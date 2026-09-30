import { ENV_ANNOTATION, type EntityGraph } from '../../context/graph/entity-graph.js'
import type { CatalogueEntity } from '../../core/schemas/entity.js'
import { missIn, partialClosing } from '../render/catalogue-read.js'
import { renderTable } from '../render/table.js'
import type { CommandResult } from './result.js'

export interface GraphOptions {
  env?: string
  type?: string
  /** Backstage's API among them: the read model's kinds, not only those this tool writes. */
  kind?: CatalogueEntity['kind']
}

/** How many references into what a bound left out `graph` lists before it counts the rest. */
const NOT_LOADED_ROWS = 25

export function runGraph(graph: EntityGraph, options: GraphOptions): CommandResult {
  const matches = graph.search({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
  })

  // A filter that matches nothing is a fact, not a success: say so, and let a
  // script tell the difference.
  if (matches.length === 0) return { text: missIn(graph.partial, 'No entity matches those filters'), found: false }

  const rows = matches.map((entity) => [
    entity.metadata.name,
    entity.kind,
    entity.spec.type,
    entity.metadata.annotations[ENV_ANNOTATION] ?? '-',
    entity.spec.owner,
  ])

  const table = renderTable(['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER'], rows)
  const dangling = graph.danglingReferences()
  const blocks = [table]

  // Surfaced, never pruned: a reference to a missing entity inflates a usage
  // count, and silence here is the failure this tool exists to prevent.
  if (dangling.length > 0) {
    const warnings = dangling.map(({ from, to }) => `  ${from} -> ${to}`)
    blocks.push([`${dangling.length} dangling reference(s):`, ...warnings].join('\n'))
  }
  // Only on a partial graph: what names what a bound left out, apart from the
  // dangling ones, then the line that says the table is part of the catalogue.
  const unloaded = graph.notLoadedReferences()
  if (unloaded.length > 0) {
    const shown = unloaded.slice(0, NOT_LOADED_ROWS).map(({ from, to }) => `  ${from} -> ${to}`)
    const hidden = unloaded.length - shown.length
    blocks.push(
      [
        unloaded.length === 1
          ? '1 reference names what was not loaded:'
          : `${String(unloaded.length)} references name what was not loaded:`,
        ...shown,
        ...(hidden > 0 ? [`  +${String(hidden)} more`] : []),
      ].join('\n'),
    )
  }
  const closing = partialClosing(graph.partial, 'this table')
  if (closing !== undefined) blocks.push(closing)
  return { text: blocks.join('\n\n'), found: true }
}
