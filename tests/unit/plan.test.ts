import { describe, expect, it } from 'vitest'
import {
  findUnknowns,
  isApplicable,
  operationSchema,
  planSchema,
} from '../../src/core/schemas/plan.js'

/**
 * A proposal, not an entity read from disk: no apiVersion (derived), no
 * annotations map (nowhere to aim a path), and an environment, because being
 * authorised in dev grants nothing in staging.
 */
const resource = {
  kind: 'Resource' as const,
  metadata: { name: 'billing-api-billing-db-dev', env: 'dev' },
  spec: {
    type: 'database-access' as const, access: 'read', owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'], dependencyOf: ['component:default/billing-api'],
  },
}

describe('plan schemas', () => {
  it('accepts a create-entity operation', () => {
    const op = operationSchema.parse({ op: 'create-entity', entity: resource })
    expect(op.op).toBe('create-entity')
  })

  it('rejects an operation that is not modelled', () => {
    const result = operationSchema.safeParse({ op: 'delete-database', name: 'billing' })
    expect(result.success).toBe(false)
  })

  it('finds no unknown in a fully determined plan', () => {
    const plan = planSchema.parse({
      intent: 'give billing-api read access to billing-db-dev',
      operations: [{ op: 'create-entity', entity: resource }],
    })
    expect(findUnknowns(plan)).toEqual([])
    expect(isApplicable(plan)).toBe(true)
  })

  it('reports the path of every unknown and refuses to apply', () => {
    const plan = planSchema.parse({
      intent: 'connect to the billing database',
      operations: [
        {
          op: 'create-entity',
          entity: {
            ...resource,
            spec: { ...resource.spec, owner: { unknown: 'no CODEOWNERS entry found' } },
          },
        },
      ],
    })
    expect(findUnknowns(plan)).toEqual(['operations.0.entity.spec.owner'])
    expect(isApplicable(plan)).toBe(false)
  })

  it('reports several unknowns in traversal order', () => {
    const plan = planSchema.parse({
      intent: 'connect to something',
      operations: [
        {
          op: 'create-entity',
          entity: {
            ...resource,
            spec: {
              type: { unknown: 'could not tell a cache from a database' },
              owner: { unknown: 'no CODEOWNERS entry found' },
            },
          },
        },
      ],
    })
    expect(findUnknowns(plan)).toEqual([
      'operations.0.entity.spec.type',
      'operations.0.entity.spec.owner',
    ])
  })

  it('refuses a plan with no operations at all', () => {
    // `absent means already done` was the old reading, and it made the most
    // dangerous sentence this tool can print reachable by a model giving up:
    // no operations, no gate to fail, no edits, `nothing to change.` on exit
    // 0. Having nothing to propose is said by ending the draft, which the CLI
    // reports as a refusal.
    const result = planSchema.safeParse({ intent: 'already declared', operations: [] })

    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path.join('.') === 'operations')).toBe(
      true,
    )
  })

  it('refuses an unknown carrying no reason', () => {
    // The reason IS the question put to the user. An unknown with an empty one
    // has nothing to ask, so it is now refused at the schema rather than parsed
    // and surfaced later — the permissive record used to let it through.
    const result = planSchema.safeParse({
      intent: 'x',
      operations: [
        {
          op: 'create-entity',
          entity: { ...resource, spec: { ...resource.spec, owner: { unknown: '' } } },
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts an unknown that carries its question, and reports its path', () => {
    const plan = planSchema.parse({
      intent: 'x',
      operations: [
        {
          op: 'create-entity',
          entity: {
            ...resource,
            spec: { ...resource.spec, owner: { unknown: 'which team owns this?' } },
          },
        },
      ],
    })
    expect(findUnknowns(plan)).toEqual(['operations.0.entity.spec.owner'])
    expect(isApplicable(plan)).toBe(false)
  })
})

describe('plan limits', () => {
  const operation = { op: 'create-entity', entity: resource }

  it('refuses more operations than a reviewer could read in one merge request', () => {
    const many = Array.from({ length: 51 }, () => operation)
    expect(planSchema.safeParse({ intent: 'x', operations: many }).success).toBe(false)
  })

  it('accepts a plan at the limit', () => {
    const many = Array.from({ length: 50 }, () => operation)
    expect(planSchema.safeParse({ intent: 'x', operations: many }).success).toBe(true)
  })

  it('refuses an intent longer than a request', () => {
    expect(planSchema.safeParse({ intent: 'x'.repeat(2001), operations: [] }).success).toBe(false)
  })

  it('refuses a structure nested deeper than any real entity', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 100; i += 1) deep = { nested: deep }
    const result = planSchema.safeParse({
      intent: 'x',
      operations: [{ op: 'create-entity', entity: deep }],
    })
    expect(result.success).toBe(false)
  })

  it('refuses a single value larger than any real field', () => {
    const result = planSchema.safeParse({
      intent: 'x',
      operations: [{ op: 'create-entity', entity: { description: 'x'.repeat(8193) } }],
    })
    expect(result.success).toBe(false)
  })

  it('walks a structure deep enough to overflow a recursive implementation', () => {
    let deep: Record<string, unknown> = { unknown: 'leaf' }
    for (let i = 0; i < 50_000; i += 1) deep = { nested: deep }
    expect(() => findUnknowns(deep)).not.toThrow()
  })

  it('refuses a __proto__ key outright, rather than dropping it quietly', () => {
    // JSON.parse *does* make __proto__ an own property — that is exactly how
    // it differs from an object literal, and why this attack is worth a test.
    // The permissive record used to accept it and rely on the key being
    // ignored downstream; the strict schema names it and refuses.
    const smuggled = JSON.parse(
      `{"kind":"Resource","metadata":{"name":"db","env":"dev"},` +
        `"spec":{"type":"database","owner":"group:default/tiger"},"__proto__":{"owned":true}}`,
    ) as Record<string, unknown>
    expect(Object.hasOwn(smuggled, '__proto__')).toBe(true)

    const result = planSchema.safeParse({
      intent: 'x',
      operations: [{ op: 'create-entity', entity: smuggled }],
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('__proto__')
    expect(({} as Record<string, unknown>).owned).toBeUndefined()
  })
})
