// The Windows lifecycle around the private state: the record and the lock are written and read through the fixed
// helper (real DACL, real refusal), and a stop goes through the authenticated operator instead of a pid. These tests
// are written for GitHub's Windows runner; this machine never runs them (see AGENTS.md). The real-core case needs
// SHEPHERDR_TEST_CORE_BIN from T6's CI step, and reports UNVERIFIED when that input is absent.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CoreClient } from '../server/core/client.ts'
import { prepareHome } from '../server/core/home.ts'
import { removeRunRecord, runRecord, withLock, writeRunRecord } from '../server/core/launcher.ts'
import { operatorStop } from '../server/core/operator.ts'
import type { CoreTerminal } from '../server/core/protocol.ts'
import type { CoreSource } from '../server/core/source.ts'
import { createPrivateDirectory, writePrivateFile } from '../server/core/windows-security.ts'
import { startWindowsOperator } from '../server/core/windows-operator.ts'

const WINDOWS = process.platform === 'win32'
const ROOT = join(import.meta.dir, '..')

/**
 * The first version only serves an ordinary medium-integrity user. GitHub's Windows runners start their processes
 * elevated (high integrity), so the plain-token path stays unproven there and T6 has to run it.
 */
const PLAIN_USER = WINDOWS && plainUser()
const CORE_BIN = process.env.SHEPHERDR_TEST_CORE_BIN

function plainUser(): boolean {
  const who = spawnSync('whoami.exe', ['/groups'], { windowsHide: true, encoding: 'utf8' })
  const output = typeof who.stdout === 'string' ? who.stdout : String(who.stdout ?? '')
  return who.status === 0 && output.includes('S-1-16-8192')
}

type FakeSource = {
  quiescing: boolean
  secrets: { operator(args: string[], stdin?: string): Promise<string> }
}

function fakeSource(): FakeSource {
  return { quiescing: false, secrets: { operator: async args => `ran ${args.join(' ')}\n` } }
}

async function until<T>(probe: () => T | undefined | false, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error('Timed out waiting for the Windows lifecycle state')
}

/** The home is a missing leaf under this test's own parent, so prepareHome creates the protected DACL itself. */
function isolatedHome(prefix: string) {
  const parent = mkdtempSync(join(tmpdir(), prefix))
  return { parent, home: join(parent, 'home') }
}

/** Grant Everyone explicitly: a hand-made directory inherits whatever the runner has, which is not the point of the test. */
function loosen(path: string) {
  const granted = spawnSync('icacls.exe', [path, '/grant', '*S-1-1-0:(OI)(CI)F'], { windowsHide: true })
  expect(granted.status).toBe(0)
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')))
    })
  })
}

/**
 * Run one command with a single deadline for the whole call: its exit, its stdout and its stderr are awaited together,
 * and a call that outlives the deadline is killed. A byte cap alone is not a bound: a fixture that never closes its
 * pipes would otherwise hold the runner forever.
 */
type Result = { out: string; err: string; code: number }
async function run(command: string[], env: Record<string, string>, ms = 60_000): Promise<Result> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env, windowsHide: true })
  const cancel = new AbortController()
  const out = read(child.stdout, cancel.signal)
  const err = read(child.stderr, cancel.signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  const raced = await Promise.race([
    Promise.all([child.exited, out, err]).then(([code, o, e]) => ({ out: o, err: e, code })),
    new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms) }),
  ])
  clearTimeout(timer)
  if (raced !== 'timeout') return raced
  cancel.abort()
  try { child.kill() } catch { /* already gone */ }
  // Descendants can inherit these pipes. Cancel the reads and bound the reap as well as the original command.
  let reapTimer: ReturnType<typeof setTimeout> | undefined
  const code = await Promise.race([child.exited, new Promise<number>(resolve => { reapTimer = setTimeout(() => resolve(124), 2000) })])
  clearTimeout(reapTimer)
  return { out: await out, err: `${await err}\nThe command did not finish within ${ms} ms and was killed`, code: code || 124 }
}

/** The launcher CLI through the same entry the product uses; the sh wrapper is not a Windows entry. */
async function cli(args: string[], env: Record<string, string>, ms = 60_000): Promise<Result> {
  return await run([process.execPath, join(ROOT, 'helper/core-entry.ts'), ...args], env, ms)
}

async function read(stream: ReadableStream<Uint8Array>, signal: AbortSignal, limit = 64 * 1024): Promise<string> {
  const reader = stream.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      size += value.length
    }
  } finally { signal.removeEventListener('abort', cancel); cancel() }
  return Buffer.concat(chunks).toString('utf8')
}

/** A private environment for this test's core only: nothing here reads or writes the runner's own Shepherdr state. */
function isolatedEnv(parent: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  for (const key of ['SHEPHERDR_CORE_CREDENTIAL', 'SHEPHERDR_BACKEND', 'SHEPHERDR_HOME', 'SHEPHERDR_PORT', 'HC_SESSION', 'HC_SOCKET']) delete env[key]
  env.XDG_CONFIG_HOME = join(parent, 'config')
  env.XDG_STATE_HOME = join(parent, 'state')
  return env
}

/**
 * The same bounded wait, for a probe that has to ask the core again each time. A refusal from the core is reported as
 * itself rather than retried into a timeout: the wait is for a growing counter, not for a working connection.
 */
async function untilAsked<T>(probe: () => Promise<T | undefined | false>, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error('Timed out waiting for the kept program to print again')
}

/** The program the core runs is named in full: a `pwsh` or a shim from PATH would be a different program. */
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * A static, non-destructive program with no account, no provider and no state outside its own process: one line per
 * tick carrying this test's nonce, the program's own `$PID` and a counter that only grows. `terminal.run` takes it as
 * argv, so nothing here is a shell string and nothing here claims an agent works.
 */
function counterProgram(nonce: string): string[] {
  return [POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', `$i = 0; while ($true) { $i++; Write-Output ('shep-tick ${nonce} ' + $PID + ' ' + $i); Start-Sleep -Milliseconds 200 }`]
}

/** The last line this nonce printed, read from a bounded tail of the screen: an unbounded screen is not a fixture. */
function ticks(text: string, nonce: string): { pid: number; counter: number } | undefined {
  const marker = `shep-tick ${nonce} `
  let last: { pid: number; counter: number } | undefined
  for (const line of text.slice(-64 * 1024).split('\n')) {
    const at = line.indexOf(marker)
    if (at < 0) continue
    const [pid, counter] = line.slice(at + marker.length).trim().split(/\s+/)
    const numbers = [Number(pid), Number(counter)]
    if (numbers.every(value => Number.isInteger(value) && value > 0) && numbers[1]! > (last?.counter ?? 0)) last = { pid: numbers[0]!, counter: numbers[1]! }
  }
  return last
}

/** The bounded screen read every assertion below uses: 300 lines of the kept terminal, no more. */
async function screen(client: CoreClient, address: string): Promise<string> {
  const read = await client.call<{ text: string }>('terminal.read', { terminal: address, lines: 300 })
  return typeof read.text === 'string' ? read.text : ''
}

type Status = { pid?: number; holder?: { current?: boolean; instance?: string; pid?: number; terminals?: number } }

/** The core and the holder behind it, as the core itself reports them: a pid alone proves neither. */
async function coreStatus(client: CoreClient): Promise<{ core: number; holder: { instance: string; pid: number; current: boolean } }> {
  const answer = await client.call<Status>('server.status')
  const holder = answer.holder
  if (typeof answer.pid !== 'number' || !holder || typeof holder.instance !== 'string' || typeof holder.pid !== 'number') throw new Error(`server.status did not name the core and its holder: ${JSON.stringify(answer)}`)
  return { core: answer.pid, holder: { instance: holder.instance, pid: holder.pid, current: holder.current === true } }
}

test.skipIf(!WINDOWS)('a private record round-trips through the fixed helper, and only its own boot removes it', () => {
  const { parent, home } = isolatedHome('shep-win-state-')
  try {
    prepareHome(home)
    const record = { pid: process.pid, boot: randomUUID(), home, port: 17888, root: ROOT, operator: '\\\\.\\pipe\\shepherdr-operator-11111111-22222222', operatorPid: 424242 }
    writeRunRecord(home, record)
    // Read back through readPrivateFile: this only succeeds because the helper wrote a DACL it accepts as private.
    expect(runRecord(home)).toEqual(record)
    expect(removeRunRecord(home, randomUUID())).toBe(false)
    expect(runRecord(home)?.boot).toBe(record.boot)
    expect(removeRunRecord(home, record.boot)).toBe(true)
    expect(runRecord(home)).toBeUndefined()
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('state that is not private is refused, never read as absent', () => {
  const { parent, home } = isolatedHome('shep-win-loose-')
  try {
    // Explicitly foreign, not inherited: whether the runner's temp directory happens to be private is not the test.
    mkdirSync(home)
    loosen(home)
    expect(() => writeRunRecord(home, { pid: process.pid, boot: randomUUID(), home, port: 17888, root: ROOT })).toThrow()
    // And a record written behind its back is refused on read rather than reported as "stopped".
    writeFileSync(join(home, 'run.json'), JSON.stringify({ pid: process.pid, boot: randomUUID(), home, port: 17888, root: ROOT }))
    expect(() => runRecord(home)).toThrow()
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a lock is reclaimed only when its owner is provably gone; a loose or ownerless one is refused', async () => {
  const { parent, home } = isolatedHome('shep-win-lock-')
  const lock = join(home, 'lifecycle.lock')
  const past = new Date(Date.now() - 60_000)
  try {
    prepareHome(home)
    expect(await withLock(home, async () => 'ran')).toBe('ran')
    expect(existsSync(lock)).toBe(false)

    // No owner file, however old: a paused start may still be inside its write window, so this is never deleted.
    createPrivateDirectory(lock)
    utimesSync(lock, past, past)
    await expect(withLock(home, async () => 'never', 1)).rejects.toThrow('no readable owner')
    expect(existsSync(lock)).toBe(true)
    rmSync(lock, { recursive: true, force: true })

    // A live process this account cannot signal (System) is not dead: EPERM is not a death certificate.
    createPrivateDirectory(lock)
    writePrivateFile(join(lock, 'owner'), `4:${randomUUID()}`)
    utimesSync(lock, past, past)
    await expect(withLock(home, async () => 'never', 1)).rejects.toThrow('still in progress')
    expect(existsSync(lock)).toBe(true)
    rmSync(lock, { recursive: true, force: true })

    // A directory the helper did not create cannot be trusted as "another start in progress".
    mkdirSync(lock)
    loosen(lock)
    await expect(withLock(home, async () => 'never', 1)).rejects.toThrow()
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test.skipIf(!PLAIN_USER)('a stop goes through the authenticated operator and runs the callback after the receipt', async () => {
  const { parent, home } = isolatedHome('shep-win-stop-')
  const boot = randomUUID()
  const source = fakeSource()
  let stopped = 0
  const operator = await startWindowsOperator(source as unknown as CoreSource, boot, { onStop: () => { stopped += 1 } })
  try {
    expect(operator.pid).toBeGreaterThan(0)
    const expected = { boot, appPid: process.pid, helperPid: operator.pid }
    const result = await operatorStop(home, operator.path, expected)
    expect(result.code).toBe(0)
    expect(result.out).toContain('Stopping Shepherdr.')
    // The callback follows the client's receipt, not the earlier hello.
    await until(() => stopped === 1, 5000)

    // The same pipe refuses an identity that is not this helper: the wrong helper pid never reaches the handler.
    await expect(operatorStop(home, operator.path, { ...expected, helperPid: operator.pid + 1 })).rejects.toThrow()
    expect(stopped).toBe(1)
    // A wrong boot is refused the same way, before any secret could travel.
    await expect(operatorStop(home, operator.path, { ...expected, boot: randomUUID() })).rejects.toThrow()
    expect(stopped).toBe(1)
  } finally { operator.close(); rmSync(parent, { recursive: true, force: true }) }
})

/**
 * The end-to-end case. Without SHEPHERDR_TEST_CORE_BIN (T6's CI input) it is UNVERIFIED, never a pass by skipping.
 * `--no-plugin-updates` removes the built-page requirement, so no `dist` is needed; every endpoint
 * (session, pipe, port, home) is this test's own, and the record read is the production private read, not a mock.
 *
 * What is asserted: the app and its helper are distinct processes, a program started in this test's own core keeps
 * printing with its original pid, and after Shepherdr is stopped, restarted and started twice the core pid, the holder
 * instance and pid, and that one program are all unchanged — a growing counter, not a "live" state word. What is NOT
 * asserted: a real agent. No Claude Code, Codex or account is involved, so this proves core/holder/program continuity
 * only; the real provider hook loop stays UNVERIFIED until T6 runs one.
 */
test.skipIf(!PLAIN_USER || !CORE_BIN)('a real core keeps its holder and its original program across a stop, a restart and a repeated start', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'shep-win-life-'))
  const home = join(parent, 'home')
  const env = isolatedEnv(parent)
  const session = `lifecycle-${randomUUID().slice(0, 8)}`
  const socket = `\\\\.\\pipe\\shepherdr-lifecycle-${randomUUID().slice(0, 8)}`
  const port = await freePort()
  const nonce = randomUUID().slice(0, 8)
  const options = ['--home', home, '--port', String(port), '--core-bin', CORE_BIN!, '--core-session', session, '--core-socket', socket, '--no-plugin-updates']
  let app: number | undefined
  let core: CoreClient | undefined
  let later: CoreClient | undefined
  try {
    const start = await cli(['start', ...options], env)
    expect(start.code, `${start.out}\n${start.err}`).toBe(0)
    const record = await until(() => {
      const current = runRecord(home)
      return current && typeof current.operatorPid === 'number' && current.pid > 0 ? current : undefined
    }, 60_000)
    app = record.pid
    expect(record.operatorPid).toBeGreaterThan(0)
    expect(record.operatorPid).not.toBe(record.pid)
    expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toMatchObject({ boot: record.boot, pid: record.pid })

    const status = await cli(['status', ...options], env)
    expect(status.code, status.err).toBe(0)
    expect(status.out).toContain(`Shepherdr is running (PID ${record.pid})`)

    // The program runs in the core this app was given, not in the app: no account, no provider, one tick per 200 ms.
    core = await CoreClient.open(socket)
    const terminal = await core.call<CoreTerminal>('terminal.run', {
      argv: counterProgram(nonce), cwd: parent, name: `t6-holder-${nonce}`, keep: true, labels: { probe: 't6-holder', nonce },
    })
    expect(terminal.address).toMatch(/\S/)
    // Live is observed from the core, not assumed from the run reply: a program that exited at once must not read as kept.
    const live = await untilAsked(async () => {
      const current = await core!.call<CoreTerminal>('terminal.get', { terminal: terminal.address })
      return current.state === 'live' ? current : undefined
    }, 15_000)
    expect(live.address).toBe(terminal.address)

    // Enough ticks to compare against, observed rather than slept for: a single tick could be the last one before a kill.
    const first = await untilAsked(async () => {
      const seen = ticks(await screen(core!, terminal.address), nonce)
      return seen && seen.counter >= 3 ? seen : undefined
    }, 15_000)
    expect(first.pid).toBeGreaterThan(0)
    if (typeof terminal.pid === 'number') expect(first.pid).toBe(terminal.pid)
    // A fresh core may not have a holder until its first terminal has actually started.
    const before = await coreStatus(core)
    expect(before.holder.current).toBe(true)

    const stop = await cli(['stop', ...options], env)
    expect(stop.code, `${stop.out}\n${stop.err}`).toBe(0)
    expect(stop.out).toContain('Shepherdr stopped.')
    expect(runRecord(home)).toBeUndefined()
    await until(() => { try { process.kill(record.pid, 0); return false } catch { return true } }, 10_000)

    // A new client, so nothing here is a cached socket: the core the app was running on is untouched by this stop.
    later = await CoreClient.open(socket)
    const afterStop = await coreStatus(later)
    expect(afterStop.core).toBe(before.core)
    expect(afterStop.holder.instance).toBe(before.holder.instance)
    expect(afterStop.holder.pid).toBe(before.holder.pid)
    const kept = await later.call<CoreTerminal>('terminal.get', { terminal: terminal.address })
    expect(kept.state).toBe('live')
    // The pid the core reports for the terminal is only compared when it reports one: the marker pid above is the proof.
    if (typeof kept.pid === 'number') expect(kept.pid).toBe(first.pid)
    const continued = await untilAsked(async () => {
      const seen = ticks(await screen(later!, terminal.address), nonce)
      return seen && seen.pid === first.pid && seen.counter > first.counter ? seen : undefined
    }, 15_000)
    expect(continued.counter).toBeGreaterThan(first.counter)

    // Restart on the same home: a new boot, while the core, its holder and the program persist. Windows may reuse PIDs.
    const again = await cli(['start', ...options], env)
    expect(again.code, `${again.out}\n${again.err}`).toBe(0)
    const second = await until(() => {
      const current = runRecord(home)
      return current && typeof current.operatorPid === 'number' && current.pid > 0 ? current : undefined
    }, 60_000)
    expect(second.boot).not.toBe(record.boot)
    expect(second.operatorPid).toBeGreaterThan(0)
    expect(second.operatorPid).not.toBe(second.pid)
    app = second.pid
    expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toMatchObject({ boot: second.boot, pid: second.pid })

    const restarted = await coreStatus(later)
    expect(restarted.core).toBe(before.core)
    expect(restarted.holder.instance).toBe(before.holder.instance)
    expect(restarted.holder.pid).toBe(before.holder.pid)
    const listed = await later.call<{ terminals: CoreTerminal[] }>('terminal.list', { all: true })
    const ours = listed.terminals.filter(item => item.labels?.nonce === nonce)
    // No second copy of the program: the restart neither re-ran it nor left a duplicate behind.
    expect(ours.map(item => item.address)).toEqual([terminal.address])
    if (typeof ours[0]!.pid === 'number') expect(ours[0]!.pid).toBe(first.pid)
    const stillGrowing = await untilAsked(async () => {
      const seen = ticks(await screen(later!, terminal.address), nonce)
      return seen && seen.pid === first.pid && seen.counter > continued.counter ? seen : undefined
    }, 15_000)
    expect(stillGrowing.counter).toBeGreaterThan(continued.counter)

    // A repeated start while that boot is healthy is a report, not a second instance: same boot, same app pid.
    const repeated = await cli(['start', ...options], env)
    expect(repeated.code, `${repeated.out}\n${repeated.err}`).toBe(0)
    expect(repeated.out).toContain(`Shepherdr is running (PID ${second.pid})`)
    expect(runRecord(home)?.boot).toBe(second.boot)
    expect(runRecord(home)?.pid).toBe(second.pid)

    const final = await cli(['stop', ...options], env)
    expect(final.code, `${final.out}\n${final.err}`).toBe(0)
    expect(final.out).toContain('Shepherdr stopped.')
    expect(runRecord(home)).toBeUndefined()
  } finally {
    // Cleanup owns exactly two processes, both verified before they are touched. The app is the pid this home's record
    // named (or the one read back here after a failed start); it is asked to stop first and only killed if it outlives
    // that. Never a guessed pid, and never a process outside this fixture's home.
    try { later?.close() } catch { /* already closed */ }
    try { core?.close() } catch { /* already closed */ }
    let owned = app
    if (owned === undefined) {
      try { owned = runRecord(home)?.pid } catch { /* an untrusted record names nothing this test may kill */ }
    }
    if (owned !== undefined) {
      try { await cli(['stop', ...options], env, 15_000) } catch { /* best effort before the hard stop */ }
      try { process.kill(owned, 0); process.kill(owned) } catch { /* already gone */ }
    }
    // The isolated core is this test's too. Stopping it here uses the absolute test binary, this test's session and its
    // private pipe only; production code never does this (Shepherdr's own stop must not touch core), and skipping it
    // would leave a core running on state that is about to be deleted.
    const coreStop = await run([CORE_BIN!, 'server', 'stop'], { ...env, HC_SESSION: session, HC_SOCKET: socket }, 30_000).catch(error => ({ out: '', err: `${error.message}`, code: 1 }))
    if (coreStop.code !== 0) console.error(`The fixture core did not stop; isolated state was retained at ${parent}: ${coreStop.err}`)
    else rmSync(parent, { recursive: true, force: true })
  }
})
