import { describe, expect, it } from 'vitest'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import { summariseGraph } from '../../src/context/graph/summary.js'
import { deriveOwners } from '../../src/core/plan/derive.js'
import { signPlan, type SignatureContext } from '../../src/core/plan/sign.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { findUnknowns, planSchema, type Plan } from '../../src/core/schemas/plan.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'
import { saidWithLevels, userSaid } from '../support/provenance.js'

const INTENT = 'give billing-api read access to orders-db in prod'

const resource = (name: string, type: string, owner: string): Entity =>
  ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name, annotations: { [ENV_ANNOTATION]: 'prod' } },
    spec: { type, owner },
  }) as Entity

const component = (name: string, owner: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, annotations: { [ENV_ANNOTATION]: 'prod' } },
  spec: { type: 'service', lifecycle: 'production', owner },
})

/**
 * The catalogue this repository declares. Everything below — the owners map,
 * the vocabulary, the witness set — is derived from THIS list and never hand
 * written, because that is the condition the guarantee rests on: the map and
 * the vocabulary have to come from one graph or a derived owner is not in the
 * list the signature measures it against.
 */
const CATALOGUE: readonly Entity[] = [
  resource('orders-db-prod', 'database', 'group:default/tiger'),
  component('billing-api', 'group:default/tiger'),
  component('invoicing-api', 'group:default/tiger'),
  component('reporting-api', 'group:default/lynx'),
]

/** What `contextsOf` builds from the graph it already has: ref → declared owner. */
const OWNERS: ReadonlyMap<string, string> = new Map(
  CATALOGUE.map((entity) => [refOf(entity), entity.spec.owner]),
)

const VOCABULARY = summariseGraph(EntityGraph.from([...CATALOGUE])).vocabulary

const context = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: new Set(OWNERS.keys()),
  vocabulary: VOCABULARY,
  repoRoot: '/repo',
  declared: new Map(),
  ...over,
})

/**
 * Derived with nothing stated but the request the plan carries — a person's
 * own, which is what every fixture here models, and no answer typed at all.
 */
const derive = (plan: Plan, owners: ReadonlyMap<string, string> = OWNERS) =>
  deriveOwners(plan, owners, userSaid(plan.intent))

const UNSTATED = { unknown: 'the request does not state an owner for this access' }

const planOf = (entity: unknown, intent = INTENT): Plan =>
  planSchema.parse({ intent, operations: [{ op: 'create-entity', entity }] })

/**
 * The same plan, NOT parsed. One test below is about a shape the schema now
 * refuses outright, and `deriveOwners` still has to answer for it: it reads
 * plans that the gates have passed today, and a second reader tomorrow may
 * hand it one they have not. The guarantee is stated in two places on purpose
 * — the test asserts both, so neither can be removed quietly.
 */
const unparsed = (entity: unknown, intent = INTENT): Plan =>
  ({ intent, operations: [{ op: 'create-entity', entity }] }) as unknown as Plan

/** The access four scenarios in five stopped on: everything settled but the owner. */
const access = (over: Record<string, unknown> = {}) => ({
  kind: 'Resource',
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access', access: 'read',
    owner: UNSTATED,
    dependsOn: ['resource:default/orders-db-prod'],
    dependencyOf: ['component:default/billing-api'],
    ...over,
  },
})

const OWNER_PATH = 'operations.0.entity.spec.owner'

const ownerOf = (plan: Plan): unknown => {
  const operation = plan.operations[0]
  if (operation?.op !== 'create-entity') throw new Error('not a create-entity plan')
  return operation.entity.spec.owner
}

describe('deriveOwners', () => {
  it('derives a right’s owner from its one consumer', () => {
    const result = derive(planOf(access()), OWNERS)

    expect(ownerOf(result.plan)).toBe('group:default/tiger')
    expect(result.derived).toEqual([
      {
        path: OWNER_PATH,
        owner: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
    ])
    expect(result.contested).toEqual([])
  })

  it('derives when two consumers are owned by the same group', () => {
    // Two consumers is not ambiguity. One answer is one answer, however many
    // declarations agree on it.
    const result = derive(
      planOf(
        access({
          dependencyOf: ['component:default/billing-api', 'component:default/invoicing-api'],
        }),
      ),
      OWNERS,
    )

    expect(ownerOf(result.plan)).toBe('group:default/tiger')
    expect(result.derived[0]?.from).toEqual([
      'component:default/billing-api',
      'component:default/invoicing-api',
    ])
  })

  it('leaves the question when two consumers are owned by different groups', () => {
    // The case this whole design exists to prevent picking. Two teams sharing
    // one access is a human decision, and taking the first would be a guess.
    const result = derive(
      planOf(
        access({
          dependencyOf: ['component:default/billing-api', 'component:default/reporting-api'],
        }),
      ),
      OWNERS,
    )

    expect(ownerOf(result.plan)).toEqual(UNSTATED)
    expect(result.derived).toEqual([])
    expect(result.contested).toEqual([
      { path: OWNER_PATH, owners: ['group:default/lynx', 'group:default/tiger'] },
    ])
  })

  it('leaves the question when no consumer has a known owner', () => {
    // A consumer the catalogue does not hold, rather than no consumer at all:
    // a right naming nobody is refused at the schema now, and the question
    // this asks — what happens when the evidence leads nowhere — is the same.
    const result = derive(planOf(access({ dependencyOf: ['component:default/nobody-owns-this'] })), OWNERS)

    expect(ownerOf(result.plan)).toEqual(UNSTATED)
    expect(result.derived).toEqual([])
    // Not contested: nothing disagreed. There was simply nothing to read.
    expect(result.contested).toEqual([])
  })

  it('never derives for an object, however many consumers it lists', () => {
    // A right's owner follows from who reaches through it. Nobody knows who
    // owns a database that does not exist yet, and the consumer list on an
    // object is not evidence.
    //
    // `unparsed`, because this shape no longer reaches here: `relationsStated`
    // refuses an object carrying consumers at the schema. That is asserted
    // just below, and this asserts the second lock — a proposal that got past
    // the first one still derives nothing from it.
    const object = {
      kind: 'Resource',
      metadata: { name: 'orders-db-staging', env: 'staging' },
      spec: {
        type: 'database',
        owner: UNSTATED,
        dependencyOf: ['component:default/billing-api'],
      },
    }
    const result = derive(unparsed(object), OWNERS)

    expect(ownerOf(result.plan)).toEqual(UNSTATED)
    expect(result.derived).toEqual([])
    expect(() => planOf(object)).toThrow(/carries no consumers/)
  })

  it('never derives for a Component', () => {
    const result = derive(
      planOf({
        kind: 'Component',
        metadata: { name: 'billing-api' },
        spec: { type: 'service', lifecycle: 'production', owner: UNSTATED },
      }),
      OWNERS,
    )

    expect(ownerOf(result.plan)).toEqual(UNSTATED)
    expect(result.derived).toEqual([])
  })

  it('never overwrites an owner the REQUEST states', () => {
    // The request said it, and that is the stronger claim. Even when the
    // consumer declares something else — especially then.
    const result = derive(
      planOf(
        access({
          owner: 'group:default/lynx',
          dependencyOf: ['component:default/billing-api'],
        }),
        `${INTENT}, owned by group:default/lynx`,
      ),
      OWNERS,
    )

    expect(ownerOf(result.plan)).toBe('group:default/lynx')
    expect(result.derived).toEqual([])
    expect(result.contested).toEqual([])
    // Kept, and not silently: the consumer says tiger.
    expect(result.overridden).toEqual([
      {
        path: OWNER_PATH,
        owner: 'group:default/lynx',
        determined: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
    ])
  })

  it('derives an owner the proposal omitted altogether', () => {
    // `proposedResourceSchema` requires the field, so this plan did not come
    // through the boundary and the cast says so. `deriveOwners` is exported
    // from core/ and handed a Plan by callers it does not own; "absent" and
    // "{unknown}" are the same fact, and treating one of them as a stated
    // owner would be the engine vouching for a value nobody wrote.
    const bare = {
      intent: INTENT,
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
            spec: {
              type: 'database-access', access: 'read',
              dependencyOf: ['component:default/billing-api'],
            },
          },
        },
      ],
    } as unknown as Plan

    expect(ownerOf(derive(bare, OWNERS).plan)).toBe('group:default/tiger')
  })

  it('leaves the plan it was handed untouched', () => {
    const plan = planOf(access())
    const before = JSON.stringify(plan)

    derive(plan, OWNERS)

    expect(JSON.stringify(plan)).toBe(before)
  })
})

describe('what the signature then says about it', () => {
  it('signs the derived owner with no question on it', () => {
    // The real signer, not an assertion about the class by hand: the whole
    // claim is that the value passes THIS gate, and a hand-written expectation
    // about `enumerated` would still hold on the day it stopped being true.
    const derived = derive(planOf(access()), OWNERS)
    const signed = signPlan(derived.plan, context(), saidWithLevels(derived.plan))
    if ('outcome' in signed) throw new Error(`refused: ${JSON.stringify(signed.refusals)}`)

    expect(findUnknowns(signed.plan)).toEqual([])
    expect(signed.classified.find((leaf) => leaf.path === OWNER_PATH)?.class).toBe('enumerated')
  })

  it('still asks when nothing could be derived', () => {
    // The gate the measured runs stopped on, unchanged for the case the rules
    // refuse to answer: an access with no consumer is still a question.
    const derived = derive(planOf(access({ dependencyOf: ['component:default/nobody-owns-this'] })), OWNERS)
    const signed = signPlan(derived.plan, context(), saidWithLevels(derived.plan))
    if ('outcome' in signed) throw new Error(`refused: ${JSON.stringify(signed.refusals)}`)

    expect(findUnknowns(signed.plan)).toContain(OWNER_PATH)
  })
})

describe('a consumer is not anything a reference points at', () => {
  it('refuses to take the owner of the resource the access reaches', () => {
    // The file promises this in as many words — "the owner of orders-db is not
    // the owner of the access to it" — and then read `dependencyOf` without
    // checking WHAT it named. A proposal listing the reached resource as its
    // own consumer made the engine write that resource's owner onto the
    // access: an authorisation handed to the team that owns the database, for
    // a grant nobody asked them about.
    const access = {
      kind: 'Resource' as const,
      metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
      spec: {
        type: 'database-access' as const, access: 'read',
        owner: { unknown: 'who owns this access?' },
        dependsOn: ['resource:default/orders-db-prod'],
        // The reached resource, named on the consumer side.
        dependencyOf: ['resource:default/orders-db-prod'],
      },
    }

    const result = derive(planOf(access), OWNERS)

    expect(result.derived).toEqual([])
    expect(findUnknowns(result.plan)).toContain('operations.0.entity.spec.owner')
  })

  it('still derives from a Component, which is what a consumer is', () => {
    const access = {
      kind: 'Resource' as const,
      metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
      spec: {
        type: 'database-access' as const, access: 'read',
        owner: { unknown: 'who owns this access?' },
        dependsOn: ['resource:default/orders-db-prod'],
        dependencyOf: ['component:default/billing-api'],
      },
    }

    const result = derive(planOf(access), OWNERS)

    expect(result.derived).toHaveLength(1)
    expect(result.derived[0]?.owner).toBe('group:default/tiger')
  })
})

/**
 * F2: a derived value must not outlive the leaf it was read from.
 *
 * The audit's sequence, in one function: the owner the engine wrote in one pass
 * looked exactly like an owner a person had stated, so the next pass skipped it
 * and lion's authorisation survived on billing-api's access. Every test below
 * asks the same question — is this owner the USER's, or the engine's own — and
 * the answer is read off the provenance the derivation is handed.
 */
describe('a derived owner dies with its evidence', () => {
  it('re-derives the owner when the consumer list changed under it', () => {
    // The whole of F2. Round 1 read `payments-api` and wrote lion; the user
    // then answered the consumer question with `billing-api`. Nothing in the
    // request states lion, so lion is not a value this may keep.
    const result = derive(
      planOf(
        access({
          owner: 'group:default/lynx',
          dependencyOf: ['component:default/billing-api'],
        }),
      ),
      OWNERS,
    )

    expect(ownerOf(result.plan)).toBe('group:default/tiger')
    expect(result.derived).toEqual([
      {
        path: OWNER_PATH,
        owner: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
    ])
  })

  it('withdraws an owner nothing in the plan determines any more', () => {
    // The consumer the owner followed from was answered with a reference the
    // catalogue says nothing about. There is no evidence left, so there is no
    // value left: it goes back to being the question it always was.
    const result = derive(
      planOf(access({ owner: 'group:default/lynx', dependencyOf: ['component:default/nobody-owns-this'] })),
      OWNERS,
    )

    expect(findUnknowns(result.plan)).toContain(OWNER_PATH)
    // The reason is mandatory, and it is the sentence the CLI puts to a person.
    expect(ownerOf(result.plan)).toHaveProperty('unknown', expect.stringMatching(/owner/))
    expect(result.derived).toEqual([])
  })

  it('withdraws it when the consumers now disagree', () => {
    // Contested was already a question when the field was empty. It has to be
    // one when a value is sitting in it too, or the answer this refused to
    // guess is the answer an earlier round happened to write.
    const result = derive(
      planOf(
        access({
          owner: 'group:default/tiger',
          dependencyOf: ['component:default/billing-api', 'component:default/reporting-api'],
        }),
      ),
      OWNERS,
    )

    expect(findUnknowns(result.plan)).toContain(OWNER_PATH)
    expect(result.contested).toEqual([
      { path: OWNER_PATH, owners: ['group:default/lynx', 'group:default/tiger'] },
    ])
  })

  it('states the derivation again when the value did not change', () => {
    // A consumer answered with the same value it already had. Nothing moves,
    // and the engine still says it computed this owner — the Reviewer runs
    // once, in the last round, and `derived` is the only thing that tells it
    // which values were not a model's choice.
    const once = derive(planOf(access()), OWNERS)
    const twice = derive(once.plan, OWNERS)

    expect(ownerOf(twice.plan)).toBe('group:default/tiger')
    expect(twice.derived).toEqual(once.derived)
  })

  it('reads the request, not the catalogue', () => {
    // `group:default/lynx` is a real owner in this catalogue and would sign
    // `enumerated`. That is not what protects it here: the request naming it
    // is. Same value, request that does not name it — re-derived.
    const kept = derive(
      planOf(access({ owner: 'group:default/lynx' }), `${INTENT} for group:default/lynx`),
      OWNERS,
    )
    const replaced = derive(planOf(access({ owner: 'group:default/lynx' })), OWNERS)

    expect(ownerOf(kept.plan)).toBe('group:default/lynx')
    expect(ownerOf(replaced.plan)).toBe('group:default/tiger')
  })
})

/**
 * Rule 1 protects an owner the user STATED, and an answer typed at a prompt is
 * the user stating it — at the field it answered, and nowhere else.
 *
 * Reading only the request made the ask loop unable to end: an owner nothing
 * determines was asked, answered, withdrawn on the next pass because the
 * request did not carry it, and asked again until the rounds ran out.
 */
describe('an owner the user answered', () => {
  const undetermined = access({
    owner: 'group:default/ghost',
    dependencyOf: ['component:default/nobody-owns-this'],
  })

  it('is kept when the answer is at that owner’s path', () => {
    const result = deriveOwners(
      planOf(undetermined),
      OWNERS,
      userSaid(INTENT, { [OWNER_PATH]: 'group:default/ghost' }),
    )

    expect(ownerOf(result.plan)).toBe('group:default/ghost')
    expect(result.derived).toEqual([])
  })

  it('outranks the consumers, exactly as the request does, and says so', () => {
    // The owner question is put in the same round as the consumer's, so the
    // answer to one can be given before the answer to the other determines a
    // different owner. The user's word stands, as it does when the request
    // carries it; what the consumers would have given is reported beside it,
    // because a diff with one team's authorisation and another team's
    // consumer is the shape a reader must be told about.
    const result = deriveOwners(
      planOf(access({ owner: 'group:default/ghost' })),
      OWNERS,
      userSaid(INTENT, { [OWNER_PATH]: 'group:default/ghost' }),
    )

    expect(ownerOf(result.plan)).toBe('group:default/ghost')
    expect(result.derived).toEqual([])
    expect(result.overridden).toEqual([
      {
        path: OWNER_PATH,
        owner: 'group:default/ghost',
        determined: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
    ])
  })

  it('reports nothing overridden when the consumers agree or determine nothing', () => {
    const agreeing = deriveOwners(
      planOf(access({ owner: 'group:default/tiger' })),
      OWNERS,
      userSaid(INTENT, { [OWNER_PATH]: 'group:default/tiger' }),
    )
    const undeterminedResult = deriveOwners(
      planOf(undetermined),
      OWNERS,
      userSaid(INTENT, { [OWNER_PATH]: 'group:default/ghost' }),
    )

    expect(agreeing.overridden).toEqual([])
    expect(undeterminedResult.overridden).toEqual([])
  })

  it('protects nothing when the same value was answered at another path', () => {
    const result = deriveOwners(
      planOf(undetermined),
      OWNERS,
      userSaid(INTENT, { 'operations.1.entity.spec.owner': 'group:default/ghost' }),
    )

    expect(findUnknowns(result.plan)).toContain(OWNER_PATH)
  })

  it('protects nothing when a different value was answered there', () => {
    const result = deriveOwners(
      planOf(undetermined),
      OWNERS,
      userSaid(INTENT, { [OWNER_PATH]: 'group:default/lynx' }),
    )

    expect(findUnknowns(result.plan)).toContain(OWNER_PATH)
  })

  it('reads the words from the provenance, never from the plan it is handed', () => {
    // The plan's own `intent` arrives with the plan, from whoever drafted it.
    // A sentence naming the owner there protects nothing.
    const result = deriveOwners(
      planOf(access({ owner: 'group:default/lynx' }), `${INTENT}, owned by group:default/lynx`),
      OWNERS,
      userSaid(INTENT),
    )

    expect(ownerOf(result.plan)).toBe('group:default/tiger')
  })
})
