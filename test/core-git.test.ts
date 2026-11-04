import { expect, test } from 'bun:test'
import { CoreGit, githubRemote } from '../server/core/git.ts'
import type { CoreFiles } from '../server/core/files.ts'
import { pathRelation, samePath, worktreeEntries } from '../server/core/repository-paths.ts'

test('GitHub remote forms retain their explicit host including legacy enterprise and rewritten hosts', () => {
  for (const url of ['git@github.company.test:owner/repo.git', 'ssh://git@github.company.test:2222/owner/repo.git', 'https://github.company.test/owner/repo.git/']) expect(githubRemote(url)).toBe('github.company.test/owner/repo')
  expect(githubRemote('http://github.localhost/owner/repo.git')).toBe('github.localhost/owner/repo')
  expect(githubRemote('/tmp/local.git')).toBeUndefined()
  expect(githubRemote('https://gitlab.com/owner/repo')).toBeUndefined()
})

test('GitHub routing checks effective and written origin and refuses uncertain reads before local fallback', async () => {
  let used = 'git@ssh-alias:owner/repo.git', written = 'https://github.com/owner/repo.git', fail = false, origin = true
  const calls: string[][] = []
  const files = { exec: async (_machine: string, argv: string[]) => {
    calls.push(argv)
    if (argv[1] === 'remote' && argv.length === 2) return Buffer.from(origin ? 'origin\n' : '')
    if (fail) throw Error('Core machine disconnected')
    if (argv[1] === 'remote') return Buffer.from(used)
    if (argv[1] === 'config') return Buffer.from(written)
    if (argv[0] === 'gh') return Buffer.from('{}')
    throw Error('Unexpected command')
  } } as unknown as CoreFiles
  const git = new CoreGit(files), repo = { machine: 'remote', folder: '/repo' }
  expect(await git.remote(repo)).toBe('github.com/owner/repo')
  used = 'http://github.localhost/owner/repo.git'
  expect(await git.remote(repo)).toBe('github.localhost/owner/repo')
  await git.pullRequest(repo, 'work/one')
  expect(calls.at(-1)).toContain('--repo')
  expect(calls.at(-1)).toContain('github.localhost/owner/repo')
  fail = true
  await expect(git.remote(repo)).rejects.toThrow('Core machine disconnected')
  fail = false; origin = false
  expect(await git.remote(repo)).toBeUndefined()
})

test('reopening a task checkout checks the saved branch/location and preserves occupied paths', async () => {
  let listing = 'worktree /tasks/one\nbranch refs/heads/work/one', branch = true
  const calls: string[][] = []
  const git = new CoreGit({ exec: async (_machine: string, argv: string[]) => {
    calls.push(argv)
    if (argv[1] === 'worktree' && argv[2] === 'list') return Buffer.from(listing)
    if (argv[1] === 'symbolic-ref') return Buffer.from('refs/heads/work/one')
    if (argv[1] === 'for-each-ref') return Buffer.from(branch ? 'refs/heads/work/one ' + 'a'.repeat(40) : '')
    if (argv[1] === 'rev-parse') return Buffer.from('a'.repeat(40))
    if (argv[1] === 'worktree' && argv[2] === 'add') return Buffer.alloc(0)
    throw Error('Unexpected command')
  } } as unknown as CoreFiles)
  const repo = { machine: 'remote', folder: '/repo' }
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.some(args => args.includes('add'))).toBe(false)
  listing = 'worktree /tasks/one\nbranch refs/heads/other'
  await expect(git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')).rejects.toThrow('another branch')
  listing = 'worktree /tasks/elsewhere\nbranch refs/heads/work/one'
  await expect(git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')).rejects.toThrow('elsewhere')
  listing = ''
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.at(-1)).toEqual(['git', 'worktree', 'add', '/tasks/one', 'work/one'])
  branch = false
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.at(-1)).toEqual(['git', 'worktree', 'add', '-b', 'work/one', '/tasks/one', 'main'])
})

test('native path comparison folds Windows case, separators and trailing dots but refuses unclear forms', () => {
  expect(samePath('C:\\Work\\项目 一', 'c:/work/项目 一/')).toBe(true)
  expect(samePath('C:\\Work\\项目 一.', 'C:\\work\\项目 一')).toBe(true)
  expect(samePath('C:\\Work\\One', 'C:\\Work\\Oneed')).toBe(false)
  expect(samePath('/tasks/one', '/tasks/one/')).toBe(true)
  expect(samePath('/tasks/one', 'C:\\tasks\\one')).toBe(false)
  expect(pathRelation('C:\\Work\\One', 'c:/work/one/sub/file.txt')).toBe('inside')
  expect(pathRelation('C:\\Work\\One', 'D:\\Work\\One')).toBe('outside')
  expect(pathRelation('C:\\Work\\One', '\\\\?\\C:\\Work\\One\\file.txt')).toBe('unknown')
  expect(pathRelation('C:\\Work\\One', 'C:work\\one')).toBe('unknown')
  expect(pathRelation('work/one', 'work/one/sub')).toBe('unknown')
  expect(pathRelation('C:\\Work\\One', 'C:\\Work\\One\\bad:*')).toBe('unknown')
  expect(worktreeEntries('worktree D:/任务 一/w\0HEAD ' + 'a'.repeat(40) + '\0branch refs/heads/w\0\0')).toEqual([
    { path: 'D:/任务 一/w', head: 'a'.repeat(40), branch: 'refs/heads/w', bare: false, detached: false, locked: false, prunable: false },
  ])
})

test('a saved Windows folder matches a -z worktree listing through separators, drive case and a non-ASCII name', async () => {
  const sha = 'a'.repeat(40), ref = 'refs/heads/work/1-例子', calls: string[][] = []
  let listing = ''
  const git = new CoreGit({ exec: async (_machine: string, argv: string[]) => {
    calls.push(argv)
    if (argv[1] === 'worktree' && argv[2] === 'list') return Buffer.from(listing)
    if (argv[1] === 'symbolic-ref') return Buffer.from(ref)
    if (argv[1] === 'for-each-ref') return Buffer.from(`${ref} ${sha}`)
    if (argv[1] === 'rev-parse') return Buffer.from(sha)
    if (argv[1] === 'worktree' && argv[2] === 'add') return Buffer.alloc(0)
    throw Error('Unexpected command')
  } } as unknown as CoreFiles)
  const repo = { machine: 'local', folder: 'D:\\repos\\项目 一\\repo' }, folder = 'd:\\REPOS\\项目 一\\repo\\work\\1-例子'
  const entry = (path: string) => `worktree ${path}\0HEAD ${sha}\0branch ${ref}\0\0`
  // Git prints `/` and keeps the on-disk drive case; the saved folder came from another call with another case.
  listing = entry('D:/repos/项目 一/repo/work/1-例子')
  await git.ensureWorktree(repo, folder, 'work/1-例子', 'main')
  expect(calls.some(args => args.includes('add'))).toBe(false)
  expect(calls.find(args => args.includes('--porcelain'))).toContain('-z')
  // The same checkout listed twice is not a folder this code can act on.
  listing += entry('d:/repos/项目 一/repo/work/1-例子')
  await expect(git.ensureWorktree(repo, folder, 'work/1-例子', 'main')).rejects.toThrow('listed more than once')
  // A device or otherwise uncomparable form is refused instead of read as "not this checkout".
  listing = entry('\\\\?\\D:\\repos\\项目 一\\repo\\work\\1-例子')
  await expect(git.ensureWorktree(repo, folder, 'work/1-例子', 'main')).rejects.toThrow('could not be compared')
  // The branch still belongs to a checkout this task may not take over.
  listing = entry('D:/repos/项目 一/repo/work/2-别的')
  await expect(git.ensureWorktree(repo, folder, 'work/1-例子', 'main')).rejects.toThrow('checked out elsewhere')
  expect(calls.some(args => args.includes('add'))).toBe(false)
})

test('basic PR identity omits restricted checks and open lookup refuses ambiguous or failed snapshots', async () => {
  let rows: unknown = [], fail = false
  const calls: string[][] = [], git = new CoreGit({} as CoreFiles), repo = { machine: 'remote', folder: '/repo' }
  git.remote = async () => 'github.test/o/r'
  git.gh = async (_repo, args) => { calls.push(args); if (fail) throw Error('GitHub unavailable'); return (args[1] === 'list' ? rows : { number: 1 }) as never }
  await git.pullRequest(repo, 'work/one', false)
  expect(calls.at(-1)?.at(-1)).not.toContain('statusCheckRollup')
  await git.pullRequest(repo, 'work/one')
  expect(calls.at(-1)?.at(-1)).toContain('statusCheckRollup')
  expect(await git.findPullRequest(repo, 'work/one', 'main')).toBeUndefined()
  rows = [{ number: 1, headRefName: 'work/one', baseRefName: 'main' }, { number: 2, headRefName: 'work/one', baseRefName: 'main' }]
  await expect(git.findPullRequest(repo, 'work/one', 'main')).rejects.toThrow('unambiguous')
  fail = true
  await expect(git.findPullRequest(repo, 'work/one', 'main')).rejects.toThrow('GitHub unavailable')
})

test('a lost push reply only settles when the remote confirms the exact captured task commit', async () => {
  const sha = 'a'.repeat(40), ref = 'refs/heads/work/one', calls: string[][] = [], git = new CoreGit({} as CoreFiles)
  let confirmed = true
  git.run = async (_repo, args) => { calls.push(args); if (args[0] === 'symbolic-ref') return ref; if (args[0] === 'rev-parse') return sha; if (args[0] === 'push') throw Error('Reply lost'); if (args[0] === 'ls-remote') return `${confirmed ? sha : 'b'.repeat(40)}\t${ref}`; throw Error('Unexpected command') }
  expect(await git.pushTaskBranch({ machine: 'machine', folder: '/work' }, 'work/one', 'c'.repeat(40))).toBe(sha)
  expect(calls.find(args => args[0] === 'push')).toEqual(['push', '--force-with-lease=refs/heads/work/one:' + 'c'.repeat(40), 'origin', `${sha}:${ref}`])
  confirmed = false
  await expect(git.pushTaskBranch({ machine: 'machine', folder: '/work' }, 'work/one', 'c'.repeat(40))).rejects.toThrow('Reply lost')
})

test('a checkout switch cannot change the task ref whose captured commit is pushed', async () => {
  const saved = 'a'.repeat(40), other = 'b'.repeat(40), ref = 'refs/heads/work/one', git = new CoreGit({} as CoreFiles), pushes: string[][] = []
  git.run = async (_repo, args) => {
    if (args[0] === 'symbolic-ref') return ref // Immediately afterward another caller switches HEAD.
    if (args[0] === 'rev-parse') return args.at(-1) === ref + '^{commit}' ? saved : other
    if (args[0] === 'push') { pushes.push(args); return '' }
    throw Error('Unexpected command')
  }
  expect(await git.pushTaskBranch({ machine: 'machine', folder: '/work' }, 'work/one')).toBe(saved)
  expect(pushes[0]).toEqual(['push', `--force-with-lease=${ref}:`, 'origin', `${saved}:${ref}`])
})
