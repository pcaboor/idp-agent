import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runPlan, type Ask } from '../../src/cli/commands/plan.js'
import { isCleared, type Cleared, type ClearRefusal } from '../../src/core/plan/clear.js'
import { confirmingEnvironment } from '../support/ask.js'

/**
 * The preview and the clearance, over the same fixtures (D2).
 *
 * `clearPlan` orders the questions, the policies, the edits and the re-check
 * on its own, beside `runPlan`'s loop and `repair`'s — a fourth copy of the
 * gate sequence (architecture-1, gap-stage5-readiness-10). One evaluation for
 * every route stays in the owner's queue; until it lands, this table is what
 * holds the copies together: every preview that ends on exit 0 clears, and
 * every refusal, question or exit 3 refuses. The one exception is by design
 * and named below — a plan writing into both repositories (D6).
 *
 * The preview runs as a person runs it, through `main`. The clearance is the
 * one `runPlan` computes from its own signature and contexts, over the same
 * repository, observed through `PlanOptions.clearance` — the seam task 5
 * turns into the submission — never rebuilt here by hand.
 */

const EXAMPLE = path.join(import.meta.dirname, '..', '..', 'examples', 'declare-database.json')

const scaffolded = async (): Promise<string> => {
  const repo = path.join(await mkdtemp(path.join(tmpdir(), 'idp-parity-')), 'repo')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  return repo
}

const declare = async (repo: string, file: string, content: string): Promise<void> => {
  const absolute = path.join(repo, ...file.split('/'))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

/** Written beside the repository, never inside it: a plan is not a declaration. */
const planFile = async (repo: string, plan: unknown): Promise<string> => {
  const file = path.join(path.dirname(repo), 'plan.json')
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return file
}

/** A person at the prompt: `read` for a level, the draft's environment confirmed, nothing else. */
const answering: Ask = async (question) =>
  question.path.endsWith('.access') ? 'read' : confirmingEnvironment(question)

/** Nobody at the prompt. */
const nobody: Ask = async () => undefined

interface Both {
  readonly code: number
  readonly out: string
  readonly clearance: Cleared | ClearRefusal | undefined
}

const both = async (repo: string, from: string, ask: Ask): Promise<Both> => {
  const out: string[] = []
  const code = await main(['plan', '--from', from, '--repo', repo], {
    out: (chunk) => void out.push(chunk),
    err: () => undefined,
    ask,
  })

  let clearance: Cleared | ClearRefusal | undefined
  const result = await runPlan({
    from,
    repo,
    ask,
    clearance: (one) => {
      clearance = one
    },
  })
  // The same run: what `main` printed is what this call computed.
  expect(`${result.text}\n`).toBe(out.join(''))
  return { code, out: out.join(''), clearance }
}

const clears = (outcome: Both): boolean => isCleared(outcome.clearance)

const reasonsOf = (outcome: Both): string =>
  outcome.clearance !== undefined && 'outcome' in outcome.clearance
    ? outcome.clearance.reasons.join('\n')
    : ''

const database = (name: string, env: string): string =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    `  name: ${name}`,
    '  annotations:',
    `    company.fr/env: ${env}`,
    'spec:',
    '  type: database',
    '  owner: group:default/tiger',
    '',
  ].join('\n')

const GRANT_PATH = 'dependencies/access/orders-api-orders-db-prod.yml'
const GRANT = 'resource:default/orders-api-orders-db-prod'
const BILLING = 'component:default/billing-api'

const grant = (consumers: readonly string[], level = 'read'): string =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: orders-api-orders-db-prod',
    '  annotations:',
    '    company.fr/env: prod',
    'spec:',
    '  type: database-access',
    `  access: ${level}`,
    '  owner: group:default/tiger',
    '  dependsOn:',
    '    - resource:default/orders-db-prod',
    '  dependencyOf:',
    ...consumers.map((consumer) => `    - ${consumer}`),
    '',
  ].join('\n')

const component = (name: string): string =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    `  name: ${name}`,
    'spec:',
    '  type: service',
    '  lifecycle: production',
    '  owner: group:default/tiger',
    '',
  ].join('\n')

/** orders-api holds a read grant over the prod database; `consumers` are listed on it. */
const withGrant = async (consumers: readonly string[], level = 'read'): Promise<string> => {
  const repo = await scaffolded()
  await declare(repo, 'components/.witness.yml', '---\n')
  await declare(repo, 'components/billing-api.yml', component('billing-api'))
  await declare(repo, 'components/orders-api.yml', component('orders-api'))
  await declare(repo, 'catalog/databases/orders-db-prod.yml', database('orders-db-prod', 'prod'))
  await declare(repo, GRANT_PATH, grant(consumers, level))
  return repo
}

const JOIN = {
  intent: `give ${BILLING} read on orders-api-orders-db-prod`,
  operations: [
    {
      op: 'update-entity',
      entityRef: GRANT,
      patch: { patch: 'add-dependency-of', consumer: BILLING, access: 'read' },
    },
  ],
}

describe('the preview and the clearance agree', () => {
  it('clears examples/declare-database.json over a scaffolded repository, as the preview offers it', async () => {
    const repo = await scaffolded()
    const outcome = await both(repo, EXAMPLE, answering)
    expect(outcome.code).toBe(0)
    expect(outcome.out).toContain('+++ b/catalog/databases/orders-db-prod.yml')
    expect(clears(outcome)).toBe(true)
  })

  it('refuses it with an owner nobody vouches for, where the preview asks', async () => {
    const repo = await scaffolded()
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as {
      operations: { entity: { spec: { owner: string } } }[]
    }
    const stray = example.operations[0]
    if (stray !== undefined) stray.entity.spec.owner = 'group:default/ghost'
    const outcome = await both(repo, await planFile(repo, example), answering)
    expect(outcome.code).toBe(3)
    expect(clears(outcome)).toBe(false)
    expect(reasonsOf(outcome)).toContain('operations.0.entity.spec.owner')
  })

  it("refuses an update whose grant's environment nobody answered, where the preview asks", async () => {
    const repo = await withGrant(['component:default/orders-api'])
    const outcome = await both(repo, await planFile(repo, JOIN), nobody)
    expect(outcome.code).toBe(3)
    expect(clears(outcome)).toBe(false)
    expect(reasonsOf(outcome)).toContain('operations.0.environment')
  })

  it('clears an update of a declared grant, as the preview offers it', async () => {
    const repo = await withGrant(['component:default/orders-api'])
    const outcome = await both(repo, await planFile(repo, JOIN), answering)
    expect(outcome.code).toBe(0)
    expect(outcome.out).toContain(`+    - ${BILLING}`)
    expect(clears(outcome)).toBe(true)
  })

  it('clears an update the repository already says, with nothing to carry', async () => {
    const repo = await withGrant(['component:default/orders-api', BILLING])
    const outcome = await both(repo, await planFile(repo, JOIN), answering)
    expect(outcome.code).toBe(0)
    expect(outcome.out).toContain('0 files · nothing written')
    expect(clears(outcome)).toBe(true)
    expect((outcome.clearance as Cleared).edits).toEqual([])
  })

  it('refuses an update at another level than the grant declares, where the preview refuses', async () => {
    const repo = await withGrant(['component:default/orders-api'], 'readwrite')
    const outcome = await both(repo, await planFile(repo, JOIN), answering)
    expect(outcome.code).toBe(1)
    expect(clears(outcome)).toBe(false)
    expect(reasonsOf(outcome)).toContain('declared-level-mismatch')
  })

  it('refuses, by name, a plan the preview shows but that writes into two repositories (D6)', async () => {
    // The one disagreement, and a deliberate one: the preview accounts for a
    // catalog-info as the service repository's and shows the rest, while a
    // branch is cut in one repository — so the clearance names `init --submit`
    // rather than cutting half the plan.
    const repo = await scaffolded()
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as {
      intent: string
      operations: unknown[]
    }
    const mixed = {
      intent: `${example.intent}, and billing-api as a production service in catalog-info.yaml`,
      operations: [
        ...example.operations,
        {
          op: 'create-catalog-info',
          repoPath: 'catalog-info.yaml',
          entity: {
            kind: 'Component',
            metadata: { name: 'billing-api' },
            spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
          },
        },
      ],
    }
    const outcome = await both(repo, await planFile(repo, mixed), answering)
    expect(outcome.code).toBe(0)
    expect(clears(outcome)).toBe(false)
    expect(reasonsOf(outcome)).toContain('init --submit')
  })
})
