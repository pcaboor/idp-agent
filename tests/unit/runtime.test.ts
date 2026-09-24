import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('turn numbering', () => {
  it('does not spend a turn on a call that failed', async () => {
    // The analyst retries a refused forced tool choice as an open one. That is
    // two physical calls for one logical turn when recording, and one when
    // replaying: if a failed call consumed a number, the recording would carry
    // a hole and every later turn would replay off by one.
    const attempts: number[] = []
    const failing: RecordingStore = {
      read: async () => recording,
      write: async () => {},
    }
    const tape = await openRecording({
      scenario: 'demo',
      store: failing,
      mode: 'replay',
      warn: () => {},
    })
    let first = true
    const counting = {
      ...tape,
      replay: (key: { agent: string; turn: number }, digest: string) => {
        attempts.push(key.turn)
        if (first) {
          first = false
          throw new Error('transient')
        }
        return tape.replay(key as never, digest)
      },
    }
    const client = createClient({ tape: counting as never, mode: 'replay' })
    await client.generate(ask('analyst')).catch(() => {})
    await client.generate(ask('analyst'))
    expect(attempts).toEqual([0, 0])
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

describe('a recorded turn the agents cannot use', () => {
  const tapeOf = async (finishReason: string, content: unknown[]) =>
    createClient({
      tape: await openRecording({
        scenario: 'demo',
        store: {
          read: async () => ({
            version: 1,
            scenario: 'demo',
            turns: [{ ...turn('analyst', 0, content), result: { content, finishReason } }],
          }),
          write: async () => {},
        },
        mode: 'replay',
        warn: () => {},
      }),
      mode: 'replay',
    })

  it('fails on replay the way it would have failed live, naming the recorded model', async () => {
    // Judged on replay too, so a tape holding such a turn — written by hand,
    // or by a build before the check — cannot hand the agent a barren turn a
    // live run would have refused.
    const client = await tapeOf('length', [])
    await expect(client.generate(ask('analyst'))).rejects.toThrow(
      'mistral a-model: the model hit its output limit before answering',
    )
  })

  it('still hands back a turn that hit the limit with a call in it', async () => {
    const client = await tapeOf('length', [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'answer', input: {} },
    ])
    await expect(client.generate(ask('analyst'))).resolves.toMatchObject({ finishReason: 'length' })
  })

  it('fails on a content filter, whatever came with it', async () => {
    const client = await tapeOf('content-filter', [{ type: 'text', text: 'I cannot' }])
    await expect(client.generate(ask('analyst'))).rejects.toThrow(
      'mistral a-model: the provider refused to answer',
    )
  })
})

describe('a recording run the model cannot answer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('refuses the turn the way a live run does, and saves nothing', async () => {
    // Record mode is a live call with a tape beside it: a turn stopped on its
    // output limit with nothing in it is refused there too. The command saves
    // the tape only after a run that succeeded, so none is written.
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-real-one')
    vi.stubEnv('OPENAI_BASE_URL', undefined)
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            id: 'resp_01',
            object: 'response',
            created_at: 0,
            status: 'incomplete',
            model: 'gpt-6-luna',
            output: [],
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const written: Recording[] = []
    const tape = await openRecording({
      scenario: 'demo',
      store: { read: async () => undefined, write: async (_, taped) => void written.push(taped) },
      mode: 'record',
      warn: () => {},
    })
    const client = createClient({
      tape,
      mode: 'record',
      choice: { provider: 'openai', model: 'gpt-6-luna' },
    })

    await expect(client.generate(ask('analyst'))).rejects.toThrow(
      'openai gpt-6-luna: the model hit its output limit before answering',
    )
    expect(written).toEqual([])
  })
})
