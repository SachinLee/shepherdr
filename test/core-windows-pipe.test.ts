// The Windows core pipe broker: portable preface/relay behaviour with a controllable helper, then real Windows objects
// for the gate. These tests are written for GitHub's Windows runner; this machine never runs them (see AGENTS.md).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { PIPE_READY, WindowsPipeError, openWindowsPipe, type PipeProcess, type PipeRequest } from '../server/core/windows-pipe.ts'

const READY_LINE = `${PIPE_READY}\n`
const WINDOWS = process.platform === 'win32'
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const HELPER = join(import.meta.dir, '..', 'helper', 'core-windows.ps1')

/**
 * The first version only serves an ordinary medium-integrity user on both ends of the pipe. GitHub's Windows runners
 * start their processes elevated (high integrity), where the relay tests cannot run: there the explicit refusal test
 * below stands in for them, and relay fidelity stays unproven on that machine.
 */
const PLAIN_USER = WINDOWS && plainUser()

function plainUser(): boolean {
  const who = spawnSync('whoami.exe', ['/groups'], { windowsHide: true, encoding: 'utf8' })
  const output = typeof who.stdout === 'string' ? who.stdout : String(who.stdout ?? '')
  return who.status === 0 && output.includes('S-1-16-8192')
}

type FakeOptions = { never?: boolean; diagnostic?: string }

/** A helper stand-in: fixed stdout chunks in order, writes recorded, kill/exit observed. */
function fakeHelper(chunks: Array<string | Uint8Array>, options: FakeOptions = {}) {
  const writes: Buffer[] = []
  let kills = 0
  let ended = false
  let open = true
  let exit: (code: number) => void = () => {}
  const exited = new Promise<number>(resolve => { exit = resolve })
  let closeStdout: () => void = () => {}
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStdout = () => {
        if (!open) return
        open = false
        try { controller.close() } catch { /* already closed */ }
      }
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      // A real helper's stdout ends when its process does, so the fake keeps the two signals together: the broker must
      // never force EOF itself, and a chunked helper that outlived its own stdout cannot exist.
      if (!options.never) { closeStdout(); exit(0) }
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.diagnostic) controller.enqueue(Buffer.from(options.diagnostic))
      controller.close()
    },
  })
  const start = (_request: PipeRequest): PipeProcess => ({
    stdin: {
      write(bytes) { writes.push(Buffer.from(bytes)); return bytes.length },
      flush: () => 0,
      end: () => { ended = true; return 0 },
    },
    stdout,
    stderr,
    exited,
    kill: () => { kills += 1; closeStdout(); exit(-1) },
  })
  return {
    spawn: start,
    writes,
    kills: () => kills,
    ended: () => ended,
    /** Ends stdout without reporting an exit, as a helper that closed its stdout and stayed alive would. */
    close: () => closeStdout(),
    exit: (code: number) => { closeStdout(); exit(code) },
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

async function collect(stream: Duplex): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function payload(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 7 + 13) % 256
  return bytes
}

/**
 * Runs an open that must be refused and returns the typed refusal. A connection that opens, or a failure that is not a
 * Windows pipe refusal, fails the test with the actual outcome instead of being cast into one.
 */
async function refused(work: Promise<unknown>): Promise<WindowsPipeError> {
  let failed = false
  let reason: unknown = undefined
  try {
    await work
  } catch (error) {
    failed = true
    reason = error
  }
  if (!failed) throw new Error('the connection was opened, but this pipe had to be refused')
  if (!(reason instanceof WindowsPipeError)) {
    const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
    throw new Error(`the connection failed with ${detail} instead of a Windows pipe refusal`)
  }
  return reason
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return out
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}

describe('windows core pipe preface (portable)', () => {
  test('refuses a path that is not a local named pipe without starting a helper', async () => {
    const error = await openWindowsPipe('C:\\home\\core.sock', {
      spawn: () => { throw new Error('the helper must not start') },
    }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsPipeError)
    expect(error.message).toContain('local named pipe')
  })

  test('keeps payload bytes that share a chunk with READY', async () => {
    const body = payload(4096)
    const helper = fakeHelper([Buffer.concat([Buffer.from(READY_LINE), body])])
    const connection = await openWindowsPipe('\\\\.\\pipe\\share-a-chunk', { spawn: helper.spawn })
    expect((await collect(connection.stream)).equals(body)).toBe(true)
    connection.dispose()
  })

  test('accepts READY split across chunks, a CRLF ending, and payload on the newline chunk', async () => {
    const body = payload(1024)
    const helper = fakeHelper([
      'SHEP',
      'HERDR-CORE-PIPE/1\r',
      Buffer.concat([Buffer.from('\n'), body.subarray(0, 17)]),
      body.subarray(17),
    ])
    const connection = await openWindowsPipe('\\\\.\\pipe\\split-ready', { spawn: helper.spawn })
    expect((await collect(connection.stream)).equals(body)).toBe(true)
    connection.dispose()
  })

  test('refuses a malformed READY line and kills the helper', async () => {
    const helper = fakeHelper([`${PIPE_READY}/2\n`])
    const error = await openWindowsPipe('\\\\.\\pipe\\wrong-version', { spawn: helper.spawn }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsPipeError)
    expect(error.code).toBe('REFUSED')
    expect(error.message).toContain('core pipe')
    expect(helper.kills()).toBe(1)
  })

  test('refuses an oversized startup line', async () => {
    const helper = fakeHelper(['A'.repeat(5000)])
    const error = await openWindowsPipe('\\\\.\\pipe\\oversized', { spawn: helper.spawn }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsPipeError)
    expect(error.code).toBe('TOOLARGE')
    expect(helper.kills()).toBe(1)
  })

  test('refuses EOF before READY', async () => {
    const helper = fakeHelper([])
    const error = await openWindowsPipe('\\\\.\\pipe\\silent', { spawn: helper.spawn }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsPipeError)
    expect(error.code).toBe('UNAVAILABLE')
    expect(helper.kills()).toBe(1)
  })

  test('reports a helper that exited before READY as refused when it refused', async () => {
    const helper = fakeHelper([], { never: true, diagnostic: 'shepherdr-core-pipe UNSAFE: the core pipe grants access to another account\n' })
    const opening = openWindowsPipe('\\\\.\\pipe\\refused', { spawn: helper.spawn }).catch(reason => reason)
    helper.exit(4)
    const error = await opening
    expect(error).toBeInstanceOf(WindowsPipeError)
    expect(error.code).toBe('REFUSED')
    expect(error.message).toContain('another account')
    expect(helper.kills()).toBe(1)
  })

  test('times out a helper that never becomes ready', async () => {
    const helper = fakeHelper(['SHEP'], { never: true })
    const started = Date.now()
    const error = await openWindowsPipe('\\\\.\\pipe\\slow', { spawn: helper.spawn, startupMs: 25 }).catch(reason => reason)
    expect(error).toBeInstanceOf(WindowsPipeError)
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toContain('25 ms')
    expect(Date.now() - started).toBeLessThan(5000)
    expect(helper.kills()).toBe(1)
  })

  test('relays writes to helper stdin and ends it', async () => {
    const helper = fakeHelper([READY_LINE], { never: true })
    const connection = await openWindowsPipe('\\\\.\\pipe\\writes', { spawn: helper.spawn })
    const body = Buffer.from([0, 1, 2, 255])
    await new Promise<void>((resolve, reject) => connection.stream.write(body, error => error ? reject(error) : resolve()))
    expect(helper.writes.length).toBe(1)
    expect(helper.writes[0].equals(body)).toBe(true)
    await new Promise<void>((resolve, reject) => {
      connection.stream.once('finish', resolve)
      connection.stream.once('error', reject)
      connection.stream.end()
    })
    expect(helper.ended()).toBe(true)
    connection.dispose()
  })

  test('relays more than the stream high-water mark without dropping bytes', async () => {
    const body = payload(1024 * 1024)
    const chunks: Buffer[] = []
    for (let offset = 0; offset < body.length; offset += 32 * 1024) chunks.push(body.subarray(offset, offset + 32 * 1024))
    const helper = fakeHelper([READY_LINE, ...chunks])
    const connection = await openWindowsPipe('\\\\.\\pipe\\large', { spawn: helper.spawn })
    expect((await collect(connection.stream)).equals(body)).toBe(true)
    connection.dispose()
  })

  test('surfaces helper exit after READY as an error', async () => {
    const helper = fakeHelper([READY_LINE], { never: true })
    const connection = await openWindowsPipe('\\\\.\\pipe\\exit-after-ready', { spawn: helper.spawn })
    const failure = new Promise<Error>(resolve => connection.stream.once('error', resolve))
    helper.exit(7)
    const error = await failure
    expect(error.message).toContain('exited with code 7')
    expect(helper.kills()).toBe(1)
  })

  test('ends the stream cleanly when the helper relay finished normally', async () => {
    const body = Buffer.from('last-bytes')
    const helper = fakeHelper([READY_LINE, body], { never: true })
    const connection = await openWindowsPipe('\\\\.\\pipe\\clean-end', { spawn: helper.spawn })
    helper.exit(0)
    expect((await collect(connection.stream)).equals(body)).toBe(true)
    expect(helper.kills()).toBe(1)
  })

  // A READY tail bigger than the stream's high-water mark pauses the pump, and the helper can exit while more chunks
  // are still queued behind it. Cancelling the reader to signal the exit (the previous behaviour) silently dropped
  // those bytes; the stream may only end at the helper's own EOF, after every queued byte has been delivered.
  test('delivers every queued byte when the helper ends before the consumer starts reading', async () => {
    const first = payload(48 * 1024)
    const second = payload(32 * 1024)
    const last = Buffer.from('the-end-of-the-tail')
    const body = Buffer.concat([first, second, last])
    const helper = fakeHelper([Buffer.concat([Buffer.from(READY_LINE), first]), second, last], { never: true })
    const connection = await openWindowsPipe('\\\\.\\pipe\\queued-tail', { spawn: helper.spawn })
    helper.exit(0)
    expect((await collect(connection.stream)).equals(body)).toBe(true)
  })

  test('releases the helper when its stdout ends but its exit is never reported', async () => {
    const body = Buffer.from('final-frame')
    const helper = fakeHelper([READY_LINE, body], { never: true })
    const connection = await openWindowsPipe('\\\\.\\pipe\\silent-eof', { spawn: helper.spawn })
    // The helper closed stdout while its process and its stdin are still up: buffered bytes must still arrive, and the
    // owned helper and its input must be released without waiting for an exit that may never be reported.
    helper.close()
    expect((await collect(connection.stream)).equals(body)).toBe(true)
    expect(helper.kills()).toBe(1)
    expect(helper.ended()).toBe(true)
  }, 20_000)

  test('dispose kills the helper once and ends the stream without a kill-induced error', async () => {
    const helper = fakeHelper([READY_LINE], { never: true })
    const connection = await openWindowsPipe('\\\\.\\pipe\\dispose', { spawn: helper.spawn })
    connection.dispose()
    connection.dispose()
    expect(helper.kills()).toBe(1)
    // The helper was killed on purpose, so its non-zero exit code is not a relay fault: the stream just ends.
    expect((await collect(connection.stream)).length).toBe(0)
  })

  test('starts exactly one helper and never reconnects for the life of the connection', async () => {
    const body = payload(128 * 1024)
    let started = 0
    const helper = fakeHelper([READY_LINE, body])
    const connection = await openWindowsPipe('\\\\.\\pipe\\one-helper', {
      spawn: request => { started += 1; return helper.spawn(request) },
    })
    expect((await collect(connection.stream)).equals(body)).toBe(true)
    expect(started).toBe(1)
    connection.dispose()
    expect(started).toBe(1)
  })
})

// Real Windows fixtures. The pipe server below is a genuine named-pipe object; the assertion is on what the broker
// does with it, not on a mocked security descriptor. T6 supplies the real hc core for compatibility.
// The user ACE uses explicit pipe access (read/write data, attributes, READ_CONTROL, SYNCHRONIZE) rather than the
// generic "GA" spelling, so the stored mask does not depend on when Windows expands generic bits.
function sddl(form: 'private' | 'foreign' | 'inherit-only' | 'null'): string {
  if (form === 'private') return 'O:__SID__D:P(A;;0x0012019B;;;__SID__)(A;;0x001F01FF;;;SY)'
  if (form === 'foreign') return 'O:__SID__D:P(A;;0x0012019B;;;__SID__)(A;;0x001F01FF;;;SY)(A;;0x00120089;;;WD)'
  if (form === 'inherit-only') return 'O:__SID__D:P(A;OICI;0x0012019B;;;__SID__)(A;;0x001F01FF;;;SY)'
  return 'O:__SID__D:NO_ACCESS_CONTROL'
}

function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

// The pipe server is created with CreateNamedPipeW and the DACL from the SDDL, so the security descriptor is the one
// the gate reads from the connected handle; NamedPipeServerStream in .NET Framework cannot set a DACL after creation
// (that handle has no WRITE_DAC).
const FIXTURE = [
  'using System;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  '',
  'public static class Fixture',
  '{',
  '    const uint PIPE_ACCESS_DUPLEX = 0x00000003;',
  '    const uint SDDL_REVISION_1 = 1;',
  '    const int ERROR_PIPE_CONNECTED = 535;',
  '',
  '    [StructLayout(LayoutKind.Sequential)]',
  '    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }',
  '',
  '    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  '    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);',
  '',
  '    [DllImport("kernel32.dll")]',
  '    static extern IntPtr LocalFree(IntPtr memory);',
  '',
  '    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  '    static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES attributes);',
  '',
  '    [DllImport("kernel32.dll", SetLastError = true)]',
  '    static extern bool ConnectNamedPipe(IntPtr pipe, IntPtr overlapped);',
  '',
  '    [DllImport("kernel32.dll", SetLastError = true)]',
  '    static extern bool ReadFile(IntPtr pipe, byte[] buffer, uint count, out uint read, IntPtr overlapped);',
  '',
  '    [DllImport("kernel32.dll", SetLastError = true)]',
  '    static extern bool WriteFile(IntPtr pipe, byte[] buffer, uint count, out uint written, IntPtr overlapped);',
  '',
  '    [DllImport("kernel32.dll", SetLastError = true)]',
  '    static extern bool CloseHandle(IntPtr handle);',
  '',
  '    static int Fail(string what)',
  '    {',
  '        Console.Error.WriteLine("fixture " + what + " failed with error " + Marshal.GetLastWin32Error());',
  '        return 2;',
  '    }',
  '',
  '    public static int Serve(string name, string sddl, bool oneShot)',
  '    {',
  '        IntPtr descriptor;',
  '        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, out descriptor, IntPtr.Zero))',
  '            return Fail("descriptor");',
  '        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();',
  '        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));',
  '        attributes.lpSecurityDescriptor = descriptor;',
  '        IntPtr pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX, 0, 1, 65536, 65536, 0, ref attributes);',
  '        LocalFree(descriptor);',
  '        if (pipe == new IntPtr(-1)) return Fail("create");',
  '        Stream stdout = Console.OpenStandardOutput();',
  '        byte[] listening = Encoding.ASCII.GetBytes("LISTENING\\n");',
  '        stdout.Write(listening, 0, listening.Length);',
  '        stdout.Flush();',
  '        if (!ConnectNamedPipe(pipe, IntPtr.Zero))',
  '        {',
  '            int error = Marshal.GetLastWin32Error();',
  '            if (error != ERROR_PIPE_CONNECTED) return Fail("connect");',
  '        }',
  '        byte[] buffer = new byte[65536];',
  '        try',
  '        {',
  '            if (oneShot)',
  '            {',
  '                byte[] hello = Encoding.ASCII.GetBytes("CORE-EOF\\n");',
  '                uint sent;',
  '                WriteFile(pipe, hello, (uint)hello.Length, out sent, IntPtr.Zero);',
  '                return 0;',
  '            }',
  '            while (true)',
  '            {',
  '                uint read;',
  '                if (!ReadFile(pipe, buffer, (uint)buffer.Length, out read, IntPtr.Zero) || read == 0) break;',
  '                uint written;',
  '                if (!WriteFile(pipe, buffer, read, out written, IntPtr.Zero) || written != read) break;',
  '            }',
  '        }',
  '        finally { CloseHandle(pipe); }',
  '        return 0;',
  '    }',
  '}',
].join('\n')

function serverScript(name: string, descriptor: string, oneShot = false): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    `$sddl = '${descriptor}' -replace '__SID__', $sid`,
    "$code = @'",
    FIXTURE,
    "'@",
    'Add-Type -TypeDefinition $code',
    `exit ([Fixture]::Serve('\\\\.\\pipe\\${name}', $sddl, ${oneShot ? '$true' : '$false'}))`,
  ].join('\n')
}

function powershell(script: string) {
  return Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encodedCommand(script)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
}

async function waitForLine(stream: ReadableStream<Uint8Array>, wanted: string, timeoutMs: number): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let buffered = ''
  try {
    while (Date.now() < deadline) {
      const { done, value } = await withTimeout(reader.read(), deadline - Date.now(), `timed out waiting for ${wanted}`)
      if (done) throw new Error(`fixture stopped before ${wanted}`)
      buffered += decoder.decode(value, { stream: true })
      while (true) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        if (buffered.slice(0, newline).trim() === wanted) return
        buffered = buffered.slice(newline + 1)
      }
    }
    throw new Error(`timed out waiting for ${wanted}`)
  } finally {
    void reader.cancel().catch(() => {})
  }
}

async function readExactly(stream: Duplex, length: number, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const stop = () => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.pause()
    }
    const timer = setTimeout(() => { stop(); reject(new Error(`timed out reading ${length} bytes`)) }, timeoutMs)
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= length) { stop(); resolve(Buffer.concat(chunks).subarray(0, length)) }
    }
    const onError = (error: Error) => { stop(); reject(error) }
    stream.on('data', onData)
    stream.on('error', onError)
    stream.resume()
  })
}

function helperAnswer(operation: string, request: Record<string, unknown>): { ok: boolean; code?: string; error?: string } {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', operation], {
    input: JSON.stringify({ operation, ...request }),
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error(result.stderr.toString() || `helper exited ${result.status}`)
  return JSON.parse(result.stdout.toString().trim())
}

function evaluate(script: string): string {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encodedCommand(script)], {
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error(result.stderr.toString() || `fixture exited ${result.status}`)
  return result.stdout.toString().trim()
}

function currentSid(): string {
  return evaluate('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
}

function descriptor(form: string, mutate: 'unknown' | 'none' = 'none'): string {
  return evaluate([
    `$sid = '${currentSid()}'`,
    `$sd = [System.Security.AccessControl.RawSecurityDescriptor]::new('${form.replaceAll('__SID__', "' + $sid + '")}')`,
    '$bytes = New-Object byte[] $sd.BinaryLength',
    '$sd.GetBinaryForm($bytes, 0)',
    mutate === 'unknown' ? '$dacl = [BitConverter]::ToInt32($bytes, 16)' : '',
    mutate === 'unknown' ? '$bytes[$dacl + 8] = 0x7f' : '',
    '[Convert]::ToBase64String($bytes)',
  ].join('\n'))
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return text(stream)
}

describe.skipIf(!WINDOWS)('windows core pipe gate (real Windows objects)', () => {
  test.skipIf(!PLAIN_USER)('relays a real private pipe on the verified connection', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('private')))
    let connection: Awaited<ReturnType<typeof openWindowsPipe>> | undefined
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      connection = await openWindowsPipe(`\\\\.\\pipe\\${name}`, { startupMs: 30_000, connectMs: 10_000 })
      const body = payload(200_000)
      connection.stream.write(body)
      const echoed = await readExactly(connection.stream, body.length)
      expect(echoed.equals(body)).toBe(true)
    } finally {
      connection?.dispose()
      server.kill()
      await server.exited
    }
  }, 60_000)

  test.skipIf(PLAIN_USER)('refuses to relay from an elevated or non-medium-integrity process', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('private')))
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      const error = await refused(openWindowsPipe(`\\\\.\\pipe\\${name}`, { startupMs: 30_000, connectMs: 10_000 }))
      expect(error.code).toBe('REFUSED')
      expect(error.message).toMatch(/elevated|medium integrity/)
    } finally {
      server.kill()
      await server.exited
    }
  }, 60_000)

  test.skipIf(!PLAIN_USER)('ends the stream when the core closes its end of the pipe', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('private'), true))
    let connection: Awaited<ReturnType<typeof openWindowsPipe>> | undefined
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      connection = await openWindowsPipe(`\\\\.\\pipe\\${name}`, { startupMs: 30_000, connectMs: 10_000 })
      const received = await withTimeout(collect(connection.stream), 20_000, 'the core end of the pipe was not reported')
      expect(received.toString('utf8')).toBe('CORE-EOF\n')
      expect(await withTimeout(server.exited, 20_000, 'the fixture kept the pipe open')).toBe(0)
    } finally {
      connection?.dispose()
      server.kill()
      await server.exited
    }
  }, 60_000)

  test.skipIf(!PLAIN_USER)('closing the stream releases the helper and the pipe', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('private')))
    let connection: Awaited<ReturnType<typeof openWindowsPipe>> | undefined
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      connection = await openWindowsPipe(`\\\\.\\pipe\\${name}`, { startupMs: 30_000, connectMs: 10_000 })
      const body = payload(4_096)
      connection.stream.write(body)
      expect((await readExactly(connection.stream, body.length)).equals(body)).toBe(true)
      connection.stream.destroy()
      expect(await withTimeout(server.exited, 20_000, 'the pipe server still had a client after the stream closed')).toBe(0)
    } finally {
      connection?.dispose()
      server.kill()
      await server.exited
    }
  }, 60_000)

  test('refuses a pipe whose protected DACL also names another account', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('foreign')))
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      const error = await refused(openWindowsPipe(`\\\\.\\pipe\\${name}`, { startupMs: 30_000, connectMs: 10_000 }))
      expect(error.code).toBe('REFUSED')
      expect(error.message).toContain('another account')
    } finally {
      server.kill()
      await server.exited
    }
  }, 60_000)

  test('refuses a pipe whose DACL is inherit-only', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('inherit-only')))
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      const error = await refused(openWindowsPipe(`\\\\.\\pipe\\${name}`, { startupMs: 30_000, connectMs: 10_000 }))
      expect(error.code).toBe('REFUSED')
      expect(error.message).toContain('ACE flags')
    } finally {
      server.kill()
      await server.exited
    }
  }, 60_000)

  test('refuses a pipe with no DACL', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('null')))
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      const error = await refused(openWindowsPipe(`\\\\.\\pipe\\${name}`, { startupMs: 30_000, connectMs: 10_000 }))
      expect(error.code).toBe('REFUSED')
      expect(error.message).toMatch(/no DACL|null/i)
    } finally {
      server.kill()
      await server.exited
    }
  }, 60_000)

  test('the descriptor seam accepts the private shape and refuses unknown or inherited ACEs', () => {
    expect(helperAnswer('verifyPipeDescriptor', { descriptor: descriptor(sddl('private')) }).ok).toBe(true)
    const foreign = helperAnswer('verifyPipeDescriptor', { descriptor: descriptor(sddl('foreign')) })
    expect(foreign.ok).toBe(false)
    expect(foreign.error).toContain('another account')
    const inherited = helperAnswer('verifyPipeDescriptor', { descriptor: descriptor(sddl('inherit-only')) })
    expect(inherited.ok).toBe(false)
    expect(inherited.error).toContain('ACE flags')
    const unknown = helperAnswer('verifyPipeDescriptor', { descriptor: descriptor(sddl('private'), 'unknown') })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('cannot be verified')
  }, 60_000)

  test('refuses an owner that is not the current user', () => {
    const system = 'S-1-5-18'
    const form = `O:${system}D:P(A;;GA;;;${system})`
    const answer = helperAnswer('verifyPipeDescriptor', { descriptor: descriptor(form) })
    expect(answer.ok).toBe(false)
    expect(answer.error).toContain('owned by you')
  }, 60_000)

  // Both lifecycle tests below need an ordinary medium-integrity user: on an elevated runner the helper refuses at the
  // integrity gate before it ever reaches the parent watch, so the assertion would be about the wrong refusal. A skip
  // here is an UNVERIFIED case, not a pass.
  test.skipIf(!PLAIN_USER)('a helper whose parent process is gone refuses instead of leaking a relay', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('private')))
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      const control = `${JSON.stringify({ operation: 'pipeClient', pipe: `\\\\.\\pipe\\${name}`, parentPid: 0x7ffe0000, connectMs: 10_000 })}\n`
      const helper = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'pipeClient'], {
        stdin: Buffer.from(control),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
      const code = await withTimeout(helper.exited, 30_000, 'the helper outlived its dead parent')
      expect(code).not.toBe(0)
      expect(await readAll(helper.stderr)).toContain('is gone or cannot be watched')
    } finally {
      server.kill()
      await server.exited
    }
  }, 60_000)

  // The dead pid above only proves the start-up check. A supervisor that dies while the pipe is live must also end the
  // helper, and it must do so even though another process still holds a copy of the helper's stdin open.
  test.skipIf(!PLAIN_USER)('a helper releases itself when its parent dies after READY with stdin still open', async () => {
    const name = `shepherdr-t2b-${randomUUID().replace(/-/g, '')}`
    const server = powershell(serverScript(name, sddl('private')))
    const supervisor = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    try {
      await waitForLine(server.stdout, 'LISTENING', 20_000)
      const control = `${JSON.stringify({ operation: 'pipeClient', pipe: `\\\\.\\pipe\\${name}`, parentPid: supervisor.pid, connectMs: 10_000 })}\n`
      const helper = Bun.spawn([POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'pipeClient'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
      helper.stdin.write(control)
      await helper.stdin.flush()
      await waitForLine(helper.stdout, PIPE_READY, 30_000)
      // stdin stays open on purpose: the watch on the supervisor, not stdin EOF, has to be what ends the helper.
      supervisor.kill()
      const code = await withTimeout(helper.exited, 20_000, 'the helper outlived the supervisor that owns its stdin')
      expect(code).toBe(0)
      expect(await readAll(helper.stderr)).toBe('')
    } finally {
      supervisor.kill()
      server.kill()
      await server.exited
    }
  }, 90_000)
})
