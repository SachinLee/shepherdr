// Windows private-state guard: every check runs in one fixed, shipped PowerShell helper that opens the real object
// once, verifies the owner, DACL, type, link count and (for reads) reads the bytes from that same handle. Nothing here
// returns a path for Bun to reopen: a path that was safe a moment ago is not authority.
//
// The helper is a system program with fixed argv and a JSON request on stdin; no shell string is ever built, no secret
// goes into argv, and the request/answer are bounded. If the helper, its policy or the filesystem cannot answer, the
// operation is refused rather than falling back to a weaker check. Same-account processes are the trusted boundary;
// an elevated administrator taking over the machine is out of scope. A pre-open check on a SQLite file is not claimed
// to make a writable parent race-free.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type WindowsSecurityCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'EACCES'
  | 'EPERM'
  | 'ENOTDIR'
  | 'ELOOP'
  | 'UNSAFE'
  | 'UNAVAILABLE'
  | 'TOOLARGE'
  | 'SHARING'

export class WindowsSecurityError extends Error {
  constructor(readonly code: WindowsSecurityCode, message: string) {
    super(message)
    this.name = 'WindowsSecurityError'
  }
}

const HELPER = fileURLToPath(new URL('../../helper/core-windows.ps1', import.meta.url))
/** The 2.0 private-file default stays 16 MiB; attachments and artifact inputs may ask for up to 32 MiB. */
const MAX_FILE = 16 * 1024 * 1024
const MAX_TRANSFER = 32 * 1024 * 1024
/** A prefix read is a peek for a reader that shows a head instead of refusing a large file; it never allocates the file. */
const MAX_HEAD = 1000000
/** Room for the JSON envelope around a base64 answer (path, identity, error fields). */
const JSON_SLACK = 64 * 1024
const MAX_BYTES = MAX_TRANSFER + MAX_TRANSFER + JSON_SLACK

interface Answer { ok: boolean; code?: string; error?: string; data?: string; path?: string; size?: number }

function encoded(bytes: number): number {
  return Math.ceil(bytes / 3) * 4 + JSON_SLACK
}

/** A read limit is a positive whole number of bytes; anything else is refused before the helper runs. */
function readLimit(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > MAX_TRANSFER) {
    throw new WindowsSecurityError('TOOLARGE', `Windows file reads are limited to whole bytes from 1 to ${MAX_TRANSFER}`)
  }
  return max
}

/** A write may be empty; 32 MiB is the largest attachment either side accepts. */
function writeSize(size: number): void {
  if (!Number.isInteger(size) || size < 0 || size > MAX_TRANSFER) {
    throw new WindowsSecurityError('TOOLARGE', `Windows file writes are limited to ${MAX_TRANSFER} bytes`)
  }
}

function powershell(): string {
  const root = process.env.SystemRoot
  if (!root) throw new WindowsSecurityError('UNAVAILABLE', 'Windows security helper is unavailable: SystemRoot is not set')
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function run(operation: string, request: Record<string, unknown>, limit = MAX_BYTES): Answer {
  if (process.platform !== 'win32') throw new WindowsSecurityError('UNAVAILABLE', 'Windows security checks are only available on Windows')
  const input = JSON.stringify({ operation, ...request })
  if (Buffer.byteLength(input) > MAX_BYTES) throw new WindowsSecurityError('TOOLARGE', 'Windows security request is too large')
  if (limit > MAX_BYTES) throw new WindowsSecurityError('TOOLARGE', 'Windows security answer limit is too large')
  const result = (() => {
    try {
      return Bun.spawnSync({
        cmd: [powershell(), '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', operation],
        stdin: Buffer.from(input),
        stdout: 'pipe',
        stderr: 'pipe',
        maxBuffer: limit,
        windowsHide: true,
      })
    } catch (error) {
      throw new WindowsSecurityError('UNAVAILABLE', `Windows security helper could not run: ${(error as Error).message}`)
    }
  })()
  const output = result.stdout.toString('utf8').trim()
  const detail = result.stderr.toString('utf8').trim()
  let answer: Answer
  try {
    answer = JSON.parse(output) as Answer
  } catch {
    throw new WindowsSecurityError('UNAVAILABLE', `Windows security helper did not return a usable answer${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }
  if (answer.ok !== true) {
    const code = (answer.code || 'UNSAFE') as WindowsSecurityCode
    throw new WindowsSecurityError(code, answer.error || 'Windows security check refused the operation')
  }
  return answer
}

/** Verify an existing directory: owner, DACL, reparse status and the ancestor chain that could replace it. Read-only. */
export function verifyDirectory(path: string): void {
  run('verifyDirectory', { path })
}

/** Verify an existing regular file before another native client (SQLite) opens it. The parent chain is checked too. */
export function verifyPrivateFile(path: string): void {
  run('verifyFile', { path })
}

/** Create a directory with a protected DACL (only this account and SYSTEM). Existing objects are refused, not repaired. */
export function createPrivateDirectory(path: string): void {
  run('createDirectory', { path })
}

/** Verify a directory, creating the leaf (and only the leaf) with a protected DACL when it is absent. */
export function preparePrivateDirectory(path: string): void {
  try {
    verifyDirectory(path)
  } catch (error) {
    if (!(error instanceof WindowsSecurityError) || error.code !== 'ENOENT') throw error
    try {
      createPrivateDirectory(path)
    } catch (inner) {
      if (!(inner instanceof WindowsSecurityError) || inner.code !== 'EEXIST') throw inner
      verifyDirectory(path)
    }
  }
}

/** Read a private file's bytes through the verified handle the helper holds; it never returns a path to reopen. */
export function readPrivateFile(path: string): string {
  return readPrivateFileBytes(path, MAX_FILE).toString('utf8')
}

/** Read up to 32 MiB of a private file's bytes from the one verified handle; the caller gets no reopenable path. */
export function readPrivateFileBytes(path: string, max = MAX_FILE): Buffer {
  const limit = readLimit(max)
  const answer = run('readFile', { path, max: limit }, encoded(limit))
  if (typeof answer.data !== 'string') throw new WindowsSecurityError('UNAVAILABLE', 'Windows security helper returned no data')
  return Buffer.from(answer.data, 'base64')
}

/**
 * Read a regular file in an ordinary repository. No private DACL is required, but every ancestor and the leaf are
 * still held open and checked: no reparse point, no second link, one stable object, and the bytes come from that handle.
 * The canonical final path is returned beside the bytes so the caller's own policy can be applied to what was read.
 */
export function readPlainFile(path: string, max: number): { path: string; bytes: Buffer } {
  const limit = readLimit(max)
  const answer = run('readPlainFile', { path, max: limit }, encoded(limit))
  if (typeof answer.data !== 'string' || typeof answer.path !== 'string') {
    throw new WindowsSecurityError('UNAVAILABLE', 'Windows security helper returned no data')
  }
  return { path: answer.path, bytes: Buffer.from(answer.data, 'base64') }
}

/**
 * Read the first bytes of a regular file in an ordinary repository, never allocating the whole file, and report the
 * object's real length. The same plain ancestor chain, the same held handle and the same after-read identity check as
 * readPlainFile apply; only the "file is larger than the limit" refusal is replaced by a bounded prefix read, so the
 * full read's 32 MiB limit is not widened and a large file is never truncated silently at a different size.
 */
export function readPlainFileHead(path: string, max: number): { path: string; bytes: Buffer; size: number } {
  if (!Number.isInteger(max) || max < 1 || max > MAX_HEAD) {
    throw new WindowsSecurityError('TOOLARGE', `Windows file head reads are limited to whole bytes from 1 to ${MAX_HEAD}`)
  }
  const answer = run('readPlainFileHead', { path, max }, encoded(max))
  if (typeof answer.data !== 'string' || typeof answer.path !== 'string') {
    throw new WindowsSecurityError('UNAVAILABLE', 'Windows security helper returned no data')
  }
  if (typeof answer.size !== 'number' || !Number.isSafeInteger(answer.size) || answer.size < 0) {
    throw new WindowsSecurityError('UNAVAILABLE', 'Windows security helper returned no usable size')
  }
  const bytes = Buffer.from(answer.data, 'base64')
  if (bytes.length !== Math.min(answer.size, max)) {
    throw new WindowsSecurityError('UNAVAILABLE', 'Windows security helper returned a different prefix')
  }
  return { path: answer.path, bytes, size: answer.size }
}

/** Write bytes to a new protected file in a verified parent, then publish it under a controlled name. */
export function writePrivateFile(path: string, data: string | Uint8Array, options: { exclusive?: boolean } = {}): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  writeSize(bytes.length)
  run('writeFile', { path, data: bytes.toString('base64'), exclusive: options.exclusive === true })
}

/** Delete the file whose handle passed the private-file checks; the deletion is issued on that same handle. */
export function deletePrivateFile(path: string): void {
  run('deleteFile', { path })
}

const MAX_PUBLISH = 16 * 1024 * 1024

/**
 * Publish one ordinary file into an existing checkout directory. This is not private state: the directory keeps its
 * own DACL and the new file inherits it, so nothing is narrowed and nothing beyond what the directory already carries
 * is granted. The directory and its ancestors are still held open (no FILE_SHARE_DELETE, no reparse point) for the
 * whole operation, the bytes are written and flushed into a uniquely named file that this call created, re-checked on
 * that same handle, and only then renamed into place with a no-replace handle rename. An existing name is refused with
 * EEXIST and is never overwritten; a failure removes only the temporary file this call still holds.
 */
export function publishPlainFile(directory: string, leaf: string, bytes: Uint8Array): void {
  if (!Number.isInteger(bytes.length) || bytes.length > MAX_PUBLISH) {
    throw new WindowsSecurityError('TOOLARGE', `Windows file publications are limited to ${MAX_PUBLISH} bytes`)
  }
  run('publishPlainFile', { directory, leaf, data: Buffer.from(bytes).toString('base64') }, encoded(bytes.length))
}

/** The narrow file seam chat and artifacts use for a local Windows app, so a portable test can prove the branch it takes. */
export interface WindowsFiles {
  preparePrivateDirectory(path: string): void
  readPrivateFileBytes(path: string, max?: number): Buffer
  readPlainFile(path: string, max: number): { path: string; bytes: Buffer }
  writePrivateFile(path: string, data: string | Uint8Array, options?: { exclusive?: boolean }): void
}

export const windowsFiles: WindowsFiles = { preparePrivateDirectory, readPrivateFileBytes, readPlainFile, writePrivateFile }
