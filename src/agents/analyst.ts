import { answerSchema, type Answer } from '../core/schemas/query.js'
import type { LlmClient, Transcript } from '../llm/client.js'
import type { EventSink } from './events.js'
import type { buildTools } from './tools/graph-tools.js'

/**
 * Bounds, not suggestions. A loop that can run forever cannot be shipped in a
 * tool that answers a read-only question, and exhausting the bound yields a
 * refusal rather than a partial guess — a partial guess is the one outcome
 * that must never reach a user, because it looks exactly like an answer.
 */
export const LOOP_LIMITS = { maxTurns: 4, maxCallsPerTurn: 3 } as const

export interface AnalystOutcome {
  answer: Answer
  witnessed: ReadonlySet<string>
  calls: string[]
}

const SYSTEM = `You answer questions about an infrastructure catalogue.

Use the tools to read the catalogue. You may not state anything you have not read:
every reference you give must have come back from a tool in this conversation.

Finish by calling "answer":
  entities      with the references you read, when they answer the question
  nothing       when no entity matches
  unanswerable  with a reason, when the catalogue cannot answer this question

Refusing is a valid outcome. Do not approximate to produce one.`

const unanswerable = (reason: string): Answer => ({ outcome: 'unanswerable', reason })

export async function answerQuestion(
  client: LlmClient,
  tools: ReturnType<typeof buildTools>,
  input: { intent: string; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<AnalystOutcome> {
  emit({ type: 'agent:start', agent: 'analyst' })

  const transcript: Transcript[] = [
    {
      role: 'user',
      text: `question: ${input.intent}\n\n${input.summary}\n${input.vocabulary}`,
    },
  ]
  const calls: string[] = []
  let answer: Answer | undefined

  for (let turn = 0; turn < LOOP_LIMITS.maxTurns && answer === undefined; turn += 1) {
    const last = turn === LOOP_LIMITS.maxTurns - 1
    const result = await client.generate({
      agent: 'analyst',
      system: SYSTEM,
      transcript,
      tools: tools.specs,
      // The last allowed turn forces termination rather than letting the loop
      // fall off its bound with nothing to show.
      toolChoice: last ? { tool: 'answer' } : 'auto',
    })

    if (result.toolCalls.length === 0) break

    const executed = result.toolCalls.slice(0, LOOP_LIMITS.maxCallsPerTurn)
    const dropped = result.toolCalls.length - executed.length
    transcript.push({ role: 'assistant', text: result.text, toolCalls: executed })

    for (const call of executed) {
      calls.push(call.name)
      // `answer` is the terminal channel, not a read: it is reported by
      // answer:ready or refused, never as one more tool call in the stream.
      const reads = call.name !== 'answer'
      if (reads) emit({ type: 'tool:call', name: call.name, args: call.args })
      const outcome = tools.run(call)
      if (reads) {
        emit({
          type: 'tool:result',
          name: call.name,
          rows: outcome.rows,
          truncated: outcome.truncated,
        })
      }

      if (call.name === 'answer') {
        const parsed = answerSchema.safeParse(call.args)
        if (parsed.success) {
          answer = parsed.data
          break
        }
        // Put back in the transcript, not thrown: the model gets to correct
        // itself rather than the whole question failing on a malformed call.
        transcript.push({
          role: 'tool',
          id: call.id,
          name: call.name,
          result: { error: `answer: ${parsed.error.issues[0]?.message ?? 'invalid'}` },
        })
        continue
      }

      transcript.push({ role: 'tool', id: call.id, name: call.name, result: outcome.result })
    }

    // Dropped calls are told, never dropped in silence: the model must know
    // its request was not executed in full.
    if (dropped > 0) {
      transcript.push({
        role: 'user',
        text: `${dropped} further tool call(s) in that turn were not executed; the limit is ${LOOP_LIMITS.maxCallsPerTurn} per turn.`,
      })
    }
  }

  const signed = sign(answer, tools.witnessed)
  if (signed.outcome === 'unanswerable' && answer?.outcome !== 'unanswerable') {
    emit({ type: 'refused', agent: 'analyst', reason: signed.reason })
  } else {
    emit({
      type: 'answer:ready',
      refs: signed.outcome === 'entities' ? signed.refs : [],
    })
  }

  return { answer: signed, witnessed: tools.witnessed, calls }
}

/**
 * The engine's two checks on what the model produced. Neither is a formality:
 * the first is the whole read-side guarantee, the second catches a model that
 * saw rows and then claimed emptiness.
 */
function sign(answer: Answer | undefined, witnessed: ReadonlySet<string>): Answer {
  if (answer === undefined) {
    return unanswerable('the search ended without an answer')
  }

  if (answer.outcome === 'entities') {
    const invented = answer.refs.filter((ref) => !witnessed.has(ref))
    if (invented.length > 0) {
      return unanswerable(`the answer named ${invented.join(', ')}, which no tool returned`)
    }
    return answer
  }

  if (answer.outcome === 'nothing' && witnessed.size > 0) {
    return unanswerable('the answer claimed nothing matches, but the tools returned entities')
  }

  return answer
}
