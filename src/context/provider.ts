import type { CatalogueEntity, OrganisationEntity, OrganisationKind } from '../core/schemas/entity.js'

/** Where an entity came from, and why it could not be used. */
export interface Rejection {
  source: string
  reason: string
  /**
   * `kind:namespace/name`, lower case, when the source is a catalogue's item:
   * its `source` is then the ref and the file the catalogue read it from, and
   * the grouped `skipped` line names it by this alone.
   */
  ref?: string
}

/**
 * Where a document this tool does not model came from, and what it was: a
 * Location, a Group Backstage would refuse, a mkdocs.yml. Not a failure, so declared apart from
 * `Rejection` and printed apart from it: one line for all of them, where a
 * rejection gets a `skipped` line of its own.
 */
export interface Ignored {
  source: string
  reason: string
  /** The kind it declares; absent when it declares none. */
  kind?: string
  /** `kind:namespace/name`, when it states a name — see `IgnoredDocument`. */
  ref?: string
  /**
   * Set aside by the catalogue read's pre-pass, not by the reader: what the
   * catalogue accepted and this tool does not model
   * (`context/backstage/translate.ts`). Counted under its own term, "set aside
   * by the catalogue read", never among the kinds not modelled.
   */
  prePass?: { rule: PrePassRule; value: string }
}

/** Why the pre-pass set an item aside, one rule per row of the note's § 5 table. */
export type PrePassRule = 'namespace' | 'lifecycle' | 'resource-type' | 'name-case' | 'api-version' | 'shape'

/**
 * What a catalogue read cost and saw, for the notice (`sourceNotice`): the distinct uids
 * served across both reads, the pages, the bytes, the time, and how many uids
 * were served twice in a read that was still whole. It holds no token and no
 * URL.
 */
export interface Census {
  served: number
  pages: number
  bytes: number
  ms: number
  repeated: number
}

/**
 * Rejections are returned rather than thrown, and never swallowed. Backstage
 * ignores a malformed entity in silence and the first source wins; a tool that
 * did the same would inherit the failure mode it exists to prevent (design 4.4).
 * What is `ignored` was set aside, not refused — a real catalogue holds kinds
 * this tool has no business judging — and is returned so it can be said.
 */
export interface LoadResult {
  /**
   * The read model: the Components and Resources this tool manages, and the
   * Backstage APIs it reads and never writes — each file's in document order,
   * its APIs after its other entities.
   */
  entities: CatalogueEntity[]
  rejected: Rejection[]
  ignored: Ignored[]
  /**
   * The fields the entities hold and the read model does not read —
   * `relations`, `spec.consumesApis` — one path per key and document. Set
   * aside like a document of an unmodelled kind, and said like one.
   */
  unread: string[]
  /** Set by `BackstageProvider` only: a file road has nothing to count. */
  census?: Census
  /**
   * The organisation: the Groups, Users, Systems and Domains read, beside the
   * entities and never among them, so nothing built from `entities` — a
   * table, a summary, a vocabulary, a gate — sees one. Absent is none.
   */
  organisation?: OrganisationEntity[]
  /**
   * The organisation kinds read whole, which a reference to is judged against:
   * a catalogue's, never a repository's. A declarations repository's Group
   * files are what it happens to hold, not the organisation, so the file road
   * never sets it. Absent is none.
   */
  judged?: readonly OrganisationKind[]
  /**
   * The reads that stopped at a bound, in the load's order. Absent is a whole
   * read, and the file road never sets it: a folder is read to its end.
   */
  partial?: readonly PartialRead[]
  /**
   * What the catalogue cache did this run: set by `BackstageProvider` only,
   * and only when it was given a cache. Absent is no cache asked for.
   */
  cache?: CacheReport
}

/**
 * Why a kept catalogue read (`context/backstage/cache.ts`) was not used or not
 * written. A path is relative to the cache root, `/`-separated, and names the
 * name that was refused — never where a link leads. Declared here, beside
 * `LoadResult`, so a report names no type of `context/backstage/`.
 */
export type CacheRefusal =
  /** A link where a folder or a file of the store goes: never followed. */
  | { readonly kind: 'link'; readonly path: string }
  /** Owned by another account. */
  | { readonly kind: 'foreign'; readonly path: string }
  /** Open to another account: a group or other bit, or on `idp-agent/` a write bit. The mode, its permission bits. */
  | { readonly kind: 'open'; readonly path: string; readonly mode: number }
  | { readonly kind: 'not-a-folder' | 'not-a-file' | 'linked'; readonly path: string }
  /** Replaced by another run under three opens in a row. */
  | { readonly kind: 'busy'; readonly path: string }
  /** A copy that did not verify, and the first check it failed. */
  | { readonly kind: 'unverified'; readonly reason: UnverifiedReason }
  /** The disk said no: the error's code, never its message. */
  | { readonly kind: 'io'; readonly code: string }
  /** The root is missing, and so is the folder above it: the store makes one name, never a chain. */
  | { readonly kind: 'no-parent' }
  /**
   * A run as root keeps and reads nothing: `sudo` can keep the caller's home,
   * and one run would leave a tree of company data there that every later run
   * of theirs refuses as foreign and cannot remove.
   */
  | { readonly kind: 'root' }

/** The check a kept copy failed, in the order they are made. */
export type UnverifiedReason =
  | 'size'
  | 'header'
  | 'format'
  | 'origin'
  | 'length'
  | 'mac'
  | 'envelope'
  | 'account'
  | 'items'

/**
 * What the catalogue cache did in one load: two facts, because one run can
 * have both — what was read, and, when the catalogue was read, what was written.
 */
export interface CacheReport {
  readonly read:
    /** Answered from a copy; `ageMs` undefined when the copy is dated after this clock's now. */
    | { readonly state: 'fresh' | 'kept'; readonly fetchedAt: number; readonly ageMs: number | undefined }
    /** A copy past its time or dated ahead, none, or none asked for (a refresh). */
    | { readonly state: 'stale' | 'absent' | 'skipped' }
    /** The store could not be used, or its copy did not verify. */
    | { readonly state: 'not-used'; readonly refusal: CacheRefusal }
  /** Absent when the catalogue was not read: a copy answered. */
  readonly written?: { readonly state: 'written' } | { readonly state: 'not-written'; readonly refusal: CacheRefusal }
}

/**
 * Which of a load's three reads (`context/backstage/load.ts`): the kinds this
 * tool models, read whole; the organisation, read for the fields the read
 * model reads; every other kind, read as refs. Here, beside `LoadResult`, so
 * the graph can name a read that stopped at a bound without importing
 * `context/backstage/`, which nothing an agent reaches may do.
 */
export type ReadScope = 'modelled' | 'organisation' | 'refs'

/** What a read's entities are called in the sentences that say it stopped at a bound. */
export function scopeWords(scope: ReadScope): string {
  switch (scope) {
    case 'modelled':
      return 'Components, Resources and APIs'
    case 'organisation':
      return 'Groups, Users, Systems and Domains'
    case 'refs':
      return 'entities of other kinds'
    default: {
      const exhaustive: never = scope
      return exhaustive
    }
  }
}

/**
 * A read that reached its ceiling (`BACKSTAGE_LIMITS`): what it read, what
 * the catalogue announced, and the bound. A count ceiling is a fact about the
 * catalogue's size, so the read stops there and says so, and what it left out
 * is not loaded — never declared nowhere (ADR-0013).
 */
export interface PartialRead {
  readonly scope: ReadScope
  /** Lower case, as a reference names them: the kinds this read asked for. */
  readonly kinds: readonly string[]
  /** How many distinct entities it read: the bound. */
  readonly read: number
  /** The first page's `totalItems`; undefined when the server served more than it announced. */
  readonly total: number | undefined
  readonly limit: number
}

export interface ContextProvider {
  readonly name: string
  load(): Promise<LoadResult>
}
