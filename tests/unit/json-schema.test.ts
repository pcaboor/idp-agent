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

  it('names the access level among what it cannot enforce either', () => {
    // Same hole, second field: the export accepts a database carrying an
    // access level because the nature rule lives in a superRefine. Stated on
    // the schema rather than left for a reader to discover.
    expect(UNENFORCED_BY_JSON_SCHEMA.join(' ')).toMatch(/spec\.access/)
    expect(JSON.stringify(entityJsonSchema())).toContain('readwrite')
  })

  it('describes the short references the reader accepts, not only the full form', () => {
    // The file shipped to a repository is what an editor checks it against. A
    // schema stricter than the reader flags the owner Backstage's own example
    // writes; the one rule it cannot state is named instead.
    const [component] = (entityJsonSchema() as {
      oneOf: { properties: { spec: { properties: { owner: { pattern: string } } } } }[]
    }).oneOf
    const owner = new RegExp(component?.properties.spec.properties.owner.pattern ?? '$^')
    expect(owner.test('artist-relations-team')).toBe(true)
    expect(owner.test('Group:payments/team-a')).toBe(true)
    expect(owner.test('component:team-a')).toBe(false)
    expect(entityJsonSchema().$comment).toMatch(/metadata\.namespace/)
  })

  it('is a real JSON Schema document', () => {
    expect(entityJsonSchema()).toHaveProperty('$schema')
  })
})

describe('planJsonSchema', () => {
  it('exports without throwing, and describes the operation union', () => {
    expect(JSON.stringify(planJsonSchema())).toContain('create-entity')
  })

  it('does not describe a leniency only the reader has', () => {
    // A proposal names every reference in full and carries no
    // metadata.namespace: the reader's short-form note is not true of it.
    expect(planJsonSchema().$comment).not.toMatch(/namespace/)
    expect(planJsonSchema().$comment).toMatch(/dependencyOf/)
  })
})
