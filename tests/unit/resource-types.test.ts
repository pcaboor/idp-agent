import { describe, expect, it } from 'vitest'
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
