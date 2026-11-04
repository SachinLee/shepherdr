/**
 * Comparing the folder a task saved with the paths Git reports for the machines that hold them.
 *
 * Git prints `/` even on Windows, and Windows folds case, separators and trailing dots or spaces.
 * A form we cannot compare is 'unknown': callers refuse instead of guessing, because the answer
 * decides whether a worktree and a branch may be removed. Nothing here resolves symlinks or
 * junctions; a caller that must be sure confirms the object identity of the paths it holds.
 */

/** How two native absolute paths describe the same place. */
export type PathMatch = 'same' | 'inside' | 'outside' | 'unknown'

export interface WorktreeEntry {
  path: string
  head?: string
  branch?: string
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}

/** `git worktree list --porcelain -z`: NUL-separated fields, a `worktree ` field starting each entry. */
export function worktreeEntries(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let entry: WorktreeEntry | undefined
  for (const field of output.split(output.includes('\0') ? '\0' : '\n')) {
    if (!field) continue
    if (field.startsWith('worktree ')) {
      entry = { path: field.slice('worktree '.length), bare: false, detached: false, locked: false, prunable: false }
      entries.push(entry)
    } else if (!entry) continue
    else if (field.startsWith('branch ')) entry.branch = field.slice('branch '.length)
    else if (field.startsWith('HEAD ')) entry.head = field.slice('HEAD '.length)
    else if (field === 'bare') entry.bare = true
    else if (field === 'detached') entry.detached = true
    else if (field === 'locked' || field.startsWith('locked ')) entry.locked = true
    else if (field === 'prunable' || field.startsWith('prunable ')) entry.prunable = true
  }
  return entries
}

/** Which file system wrote the path; a path of mixed or unclear form is unknown. */
export function pathFlavor(path: unknown): 'windows' | 'posix' | undefined {
  if (typeof path !== 'string' || !path || path.includes('\0')) return undefined
  if (/^[A-Za-z]:/.test(path) || path.startsWith('\\\\') || path.startsWith('//')) return 'windows'
  return path.startsWith('/') ? 'posix' : undefined
}

/** Windows drops trailing dots and spaces from a name before it names anything, and folds case. */
function windowsPart(part: string): string | undefined {
  if (/[:*?"<>|]/.test(part) || /[\u0000-\u001f]/.test(part)) return undefined
  const folded = part.replace(/[. ]+$/, '').toLowerCase()
  return folded || undefined
}

/** A comparison key for a native absolute path, or undefined when its form cannot be compared. */
export function comparablePath(path: string, flavor = pathFlavor(path)): string | undefined {
  if (typeof path !== 'string' || !path || path.includes('\0') || !flavor) return undefined
  if (flavor === 'posix') {
    if (!path.startsWith('/')) return undefined
    const parts = path.split('/').filter(part => part !== '')
    if (parts.some(part => part === '.' || part === '..')) return undefined
    return parts.join('/')
  }
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return undefined
  const slashed = path.replaceAll('\\', '/')
  const tail = (parts: string[]) => {
    if (parts.some(part => part === '.' || part === '..')) return undefined
    const folded = parts.map(windowsPart)
    return folded.some(part => part === undefined) ? undefined : folded as string[]
  }
  if (slashed.startsWith('//')) {
    const [server, share, ...rest] = slashed.split('/').filter(part => part !== '')
    const parts = tail(rest)
    if (!server || !share || !parts) return undefined
    return `//${server.toLowerCase()}/${share.toLowerCase()}${parts.map(part => `/${part}`).join('')}`
  }
  const drive = /^([A-Za-z]):(?=\/|$)/.exec(slashed)
  const parts = tail(slashed.slice(2).split('/').filter(part => part !== ''))
  if (!drive || !parts) return undefined
  return `${drive[1]!.toLowerCase()}:${parts.map(part => `/${part}`).join('')}`
}

/**
 * Where `child` sits relative to `parent`. 'unknown' covers a mixed Windows/POSIX pair, a relative
 * path, a device path or a native form Windows cannot name; callers treat it as unsafe to act on.
 */
export function pathRelation(parent: string, child: string): PathMatch {
  const flavor = pathFlavor(parent)
  if (!flavor || flavor !== pathFlavor(child)) return 'unknown'
  const root = comparablePath(parent, flavor)
  const leaf = comparablePath(child, flavor)
  if (root === undefined || leaf === undefined) return 'unknown'
  if (root === leaf) return 'same'
  return leaf.startsWith(root === '' ? '/' : `${root}/`) ? 'inside' : 'outside'
}

/** Whether both native paths name the same place, as far as their form can say. */
export function samePath(left: string, right: string) { return pathRelation(left, right) === 'same' }
