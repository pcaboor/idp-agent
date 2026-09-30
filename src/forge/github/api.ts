import {
  branchAnswer,
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
import { printedRepository, type GitHubRepository } from '../../core/github/remote.js'
import { GH_LIMITS, GhError, ghIn, type GhAnswer, type GhClient, type GhProcess, type GhRoute } from '../../process/gh.js'
import { GITHUB_LIMITS } from './limits.js'

/**
 * GitHub, as this build reads it: through gh, one typed method per route
 * (stage 6 brief § 6), each answer's status held to what the route expects
 * and its body parsed against the schema of the fields a decision needs
 * (`core/github/answers.ts`). What goes wrong is said in this build's words
 * (`GitHubAnswerError`), never GitHub's or gh's, which a repository or a
 * server can reach. The routes of a commit, the pull requests and the one
 * write arrive with the forge that reads them (stage 6 plan, Task 6.2.1).
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

/** The route an answer came from: one of the eight reads, the one write, or gh's `--version`. */
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
  const ask = async (route: GhRoute): Promise<GhAnswer> => {
    if (gh.calls() >= GITHUB_LIMITS.ghCalls) {
      throw new Error(`idp-agent made more than ${String(GITHUB_LIMITS.ghCalls)} gh calls in one run`)
    }
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

  const { owner, name } = repository
  const where = printedRepository(repository)

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
    calls: () => gh.calls(),
  }
}
