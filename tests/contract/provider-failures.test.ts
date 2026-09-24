import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { takeTurn } from '../../src/agents/forced-turn.js'
import type { GenerateRequest, ModelToolSpec } from '../../src/llm/client.js'
import {
  ModelOutputLimitError,
  ModelRefusalError,
  ModelTimeoutError,
  ProviderCallError,
} from '../../src/llm/failures.js'
import { KEY_VARIABLES, type ProviderName } from '../../src/llm/providers.js'
import { createClient } from '../../src/llm/runtime.js'

/**
 * What a model call that cannot succeed turns into, through the real runtime
 * and the real adapter — only `fetch` is replaced, as in `providers.test.ts`.
 *
 * Each failure must end as ONE line that says what happened and what to do:
 * not a five-minute wait, not the SDK's own multi-line text, not a raw JSON
 * body. The bodies below are each provider's own error format, so a change in
 * how an adapter reads them shows up here and not in front of a user.
 *
 * The keys are fake and the hosts are never reached. Every stub is undone after
 * each test, which puts back the thrower `tests/setup/offline.ts` installed.
 */

interface Wire {
  model: string
  moves: string[]
  /** A response that ends on `reason` having produced nothing at all. */
  empty(reason: 'length' | 'content-filter'): unknown
  /** The provider's error body for a status, carrying `message`. */
  error(status: number, message: string, code?: string): unknown
}

const WIRES: Record<ProviderName, Wire> = {
  anthropic: {
    model: 'claude-sonnet-4-5',
    moves: ['ANTHROPIC_BASE_URL'],
    empty: (reason) => ({
      type: 'message',
      id: 'msg_01',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: reason === 'length' ? 'max_tokens' : 'refusal',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    error: (status, message) => ({
      type: 'error',
      error: {
        type:
          status === 401
            ? 'authentication_error'
            : status === 429
              ? 'rate_limit_error'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error',
        message,
      },
    }),
  },
  openai: {
    model: 'gpt-6-luna',
    moves: ['OPENAI_BASE_URL'],
    empty: (reason) => ({
      id: 'resp_01',
      object: 'response',
      created_at: 0,
      status: 'incomplete',
      model: 'gpt-6-luna',
      output: [],
      incomplete_details: { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    error: (status, message, code) => ({
      error: {
        message,
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        param: null,
        code: code ?? null,
      },
    }),
  },
  mistral: {
    model: 'mistral-large-latest',
    moves: [],
    // Mistral has no content filter finish reason; the adapter reads anything
    // it does not know as "other", so only `length` is exercised for it.
    empty: () => ({
      id: 'cmpl_01',
      object: 'chat.completion',
      created: 0,
      model: 'mistral-large-latest',
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    // A real 401 from Mistral is not in its documented error shape — it is
    // `{"message":"Unauthorized"}` — so the adapter falls back to the status text.
    error: (status, message, code) =>
      status === 401
        ? { message: 'Unauthorized', request_id: 'req_01' }
        : {
            object: 'error',
            message,
            type: 'invalid_request_error',
            param: null,
            code: code ?? null,
          },
  },
}

const PROVIDERS = Object.keys(WIRES) as ProviderName[]

const request = (): GenerateRequest => ({
  agent: 'analyst',
  system: 'You answer questions about a catalogue.',
  transcript: [{ role: 'user', text: 'which databases run in prod?' }],
  tools: [],
  toolChoice: 'auto',
})

/** Counts the calls and answers each with `reply`. */
const answering = (reply: () => Response): { calls: number } => {
  const seen = { calls: 0 }
  vi.stubGlobal('fetch', async (): Promise<Response> => {
    seen.calls += 1
    return reply()
  })
  return seen
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 401 ? 'Unauthorized' : '',
    // Zero, so the SDK's own retries of a 429 or a 5xx cost no wall time here.
    headers: { 'content-type': 'application/json', 'retry-after-ms': '0', ...headers },
  })

const live = (provider: ProviderName, timeout?: number) => {
  vi.stubEnv(KEY_VARIABLES[provider], 'test-key-not-a-real-one')
  for (const name of WIRES[provider].moves) vi.stubEnv(name, undefined)
  return createClient({
    mode: 'live',
    choice: { provider, model: WIRES[provider].model },
    ...(timeout !== undefined ? { timeout } : {}),
  })
}

/** The error a call rejected with, so a test can assert on more than its type. */
const failure = async (call: Promise<unknown>): Promise<Error> => {
  try {
    await call
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`rejected with a non-error: ${String(error)}`)
  }
  throw new Error('the call succeeded')
}

/** One line a person can read: no newline, no JSON, bounded. */
const oneLine = (message: string): void => {
  expect(message).not.toContain('\n')
  expect(message).not.toMatch(/[{}]/)
  expect(message.length).toBeLessThanOrEqual(240)
}

/** An OpenAI response that answered in words. */
const completed = (text: string): unknown => ({
  id: 'resp_02',
  object: 'response',
  created_at: 0,
  status: 'completed',
  model: 'gpt-6-luna',
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
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe.each(PROVIDERS)('a %s call that cannot succeed', (provider) => {
  const wire = WIRES[provider]
  const who = `${provider} ${wire.model}`

  it('gives up when the timeout expires, once, rather than waiting on the socket', async () => {
    // Observed with gpt-6-luna: one request got no answer for five minutes —
    // undici's headers timeout — and was then retried in silence.
    const signals: AbortSignal[] = []
    let calls = 0
    vi.stubGlobal('fetch', (_: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
      calls += 1
      if (init?.signal !== undefined) signals.push(init.signal)
      return new Promise(() => {})
    })

    const started = Date.now()
    const error = await failure(live(provider, 0.05).generate(request()))

    expect(error).toBeInstanceOf(ModelTimeoutError)
    expect(error.message).toBe(
      `${who} did not answer within 0.05 s; set IDP_TIMEOUT=<seconds> to wait longer`,
    )
    expect(Date.now() - started).toBeLessThan(2000)
    // The request is aborted, not left holding a socket, and never sent again.
    expect(signals).toHaveLength(1)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(1)
  })

  it('does not retry an expired call when fetch honours the abort', async () => {
    let calls = 0
    vi.stubGlobal('fetch', (_: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
      calls += 1
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    })

    const error = await failure(live(provider, 0.05).generate(request()))

    expect(error).toBeInstanceOf(ModelTimeoutError)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(1)
  })

  it('says the key was refused on a 401, naming the variable, and asks once', async () => {
    const seen = answering(() => json(401, wire.error(401, 'invalid x-api-key', 'invalid_api_key')))
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toBe(
      `${who}: the key was refused (HTTP 401); check ${KEY_VARIABLES[provider]}`,
    )
    expect(seen.calls).toBe(1)
  })

  it('says a 403 refused the key too', async () => {
    answering(() => json(403, wire.error(403, 'forbidden')))
    const error = await failure(live(provider).generate(request()))
    expect(error.message).toBe(
      `${who}: the key was refused (HTTP 403); check ${KEY_VARIABLES[provider]}`,
    )
  })

  it('says it was rate limited on a 429, after the retries the timeout bounds', async () => {
    const seen = answering(() => json(429, wire.error(429, 'Requests rate limit exceeded')))
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toBe(`${who}: rate limited (HTTP 429)`)
    oneLine(error.message)
    // The SDK's two retries of a 429 are kept: they fall inside IDP_TIMEOUT.
    expect(seen.calls).toBe(3)
  })

  it('says the provider failed on a 5xx', async () => {
    answering(() => json(500, wire.error(500, 'Internal server error')))
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toBe(`${who}: the provider failed (HTTP 500)`)
  })

  it('names a context-length refusal as such', async () => {
    const said: Record<ProviderName, string> = {
      anthropic: 'prompt is too long: 213000 tokens > 200000 maximum',
      openai: 'Your input exceeds the context window of this model.',
      mistral:
        'Prompt contains 140000 tokens and 0 draft tokens, ' +
        'too large for model with 131072 maximum context length',
    }
    answering(() => json(400, wire.error(400, said[provider], 'context_length_exceeded')))
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toBe(
      `${who}: the request is longer than the model's context window (HTTP 400)`,
    )
  })

  it('keeps any other refusal to one sanitised, bounded line', async () => {
    // Padded with words, not one unbroken run: a run of letters and digits is
    // masked as a key, and a single `[redacted]` would be short whether or not
    // anything cut it.
    const hostile =
      `bad request\n\u001b[2J\u001b[Hsk-proj-abcdefghijklmnop ${'too long '.repeat(300)}`
    answering(() => json(400, wire.error(400, hostile)))
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toMatch(
      new RegExp(`^${who}: the request was refused \\(HTTP 400\\): bad request `),
    )
    oneLine(error.message)
    expect(error.message).toMatch(/too lo\w*…$/)
    expect(error.message.length).toBeLessThanOrEqual(who.length + 160)
    expect(error.message).not.toContain('\u001b')
    expect(error.message).not.toContain('abcdefghijklmnop')
  })

  it('does not read an echoed billing-db as an empty account', async () => {
    // The demo catalogue is billing-api and billing-db, and a 400 that quotes
    // the value it refused quotes them. The account is the provider's to name.
    const said = "Invalid 'input[3].name': expected a pattern, got 'billing-db in prod'"
    answering(() => json(400, wire.error(400, said, 'invalid_value')))
    const error = await failure(live(provider).generate(request()))

    expect(error.message).toMatch(new RegExp(`^${who}: the request was refused \\(HTTP 400\\)`))
    expect(error.message).not.toMatch(/quota/)
  })

  it('reads a 200 it cannot parse as an unreadable answer, not a refusal', async () => {
    answering(
      () =>
        new Response('<html>a proxy said hello</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toBe(`${who}: the provider's answer could not be read (HTTP 200)`)
  })

  it('says what failed when the retries outlast the timeout, not "did not answer"', async () => {
    // The SDK waits out retry-after between attempts. A timer that fires in
    // that wait fires on a provider that DID answer, with a 429.
    const seen = answering(() =>
      json(429, wire.error(429, 'Requests rate limit exceeded'), { 'retry-after-ms': '5000' }),
    )
    const error = await failure(live(provider, 0.2).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toBe(`${who}: rate limited (HTTP 429)`)
    expect(seen.calls).toBe(1)
  })

  it('says it could not reach the provider when a dead host outlasts the timeout', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      calls += 1
      // What undici throws: the SDK reads the cause to tell a dead host apart.
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
    })
    const error = await failure(live(provider, 0.2).generate(request()))

    expect(error).toBeInstanceOf(ProviderCallError)
    expect(error.message).toMatch(new RegExp(`^${who}: could not reach the provider`))
    expect(calls).toBe(1)
  })

  it('says the model hit its output limit when it stopped on length with nothing', async () => {
    answering(() => json(200, wire.empty('length')))
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ModelOutputLimitError)
    expect(error.message).toBe(`${who}: the model hit its output limit before answering`)
  })

  const filtered = it.skipIf(provider === 'mistral')
  filtered('says the provider refused to answer on a content filter', async () => {
    answering(() => json(200, wire.empty('content-filter')))
    const error = await failure(live(provider).generate(request()))

    expect(error).toBeInstanceOf(ModelRefusalError)
    expect(error.message).toBe(`${who}: the provider refused to answer`)
  })
})

describe('an empty account', () => {
  // Read from what the provider says about the account, never from a word
  // anywhere in the body: the body can echo the request, and the request is
  // the catalogue.
  it('is named from OpenAI\'s insufficient_quota code', async () => {
    answering(() =>
      json(
        429,
        WIRES.openai.error(429, 'You exceeded your current quota.', 'insufficient_quota'),
      ),
    )
    const error = await failure(live('openai').generate(request()))
    expect(error.message).toBe('openai gpt-6-luna: the account is out of quota (HTTP 429)')
  })

  it('is named from Anthropic\'s credit balance refusal', async () => {
    answering(() =>
      json(
        400,
        WIRES.anthropic.error(
          400,
          'Your credit balance is too low to access the Anthropic API. ' +
            'Please go to Plans & Billing.',
        ),
      ),
    )
    const error = await failure(live('anthropic').generate(request()))
    expect(error.message).toBe(
      'anthropic claude-sonnet-4-5: the account is out of quota (HTTP 400)',
    )
  })

  it('is not read into a rate limit whose body mentions billing', async () => {
    answering(() => json(429, WIRES.openai.error(429, 'Rate limit reached for billing-api reads')))
    const error = await failure(live('openai').generate(request()))
    expect(error.message).toBe('openai gpt-6-luna: rate limited (HTTP 429)')
  })
})

describe('a failure on the forced last turn', () => {
  // `takeTurn` retries a forced turn as an open one when the error reads like a
  // refused tool choice. None of the failures above is one, and retrying them
  // would double the wait and the bill for the same answer.
  const answer: ModelToolSpec = {
    name: 'answer',
    description: 'The answer.',
    parameters: z.object({ text: z.string() }),
  }
  const forced = (client: ReturnType<typeof createClient>) =>
    takeTurn({
      client,
      agent: 'analyst',
      system: 'You answer questions about a catalogue.',
      transcript: [{ role: 'user', text: 'which databases run in prod?' }],
      tools: [answer],
      terminal: 'answer',
      last: true,
    })

  it('is not retried as an open turn when it timed out', async () => {
    let calls = 0
    vi.stubGlobal('fetch', (): Promise<Response> => {
      calls += 1
      return new Promise(() => {})
    })
    await expect(forced(live('openai', 0.05))).rejects.toBeInstanceOf(ModelTimeoutError)
    expect(calls).toBe(1)
  })

  it.each([
    ['a refused key', 401, 1],
    ['a rate limit', 429, 3],
    ['a provider failure', 500, 3],
  ])('is not retried as an open turn on %s', async (_, status, calls) => {
    const seen = answering(() =>
      json(status, WIRES.openai.error(status, 'the tool_choice required tool was forced')),
    )
    await expect(forced(live('openai'))).rejects.toBeInstanceOf(ProviderCallError)
    expect(seen.calls).toBe(calls)
  })

  it.each([
    ['its output limit', 'length', ModelOutputLimitError],
    ['a content filter', 'content-filter', ModelRefusalError],
  ] as const)('is not retried as an open turn on %s', async (_, reason, type) => {
    const seen = answering(() => json(200, WIRES.openai.empty(reason)))
    await expect(forced(live('openai'))).rejects.toBeInstanceOf(type)
    expect(seen.calls).toBe(1)
  })

  it('still falls back when the provider names the tool choice past the summary cut', async () => {
    // The fallback is decided on the provider's whole message, not on the
    // bounded summary a person reads: a long preamble must not hide it.
    let calls = 0
    const said =
      'Invalid request for model gpt-6-luna in this deployment region with the current ' +
      'account tier and settings; the parameter tool_choice with a named function is not supported'
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      calls += 1
      return calls === 1 ? json(400, WIRES.openai.error(400, said)) : json(200, completed('done'))
    })
    await expect(forced(live('openai'))).resolves.toMatchObject({ text: 'done' })
    expect(calls).toBe(2)
  })

  it('still falls back to an open turn when the provider refuses the tool choice', async () => {
    // The one failure the fallback exists for, and it must survive the
    // rewording: the provider's own words are kept for a plain 400.
    let calls = 0
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      calls += 1
      return calls === 1
        ? json(400, WIRES.openai.error(400, "tool_choice 'required' is not supported here"))
        : json(200, completed('done'))
    })
    await expect(forced(live('openai'))).resolves.toMatchObject({ text: 'done' })
    expect(calls).toBe(2)
  })
})
