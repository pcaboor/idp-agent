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
 * What it models so far: whether gh is installed, its version, the accounts
 * and the one gh is logged in as (or none), an expired login, and a `/user`
 * GitHub refuses (an App's token); and repositories — their name, whether
 * they are archived, each account's permissions, their branches and whether
 * classic protection covers each, their rulesets, and the refs of a bare
 * repository on disk, read with the fake's own git. The routes idp-agent
 * reads beyond those (a commit, the pull requests, the one write) are
 * recognised and answered "not modelled", by name; every other vector — every
 * door of § 6 — is "not a vector idp-agent sends", exit 97.
 *
 * It runs under Node's type stripping (22.18 or later), so it holds no syntax
 * stripping cannot erase, and imports only `node:` built-ins:
 * `tests/support/fake-gh.ts` wraps `answer` as the process a test hands the
 * launcher, and typechecks it. Run as a program — `node tools/fake-gh.ts
 * <gh's arguments>`, as `pnpm demo:github` puts it first on PATH as `gh` — it
 * reads the world from the JSON file `FAKE_GH_STATE` names and answers as
 * `answer` does.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
  /** The branch of `branch`, `rules` and `ref`, decoded. */
  readonly branch: string
  /** The ruleset of `ruleset`. */
  readonly id: number
}

/** The route a `GET` path is, by this file's own reading, or undefined for a path idp-agent never reads. */
const routeOf = (address: string): Read | undefined => {
  const read = (route: Read['route'], owner = '', name = '', branch = '', id = 0): Read => ({ route, owner, name, branch, id })
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
  if (match !== null) return SHA.test(match[1] ?? '') ? read('commit', owner, name) : undefined
  match = /^pulls\?head=([^&]+)&state=all&per_page=100$/.exec(rest)
  if (match !== null) {
    const head = decodeURIComponent(match[1] ?? '')
    return head.startsWith(`${owner}:`) && SUBMISSION.test(head.slice(owner.length + 1)) ? read('pulls', owner, name) : undefined
  }
  return undefined
}

/**
 * The one POST: exactly the six keys, a bare submission head, a base, no
 * draft, no maintainer edits — and written as the engine writes it, the keys
 * in that order with no white space, so a key given twice is never read.
 */
const isPullRequest = (address: string, stdin: Buffer | undefined): boolean => {
  const parts = /^repos\/([^/]+)\/([^/]+)\/pulls$/.exec(address)
  if (parts === null || !OWNER.test(parts[1] ?? '') || !REPOSITORY.test(parts[2] ?? '')) return false
  if (stdin === undefined) return false
  const text = stdin.toString('utf8')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof body !== 'object' || body === null) return false
  const fields = body as Record<string, unknown>
  const written = JSON.stringify({
    title: fields['title'],
    head: fields['head'],
    base: fields['base'],
    body: fields['body'],
    draft: fields['draft'],
    maintainer_can_modify: fields['maintainer_can_modify'],
  })
  return (
    written === text &&
    typeof fields['title'] === 'string' &&
    typeof fields['body'] === 'string' &&
    typeof fields['head'] === 'string' &&
    SUBMISSION.test(fields['head']) &&
    typeof fields['base'] === 'string' &&
    branchPath(fields['base']) !== undefined &&
    fields['draft'] === false &&
    fields['maintainer_can_modify'] === false
  )
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

/** The commit `refs/heads/<branch>` is at in the bare repository, read with the fake's own git. */
const refIn = (bare: string, branch: string): string | undefined => {
  try {
    return execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/** A route of one repository, answered for the account gh acts as: the five § 8 reads. */
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
      const rules = repository.rulesets
        .filter((ruleset) => ruleset.enforcement === 'active' && ruleset.branches.includes(read.branch))
        .flatMap((ruleset) =>
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
    case 'user':
    case 'commit':
    case 'pulls':
      return notModelled(read.route)
    default: {
      const _exhaustive: never = read.route
      return _exhaustive
    }
  }
}

/**
 * What gh prints for `argv`, with `stdin`, in the world `state` describes.
 * `state` is read, never changed: a test changes the world through
 * `tests/support/fake-gh.ts`.
 */
export function answer(state: FakeState, argv: readonly string[], stdin: Buffer | undefined): FakeExit {
  if (!state.installed) return { code: 'ENOENT', stdout: Buffer.alloc(0), stderr: '', timedOut: false }
  if (argv.length === 1 && argv[0] === '--version') {
    if (stdin !== undefined) return refused()
    return exit(
      0,
      `gh version ${state.version} (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v${state.version}\n`,
    )
  }
  const [command, hostFlag, host, methodFlag, method, includeFlag, address = '', ...rest] = argv
  if (command !== 'api' || hostFlag !== '--hostname' || host !== 'github.com') return refused()
  if (methodFlag !== '--method' || includeFlag !== '--include' || /[{}]/.test(address)) return refused()
  if (method === 'GET') {
    if (rest.length !== 0 || stdin !== undefined) return refused()
    const read = routeOf(address)
    if (read === undefined) return refused()
    if (read.route === 'user') return user(state)
    if (read.route === 'commit' || read.route === 'pulls') return notModelled(read.route)
    return ofRepository(state, read)
  }
  if (method === 'POST' && rest.length === 2 && rest[0] === '--input' && rest[1] === '-') {
    return isPullRequest(address, stdin) ? notModelled('open-pull-request') : refused()
  }
  return refused()
}

/**
 * The executable: `node tools/fake-gh.ts <gh's arguments>`, the world read
 * from `FAKE_GH_STATE`, stdin read only for the one form that takes it.
 * `installed: false` cannot be said by a program that runs: a demo takes the
 * fake off PATH instead, and this exits 127, as a shell does for a command it
 * cannot find.
 */
function main(argv: readonly string[]): void {
  const file = process.env['FAKE_GH_STATE']
  if (file === undefined || file === '') {
    process.stderr.write('fake gh: FAKE_GH_STATE names no state file\n')
    process.exit(REFUSED_EXIT)
  }
  const state = JSON.parse(readFileSync(file, 'utf8')) as FakeState
  const stdin = argv.at(-2) === '--input' && argv.at(-1) === '-' ? readFileSync(0) : undefined
  const answered = answer(state, argv, stdin)
  process.stdout.write(answered.stdout)
  process.stderr.write(answered.stderr)
  process.exitCode = typeof answered.code === 'number' ? answered.code : 127
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
