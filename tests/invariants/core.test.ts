import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  arbitraryEntity,
  arbitraryHandWrittenFile,
  entityName,
  arbitraryPlan,
} from './arbitraries.js'
import { parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { signPlan } from '../../src/core/plan/sign.js'
import {
  insertDocument,
  listDocumentNames,
  removeDocument,
} from '../../src/core/yaml/surgery.js'
import { assertInsideRepo, resolveEntityPath } from '../../src/core/paths/entity-path.js'

const signatureContext = {
  witnessed: new Set<string>(),
  vocabulary: {
    kinds: ['Component', 'Resource'],
    types: ['database', 'cache', 'api', 'database-access', 'network-access'],
    environments: ['dev', 'staging', 'prod'],
    owners: ['group:default/tiger', 'group:default/common'],
  },
  repoRoot: '/repo',
  declared: new Map<string, string>(),
}

/** Counts terminal values the way the signer walks them. */
function countLeaves(value: unknown): number {
  if (value === null || typeof value !== 'object') return 1
  if (typeof value === 'object' && value !== null && 'unknown' in value) return 1
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countLeaves(v), 0)
  return Object.values(value).reduce((n: number, v) => n + countLeaves(v), 0)
}

describe('invariants', () => {
  it('serialise then reload yields the same entity', () => {
    fc.assert(
      fc.property(arbitraryEntity, (entity) => {
        expect(parseEntity(serializeEntity(entity))).toEqual(entity)
      }),
    )
  })

  it('insert then remove yields the file byte for byte', () => {
    // The file is hand-written on purpose. Building it with insertDocument would
    // make this vacuous: the input would already be normalised by the code under
    // test, and a parse-and-restringify implementation would pass.
    fc.assert(
      fc.property(arbitraryHandWrittenFile, arbitraryEntity, (file, entity) => {
        fc.pre(!listDocumentNames(file).includes(entity.metadata.name))
        const grown = insertDocument(file, serializeEntity(entity))
        expect(removeDocument(grown, entity.metadata.name)).toBe(file)
      }),
    )
  })

  it('removing a document that is not there changes nothing', () => {
    fc.assert(
      fc.property(arbitraryHandWrittenFile, entityName, (file, name) => {
        fc.pre(!listDocumentNames(file).includes(name))
        expect(removeDocument(file, name)).toBe(file)
      }),
    )
  })

  it('every inserted document is listed, in order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryEntity, { maxLength: 5, selector: (e) => e.metadata.name }),
        (entities) => {
          const file = entities.reduce(
            (acc, entity) => insertDocument(acc, serializeEntity(entity)),
            '',
          )
          expect(listDocumentNames(file)).toEqual(entities.map((e) => e.metadata.name))
        },
      ),
    )
  })

  it('every leaf of a signed plan is classified', () => {
    // Total over leaves, not over references: a Plan carries invented values,
    // so the read-side membership test has nothing to test against. A field
    // that escaped by being nested is a field nobody vouched for.
    fc.assert(
      fc.property(arbitraryPlan, (draft) => {
        const parsed = planSchema.safeParse(draft)
        if (!parsed.success) return
        const result = signPlan(parsed.data, signatureContext)
        if ('outcome' in result) return
        expect(result.classified.length).toBe(countLeaves(result.plan.operations))
      }),
    )
  })

  it('every path a signature produces stays inside the repository', () => {
    fc.assert(
      fc.property(arbitraryPlan, (draft) => {
        const parsed = planSchema.safeParse(draft)
        if (!parsed.success) return
        const result = signPlan(parsed.data, signatureContext)
        if ('outcome' in result) return
        for (const produced of result.paths.values()) {
          expect(assertInsideRepo('/repo', produced).startsWith('/repo/')).toBe(true)
        }
      }),
    )
  })

  it('every computed path stays inside the repository', () => {
    fc.assert(
      fc.property(arbitraryEntity, (entity) => {
        const resolved = assertInsideRepo('/repo', resolveEntityPath(entity))
        expect(resolved.startsWith('/repo/')).toBe(true)
      }),
    )
  })
})
