import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { OVERVIEW_LIMITS } from '../../src/cli/render/overview.js'
import { overviewOf, type Tally } from '../../src/context/graph/overview.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import type { ResourceType } from '../../src/core/schemas/resource-types.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

/**
 * The demo SI read a second way: the raw YAML, with no `parseDocuments`, no
 * `EntityGraph` and no `overviewOf`. A count copied from the implementation's
 * output would assert that it agrees with itself.
 */
interface Raw {
  kind: string
  metadata: { name: string; annotations?: Record<string, string> }
  spec: {
    type: string
    owner: string
    access?: string
    dependsOn?: string[]
    dependencyOf?: string[]
  }
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  )

const RAW: Raw[] = files(FIXTURES)
  .filter((file) => file.endsWith('.yml'))
  .flatMap((file) => parseAllDocuments(readFileSync(file, 'utf8')).map((doc) => doc.toJS()))
  .filter((doc): doc is Raw => doc !== null && typeof doc === 'object' && 'kind' in doc)

/** Count desc, then name — the order the brief fixes, computed here by hand. */
const tally = (values: string[]): Tally[] => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || (left.name < right.name ? -1 : 1))
}

const ENV = 'company.fr/env'
const RIGHTS = ['database-access', 'network-access', 'gateway-route']

const rawRef = (doc: Raw): string => `${doc.kind.toLowerCase()}:default/${doc.metadata.name}`

/**
 * What reaches each object, walked over the raw documents: an edge is written
 * from either side, `dependsOn` on the one that depends or `dependencyOf` on
 * the Resource depended on. A Component ends a chain; a right is counted and
 * walked through. Sorted services, then rights, then name.
 */
const rawReached = (): Array<{ ref: string; services: number; rights: number }> => {
  const byRef = new Map(RAW.map((doc) => [rawRef(doc), doc]))
  const dependants = new Map<string, Set<string>>()
  const link = (target: string, from: string) =>
    dependants.set(target, (dependants.get(target) ?? new Set()).add(from))
  for (const doc of RAW) {
    for (const target of doc.spec.dependsOn ?? []) link(target, rawRef(doc))
    if (doc.kind !== 'Resource') continue
    for (const consumer of doc.spec.dependencyOf ?? []) link(rawRef(doc), consumer)
  }
  const reached = []
  for (const doc of RAW) {
    if (doc.kind !== 'Resource' || RIGHTS.includes(doc.spec.type)) continue
    const seen = new Set([rawRef(doc)])
    const queue = [rawRef(doc)]
    let services = 0
    let rights = 0
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
      for (const next of dependants.get(current) ?? []) {
        const found = byRef.get(next)
        if (found === undefined || seen.has(next)) continue
        seen.add(next)
        if (found.kind === 'Component') services += 1
        else {
          if (RIGHTS.includes(found.spec.type)) rights += 1
          queue.push(next)
        }
      }
    }
    if (services + rights > 0) reached.push({ ref: rawRef(doc), services, rights })
  }
  return reached.sort(
    (left, right) =>
      right.services - left.services ||
      right.rights - left.rights ||
      (left.ref < right.ref ? -1 : 1),
  )
}

const demo = async () => {
  const { entities, ignored, rejected } = await new FixtureProvider(FIXTURES).load()
  return overviewOf(EntityGraph.from(entities), { ignored, rejected: rejected.length })
}

describe('overviewOf over the demo SI', () => {
  it('counts every entity, exactly — this is read by a person, not a prompt', async () => {
    const overview = await demo()
    expect(RAW.length).toBeGreaterThan(30)
    expect(overview.entities).toBe(RAW.length)
    expect(overview.kinds).toEqual(tally(RAW.map((doc) => doc.kind)))
    expect(overview.types).toEqual(tally(RAW.map((doc) => doc.spec.type)))
    expect(overview.owners).toEqual(tally(RAW.map((doc) => doc.spec.owner)))
  })

  it('counts environments as declared, and the entities that declare none apart', async () => {
    const overview = await demo()
    const declared = RAW.flatMap((doc) => doc.metadata.annotations?.[ENV] ?? [])
    expect(overview.environments.declared).toEqual(tally(declared))
    expect(overview.environments.undeclared).toBe(RAW.length - declared.length)
    // The five Components declare none: an undeclared environment is counted,
    // never folded into one that happens to be common.
    expect(overview.environments.undeclared).toBe(5)
  })

  it('counts the rights and the level each one states', async () => {
    const overview = await demo()
    const rights = RAW.filter((doc) => doc.kind === 'Resource' && RIGHTS.includes(doc.spec.type))
    const levelled = rights.filter((doc) => doc.spec.type === 'database-access')
    expect(overview.rights).toEqual({
      total: rights.length,
      read: levelled.filter((doc) => doc.spec.access === 'read').length,
      readwrite: levelled.filter((doc) => doc.spec.access === 'readwrite').length,
      undeclared: levelled.filter((doc) => doc.spec.access === undefined).length,
      unlevelled: rights.length - levelled.length,
    })
    expect(overview.rights).toEqual({ total: 10, read: 3, readwrite: 4, undeclared: 0, unlevelled: 3 })
  })

  it('ranks the objects by the services that reach them, through any chain', async () => {
    // By hand, from the file names: the two shared MySQL hosts each sit under
    // three databases that three different services hold a grant on, and
    // billing-db-prod is read by reporting-worker and written by billing-api.
    const { reached } = await demo()
    expect(reached.slice(0, 3)).toMatchObject([
      { ref: 'resource:default/mysql-disi6-dev', services: 3 },
      { ref: 'resource:default/mysql-prod-01', services: 3 },
      { ref: 'resource:default/billing-db-prod', services: 2 },
    ])
    // The whole list, every count and every tie, from the raw documents.
    expect(reached).toEqual(rawReached())
    expect(reached.length).toBeGreaterThan(OVERVIEW_LIMITS.rows)
    // Rights are how an object is reached, not what is reached; an object
    // nothing reaches is not "most reached" at any rank.
    const objects = new Set(
      RAW.filter((doc) => doc.kind === 'Resource' && !RIGHTS.includes(doc.spec.type)).map(
        (doc) => `resource:default/${doc.metadata.name}`,
      ),
    )
    expect(reached.every(({ ref }) => objects.has(ref))).toBe(true)
    expect(reached.map(({ ref }) => ref)).not.toContain('resource:default/mysql-disi6-rec')
    expect(reached.every(({ services, rights }) => services + rights > 0)).toBe(true)
  })

  it('counts every entity under no system, and describes none: the demo SI writes neither', async () => {
    const overview = await demo()
    expect(overview.systems).toEqual({ declared: [], none: RAW.length })
    expect(overview.tags).toEqual([])
    expect(overview.described).toEqual([])
  })

  it('reports no dangling reference, nothing set aside and nothing rejected', async () => {
    const overview = await demo()
    expect(overview.dangling).toEqual([])
    expect(overview.setAside).toEqual({ total: 0, kinds: [], unkinded: 0 })
    expect(overview.rejected).toBe(0)
  })
})

const resource = (
  name: string,
  type: ResourceType,
  dependsOn: string[] = [],
  dependencyOf: string[] = [],
): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name, annotations: { [ENV]: 'dev' } },
  spec: {
    type,
    owner: 'group:default/tiger',
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(dependencyOf.length > 0 ? { dependencyOf } : {}),
  },
})

describe('overviewOf at the edges', () => {
  it('describes an empty graph as empty, with no list holding anything', () => {
    expect(overviewOf(EntityGraph.from([]), { ignored: [], rejected: 0 })).toEqual({
      entities: 0,
      kinds: [],
      types: [],
      environments: { declared: [], undeclared: 0 },
      owners: [],
      systems: { declared: [], none: 0 },
      tags: [],
      described: [],
      rights: { total: 0, read: 0, readwrite: 0, undeclared: 0, unlevelled: 0 },
      reached: [],
      dangling: [],
      setAside: { total: 0, kinds: [], unkinded: 0 },
      rejected: 0,
    })
  })

  it('lists every dangling reference, sorted, never pruned', () => {
    const graph = EntityGraph.from([
      resource('zeta-db', 'database', ['resource:default/ghost-host']),
      resource('alpha-grant', 'database-access', ['resource:default/zeta-db'], [
        'component:default/ghost-service',
      ]),
      resource('alpha-db', 'database', ['resource:default/another-ghost']),
    ])
    expect(overviewOf(graph, { ignored: [], rejected: 0 }).dangling).toEqual([
      { from: 'resource:default/alpha-db', to: 'resource:default/another-ghost' },
      { from: 'resource:default/alpha-grant', to: 'component:default/ghost-service' },
      { from: 'resource:default/zeta-db', to: 'resource:default/ghost-host' },
    ])
  })

  it('counts an object only grants reach, their services being declared elsewhere', () => {
    // A declarations repository: the grant names a service another repository
    // declares. No declared service reaches the database; the grant does, and
    // "most reached: none" would say something false about this catalogue.
    const graph = EntityGraph.from([
      resource('orders-db', 'database'),
      resource('orders-grant', 'database-access', ['resource:default/orders-db'], [
        'component:default/orders-api',
      ]),
      resource('idle-db', 'database'),
    ])
    expect(overviewOf(graph, { ignored: [], rejected: 0 }).reached).toEqual([
      { ref: 'resource:default/orders-db', services: 0, rights: 1 },
    ])
  })

  it('counts an empty or blank environment as undeclared, not as one named ""', () => {
    const named = (name: string, env: string): Entity => ({
      ...resource(name, 'database'),
      metadata: { name, annotations: { [ENV]: env } },
    })
    const overview = overviewOf(
      EntityGraph.from([named('a', ''), named('b', '  '), named('c', 'dev')]),
      { ignored: [], rejected: 0 },
    )
    expect(overview.environments).toEqual({ declared: [{ name: 'dev', count: 1 }], undeclared: 2 })
  })

  it('counts a grant with no stated level as undeclared, never as readwrite', () => {
    const graph = EntityGraph.from([resource('grant', 'database-access')])
    expect(overviewOf(graph, { ignored: [], rejected: 0 }).rights).toEqual({
      total: 1,
      read: 0,
      readwrite: 0,
      undeclared: 1,
      unlevelled: 0,
    })
  })

  it('says what was set aside, by kind, and how much was rejected', () => {
    const overview = overviewOf(EntityGraph.from([]), {
      ignored: [
        { source: 'org/a.yml', reason: 'not modelled', kind: 'User', ref: 'user:default/a' },
        { source: 'org/b.yml', reason: 'not modelled', kind: 'Group', ref: 'group:default/b' },
        { source: 'org/c.yml', reason: 'not modelled', kind: 'User', ref: 'user:default/c' },
        { source: 'mkdocs.yml', reason: 'declares no kind' },
      ],
      rejected: 2,
    })
    expect(overview.setAside).toEqual({
      total: 4,
      kinds: [
        { name: 'User', count: 2 },
        { name: 'Group', count: 1 },
      ],
      unkinded: 1,
    })
    expect(overview.rejected).toBe(2)
  })

  it('counts entities by system, and the ones in none apart', () => {
    const inSystem = (name: string, system?: string): Entity => {
      const base = resource(name, 'database')
      return system === undefined ? base : { ...base, spec: { ...base.spec, system } } as Entity
    }
    const overview = overviewOf(
      EntityGraph.from([
        inSystem('a', 'system:default/billing'),
        inSystem('b', 'system:default/web'),
        inSystem('c', 'system:default/web'),
        inSystem('d'),
      ]),
      { ignored: [], rejected: 0 },
    )
    expect(overview.systems).toEqual({
      declared: [
        { name: 'system:default/web', count: 2 },
        { name: 'system:default/billing', count: 1 },
      ],
      none: 1,
    })
  })

  it('counts each tag once per entity that carries it', () => {
    const tagged = (name: string, tags: string[]): Entity => ({
      ...resource(name, 'database'),
      metadata: { name, annotations: {}, tags },
    })
    const overview = overviewOf(
      EntityGraph.from([
        tagged('a', ['java', 'java', 'web']),
        tagged('b', ['java']),
        tagged('c', []),
      ]),
      { ignored: [], rejected: 0 },
    )
    expect(overview.tags).toEqual([
      { name: 'java', count: 2 },
      { name: 'web', count: 1 },
    ])
  })

  it('lists every entity that describes itself, by reference, in its own words', () => {
    const described = (name: string, description?: string): Entity => ({
      ...resource(name, 'database'),
      metadata: {
        name,
        annotations: {},
        ...(description === undefined ? {} : { description }),
      },
    })
    const graph = [
      described('zeta-db', 'The ledger'),
      described('alpha-db', 'Orders, by customer'),
      described('blank-db', '   '),
      described('silent-db'),
    ]
    const left = overviewOf(EntityGraph.from(graph), { ignored: [], rejected: 0 })
    const right = overviewOf(EntityGraph.from([...graph].reverse()), { ignored: [], rejected: 0 })
    expect(left.described).toEqual([
      { ref: 'resource:default/alpha-db', description: 'Orders, by customer' },
      { ref: 'resource:default/zeta-db', description: 'The ledger' },
    ])
    expect(right.described).toEqual(left.described)
  })

  it('breaks a tie by name, so the same graph always reads the same', () => {
    const one = [resource('b', 'cache'), resource('a', 'database')]
    const left = overviewOf(EntityGraph.from(one), { ignored: [], rejected: 0 })
    const right = overviewOf(EntityGraph.from([...one].reverse()), { ignored: [], rejected: 0 })
    expect(left).toEqual(right)
    expect(left.types).toEqual([
      { name: 'cache', count: 1 },
      { name: 'database', count: 1 },
    ])
  })

  it('breaks a tie among the most reached by reference, whatever the load order', () => {
    const grants = [
      resource('zeta-db', 'database'),
      resource('alpha-db', 'database'),
      resource('grant-z', 'database-access', ['resource:default/zeta-db']),
      resource('grant-a', 'database-access', ['resource:default/alpha-db']),
    ]
    const left = overviewOf(EntityGraph.from(grants), { ignored: [], rejected: 0 })
    const right = overviewOf(EntityGraph.from([...grants].reverse()), { ignored: [], rejected: 0 })
    expect(left.reached).toEqual(right.reached)
    expect(left.reached.map(({ ref }) => ref)).toEqual([
      'resource:default/alpha-db',
      'resource:default/zeta-db',
    ])
  })
})
