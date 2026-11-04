#Requires -Version 5.1
<#
  The ordinary-user half of the Windows check (scripts/windows/ci-host.ps1 starts it with the account it made).

  It begins with the token, not with a logon: the account's user, session, elevation and integrity level come from
  GetTokenInformation, and a single wrong one ends the check with exit 1. Nothing here skips, because the logon a
  GitHub Windows runner would otherwise give every process is exactly the elevated one production refuses: a plain
  run that quietly skipped these tests would prove nothing.

  Everything after that is the account's own: a private profile, a copy of this commit cloned with the user's own git,
  the fixed core build, frozen install, typecheck, build, and the two Windows test groups.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExpectedSid,
  [Parameter(Mandatory = $true)][int]$ExpectedSession,
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$Git,
  [Parameter(Mandatory = $true)][string]$CoreZip,
  [Parameter(Mandatory = $true)][string]$CoreZipSha256,
  [Parameter(Mandatory = $true)][string]$CoreExeSha256,
  [Parameter(Mandatory = $true)][string]$CoreVersion
)

$ErrorActionPreference = 'Stop'

function Say([string]$message) { Write-Host "shepherdr-ci-user: $message" }
function Fail([string]$message) { [Console]::Error.WriteLine("shepherdr-ci-user: $message"); exit 1 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ShepherdrCiToken
{
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TokenUser { public SidAndAttributes User; }
    [StructLayout(LayoutKind.Sequential)] struct TokenGroups { public uint GroupCount; public SidAndAttributes Groups; }
    [StructLayout(LayoutKind.Sequential)] struct TokenElevation { public uint Elevated; }
    [StructLayout(LayoutKind.Sequential)] struct TokenMandatoryLabel { public SidAndAttributes Label; }

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int written);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    static IntPtr Ask(IntPtr token, int kind)
    {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        int written;
        if (!GetTokenInformation(token, kind, buffer, needed, out written))
        {
            int error = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(buffer);
            throw new Exception("GetTokenInformation " + kind + " failed: " + error);
        }
        return buffer;
    }

    static string Text(IntPtr sid)
    {
        IntPtr text;
        if (!ConvertSidToStringSid(sid, out text)) throw new Exception("ConvertSidToStringSid failed: " + Marshal.GetLastWin32Error());
        try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    }

    public static string[] Read()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) throw new Exception("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
        IntPtr user = IntPtr.Zero, groups = IntPtr.Zero, session = IntPtr.Zero, elevation = IntPtr.Zero, integrity = IntPtr.Zero;
        try
        {
            user = Ask(token, 1);
            groups = Ask(token, 2);
            session = Ask(token, 12);
            elevation = Ask(token, 20);
            integrity = Ask(token, 25);
            TokenUser who = (TokenUser)Marshal.PtrToStructure(user, typeof(TokenUser));
            TokenElevation elevated = (TokenElevation)Marshal.PtrToStructure(elevation, typeof(TokenElevation));
            TokenMandatoryLabel label = (TokenMandatoryLabel)Marshal.PtrToStructure(integrity, typeof(TokenMandatoryLabel));
            uint rid = (uint)Marshal.ReadInt32(GetSidSubAuthority(label.Label.Sid, (uint)(Marshal.ReadByte(GetSidSubAuthorityCount(label.Label.Sid)) - 1)));
            TokenGroups all = (TokenGroups)Marshal.PtrToStructure(groups, typeof(TokenGroups));
            int first = (int)Marshal.OffsetOf(typeof(TokenGroups), "Groups");
            int stride = Marshal.SizeOf(typeof(SidAndAttributes));
            bool administrator = false;
            for (int i = 0; i < all.GroupCount; i++)
            {
                SidAndAttributes entry = (SidAndAttributes)Marshal.PtrToStructure(new IntPtr(groups.ToInt64() + first + i * stride), typeof(SidAndAttributes));
                if (Text(entry.Sid) == "S-1-5-32-544") administrator = true;
            }
            return new string[] { Text(who.User.Sid), Marshal.ReadInt32(session).ToString(), elevated.Elevated != 0 ? "elevated" : "plain", rid.ToString(), administrator ? "administrator" : "standard" };
        }
        finally
        {
            foreach (IntPtr pointer in new IntPtr[] { user, groups, session, elevation, integrity }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
            CloseHandle(token);
        }
    }
}
'@

# ---------------------------------------------------------------- the token this runs on

try { $token = [ShepherdrCiToken]::Read() }
catch { Fail "could not read this process's token: $($_.Exception.Message)" }
$sid = $token[0]
$session = [int]$token[1]
$elevation = $token[2]
$level = [uint32]$token[3]
$membership = $token[4]
Say "token: $sid, session $session, $elevation, integrity 0x$($level.ToString('x')), $membership"

if ($sid -ne $ExpectedSid) { Fail "this runs as $sid, not the account the host made ($ExpectedSid)" }
if ($session -ne $ExpectedSession) { Fail "this runs in session $session, not the host's $ExpectedSession" }
if ($elevation -ne 'plain') { Fail 'this is an elevated token; the gate is only proved by a non-elevated one' }
if ($level -ne 0x2000) { Fail "this token's integrity is 0x$($level.ToString('x')), not the medium 0x2000" }
if ($membership -ne 'standard') { Fail 'this account is in Administrators; it must be an ordinary one' }

$profileDir = $env:USERPROFILE
if (-not $profileDir -or -not (Test-Path -LiteralPath $profileDir)) { Fail "no profile for this account: '$profileDir'" }
if (-not $profileDir.StartsWith(($env:SystemDrive + '\Users\'), 'OrdinalIgnoreCase')) { Fail "the profile is $profileDir, not under $env:SystemDrive\Users" }
try
{
  $owner = (Get-Acl -LiteralPath $profileDir).Owner
  $ownerSid = (New-Object Security.Principal.NTAccount -ArgumentList $owner).Translate([Security.Principal.SecurityIdentifier]).Value
}
catch { Fail "could not read who owns the profile $profileDir" }
if ($ownerSid -ne $sid) { Fail "the profile is owned by $ownerSid, not this account" }
Say "profile: $profileDir"

# ---------------------------------------------------------------- this account's own files

$work = Join-Path $profileDir 'shepherdr-ci'
$app = Join-Path $work 'app'
$temp = Join-Path $work 'temp'
$home = Join-Path $work 'home'
$config = Join-Path $work 'config'
$state = Join-Path $work 'state'
$cache = Join-Path $work 'cache'
New-Item -ItemType Directory -Force -Path $work, $temp, $home, $config, $state, $cache | Out-Null

# The tests and the app read these, so a leftover of the administrator's session (its core, its server, its port, its
# home) cannot reach them: everything is this account's, under this account's profile.
$env:HOME = $home
$env:TMP = $temp
$env:TEMP = $temp
$env:XDG_CONFIG_HOME = $config
$env:XDG_STATE_HOME = $state
$env:XDG_CACHE_HOME = $cache
$env:SHEPHERDR_HOME = $home
foreach ($key in 'HC_SESSION', 'HC_SOCKET', 'SHEPHERDR_PORT', 'SHEPHERDR_URL', 'SHEPHERDR_CHAT', 'SHEPHERDR_TEST_CORE_BIN')
{ Remove-Item -LiteralPath "Env:\$key" -ErrorAction SilentlyContinue }
$env:PATH = (Split-Path $Bun) + ';' + $env:PATH
# the workflow's own env does not cross into this logon (Windows builds it from the account's profile), and the tests
# that make commits need someone to make them
$env:GIT_AUTHOR_NAME = 'CI'
$env:GIT_AUTHOR_EMAIL = 'ci@localhost'
$env:GIT_COMMITTER_NAME = 'CI'
$env:GIT_COMMITTER_EMAIL = 'ci@localhost'
# two files at a time: the lifecycle and operator files each hold a real core and a helper, and the runner has 4 GB
$env:SHEPHERDR_TEST_JOBS = '2'

$reported = (& $Bun --version 2>&1 | Out-String).Trim()
if ($reported -ne '1.4.2') { Fail "bun reports '$reported', not 1.4.2" }
Say "bun: $Bun ($reported)"

# The fixed core build, checked again here: the bytes the tests start are the ones the check names.
if (-not (Test-Path -LiteralPath $CoreZip)) { Fail "no core archive at $CoreZip" }
$zipHash = (Get-FileHash -LiteralPath $CoreZip -Algorithm SHA256).Hash
if ($zipHash -ne $CoreZipSha256) { Fail "the core archive's hash is $zipHash, not $CoreZipSha256" }
$core = Join-Path $work 'core'
Expand-Archive -LiteralPath $CoreZip -DestinationPath $core -Force
$exes = @(Get-ChildItem -LiteralPath $core -Filter *.exe -Recurse -File)
if ($exes.Count -ne 1) { Fail "the core archive holds $($exes.Count) executables, not one" }
$exeHash = (Get-FileHash -LiteralPath $exes[0].FullName -Algorithm SHA256).Hash
if ($exeHash -ne $CoreExeSha256) { Fail "the core executable's hash is $exeHash, not $CoreExeSha256" }
$line = (& $exes[0].FullName --version 2>&1 | Out-String).Trim()
if (($line -split '\s+')[-1] -ne $CoreVersion) { Fail "the core reports '$line', not $CoreVersion" }
$env:SHEPHERDR_TEST_CORE_BIN = $exes[0].FullName
Say "core: $($exes[0].FullName) ($line)"

# The checkout was the administrator's, with ancestors that more than its owner can write; this copy is this
# account's, from a read-only copy of that commit. The source is read as another user's repository, so the safety
# check is told about it for these two commands only: no global or system git setting is changed.
$head = (& $Git -c "safe.directory=$Source" -C $Source rev-parse HEAD 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Fail "could not read the copy's commit: $head" }
& $Git -c "safe.directory=$Source" clone --no-hardlinks --quiet $Source $app
if ($LASTEXITCODE -ne 0) { Fail 'git clone --no-hardlinks of the read-only copy failed' }
$copy = (& $Git -C $app rev-parse HEAD 2>&1 | Out-String).Trim()
if ($copy -ne $head) { Fail "this copy is at $copy, not $head" }
Say "checkout: $app at $head"

# ---------------------------------------------------------------- the check itself

function Run([string]$label, [string]$log, [scriptblock]$body)
{
  Say "run: $label"
  & $body *> $log
  $code = $LASTEXITCODE
  Get-Content -LiteralPath $log | ForEach-Object { Write-Host $_ }
  if ($code -ne 0) { Fail "$label failed: exit $code" }
}

function Ran([string]$log, [string]$name)
{
  if (-not (Select-String -LiteralPath $log -Pattern ('\(pass\).*' + [regex]::Escape($name)) -Quiet))
  { Fail "did not pass as the ordinary user: $name (skipped or never ran)" }
}

# the groups of openspec/changes/windows-native-support/tasks.md, T6: the Windows surfaces that only a real
# unprivileged, medium-integrity account can prove, then the ordinary work
$security = @(
  'core-home', 'core-secrets', 'core-windows-security', 'core-client', 'core-launcher', 'core-operator',
  'core-windows-pipe', 'core-windows-operator', 'core-windows-cli', 'core-windows-lifecycle', 'core-windows-publication'
)
$ordinary = @(
  'core-agents', 'core-launch-matrix', 'core-own-commands', 'core-pilot-lifecycle', 'core-windows-agents',
  'core-worktree', 'core-git', 'core-tasks', 'core-review-reader', 'core-windows-files', 'core-chat', 'core-artifacts',
  'core-windows-transfers'
)
$securityLog = Join-Path $work 'security.log'
$ordinaryLog = Join-Path $work 'ordinary.log'

Push-Location $app
try
{
  Run 'install' (Join-Path $work 'install.log') { & $Bun install --frozen-lockfile }
  Run 'typecheck' (Join-Path $work 'typecheck.log') { & $Bun run typecheck }
  Run 'build' (Join-Path $work 'build.log') { & $Bun run build }
  # 240 s a test: the lifecycle file starts a real core, stops it and starts it again, with 30 s waits of its own
  Run 'security' $securityLog { & $Bun run test '--timeout=240000' @security }
  Ran $securityLog 'relays a real private pipe on the verified connection'
  Ran $securityLog 'creates the pipe privately and serves one request end to end'
  Ran $securityLog 'a real core keeps its holder and its original program across a stop, a restart and a repeated start'
  Run 'ordinary' $ordinaryLog { & $Bun run test '--timeout=240000' @ordinary }
  # a run whose every test skipped also exits 0: this group has to have passed something
  if (-not (Select-String -LiteralPath $ordinaryLog -SimpleMatch '(pass) ' -Quiet))
  { Fail 'the ordinary group passed no test: everything in it skipped' }
}
finally
{
  Pop-Location
}

Say 'done'
