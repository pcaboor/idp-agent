import {
  branchAnswer,
  commitAnswer,
  openPullsAnswer,
  pullAnswer,
  pullFilesAnswer,
  pullsAnswer,
  refAnswer,
  repositoryAnswer,
  rulesAnswer,
  rulesetAnswer,
  userAnswer,
  type BranchAnswer,
  type RepositoryAnswer,
  type RulesAnswer,
  type RulesetAnswer,
} from '../../core/github/answers.js'
import type { InFlightFile } from '../../core/github/in-flight.js'
import { isBranch, printedRepository, type GitHubRepository } from '../../core/github/remote.js'
import { GH_LIMITS, GhError, ghIn, type GhAnswer, type GhClient, type GhProcess, type GhRoute } from '../../process/gh.js'
import { GITHUB_LIMITS } from './limits.js'

/**
 * GitHub, as this build reads it: through gh, one typed method per route
 * (stage 6 brief § 6), each answer's status held to what the route expects
 * and its body parsed against the schema of the fields a decision needs
 * (`core/github/answers.ts`). What goes wrong is said in this build's words
 * (`GitHubAnswerError`), never GitHub's or gh's, which a repository or a
 * server can reach. The routes of a commit and of the pull requests, and the
 * one write, are the GitHub forge's (`forge.ts`): the write at most once per
 * run, whatever the first one answered. The two reads of what is in flight
 * (Task 6.3.6) are `in-flight.ts`'s, and the only routes read a page at a
 * time: a next page is said, never followed here.
 */

/**
 * The one caller of `ghIn` in src/: cli/ reaches gh through this, never the
 * launcher. `run` is `spawnGh` unless a test hands the fake
 * (`MainDeps.gh`); `env` is the person's, which the launcher passes on minus
 * what § 5 removes.
 */
export function githubClient(options: { readonly env?: NodeJS.ProcessEnv; readonly run?: GhProcess }): GhClient {
  return ghIn({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.run === undefined ? {} : { run: options.run }),
  })
}

/** What an answer's failure is: an HTTP status, or what kept an answer from being read at all. */
export type AnswerStatus = number | 'timeout' | 'too-large' | 'unreadable' | 'paginated'

/** The route an answer came from: one of the ten reads, the one write, or gh's `--version`. */
export type AnswerRoute = GhRoute['route'] | 'open-pull-request' | 'version'

const NOTHING = 'Nothing was written.'

/** How many rules the one page of the rules route holds: `per_page=100`, as the launcher writes the path. */
const RULES_PAGE = 100

/** One sentence per class of failure (§ 15), naming the route and the status, never an answer's words. */
const said = (route: AnswerRoute, status: AnswerStatus, repository: GitHubRepository): string => {
  const where = `${repository.owner}/${repository.name}`
  if (typeof status === 'number') {
    if (status === 401) {
      return `github.com refused gh's login during the run (401 on ${route}): run gh auth login --hostname github.com again. ${NOTHING}`
    }
    if (status === 403) {
      return (
        `github.com answered 403 through gh on ${route}: your account cannot do this on ${where}, or GitHub is ` +
        `limiting how fast it may be asked; it does not say which. ${NOTHING}`
      )
    }
    if (status === 404) {
      return (
        `github.com answered 404 through gh on ${route}: ${where} does not exist, or your account cannot see it; ` +
        `GitHub does not say which. ${NOTHING}`
      )
    }
    if (status >= 500 && status <= 599) {
      return `github.com answered ${String(status)} through gh on ${route}; try again later. ${NOTHING}`
    }
    return `github.com answered ${String(status)} through gh on ${route}, which this build does not read. ${NOTHING}`
  }
  switch (status) {
    case 'timeout':
      return `gh did not answer within ${String(GH_LIMITS.timeoutMs / 1000)} s on ${route}. ${NOTHING}`
    case 'too-large':
      return `gh's answer on ${route} was over 1 MiB, more than this build reads. ${NOTHING}`
    case 'unreadable':
      return `gh's answer on ${route} could not be read. ${NOTHING}`
    case 'paginated':
      return `github.com's answer on ${route} runs to more than one page, which this build does not read. ${NOTHING}`
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

/**
 * GitHub's answer, at run time, was not one this build can act on: exit 1
 * when a command reaches it. Not the person's arguments — those are
 * `ForgeInputError`s, which `readIdentity` makes of the answers that mean gh
 * is not logged in as a person. `sentence`, when a route has more to say than
 * its class — which branch has no ref, how many rules were too many — is
 * written by this build too, and names only what passed a grammar.
 */
export class GitHubAnswerError extends Error {
  constructor(
    readonly route: AnswerRoute,
    readonly status: AnswerStatus,
    repository: GitHubRepository,
    sentence?: string,
  ) {
    super(sentence ?? said(route, status, repository))
    this.name = 'GitHubAnswerError'
  }
}

/** A `GhError` the client raised, as the status it stands for: gh's exit 4 is GitHub refusing the login. */
export const statusOf = (error: GhError): AnswerStatus => {
  switch (error.kind) {
    case 'auth':
      return 401
    case 'timeout':
      return 'timeout'
    case 'too-large':
      return 'too-large'
    case 'missing':
    case 'unreadable':
    case 'failed':
      return 'unreadable'
    default: {
      const _exhaustive: never = error.kind
      return _exhaustive
    }
  }
}

/** A commit on GitHub, as recognition compares it (§ 14): its tree, its parents and its message. */
export interface GitHubCommit {
  readonly sha: string
  readonly tree: string
  readonly parents: readonly string[]
  readonly message: string
}

/**
 * A pull request from a branch, as § 14's table reads it: `merged` from
 * `merged_at`, and, on a closed one, `at` the day it was merged or closed,
 * `YYYY-MM-DD`, read from the start of GitHub's date and nothing else of it;
 * `base` held to the grammar of a branch, since a sentence names it.
 */
export type PullRequestFrom = {
  readonly number: number
  readonly base: string
  readonly head: string
} & (
  | { readonly state: 'open'; readonly merged: false; readonly at: undefined }
  | { readonly state: 'closed'; readonly merged: boolean; readonly at: string }
)

/**
 * An open pull request into the base, as the in-flight read lists it: its
 * number, its author's login as GitHub wrote it (unchecked: `in-flight.ts`
 * holds a candidate's to `isLogin`), its head's branch and commit, and the
 * repository the head is a branch of (`null`: a fork GitHub no longer holds).
 * Never its title nor its body, which the schema does not name.
 */
export interface OpenPull {
  readonly number: number
  readonly by: string | undefined
  readonly branch: string
  readonly head: string
  readonly repository: string | null
}

/** The pull request a submission opens: the engine's title and body, from `head` into `base`. */
export interface PullRequestAsked {
  readonly title: string
  readonly head: string
  readonly base: string
  readonly body: string
}

/** The account gh acts as, as `/user` names it: the two fields a decision reads, and nothing else kept. */
export interface GitHubUser {
  readonly login: string
  readonly type: string
}

export interface GitHubApi {
  /** `GET user`: whom gh is logged in as. */
  user(): Promise<GitHubUser>
  /** `GET repos/<o>/<r>`: its name as GitHub answers it, whether it is archived, what gh's account may do (§ 8, item 1). */
  repository(): Promise<RepositoryAnswer>
  /** `GET repos/<o>/<r>/rules/branches/<base>`: every active rule for the base, one page, never followed to a second (item 2). */
  rules(base: string): Promise<RulesAnswer>
  /** `GET repos/<o>/<r>/rulesets/<id>`: whether gh's account can bypass it, and who can (item 3). */
  ruleset(id: number): Promise<RulesetAnswer>
  /** `GET repos/<o>/<r>/branches/<base>`: whether classic branch protection covers it (item 4). */
  branch(base: string): Promise<BranchAnswer>
  /** `GET repos/<o>/<r>/git/ref/heads/<branch>`: the commit the branch is at on GitHub. */
  ref(branch: string): Promise<string>
  /** `GET repos/<o>/<r>/git/commits/<sha>`: a commit's tree, parents and message (§ 14). */
  commit(sha: string): Promise<GitHubCommit>
  /** `GET repos/<o>/<r>/pulls?head=…&state=all`: every pull request from the branch, one page of 100. */
  pulls(branch: string): Promise<readonly PullRequestFrom[]>
  /** `GET …/pulls?state=open&base=<base>&sort=created&direction=desc&per_page=100&page=<p>`: one page, and whether GitHub links a next. */
  openPulls(base: string, page: number): Promise<{ readonly pulls: readonly OpenPull[]; readonly more: boolean }>
  /** `GET …/pulls/<n>/files?per_page=100`: one page, and whether it was the whole list. */
  pullFiles(number: number): Promise<{ readonly files: readonly InFlightFile[]; readonly complete: boolean }>
  /**
   * `POST repos/<o>/<r>/pulls`, the one write, its body on stdin: the number
   * GitHub gave it, from a 201. At most once per API: a second call throws
   * before any process starts, whatever the first answered — a timed-out or
   * lost one included.
   */
  openPullRequest(input: PullRequestAsked): Promise<{ readonly number: number }>
  /** How many gh processes this run has started, the version's included: `idp.forge.gh_calls`. */
  calls(): number
}

/**
 * The API over `gh`, for `repository`. Every method checks the run's budget
 * first — `GITHUB_LIMITS.ghCalls`, which § 15's figures add up to exactly, so
 * one more is a programming error, thrown before any call — then asks, and
 * holds the answer to its route.
 */
export function githubApi(gh: GhClient, repository: GitHubRepository): GitHubApi {
  const spend = (): void => {
    if (gh.calls() >= GITHUB_LIMITS.ghCalls) {
      throw new Error(`idp-agent made more than ${String(GITHUB_LIMITS.ghCalls)} gh calls in one run`)
    }
  }
  const ask = async (route: GhRoute): Promise<GhAnswer> => {
    spend()
    try {
      return await gh.get(route)
    } catch (error) {
      if (error instanceof GhError) throw new GitHubAnswerError(route.route, statusOf(error), repository)
      throw error
    }
  }

  /** The body as JSON, within the one-answer bound; undefined when it is not JSON. */
  const json = (route: AnswerRoute, answer: GhAnswer): unknown => {
    if (Buffer.byteLength(answer.body, 'utf8') > GH_LIMITS.maxOutputBytes) {
      throw new GitHubAnswerError(route, 'too-large', repository)
    }
    try {
      return JSON.parse(answer.body) as unknown
    } catch {
      return undefined
    }
  }

  /**
   * One read: a 200, one page — a `Link` to a next one is refused, never
   * followed — and a body that parses against `schema`, else a
   * `GitHubAnswerError` for the route; `sentences` says more than the class
   * for the statuses a route has more to say about.
   */
  const read = async <T>(
    route: GhRoute,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    sentences: { readonly paginated?: string; readonly 404?: string } = {},
  ): Promise<T> => {
    const answer = await ask(route)
    if (answer.status !== 200) {
      throw new GitHubAnswerError(route.route, answer.status, repository, answer.status === 404 ? sentences[404] : undefined)
    }
    if (answer.hasNext) throw new GitHubAnswerError(route.route, 'paginated', repository, sentences.paginated)
    const parsed = schema.safeParse(json(route.route, answer))
    if (!parsed.success) throw new GitHubAnswerError(route.route, 'unreadable', repository)
    return parsed.data
  }

  /**
   * One page of the in-flight reads: a 200 and a body that parses against
   * `schema`, and whether a `Link` names a next page — said to the caller,
   * which decides whether to ask it, never followed here.
   */
  const page = async <T>(
    route: GhRoute,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): Promise<{ readonly data: T; readonly hasNext: boolean }> => {
    const answer = await ask(route)
    if (answer.status !== 200) throw new GitHubAnswerError(route.route, answer.status, repository)
    const parsed = schema.safeParse(json(route.route, answer))
    if (!parsed.success) throw new GitHubAnswerError(route.route, 'unreadable', repository)
    return { data: parsed.data, hasNext: answer.hasNext }
  }

  const { owner, name } = repository
  const where = printedRepository(repository)
  /** Set before the one POST starts, so a POST whose answer was lost still counts. */
  let asked = false

  return {
    user: async () => {
      const parsed = await read({ route: 'user' }, userAnswer)
      return { login: parsed.login, type: parsed.type }
    },
    repository: () => read({ route: 'repository', owner, name }, repositoryAnswer),
    rules: (base) =>
      read({ route: 'rules', owner, name, branch: base }, rulesAnswer, {
        paginated: `${where}'s ${base} has more than ${String(RULES_PAGE)} rules, more than this build reasons about. ${NOTHING}`,
      }),
    ruleset: async (id) => {
      const parsed = await read({ route: 'ruleset', owner, name, id }, rulesetAnswer)
      // An answer about another ruleset is not an answer about this one.
      if (parsed.id !== id) throw new GitHubAnswerError('ruleset', 'unreadable', repository)
      return parsed
    },
    branch: (base) => read({ route: 'branch', owner, name, branch: base }, branchAnswer),
    ref: async (branch) => {
      const parsed = await read({ route: 'ref', owner, name, branch }, refAnswer, {
        404:
          `github.com answered 404 through gh on ref: ${where} has no branch ${branch}, or your account cannot see it; ` +
          `GitHub does not say which. ${NOTHING}`,
      })
      if (parsed.ref !== `refs/heads/${branch}`) throw new GitHubAnswerError('ref', 'unreadable', repository)
      return parsed.object.sha
    },
    commit: async (sha) => {
      const parsed = await read({ route: 'commit', owner, name, sha }, commitAnswer)
      // An answer about another commit is not an answer about this one.
      if (parsed.sha !== sha) throw new GitHubAnswerError('commit', 'unreadable', repository)
      return {
        sha: parsed.sha,
        tree: parsed.tree.sha,
        parents: parsed.parents.map((parent) => parent.sha),
        message: parsed.message,
      }
    },
    pulls: async (branch) => {
      const parsed = await read({ route: 'pulls', owner, name, head: branch }, pullsAnswer, {
        paginated: `${where} has more than ${String(GITHUB_LIMITS.pullsPage)} pull requests from ${branch}, more than this build reads. ${NOTHING}`,
      })
      // Each from this branch, into a branch a sentence may name: or none of it is read.
      if (parsed.some((one) => one.head.ref !== branch || !isBranch(one.base.ref))) {
        throw new GitHubAnswerError('pulls', 'unreadable', repository)
      }
      return parsed.map((one): PullRequestFrom => {
        const fields = { number: one.number, base: one.base.ref, head: one.head.ref }
        if (one.state === 'open') return { ...fields, state: 'open', merged: false, at: undefined }
        // GitHub dates every closed pull request: one it gives no day for is
        // not read, rather than a day put in its place.
        const at = /^\d{4}-\d{2}-\d{2}/.exec(one.merged_at ?? one.closed_at ?? '')?.[0]
        if (at === undefined) throw new GitHubAnswerError('pulls', 'unreadable', repository)
        return { ...fields, state: 'closed', merged: one.merged_at !== null, at }
      })
    },
    openPulls: async (base, number) => {
      const { data, hasNext } = await page({ route: 'open-pulls', owner, name, base, page: number }, openPullsAnswer)
      // Each into the base asked about: or none of it is read.
      if (data.some((one) => one.base.ref !== base)) throw new GitHubAnswerError('open-pulls', 'unreadable', repository)
      return {
        pulls: data.map(
          (one): OpenPull => ({
            number: one.number,
            by: one.user?.login,
            branch: one.head.ref,
            head: one.head.sha,
            repository: one.head.repo?.full_name ?? null,
          }),
        ),
        more: hasNext,
      }
    },
    pullFiles: async (number) => {
      const { data, hasNext } = await page({ route: 'pull-files', owner, name, number }, pullFilesAnswer)
      return {
        files: data.map((one): InFlightFile => {
          const removed = one.status === 'removed'
          return {
            path: one.filename,
            removed,
            ...(one.previous_filename === undefined ? {} : { previous: one.previous_filename }),
            ...(removed || one.sha === null ? {} : { blob: one.sha }),
            ...(one.patch === undefined ? {} : { patch: one.patch }),
          }
        }),
        complete: !hasNext,
      }
    },
    openPullRequest: async (input) => {
      if (asked) throw new Error('idp-agent asked to open a second pull request in one run')
      if (Buffer.byteLength(input.body, 'utf8') > GITHUB_LIMITS.bodyBytes) {
        throw new GitHubAnswerError(
          'open-pull-request',
          'too-large',
          repository,
          `the pull request's body is over 1 MiB, more than this build sends. ${NOTHING}`,
        )
      }
      spend()
      // The one form the launcher admits: these six keys, in this order, no white space.
      const body = JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: false,
        maintainer_can_modify: false,
      })
      asked = true
      let answer: GhAnswer
      try {
        answer = await gh.openPullRequest(owner, name, body)
      } catch (error) {
        if (error instanceof GhError) throw new GitHubAnswerError('open-pull-request', statusOf(error), repository)
        throw error
      }
      if (answer.status !== 201) throw new GitHubAnswerError('open-pull-request', answer.status, repository)
      const parsed = pullAnswer.safeParse(json('open-pull-request', answer))
      // What GitHub says it opened must be what was asked.
      if (!parsed.success || parsed.data.head.ref !== input.head || parsed.data.base.ref !== input.base) {
        throw new GitHubAnswerError('open-pull-request', 'unreadable', repository)
      }
      return { number: parsed.data.number }
    },
    calls: () => gh.calls(),
  }
}
