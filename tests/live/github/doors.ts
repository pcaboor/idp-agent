import { Buffer } from 'node:buffer'
import { parseIncluded } from '../../../src/process/gh.js'
import type { DoorEntry, DoorReason, DoorRefusal } from '../../support/github-answers.js'

/**
 * Every door the owner's live run tries on GitHub as the identity that opened
 * the pull request (stage 6 brief § 10; stage 6 plan, Task 6.4.1, steps 4 and
 * 5), with its argument vector. `tests/live/` may name a door — the door rule
 * of `tests/architecture/` lets it, beside `tests/support/fake-gh.ts` — and
 * this is the one place the live run spells them.
 *
 * Each `gh pr` door names the repository with `--repo`; each `gh api` door
 * names the host, the method and `--include`, so GitHub's status is read
 * rather than an exit code; the GraphQL doors are `gh api graphql` with the
 * pull request's node id and the base's commit written in; the push is the
 * test's own `git push` of the pull request's head onto the base, a
 * fast-forward the pull request rule forbids, with no force of any kind. No
 * door forces anything: a door that succeeded would leave the throwaway
 * repository one additive commit, never a rewritten one.
 *
 * A door the fake's model answers carries the name its `DOORS` entry has in
 * `tests/support/fake-gh.ts` (`modelled`), so the contract test holds the fake
 * to what GitHub answered there; a door the fake does not answer carries a
 * name of its own, and is asserted from the file alone.
 */

/** What a door's vector is built from: the run's repository, base, pull request and clone. */
export interface LiveContext {
  readonly owner: string
  readonly name: string
  /** The base the pull request goes into: the repository's default branch. */
  readonly base: string
  /** The pull request's number. */
  readonly number: number
  /** Its `idp-agent/` branch. */
  readonly branch: string
  /** The commit its branch is at. */
  readonly head: string
  /** The commit the base is at, which no door may move. */
  readonly baseSha: string
  /** The pull request's GraphQL node id. */
  readonly nodeId: string
  /** The run's UTC time, `yyyymmddhhmmss`. */
  readonly stamp: string
  /** The test's own clone, where the push door runs. */
  readonly clone: string
}

export interface LiveDoor {
  /** The DOORS name the fake answers this door under, or a name of its own when `modelled` is false. */
  readonly name: string
  readonly modelled: boolean
  readonly via: 'gh' | 'gh-api' | 'graphql' | 'git-push'
  readonly step: 'doors' | 'after-approval'
  /** gh's arguments for `gh`, `gh-api` and `graphql`; git's for `git-push`. */
  argv(context: LiveContext): readonly string[]
}

const repository = (context: LiveContext): string => `${context.owner}/${context.name}`

/** A branch as a path: each component encoded, joined with a literal `/`. */
const refPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/')

const api = (method: string, route: string, ...fields: string[]): string[] => [
  'api',
  '--hostname',
  'github.com',
  '--method',
  method,
  '--include',
  route,
  ...fields,
]

const merge = (method: '--merge' | '--squash' | '--rebase', step: LiveDoor['step'] = 'doors'): LiveDoor => ({
  name: `gh pr merge ${method}`,
  modelled: true,
  via: 'gh',
  step,
  argv: (context) => ['pr', 'merge', String(context.number), '--repo', repository(context), method],
})

/** The file a write door would add to the base, which must never reach it. */
const stray = (context: LiveContext): { path: string; content: string } => ({
  path: `live-${context.stamp}.txt`,
  content: Buffer.from(`idpa live test ${context.stamp}: this file must never reach ${context.base}\n`, 'utf8').toString('base64'),
})

export const LIVE_DOORS: readonly LiveDoor[] = [
  merge('--merge'),
  merge('--squash'),
  merge('--rebase'),
  {
    name: 'gh pr merge --admin',
    modelled: true,
    via: 'gh',
    step: 'doors',
    argv: (context) => ['pr', 'merge', String(context.number), '--repo', repository(context), '--merge', '--admin'],
  },
  {
    name: 'gh api PUT …/pulls/1/merge',
    modelled: true,
    via: 'gh-api',
    step: 'doors',
    argv: (context) =>
      api('PUT', `repos/${repository(context)}/pulls/${String(context.number)}/merge`, '-f', 'merge_method=merge', '-f', `sha=${context.head}`),
  },
  {
    // A 404 is GitHub not serving it: it counts as refused only because the base did not move.
    // A 2xx is GitHub accepting it, to judge it later (202 on 2026-10-02, the ruleset refusing
    // the merge after): queued, and counted refused only once observed never merged.
    name: 'gh api PUT …/pulls/1/merge-async',
    modelled: true,
    via: 'gh-api',
    step: 'doors',
    argv: (context) => api('PUT', `repos/${repository(context)}/pulls/${String(context.number)}/merge-async`),
  },
  {
    name: 'gh api POST …/merges',
    modelled: true,
    via: 'gh-api',
    step: 'doors',
    argv: (context) =>
      api(
        'POST',
        `repos/${repository(context)}/merges`,
        '-f',
        `base=${context.base}`,
        '-f',
        `head=${context.branch}`,
        '-f',
        `commit_message=idpa live test ${context.stamp}: a merge that must be refused`,
      ),
  },
  {
    name: 'gh api PUT …/contents/catalog/x.yml',
    modelled: true,
    via: 'gh-api',
    step: 'doors',
    argv: (context) => {
      const file = stray(context)
      return api(
        'PUT',
        `repos/${repository(context)}/contents/${file.path}`,
        '-f',
        `message=idpa live test ${context.stamp}: a write that must be refused`,
        '-f',
        `content=${file.content}`,
        '-f',
        `branch=${context.base}`,
      )
    },
  },
  {
    // Not forced: a fast-forward of the base to the pull request's head, which the pull request rule forbids.
    name: 'gh api PATCH …/git/refs/heads/main',
    modelled: true,
    via: 'gh-api',
    step: 'doors',
    argv: (context) =>
      api('PATCH', `repos/${repository(context)}/git/refs/heads/${refPath(context.base)}`, '-f', `sha=${context.head}`, '-F', 'force=false'),
  },
  {
    // Not forced either: no `--force`, no `+`, one refspec.
    name: 'git push of the head onto the base',
    modelled: false,
    via: 'git-push',
    step: 'doors',
    argv: (context) => ['-C', context.clone, 'push', 'origin', `${context.head}:refs/heads/${context.base}`],
  },
  {
    name: 'graphql mergePullRequest',
    modelled: false,
    via: 'graphql',
    step: 'doors',
    argv: (context) => [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'POST',
      '--include',
      'graphql',
      '-f',
      `query=mutation { mergePullRequest(input: { pullRequestId: "${context.nodeId}", expectedHeadOid: "${context.head}", mergeMethod: MERGE }) { pullRequest { merged } } }`,
    ],
  },
  {
    name: 'graphql createCommitOnBranch',
    modelled: false,
    via: 'graphql',
    step: 'doors',
    argv: (context) => {
      const file = stray(context)
      return [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        '--include',
        'graphql',
        '-f',
        `query=mutation { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: "${repository(context)}", branchName: "${context.base}" }, ` +
          `expectedHeadOid: "${context.baseSha}", message: { headline: "idpa live test ${context.stamp}: a commit that must be refused" }, ` +
          `fileChanges: { additions: [{ path: "${file.path}", contents: "${file.content}" }] } }) { commit { oid } } }`,
      ]
    },
  },
  {
    // The author's own approval, which GitHub never records.
    name: 'gh pr review --approve',
    modelled: true,
    via: 'gh',
    step: 'doors',
    argv: (context) => ['pr', 'review', String(context.number), '--repo', repository(context), '--approve'],
  },
  {
    name: 'gh api POST …/pulls/1/reviews',
    modelled: true,
    via: 'gh-api',
    step: 'doors',
    argv: (context) => api('POST', `repos/${repository(context)}/pulls/${String(context.number)}/reviews`, '-f', 'event=APPROVE'),
  },
  // Step 5: after another person's approval and the author's push on top, the author's merge.
  merge('--merge', 'after-approval'),
]

// ---------------------------------------------------------------- what a door may send

/**
 * Words no door sends, whatever it goes through: a force of any kind, a
 * deletion, more than one ref, a pruning, an upstream set, an auto-merge.
 * `-f` is not among them: gh's `api` reads it as a field; the push's own
 * vector is held to one shape below.
 */
const NEVER = /^(?:--force(?:-with-lease|-if-includes)?|--mirror|--delete|--delete-branch|--prune|--all|--tags|--auto|--set-upstream|-u|-d|-D)(?:=.*)?$/

/** The REST methods a door sends: no door deletes, and none reads. */
const METHODS: ReadonlySet<string> = new Set(['PUT', 'POST', 'PATCH'])

/** The GraphQL mutations a door sends: a merge of the pull request, and a commit onto the base. */
const MUTATIONS: ReadonlySet<string> = new Set(['mergePullRequest', 'createCommitOnBranch'])

/**
 * Why `argv` must not be sent as a door through `via`, or nothing when it may:
 * no force and no deletion anywhere; a push that is exactly the pull request's
 * head onto the base, from the test's clone, to `origin`; a `gh pr` door on
 * the run's pull request, naming the repository with `--repo` once; a REST
 * door to `github.com`, under `repos/<owner>/<name>/`, with a method that
 * deletes nothing and `force=false` wherever it moves a ref; a GraphQL door of
 * one allowed mutation, on the run's pull request or repository. `tryDoor`
 * refuses to send a door this answers anything for, and the default suite
 * holds every `LIVE_DOORS` vector to it (`tests/unit/live-config.test.ts`).
 */
export function doorRefusals(via: LiveDoor['via'], argv: readonly string[], context: LiveContext): string[] {
  const reasons: string[] = []
  const named = repository(context)
  for (const word of argv) {
    if (word.startsWith('+')) reasons.push(`${word} forces`)
    if (NEVER.test(word)) reasons.push(`${word} is never sent`)
  }
  switch (via) {
    case 'git-push': {
      const only = ['-C', context.clone, 'push', 'origin', `${context.head}:refs/heads/${context.base}`]
      if (argv.some((word) => word === '-f' || word.startsWith(':') || word.includes('*'))) reasons.push('a push that forces, deletes or names a pattern')
      if (argv.length !== only.length || argv.some((word, at) => word !== only[at])) {
        reasons.push('a push other than the head onto the base, from the clone, to origin, in one refspec')
      }
      break
    }
    case 'gh': {
      if (argv[0] !== 'pr' || argv[2] !== String(context.number)) reasons.push(`a gh door on something other than pull request #${String(context.number)}`)
      const at = argv.indexOf('--repo')
      if (at === -1 || argv[at + 1] !== named || argv.lastIndexOf('--repo') !== at || argv.includes('-R')) {
        reasons.push(`a gh door that does not name ${named} with --repo, once`)
      }
      break
    }
    case 'gh-api':
    case 'graphql': {
      const [api, hostFlag, host, methodFlag, method = '', include, route = '', ...fields] = argv
      if (api !== 'api' || hostFlag !== '--hostname' || host !== 'github.com' || methodFlag !== '--method' || include !== '--include') {
        reasons.push('an api door that does not name --hostname github.com, its method and --include, in that order')
      }
      if (!METHODS.has(method)) reasons.push(`${method} is not a method a door sends`)
      const values = new Map<string, string>()
      for (let at = 0; at < fields.length; at += 2) {
        const flag = fields[at]
        const field = fields[at + 1] ?? ''
        const equals = field.indexOf('=')
        if ((flag !== '-f' && flag !== '-F') || equals < 1) {
          reasons.push(`${flag ?? ''} ${field} is not one field`)
          continue
        }
        values.set(field.slice(0, equals), field.slice(equals + 1))
      }
      if (via === 'gh-api') {
        if (!route.startsWith(`repos/${named}/`) || route.includes('..') || route.includes('?')) {
          reasons.push(`a route outside repos/${named}/`)
        }
        const force = values.get('force')
        if (force !== undefined && force !== 'false') reasons.push(`force=${force}`)
        if (route.includes('/git/refs/') && force !== 'false') reasons.push('a ref moved without force=false')
        break
      }
      const query = fields[1]?.startsWith('query=') === true ? fields[1].slice('query='.length) : ''
      if (route !== 'graphql' || method !== 'POST' || fields.length !== 2 || fields[0] !== '-f' || query === '') {
        reasons.push('a GraphQL door that is not one query, sent by POST')
      }
      const mutations = [...query.matchAll(/\b(\w+)\s*\(\s*input:/g)].map(([, mutation]) => mutation ?? '')
      const [mutation = ''] = mutations
      if (!query.startsWith('mutation {') || mutations.length !== 1 || !MUTATIONS.has(mutation)) {
        reasons.push('a GraphQL door that is not one mergePullRequest or one createCommitOnBranch')
      }
      for (const [, other] of query.matchAll(/repositoryNameWithOwner:\s*"([^"]*)"/g)) {
        if (other !== named) reasons.push(`a GraphQL door on another repository than ${named}`)
      }
      if (mutation === 'mergePullRequest' && !query.includes(`pullRequestId: "${context.nodeId}"`)) {
        reasons.push(`a GraphQL door on another pull request than #${String(context.number)}`)
      }
      if (mutation === 'createCommitOnBranch' && !query.includes(`repositoryNameWithOwner: "${named}"`)) {
        reasons.push(`a GraphQL commit that does not name ${named}`)
      }
      break
    }
    default: {
      const _exhaustive: never = via
      reasons.push(`a door through ${String(_exhaustive)}`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------- what GitHub answered

/** A door's process: its exit, stdout and stderr. */
export interface DoorRun {
  readonly code: number | string | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * A door's outcome, classified: `refused` only for a `DoorRefusal` — or, for a
 * `queued` door, once `queuedOutcome` has observed it never merged.
 */
export interface DoorOutcome {
  /** GitHub answered something: a status, a GraphQL answer, a `remote:` line, gh's refusal after a request. */
  readonly reachedGitHub: boolean
  readonly refused: boolean
  readonly reason: DoorReason
  /** The HTTP status `--include` printed, for `gh-api` and `graphql`. */
  readonly status?: number
  /** GraphQL: whether the answer held an `errors` array. */
  readonly errors?: boolean
  /** A push's `remote:` lines, as git printed them: the caller scrubs them before they are kept. */
  readonly remote: readonly string[]
}

const REFUSALS: ReadonlySet<DoorReason> = new Set<DoorRefusal>(['rule', 'review', 'own-review', 'not-mergeable', 'not-served'])

/** gh's own refusal of its arguments, before any request. */
const UNSENT = /unknown flag|accepts \d|required flag|could not determine|not a git repository/i

/**
 * GitHub's words, by class, first match wins: a refused session or key, a
 * token without the scope, the author's own review, a ruleset or a
 * protection, a review the rules require, a pull request not mergeable, a
 * thing not found. Only the class is kept.
 */
const CLASSES: readonly (readonly [DoorReason, RegExp])[] = [
  ['unauthenticated', /bad credentials|requires authentication|\bHTTP 401\b|gh auth login|not logged in|authentication failed|permission denied \(publickey\)/i],
  ['scope', /not accessible by (?:personal access token|integration)|missing required scopes?|insufficient scopes?|saml enforcement|permission to \S+ denied/i],
  ['own-review', /can ?not approve your own pull request/i],
  ['rule', /rule violations?|\bGH0(?:06|13)\b|protected branch|branch policy prohibits|changes must be made through a pull request/i],
  ['review', /approving reviews? (?:is|are) required|review from someone other than|last pusher|review (?:is )?required|code owner review/i],
  ['not-mergeable', /not mergeable|merge (?:is )?blocked/i],
  ['not-found', /could not resolve to|\bnot found\b/i],
]

const classOf = (text: string): DoorReason | undefined => CLASSES.find(([, words]) => words.test(text))?.[0]

const judged = (reason: DoorReason, rest: Omit<DoorOutcome, 'refused' | 'reason'>): DoorOutcome => ({
  ...rest,
  reason,
  refused: REFUSALS.has(reason),
})

/** The door GitHub answers before it judges: `merge-async`, accepted, then merged or refused by the rules later. */
const judgedLater = (door: LiveDoor): boolean => door.name.endsWith('merge-async')

/**
 * What GitHub answered a door, by class: a door counts as refused only when
 * GitHub's words name a ruleset, a protection, a review or mergeability —
 * or, for a REST merge, a 405, which is GitHub saying it is not mergeable, and
 * for `merge-async`, a 404, GitHub not serving it (the base is read after
 * either way). `merge-async`'s 2xx is `queued`, not `accepted`: GitHub took
 * the request and judges it later (202, then the ruleset's refusal, on
 * 2026-10-02), so it is neither carried out nor refused until `queuedOutcome`
 * has observed what followed. A 401, a token without the scope, a thing not
 * found and a refusal no class reads are not tried, and stop the run: none
 * proves the rules, and the contract test would otherwise hold the fake to
 * them.
 */
export function doorOutcome(door: LiveDoor, ran: DoorRun): DoorOutcome {
  switch (door.via) {
    case 'gh': {
      if (ran.code === 0) return judged('accepted', { reachedGitHub: true, remote: [] })
      if (ran.code !== 1 || UNSENT.test(ran.stderr)) return judged('not-sent', { reachedGitHub: false, remote: [] })
      return judged(classOf(ran.stderr) ?? 'unrecognised', { reachedGitHub: true, remote: [] })
    }
    case 'gh-api':
    case 'graphql': {
      const answer = parseIncluded(Buffer.from(ran.stdout, 'utf8'))
      if (answer === undefined) return judged('not-sent', { reachedGitHub: false, remote: [] })
      let errors = false
      if (door.via === 'graphql') {
        try {
          const body = JSON.parse(answer.body) as { errors?: unknown }
          errors = Array.isArray(body.errors) && body.errors.length > 0
        } catch {
          errors = false
        }
      }
      const rest = { reachedGitHub: true, status: answer.status, ...(door.via === 'graphql' ? { errors } : {}), remote: [] }
      if (answer.status === 401) return judged('unauthenticated', rest)
      if (answer.status === 404 && judgedLater(door)) return judged('not-served', rest)
      if (answer.status >= 200 && answer.status < 300 && !errors) return judged(judgedLater(door) ? 'queued' : 'accepted', rest)
      const fallback = answer.status === 405 && door.via === 'gh-api' ? 'not-mergeable' : answer.status === 404 ? 'not-found' : 'unrecognised'
      return judged(classOf(`${answer.body}\n${ran.stderr}`) ?? fallback, rest)
    }
    case 'git-push': {
      const remote = ran.stderr.split(/\r?\n/).filter((line) => line.startsWith('remote:')).map((line) => line.trimEnd())
      if (ran.code === 0) return judged('accepted', { reachedGitHub: true, remote })
      const answered = remote.length > 0 || /\[remote rejected\]|\[rejected\]/.test(ran.stderr)
      const reason = classOf(ran.stderr)
      if (reason !== undefined) return judged(reason, { reachedGitHub: true, remote })
      return judged(answered ? 'unrecognised' : 'not-sent', { reachedGitHub: answered, remote })
    }
    default: {
      const _exhaustive: never = door.via
      throw new Error(`a door through ${String(_exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------- a queued door, observed

/** One look, after a queued door, at the pull request and the base: whether it is merged, whether it is open, the base's commit. */
export interface Observation {
  readonly merged: boolean
  readonly open: boolean
  readonly baseSha: string
}

/**
 * When the run looks after a queued door: six reads, five seconds apart —
 * 30 s, within the step's 180 s with every other door. GitHub answered
 * `merge-async` 202 and had not merged by the last of them (2026-10-02);
 * the end of the run looks again (`neverMerged`).
 */
export const QUEUED_PAUSES_MS: readonly number[] = [5_000, 5_000, 5_000, 5_000, 5_000, 5_000]

/**
 * A queued door's outcome, once observed: refused, still `queued`, when there
 * was at least one observation and, over every one, the pull request was never
 * merged and the base stayed at `baseSha`, the commit the run found it at — the
 * merge GitHub accepted and the rules then refused; not refused otherwise, the
 * invariant broken. Nothing observed proves nothing. Any other outcome is
 * returned as it is: an observation never makes a refusal of something else,
 * nor undoes one.
 */
export function queuedOutcome(outcome: DoorOutcome, observations: readonly Observation[], baseSha: string): DoorOutcome {
  if (outcome.reason !== 'queued') return outcome
  const held = observations.length > 0 && observations.every((seen) => !seen.merged && seen.baseSha === baseSha)
  return { ...outcome, refused: held }
}

/**
 * The line `tryDoor` writes on stderr for a door, from its entry: the door;
 * `refused`, `NOT REFUSED` for one GitHub carried out or queued and then did
 * not refuse, or `not tried`; the class and the status — for a queued door,
 * what its observations saw — and whether the base moved.
 */
export function doorLine(entry: DoorEntry): string {
  const carried = entry.reason === 'accepted' || entry.reason === 'queued'
  const verdict = entry.refused ? 'refused' : carried ? 'NOT REFUSED' : 'not tried'
  const status = entry.status === undefined ? '' : `, ${String(entry.status)}`
  const seen =
    entry.observed === undefined
      ? ''
      : `: accepted, ${entry.observed.merged ? 'merged within' : 'never merged over'} ${String(entry.observed.seconds)} s`
  return `live: ${entry.door}: ${verdict} (${entry.reason}${status}${seen}), the base ${entry.baseUnchanged ? 'unchanged' : 'MOVED'}`
}
