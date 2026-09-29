import { QUERY_LIMITS, answerSchema, type Answer } from '../core/schemas/query.js'
import type { LlmClient, Transcript } from '../llm/client.js'
import type { EventSink } from './events.js'
import { MAX_REPAIRS, takeTurn } from './forced-turn.js'
import { asAgent } from './lifetime.js'
import type { buildTools } from './tools/graph-tools.js'

/**
 * Bounds, not suggestions. A loop that can run forever cannot be shipped in a
 * tool that answers a read-only question, and exhausting the bound yields a
 * refusal rather than a partial guess — a partial guess is the one outcome
 * that must never reach a user, because it looks exactly like an answer.
 */
export const LOOP_LIMITS = {
  maxTurns: 4,
  maxCallsPerTurn: 3,
  /**
   * Turns that read nothing at all. "salut" is not a question about a
   * catalogue, and spending four paid round-trips to find that out is three
   * too many.
   */
  maxBarrenTurns: 2,
} as const

export interface AnalystOutcome {
  /**
   * Signed: an `entities` answer names only what the tools returned, and a
   * `relation` answer's entity and other end are references they returned. Its
   * `intro` and `conclusion`, when it carries them, are the model's words as
   * written and are NOT checked here — whoever prints them runs
   * `checkCommentary` first (ADR-0008), and nothing puts them on the stream.
   */
  answer: Answer
  witnessed: ReadonlySet<string>
  calls: string[]
  /**
   * Rows cut off by the searches the answer's references came from — for each
   * reference, the last call that returned it, a `get_entity` of a reference
   * the model already held aside: a lookup does not say where the list came
   * from, and letting it did drop the cut of the search that had. The tool
   * tells the model; if it stopped there the CLI would print a short list with
   * nothing saying it is short. Only those searches: a wide search the model
   * narrowed afterwards cut rows of a list nobody is shown, and adding its cut
   * to the answer's said the answer was short by rows it never lacked
   * (gap-ask-grounding-11). A search run twice is one search.
   */
  truncated: number
}

/** The prompt up to the end of the `relation` line, where the organisation's paragraph goes. */
const HEAD = `You answer questions about an infrastructure catalogue.

Use the tools to read the catalogue. You may not state anything you have not read:
every reference you give must have come back from a tool in this conversation.
A reference marked "declared": false is written in the catalogue and names no entity:
say so, and never treat it as the entity that shares its name.

Finish by calling "answer":
  entities      with the references you read, when they answer the question
  relation      with "ref" and "relation", when asked how an entity is related:
                what it consumes or reaches ("consumes"), who consumes or uses
                it ("consumed-by"), what it depends on ("depends-on"), what
                breaks or is affected if it fails ("impacts"), the APIs it
                provides or who provides one ("provides", "provided-by"), or
                how two entities are related ("between", the other one as
                "to": the paths where one depends on the other, else what both
                reach). The engine computes every path and writes it; "ref"
                and "to" must be references a tool returned. get_relations
                shows you those paths; read them before you conclude on them.`

/**
 * The organisation's relations, with the question each answers: in the
 * prompt only when the registry reads the organisation (`buildTools`'
 * `organisation`), so over a source that holds none the prompt is the one
 * every tape was recorded against, byte for byte.
 */
const ORGANISATION = `
                Over the organisation — Groups (teams), Users (people),
                Systems and Domains, found with search_entities and read
                with get_entity — "relation" also answers what a team or a
                person owns ("owns"), who owns something and the teams above
                ("owned-by"), a person's or a team's groups ("member-of"),
                who is in a team ("has-member"), which system and domain
                something is in ("part-of"), and what a system or a domain
                holds ("has-part").`

const TAIL = `
  nothing       when no entity matches
  overview      when asked to describe, summarise or give an overview of the
                catalogue, SI, repository or project as a whole. The engine
                writes the description; call it straight away, and never answer
                "unanswerable" for such a request
  unanswerable  with a reason, when the catalogue cannot answer this question

Refusing is a valid outcome. Do not approximate to produce one.

With "entities", "relation", "nothing" or "overview" you may add "intro", one
short sentence introducing the answer, and "conclusion", at most three short
sentences on what the result means for the question. Write both in the
language of the question. Say only what the tool results state; where they do
not say, say it is not declared rather than guess. Do not restate the list or its figures: the engine
prints them. Name only entities a tool returned in this conversation: the
engine deletes any sentence that names anything else, an identifier nobody
returned included. Both are optional: omit them rather than pad.

If the request is not a question about this catalogue at all — a greeting, small
talk, something about the weather — call "answer" with "unanswerable" straight
away. Do not search first.`

const SYSTEM = `${HEAD}${TAIL}`
const SYSTEM_WITH_ORGANISATION = `${HEAD}${ORGANISATION}${TAIL}`

/**
 * What the loop reads off the registry: its specs, what it runs and signs
 * with, and — when the registry says — the answer it advertises and whether
 * it reads the organisation. Absent, the answer is `answerSchema`, without
 * the organisation, as a registry built with `apis` alone advertises.
 */
type Registry = Pick<ReturnType<typeof buildTools>, 'specs' | 'run' | 'witnessed'> &
  Partial<Pick<ReturnType<typeof buildTools>, 'answer' | 'organisation'>>

const unanswerable = (reason: string): Answer => ({ outcome: 'unanswerable', reason })

/**
 * The references an answer names, each of which a tool must have returned: an
 * `entities` answer's, and a `relation`'s entity and, for `between`, its other
 * end. What the stream's `answer:ready` carries, and nothing else.
 */
function referencesOf(answer: Answer): string[] {
  switch (answer.outcome) {
    case 'entities':
      return [...answer.refs]
    case 'relation':
      return answer.to === undefined ? [answer.ref] : [answer.ref, answer.to]
    case 'nothing':
    case 'overview':
    case 'unanswerable':
      return []
    default: {
      const exhaustive: never = answer
      return exhaustive
    }
  }
}

export async function answerQuestion(
  client: LlmClient,
  // What the loop runs and signs with. What a result showed as naming nothing
  // is the commentary check's, read off the registry by whoever runs it.
  tools: Registry,
  input: { intent: string; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<AnalystOutcome> {
  return asAgent('analyst', emit, () => answerFromCatalogue(client, tools, input, emit))
}

async function answerFromCatalogue(
  client: LlmClient,
  tools: Registry,
  input: { intent: string; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<AnalystOutcome> {
  const system = tools.organisation === true ? SYSTEM_WITH_ORGANISATION : SYSTEM
  const answers = tools.answer ?? answerSchema
  const transcript: Transcript[] = [
    {
      role: 'user',
      text: `question: ${input.intent}\n\n${input.summary}\n${input.vocabulary}`,
    },
  ]
  const calls: string[] = []
  let answer: Answer | undefined
  /** What each search cut, by the call as the model made it. */
  const cuts = new Map<string, number>()
  /** For each reference, the search that returned it last — a lookup aside. */
  const cameFrom = new Map<string, string>()
  let barren = 0
  /** What the model said on a turn that called nothing. Becomes the reason. */
  let said = ''
  /** Turns granted back for a refused terminal call. See MAX_REPAIRS. */
  let repairs = 0
  /**
   * Answer calls the union refused, and why the last one was. A model that
   * answered three times and never fitted did not find the catalogue silent,
   * and the refusal must not say it did. Cleared by a read that returns rows:
   * a run that went on to read the catalogue did not end on the refusal.
   */
  const rejected = { times: 0, issue: '' }

  let stop = false

  for (
    let turn = 0;
    turn < LOOP_LIMITS.maxTurns + repairs && answer === undefined && !stop;
    turn += 1
  ) {
    // Two turns that read nothing mean the catalogue has nothing to say here.
    // One more turn to ask for the answer, then out — whether the model
    // cooperates or not.
    const barrenOut = barren >= LOOP_LIMITS.maxBarrenTurns
    stop = barrenOut
    const last = turn === LOOP_LIMITS.maxTurns - 1 || barrenOut
    // The last allowed turn forces termination rather than letting the loop
    // fall off its bound with nothing to show.
    const result = await takeTurn({
      client,
      agent: 'analyst',
      system,
      transcript,
      tools: tools.specs,
      terminal: 'answer',
      last,
    })

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
    const executed = result.toolCalls.slice(0, LOOP_LIMITS.maxCallsPerTurn)
    const dropped = result.toolCalls.length - executed.length
    transcript.push({ role: 'assistant', text: result.text, toolCalls: executed })

    for (const call of executed) {
      calls.push(call.name)
      // `answer` is the terminal channel, not a read: it is reported by
      // answer:ready or refused, never as one more tool call in the stream.
      const reads = call.name !== 'answer'
      if (reads) emit({ type: 'tool:call', id: call.id, name: call.name, args: call.args })
      const outcome = tools.run(call)
      if (reads) {
        const search = `${call.name} ${JSON.stringify(call.args)}`
        cuts.set(search, outcome.truncated)
        // A lookup of a row the model already holds is not where the row came
        // from: a wide search then a `get_entity` per row it keeps is how a
        // model reads one, and the lookup's cut of 0 hid the search's.
        const lookup = call.name === 'get_entity'
        for (const ref of outcome.returned ?? []) {
          if (!lookup || !cameFrom.has(ref)) cameFrom.set(ref, search)
        }
      }
      // A reference shown as naming nothing is not a row, but it was read:
      // two turns that found only those have not found nothing.
      const found = outcome.rows + (outcome.dangling ?? 0)
      read += found
      if (found > 0) {
        rejected.times = 0
        rejected.issue = ''
      }
      if (reads) {
        emit({
          type: 'tool:result',
          id: call.id,
          name: call.name,
          rows: outcome.rows,
          truncated: outcome.truncated,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        })
      }

      if (call.name === 'answer') {
        const parsed = answers.safeParse(call.args)
        if (parsed.success) {
          answer = parsed.data
          break
        }
        // Put back in the transcript, not thrown: the model gets to correct
        // itself rather than the whole question failing on a malformed call —
        // and a turn is granted back, or on the forced turn the correction is
        // written into a transcript that is never sent again.
        if (repairs < MAX_REPAIRS) repairs += 1
        const [issue] = parsed.error.issues
        rejected.times += 1
        rejected.issue =
          issue === undefined
            ? 'invalid'
            : `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`
        // The same issue the person is told, field path and all: a model
        // told only "expected array" has to guess which field it was.
        transcript.push({
          role: 'tool',
          id: call.id,
          name: call.name,
          result: { error: `answer: ${rejected.issue}` },
        })
        continue
      }

      transcript.push({ role: 'tool', id: call.id, name: call.name, result: outcome.result })
    }

    barren = read === 0 ? barren + 1 : 0

    // Dropped calls are told, never dropped in silence: the model must know
    // its request was not executed in full.
    if (dropped > 0) {
      transcript.push({
        role: 'user',
        text: `${dropped} further tool call(s) in that turn were not executed; the limit is ${LOOP_LIMITS.maxCallsPerTurn} per turn.`,
      })
    }
  }

  // A turn of prose on the last allowed turn is the model saying why, and it
  // was being thrown away. It becomes the reason when there is nothing better.
  const signed = sign(answer, tools.witnessed, said, rejected)
  if (signed.outcome === 'unanswerable' && answer?.outcome !== 'unanswerable') {
    emit({ type: 'refused', agent: 'analyst', reason: signed.reason })
  } else {
    // The outcome travels with the event: an overview and an empty result
    // both carry no reference, and a renderer must not have to guess which.
    emit({
      type: 'answer:ready',
      outcome: signed.outcome,
      refs: referencesOf(signed),
    })
  }

  const sources = new Set(referencesOf(signed).flatMap((ref) => cameFrom.get(ref) ?? []))
  const truncated = [...sources].reduce((total, search) => total + (cuts.get(search) ?? 0), 0)
  return { answer: signed, witnessed: tools.witnessed, calls, truncated }
}

/**
 * The engine's two checks on what the model produced. Neither is a formality:
 * the first is the whole read-side guarantee, the second catches a model that
 * saw rows and then claimed emptiness.
 */
function sign(
  answer: Answer | undefined,
  witnessed: ReadonlySet<string>,
  said: string,
  rejected: { times: number; issue: string },
): Answer {
  if (answer === undefined) {
    // Say what happened, not how the loop is built. A model whose answers were
    // refused, with nothing read since, is the engine's fact and outranks
    // anything the model said in prose afterwards: "nothing matched" there was
    // false. Every refused answer since the last read is counted; only the last
    // is named.
    if (rejected.times > 0) {
      const times = rejected.times === 1 ? 'once' : `${rejected.times} times`
      return unanswerable(
        `the model answered ${times} and no answer fitted the answer tool; the last: ${rejected.issue}`.slice(
          0,
          QUERY_LIMITS.maxReason,
        ),
      )
    }
    // An empty witness set means the catalogue held nothing for this — very
    // often because it was not a question about the catalogue at all.
    if (said !== '') return unanswerable(said.slice(0, 400))
    return unanswerable(
      witnessed.size === 0
        ? 'nothing in the catalogue matched this, and it may not be a question about it'
        : 'the search read entities but did not settle on an answer',
    )
  }

  if (answer.outcome === 'relation' && answer.relation !== 'between' && answer.to !== undefined) {
    // Discarded, never read: only `between` has another end, and a model
    // shown the field flat beside every relation fills it (ADR-0007).
    const { to: _discarded, ...kept } = answer
    return sign(kept, witnessed, said, rejected)
  }

  if (answer.outcome === 'entities' || answer.outcome === 'relation') {
    const invented = referencesOf(answer).filter((ref) => !witnessed.has(ref))
    if (invented.length > 0) {
      return unanswerable(`the answer named ${invented.join(', ')}, which no tool returned`)
    }
    return answer
  }

  if (answer.outcome === 'nothing' && witnessed.size > 0) {
    // Refused, and said so in terms the reader can act on rather than in terms
    // of the check that caught it.
    return unanswerable(
      'the model contradicted what it read, so its answer was not used; try a more specific question',
    )
  }

  // An overview passes as chosen, whatever was read on the way: it carries no
  // reference, so there is nothing in it to witness here. The engine writes it
  // from the graph. Its commentary, like that of every answer kept here, is
  // handed back as the model wrote it: the check that reads it needs every
  // entity the graph holds, and this agent never holds a graph
  // (`core/answer/commentary.ts`, run by `cli/commands/ask.ts`).
  return answer
}
