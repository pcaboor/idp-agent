import { refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import { renderEntityDetail } from '../render/entity.js'
import type { CommandResult } from './result.js'

/**
 * A bare name resolves to a reference; an ambiguous one lists the candidates
 * instead of picking the first. Declare, never infer (design 4.1).
 */
export function runShow(graph: EntityGraph, query: string): CommandResult {
  const exact = graph.get(query) ?? graph.all().find((entity) => entity.metadata.name === query)
  if (exact !== undefined) return { text: renderEntityDetail(graph, exact), found: true }

  const candidates = graph.search({ nameContains: query })
  if (candidates.length === 0) return { text: `No entity named "${query}".`, found: false }

  // Ambiguous is not found: the query resolved no entity, and a caller that
  // treated this as success would be picking the first candidate by accident.
  const lines = candidates.map((entity) => `  ${refOf(entity)}`)
  return {
    text: [`"${query}" matches ${candidates.length} entities:`, ...lines].join('\n'),
    found: false,
  }
}
