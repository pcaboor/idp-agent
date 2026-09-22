import { z } from 'zod'
import { entityRefSchema, ownerRefSchema } from './entity.js'
import { RESOURCE_TYPE_NAMES } from './resource-types.js'

/**
 * An explicitly undetermined value. Declare, never infer (design 4.1): what the
 * system does not know is reported as unknown, never filled in with a plausible
 * value. The reason is mandatory — it is the question the CLI puts to the user.
 */

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
 * A question, in the model's words.
 *
 * Bounded like every other string a model writes. Every stated value in a
 * proposal is length-capped, and leaving the reason uncapped made `{unknown}`
 * the one field with no ceiling: a channel for an unbounded run of arbitrary
 * text — a path, a file's contents, an instruction — to travel verbatim
 * through the engine and into the next agent's opening message. The escape
 * hatch for "I do not know" is not a place to put a payload.
 */
export const unknownSchema = z.object({
  unknown: z.string().min(1).max(PLAN_LIMITS.maxStringLength),
})
export type UnknownValue = z.infer<typeof unknownSchema>

/**
 * A proposal is stricter than an entity read from disk, and the asymmetry is
 * the point.
 *
 * `entitySchema` READS a real Backstage repository, whose files legitimately
 * carry fields this tool does not model — making it strict would break
 * `readRepository` on any real catalogue. A PROPOSAL is the other direction:
 * an unmodelled field there is either an invention or a field that will be
 * dropped in silence when `ordered()` serialises it. Both are unacceptable.
 *
 * Three things are deliberately absent, and each absence is a guarantee:
 *
 *   no `apiVersion`     the engine derives it
 *   no `annotations`    the environment is a named field and every other
 *                       annotation is engine-computed, so there is nowhere to
 *                       put `idp-agent.dev/source-file` — which resolveEntityPath
 *                       reads to decide where a file goes. Without this, a model
 *                       aims at its own path, and design 5.2 promises it cannot.
 *   no path, anywhere   the engine chooses it (design 5.2)
 */
const or = <T extends z.ZodType>(schema: T): z.ZodType =>
  z.union([schema, unknownSchema])

/**
 * Exported because the Inspector reports a name that lands in `metadata.name`
 * here. A name it cannot express is `{unknown}` and the CLI asks — which is only
 * true if both ends measure "expressible" with the same pattern.
 */
export const proposedName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/, 'invalid Backstage name')

export const proposedResourceSchema = z.strictObject({
  kind: z.literal('Resource'),
  metadata: z.strictObject({
    name: proposedName,
    description: z.string().max(PLAN_LIMITS.maxStringLength).optional(),
    /** Required: being authorised in dev grants nothing in staging (design 4.1). */
    env: or(z.string().min(1).max(63)),
  }),
  spec: z.strictObject({
    type: or(z.enum(RESOURCE_TYPE_NAMES)),
    owner: or(ownerRefSchema),
    dependsOn: z.array(entityRefSchema).optional(),
    dependencyOf: z.array(entityRefSchema).optional(),
  }),
})

export const proposedComponentSchema = z.strictObject({
  kind: z.literal('Component'),
  metadata: z.strictObject({
    name: proposedName,
    description: z.string().max(PLAN_LIMITS.maxStringLength).optional(),
  }),
  spec: z.strictObject({
    type: or(z.string().min(1).max(63)),
    lifecycle: or(z.enum(['experimental', 'production', 'deprecated'])),
    owner: or(ownerRefSchema),
    dependsOn: z.array(entityRefSchema).optional(),
  }),
})

/**
 * A patch is a closed union too. "What is not modelled cannot be requested"
 * applies to a change as much as to a creation — a free-form patch is a write
 * tool with no shape.
 */
export const patchSchema = z.discriminatedUnion('patch', [
  z.strictObject({
    patch: z.literal('add-dependency-of'),
    consumer: entityRefSchema,
  }),
])

/**
 * The closed set of things an agent may ask for. Anything outside it is rejected
 * at the boundary, before its content is even looked at.
 *
 * There is no delete operation: an access declaration may be the only trace of a
 * still-open flow, so removal is a human decision (design 4.4).
 */
export const operationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('create-entity'),
    // Discriminated on kind, not a bare union: a bare union reports
    // `invalid_union` at `operations.0.entity` and swallows the issue that
    // actually failed, so a rejection cannot name the field. Stage 1 fixed the
    // same defect in the readers with reasonOf(); the proposal boundary owes
    // the repair loop (task 8) the same courtesy.
    entity: z.discriminatedUnion('kind', [proposedResourceSchema, proposedComponentSchema]),
  }),
  z.strictObject({
    op: z.literal('update-entity'),
    entityRef: entityRefSchema,
    patch: patchSchema,
  }),
  z.strictObject({
    op: z.literal('create-catalog-info'),
    repoPath: z.string().min(1).max(512),
    entity: proposedComponentSchema,
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
