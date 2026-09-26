import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { answerQuestion } from '../../src/agents/analyst.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import { runRelations } from '../../src/cli/commands/relations.js'
import { main } from '../../src/cli/index.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { RELATION_LIMITS } from '../../src/context/graph/relations.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { QUERY_LIMITS, answerSchema } from '../../src/core/schemas/query.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'

/**
 * A relation question answered by the Analyst: the model CHOOSES the entity
 * and the relation, from references a tool returned, and the engine computes
 * the relation and writes it with the renderer `idpa relations` prints — so
 * nothing in the block is the model's (ADR-0007, the relation addendum). The
 * owner's three questions, driven through `main` on a scripted client.
 */

const OWNER = path.resolve(import.meta.dirname, '../golden/relations-owner')

const load = async (root: string = OWNER): Promise<EntityGraph> => {
  const loaded = await new FixtureProvider(root).load()
  return EntityGraph.from(loaded.entities)
}

const PAYMENTS = 'component:default/payments-api'
const BILLING = 'component:default/billing-api'
const RIGHT = 'resource:default/billing-api-billing-db-dev'
const DB = 'resource:default/billing-db-dev'
const HOST = 'resource:default/mysql-disi6-dev'

const database = (name: string, dependsOn: string[] = []): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name, annotations: {} },
  spec: { type: 'database', owner: 'group:default/tiger', ...(dependsOn.length > 0 ? { dependsOn } : {}) },
})

const calling = (name: string, args: unknown, id = `c-${name}`): GenerateResult => ({
  text: '',
  toolCalls: [{ id, name, args }],
  finishReason: 'tool-calls',
})
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request) => {
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? saying('')
    },
  }
}

const run = async (question: string, analyst: GenerateResult[]) => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const client = scripted({ supervisor: [saying('QUESTION')], analyst })
  const code = await main([question, '--repo', OWNER], {
    client,
    env: {},
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
  })
  return { code, out: out.join(''), err: err.join(''), events, client }
}

describe('the answer union', () => {
  it('carries a relation: a reference, a relation, and the other end for between', () => {
    expect(answerSchema.parse({ outcome: 'relation', ref: PAYMENTS, relation: 'consumes' })).toEqual({
      outcome: 'relation',
      ref: PAYMENTS,
      relation: 'consumes',
    })
    expect(
      answerSchema.parse({ outcome: 'relation', ref: PAYMENTS, relation: 'between', to: DB }),
    ).toMatchObject({ to: DB })
  })

  it('refuses between with no other end, and a relation it does not name', () => {
    const between = answerSchema.safeParse({ outcome: 'relation', ref: PAYMENTS, relation: 'between' })
    expect(between.success).toBe(false)
    expect(between.error?.issues[0]?.path).toEqual(['to'])
    expect(answerSchema.safeParse({ outcome: 'relation', ref: PAYMENTS, relation: 'related' }).success).toBe(false)
    expect(answerSchema.safeParse({ outcome: 'relation', ref: 'payments-api', relation: 'consumes' }).success).toBe(false)
  })

  it('discards an other end on any relation but between, blank, null or malformed alike', () => {
    for (const to of ['', null, 'payments-api', 42, 'component:default/invented']) {
      const parsed = answerSchema.safeParse({ outcome: 'relation', ref: PAYMENTS, relation: 'consumes', to })
      expect(parsed.success, JSON.stringify(to)).toBe(true)
      expect(parsed.data, JSON.stringify(to)).toMatchObject({ outcome: 'relation', ref: PAYMENTS, relation: 'consumes' })
    }
  })

  it('still refuses between with an other end that is not a reference', () => {
    for (const to of ['', null, 'billing-db-dev']) {
      const parsed = answerSchema.safeParse({ outcome: 'relation', ref: PAYMENTS, relation: 'between', to })
      expect(parsed.success, JSON.stringify(to)).toBe(false)
      expect(parsed.error?.issues[0]?.path).toEqual(['to'])
    }
  })

  it('discards what rides along, and keeps the commentary', () => {
    expect(
      answerSchema.parse({
        outcome: 'relation',
        ref: PAYMENTS,
        relation: 'consumes',
        refs: ['component:default/invented'],
        reason: ' ',
        intro: 'Here is what it consumes.',
      }),
    ).toEqual({ outcome: 'relation', ref: PAYMENTS, relation: 'consumes', intro: 'Here is what it consumes.' })
  })
})

describe('get_relations, on the Analyst’s registry only', () => {
  it('is not offered to the Architect', async () => {
    const graph = await load()
    expect(buildTools(graph).specs.map((spec) => spec.name)).not.toContain('get_relations')
    expect(buildTools(graph).run(calling('get_relations', { ref: PAYMENTS, relation: 'consumes' }).toolCalls[0]!).error).toBe(
      'unknown tool "get_relations"',
    )
  })

  it('returns each row with its path, the rights and levels on it, and every step’s environment', async () => {
    const tools = buildTools(await load(), { apis: true })
    expect(tools.specs.map((spec) => spec.name)).toContain('get_relations')
    const outcome = tools.run(calling('get_relations', { ref: PAYMENTS, relation: 'consumes' }).toolCalls[0]!)
    expect(outcome.rows).toBe(1)
    expect(outcome.result).toEqual({
      relation: 'consumes',
      subject: { ref: PAYMENTS, kind: 'Component', type: 'service', env: '(undeclared)' },
      rows: [
        {
          ref: DB,
          kind: 'Resource',
          type: 'database',
          env: 'dev',
          depth: 2,
          path: [
            { ref: PAYMENTS, kind: 'Component', type: 'service', env: '(undeclared)' },
            { ref: RIGHT, kind: 'Resource', type: 'database-access', env: 'dev', right: true, access: 'readwrite' },
            { ref: DB, kind: 'Resource', type: 'database', env: 'dev' },
          ],
        },
      ],
      stoppedAtDepth: '2: hops further than this were not followed',
    })
    // Every entity on the path is witnessed: an answer may name it.
    for (const ref of [PAYMENTS, RIGHT, DB]) expect(tools.witnessed.has(ref)).toBe(true)
    expect(tools.witnessed.has(HOST)).toBe(false)
  })

  it('puts a step declared nowhere beside the rows, never among them', async () => {
    const tools = buildTools(await load(), { apis: true })
    const outcome = tools.run(calling('get_relations', { ref: BILLING, relation: 'consumes' }).toolCalls[0]!)
    const result = outcome.result as { rows: Array<{ ref: string }>; danglingReferences: unknown[] }
    expect(result.rows.map((row) => row.ref)).toEqual([DB])
    expect(result.danglingReferences).toEqual([
      {
        ref: 'resource:default/payments-api',
        declared: false,
        field: 'dependsOn',
        declaredBy: 'resource:default/billing-api-to-payments',
        sameName: [PAYMENTS],
        path: [
          { ref: BILLING, kind: 'Component', type: 'service', env: '(undeclared)' },
          { ref: 'resource:default/billing-api-to-payments', kind: 'Resource', type: 'network-access', env: 'prod', right: true },
        ],
      },
    ])
    expect(outcome.dangling).toBe(1)
    expect(tools.declaredNowhere.has('resource:default/payments-api')).toBe(true)
    expect(tools.witnessed.has('resource:default/payments-api')).toBe(false)
    expect(tools.witnessed.has('resource:default/billing-api-to-payments')).toBe(true)
  })

  it('reads between as paths, each marked with its direction', async () => {
    const tools = buildTools(await load(), { apis: true })
    const outcome = tools.run(
      calling('get_relations', { ref: DB, relation: 'between', to: PAYMENTS }).toolCalls[0]!,
    )
    expect(outcome.result).toMatchObject({
      relation: 'between',
      to: { ref: PAYMENTS },
      rows: [{ ref: PAYMENTS, depth: 2, direction: 'the last entity depends on the first', path: [{ ref: DB }, { ref: RIGHT }, { ref: PAYMENTS }] }],
    })
  })

  it('reads a blank or malformed other end on another relation as absent', async () => {
    const tools = buildTools(await load(), { apis: true })
    for (const to of ['', null, 'billing-db-dev']) {
      const outcome = tools.run(calling('get_relations', { ref: PAYMENTS, relation: 'consumes', to }).toolCalls[0]!)
      expect(outcome.error, JSON.stringify(to)).toBeUndefined()
      expect(outcome.rows).toBe(1)
    }
  })

  it('refuses an entity that is not declared, naming which, and between with no other end', async () => {
    const tools = buildTools(await load(), { apis: true })
    expect(tools.run(calling('get_relations', { ref: 'component:default/absent', relation: 'consumes' }).toolCalls[0]!).error).toBe(
      'no such entity: "ref" component:default/absent',
    )
    expect(
      tools.run(calling('get_relations', { ref: PAYMENTS, relation: 'between', to: 'resource:default/absent' }).toolCalls[0]!).error,
    ).toBe('no such entity: "to" resource:default/absent')
    expect(tools.run(calling('get_relations', { ref: PAYMENTS, relation: 'between' }).toolCalls[0]!).error).toBe(
      'get_relations: "between" needs "to", the other entity',
    )
  })

  it('bounds its rows as every tool does, and says so', () => {
    const leaves = Array.from({ length: QUERY_LIMITS.maxRows + 5 }, (_, index) => `leaf${String(index).padStart(3, '0')}`)
    const graph = EntityGraph.from([
      database('hub', leaves.map((name) => `resource:default/${name}`)),
      ...leaves.map((name) => database(name)),
    ])
    const tools = buildTools(graph, { apis: true })
    const outcome = tools.run(calling('get_relations', { ref: 'resource:default/hub', relation: 'depends-on' }).toolCalls[0]!)
    expect(outcome.rows).toBe(QUERY_LIMITS.maxRows)
    expect(outcome.truncated).toBe(5)
    expect(outcome.result).toMatchObject({ truncated: '5 more not shown' })
    // Only what the model was shown is witnessed.
    expect(tools.witnessed.has(`resource:default/${leaves[QUERY_LIMITS.maxRows - 1] as string}`)).toBe(true)
    expect(tools.witnessed.has(`resource:default/${leaves[QUERY_LIMITS.maxRows] as string}`)).toBe(false)
  })

  it('bounds the cycles it returns, and counts the rest', () => {
    const spokes = Array.from({ length: RELATION_LIMITS.cycles + 3 }, (_, index) => `spoke${String(index)}`)
    const graph = EntityGraph.from([
      database('hub', spokes.map((name) => `resource:default/${name}`)),
      ...spokes.map((name) => database(name, ['resource:default/hub'])),
    ])
    const tools = buildTools(graph, { apis: true })
    const outcome = tools.run(calling('get_relations', { ref: 'resource:default/hub', relation: 'depends-on' }).toolCalls[0]!)
    const result = outcome.result as { cycles: string[][]; moreCycles: string }
    expect(result.cycles).toHaveLength(RELATION_LIMITS.cycles)
    expect(result.moreCycles).toBe('3 more cycles not shown')
  })

  it('where neither depends on the other, returns what both reach, witnessed, and a near miss beside it', async () => {
    const tools = buildTools(await load(), { apis: true })
    const outcome = tools.run(calling('get_relations', { ref: PAYMENTS, relation: 'between', to: BILLING }).toolCalls[0]!)
    const result = outcome.result as Record<string, unknown>
    expect(result['rows']).toEqual([])
    expect(result['shared']).toEqual([
      {
        both: 'both depend on it',
        ref: RIGHT,
        kind: 'Resource',
        type: 'database-access',
        env: 'dev',
        access: 'readwrite',
        paths: [
          [
            { ref: PAYMENTS, kind: 'Component', type: 'service', env: '(undeclared)' },
            { ref: RIGHT, kind: 'Resource', type: 'database-access', env: 'dev', right: true, access: 'readwrite' },
          ],
          [
            { ref: BILLING, kind: 'Component', type: 'service', env: '(undeclared)' },
            { ref: RIGHT, kind: 'Resource', type: 'database-access', env: 'dev', right: true, access: 'readwrite' },
          ],
        ],
      },
    ])
    expect(result['danglingReferences']).toMatchObject([
      { ref: 'resource:default/payments-api', declaredBy: 'resource:default/billing-api-to-payments', sameName: [PAYMENTS] },
    ])
    expect(outcome.rows).toBe(0)
    expect(tools.witnessed.has(RIGHT)).toBe(true)
    expect(tools.witnessed.has('resource:default/payments-api')).toBe(false)
  })
})

describe('the witness check on a relation answer', () => {
  const answering = async (answer: Record<string, unknown>, read: GenerateResult[] = []) => {
    const graph = await load()
    const tools = buildTools(graph, { apis: true })
    const events: AgentEvent[] = []
    const client = scripted({ analyst: [...read, calling('answer', answer)] })
    const outcome = await answerQuestion(
      client,
      tools,
      { intent: 'what does payments-api consume?', summary: '', vocabulary: '' },
      (event) => void events.push(event),
    )
    return { outcome, events }
  }
  const SEARCH = calling('search_entities', { nameContains: 'payments-api' })

  it('refuses a reference no tool returned, and names it', async () => {
    const { outcome } = await answering({ outcome: 'relation', ref: PAYMENTS, relation: 'consumes' })
    expect(outcome.answer).toEqual({
      outcome: 'unanswerable',
      reason: `the answer named ${PAYMENTS}, which no tool returned`,
    })
  })

  it('refuses an other end no tool returned', async () => {
    const { outcome } = await answering(
      { outcome: 'relation', ref: PAYMENTS, relation: 'between', to: DB },
      [SEARCH],
    )
    expect(outcome.answer).toEqual({
      outcome: 'unanswerable',
      reason: `the answer named ${DB}, which no tool returned`,
    })
  })

  it('signs a witnessed one, drops an other end that is not between’s, and says so on the stream', async () => {
    const { outcome, events } = await answering(
      { outcome: 'relation', ref: PAYMENTS, relation: 'consumes', to: 'component:default/invented' },
      [SEARCH],
    )
    expect(outcome.answer).toEqual({ outcome: 'relation', ref: PAYMENTS, relation: 'consumes' })
    expect(events).toContainEqual({ type: 'answer:ready', outcome: 'relation', refs: [PAYMENTS] })
  })
})

describe("the owner's questions, through idpa, on a scripted model", () => {
  const block = async (options: Parameters<typeof runRelations>[1]): Promise<string> =>
    runRelations(await load(), options).text

  it('"Que consomme payments-api ?" prints what idpa relations prints', async () => {
    const { code, out, events } = await run('Que consomme payments-api ?', [
      calling('get_relations', { ref: PAYMENTS, relation: 'consumes' }),
      calling('answer', {
        outcome: 'relation',
        ref: PAYMENTS,
        relation: 'consumes',
        intro: 'payments-api consomme une base, par un droit.',
        conclusion: 'Elle passe par billing-api-billing-db-dev, en lecture-écriture.',
      }),
    ])
    expect(code).toBe(0)
    const engine = await block({ query: PAYMENTS, relation: 'consumes', asked: true })
    expect(out).toBe(
      `› payments-api consomme une base, par un droit.\n\n${engine}\n\n› Elle passe par billing-api-billing-db-dev, en lecture-écriture.\n`,
    )
    expect(engine).toContain(
      'resource:default/billing-db-dev  database  dev  readwrite  resource:default/billing-api-billing-db-dev (dev)',
    )
    // Under an answer, the way further is the command, not a flag ask refuses.
    expect(engine).toContain('idpa relations component:default/payments-api --consumes --depth 3 follows it')
    expect(events).toContainEqual({ type: 'answer:ready', outcome: 'relation', refs: [PAYMENTS] })
  })

  it('"which services use billing-db-dev ?" names both, each through the readwrite dev right', async () => {
    const { code, out } = await run('which services use billing-db-dev ?', [
      calling('search_entities', { nameContains: 'billing-db-dev' }),
      calling('answer', { outcome: 'relation', ref: DB, relation: 'consumed-by' }),
    ])
    expect(code).toBe(0)
    expect(out).toBe(`${await block({ query: DB, relation: 'consumed-by', asked: true })}\n`)
    expect(out).toContain('component:default/billing-api   service  -    readwrite  resource:default/billing-api-billing-db-dev (dev)')
    expect(out).toContain('component:default/payments-api  service  -    readwrite  resource:default/billing-api-billing-db-dev (dev)')
  })

  it('"Quelle est la dépendance entre payments-api et billing-db-dev ?" prints the path', async () => {
    const { code, out } = await run('Quelle est la dépendance entre payments-api et billing-db-dev ?', [
      calling('get_relations', { ref: PAYMENTS, relation: 'between', to: DB }),
      calling('answer', { outcome: 'relation', ref: PAYMENTS, relation: 'between', to: DB }),
    ])
    expect(code).toBe(0)
    expect(out).toBe(`${await block({ query: PAYMENTS, to: DB, asked: true })}\n`)
    expect(out).toContain('payments-api → billing-api-billing-db-dev (readwrite) → billing-db-dev')
  })

  it('a relation that holds nothing is a negative answer, exit 1', async () => {
    const { code, out } = await run('what does billing-db-dev consume?', [
      calling('search_entities', { nameContains: 'billing-db-dev' }),
      calling('answer', { outcome: 'relation', ref: DB, relation: 'consumes' }),
    ])
    expect(code).toBe(1)
    expect(out).toBe(`${await block({ query: DB, relation: 'consumes', asked: true })}\n`)
  })

  it('--quiet prints the block alone', async () => {
    const out: string[] = []
    const code = await main(['ask', 'Que consomme payments-api ?', '--quiet', '--repo', OWNER], {
      client: scripted({
        supervisor: [saying('QUESTION')],
        analyst: [
          calling('get_relations', { ref: PAYMENTS, relation: 'consumes' }),
          calling('answer', { outcome: 'relation', ref: PAYMENTS, relation: 'consumes', intro: 'Voici.' }),
        ],
      }),
      env: {},
      out: (chunk) => void out.push(chunk),
      err: () => {},
      events: () => {},
    })
    expect(code).toBe(0)
    expect(out.join('')).toBe(`${await block({ query: PAYMENTS, relation: 'consumes', asked: true })}\n`)
  })

  it('tells the model that relation questions are answered with a relation', async () => {
    const { client } = await run('Que consomme payments-api ?', [
      calling('answer', { outcome: 'unanswerable', reason: 'no' }),
    ])
    const analyst = client.seen.find((request) => request.agent === 'analyst')
    expect(analyst?.system).toMatch(/relation\s+with "ref" and "relation"/)
    expect(analyst?.system).toContain('consumes')
    // One entry, one sentence closed before the next outcome's.
    expect(analyst?.system).toMatch(/before you conclude on them\.\n {2}nothing/)
    const answer = analyst?.tools.find((spec) => spec.name === 'answer')
    expect(answer?.description).toContain('"relation"')
  })
})
