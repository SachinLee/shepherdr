// Platform rules for one agent launch. The core's own host decides only launches that run here: a remote target
// keeps the POSIX shell it was prepared with, and nothing here treats "the host is Windows" as "every machine is".
/** Where a launch runs: this machine follows the core's host; a remote target keeps its own shell rules. */
export type AgentHost = 'posix' | 'windows'

export function agentHost(remote: boolean, host: NodeJS.Platform = process.platform): AgentHost {
  return !remote && host === 'win32' ? 'windows' : 'posix'
}

/** PATH is split by the host's delimiter: a POSIX colon inside `C:\…` would cut the drive letter off. */
export function pathList(parts: Array<string | undefined>, host: AgentHost): string {
  return parts.filter((part): part is string => part !== undefined).join(host === 'windows' ? ';' : ':')
}

/** A later PATH must replace an earlier Path on Windows, which looks names up without case. */
export function environment(entries: Array<[string, string]>, host: AgentHost): Record<string, string> {
  const out: Record<string, string> = {}
  const names = new Map<string, string>()
  for (const [key, value] of entries) {
    const existing = host === 'windows' ? names.get(key.toLowerCase()) : undefined
    if (existing !== undefined) { out[existing] = value; continue }
    names.set(key.toLowerCase(), key); out[key] = value
  }
  return out
}

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** An absolute Windows path: a drive letter or a UNC share, never a bare name a shell would resolve from PATH. */
const absolute = (value: string) => /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value)

/**
 * A Windows argv may only name a real native program: an absolute `.exe`. The `.cmd`, `.bat` and `.ps1` files npm
 * installs in `node_modules/.bin` are shims that need a shell, which is exactly what Claude Code's exec form refuses.
 */
export function nativeWindowsExecutable(value: string): boolean {
  return absolute(value) && /\.exe$/i.test(value)
}

/** `command` alone is a shell string on POSIX; `args` present makes the same field the program of an exec-form hook. */
export interface HookCommand { command: string; args?: string[] }
export interface HookRefusal { refusal: string }

/** Codex keeps its refusal: its hooks are TOML command strings for a shell this build has not verified on Windows. */
export const CODEX_WINDOWS = 'Shepherdr cannot start Codex on Windows yet: its hooks take a command string for a shell this build has not verified, so no agent was started and no approval rule was written.'

/**
 * A provider hook is the one place a shell string is unavoidable, so it is also the one place a path with a space
 * could split into another command. POSIX keeps the single-quoted form this build has always used. Claude Code on
 * Windows uses its exec form (`command` plus `args`): the program is spawned directly with the argument vector and no
 * shell, so a space, a quote or a `!` inside a path stays one argument. A shim, a relative path or a guessed quote is
 * refused instead, because a wildcard rule or a `dangerously-*` flag would widen authority instead of carrying it.
 */
export function hookCommand(host: AgentHost, kind: 'claude' | 'codex', bun: string, script: string): HookCommand | HookRefusal {
  if (host === 'posix') return { command: `${quote(bun)} ${quote(script)}` }
  if (kind === 'codex') return { refusal: CODEX_WINDOWS }
  if (!nativeWindowsExecutable(bun)) return { refusal: `Shepherdr cannot start Claude Code on Windows: its hook program ${bun} is not a native .exe that can run without a shell, so no agent was started and no approval rule was written.` }
  if (!absolute(script)) return { refusal: `Shepherdr cannot start Claude Code on Windows: its hook script ${script} is not an absolute path, so no agent was started and no approval rule was written.` }
  return { command: bun, args: [script] }
}

/**
 * The oldest Claude Code this build enables on Windows. The published hook reference shows the exec-form shape
 * (`command` plus `args`) and that `onFailure: "block"` needs >= 2.1.295, but it does not record which release first
 * accepted `args`, and this build has never run a real Windows provider. 2.1.317 is therefore a conservative
 * configured floor, not a verified capability: a real Claude Code closed loop on Windows stays UNVERIFIED.
 */
export const CLAUDE_WINDOWS_MINIMUM = '2.1.317'

export interface ProbeAnswer { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }

/** Where `claude` is and what it answers to `--version`: a seam so tests never start a real provider. */
export interface ClaudeProbe {
  find: () => string | undefined
  run: (file: string, args: string[]) => ProbeAnswer
}

export interface WindowsClaude { path: string; version: string }

/** The real probe: one bounded argv call with a deadline, never a shell and never an interactive session. */
export const claudeProbe: ClaudeProbe = {
  find: () => Bun.which('claude') ?? undefined,
  run: (file, args) => {
    const answer = Bun.spawnSync([file, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 10_000, maxBuffer: 64 * 1024 })
    return { exitCode: answer.exitCode, stdout: answer.stdout.toString(), stderr: answer.stderr.toString(), timedOut: answer.exitedDueToTimeout === true }
  },
}

const released = /^(?:Claude Code\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s*\(Claude Code\))?$/

function atLeast(version: string, minimum: string): boolean {
  const have = version.split('.').map(Number), need = minimum.split('.').map(Number)
  for (const index of [0, 1, 2]) {
    if (have[index] === need[index]) continue
    return have[index] > need[index]
  }
  return true
}

const reason = (answer: ProbeAnswer) => answer.timedOut ? 'it did not answer within its deadline'
  : answer.exitCode === null ? 'it was stopped by a signal' : answer.exitCode !== 0 ? `it exited with ${answer.exitCode}` : 'it printed no version'

/**
 * Decide whether this machine can start Claude Code natively. A missing program, an npm shim, a failed or timed-out
 * probe, an unreadable version and a version below the floor are all refusals, so a launch stops before a grant, a
 * private launch file or a terminal exists. Nothing here starts a session or installs anything.
 */
export function windowsClaude(probe: ClaudeProbe = claudeProbe, minimum = CLAUDE_WINDOWS_MINIMUM): WindowsClaude | HookRefusal {
  const found = probe.find()
  if (!found) return { refusal: `Shepherdr cannot start Claude Code on Windows: no claude was found on PATH, and the .cmd shim npm installs there needs a shell this build does not use. No agent was started and no approval rule was written.` }
  if (!nativeWindowsExecutable(found)) return { refusal: `Shepherdr cannot start Claude Code on Windows: ${found} is not a native .exe, and a .cmd, .bat or .ps1 shim needs a shell this build does not use. No agent was started and no approval rule was written.` }
  const answer = ((): ProbeAnswer | HookRefusal => {
    try { return probe.run(found, ['--version']) } catch (error) {
      return { refusal: `Shepherdr could not start Claude Code at ${found} to check its version: ${error instanceof Error ? error.message : String(error)}. No agent was started and no approval rule was written.` }
    }
  })()
  if ('refusal' in answer) return answer
  // A probe that failed is a failed probe even when it printed something version-shaped: a non-zero exit, a signal or
  // a deadline means the answer is not trustworthy, so the version is never parsed out of it.
  const failed = answer.timedOut === true || answer.exitCode === null || answer.exitCode !== 0
  const version = failed ? null : released.exec(answer.stdout.trim().split('\n')[0]?.trim() ?? '')
  if (!version) return { refusal: `Shepherdr could not read Claude Code's version from ${found}: ${reason(answer)}. It needs ${minimum} or later for hook exec form, so no agent was started and no approval rule was written.` }
  const parsed = `${version[1]}.${version[2]}.${version[3]}`
  if (!atLeast(parsed, minimum)) return { refusal: `Shepherdr needs Claude Code ${minimum} or later on Windows for hooks that run without a shell; ${found} reports ${parsed}. No agent was started and no approval rule was written.` }
  return { path: found, version: parsed }
}

/** The one refusal every Windows-local Autopilot entry point shares, before state, grant or terminal. */
export const AUTOPILOT_WINDOWS = 'Autopilot needs Linux isolation and cannot run on this Windows machine. It was not started: no unisolated agent and no WSL fallback was used.'
