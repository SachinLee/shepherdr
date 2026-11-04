import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CoreSource } from './source.ts'
import { CorePluginUpdates } from './plugin-updates.ts'
import { coreConfig, type CoreConfig } from './config.ts'
import { removeRunRecord, writeRunRecord, type RunRecord } from './launcher.ts'
import { startOperator, type StartedOperator } from './operator.ts'

/** Every side effect of a shutdown, named so the sequence and its failure rules can be exercised without a core. */
export interface ShutdownSteps {
  drain(): Promise<void>
  closeOperator(): void
  stopSource(): void
  stopServer(): void
  removeRecord(): boolean
  exit(code: number): void
  log(message: string): void
}
export type ShutdownOutcome = 'stopped' | 'failed'

/**
 * The one shutdown sequence, shared by signals and the authenticated operator stop. A failed drain or a resource that
 * throws keeps the record: this process did not cleanly stop, and status must not be told otherwise.
 */
export async function coreShutdown(steps: ShutdownSteps): Promise<ShutdownOutcome> {
  try { await steps.drain() } catch (error) {
    steps.log(`Shepherdr could not finish its work: ${(error as Error).message}`)
    return 'failed'
  }
  for (const step of [steps.closeOperator, steps.stopSource, steps.stopServer]) {
    try { step() } catch (error) {
      steps.log(`Shepherdr could not close its own resources: ${(error as Error).message}`)
      return 'failed'
    }
  }
  try {
    // Only this boot's record is removed; the core and every agent are independent of this process.
    if (!steps.removeRecord()) steps.log('The core could not remove its own run record; the next start will replace it.')
  } catch (error) {
    steps.log(`The core could not remove its own run record: ${(error as Error).message}`)
  }
  steps.exit(0)
  return 'stopped'
}

/** Join every stop caller (signal, operator acknowledgement) to one running shutdown instead of draining twice. */
export function shutdownOnce(
  run: () => Promise<ShutdownOutcome>,
  log: (message: string) => void = message => console.error(message),
  failed: () => void = () => { process.exitCode = 1 },
) {
  let pending: Promise<void> | undefined
  return (): Promise<void> => {
    pending ??= (async () => {
      if (await run() === 'failed') failed()
    })().catch(error => {
      log(`Shepherdr could not stop: ${(error as Error).message}`)
      failed()
    })
    return pending
  }
}

export async function runCoreServer(config: CoreConfig, boot: string = randomUUID()) {
  // Reused presentation and push code resolves its private state only after these values are set.
  process.env.SHEPHERDR_HOME = config.home
  process.env.SHEPHERDR_PORT = String(config.port)
  const source = new CoreSource(config)
  const cleanup: (() => void)[] = [() => source.stop()]
  try {
  await source.start()
  const { default: base, catalog, user } = await import('../../generated/server-plugins.ts')
  await source.plugins.start(catalog, [...base.map(plugin => [plugin.name, async () => plugin] as [string, () => Promise<typeof plugin>]), ...user.map(([name, load]) => [name, async () => (await load()).default] as [string, () => Promise<import('../plugin-api.ts').ServerPlugin>])])
  const { startApp } = await import('../app.ts')
  const { Push, deviceName } = await import('../push.ts')
  if (config.plugins !== false) source.pluginUpdates = new CorePluginUpdates(source, join(import.meta.dir, '../..'))
  const push = new Push()
  source.devices = () => push.devices.map(deviceName)
  source.pushWarnings = () => push.warnings(deviceName)
  const server = startApp({ source, port: config.port, host: '127.0.0.1', dist: join(import.meta.dir, '../../dist'), push,
    assets: source.pluginUpdates?.assets,
    health: () => ({ product: 'shepherdr-core', boot, pid: process.pid, core: source.connected() }) })
  cleanup.push(() => server.stop(true))
  let operator: StartedOperator | undefined
  /**
   * The one idempotent shutdown, shared by signals and the authenticated operator stop. A second request waits for the
   * same promise: the drain runs once, the record of this boot is removed once, and nothing is signaled by pid.
   */
  const stop = shutdownOnce(() => coreShutdown({
    // drain() reports whether it ever had to wait, not whether it succeeded: waiting is drained by awaiting it.
    drain: async () => { await source.drain() },
    closeOperator: () => operator?.close(),
    stopSource: () => source.stop(),
    stopServer: () => server.stop(true),
    removeRecord: () => removeRunRecord(config.home, boot),
    exit: code => process.exit(code),
    log: message => console.error(message),
  }))
  // The callback only resolves the shared promise: the operator loop must not await a drain that closes its own source.
  operator = await startOperator(source, boot, { onStop: () => { void stop() } })
  cleanup.push(() => operator?.close())
  const record: RunRecord = { pid: process.pid, boot, home: config.home, port: server.port!, root: join(import.meta.dir, '../..'), operator: operator.path,
    ...(operator.pid === undefined ? {} : { operatorPid: operator.pid }) }
  // Published only after READY: the record names the helper that is already serving this pipe, never a guess.
  writeRunRecord(config.home, record)
  source.pluginUpdates?.start()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void stop() })
  return { server, source }
  } catch (error) {
    for (const close of cleanup.reverse()) { try { close() } catch { /* preserve the startup error */ } }
    source.mailbox.close(); source.store.close()
    throw error
  }
}

if (import.meta.main) {
  try { await runCoreServer(coreConfig(process.argv.slice(2)), process.env.SHEPHERDR_BOOT_ID || randomUUID()) }
  catch (error) { console.error((error as Error).message); process.exitCode = 1 }
}
