import { refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import { relationsOf, stepOf, type RelationResult } from '../../context/graph/relations.js'
import type { OwnRelation } from '../../core/schemas/query.js'
import {
  OVERVIEW_ORDER,
  holds,
  renderRelation,
  renderRelationsOverview,
  type Road,
} from '../render/relations.js'
import type { CommandResult } from './result.js'
import { resolveEntity } from './show.js'

export interface RelationsOptions {
  /** A name or a reference, resolved as `show` resolves one. */
  readonly query: string
  /** One relation; absent, every relation that holds something. */
  readonly relation?: OwnRelation
  /** The other end: every path between the two. Never with `relation`. */
  readonly to?: string
  /** How many declared hops; each relation's own default otherwise. */
  readonly depth?: number
  /**
   * Printed under an answer to a question (`ask`), where `--depth` is not an
   * option: a bound then names the whole command that goes further.
   */
  readonly asked?: boolean
}

/**
 * Every relation of one entity, computed from the declarations and printed
 * with its paths — no model, no key (`context/graph/relations.ts`). A name
 * that names nothing, or several entities, is `show`'s negative answer, word
 * for word; a relation that holds nothing is said to be empty, and is a
 * negative answer too, as a filter matching nothing is on `graph`. Between
 * two entities, a path or an entity both reach is an answer; a near miss
 * alone is not, since it reaches nothing (`holds`).
 */
export function runRelations(graph: EntityGraph, options: RelationsOptions): CommandResult {
  const found = resolveEntity(graph, options.query)
  if ('text' in found) return found
  const ref = refOf(found.entity)
  const depth = options.depth === undefined ? {} : { depth: options.depth }
  const road: Road = options.asked === true ? 'answer' : 'command'

  if (options.to !== undefined) {
    const other = resolveEntity(graph, options.to)
    if ('text' in other) return other
    const to = refOf(other.entity)
    if (to === ref) {
      return {
        text: `"${options.query}" and "${options.to}" are the same entity: ${ref}`,
        found: false,
      }
    }
    return answered(relationsOf(graph, ref, 'between', { ...depth, to }), road)
  }

  if (options.relation !== undefined) {
    return answered(relationsOf(graph, ref, options.relation, depth), road)
  }

  const results = OVERVIEW_ORDER.flatMap(
    (relation) => relationsOf(graph, ref, relation, depth) ?? [],
  )
  return {
    text: renderRelationsOverview(stepOf(found.entity), results, road),
    found: results.some(holds),
  }
}

/**
 * A relation of an entity the graph holds is always computed; `undefined`
 * here would be a resolved name the graph no longer answers to.
 */
function answered(result: RelationResult | undefined, road: Road): CommandResult {
  if (result === undefined) return { text: 'No entity matches that question.', found: false }
  return { text: renderRelation(result, road), found: holds(result) }
}
