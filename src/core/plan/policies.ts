import { answered, named, type Provenance } from './provenance.js'
import {
  environmentPath,
  environmentsNamedBy,
  requestedEnvironment,
  scopeOf,
  type Namesakes,
  type PointedAt,
} from './environment.js'
import {
  levelClaim,
  levelledSiteOf,
  proposedClaim,
  soleReference,
  statedAs,
  type AccessSubject,
  type GrantedOver,
  type LevelClaim,
} from './grant.js'
import type { AccessLevel, Nature } from '../schemas/resource-types.js'
import type { Vocabulary } from '../schemas/vocabulary.js'
import type { Operation } from '../schemas/plan.js'
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
 * Six ship in v0.1. The count once went DOWN, when the level moved into the
 * operation: `level-mismatch` and `unamendable-level` asked the same question
 * of two shapes and answered a level-less declaration in opposite directions,
 * so they are one predicate here. It went up again when a name stopped being
 * read as a scope (`environment-in-name`). A configurable rule engine —
 * `governance/`, and the `get_governance_rule` tool of §6 — is deferred: six
 * predicates that run are worth more than an extension point that does not.
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
  /** A proposed name says another environment than the one the entity declares. */
  | 'environment-in-name'
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
  /**
   * ref → what that right is over, for every right the snapshot holds whose
   * type states a level (`GrantedOver`).
   *
   * Read by one sentence: the remedy `declared-level-mismatch` hands back when
   * the level it refuses is the user's. "Declare a separate grant" has to say
   * for whom and over what, and an update names only the grant — the thing it
   * reaches is in the repository, not in the operation. And whether the grant
   * is here at all is whether that remedy applies: a grant of its own "that
   * states access read" is only a remedy where a grant of that type can.
   */
  readonly over: GrantedOver
  /**
   * ref → the consumers a right lists in `dependencyOf`, for every right the
   * snapshot holds.
   *
   * Read by one sentence, as `over` is: the remedy `environment-mismatch`
   * hands back when the user answered another environment than the one of the
   * grant an update extends. "The grant of that environment" is the one held
   * by the same consumers, declared there — found from what the repository
   * declares, never from a name. Optional: without it the remedy is always a
   * separate grant, which is never wrong.
   */
  readonly holders?: ReadonlyMap<string, readonly string[]>
  /**
   * Every name the repository holds — an API, a document set aside or
   * refused, a namesake in another namespace — with every environment its
   * documents declare. What `requestedEnvironment` reads the names a request
   * mentions off, and only that: the other gates are held to `environments`,
   * the write model's.
   */
  readonly namesakes: Namesakes
}


const folderOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Every environment a creation touches, for `environment-mismatch` alone: the
 * one the entity declares, and the ones its name says (`environmentsNamedBy`).
 * A name is read here because the signature lets a name keep a segment a
 * witnessed reference vouches for — `billing-api-orders-db-prod` passes on a
 * dev request, because `orders-db-prod` exists. The value is right about where
 * it came from and wrong about what it says, which is exactly the gap a policy
 * is for — and measured against what the USER stated, a name saying an
 * environment nobody stated is refused whether the entity's environment is
 * declared or still a question. Read by `environmentsNamedBy`'s whole-part
 * rule, where it once split on `-` alone: `…-pre-prod` touches `pre-prod`,
 * and no longer a false `prod` besides, when both are environments.
 *
 * It is NOT the environment the entity grants, and nothing else reads it so.
 * `cross-environment-consumer` once did, and a name then widened the scope it
 * was measured against: an `env: dev` access over `orders-db-prod` was refused
 * named `…-dev` and passed named `billing-api-orders-db-prod`. What a right
 * grants is the environment it declares (`environmentOf`), and a name saying
 * another is `environment-in-name`'s refusal, not a second scope.
 */
function environmentsTouched(entity: unknown, vocabulary: Vocabulary): string[] {
  const touched = new Set<string>()
  const env = environmentOf(entity)
  if (env !== undefined) touched.add(env)
  for (const said of environmentsNamedBy(nameOf(entity) ?? '', vocabulary.environments)) {
    touched.add(said)
  }
  return [...touched]
}

/** The name an entity carries in `metadata.name`, when it is a string. */
const nameOf = (entity: unknown): string | undefined => {
  if (typeof entity !== 'object' || entity === null) return undefined
  const metadata = (entity as { metadata?: unknown }).metadata
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const { name } = metadata as { name?: unknown }
  return typeof name === 'string' ? name : undefined
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
 * and the merge is the act of authorisation (§4.2). Where the value came from
 * does change one thing: the remedy. See `separateGrant`.
 */
function levelMismatch(
  context: PolicyContext,
  provenance: Provenance,
  opIndex: number,
  path: string,
  ref: string | undefined,
  claim: LevelClaim,
  grant: GrantShape,
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

  // Whose level it is decides the remedy, and `answered` is the signer's own
  // test for a level (`signPlan`): a level is never read out of the request,
  // so the only way it is the user's is that they answered it, here. Against
  // a right with no level — a network flow, which `over` does not hold — the
  // only remedy there is is `repairFor`'s: state none. A separate grant at
  // their level is one its type cannot state, and the schema refuses it.
  if (stated !== undefined && answered(provenance, path, stated) && context.over.has(ref)) {
    return {
      policy: 'declared-level-mismatch',
      opIndex,
      path,
      message:
        `${ref} ${statedAs(declared)}, and this plan ${statedAs(stated)}. ` +
        `The user asked for ${stated}. ${separateGrant(stated, grant)}`,
    }
  }

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
 * What the remedy needs to know about the operation a level mismatch is in:
 * whether it joins an existing grant or declares one, and the consumer and the
 * thing, as far as they are known.
 */
interface GrantShape {
  readonly shape: 'update' | 'creation'
  readonly access: {
    readonly [K in keyof AccessSubject]?: AccessSubject[K] | undefined
  }
}

/**
 * The one remedy for a level the user set: a grant of its own, at their level.
 *
 * `repairFor`'s first option is "state the level the grant declares", and for
 * a level the model chose that is the fix. For one the user answered it is
 * the opposite of one: it proposes handing over more than they asked for, and
 * the engine puts their answer back into every redraft anyway (`reapply.ts`),
 * so a model that took the advice was refused again, three times, over a plan
 * nobody could have written. Omitting the level against a grant that states
 * none is the same widening by silence. So neither is offered here.
 *
 * It names the consumer and the thing when it knows them — a model told
 * "declare a separate grant" without being told for whom and over what has to
 * guess the half it was not told — and says only what it knows when it does
 * not: an update against a grant over two things names no thing.
 */
const separateGrant = (level: string, { shape, access }: GrantShape): string => {
  const whom = [
    ...(access.consumer === undefined ? [] : [`for ${access.consumer}`]),
    ...(access.resource === undefined ? [] : [`over ${access.resource}`]),
  ]
  return (
    `A level is a scalar and this tool only ever appends (§4.3), so appending cannot change ` +
    `the level a grant declares: declare a separate grant ${[...whom, ''].join(' ')}that states ` +
    `access ${level}, ` +
    (shape === 'update'
      ? 'instead of adding it to this one.'
      : 'under a name of its own, instead of restating this one.')
  )
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
 *
 * For a level the MODEL chose, or left out. One the user answered gets
 * `separateGrant` instead, and this sentence is kept byte for byte for the
 * rest: it is what the recorded runs were sent.
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
 * the whole plan. An answer is the user's word about ONE field: `metadata.env`
 * on a proposed entity, or — for an update, which names its grant by reference
 * and states none of its own — the environment it was asked at
 * (`environmentPath`). So an answer counts for the operation it was typed at,
 * and only while that operation still holds the value typed: `dev` answered
 * for a database in operation 0 says nothing about the grant operation 1
 * joins, and an answer at a path this plan does not hold says nothing about
 * this plan at all. Read plan-wide, either one cleared an
 * `environment-mismatch` the user never spoke to.
 *
 * `named` for the request, `answered` at the operation's own field — the same
 * two sources `stated` composes when the signature vouches for an environment,
 * which is what makes a plan refused with `dev` typed into the request refused
 * with `dev` typed at a prompt too. Kept apart here because the message says
 * which of the two it was. Measured against the vocabulary either way, so
 * the two sources cannot disagree about what counts: a word the repository has
 * never used as an environment names none, typed anywhere.
 *
 * For an update, the request's are what `requestedEnvironment` reads — the
 * definition that stops the question, so the gates hold the update to what
 * stopped it. Its words, unless the request also mentions a name declared in
 * another environment, in which case it stated none and is asked; and, where
 * the user stated neither, the environment the request pointed at by naming
 * what its grant is over in full. Silence alone: a request naming an
 * environment, or an answer, is what was asked, and a thing named beside it
 * never widens that to a second scope.
 */
interface StatedEnvironments {
  /** Every environment stated for this operation, by either source. */
  readonly all: readonly string[]
  /** The ones the request named. */
  readonly named: readonly string[]
  /** The one answered at this operation's own environment, and where. */
  readonly answered: { readonly env: string; readonly path: string } | undefined
  /** The one the request pointed at through what an update's grant is over. */
  readonly pointed: PointedAt | undefined
}

function environmentsStated(
  context: PolicyContext,
  provenance: Provenance,
  opIndex: number,
  operation: Operation,
): StatedEnvironments {
  const { vocabulary } = context
  const update = operation.op === 'update-entity'
  const requested = update
    ? requestedEnvironment(
        operation.entityRef,
        vocabulary.environments,
        context.environments,
        context.over,
        context.namesakes,
        provenance,
      )
    : undefined
  const fromRequest =
    requested?.named ?? vocabulary.environments.filter((env) => named(provenance, env))
  // An update's answer is to "which environment is this access for?", about
  // a grant the repository declares, so it counts whatever it names: `qa`
  // answered against a prod grant is a mismatch, not silence. A proposed
  // entity's is measured against the vocabulary like the request's words.
  const path = update
    ? environmentPath(opIndex)
    : `operations.${opIndex}.entity.metadata.env`
  const own = update ? provenance.answers.get(path) : environmentOf(operation.entity)
  const fromAnswer =
    own !== undefined &&
    (update || vocabulary.environments.includes(own)) &&
    !fromRequest.includes(own) &&
    answered(provenance, path, own)
      ? { env: own, path }
      : undefined
  const pointed = fromAnswer === undefined ? requested?.pointed : undefined
  return {
    all: [
      ...fromRequest,
      ...(fromAnswer === undefined ? [] : [fromAnswer.env]),
      ...(pointed === undefined ? [] : [pointed.env]),
    ],
    named: fromRequest,
    answered: fromAnswer,
    pointed,
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
const statedAsWords = ({
  named: fromRequest,
  answered: fromAnswer,
  pointed,
}: StatedEnvironments): string =>
  [
    ...(fromRequest.length > 0 ? [`the request named ${fromRequest.join(' and ')}`] : []),
    ...(fromAnswer === undefined ? [] : [`${fromAnswer.env} was answered at ${fromAnswer.path}`]),
    ...(pointed === undefined
      ? []
      : [
          `the request named ${pointed.things.join(' and ')}, ` +
            `${pointed.things.length === 1 ? 'which is' : 'each'} declared ${pointed.env}`,
        ]),
  ].join(', and ')

/**
 * The remedy for an update whose grant is in another environment than the one
 * the user answered: the grant of that environment, when the repository holds
 * one, else a separate grant.
 *
 * "The grant of that environment" is read off what the repository declares,
 * never off a name: a right declared there, held by exactly the consumers
 * that hold this one, and levelled when this one is (`over`). Names are the
 * model's to choose, and `orders-api-orders-db-dev` being the dev twin of
 * `…-prod` is a reading of two names — the guess this gate exists to refuse.
 * Several such grants are all named, for the draft to choose the one over
 * what was asked; the Reviewer and the environment question judge its choice.
 */
function grantIn(
  env: string,
  entityRef: string,
  consumer: string,
  context: PolicyContext,
): string {
  const mine = context.holders?.get(entityRef) ?? []
  const same = (theirs: readonly string[]): boolean =>
    theirs.length === mine.length && mine.every((one) => theirs.includes(one))
  const grants = [...(context.holders ?? new Map<string, readonly string[]>()).entries()]
    .filter(
      ([ref, theirs]) =>
        ref !== entityRef &&
        mine.length > 0 &&
        context.environments.get(ref) === env &&
        context.natures.get(ref) === 'right' &&
        context.over.has(ref) === context.over.has(entityRef) &&
        same(theirs),
    )
    .map(([ref]) => ref)
    .sort()
  const separate = `declare a separate grant in ${env} for ${consumer}`
  const [only] = grants
  if (only === undefined) return `${separate} instead of joining this one.`
  // Found by who holds it, so it may be over another thing than the one
  // asked about: what it is over is said, and a separate grant offered beside
  // it, for the draft to choose — never one presented as the fix.
  const reach = context.over.get(only) ?? []
  return grants.length === 1
    ? `join ${consumer} to ${only} — declared ${env}, held by the same consumers as this ` +
        `one${reach.length === 0 ? '' : `, and over ${reach.join(' and ')}`} — if that is ` +
        `what was asked, or ${separate}, instead of joining this one.`
    : `join ${consumer} to whichever of ${grants.join(', ')} — each declared ${env} and held ` +
        `by the same consumers as this one — is over what was asked, or ${separate}, instead ` +
        'of joining this one.'
}

/**
 * ref → environment, as the repository declares it and as this plan declares
 * the entities it creates. A right over a database the same plan declares in
 * prod reaches prod as surely as one over a database the repository holds,
 * and read from the repository alone, `cross-environment-consumer` compared
 * it with nothing: a dev right over it passed. Declared either way, never
 * inferred — an environment still a question declares nothing yet. The plan's
 * own declaration wins where both hold one, since it is the one the diff
 * writes.
 */
function declaredWithin(
  plan: SignedPlan['plan'],
  repository: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const environments = new Map(repository)
  for (const operation of plan.operations) {
    if (operation.op !== 'create-entity') continue
    const { kind, metadata } = operation.entity
    const env = environmentOf(operation.entity)
    if (typeof metadata.name !== 'string' || env === undefined) continue
    environments.set(`${kind.toLowerCase()}:default/${metadata.name}`, env)
  }
  return environments
}

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
  const environments = declaredWithin(signed.plan, context.environments)

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
    // The environments the user stated for this operation — for an update,
    // the one its request pointed at through what the grant is over, too.
    // When they stated none, every environment policy stays silent: the signer
    // or the question already asks, and firing here would report it twice.
    const asked = environmentsStated(context, provenance, opIndex, operation)

    if (operation.op === 'update-entity') {
      // `operation.patch.consumer` is read straight off the union: §5.3 keeps
      // `Patch` closed and it holds one member today, so a second member
      // without a consumer breaks the build right here — which is the right
      // way to be told that this gate has a new case to answer for.
      const { entityRef, patch } = operation
      const grantEnv = environments.get(entityRef)
      const consumerEnv = environments.get(patch.consumer)
      const answeredEnv = provenance.answers.get(environmentPath(opIndex))
      // What the grant hands out: the environment it declares, or — declaring
      // none — that of what it is over, as the repository declares it. The
      // scope its question showed (`scopeOf`), so the answer is held to it.
      const scope = scopeOf(entityRef, environments, context.over)

      if (asked.all.length > 0) {
        // Both ends, because an update touches both: the grant being extended
        // and the consumer being joined to it. A reference the repository
        // declares no environment for contributes none — declare, never infer,
        // and reading one off a name is what `environmentsTouched` is for on
        // the side where a name is the model's to choose.
        const outside = scope.environments.filter((env) => !asked.all.includes(env))
        const path = `operations.${opIndex}.entityRef`
        if (outside.length > 0) {
          // The user answered this access's environment, and the grant the
          // draft extends is in another (core-plan-3). The engine never
          // retargets it: the draft has to, and it is told which grant.
          violations.push(
            answeredEnv !== undefined
              ? {
                  policy: 'environment-mismatch',
                  opIndex,
                  path,
                  message:
                    `${entityRef} ${scope.words}, and ${answeredEnv} was answered at ` +
                    `${environmentPath(opIndex)} for ${patch.consumer}'s access. An ` +
                    `environment is never inferred, and a grant is never retargeted for ` +
                    `you: ${grantIn(answeredEnv, entityRef, patch.consumer, context)}`,
                }
              : mismatch(opIndex, path, outside.join(' and '), asked),
          )
        }
        if (consumerEnv !== undefined && !asked.all.includes(consumerEnv)) {
          violations.push(
            mismatch(opIndex, `operations.${opIndex}.patch.consumer`, consumerEnv, asked),
          )
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
        provenance,
        opIndex,
        `operations.${opIndex}.patch.access`,
        entityRef,
        levelClaim(patch.access),
        {
          shape: 'update',
          access: {
            consumer: patch.consumer,
            resource: soleReference(context.over.get(entityRef)),
          },
        },
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
    // and the grant is scoped to an environment — the one it DECLARES, and
    // nothing its name says (see `environmentsTouched`). Both ends are read,
    // what it reaches and who holds it, each by the environment the repository
    // or this plan declares for it (`declaredWithin`). A reference neither has
    // ever seen is dangling-reference's business, and CI runs that rule — guessing
    // here would report a worse second version of it. An environment still a
    // question scopes nothing yet: it is asked before anything is compared.
    const declared = environmentOf(entity)
    for (const reference of referencesOf(entity)) {
      const theirs = environments.get(reference)
      if (theirs === undefined || declared === undefined || declared === theirs) continue
      violations.push({
        policy: 'cross-environment-consumer',
        opIndex,
        path: `operations.${opIndex}.entity.spec`,
        message:
          `${reference} lives in ${theirs}, but this declaration is scoped to ` +
          `${declared}. Being authorised in one environment ` +
          `grants nothing in another.`,
      })
    }

    // A name is the model's to choose (§5.2) and says what it likes, so what
    // it says is held to the one thing that decides: the environment the
    // entity declares. `billing-api-orders-db-prod` declared dev is a reviewer
    // reading "prod" in the diff over a grant that is not, and a later reader
    // of the catalogue trusting the name. Whole parts of the name only
    // (`environmentsNamedBy`): `product-api` says no `prod`.
    const name = nameOf(entity)
    const says =
      name === undefined || declared === undefined
        ? []
        : environmentsNamedBy(name, context.vocabulary.environments).filter(
            (env) => env !== declared,
          )
    if (name !== undefined && declared !== undefined && says.length > 0) {
      violations.push({
        policy: 'environment-in-name',
        opIndex,
        path: `operations.${opIndex}.entity.metadata.name`,
        message:
          `${name} is declared ${declared}, and its name says ${says.join(' and ')}: ` +
          `a name must not say another environment.`,
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
      provenance,
      opIndex,
      `operations.${opIndex}.entity.spec.access`,
      signed.refs.get(opIndex),
      proposedClaim(entity),
      { shape: 'creation', access: levelledSiteOf(operation, context.over) ?? {} },
    )
    if (level !== undefined) violations.push(level)
  }

  // Every violation, never the first: a caller fixing them one round-trip at
  // a time is the repair loop's worst case, and each round-trip is paid for.
  return violations
}
