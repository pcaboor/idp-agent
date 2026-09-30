import { constants, type Stats } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * Physical confinement: the one lstat, realpath and `O_NOFOLLOW` primitive
 * every module that reads or writes a user's repository goes through (review,
 * batch B3). `assertInsideRepo` in `core/paths` is lexical, and has to be —
 * `core/` touches no disk — so it cannot see that `catalog` is a link to
 * `../outside`: `init platform` wrote three witnesses there, and `iac-fs` read
 * an entity from wherever a linked `.yml` pointed. What a name leads to is a
 * fact about the disk, and only a module that asks the disk can know it.
 *
 * Three callers, three stances, one set of calls:
 *
 *   - `context/project-fs` follows a link that stays inside the application
 *     repository — a monorepo links a shared config into a package — and
 *     refuses one that leaves it: `followInside`, then `openToRead`.
 *   - `context/iac-fs` follows none: a declarations repository holds no link,
 *     and a reviewer reads the file a link names, not the file it leads to.
 *     `openToRead` refuses one by name.
 *   - `scaffold/write.ts` writes through none: `makeFolders` and `createNew`.
 *
 * Every path is judged against a root that is already real (`realRootOf`):
 * the directory the user named is theirs, by whatever path they named it —
 * a temporary directory on macOS is reached through `/var`, itself a link —
 * and below it nothing is taken on trust.
 *
 * `O_NOFOLLOW` guards the last name of a path and nothing above it, and Node
 * has no `openat` to hold a folder still while a file in it is opened. So an
 * open is checked once the descriptor exists: no folder between the root and
 * the file a link, and the name still naming the inode that was opened; and
 * `makeFolders` asks every name above again after each one it makes. A folder
 * swapped for a link — to outside the root or to another folder inside it —
 * between a check and an open is refused before a byte is read from it or
 * written to it; what `mkdir` or an exclusive create made in that instant is
 * one empty folder or one empty file, and the refusal names the path. A
 * folder swapped for a link and back again between two of these checks
 * themselves is the instant no check short of `openat` closes (SECURITY.md).
 *
 * A leaf: `node:` built-ins and nothing of ours, so `scaffold/`, which may
 * import `core/` and nothing else of ours, can take it as well as `context/`.
 * `tests/architecture/` holds both lines.
 */

/** Absent on Windows, where the checks around the open are the whole guard. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * A symbolic link met where a path was to be read or written — the link
 * itself, or a file reached through one. `path` is relative to the root, POSIX,
 * and never the link's target: that is a path outside the repository, and a
 * refusal is printed, and handed to a model by `project-fs`.
 */
export class LinkRefused extends Error {
  constructor(
    readonly path: string,
    /** Whether the link was a folder above `path` rather than `path` itself. */
    readonly through = false,
  ) {
    super(
      through
        ? `${path} is reached through a symbolic link, never followed`
        : `${path} is a symbolic link, never followed`,
    )
    this.name = 'LinkRefused'
  }
}

/**
 * Containment. `root + sep` rather than a bare prefix, so `/repo-evil` is never
 * accepted for `/repo`. The root itself is inside: a link to the root is a
 * cycle, not an escape, and `project-fs` gives it the reason it deserves.
 */
export const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root + path.sep)

/** The root every other call here is judged against: `root` with no link left in it. */
export const realRootOf = (root: string): Promise<string> => realpath(path.resolve(root))

const posix = (realRoot: string, absolute: string): string =>
  path.relative(realRoot, absolute).split(path.sep).join('/')

/**
 * A relative path's names. `..` is refused here too, though every caller has
 * already put the path through `assertInsideRepo`: this module is the one that
 * acts on it, and a check it relies on elsewhere is a check it does not make.
 */
function namesOf(relative: string): string[] {
  const names = relative.split(/[\\/]/).filter((name) => name !== '' && name !== '.')
  if (names.includes('..')) throw new Error(`${relative} climbs out of the repository`)
  return names
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code

/** Where a link leads, decided before anything is read through it. */
export type LinkTarget =
  | { readonly outcome: 'nowhere' }
  | { readonly outcome: 'outside' }
  | { readonly outcome: 'unreadable' }
  /** `real` has no link left in it, and `stats` are its own, not a link's. */
  | { readonly outcome: 'inside'; readonly real: string; readonly stats: Stats }

/**
 * Where the link at `absolute` leads. realpath before deciding anything: `..`
 * and an intermediate link are both resolved by it and by nothing short of it.
 * For a caller that follows a link inside; `iac-fs` and the writer follow none.
 */
export async function followInside(realRoot: string, absolute: string): Promise<LinkTarget> {
  const real = await realpath(absolute).catch(() => undefined)
  if (real === undefined) return { outcome: 'nowhere' }
  if (!isInside(realRoot, real)) return { outcome: 'outside' }
  // `real` has no link left in it, so this lstat is a stat that follows nothing.
  const stats = await lstat(real).catch(() => undefined)
  if (stats === undefined) return { outcome: 'unreadable' }
  return { outcome: 'inside', real, stats }
}

/**
 * Every name from the root down to the last of `names`, asked of the disk
 * again: a link among them is refused by name, wherever it leads, and a file
 * among them is an error, as `mkdir -p` made it. Asked from the root down on
 * every call rather than trusted from the call before, because a folder
 * checked a moment ago is exactly what a swap replaces.
 */
async function foldersOnly(realRoot: string, names: readonly string[]): Promise<void> {
  let current = realRoot
  for (const [index, name] of names.entries()) {
    current = path.join(current, name)
    const stats = await lstat(current)
    const walked = names.slice(0, index + 1).join('/')
    if (stats.isSymbolicLink()) throw new LinkRefused(walked)
    if (!stats.isDirectory()) {
      throw Object.assign(new Error(`${walked} is not a folder`), { code: 'ENOTDIR' })
    }
  }
}

/**
 * Whether the descriptor still is the file `absolute` names inside the root:
 * no folder between the root and it a link, and the name naming the inode
 * that was opened. A folder swapped for a link fails the first, whether the
 * link leads outside the root or to another folder inside it — resolving it
 * and testing containment passed the second kind, and a file read or created
 * under the path the walk listed was another folder's; swapped back, the
 * second. `absolute` is always the real root and names read from the disk or
 * laid out, so it is never compared by case with what `realpath` returns.
 */
async function holdsInside(realRoot: string, absolute: string, handle: FileHandle): Promise<boolean> {
  const opened = await handle.stat()
  const relative = path.relative(realRoot, absolute)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  if (path.isAbsolute(relative)) return false
  const folders = relative.split(path.sep).slice(0, -1)
  const clear = await foldersOnly(realRoot, folders).then(
    () => true,
    () => false,
  )
  if (!clear) return false
  const named = await lstat(absolute).catch(() => undefined)
  return named !== undefined && named.ino === opened.ino && named.dev === opened.dev
}

/**
 * A descriptor to read `absolute` through, which cannot have become something
 * else. `readFile(path)` re-resolves the path, so a decision taken on it and
 * the bytes taken after were about two different opens. With `O_NOFOLLOW` the
 * open fails outright if the last name has become a link — or always was one:
 * a link is refused here, dangling or not, to a file or to a folder — and the
 * check after it refuses a folder above that has. Everything after happens on
 * the descriptor, which names an inode rather than a path.
 *
 * Whether it is a regular file is the caller's to ask of the descriptor.
 */
export async function openToRead(realRoot: string, absolute: string): Promise<FileHandle> {
  let handle: FileHandle
  try {
    handle = await open(absolute, constants.O_RDONLY | NO_FOLLOW)
  } catch (error) {
    // ELOOP on Linux and macOS; EMLINK is what FreeBSD answers.
    if (code(error) === 'ELOOP' || code(error) === 'EMLINK') {
      throw new LinkRefused(posix(realRoot, absolute))
    }
    throw error
  }
  try {
    if (!(await holdsInside(realRoot, absolute, handle))) {
      throw new LinkRefused(posix(realRoot, absolute), true)
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/**
 * Every folder of `relative` under the root, made when missing — one name at a
 * time, never `recursive`, which follows every link on the way and made the
 * folder a dangling one named. A name that is a link, where it leads
 * notwithstanding, is refused; one that is a file is an error, as `mkdir -p`
 * made it.
 *
 * After each name, every name above it is asked again (`foldersOnly`). `mkdir`
 * follows every name but its last, so a folder checked on the way down and
 * swapped for a link before the next name was made took that folder — and
 * every deeper one, and the file after them — wherever the link led: checking
 * the new name alone saw a folder, through the link. Now the one folder made
 * in that instant is all that lands there, and the refusal names the link.
 */
export async function makeFolders(realRoot: string, relative: string): Promise<void> {
  const names = namesOf(relative)
  for (let depth = 1; depth <= names.length; depth += 1) {
    const current = path.join(realRoot, ...names.slice(0, depth))
    const there = await lstat(current).catch((error: unknown) => {
      if (code(error) === 'ENOENT') return undefined
      throw error
    })
    if (there === undefined) {
      // Not recursive, so the one folder is made where it is named. A link
      // planted there since the lstat makes this EEXIST, and the walk below
      // refuses it.
      await mkdir(current).catch((error: unknown) => {
        if (code(error) !== 'EEXIST') throw error
      })
    }
    await foldersOnly(realRoot, names.slice(0, depth))
  }
}

/**
 * A descriptor on a file this call created at `relative`, or undefined when
 * something is already there — never a clobber, never a truncation.
 *
 * `O_CREAT | O_EXCL` is the whole never-clobber guarantee: it fails rather
 * than truncate, and checking for existence first would leave a window where a
 * concurrent write is silently lost. It also neither follows a link where the
 * file goes nor creates what one names, dangling or not: POSIX answers EEXIST
 * for a link, so a link there, planted before the call or during it, is kept
 * as a file is — untouched, and `init platform` says a kept registration is
 * not a regular file. `O_NOFOLLOW` beside it says the same where a platform
 * would answer ELOOP instead.
 */
export async function openNew(realRoot: string, relative: string): Promise<FileHandle | undefined> {
  const absolute = path.join(realRoot, ...namesOf(relative))
  const name = posix(realRoot, absolute)
  let handle: FileHandle
  try {
    handle = await open(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o666,
    )
  } catch (error) {
    if (code(error) === 'EEXIST') return undefined
    if (code(error) === 'ELOOP' || code(error) === 'EMLINK') {
      // The last name, a link: kept, as above. A loop above it: refused.
      const there = await lstat(absolute).catch(() => undefined)
      if (there?.isSymbolicLink() === true) return undefined
      throw new LinkRefused(name, true)
    }
    throw error
  }
  try {
    if (!(await holdsInside(realRoot, absolute, handle))) throw new LinkRefused(name, true)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/**
 * Write `content` to a new file at `relative`, its folders made as
 * `makeFolders` makes them. True when written, false when something was
 * already there — a file, or a link — and is kept byte for byte.
 */
export async function createNew(realRoot: string, relative: string, content: string): Promise<boolean> {
  await makeFolders(realRoot, path.dirname(relative))
  const handle = await openNew(realRoot, relative)
  if (handle === undefined) return false
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
  return true
}
