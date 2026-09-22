import { describe, expect, it } from 'vitest'
import type { FileEdit } from '../../src/core/diff/unified.js'
import { planEdits } from '../../src/core/plan/edits.js'
import type { SignatureContext } from '../../src/core/plan/sign.js'
import { signPlan } from '../../src/core/plan/sign.js'
import { findUnknowns, planSchema } from '../../src/core/schemas/plan.js'
import { parseEntity } from '../../src/core/yaml/serialize.js'
import { listDocumentNames } from '../../src/core/yaml/surgery.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api', 'service'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger'],
}

const context = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: new Set([
    'resource:default/orders-db-prod',
    'resource:default/checkout-orders-db-prod',
    'component:default/checkout-web',
    'component:default/billing-api',
    'component:default/payments-api',
  ]),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
  ...over,
})

const sign = (intent: string, operations: unknown[]) => {
  const result = signPlan(planSchema.parse({ intent, operations }), context())
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

const CREATE_INTENT = 'give billing-api access to orders-db in prod'

const access = {
  kind: 'Resource' as const,
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access' as const,
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'],
  },
}

const createAccess = { op: 'create-entity' as const, entity: access }

/** What signPlan computes for `access`. Asserted below, never assumed. */
const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'

const document = (name: string, consumers: readonly string[]): string =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    `  name: ${name}`,
    '  annotations:',
    '    company.fr/env: prod',
    'spec:',
    '  type: database-access',
    '  owner: group:default/tiger',
    '  dependsOn:',
    '    - resource:default/orders-db-prod',
    ...(consumers.length > 0
      ? ['  dependencyOf:', ...consumers.map((consumer) => `    - ${consumer}`)]
      : []),
    '',
  ].join('\n')

const AMEND_PATH = 'dependencies/access/checkout-orders-db-prod.yml'
const AMEND_FILE = document('checkout-orders-db-prod', ['component:default/checkout-web'])
const AMEND_INTENT = 'let billing-api and payments-api share the checkout access too'

const addConsumer = (consumer: string) => ({
  op: 'update-entity' as const,
  entityRef: 'resource:default/checkout-orders-db-prod',
  patch: { patch: 'add-dependency-of' as const, consumer },
})

const repository = (entries: Array<[string, string]>): ReadonlyMap<string, string> =>
  new Map(entries)

const at = (edits: readonly FileEdit[], index: number): FileEdit => {
  const edit = edits[index]
  if (edit === undefined) throw new Error(`no edit at ${index}; got ${edits.length}`)
  return edit
}

describe('planEdits, creating an entity', () => {
  it('writes the serialised entity at the path the engine signed', () => {
    const signed = sign(CREATE_INTENT, [createAccess])
    expect(signed.paths.get(0)).toBe(ACCESS_PATH)

    const edits = planEdits(signed, repository([])).edits

    expect(edits).toHaveLength(1)
    expect(at(edits, 0).path).toBe(ACCESS_PATH)
    expect(at(edits, 0).before).toBeUndefined()
    expect(at(edits, 0).after.startsWith('---\n')).toBe(true)
    expect(listDocumentNames(at(edits, 0).after)).toEqual(['billing-api-orders-db-prod'])
  })

  it('produces bytes that read back as an entity, translation and all', () => {
    // The seam, asserted rather than described: a proposal carries
    // `metadata.env` and no apiVersion, and an entity carries neither of
    // those. If the translation were missing, entitySchema would say so here.
    const edits = planEdits(sign(CREATE_INTENT, [createAccess]), repository([])).edits
    const entity = parseEntity(at(edits, 0).after.slice('---\n'.length))

    expect(entity.apiVersion).toBe('backstage.io/v1alpha1')
    expect(entity.metadata.annotations['company.fr/env']).toBe('prod')
    expect(entity.metadata).not.toHaveProperty('env')
  })

  it('appends to a file that already holds another document', () => {
    const existing = document('other-access', [])
    const edits = planEdits(sign(CREATE_INTENT, [createAccess]), repository([[ACCESS_PATH, existing]])).edits

    expect(at(edits, 0).before).toBe(existing)
    // Appended, never rebuilt: what was there is still there, byte for byte,
    // which is the whole premise of the surgery layer (§4.3).
    expect(at(edits, 0).after.startsWith(existing)).toBe(true)
    expect(listDocumentNames(at(edits, 0).after)).toEqual([
      'other-access',
      'billing-api-orders-db-prod',
    ])
  })

  it('still produces an edit when the entity is already declared there', () => {
    // An empty diff, not an absent one. "Nothing to do" and "the operation was
    // dropped" are different answers and the caller has to tell them apart.
    const existing = document('billing-api-orders-db-prod', [])
    const edits = planEdits(sign(CREATE_INTENT, [createAccess]), repository([[ACCESS_PATH, existing]])).edits

    expect(edits).toHaveLength(1)
    expect(at(edits, 0).before).toBe(existing)
    expect(at(edits, 0).after).toBe(existing)
  })

  it('contributes nothing when the operation still carries a question', () => {
    const undecided = {
      op: 'create-entity' as const,
      entity: { ...access, spec: { ...access.spec, type: { unknown: 'which kind of access?' } } },
    }
    const signed = sign(CREATE_INTENT, [undecided])

    expect(signed.paths.has(0)).toBe(false)
    expect(planEdits(signed, repository([])).edits).toEqual([])
  })

  it('contributes nothing for a component, which the engine computes no path for', () => {
    const component = {
      op: 'create-entity' as const,
      entity: {
        kind: 'Component' as const,
        metadata: { name: 'billing-api' },
        spec: {
          type: 'service',
          lifecycle: 'production' as const,
          owner: 'group:default/tiger',
        },
      },
    }
    const signed = sign('register the production billing-api service', [component])

    expect(findUnknowns(signed.plan)).toEqual([])
    expect(signed.paths.has(0)).toBe(false)
    expect(planEdits(signed, repository([])).edits).toEqual([])
  })
})

describe('planEdits, amending an entity', () => {
  it('adds the consumer as one line in the existing file', () => {
    const signed = sign(AMEND_INTENT, [addConsumer('component:default/billing-api')])
    const edits = planEdits(signed, repository([[AMEND_PATH, AMEND_FILE]])).edits

    expect(edits).toHaveLength(1)
    expect(at(edits, 0).path).toBe(AMEND_PATH)
    expect(at(edits, 0).before).toBe(AMEND_FILE)
    expect(at(edits, 0).after).toContain('    - component:default/billing-api')
    expect(at(edits, 0).after).toContain('    - component:default/checkout-web')
    expect(at(edits, 0).after.split('\n')).toHaveLength(AMEND_FILE.split('\n').length + 1)
  })

  it('still produces an edit when the consumer is already listed', () => {
    const signed = sign(AMEND_INTENT, [addConsumer('component:default/checkout-web')])
    const edits = planEdits(signed, repository([[AMEND_PATH, AMEND_FILE]])).edits

    expect(edits).toHaveLength(1)
    expect(at(edits, 0).after).toBe(at(edits, 0).before)
  })

  it('contributes nothing when no file declares the entity', () => {
    const signed = sign(AMEND_INTENT, [addConsumer('component:default/billing-api')])
    expect(planEdits(signed, repository([])).edits).toEqual([])
  })
})

describe('planEdits, two operations on one file', () => {
  it('emits ONE edit for the file, carrying both operations', () => {
    // The defect this design invites, twice over. Reading both operations from
    // the bytes handed in would make the second silently discard the first —
    // and emitting one edit per operation produces two `--- a/<path>` sections
    // for one file, the second hunk numbered against the intermediate buffer
    // rather than the repository, which `patch` garbles. A diff is a statement
    // about a file, not about the work that produced it.
    const signed = sign(AMEND_INTENT, [
      addConsumer('component:default/billing-api'),
      addConsumer('component:default/payments-api'),
    ])
    const edits = planEdits(signed, repository([[AMEND_PATH, AMEND_FILE]])).edits

    expect(edits).toHaveLength(1)
    expect(at(edits, 0).before).toBe(AMEND_FILE)

    const final = at(edits, 0).after
    expect(final).toContain('    - component:default/checkout-web')
    expect(final).toContain('    - component:default/billing-api')
    expect(final).toContain('    - component:default/payments-api')
    expect(final.split('\n')).toHaveLength(AMEND_FILE.split('\n').length + 2)
  })

  it('lets a second creation see what the first one wrote', () => {
    const signed = sign(CREATE_INTENT, [createAccess, createAccess])
    const edits = planEdits(signed, repository([])).edits

    // One file, one edit — and the second operation finds the entity already
    // there, so it adds nothing rather than declaring it twice.
    expect(edits).toHaveLength(1)
    expect(at(edits, 0).before).toBeUndefined()
    expect(listDocumentNames(at(edits, 0).after)).toEqual(['billing-api-orders-db-prod'])
  })
})

describe('planEdits, as a pure function', () => {
  it('neither touches the map it is handed nor disagrees with itself', () => {
    const before = new Map([[AMEND_PATH, AMEND_FILE]])
    const signed = sign(AMEND_INTENT, [
      addConsumer('component:default/billing-api'),
      addConsumer('component:default/payments-api'),
    ])

    const first = planEdits(signed, before).edits
    const second = planEdits(signed, before).edits

    expect(second).toEqual(first)
    expect(before.size).toBe(1)
    expect(before.get(AMEND_PATH)).toBe(AMEND_FILE)
  })
})

describe('create-catalog-info', () => {
  it('contributes nothing: its path is not one the engine computed', () => {
    // §5.2, the rule the proposal schema is built around — the engine chooses
    // where bytes go. `repoPath` names a file in the service's own repository,
    // which this edit set does not describe, and signPlan computes no path for
    // it. Dropped on purpose, not for want of an answer: nothing here is asked.
    const signed = sign(
      'add a catalog-info at apps/checkout-web for the production checkout-web service',
      [
        {
          op: 'create-catalog-info',
          repoPath: 'apps/checkout-web',
          entity: {
            kind: 'Component',
            metadata: { name: 'checkout-web' },
            spec: {
              type: 'service',
              lifecycle: 'production',
              owner: 'group:default/tiger',
            },
          },
        },
      ],
    )

    expect(findUnknowns(signed.plan)).toEqual([])
    expect(planEdits(signed, repository([])).edits).toEqual([])
  })
})

describe('planEdits, what it refuses to do quietly', () => {
  it('resolves an update by the full reference, kind included', () => {
    // `component:default/x` and `resource:default/x` are two entities.
    // Resolving by the bare name let an operation naming one patch the other:
    // a Component reference amending a Resource, in silence.
    const asComponent = {
      op: 'update-entity' as const,
      entityRef: 'component:default/checkout-orders-db-prod',
      patch: { patch: 'add-dependency-of' as const, consumer: 'component:default/billing-api' },
    }
    const signed = signPlan(
      planSchema.parse({ intent: AMEND_INTENT, operations: [asComponent] }),
      context({
        witnessed: new Set([
          'component:default/checkout-orders-db-prod',
          'component:default/billing-api',
        ]),
      }),
    )
    if ('outcome' in signed) throw new Error('refused')

    // The file declares a RESOURCE of that name. A Component reference must
    // not reach it — and must say so rather than vanishing.
    const { edits, dropped } = planEdits(signed, repository([[AMEND_PATH, AMEND_FILE]]))

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toContain('component:default/checkout-orders-db-prod')
  })

  it('names an operation it could not carry out, rather than dropping it', () => {
    // "This plan grants nothing" and "nothing to change" are the same sentence
    // for opposite facts. An operation that produces no bytes has to be stated.
    const missing = {
      op: 'update-entity' as const,
      entityRef: 'resource:default/orders-db-prod',
      patch: { patch: 'add-dependency-of' as const, consumer: 'component:default/billing-api' },
    }
    const signed = sign('let billing-api consume orders-db in prod', [missing])

    const { edits, dropped } = planEdits(signed, repository([]))

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.opIndex).toBe(0)
    expect(dropped[0]?.reason).toMatch(/declared in no file/)
  })

  it('lets an update patch an entity the same plan creates', () => {
    // Order matters and the plan states it. An update naming an entity created
    // earlier in the same plan used to be dropped in silence, so the preview
    // showed the creation without the grant that was the point of asking.
    const patchIt = {
      op: 'update-entity' as const,
      entityRef: 'resource:default/billing-api-orders-db-prod',
      patch: { patch: 'add-dependency-of' as const, consumer: 'component:default/payments-api' },
    }
    const signed = signPlan(
      planSchema.parse({ intent: CREATE_INTENT, operations: [createAccess, patchIt] }),
      context({
        witnessed: new Set([
          'resource:default/orders-db-prod',
          'resource:default/billing-api-orders-db-prod',
          'component:default/payments-api',
        ]),
      }),
    )
    if ('outcome' in signed) throw new Error('refused')

    const { edits, dropped } = planEdits(signed, repository([]))

    expect(dropped).toEqual([])
    expect(edits).toHaveLength(1)
    expect(at(edits, 0).after).toContain('- component:default/payments-api')
  })

  it('reports a create-catalog-info instead of omitting it', () => {
    // It writes into the service's own repository, not this one — the omission
    // is the rule, not a gap. But an operation contributing no bytes must
    // never be invisible.
    const catalogInfo = {
      op: 'create-catalog-info' as const,
      repoPath: 'catalog-info.yaml',
      entity: {
        kind: 'Component' as const,
        metadata: { name: 'billing-api' },
        spec: {
          type: 'service',
          lifecycle: 'production',
          owner: 'group:default/tiger',
        },
      },
    }
    // Every leaf spelled out in the request, repoPath included: a path a model
    // wrote is exactly what §5.2 forbids following, so an unspoken one is a
    // question and this branch would never be reached.
    const signed = sign(
      'add a production catalog-info.yaml for billing-api, a service in prod',
      [catalogInfo],
    )

    const { edits, dropped } = planEdits(signed, repository([]))

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toContain('service repository')
  })
})
