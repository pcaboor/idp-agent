import { describe, expect, it } from 'vitest'
import { checkRepository } from '../../src/core/validate/rules.js'
import type { RepositoryFile, RepositorySnapshot } from '../../src/core/validate/rules.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { parseDocuments } from '../../src/core/yaml/serialize.js'

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
  ignored: [],
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

  describe('over a repository that is also a Backstage catalogue', () => {
    /** A file as the one reader reads it, so these hold for real bytes. */
    const read = (path: string, ...documents: string[]): RepositoryFile => ({
      path,
      ...parseDocuments(documents.map((body) => `---\n${body}\n`).join('\n')),
    })
    const group = (name: string): string =>
      `apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata:\n  name: ${name}\nspec:\n  type: team\n  children: []`
    const api = 'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing-events'
    const billing =
      'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\n' +
      'spec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger'

    it('warns once per document it does not model, anchored on the file', () => {
      const violations = checkRepository(
        snapshot({ folders: ['org'], witnesses: [], files: [read('org/teams.yml', group('a'), group('b'))] }),
      )
      expect(violations).toEqual([
        {
          rule: 'not-modelled',
          file: 'org/teams.yml',
          severity: 'warning',
          message: 'kind Group is not modelled by this tool; group a left as is',
        },
        {
          rule: 'not-modelled',
          file: 'org/teams.yml',
          severity: 'warning',
          message: 'kind Group is not modelled by this tool; group b left as is',
        },
      ])
    })

    it('does not count a set-aside document as a second entity in its file', () => {
      // catalog-info.yaml holding a Component and the API it provides is the
      // most common shape there is. One of the two is this tool's entity.
      const violations = checkRepository(
        snapshot({
          folders: ['components'],
          witnesses: ['components'],
          files: [read('components/catalog-info.yaml', billing, api)],
        }),
      )
      expect(violations.map((violation) => violation.rule)).toEqual(['not-modelled'])
    })

    it('demands no witness from a folder holding only documents it does not model', () => {
      const violations = checkRepository(
        snapshot({ folders: ['org'], witnesses: [], files: [read('org/tiger.yml', group('tiger'))] }),
      )
      expect(violations.map((violation) => violation.rule)).toEqual(['not-modelled'])
    })

    it('does not call a reference dangling when the repository declares its target', () => {
      // The API is read and set aside, not absent: "nothing declares" beside a
      // warning naming that very API would contradict it.
      const consumer = billing + '\n  dependsOn:\n    - api:default/billing-events\n    - api:default/ghost'
      const violations = checkRepository(
        snapshot({
          folders: ['components'],
          witnesses: ['components'],
          files: [read('components/catalog-info.yaml', consumer, api)],
        }),
      )
      expect(violations.map((violation) => [violation.rule, violation.message])).toEqual([
        ['not-modelled', 'kind API is not modelled by this tool; api billing-events left as is'],
        ['dangling-reference', 'component:default/billing-api names api:default/ghost, which nothing declares'],
      ])
    })

    it('does not read a set-aside document as a duplicate of an entity of the same name', () => {
      const violations = checkRepository(
        snapshot({
          folders: ['components', 'apis'],
          witnesses: ['components'],
          files: [
            read('components/billing-api.yml', billing),
            read('apis/billing-api.yml', api.replace('billing-events', 'billing-api')),
          ],
        }),
      )
      expect(violations.map((violation) => violation.rule)).toEqual(['not-modelled'])
    })
  })
})
