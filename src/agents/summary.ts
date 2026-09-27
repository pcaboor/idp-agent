import type { SiSummary, Vocabulary } from '../context/graph/summary.js'

/**
 * The most code points of one vocabulary value the prompt carries. Wider than
 * anything a catalogue names — an owner in full is `group:`, a namespace and
 * Backstage's 63 characters — so only a value nobody would write as a type or
 * an environment is ever cut.
 */
export const VOCABULARY_VALUE_LIMIT = 128

/**
 * A control character, a line or paragraph separator, or white space, in any
 * run: what would start a line of the prompt, or hide in one. Named by
 * property rather than by code point, so no script's own spacing is special.
 */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}\s]+/gu

/**
 * One value of the vocabulary as the prompt carries it: on one line, and
 * bounded, the cut said with an ellipsis (gap-ask-grounding-6).
 *
 * A Component's type and the environment annotation are free text in a file
 * anybody can commit, and each is listed on a line of the Supervisor's and
 * the Analyst's opening message: a line break in one wrote a line of the
 * prompt that no catalogue states. A value with nothing to flatten comes back
 * as it was, byte for byte, which is what keeps every recording replaying.
 */
export function vocabularyValue(value: string): string {
  const flat = [...value.replace(BREAKS, ' ').trim()]
  return flat.length > VOCABULARY_VALUE_LIMIT
    ? `${flat.slice(0, VOCABULARY_VALUE_LIMIT).join('')}…`
    : flat.join('')
}

/**
 * The values as listed: each flattened, then the ones that read the same
 * given once, in the order they came, and one that reads as nothing left out.
 */
const listed = (values: readonly string[]): string[] => [
  ...new Set(values.map(vocabularyValue).filter((value) => value !== '')),
]

/**
 * The prompt text the model sees about the SI. Deterministic bytes: the
 * recording digest depends on it, so an unstable ordering here would warn on
 * every replay. Computed in `context/` and handed over as plain data — an
 * agent never holds a graph.
 */
export function formatSummary(summary: SiSummary, vocabulary: Vocabulary): string {
  const list = (label: string, values: readonly string[]): string => {
    const shown = listed(values)
    return `  ${label}: ${shown.length === 0 ? '(none declared)' : shown.join(', ')}`
  }

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
