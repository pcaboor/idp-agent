import { questionsOf, type Question } from '../core/plan/clarify.js'
import { deriveOwners, type DerivedOwner } from '../core/plan/derive.js'
import { planEdits, type DroppedOperation } from '../core/plan/edits.js'
import { checkPolicies, type PolicyContext } from '../core/plan/policies.js'
import { recheckPlan, type Recheck } from '../core/plan/recheck.js'
import { signPlan, type SignatureContext, type SignedPlan } from '../core/plan/sign.js'
import type { FileEdit } from '../core/diff/unified.js'
import { planSchema, type Plan } from '../core/schemas/plan.js'
import { reasonOf } from '../core/schemas/reject.js'
import type { RepositorySnapshot } from '../core/validate/rules.js'
import type { ArchitectOutcome } from './architect.js'
import type { EventSink } from './events.js'
import type { Verdict } from './reviewer.js'

/**
 * The repair loop of design §6.1, and it is **plain TypeScript**.
 *
 * It holds no transcript, no tool and no system prompt, because it is not an
 * agent: orchestration is deterministic and no agent decides the sequence
 * (design §6, ADR-0001). What it does is run five gates over a draft in the one
 * order the design fixes, hand what refused back to the Architect, and stop.
 * The only loop it has is the attempt count.
 *
 * The two steps that cost a model round-trip arrive as **functions**, not as a
 * client: `draft` and `review`. Three things follow from that, and each is the
 * reason it is written this way rather than taking an `LlmClient`.
 *
 *   - No `LlmClient` appears in this file at all, so every gate and the whole
 *     ordering is testable with no model, no recording and no transcript.
 *   - The Architect's inputs — its tool bag, the project facts, the catalogue
 *     summary — are none of this file's business. It knows how to ask for a
 *     draft; it does not know what an Architect needs in order to make one.
 *   - Where the report LANDS in the Architect's opening message is the caller's
 *     choice. What is guaranteed here is what the string contains.
 *
 * What this does NOT do is write. It composes the bytes a plan would leave
 * behind because the re-check reads them (see `recheckPlan`), and it stops
 * there: `agents/` reaches no disk, which is why the repository arrives as a
 * snapshot and a map of bytes rather than as a path.
 */

/** Design §6.1: "3 attempts maximum", then a clean stop. */
export const REPAIR_LIMITS = { maxAttempts: 3 } as const

/**
 * The five gates, in the order they run.
 *
 * Named as a type because two things read it: the loop, and the `repair` event
 * that says which one refused. A gate that exists in one and not the other
 * would be a gate nobody can see from the stream.
 */
export type Gate = 'zod' | 'signature' | 'policy' | 'reviewer' | 'recheck'

export interface RepairAttempt {
  readonly attempt: 1 | 2 | 3
  /**
   * The gates that actually RAN, in the order they ran — appended as each one
   * is reached, never listed up front. A re-ordering of the source below is
   * therefore a failing test rather than a comment that stopped being true.
   */
  readonly gates: readonly Gate[]
  /** The gate that ended this attempt. Absent when every gate it ran passed. */
  readonly failed: Gate | undefined
  /** What the Architect was handed afterwards, verbatim. */
  readonly report: string | undefined
}

/**
 * Three outcomes, and they are a union rather than one record with optional
 * fields so that the absences are compile errors.
 *
 * `stopped` carries a `plan` and **no `signed`**: design §6.1 shows the partial
 * plan with the reason and writes no file, and there is nowhere in this shape
 * to put the signed object a caller would need in order to write one. The same
 * reason `SignedPlan`'s brand is unforgeable, one level up.
 */
export type RepairOutcome =
  | {
      readonly outcome: 'planned'
      readonly signed: SignedPlan
      /** One edit per file, as `planEdits` composed them. The diff the caller shows. */
      readonly edits: readonly FileEdit[]
      readonly dropped: readonly DroppedOperation[]
      readonly recheck: Recheck
      readonly attempts: readonly RepairAttempt[]
      readonly truncated: number
      readonly rejections: number
    }
  | {
      readonly outcome: 'questions'
      /** The plan as the signer left it: every unvouched value already a question. */
      readonly plan: Plan
      readonly questions: readonly Question[]
      readonly attempts: readonly RepairAttempt[]
      readonly truncated: number
      readonly rejections: number
    }
  | {
      readonly outcome: 'stopped'
      /** The partial plan, shown with the reason. Absent only if no draft ever parsed. */
      readonly plan: Plan | undefined
      readonly gate: Gate | undefined
      readonly reason: string
      readonly attempts: readonly RepairAttempt[]
      readonly truncated: number
      readonly rejections: number
    }

export interface RepairInput {
  /**
   * The request, in the user's own words, from the caller that read them.
   *
   * Held here and imposed on every draft rather than taken from the plan,
   * because `plan.intent` arrives from the same callback as the plan. The
   * signature measures provenance against the intent — a value that appears in
   * it is `echoed`, the strongest claim a value can carry — so a drafter that
   * wrote its own intent could name the owner it wanted to propose and have
   * the gate vouch for it. `draftPlan` does overwrite the field today; this is
   * the gate not depending on that, since it is the gate that would be wrong.
   */
  readonly intent: string
  /**
   * Ask the Architect for a plan. `report` is what the previous attempt's gate
   * refused, in the engine's own words; it is absent on the first attempt,
   * because there is nothing yet to fix.
   */
  readonly draft: (report: string | undefined) => Promise<ArchitectOutcome>
  /**
   * Gate [4]. A function and not a client for the reason above, and separate
   * from `draft` for the reason `reviewer.ts` gives: the Reviewer must not see
   * the Architect's reasoning, which attempt this is, or what an earlier gate
   * said. Keeping the two as two arguments is what makes that a wiring decision
   * the caller cannot make by accident.
   */
  /**
   * Gate [4]. Takes the derivations as well as the plan: a derived owner is a
   * fact the engine computed, and a Reviewer that cannot tell it from a value
   * the model chose refuses arithmetic — which it did, three attempts a run.
   * Facts, never reasoning; the independence rule is unchanged.
   */
  readonly review: (
    plan: Plan,
    derived: readonly DerivedOwner[],
  ) => Promise<Verdict>
  readonly signature: SignatureContext
  readonly policy: PolicyContext
  /**
   * ref → the owner that entity declares, read off the catalogue by the caller
   * (`agents/` reaches no disk). What `deriveOwners` computes a right's owner
   * from, between gates [1] and [2].
   *
   * Required, and not optional with an empty default. An absent map derives
   * nothing, which is exactly the block this exists to clear: a caller that
   * forgot it would get the old behaviour — every access stopping on
   * `spec.owner` — with nothing anywhere saying why. It must be built from the
   * same graph as `signature.vocabulary`, or a derived owner is a value the
   * signature has never heard of; `deriveOwners` says so where it states what
   * it does not cover.
   */
  readonly owners: ReadonlyMap<string, string>
  /**
   * The repository as it is NOW — gate [5] is handed one, it does not fetch
   * one. §4.4: the catalogue lags the repository by about two minutes, so the
   * freshness of this snapshot is the caller's guarantee to make, not this
   * file's, and nothing here can improve on what it was given.
   */
  readonly snapshot: RepositorySnapshot
  /**
   * The bytes of that snapshot, path → content. `planEdits` composes against
   * text rather than an AST, because a reviewer reads an added line (§4.3).
   */
  readonly contents: ReadonlyMap<string, string>
}

/**
 * What the Architect is handed, and every line of it carries the ENGINE'S own
 * dotted path — `operations.0.entity.spec.owner`, the string `findUnknowns`
 * produces and a human reads out.
 *
 * Never a paraphrase, and this is the whole reason the schemas, the signer and
 * the policies all agree on one path format: a model repairing a paraphrase is
 * repairing something else, and it has no way to tell that it is.
 *
 * It does not say which attempt this is. The model is told what is wrong, not
 * how much rope is left — "one try remaining" is an invitation to guess, and
 * the legal escape from not knowing a value is the question named below, not a
 * plausible value chosen under pressure.
 */
const reportOf = (gate: Gate, findings: readonly string[]): string =>
  [
    `the plan was refused at the ${gate} gate:`,
    '',
    ...findings.map((finding) => `  ${finding}`),
    '',
    'Each line names a field by its path in the plan you proposed. Propose again with ' +
      'those fixed, and {"unknown": "<why>"} wherever you cannot determine a value.',
  ].join('\n')

export async function repair(input: RepairInput, emit: EventSink): Promise<RepairOutcome> {
  const attempts: RepairAttempt[] = []
  /** The last plan that got past gate [1]. What a clean stop shows (§6.1). */
  let partial: Plan | undefined
  /** Rows the Architect's tools cut off, summed across every attempt. */
  /** Derivations already stated, so a repeated attempt does not restate them. */
  const announced = new Set<string>()
  let truncated = 0
  /** Proposals the Architect's own schema refused, summed across attempts. */
  let rejections = 0
  let report: string | undefined
  let refusal: { gate: Gate; reason: string } | undefined

  for (let number = 1; number <= REPAIR_LIMITS.maxAttempts; number += 1) {
    // The event's attempt is 1 | 2 | 3 (design §6.2) and `maxAttempts` is the 3
    // it names. Clamped so that raising the bound cannot make the two disagree.
    const attempt = Math.min(number, 3) as 1 | 2 | 3
    const gates: Gate[] = []

    const fail = (gate: Gate, findings: readonly string[]): void => {
      // One list of findings, two renderings: the report the model reads and
      // the one line a person watching the stream reads. Two formatters would
      // be two places for them to say different things about one refusal.
      const reason = findings.join('; ')
      report = reportOf(gate, findings)
      refusal = { gate, reason }
      attempts.push({ attempt, gates: [...gates], failed: gate, report })
      emit({ type: 'repair', attempt, gate, reason })
    }

    const drafted = await input.draft(report)
    // Carried, not read and dropped. The Architect counts these for its caller:
    // rows the tools cut off, and proposals its own schema refused. A plan
    // drafted on a partial view of the catalogue looks exactly like one drafted
    // on all of it, and this seam was where that signal died.
    truncated += drafted.truncated
    rejections += drafted.rejections

    if (drafted.plan === undefined) {
      // Not a repair, and not an attempt worth paying for again. The Architect
      // has already spent its own forced turn and its granted-back ones, and it
      // has already emitted `refused` on this same sink — a `repair` event here
      // would report that failure a second time under a name that promises a
      // correction, and the report we could hand back would say nothing the
      // model does not already know.
      attempts.push({ attempt, gates, failed: undefined, report: undefined })
      // The refusal an earlier attempt recorded is kept, not overwritten. A
      // second attempt that produced no draft at all does not un-refuse the
      // first one, and `plan` still carries the partial plan a gate judged —
      // returning "there was nothing to judge" beside it said two things that
      // could not both be true.
      const earlier = [...attempts].reverse().find((one) => one.failed !== undefined)
      return {
        outcome: 'stopped',
        plan: partial,
        gate: earlier?.failed,
        reason:
          earlier === undefined
            ? 'the draft ended with no proposal, so there was nothing for a gate to judge'
            : `the draft ended with no proposal; the last one was refused at the ${earlier.failed} gate: ${earlier.report ?? ''}`,
        attempts,
        truncated,
        rejections,
      }
    }

    // [1] Zod. Free, and first — which is what makes the gate after it total:
    // every name the engine could not turn into a path is a name `proposedName`
    // has already refused, so the signer is never asked to file one.
    //
    // `draftPlan` parses too, and that is not this parse. Its parse happens
    // inside its own loop so the MODEL gets a turn to fix the field; this one
    // is the boundary of a function that is handed a plan by a callback it does
    // not own. A different drafter — a recording, a fixture, next year's agent
    // — meets the same gate.
    gates.push('zod')
    const parsed = planSchema.safeParse(drafted.plan)
    if (!parsed.success) {
      fail('zod', [reasonOf(parsed.error)])
      continue
    }
    // Between [1] and [2], and **not a gate**.
    //
    // After the parse because it needs a Plan — it reads `spec.type` and
    // `spec.dependencyOf`, and gate [1] is what makes those mean anything.
    // Before the signature because the signature is what the derived value has
    // to satisfy: run afterwards, it would be writing a value into a plan that
    // had already been classified, and the classification would describe a
    // field that no longer exists. Every later gate — the policies, the
    // Reviewer, the re-check — then judges the plan with the owner in it,
    // which is the plan the user would be shown.
    //
    // It is not in `Gate`, and that is a decision rather than an omission.
    // `Gate` is read by two things: the list of gates an attempt RAN, and the
    // `repair` event that names the one that refused. Derivation can only ever
    // add information — it has no refusal and no report to hand back — so a
    // member there could never appear in `failed`, and the event would name a
    // gate that never fails. The five gates of §6.1 stay five.
    //
    // The caller's intent, never the draft's — the same substitution the
    // signature makes four lines below, and now for a second reason. The
    // derivation keeps an owner the REQUEST states (F2), so a drafter left free
    // to supply its own `intent` could write the sentence that protects the
    // owner it wanted. The plan a seeded round hands back carries the PREVIOUS
    // round's request as well, which is the request without the answer that
    // round was seeded with.
    const derivation = deriveOwners({ ...parsed.data, intent: input.intent }, input.owners)
    // Stated, never silent. The engine is overwriting a model's explicit "I do
    // not know" with a value the model never wrote; the same rule that makes a
    // truncated tool result audible makes this one.
    for (const one of derivation.derived) {
      // Once per path, not once per attempt. The same owner follows from the
      // same consumer every time the loop comes round, and emitting it again
      // rendered as three identical lines with nothing to tell them apart —
      // the defect `events.ts` documents for `retry` and fixes there.
      if (announced.has(one.path)) continue
      announced.add(one.path)
      emit({ type: 'derived', path: one.path, owner: one.owner, from: [...one.from] })
    }
    // `derivation.contested` is deliberately not emitted. A contested owner is
    // still a question, and it already leaves as an `ask`; a stderr line beside
    // it would state one stop twice and read as two things having happened —
    // the reason `events.ts` gives for `ask` rendering nothing itself. It is
    // returned rather than dropped so whoever renders the questions can name
    // the two teams that disagreed, which is a job for the form stage 7 draws
    // and not for a progress line.

    // The plan the gates judge, and the one a clean stop shows. Not
    // `parsed.data`: showing the pre-derivation draft would show the user a
    // plan no gate ever saw.
    partial = derivation.plan

    // [2] The signature. Free. It vouches for where every value came from, and
    // turns the ones nobody can vouch for into questions rather than refusing
    // them — "declare, never infer" means asking (see `signPlan`).
    gates.push('signature')
    // The caller's intent, never the draft's. See RepairInput.intent.
    const signed = signPlan({ ...derivation.plan, intent: input.intent }, input.signature)
    if ('outcome' in signed) {
      fail(
        'signature',
        signed.refusals.map((one) => `${one.path}: ${one.reason}`),
      )
      continue
    }

    // A question is NOT a failed gate, and this is where it leaves the loop.
    //
    // It exits here, after the signature and before anything that costs: the
    // signer is what INSERTS most of these, so asking earlier would put half
    // the questions to the user and keep the rest for the next run. And it
    // exits rather than repairs because no model can fix it — the value is one
    // only the user holds. Handing it back would spend three paid attempts
    // asking the Architect to invent exactly what design 4.1 forbids it to
    // invent, and the third would end in a clean stop over a plan that was
    // never wrong. Design 7.5: the CLI asks.
    const questions = questionsOf(signed.plan)

    // [3] Policies. Free, deterministic, and every violation at once: a caller
    // fixing them one round-trip at a time is this loop's worst case.
    //
    // It runs BEFORE the questions leave, even though a question ends the run:
    // a policy costs nothing, and the alternative was putting a question to
    // the user about a plan this gate would have refused outright. Worse, it
    // was an escape — an Architect failing a hard gate could turn a refusal
    // into a question by emitting one `{unknown}` anywhere in the plan, and
    // the loop would stop asking it to try again.
    gates.push('policy')
    const violations = checkPolicies(signed, input.policy)
    if (violations.length > 0) {
      fail(
        'policy',
        violations.map((one) => `${one.policy} at ${one.path}: ${one.message}`),
      )
      continue
    }

    // A question is NOT a failed gate, and this is where it leaves the loop.
    //
    // After the free gates and before anything that costs. It exits rather
    // than repairs because no model can fix it — the value is one only the
    // user holds. Handing it back would spend three paid attempts asking the
    // Architect to invent exactly what design 4.1 forbids it to invent, and
    // the third would end in a clean stop over a plan that was never wrong.
    // Design 7.5: the CLI asks.
    if (questions.length > 0) {
      // Audible, not merely returned. A consumer reading the stream has to see
      // why a run stopped; the outcome is for the caller, the events are for
      // whoever is watching (design §6.2).
      for (const question of questions) emit({ type: 'ask', question })
      attempts.push({ attempt, gates: [...gates], failed: undefined, report: undefined })
      return { outcome: 'questions', plan: signed.plan, questions, attempts, truncated, rejections }
    }

    // [4] The Reviewer. The first gate that costs anything, and the order is
    // what buys that: three free gates have already refused everything they
    // can, so a round-trip is only ever paid for a plan that is expressible,
    // vouched for, determined and policy-clean. The question it answers is the
    // one none of them can ask — is this what was asked for.
    gates.push('reviewer')
    const verdict = await input.review(signed.plan, derivation.derived)
    if (verdict.verdict === 'no-opinion') {
      // No opinion is not a rejection, and repairing is not the answer to it.
      // Nobody found fault with this plan — nobody read it — so handing the
      // Architect a report saying "fix this" would spend the remaining paid
      // attempts on a defect that does not exist, and end by telling the user
      // their plan was refused. It stops here, saying what actually happened.
      return {
        outcome: 'stopped',
        plan: signed.plan,
        gate: 'reviewer',
        reason: verdict.reason,
        attempts,
        truncated,
        rejections,
      }
    }
    if (verdict.verdict === 'reject') {
      fail('reviewer', [verdict.reason])
      continue
    }

    // [5] The re-check, last because it is the only gate whose answer can go
    // stale: it asks what CI would say about the repository this plan would
    // leave behind, and it asks it of the very bytes the caller is about to
    // show. Running it before the Reviewer would compute a preview for plans
    // the Reviewer then rejects.
    gates.push('recheck')
    const { edits, dropped } = planEdits(signed, input.contents)
    const recheck = recheckPlan(signed, input.snapshot, edits)
    // Errors only. A dangling reference is a warning: it is surfaced, never
    // pruned (§4.4), and refusing a plan over one would push people to delete
    // the declaration instead — the one thing that rule forbids.
    const errors = recheck.violations.filter((violation) => violation.severity === 'error')
    if (errors.length > 0) {
      fail(
        'recheck',
        errors.map((one) => `${one.rule} at ${one.file}: ${one.message}`),
      )
      continue
    }

    attempts.push({ attempt, gates: [...gates], failed: undefined, report: undefined })
    return { outcome: 'planned', signed, edits, dropped, recheck, attempts, truncated, rejections }
  }

  // Past three attempts: a clean stop (§6.1). The partial plan goes back with
  // the reason and nothing else — no signature, so nothing downstream can write
  // it, and no `refused` event, because `refused` names an AGENT and this is
  // not one agent's refusal. The gates are already audible as `repair` events;
  // the caller prints what comes back.
  //
  // What a stop does NOT claim is that the plan is wrong in the way the last
  // gate said. It is the last thing that was wrong with it after three tries,
  // which is the most this loop can honestly report.
  return {
    outcome: 'stopped',
    plan: partial,
    gate: refusal?.gate,
    reason:
      refusal === undefined
        ? 'the plan was refused, and no gate said which'
        : `${REPAIR_LIMITS.maxAttempts} attempts, still refused at the ${refusal.gate} gate: ${refusal.reason}`,
    attempts,
    truncated,
    rejections,
  }
}
