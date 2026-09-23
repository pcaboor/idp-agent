import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

describe('FixtureProvider', () => {
  it('loads every entity in the fixture SI', async () => {
    const { entities, rejected } = await new FixtureProvider(ROOT).load()
    expect(rejected).toEqual([])
    expect(entities.length).toBeGreaterThanOrEqual(28)
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
