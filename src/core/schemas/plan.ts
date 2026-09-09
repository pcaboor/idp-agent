import { z } from 'zod'
import { componentSchema, entityRefSchema } from './entity.js'

/**
 * An explicitly undetermined value. Declare, never infer (design 4.1): what the
 * system does not know is reported as unknown, never filled in with a plausible
 * value. The reason is mandatory — it is the question the CLI puts to the user.
 */
export const unknownSchema = z.object({ unknown: z.string().min(1) })
export type UnknownValue = z.infer<typeof unknownSchema>

/**
 * The closed set of things an agent may ask for. Anything outside it is rejected
 * at the boundary, before its content is even looked at.
 *
 * There is no delete operation: an access declaration may be the only trace of a
 * still-open flow, so removal is a human decision (design 4.4).
 */
export const operationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create-entity'),
    /**
     * Deliberately not narrowed to `entitySchema`: a proposal may legitimately
     * carry `{ unknown }` in place of a field. Strict entity validation happens
     * once unknowns are resolved, at application time.
     */
    entity: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('update-entity'),
    entityRef: entityRefSchema,
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('create-catalog-info'),
    repoPath: z.string().min(1),
    entity: componentSchema,
  }),
])

export type Operation = z.infer<typeof operationSchema>

export const planSchema = z.object({
  intent: z.string().min(1),
  operations: z.array(operationSchema),
})

export type Plan = z.infer<typeof planSchema>

/**
 * Deliberately looser than `unknownSchema`: an unknown carrying an empty reason
 * is malformed, and surfacing it is more useful than letting it through.
 */
const isUnknownValue = (value: unknown): value is UnknownValue =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'unknown' in value &&
  typeof (value as { unknown: unknown }).unknown === 'string'

/** Dotted paths of every explicitly undetermined field, in traversal order. */
export function findUnknowns(value: unknown, path = ''): string[] {
  if (isUnknownValue(value)) return [path]
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findUnknowns(item, path ? `${path}.${index}` : `${index}`),
    )
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      findUnknowns(item, path ? `${path}.${key}` : key),
    )
  }
  return []
}

/** A plan holding any unknown cannot be applied; the CLI asks the user instead. */
export function isApplicable(plan: Plan): boolean {
  return findUnknowns(plan).length === 0
}
