import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { LinkRefused, makeFolders, openNew, openToRead, realRootOf } from '../../confine/confine.js'
import { readsAsDefinition } from '../../core/schemas/entity.js'
import type { CacheRefusal, Census, PartialRead, UnverifiedReason } from '../provider.js'
import { CATALOGUE_CACHE, type BackstageLimits } from './limits.js'
import {
  accountHolds,
  admitted,
  judgedOf,
  MODELLED_KINDS,
  ORGANISATION_FIELDS,
  readShapeOf,
  REFS_FIELDS,
  type ReadRule,
  type Served,
} from './load.js'

/**
 * The store a catalogue read is kept in (docs/plans/backstage-http-slice-2.md,
 * Task 2.2): company data at rest, and an input. Under the person's cache
 * root, `idp-agent/backstage/` holds a per-machine `secret` and one folder per
 * key, each holding one copy, `served.json`.
 *
 *   - **Who may open it.** From `idp-agent/` down, every name is a folder or a
 *     file of the running account, never a link, and open to no one else —
 *     `idp-agent/` writable by no one else, everything in `backstage/` closed
 *     to group and other — and every file has one link. One judgement,
 *     `acceptable`, over every name, before every read and every write. A
 *     name that fails is never repaired, removed or `chmod`-ed: the store is
 *     not used, and the refusal names the path.
 *   - **The key** is an HMAC under the secret of the catalogue's base, the
 *     token and the read shape of the effective limits, so the token is never
 *     at rest, not even hashed: a short token hashed plainly could be
 *     recovered offline from a folder's name.
 *   - **A copy** is written to a temporary file of its own by exclusive
 *     creation and renamed into place, sealed by a MAC over its format, its
 *     key, its header and every byte of its body.
 *   - **A read** goes through every check a page meets and more, in order,
 *     on the descriptor — then the provider runs the pre-pass and the reader
 *     on every item, as on a page. A file on disk is never a source that
 *     skips the reader.
 *
 * Everything below `idp-agent/` goes through `confine/`: `makeFolders` and
 * `openNew` follow no link, `openToRead` opens none. The root itself is the
 * person's, and followed if it is a link, as a directory a person names always
 * is (`realRootOf`).
 */

/** The format a copy declares, and the first line of what its MAC covers. */
export const CACHE_FORMAT = 'idp-agent/backstage-cache/1'

const TOP = 'idp-agent'
const STORE = 'idp-agent/backstage'
const SECRET = `${STORE}/secret`
const COPY = 'served.json'

/** A key folder's name: the first 32 hex characters of an HMAC. */
const KEY = /^[0-9a-f]{32}$/

/** A secret as it is kept: 32 random bytes in lower-case hex, and a line break. */
const SECRET_SHAPE = /^[0-9a-f]{64}\n$/

export type { CacheRefusal }

/** What `acceptable` judges a name as: `idp-agent/`, a folder below it, or a file. */
export type NameKind = 'top' | 'folder' | 'file'

/** The part of `Stats` a judgement reads: synthetic in a test, the disk's otherwise. */
export type NameStats = Pick<Stats, 'mode' | 'uid' | 'nlink'> & {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/**
 * Whether one name of the store may be used: the one judgement of type,
 * owner, mode and links, or the kind of refusal. `idp-agent/` may be read by
 * others — a person's `~/.cache` often is — but written by no one else;
 * everything in `backstage/` is closed to group and other, and a file has
 * no more than one link, since a second name for a copy or a secret is a name
 * someone else may have made.
 */
export function acceptable(stats: NameStats, owner: number, kind: NameKind): CacheRefusal['kind'] | undefined {
  if (stats.isSymbolicLink()) return 'link'
  if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) return kind === 'file' ? 'not-a-file' : 'not-a-folder'
  if (stats.uid !== owner) return 'foreign'
  if ((stats.mode & (kind === 'top' ? 0o022 : 0o077)) !== 0) return 'open'
  // No name left is no second name: a descriptor opened on a copy another run has since replaced.
  if (kind === 'file' && stats.nlink > 1) return 'linked'
  return undefined
}

/** A refusal of the name at `relative`, from the kind `acceptable` gave. */
function refusalAt(relative: string, stats: NameStats, kind: CacheRefusal['kind']): CacheRefusal {
  switch (kind) {
    case 'open':
      return { kind, path: relative, mode: stats.mode & 0o777 }
    case 'link':
    case 'foreign':
    case 'not-a-folder':
    case 'not-a-file':
    case 'linked':
    case 'busy':
      return { kind, path: relative }
    case 'unverified':
    case 'io':
    case 'root':
      throw new Error(`acceptable never answers ${kind}`)
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

/** The refusal a thrown error is: a link `confine/` refused, or the code the disk answered. */
function refusalOf(error: unknown): CacheRefusal {
  if (error instanceof LinkRefused) return { kind: 'link', path: error.path }
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return { kind: 'io', code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'EUNKNOWN' }
}

/** A refusal carried by a throw, so a check deep in a read or a write ends it with its reason. */
class Refused extends Error {
  constructor(readonly refusal: CacheRefusal) {
    super(refusal.kind)
    this.name = 'Refused'
  }
}

const isErrno = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException | undefined)?.code === code

/** The name's stats, never following it, or undefined when there is none. */
const lstatOrNone = (absolute: string): Promise<Stats | undefined> =>
  lstat(absolute).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  })

/** A temporary name beside `name`, this run's own. */
const temporaryName = (name: string): string =>
  `${name}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`

/**
 * The real root: `root` followed if it is a link, as a directory a person
 * names is. A missing root whose parent is a folder is made, `0o700`, as the
 * XDG base directory specification asks — the one folder the person's
 * environment names, never a chain of them.
 */
async function realCacheRoot(root: string): Promise<string> {
  const resolved = path.resolve(root)
  try {
    return await realRootOf(resolved)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  const realParent = await realRootOf(path.dirname(resolved))
  await makeFolders(realParent, path.basename(resolved), { mode: 0o700 })
  return realRootOf(resolved)
}

/** The real root, or undefined when there is none: a read-only store makes no root. */
const existingRoot = (root: string): Promise<string | undefined> =>
  realRootOf(path.resolve(root)).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  })

export interface Kept {
  readonly served: Served
  /** When the load that made the copy began: the MAC-covered header's, equal to `served.startedAt`. */
  readonly fetchedAt: number
}

export interface CatalogueCache {
  /** The folder a copy of this catalogue, token and read shape is kept in: 32 hex characters. */
  readonly key: string
  /**
   * The copy, verified — or why there is none. `stale`: under `fresh`, a
   * copy past the TTL or dated ahead of now by its header, read no further.
   * `kept` reads a copy whatever its age.
   */
  read(use: 'fresh' | 'kept'): Promise<{ readonly kept: Kept } | { readonly none: 'absent' | 'stale' } | { readonly none: CacheRefusal }>
  /** Keeps `served` as this key's copy, replacing the one there; never fails the run. */
  write(served: Served): Promise<{ readonly written: true } | { readonly written: false; readonly refusal: CacheRefusal }>
}

interface StoreOptions {
  /** `$XDG_CACHE_HOME` or `~/.cache`, the person's: followed if a link, made `0o700` when missing and its parent is a folder. */
  readonly root: string
  readonly base: URL
  /** Put into the key under the secret, and kept nowhere. */
  readonly token: string | undefined
  /** The account every name must belong to (`process.getuid()`, from cli/). */
  readonly owner: number
  /** The provider's effective limits: the key's read shape, and the bounds a copy is checked against. */
  readonly limits: BackstageLimits
  readonly now?: () => number
  /** Tests only: the open a read goes through, so a rename between the open and its check is staged exactly. */
  readonly openRead?: typeof openToRead
  /** Tests only: the open a write goes through, so a folder swapped between the write and the rename is staged exactly. */
  readonly openWrite?: typeof openNew
  /**
   * A kept read's store, which makes nothing — not a missing root, a folder or
   * a secret — and is only read. A store not all there, or a secret not of a
   * secret's shape, is `absent`: nothing kept under it could verify.
   */
  readonly readOnly?: boolean
}

/** The store for this base and token under `root`, or why it cannot be used at all. */
export async function catalogueCache(
  options: StoreOptions,
): Promise<{ readonly cache: CatalogueCache } | { readonly unusable: CacheRefusal } | { readonly absent: true }> {
  // Before anything is made: a run as root makes no tree in anyone's home.
  if (options.owner === 0) return { unusable: { kind: 'root' } }
  const make = options.readOnly !== true
  try {
    const realRoot = make ? await realCacheRoot(options.root) : await existingRoot(options.root)
    if (realRoot === undefined) return { absent: true }
    const store = new Store(realRoot, options)
    if (!(await store.folders(make))) return { absent: true }
    const secret = await store.secret(make)
    if (secret === undefined) return { absent: true }
    const key = createHmac('sha256', secret)
      .update('key\n')
      .update(JSON.stringify([CACHE_FORMAT, options.base.href, options.token ?? '', readShapeOf(options.limits)]))
      .digest('hex')
      .slice(0, 32)
    return { cache: store.bound(key, secret) }
  } catch (error) {
    return { unusable: error instanceof Refused ? error.refusal : refusalOf(error) }
  }
}

/** The store's disk: every name judged, every folder made through `confine/`. */
class Store {
  private readonly openRead: typeof openToRead
  private readonly openWrite: typeof openNew

  constructor(
    private readonly realRoot: string,
    private readonly options: StoreOptions,
  ) {
    this.openRead = options.openRead ?? openToRead
    this.openWrite = options.openWrite ?? openNew
  }

  private absolute(relative: string): string {
    return path.join(this.realRoot, ...relative.split('/'))
  }

  /** Throws the refusal of the name at `relative`, if it has one. */
  private judge(relative: string, stats: NameStats, kind: NameKind): void {
    const refused = acceptable(stats, this.options.owner, kind)
    if (refused !== undefined) throw new Refused(refusalAt(relative, stats, refused))
  }

  /**
   * The folder at `relative`, made `0o700` when missing, judged either way;
   * `false` when it is missing and `make` is false.
   */
  async folder(relative: string, kind: 'top' | 'folder', make: boolean): Promise<boolean> {
    const at = this.absolute(relative)
    let stats = await lstatOrNone(at)
    if (stats === undefined) {
      if (!make) return false
      await makeFolders(this.realRoot, relative, { mode: 0o700 })
      stats = await lstat(at)
    }
    this.judge(relative, stats, kind)
    return true
  }

  /** `idp-agent/` and `backstage/`, made when missing unless `make` is false, judged either way; false when one is missing. */
  async folders(make = true): Promise<boolean> {
    return (await this.folder(TOP, 'top', make)) && (await this.folder(STORE, 'folder', make))
  }

  /**
   * The secret's bytes: the one kept, or a new one when there is none or it is
   * not a secret's shape — undefined then, when `make` is false.
   */
  async secret(make = true): Promise<Buffer | undefined> {
    const kept = await this.readSmall(SECRET, 128)
    if (kept !== undefined && SECRET_SHAPE.test(kept)) return Buffer.from(kept.slice(0, 64), 'hex')
    if (!make) return undefined
    const hex = randomBytes(32).toString('hex')
    const temporary = `${STORE}/${temporaryName('secret')}`
    await this.writeNew(temporary, [Buffer.from(`${hex}\n`, 'utf8')])
    try {
      await this.folders()
      await rename(this.absolute(temporary), this.absolute(SECRET))
    } catch (error) {
      await unlink(this.absolute(temporary)).catch(() => undefined)
      throw error
    }
    return Buffer.from(hex, 'hex')
  }

  /**
   * A small file's text, judged on its descriptor, or undefined when there is
   * none. Anything that is not a regular file of the account, closed and
   * linked once, is refused: a name to look at, never one to replace.
   */
  private async readSmall(relative: string, most: number): Promise<string | undefined> {
    const handle = await this.open(relative)
    if (handle === undefined) return undefined
    try {
      this.judge(relative, await handle.stat(), 'file')
      const buffer = Buffer.alloc(most)
      const { bytesRead } = await handle.read(buffer, 0, most, 0)
      return buffer.subarray(0, bytesRead).toString('latin1')
    } finally {
      await handle.close()
    }
  }

  /**
   * A descriptor on the file at `relative`, never a link; undefined when there
   * is none. `openToRead` refuses a name that no longer names the inode it
   * opened — which is also what a sibling run's `rename` of a new copy between
   * its open and its check looks like. When the name, asked at once, is a
   * regular file with no link among the folders above it, the file was
   * replaced, not linked, and it is opened again: three opens in all, then
   * `busy`. A link is refused on every open, and never retried.
   */
  private async open(relative: string): Promise<Handle | undefined> {
    for (let opens = 1; ; opens += 1) {
      try {
        // Never waiting on the open: a pipe at the name is refused as not a file, not waited on for a writer.
        return await this.openRead(this.realRoot, this.absolute(relative), { nonBlocking: true })
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return undefined
        if (!(error instanceof LinkRefused && error.through && (await this.replaced(relative)))) throw error
        if (opens >= 3) throw new Refused({ kind: 'busy', path: relative })
      }
    }
  }

  /** Whether the name at `relative` is a regular file with no link among the folders above it. */
  private async replaced(relative: string): Promise<boolean> {
    const names = relative.split('/')
    for (let depth = 1; depth < names.length; depth += 1) {
      const above = await lstatOrNone(this.absolute(names.slice(0, depth).join('/')))
      if (above?.isDirectory() !== true) return false
    }
    return (await lstatOrNone(this.absolute(relative)))?.isFile() === true
  }

  /**
   * After a copy is written, and never otherwise: each folder under
   * `backstage/` named as a key, the account's and closed, loses a copy older
   * than `keepMs` by its mtime and a temporary file older than the TTL, and is
   * then removed if empty — when this pass emptied it, or it has been empty
   * longer than the TTL, so another run's folder, made a moment ago for a copy
   * it is still sealing, is left — and `rmdir` removes nothing else. Nothing is followed:
   * every name is `lstat`-ed, and a link, a file, or a folder of another name,
   * owner or mode is left as it is. A copy no run writes again is removed seven
   * days after it was written (the owner's answer to question 1); a secret made
   * again leaves every earlier key to this.
   */
  private async prune(): Promise<void> {
    const now = (this.options.now ?? Date.now)()
    for (const name of await readdir(this.absolute(STORE))) {
      if (!KEY.test(name)) continue
      const folder = `${STORE}/${name}`
      const stats = await lstatOrNone(this.absolute(folder))
      if (stats === undefined || acceptable(stats, this.options.owner, 'folder') !== undefined) continue
      let removed = false
      for (const entry of await readdir(this.absolute(folder))) {
        const file = `${folder}/${entry}`
        const at = await lstatOrNone(this.absolute(file))
        if (at?.isFile() !== true) continue
        const age = now - at.mtimeMs
        const expired = entry === COPY ? age > CATALOGUE_CACHE.keepMs : entry.endsWith('.tmp') && age > CATALOGUE_CACHE.ttlMs
        // The folder asked again before each removal: one swapped for a link since is left.
        if (expired && (await lstatOrNone(this.absolute(folder)))?.isDirectory() === true) {
          removed = await unlink(this.absolute(file)).then(
            () => true,
            () => removed,
          )
        }
      }
      // An empty folder this pass did not empty, and one younger than the TTL, is another run's
      // between its `mkdir` and its temporary file: removing it would fail that run's write.
      if (removed || now - stats.mtimeMs > CATALOGUE_CACHE.ttlMs) {
        await rmdir(this.absolute(folder)).catch(() => undefined)
      }
    }
  }

  /** A new file at `relative`, `0o600`, by exclusive creation, holding `chunks`. */
  private async writeNew(relative: string, chunks: readonly Buffer[]): Promise<void> {
    const handle = await this.openWrite(this.realRoot, relative, { mode: 0o600 })
    if (handle === undefined) throw new Refused({ kind: 'io', code: 'EEXIST' })
    try {
      await handle.writeFile(chunks)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(this.absolute(relative)).catch(() => undefined)
      throw error
    }
    await handle.close()
  }

  /** The store's two operations for one key. */
  bound(key: string, secret: Buffer): CatalogueCache {
    return {
      key,
      read: (use) => this.readCopy(key, secret, use),
      write: (served) => this.writeCopy(key, secret, served),
    }
  }

  private async writeCopy(
    key: string,
    secret: Buffer,
    served: Served,
  ): Promise<{ readonly written: true } | { readonly written: false; readonly refusal: CacheRefusal }> {
    const folder = `${STORE}/${key}`
    const copy = `${folder}/${COPY}`
    const temporary = `${folder}/${temporaryName(COPY)}`
    let made = false
    try {
      await this.folders()
      await this.folder(folder, 'folder', true)
      const { header, body } = sealed(key, secret, this.options.base, served)
      // A header no read would take is not kept: every later run would rewrite it.
      if (header.length > CATALOGUE_CACHE.headerBytes) throw new Refused({ kind: 'unverified', reason: 'header' })
      await this.writeNew(temporary, [header, ...body])
      made = true
      // Asked again after the write: a folder swapped since is refused before the rename.
      await this.folders()
      await this.folder(folder, 'folder', false)
      const there = await lstatOrNone(this.absolute(copy))
      if (there !== undefined && !there.isFile()) {
        throw new Refused({ kind: there.isSymbolicLink() ? 'link' : 'not-a-file', path: copy })
      }
      // A name replaced as a name: a link planted since the lstat is replaced, its target never opened.
      await rename(this.absolute(temporary), this.absolute(copy))
      made = false
      // Pruning never fails a write: what it could not remove, the next write tries again.
      await this.prune().catch(() => undefined)
      return { written: true }
    } catch (error) {
      if (made) await unlink(this.absolute(temporary)).catch(() => undefined)
      return { written: false, refusal: error instanceof Refused ? error.refusal : refusalOf(error) }
    }
  }

  private async readCopy(
    key: string,
    secret: Buffer,
    use: 'fresh' | 'kept',
  ): Promise<{ readonly kept: Kept } | { readonly none: 'absent' | 'stale' } | { readonly none: CacheRefusal }> {
    const folder = `${STORE}/${key}`
    const copy = `${folder}/${COPY}`
    try {
      // A read makes nothing: a store not all there holds no copy.
      if (!(await this.folders(false)) || !(await this.folder(folder, 'folder', false))) return { none: 'absent' }
      const handle = await this.open(copy)
      if (handle === undefined) return { none: 'absent' }
      try {
        // Everything from here on is asked of the descriptor, which names one inode.
        this.judge(copy, await handle.stat(), 'file')
        const verified = await verify(handle, {
          key,
          secret,
          base: this.options.base,
          limits: this.options.limits,
          fresh: use === 'fresh' ? (this.options.now ?? Date.now)() : undefined,
        })
        return verified === 'stale' ? { none: 'stale' } : { kept: verified }
      } finally {
        await handle.close()
      }
    } catch (error) {
      return { none: error instanceof Refused ? error.refusal : refusalOf(error) }
    }
  }
}

/** A descriptor a copy is read through. */
type Handle = Awaited<ReturnType<typeof openToRead>>

/** Ends a read of a copy that did not verify, with the first check it failed. */
const unverified = (reason: UnverifiedReason): Refused => new Refused({ kind: 'unverified', reason })

/** `length` bytes from `position`, or fewer where the file ends. */
async function bytesAt(handle: Handle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let at = 0
  while (at < length) {
    const { bytesRead } = await handle.read(buffer, at, length - at, position + at)
    if (bytesRead === 0) break
    at += bytesRead
  }
  return buffer.subarray(0, at)
}

/** Text that is UTF-8 and nothing else: a byte order mark is kept, and then refused by the parse. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** `bytes` as JSON, or undefined when they are not UTF-8 JSON. */
function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(UTF8.decode(bytes)) as unknown
  } catch {
    return undefined
  }
}

const whole = z.number().int().nonnegative()

const headerSchema = z.strictObject({
  format: z.literal(CACHE_FORMAT),
  origin: z.string(),
  fetchedAt: z.string(),
  count: whole,
  bytes: whole,
  mac: z.string().regex(/^[0-9a-f]{64}$/),
})

const envelopeSchema = z.strictObject({
  startedAt: whole,
  asked: z.strictObject({ organisation: z.array(z.string()), refs: z.array(z.string()) }),
  bounded: z.array(
    z.strictObject({
      scope: z.enum(['modelled', 'organisation', 'refs']),
      kinds: z.array(z.string()),
      read: whole,
      total: whole.optional(),
      limit: whole,
    }),
  ),
  census: z.strictObject({ served: whole, pages: whole, bytes: whole, ms: whole, repeated: whole }),
  counts: z.strictObject({ whole, organisation: whole, refs: whole }),
})

/**
 * A copy, verified, in the order a check costs: its size, before a byte is
 * read; its header; under `fresh`, its age by the header alone — skipping only
 * reads less, so an age nobody has vouched for is enough to skip, and nothing
 * of a stale copy is used; its length and its MAC; each line on its own; its
 * account of its own reads, held to what a live load could give; every item
 * through the load's own check. Then it is a `Served`, and the provider's
 * loop runs the pre-pass and the reader on every item, as on a page.
 */
async function verify(
  handle: Handle,
  context: { key: string; secret: Buffer; base: URL; limits: BackstageLimits; fresh: number | undefined },
): Promise<Kept | 'stale'> {
  const { limits } = context
  const { size } = await handle.stat()
  if (size > limits.bytesPerRun + CATALOGUE_CACHE.headerBytes) throw unverified('size')

  const start = await bytesAt(handle, Math.min(size, CATALOGUE_CACHE.headerBytes), 0)
  const end = start.indexOf(0x0a)
  if (end === -1) throw unverified('header')
  const parsed = jsonOf(start.subarray(0, end))
  if (isRecord(parsed) && Object.hasOwn(parsed, 'format') && parsed['format'] !== CACHE_FORMAT) throw unverified('format')
  const shaped = headerSchema.safeParse(parsed)
  if (!shaped.success) throw unverified('header')
  const header = shaped.data
  if (header.origin !== context.base.href) throw unverified('origin')
  const fetchedAt = Date.parse(header.fetchedAt)
  if (Number.isNaN(fetchedAt) || new Date(fetchedAt).toISOString() !== header.fetchedAt) throw unverified('header')

  if (context.fresh !== undefined) {
    const age = context.fresh - fetchedAt
    if (!(age >= 0 && age < CATALOGUE_CACHE.ttlMs)) return 'stale'
  }

  if (size - (end + 1) !== header.bytes) throw unverified('length')
  const body = await bytesAt(handle, header.bytes, end + 1)
  if (body.length !== header.bytes) throw unverified('length')
  const mac = Buffer.from(macOf(context.secret, context.key, header, [body]), 'hex')
  if (!timingSafeEqual(mac, Buffer.from(header.mac, 'hex'))) throw unverified('mac')

  const lines = linesOf(body)
  if (lines.some((line) => line.length > limits.bytesPerResponse)) throw unverified('size')
  const [first, ...rest] = lines
  const stated = envelopeSchema.safeParse(first === undefined ? undefined : jsonOf(first))
  if (!stated.success) throw unverified('envelope')
  const envelope = stated.data
  if (envelope.startedAt !== fetchedAt) throw unverified('envelope')
  const { counts } = envelope
  if (body.at(-1) !== 0x0a || rest.length !== counts.whole + counts.organisation + counts.refs) throw unverified('items')

  const bounded: PartialRead[] = envelope.bounded.map(({ scope, kinds, read, total, limit }) => ({ scope, kinds, read, total, limit }))
  if (!accountHolds(envelope.asked, bounded, limits) || envelope.census.served !== rest.length) throw unverified('account')

  const items = rest.map((line) => {
    const item = jsonOf(line)
    if (item === undefined) throw unverified('items')
    return item
  })
  const modelled = items.slice(0, counts.whole)
  const organisation = items.slice(counts.whole, counts.whole + counts.organisation)
  const refs = items.slice(counts.whole + counts.organisation)
  const reads: readonly (readonly [unknown[], ReadRule])[] = [
    [modelled, { asked: new Set(MODELLED_KINDS), ceiling: limits.modelledEntities, scope: 'modelled' }],
    [organisation, { asked: new Set(envelope.asked.organisation), ceiling: limits.organisationEntities, scope: 'organisation' }],
    [refs, { asked: new Set(envelope.asked.refs), ceiling: limits.otherRefs, scope: 'refs' }],
  ]
  const kept = new Set<string>()
  for (const [read, rule] of reads) {
    const admission = admitted(read, rule, new Set(), kept)
    // A copy holds what its reads kept, each uid once and none past a ceiling.
    if ('refused' in admission || admission.stopped || admission.repeated > 0) throw unverified('items')
  }
  if (kept.size !== header.count) throw unverified('items')

  const served: Served = {
    whole: modelled,
    organisation,
    refs,
    judged: judgedOf(envelope.asked.organisation, bounded),
    bounded,
    census: envelope.census,
    asked: envelope.asked,
    startedAt: envelope.startedAt,
  }
  return { served, fetchedAt }
}

/** A copy's first line, and what its MAC covers but the MAC itself. */
interface Header {
  readonly format: string
  readonly origin: string
  readonly fetchedAt: string
  readonly count: number
  readonly bytes: number
  readonly mac: string
}

/** A copy's body's first line: the account of the load, and how many items of each read follow. */
interface Envelope {
  readonly startedAt: number
  readonly asked: Served['asked']
  readonly bounded: readonly PartialRead[]
  readonly census: Census
  readonly counts: { readonly whole: number; readonly organisation: number; readonly refs: number }
}

/** A body's lines, as bytes: the body ends with a line break, which ends its last line. */
function linesOf(body: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let at = 0
  while (at < body.length) {
    const end = body.indexOf(0x0a, at)
    const stop = end === -1 ? body.length : end
    lines.push(body.subarray(at, stop))
    at = stop + 1
  }
  return lines
}

/**
 * A dotted field list applied to `item` as Backstage's `fields` applies it:
 * each path's value, where there is one, and nothing else. What a Backstage
 * honouring `fields` serves, so nothing a server that ignored it sent — a
 * User's profile, an annotation — is kept.
 */
function projected(item: unknown, fields: string): unknown {
  const out: Record<string, unknown> = {}
  for (const dotted of fields.split(',')) {
    const names = dotted.split('.')
    let value: unknown = item
    for (const name of names) {
      value = isRecord(value) && Object.hasOwn(value, name) ? value[name] : undefined
      if (value === undefined) break
    }
    if (value === undefined) continue
    let into = out
    for (const name of names.slice(0, -1)) {
      if (!isRecord(into[name])) into[name] = {}
      into = into[name] as Record<string, unknown>
    }
    into[names[names.length - 1] ?? ''] = value
  }
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isApi = (kind: unknown): boolean => typeof kind === 'string' && kind.toLowerCase() === 'api'

/**
 * An API's definition the reader reads as declared, kept as `declared`, which
 * it reads the same. The kind in any case, as the load admits it and the reader
 * dispatches on it: `kind: Api` passes the load and is refused by the reader on
 * its kind, and its definition is still text nobody keeps.
 */
function minimisedWhole(item: unknown): unknown {
  if (!isRecord(item) || !isApi(item['kind']) || !isRecord(item['spec'])) return item
  const spec = item['spec']
  if (!Object.hasOwn(spec, 'definition') || !readsAsDefinition(spec['definition'])) return item
  return { ...item, spec: { ...spec, definition: 'declared' } }
}

/** The five fields a MAC covers of a header, in their order: its canonical form. */
const canonical = (header: Omit<Header, 'mac'>): string =>
  JSON.stringify({
    format: header.format,
    origin: header.origin,
    fetchedAt: header.fetchedAt,
    count: header.count,
    bytes: header.bytes,
  })

/** The MAC of a copy: its format, the key it is kept under, its header but the MAC, and every byte of its body. */
function macOf(secret: Buffer, key: string, header: Omit<Header, 'mac'>, body: readonly Buffer[]): string {
  const hmac = createHmac('sha256', secret).update(`${CACHE_FORMAT}\n${key}\n${canonical(header)}\n`)
  for (const chunk of body) hmac.update(chunk)
  return hmac.digest('hex')
}

/** A `Served` as a copy: the header line, and the body — the envelope, then one line per item. */
function sealed(key: string, secret: Buffer, base: URL, served: Served): { header: Buffer; body: Buffer[] } {
  const line = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  const envelope: Envelope = {
    startedAt: served.startedAt,
    asked: served.asked,
    bounded: served.bounded,
    census: served.census,
    counts: { whole: served.whole.length, organisation: served.organisation.length, refs: served.refs.length },
  }
  const body = [
    line(envelope),
    ...served.whole.map((item) => line(minimisedWhole(item))),
    ...served.organisation.map((item) => line(projected(item, ORGANISATION_FIELDS))),
    ...served.refs.map((item) => line(projected(item, REFS_FIELDS))),
  ]
  const unsealed = {
    format: CACHE_FORMAT,
    origin: base.href,
    fetchedAt: new Date(served.startedAt).toISOString(),
    count: served.whole.length + served.organisation.length + served.refs.length,
    bytes: body.reduce((sum, chunk) => sum + chunk.length, 0),
  }
  const header = Buffer.from(`${JSON.stringify({ ...unsealed, mac: macOf(secret, key, unsealed, body) })}\n`, 'utf8')
  return { header, body }
}
