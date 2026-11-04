#Requires -Version 5.1
<#
  The administrator half of the Windows check (.github/workflows/check.yml).

  A GitHub Windows runner is an administrator with UAC off, so every process it starts is elevated, and the gate this
  product enforces in production - an ordinary, non-elevated, medium-integrity account - never runs there. This script
  makes the one thing that gate needs: a throwaway standard local account, and the files it is allowed to read (a
  copy of this checkout, bun, and the fixed core build). Then it starts ci-user.ps1 as that account and waits for it.

  Everything it makes lives in one folder under %ProgramData%, readable by Users and writable by nobody, and goes at
  the end. The account's password is random, lives in memory only, and is never written down or passed on a command
  line. It never skips: a machine that cannot give an ordinary user a logon stops the check with why.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  # how long the ordinary user gets for install, build and both test groups
  [int]$Minutes = 20
)

$ErrorActionPreference = 'Stop'

# The one core build this check is proved against
# (openspec/changes/windows-native-support/verification.md:30): the versioned release, the archive and executable
# hashes, and the archive's size. Another build is another check, so these are fixed here, not fetched as "latest".
$Version = '0.1.17'
$ZipUrl = 'https://releases.herdr.dev/core/0.1.17/herdr-core-windows-x86_64.zip'
$ZipSha256 = 'A212B69DB0EFB808882683F15E5DA45AB9606DA7BCC54B97B29ED4FA540F5491'
$ExeSha256 = 'D144159FE0A4CA3EEE4AB9D176331632FB78E2B1AFE6F90ACFC4325AEA97594E'
$ZipLength = 3699216
$BunVersion = '1.4.2'

function Say([string]$message) { Write-Host "shepherdr-ci-host: $message" }
function Fail([string]$message) { [Console]::Error.WriteLine("shepherdr-ci-host: $message"); exit 1 }
function Show-Logs([string[]]$files)
{
  foreach ($file in $files)
  {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    Write-Host "--- $file"
    Get-Content -LiteralPath $file | ForEach-Object { Write-Host $_ }
  }
}

# ---------------------------------------------------------------- the runner's own account

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -eq 'S-1-5-18')
{ Fail 'this runs as LocalSystem; CreateProcessWithLogonW needs a logged-on user, not the machine account' }
$principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
{ Fail "this runs as $($identity.Name), which is not an administrator; the check needs one to make an ordinary user" }
Say "host: $($identity.Name), session $((Get-Process -Id $PID).SessionId)"

if (-not (Test-Path -LiteralPath $Workspace)) { Fail "no checkout at $Workspace" }
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCommand) { Fail 'git is not on PATH' }
$git = $gitCommand.Source

# Start-Process -Credential is CreateProcessWithLogonW, which is the Secondary Logon service's job. Windows images
# ship it stopped (and sometimes disabled), so start it here and say so plainly when it cannot run.
$logon = Get-Service -Name seclogon -ErrorAction SilentlyContinue
if (-not $logon) { Fail 'the Secondary Logon service (seclogon) is missing; an ordinary user cannot be started without it' }
if ($logon.Status -ne 'Running')
{
  try { Set-Service -Name seclogon -StartupType Manual -ErrorAction Stop; Start-Service -Name seclogon -ErrorAction Stop }
  catch { Fail "could not start the Secondary Logon service: $($_.Exception.Message)" }
}
if ((Get-Service -Name seclogon).Status -ne 'Running') { Fail 'the Secondary Logon service is not running' }
Say 'host: Secondary Logon is running'

# ---------------------------------------------------------------- the stage

$stage = Join-Path $env:ProgramData ('shepherdr-ci-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
$name = 'shepci' + [guid]::NewGuid().ToString('n').Substring(0, 8)
$madeUser = $false
$sid = $null
$failure = $null

function Remove-Stage
{
  # the ordinary user's own processes first, or Windows keeps its profile and the stage's files busy
  Get-Process -IncludeUserName -ErrorAction SilentlyContinue |
    Where-Object { $_.UserName -eq "$env:COMPUTERNAME\$name" } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
  if ($madeUser)
  {
    for ($i = 0; $i -lt 3; $i++)
    {
      try { Remove-LocalUser -Name $name -ErrorAction Stop; break }
      catch { Start-Sleep -Seconds 2 }
    }
    Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue |
      ForEach-Object { try { Remove-CimInstance -InputObject $_ -ErrorAction Stop } catch {} }
  }
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

try
{
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  # Users read and run what is here and write nothing: the ordinary user's own copy is made under its profile, which
  # the checkout's D:\a... is not (its ancestors are writable by more than its owner).
  & icacls.exe $stage /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not give Users read access to the stage folder' }
  Say "stage: $stage"

  # A copy of this commit, made by a full-path git and readable by plain users. The branch is made because the runner's
  # checkout is a detached merge commit: a clone only fetches reachable refs, so the commit is reachable from a branch
  # of its own first.
  $head = (& $git -C $Workspace rev-parse HEAD 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "could not read the checkout's commit: $head" }
  & $git -C $Workspace branch --force shepherdr-ci $head | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not mark the checkout as a branch for the copy' }
  $source = Join-Path $stage 'source'
  & $git clone --no-local --quiet --branch shepherdr-ci $Workspace $source
  if ($LASTEXITCODE -ne 0) { throw 'git clone --no-local of the checkout failed' }
  $copy = (& $git -C $source rev-parse HEAD 2>&1 | Out-String).Trim()
  if ($copy -ne $head) { throw "the copy is at $copy, not $head" }
  Say "source: $source at $head"

  # bun, the one setup-bun put on this administrator's PATH: copied to where the ordinary user can run it.
  $bunCommand = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bunCommand) { throw 'bun is not on PATH' }
  $bin = Join-Path $stage 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  Copy-Item -Path (Join-Path (Split-Path $bunCommand.Source) '*') -Destination $bin -Recurse -Force
  $bun = Join-Path $bin 'bun.exe'
  if (-not (Test-Path -LiteralPath $bun)) { throw "no bun.exe beside $($bunCommand.Source)" }
  $reported = (& $bun --version 2>&1 | Out-String).Trim()
  if ($reported -ne $BunVersion) { throw "the copied bun reports '$reported', not $BunVersion" }
  Say "bun: $bun ($reported)"

  # The fixed core build. Both hashes are checked here so a wrong or missing release fails in minutes with its name,
  # and ci-user.ps1 checks both again as the ordinary user, whose runs use it.
  $zip = Join-Path $stage 'herdr-core.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
  $length = (Get-Item -LiteralPath $zip).Length
  if ($length -ne $ZipLength) { throw "the core archive is $length bytes, not $ZipLength" }
  $zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  if ($zipHash -ne $ZipSha256) { throw "the core archive's hash is $zipHash, not $ZipSha256" }
  $core = Join-Path $stage 'core'
  Expand-Archive -LiteralPath $zip -DestinationPath $core -Force
  $exes = @(Get-ChildItem -LiteralPath $core -Filter *.exe -Recurse -File)
  if ($exes.Count -ne 1) { throw "the core archive holds $($exes.Count) executables, not one" }
  $exeHash = (Get-FileHash -LiteralPath $exes[0].FullName -Algorithm SHA256).Hash
  if ($exeHash -ne $ExeSha256) { throw "the core executable's hash is $exeHash, not $ExeSha256" }
  $line = (& $exes[0].FullName --version 2>&1 | Out-String).Trim()
  if (($line -split '\s+')[-1] -ne $Version) { throw "the core reports '$line', not $Version" }
  Say "core: $($exes[0].FullName) ($line)"

  # ---------------------------------------------------------------- the ordinary user

  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # never printed, never on a command line, and not kept after the logon: only the SecureString and the credential do
  $password = [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').Replace('=', 'C')
  $account = New-LocalUser -Name $name -Password (ConvertTo-SecureString $password -AsPlainText -Force) `
    -AccountNeverExpires -PasswordNeverExpires -Description 'Shepherdr CI ordinary user' -ErrorAction Stop
  $madeUser = $true
  $sid = $account.SID.Value
  $administrators = Get-LocalGroup -SID 'S-1-5-32-544' -ErrorAction Stop
  if (Get-LocalGroupMember -Group $administrators -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid })
  { throw "$name is in Administrators; the ordinary user must not be" }
  Say "user: $name ($sid)"

  $credential = New-Object System.Management.Automation.PSCredential -ArgumentList "$env:COMPUTERNAME\$name", (ConvertTo-SecureString $password -AsPlainText -Force)
  $session = (Get-Process -Id $PID).SessionId

  $script = Join-Path $stage 'ci-user.ps1'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ci-user.ps1') -Destination $script -Force
  $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $shell)) { throw "no PowerShell at $shell" }

  # PowerShell, not a shell: -NoProfile so nothing of the image's runs first, -NonInteractive so a prompt cannot wait
  # forever. No -ExecutionPolicy: the script is a local file of a clone, and the machine's policy decides.
  $arguments = '-NoProfile -NonInteractive -File "{0}" -ExpectedSid "{1}" -ExpectedSession {2} -Source "{3}" -Bun "{4}" -Git "{5}" -CoreZip "{6}" -CoreZipSha256 "{7}" -CoreExeSha256 "{8}" -CoreVersion "{9}"' -f `
    $script, $sid, $session, $source, $bun, $git, $zip, $ZipSha256, $ExeSha256, $Version

  $out = Join-Path $stage 'user.out.log'
  $err = Join-Path $stage 'user.err.log'
  Say "user: starting $script in session $session"
  $process = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile `
    -WorkingDirectory $env:ProgramData -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
  $limit = [int][TimeSpan]::FromMinutes($Minutes).TotalMilliseconds
  if (-not $process.WaitForExit($limit))
  {
    & taskkill.exe /T /F /PID $process.Id | Out-Null
    $process.WaitForExit(10000) | Out-Null
    Show-Logs @($out, $err)
    throw "the ordinary user did not finish in $Minutes minutes"
  }
  $code = $process.ExitCode
  Show-Logs @($out, $err)
  if ($code -ne 0) { throw "the ordinary user exited $code" }
  Say 'user: passed'
}
catch
{
  $failure = $_.Exception.Message
}
finally
{
  Remove-Stage
}

if ($failure) { Fail $failure }
Say 'host: done'
