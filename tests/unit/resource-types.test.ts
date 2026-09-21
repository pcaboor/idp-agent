import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
import {
  RESOURCE_TYPE_NAMES,
  RESOURCE_TYPES,
  folderOf,
  natureOf,
} from '../../src/core/schemas/resource-types.js'

describe('resource type registry', () => {
  it('declares a nature and a folder for every type, in one place', () => {
    for (const name of RESOURCE_TYPE_NAMES) {
      const entry = RESOURCE_TYPES[name]
      expect(entry.nature === 'object' || entry.nature === 'right').toBe(true)
      expect(entry.folder.length).toBeGreaterThan(0)
    }
  })

  it('files objects under catalog/ and rights under dependencies/', () => {
    for (const name of RESOURCE_TYPE_NAMES) {
      const { nature, folder } = RESOURCE_TYPES[name]
      const expectedRoot = nature === 'object' ? 'catalog/' : 'dependencies/'
      expect(folder.startsWith(expectedRoot)).toBe(true)
    }
  })

  it('separates objects from rights', () => {
    expect(natureOf('database')).toBe('object')
    expect(natureOf('database-access')).toBe('right')
    expect(natureOf('gateway-route')).toBe('right')
  })

  it('exposes the folder of a type', () => {
    expect(folderOf('database')).toBe('catalog/databases')
    expect(folderOf('network-access')).toBe('dependencies/network')
  })
})

describe('the registry and the fixture SI', () => {
  it('every folder the registry declares exists in the fixtures, with a witness', async () => {
    // The fixture SI is a valid IaC repository, not a test-only shape: a folder
    // the registry knows and the repository lacks is exactly the hole the
    // one-witness-per-folder rule exists to make impossible (design 4.4).
    const missing: string[] = []
    for (const type of RESOURCE_TYPE_NAMES) {
      const folder = path.join(FIXTURES, folderOf(type))
      const entries = await readdir(folder).catch(() => undefined)
      if (entries === undefined) missing.push(`${folderOf(type)} (no folder)`)
      else if (!entries.includes('.witness.yml')) missing.push(`${folderOf(type)} (no witness)`)
    }
    expect(missing).toEqual([])
  })
})
