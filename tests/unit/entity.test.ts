import { describe, expect, it } from 'vitest'
import { entitySchema, resourceSchema } from '../../src/core/schemas/entity.js'

describe('entity schemas', () => {
  it('accepts a well-formed Resource', () => {
    const parsed = resourceSchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    })
    expect(parsed.metadata.annotations).toEqual({})
  })

  it('rejects an owner without a group or user prefix', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'tiger' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a name that is not a valid Backstage name', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'Billing DB' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    })
    expect(result.success).toBe(false)
  })

  it('discriminates Component from Resource', () => {
    const parsed = entitySchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'billing-api' },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    })
    expect(parsed.kind).toBe('Component')
  })

  it('rejects an unknown resource type', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'x' },
      spec: { type: 'quantum-blob', owner: 'group:default/tiger' },
    })
    expect(result.success).toBe(false)
  })

  it('refuses dependencyOf on an object: a resource does not carry its consumers', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: {
        type: 'database',
        owner: 'group:default/tiger',
        dependencyOf: ['component:default/billing-api'],
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts dependencyOf on a right', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-api-billing-db-dev' },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        dependencyOf: ['component:default/billing-api'],
      },
    })
    expect(result.success).toBe(true)
  })

  it('still discriminates on kind once the refinement is in place', () => {
    const parsed = entitySchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    })
    expect(parsed.kind).toBe('Resource')
  })
})
