import { expect, test } from 'bun:test'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { includeStagePath, seedWorktreeIncludes } from '../helper/core-worktree-includes.ts'

const WINDOWS = process.platform === 'win32'

/** Create a junction, or report that this account could not: the caller then states what it did not prove. */
function junction(link: string, target: string) {
  const made = Bun.spawnSync(['cmd', '/c', 'mklink', '/J', link, target], { stdin: 'ignore' })
  return made.exitCode === 0 ? undefined : made.stderr.toString()
}

async function fixture(run: (f: { repo: string; folder: string; root: string; git: (cwd: string, ...args: string[]) => void }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'shep-includes-')), repo = join(root, 'repo'), folder = join(root, 'task')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@localhost', GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@localhost' }
  const git = (cwd: string, ...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd, env }); if (result.exitCode) throw Error(result.stderr.toString()) }
  mkdirSync(repo); git(repo, 'init', '--initial-branch=main')
  writeFileSync(join(repo, '.gitignore'), '*.local\n'); writeFileSync(join(repo, 'tracked.txt'), 'base')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base'); git(repo, 'worktree', 'add', '-b', 'work/proof', folder)
  try { await run({ repo, folder, root, git }) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('Git include syntax copies ignored nested files, honors exclusions, and never replaces existing task bytes', () => fixture(async ({ repo, folder }) => {
  mkdirSync(join(repo, 'config'))
  writeFileSync(join(repo, '.worktreeinclude'), '# project-local config\nconfig/*.local\n!config/skip.local\ntracked.txt\nuntracked.txt\n')
  writeFileSync(join(repo, 'config/proof.local'), 'synthetic config')
  writeFileSync(join(repo, 'config/skip.local'), 'excluded fixture')
  writeFileSync(join(repo, 'untracked.txt'), 'not ignored')
  expect(await seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).toEqual({ copied: 1 })
  expect(readFileSync(join(folder, 'config/proof.local'), 'utf8')).toBe('synthetic config')
  expect(existsSync(join(folder, 'config/skip.local'))).toBe(false)
  expect(existsSync(join(folder, 'untracked.txt'))).toBe(false)
  expect(readFileSync(join(folder, 'tracked.txt'), 'utf8')).toBe('base')
  writeFileSync(join(folder, 'config/proof.local'), 'unfinished task config')
  expect(await seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).toEqual({ copied: 0 })
  expect(readFileSync(join(folder, 'config/proof.local'), 'utf8')).toBe('unfinished task config')
}))

test('include selection cannot follow file/directory links or hardlinks outside the project', () => fixture(async ({ repo, folder, root }) => {
  writeFileSync(join(repo, '.worktreeinclude'), '*.local\n')
  writeFileSync(join(root, 'outside'), 'outside fixture')
  // Windows needs Developer Mode (or elevation) for a file symlink; report that instead of failing the run.
  let linked = true
  try { symlinkSync(join(root, 'outside'), join(repo, 'linked.local')) } catch (error) {
    if (!WINDOWS || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    linked = false
    console.log('UNVERIFIED symlink: this Windows account cannot create a file symlink, so the symlink refusal was not exercised')
  }
  if (linked) {
    await expect(seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).rejects.toThrow('plain files')
    expect(existsSync(join(folder, 'linked.local'))).toBe(false)
    rmSync(join(repo, 'linked.local'))
  }
  linkSync(join(root, 'outside'), join(repo, 'linked.local'))
  await expect(seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).rejects.toThrow('plain files')
  expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('outside fixture')
}))

test('a task base with different ignore rules and the wrong checkout identity refuse before copying', () => fixture(async ({ repo, folder }) => {
  writeFileSync(join(repo, '.worktreeinclude'), '*.local\n'); writeFileSync(join(repo, 'proof.local'), 'synthetic config')
  await expect(seedWorktreeIncludes({ repo, folder, branch: 'wrong' })).rejects.toThrow('identity')
  writeFileSync(join(folder, '.gitignore'), '')
  await expect(seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).rejects.toThrow('not ignored')
  expect(existsSync(join(folder, 'proof.local'))).toBe(false)
}))

test('without an include file nothing is copied; rule symlinks are explicit refusals', () => fixture(async ({ repo, folder, root }) => {
  writeFileSync(join(repo, 'proof.local'), 'synthetic config')
  expect(await seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).toEqual({ copied: 0 })
  writeFileSync(join(root, 'rules'), '*.local\n')
  try { symlinkSync(join(root, 'rules'), join(repo, '.worktreeinclude')) } catch (error) {
    if (!WINDOWS || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    console.log('UNVERIFIED symlink: this Windows account cannot create a file symlink, so the rule-symlink refusal was not exercised')
    return
  }
  await expect(seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).rejects.toThrow('plain .worktreeinclude')
  expect(existsSync(join(folder, 'proof.local'))).toBe(false)
}))


test.skipIf(WINDOWS || process.getuid?.() === 0)('failed destination publication leaves no partial target; a later retry copies the whole file', () => fixture(async ({ repo, folder }) => {
  writeFileSync(join(repo, '.worktreeinclude'), '*.local\n'); writeFileSync(join(repo, 'proof.local'), 'whole synthetic config')
  chmodSync(folder, 0o500)
  try { await expect(seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).rejects.toThrow() }
  finally { chmodSync(folder, 0o700) }
  expect(existsSync(join(folder, 'proof.local'))).toBe(false)
  expect(await seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).toEqual({ copied: 1 })
  expect(readFileSync(join(folder, 'proof.local'), 'utf8')).toBe('whole synthetic config')
}))


test.skipIf(WINDOWS)('interrupted atomic publication removes only its private alias and restores a single-link task file', () => fixture(async ({ repo, folder }) => {
  const stage = includeStagePath(repo, folder), temporary = join(stage, '11111111-1111-4111-8111-111111111111')
  mkdirSync(stage, { mode: 0o700 }); writeFileSync(temporary, 'whole synthetic config', { mode: 0o600 })
  linkSync(temporary, join(folder, 'proof.local'))
  // No rule file remains: repair still runs before treating the next start as seeded.
  expect(await seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).toEqual({ copied: 0 })
  expect(readFileSync(join(folder, 'proof.local'), 'utf8')).toBe('whole synthetic config')
  expect((await import('node:fs')).lstatSync(join(folder, 'proof.local')).nlink).toBe(1)
  expect(existsSync(temporary)).toBe(false)
}))

test.skipIf(!WINDOWS)('Windows staging is a private folder whose leftover publication is repaired, and foreign data is never removed', () => fixture(async ({ repo, folder }) => {
  const { createPrivateDirectory, writePrivateFile } = await import('../server/core/windows-security.ts')
  const stage = includeStagePath(repo, folder), temporary = join(stage, '22222222-2222-4222-8222-222222222222')
  createPrivateDirectory(stage)
  writePrivateFile(temporary, 'whole synthetic config')
  writeFileSync(join(folder, 'proof.local'), 'whole synthetic config')
  // No rule file remains: repair still runs before treating the next start as seeded.
  expect(await seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).toEqual({ copied: 0 })
  expect(existsSync(temporary)).toBe(false)
  expect(existsSync(stage)).toBe(false)
  expect(readFileSync(join(folder, 'proof.local'), 'utf8')).toBe('whole synthetic config')
  // A stage name this code did not create is left exactly where it is, and nothing is copied past it.
  writeFileSync(join(repo, '.worktreeinclude'), '*.local\n'); writeFileSync(join(repo, 'proof.local'), 'synthetic config')
  createPrivateDirectory(stage)
  writePrivateFile(join(stage, 'not-ours.txt'), 'foreign staged bytes')
  await expect(seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).rejects.toThrow('Unrecognized worktree include staging')
  expect(readFileSync(join(stage, 'not-ours.txt'), 'utf8')).toBe('foreign staged bytes')
  expect(readFileSync(join(folder, 'proof.local'), 'utf8')).toBe('whole synthetic config')
}))

test.skipIf(!WINDOWS)('a task folder reached through a junction is refused as a separate checkout', () => fixture(async ({ repo, root, folder }) => {
  writeFileSync(join(repo, '.worktreeinclude'), '*.local\n'); writeFileSync(join(repo, 'proof.local'), 'synthetic config')
  const linked = join(root, 'task-link')
  const problem = junction(linked, folder)
  if (problem) { console.log('UNVERIFIED junction: this account could not create a junction: ' + problem); return }
  await expect(seedWorktreeIncludes({ repo, folder: linked, branch: 'work/proof' })).rejects.toThrow('separate checkouts')
  expect(existsSync(join(folder, 'proof.local'))).toBe(false)
}))

test.skipIf(!WINDOWS)('an include is published on the task volume when the repository sits on another', async () => {
  // UNVERIFIED without a second volume: say so instead of pretending the cross-volume case ran.
  const other = process.env.SHEPHERDR_SECOND_VOLUME
  if (!other || !existsSync(other)) {
    console.log('UNVERIFIED second volume: set SHEPHERDR_SECOND_VOLUME to a folder on another volume to exercise the cross-volume stage')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'shep-includes-cross-')), repo = mkdtempSync(join(other, 'shep-includes-repo-')), folder = join(root, 'task')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@localhost', GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@localhost' }
  const git = (cwd: string, ...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd, env }); if (result.exitCode) throw Error(result.stderr.toString()) }
  try {
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, '.gitignore'), '*.local\n'); writeFileSync(join(repo, 'tracked.txt'), 'base')
    writeFileSync(join(repo, '.worktreeinclude'), '*.local\n'); writeFileSync(join(repo, 'proof.local'), 'synthetic config')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base'); git(repo, 'worktree', 'add', '-b', 'work/proof', folder)
    expect(await seedWorktreeIncludes({ repo, folder, branch: 'work/proof' })).toEqual({ copied: 1 })
    expect(readFileSync(join(folder, 'proof.local'), 'utf8')).toBe('synthetic config')
    expect(existsSync(includeStagePath(repo, folder))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }) }
})
