import { z } from 'zod'
import { entityRefSchema, ownerRefSchema } from './entity.js'
import {
  ACCESS_LEVELS,
  levelledOf,
  RESOURCE_TYPE_NAMES,
  RESOURCE_TYPES,
  type ResourceType,
} from './resource-types.js'

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
 * `entitySchema` READS the Components and Resources of a real Backstage
 * repository, whose files legitimately carry fields this tool does not model —
 * making it strict would break `readRepository` on any real catalogue, whose
 * other kinds never reach the schema: `parseDocuments` sets them aside. A
 * PROPOSAL is the other direction: an unmodelled field there is either an
 * invention or a field that will be dropped in silence when `ordered()`
 * serialises it. Both are unacceptable.
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

/**
 * Deliberately no `description`, on either proposal.
 *
 * The signature asks one question of every value: where did it come from? Free
 * prose has no answer — a sentence a model writes is echoed by nothing and
 * enumerated by nothing, so it classifies as `novel` and becomes a question.
 * That is not a theoretical objection: it dead-ended the whole run. A draft
 * carrying a perfectly reasonable description exited as "nothing vouches for
 * this description; which one is it?", asked of the user, about a sentence the
 * model had just written — and the Architect was never asked again and the
 * Reviewer never called.
 *
 * The field could have been exempted from the walk instead. It is not, for the
 * same reason `ProjectFacts` has no description either: it is a second
 * free-text channel out of a model and into a file in the repository, serving
 * no field that needs it. What is not modelled cannot be requested.
 *
 * A human adds one in the merge request, where prose belongs.
 */
/**
 * A grant of a levelled type states its level, or says it does not know.
 *
 * `.optional()` alone made "say nothing" a legal proposal — no leaf, so no
 * question, so a database-access drafted from a request that said "read
 * access" landed with no level at all and exit 0. `metadata.env` set the
 * opposite precedent for exactly this reason, and this is the write side of
 * the same rule: a proposal is stricter than an entity read from disk, because
 * a repository that already exists is not this tool's to invalidate.
 */
const levelStated = (
  value: { spec: { type: unknown; access?: unknown } },
  ctx: z.RefinementCtx,
): void => {
  const type = value.spec.type
  if (typeof type !== 'string' || !RESOURCE_TYPE_NAMES.includes(type as ResourceType)) return
  const wanted = levelledOf(type as ResourceType)
  const stated = value.spec.access !== undefined

  if (wanted && !stated) {
    ctx.addIssue({
      code: 'custom',
      path: ['spec', 'access'],
      message: `a '${type}' grant must state 'read' or 'readwrite', or {"unknown": "<why>"}`,
    })
  }
  if (!wanted && stated) {
    ctx.addIssue({
      code: 'custom',
      path: ['spec', 'access'],
      message: `a '${type}' is not read or write; it is opened or it is not`,
    })
  }
}

/**
 * §4.1, asked of a proposal before anything else looks at it: a right is over
 * SOMETHING and granted to SOMEBODY, and a thing is neither.
 *
 * Both lists are `.optional()` in the shape above because absent is a complete
 * answer for a list — §5.4 exempts them from `{unknown}` for that reason — and
 * absent is exactly what makes a right meaningless. A `database-access` naming
 * no consumer grants nothing to nobody: it passes every gate, renders a diff,
 * and reads to whoever merges it like an authorisation. It was the shape a
 * model reached for when the gate that used to refuse the alternative told it
 * to fix a level instead, which is how it was found.
 *
 * Refused HERE, at the schema, rather than in a policy, because it is true of
 * every repository — there is no snapshot to consult and nothing to configure.
 * The message names the field and the type for the same reason `levelStated`
 * does: the repair loop hands it back, and a model can only act on what it is
 * told it got wrong.
 */
const relationsStated = (
  value: { spec: { type: unknown; dependsOn?: unknown; dependencyOf?: unknown } },
  ctx: z.RefinementCtx,
): void => {
  const type = value.spec.type
  if (typeof type !== 'string' || !RESOURCE_TYPE_NAMES.includes(type as ResourceType)) return
  const held = (list: unknown): boolean => Array.isArray(list) && list.length > 0

  if (RESOURCE_TYPES[type as ResourceType].nature === 'right') {
    if (!held(value.spec.dependsOn)) {
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'dependsOn'],
        message: `a '${type}' is a right over something; name what it is over in 'dependsOn'`,
      })
    }
    if (!held(value.spec.dependencyOf)) {
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'dependencyOf'],
        message:
          `a '${type}' is granted to somebody; name at least one consumer in ` +
          `'dependencyOf'. A right nobody holds grants nothing.`,
      })
    }
    return
  }

  if (held(value.spec.dependencyOf)) {
    ctx.addIssue({
      code: 'custom',
      path: ['spec', 'dependencyOf'],
      message: `a '${type}' is a thing, not a right over one, so it carries no consumers`,
    })
  }
}

export const proposedResourceSchema = z.strictObject({
  kind: z.literal('Resource'),
  metadata: z.strictObject({
    name: proposedName,
    /** Required: being authorised in dev grants nothing in staging (design 4.1). */
    env: or(z.string().min(1).max(63)),
  }),
  spec: z.strictObject({
    type: or(z.enum(RESOURCE_TYPE_NAMES)),
    owner: or(ownerRefSchema),
    dependsOn: z.array(entityRefSchema).optional(),
    dependencyOf: z.array(entityRefSchema).optional(),
    /**
     * What the grant is for, and `or(...)` for the reason `owner` and `type`
     * are: §5.4 says every field the model CHOOSES is a value or `{unknown}`.
     * `dependsOn` and `dependencyOf` are exempt because they are lists, where
     * absent is already a complete answer; a level is not a list, and a level
     * nobody stated is the one gap where filling in a plausible value hands
     * out write.
     *
     * Optional as well, and the two absences say different things: omitted
     * means the right has no level to state — a network route is not read or
     * write — while `{unknown}` means the model could not determine one, so
     * the plan cannot be applied and the CLI asks.
     *
     * Whether a level belongs on this type at all is left to `entitySchema`,
     * exactly as `dependencyOf` is: this boundary knows no natures, and the
     * bytes the plan would produce are read back by `recheckPlan`.
     */
    /**
     * Optional in the shape, required by the refinement below for a type that
     * has a level. Two reasons it is not simply required:
     *
     *   - a `network-access` has no level, and requiring one everywhere would
     *     make the honest proposal for a flow an `{unknown}` about a question
     *     nobody asked;
     *   - the refinement can name the field AND the type in its message, which
     *     `z.enum` alone cannot, and the repair loop hands that message back.
     */
    access: or(z.enum(ACCESS_LEVELS)).optional(),
  }),
}).superRefine((value, ctx) => {
  levelStated(value, ctx)
  relationsStated(value, ctx)
})

export const proposedComponentSchema = z.strictObject({
  kind: z.literal('Component'),
  metadata: z.strictObject({
    name: proposedName,
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
    /**
     * The level the grant being extended grants, and therefore the level the
     * consumer receives.
     *
     * It is here because it was nowhere. An update joins a consumer to an
     * EXISTING grant, so the plan stated no level at all, so the signature had
     * nothing to classify and the only gate left read the requested level out
     * of the English in the request — `echoes(intent, 'read')`. A request
     * arrives in whatever language the person wrote it in (see `echoes`), so
     * "accès en lecture" named no level, the gate stayed silent, and a
     * `readwrite` grant was extended to a request for `read` at exit 0. With
     * the level in the operation the signature classifies it like any other
     * leaf — echoed when the request named it, novel and therefore a question
     * when it did not, in every script — and a policy compares it to what the
     * repository declares without reading a word of the request.
     *
     * `or(...)` for the reason `metadata.env` and `spec.access` carry it: §5.4
     * says every field the model CHOOSES is a value or `{unknown}`, and a level
     * nobody stated is the one gap where filling in a plausible value hands out
     * write.
     *
     * **Optional, unlike `metadata.env`, and for a reason `spec.access` only
     * half shares.** `metadata.env` is required because every declaration is in
     * exactly one environment — there is no such thing as an environment-less
     * one — so an absent field could only ever be a silent gap. A level is not
     * like that: a `network-access` is opened or it is not, and a right with no
     * level has none to state. `spec.access` expresses that with a refinement,
     * because the TYPE that decides it sits in the same object; here it does
     * not. An update names its target by reference, and this boundary knows no
     * natures — so requiring a level would force an `{unknown}` about a
     * question nobody asked for every flow, and a refinement has nothing to
     * read.
     *
     * So the two absences say different things here exactly as they do on
     * `spec.access` — omitted means the grant states no level, `{unknown}`
     * means the model could not determine one — and the difference is that
     * this claim is CHECKED. The grant already exists, so `declared-level-
     * mismatch` compares the claim to the declaration: an omission against a
     * grant that declares `readwrite` is refused, and the pre-`access`
     * repository, whose declarations carry no level at all, is the case the
     * omission exists to express.
     */
    access: or(z.enum(ACCESS_LEVELS)).optional(),
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
    /**
     * At least one, and the lower bound matters more than the upper one.
     *
     * A model that cannot see what to do calls `propose` with `[]` — it is the
     * shape that costs it nothing — and an empty plan passes every gate
     * vacuously, produces no edits, and came out of the CLI as `nothing to
     * change.` on exit 0. The person asked for an authorisation and was told
     * their repository already grants it. That is the one sentence this tool
     * must never say untruthfully, and it was reachable by a model giving up.
     *
     * There is already a channel for having nothing to propose: ending the
     * draft without calling `propose` at all, which `ArchitectOutcome.plan`
     * carries as `undefined` and the CLI reports as a refusal. `nothing to
     * change` stays reachable the only way it is ever true — operations that
     * restate what the repository already declares, so `planEdits` produces
     * bytes identical to the ones on disk.
     */
    operations: z
      .array(operationSchema)
      .min(1, 'a plan with no operations is not a proposal; end the draft instead')
      .max(PLAN_LIMITS.maxOperations),
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
