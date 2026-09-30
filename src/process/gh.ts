import { execFile } from 'node:child_process'
import path from 'node:path'
import { spawnedEnvironment } from './environment.js'
import { SUBMISSION_BRANCH, isBranch, isHex } from './grammar.js'
import { LauncherRefusal } from './refusal.js'

/**
 * The second process src/ starts (stage 6 brief § 6), held to git.ts's shape:
 * `execFile`, no shell, Node's own directory, a timeout and a cap, an
 * environment from `spawnedEnvironment`. It cannot import git.ts — only
 * `context/project-fs` and `forge/` may load the git launcher — so
 * NEUTRAL_DIRECTORY is its own copy, and the names both check live in
 * `grammar.ts`.
 *
 * For gh the neutral directory matters twice: gh fills `{owner}`, `{repo}` and
 * `{branch}` in an endpoint "from the repository of the current directory",
 * and `:owner`, `:repo` and `:branch` too, and a hostile repository's remotes
 * must not choose where a request goes. No call uses a placeholder, and the
 * grammar refuses both braces and the colon, which no value of it holds
 * unencoded: each call names the host with `--hostname` and the path in
 * full.
 *
 * gh speaks exactly three shapes here, checked on the FINISHED vector before
 * anything starts (`checkGhArgv`): `--version`; `api --hostname github.com
 * --method GET --include <path>`, the path one of eight templates, every value
 * held to its grammar and encoded; and `api --hostname github.com --method
 * POST --include repos/<o>/<r>/pulls --input -`, the one write, its body on
 * standard input. `--method` is always explicit, because gh's default turns to
 * a write as soon as a parameter is added. `--include` puts the status line
 * and the headers before the body, so the status is read rather than trusted
 * from an exit code; the output is parsed, never printed.
 *
 * idp-agent holds no GitHub credential (§ 5): gh reads its own login, from its
 * configuration or from its own variables, which pass through unread.
 */

export interface GhLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

/** One call, and one answer of at most 1 MiB (§ 15). */
export const GH_LIMITS: GhLimits = { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 }

/** What a pull request's body may weigh on stdin (§ 15). */
const BODY_BYTES = 1024 * 1024

/**
 * Removed from gh's environment, beyond what `spawnedEnvironment` removes,
 * compared by upper-cased name and never read (§ 5); an entry ending `*` is a
 * prefix. Every `GIT_*`; the two variables that would point gh at another
 * host or repository; gh's and Go's debugging, which log HTTP traffic and
 * headers to the stderr this reads; what forces terminal formatting into
 * output this parses; and the Enterprise Server tokens, for a host stage 6
 * never addresses.
 */
export const GH_REMOVED: readonly string[] = [
  'GIT_*',
  'GH_HOST',
  'GH_REPO',
  'GH_DEBUG',
  'DEBUG',
  'GODEBUG',
  'GH_FORCE_TTY',
  'CLICOLOR_FORCE',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]

/** Set on every call: gh never asks, never checks for an update, never decorates what is parsed. */
export const GH_SET: Readonly<Record<string, string>> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  NO_COLOR: '1',
  GH_PAGER: 'cat',
}

/** Where gh is started from: the directory of the running Node binary, never a repository. */
const NEUTRAL_DIRECTORY = path.dirname(process.execPath)

/** A name `GH_REMOVED` lists, whatever its case. */
const removedFromGh = (name: string): boolean => {
  const upper = name.toUpperCase()
  return GH_REMOVED.some((entry) => (entry.endsWith('*') ? upper.startsWith(entry.slice(0, -1)) : upper === entry))
}

/**
 * gh's environment: a spawned one — no provider key, no catalogue variable —
 * minus every name `GH_REMOVED` lists, plus `GH_SET`. Built by `ghIn` and again
 * by `spawnGh` from what it is handed; the same either way.
 */
export function ghEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(spawnedEnvironment(env))) {
    if (!removedFromGh(name)) kept[name] = value
  }
  return { ...kept, ...GH_SET }
}

// ---------------------------------------------------------------- requests

/** The eight things idp-agent reads on GitHub, each a template of § 6. */
export type GhRoute =
  | { readonly route: 'user' }
  | { readonly route: 'repository'; readonly owner: string; readonly name: string }
  | { readonly route: 'branch'; readonly owner: string; readonly name: string; readonly branch: string }
  | { readonly route: 'rules'; readonly owner: string; readonly name: string; readonly branch: string }
  | { readonly route: 'ruleset'; readonly owner: string; readonly name: string; readonly id: number }
  | { readonly route: 'ref'; readonly owner: string; readonly name: string; readonly branch: string }
  | { readonly route: 'commit'; readonly owner: string; readonly name: string; readonly sha: string }
  | { readonly route: 'pulls'; readonly owner: string; readonly name: string; readonly head: string }

/** A call gh is asked to make; `body` is the whole JSON of the one POST. */
export type GhRequest =
  | { readonly kind: 'version' }
  | { readonly kind: 'get'; readonly route: GhRoute }
  | { readonly kind: 'open-pull-request'; readonly owner: string; readonly name: string; readonly body: string }

/**
 * A ref name as a path: split on `/`, each component encoded as a URI
 * component, joined with a literal `/` — how `git/ref/heads/release/1` and
 * `branches/release/1` are addressed (§ 6).
 */
export function encodeRefPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/')
}

const pathOf = (route: GhRoute): string => {
  switch (route.route) {
    case 'user':
      return 'user'
    case 'repository':
      return `repos/${route.owner}/${route.name}`
    case 'branch':
      return `repos/${route.owner}/${route.name}/branches/${encodeRefPath(route.branch)}`
    case 'rules':
      return `repos/${route.owner}/${route.name}/rules/branches/${encodeRefPath(route.branch)}?per_page=100`
    case 'ruleset':
      return `repos/${route.owner}/${route.name}/rulesets/${String(route.id)}`
    case 'ref':
      return `repos/${route.owner}/${route.name}/git/ref/heads/${encodeRefPath(route.branch)}`
    case 'commit':
      return `repos/${route.owner}/${route.name}/git/commits/${route.sha}`
    case 'pulls':
      return `repos/${route.owner}/${route.name}/pulls?head=${encodeURIComponent(`${route.owner}:${route.head}`)}&state=all&per_page=100`
    default: {
      const _exhaustive: never = route
      return _exhaustive
    }
  }
}

const API = ['api', '--hostname', 'github.com', '--method'] as const

/** The vector for `request`, before any check: `checkGhArgv` is what decides whether it runs. */
export function ghArgv(request: GhRequest): string[] {
  switch (request.kind) {
    case 'version':
      return ['--version']
    case 'get':
      return [...API, 'GET', '--include', pathOf(request.route)]
    case 'open-pull-request':
      return [...API, 'POST', '--include', `repos/${request.owner}/${request.name}/pulls`, '--input', '-']
    default: {
      const _exhaustive: never = request
      return _exhaustive
    }
  }
}

// ---------------------------------------------------------------- the grammar

/** GitHub's account names: letters, digits and hyphens, up to 39, not starting with a hyphen. */
const isOwner = (word: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(word)
/** GitHub's repository names: letters, digits, `.`, `_`, `-`, up to 100, never `.` or `..`. */
const isName = (word: string): boolean => /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/.test(word)
const isId = (word: string): boolean => /^[1-9][0-9]{0,15}$/.test(word)

/** An encoded ref path whose name is a branch, written exactly as `encodeRefPath` writes it. */
const isRefPath = (encoded: string): boolean => {
  let branch: string
  try {
    branch = encoded.split('/').map(decodeURIComponent).join('/')
  } catch {
    return false
  }
  return isBranch(branch) && encodeRefPath(branch) === encoded
}

/** `<owner>:<submission branch>`, written exactly as `encodeURIComponent` writes it. */
const isPullsHead = (encoded: string, owner: string): boolean => {
  let head: string
  try {
    head = decodeURIComponent(encoded)
  } catch {
    return false
  }
  const prefix = `${owner}:`
  return (
    head.startsWith(prefix) &&
    SUBMISSION_BRANCH.test(head.slice(prefix.length)) &&
    encodeURIComponent(head) === encoded
  )
}

/** One of the eight `GET` templates, every value held to its grammar. */
const isGetPath = (route: string): boolean => {
  if (route === 'user') return true
  const repository = /^repos\/([^/?#]+)\/([^/?#]+)(.*)$/s.exec(route)
  if (repository === null) return false
  const [, owner = '', name = '', rest = ''] = repository
  if (!isOwner(owner) || !isName(name)) return false
  if (rest === '') return true
  const within = (prefix: string, suffix: string, value: (word: string) => boolean): boolean =>
    rest.length > prefix.length + suffix.length &&
    rest.startsWith(prefix) &&
    rest.endsWith(suffix) &&
    value(rest.slice(prefix.length, rest.length - suffix.length))
  return (
    within('/branches/', '', isRefPath) ||
    within('/rules/branches/', '?per_page=100', isRefPath) ||
    within('/rulesets/', '', isId) ||
    within('/git/ref/heads/', '', isRefPath) ||
    within('/git/commits/', '', isHex) ||
    within('/pulls?head=', '&state=all&per_page=100', (head) => isPullsHead(head, owner))
  )
}

/** `repos/<o>/<r>/pulls`, the one path written to. */
const isPullsPath = (route: string): boolean => {
  const pulls = /^repos\/([^/]+)\/([^/]+)\/pulls$/.exec(route)
  return pulls !== null && isOwner(pulls[1] ?? '') && isName(pulls[2] ?? '')
}

/**
 * The one POST's body, exactly as the engine writes it: a JSON object of
 * `title` (1 to 256 characters, no control character), `head` (the bare
 * submission branch, never `owner:branch`), `base` (a branch), `body` (at most
 * 1 MiB), `draft: false` and `maintainer_can_modify: false`, in that order
 * and with no white space between them — so no key is added, repeated or
 * changed on the way to GitHub.
 */
const isPullBody = (stdin: Buffer): boolean => {
  const text = stdin.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(stdin)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const { title, head, base, body } = parsed as Record<string, unknown>
  if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string' || typeof body !== 'string') {
    return false
  }
  const canonical = JSON.stringify({ title, head, base, body, draft: false, maintainer_can_modify: false })
  return (
    canonical === text &&
    title.length >= 1 &&
    title.length <= 256 &&
    !/\p{Cc}/u.test(title) &&
    SUBMISSION_BRANCH.test(head) &&
    isBranch(base) &&
    Buffer.byteLength(body, 'utf8') <= BODY_BYTES
  )
}

/** The word a refusal names: gh's command, or `(unnamed)` for anything that is not shaped like one. */
const commandWord = (argv: readonly string[]): string => {
  const word = argv[0]
  if (word === undefined) return '(none)'
  return /^-{0,2}[a-z][a-z-]{0,31}$/.test(word) ? word : '(unnamed)'
}

/**
 * Holds the FINISHED vector to exactly `['--version']`, the `GET` form with no
 * stdin, or the `POST` form with its body on stdin; any `{`, `}` or `:` in a
 * path — gh's placeholders, `{branch}` and `:branch` alike — is refused before
 * anything else, whatever a value's grammar comes to admit. Anything else throws `LauncherRefusal`, and
 * nothing starts. The engine's own copy of these grammars will live in
 * `core/github/` (Task 6.1.2): `process/` imports nothing of ours.
 */
export function checkGhArgv(argv: readonly string[], stdin?: Buffer): void {
  const refuse = (): never => {
    throw new LauncherRefusal('gh', commandWord(argv))
  }
  if (argv.length === 1 && argv[0] === '--version') {
    if (stdin !== undefined) refuse()
    return
  }
  const [api, hostname, host, method, verb, include, route = '', ...rest] = argv
  if (api !== 'api' || hostname !== '--hostname' || host !== 'github.com') refuse()
  if (method !== '--method' || include !== '--include') refuse()
  if (/[{}:]/.test(route)) refuse()
  if (verb === 'GET') {
    if (rest.length !== 0 || stdin !== undefined || !isGetPath(route)) refuse()
    return
  }
  if (verb === 'POST') {
    if (rest.length !== 2 || rest[0] !== '--input' || rest[1] !== '-') refuse()
    if (!isPullsPath(route) || stdin === undefined || !isPullBody(stdin)) refuse()
    return
  }
  refuse()
}

// ---------------------------------------------------------------- the process

export interface GhExit {
  /** The exit code, or Node's code for a gh that never ran (`ENOENT`) or said too much. */
  readonly code: number | string | undefined
  readonly stdout: Buffer
  /** gh's own words: read to classify, never printed. */
  readonly stderr: string
  readonly timedOut: boolean
}

/**
 * How a vector reaches a gh: `spawnGh` in the CLI, a fake in the tests
 * (`MainDeps.gh`). Only ever handed a vector `checkGhArgv` admitted.
 */
export type GhProcess = (
  argv: readonly string[],
  options: { readonly stdin?: Buffer; readonly env: NodeJS.ProcessEnv; readonly limits: GhLimits },
) => Promise<GhExit>

/** The real gh: started by name, from the neutral directory, with gh's environment and the bounds. */
export const spawnGh: GhProcess = (argv, options) =>
  new Promise((resolve) => {
    const child = execFile(
      'gh',
      [...argv],
      {
        cwd: NEUTRAL_DIRECTORY,
        env: ghEnvironment(options.env),
        encoding: 'buffer',
        timeout: options.limits.timeoutMs,
        maxBuffer: options.limits.maxOutputBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error === null ? 0 : (error.code ?? undefined),
          stdout,
          stderr: stderr.toString('utf8'),
          timedOut: error?.killed === true,
        }),
    )
    // As in git.ts: a gh that never started closes its end of the pipe, and
    // the failure that matters is the callback's.
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.stdin)
  })

// ---------------------------------------------------------------- answers

/** An included answer: the status line's code, whether a `Link` names a next page, and the body. */
export interface GhAnswer {
  readonly status: number
  readonly hasNext: boolean
  readonly body: string
}

/** A `Link` header's value names a `next` relation. */
const linksNext = (value: string): boolean =>
  value.split(/,\s*(?=<)/).some((link) => {
    const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(link)?.[1] ?? ''
    return rel.split(/\s+/).includes('next')
  })

/**
 * gh's `--include` output: the status line, the headers, a blank line, the
 * body; line ends `\r\n` or `\n`. Undefined for anything else — no status
 * line, a status that is not three digits, a head with no blank line after it.
 */
export function parseIncluded(stdout: Buffer): GhAnswer | undefined {
  const text = stdout.toString('utf8')
  const end = /\r?\n\r?\n/.exec(text)
  if (end === null) return undefined
  const [first = '', ...headers] = text.slice(0, end.index).split(/\r?\n/)
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})(?: .*)?$/.exec(first)?.[1]
  if (status === undefined) return undefined
  const hasNext = headers.some((line) => {
    const link = /^link:(.*)$/i.exec(line)?.[1]
    return link !== undefined && linksNext(link)
  })
  return { status: Number(status), hasNext, body: text.slice(end.index + end[0].length) }
}

type GhFailure = 'missing' | 'auth' | 'timeout' | 'too-large' | 'unreadable' | 'failed'

/** What went wrong, in this build's words: never gh's, which a repository or a server can reach. */
const REASONS: Readonly<Record<GhFailure, string>> = {
  missing: ': gh is not on PATH',
  auth: ': gh is not logged in',
  timeout: ': timed out',
  'too-large': ': its answer was past the bound',
  unreadable: ': its answer had no status line',
  failed: '',
}

export class GhError extends Error {
  constructor(
    /** `missing`: gh never started (`ENOENT`); `auth`: gh's exit 4, authentication required. */
    readonly kind: GhFailure,
    word: string,
  ) {
    super(`gh ${word} failed${REASONS[kind]}`)
    this.name = 'GhError'
  }
}

/** A gh that never answered: not found, stopped at a bound. */
const unanswered = (exit: GhExit, word: string): GhError | undefined => {
  if (exit.code === 'ENOENT') return new GhError('missing', word)
  if (exit.timedOut) return new GhError('timeout', word)
  if (exit.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GhError('too-large', word)
  return undefined
}

/** gh, as idp-agent may use it. */
export interface GhClient {
  /** `gh --version`'s output, whole, for the engine to read the version from. */
  version(): Promise<string>
  get(route: GhRoute): Promise<GhAnswer>
  /** The one write: `body` is the whole JSON, handed on stdin. */
  openPullRequest(owner: string, name: string, body: string): Promise<GhAnswer>
  /** How many processes this client started: a refused request starts none. */
  calls(): number
}

/**
 * The gh launcher: builds each vector with `ghArgv`, checks it with
 * `checkGhArgv`, counts it, and only then hands it to `run` (`spawnGh`, or a
 * test's fake) with gh's environment and the bounds — so a fake never sees a
 * vector the grammar refused.
 */
export function ghIn(
  options: { readonly env?: NodeJS.ProcessEnv; readonly run?: GhProcess; readonly limits?: GhLimits } = {},
): GhClient {
  const run = options.run ?? spawnGh
  const limits = options.limits ?? GH_LIMITS
  let started = 0

  const call = async (request: GhRequest): Promise<GhExit> => {
    const stdin = request.kind === 'open-pull-request' ? Buffer.from(request.body, 'utf8') : undefined
    let argv: string[]
    try {
      argv = ghArgv(request)
    } catch {
      // A value encodeURIComponent cannot write (a lone surrogate) is no
      // value of the grammar either.
      throw new LauncherRefusal('gh', request.kind === 'version' ? '--version' : 'api')
    }
    checkGhArgv(argv, stdin)
    started += 1
    return run(argv, { ...(stdin === undefined ? {} : { stdin }), env: ghEnvironment(options.env), limits })
  }

  const answer = async (request: GhRequest): Promise<GhAnswer> => {
    const exit = await call(request)
    const stopped = unanswered(exit, 'api')
    if (stopped !== undefined) throw stopped
    const included = parseIncluded(exit.stdout)
    if (included !== undefined) return included
    if (exit.code === 4) throw new GhError('auth', 'api')
    throw new GhError(exit.code === 0 ? 'unreadable' : 'failed', 'api')
  }

  return {
    version: async () => {
      const exit = await call({ kind: 'version' })
      const stopped = unanswered(exit, '--version')
      if (stopped !== undefined) throw stopped
      if (exit.code === 4) throw new GhError('auth', '--version')
      if (exit.code !== 0) throw new GhError('failed', '--version')
      return exit.stdout.toString('utf8')
    },
    get: (route) => answer({ kind: 'get', route }),
    openPullRequest: (owner, name, body) => answer({ kind: 'open-pull-request', owner, name, body }),
    calls: () => started,
  }
}
