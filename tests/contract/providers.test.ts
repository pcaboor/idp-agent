import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { GenerateRequest, ModelToolSpec } from '../../src/llm/client.js'
import type { ProviderName } from '../../src/llm/providers.js'
import { createClient } from '../../src/llm/runtime.js'
import { offeredTools, requests } from '../support/offered-tools.js'

/**
 * What each adapter actually puts on the wire, checked without a key and
 * without the network.
 *
 * The runtime is driven exactly as `idp-agent` drives it — `createClient` in
 * `live` mode, the real adapter, the real tool specs — and only `fetch` is
 * replaced: it keeps the request body and answers in that provider's own wire
 * format. A recording cannot catch what this does. A tape stores what the
 * model returned, never the bytes that were sent, and it replays without
 * building an adapter at all — so a request a provider refuses with a 400 is
 * invisible to every scenario in the suite, which is how `answer` and
 * `verdict` came to be unusable on Anthropic.
 *
 * The keys are fake and the hosts are never reached. Every stub is undone after
 * each test, which puts back the thrower `tests/setup/offline.ts` installed.
 */

type Body = Record<string, unknown>

interface Wire {
  /** The environment variable the adapter reads its key from. */
  key: string
  /** Any variable that would move the endpoint, cleared so the URL is the documented one. */
  moves: string[]
  model: string
  url: string
  /** Each tool's name and the JSON Schema sent for its arguments. */
  schemas(body: Body): Array<[string, Record<string, unknown>]>
  /** What a forced call to `tool` must look like in the body. */
  forced(body: Body, tool: string): void
  /** A minimal, valid response calling `tool` with `args` under the id `id`. */
  calling(tool: string, args: unknown, id: string): unknown
  saying(text: string): unknown
}

const records = (value: unknown): Body[] => value as Body[]

const WIRES: Record<ProviderName, Wire> = {
  anthropic: {
    key: 'ANTHROPIC_API_KEY',
    moves: ['ANTHROPIC_BASE_URL'],
    model: 'claude-sonnet-4-5',
    url: 'https://api.anthropic.com/v1/messages',
    schemas: (body) =>
      records(body['tools']).map((tool) => [
        tool['name'] as string,
        tool['input_schema'] as Record<string, unknown>,
      ]),
    forced: (body, tool) => expect(body['tool_choice']).toEqual({ type: 'tool', name: tool }),
    calling: (tool, args, id) => ({
      type: 'message',
      id: 'msg_01',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'tool_use', id, name: tool, input: args }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    saying: (text) => ({
      type: 'message',
      id: 'msg_02',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },

  // `createOpenAI()(model)` is the Responses API in @ai-sdk/openai 4, not chat
  // completions: a function tool is flat — `parameters` beside `name`.
  openai: {
    key: 'OPENAI_API_KEY',
    moves: ['OPENAI_BASE_URL'],
    model: 'gpt-5',
    url: 'https://api.openai.com/v1/responses',
    schemas: (body) =>
      records(body['tools']).map((tool) => [
        tool['name'] as string,
        tool['parameters'] as Record<string, unknown>,
      ]),
    forced: (body, tool) => expect(body['tool_choice']).toEqual({ type: 'function', name: tool }),
    calling: (tool, args, id) => ({
      id: 'resp_01',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5',
      output: [
        {
          type: 'function_call',
          id: 'fc_01',
          call_id: id,
          name: tool,
          arguments: JSON.stringify(args),
          status: 'completed',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    saying: (text) => ({
      id: 'resp_02',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          id: 'msg_01',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  },

  // Mistral has no "this tool" choice. The adapter sends only the forced tool
  // and `tool_choice: "any"`, which is the same promise stated another way.
  mistral: {
    key: 'MISTRAL_API_KEY',
    moves: [],
    model: 'mistral-large-latest',
    url: 'https://api.mistral.ai/v1/chat/completions',
    schemas: (body) =>
      records(body['tools']).map((tool) => {
        const fn = tool['function'] as Body
        return [fn['name'] as string, fn['parameters'] as Record<string, unknown>]
      }),
    forced: (body, tool) => {
      expect(body['tool_choice']).toBe('any')
      expect(WIRES.mistral.schemas(body).map(([name]) => name)).toEqual([tool])
    },
    calling: (tool, args, id) => ({
      id: 'cmpl_01',
      object: 'chat.completion',
      created: 0,
      model: 'mistral-large-latest',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    saying: (text) => ({
      id: 'cmpl_02',
      object: 'chat.completion',
      created: 0,
      model: 'mistral-large-latest',
      choices: [
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  },
}

interface Sent {
  url: string
  body: Body
}

/** Replaces `fetch` with one that keeps each request and answers `reply`. */
const serving = (reply: unknown): Sent[] => {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    sent.push({ url, body: JSON.parse(String(init?.body)) as Body })
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return sent
}

const request = (
  tools: ModelToolSpec[],
  toolChoice: GenerateRequest['toolChoice'],
): GenerateRequest => ({
  agent: 'analyst',
  system: 'You answer questions about a catalogue.',
  transcript: [{ role: 'user', text: 'which databases run in prod?' }],
  tools,
  toolChoice,
})

const ROOT_UNIONS = ['oneOf', 'anyOf', 'allOf']

let specs: ModelToolSpec[] = []
const spec = (name: string): ModelToolSpec => {
  const found = specs.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no agent offers a tool named "${name}"`)
  return found
}

beforeAll(async () => {
  specs = await offeredTools()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe.each(Object.keys(WIRES) as ProviderName[])('the %s wire', (provider) => {
  const wire = WIRES[provider]
  const client = () => {
    vi.stubEnv(wire.key, 'test-key-not-a-real-one')
    for (const name of wire.moves) vi.stubEnv(name, undefined)
    return createClient({ mode: 'live', choice: { provider, model: wire.model } })
  }

  it('sends every tool any agent offers with an object-rooted schema', async () => {
    for (const tools of requests(specs)) {
      const sent = serving(wire.saying('done'))
      const result = await client().generate(request(tools, 'auto'))

      expect(sent).toHaveLength(1)
      expect(sent[0]?.url).toBe(wire.url)
      const schemas = wire.schemas(sent[0]?.body ?? {})
      expect(schemas.map(([name]) => name)).toEqual(tools.map((each) => each.name))
      for (const [name, schema] of schemas) {
        expect(schema['type'], `${name} is sent with no object root`).toBe('object')
        for (const key of ROOT_UNIONS) {
          expect(schema, `${name} is sent with ${key} at its root`).not.toHaveProperty(key)
        }
      }
      expect(result).toEqual({
        text: 'done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
    }
  })

  it.each([
    ['answer', { outcome: 'entities', refs: ['resource:default/billing-db-prod'] }],
    ['verdict', { verdict: 'reject', reason: 'the request asked for read, the plan grants write' }],
  ])('forces %s and reads the call back', async (tool, args) => {
    const id = `call_${tool}_01`
    const sent = serving(wire.calling(tool, args, id))
    const result = await client().generate(request([spec('answer'), spec('verdict')], { tool }))

    expect(sent).toHaveLength(1)
    wire.forced(sent[0]?.body ?? {}, tool)
    expect(result.toolCalls).toEqual([{ id, name: tool, args }])
  })

  it('never leaves a tool to a provider default of strict mode', async () => {
    // Measured against OpenAI's Responses API with gpt-6-luna: a function tool
    // sent with no `strict` comes back echoed as `strict: true`, and the model
    // is then made to fill every property — `env: ""`, `env: "default"` — so a
    // search that needed no environment matched nothing, and an overview came
    // with refs attached. Every schema here has optional fields, which strict
    // mode cannot express. Anthropic accepts the flag only on models that
    // support it, and otherwise ignores it; it must still never be true.
    for (const tools of requests(specs)) {
      const sent = serving(wire.saying('done'))
      await client().generate(request(tools, 'auto'))

      for (const tool of records(sent[0]?.body['tools'])) {
        const nested = tool['function'] as Body | undefined
        const flag = tool['strict'] ?? nested?.['strict']
        const name = String(tool['name'] ?? nested?.['name'])
        expect(flag, `${name} is sent in strict mode`).not.toBe(true)
        if (provider !== 'anthropic') {
          expect(flag, `${name} leaves strict to a default`).toBe(false)
        }
      }
    }
  })

  it('passes a call its union refuses through as sent, for the agent to hand back', async () => {
    // The flat advertisement lets `{ outcome: "entities" }` through with no
    // refs. The SDK checks it against the union, flags it invalid, and returns
    // it anyway; nothing here drops it. What stops it is the agent's own parse
    // of its terminal tool — which is why the looser advertisement is safe.
    const args = { outcome: 'entities' }
    serving(wire.calling('answer', args, 'call_invalid_01'))
    const result = await client().generate(request([spec('answer')], { tool: 'answer' }))

    expect(result.toolCalls).toEqual([{ id: 'call_invalid_01', name: 'answer', args }])
  })
})

describe('a schema no provider can be sent', () => {
  it('stops the run before a request exists, naming the tool', async () => {
    const sent = serving(WIRES.anthropic.saying('never'))
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-real-one')
    const client = createClient({
      mode: 'live',
      choice: { provider: 'anthropic', model: WIRES.anthropic.model },
    })
    const loose: ModelToolSpec = {
      name: 'loose',
      description: 'two shapes and nothing to tell them apart by',
      parameters: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    }

    await expect(client.generate(request([loose], 'auto'))).rejects.toThrow(/tool "loose"/)
    expect(sent).toHaveLength(0)
  })
})
