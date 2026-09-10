import { refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import { renderEntityDetail } from '../render/entity.js'

/**
 * A bare name resolves to a reference; an ambiguous one lists the candidates
 * instead of picking the first. Declare, never infer (design 4.1).
 */
export function runShow(graph: EntityGraph, query: string): string {
  const exact = graph.get(query) ?? graph.all().find((entity) => entity.metadata.name === query)
  if (exact !== undefined) return renderEntityDetail(graph, exact)

  const candidates = graph.search({ nameContains: query })
  if (candidates.length === 0) return `No entity named "${query}".`

  const lines = candidates.map((entity) => `  ${refOf(entity)}`)
  return [`"${query}" matches ${candidates.length} entities:`, ...lines].join('\n')
}
