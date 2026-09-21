import { describe, expect, it } from 'vitest'
import { checkRepository } from '../../src/core/validate/rules.js'
import type { RepositoryFile, RepositorySnapshot } from '../../src/core/validate/rules.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const database = (name: string, spec: Record<string, unknown> = {}): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name, annotations: {} },
  spec: { type: 'database', owner: 'group:default/tiger', ...spec },
})

const component = (name: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, annotations: {} },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
})

const file = (path: string, entities: Entity[], over: Partial<RepositoryFile> = {}): RepositoryFile => ({
  path,
  entities,
  rejections: [],
  documents: entities.length,
  ...over,
})

const snapshot = (over: Partial<RepositorySnapshot> = {}): RepositorySnapshot => ({
  folders: ['catalog/databases'],
  witnesses: ['catalog/databases'],
  files: [],
  ...over,
})

describe('checkRepository', () => {
  it('accepts a repository that conforms', () => {
    const clean = snapshot({ files: [file('catalog/databases/a.yml', [database('a')])] })
    expect(checkRepository(clean)).toEqual([])
  })

  it('refuses two files declaring the same name, and names both', () => {
    // The catalogue ingests a duplicate in silence and lets the first source
    // win (design 4.4). Naming one file would leave the reader hunting for
    // the other, which is the whole difficulty of the bug.
    const violations = checkRepository(
      snapshot({
        files: [
          file('catalog/databases/a.yml', [database('a')]),
          file('catalog/databases/copy.yml', [database('a')]),
        ],
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.rule).toBe('duplicate-name')
    expect(violations[0]?.severity).toBe('error')
    expect(violations[0]?.message).toContain('a.yml')
    expect(violations[0]?.message).toContain('copy.yml')
  })

  it('allows the same name under two different kinds', () => {
    // A Component and a Resource called the same thing are two entities, and
    // their references differ. Only the reference has to be unique.
    const violations = checkRepository(
      snapshot({
        folders: ['catalog/databases', 'components'],
        witnesses: ['catalog/databases', 'components'],
        files: [
          file('catalog/databases/billing.yml', [database('billing')]),
          file('components/billing.yml', [component('billing')]),
        ],
      }),
    )
    expect(violations).toEqual([])
  })

  it('reports an entity Zod refused, instead of passing over the file', () => {
    const violations = checkRepository(
      snapshot({
        files: [file('catalog/databases/x.yml', [], { rejections: ['owner is required'], documents: 1 })],
      }),
    )
    expect(violations[0]?.rule).toBe('invalid-entity')
    expect(violations[0]?.severity).toBe('error')
    expect(violations[0]?.message).toContain('owner')
  })

  it('refuses two entities in one file', () => {
    // One file per entity: two concurrent declarations must never write the
    // same file (design 4.3).
    const violations = checkRepository(
      snapshot({ files: [file('catalog/databases/two.yml', [database('a'), database('b')])] }),
    )
    expect(violations.map((violation) => violation.rule)).toContain('multiple-entities')
  })

  it('refuses a folder that holds entities and has no witness', () => {
    const violations = checkRepository(
      snapshot({ witnesses: [], files: [file('catalog/databases/a.yml', [database('a')])] }),
    )
    expect(violations[0]?.rule).toBe('missing-witness')
    expect(violations[0]?.file).toBe('catalog/databases')
  })

  it('does not demand a witness from a folder that holds no entity', () => {
    // schemas/ and .github/ are folders too. The rule is about where entities
    // live, not about every directory in the repository.
    const violations = checkRepository(snapshot({ folders: ['schemas'], witnesses: [], files: [] }))
    expect(violations).toEqual([])
  })

  it('refuses an entity filed somewhere other than where it belongs', () => {
    const violations = checkRepository(
      snapshot({
        folders: ['catalog/caches'],
        witnesses: ['catalog/caches'],
        files: [file('catalog/caches/a.yml', [database('a')])],
      }),
    )
    expect(violations[0]?.rule).toBe('misplaced-entity')
    expect(violations[0]?.message).toContain('catalog/databases')
  })

  it('leaves a Component alone, since it has no conventional location', () => {
    // resolveEntityPath throws for a Component — it lives in its own
    // repository. A naive misplacement rule crashes on all five fixture
    // Components, and this is the guard that stops it.
    const violations = checkRepository(
      snapshot({
        folders: ['components'],
        witnesses: ['components'],
        files: [file('components/billing-api.yml', [component('billing-api')])],
      }),
    )
    expect(violations).toEqual([])
  })

  it('warns on a dangling reference rather than erroring', () => {
    // Reported, never pruned (design 4.4). But a repository mid-migration is
    // not broken, and turning CI red here would push people to delete the
    // declaration — which is the one thing that rule forbids.
    const violations = checkRepository(
      snapshot({
        files: [
          file('catalog/databases/a.yml', [database('a', { dependsOn: ['resource:default/gone'] })]),
        ],
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.rule).toBe('dangling-reference')
    expect(violations[0]?.severity).toBe('warning')
    expect(violations[0]?.message).toContain('resource:default/gone')
  })

  it('does not call a resolved reference dangling', () => {
    const violations = checkRepository(
      snapshot({
        files: [
          file('catalog/databases/a.yml', [database('a', { dependsOn: ['resource:default/b'] })]),
          file('catalog/databases/b.yml', [database('b')]),
        ],
      }),
    )
    expect(violations).toEqual([])
  })

  it('puts errors before warnings, and orders each by file', () => {
    const violations = checkRepository(
      snapshot({
        files: [
          file('catalog/databases/z.yml', [database('z', { dependsOn: ['resource:default/gone'] })]),
          file('catalog/databases/a.yml', [database('a'), database('b')]),
        ],
      }),
    )
    expect(violations.map((violation) => violation.severity)).toEqual(['error', 'warning'])
  })
})
