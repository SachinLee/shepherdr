#!/usr/bin/env bun
// Capture the reviewer's native JSON stdout, never its terminal screen. Core owns this holder.
import { constants, openSync, fstatSync, writeSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { readCredential } from '../server/core/home.ts'

const WINDOWS = process.platform === 'win32'
const config = readCredential<{ argv: string[]; log: string }>(process.argv[2])
if (!Array.isArray(config.argv) || !config.argv.length || config.argv.some(word => typeof word !== 'string')) throw new Error('Invalid reviewer launch')
if (WINDOWS) {
  // The launcher creates this log under a protected DACL. Verify the file and the parent chain that could be
  // swapped by another account before appending; the account boundary is the guard, not POSIX mode bits.
  const { verifyDirectory, verifyPrivateFile } = await import('../server/core/windows-security.ts')
  verifyDirectory(dirname(config.log))
  verifyPrivateFile(config.log)
}
const fd = openSync(config.log, constants.O_WRONLY | constants.O_APPEND | (WINDOWS ? 0 : constants.O_NOFOLLOW))
const stat = fstatSync(fd)
// The handle itself must still name one regular file: a second name would let somebody else read the reviewer events.
if (!stat.isFile() || (WINDOWS ? stat.nlink !== 1 : stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())) throw new Error('Reviewer log must be private')
let size = stat.size
const append = (event: unknown) => {
  const line = JSON.stringify({ at: Date.now(), event }) + '\n'
  size += Buffer.byteLength(line)
  if (size > 64 * 1024 * 1024) throw new Error('Reviewer event log exceeded 64 MiB')
  writeSync(fd, line)
}
const child = Bun.spawn(config.argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
let failed = false, completed = false
const deadline = setTimeout(() => { failed = true; child.kill(); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }, 540_000)
try {
  const decoder = new TextDecoder()
  let pending = ''
  const reader = child.stdout.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    if (Buffer.byteLength(pending) > 2 * 1024 * 1024) throw new Error('Reviewer event exceeded 2 MiB')
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.type === 'turn.completed') completed = true
      if (event.type === 'turn.failed') failed = true
      append(event)
      process.stdout.write(line + '\n')
    }
  }
  pending += decoder.decode()
  if (pending.trim()) {
    const event = JSON.parse(pending)
    if (event.type === 'turn.completed') completed = true
    if (event.type === 'turn.failed') failed = true
    append(event)
  }
} catch {
  failed = true; child.kill()
  try { append({ type: 'turn.failed', error: { message: 'The reviewer event stream was interrupted; its result is incomplete.' } }) } catch {}
} finally {
  const code = await child.exited
  clearTimeout(deadline)
  if (code !== 0 || failed || !completed) {
    failed = true
    // A full log may have caused the interruption; core's nonzero holder exit still prevents a relay.
    try { append({ type: 'turn.failed', error: { message: 'The reviewer exited before completing successfully.' } }) } catch {}
  }
  closeSync(fd)
  process.exitCode = failed ? 1 : code
}
