import { describe, expect, it } from 'vitest'
import { paintDiff } from '../../src/cli/render/diff.js'
import { renderTable } from '../../src/cli/render/table.js'
import { renderEntityDetail } from '../../src/cli/render/entity.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import type { Entity } from '../../src/core/schemas/entity.js'

describe('renderTable', () => {
  it('aligns columns to the widest cell', () => {
    // Asserting the exact run of spaces would mean counting them by hand and
    // getting it wrong; assert the alignment itself.
    const lines = renderTable(['NAME', 'ENV'], [['a', 'dev'], ['longer-name', 'prod']]).split('\n')
    expect(lines).toHaveLength(3)
    const column = lines[0]?.indexOf('ENV')
    expect(lines[1]?.indexOf('dev')).toBe(column)
    expect(lines[2]?.indexOf('prod')).toBe(column)
    expect(lines[2]?.startsWith('longer-name  ')).toBe(true)
  })

  it('renders headers alone when there are no rows', () => {
    expect(renderTable(['NAME'], [])).toBe('NAME')
  })

  it('never pads the last column, so no line carries trailing space', () => {
    const output = renderTable(['A', 'B'], [['x', 'y']])
    expect(output.split('\n').every((line) => line === line.trimEnd())).toBe(true)
  })
})

describe('renderEntityDetail', () => {
  const db: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name: 'billing-db-dev', annotations: { 'company.fr/env': 'dev' } },
    spec: { type: 'database', owner: 'group:default/tiger' },
  }

  it('states what is known', () => {
    const output = renderEntityDetail(EntityGraph.from([db]), db)
    expect(output).toContain('billing-db-dev')
    expect(output).toContain('database')
    expect(output).toContain('group:default/tiger')
    expect(output).toContain('dev')
  })

  it('says an environment is undeclared rather than guessing one', () => {
    const bare: Entity = { ...db, metadata: { name: 'x', annotations: {} } }
    expect(renderEntityDetail(EntityGraph.from([bare]), bare)).toContain('undeclared')
  })

  it('states the environment of every resource it lists, since dev and prod are two rights', () => {
    // A service lists accesses from several environments at once, and being
    // authorised in dev grants nothing in prod (design 4.1). Reading it off the
    // name would be reading a convention instead of the declaration.
    const service: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'billing-api', annotations: {} },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    }
    const accessIn = (env: string): Entity => ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: `billing-api-db-${env}`, annotations: { 'company.fr/env': env } },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        dependencyOf: ['component:default/billing-api'],
      },
    })
    const graph = EntityGraph.from([service, accessIn('dev'), accessIn('prod')])
    const listed = renderEntityDetail(graph, service)
      .split('\n')
      .filter((line) => line.includes('billing-api-db-'))

    expect(listed).toHaveLength(2)
    expect(listed[0]?.endsWith('dev')).toBe(true)
    expect(listed[1]?.endsWith('prod')).toBe(true)
  })
})

describe('paintDiff', () => {
  const RED = '\u001B[31m'
  const BOLD = '\u001B[1m'

  it('paints a removed document marker as a removal, not as a file header', () => {
    // Every entity document in this repository starts with `---`, so a removed
    // one is `----`: four dashes. Testing `startsWith('---')` claimed it as a
    // file header and painted it bold — the likeliest removal line there is,
    // shown as though the header itself had changed.
    const painted = paintDiff('--- a/x.yml\n+++ b/x.yml\n@@ -1,1 +0,0 @@\n----\n', true)
    const lines = painted.split('\n')

    expect(lines[0]?.startsWith(BOLD)).toBe(true)
    expect(lines[3]?.startsWith(RED)).toBe(true)
  })

  it('still paints the file headers bold', () => {
    const painted = paintDiff('--- /dev/null\n+++ b/x.yml\n', true)

    expect(painted.split('\n')[0]?.startsWith(BOLD)).toBe(true)
  })
})
