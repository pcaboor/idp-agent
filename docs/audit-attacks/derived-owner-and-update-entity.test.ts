import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runIntent, runPlan } from '../../src/cli/commands/plan.js'
import { CONFIG_FILE } from '../../src/cli/config.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import type { Question } from '../../src/core/plan/clarify.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'

/*
 * Adversarial reproduction of two suspected defects. Everything below is
 * copied from tests/unit/plan-intent.test.ts and tests/scenarios/plan-mode.test.ts
 * except where a comment says otherwise.
 */

// ---- copied from tests/unit/plan-intent.test.ts -----------------------------

const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return (
        turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      )
    },
  }
}

const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

const openingOf = (request: GenerateRequest | undefined): string => {
  const first = request?.transcript[0]
  return first !== undefined && first.role === 'user' ? first.text : ''
}

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-audit-'))

const application = async (config?: string): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8' } }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, 'CODEOWNERS'), '* @acme/platform\n', 'utf8')
  if (config !== undefined) await writeFile(path.join(root, CONFIG_FILE), config, 'utf8')
  return root
}

const CONFIGURED = `iacRepo: github.com/acme/iac
environments: [dev, staging, prod]
`

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [{ name: 'pg', type: 'database' }],
}

// ---- copied from tests/scenarios/plan-mode.test.ts --------------------------

/**
 * FIXTURE CHANGE vs the scenario helper: the `.idp-agent.yml` it writes into
 * the iac root is NOT written here. `readRepository` skips hidden DIRECTORIES
 * only, so a hidden `.yml` at the root is parsed as an entity file, rejected by
 * `entitySchema` ("kind: Invalid discriminator value"), and `checkRepository`
 * reports that as an `invalid-entity` ERROR — which the recheck gate would
 * refuse on every run, regardless of the plan under test. The intent road reads
 * its config from the APPLICATION repo (`application(CONFIGURED)`), and
 * `runPlan` reads none, so nothing here needs it.
 */
const declarations = async (entities: Record<string, string> = {}): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-plan-')), 'iac')
  await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0-test' })
  for (const [relative, text] of Object.entries(entities)) {
    const absolute = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(path.join(path.dirname(absolute), '.witness.yml'), '---\n', { flag: 'w' })
    await writeFile(absolute, text, 'utf8')
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

// ---- new fixtures -----------------------------------------------------------

const PAYMENTS_API = `---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payments-api
  annotations:
    company.fr/env: prod
spec:
  type: service
  lifecycle: production
  owner: group:default/lion
`

/** Keys in the order `serializeEntity` emits them: type, access, owner, dependsOn, dependencyOf. */
const PAYMENTS_ACCESS = `---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: payments-api-orders-db-prod
  annotations:
    company.fr/env: prod
spec:
  type: database-access
  access: readwrite
  owner: group:default/lion
  dependsOn:
    - resource:default/orders-db-prod
  dependencyOf:
    - component:default/payments-api
`

const banner = (title: string, body: string): void => {
  console.log(`\n===== ${title} =====\n${body}\n===== end ${title} =====`)
}

// -----------------------------------------------------------------------------

describe('defect 1: a derived owner survives the rejection of the consumer it was derived from', () => {
  it('ends on a diff owned by lion (payments-api) while the only consumer is billing-api (tiger)', async () => {
    const repo = await declarations({
      'catalog/databases/orders-db-prod.yml': ORDERS_DB,
      'catalog/components/billing-api.yml': BILLING_API,
      'catalog/components/payments-api.yml': PAYMENTS_API,
    })
    const project = await application(CONFIGURED)
    const INTENT = 'give billing-api read access to orders-db in prod'

    const PROPOSAL = {
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
            spec: {
              type: 'database-access',
              access: 'read',
              owner: { unknown: 'no file states who owns this access' },
              dependsOn: ['resource:default/orders-db-prod'],
              // NOT read by any tool, NOT in the request -> the signature must
              // turn this into a question. But deriveOwners runs first.
              dependencyOf: ['component:default/payments-api'],
            },
          },
        },
      ],
    }

    const client = scripted({
      inspector: [turnCalling(REPORT_TOOL, FACTS)],
      architect: [
        turnCalling('get_entity', { ref: 'resource:default/orders-db-prod' }),
        turnCalling(PROPOSE_TOOL, PROPOSAL),
      ],
      reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })

    const asked: Question[] = []
    const ask = async (question: Question): Promise<string | undefined> => {
      asked.push(question)
      if (question.path === 'operations.0.entity.spec.dependencyOf.0') {
        return 'component:default/billing-api'
      }
      console.log('DECLINED unexpected question:', JSON.stringify(question))
      return undefined
    }

    const { events, emit } = collect()
    const result = await runIntent({ intent: INTENT, repo, project, client, emit, ask, json: false })

    const derived = events.filter((event) => event.type === 'derived')
    const reviews = client.seen.filter((request) => request.agent === 'reviewer')

    banner('defect 1 / questions asked', JSON.stringify(asked, null, 2))
    banner('defect 1 / events', events.map((event) => JSON.stringify(event)).join('\n'))
    banner('defect 1 / derived events', JSON.stringify(derived, null, 2))
    banner('defect 1 / result.found', String(result.found))
    banner('defect 1 / result.text', result.text)
    banner(
      'defect 1 / reviewer openings (one per round the reviewer ran)',
      reviews.map((request, index) => `--- reviewer request #${index} ---\n${openingOf(request)}`).join('\n'),
    )
    banner(
      'defect 1 / did any reviewer opening carry a "values the engine computed" line?',
      String(reviews.some((request) => openingOf(request).includes('values the engine computed'))),
    )

    // The one question the signature raised: the consumer nobody vouched for.
    expect(asked.map((question) => question.path)).toEqual([
      'operations.0.entity.spec.dependencyOf.0',
    ])

    // The owner was derived, once, from payments-api -> lion.
    expect(derived).toEqual([
      {
        type: 'derived',
        path: 'operations.0.entity.spec.owner',
        owner: 'group:default/lion',
        from: ['component:default/payments-api'],
      },
    ])

    // The run ends on a diff (exit-0 semantics) ...
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/billing-api-orders-db-prod.yml')
    // ... whose access is owned by payments-api's team ...
    expect(result.text).toContain('owner: group:default/lion')
    // ... while its only consumer is billing-api (owned by tiger) ...
    expect(result.text).toContain('- component:default/billing-api')
    // ... and the consumer the owner was derived from is nowhere in it.
    expect(result.text).not.toContain('payments-api')

    // The reviewer ran exactly once (round 2), was shown `lion` as the owner,
    // and was told nothing was derived: no "values the engine computed" line.
    expect(reviews).toHaveLength(1)
    expect(openingOf(reviews[0])).toContain('group:default/lion')
    expect(openingOf(reviews[0])).not.toContain('values the engine computed')
  })
})

describe('check 2: update-entity through runPlan (file-borne plan, no model)', () => {
  const fixture = () =>
    declarations({
      'catalog/databases/orders-db-prod.yml': ORDERS_DB,
      'dependencies/access/payments-api-orders-db-prod.yml': PAYMENTS_ACCESS,
      'catalog/components/billing-api.yml': BILLING_API,
      'catalog/components/payments-api.yml': PAYMENTS_API,
    })

  const planFile = async (plan: unknown): Promise<string> => {
    const from = path.join(await temp(), 'plan.json')
    await writeFile(from, JSON.stringify(plan, null, 2), 'utf8')
    return from
  }

  it('(a) add-dependency-of onto an OBJECT (the database): which gate catches it', async () => {
    const repo = await fixture()
    const plan = {
      intent: 'let billing-api use orders-db in prod',
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/orders-db-prod',
          patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api' },
        },
      ],
    }
    const from = await planFile(plan)

    const prose = await runPlan({ from, repo, json: false })
    banner('check 2a / result.found', String(prose.found))
    banner('check 2a / result.text', prose.text)

    // The same run as JSON, so the gate and the rule are named rather than inferred.
    const machine = await runPlan({ from, repo, json: true })
    const report = JSON.parse(machine.text) as {
      questions: unknown[]
      policies: unknown[]
      recheck: { outcomes: Record<string, string>; violations: { rule: string; file: string; message: string; severity: string }[] }
      files: string[]
      dropped: unknown[]
    }
    banner(
      'check 2a / --json: questions / policies / recheck.violations / files / dropped',
      JSON.stringify(
        {
          questions: report.questions,
          policies: report.policies,
          recheck: report.recheck,
          files: report.files,
          dropped: report.dropped,
        },
        null,
        2,
      ),
    )

    expect(prose.found).toBe(false)
    expect(prose.text).not.toContain('@@')
    expect(report.questions).toEqual([])
    expect(report.policies).toEqual([])
    expect(report.recheck.violations.map((one) => one.rule)).toContain('invalid-entity')
    expect(prose.text).toContain("'database' is an object; only a right carries its consumers")
  })

  it('(b) add-dependency-of onto a WIDER grant (readwrite, owned by lion): diff, exit-0, and is "readwrite" visible', async () => {
    const repo = await fixture()
    const plan = {
      intent: 'give billing-api read access to orders-db in prod',
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/payments-api-orders-db-prod',
          patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api' },
        },
      ],
    }
    const from = await planFile(plan)

    const result = await runPlan({ from, repo, json: false })
    banner('check 2b / result.found', String(result.found))
    banner('check 2b / result.text', result.text)
    banner('check 2b / does "readwrite" appear in result.text?', String(result.text.includes('readwrite')))
    banner('check 2b / does "group:default/lion" appear in result.text?', String(result.text.includes('group:default/lion')))

    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/payments-api-orders-db-prod.yml')
    expect(result.text).toContain('+    - component:default/billing-api')
    // The request said "read"; the grant billing-api is being added to is
    // readwrite. The level line is unchanged context 5 lines above the insert,
    // outside the 3-line window, so the diff never shows it.
    expect(result.text).not.toContain('readwrite')
  })
})
