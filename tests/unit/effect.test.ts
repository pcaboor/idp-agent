import { describe, expect, it } from 'vitest'
import { appendedOnly, insertedOnly } from '../../src/core/plan/effect.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { serializeEntity } from '../../src/core/yaml/serialize.js'

/**
 * The "and nothing else" half of the post-condition, on hand-built pairs.
 *
 * The surgery is right for every shape the property test generates, so these
 * checks never fire there: a later change that weakened one would pass the
 * whole suite. Each pair below is a wrong result the surgery does not produce
 * today, stated so that the check which catches it cannot be removed unseen.
 */

const REF = 'resource:default/grant-a'
const CONSUMER = 'component:default/billing-api'

const grant = (name: string, consumers: readonly string[], owner = 'group:default/tiger') =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    `  name: ${name}`,
    'spec:',
    '  type: database-access',
    `  owner: ${owner}`,
    ...(consumers.length > 0 ? ['  dependencyOf:', ...consumers.map((one) => `    - ${one}`)] : []),
    '',
  ].join('\n')

const file = (...documents: string[]) => documents.join('\n')

const BEFORE = file(grant('grant-a', ['component:default/checkout']), grant('grant-b', []))

describe('appendedOnly', () => {
  it('holds for the consumer appended and nothing else', () => {
    const after = file(
      grant('grant-a', ['component:default/checkout', CONSUMER]),
      grant('grant-b', []),
    )
    expect(appendedOnly(BEFORE, after, REF, CONSUMER)).toBeUndefined()
  })

  it('refuses a result that also changed another document', () => {
    const after = file(
      grant('grant-a', ['component:default/checkout', CONSUMER]),
      grant('grant-b', [], 'group:default/lion'),
    )
    expect(appendedOnly(BEFORE, after, REF, CONSUMER)).toBe(
      'the result changes another document in the file',
    )
  })

  it('refuses a result that also changed another field of the target', () => {
    const after = file(
      grant('grant-a', ['component:default/checkout', CONSUMER], 'group:default/lion'),
      grant('grant-b', []),
    )
    expect(appendedOnly(BEFORE, after, REF, CONSUMER)).toBe(
      `the result changes more of ${REF} than its consumers`,
    )
  })

  it('refuses a result that listed the consumer twice', () => {
    const after = file(
      grant('grant-a', ['component:default/checkout', CONSUMER, CONSUMER]),
      grant('grant-b', []),
    )
    expect(appendedOnly(BEFORE, after, REF, CONSUMER)).toBe(
      `the result changes more of ${REF} than its consumers`,
    )
  })

  it('refuses a result that gained a document', () => {
    const after = file(
      grant('grant-a', ['component:default/checkout', CONSUMER]),
      grant('grant-b', []),
      grant('grant-c', []),
    )
    expect(appendedOnly(BEFORE, after, REF, CONSUMER)).toBe(
      `the result does not declare ${REF} where the file did`,
    )
  })

  it('refuses a result that lost a document', () => {
    const after = grant('grant-a', ['component:default/checkout', CONSUMER])
    expect(appendedOnly(BEFORE, after, REF, CONSUMER)).toBe(
      `the result does not declare ${REF} where the file did`,
    )
  })

  it('refuses a result that listed the consumer on another document', () => {
    const after = file(
      grant('grant-a', ['component:default/checkout']),
      grant('grant-b', [CONSUMER]),
    )
    expect(appendedOnly(BEFORE, after, REF, CONSUMER)).toBe(
      `the result does not list ${CONSUMER} under ${REF}`,
    )
  })
})

describe('insertedOnly', () => {
  const entity: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name: 'grant-c', annotations: {} },
    spec: { type: 'database-access', owner: 'group:default/tiger', dependencyOf: [CONSUMER] },
  }
  const added = `---\n${serializeEntity(entity)}`

  it('holds for one more document, reading back as the entity', () => {
    expect(insertedOnly(BEFORE, file(BEFORE, added), entity)).toBeUndefined()
  })

  it('refuses a result that also changed a document already in the file', () => {
    const changed = file(
      grant('grant-a', ['component:default/checkout'], 'group:default/lion'),
      grant('grant-b', []),
    )
    expect(insertedOnly(BEFORE, file(changed, added), entity)).toBe(
      'the result changes a document that was already in the file',
    )
  })

  it('refuses an added document that is not the entity', () => {
    const other = `---\n${serializeEntity({
      ...entity,
      spec: { ...entity.spec, owner: 'group:default/lion' },
    } as Entity)}`
    expect(insertedOnly(BEFORE, file(BEFORE, other), entity)).toBe(
      'the added document does not read back as resource:default/grant-c',
    )
  })

  it('refuses a result holding two more documents', () => {
    expect(insertedOnly(BEFORE, file(BEFORE, added, added), entity)).toBe(
      'the result does not hold exactly one more document than the file',
    )
  })
})
