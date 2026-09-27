import { entitySchema, type Entity } from '../schemas/entity.js'
import type { Operation } from '../schemas/plan.js'
import {
  RESOURCE_TYPES,
  RESOURCE_TYPE_NAMES,
  levelledOf,
  type AccessLevel,
  type Nature,
  type ResourceType,
} from '../schemas/resource-types.js'
import { ENV_ANNOTATION } from '../schemas/vocabulary.js'
import { materialise } from './materialise.js'

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
 * Then it meant a LEVEL, and the same falsehood came back through every other
 * field (review priority 8, runtime-probe-1): a grant of that name held by
 * another consumer, owned by another team or scoped to another environment
 * restated a proposal whenever the two levels agreed, so an access nobody had
 * was reported on exit 0 as the one the request asked for.
 *
 * So a declaration restates an operation when EVERYTHING the operation would
 * declare is already there (`restatementOf`, `consumerRestatement`): the type,
 * the environment, the level, the owner, what the right is over and who holds
 * it. Anything missing or different is not already declared. `planEdits` asks
 * this to decide whether to write bytes, `recheckPlan` to name the outcome a
 * person reads, and the `declared-otherwise` policy to refuse a creation that
 * says otherwise before any preview; three answers to one question is the
 * shape this folder has paid for before, so there is one.
 *
 * Two lists are compared by INCLUSION, and that is not leniency. A file
 * legitimately carries consumers, targets, a description and tags no proposal
 * ever states — a grant orders-api also holds is still billing-api's access —
 * so a declaration listing more than the proposal restates it, and one
 * missing an item does not. What is not compared: a description, tags, a
 * Component's lifecycle — nothing a proposal states about an authorisation.
 *
 * References are compared as the reader reads them. The declaration arrives
 * parsed by `entitySchema`, which writes Backstage's short forms in full; the
 * proposal is read through the same schema when it can be (`asRead`), so both
 * sides meet in one spelling and a file writing `owner: tiger` restates a
 * proposal naming `group:default/tiger`.
 */

/** A field an operation states, as the declaration already says it. */
export interface DeclaredField {
  /** The key a reader finds in the file: `owner`, `dependencyOf`, `company.fr/env`. */
  readonly field: string
  readonly value: string
}

/** A field an operation states and the declaration does not say. */
export interface FieldDifference {
  readonly field: string
  /** What the declaration says there — the whole list, for a list. */
  readonly declared: string
  /** What the operation says there — for a list, the items the declaration lacks. */
  readonly proposed: string
  /**
   * Present when the operation holds `{unknown}` there. A question is not a
   * claim: the signature asks it before anything is previewed, so a gate
   * refusing it as well would state one stop twice.
   */
  readonly question?: true
}

export type Restatement =
  /** Already declared: every field the operation states, as the file says it. */
  | { readonly restates: true; readonly fields: readonly DeclaredField[] }
  /** Not: every field that differs, never the first alone. */
  | { readonly restates: false; readonly differs: readonly FieldDifference[] }

/** What a field reads as when nothing is stated there. §4.1: absent is absent. */
const NONE = 'none'
/** What a field reads as when it holds `{unknown}`. A question is never a value. */
const QUESTION = 'a question'

const words = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined ? NONE : QUESTION

const listWords = (list: readonly string[]): string => (list.length === 0 ? NONE : list.join(', '))

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/**
 * The fields of a proposal this comparison reads, references written as the
 * reader writes them.
 *
 * A proposal is not an Entity (see `materialise`), and its references are the
 * strict full form already; reading it through `entitySchema` anyway is what
 * makes "normalised as the reader normalises them" a fact rather than a
 * coincidence of two grammars. A proposal the schema refuses — one still
 * carrying a question, a consumer list on a thing — is read as written, and a
 * question in it stays a question.
 */
function asRead(proposal: unknown): Record<string, unknown> & { env?: unknown } {
  const raw = objectOf(proposal)
  const spec = objectOf(raw.spec)
  const env = objectOf(raw.metadata).env
  const entity = materialise(proposal)
  const read = entity === undefined ? undefined : entitySchema.safeParse(entity)
  return read?.success === true ? { ...spec, ...read.data.spec, env } : { ...spec, env }
}

/**
 * Whether `declared` — the declaration of the reference a creation names —
 * already says everything `proposal` says, and if not, what differs.
 */
export function restatementOf(declared: Entity, proposal: unknown): Restatement {
  const proposed = asRead(proposal)
  const fields: DeclaredField[] = []
  const differs: FieldDifference[] = []

  const scalar = (field: string, there: unknown, here: unknown, listed = true): void => {
    if (there === here && typeof here === 'string') {
      fields.push({ field, value: here })
      return
    }
    // Neither side states it: nothing to compare, and nothing to name.
    if (there === undefined && here === undefined) {
      if (listed) fields.push({ field, value: NONE })
      return
    }
    differs.push({
      field,
      declared: words(there),
      proposed: words(here),
      ...(typeof here === 'object' && here !== null ? { question: true as const } : {}),
    })
  }

  const included = (field: string, there: readonly string[] | undefined, here: unknown): void => {
    // A proposal that states no list claims nothing about one: a thing states
    // no consumers, and the schema refuses a right that states none.
    if (here === undefined) return
    const theirs = there ?? []
    if (!Array.isArray(here) || !here.every((item) => typeof item === 'string')) {
      differs.push({ field, declared: listWords(theirs), proposed: QUESTION, question: true })
      return
    }
    const missing = here.filter((item) => !theirs.includes(item))
    if (missing.length === 0) fields.push({ field, value: listWords(here) })
    else differs.push({ field, declared: listWords(theirs), proposed: missing.join(', ') })
  }

  const spec = declared.spec as {
    type?: unknown
    access?: unknown
    owner?: unknown
    dependsOn?: string[]
    dependencyOf?: string[]
  }
  scalar('type', spec.type, proposed.type)
  scalar(ENV_ANNOTATION, declared.metadata.annotations[ENV_ANNOTATION], proposed.env, false)
  scalar('access', declaredLevel(declared), proposed.access, false)
  scalar('owner', spec.owner, proposed.owner)
  included('dependsOn', spec.dependsOn, proposed.dependsOn)
  included('dependencyOf', spec.dependencyOf, proposed.dependencyOf)

  return differs.length === 0 ? { restates: true, fields } : { restates: false, differs }
}

/**
 * Whether the grant an `add-dependency-of` extends already gives `consumer`
 * the access the operation states: the consumer listed, at the level the
 * operation claims (§5.3 — an omitted level claims the grant states none).
 *
 * The type, the environment, the owner and what the grant is over are named
 * for a reader and not compared: the operation states none of them, since it
 * names its grant by reference. They are named because they are the only way
 * to see WHICH access is already there. A draft extending a grant over
 * payments-db-prod that already lists billing-api is already declared, and
 * printed the consumer, the level and the environment alone, so a request for
 * orders-db-prod read as done with nothing on the page to tell the two apart.
 * Whether that grant is over what the request asked for is not decided here —
 * this reads no request — and `docs/roadmap.md` carries it. The environment
 * policies hold what the user answered or pointed at to the grant's own.
 */
export function consumerRestatement(
  declared: Entity,
  consumer: string,
  access: unknown,
): Restatement {
  const fields: DeclaredField[] = []
  const differs: FieldDifference[] = []
  const spec = declared.spec as { type?: unknown; owner?: unknown; dependsOn?: string[] }
  // Named, in the order a creation's are, so the two read alike.
  const named = (field: string, value: unknown): void => {
    if (typeof value === 'string') fields.push({ field, value })
  }

  named('type', spec.type)
  named(ENV_ANNOTATION, declared.metadata.annotations[ENV_ANNOTATION])

  const claim = levelClaim(access)
  const level = declaredLevel(declared)
  if (claim.said === 'question') {
    differs.push({ field: 'access', declared: words(level), proposed: QUESTION, question: true })
  } else {
    const stated = claim.said === 'level' ? claim.level : undefined
    if (stated === level) fields.push({ field: 'access', value: words(level) })
    else differs.push({ field: 'access', declared: words(level), proposed: words(stated) })
  }

  named('owner', spec.owner)
  named('dependsOn', listWords(spec.dependsOn ?? []))

  const holders = declared.kind === 'Resource' ? (declared.spec.dependencyOf ?? []) : []
  if (holders.includes(consumer)) fields.push({ field: 'dependencyOf', value: consumer })
  else differs.push({ field: 'dependencyOf', declared: listWords(holders), proposed: consumer })

  return differs.length === 0 ? { restates: true, fields } : { restates: false, differs }
}

/**
 * One difference, as a sentence names it: for a list, what it lacks; for a
 * level, the words `statedAs` uses everywhere a level is named.
 */
export const differenceWords = (difference: FieldDifference): string => {
  const { field, declared, proposed } = difference
  if (field === 'dependsOn' || field === 'dependencyOf') {
    return difference.question === true
      ? `${field} is still a question`
      : `${field} lists ${declared}, not ${proposed}`
  }
  if (field === 'access') {
    const level = (value: string): string | undefined => (value === NONE ? undefined : value)
    return difference.question === true
      ? 'its level is still a question'
      : `it ${statedAs(level(declared))} where this plan ${statedAs(level(proposed))}`
  }
  return `${field} is ${declared} there and ${proposed} here`
}

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

/** Whether a declaration already says everything a proposal says. See `restatementOf`. */
export const restates = (declared: Entity, proposal: unknown): boolean =>
  restatementOf(declared, proposal).restates

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
