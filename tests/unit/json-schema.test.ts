import { describe, expect, it } from 'vitest'
import {
  UNENFORCED_BY_JSON_SCHEMA,
  entityJsonSchema,
  planJsonSchema,
} from '../../src/core/schemas/json-schema.js'
import { resourceSchema } from '../../src/core/schemas/entity.js'

describe('entityJsonSchema', () => {
  it('does not require annotations, which carry a default', () => {
    // io: 'input' is load-bearing. In output mode a field with .default({}) is
    // exported as required, and every hand-written entity in a real repository
    // would go red against the schema this stage ships.
    const groups = JSON.stringify(entityJsonSchema()).match(/"required":\[[^\]]*\]/g) ?? []
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.some((group) => group.includes('annotations'))).toBe(false)
  })

  it('still describes annotations, it just does not demand them', () => {
    expect(JSON.stringify(entityJsonSchema())).toContain('annotations')
  })

  it('enumerates every resource type the registry declares', () => {
    const schema = JSON.stringify(entityJsonSchema())
    for (const type of [
      'database',
      'cache',
      'api',
      'database-access',
      'network-access',
      'gateway-route',
    ]) {
      expect(schema).toContain(type)
    }
  })

  it('names what it cannot enforce, rather than looking complete', () => {
    // superRefine has no JSON Schema equivalent: the export accepts a database
    // carrying dependencyOf, which resourceSchema refuses. A schema quietly
    // weaker than the validator is worse than none, because it is trusted.
    const looser = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'x' },
      spec: {
        type: 'database',
        owner: 'group:default/tiger',
        dependencyOf: ['component:default/a'],
      },
    }
    expect(resourceSchema.safeParse(looser).success).toBe(false)
    expect(UNENFORCED_BY_JSON_SCHEMA.join(' ')).toMatch(/dependencyOf/)
    expect(JSON.stringify(entityJsonSchema())).toContain('$comment')
  })

  it('is a real JSON Schema document', () => {
    expect(entityJsonSchema()).toHaveProperty('$schema')
  })
})

describe('planJsonSchema', () => {
  it('exports without throwing, and describes the operation union', () => {
    expect(JSON.stringify(planJsonSchema())).toContain('create-entity')
  })
})
