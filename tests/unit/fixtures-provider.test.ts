import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

describe('FixtureProvider', () => {
  it('loads every entity in the fixture SI', async () => {
    const { entities, rejected, ignored } = await new FixtureProvider(ROOT).load()
    expect(rejected).toEqual([])
    expect(ignored).toEqual([])
    expect(entities.length).toBeGreaterThanOrEqual(28)
  })

  it('sets aside a document it does not model rather than refusing it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fixture-foreign-'))
    await writeFile(path.join(root, 'mkdocs.yml'), 'site_name: Demo\n')
    await writeFile(
      path.join(root, 'billing.yml'),
      'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing-events\n',
    )

    const { entities, rejected, ignored } = await new FixtureProvider(root).load()

    expect(entities).toEqual([])
    expect(rejected).toEqual([])
    expect(ignored).toEqual([
      {
        source: 'billing.yml',
        kind: 'API',
        ref: 'api:default/billing-events',
        reason: 'kind API is not modelled by this tool; api billing-events left as is',
      },
      { source: 'mkdocs.yml', reason: 'not a catalogue entity: no apiVersion or kind' },
    ])
  })

  it('reports an invalid entity instead of dropping it silently', async () => {
    const broken = path.resolve(import.meta.dirname, '../golden/broken-si')
    const { entities, rejected } = await new FixtureProvider(broken).load()
    expect(entities).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.source).toContain('invalid.yml')
    expect(rejected[0]?.reason).toMatch(/group|user/)
  })

  it('does not read a hidden directory as catalogue', async () => {
    // The provider reads a directory laid out as an IaC repository, and a real
    // one has .github/workflows. Those are YAML and are not entities.
    const { rejected } = await new FixtureProvider(ROOT).load()
    expect(rejected.filter((r) => r.source.includes('.github'))).toEqual([])
  })

  it('reads several documents from one file', async () => {
    const multi = path.resolve(import.meta.dirname, '../golden/multi-doc')
    const { entities } = await new FixtureProvider(multi).load()
    expect(entities.map((entity) => entity.metadata.name)).toEqual(['first', 'second'])
  })

  it('reads a right that states the level it grants and one that states none', async () => {
    // Both shapes are on disk, so this is a fact about files rather than about
    // a hand-built object. A database-access says read or readwrite; a network
    // route states no level at all, which is why the field is optional — a
    // required one would make every access ever written invalid, this
    // repository's included.
    const { entities, rejected } = await new FixtureProvider(ROOT).load()
    expect(rejected).toEqual([])

    const specOf = (name: string) => {
      const found = entities.find((entity) => entity.metadata.name === name)
      return found?.kind === 'Resource' ? found.spec : undefined
    }
    // The same database, granted twice at two levels: billing-api writes it,
    // the reporting worker only reads it. That distinction was unwritable
    // before this field and is the whole of what it buys.
    expect(specOf('billing-api-billing-db-prod')?.access).toBe('readwrite')
    expect(specOf('reporting-billing-db-prod')?.access).toBe('read')
    expect(specOf('billing-api-to-payments')).not.toHaveProperty('access')
  })

  it('ignores a witness file, which declares nothing', async () => {
    const { rejected } = await new FixtureProvider(ROOT).load()
    expect(rejected.filter((r) => r.source.includes('witness'))).toEqual([])
  })
})

describe('FixtureProvider, over a document the parser has refused', () => {
  it('reports a duplicate key instead of loading the last value', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fixtures-dup-'))
    await writeFile(
      path.join(root, 'twice.yml'),
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: twice',
        'spec:',
        '  type: database',
        '  owner: group:default/tiger',
        '  owner: group:default/lion',
        '',
      ].join('\n'),
    )
    const { entities, rejected } = await new FixtureProvider(root).load()
    expect(entities).toEqual([])
    expect(rejected).toEqual([{ source: 'twice.yml', reason: expect.stringContaining('DUPLICATE_KEY') }])
  })
})
