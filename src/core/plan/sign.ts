import { echoes } from './echoes.js'
import type { Plan } from '../schemas/plan.js'
import { PLAN_LIMITS } from '../schemas/plan.js'
import { computeEntityPath } from '../paths/entity-path.js'
import type { ResourceType } from '../schemas/resource-types.js'
import type { Vocabulary } from '../schemas/vocabulary.js'

/**
 * The write-side guarantee ADR-0007 said propose() owed.
 *
 * The read-side one worked because an Answer carries nothing but identifiers,
 * so one membership test covered all of it. A Plan carries values that were
 * never in the catalogue — that is what proposing means — so membership has
 * nothing to test against. Instead every leaf is classified by WHERE IT CAME
 * FROM, and a value nobody can vouch for becomes a question.
 *
 * What this does not cover, stated as plainly as ADR-0007 stated its own:
 * the signature says where a value came from. It says NOTHING about whether
 * the value is right. An owner that exists and is the wrong team is
 * `enumerated` and signs cleanly. That is what the diff is for, and why the
 * merge — not the signature — is the act of authorisation.
 */

declare const signature: unique symbol

export type LeafClass = 'echoed' | 'enumerated' | 'derived' | 'novel'

export interface LeafFinding {
  readonly opIndex: number
  /** The dotted form findUnknowns returns, so a report reads like a question. */
  readonly path: string
  readonly class: LeafClass
}

export interface LeafRefusal {
  readonly opIndex: number
  readonly path: string
  readonly reason: string
}

export interface PlanRefusal {
  readonly outcome: 'refused'
  readonly gate: 'signature'
  readonly refusals: readonly LeafRefusal[]
}

export interface SignatureContext {
  /**
   * Values the user typed at a prompt, as themselves.
   *
   * A different fact from "the word appears in the request", and the reason
   * the two are held apart. The ask loop used to GROW the intent with each
   * answer so `echoes` would find it again, which worked for an identifier and
   * failed for a common word — once `read` was in the intent it vouched for
   * every `read` in the plan — and left the request in a `--json` report
   * carrying sentences the user never wrote.
   *
   * What it does NOT carry is which question each answer belonged to. An
   * answer here vouches for the VALUE, so answering one field with `read`
   * would vouch for another field also holding `read` — a narrower map is the
   * better shape the day a plan asks about two levels at once.
   */
  readonly answered: ReadonlySet<string>
  /**
   * Whose words `plan.intent` is, which decides whether `echoes` may vouch.
   *
   * `echoed` is the strongest claim a leaf can carry — not "this value exists
   * somewhere" but "the person asked for it" — and it rests entirely on the
   * intent being a person's own sentence. `init` composes one: "declare this
   * repository in the catalogue, from what its own files state". Measured
   * against that, a Component named `repository-files` signs echoed, because
   * both segments are words the engine wrote about itself. The engine vouched
   * for the model using the engine's own prose.
   *
   * So an engine-composed intent vouches for nothing by word test. What it
   * legitimately establishes — the values an inspection actually read out of
   * the project's files — travels in `answered`, which is the field for a value
   * somebody other than the model stands behind.
   */
  readonly wordsOf: 'user' | 'engine'
  /** References the ENGINE returned — the propose tool's witness set. */
  readonly witnessed: ReadonlySet<string>
  readonly vocabulary: Vocabulary
  readonly repoRoot: string
  /** ref → the file already declaring it. The re-check decides what that means. */
  readonly declared: ReadonlyMap<string, string>
}

/**
 * Only `signPlan` can mint one: the brand is not exported, so everything
 * downstream takes a SignedPlan and a bare Plan will not typecheck. "The
 * engine signs" becomes a compile error rather than a slogan.
 */
export interface SignedPlan {
  readonly plan: Plan
  /** Engine-computed, repository-relative. Never read from the proposal. */
  readonly paths: ReadonlyMap<number, string>
  readonly refs: ReadonlyMap<number, string>
  readonly classified: readonly LeafFinding[]
  readonly [signature]: true
}

const isUnknown = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'unknown' in value


/**
 * A name is the one thing design 5.2 hands the model outright, and a composed
 * name is never echoed whole: nobody writes "billing-api-orders-db-prod" in a
 * request. So a name is vouched for when **every segment of it** is — each
 * hyphen-separated piece either appears in the request or is a value the
 * catalogue already uses. `billing-api-orders-db-prod` from "give billing-api
 * access to orders-db in prod" passes; `billing-api-secret-backdoor` does not.
 *
 * THE LIMIT, stated rather than papered over. A word test cannot tell a word
 * that names something from a word that is merely present: on "please declare
 * a database in prod, thanks", a Component named `please-thanks` has both its
 * segments in the request and signs echoed. It is filed at
 * `catalog/databases/please-thanks.yml` and a person reads that path in the
 * diff before merging, which is where this is caught.
 *
 * It is left open deliberately. Every fix is a list of words that do not
 * count, and this tool takes a request in any language its model supports —
 * a stop list would work in the language somebody wrote it in and silently
 * weaken the check in every other. A filler-word name is a cosmetic defect
 * that the diff shows; a name check that works in English and not in Turkish
 * is a guarantee that is false without saying so.
 */
function composed(
  vouches: (text: string) => boolean,
  vocabulary: Vocabulary,
  witnessed: ReadonlySet<string>,
  name: string,
): boolean {
  const segments = name.split('-').filter((segment) => segment.length > 0)
  if (segments.length === 0) return false

  // Deliberately no `vocabulary.environments` — the same hole `enumerated`
  // had, one layer along. An environment is never provenance: `prod` always
  // exists, and one declared in `.idp-agent.yml` exists more trivially still.
  // Letting it vouch for a segment flipped `metadata.name` from a question to
  // `echoed` — the strongest claim a value can carry — for a name the request
  // never mentioned, on a request that named dev.
  //
  // A witnessed reference is different, and stays: the catalogue actually
  // returned that entity, so `orders-db-prod` carrying `prod` is a fact about
  // something that exists rather than a list of what could.
  const known = [
    ...vocabulary.types,
    ...[...witnessed].flatMap((ref) => (ref.split('/').pop() ?? '').split('-')),
  ]

  return segments.every((segment) => vouches(segment) || known.includes(segment))
}

function enumerated(vocabulary: Vocabulary, path: string, value: string): boolean {
  if (path.endsWith('.owner')) return vocabulary.owners.includes(value)
  // A COMPONENT's type, and only a Component's. A Resource's is the closed
  // union and never reaches here — the structural branch takes it, and
  // measuring it against a list of what the repository has happened to use is
  // the circular block that branch exists to avoid. A Component's is
  // `z.string().min(1).max(63)`, so the same list is the only thing that can
  // say a service type was already in use rather than composed: `summariseGraph`
  // maps `spec.type` over EVERY entity, Components included.
  if (path.endsWith('.type')) return vocabulary.types.includes(value)
  // Deliberately no `.env`. An environment is the one field where "the
  // catalogue already uses this value" is not provenance: `prod` always
  // exists, so enumerating it would let a model pick production for a request
  // that named no environment at all, and the plan would sign cleanly. §4.1
  // says being authorised in dev grants nothing elsewhere; an environment is
  // therefore echoed — the user named it — or novel, and novel means asked.
  if (path.endsWith('.kind')) return vocabulary.kinds.includes(value)
  return false
}

interface Frame {
  readonly value: unknown
  readonly path: string
  readonly opIndex: number
  /**
   * The `kind` the nearest enclosing entity states, or undefined above one.
   *
   * It decides one thing: whether `spec.type` is the closed union or free
   * text. Carried on the frame rather than read off the path, because a path
   * says where a leaf sits and not what declares it — `operations.0.entity`
   * is a Resource in one plan and a Component in the next.
   */
  readonly kind: string | undefined
}

/**
 * Iterative, bounded by PLAN_LIMITS, in the shape of findUnknowns — a
 * recursive walk would make a deeply nested proposal a denial of service, and
 * the guarantee has to be total over leaves or a field escapes by being nested.
 */
/**
 * Every reference this plan would bring into existence.
 *
 * A grant over a database the catalogue does not hold yet is TWO operations —
 * declare the database, then the right over it — and the second names the
 * first. That reference is in no witness set, because the witness set is what
 * the read tools returned and the catalogue does not hold it; it is not echoed,
 * because a request says "orders-db" and not `resource:default/orders-db-prod`.
 * So it signed `novel`, and §7.5's missing-resource branch could not finish
 * without a person answering a question the plan carries the answer to two
 * lines above.
 *
 * It is grounded, and in the one place that matters: the plan the reviewer
 * reads before merging. `planEdits` has known this for as long as it has had a
 * test called "lets a second creation see what the first one wrote".
 *
 * WHAT STOPS IT BEING A HOLE is that a name is classified on its own. If the
 * model invented `orders-db-prod`, `operations.0.entity.metadata.name` is
 * novel and already a question; if the name is vouched for, a reference to it
 * is vouched for by the same evidence. The reference inherits the name's
 * standing rather than manufacturing its own — which is why this reads the
 * name and never the `{unknown}` that may stand in its place.
 *
 * Order is deliberately not required. Operation 0 may name what operation 1
 * declares: both are in one diff, and a reviewer reads the diff whole.
 */
const created = (plan: Plan): ReadonlySet<string> => {
  const refs = new Set<string>()
  for (const operation of plan.operations) {
    if (operation.op !== 'create-entity') continue
    const { kind, metadata } = operation.entity
    const name = metadata.name
    if (typeof name !== 'string') continue
    refs.add(`${kind.toLowerCase()}:default/${name}`)
  }
  return refs
}

export function signPlan(plan: Plan, context: SignatureContext): SignedPlan | PlanRefusal {
  const creates = created(plan)
  // The word test, or nothing at all. See `SignatureContext.wordsOf`.
  const vouches = (text: string): boolean =>
    context.wordsOf === 'user' && echoes(plan.intent, text)
  const classified: LeafFinding[] = []
  const refusals: LeafRefusal[] = []
  const asked = new Map<string, string>()

  const stack: Frame[] = plan.operations.map((operation, index) => ({
    value: operation,
    path: `operations.${index}`,
    opIndex: index,
    kind: undefined,
  }))
  let nodes = 0

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    nodes += 1
    if (nodes > PLAN_LIMITS.maxNodes) {
      return {
        outcome: 'refused',
        gate: 'signature',
        refusals: [{ opIndex: 0, path: '', reason: 'plan holds more values than can be signed' }],
      }
    }

    const { value, path, opIndex, kind } = frame

    if (isUnknown(value)) {
      // Already a question. Nothing to vouch for, nothing to refuse.
      classified.push({ opIndex, path, class: 'derived' })
      continue
    }

    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        stack.push({ value: item, path: `${path}.${index}`, opIndex, kind })
      }
      continue
    }

    if (typeof value === 'object' && value !== null) {
      // An entity states its own kind, and every leaf below inherits that
      // statement. Read off the object rather than off the path so a proposal
      // nested one level deeper — `create-catalog-info` carries its entity the
      // same way — needs no second rule.
      const stated = (value as { kind?: unknown }).kind
      const inherited = typeof stated === 'string' ? stated : kind
      for (const [key, nested] of Object.entries(value)) {
        stack.push({ value: nested, path: `${path}.${key}`, opIndex, kind: inherited })
      }
      continue
    }

    // A leaf.
    const text = String(value)
    let leafClass: LeafClass = 'novel'

    if (
      path.endsWith('.op') ||
      path.endsWith('.patch') ||
      path.endsWith('.kind') ||
      (path.endsWith('.type') && kind === 'Resource')
    ) {
      // Structural: the closed union already decided these.
      //
      // A RESOURCE's `.type` joined them because measuring it against the
      // vocabulary — what the repository ALREADY uses — made the FIRST access
      // of a repository unproposable: no access exists, so `database-access` is
      // in no vocabulary, so it is a question, so no access is ever written. It
      // is `z.enum(RESOURCE_TYPE_NAMES)`, and a type outside that union is
      // refused by the schema before the signature sees it, so asking where it
      // came from has one answer: the union.
      //
      // **A COMPONENT's is not, and the condition is `kind` for that reason.**
      // `proposedComponentSchema.spec.type` is `or(z.string().min(1).max(63))`
      // — Backstage's own `spec.type` on a Component is conventional, not
      // closed, and `componentSchema` reads `z.string().min(1)` off a
      // repository that already exists, which `validate` may not invalidate.
      // So the branch was vouching for 63 characters a model composed: the one
      // free-text field in a proposal, reaching `catalog-info.yaml` through
      // `init --repo` and the Reviewer's opening message verbatim. It now falls
      // through to echoed / enumerated / novel like any other leaf, and novel
      // means asked. Nothing is lost on the way in: a Resource's type still
      // never meets the vocabulary, and a Component's type is a value and never
      // a path — `computeEntityPath` is only ever asked about a Resource below.
      //
      // What this does NOT cover: whether the type is the RIGHT one. A model
      // proposing `database` where an access belongs signs cleanly, and the
      // diff is where a human sees it — the same limit the module states at the
      // top and the reason the merge is the act of authorisation.
      leafClass = 'derived'
    } else if (path.endsWith('.access')) {
      // A level is asked, never read out of the request.
      //
      // `echoes` is a word test and a level is a common word, so it could not
      // tell asked-for from forbidden from merely mentioned. Measured on the
      // request it was meant to serve: "do not grant readwrite, only read"
      // classified `readwrite` as echoed — a request that FORBIDS write made
      // write look asked for — and "read replica", a database term in a
      // database-access tool, named a level nobody asked for.
      //
      // So the only provenance a level has is the user answering for it. That
      // is one question per grant whose level the request did not settle at a
      // prompt, and an access level is worth a question: granting write where
      // read was asked for is the accident this whole design exists around.
      leafClass = context.answered.has(text) ? 'echoed' : 'novel'
    } else if (creates.has(text)) {
      // A reference to an entity this same plan declares. Derived, not echoed:
      // it follows from another operation by a rule the engine applied, and
      // nobody wrote it in a request. See `created`.
      leafClass = 'derived'
    } else if (vouches(text) || context.answered.has(text)) {
      // Checked before the vocabulary on purpose. A value can be both, and
      // "the user asked for this" is the stronger claim: it is their request,
      // not merely something that happens to exist somewhere.
      leafClass = 'echoed'
    } else if (context.witnessed.has(text) || enumerated(context.vocabulary, path, text)) {
      leafClass = 'enumerated'
    } else if (
      path.endsWith('.name') &&
      composed(vouches, context.vocabulary, context.witnessed, text)
    ) {
      leafClass = 'echoed'
    }

    classified.push({ opIndex, path, class: leafClass })
    if (leafClass === 'novel') asked.set(path, text)
  }

  // A value nobody can vouch for becomes a question rather than a refusal:
  // "declare, never infer" means asking, not guessing and not giving up.
  //
  // Cloned even when nothing was asked, so the object this function freezes is
  // never the one the caller handed it. `deriveOwners` states the same rule
  // where it clones: the caller still holds the plan it passed — `repair` keeps
  // one as the partial plan a clean stop shows — and freezing it underneath
  // them would change the behaviour of an object nobody signed.
  const withQuestions = asked.size === 0 ? structuredClone(plan) : askAbout(plan, asked)

  const paths = new Map<number, string>()
  const refs = new Map<number, string>()

  for (const [index, operation] of withQuestions.operations.entries()) {
    if (operation.op !== 'create-entity') continue
    const entity = operation.entity
    const name = entity.metadata.name
    if (entity.kind !== 'Resource') continue
    const type = entity.spec.type
    // A path cannot be computed from a question. The plan is not applicable
    // anyway — the CLI asks first.
    if (isUnknown(type) || isUnknown(name) || typeof name !== 'string') continue
    try {
      paths.set(index, computeEntityPath(type as ResourceType, name))
      refs.set(index, `resource:default/${name}`)
    } catch (error) {
      refusals.push({
        opIndex: index,
        path: `operations.${index}.entity.metadata.name`,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (refusals.length > 0) return { outcome: 'refused', gate: 'signature', refusals }

  // The brand exists only in the type: `declare const` has no runtime value,
  // and constructing the property would let anyone forge one. The cast here is
  // the whole point — this module is the only place it is allowed.
  //
  // Frozen, and that is the second half of what the brand promises. See
  // `bound` below for what it does and does not buy.
  return bound({
    plan: deepFreeze(withQuestions),
    paths: sealed(paths),
    refs: sealed(refs),
    classified: Object.freeze(classified),
  })
}

/** What a mutation of a signed plan is told, wherever this module can say it. */
const SEALED = 'a signed plan is what was signed; sign the plan you changed'

/**
 * The signature, bound to CONTENT and not only to identity.
 *
 * The brand proved `signPlan` returned this object once. It did not prove the
 * object still held what was signed: `Plan` is `z.infer<…>` and mutable,
 * `SignedPlan` marks only its own four fields readonly, and nothing froze
 * anything — so `spec.owner = 'group:default/nobody'` compiled, ran, reached
 * `planEdits` and was written, while `classified` went on reporting the owner
 * the gate had vouched for. Stage 5 hands a `SignedPlan` to a writer, and
 * "signed" has to mean the bytes it composes are the ones the gates judged.
 *
 * Freezing rather than carrying a digest, and the reason is reach: a digest
 * protects whichever caller remembers to compare it, and the readers of a
 * signed plan are `checkPolicies`, `recheckPlan`, `planEdits`, the Reviewer's
 * opening message, both renderers and whatever stage 5 adds. A frozen object
 * protects all of them at once, including the ones not written yet, and turns
 * a mutation into a throw at the line that wrote it rather than a refusal one
 * gate later.
 *
 * What this does NOT cover, stated as plainly as the module states its own:
 *
 *   - **A copy is not covered, deliberately.** `structuredClone`, a spread and
 *     a JSON round trip all yield a mutable Plan, and they have to:
 *     `clarify.answer` and §7.5's ask loop produce a NEW plan from an answered
 *     one, and that plan goes back through all five gates and is signed again.
 *     What stops a copy reaching a writer is the brand — a bare Plan does not
 *     typecheck — not the freeze.
 *   - It is a runtime guarantee, not a compile-time one. `Plan` stays mutable
 *     in the types, so a mutation is a `TypeError` where it runs and not a red
 *     squiggle where it is written.
 *   - It says nothing about whether the frozen values are RIGHT. That is the
 *     limit this module opens with, and the reason the merge is the act of
 *     authorisation.
 *   - It stops at the bytes. `planEdits` returns plain `FileEdit`s, and what a
 *     writer does with the strings afterwards is that writer's guarantee.
 */
const bound = (signed: {
  plan: Plan
  paths: ReadonlyMap<number, string>
  refs: ReadonlyMap<number, string>
  classified: readonly LeafFinding[]
}): SignedPlan => Object.freeze(signed) as unknown as SignedPlan

/**
 * Iterative, in the shape of the walk above and bounded by it: a plan holding
 * more than `PLAN_LIMITS.maxNodes` values was refused before this runs, and a
 * recursive freeze would make a deeply nested proposal a denial of service in
 * the one function whose whole job is to close that door.
 */
function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value]

  while (stack.length > 0) {
    const current = stack.pop()
    if (typeof current !== 'object' || current === null) continue
    if (Object.isFrozen(current)) continue
    Object.freeze(current)
    for (const nested of Object.values(current)) stack.push(nested)
  }

  return value
}

/**
 * A Map that refuses to change.
 *
 * `Object.freeze` does nothing to one: `set` lives on the prototype and writes
 * internal slots, so a frozen Map is still a writable Map. `paths` is the
 * field §5.2 is about — the engine chooses where bytes go, and a model cannot
 * aim at a path — so leaving it writable would leave the strongest guarantee
 * in the design as the one field a mutation could still move. The mutators are
 * shadowed on the instance (non-writable and non-configurable by
 * `defineProperty`'s defaults, so the shadow cannot be removed), and the
 * instance is then frozen.
 *
 * What this does NOT cover: `ReadonlyMap` already said no at compile time, and
 * this only answers the cast that ignores it.
 */
const sealed = <K, V>(entries: ReadonlyMap<K, V>): ReadonlyMap<K, V> => {
  const map = new Map(entries)
  const refuse = (): never => {
    throw new TypeError(SEALED)
  }
  for (const mutator of ['set', 'delete', 'clear']) {
    Object.defineProperty(map, mutator, { value: refuse })
  }
  return Object.freeze(map)
}

/** Replaces each novel leaf with the question the CLI will put to the user. */
function askAbout(plan: Plan, asked: ReadonlyMap<string, string>): Plan {
  const clone = structuredClone(plan) as Record<string, unknown>
  for (const [path] of asked) {
    const parts = path.split('.')
    const field = parts.pop()
    if (field === undefined) continue
    let cursor: Record<string, unknown> = clone
    for (const part of parts) {
      const next = cursor[part]
      if (typeof next !== 'object' || next === null) break
      cursor = next as Record<string, unknown>
    }
    // An array element's field is its index, and "nothing vouches for this 0"
    // names nothing a person can act on. The list it belongs to is the noun.
    const noun = /^\d+$/.test(field) ? `${parts[parts.length - 1] ?? 'value'} entry` : field
    cursor[field] = { unknown: `nothing vouches for this ${noun}; which one is it?` }
  }
  return clone as unknown as Plan
}
