import { describe, expect, it } from 'vitest'
import { planSchema } from '../../src/core/schemas/plan.js'
import { entitySchema } from '../../src/core/schemas/entity.js'

const plan = (entity: unknown): unknown => ({
  intent: 'give billing-api access to orders-db in prod',
  operations: [{ op: 'create-entity', entity }],
})

const sound = {
  kind: 'Resource',
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: { type: 'database-access', owner: 'group:default/tiger' },
}

describe('a proposal is stricter than an entity read from disk', () => {
  it('accepts a well-formed proposal', () => {
    expect(planSchema.safeParse(plan(sound)).success).toBe(true)
  })

  it('refuses a field it does not model, instead of dropping it later', () => {
    // Today this passes and `ordered()` drops the field in silence at
    // serialisation. A proposal carrying an unmodelled field is either an
    // invention or a silent drop, and both are unacceptable.
    const result = planSchema.safeParse(plan({ ...sound, backdoor: true }))
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('backdoor')
  })

  it('has nowhere to carry an annotation, so the model cannot aim at a path', () => {
    // §5.2 promises the engine chooses the path and the model cannot aim at
    // it. resolveEntityPath reads idp-agent.dev/source-file to decide where a
    // file goes, so a model writing that annotation aims at the path. The
    // proposal has no annotations map at all: the attack is inexpressible.
    const aiming = {
      ...sound,
      metadata: {
        ...sound.metadata,
        annotations: { 'idp-agent.dev/source-file': '../../etc/passwd.yml' },
      },
    }
    expect(planSchema.safeParse(plan(aiming)).success).toBe(false)
  })

  it('refuses a proposal that names its own path by any other spelling', () => {
    expect(planSchema.safeParse(plan({ ...sound, path: 'anywhere.yml' })).success).toBe(false)
    expect(
      planSchema.safeParse(plan({ ...sound, metadata: { ...sound.metadata, path: 'x.yml' } }))
        .success,
    ).toBe(false)
  })

  it('requires an environment, because it is part of an access identity', () => {
    // Being authorised in dev grants nothing in staging (design 4.1). An
    // access with no environment is not a smaller request, it is a different
    // entity.
    const { env: _env, ...withoutEnv } = sound.metadata
    expect(planSchema.safeParse(plan({ ...sound, metadata: withoutEnv })).success).toBe(false)
  })

  it('refuses a type the registry does not declare', () => {
    // The union is closed: what is not modelled cannot be requested. This is
    // a schema error, not a question — asking would imply it could be added.
    expect(
      planSchema.safeParse(plan({ ...sound, spec: { ...sound.spec, type: 'quantum-db' } })).success,
    ).toBe(false)
  })

  it('lets an unknown stand in for any field the model could not determine', () => {
    // Declare, never infer: the model has a legal way to say "I do not know"
    // for every field it chooses, and the plan then cannot be applied.
    const asking = {
      ...sound,
      spec: { ...sound.spec, owner: { unknown: 'which team owns this?' } },
    }
    expect(planSchema.safeParse(plan(asking)).success).toBe(true)
  })

  it('keeps the read schema permissive, since a real catalogue carries more', () => {
    // entitySchema READS a Backstage repository whose files legitimately hold
    // fields this tool does not model. Making it strict would break
    // readRepository on any real catalogue. Two schemas, one direction each.
    expect(
      entitySchema.safeParse({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Resource',
        metadata: { name: 'x', labels: { team: 'tiger' } },
        spec: { type: 'database', owner: 'group:default/tiger' },
      }).success,
    ).toBe(true)
  })

  it('still accepts a component proposal, which has a lifecycle and no env', () => {
    const component = {
      kind: 'Component',
      metadata: { name: 'billing-api' },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    }
    expect(
      planSchema.safeParse({
        intent: 'declare billing-api',
        operations: [{ op: 'create-catalog-info', repoPath: 'apps/billing', entity: component }],
      }).success,
    ).toBe(true)
  })
})
