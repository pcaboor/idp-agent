import { ENV_ANNOTATION, type EntityGraph } from '../../context/graph/entity-graph.js'
import { renderTable } from '../render/table.js'

export interface GraphOptions {
  env?: string
  type?: string
  kind?: 'Component' | 'Resource'
}

export function runGraph(graph: EntityGraph, options: GraphOptions): string {
  const matches = graph.search({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
  })

  if (matches.length === 0) return 'No entity matches those filters.'

  const rows = matches.map((entity) => [
    entity.metadata.name,
    entity.kind,
    entity.spec.type,
    entity.metadata.annotations[ENV_ANNOTATION] ?? '-',
    entity.spec.owner,
  ])

  const table = renderTable(['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER'], rows)
  const dangling = graph.danglingReferences()
  if (dangling.length === 0) return table

  // Surfaced, never pruned: a reference to a missing entity inflates a usage
  // count, and silence here is the failure this tool exists to prevent.
  const warnings = dangling.map(({ from, to }) => `  ${from} -> ${to}`)
  return [table, '', `${dangling.length} dangling reference(s):`, ...warnings].join('\n')
}
