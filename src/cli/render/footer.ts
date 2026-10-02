import type { MergeNote, ProtectionVerdict } from '../../core/github/protection.js'
import type { Base, LocalRoad, PullRequest, Road } from '../../forge/provider.js'
import { inertLine } from './plain.js'

/** The one line every run that produced a diff ends on (design §7.4). */
export const CLOSING = 'Nothing is provisioned yet. The merge is what authorises it.'

/**
 * What became of a diff. `preview` is stage 4's sentence, unchanged; the rest
 * exist only with `--submit`, and none of them says "applied" — a submission
 * is a request (§4.2).
 *
 * `submitted` names the road it took: a local road says why nothing was
 * pushed, and GitHub's road carries the pull request. A refusal after the
 * local branch was cut says it was `kept`; a branch on GitHub whose pull
 * request was not opened, and a pull request closed, are the GitHub road's
 * own ends.
 *
 * Imports a forge's shapes as types only: the rule "only cli/ reaches forge/ at
 * runtime" would allow more here, and nothing here needs it.
 */
export type PreviewStatus =
  | { readonly kind: 'preview' }
  | { readonly kind: 'pending'; readonly branch: string }
  | { readonly kind: 'declined' }
  | { readonly kind: 'refused'; readonly reasons: readonly string[]; readonly kept?: string }
  | {
      readonly kind: 'submitted'
      readonly again: boolean
      readonly branch: string
      readonly base: Base
      readonly road: Road
      readonly pullRequest?: PullRequest
      /** The older base our commit sits on, which GitHub may still merge (stage 6 brief § 14). */
      readonly olderBase?: string
      /** The contexts merging waits for, as the rules read before the pull request require them. */
      readonly statusChecks?: readonly string[]
      /**
       * The note the rules read just before the pull request called for: where
       * it is `author-may-merge`, merging waits for no approval, and the lines
       * do not promise one.
       */
      readonly note?: MergeNote
    }
  /** `repository` as printed, `github.com/acme/iac`; `reason` the forge's, cleaned. */
  | { readonly kind: 'pushed-without-pull-request'; readonly branch: string; readonly repository: string; readonly reason: string }
  /** `base`: the branch on GitHub a merged pull request went into, which no longer carries it. */
  | {
      readonly kind: 'closed'
      readonly branch: string
      readonly number: number
      readonly merged: boolean
      readonly at: string
      readonly base: string
    }
  /** `init`'s preview ends on its `apply` sentence instead of `CLOSING`: the tail it says in place of it. */
  | { readonly kind: 'applied-by-hand'; readonly apply: string }

const short = (commit: string): string => commit.slice(0, 7)

/** One value of the repository or of GitHub, on one line, whatever it holds. */
const one = (value: string): string => inertLine(value, Number.POSITIVE_INFINITY)

/**
 * Why a local road pushed nothing, in place of stage 5's "this build has no
 * forge". `--local` says what this run did and nothing about GitHub: it reads
 * nothing there, and an earlier run without it may have pushed the same
 * branch, so "nothing pushed by this run" is true either way.
 */
export function localRoadLine(road: LocalRoad): string {
  switch (road.why) {
    case 'no-upstream':
      return `${one(road.branch)} tracks no remote: nothing pushed`
    case 'other-host':
      return `the remote is on ${one(road.host)}, where this build opens no pull request: nothing pushed`
    case 'asked':
      return '--local: nothing pushed by this run'
    default: {
      const _exhaustive: never = road
      return _exhaustive
    }
  }
}

/**
 * The pull request, at the URL the engine built (`pullRequestUrl`, never
 * GitHub's `html_url`), and what merging it waits for: one approval of its
 * latest commit by someone else, and the status checks the rules require —
 * or that none is, so nothing downstream could refuse it (ADR-0012). Where
 * the note is `author-may-merge`, the rules ask for no such approval (the
 * owner's decision of 2026-10-01), and only the status checks are said.
 */
export function pullRequestLines(
  pullRequest: PullRequest,
  verdict: Pick<ProtectionVerdict['reported'], 'statusChecks'> & { readonly note?: MergeNote },
): string[] {
  const where = `github.com/${one(pullRequest.repository)}`
  const number = `#${String(pullRequest.number)}`
  const alone = verdict.note === 'author-may-merge'
  const none = 'No status check is required, so a system downstream could not refuse it (ADR-0012).'
  const checks = verdict.statusChecks.map(one).join(', ')
  const waits = 'Merging it waits for one approval of its latest commit from someone other than you'
  return [
    pullRequest.state === 'opened'
      ? `Pull request ${number} opened on ${where}: ${pullRequest.url}`
      : `Pull request ${number} is open on ${where}: ${pullRequest.url}`,
    verdict.statusChecks.length === 0
      ? alone
        ? none
        : `${waits}. ${none}`
      : alone
        ? `Merging it waits for the status checks ${checks}.`
        : `${waits}, and for the status checks ${checks}.`,
  ]
}

/**
 * The base as a person reads it: `main@abc1234`. Its branch is the
 * repository's own — after a clone, whatever the remote named its default —
 * and git takes a bidi control in a ref name, so it is printed through
 * `inertLine`: this is the line that says which base a request sits on. The
 * `--json` report carries the name as it is.
 */
export const baseOf = (base: Base): { readonly at: string; readonly branch: string } => {
  const branch = inertLine(base.branch, Number.POSITIVE_INFINITY)
  return { at: `${branch}@${short(base.commit)}`, branch }
}

/**
 * The last lines of a run that produced a diff: the count, what was done with
 * it, and §7.4's sentence. A diff printed by a confirmation prompt is not
 * printed again, and these lines are then the whole of the result.
 */
export function closingLines(status: PreviewStatus, changed: number): string[] {
  const files = `${String(changed)} ${changed === 1 ? 'file' : 'files'}`
  switch (status.kind) {
    case 'preview':
      return [`${files} · nothing written`, CLOSING]
    case 'applied-by-hand':
      return [`${files} · nothing written`, status.apply]
    case 'pending':
      return [`${files} · not yet submitted — it would become ${status.branch}`, CLOSING]
    case 'declined':
      return [`${files} · not submitted · nothing written`, CLOSING]
    case 'refused':
      return [
        `${files} · not submitted:`,
        ...status.reasons.map((reason) => `  ${reason}`),
        status.kept === undefined
          ? 'Nothing was written.'
          : `${status.kept} was cut in this clone, and no pull request was opened.`,
        CLOSING,
      ]
    case 'submitted':
      return [...submittedLines(status, files), CLOSING]
    case 'pushed-without-pull-request':
      return [`${files} · ${status.branch} is on ${status.repository}, and ${status.reason}`, CLOSING]
    case 'closed':
      return status.merged
        ? [
            `${files} · not submitted — ${status.branch} was merged as pull request #${String(status.number)}, and ` +
              `${status.base} no longer carries it · nothing written`,
            "A reverted change is a reviewer's decision, which this tool does not re-request.",
            CLOSING,
          ]
        : [
            `${files} · not submitted — ${status.branch} was submitted as pull request #${String(status.number)} and ` +
              `closed on ${status.at} · nothing written`,
            'A closed request is not reopened by this tool: reopen it on GitHub, or change the request.',
            CLOSING,
          ]
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

/**
 * A submission's lines before `CLOSING`: the branch and its base, then, on a
 * local road, why nothing was pushed, and on GitHub's, the pull request. A
 * GitHub road always ends on a pull request; a status without one is a
 * programming error, never a line.
 */
function submittedLines(status: Extract<PreviewStatus, { readonly kind: 'submitted' }>, files: string): string[] {
  const base = baseOf(status.base)
  const { road, pullRequest, olderBase } = status
  if (road.kind === 'local') {
    return [
      status.again
        ? `${files} · already submitted as ${status.branch} · nothing written`
        : `${files} · submitted as ${status.branch} on top of ${base.at} · ${base.branch} untouched`,
      localRoadLine(road),
    ]
  }
  if (pullRequest === undefined) throw new Error('a submission on GitHub ended without a pull request')
  const older = olderBase === undefined ? undefined : `${base.branch}@${short(olderBase)}`
  const now = short(status.base.commit)
  if (status.again) {
    const open = `pull request #${String(pullRequest.number)} is open`
    return [
      older === undefined
        ? `${files} · already submitted as ${status.branch} · ${open} · nothing written`
        : `${files} · already submitted as ${status.branch} · ${open}, on ${older}; ${base.branch} is now ${now}, ` +
          'and GitHub shows whether it still merges cleanly · nothing written',
    ]
  }
  return [
    older === undefined
      ? `${files} · submitted as ${status.branch} on top of ${base.at} · ${base.branch} untouched`
      : `${files} · submitted as ${status.branch} on top of ${older}, an older ${base.branch} (now ${now}; GitHub ` +
        `shows whether it still merges cleanly) · ${base.branch} untouched`,
    ...pullRequestLines(pullRequest, {
      statusChecks: status.statusChecks ?? [],
      ...(status.note === undefined ? {} : { note: status.note }),
    }),
  ]
}
