import { asSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { answerQuestion } from '../../src/agents/analyst.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { ToolOutcome } from '../../src/agents/tools/graph-tools.js'
import { QUERY_LIMITS, answerSchema } from '../../src/core/schemas/query.js'
import type { GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { toTools } from '../../src/llm/runtime.js'
import { offeredTools } from '../support/offered-tools.js'

/**
 * The answer's commentary (ADR-0008): `intro` and `conclusion`, optional, on
 * `entities`, `nothing` and `overview`, written in the same terminal call. A
 * malformed or oversized one is DROPPED, never a reason to refuse the answer
 * or to spend a repair turn: the answer is what matters.
 */

const A = 'resource:default/billing-db-prod'

describe('answerSchema, on commentary', () => {
  it('keeps an introduction and a conclusion on the three answers that frame a block', () => {
    for (const answer of [
      { outcome: 'entities', refs: [A] },
      { outcome: 'nothing' },
      { outcome: 'overview' },
    ]) {
      expect(
        answerSchema.parse({ ...answer, intro: 'Here it is.', conclusion: 'That is all.' }),
      ).toEqual({ ...answer, intro: 'Here it is.', conclusion: 'That is all.' })
    }
  })

  it('leaves both optional, and adds no key when they are absent', () => {
    expect(Object.keys(answerSchema.parse({ outcome: 'entities', refs: [A] }))).toEqual([
      'outcome',
      'refs',
    ])
    expect(Object.keys(answerSchema.parse({ outcome: 'overview' }))).toEqual(['outcome'])
  })

  it('drops a malformed or oversized one and keeps the answer', () => {
    const long = 'x'.repeat(QUERY_LIMITS.maxCommentary + 1)
    for (const [intro, conclusion] of [
      [42, ['a list']],
      [long, long],
      [null, { text: 'x' }],
    ] as const) {
      const parsed = answerSchema.safeParse({ outcome: 'entities', refs: [A], intro, conclusion })
      expect(parsed.success).toBe(true)
      expect(parsed.data).toEqual({ outcome: 'entities', refs: [A] })
      // Caught to an absent value: nothing downstream can read one.
      expect(JSON.stringify(parsed.data)).toBe(JSON.stringify({ outcome: 'entities', refs: [A] }))
    }
  })

  it('counts the raw bound in characters, as the advertised maxLength does', () => {
    // JSON Schema's maxLength counts code points; a string the advertisement
    // allows is one the validator keeps, emoji and astral ideographs included.
    const astral = '\u{1F600}'.repeat(QUERY_LIMITS.maxCommentary)
    expect(answerSchema.parse({ outcome: 'nothing', intro: astral })).toEqual({
      outcome: 'nothing',
      intro: astral,
    })
    expect(answerSchema.parse({ outcome: 'nothing', intro: `${astral}x` })).toEqual({
      outcome: 'nothing',
    })
  })

  it('keeps one at the raw bound exactly', () => {
    const edge = 'x'.repeat(QUERY_LIMITS.maxCommentary)
    expect(answerSchema.parse({ outcome: 'nothing', intro: edge })).toEqual({
      outcome: 'nothing',
      intro: edge,
    })
  })

  it('discards it on an unanswerable, whose reason already says why', () => {
    expect(
      answerSchema.parse({
        outcome: 'unanswerable',
        reason: 'no cost data',
        intro: 'Sorry.',
        conclusion: 'Try again.',
      }),
    ).toEqual({ outcome: 'unanswerable', reason: 'no cost data' })
  })
})

describe('the answer tool, as a model is shown it', () => {
  const advertisedAnswer = async (): Promise<Record<string, unknown>> => {
    const answer = (await offeredTools()).find((spec) => spec.name === 'answer')
    if (answer === undefined) throw new Error('no answer tool offered')
    return (await asSchema(toTools([answer])['answer']?.inputSchema).jsonSchema) as Record<
      string,
      unknown
    >
  }

  it('offers both fields, bounded, optional, and says a bad one is dropped rather than refused', async () => {
    const advertised = (await advertisedAnswer()) as {
      properties: Record<string, { type?: string; maxLength?: number; description?: string }>
      required: string[]
    }
    for (const field of ['intro', 'conclusion']) {
      const property = advertised.properties[field]
      expect(property, field).toBeDefined()
      expect(property?.type).toBe('string')
      expect(property?.maxLength).toBe(QUERY_LIMITS.maxCommentary)
      expect(property?.description).toMatch(/dropped, never refused/i)
      expect(property?.description).toMatch(/"entities", "nothing" or "overview"/)
      expect(advertised.required).not.toContain(field)
    }
  })
})

const scripted = (turns: GenerateResult[]): LlmClient & { seen: GenerateRequest[] } => {
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request) => {
      seen.push(request)
      return turns[seen.length - 1] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `c-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const tools = (refs: string[]) => ({
  specs: [],
  witnessed: new Set(refs),
  run: (call: { name: string; args: unknown }): ToolOutcome =>
    call.name === 'answer'
      ? { result: call.args, rows: 0, truncated: 0 }
      : { result: { rows: refs.map((ref) => ({ ref })) }, rows: refs.length, truncated: 0 },
})

const INPUT = { intent: 'which databases are in prod?', summary: 'si:', vocabulary: '' }

describe('answerQuestion, with commentary', () => {
  it('hands the commentary back with the answer, in the same call', async () => {
    const client = scripted([
      calling('search_entities', { type: 'database' }),
      calling('answer', {
        outcome: 'entities',
        refs: [A],
        intro: 'One database is in prod.',
        conclusion: 'It is billing-db-prod.',
      }),
    ])
    const events: AgentEvent[] = []
    const outcome = await answerQuestion(client, tools([A]), INPUT, (event) => void events.push(event))

    expect(outcome.answer).toEqual({
      outcome: 'entities',
      refs: [A],
      intro: 'One database is in prod.',
      conclusion: 'It is billing-db-prod.',
    })
    // No extra model turn: the commentary rode on the terminal call.
    expect(client.seen).toHaveLength(2)
    // The event stream carries the outcome and the references, never a sentence.
    expect(events).toContainEqual({ type: 'answer:ready', outcome: 'entities', refs: [A] })
    expect(JSON.stringify(events)).not.toContain('One database')
    expect(JSON.stringify(events)).not.toContain('It is billing')
  })

  it('spends no repair turn on a malformed commentary', async () => {
    const client = scripted([
      calling('answer', { outcome: 'overview', intro: 42, conclusion: 'x'.repeat(5_000) }),
    ])
    const outcome = await answerQuestion(client, tools([]), INPUT, () => {})
    expect(outcome.answer).toEqual({ outcome: 'overview' })
    expect(client.seen).toHaveLength(1)
  })

  it('loses the commentary with the answer when the engine refuses an invented reference', async () => {
    const client = scripted([
      calling('search_entities', { type: 'database' }),
      calling('answer', {
        outcome: 'entities',
        refs: ['resource:default/ghost'],
        intro: 'Here is ghost.',
      }),
    ])
    const outcome = await answerQuestion(client, tools([A]), INPUT, () => {})
    expect(outcome.answer.outcome).toBe('unanswerable')
    expect(JSON.stringify(outcome.answer)).not.toContain('Here is ghost')
  })

  it('tells the model what the commentary is for, and what the engine does to it', async () => {
    const client = scripted([calling('answer', { outcome: 'nothing' })])
    await answerQuestion(client, tools([]), INPUT, () => {})
    const system = client.seen[0]?.system ?? ''
    expect(system).toMatch(/"intro"/)
    expect(system).toMatch(/"conclusion"/)
    expect(system).toMatch(/language of the question/)
    expect(system).toMatch(/do not restate the list or its figures/i)
    expect(system).toMatch(/deletes any sentence/)
    expect(system).toMatch(/omit/i)
    // Declare, never infer (design §4.1): the check cannot catch a sentence
    // that reasons wrongly about what was read, so the prompt asks for none.
    expect(system).toMatch(/only what the tool results state/i)
    expect(system).toMatch(/not\s+declared rather than guess/i)
  })
})
