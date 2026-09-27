import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { main, renderEvent } from '../../src/cli/index.js'
import { counted } from '../../src/cli/usage.js'
import type { GenerateResult, LlmClient, TokenUsage } from '../../src/llm/client.js'

/**
 * What a run cost, said once at its end (product-gap-10): how many model
 * calls, and the tokens the provider reported for them. Each call is also an
 * event on the stream, carrying what its provider reported, so a consumer that
 * shows no more than the stream — stage 7's chat, a trace — can count too.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

const reply = (turn: Omit<GenerateResult, 'finishReason'>, usage?: TokenUsage): GenerateResult => ({
  ...turn,
  finishReason: turn.toolCalls.length > 0 ? 'tool-calls' : 'stop',
  ...(usage === undefined ? {} : { usage }),
})

const QUESTION = { text: 'QUESTION', toolCalls: [] }
const SEARCH = {
  text: '',
  toolCalls: [{ id: 'c1', name: 'search_entities', args: { type: 'database', env: 'prod' } }],
}
const ANSWER = {
  text: '',
  toolCalls: [
    { id: 'c2', name: 'answer', args: { outcome: 'entities', refs: ['resource:default/billing-db-prod'] } },
  ],
}

const scripted = (turns: GenerateResult[]): LlmClient => {
  let index = 0
  return { generate: async () => turns[index++] ?? reply({ text: '', toolCalls: [] }) }
}

const run = async (turns: GenerateResult[]) => {
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(['ask', 'which databases are in prod?', '--repo', DEMO], {
    client: scripted(turns),
    env: {},
    out: () => {},
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
  })
  return { code, err: err.join(''), events }
}

describe('what a run cost', () => {
  it('ends on one line: the calls, and the tokens every one of them reported', async () => {
    const { code, err } = await run([
      reply(QUESTION, { inputTokens: 1_200, outputTokens: 3, totalTokens: 1_203 }),
      reply(SEARCH, { inputTokens: 2_000, outputTokens: 40 }),
      reply(ANSWER, { inputTokens: 2_500, outputTokens: 60 }),
    ])
    expect(code).toBe(0)
    expect(err.trimEnd().split('\n').at(-1)).toBe(
      '· 3 model calls: 5700 input tokens, 103 output tokens',
    )
  })

  it('says which calls a count is of, when some reported none', async () => {
    const { err } = await run([
      reply(QUESTION),
      reply(SEARCH, { inputTokens: 2_000, outputTokens: 40 }),
      reply(ANSWER, { inputTokens: 2_500 }),
    ])
    expect(err.trimEnd().split('\n').at(-1)).toBe(
      '· 3 model calls: 4500 input tokens, of the 2 that reported them; 40 output tokens, ' +
        'of the 1 that reported them',
    )
  })

  it('says no count was reported rather than printing zero', async () => {
    // A tape recorded before usage was stored, or a provider that says none:
    // absent is not zero.
    const { err } = await run([reply(QUESTION), reply(SEARCH), reply(ANSWER)])
    expect(err.trimEnd().split('\n').at(-1)).toBe('· 3 model calls; no token count was reported')
  })

  it('is said on a run that failed too, before the failure, which stays the last line', async () => {
    const failing: LlmClient = {
      generate: (() => {
        let calls = 0
        return async () => {
          calls += 1
          if (calls === 1) return reply(QUESTION, { inputTokens: 10, outputTokens: 1 })
          throw new Error('the provider went away')
        }
      })(),
    }
    const err: string[] = []
    const code = await main(['ask', 'which databases are in prod?', '--repo', DEMO], {
      client: failing,
      env: {},
      out: () => {},
      err: (chunk) => void err.push(chunk),
      events: () => {},
    })
    expect(code).toBe(1)
    const lines = err.join('').trimEnd().split('\n')
    expect(lines.at(-2)).toBe('· 1 model call: 10 input tokens, 1 output token')
    expect(lines.at(-1)).toBe('the provider went away')
  })

  it("is said before the Supervisor's failure too, which is a failure's line and the last", async () => {
    // Two answers that are no word: the run fails as a call that could not
    // succeed does, and its line was printed during the run, before the
    // count — the one failure that did not end on its own line. The events
    // are rendered as a terminal shows them, not handed to a sink.
    const said: string[] = []
    const code = await main(['ask', 'which databases are in prod?', '--repo', DEMO], {
      client: scripted([
        reply({ text: 'PERHAPS', toolCalls: [] }, { inputTokens: 5, outputTokens: 1 }),
        reply({ text: 'MAYBE', toolCalls: [] }, { inputTokens: 5, outputTokens: 1 }),
      ]),
      env: {},
      out: () => {},
      err: (chunk) => void said.push(chunk),
    })
    const err = said.join('')
    expect(code).toBe(1)
    const lines = err.trimEnd().split('\n')
    expect(lines.at(-2)).toBe('· 2 model calls: 10 input tokens, 2 output tokens')
    expect(lines.at(-1)).toMatch(/^the model answered "PERHAPS", then "MAYBE", .*IDP_SUPERVISOR_MODEL/)
    // Said once: the event stream says only that the Supervisor stopped — and
    // not that it corrected itself, which it did not.
    expect(err.match(/PERHAPS/g)).toHaveLength(1)
    expect(err).toContain('! supervisor stopped')
    expect(err).not.toContain('corrected itself')
  })

  it('follows a line the command printed as its result: a refusal is not a failure', async () => {
    // Exit 3, understood and declined: the refusal is what the command
    // answered, and the count of what the run cost comes after it.
    const { code, err } = await run([
      reply(QUESTION),
      reply({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'answer', args: { outcome: 'unanswerable', reason: 'no cost data' } },
        ],
      }),
    ])
    expect(code).toBe(3)
    const lines = err.trimEnd().split('\n')
    expect(lines.at(-2)).toBe('cannot answer: no cost data')
    expect(lines.at(-1)).toBe('· 2 model calls; no token count was reported')
  })

  it('hands the inner client the options it was given: a signal must reach the call', async () => {
    // The other wrapper `agentBacked` puts around the session's client, with
    // `traced`: one that dropped the options would make a caller's signal
    // silently ignored (agents-llm-10).
    const seen: unknown[] = []
    const inner: LlmClient = {
      generate: async (_, options) => {
        seen.push(options)
        return reply(QUESTION)
      },
    }
    const options = { signal: new AbortController().signal }
    await counted(inner, () => {}).client.generate(
      { agent: 'supervisor', system: 's', transcript: [], tools: [], toolChoice: 'none' },
      options,
    )
    expect(seen[0]).toBe(options)
  })

  it('puts every call on the event stream, with what its provider reported', async () => {
    const usage = { inputTokens: 1_200, outputTokens: 3 }
    const { events } = await run([reply(QUESTION, usage), reply(SEARCH), reply(ANSWER)])
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', agent: 'supervisor', usage },
      { type: 'usage', agent: 'analyst' },
      { type: 'usage', agent: 'analyst' },
    ])
    // The line at the end is the reader's count; one line per call is not news.
    expect(renderEvent({ type: 'usage', agent: 'supervisor', usage })).toBeUndefined()
  })
})
