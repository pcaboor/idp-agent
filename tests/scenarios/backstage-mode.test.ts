import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { Recording } from '../../src/llm/recording.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'
import { disagreements, memorySink, onlyTrace } from '../support/trace.js'

/**
 * Question mode over a Backstage catalogue, against a recorded model
 * (backstage-http slice 1's `question-backstage-owner`, slice 3's two
 * organisation questions; docs/plans/backstage-http-slice-3.md, owner step R).
 *
 * The catalogue is the fake of `tests/support/fake-backstage.ts`, handed to
 * `main` as `catalogueFetch`: in process, never a socket, recording or not.
 * `tests/setup/shell.ts` removes the shell's `IDP_BACKSTAGE_*` even while a
 * scenario records, so the scenario names its own catalogue URL, and what the
 * tape holds is what the fake served: this repository's demo data, no
 * company's.
 *
 * Replay is instant; recording talks to a provider and takes seconds per turn,
 * so the timeout is sized for the recording run.
 */
// Ten minutes, as plan-mode.test.ts, and the number is about RECORDING rather
// than replay — a replay is milliseconds. A question makes up to five calls
// (the Supervisor, then the Analyst's four turns), and one call alone may take
// DEFAULT_TIMEOUT_SECONDS (120) with its retries when a provider throttles. A
// tape is written when the run ends, so a test killed mid-run loses every turn
// it had already paid for.
const TIMEOUT = 600_000

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORGANISATION = path.resolve(import.meta.dirname, '../golden/organisation')
const ORG_YAML = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')
const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'

/** The only run of this file that may call a model: `tests/setup/shell.ts` keeps the switch for a scenario alone. */
const RECORDING = process.env['IDP_RECORDING'] === 'record'

type Item = Record<string, unknown>

/**
 * What the fake serves. The demo SI with the demo's organisation
 * (`tools/backstage/org.yaml`, as `pnpm demo:backstage` and the Docker
 * Backstage serve it), or `tests/golden/organisation` alone — the fake
 * program's `--no-org` — whose billing-api declares `system: billing`.
 */
const served = (root: string, options: { org?: boolean } = {}): Item[] =>
  catalogueOf(root, options.org === false ? {} : { org: ORG_YAML })

interface Ran {
  code: number
  out: string
  err: string
  events: AgentEvent[]
}

/**
 * `question-mode.test.ts`'s `run`, over a catalogue: `ask` with the fake as
 * the transport and the URL the scenario names. Everything but the model's
 * HTTP call is real — the catalogue read, the Supervisor, the Analyst's
 * bounded loop, its tools, the witness check and the renderers.
 */
const run = async (scenario: string, intent: string, entities: Item[]): Promise<Ran> => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const sink = memorySink()
  const catalogue = fakeBackstage({ entities })
  const code = await main(['ask', intent], {
    traceSinks: [sink],
    recordingDir: RECORDINGS,
    scenario,
    env: { ...process.env, IDP_BACKSTAGE_URL: LOOPBACK },
    catalogueFetch: catalogue.fetch,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
  })
  const stderr = err.join('')
  // A turn the tape does not hold is fatal (src/llm/recording.ts), and said
  // first: before its tape exists, this is the one failure a scenario shows.
  expect(stderr, `${scenario}: no tape — record it (tests/README.md, "The tapes")`).not.toMatch(
    /no recording for/,
  )
  // A replay under a request the code no longer sends is a stale tape, as in
  // plan-mode.test.ts: the warning is the harness's only signal of it.
  expect(stderr, `${scenario}: the recording is stale — re-record it`).not.toMatch(
    /prompt changed since recording/,
  )
  // A tape turn the run never reached fails the run, as in plan-mode.test.ts.
  expect(stderr, `${scenario}: the tape holds turns the run never makes`).not.toMatch(
    /never replayed/,
  )
  // The catalogue was read — not the demo SI, not a repository.
  expect(catalogue.sent.length, `${scenario}: the catalogue was never read`).toBeGreaterThan(0)
  expect(stderr).toContain('reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL)')
  // Whatever the model chose, the trace tells the run the way its stream did.
  const trace = onlyTrace(sink)
  expect(disagreements(trace, events), `${scenario}: the trace and the stream disagree`).toEqual([])
  expect(trace.spans[0]?.attributes).toMatchObject({
    'idp.mode': RECORDING ? 'record' : 'replay',
    'idp.scenario': scenario,
  })
  // What the model was sent held no '@': ada's email annotation and profile
  // are served by the fake and never requested, so no address reaches a
  // provider (backstage-http slice 3, question 2). Read off the tape, which is
  // what was sent the day it was recorded; the stale check above says today's
  // requests are those.
  const tape = JSON.parse(await readFile(path.join(RECORDINGS, `${scenario}.json`), 'utf8')) as Recording
  expect(tape.turns.length).toBeGreaterThan(0)
  for (const turn of tape.turns) {
    expect(JSON.stringify(turn.call), `${scenario} ${turn.agent} turn ${turn.turn} sent an '@'`).not.toContain('@')
  }
  return { code, out: out.join(''), err: stderr, events }
}

/** The lines the engine wrote: every line but the model's intro and conclusion, marked `› ` (ADR-0008). */
const engineLines = (out: string): string[] => out.split('\n').filter((line) => !line.startsWith('› '))

/**
 * The first line the engine wrote: the name a card or a relation block starts
 * with, i.e. the entity the answer is about.
 */
const engineHeader = (out: string): string | undefined =>
  engineLines(out).find((line) => line.trim() !== '')

/** The engine's block names `ref`: a model's sentence naming it is not enough. */
const engineNames = (out: string, ref: string): void => {
  expect(
    engineLines(out).some((line) => line.includes(ref)),
    `the engine's block names ${ref}:\n${out}`,
  ).toBe(true)
}

describe('question mode over a Backstage catalogue, end to end', () => {
  it(
    'answers who owns billing-api from a Backstage catalogue',
    async () => {
      // backstage-http slice 1: the demo SI and its organisation, served.
      // A card or a relation block, whichever the model chose: both are the
      // engine's, and both name the owner in full.
      const { code, out } = await run('question-backstage-owner', 'who owns billing-api?', served(DEMO))
      expect(code).toBe(0)
      engineNames(out, 'group:default/tiger')
    },
    TIMEOUT,
  )

  it(
    'answers what team tiger owns with the relation block',
    async () => {
      // backstage-http slice 3: tests/golden/organisation, --no-org. What a
      // team owns is written by the engine, about tiger: the relation block
      // (`owns (N)`, the walk the plan asks for) or tiger's card, whose `owns`
      // section lists the same rows. Both are right; failing the card would
      // throw away a paid recording for a correct answer.
      const { code, out, events } = await run(
        'question-organisation-owns',
        'what does team tiger own?',
        served(ORGANISATION, { org: false }),
      )
      expect(code).toBe(0)
      expect(events.some((event) => event.type === 'answer:ready')).toBe(true)
      expect(engineHeader(out), `the engine's block is about tiger:\n${out}`).toBe('group:default/tiger')
      expect(engineLines(out).some((line) => /^owns( \(\d+\))?$/.test(line)), out).toBe(true)
      engineNames(out, 'component:default/billing-api')
    },
    TIMEOUT,
  )

  it(
    'answers which system billing-api is in',
    async () => {
      // backstage-http slice 3: the same source, where billing-api declares
      // `system: billing`; a Backstage `partOf` is emitted from that field.
      // The block must be about billing-api (its card's `system` line, or its
      // `part of` block) or about the system: tiger's `owns` block also lists
      // system:default/billing, and would answer another question.
      const { code, out } = await run(
        'question-organisation-system',
        'which system is billing-api in?',
        served(ORGANISATION, { org: false }),
      )
      expect(code).toBe(0)
      expect(
        ['component:default/billing-api', 'system:default/billing'],
        `the engine's block is about billing-api or its system:\n${out}`,
      ).toContain(engineHeader(out))
      engineNames(out, 'system:default/billing')
    },
    TIMEOUT,
  )
})
