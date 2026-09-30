import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createClient, toMessages, usageOf } from '../../src/llm/runtime.js'
import { openRecording } from '../../src/llm/recording.js'
import type { Recording, RecordingStore } from '../../src/llm/recording.js'
import type { GenerateRequest, ModelToolSpec, Transcript } from '../../src/llm/client.js'

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

  it('replays nothing once the signal has aborted, and spends no turn on it', async () => {
    const client = await replaying()
    const stop = new AbortController()
    stop.abort(new Error('stopped'))
    await expect(client.generate(ask('supervisor'), { signal: stop.signal })).rejects.toThrow(
      'stopped',
    )
    expect((await client.generate(ask('supervisor'))).text).toBe('QUESTION')
  })

  it('replays a turn whatever signal comes with the call: it is no part of the digest', async () => {
    const warned: string[] = []
    const tape = await openRecording({
      scenario: 'demo',
      store,
      mode: 'replay',
      warn: (line) => void warned.push(line),
    })
    const client = createClient({ tape, mode: 'replay' })
    const plain = await client.generate(ask('analyst'))
    const signalled = createClient({
      tape: await openRecording({
        scenario: 'demo',
        store,
        mode: 'replay',
        warn: (line) => void warned.push(line),
      }),
      mode: 'replay',
    })
    const withSignal = await signalled.generate(ask('analyst'), {
      signal: new AbortController().signal,
    })
    expect(withSignal).toEqual(plain)
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
      replay: (key: { agent: string; turn: number }, digests: readonly string[]) => {
        attempts.push(key.turn)
        if (first) {
          first = false
          throw new Error('transient')
        }
        return tape.replay(key as never, digests)
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

describe('token usage', () => {
  it('keeps the counts a provider reported and drops the ones it did not', () => {
    expect(
      usageOf({ inputTokens: 120, outputTokens: 3, totalTokens: 123, inputTokenDetails: {} }),
    ).toEqual({ inputTokens: 120, outputTokens: 3, totalTokens: 123 })
    // Absent is not zero: an unreported count stays unreported.
    expect(usageOf({ inputTokens: 120, outputTokens: undefined, totalTokens: undefined })).toEqual({
      inputTokens: 120,
    })
  })

  it('has no usage at all when nothing was reported', () => {
    expect(usageOf(undefined)).toBeUndefined()
    expect(usageOf('120 tokens')).toBeUndefined()
    expect(usageOf({ inputTokens: undefined, outputTokens: Number.NaN })).toBeUndefined()
  })

  it('replays the usage a recording carries', async () => {
    const counted: Recording = {
      ...recording,
      turns: [
        {
          ...turn('supervisor', 0, []),
          result: {
            content: [{ type: 'text', text: 'QUESTION' }],
            finishReason: 'stop',
            usage: { inputTokens: 120, outputTokens: 1, totalTokens: 121 },
          },
        },
      ],
    }
    const client = createClient({
      tape: await openRecording({
        scenario: 'demo',
        store: { read: async () => counted, write: async () => {} },
        mode: 'replay',
        warn: () => {},
      }),
      mode: 'replay',
    })

    expect((await client.generate(ask('supervisor'))).usage).toEqual({
      inputTokens: 120,
      outputTokens: 1,
      totalTokens: 121,
    })
  })

  it('replays a recording made before usage was stored with no usage, never a zero', async () => {
    const result = await (await replaying()).generate(ask('supervisor'))
    expect('usage' in result).toBe(false)
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

describe('the messages a transcript is sent as', () => {
  // A turn where the model said nothing and called nothing is kept in the
  // transcript — the agent counts it and asks again — and was sent back as an
  // assistant message with no content. Anthropic refuses one (every message
  // but a final assistant one must have content), and Mistral is sent `""`
  // with no tool call. It is dropped, and the two user messages it stood
  // between become one, in order: the rule the Anthropic adapter applies to
  // consecutive user messages itself, applied here for every provider.
  const nudge = 'Call a tool: answer, or one of the read tools.'
  const barren: Transcript = { role: 'assistant', text: '', toolCalls: [] }

  it('drops an assistant turn that said nothing and called nothing', () => {
    expect(toMessages([{ role: 'user', text: 'hello' }, barren, { role: 'user', text: nudge }])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: nudge },
        ],
      },
    ])
  })

  it('counts whitespace as nothing said', () => {
    const messages = toMessages([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: ' \n', toolCalls: [] },
      { role: 'user', text: nudge },
    ])
    expect(messages.map((message) => message.role)).toEqual(['user'])
  })

  it('never sends an assistant message with no content, whatever surrounds it', () => {
    const messages = toMessages([
      { role: 'user', text: 'hello' },
      barren,
      { role: 'user', text: nudge },
      barren,
      { role: 'user', text: nudge },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'get_entity', args: { ref: 'x' } }] },
      { role: 'tool', id: 'c1', name: 'get_entity', result: { rows: [] } },
      barren,
      { role: 'user', text: nudge },
    ])
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      expect(message.content).not.toEqual([])
      expect(message.content).not.toBe('')
    }
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
  })

  it('leaves a transcript with no barren turn as it was sent before', () => {
    const call = { id: 'c1', name: 'get_entity', args: { ref: 'x' } }
    expect(
      toMessages([
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'Reading it.', toolCalls: [call] },
        { role: 'tool', id: 'c1', name: 'get_entity', result: { rows: [] } },
      ]),
    ).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading it.' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'get_entity', input: { ref: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'get_entity',
            output: { type: 'json', value: { rows: [] } },
          },
        ],
      },
    ])
  })
})

describe('the digest a turn is recorded and replayed under', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  /** A provider that answers every call, in process: no socket, no host. */
  const answering = (): void => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-real-one')
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1')
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            id: 'resp_01',
            object: 'response',
            created_at: 0,
            status: 'completed',
            model: 'gpt-6-luna',
            output: [
              {
                type: 'message',
                id: 'msg_01',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'QUESTION', annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
  }

  const tool = (env: z.ZodType): ModelToolSpec => ({
    name: 'search_entities',
    description: 'find entities',
    parameters: z.object({ env }),
  })

  const request = (spec: ModelToolSpec, toolChoice: GenerateRequest['toolChoice'] = 'auto'): GenerateRequest => ({
    agent: 'analyst',
    system: 'system',
    transcript: [{ role: 'user', text: 'hello' }],
    tools: [spec],
    toolChoice,
  })

  const ENV = z.string().max(8).regex(/^[a-z]+$/).describe('the environment, as the catalogue names it')

  /** Records one turn of `sent`, and hands back the tape it wrote. */
  const recorded = async (sent: GenerateRequest): Promise<Recording> => {
    answering()
    const written: Recording[] = []
    const tape = await openRecording({
      scenario: 'demo',
      store: { read: async () => undefined, write: async (_, taped) => void written.push(taped) },
      mode: 'record',
      warn: () => {},
    })
    const client = createClient({ tape, mode: 'record', choice: { provider: 'openai', model: 'gpt-6-luna' } })
    await client.generate(sent)
    await tape.save()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    return written[0]!
  }

  /** The warnings one replay of `tape` under `sent` produced. */
  const warnings = async (tape: Recording, sent: GenerateRequest): Promise<string[]> => {
    const warned: string[] = []
    const client = createClient({
      tape: await openRecording({
        scenario: 'demo',
        store: { read: async () => tape, write: async () => {} },
        mode: 'replay',
        warn: (line) => void warned.push(line),
      }),
      mode: 'replay',
    })
    await client.generate(sent)
    return warned
  }

  it('records a new turn under the digest of what the provider is sent', async () => {
    const tape = await recorded(request(tool(ENV)))
    expect(tape.turns[0]?.digest).toMatch(/^sent:sha256:[0-9a-f]{64}$/)
    expect(await warnings(tape, request(tool(ENV)))).toEqual([])
  })

  it.each([
    ['a reworded field description', ENV.describe('the environment')],
    ['a changed maximum', z.string().max(9).regex(/^[a-z]+$/).describe('the environment, as the catalogue names it')],
    ['a changed pattern', z.string().max(8).regex(/^[a-z-]+$/).describe('the environment, as the catalogue names it')],
  ])('reports the turn stale on %s, which the Zod objects never showed', async (_, changed) => {
    // What a model is shown of a tool is its JSON Schema, and each of these
    // moves it. The digest of the request's Zod objects moved on none of them:
    // `.describe` lives in a registry, and a check stringifies as `{}`
    // (tests-6, wip-diff-12).
    const tape = await recorded(request(tool(ENV)))
    expect(await warnings(tape, request(tool(changed)))).toEqual([
      'recording demo analyst turn 0: the prompt changed since recording; replaying anyway',
    ])
  })

  it('reports the turn stale on a changed tool choice', async () => {
    const tape = await recorded(request(tool(ENV)))
    expect(await warnings(tape, request(tool(ENV), { tool: 'search_entities' }))).toHaveLength(1)
  })

  it.each<[string, (sent: GenerateRequest) => GenerateRequest]>([
    ['a changed system prompt', (sent) => ({ ...sent, system: 'another system' })],
    [
      'a transcript one entry longer',
      (sent) => ({ ...sent, transcript: [...sent.transcript, { role: 'user', text: 'and?' }] }),
    ],
    ['a changed transcript entry', (sent) => ({ ...sent, transcript: [{ role: 'user', text: 'hi' }] })],
    [
      'a reworded tool description',
      (sent) => ({ ...sent, tools: sent.tools.map((spec) => ({ ...spec, description: 'find them' })) }),
    ],
    [
      'a renamed tool',
      (sent) => ({ ...sent, tools: sent.tools.map((spec) => ({ ...spec, name: 'find_entities' })) }),
    ],
  ])('reports the turn stale on %s, as the digest it replaced did', async (_, change) => {
    // What the old digest covered, the new one must too: every turn recorded
    // from now on is compared under it alone, so a part it drops is a prompt
    // change no tape would ever report again.
    const tape = await recorded(request(tool(ENV)))
    expect(await warnings(tape, change(request(tool(ENV))))).toEqual([
      'recording demo analyst turn 0: the prompt changed since recording; replaying anyway',
    ])
  })

  it('still compares a turn recorded before, under the digest it was recorded with', async () => {
    // Every tape recorded before 2026-09-30 holds this digest, which a tape
    // cannot be moved off honestly: it stores neither the tools nor the tool
    // choice it was sent with. So it is still computed, and such a turn keeps
    // the verdict it had, stale or fresh.
    const sent = request(tool(ENV))
    const old = `sha256:${createHash('sha256').update(JSON.stringify(sent)).digest('hex')}`
    const tape: Recording = { ...recording, turns: [{ ...turn('analyst', 0, []), digest: old }] }
    expect(await warnings(tape, sent)).toEqual([])
    expect(await warnings(tape, { ...sent, system: 'another system' })).toHaveLength(1)
  })

  it('writes down the transcript as it was sent, not as it grew afterwards', async () => {
    // Stored by reference, every turn of an agent showed the transcript of its
    // last: the tape said the model had read what it had not been sent yet.
    answering()
    const written: Recording[] = []
    const tape = await openRecording({
      scenario: 'demo',
      store: { read: async () => undefined, write: async (_, taped) => void written.push(taped) },
      mode: 'record',
      warn: () => {},
    })
    const client = createClient({ tape, mode: 'record', choice: { provider: 'openai', model: 'gpt-6-luna' } })
    const sent = request(tool(ENV))
    await client.generate(sent)
    sent.transcript.push({ role: 'assistant', text: 'QUESTION', toolCalls: [] })
    await client.generate(sent)
    await tape.save()
    const lengths = written[0]?.turns.map(
      (taped) => (taped.call as { transcript: Transcript[] }).transcript.length,
    )
    expect(lengths).toEqual([1, 2])
  })
})
