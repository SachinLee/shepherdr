// Windows private operator transport.
//
// Bun cannot create a Windows named pipe with a chosen DACL, and a preflight check followed by a Bun connect could not
// prove that the verified endpoint and the endpoint that carries a secret are the same object. The fixed Windows
// PowerShell helper creates the pipe once with FILE_FLAG_FIRST_PIPE_INSTANCE and a protected current-user/SYSTEM DACL,
// rejects remote clients, verifies every connected client's account, session and integrity on that connected handle,
// and relays bounded frames to this process. The client half spawns the same helper, which verifies the connected
// handle (owner, protected DACL, server account/session/integrity) before the boot handshake and only sends the
// request after the helper reports the handshake passed.
//
// Frames are a 4-byte little-endian length and a UTF-8 JSON body, at most 512 KiB. The helper's own stdin/stdout
// channel carries the same length prefix plus one tag byte so this side can tell a client request from the helper's
// "the client confirmed it read the reply" acknowledgement, or the abandonment of a reply the client never confirmed,
// without parsing or re-encoding the body. Delivery is confirmed by the client over the pipe itself: a successful
// WriteFile only fills a buffer that DisconnectNamedPipe would drop, so the acknowledgement means the bytes arrived.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreSource } from './source.ts'
import type { OperatorResult } from './operator.ts'

/** EXACT first line the helper writes once the operator pipe exists and its descriptor has been verified. */
export const OPERATOR_READY = 'SHEPHERDR-OPERATOR/1'
const HELPER = fileURLToPath(new URL('../../helper/core-windows.ps1', import.meta.url))
const FRAME_LIMIT = 512 * 1024
const STARTUP_MS = 30_000
const REQUEST_MS = 15_000
const EXIT_MS = 1_000
const KIND_REQUEST = 1
const KIND_REPLY = 2
const KIND_ACK = 3
const KIND_ABANDON = 4

export class WindowsOperatorError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'REFUSED', message: string) {
    super(message)
    this.name = 'WindowsOperatorError'
  }
}

/** The boot/run identity a Windows client must present before its request may carry a secret. */
export interface OperatorIdentity {
  boot: string
  /**
   * The pid of the caller that asks for the request — the process that spawned the client helper — not the pid in the
   * run record, which names the core server. It is only a carried label: the instance is pinned by the boot id and the
   * published helper pid, and nothing here claims to prove parentage.
   */
  appPid: number
  /** The helper process that serves this operator pipe; never the application pid. */
  helperPid: number
}

export interface OperatorLaunch {
  pipe: string
  boot: string
  appPid: number
  parentPid: number
}

/** The narrow part of a spawned helper this module uses, so portable tests can supply a real child of their own. */
export interface OperatorProcess {
  readonly stdin: {
    write(bytes: Uint8Array): number | Promise<number>
    flush(): number | Promise<number>
    end(): number | Promise<number>
  }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(): void
}

export interface WindowsOperatorOptions {
  /** Test seam: starts something that speaks the helper's operator protocol. Production starts the shipped script. */
  spawn?: (launch: OperatorLaunch) => OperatorProcess
  /** Test seam: starts the client half. Production starts the shipped script. */
  connect?: (control: ClientControl) => OperatorProcess
  startupMs?: number
  requestMs?: number
  /**
   * Called after a validated stop request's reply has been flushed to the client. The next slice wires this to the
   * one idempotent drain; without it a stop request is refused and nothing happens.
   */
  onStop?: () => void | Promise<void>
}

export interface StartedWindowsOperator {
  /** The local named pipe the run record publishes. */
  path: string
  /** The helper process that owns the pipe. It is not this application's pid. */
  pid: number
  /** Kills only this operator's helper. Safe to call more than once. */
  close(): void
}

export interface ClientControl {
  pipe: string
  hello: OperatorIdentity
  request: string
  connectMs: number
  /** The caller the client watches: if it dies, the client exits without connecting, so no stop outlives its caller. */
  parentPid: number
}

function powershell(): string {
  const root = process.env.SystemRoot
  if (!root) throw new WindowsOperatorError('UNAVAILABLE', 'Windows private operator is unavailable: SystemRoot is not set')
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** `\\.\pipe\shepherdr-operator-<boot8>-<random8>`: the shape both the helper and the client validate. */
export function operatorPipe(boot: string): string {
  const suffix = crypto.getRandomValues(new Uint8Array(4))
  return `\\\\.\\pipe\\shepherdr-operator-${boot.slice(0, 8).toLowerCase()}-${Array.from(suffix, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Accepts only the helper's operator pipe name; a path, a share or a lookalike is refused. */
export function operatorPipeName(path: string): string {
  const match = /^\\\\\.\\pipe\\shepherdr-operator-[a-f0-9]{8}-[a-f0-9]{8}$/i.exec(path)
  if (!match) throw new Error('Invalid private operator pipe: the run record must name \\\\.\\pipe\\shepherdr-operator-NAME')
  return path
}

function detail(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 500)
}

function spawnServer(launch: OperatorLaunch): OperatorProcess {
  const child = Bun.spawn([powershell(), '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorServer'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const line = JSON.stringify({ operation: 'operatorServer', pipe: launch.pipe, boot: launch.boot, appPid: launch.appPid, parentPid: launch.parentPid })
  const queued = child.stdin.write(`${line}\n`)
  if (typeof queued !== 'number') void queued.catch(() => { /* the helper failed before its control line */ })
  return adapt(child)
}

// A client helper is short-lived and owned by the caller's request. It watches its caller before it connects, so a
// stop request cannot outlive the process that asked for it; the caller still kills it on its total deadline.
function spawnClient(_control: ClientControl): OperatorProcess {
  const child = Bun.spawn([powershell(), '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorClient'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  return adapt(child)
}

function adapt(child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): OperatorProcess {
  const stdin: OperatorProcess['stdin'] = child.stdin
  return {
    stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: () => { try { child.kill() } catch { /* already gone */ } },
  }
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
    // Diagnostics are best effort; the refusal below still explains itself.
  }
}

function settled(exit: Promise<number>, ms: number): Promise<number | null> {
  return new Promise<number | null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    exit.then(code => { clearTimeout(timer); resolve(code) }, () => { clearTimeout(timer); resolve(null) })
  })
}

function drainMoment(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    work.then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); resolve() })
  })
}

function within<T>(work: Promise<T>, ms: number, timeout: () => WindowsOperatorError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout()), ms)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** One frame of the app channel: 4-byte length (payload including the tag), one tag byte, then the body. */
function takeFrame(buffer: Buffer): { kind: number; body: Buffer; rest: Buffer } | null {
  if (buffer.length < 4) return null
  const length = buffer.readUInt32LE(0)
  if (length < 1) throw new WindowsOperatorError('REFUSED', 'the Windows operator helper sent an empty frame')
  // The header alone is enough to refuse: never wait for a body that is already known to be out of bounds.
  if (length > FRAME_LIMIT + 1) throw new WindowsOperatorError('REFUSED', 'the Windows operator helper sent an oversized frame')
  if (buffer.length < 5) return null
  if (buffer.length < 4 + length) return null
  return { kind: buffer[4]!, body: buffer.subarray(5, 4 + length), rest: buffer.subarray(4 + length) }
}

function reply(out: string, code: number): Buffer {
  return Buffer.from(JSON.stringify({ out, code }), 'utf8')
}

/**
 * Start the fixed helper and return the operator endpoint. The helper owns the pipe; this process owns only the
 * bounded stdin/stdout channel, one serial request at a time. Nothing here is a general RPC: a request is validated,
 * answered by `source.secrets.operator`, and the reply is flushed before a stop callback may run.
 */
export async function startWindowsOperator(source: CoreSource, boot: string, options: WindowsOperatorOptions = {}): Promise<StartedWindowsOperator> {
  const pipe = operatorPipe(boot)
  const launch = options.spawn ?? spawnServer
  const startupMs = options.startupMs ?? STARTUP_MS

  let child: OperatorProcess
  try {
    child = launch({ pipe, boot, appPid: process.pid, parentPid: process.pid })
  } catch (error) {
    throw new WindowsOperatorError('UNAVAILABLE', `Windows private operator could not start: ${error instanceof Error ? error.message : String(error)}`)
  }

  let diagnostic = ''
  const drained = drain(child.stderr, chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096) })
  const reason = (prefix: string) => {
    const rest = detail(diagnostic)
    return rest ? `${prefix}: ${rest}` : prefix
  }

  const reader = child.stdout.getReader()
  let preface: Buffer = Buffer.alloc(0)
  let tail: Buffer = Buffer.alloc(0)
  let pid = 0
  try {
    await within((async () => {
      while (true) {
        // Parse before reading: the helper may put the first frame in the same chunk as its startup line, and a
        // consumer that reads again first would wait for bytes that already arrived.
        const newline = preface.indexOf(10)
        if (newline >= 0) {
          if (newline > 256) throw new WindowsOperatorError('REFUSED', 'Windows private operator sent an oversized startup line')
          const line = preface.subarray(0, newline).toString('utf8').replace(/\r$/, '')
          const match = /^SHEPHERDR-OPERATOR\/1 ([1-9][0-9]{0,9})$/.exec(line)
          if (!match) throw new WindowsOperatorError('REFUSED', `Windows private operator refused this endpoint: ${detail(line) || 'no reason was given'}`)
          pid = Number(match[1])
          if (!Number.isSafeInteger(pid)) throw new WindowsOperatorError('REFUSED', 'Windows private operator reported an unreadable helper pid')
          // The helper writes only its startup line before the first frame, so anything after it is already framed.
          tail = preface.subarray(newline + 1)
          return
        }
        if (preface.length > 256) throw new WindowsOperatorError('REFUSED', 'Windows private operator sent an oversized startup line')
        const { done, value } = await reader.read()
        if (done) {
          const code = await settled(child.exited, EXIT_MS)
          await drainMoment(drained, 250)
          const text = reason('Windows private operator stopped before it was ready')
          if (code === 4) throw new WindowsOperatorError('REFUSED', text)
          throw new WindowsOperatorError('UNAVAILABLE', text)
        }
        preface = Buffer.concat([preface, value ? Buffer.from(value) : Buffer.alloc(0)])
      }
    })(), startupMs, () => new WindowsOperatorError('UNAVAILABLE', `Windows private operator was not ready within ${startupMs} ms`))
  } catch (error) {
    try { child.kill() } catch { /* already gone */ }
    try { await reader.cancel() } catch { /* stream already closed */ }
    throw error instanceof WindowsOperatorError ? error : new WindowsOperatorError('UNAVAILABLE', reason('Windows private operator failed'))
  }

  let closed = false
  let killed = false
  let failure: Error | null = null
  let pendingStop = false
  // The helper gives the application fifteen seconds before it fails the channel; the adapter must not wait longer,
  // or a vault call that never settles would hold the single serial client loop open forever.
  const answerMs = options.requestMs ?? REQUEST_MS

  // Safe to call from the loop's catch and from close(): one end and one kill of the helper this process owns.
  const stopHelper = () => {
    if (killed) return
    killed = true
    try {
      const ended = child.stdin.end()
      if (typeof ended !== 'number') void ended.catch(() => { /* helper already gone */ })
    } catch { /* stdin already closed */ }
    try { child.kill() } catch { /* already gone */ }
  }

  const send = async (kind: number, body: Buffer) => {
    // A late answer must never be written to a closed channel or to a helper that has already been torn down.
    if (closed || killed) throw new WindowsOperatorError('UNAVAILABLE', 'the Windows private operator is closed')
    if (body.length > FRAME_LIMIT) throw new WindowsOperatorError('REFUSED', 'the Windows operator reply is larger than 512 KiB')
    const frame = Buffer.alloc(5 + body.length)
    frame.writeUInt32LE(body.length + 1, 0)
    frame[4] = kind
    body.copy(frame, 5)
    const written = child.stdin.write(frame)
    const flushed = typeof written === 'number' ? child.stdin.flush() : written.then(() => child.stdin.flush())
    if (typeof flushed === 'number') return
    await flushed
  }

  // Bounds and shape are the same as the POSIX socket path: at most 16 arguments of at most 256 characters and one
  // stdin string below 64 KiB. Anything else is answered with a refusal, never with a thrown error out of the loop.
  const answer = async (body: Buffer): Promise<Buffer> => {
    let input: { args?: unknown; stdin?: unknown; stop?: unknown }
    try { input = JSON.parse(body.toString('utf8')) } catch { return reply('Invalid private operator request\n', 1) }
    if (!input || typeof input !== 'object') return reply('Invalid private operator request\n', 1)
    if (input.stop === true) {
      if (!options.onStop) return reply('This core does not accept a stop request through its private operator channel.\n', 1)
      pendingStop = true
      return reply('Stopping Shepherdr.\n', 0)
    }
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 16 ||
      input.args.some(word => typeof word !== 'string' || word.length > 256))) return reply('Invalid private operator request\n', 1)
    if (input.stdin !== undefined && (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin) > 64 * 1024)) return reply('Invalid private operator request\n', 1)
    if (!Array.isArray(input.args)) return reply('Invalid private operator request\n', 1)
    if (source.quiescing) return reply('Shepherdr is stopping; retry after it reconnects\n', 1)
    try {
      const body = reply(await source.secrets.operator(input.args as string[], input.stdin as string | undefined), 0)
      return body.length > FRAME_LIMIT ? reply('The operator reply is too large\n', 1) : body
    } catch (error) {
      return reply(`${(error as Error).message}\n`, 1)
    }
  }

  const handle = async (frame: { kind: number; body: Buffer }) => {
    if (frame.kind === KIND_REQUEST) {
      // The application side is a single serial channel: one unanswered request stalls every later client, and the
      // helper's own fifteen-second deadline let a stuck vault keep this loop waiting on a promise that never settles.
      // Bound the whole answer-and-send step instead; a late value is dropped rather than written for the next client.
      try {
        await within((async () => {
          const body = await answer(frame.body)
          await send(KIND_REPLY, body)
        })(), answerMs, () => new WindowsOperatorError('UNAVAILABLE', 'The private operator application did not answer in time'))
      } catch (error) {
        pendingStop = false
        stopHelper()
        throw error
      }
      return
    }
    if (frame.kind === KIND_ACK) {
      if (!pendingStop) return
      pendingStop = false
      // The helper answers with this only after the client confirmed it read the whole reply, so a stop may drain now.
      try { await options.onStop?.() } catch { /* the drain owns its own failures */ }
      return
    }
    if (frame.kind === KIND_ABANDON) {
      // The client never received the reply, so a stop that was answered must not run.
      pendingStop = false
      return
    }
    throw new WindowsOperatorError('REFUSED', `Windows private operator sent an unknown frame tag ${frame.kind}`)
  }

  const loop = (async () => {
    let buffered: Buffer = tail
    while (true) {
      // Consume what already arrived before asking for more, so a frame in the startup chunk is never stranded.
      while (true) {
        const frame = takeFrame(buffered)
        if (!frame) break
        buffered = frame.rest
        await handle(frame)
      }
      const { done, value } = await reader.read()
      if (done) {
        if (buffered.length > 0) throw new WindowsOperatorError('REFUSED', 'the Windows operator helper closed in the middle of a frame')
        throw new WindowsOperatorError('UNAVAILABLE', 'the Windows operator helper closed its channel')
      }
      buffered = Buffer.concat([buffered, Buffer.from(value ?? Buffer.alloc(0))])
    }
  })().catch(error => {
    failure = error instanceof Error ? error : new Error(String(error))
    stopHelper()
  })

  // An exit after READY means the pipe is gone; the next client attempt fails to connect, and close() stays safe.
  void child.exited.then(code => {
    if (!closed && code !== 0 && !failure) failure = new WindowsOperatorError('UNAVAILABLE', reason(`Windows private operator exited with code ${code}`))
  }, () => {})

  return {
    path: pipe,
    pid,
    close() {
      if (closed) return
      closed = true
      stopHelper()
      try { void reader.cancel() } catch { /* already closed */ }
      void loop
    },
  }
}

/**
 * Client half: one helper process connects to the operator pipe, verifies that same connected handle, performs the
 * boot handshake, and only then sends the request. `home` stays in the signature for the POSIX transport; on Windows
 * the pipe name and the expected identity from the run record are the authority.
 */
export interface WindowsOperatorClientOptions {
  /** Test seam: starts the client half. Production starts the shipped script. */
  connect?: (control: ClientControl) => OperatorProcess
  requestMs?: number
}

export async function windowsOperatorRequest(home: string, path: string, args: string[], stdin: string | undefined, expected: OperatorIdentity, options: WindowsOperatorClientOptions = {}): Promise<OperatorResult> {
  const request = JSON.stringify(stdin === undefined ? { args } : { args, stdin })
  return ask(home, path, request, expected, options)
}

/**
 * Ask the core to stop through the same authenticated client flow. The answer is an acceptance, not an exit: the
 * caller still waits for that boot's record and the original process to go, and never signals a pid by itself.
 */
export async function windowsOperatorStop(home: string, path: string, expected: OperatorIdentity, options: WindowsOperatorClientOptions = {}): Promise<OperatorResult> {
  return ask(home, path, JSON.stringify({ stop: true }), expected, options)
}

async function ask(home: string, path: string, request: string, expected: OperatorIdentity, options: WindowsOperatorClientOptions): Promise<OperatorResult> {
  void home
  operatorPipeName(path)
  if (!expected || typeof expected.boot !== 'string' || !Number.isSafeInteger(expected.appPid) || !Number.isSafeInteger(expected.helperPid)) {
    throw new Error('A Windows private operator request needs the boot and helper identity from the run record')
  }
  if (Buffer.byteLength(request) > FRAME_LIMIT) throw new Error('Operator request is too large')
  const control: ClientControl = { pipe: path, hello: { boot: expected.boot, appPid: expected.appPid, helperPid: expected.helperPid }, request, connectMs: 10_000, parentPid: process.pid }
  const child = (options.connect ?? spawnClient)(control)
  const requestMs = options.requestMs ?? REQUEST_MS

  // The helper reads exactly one control line and then never reads its stdin again; the request travels in the pipe
  // frame. Ending only after the write has been queued keeps the line complete even when the OS took a partial write.
  try {
    const queued = child.stdin.write(Buffer.from(`${JSON.stringify({ operation: 'operatorClient', ...control })}\n`, 'utf8'))
    const ended = typeof queued === 'number' ? child.stdin.end() : queued.then(() => child.stdin.end())
    if (typeof ended !== 'number') void ended.catch(() => { /* the helper already has its control line */ })
  } catch {
    try { child.kill() } catch { /* already gone */ }
    throw new Error('The private operator could not be started; inspect the named setting before retrying')
  }

  let diagnostic = ''
  const drained = drain(child.stderr, chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096) })
  const reason = (prefix: string) => {
    const rest = detail(diagnostic)
    return rest ? `${prefix}: ${rest}` : prefix
  }

  const reader = child.stdout.getReader()
  let received: Buffer = Buffer.alloc(0)
  try {
    await within((async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (!value || !value.length) continue
        // Accumulate bytes, never a decoded string per chunk: a UTF-8 character may straddle two chunks.
        received = Buffer.concat([received, Buffer.from(value)])
        if (received.length > FRAME_LIMIT) throw new WindowsOperatorError('REFUSED', 'The operator reply is too large')
      }
    })(), requestMs, () => new WindowsOperatorError('UNAVAILABLE', 'The operator command timed out; inspect the named setting before retrying'))

    const code = await settled(child.exited, EXIT_MS)
    await drainMoment(drained, 250)
    if (code === null) throw new WindowsOperatorError('UNAVAILABLE', 'The private operator client did not exit; inspect the named setting before retrying')
    // A reply is only usable from a helper that finished cleanly: valid-looking JSON from a refused client is a failure.
    if (code !== 0) throw new WindowsOperatorError('REFUSED', 'The private operator client failed')
    return parseOperatorReply(received.toString('utf8'))
  } catch (error) {
    throw new Error(reason(error instanceof Error ? error.message : 'The private operator could not be used'))
  } finally {
    // The helper is owned by this call: it must not outlive it, however the exchange ended.
    try { child.kill() } catch { /* already gone */ }
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

function parseOperatorReply(text: string): { out: string; code: number } {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('No valid operator reply; inspect the named setting before retrying') }
  if (!parsed || typeof parsed !== 'object') throw new Error('No valid operator reply; inspect the named setting before retrying')
  const value = parsed as { out?: unknown; code?: unknown }
  if (typeof value.out !== 'string' || typeof value.code !== 'number' || !Number.isInteger(value.code)) {
    throw new Error('No valid operator reply; inspect the named setting before retrying')
  }
  return { out: value.out, code: value.code }
}
