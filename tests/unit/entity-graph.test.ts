import { describe, expect, it } from 'vitest'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import type { ResourceType } from '../../src/core/schemas/resource-types.js'

const resource = (
  name: string,
  type: ResourceType,
  env: string,
  dependsOn: string[] = [],
  dependencyOf: string[] = [],
): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name, annotations: { 'company.fr/env': env } },
  spec: {
    type,
    owner: 'group:default/tiger',
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(dependencyOf.length > 0 ? { dependencyOf } : {}),
  },
})

const host = resource('mysql-dev', 'database', 'dev')
const db = resource('billing-db-dev', 'database', 'dev', ['resource:default/mysql-dev'])
const access = resource(
  'billing-api-billing-db-dev',
  'database-access',
  'dev',
  ['resource:default/billing-db-dev'],
  ['component:default/billing-api'],
)
const component: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'billing-api', annotations: {} },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
}

const graph = EntityGraph.from([host, db, access])

describe('refOf', () => {
  it('builds a Backstage reference', () => {
    expect(refOf(db)).toBe('resource:default/billing-db-dev')
    expect(refOf(component)).toBe('component:default/billing-api')
  })
})

describe('EntityGraph', () => {
  it('finds an entity by reference', () => {
    expect(graph.get('resource:default/billing-db-dev')).toEqual(db)
    expect(graph.get('resource:default/absent')).toBeUndefined()
  })

  it('searches by type and environment', () => {
    expect(graph.search({ type: 'database', env: 'dev' }).map((e) => e.metadata.name)).toEqual([
      'mysql-dev',
      'billing-db-dev',
    ])
  })

  it('searches by name fragment', () => {
    expect(graph.search({ nameContains: 'billing' }).map((e) => e.metadata.name)).toEqual([
      'billing-db-dev',
      'billing-api-billing-db-dev',
    ])
  })

  it('lists what an entity depends on', () => {
    expect(graph.dependenciesOf(refOf(db)).map((e) => e.metadata.name)).toEqual(['mysql-dev'])
  })

  it('lists what depends on an entity, from both directions of the declaration', () => {
    expect(graph.dependantsOf(refOf(db)).map((e) => e.metadata.name)).toEqual([
      'billing-api-billing-db-dev',
    ])
  })

  it('reports a dangling reference rather than resolving it to something plausible', () => {
    const orphan = resource('ghost-access', 'database-access', 'dev', ['resource:default/vanished'])
    expect(EntityGraph.from([orphan]).danglingReferences()).toEqual([
      { from: 'resource:default/ghost-access', to: 'resource:default/vanished' },
    ])
  })

  it('has no dangling reference in a consistent graph', () => {
    expect(EntityGraph.from([host, db, access, component]).danglingReferences()).toEqual([])
  })

  it('survives a reference cycle', () => {
    const a = resource('a', 'database', 'dev', ['resource:default/b'])
    const b = resource('b', 'database', 'dev', ['resource:default/a'])
    const cyclic = EntityGraph.from([a, b])
    expect(cyclic.dependenciesOf('resource:default/a').map((e) => e.metadata.name)).toEqual(['b'])
  })
})

describe('consumersOf', () => {
  const full = EntityGraph.from([host, db, access, component])

  it('reaches the component behind an access', () => {
    expect(full.consumersOf(refOf(db)).map((e) => e.metadata.name)).toEqual(['billing-api'])
  })

  it('reaches consumers of the host through the database', () => {
    expect(full.consumersOf(refOf(host)).map((e) => e.metadata.name)).toEqual(['billing-api'])
  })

  it('returns nothing for an entity nobody consumes', () => {
    expect(full.consumersOf('resource:default/absent')).toEqual([])
  })

  it('terminates on a cycle', () => {
    const a = resource('a', 'database', 'dev', ['resource:default/b'])
    const b = resource('b', 'database', 'dev', ['resource:default/a'])
    expect(EntityGraph.from([a, b]).consumersOf('resource:default/a')).toEqual([])
  })
})
