import type { LlmClient, Transcript } from '../llm/client.js'
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
 * turn — and one more when the first gives neither word — two possible answers.
 */
export async function classify(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<Classification> {
  return asAgent('supervisor', emit, () => classifyRequest(client, input, emit))
}

/**
 * What surrounds a word without changing it: punctuation, the symbols
 * markdown decorates with — `**`, a backtick — and white space. Named by
 * property, so a full stop of any script is one.
 */
const DECORATION = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu

/**
 * The word a turn gave, or `undefined` when it gave none of the two.
 *
 * Stripping what surrounds a word, and its case, is formatting: "Question.",
 * "**QUESTION**" and "`mutation`" each say one of the two words, and each
 * ended the run on exit 3 (gap-ask-grounding-7). Finding the word inside a
 * sentence would not be: it was asked for one word, and anything else is a
 * refusal to classify rather than a classification to rescue by substring
 * matching.
 */
function wordOf(text: string): Classification | undefined {
  const word = text.replace(DECORATION, '').toUpperCase()
  return word === 'MUTATION' || word === 'QUESTION' ? word : undefined
}

/** What the model said, as a message quotes it: its first characters, trimmed. */
const quoted = (text: string): string => `"${text.trim().slice(0, 60)}"`

/** Handed back with the answer that was no word: why the model is asked again. */
const AGAIN =
  'That is not one of the two words. Answer with exactly one word: QUESTION or MUTATION.'

async function classifyRequest(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<Classification> {
  const opening: Transcript = { role: 'user', text: `request: ${input.intent}\n\n${input.summary}` }
  const ask = (transcript: Transcript[]): Promise<{ text: string }> =>
    client.generate({
      agent: 'supervisor',
      system: SYSTEM,
      transcript,
      tools: [],
      toolChoice: 'none',
    })

  const first = await ask([opening])
  let word = wordOf(first.text)
  if (word === undefined) {
    // Once more, with the answer handed back: a model that wrapped the word in
    // a sentence is usually one sentence away from the word alone. The first
    // request is sent as it always was, so a recording of it replays.
    const second = await ask([
      opening,
      { role: 'assistant', text: first.text, toolCalls: [] },
      { role: 'user', text: AGAIN },
    ])
    word = wordOf(second.text)
    if (word === undefined) {
      // Nothing was judged, so not `refused`: the model gave no word to judge,
      // twice, and the choice of model is what the person can change. The
      // reason is the error `cli/index.ts` prints, once, as the run's last
      // line: thrown, as a call that could not succeed is.
      const reason =
        `the model answered ${quoted(first.text)}, then ${quoted(second.text)}, where one ` +
        'word was asked, QUESTION or MUTATION; IDP_SUPERVISOR_MODEL can give the ' +
        'Supervisor a model that follows it'
      emit({ type: 'stopped', agent: 'supervisor', reason })
      throw new ClassificationError(reason)
    }
    // Said once the second answer is a word, and not before: a terminal reads
    // `retry` as the agent having corrected itself, and a second answer that
    // is no word either is not a correction — the stop says both.
    emit({
      type: 'retry',
      agent: 'supervisor',
      reason: `expected MUTATION or QUESTION, got ${quoted(first.text)}`,
    })
  }

  emit({ type: 'classified', classification: word })
  return word
}
