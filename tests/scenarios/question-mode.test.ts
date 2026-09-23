import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { runGraph } from '../../src/cli/commands/graph.js'
import type { AgentEvent } from '../../src/agents/events.js'

/**
 * Replay is instant; recording talks to a provider and takes seconds per turn,
 * so the timeout is sized for the recording run, not the replay.
 */
const TIMEOUT = 120_000

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')

/**
 * Drives the whole chain against a recorded model. Everything but the HTTP
 * call is real: the supervisor, the bounded loop, the tool registry, the Zod
 * validation, the witness check and the renderers.
 *
 * Recorded once with IDP_RECORDING=record and a key; replayed by everyone else.
 */
const run = async (
  scenario: string,
  intent: string,
): Promise<{ code: number; out: string; err: string; events: AgentEvent[] }> => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(['ask', intent], {
    root: FIXTURES,
    recordingDir: RECORDINGS,
    scenario,
    env: process.env,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
  })
  return { code, out: out.join(''), err: err.join(''), events }
}

describe('question mode, end to end', () => {
  it(
    'answers a question with the table the graph itself would print',
    async () => {
      // The load-bearing assertion of the whole stage: what reaches stdout is
      // renderTable's output, byte for byte, never something a model wrote.
      const { code, out } = await run('question-prod-databases', 'which databases are in prod?')
      const graph = EntityGraph.from((await new FixtureProvider(FIXTURES).load()).entities)
      expect(code).toBe(0)
      expect(out).toBe(`${runGraph(graph, { type: 'database', env: 'prod' }).text}\n`)
    },
    TIMEOUT,
  )

  it(
    'names the services that reach a database',
    async () => {
      const { code, out } = await run(
        'question-consumers-of-billing-db',
        'which services use the billing database in prod?',
      )
      expect(code).toBe(0)
      expect(out).toContain('billing-api')
    },
    TIMEOUT,
  )

  it(
    'refuses a question the catalogue cannot answer, with a reason on stderr',
    async () => {
      const { code, out, err } = await run(
        'question-unanswerable-ranking',
        'which database is the most expensive to run?',
      )
      expect(code).toBe(3)
      expect(out).toBe('')
      expect(err).toContain('cannot answer')
    },
    TIMEOUT,
  )

  it(
    'classifies a change request and declines it',
    async () => {
      const { code, err, events } = await run(
        'mutation-classified-link',
        'give billing-api read access to orders-db in prod',
      )
      expect(code).toBe(3)
      expect(err).toContain('this build only reads')
      expect(events.some((event) => event.type === 'tool:call')).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'emits the stream the TUI will consume at stage 7',
    async () => {
      const { events } = await run('question-prod-databases', 'which databases are in prod?')
      expect(events[0]).toEqual({ type: 'agent:start', agent: 'supervisor' })
      expect(events.some((event) => event.type === 'classified')).toBe(true)
      expect(events.some((event) => event.type === 'answer:ready')).toBe(true)
    },
    TIMEOUT,
  )
})
