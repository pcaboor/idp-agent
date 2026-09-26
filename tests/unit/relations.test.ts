import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import {
  RELATION_LIMITS,
  reachedBy,
  relationsOf,
  rightsOn,
  type RelationResult,
  type RelationRow,
} from '../../src/context/graph/relations.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { RELATIONS } from '../../src/core/schemas/query.js'
import type { ResourceType } from '../../src/core/schemas/resource-types.js'

/**
 * Every relation is computed from the declarations, by one walk over the
 * graph's own edges — never inferred, never a second definition of an edge,
 * a right, a level or a dangling reference. The owner's three questions are
 * asked of `tests/golden/relations-owner/`, a cut of a declarations
 * repository where one right over billing-db-dev names two consumers.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const OWNER = path.resolve(import.meta.dirname, '../golden/relations-owner')
const APIS = path.resolve(import.meta.dirname, '../golden/backstage-apis')
const DANGLING = path.resolve(import.meta.dirname, '../golden/dangling-shown')

const load = async (root: string): Promise<EntityGraph> => {
  const loaded = await new FixtureProvider(root).load()
  return EntityGraph.from(
    loaded.entities,
    loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
  )
}

const resource = (
  name: string,
  type: ResourceType,
  options: { env?: string; dependsOn?: string[]; dependencyOf?: string[]; access?: 'read' | 'readwrite' } = {},
): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: {
    name,
    annotations: options.env === undefined ? {} : { 'company.fr/env': options.env },
  },
  spec: {
    type,
    owner: 'group:default/tiger',
    ...(options.access === undefined ? {} : { access: options.access }),
    ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
    ...(options.dependencyOf === undefined ? {} : { dependencyOf: options.dependencyOf }),
  },
})

const service = (name: string, dependsOn: string[] = []): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, annotations: {} },
  spec: {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:default/tiger',
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  },
})

const r = (name: string): string => `resource:default/${name}`
const c = (name: string): string => `component:default/${name}`

/** A row as refs: the path from the subject to what it reached. */
const paths = (result: RelationResult | undefined): string[][] =>
  (result?.rows ?? []).map((row) => row.steps.map((step) => step.ref))

const must = (result: RelationResult | undefined): RelationResult => {
  expect(result).toBeDefined()
  if (result === undefined) throw new Error('no result')
  return result
}

describe('consumes: what a consumer reaches through its rights', () => {
  it("answers the owner's question: payments-api consumes billing-db-dev, readwrite, dev, via the right", async () => {
    const result = must(relationsOf(await load(OWNER), c('payments-api'), 'consumes'))
    expect(paths(result)).toEqual([[c('payments-api'), r('billing-api-billing-db-dev'), r('billing-db-dev')]])
    const [row] = result.rows as [RelationRow]
    expect(reachedBy(row)).toEqual({
      ref: r('billing-db-dev'),
      kind: 'Resource',
      type: 'database',
      env: 'dev',
    })
    expect(rightsOn(row)).toEqual([
      {
        ref: r('billing-api-billing-db-dev'),
        kind: 'Resource',
        type: 'database-access',
        env: 'dev',
        right: { levelled: true, level: 'readwrite' },
      },
    ])
    expect(row.steps[0]).toEqual({ ref: c('payments-api'), kind: 'Component', type: 'service' })
  })

  it('stops at the object a right is over unless asked for more, and says it stopped', async () => {
    const graph = await load(OWNER)
    const bounded = must(relationsOf(graph, c('payments-api'), 'consumes'))
    expect(bounded.depth).toBe(RELATION_LIMITS.consumesDepth)
    // billing-db-dev runs on a host, and that edge was not followed.
    expect(bounded.stopped).toBe(true)

    const onward = must(relationsOf(graph, c('payments-api'), 'consumes', { depth: 3 }))
    expect(paths(onward)).toEqual([
      [c('payments-api'), r('billing-api-billing-db-dev'), r('billing-db-dev')],
      [c('payments-api'), r('billing-api-billing-db-dev'), r('billing-db-dev'), r('mysql-disi6-dev')],
    ])
    expect(onward.stopped).toBe(false)
  })

  it('lists a right with no level as one, and a target declared nowhere with the entity of its name', async () => {
    const result = must(relationsOf(await load(OWNER), c('billing-api'), 'consumes'))
    expect(paths(result)).toEqual([
      [c('billing-api'), r('billing-api-billing-db-dev'), r('billing-db-dev')],
      [c('billing-api'), r('billing-api-to-payments'), r('payments-api')],
    ])
    const dangling = result.rows[1] as RelationRow
    expect(rightsOn(dangling)[0]?.right).toEqual({ levelled: false })
    expect(reachedBy(dangling)).toEqual({
      ref: r('payments-api'),
      nowhere: {
        from: r('billing-api-to-payments'),
        field: 'dependsOn',
        to: r('payments-api'),
        sameName: [c('payments-api')],
      },
    })
  })

  it('reaches nothing from an entity that holds no right', async () => {
    const graph = await load(DEMO)
    expect(must(relationsOf(graph, r('billing-db-prod'), 'consumes')).rows).toEqual([])
  })

  it('reads a levelled right that states no level as unstated, never as readwrite', () => {
    const graph = EntityGraph.from([
      service('app'),
      resource('db', 'database', { env: 'dev' }),
      resource('app-db', 'database-access', {
        env: 'dev',
        dependsOn: [r('db')],
        dependencyOf: [c('app')],
      }),
    ])
    const [row] = must(relationsOf(graph, c('app'), 'consumes')).rows
    expect(row === undefined ? undefined : rightsOn(row)[0]?.right).toEqual({ levelled: true })
  })
})

describe('consumed-by: who reaches an entity through rights', () => {
  it("answers the owner's question: billing-api and payments-api, each through the same readwrite dev right", async () => {
    const result = must(relationsOf(await load(OWNER), r('billing-db-dev'), 'consumed-by'))
    expect(paths(result)).toEqual([
      [r('billing-db-dev'), r('billing-api-billing-db-dev'), c('billing-api')],
      [r('billing-db-dev'), r('billing-api-billing-db-dev'), c('payments-api')],
    ])
    for (const row of result.rows) {
      expect(rightsOn(row).map(({ ref, env, right }) => ({ ref, env, right }))).toEqual([
        { ref: r('billing-api-billing-db-dev'), env: 'dev', right: { levelled: true, level: 'readwrite' } },
      ])
    }
  })

  it('walks through the objects in front of a host, with the path', async () => {
    const result = must(relationsOf(await load(DEMO), r('mysql-prod-01'), 'consumed-by'))
    expect(paths(result)).toEqual([
      [r('mysql-prod-01'), r('billing-db-prod'), r('billing-api-billing-db-prod'), c('billing-api')],
      [r('mysql-prod-01'), r('orders-db-prod'), r('orders-api-orders-db-prod'), c('orders-api')],
      [r('mysql-prod-01'), r('billing-db-prod'), r('reporting-billing-db-prod'), c('reporting-worker')],
    ])
  })

  it('lists one row per right when a consumer reaches the object through two', () => {
    const graph = EntityGraph.from([
      service('app'),
      resource('db', 'database', { env: 'dev' }),
      resource('app-db-read', 'database-access', {
        env: 'dev',
        access: 'read',
        dependsOn: [r('db')],
        dependencyOf: [c('app')],
      }),
      resource('app-to-db', 'network-access', {
        env: 'dev',
        dependsOn: [r('db')],
        dependencyOf: [c('app')],
      }),
    ])
    const result = must(relationsOf(graph, r('db'), 'consumed-by'))
    expect(result.rows.map((row) => rightsOn(row).map(({ ref, right }) => [ref, right]))).toEqual([
      [[r('app-db-read'), { levelled: true, level: 'read' }]],
      [[r('app-to-db'), { levelled: false }]],
    ])
  })

  it('names the same services consumersOf does, and the same services declared nowhere', async () => {
    for (const root of [DEMO, OWNER, APIS, DANGLING]) {
      const graph = await load(root)
      for (const entity of graph.all()) {
        const ref = refOf(entity)
        const result = must(relationsOf(graph, ref, 'consumed-by', { depth: 100, rows: 10_000 }))
        const reached = new Set(result.rows.flatMap((row) => (reachedBy(row).nowhere ? [] : [reachedBy(row).ref])))
        expect([...reached].sort(), ref).toEqual(graph.consumersOf(ref).map(refOf).sort())
        const nowhere = new Set(result.rows.flatMap((row) => (reachedBy(row).nowhere ? [reachedBy(row).ref] : [])))
        expect([...nowhere].sort(), ref).toEqual(
          [...new Set(graph.unresolvedConsumersOf(ref).map(({ to }) => to))].sort(),
        )
      }
    }
  })

  it('marks a consumer declared nowhere where the path ends', async () => {
    const result = must(relationsOf(await load(DANGLING), r('billing-db-dev'), 'consumed-by'))
    const missing = result.rows.find((row) => reachedBy(row).nowhere !== undefined)
    expect(missing?.steps.map((step) => step.ref)).toEqual([
      r('billing-db-dev'),
      r('billing-api-billing-db-dev'),
      c('payments-api'),
    ])
    expect(missing === undefined ? undefined : reachedBy(missing).nowhere?.sameName).toEqual([r('payments-api')])
  })
})

describe('depends-on and impacts: every declared hop, transitively', () => {
  it('impacts of a host: the databases on it, the rights over them, the services behind them', async () => {
    const result = must(relationsOf(await load(DEMO), r('mysql-prod-01'), 'impacts'))
    expect(paths(result)).toEqual([
      [r('mysql-prod-01'), r('billing-db-prod')],
      [r('mysql-prod-01'), r('compliance-db-prod')],
      [r('mysql-prod-01'), r('orders-db-prod')],
      [r('mysql-prod-01'), r('billing-db-prod'), r('billing-api-billing-db-prod')],
      [r('mysql-prod-01'), r('orders-db-prod'), r('orders-api-orders-db-prod')],
      [r('mysql-prod-01'), r('billing-db-prod'), r('reporting-billing-db-prod')],
      [r('mysql-prod-01'), r('billing-db-prod'), r('billing-api-billing-db-prod'), c('billing-api')],
      [r('mysql-prod-01'), r('orders-db-prod'), r('orders-api-orders-db-prod'), c('orders-api')],
      [r('mysql-prod-01'), r('billing-db-prod'), r('reporting-billing-db-prod'), c('reporting-worker')],
    ])
    expect(result.rows.map((row) => row.steps.length - 1)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3])
    expect(result.rows.map((row) => reachedBy(row).env)).toEqual([
      'prod', 'prod', 'prod', 'prod', 'prod', 'prod', undefined, undefined, undefined,
    ])
    expect(result.stopped).toBe(false)
    expect(result.cycles).toEqual([])
  })

  it('depends-on of a service: its rights, what they are over, and what those run on', async () => {
    const result = must(relationsOf(await load(DEMO), c('reporting-worker'), 'depends-on'))
    expect(paths(result)).toEqual([
      [c('reporting-worker'), r('reporting-billing-db-prod')],
      [c('reporting-worker'), r('reporting-billing-db-prod'), r('billing-db-prod')],
      [c('reporting-worker'), r('reporting-billing-db-prod'), r('billing-db-prod'), r('mysql-prod-01')],
    ])
  })

  it('is the transpose of impacts, hop by hop', async () => {
    const graph = await load(DEMO)
    for (const entity of graph.all()) {
      const ref = refOf(entity)
      for (const row of must(relationsOf(graph, ref, 'depends-on', { depth: 1 })).rows) {
        const back = must(relationsOf(graph, reachedBy(row).ref, 'impacts', { depth: 1 }))
        expect(paths(back).map((p) => p.at(-1))).toContain(ref)
      }
    }
  })

  it('marks a dependency declared nowhere, and ends the path there', async () => {
    const result = must(relationsOf(await load(DANGLING), c('billing-api'), 'depends-on'))
    const missing = result.rows.filter((row) => reachedBy(row).nowhere !== undefined)
    expect(missing.map((row) => row.steps.map((step) => step.ref))).toEqual([
      [c('billing-api'), r('billing-queue-dev')],
    ])
    expect(reachedBy(missing[0] as RelationRow)).toEqual({
      ref: r('billing-queue-dev'),
      nowhere: { from: c('billing-api'), field: 'dependsOn', to: r('billing-queue-dev'), sameName: [] },
    })
  })

  it('never loops on a cycle, and reports it', () => {
    const graph = EntityGraph.from([
      resource('a', 'database', { dependsOn: [r('b')] }),
      resource('b', 'database', { dependsOn: [r('c')] }),
      resource('c', 'database', { dependsOn: [r('a')] }),
    ])
    const result = must(relationsOf(graph, r('a'), 'depends-on'))
    expect(paths(result)).toEqual([
      [r('a'), r('b')],
      [r('a'), r('b'), r('c')],
    ])
    expect(result.cycles).toEqual([[r('a'), r('b'), r('c'), r('a')]])
    const back = must(relationsOf(graph, r('a'), 'impacts'))
    expect(back.cycles).toEqual([[r('a'), r('c'), r('b'), r('a')]])
  })

  it('reports a cycle between two entities reached along different branches', () => {
    // s reaches a and b on two branches; a → b → a closes on neither
    // branch's path, and is declared all the same.
    const graph = EntityGraph.from([
      resource('s', 'database', { dependsOn: [r('a'), r('b')] }),
      resource('a', 'database', { dependsOn: [r('b')] }),
      resource('b', 'database', { dependsOn: [r('a')] }),
    ])
    const result = must(relationsOf(graph, r('s'), 'depends-on'))
    expect(paths(result)).toEqual([
      [r('s'), r('a')],
      [r('s'), r('b')],
      [r('s'), r('b'), r('a')],
      [r('s'), r('a'), r('b')],
    ])
    expect(result.cycles).toEqual([[r('s'), r('a'), r('b'), r('a')]])
  })

  it('reports a cycle that closes at the depth bound', () => {
    const graph = EntityGraph.from([
      resource('a', 'database', { dependsOn: [r('b')] }),
      resource('b', 'database', { dependsOn: [r('c')] }),
      resource('c', 'database', { dependsOn: [r('a')] }),
    ])
    const result = must(relationsOf(graph, r('a'), 'depends-on', { depth: 2 }))
    expect(result.cycles).toEqual([[r('a'), r('b'), r('c'), r('a')]])
    // Nothing was left: the edge not followed returns to a listed entity.
    expect(result.stopped).toBe(false)
  })

  it('lists every edge of a diamond, each with its own path', () => {
    const graph = EntityGraph.from([
      resource('top', 'database', { dependsOn: [r('left'), r('right')] }),
      resource('left', 'database', { dependsOn: [r('bottom')] }),
      resource('right', 'database', { dependsOn: [r('bottom')] }),
      resource('bottom', 'database'),
    ])
    expect(paths(relationsOf(graph, r('top'), 'depends-on'))).toEqual([
      [r('top'), r('left')],
      [r('top'), r('right')],
      [r('top'), r('left'), r('bottom')],
      [r('top'), r('right'), r('bottom')],
    ])
  })
})

describe('bounds are stated, never silent', () => {
  const chain = EntityGraph.from(
    Array.from({ length: 6 }, (_, index) =>
      resource(`n${String(index)}`, 'database', index < 5 ? { dependsOn: [r(`n${String(index + 1)}`)] } : {}),
    ),
  )

  it('stops at a depth, and says it stopped only when something was left', () => {
    const cut = must(relationsOf(chain, r('n0'), 'depends-on', { depth: 2 }))
    expect(paths(cut).map((p) => p.length - 1)).toEqual([1, 2])
    expect(cut).toMatchObject({ depth: 2, stopped: true })
    expect(must(relationsOf(chain, r('n0'), 'depends-on', { depth: 5 })).stopped).toBe(false)
  })

  it('cuts at a row count, and counts what it cut', () => {
    const cut = must(relationsOf(chain, r('n0'), 'depends-on', { rows: 2 }))
    expect(cut.rows).toHaveLength(2)
    expect(cut.total).toBe(5)
  })

  it('orders by depth, then by reference, whatever order the entities came in', async () => {
    const graph = await load(DEMO)
    const shuffled = EntityGraph.from([...graph.all()].reverse())
    for (const relation of RELATIONS) {
      if (relation === 'between') continue
      for (const entity of graph.all()) {
        const ref = refOf(entity)
        expect(paths(relationsOf(shuffled, ref, relation)), `${relation} ${ref}`).toEqual(
          paths(relationsOf(graph, ref, relation)),
        )
      }
    }
  })
})

describe('provides and provided-by: Backstage APIs, one declared hop', () => {
  it('what a component provides, a providesApis naming nothing marked', async () => {
    const result = must(relationsOf(await load(APIS), c('billing-api'), 'provides'))
    expect(paths(result)).toEqual([
      [c('billing-api'), 'api:default/billing'],
      [c('billing-api'), 'api:default/ghost'],
    ])
    expect(reachedBy(result.rows[1] as RelationRow).nowhere?.field).toBe('providesApis')
  })

  it('who provides an API', async () => {
    const result = must(relationsOf(await load(APIS), 'api:default/billing', 'provided-by'))
    expect(paths(result)).toEqual([['api:default/billing', c('billing-api')]])
  })

  it('who reaches an API through a right with no level', async () => {
    const result = must(relationsOf(await load(APIS), 'api:default/payments', 'consumed-by'))
    expect(paths(result)).toEqual([
      ['api:default/payments', r('orders-api-to-payments'), c('orders-api')],
    ])
    expect(rightsOn(result.rows[0] as RelationRow)[0]?.right).toEqual({ levelled: false })
  })
})

describe('between: every simple path linking two entities, either way', () => {
  it("answers the owner's question: payments-api to billing-db-dev through the readwrite right", async () => {
    const graph = await load(OWNER)
    const result = must(relationsOf(graph, c('payments-api'), 'between', { to: r('billing-db-dev') }))
    expect(paths(result)).toEqual([
      [c('payments-api'), r('billing-api-billing-db-dev'), r('billing-db-dev')],
    ])
    expect(result.rows[0]?.backward).toBeUndefined()
    expect(result.to?.ref).toBe(r('billing-db-dev'))

    // Asked the other way round: the same path, listed from the entity asked
    // about, each step depending on the one before.
    const back = must(relationsOf(graph, r('billing-db-dev'), 'between', { to: c('payments-api') }))
    expect(paths(back)).toEqual([
      [r('billing-db-dev'), r('billing-api-billing-db-dev'), c('payments-api')],
    ])
    expect(back.rows[0]?.backward).toBe(true)
  })

  it('finds several paths, shortest first, and none where nothing links them', () => {
    const graph = EntityGraph.from([
      service('app', [r('db'), r('cache')]),
      resource('cache', 'cache', { dependsOn: [r('db')] }),
      resource('db', 'database'),
      resource('other', 'database'),
    ])
    expect(paths(relationsOf(graph, c('app'), 'between', { to: r('db') }))).toEqual([
      [c('app'), r('db')],
      [c('app'), r('cache'), r('db')],
    ])
    expect(must(relationsOf(graph, c('app'), 'between', { to: r('other') })).rows).toEqual([])
  })

  it('keeps a declaration naming the other end under another kind apart from the paths', async () => {
    // The owner's first report: a right names component:default/payments-api,
    // declared nowhere, beside resource:default/payments-api. No path links the
    // Resource and the database, and "none" alone was read as "no relation";
    // but a near miss is not a path either, and is never counted as one.
    const graph = await load(DANGLING)
    const result = must(relationsOf(graph, r('payments-api'), 'between', { to: r('billing-db-dev') }))
    expect(result.rows).toEqual([])
    expect(result.total).toBe(0)
    expect(result.nearMisses?.total).toBe(1)
    const [row] = result.nearMisses?.rows ?? []
    expect(row?.steps.map((step) => step.ref)).toEqual([
      r('billing-db-dev'),
      r('billing-api-billing-db-dev'),
      c('payments-api'),
    ])
    expect(row?.backward).toBe(true)
    expect(row === undefined ? undefined : reachedBy(row).nowhere?.sameName).toEqual([r('payments-api')])
    // Asked from the other end, the same declaration, found from the start.
    const back = must(relationsOf(graph, r('billing-db-dev'), 'between', { to: r('payments-api') }))
    expect(back.nearMisses?.rows.map((near) => near.steps.map((step) => step.ref))).toEqual(
      result.nearMisses?.rows.map((near) => near.steps.map((step) => step.ref)),
    )
  })

  it('where neither depends on the other, names the nearest entity both depend on', async () => {
    // One right lists both services as its consumers: neither service depends
    // on the other, and the file relates them all the same.
    const graph = await load(OWNER)
    const result = must(relationsOf(graph, c('payments-api'), 'between', { to: c('billing-api') }))
    expect(result.rows).toEqual([])
    expect(result.shared?.total).toBe(1)
    const [meeting] = result.shared?.rows ?? []
    expect(meeting?.relation).toBe('depends-on')
    expect(meeting?.paths.map((row) => row.steps.map((step) => step.ref))).toEqual([
      [c('payments-api'), r('billing-api-billing-db-dev')],
      [c('billing-api'), r('billing-api-billing-db-dev')],
    ])
  })

  it('two consumers of one database meet at the database, not at the host behind it', async () => {
    const graph = await load(DEMO)
    const result = must(relationsOf(graph, c('billing-api'), 'between', { to: c('reporting-worker') }))
    expect(result.rows).toEqual([])
    expect(result.shared?.rows.map((meeting) => meeting.paths.map((row) => row.steps.map((step) => step.ref)))).toEqual([
      [
        [c('billing-api'), r('billing-api-billing-db-prod'), r('billing-db-prod')],
        [c('reporting-worker'), r('reporting-billing-db-prod'), r('billing-db-prod')],
      ],
    ])
  })

  it('two objects one service reaches meet at the service, read toward what needs them', () => {
    const graph = EntityGraph.from([
      service('app'),
      resource('db', 'database', { env: 'dev' }),
      resource('cache', 'cache', { env: 'dev' }),
      resource('app-db', 'database-access', { env: 'dev', access: 'read', dependsOn: [r('db')], dependencyOf: [c('app')] }),
      resource('app-cache', 'database-access', { env: 'dev', access: 'read', dependsOn: [r('cache')], dependencyOf: [c('app')] }),
    ])
    const result = must(relationsOf(graph, r('db'), 'between', { to: r('cache') }))
    expect(result.shared?.rows.map((meeting) => [meeting.relation, meeting.paths.map((row) => row.steps.map((step) => step.ref))])).toEqual([
      [
        'impacts',
        [
          [r('db'), r('app-db'), c('app')],
          [r('cache'), r('app-cache'), c('app')],
        ],
      ],
    ])
  })

  it('names no shared entity where a path links the two', async () => {
    const graph = await load(OWNER)
    const result = must(relationsOf(graph, c('payments-api'), 'between', { to: r('billing-db-dev') }))
    expect(result.shared).toBeUndefined()
    expect(result.nearMisses).toBeUndefined()
  })

  it('does not know an entity that is not declared', async () => {
    const graph = await load(OWNER)
    expect(relationsOf(graph, c('absent'), 'consumes')).toBeUndefined()
    expect(relationsOf(graph, c('payments-api'), 'between', { to: r('absent') })).toBeUndefined()
    expect(relationsOf(graph, c('payments-api'), 'between')).toBeUndefined()
  })
})
