import { describe, expect, it } from 'vitest'
import { checkPolicies } from '../../src/core/plan/policies.js'
import type { PolicyContext, PolicyViolation } from '../../src/core/plan/policies.js'
import { signPlan } from '../../src/core/plan/sign.js'
import type { SignatureContext, SignedPlan } from '../../src/core/plan/sign.js'
import { findUnknowns, planSchema } from '../../src/core/schemas/plan.js'
import type { AccessLevel } from '../../src/core/schemas/resource-types.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger', 'group:default/common'],
}

const signature = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: new Set([
    'resource:default/orders-db-prod',
    'resource:default/orders-db-dev',
    'component:default/billing-api',
    // The grants an update-entity joins someone to. Witnessed, or the signer
    // turns the reference into a question and no policy is ever reached.
    'resource:default/checkout-orders-db-prod',
    'resource:default/checkout-orders-db-dev',
    'resource:default/payments-orders-db-prod',
    // Written before `spec.access` existed, so it declares no level at all.
    'resource:default/legacy-orders-db-prod',
  ]),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
  ...over,
})

const policies = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  vocabulary,
  witnesses: new Set(['dependencies/access', 'dependencies/databases', 'systems']),
  environments: new Map([
    ['resource:default/orders-db-prod', 'prod'],
    ['resource:default/orders-db-dev', 'dev'],
    ['component:default/billing-api', 'prod'],
    ['resource:default/checkout-orders-db-prod', 'prod'],
    ['resource:default/checkout-orders-db-dev', 'dev'],
    ['resource:default/payments-orders-db-prod', 'prod'],
    ['resource:default/legacy-orders-db-prod', 'prod'],
  ]),
  levels: new Map<string, AccessLevel | undefined>([
    ['resource:default/checkout-orders-db-prod', 'read'],
    ['resource:default/checkout-orders-db-dev', 'read'],
    ['resource:default/payments-orders-db-prod', 'readwrite'],
    // Declared, and stating no level: `has` is true and `get` is undefined,
    // which is §4.1's unstated level and not a grant of `read`.
    ['resource:default/legacy-orders-db-prod', undefined],
  ]),
  ...over,
})

const sign = (entity: unknown, intent: string, over: Partial<SignatureContext> = {}): SignedPlan => {
  const parsed = planSchema.parse({ intent, operations: [{ op: 'create-entity', entity }] })
  const result = signPlan(parsed, signature(over))
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

/**
 * An update joining `consumer` to a grant that already exists, stating the
 * level that grant grants (§5.3). `access` omitted means the operation claims
 * the grant states none — a claim, not a gap, and one the policy checks.
 */
const joining = (entityRef: string, consumer: string, access?: unknown) => ({
  op: 'update-entity' as const,
  entityRef,
  patch: {
    patch: 'add-dependency-of' as const,
    consumer,
    ...(access === undefined ? {} : { access }),
  },
})

const signUpdate = (
  entityRef: string,
  consumer: string,
  intent: string,
  access?: unknown,
): SignedPlan => {
  const parsed = planSchema.parse({ intent, operations: [joining(entityRef, consumer, access)] })
  const result = signPlan(parsed, signature())
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

const of = (violations: readonly PolicyViolation[], policy: string): PolicyViolation | undefined =>
  violations.find((violation) => violation.policy === policy)

const accessIn = (env: string, dependsOn: string[] = []) => ({
  kind: 'Resource' as const,
  metadata: { name: `billing-api-orders-db-${env}`, env },
  spec: {
    type: 'database-access' as const, access: 'read',
    owner: 'group:default/tiger',
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  },
})

describe('environment-mismatch', () => {
  it('refuses a plan that touches prod when the intent named dev', () => {
    // The design's own example of what Zod cannot catch and a Reviewer was
    // meant to. It is deterministic, so it does not need a model.
    const signed = sign(
      { ...accessIn('dev'), metadata: { name: 'billing-api-orders-db-prod', env: 'dev' } },
      'give billing-api read access to orders-db in dev',
    )

    const violations = checkPolicies(signed, policies())

    expect(violations[0]?.policy).toBe('environment-mismatch')
    expect(violations[0]?.message).toContain('prod')
  })

  it('says nothing when the intent names no environment', () => {
    // Declare, never infer: silence in the request is not permission, but it
    // is not a violation either. The signer already turned it into a question,
    // and a policy that fired here would report the same thing twice.
    const signed = sign(accessIn('prod'), 'give billing-api read access to orders-db')

    expect(checkPolicies(signed, policies())).toEqual([])
  })

  it('says nothing when every environment in the plan is the one asked for', () => {
    const signed = sign(accessIn('prod'), 'give billing-api read access to orders-db in prod')

    expect(checkPolicies(signed, policies())).toEqual([])
  })
})

describe('unwitnessed-folder', () => {
  it('refuses writing into a folder with no witness', () => {
    // A folder without a witness is a folder the repository never declared.
    // Writing there invents structure, which is what §7.2 forbids.
    const signed = sign(accessIn('prod'), 'give billing-api read access to orders-db in prod')

    const violations = checkPolicies(signed, policies({ witnesses: new Set(['systems']) }))

    expect(violations.map((violation) => violation.policy)).toContain('unwitnessed-folder')
    expect(violations[0]?.message).toContain('dependencies/access')
  })
})

describe('cross-environment-consumer', () => {
  it('refuses a dev access declaring a prod consumer', () => {
    // Being authorised in dev grants nothing in staging (§4.1). An access
    // whose environment differs from its consumer's is the shape of that bug.
    const signed = sign(
      accessIn('dev', ['resource:default/orders-db-prod']),
      'give billing-api read access to orders-db in dev',
    )

    const violations = checkPolicies(signed, policies())

    expect(violations.map((violation) => violation.policy)).toContain(
      'cross-environment-consumer',
    )
  })

  it('says nothing when the reference lives in the same environment', () => {
    const signed = sign(
      accessIn('dev', ['resource:default/orders-db-dev']),
      'give billing-api read access to orders-db in dev',
    )

    expect(checkPolicies(signed, policies())).toEqual([])
  })

  it('says nothing about a reference the repository has never seen', () => {
    // An unknown reference is dangling-reference's business, and CI already
    // runs that rule. A policy guessing here would report a second, worse
    // version of a violation the repository states precisely.
    const signed = sign(
      accessIn('dev', ['resource:default/ghost']),
      'give billing-api read access to orders-db in dev',
      { witnessed: new Set(['resource:default/ghost']) },
    )

    expect(checkPolicies(signed, policies())).toEqual([])
  })
})

describe('the policies, over an update-entity', () => {
  // The operation that hands an EXISTING authorisation to someone new used to
  // travel ungated: the loop skipped anything that was not a creation, so the
  // one operation §4.1 is most about met no gate at all.

  it('refuses an update joining a prod grant when the request named dev', () => {
    const signed = signUpdate(
      'resource:default/checkout-orders-db-prod',
      'component:default/billing-api',
      'let billing-api use the checkout access to orders-db in dev',
    )

    const violation = of(checkPolicies(signed, policies()), 'environment-mismatch')

    // The engine's own dotted path, as every other violation carries.
    expect(violation?.path).toBe('operations.0.entityRef')
    expect(violation?.message).toContain('prod')
  })

  it('refuses joining a prod consumer to a dev grant', () => {
    // Being authorised in dev grants nothing in prod (§4.1), and an update is
    // where that is decided for a consumer nobody re-declares.
    const signed = signUpdate(
      'resource:default/checkout-orders-db-dev',
      'component:default/billing-api',
      'let billing-api use the checkout access to orders-db in dev',
    )

    const violation = of(checkPolicies(signed, policies()), 'cross-environment-consumer')

    expect(violation?.path).toBe('operations.0.patch.consumer')
  })

  it('says nothing about a folder, which an update never computes', () => {
    // `unwitnessed-folder` is about a path the ENGINE computed, and an update
    // computes none: it amends a file the repository already holds, so there
    // is no structure to invent.
    const signed = signUpdate(
      'resource:default/checkout-orders-db-prod',
      'component:default/billing-api',
      'let billing-api use the checkout access to orders-db in prod',
    )

    const violations = checkPolicies(signed, policies({ witnesses: new Set() }))

    expect(violations.map((violation) => violation.policy)).not.toContain('unwitnessed-folder')
  })

  it('says nothing about an update that only adds a consumer where it belongs', () => {
    // The case that must keep working: the right environment, the level the
    // grant declares, a consumer that lives there too.
    const signed = signUpdate(
      'resource:default/checkout-orders-db-prod',
      'component:default/billing-api',
      'give billing-api read access to orders-db in prod',
      'read',
    )

    expect(checkPolicies(signed, policies())).toEqual([])
  })
})

/**
 * The level the operation STATES against the level the repository DECLARES.
 *
 * It replaces two policies that compared different things and were calibrated
 * in opposite directions on the same declaration. `level-mismatch` read the
 * requested level out of the English in the request — so a French request
 * named none, and the only gate between a read request and a readwrite grant
 * never fired — and stayed silent when the grant declared no level;
 * `unamendable-level` hard-refused that same level-less declaration on a
 * creation. Now there is one comparison, and both shapes of operation carry
 * the level as a field.
 */
describe('declared-level-mismatch, over an update', () => {
  const REF = 'resource:default/payments-orders-db-prod'
  const CONSUMER = 'component:default/billing-api'

  it('refuses an update stating read against a grant the repository declares readwrite', () => {
    // The level of the grant being extended IS the authorisation being handed
    // over, and one `add-dependency-of` hands it over whole. The diff shows an
    // added consumer line and not the level, so nothing else would ever say so.
    const signed = signUpdate(REF, CONSUMER, 'give billing-api read access to orders-db in prod', 'read')

    const violation = of(checkPolicies(signed, policies()), 'declared-level-mismatch')

    expect(violation?.path).toBe('operations.0.patch.access')
    expect(violation?.message).toContain('readwrite')
    expect(violation?.message).toContain('read')
  })

  it('refuses it identically when the request is not in English', () => {
    // The policy never reads the request — that is the whole change. The level
    // is a field of the operation, so the comparison is between two facts, and
    // the script the person typed in cannot reach it. `levelAsked` could not
    // say that: it matched English words, and a request in any other language
    // left the gate silent while a readwrite grant was handed over at exit 0.
    const signed = signUpdate(
      REF,
      CONSUMER,
      // The Japanese script of `echoes.test.ts`, naming `read` as a word: a
      // Latin run between two non-Latin characters is a word, so the level is
      // `echoed` here and reaches the policy as a value rather than a question.
      'billing-apiにprod環境のorders-dbへのreadアクセスを付与',
      'read',
    )

    const violation = of(checkPolicies(signed, policies()), 'declared-level-mismatch')

    expect(violation?.path).toBe('operations.0.patch.access')
    expect(violation?.message).toContain('readwrite')
  })

  it('turns a level the request never named into a question, in any language', () => {
    // The other half, and the one no policy can answer: a French request names
    // no English word, so nothing vouches for the level the model wrote and the
    // signature asks. Under `levelAsked` this same run passed every gate and
    // joined a readwrite grant to a request for read, silently.
    const signed = signUpdate(
      REF,
      CONSUMER,
      "donne à billing-api l'accès à orders-db en prod",
      'read',
    )

    expect(findUnknowns(signed.plan)).toEqual(['operations.0.patch.access'])
    // A question is not a claim: the CLI asks before any preview, and refusing
    // here would state one stop twice.
    expect(checkPolicies(signed, policies())).toEqual([])
  })

  it('says nothing when the level stated is the level declared', () => {
    const signed = signUpdate(
      'resource:default/checkout-orders-db-prod',
      CONSUMER,
      'give billing-api read access to orders-db in prod',
      'read',
    )

    expect(checkPolicies(signed, policies())).toEqual([])
  })

  it('refuses an update stating a level against a declaration that states none', () => {
    // The pre-`access` repository, first direction. An unstated level is
    // unstated (§4.1) and never read as `read`, so an operation claiming the
    // grant grants read is claiming something the file does not say — and
    // nothing here can make it say it.
    const signed = signUpdate(
      'resource:default/legacy-orders-db-prod',
      CONSUMER,
      'give billing-api read access to orders-db in prod',
      'read',
    )

    const violation = of(checkPolicies(signed, policies()), 'declared-level-mismatch')

    expect(violation?.path).toBe('operations.0.patch.access')
    expect(violation?.message).toContain('states no level')
  })

  it('lets an update join a declaration that states no level when it states none either', () => {
    // The pre-`access` repository, second direction, and the reason `access` is
    // optional rather than required: a repository written before the field has
    // declarations carrying none, and joining a consumer to one is legitimate
    // work. The operation says so by omitting the field, and the two agree.
    const signed = signUpdate('resource:default/legacy-orders-db-prod', CONSUMER,
      'let billing-api use the legacy access to orders-db in prod')

    expect(checkPolicies(signed, policies())).toEqual([])
  })

  it('refuses an update that states no level against a grant that declares one', () => {
    // Silence is a claim here, not a gap, so it is checked like any other. An
    // operation omitting the field against a `readwrite` grant is saying the
    // grant has no level, and the consumer would receive one.
    const signed = signUpdate(REF, CONSUMER, 'give billing-api read access to orders-db in prod')

    const violation = of(checkPolicies(signed, policies()), 'declared-level-mismatch')

    expect(violation?.path).toBe('operations.0.patch.access')
    expect(violation?.message).toContain('readwrite')
    expect(violation?.message).toContain('states no level')
  })

  it('says nothing about a grant the repository has never declared', () => {
    // `has`, never `get`: a reference the map does not hold at all is not a
    // grant this repository declares, and no level of it is wrong yet.
    const signed = signUpdate(REF, CONSUMER, 'give billing-api read access to orders-db in prod', 'read')

    expect(checkPolicies(signed, policies({ levels: new Map() }))).toEqual([])
  })
})

describe('declared-level-mismatch, over a creation', () => {
  const READ_IN_PROD = 'give billing-api read access to orders-db in prod'
  const REF = 'resource:default/billing-api-orders-db-prod'

  it('refuses a creation restating a grant the repository declares wider', () => {
    // A narrowing: the plan says read, the repository says readwrite. Nothing
    // in this tool rewrites a scalar, so the file would come out unchanged and
    // the run would report "the repository already says it" — about a grant
    // that says the opposite.
    const signed = sign(accessIn('prod'), READ_IN_PROD)

    const violations = checkPolicies(
      signed,
      policies({ levels: new Map<string, AccessLevel | undefined>([[REF, 'readwrite']]) }),
    )

    const violation = of(violations, 'declared-level-mismatch')
    expect(violation?.path).toBe('operations.0.entity.spec.access')
    expect(violation?.message).toContain('readwrite')
  })

  it('refuses a creation stating a level the repository declares without one', () => {
    // An unstated level is unstated (§4.1), never read as anything. So a file
    // with no level does not already say `read`, and appending cannot add one.
    const signed = sign(accessIn('prod'), READ_IN_PROD)

    const violations = checkPolicies(
      signed,
      policies({ levels: new Map<string, AccessLevel | undefined>([[REF, undefined]]) }),
    )

    expect(violations.map((violation) => violation.policy)).toContain(
      'declared-level-mismatch',
    )
  })

  it('says nothing when the repository already states the level the plan states', () => {
    // A genuine already-declared: same grant, same level. This is the run that
    // must still end on "nothing to change", because it is true.
    const signed = sign(accessIn('prod'), READ_IN_PROD)

    expect(
      checkPolicies(
        signed,
        policies({ levels: new Map<string, AccessLevel | undefined>([[REF, 'read']]) }),
      ),
    ).toEqual([])
  })

  it('says nothing about a grant the repository has never declared', () => {
    const signed = sign(accessIn('prod'), READ_IN_PROD)

    expect(checkPolicies(signed, policies())).toEqual([])
  })
})

describe('the list itself', () => {
  it('reports every violation, not the first one', () => {
    // A caller fixing them one round-trip at a time is the repair loop's
    // worst case: each fix costs a paid turn.
    const signed = sign(
      { ...accessIn('dev', ['resource:default/orders-db-prod']),
        metadata: { name: 'billing-api-orders-db-prod', env: 'dev' } },
      'give billing-api read access to orders-db in dev',
    )

    const violations = checkPolicies(signed, policies({ witnesses: new Set() }))

    expect(new Set(violations.map((violation) => violation.policy)).size).toBeGreaterThan(1)
  })
})
