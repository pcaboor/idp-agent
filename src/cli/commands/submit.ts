import type { PullRequestInput } from '../../core/github/pull-request.js'
import { locatorRepository, printedRepository, sameRepository } from '../../core/github/remote.js'
import type { Cleared, ClearRefusal, Expectation, Repository } from '../../core/plan/clear.js'
import { CONFIG_FILE, type RepositoryConfig } from '../../core/schemas/config.js'
import type { GitHubApi } from '../../forge/github/api.js'
import { preflight } from '../../forge/github/preflight.js'
import { openSubmissionForge, type OpenedForge } from '../../forge/open.js'
import type { Base, ForgeProvider, GhIdentity, GitHubRoad, PullRequest, Road, Submitted } from '../../forge/provider.js'
import type { GhProcess } from '../../process/gh.js'
import type { Attributes } from '../../trace/model.js'
import { baseOf, closingLines, type PreviewStatus } from '../render/footer.js'
import { inert, inertLine } from '../render/plain.js'
import { renderUnprotected } from '../render/protection.js'
import type { CommandResult } from './result.js'

/**
 * `--submit`: a previewed plan becomes one new branch, cut from `HEAD`, for
 * review (ADR-0010) — and, where the checked-out branch tracks one on
 * github.com, that branch pushed with the person's git and one pull request
 * opened with their gh (stage 6 brief § 3). Everything a run decides about
 * that lives here, in the order it happens — open the forge before anything
 * is read, refuse a repository whose working tree is not `HEAD`, or a base on
 * GitHub the rules do not protect, before anything is previewed, then clear,
 * recognise a submission already made, confirm and submit — so both roads of
 * `plan`, and `init` after them, take the same steps rather than three copies
 * of them.
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
  /**
   * On GitHub's road: where the branch is pushed and the pull request opened,
   * and whether an earlier run pushed the branch already, so only the pull
   * request is left to ask about. Absent on a local road.
   */
  readonly github?: {
    readonly host: 'github.com'
    /** `acme/iac`: the host is its own field. */
    readonly repository: string
    readonly base: string
    readonly pushedAlready: boolean
  }
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
   * so `main` can hand `plan "<intent>"` and `init` the forge it opened before
   * the model was configured, rather than open a second one.
   */
  readonly open?: (root: string, repository: Repository) => Promise<OpenedForge>
  /** `--local`: stage 5's branch, on purpose — nothing is read on GitHub and nothing is pushed. */
  readonly local?: boolean
  /** The person's environment, handed to every git and gh the submission starts; `process.env` when absent. */
  readonly env?: NodeJS.ProcessEnv
  /** The gh a test hands in (`MainDeps.gh`); the person's own otherwise. */
  readonly gh?: GhProcess
  /** Where the line naming the GitHub road goes: stderr, from `cli/index.ts`. */
  readonly notice?: (line: string) => void
}

export interface Opened {
  readonly root: string
  readonly forge: ForgeProvider
  readonly base: Base
  readonly road: Road
  /** On GitHub's road: who gh is, and GitHub through it. */
  readonly github?: { readonly identity: GhIdentity; readonly api: GitHubApi }
}

/** One value of the repository or of GitHub, on one line, whatever it holds. */
const one = (value: string): string => inertLine(value, Number.POSITIVE_INFINITY)

/** How many gh calls the run has made through this forge: 0 on a local road. */
const callsOf = (opened: Opened): number => opened.github?.api.calls() ?? 0

/**
 * A refusal before anything was previewed, in prose or as `--json`'s
 * `submission` key alone, carrying where the submission would have gone for a
 * traced run's root (stage 6 brief § 12). The attributes are computed here,
 * when the result is returned, so the gh calls counted are every call made.
 * The reasons quote a path, a branch or a file's `iacRepo`: `JSON.stringify`
 * escapes a control character and not a bidi one, so each passes `inert`,
 * as the prose does, its lines and their indentation kept.
 */
const refusedBefore = (
  opened: Opened,
  text: string,
  reasons: readonly string[],
  options: { readonly json?: boolean },
): CommandResult => {
  const submission: SubmissionReport = { outcome: 'refused', reasons: reasons.map(inert) }
  const attributes = forgeAttributes(submission, opened.road, callsOf(opened))
  return options.json === true
    ? { text: JSON.stringify({ submission }, null, 2), found: false, attributes }
    : { text, found: false, attributes }
}

/** The line that says, before the diff, where a submission goes and as whom. No role: the preflight reads it, after. */
const submittingLine = (road: GitHubRoad, identity: GhIdentity): string =>
  `submitting to ${printedRepository(road.repository)}, into ${one(road.base)} (${one(road.remote)}, ` +
  `${one(road.branch)}'s upstream), as ${one(identity.login)} (gh)`

/**
 * Before anything is read and before any model is paid: a repository that
 * cannot take a branch — not a clone's root, no git, no committer identity, a
 * detached or unborn `HEAD` — is refused now, as an argument (exit 2), by
 * `ForgeInputError`; and so, on GitHub's road, are a clone configured to
 * redirect the push and a gh that is missing, logged out, too old or not a
 * person (stage 6 brief § 7, § 9). On that road the line naming it is said
 * once, by the run that opened the forge.
 */
export async function openForSubmission(
  root: string,
  repository: Repository,
  options: SubmitOptions & { readonly route: PullRequestInput['road'] },
): Promise<Opened> {
  const opened =
    options.open !== undefined
      ? await options.open(root, repository)
      : await openSubmissionForge({
          repo: root,
          repository,
          env: options.env ?? process.env,
          ...(options.gh === undefined ? {} : { gh: options.gh }),
          local: options.local === true,
          route: options.route,
        })
  const base = await opened.forge.base()
  if (options.open === undefined && opened.road.kind === 'github' && opened.github !== undefined) {
    options.notice?.(submittingLine(opened.road, opened.github.identity))
  }
  return {
    root,
    forge: opened.forge,
    base,
    road: opened.road,
    ...(opened.github === undefined ? {} : { github: opened.github }),
  }
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
  (opened: OpenedForge, root: string, repository: Repository) =>
  (asked: string, which: Repository): Promise<OpenedForge> =>
    asked === root && which === repository
      ? Promise.resolve({
          forge: opened.forge,
          road: opened.road,
          ...(opened.github === undefined ? {} : { github: opened.github }),
        })
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
  const text = [
    `not submitted — the repository is not what ${baseOf(opened.base).at} holds:`,
    // A path is a repository's own, and may hold what a terminal obeys.
    ...cleaned(divergent).map((line) => `  ${line}`),
    '',
    'Commit or set those changes aside, and run this again. Nothing was previewed, and nothing was written.',
  ].join('\n')
  return refusedBefore(opened, text, divergent, options)
}

/**
 * § 13: `iacRepo` is a cross-check, never a source. On a GitHub road, a service whose
 * `.idp-agent.yml` names another repository than the one this clone would open the pull
 * request on is refused, exit 1, naming both. No file, no road to GitHub: nothing to hold.
 *
 * A locator that names no repository on github.com is refused too, rather
 * than passed over: a service that says its declarations live elsewhere is
 * pointed at the wrong clone whatever the host. The locator is quoted, which
 * is safe — the schema refused userinfo, a query and a fragment — through
 * `inertLine`, like the paths and the branch: each is a file's or a clone's.
 * Synchronous, and before anything more is read of either repository or of
 * GitHub: `main` has asked gh only its version and who it is.
 */
export function refuseOtherRepository(
  opened: Opened,
  config: RepositoryConfig | undefined,
  project: string,
  options: { readonly json?: boolean } = {},
): CommandResult | undefined {
  const { road } = opened
  if (config === undefined || road.kind !== 'github') return undefined
  const named = locatorRepository(config.iacRepo)
  // Compared as GitHub resolves a repository, owner and name in any case (6.1.2).
  if (named !== undefined && sameRepository(named, road.repository)) return undefined
  const reason =
    `${CONFIG_FILE} in ${project} names ${config.iacRepo} as this service's declarations repository, ` +
    `and ${opened.root}'s ${road.branch} tracks ${printedRepository(road.repository)}`
  return refusedBefore(
    opened,
    `not submitted — ${one(reason)}: run this with --repo naming a clone of the repository it names, ` +
      'or change iacRepo in a reviewed change. Nothing was written.',
    [reason],
    options,
  )
}

/**
 * On GitHub's road, after the divergence and before the preview: whether the
 * base's rules keep a pull request from merging until someone other than its
 * opener approves its latest commit, and whether GitHub's base is the commit
 * this clone's is (stage 6 brief § 8). Either answered no is the
 * repository's state, a negative answer (exit 1), with the ruleset to add or
 * the commits to bring level; nothing was previewed, nothing written, and no
 * question asked. The rules are judged first, so a base that fails both is
 * told about its ruleset. A local road reads nothing here.
 *
 * With `json`, the refusal is the report, as `refuseDivergence`'s is. With
 * `offerLocal`, `init --submit`'s, the refusal on the rules names `--local`
 * (decision 17).
 */
export async function refuseUnprotected(
  opened: Opened,
  options: { readonly json?: boolean; readonly offerLocal?: boolean } = {},
): Promise<CommandResult | undefined> {
  const { road, github } = opened
  if (road.kind !== 'github') return undefined
  if (github === undefined) throw new Error('a GitHub road opened without gh')
  // Judged once per forge and base: a road that reads the preflight early
  // (the phrase's, 6.3.3) is not read again by `runIntent`, and the run stays
  // within `GITHUB_LIMITS.ghCalls`. A refusal ends the run, so only a pass is
  // ever read back; a base that moved in between is judged again. Step 8's
  // and step 11's reads are the forge's own, and never kept.
  const kept = judged.get(opened.forge)
  if (kept !== undefined && kept.commit === opened.base.commit) return kept.verdict
  const verdict = unprotected(opened, road, github, options)
  judged.set(opened.forge, { commit: opened.base.commit, verdict })
  return verdict
}

/** The verdict `refuseUnprotected` reached for a forge, and the base commit it judged. */
const judged = new WeakMap<ForgeProvider, { readonly commit: string; readonly verdict: Promise<CommandResult | undefined> }>()

/** `refuseUnprotected`'s judgement, read from GitHub. */
async function unprotected(
  opened: Opened,
  road: GitHubRoad,
  github: NonNullable<Opened['github']>,
  options: { readonly json?: boolean; readonly offerLocal?: boolean },
): Promise<CommandResult | undefined> {
  const { verdict, level } = await preflight(github.api, road, opened.base)
  let text: string
  let reasons: string[]
  if (!verdict.holds) {
    text = renderUnprotected(verdict, road, { offerLocal: options.offerLocal === true })
    const lines = text.split('\n')
    reasons = [lines[0] ?? '', ...lines.filter((line) => line.startsWith('  missing: '))]
  } else if (level !== 'level') {
    text =
      `not submitted — ${printedRepository(road.repository)}'s ${one(road.base)} is at ${level.github.slice(0, 7)} and ` +
      `this clone's ${one(opened.base.branch)} is at ${opened.base.commit.slice(0, 7)}: bring them level (git pull), ` +
      'then run this again. If you submitted this change before, the next run names its pull request. ' +
      'Nothing was written.'
    reasons = [text]
  } else {
    return undefined
  }
  return refusedBefore(opened, text, reasons, options)
}

/**
 * What `--json` reports under `submission` (D11). Its shape is pinned by tests
 * in `plan-command.test.ts` and `submit-github.test.ts`; versioning the report
 * is cli-ux-10's. `pushed` is whether THIS run pushed the branch: false on a
 * local road, on a pull request opened for a branch an earlier run pushed,
 * and on every `already-submitted`. `kept` is the local branch a refusal after
 * it was cut leaves in the clone.
 */
export type SubmissionReport =
  | {
      readonly outcome: 'created' | 'already-submitted'
      readonly branch: string
      readonly commit: string
      readonly base: Base
      readonly pushed: boolean
      readonly pullRequest?: PullRequest
      readonly olderBase?: string
    }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'declined'; readonly branch: string }
  | { readonly outcome: 'refused'; readonly reasons: readonly string[]; readonly kept?: string }
  | {
      readonly outcome: 'pushed-without-pull-request'
      readonly branch: string
      readonly commit: string
      readonly reason: string
    }
  | {
      readonly outcome: 'closed'
      readonly branch: string
      readonly number: number
      readonly merged: boolean
      readonly at: string
    }

/**
 * Where a submission went, as root attributes of a traced run (stage 6 brief
 * § 12): the forge's kind, the host and repository on GitHub's road (the host
 * on another host's too), the base, the branch, the pull request's number, the
 * outcome, how many gh calls the run made and whether it pushed. Never gh's
 * login, nor anything a person typed.
 */
export function forgeAttributes(report: SubmissionReport, road: Road, calls: number): Attributes {
  const where: Record<string, string | number | boolean> = {}
  switch (road.kind) {
    case 'github':
      where['idp.forge.kind'] = 'github'
      where['idp.forge.host'] = road.repository.host
      where['idp.forge.repository'] = `${road.repository.owner}/${road.repository.name}`
      where['idp.forge.base'] = road.base
      break
    case 'local':
      where['idp.forge.kind'] = 'local'
      if (road.why === 'other-host') where['idp.forge.host'] = road.host
      break
    default: {
      const _exhaustive: never = road
      return _exhaustive
    }
  }
  // Whether this run pushed; a stop at step 12, or a refusal that kept the
  // branch, does not say, and claims nothing.
  let pushed: boolean | undefined = false
  switch (report.outcome) {
    case 'created':
    case 'already-submitted':
      if (road.kind !== 'github') where['idp.forge.base'] = report.base.branch
      where['idp.forge.branch'] = report.branch
      if (report.pullRequest !== undefined) where['idp.forge.pull_request'] = report.pullRequest.number
      pushed = report.pushed
      break
    case 'declined':
      where['idp.forge.branch'] = report.branch
      break
    case 'pushed-without-pull-request':
      where['idp.forge.branch'] = report.branch
      pushed = undefined
      break
    case 'closed':
      where['idp.forge.branch'] = report.branch
      where['idp.forge.pull_request'] = report.number
      break
    case 'refused':
      // A kept branch may have been pushed before step 11 refused: unsaid.
      if (report.kept !== undefined) {
        where['idp.forge.branch'] = report.kept
        pushed = undefined
      }
      break
    case 'unchanged':
      break
    default: {
      const _exhaustive: never = report
      return _exhaustive
    }
  }
  return {
    ...where,
    'idp.forge.outcome': report.outcome,
    'idp.forge.gh_calls': calls,
    ...(pushed === undefined ? {} : { 'idp.forge.pushed': pushed }),
  }
}

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
  const { opened } = input
  const done = await submitting(input)
  // Where it went, for a traced run's root (stage 6 brief § 12).
  const attributes = forgeAttributes(done.report, opened.road, callsOf(opened))
  return { report: done.report, result: { ...done.result, attributes } }
}

/** `submit`'s steps, before its result is given where it went. */
async function submitting(input: {
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
  // else's, which no answer at the prompt could make ours. On GitHub's road
  // a closed pull request is answered here too; our branch pushed by an
  // earlier run with no pull request is not the end of the run: only the
  // pull request is left, and it is asked about (stage 6 brief § 14, row 2).
  // The forge only reads to say so; `submit` below looks again at the moment
  // of writing, for a branch created while the person read the diff.
  const known = await opened.forge.recognise(cleared, opened.base)
  if (known !== undefined && known.outcome !== 'pushed-without-pull-request') {
    return outcomeOf(known, opened.base, opened.road, said)
  }

  if (confirm !== undefined) {
    const { road } = opened
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
      ...(road.kind === 'github'
        ? {
            github: {
              host: road.repository.host,
              repository: `${road.repository.owner}/${road.repository.name}`,
              base: road.base,
              pushedAlready: known?.outcome === 'pushed-without-pull-request',
            },
          }
        : {}),
    })
    if (!yes) {
      return {
        report: { outcome: 'declined', branch: cleared.branch },
        result: { text: said({ kind: 'declined' }), found: true },
      }
    }
  }

  return outcomeOf(await opened.forge.submit(cleared, opened.base), opened.base, opened.road, said)
}

/** A reason the forge ended on "Nothing was written.": the closing lines say it, or say what was kept. */
const unwritten = (reason: string): string => reason.replace(/\s*Nothing was written\.$/, '')

/**
 * What the forge said, as the run's result and its `--json` key — the same
 * words whether it said them before the prompt or at the moment of writing.
 * A pull request not opened, and one closed, are negative answers (exit 1),
 * as a refusal is.
 */
function outcomeOf(
  submitted: Submitted,
  base: Base,
  road: Road,
  said: (status: PreviewStatus) => string,
): { readonly result: CommandResult; readonly report: SubmissionReport } {
  switch (submitted.outcome) {
    case 'created':
    case 'already-submitted': {
      const { pullRequest, olderBase } = submitted
      const statusChecks = submitted.outcome === 'created' ? submitted.statusChecks : undefined
      const status: PreviewStatus = {
        kind: 'submitted',
        again: submitted.outcome === 'already-submitted',
        branch: submitted.branch,
        base,
        road,
        ...(pullRequest === undefined ? {} : { pullRequest }),
        ...(olderBase === undefined ? {} : { olderBase }),
        ...(statusChecks === undefined ? {} : { statusChecks }),
      }
      return {
        report: {
          outcome: submitted.outcome,
          branch: submitted.branch,
          commit: submitted.commit,
          base,
          pushed: submitted.pushed === true,
          ...(pullRequest === undefined ? {} : { pullRequest }),
          ...(olderBase === undefined ? {} : { olderBase }),
        },
        result: { text: said(status), found: true },
      }
    }
    case 'unchanged':
      return { report: submitted, result: { text: said({ kind: 'preview' }), found: true } }
    case 'refused': {
      // The forge's words quote refs and paths of the repository: cleaned.
      const { kept } = submitted
      const status: PreviewStatus = {
        kind: 'refused',
        reasons: cleaned([unwritten(submitted.reason)]),
        ...(kept === undefined ? {} : { kept: one(kept) }),
      }
      return {
        report: { outcome: 'refused', reasons: [submitted.reason], ...(kept === undefined ? {} : { kept }) },
        result: { text: said(status), found: false },
      }
    }
    case 'pushed-without-pull-request': {
      if (road.kind !== 'github') throw new Error('a local road never stops before a pull request')
      const status: PreviewStatus = {
        kind: 'pushed-without-pull-request',
        branch: one(submitted.branch),
        repository: printedRepository(road.repository),
        reason: one(submitted.reason),
      }
      return {
        report: {
          outcome: 'pushed-without-pull-request',
          branch: submitted.branch,
          commit: submitted.commit,
          reason: submitted.reason,
        },
        result: { text: said(status), found: false },
      }
    }
    case 'closed': {
      if (road.kind !== 'github') throw new Error('a local road never meets a pull request')
      const status: PreviewStatus = {
        kind: 'closed',
        branch: one(submitted.branch),
        number: submitted.number,
        merged: submitted.merged,
        at: one(submitted.at),
        base: one(road.base),
      }
      return {
        report: {
          outcome: 'closed',
          branch: submitted.branch,
          number: submitted.number,
          merged: submitted.merged,
          at: submitted.at,
        },
        result: { text: said(status), found: false },
      }
    }
    default: {
      const _exhaustive: never = submitted
      return _exhaustive
    }
  }
}
