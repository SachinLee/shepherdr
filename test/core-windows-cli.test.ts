import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { coreConfig, coreEnvironment, windowsCorePipe } from '../server/core/config.ts'
import { HELP, NO_LEGACY_ROUTE, entryRoute, runEntry } from '../helper/core-entry.ts'

function withEnv<T>(vars: Record<string, string | undefined>, work: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { return work() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const CLEAN = { HC_SESSION: undefined, HC_SOCKET: undefined, SHEPHERDR_PORT: undefined, SHEPHERDR_CORE_BIN: undefined, SHEPHERDR_CORE_CREDENTIAL: undefined, SHEPHERDR_BACKEND: undefined }

describe('shared CLI dispatcher', () => {
  test('start, stop and bare status stay with the standalone application', () => {
    withEnv(CLEAN, () => {
      const argv = ['start', '--home', 'C:\\A B\\中 文', '--port', '17887', '--core-session', 'preview']
      expect(entryRoute(argv)).toEqual({ kind: 'launcher', args: argv })
      expect(entryRoute(['stop', '--home', 'C:\\A B'])).toEqual({ kind: 'launcher', args: ['stop', '--home', 'C:\\A B'] })
      // A credential never turns a lifecycle verb into an agent command.
      expect(entryRoute(['start'], { SHEPHERDR_CORE_CREDENTIAL: 'C:\\cred.json' })).toEqual({ kind: 'launcher', args: ['start'] })
    })
  })

  test('status with lifecycle flags is the application; status TASK stays an agent report', () => {
    withEnv(CLEAN, () => {
      for (const flag of ['--home', '--home=x', '--port', '--port=17887', '--core-session', '--core-socket', '--core-bin']) {
        const argv = ['status', flag]
        expect(entryRoute(argv)).toEqual({ kind: 'launcher', args: argv })
      }
      expect(entryRoute(['status'])).toEqual({ kind: 'launcher', args: ['status'] })
      expect(entryRoute(['status'], { SHEPHERDR_CORE_CREDENTIAL: 'C:\\cred.json' })).toEqual({ kind: 'launcher', args: ['status'] })
      // A shell's explicit empty word is the same as no second word: `status ""` stays the application.
      expect(entryRoute(['status', ''])).toEqual({ kind: 'launcher', args: ['status', ''] })
      expect(entryRoute(['status', '', '--home', 'C:\\A B'])).toEqual({ kind: 'launcher', args: ['status', '', '--home', 'C:\\A B'] })
      // Without a launch credential the POSIX entry refuses `status TASK`; it never invents a web route.
      expect(entryRoute(['status', 'SHEP-7'])).toEqual({ kind: 'error' })
      expect(entryRoute(['status', 'SHEP-7', '--note', 'ok'], { SHEPHERDR_CORE_CREDENTIAL: 'C:\\cred.json' })).toEqual({ kind: 'cli', args: ['status', 'SHEP-7', '--note', 'ok'] })
    })
  })

  test('a launch credential or core backend wins, and the explicit agent word is dropped', () => {
    const env = { SHEPHERDR_CORE_CREDENTIAL: 'C:\\private\\credential.json' }
    expect(entryRoute(['agent', 'status', 'TASK-9', '--note', '含 空格 "引号"'], env)).toEqual({ kind: 'cli', args: ['status', 'TASK-9', '--note', '含 空格 "引号"'] })
    expect(entryRoute(['agent', 'start'], env)).toEqual({ kind: 'cli', args: ['start'] })
    expect(entryRoute(['secret', 'set', 'NAME'], { SHEPHERDR_BACKEND: 'core' })).toEqual({ kind: 'cli', args: ['secret', 'set', 'NAME'] })
  })

  test('human secret verbs use the operator only when no credential applies', () => {
    withEnv(CLEAN, () => {
      for (const verb of ['set', 'rm', 'remove']) {
        const argv = ['secret', verb, 'NAME', '--machine']
        expect(entryRoute(argv)).toEqual({ kind: 'operator', args: argv })
      }
      expect(entryRoute(['secret', 'list'])).toEqual({ kind: 'error' })
    })
  })

  test('help exits 0 without touching stdin, and an unknown word keeps the legacy refusal', () => {
    const runs: string[][] = []
    const out: string[] = []
    const err: string[] = []
    const run = (command: string[]) => { runs.push(command); return 0 }
    for (const argv of [[], [''], ['help'], ['--help']]) expect(runEntry(argv, { env: {}, run, out: text => out.push(text), err: text => err.push(text) })).toBe(0)
    expect(runs).toHaveLength(0)
    expect(out).toEqual([`${HELP}\n`, `${HELP}\n`, `${HELP}\n`, `${HELP}\n`])
    expect(runEntry(['unrouted'], { env: {}, run, out: text => out.push(text), err: text => err.push(text) })).toBe(1)
    expect(runs).toHaveLength(0)
    expect(err).toEqual([`${NO_LEGACY_ROUTE}\n`])
  })

  test('the helper receives the full argv, an absolute bun path and inherited stdio', () => {
    const root = join('C:', 'Shep Dr', '中文 目录')
    const argv = ['status', 'SHEP-1', '--note', '含 空格 "双引号" \'单引号\'', 'C:\\Program Files\\Shep']
    const calls: { command: string[]; stdio: string }[] = []
    const code = runEntry(argv, {
      env: { SHEPHERDR_CORE_CREDENTIAL: 'C:\\cred.json' },
      root,
      execPath: process.execPath,
      run: (command, stdio) => { calls.push({ command, stdio }); return 7 },
      out: () => {}, err: () => {},
    })
    expect(code).toBe(7)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.command[0]).toBe(process.execPath)
    expect(call.command[0].startsWith('/') || /^[a-zA-Z]:[\\/]/.test(call.command[0])).toBe(true)
    expect(call.command[1]).toBe(join(root, 'helper', 'core-cli.ts'))
    expect(call.command.slice(2)).toEqual(argv)
    expect(call.stdio).toBe('inherit')
  })

  test('each route runs exactly its immutable script under the checkout root', () => {
    const root = join(tmpdir(), 'shep cli 中文')
    const calls: { args: string[]; script: string }[] = []
    for (const [argv, env] of [
      [['stop'], {}],
      [['status', '--home', '/tmp/x'], {}],
      [['secret', 'rm', 'NAME'], {}],
      [['status', 'SHEP-1'], { SHEPHERDR_CORE_CREDENTIAL: 'x' }],
    ] as [string[], Record<string, string>][]) {
      runEntry(argv, { env, root, execPath: 'bun-absolute', run: (command) => { calls.push({ args: argv, script: command[1] }); return 0 }, out: () => {}, err: () => {} })
    }
    const script = (words: string) => calls.find(call => call.args.join(' ') === words)?.script
    expect(script('stop')).toBe(join(root, 'server', 'core', 'launcher.ts'))
    expect(script('status --home /tmp/x')).toBe(join(root, 'server', 'core', 'launcher.ts'))
    expect(script('secret rm NAME')).toBe(join(root, 'helper', 'core-operator.ts'))
    expect(script('status SHEP-1')).toBe(join(root, 'helper', 'core-cli.ts'))
  })
})

describe('Windows core endpoints', () => {
  test('an explicit --core-socket wins and keeps its raw local pipe name', () => {
    withEnv({ ...CLEAN, HC_SOCKET: '\\\\.\\pipe\\inherited' }, () => {
      const config = coreConfig(['--core-socket', '\\\\.\\pipe\\explicit', '--core-session', 'work'], 'win32')
      expect(config.socket).toBe('\\\\.\\pipe\\explicit')
      expect(config.session).toBe('work')
    })
  })

  test('an explicit --core-session never inherits HC_SOCKET', () => {
    withEnv({ ...CLEAN, HC_SOCKET: '\\\\.\\pipe\\inherited' }, () => {
      expect(() => coreConfig(['--core-session', 'work'], 'win32')).toThrow(/HC_SOCKET/)
      expect(() => coreConfig(['--core-session', 'work'], 'win32')).toThrow(/--core-socket/)
    })
  })

  test('a missing choice fails closed instead of guessing a default pipe name', () => {
    withEnv(CLEAN, () => {
      expect(() => coreConfig([], 'win32')).toThrow(/No default core pipe name is assumed/)
      expect(() => coreConfig(['--home', join(tmpdir(), 'shep')], 'win32')).toThrow(/Choosing a core endpoint is required/)
    })
  })

  test('an inherited HC_SOCKET pipe is used unchanged, without resolve or the Unix length limit', () => {
    const pipe = `\\\\.\\pipe\\${'n'.repeat(140)} 中文`
    withEnv({ ...CLEAN, HC_SOCKET: pipe }, () => {
      expect(coreConfig([], 'win32').socket).toBe(pipe)
    })
  })

  test('remote, namespace and malformed endpoints are refused', () => {
    for (const bad of [
      '\\\\server\\share\\pipe\\x',
      '\\\\.\\pipe\\',
      '\\\\.\\pipe',
      '\\\\.\\pipe\\a\\b',
      '\\\\.\\pipe\\a/b',
      '\\\\.\\pipe\\.',
      '\\\\.\\pipe\\..',
      '\\\\.\\pipe\\a\u0000b',
      '\\\\.\\pipe\\a\u001fb',
      '\\\\?\\pipe\\x',
      '/tmp/core.sock',
      'core.sock',
    ]) expect(() => windowsCorePipe(bad, '--core-socket')).toThrow(/named pipe/)
  })

  test('a case-insensitive local device prefix and ordinary names are accepted verbatim', () => {
    for (const good of ['\\\\.\\PIPE\\Name', '\\\\.\\pipe\\Name with space 中文', `\\\\.\\pipe\\${'x'.repeat(200)}`]) expect(windowsCorePipe(good, '--core-socket')).toBe(good)
  })

  test('POSIX endpoint selection keeps its old precedence', () => {
    withEnv({ ...CLEAN, HC_SOCKET: '/tmp/inherited.sock' }, () => {
      expect(coreConfig([], 'linux').socket).toBe(resolve('/tmp/inherited.sock'))
      expect(coreConfig(['--core-socket', '/tmp/mine.sock'], 'linux').socket).toBe(resolve('/tmp/mine.sock'))
      expect(coreConfig(['--core-session', 'work'], 'linux').socket).not.toBe(resolve('/tmp/inherited.sock'))
      expect(() => coreConfig(['--core-socket', `/${'a'.repeat(120)}`], 'linux')).toThrow(/too long/)
    })
  })

  test('the core environment still strips launch credentials and points at the chosen pipe', () => {
    withEnv({ SHEPHERDR_CORE_CREDENTIAL: 'C:\\cred.json', SHEPHERDR_BACKEND: 'core', HC_SOCKET: '\\\\.\\pipe\\stale', CLAUDECODE: '1' }, () => {
      const config = coreConfig(['--core-socket', '\\\\.\\pipe\\chosen'], 'win32')
      const env = coreEnvironment(config)
      expect(env.SHEPHERDR_CORE_CREDENTIAL).toBeUndefined()
      expect(env.SHEPHERDR_BACKEND).toBeUndefined()
      expect(env.CLAUDECODE).toBeUndefined()
      expect(env.HC_SOCKET).toBe('\\\\.\\pipe\\chosen')
      expect(env.HC_SESSION).toBe('shepherdr')
    })
  })
})

/**
 * The fixture stands in for every routed helper: it records what the wrapper actually delivered and
 * exits with a distinctive non-zero status, so the assertion covers CMD's `%*`, the dispatcher's
 * argv-array spawn, inherited stdin and the exit code, without any real server, agent or user state.
 * It reports through a file, so the assertion never depends on console code pages or stdout buffering.
 */
const FIXTURE = [
  'import { writeFileSync } from "node:fs"',
  'const chunks: Buffer[] = []',
  'for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))',
  'writeFileSync(process.env.SHEP_FIXTURE_OUT, JSON.stringify({',
  '  script: process.argv[1],',
  '  args: process.argv.slice(2),',
  '  stdin: Buffer.concat(chunks).toString("utf8"),',
  '}))',
  'process.exitCode = 23',
  '',
].join('\n')

/**
 * `cmd /s /c` strips the first and last quote of the string, then parses the rest as one ordinary
 * command line, so an outer pair around the whole line leaves exactly one quoted word per argv
 * element. This is the documented, deterministic form; it is not a general escaping routine.
 */
function cmdCommandLine(script: string, args: string[]) {
  return `""${script}"${args.map(arg => ` "${arg}"`).join('')}"`
}

describe('Windows cmd entry', () => {
  test('the cmd wrapper quotes its own directory, forwards %* and disables delayed expansion', () => {
    // `!` in the *outer* command line is already lost when cmd runs with /v:on, before any wrapper
    // can help; this check covers the batch body itself, which is where the flag applies.
    const wrapper = readFileSync(join(resolve(import.meta.dir, '..'), 'bin', 'shepherdr.cmd'), 'utf8')
    expect(wrapper).toMatch(/^@echo off/m)
    expect(wrapper).toContain('setlocal DisableDelayedExpansion')
    expect(wrapper).toContain('"%~dp0..\\helper\\core-entry.ts" %*')
  })

  // This runs the real .cmd wrapper and the real dispatcher through cmd.exe on a temporary checkout.
  // Skipped everywhere else, where cmd.exe does not exist.
  test.skipIf(process.platform !== 'win32')('cmd.exe forwards argv, stdin and the exit status through the real wrapper', () => {
    const repo = resolve(import.meta.dir, '..')
    // Spaces and Chinese in the checkout path are the point: quoting has to survive `%~dp0`.
    const root = mkdtempSync(join(tmpdir(), 'shep cmd 中 文 '))
    try {
      for (const dir of ['bin', 'helper', join('server', 'core')]) mkdirSync(join(root, dir), { recursive: true })
      copyFileSync(join(repo, 'bin', 'shepherdr.cmd'), join(root, 'bin', 'shepherdr.cmd'))
      copyFileSync(join(repo, 'helper', 'core-entry.ts'), join(root, 'helper', 'core-entry.ts'))
      for (const script of ['server/core/launcher.ts', 'helper/core-cli.ts', 'helper/core-operator.ts']) writeFileSync(join(root, script), FIXTURE)

      const wrapper = join(root, 'bin', 'shepherdr.cmd')
      const comspec = process.env.ComSpec || 'cmd.exe'
      const run = (args: string[], extra: Record<string, string>, input: string, out: string) => {
        const env: Record<string, string | undefined> = { ...process.env, PATH: `${dirname(process.execPath)};${process.env.PATH ?? ''}`, SHEP_FIXTURE_OUT: out }
        delete env.SHEPHERDR_CORE_CREDENTIAL
        delete env.SHEPHERDR_BACKEND
        Object.assign(env, extra)
        return spawnSync(comspec, ['/d', '/s', '/v:off', '/c', cmdCommandLine(wrapper, args)], {
          windowsVerbatimArguments: true,
          input,
          env,
          encoding: 'utf8',
          timeout: 20_000,
        })
      }

      const cases: Array<{ args: string[]; extra: Record<string, string>; input: string; script: string }> = [
        // `stop` and bare `status` are the application, including the shell's explicit empty word.
        { args: ['stop', '--home', 'C:\\A B\\中 文 目录'], extra: {}, input: '', script: 'server/core/launcher.ts' },
        { args: ['status'], extra: {}, input: '', script: 'server/core/launcher.ts' },
        { args: ['status', ''], extra: {}, input: '', script: 'server/core/launcher.ts' },
        // A credential routes to the agent helper; spaces, Chinese, single quotes and `!` are data.
        { args: ['status', 'SHEP-7', '--note', "含 空格与'单引号'和惊!叹", 'C:\\Program Files\\Shep'], extra: { SHEPHERDR_CORE_CREDENTIAL: 'C:\\cred.json' }, input: '', script: 'helper/core-cli.ts' },
        // The operator path proves stdin survives: the fixture reads exactly the piped bytes.
        { args: ['secret', 'set', 'NAME'], extra: {}, input: 's3cret-值\n含 空格的第二行\n', script: 'helper/core-operator.ts' },
      ]

      for (const [index, item] of cases.entries()) {
        const out = join(root, `fixture-${index}.json`)
        const result = run(item.args, item.extra, item.input, out)
        const detail = `args=${JSON.stringify(item.args)} status=${result.status} signal=${result.signal} stdout=${result.stdout} stderr=${result.stderr}`
        if (result.error) throw new Error(`${detail} error=${result.error.message}`)
        // Nothing recorded means the wrapper or the dispatcher failed before a helper ran.
        if (!existsSync(out)) throw new Error(`${detail} no fixture output`)
        expect(JSON.parse(readFileSync(out, 'utf8')) as { script: string; args: string[]; stdin: string }, detail).toEqual({
          script: join(root, item.script),
          args: item.args,
          stdin: item.input,
        })
        expect(result.status, detail).toBe(23)
      }
    } finally {
      // A surviving child could hold a file open for a moment; a leaked temp directory must not hide the real failure.
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
    }
  })
})
