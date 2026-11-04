#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

/**
 * The one routing table behind `bin/shepherdr` (POSIX sh) and `bin/shepherdr.cmd` (Windows).
 * It mirrors the standalone entry's existing verbs exactly, keeps every argv word untouched,
 * and hands stdin/stdout/stderr to the chosen helper so `secret set NAME < file` keeps working.
 */

export type EntryRoute =
  | { kind: 'launcher'; args: string[] }
  | { kind: 'cli'; args: string[] }
  | { kind: 'operator'; args: string[] }
  | { kind: 'help' }
  | { kind: 'error' }

/** `status` alone, or with lifecycle flags, is the application; `status TASK ...` stays an agent report. */
function lifecycleStatus(second: string | undefined) {
  // `status ""` is the shell's empty word and still the application, exactly like an absent second word.
  return second === undefined || second === '' || second === '--home' || second.startsWith('--home=') || second === '--port' || second.startsWith('--port=') || second.startsWith('--core-')
}

export function entryRoute(args: string[], env: NodeJS.ProcessEnv = process.env): EntryRoute {
  const first = args[0]
  const second = args[1]
  // Lifecycle verbs belong to the standalone application, even inside an agent session.
  if (first === 'start' || first === 'stop') return { kind: 'launcher', args }
  if (first === 'status' && lifecycleStatus(second)) return { kind: 'launcher', args }
  // The owning launch credential wins: `shepherdr agent ...` is only an explicit spelling of the same mailbox.
  if (env.SHEPHERDR_CORE_CREDENTIAL || env.SHEPHERDR_BACKEND === 'core') return { kind: 'cli', args: first === 'agent' ? args.slice(1) : args }
  // Human secret verbs use the private operator channel only when no agent credential applies.
  if (first === 'secret' && (second === 'set' || second === 'rm' || second === 'remove')) return { kind: 'operator', args }
  if (first === undefined || first === '' || first === 'help' || first === '--help') return { kind: 'help' }
  return { kind: 'error' }
}

export const HELP = [
  'shepherdr start | stop | status [--home PATH]',
  'shepherdr secret set NAME [--machine | --space NAME] < file',
  'shepherdr secret rm NAME [--machine | --space NAME]',
  'Agent commands use the owning launch-provisioned helper and core mailbox.',
].join('\n')

export const NO_LEGACY_ROUTE = 'This standalone command has no legacy HTTP routing. Use the owning authenticated agent helper, or open the app. Use hc for core terminals and agents.'

/** Runs one target with the exact argv array and this process's own stdin/stdout/stderr. */
export type EntryRunner = (command: string[], stdio: 'inherit') => number

export interface EntryOptions {
  env?: NodeJS.ProcessEnv
  root?: string
  execPath?: string
  run?: EntryRunner
  out?: (text: string) => void
  err?: (text: string) => void
}

function spawnInherit(command: string[]): number {
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

export function runEntry(args: string[], options: EntryOptions = {}): number {
  const route = entryRoute(args, options.env ?? process.env)
  const out = options.out ?? ((text: string) => { process.stdout.write(text) })
  const err = options.err ?? ((text: string) => { process.stderr.write(text) })
  if (route.kind === 'help') { out(`${HELP}\n`); return 0 }
  if (route.kind === 'error') { err(`${NO_LEGACY_ROUTE}\n`); return 1 }
  const root = options.root ?? resolve(import.meta.dir, '..')
  const execPath = options.execPath ?? process.execPath
  const target = route.kind === 'launcher' ? 'server/core/launcher.ts' : route.kind === 'cli' ? 'helper/core-cli.ts' : 'helper/core-operator.ts'
  const command = [execPath, join(root, target), ...route.args]
  try {
    return (options.run ?? spawnInherit)(command, 'inherit')
  } catch (error) {
    err(`${(error as Error).message}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = runEntry(process.argv.slice(2))
