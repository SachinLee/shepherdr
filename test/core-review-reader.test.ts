import { expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreReviewReader } from '../server/core/review-reader.ts'

const WINDOWS = process.platform === 'win32'
const HELPER = join(import.meta.dir, '../helper/core-review.ts')

test('native exec events preserve IDs and distinguish completed and failed reviews', () => {
  const reader = new CoreReviewReader()
  const raw = [
    { type: 'thread.started', thread_id: 'thread' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item', type: 'agent_message', text: 'No findings' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    { type: 'turn.failed', error: { message: 'Provider disconnected' } },
  ]
  const lines = raw.map((event, offset) => ({ text: JSON.stringify({ at: offset + 100, event }), offset: offset * 100 }))
  const events = reader.parse(lines, '/private/review')
  expect(events).toContainEqual({ kind: 'session', id: '/private/review:0', at: 100, sessionId: 'thread', file: '/private/review' })
  expect(events).toContainEqual({ kind: 'agent', id: '/private/review:200', at: 102, text: 'No findings' })
  expect(events.filter(event => event.kind === 'turn-end')).toEqual([
    { kind: 'turn-end', id: '/private/review:300', at: 103 },
    { kind: 'turn-end', id: '/private/review:400', at: 104, aborted: true },
  ])
  expect(reader.parse(lines, '/private/review')).toEqual(events)
})

/** Run the real reviewer helper against a fake provider: the launch record and log are files it must keep private. */
async function review(provider: string) {
  const root = mkdtempSync(join(tmpdir(), 'shep-review-'))
  const folder = WINDOWS ? join(root, 'private') : root
  const credential = join(folder, 'launch.json'), log = join(folder, 'log')
  const launch = JSON.stringify({ argv: [process.execPath, '-e', provider], log })
  if (WINDOWS) {
    const { preparePrivateDirectory, writePrivateFile } = await import('../server/core/windows-security.ts')
    preparePrivateDirectory(folder)
    writePrivateFile(credential, launch)
    writePrivateFile(log, '')
  } else {
    writeFileSync(credential, launch, { mode: 0o600 })
    writeFileSync(log, '', { mode: 0o600 })
    chmodSync(credential, 0o600)
  }
  const child = Bun.spawnSync([process.execPath, HELPER, credential], { stdin: 'ignore' })
  const events = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { at: number; event: { type: string; error?: { message: string } } })
  return { status: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(), events, remove: () => rmSync(root, { recursive: true, force: true }) }
}

const emit = (...events: unknown[]) => `process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n') + '\n')})`

test('the reviewer helper echoes a completed provider stream and leaves a private event log', async () => {
  const run = await review(emit({ type: 'thread.started', thread_id: 'thread' }, { type: 'turn.completed', usage: {} }))
  try {
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('thread.started')
    expect(run.events.map(line => line.event.type)).toEqual(['thread.started', 'turn.completed'])
    for (const line of run.events) expect(typeof line.at).toBe('number')
  } finally { run.remove() }
})

test('a provider turn failure is a failed review, not a finished one', async () => {
  const run = await review(emit({ type: 'thread.started', thread_id: 'thread' }, { type: 'turn.failed', error: { message: 'Provider disconnected' } }))
  try {
    expect(run.status).toBe(1)
    expect(run.events.at(-1)?.event).toMatchObject({ type: 'turn.failed', error: { message: 'Provider disconnected' } })
  } finally { run.remove() }
})

test('a stream that ends without turn.completed, or a provider that exits nonzero, is reported incomplete', async () => {
  const quiet = await review(emit({ type: 'thread.started', thread_id: 'thread' }))
  try {
    expect(quiet.status).toBe(1)
    expect(quiet.events.at(-1)?.event.error?.message).toContain('before completing successfully')
  } finally { quiet.remove() }
  const broken = await review(`process.exitCode = 3`)
  try {
    expect(broken.status).toBe(1)
    expect(broken.events.at(-1)?.event.error?.message).toContain('before completing successfully')
  } finally { broken.remove() }
})

test.skipIf(WINDOWS)('the reviewer helper refuses a log over 2 MiB per line and a log other accounts can read', async () => {
  const run = await review(`process.stdout.write('x'.repeat(2 * 1024 * 1024 + 10) + '\\n')`)
  try {
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.events.at(-1)?.event.error?.message).toContain('before completing successfully')
  } finally { run.remove() }
  const root = mkdtempSync(join(tmpdir(), 'shep-review-'))
  try {
    const credential = join(root, 'launch.json'), log = join(root, 'log')
    writeFileSync(credential, JSON.stringify({ argv: [process.execPath, '-e', 'process.exit(0)'], log }), { mode: 0o600 })
    writeFileSync(log, '', { mode: 0o644 })
    const child = Bun.spawnSync([process.execPath, HELPER, credential], { stdin: 'ignore' })
    expect(child.exitCode).not.toBe(0)
    expect(child.stderr.toString()).toContain('Reviewer log must be private')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!WINDOWS)('the reviewer helper holds the log object itself: a second link is refused before any append', async () => {
  const { preparePrivateDirectory, writePrivateFile } = await import('../server/core/windows-security.ts')
  const root = mkdtempSync(join(tmpdir(), 'shep-review-'))
  try {
    const folder = join(root, 'private')
    preparePrivateDirectory(folder)
    const credential = join(folder, 'launch.json'), log = join(folder, 'log')
    writePrivateFile(credential, JSON.stringify({ argv: [process.execPath, '-e', 'process.exit(0)'], log }))
    writePrivateFile(log, '')
    linkSync(log, join(folder, 'log-alias')) // The log now has two names; another client could replace what it reads.
    const child = Bun.spawnSync([process.execPath, HELPER, credential], { stdin: 'ignore' })
    expect(child.exitCode).not.toBe(0)
    expect(child.stderr.toString()).toMatch(/single link|private/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
