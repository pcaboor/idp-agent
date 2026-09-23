import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { hashTree } from '../support/tree.js'

/**
 * The whole chain, against a recorded model: Inspector → Architect → the five
 * gates → the diff. Everything but the HTTP call is real — the bounded loops,
 * the tool registries, the strict schemas, the signature, the policies, the
 * Reviewer, the re-check and the renderer.
 *
 * Recorded once with IDP_RECORDING=record and a key; replayed by everyone else
 * with neither. The recordings are keyed on (scenario, agent, turn) and never
 * on a prompt hash, so a reworded system prompt replays and a changed one is a
 * warning rather than a silent miss.
 *
 * Replay is instant; recording talks to a provider and takes seconds per turn,
 * so the timeout is sized for the recording run.
 */
// Ten minutes, and the number is about RECORDING rather than replay — a replay
// is milliseconds. A recording makes a dozen real calls, and a provider that
// starts throttling turns a 50-second pass into a 900-second one. The old 240
// seconds killed four recordings mid-run and lost every turn they had already
// paid for, because a tape is written when the run ends.
const TIMEOUT = 600_000

const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')

/** A declarations repository, scaffolded the way a user's would be. */
const declarations = async (
  entities: Record<string, string> = {},
): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-plan-')), 'iac')
  await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0-test' })
  const { mkdir } = await import('node:fs/promises')
  for (const [relative, text] of Object.entries(entities)) {
    const absolute = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(absolute), { recursive: true })
    // A folder exists in this repository when a witness says so (§7.2), and
    // `init platform` scaffolds none for Components — they live in the
    // service's own repository. A catalogue that aggregates both is what a
    // real Backstage sees, so the fixture declares the folder the way a
    // repository holding them would.
    await writeFile(path.join(path.dirname(absolute), '.witness.yml'), '---\n', {
      flag: 'w',
    })
    await writeFile(absolute, text, 'utf8')
  }
  // Every environment the scenarios use, declared where §7.0 says: a fresh
  // repository holds no entities, so nothing would enumerate them otherwise.
  await writeFile(
    path.join(root, '.idp-agent.yml'),
    'iacRepo: acme/iac\nenvironments:\n  - dev\n  - staging\n  - prod\n',
    'utf8',
  )
  return root
}

/** The application repository the Inspector reads. */
const application = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'idp-app-'))
  for (const [relative, text] of Object.entries(files)) {
    await writeFile(path.join(root, relative), text, 'utf8')
  }
  return root
}

const ORDERS_DB = `---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: orders-db-prod
  annotations:
    company.fr/env: prod
spec:
  type: database
  owner: group:default/tiger
`

const BILLING_API = `---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: billing-api
  annotations:
    company.fr/env: prod
spec:
  type: service
  lifecycle: production
  owner: group:default/tiger
`

const PACKAGE_JSON = JSON.stringify(
  { name: 'billing-api', dependencies: { pg: '^8.11.0' } },
  null,
  2,
)

const run = async (
  scenario: string,
  intent: string,
  repo: string,
  project: string,
): Promise<{ code: number; out: string; err: string; events: AgentEvent[] }> => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(['plan', intent, '--repo', repo], {
    cwd: project,
    recordingDir: RECORDINGS,
    scenario,
    env: process.env,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
    // Somebody at the keyboard, answering the one question a grant always
    // carries. Without it these scenarios stop at the level and never exercise
    // the two gates past it — which is the half of the chain a recording is
    // for. Every other question is declined, so a scenario about an unvouched
    // owner still ends on that owner.
    ask: async (question) => (question.path.endsWith('.access') ? 'read' : undefined),
  })
  const stderr = err.join('')
  // A recording whose prompt has drifted replays anyway and warns, and the
  // warning went to a sink nobody read: every scenario captured `err` and
  // asserted nothing about it, so twelve green tests could be replaying
  // behaviour produced under a system prompt that no longer exists. The
  // warning is the harness's only signal that a tape has gone stale, and a
  // signal nothing asserts on is not a signal.
  expect(stderr, `${scenario}: the recording is stale — re-record it`).not.toMatch(
    /prompt changed since recording/,
  )
  return { code, out: out.join(''), err: stderr, events }
}

/**
 * What holds whatever the model proposed.
 *
 * A recording freezes one sample of a model's behaviour, not a law: re-record
 * these and the Reviewer that refused on the merits last time may be a
 * re-check refusing a duplicate this time. Asserting the exact verdict makes a
 * test that is true until the day someone re-records, and then quietly wrong.
 *
 * So these are the invariants: the repository does not move, a run that
 * refused shows no diff, the exit code is one of the three the design allows —
 * never 2, which would mean the arguments were refused rather than the plan —
 * and whatever happened is stated rather than silent.
 */
const endedWell = (code: number, out: string): void => {
  expect([0, 1, 3]).toContain(code)
  if (code === 0) {
    // Two shapes end well on exit 0, and the second is §7.5's already-declared
    // row: a plan that RESTATES what the repository holds produces bytes
    // identical to the ones on disk, so there is no diff to show and the run
    // says so instead. It used to be reachable a third way — a model calling
    // propose with no operations at all — and that is what made asserting a
    // diff here the only safe rule. Both boundaries require an operation now,
    // so "nothing to change" can only mean the repository already says it.
    if (/^\+\+\+ /m.test(out)) expect(out).toContain('nothing written')
    else expect(out).toContain('nothing to change')
    expect(out).toContain('nothing written')
    return
  }
  // Refused or asked: no diff, and a reason. Four shapes reach here — a gate
  // refused, the signature asked, three attempts were spent, or the Architect
  // produced no proposal at all — and every one of them has to SAY so. A run
  // that ends with no diff and no sentence is the failure this whole stage is
  // built to make impossible.
  expect(out).not.toMatch(/^\+\+\+ /m)
  expect(out).toMatch(/asked rather than guessed|refused/)
  expect(out.trim().length).toBeGreaterThan(0)
}

/** The run reached the model rather than failing before it. */
const reachedTheModel = (events: AgentEvent[]): void => {
  const started = events
    .filter((event) => event.type === 'agent:start')
    .map((event) => (event.type === 'agent:start' ? event.agent : ''))
  expect(started).toContain('inspector')
  expect(started).toContain('architect')
}

describe('plan "<intent>"', () => {
  it(
    'link-db-exists: proposes the access alone when the database is already declared',
    async () => {
      const repo = await declarations({
        'catalog/databases/orders-db-prod.yml': ORDERS_DB,
        'systems/billing-api.yml': BILLING_API,
      })
      const project = await application({ 'package.json': PACKAGE_JSON })
      const before = await hashTree(repo)

      const { code, out, events } = await run(
        'link-db-exists',
        'give billing-api read access to orders-db in prod',
        repo,
        project,
      )

      // The stage's claim, on the path that reaches a model.
      expect(await hashTree(repo)).toBe(before)
      endedWell(code, out)
      reachedTheModel(events)
    },
    TIMEOUT,
  )

  it(
    'link-db-missing: the database is not in the catalogue',
    async () => {
      const repo = await declarations({ 'systems/billing-api.yml': BILLING_API })
      const project = await application({ 'package.json': PACKAGE_JSON })
      const before = await hashTree(repo)

      const { code, out, events } = await run(
        'link-db-missing',
        'give billing-api read access to orders-db in prod',
        repo,
        project,
      )

      expect(await hashTree(repo)).toBe(before)
      endedWell(code, out)
      reachedTheModel(events)
    },
    TIMEOUT,
  )

  it(
    'link-ambiguous-env: the request names no environment',
    async () => {
      // "Declare, never infer": silence in the request is not permission. An
      // environment is echoed or it is a question — never enumerated, because
      // `prod` always exists.
      const repo = await declarations({
        'catalog/databases/orders-db-prod.yml': ORDERS_DB,
        'systems/billing-api.yml': BILLING_API,
      })
      const project = await application({ 'package.json': PACKAGE_JSON })
      const before = await hashTree(repo)

      const { code, out, events } = await run(
        'link-ambiguous-env',
        'give billing-api read access to orders-db',
        repo,
        project,
      )

      expect(await hashTree(repo)).toBe(before)
      endedWell(code, out)
      reachedTheModel(events)
    },
    TIMEOUT,
  )

  it(
    'link-already-declared: the access is in the repository already',
    async () => {
      // The declaration states its level. Without it this fixture predated
      // §5.3's field and the scenario could not test its own name: a request
      // for read against a declaration stating no level is a
      // declared-level-mismatch, correctly — so the idempotent path §7.5
      // describes was never reached by the scenario built to reach it.
      const repo = await declarations({
        'catalog/databases/orders-db-prod.yml': ORDERS_DB,
        'systems/billing-api.yml': BILLING_API,
        'dependencies/access/billing-api-orders-db-prod.yml': `---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: billing-api-orders-db-prod
  annotations:
    company.fr/env: prod
spec:
  type: database-access
  # The level this grant states, and the one the request asks for.
  access: read
  owner: group:default/tiger
  dependsOn:
    - resource:default/orders-db-prod
  dependencyOf:
    - component:default/billing-api
`,
      })
      const project = await application({ 'package.json': PACKAGE_JSON })
      const before = await hashTree(repo)

      const { code, out, events } = await run(
        'link-already-declared',
        'give billing-api read access to orders-db in prod',
        repo,
        project,
      )

      expect(await hashTree(repo)).toBe(before)
      endedWell(code, out)
      reachedTheModel(events)
    },
    TIMEOUT,
  )
})

describe('an owner the request names, against a real model', () => {
  it(
    'repair-malformed-owner: a group outside the catalogue is written because a person asked for it',
    async () => {
      // §9.3's fifth scenario, and it no longer tests what its id says. It was
      // built so the Architect would always have something real to repair: the
      // repository declares one group, the request names another, and the
      // signature was expected to refuse the second every time.
      //
      // It does not, and should not. A value the request itself carries is
      // ECHOED — vouched for by the person who wrote it (§5.4) — and refusing
      // an owner the catalogue has not used yet is the trap the type check
      // already fell into: the first grant of a new team could never be
      // proposed. So the owner is written, and the merge is where it is
      // authorised. What this asserts is that provenance rule end to end.
      //
      // The repair loop itself is covered by scripted clients in
      // tests/unit/repair.test.ts, where a refusal can be guaranteed. No
      // scenario can force a real model to be wrong, and the current five
      // record zero refusals between them.
      const repo = await declarations({
        'catalog/databases/orders-db-prod.yml': ORDERS_DB,
        'systems/billing-api.yml': BILLING_API,
      })
      const project = await application({ 'package.json': PACKAGE_JSON })
      const before = await hashTree(repo)

      const { code, out, events } = await run(
        'repair-malformed-owner',
        'give billing-api read access to orders-db in prod, owned by group:default/platform-wizards',
        repo,
        project,
      )

      expect(await hashTree(repo)).toBe(before)
      endedWell(code, out)
      reachedTheModel(events)
      // The owner is the one the request named, and it reaches the diff rather
      // than being replaced by the one derivation would have read off the
      // consumer. A run that asked or repaired says so either way.
      if (code === 0) expect(out).toContain('group:default/platform-wizards')
      expect(events.some((event) => event.type === 'repair' || event.type === 'ask')).toBe(
        true,
      )
    },
    TIMEOUT,
  )
})

describe('the recordings themselves', () => {
  it('no shipped recording is hand-authored', async () => {
    // Stage 2 introduced the handAuthored flag and never tested it. A
    // fabricated recording passing as a real one would make the whole harness
    // worthless, and nothing would say so.
    const { readdir, readFile } = await import('node:fs/promises')
    const files = (await readdir(RECORDINGS)).filter((name) => name.endsWith('.json'))

    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const raw = await readFile(path.join(RECORDINGS, file), 'utf8')
      const tape = JSON.parse(raw) as { turns?: { handAuthored?: boolean }[] }
      expect(
        (tape.turns ?? []).every((turn) => turn.handAuthored !== true),
        `${file} carries a hand-authored turn`,
      ).toBe(true)
    }
  })

  it('carries no credential', async () => {
    // What is recorded is a request and a response. Neither should ever hold
    // the key that made it — checked here rather than trusted, because a
    // recording is committed and a key in one is a key in the history.
    const { readdir, readFile } = await import('node:fs/promises')
    const files = (await readdir(RECORDINGS)).filter((name) => name.endsWith('.json'))

    for (const file of files) {
      const raw = await readFile(path.join(RECORDINGS, file), 'utf8')
      expect(raw, `${file}`).not.toMatch(/authorization|api[_-]?key|bearer\s/i)
    }
  })
})
