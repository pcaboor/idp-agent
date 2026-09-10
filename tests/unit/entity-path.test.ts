import { describe, expect, it } from 'vitest'
import {
  PathEscapeError,
  assertInsideRepo,
  computeEntityPath,
  resolveEntityPath,
} from '../../src/core/paths/entity-path.js'
import { SOURCE_FILE_ANNOTATION, type Entity } from '../../src/core/schemas/entity.js'

const resource = (annotations: Record<string, string>): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'billing-db-dev', annotations },
  spec: { type: 'database', owner: 'group:default/tiger' },
})

describe('computeEntityPath', () => {
  it('files one entity per file, in one folder per nature', () => {
    expect(computeEntityPath('database', 'billing-db-dev')).toBe(
      'catalog/databases/billing-db-dev.yml',
    )
    expect(computeEntityPath('database-access', 'a-b')).toBe('dependencies/access/a-b.yml')
    expect(computeEntityPath('network-access', 'a-b')).toBe('dependencies/network/a-b.yml')
  })

  it('refuses a name carrying a path separator', () => {
    expect(() => computeEntityPath('database', '../../etc/passwd')).toThrow(PathEscapeError)
    expect(() => computeEntityPath('database', 'a/b')).toThrow(PathEscapeError)
  })

  it('refuses a name starting with a dot', () => {
    expect(() => computeEntityPath('database', '.hidden')).toThrow(PathEscapeError)
  })

  it('accepts dots inside a name, which cannot traverse', () => {
    expect(computeEntityPath('database', 'a..b')).toBe('catalog/databases/a..b.yml')
  })
})

describe('resolveEntityPath', () => {
  it('reads the location from the entity when the annotation is present', () => {
    const entity = resource({ [SOURCE_FILE_ANNOTATION]: 'legacy/all-databases.yml' })
    expect(resolveEntityPath(entity)).toBe('legacy/all-databases.yml')
  })

  it('falls back to the convention when the annotation is absent or empty', () => {
    expect(resolveEntityPath(resource({}))).toBe('catalog/databases/billing-db-dev.yml')
    expect(resolveEntityPath(resource({ [SOURCE_FILE_ANNOTATION]: '' }))).toBe(
      'catalog/databases/billing-db-dev.yml',
    )
  })

  it('refuses an annotation that traverses out of the repository', () => {
    const entity = resource({ [SOURCE_FILE_ANNOTATION]: '../../../etc/passwd' })
    expect(() => resolveEntityPath(entity)).toThrow(PathEscapeError)
  })

  it('refuses an absolute annotation', () => {
    const entity = resource({ [SOURCE_FILE_ANNOTATION]: '/etc/passwd' })
    expect(() => resolveEntityPath(entity)).toThrow(PathEscapeError)
  })

  it('refuses to place a Component by convention', () => {
    const component: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'billing-api', annotations: {} },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    }
    expect(() => resolveEntityPath(component)).toThrow(/own repository/)
  })
})

describe('assertInsideRepo', () => {
  it('accepts a path inside the repository', () => {
    expect(assertInsideRepo('/repo', 'catalog/databases/x.yml')).toBe(
      '/repo/catalog/databases/x.yml',
    )
  })

  it('normalises a path that leaves and comes back', () => {
    expect(assertInsideRepo('/repo', 'catalog/../catalog/x.yml')).toBe('/repo/catalog/x.yml')
  })

  it('refuses a traversal escape', () => {
    expect(() => assertInsideRepo('/repo', '../../etc/passwd')).toThrow(PathEscapeError)
  })

  it('refuses an absolute path', () => {
    expect(() => assertInsideRepo('/repo', '/etc/passwd')).toThrow(PathEscapeError)
  })

  it('refuses a sibling directory sharing the prefix', () => {
    expect(() => assertInsideRepo('/repo', '../repo-evil/x.yml')).toThrow(PathEscapeError)
  })

  it('refuses the repository root itself, which is not a file', () => {
    expect(() => assertInsideRepo('/repo', '')).toThrow(PathEscapeError)
    expect(() => assertInsideRepo('/repo', '.')).toThrow(PathEscapeError)
  })

  it('refuses a null byte, which truncates a path in a syscall', () => {
    const poisoned = 'catalog/x' + String.fromCharCode(0) + '.yml'
    expect(() => assertInsideRepo('/repo', poisoned)).toThrow(PathEscapeError)
  })
})
