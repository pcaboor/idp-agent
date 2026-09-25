import { describe, expect, it } from 'vitest'
import { reapplyAnswers, recordAnswers, type RecordedAnswer } from '../../src/core/plan/reapply.js'
import { planSchema, type Plan } from '../../src/core/schemas/plan.js'

/**
 * An answer is the user's word about one field of one entity, and it has to
 * outlive the plan it was typed into.
 *
 * The run this exists for: the user answered the owner of `orders-db-prod`,
 * the Reviewer refused the filled plan, and the Architect's redraft — which
 * had never seen the answer — put `{unknown}` back in the same field. Keyed
 * by path alone, the answer vouched for nothing any more and the same
 * question was asked a second time.
 */

const UNKNOWN_OWNER = { unknown: 'who owns this database?' }
const TIGER = 'group:default/tiger'
const LION = 'group:default/lion'

const database = (name: string, owner: unknown) => ({
  op: 'create-entity' as const,
  entity: {
    kind: 'Resource' as const,
    metadata: { name, env: 'prod' },
    spec: { type: 'database', owner },
  },
})

const access = (over: { owner?: unknown; access?: unknown; type?: string } = {}) => ({
  op: 'create-entity' as const,
  entity: {
    kind: 'Resource' as const,
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: over.type ?? 'database-access',
      // Absent when the caller passes `access: undefined`, `read` when it says nothing.
      ...(!('access' in over)
        ? { access: 'read' }
        : over.access === undefined
          ? {}
          : { access: over.access }),
      owner: over.owner ?? TIGER,
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: ['component:default/billing-api'],
    },
  },
})

const update = (level: unknown, consumer = 'component:default/billing-api') => ({
  op: 'update-entity' as const,
  entityRef: 'resource:default/billing-api-orders-db-prod',
  patch: {
    patch: 'add-dependency-of' as const,
    consumer,
    ...(level === undefined ? {} : { access: level }),
  },
})

/** Through the schema, as every plan reaching the step has been. */
const planOf = (...operations: unknown[]): Plan =>
  planSchema.parse({
    intent: 'give billing-api read access to the orders database in prod',
    operations,
  })

const OWNER_0 = 'operations.0.entity.spec.owner'
const OWNER_1 = 'operations.1.entity.spec.owner'

/** The owner's answer, recorded against the plan it filled. */
const ownerAnswered = (): RecordedAnswer[] =>
  recordAnswers(planOf(database('orders-db-prod', TIGER)), [{ path: OWNER_0, value: TIGER }])

describe('recordAnswers', () => {
  it('records an answer by the entity its operation declares and the field inside it', () => {
    expect(ownerAnswered()).toEqual([
      {
        path: OWNER_0,
        value: TIGER,
        about: { entity: 'resource:default/orders-db-prod', field: 'entity.spec.owner' },
      },
    ])
  })

  it('records an update by the entity it amends', () => {
    const plan = planOf(update('read'))
    expect(recordAnswers(plan, [{ path: 'operations.0.patch.access', value: 'read' }])).toEqual([
      {
        path: 'operations.0.patch.access',
        value: 'read',
        about: {
          entity: 'resource:default/billing-api-orders-db-prod',
          field: 'patch.access',
        },
      },
    ])
  })

  it('tells a Component from a Resource of the same name', () => {
    const plan = planOf({
      op: 'create-entity',
      entity: {
        kind: 'Component',
        metadata: { name: 'orders-db-prod' },
        spec: { type: 'service', lifecycle: 'production', owner: TIGER },
      },
    })
    expect(recordAnswers(plan, [{ path: OWNER_0, value: TIGER }])[0]?.about?.entity).toBe(
      'component:default/orders-db-prod',
    )
  })

  it('keeps at its path an answer about an entity another operation also amends', () => {
    // Two updates of one grant are two consumers, and each asks the level:
    // two questions, answered separately, that the entity cannot tell apart.
    const plan = planOf(
      update('read', 'component:default/payments-api'),
      update('readwrite', 'component:default/shipping-api'),
    )
    expect(
      recordAnswers(plan, [
        { path: 'operations.0.patch.access', value: 'read' },
        { path: 'operations.1.patch.access', value: 'readwrite' },
      ]),
    ).toEqual([
      { path: 'operations.0.patch.access', value: 'read' },
      { path: 'operations.1.patch.access', value: 'readwrite' },
    ])
  })

  it('keeps an answer it cannot place in an operation at its path, and nothing more', () => {
    const plan = planOf(database('orders-db-prod', TIGER))
    const outside = 'operations.7.entity.spec.owner'
    expect(recordAnswers(plan, [{ path: outside, value: TIGER }])).toEqual([
      { path: outside, value: TIGER },
    ])
  })
})

describe('reapplyAnswers', () => {
  it('changes nothing, and vouches at the same path, when the plan is the one answered', () => {
    const plan = planOf(database('orders-db-prod', TIGER))
    const result = reapplyAnswers(plan, ownerAnswered())

    expect(result.plan).toEqual(plan)
    expect([...result.answers]).toEqual([[OWNER_0, TIGER]])
    expect(result.reapplied).toEqual([])
  })

  it('writes the answer back where a redraft put the question again', () => {
    const redraft = planOf(database('orders-db-prod', UNKNOWN_OWNER), access())
    const result = reapplyAnswers(redraft, ownerAnswered())

    expect(result.plan.operations[0]).toEqual(database('orders-db-prod', TIGER))
    expect(result.answers.get(OWNER_0)).toBe(TIGER)
    expect(result.reapplied).toEqual([
      {
        path: OWNER_0,
        value: TIGER,
        entity: 'resource:default/orders-db-prod',
        answeredAt: OWNER_0,
      },
    ])
  })

  it('follows the entity when a redraft moves it to another index', () => {
    const redraft = planOf(access(), database('orders-db-prod', UNKNOWN_OWNER))
    const result = reapplyAnswers(redraft, ownerAnswered())

    expect(result.plan.operations[1]).toEqual(database('orders-db-prod', TIGER))
    // The access at the old index is untouched, and the answer does not vouch
    // for whatever sits there now: that was the one limit of a path key.
    expect(result.plan.operations[0]).toEqual(access())
    expect([...result.answers]).toEqual([[OWNER_1, TIGER]])
    expect(result.reapplied).toEqual([
      expect.objectContaining({ path: OWNER_1, answeredAt: OWNER_0 }),
    ])
  })

  it('lets the answer win over a different value the redraft wrote, and says so', () => {
    const redraft = planOf(database('orders-db-prod', LION))
    const result = reapplyAnswers(redraft, ownerAnswered())

    expect(result.plan.operations[0]).toEqual(database('orders-db-prod', TIGER))
    expect(result.answers.get(OWNER_0)).toBe(TIGER)
    expect(result.reapplied).toEqual([
      {
        path: OWNER_0,
        value: TIGER,
        entity: 'resource:default/orders-db-prod',
        answeredAt: OWNER_0,
        replaced: LION,
      },
    ])
  })

  it('does not follow a renamed entity: the question is asked again', () => {
    const redraft = planOf(database('orders-prod', UNKNOWN_OWNER))
    const result = reapplyAnswers(redraft, ownerAnswered())

    expect(result.plan).toEqual(redraft)
    expect(result.answers.size).toBe(0)
    expect(result.reapplied).toEqual([])
  })

  it('does not follow an entity of another kind under the same name', () => {
    const redraft = planOf({
      op: 'create-entity',
      entity: {
        kind: 'Component',
        metadata: { name: 'orders-db-prod' },
        spec: { type: 'service', lifecycle: 'production', owner: UNKNOWN_OWNER },
      },
    })
    const result = reapplyAnswers(redraft, ownerAnswered())

    expect(result.plan).toEqual(redraft)
    expect(result.answers.size).toBe(0)
  })

  it("keeps an update's answered level through a redraft that moved or dropped it", () => {
    const answered = recordAnswers(planOf(update('read')), [
      { path: 'operations.0.patch.access', value: 'read' },
    ])

    const asked = reapplyAnswers(
      planOf(database('orders-db-prod', TIGER), update({ unknown: 'which level?' })),
      answered,
    )
    expect(asked.plan.operations[1]).toEqual(update('read'))
    expect([...asked.answers]).toEqual([['operations.1.patch.access', 'read']])

    // Absent is a claim — "this grant states no level" — and the user said
    // otherwise about this grant.
    const omitted = reapplyAnswers(planOf(update(undefined)), answered)
    expect(omitted.plan.operations[0]).toEqual(update('read'))
    expect(omitted.reapplied).toEqual([
      expect.objectContaining({ path: 'operations.0.patch.access', value: 'read' }),
    ])
  })

  it('writes nothing the schema would refuse there, and vouches for nothing it did not write', () => {
    // A level answered for a database-access; the redraft made the grant a
    // network-access, which has no level to state.
    const answered = recordAnswers(planOf(access({ access: 'read' })), [
      { path: 'operations.0.entity.spec.access', value: 'read' },
    ])
    const redraft = planOf(access({ type: 'network-access', access: undefined }))
    const result = reapplyAnswers(redraft, answered)

    expect(result.plan).toEqual(redraft)
    expect(result.answers.size).toBe(0)
    expect(result.reapplied).toEqual([])
  })

  it('never rewrites a consumer; it vouches for one only where it still stands', () => {
    const consumer = 'operations.0.patch.consumer'
    const answered = recordAnswers(planOf(update('read')), [
      { path: consumer, value: 'component:default/billing-api' },
    ])

    const other = planOf(update('read', 'component:default/payments-api'))
    const moved = reapplyAnswers(other, answered)
    expect(moved.plan).toEqual(other)
    expect(moved.answers.size).toBe(0)

    const kept = reapplyAnswers(planOf(database('orders-db-prod', TIGER), update('read')), answered)
    expect([...kept.answers]).toEqual([
      ['operations.1.patch.consumer', 'component:default/billing-api'],
    ])
    expect(kept.reapplied).toEqual([])
  })

  it('keeps an answer with nothing to follow at the path it was typed at', () => {
    const plan = planOf(database('orders-db-prod', TIGER))
    const result = reapplyAnswers(plan, [{ path: OWNER_0, value: TIGER }])
    expect([...result.answers]).toEqual([[OWNER_0, TIGER]])
  })

  it('takes the later of two answers to the same field', () => {
    const plan = planOf(database('orders-db-prod', UNKNOWN_OWNER))
    const result = reapplyAnswers(plan, [
      ...ownerAnswered(),
      ...recordAnswers(planOf(access(), database('orders-db-prod', LION)), [
        { path: OWNER_1, value: LION },
      ]),
    ])
    expect(result.answers.get(OWNER_0)).toBe(LION)
    expect(result.plan.operations[0]).toEqual(database('orders-db-prod', LION))
  })

  it('leaves two answers typed into two updates of one grant exactly where they were', () => {
    // The regression: keyed by the entity, `readwrite` overwrote `read` as a
    // value the draft wrote, and a read joined a readwrite grant at exit 0.
    const plan = planOf(
      update('read', 'component:default/payments-api'),
      update('readwrite', 'component:default/shipping-api'),
    )
    const answered = recordAnswers(plan, [
      { path: 'operations.0.patch.access', value: 'read' },
      { path: 'operations.1.patch.access', value: 'readwrite' },
    ])
    const result = reapplyAnswers(plan, answered)

    expect(result.plan).toEqual(plan)
    expect([...result.answers]).toEqual([
      ['operations.0.patch.access', 'read'],
      ['operations.1.patch.access', 'readwrite'],
    ])
    expect(result.reapplied).toEqual([])
  })

  it('places no answer in a draft that amends its entity twice', () => {
    // Which of the two the answer was about is not something the draft can
    // say: it writes into neither and vouches for the model's value in
    // neither, and the level is asked again.
    const answered = recordAnswers(planOf(update('read')), [
      { path: 'operations.0.patch.access', value: 'read' },
    ])
    const redraft = planOf(
      update({ unknown: 'which level?' }, 'component:default/payments-api'),
      update('read', 'component:default/shipping-api'),
    )
    const result = reapplyAnswers(redraft, answered)

    expect(result.plan).toEqual(redraft)
    expect(result.answers.size).toBe(0)
    expect(result.reapplied).toEqual([])
  })

  it('never changes the plan it was handed', () => {
    const redraft = planOf(database('orders-db-prod', UNKNOWN_OWNER))
    const before = structuredClone(redraft)
    reapplyAnswers(redraft, ownerAnswered())
    expect(redraft).toEqual(before)
  })
})
