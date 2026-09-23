import type { Entity } from '../schemas/entity.js'
import { RESOURCE_TYPES, type AccessLevel, type Nature } from '../schemas/resource-types.js'

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
