#!/usr/bin/env bun
import { resolve } from 'node:path'
import { defaultHome, inspectHome } from '../server/core/home.ts'
import { runRecord } from '../server/core/launcher.ts'
import { operatorRequest } from '../server/core/operator.ts'
import type { OperatorIdentity } from '../server/core/windows-operator.ts'

/**
 * The Windows run record must name the helper that holds the pipe; a Windows request without that identity is refused
 * rather than treated as a POSIX socket caller. T2c2 publishes the field.
 */
function windowsIdentity(record: { boot: string }): OperatorIdentity {
  const helperPid = (record as { operatorPid?: unknown }).operatorPid
  if (typeof helperPid !== 'number' || !Number.isSafeInteger(helperPid) || helperPid <= 0) {
    throw new Error('The core run record has no operator helper identity yet; restart Shepherdr with this build.')
  }
  return { boot: record.boot, appPid: process.pid, helperPid }
}

try {
  if (process.env.SHEPHERDR_CORE_CREDENTIAL || process.env.SHEPHERDR_BACKEND === 'core') throw new Error('Agents must use their authenticated core mailbox')
  const args = process.argv.slice(2)
  let home = defaultHome()
  const index = args.indexOf('--home')
  if (index >= 0) { if (!args[index + 1]) throw new Error('Give --home PATH'); home = resolve(args[index + 1]!); args.splice(index, 2) }
  if (typeof inspectHome(home) !== 'object') throw new Error('No core installation here. Use the correct --home; legacy state was left untouched.')
  const record = runRecord(home)
  if (!record?.operator) throw new Error('The core server is not running with a private operator socket. Check shepherdr status.')
  let stdin: string | undefined
  if (args[0] === 'secret' && args[1] === 'set') {
    if (process.stdin.isTTY) throw new Error('Give the value on stdin: secret set NAME < file')
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of process.stdin) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 64 * 1024) throw new Error('Keep a secret under 64 KiB'); chunks.push(bytes) }
    stdin = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }
  const result = await operatorRequest(home, record.operator, args, stdin, process.platform === 'win32' ? windowsIdentity(record) : undefined)
  process.stdout.write(result.out); process.exitCode = result.code
} catch (error) { console.error((error as Error).message); process.exitCode = 1 }
