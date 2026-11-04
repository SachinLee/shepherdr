import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { prepareHome } from '../server/core/home.ts'
import { coreConfig } from '../server/core/config.ts'
import { createPrivateDirectory, writePrivateFile } from '../server/core/windows-security.ts'
import { buildProblem, claimHome, coreMachines, coreProblem, launcherStatus, removeRunRecord, runRecord, saveCore, withLock, writeRunRecord } from '../server/core/launcher.ts'
import { coreShutdown, shutdownOnce } from '../server/core/main.ts'

test('a live unconfirmed process never reports stopped or gets signaled', async () => {
  // A missing leaf under an isolated parent: on Windows prepareHome must create the protected DACL itself, so an
  // inherited (loose) directory is never accepted as this test's home.
  const parent = mkdtempSync(join(tmpdir(), 'shep-launcher-'))
  const home = join(parent, 'home')
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('not ready', { status: 503 }) })
  try {
    prepareHome(home)
    const record = { pid: process.pid, boot: 'starting', home, port: server.port!, root: '/unused' }
    // On Windows the record is written by the helper like the product does; a file written behind its back is refused.
    if (process.platform === 'win32') writeRunRecord(home, record)
    else writeFileSync(join(home, 'run.json'), JSON.stringify(record), { mode: 0o600 })
    const text = await launcherStatus({ home, port: server.port!, binary: 'hc', session: 'test', socket: '/unused' })
    expect(text).toContain('process is alive')
    expect(text).not.toContain('is stopped')
    expect(text).toContain('not confirmed yet')
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  } finally { server.stop(true); rmSync(parent, { recursive: true, force: true }) }
})

test('start refuses an unbuilt application and names the step; a Vite preview serves its own page', () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-launcher-build-'))
  try {
    expect(buildProblem({}, root)).toContain(`bun run build in ${root}`)
    expect(buildProblem({ plugins: false }, root)).toBeUndefined()
    mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist/index.html'), '<!doctype html>')
    expect(buildProblem({}, root)).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Unix default-socket semantics: with no --core-socket the config falls back to the Unix socket, which Windows refuses
// outright. The Windows rule (an explicit endpoint, and a refusal without one) is covered by core-windows-cli.
test.skipIf(process.platform === 'win32')('a new home never takes on its core\'s machines unless its start names that core', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-launcher-machines-'))
  const machines = async () => [{ name: 'mac-mini' }, { name: 'vps' }]
  const inherited = process.env.HC_SESSION, socket = process.env.HC_SOCKET
  process.env.HC_SESSION = 'default' // what any hc terminal hands down: never a choice
  delete process.env.HC_SOCKET
  try {
    const home = join(root, 'trial')
    const config = coreConfig(['--home', home, '--port', '17941'])
    expect(config.chosenCore).toBe(false)
    const refused = await coreProblem(config, machines)
    expect(refused).toContain('2 machines (mac-mini, vps)')
    expect(refused).toContain('Nothing was started')
    expect(refused).toContain('--core-session default')
    expect(existsSync(home)).toBe(false)

    // An empty home is a directory with no core marker: a plain mode-0700 mkdir on POSIX, and on Windows the private
    // directory production would make, where a bare mkdir would be a loose one. prepareHome writes the marker, so it
    // would end the empty phase instead of starting it.
    if (process.platform === 'win32') createPrivateDirectory(home)
    else mkdirSync(home, { mode: 0o700 })
    expect(await coreProblem(config, machines)).toContain('already has 2 machines')
    expect(await coreProblem(config, async () => [])).toBeUndefined()

    const unasked = async () => { throw new Error('must not ask core') }
    expect(await coreProblem(coreConfig(['--home', home, '--core-session', 'trial']), unasked)).toBeUndefined()
    expect(await coreProblem(coreConfig(['--home', home, '--core-session', 'default']), unasked)).toBeUndefined()
    expect(await coreProblem(coreConfig(['--home', home, '--core-socket', join(root, 'core.sock')]), unasked)).toBeUndefined()

    prepareHome(home)
    expect(await coreProblem(config, unasked)).toBeUndefined()

    // A trial on its own core stays there: a later start with fewer words never lands on the shared one.
    const trial = coreConfig(['--home', home, '--core-session', 'trial'])
    saveCore(trial)
    const restart = await coreProblem(config, unasked)
    expect(restart).toContain('runs on core session trial at')
    expect(restart).toContain(`--core-session trial --core-socket ${trial.socket}`)
    expect(await coreProblem(trial, unasked)).toBeUndefined()

    // Held to the session and the socket: either alone can be a different core with its own machines.
    saveCore(config)
    expect(await coreProblem({ ...config, socket: join(root, 'moved.sock') }, unasked)).toContain('Nothing was started')
    expect(await coreProblem({ ...config, session: 'other' }, unasked)).toContain('Nothing was started')

    // An inherited socket never overrides a named session; only --core-socket does.
    process.env.HC_SOCKET = join(root, 'shared.sock')
    expect(coreConfig(['--home', home]).socket).toBe(join(root, 'shared.sock'))
    expect(coreConfig(['--home', home, '--core-session', 'trial']).socket).not.toBe(join(root, 'shared.sock'))
    expect(coreConfig(['--home', home, '--core-session', 'trial', '--core-socket', join(root, 'mine.sock')]).socket).toBe(join(root, 'mine.sock'))
    delete process.env.HC_SOCKET

    // A first start that fails after making the home still leaves its core: the retry is not a home from before the record.
    const failed = coreConfig(['--home', join(root, 'failed'), '--core-session', 'trial'])
    claimHome(failed)
    expect(await coreProblem({ ...failed, chosenCore: false, session: 'default' }, unasked)).toContain('Nothing was started')
    claimHome(failed)
    saveCore({ ...failed, session: 'later' })
    claimHome(failed)
    expect(await coreProblem({ ...failed, chosenCore: false, session: 'later' }, unasked)).toBeUndefined()
  } finally {
    if (inherited === undefined) delete process.env.HC_SESSION
    else process.env.HC_SESSION = inherited
    if (socket === undefined) delete process.env.HC_SOCKET
    else process.env.HC_SOCKET = socket
    rmSync(root, { recursive: true, force: true })
  }
})

// Also a Unix default-socket case: coreConfig would refuse it on Windows before the machine question is asked.
test.skipIf(process.platform === 'win32')('a stopped core is never started just to learn its machines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-launcher-stopped-'))
  const state = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  try {
    const config = coreConfig(['--home', join(root, 'trial'), '--core-bin', join(root, 'no-such-hc'), '--no-plugin-updates'])
    const saved = join(root, 'herdr-core', config.session)
    mkdirSync(saved, { recursive: true })
    writeFileSync(join(saved, 'machines.json'), JSON.stringify([{ name: 'mac-mini' }]))
    expect(await coreProblem(config, () => coreMachines(config))).toContain('a machine (mac-mini)')

    // No saved machines: ask core, which may be running on state this start cannot see.
    writeFileSync(join(saved, 'machines.json'), '[]')
    await expect(coreMachines(config)).rejects.toThrow('Core did not start')
  } finally {
    if (state === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = state
    rmSync(root, { recursive: true, force: true })
  }
})

test('an absent record is absent; a malformed or foreign one is refused, never read as stopped', () => {
  const parent = mkdtempSync(join(tmpdir(), 'shep-launcher-record-'))
  const home = join(parent, 'home')
  // Content-level cases must reach the record's own validation, so on Windows they are written by the helper too:
  // a file written behind its back would be refused earlier, for its DACL, and prove less.
  const put = (text: string) => {
    if (process.platform === 'win32') writePrivateFile(join(home, 'run.json'), text)
    else writeFileSync(join(home, 'run.json'), text, { mode: 0o600 })
  }
  try {
    prepareHome(home)
    expect(runRecord(home)).toBeUndefined()
    const good = { pid: process.pid, boot: randomUUID(), home, port: 17888, root: '/unused' }
    writeRunRecord(home, good)
    expect(runRecord(home)).toEqual(good)

    const wrong = (value: unknown) => put(JSON.stringify(value))
    wrong({ ...good, boot: '../escape' })
    expect(() => runRecord(home)).toThrow('The core run record cannot be trusted: its boot id is malformed')
    wrong({ ...good, home: join(home, 'elsewhere') })
    expect(() => runRecord(home)).toThrow('it belongs to another home')
    wrong({ ...good, port: 80 })
    expect(() => runRecord(home)).toThrow('its port is malformed')
    wrong({ ...good, pid: 'not-a-pid' })
    expect(() => runRecord(home)).toThrow('it names no process')
    wrong({ ...good, operatorPid: 0 })
    expect(() => runRecord(home)).toThrow('its operator helper pid is malformed')
    put('not json')
    expect(() => runRecord(home)).toThrow('it is not valid JSON')
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('only the boot that wrote a record may remove it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'shep-launcher-boot-'))
  const home = join(parent, 'home')
  try {
    prepareHome(home)
    writeRunRecord(home, { pid: process.pid, boot: 'one', home, port: 17888, root: '/unused', operator: '\\\\.\\pipe\\shepherdr-operator-11111111-22222222', operatorPid: 424242 })
    expect(runRecord(home)?.operatorPid).toBe(424242)
    expect(removeRunRecord(home, 'two')).toBe(false)
    expect(runRecord(home)?.boot).toBe('one')
    expect(removeRunRecord(home, 'one')).toBe(true)
    expect(runRecord(home)).toBeUndefined()
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test.skipIf(process.platform === 'win32')('a live or half-written lock is never replaced, and a dead one is reclaimed once', async () => {
  // Windows creates the lock directory through the fixed helper, so its rules are asserted in core-windows-lifecycle.test.ts.
  const parent = mkdtempSync(join(tmpdir(), 'shep-launcher-lock-'))
  const home = join(parent, 'home')
  const lock = join(home, 'lifecycle.lock')
  try {
    prepareHome(home)

    // Mid-write: the directory exists but its owner file does not yet. Fresh means in progress, not dead.
    mkdirSync(lock, { mode: 0o700 })
    await expect(withLock(home, async () => 'never', 1)).rejects.toThrow('still in progress')
    expect(existsSync(join(lock, 'owner'))).toBe(false)

    // A live owner keeps its lock, however long this start waits.
    writeFileSync(join(lock, 'owner'), `${process.pid}:${randomUUID()}`, { mode: 0o600 })
    await expect(withLock(home, async () => 'never', 1)).rejects.toThrow('still in progress')
    expect(existsSync(join(lock, 'owner'))).toBe(true)

    // The same lock after its owner is provably gone and the write window passed is reclaimed, once.
    const past = new Date(Date.now() - 60_000)
    writeFileSync(join(lock, 'owner'), `2147483646:${randomUUID()}`, { mode: 0o600 })
    utimesSync(lock, past, past)
    expect(await withLock(home, async () => 'ran')).toBe('ran')
    expect(existsSync(lock)).toBe(false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test.skipIf(process.platform === 'win32')('two starts through the lock run one at a time and never remove each other\'s lock', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'shep-launcher-serial-'))
  const home = join(parent, 'home')
  try {
    prepareHome(home)
    const order: string[] = []
    await Promise.all([
      withLock(home, async () => { order.push('first'); await Bun.sleep(50) }),
      withLock(home, async () => { order.push('second') }),
    ])
    expect(order).toEqual(['first', 'second'])
    expect(existsSync(join(home, 'lifecycle.lock'))).toBe(false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('shutdown drains once, keeps the record on failure, and never reports a clean stop it did not reach', async () => {
  const calls: string[] = []
  const steps = (overrides: Partial<Parameters<typeof coreShutdown>[0]> = {}) => ({
    drain: async () => { calls.push('drain') },
    closeOperator: () => { calls.push('operator') },
    stopSource: () => { calls.push('source') },
    stopServer: () => { calls.push('server') },
    removeRecord: () => { calls.push('record'); return true },
    exit: (code: number) => { calls.push(`exit ${code}`) },
    log: (message: string) => { calls.push(`log ${message}`) },
    ...overrides,
  })

  // Success: every step once, in order, and the record goes before the exit.
  expect(await coreShutdown(steps())).toBe('stopped')
  expect(calls).toEqual(['drain', 'operator', 'source', 'server', 'record', 'exit 0'])

  // A blocked drain is not a stop: nothing is closed, the record stays, and no exit is reported while it runs.
  calls.length = 0
  let release: () => void = () => {}
  const blocked = coreShutdown(steps({ drain: () => { calls.push('drain'); return new Promise<void>(resolve => { release = resolve }) } }))
  await Bun.sleep(20)
  expect(calls).toEqual(['drain'])
  release()
  expect(await blocked).toBe('stopped')

  // A failed drain keeps the record and says why; a resource that throws does the same.
  calls.length = 0
  expect(await coreShutdown(steps({ drain: async () => { throw new Error('mailbox pending') } }))).toBe('failed')
  expect(calls).toEqual(['log Shepherdr could not finish its work: mailbox pending'])
  calls.length = 0
  expect(await coreShutdown(steps({ stopSource: () => { throw new Error('still holding') } }))).toBe('failed')
  expect(calls).toEqual(['drain', 'operator', 'log Shepherdr could not close its own resources: still holding'])
  expect(calls.some(call => call.startsWith('record'))).toBe(false)
  expect(calls.some(call => call.startsWith('exit'))).toBe(false)
})

test('every stop caller joins the same shutdown instead of draining twice', async () => {
  let drains = 0
  const stop = shutdownOnce(async () => { drains += 1; await Bun.sleep(20); return 'stopped' }, () => {}, () => {})
  await Promise.all([stop(), stop()])
  expect(drains).toBe(1)
})

test('a shutdown that rejects is reported and never becomes an unhandled rejection', async () => {
  const logs: string[] = []
  let failed = 0
  const stop = shutdownOnce(async () => { throw new Error('drain escaped') }, message => { logs.push(message) }, () => { failed += 1 })
  await expect(stop()).resolves.toBeUndefined()
  expect(logs).toEqual(['Shepherdr could not stop: drain escaped'])
  expect(failed).toBe(1)
})
