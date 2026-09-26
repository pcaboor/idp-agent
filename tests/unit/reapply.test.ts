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
          consumer: 'component:default/billing-api',
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
    // Vouched where it stands, and never said to be put back into every draft:
    // it is not, and the repair report reads `about` as exactly that.
    expect(kept.about.size).toBe(0)
  })

  it('keeps an answer with nothing to follow at the path it was typed at', () => {
    const plan = planOf(database('orders-db-prod', TIGER))
    const result = reapplyAnswers(plan, [{ path: OWNER_0, value: TIGER }])
    expect([...result.answers]).toEqual([[OWNER_0, TIGER]])
    expect(result.about.size).toBe(0)
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

/**
 * A level is the user's word about an ACCESS — who reaches what — and not
 * about the grant a draft happened to carry it in.
 *
 * The owner's run: the draft joined billing-api to orders-api's grant over
 * orders-db-prod, the person answered `read`, and the only plan that honours
 * that is a grant of billing-api's own. Keyed by the grant, the answer stayed
 * behind on orders-api's grant when the redraft declared that one, and the
 * level was asked a second time about the same access.
 */
describe('an answered level follows the access, not the grant that carried it', () => {
  const BILLING = 'component:default/billing-api'
  const PAYMENTS = 'component:default/payments-api'
  const DATABASE = 'resource:default/orders-db-prod'
  const ORDERS_GRANT = 'resource:default/orders-api-orders-db-prod'
  const OVER = new Map<string, readonly string[]>([[ORDERS_GRANT, [DATABASE]]])
  const JOINED_AT = 'operations.0.patch.access'
  const DECLARED_AT = 'operations.0.entity.spec.access'
  const THE_ACCESS = `${BILLING}'s access to ${DATABASE}`

  const joining = (level: unknown, consumer = BILLING) => ({
    op: 'update-entity' as const,
    entityRef: ORDERS_GRANT,
    patch: {
      patch: 'add-dependency-of' as const,
      consumer,
      ...(level === undefined ? {} : { access: level }),
    },
  })

  /** The answer the owner typed, against the draft it filled. */
  const answeredRead = (): RecordedAnswer[] =>
    recordAnswers(planOf(joining('read')), [{ path: JOINED_AT, value: 'read' }], OVER)

  it('records a level by the access it states, when the repository says what it is over', () => {
    // And by its grant and its one consumer as well: see the test of a
    // redraft that changes what the grant is over.
    expect(answeredRead()).toEqual([
      {
        path: JOINED_AT,
        value: 'read',
        about: { entity: ORDERS_GRANT, field: 'patch.access', consumer: BILLING },
        access: { consumer: BILLING, resource: DATABASE },
      },
    ])
    // And a creation's by its one consumer and its one thing, with no map at all.
    expect(
      recordAnswers(planOf(access({ access: 'read' })), [{ path: DECLARED_AT, value: 'read' }]),
    ).toEqual([
      {
        path: DECLARED_AT,
        value: 'read',
        about: {
          entity: 'resource:default/billing-api-orders-db-prod',
          field: 'entity.spec.access',
          consumer: BILLING,
        },
        access: { consumer: BILLING, resource: DATABASE },
      },
    ])
  })

  it('carries no level onto a join to a grant that states none', () => {
    // `GrantedOver` holds only the rights that state a level. A network flow
    // over the same database is billing-api reaching it too, but not at a
    // level: nothing is written into that join, and it is not a second
    // statement of the access that would have the answer asked again.
    const network = 'resource:default/billing-api-to-orders-db-prod'
    const joinNetwork = {
      op: 'update-entity' as const,
      entityRef: network,
      patch: { patch: 'add-dependency-of' as const, consumer: BILLING },
    }
    const redraft = planOf(access({ access: { unknown: 'which level?' } }), joinNetwork)

    const result = reapplyAnswers(redraft, answeredRead(), OVER)

    expect(result.plan.operations).toEqual([access({ access: 'read' }), joinNetwork])
    expect(result.reapplied).toEqual([
      { path: DECLARED_AT, value: 'read', entity: THE_ACCESS, answeredAt: JOINED_AT },
    ])
  })

  it('carries the level to a grant of its own that the redraft declares, and says so', () => {
    const redraft = planOf(access({ access: { unknown: 'which level?' } }))

    const result = reapplyAnswers(redraft, answeredRead(), OVER)

    expect(result.plan.operations[0]).toEqual(access({ access: 'read' }))
    expect([...result.answers]).toEqual([[DECLARED_AT, 'read']])
    expect(result.reapplied).toEqual([
      { path: DECLARED_AT, value: 'read', entity: THE_ACCESS, answeredAt: JOINED_AT },
    ])
  })

  it('carries it back the other way, onto an existing grant the redraft joins', () => {
    const answered = recordAnswers(
      planOf(access({ access: 'read' })),
      [{ path: DECLARED_AT, value: 'read' }],
    )

    const result = reapplyAnswers(planOf(joining('readwrite')), answered, OVER)

    expect(result.plan.operations[0]).toEqual(joining('read'))
    expect(result.reapplied).toEqual([
      expect.objectContaining({ path: JOINED_AT, value: 'read', replaced: 'readwrite' }),
    ])
  })

  it("puts nothing on another consumer's access through the same grant", () => {
    // Keyed by the grant, this answer set payments-api's level: a value the
    // user gave about billing-api, vouched for about somebody else.
    const redraft = planOf(joining({ unknown: 'which level?' }, PAYMENTS))

    const result = reapplyAnswers(redraft, answeredRead(), OVER)

    expect(result.plan).toEqual(redraft)
    expect(result.answers.size).toBe(0)
    expect(result.reapplied).toEqual([])
  })

  it('keeps a level typed into a grant whose thing it cannot tell for that consumer alone', () => {
    // Over two databases, the grant names no one access, so the answer is held
    // by the grant — and by the consumer it was typed for. The same consumer
    // joined to the same grant again is the same question and is not asked;
    // another consumer joined to it is another access, and is.
    const twoThings = new Map([[ORDERS_GRANT, [DATABASE, 'resource:default/orders-db-dev']]])
    const answered = recordAnswers(
      planOf(joining('read')),
      [{ path: JOINED_AT, value: 'read' }],
      twoThings,
    )
    expect(answered).toEqual([
      {
        path: JOINED_AT,
        value: 'read',
        about: { entity: ORDERS_GRANT, field: 'patch.access', consumer: BILLING },
      },
    ])

    const other = planOf(joining({ unknown: 'which level?' }, PAYMENTS))
    const refused = reapplyAnswers(other, answered, twoThings)
    expect(refused.plan).toEqual(other)
    expect(refused.answers.size).toBe(0)
    expect(refused.reapplied).toEqual([])

    const same = reapplyAnswers(planOf(joining({ unknown: 'which level?' })), answered, twoThings)
    expect(same.plan.operations[0]).toEqual(joining('read'))
    expect(same.reapplied).toEqual([
      { path: JOINED_AT, value: 'read', entity: ORDERS_GRANT, answeredAt: JOINED_AT },
    ])
  })

  it('asks again a level typed for a grant of two consumers, which is no one access', () => {
    const shared = {
      op: 'create-entity' as const,
      entity: {
        kind: 'Resource' as const,
        metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
        spec: {
          type: 'database-access',
          access: 'read',
          owner: TIGER,
          dependsOn: [DATABASE],
          dependencyOf: [BILLING, PAYMENTS],
        },
      },
    }
    const answered = recordAnswers(planOf(shared), [{ path: DECLARED_AT, value: 'read' }], OVER)
    expect(answered).toEqual([{ path: DECLARED_AT, value: 'read' }])

    const redraft = planOf(access({ access: { unknown: 'which level?' } }))
    const result = reapplyAnswers(redraft, answered, OVER)
    expect(result.plan).toEqual(redraft)
    expect(result.reapplied).toEqual([])
  })

  it('keeps a level with its grant and consumer when the redraft changes what it is over', () => {
    // The `link-db-missing` tape: the first draft declared billing-api's grant
    // over `resource:default/orders-db`, the level was answered, and the
    // redraft declared the same grant over `resource:prod/orders-db`. No draft
    // states the access the answer was typed for any more, and the grant and
    // its one consumer are the ones the person answered about: not asked twice.
    const over = (thing: string, level: unknown) => ({
      op: 'create-entity' as const,
      entity: {
        kind: 'Resource' as const,
        metadata: { name: 'billing-api-orders-db', env: 'prod' },
        spec: {
          type: 'database-access',
          access: level,
          owner: TIGER,
          dependsOn: [thing],
          dependencyOf: [BILLING],
        },
      },
    })
    const answered = recordAnswers(
      planOf(database('orders-db', TIGER), over('resource:default/orders-db', 'read')),
      [{ path: 'operations.1.entity.spec.access', value: 'read' }],
      OVER,
    )

    const result = reapplyAnswers(
      planOf(over('resource:prod/orders-db', { unknown: 'which level?' })),
      answered,
      OVER,
    )

    expect(result.plan.operations[0]).toEqual(over('resource:prod/orders-db', 'read'))
    expect(result.reapplied).toEqual([
      {
        path: DECLARED_AT,
        value: 'read',
        entity: 'resource:default/billing-api-orders-db',
        answeredAt: 'operations.1.entity.spec.access',
      },
    ])
    // Another consumer in that same grant is another access, and is asked.
    const payments = planOf({
      ...over('resource:prod/orders-db', { unknown: 'which level?' }),
      entity: {
        ...over('resource:prod/orders-db', { unknown: 'which level?' }).entity,
        spec: {
          ...over('resource:prod/orders-db', { unknown: 'which level?' }).entity.spec,
          dependencyOf: [PAYMENTS],
        },
      },
    })
    expect(reapplyAnswers(payments, answered, OVER).reapplied).toEqual([])
  })

  it("follows each consumer of one grant by its own access, in the redraft's order", () => {
    const plan = planOf(joining('read'), joining('readwrite', PAYMENTS))
    const answered = recordAnswers(
      plan,
      [
        { path: JOINED_AT, value: 'read' },
        { path: 'operations.1.patch.access', value: 'readwrite' },
      ],
      OVER,
    )
    expect(answered.map((one) => one.access)).toEqual([
      { consumer: BILLING, resource: DATABASE },
      { consumer: PAYMENTS, resource: DATABASE },
    ])

    const swapped = planOf(
      joining({ unknown: 'which level?' }, PAYMENTS),
      joining({ unknown: 'which level?' }),
    )
    const result = reapplyAnswers(swapped, answered, OVER)

    expect(result.plan.operations).toEqual([joining('readwrite', PAYMENTS), joining('read')])
    expect(result.reapplied.map(({ path, value, entity }) => ({ path, value, entity }))).toEqual([
      { path: JOINED_AT, value: 'readwrite', entity: `${PAYMENTS}'s access to ${DATABASE}` },
      { path: 'operations.1.patch.access', value: 'read', entity: THE_ACCESS },
    ])
  })

  it('carries nothing into a draft that states the same access twice', () => {
    const redraft = planOf(
      joining({ unknown: 'which level?' }),
      access({ access: { unknown: 'which level?' } }),
    )

    const result = reapplyAnswers(redraft, answeredRead(), OVER)

    expect(result.plan).toEqual(redraft)
    expect(result.answers.size).toBe(0)
  })

  it('records nothing by an access the plan it filled states twice', () => {
    const plan = planOf(joining('read'), access({ access: 'read' }))
    expect(recordAnswers(plan, [{ path: JOINED_AT, value: 'read' }], OVER)).toEqual([
      {
        path: JOINED_AT,
        value: 'read',
        about: { entity: ORDERS_GRANT, field: 'patch.access', consumer: BILLING },
      },
    ])
  })
})
