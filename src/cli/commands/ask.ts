import { answerQuestion } from '../../agents/analyst.js'
import { ClassificationError, classify, type Classification } from '../../agents/supervisor.js'
import { formatSummary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import { summariseGraph } from '../../context/graph/summary.js'
import { ENV_ANNOTATION, refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import { overviewOf, type Unread } from '../../context/graph/overview.js'
import type { Vocabulary } from '../../core/schemas/vocabulary.js'
import {
  checkCommentary,
  type CheckedCommentary,
  type KnownEntity,
} from '../../core/answer/commentary.js'
import type { CatalogueEntity } from '../../core/schemas/entity.js'
import { QUERY_LIMITS, type Answer } from '../../core/schemas/query.js'
import type { EventSink } from '../../agents/events.js'
import type { LlmClient } from '../../llm/client.js'
import { renderEntityDetail } from '../render/entity.js'
import { renderOverview, type OverviewSource } from '../render/overview.js'
import { inertLine, oneLine } from '../render/plain.js'
import { renderTable } from '../render/table.js'
import type { CommandResult } from './result.js'

/**
 * Where the graph was read from, and what the reader could not turn into it.
 * Only the overview prints these; `main` has them, so it hands them over
 * rather than this command reading anything a second time.
 */
export interface AskSource extends OverviewSource, Unread {}

/** What `ask` and the one gesture, `idpa "<phrase>"`, both hand over. */
export interface AskOptions {
  readonly graph: EntityGraph
  readonly client: LlmClient
  /** The request, in the user's own words. */
  readonly intent: string
  readonly source: AskSource
  readonly emit: EventSink
  readonly err: (chunk: string) => void
  /**
   * Whether stdout is a terminal that wants colour (`colourOf` in `main`):
   * the model's lines are dimmed there. Absent is no colour.
   */
  readonly colour?: boolean
  /** `--quiet`: the verified block alone — no commentary, and no line about it. */
  readonly quiet?: boolean
}

/**
 * The model chooses which question to ask the graph; the engine answers it and
 * prints it. What the model wrote reaches stdout in one form only: the
 * commentary around the engine's block, each sentence checked against what the
 * tools returned, cleaned, bounded and marked `› ` as the model's (ADR-0008).
 * Its other words — an `unanswerable` reason, the Supervisor's refusal to
 * classify — go to stderr as one cleaned, bounded line each (design § 5.2,
 * ADR-0007).
 *
 * `ask` is the command that forces the read road, so a change request is
 * understood and declined here, pointing at the gesture that previews it.
 */
export async function runAsk(options: AskOptions): Promise<CommandResult> {
  return classified(options, async () => {
    // Understood, and declined: `ask` only reads. Not a failed query.
    options.err('that is a change request; run it as idpa "<phrase>" to preview the plan\n')
    return { text: '', found: false, unsupported: true }
  })
}

/**
 * The Supervisor's one decision, taken once: a question is answered here, and
 * a change is handed to `change` — `ask`'s refusal, or the entry's preview
 * (`entry.ts`). One function for both, so the question road of `idpa
 * "<phrase>"` is `ask`'s to the byte: the same summary, the same classifier
 * turn, the same Analyst, the same exit codes.
 */
export async function classified(
  options: AskOptions,
  change: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const { graph, client, intent, emit, err } = options
  const { summary, vocabulary } = summariseGraph(graph)
  const summaryText = formatSummary(summary, vocabulary)

  let classification: Classification
  try {
    classification = await classify(client, { intent, summary: summaryText }, emit)
  } catch (error) {
    if (!(error instanceof ClassificationError)) throw error
    // It quotes what the Supervisor said instead of a word: the model's text.
    err(`${oneLine(error.message)}\n`)
    return { text: '', found: false, unsupported: true }
  }

  switch (classification) {
    case 'MUTATION':
      return change()
    case 'QUESTION':
      return answered(options, summaryText, vocabulary)
    default: {
      const exhaustive: never = classification
      return exhaustive
    }
  }
}

/**
 * The Analyst over the graph, shown the summary the Supervisor was shown, and
 * its answer printed: the engine's block, framed by the model's commentary
 * once the engine has checked it.
 */
async function answered(
  options: AskOptions,
  summaryText: string,
  vocabulary: Vocabulary,
): Promise<CommandResult> {
  const { graph, client, intent, emit } = options
  // The Analyst's registry: Backstage's APIs are found and read, and the
  // Architect's, which proposes neither, stays the one it was (`buildTools`).
  const tools = buildTools(graph, { apis: true })
  const { answer, witnessed, truncated } = await answerQuestion(
    client,
    tools,
    { intent, summary: summaryText, vocabulary: '' },
    emit,
  )
  const result = block(options, answer, truncated)
  if (answer.outcome === 'unanswerable' || options.quiet === true) return result

  const commentary = checkCommentary(answer, {
    entities: graph.all().map(known),
    witnessed,
    vocabulary: [
      ...vocabulary.kinds,
      ...vocabulary.types,
      ...vocabulary.environments,
      ...vocabulary.owners,
    ],
    question: intent,
    clean: (text) => inertLine(text, Number.POSITIVE_INFINITY),
  })
  const left = leftOut(commentary)
  if (left !== undefined) options.err(`${left}\n`)
  return { ...result, text: framed(result.text, commentary, options.colour === true) }
}

/** The engine's block for an answer: what `ask` printed before there was commentary. */
function block(options: AskOptions, answer: Answer, truncated: number): CommandResult {
  const { graph, source, err } = options
  switch (answer.outcome) {
    case 'unanswerable':
      // The model's own prose (review finding security-4): cleaned, and kept
      // to the one line a reason is, so it cannot draw anything under it. The
      // bound is the schema's, so an honest reason is never cut here.
      err(`cannot answer: ${oneLine(answer.reason, QUERY_LIMITS.maxReason)}\n`)
      return { text: '', found: false, unsupported: true }
    case 'nothing':
      return { text: 'No entity matches that question.', found: false }
    case 'overview':
      // Chosen by the model, written by the engine: every figure comes from
      // the graph and the reader, and nothing from the conversation. Whatever
      // the search cut on the way is not part of it, so no truncation line.
      return { text: renderOverview(overviewOf(graph, source), source), found: true }
    case 'entities':
      return renderEntities(graph, answer.refs, truncated)
    default: {
      const exhaustive: never = answer
      return exhaustive
    }
  }
}

function renderEntities(
  graph: EntityGraph,
  refs: readonly string[],
  truncated: number,
): CommandResult {
  // Re-read from the graph and sorted: the model's ordering is not one anybody
  // verified, and the entity it named is not the entity we print unless the
  // graph still holds it.
  const found = [...refs]
    .sort()
    .map((ref) => graph.get(ref))
    .filter((entity): entity is CatalogueEntity => entity !== undefined)

  if (found.length === 0) return { text: 'No entity matches that question.', found: false }
  if (found.length === 1) {
    return { text: withTruncation(renderEntityDetail(graph, found[0]!), truncated), found: true }
  }

  const rows = found.map((entity) => [
    entity.metadata.name,
    entity.kind,
    entity.spec.type,
    entity.metadata.annotations[ENV_ANNOTATION] ?? '-',
    entity.spec.owner,
  ])
  return {
    text: withTruncation(renderTable(['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER'], rows), truncated),
    found: true,
  }
}

/**
 * An entity as the commentary check needs it: every reference and name the
 * graph holds, and what each declares that a sentence about it may quote.
 */
function known(entity: CatalogueEntity): KnownEntity {
  const env = entity.metadata.annotations[ENV_ANNOTATION]
  const access = entity.kind === 'Resource' ? entity.spec.access : undefined
  // A Component's and an API's lifecycle both; an API's definition is not a
  // value a sentence may quote — it is kept as `declared`, and never read.
  const lifecycle = entity.kind === 'Resource' ? undefined : entity.spec.lifecycle
  return {
    ref: refOf(entity),
    name: entity.metadata.name,
    declares: [
      entity.spec.owner,
      entity.spec.type,
      ...(entity.spec.system === undefined ? [] : [entity.spec.system]),
      ...(env === undefined ? [] : [env]),
      ...(lifecycle === undefined ? [] : [lifecycle]),
      ...(access === undefined ? [] : [access]),
      ...(entity.metadata.tags ?? []),
    ],
  }
}

/**
 * What marks a line as the model's. The engine's blocks never start with it —
 * a table starts with its header, a card with a name, the overview with its
 * headline — so the mark survives a pipe with no colour, where the dimming
 * does not.
 */
const MODEL = '› '

/** SGR 2, faint, and 22, back to normal intensity: nothing else is touched. */
const dim = (line: string): string => `\u001B[2m${line}\u001B[22m`

/**
 * The block, with the introduction above it and the conclusion under it, a
 * blank line between each. The block's bytes are the ones printed without
 * commentary; one conclusion sentence per line, so every line carries the mark.
 */
function framed(text: string, commentary: CheckedCommentary, colour: boolean): string {
  const mark = (line: string): string => (colour ? dim(`${MODEL}${line}`) : `${MODEL}${line}`)
  return [
    ...(commentary.intro === undefined ? [] : [mark(commentary.intro)]),
    text,
    ...(commentary.conclusion.length === 0 ? [] : [commentary.conclusion.map(mark).join('\n')]),
  ].join('\n\n')
}

/** How many names the stderr line quotes before it counts the rest. */
const MAX_QUOTED = 5
/** A quoted name's bound: it is an identifier the model wrote, not a reference we print. */
const NAME_LIMIT = 60

/**
 * The one line that says the engine left sentences out, or `undefined` when it
 * left none out for what they named. A sentence cut for length is not said:
 * it named nothing unread, and the bound is the check's own, not a finding.
 */
function leftOut(commentary: CheckedCommentary): string | undefined {
  const unread = commentary.dropped.filter((drop) => drop.why === 'unread')
  if (unread.length === 0) return undefined
  const names = [...new Set(unread.flatMap((drop) => drop.names))].map((name) =>
    inertLine(name, NAME_LIMIT),
  )
  const quoted = names.slice(0, MAX_QUOTED)
  const rest = names.length - quoted.length
  const listed =
    rest > 0
      ? `${quoted.join(', ')} and ${String(rest)} more`
      : quoted.length === 1
        ? (quoted[0] ?? '')
        : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1) ?? ''}`
  const sentences =
    unread.length === 1
      ? 'that sentence was left out'
      : `those ${String(unread.length)} sentences were left out`
  return `! the model's commentary named ${listed}, which no tool returned; ${sentences}`
}

/**
 * A short list that does not say it is short is worse than an error: the
 * reader leaves with a wrong answer believing it complete. The tools tell the
 * model when they cut rows; this is where the reader is told too.
 */
function withTruncation(text: string, truncated: number): string {
  if (truncated === 0) return text
  return `${text}\n\n${truncated} further row(s) were not shown; narrow the question to see them.`
}
