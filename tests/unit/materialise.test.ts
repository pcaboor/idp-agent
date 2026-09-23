import { describe, expect, it } from 'vitest'
import { materialise } from '../../src/core/plan/materialise.js'

/** What a proposal looks like when everything has been determined. */
const settled = {
  kind: 'Resource',
  metadata: { name: 'orders-db-prod', env: 'prod' },
  spec: { type: 'database', owner: 'group:default/tiger' },
}

describe('materialise', () => {
  it('turns a proposal into the entity it would become', () => {
    const entity = materialise(settled)

    expect(entity?.apiVersion).toBe('backstage.io/v1alpha1')
    expect(entity?.metadata.name).toBe('orders-db-prod')
    // `metadata.env` on the way in, the annotation on the way out: the
    // translation this function exists for.
    expect(entity?.metadata.annotations['company.fr/env']).toBe('prod')
  })

  it('refuses a proposal that still carries a question', () => {
    // F12. Without this the mapping `{unknown: "which team owns it?"}` is
    // serialised under `owner:` — a question written into a declaration as
    // though it were an answer, in the one function whose output gets turned
    // into bytes.
    const asking = {
      ...settled,
      spec: { ...settled.spec, owner: { unknown: 'which team owns this database?' } },
    }

    expect(materialise(asking)).toBeUndefined()
  })

  it('refuses one nested deeper than the top level of a spec', () => {
    // The guard walks, because a question can sit anywhere a value can.
    const asking = {
      ...settled,
      spec: { ...settled.spec, dependsOn: [{ unknown: 'which database?' }] },
    }

    expect(materialise(asking)).toBeUndefined()
  })

  it('still refuses a proposal with no name, for a different reason', () => {
    // An entity with no name is not an entity. Kept distinct from the question
    // guard above so neither can quietly absorb the other.
    expect(materialise({ ...settled, metadata: { env: 'prod' } })).toBeUndefined()
  })
})
