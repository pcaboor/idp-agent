import { answerQuestion } from '../../agents/analyst.js'
import { ClassificationError, classify } from '../../agents/supervisor.js'
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

/**
 * The model chooses which question to ask the graph; the engine answers it and
 * prints it. Nothing the model wrote reaches stdout — the two exceptions, an
 * `unanswerable` reason and the Supervisor's refusal to classify, go to stderr
 * as one cleaned, bounded line each (design § 5.2, ADR-0007).
 */
export async function runAsk(options: {
  graph: EntityGraph
  client: LlmClient
  intent: string
  source: AskSource
  emit: EventSink
  err: (chunk: string) => void
}): Promise<CommandResult> {
  const { graph, client, intent, source, emit, err } = options
  const { summary, vocabulary } = summariseGraph(graph)
  const summaryText = formatSummary(summary, vocabulary)

  let classification: 'MUTATION' | 'QUESTION'
  try {
    classification = await classify(client, { intent, summary: summaryText }, emit)
  } catch (error) {
    if (!(error instanceof ClassificationError)) throw error
    // It quotes what the Supervisor said instead of a word: the model's text.
    err(`${oneLine(error.message)}\n`)
    return { text: '', found: false, unsupported: true }
  }

  if (classification === 'MUTATION') {
    // Understood, and declined: writing arrives at stage 5. Not a failed query.
    err('that is a change request; this build only reads (stage 5 writes)\n')
    return { text: '', found: false, unsupported: true }
  }

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
