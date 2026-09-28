import type { Ignored, PrePassRule, Rejection } from '../../context/provider.js'
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
 * most `REFS` refs. Pure: cli/ prints them from 1.5.
 */

const VALUE_LENGTH = 80
const REASON_LENGTH = 200
const VALUES = 5
const REFS = 3
const REASONS = 5

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
