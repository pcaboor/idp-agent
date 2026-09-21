import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { summariseGraph } from '../../src/context/graph/summary.js'
import { formatSummary } from '../../src/agents/summary.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const load = async (): Promise<EntityGraph> =>
  EntityGraph.from((await new FixtureProvider(ROOT).load()).entities)

const database = (name: string, env: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name, annotations: { 'company.fr/env': env } },
  spec: { type: 'database', owner: 'group:default/tiger' },
})

describe('summariseGraph', () => {
  it('counts in buckets, never exactly', async () => {
    // An exact count would move every time a fixture is added, and moving the
    // prompt re-records every recording of every scenario.
    const { summary } = summariseGraph(await load())
    expect(summary.entities).toBe('10-99')
    expect(summary.components).toBe('1-9')
    expect(summary.resources).toBe('10-99')
  })

  it('covers the empty case and the large one', () => {
    expect(summariseGraph(EntityGraph.from([])).summary.entities).toBe('0')
    const many = Array.from({ length: 120 }, (_, index) => database(`db-${index}`, 'dev'))
    expect(summariseGraph(EntityGraph.from(many)).summary.entities).toBe('100+')
  })

  it('reports dangling references exactly, since that is a health fact and not a scale', () => {
    const orphan: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'ghost', annotations: {} },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/gone'],
      },
    }
    expect(summariseGraph(EntityGraph.from([orphan])).summary.danglingReferences).toBe(1)
    expect(summariseGraph(EntityGraph.from([])).summary.danglingReferences).toBe(0)
  })

  it('lists the closed vocabulary, sorted, and never an entity name', async () => {
    // The model may filter on these values; it may not be handed the catalogue.
    const { vocabulary } = summariseGraph(await load())
    expect(vocabulary.kinds).toEqual(['Component', 'Resource'])
    expect(vocabulary.environments).toEqual(['dev', 'prod', 'staging'])
    expect(vocabulary.types).toEqual([...vocabulary.types].sort())
    expect(vocabulary.owners).toEqual([...vocabulary.owners].sort())
    expect(JSON.stringify(vocabulary)).not.toContain('billing-db-prod')
  })

  it('omits an undeclared environment rather than inventing one', () => {
    const bare: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'x', annotations: {} },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    }
    expect(summariseGraph(EntityGraph.from([bare])).vocabulary.environments).toEqual([])
  })
})

describe('formatSummary', () => {
  const textOf = (graph: EntityGraph): string => {
    const { summary, vocabulary } = summariseGraph(graph)
    return formatSummary(summary, vocabulary)
  }

  it('does not move when an entity of a known type, env and owner is added', async () => {
    // This is the test that keeps every recording valid through stages 3 and 4.
    const before = textOf(await load())
    const after = textOf(EntityGraph.from([...(await load()).all(), database('another-db', 'prod')]))
    expect(after).toBe(before)
  })

  it('is byte-stable whatever order the provider loaded entities in', async () => {
    const forward = textOf(await load())
    const backward = textOf(EntityGraph.from([...(await load()).all()].reverse()))
    expect(backward).toBe(forward)
  })

  it('moves when a dangling reference appears, because that is what it must report', async () => {
    const broken: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'ghost', annotations: { 'company.fr/env': 'prod' } },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/gone'],
      },
    }
    expect(textOf(EntityGraph.from([...(await load()).all(), broken]))).not.toBe(
      textOf(await load()),
    )
  })

  it('states what it knows without naming a single entity', async () => {
    const text = textOf(await load())
    expect(text).toContain('entities: 10-99')
    expect(text).toContain('dangling references: 0')
    expect(text).not.toContain('billing-db-prod')
  })
})
