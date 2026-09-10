import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  arbitraryEntity,
  arbitraryHandWrittenFile,
  entityName,
} from './arbitraries.js'
import { parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import {
  insertDocument,
  listDocumentNames,
  removeDocument,
} from '../../src/core/yaml/surgery.js'
import { assertInsideRepo, resolveEntityPath } from '../../src/core/paths/entity-path.js'

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

  it('every computed path stays inside the repository', () => {
    fc.assert(
      fc.property(arbitraryEntity, (entity) => {
        const resolved = assertInsideRepo('/repo', resolveEntityPath(entity))
        expect(resolved.startsWith('/repo/')).toBe(true)
      }),
    )
  })
})
