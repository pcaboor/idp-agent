import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { runGraph } from '../../src/cli/commands/graph.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { Recording } from '../../src/llm/recording.js'
import { disagreements, memorySink, onlyTrace } from '../support/trace.js'

/**
 * Replay is instant; recording talks to a provider and takes seconds per turn,
 * so the timeout is sized for the recording run, not the replay.
 */
const TIMEOUT = 120_000

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')

/**
 * A recording run writes what it makes and checks no turn left over, so the
 * test of that check is replay's alone: recorded, it would pay for a call and
 * then fail on the exit code a recording never sets.
 */
const RECORDING = process.env['IDP_RECORDING'] === 'record'

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
  const sink = memorySink()
  const code = await main(['ask', intent], {
    traceSinks: [sink],
    root: FIXTURES,
    recordingDir: RECORDINGS,
    scenario,
    env: process.env,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
  })
  // A tape turn the run never reached fails the run, as in plan-mode.test.ts.
  // The staleness of three of these tapes is known and asserted elsewhere
  // (prompt-digests.test.ts, docs/roadmap.md), so it is not asserted here.
  expect(err.join(''), `${scenario}: the tape holds turns the run never makes`).not.toMatch(
    /never replayed/,
  )
  // The trace a replayed question produces tells the run the way its own
  // stream did, as a replayed plan's does (plan-mode.test.ts).
  const trace = onlyTrace(sink)
  expect(disagreements(trace, events), `${scenario}: the trace and the stream disagree`).toEqual([])
  expect(trace.spans[0]?.attributes).toMatchObject({ 'idp.mode': 'replay', 'idp.scenario': scenario })
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
      expect(err).toContain('run it as idpa "<phrase>" to preview the plan')
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

  it.skipIf(RECORDING)(
    'fails a replay that leaves a turn of its tape unplayed',
    async () => {
      // A turn no run reaches is an error, not silence (tests-5): here the
      // tape holds one more Analyst turn than the question makes, the way a
      // re-recording merged over a longer run used to leave one.
      const tape = JSON.parse(
        await readFile(path.join(RECORDINGS, 'question-prod-databases.json'), 'utf8'),
      ) as Recording
      const analyst = tape.turns.filter((turn) => turn.agent === 'analyst')
      const extra = { ...analyst.at(-1)!, turn: analyst.length }
      const directory = await mkdtemp(path.join(tmpdir(), 'idp-tape-'))
      await writeFile(
        path.join(directory, 'question-prod-databases.json'),
        JSON.stringify({ ...tape, turns: [...tape.turns, extra] }),
        'utf8',
      )
      const out: string[] = []
      const err: string[] = []
      const code = await main(['ask', 'which databases are in prod?'], {
        root: FIXTURES,
        recordingDir: directory,
        scenario: 'question-prod-databases',
        env: process.env,
        out: (chunk) => void out.push(chunk),
        err: (chunk) => void err.push(chunk),
        events: () => {},
      })
      expect(code).toBe(1)
      expect(err.join('')).toContain(
        `recording question-prod-databases: analyst turn ${analyst.length} was never replayed`,
      )
      // The same tape, as recorded, is played through: the error is the turn.
      expect((await run('question-prod-databases', 'which databases are in prod?')).code).toBe(0)
    },
    TIMEOUT,
  )
})
