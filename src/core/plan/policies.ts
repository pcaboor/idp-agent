import { answered, named, type Provenance } from './provenance.js'
import { levelClaim, proposedClaim, statedAs, type LevelClaim } from './grant.js'
import type { AccessLevel, Nature } from '../schemas/resource-types.js'
import type { Vocabulary } from '../schemas/vocabulary.js'
import type { SignedPlan } from './sign.js'

/**
 * The second gate of §6.1, which the design named four times and defined
 * nowhere.
 *
 * **A Policy is a deterministic predicate over a signed Plan.** No model, no
 * disk. That is the whole definition, and it is what makes these testable
 * without a repository and free to run: the first gate (the schema) rejects
 * what cannot be expressed, the signature asks about what nobody can vouch
 * for, and a policy refuses what is expressible, vouched for, and still wrong.
 *
 * Four ship in v0.1, and the count went DOWN when the level moved into the
 * operation: `level-mismatch` and `unamendable-level` asked the same question
 * of two shapes and answered a level-less declaration in opposite directions,
 * so they are one predicate here. A configurable rule engine — `governance/`,
 * and the `get_governance_rule` tool of §6 — is deferred: four predicates that
 * run are worth more than an extension point that does not.
 *
 * **Every operation is gated, not only the creations.** This loop once skipped
 * anything that was not a `create-entity` or a `create-catalog-info`, which
 * left `update-entity` — the operation that joins a consumer to an EXISTING
 * grant, and so the one that hands out an authorisation nobody re-declares —
 * travelling with no gate at all. A request naming `dev` could join a consumer
 * to a `prod` grant and meet nothing on the way. An update names its target by
 * reference rather than carrying an entity, so every fact about it is read off
 * the snapshot this context carries.
 */

export type PolicyName =
  | 'environment-mismatch'
  | 'unwitnessed-folder'
  | 'cross-environment-consumer'
  /** The level the operation states is not the level the repository declares. */
  | 'declared-level-mismatch'
  /** The operation hands a consumer to an entity that is not a right (§4.1). */
  | 'consumer-on-an-object'

export interface PolicyViolation {
  readonly policy: PolicyName
  readonly opIndex: number
  /** The dotted path, so a violation reads like the questions do. */
  readonly path: string
  readonly message: string
}

export interface PolicyContext {
  readonly vocabulary: Vocabulary
  /** Folders holding a witness, repository-relative. §7.2's structure. */
  readonly witnesses: ReadonlySet<string>
  /** ref → the environment that entity declares, from the snapshot. */
  readonly environments: ReadonlyMap<string, string>
  /**
   * ref → the level that entity declares, for every entity the snapshot holds.
   *
   * `has` and `get` answer different questions and both are needed. `has` says
   * the repository declares that reference at all — a grant it has never heard
   * of is a creation, and no level of it is wrong yet. `get` says what level
   * the declaration states, `undefined` when it states none: §4.1's unstated
   * level, which is reported as absent and never read as `readwrite`. So a
   * file with no level does NOT already say `read`, and the map says so
   * without a second set to carry "declared" separately.
   */
  readonly levels: ReadonlyMap<string, AccessLevel | undefined>
  /**
   * ref → thing or right, for every entity the snapshot holds (§4.1).
   *
   * Kept apart from `levels` because the two say different things about the
   * same silence. A right that states no level and a database that CANNOT
   * state one both answer `undefined` there, and telling a model to fix the
   * level of a database is how this gate used to spend a repair attempt.
   */
  readonly natures: ReadonlyMap<string, Nature>
}


const folderOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Every environment the plan touches: the one an entity declares, and the ones
 * its name carries. A name is checked because the signature lets a name keep a
 * segment a witnessed reference vouches for — `billing-api-orders-db-prod`
 * passes on a dev request, because `orders-db-prod` exists. The value is right
 * about where it came from and wrong about what it says, which is exactly the
 * gap a policy is for.
 */
function environmentsTouched(entity: unknown, vocabulary: Vocabulary): string[] {
  if (typeof entity !== 'object' || entity === null) return []
  const metadata = (entity as { metadata?: unknown }).metadata
  if (typeof metadata !== 'object' || metadata === null) return []

  const touched = new Set<string>()
  const { env, name } = metadata as { env?: unknown; name?: unknown }

  if (typeof env === 'string') touched.add(env)
  if (typeof name === 'string') {
    for (const segment of name.split('-')) {
      if (vocabulary.environments.includes(segment)) touched.add(segment)
    }
  }
  return [...touched]
}

/**
 * The level the operation STATES against the level the repository DECLARES.
 *
 * One comparison, both shapes of operation, replacing two policies that
 * compared different things and answered the same declaration in opposite
 * directions. `level-mismatch` read the requested level out of the request —
 * `echoes(intent, 'readwrite' | 'write' | 'read')` — which fails on its own
 * terms: a request arrives in whatever language the person wrote it in (see
 * `echoes`), so "accès en lecture" named no level, the gate stayed silent, and
 * a `readwrite` grant was handed to a request for `read` at exit 0. It also
 * read "read replica" — a database term, in a database-access tool — as a
 * request for `read`. And it stayed silent when the grant declared no level,
 * while `unamendable-level` hard-refused that very case on a creation.
 *
 * Both halves are now facts: §5.3 puts the level in the `add-dependency-of`
 * patch, so nothing here reads a word of the request. What the request named
 * is the SIGNATURE's question — a level the request did not name is novel and
 * leaves as a question, in every script — and this gate asks the one a
 * deterministic predicate can answer: does the level the plan states match the
 * one the repository declares?
 *
 * Silence is a claim, not a gap, and that is what makes the two directions
 * consistent. An operation omitting the level says the grant has none, which
 * is exactly what a pre-`access` declaration says — so joining a consumer to
 * one is legitimate work and passes, and the objection that firing here would
 * refuse every such update is answered by making the claim expressible rather
 * than by staying silent. The same omission against a grant that declares
 * `readwrite` is refused, and so is a stated level against a declaration that
 * states none: an unstated level is unstated (§4.1), never read as anything.
 *
 * What this does NOT cover: whether the level is the RIGHT one for what was
 * asked. It compares the plan to the repository, not to the request. The
 * signature asks where the value came from, the Reviewer reads the request,
 * and the merge is the act of authorisation (§4.2).
 */
function levelMismatch(
  context: PolicyContext,
  opIndex: number,
  path: string,
  ref: string | undefined,
  claim: LevelClaim,
): PolicyViolation | undefined {
  // `has`, never `get`: a reference the map does not hold at all is a grant
  // this repository has never declared, and no level of it is wrong yet. See
  // PolicyContext.levels for why the two answers are different questions.
  if (ref === undefined || !context.levels.has(ref)) return undefined
  // A thing has no level, so no level of it can mismatch. Without this the
  // map's `undefined` for a database reads as "declares no level", any stated
  // level differs from it, and the violation says to change the level line —
  // on an entity whose real problem is that it is not a grant at all. That is
  // `consumer-on-an-object`'s to say, and it says it in the same pass.
  if (context.natures.get(ref) !== 'right') return undefined
  // A question is not a claim. The signer already replaced what the model
  // wrote, `planEdits` drops the operation, and the CLI asks before any
  // preview is offered — refusing here would state one stop twice.
  if (claim.said === 'question') return undefined

  const declared = context.levels.get(ref)
  const stated = claim.said === 'level' ? claim.level : undefined
  if (declared === stated) return undefined

  return {
    policy: 'declared-level-mismatch',
    opIndex,
    path,
    message:
      `${ref} ${statedAs(declared)}, and this plan ${statedAs(stated)}. A level is a scalar ` +
      `and this tool only ever appends (§4.3), so what would be granted is the level the ` +
      `repository declares. ${repairFor(declared)}`,
  }
}

/**
 * What to do about it, in the words of whoever has to do it.
 *
 * This used to end "change that line where a reviewer sees it" — advice for a
 * person editing YAML, handed to a model that has to fill a JSON field. The
 * scenario that found it spent all three attempts re-proposing the same
 * operation with `access` still omitted: the model was told what was wrong and
 * never what to write. A repair message that cannot be acted on is a refusal
 * with extra words.
 *
 * Both directions name the same level, because an `add-dependency-of` hands
 * over the level the grant already declares and cannot alter it. The way to
 * hand over a DIFFERENT one is a different grant, which is the second
 * sentence rather than a hint.
 */
const repairFor = (declared: AccessLevel | undefined): string =>
  declared === undefined
    ? `State no level either — omit 'access' — or declare a separate grant that states one.`
    : `State '"access": "${declared}"' to hand over what it grants, or declare a ` +
      `separate grant for a different level.`

const referencesOf = (entity: unknown): string[] => {
  if (typeof entity !== 'object' || entity === null) return []
  const spec = (entity as { spec?: unknown }).spec
  if (typeof spec !== 'object' || spec === null) return []
  const { dependsOn, dependencyOf } = spec as { dependsOn?: unknown; dependencyOf?: unknown }
  return [...(Array.isArray(dependsOn) ? dependsOn : []), ...(Array.isArray(dependencyOf) ? dependencyOf : [])]
    .filter((reference): reference is string => typeof reference === 'string')
}

/**
 * The environments the user stated for one operation, and where each came from.
 *
 * The request's are every operation's: a sentence naming `prod` names it for
 * the whole plan. An answer is the user's word about ONE field, and the one
 * field a plan carries an environment in is `metadata.env` on a proposed
 * entity — an update names its grant by reference and states none of its own.
 * So an answer counts for the operation it was typed at, and only while that
 * operation still holds the value typed: `dev` answered for a database in
 * operation 0 says nothing about the grant operation 1 joins, and an answer at
 * a path this plan does not hold says nothing about this plan at all. Read
 * plan-wide, either one cleared an `environment-mismatch` the user never
 * spoke to.
 *
 * `named` for the request, `answered` at the operation's own field — the same
 * two sources `stated` composes when the signature vouches for an environment,
 * which is what makes a plan refused with `dev` typed into the request refused
 * with `dev` typed at a prompt too. Kept apart here because the message says
 * which of the two it was. Measured against the vocabulary either way, so
 * the two sources cannot disagree about what counts: a word the repository has
 * never used as an environment names none, typed anywhere.
 */
interface StatedEnvironments {
  /** Every environment stated for this operation, by either source. */
  readonly all: readonly string[]
  /** The ones the request named. */
  readonly named: readonly string[]
  /** The one answered at this operation's own environment, and where. */
  readonly answered: { readonly env: string; readonly path: string } | undefined
}

function environmentsStated(
  vocabulary: Vocabulary,
  provenance: Provenance,
  opIndex: number,
  entity: unknown,
): StatedEnvironments {
  const fromRequest = vocabulary.environments.filter((env) => named(provenance, env))
  const path = `operations.${opIndex}.entity.metadata.env`
  const own = environmentOf(entity)
  const fromAnswer =
    own !== undefined &&
    vocabulary.environments.includes(own) &&
    !fromRequest.includes(own) &&
    answered(provenance, path, own)
      ? { env: own, path }
      : undefined
  return {
    all: fromAnswer === undefined ? fromRequest : [...fromRequest, fromAnswer.env],
    named: fromRequest,
    answered: fromAnswer,
  }
}

/** The environment an entity declares in `metadata.env`, when it declares one. */
const environmentOf = (entity: unknown): string | undefined => {
  if (typeof entity !== 'object' || entity === null) return undefined
  const metadata = (entity as { metadata?: unknown }).metadata
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const { env } = metadata as { env?: unknown }
  return typeof env === 'string' ? env : undefined
}

/**
 * Whose word each environment was, for the sentence a person reads. A message
 * saying the request named an environment the user only typed at a prompt
 * would be the engine misquoting the person it is reporting to.
 */
const statedAsWords = ({ named: fromRequest, answered: fromAnswer }: StatedEnvironments): string =>
  [
    ...(fromRequest.length > 0 ? [`the request named ${fromRequest.join(' and ')}`] : []),
    ...(fromAnswer === undefined ? [] : [`${fromAnswer.env} was answered at ${fromAnswer.path}`]),
  ].join(', and ')

/**
 * `provenance` is what the user stated, the one source of it (see
 * `Provenance`) — a round's, where `context` is the run's: the ask loop changes
 * the first between passes and never the second.
 */
export function checkPolicies(
  signed: SignedPlan,
  context: PolicyContext,
  provenance: Provenance,
): PolicyViolation[] {
  const violations: PolicyViolation[] = []
  const { operations } = signed.plan

  // One sentence, two shapes of operation. A creation touches an environment
  // through the entity it carries and an update through the references it
  // names, and "an environment is never inferred" is the same refusal in both.
  const mismatch = (
    opIndex: number,
    path: string,
    touched: string,
    asked: StatedEnvironments,
  ): PolicyViolation => ({
    policy: 'environment-mismatch',
    opIndex,
    path,
    message:
      `the plan touches ${touched}, but ${statedAsWords(asked)}. ` +
      `An environment is never inferred.`,
  })

  for (const [opIndex, operation] of operations.entries()) {
    // The environments the user stated for this operation. When they stated
    // none, every environment policy stays silent: the signer already turned
    // that into a question, and firing here would report the same thing twice.
    const asked = environmentsStated(
      context.vocabulary,
      provenance,
      opIndex,
      operation.op === 'update-entity' ? undefined : operation.entity,
    )

    if (operation.op === 'update-entity') {
      // `operation.patch.consumer` is read straight off the union: §5.3 keeps
      // `Patch` closed and it holds one member today, so a second member
      // without a consumer breaks the build right here — which is the right
      // way to be told that this gate has a new case to answer for.
      const { entityRef, patch } = operation
      const grantEnv = context.environments.get(entityRef)
      const consumerEnv = context.environments.get(patch.consumer)

      if (asked.all.length > 0) {
        // Both ends, because an update touches both: the grant being extended
        // and the consumer being joined to it. A reference the repository
        // declares no environment for contributes none — declare, never infer,
        // and reading one off a name is what `environmentsTouched` is for on
        // the side where a name is the model's to choose.
        for (const [path, touched] of [
          [`operations.${opIndex}.entityRef`, grantEnv],
          [`operations.${opIndex}.patch.consumer`, consumerEnv],
        ] as const) {
          if (touched === undefined || asked.all.includes(touched)) continue
          violations.push(mismatch(opIndex, path, touched, asked))
        }
      }

      // The same §4.1 rule the creation side reads off `spec.dependencyOf`,
      // asked of the one reference an update adds: being authorised in dev
      // grants nothing in prod, and an update is where that authorisation is
      // handed to somebody without anyone re-declaring it.
      if (grantEnv !== undefined && consumerEnv !== undefined && grantEnv !== consumerEnv) {
        violations.push({
          policy: 'cross-environment-consumer',
          opIndex,
          path: `operations.${opIndex}.patch.consumer`,
          message:
            `${patch.consumer} lives in ${consumerEnv}, but ${entityRef} is scoped to ` +
            `${grantEnv}. Being authorised in one environment grants nothing in another.`,
        })
      }

      // §4.1, asked of the target before anything else is asked of it: a
      // right carries its consumers and a thing does not. Nothing downstream
      // asks either — `planEdits` finds the file by reference and appends the
      // consumer line to whatever is in it, so an update aimed at a database
      // writes a consumer list onto the database, and the diff a person reads
      // shows one plausible added line in a file that legitimately exists.
      //
      // `has`, for the same reason `levelMismatch` uses it: a reference this
      // repository declares nowhere has no nature to be wrong about, and
      // `planEdits` drops that operation by name a moment later.
      const nature = context.natures.get(entityRef)
      if (nature !== undefined && nature !== 'right') {
        violations.push({
          policy: 'consumer-on-an-object',
          opIndex,
          path: `operations.${opIndex}.entityRef`,
          message:
            `${entityRef} is a thing, not a right over one, so it carries no ` +
            `consumers to add ${patch.consumer} to. Access to it is a right of ` +
            `its own — declare one that depends on it.`,
        })
      }

      // The level of the grant being extended IS the authorisation being
      // handed over, and one `add-dependency-of` hands it over whole. Nothing
      // downstream asks: the unified diff shows an added consumer line in an
      // otherwise unchanged file, and `access:` sits further from the
      // insertion than the three lines of context a hunk carries — so the
      // level is an unchanged line, invisible to whoever does the merging.
      //
      // The path names the field the operation would have to change, which is
      // the field the repair report hands back — including when the operation
      // omitted it and the claim was the omission.
      const level = levelMismatch(
        context,
        opIndex,
        `operations.${opIndex}.patch.access`,
        entityRef,
        levelClaim(patch.access),
      )
      if (level !== undefined) violations.push(level)

      // `unwitnessed-folder` is deliberately not asked here. It is about a
      // folder the ENGINE computed a path into — §7.2: writing where the
      // repository never declared structure invents it — and an update
      // computes no path at all. It amends a file that already exists, in a
      // folder that already holds it, so there is no structure to invent.
      // `signed.paths` holds no entry for an update either, so the check below
      // would be silent anyway; it is stated rather than left to fall out of
      // the data.
      continue
    }

    if (operation.op !== 'create-entity' && operation.op !== 'create-catalog-info') continue
    const entity: unknown = operation.entity

    if (asked.all.length > 0) {
      for (const touched of environmentsTouched(entity, context.vocabulary)) {
        if (asked.all.includes(touched)) continue
        violations.push(
          mismatch(opIndex, `operations.${opIndex}.entity.metadata`, touched, asked),
        )
      }
    }

    const produced = signed.paths.get(opIndex)
    if (produced !== undefined) {
      const folder = folderOf(produced)
      if (!context.witnesses.has(folder)) {
        violations.push({
          policy: 'unwitnessed-folder',
          opIndex,
          path: `operations.${opIndex}`,
          message:
            `${folder} holds no witness, so the repository never declared it. ` +
            `Writing there would invent structure.`,
        })
      }
    }

    // An access is the shape §4.1 is about: it grants one thing to another,
    // and the grant is scoped to an environment. A reference the repository
    // has never seen is dangling-reference's business, and CI already runs
    // that rule — guessing here would report a worse second version of it.
    const declared = environmentsTouched(entity, context.vocabulary)
    for (const reference of referencesOf(entity)) {
      const theirs = context.environments.get(reference)
      if (theirs === undefined) continue
      if (declared.length === 0 || declared.includes(theirs)) continue
      violations.push({
        policy: 'cross-environment-consumer',
        opIndex,
        path: `operations.${opIndex}.entity.spec`,
        message:
          `${reference} lives in ${theirs}, but this declaration is scoped to ` +
          `${declared.join(' and ')}. Being authorised in one environment ` +
          `grants nothing in another.`,
      })
    }

    // The same comparison the update branch makes, read off the entity this
    // operation carries rather than off the patch. "Already declared" compares
    // the GRANT (`grant.ts`), so a plan restating a different level writes no
    // bytes — and this is what says so, before a diff is ever offered, rather
    // than a preview reporting "nothing to change" about a change nobody made.
    //
    // `signed.refs` holds an entry only for a `create-entity` of a Resource,
    // so a Component and a `create-catalog-info` fall out silently: neither
    // states a level, and neither is a grant.
    const level = levelMismatch(
      context,
      opIndex,
      `operations.${opIndex}.entity.spec.access`,
      signed.refs.get(opIndex),
      proposedClaim(entity),
    )
    if (level !== undefined) violations.push(level)
  }

  // Every violation, never the first: a caller fixing them one round-trip at
  // a time is the repair loop's worst case, and each round-trip is paid for.
  return violations
}
