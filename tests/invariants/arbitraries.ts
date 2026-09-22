import fc from 'fast-check'
import { RESOURCE_TYPE_NAMES } from '../../src/core/schemas/resource-types.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { serializeEntity } from '../../src/core/yaml/serialize.js'
import { insertDocument } from '../../src/core/yaml/surgery.js'

const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
const middle = [...alnum, '-', '.', '_']

/** Built valid by construction rather than filtered, so no run is wasted. */
export const entityName = fc
  .tuple(
    fc.constantFrom(...alnum),
    fc.array(fc.constantFrom(...middle), { maxLength: 18 }),
    fc.constantFrom(...alnum),
  )
  .map(([first, body, last]) => first + body.join('') + last)

const LF = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

/** Strings a YAML emitter is tempted to write unquoted, plus ordinary text. */
const annotationValue = fc.oneof(
  fc.constantFrom(
    'no',
    'yes',
    'on',
    'off',
    'y',
    'n',
    'true',
    'false',
    '123',
    '1.0',
    '0755',
    '~',
    'null',
    '*star',
    '&anchor',
    'key: value',
    'value # not a comment',
    '  padded  ',
    '',
    'cafe naive',
    '---',
    `line one${LF}line two`,
    `a${TAB}tab`,
  ),
  fc.string({ maxLength: 24 }),
)

export const arbitraryEntity: fc.Arbitrary<Entity> = fc.record({
  apiVersion: fc.constant('backstage.io/v1alpha1' as const),
  kind: fc.constant('Resource' as const),
  metadata: fc.record({
    name: entityName,
    annotations: fc.dictionary(
      fc.constantFrom('company.fr/env', 'team', 'note', 'idp-agent.dev/origin'),
      annotationValue,
      { maxKeys: 3 },
    ),
  }),
  spec: fc.record({
    type: fc.constantFrom(...RESOURCE_TYPE_NAMES),
    owner: entityName.map((group) => `group:default/${group}`),
  }),
})

/** Files built the way the tool builds them: one document per entity. */
export const arbitraryFile = fc
  .uniqueArray(arbitraryEntity, {
    minLength: 0,
    maxLength: 4,
    selector: (entity) => entity.metadata.name,
  })
  .map((entities) =>
    entities.reduce((file, entity) => insertDocument(file, serializeEntity(entity)), ''),
  )

/**
 * Files as a human left them, not as this tool would write them: comments,
 * keys in another order, an extra blank line.
 *
 * Generating them with insertDocument instead would make every byte-for-byte
 * property vacuous — the file would already be normalised by the very code
 * under test, and any self-consistent implementation would pass.
 */
export const arbitraryHandWrittenFile = fc
  .uniqueArray(
    fc.record({
      name: entityName,
      comment: fc.boolean(),
      reversedKeys: fc.boolean(),
      padded: fc.boolean(),
    }),
    { minLength: 0, maxLength: 4, selector: (spec) => spec.name },
  )
  .map((specs) =>
    specs
      .map((spec) => {
        const body = spec.reversedKeys
          ? [
              'kind: Resource',
              'apiVersion: backstage.io/v1alpha1',
              'spec:',
              "  owner: group:default/legacy",
              '  type: database',
              'metadata:',
              `  name: ${spec.name}`,
            ]
          : [
              'apiVersion: backstage.io/v1alpha1',
              'kind: Resource',
              'metadata:',
              `  name: ${spec.name}`,
              spec.padded ? '  description: kept as written' : '  description: kept',
              'spec:',
              '  type: database',
              "  owner: group:default/legacy",
            ]
        const header = spec.comment ? [`# hand written note about ${spec.name}`] : []
        return [...header, '---', ...body, ''].join('\n')
      })
      .join('\n'),
  )

/**
 * A proposal, not an entity read from disk. Generated against the strict
 * schemas so a property can assert something about every plan the model is
 * allowed to emit — including the nested and the awkward.
 */
export const arbitraryProposal = fc.record({
  kind: fc.constant('Resource' as const),
  metadata: fc.record({
    name: entityName,
    env: fc.constantFrom('dev', 'staging', 'prod'),
  }),
  spec: fc.record({
    type: fc.constantFrom('database', 'cache', 'api', 'database-access', 'network-access'),
    owner: fc.constantFrom('group:default/tiger', 'group:default/common', 'group:default/ghost'),
  }),
})

export const arbitraryPlan = fc.record({
  intent: fc.string({ minLength: 1, maxLength: 120 }),
  operations: fc
    .array(
      arbitraryProposal.map((entity) => ({ op: 'create-entity' as const, entity })),
      { minLength: 1, maxLength: 5 },
    ),
})
