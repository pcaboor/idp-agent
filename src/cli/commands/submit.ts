import type { ProjectRead } from '../../context/project-fs/types.js'
import { PATCH_LINES, type InFlightEntry, type InFlightPull, type InFlightVerdict } from '../../core/github/in-flight.js'
import { noteLine, noteOf, refusesPush, type MergeNote } from '../../core/github/protection.js'
import { pullRequestUrl, type PullRequestInput } from '../../core/github/pull-request.js'
import { locatorRepository, printedRepository, sameRepository } from '../../core/github/remote.js'
import { identitiesOf, isComponent } from '../../core/plan/catalog-info.js'
import { relatedPaths, type Cleared, type ClearRefusal, type Expectation, type Repository } from '../../core/plan/clear.js'
import type { RepositorySnapshot } from '../../core/validate/rules.js'
import { CONFIG_FILE, type RepositoryConfig } from '../../core/schemas/config.js'
import { ForgeInputError } from '../../forge/errors.js'
import { GitHubAnswerError, type GitHubApi } from '../../forge/github/api.js'
import { preflight } from '../../forge/github/preflight.js'
import { openSubmissionForge, type OpenedForge } from '../../forge/open.js'
import type {
  Base,
  ForgeProvider,
  GhIdentity,
  GitHubRoad,
  LocalRoad,
  PullRequest,
  Recognised,
  Road,
  Submitted,
} from '../../forge/provider.js'
import type { GhProcess } from '../../process/gh.js'
import type { Attributes } from '../../trace/model.js'
import { baseOf, closingLines, IN_FLIGHT_SHOWN, type Beside, type PreviewStatus } from '../render/footer.js'
import { inert, inertLine, visible } from '../render/plain.js'
import { renderUnprotected } from '../render/protection.js'
import type { CommandResult } from './result.js'

/**
 * `--submit`: a previewed plan becomes one new branch, cut from `HEAD`, for
 * review (ADR-0010) — and, where the checked-out branch tracks one on
 * github.com, that branch pushed with the person's git and one pull request
 * opened with their gh (stage 6 brief § 3). Everything a run decides about
 * that lives here, in the order it happens — open the forge before anything
 * is read, refuse a repository whose working tree is not `HEAD`, or one on
 * GitHub this run cannot push to, before anything is previewed — saying, where
 * the base's rules let a pull request's author merge it alone, that they do
 * (the owner's decision of 2026-10-01) — then clear,
 * recognise a submission already made, confirm and submit — so both roads of
 * `plan`, and `init` after them, take the same steps rather than three copies
 * of them. At a terminal, a change previewed without `--submit` takes the
 * same steps after its diff (`openToPropose`, the owner's decision of
 * 2026-10-01), and a step that would have refused is why no pull request is
 * proposed.
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
    /** The preflight found an `author-may-merge` kind: the question does not promise an approval. */
    readonly authorMayMergeAlone: boolean
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
  /** Where the line naming the GitHub road goes, and the note on who may merge: stderr, from `cli/index.ts`. */
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
 * On GitHub's road, after the divergence and before the preview: whether this
 * run can push to the repository at all — not archived, pushable by gh's
 * account, answering under the remote's name (§ 8 item 1) — and whether
 * GitHub's base is the commit this clone's is (stage 6 brief § 8). Either
 * answered no is the repository's state, a negative answer (exit 1);
 * nothing was previewed, nothing written, and no question asked. Item 1 is
 * judged first, so a repository that fails both is told why it cannot take a
 * pull request. A local road reads nothing here.
 *
 * The rules of items 2 to 4 refuse nothing (the owner's decision of
 * 2026-10-01): whether a pull request's author may merge it alone is the
 * company's rule, not idpa's. Where they let the author merge alone, or leave
 * the base unguarded, the note's line goes to `notice` — stderr, never the
 * result, so a traced run's output and `--json` are unchanged by it — once a
 * run, and the run goes on.
 *
 * With `json`, the refusal is the report, as `refuseDivergence`'s is. With
 * `offerLocal`, `init --submit`'s, the refusal on item 1 names `--local`
 * (decision 17).
 */
export async function refuseUnprotected(
  opened: Opened,
  options: { readonly json?: boolean; readonly offerLocal?: boolean; readonly notice?: (line: string) => void } = {},
): Promise<CommandResult | undefined> {
  const { road, github } = opened
  if (road.kind !== 'github') return undefined
  if (github === undefined) throw new Error('a GitHub road opened without gh')
  // Judged once per forge and base: a road that reads the preflight early
  // (the phrase's, 6.3.3) is not read again by `runIntent`, and the run stays
  // within `GITHUB_LIMITS.ghCalls` — nor says its note twice. A refusal ends
  // the run, so only a pass is ever read back; a base that moved in between
  // is judged again. Step 8's and step 11's reads are the forge's own, and
  // never kept.
  const kept = judged.get(opened.forge)
  if (kept !== undefined && kept.commit === opened.base.commit) return (await kept.judgement).refusal
  const judgement = unprotected(opened, road, github, options)
  judged.set(opened.forge, { commit: opened.base.commit, judgement })
  return (await judgement).refusal
}

/** What `refuseUnprotected` reached: a refusal, or none and the note the run said, if any, with its line. */
interface Judgement {
  readonly refusal?: CommandResult
  readonly note?: { readonly kind: MergeNote; readonly line: string }
}

/** The judgement `refuseUnprotected` reached for a forge, and the base commit it judged. */
const judged = new WeakMap<ForgeProvider, { readonly commit: string; readonly judgement: Promise<Judgement> }>()

/** The note the preflight kept for this forge said, if any, and its line: the question and the closing lines read it. */
const preflightNote = async (opened: Opened): Promise<Judgement['note']> => {
  const kept = judged.get(opened.forge)
  return kept === undefined ? undefined : (await kept.judgement).note
}

/** `refuseUnprotected`'s judgement, read from GitHub. */
async function unprotected(
  opened: Opened,
  road: GitHubRoad,
  github: NonNullable<Opened['github']>,
  options: { readonly json?: boolean; readonly offerLocal?: boolean; readonly notice?: (line: string) => void },
): Promise<Judgement> {
  const { verdict, level } = await preflight(github.api, road, opened.base)
  let text: string
  let reasons: string[]
  if (refusesPush(verdict)) {
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
    const note = noteOf(verdict)
    if (note === undefined) return {}
    // The line is the engine's; the base in it is held to the branch grammar.
    const line = one(noteLine(note, road.base, verdict.missing))
    options.notice?.(line)
    return { note: { kind: note, line } }
  }
  return { refusal: refusedBefore(opened, text, reasons, options) }
}

// ---------------------------------------------------------------- what is in flight (6.3.6)

/**
 * A pull request in flight, as `--json`, a status and a trace may carry it:
 * its number, the URL the engine builds, and this change's own paths it
 * changes. Never a login, never another run's branch, never a patch, never a
 * title (the owner's decision of 2026-10-01).
 */
export interface InFlightReport {
  readonly number: number
  readonly url: string
  readonly paths: readonly string[]
}

const reportOf = (entry: InFlightEntry, road: GitHubRoad): InFlightReport => ({
  number: entry.pull.number,
  url: pullRequestUrl(road.repository, entry.pull.number),
  paths: entry.paths,
})

/** The pull requests beside a change, as the statuses print them. */
const besideOf = (entries: readonly InFlightEntry[], road: GitHubRoad): Beside => ({
  repository: printedRepository(road.repository),
  pulls: entries.map((entry) => ({ number: entry.pull.number, paths: entry.paths, complete: entry.pull.complete })),
})

/** Who opened a pull request in flight, and from where: stderr alone. */
const whoLine = (pull: InFlightPull): string =>
  `pull request #${String(pull.number)} is by ${one(pull.by)}, from ${one(pull.branch)}`

/** The stdout line of a competing pull request: its number, this change's paths, its URL. */
const competingLine = (entry: InFlightEntry, road: GitHubRoad): string =>
  `pull request #${String(entry.pull.number)} on ${printedRepository(road.repository)} already changes ` +
  `${entry.paths.map(one).join(', ')}, differently: ${pullRequestUrl(road.repository, entry.pull.number)}`

/** A line of another pull request's patch, cut at `PATCH_LINES.perLine` code points: one line of 1 MiB is still one line. */
const patchLine = (line: string): string => {
  const points = [...line]
  return points.length > PATCH_LINES.perLine ? `${points.slice(0, PATCH_LINES.perLine).join('')}…` : line
}

/**
 * What a competing pull request changes, on stderr: for each of this change's
 * paths it changes, its heading and at most 40 lines of GitHub's patch, each
 * indented four spaces, cut at 200 characters, every control and bidi
 * character spelled out, at most 120 lines in all, then where the rest is. A
 * patch is printed here and reaches nothing else: no model, no trace, no pull
 * request body and no `--json`.
 */
export const patchLines = (entries: readonly InFlightEntry[], road: GitHubRoad): string[] => {
  const lines: string[] = []
  let left: number = PATCH_LINES.perRun
  for (const { pull, paths } of entries) {
    const files = `${pullRequestUrl(road.repository, pull.number)}/files`
    for (const path of paths) {
      lines.push(`In pull request #${String(pull.number)}, ${one(path)}:`)
      const file = pull.files.find((candidate) => candidate.path === path || candidate.previous === path)
      if (file?.patch === undefined || file.patch === '') {
        lines.push(`    (GitHub shows no patch for it: ${files})`)
        continue
      }
      const patch = file.patch.split(/\r?\n/)
      const shown = patch.slice(0, Math.min(PATCH_LINES.perPath, left))
      left -= shown.length
      // Spelled out, never removed: a reviewer sees that a line holds something there, as in the diff.
      lines.push(...shown.map((line) => `    ${visible(patchLine(line))}`))
      if (shown.length < patch.length) lines.push(`    … ${String(patch.length - shown.length)} more lines: ${files}`)
    }
  }
  return lines
}

/** A verdict's pull requests, by kind and number: what step 8 compares with the one shown before the question. */
const verdictKey = (verdict: InFlightVerdict): string => {
  switch (verdict.kind) {
    case 'clear':
      return 'clear'
    case 'same':
      return `same ${String(verdict.pull.number)}`
    case 'competing':
    case 'beside':
      return `${verdict.kind} ${verdict.pulls.map((entry) => String(entry.pull.number)).join(',')}`
    default: {
      const _exhaustive: never = verdict
      return _exhaustive
    }
  }
}

/** How many pull requests in flight a verdict judged same, competing or beside: `idp.forge.in_flight`. */
const countOf = (verdict: InFlightVerdict): number =>
  verdict.kind === 'clear' ? 0 : verdict.kind === 'same' ? 1 : verdict.pulls.length

/**
 * The inspected service's paths in the declarations repository: the one
 * Component its root `catalog-info.yaml` or `.yml` declares — the files of no
 * workspace — and every file of `snapshot` that declares it or names it
 * (`relatedPaths`). Undefined when no single Component is declared there: the
 * service is not known before the model, and nothing is said.
 */
export function serviceTarget(
  project: ProjectRead,
  snapshot: RepositorySnapshot,
): { readonly what: string; readonly paths: readonly string[] } | undefined {
  const components = project.declarations
    .filter((file) => file.workspace === undefined && (file.path === 'catalog-info.yaml' || file.path === 'catalog-info.yml'))
    .flatMap((file) => ('text' in file ? identitiesOf(file.text).identities.filter(isComponent) : []))
  const [component] = components
  if (components.length !== 1 || component === undefined) return undefined
  const ref = `component:${component.namespace.toLowerCase()}/${component.name.toLowerCase()}`
  return { what: ref, paths: relatedPaths(snapshot, [ref], []) }
}

/**
 * Right after `refuseUnprotected`, before any model (the owner's decision of
 * 2026-10-01): makes the first read of what is in flight, kept by the forge;
 * says on stderr the idp-agent pull requests touching `about` when it is given
 * — their author and branch said there and nowhere else — and refuses only a
 * read that cannot be made whole (exit 1). Nothing is refused for being in
 * flight here: before the bytes exist, the same change and a different one
 * cannot be told apart, and a change somebody already proposed byte for byte
 * is named at exit 0 once its bytes exist. A local road reads nothing.
 */
export async function sayInFlight(
  opened: Opened,
  about: { readonly what: string; readonly paths: readonly string[] } | undefined,
  options: { readonly json?: boolean; readonly notice?: (line: string) => void },
): Promise<CommandResult | undefined> {
  const { forge, road } = opened
  if (forge.inFlight === undefined || road.kind !== 'github') return undefined
  let verdict: InFlightVerdict
  try {
    verdict = await forge.inFlight({ writes: [], related: about?.paths ?? [] })
  } catch (error) {
    if (!(error instanceof GitHubAnswerError)) throw error
    return refusedBefore(opened, error.message, [error.message], options)
  }
  if (about === undefined || verdict.kind !== 'beside') return undefined
  const where = printedRepository(road.repository)
  for (const { pull, paths } of verdict.pulls.slice(0, IN_FLIGHT_SHOWN)) {
    options.notice?.(
      `in flight on ${where}, touching ${one(about.what)}: pull request #${String(pull.number)} by ${one(pull.by)} ` +
        `(${one(pull.branch)}), changing ${paths.map(one).join(', ')}`,
    )
  }
  const more = verdict.pulls.length - IN_FLIGHT_SHOWN
  if (more > 0) options.notice?.(`… and ${String(more)} more`)
  options.notice?.('this run drafts the change, then compares it with them before anything is written')
  return undefined
}

/**
 * Why a change previewed at a terminal ends without the question: what `--submit`
 * would have refused with, said as the reason nothing is proposed — or, from
 * 6.3.6, an idp-agent pull request in flight with the same change or a
 * competing one, said in the line it carries.
 */
export type Unproposed =
  | { readonly why: 'local-road'; readonly road: LocalRoad }
  | { readonly why: 'refused'; readonly line: string }
  | { readonly why: 'in-flight'; readonly line: string }

/** What a local road leaves a person who wants the branch anyway. */
const CUTS_HERE = '--submit cuts the branch in this clone'

/**
 * The one stderr line, at most once per run: `no pull request proposed — <reason>`.
 * A local road's is built from the road itself, not from `localRoadLine`, whose
 * "nothing pushed" would be the wrong advice here: `--submit` is. `asked` never
 * reaches it — `--local` without `--submit` is refused at parse time — so it
 * throws rather than say something about a road nobody can be on.
 */
export function unproposedLine(unproposed: Unproposed): string {
  const said = (reason: string): string => `no pull request proposed — ${reason}`
  switch (unproposed.why) {
    case 'local-road': {
      const { road } = unproposed
      switch (road.why) {
        case 'no-upstream':
          return said(`${one(road.branch)} tracks no remote; ${CUTS_HERE}`)
        case 'other-host':
          return said(`the remote is on ${one(road.host)}, where this build opens no pull request; ${CUTS_HERE}`)
        case 'asked':
          throw new Error('--local is refused without --submit, and never reaches a proposal')
        default: {
          const _exhaustive: never = road
          return _exhaustive
        }
      }
    }
    case 'refused':
    case 'in-flight':
      return said(one(unproposed.line))
    default: {
      const _exhaustive: never = unproposed
      return _exhaustive
    }
  }
}

/**
 * The reason `--submit` would have printed for the same refusal, as one line:
 * its first, without the `not submitted — ` it opens on or the ` Nothing was
 * written.` it may end on (the preview wrote nothing either); and when that
 * line ends on `:`, the indented lines under it — § 8 item 1's `missing:`
 * lines, a divergence's paths — joined to it by `; `. A line that is not
 * indented ends it, so a ruleset to add, or "Then run this again", is never
 * part of it; and § 8 item 1's block names `gh's account`, never a login.
 *
 * `--submit`'s offer of `--local` becomes `--submit --local`: this run had no
 * `--submit`, and `--local` without it is refused at parse time (exit 2), so
 * the offer as `--submit` words it would be advice that fails.
 */
const reasonOf = (text: string): string => {
  const [first = '', ...rest] = text.split('\n')
  const line = first
    .replace(/^not submitted — /, '')
    .replace(/\s*Nothing was written\.$/, '')
    .replaceAll(LOCAL_OFFER, PROPOSAL_LOCAL_OFFER)
  if (!line.endsWith(':')) return line
  const under: string[] = []
  for (const next of rest) {
    if (!next.startsWith('  ') || next.trim() === '') break
    under.push(next.trim())
  }
  return under.length === 0 ? line : `${line} ${under.join('; ')}`
}

/** How `--submit`'s refusals offer stage 5's branch (`forge/github/identity.ts`, `road.ts`), and how a proposal's do. */
const LOCAL_OFFER = 'add --local to cut the branch in this clone only'
const PROPOSAL_LOCAL_OFFER = 'add --submit --local to cut the branch in this clone only'

/** What `main` hands a change road previewed at a terminal without `--submit`. */
export interface Proposal extends Pick<SubmitOptions, 'env' | 'gh' | 'notice'> {
  /** The person at the keyboard: `--submit`'s question, asked after the diff. */
  readonly confirm: Confirm
  readonly route: 'intent' | 'phrase'
}

/** A forge a proposal can be put through, and the lines it holds until the question. */
export interface Proposable extends Opened {
  /** The `submitting to …` line and 6.3.4's note, in that order: `submit` says them just before the question. */
  readonly held: readonly string[]
}

/**
 * Steps 3 to 5 of the proposal road: the forge, the road, gh, the service's iacRepo,
 * divergence and the base's rules — everything `--submit` checks before it previews —
 * after the last model call. A refusal is never thrown here: it is why nothing is
 * proposed. Anything else (a programming error, git failing unexpectedly) is thrown.
 *
 * A question is put only where the engine could do what it says, so every read
 * `--submit` makes before its question comes first; and since this runs after
 * the Reviewer, an exit 2 of `--submit`'s — gh logged out, a clone configured
 * to redirect the push — is not one here: the person asked for a preview, and
 * the preview stands (Global Constraint 9, no exit 2 after a model call).
 * GitHub's answer to the preflight is a refusal too, by the same reading.
 *
 * The `submitting to …` line and 6.3.4's note are held, not said: they are
 * returned with the forge, and `submit` says them just before the question.
 * Said here, a run that then proposes nothing — a check below, or recognition
 * in `submit` — would read `submitting to …` above `no pull request proposed`,
 * and nothing was being submitted.
 */
export async function openToPropose(input: {
  readonly root: string
  readonly proposal: Proposal
  readonly project?: string
  readonly config?: RepositoryConfig
  readonly contents: ReadonlyMap<string, string>
}): Promise<Proposable | Unproposed> {
  const { proposal } = input
  const held: string[] = []
  const notice = (line: string): void => void held.push(line)
  try {
    const opened = await openForSubmission(input.root, 'declarations', {
      ...(proposal.env === undefined ? {} : { env: proposal.env }),
      ...(proposal.gh === undefined ? {} : { gh: proposal.gh }),
      notice,
      local: false,
      route: proposal.route,
    })
    if (opened.road.kind === 'local') return { why: 'local-road', road: opened.road }
    const refused =
      (input.project === undefined ? undefined : refuseOtherRepository(opened, input.config, input.project)) ??
      (await refuseDivergence(opened, { files: input.contents, scope: 'catalogue' })) ??
      (await refuseUnprotected(opened, { notice }))
    return refused === undefined ? { ...opened, held } : { why: 'refused', line: reasonOf(refused.text) }
  } catch (error) {
    if (error instanceof ForgeInputError || error instanceof GitHubAnswerError) {
      return { why: 'refused', line: reasonOf(error.message) }
    }
    throw error
  }
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
      /** On GitHub: the note the rules read just before the pull request called for, which its body carries. */
      readonly note?: MergeNote
      /** On GitHub: the idp-agent pull requests in flight beside it, which its body names (6.3.6). */
      readonly beside?: readonly InFlightReport[]
    }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'declined'; readonly branch: string }
  | {
      readonly outcome: 'refused'
      readonly reasons: readonly string[]
      readonly kept?: string
      /** Refused for an idp-agent pull request in flight that changes a file this change writes, differently. */
      readonly inFlight?: readonly InFlightReport[]
    }
  /** Another account's pull request in flight proposes the same bytes: named, nothing written (6.3.6). No author. */
  | { readonly outcome: 'already-proposed'; readonly branch: string; readonly number: number; readonly url: string }
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
 * outcome, how many gh calls the run made and whether it pushed — and, when
 * what is in flight was judged, how many pull requests it judged the same,
 * competing or beside (`inFlight`, 6.3.6). Never gh's login, nor another
 * person's, nor their branch, nor anything a person typed.
 */
export function forgeAttributes(report: SubmissionReport, road: Road, calls: number, inFlight?: number): Attributes {
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
    case 'already-proposed':
      // The pull request named is another account's: this run pushed nothing.
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
    ...(inFlight === undefined ? {} : { 'idp.forge.in_flight': inFlight }),
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
  /** Where a note line the preflight did not say is said, above the closing lines: stderr. */
  readonly notice?: (line: string) => void
  /**
   * The person did not type --submit: a recognised refusal or closed pull request ends
   * the run on the preview and `unproposedLine`, exit 0, and a submission recognised
   * before the question prints the whole preview, not only its closing lines. So does
   * GitHub failing to answer recognition's read: it comes before the question, and the
   * person asked for a preview. `held` is said just before the question, and only then.
   */
  readonly proposal?: ProposalEnding
}): Promise<{ readonly result: CommandResult; readonly report: SubmissionReport }> {
  const { opened } = input
  const done = await submitting(input)
  // Where it went, for a traced run's root (stage 6 brief § 12) — and, on the
  // proposal road, whether the question was put (true) or the run said why
  // not (false); a submission named before the question was neither.
  const attributes = {
    ...forgeAttributes(done.report, opened.road, callsOf(opened), done.inFlight),
    ...(done.proposed === undefined ? {} : { 'idp.forge.proposed': done.proposed }),
  }
  return { report: done.report, result: { ...done.result, attributes } }
}

/** What `submit` is handed on the proposal road: where its lines go, and the ones `openToPropose` held. */
interface ProposalEnding {
  readonly notice: (line: string) => void
  readonly held?: readonly string[]
}

/** `submit`'s steps, before its result is given where it went. */
async function submitting(input: {
  readonly opened: Opened
  readonly cleared: Cleared | ClearRefusal
  readonly render: (status: PreviewStatus) => CommandResult
  readonly confirm?: Confirm
  readonly notice?: (line: string) => void
  readonly proposal?: ProposalEnding
}): Promise<{
  readonly result: CommandResult
  readonly report: SubmissionReport
  readonly proposed?: boolean
  /** How many pull requests in flight the last judgement named, when one was made. */
  readonly inFlight?: number
}> {
  const { opened, cleared, render, confirm, proposal } = input

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
  // Where stderr goes: the proposal's, else `--submit`'s.
  const tell = (line: string): void => (proposal === undefined ? input.notice?.(line) : proposal.notice(line))
  /** On the proposal road, why nothing is proposed: the line, then the preview whole, exit 0. */
  const unproposed = (
    why: Unproposed,
    report: SubmissionReport,
    count?: number,
  ): { readonly result: CommandResult; readonly report: SubmissionReport; readonly proposed: false; readonly inFlight?: number } => {
    tell(unproposedLine(why))
    return {
      report,
      result: { text: render({ kind: 'preview' }).text, found: true },
      proposed: false,
      ...(count === undefined ? {} : { inFlight: count }),
    }
  }

  // What is in flight (the owner's decision of 2026-10-01), judged before
  // recognition: another account's run of this very change lands on the same
  // branch name under other words, and is named here rather than refused as
  // "a different change". The forge read it before any model (`sayInFlight`)
  // and answers from that read, at no gh call; on the proposal road, and on a
  // forge nobody asked before, this is the first read. Only the GitHub forge
  // has one.
  let shown: InFlightVerdict | undefined
  let beside: readonly InFlightEntry[] = []
  if (opened.forge.inFlight !== undefined && opened.road.kind === 'github') {
    const { road } = opened
    try {
      shown = await opened.forge.inFlight({
        writes: cleared.edits.map((edit) => ({ path: edit.path, after: edit.after })),
        related: cleared.related,
        branch: cleared.branch,
      })
    } catch (error) {
      // As recognition's read below: why nothing is proposed, or `--submit`'s answer.
      if (proposal === undefined || !(error instanceof GitHubAnswerError)) throw error
      return unproposed({ why: 'refused', line: reasonOf(error.message) }, { outcome: 'refused', reasons: [error.message] })
    }
    const count = countOf(shown)
    switch (shown.kind) {
      case 'clear':
        break
      case 'same': {
        const { pull } = shown
        const url = pullRequestUrl(road.repository, pull.number)
        if (proposal !== undefined) {
          return unproposed(
            { why: 'in-flight', line: `already proposed by ${one(pull.by)} in pull request #${String(pull.number)}: ${url}` },
            { outcome: 'already-proposed', branch: cleared.branch, number: pull.number, url },
            count,
          )
        }
        const named = outcomeOf(
          { outcome: 'already-proposed', branch: cleared.branch, number: pull.number, url, by: pull.by },
          opened,
          said,
          tell,
        )
        return { ...named, inFlight: count }
      }
      case 'competing': {
        if (proposal !== undefined) {
          const [first] = shown.pulls
          if (first === undefined) throw new Error('a competing verdict names a pull request')
          const reason =
            `pull request #${String(first.pull.number)} by ${one(first.pull.by)} (${one(first.pull.branch)}) already changes ` +
            `${first.paths.map(one).join(', ')}, differently: ${pullRequestUrl(road.repository, first.pull.number)}`
          const ended = unproposed(
            { why: 'in-flight', line: reason },
            { outcome: 'refused', reasons: shown.pulls.map((entry) => competingLine(entry, road)), inFlight: shown.pulls.map((entry) => reportOf(entry, road)) },
            count,
          )
          for (const line of patchLines(shown.pulls, road)) tell(line)
          return ended
        }
        const refusal = outcomeOf({ outcome: 'refused', reason: '', inFlight: shown.pulls }, opened, said, tell)
        return { ...refusal, inFlight: count }
      }
      case 'beside':
        beside = shown.pulls
        break
      default: {
        const _exhaustive: never = shown
        return _exhaustive
      }
    }
  }
  const count = shown === undefined ? undefined : countOf(shown)
  const withCount = <T extends object>(done: T): T & { readonly inFlight?: number } =>
    count === undefined ? done : { ...done, inFlight: count }

  // Before anyone is asked: a branch that is already there is either this
  // very submission — nothing to confirm, and nothing to write — or somebody
  // else's, which no answer at the prompt could make ours. On GitHub's road
  // a closed pull request is answered here too; our branch pushed by an
  // earlier run with no pull request is not the end of the run: only the
  // pull request is left, and it is asked about (stage 6 brief § 14, row 2).
  // The forge only reads to say so; `submit` below looks again at the moment
  // of writing, for a branch created while the person read the diff.
  let known: Recognised | undefined
  try {
    known = await opened.forge.recognise(cleared, opened.base)
  } catch (error) {
    // On the proposal road, a read before the question that GitHub failed to
    // answer is why nothing is proposed, as the preflight's is in
    // `openToPropose`: the preview stands, exit 0. Under `--submit` it is the
    // run's answer, exit 1, as it always was.
    if (proposal === undefined || !(error instanceof GitHubAnswerError || error instanceof ForgeInputError)) throw error
    return withCount(unproposed({ why: 'refused', line: reasonOf(error.message) }, { outcome: 'refused', reasons: [error.message] }))
  }
  const noted = await preflightNote(opened)
  // The note step 11's read calls for, said on stderr just above the closing
  // lines when the preflight did not say those words: the rules changed while
  // the person read the diff, and the body carries step 11's line, so stderr
  // ends on what the body says. The same line is never said twice in a run.
  const after = (line: string): void => {
    if (line !== noted?.line) input.notice?.(line)
  }
  if (known !== undefined && known.outcome !== 'pushed-without-pull-request') {
    if (proposal === undefined) return withCount(outcomeOf(known, opened, said, after))
    // Recognised before a proposal: the person asked for a preview, and gets
    // it whole. A submission already made is named under it; a refusal or a
    // closed pull request is why nothing is proposed, and the preview stands.
    let ended: PreviewStatus = { kind: 'preview' }
    const whole = outcomeOf(
      known,
      opened,
      (status) => {
        ended = status
        return render(status).text
      },
      after,
    )
    if (known.outcome === 'already-submitted') return withCount(whole)
    // A closed pull request's reason is its closing line's, so one sentence says it.
    const shownLines = closingLines(ended, changed)
    proposal.notice(
      unproposedLine({
        why: 'refused',
        line:
          known.outcome === 'refused'
            ? reasonOf(unwritten(known.reason))
            : (shownLines[0] ?? '').replace(/^\d+ files? · not submitted — /, '').replace(/ · nothing written$/, ''),
      }),
    )
    return withCount({
      report: whole.report,
      result: { text: render({ kind: 'preview' }).text, found: true },
      proposed: false,
    })
  }

  // The question is about to be put: what `openToPropose` held is true now,
  // and so is who opened each pull request in flight beside this one — said
  // once, on stderr, never on stdout.
  for (const line of proposal?.held ?? []) proposal?.notice(line)
  for (const { pull } of beside.slice(0, IN_FLIGHT_SHOWN)) tell(whoLine(pull))

  const road = opened.road
  const besideNow = beside.length === 0 || road.kind !== 'github' ? undefined : besideOf(beside, road)
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
      preview: render({ kind: 'pending', branch: cleared.branch, ...(besideNow === undefined ? {} : { beside: besideNow }) }).text,
      ...(road.kind === 'github'
        ? {
            github: {
              host: road.repository.host,
              repository: `${road.repository.owner}/${road.repository.name}`,
              base: road.base,
              pushedAlready: known?.outcome === 'pushed-without-pull-request',
              authorMayMergeAlone: noted?.kind === 'author-may-merge',
            },
          }
        : {}),
    })
    if (!yes) {
      return withCount({
        report: { outcome: 'declined', branch: cleared.branch },
        result: { text: said({ kind: 'declined' }), found: true },
        ...(proposal === undefined ? {} : { proposed: true }),
      })
    }
  }

  const submitted = await opened.forge.submit(cleared, opened.base)
  // Step 8 read what is in flight again: where its verdict is not the one
  // shown before the question, that is said first, then the new verdict's lines.
  const now = stepEight(submitted)
  if (shown !== undefined && now !== undefined && verdictKey(now) !== verdictKey(shown) && now.kind !== 'clear') {
    tell('what is in flight changed while you read the diff:')
    if (now.kind === 'beside') for (const { pull } of now.pulls.slice(0, IN_FLIGHT_SHOWN)) tell(whoLine(pull))
  }
  const done = outcomeOf(submitted, opened, said, after, tell)
  const final = now === undefined ? count : countOf(now)
  return {
    report: done.report,
    result: done.result,
    ...(proposal === undefined ? {} : { proposed: true }),
    ...(final === undefined ? {} : { inFlight: final }),
  }
}

/**
 * The verdict step 8 reached, as the forge's answer carries it: `undefined`
 * where the answer says nothing of what is in flight — a refusal for another
 * reason, a stop at step 12, a closed pull request.
 */
const stepEight = (submitted: Submitted): InFlightVerdict | undefined => {
  switch (submitted.outcome) {
    case 'already-proposed':
      return {
        kind: 'same',
        pull: { number: submitted.number, by: submitted.by, branch: submitted.branch, head: '', files: [], complete: true },
      }
    case 'refused':
      return submitted.inFlight === undefined ? undefined : { kind: 'competing', pulls: submitted.inFlight }
    case 'created':
      return submitted.beside === undefined || submitted.beside.length === 0
        ? { kind: 'clear' }
        : { kind: 'beside', pulls: submitted.beside }
    case 'already-submitted':
    case 'unchanged':
    case 'pushed-without-pull-request':
    case 'closed':
      return undefined
    default: {
      const _exhaustive: never = submitted
      return _exhaustive
    }
  }
}

/** A reason the forge ended on "Nothing was written.": the closing lines say it, or say what was kept. */
const unwritten = (reason: string): string => reason.replace(/\s*Nothing was written\.$/, '')

/** What a competing pull request leaves a person: review it, or wait — and, in a service's repository, `--local`. */
const remedyFor = (opened: Opened): string =>
  opened.forge.repository === 'service'
    ? 'Review it there, or run this again once it is merged or closed, or add --local to cut the branch in this clone only. Nothing was written.'
    : 'Review it there, or run this again once it is merged or closed. Nothing was written.'

/**
 * What the forge said, as the run's result and its `--json` key — the same
 * words whether it said them before the prompt or at the moment of writing.
 * A pull request not opened, and one closed, are negative answers (exit 1),
 * as a refusal is; so is a pull request in flight that competes with this
 * change. A change another account already proposed is named, exit 0. What
 * names another person — their login, their branch, their patch — goes to
 * `inFlight`, stderr, before the result; the result names numbers, URLs and
 * this change's own paths.
 */
function outcomeOf(
  submitted: Submitted,
  opened: Opened,
  said: (status: PreviewStatus) => string,
  noting: (line: string) => void,
  inFlight: (line: string) => void = noting,
): { readonly result: CommandResult; readonly report: SubmissionReport } {
  const { base, road } = opened
  switch (submitted.outcome) {
    case 'created':
    case 'already-submitted': {
      const { pullRequest, olderBase } = submitted
      const statusChecks = submitted.outcome === 'created' ? submitted.statusChecks : undefined
      const note = submitted.outcome === 'created' ? submitted.note : undefined
      const beside = submitted.outcome === 'created' ? (submitted.beside ?? []) : []
      if (note !== undefined && road.kind === 'github') {
        noting(one(noteLine(note, road.base, submitted.outcome === 'created' ? (submitted.missing ?? []) : [])))
      }
      const status: PreviewStatus = {
        kind: 'submitted',
        again: submitted.outcome === 'already-submitted',
        branch: submitted.branch,
        base,
        road,
        ...(pullRequest === undefined ? {} : { pullRequest }),
        ...(olderBase === undefined ? {} : { olderBase }),
        ...(statusChecks === undefined ? {} : { statusChecks }),
        ...(note === undefined ? {} : { note }),
        ...(beside.length === 0 || road.kind !== 'github' ? {} : { beside: besideOf(beside, road) }),
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
          ...(note === undefined ? {} : { note }),
          ...(beside.length === 0 || road.kind !== 'github' ? {} : { beside: beside.map((entry) => reportOf(entry, road)) }),
        },
        result: { text: said(status), found: true },
      }
    }
    case 'unchanged':
      return { report: submitted, result: { text: said({ kind: 'preview' }), found: true } }
    case 'refused': {
      if (submitted.inFlight !== undefined && road.kind === 'github') {
        // Another person's pull request: who and from where, then what it
        // changes of this change's files, on stderr; numbers, URLs and paths on stdout.
        for (const { pull } of submitted.inFlight) inFlight(whoLine(pull))
        for (const line of patchLines(submitted.inFlight, road)) inFlight(line)
        const reasons = submitted.inFlight.map((entry) => competingLine(entry, road))
        return {
          report: { outcome: 'refused', reasons, inFlight: submitted.inFlight.map((entry) => reportOf(entry, road)) },
          result: { text: said({ kind: 'refused', reasons, remedy: remedyFor(opened) }), found: false },
        }
      }
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
    case 'already-proposed': {
      if (road.kind !== 'github') throw new Error('a local road never meets a pull request')
      // The owner's words, on stderr: the author is named there and nowhere else.
      inFlight(`already proposed by ${one(submitted.by)} in pull request #${String(submitted.number)}`)
      return {
        report: { outcome: 'already-proposed', branch: submitted.branch, number: submitted.number, url: submitted.url },
        result: {
          text: said({
            kind: 'already-proposed',
            number: submitted.number,
            url: submitted.url,
            repository: printedRepository(road.repository),
          }),
          found: true,
        },
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
