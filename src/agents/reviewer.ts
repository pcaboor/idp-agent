import { z } from 'zod'
import type { Plan } from '../core/schemas/plan.js'
import { QUERY_LIMITS } from '../core/schemas/query.js'
import { reasonOf } from '../core/schemas/reject.js'
import type { LlmClient, ModelToolSpec, Transcript } from '../llm/client.js'
import type { EventSink } from './events.js'
import { MAX_REPAIRS, takeTurn } from './forced-turn.js'
import { asAgent } from './lifetime.js'

/** The terminal tool. Named once so the loop and the spec cannot disagree. */
export const VERDICT_TOOL = 'verdict'

/**
 * One turn to judge, and one more that is forced onto the verdict.
 *
 * There is no `maxBarrenTurns` here and nothing is missing. The Analyst and the
 * Architect count turns that read nothing because reading is how those agents
 * make progress; this one reads nothing at all — it is handed the plan and the
 * request and holds a single tool — so a turn of prose is the only
 * non-terminal turn there is, and `maxTurns` is already the bound on those.
 */
export const REVIEWER_LIMITS = { maxTurns: 2, maxCallsPerTurn: 1 } as const

/**
 * The verdict, and refusal is a MEMBER of the union — `answerSchema`'s shape
 * for `answerSchema`'s reason: a model with no legal way to object invents a
 * defect in order to stay in schema. Here that cuts both ways, because this
 * verdict BLOCKS. An invented defect stops a sound plan, and an approval the
 * model could not express any other way lets an unsound one through.
 *
 * The reason is bounded by `QUERY_LIMITS.maxReason` and not by
 * `PLAN_LIMITS.maxStringLength`. Those two ceilings are for two jobs: 8 192
 * bounds a value that will be WRITTEN into a declaration, where a description
 * has to fit; 300 bounds one sentence a human reads on a terminal when
 * something was refused — which is exactly what this is, and
 * `unanswerable.reason` is its twin. Borrowed rather than restated, so the two
 * refusals cannot drift apart.
 */
export const verdictSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('ok') }),
  z.object({
    verdict: z.literal('reject'),
    reason: z.string().min(1).max(QUERY_LIMITS.maxReason),
  }),
])

/**
 * What the Reviewer returns, which is not quite what the model may say.
 *
 * `no-opinion` is a THIRD outcome and not a flavour of rejection, because the
 * difference decides what happens next and what the user is told. Collapsed
 * into `reject`, a review that never happened read as a review that refused:
 * the repair loop spent all three paid attempts asking the Architect to fix a
 * plan nobody had found fault with, and the run ended telling the user their
 * plan had been refused. The file said in a comment that this must never
 * happen; it was a comment, not a type.
 *
 * The direction is unchanged — this gate blocks, and no-opinion is not an
 * approval. What changes is that the caller can now say which of the two it
 * was, and stop instead of repairing.
 */
export type Verdict =
  | z.infer<typeof verdictSchema>
  | { readonly verdict: 'no-opinion'; readonly reason: string }

/**
 * One question, and the deterministic gates' questions written out as
 * everything this one is not.
 *
 * The earlier prompt named "an environment nobody named" and "an owner nobody
 * mentioned" as rejections, and that is what three refused attempts a run were
 * made of: the Reviewer re-judging PROVENANCE, which gate [2] settles value by
 * value, and refusing owners the engine had DERIVED outright from the consumer
 * (`core/plan/derive.ts`). Two gates applying two different rules to one field
 * is why a sound plan never reached a diff — and the one this gate loses is the
 * arithmetic one, because a signed plan's provenance is a fact and a model's
 * opinion of it is not.
 *
 * So the prompt states the four answers gate [2] can give, rather than asking
 * the model to take "already accounted for" on faith, and names the three
 * fields settled by the checks that run without a model — the environment and
 * the folder by `policies.ts`, the path by the engine computing it (§5.2). What
 * is left is design §6's sentence: "Perfectly valid YAML can answer the wrong
 * question." Whether the plan does what was asked — all of it, and nothing
 * more.
 *
 * What this does NOT buy: a level, an entity or half a request is still a
 * judgement a model makes about prose, and this prompt cannot make it a good
 * one. It removes the objection the model was RIGHT to raise on what it knew;
 * it does not make the remaining question easy.
 */
const SYSTEM = `You review one plan of infrastructure declarations against the request that asked for it.

You are given the request in the user's own words, the operations the plan would apply,
and — for any value the engine computed rather than a model choosing it — a line saying
so. That is everything: there is no conversation to consult and nothing to read. Judge
what the plan does, not how it came to be written.

Yours is the question no deterministic check can ask: does this plan do what the request
asked for — all of it, and nothing more? Perfectly valid declarations can answer the wrong
question. A plan that grants write where read was asked for, that touches an entity the
request never mentioned, or that does half of what was asked and stops: those are
rejections, and they are what this gate is for.

Do not judge where a value came from. Every value here is already accounted for: it
appears in the request, or it is one the catalogue already uses, or it follows from a rule
the engine applied, or it has already been turned into a question the user will be asked.
A gate before yours established that, value by value, and it is not re-opened here.
Refusing an owner because the request did not name it refuses the engine's own arithmetic:
an access belongs to whoever owns the service reaching through it, and the catalogue — not
the request — is where that is written.

Three more things are settled before you see the plan, each by a check that runs without a
model: the environment, where a plan touching one the request never named is stopped
before it reaches you; the folder, where a write into one the repository never declared is
stopped the same way; and the file path, which the engine computes from the type and the
name, so no model chooses one. Do not re-check them.

Every plan you see carries at least one operation; an empty one is refused before it
reaches you. A plan that restates what the catalogue already declares is not a mistake —
the preview compares it to the bytes on disk and reports that it is already there.

Finish by calling "${VERDICT_TOOL}":
  ok      the plan does what the request asked for, and goes no further
  reject  with a reason naming what is wrong, in the terms the request used

Your rejection stops the plan. It is not a note for someone to weigh later. Rejecting is a
valid outcome and so is accepting: do not invent a defect in order to have something to
say, and do not accept a plan you cannot account for.`

/**
 * The only tool, and it is the terminal channel.
 *
 * Design § 6 lists SI reads beside the Reviewer. They are absent here, and the
 * absence is the independence rule made structural rather than remembered: a
 * read tool is one more channel for something that is not the plan to reach the
 * gate that can veto it, and this gate is meant to answer one question — does
 * this plan match what was asked for — out of two inputs and nothing else.
 */
const TOOLS: ModelToolSpec[] = [
  {
    name: VERDICT_TOOL,
    description:
      'Give your verdict on the plan. "ok" accepts it. "reject" stops it, and needs a ' +
      'reason saying what is wrong, in the terms the request used. You must call this ' +
      'to finish.',
    parameters: verdictSchema,
  },
]

/**
 * A reason this file writes obeys the same ceiling the model's does.
 *
 * What comes back is typed `Verdict`, and a `Verdict` the schema would refuse is
 * a lie told by the type: anything that re-parses one — a recording, the gate
 * that reports which check ended the run — would refuse the engine's own words.
 */
const bounded = (reason: string): string => reason.slice(0, QUERY_LIMITS.maxReason)

/**
 * What the Reviewer is shown, and it is the whole of what it is shown.
 *
 * The request appears once, from the argument the caller passed. `plan.intent`
 * holds the same string — `draftPlan` fills it in from the user's words and the
 * model cannot write it — and printing it a second time would invite the model
 * to measure the plan against a field OF the plan. One authority for what was
 * asked.
 *
 * The operations cross as JSON rather than as prose lines. A formatter of our
 * own would be one field away from hiding the field that mattered, and the
 * field that mattered is the whole reason this gate exists: an environment
 * nobody named is a line in an operation, not a paragraph. The bytes are
 * deterministic for a plan that came through `planSchema` — the only way one is
 * minted (see `architect.ts`) — which is what a recording digest depends on.
 */
/**
 * Everything the Reviewer is given, and the list is short on purpose. The plan,
 * the request in the user's own words, and the values the ENGINE computed. No
 * transcript, no attempt number, no earlier gate's reason: this and the
 * Architect are the same weights behind the same provider, so their errors are
 * correlated by construction and a second opinion fed the first one's reasoning
 * is an echo holding a veto.
 */
export interface ReviewInput {
  readonly plan: Plan
  readonly intent: string
  /** Deterministic facts, never reasoning. See `opening`. */
  readonly derived: readonly { path: string; owner: string; from: readonly string[] }[]
  /**
   * What the repository says about each entity an `update-entity` targets.
   *
   * An update names its target by REFERENCE and carries no entity, so the
   * operations JSON for one is `{op, entityRef, patch}` and nothing more. A
   * reviewer asked "is this what was requested" about a grant whose level,
   * environment, owner and current consumers it cannot see is being asked to
   * judge an authorisation with the authorisation withheld — and an
   * `add-dependency-of` hands over exactly those facts.
   *
   * Read off the snapshot by the caller, never from the Architect: `agents/`
   * reaches no disk, and a fact arriving through the model is not a fact.
   */
  readonly targets: readonly UpdateTarget[]
  /**
   * What each operation would DO to the repository, from the preview.
   *
   * The Reviewer used to run before the preview existed, so it could approve a
   * plan whose only operation produces no bytes — which is what an "empty diff,
   * exit 0" run is. F10 moved the free gate first precisely so these exist by
   * the time this one runs; this is what that bought.
   */
  readonly effects: readonly OperationEffect[]
}

/** The repository's own words about the grant an update would extend. */
export interface UpdateTarget {
  readonly opIndex: number
  readonly entityRef: string
  /** What it grants, or undefined when it states no level (§4.1). */
  readonly level: string | undefined
  readonly environment: string | undefined
  readonly owner: string | undefined
  /** Who already holds it. An update ADDS to this list. */
  readonly consumers: readonly string[]
}

/** One operation, and what the preview says it would do. */
export interface OperationEffect {
  readonly opIndex: number
  readonly effect: string
}

const opening = (input: ReviewInput): string => {
  /**
   * What the ENGINE established, stated as fact — never what the Architect
   * reasoned.
   *
   * The distinction is the whole of this gate's independence, and leaving it
   * out cost three attempts every run: the Reviewer saw an owner the request
   * never named and refused it as an invention, three times, correctly by what
   * it knew. A derived owner is not a choice a model made — it follows from
   * the catalogue by a deterministic rule the engine applied — and a reviewer
   * that cannot tell the two apart refuses arithmetic.
   *
   * This is not the Architect's transcript arriving by another door. It
   * carries no reasoning, no attempt number and no earlier gate: one line per
   * derived value, saying which entity it follows from and what the catalogue
   * says that entity's owner is. A reviewer may still object to it — the rule
   * could be the wrong rule here — but it objects knowing what it is looking
   * at.
   */
  const facts =
    input.derived.length === 0
      ? ''
      : `\n\nvalues the engine computed rather than the model choosing them:\n${input.derived
          .map(
            (one) =>
              `  ${one.path} follows from ${one.from.join(', ')}, which the catalogue says ${one.owner} owns`,
          )
          .join('\n')}`

  /**
   * The target of each update, in the repository's own words.
   *
   * Rendered as lines rather than folded into the operations JSON, because the
   * JSON is what the model PROPOSED and this is what the repository SAYS. A
   * reviewer that cannot tell those apart is reading one document.
   */
  const targets =
    input.targets.length === 0
      ? ''
      : `\n\nwhat is already declared about each entity an update targets:\n${input.targets
          .map(
            (one) =>
              `  operations.${one.opIndex} targets ${one.entityRef}: ` +
              `${statedAs(one.level)}, ${where(one.environment)}, ${held(one.owner)}, ` +
              `${consumers(one.consumers)}`,
          )
          .join('\n')}`

  /**
   * What the plan would actually do. Every operation appears, including the
   * ones that change nothing: an operation producing no bytes is the difference
   * between a request satisfied and a request silently ignored, and it is
   * exactly what a reviewer approving "the plan" would otherwise never see.
   */
  const effects =
    input.effects.length === 0
      ? ''
      : `\n\nwhat each operation would do:\n${input.effects
          .map((one) => `  operations.${one.opIndex} ${one.effect}`)
          .join('\n')}`

  return `request: ${input.intent}\n\noperations the plan would apply:\n${JSON.stringify(
    input.plan.operations,
    null,
    2,
  )}${facts}${targets}${effects}`
}

const statedAs = (level: string | undefined): string =>
  level === undefined ? 'it states no level' : `it grants ${level}`

const where = (environment: string | undefined): string =>
  environment === undefined ? 'it declares no environment' : `it is scoped to ${environment}`

const held = (owner: string | undefined): string =>
  owner === undefined ? 'the catalogue names no owner for it' : `${owner} owns it`

const consumers = (list: readonly string[]): string =>
  list.length === 0 ? 'nobody holds it yet' : `it is already held by ${list.join(', ')}`

/**
 * The substance gate (design § 6.1, gate [4]). Zod refuses what cannot be
 * expressed; this refuses what is expressible, well-formed, and still not what
 * was asked for.
 *
 * It BLOCKS, deliberately, and that decision is what makes its input list
 * mandatory rather than tidy. The Architect and the Reviewer are the same
 * weights behind the same provider, so their errors are correlated by
 * construction; fed the Architect's own transcript, a second opinion becomes an
 * echo — and this echo holds a veto. So: the Plan and the original request,
 * never the draft's reasoning, never which attempt this is, never what an
 * earlier gate said.
 *
 * What that does NOT buy is independence of judgement. Two runs of the same
 * model over the same plan are not two reviewers, and no amount of input
 * hygiene makes them so. This catches the mismatch between a request and a
 * plan; it does not catch a blind spot the model has about both.
 */
export async function reviewPlan(
  client: LlmClient,
  input: ReviewInput,
  emit: EventSink,
): Promise<Verdict> {
  return asAgent('reviewer', emit, () => reviewAgainstRequest(client, input, emit))
}

async function reviewAgainstRequest(
  client: LlmClient,
  input: ReviewInput,
  emit: EventSink,
): Promise<Verdict> {
  const transcript: Transcript[] = [{ role: 'user', text: opening(input) }]
  let verdict: Verdict | undefined
  /** What the model said on a turn that called nothing. Becomes the reason. */
  let said = ''
  /** Turns granted back for a refused terminal call. See MAX_REPAIRS. */
  let repairs = 0
  let rejections = 0

  for (
    let turn = 0;
    turn < REVIEWER_LIMITS.maxTurns + repairs && verdict === undefined;
    turn += 1
  ) {
    // Every turn after the first is forced, granted-back ones included. A turn
    // bought by a repair exists so the model can correct a verdict it already
    // gave; spending it on an open choice would spend it on a turn that need
    // not conclude.
    const last = turn >= REVIEWER_LIMITS.maxTurns - 1
    let result
    try {
      result = await takeTurn({
        client,
        agent: 'reviewer',
        system: SYSTEM,
        transcript,
        tools: TOOLS,
        terminal: VERDICT_TOOL,
        last,
      })
    } catch (error) {
      // Not swallowed — a provider failure is not this loop's to absorb, and a
      // caller is owed the difference between "the plan was rejected" and "no
      // opinion was obtained". Both stop the plan; only one is about the plan.
      //
      // But it IS this loop's to CLOSE, for the reason the Architect and the
      // Inspector both give: `agent:start` is already on the sink, and letting
      // the rejection through untouched leaves a stream showing an agent that
      // began and never ended.
      emit({
        type: 'stopped',
        agent: 'reviewer',
        reason: bounded(error instanceof Error ? error.message : String(error)),
      })
      throw error
    }

    if (result.toolCalls.length === 0) {
      // Prose is not a verdict. A model that reviews in words has not used the
      // terminal channel, and stopping here would skip the forced turn — the
      // one thing that exists to stop the loop falling off its bound. The text
      // is kept either way: it is the model saying why it did not conclude, and
      // it is the only account of that the refusal will have.
      //
      // The last turn that said SOMETHING wins, not simply the last turn: a
      // forced turn that comes back empty is the common shape here, and letting
      // it overwrite an earlier statement trades the model's own account of why
      // for the generic sentence below.
      if (result.text !== '') said = result.text
      if (last) break
      transcript.push({ role: 'assistant', text: result.text, toolCalls: [] })
      transcript.push({
        role: 'user',
        text: 'That turn called no tool. Give your verdict by calling one, not in prose.',
      })
      continue
    }

    const executed = result.toolCalls.slice(0, REVIEWER_LIMITS.maxCallsPerTurn)
    const dropped = result.toolCalls.length - executed.length
    transcript.push({ role: 'assistant', text: result.text, toolCalls: executed })

    for (const call of executed) {
      if (call.name !== VERDICT_TOOL) {
        // Not listed, so a model asking for it is asking for something that is
        // not there. Refused in the transcript rather than ignored: a call that
        // vanishes leaves the model waiting on a result it will never read.
        transcript.push({
          role: 'tool',
          id: call.id,
          name: call.name,
          result: { error: `${call.name} is not a tool this agent has` },
        })
        continue
      }

      const parsed = verdictSchema.safeParse(call.args)
      if (parsed.success) {
        verdict = parsed.data
        break
      }

      // Put back in the transcript, not thrown: the model gets to correct
      // itself rather than the whole review failing on one malformed call. The
      // error names the field, which is what makes the correction possible —
      // and a turn is granted back, or the correction would be written into a
      // transcript that is never sent again.
      const why = reasonOf(parsed.error)
      rejections += 1
      if (repairs < MAX_REPAIRS) repairs += 1
      emit({ type: 'retry', agent: 'reviewer', reason: why })
      transcript.push({
        role: 'tool',
        id: call.id,
        name: call.name,
        result: { error: `${VERDICT_TOOL}: ${why}` },
      })
    }

    // Dropped calls are told, never dropped in silence: the model must know its
    // request was not executed in full.
    if (dropped > 0) {
      transcript.push({
        role: 'user',
        text: `${dropped} further tool call(s) in that turn were not executed; the limit is ${REVIEWER_LIMITS.maxCallsPerTurn} per turn.`,
      })
    }
  }

  if (verdict === undefined) {
    // Fail closed, and the direction is the decision rather than a default. A
    // review that did not happen is not an approval: this gate blocks, so
    // returning "ok" here would turn every provider hiccup into the silent
    // removal of the gate — a run that got no second opinion would be
    // indistinguishable, in its output and in its exit code, from one that got
    // a favourable one. Rejecting costs a user a run they must ask for again;
    // approving costs them the only check that reads the plan against what they
    // actually asked for.
    //
    // What this does NOT say is that the plan is wrong, and that is now a
    // TYPE rather than a sentence in a comment: `no-opinion` is its own member
    // of the union, so the repair loop can tell "nobody reviewed this" from
    // "the reviewer refused it" — and stop, rather than spending three paid
    // attempts repairing a plan no one found fault with.
    const reason = bounded(
      said === ''
        ? 'the review ended with no verdict, so this plan has not been reviewed'
        : `the review ended with no verdict: ${said}`,
    )
    emit({ type: 'refused', agent: 'reviewer', reason })
    return { verdict: 'no-opinion', reason }
  }

  if (verdict.verdict === 'reject') {
    // A rejection is the Reviewer doing its job, and it stops the plan (design
    // § 6.1). It is audible for the reason the Architect's refusal is: a run
    // that ends with no diff has to say which gate ended it.
    emit({ type: 'refused', agent: 'reviewer', reason: verdict.reason })
  }

  // Nothing is emitted when the plan passes. The event union has no verdict of
  // its own (design § 6.2 lists none) and inventing one is not this file's to
  // do: a plan that cleared this gate is reported by the gate after it, and in
  // the end by the diff.
  return verdict
}
