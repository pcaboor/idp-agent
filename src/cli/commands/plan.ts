import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { draftPlan } from '../../agents/architect.js'
import type { EventSink } from '../../agents/events.js'
import { inspect } from '../../agents/inspector.js'
import { repair, type Gate, type RepairAttempt, type RepairOutcome } from '../../agents/repair.js'
import { reviewPlan } from '../../agents/reviewer.js'
import { formatSummary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import { EntityGraph, refOf } from '../../context/graph/entity-graph.js'
import { summariseGraph, type SiSummary } from '../../context/graph/summary.js'
import { readRepository } from '../../context/iac-fs/snapshot.js'
import { readProject } from '../../context/project-fs/snapshot.js'
import { renderUnifiedDiff, type FileEdit } from '../../core/diff/unified.js'
import { answer, AnswerError, questionsOf, type Question } from '../../core/plan/clarify.js'
import { deriveOwners } from '../../core/plan/derive.js'
import { planEdits, type DroppedOperation } from '../../core/plan/edits.js'
import { declaredLevel, natureOf } from '../../core/plan/grant.js'
import { checkPolicies, type PolicyContext, type PolicyViolation } from '../../core/plan/policies.js'
import { recheckPlan, type Recheck } from '../../core/plan/recheck.js'
import { signPlan, type SignatureContext, type SignedPlan } from '../../core/plan/sign.js'
import { planSchema, type Plan } from '../../core/schemas/plan.js'
import type { AccessLevel, Nature } from '../../core/schemas/resource-types.js'
import { ENV_ANNOTATION, type Vocabulary } from '../../core/schemas/vocabulary.js'
import type { RepositorySnapshot, Violation } from '../../core/validate/rules.js'
import type { LlmClient } from '../../llm/client.js'
import { readConfig, seededVocabulary, type RepositoryConfig } from '../config.js'
import { paintDiff } from '../render/diff.js'
import type { CommandResult } from './result.js'
import { plain } from '../render/plain.js'
import { declarationsRoot } from '../repository.js'

/**
 * Steps 3 to 7 of §7.4, wired end to end and stopping one step short of the
 * branch and the merge request.
 *
 * **Two ways in, one way out.** `runPlan` reads a Plan from a file — no model is
 * involved and none can be — and `runIntent` drafts one: Inspector, Architect,
 * the repair loop of §6.1. They meet at `renderPreview`, and that meeting is
 * the point. A second renderer would be a second answer to "what would this
 * do?", and the deterministic entry point exists precisely so the two can be
 * compared byte for byte.
 *
 * Everything either one calls is tested on its own — the signature, the three
 * policies, the re-check, the edits, the diff, the loop. What lives here is the
 * order they run in, what each outcome costs, and which exit code it earns.
 *
 * Both read and neither writes. Nothing below opens a file for writing, and
 * `plan-command.test.ts` and `plan-intent.test.ts` hash every path, every byte
 * and every directory of both repositories either side of a full run rather
 * than taking that on trust.
 *
 * No injected reader, unlike `runValidate`: the guarantee this command owes is
 * about a real directory on a real disk, and a fake file system is precisely
 * what would let it pass while being false. The MODEL is injected, because a
 * model is not a disk — a scripted client is the whole of how the intent form
 * is tested without a key and without a recording.
 */

/** The one line every run that produced a diff ends on (design §7.4). */
const CLOSING = 'Nothing is provisioned yet. The merge is what authorises it.'

/**
 * The arguments were refused, which is exit 2 — a different answer from "the
 * repository does not conform". `CommandResult` has no room for that
 * distinction by design: a command states a fact and `cli/index.ts` turns it
 * into a code. So the refusal is thrown and caught there, the way
 * `NoModelConfiguredError` already is.
 */
export class PlanInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanInputError'
  }
}

export interface PlanOptions {
  /** The JSON Plan. Anywhere on disk; it is not part of the repository. */
  readonly from: string
  /** The declarations repository. A preview is decided against it, never against the catalogue (§4.4). */
  readonly repo: string
  readonly json?: boolean
  /** Only a caller that knows it holds a terminal asks for colour. */
  readonly colour?: boolean
  /**
   * How a question reaches a person. Absent means there is nobody to ask — a
   * pipeline, a test, a `--json` run in CI — and the questions print and the
   * run exits 3, which is what it did before there was an `ask` at all.
   */
  readonly ask?: Ask
  /**
   * Where a derivation is stated. Absent means nobody is listening — the
   * events still travel on the intent road, and this road has no agents to
   * report; but the engine overwriting an explicit "I do not know" must be
   * audible wherever it happens.
   */
  readonly emit?: EventSink
}

/**
 * Zod puts the offending field in the issue's path and not in its message, so
 * the message alone says something is wrong without saying what — the same
 * repair `readRepository` makes for an entity it refused.
 */
const reasonOf = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): string => {
  const issue = issues[0]
  if (issue === undefined) return 'not a plan'
  const where = issue.path.map(String).join('.')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}

async function loadPlan(from: string): Promise<Plan> {
  let text: string
  try {
    text = await readFile(from, 'utf8')
  } catch (error) {
    throw new PlanInputError(
      `cannot read ${from}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new PlanInputError(
      `${from} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // The first gate of §6.1. A proposal that does not parse is refused whole:
  // previewing the operations that happen to be well formed would offer a
  // reviewer a diff for a plan nobody can run.
  const parsed = planSchema.safeParse(value)
  if (!parsed.success) {
    throw new PlanInputError(`${from} is not a plan — ${reasonOf(parsed.error.issues)}`)
  }
  return parsed.data
}

/**
 * The bytes, beside the parse. `RepositorySnapshot` keeps the entities and the
 * provenance and drops the text, and `planEdits` composes against text — it has
 * to, because a reviewer reads an added line and not an AST (§4.3). Reading
 * twice is the price of not making the snapshot carry a second representation
 * of every file.
 *
 * A file it cannot read refuses the run, named. `readRepository` reports one
 * as a rejection, which is right for `validate`; skipping it here is not:
 * `planEdits` takes a path it holds no bytes for as a file that does not
 * exist, and would preview a creation over one that does.
 */
async function readContents(
  root: string,
  snapshot: RepositorySnapshot,
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    snapshot.files.map(async (file) => {
      const absolute = path.join(root, ...file.path.split('/'))
      try {
        return [file.path, await readFile(absolute, 'utf8')] as const
      } catch (error) {
        const why = (error as NodeJS.ErrnoException).code ?? String(error)
        throw new PlanInputError(
          `${file.path} could not be read (${why}); plan needs every file of the repository`,
        )
      }
    }),
  )
  return new Map(entries)
}

interface Contexts {
  readonly signature: SignatureContext
  readonly policy: PolicyContext
  /** What both gates measure a value against, `.idp-agent.yml` included. */
  readonly vocabulary: Vocabulary
  /**
   * ref → the owner that entity declares. What `deriveOwners` reads a right's
   * owner off, and it is built HERE, beside the vocabulary and off the same
   * graph, because that is the condition the whole derivation rests on: a
   * value read from one graph and measured against another is a value the
   * signature has never heard of.
   */
  readonly owners: ReadonlyMap<string, string>
  /** The same counts the Supervisor's summary uses, so the model sees one catalogue. */
  readonly summary: SiSummary
}

/**
 * The catalogue as the repository states it (§4.4: Backstage to explore, the
 * git repository to decide).
 *
 * One builder, because two readers need it and they must not disagree: the gate
 * contexts are derived from it, and so are the Architect's read tools — a
 * witness set built from one graph while the plan is signed against another
 * would vouch for references this repository has never seen.
 */
const graphOf = (snapshot: RepositorySnapshot): EntityGraph =>
  EntityGraph.from(snapshot.files.flatMap((file) => [...file.entities]))

/**
 * Both gates read the same repository, so they are built together and the
 * vocabulary is derived once. `summariseGraph` is the builder the Supervisor's
 * summary already uses; a second one here would be a second answer to "what
 * values does this catalogue use".
 *
 * `witnessed` is the caller's to supply, because the two entry points can
 * honestly claim different things. A plan that arrived in a FILE has no tool
 * transcript — there was no tool — so the honest witness set is the references
 * the repository itself declares, read off disk, which is stronger provenance
 * than a witness set a model's own call produced. A plan the Architect DRAFTED
 * has one, and `buildTools` holds it: what the engine returned during the
 * draft, never what the model wrote. Defaulting to the declarations is what the
 * file form wants and what the intent form must not silently inherit.
 */
function contextsOf(
  root: string,
  snapshot: RepositorySnapshot,
  graph: EntityGraph,
  seed: {
    readonly config?: RepositoryConfig | undefined
    readonly witnessed?: ReadonlySet<string>
  } = {},
): Contexts {
  const summarised = summariseGraph(graph)
  // What the entities show, plus what §7.0 declares. A fresh repository shows
  // no environment at all, which leaves every environment policy with nothing
  // to fire on — see `seededVocabulary`.
  const vocabulary = seededVocabulary(summarised.vocabulary, seed.config)

  const declared = new Map<string, string>()
  const environments = new Map<string, string>()
  const owners = new Map<string, string>()
  const levels = new Map<string, AccessLevel | undefined>()
  const natures = new Map<string, Nature>()
  for (const file of snapshot.files) {
    for (const entity of file.entities) {
      declared.set(refOf(entity), file.path)
      // Every entity, and the value is what it STATES — undefined when it
      // states none. The policies need both facts: a reference the map does
      // not hold at all is a grant this repository has never declared, while
      // one it holds with no level is §4.1's unstated level, which is never
      // read as `readwrite` and never already says `read`.
      levels.set(refOf(entity), declaredLevel(entity))
      // Thing or right (§4.1). Read from the kind and the type, never from the
      // folder: where a file sits is a convention this tool computes for what
      // it writes, and says nothing about what somebody else filed.
      natures.set(refOf(entity), natureOf(entity))
      // Read from the entity, never inferred: `spec.owner` is required on both
      // kinds, so every entity the reader accepted contributes exactly one.
      owners.set(refOf(entity), entity.spec.owner)
      const env = entity.metadata.annotations[ENV_ANNOTATION]
      // Declare, never infer: an entity with no environment contributes none,
      // and cross-environment-consumer stays silent rather than reading one off
      // the name.
      if (env !== undefined) environments.set(refOf(entity), env)
    }
  }

  return {
    vocabulary,
    owners,
    summary: summarised.summary,
    signature: {
      // `plan "<intent>"` and `plan --from` both carry the request a person
      // typed, so the word test stands.
      wordsOf: 'user',
      witnessed: seed.witnessed ?? new Set(declared.keys()),
      vocabulary,
      repoRoot: root,
      declared,
      // Filled per round by whichever loop is asking. Empty here because
      // nothing has been asked yet, and `contextsOf` runs once.
      answered: new Set<string>(),
    },
    policy: { vocabulary, witnesses: new Set(snapshot.witnesses), environments, levels, natures },
  }
}

const errorsIn = (recheck: Recheck): Violation[] =>
  recheck.violations.filter((violation) => violation.severity === 'error')

const violationLine = (violation: Violation): string =>
  `${violation.severity.padEnd(7)} ${violation.file}: ${violation.message}`

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/** What the repository already says, for the run that has nothing to add. */
function settled(signed: SignedPlan, recheck: Recheck): string[] {
  const lines: string[] = []
  for (const [opIndex, outcome] of recheck.outcomes) {
    if (outcome !== 'already-declared') continue
    const where = signed.paths.get(opIndex)
    const ref = signed.refs.get(opIndex)
    if (where === undefined || ref === undefined) continue
    lines.push(`  = ${where} already declares ${ref}`)
  }

  return lines.length === 0
    ? ['nothing to change.']
    : ['nothing to change — the repository already says it:', '', ...lines]
}

/**
 * Whether an empty diff is an ANSWER or a failure to act, which are two
 * outcomes that used to share one sentence and one exit code.
 *
 * `nothing to change.` on exit 0 says the repository already grants what was
 * asked for. It is true when the re-check says `already-declared`: the plan
 * restated a declaration and the bytes it would write are the ones on disk.
 *
 * It is NOT true when every operation was dropped instead — a Component the
 * engine computed no path for, a proposal that could not be read back as an
 * entity, an update whose target is in no file this plan can see. The reasons
 * are printed underneath either way, and printing a reason under a sentence
 * that contradicts it is not saying it: somebody asked for an authorisation,
 * got exit 0 and the words "nothing to change", and nothing happened.
 *
 * `create-catalog-info` is the one drop that is not a failure here, and it is
 * why this asks the re-check rather than counting dropped operations: its
 * bytes go to the SERVICE repository, which this preview does not cover, so a
 * plan carrying one has done what it said even though this diff is empty.
 */
const changedNothing = (
  signed: SignedPlan,
  dropped: readonly DroppedOperation[],
  recheck: Recheck | undefined,
): boolean => {
  if (recheck === undefined || dropped.length === 0) return false
  const accounted = new Set<number>()
  for (const [opIndex, outcome] of recheck.outcomes) {
    if (outcome === 'already-declared') accounted.add(opIndex)
  }
  for (const [opIndex, operation] of signed.plan.operations.entries()) {
    if (operation.op === 'create-catalog-info') accounted.add(opIndex)
  }
  return signed.plan.operations.every((_, opIndex) => !accounted.has(opIndex))
}

/**
 * What a machine reads: the signed plan, and everything that judged it.
 *
 * Returned as a value rather than as text, because the intent form wraps it —
 * a drafted plan has an outcome and an attempt count a file-borne one does not.
 * Two builders would be two shapes for one report.
 */
const reportOf = (
  signed: SignedPlan,
  questions: readonly Question[],
  policies: readonly PolicyViolation[],
  recheck: Recheck,
  changed: readonly FileEdit[],
  dropped: readonly DroppedOperation[],
): object => ({
  plan: signed.plan,
  signature: {
    paths: Object.fromEntries(signed.paths),
    refs: Object.fromEntries(signed.refs),
    classified: signed.classified,
  },
  questions,
  policies,
  recheck: {
    outcomes: Object.fromEntries(recheck.outcomes),
    violations: recheck.violations,
  },
  files: changed.map((edit) => edit.path),
  // An operation that produced no bytes is stated, never omitted: "this plan
  // grants nothing" and "nothing to change" are the same sentence for opposite
  // facts, and a machine must be able to tell them apart.
  dropped,
})

const asJson = (value: object): string => JSON.stringify(value, null, 2)

/**
 * What the plan asked for and this preview did not produce.
 *
 * Never silent. An operation that contributes no bytes looks exactly like one
 * whose work was already done, and those are opposite facts: the first means
 * the plan grants nothing, the second that it grants what is already granted.
 */
const droppedLines = (dropped: readonly DroppedOperation[]): string[] =>
  dropped.length === 0
    ? []
    : [
        '',
        `${plural(dropped.length, 'operation', 'operations')} produced no change:`,
        ...dropped.map((one) => `  ! operations.${String(one.opIndex)} — ${one.reason}`),
      ]

/**
 * The bytes a plan would leave behind, and the one line every such run ends on.
 *
 * **The single renderer.** `plan --from`, `plan "<intent>"` and `init --repo`
 * all arrive here, and that is deliberate: the deterministic entry point exists
 * so a drafted preview and a file-borne one can be compared byte for byte, and
 * a second renderer would quietly end that.
 *
 * `recheck` is optional, and its absence is a fact rather than a gap. It says
 * what CI would say about the repository this plan would leave behind, and
 * `init --repo` leaves none: `create-catalog-info` writes into the service's own
 * repository, which this preview does not cover (`edits.ts` says so where the
 * operation is dropped). With no re-check there are no warnings to report and
 * nothing that could have been 'already-declared', which is exactly what
 * `settled` falls back to.
 */
export function renderPreview(preview: {
  readonly signed: SignedPlan
  readonly edits: readonly FileEdit[]
  readonly dropped: readonly DroppedOperation[]
  readonly recheck?: Recheck | undefined
  readonly colour?: boolean
}): CommandResult {
  const { signed, edits, dropped, recheck } = preview
  const changed = edits.filter((edit) => edit.before !== edit.after)
  const diff = renderUnifiedDiff(edits)

  if (diff === '') {
    const acted = !changedNothing(signed, dropped, recheck)
    return {
      text: [
        ...(acted
          ? recheck === undefined
            ? ['nothing to change.']
            : settled(signed, recheck)
          : ['this plan changes nothing, and the repository does not already say it:']),
        ...droppedLines(dropped),
        '',
        '0 files · nothing written',
        CLOSING,
      ].join('\n'),
      found: true,
      // Exit 3 rather than 0: understood, and this build will not act on it.
      // The run produced no bytes and nothing states the request was already
      // satisfied, so reporting success would be the one falsehood this tool
      // must never tell.
      ...(acted ? {} : { unsupported: true }),
    }
  }

  // A warning is reported and never turns the answer negative: a dangling
  // reference is surfaced, never pruned (§4.4), and refusing a preview over one
  // would push people to delete the declaration instead.
  const warnings =
    recheck?.violations.filter((violation) => violation.severity === 'warning') ?? []

  return {
    text: [
      ...warnings.map(violationLine),
      ...droppedLines(dropped),
      ...(warnings.length > 0 || dropped.length > 0 ? [''] : []),
      paintDiff(diff, preview.colour === true).trimEnd(),
      '',
      `${plural(changed.length, 'file', 'files')} · nothing written`,
      CLOSING,
    ].join('\n'),
    found: true,
  }
}

/**
 * Exit 3: understood, and this build will not act on it. No diff — a preview of
 * the half that is determined would read like a plan that is ready, and it is
 * not.
 *
 * Shared by both forms for a reason beyond tidiness: a question is the one
 * outcome the user can DO something about, and the sentence telling them so has
 * to be the same sentence whichever road produced it.
 */
export const renderQuestions = (questions: readonly Question[]): CommandResult => ({
  text: [
    `${plural(questions.length, 'question', 'questions')}, asked rather than guessed:`,
    '',
    // `plain`, because the reason is up to 8 192 characters the MODEL wrote
    // and this line goes to a terminal. The path beside it is the engine's.
    ...questions.flatMap((question) => [
      `  ${question.path}`,
      `      ${plain(question.question)}`,
    ]),
    '',
    'Fill them in and run this again. Nothing was previewed, and nothing was written.',
  ].join('\n'),
  found: false,
  unsupported: true,
})

/**
 * How a question reaches a person, and it is a function for the reason `client`
 * is one: the whole interactive path is then driven from a test with no
 * terminal, no stdin and no process. `cli/index.ts` owns the only
 * implementation that touches a keyboard.
 *
 * `undefined` is the user DECLINING — they will not answer this one. It is not
 * an empty value, and the two must stay distinct: an empty string is a value
 * every gate below would wave through (`echoes` vouches for it) and it would
 * reach the diff as a field with nothing in it.
 */
export type Ask = (question: Question) => Promise<string | undefined>

/**
 * How many times a run may come back with questions before it stops asking.
 *
 * Three, the number §6.1 already gives the model, and for the same reason: a
 * bound is what turns "it keeps asking" into an outcome someone can read. It
 * counts ROUNDS, not questions — every question a pass produced is asked in one
 * round — so a plan with nine undetermined fields is one round, and a run that
 * answers a question only to be asked a new one is three.
 *
 * Exhausting it is a clean stop and never a loop: the questions that are left
 * print exactly as they do when nobody was there to ask, and the run exits 3.
 * What it does NOT do is claim the remaining questions are unanswerable — it
 * says this build stopped asking, which is the most it can honestly report.
 */
export const ASK_LIMITS = { maxRounds: 3 } as const

/** What the user said, and the field they said it about. */
export interface Answer {
  readonly path: string
  readonly value: string
}

/**
 * What putting a round of questions to someone produced. A union rather than
 * one record with optional fields, so the three absences are compile errors.
 */
export type Filling =
  | { readonly outcome: 'answered'; readonly plan: Plan; readonly answers: readonly Answer[] }
  /** They stopped. What is left is what they were not asked, or would not say. */
  | { readonly outcome: 'declined'; readonly unanswered: readonly Question[] }
  /** `answer` refused the path. Surfaced, never thrown at the user as a stack. */
  | { readonly outcome: 'refused'; readonly reason: string }

/**
 * The request, and what the user said when they were asked.
 *
 * **This is what stops an answer being asked about twice**, and it is not a
 * special case bolted onto the signer. `signPlan` classifies every leaf by where
 * it came from, and the strongest claim a value can carry is `echoed` — the
 * request names it. A value the user typed at a prompt and the request does not
 * carry classifies `novel` on the very next pass, `askAbout` puts an
 * `{unknown}` back where the answer was, and the same question returns for
 * ever. The fix is not to exempt the field: it is that the request GREW. The
 * user is the authority the intent comes from, so what they say when asked is
 * part of what they asked for, and `echoed` becomes true of it in the ordinary
 * way.
 *
 * Only the VALUES join it, never the dotted paths. A path is engine
 * bookkeeping — `operations`, `metadata`, `env` — and putting it in the string
 * the signature measures against would quietly vouch for those words as values
 * too. The Architect and the Reviewer read this same string, which is the other
 * half of why it has to grow: the Reviewer's question is "is this what was
 * asked for", and it rejects an owner "the request did not mention" — including
 * one the user just mentioned.
 *
 * What this does NOT cover: `echoes` is a whole-request test and always was, so
 * an answered `prod` vouches for `prod` ANYWHERE in the plan, not only at the
 * field it was typed for. That is the existing shape of `echoed` rather than
 * something new here, and the diff is still what a human reads.
 *
 * `undefined` when the answers no longer fit. The signed plan carries this
 * string in `plan.intent` and `--json` hands that plan to a caller who may feed
 * it back to `--from`: a request grown past the schema's own bound would be a
 * plan this tool emits and then refuses to read.
 */

/**
 * The signature context for this round, carrying what the user has answered.
 *
 * An answer is its own provenance. The loop used to put every answer back into
 * the request so `echoes` would find it, which worked for an identifier and
 * failed for a common word — and left a `--json` report quoting a request the
 * user never wrote. A value typed at a prompt is a fact about that value, and
 * `sign.ts` reads it as one.
 *
 * What it does NOT carry is which question each answer belonged to: an answer
 * vouches for the VALUE, so answering one field `read` would vouch for another
 * field also holding `read`. A narrower map is the better shape the day a plan
 * asks about two levels at once.
 */
const answering = (
  signature: SignatureContext,
  answers: readonly Answer[],
): SignatureContext => ({
  ...signature,
  answered: new Set(answers.map((one) => one.value)),
})

/**
 * An answer this run cannot use, and why. `found: false` and NOT `unsupported`:
 * the build understood the request and acted on it, and this is a negative
 * answer about one value — the same distinction `renderStopped` draws.
 */
const renderRefusedAnswer = (reason: string): CommandResult => ({
  text: [
    `the answer was refused — ${reason}`,
    '',
    'Nothing was previewed, and nothing was written.',
  ].join('\n'),
  found: false,
})

/**
 * Puts one round of questions to the user and fills the plan with what comes
 * back, one question at a time.
 *
 * `questionsOf` and `answer` do the work, and neither is reimplemented here:
 * `answer` already returns a NEW plan and already refuses a path that is not a
 * question, so each answer is applied to the plan the last one produced.
 *
 * Exported because it is the one part of the ask loop with a shape worth
 * testing on its own — in particular the refusal, which the loop above cannot
 * produce by itself and a miswiring above it could.
 */
export async function fillAnswers(
  plan: Plan,
  questions: readonly Question[],
  ask: Ask,
): Promise<Filling> {
  let filled = plan
  const answers: Answer[] = []

  for (const [index, question] of questions.entries()) {
    const said = await ask(question)
    // An empty line is a decline, not an empty value. A terminal cannot tell
    // "I do not know either" from a stray Return, and the safe reading of the
    // two is the one that writes nothing.
    if (said === undefined || said.trim() === '') {
      // What is left, never what was already given: nothing here is kept, so
      // the answers collected before the stop go with the run. A re-run asks
      // them again — which is what "nothing was written" costs.
      return { outcome: 'declined', unanswered: questions.slice(index) }
    }

    try {
      filled = answer(filled, question.path, said.trim())
    } catch (error) {
      // `answer` refuses a path that is not a question, which is how a value
      // the engine vouched for would otherwise be overwritten by one nobody
      // did. The list and the plan can only disagree through a miswiring here,
      // and a miswiring must reach the user as a refusal rather than a stack.
      if (error instanceof AnswerError) return { outcome: 'refused', reason: error.message }
      throw error
    }
    answers.push({ path: question.path, value: said.trim() })
  }

  return { outcome: 'answered', plan: filled, answers }
}

/**
 * A clean stop (§6.1, §7.5): the partial plan, the reason, and no file.
 *
 * `found: false` and NOT `unsupported`, and the difference is the whole of what
 * an exit code is for here. `unsupported` means this build understood the
 * request and will not act on it — a boundary the user cannot move by typing
 * anything. A stop is the opposite: the build did act, three times, and the
 * gate refused. That is a negative answer about THIS request, which is what
 * exit 1 says — the same code `plan --from` already returns when one of those
 * gates refuses a plan once.
 *
 * The operations cross as JSON, for `reviewer.ts`'s reason: a formatter of our
 * own would be one field away from hiding the field that mattered, and the
 * field that mattered is why this stopped.
 */
export function renderStopped(
  plan: Plan | undefined,
  gate: Gate | undefined,
  reason: string,
): CommandResult {
  const where = gate === undefined ? 'the plan was refused' : `refused at the ${gate} gate`
  return {
    text: [
      // The Reviewer's own words, and the one place a refusal quotes a model.
      `${where}: ${plain(reason)}`,
      '',
      ...(plan === undefined
        ? ['No draft ever parsed, so there is no partial plan to show.']
        : [
            'the plan as it stood when it was refused, and it was not written:',
            '',
            asJson(plan.operations),
          ]),
      '',
      'Nothing was previewed, and nothing was written. Name the value the gate ' +
        'could not accept and run this again.',
    ].join('\n'),
    found: false,
  }
}

export async function runPlan(options: PlanOptions): Promise<CommandResult> {
  const root = await declarationsRoot('plan', options.repo)
  const snapshot = await readRepository(root)
  const loaded = await loadPlan(options.from)

  const contexts = contextsOf(root, snapshot, graphOf(snapshot))
  const contents = await readContents(root, snapshot)

  /** What the user said when asked. The request grows by it; see `withAnswers`. */
  const answers: Answer[] = []
  let plan = loaded

  // §7.5: the CLI asks. One pass of the whole deterministic sequence per round,
  // because an answer changes the plan and everything downstream of the
  // signature judged the plan as it was — the policies, the bytes, the
  // re-check. Re-running only the signer would show a diff two gates never saw.
  for (let round = 0; ; round += 1) {
    const request = loaded.intent

    // The same derivation the loop runs between gates [1] and [2], and it runs
    // here for the reason this file exists: both roads have to answer "what
    // would this do?" the same way, and a rule that applied only to a drafted
    // plan would make the deterministic entry point a different engine. A
    // right's owner follows from its consumer whoever wrote the plan down.
    const derivation = deriveOwners({ ...plan, intent: request }, contexts.owners)
    const derived = derivation.plan
    // Stated on this road too. The engine overwrites a model's explicit "I do
    // not know" here exactly as it does when drafting, and a rule that is
    // audible on one entry point and silent on the other is two engines.
    for (const one of derivation.derived) {
      options.emit?.({ type: 'derived', path: one.path, owner: one.owner, from: [...one.from] })
    }
    const signed = signPlan(derived, answering(contexts.signature, answers))
    if ('outcome' in signed) {
      // A refusal is not a question: nothing here can be answered, because the
      // value is not undetermined — it is unusable.
      return {
        text: [
          'refused at the signature — the engine signs what it can vouch for:',
          ...signed.refusals.map((refusal) => `  ${refusal.path}: ${refusal.reason}`),
        ].join('\n'),
        found: false,
      }
    }

    const questions = questionsOf(signed.plan)
    if (questions.length === 0 || options.ask === undefined || round >= ASK_LIMITS.maxRounds) {
      return previewPlan(signed, questions, contexts, snapshot, contents, options)
    }

    const filled = await fillAnswers(signed.plan, questions, options.ask)
    if (filled.outcome === 'refused') return renderRefusedAnswer(filled.reason)
    // The same renderer the run would have ended on with nobody there to ask,
    // so a decline and an unattended run say the same sentence.
    if (filled.outcome === 'declined') {
      return previewPlan(signed, filled.unanswered, contexts, snapshot, contents, options)
    }

    // Gate [1], over the plan the user just changed. An answer is a value
    // entering the plan, and the schema is what decides whether a value may be
    // there — without this, `tiger` reaches a diff as an owner reference,
    // because the signature vouches for it (the user said it) and nothing
    // downstream re-parses. `--from` has no Architect to hand the refusal back
    // to, so it is a clean stop naming the field rather than a repair.
    const reparsed = planSchema.safeParse(filled.plan)
    if (!reparsed.success) return renderRefusedAnswer(reasonOf(reparsed.error.issues))

    plan = reparsed.data
    answers.push(...filled.answers)
  }
}

/**
 * The deterministic tail of `plan --from`: the policies, the bytes, the
 * re-check, and the one of four answers this run earned.
 *
 * Split out of `runPlan` so the ask loop can run it more than once. It takes
 * `questions` rather than recomputing them, because a decline reports what is
 * still unanswered and the signed plan holds every question of the round —
 * including the ones the user already answered and this run did not keep.
 */
function previewPlan(
  signed: SignedPlan,
  questions: readonly Question[],
  contexts: Contexts,
  snapshot: RepositorySnapshot,
  contents: ReadonlyMap<string, string>,
  options: { readonly json?: boolean; readonly colour?: boolean },
): CommandResult {
  const policies = checkPolicies(signed, contexts.policy)
  // The edits come first, and the re-check reads them: what CI would say is
  // asked about the very bytes the reviewer is shown, not about a second model
  // of the plan that can disagree with the first.
  const { edits, dropped } = planEdits(signed, contents)
  const recheck = recheckPlan(signed, snapshot, edits)
  const changed = edits.filter((edit) => edit.before !== edit.after)

  const errors = errorsIn(recheck)
  const refused = policies.length > 0 || errors.length > 0

  if (options.json === true) {
    // The same codes as the human path, so a script reads the verdict from the
    // exit status and the detail from stdout, and never has to parse prose.
    return {
      text: asJson(reportOf(signed, questions, policies, recheck, changed, dropped)),
      found: !refused,
      ...(questions.length > 0 ? { unsupported: true } : {}),
    }
  }

  if (questions.length > 0) return renderQuestions(questions)

  if (policies.length > 0) {
    return {
      text: [
        ...policies.flatMap((violation) => [
          `policy  ${violation.policy} at ${violation.path}`,
          `        ${violation.message}`,
        ]),
        '',
        `${plural(policies.length, 'policy violation', 'policy violations')}. ` +
          'No diff: a plan that would be refused is not offered for review.',
      ].join('\n'),
      found: false,
    }
  }

  if (errors.length > 0) {
    return {
      text: [
        ...errors.map(violationLine),
        '',
        `${plural(errors.length, 'violation', 'violations')} in the repository this plan would ` +
          'leave behind. No diff.',
      ].join('\n'),
      found: false,
    }
  }

  return renderPreview({
    signed,
    edits,
    dropped,
    recheck,
    ...(options.colour !== undefined ? { colour: options.colour } : {}),
  })
}

export interface IntentOptions {
  /**
   * The request, in the user's own words, from the caller that read them.
   * Never a paraphrase: the signature measures every proposed value against
   * this string, so rewriting it rewrites what the gate will vouch for.
   */
  readonly intent: string
  /** The declarations repository. A preview is decided against it (§4.4). */
  readonly repo: string
  /** The application repository the Inspector reads (§7.4, step 3). */
  readonly project: string
  readonly client: LlmClient
  readonly emit: EventSink
  readonly json?: boolean
  /** Only a caller that knows it holds a terminal asks for colour. */
  readonly colour?: boolean
  /**
   * How a question reaches a person. Absent means there is nobody to ask, and
   * the run ends on the questions the way it always has — see `PlanOptions.ask`.
   */
  readonly ask?: Ask
}

/**
 * §7.4 steps 3 to 7: Inspector, Architect, the repair loop, the diff.
 *
 * Everything deterministic is reused rather than restated. The two gate
 * contexts are the ones `runPlan` builds, over the same snapshot; the five
 * gates are `repair`'s, in the order §6.1 fixes; the rendering is
 * `renderPreview`'s. What this function contributes is the wiring, and every
 * decision in it is about what must NOT reach where.
 */
export async function runIntent(options: IntentOptions): Promise<CommandResult> {
  const root = await declarationsRoot('plan', options.repo)
  // Read before a single agent runs, and before the project is walked. A
  // committed file that does not parse is not a repository that declared
  // nothing: falling back would answer a typo with a run that silently asks
  // about everything, and charge a model round-trip for it.
  const config = await readConfig(options.project)
  const snapshot = await readRepository(root)
  // Taken on this side of the line: `agents/` reaches no disk, so the bytes are
  // read here and handed over, with every exclusion and cap already applied.
  const project = await readProject(options.project)

  // The Architect's read tools sit on the repository, not on the fixture SI,
  // and `buildTools` owns the witness set they fill — what the ENGINE returned
  // during the draft, never what the model wrote.
  const graph = graphOf(snapshot)
  const tools = buildTools(graph)
  const contexts = contextsOf(root, snapshot, graph, { config, witnessed: tools.witnessed })
  const summary = formatSummary(contexts.summary, contexts.vocabulary)
  // Before the Inspector too: a repository `plan` cannot read whole is refused,
  // and refused before a model round-trip is spent on it.
  const contents = await readContents(root, snapshot)

  const facts = await inspect(options.client, project, options.emit)

  /** What the user said when asked. The request grows by it; see `withAnswers`. */
  const answers: Answer[] = []
  /**
   * The plan the user just filled, which the next run of the gates starts from.
   * Absent on the first round, when there is nothing to start from but a draft.
   */
  let answered: Plan | undefined
  /**
   * Carried across rounds, never restarted with each one.
   *
   * `repair` counts these for its caller — rows its tools cut off, proposals
   * its own schema refused, and the gates each attempt ran — and says in its
   * own comment that a seam is where that signal died once already. An answered
   * run is several calls to it, so this is that seam: reporting only the last
   * round's numbers would say a run that spent nine attempts spent two. The
   * attempt NUMBERS restart per round, because 1 | 2 | 3 is §6.1's count of
   * what the Architect gets per run of the loop and not a count of rounds.
   */
  const spent = { truncated: 0, rejections: 0, attempts: [] as RepairAttempt[] }

  // §7.5: the CLI asks, and then RUNS THE GATES AGAIN. All five of them, over
  // the filled plan — not the signature alone. A question leaves the loop
  // before the Reviewer and before the re-check (§6.1), so those two have never
  // seen the value the user supplied, and showing a diff they did not judge is
  // the one thing this stage may not do. The Reviewer in particular has to see
  // it: its question is "is this what was asked for", and the answer is now
  // part of what was asked.
  for (let round = 0; ; round += 1) {
    const request = options.intent

    // Spent by the first attempt of this round and never again. A filled plan
    // is a proposal that cost no round-trip, so it enters the loop as one; if a
    // gate refuses it, the Architect gets the remaining attempts in the
    // ordinary way, which is exactly what `repair` is for. Cleared before the
    // call so a re-draft cannot hand the same plan back a second time.
    let seeded = answered
    answered = undefined

    const outcome = await repair(
      {
        // The user's words, held here and imposed on every draft. `signPlan`
        // measures provenance against this string, so a drafter that wrote its
        // own intent could name the owner it wanted and have the gate vouch for
        // it (see `RepairInput.intent`). It is passed once, from the caller that
        // read it — and it grows only by what the USER said when asked, never
        // by anything a model wrote (`withAnswers`).
        intent: request,
        draft: (report) => {
          if (seeded !== undefined) {
            const filled = seeded
            seeded = undefined
            return Promise.resolve({ plan: filled, truncated: 0, rejections: 0 })
          }
          return draftPlan(
            options.client,
            tools,
            {
              intent: request,
              facts,
              summary,
              // `draftPlan` concatenates this slot last, after the facts and the
              // summary, which makes it the one place a caller may add to the
              // opening message — and `repair` leaves where the report lands to
              // the caller for exactly that reason.
              //
              // It must never be appended to `intent`. The signature measures
              // every proposed value against that string, so a refusal naming
              // `group:default/tiger` would make that owner `echoed` on the next
              // attempt: the gate that caught the value would then vouch for it.
              vocabulary: report === undefined ? '' : `\n${report}`,
            },
            options.emit,
          )
        },
        // Two arguments, never one. The Reviewer is handed the plan and the
        // ORIGINAL request, and nothing else — not the Architect's reasoning, not
        // which attempt this is, not what an earlier gate said. Both agents are
        // the same weights behind the same provider, so a second opinion fed the
        // first one's transcript is an echo holding a veto (`reviewer.ts`).
        // Spread, so a fact added to `ReviewFacts` reaches the Reviewer
        // without a second edit here — the wiring is the one place where
        // forgetting is silent.
        review: (plan, facts) =>
          reviewPlan(options.client, { plan, intent: request, ...facts }, options.emit),
        signature: answering(contexts.signature, answers),
        policy: contexts.policy,
        // Built off the same graph as `contexts.vocabulary`, which is the whole
        // of what makes a derived owner survive the signature (`deriveOwners`).
        owners: contexts.owners,
        snapshot,
        contents,
      },
      options.emit,
    )

    spent.truncated += outcome.truncated
    spent.rejections += outcome.rejections
    spent.attempts.push(...outcome.attempts)

    if (outcome.outcome !== 'questions') return renderOutcome({ ...outcome, ...spent }, options)
    // Nobody to ask, or out of rounds. Both end on the questions, and they end
    // on the SAME sentence: a bound that produced a different answer from an
    // unattended run would be a third outcome nobody designed.
    if (options.ask === undefined || round >= ASK_LIMITS.maxRounds) {
      return renderOutcome({ ...outcome, ...spent }, options)
    }

    const filled = await fillAnswers(outcome.plan, outcome.questions, options.ask)
    if (filled.outcome === 'refused') return renderRefusedAnswer(filled.reason)
    // The outcome the loop already produced, with the questions narrowed to the
    // ones still open. Reusing it is what keeps a decline rendering — in both
    // `--json` and prose — exactly as an unattended run does.
    if (filled.outcome === 'declined') {
      return renderOutcome({ ...outcome, ...spent, questions: filled.unanswered }, options)
    }

    answers.push(...filled.answers)
    answered = filled.plan
  }
}

/**
 * The three outcomes of §6.1, and the code each earns.
 *
 *   planned    the diff, exit 0 — the same renderer `--from` ends on
 *   questions  the questions, exit 3 — understood, and not acted on
 *   stopped    the partial plan and the reason, exit 1 — see `renderStopped`
 *
 * A `planned` outcome needs no policy list and no question list: `repair`
 * returns it only after both gates passed, so the report carries two empty
 * arrays as the statement that they ran and found nothing.
 */
function renderOutcome(
  outcome: RepairOutcome,
  options: { readonly json?: boolean; readonly colour?: boolean },
): CommandResult {
  if (outcome.outcome === 'planned') {
    const changed = outcome.edits.filter((edit) => edit.before !== edit.after)
    if (options.json === true) {
      return {
        text: asJson({
          outcome: 'planned',
          ...reportOf(outcome.signed, [], [], outcome.recheck, changed, outcome.dropped),
          // Carried out of the loop, never dropped: a plan drafted on a partial
          // view of the catalogue is byte-identical to one drafted on all of
          // it, and this seam is where that signal died once already.
          truncated: outcome.truncated,
          rejections: outcome.rejections,
          attempts: outcome.attempts,
        }),
        found: true,
      }
    }
    return renderPreview({
      signed: outcome.signed,
      edits: outcome.edits,
      dropped: outcome.dropped,
      recheck: outcome.recheck,
      ...(options.colour !== undefined ? { colour: options.colour } : {}),
    })
  }

  if (outcome.outcome === 'questions') {
    return options.json === true
      ? {
          text: asJson({
            outcome: 'questions',
            plan: outcome.plan,
            questions: outcome.questions,
          }),
          found: false,
          unsupported: true,
        }
      : renderQuestions(outcome.questions)
  }

  return options.json === true
    ? {
        text: asJson({
          outcome: 'stopped',
          gate: outcome.gate ?? null,
          reason: outcome.reason,
          plan: outcome.plan ?? null,
          attempts: outcome.attempts,
        }),
        found: false,
      }
    : renderStopped(outcome.plan, outcome.gate, outcome.reason)
}
