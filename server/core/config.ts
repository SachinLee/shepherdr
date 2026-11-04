import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultHome } from './home.ts'

export interface CoreConfig { home: string; port: number; binary: string; session: string; socket: string; plugins?: boolean; chosenCore?: boolean }

const WINDOWS_PIPE = /^\\\\\.\\pipe\\(.+)$/i

/**
 * Windows keeps the raw local named-pipe name end to end: no `resolve`, no Unix length limit and no
 * remote/UNC device paths. Random pipe names never stand in for a private endpoint, so anything
 * outside `\\.\pipe\<leaf>` is refused rather than guessed at.
 */
export function windowsCorePipe(value: string, source: string): string {
  const leaf = WINDOWS_PIPE.exec(value)?.[1]
  const invalid = leaf === undefined || leaf === '.' || leaf === '..' || /[\\/\u0000-\u001f\u007f]/.test(leaf)
  if (invalid) throw new Error(`${source} on Windows must be a local named pipe: \\\\.\\pipe\\NAME (a remote share, path separator, control character or empty name is refused)`)
  return value
}

export function coreConfig(args: string[], host: NodeJS.Platform = process.platform): CoreConfig {
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const option = args[index]
    if (option === '--foreground' || option === '--no-plugin-updates') continue
    if (!['--home', '--port', '--core-bin', '--core-session', '--core-socket'].includes(option) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${option}`)
    options.set(option, args[++index])
  }
  const home = resolve(options.get('--home') || defaultHome())
  const port = Number(options.get('--port') || process.env.SHEPHERDR_PORT || 7787)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535')
  const session = options.get('--core-session') || process.env.HC_SESSION || 'shepherdr'
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(session)) throw new Error('Invalid core session')
  // A named session is that session's own socket, never one inherited from the shell it was started in.
  const inherited = options.has('--core-session') ? undefined : process.env.HC_SOCKET
  const explicit = options.get('--core-socket')
  let socket: string
  if (host === 'win32') {
    const chosen = explicit !== undefined ? explicit : inherited
    // The official default core pipe name is not confirmed yet, so a missing choice is an error, never a guess.
    if (chosen === undefined) throw new Error('Choosing a core endpoint is required on Windows: pass --core-socket \\\\.\\pipe\\NAME (or inherit HC_SOCKET from the chosen core). No default core pipe name is assumed.')
    socket = windowsCorePipe(chosen, explicit !== undefined ? '--core-socket' : 'HC_SOCKET')
  } else {
    const runtime = process.env.XDG_RUNTIME_DIR || (process.getuid && existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'herdr-core', session))
    const resolved = resolve(explicit || inherited || join(runtime, 'herdr-core', `${session}.sock`))
    // State-directory fallback stores the socket directly there, without an extra herdr-core component.
    const fallback = !process.env.XDG_RUNTIME_DIR && !(process.getuid && existsSync(`/run/user/${process.getuid()}`))
    const endpoint = !explicit && !inherited && fallback ? join(runtime, `${session}.sock`) : resolved
    if (Buffer.byteLength(endpoint) > 100) throw new Error('Core socket path is too long; use --core-socket in a private directory')
    socket = endpoint
  }
  return { home, port, binary: options.get('--core-bin') || process.env.SHEPHERDR_CORE_BIN || 'hc', session, socket, plugins: !args.includes('--no-plugin-updates'), chosenCore: options.has('--core-session') || options.has('--core-socket') }
}

/** Never propagate the launching agent's credentials, routing or child-session markers into a new server/core. */
export function coreEnvironment(config: CoreConfig): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(SHEPHERDR_|AGENT_BROWSER_|CLAUDE_CODE_|HC_)/.test(key) || ['CLAUDECODE', 'ELEVENLABS_API_KEY'].includes(key)) delete env[key]
  return { ...env, SHEPHERDR_HOME: config.home, SHEPHERDR_PORT: String(config.port), HC_SESSION: config.session, HC_SOCKET: config.socket }
}
