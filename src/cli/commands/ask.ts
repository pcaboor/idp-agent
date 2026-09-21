import { answerQuestion } from '../../agents/analyst.js'
import { ClassificationError, classify } from '../../agents/supervisor.js'
import { formatSummary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import { summariseGraph } from '../../context/graph/summary.js'
import { ENV_ANNOTATION, type EntityGraph } from '../../context/graph/entity-graph.js'
import type { Entity } from '../../core/schemas/entity.js'
import type { EventSink } from '../../agents/events.js'
import type { LlmClient } from '../../llm/client.js'
import { renderEntityDetail } from '../render/entity.js'
import { renderTable } from '../render/table.js'
import type { CommandResult } from './result.js'

/**
 * The model chooses which question to ask the graph; the engine answers it and
 * prints it. Nothing the model wrote reaches stdout — the one exception, an
 * `unanswerable` reason, goes to stderr (design § 5.2, ADR-0007).
 */
export async function runAsk(options: {
  graph: EntityGraph
  client: LlmClient
  intent: string
  emit: EventSink
  err: (chunk: string) => void
}): Promise<CommandResult> {
  const { graph, client, intent, emit, err } = options
  const { summary, vocabulary } = summariseGraph(graph)
  const summaryText = formatSummary(summary, vocabulary)

  let classification: 'MUTATION' | 'QUESTION'
  try {
    classification = await classify(client, { intent, summary: summaryText }, emit)
  } catch (error) {
    if (!(error instanceof ClassificationError)) throw error
    err(`${error.message}\n`)
    return { text: '', found: false, unsupported: true }
  }

  if (classification === 'MUTATION') {
    // Understood, and declined: writing arrives at stage 5. Not a failed query.
    err('that is a change request; this build only reads (stage 5 writes)\n')
    return { text: '', found: false, unsupported: true }
  }

  const tools = buildTools(graph)
  const { answer } = await answerQuestion(
    client,
    tools,
    { intent, summary: summaryText, vocabulary: '' },
    emit,
  )

  if (answer.outcome === 'unanswerable') {
    err(`cannot answer: ${answer.reason}\n`)
    return { text: '', found: false, unsupported: true }
  }

  if (answer.outcome === 'nothing') {
    return { text: 'No entity matches that question.', found: false }
  }

  // Re-read from the graph and sorted: the model's ordering is not one anybody
  // verified, and the entity it named is not the entity we print unless the
  // graph still holds it.
  const found = [...answer.refs]
    .sort()
    .map((ref) => graph.get(ref))
    .filter((entity): entity is Entity => entity !== undefined)

  if (found.length === 0) return { text: 'No entity matches that question.', found: false }
  if (found.length === 1) return { text: renderEntityDetail(graph, found[0]!), found: true }

  const rows = found.map((entity) => [
    entity.metadata.name,
    entity.kind,
    entity.spec.type,
    entity.metadata.annotations[ENV_ANNOTATION] ?? '-',
    entity.spec.owner,
  ])
  return { text: renderTable(['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER'], rows), found: true }
}
