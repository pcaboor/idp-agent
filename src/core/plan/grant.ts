import type { Entity } from '../schemas/entity.js'
import type { Operation } from '../schemas/plan.js'
import {
  RESOURCE_TYPES,
  RESOURCE_TYPE_NAMES,
  levelledOf,
  type AccessLevel,
  type Nature,
  type ResourceType,
} from '../schemas/resource-types.js'

/**
 * What "already declared" means, in one place.
 *
 * It used to mean a NAME. `planEdits` asked `listDocumentNames` whether the
 * file held a document called what the plan proposed, and `recheckPlan` asked
 * whether the reference was declared at the computed path — so a plan stating
 * `read` against a file granting `readwrite` produced an edit whose two sides
 * were equal, an empty diff, and a run that ended on "nothing to change — the
 * repository already says it". The tool asserted a falsehood about an
 * authorisation in both directions: a requested narrowing silently did not
 * happen, and a request for `read` was reported satisfied by a standing
 * `readwrite`.
 *
 * A grant IS its level — §4.1: a right states the level it grants, and only a
 * right may — so a declaration restates a proposal when it states the same
 * level. `planEdits` asks that to decide whether to write bytes and
 * `recheckPlan` asks it to name the outcome a person reads; two answers to one
 * question is the shape this folder has paid for before, so there is one.
 *
 * What this does NOT compare: the owner, the type, the environment, the
 * consumer list, or anything else. A file legitimately carries consumers, a
 * description and tags no proposal ever states, so comparing documents would
 * call a genuine replay a change and refuse it. The level is the field that is
 * the authorisation, and it is the one this closes — a declaration whose OWNER
 * differs still reads as already declared here, and nothing below says
 * otherwise.
 */

/** The level a declaration states, or undefined when it states none (§4.1). */
export const declaredLevel = (entity: Entity): AccessLevel | undefined =>
  entity.kind === 'Resource' ? entity.spec.access : undefined

/**
 * The level a PROPOSAL states as a value.
 *
 * A question is not a value and neither is silence, and both come back
 * undefined. That fold is safe here and nowhere else: an operation carrying a
 * question produces no bytes at all (`planEdits` drops it) and the CLI puts
 * the question to the user before any preview is offered, so the two never
 * reach a reader as one answer.
 *
 * Takes `unknown` because a proposal is not an `Entity` — it carries
 * `metadata.env` and no apiVersion (see `materialise`), and translating one
 * just to read a level would make this the third module that owns that seam.
 */
export function proposedLevel(entity: unknown): string | undefined {
  const access = statedAccess(entity)
  return typeof access === 'string' ? access : undefined
}

/** The `spec.access` a proposal carries, in whatever shape it carries it. */
function statedAccess(entity: unknown): unknown {
  if (typeof entity !== 'object' || entity === null) return undefined
  const spec = (entity as { spec?: unknown }).spec
  if (typeof spec !== 'object' || spec === null) return undefined
  return (spec as { access?: unknown }).access
}

/**
 * What an operation SAYS about a level, with the three answers kept apart.
 *
 * `proposedLevel` folds a question into silence and states why that fold is
 * safe where it is read: an operation carrying a question produces no bytes at
 * all. A policy cannot fold them, because silence is a CLAIM here rather than
 * a gap — `patchSchema` says why an `add-dependency-of` had to be able to
 * express "this grant states no level", and `proposedResourceSchema` says the
 * same of a right that has none. Read as silence, a question would be compared
 * against a level-less declaration, found equal, and a level nobody could name
 * would pass as agreed.
 *
 * What this does NOT say is whether the claim is TRUE. That is the comparison
 * `declared-level-mismatch` makes, against the declaration this module reads.
 */
export type LevelClaim =
  /** `read` or `readwrite`: a value, and the level that would be handed over. */
  | { readonly said: 'level'; readonly level: string }
  /** `{unknown}`: the model could not determine one, so the CLI asks first. */
  | { readonly said: 'question' }
  /** No field at all: the claim that this grant has no level to state (§4.1). */
  | { readonly said: 'none' }

export function levelClaim(access: unknown): LevelClaim {
  if (typeof access === 'string') return { said: 'level', level: access }
  // Anything neither a string nor absent came through `or(...)`, so it is
  // `{unknown}` — the only other shape the proposal boundary admits.
  if (access !== undefined) return { said: 'question' }
  return { said: 'none' }
}

/** The same question, asked of a proposed entity's `spec.access`. */
export const proposedClaim = (entity: unknown): LevelClaim => levelClaim(statedAccess(entity))

/** Whether a declaration already states the grant a proposal states. */
export const restates = (declared: Entity, proposal: unknown): boolean =>
  declaredLevel(declared) === proposedLevel(proposal)

/**
 * How a level reads in a sentence. An unstated one is reported as unstated and
 * never as a blank — §4.1 again: absent is absent, never read as `readwrite`.
 */
export const statedAs = (level: string | undefined): string =>
  level === undefined ? 'states no level' : `grants ${level}`

/**
 * Whether an entity is a thing or a right over a thing (§4.1).
 *
 * Total, and the two sides are answered from different places because they are
 * knowable in different ways. A Resource's type is a closed enum, so the table
 * that declares the nature of each type answers it outright. A Component's is
 * free text — `service`, `website`, whatever a team writes — and no list of
 * those could ever be complete, so the answer comes from the KIND instead: a
 * Component is a thing the organisation runs, never an authorisation over one.
 *
 * Asked by the gate that refuses to hand an authorisation to an entity that
 * cannot carry one, and by `declared-level-mismatch` before it compares a
 * level to a declaration that was never able to state one.
 */
export const natureOf = (entity: Entity): Nature =>
  entity.kind === 'Resource' ? RESOURCE_TYPES[entity.spec.type].nature : 'object'

/**
 * ref → what that right is over — its `dependsOn` — for every right a
 * repository declares WHOSE TYPE STATES A LEVEL. An `update-entity` names its
 * grant by reference and carries none of it, so this is how the engine knows
 * which thing a consumer joined to an existing grant would reach at a level.
 *
 * Only the levelled rights, and that is the point of it rather than a saving.
 * A `network-access` over orders-db-prod is billing-api reaching that database
 * too, but not at any level: a level answered for billing-api's database
 * access, carried by that access onto a network join, was written into a
 * `patch.access` the grant cannot state and refused there — and a plan that
 * held both counted one access twice and asked its level again. So `has` on
 * this map is also the engine's one answer to "does this declared grant state
 * a level", and the policy and the questions read it as that (`levelSiteOf`).
 */
export type GrantedOver = ReadonlyMap<string, readonly string[]>

/** Whether a declaration is a right whose type states a level: the ones `GrantedOver` holds. */
export const statesLevels = (entity: Entity): entity is Extract<Entity, { kind: 'Resource' }> =>
  entity.kind === 'Resource' && levelledOf(entity.spec.type)

/**
 * An access, as the person thinks of it: who reaches what. Not the grant that
 * carries it — the owner's run answered "the level at which billing-api reaches
 * orders-db-prod", and whether a draft says that by joining billing-api to
 * orders-api's grant or by declaring a grant of its own is the draft's choice,
 * not the person's.
 */
export interface AccessSubject {
  readonly consumer: string
  readonly resource: string
}

/** Where an operation states the level of an access, and which access it is. */
export interface LevelField {
  /** Dotted, relative to the operation: `patch.access` or `entity.spec.access`. */
  readonly field: string
  readonly access: AccessSubject
}

/** The one reference a list holds, or undefined when it holds none, several or a question. */
export const soleReference = (list: unknown): string | undefined =>
  Array.isArray(list) && list.length === 1 && typeof list[0] === 'string' ? list[0] : undefined

/**
 * Where an operation would state a level, and the one consumer it would state
 * it for — read off the operation alone, whatever the grant turns out to be.
 *
 * An update joins ONE consumer, and states the level at `patch.access`; a
 * creation of a Resource states it at `entity.spec.access`, for the consumer
 * its `dependencyOf` holds when it holds exactly one. A grant for two
 * consumers states one level for both, which neither could claim alone, and
 * has no consumer here. This is what an answer typed at a level is about
 * before anything is known of the access: the consumer it was typed for.
 */
export interface LevelSite {
  /** Dotted, relative to the operation: `patch.access` or `entity.spec.access`. */
  readonly field: string
  readonly consumer: string | undefined
}

export function levelSiteOf(operation: Operation): LevelSite | undefined {
  switch (operation.op) {
    case 'update-entity': {
      const { consumer } = operation.patch
      return {
        field: 'patch.access',
        consumer: typeof consumer === 'string' ? consumer : undefined,
      }
    }
    case 'create-entity':
      return operation.entity.kind === 'Resource'
        ? {
            field: 'entity.spec.access',
            consumer: soleReference(operation.entity.spec.dependencyOf),
          }
        : undefined
    case 'create-catalog-info':
      return undefined
    default: {
      const exhaustive: never = operation
      return exhaustive
    }
  }
}

/**
 * Where an operation states the level of a grant that HAS one, and the
 * consumer and the thing as far as they are known — each undefined where the
 * operation or the repository does not say exactly one.
 *
 * An update's grant states a level when the repository declares it among the
 * levelled rights (`GrantedOver`), and reaches what that grant is over; a
 * creation's type says outright. A right with no level (`network-access`) and
 * an update of a grant the repository does not declare as levelled answer
 * undefined: no level of theirs is anyone's answer.
 */
export interface LevelledSite extends LevelSite {
  readonly resource: string | undefined
}

export function levelledSiteOf(operation: Operation, over: GrantedOver): LevelledSite | undefined {
  const site = levelSiteOf(operation)
  if (site === undefined) return undefined
  switch (operation.op) {
    case 'update-entity':
      return over.has(operation.entityRef)
        ? { ...site, resource: soleReference(over.get(operation.entityRef)) }
        : undefined
    case 'create-entity': {
      const { entity } = operation
      if (entity.kind !== 'Resource') return undefined
      const { type, dependsOn } = entity.spec
      if (typeof type !== 'string' || !RESOURCE_TYPE_NAMES.includes(type as ResourceType)) {
        return undefined
      }
      if (!levelledOf(type as ResourceType)) return undefined
      return { ...site, resource: soleReference(dependsOn) }
    }
    case 'create-catalog-info':
      return undefined
    default: {
      const exhaustive: never = operation
      return exhaustive
    }
  }
}

/**
 * The access an operation states a level for, when there is exactly one: a
 * `levelledSiteOf` whose consumer and thing are both known. Anything else — a
 * question in the consumer or the type, a grant over two databases, a grant
 * for two consumers, a right with no level — answers undefined, and a caller
 * asking to carry an answer by its access carries nothing.
 */
export function levelFieldOf(operation: Operation, over: GrantedOver): LevelField | undefined {
  const site = levelledSiteOf(operation, over)
  if (site?.consumer === undefined || site.resource === undefined) return undefined
  return { field: site.field, access: { consumer: site.consumer, resource: site.resource } }
}

/** An access in words, the same words everywhere it is named. */
export const accessWords = ({ consumer, resource }: AccessSubject): string =>
  `${consumer}'s access to ${resource}`
