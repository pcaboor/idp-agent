import type { CatalogueEntity } from '../core/schemas/entity.js'

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
 * Group, a System, a mkdocs.yml. Not a failure, so declared apart from
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
 * What a catalogue read cost and saw, for the notice (1.5): the distinct uids
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
}

export interface ContextProvider {
  readonly name: string
  load(): Promise<LoadResult>
}
