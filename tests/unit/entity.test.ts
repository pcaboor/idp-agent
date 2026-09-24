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

  it('reads an owner without a prefix as a group, the way Backstage does', () => {
    const parsed = resourceSchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'tiger' },
    })
    expect(parsed.spec.owner).toBe('group:default/tiger')
  })

  it('rejects an owner that is neither a group nor a user', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'component:tiger' },
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
        type: 'database-access', access: 'read',
        owner: 'group:default/tiger',
        dependencyOf: ['component:default/billing-api'],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a right that states the level it grants', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-api-orders-db-prod' },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        access: 'read',
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a right that states no level, or every access ever written is invalid', () => {
    // The read side is optional on purpose. `entitySchema` READS a repository
    // that already exists, and no access in one carries this field yet: making
    // it required would make `validate` — the command a user points at the
    // repository they already have — report invalid-entity on every access
    // declaration in it.
    //
    // What the optionality does NOT buy is a default. An absent level is
    // absent; nothing here or downstream reads it as readwrite.
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-api-billing-db-dev' },
      spec: { type: 'database-access', owner: 'group:default/tiger' },
    })
    expect(result.success).toBe(true)
    expect(result.data?.spec).not.toHaveProperty('access')
  })

  it('refuses an access level on an object, naming the field', () => {
    // A database is not a grant, so there is nothing for a level to be about.
    // Enforced here for the reason `dependencyOf` is: a level on an object is
    // valid YAML the catalogue ingests without complaint, so nothing
    // downstream would ever report it.
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'group:default/tiger', access: 'read' },
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('access')
  })

  it('refuses a level the registry does not declare', () => {
    // Closed, like the type union: what is not modelled cannot be requested.
    // `admin` is not a wider grant this tool can express, it is a string
    // nothing downstream knows how to act on.
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-api-orders-db-prod' },
      spec: { type: 'database-access', owner: 'group:default/tiger', access: 'admin' },
    })
    expect(result.success).toBe(false)
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
