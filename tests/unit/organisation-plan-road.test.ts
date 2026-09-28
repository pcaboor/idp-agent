import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { PROPOSE_TOOL, buildProposeTool } from '../../src/agents/tools/propose-tool.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runIntent, type Ask } from '../../src/cli/commands/plan.js'
import type { Question } from '../../src/core/plan/clarify.js'
import { operationSchema } from '../../src/core/schemas/plan.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { confirmingEnvironment } from '../support/ask.js'

/**
 * The doctrine's proof: the organisation is read for the read model, and a
 * change is decided against the write model exactly as it was. A Group, a
 * User, a System or a Domain declared in the repository is a reference that
 * resolves there, never a node, never a vouch, and never an error a plan can
 * meet.
 */

const BACKSTAGE_APIS = path.resolve(import.meta.dirname, '../golden/backstage-apis')
const ORGANISATION = path.resolve(import.meta.dirname, '../golden/organisation')

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

const calling = (...calls: Array<readonly [string, unknown]>): GenerateResult => ({
  text: '',
  toolCalls: calls.map(([name, args], at) => ({ id: `call-${String(at)}-${name}`, name, args })),
  finishReason: 'tool-calls',
})

/** Each agent's turns in order; every request kept as its digest. */
const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { sent: string[]; seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const sent: string[] = []
  const seen: GenerateRequest[] = []
  return {
    sent,
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      sent.push(`${request.agent}#${digest(request)}`)
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

const answering: Ask = async (question) =>
  question.path.endsWith('.access') ? 'read' : confirmingEnvironment(question)

/** A scaffolded declarations repository holding `golden` on top. */
const repositoryOf = async (golden: string): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-org-plan-')), 'repo')
  await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0-test' })
  await cp(golden, root, { recursive: true })
  return root
}

const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

const OPERATIONS = [
  {
    op: 'create-entity',
    entity: {
      kind: 'Resource',
      metadata: { name: 'orders-db-prod', env: 'prod' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    },
  },
  {
    op: 'create-entity',
    entity: {
      kind: 'Resource',
      metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
      spec: {
        type: 'database-access',
        access: 'read',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/orders-db-prod'],
        dependencyOf: ['component:default/billing-api'],
      },
    },
  },
]

/** The Architect reads the repository through its tools, then proposes; the Reviewer accepts. */
const drafting = (): ReturnType<typeof scripted> =>
  scripted({
    architect: [
      calling(
        ['search_entities', { kind: 'Component' }],
        ['search_entities', { kind: 'Resource' }],
        ['get_entity', { ref: 'component:default/billing-api' }],
      ),
      calling([PROPOSE_TOOL, { operations: OPERATIONS }]),
    ],
    reviewer: [calling([VERDICT_TOOL, { verdict: 'ok' }])],
  })

/** Measured on f8bcb43, before backstage-http slice 3, by the run below. */
const ON_F8BCB43 = {
  sent: [
    'architect#sha256:acbdfe6b40c4682d38b3908ae1415ee1b215897a6b2f89443e099a5cab2cf829',
    'architect#sha256:b7f824a049485d2140fb1bb7d08a30dde1febc5ae2df7b0686a122f7559717c8',
    'reviewer#sha256:555ff91ed0d8d93a5276a738faf85699d1e02515c208eb25a06f07b278894b2a',
  ],
  events: 'sha256:1dc00bd1376d5b20916e64ee684fff6f2948b99ed16a4f6eab940fc1b09321c1',
}

describe('the organisation never reaches a plan', () => {
  it('builds the plan road’s graph, summary and Architect tool results for a repository holding Groups exactly as f8bcb43 did', async () => {
    // tests/golden/backstage-apis holds org/teams.yml, a Group. What the
    // Architect is sent — its summary, and the rows of its searches — what the
    // Reviewer is sent, and every event the gates emit, which carries what
    // the signature and the policies decided, are hashed against f8bcb43's.
    const repo = await repositoryOf(BACKSTAGE_APIS)
    const client = drafting()
    const events: AgentEvent[] = []
    const result = await runIntent({
      ask: answering,
      intent: INTENT,
      repo,
      project: undefined,
      client,
      emit: (event) => void events.push(event),
    })
    expect(result.found).toBe(true)
    expect(client.sent).toEqual(ON_F8BCB43.sent)
    expect(digest(events)).toBe(ON_F8BCB43.events)
  })

  it('refuses no plan that amends a grant whose file also holds a Group Backstage would refuse', async () => {
    // The grant's file gains a second document, a Group without children. A
    // plan amending the grant passes the re-check: no error, the Group's
    // warning among the plan's warnings as it was when every Group was set
    // aside, and the Architect is sent nothing about it — one turn, no repair.
    const repo = await repositoryOf(ORGANISATION)
    const grant = path.join(repo, 'dependencies', 'access', 'billing-api-billing-db-prod.yml')
    await writeFile(
      grant,
      `${await readFile(grant, 'utf8')}---\napiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata:\n  name: ghost-team\nspec:\n  type: team\n`,
      'utf8',
    )
    const run = await planOver(repo, 'let component:default/checkout-web read through resource:default/billing-api-billing-db-prod', [
      {
        op: 'update-entity',
        entityRef: 'resource:default/billing-api-billing-db-prod',
        patch: { patch: 'add-dependency-of', consumer: 'component:default/checkout-web', access: 'read' },
      },
    ])
    expect(run.result.found).toBe(true)
    expect(run.result.text).toContain('+++ b/dependencies/access/billing-api-billing-db-prod.yml')
    expect(run.result.text).toContain(
      'Group ghost-team is not read: spec.children: required, which Backstage requires',
    )
    expect(run.result.text).not.toMatch(/\berror\b/)
    expect(run.events.filter((event) => event.type === 'repair')).toEqual([])
    expect(run.client.seen.filter((request) => request.agent === 'architect')).toHaveLength(1)
  })

  it('resolves, in the Architect’s summary, a dependsOn naming a System Backstage would refuse and one naming a read Group: dangling references: 0', async () => {
    const repo = await repositoryOf(ORGANISATION)
    await writeFile(
      path.join(repo, 'org', 'events.yml'),
      '---\napiVersion: backstage.io/v1alpha1\nkind: System\nmetadata:\n  name: events\n',
      'utf8',
    )
    const database = path.join(repo, 'catalog', 'databases', 'billing-db-prod.yml')
    await writeFile(
      database,
      `${await readFile(database, 'utf8')}  dependsOn:\n    - system:default/events\n    - group:default/tiger\n`,
      'utf8',
    )
    const run = await planOver(repo, INTENT, OPERATIONS)
    const opening = run.client.seen.find((request) => request.agent === 'architect')?.transcript[0]
    expect(opening?.role === 'user' ? opening.text : '').toContain('dangling references: 0')
  })

  it('vouches nothing with a declared Group: a proposed owner no entity carries signs novel and is asked, Group file or not', async () => {
    // group:default/engineering is declared by org/engineering.yml and owns
    // the Domain; no entity names it. The request does not either.
    const intent =
      'declare the database ledger-db-prod in prod, then give component:default/billing-api ' +
      'a database-access granting read to resource:default/ledger-db-prod'
    const operations = [
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: { name: 'ledger-db-prod', env: 'prod' },
          spec: { type: 'database', owner: 'group:default/engineering' },
        },
      },
    ]
    const withGroups = await planOver(await repositoryOf(ORGANISATION), intent, operations)
    const withoutGroups = await repositoryOf(ORGANISATION)
    await rm(path.join(withoutGroups, 'org'), { recursive: true })
    const without = await planOver(withoutGroups, intent, operations)
    const owners = (asked: readonly Question[]): string[] =>
      asked.map(({ path: at }) => at).filter((at) => at.endsWith('.owner'))
    expect(owners(withGroups.asked)).toEqual(['operations.0.entity.spec.owner'])
    expect(withGroups.asked).toEqual(without.asked)
  })

  it('derives a grant’s owner from its consumers, as before, when the owner’s Group is declared in the repository', async () => {
    const operations = [
      OPERATIONS[0],
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
          spec: {
            type: 'database-access',
            access: 'read',
            owner: { unknown: 'who owns the grant' },
            dependsOn: ['resource:default/orders-db-prod'],
            dependencyOf: ['component:default/billing-api'],
          },
        },
      },
    ]
    const withGroups = await planOver(await repositoryOf(ORGANISATION), INTENT, operations)
    const withoutGroups = await repositoryOf(ORGANISATION)
    await rm(path.join(withoutGroups, 'org'), { recursive: true })
    const without = await planOver(withoutGroups, INTENT, operations)
    const derived = (events: readonly AgentEvent[]): AgentEvent[] =>
      events.filter((event) => event.type === 'derived')
    expect(derived(withGroups.events)).toEqual([
      {
        type: 'derived',
        path: 'operations.1.entity.spec.owner',
        owner: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
    ])
    expect(derived(withGroups.events)).toEqual(derived(without.events))
    expect(withGroups.result.text).toBe(without.result.text.replaceAll(path.dirname(withoutGroups), path.dirname(withGroups.repo)))
  })

  it('gives the propose tool and the proposal schemas no field for a Group, a User, a System or a Domain', () => {
    expect(JSON.stringify(buildProposeTool().spec)).not.toMatch(/memberOf|"children"|subdomainOf|"domain"/)
    for (const kind of ['Group', 'User', 'System', 'Domain']) {
      const parsed = operationSchema.safeParse({
        op: 'create-entity',
        entity: { kind, metadata: { name: 'tiger' }, spec: { type: 'team', children: [], owner: 'group:default/tiger' } },
      })
      expect(parsed.success).toBe(false)
    }
  })
})

/** A plan drafted by a scripted Architect over `repo`: what it printed, emitted, asked and sent. */
async function planOver(repo: string, intent: string, operations: readonly unknown[]) {
  const client = scripted({
    architect: [calling([PROPOSE_TOOL, { operations }])],
    reviewer: [calling([VERDICT_TOOL, { verdict: 'ok' }])],
  })
  const events: AgentEvent[] = []
  const asked: Question[] = []
  const result = await runIntent({
    ask: async (question) => {
      asked.push(question)
      return answering(question)
    },
    intent,
    repo,
    project: undefined,
    client,
    emit: (event) => void events.push(event),
  })
  return { result, events, asked, client, repo }
}
