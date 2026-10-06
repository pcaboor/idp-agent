import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isInside, LinkRefused, openToRead } from '../../confine/confine.js'
import {
  allowed,
  discardedWhole,
  isCode,
  isGenerated,
  neverOpened,
  type Allowed,
  type ByDesign,
  type FileFormat,
  type FileStanding,
  type PathNotAnalysed,
  type Walked,
} from '../../core/discovery/allow.js'
import { DISCOVERY_LIMITS, type DiscoveryLimits } from '../../core/discovery/limits.js'
import type { ExtractorName } from '../../core/discovery/rules.js'
import { blobId } from '../../core/git/blob.js'
import { GIT_LIMITS, GitError, gitIn, type Git, type GitLimits } from '../../process/git.js'

/**
 * Stage 8's discovery read (brief § 8, plan Task 1.2): what a service's
 * repository commits of its configuration, opened by name and nothing else.
 *
 * The second reader of the application repository, and deliberately not the
 * first. `project-fs/snapshot.ts` reads what a MODEL is sent, and withholds
 * every environment file; this opens a closed allow-list of configuration
 * files by name — `package.json` and the sample family, `.env.example` among
 * them, which the snapshot withholds — for the engine's own extractors, and
 * hands its bytes to nothing that reaches a model. An architecture rule keeps
 * either module from loading the other, and everything `agents/` reaches out
 * of both.
 *
 * What it does, in order. It asks git what the root's repository tracks and
 * what `HEAD` holds, with six shapes the launcher already runs and no other.
 * It walks the working tree, never following a link, and puts every path git
 * tracks and `HEAD` holds in exactly one group: never opened by its path
 * (`byDesign`), not analysed with its reason, or opened. It opens a path only
 * when the allow-list names it, the never-opened lists do not, and it is a
 * regular file with one name, through `openToRead`, bounded. And it keeps a
 * file's bytes only when git's blob for them is `HEAD`'s for that path: a file
 * changed since, staged or not, is read once to be hashed, then dropped,
 * handed to no extractor and kept in no field (owner's answer 4, 2026-10-04).
 *
 * It names a path only when `HEAD` holds it, because then its name is
 * committed. Everything else is counted and never named: what git does not
 * track, and every path outside a repository (`untracked`); what the index
 * holds and `HEAD` does not, staged with `git add` and never committed,
 * whether the working tree still holds it or not (`staged`, owner's answer 5,
 * 2026-10-06) — every path git tracks, under an unborn `HEAD`; under a `HEAD`
 * that could not be listed whole, every path git tracks (`unlisted`), none of
 * them opened either; and a path `HEAD` holds whose name is not valid UTF-8
 * (`unnameable`), never opened.
 *
 * It names a path as git spells it. git's paths are bytes: two that differ in
 * one byte are never one path here, and one that is not valid UTF-8 is never
 * named. A name its folder spells otherwise than git — in another case, or
 * decomposed, which APFS serves as the same file — is taken under git's
 * spelling only when the filesystem says the two are one file.
 *
 * What it does NOT do: extract, judge or render. No command calls it yet.
 */

/** One file the read kept: committed at `HEAD`, unchanged, allow-listed, and not discarded whole. */
export interface OpenedFile {
  /** Relative to the root, POSIX, as git names it under the root. */
  readonly path: string
  readonly bytes: Buffer
  /** sha256 of `bytes`, hex. */
  readonly sha256: string
  readonly extractor: ExtractorName
  readonly format: FileFormat
  readonly standing: FileStanding
}

export interface DiscoveryRead extends Walked {
  /** The repository's object format; `sha1` where there is none to read (`walk`, `none`). */
  readonly objectFormat: 'sha1' | 'sha256'
  /** The bytes of `opened`, in its order. */
  readonly files: readonly OpenedFile[]
}

export interface DiscoveryOptions {
  readonly limits?: Partial<DiscoveryLimits>
  /**
   * The launcher's bound on the listing of `HEAD`, and on it alone: a test
   * shrinks it to make the listing overflow without starving the calls before
   * it, whose output holds a temporary folder's path.
   */
  readonly git?: Partial<GitLimits>
}

/**
 * What git tracks under the root, by key (`keyOf`), root-relative: the files,
 * and every folder holding one.
 */
interface Tracked {
  readonly files: ReadonlySet<string>
  readonly directories: ReadonlySet<string>
  /**
   * Every key of `files` and `directories` whose last segment is valid UTF-8,
   * sorted, under its parent's key and that segment folded (`spelt`): where
   * the walk looks for git's spelling of an entry its folder spells otherwise.
   */
  readonly spellings: ReadonlyMap<string, readonly string[]>
}

type Tracking =
  | { readonly selection: 'git'; readonly tracked: Tracked; readonly prefix: string }
  | { readonly selection: 'walk' }
  | { readonly selection: 'none' }

/** One entry of `HEAD`'s tree, by its path's key under the root. */
interface HeadEntry {
  readonly mode: string
  readonly oid: string
}

/** What `HEAD` holds under the root, or why it is not known. */
type Committed =
  | {
      readonly state: 'listed'
      readonly format: 'sha1' | 'sha256'
      readonly entries: ReadonlyMap<string, HeadEntry>
    }
  | { readonly state: 'unborn' }
  | { readonly state: 'unlisted' }

type GitOutcome = { readonly ok: true; readonly stdout: Buffer } | { readonly ok: false; readonly error: GitError }

/** One git call; a `GitError` is an answer, anything else a defect of ours and thrown. */
const run = async (git: Git, args: readonly string[]): Promise<GitOutcome> => {
  try {
    return { ok: true, stdout: await git(args) }
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    return { ok: false, error }
  }
}

/** A line git ends with a newline, without it. */
const line = (stdout: Buffer): string => stdout.toString('utf8').replace(/\r?\n$/, '')

/**
 * A path as git's bytes, one character a byte (`latin1`): two paths that
 * differ in one byte are two keys, whatever their bytes decode to. Decoded
 * with replacement, `n\xff.md` and `n\xfe.md` would both be `n\uFFFD.md`: one
 * key for two paths, and a name that is neither. `/` and NUL are one byte in
 * UTF-8 and never inside a character, so a key splits where its path does.
 */
const keyOf = (name: string): string => Buffer.from(name, 'utf8').toString('latin1')

/** `fatal`: a byte that is not UTF-8 throws rather than becoming U+FFFD. `ignoreBOM`: a leading U+FEFF is kept, as the bytes hold it. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A key's name, or undefined when its bytes are not valid UTF-8: such a path is counted, never named, never opened. */
function nameOf(key: string): string | undefined {
  try {
    return UTF8.decode(Buffer.from(key, 'latin1'))
  } catch {
    return undefined
  }
}

/** A name composed (NFC) and lowercased: where two spellings APFS serves as one file meet. */
const folded = (name: string): string => name.normalize('NFC').toLowerCase()

/** Where `spellings` files a key: its parent's key, and its last segment folded. */
const spelt = (parent: string, name: string): string => `${parent}\0${folded(name)}`

/** Whether a `.git` entry — a folder, or the file a worktree writes — sits at `from` or above it. */
async function gitMarkerAbove(from: string): Promise<boolean> {
  let directory = from
  for (;;) {
    if ((await lstat(path.join(directory, '.git')).catch(() => undefined)) !== undefined) return true
    const parent = path.dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

/**
 * Which paths git tracks under the root, and where the root sits in its
 * repository. Written to the shape of the snapshot's `tracking`
 * (`project-fs/snapshot.ts`), which this module may not import — an
 * architecture rule keeps the two readers apart — and with its three answers:
 * `walk` where git says there is no repository and no `.git` sits at the root
 * or above it, `git` where it lists the files, and `none` for anything else,
 * where nothing is read. It adds the prefix, `rev-parse --show-prefix`, so a
 * service in a folder of its repository finds its paths in `HEAD`'s listing,
 * which names them from the top. Every path and the prefix are keys
 * (`keyOf`), never decoded here.
 */
async function tracking(realRoot: string, git: Git): Promise<Tracking> {
  const top = await run(git, ['rev-parse', '--show-toplevel'])
  if (!top.ok) {
    const unknown = top.error.code === 'ENOENT' || /not a git repository/.test(top.error.stderr)
    // git's "not a git repository" is also its answer about a `.git` FILE
    // whose gitdir no longer exists; the marker on disk decides.
    return { selection: unknown && !(await gitMarkerAbove(realRoot)) ? 'walk' : 'none' }
  }
  // The repository git answered about must hold the root: `core.worktree` can
  // name any folder as a repository's work tree.
  const realTop = await realpath(line(top.stdout)).catch(() => undefined)
  if (realTop === undefined || !isInside(realTop, realRoot)) return { selection: 'none' }

  const prefix = await run(git, ['rev-parse', '--show-prefix'])
  // Relative to the root, and only under it: `ls-files` run in a folder lists
  // that folder. `-z`, so no path is quoted or split.
  const listed = await run(git, ['ls-files', '-z', '--cached'])
  if (!prefix.ok || !listed.ok) return { selection: 'none' }

  const files = new Set<string>()
  const directories = new Set<string>()
  for (const entry of listed.stdout.toString('latin1').split('\0')) {
    if (entry === '') continue
    files.add(entry)
    const segments = entry.split('/')
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join('/'))
    }
  }
  const spellings = new Map<string, string[]>()
  for (const key of [...files, ...directories].sort()) {
    const slash = key.lastIndexOf('/')
    const last = nameOf(key.slice(slash + 1))
    if (last === undefined) continue
    const at = spelt(slash === -1 ? '' : key.slice(0, slash), last)
    spellings.set(at, [...(spellings.get(at) ?? []), key])
  }
  const shown = prefix.stdout.toString('latin1').replace(/\r?\n$/, '')
  return { selection: 'git', tracked: { files, directories, spellings }, prefix: shown }
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * What `HEAD` holds under the root: one `ls-tree -r -z --full-tree`, which
 * lists the whole repository even when the service is a folder of it, its
 * paths taken through the prefix. Whole or nothing: a listing that fails or
 * passes the launcher's bound opens no file and names none (`unlisted`), and
 * an unborn `HEAD` commits nothing.
 */
async function committedAt(
  git: Git,
  listing: Git,
  prefix: string,
): Promise<{ readonly head: string | undefined; readonly format: 'sha1' | 'sha256' | undefined; readonly committed: Committed }> {
  const formatOf = await run(git, ['rev-parse', '--show-object-format'])
  const format = formatOf.ok ? line(formatOf.stdout) : undefined
  const known = format === 'sha1' || format === 'sha256' ? format : undefined

  const resolved = await run(git, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (!resolved.ok) {
    // `--verify --quiet` exits 1, saying nothing, when `HEAD` names no commit yet.
    const unborn = resolved.error.code === 1 && resolved.error.stderr.trim() === ''
    return { head: undefined, format: known, committed: { state: unborn ? 'unborn' : 'unlisted' } }
  }
  const head = line(resolved.stdout)
  if (!COMMIT.test(head) || known === undefined) {
    return { head: COMMIT.test(head) ? head : undefined, format: known, committed: { state: 'unlisted' } }
  }

  const tree = await run(listing, ['ls-tree', '-r', '-z', '--full-tree', head])
  if (!tree.ok) return { head, format: known, committed: { state: 'unlisted' } }
  const entries = new Map<string, HeadEntry>()
  // Keys, as `ls-files`' paths: the mode, the type and the object are ASCII.
  for (const record of tree.stdout.toString('latin1').split('\0')) {
    if (record === '') continue
    // `<mode> <type> <object>\t<path>`
    const tab = record.indexOf('\t')
    const [mode = '', , oid = ''] = record.slice(0, tab).split(' ')
    const named = record.slice(tab + 1)
    if (tab === -1 || !named.startsWith(prefix)) continue
    entries.set(named.slice(prefix.length), { mode, oid })
  }
  return { head, format: known, committed: { state: 'listed', format: known, entries } }
}

/** One entry the walk reached that git tracks as a file: a file, a link, a pipe, a submodule's folder. */
interface Found {
  /** Root-relative, POSIX, git's spelling: the name the read says. */
  readonly path: string
  /** git's bytes for `path` (`keyOf`). */
  readonly key: string
  /** Where the walk reached it, under its folder's spelling, which can differ from git's in case or normalization. */
  readonly absolute: string
  /** Of the entry itself, never of where a link leads; undefined when it could not be asked. */
  readonly stats: Stats | undefined
}

interface WalkState {
  /** Undefined outside a repository: then every path is counted and none is named. */
  readonly tracked: Tracked | undefined
  readonly maxDirectories: number
  readonly found: Found[]
  /** Folders the budget left unwalked, and folders that could not be listed: what git tracks there is reached by no walk. */
  readonly cut: string[]
  readonly unlistable: string[]
  untracked: number
  directories: number
  truncated: boolean
}

/**
 * The name git tracks an entry under, when its folder spells it otherwise, or
 * undefined. APFS folds case and Unicode normalization, and git on it
 * (`core.ignorecase`, `core.precomposeunicode`) tracks `package.json` while the
 * folder lists `PACKAGE.JSON`, and `café` composed (NFC) while Finder wrote it
 * decomposed (NFD): `git status` calls either unchanged. A name git tracks in
 * the same folder that folds to the same (`folded`) is git's spelling of this
 * entry only when the filesystem says they are one file, the same device and
 * inode, and the folder does not list that spelling itself: two entries of one
 * folder that are one file are a hard link, never one name. The bytes are
 * still `HEAD`'s blob or nothing, checked after.
 */
async function gitSpelling(
  tracked: Tracked,
  directory: string,
  prefix: string,
  own: string,
  listed: ReadonlySet<string>,
): Promise<string | undefined> {
  const candidates = tracked.spellings.get(spelt(keyOf(prefix), own))
  if (candidates === undefined) return undefined
  const walked = await lstat(path.join(directory, own), { bigint: true }).catch(() => undefined)
  if (walked === undefined) return undefined
  for (const key of candidates) {
    const last = key.slice(key.lastIndexOf('/') + 1)
    // `spellings` files UTF-8 names alone, so `last` and `key` decode.
    const name = nameOf(last)
    if (listed.has(last) || name === undefined) continue
    const same = await lstat(path.join(directory, name), { bigint: true }).catch(() => undefined)
    if (same !== undefined && same.dev === walked.dev && same.ino === walked.ino) return nameOf(key)
  }
  return undefined
}

/**
 * One folder, entries in sorted order. No link is followed — unlike the
 * snapshot, which follows one that stays inside: a tracked link is a blob of
 * its target's name, so its bytes can never be "committed and unchanged" as a
 * file, and a folder that is a link is not descended. `prefix` is git's
 * spelling of the folder, `directory` where the walk reached it.
 */
async function walk(state: WalkState, directory: string, prefix: string): Promise<void> {
  // The folder's bytes: a name that is not UTF-8 is compared with git's bytes,
  // never decoded with replacement into a name nobody wrote.
  const names = await readdir(directory, { encoding: 'buffer' }).catch(() => undefined)
  if (names === undefined) {
    state.unlistable.push(prefix)
    return
  }
  const listed = new Set(names.map((raw) => raw.toString('latin1')))
  for (const raw of [...names].sort(Buffer.compare)) {
    const own = nameOf(raw.toString('latin1'))
    // The repository's own `.git` is neither walked nor counted: counted, it
    // would make every report say "git does not track 1 path".
    if (prefix === '' && own === '.git') continue
    const tracked = state.tracked
    if (own === undefined) {
      // A name that is not UTF-8, which APFS refuses and another filesystem
      // holds, is never named, opened or descended. Where git tracks it,
      // git's listing counts it (`staged`, `unnameable`); otherwise it is
      // counted here, as any path git does not track.
      const key = `${prefix === '' ? '' : `${keyOf(prefix)}/`}${raw.toString('latin1')}`
      if (tracked === undefined || !(tracked.files.has(key) || tracked.directories.has(key))) state.untracked += 1
      continue
    }
    let here = prefix === '' ? own : `${prefix}/${own}`
    const absolute = path.join(directory, own)
    // lstat, never stat: stat follows a link and reports its target.
    const stats = await lstat(absolute).catch(() => undefined)

    if (tracked !== undefined && !tracked.files.has(keyOf(here)) && !tracked.directories.has(keyOf(here))) {
      here = (await gitSpelling(tracked, directory, prefix, own, listed)) ?? here
    }
    const key = keyOf(here)
    if (tracked !== undefined && tracked.files.has(key)) {
      state.found.push({ path: here, key, absolute, stats })
      continue
    }
    const descend = stats?.isDirectory() === true && (tracked === undefined || tracked.directories.has(key))
    if (!descend) {
      // Counted, and neither opened nor NAMED: the name of a file nobody
      // committed — `notes/customer-x-incident.md`, a `.env` — is no more the
      // service's to print than its content. A folder git tracks nothing in
      // counts once, as git lists it; outside a repository every file counts.
      state.untracked += 1
      continue
    }
    if (state.directories >= state.maxDirectories) {
      state.cut.push(here)
      state.truncated = true
      continue
    }
    state.directories += 1
    await walk(state, absolute, here)
  }
}

/** A path at or under one of `folders`. */
const under = (file: string, folders: readonly string[]): boolean =>
  folders.some((folder) => folder === '' || file === folder || file.startsWith(`${folder}/`))

type Bounded = { readonly bytes: Buffer } | { readonly refused: PathNotAnalysed }

/**
 * The bytes of one file, bounded, through a descriptor that cannot have
 * become something else. Written to the shape of the snapshot's `readBounded`
 * (`project-fs/snapshot.ts`), which this module may not import, and stricter:
 * the open is `nonBlocking`, so a path swapped for a pipe since the walk's
 * `lstat` is refused rather than waited on, and the three checks the walk made
 * are made again on the descriptor — a regular file, one name, within the cap.
 * One byte past the cap is enough to know the file is over it, so an enormous
 * file is never pulled into memory to be refused, and none is ever cut.
 */
async function readBounded(realRoot: string, absolute: string, cap: number): Promise<Bounded> {
  let handle
  try {
    handle = await openToRead(realRoot, absolute, { nonBlocking: true })
  } catch (error) {
    return { refused: error instanceof LinkRefused ? 'link' : 'unreadable' }
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return { refused: 'not-a-file' }
    if (stats.nlink > 1) return { refused: 'link' }
    if (stats.size > cap) return { refused: 'over-size' }
    const buffer = Buffer.alloc(cap + 1)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const bytes = filled > cap ? undefined : Buffer.from(buffer.subarray(0, filled))
    buffer.fill(0)
    return bytes === undefined ? { refused: 'over-size' } : { bytes }
  } catch {
    return { refused: 'unreadable' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** A regular file's mode in a tree: the only entry whose blob is a file's bytes. */
const REGULAR = new Set(['100644', '100755'])

const byPath = (a: { readonly path: string }, b: { readonly path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/** A read that names nothing and opened nothing. */
const nothing = (selection: Walked['selection'], untracked: number, truncated: boolean): DiscoveryRead => ({
  selection,
  head: undefined,
  objectFormat: 'sha1',
  opened: [],
  notAnalysed: [],
  byDesign: [],
  untracked,
  staged: 0,
  unlisted: 0,
  unnameable: 0,
  truncated,
  files: [],
})

export async function readDiscovery(root: string, options: DiscoveryOptions = {}): Promise<DiscoveryRead> {
  const limits: DiscoveryLimits = { ...DISCOVERY_LIMITS, ...options.limits }
  // Every containment decision is made against the REAL root: on macOS a
  // temporary folder is reached through a link.
  const realRoot = await realpath(path.resolve(root)).catch(() => undefined)
  const rootStats = realRoot === undefined ? undefined : await lstat(realRoot).catch(() => undefined)
  if (realRoot === undefined || rootStats?.isDirectory() !== true) return nothing('none', 0, false)

  const git = gitIn(realRoot)
  const chosen = await tracking(realRoot, git)
  if (chosen.selection === 'none') return nothing('none', 0, false)

  const state: WalkState = {
    tracked: chosen.selection === 'git' ? chosen.tracked : undefined,
    maxDirectories: limits.maxDirectories,
    found: [],
    cut: [],
    unlistable: [],
    untracked: 0,
    directories: 1,
    truncated: false,
  }
  await walk(state, realRoot, '')
  // Outside a repository nothing is committed, so the rule for what git does
  // not track holds of every path: counted, none opened, none named.
  if (chosen.selection === 'walk') return nothing('walk', state.untracked, state.truncated)

  const listing = gitIn(realRoot, { limits: { ...GIT_LIMITS, ...options.git } })
  const { head, format, committed } = await committedAt(git, listing, chosen.prefix)
  const tracked = chosen.tracked.files

  // A path is named only when `HEAD` holds it. Under an unborn `HEAD` nothing
  // is committed, so every path the index holds is staged and never
  // committed; under one that could not be listed whole nothing can be shown
  // committed. Either way every path git tracks is counted, and none is named
  // or opened.
  if (committed.state !== 'listed') {
    return {
      ...nothing('git', state.untracked, state.truncated),
      head,
      objectFormat: format ?? 'sha1',
      staged: committed.state === 'unborn' ? tracked.size : 0,
      unlisted: committed.state === 'unlisted' ? tracked.size : 0,
    }
  }
  const entries = committed.entries
  const objectFormat = committed.format

  // Staged and never committed: in the index, not in `HEAD`. Counted from
  // git's two listings, whether or not the walk reached it, and named nowhere,
  // because its name is not committed either (owner's answer 5, 2026-10-06).
  // And of what `HEAD` holds, a path whose bytes are not UTF-8: counted, and
  // never named or opened, because it has no name to say but one we invent.
  let staged = 0
  let unnameable = 0
  for (const key of tracked) {
    if (!entries.has(key)) staged += 1
    else if (nameOf(key) === undefined) unnameable += 1
  }

  const opened: OpenedFile[] = []
  const notAnalysed: { path: string; why: PathNotAnalysed }[] = []
  const byDesign: { path: string; why: ByDesign }[] = []

  /** An allow-listed path `HEAD` holds: opened only when it holds it as a regular file, kept only when its bytes are that file's. */
  const open = async (found: Found, rule: Allowed, entry: HeadEntry): Promise<void> => {
    const refuse = (why: PathNotAnalysed): void => {
      notAnalysed.push({ path: found.path, why })
    }
    const stats = found.stats
    if (stats === undefined) return refuse('unreadable')
    if (stats.isSymbolicLink()) return refuse('link')
    if (!stats.isFile()) return refuse('not-a-file')
    // A hard link has no target to resolve: the name here and a name outside
    // are one inode, equally real, so a file with a second name is refused.
    if (stats.nlink > 1) return refuse('link')
    if (stats.size > limits.maxFileBytes) return refuse('over-size')

    // A path `HEAD` holds as something else — a link, a submodule — was not
    // committed as a file: known without opening it.
    if (!REGULAR.has(entry.mode)) return refuse('not-committed')

    const read = await readBounded(realRoot, found.absolute, limits.maxFileBytes)
    if ('refused' in read) return refuse(read.refused)
    const bytes = read.bytes
    if (blobId(bytes, objectFormat) !== entry.oid) {
      // Read once, to be hashed, and dropped here: changed since `HEAD`,
      // staged or not, so not what a reviewer will see at the commit.
      bytes.fill(0)
      return refuse('not-committed')
    }
    const discarded = discardedWhole(bytes.toString('utf8'), rule.format)
    if (discarded !== undefined) {
      bytes.fill(0)
      if (discarded === 'parse-failure') return refuse(discarded)
      byDesign.push({ path: found.path, why: discarded })
      return
    }
    opened.push({
      path: found.path,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      extractor: rule.extractor,
      format: rule.format,
      standing: rule.standing,
    })
  }

  // In this order: never opened, generated, allowed, then code or no rule —
  // of what `HEAD` holds alone: a path only staged is counted above.
  for (const found of state.found) {
    const entry = entries.get(found.key)
    if (entry === undefined) continue
    const never = neverOpened(found.path)
    if (never !== undefined) byDesign.push({ path: found.path, why: never })
    else if (isGenerated(found.path)) notAnalysed.push({ path: found.path, why: 'generated' })
    else {
      const rule = allowed(found.path)
      if (rule !== undefined) await open(found, rule, entry)
      else notAnalysed.push({ path: found.path, why: isCode(found.path) ? 'code' : 'no-rule' })
    }
  }

  // What git tracks and `HEAD` holds, and no walk reached: deleted from the
  // working tree, left out of it by a sparse checkout, or under a folder
  // replaced by a file or a link — named, because the name is committed.
  // Under a folder that could not be listed it is unreadable, and under one
  // the budget left unwalked it is said by `truncated` alone. One whose bytes
  // are not UTF-8 is counted above, and named nowhere.
  const reached = new Set(state.found.map((found) => found.key))
  for (const key of tracked) {
    if (!entries.has(key) || reached.has(key)) continue
    const file = nameOf(key)
    if (file === undefined || under(file, state.cut)) continue
    notAnalysed.push({ path: file, why: under(file, state.unlistable) ? 'unreadable' : 'deleted' })
  }

  opened.sort(byPath)
  return {
    selection: 'git',
    head,
    objectFormat,
    opened: opened.map((file) => file.path),
    notAnalysed: notAnalysed.sort(byPath),
    byDesign: byDesign.sort(byPath),
    untracked: state.untracked,
    staged,
    unlisted: 0,
    unnameable,
    truncated: state.truncated,
    files: opened,
  }
}
