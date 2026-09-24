import type { LlmClient } from '../llm/client.js'
import type { EventSink } from './events.js'
import { asAgent } from './lifetime.js'

export class ClassificationError extends Error {}

export type Classification = 'MUTATION' | 'QUESTION'

const SYSTEM = `You classify a request about an infrastructure catalogue.

Answer with exactly one word:
  QUESTION  the request asks about what exists
  MUTATION  the request asks for something to change

No explanation, no punctuation, no other word.`

/**
 * The one free choice the design leaves a model in the orchestration: plain
 * TypeScript sequences everything else (design § 6, ADR-0001). No tools, one
 * turn, two possible answers.
 */
export async function classify(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<Classification> {
  return asAgent('supervisor', emit, () => classifyRequest(client, input, emit))
}

async function classifyRequest(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<Classification> {
  const result = await client.generate({
    agent: 'supervisor',
    system: SYSTEM,
    transcript: [{ role: 'user', text: `request: ${input.intent}\n\n${input.summary}` }],
    tools: [],
    toolChoice: 'none',
  })

  // Trimming and upper-casing is formatting. Finding the word inside a sentence
  // would not be: it was asked for one word, and anything else is a refusal to
  // classify rather than a classification to rescue by substring matching.
  const word = result.text.trim().toUpperCase()
  if (word !== 'MUTATION' && word !== 'QUESTION') {
    const reason = `expected MUTATION or QUESTION, got "${result.text.trim().slice(0, 60)}"`
    emit({ type: 'refused', agent: 'supervisor', reason })
    throw new ClassificationError(reason)
  }

  emit({ type: 'classified', classification: word })
  return word
}
