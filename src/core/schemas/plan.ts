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
 * Bounds on a proposal. A plan is produced by a model, so it is untrusted input:
 * these are not stylistic limits, they stop a malformed or steered proposal from
 * exhausting the process before anything has been reviewed.
 *
 * The operation count is deliberately low. A plan a human cannot read in one
 * merge request is not a plan, it is a migration, and it needs a different tool.
 */
export const PLAN_LIMITS = {
  maxOperations: 50,
  maxIntentLength: 2_000,
  maxDepth: 32,
  maxNodes: 10_000,
  maxStringLength: 8_192,
} as const

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

/**
 * Walk iteratively, never recursively: a proposal nested 50 000 deep would
 * overflow the call stack, and killing the CLI is a cheap thing for a steered
 * model to achieve. Returns the first breach, or undefined.
 */
function shapeViolation(value: unknown): string | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break

    nodes += 1
    if (nodes > PLAN_LIMITS.maxNodes) return `plan holds more than ${PLAN_LIMITS.maxNodes} values`
    if (current.depth > PLAN_LIMITS.maxDepth) {
      return `plan nests deeper than ${PLAN_LIMITS.maxDepth} levels`
    }
    if (typeof current.value === 'string' && current.value.length > PLAN_LIMITS.maxStringLength) {
      return `a value exceeds ${PLAN_LIMITS.maxStringLength} characters`
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 })
    } else if (typeof current.value === 'object' && current.value !== null) {
      for (const item of Object.values(current.value)) {
        stack.push({ value: item, depth: current.depth + 1 })
      }
    }
  }

  return undefined
}

export const planSchema = z
  .object({
    intent: z.string().min(1).max(PLAN_LIMITS.maxIntentLength),
    operations: z.array(operationSchema).max(PLAN_LIMITS.maxOperations),
  })
  .superRefine((value, ctx) => {
    const violation = shapeViolation(value)
    if (violation !== undefined) ctx.addIssue({ code: 'custom', message: violation })
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

/**
 * Dotted paths of every explicitly undetermined field, in traversal order.
 * Iterative for the same reason as `shapeViolation`: this also runs on values
 * that have not been through `planSchema` yet.
 */
export function findUnknowns(value: unknown): string[] {
  const found: string[] = []
  const stack: Array<{ value: unknown; path: string }> = [{ value, path: '' }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break

    if (isUnknownValue(current.value)) {
      found.push(current.path)
      continue
    }

    // Children are pushed in reverse so the stack yields them in source order.
    if (Array.isArray(current.value)) {
      for (let i = current.value.length - 1; i >= 0; i -= 1) {
        const path = current.path === '' ? `${i}` : `${current.path}.${i}`
        stack.push({ value: current.value[i], path })
      }
    } else if (typeof current.value === 'object' && current.value !== null) {
      const entries = Object.entries(current.value)
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i]
        if (entry === undefined) continue
        const path = current.path === '' ? entry[0] : `${current.path}.${entry[0]}`
        stack.push({ value: entry[1], path })
      }
    }
  }

  return found
}

/** A plan holding any unknown cannot be applied; the CLI asks the user instead. */
export function isApplicable(plan: Plan): boolean {
  return findUnknowns(plan).length === 0
}
