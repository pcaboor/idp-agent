import { describe, expect, it } from 'vitest'
import { renderUnifiedDiff, type FileEdit } from '../../src/core/diff/unified.js'
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
  // A person's own request, which is what every fixture here models.
  wordsOf: 'user',
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
  // The level is asked, never read out of the request, so a fixture that
  // wants a complete plan answers for it — which is what a run does.
  answered: new Set(['read']),
  ...over,
})

const sign = (intent: string, operations: unknown[]) => {
  const result = signPlan(planSchema.parse({ intent, operations }), context())
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

const CREATE_INTENT = 'give billing-api read access to orders-db in prod'

const access = {
  kind: 'Resource' as const,
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access' as const, access: 'read',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'],
    dependencyOf: ['component:default/billing-api'],
  },
}

const createAccess = { op: 'create-entity' as const, entity: access }

/** What signPlan computes for `access`. Asserted below, never assumed. */
const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'

/** No `access:` line at all — §4.1's unstated level, a third answer again. */
const NO_LEVEL = ''

/**
 * A grant as the repository holds it. The level is a parameter because
 * "already declared" is about what the file SAYS, not about a name it happens
 * to carry.
 */
const document = (
  name: string,
  consumers: readonly string[],
  level: string = 'read',
): string =>
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
    ...(level === NO_LEVEL ? [] : [`  access: ${level}`]),
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

  it('carries the level a grant states through into the bytes', () => {
    // `materialise` copies the spec wholesale, so the level reaching the file
    // is a fact about the translation rather than a field anyone listed twice.
    // The round trip is what proves it: `entitySchema` refuses a level it does
    // not recognise, so the parse is the assertion.
    const granting = {
      op: 'create-entity' as const,
      entity: { ...access, spec: { ...access.spec, access: 'read' as const } },
    }
    const edits = planEdits(
      sign('give billing-api read access to orders-db in prod', [granting]),
      repository([]),
    ).edits
    const entity = parseEntity(at(edits, 0).after.slice('---\n'.length))

    expect(entity.kind === 'Resource' && entity.spec.access).toBe('read')
    expect(at(edits, 0).after).toContain('  access: read\n')
  })

  it('writes no bytes at all for a grant whose level is still a question', () => {
    // Absent is no longer reachable here — the proposal schema refuses a
    // levelled right that states nothing, so the only honest way to say "I do
    // not know" is `{unknown}`, and an operation carrying one produces no
    // edit. A default written at this layer would be a grant nobody asked for,
    // arriving through the one path that writes bytes.
    const unsure = {
      ...access,
      spec: { ...access.spec, access: { unknown: 'read or write?' } },
    }
    const { edits, dropped } = planEdits(sign(CREATE_INTENT, [
      { op: 'create-entity' as const, entity: unsure },
    ]), repository([]))

    expect(edits).toEqual([])
    expect(dropped[0]?.reason).toContain('question')
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
    // Already declared means the file states the same GRANT — same level, not
    // merely the same name.
    const existing = document('billing-api-orders-db-prod', [], 'read')
    const edits = planEdits(sign(CREATE_INTENT, [createAccess]), repository([[ACCESS_PATH, existing]])).edits

    expect(edits).toHaveLength(1)
    expect(at(edits, 0).before).toBe(existing)
    expect(at(edits, 0).after).toBe(existing)
  })

  it('produces no bytes when the file declares that grant at another level', () => {
    // The falsehood this closes: a name match with a different level came out
    // as an EMPTY diff and "the repository already says it", so a requested
    // narrowing silently did not happen. Appending cannot rewrite a scalar, so
    // there is no honest edit to show — and the operation is named, never
    // dropped in silence.
    const wider = document('billing-api-orders-db-prod', [], 'readwrite')
    const { edits, dropped } = planEdits(
      sign(CREATE_INTENT, [createAccess]),
      repository([[ACCESS_PATH, wider]]),
    )

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toContain('readwrite')
    expect(dropped[0]?.reason).toContain('read')
  })

  it('produces no bytes when the file declares that grant with no level at all', () => {
    // §4.1: an unstated level is unstated, never read as anything. A file that
    // states none does not already say `read`.
    const unstated = document('billing-api-orders-db-prod', [], NO_LEVEL)
    const { edits, dropped } = planEdits(
      sign(CREATE_INTENT, [createAccess]),
      repository([[ACCESS_PATH, unstated]]),
    )

    expect(edits).toEqual([])
    expect(dropped[0]?.reason).toMatch(/states no level|no level/)
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
          'component:default/billing-api',
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

describe('planEdits writes what was signed, and only that', () => {
  it('cannot be handed a signed plan whose contents moved after signing', () => {
    // The audit's reproduction, inverted. `Plan` is `z.infer<…>` and mutable
    // and `SignedPlan` marks only its own fields readonly, so this assignment
    // used to compile, run, and put `group:default/nobody-vouched-for-this`
    // into the bytes — while `classified` went on reporting the owner the
    // signature had vouched for. The brand said this object was signed once;
    // it did not say it still held what was signed.
    const signed = sign(CREATE_INTENT, [createAccess])
    const operation = signed.plan.operations[0]
    if (operation?.op !== 'create-entity' || operation.entity.kind !== 'Resource') {
      throw new Error('the fixture is a Resource creation')
    }

    expect(() => {
      operation.entity.spec.owner = 'group:default/nobody-vouched-for-this'
    }).toThrow(TypeError)

    const { edits, dropped } = planEdits(signed, repository([]))

    expect(dropped).toEqual([])
    expect(at(edits, 0).after).toContain('owner: group:default/tiger')
    expect(at(edits, 0).after).not.toContain('nobody-vouched-for-this')
  })
})

describe('what the diff of an update can and cannot state', () => {
  it('writes the consumer and not the level, because the level is a claim about the file', () => {
    // §5.3 put `access` in the patch so the signature can classify it and
    // `declared-level-mismatch` can compare it. It is a CLAIM about the grant
    // being extended, not a value to write: the grant already states its level
    // and this tool only appends (§4.3), so an operation stating `read` against
    // a file granting `read` leaves that line exactly as it found it. Green
    // before the field existed and green after — which is the point: adding a
    // field to the operation must not add a byte to the repository.
    // Its own intent, naming the level: `AMEND_INTENT` names none, so the
    // signature would turn `read` into a question and `planEdits` would drop
    // the operation — which is the ask loop working, not the case under test.
    const signed = sign('let billing-api share the checkout read access too', [
      { ...addConsumer('component:default/billing-api'), patch: {
        patch: 'add-dependency-of' as const,
        consumer: 'component:default/billing-api',
        access: 'read',
      } },
    ])

    const { edits, dropped } = planEdits(signed, repository([[AMEND_PATH, AMEND_FILE]]))

    expect(dropped).toEqual([])
    const after = at(edits, 0).after
    expect(after).toContain('    - component:default/billing-api')
    // One level line, the one that was already there.
    expect(after.match(/^ {2}access:/gm)).toHaveLength(1)
    expect(after).toContain('  access: read')
  })


  it('shows the consumer it adds, and cannot show the level that consumer receives', () => {
    // The honest limit, asserted rather than implied. `appendSequenceItem`
    // appends one item to a sequence and nothing in the surgery layer rewrites
    // a scalar (§4.3), so `access:` is an unchanged line — and `ordered()`
    // files it above `owner`, `dependsOn` and `dependencyOf`, which is further
    // from the insertion than the three lines of context a unified diff
    // carries. So the level cannot reach the hunk, and this is what the
    // `declared-level-mismatch` policy and the Reviewer's operation JSON exist
    // to cover: the reviewer of the merge request sees one added consumer line
    // under `dependencyOf:`, and the authorisation it joins is not in front of
    // them.
    const signed = sign(AMEND_INTENT, [addConsumer('component:default/billing-api')])

    const { edits } = planEdits(signed, repository([[AMEND_PATH, AMEND_FILE]]))
    const diff = renderUnifiedDiff(edits)

    expect(diff).toContain('+    - component:default/billing-api')
    expect(diff).not.toContain('access:')
  })
})

describe('planEdits reads back what it wrote', () => {
  // The guarantee, stated where it is tested: an edit is offered only when the
  // parser, reading the bytes back, finds the operation carried out and
  // nothing else changed. The surgery is a line-level heuristic underneath;
  // this is what makes a wrong guess a named drop instead of a wrong diff, or
  // an unchanged file that reads as "already listed".
  const billingApi = addConsumer('component:default/billing-api')

  it('drops an update whose target only the parser can find, and leaves the file alone', () => {
    // A flow-mapping `metadata`: the parser reads the entity, a line edit
    // cannot find it. That used to be before === after — "nothing to change".
    const file = [
      '---',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata: {name: checkout-orders-db-prod, annotations: {company.fr/env: prod}}',
      'spec:',
      '  type: database-access',
      '  access: read',
      '  owner: group:default/tiger',
      '  dependencyOf:',
      '    - component:default/checkout-web',
      '',
    ].join('\n')

    const { edits, dropped } = planEdits(sign(AMEND_INTENT, [billingApi]), repository([[AMEND_PATH, file]]))

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toContain(AMEND_PATH)
    expect(dropped[0]?.reason).toContain('component:default/billing-api')
  })

  it('drops an update the surgery carried to the wrong document', () => {
    // Two entities of one name and two kinds in one file. `planEdits` resolves
    // the RESOURCE by its full reference; the surgery finds documents by name
    // and amends the first — the Component. The bytes change and the grant
    // does not: only reading them back can tell.
    const component = [
      '---',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: checkout-orders-db-prod',
      'spec:',
      '  type: service',
      '  lifecycle: production',
      '  owner: group:default/tiger',
      '',
    ].join('\n')
    const file = `${component}\n${AMEND_FILE}`

    const { edits, dropped } = planEdits(sign(AMEND_INTENT, [billingApi]), repository([[AMEND_PATH, file]]))

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toContain(AMEND_PATH)
  })

  it('reports a consumer the parser reads as listed as already done, in any shape', () => {
    // A flow sequence the surgery refuses to split — and does not need to: the
    // consumer is there. Already done is an unchanged file, not a drop.
    const file = AMEND_FILE.replace(
      '  dependencyOf:\n    - component:default/checkout-web',
      '  dependencyOf: [component:default/checkout-web, component:default/billing-api]',
    )

    const { edits, dropped } = planEdits(sign(AMEND_INTENT, [billingApi]), repository([[AMEND_PATH, file]]))

    expect(dropped).toEqual([])
    expect(edits).toHaveLength(1)
    expect(at(edits, 0).after).toBe(file)
  })

  it('names the file when the surgery refuses a shape', () => {
    const file = AMEND_FILE.replace(
      '  dependencyOf:\n    - component:default/checkout-web',
      '  dependencyOf: [component:default/checkout-web]',
    )

    const { edits, dropped } = planEdits(sign(AMEND_INTENT, [billingApi]), repository([[AMEND_PATH, file]]))

    expect(edits).toEqual([])
    expect(dropped[0]?.reason).toContain(AMEND_PATH)
    expect(dropped[0]?.reason).toContain('flow sequence')
  })

  it('drops a creation whose file would not read back', () => {
    // The file at the computed path already holds a document the parser
    // faults. Appending beside it produces bytes nobody can vouch for, so the
    // creation is named and the file is left alone.
    const broken = `${document('other-access', [])}  owner: group:default/lion\n`

    const { edits, dropped } = planEdits(
      sign(CREATE_INTENT, [createAccess]),
      repository([[ACCESS_PATH, broken]]),
    )

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toContain(ACCESS_PATH)
    expect(dropped[0]?.reason).toContain('DUPLICATE_KEY')
  })
})

describe('planEdits, beside a document the parser faults', () => {
  // A duplicate key in a SIBLING document says nothing about whether the
  // target lists the consumer. Read as one, the file answered "not listed" for
  // a consumer that was, and the unchanged file was then dropped as "the edit
  // left the file as it was" — a plan told the repository did not say what it
  // said.
  const billingApi = addConsumer('component:default/billing-api')
  const brokenSibling = [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: sibling-access',
    '  name: sibling-access-again',
    '',
  ].join('\n')

  it('reports a consumer the target already lists as already done', () => {
    const file = `${document('checkout-orders-db-prod', [
      'component:default/checkout-web',
      'component:default/billing-api',
    ])}\n${brokenSibling}`

    const { edits, dropped } = planEdits(
      sign(AMEND_INTENT, [billingApi]),
      repository([[AMEND_PATH, file]]),
    )

    expect(dropped).toEqual([])
    expect(edits).toEqual([{ path: AMEND_PATH, before: file, after: file }])
  })

  it('names the fault the file already had, rather than blaming the edit', () => {
    const file = `${AMEND_FILE}\n${brokenSibling}`

    const { edits, dropped } = planEdits(
      sign(AMEND_INTENT, [billingApi]),
      repository([[AMEND_PATH, file]]),
    )

    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toContain('the file does not parse')
    expect(dropped[0]?.reason).toContain('DUPLICATE_KEY')
  })
})

describe('planEdits, amending an entity that carries no consumers', () => {
  // The line reads back as YAML, and the entity schema strips it: a Component
  // has no `dependencyOf`. Comparing raw values let it through, and a second
  // run — asking the schema whether the consumer was listed — found it not
  // listed, then found the line, and dropped what it had just offered.
  const path = 'catalog/components/checkout-web.yml'
  const file = [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    '  name: checkout-web',
    'spec:',
    '  type: service',
    '  lifecycle: production',
    '  owner: group:default/tiger',
    '',
  ].join('\n')
  const onComponent = {
    op: 'update-entity' as const,
    entityRef: 'component:default/checkout-web',
    patch: { patch: 'add-dependency-of' as const, consumer: 'component:default/billing-api' },
  }

  it('drops the operation, naming why, and gives the same answer every time', () => {
    const signed = sign(AMEND_INTENT, [onComponent])
    const first = planEdits(signed, repository([[path, file]]))

    expect(first.edits).toEqual([])
    expect(first.dropped).toHaveLength(1)
    expect(first.dropped[0]?.reason).toContain(path)
    expect(first.dropped[0]?.reason).toContain('only a Resource lists its consumers')
    expect(planEdits(signed, repository([[path, file]]))).toEqual(first)
  })
})
