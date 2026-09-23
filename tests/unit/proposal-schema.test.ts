import { describe, expect, it } from 'vitest'
import { planSchema } from '../../src/core/schemas/plan.js'
import { entitySchema } from '../../src/core/schemas/entity.js'

const plan = (entity: unknown): unknown => ({
  intent: 'give billing-api read access to orders-db in prod',
  operations: [{ op: 'create-entity', entity }],
})

const sound = {
  kind: 'Resource',
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access', owner: 'group:default/tiger', access: 'read' as const,
    dependsOn: ['resource:default/orders-db-prod'], dependencyOf: ['component:default/billing-api'],
  },
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

  it('lets a proposal state the level the grant is for', () => {
    // The field the Reviewer said was missing: the request asked for read
    // access and `database-access` had no way to say so, which made `read` a
    // word in a name and nothing more.
    expect(
      planSchema.safeParse(plan({ ...sound, spec: { ...sound.spec, access: 'read' } })).success,
    ).toBe(true)
  })

  it('lets the level be an unknown, the way owner and type may be', () => {
    // §5.4: every field the model CHOOSES is a value or `{unknown}`. A level
    // it cannot determine is a question put to the user — and this is the one
    // field where guessing hands out write.
    const asking = {
      ...sound,
      spec: { ...sound.spec, access: { unknown: 'read or readwrite?' } },
    }
    expect(planSchema.safeParse(plan(asking)).success).toBe(true)
  })

  it('refuses a level the registry does not declare', () => {
    expect(
      planSchema.safeParse(plan({ ...sound, spec: { ...sound.spec, access: 'admin' } })).success,
    ).toBe(false)
  })

  it('refuses a level on a type that has none, naming the type', () => {
    // Unlike `dependencyOf`, this one IS refused at the proposal boundary. The
    // boundary already reads `spec.type` to know whether a level is required,
    // so it knows enough to say the level does not belong — and a refusal here
    // names the field and the type, which the repair loop hands back. Left to
    // `entitySchema`, the same mistake arrives as a re-check violation about
    // bytes, which no model can act on.
    const onAnObject = { ...sound, spec: { type: 'database', owner: sound.spec.owner, access: 'read' } }
    const parsed = planSchema.safeParse(plan(onAnObject))

    expect(parsed.success).toBe(false)
    expect(
      parsed.error?.issues.some((issue) => issue.message.includes('opened or it is not')),
    ).toBe(true)
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

describe('a grant states its level, or says it does not know', () => {
  it('refuses a right that states no level at all', () => {
    // `.optional()` made "say nothing" a legal proposal: no leaf, so no
    // question, so a database-access written from a request that said "read
    // access" landed with no level and exit 0. `metadata.env` set the opposite
    // precedent for exactly this reason — required, and wrapped in `or()` so
    // the honest answer is `{unknown}` rather than silence.
    const parsed = planSchema.safeParse({
      intent: 'give billing-api read access to orders-db in prod',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
            spec: { type: 'database-access', owner: 'group:default/tiger' },
          },
        },
      ],
    })

    expect(parsed.success).toBe(false)
    expect(
      parsed.error?.issues.some((issue) => issue.path.join('.').endsWith('spec.access')),
    ).toBe(true)
  })

  it('accepts a level the model admits it does not know', () => {
    const parsed = planSchema.safeParse({
      intent: 'give billing-api read access to orders-db in prod',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
            spec: {
              type: 'database-access',
              owner: 'group:default/tiger',
              access: { unknown: 'the request does not say read or write' },
              dependsOn: ['resource:default/orders-db-prod'],
              dependencyOf: ['component:default/billing-api'],
            },
          },
        },
      ],
    })

    expect(parsed.success).toBe(true)
  })
})

describe('an update states the level it is extending', () => {
  const joining = (patch: unknown): unknown => ({
    intent: 'give billing-api read access to orders-db in prod',
    operations: [
      { op: 'update-entity', entityRef: 'resource:default/checkout-orders-db-prod', patch },
    ],
  })

  const CONSUMER = 'component:default/billing-api'

  it('accepts the level as a value', () => {
    // The level of the grant being extended IS the authorisation being
    // extended, and it used to be nowhere in the operation: the only gate
    // between a read request and a readwrite grant read the level out of
    // English prose in the request. A field is what makes it a fact.
    expect(
      planSchema.safeParse(
        joining({ patch: 'add-dependency-of', consumer: CONSUMER, access: 'read' }),
      ).success,
    ).toBe(true)
  })

  it('accepts a level the model admits it does not know', () => {
    expect(
      planSchema.safeParse(
        joining({
          patch: 'add-dependency-of',
          consumer: CONSUMER,
          access: { unknown: 'the grant states no level I could read' },
        }),
      ).success,
    ).toBe(true)
  })

  it('accepts the field omitted, which is how a grant with no level is joined', () => {
    // Optional, unlike `metadata.env` and like `spec.access`: whether a level
    // exists at all depends on the TYPE of the entity the reference names, and
    // that entity is not in the operation. A `network-access` is opened or it
    // is not, so requiring one here would make the honest proposal for a flow
    // an `{unknown}` about a question nobody asked. Whether the omission was
    // allowed is the policy's to decide, against the declaration.
    expect(
      planSchema.safeParse(joining({ patch: 'add-dependency-of', consumer: CONSUMER })).success,
    ).toBe(true)
  })

  it('refuses a level outside the two the registry declares', () => {
    const parsed = planSchema.safeParse(
      joining({ patch: 'add-dependency-of', consumer: CONSUMER, access: 'admin' }),
    )

    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('access')
  })
})
