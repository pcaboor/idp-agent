import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import type { LlmClient } from '../../src/llm/client.js'

/**
 * A model call that cannot succeed, seen from the command line: one line on
 * stderr, the right exit code, and nothing started that could not finish.
 *
 * The runtime-level half — the bytes each provider answers with, and what they
 * become — is `tests/contract/provider-failures.test.ts`. This is the wiring:
 * what `main` reads from the environment, and what it prints.
 */

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

const run = async (
  argv: string[],
  deps: Partial<MainDeps>,
): Promise<{ code: number; out: string; err: string; events: AgentEvent[] }> => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(argv, {
    root: FIXTURES,
    cwd: FIXTURES,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
    ...deps,
  })
  return { code, out: out.join(''), err: err.join(''), events }
}

/** What a failing run may say beyond the demo notice: exactly one line. */
const failureLines = (err: string): string[] =>
  err.split('\n').filter((line) => line !== '' && !line.includes('demo'))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('a missing key', () => {
  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['mistral', 'MISTRAL_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
  ])('is refused for %s with exit 2, naming %s, before any agent runs', async (provider, key) => {
    const { code, out, err, events } = await run(['ask', 'which databases are in prod?'], {
      env: { IDP_PROVIDER: provider, IDP_MODEL: 'some-model' },
    })

    expect(code).toBe(2)
    expect(err).toContain(key)
    expect(failureLines(err)).toHaveLength(1)
    expect(out).toBe('')
    expect(events).toEqual([])
  })

  it('is refused before the Inspector reads anything, on plan "<intent>"', async () => {
    const { code, err, events } = await run(
      ['plan', 'give billing-api read access to billing-db in prod', '--repo', FIXTURES],
      { env: { IDP_PROVIDER: 'openai', IDP_MODEL: 'gpt-6-luna' } },
    )

    expect(code).toBe(2)
    expect(err).toContain('OPENAI_API_KEY')
    expect(events).toEqual([])
  })

  it('does not stop an injected client, which reads no key', async () => {
    const client: LlmClient = {
      generate: async () => ({ text: 'MUTATION', toolCalls: [], finishReason: 'stop' }),
    }
    const { code } = await run(['ask', 'which databases are in prod?'], {
      env: { IDP_PROVIDER: 'openai', IDP_MODEL: 'gpt-6-luna' },
      client,
    })
    // A change request put to `ask`: the command ran, whatever the answer.
    expect(code).toBe(3)
  })
})

describe('IDP_TIMEOUT', () => {
  const configured = {
    IDP_PROVIDER: 'openai',
    IDP_MODEL: 'gpt-6-luna',
    OPENAI_API_KEY: 'test-key-not-a-real-one',
  }

  it('is refused with exit 2, naming itself, when it is not a number of seconds', async () => {
    const { code, err, events } = await run(['ask', 'which databases are in prod?'], {
      env: { ...configured, IDP_TIMEOUT: 'soon' },
    })

    expect(code).toBe(2)
    expect(err).toContain('IDP_TIMEOUT')
    expect(events.filter((event) => event.type === 'agent:start')).toEqual([])
  })

  it('ends a call nobody answers with one line and exit 1', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-real-one')
    vi.stubEnv('OPENAI_BASE_URL', undefined)
    let calls = 0
    vi.stubGlobal('fetch', (): Promise<Response> => {
      calls += 1
      return new Promise(() => {})
    })

    const { code, out, err } = await run(['ask', 'which databases are in prod?'], {
      env: { ...configured, IDP_TIMEOUT: '0.05' },
    })

    expect(code).toBe(1)
    expect(out).toBe('')
    expect(failureLines(err)).toEqual([
      'openai gpt-6-luna did not answer within 0.05 s; set IDP_TIMEOUT=<seconds> to wait longer',
    ])
    expect(calls).toBe(1)
  })
})

describe('plan "<intent>", rendered as a person sees it', () => {
  // No `events` sink: the stream goes through the real renderer onto stderr,
  // which is where the Inspector's closing event and the command's own failure
  // line meet.
  const plan = async (fetch: () => Promise<Response>) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-real-one')
    vi.stubEnv('OPENAI_BASE_URL', undefined)
    vi.stubGlobal('fetch', fetch)
    const err: string[] = []
    const code = await main(
      ['plan', 'give billing-api read access to billing-db in prod', '--repo', FIXTURES],
      {
        root: FIXTURES,
        cwd: FIXTURES,
        out: () => {},
        err: (chunk) => void err.push(chunk),
        env: {
          IDP_PROVIDER: 'openai',
          IDP_MODEL: 'gpt-6-luna',
          OPENAI_API_KEY: 'test-key-not-a-real-one',
          IDP_TIMEOUT: '0.05',
        },
      },
    )
    return { code, err: err.join('') }
  }

  const occurrences = (text: string, part: string): number => text.split(part).length - 1

  it('says a timeout once, and never as the agent refusing', async () => {
    const { code, err } = await plan(() => new Promise(() => {}))
    const line = 'openai gpt-6-luna did not answer within 0.05 s'

    expect(code).toBe(1)
    expect(occurrences(err, line)).toBe(1)
    expect(err).not.toMatch(/refused/)
  })

  it('says a refused key once', async () => {
    const { code, err } = await plan(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    )

    expect(code).toBe(1)
    expect(occurrences(err, 'the key was refused (HTTP 401)')).toBe(1)
  })
})

describe('a provider that refuses the call', () => {
  it('prints one line and exits 1, with no stack and no body', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-real-one')
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined)
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    )

    const { code, out, err } = await run(['ask', 'which databases are in prod?'], {
      env: {
        IDP_PROVIDER: 'anthropic',
        IDP_MODEL: 'claude-sonnet-4-5',
        ANTHROPIC_API_KEY: 'test-key-not-a-real-one',
      },
    })

    expect(code).toBe(1)
    expect(out).toBe('')
    expect(failureLines(err)).toEqual([
      'anthropic claude-sonnet-4-5: the key was refused (HTTP 401); check ANTHROPIC_API_KEY',
    ])
    expect(err).not.toMatch(/\n\s+at /)
  })
})
