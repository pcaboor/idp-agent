import type { Entity } from '../core/schemas/entity.js'

/** Where an entity came from, and why it could not be used. */
export interface Rejection {
  source: string
  reason: string
}

/**
 * Rejections are returned rather than thrown, and never swallowed. Backstage
 * ignores a malformed entity in silence and the first source wins; a tool that
 * did the same would inherit the failure mode it exists to prevent (design 4.4).
 */
export interface LoadResult {
  entities: Entity[]
  rejected: Rejection[]
}

export interface ContextProvider {
  readonly name: string
  load(): Promise<LoadResult>
}
