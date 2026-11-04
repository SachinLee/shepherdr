# Windows native preview

This change targets a Windows x64 Shepherdr server connected to herdr-core on the
same Windows machine, under the same ordinary user account. It is an experimental
implementation: Windows application, security and provider acceptance are still
unverified. A Windows browser visiting a Linux server does not validate this path.
The authoritative evidence is in the
[Windows change record](../../openspec/changes/windows-native-support/artifacts/verification.md).

## Prerequisites

- Windows x64 and an ordinary, non-elevated desktop session. Run Bun, core and
  Shepherdr as the same user in that session. Administrator terminals, SYSTEM,
  Windows services, ARM64 and automatic login startup are outside this preview.
- Git and native Bun. The repository pins Bun 1.4.2 for CI; the initial isolated
  core protocol probe used Bun 1.4.4. That probe does not establish application
  compatibility with either version.
- Native herdr-core. The isolated Windows probe verified hc 0.1.17, generation 1.
  Shepherdr also checks the live protocol generation and required methods.
- Windows PowerShell 5.1 with its .NET APIs available. A fixed helper opens and
  validates local files and named pipes. If script execution, compilation or
  security inspection is blocked by machine policy, startup refuses; this change
  does not alter execution policy or retry through an unchecked connection.
- For the candidate Claude path, native `claude.exe` on PATH and native
  `bun.exe`. npm `.cmd`, `.bat` and `.ps1` shims are refused. Claude must already
  be installed and signed in by the operator. The configured Claude minimum is
  2.1.317, a conservative floor rather than a verified introduction version for
  exec-form hooks. Real Claude hook and permission behaviour remains unverified.

Build the reviewed checkout on a separate build machine or in CI. The shared
development machine's rule permitting only `bun run typecheck` still applies;
these instructions do not authorize a local build there.

```powershell
bun install --frozen-lockfile
bun run build
```

Keep the built checkout and its dependencies in place while it runs. The Windows
entry is `bin\shepherdr.cmd`; it finds Bun through PATH. Hooks use the absolute
native Bun executable selected by the running server.

## Isolated manual startup

Use a fresh home, explicit core session and explicit local pipe. Windows does not
guess a pipe name from Unix defaults. Do not reuse a desktop application's core
session or an existing Shepherdr home for a preview.

The following commands are operator instructions, not evidence that startup has
been accepted. Run them from the built checkout in an ordinary PowerShell window:

```powershell
$previewId = [guid]::NewGuid().ToString('N')
$previewRoot = Join-Path $env:LOCALAPPDATA "ShepherdrPreview-$previewId"
New-Item -ItemType Directory -Path $previewRoot | Out-Null
$previewHome = Join-Path $previewRoot 'home'
$previewSession = "shep-preview-$($previewId.Substring(0, 12))"
$previewPipe = "\\.\pipe\shep-preview-$previewId"

$env:XDG_CONFIG_HOME = Join-Path $previewRoot 'core-config'
$env:XDG_STATE_HOME = Join-Path $previewRoot 'core-state'
$env:HC_SESSION = $previewSession
$env:HC_SOCKET = $previewPipe

& .\bin\shepherdr.cmd start --home $previewHome --port 17887 `
  --core-bin 'C:\absolute\path\to\hc.exe' `
  --core-session $previewSession --core-socket $previewPipe --no-plugin-updates
& .\bin\shepherdr.cmd status --home $previewHome
& .\bin\shepherdr.cmd stop --home $previewHome
```

Replace the hc path and choose a free port. Leave the home leaf absent before the
first start: Shepherdr creates it with a protected DACL. A pre-existing directory
with unsuitable permissions is refused, rather than silently repaired. The XDG
and HC variables above belong to that PowerShell process and its children; they
do not change the system PATH or permanent environment.

Only local `\\.\pipe\<name>` endpoints are accepted. Remote pipe paths, alternate
namespaces and malformed names are refused. `--core-socket` takes precedence;
an explicitly selected core session does not silently inherit a different
session's `HC_SOCKET`.

`status` reads existing state without creating a home, migrating it or changing
ACLs. `stop` authenticates the operator pipe against the recorded helper process
and boot before asking the application to drain. It does not send a Windows
process signal, kill an unverified PID or stop/restart core. A drain that has not
completed is reported as finishing. Keep its state and logs for diagnosis.

Stopping Shepherdr should leave core, terminal holders and their existing programs
running. Acceptance must verify the same core and holder identities and continuous
output from the original program; a terminal merely showing `live` is insufficient.
Never use `hc server stop` as a substitute for `shepherdr stop`: core stop can end
those programs.

## Scope and limitations

| Area | Evidence and current status |
| --- | --- |
| hc 0.1.17 protocol on Windows x64 | Verified by the isolated P0 probe with Bun 1.4.4; application acceptance remains open. |
| Native service, private files, operator and ordinary repository files | Implementation under review; Windows CI and OS acceptance remain unverified. |
| Claude exec-form hooks and agent continuity | Candidate implementation; a real signed-in provider session remains unverified. |
| Windows Codex and local Autopilot | Refused in this preview. |
| ARM64, services, automatic startup and optional platform integrations | Outside this preview's support commitment. |

The candidate ordinary agent path is Claude with structured exec-form hooks:
the native executable and script arguments are separate, without shell quoting.
Permission hook startup failures must block. Windows command paths receive no
new wildcard or automatic permission rules; use the provider's normal approval
flow. Real launch, message delivery, permission decisions, hook status, completion
and reconnection all still need Windows acceptance evidence.

Windows Codex is explicitly refused while its hook shell contract is unverified.
Local Autopilot is also refused because its isolation requires Linux namespaces;
there is no WSL or unrestricted fallback. Shared browser, voice, SSH machine
management, plan approval and platform-specific limits have no Windows support
commitment in this preview. Existing Linux/macOS functionality retains its own
requirements.

Windows ordinary file operations distinguish repository files from private state.
Repository files do not need Shepherdr's private DACL, but links, reparse points,
hardlinks, alternate data streams and invalid Windows names are rejected where
they could cross the file boundary. Credentials, launch settings, staging and
exports remain private. A path under a user profile, a random pipe name or Unix
mode bits alone do not establish that privacy.

## Troubleshooting and acceptance

- For a token or peer refusal, check that the server and core run as the same
  ordinary user in the same session. Do not solve it by running both elevated or
  bypassing security checks.
- For an ACL, owner or reparse refusal, preserve the original directory for
  inspection and choose a fresh missing home under the intended user's profile.
  Do not weaken the ACL checks or point a second installation at legacy state.
- For a missing endpoint, confirm the explicit session, pipe, absolute hc path
  and isolated XDG variables. A protocol generation or required-method error
  requires a compatible core, not a transport fallback.
- For a refused Claude version probe, inspect the native executable and its
  `--version` result. A timeout or nonzero exit must refuse even if version text
  was printed. Do not substitute an npm shim or grant broader permissions.
- For a stale lock or finishing stop, retain the private state and diagnostics.
  Do not delete a live or ownerless lock, kill a reused PID or stop core to make
  the launcher report success.

The required Windows CI must run security and lifecycle cases under an actual
ordinary medium-integrity token. A successful elevated run that skipped those
cases is not acceptance. Ubuntu regression checks, the pinned Bun version, real
core lifecycle evidence and a real Claude closed loop are separate outstanding
gates. No release, tag or package publication is implied by this preview.

The CI preparation separates elevated refusal checks from ordinary-user tests.
The ordinary stage must verify the expected user SID, Windows session, a
non-elevated token and medium integrity before running the suites. It also needs
the fixed hc 0.1.17 archive and executable hashes and the pinned Bun 1.4.2.
Account/profile creation, desktop access or token failures must fail the job;
skipping the real-core case because its binary or token is missing cannot pass
this gate. The CI account and state belong only to the disposable runner.
These workflow changes have not yet been run.
