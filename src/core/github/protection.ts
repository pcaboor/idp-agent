import {
  pullRequestParameters,
  statusChecksParameters,
  type RepositoryAnswer,
  type RulesAnswer,
  type RulesetAnswer,
} from './answers.js'
import { isBranch, parseRemoteUrl, type GitHubRepository } from './remote.js'

/**
 * Whether a base keeps a pull request from merging until someone other than
 * its opener approves its latest commit, judged from what gh read (stage 6
 * brief § 8, items 1 to 5). Pure: the reads are `forge/github/preflight.ts`'s.
 *
 * A rule counts only when the ruleset that supplies it answers
 * `current_user_can_bypass: never` for the account gh acts as — the account
 * that will open the pull request. Two binding rulesets are read together,
 * the most restrictive winning, as GitHub enforces both. Classic branch
 * protection is never counted: its settings need an administrator to read,
 * and the owner decided a ruleset is required.
 *
 * A verdict that does not hold refuses a submission only on item 1 — the
 * push itself could not be made; anything of items 2 to 4 is a note, said on
 * stderr and in the pull request (`consequenceOf`, the owner's decision of
 * 2026-10-01): whether its author may merge it alone is the company's rule.
 */

/** What a base lacks, in the order it is said. */
export type Missing =
  | 'pull-request'
  | 'approvals'
  | 'last-push'
  | 'non-fast-forward'
  | 'deletion'
  | 'bypassable'
  | 'deploy-key'
  | 'classic-only'
  | 'archived'
  | 'no-push'
  | 'renamed'

/** `Missing`, in its order: a verdict names each at most once, in this order. */
const ORDER: readonly Missing[] = [
  'pull-request',
  'approvals',
  'last-push',
  'non-fast-forward',
  'deletion',
  'bypassable',
  'deploy-key',
  'classic-only',
  'archived',
  'no-push',
  'renamed',
]

export interface ProtectionVerdict {
  readonly holds: boolean
  readonly missing: readonly Missing[]
  /** The rulesets that supply a required rule, read one by one: ascending. */
  readonly rulesets: readonly number[]
  /**
   * Those of `rulesets` that answer `never`, ascending: the ones whose rules
   * count, and the ones a holding base is said to be protected by.
   */
  readonly binding: readonly number[]
  /** The supplying rulesets whose bypass list, as shown, holds a deploy key: set when `deploy-key` is missing. */
  readonly deployKeys?: readonly number[]
  /**
   * The name GitHub answered for a renamed or transferred repository, when it
   * is an `<owner>/<name>` by GitHub's grammar; otherwise nothing to print.
   */
  readonly renamedTo?: string
  readonly reported: {
    /** The approvals the binding pull request rules require, the most restrictive winning; 0 when none binds. */
    readonly approvals: number
    readonly codeOwners: boolean
    /** The required contexts, sorted: GitHub's own words, printed through `inertLine`. */
    readonly statusChecks: readonly string[]
    readonly signatures: boolean
    readonly mergeQueue: boolean
    /** A binding pull request rule requires the last push's approval, and none dismisses stale approvals. */
    readonly lastPushOnly: boolean
    /** A binding pull request rule dismisses stale approvals, and none requires the last push's approval. */
    readonly dismissStaleOnly: boolean
    /**
     * The binding rulesets' bypass lists that were shown, counted by type;
     * `unreadable` when none of them was. A non-binding ruleset's list is not
     * counted: it names whoever bypasses a rule that already does not count.
     */
    readonly bypassActors: readonly { readonly type: string; readonly count: number }[] | 'unreadable'
    /**
     * The binding rulesets whose bypass list GitHub left out, ascending: it
     * shows one only to someone who may edit the ruleset.
     */
    readonly bypassHidden: readonly number[]
    /** What the account may do in the repository; `read` cannot push, and fails on `no-push`. */
    readonly role: 'admin' | 'maintain' | 'write' | 'read'
  }
}

export interface ProtectionInput {
  /** The repository the remote's URL names. */
  readonly expected: GitHubRepository
  readonly repository: RepositoryAnswer
  /** The rules for the base; absent when item 1 failed and nothing more was read. */
  readonly rules?: RulesAnswer
  /** Each supplying ruleset that was read, by id. */
  readonly rulesets: ReadonlyMap<number, RulesetAnswer>
  /**
   * Whether the branch route calls the base protected, read as classic branch
   * protection and only when no ruleset supplies a required rule. GitHub says
   * `true` under a ruleset alone as well (2026-10-02), so a ruleset supplying
   * none of the three reads as `classic-only`: an open question in
   * `docs/roadmap.md`, "`protected: true` is not classic protection alone".
   */
  readonly classic?: boolean
}

/** The three rule types that keep the opener from merging (§ 8, item 2). */
const REQUIRED: ReadonlySet<string> = new Set(['pull_request', 'non_fast_forward', 'deletion'])

/** The actor type of a deploy key, which pushes with git where gh cannot see it. */
const DEPLOY_KEY = 'DeployKey'

/** In the type's order, each once. */
const ordered = (missing: ReadonlySet<Missing>): Missing[] => ORDER.filter((entry) => missing.has(entry))

const roleOf = (permissions: RepositoryAnswer['permissions']): ProtectionVerdict['reported']['role'] => {
  if (permissions.admin) return 'admin'
  if (permissions.maintain === true) return 'maintain'
  return permissions.push ? 'write' : 'read'
}

/**
 * Item 1 alone: an archived repository, one GitHub answers under another name
 * (whose rules would be read through a redirect), one the account cannot push
 * to. Any of them stops the check: no ruleset would help.
 */
export function repositoryMissing(expected: GitHubRepository, repository: RepositoryAnswer): Missing[] {
  const missing = new Set<Missing>()
  if (repository.archived) missing.add('archived')
  if (!repository.permissions.push) missing.add('no-push')
  if (repository.full_name.toLowerCase() !== `${expected.owner}/${expected.name}`.toLowerCase()) missing.add('renamed')
  return ordered(missing)
}

/** The name GitHub answered, kept only when it is one: it is printed. */
const answeredName = (fullName: string): string | undefined => {
  const parsed = parseRemoteUrl(`https://github.com/${fullName}`)
  return parsed.kind === 'github' && `${parsed.repository.owner}/${parsed.repository.name}` === fullName
    ? fullName
    : undefined
}

export function judgeProtection(input: ProtectionInput): ProtectionVerdict {
  const rules = input.rules ?? []
  const pullRequests = rules.flatMap((rule) =>
    rule.type === 'pull_request' ? [{ rule, parameters: pullRequestParameters.parse(rule.parameters) }] : [],
  )
  const reported = {
    codeOwners: pullRequests.some(({ parameters }) => parameters.require_code_owner_review === true),
    statusChecks: [
      ...new Set(
        rules.flatMap((rule) =>
          rule.type === 'required_status_checks'
            ? statusChecksParameters.parse(rule.parameters).required_status_checks.map((check) => check.context)
            : [],
        ),
      ),
    ].sort(),
    signatures: rules.some((rule) => rule.type === 'required_signatures'),
    mergeQueue: rules.some((rule) => rule.type === 'merge_queue'),
    role: roleOf(input.repository.permissions),
  }

  const first = repositoryMissing(input.expected, input.repository)
  if (first.length > 0) {
    const renamedTo = first.includes('renamed') ? answeredName(input.repository.full_name) : undefined
    return {
      holds: false,
      missing: first,
      rulesets: [],
      binding: [],
      ...(renamedTo === undefined ? {} : { renamedTo }),
      reported: {
        ...reported,
        approvals: 0,
        lastPushOnly: false,
        dismissStaleOnly: false,
        bypassActors: [],
        bypassHidden: [],
      },
    }
  }

  const supplying = rules.filter((rule) => REQUIRED.has(rule.type))
  const rulesets = [...new Set(supplying.map((rule) => rule.ruleset_id))].sort((a, b) => a - b)
  const binds = (id: number): boolean => input.rulesets.get(id)?.current_user_can_bypass === 'never'
  const binding = rulesets.filter(binds)

  const bindingPullRequests = pullRequests.filter(({ rule }) => binds(rule.ruleset_id))
  const approvals = Math.max(0, ...bindingPullRequests.map(({ parameters }) => parameters.required_approving_review_count))
  const lastPush = bindingPullRequests.some(({ parameters }) => parameters.require_last_push_approval === true)
  const dismissStale = bindingPullRequests.some(({ parameters }) => parameters.dismiss_stale_reviews_on_push === true)
  const bound = (type: string): boolean => supplying.some((rule) => rule.type === type && binds(rule.ruleset_id))

  const missing = new Set<Missing>()
  if (supplying.length === 0 && input.classic === true) {
    missing.add('classic-only')
  } else {
    if (bindingPullRequests.length === 0) missing.add('pull-request')
    else if (approvals < 1) missing.add('approvals')
    if (!lastPush && !dismissStale) missing.add('last-push')
    if (!bound('non_fast_forward')) missing.add('non-fast-forward')
    if (!bound('deletion')) missing.add('deletion')
    // Said only where it explains a rule that does not count: a ruleset gh's
    // account bypasses, repeating a rule a binding one supplies, takes nothing
    // away (§ 8, item 3: a rule counts only when its ruleset answers never).
    if ([...REQUIRED].some((type) => supplying.some((rule) => rule.type === type) && !bound(type))) {
      missing.add('bypassable')
    }
  }

  // Every list GitHub showed is looked at, whichever other list it left out:
  // a deploy key seen is said, on any supplying ruleset.
  const listOf = (id: number) => input.rulesets.get(id)?.bypass_actors
  const deployKeys = rulesets.filter((id) => listOf(id)?.some((actor) => actor.actor_type === DEPLOY_KEY) === true)
  if (deployKeys.length > 0) missing.add('deploy-key')

  const bypassHidden = binding.filter((id) => listOf(id) === undefined)
  const counts = new Map<string, number>()
  for (const actor of binding.flatMap((id) => listOf(id) ?? [])) {
    counts.set(actor.actor_type, (counts.get(actor.actor_type) ?? 0) + 1)
  }
  const bypassActors: ProtectionVerdict['reported']['bypassActors'] =
    binding.length > 0 && bypassHidden.length === binding.length
      ? 'unreadable'
      : [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([type, count]) => ({ type, count }))

  const said = ordered(missing)
  return {
    holds: said.length === 0,
    missing: said,
    rulesets,
    binding,
    ...(deployKeys.length === 0 ? {} : { deployKeys }),
    reported: {
      ...reported,
      approvals,
      lastPushOnly: lastPush && !dismissStale,
      dismissStaleOnly: dismissStale && !lastPush,
      bypassActors,
      bypassHidden,
    },
  }
}

/**
 * What a missing rule does to a submission (the owner's decision of
 * 2026-10-01): whether a pull request's author may merge it alone is the
 * company's rule, not idpa's, so a rule of items 2 to 4 that is missing is
 * said, never refused. `author-may-merge`: nothing binding asks for another
 * person's approval of the commit that would merge. `base-unguarded`: a
 * binding pull request rule may still ask for it, but no binding rule blocks
 * force pushes or deletions of the base.
 */
export type MergeNote = 'author-may-merge' | 'base-unguarded'

/**
 * Exhaustive over `Missing`: a note, or a refusal of the push itself (§ 8
 * item 1). `bypassable` is never a note of its own: `judgeProtection` adds it
 * only beside the required kind the bypassed ruleset supplies, which decides —
 * a bypassed pull request rule is `pull-request` too, so alone it can only
 * explain `non-fast-forward` or `deletion`. A deploy key in a bypass list
 * moves the base with a plain push, and gh cannot see who holds it.
 */
export function consequenceOf(missing: Missing): MergeNote | 'refused' {
  switch (missing) {
    case 'pull-request':
    case 'approvals':
    case 'last-push':
    case 'deploy-key':
    case 'classic-only':
      return 'author-may-merge'
    case 'non-fast-forward':
    case 'deletion':
    case 'bypassable':
      return 'base-unguarded'
    case 'archived':
    case 'no-push':
    case 'renamed':
      return 'refused'
    default: {
      const _exhaustive: never = missing
      return _exhaustive
    }
  }
}

/** Whether a verdict refuses the submission: some missing kind's consequence is `refused`. */
export function refusesPush(verdict: ProtectionVerdict): boolean {
  return verdict.missing.some((missing) => consequenceOf(missing) === 'refused')
}

/**
 * The one note a verdict carries, or none: `author-may-merge` when any missing
 * kind is one, else `base-unguarded` when any is, else undefined. Undefined
 * too when the verdict refuses: a caller reads `refusesPush` first.
 */
export function noteOf(verdict: ProtectionVerdict): MergeNote | undefined {
  if (refusesPush(verdict)) return undefined
  const consequences = new Set(verdict.missing.map(consequenceOf))
  if (consequences.has('author-may-merge')) return 'author-may-merge'
  return consequences.has('base-unguarded') ? 'base-unguarded' : undefined
}

/** The owner's words, on stderr and in the pull request's body. */
export const MERGE_NOTE = "note: on this repository the author may merge without another person's review"

/**
 * Where a note's line goes: `text` for stderr, `markdown` for the pull
 * request's body, where the base is written as code so that a branch name —
 * `@acme/security`, `fix#12`, `GH-12`, a commit's digits — cannot mention,
 * reference, link or render. The words are the same in both.
 */
export type NoteForm = 'text' | 'markdown'

/**
 * The `base-unguarded` line: a fact about the rules, never about their
 * effect, since a binding pull request rule refuses a direct push — a force
 * push included — by anyone it binds. It names the rules no binding ruleset
 * supplies among `non-fast-forward` and `deletion` (both, when `missing`
 * names neither: a line that says less would be the one that is false), and
 * the base only when it holds to the branch grammar and holds no backtick,
 * which would close its code span in the body, else "the base", in both
 * forms: the line reaches stderr and a pull request's body, and `core/` has
 * no `inertLine`.
 */
export function unguardedNote(base: string, missing: readonly Missing[], form: NoteForm = 'text'): string {
  const named = isBranch(base) && !base.includes('`')
  const where = !named ? 'the base' : form === 'markdown' ? `\`${base}\`` : base
  const forcePushes = missing.includes('non-fast-forward')
  const deletions = missing.includes('deletion')
  const what =
    forcePushes === deletions
      ? 'blocks force pushes or restricts deletions'
      : forcePushes
        ? 'blocks force pushes'
        : 'restricts deletions'
  return `note: on this repository no rule on ${where} that binds the author ${what}`
}

/** The line for a note, whichever it is, in the form its place reads. */
export function noteLine(note: MergeNote, base: string, missing: readonly Missing[], form: NoteForm = 'text'): string {
  switch (note) {
    case 'author-may-merge':
      return MERGE_NOTE
    case 'base-unguarded':
      return unguardedNote(base, missing, form)
    default: {
      const _exhaustive: never = note
      return _exhaustive
    }
  }
}

/** The longest line `noteLine` can return for a base of 255 bytes, in either form: what the body's bound is checked with. */
export const LONGEST_NOTE: string = [MERGE_NOTE, unguardedNote('a'.repeat(255), [], 'markdown')].reduce((longest, line) =>
  Buffer.byteLength(line, 'utf8') > Buffer.byteLength(longest, 'utf8') ? line : longest,
)

/**
 * The one list of settings (§ 8), printed by `idpa protection` and by
 * `init platform`, so the two cannot drift. `required`
 * is what `judgeProtection` checks; `advised` is what no read of the person's
 * can check, or what is policy rather than who may merge.
 */
export const PROTECTION_SETTINGS: readonly { readonly level: 'required' | 'advised'; readonly text: string }[] = [
  { level: 'required', text: 'require a pull request before merging — 1 approval' },
  {
    level: 'required',
    text: 'require approval of the most recent reviewable push (or dismiss stale approvals when new commits are pushed)',
  },
  { level: 'required', text: 'block force pushes; restrict deletions' },
  { level: 'required', text: 'nobody who submits in the bypass list' },
  { level: 'advised', text: 'no deploy key and no app in the bypass list' },
  {
    level: 'advised',
    text: 'GitHub Actions may not approve pull requests (Settings → Actions → General → Workflow permissions)',
  },
  { level: 'advised', text: 'set it at the organisation level, where a repository administrator cannot change it' },
  { level: 'advised', text: 'require review from Code Owners' },
  { level: 'advised', text: 'the downstream decision as a required status check, once one reports (ADR-0012)' },
]

/** `PROTECTION_SETTINGS` as § 8 prints them: `  required · …`, `  advised  · …`. */
export function protectionText(): string[] {
  return PROTECTION_SETTINGS.map(({ level, text }) => `  ${level.padEnd('required'.length)} · ${text}`)
}
