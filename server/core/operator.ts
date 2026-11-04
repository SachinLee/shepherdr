import { createServer, createConnection } from 'node:net'
import { chmodSync, lstatSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { CoreSource } from './source.ts'
import { startWindowsOperator, windowsOperatorRequest, windowsOperatorStop, type OperatorIdentity } from './windows-operator.ts'

const LIMIT = 512 * 1024
export interface OperatorResult { out: string; code: number }
/** A started private operator: its endpoint, and on Windows the helper that owns the pipe — never this application's pid. */
export interface StartedOperator {
  path: string
  pid?: number
  close(): void
}
/** Narrow lifecycle hook for the Windows transport; the POSIX socket has no stop command. */
export interface OperatorOptions {
  /** Called only after a validated stop request's reply has been flushed to the client. */
  onStop?: () => void | Promise<void>
}
/** OS-owned socket in the private installation home. No web route or caller-selected agent identity. */
export async function startOperator(source: CoreSource, boot: string, options: OperatorOptions = {}): Promise<StartedOperator> {
  // Windows cannot hand Bun a named pipe with a chosen DACL, so the fixed helper creates, verifies and holds it. The
  // returned pid is that helper's, never this application's; the socket path and its 0600 mode remain POSIX-only.
  if (process.platform === 'win32') {
    const operator = await startWindowsOperator(source, boot, options)
    return { path: operator.path, pid: operator.pid, close: () => operator.close() }
  }
  const path = join(source.config.home, `operator.${boot.slice(0, 8)}.sock`)
  if (Buffer.byteLength(path) > 100) throw new Error('Home path is too long for its private operator socket')
  const server = createServer({ allowHalfOpen: true }, socket => {
    const deadline = setTimeout(() => socket.destroy(), 5000)
    socket.on('close', () => clearTimeout(deadline))
    let size = 0
    const chunks: Buffer[] = []
    socket.on('error', () => {})
    socket.on('data', data => { const chunk = Buffer.from(data); size += chunk.length; if (size > LIMIT) socket.destroy(); else chunks.push(chunk) })
    socket.on('end', async () => {
      if (socket.destroyed || source.quiescing) { socket.destroy(); return }
      let result: OperatorResult
      try {
        let input: { args?: unknown; stdin?: unknown }
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Invalid private operator request') }
        if (!input || typeof input !== 'object') throw new Error('Invalid private operator request')
        if (!Array.isArray(input.args) || input.args.length > 16 || input.args.some(word => typeof word !== 'string' || word.length > 256) ||
          input.stdin !== undefined && (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin) > 64 * 1024)) throw new Error('Invalid private operator request')
        result = { out: await source.secrets.operator(input.args, input.stdin as string | undefined), code: 0 }
      } catch (error) { result = { out: (error as Error).message + '\n', code: 1 } }
      socket.end(JSON.stringify(result))
    })
  })
  server.maxConnections = 16
  // The client half-closes after its bounded request; keep the response half open.
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    chmodSync(path, 0o600)
  } catch (error) { server.close(); throw error }
  return { path, close: () => server.close() }
}

export async function operatorRequest(home: string, path: string, args: string[], stdin?: string, expected?: OperatorIdentity): Promise<OperatorResult> {
  // Windows proves the endpoint and the peer on the connected handle; the caller must name this core instance from its
  // run record. A missing identity is refused rather than treated as a Unix caller.
  if (process.platform === 'win32') {
    if (!expected) throw new Error('A Windows private operator request needs the boot and helper identity from the run record')
    return windowsOperatorRequest(home, path, args, stdin, expected)
  }
  const directory = lstatSync(home)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || directory.uid !== process.getuid?.()) throw new Error('Operator home must be a private directory owned by you')
  if (!/^operator\.[a-f0-9]{8}\.sock$/.test(basename(path)) || join(home, basename(path)) !== path) throw new Error('Invalid private operator socket')
  const stat = lstatSync(path)
  if (!stat.isSocket() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('Operator socket must be private and owned by you')
  const body = JSON.stringify({ args, stdin })
  if (Buffer.byteLength(body) > LIMIT) throw new Error('Operator request is too large')
  return new Promise((resolve, reject) => {
    const socket = createConnection(path), chunks: Buffer[] = []; let size = 0
    socket.setTimeout(10_000, () => socket.destroy(new Error('The operator command timed out; inspect the named setting before retrying')))
    socket.on('error', reject)
    socket.on('connect', () => socket.end(body))
    socket.on('data', data => { const chunk = Buffer.from(data); size += chunk.length; if (size > LIMIT) socket.destroy(new Error('Operator reply is too large')); else chunks.push(chunk) })
    socket.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('No valid operator reply; inspect the named setting before retrying')) } })
  })
}

/**
 * Ask a running core to drain and stop through its authenticated private channel. Windows only: the POSIX socket has
 * no stop command, and the reply means "accepted", not "exited" — the caller still waits for the record and process.
 */
export async function operatorStop(home: string, path: string, expected: OperatorIdentity): Promise<OperatorResult> {
  if (process.platform !== 'win32') throw new Error('This platform does not accept a stop request through its private operator')
  return windowsOperatorStop(home, path, expected)
}
