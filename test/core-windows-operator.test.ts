// The Windows private operator transport: the helper's bounded app channel with a controllable stand-in, the client
// half with a controllable peer, then real Windows objects (pipe creation, boot handshake, parent death). These tests
// are written for GitHub's Windows runner; this machine never runs them (see AGENTS.md).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CoreSource } from '../server/core/source.ts'
import { operatorRequest } from '../server/core/operator.ts'
import {
  OPERATOR_READY,
  WindowsOperatorError,
  startWindowsOperator,
  windowsOperatorRequest,
  windowsOperatorStop,
  type ClientControl,
  type OperatorIdentity,
  type OperatorLaunch,
  type OperatorProcess,
} from '../server/core/windows-operator.ts'

const WINDOWS = process.platform === 'win32'
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const HELPER = join(import.meta.dir, '..', 'helper', 'core-windows.ps1')
const PIPE = '\\\\.\\pipe\\shepherdr-operator-0123abcd-deadbeef'
const BOOT = '0123abcd-0000-4000-8000-000000000000'

/**
 * The first version only serves an ordinary medium-integrity user on both ends of the pipe. GitHub's Windows runners
 * start their processes elevated (high integrity), where a real handshake cannot run: the refusal stays unproven there
 * and T6 has to run the plain-token layer.
 */
const PLAIN_USER = WINDOWS && plainUser()

function plainUser(): boolean {
  const who = spawnSync('whoami.exe', ['/groups'], { windowsHide: true, encoding: 'utf8' })
  const output = typeof who.stdout === 'string' ? who.stdout : String(who.stdout ?? '')
  return who.status === 0 && output.includes('S-1-16-8192')
}

type OperatorCalls = { args: string[]; stdin: string | undefined }

type FakeSource = {
  quiescing: boolean
  secrets: { operator(args: string[], stdin?: string): Promise<string> }
  calls: OperatorCalls[]
}

/** A `CoreSource` stand-in: the transport only needs the vault seam and the quiescing flag. */
function fakeSource(work: (args: string[], stdin: string | undefined) => Promise<string> = async args => `ran ${args.join(' ')}\n`): FakeSource {
  const calls: OperatorCalls[] = []
  return {
    quiescing: false,
    calls,
    secrets: {
      operator: async (args, stdin) => {
        calls.push({ args, stdin })
        return work(args, stdin)
      },
    },
  }
}

function frame(kind: number, body: string | Uint8Array): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  const out = Buffer.alloc(4 + 1 + bytes.length)
  out.writeUInt32LE(bytes.length + 1, 0)
  out[4] = kind
  bytes.copy(out, 5)
  return out
}

type FakeHelper = {
  spawn: (launch: OperatorLaunch) => OperatorProcess
  launch: () => OperatorLaunch
  /** Frames this side wrote into the app channel, in order. */
  frames: () => Array<{ kind: number; body: string }>
  /** Push one helper frame (or raw bytes) to the application, as the shipped helper would. */
  push: (kind: number, body?: string | Uint8Array) => void
  raw: (bytes: Uint8Array) => void
  /** Ends the helper's stdout without an exit code, as a helper that closed its own stdout would. */
  close: () => void
  kills: () => number
  ended: () => boolean
  exited: () => Promise<number>
  /** Ends the helper: stdout closes first, then the exit code. */
  exit: (code: number) => void
}

type FakeHelperSetup = {
  /** `null` writes no startup line at all. */
  ready?: string | null
  /** Bytes appended to the startup chunk, so a frame can arrive with the READY line. */
  between?: Uint8Array
  /** Splits the startup line across two chunks at a byte boundary. */
  splitReady?: boolean
  diagnostic?: string
  /** Ends the helper with this code as soon as the startup line has been written. */
  exitCode?: number
  neverExit?: boolean
}

function fakeHelper(setup: FakeHelperSetup = {}): FakeHelper {
  const writes: Array<{ kind: number; body: string }> = []
  let launch: OperatorLaunch | undefined
  let kills = 0
  let ended = false
  let closed = false
  let resolved = false
  let buffered = Buffer.alloc(0)
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let finish: (code: number) => void = () => {}
  const exited = new Promise<number>(resolve => {
    finish = resolve
  })
  const closeStdout = () => {
    if (closed) return
    closed = true
    try {
      controller?.close()
    } catch {
      /* already closed */
    }
  }
  const exit = (code: number) => {
    closeStdout()
    if (resolved) return
    resolved = true
    finish(code)
  }
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      const line = setup.ready === undefined ? `${OPERATOR_READY} 4242\n` : setup.ready
      if (line !== null) {
        const chunk = Buffer.concat([Buffer.from(line, 'utf8'), setup.between ?? Buffer.alloc(0)])
        if (setup.splitReady && chunk.length > 1) {
          const at = Math.floor(chunk.length / 2)
          c.enqueue(chunk.subarray(0, at))
          c.enqueue(chunk.subarray(at))
        } else c.enqueue(chunk)
      }
      if (setup.exitCode !== undefined) queueMicrotask(() => exit(setup.exitCode!))
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      if (setup.diagnostic) c.enqueue(Buffer.from(setup.diagnostic, 'utf8'))
      c.close()
    },
  })

  const stdin: OperatorProcess['stdin'] = {
    write(bytes) {
      buffered = Buffer.concat([buffered, Buffer.from(bytes)])
      while (buffered.length >= 5) {
        const length = buffered.readUInt32LE(0)
        if (buffered.length < 4 + length) break
        const kind = buffered[4]!
        const body = buffered.subarray(5, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        writes.push({ kind, body })
      }
      return bytes.length
    },
    flush: () => 0,
    end: () => {
      ended = true
      return 0
    },
  }

  return {
    spawn(incoming) {
      launch = incoming
      return {
        stdin,
        stdout,
        stderr,
        exited,
        kill: () => {
          kills += 1
          exit(-1)
        },
      }
    },
    launch: () => {
      if (!launch) throw new Error('the transport did not start a helper')
      return launch
    },
    frames: () => writes.slice(),
    push: (kind, body = '') => {
      controller?.enqueue(frame(kind, body))
    },
    raw: bytes => {
      controller?.enqueue(Buffer.from(bytes))
    },
    close: closeStdout,
    kills: () => kills,
    ended: () => ended,
    exited: () => exited,
    exit,
  }
}

/** A client half whose stdout carries exactly `text`, so the client-side parsing can be tested without a pipe. */
function replyProcess(text: string, code = 0, diagnostic = '', options: { chunks?: Uint8Array[]; neverExit?: boolean } = {}) {
  const writes: Buffer[] = []
  let ended = false
  let kills = 0
  let resolve: (value: number) => void = () => {}
  const exited = new Promise<number>(done => {
    resolve = done
  })
  return {
    process: {
      stdin: {
        write(bytes: Uint8Array) {
          writes.push(Buffer.from(bytes))
          return bytes.length
        },
        flush: () => 0,
        end: () => {
          ended = true
          return 0
        },
      },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          if (options.chunks) for (const chunk of options.chunks) controller.enqueue(chunk)
          else if (text) controller.enqueue(Buffer.from(text, 'utf8'))
          controller.close()
          if (!options.neverExit) resolve(code)
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          if (diagnostic) controller.enqueue(Buffer.from(diagnostic, 'utf8'))
          controller.close()
        },
      }),
      exited,
      kill: () => {
        kills += 1
        resolve(-1)
      },
    } as OperatorProcess,
    writes: () => writes,
    ended: () => ended,
    kills: () => kills,
  }
}

/** A client half that never answers: its stdout stays open until the transport gives up and kills it. */
function silentProcess() {
  let closed = false
  let resolve: (value: number) => void = () => {}
  const exited = new Promise<number>(done => {
    resolve = done
  })
  const stdout = new ReadableStream<Uint8Array>({
    start() {
      /* stays open */
    },
  })
  return {
    process: {
      stdin: { write: (bytes: Uint8Array) => bytes.length, flush: () => 0, end: () => 0 },
      stdout,
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }),
      exited,
      kill: () => {
        if (closed) return
        closed = true
        resolve(-1)
      },
    } as OperatorProcess,
  }
}

async function eventually(check: () => boolean, ms = 3000, message = 'the expected state did not arrive'): Promise<void> {
  const limit = Date.now() + ms
  while (Date.now() < limit) {
    if (check()) return
    await Bun.sleep(10)
  }
  if (!check()) throw new Error(message)
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const IDENTITY: OperatorIdentity = { boot: BOOT, appPid: 4242, helperPid: 5151 }

describe('windows private operator helper channel (portable)', () => {
  test('reads a startup line split across chunks and keeps a frame that followed it', async () => {
    const source = fakeSource()
    const helper = fakeHelper({
      splitReady: true,
      between: frame(1, JSON.stringify({ args: ['secret', 'set', 'DEMO'], stdin: 'value' })),
    })
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      expect(started.path).toMatch(/^\\\\\.\\pipe\\shepherdr-operator-0123abcd-[a-f0-9]{8}$/)
      expect(started.pid).toBe(4242)
      expect(helper.launch().appPid).toBe(process.pid)
      expect(helper.launch().parentPid).toBe(process.pid)
      await eventually(() => helper.frames().length === 1)
      expect(JSON.parse(helper.frames()[0]!.body)).toEqual({ out: 'ran secret set DEMO\n', code: 0 })
      expect(source.calls).toEqual([{ args: ['secret', 'set', 'DEMO'], stdin: 'value' }])
    } finally {
      started.close()
    }
  })

  test('accepts a startup line with a CRLF ending', async () => {
    const helper = fakeHelper({ ready: `${OPERATOR_READY} 77\r\n` })
    const started = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      expect(started.pid).toBe(77)
    } finally {
      started.close()
    }
  })

  test('refuses an unknown startup version instead of guessing', async () => {
    const helper = fakeHelper({ ready: 'SHEPHERDR-OPERATOR/2 4242\n' })
    const error = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsOperatorError)
    expect((error as WindowsOperatorError).code).toBe('REFUSED')
    expect((error as Error).message).toContain('refused this endpoint')
    expect(helper.kills()).toBe(1)
  })

  test('refuses an oversized startup line', async () => {
    const helper = fakeHelper({ ready: `${'x'.repeat(300)}` })
    const error = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsOperatorError)
    expect((error as Error).message).toContain('oversized startup line')
    expect(helper.kills()).toBe(1)
  })

  test('reports the helper diagnostic when it exits before READY', async () => {
    const helper = fakeHelper({ ready: null, exitCode: 4, diagnostic: 'shepherdr-operator UNSAFE: the operator endpoint is unsafe' })
    const error = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsOperatorError)
    expect((error as WindowsOperatorError).code).toBe('REFUSED')
    expect((error as Error).message).toContain('the operator endpoint is unsafe')
  })

  test('times out a helper that never becomes ready and kills it', async () => {
    const helper = fakeHelper({ ready: null })
    const error = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn, startupMs: 25 }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsOperatorError)
    expect((error as Error).message).toContain('was not ready within 25 ms')
    expect(helper.kills()).toBe(1)
  })

  test('refuses a malformed request without disturbing the channel', async () => {
    const helper = fakeHelper()
    const source = fakeSource()
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      helper.push(1, 'not json')
      await eventually(() => helper.frames().length === 1)
      expect(JSON.parse(helper.frames()[0]!.body)).toEqual({ out: 'Invalid private operator request\n', code: 1 })
      helper.push(1, JSON.stringify({ args: ['secret', 'set', 'DEMO'] }))
      await eventually(() => helper.frames().length === 2)
      expect(JSON.parse(helper.frames()[1]!.body)).toEqual({ out: 'ran secret set DEMO\n', code: 0 })
      expect(source.calls).toHaveLength(1)
    } finally {
      started.close()
    }
  })

  test('keeps the argument and stdin bounds of the POSIX socket', async () => {
    const helper = fakeHelper()
    const source = fakeSource()
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      helper.push(1, JSON.stringify({ args: Array.from({ length: 17 }, () => 'x') }))
      helper.push(1, JSON.stringify({ args: ['x'.repeat(257)] }))
      helper.push(1, JSON.stringify({ args: ['secret', 'set', 'BIG'], stdin: 'y'.repeat(64 * 1024 + 1) }))
      helper.push(1, JSON.stringify({ args: 'secret' }))
      await eventually(() => helper.frames().length === 4)
      for (const written of helper.frames()) expect(JSON.parse(written.body)).toEqual({ out: 'Invalid private operator request\n', code: 1 })
      expect(source.calls).toHaveLength(0)
    } finally {
      started.close()
    }
  })

  test('answers a vault reply that cannot fit in one frame with a bounded refusal', async () => {
    const helper = fakeHelper()
    const source = fakeSource(async () => 'x'.repeat(512 * 1024))
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      helper.push(1, JSON.stringify({ args: ['secret', 'set', 'DEMO'] }))
      await eventually(() => helper.frames().length === 1)
      expect(JSON.parse(helper.frames()[0]!.body)).toEqual({ out: 'The operator reply is too large\n', code: 1 })
      expect(source.calls).toHaveLength(1)
    } finally {
      started.close()
    }
  })

  test('refuses secrets while the source is quiescing', async () => {
    const helper = fakeHelper()
    const source = fakeSource()
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      source.quiescing = true
      helper.push(1, JSON.stringify({ args: ['secret', 'set', 'DEMO'] }))
      await eventually(() => helper.frames().length === 1)
      expect(JSON.parse(helper.frames()[0]!.body)).toEqual({ out: 'Shepherdr is stopping; retry after it reconnects\n', code: 1 })
      expect(source.calls).toHaveLength(0)
    } finally {
      started.close()
    }
  })

  test('refuses a stop request when no handler is wired', async () => {
    const helper = fakeHelper()
    const started = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      helper.push(1, JSON.stringify({ stop: true }))
      await eventually(() => helper.frames().length === 1)
      expect(JSON.parse(helper.frames()[0]!.body)).toEqual({
        out: 'This core does not accept a stop request through its private operator channel.\n',
        code: 1,
      })
    } finally {
      started.close()
    }
  })

  test('runs a stop handler only after the reply reached the client', async () => {
    const order: string[] = []
    const helper = fakeHelper()
    const started = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, {
      spawn: helper.spawn,
      onStop: () => {
        order.push('stop')
      },
    })
    try {
      helper.push(1, JSON.stringify({ stop: true }))
      await eventually(() => helper.frames().length === 1)
      expect(JSON.parse(helper.frames()[0]!.body)).toEqual({ out: 'Stopping Shepherdr.\n', code: 0 })
      expect(order).toEqual([])
      helper.push(3)
      await eventually(() => order.length === 1)
      expect(order).toEqual(['stop'])
      helper.push(3)
      await Bun.sleep(20)
      expect(order).toEqual(['stop'])
    } finally {
      started.close()
    }
  })

  test('does not run a stop whose reply the client never read', async () => {
    const order: string[] = []
    const helper = fakeHelper()
    const started = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, {
      spawn: helper.spawn,
      onStop: () => {
        order.push('stop')
      },
    })
    try {
      helper.push(1, JSON.stringify({ stop: true }))
      await eventually(() => helper.frames().length === 1)
      expect(JSON.parse(helper.frames()[0]!.body)).toEqual({ out: 'Stopping Shepherdr.\n', code: 0 })
      // The helper could not give the reply to the client, so it abandons it; a later acknowledgement of an unrelated
      // request must not drain this core.
      helper.push(4)
      helper.push(1, JSON.stringify({ args: ['secret', 'set', 'DEMO'] }))
      await eventually(() => helper.frames().length === 2)
      helper.push(3)
      await Bun.sleep(20)
      expect(order).toEqual([])
    } finally {
      started.close()
    }
  })

  test('fails the channel when the application never answers', async () => {
    const helper = fakeHelper()
    const source = fakeSource(
      () =>
        new Promise<string>(() => {
          /* never settles */
        }),
    )
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn, requestMs: 25 })
    try {
      helper.push(1, JSON.stringify({ args: ['secret', 'set', 'DEMO'] }))
      await eventually(() => helper.kills() === 1)
      // Nothing may be written back on behalf of a request the application abandoned.
      expect(helper.frames()).toEqual([])
    } finally {
      started.close()
    }
  })

  test('does not write a late answer for the next client', async () => {
    let release: (value: string) => void = () => {}
    const helper = fakeHelper()
    const source = fakeSource(
      () =>
        new Promise<string>(resolve => {
          release = resolve
        }),
    )
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn, requestMs: 25 })
    try {
      helper.push(1, JSON.stringify({ args: ['secret', 'set', 'LATE'] }))
      await eventually(() => helper.kills() === 1)
      release('answered after the channel closed')
      await Bun.sleep(20)
      // The stale value must not be framed after the channel failed, and no new request is read on a closed helper.
      expect(helper.frames()).toEqual([])
    } finally {
      started.close()
    }
  })

  test('fails and cleans up an oversized helper frame', async () => {
    const helper = fakeHelper()
    const started = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      helper.raw(Buffer.from([0xff, 0xff, 0xff, 0xff, 1]))
      await eventually(() => helper.kills() === 1)
      expect(helper.kills()).toBe(1)
    } finally {
      started.close()
    }
  })

  test('refuses an oversized frame from its four-byte header alone', async () => {
    const helper = fakeHelper()
    const started = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      // The length already says "too large": the transport must refuse without waiting for a body that will never fit.
      helper.raw(Buffer.from([0xff, 0xff, 0xff, 0xff]))
      await eventually(() => helper.kills() === 1)
      expect(helper.kills()).toBe(1)
    } finally {
      started.close()
    }
  })

  test('does not answer a truncated frame that ends with the channel', async () => {
    const helper = fakeHelper()
    const source = fakeSource()
    const started = await startWindowsOperator(source as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    try {
      helper.raw(frame(1, JSON.stringify({ args: ['secret', 'set', 'DEMO'] })).subarray(0, 7))
      helper.close()
      await Bun.sleep(20)
      expect(helper.frames()).toHaveLength(0)
      expect(source.calls).toHaveLength(0)
    } finally {
      started.close()
    }
  })

  test('close() ends the helper channel once and kills only its own helper', async () => {
    const helper = fakeHelper()
    const started = await startWindowsOperator(fakeSource() as unknown as CoreSource, BOOT, { spawn: helper.spawn })
    started.close()
    started.close()
    expect(helper.ended()).toBe(true)
    expect(helper.kills()).toBe(1)
  })
})

describe('windows private operator client (portable)', () => {
  test('refuses a path that is not an operator pipe before starting a client', async () => {
    const error = await windowsOperatorRequest('C:\\home', 'C:\\home\\operator.sock', [], undefined, IDENTITY, {
      connect: () => {
        throw new Error('the client must not start')
      },
    }).catch(reason => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Invalid private operator pipe')
  })

  test('refuses a request without the run identity', async () => {
    const error = await windowsOperatorRequest('C:\\home', PIPE, [], undefined, undefined as unknown as OperatorIdentity, {
      connect: () => {
        throw new Error('the client must not start')
      },
    }).catch(reason => reason)
    expect((error as Error).message).toContain('needs the boot and helper identity')
  })

  test('carries the run identity and the request before the client starts', async () => {
    let control: ClientControl | undefined
    const client = replyProcess('{"out":"Saved DEMO for Everywhere.\\n","code":0}')
    const result = await windowsOperatorRequest('C:\\home', PIPE, ['secret', 'set', 'DEMO'], 'demo-value', IDENTITY, {
      connect: incoming => {
        control = incoming
        return client.process
      },
    })
    expect(result).toEqual({ out: 'Saved DEMO for Everywhere.\n', code: 0 })
    expect(control).toEqual({
      pipe: PIPE,
      hello: IDENTITY,
      request: JSON.stringify({ args: ['secret', 'set', 'DEMO'], stdin: 'demo-value' }),
      connectMs: 10_000,
      parentPid: process.pid,
    })
    expect(client.ended()).toBe(true)
  })

  test('a stop uses the same verified client flow and names the caller it must not outlive', async () => {
    let control: ClientControl | undefined
    const client = replyProcess('{"out":"Stopping Shepherdr.\\n","code":0}')
    const result = await windowsOperatorStop('C:\\home', PIPE, IDENTITY, {
      connect: incoming => { control = incoming; return client.process },
    })
    expect(result).toEqual({ out: 'Stopping Shepherdr.\n', code: 0 })
    // The caller is watched by the client helper before it connects: no stop survives the process that asked for it.
    expect(control?.parentPid).toBe(process.pid)
    expect(JSON.parse(control!.request)).toEqual({ stop: true })
    expect(control?.hello).toEqual(IDENTITY)
  })

  test('omits stdin when the caller gave none', async () => {
    let control: ClientControl | undefined
    await windowsOperatorRequest('C:\\home', PIPE, ['secret', 'rm', 'DEMO'], undefined, IDENTITY, {
      connect: incoming => {
        control = incoming
        return replyProcess('{"out":"","code":0}').process
      },
    })
    expect(JSON.parse(control!.request)).toEqual({ args: ['secret', 'rm', 'DEMO'] })
  })

  test('refuses a reply larger than the frame limit', async () => {
    const client = replyProcess('x'.repeat(512 * 1024 + 1))
    const error = await windowsOperatorRequest('C:\\home', PIPE, [], undefined, IDENTITY, { connect: () => client.process }).catch(reason => reason)
    expect((error as Error).message).toContain('too large')
    expect(client.kills()).toBe(1)
  })

  test('times out a client that never answers', async () => {
    const client = silentProcess()
    const error = await windowsOperatorRequest('C:\\home', PIPE, [], undefined, IDENTITY, { connect: () => client.process, requestMs: 25 }).catch(
      reason => reason,
    )
    expect((error as Error).message).toContain('timed out')
  })

  test('refuses a reply that is not the bounded result object', async () => {
    const error = await windowsOperatorRequest('C:\\home', PIPE, [], undefined, IDENTITY, {
      connect: () => replyProcess('{"out":1,"code":"zero"}').process,
    }).catch(reason => reason)
    expect((error as Error).message).toContain('No valid operator reply')
  })

  test('keeps a multi-byte character split across two chunks', async () => {
    const text = '{"out":"\u4fdd\u5b58 DEMO \u5b8c\u6210\u3002\\n","code":0}'
    const bytes = Buffer.from(text, 'utf8')
    // Split inside the three bytes of the first character: decoding each chunk on its own would corrupt it.
    const at = bytes.indexOf(Buffer.from('\u4fdd', 'utf8')) + 1
    const client = replyProcess('', 0, '', { chunks: [bytes.subarray(0, at), bytes.subarray(at)] })
    const result = await windowsOperatorRequest('C:\\home', PIPE, ['secret', 'set', 'DEMO'], 'demo-value', IDENTITY, {
      connect: () => client.process,
    })
    expect(result).toEqual({ out: '\u4fdd\u5b58 DEMO \u5b8c\u6210\u3002\n', code: 0 })
  })

  test('does not accept a valid reply from a client that failed', async () => {
    const error = await windowsOperatorRequest('C:\\home', PIPE, [], undefined, IDENTITY, {
      connect: () =>
        replyProcess(
          '{"out":"Saved.\\n","code":0}',
          4,
          'shepherdr-operator REFUSED: the private operator is not the helper this core instance published',
        ).process,
    }).catch(reason => reason)
    expect((error as Error).message).toContain('client failed')
    expect((error as Error).message).toContain('not the helper this core instance published')
  })

  test('refuses a reply whose client never exited', async () => {
    const client = replyProcess('{"out":"Saved.\\n","code":0}', 0, '', { neverExit: true })
    const error = await windowsOperatorRequest('C:\\home', PIPE, [], undefined, IDENTITY, { connect: () => client.process }).catch(reason => reason)
    expect((error as Error).message).toContain('did not exit')
    expect(client.kills()).toBe(1)
  })

  test('keeps the helper refusal out of the secret path', async () => {
    const error = await windowsOperatorRequest('C:\\home', PIPE, ['secret', 'set', 'DEMO'], 'demo-value', IDENTITY, {
      connect: () => replyProcess('', 4, 'shepherdr-operator REFUSED: the operator client is not this core instance').process,
    }).catch(reason => reason)
    expect((error as Error).message).toContain('not this core instance')
    expect((error as Error).message).not.toContain('demo-value')
  })
})

describe('windows private operator (real Windows)', () => {
  test.skipIf(!PLAIN_USER)('creates the pipe privately and serves one request end to end', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shep-op-'))
    const source = fakeSource(async args => `Saved ${args.join(' ')} for Everywhere.\n`)
    const operator = await startWindowsOperator(source as unknown as CoreSource, BOOT)
    try {
      expect(operator.path).toMatch(/^\\\\\.\\pipe\\shepherdr-operator-0123abcd-[a-f0-9]{8}$/)
      expect(operator.pid).not.toBe(process.pid)
      const result = await windowsOperatorRequest(home, operator.path, ['secret', 'set', 'DEMO'], 'demo-value', {
        boot: BOOT,
        appPid: process.pid,
        helperPid: operator.pid,
      })
      expect(result).toEqual({ out: 'Saved secret set DEMO for Everywhere.\n', code: 0 })
      expect(source.calls).toEqual([{ args: ['secret', 'set', 'DEMO'], stdin: 'demo-value' }])
    } finally {
      operator.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!PLAIN_USER)('refuses a foreign boot before the secret reaches the handler', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shep-op-'))
    const source = fakeSource()
    const operator = await startWindowsOperator(source as unknown as CoreSource, BOOT)
    try {
      const error = await windowsOperatorRequest(home, operator.path, ['secret', 'set', 'DEMO'], 'demo-value', {
        boot: randomUUID(),
        appPid: process.pid,
        helperPid: operator.pid,
      }).catch(reason => reason)
      expect(error).toBeInstanceOf(Error)
      expect(source.calls).toHaveLength(0)
    } finally {
      operator.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!PLAIN_USER)('refuses a helper pid that is not the serving helper', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shep-op-'))
    const source = fakeSource()
    const operator = await startWindowsOperator(source as unknown as CoreSource, BOOT)
    try {
      const error = await windowsOperatorRequest(home, operator.path, ['secret', 'set', 'DEMO'], 'demo-value', {
        boot: BOOT,
        appPid: process.pid,
        helperPid: operator.pid + 1,
      }).catch(reason => reason)
      expect(error).toBeInstanceOf(Error)
      expect(source.calls).toHaveLength(0)
    } finally {
      operator.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!PLAIN_USER)('refuses a second helper on the same pipe name (first instance wins)', async () => {
    const pipe = `\\\\.\\pipe\\shepherdr-operator-0123abcd-${randomBytesHex(4)}`
    const first = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorServer'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    const second = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorServer'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    try {
      const control = JSON.stringify({ operation: 'operatorServer', pipe, boot: BOOT, appPid: process.pid, parentPid: process.pid })
      send(first.stdin, `${control}\n`)
      const ready = await withTimeout(readLine(first.stdout as ReadableStream<Uint8Array>), 30_000, 'the first helper did not create the pipe')
      expect(ready).toMatch(new RegExp(`^${OPERATOR_READY} [1-9][0-9]*$`))
      send(second.stdin, `${control}\n`)
      const text = await withTimeout(new Response(second.stderr as ReadableStream<Uint8Array>).text(), 30_000, 'the second helper did not report')
      const code = await withTimeout(second.exited, 30_000, 'the second helper did not exit')
      expect(code).toBe(4)
      expect(text).toContain('another process is already serving this private operator pipe')
    } finally {
      try {
        first.kill()
      } catch {
        /* already gone */
      }
      try {
        second.kill()
      } catch {
        /* already gone */
      }
      await Bun.sleep(50)
    }
  })

  test.skipIf(!PLAIN_USER)('kills the operator helper when its parent is gone', async () => {
    const supervisor = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-Command', 'Start-Sleep -Seconds 120'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    const pipe = `\\\\.\\pipe\\shepherdr-operator-0123abcd-${randomBytesHex(4)}`
    const helper = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorServer'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    try {
      const control = JSON.stringify({ operation: 'operatorServer', pipe, boot: BOOT, appPid: process.pid, parentPid: supervisor.pid })
      send(helper.stdin, `${control}\n`)
      const ready = await withTimeout(readLine(helper.stdout as ReadableStream<Uint8Array>), 30_000, 'the helper did not create the pipe')
      expect(ready).toContain(OPERATOR_READY)
      supervisor.kill()
      const code = await withTimeout(helper.exited, 20_000, 'the helper outlived its parent')
      expect(code).toBe(0)
    } finally {
      try {
        supervisor.kill()
      } catch {
        /* already gone */
      }
      try {
        helper.kill()
      } catch {
        /* already gone */
      }
      await Bun.sleep(50)
    }
  })

  test.skipIf(!PLAIN_USER)('keeps small replies intact across repeated clients', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shep-op-'))
    const source = fakeSource(async args => `Saved ${args.join(' ')}.\n`)
    const operator = await startWindowsOperator(source as unknown as CoreSource, BOOT)
    try {
      // A short reply is the case where a disconnect right after the write would drop the bytes still in the pipe
      // buffer. Each client must receive its own reply, in order, five times.
      for (let index = 0; index < 5; index += 1) {
        const result = await windowsOperatorRequest(home, operator.path, ['secret', 'set', `K${index}`], undefined, {
          boot: BOOT,
          appPid: process.pid,
          helperPid: operator.pid,
        })
        expect(result).toEqual({ out: `Saved secret set K${index}.\n`, code: 0 })
      }
      expect(source.calls).toHaveLength(5)
    } finally {
      operator.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!PLAIN_USER)('reports an undelivered stop when the client never confirms the reply', async () => {
    const pipe = `\\\\.\\pipe\\shepherdr-operator-0123abcd-${randomBytesHex(4)}`
    const name = pipe.slice(pipe.lastIndexOf('\\') + 1)
    const helper = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorServer'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    const channel = helperChannel(helper.stdout as ReadableStream<Uint8Array>)
    let client: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
    try {
      send(helper.stdin, `${JSON.stringify({ operation: 'operatorServer', pipe, boot: BOOT, appPid: process.pid, parentPid: process.pid })}\n`)
      const ready = await withTimeout(channel.ready(), 30_000, 'the helper did not create the pipe')
      const helperPid = Number(/ ([1-9][0-9]*)$/.exec(ready)?.[1])
      expect(helperPid).toBeGreaterThan(0)
      // A raw client speaks the pipe protocol but never sends the fixed receipt after reading its reply.
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous, [System.IO.Pipes.TokenImpersonationLevel]::Identification, [System.IO.Pipes.HandleInheritability]::None)`,
        '$p.Connect(5000)',
        'function Send([string]$text) { $b = [System.Text.Encoding]::UTF8.GetBytes($text); $h = [BitConverter]::GetBytes([int]$b.Length); $p.Write($h, 0, 4); $p.Write($b, 0, $b.Length); $p.Flush() }',
        "function Receive([int]$max) { $h = New-Object byte[] 4; $got = 0; while ($got -lt 4) { $n = $p.Read($h, $got, 4 - $got); if ($n -le 0) { throw 'ended' }; $got += $n }; $len = [BitConverter]::ToInt32($h, 0); if ($len -lt 1 -or $len -gt $max) { throw 'frame' }; $b = New-Object byte[] $len; $got = 0; while ($got -lt $len) { $n = $p.Read($b, $got, $len - $got); if ($n -le 0) { throw 'ended' }; $got += $n }; return [System.Text.Encoding]::UTF8.GetString($b) }",
        `Send (@{ boot = '${BOOT}'; appPid = ${process.pid}; helperPid = ${helperPid}; pid = [int64]$PID } | ConvertTo-Json -Compress)`,
        '$ok = Receive 4096',
        'if ($ok -ne \'{"ok":true}\') { throw (\'handshake \' + $ok) }',
        'Send \'{"stop":true}\'',
        '$null = Receive 524288',
        '$p.Dispose()',
        "'UNCONFIRMED'",
      ].join('\n')
      client = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
      // This process plays the application: answer the relayed stop, then expect the abandonment frame, not delivery.
      const request = await withTimeout(channel.frame(), 20_000, 'the helper did not relay the stop request')
      expect(request.kind).toBe(1)
      expect(JSON.parse(request.body)).toEqual({ stop: true })
      send(helper.stdin, frame(2, JSON.stringify({ out: 'Stopping Shepherdr.\n', code: 0 })))
      const report = await withTimeout(channel.frame(), 20_000, 'the helper did not report the delivery')
      expect(report.kind).toBe(4)
      const text = await withTimeout(new Response(client.stdout as ReadableStream<Uint8Array>).text(), 20_000, 'the raw client did not finish')
      expect(text).toContain('UNCONFIRMED')
    } finally {
      try {
        client?.kill()
      } catch {
        /* already gone */
      }
      try {
        helper.kill()
      } catch {
        /* already gone */
      }
      await Bun.sleep(50)
    }
  })

  // A client that connects, asks, and never reads its reply must not pin the single-instance server past the write
  // deadline. The reply is larger than the pipe buffer, so the helper's WriteFile really blocks.
  test.skipIf(!PLAIN_USER)('stops serving when a client never reads its reply', async () => {
    const pipe = `\\\\.\\pipe\\shepherdr-operator-0123abcd-${randomBytesHex(4)}`
    const helper = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorServer'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    let client: ReturnType<typeof Bun.spawn> | undefined
    try {
      const channel = helperChannel(helper.stdout as ReadableStream<Uint8Array>)
      send(helper.stdin, `${JSON.stringify({ operation: 'operatorServer', pipe, boot: BOOT, appPid: process.pid, parentPid: process.pid })}\n`)
      const ready = await withTimeout(channel.ready(), 20_000, 'the helper did not publish its pipe')
      expect(ready.startsWith(OPERATOR_READY)).toBe(true)
      const helperPid = Number(ready.slice(OPERATOR_READY.length + 1))
      const name = pipe.slice('\\\\.\\pipe\\'.length)
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous, [System.IO.Pipes.TokenImpersonationLevel]::Identification, [System.IO.Pipes.HandleInheritability]::None)`,
        '$p.Connect(5000)',
        'function Send([string]$text) { $b = [System.Text.Encoding]::UTF8.GetBytes($text); $h = [BitConverter]::GetBytes([int]$b.Length); $p.Write($h, 0, 4); $p.Write($b, 0, $b.Length); $p.Flush() }',
        "function Receive([int]$max) { $h = New-Object byte[] 4; $got = 0; while ($got -lt 4) { $n = $p.Read($h, $got, 4 - $got); if ($n -le 0) { throw 'ended' }; $got += $n }; $len = [BitConverter]::ToInt32($h, 0); if ($len -lt 1 -or $len -gt $max) { throw 'frame' }; $b = New-Object byte[] $len; $got = 0; while ($got -lt $len) { $n = $p.Read($b, $got, $len - $got); if ($n -le 0) { throw 'ended' }; $got += $n }; return [System.Text.Encoding]::UTF8.GetString($b) }",
        `Send (@{ boot = '${BOOT}'; appPid = ${process.pid}; helperPid = ${helperPid}; pid = [int64]$PID } | ConvertTo-Json -Compress)`,
        '$ok = Receive 4096',
        'if ($ok -ne \'{"ok":true}\') { throw (\'handshake \' + $ok) }',
        'Send \'{"args":["secret","get","BIG"]}\'',
        // Keep the connection open without reading the reply, so the helper's WriteFile cannot finish.
        'Start-Sleep -Seconds 40',
      ].join('\n')
      client = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
      const request = await withTimeout(channel.frame(), 20_000, 'the helper did not relay the request')
      expect(request.kind).toBe(1)
      const large = JSON.stringify({ out: 'x'.repeat(200_000), code: 0 })
      send(helper.stdin, frame(2, large))
      const code = await withTimeout(helper.exited, 40_000, 'the helper did not give up on the idle client')
      expect(code).toBe(3)
      const diagnostic = await new Response(helper.stderr as ReadableStream<Uint8Array>).text()
      expect(diagnostic).toContain('did not read its reply in time')
      expect(diagnostic).not.toContain('xxxx')
    } finally {
      try {
        client?.kill()
      } catch {
        /* already gone */
      }
      try {
        helper.kill()
      } catch {
        /* already gone */
      }
      await Bun.sleep(50)
    }
  })

  // An elevated runner is exactly where the helper has to refuse: it must not publish an endpoint it cannot verify.
  test.skipIf(!WINDOWS || PLAIN_USER)('refuses to serve the pipe from an elevated process', async () => {
    const pipe = `\\\\.\\pipe\\shepherdr-operator-0123abcd-${randomBytesHex(4)}`
    const helper = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'operatorServer'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    try {
      send(helper.stdin, `${JSON.stringify({ operation: 'operatorServer', pipe, boot: BOOT, appPid: process.pid, parentPid: process.pid })}\n`)
      const code = await withTimeout(helper.exited, 30_000, 'the elevated helper did not refuse')
      const diagnostic = await new Response(helper.stderr as ReadableStream<Uint8Array>).text()
      expect(code).toBe(4)
      expect(diagnostic).toContain('shepherdr-operator UNSAFE')
      expect(diagnostic).toMatch(/elevated|medium integrity/)
    } finally {
      try {
        helper.kill()
      } catch {
        /* already gone */
      }
      await Bun.sleep(50)
    }
  })

  test.skipIf(!WINDOWS)('a Windows operatorRequest without the run identity is refused', async () => {
    const error = await operatorRequest('C:\\anywhere', PIPE, ['secret', 'set', 'DEMO']).catch(reason => reason)
    expect((error as Error).message).toContain('needs the boot and helper identity')
  })
})

function randomBytesHex(bytes: number): string {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}

// A helper that exits before reading its control line rejects the write; that refusal is the test's subject, not an
// unhandled rejection.
function send(sink: { write(data: string | Uint8Array): number | Promise<number> }, data: string | Uint8Array): void {
  const queued = sink.write(data)
  if (typeof queued !== 'number') void queued.catch(() => { /* the helper is already gone */ })
}

// The helper's stdout carries an ASCII startup line and then binary frames; both are read from the same stream, so the
// leftover bytes of one read must be kept for the next call.
function helperChannel(stream: ReadableStream<Uint8Array>): { ready: () => Promise<string>; frame: () => Promise<{ kind: number; body: string }> } {
  const reader = stream.getReader()
  let buffered = Buffer.alloc(0)
  const more = async () => {
    const { done, value } = await reader.read()
    if (done) throw new Error('the helper closed its channel')
    buffered = Buffer.concat([buffered, Buffer.from(value)])
  }
  return {
    async ready() {
      while (true) {
        const newline = buffered.indexOf(10)
        if (newline >= 0) {
          const line = buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '')
          buffered = buffered.subarray(newline + 1)
          return line
        }
        await more()
      }
    },
    async frame() {
      while (true) {
        if (buffered.length >= 4) {
          const length = buffered.readUInt32LE(0)
          if (buffered.length >= 4 + length) {
            const kind = buffered[4]!
            const body = buffered.subarray(5, 4 + length).toString('utf8')
            buffered = buffered.subarray(4 + length)
            return { kind, body }
          }
        }
        await more()
      }
    },
  }
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
    const newline = text.indexOf('\n')
    if (newline >= 0) return text.slice(0, newline).replace(/\r$/, '')
  }
}
