// Publishing one ordinary file into a checkout: real directories, real inherited ACLs, real handles. AGENTS.md forbids
// running tests on this machine; CI runs the portable ones and a Windows machine runs the rest. Nothing here mocks an
// ACL or a handle, and no case claims a check it did not perform.
import { expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { publishPlainFile, readPlainFile, readPlainFileHead, WindowsSecurityError } from '../server/core/windows-security.ts'

const WINDOWS = process.platform === 'win32'
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const MIB = 1024 * 1024
/** The head limit a worktree reader asks for; anything larger is someone else's constant, not this one. */
const HEAD = 1_000_000

function ps(command: string): string {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`PowerShell failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A PowerShell single-quoted literal: no `$`, backtick or backslash is interpreted, and a quote doubles. */
function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
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
  return mkdtempSync(join(tmpdir(), `shep-publish-${name}-`))
}

function listing(directory: string): string[] {
  return readdirSync(directory).sort()
}

function directorySddl(directory: string): string {
  return ps(`$p=${q(directory)}; ([System.IO.Directory]::GetAccessControl($p)).Sddl`)
}

/** "protected|identities": whether the DACL is protected and which accounts it names, read from the real object. */
function fileAcl(file: string): string {
  return ps(
    `$p=${q(file)}; $a=[System.IO.File]::GetAccessControl($p); "$($a.AreAccessRulesProtected)|" + (($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique) -join ',')`,
  )
}

function directoryAcl(directory: string): string {
  return ps(
    `$p=${q(directory)}; $a=[System.IO.Directory]::GetAccessControl($p); "$($a.AreAccessRulesProtected)|" + (($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique) -join ',')`,
  )
}

test('a publication over the size limit is refused before the platform or the filesystem is touched', () => {
  const root = temporary('limit')
  try {
    const error = refusal(() => publishPlainFile(root, 'over.bin', new Uint8Array(16 * MIB + 1)))
    expect(error.code).toBe('TOOLARGE')
    expect(error.message).toBe('Windows file publications are limited to 16777216 bytes')
    expect(listing(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(WINDOWS)('a publication elsewhere in the process is refused, not silently skipped', () => {
  const root = temporary('platform')
  try {
    const error = refusal(() => publishPlainFile(root, 'page.html', new Uint8Array([0x41])))
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toMatch(/only available on Windows/)
    expect(listing(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('an ordinary checkout keeps its own DACL and the new file inherits it', () => {
  const root = temporary('acl')
  try {
    const before = directorySddl(root)
    publishPlainFile(root, 'page.html', new Uint8Array([0x41, 0x42]))
    expect(readFileSync(join(root, 'page.html')).equals(Buffer.from([0x41, 0x42]))).toBe(true)
    // The directory is untouched: nothing was narrowed, protected or repaired.
    expect(directorySddl(root)).toBe(before)
    const [fileProtected, fileIdentities] = fileAcl(join(root, 'page.html')).split('|')
    const [, directoryIdentities] = directoryAcl(root).split('|')
    // The file has no protected DACL of its own, and it names no account the directory does not already name: it
    // inherited what was handed down instead of being narrowed to this app or granted anything extra.
    expect(fileProtected).toBe('False')
    const inherited = new Set(directoryIdentities.split(','))
    for (const identity of fileIdentities.split(',')) expect(inherited.has(identity)).toBe(true)
    expect(existsSync(join(root, 'page.html'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a directory that grants another account write still accepts an ordinary publication', () => {
  const root = temporary('wide')
  try {
    // The rule must be inheritable, otherwise it would apply to the directory alone and the file would never name
    // Users. It is the fixture that decides this, so the fixture itself is checked back before anything is published.
    ps(
      `$p=${q(root)}; $a=[System.IO.Directory]::GetAccessControl($p); $i=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($i,'Modify',[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,'Allow'); [void]$a.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$a)`,
    )
    const ruleFlags = ps(
      `$p=${q(root)}; $a=[System.IO.Directory]::GetAccessControl($p); ($a.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-545' } | Select-Object -First 1).InheritanceFlags`,
    )
    expect(ruleFlags).toContain('ContainerInherit')
    expect(ruleFlags).toContain('ObjectInherit')
    const before = directorySddl(root)
    // A checkout is not private state: its ACL is not ours to demand, and the new file still inherits it.
    publishPlainFile(root, 'shared.txt', new Uint8Array([0x00, 0xff]))
    expect(readFileSync(join(root, 'shared.txt')).equals(Buffer.from([0x00, 0xff]))).toBe(true)
    expect(fileAcl(join(root, 'shared.txt')).split('|')[1]).toContain('S-1-5-32-545')
    // Publishing a file changed the directory's contents, never the directory's own permissions.
    expect(directorySddl(root)).toBe(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('published bytes come back exactly, including empty and a name with a space and non-ASCII text', () => {
  const root = temporary('bytes')
  try {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x0a, 0xc3, 0xa9])
    publishPlainFile(root, "it's 数据.txt", bytes)
    expect(readFileSync(join(root, "it's 数据.txt")).equals(Buffer.from(bytes))).toBe(true)

    publishPlainFile(root, 'empty.bin', new Uint8Array(0))
    expect(readFileSync(join(root, 'empty.bin')).length).toBe(0)

    const whole = new Uint8Array(16 * MIB)
    for (let index = 0; index < whole.length; index += 1) whole[index] = index % 251
    publishPlainFile(root, 'whole.bin', whole)
    expect(Buffer.compare(readFileSync(join(root, 'whole.bin')), Buffer.from(whole))).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a publication never overwrites a name that already exists', () => {
  const root = temporary('exists')
  try {
    writeFileSync(join(root, 'page.html'), 'original')
    const before = listing(root)
    const error = refusal(() => publishPlainFile(root, 'page.html', new Uint8Array([0x6e, 0x65, 0x77])))
    expect(error.code).toBe('EEXIST')
    expect(readFileSync(join(root, 'page.html'), 'utf8')).toBe('original')
    // A failed publication removes only the temporary file it created: nothing else appears.
    expect(listing(root)).toEqual(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('the second of two attempts for one name loses and leaves the winner intact', () => {
  const root = temporary('race')
  try {
    publishPlainFile(root, 'page.html', new Uint8Array([0x66, 0x69, 0x72, 0x73, 0x74]))
    const winner = readFileSync(join(root, 'page.html'))
    const error = refusal(() => publishPlainFile(root, 'page.html', new Uint8Array([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64])))
    expect(error.code).toBe('EEXIST')
    expect(readFileSync(join(root, 'page.html')).equals(winner)).toBe(true)
    expect(listing(root)).toEqual(['page.html'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a leaf that is not one plain file name is refused before anything is created', () => {
  const root = temporary('leaf')
  try {
    const cases = [
      ['a/b', /single plain Windows file name/],
      ['a\\b', /single plain Windows file name/],
      ['C:\\escape.txt', /single plain Windows file name/],
      ['page.html:stream', /single plain Windows file name/],
      ['CON', /reserved device names/],
      ['nul.txt', /reserved device names/],
      ['COM\u00b9', /reserved device names/],
      ['LPT\u00b2.ext', /reserved device names/],
      ['com\u00b3', /reserved device names/],
      ['data.', /trailing dots and spaces/],
      ['data ', /trailing dots and spaces/],
      ['', /file name is empty/],
      ['.', /must not be \. or \../],
      ['..', /must not be \. or \../],
      ['a\u0007b', /control characters/],
      ['a*b', /single plain Windows file name/],
      ['a?b', /single plain Windows file name/],
      ['a"b', /single plain Windows file name/],
      ['a<b', /single plain Windows file name/],
      ['a>b', /single plain Windows file name/],
      ['a|b', /single plain Windows file name/],
      ['x'.repeat(256), /longer than 255 characters/],
    ] as const
    for (const [leaf, message] of cases) {
      const error = refusal(() => publishPlainFile(root, leaf, new Uint8Array([0x41])))
      expect(error.code).toBe('UNSAFE')
      expect(error.message).toMatch(message)
    }
    expect(listing(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a reserved device name in the directory path is refused, not left to the filesystem', () => {
  // The same reserved-name rule applies to every segment of the path, so an ancestor cannot smuggle a device name
  // past the check for the leaf. These names are checked on the raw text, before any path normalisation.
  const root = temporary('device-path')
  try {
    for (const name of ['COM\u00b9', 'LPT\u00b2.ext', 'nul']) {
      const error = refusal(() => publishPlainFile(join(root, name), 'page.html', new Uint8Array([0x41])))
      expect(error.code).toBe('UNSAFE')
      expect(error.message).toBe('reserved device names are not allowed in a private path')
    }
    const head = refusal(() => readPlainFileHead(join(root, 'COM\u00b3', 'page.html'), 64))
    expect(head.code).toBe('UNSAFE')
    expect(head.message).toBe('reserved device names are not allowed in a private path')
    expect(listing(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a junction on the way to the directory is refused, not followed', () => {
  const root = temporary('junction')
  try {
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    ps(`New-Item -ItemType Junction -Path ${q(link)} -Target ${q(real)} | Out-Null`)
    const error = refusal(() => publishPlainFile(link, 'page.html', new Uint8Array([0x41])))
    expect(error.code).toBe('UNSAFE')
    expect(error.message).toMatch(/reparse point/)
    // The real directory did not receive the file through the junction either.
    expect(listing(real)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a missing directory is refused instead of created', () => {
  const root = temporary('missing')
  try {
    const error = refusal(() => publishPlainFile(join(root, 'absent'), 'page.html', new Uint8Array([0x41])))
    expect(error.code).toBe('ENOENT')
    expect(listing(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a target that is a hardlink is never replaced, so the other link keeps its bytes', () => {
  const root = temporary('hardlink')
  try {
    const target = join(root, 'page.html')
    const other = join(root, 'other.txt')
    writeFileSync(target, 'original')
    linkSync(target, other)
    const error = refusal(() => publishPlainFile(root, 'page.html', new Uint8Array([0x6e, 0x65, 0x77])))
    expect(error.code).toBe('EEXIST')
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(readFileSync(other, 'utf8')).toBe('original')
    expect(listing(root)).toEqual(['other.txt', 'page.html'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a failure after the temporary file exists cleans up only that temporary file', () => {
  const root = temporary('cleanup')
  try {
    writeFileSync(join(root, 'keep.txt'), 'keep')
    writeFileSync(join(root, 'page.html'), 'original')
    // The write and the flush succeed; the no-replace rename is what fails, so the temporary file exists at failure.
    const error = refusal(() => publishPlainFile(root, 'page.html', new Uint8Array([0x6e, 0x65, 0x77])))
    expect(error.code).toBe('EEXIST')
    expect(listing(root)).toEqual(['keep.txt', 'page.html'])
    expect(readFileSync(join(root, 'page.html'), 'utf8')).toBe('original')
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a publication on another fixed drive works when one exists', () => {
  const here = temporary('drive')
  try {
    const current = win32.parse(here).root.toLowerCase()
    const volumes = ps(
      `[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed -and $_.IsReady } | ForEach-Object { $_.Name }`,
    )
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean)
      .filter(volume => volume.toLowerCase() !== current)
    let published = false
    for (const volume of volumes) {
      let created: string | null = null
      try {
        created = mkdtempSync(join(volume, 'shep-publish-drive-'))
      } catch (error) {
        // Only the volume's own refusal to accept a directory may be skipped, and only before the seam is exercised:
        // nothing about this publication has been proven or disproven yet.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code !== 'EACCES' && code !== 'EPERM') throw error
      }
      if (created === null) continue
      // Once a writable directory exists, every failure is the seam's and must not be swallowed.
      try {
        publishPlainFile(created, 'page.html', new Uint8Array([0x64, 0x72, 0x69, 0x76, 0x65]))
        expect(readFileSync(join(created, 'page.html')).equals(Buffer.from([0x64, 0x72, 0x69, 0x76, 0x65]))).toBe(true)
        published = true
      } finally {
        rmSync(created, { recursive: true, force: true })
      }
    }
    if (!published) {
      console.log('UNVERIFIED cross-drive publication: no second writable fixed volume on this machine')
    }
  } finally {
    rmSync(here, { recursive: true, force: true })
  }
})

// The helper holds every ancestor, including the target directory, without FILE_SHARE_DELETE, so a rename or a
// junction swapped in during the operation fails with SHARING. Proving that needs a point inside the helper to pause
// between the create and the rename, and the shipped helper has no such seam on purpose, so this stays unproven
// rather than turning a missing race into a pass.
test.todo('UNVERIFIED: the directory cannot be swapped while a publication holds it')

test('a head limit outside the accepted range is refused before the platform or the filesystem is touched', () => {
  const root = temporary('head-limit')
  try {
    for (const max of [0, -1, 1.5, HEAD + 1, Number.NaN]) {
      const error = refusal(() => readPlainFileHead(join(root, 'page.html'), max))
      expect(error.code).toBe('TOOLARGE')
      expect(error.message).toBe('Windows file head reads are limited to whole bytes from 1 to 1000000')
    }
    expect(listing(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(WINDOWS)('a head read elsewhere in the process is refused, not silently skipped', () => {
  const root = temporary('head-portable')
  try {
    const error = refusal(() => readPlainFileHead(join(root, 'page.html'), 64))
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toMatch(/only available on Windows/)
    expect(listing(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a head read returns the prefix and the real size, and the full read still refuses the same file', () => {
  const root = temporary('head-prefix')
  const file = join(root, 'large.bin')
  const bytes = Buffer.alloc(2 * MIB, 0x5a)
  bytes[0] = 0x00
  bytes[bytes.length - 1] = 0xa9
  try {
    writeFileSync(file, bytes)
    const before = directorySddl(root)
    const head = readPlainFileHead(file, HEAD)
    expect(head.size).toBe(bytes.length)
    expect(head.bytes.length).toBe(HEAD)
    expect(head.bytes.equals(bytes.subarray(0, HEAD))).toBe(true)
    expect(head.path.toLowerCase().endsWith('large.bin')).toBe(true)
    // A head read is read-only and an ordinary checkout is not private state: nothing about the directory changes.
    expect(directorySddl(root)).toBe(before)
    // The same file through the full read is refused, which is exactly the tooBig signal the head read replaces.
    const refused = refusal(() => readPlainFile(file, HEAD))
    expect(refused.code).toBe('TOOLARGE')
    expect(refused.message).toBe('file is larger than the configured limit')
    // The full read still works up to its own limit, so the head read did not widen or replace it.
    expect(Buffer.compare(readPlainFile(file, 32 * MIB).bytes, bytes)).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a head read of a file above the full read limit reports its size without allocating it', () => {
  const root = temporary('head-giant')
  const file = join(root, 'giant.bin')
  const giant = 33 * MIB
  try {
    // A hole is not an allocation: the fixture is 33 MiB long without this process ever holding 33 MiB.
    const handle = openSync(file, 'w')
    try {
      ftruncateSync(handle, giant)
    } finally {
      closeSync(handle)
    }
    const head = readPlainFileHead(file, 16)
    expect(head.size).toBe(giant)
    expect(head.bytes.length).toBe(16)
    expect(head.bytes.equals(Buffer.alloc(16))).toBe(true)
    const refused = refusal(() => readPlainFile(file, 32 * MIB))
    expect(refused.code).toBe('TOOLARGE')
    expect(refused.message).toBe('file is larger than the configured limit')
    expect(statSync(file).size).toBe(giant)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a head read of an empty file returns no bytes and a size of zero', () => {
  const root = temporary('head-empty')
  const file = join(root, 'empty.bin')
  try {
    writeFileSync(file, Buffer.alloc(0))
    const head = readPlainFileHead(file, HEAD)
    expect(head.size).toBe(0)
    expect(head.bytes.length).toBe(0)
    expect(head.path.toLowerCase().endsWith('empty.bin')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!WINDOWS)('a head read refuses a second link, a reparse-point ancestor, an alternate stream and a device name', () => {
  // Each of these is a way for the name to stop meaning the object that was checked: a hardlink can be rewritten from
  // elsewhere, a reparse point redirects an ancestor, and a stream or device name is a second object under one path.
  const root = temporary('head-refusal')
  const file = join(root, 'page.html')
  const other = join(root, 'other.txt')
  const real = join(root, 'real')
  const link = join(root, 'link')
  try {
    mkdirSync(real)
    writeFileSync(file, 'original')
    writeFileSync(join(real, 'inside.html'), 'inside')
    linkSync(file, other)
    ps(`New-Item -ItemType Junction -Path ${q(link)} -Target ${q(real)} | Out-Null`)
    for (const [path, message] of [
      [other, /has more than one link/],
      [join(link, 'inside.html'), /reparse point/],
      [`${file}:stream`, /alternate data streams/],
      [join(root, 'CON'), /reserved device names/],
    ] as const) {
      const error = refusal(() => readPlainFileHead(path, 64))
      expect(error.code).toBe('UNSAFE')
      expect(error.message).toMatch(message)
    }
    expect(readFileSync(file, 'utf8')).toBe('original')
    expect(readFileSync(join(real, 'inside.html'), 'utf8')).toBe('inside')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The helper re-reads identity, link count and size after the prefix read and refuses `file changed while being read`.
// Hitting that needs a pause between the read and the check, and the helper deliberately has none, so this stays
// unproven instead of being faked with a mock handle.
test.todo('UNVERIFIED: a head read is refused when the file changes under the handle')
