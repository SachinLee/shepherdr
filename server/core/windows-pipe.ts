// Windows core pipe client. Bun's node:net has no real Windows named-pipe handle, so a preflight check followed by a
// Bun reconnect could not prove that the verified pipe and the relayed bytes are the same connection. A fixed system
// Windows PowerShell 5.1 helper opens the pipe once, checks the owner, protected DACL and server token on that
// connected handle, and then relays raw bytes on the same stream. This module starts that helper, waits for its
// versioned READY line, and exposes the connection as a Duplex. It never reconnects; a failure before READY kills the
// helper and surfaces a bounded diagnostic.
import { Duplex } from 'node:stream'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowsCorePipe } from './config.ts'

/** Exact first line the helper writes after it has verified the connected pipe. */
export const PIPE_READY = 'SHEPHERDR-CORE-PIPE/1'
const HELPER = fileURLToPath(new URL('../../helper/core-windows.ps1', import.meta.url))
const MAX_PREFACE = 4096
const MAX_DIAGNOSTIC = 4096
const STARTUP_MS = 30_000
const CONNECT_MS = 10_000
/** How long an EOF before READY waits for the helper's exit code, which says whether it refused or just vanished. */
const EXIT_MS = 1_000

export class WindowsPipeError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'REFUSED' | 'TOOLARGE', message: string) {
    super(message)
    this.name = 'WindowsPipeError'
  }
}

export interface PipeRequest {
  pipe: string
  parentPid: number
  connectMs: number
}

/** The narrow part of a spawned helper this module uses, so portable tests can supply a real child of their own. */
export interface PipeProcess {
  readonly stdin: {
    /** A write may complete later (the helper's pipe is full); a promise means "wait for it before writing more". */
    write(bytes: Uint8Array): number | Promise<number>
    flush(): number | Promise<number>
    end(): number | Promise<number>
  }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(): void
}

export interface WindowsPipeOptions {
  /** Test seam: starts something that speaks the helper's control protocol. Production always starts the shipped script. */
  spawn?: (request: PipeRequest) => PipeProcess
  startupMs?: number
  connectMs?: number
}

export interface WindowsPipeConnection {
  /** Raw core bytes on the one verified connection. Errors and EOF come from the helper, never from a second open. */
  stream: Duplex
  /** Kills only this connection's helper. Safe to call more than once. */
  dispose: () => void
}

function powershell(): string {
  const root = process.env.SystemRoot
  if (!root) throw new WindowsPipeError('UNAVAILABLE', 'Windows core pipe broker is unavailable: SystemRoot is not set')
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function launch(request: PipeRequest): PipeProcess {
  const child = Bun.spawn([powershell(), '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'pipeClient'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const control = JSON.stringify({ operation: 'pipeClient', pipe: request.pipe, parentPid: request.parentPid, connectMs: request.connectMs })
  const queued = child.stdin.write(`${control}\n`)
  // A rejected preface write means the helper is already gone; its start-up path reports that to the caller.
  if (typeof queued !== 'number') void queued.catch(() => { /* the helper failed before its control line */ })
  return {
    stdin: {
      write: bytes => child.stdin.write(bytes),
      flush: () => child.stdin.flush(),
      end: () => child.stdin.end(),
    },
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: () => { try { child.kill() } catch { /* already gone */ } },
  }
}

function detail(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 500)
}

async function drain(stream: ReadableStream<Uint8Array>, keep: (chunk: Buffer) => void): Promise<void> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value && value.length) keep(Buffer.from(value))
    }
  } catch {
    // Diagnostics are best effort; the exit path below still refuses without them.
  }
}

/** Waits for a child's exit code, but never longer than ms; null means it has not exited yet. */
function settled(exit: Promise<number>, ms: number): Promise<number | null> {
  return new Promise<number | null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    exit.then(code => { clearTimeout(timer); resolve(code) }, () => { clearTimeout(timer); resolve(null) })
  })
}

/** Gives the stderr reader a bounded moment to deliver a refusal's last bytes. */
function drainMoment(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    work.then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); resolve() })
  })
}

function within<T>(work: Promise<T>, ms: number, timeout: () => WindowsPipeError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout()), ms)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/**
 * Start the fixed helper, wait for READY, and return the same connected stream for core frames. Before READY, every
 * failure (spawn, refusal, malformed preface, timeout, early exit) kills the helper and rejects; no connection is
 * handed back half-verified. After READY, the helper owns one end of the pipe and this side owns the other: stdout
 * EOF ends the stream once every byte is delivered, and a closed stdin, an error, a cancellation or the helper's own
 * exit releases the other copy. There is no reconnect here; a fresh attempt is the core session's decision.
 */
export async function openWindowsPipe(path: string, options: WindowsPipeOptions = {}): Promise<WindowsPipeConnection> {
  let pipe: string
  try {
    pipe = windowsCorePipe(path, 'core socket')
  } catch (error) {
    throw new WindowsPipeError('REFUSED', error instanceof Error ? error.message : String(error))
  }
  const start = options.spawn ?? launch
  const startupMs = options.startupMs ?? STARTUP_MS
  const connectMs = options.connectMs ?? CONNECT_MS

  let child: PipeProcess
  try {
    child = start({ pipe, parentPid: process.pid, connectMs })
  } catch (error) {
    throw new WindowsPipeError('UNAVAILABLE', `Windows core pipe broker could not start: ${error instanceof Error ? error.message : String(error)}`)
  }

  let diagnostic = ''
  const drained = drain(child.stderr, chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-MAX_DIAGNOSTIC) })
  const reason = (prefix: string) => {
    const rest = detail(diagnostic)
    return rest ? `${prefix}: ${rest}` : prefix
  }

  const reader = child.stdout.getReader()
  let preface = Buffer.alloc(0)
  let tail = Buffer.alloc(0)
  try {
    await within((async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // The helper reports a refusal on stderr and exits 4 (a security refusal) or 3 (its connect deadline); wait
          // briefly for that code and for the last stderr bytes so an unverified pipe is reported as refused, with its
          // reason. A connect deadline is transient — the core may still be starting — so only 4 is a refusal.
          const code = await settled(child.exited, EXIT_MS)
          await drainMoment(drained, 250)
          const text = reason('Windows core pipe broker stopped before it was ready')
          if (code === 4) throw new WindowsPipeError('REFUSED', text)
          throw new WindowsPipeError('UNAVAILABLE', text)
        }
        preface = Buffer.concat([preface, value ? Buffer.from(value) : Buffer.alloc(0)])
        const newline = preface.indexOf(10)
        if (newline < 0) {
          if (preface.length > MAX_PREFACE) throw new WindowsPipeError('TOOLARGE', 'Windows core pipe broker sent an oversized startup line')
          continue
        }
        const line = preface.subarray(0, newline).toString('utf8').replace(/\r$/, '')
        if (line !== PIPE_READY) throw new WindowsPipeError('REFUSED', `Windows core pipe broker refused this core pipe: ${detail(line) || 'no reason was given'}`)
        // READY and the first core bytes can share one read; they belong to the core, not to the control line.
        tail = preface.subarray(newline + 1)
        return
      }
    })(), startupMs, () => new WindowsPipeError('UNAVAILABLE', `Windows core pipe broker was not ready within ${startupMs} ms`))
  } catch (error) {
    try { child.kill() } catch { /* already gone */ }
    try { await reader.cancel() } catch { /* stream already closed */ }
    throw error instanceof WindowsPipeError ? error : new WindowsPipeError('UNAVAILABLE', reason('Windows core pipe broker failed'))
  }

  let stream!: Duplex
  let paused = false
  let pumping = false
  let ending = false
  let finished = false
  let stopped = false

  const stopInput = () => {
    try {
      const closed = child.stdin.end()
      if (typeof closed !== 'number') void closed.catch(() => { /* helper already gone */ })
    } catch {
      // stdin already closed
    }
  }

  const teardown = () => {
    if (stopped) return
    stopped = true
    stopInput()
    try { child.kill() } catch { /* already gone */ }
  }

  // The helper writes core bytes on stdout and closes stdout when it exits, so the end of the stream has to come from
  // that EOF: every byte it wrote is already queued at that point, and cancelling the reader instead would drop bytes
  // the consumer has not read yet (a large READY tail alone can pause the pump). The exit code is read here only to
  // tell a relay fault from a clean end, and the wait is bounded because a helper that closes stdout but stays alive
  // still has to be released.
  const finish = async () => {
    if (ending || finished) return
    ending = true
    const code = await settled(child.exited, EXIT_MS)
    if (finished) return
    finished = true
    // Somebody disposed of this connection on purpose: the helper was killed, so its exit code says nothing about the
    // core. End the stream quietly instead of reporting the kill as a relay fault.
    const deliberate = stopped
    teardown()
    if (!deliberate && code !== null && code !== 0) {
      // The helper writes its refusal or fault text to stderr before it exits; a bounded wait keeps the last bytes.
      await drainMoment(drained, 250)
      stream.destroy(new WindowsPipeError('UNAVAILABLE', reason(`Windows core pipe broker exited with code ${code}`)))
      return
    }
    stream.push(null)
  }

  const pump = async () => {
    if (pumping || paused || finished) return
    pumping = true
    try {
      if (tail.length) {
        const chunk = tail
        tail = Buffer.alloc(0)
        if (!stream.push(chunk)) { paused = true; return }
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) { await finish(); return }
        if (!value || !value.length) continue
        if (!stream.push(Buffer.from(value))) { paused = true; return }
      }
    } catch (error) {
      finished = true
      stream.destroy(error instanceof Error ? error : new Error(String(error)))
    } finally {
      pumping = false
    }
  }

  stream = new Duplex({
    read() {
      if (paused) { paused = false; void pump() }
    },
    write(bytes, _encoding, done) {
      try {
        // Waiting for the helper to accept the bytes (and for its stdin flush) keeps the core's write buffer bounded
        // even when the helper's pipe is full and the write itself has to complete later.
        const written = child.stdin.write(bytes)
        const flushed = typeof written === 'number' ? child.stdin.flush() : written.then(() => child.stdin.flush())
        if (typeof flushed === 'number') done()
        else void flushed.then(() => done(), error => done(error))
      } catch (error) {
        done(error as Error)
      }
    },
    final(done) {
      stopInput()
      done()
    },
    destroy(error, done) {
      finished = true
      teardown()
      done(error)
    },
  })

  void pump()
  return { stream, dispose: teardown }
}
