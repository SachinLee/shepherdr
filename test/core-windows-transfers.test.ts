// Windows attachment/artifact transfers: real private state and real repository files on Windows, plus a small
// injected platform/io seam for the portable branch wiring. AGENTS.md forbids running tests on this machine; CI runs
// them. Nothing here mocks an ACL or a handle: fakeWindowsFiles only records which write went where, while every real
// Windows case opens the real object through the shipped helper.
import { expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { CoreSource } from '../server/core/source.ts'
import { CoreChat } from '../server/core/chat.ts'
import { CoreArtifacts } from '../server/core/artifacts.ts'
import { preparePrivateDirectory, readPlainFile, readPrivateFileBytes, WindowsSecurityError, writePrivateFile, type WindowsFiles } from '../server/core/windows-security.ts'
import type { CoreAgent, CoreSpace } from '../server/core/model.ts'

const WINDOWS = process.platform === 'win32'
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const MIB = 1024 * 1024

function temporary(name: string): string {
  return mkdtempSync(join(tmpdir(), `shep-${name}-`))
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

function ps(command: string): string {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`PowerShell failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A PowerShell single-quoted literal: no `$`, backtick or backslash is interpreted, and a quote doubles. */
function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The seam the Windows branch of CoreChat/CoreArtifacts talks to: the same method names over a real temporary tree.
 * This is branch wiring only, never OS security: it proves which call went where, and every real Windows case below
 * opens the real object through the shipped helper instead.
 */
function fakeWindowsFiles() {
  const calls: string[] = []
  const files: WindowsFiles = {
    preparePrivateDirectory(path) {
      calls.push(`prepare:${path}`)
      mkdirSync(path, { recursive: true })
    },
    readPrivateFileBytes(path, max = 16 * MIB) {
      calls.push(`read:${path}`)
      const bytes = readFileSync(path)
      if (bytes.length > max) throw new WindowsSecurityError('TOOLARGE', 'file is larger than the configured limit')
      return bytes
    },
    readPlainFile(path, max) {
      calls.push(`plain:${path}`)
      // A Windows-spelled path reaches this seam even in a POSIX test process; both filesystems accept forward slashes.
      const file = path.replace(/\\/g, '/'), bytes = readFileSync(file)
      if (bytes.length > max) throw new WindowsSecurityError('TOOLARGE', 'file is larger than the configured limit')
      return { path: realpathSync.native(file), bytes }
    },
    writePrivateFile(path, data, options) {
      calls.push(`write:${path}`)
      writeFileSync(path, data, { flag: options?.exclusive ? 'wx' : 'w' })
    },
  }
  return { calls, files }
}

async function fixture(run: (source: CoreSource, agent: CoreAgent, root: string, workspace: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'shep-transfers-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  // A real home with a space and non-ASCII text: every path the helper is handed goes through this name.
  const source = new CoreSource({ home: join(root, 'app 数据 目录'), port: 17887, session: 'test', socket: '/unused', binary: 'hc' })
  const space = { id: 'p:local:one', name: 'one', machine: source.localMachineId(), folder: workspace, base: 'main', prefix: 'ONE', mode: 'regular', added: 1 } as CoreSpace
  const agent: CoreAgent = { chat: space.id, space: space.id, machine: space.machine, role: 'coordinator', kind: 'claude', launch: 'launch', grant: 'grant', hook: '/unused', started: 1, state: 'idle' }
  agent.grant = source.mailbox.issue(agent.chat, agent.launch, agent.machine, ['artifact']).id
  source.agents.terminal = (() => ({ state: 'live', pid: 123 })) as unknown as typeof source.agents.terminal
  source.store.set('space', space.id, space); source.store.set('agent', agent.chat, agent)
  try { await run(source, agent, root, workspace) }
  finally { source.stop(); source.mailbox.close(); source.store.close(); rmSync(root, { recursive: true, force: true }) }
}

/** A checker that produces real screenshot files, so publication can export them. */
function shots(artifacts: CoreArtifacts, root: string) {
  const light = join(root, 'light.png'), dark = join(root, 'dark.png')
  writeFileSync(light, 'test picture'); writeFileSync(dark, 'test picture dark')
  artifacts.checker = async () => ({ errors: [], warnings: [], shots: { light, dark } })
}

// ---------------------------------------------------------------------------------------------------------------------
// Portable branch wiring: an injected host and io seam, no ACLs, runs on every platform.

test('a Windows chat upload goes through the private helper, keeps binary bytes and refuses oversize before any file work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-transfer-chat-'))
  // A home whose name holds a space and non-ASCII text: every upload path is handed to the helper under it.
  const source = new CoreSource({ home: join(root, 'app 数据 目录'), port: 17887, session: 'test', socket: '/unused', binary: 'hc' })
  const space = { id: 'p:any:~', machine: 'remote', name: '~', home: true, folder: root, base: 'main', prefix: 'TASK', mode: 'regular', added: 1 } as CoreSpace
  source.store.set('space', space.id, space)
  const { calls, files } = fakeWindowsFiles()
  try {
    const chat = new CoreChat(source, 'installation', 'win32', files), directory = join(source.config.home, 'uploads')
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41])
    const path = await chat.upload(space.id, 'proof.bin', bytes)
    expect(calls).toEqual([`prepare:${directory}`, `write:${path}`])
    const blob = (await chat.attachment(space.id, path))!
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes)
    // The type comes from the name this app stored, without a second look at the path.
    expect(blob.type).toBe('application/octet-stream')
    expect(calls.at(-1)).toBe(`read:${path}`)
    await expect(chat.upload(space.id, 'big.bin', Buffer.alloc(32 * MIB + 1))).rejects.toThrow('too large')
    expect(calls).toHaveLength(3)
    for (const name of ['../proof.bin', 'folder\\proof.bin', 'proof.bin:secret', 'proof.bin.', 'proof.bin ', 'CON', 'nul.txt', 'COM¹.log']) {
      await expect(chat.upload(space.id, name, bytes)).rejects.toThrow('valid Windows file name')
    }
    expect(calls).toHaveLength(3)
    // The same class on POSIX writes the file itself and never touches the Windows seam.
    const plain = new CoreChat(source, 'installation', 'linux', files)
    const other = await plain.upload(space.id, 'plain.bin', bytes)
    expect(calls).toHaveLength(3)
    expect(Buffer.from(await (await plain.attachment(space.id, other))!.arrayBuffer())).toEqual(bytes)
  } finally { source.stop(); source.mailbox.close(); source.store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('a Windows artifact read judges the helper\'s canonical path, and a machine that is not local keeps the core script', async () => fixture(async (source, agent, root, workspace) => {
  const { calls, files } = fakeWindowsFiles()
  const artifacts = new CoreArtifacts(source, 'installation', 'win32', files)
  shots(artifacts, root)
  writeFileSync(join(workspace, 'page.html'), '<p>First</p>')
  const cwd = workspace, home = source.config.home
  await artifacts.cli(agent, ['artifact', 'new', 'page.html', '--title', 'Example'], cwd)
  expect(calls).toContain(`plain:${join(workspace, 'page.html')}`)
  expect(calls.some(call => call.startsWith(`prepare:${join(home, 'exports')}`))).toBe(true)
  mkdirSync(join(home, 'vault'), { recursive: true })
  writeFileSync(join(home, 'vault', 'secret.html'), 'SYNTHETIC_PRIVATE_MATERIAL')
  await expect(artifacts.cli(agent, ['artifact', 'new', 'vault/secret.html', '--title', 'Unsafe'], home)).rejects.toThrow('Private files')
  mkdirSync(join(home, 'exports'), { recursive: true })
  writeFileSync(join(home, 'exports', 'kept.html'), '<p>Kept</p>')
  await artifacts.cli(agent, ['artifact', 'new', 'kept.html', '--title', 'Exported'], join(home, 'exports'))
  // The exports exception is a leaf, not a door: a dot-dot spelling back into the home is still private.
  await expect(artifacts.cli(agent, ['artifact', 'new', '../vault/secret.html', '--title', 'Sneaky'], join(home, 'exports'))).rejects.toThrow('Private files')
  // A non-local machine never takes the local Windows I/O: the request still goes through core.
  let core = 0
  source.files.exec = async () => { core++; return Buffer.alloc(0) }
  source.agents.bun = async () => process.execPath
  const route = source.route.bind(source)
  source.route = async machine => (machine === 'remote' ? 'remote' : route(machine))
  const remote = new CoreArtifacts(source, 'installation', 'win32', files)
  await expect(remote.cli({ ...agent, machine: 'remote' }, ['artifact', 'new', 'page.html', '--title', 'Remote'], cwd)).rejects.toThrow('HTML file is empty')
  expect(core).toBe(1)
  // And a POSIX host keeps the core script for a local machine too.
  const posix = new CoreArtifacts(source, 'installation', 'linux', files)
  await expect(posix.cli(agent, ['artifact', 'new', 'page.html', '--title', 'Posix'], cwd)).rejects.toThrow('HTML file is empty')
  expect(core).toBe(2)
  // A machine core does not know is a refusal, not a guess that it speaks POSIX: nothing local and no core run.
  const plainCalls = calls.filter(call => call.startsWith('plain:')).length
  source.route = async () => { throw new Error('This machine is not connected through core') }
  await expect(remote.cli({ ...agent, machine: 'unknown' }, ['artifact', 'new', 'page.html', '--title', 'Unknown'], cwd)).rejects.toThrow('not connected through core')
  expect(core).toBe(2)
  expect(calls.filter(call => call.startsWith('plain:')).length).toBe(plainCalls)
  expect(plainCalls).toBe(4)
}))

// ---------------------------------------------------------------------------------------------------------------------
// Real Windows objects.

test.skipIf(!WINDOWS)('private bytes survive the helper exactly, and the transfer limit is 32 MiB on both sides', () => {
  const root = temporary('win-bytes')
  try {
    const home = join(root, 'home'), file = join(home, 'payload.bin')
    preparePrivateDirectory(home)
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a])
    writePrivateFile(file, bytes)
    expect(readPrivateFileBytes(file)).toEqual(bytes)
    expect(readPrivateFileBytes(file, 32 * MIB)).toEqual(bytes)
    writePrivateFile(join(home, 'empty.bin'), Buffer.alloc(0))
    expect(readPrivateFileBytes(join(home, 'empty.bin'))).toHaveLength(0)
    // 32 MiB is accepted on both sides; 16 MiB is still the default read limit.
    const full = Buffer.alloc(32 * MIB, 9), whole = join(home, 'whole.bin')
    writePrivateFile(whole, full)
    expect(refusal(() => readPrivateFileBytes(whole)).code).toBe('TOOLARGE')
    expect(readPrivateFileBytes(whole, 32 * MIB).length).toBe(full.length)
    // Not just the length: every byte of the 32 MiB answer must be the bytes that were written.
    expect(Buffer.compare(readPrivateFileBytes(whole, 32 * MIB), full)).toBe(0)
    // 32 MiB + 1 is refused, and no other write happens.
    expect(refusal(() => writePrivateFile(join(home, 'over.bin'), Buffer.alloc(32 * MIB + 1))).code).toBe('TOOLARGE')
    expect(existsSync(join(home, 'over.bin'))).toBe(false)
    expect(refusal(() => readPrivateFileBytes(whole, 32 * MIB + 1)).code).toBe('TOOLARGE')
    expect(refusal(() => readPrivateFileBytes(whole, 0)).code).toBe('TOOLARGE')
    expect(refusal(() => readPrivateFileBytes(whole, 1.5)).code).toBe('TOOLARGE')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('an ordinary repository reads through held handles and refuses every alias', () => {
  const root = temporary('win-plain')
  try {
    const repo = join(root, 'repo'), file = join(repo, 'data.bin')
    mkdirSync(repo)
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41])
    writeFileSync(file, bytes)
    // An inherited, wide ACL on the temp tree is fine: a repository file is not private state.
    expect(readPlainFile(file, MIB).bytes).toEqual(bytes)
    expect(readPlainFile(file, MIB).path).toMatch(/data\.bin$/i)
    // A real repository name may hold spaces and non-ASCII text; the bytes and the canonical path still come back.
    const spaced = join(root, 'repo with space 中文')
    mkdirSync(spaced)
    writeFileSync(join(spaced, '数据 file.bin'), bytes)
    expect(readPlainFile(join(spaced, '数据 file.bin'), MIB).bytes).toEqual(bytes)
    expect(readPlainFile(join(spaced, '数据 file.bin'), MIB).path).toMatch(/数据 file\.bin$/i)
    writeFileSync(join(repo, 'empty.bin'), Buffer.alloc(0))
    expect(readPlainFile(join(repo, 'empty.bin'), MIB).bytes).toHaveLength(0)
    writeFileSync(join(repo, 'long.bin'), Buffer.alloc(1024))
    expect(refusal(() => readPlainFile(join(repo, 'long.bin'), 1023)).message).toMatch(/larger than the configured limit/)
    expect(refusal(() => readPlainFile(file, 0)).code).toBe('TOOLARGE')
    expect(refusal(() => readPlainFile(file, 32 * MIB + 1)).code).toBe('TOOLARGE')

    // A case-variant spelling is the same object; the answer carries the real, canonical name.
    expect(readPlainFile(file.replace(/\\repo\\/, '\\REPO\\').replace(/\.bin$/, '.BIN'), MIB).path).toMatch(/data\.bin$/i)
    // An 8.3 short name is the same object too: the answer expands it, so an alias cannot hide which file was read.
    const short = ps(`$f=New-Object -ComObject Scripting.FileSystemObject; $f.GetFile(${q(file)}).ShortPath`)
    if (short && short.toLowerCase() !== file.toLowerCase()) expect(readPlainFile(short, MIB).path).toMatch(/data\.bin$/i)
    linkSync(file, join(repo, 'alias.bin'))
    expect(refusal(() => readPlainFile(join(repo, 'alias.bin'), MIB)).message).toMatch(/more than one link/)
    // A junction anywhere in the path is a reparse point and is refused before the leaf is opened.
    ps(`New-Item -ItemType Junction -Path ${q(join(root, 'junction'))} -Target ${q(repo)} | Out-Null`)
    expect(refusal(() => readPlainFile(join(root, 'junction', 'data.bin'), MIB)).message).toMatch(/reparse point/)
    expect(refusal(() => readPlainFile(`${file}:hidden`, MIB)).message).toMatch(/alternate data streams/)
    expect(refusal(() => readPlainFile(join(repo, 'data.bin.'), MIB)).message).toMatch(/trailing dots/)
    expect(refusal(() => readPlainFile(join(repo, 'data.bin '), MIB)).message).toMatch(/trailing dots/)
    expect(refusal(() => readPlainFile(join(repo, 'CON'), MIB)).message).toMatch(/reserved device names/)
    expect(refusal(() => readPlainFile('\\\\server\\share\\file.bin', MIB)).message).toMatch(/UNC/)
    expect(refusal(() => readPlainFile('\\\\?\\C:\\Windows\\win.ini', MIB)).message).toMatch(/network, device and UNC/)
    expect(refusal(() => readPlainFile(join(repo, 'absent.bin'), MIB)).code).toBe('ENOENT')
    expect(existsSync(join(root, 'junction'))).toBe(true)
    // A legal repository on another local fixed volume is readable: the drive letter is not itself a refusal.
    const own = win32.parse(root).root.toLowerCase()
    const volumes = ps(`[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed -and $_.IsReady } | ForEach-Object { $_.Name }`)
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      .filter(volume => win32.parse(volume).root.toLowerCase() !== own)
    let elsewhere: string | undefined
    for (const volume of volumes) {
      try { elsewhere = mkdtempSync(join(volume, 'shep-plain-')); break } catch { continue }
    }
    if (elsewhere) {
      try {
        writeFileSync(join(elsewhere, 'other.bin'), bytes)
        expect(readPlainFile(join(elsewhere, 'other.bin'), MIB).bytes).toEqual(bytes)
      } finally { rmSync(elsewhere, { recursive: true, force: true }) }
    } else {
      // Unverified, not faked: this account has no second writable fixed volume, so cross-drive is not proven here.
      console.log('UNVERIFIED cross-volume: no second writable fixed volume on this machine')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a private directory with a wide ACL is refused, not repaired', () => {
  const root = temporary('win-wide')
  try {
    const home = join(root, 'home')
    mkdirSync(home)
    // .NET rather than Get-Acl/Set-Acl: the security module is not loaded in every session, and this only needs one ACE.
    ps(`$p=${q(home)}; $a=[System.IO.Directory]::GetAccessControl($p); $i=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($i,'Modify','Allow'); $a.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$a)`)
    expect(refusal(() => preparePrivateDirectory(home)).message).toMatch(/another account/)
    expect(refusal(() => writePrivateFile(join(home, 'x'), 'x')).code).toBe('UNSAFE')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a local Windows chat uploads and downloads the same binary bytes and refuses a second link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-win-chat-'))
  const source = new CoreSource({ home: join(root, 'app'), port: 17887, session: 'test', socket: '/unused', binary: 'hc' })
  const space = { id: 'p:local:~', machine: source.localMachineId(), name: '~', home: true, folder: root, base: 'main', prefix: 'TASK', mode: 'regular', added: 1 } as CoreSpace
  source.store.set('space', space.id, space)
  try {
    const chat = new CoreChat(source, 'installation')
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x7f])
    const path = await chat.upload(space.id, 'proof.bin', bytes)
    expect(path.startsWith(join(source.config.home, 'uploads'))).toBe(true)
    expect(Buffer.from(await (await chat.attachment(space.id, path))!.arrayBuffer())).toEqual(bytes)
    // 32 MiB + 1 is refused before any file or directory is created.
    const before = existsSync(join(source.config.home, 'uploads'))
    await expect(chat.upload(space.id, 'big.bin', Buffer.alloc(32 * MIB + 1))).rejects.toThrow('too large')
    expect(existsSync(join(source.config.home, 'uploads'))).toBe(before)
    expect(source.store.all('upload')).toHaveLength(1)
    linkSync(path, join(root, 'alias.bin'))
    await expect(chat.attachment(space.id, path)).rejects.toThrow('regular uploaded file')
    // A record from another chat still does not download.
    expect(await chat.attachment('another-chat', path)).toBeNull()
  } finally { source.stop(); source.mailbox.close(); source.store.close(); rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a local Windows artifact reads repository files, refuses private ones and exports under home', async () => {
  await fixture(async (source, agent, root, workspace) => {
    const artifacts = new CoreArtifacts(source, 'installation')
    shots(artifacts, root)
    writeFileSync(join(workspace, 'page.html'), '<p>First</p>')
    const report = await artifacts.cli(agent, ['artifact', 'new', 'page.html', '--title', 'Example'], workspace)
    const id = artifacts.list()[0].id
    // The path may hold spaces and non-ASCII text, so it runs to the line's " (dark: " marker.
    const exported = /Pictures at phone width: (.+?) \(dark: /.exec(report)![1]
    expect(win32.normalize(exported).startsWith(win32.normalize(join(source.config.home, 'exports') + '\\'))).toBe(true)
    expect(existsSync(exported)).toBe(true)
    // Another export of the same name cannot overwrite the first.
    const second = await artifacts.cli(agent, ['artifact', 'show', id], workspace)
    expect(second).toContain('HTML: ')
    const shown = /HTML: ([^\n]+)/.exec(second)![1]
    expect(existsSync(shown)).toBe(true)
    expect(shown).not.toBe(exported)
    // Private home content stays unreadable as an artifact input, while the exports leaf is a legal source.
    writeFileSync(join(source.config.home, 'vault.txt'), 'SYNTHETIC_PRIVATE_MATERIAL')
    await expect(artifacts.cli(agent, ['artifact', 'new', 'vault.txt', '--title', 'Unsafe'], source.config.home)).rejects.toThrow('Private files')
    await artifacts.cli(agent, ['artifact', 'new', basename(shown), '--title', 'Kept'], join(source.config.home, 'exports'))
  })
})
