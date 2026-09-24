import type { Overview, Tally } from '../../context/graph/overview.js'
import { TAG_LENGTH } from './entity.js'
import { oneLine } from './plain.js'

/**
 * The `overview` answer, as a reader sees it. The model chose it; every word
 * of it is written here, from `overviewOf`'s figures (ADR-0007).
 *
 * Plain text, for the reason the table is: it is piped, grepped and pasted.
 * No colour, no trailing space, and every list cut at the same length with
 * the remainder counted — a list that stops without saying so is read as
 * complete. Names come from files, so each is flattened like any other text
 * this tool did not write: a Component's `spec.type` and a set-aside kind are
 * free strings, and a terminal obeys what is in them. A label is cut at
 * `label` — one long name would otherwise pad every row of its section to its
 * width — and a tag at Backstage's own 63, as `show` cuts it; either cut ends
 * in `…`.
 */
export const OVERVIEW_LIMITS = { rows: 5, label: 100, description: 80 } as const

/**
 * Where the overview was read from. `repo` is the repository's name — its
 * folder's, which `main` resolves, so `--repo .` reads as the folder it is and
 * not as a dot. No `repo` is the demo SI, an absence.
 */
export interface OverviewSource {
  repo?: string
}

/** A label, a count, and what is counted when the section title does not say. */
type Entry = readonly [label: string, value: string, unit?: string]

const INDENT = '  '

/** Flattened and cleaned, not cut: a headline's path and a reference are read whole. */
const cell = (text: string): string => oneLine(text, Number.POSITIVE_INFINITY)

/** A row's label: cleaned, and cut at `max`. */
const label = (text: string, max: number = OVERVIEW_LIMITS.label): string => oneLine(text, max)

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`

const tallied = (tallies: readonly Tally[], max: number = OVERVIEW_LIMITS.label): Entry[] =>
  tallies.map(({ name, count }) => [label(name, max), String(count)] as const)

/**
 * A tag or a system that is nothing once cleaned — blank, or only what a
 * terminal obeys — names nothing, and a row for it would be an empty label.
 * Judged after cleaning, as `show` judges it.
 */
const named = (tallies: readonly Tally[]): Tally[] =>
  tallies.filter(({ name }) => label(name) !== '')

/**
 * Aligned `label  value` lines: the first few entries, then how many were cut,
 * then `pinned`. A pinned line is never cut — the entities that declare no
 * environment are a fact about the catalogue, not one more environment
 * competing for a place — and it is measured with the list it follows.
 */
function rows(entries: readonly Entry[], pinned?: Entry): string[] {
  const shown = entries
    .slice(0, OVERVIEW_LIMITS.rows)
    .map(([name, value, unit]): Entry =>
      unit === undefined ? [label(name), value] : [label(name), value, unit],
    )
  const measured = pinned === undefined ? shown : [...shown, pinned]
  const labels = Math.max(...measured.map(([name]) => name.length))
  const values = Math.max(...measured.map(([, value]) => value.length))
  const line = ([name, value, unit]: Entry): string =>
    `${INDENT}${name.padEnd(labels)}  ${value.padStart(values)}${unit === undefined ? '' : ` ${unit}`}`

  const lines = shown.map(line)
  const hidden = entries.length - shown.length
  if (hidden > 0) lines.push(`${INDENT}+${String(hidden)} more`)
  if (pinned !== undefined) lines.push(line(pinned))
  return lines
}

export function renderOverview(overview: Overview, source: OverviewSource): string {
  const from =
    source.repo === undefined
      ? 'the demo SI, a fictional company'
      : `the repository ${cell(source.repo)}`
  const blocks: string[][] = [
    [`Overview of ${from}: ${plural(overview.entities, 'entity', 'entities')}`],
  ]

  if (overview.entities === 0) {
    blocks.push(['It declares no entity.'])
  } else {
    const { declared, undeclared } = overview.environments
    blocks.push(
      ['kinds', ...rows(tallied(overview.kinds))],
      ['types', ...rows(tallied(overview.types))],
      [
        'environments',
        ...rows(
          tallied(declared),
          undeclared > 0 ? ['(undeclared)', String(undeclared)] : undefined,
        ),
      ],
      ['owners', ...rows(tallied(overview.owners))],
      systems(overview.systems),
      tagged(named(overview.tags)),
      described(overview.described, overview.entities),
      rights(overview.rights),
      reached(overview.reached),
      dangling(overview.dangling),
    )
  }

  // What the reader could not turn into entities. Said here as well as on
  // stderr: an overview that counted only what it could read would describe a
  // smaller catalogue than the one the user has.
  const { setAside, rejected } = overview
  if (setAside.total > 0) {
    blocks.push([
      `not loaded  ${plural(setAside.total, 'document', 'documents')} this tool does not model`,
      ...rows(
        tallied(setAside.kinds),
        setAside.unkinded > 0 ? ['not an entity', String(setAside.unkinded)] : undefined,
      ),
    ])
  }
  if (rejected > 0) {
    blocks.push([
      `rejected  ${plural(rejected, 'document', 'documents')}; each is named on a skipped line on stderr`,
    ])
  }

  return blocks.map((block) => block.join('\n')).join('\n\n')
}

/**
 * `(none)` pinned like `(undeclared)` is under environments: the entities in
 * no system are a fact about the catalogue, not one more system competing for
 * a place. When no entity declares one, one line says so rather than a list
 * whose only row is the absence.
 */
function systems({ declared, none }: Overview['systems']): string[] {
  const shown = named(declared)
  // An entity whose system names nothing once cleaned is in none a reader can see.
  const total = (tallies: readonly Tally[]): number =>
    tallies.reduce((sum, { count }) => sum + count, 0)
  const outside = none + total(declared) - total(shown)
  if (shown.length === 0) return ['systems  none declared']
  return ['systems', ...rows(tallied(shown), outside > 0 ? ['(none)', String(outside)] : undefined)]
}

/** Cut at Backstage's 63, as `show` cuts a tag. */
function tagged(tags: readonly Tally[]): string[] {
  if (tags.length === 0) return ['tags  none']
  return ['tags', ...rows(tallied(tags, TAG_LENGTH))]
}

/**
 * What a few entities are, in the words their own files wrote — the one part
 * of the overview that is prose, and not the model's. One line each, cut at
 * `OVERVIEW_LIMITS.description`, and the remainder counted.
 */
function described(all: Overview['described'], total: number): string[] {
  // Judged once cleaned: a description that is only a clear-screen describes
  // nothing, and counting it would claim an entity says what it is.
  const entries = all.flatMap(({ ref, description }) => {
    const text = oneLine(description, OVERVIEW_LIMITS.description)
    return text === '' ? [] : [[cell(ref), text] as const]
  })
  if (entries.length === 0) return ['entities  none carries a description']
  const shown = entries.slice(0, OVERVIEW_LIMITS.rows)
  const width = Math.max(...shown.map(([ref]) => ref.length))
  const lines = shown.map(([ref, text]) => `${INDENT}${ref.padEnd(width)}  ${text}`)
  const hidden = entries.length - shown.length
  if (hidden > 0) lines.push(`${INDENT}+${String(hidden)} more`)
  const verb = entries.length === 1 ? 'carries' : 'carry'
  return [`entities  ${String(entries.length)} of ${String(total)} ${verb} a description`, ...lines]
}

function rights(counts: Overview['rights']): string[] {
  if (counts.total === 0) return ['rights  none']
  const levels: Array<readonly [string, number]> = [
    ['read', counts.read],
    ['readwrite', counts.readwrite],
    // A levelled right stating no level, and a right with no level to state,
    // are two different facts, and only the first is something to fix.
    ['level undeclared', counts.undeclared],
    ['no level to state', counts.unlevelled],
  ]
  return [
    `rights  ${String(counts.total)}`,
    ...rows(levels.filter(([, count]) => count > 0).map(([name, count]) => [name, String(count)])),
  ]
}

/**
 * Services and rights both, on every line: a repository whose services are
 * declared elsewhere has grants reaching its databases and no service, and a
 * bare "none" would say nothing reaches them.
 */
function reached(objects: Overview['reached']): string[] {
  if (objects.length === 0) return ['most reached  no service or right reaches an object']
  return [
    'most reached',
    ...rows(
      objects.map(({ ref, services, rights }) => [
        ref,
        String(services),
        `${services === 1 ? 'service' : 'services'}, ${plural(rights, 'right', 'rights')}`,
      ]),
    ),
  ]
}

function dangling(references: Overview['dangling']): string[] {
  if (references.length === 0) return ['dangling references  none']
  const shown = references.slice(0, OVERVIEW_LIMITS.rows)
  const lines = shown.map(({ from, to }) => `${INDENT}${cell(from)} → ${cell(to)}`)
  const hidden = references.length - shown.length
  if (hidden > 0) lines.push(`${INDENT}+${String(hidden)} more`)
  return [`dangling references  ${String(references.length)}`, ...lines]
}
