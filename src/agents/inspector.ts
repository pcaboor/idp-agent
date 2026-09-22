import type { z } from 'zod'
import type { ProjectSnapshot } from '../context/project-fs/types.js'
import type { LlmClient, Transcript } from '../llm/client.js'
import type { EventSink } from './events.js'
import { MAX_REPAIRS, takeTurn } from './forced-turn.js'
import {
  REPORT_TOOL,
  buildProjectTools,
  projectFactsSchema,
  type ProjectFacts,
} from './tools/project-tools.js'

export { projectFactsSchema, type ProjectFacts } from './tools/project-tools.js'

/**
 * Bounds, not suggestions — the Analyst's reasoning, with an inspection's
 * shape. An inspection opens more files than a query opens tables, so the turn
 * budget is larger; exhausting it still yields an all-unknown report rather
 * than a partial one, because a partly filled `ProjectFacts` reads as partly
 * established and nothing downstream can tell the difference.
 */
export const INSPECTOR_LIMITS = {
  maxTurns: 6,
  maxCallsPerTurn: 4,
  /** Turns that read nothing at all: a repository with no answers in it. */
  maxBarrenTurns: 2,
} as const

const SYSTEM = `You establish facts about ONE application repository.

Use list_files and read_file to read it. You may not state anything the files do
not state: a fact no file carries is unknown, with a short reason naming what you
looked for and did not find.

Finish by calling "${REPORT_TOOL}". Every field is required. Give a value the
files state, or {"unknown": "<why>"}. Never omit a field and never fill one with
a plausible value — a guessed owner is authorisation handed to the wrong team,
and a name taken from a directory is a name nobody chose.

The owner is an entity reference, "group:<namespace>/<name>" or
"user:<namespace>/<name>". A CODEOWNERS entry is not one: "@acme/platform" is a
forge handle, a different namespace, and translating it would invent a reference
nobody declared. Put the handle verbatim in "forgeHandle" and leave "owner"
unknown, unless a file states an entity reference in full.`

/**
 * What the model is told before it has called anything, and the one place the
 * snapshot's `skipped` list appears.
 *
 * It arrives unasked rather than through a tool, and that is the whole point of
 * rule 4: what was EXCLUDED cannot be discovered — no tool returns it, and a
 * model that never thinks to ask believes it was handed the repository. What was
 * INCLUDED is different: it is exactly what `list_files` returns, and a model
 * that never calls it reads nothing and ends on the barren bound, loudly.
 *
 * The list is carried whole. `readProject` already caps it at
 * `PROJECT_LIMITS.maxSkipped` and states its own overflow in its last entry, so
 * a second cap here would be a second bound to drift and a second silent cut.
 */
function opening(snapshot: ProjectSnapshot): string {
  const lines = [
    `A snapshot of one application repository. ${snapshot.files.length} file(s) were read;`,
    'call list_files for their paths and read_file to read one.',
    '',
  ]

  if (snapshot.skipped.length === 0) {
    lines.push('Nothing was excluded: every file in the repository is in this snapshot.')
  } else {
    lines.push(
      `${snapshot.skipped.length} path(s) were NOT read and no tool can reach them:`,
      ...snapshot.skipped.map((entry) => `  ${entry.path} — ${entry.reason}`),
    )
  }

  lines.push(
    '',
    snapshot.truncated
      ? 'A cap stopped the harvest: paths exist that are neither read nor named above.'
      : 'No cap stopped the harvest: everything not named above was read.',
    '',
    'A fact that lives only in a file you were not given is unknown, not absent.',
  )

  return lines.join('\n')
}

/**
 * Every field unknown, carrying the reason the inspection ended.
 *
 * Not a default and not a fallback: an inspection that produced no report
 * established nothing, and the only honest shape for nothing is the one design
 * 5.4 defines. The repository root is deliberately not consulted — a checkout at
 * `~/work/billing-api` makes a very convincing name that no file in it states.
 */
const undetermined = (reason: string): ProjectFacts => ({
  name: { unknown: reason },
  type: { unknown: reason },
  lifecycle: { unknown: reason },
  runtime: { unknown: reason },
  owner: { unknown: reason },
  forgeHandle: { unknown: reason },
  dependencies: { unknown: reason },
})

export async function inspect(
  client: LlmClient,
  snapshot: ProjectSnapshot,
  emit: EventSink,
): Promise<ProjectFacts> {
  emit({ type: 'agent:start', agent: 'inspector' })

  const tools = buildProjectTools(snapshot)
  const transcript: Transcript[] = [{ role: 'user', text: opening(snapshot) }]
  let facts: ProjectFacts | undefined
  let barren = 0
  /** What the model said on a turn that called nothing. Becomes the reason. */
  let said = ''
  /** Turns granted back for a refused terminal call. See MAX_REPAIRS. */
  let repairs = 0
  let rejections = 0
  let stop = false

  for (
    let turn = 0;
    turn < INSPECTOR_LIMITS.maxTurns + repairs && facts === undefined && !stop;
    turn += 1
  ) {
    // Two turns that read nothing mean this repository has nothing more to say.
    // One more turn to ask for the report, then out — whether the model
    // cooperates or not.
    const barrenOut = barren >= INSPECTOR_LIMITS.maxBarrenTurns
    stop = barrenOut
    const last = turn === INSPECTOR_LIMITS.maxTurns - 1 || barrenOut
    // The last allowed turn forces termination rather than letting the loop fall
    // off its bound with nothing to show.
    let result
    try {
      result = await takeTurn({
        client,
        agent: 'inspector',
        system: SYSTEM,
        transcript,
        tools: tools.specs,
        terminal: REPORT_TOOL,
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
        agent: 'inspector',
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
    const executed = result.toolCalls.slice(0, INSPECTOR_LIMITS.maxCallsPerTurn)
    const dropped = result.toolCalls.length - executed.length
    transcript.push({ role: 'assistant', text: result.text, toolCalls: executed })

    for (const call of executed) {
      // The report is the terminal channel, not a read: it ends the inspection
      // or is refused, never one more tool call in the stream.
      const reads = call.name !== REPORT_TOOL
      if (reads) emit({ type: 'tool:call', name: call.name, args: call.args })
      const outcome = tools.run(call)
      read += outcome.rows
      if (reads) {
        emit({
          type: 'tool:result',
          name: call.name,
          rows: outcome.rows,
          truncated: outcome.truncated,
        })
      }

      if (call.name === REPORT_TOOL) {
        const parsed = projectFactsSchema.safeParse(call.args)
        if (parsed.success) {
          facts = parsed.data
          break
        }
        // Put back in the transcript, not thrown: the model gets to correct
        // itself rather than the whole inspection failing on a malformed call.
        // This is also how a forge handle put in `owner` comes back as an error
        // the model can act on instead of an owner nobody declared.
        rejections += 1
        if (repairs < MAX_REPAIRS) repairs += 1
        emit({
          type: 'retry',
          agent: 'inspector',
          reason: issueOf(parsed.error),
          })
        transcript.push({
          role: 'tool',
          id: call.id,
          name: call.name,
          result: { error: `${REPORT_TOOL}: ${issueOf(parsed.error)}` },
        })
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
        text: `${dropped} further tool call(s) in that turn were not executed; the limit is ${INSPECTOR_LIMITS.maxCallsPerTurn} per turn.`,
      })
    }
  }

  if (facts === undefined) {
    // Refused, and said so. There is no `facts:ready` in the event union
    // (design 6.2) and inventing one is not this file's to do: a successful
    // inspection is reported by the plan it feeds, while a failed one has to be
    // audible here or the Architect proposes from an object full of unknowns
    // without anyone having been told why.
    const reason =
      said === ''
        ? 'the inspection ended with no report, so nothing about this repository was established'
        : `the inspection ended with no report: ${said.slice(0, 400)}`
    emit({ type: 'refused', agent: 'inspector', reason })
    return undetermined(reason)
  }

  return facts
}

/**
 * The first issue, with the field it is about.
 *
 * `plan.ts` says in as many words why a rejection that cannot name the field is
 * a rejection nobody can act on. The repair here is the same one, a layer up and
 * inside a single turn: "invalid input" sends the model guessing at which of
 * seven fields it got wrong.
 */
function issueOf(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid'
  const where = issue.path.map(String).join('.')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}
