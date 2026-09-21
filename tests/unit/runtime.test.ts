import { describe, expect, it } from 'vitest'
import { createClient } from '../../src/llm/runtime.js'
import { openRecording } from '../../src/llm/recording.js'
import type { Recording, RecordingStore } from '../../src/llm/recording.js'
import type { GenerateRequest } from '../../src/llm/client.js'

const turn = (agent: 'supervisor' | 'analyst', index: number, content: unknown[]) => ({
  agent,
  turn: index,
  provider: 'mistral',
  model: 'a-model',
  digest: 'sha256:whatever',
  call: {},
  result: { content, finishReason: 'stop' },
})

const recording: Recording = {
  version: 1,
  scenario: 'demo',
  turns: [
    turn('analyst', 0, [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search_entities', input: { env: 'prod' } },
    ]),
    turn('analyst', 1, [{ type: 'text', text: 'done' }]),
    turn('supervisor', 0, [{ type: 'text', text: 'QUESTION' }]),
  ],
}

const store: RecordingStore = { read: async () => recording, write: async () => {} }

const ask = (agent: 'supervisor' | 'analyst'): GenerateRequest => ({
  agent,
  system: 'system',
  transcript: [{ role: 'user', text: 'hello' }],
  tools: [],
  toolChoice: 'none',
})

const replaying = async () =>
  createClient({
    tape: await openRecording({ scenario: 'demo', store, mode: 'replay', warn: () => {} }),
    mode: 'replay',
  })

describe('createClient in replay', () => {
  it('counts turns per agent, so a second call replays the second turn', async () => {
    // The turn number is counted by the runtime, never derived from content:
    // that is what makes (scenario, agent, turn) a usable key.
    const client = await replaying()
    expect((await client.generate(ask('analyst'))).toolCalls[0]?.name).toBe('search_entities')
    expect((await client.generate(ask('analyst'))).text).toBe('done')
  })

  it('counts each agent separately', async () => {
    const client = await replaying()
    await client.generate(ask('analyst'))
    expect((await client.generate(ask('supervisor'))).text).toBe('QUESTION')
  })

  it('reads a text part as text and a tool-call part as a call', async () => {
    const client = await replaying()
    const result = await client.generate(ask('analyst'))
    expect(result.text).toBe('')
    expect(result.toolCalls).toEqual([
      { id: 'c1', name: 'search_entities', args: { env: 'prod' } },
    ])
    expect(result.finishReason).toBe('stop')
  })

  it('fails on a turn that was never recorded, rather than inventing one', async () => {
    const client = await replaying()
    await client.generate(ask('supervisor'))
    await expect(client.generate(ask('supervisor'))).rejects.toThrow(/IDP_RECORDING=record/)
  })

  it('never builds a provider, so replay needs no key and no adapter', async () => {
    // The whole point: a contributor replays a recording made against a model
    // they do not have credentials for.
    const client = await replaying()
    await expect(client.generate(ask('supervisor'))).resolves.toBeDefined()
  })
})

describe('createClient in record', () => {
  it('refuses to record without a configured model', async () => {
    const client = createClient({
      tape: await openRecording({ scenario: 'demo', store, mode: 'record', warn: () => {} }),
      mode: 'record',
    })
    await expect(client.generate(ask('supervisor'))).rejects.toThrow(/model/)
  })
})

describe('the request contract', () => {
  it('passes the declared tools through instead of dropping them', async () => {
    // GenerateRequest carries tools and a toolChoice. Accepting them and then
    // ignoring them would be the silent drop this project exists to prevent —
    // the model would simply never be offered a tool, with nothing to show why.
    const { toTools } = await import('../../src/llm/runtime.js')
    const { z } = await import('zod')
    const tools = toTools([
      {
        name: 'search_entities',
        description: 'find entities',
        parameters: z.object({ env: z.string() }),
      },
    ])
    expect(Object.keys(tools)).toEqual(['search_entities'])
    expect(tools['search_entities']?.description).toBe('find entities')
    // No execute: the hand-written loop runs the tools, not the SDK (design 3).
    expect(tools['search_entities']?.execute).toBeUndefined()
  })

  it('translates a forced tool choice into the shape the SDK expects', async () => {
    const { toToolChoice } = await import('../../src/llm/runtime.js')
    expect(toToolChoice('auto')).toBe('auto')
    expect(toToolChoice('none')).toBe('none')
    expect(toToolChoice({ tool: 'answer' })).toEqual({ type: 'tool', toolName: 'answer' })
  })
})
