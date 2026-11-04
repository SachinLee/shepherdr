// Windows-local agent launches: the platform rules, the hook shape each provider gets, and the refusals that must
// happen before a grant, a private launch file or a terminal exists. Fixtures prove boundaries only; a real provider
// closed loop stays UNVERIFIED until a Windows runner starts one.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreAgents } from '../server/core/agents.ts'
import { CoreStore } from '../server/core/store.ts'
import { agentHost, AUTOPILOT_WINDOWS, CLAUDE_WINDOWS_MINIMUM, environment, hookCommand, pathList, windowsClaude } from '../server/core/agent-platform.ts'
import type { ClaudeProbe, ProbeAnswer } from '../server/core/agent-platform.ts'
import { preparePrivateDirectory, readPrivateFile, verifyPrivateFile, writePrivateFile } from '../server/core/windows-security.ts'
import type { CoreSession } from '../server/core/session.ts'
import type { Mailbox } from '../server/core/mailbox.ts'
import type { CoreAgent, CoreSpace } from '../server/core/model.ts'

const root = join(import.meta.dir, '..')
const BUN = 'C:\\Program Files\\Bun\\bun.exe'
// Every character a shell would eat or split: two spaces, a Chinese folder, an apostrophe and a literal bang.
const SCRIPT = "C:\\我的 项目\\it's!\\helper\\core-hook.ts"

test('the host rule follows the launch target, never the core alone', () => {
  expect(agentHost(false, 'win32')).toBe('windows')
  expect(agentHost(true, 'win32')).toBe('posix')
  expect(agentHost(false, 'linux')).toBe('posix')
  expect(agentHost(false, 'darwin')).toBe('posix')
})

test('PATH keeps a Windows path whole and a POSIX path unchanged', () => {
  expect(pathList(['C:\\Shep\\bin', 'C:\\Program Files\\hc', 'C:\\Windows'], 'windows')).toBe('C:\\Shep\\bin;C:\\Program Files\\hc;C:\\Windows')
  expect(pathList(['/opt/shep/bin', '/usr/local/bin', '/usr/bin'], 'posix')).toBe('/opt/shep/bin:/usr/local/bin:/usr/bin')
})

test('a later PATH replaces an earlier Path on Windows instead of sitting beside it', () => {
  const windows = environment([['Path', 'C:\\old'], ['SHEPHERDR_BACKEND', 'core'], ['PATH', 'C:\\Shep\\bin;C:\\Windows']], 'windows')
  expect(windows).toEqual({ Path: 'C:\\Shep\\bin;C:\\Windows', SHEPHERDR_BACKEND: 'core' })
  const posix = environment([['Path', '/old'], ['PATH', '/new']], 'posix')
  expect(posix).toEqual({ Path: '/old', PATH: '/new' })
})

test('a POSIX hook command quotes each path, and Codex on Windows refuses instead of guessing a shell', () => {
  const posix = hookCommand('posix', 'claude', '/opt/it\'s bun', '/repo/helper/core-hook.ts')
  expect(posix).toEqual({ command: `'/opt/it'"'"'s bun' '/repo/helper/core-hook.ts'` })
  const windows = hookCommand('windows', 'codex', BUN, SCRIPT)
  expect('refusal' in windows && windows.refusal).toContain('Windows')
  expect('refusal' in windows && windows.refusal).toContain('no agent was started')
  expect('command' in windows).toBe(false)
})

test('a Windows Claude hook is exec form: one program and one script argument, never a shell string', () => {
  const hook = hookCommand('windows', 'claude', BUN, SCRIPT)
  if ('refusal' in hook) throw new Error(hook.refusal)
  expect(hook.command).toBe(BUN)
  expect(hook.args).toEqual([SCRIPT])
  // The program field must not smuggle the script in beside it: exec form keeps `command` the executable only.
  expect(hook.command).not.toContain('core-hook')
  // The settings file carries this as JSON, so a space, an apostrophe or a bang must survive the encoding unchanged.
  const encoded = JSON.stringify({ type: 'command', ...hook })
  expect(JSON.parse(encoded)).toEqual({ type: 'command', command: BUN, args: [SCRIPT] })
  expect(encoded).toContain(SCRIPT.replace(/\\/g, '\\\\'))
  expect(encoded).not.toContain(`'${SCRIPT}'`)
})

test('a Windows Claude hook refuses a shim program or a relative script instead of quoting one', () => {
  for (const shim of ['C:\\Users\\me\\AppData\\Roaming\\npm\\bun.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\bun.bat', 'C:\\Users\\me\\AppData\\Roaming\\npm\\bun.ps1']) {
    const refused = hookCommand('windows', 'claude', shim, SCRIPT)
    if (!('refusal' in refused)) throw new Error(`a shim hook program must be refused: ${shim}`)
    expect(refused.refusal).toContain('not a native .exe')
    expect(refused.refusal).toContain('no agent was started')
  }
  const relative = hookCommand('windows', 'claude', BUN, 'helper/core-hook.ts')
  if (!('refusal' in relative)) throw new Error('a relative hook script must be refused')
  expect(relative.refusal).toContain('not an absolute path')
})

function answering(overrides: Partial<ProbeAnswer> = {}): ProbeAnswer {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides }
}

function probeAt(file: string | undefined, answer: (file: string, args: string[]) => ProbeAnswer = () => answering()): ClaudeProbe {
  return { find: () => file, run: answer }
}

test('a Windows Claude probe refuses an absent program, a shim, and a version below the floor', () => {
  const absent = windowsClaude(probeAt(undefined))
  if (!('refusal' in absent)) throw new Error('an absent claude must be refused')
  expect(absent.refusal).toContain('no claude was found on PATH')
  expect(absent.refusal).toContain('no agent was started')

  for (const shim of ['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.ps1', 'claude']) {
    const refused = windowsClaude(probeAt(shim))
    if (!('refusal' in refused)) throw new Error(`a non-native program must be refused: ${shim}`)
    expect(refused.refusal).toContain('not a native .exe')
  }

  const old = windowsClaude(probeAt('C:\\Program Files\\Claude\\claude.exe', () => answering({ stdout: '2.1.300 (Claude Code)\n' })))
  if (!('refusal' in old)) throw new Error('an old claude must be refused')
  expect(old.refusal).toContain(CLAUDE_WINDOWS_MINIMUM)
  expect(old.refusal).toContain('2.1.300')
  expect(old.refusal).toContain('no agent was started')
})

test('a Windows Claude probe refuses a failed, silent or hung answer instead of guessing a version', () => {
  const file = 'C:\\Program Files\\Claude\\claude.exe'
  // Every failure carries a legitimate-looking version on stdout: a non-zero exit, a signal or a deadline still means
  // the answer is untrustworthy, so the version must never be read out of it.
  const printed = `${CLAUDE_WINDOWS_MINIMUM} (Claude Code)\n`
  const cases: Array<[string, ProbeAnswer]> = [
    ['it exited with 3', answering({ exitCode: 3, stdout: printed })],
    ['it was stopped by a signal', answering({ exitCode: null, stdout: printed })],
    ['it did not answer within its deadline', answering({ timedOut: true, stdout: printed })],
    ['it exited with 3', answering({ exitCode: 3 })],
    ['it was stopped by a signal', answering({ exitCode: null })],
    ['it did not answer within its deadline', answering({ timedOut: true })],
    ['it printed no version', answering({ stdout: 'claude: not a version\n' })],
  ]
  for (const [reason, answer] of cases) {
    const refused = windowsClaude(probeAt(file, () => answer))
    if (!('refusal' in refused)) throw new Error(`a ${reason} answer must be refused`)
    expect(refused.refusal).toContain('could not read Claude Code\'s version')
    expect(refused.refusal).toContain(reason)
  }
  const threw = windowsClaude(probeAt(file, () => { throw new Error('spawn failed') }))
  if (!('refusal' in threw)) throw new Error('a probe that cannot start must be refused')
  expect(threw.refusal).toContain('could not start Claude Code at')
  expect(threw.refusal).toContain('spawn failed')
})

test('a Windows Claude probe accepts the floor version and anything later, and asks with one argv call', () => {
  const file = 'C:\\Program Files\\Claude\\claude.exe'
  let asked: string[] | undefined
  const accepted = windowsClaude(probeAt(file, (called, args) => { asked = [called, ...args]; return answering({ stdout: `${CLAUDE_WINDOWS_MINIMUM} (Claude Code)\n` }) }))
  if ('refusal' in accepted) throw new Error(accepted.refusal)
  expect(accepted).toEqual({ path: file, version: CLAUDE_WINDOWS_MINIMUM })
  // One bounded argv call, no shell: the version probe is the only thing this code ever starts.
  expect(asked).toEqual([file, '--version'])
  const later = windowsClaude(probeAt(file, () => answering({ stdout: '2.1.400\n' })))
  if ('refusal' in later) throw new Error(later.refusal)
  expect(later).toEqual({ path: file, version: '2.1.400' })
})

interface TerminalRun { argv: string[]; env: Record<string, string>; cwd: string }

/** A probe that refuses before any program runs, so no test can ever start a real provider. */
const absent: ClaudeProbe = { find: () => undefined, run: () => { throw new Error('a refused launch must not run the probe') } }

function fixture(platform: NodeJS.Platform, probe: ClaudeProbe = absent) {
  // The home leaf is missing on purpose: a mkdtemp directory inherits the temp parent's looser ACL, which a Windows
  // store refuses. `prepareHome` inside CoreStore creates and protects the leaf, so the fixture is valid on every host.
  const parent = mkdtempSync(join(tmpdir(), 'shep-windows-agents-')), home = join(parent, 'home'), store = new CoreStore(home)
  let grants = 0
  const requests: TerminalRun[] = []
  const core = { current: { terminals: new Map() }, call: async (_method: string, input: TerminalRun) => { requests.push(input); return { address: 't1', pid: 1 } } } as unknown as CoreSession
  const mailbox = { issue: () => { grants++; return { id: 'grant', credential: {} } }, revoke: () => {} } as unknown as Mailbox
  const agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
    { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, async () => undefined, () => {}, undefined, platform, probe)
  const space: CoreSpace = { id: 'space', name: 'Example', machine: 'machine', folder: 'C:\\repo', base: 'main', prefix: 'EX', mode: 'regular', added: 1 }
  store.set('meta', 'local', { id: 'machine' })
  return { home, store, agents, space, requests, counts: () => ({ grants, calls: requests.length }), cleanup: () => { store.close(); rmSync(parent, { recursive: true, force: true }) } }
}

test('Autopilot on this Windows machine refuses before any state, grant or terminal', async () => {
  const f = fixture('win32')
  try {
    const launching = f.agents.launch(f.space, 'chat', 'claude', 'Wait', { pilot: { run: 'run', hosts: ['api.anthropic.com'], repo: 'C:\\repo' } })
    await expect(launching).rejects.toThrow(AUTOPILOT_WINDOWS)
    expect(f.counts()).toEqual({ grants: 0, calls: 0 })
    expect(existsSync(join(f.home, 'sessions'))).toBe(false)
    expect(f.store.get('agent', 'chat')).toBeUndefined()
  } finally { f.cleanup() }
})

test('Codex on Windows refuses before a grant while its hook shell is unverified', async () => {
  const f = fixture('win32')
  try {
    const launching = f.agents.launch(f.space, 'chat', 'codex', 'Wait')
    await expect(launching).rejects.toThrow('has not verified')
    expect(f.counts()).toEqual({ grants: 0, calls: 0 })
    expect(existsSync(join(f.home, 'sessions'))).toBe(false)
    expect(f.store.get('agent', 'chat')).toBeUndefined()
  } finally { f.cleanup() }
})

test('a Windows Claude launch refuses before a grant when no native program or a version below the floor is found', async () => {
  const file = 'C:\\Program Files\\Claude\\claude.exe'
  // A version-shaped line on stdout does not rescue a failed probe: a launch must refuse before a grant, a session
  // directory, a private launch file, a terminal or a history entry exists.
  const printed = `${CLAUDE_WINDOWS_MINIMUM} (Claude Code)\n`
  const cases: Array<[ClaudeProbe, string]> = [
    [absent, 'no claude was found on PATH'],
    [probeAt('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'), 'not a native .exe'],
    [probeAt(file, () => answering({ stdout: '2.1.300\n' })), CLAUDE_WINDOWS_MINIMUM],
    [probeAt(file, () => answering({ timedOut: true })), 'did not answer within its deadline'],
    [probeAt(file, () => answering({ exitCode: 3, stdout: printed })), 'exited with 3'],
    [probeAt(file, () => answering({ exitCode: null, stdout: printed })), 'stopped by a signal'],
    [probeAt(file, () => answering({ timedOut: true, stdout: printed })), 'did not answer within its deadline'],
  ]
  for (const [probe, text] of cases) {
    const f = fixture('win32', probe)
    try {
      const launching = f.agents.launch(f.space, 'chat', 'claude', 'Wait')
      await expect(launching).rejects.toThrow(text)
      // A refusal happens before a grant, a session directory, a private launch file or a terminal: nothing to undo.
      expect(f.counts()).toEqual({ grants: 0, calls: 0 })
      expect(existsSync(join(f.home, 'sessions'))).toBe(false)
      expect(f.store.get('agent', 'chat')).toBeUndefined()
      expect(f.store.all('agent-launch')).toEqual([])
    } finally { f.cleanup() }
  }
})

// A simulated POSIX host on a real Windows runner would write its launch files through POSIX file modes, which proves
// nothing about Windows and is not a positive control. The POSIX shape is proven on POSIX; Windows refusals are above.
test.skipIf(process.platform === 'win32')('the same launch on a POSIX host still issues its grant and reaches terminal.run', async () => {
  const f = fixture('linux')
  try {
    const agent = await f.agents.launch(f.space, 'chat', 'claude', 'Wait')
    expect(agent).toMatchObject({ terminal: 't1', pid: 1, state: 'starting' })
    expect(f.counts()).toEqual({ grants: 1, calls: 1 })
    expect(f.store.get<CoreAgent>('agent', 'chat')?.hook).toStartWith(join(f.home, 'sessions'))
  } finally { f.cleanup() }
})

test.skipIf(process.platform !== 'win32')('a Windows Claude launch runs the verified exe, keeps private files and writes no auto-allow rule', async () => {
  const claude = 'C:\\Program Files\\Claude\\claude.exe'
  let asked: string[] | undefined
  const probe: ClaudeProbe = { find: () => claude, run: (file, args) => { asked = [file, ...args]; return answering({ stdout: `${CLAUDE_WINDOWS_MINIMUM} (Claude Code)\n` }) } }
  const f = fixture('win32', probe)
  try {
    const agent = await f.agents.launch(f.space, 'chat', 'claude', 'Wait')
    const entry = join(root, 'bin', 'shepherdr.cmd'), script = join(root, 'helper', 'core-hook.ts'), directory = join(f.home, 'sessions')
    expect(asked).toEqual([claude, '--version'])
    expect(agent).toMatchObject({ terminal: 't1', pid: 1, state: 'starting', command: entry })
    expect(f.counts()).toEqual({ grants: 1, calls: 1 })
    expect(agent.hook).toStartWith(directory)

    const [run] = f.requests
    // The terminal gets the program whose version was checked, not a `claude` name a shell would resolve itself.
    expect(run.argv[0]).toBe(claude)
    expect(run.argv).not.toContain('claude')
    expect(run.argv).not.toContain('--permission-mode')
    expect(run.argv).not.toContain('--dangerously-skip-permissions')
    expect(run.env.SHEPHERDR_COMMAND).toBe(entry)
    expect(run.env.PATH.startsWith(join(root, 'bin') + ';')).toBe(true)
    expect(run.env.PATH).not.toContain(join(root, 'bin') + ':')

    const settings = JSON.parse(readFileSync(run.argv[run.argv.indexOf('--settings') + 1], 'utf8'))
    // Exec form: the program and the script are separate argv entries, so no path is re-parsed by a shell.
    expect(settings.hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: process.execPath, args: [script], timeout: 5 })
    expect(settings.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: 'command', command: process.execPath, args: [script], timeout: 3600, onFailure: 'block' })
    expect(settings.hooks.Stop[0].hooks[0]).not.toHaveProperty('onFailure')
    // A Windows path is outside the own-command grammar, so the launch ships an empty allow list: every call asks.
    expect(settings.permissions).toEqual({ allow: [] })

    for (const name of ['grant.credential.json', 'grant.hooks.jsonl', 'grant.settings.json', 'grant.instructions.md']) expect(() => verifyPrivateFile(join(directory, name))).not.toThrow()
    expect(readPrivateFile(join(directory, 'grant.instructions.md'))).toContain('ask for permission the normal way')
    expect(readPrivateFile(join(directory, 'grant.instructions.md'))).not.toContain('only that form needs no permission')
  } finally { f.cleanup() }
})

test.skipIf(process.platform !== 'win32')('a Windows hook file another account could replace denies the permission request', () => {
  const parent = mkdtempSync(join(tmpdir(), 'shep-hook-windows-'))
  try {
    // The credential lives where a launch puts it: inside a protected home. Reading it back is the positive control —
    // the deny below must come from the hook file's ACL, not from an unreadable or loose credential.
    const home = join(parent, 'home')
    preparePrivateDirectory(home)
    const credential = join(home, 'grant.credential.json'), hook = join(parent, 'grant.hooks.jsonl')
    writePrivateFile(credential, JSON.stringify({ mail: { id: 'grant' }, endpoint: '\\\\.\\pipe\\unreached' }))
    // Written beside the protected home, under the temp directory's inherited DACL. The unsafety is asserted, not
    // assumed: if this file happened to be protected the deny below would prove nothing about the check.
    writeFileSync(hook, '')
    expect(readPrivateFile(credential)).toContain('"grant"')
    expect(() => verifyPrivateFile(hook)).toThrow()
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'helper', 'core-hook.ts')], {
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })),
      env: { ...process.env, SHEPHERDR_CORE_CREDENTIAL: credential, SHEPHERDR_CORE_HOOK_FILE: hook },
    })
    expect(run.stdout.toString()).toContain('"behavior":"deny"')
  } finally { rmSync(parent, { recursive: true, force: true }) }
})
