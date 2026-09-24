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

const fakeTools = (refs: string[], truncated = 0) => ({
  specs: [],
  witnessed: new Set(refs),
  run: (call: { name: string; args: unknown }): ToolOutcome =>
    call.name === 'answer'
      ? { result: call.args, rows: 0, truncated: 0 }
      : { result: { rows: refs.map((ref) => ({ ref })) }, rows: refs.length, truncated },
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

  it('explains a contradicted answer in terms a reader can act on', async () => {
    // "the answer claimed nothing matches, but the tools returned entities"
    // is a sentence about my own machinery. Whoever typed the question needs
    // to know it was refused and what to do next.
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'nothing' }),
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(JSON.stringify(outcome.answer)).toMatch(/contradicted what it read/i)
    expect(JSON.stringify(outcome.answer)).not.toMatch(/the tools returned entities/i)
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

  it('hands back an answer the flat advertisement allows and the union refuses', async () => {
    // A provider is shown `refs` as optional (llm/tool-schema.ts), and the
    // client passes an invalid call through unchanged: this parse is the gate.
    const client = scripted([
      turnCalling('answer', { outcome: 'entities' }),
      turnCalling('answer', { outcome: 'nothing' }),
    ])
    const { emit } = collect()
    expect((await answerQuestion(client, fakeTools([]), INPUT, emit)).answer.outcome).toBe(
      'nothing',
    )
    expect(client.calls).toBe(2)
  })

  it('reports unanswerable when the model stops without calling answer', async () => {
    const client = scripted([{ text: 'the answer is 4', toolCalls: [], finishReason: 'stop' }])
    const { emit } = collect()
    expect((await answerQuestion(client, fakeTools([]), INPUT, emit)).answer.outcome).toBe(
      'unanswerable',
    )
  })

  it('degrades to an open tool choice when the model refuses a forced one', async () => {
    // Forcing a tool is model-dependent: some reject it with a 400, and the
    // SDK throws when a forced call does not come back. Neither may take the
    // whole question down.
    const seen: unknown[] = []
    let calls = 0
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request.toolChoice)
        calls += 1
        if (typeof request.toolChoice === 'object') {
          throw new Error("Model response did not contain a call to the required tool 'answer'.")
        }
        return calls > 3
          ? turnCalling('answer', { outcome: 'entities', refs: [A] })
          : turnCalling('search_entities', { type: 'database' })
      },
    }
    const { emit } = collect()
    // Productive tools, so the barren-turn bound does not end the loop first:
    // this case is about the forced tool choice, nothing else.
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(seen).toContain('auto')
    expect(outcome.answer.outcome).toBe('entities')
  })

  it('reports unanswerable when even the open retry produces no answer', async () => {
    const client: LlmClient = {
      generate: async (request) => {
        if (typeof request.toolChoice === 'object') throw new Error('forced tool use rejected')
        return turnCalling('search_entities', { type: 'database' })
      },
    }
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A]), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
  })

  it('does not swallow a failure that has nothing to do with the tool choice', async () => {
    const client: LlmClient = {
      generate: async () => {
        throw new Error('the provider is down')
      },
    }
    const { emit } = collect()
    await expect(answerQuestion(client, fakeTools([]), INPUT, emit)).rejects.toThrow(
      /provider is down/,
    )
  })

  it('carries the truncation out of the loop, so the caller can say so', async () => {
    // The tool tells the model it cut rows. If that stops there, the CLI
    // prints a short list and nothing says it is short — the silent drop this
    // project exists to prevent.
    const client = scripted([
      turnCalling('search_entities', { kind: 'Resource' }),
      turnCalling('answer', { outcome: 'entities', refs: [A] }),
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([A], 3), INPUT, emit)
    expect(outcome.truncated).toBe(3)
  })

  it('reports no truncation when nothing was cut', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: [A] }),
    ])
    const { emit } = collect()
    expect((await answerQuestion(client, fakeTools([A]), INPUT, emit)).truncated).toBe(0)
  })

  it('gives up early when searching keeps returning nothing', async () => {
    // "salut" is not a question about a catalogue. Four turns of paid calls to
    // discover that is three too many.
    const client = scripted(
      Array.from({ length: 10 }, () => turnCalling('search_entities', { type: 'greeting' })),
    )
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([]), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
    // Two barren turns, then one more to ask for the answer. Not four.
    expect(client.calls).toBeLessThanOrEqual(LOOP_LIMITS.maxBarrenTurns + 1)
    expect(client.calls).toBeLessThan(LOOP_LIMITS.maxTurns)
  })

  it('says the catalogue held nothing, rather than describing its own machinery', async () => {
    const client = scripted(
      Array.from({ length: 10 }, () => turnCalling('search_entities', { type: 'greeting' })),
    )
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([]), INPUT, emit)
    expect(JSON.stringify(outcome.answer)).toMatch(/nothing in the catalogue/i)
    expect(JSON.stringify(outcome.answer)).not.toMatch(/search ended/i)
  })

  it('keeps going when the searches are productive', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: [A] }),
    ])
    const { emit } = collect()
    expect((await answerQuestion(client, fakeTools([A]), INPUT, emit)).answer.outcome).toBe(
      'entities',
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
