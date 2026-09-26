import { ENV_ANNOTATION, type EntityGraph } from '../../context/graph/entity-graph.js'
import type { CatalogueEntity } from '../../core/schemas/entity.js'
import { renderTable } from '../render/table.js'
import type { CommandResult } from './result.js'

export interface GraphOptions {
  env?: string
  type?: string
  /** Backstage's API among them: the read model's kinds, not only those this tool writes. */
  kind?: CatalogueEntity['kind']
}

export function runGraph(graph: EntityGraph, options: GraphOptions): CommandResult {
  const matches = graph.search({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
  })

  // A filter that matches nothing is a fact, not a success: say so, and let a
  // script tell the difference.
  if (matches.length === 0) return { text: 'No entity matches those filters.', found: false }

  const rows = matches.map((entity) => [
    entity.metadata.name,
    entity.kind,
    entity.spec.type,
    entity.metadata.annotations[ENV_ANNOTATION] ?? '-',
    entity.spec.owner,
  ])

  const table = renderTable(['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER'], rows)
  const dangling = graph.danglingReferences()
  if (dangling.length === 0) return { text: table, found: true }

  // Surfaced, never pruned: a reference to a missing entity inflates a usage
  // count, and silence here is the failure this tool exists to prevent.
  const warnings = dangling.map(({ from, to }) => `  ${from} -> ${to}`)
  return {
    text: [table, '', `${dangling.length} dangling reference(s):`, ...warnings].join('\n'),
    found: true,
  }
}
