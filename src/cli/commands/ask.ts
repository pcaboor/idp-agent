import { answerQuestion } from '../../agents/analyst.js'
import { ClassificationError, classify, type Classification } from '../../agents/supervisor.js'
import { formatSummary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import { summariseGraph } from '../../context/graph/summary.js'
import { ENV_ANNOTATION, type EntityGraph } from '../../context/graph/entity-graph.js'
import { overviewOf, type Unread } from '../../context/graph/overview.js'
import type { Entity } from '../../core/schemas/entity.js'
import { QUERY_LIMITS } from '../../core/schemas/query.js'
import type { EventSink } from '../../agents/events.js'
import type { LlmClient } from '../../llm/client.js'
import { renderEntityDetail } from '../render/entity.js'
import { renderOverview, type OverviewSource } from '../render/overview.js'
import { oneLine } from '../render/plain.js'
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
}

/**
 * The model chooses which question to ask the graph; the engine answers it and
 * prints it. Nothing the model wrote reaches stdout — the two exceptions, an
 * `unanswerable` reason and the Supervisor's refusal to classify, go to stderr
 * as one cleaned, bounded line each (design § 5.2, ADR-0007).
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
      return answered(options, summaryText)
    default: {
      const exhaustive: never = classification
      return exhaustive
    }
  }
}

/** The Analyst over the graph, shown the summary the Supervisor was shown. */
async function answered(options: AskOptions, summaryText: string): Promise<CommandResult> {
  const { graph, client, intent, source, emit, err } = options
  const tools = buildTools(graph)
  const { answer, truncated } = await answerQuestion(
    client,
    tools,
    { intent, summary: summaryText, vocabulary: '' },
    emit,
  )

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
    .filter((entity): entity is Entity => entity !== undefined)

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
 * A short list that does not say it is short is worse than an error: the
 * reader leaves with a wrong answer believing it complete. The tools tell the
 * model when they cut rows; this is where the reader is told too.
 */
function withTruncation(text: string, truncated: number): string {
  if (truncated === 0) return text
  return `${text}\n\n${truncated} further row(s) were not shown; narrow the question to see them.`
}
