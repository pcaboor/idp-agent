import { planSchema, type Plan, type UnknownValue } from '../core/schemas/plan.js'
import { reasonOf } from '../core/schemas/reject.js'
import type { LlmClient, ModelToolCall, ModelToolSpec, Transcript } from '../llm/client.js'
import type { EventSink } from './events.js'
import { MAX_REPAIRS, takeTurn } from './forced-turn.js'
import type { ToolOutcome } from './tools/graph-tools.js'
import type { ProjectFacts } from './tools/project-tools.js'
import { PROPOSE_TOOL, buildProposeTool } from './tools/propose-tool.js'

/**
 * Bounds, not suggestions — the Analyst's, because a draft is the same shape of
 * work: read what the catalogue holds, then commit to one terminal call.
 * Exhausting the bound yields no plan at all rather than a partial one; a
 * partial plan is the outcome that must never reach a diff, because it looks
 * exactly like a plan.
 */
export const ARCHITECT_LIMITS = {
  maxTurns: 4,
  maxCallsPerTurn: 3,
  /** Turns that read nothing at all: a catalogue with nothing to say about this. */
  maxBarrenTurns: 2,
} as const

const SYSTEM = `You draft a plan of infrastructure declarations for one request.

You are given the request, the facts established about the application repository,
and a summary of the catalogue. Use the read tools to find out what the catalogue
already holds: whether the resource exists is what decides between proposing the
resource and the access to it, or the access alone. A grant that exists states
the level it grants; read it rather than assume it, and state it back in the
"access" of an "add-dependency-of" patch — the level that grant declares, not the
level the request asks for. Leave "access" out only when the grant declares none.

You may not name anything you have not read: every entity reference you give must
have come back from a tool in this conversation.

You choose no file, no folder and no path. The engine computes where a declaration
is filed, from its type and its name — there is no field to put one in and no tool
that will tell you one.

A value no tool returned and no fact states is {"unknown": "<why>"}, never a
plausible one. A guessed owner is authorisation handed to the wrong team, a
guessed environment is access somewhere nobody asked for, and a guessed access
level is write where read was asked for.

A right is over SOMETHING and granted to SOMEBODY. An access states both: the
resource it reaches in "dependsOn", and every consumer holding it in
"dependencyOf". A resource, a cache and an api are things: they state no
consumers and no level. When the resource the request names does not exist yet,
that is two operations — declare the resource, then declare the access over it —
and never one entity carrying both.

Finish by calling "${PROPOSE_TOOL}", with at least one operation. When the
catalogue already declares what the request asks for, propose it ANYWAY: the
preview compares your declaration to the bytes on disk and reports that it is
already there, naming the file. An empty list is not an answer, and it is
refused.`

const stated = (value: string | UnknownValue): string =>
  typeof value === 'string' ? value : `unknown (${value.unknown})`

/**
 * The established facts as lines rather than as JSON.
 *
 * Deterministic bytes, for the reason `formatSummary` gives: a recording digest
 * depends on them, and two `ProjectFacts` built by different paths — a report
 * the model made, and the all-unknown one a failed inspection returns — have no
 * reason to agree on key order.
 *
 * An unknown is printed, never dropped. A fact that arrives as an absent line
 * reads as a fact nobody needed, and the Architect would fill it in.
 */
function formatFacts(facts: ProjectFacts): string {
  const dependencies = facts.dependencies

  return [
    'repository:',
    `  name: ${stated(facts.name)}`,
    `  type: ${stated(facts.type)}`,
    `  lifecycle: ${stated(facts.lifecycle)}`,
    `  runtime: ${stated(facts.runtime)}`,
    `  owner: ${stated(facts.owner)}`,
    `  forge handle: ${stated(facts.forgeHandle)}`,
    '  declared dependencies:',
    ...(Array.isArray(dependencies)
      ? dependencies.length === 0
        ? ['    (none declared)']
        : dependencies.map((declared) => `    ${declared.name}: ${stated(declared.type)}`)
      : [`    ${stated(dependencies)}`]),
  ].join('\n')
}

const opening = (input: { intent: string; facts: ProjectFacts; summary: string; vocabulary: string }): string =>
  `request: ${input.intent}\n\n${formatFacts(input.facts)}\n\n${input.summary}\n${input.vocabulary}`

export interface ArchitectOutcome {
  /** Absent when the draft ended with nothing to review. */
  readonly plan: Plan | undefined
  /**
   * Rows the read tools cut off. Carried out because a plan drafted on a
   * partial view of the catalogue looks exactly like one drafted on all of it,
   * and the difference is the whole question of whether the proposal is right.
   */
  readonly truncated: number
  /** Proposals refused and handed back. A run that took three is worth seeing. */
  readonly rejections: number
}

/**
 * Terminal channels belonging to other agents. An agent's terminal tool ends
 * ITS loop and answers in ITS shape; in front of another agent it is a tool
 * that echoes arguments, which is a channel for a model to hear its own
 * invention back as a fact.
 */
const TERMINAL_ELSEWHERE = new Set(['answer'])

export async function draftPlan(
  client: LlmClient,
  tools: {
    specs: ModelToolSpec[]
    run(call: ModelToolCall): ToolOutcome
    witnessed: ReadonlySet<string>
  },
  input: { intent: string; facts: ProjectFacts; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<ArchitectOutcome> {
  emit({ type: 'agent:start', agent: 'architect' })

  // Built here and not handed in: `taken()` is the only way the plan comes back,
  // and a propose tool the caller also holds is a second reader of a buffer that
  // is supposed to cross the boundary once.
  const propose = buildProposeTool()
  // Read tools only, and the terminal one this function owns.
  //
  // The only tool bag this codebase builds is `buildTools`, and it carries
  // `answer` — the Analyst's terminal channel, which returns `{result:
  // call.args}`. Forwarded unfiltered, that hands the Architect a tool that
  // echoes its own arguments back as a tool RESULT: references the model
  // invented, returning in the shape of something the engine said. That echo
  // is the one shape every guarantee in propose-tool.ts exists to prevent, and
  // every test here filtered `answer` out by hand — so the combination the
  // code actually ships was the one never exercised.
  const specs = [
    ...tools.specs.filter((spec) => !TERMINAL_ELSEWHERE.has(spec.name)),
    propose.spec,
  ]
  const transcript: Transcript[] = [{ role: 'user', text: opening(input) }]
  let drafted: Plan | undefined
  let barren = 0
  /** What the model said on a turn that called nothing. Becomes the reason. */
  let said = ''
  /** Turns granted back for a refused terminal call. See MAX_REPAIRS. */
  let repairs = 0
  let rejections = 0
  // Carried out of the loop, the way the Analyst carries it. A plan drafted on
  // a catalogue view the tools cut off is byte-identical to one drafted on a
  // complete view, and Stage 2 already paid for that lesson once: `List all
  // Ressource` printed 25 of 28 in silence.
  let truncated = 0
  let stop = false

  for (
    let turn = 0;
    turn < ARCHITECT_LIMITS.maxTurns + repairs && drafted === undefined && !stop;
    turn += 1
  ) {
    // Two turns that read nothing mean the catalogue has nothing more to say
    // here. One more turn to ask for the proposal, then out — whether the model
    // cooperates or not.
    const barrenOut = barren >= ARCHITECT_LIMITS.maxBarrenTurns
    stop = barrenOut
    const last = turn === ARCHITECT_LIMITS.maxTurns - 1 || barrenOut
    // The last allowed turn forces termination rather than letting the loop fall
    // off its bound with nothing to show.
    let result
    try {
      result = await takeTurn({
        client,
        agent: 'architect',
        system: SYSTEM,
        transcript,
        tools: specs,
        terminal: PROPOSE_TOOL,
        last,
      })
    } catch (error) {
      // Not swallowed — a provider failure is not this loop's to absorb, and a
      // caller that asked for an inspection is owed the difference between
      // "nothing is established about this repository" and "I could not look".
      //
      // But it IS this loop's to CLOSE. `agent:start` is already on the sink,
      // and letting the rejection through untouched left a stream showing an
      // agent that began and never ended.
      emit({
        type: 'refused',
        agent: 'architect',
        reason: `the run stopped: ${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    }

    if (result.toolCalls.length === 0) {
      // Prose is not a stopping condition. A model that answers in words has
      // not used the terminal channel, and breaking here meant the forced turn
      // — the one thing that exists to stop the loop falling off its bound —
      // was never reached. It counts as a barren turn instead, and the text is
      // kept: it is the model saying why it did nothing, and it was being
      // discarded before it reached the transcript, the sink or the refusal.
      if (last) {
        said = result.text
        break
      }
      transcript.push({ role: 'assistant', text: result.text, toolCalls: [] })
      transcript.push({
        role: 'user',
        text: 'That turn called no tool. Answer by calling one, not in prose.',
      })
      barren += 1
      continue
    }

    let read = 0
    const executed = result.toolCalls.slice(0, ARCHITECT_LIMITS.maxCallsPerTurn)
    const dropped = result.toolCalls.length - executed.length
    transcript.push({ role: 'assistant', text: result.text, toolCalls: executed })

    for (const call of executed) {
      // The proposal is the terminal channel, not a read: it ends the draft or
      // is refused, never one more tool call in the stream.
      const reads = call.name !== PROPOSE_TOOL
      if (reads) emit({ type: 'tool:call', name: call.name, args: call.args })
      // Routed, not merged into one bag: the read tools witness what the engine
      // returned and the propose tool witnesses nothing, and a single `run` that
      // could do either would be one edit away from blurring that.
      if (reads && TERMINAL_ELSEWHERE.has(call.name)) {
        // Not listed, so a model asking for it is asking for something that is
        // not there. Refused in the transcript rather than executed: listing is
        // not the enforcement, this is.
        transcript.push({
          role: 'tool',
          id: call.id,
          name: call.name,
          result: { error: `${call.name} is not a tool this agent has` },
        })
        continue
      }
      const outcome = reads ? tools.run(call) : propose.run(call)
      read += outcome.rows
      truncated += outcome.truncated
      if (reads) {
        emit({
          type: 'tool:result',
          name: call.name,
          rows: outcome.rows,
          truncated: outcome.truncated,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        })
      }

      if (!reads) {
        const buffered = propose.taken()
        if (buffered !== undefined) {
          // The intent is the request, in the user's words, and the plan's
          // record of what was asked. No gate reads it — they read the
          // caller's `Provenance` — but a model-authored one would be a
          // proposal writing its own request, and vouching for itself the day
          // a caller built the provenance from it. See the propose tool.
          //
          // Validated HERE, against the whole plan, and inside the loop. The
          // propose tool checks the operations; `planSchema` checks the plan,
          // and the two are not the same check — its shape bounds apply to the
          // assembled object, and this function supplies a field the tool never
          // saw. Validating after the loop would have meant handing back an
          // object typed `Plan` that the plan boundary refuses, with no turn
          // left for the model to correct it.
          const parsed = planSchema.safeParse({ ...buffered, intent: input.intent })
          if (parsed.success) {
            drafted = parsed.data
            break
          }
          emit({
            type: 'retry',
            agent: 'architect',
            reason: reasonOf(parsed.error),
            })
          rejections += 1
          if (repairs < MAX_REPAIRS) repairs += 1
          transcript.push({
            role: 'tool',
            id: call.id,
            name: call.name,
            result: { error: reasonOf(parsed.error) },
          })
          continue
        }
        // Put back in the transcript, not thrown: the model gets to correct
        // itself rather than the whole draft failing on one malformed call. The
        // error names the field, which is what makes the correction possible —
        // and a turn is granted back, or the transcript would be handed a
        // correction nobody ever asks for.
        rejections += 1
        if (repairs < MAX_REPAIRS) repairs += 1
        emit({
          type: 'retry',
          agent: 'architect',
          reason: 'the proposal did not match the schema',
          })
        transcript.push({ role: 'tool', id: call.id, name: call.name, result: outcome.result })
        continue
      }

      transcript.push({ role: 'tool', id: call.id, name: call.name, result: outcome.result })
    }

    barren = read === 0 ? barren + 1 : 0

    // Dropped calls are told, never dropped in silence: the model must know its
    // request was not executed in full.
    if (dropped > 0) {
      transcript.push({
        role: 'user',
        text: `${dropped} further tool call(s) in that turn were not executed; the limit is ${ARCHITECT_LIMITS.maxCallsPerTurn} per turn.`,
      })
    }
  }

  if (drafted === undefined) {
    // Refused, and said so. There is no `plan:ready` in the event union yet
    // (design 6.2 lists one; `events.ts` says it arrives with the write path),
    // so success is reported by what the caller does with the plan, while a
    // failure has to be audible here or the run ends with no plan and no reason.
    emit({
      type: 'refused',
      agent: 'architect',
      // What the model SAID, when it said anything. A run that ended because
      // the model explained in prose why it could not propose has a reason
      // worth keeping; discarding it leaves the caller a generic sentence for
      // a specific failure.
      reason:
        said === ''
          ? 'the draft ended with no proposal, so there is nothing to review'
          : `the draft ended with no proposal: ${said.slice(0, 400)}`,
    })
    return { plan: undefined, truncated, rejections }
  }

  emit({ type: 'plan:ready', operations: drafted.operations.length })
  return { plan: drafted, truncated, rejections }
}
