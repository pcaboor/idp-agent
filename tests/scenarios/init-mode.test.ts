import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { committed } from '../support/git.js'
import { hashTree } from '../support/tree.js'
import { disagreements, memorySink, onlyTrace } from '../support/trace.js'

/**
 * `idpa init` against a recorded model (stage 8, slice 2, Task 2.3): the
 * Inspector reads the service `--project` names, the Architect drafts its
 * Component over the declarations repository `IDP_REPO` names, and the five
 * gates judge it, the Reviewer last — the first `init` that calls one. The
 * declarations repository is a copy of the demo SI; the fixture is never
 * touched.
 *
 * Recorded once by the owner, with IDP_RECORDING=record and a key (the plan's
 * Task 2.3, Step 9); replayed by everyone else with neither. Until it is
 * recorded this fails, on `no recording for init-new-service …`.
 *
 * NO REAL SECRET IS WRITTEN HERE: both passwords are marked placeholders, and
 * the scenario asserts, on record and on replay, that the tape holds neither.
 */
const TIMEOUT = 600_000
const RECORDING = process.env['IDP_RECORDING'] === 'record'
const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

const SAMPLE_PASSWORD = 'S4mple-Passw0rd-7Qz'
const LOCAL_PASSWORD = 'Local-Passw0rd-3Mv'

/** `invoicing-worker`: its manifest and CODEOWNERS, a committed `.env.example`, and an untracked `.env`. */
const service = async (): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-init-mode-')), 'invoicing-worker')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(root)
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'invoicing-worker', dependencies: { mysql2: '^3.9.0' } }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, 'CODEOWNERS'), '*  @acme/tiger\n', 'utf8')
  await writeFile(
    path.join(root, '.env.example'),
    `DATABASE_URL=mysql://app_billing:${SAMPLE_PASSWORD}@localhost:3306/billing\n`,
    'utf8',
  )
  await committed(root)
  await writeFile(
    path.join(root, '.env'),
    `DATABASE_URL=mysql://app_billing:${LOCAL_PASSWORD}@billing-db.prod.internal:3306/billing\n`,
    'utf8',
  )
  return root
}

/** A copy of the demo SI, the declarations repository `IDP_REPO` names. */
const declarations = async (): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-init-mode-')), 'iac')
  await cp(DEMO, root, { recursive: true })
  return root
}

const run = async (
  scenario: string,
  args: readonly string[],
  repo: string,
): Promise<{ code: number; out: string; err: string; events: AgentEvent[] }> => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const sink = memorySink()
  const code = await main([...args], {
    traceSinks: [sink],
    cwd: await mkdtemp(path.join(tmpdir(), 'idp-init-mode-cwd-')),
    recordingDir: RECORDINGS,
    scenario,
    env: { ...process.env, IDP_REPO: repo },
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
    // Every flag is typed, so nothing should be asked; a question is declined,
    // and the run ends on it rather than waiting on a terminal.
    ask: async () => undefined,
  })
  const stderr = err.join('')
  // First, so a scenario nobody recorded yet says so in its own words.
  expect(stderr, `${scenario}: no tape — the owner records it`).not.toMatch(/no recording for/)
  expect(stderr, `${scenario}: the recording is stale — re-record it`).not.toMatch(
    /prompt changed since recording/,
  )
  expect(stderr, `${scenario}: the tape holds turns the run never makes`).not.toMatch(/never replayed/)
  const trace = onlyTrace(sink)
  expect(disagreements(trace, events), `${scenario}: the trace and the stream disagree`).toEqual([])
  expect(trace.spans[0]?.attributes).toMatchObject({
    'idp.mode': RECORDING ? 'record' : 'replay',
    'idp.scenario': scenario,
  })
  return { code, out: out.join(''), err: stderr, events }
}

describe('idpa init', () => {
  it(
    'init-new-service: a service the declarations repository does not declare yet',
    async () => {
      const project = await service()
      const repo = await declarations()
      const before = { project: await hashTree(project), repo: await hashTree(repo) }

      const { code, out, events } = await run(
        'init-new-service',
        [
          'init',
          '--project', project,
          '--name', 'invoicing-worker',
          '--type', 'service',
          '--lifecycle', 'production',
          '--owner', 'group:default/tiger',
        ],
        repo,
      )

      expect(code).toBe(0)
      expect(out).toContain('+++ b/catalog-info.yaml')
      expect(out).toContain('name: invoicing-worker')
      expect(out).toMatch(/^discovery — what this repository's committed configuration states/m)
      // A preview writes nothing, in either repository.
      expect(await hashTree(project)).toBe(before.project)
      expect(await hashTree(repo)).toBe(before.repo)
      // The three agents, the Reviewer among them.
      const started = events.flatMap((event) => (event.type === 'agent:start' ? [event.agent] : []))
      expect(started).toEqual(expect.arrayContaining(['inspector', 'architect', 'reviewer']))

      // What the tape holds is what every request sent: neither password.
      const tape = await readFile(path.join(RECORDINGS, 'init-new-service.json'), 'utf8')
      expect(tape.includes(SAMPLE_PASSWORD), 'the committed .env.example reached a model').toBe(false)
      expect(tape.includes(LOCAL_PASSWORD), 'the untracked .env reached a model').toBe(false)
    },
    TIMEOUT,
  )
})
