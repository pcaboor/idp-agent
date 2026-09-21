import type { SiSummary, Vocabulary } from '../context/graph/summary.js'

/**
 * The prompt text the model sees about the SI. Deterministic bytes: the
 * recording digest depends on it, so an unstable ordering here would warn on
 * every replay. Computed in `context/` and handed over as plain data — an
 * agent never holds a graph.
 */
export function formatSummary(summary: SiSummary, vocabulary: Vocabulary): string {
  const list = (label: string, values: string[]): string =>
    `  ${label}: ${values.length === 0 ? '(none declared)' : values.join(', ')}`

  return [
    'si:',
    `  entities: ${summary.entities}`,
    `  components: ${summary.components}`,
    `  resources: ${summary.resources}`,
    `  dangling references: ${summary.danglingReferences}`,
    'vocabulary:',
    list('kinds', vocabulary.kinds),
    list('types', vocabulary.types),
    list('environments', vocabulary.environments),
    list('owners', vocabulary.owners),
  ].join('\n')
}
