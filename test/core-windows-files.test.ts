import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorktree } from '../helper/core-worktree.ts'
import { includeStagePath, seedWorktreeIncludes } from '../helper/core-worktree-includes.ts'
import { publishPlainFile } from '../server/core/windows-security.ts'

// Real Windows file-system evidence for the ordinary worktree reader and include publication. These run only on a
// Windows machine: the POSIX runner has no drive letters, junctions, ADS or case-folded paths to check.
const WINDOWS = process.platform === 'win32'

function repository(root: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@localhost', GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@localhost' }
  const git = (...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd: root, env }); if (result.exitCode) throw Error(result.stderr.toString()) }
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, '.gitignore'), '*.local\n'); writeFileSync(join(root, 'tracked.txt'), 'base\n')
  git('add', '.'); git('commit', '-m', 'base')
  return git
}

test.skipIf(!WINDOWS)('a worktree file over 32 MiB is read as one bounded prefix with its real size', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep 文件-'))
  try {
    repository(root)
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(34_000_000))
    const read = (await readWorktree({ folder: root, base: 'main', branch: 'main', what: 'file', path: 'large.txt' })) as { size: number; tooBig?: boolean; text?: string }
    expect(read).toMatchObject({ size: 34_000_000, tooBig: true })
    expect(read.text?.length).toBe(1_000_000)
    // The same file through the other drive case and separator form is still the same object.
    const slashed = root.replaceAll('\\', '/'), folded = slashed[0]!.toLowerCase() + slashed.slice(1)
    expect(await readWorktree({ folder: folded, base: 'main', branch: 'main', what: 'file', path: 'large.txt' })).toMatchObject({ size: 34_000_000 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('publishing an include never replaces a task file and refuses a name Windows would reinterpret', () => {
  const root = mkdtempSync(join(tmpdir(), 'shep 发布-'))
  try {
    const directory = join(root, 'checkout with space')
    mkdirSync(directory)
    publishPlainFile(directory, 'proof.local', Buffer.from('first bytes'))
    expect(() => publishPlainFile(directory, 'proof.local', Buffer.from('second bytes'))).toThrow()
    expect(readFileSync(join(directory, 'proof.local'), 'utf8')).toBe('first bytes')
    // Everything besides the published file is gone: a refused publish leaves no temporary behind.
    expect(readdirSync(directory)).toEqual(['proof.local'])
    for (const leaf of ['NUL', 'name.', 'name ', 'a:b', 'CON.txt']) expect(() => publishPlainFile(directory, leaf, Buffer.from('x'))).toThrow()
    expect(readdirSync(directory)).toEqual(['proof.local'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('an include stage without a private DACL is refused and its data is left untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep 暂存-')), repo = join(root, 'repo'), folder = join(root, 'task')
  try {
    mkdirSync(repo)
    const git = repository(repo)
    git('worktree', 'add', '-b', 'work/proof', folder)
    writeFileSync(join(repo, '.worktreeinclude'), '*.local\n'); writeFileSync(join(repo, 'proof.local'), 'synthetic config')
    const stage = includeStagePath(repo, folder), leftover = join(stage, '33333333-3333-4333-8333-333333333333')
    mkdirSync(stage) // An ordinary directory: its inherited DACL is not the private state this code owns.
    writeFileSync(leftover, 'staged bytes')
    await expect(seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).rejects.toThrow()
    expect(readFileSync(leftover, 'utf8')).toBe('staged bytes')
    expect(existsSync(join(folder, 'proof.local'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
