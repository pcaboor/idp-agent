/**
 * A fake gh: a model of the GitHub that `gh api` answers, for the tests and,
 * from stage 6's next step, for `pnpm demo:github` (stage 6 brief § 10).
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
 * GitHub refuses (an App's token). The other routes idp-agent reads are
 * recognised and answered "not modelled", by name; every other vector —
 * every door of § 6 — is "not a vector idp-agent sends", exit 97.
 *
 * It runs under Node's type stripping (22.18 or later), so it holds no syntax
 * stripping cannot erase, and imports nothing: `tests/support/fake-gh.ts`
 * wraps `answer` as the process a test hands the launcher, and typechecks it.
 * No executable entry yet.
 */

/** An account GitHub knows: a person, or a bot. */
export interface Account {
  readonly login: string
  readonly type: 'User' | 'Bot' | 'Organization'
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

/** An answer as `gh api --include` prints it, and the exit gh gives it. */
const included = (status: number, body: unknown): FakeExit =>
  exit(
    status >= 200 && status < 300 ? 0 : 1,
    `HTTP/2.0 ${String(status)} ${REASONS[status] ?? 'Status'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
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

/** The route a `GET` path is, by this file's own reading, or undefined for a path idp-agent never reads. */
const routeOf = (address: string): string | undefined => {
  if (address === 'user') return 'user'
  const parts = /^repos\/([^/]+)\/([^/?]+)(?:\/(.*))?$/.exec(address)
  if (parts === null) return undefined
  const [, owner = '', name = '', rest] = parts
  if (!OWNER.test(owner) || !REPOSITORY.test(name) || name === '.' || name === '..') return undefined
  if (rest === undefined) return 'repository'
  let match = /^branches\/([^?]+)$/.exec(rest)
  if (match !== null) return branchPath(match[1] ?? '') === undefined ? undefined : 'branch'
  match = /^rules\/branches\/([^?]+)\?per_page=100$/.exec(rest)
  if (match !== null) return branchPath(match[1] ?? '') === undefined ? undefined : 'rules'
  if (/^rulesets\/[1-9][0-9]*$/.test(rest)) return 'ruleset'
  match = /^git\/ref\/heads\/([^?]+)$/.exec(rest)
  if (match !== null) return branchPath(match[1] ?? '') === undefined ? undefined : 'ref'
  match = /^git\/commits\/([^/?]+)$/.exec(rest)
  if (match !== null) return SHA.test(match[1] ?? '') ? 'commit' : undefined
  match = /^pulls\?head=([^&]+)&state=all&per_page=100$/.exec(rest)
  if (match !== null) {
    const head = decodeURIComponent(match[1] ?? '')
    return head.startsWith(`${owner}:`) && SUBMISSION.test(head.slice(owner.length + 1)) ? 'pulls' : undefined
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

/** `GET user`: the account gh is logged in as, with fields the reader never reads. */
const user = (state: FakeState): FakeExit => {
  const session = state.session
  if (session === undefined) return exit(4, '', LOGGED_OUT)
  if (session.expired === true) return included(401, { message: 'Bad credentials', status: '401' })
  if (state.userRefused === true) return included(403, { message: 'Resource not accessible by integration', status: '403' })
  const index = state.accounts.findIndex((account) => account.login === session.login)
  const account = state.accounts[index]
  if (account === undefined) return included(401, { message: 'Bad credentials', status: '401' })
  return included(200, {
    login: account.login,
    id: 1000 + index,
    node_id: `U_${account.login}`,
    type: account.type,
    site_admin: false,
    name: null,
  })
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
    const route = routeOf(address)
    if (route === undefined) return refused()
    if (route === 'user') return user(state)
    return notModelled(route)
  }
  if (method === 'POST' && rest.length === 2 && rest[0] === '--input' && rest[1] === '-') {
    return isPullRequest(address, stdin) ? notModelled('open-pull-request') : refused()
  }
  return refused()
}
