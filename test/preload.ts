// Run before the tests in every checkout (bunfig.toml): a fresh worktree, or one whose lockfile moved since its last
// install, gets its dependencies and plugin registries first, and plain bun test goes the fast way (scripts/test.ts).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRegistries } from '../scripts/build-plugins.ts'
import { once } from './once.ts'

// Tests never touch the Shepherdr that runs on this machine: its data folder, its server and its chats. A test file
// that wants a home of its own sets one before it imports the store; until then, and in every file that doesn't,
// it is a fresh empty folder (bun test without --parallel shares the store between files).
// (and the folders of runs gone an hour ago go, since a test process doesn't always get to clear its own)
for (const n of readdirSync(tmpdir()))
  if (n.startsWith('shep-test-home-'))
    try {
      if (Date.now() - statSync(join(tmpdir(), n)).mtimeMs > 3_600_000) rmSync(join(tmpdir(), n), { recursive: true, force: true })
    } catch {}
const parent = mkdtempSync(join(tmpdir(), 'shep-test-home-'))
// On Windows the home is a folder the app makes itself, with the private access list the core insists on: a folder
// made here inherits the administrators' access, and the core refuses that home. So the tests get a leaf that does
// not exist yet inside the folder this run owns, and the whole folder goes at the exit.
const home = process.platform === 'win32' ? join(parent, 'home') : parent
process.env.SHEPHERDR_HOME = home
process.on('exit', () => {
  // a child that outlived the file can still hold a file here on Windows, and the run has already been judged
  try { rmSync(parent, { recursive: true, force: true }) } catch {}
})
for (const k of ['SHEPHERDR_URL', 'SHEPHERDR_CHAT']) delete process.env[k]

const root = join(import.meta.dir, '..')
const modules = join(root, 'node_modules')
const stamp = join(modules, '.shepherdr-deps')
const want = createHash('sha256')
  .update(['bun.lock', 'package.json'].map((f) => readFileSync(join(root, f), 'utf8')).join('\0'))
  .digest('hex')

mkdirSync(modules, { recursive: true })
await once(join(modules, '.shepherdr-deps.lock'), () => existsSync(stamp) && readFileSync(stamp, 'utf8') === want, () => {
  const r = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (!r.success) throw new Error(`bun install failed:\n${r.stderr.toString()}`)
  writeFileSync(stamp, want)
})

writeRegistries()

/** how this bun was started: bun test runs the preload in the process the command started */
function command(): string[] {
  // Windows has neither /proc nor ps, and it never needs them: its bun keeps the command in the arguments.
  if (process.platform === 'win32') return process.argv
  try {
    return readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean)
  } catch {
    const r = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(process.pid)], { stdout: 'pipe' })
    return r.stdout.toString().trim().split(/\s+/)
  }
}

// Plain bun test runs the files one at a time in one process, where they share what they import (the store, the
// settings): slow, and one file's leftovers can fail another. It runs as bun run test instead, the files in parallel,
// each on its own. --parallel, --isolate and the runner's own workers run as asked, and a runner that says so
// (SHEPHERDR_TEST_RUNNER, which scripts/test.ts sets) is already running them that way: it is not looked at.
if (!process.env.SHEPHERDR_TEST_RUNNER) {
  const cmd = command()
  const at = cmd.indexOf('test')
  if (at > 0 && !cmd.some((a) => /^--(parallel|isolate|test-worker)\b/.test(a))) {
    console.log('bun test runs as bun run test here: the files in parallel, each on its own (AGENTS.md).')
    const r = Bun.spawnSync([process.execPath, join(root, 'scripts', 'test.ts'), ...cmd.slice(at + 1)], { cwd: process.cwd(), stdio: ['inherit', 'inherit', 'inherit'] })
    process.exit(r.exitCode ?? 1)
  }
}
