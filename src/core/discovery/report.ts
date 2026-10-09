import {
  allowed,
  byDesignReason,
  notAnalysedReason,
  type ByDesign,
  type FileStanding,
  type PathNotAnalysed,
  type Walked,
} from './allow.js'
import { parseFailureReason, type Extracted, type ParseFailure } from './extractors.js'
import { ENGINES, type Engine, type Finding, type HostPort, type Reference, type Standing } from './finding.js'
import { DISCOVERY_LIMITS } from './limits.js'
import { ENGINE_TYPE, RULES, type ExtractorName } from './rules.js'
import type { Check, Checked } from './verify.js'

/**
 * The coverage report of stage 8's discovery (brief § 9, plan Task 1.4): what
 * a service's committed configuration states, and what was not read and why.
 * Pure over what the read walked, what the extractors made of each file and
 * what the re-read said of each finding.
 *
 * Every path the walk named lands in exactly one part — analysed, not
 * analysed, or present and not read by design — and what nobody committed is
 * counted and never named: what git does not track, what is staged and never
 * committed, every path under a `HEAD` not listed whole, and a name that is
 * not valid UTF-8 (owner's answers 3 and 5).
 *
 * In slice 1 nothing vouches, nothing is matched and nothing is proposed: the
 * report says what the files state, and its sentence says how many findings
 * the re-read verified, which is what `init`'s exit reads (owner's answer 1,
 * read literally, and answer 7: a value the engine could not read is not
 * counted; `verifiedFindings`). No model is sent any of it.
 */

/** One file a finding came from, as the report names it. */
export interface Analysed {
  readonly path: string
  readonly extractor: ExtractorName
  readonly standing: FileStanding
  /** The findings of it the report lists: those the re-read did not refuse. */
  readonly findings: number
  /** The findings of it the re-read refused, each listed under *findings* by its line and its check. */
  readonly dropped: number
}

/**
 * A finding the re-read refused, named by the check that refused it, never by
 * a value. `path` and `line` are where an extractor read it, from a file the
 * walk opened at `HEAD`, so a path the report may name; both are undefined
 * for a refused ID no extractor of this run made.
 */
export interface DroppedFinding {
  readonly path: string | undefined
  readonly line: number | undefined
  readonly id: string | undefined
  readonly check: Check
  readonly reason: string
}

/** A path not analysed, with its reason, and the parse failure when that is the reason. */
export interface NotAnalysedPath {
  readonly path: string
  readonly why: PathNotAnalysed
  readonly failure?: ParseFailure
}

export interface Coverage {
  readonly head: string | undefined
  readonly selection: Walked['selection']
  readonly analysed: readonly Analysed[]
  /** Reported: those that vouched and those that cannot vouch, in path and line order. */
  readonly findings: readonly Finding[]
  /** The IDs of the findings that vouched. */
  readonly verified: readonly string[]
  /** What the re-read refused, in path and line order: of an analysed file, or of none this run extracted. */
  readonly dropped: readonly DroppedFinding[]
  readonly notAnalysed: readonly NotAnalysedPath[]
  readonly byDesign: Walked['byDesign']
  readonly untracked: number
  /** Staged, never committed: counted, never named. */
  readonly staged: number
  /** `HEAD` not listed whole: every tracked path, counted, none named. */
  readonly unlisted: number
  /** A path `HEAD` holds whose name is not valid UTF-8: counted, never named. */
  readonly unnameable: number
  readonly truncated: boolean
}

const byPath = (a: { readonly path: string }, b: { readonly path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const byPlace = (a: Finding, b: Finding): number =>
  byPath(a, b) || a.lines[0] - b.lines[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The files past the run's finding cap, in the read's order: the first whose
 * findings would carry the run over `maxFindingsPerRun`, and every one after.
 * `discover` asks it before the re-read, so no file past the cap is opened
 * again, and hands what it decided to `coverageOf`, so the report cannot
 * disagree: asked again after a file is extracted once more, it could let in
 * a file nobody read again.
 */
export function pastRunCap(
  opened: readonly string[],
  extracted: ReadonlyMap<string, Extracted>,
  cap: number = DISCOVERY_LIMITS.maxFindingsPerRun,
): ReadonlySet<string> {
  const past = new Set<string>()
  let total = 0
  for (const file of opened) {
    if (past.size > 0) {
      past.add(file)
      continue
    }
    const one = extracted.get(file)
    if (one?.outcome !== 'read') continue
    if (total + one.findings.length > cap) past.add(file)
    else total += one.findings.length
  }
  return past
}

/** Frozen to the last list, so a coverage carried on a `Cleared` is the one rendered. */
function deepFrozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFrozen(inner)
    Object.freeze(value)
  }
  return value
}

/**
 * The coverage of one run: every path the read named, in exactly one part. A
 * file opened is analysed unless its extraction failed or was over a cap, or
 * a finding of it came back `stale` twice — `discover` hands in only the last
 * check, so a `stale` here is the second: *changed during the run*. Its
 * findings are then kept by none. `past` is the run cap as `discover` decided
 * it, and `pastRunCap` of what was extracted when nobody decided it.
 */
export function coverageOf(
  walked: Walked,
  extracted: ReadonlyMap<string, Extracted>,
  checked: readonly Checked[],
  past: ReadonlySet<string> = pastRunCap(walked.opened, extracted),
): Coverage {
  // Where each finding this run extracted was read, by its ID: a refused
  // finding is named by its file and line, never by a value.
  const readAt = new Map<string, { readonly path: string; readonly line: number }>()
  for (const file of walked.opened) {
    const one = extracted.get(file)
    if (one?.outcome !== 'read') continue
    for (const finding of one.findings) readAt.set(finding.id, { path: file, line: finding.lines[0] })
  }
  const byFile = new Map<string, Checked[]>()
  const refused: DroppedFinding[] = []
  for (const one of checked) {
    switch (one.outcome) {
      case 'vouches':
      case 'cannot-vouch':
      case 'stale': {
        const mine = byFile.get(one.finding.path) ?? []
        mine.push(one)
        byFile.set(one.finding.path, mine)
        break
      }
      case 'refused': {
        const at = one.id === undefined ? undefined : readAt.get(one.id)
        refused.push({ path: at?.path, line: at?.line, id: one.id, check: one.check, reason: one.reason })
        break
      }
      default: {
        const _exhaustive: never = one
        throw new Error(`a check of no outcome anybody named (${typeof _exhaustive}), an engine bug`)
      }
    }
  }

  const analysed: Analysed[] = []
  const notAnalysed: NotAnalysedPath[] = walked.notAnalysed.map((entry) => ({ ...entry }))
  const findings: Finding[] = []
  const verified: string[] = []
  const analysedPaths = new Set<string>()
  for (const file of walked.opened) {
    const rule = allowed(file)
    const one = extracted.get(file)
    if (past.has(file)) {
      notAnalysed.push({ path: file, why: 'past-run-cap' })
      continue
    }
    // Opened and handed to no extractor, or a path the allow-list does not
    // name: a defect of the caller's, said as what it is for the reader.
    if (rule === undefined || one === undefined) {
      notAnalysed.push({ path: file, why: 'unreadable' })
      continue
    }
    if (one.outcome === 'parse-failure') {
      notAnalysed.push({ path: file, why: 'parse-failure', failure: one.why })
      continue
    }
    if (one.outcome === 'over-finding-cap') {
      notAnalysed.push({ path: file, why: 'over-finding-cap' })
      continue
    }
    const mine = byFile.get(file) ?? []
    if (mine.some((check) => check.outcome === 'stale')) {
      notAnalysed.push({ path: file, why: 'changed-during-run' })
      continue
    }
    for (const check of mine) {
      if (check.outcome === 'stale' || check.outcome === 'refused') continue
      findings.push(check.finding)
      if (check.outcome === 'vouches') verified.push(check.finding.id)
    }
    analysedPaths.add(file)
    analysed.push({
      path: file,
      extractor: rule.extractor,
      standing: rule.standing,
      findings: mine.length,
      dropped: refused.filter((one) => one.path === file).length,
    })
  }
  // A file not analysed keeps its findings nowhere, its drops included.
  const dropped = refused
    .filter((one) => one.path === undefined || analysedPaths.has(one.path))
    .sort((a, b) => byPath({ path: a.path ?? '' }, { path: b.path ?? '' }) || (a.line ?? 0) - (b.line ?? 0))

  return deepFrozen({
    head: walked.head,
    selection: walked.selection,
    analysed: analysed.sort(byPath),
    findings: findings.sort(byPlace),
    verified,
    dropped,
    notAnalysed: notAnalysed.sort(byPath),
    byDesign: walked.byDesign.map((entry) => ({ ...entry })).sort(byPath),
    untracked: walked.untracked,
    staged: walked.staged,
    unlisted: walked.unlisted,
    unnameable: walked.unnameable,
    truncated: walked.truncated,
  })
}

/** A value the engine could not read (`unparsed`) or would not show (`withheld`): it states nothing. */
const unread = (finding: Finding): boolean => finding.kind === 'unparsed' || finding.kind === 'withheld'

/**
 * The findings the re-read let vouch (`Checked` `vouches`) that hold a value
 * the engine could read: what answer 2's exit reads, and the count the
 * sentence says, so the two never disagree. A name of `5`, one outside npm's
 * grammar or one shaped like a credential vouches — its standing is
 * `evidence` — and states nothing, so it is listed as what it is and not
 * counted (owner's answer 7, 2026-10-06).
 */
export const verifiedFindings = (coverage: Coverage): number => {
  const verified = new Set(coverage.verified)
  return coverage.findings.filter((finding) => verified.has(finding.id) && !unread(finding)).length
}

const isEngine = (kind: string): kind is Engine => (ENGINES as readonly string[]).includes(kind)

/**
 * A verified finding whose rule supports a target and whose kind is an
 * engine: 0 in slice 1, by construction — the sample family is never
 * `evidence`, and an installed client says a kind, not a target. A
 * Kubernetes manifest's connection (2.4) is the first that makes it more; one
 * naming this machine alone is `local`, and one naming another value a
 * `placeholder`, and neither vouches.
 */
export const evidencedDependencies = (coverage: Coverage): number => {
  const verified = new Set(coverage.verified)
  return coverage.findings.filter(
    (finding) =>
      verified.has(finding.id) &&
      isEngine(finding.kind) &&
      (RULES[finding.rule].supports as readonly string[]).includes('target'),
  ).length
}

/**
 * Whether the run read everything: nothing not analysed, nothing set aside by
 * design, nothing uncounted or unnamed, `HEAD` listed whole, the walk not cut
 * short, inside a git repository. A README is enough to make it false, which
 * is true of every real repository in slice 1, and said rather than hidden.
 */
export const isComplete = (coverage: Coverage): boolean =>
  coverage.selection === 'git' &&
  coverage.notAnalysed.length === 0 &&
  coverage.byDesign.length === 0 &&
  coverage.untracked === 0 &&
  coverage.staged === 0 &&
  coverage.unlisted === 0 &&
  coverage.unnameable === 0 &&
  !coverage.truncated

/** The paths the sentence counts as not analysed: every one named there, and every one counted. */
const notAnalysedCount = (coverage: Coverage): number =>
  coverage.notAnalysed.length +
  coverage.byDesign.length +
  coverage.untracked +
  coverage.staged +
  coverage.unlisted +
  coverage.unnameable

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`

/**
 * "no dependency evidenced in N files analysed (V findings verified); M paths
 * not analysed; K references configured outside this repository". The note's
 * sentence for an empty result word for word, and in parentheses the count
 * the exit reads, so a script that reads exit 0 beside "no dependency
 * evidenced" reads why in the same line. Never "no dependencies".
 */
export function coverageSentence(coverage: Coverage): string {
  const evidenced = evidencedDependencies(coverage)
  const verified = verifiedFindings(coverage)
  const references = coverage.findings.filter((finding) => finding.standing === 'placeholder').length
  const dependencies =
    evidenced === 0 ? 'no dependency evidenced' : `${count(evidenced, 'dependency', 'dependencies')} evidenced`
  const findings = verified === 0 ? 'no finding verified' : `${count(verified, 'finding', 'findings')} verified`
  return (
    `${dependencies} in ${count(coverage.analysed.length, 'file', 'files')} analysed (${findings}); ` +
    `${count(notAnalysedCount(coverage), 'path', 'paths')} not analysed; ` +
    `${count(references, 'reference', 'references')} configured outside this repository`
  )
}

/** One line of a part: the place a finding was read, what it says, and its rendering, each already quoted. */
export interface CoverageLine {
  readonly at?: string
  readonly text: string
  readonly shown?: string
}

export interface CoverageSection {
  readonly label: string
  readonly lines: readonly CoverageLine[]
}

/** Writes a path, a value or a rendering for its reader, or undefined when that reader cannot be shown it. */
export type Quote = (text: string) => string | undefined

/** Who states a finding, by its standing. */
function whoStates(standing: Standing): string {
  switch (standing) {
    case 'evidence':
      return 'the repository states'
    case 'sample':
      return 'a sample states'
    case 'mention':
      return 'a test, an example or a development dependency mentions'
    case 'placeholder':
      return 'a reference states'
    case 'local':
      return 'a local setting states'
    case 'claimed':
      return 'a claim states'
    default: {
      const _exhaustive: never = standing
      return _exhaustive
    }
  }
}

const NOT_EXPRESSIBLE = ' — found, not expressible: no resource type for it in this registry'

const hostText = (entry: HostPort): string =>
  entry.port === undefined ? entry.host : `${entry.host}:${String(entry.port)}`

/** A Secret or a ConfigMap as the report names one: `secret billing-db-creds, key password`, or every key of it. */
function referenceText(reference: Reference, quote: (text: string) => string): string {
  const source = `${reference.from === 'secret' ? 'secret' : 'config map'} ${quote(reference.name)}`
  return reference.key === undefined ? `every key of ${source}` : `${source}, key ${quote(reference.key)}`
}

/**
 * What a finding says, in the engine's words around the finding's own fields,
 * each written by `quote`. Never `shown`, which is said on its own line, and
 * never a word of the file's but those its grammars passed.
 */
function sentenceOf(finding: Finding, quote: (text: string) => string): string {
  const fields = finding.fields
  const variable = fields.variable === undefined ? '' : ` (${quote(fields.variable)})`
  const engine = (kind: Engine): string => {
    const expressible = ENGINE_TYPE[kind] === undefined ? NOT_EXPRESSIBLE : ''
    if (finding.rule === 'npm.dependency') {
      const installed = finding.standing === 'evidence' ? 'installed' : 'mentioned'
      return `a ${kind} client is ${installed}: ${quote(fields.package ?? '')}${expressible}`
    }
    const scheme = (fields.scheme ?? kind).toLowerCase()
    if (finding.standing === 'placeholder') {
      const what = kind === 'http' ? `an ${scheme} endpoint` : `a ${kind} connection`
      return `configured outside this repository: ${what}${variable}${expressible}`
    }
    const what =
      kind === 'http'
        ? `an ${scheme} endpoint${fields.url === undefined ? '' : ` at ${quote(fields.url)}`}`
        : [
            kind,
            ...(fields.database === undefined ? [] : [`database ${quote(fields.database)}`]),
            ...(fields.hosts === undefined || fields.hosts.length === 0
              ? []
              : [`on ${fields.hosts.map((entry) => quote(hostText(entry))).join(', ')}`]),
            ...(fields.account === undefined ? [] : [`as ${quote(fields.account)}`]),
          ].join(' ')
    return `${whoStates(finding.standing)} ${what}${expressible}`
  }
  const kind = finding.kind
  switch (kind) {
    case 'package-name':
      return finding.standing === 'evidence'
        ? `the package is named ${quote(fields.name ?? '')}`
        : `${whoStates(finding.standing)} a package named ${quote(fields.name ?? '')}`
    case 'reference': {
      const where = fields.reference === undefined ? 'a value' : referenceText(fields.reference, quote)
      return finding.standing === 'placeholder'
        ? `configured outside this repository: ${where}${variable}`
        : `${whoStates(finding.standing)} ${where}${variable}`
    }
    case 'unparsed':
      return `a value this version could not read${variable}`
    case 'withheld':
      return `a value shaped like a credential, not shown${variable}`
    case 'postgres':
    case 'mysql':
    case 'mariadb':
    case 'mssql':
    case 'oracle':
    case 'mongodb':
    case 'redis':
    case 'amqp':
    case 'kafka':
    case 'http':
      return engine(kind)
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/**
 * Whether a finding's rendering is shown: a connection the parser read, and
 * not one that names another value. A reference is named and never rendered:
 * no value of it was read.
 */
const rendered = (finding: Finding): boolean =>
  (finding.rule === 'env-file.url' || finding.rule === 'k8s.env-value') &&
  isEngine(finding.kind) &&
  finding.standing !== 'placeholder'

/**
 * `env-file, a sample: 3 findings` — the extractor, the file's standing when
 * it is not evidence, the count, and how many the re-read dropped, if any.
 */
function analysedText(file: Analysed, path: string): string {
  const standing = file.standing === 'evidence' ? '' : file.standing === 'sample' ? ', a sample' : ', a mention'
  const dropped = file.dropped === 0 ? '' : `, ${String(file.dropped)} dropped by the re-read`
  return `${path} (${file.extractor}${standing}: ${count(file.findings, 'finding', 'findings')}${dropped})`
}

/** A group's paths, bounded: the first `maxListed` that `quote` can show, then how many more. */
function listed(paths: readonly string[], quote: Quote): { readonly text: string | undefined; readonly hidden: number } {
  const shown: string[] = []
  let hidden = 0
  for (const path of paths) {
    const quoted = quote(path)
    if (quoted === undefined) hidden += 1
    else shown.push(quoted)
  }
  if (shown.length === 0) return { text: undefined, hidden }
  const more = shown.length - DISCOVERY_LIMITS.maxListed
  return {
    text: `${shown.slice(0, DISCOVERY_LIMITS.maxListed).join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}`,
    hidden,
  }
}

const cannotShow = (hidden: number): CoverageLine => ({
  text: hidden === 1 ? '1 path whose name a body cannot show' : `${String(hidden)} paths whose names a body cannot show`,
})

/** Paths grouped by their reason, in the order each reason is first met, each group bounded. */
function grouped<Why>(
  entries: readonly { readonly path: string; readonly why: Why }[],
  words: (why: Why) => string,
  quote: Quote,
): CoverageLine[] {
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const label = words(entry.why)
    groups.set(label, [...(groups.get(label) ?? []), entry.path])
  }
  const lines: CoverageLine[] = []
  let hidden = 0
  for (const [label, paths] of groups) {
    const group = listed(paths, quote)
    hidden += group.hidden
    if (group.text !== undefined) lines.push({ text: `${label}: ${group.text}` })
  }
  return hidden === 0 ? lines : [...lines, cannotShow(hidden)]
}

const notAnalysedWords = (entry: NotAnalysedPath): string =>
  entry.failure === undefined
    ? notAnalysedReason(entry.why)
    : `${notAnalysedReason(entry.why)} (${parseFailureReason(entry.failure)})`

/** What nobody committed, or the read could not name: counted, never named. */
function countedLines(coverage: Coverage): CoverageLine[] {
  switch (coverage.selection) {
    case 'none':
      return [{ text: "git could not list this repository's files: nothing was read" }]
    case 'walk':
      return [{ text: `not a git repository: ${count(coverage.untracked, 'path', 'paths')}, none analysed, none named` }]
    case 'git':
      return [
        ...(coverage.untracked === 0
          ? []
          : [{ text: `git does not track ${count(coverage.untracked, 'path', 'paths')}, not named` }]),
        ...(coverage.staged === 0
          ? []
          : [{ text: `${count(coverage.staged, 'path', 'paths')} staged and never committed, not named` }]),
        ...(coverage.unnameable === 0
          ? []
          : [
              {
                text:
                  coverage.unnameable === 1
                    ? '1 path whose name is not valid UTF-8, not named'
                    : `${String(coverage.unnameable)} paths whose names are not valid UTF-8, not named`,
              },
            ]),
        ...(coverage.unlisted === 0
          ? []
          : [
              {
                text: `${count(coverage.unlisted, 'path', 'paths')} git tracks, not named: ${notAnalysedReason('head-unlisted')}`,
              },
            ]),
      ]
    default: {
      const _exhaustive: never = coverage.selection
      return _exhaustive
    }
  }
}

/**
 * The six parts of § 9, in order, each a label and its lines. `quote` writes
 * a path, a field's value or a rendering for its reader — spelled out for a
 * terminal, a code span for a body — or returns undefined when that reader
 * cannot be shown it: then it is counted, never named. Both renderings are
 * built from these, so they cannot disagree about what was read.
 * `findings` bounds the findings listed (a body's 100); the terminal lists
 * every one up to the run's cap.
 */
export function coverageSections(
  coverage: Coverage,
  quote: Quote,
  options: { readonly findings?: number } = {},
): readonly CoverageSection[] {
  // A field's value passed its grammar, which no reader's quoting refuses; a
  // value one did is said as a value, never dropped from the sentence.
  const value = (text: string): string => quote(text) ?? 'a value'

  const analysedLines: CoverageLine[] = []
  let analysedHidden = 0
  for (const file of coverage.analysed.slice(0, DISCOVERY_LIMITS.maxListed)) {
    const path = quote(file.path)
    if (path === undefined) analysedHidden += 1
    else analysedLines.push({ text: analysedText(file, path) })
  }
  const moreAnalysed = coverage.analysed.length - DISCOVERY_LIMITS.maxListed
  if (moreAnalysed > 0) analysedLines.push({ text: `and ${String(moreAnalysed)} more` })
  if (analysedHidden > 0) analysedLines.push(cannotShow(analysedHidden))

  const findingLines: CoverageLine[] = []
  const bound = options.findings ?? Number.POSITIVE_INFINITY
  let findingsHidden = 0
  for (const finding of coverage.findings.slice(0, bound)) {
    const path = quote(finding.path)
    if (path === undefined) {
      findingsHidden += 1
      continue
    }
    const shown = rendered(finding) ? quote(finding.shown) : undefined
    findingLines.push({
      at: `${path}:${String(finding.lines[0])}`,
      text: sentenceOf(finding, value),
      ...(shown === undefined ? {} : { shown }),
    })
  }
  const moreFindings = coverage.findings.length - bound
  if (moreFindings > 0) findingLines.push({ text: `and ${count(moreFindings, 'finding', 'findings')} more, not listed here` })
  if (findingsHidden > 0) findingLines.push(cannotShow(findingsHidden))
  // What the re-read refused, at the file and line it was read, bounded as a
  // group's paths are: each analysed file says how many of its own it lost.
  for (const one of coverage.dropped.slice(0, DISCOVERY_LIMITS.maxListed)) {
    const path = one.path === undefined ? undefined : quote(one.path)
    findingLines.push({
      ...(path === undefined || one.line === undefined ? {} : { at: `${path}:${String(one.line)}` }),
      text: `dropped by the re-read, at its ${one.check} check: ${one.reason}`,
    })
  }
  const moreDropped = coverage.dropped.length - DISCOVERY_LIMITS.maxListed
  if (moreDropped > 0) findingLines.push({ text: `and ${String(moreDropped)} more dropped by the re-read` })

  const notAnalysed = [
    ...grouped(coverage.notAnalysed.map((entry) => ({ path: entry.path, why: entry })), notAnalysedWords, quote),
    ...countedLines(coverage),
    ...(coverage.truncated
      ? [
          {
            text:
              `the walk stopped at its budget of ${DISCOVERY_LIMITS.maxDirectories.toLocaleString('en')} folders: ` +
              'what lies past it is neither named nor counted',
          },
        ]
      : []),
  ]
  const byDesign = grouped<ByDesign>(coverage.byDesign, byDesignReason, quote)

  return [
    { label: 'analysed', lines: analysedLines.length === 0 ? [{ text: 'no file' }] : analysedLines },
    { label: 'findings', lines: findingLines.length === 0 ? [{ text: 'none' }] : findingLines },
    {
      label: 'not proposed',
      lines: [{ text: 'every finding: this version reports what the configuration states and proposes nothing from it' }],
    },
    {
      label: 'declared, not evidenced by this repository',
      // True whether or not a declarations repository was found: stderr says
      // which, and this part is carried into a pull request's body too.
      lines: [{ text: 'not compared: this version matches nothing against a declarations repository yet' }],
    },
    { label: 'not analysed', lines: notAnalysed.length === 0 ? [{ text: 'nothing' }] : notAnalysed },
    { label: 'present, not read by design', lines: byDesign.length === 0 ? [{ text: 'nothing' }] : byDesign },
  ]
}

/** The report's first line: what it is, the commit it read (`quote`d), and that it renders and proposes nothing. */
export function coverageHeading(coverage: Coverage, quote: Quote): string {
  const commit = coverage.head === undefined ? undefined : quote(coverage.head.slice(0, 7))
  const read = commit === undefined ? 'at no commit' : `at commit ${commit}`
  return (
    `discovery — what this repository's committed configuration states, read ${read}; ` +
    'renderings, not quotes; nothing is proposed from it in this version'
  )
}
