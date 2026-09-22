import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { EntityGraph, refOf } from '../../context/graph/entity-graph.js'
import { summariseGraph } from '../../context/graph/summary.js'
import { readRepository } from '../../context/iac-fs/snapshot.js'
import { renderUnifiedDiff, type FileEdit } from '../../core/diff/unified.js'
import { questionsOf, type Question } from '../../core/plan/clarify.js'
import { planEdits, type DroppedOperation } from '../../core/plan/edits.js'
import { checkPolicies, type PolicyContext, type PolicyViolation } from '../../core/plan/policies.js'
import { recheckPlan, type Recheck } from '../../core/plan/recheck.js'
import { signPlan, type SignatureContext, type SignedPlan } from '../../core/plan/sign.js'
import type { Entity } from '../../core/schemas/entity.js'
import { planSchema, type Plan } from '../../core/schemas/plan.js'
import { ENV_ANNOTATION } from '../../core/schemas/vocabulary.js'
import type { RepositorySnapshot, Violation } from '../../core/validate/rules.js'
import { paintDiff } from '../render/diff.js'
import type { CommandResult } from './result.js'

/**
 * Steps 5 to 7 of §7.4, wired end to end and stopping one step short of the
 * branch and the merge request.
 *
 * The Plan is read from a file rather than drafted, so no model is involved and
 * none can be: the agents that produce one arrive with 4b, and this entry point
 * survives them as the deterministic way to ask "what would this do?".
 * Everything it calls is tested on its own — the signature, the three policies,
 * the re-check, the edits, the diff. What lives here is the order they run in,
 * and what each outcome costs.
 *
 * It reads two things and writes none. Nothing below opens a file for writing,
 * and `tests/unit/plan-command.test.ts` hashes every path and every byte of the
 * repository either side of a full preview rather than taking that on trust.
 *
 * No injected reader, unlike `runValidate`: the guarantee this command owes is
 * about a real directory on a real disk, and a fake file system is precisely
 * what would let it pass while being false.
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
}

/**
 * Both gates read the same repository, so they are built together and the
 * vocabulary is derived once. `summariseGraph` is the builder the Supervisor's
 * summary already uses; a second one here would be a second answer to "what
 * values does this catalogue use".
 *
 * What the engine can vouch for here is not what it vouches for after
 * `propose()`: there is no tool transcript, because there was no tool. It is
 * the set of references the repository itself declares — read off disk, which
 * is stronger provenance than a witness set a model's own call produced, and
 * the honest one for a plan that arrived in a file.
 */
function contextsOf(root: string, snapshot: RepositorySnapshot): Contexts {
  const entities: Entity[] = snapshot.files.flatMap((file) => [...file.entities])
  const { vocabulary } = summariseGraph(EntityGraph.from(entities))

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
    signature: { witnessed: new Set(declared.keys()), vocabulary, repoRoot: root, declared },
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

/** The JSON a machine reads: the signed plan, and everything that judged it. */
const report = (
  signed: SignedPlan,
  questions: readonly Question[],
  policies: readonly PolicyViolation[],
  recheck: Recheck,
  changed: readonly FileEdit[],
  dropped: readonly DroppedOperation[],
): string =>
  JSON.stringify(
    {
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
      // An operation that produced no bytes is stated, never omitted: "this
      // plan grants nothing" and "nothing to change" are the same sentence
      // for opposite facts, and a machine must be able to tell them apart.
      dropped,
    },
    null,
    2,
  )

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

export async function runPlan(options: PlanOptions): Promise<CommandResult> {
  const root = await repositoryRoot(options.repo)
  const snapshot = await readRepository(root)
  const plan = await loadPlan(options.from)

  const contexts = contextsOf(root, snapshot)
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
  const diff = renderUnifiedDiff(edits)

  const errors = errorsIn(recheck)
  const refused = policies.length > 0 || errors.length > 0

  if (options.json === true) {
    // The same codes as the human path, so a script reads the verdict from the
    // exit status and the detail from stdout, and never has to parse prose.
    return {
      text: report(signed, questions, policies, recheck, changed, dropped),
      found: !refused,
      ...(questions.length > 0 ? { unsupported: true } : {}),
    }
  }

  if (questions.length > 0) {
    // Exit 3: understood, and this build will not act on it. No diff — a
    // preview of the half that is determined would read like a plan that is
    // ready, and it is not.
    return {
      text: [
        `${plural(questions.length, 'question', 'questions')}, asked rather than guessed:`,
        '',
        ...questions.flatMap((question) => [`  ${question.path}`, `      ${question.question}`]),
        '',
        'Fill them in and run this again. Nothing was previewed, and nothing was written.',
      ].join('\n'),
      found: false,
      unsupported: true,
    }
  }

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

  if (diff === '') {
    return {
      text: [
        ...settled(signed, recheck),
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
  const warnings = recheck.violations.filter((violation) => violation.severity === 'warning')

  return {
    text: [
      ...warnings.map(violationLine),
      ...droppedLines(dropped),
      ...(warnings.length > 0 || dropped.length > 0 ? [''] : []),
      paintDiff(diff, options.colour === true).trimEnd(),
      '',
      `${plural(changed.length, 'file', 'files')} · nothing written`,
      CLOSING,
    ].join('\n'),
    found: true,
  }
}
