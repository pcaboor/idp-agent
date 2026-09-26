import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTools, type ToolOutcome } from '../../src/agents/tools/graph-tools.js'
import { runAsk } from '../../src/cli/commands/ask.js'
import { main } from '../../src/cli/index.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { ENV_ANNOTATION, EntityGraph } from '../../src/context/graph/entity-graph.js'
import { renderEntityDetail } from '../../src/cli/render/entity.js'
import type { CatalogueEntity, Entity } from '../../src/core/schemas/entity.js'
import { QUERY_LIMITS } from '../../src/core/schemas/query.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'

/**
 * The owner's case. A right over billing-db-dev, in dev, readwrite, whose
 * `dependencyOf` was edited to name `component:default/payments-api` — and no
 * Component of that name exists: the catalogue's payments-api is a Resource,
 * an external API. `validate` warned; `show` and the Analyst said nothing, and
 * "what is the dependency between payments-api and billing-db-dev?" was
 * answered "none is declared" off the Resource. A declared reference is shown
 * where its entity's relations are shown, broken or not, marked as declared
 * nowhere, with the entity of the same name when there is one. The engine
 * never decides that `component:` meant `resource:` (declare, never infer).
 *
 * `tests/golden/dangling-shown/` is that repository, cut down, plus a dangling
 * `dependsOn` and a dangling `providesApis` that no entity shares a name with.
 */

const REPO = path.resolve(import.meta.dirname, '../golden/dangling-shown')

const RIGHT = 'resource:default/billing-api-billing-db-dev'
const DB = 'resource:default/billing-db-dev'
const SERVICE = 'component:default/billing-api'
const PAYMENTS = 'resource:default/payments-api'
const MISSING = 'component:default/payments-api'

const load = async (): Promise<EntityGraph> => {
  const loaded = await new FixtureProvider(REPO).load()
  return EntityGraph.from(
    loaded.entities,
    loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
  )
}

const run = async (argv: string[], client?: LlmClient) => {
  const io = { out: [] as string[], err: [] as string[] }
  const code = await main(argv, {
    ...(client === undefined ? {} : { client }),
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
    events: () => {},
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

describe('the graph keeps what an entity declares and nothing answers to', () => {
  it('per entity, with the field, the reference as read, and the entities of its name', async () => {
    const graph = await load()
    expect(graph.unresolvedOf(RIGHT)).toEqual([
      { from: RIGHT, field: 'dependencyOf', to: MISSING, sameName: [PAYMENTS] },
    ])
    expect(graph.unresolvedOf(SERVICE)).toEqual([
      {
        from: SERVICE,
        field: 'dependsOn',
        to: 'resource:default/billing-queue-dev',
        sameName: [],
      },
      // Read in Backstage's short form, `billing-events`, and kept as the
      // reader normalised it.
      { from: SERVICE, field: 'providesApis', to: 'api:default/billing-events', sameName: [] },
    ])
    expect(graph.unresolvedOf(DB)).toEqual([])
    expect(graph.unresolvedOf('component:default/absent')).toEqual([])
  })

  it('by field', async () => {
    const graph = await load()
    expect(graph.unresolvedOf(SERVICE, 'dependsOn').map(({ to }) => to)).toEqual([
      'resource:default/billing-queue-dev',
    ])
    expect(graph.unresolvedOf(SERVICE, 'providesApis').map(({ to }) => to)).toEqual([
      'api:default/billing-events',
    ])
    expect(graph.unresolvedOf(SERVICE, 'dependencyOf')).toEqual([])
    expect(graph.unresolvedOf(RIGHT, 'dependencyOf').map(({ to }) => to)).toEqual([MISSING])
  })

  it('for a target, what the rights reaching it name and nothing declares', async () => {
    const graph = await load()
    const reached = [{ from: RIGHT, field: 'dependencyOf', to: MISSING, sameName: [PAYMENTS] }]
    expect(graph.unresolvedConsumersOf(DB)).toEqual(reached)
    // The right itself: its own dependencyOf is one hop from it.
    expect(graph.unresolvedConsumersOf(RIGHT)).toEqual(reached)
    // Through the object the database runs on, as `consumersOf` walks.
    expect(graph.unresolvedConsumersOf('resource:default/mysql-disi6-dev')).toEqual(reached)
    expect(graph.unresolvedConsumersOf(PAYMENTS)).toEqual([])
    expect(graph.unresolvedConsumersOf(SERVICE)).toEqual([])
  })

  it('is the one definition of dangling: the summary and graph list the same pairs', async () => {
    const graph = await load()
    expect(graph.danglingReferences()).toEqual([
      { from: SERVICE, to: 'resource:default/billing-queue-dev' },
      { from: SERVICE, to: 'api:default/billing-events' },
      { from: RIGHT, to: MISSING },
    ])
  })

  it('resolves nothing by it: every query answers what it answered', async () => {
    const graph = await load()
    const refs = (entities: Entity[] | ReturnType<EntityGraph['all']>): string[] =>
      entities.map((entity) => `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`)
    expect(refs(graph.dependantsOf(RIGHT))).toEqual([SERVICE])
    expect(refs(graph.consumersOf(DB))).toEqual([SERVICE])
    expect(refs(graph.dependantsOf(PAYMENTS))).toEqual(['resource:default/billing-api-to-payments'])
    expect(refs(graph.dependenciesOf(MISSING))).toEqual([])
    expect(graph.get(MISSING)).toBeUndefined()
  })

  it('names every entity of the name, under another kind or namespace, and none by guess', () => {
    const entity = (kind: 'Component' | 'Resource', name: string, spec: object = {}): Entity =>
      ({
        apiVersion: 'backstage.io/v1alpha1',
        kind,
        metadata: { name, annotations: {} },
        spec: {
          type: kind === 'Component' ? 'service' : 'api',
          ...(kind === 'Component' ? { lifecycle: 'production' } : {}),
          owner: 'group:default/tiger',
          ...spec,
        },
      }) as Entity
    const graph = EntityGraph.from(
      [
        entity('Component', 'ledger'),
        entity('Resource', 'ledger'),
        entity('Resource', 'ledger-db'),
        entity('Component', 'caller', {
          dependsOn: ['api:default/ledger', 'component:finance/ledger', 'resource:default/ledg'],
        }),
        entity('Component', 'grouped', { dependsOn: ['group:default/tiger'] }),
      ],
      ['group:default/tiger'],
    )
    expect(graph.unresolvedOf('component:default/caller')).toEqual([
      {
        from: 'component:default/caller',
        field: 'dependsOn',
        to: 'api:default/ledger',
        sameName: ['component:default/ledger', 'resource:default/ledger'],
      },
      {
        from: 'component:default/caller',
        field: 'dependsOn',
        to: 'component:finance/ledger',
        sameName: ['component:default/ledger', 'resource:default/ledger'],
      },
      // A near name is not the name: `ledg` is neither `ledger` nor `ledger-db`.
      {
        from: 'component:default/caller',
        field: 'dependsOn',
        to: 'resource:default/ledg',
        sameName: [],
      },
    ])
    // A document set aside is declared: a reference to it is not dangling.
    expect(graph.unresolvedOf('component:default/grouped')).toEqual([])
  })
})

describe("show's card", () => {
  it('lists the consumer a right names and nothing declares among the services reached', async () => {
    const { code, out } = await run(['show', 'billing-db-dev', '--repo', REPO])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'resource:default/billing-db-dev',
        '',
        '  kind         Resource',
        '  type         database',
        '  owner        group:default/tiger',
        '  environment  dev',
        '',
        'depends on',
        '  resource:default/mysql-disi6-dev  dev',
        '',
        'used by',
        '  resource:default/billing-api-billing-db-dev  dev',
        '',
        'reached by services',
        '  component:default/billing-api',
        '  component:default/payments-api  declared nowhere; resource:default/payments-api has this name',
        '',
      ].join('\n'),
    )
  })

  it("marks it on the right's own card, after what resolves", async () => {
    const { code, out } = await run(['show', 'billing-api-billing-db-dev', '--repo', REPO])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'resource:default/billing-api-billing-db-dev',
        '',
        '  kind         Resource',
        '  type         database-access',
        '  access       readwrite',
        '  owner        group:default/tiger',
        '  environment  dev',
        '',
        'depends on',
        '  resource:default/billing-db-dev  dev',
        '',
        'used by',
        '  component:default/billing-api',
        '  component:default/payments-api  declared nowhere; resource:default/payments-api has this name',
        '',
        'reached by services',
        '  component:default/billing-api',
        '  component:default/payments-api  declared nowhere; resource:default/payments-api has this name',
        '',
      ].join('\n'),
    )
  })

  it('shows a dangling dependsOn and a dangling providesApis in their sections', async () => {
    const { code, out } = await run(['show', 'billing-api', '--repo', REPO])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'component:default/billing-api',
        '',
        '  kind         Component',
        '  type         service',
        '  owner        group:default/tiger',
        '  environment  (undeclared)',
        '',
        'provides',
        '  api:default/billing-events  declared nowhere',
        '',
        'depends on',
        '  resource:default/billing-api-billing-db-dev  dev',
        '  resource:default/billing-api-to-payments     prod',
        '  resource:default/billing-queue-dev           declared nowhere',
        '',
        'used by',
        '  none',
        '',
      ].join('\n'),
    )
  })

  it('prints the Resource payments-api as itself: a homonym is not the reference', async () => {
    const { code, out } = await run(['show', 'payments-api', '--repo', REPO])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'resource:default/payments-api',
        '',
        '  kind         Resource',
        '  type         api',
        '  owner        group:default/tiger',
        '  environment  prod',
        '',
        'depends on',
        '  none',
        '',
        'used by',
        '  resource:default/billing-api-to-payments  prod',
        '',
        'reached by services',
        '  component:default/billing-api',
        '',
      ].join('\n'),
    )
  })

  it('does not resolve the undeclared reference: show on it is not found', async () => {
    // The reference in full names nothing, and is not answered with the
    // Resource that shares its name.
    const { code, out } = await run(['show', MISSING, '--repo', REPO])
    expect(code).toBe(1)
    expect(out).toBe(`No entity named "${MISSING}".\n`)
  })

  it("leaves validate's output as it was", async () => {
    const { code, out } = await run(['validate', REPO])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'warning components/billing-api.yml: component:default/billing-api names resource:default/billing-queue-dev, which nothing declares',
        'warning components/billing-api.yml: component:default/billing-api names api:default/billing-events, which nothing declares',
        'warning dependencies/access/billing-api-billing-db-dev.yml: resource:default/billing-api-billing-db-dev names component:default/payments-api, which nothing declares',
        '',
        '6 entities in 6 files, 0 violations',
        '',
      ].join('\n'),
    )
  })
})

const call = (name: string, args: unknown) => ({ id: 'c1', name, args })
const result = (outcome: ToolOutcome): Record<string, unknown> =>
  outcome.result as Record<string, unknown>

const FLAGGED = {
  ref: MISSING,
  declared: false,
  field: 'dependencyOf',
  declaredBy: RIGHT,
  sameName: [PAYMENTS],
}

describe("the Analyst's rows", () => {
  it('carry what a right names and nothing declares, flagged and apart from the rows', async () => {
    const built = buildTools(await load(), { apis: true })
    const outcome = built.run(call('get_entity', { ref: RIGHT }))
    expect(outcome.rows).toBe(1)
    expect(result(outcome)).toEqual({
      rows: [
        {
          ref: RIGHT,
          name: 'billing-api-billing-db-dev',
          kind: 'Resource',
          type: 'database-access',
          access: 'readwrite',
          env: 'dev',
          owner: 'group:default/tiger',
          danglingReferences: [FLAGGED],
        },
      ],
    })
  })

  it('list the undeclared consumer among the consumers of billing-db-dev', async () => {
    const built = buildTools(await load(), { apis: true })
    const outcome = built.run(call('get_dependencies', { ref: DB, direction: 'consumers' }))
    expect(outcome.rows).toBe(1)
    expect(result(outcome)).toEqual({
      rows: [
        {
          ref: SERVICE,
          name: 'billing-api',
          kind: 'Component',
          type: 'service',
          env: '(undeclared)',
          owner: 'group:default/tiger',
          danglingReferences: [
            {
              ref: 'resource:default/billing-queue-dev',
              declared: false,
              field: 'dependsOn',
              declaredBy: SERVICE,
              sameName: [],
            },
            {
              ref: 'api:default/billing-events',
              declared: false,
              field: 'providesApis',
              declaredBy: SERVICE,
              sameName: [],
            },
          ],
        },
      ],
      danglingReferences: [FLAGGED],
    })
  })

  it('list it among the dependants of the right, and a dangling dependsOn among dependencies', async () => {
    const built = buildTools(await load(), { apis: true })
    const dependants = built.run(call('get_dependencies', { ref: RIGHT, direction: 'dependants' }))
    expect(result(dependants).danglingReferences).toEqual([FLAGGED])
    const dependencies = built.run(
      call('get_dependencies', { ref: SERVICE, direction: 'dependencies' }),
    )
    expect(result(dependencies).danglingReferences).toEqual([
      expect.objectContaining({ ref: 'resource:default/billing-queue-dev', field: 'dependsOn' }),
    ])
    // Nothing unresolved on that side: the key is absent, as before.
    const none = built.run(call('get_dependencies', { ref: DB, direction: 'dependencies' }))
    expect(result(none)).not.toHaveProperty('danglingReferences')
  })

  it('list a dangling providesApis in what get_apis says a component provides', async () => {
    const built = buildTools(await load(), { apis: true })
    const provides = built.run(call('get_apis', { ref: SERVICE, direction: 'provides' }))
    expect(provides.rows).toBe(0)
    expect(result(provides)).toEqual({
      rows: [],
      danglingReferences: [
        {
          ref: 'api:default/billing-events',
          declared: false,
          field: 'providesApis',
          declaredBy: SERVICE,
          sameName: [],
        },
      ],
    })
  })

  it('witness the entities they name, never the reference that names nothing', async () => {
    const built = buildTools(await load(), { apis: true })
    built.run(call('get_dependencies', { ref: DB, direction: 'consumers' }))
    expect(built.witnessed.has(SERVICE)).toBe(true)
    // The Resource of the same name, and the right that declares the
    // reference: entities the engine returned, by reference, on this row.
    expect(built.witnessed.has(PAYMENTS)).toBe(true)
    expect(built.witnessed.has(RIGHT)).toBe(true)
    expect(built.witnessed.has(MISSING)).toBe(false)
    expect(built.witnessed.has('api:default/billing-events')).toBe(false)
  })

  it("leave the Architect's rows as they were", async () => {
    const graph = await load()
    const architect = buildTools(graph, { refuseUnusedValues: false })
    expect(JSON.stringify(architect.run(call('get_entity', { ref: RIGHT })).result)).not.toContain(
      'danglingReferences',
    )
    const consumers = architect.run(call('get_dependencies', { ref: DB, direction: 'consumers' }))
    expect(consumers.result).toEqual({
      rows: [
        {
          ref: SERVICE,
          name: 'billing-api',
          kind: 'Component',
          type: 'service',
          env: '(undeclared)',
          owner: 'group:default/tiger',
        },
      ],
    })
    expect(architect.witnessed.has(PAYMENTS)).toBe(false)
  })
})

const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `c-${name}`, name, args }],
  finishReason: 'tool-calls',
})
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

const byAgent = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
  seen: GenerateRequest[] = [],
): LlmClient => {
  const spent = new Map<AgentName, number>()
  return {
    generate: async (request) => {
      seen.push(request)
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? saying('')
    },
  }
}

const QUESTION = 'Quelle est la dependance entre payments-api et billing-db-dev ?'
const CONSUMERS = calling('get_dependencies', { ref: DB, direction: 'consumers' })
const NAMES_IT = `The right names ${MISSING}, which is declared nowhere.`

const ask = async (analyst: GenerateResult[], intent: string = QUESTION) => {
  const errors: string[] = []
  const answered = await runAsk({
    graph: await load(),
    client: byAgent({ supervisor: [saying('QUESTION')], analyst }),
    intent,
    source: { ignored: [], rejected: 0 },
    emit: () => {},
    err: (chunk) => void errors.push(chunk),
  })
  return { answered, errors: errors.join('') }
}

describe('an answer about the reference that names nothing', () => {
  it('is refused when it names the reference as an entity', async () => {
    const { answered, errors } = await ask([
      CONSUMERS,
      calling('answer', { outcome: 'entities', refs: [MISSING] }),
    ])
    expect(answered.found).toBe(false)
    expect(errors).toContain(`${MISSING}, which no tool returned`)
  })

  it('may name the entity of the same name, which the engine returned', async () => {
    const { answered } = await ask([
      CONSUMERS,
      calling('answer', { outcome: 'entities', refs: [PAYMENTS] }),
    ])
    expect(answered.found).toBe(true)
    expect(answered.text.startsWith(`${PAYMENTS}\n`)).toBe(true)
  })

  it('keeps a conclusion that names it as declared nowhere', async () => {
    const { answered, errors } = await ask([
      CONSUMERS,
      calling('answer', { outcome: 'entities', refs: [SERVICE], conclusion: NAMES_IT }),
    ])
    expect(answered.text).toContain(`› ${NAMES_IT}`)
    expect(errors).toBe('')
  })

  it('drops that sentence when no tool returned what declares it', async () => {
    const { answered, errors } = await ask(
      [
        calling('get_entity', { ref: PAYMENTS }),
        calling('answer', { outcome: 'entities', refs: [PAYMENTS], conclusion: NAMES_IT }),
      ],
      'what is payments-api?',
    )
    expect(answered.text).not.toContain('›')
    expect(errors).toContain('which no tool returned')
  })

  it('tells the Analyst what a reference marked declared: false is', async () => {
    const seen: GenerateRequest[] = []
    await runAsk({
      graph: await load(),
      client: byAgent(
        { supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] },
        seen,
      ),
      intent: QUESTION,
      source: { ignored: [], rejected: 0 },
      emit: () => {},
      err: () => {},
    })
    const system = seen.find((request) => request.agent === 'analyst')?.system ?? ''
    expect(system).toContain(
      'A reference marked "declared": false is written in the catalogue and names no entity',
    )
  })
})

describe("the owner's question, through main", () => {
  it('prints the verified block and a commentary that names the undeclared consumer', async () => {
    const client = byAgent({
      supervisor: [saying('QUESTION')],
      analyst: [
        CONSUMERS,
        calling('answer', {
          outcome: 'entities',
          refs: [RIGHT, PAYMENTS],
          intro: 'Two entities answer this.',
          conclusion: `${NAMES_IT} ${PAYMENTS} is a Resource, not that consumer.`,
        }),
      ],
    })
    const { code, out, err } = await run(['ask', '--repo', REPO, QUESTION], client)
    expect(code).toBe(0)
    expect(err).not.toContain("the model's commentary named")
    expect(out).toBe(
      [
        '› Two entities answer this.',
        '',
        'NAME                        KIND      TYPE             ENV   OWNER',
        'billing-api-billing-db-dev  Resource  database-access  dev   group:default/tiger',
        'payments-api                Resource  api              prod  group:default/tiger',
        '',
        `› ${NAMES_IT}`,
        `› ${PAYMENTS} is a Resource, not that consumer.`,
        '',
      ].join('\n'),
    )
  })
})

/**
 * Graphs of a few entities, for what the owner's repository does not hold: a
 * missing consumer named by two rights, a missing reference of two names'
 * worth of homonyms, a reference too long to align, more of them than a
 * result shows, and an entity witnessed without its row being read.
 */
const entityOf = (
  kind: 'API' | 'Component' | 'Resource',
  name: string,
  spec: Record<string, unknown> = {},
  env?: string,
): CatalogueEntity =>
  ({
    apiVersion: 'backstage.io/v1alpha1',
    kind,
    metadata: { name, annotations: env === undefined ? {} : { [ENV_ANNOTATION]: env } },
    spec: {
      owner: 'group:default/tiger',
      ...(kind === 'Component' ? { type: 'service', lifecycle: 'production' } : {}),
      ...(kind === 'Resource' ? { type: 'database' } : {}),
      ...(kind === 'API' ? { type: 'openapi', lifecycle: 'production', definition: 'x' } : {}),
      ...spec,
    },
  }) as CatalogueEntity

const right = (name: string, dependencyOf: string[], dependsOn: string[] = []): CatalogueEntity =>
  entityOf(
    'Resource',
    name,
    {
      type: 'database-access',
      access: 'readwrite',
      dependsOn: ['resource:default/db', ...dependsOn],
      dependencyOf,
    },
    'dev',
  )

const cardOf = (graph: EntityGraph, ref: string): string => {
  const entity = graph.get(ref)
  if (entity === undefined) throw new Error(`no ${ref}`)
  return renderEntityDetail(graph, entity)
}

/** One section of a card, its title line included: the card separates them by a blank line. */
const sectionOf = (card: string, title: string): string =>
  card.split('\n\n').find((part) => part.startsWith(`${title}\n`)) ?? ''

describe('what the rights reaching a target name as consumers', () => {
  const graph = EntityGraph.from([
    entityOf('Resource', 'db', {}, 'dev'),
    right('r1', ['component:default/ghost', 'resource:default/nope']),
    right('r2', ['component:default/ghost', 'component:default/twin']),
    entityOf('Resource', 'twin', { type: 'api' }, 'prod'),
    entityOf('API', 'twin'),
  ])

  it('are services only: a missing Resource would be walked through, never listed', () => {
    const reached = graph.unresolvedConsumersOf('resource:default/db')
    expect(reached.map(({ from, to }) => `${from} ${to}`).sort()).toEqual([
      'resource:default/r1 component:default/ghost',
      'resource:default/r2 component:default/ghost',
      'resource:default/r2 component:default/twin',
    ])
  })

  it('print once each under "reached by services", homonyms joined', () => {
    expect(sectionOf(cardOf(graph, 'resource:default/db'), 'reached by services')).toBe(
      [
        'reached by services',
        '  component:default/ghost  declared nowhere',
        '  component:default/twin   declared nowhere; api:default/twin and resource:default/twin have this name',
      ].join('\n'),
    )
  })

  it("leave a missing Resource on the right's own card, under used by", () => {
    const card = cardOf(graph, 'resource:default/r1')
    expect(sectionOf(card, 'used by')).toBe(
      [
        'used by',
        '  component:default/ghost  declared nowhere',
        '  resource:default/nope    declared nowhere',
      ].join('\n'),
    )
    expect(sectionOf(card, 'reached by services')).toBe(
      ['reached by services', '  component:default/ghost  declared nowhere'].join('\n'),
    )
  })
})

describe("the card's alignment", () => {
  it('is not widened by a reference longer than any entity\'s', () => {
    const long = `resource:default/${'a'.repeat(120)}`
    const graph = EntityGraph.from([
      entityOf('Resource', 'db', {}, 'dev'),
      entityOf('Component', 'caller', { dependsOn: ['resource:default/db', long] }),
    ])
    expect(sectionOf(cardOf(graph, 'component:default/caller'), 'depends on')).toBe(
      ['depends on', '  resource:default/db  dev', `  ${long}  declared nowhere`].join('\n'),
    )
  })
})

describe('the dangling references a result carries', () => {
  const beyond = QUERY_LIMITS.maxRows + 2
  const numbered = (at: number): string => String(at).padStart(2, '0')
  const graph = EntityGraph.from([
    entityOf('Resource', 'db', {}, 'dev'),
    ...Array.from({ length: beyond }, (_, at) =>
      right(`r${numbered(at)}`, [`component:default/gone-${numbered(at)}`]),
    ),
    entityOf('Component', 'wide', {
      dependsOn: Array.from({ length: beyond }, (_, at) => `resource:default/lost-${numbered(at)}`),
    }),
  ])

  it('are bounded beside the rows as the rows are, and the cut is stated', () => {
    const built = buildTools(graph, { apis: true })
    const outcome = built.run(
      call('get_dependencies', { ref: 'resource:default/db', direction: 'consumers' }),
    )
    const listed = result(outcome).danglingReferences as Array<{ declaredBy: string }>
    expect(listed).toHaveLength(QUERY_LIMITS.maxRows)
    expect(result(outcome).danglingTruncated).toBe('2 more not shown')
    expect(outcome.dangling).toBe(QUERY_LIMITS.maxRows)
    // What was cut was not shown, so what declares it was not returned.
    const declaredBy = new Set(listed.map(({ declaredBy }) => declaredBy))
    const cut = Array.from({ length: beyond }, (_, at) => `resource:default/r${numbered(at)}`)
      .filter((ref) => !declaredBy.has(ref))
    expect(cut).toHaveLength(2)
    for (const ref of cut) expect(built.witnessed.has(ref)).toBe(false)
  })

  it('are bounded on a row, and the cut is stated', () => {
    const outcome = buildTools(graph, { apis: true }).run(
      call('get_entity', { ref: 'component:default/wide' }),
    )
    const [row] = result(outcome).rows as Array<Record<string, unknown>>
    expect(row?.danglingReferences).toHaveLength(QUERY_LIMITS.maxRows)
    expect(row?.danglingTruncated).toBe('2 more not shown')
  })
})

describe('a turn that read only references naming nothing', () => {
  it('read something: it is not a barren turn', async () => {
    const provides = calling('get_apis', { ref: SERVICE, direction: 'provides' })
    const outcome = buildTools(await load(), { apis: true }).run(
      call('get_apis', { ref: SERVICE, direction: 'provides' }),
    )
    expect(outcome.rows).toBe(0)
    expect(outcome.dangling).toBe(1)
    // Two barren turns would force the third to be the last, and a model
    // that read on there would end with no answer.
    const { answered } = await ask([
      provides,
      provides,
      calling('get_entity', { ref: SERVICE }),
      calling('answer', { outcome: 'entities', refs: [SERVICE] }),
    ])
    expect(answered.found).toBe(true)
  })
})

describe('a sentence naming an entity no tool returned', () => {
  const askOver = async (graph: EntityGraph, analyst: GenerateResult[]) => {
    const errors: string[] = []
    const answered = await runAsk({
      graph,
      client: byAgent({ supervisor: [saying('QUESTION')], analyst }),
      intent: 'what is there?',
      source: { ignored: [], rejected: 0 },
      emit: () => {},
      err: (chunk) => void errors.push(chunk),
    })
    return { answered, errors: errors.join('') }
  }
  const SECRET = 'secret-thing is owned by tiger.'

  it('is dropped when its declarer was returned as a provider, its row unread', async () => {
    // svc is witnessed through the API's providedBy; its own dangling
    // dependsOn, whose name is secret-thing's, was never shown.
    const graph = EntityGraph.from([
      entityOf('API', 'orders'),
      entityOf('Component', 'svc', {
        providesApis: ['api:default/orders'],
        dependsOn: ['resource:default/secret-thing'],
      }),
      entityOf('Component', 'secret-thing'),
    ])
    const { answered, errors } = await askOver(graph, [
      calling('get_entity', { ref: 'api:default/orders' }),
      calling('answer', { outcome: 'entities', refs: ['api:default/orders'], conclusion: SECRET }),
    ])
    expect(answered.text).not.toContain('›')
    expect(errors).toContain('secret-thing, which no tool returned')
  })

  it('is dropped when its declarer was returned as declaring another reference', async () => {
    // r1 is witnessed as what declares the missing consumer ghost; its
    // dangling dependsOn was not on the consumers walk's side.
    const graph = EntityGraph.from([
      entityOf('Resource', 'db', {}, 'dev'),
      right('r1', ['component:default/ghost'], ['resource:default/secret-thing']),
      entityOf('Component', 'secret-thing'),
    ])
    const { answered, errors } = await askOver(graph, [
      calling('get_dependencies', { ref: 'resource:default/db', direction: 'consumers' }),
      calling('answer', { outcome: 'entities', refs: ['resource:default/r1'], conclusion: SECRET }),
    ])
    expect(answered.text).not.toContain('›')
    expect(errors).toContain('secret-thing, which no tool returned')
  })

  it('is kept once the reference itself was shown, with its homonym', async () => {
    const graph = EntityGraph.from([
      entityOf('Resource', 'db', {}, 'dev'),
      right('r1', ['component:default/ghost'], ['resource:default/secret-thing']),
      entityOf('Component', 'secret-thing'),
    ])
    const { answered, errors } = await askOver(graph, [
      calling('get_entity', { ref: 'resource:default/r1' }),
      calling('answer', {
        outcome: 'entities',
        refs: ['resource:default/r1'],
        conclusion: 'The right names resource:default/secret-thing, which is declared nowhere.',
      }),
    ])
    expect(answered.text).toContain('› The right names resource:default/secret-thing')
    expect(errors).toBe('')
  })
})
