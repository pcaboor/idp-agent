import type { Entity } from '../core/schemas/entity.js'

/** Where an entity came from, and why it could not be used. */
export interface Rejection {
  source: string
  reason: string
}

/**
 * Where a document this tool does not model came from, and what it was: a
 * Group, an API, a mkdocs.yml. Not a failure, so declared apart from
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
}

/**
 * Rejections are returned rather than thrown, and never swallowed. Backstage
 * ignores a malformed entity in silence and the first source wins; a tool that
 * did the same would inherit the failure mode it exists to prevent (design 4.4).
 * What is `ignored` was set aside, not refused — a real catalogue holds kinds
 * this tool has no business judging — and is returned so it can be said.
 */
export interface LoadResult {
  entities: Entity[]
  rejected: Rejection[]
  ignored: Ignored[]
}

export interface ContextProvider {
  readonly name: string
  load(): Promise<LoadResult>
}
