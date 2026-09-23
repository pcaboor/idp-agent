import { describe, expect, it } from 'vitest'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import { summariseGraph } from '../../src/context/graph/summary.js'
import { deriveOwners } from '../../src/core/plan/derive.js'
import { signPlan, type SignatureContext } from '../../src/core/plan/sign.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { findUnknowns, planSchema, type Plan } from '../../src/core/schemas/plan.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'

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

const UNSTATED = { unknown: 'the request does not state an owner for this access' }

const planOf = (entity: unknown, intent = INTENT): Plan =>
  planSchema.parse({ intent, operations: [{ op: 'create-entity', entity }] })

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
    const result = deriveOwners(planOf(access()), OWNERS)

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
    const result = deriveOwners(
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
    const result = deriveOwners(
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
    const result = deriveOwners(planOf(access({ dependencyOf: [] })), OWNERS)

    expect(ownerOf(result.plan)).toEqual(UNSTATED)
    expect(result.derived).toEqual([])
    // Not contested: nothing disagreed. There was simply nothing to read.
    expect(result.contested).toEqual([])
  })

  it('never derives for an object, however many consumers it lists', () => {
    // A right's owner follows from who reaches through it. Nobody knows who
    // owns a database that does not exist yet, and the consumer list on an
    // object is not evidence — `resourceSchema` refuses one outright on disk.
    const result = deriveOwners(
      planOf({
        kind: 'Resource',
        metadata: { name: 'orders-db-staging', env: 'staging' },
        spec: {
          type: 'database',
          owner: UNSTATED,
          dependencyOf: ['component:default/billing-api'],
        },
      }),
      OWNERS,
    )

    expect(ownerOf(result.plan)).toEqual(UNSTATED)
    expect(result.derived).toEqual([])
  })

  it('never derives for a Component', () => {
    const result = deriveOwners(
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

  it('never overwrites a stated owner', () => {
    // The request said it, and that is the stronger claim. Even when the
    // consumer declares something else — especially then.
    const result = deriveOwners(
      planOf(
        access({
          owner: 'group:default/lynx',
          dependencyOf: ['component:default/billing-api'],
        }),
      ),
      OWNERS,
    )

    expect(ownerOf(result.plan)).toBe('group:default/lynx')
    expect(result.derived).toEqual([])
    expect(result.contested).toEqual([])
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

    expect(ownerOf(deriveOwners(bare, OWNERS).plan)).toBe('group:default/tiger')
  })

  it('leaves the plan it was handed untouched', () => {
    const plan = planOf(access())
    const before = JSON.stringify(plan)

    deriveOwners(plan, OWNERS)

    expect(JSON.stringify(plan)).toBe(before)
  })
})

describe('what the signature then says about it', () => {
  it('signs the derived owner with no question on it', () => {
    // The real signer, not an assertion about the class by hand: the whole
    // claim is that the value passes THIS gate, and a hand-written expectation
    // about `enumerated` would still hold on the day it stopped being true.
    const derived = deriveOwners(planOf(access()), OWNERS)
    const signed = signPlan(derived.plan, context())
    if ('outcome' in signed) throw new Error(`refused: ${JSON.stringify(signed.refusals)}`)

    expect(findUnknowns(signed.plan)).toEqual([])
    expect(signed.classified.find((leaf) => leaf.path === OWNER_PATH)?.class).toBe('enumerated')
  })

  it('still asks when nothing could be derived', () => {
    // The gate the measured runs stopped on, unchanged for the case the rules
    // refuse to answer: an access with no consumer is still a question.
    const derived = deriveOwners(planOf(access({ dependencyOf: [] })), OWNERS)
    const signed = signPlan(derived.plan, context())
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

    const result = deriveOwners(planOf(access), OWNERS)

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

    const result = deriveOwners(planOf(access), OWNERS)

    expect(result.derived).toHaveLength(1)
    expect(result.derived[0]?.owner).toBe('group:default/tiger')
  })
})
