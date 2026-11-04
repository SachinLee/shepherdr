import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CoreClient } from './client.ts'
import { coreConfig, coreEnvironment, type CoreConfig } from './config.ts'
import { inspectHome, prepareHome } from './home.ts'
import { operatorStop } from './operator.ts'
import { createPrivateDirectory, deletePrivateFile, readPrivateFile, verifyDirectory, verifyPrivateFile, WindowsSecurityError, writePrivateFile } from './windows-security.ts'

export interface RunRecord { pid: number; boot: string; home: string; port: number; root: string; operator?: string; operatorPid?: number }
export interface Health { product: 'shepherdr-core'; boot: string; pid: number; core: boolean }

const WINDOWS = process.platform === 'win32'
const BOOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const OWNER = /^([1-9][0-9]{0,9}):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** A private state file's text, or undefined when it is absent. Unsafe or unreadable state is an error, never absence. */
function readState(path: string): string | undefined {
  if (WINDOWS) {
    try { return readPrivateFile(path) } catch (error) {
      if (error instanceof WindowsSecurityError && error.code === 'ENOENT') return undefined
      throw new Error(`${basename(path)} cannot be read privately: ${(error as Error).message}`)
    }
  }
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function writeState(path: string, data: string, options: { exclusive?: boolean } = {}): void {
  if (WINDOWS) { writePrivateFile(path, data, { exclusive: options.exclusive === true }); return }
  writeFileSync(path, data, { mode: 0o600, flag: options.exclusive ? 'wx' : 'w' })
}
function removeState(path: string): void {
  if (WINDOWS) { deletePrivateFile(path); return }
  rmSync(path)
}

function samePath(left: string, right: string) {
  const a = resolve(left), b = resolve(right)
  return WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b
}
function invalid(why: string): never {
  throw new Error(`The core run record cannot be trusted: ${why}. Nothing was signaled; inspect the private home before starting or stopping.`)
}
/** Basic types, this home and a plausible boot/port only: an identity claim still needs the health and operator checks. */
function checkedRecord(value: unknown, home: string): RunRecord {
  if (!value || typeof value !== 'object') invalid('it is not an object')
  const record = value as Record<string, unknown>
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 1) invalid('it names no process')
  if (typeof record.boot !== 'string' || !BOOT.test(record.boot)) invalid('its boot id is malformed')
  if (typeof record.home !== 'string' || !samePath(record.home, home)) invalid('it belongs to another home')
  if (typeof record.port !== 'number' || !Number.isSafeInteger(record.port) || record.port < 1024 || record.port > 65535) invalid('its port is malformed')
  if (typeof record.root !== 'string' || !record.root || record.root.length > 4096) invalid('its root is malformed')
  if (record.operator !== undefined && (typeof record.operator !== 'string' || !record.operator || record.operator.length > 512)) invalid('its operator endpoint is malformed')
  if (record.operatorPid !== undefined && (typeof record.operatorPid !== 'number' || !Number.isSafeInteger(record.operatorPid) || record.operatorPid < 1)) invalid('its operator helper pid is malformed')
  const operator = record.operator as string | undefined
  const operatorPid = record.operatorPid as number | undefined
  return { pid: record.pid, boot: record.boot, home: record.home, port: record.port, root: record.root,
    ...(operator === undefined ? {} : { operator }), ...(operatorPid === undefined ? {} : { operatorPid }) }
}

export function runRecord(home: string): RunRecord | undefined {
  const text = readState(join(home, 'run.json'))
  if (text === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { invalid('it is not valid JSON') }
  return checkedRecord(value, home)
}
/** Publish this process's record under its own name. On Windows the helper checks the parent chain and the DACL itself. */
export function writeRunRecord(home: string, record: RunRecord): void {
  const text = JSON.stringify(record)
  if (WINDOWS) { writePrivateFile(join(home, 'run.json'), text); return }
  const temporary = join(home, `run.${record.boot}.tmp`)
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, join(home, 'run.json'))
}
/** Remove run.json only while it still names this boot; another start's record is never touched. */
export function removeRunRecord(home: string, boot: string): boolean {
  let current: RunRecord | undefined
  try { current = runRecord(home) } catch { return false }
  if (!current || current.boot !== boot) return false
  try { removeState(join(home, 'run.json')); return true } catch { return false }
}
async function health(record: RunRecord): Promise<Health | undefined> {
  if (!Number.isInteger(record.port) || record.port < 1024 || record.port > 65535) return
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/health`, { signal: AbortSignal.timeout(700) })
    const body = await response.json() as Health
    if (response.ok && body.product === 'shepherdr-core' && body.boot === record.boot && body.pid === record.pid) return body
  } catch { /* stopped, starting, or a different port owner */ }
}
/**
 * True only when the pid is provably gone. A refused signal (EPERM) or an unknown failure says nothing about the
 * process, so it is never taken as death: a paused or foreign process must keep its lock and its status.
 */
function dead(pid: number) {
  try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
function alive(pid: number) { return !dead(pid) }
/** Liveness only, never identity: the operator handshake proves which helper answers. POSIX stops with SIGTERM. */
function controlAlive(record: RunRecord) {
  return record.operator !== undefined && typeof record.operatorPid === 'number' && alive(record.operatorPid)
}

/** Discover existing private mappings only. Startup never changes Tailscale configuration. */
export function privateUrls(port: number): string[] {
  try {
    const status = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 2000 })
    const serve = spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
    if (status.status !== 0 || serve.status !== 0) return []
    const dns = (JSON.parse(status.stdout).Self.DNSName as string).replace(/\.$/, '')
    const config = JSON.parse(serve.stdout) as { Web?: Record<string, { Handlers: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> }
    const urls: string[] = []
    for (const [host, web] of Object.entries(config.Web ?? {})) {
      if (host.split(':')[0] !== dns || config.AllowFunnel?.[host]) continue
      for (const [path, handler] of Object.entries(web.Handlers)) {
        if (handler.Proxy === `http://127.0.0.1:${port}`) urls.push(`https://${host.replace(/:443$/, '')}${path.endsWith('/') ? path : path + '/'}`)
      }
    }
    return urls
  } catch { return [] }
}

export async function launcherStatus(config: CoreConfig, observed?: { record: RunRecord; current: Health }) {
  const kind = inspectHome(config.home)
  if (kind === 'legacy') return 'Legacy 2.0 state is present. The core application has not started here; use an isolated preview home until cutover.'
  let record: RunRecord | undefined
  try { record = observed?.record ?? runRecord(config.home) } catch (error) { return `Shepherdr’s private state cannot be trusted: ${(error as Error).message}` }
  const current = observed?.current ?? (record && await health(record))
  if (!current || !record) return record && alive(record.pid) ? `Shepherdr’s recorded process is alive (PID ${record.pid}), but its status is not confirmed yet. It has not been signaled; check status again shortly.` : 'Shepherdr is stopped.'
  const urls = privateUrls(record.port)
  // Status only observes: a helper that is gone is reported, never restarted, and the app pid is never signaled here.
  const control = WINDOWS && !controlAlive(record) ? '\nIts private operator helper is not running, so a stop request will be refused; nothing will be signaled by guesswork.' : ''
  return `Shepherdr is running (PID ${record.pid}). Core ${current.core ? 'connected' : 'reconnecting'}.${control}\n${urls.length ? urls.map(url => `Private URL: ${url}`).join('\n') : 'No private Tailscale Serve mapping points to this port. Configure one before opening from another device.'}`
}

function readOwnerText(owner: string): string | undefined {
  if (WINDOWS) {
    try { return readPrivateFile(owner) } catch (error) {
      if (error instanceof WindowsSecurityError && error.code === 'ENOENT') return undefined
      throw new Error(`The lifecycle lock cannot be trusted: ${(error as Error).message}. Nothing was started or stopped.`)
    }
  }
  try { return readFileSync(owner, 'utf8') } catch { return undefined }
}
/** A pid only means "check liveness": the lock's own token is what decides who may remove it. */
function lockOwner(owner: string): number | undefined {
  const text = readOwnerText(owner)
  if (text === undefined) return undefined
  const match = OWNER.exec(text.trim())
  if (match) return Number(match[1])
  // POSIX keeps the old forgiving read; Windows refuses rather than reusing a file that cannot be verified.
  if (WINDOWS) throw new Error('The lifecycle lock cannot be trusted: its owner file is malformed. Nothing was started or stopped.')
  return undefined
}
function lockCreate(lock: string, owner: string, token: string) {
  if (WINDOWS) {
    // A directory mode is not an ACL on Windows: the fixed helper creates it with a protected DACL, then the owner file.
    createPrivateDirectory(lock)
    try { writePrivateFile(owner, token, { exclusive: true }) } catch (error) {
      // This call created the directory, so removing it is recovery, not guesswork: an ownerless lock would otherwise
      // block every later start until someone inspected it by hand.
      try { lockRemove(lock) } catch { /* keep the write error, which explains the failure */ }
      throw error
    }
    return
  }
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(owner, token, { mode: 0o600 })
}
function lockRemove(lock: string) {
  // Verify before removing on Windows so a loose directory is refused instead of deleted.
  if (WINDOWS) verifyDirectory(lock)
  rmSync(lock, { recursive: true })
}

/** Exported for the lifecycle tests: the loop, its staleness rule and its token-checked release are the unit under test. */
export async function withLock<T>(home: string, work: () => Promise<T>, attempts = 100) {
  const lock = join(home, 'lifecycle.lock')
  const owner = join(lock, 'owner')
  const token = `${process.pid}:${randomUUID()}`
  for (let attempt = 0; ; attempt++) {
    try { lockCreate(lock, owner, token); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = lockOwner(owner)
      // Reclaim only an owner that is provably gone. Windows never guesses from age: a paused start inside its
      // owner-write window looks old without having written a token, so a missing owner file is waited on and then
      // reported, never deleted. POSIX keeps its older rule: past the write window an absent owner is a crash.
      const reclaim = WINDOWS
        ? holder !== undefined && dead(holder)
        : Date.now() - statSync(lock).mtimeMs > 30_000 && (holder === undefined || dead(holder))
      if (reclaim) { lockRemove(lock); continue }
      if (attempt >= attempts) {
        if (WINDOWS && holder === undefined) throw new Error('The lifecycle lock has no readable owner; it was not removed. Nothing was started or stopped.')
        throw new Error('Another start or stop is still in progress; check status')
      }
      await Bun.sleep(100)
    }
  }
  try { return await work() }
  finally {
    try { if (readOwnerText(owner)?.trim() === token) lockRemove(lock) } catch { /* already removed */ }
  }
}

async function ensureCore(config: CoreConfig) {
  const result = spawnSync(config.binary, ['server', 'start'], { env: coreEnvironment(config), encoding: 'utf8', timeout: 15_000 })
  if (result.status !== 0) throw new Error(`Core did not start: ${result.error?.message || result.stderr.trim() || 'install herdr-core (hc) first'}`)
  const core = await CoreClient.open(config.socket)
  core.close()
}

/** Without the built page every visit is an error, while start would still say it runs. A Vite preview serves its own. */
export function buildProblem(config: Pick<CoreConfig, 'plugins'>, root = join(import.meta.dir, '../..')) {
  if (config.plugins === false || existsSync(join(root, 'dist/index.html'))) return
  return `Shepherdr is not built, so its page cannot open. Nothing was started. Run bun run build in ${root}, then start again.`
}

/** The core this home runs on, saved as it is made or when a start names one. Homes from before this file have none. */
function savedCore(home: string) {
  const text = readState(join(home, 'core.json'))
  if (text === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch {
    // On Windows a damaged file is not the same as a home that never chose a core: starting on a guess would pick a
    // different socket than the one this home was using.
    if (WINDOWS) throw new Error('The saved core cannot be trusted: it is not valid JSON. Nothing was started.')
    return undefined
  }
  const saved = value as { session?: unknown; socket?: unknown } | null
  if (!saved || typeof saved !== 'object' || typeof saved.session !== 'string' || !saved.session || typeof saved.socket !== 'string' || !saved.socket) {
    if (WINDOWS) throw new Error('The saved core cannot be trusted: it does not name a session and socket. Nothing was started.')
    return undefined
  }
  return { session: saved.session, socket: saved.socket }
}
export function saveCore(config: CoreConfig) {
  // A saved core redirects this home's socket: on Windows it is written and read through the private helper, not a
  // file whose ACL a mode number pretends to set.
  writeState(join(config.home, 'core.json'), JSON.stringify({ session: config.session, socket: config.socket }))
}
/** Saved with the marker, not after a start that may fail: a retry must not read this as a home from before the file. */
export function claimHome(config: CoreConfig) {
  const fresh = typeof inspectHome(config.home) !== 'object'
  prepareHome(config.home)
  if (fresh) saveCore(config)
}

/** A core's saved machines belong to whoever added them. A home takes them on only when a start names that core:
 * HC_SESSION alone is inherited from any hc terminal, and XDG homes alone can still reach the same running core. */
export async function coreProblem(config: CoreConfig, machines: () => Promise<{ name: string }[]>) {
  if (config.chosenCore) return
  const kind = inspectHome(config.home)
  if (kind !== 'absent' && kind !== 'empty') {
    const saved = savedCore(config.home)
    if (saved && (saved.session !== config.session || saved.socket !== config.socket)) return `This home runs on core session ${saved.session} at ${saved.socket}, not ${config.session} at ${config.socket}. Nothing was started. Start it with --core-session ${saved.session} --core-socket ${saved.socket}.`
    return
  }
  const found = await machines()
  if (found.length) return `Core session ${config.session} already has ${found.length === 1 ? 'a machine' : `${found.length} machines`} (${found.map(machine => machine.name).join(', ')}), and a new Shepherdr would run commands on ${found.length === 1 ? 'it' : 'them'}. Nothing was started. For a trial, give it its own core: --core-session NAME. To use ${found.length === 1 ? 'this machine' : 'these machines'} here, say so: --core-session ${config.session}.`
}

/** A core that starts reconnects its saved machines, and every hc command starts it: its own file answers without that. */
function savedMachines(config: CoreConfig) {
  const state = process.env.XDG_STATE_HOME || join(homedir(), '.local/state')
  try { return JSON.parse(readFileSync(join(state, 'herdr-core', config.session, 'machines.json'), 'utf8')) as { name: string }[] } catch { return [] }
}

export async function coreMachines(config: CoreConfig) {
  const problem = buildProblem(config)
  if (problem) throw new Error(problem)
  const saved = savedMachines(config)
  if (saved.length) return saved
  await ensureCore(config)
  const core = await CoreClient.open(config.socket)
  try { return (await core.call<{ machines: { name: string }[] }>('machine.list')).machines } finally { core.close() }
}

/** A private append log: created by the helper under a protected DACL, or verified before an existing one is appended to. */
function openLog(home: string): number {
  const log = join(home, 'server.log')
  if (WINDOWS) {
    try { verifyPrivateFile(log) } catch (error) {
      if (!(error instanceof WindowsSecurityError) || error.code !== 'ENOENT') throw new Error(`The core log cannot be trusted: ${(error as Error).message}`)
      writePrivateFile(log, '')
    }
  }
  return openSync(log, 'a', 0o600)
}

async function start(config: CoreConfig, foreground: boolean) {
  // Before prepareHome: a refused start leaves no marker for the next start to pass on.
  const refused = await coreProblem(config, () => coreMachines(config))
  if (refused) throw new Error(refused)
  claimHome(config)
  await withLock(config.home, async () => {
    const record = runRecord(config.home)
    const confirmed = record && await health(record)
    if (record && confirmed) {
      // A core whose private operator helper died is still running, but it can no longer be stopped through its own
      // channel: start refuses instead of reporting a healthy instance it cannot control.
      if (WINDOWS && !controlAlive(record)) throw new Error('The recorded process is running but its private operator helper is gone. It has not been signaled; stop it before starting another one.')
      console.log(await launcherStatus(config, { record, current: confirmed })); return
    }
    if (record && alive(record.pid)) throw new Error('The recorded process is alive but its identity cannot be verified. No process was stopped; inspect it before restarting.')
    const problem = buildProblem(config)
    if (problem) throw new Error(problem)
    await ensureCore(config)
    if (config.chosenCore) saveCore(config)
    const boot = randomUUID()
    const args = ['--home', config.home, '--port', String(config.port), '--core-bin', config.binary, '--core-session', config.session, '--core-socket', config.socket]
    if (config.plugins === false) args.push('--no-plugin-updates')
    if (foreground) {
      // Server starts before releasing the lifecycle lock; no second start can race its bind.
      const { runCoreServer } = await import('./main.ts')
      await runCoreServer(config, boot)
      return
    }
    const log = openLog(config.home)
    let child
    try {
      child = spawn(process.execPath, [join(import.meta.dir, 'main.ts'), ...args], {
        detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...coreEnvironment(config), ...(process.env.ELEVENLABS_API_KEY ? { ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY } : {}), SHEPHERDR_BOOT_ID: boot },
      })
    } finally {
      // A spawn that throws synchronously must not leave this descriptor open; the child holds its own copy.
      closeSync(log)
    }
    let failed: Error | undefined
    child.on('error', error => { failed = error })
    child.unref()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || child.exitCode !== null) throw new Error(`Shepherdr did not start; see the private server log. ${failed?.message ?? ''}`)
      // The record may not exist yet while the child publishes it. Any other refusal (ACL, corruption) is reported
      // now instead of being retried until the deadline and then called a timeout.
      let current: RunRecord | undefined
      try { current = runRecord(config.home) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const confirmed = current && current.boot === boot ? await health(current) : undefined
      if (current && confirmed) { console.log(await launcherStatus(config, { record: current, current: confirmed })); return }
      await Bun.sleep(100)
    }
    throw new Error('Shepherdr has not answered yet. Check status and its private server log before starting again.')
  })
}

/** Ask the running core through its authenticated private channel; the receipt is an acceptance, not an exit. */
async function stopThroughOperator(config: CoreConfig, record: RunRecord) {
  if (!record.operator || typeof record.operatorPid !== 'number') throw new Error('The run record does not name the private operator helper, so this core cannot be asked to stop. Nothing was signaled.')
  const result = await operatorStop(config.home, record.operator, { boot: record.boot, appPid: process.pid, helperPid: record.operatorPid })
  if (result.code !== 0) throw new Error(result.out.trim() || 'The core refused to stop; it was not signaled.')
  // The core accepted the request; the finish line is this boot's record gone and the original process exited.
  for (let attempt = 0; attempt < 300; attempt++) {
    let current: RunRecord | undefined
    try { current = runRecord(config.home) } catch (error) {
      // A record that exists but cannot be trusted is not progress: report it rather than polling to the deadline.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      current = record
    }
    if ((!current || current.boot !== record.boot) && !alive(record.pid)) { console.log('Shepherdr stopped. Core and agents keep running.'); return }
    await Bun.sleep(100)
  }
  throw new Error('Shepherdr is finishing work before stopping. No agent was stopped; check status shortly.')
}

async function stop(config: CoreConfig) {
  const kind = inspectHome(config.home)
  if (typeof kind !== 'object') { console.log(await launcherStatus(config)); return }
  await withLock(config.home, async () => {
    // Read again under the lock: another start may have published a new boot while this stop was waiting.
    const record = runRecord(config.home)
    if (!record || !await health(record)) {
      if (record && alive(record.pid)) throw new Error('The recorded process cannot be verified; it has not been signaled')
      console.log('Shepherdr is stopped.'); return
    }
    // Windows never turns SIGTERM into a graceful stop: only the core's own idempotent drain may end it.
    if (WINDOWS) return stopThroughOperator(config, record)
    process.kill(record.pid, 'SIGTERM')
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!alive(record.pid)) { console.log('Shepherdr stopped. Core and agents keep running.'); return }
      await Bun.sleep(100)
    }
    throw new Error('Shepherdr is finishing work before stopping. No agent was stopped; check status shortly.')
  })
}

if (import.meta.main) {
  try {
    const [verb, ...args] = process.argv.slice(2)
    const config = coreConfig(args)
    if (verb === 'start') await start(config, args.includes('--foreground'))
    else if (verb === 'stop') await stop(config)
    else if (verb === 'status') console.log(await launcherStatus(config))
    else throw new Error('Use shepherdr start, stop, or status')
  } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
}
