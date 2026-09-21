import { describe, expect, it } from 'vitest'
import { LOOP_LIMITS, answerQuestion } from '../../src/agents/analyst.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'
import type { ToolOutcome } from '../../src/agents/tools/graph-tools.js'

/** Replays a scripted sequence of model turns, so the loop is tested without a model. */
const scripted = (turns: GenerateResult[]): LlmClient & { calls: number } => {
  const client = {
    calls: 0,
    generate: async (): Promise<GenerateResult> => {
      const turn = turns[client.calls] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      client.calls += 1
      return turn
    },
  }
  return client
}

const toolCall = (name: string, args: unknown) => ({ id: 'c1', name, args })
const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [toolCall(name, args)],
  finishReason: 'tool-calls',
})

const fakeTools = (refs: string[]) => ({
  specs: [],
  witnessed: new Set(refs),
  run: (call: { name: string; args: unknown }): ToolOutcome =>
    call.name === 'answer'
      ? { result: call.args, rows: 0, truncated: 0 }
      : { result: { rows: refs.map((ref) => ({ ref })) }, rows: refs.length, truncated: 0 },
})

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

const INPUT = { intent: 'which databases are in prod?', summary: 'si:', vocabulary: 'v' }
const A = 'resource:default/billing-db-prod'

describe('answerQuestion', () => {
  it('returns the answer the model signed off through the answer tool', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: [A] }),
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(outcome.answer).toEqual({ outcome: 'entities', refs: [A] })
  })

  it('stops at the turn limit and reports unanswerable rather than guessing', async () => {
    // A partial guess is the one outcome that must never reach a user: it looks
    // exactly like an answer.
    const client = scripted(
      Array.from({ length: 10 }, () => turnCalling('search_entities', { type: 'database' })),
    )
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
    expect(client.calls).toBeLessThanOrEqual(LOOP_LIMITS.maxTurns)
  })

  it('refuses an answer naming a reference no tool returned, and names it', async () => {
    // The whole read-side guarantee. Without it the model can state a fact the
    // graph never produced, which is the failure "declare, never infer" forbids.
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: ['resource:default/invented'] }),
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
    expect(JSON.stringify(outcome.answer)).toContain('resource:default/invented')
  })

  it('refuses a mix of witnessed and invented references', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: [A, 'resource:default/invented'] }),
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
  })

  it('refuses "nothing" when the tools did return rows', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'nothing' }),
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
  })

  it('accepts "nothing" when no tool returned a row', async () => {
    const client = scripted([turnCalling('answer', { outcome: 'nothing' })])
    const { emit } = collect()
    expect((await answerQuestion(client, fakeTools([]), INPUT, emit)).answer).toEqual({
      outcome: 'nothing',
    })
  })

  it('passes an unanswerable through, since refusing is a legal outcome', async () => {
    const client = scripted([
      turnCalling('answer', { outcome: 'unanswerable', reason: 'the catalogue has no cost data' }),
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([]), INPUT, emit)
    expect(outcome.answer).toEqual({
      outcome: 'unanswerable',
      reason: 'the catalogue has no cost data',
    })
  })

  it('caps the calls it executes in one turn', async () => {
    const many = Array.from({ length: 9 }, () => toolCall('search_entities', { type: 'database' }))
    const client = scripted([
      { text: '', toolCalls: many, finishReason: 'tool-calls' },
      turnCalling('answer', { outcome: 'nothing' }),
    ])
    const { events, emit } = collect()
    await answerQuestion(client, fakeTools([]), INPUT, emit)
    expect(
      events.filter((event) => event.type === 'tool:call' && event.name === 'search_entities'),
    ).toHaveLength(LOOP_LIMITS.maxCallsPerTurn)
  })

  it('keeps going after an answer whose arguments do not parse', async () => {
    // A malformed answer is put back in the transcript, not a crash: the model
    // gets to correct itself.
    const client = scripted([
      turnCalling('answer', { outcome: 'entities', refs: [] }),
      turnCalling('answer', { outcome: 'nothing' }),
    ])
    const { emit } = collect()
    expect((await answerQuestion(client, fakeTools([]), INPUT, emit)).answer.outcome).toBe(
      'nothing',
    )
  })

  it('reports unanswerable when the model stops without calling answer', async () => {
    const client = scripted([{ text: 'the answer is 4', toolCalls: [], finishReason: 'stop' }])
    const { emit } = collect()
    expect((await answerQuestion(client, fakeTools([]), INPUT, emit)).answer.outcome).toBe(
      'unanswerable',
    )
  })

  it('emits a readable stream: start, call, result, then the answer', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: [A] }),
    ])
    const { events, emit } = collect()
    await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(events.map((event) => event.type)).toEqual([
      'agent:start',
      'tool:call',
      'tool:result',
      'answer:ready',
    ])
  })

  it('emits a refusal when it rejects an invented reference', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: ['resource:default/invented'] }),
    ])
    const { events, emit } = collect()
    await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(events.some((event) => event.type === 'refused')).toBe(true)
  })
})
