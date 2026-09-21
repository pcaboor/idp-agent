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
  'an entity must be filed at the path its type and name produce',
]

/**
 * `io: 'input'` is load-bearing. `metadata.annotations` carries `.default({})`,
 * and in output mode Zod exports that field as *required* — every hand-written
 * entity in a real repository would fail against the schema this stage ships.
 */
function exported(schema: z.ZodType): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>),
    $comment: `Enforced by idp-agent and not by this schema: ${UNENFORCED_BY_JSON_SCHEMA.join('; ')}.`,
  }
}

export const entityJsonSchema = (): Record<string, unknown> => exported(entitySchema)
export const planJsonSchema = (): Record<string, unknown> => exported(planSchema)
