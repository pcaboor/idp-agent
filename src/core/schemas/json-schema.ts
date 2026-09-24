import { z } from 'zod'
import { entitySchema } from './entity.js'
import { planSchema } from './plan.js'

/**
 * The rules Zod enforces that JSON Schema has no way to express. They are
 * emitted as a `$comment` on the exported schema rather than left implicit: a
 * schema quietly weaker than the validator is worse than no schema at all,
 * because it is the one people trust.
 */
export const UNENFORCED_BY_JSON_SCHEMA: readonly string[] = [
  'only a right-nature type may carry spec.dependencyOf — an object has no consumers',
  'only a right-nature type may carry spec.access — an object grants no level',
  'an entity must be filed at the path its type and name produce',
]

/**
 * What only the reader enforces. A proposal names every reference in full and
 * has no `metadata.namespace`, so this is said of the entity schema alone.
 */
export const UNENFORCED_BY_ENTITY_JSON_SCHEMA: readonly string[] = [
  ...UNENFORCED_BY_JSON_SCHEMA,
  'a reference that omits its namespace takes metadata.namespace, which must then be one',
]

/**
 * `io: 'input'` is load-bearing. `metadata.annotations` carries `.default({})`,
 * and in output mode Zod exports that field as *required* — every hand-written
 * entity in a real repository would fail against the schema this stage ships.
 */
function exported(schema: z.ZodType, unenforced: readonly string[]): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>),
    $comment: `Enforced by idp-agent and not by this schema: ${unenforced.join('; ')}.`,
  }
}

export const entityJsonSchema = (): Record<string, unknown> =>
  exported(entitySchema, UNENFORCED_BY_ENTITY_JSON_SCHEMA)
export const planJsonSchema = (): Record<string, unknown> =>
  exported(planSchema, UNENFORCED_BY_JSON_SCHEMA)
