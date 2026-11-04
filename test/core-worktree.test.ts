import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, linkSync, unlinkSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { readWorktree } from '../helper/core-worktree.ts'

const WINDOWS = process.platform === 'win32'

// Real scratch Git repositories, run on GitHub only.
test('native worktree files, literal paths, rename diff and path isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-tree-'))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdin: 'ignore' })
    if (result.exitCode) throw Error(result.stderr.toString())
  }
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, 'example.txt'), 'before\n'); writeFileSync(join(root, 'a\tb.txt'), 'before\n'); writeFileSync(join(root, 'original.txt'), 'rename\n'); writeFileSync(join(root, '.gitignore'), '.env\n')
    git('add', '.'); git('commit', '-m', 'baseline'); git('switch', '-c', 'work/example')
    writeFileSync(join(root, 'example.txt'), 'after\n'); writeFileSync(join(root, 'a\tb.txt'), 'after\n'); git('mv', 'original.txt', 'renamed.txt'); writeFileSync(join(root, '[literal].txt'), 'new\n')
    writeFileSync(join(root, '.env'), 'SYNTHETIC_PRIVATE_MATERIAL')
    symlinkSync('.env', join(root, 'alias.txt'))
    symlinkSync('/etc/passwd', join(root, 'outside.txt'))
    linkSync(join(root, '.env'), join(root, 'linked.txt'))
    const ask = { folder: root, base: 'main', branch: 'work/example' }
    expect(await readWorktree({ ...ask, what: 'files' })).toMatchObject({ files: expect.arrayContaining(['example.txt', '[literal].txt']) })
    expect(await readWorktree({ ...ask, what: 'file', path: '[literal].txt' })).toMatchObject({ text: 'new\n' })
    for (const path of ['../secret', '.git/config', '.env', 'alias.txt', 'outside.txt', 'linked.txt']) await expect(readWorktree({ ...ask, what: 'file', path })).rejects.toThrow()
    unlinkSync(join(root, 'linked.txt'))
    expect(await readWorktree({ ...ask, what: 'diff' })).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: 'example.txt', add: 1, del: 1 }), expect.objectContaining({ path: '[literal].txt', add: 1 }), expect.objectContaining({ path: 'a\tb.txt', add: 1, del: 1 }), expect.objectContaining({ path: 'renamed.txt', status: 'renamed', from: 'original.txt' })]) })
    expect(await readWorktree({ ...ask, what: 'patch', path: '[literal].txt' })).toMatchObject({ text: expect.stringContaining('+new') })
    expect(await readWorktree({ ...ask, what: 'pr' })).toMatchObject({ pr: null, why: 'This space has no GitHub remote.' })
    await expect(readWorktree({ ...ask, what: 'patch', path: '.env' })).rejects.toThrow('no changes')
    unlinkSync(join(root, 'example.txt')); linkSync(join(root, '.env'), join(root, 'example.txt'))
    await expect(readWorktree({ ...ask, what: 'file', path: 'example.txt' })).rejects.toThrow()
    await expect(readWorktree({ ...ask, what: 'diff' })).rejects.toThrow('readable boundary')
    await expect(readWorktree({ ...ask, what: 'patch', path: 'example.txt' })).rejects.toThrow('readable boundary')
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('unreadable GitHub checks are not reported as no checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-tree-gh-')), bin = join(root, 'bin')
  mkdirSync(bin)
  const git = (...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd: root, stdin: 'ignore' }); if (result.exitCode) throw Error(result.stderr.toString()) }
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, 'example.txt'), 'example\n'); git('add', '.'); git('commit', '-m', 'baseline'); git('remote', 'add', 'origin', 'https://github.com/example/example.git')
    const gh = join(bin, 'gh')
    const checks = `const args=process.argv.slice(2);if(args.some(word=>word.split(',').includes('headRefOid'))){process.stdout.write(JSON.stringify({number:1,title:'Example',state:'OPEN',isDraft:false,url:'https://github.com/example/example/pull/1',headRefOid:'abc'}))}else{process.stderr.write('not accessible by personal access token');process.exitCode=1}`
    writeFileSync(gh, `#!${process.execPath}\n${checks}`)
    chmodSync(gh, 0o700)
    // Windows resolves an executable through PATHEXT, so the fixture ships a command shim beside the POSIX script.
    writeFileSync(join(bin, 'gh.js'), checks)
    writeFileSync(join(bin, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0gh.js" %*\r\n`)
    const script = 'globalThis.__shepherdrWorktreeEval = true\n' + readFileSync(join(import.meta.dir, '../helper/core-worktree.ts'), 'utf8') + '\nprocess.stdout.write(JSON.stringify(await readWorktree(JSON.parse(await Bun.stdin.text()))))'
    const child = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? '') }, stdin: Buffer.from(JSON.stringify({ folder: root, base: 'main', branch: 'main', what: 'pr' })) })
    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ pr: { checks: [], checksError: 'Could not read GitHub checks.' } })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the worktree helper file answers one {ok, value} or {ok, error} object on stdin', () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-tree-cli-'))
  const helper = join(import.meta.dir, '../helper/core-worktree.ts')
  const git = (...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd: root, stdin: 'ignore' }); if (result.exitCode) throw Error(result.stderr.toString()) }
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, 'example.txt'), 'example\n'); git('add', '.'); git('commit', '-m', 'baseline')
    const ask = { folder: root, base: 'main', branch: 'main', what: 'files' }
    const answered = Bun.spawnSync([process.execPath, helper], { stdin: Buffer.from(JSON.stringify(ask)) })
    expect(answered.exitCode).toBe(0)
    expect(JSON.parse(answered.stdout.toString())).toMatchObject({ ok: true, value: { files: expect.arrayContaining(['example.txt']) } })
    const refused = Bun.spawnSync([process.execPath, helper], { stdin: Buffer.from(JSON.stringify({ ...ask, what: 'file', path: '../escape' })) })
    expect(refused.exitCode).toBe(0)
    expect(JSON.parse(refused.stdout.toString())).toMatchObject({ ok: false, error: expect.any(String) })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('a Windows worktree is read through its real object, never a lowercased path or a link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep 任务-'))
  const git = (...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd: root, stdin: 'ignore' }); if (result.exitCode) throw Error(result.stderr.toString()) }
  const junction = (link: string, target: string) => Bun.spawnSync(['cmd', '/c', 'mklink', '/J', link, target], { stdin: 'ignore' })
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, 'example.txt'), 'before\n'); git('add', '.'); git('commit', '-m', 'baseline'); git('switch', '-c', 'work/例子')
    writeFileSync(join(root, 'example.txt'), 'after\n'); writeFileSync(join(root, 'notes 一.txt'), 'notes\n')
    const ask = { folder: root, base: 'main', branch: 'work/例子' }
    // The saved folder may come back with another drive case and forward slashes; the object identity decides.
    const slashed = root.replaceAll('\\', '/'), folded = slashed[0]!.toLowerCase() + slashed.slice(1)
    expect(await readWorktree({ ...ask, folder: folded, what: 'files' })).toMatchObject({ files: expect.arrayContaining(['example.txt', 'notes 一.txt']) })
    expect(await readWorktree({ ...ask, folder: folderWithSlash(root), what: 'file', path: 'notes 一.txt' })).toMatchObject({ text: 'notes\n' })
    // Names Windows would reinterpret are refused instead of being handed to a lazy open.
    for (const path of ['example.txt:hidden', 'C:example.txt', 'NUL', 'CON.txt', 'example.txt. ', 'example.txt ']) await expect(readWorktree({ ...ask, what: 'file', path })).rejects.toThrow('No such file.')
    for (const path of ['../secret', '.git/config', 'a\\b.txt']) await expect(readWorktree({ ...ask, what: 'file', path })).rejects.toThrow()
    // A large text file keeps the prefix bound and still reports the real object size.
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(1_500_000))
    const large = (await readWorktree({ ...ask, what: 'file', path: 'large.txt' })) as { size: number; tooBig?: boolean; text?: string }
    expect(large).toMatchObject({ size: 1_500_000, tooBig: true })
    expect(large.text?.length).toBe(1_000_000)
    // A junction inside the checkout is refused, never resolved into the folder it redirects to.
    mkdirSync(join(root, 'real-dir')); writeFileSync(join(root, 'real-dir', 'secret.txt'), 'secret\n')
    const made = junction(join(root, 'joined'), join(root, 'real-dir'))
    if (made.exitCode) console.log('UNVERIFIED junction: this account could not create a junction: ' + made.stderr.toString())
    else await expect(readWorktree({ ...ask, what: 'file', path: 'joined/secret.txt' })).rejects.toThrow('No such file.')
    // A hardlinked file is listed by Git but must not be read through a second name.
    writeFileSync(join(root, 'copy.txt'), 'one name\n'); linkSync(join(root, 'copy.txt'), join(root, 'second.txt'))
    await expect(readWorktree({ ...ask, what: 'file', path: 'second.txt' })).rejects.toThrow('No such file.')
    await expect(readWorktree({ ...ask, what: 'diff' })).rejects.toThrow('readable boundary')
    expect(readFileSync(join(root, 'copy.txt'), 'utf8')).toBe('one name\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/** The same Windows folder with a trailing separator, which join() would otherwise fold away. */
function folderWithSlash(folder: string) { return folder + '\\' }

test('contained file and diff panels use checked Git without executing host callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-tree-checked-'))
  const git = (...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { cwd: root }); if (p.exitCode) throw Error(p.stderr.toString()) }
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, '[literal].txt'), 'before\n'); git('add', '.'); git('commit', '-m', 'Base')
    writeFileSync(join(root, '[literal].txt'), 'after\n')
    const marker = join(root, 'executed'), callback = join(root, 'callback')
    writeFileSync(callback, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o700 })
    git('config', 'core.fsmonitor', callback)
    const checked = { repo: root, writableRoots: [root], bun: process.execPath, helper: join(import.meta.dir, '../helper/core-pilot-git.ts') }
    const ask = { folder: root, base: 'main', branch: 'main', checked }
    expect(await readWorktree({ ...ask, what: 'file', path: '[literal].txt' })).toMatchObject({ text: 'after\n' })
    expect(await readWorktree({ ...ask, what: 'patch', path: '[literal].txt' })).toMatchObject({ text: expect.stringContaining('+after') })
    expect(await Bun.file(marker).exists()).toBe(false)
    git('config', 'include.path', '../not-created.cfg')
    await expect(readWorktree({ ...ask, what: 'files' })).rejects.toThrow('no longer available')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
