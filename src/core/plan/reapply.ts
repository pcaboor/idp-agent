import { operationSchema, type Operation, type Plan } from '../schemas/plan.js'

/**
 * An answer is the user's word about one field of one entity, and it outlives
 * the plan it was typed into.
 *
 * It used to be held by its path alone — `operations.0.entity.spec.owner` —
 * and a path is the plan's own index. The ask loop hands the next round the
 * plan it filled, so the index held; the Architect does not. A run asked for
 * the owner of `orders-db-prod`, the user answered tiger, the Reviewer
 * refused the filled plan because it granted no access, and the redraft —
 * which had never seen the answer — put `{unknown}` back in the same field.
 * The same question was asked a second time. A redraft that moved the
 * database to another index would have lost it the same way, and one that put
 * another operation at that index inherited it: the answer vouched for the
 * same value at the same field of whatever sat there.
 *
 * So an answer is recorded by WHAT it is about: the entity its operation
 * declares or amends — `kind:default/name` for a creation, the `entityRef` of
 * an update — and the field inside that operation. `reapplyAnswers` runs on
 * every plan before the signature, on both roads, and puts each answer back
 * wherever that entity now is.
 *
 * **The user's answer wins over a different value.** It is what they stated
 * for that entity's field, the same rule by which an owner the user states
 * outranks the consumers (`deriveOwners`), and the replacement is reported
 * rather than left for the diff. A field the redraft left open, or left out,
 * is filled — which is what not asking again means.
 *
 * **Nothing a model wrote can become an answer.** The values this writes, and
 * the values the provenance it returns vouches for, are the recorded ones
 * only: a draft that happens to hold the same value is vouched for because the
 * user said it, and one that holds another is overwritten, never adopted.
 *
 * What this does NOT cover, stated as plainly as the rest of this folder:
 *
 *   - A renamed entity, or one of another kind, is another entity. Its field
 *     is asked again — the safe direction — and so is every field of an
 *     entity whose NAME the user answered and the redraft named otherwise.
 *   - An entity two operations of one plan declare or amend has no identity
 *     here: two updates extending one grant to two consumers each ask the
 *     grant's level, and those are two answers, not one given twice. An
 *     answer typed into such a plan stays at its path; a draft that amends
 *     an answered entity twice has that field asked again.
 *   - A list element and an update's consumer are never written. Their
 *     position is not their identity — `dependencyOf.0` of a redraft is
 *     whichever consumer it put first, and a second update of one grant is a
 *     second consumer — so writing one would replace a consumer rather than
 *     restore one. Such an answer vouches only where the same entity still
 *     holds exactly that value.
 *   - A value the schema would refuse at the field is not written: a level
 *     answered for a `database-access` does not follow the grant into a
 *     redraft that made it a `network-access`, which has no level to state.
 *   - An answer that cannot be placed in an operation — a path outside the
 *     plan, or an entity with no name to know it by — stays where it was
 *     typed, which is the old path-keyed limit, now confined to that case.
 *   - It says what the user stated, never whether it is right. The diff is
 *     where a person reads it, and the merge is the act of authorisation.
 */

/** What an answer is about: an entity, and a field of the operation naming it. */
export interface AnswerSubject {
  /** `kind:default/name` — the reference the operation declares or amends. */
  readonly entity: string
  /** Dotted, relative to the operation: `entity.spec.owner`, `patch.access`. */
  readonly field: string
}

/** What the user typed, where, and — when it can be told — what about. */
export interface RecordedAnswer {
  /** The path it was typed at, in the plan it was typed into. For reporting. */
  readonly path: string
  readonly value: string
  /** Absent when the operation has nothing stable to know it by. */
  readonly about?: AnswerSubject
}

/** An answer this step put back into a draft, which is a decision and is said. */
export interface ReappliedAnswer {
  /** Where it now sits. */
  readonly path: string
  readonly value: string
  readonly entity: string
  /** Where it was typed, in the plan it was typed into. */
  readonly answeredAt: string
  /** What the draft held there instead, when it held another value. */
  readonly replaced?: string
}

export interface Reapplication {
  readonly plan: Plan
  /**
   * Path → value, at THIS plan's paths: the answers a `Provenance` for it
   * carries, so the derivation, the signature and the policies vouch for each
   * value where it now sits and nowhere else.
   */
  readonly answers: ReadonlyMap<string, string>
  readonly reapplied: readonly ReappliedAnswer[]
}

/**
 * The entity an operation declares or amends, as a reference. A creation whose
 * name is not a string — a plan that did not come through the schema — has
 * none, and an answer about it stays at its path.
 */
function identityOf(operation: Operation): string | undefined {
  switch (operation.op) {
    case 'create-entity':
    case 'create-catalog-info': {
      const { kind, metadata } = operation.entity
      return typeof metadata.name === 'string'
        ? `${kind.toLowerCase()}:default/${metadata.name}`
        : undefined
    }
    case 'update-entity':
      return operation.entityRef
    default: {
      const exhaustive: never = operation
      return exhaustive
    }
  }
}

/**
 * The identity of each operation, or undefined where it has none to know it
 * by — which includes an identity another operation of the same plan shares.
 * Two updates extending one grant to two consumers are two questions about
 * the grant's level, answered separately; an identity that cannot tell them
 * apart would let one answer overwrite the other, and vouch for a value the
 * model wrote in the sibling that nobody asked the user about.
 */
function identitiesOf(plan: Plan): (string | undefined)[] {
  const all = plan.operations.map(identityOf)
  const count = new Map<string, number>()
  for (const one of all) if (one !== undefined) count.set(one, (count.get(one) ?? 0) + 1)
  return all.map((one) => (one !== undefined && count.get(one) === 1 ? one : undefined))
}

const OPERATION_PATH = /^operations\.(\d+)\.(.+)$/

/**
 * Records a round's answers against the plan they filled — the plan as it
 * stands after every one of them, so an entity whose name was itself answered
 * is known by the name the user gave.
 */
export function recordAnswers(
  plan: Plan,
  answers: readonly { readonly path: string; readonly value: string }[],
): RecordedAnswer[] {
  const identities = identitiesOf(plan)
  return answers.map(({ path, value }) => {
    const match = OPERATION_PATH.exec(path)
    const entity = match === null ? undefined : identities[Number(match[1])]
    if (match === null || entity === undefined) return { path, value }
    return { path, value, about: { entity, field: match[2] ?? '' } }
  })
}

/**
 * Whose position in the operation is not its identity: an element of a list,
 * and an update's consumer. See the module comment.
 */
const positional = (field: string): boolean =>
  field === 'patch.consumer' || field.split('.').some((part) => /^\d+$/.test(part))

const isUnknown = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'unknown' in value

/** The object holding `field` inside `operation`, or undefined if the shape differs. */
function holderOf(
  operation: unknown,
  field: string,
): { holder: Record<string, unknown>; key: string } | undefined {
  const parts = field.split('.')
  const key = parts.pop()
  if (key === undefined || key === '') return undefined
  let cursor: unknown = operation
  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  if (typeof cursor !== 'object' || cursor === null) return undefined
  return { holder: cursor as Record<string, unknown>, key }
}

export function reapplyAnswers(plan: Plan, answers: readonly RecordedAnswer[]): Reapplication {
  const vouched = new Map<string, string>()
  const reapplied: ReappliedAnswer[] = []

  // Kept where they were typed: there is nothing to follow them by. First, so
  // an answer placed by its entity below wins a path both claim.
  for (const one of answers) if (one.about === undefined) vouched.set(one.path, one.value)

  // One answer per entity and field, the latest. Only rounds can repeat a
  // key — within one plan an identity is unique or not recorded at all — so a
  // later answer is one to the same question, which replaced the earlier one
  // in the plan it was typed into.
  const latest = new Map<string, RecordedAnswer & { about: AnswerSubject }>()
  for (const one of answers) {
    if (one.about === undefined) continue
    latest.set(`${one.about.entity}\u0000${one.about.field}`, { ...one, about: one.about })
  }
  if (latest.size === 0) return { plan, answers: vouched, reapplied }

  // Cloned, never mutated in place, for `deriveOwners`'s reason: the caller
  // still holds the plan it was handed.
  const clone = structuredClone(plan)
  // An entity this draft amends twice is not one an answer can be placed in:
  // which of the two it was about is not something the draft can say, so its
  // fields are asked again.
  const identities = identitiesOf(clone)
  for (const [index, operation] of clone.operations.entries()) {
    const entity = identities[index]
    if (entity === undefined) continue
    for (const one of latest.values()) {
      if (one.about.entity !== entity) continue
      const path = `operations.${index}.${one.about.field}`
      const found = holderOf(operation, one.about.field)
      if (found === undefined) continue
      const { holder, key } = found
      const had = Object.hasOwn(holder, key)
      const current = holder[key]

      if (current === one.value) {
        vouched.set(path, one.value)
        continue
      }
      if (positional(one.about.field)) continue
      // A string, a question, or nothing: the three shapes a field an answer
      // was typed for can take. Anything else is not the field it was about.
      if (current !== undefined && typeof current !== 'string' && !isUnknown(current)) continue

      holder[key] = one.value
      if (!operationSchema.safeParse(operation).success) {
        // The redraft made the field one the schema will not take this value
        // at. Put back exactly what was there, absence included.
        if (had) holder[key] = current
        else delete holder[key]
        continue
      }
      vouched.set(path, one.value)
      reapplied.push({
        path,
        value: one.value,
        entity,
        answeredAt: one.path,
        ...(typeof current === 'string' ? { replaced: current } : {}),
      })
    }
  }

  return { plan: clone, answers: vouched, reapplied }
}
