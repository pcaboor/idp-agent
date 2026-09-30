/**
 * A fake gh: a model of the GitHub that `gh api` answers, for the tests and
 * for `pnpm demo:github` (stage 6 brief § 10).
 *
 * It reads the argument vector with its own patterns, written apart from the
 * launcher's grammar (`src/process/gh.ts`), so that a drift between what the
 * launcher sends and what idp-agent means to send fails a test rather than
 * passing both. It answers as gh prints an `--include` answer: the status line,
 * the headers, a blank line, the body, and gh's exit code — 0 for a 2xx, 1 for
 * another status, 4 when no login is found.
 *
 * What it models: whether gh is installed, its version, the accounts and the
 * one gh is logged in as (or none), an expired login, and a `/user` GitHub
 * refuses (an App's token); repositories — their name, whether they are
 * archived, each account's permissions, their branches and whether classic
 * protection covers each, their rulesets, and the refs and commits of a bare
 * repository on disk, read (and, for a merge or a push, written) with the
 * fake's own git; and pull requests, with their author, their reviews and
 * who pushed their head last.
 *
 * And the doors a person could try as the pull request's author (§ 10): a
 * merge, through `gh pr merge` or the API, judged as the rules would judge it
 * — refused (405) unless someone other than the author and the last pusher
 * approved the head, or the merger may bypass the ruleset; an approval by the
 * author (422); a write to a base the rules protect (409, "Repository rule
 * violations found"). Classic branch protection is not modelled: it binds
 * nobody here, as it binds no administrator on GitHub without "Do not allow
 * bypassing". Each answer is the fake's guess until the owner's live run
 * records GitHub's (6.4.1). Every other vector is "not a vector idp-agent
 * sends", exit 97; a write the fake does not model is "not modelled".
 *
 * It runs under Node's type stripping (22.18 or later), so it holds no syntax
 * stripping cannot erase, and imports only `node:` built-ins:
 * `tests/support/fake-gh.ts` wraps `answer` as the process a test hands the
 * launcher, and typechecks it. Run as a program — `node tools/fake-gh.ts
 * <gh's arguments>`, as `pnpm demo:github` puts it first on PATH as `gh` — it
 * reads the world from the JSON file `FAKE_GH_STATE` names, answers as
 * `answer` does, and writes the world back when the answer changed it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** An account GitHub knows: a person, or a bot. */
export interface Account {
  readonly login: string
  readonly type: 'User' | 'Bot' | 'Organization'
}

/** Who may bypass a ruleset, as GitHub lists an actor; `actor_id` is an account's id for a `User`. */
export interface FakeBypassActor {
  readonly actor_type: string
  readonly actor_id: number | null
  readonly bypass_mode: 'always' | 'pull_request' | 'exempt'
}

/** A ruleset on a repository's branches, named exactly (no pattern). */
export interface FakeRuleset {
  readonly id: number
  readonly enforcement: 'active' | 'evaluate' | 'disabled'
  readonly branches: readonly string[]
  readonly rules: readonly { readonly type: string; readonly parameters?: Record<string, unknown> }[]
  readonly bypass: readonly FakeBypassActor[]
  /**
   * What `current_user_can_bypass` answers whatever the list says, for the
   * answers GitHub gives that the list does not explain; `null` leaves the
   * field out.
   */
  readonly canBypass?: string | null
}

/** What an account may do in a repository. */
export interface FakePermission {
  readonly admin: boolean
  readonly maintain: boolean
  readonly push: boolean
}

export interface FakeRepository {
  readonly owner: string
  readonly name: string
  /** What `full_name` answers, when the repository was renamed or transferred. */
  readonly fullName?: string
  readonly archived: boolean
  /** By login; an account not listed may read, as on a public repository, and nothing more. */
  readonly permissions: Readonly<Record<string, FakePermission>>
  /** A bare repository whose `refs/heads/*` are the branches' commits on GitHub. */
  readonly bare?: string
  readonly branches: Readonly<Record<string, { readonly protected: boolean }>>
  readonly rulesets: readonly FakeRuleset[]
}

/** A pull request, as the model holds it: GitHub's fields a test or a door reads, and who did what. */
export interface FakePull {
  number: number
  owner: string
  name: string
  title: string
  body: string
  head: string
  base: string
  draft: boolean
  maintainer_can_modify: boolean
  author: string
  state: 'open' | 'closed'
  merged_at: string | null
  closed_at: string | null
  /** Who pushed the head last: the author when it is opened, then whoever pushed on top of it. */
  lastPusher: string
  /** Each approval, at the commit the head was at when it was given. */
  reviews: { login: string; commit: string }[]
}

/**
 * The next `times` calls of `route` answered `status` — an HTTP status, or
 * `lost`: an exit 1 with nothing on stdout, as a connection dropped under gh.
 * `made`: the call is carried out first, and only its answer replaced (a pull
 * request opened, then its answer lost); by default a status is answered
 * instead of the call, and a lost answer after it.
 */
export interface FakeFault {
  route: string
  status: number | 'lost'
  times: number
  made?: boolean
}

export interface FakeState {
  installed: boolean
  /** What `gh --version` says, e.g. `2.40.0`. */
  version: string
  accounts: Account[]
  /** Whom gh is logged in as, or nobody; an expired login answers 401. */
  session: { login: string; expired?: true } | undefined
  /** `/user` refused (403), as for an App's installation token. */
  userRefused?: true
  repositories: FakeRepository[]
  pulls?: FakePull[]
  faults?: FakeFault[]
}

/** What the process answered: the shape of `src/process/gh.ts`'s `GhExit`. */
export interface FakeExit {
  readonly code: number | string | undefined
  readonly stdout: Buffer
  readonly stderr: string
  readonly timedOut: boolean
}

/** The exit a vector outside what idp-agent sends gets, and a route not modelled yet. */
export const REFUSED_EXIT = 97

/** A fresh model: gh 2.40.0, installed, one person `ada`, logged in as her. */
export function initialState(): FakeState {
  return {
    installed: true,
    version: '2.40.0',
    accounts: [{ login: 'ada', type: 'User' }],
    session: { login: 'ada' },
    repositories: [],
  }
}

const exit = (code: number | string, stdout: string, stderr = ''): FakeExit => ({
  code,
  stdout: Buffer.from(stdout, 'utf8'),
  stderr,
  timedOut: false,
})

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  502: 'Bad Gateway',
}

/** An answer as `gh api --include` prints it, and the exit gh gives it; `headers` are added to its own. */
const included = (status: number, body: unknown, headers: readonly string[] = []): FakeExit =>
  exit(
    status >= 200 && status < 300 ? 0 : 1,
    `HTTP/2.0 ${String(status)} ${REASONS[status] ?? 'Status'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      headers.map((header) => `${header}\r\n`).join('') +
      'X-Github-Media-Type: github.v3; format=json\r\n\r\n' +
      JSON.stringify(body),
    status >= 200 && status < 300 ? '' : `gh: ${REASONS[status] ?? 'Status'} (HTTP ${String(status)})\n`,
  )

const refused = (): FakeExit => exit(REFUSED_EXIT, '', 'fake gh: not a vector idp-agent sends\n')
const notModelled = (route: string): FakeExit => exit(REFUSED_EXIT, '', `fake gh: ${route} is not modelled\n`)

// ---------------------------------------------------------------- the vector, read apart

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9-])){0,38}$/
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/
const COMPONENT = /^(?:[A-Za-z0-9_~-]|\.(?!\.)|%[0-9A-F]{2})+$/
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SUBMISSION = /^idp-agent\/[a-z0-9-]+-[0-9a-f]{8}$/

/** A branch written as a path of encoded components: no component empty, dotted or holding a slash once decoded. */
const branchPath = (written: string): string | undefined => {
  const components = written.split('/')
  const decoded: string[] = []
  for (const component of components) {
    if (!COMPONENT.test(component) || component.startsWith('.')) return undefined
    let plain: string
    try {
      plain = decodeURIComponent(component)
    } catch {
      return undefined
    }
    if (plain.includes('/') || /[{}%\s]/.test(plain)) return undefined
    decoded.push(plain)
  }
  return decoded.join('/')
}

/** A `GET` path, by this file's own reading: the route, and the values it names. */
interface Read {
  readonly route: 'user' | 'repository' | 'branch' | 'rules' | 'ruleset' | 'ref' | 'commit' | 'pulls'
  readonly owner: string
  readonly name: string
  /** The branch of `branch`, `rules` and `ref`, decoded; the head of `pulls`. */
  readonly branch: string
  /** The ruleset of `ruleset`. */
  readonly id: number
  /** The commit of `commit`. */
  readonly sha: string
}

/** The route a `GET` path is, by this file's own reading, or undefined for a path idp-agent never reads. */
const routeOf = (address: string): Read | undefined => {
  const read = (route: Read['route'], owner = '', name = '', branch = '', id = 0, sha = ''): Read => ({
    route,
    owner,
    name,
    branch,
    id,
    sha,
  })
  if (address === 'user') return read('user')
  const parts = /^repos\/([^/]+)\/([^/?]+)(?:\/(.*))?$/.exec(address)
  if (parts === null) return undefined
  const [, owner = '', name = '', rest] = parts
  if (!OWNER.test(owner) || !REPOSITORY.test(name) || name === '.' || name === '..') return undefined
  if (rest === undefined) return read('repository', owner, name)
  const branchRoute = (route: Read['route'], pattern: RegExp): Read | undefined => {
    const match = pattern.exec(rest)
    if (match === null) return undefined
    const branch = branchPath(match[1] ?? '')
    return branch === undefined ? undefined : read(route, owner, name, branch)
  }
  const branched =
    branchRoute('branch', /^branches\/([^?]+)$/) ??
    branchRoute('rules', /^rules\/branches\/([^?]+)\?per_page=100$/) ??
    branchRoute('ref', /^git\/ref\/heads\/([^?]+)$/)
  if (branched !== undefined) return branched
  if (/^(?:branches|rules\/branches|git\/ref\/heads)\//.test(rest)) return undefined
  let match = /^rulesets\/([1-9][0-9]*)$/.exec(rest)
  if (match !== null) return read('ruleset', owner, name, '', Number(match[1]))
  match = /^git\/commits\/([^/?]+)$/.exec(rest)
  if (match !== null) return SHA.test(match[1] ?? '') ? read('commit', owner, name, '', 0, match[1]) : undefined
  match = /^pulls\?head=([^&]+)&state=all&per_page=100$/.exec(rest)
  if (match !== null) {
    const head = decodeURIComponent(match[1] ?? '')
    return head.startsWith(`${owner}:`) && SUBMISSION.test(head.slice(owner.length + 1))
      ? read('pulls', owner, name, head.slice(owner.length + 1))
      : undefined
  }
  return undefined
}

/** The one POST, read: the repository it names and the fields of its body. */
interface Asked {
  readonly owner: string
  readonly name: string
  readonly title: string
  readonly head: string
  readonly base: string
  readonly body: string
}

/**
 * The one POST: exactly the six keys, a bare submission head, a base, no
 * draft, no maintainer edits — and written as the engine writes it, the keys
 * in that order with no white space, so a key given twice is never read.
 */
const pullRequestOf = (address: string, stdin: Buffer | undefined): Asked | undefined => {
  const parts = /^repos\/([^/]+)\/([^/]+)\/pulls$/.exec(address)
  if (parts === null || !OWNER.test(parts[1] ?? '') || !REPOSITORY.test(parts[2] ?? '')) return undefined
  if (stdin === undefined) return undefined
  const text = stdin.toString('utf8')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const fields = body as Record<string, unknown>
  const written = JSON.stringify({
    title: fields['title'],
    head: fields['head'],
    base: fields['base'],
    body: fields['body'],
    draft: fields['draft'],
    maintainer_can_modify: fields['maintainer_can_modify'],
  })
  const { title, head, base } = fields
  return written === text &&
    typeof title === 'string' &&
    typeof fields['body'] === 'string' &&
    typeof head === 'string' &&
    SUBMISSION.test(head) &&
    typeof base === 'string' &&
    branchPath(base) !== undefined &&
    fields['draft'] === false &&
    fields['maintainer_can_modify'] === false
    ? { owner: parts[1] ?? '', name: parts[2] ?? '', title, head, base, body: fields['body'] }
    : undefined
}

// ---------------------------------------------------------------- the answers

const LOGGED_OUT =
  'To get started with GitHub CLI, please run:  gh auth login\n' +
  'Alternatively, populate the environment variable with a GitHub API authentication token.\n'

const NOT_FOUND = { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }

/** How many rules one page holds, as `per_page=100` asks. */
const PAGE = 100

/** The account gh acts as, its id, or the answer that says why there is none. */
const signedIn = (state: FakeState): { readonly login: string; readonly id: number } | FakeExit => {
  const session = state.session
  if (session === undefined) return exit(4, '', LOGGED_OUT)
  if (session.expired === true) return included(401, { message: 'Bad credentials', status: '401' })
  const index = state.accounts.findIndex((account) => account.login === session.login)
  if (index === -1) return included(401, { message: 'Bad credentials', status: '401' })
  return { login: session.login, id: 1000 + index }
}

const isExit = (value: object): value is FakeExit => 'stdout' in value

/** `GET user`: the account gh is logged in as, with fields the reader never reads. */
const user = (state: FakeState): FakeExit => {
  const who = signedIn(state)
  if (isExit(who)) return who
  if (state.userRefused === true) return included(403, { message: 'Resource not accessible by integration', status: '403' })
  const account = state.accounts[who.id - 1000]
  return included(200, {
    login: who.login,
    id: who.id,
    node_id: `U_${who.login}`,
    type: account?.type,
    site_admin: false,
    name: null,
  })
}

/** GitHub's comparison of names: case does not matter. */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** What `login` may do in `repository`. */
const permissionOf = (repository: FakeRepository, login: string): FakePermission =>
  repository.permissions[login] ?? { admin: false, maintain: false, push: false }

/** The role GitHub's `RepositoryRole` actors name by id: 5 admin, 2 maintain, 4 write. */
const roleIdOf = (permission: FakePermission): number | undefined =>
  permission.admin ? 5 : permission.maintain ? 2 : permission.push ? 4 : undefined

/**
 * `current_user_can_bypass` for the account gh acts as: `always` for a
 * `User` actor that is it, or a `RepositoryRole` it holds, in that mode;
 * `exempt` and `pull_requests_only` likewise; `never` otherwise.
 */
const bypassFor = (ruleset: FakeRuleset, repository: FakeRepository, who: { login: string; id: number }): string => {
  const role = roleIdOf(permissionOf(repository, who.login))
  const modes = ruleset.bypass
    .filter(
      (actor) =>
        (actor.actor_type === 'User' && actor.actor_id === who.id) ||
        (actor.actor_type === 'RepositoryRole' && role !== undefined && actor.actor_id === role),
    )
    .map((actor) => actor.bypass_mode)
  if (modes.includes('always')) return 'always'
  if (modes.includes('exempt')) return 'exempt'
  if (modes.includes('pull_request')) return 'pull_requests_only'
  return 'never'
}

/** The fake's own git on a bare repository: isolated from every configuration, with a fixed identity for what it writes. */
const inBare = (bare: string, args: readonly string[]): string =>
  execFileSync('git', ['--git-dir', bare, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'GitHub',
      GIT_AUTHOR_EMAIL: 'noreply@github.com',
      GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'GitHub',
      GIT_COMMITTER_EMAIL: 'noreply@github.com',
      GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

/** The commit `refs/heads/<branch>` is at in the bare repository, read with the fake's own git. */
const refIn = (bare: string, branch: string): string | undefined => {
  try {
    return inBare(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  } catch {
    return undefined
  }
}

/** `ancestor` is `descendant` or one of its ancestors. */
const isAncestor = (bare: string, ancestor: string, descendant: string): boolean => {
  try {
    inBare(bare, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

/** A commit of the bare repository, as GitHub's `git/commits` route answers one, or undefined. */
const commitIn = (bare: string, sha: string, source: string): unknown => {
  let raw: string
  try {
    raw = execFileSync('git', ['--git-dir', bare, 'cat-file', 'commit', sha], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
  const split = raw.indexOf('\n\n')
  const headers = raw.slice(0, split).split('\n')
  const value = (name: string): string[] =>
    headers.filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1))
  const url = (kind: string, id: string): string => `https://api.github.com/repos/${source}/git/${kind}/${id}`
  return {
    sha,
    node_id: `C_${sha.slice(0, 8)}`,
    url: url('commits', sha),
    author: { name: 'someone', email: 'someone@example.com', date: '2026-10-01T00:00:00Z' },
    committer: { name: 'someone', email: 'someone@example.com', date: '2026-10-01T00:00:00Z' },
    tree: { sha: value('tree')[0] ?? '', url: url('trees', value('tree')[0] ?? '') },
    // The message as the commit holds it, its final newline kept: whether
    // GitHub keeps it is one of the answers the live run records (6.4.1).
    message: raw.slice(split + 2),
    parents: value('parent').map((parent) => ({ sha: parent, url: url('commits', parent) })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  }
}

/** A pull request as GitHub's pull routes answer one, with fields the reader never reads. */
const pullJson = (pull: FakePull, bare: string | undefined): unknown => {
  const at = (branch: string): string | null => (bare === undefined ? null : (refIn(bare, branch) ?? null))
  return {
    url: `https://api.github.com/repos/${pull.owner}/${pull.name}/pulls/${String(pull.number)}`,
    html_url: `https://github.com/${pull.owner}/${pull.name}/pull/${String(pull.number)}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    user: { login: pull.author, type: 'User' },
    body: pull.body,
    draft: pull.draft,
    merged_at: pull.merged_at,
    closed_at: pull.closed_at,
    head: { label: `${pull.owner}:${pull.head}`, ref: pull.head, sha: at(pull.head) },
    base: { label: `${pull.owner}:${pull.base}`, ref: pull.base, sha: at(pull.base) },
  }
}

/** The account a door is tried as, its id for the bypass lists. */
interface Who {
  readonly login: string
  readonly id: number
}

/** The active rulesets naming `branch`. */
const rulesetsOn = (repository: FakeRepository, branch: string): FakeRuleset[] =>
  repository.rulesets.filter((ruleset) => ruleset.enforcement === 'active' && ruleset.branches.includes(branch))

/** A ruleset on `branch` requiring a pull request that `who` cannot bypass: a direct write there is refused. */
const guarded = (repository: FakeRepository, branch: string, who: Who): boolean =>
  rulesetsOn(repository, branch).some(
    (ruleset) => ruleset.rules.some((rule) => rule.type === 'pull_request') && bypassFor(ruleset, repository, who) === 'never',
  )

/**
 * Whether `who` may merge `pull` now, as a ruleset on its base judges it: for
 * every pull request rule of a ruleset `who` cannot bypass, enough approvals
 * from someone other than the author — at the head's current commit when the
 * rule requires the last push's approval or dismisses stale ones, and from
 * someone other than the last pusher when it requires the last push's.
 */
const mayMerge = (repository: FakeRepository, pull: FakePull, who: Who, head: string): boolean =>
  rulesetsOn(repository, pull.base).every((ruleset) => {
    if (bypassFor(ruleset, repository, who) !== 'never') return true
    return ruleset.rules.every((rule) => {
      if (rule.type !== 'pull_request') return true
      const parameters = rule.parameters ?? {}
      const required = typeof parameters['required_approving_review_count'] === 'number' ? parameters['required_approving_review_count'] : 0
      const lastPush = parameters['require_last_push_approval'] === true
      const fresh = lastPush || parameters['dismiss_stale_reviews_on_push'] === true
      const approvers = new Set(
        pull.reviews
          .filter(
            (review) =>
              review.login !== pull.author && (!fresh || review.commit === head) && (!lastPush || review.login !== pull.lastPusher),
          )
          .map((review) => review.login),
      )
      return approvers.size >= required
    })
  })

const MERGED_AT = '2026-10-01T00:00:00Z'

/** A merge of pull request `number` by `who`, judged by the model: the status, and the bare base moved on 200. */
const merged = (state: FakeState, repository: FakeRepository, number: number, who: Who): { status: number; body: unknown } => {
  const pull = (state.pulls ?? []).find(
    (one) => one.number === number && same(one.owner, repository.owner) && same(one.name, repository.name),
  )
  if (pull === undefined) return { status: 404, body: NOT_FOUND }
  const refusal = { status: 405, body: { message: 'Pull Request is not mergeable', status: '405' } }
  if (pull.state !== 'open' || repository.bare === undefined) return refusal
  const head = refIn(repository.bare, pull.head)
  const base = refIn(repository.bare, pull.base)
  if (head === undefined || base === undefined || !isAncestor(repository.bare, base, head)) return refusal
  if (!mayMerge(repository, pull, who, head)) return refusal
  const tree = inBare(repository.bare, ['rev-parse', `${head}^{tree}`])
  const merge = inBare(repository.bare, [
    'commit-tree',
    tree,
    '-p',
    base,
    '-p',
    head,
    '-m',
    `Merge pull request #${String(number)} from ${pull.owner}/${pull.head}`,
  ])
  inBare(repository.bare, ['update-ref', `refs/heads/${pull.base}`, merge, base])
  Object.assign(pull, { state: 'closed', merged_at: MERGED_AT, closed_at: MERGED_AT })
  return { status: 200, body: { sha: merge, merged: true, message: 'Pull Request successfully merged' } }
}

/** An approval of pull request `number` by `who`: GitHub refuses the author's own (422). */
const approved = (state: FakeState, repository: FakeRepository, number: number, who: Who): { status: number; body: unknown } => {
  const pull = (state.pulls ?? []).find(
    (one) => one.number === number && same(one.owner, repository.owner) && same(one.name, repository.name),
  )
  if (pull === undefined || repository.bare === undefined) return { status: 404, body: NOT_FOUND }
  if (pull.author === who.login) {
    return { status: 422, body: { message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] } }
  }
  const head = refIn(repository.bare, pull.head)
  if (head === undefined) return { status: 422, body: { message: 'Unprocessable Entity' } }
  pull.reviews.push({ login: who.login, commit: head })
  return { status: 200, body: { state: 'APPROVED', user: { login: who.login } } }
}

/** A route of one repository, answered for the account gh acts as. */
const ofRepository = (state: FakeState, read: Read): FakeExit => {
  const who = signedIn(state)
  if (isExit(who)) return who
  const repository = state.repositories.find((candidate) => same(candidate.owner, read.owner) && same(candidate.name, read.name))
  if (repository === undefined) return included(404, NOT_FOUND)
  const permission = permissionOf(repository, who.login)
  const source = `${repository.owner}/${repository.name}`
  switch (read.route) {
    case 'repository':
      return included(200, {
        id: 1,
        node_id: 'R_1',
        name: repository.name,
        full_name: repository.fullName ?? source,
        owner: { login: repository.owner, type: 'Organization' },
        private: false,
        description: 'the declarations',
        archived: repository.archived,
        default_branch: 'main',
        permissions: { ...permission, triage: permission.push, pull: true },
      })
    case 'branch': {
      const branch = repository.branches[read.branch]
      if (branch === undefined) return included(404, { ...NOT_FOUND, message: 'Branch not found' })
      return included(200, { name: read.branch, protected: branch.protected, protection_url: 'https://api.github.com/…' })
    }
    case 'rules': {
      const rules = rulesetsOn(repository, read.branch).flatMap((ruleset) =>
        ruleset.rules.map((rule) => ({
          type: rule.type,
          ruleset_source_type: 'Repository',
          ruleset_source: source,
          ruleset_id: ruleset.id,
          ...(rule.parameters === undefined ? {} : { parameters: rule.parameters }),
        })),
      )
      const next = `<https://api.github.com/repositories/1/rules/branches/${read.branch}?per_page=${String(PAGE)}&page=2>`
      return included(200, rules.slice(0, PAGE), rules.length > PAGE ? [`Link: ${next}; rel="next", ${next}; rel="last"`] : [])
    }
    case 'ruleset': {
      const ruleset = repository.rulesets.find((candidate) => candidate.id === read.id)
      if (ruleset === undefined) return included(404, NOT_FOUND)
      const bypass = ruleset.canBypass === undefined ? bypassFor(ruleset, repository, who) : ruleset.canBypass
      return included(200, {
        id: ruleset.id,
        name: `ruleset ${String(ruleset.id)}`,
        target: 'branch',
        source_type: 'Repository',
        source,
        enforcement: ruleset.enforcement,
        conditions: { ref_name: { include: ruleset.branches.map((branch) => `refs/heads/${branch}`), exclude: [] } },
        rules: ruleset.rules,
        ...(bypass === null ? {} : { current_user_can_bypass: bypass }),
        // Shown only to someone who may edit the ruleset.
        ...(permission.admin ? { bypass_actors: ruleset.bypass } : {}),
      })
    }
    case 'ref': {
      const sha = repository.bare === undefined ? undefined : refIn(repository.bare, read.branch)
      if (sha === undefined) return included(404, NOT_FOUND)
      return included(200, {
        ref: `refs/heads/${read.branch}`,
        node_id: 'REF_1',
        object: { sha, type: 'commit', url: `https://api.github.com/repos/${source}/git/commits/${sha}` },
      })
    }
    case 'commit': {
      const commit = repository.bare === undefined ? undefined : commitIn(repository.bare, read.sha, source)
      return commit === undefined ? included(404, NOT_FOUND) : included(200, commit)
    }
    case 'pulls':
      return included(
        200,
        (state.pulls ?? [])
          .filter((pull) => same(pull.owner, repository.owner) && same(pull.name, repository.name) && pull.head === read.branch)
          .sort((a, b) => b.number - a.number)
          .map((pull) => pullJson(pull, repository.bare)),
      )
    case 'user':
      return user(state)
    default: {
      const _exhaustive: never = read.route
      return _exhaustive
    }
  }
}

/** The one POST, carried out: a pull request opened by the account gh acts as, or GitHub's refusal. */
const opened = (state: FakeState, asked: Asked): FakeExit => {
  const who = signedIn(state)
  if (isExit(who)) return who
  const repository = state.repositories.find((candidate) => same(candidate.owner, asked.owner) && same(candidate.name, asked.name))
  if (repository === undefined) return included(404, NOT_FOUND)
  if (!permissionOf(repository, who.login).push) return included(403, { message: 'Resource not accessible', status: '403' })
  const invalid = (message: string): FakeExit => included(422, { message: 'Validation Failed', errors: [{ message }], status: '422' })
  const bare = repository.bare
  if (bare === undefined || refIn(bare, asked.head) === undefined) return invalid('head is invalid')
  if (refIn(bare, asked.base) === undefined) return invalid('base is invalid')
  const pulls = (state.pulls ??= [])
  const mine = pulls.filter((pull) => same(pull.owner, repository.owner) && same(pull.name, repository.name))
  if (mine.some((pull) => pull.state === 'open' && pull.head === asked.head && pull.base === asked.base)) {
    return invalid(`A pull request already exists for ${repository.owner}:${asked.head}.`)
  }
  const pull: FakePull = {
    number: Math.max(0, ...mine.map((one) => one.number)) + 1,
    owner: repository.owner,
    name: repository.name,
    title: asked.title,
    body: asked.body,
    head: asked.head,
    base: asked.base,
    draft: false,
    maintainer_can_modify: false,
    author: who.login,
    state: 'open',
    merged_at: null,
    closed_at: null,
    lastPusher: who.login,
    reviews: [],
  }
  pulls.push(pull)
  return included(201, pullJson(pull, bare))
}

/** The repository a `gh pr` command acts on: gh reads it from the current directory; the fake holds one. */
const current = (state: FakeState): FakeRepository | undefined => state.repositories[0]

/**
 * A door of § 10, answered by the model: a merge, an approval, a write to a
 * base. Undefined for a vector the model does not answer.
 */
const door = (state: FakeState, argv: readonly string[], stdin: Buffer | undefined): FakeExit | undefined => {
  const who = signedIn(state)
  // `gh pr merge <n> --merge|--squash|--rebase [--admin]` and `gh pr review <n> --approve`.
  if (argv[0] === 'pr') {
    const [, verb = '', number = '', ...flags] = argv
    if (!/^[1-9][0-9]*$/.test(number)) return undefined
    const methods = ['--merge', '--squash', '--rebase']
    const isMerge =
      verb === 'merge' &&
      flags.filter((flag) => methods.includes(flag)).length === 1 &&
      flags.every((flag) => methods.includes(flag) || flag === '--admin')
    const isApproval = verb === 'review' && flags.length === 1 && flags[0] === '--approve'
    if (!isMerge && !isApproval) return undefined
    if (isExit(who)) return who
    const repository = current(state)
    if (repository === undefined) return exit(1, '', 'GraphQL: Could not resolve to a Repository\n')
    const answered = isMerge ? merged(state, repository, Number(number), who) : approved(state, repository, Number(number), who)
    return answered.status === 200 ? exit(0, '') : exit(1, '', `X Pull request #${number} was not ${isMerge ? 'merged' : 'approved'}\n`)
  }
  const [command, hostFlag, host, methodFlag, method, includeFlag, address = '', ...rest] = argv
  if (command !== 'api' || hostFlag !== '--hostname' || host !== 'github.com') return undefined
  if (methodFlag !== '--method' || includeFlag !== '--include') return undefined
  const parts = /^repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(address)
  if (parts === null) return undefined
  const repository = state.repositories.find((candidate) => same(candidate.owner, parts[1] ?? '') && same(candidate.name, parts[2] ?? ''))
  const input = rest.length === 2 && rest[0] === '--input' && rest[1] === '-'
  if (!input && rest.length !== 0) return undefined
  const path = parts[3] ?? ''
  const pullRoute = /^pulls\/([1-9][0-9]*)\/(merge|merge-async|reviews)$/.exec(path)
  const writesTo = (branch: string): FakeExit => {
    if (isExit(who)) return who
    if (repository === undefined) return included(404, NOT_FOUND)
    if (guarded(repository, branch, who)) {
      return included(409, { message: 'Repository rule violations found', status: '409' })
    }
    return notModelled(`a write to ${branch}`)
  }
  if (method === 'PUT' && pullRoute !== null && pullRoute[2] !== 'reviews') {
    if (isExit(who)) return who
    if (repository === undefined) return included(404, NOT_FOUND)
    const answered = merged(state, repository, Number(pullRoute[1]), who)
    return included(answered.status, answered.body)
  }
  if (method === 'POST' && input && pullRoute?.[2] === 'reviews') {
    if (!/"event"\s*:\s*"APPROVE"/.test(stdin?.toString('utf8') ?? '')) return undefined
    if (isExit(who)) return who
    if (repository === undefined) return included(404, NOT_FOUND)
    const answered = approved(state, repository, Number(pullRoute[1]), who)
    return included(answered.status, answered.body)
  }
  if (method === 'POST' && input && path === 'merges') {
    let base: unknown
    try {
      base = (JSON.parse(stdin?.toString('utf8') ?? '') as Record<string, unknown>)['base']
    } catch {
      return undefined
    }
    return typeof base === 'string' ? writesTo(base) : undefined
  }
  if (method === 'PUT' && input && path.startsWith('contents/')) return writesTo('main')
  const ref = /^git\/refs\/heads\/(.+)$/.exec(path)
  if (method === 'PATCH' && input && ref !== null) return writesTo(ref[1] ?? '')
  return undefined
}

/**
 * The route a fault names: a read's, or `open-pull-request` for the one POST.
 * Undefined for a vector no fault can name.
 */
const faultRoute = (argv: readonly string[], stdin: Buffer | undefined): string | undefined => {
  const [command, , , , method, , address = ''] = argv
  if (command !== 'api') return undefined
  if (method === 'GET') return routeOf(address)?.route
  if (method === 'POST' && pullRequestOf(address, stdin) !== undefined) return 'open-pull-request'
  return undefined
}

/**
 * What gh prints for `argv`, with `stdin`, in the world `state` describes.
 * `state` is changed by what GitHub would change — a pull request opened, a
 * review, a merge, a fault spent — and by nothing else: a test changes the
 * world through `tests/support/fake-gh.ts`.
 */
export function answer(state: FakeState, argv: readonly string[], stdin: Buffer | undefined): FakeExit {
  if (!state.installed) return { code: 'ENOENT', stdout: Buffer.alloc(0), stderr: '', timedOut: false }
  const route = faultRoute(argv, stdin)
  const fault = route === undefined ? undefined : (state.faults ?? []).find((one) => one.route === route && one.times > 0)
  if (fault === undefined) return carried(state, argv, stdin)
  fault.times -= 1
  if (fault.made ?? fault.status === 'lost') carried(state, argv, stdin)
  return fault.status === 'lost'
    ? exit(1, '', 'fake gh: the connection was lost\n')
    : included(fault.status, { message: 'a fault the test asked for', status: String(fault.status) })
}

/** The answer, without a fault. */
function carried(state: FakeState, argv: readonly string[], stdin: Buffer | undefined): FakeExit {
  if (argv.length === 1 && argv[0] === '--version') {
    if (stdin !== undefined) return refused()
    return exit(
      0,
      `gh version ${state.version} (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v${state.version}\n`,
    )
  }
  const modelled = door(state, argv, stdin)
  if (modelled !== undefined) return modelled
  const [command, hostFlag, host, methodFlag, method, includeFlag, address = '', ...rest] = argv
  if (command !== 'api' || hostFlag !== '--hostname' || host !== 'github.com') return refused()
  if (methodFlag !== '--method' || includeFlag !== '--include' || /[{}]/.test(address)) return refused()
  if (method === 'GET') {
    if (rest.length !== 0 || stdin !== undefined) return refused()
    const read = routeOf(address)
    if (read === undefined) return refused()
    if (read.route === 'user') return user(state)
    return ofRepository(state, read)
  }
  if (method === 'POST' && rest.length === 2 && rest[0] === '--input' && rest[1] === '-') {
    const asked = pullRequestOf(address, stdin)
    return asked === undefined ? refused() : opened(state, asked)
  }
  return refused()
}

/**
 * A push to the bare repository by `actor`, as GitHub's rules judge a push:
 * to a branch a ruleset requires a pull request on, refused unless the actor
 * bypasses that ruleset — a deploy key when a `DeployKey` actor is in its
 * list — and a non-fast-forward refused unless bypassed too; any other branch
 * taken. The commit's objects must be in the bare repository already. The
 * status: 200, or 409 for a push the rules refuse.
 */
export function pushed(
  state: FakeState,
  actor: { readonly type: 'User'; readonly login: string } | { readonly type: 'DeployKey'; readonly id: number },
  ref: string,
  commit: string,
): number {
  const repository = state.repositories.find((candidate) => candidate.bare !== undefined)
  if (repository?.bare === undefined || !ref.startsWith('refs/heads/')) throw new Error('the fake holds no bare repository to push to')
  const bare = repository.bare
  const branch = ref.slice('refs/heads/'.length)
  const old = refIn(bare, branch)
  const fastForward = old === undefined || isAncestor(bare, old, commit)
  const index = state.accounts.findIndex((account) => actor.type === 'User' && account.login === actor.login)
  const bypasses = (ruleset: FakeRuleset): boolean =>
    actor.type === 'User'
      ? bypassFor(ruleset, repository, { login: actor.login, id: 1000 + index }) !== 'never'
      : ruleset.bypass.some((one) => one.actor_type === 'DeployKey')
  const refusedHere = rulesetsOn(repository, branch).some(
    (ruleset) =>
      !bypasses(ruleset) &&
      ruleset.rules.some((rule) => rule.type === 'pull_request' || (rule.type === 'non_fast_forward' && !fastForward)),
  )
  if (refusedHere) return 409
  inBare(bare, ['update-ref', ref, commit, old ?? ''])
  const pusher = actor.type === 'User' ? actor.login : `deploy-key-${String(actor.id)}`
  for (const pull of state.pulls ?? []) if (pull.state === 'open' && pull.head === branch) pull.lastPusher = pusher
  return 200
}

/** An approval of pull request `number` by `login`, at the head's current commit; the author's own is refused. */
export function approve(state: FakeState, number: number, login: string): void {
  const repository = state.repositories.find((candidate) => candidate.bare !== undefined) ?? current(state)
  const index = state.accounts.findIndex((account) => account.login === login)
  if (repository === undefined || index === -1) throw new Error(`the fake GitHub cannot approve as ${login}`)
  const answered = approved(state, repository, number, { login, id: 1000 + index })
  if (answered.status !== 200) throw new Error(`the fake GitHub refused ${login}'s approval of #${String(number)} (${String(answered.status)})`)
}

/**
 * The executable: `node tools/fake-gh.ts <gh's arguments>`, the world read
 * from `FAKE_GH_STATE`, stdin read only for the one form that takes it, and
 * the world written back when the answer changed it. `installed: false`
 * cannot be said by a program that runs: a demo takes the fake off PATH
 * instead, and this exits 127, as a shell does for a command it cannot find.
 */
function main(argv: readonly string[]): void {
  const file = process.env['FAKE_GH_STATE']
  if (file === undefined || file === '') {
    process.stderr.write('fake gh: FAKE_GH_STATE names no state file\n')
    process.exit(REFUSED_EXIT)
  }
  const before = readFileSync(file, 'utf8')
  const state = JSON.parse(before) as FakeState
  const stdin = argv.at(-2) === '--input' && argv.at(-1) === '-' ? readFileSync(0) : undefined
  const answered = answer(state, argv, stdin)
  if (JSON.stringify(state) !== JSON.stringify(JSON.parse(before))) writeFileSync(file, JSON.stringify(state))
  process.stdout.write(answered.stdout)
  process.stderr.write(answered.stderr)
  process.exitCode = typeof answered.code === 'number' ? answered.code : 127
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
