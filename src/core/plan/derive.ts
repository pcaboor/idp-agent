import type { Plan } from '../schemas/plan.js'
import { RESOURCE_TYPES, natureOf, type ResourceType } from '../schemas/resource-types.js'
import { stated, type Provenance } from './provenance.js'

/**
 * A right's owner is not a choice. It is a consequence.
 *
 * Design §5.2 gives the model the name, the owner, the environment and the
 * dependencies "entirely", and the signature says an owner nobody vouches for
 * is a question. Both were true at once and the run stopped between them: four
 * recorded scenarios in five ended on `operations.0.entity.spec.owner`, with
 * the model saying — correctly — that nothing in the request states who owns
 * the access, and that the owner of the resource being reached is not evidence
 * that this team should own the reaching.
 *
 * The resolution is not to relax the gate and not to press the model. An
 * access `billing-api → orders-db` belongs to whoever owns `billing-api`, and
 * the catalogue already says who that is. So the field is TAKEN AWAY from the
 * model rather than asked of it, the way the path already is (§5.2: the engine
 * computes the path, the model cannot aim at it).
 *
 * This holds for a RIGHT and for nothing else. `natureOf` is the line: a right
 * carries its consumers (§4.1), and a consumer is exactly the evidence this
 * needs. An OBJECT carries none, and the question stays legitimate there —
 * nobody knows who owns a database that does not exist yet.
 *
 * `owners` is ref → the owner that entity DECLARES, built by the caller from
 * the catalogue. `core/` reads no disk, so the map arrives rather than being
 * fetched; see `contextsOf` in `cli/commands/plan.ts`, which builds it from the
 * same graph it builds the vocabulary from.
 *
 * **Why the derived value then passes the signature**, rather than swapping one
 * question for another. It is not an assertion; it is a path through `sign.ts`:
 *
 *   1. the value written here is `owners.get(consumer)`, which is the
 *      `spec.owner` of an entity the catalogue graph holds;
 *   2. `summariseGraph` builds `vocabulary.owners` as the sorted `spec.owner`
 *      of every entity in THAT SAME graph, and `seededVocabulary` only ever
 *      adds environments, so it never removes one;
 *   3. `signPlan` reaches the leaf `operations.N.entity.spec.owner`. It is not
 *      `.op`, `.patch`, `.kind` or `.type`, so it is not structural; `stated`
 *      may or may not match; `witnessed` holds entity refs, never owner refs;
 *   4. so it falls to `enumerated(vocabulary, path, text)`, which for a path
 *      ending in `.owner` answers `vocabulary.owners.includes(value)` — true by
 *      (1) and (2).
 *
 * The leaf therefore classifies `enumerated`, never `novel`, so `askAbout`
 * never sees it and no `{unknown}` is put back. Step (2) is the whole of the
 * condition, and it is a fact about the CALLER, not about this file — which is
 * why it is also written down as an absence below.
 *
 * **Every pass re-derives, and a conclusion that cannot be re-derived is
 * withdrawn.** The value written here used to be indistinguishable from one a
 * person stated — absent and `{unknown}` were the only unstated things, so the
 * rule protecting the REQUEST's owner protected the engine's own. §7.5 runs the
 * gates again over an answered plan, and a run that read `group:default/lion`
 * off a consumer the user then replaced with a different component ended on a
 * diff carrying lion's authorisation and somebody else's consumer: the evidence
 * rejected, the conclusion standing, and the Reviewer — which runs once, in the
 * last round — told nothing, because the derivation happened in a round it
 * never saw.
 *
 * So the question asked about a value already in the field is not "is something
 * there" but "did the USER put it there" — in the request, or answering for
 * this owner at a prompt — and `stated` answers it, the same predicate the
 * signature classifies an owner `echoed` with. Both come from `provenance.ts`,
 * the one module every gate reads what the user said from, so the three cannot
 * drift about it. The words are the provenance's, never `plan.intent`'s, and
 * an answer counts at the path it was typed for: a record kept alongside the
 * plan — "these paths were derived last round" — would not survive the
 * Architect handing back a different plan under the same indices, but what the
 * user typed at a field is the user's whatever the engine concluded there
 * before.
 *
 * Reading the request alone made the loop unable to end. An owner nothing
 * determines — a consumer the catalogue does not declare, or two teams — was
 * asked, answered, withdrawn on the next pass because the request did not
 * carry it, and asked again until the rounds ran out.
 *
 * Three outcomes for a right's owner, every pass, whoever wrote what is there:
 *
 *   the user states it         left alone — rule 1: the request, or an answer;
 *                              reported when the consumers determine another
 *   one consumer answers it    written, and reported, even when it does not move
 *   nothing answers it         a value in the field is WITHDRAWN to a question
 *
 * What this does NOT cover, stated as plainly as `sign.ts` states its own:
 *
 *   - It says who the owner FOLLOWS FROM. It says nothing about whether that
 *     team should have the access at all. A derived owner is still a line in a
 *     diff, and the merge is the act of authorisation (§4.2).
 *   - It never reads `spec.dependsOn`. That names the resource being reached,
 *     and the owner of `orders-db` is not the owner of the access to it —
 *     which is the very objection the model raised. Only `dependencyOf`, the
 *     consumer side, is evidence, and only a `component:` reference in it:
 *     excluding one field is not the same as checking the other, since the
 *     reached resource can be named on the consumer side too.
 *   - It does not check that a consumer exists. A ref the map does not hold
 *     derives nothing; whether that ref is dangling is the re-check's question,
 *     and §4.4 says a dangling reference is surfaced, never pruned.
 *   - It never touches `update-entity`. The one patch in the union is
 *     `add-dependency-of`, which adds a consumer to an access whose file
 *     already states an owner a human wrote; re-opening that from here would
 *     let a new consumer rewrite an existing authorisation.
 *   - It never touches a Component, in `create-entity` or in
 *     `create-catalog-info`. A service is not a right over anything.
 *   - The guarantee in rule 3 below holds only while the caller builds this map
 *     and the signature's vocabulary from ONE graph. Two graphs, and a derived
 *     owner is a value the signer has never heard of.
 *   - It trusts the provenance it is HANDED. `plan.intent` is never read, so
 *     a drafter's own sentence protects nothing; a caller that built the
 *     provenance out of that sentence would undo it, which is why `repair`
 *     takes the provenance from its caller and never from the draft.
 *   - `derived` says the engine computed this owner. It does not say the
 *     proposal had nothing in the field: a right's owner is not the model's to
 *     state (§5.2), so a model that guessed the same value is reported the
 *     same as one that wrote `{unknown}`.
 *   - Withdrawing is not an event. It produces a question, and a question is
 *     already audible on the stream — the reason `repair` gives for not
 *     announcing a contested owner a second time beside its own `ask`.
 */

export interface DerivedOwner {
  /** The dotted path, the form `findUnknowns` returns and a report reads out. */
  readonly path: string
  readonly owner: string
  /** The consumers it was read off, in the order the proposal declared them. */
  readonly from: readonly string[]
}

export interface ContestedOwner {
  readonly path: string
  /** The owners that disagreed, sorted. Two teams, one access, one human call. */
  readonly owners: readonly string[]
}

/**
 * An owner the user stated, kept, where the consumers determine another.
 *
 * The user's word outranks the consumers (rule 1), and that is a decision the
 * engine made about two facts that disagree — so it is stated, not left for a
 * reader to spot in a diff carrying one team's authorisation and another
 * team's consumer. The case is not rare in the ask loop: the owner question
 * and a consumer question are put in the same round, so an owner can be typed
 * before the consumer that then determines a different one.
 */
export interface OverriddenOwner {
  readonly path: string
  /** What the user stated, and what the plan keeps. */
  readonly owner: string
  /** What the consumers would have given. */
  readonly determined: string
  readonly from: readonly string[]
}

/**
 * The plan, and what happened to it.
 *
 * Not a bare `Plan`, and the extra two fields are the reason. This function
 * overwrites a model's explicit "I do not know" with a value the model never
 * wrote — that is a decision, and a decision nobody can see is the one shape
 * this repository argues against everywhere else (`dropped` in the preview,
 * `truncated` on a tool result: stated, never silent).
 *
 * `contested` reports only the case where this COULD have answered and refused
 * to. A right with no known consumer is not listed: there was nothing to read,
 * the question already says the value is undetermined, and a line saying "no
 * consumer had an owner" tells a reader nothing they can act on. Silence about
 * what was never answerable is not a hidden decision; silence about a deliberate
 * refusal would be.
 */
export interface Derivation {
  readonly plan: Plan
  readonly derived: readonly DerivedOwner[]
  readonly contested: readonly ContestedOwner[]
  readonly overridden: readonly OverriddenOwner[]
}

/**
 * `spec.type` is typed `unknown` — `or()` in `plan.ts` widens it — so the
 * registry is asked rather than the type system. A proposal that came through
 * `planSchema` can only carry a member or an `{unknown}`, but this is handed a
 * Plan by callers it does not own, and `natureOf` on a string outside the
 * registry would read `.nature` off undefined.
 */
const isResourceType = (value: unknown): value is ResourceType =>
  typeof value === 'string' && Object.hasOwn(RESOURCE_TYPES, value)

/**
 * Absent and `{unknown}` are the same fact: nobody stated an owner. It is what
 * says whether there is a value to withdraw, and no longer what says whether a
 * value may be overwritten — that is `stated`'s.
 */
const unstated = (owner: unknown): boolean =>
  owner === undefined || (typeof owner === 'object' && owner !== null && 'unknown' in owner)

/**
 * The question a withdrawn owner goes back to being.
 *
 * One sentence for two cases — an owner whose consumers changed under it, and
 * one a model wrote for a field §5.2 gives it no say in — because both are the
 * same fact about the plan as it now stands: nothing here determines who owns
 * this. A sentence about what an earlier round had done would be true of only
 * one of them, and this string is put to a person.
 */
const WITHDRAWN =
  'the request does not state an owner for this access, and its consumers do not determine one'

export function deriveOwners(
  plan: Plan,
  owners: ReadonlyMap<string, string>,
  provenance: Provenance,
): Derivation {
  const derived: DerivedOwner[] = []
  const contested: ContestedOwner[] = []
  const overridden: OverriddenOwner[] = []
  /**
   * opIndex → the owner to write, or the question to put back in its place.
   * Collected first; the plan is cloned once.
   */
  const settled = new Map<number, string | { unknown: string }>()

  for (const [index, operation] of plan.operations.entries()) {
    if (operation.op !== 'create-entity') continue
    const entity = operation.entity
    if (entity.kind !== 'Resource') continue
    if (!isResourceType(entity.spec.type) || natureOf(entity.spec.type) !== 'right') continue
    const current = entity.spec.owner
    const path = `operations.${index}.entity.spec.owner`
    // Rule 1, and the only thing that outranks the consumers: the user stated
    // this owner. Not "something is already there" — that was what let the
    // engine's own value protect itself (F2) — and not "the request names it"
    // alone, which withdrew an owner the user had just typed for this field.
    // Decided before the consumers are read, and acted on after: what they
    // would have given is what `overridden` reports.
    const kept =
      typeof current === 'string' && stated(provenance, path, current) ? current : undefined

    const from: string[] = []
    const found = new Set<string>()
    for (const consumer of entity.spec.dependencyOf ?? []) {
      // A consumer is a COMPONENT. Reading `dependencyOf` without checking what
      // it named was the whole of this module's promise broken in one line: a
      // proposal listing the REACHED resource as its own consumer made the
      // engine write that resource's owner onto the access — an authorisation
      // handed to the team that owns the database, for a grant nobody asked
      // them about. `dependsOn` is excluded by never being read; that is not
      // enough, because the same ref can appear on the consumer side too.
      //
      // The kind is in the reference, which is why a reference carries one.
      if (!consumer.startsWith('component:')) continue
      const declared = owners.get(consumer)
      if (declared === undefined) continue
      from.push(consumer)
      found.add(declared)
    }

    // Exactly one ANSWER, not exactly one consumer. Two consumers agreeing is
    // not ambiguity — it is the same fact declared twice — and requiring one
    // consumer would send an access shared by a team's two services back to the
    // user over a question nobody has.
    const [only] = found
    if (kept !== undefined) {
      // Only a single determined owner is overridden. Two teams are the
      // contest the user's word settles, which is what asking them was for.
      if (found.size === 1 && only !== undefined && only !== kept) {
        overridden.push({ path, owner: kept, determined: only, from })
      }
      continue
    }
    if (found.size === 1 && only !== undefined) {
      settled.set(index, only)
      // Reported on every pass, including the one where the value does not
      // move. The Reviewer runs ONCE, in whichever round reaches it, and this
      // list is the whole of what it is told about which values were not a
      // model's choice; a derivation that went quiet because it agreed with
      // itself would be one that round's Reviewer never heard of (F2).
      derived.push({ path, owner: only, from })
      continue
    }
    // More than one owner is where this stops. Picking the first would be the
    // guess the whole design exists to prevent, and two teams sharing one
    // access is precisely the case a human must decide. Zero falls here too and
    // is not reported: see `Derivation` for why.
    if (found.size > 1) contested.push({ path, owners: [...found].sort() })
    // Nothing answers it, and something is in the field. That value is either a
    // conclusion this drew from evidence the plan no longer carries or a choice
    // §5.2 does not give the model; in both cases nothing now vouches for it,
    // and the honest state of a field nothing vouches for is the question it
    // was before anything did. Leaving it would be the engine signing its own
    // earlier guess (F2).
    if (!unstated(current)) settled.set(index, { unknown: WITHDRAWN })
  }

  if (settled.size === 0) return { plan, derived, contested, overridden }

  // Cloned, never mutated in place. The caller still holds the plan it was
  // handed — `repair` keeps one as the partial plan a clean stop shows — and a
  // function that rewrote it underneath them would make that record a lie.
  const clone = structuredClone(plan)
  for (const [index, value] of settled) {
    const operation = clone.operations[index]
    // The clone is the plan the loop above walked, so this holds by
    // construction; re-stating it is what the type system asks for, and it is
    // cheaper than a cast that would survive the shape changing.
    if (operation?.op !== 'create-entity') continue
    operation.entity.spec.owner = value
  }

  return { plan: clone, derived, contested, overridden }
}
