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

  it('reads several documents from one file', async () => {
    const multi = path.resolve(import.meta.dirname, '../golden/multi-doc')
    const { entities } = await new FixtureProvider(multi).load()
    expect(entities.map((entity) => entity.metadata.name)).toEqual(['first', 'second'])
  })

  it('ignores a witness file, which declares nothing', async () => {
    const { rejected } = await new FixtureProvider(ROOT).load()
    expect(rejected.filter((r) => r.source.includes('witness'))).toEqual([])
  })
})
