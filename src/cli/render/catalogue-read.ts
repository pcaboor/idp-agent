import { scopeWords, type Ignored, type PartialRead, type PrePassRule, type Rejection } from '../../context/provider.js'
import { inertLine } from './plain.js'

/**
 * What a catalogue read says on stderr beside `not loaded:`, grouped by
 * reason with its count (docs/backstage-http-brief.md § 5): one line per
 * rejection would flood a terminal on a catalogue of thousands. One term per
 * category — "set aside by the catalogue read" for the pre-pass, "skipped"
 * for the reader's refusals; the kinds this tool does not model keep their
 * own "not modelled" line, `notLoaded`'s.
 *
 * Every value quoted here — a namespace, a lifecycle, a type, a ref, a
 * location — was chosen by the catalogue, so each is `inertLine`d and cut to
 * `VALUE_LENGTH`, and a reason to `REASON_LENGTH`: nothing a terminal obeys,
 * and the bidi controls spelled out, as the file road's `skipped` line is. A
 * catalogue is a remote source, and no less hostile than a file. A reason
 * lists at most `VALUES` distinct values, then how many more, and a line at
 * most `REFS` refs. Pure: `main` prints them after the notice.
 */

/** The bounds stated above, exported for the test that holds the lines to them. */
export const VALUE_LENGTH = 80
export const REASON_LENGTH = 200
export const VALUES = 5
export const REFS = 3
export const REASONS = 5

const value = (text: string): string => inertLine(text, VALUE_LENGTH)

/** What a pre-pass rule set aside, in the words of the line. */
function termOf(rule: PrePassRule): string {
  switch (rule) {
    case 'namespace':
      return 'outside namespace default'
    case 'lifecycle':
      return 'lifecycle not modelled'
    case 'resource-type':
      return 'resource type not modelled'
    case 'name-case':
      return 'name in upper case'
    case 'api-version':
      return 'apiVersion not read'
    case 'shape':
      return 'shape not read'
    default: {
      const exhaustive: never = rule
      return exhaustive
    }
  }
}

/** Counts of `keys`, most frequent first, then in code-unit order. */
function tally(keys: readonly string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts].sort(([left, a], [right, b]) => b - a || (left < right ? -1 : left > right ? 1 : 0))
}

/** At most `REFS` of `refs`, each cleaned and cut, then `…` when there were more. */
function firstRefs(refs: readonly string[]): string {
  const shown = refs.slice(0, REFS).map(value)
  return refs.length > REFS ? [...shown, '…'].join(', ') : shown.join(', ')
}

/**
 * One line for everything the pre-pass set aside, grouped by rule — the rule
 * with most first — each with its count and its five most frequent values,
 * then the first three refs in the order given (the provider's, by ref).
 * Undefined when the pre-pass set nothing aside: a Group or a System is
 * `not loaded:`'s, never this line's.
 */
export function setAsideLine(ignored: readonly Ignored[]): string | undefined {
  const rows = ignored.filter((row) => row.prePass !== undefined)
  if (rows.length === 0) return undefined
  const byRule = new Map<PrePassRule, string[]>()
  for (const { prePass } of rows) {
    if (prePass === undefined) continue
    const values = byRule.get(prePass.rule) ?? []
    values.push(value(prePass.value))
    byRule.set(prePass.rule, values)
  }
  const groups = [...byRule]
    .map(([rule, values]) => ({ rule, values, term: termOf(rule) }))
    .sort((a, b) => b.values.length - a.values.length || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    .map(({ values, term }) => {
      const counted = tally(values)
      const listed = counted.slice(0, VALUES).map(([each, count]) => `${each} ×${String(count)}`)
      if (counted.length > VALUES) listed.push(`and ${String(counted.length - VALUES)} more`)
      return `${String(values.length)} ${term} (${listed.join(', ')})`
    })
  const refs = rows.map(({ ref, source }) => ref ?? source)
  return `set aside by the catalogue read: ${groups.join(', ')}; first: ${firstRefs(refs)}`
}

/**
 * The reader's refusals, one line per reason — the five most common, each
 * with its count and three refs — then one line counting the rest. A
 * rejection is named by its ref when it has one, else by its source.
 */
export function skippedLines(rejected: readonly Rejection[]): string[] {
  const byReason = new Map<string, string[]>()
  for (const { reason, ref, source } of rejected) {
    const key = inertLine(reason, REASON_LENGTH)
    const refs = byReason.get(key) ?? []
    refs.push(ref ?? source)
    byReason.set(key, refs)
  }
  const reasons = [...byReason].sort(
    ([left, a], [right, b]) => b.length - a.length || (left < right ? -1 : left > right ? 1 : 0),
  )
  const lines = reasons
    .slice(0, REASONS)
    .map(([reason, refs]) => `skipped ${String(refs.length)}: ${reason} (${firstRefs(refs)})`)
  const rest = reasons.slice(REASONS)
  if (rest.length > 0) {
    const count = rest.reduce((sum, [, refs]) => sum + refs.length, 0)
    const other = rest.length === 1 ? 'other reason' : 'other reasons'
    lines.push(`skipped ${String(count)} more, for ${String(rest.length)} ${other}`)
  }
  return lines
}

/** A count as the note writes one: `20,000`. */
const countOf = (count: number): string => count.toLocaleString('en-US')

/**
 * How many a catalogue's bounds left out, over every read that stopped at one:
 * exact when each announced its total, else at least one more for each that
 * did not — the server served more than it announced, and how many is not
 * known. Zero, and exact, for a whole read.
 */
export function pastBoundOf(partial: readonly PartialRead[]): { count: number; exact: boolean } {
  return {
    count: partial.reduce((sum, { read, total }) => sum + (total === undefined ? 1 : total - read), 0),
    exact: partial.every(({ total }) => total !== undefined),
  }
}

/** `this version's bound of 20,000`: one wording for the bound, on stderr, stdout and in a prompt. */
export const boundOf = (limit: number): string => `this version's bound of ${countOf(limit)}`

/**
 * How many of a read's kinds a bound left out, with the verb that agrees:
 * "533 Components, Resources and APIs were", "1 of the Components, Resources
 * and APIs was". `between` goes between the two, as the stderr line's
 * ", beyond this version's bound of 40," does.
 */
const leftOut = (count: number, scope: PartialRead['scope'], between = ''): string =>
  count === 1
    ? `1 of the ${scopeWords(scope)}${between} was not loaded`
    : `${countOf(count)} ${scopeWords(scope)}${between} were not loaded`

/**
 * What the bounds left out, as a sentence of an answer:
 * "533 Components, Resources and APIs were not loaded, past this version's
 * bound of 20,000", or, when the server announced fewer than it served,
 * "… past this version's bound of 40 were not loaded, how many is not known";
 * one clause per read that stopped, joined by "; ". Counts, never names:
 * the part kept is the first in the server's order, and nothing else.
 */
export function partialSentence(partial: readonly PartialRead[]): string {
  return partial
    .map(({ scope, read, total, limit }) =>
      total === undefined
        ? `${scopeWords(scope)} past ${boundOf(limit)} were not loaded, how many is not known`
        : `${leftOut(total - read, scope)}, past ${boundOf(limit)}`,
    )
    .join('; ')
}

/**
 * The stderr line of a catalogue read in part, after the notice and after
 * `not loaded:` — the kinds not modelled, whose words it never begins with
 * (row 17 of the plan): "past the bound: 533 Components, Resources and APIs,
 * beyond this version's bound of 20,000, were not loaded; …".
 */
export function partialLine(partial: readonly PartialRead[]): string {
  const reads = partial.map(({ scope, read, total, limit }) =>
    total === undefined
      ? `${scopeWords(scope)} beyond ${boundOf(limit)} were not loaded, how many is not known`
      : leftOut(total - read, scope, `, beyond ${boundOf(limit)},`),
  )
  return (
    `past the bound: ${reads.join('; ')}; ` +
    'the graph is partial, and a reference to one of them is not loaded, never declared nowhere'
  )
}

/**
 * The closing line of an answer from a partial graph — `graph`'s table,
 * `show`'s card, a relation's block — naming what it holds (`in`): stdout is
 * what a person pipes or pastes, and a partial answer is never silent there.
 * Undefined for a whole graph, whose answer is what it always was.
 */
export function partialClosing(partial: readonly PartialRead[], held: string): string | undefined {
  return partial.length === 0 ? undefined : `partial: ${partialSentence(partial)}; what they declare is not in ${held}`
}

/**
 * A miss, said with the part it looked in: "No entity named "x"" becomes
 * "No entity named "x" in the part of the catalogue read: …." on a partial
 * graph, and is what it always was on a whole one. `miss` is the sentence
 * without its full stop.
 */
export function missIn(partial: readonly PartialRead[], miss: string): string {
  return partial.length === 0 ? `${miss}.` : `${miss} in the part of the catalogue read: ${partialSentence(partial)}.`
}
