import { refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import type { CatalogueEntity } from '../../core/schemas/entity.js'
import { NOWHERE, renderEntityDetail } from '../render/entity.js'
import type { CommandResult } from './result.js'

/**
 * A bare name resolves to a reference; an ambiguous one lists the candidates
 * instead of picking the first. Declare, never infer (design 4.1). `said` is
 * what a reference naming nothing is called, which `main` chooses by the
 * source (`NOWHERE`).
 */
export function runShow(graph: EntityGraph, query: string, said: string = NOWHERE): CommandResult {
  const found = resolveEntity(graph, query)
  if ('text' in found) return found
  return { text: renderEntityDetail(graph, found.entity, said), found: true }
}

/**
 * What a name or a reference typed on the command line names: an entity, or
 * the negative answer to print instead — no entity by that name, or every
 * entity whose name holds it. `show` and `relations` resolve through this one
 * function, so a name means the same entity to both, and an ambiguous one is
 * refused by both in the same words.
 */
export function resolveEntity(
  graph: EntityGraph,
  query: string,
): { entity: CatalogueEntity } | CommandResult {
  const byRef = graph.get(query)
  if (byRef !== undefined) return { entity: byRef }

  // A name two entities carry — a component and the Resource of its API, say
  // — names neither: which one the reader meant is theirs to say, with the
  // reference. Only the entities of exactly that name are listed then.
  const named = graph.all().filter((entity) => entity.metadata.name === query)
  if (named.length === 1) return { entity: named[0] as CatalogueEntity }

  const candidates =
    named.length > 1
      ? [...named].sort((left, right) => refOf(left).localeCompare(refOf(right), 'en'))
      : graph.search({ nameContains: query })
  if (candidates.length === 0) return { text: `No entity named "${query}".`, found: false }

  // Ambiguous is not found: the query resolved no entity, and a caller that
  // treated this as success would be picking the first candidate by accident.
  const lines = candidates.map((entity) => `  ${refOf(entity)}`)
  return {
    text: [`"${query}" matches ${candidates.length} entities:`, ...lines].join('\n'),
    found: false,
  }
}
