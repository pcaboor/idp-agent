import type { SiSummary, Vocabulary, VocabularyCounts } from '../context/graph/summary.js'
import { scopeWords } from '../context/provider.js'

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
 * The most values of one vocabulary list the Supervisor and the Analyst are
 * shown (review, domain-backstage-8). A catalogue of 300 Groups put 300
 * owners in every prompt of theirs; a list of 30 or fewer, as every demo list
 * is, prints exactly as it did, so no recorded digest moves.
 */
export const VOCABULARY_LIST_LIMIT = 30

/**
 * The values as listed, each with how often it came: each flattened, then the
 * ones that read the same given once, in the order they came, their counts
 * summed, and one that reads as nothing left out.
 */
const listed = (
  values: readonly string[],
  counts: ReadonlyMap<string, number> | undefined,
): Map<string, number> => {
  const shown = new Map<string, number>()
  for (const value of values) {
    const flat = vocabularyValue(value)
    if (flat === '') continue
    shown.set(flat, (shown.get(flat) ?? 0) + (counts?.get(value) ?? 1))
  }
  return shown
}

/** Code-unit order, as `sorted` in `context/graph/summary.ts` orders a list. */
const byValue = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** One list as the prompt shows it. */
const shownList = (
  values: readonly string[],
  counts: ReadonlyMap<string, number> | undefined,
): { values: string[]; more: number } => {
  const all = listed(values, counts)
  if (counts === undefined || all.size <= VOCABULARY_LIST_LIMIT) return { values: [...all.keys()], more: 0 }
  const kept = [...all]
    // The most frequent first, a tie broken by value: the same 30 on every run.
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || byValue(left, right))
    .slice(0, VOCABULARY_LIST_LIMIT)
    .map(([value]) => value)
    .sort(byValue)
  return { values: kept, more: all.size - kept.length }
}

/**
 * Each list as the prompt shows it: flattened, deduplicated, and — given the
 * counts — past 30 the 30 most frequent, a tie broken by value, alphabetically,
 * with how many more. Without the counts every value is kept, as the
 * Architect's and init's summaries keep them. This is what the commentary
 * check is handed: a value the model was shown is one it read (ADR-0008).
 */
export function shownVocabulary(
  vocabulary: Vocabulary,
  counts?: VocabularyCounts,
): { [K in keyof Vocabulary]: { values: string[]; more: number } } {
  return {
    kinds: shownList(vocabulary.kinds, counts?.kinds),
    types: shownList(vocabulary.types, counts?.types),
    environments: shownList(vocabulary.environments, counts?.environments),
    owners: shownList(vocabulary.owners, counts?.owners),
  }
}

/**
 * The prompt text the model sees about the SI. Deterministic bytes: the
 * recording digest depends on it, so an unstable ordering here would warn on
 * every replay. Computed in `context/` and handed over as plain data — an
 * agent never holds a graph.
 *
 * With `counts`, each list is capped (`shownVocabulary`): the Supervisor's and
 * the Analyst's summary, which may be a whole company catalogue's. Without,
 * every value is printed, as the Architect's and init's are: they read a
 * declarations repository, and what the Architect is shown is not moved.
 */
export function formatSummary(
  summary: SiSummary,
  vocabulary: Vocabulary,
  counts?: VocabularyCounts,
): string {
  const shown = shownVocabulary(vocabulary, counts)
  const list = (label: string, { values, more }: { values: string[]; more: number }): string =>
    `  ${label}: ${values.length === 0 ? '(none declared)' : values.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`

  return [
    'si:',
    `  entities: ${summary.entities}`,
    `  components: ${summary.components}`,
    `  resources: ${summary.resources}`,
    // The organisation, only when the graph holds one: a source that holds
    // none is summarised byte for byte as it was before the organisation was read.
    ...(summary.organisation === undefined
      ? []
      : [
          `  organisation: groups ${summary.organisation.groups}, users ${summary.organisation.users}, ` +
            `systems ${summary.organisation.systems}, domains ${summary.organisation.domains}`,
        ]),
    `  dangling references: ${summary.danglingReferences}`,
    'vocabulary:',
    list('kinds', shown.kinds),
    list('types', shown.types),
    list('environments', shown.environments),
    list('owners', shown.owners),
    // Only when a catalogue was read in part: a whole source's summary is the
    // one every recording was made against.
    ...(summary.partial === undefined || summary.partial.length === 0 ? [] : [readInPart(summary.partial)]),
  ].join('\n')
}

/**
 * The one line that tells a model the catalogue was read in part: which reads
 * stopped at which bound, and that a reference past it is not loaded — so a
 * miss is not taken for a fact about the catalogue, nor a reference past the
 * bound for one declared nowhere. The bound in the words stderr and stdout
 * use; never a count.
 */
function readInPart(partial: NonNullable<SiSummary['partial']>): string {
  const reads = partial.map(
    ({ scope, limit }) => `${scopeWords(scope)} past this version's bound of ${limit.toLocaleString('en-US')}`,
  )
  return (
    `The catalogue was read in part: ${reads.join(' and ')} were not loaded; ` +
    'a reference to one is not loaded, never declared nowhere.'
  )
}
