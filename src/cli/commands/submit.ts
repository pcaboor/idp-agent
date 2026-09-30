import type { Cleared, ClearRefusal, Expectation, Repository } from '../../core/plan/clear.js'
import { openLocalForge } from '../../forge/local/forge.js'
import type { Base, ForgeProvider, Submitted } from '../../forge/provider.js'
import { baseOf, closingLines, type PreviewStatus } from '../render/footer.js'
import { inertLine } from '../render/plain.js'
import type { CommandResult } from './result.js'

/**
 * `--submit`: a previewed plan becomes one new branch, cut from `HEAD`, for
 * review (ADR-0010). Everything a run decides about that lives here, in the
 * order it happens — open the forge before anything is read, refuse a
 * repository whose working tree is not `HEAD` before anything is previewed,
 * then clear, recognise a branch already there, confirm and submit — so both
 * roads of `plan`, and `init` after them, take the same steps rather than
 * three copies of them.
 *
 * Nothing here authorises anything. The branch is a request; the merge, which
 * nobody can perform from this terminal, is what authorises it (§4.2).
 */

/**
 * What a person is asked to submit, as data (D5): a terminal prints `preview`
 * and asks; stage 7's TUI can lay out the files and the branch itself without
 * parsing the text. Nothing in it authorises anything — it is a request.
 */
export interface SubmissionSummary {
  /** The repository the branch is cut in, as `declarationsFor` resolved it (D19). */
  readonly root: string
  readonly repository: Repository
  readonly branch: string
  readonly base: Base
  readonly files: readonly { readonly path: string; readonly change: 'create' | 'amend' }[]
  /** The preview as printed, `not yet submitted` tail included. */
  readonly preview: string
}

/**
 * The person at the keyboard: shown the diff, asked one question. A function
 * for the reason `Ask` is one — the interactive path is then driven from a
 * test with no terminal. `cli/index.ts` owns the only implementation that
 * touches a keyboard.
 */
export type Confirm = (summary: SubmissionSummary) => Promise<boolean>

export interface SubmitOptions {
  /**
   * Absent: `--submit` was the whole confirmation — a script, a pipe, `--json`.
   * That is safe because the confirmation was never the guard: the merge is,
   * and nobody can perform it from this terminal (§4.2).
   */
  readonly confirm?: Confirm
  /**
   * Injected so a test can hand in a forge that fails where it chooses — and
   * so `main` can hand `plan "<intent>"` the forge it opened before the model
   * was configured, rather than open a second one.
   */
  readonly open?: (root: string, repository: Repository) => Promise<ForgeProvider>
}

export interface Opened {
  readonly root: string
  readonly forge: ForgeProvider
  readonly base: Base
}

/**
 * Before anything is read and before any model is paid: a repository that
 * cannot take a branch — not a clone's root, no git, no committer identity, a
 * detached or unborn `HEAD` — is refused now, as an argument (exit 2), by
 * `ForgeInputError`.
 */
export async function openForSubmission(
  root: string,
  repository: Repository,
  options: SubmitOptions,
): Promise<Opened> {
  const forge = await (options.open ?? openLocalForge)(root, repository)
  return { root, forge, base: await forge.base() }
}

/**
 * A forge already opened, handed on as the `open` a later `openForSubmission`
 * calls — for the repository it was opened on and no other. `main` opens the
 * intent road's forge before the model is configured, and `runIntent` resolves
 * its root on its own: were the two ever to disagree, the confirmation would
 * name one directory while the branch was cut in another, so a mismatch is an
 * error, never a forge quietly reused.
 */
export const reopening =
  (forge: ForgeProvider, root: string, repository: Repository) =>
  (asked: string, which: Repository): Promise<ForgeProvider> =>
    asked === root && which === repository
      ? Promise.resolve(forge)
      : Promise.reject(new Error('a forge opened for one repository was asked for another repository'))

/**
 * A reason that quotes the repository — a path, a branch — or a value a file
 * or a model wrote: one line each, every control and bidi character spelled
 * out, never cut. The forge's divergence is several lines, and each is kept.
 */
const cleaned = (reasons: readonly string[]): string[] =>
  reasons.flatMap((reason) =>
    reason
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => inertLine(line.trim(), Number.POSITIVE_INFINITY)),
  )

/**
 * The gates are about to judge the working tree, and the branch will be cut
 * from `HEAD`. If those differ, stop BEFORE the preview — and on the intent
 * road before a model is paid for — rather than show a diff that cannot be
 * submitted.
 *
 * With `json`, the refusal is the report, and the report is only its
 * `submission` key: nothing was judged, so there is nothing else to say, and a
 * script that asked for JSON never has to parse prose (D11).
 */
export async function refuseDivergence(
  opened: Opened,
  expected: Expectation,
  options: { readonly json?: boolean } = {},
): Promise<CommandResult | undefined> {
  const divergent = await opened.forge.diverges(opened.base, expected)
  if (divergent.length === 0) return undefined
  if (options.json === true) {
    const submission: SubmissionReport = { outcome: 'refused', reasons: divergent }
    return { text: JSON.stringify({ submission }, null, 2), found: false }
  }
  return {
    text: [
      `not submitted — the repository is not what ${baseOf(opened.base).at} holds:`,
      // A path is a repository's own, and may hold what a terminal obeys.
      ...cleaned(divergent).map((line) => `  ${line}`),
      '',
      'Commit or set those changes aside, and run this again. Nothing was previewed, and nothing was written.',
    ].join('\n'),
    found: false,
  }
}

/**
 * What `--json` reports under `submission` (D11). Its shape is pinned by a
 * test in `plan-command.test.ts`; versioning the report is cli-ux-10's.
 */
export type SubmissionReport =
  | {
      readonly outcome: 'created' | 'already-submitted'
      readonly branch: string
      readonly commit: string
      readonly base: Base
    }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'declined'; readonly branch: string }
  | { readonly outcome: 'refused'; readonly reasons: readonly string[] }

/**
 * Clear, recognise, confirm, submit — in that order, and each one can end the
 * run.
 *
 * `render` is the preview renderer with everything bound but its status, so
 * the diff a person confirms is the diff the preview printed; a second
 * renderer here would be a second answer to "what would this do?".
 *
 * The caller hands over only a diff that changes something: a plan that
 * changes nothing is the same answer with or without `--submit` — #83's
 * exit 3 included — and never reaches a forge.
 */
export async function submit(input: {
  readonly opened: Opened
  readonly cleared: Cleared | ClearRefusal
  readonly render: (status: PreviewStatus) => CommandResult
  readonly confirm?: Confirm
}): Promise<{ readonly result: CommandResult; readonly report: SubmissionReport }> {
  const { opened, cleared, render, confirm } = input

  if ('outcome' in cleared) {
    // No prompt was shown: the diff is printed here, with why it goes no further.
    const status: PreviewStatus = { kind: 'refused', reasons: cleaned(cleared.reasons) }
    return {
      report: { outcome: 'refused', reasons: cleared.reasons },
      result: { text: render(status).text, found: false },
    }
  }

  const changed = cleared.edits.length
  // With a prompt, the diff was already printed by it; the result is the
  // closing lines only, or the person reads the diff twice. A run the forge
  // answers before the prompt prints the same lines as one it answers after:
  // what the prompt would have shown is not printed in its place.
  const said = (status: PreviewStatus): string =>
    confirm === undefined ? render(status).text : closingLines(status, changed).join('\n')

  // Before anyone is asked: a branch that is already there is either this
  // very submission — nothing to confirm, and nothing to write — or somebody
  // else's, which no answer at the prompt could make ours. The forge only
  // reads to say so; `submit` below looks again at the moment of writing,
  // for a branch created while the person read the diff.
  const known = await opened.forge.recognise(cleared, opened.base)
  if (known !== undefined) return outcomeOf(known, opened.base, said)

  if (confirm !== undefined) {
    const yes = await confirm({
      root: opened.root,
      repository: cleared.repository,
      branch: cleared.branch,
      base: opened.base,
      files: cleared.edits.map((edit) => ({
        path: edit.path,
        change: edit.before === undefined ? 'create' : 'amend',
      })),
      preview: render({ kind: 'pending', branch: cleared.branch }).text,
    })
    if (!yes) {
      return {
        report: { outcome: 'declined', branch: cleared.branch },
        result: { text: said({ kind: 'declined' }), found: true },
      }
    }
  }

  return outcomeOf(await opened.forge.submit(cleared, opened.base), opened.base, said)
}

/**
 * What the forge said, as the run's result and its `--json` key — the same
 * words whether it said them before the prompt or at the moment of writing.
 */
function outcomeOf(
  submitted: Submitted,
  base: Base,
  said: (status: PreviewStatus) => string,
): { readonly result: CommandResult; readonly report: SubmissionReport } {
  switch (submitted.outcome) {
    case 'created':
    case 'already-submitted': {
      const status: PreviewStatus = {
        kind: 'submitted',
        again: submitted.outcome === 'already-submitted',
        branch: submitted.branch,
        base,
      }
      return {
        report: { ...submitted, base },
        result: { text: said(status), found: true },
      }
    }
    case 'unchanged':
      return { report: submitted, result: { text: said({ kind: 'preview' }), found: true } }
    case 'refused': {
      // The forge's words quote refs and paths of the repository: cleaned.
      const status: PreviewStatus = { kind: 'refused', reasons: cleaned([submitted.reason]) }
      return {
        report: { outcome: 'refused', reasons: [submitted.reason] },
        result: { text: said(status), found: false },
      }
    }
    case 'pushed-without-pull-request':
    case 'closed':
      // Only the GitHub forge answers these, and no road opens it before
      // stage 6 plan's 6.2.2, which replaces both cases.
      throw new Error(`the local forge never answers ${submitted.outcome}`)
    default: {
      const _exhaustive: never = submitted
      return _exhaustive
    }
  }
}
