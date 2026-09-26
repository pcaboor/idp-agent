import { operationSchema, type Operation, type Plan } from '../schemas/plan.js'
import {
  accessWords,
  levelFieldOf,
  levelSiteOf,
  type AccessSubject,
  type GrantedOver,
  type LevelField,
} from './grant.js'

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
 *     answer typed into such a plan stays at its path — a level follows its
 *     consumer's access instead, when there is one (below); a draft that
 *     amends an answered entity twice has that field asked again.
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
 *
 * **A level is the one answer keyed by something more: the access it states.** The
 * person answering "which level?" is saying at what level a consumer reaches a
 * thing, not what a particular grant declares. The owner's run joined
 * billing-api to orders-api's grant, the person answered `read`, and the only
 * plan honouring that is a grant of billing-api's own — keyed by the grant,
 * the answer stayed behind on orders-api's, and the new grant's level was
 * asked again about the same access. So a level is recorded by its consumer
 * and its thing (`levelFieldOf`), and put back wherever the redraft states
 * that access — joined to an existing grant or declared in a new one. The
 * limits, each the safe direction:
 *
 *   - A level is always about ONE consumer (`levelSiteOf`), and never lands on
 *     another. It is held by its grant as well, as every answer is, but put
 *     back there only where that grant still states it for that same consumer
 *     — and only when no operation of the redraft states the access itself,
 *     which then wins. That is what keeps an answer through a redraft that
 *     changed what the grant is over (the `link-db-missing` tape: the same
 *     grant for the same consumer, declared over another reference of the
 *     same database) without letting it vouch for somebody else joined to it.
 *   - The access is only known when there is exactly one of each: an update's
 *     thing is what the repository declares its grant over (`GrantedOver`,
 *     which holds only the rights that state a level — a network flow has
 *     none, and is no statement of the access). A grant over two things is
 *     held by the grant and its consumer alone, as above. A grant for two
 *     consumers has no one consumer to hold it for, and a level typed there
 *     stays at its path.
 *   - Two updates of one grant, for two consumers, are two accesses: each
 *     level follows its own consumer, whichever order the redraft puts them
 *     in, though the grant — amended twice — holds neither.
 *   - A draft that states one access twice has it asked again, for the reason
 *     an entity amended twice does.
 */

/** What an answer is about: an entity, and a field of the operation naming it. */
export interface AnswerSubject {
  /** `kind:default/name` — the reference the operation declares or amends. */
  readonly entity: string
  /** Dotted, relative to the operation: `entity.spec.owner`, `patch.access`. */
  readonly field: string
  /**
   * For a level, the one consumer it was typed for: it is put back into this
   * entity only where the entity states the level for that same consumer.
   */
  readonly consumer?: string
}

/** What the user typed, where, and — when it can be told — what about. */
export interface RecordedAnswer {
  /** The path it was typed at, in the plan it was typed into. For reporting. */
  readonly path: string
  readonly value: string
  /** Absent when the operation has nothing stable to know it by. */
  readonly about?: AnswerSubject
  /** A level's access, when there is exactly one. See the module comment. */
  readonly access?: AccessSubject
}

/** An answer this step put back into a draft, which is a decision and is said. */
export interface ReappliedAnswer {
  /** Where it now sits. */
  readonly path: string
  readonly value: string
  /**
   * What it is about: the entity's reference, or — for a level carried by its
   * access — the access in words, since the grant it now sits in may not be
   * the one it was typed into.
   */
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
  /**
   * Path → what the answer there is about, in words — an entity reference, or
   * an access — for every answer this step puts back into a draft whatever the
   * draft wrote there. What the repair report tells the Architect the user
   * fixed, in exactly those words, so it holds nothing the engine would not
   * put back: not an answer held only by its path, which vouches where the
   * draft happens to hold it, and not a list element or a consumer, which are
   * never written (see the module comment).
   */
  readonly about: ReadonlyMap<string, string>
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

const accessKey = ({ consumer, resource }: AccessSubject): string => `${consumer}\u0000${resource}`

/**
 * The access each operation states a level for, or undefined where it states
 * none — which includes an access another operation of the same plan states,
 * for `identitiesOf`'s reason: which of the two an answer was about is not
 * something the plan can say.
 */
function accessesOf(plan: Plan, over: GrantedOver): (LevelField | undefined)[] {
  const all = plan.operations.map((operation) => levelFieldOf(operation, over))
  const count = new Map<string, number>()
  for (const one of all) {
    if (one === undefined) continue
    const key = accessKey(one.access)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  return all.map((one) =>
    one !== undefined && count.get(accessKey(one.access)) === 1 ? one : undefined,
  )
}

const OPERATION_PATH = /^operations\.(\d+)\.(.+)$/

/**
 * Records a round's answers against the plan they filled — the plan as it
 * stands after every one of them, so an entity whose name was itself answered
 * is known by the name the user gave.
 *
 * `over` is what the repository declares each levelled grant over, which is
 * how an update's level is known by its access. Without it an update's level
 * is held by its grant and its consumer alone — the safe direction, since
 * that asks more.
 */
export function recordAnswers(
  plan: Plan,
  answers: readonly { readonly path: string; readonly value: string }[],
  over: GrantedOver = new Map(),
): RecordedAnswer[] {
  const identities = identitiesOf(plan)
  const accesses = accessesOf(plan, over)
  return answers.map(({ path, value }) => {
    const match = OPERATION_PATH.exec(path)
    if (match === null) return { path, value }
    const index = Number(match[1])
    const field = match[2] ?? ''
    const entity = identities[index]
    const operation = plan.operations[index]
    const site = operation === undefined ? undefined : levelSiteOf(operation)
    if (site === undefined || site.field !== field) {
      return entity === undefined ? { path, value } : { path, value, about: { entity, field } }
    }
    // A level. With no one consumer to hold it for, it is nobody's in
    // particular, and stays where it was typed.
    const { consumer } = site
    if (consumer === undefined) return { path, value }
    const level = accesses[index]
    return {
      path,
      value,
      ...(entity === undefined ? {} : { about: { entity, field, consumer } }),
      ...(level === undefined || level.field !== field ? {} : { access: level.access }),
    }
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

/** One answer a draft's operation is to receive, and the words for what it is about. */
interface Placement {
  readonly one: RecordedAnswer
  /** Its place among the answers: a later one to the same question wins. */
  readonly order: number
  readonly about: string
}

export function reapplyAnswers(
  plan: Plan,
  answers: readonly RecordedAnswer[],
  over: GrantedOver = new Map(),
): Reapplication {
  const vouched = new Map<string, string>()
  const about = new Map<string, string>()
  const reapplied: ReappliedAnswer[] = []

  // Kept where they were typed: there is nothing to follow them by. First, so
  // an answer placed by its entity below wins a path both claim.
  for (const one of answers) {
    if (one.about === undefined && one.access === undefined) vouched.set(one.path, one.value)
  }

  // One answer per entity and field, and one per access, the latest. Only
  // rounds can repeat a key — within one plan an identity is unique or not
  // recorded at all — so a later answer is one to the same question, which
  // replaced the earlier one in the plan it was typed into.
  type Held<T> = { readonly one: T; readonly order: number }
  const byEntity = new Map<string, Held<RecordedAnswer & { about: AnswerSubject }>>()
  const byAccess = new Map<string, Held<RecordedAnswer>>()
  for (const [order, one] of answers.entries()) {
    if (one.about !== undefined) {
      // A level's consumer is part of the question it answers: two rounds
      // answering the levels of two consumers of one grant answered two.
      const { entity, field, consumer } = one.about
      const key = `${entity}\u0000${field}\u0000${consumer ?? ''}`
      byEntity.set(key, { one: { ...one, about: one.about }, order })
    }
    if (one.access !== undefined) byAccess.set(accessKey(one.access), { one, order })
  }
  if (byEntity.size === 0 && byAccess.size === 0) {
    return { plan, answers: vouched, about, reapplied }
  }

  // Cloned, never mutated in place, for `deriveOwners`'s reason: the caller
  // still holds the plan it was handed.
  const clone = structuredClone(plan)
  // An entity this draft amends twice is not one an answer can be placed in:
  // which of the two it was about is not something the draft can say, so its
  // fields are asked again. The same of an access it states twice.
  const identities = identitiesOf(clone)
  const accesses = accessesOf(clone, over)
  // Every access the redraft states, counted twice or not: a level held by
  // its grant is put back there only when none of them is the one it was
  // typed for — where one is, that operation is where it belongs.
  const stated = new Set(
    clone.operations.flatMap((operation) => {
      const level = levelFieldOf(operation, over)
      return level === undefined ? [] : [accessKey(level.access)]
    }),
  )
  for (const [index, operation] of clone.operations.entries()) {
    // Field → the answer it receives. An entity's answers by their field, and
    // a level by its access; where both claim one field, the later answer.
    const placements = new Map<string, Placement>()
    const offer = (field: string, placement: Placement): void => {
      const standing = placements.get(field)
      if (standing === undefined || standing.order < placement.order) {
        placements.set(field, placement)
      }
    }
    const entity = identities[index]
    const level = accesses[index]
    const carried = level === undefined ? undefined : byAccess.get(accessKey(level.access))
    if (entity !== undefined) {
      const site = levelSiteOf(operation)
      for (const { one, order } of byEntity.values()) {
        if (one.about.entity !== entity) continue
        const { consumer, field } = one.about
        // A level held by its grant: only for the consumer it was typed for,
        // and only when its own access is nowhere in the redraft and this
        // operation's access has no answer of its own. See the module comment.
        if (consumer !== undefined) {
          if (site?.field !== field || site.consumer !== consumer) continue
          if (one.access !== undefined && stated.has(accessKey(one.access))) continue
          if (carried !== undefined && level?.field === field) continue
        }
        offer(field, { one, order, about: entity })
      }
    }
    if (level !== undefined && carried !== undefined) {
      offer(level.field, { ...carried, about: accessWords(level.access) })
    }

    for (const [field, { one, about: what }] of placements) {
      const path = `operations.${index}.${field}`
      const found = holderOf(operation, field)
      if (found === undefined) continue
      const { holder, key } = found
      const had = Object.hasOwn(holder, key)
      const current = holder[key]

      if (current === one.value) {
        vouched.set(path, one.value)
        // Not a list element or a consumer: those stand only where the draft
        // put them, and `about` is what the engine puts back whatever it wrote.
        if (!positional(field)) about.set(path, what)
        continue
      }
      if (positional(field)) continue
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
      about.set(path, what)
      reapplied.push({
        path,
        value: one.value,
        entity: what,
        answeredAt: one.path,
        ...(typeof current === 'string' ? { replaced: current } : {}),
      })
    }
  }

  return { plan: clone, answers: vouched, about, reapplied }
}
