import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { draftPlan } from '../../agents/architect.js'
import type { EventSink } from '../../agents/events.js'
import { inspect } from '../../agents/inspector.js'
import { repair, type Gate, type RepairOutcome } from '../../agents/repair.js'
import { reviewPlan } from '../../agents/reviewer.js'
import { formatSummary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import { EntityGraph, refOf } from '../../context/graph/entity-graph.js'
import { summariseGraph, type SiSummary } from '../../context/graph/summary.js'
import { readRepository } from '../../context/iac-fs/snapshot.js'
import { readProject } from '../../context/project-fs/snapshot.js'
import { renderUnifiedDiff, type FileEdit } from '../../core/diff/unified.js'
import { questionsOf, type Question } from '../../core/plan/clarify.js'
import { planEdits, type DroppedOperation } from '../../core/plan/edits.js'
import { checkPolicies, type PolicyContext, type PolicyViolation } from '../../core/plan/policies.js'
import { recheckPlan, type Recheck } from '../../core/plan/recheck.js'
import { signPlan, type SignatureContext, type SignedPlan } from '../../core/plan/sign.js'
import { planSchema, type Plan } from '../../core/schemas/plan.js'
import { ENV_ANNOTATION, type Vocabulary } from '../../core/schemas/vocabulary.js'
import type { RepositorySnapshot, Violation } from '../../core/validate/rules.js'
import type { LlmClient } from '../../llm/client.js'
import { readConfig, seededVocabulary, type RepositoryConfig } from '../config.js'
import { paintDiff } from '../render/diff.js'
import type { CommandResult } from './result.js'

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
 * `readRepository` swallows a failed `readdir` and returns an empty snapshot,
 * which is right for a repository holding an empty folder and wrong for a path
 * that is not there: a preview against nothing would look like a clean creation
 * of everything.
 */
async function repositoryRoot(repo: string): Promise<string> {
  const stats = await stat(repo).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new PlanInputError(`${repo} is not a directory; plan needs the declarations repository`)
  }
  return path.resolve(repo)
}

/**
 * The bytes, beside the parse. `RepositorySnapshot` keeps the entities and the
 * provenance and drops the text, and `planEdits` composes against text — it has
 * to, because a reviewer reads an added line and not an AST (§4.3). Reading
 * twice is the price of not making the snapshot carry a second representation
 * of every file.
 */
async function readContents(
  root: string,
  snapshot: RepositorySnapshot,
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    snapshot.files.map(
      async (file) =>
        [file.path, await readFile(path.join(root, ...file.path.split('/')), 'utf8')] as const,
    ),
  )
  return new Map(entries)
}

interface Contexts {
  readonly signature: SignatureContext
  readonly policy: PolicyContext
  /** What both gates measure a value against, `.idp-agent.yml` included. */
  readonly vocabulary: Vocabulary
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
  for (const file of snapshot.files) {
    for (const entity of file.entities) {
      declared.set(refOf(entity), file.path)
      const env = entity.metadata.annotations[ENV_ANNOTATION]
      // Declare, never infer: an entity with no environment contributes none,
      // and cross-environment-consumer stays silent rather than reading one off
      // the name.
      if (env !== undefined) environments.set(refOf(entity), env)
    }
  }

  return {
    vocabulary,
    summary: summarised.summary,
    signature: {
      witnessed: seed.witnessed ?? new Set(declared.keys()),
      vocabulary,
      repoRoot: root,
      declared,
    },
    policy: { vocabulary, witnesses: new Set(snapshot.witnesses), environments },
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
    return {
      text: [
        ...(recheck === undefined ? ['nothing to change.'] : settled(signed, recheck)),
        ...droppedLines(dropped),
        '',
        '0 files · nothing written',
        CLOSING,
      ].join('\n'),
      found: true,
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
    ...questions.flatMap((question) => [`  ${question.path}`, `      ${question.question}`]),
    '',
    'Fill them in and run this again. Nothing was previewed, and nothing was written.',
  ].join('\n'),
  found: false,
  unsupported: true,
})

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
      `${where}: ${reason}`,
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
  const root = await repositoryRoot(options.repo)
  const snapshot = await readRepository(root)
  const plan = await loadPlan(options.from)

  const contexts = contextsOf(root, snapshot, graphOf(snapshot))
  const signed = signPlan(plan, contexts.signature)
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
  const policies = checkPolicies(signed, contexts.policy)
  // The edits come first, and the re-check reads them: what CI would say is
  // asked about the very bytes the reviewer is shown, not about a second model
  // of the plan that can disagree with the first.
  const { edits, dropped } = planEdits(signed, await readContents(root, snapshot))
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
  const root = await repositoryRoot(options.repo)
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

  const facts = await inspect(options.client, project, options.emit)

  const outcome = await repair(
    {
      // The user's words, held here and imposed on every draft. `signPlan`
      // measures provenance against this string, so a drafter that wrote its
      // own intent could name the owner it wanted and have the gate vouch for
      // it (see `RepairInput.intent`). It is passed once, from the caller that
      // read it.
      intent: options.intent,
      draft: (report) =>
        draftPlan(
          options.client,
          tools,
          {
            intent: options.intent,
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
        ),
      // Two arguments, never one. The Reviewer is handed the plan and the
      // ORIGINAL request, and nothing else — not the Architect's reasoning, not
      // which attempt this is, not what an earlier gate said. Both agents are
      // the same weights behind the same provider, so a second opinion fed the
      // first one's transcript is an echo holding a veto (`reviewer.ts`).
      review: (plan) =>
        reviewPlan(options.client, { plan, intent: options.intent }, options.emit),
      signature: contexts.signature,
      policy: contexts.policy,
      snapshot,
      contents: await readContents(root, snapshot),
    },
    options.emit,
  )

  return renderOutcome(outcome, options)
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
