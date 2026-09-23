import { describe, expect, it } from 'vitest'
import { checkPolicies } from '../../src/core/plan/policies.js'
import type { PolicyContext } from '../../src/core/plan/policies.js'
import { signPlan } from '../../src/core/plan/sign.js'
import type { SignatureContext, SignedPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'

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
  ]),
  ...over,
})

const sign = (entity: unknown, intent: string, over: Partial<SignatureContext> = {}): SignedPlan => {
  const parsed = planSchema.parse({ intent, operations: [{ op: 'create-entity', entity }] })
  const result = signPlan(parsed, signature(over))
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

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
