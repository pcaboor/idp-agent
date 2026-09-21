import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { runGraph } from '../../src/cli/commands/graph.js'
import { runShow } from '../../src/cli/commands/show.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const load = async (): Promise<EntityGraph> =>
  EntityGraph.from((await new FixtureProvider(ROOT).load()).entities)

describe('graph', () => {
  it('summarises the whole SI', async () => {
    const output = runGraph(await load(), {})
    expect(output).toContain('billing-db-dev')
    expect(output).toContain('NAME')
  })

  it('filters by environment', async () => {
    const output = runGraph(await load(), { env: 'prod' })
    expect(output).toContain('billing-db-prod')
    expect(output).not.toContain('billing-db-dev')
  })

  it('reports when a filter matches nothing, rather than printing an empty table', async () => {
    expect(runGraph(await load(), { env: 'nowhere' })).toContain('No entity matches')
  })

  it('surfaces a dangling reference under the table', () => {
    const orphan = EntityGraph.from([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Resource',
        metadata: { name: 'ghost', annotations: {} },
        spec: { type: 'database-access', owner: 'group:default/tiger', dependsOn: ['resource:default/gone'] },
      },
    ])
    expect(runGraph(orphan, {})).toContain('dangling reference')
  })
})

describe('show', () => {
  it('accepts a bare name as well as a full reference', async () => {
    const graph = await load()
    expect(runShow(graph, 'billing-db-dev')).toContain('resource:default/billing-db-dev')
    expect(runShow(graph, 'resource:default/billing-db-dev')).toContain('database')
  })

  it('names the services that reach a database', async () => {
    expect(runShow(await load(), 'billing-db-prod')).toContain('billing-api')
  })

  it('lists the candidates when a name is ambiguous', async () => {
    const output = runShow(await load(), 'billing')
    expect(output).toMatch(/matches \d+ entities/)
    expect(output).toContain('billing-db-dev')
    expect(output).toContain('billing-db-prod')
  })

  it('says so when nothing matches', async () => {
    expect(runShow(await load(), 'no-such-thing')).toContain('No entity named')
  })

  it('names the accesses a service depends on, declared from the access side', async () => {
    const output = runShow(await load(), 'billing-api')
    expect(output).toContain('billing-api-billing-db-prod')
    expect(output).toContain('billing-api-cache-dev')
  })

  it('does not say a service depends on nothing while a database says it is reached by it', async () => {
    const graph = await load()
    expect(runShow(graph, 'billing-db-prod')).toContain('billing-api')
    expect(runShow(graph, 'billing-api')).not.toMatch(/depends on\n\s+none/)
  })
})
