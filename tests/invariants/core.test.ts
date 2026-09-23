import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  arbitraryEntity,
  arbitraryHandWrittenFile,
  entityName,
  arbitraryPlan,
} from './arbitraries.js'
import { parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import { entitySchema } from '../../src/core/schemas/entity.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { signPlan } from '../../src/core/plan/sign.js'
import {
  appendSequenceItem,
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
  answered: new Set<string>(),
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

  it('insert then append then remove yields the file byte for byte', () => {
    // Appending reaches only inside the document it was aimed at: whatever line
    // it added leaves with that document, and the hand-written neighbours come
    // back exactly as they were. Same reason the file is not built with
    // insertDocument — a normalised input would make this vacuous.
    fc.assert(
      fc.property(
        arbitraryHandWrittenFile,
        arbitraryEntity,
        entityName,
        (file, entity, consumer) => {
          fc.pre(!listDocumentNames(file).includes(entity.metadata.name))
          const grown = insertDocument(file, serializeEntity(entity))
          const amended = appendSequenceItem(
            grown,
            entity.metadata.name,
            'dependencyOf',
            `component:default/${consumer}`,
          )
          // Without this the property would hold for a function that returned
          // its argument, which is exactly the failure mode it must exclude.
          expect(amended).not.toBe(grown)
          expect(removeDocument(amended, entity.metadata.name)).toBe(file)
        },
      ),
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

/**
 * The generators, asserted on rather than assumed.
 *
 * A generator that never produces a field makes every property over it vacuous:
 * "serialise then reload yields the same entity" holds just as well for a
 * serialiser that drops `spec.access` on the floor, and "every leaf of a signed
 * plan is classified" for a signer that never saw one. §4.1 added the field, so
 * the generators have to carry it, and this is what says they do.
 *
 * Sampled at a fixed seed because the coverage IS the assertion — a property
 * would be asserting the same silence. What this does NOT assert is a
 * distribution: how often fast-check reaches a level is its business, and one
 * in a sample is all it takes to stop a property being vacuous.
 */
describe('the generators cover the level a grant states', () => {
  it('puts one on a right and never on an object', () => {
    const sample = fc.sample(arbitraryEntity, { numRuns: 200, seed: 1 })

    // The nature rule lives in `resourceSchema.superRefine`, so an entity
    // generated with a level on a database is one the tool cannot hold — and
    // every property above it would be asserting something about a shape that
    // never reaches disk.
    for (const entity of sample) expect(entitySchema.safeParse(entity).success).toBe(true)

    expect(
      sample.some((entity) => entity.kind === 'Resource' && entity.spec.access !== undefined),
    ).toBe(true)
    // Both halves of the optionality, or the generator covers one shape and
    // calls it the field: an access written before this field exists states no
    // level, and that is the common case in a real repository.
    expect(
      sample.some((entity) => entity.kind === 'Resource' && entity.spec.access === undefined),
    ).toBe(true)
  })

  it('lets a proposal state one, or say it cannot determine it', () => {
    const levels = fc
      .sample(arbitraryPlan, { numRuns: 200, seed: 1 })
      .flatMap((plan) => plan.operations.map((operation) => operation.entity.spec.access))

    expect(levels.some((level) => level === 'read' || level === 'readwrite')).toBe(true)
    // §5.4: a field the model CHOOSES is a value or `{unknown}`, and this is
    // the one where filling in a plausible value hands out write. A generator
    // that only ever states a level never signs the question.
    expect(
      levels.some(
        (level) => typeof level === 'object' && level !== null && 'unknown' in level,
      ),
    ).toBe(true)
  })
})
