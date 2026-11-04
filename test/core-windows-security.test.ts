// Real Windows objects, real ACLs, real handles: these tests prove the private-state seam on Windows. They do not run on
// this machine (AGENTS.md forbids tests here); CI runs them. Nothing here mocks an ACL.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { inspectHome, prepareHome, readCredential } from '../server/core/home.ts'
import { CoreStore } from '../server/core/store.ts'
import { Vault } from '../server/common/secrets.ts'
import {
  preparePrivateDirectory,
  readPrivateFile,
  verifyDirectory,
  verifyPrivateFile,
  WindowsSecurityError,
  writePrivateFile,
} from '../server/core/windows-security.ts'

const WINDOWS = process.platform === 'win32'
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const HELPER = join(import.meta.dir, '..', 'helper', 'core-windows.ps1')

function ps(command: string): string {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`PowerShell failed: ${result.stderr}`)
  return result.stdout.trim()
}

function quote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

function rule(path: string, sid: string, rights: string, kind: 'Allow' | 'Deny') {
  ps(`$p=${quote(path)}; $a=Get-Acl -LiteralPath $p; $i=[System.Security.Principal.SecurityIdentifier]::new('${sid}'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($i,'${rights}','${kind}'); [void]$a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`)
}

function sddl(path: string, form: string) {
  ps(`$p=${quote(path)}; $a=Get-Acl -LiteralPath $p; $a.SetSecurityDescriptorSddlForm('${form}'); Set-Acl -LiteralPath $p -AclObject $a`)
}

function refusal(run: () => unknown): WindowsSecurityError {
  try {
    run()
  } catch (error) {
    if (error instanceof WindowsSecurityError) return error
    throw error
  }
  throw new Error('expected a Windows security refusal')
}

function temporary(name: string): string {
  return mkdtempSync(join(tmpdir(), `shep-${name}-`))
}

function privateHome(root: string): string {
  const home = join(root, 'home')
  preparePrivateDirectory(home)
  return home
}

function currentSid(): string {
  return ps("([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value")
}

function trustees(path: string): string[] {
  const out = ps(`(Get-Acl -LiteralPath ${quote(path)}).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique`)
  return out.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

function helperAnswer(operation: string, request: Record<string, unknown>) {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', operation], {
    input: JSON.stringify({ operation, ...request }),
    encoding: 'utf8',
  })
  return JSON.parse(result.stdout) as { ok: boolean; code?: string; error?: string }
}

class OutputLines {
  private buffer = ''
  private queue: string[] = []
  private waiting: ((line: string) => void)[] = []
  private closed = false

  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          this.buffer += decoder.decode(value, { stream: true })
          let at = this.buffer.indexOf('\n')
          while (at >= 0) {
            const line = this.buffer.slice(0, at).replace(/\r$/, '')
            this.buffer = this.buffer.slice(at + 1)
            const waiter = this.waiting.shift()
            if (waiter) waiter(line)
            else this.queue.push(line)
            at = this.buffer.indexOf('\n')
          }
        }
      } finally { this.closed = true }
    })()
  }

  next(timeoutMs = 15000): Promise<string> {
    const ready = this.queue.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    if (this.closed) return Promise.reject(new Error('helper closed its output'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('helper did not signal in time')), timeoutMs)
      this.waiting.push(line => { clearTimeout(timer); resolve(line) })
    })
  }
}

// Runs one real filesystem attempt in another process and reports whether it succeeded. A sharing violation or ACL
// refusal is the expected result while the helper holds the production handles.
function attempt(command: string): string {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; try { ${command}; 'SUCCEEDED' } catch { 'REFUSED: ' + $_.Exception.Message }`], { encoding: 'utf8', timeout: 20000 })
  if (result.error || result.status !== 0) throw new Error(`attempt process failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout.trim()
}

// Builds a real self-relative security descriptor with one effective full-control ACE for the current user and a
// second ACE for `secondSid` of `type`. Type 0 is an ordinary allow; 0x7f is a type .NET has no KnownAce for, which is
// the only way to put an unverifiable ACE in front of the validator without installing it on an object.
function descriptor(secondSid: string, type: number, rights: number): string {
  const script = `
$uSid=([Security.Principal.WindowsIdentity]::GetCurrent()).User
$u=New-Object byte[] $uSid.BinaryLength
$uSid.GetBinaryForm($u,0)
$fSid=[Security.Principal.SecurityIdentifier]::new('${secondSid}')
$f=New-Object byte[] $fSid.BinaryLength
$fSid.GetBinaryForm($f,0)
$m=[IO.MemoryStream]::new(); $w=[IO.BinaryWriter]::new($m)
$w.Write([byte]1); $w.Write([byte]0); $w.Write([uint16]0x8004)
$w.Write([uint32]20); $w.Write([uint32](20+$u.Length)); $w.Write([uint32]0); $w.Write([uint32](20+2*$u.Length))
$w.Write($u); $w.Write($u)
$ace1=8+$u.Length; $ace2=8+$f.Length
$w.Write([byte]2); $w.Write([byte]0); $w.Write([uint16](8+$ace1+$ace2)); $w.Write([uint16]2); $w.Write([uint16]0)
$w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]$ace1); $w.Write([uint32]0x1F01FF); $w.Write($u)
$w.Write([byte]${type}); $w.Write([byte]0); $w.Write([uint16]$ace2); $w.Write([uint32]${rights}); $w.Write($f)
$w.Flush(); [Convert]::ToBase64String($m.ToArray())`
  return ps(script)
}

test.skipIf(!WINDOWS)('absent status is read-only and creates nothing', () => {
  const root = temporary('win-absent')
  const missing = join(root, 'missing', 'home')
  try {
    expect(inspectHome(missing)).toBe('absent')
    expect(existsSync(missing)).toBe(false)
    expect(existsSync(join(root, 'missing'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a new home gets a protected DACL and a stable identity', () => {
  const root = temporary('win-home')
  try {
    const home = privateHome(root)
    verifyDirectory(home)
    const first = prepareHome(home)
    expect(prepareHome(home)).toEqual(first)
    expect(JSON.parse(readPrivateFile(join(home, 'installation.json')))).toEqual(first)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('an inherited or broad allow is refused, never repaired', () => {
  const root = temporary('win-broad')
  try {
    const home = join(root, 'home')
    mkdirSync(home)
    rule(home, 'S-1-5-32-545', 'Read', 'Allow')
    expect(refusal(() => verifyDirectory(home)).message).toMatch(/another account/)
    expect(refusal(() => preparePrivateDirectory(home)).message).toMatch(/another account/)
    expect(refusal(() => prepareHome(home)).message).toMatch(/another account/)
    // Still loose: the refusal did not rewrite the DACL.
    expect(refusal(() => verifyDirectory(home)).message).toMatch(/another account/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('an inherit-only grant to another account is refused', () => {
  const root = temporary('win-inherit')
  try {
    const home = privateHome(root)
    // Current user and SYSTEM still have effective full control; only a foreign inherit-only trustee was added.
    ps(`$p=${quote(home)}; $a=Get-Acl -LiteralPath $p; $i=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($i,'Read','ObjectInherit','InheritOnly','Allow'); [void]$a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`)
    expect(refusal(() => verifyDirectory(home)).message).toMatch(/another account/)
    expect(refusal(() => preparePrivateDirectory(home)).message).toMatch(/another account/)
    expect(refusal(() => prepareHome(home)).message).toMatch(/another account/)

    const inherited = join(root, 'inherited-only')
    mkdirSync(inherited)
    const sid = currentSid()
    sddl(inherited, `O:${sid}D:P(A;;0x1200A9;;;${sid})(A;OICIIO;FA;;;${sid})(A;OICIIO;FA;;;SY)`)
    expect(refusal(() => verifyDirectory(inherited)).message).toMatch(/full control/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('an unknown ACE is refused by the descriptor validator', () => {
  expect(helperAnswer('verifyDescriptor', { descriptor: descriptor('S-1-5-18', 0, 0x1f01ff) }).ok).toBe(true)
  const answer = helperAnswer('verifyDescriptor', { descriptor: descriptor('S-1-5-32-545', 0x7f, 0) })
  expect(answer.ok).toBe(false)
  expect(answer.error).toMatch(/cannot be verified/)
})

test.skipIf(!WINDOWS)('a deny ACE or a missing DACL refuses instead of looking private', () => {
  const root = temporary('win-deny')
  try {
    const denied = privateHome(root)
    // The helper opens with GENERIC_READ; denying WriteData leaves that open possible so the descriptor itself is
    // what refuses. Denying Read instead fails in CreateFile with EACCES, which must also refuse.
    rule(denied, 'S-1-5-32-545', 'WriteData', 'Deny')
    expect(refusal(() => verifyDirectory(denied)).message).toMatch(/deny ACE/)

    const readDenied = join(root, 'read-denied')
    preparePrivateDirectory(readDenied)
    rule(readDenied, 'S-1-5-32-545', 'Read', 'Deny')
    expect(refusal(() => verifyDirectory(readDenied)).code).toBe('EACCES')

    const nulled = join(root, 'nulled')
    preparePrivateDirectory(nulled)
    sddl(nulled, 'D:NO_ACCESS_CONTROL')
    expect(refusal(() => verifyDirectory(nulled)).message).toMatch(/no DACL/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a directory owned by another account is refused', () => {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  expect(refusal(() => verifyDirectory(system32)).message).toMatch(/owned by you/)
})

test.skipIf(!WINDOWS)('a junction is refused, including when it is the home path', () => {
  const root = temporary('win-junction')
  try {
    const target = privateHome(root)
    const link = join(root, 'link')
    ps(`New-Item -ItemType Junction -Path ${quote(link)} -Target ${quote(target)} | Out-Null`)
    expect(refusal(() => verifyDirectory(link)).message).toMatch(/reparse/)
    expect(refusal(() => prepareHome(link)).message).toMatch(/reparse/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a credential with another hardlink is refused', () => {
  const root = temporary('win-hardlink')
  try {
    const home = privateHome(root)
    const file = join(home, 'credential.json')
    writePrivateFile(file, '{"token":"x"}')
    ps(`New-Item -ItemType HardLink -Path ${quote(join(root, 'alias'))} -Target ${quote(file)} | Out-Null`)
    expect(refusal(() => readPrivateFile(file)).message).toMatch(/single link/)
    expect(refusal(() => readCredential(file)).message).toMatch(/single link/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('an open handle that denies sharing refuses read and replacement', async () => {
  const root = temporary('win-sharing')
  const home = privateHome(root)
  const file = join(home, 'credential.json')
  writePrivateFile(file, '{"token":"x"}')
  const child = Bun.spawn([
    POWERSHELL, '-NoProfile', '-NonInteractive', '-Command',
    `$f=[System.IO.File]::Open(${quote(file)},'Open','Read','None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 30`,
  ], { stdout: 'pipe', stderr: 'pipe' })
  try {
    try {
      const reader = child.stdout
      if (!reader || typeof reader === 'number') throw new Error('no helper stdout')
      const chunk = await reader.getReader().read()
      expect(new TextDecoder().decode(chunk.value)).toContain('held')
      expect(refusal(() => readPrivateFile(file)).code).toBe('SHARING')
      expect(refusal(() => writePrivateFile(file, '{}')).code).toBe('SHARING')
    } finally {
      child.kill()
      await child.exited
    }
    expect(readPrivateFile(file)).toBe('{"token":"x"}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('an unavailable helper refuses instead of falling back', () => {
  const root = temporary('win-helper')
  const home = privateHome(root)
  const before = process.env.SystemRoot
  try {
    process.env.SystemRoot = join(root, 'no-such-windows')
    expect(refusal(() => verifyDirectory(home)).code).toBe('UNAVAILABLE')
  } finally {
    if (before === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = before
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('the vault never overwrites a state it cannot read', () => {
  const root = temporary('win-vault')
  try {
    const home = join(root, 'vault-home')
    prepareHome(home)
    const file = join(home, 'vault.json')
    writePrivateFile(file, 'DO_NOT_DISCLOSE invalid JSON')
    const result = new Vault(home).set('all', 'KEY', 'value')
    expect(result.ok).toBe(false)
    expect(result.error ?? '').not.toContain('DO_NOT_DISCLOSE')
    expect(readPrivateFile(file)).toBe('DO_NOT_DISCLOSE invalid JSON')

    const fresh = join(root, 'fresh-vault')
    prepareHome(fresh)
    expect(new Vault(fresh).set('all', 'KEY', 's3cret')).toEqual({ ok: true })
    expect(readPrivateFile(join(fresh, 'vault.json'))).toContain('s3cret')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('credentials are read through the verified handle', () => {
  const root = temporary('win-credential')
  try {
    const home = join(root, 'credential-home')
    prepareHome(home)
    const good = join(home, 'credential.json')
    writePrivateFile(good, '{"token":"x"}')
    expect(readCredential<{ token: string }>(good)).toEqual({ token: 'x' })

    const loose = join(home, 'loose.json')
    writePrivateFile(loose, '{}')
    rule(loose, 'S-1-5-32-545', 'Read', 'Allow')
    expect(refusal(() => readCredential(loose)).message).toMatch(/another account/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('the store creates a private SQLite file and reopens it', () => {
  const root = temporary('win-store')
  const home = join(root, 'store-home')
  let store = new CoreStore(home)
  try {
    store.set('kind', 'key', { value: 1 })
    store.close()
    const file = join(home, 'state.sqlite')
    verifyPrivateFile(file)
    expect(statSync(file).size).toBeGreaterThan(0)
    store = new CoreStore(home)
    expect(store.get('kind', 'key')).toEqual({ value: 1 })
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('an uncommitted SQLite journal grants only the private trustees', () => {
  const root = temporary('win-journal')
  const home = join(root, 'home')
  const store = new CoreStore(home)
  try {
    store.db.exec('BEGIN IMMEDIATE')
    store.db.exec("INSERT INTO counters (key, value) VALUES ('journal-probe', 1)")
    const journal = join(home, 'state.sqlite-journal')
    expect(existsSync(journal)).toBe(true)
    expect(trustees(journal).sort()).toEqual([currentSid(), 'S-1-5-18'].sort())
  } finally {
    try { store.db.exec('ROLLBACK') } catch {}
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('held production handles block rename, hardlink and write attempts', async () => {
  const root = temporary('win-hold')
  const home = privateHome(root)
  const file = join(home, 'credential.json')
  const alias = join(root, 'alias.json')
  const moved = join(root, 'moved')
  writePrivateFile(file, '{"token":"x"}')
  const child = Bun.spawn([
    POWERSHELL, '-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER, '-Operation', 'holdFile',
  ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const lines = new OutputLines(child.stdout as ReadableStream<Uint8Array>)
  try {
    child.stdin.write(JSON.stringify({ operation: 'holdFile', path: file, waitMs: 30000 }) + '\n')
    await child.stdin.flush()
    const ready = JSON.parse(await lines.next()) as { ok: boolean; identity: string }
    expect(ready.ok).toBe(true)

    // While the production Open-Chain/Open-PrivateFile handles are held, another process cannot rename the file or an
    // ancestor, add a hardlink to it, or open it for writing. These must fail at the OS sharing layer.
    expect(attempt(`Move-Item -LiteralPath ${quote(file)} -Destination ${quote(alias)}`)).toMatch(/^REFUSED:/)
    expect(attempt(`Move-Item -LiteralPath ${quote(home)} -Destination ${quote(moved)}`)).toMatch(/^REFUSED:/)
    expect(attempt(`New-Item -ItemType HardLink -Path ${quote(alias)} -Target ${quote(file)} | Out-Null`)).toMatch(/^REFUSED:/)
    expect(attempt(`[IO.File]::WriteAllText(${quote(file)}, 'evil')`)).toMatch(/^REFUSED:/)

    child.stdin.write('continue\n')
    await child.stdin.flush()
    const final = JSON.parse(await lines.next(30000)) as { ok: boolean; identity: string }
    expect(final.ok).toBe(true)
    expect(final.identity).toBe(ready.identity)
    expect(readPrivateFile(file)).toBe('{"token":"x"}')
    expect(existsSync(alias)).toBe(false)
    expect(existsSync(home)).toBe(true)
    expect(await child.exited).toBe(0)
  } finally {
    child.kill()
    await child.exited.catch(() => 0)
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('refusals carry a Windows security code and a reason', () => {
  const root = temporary('win-reason')
  try {
    const home = privateHome(root)
    expect(() => writePrivateFile(join(home, 'missing', 'file'), 'x')).toThrow(WindowsSecurityError)
    const error = refusal(() => readPrivateFile(join(home, 'absent.json')))
    expect(error.code).toBe('ENOENT')
    expect(error.message.length).toBeGreaterThan(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
