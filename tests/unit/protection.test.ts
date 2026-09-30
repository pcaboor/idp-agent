import { describe, expect, it } from 'vitest'
import {
  repositoryAnswer,
  rulesAnswer,
  rulesetAnswer,
  type RulesetAnswer,
} from '../../src/core/github/answers.js'
import {
  PROTECTION_SETTINGS,
  judgeProtection,
  protectionText,
  type ProtectionInput,
} from '../../src/core/github/protection.js'
import type { GitHubRepository } from '../../src/core/github/remote.js'

/**
 * The judgement of stage 6 brief § 8, items 1 to 5, over GitHub's answers as
 * GitHub writes them — `type`, `ruleset_id`, `parameters` — parsed by the
 * schemas the forge parses them with, so a fixture GitHub would not write is
 * refused here before it is judged. Pure: no process, no gh.
 */

const ACME: GitHubRepository = { host: 'github.com', owner: 'acme', name: 'iac' }

/** `GET repos/acme/iac` for an account holding `permissions`. */
const repository = (
  fields: { full_name?: string; archived?: boolean; admin?: boolean; maintain?: boolean; push?: boolean } = {},
) =>
  repositoryAnswer.parse({
    id: 1,
    full_name: fields.full_name ?? 'acme/iac',
    archived: fields.archived ?? false,
    permissions: {
      admin: fields.admin ?? false,
      maintain: fields.maintain ?? false,
      push: fields.push ?? true,
      triage: true,
      pull: true,
    },
  })

/** One rule of `GET rules/branches/<b>`, as GitHub answers it. */
const rule = (type: string, rulesetId: number, parameters?: Record<string, unknown>) => ({
  type,
  ruleset_source_type: 'Repository',
  ruleset_source: 'acme/iac',
  ruleset_id: rulesetId,
  ...(parameters === undefined ? {} : { parameters }),
})

/** A pull request rule: 1 approval and the most recent push's approval, unless `change` says otherwise. */
const pullRequest = (rulesetId: number, change: Record<string, unknown> = {}) =>
  rule('pull_request', rulesetId, {
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: true,
    required_review_thread_resolution: false,
    ...change,
  })

/**
 * `GET rulesets/<id>`: `bypass` is what `current_user_can_bypass` answers,
 * and `actors` the bypass list; `null` leaves the field out, as GitHub does.
 */
const ruleset = (
  id: number,
  bypass: string | null = 'never',
  actors: readonly { actor_type: string; actor_id?: number | null; bypass_mode?: string }[] | null = [],
): RulesetAnswer =>
  rulesetAnswer.parse({
    id,
    name: `ruleset ${String(id)}`,
    target: 'branch',
    enforcement: 'active',
    ...(bypass === null ? {} : { current_user_can_bypass: bypass }),
    ...(actors === null ? {} : { bypass_actors: actors }),
  })

/** The three required rules from `id`. */
const protectedBy = (id: number, change: Record<string, unknown> = {}) => [
  pullRequest(id, change),
  rule('non_fast_forward', id),
  rule('deletion', id),
]

const judged = (input: {
  rules?: readonly unknown[]
  rulesets?: readonly RulesetAnswer[]
  repository?: ReturnType<typeof repository>
  classic?: boolean
}) => {
  const given: ProtectionInput = {
    expected: ACME,
    repository: input.repository ?? repository(),
    ...(input.rules === undefined ? {} : { rules: rulesAnswer.parse(input.rules) }),
    rulesets: new Map((input.rulesets ?? []).map((answer) => [answer.id, answer])),
    ...(input.classic === undefined ? {} : { classic: input.classic }),
  }
  return judgeProtection(given)
}

describe('judgeProtection: what keeps the opener from merging (§ 8, items 2 and 3)', () => {
  it('holds for one ruleset that binds gh’s account: a pull request, the last push’s approval, no force push, no deletion', () => {
    const verdict = judged({ rules: protectedBy(1), rulesets: [ruleset(1)] })
    expect(verdict.holds).toBe(true)
    expect(verdict.missing).toEqual([])
    expect(verdict.rulesets).toEqual([1])
    expect(verdict.reported).toEqual({
      approvals: 1,
      codeOwners: false,
      statusChecks: [],
      signatures: false,
      mergeQueue: false,
      lastPushOnly: true,
      dismissStaleOnly: false,
      bypassActors: [],
      bypassHidden: [],
      role: 'write',
    })
    expect(verdict.binding).toEqual([1])
  })

  it('holds with stale approvals dismissed in place of the last push’s approval, and says so', () => {
    const verdict = judged({
      rules: protectedBy(1, { require_last_push_approval: false, dismiss_stale_reviews_on_push: true }),
      rulesets: [ruleset(1)],
    })
    expect(verdict.holds).toBe(true)
    expect(verdict.reported).toMatchObject({ dismissStaleOnly: true, lastPushOnly: false })
  })

  it('refuses a pull request rule that requires no approval', () => {
    const verdict = judged({ rules: protectedBy(1, { required_approving_review_count: 0 }), rulesets: [ruleset(1)] })
    expect(verdict).toMatchObject({ holds: false, missing: ['approvals'] })
  })

  it('refuses a pull request rule with neither push rule', () => {
    const verdict = judged({ rules: protectedBy(1, { require_last_push_approval: false }), rulesets: [ruleset(1)] })
    expect(verdict).toMatchObject({ holds: false, missing: ['last-push'] })
  })

  it('refuses no pull request rule at all, naming both of its halves', () => {
    const verdict = judged({ rules: [rule('non_fast_forward', 1), rule('deletion', 1)], rulesets: [ruleset(1)] })
    expect(verdict).toMatchObject({ holds: false, missing: ['pull-request', 'last-push'] })
  })

  it('refuses a base where force pushes are not blocked, or deletions not restricted', () => {
    expect(judged({ rules: [pullRequest(1), rule('deletion', 1)], rulesets: [ruleset(1)] })).toMatchObject({
      holds: false,
      missing: ['non-fast-forward'],
    })
    expect(judged({ rules: [pullRequest(1), rule('non_fast_forward', 1)], rulesets: [ruleset(1)] })).toMatchObject({
      holds: false,
      missing: ['deletion'],
    })
  })

  it.each([['always'], ['pull_requests_only'], ['exempt'], ['a word GitHub has not written yet'], [null]])(
    'counts no rule of a ruleset answering current_user_can_bypass %s',
    (bypass) => {
      const verdict = judged({ rules: protectedBy(1), rulesets: [ruleset(1, bypass)] })
      expect(verdict).toMatchObject({
        holds: false,
        missing: ['pull-request', 'last-push', 'non-fast-forward', 'deletion', 'bypassable'],
      })
    },
  )

  it('counts each rule by the ruleset that supplies it', () => {
    const verdict = judged({
      rules: [pullRequest(1), rule('non_fast_forward', 2), rule('deletion', 2)],
      rulesets: [ruleset(1), ruleset(2, 'always')],
    })
    expect(verdict).toMatchObject({ holds: false, missing: ['non-fast-forward', 'deletion', 'bypassable'] })
    expect(verdict.rulesets).toEqual([1, 2])
  })

  it('counts a rule whose ruleset was not read as not binding', () => {
    const verdict = judged({ rules: protectedBy(1), rulesets: [] })
    expect(verdict).toMatchObject({ holds: false, missing: ['pull-request', 'last-push', 'non-fast-forward', 'deletion', 'bypassable'] })
  })

  it('reads two binding rulesets together, the most restrictive winning, as GitHub enforces both', () => {
    const verdict = judged({
      rules: [
        pullRequest(1, { require_last_push_approval: false }),
        pullRequest(2, { required_approving_review_count: 0 }),
        rule('non_fast_forward', 1),
        rule('deletion', 2),
      ],
      rulesets: [ruleset(1), ruleset(2)],
    })
    expect(verdict).toMatchObject({ holds: true, missing: [], rulesets: [1, 2] })
    expect(verdict.reported.approvals).toBe(1)
  })

  it('refuses no base for a ruleset gh’s account can bypass when binding ones supply every rule it repeats', () => {
    const verdict = judged({
      rules: [...protectedBy(1), rule('deletion', 2)],
      rulesets: [ruleset(1), ruleset(2, 'always')],
    })
    expect(verdict).toMatchObject({ holds: true, missing: [], rulesets: [1, 2], binding: [1] })
  })

  it('names bypassable only for a rule no binding ruleset supplies', () => {
    const verdict = judged({
      rules: [pullRequest(1), rule('non_fast_forward', 1), rule('non_fast_forward', 2)],
      rulesets: [ruleset(1), ruleset(2, 'always')],
    })
    expect(verdict).toMatchObject({ holds: false, missing: ['deletion'], binding: [1] })
  })

  it('reports the approvals the most restrictive binding rule requires', () => {
    const verdict = judged({ rules: protectedBy(1, { required_approving_review_count: 2 }), rulesets: [ruleset(1)] })
    expect(verdict.reported.approvals).toBe(2)
  })
})

describe('judgeProtection: the bypass list (§ 8, item 3)', () => {
  it('refuses a deploy key it can see in a supplying ruleset’s bypass list', () => {
    const verdict = judged({
      rules: protectedBy(1),
      rulesets: [ruleset(1, 'never', [{ actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' }])],
    })
    expect(verdict).toMatchObject({ holds: false, missing: ['deploy-key'] })
    expect(verdict.reported.bypassActors).toEqual([{ type: 'DeployKey', count: 1 }])
  })

  it('names the ruleset whose bypass list holds a deploy key', () => {
    const verdict = judged({
      rules: [...protectedBy(1), rule('deletion', 2)],
      rulesets: [ruleset(1), ruleset(2, 'never', [{ actor_type: 'DeployKey', actor_id: 4, bypass_mode: 'always' }])],
    })
    expect(verdict).toMatchObject({ holds: false, missing: ['deploy-key'], deployKeys: [2] })
  })

  it('refuses a deploy key it can see even when another supplying ruleset hides its bypass list', () => {
    const verdict = judged({
      rules: [pullRequest(1), rule('non_fast_forward', 1), rule('deletion', 2)],
      rulesets: [
        ruleset(1, 'never', [{ actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' }]),
        ruleset(2, 'never', null),
      ],
    })
    expect(verdict).toMatchObject({ holds: false, missing: ['deploy-key'], deployKeys: [1] })
  })

  it('refuses a deploy key in the bypass list of a ruleset that binds nobody here', () => {
    const verdict = judged({
      rules: [...protectedBy(1), rule('deletion', 2)],
      rulesets: [ruleset(1), ruleset(2, 'always', [{ actor_type: 'DeployKey', actor_id: 4, bypass_mode: 'always' }])],
    })
    expect(verdict).toMatchObject({ holds: false, missing: ['deploy-key'], deployKeys: [2] })
  })

  it('says the bypass list could not be read when GitHub leaves it out', () => {
    const verdict = judged({ rules: protectedBy(1), rulesets: [ruleset(1, 'never', null)] })
    expect(verdict).toMatchObject({ holds: true, missing: [] })
    expect(verdict.reported.bypassActors).toBe('unreadable')
    expect(verdict.reported.bypassHidden).toEqual([1])
  })

  it('counts the lists it was shown and names the rulesets whose list it was not', () => {
    const verdict = judged({
      rules: [pullRequest(1), rule('non_fast_forward', 1), rule('deletion', 2)],
      rulesets: [ruleset(1, 'never', [{ actor_type: 'Team', actor_id: 7, bypass_mode: 'always' }]), ruleset(2, 'never', null)],
    })
    expect(verdict).toMatchObject({ holds: true, missing: [] })
    expect(verdict.reported.bypassActors).toEqual([{ type: 'Team', count: 1 }])
    expect(verdict.reported.bypassHidden).toEqual([2])
  })

  it('reports only the binding rulesets’ bypass lists: another one’s names whoever bypasses a rule that is not counted', () => {
    const verdict = judged({
      rules: [...protectedBy(1), rule('deletion', 2)],
      rulesets: [ruleset(1), ruleset(2, 'always', [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }])],
    })
    expect(verdict).toMatchObject({ holds: true, missing: [] })
    expect(verdict.reported).toMatchObject({ bypassActors: [], bypassHidden: [] })
  })

  it('counts every other actor by its type, and names none', () => {
    const verdict = judged({
      rules: protectedBy(1),
      rulesets: [
        ruleset(1, 'never', [
          { actor_type: 'Team', actor_id: 7, bypass_mode: 'always' },
          { actor_type: 'Integration', actor_id: 12, bypass_mode: 'always' },
        ]),
      ],
    })
    expect(verdict).toMatchObject({ holds: true, missing: [] })
    expect(verdict.reported.bypassActors).toEqual([
      { type: 'Integration', count: 1 },
      { type: 'Team', count: 1 },
    ])
  })
})

describe('judgeProtection: classic branch protection (§ 8, item 4)', () => {
  it('refuses a base protected by classic branch protection alone', () => {
    const verdict = judged({ rules: [], classic: true })
    expect(verdict).toMatchObject({ holds: false, missing: ['classic-only'], rulesets: [] })
  })

  it('refuses a base protected by nothing, naming every rule', () => {
    const verdict = judged({ rules: [], classic: false })
    expect(verdict).toMatchObject({
      holds: false,
      missing: ['pull-request', 'last-push', 'non-fast-forward', 'deletion'],
    })
  })
})

describe('judgeProtection: the repository (§ 8, item 1)', () => {
  it('stops at an archived repository, whatever else it would say', () => {
    const verdict = judged({ repository: repository({ archived: true }) })
    expect(verdict).toMatchObject({ holds: false, missing: ['archived'], rulesets: [] })
  })

  it('reads the remote’s name as GitHub does, ignoring case', () => {
    expect(
      judged({ repository: repository({ full_name: 'Acme/IAC' }), rules: protectedBy(1), rulesets: [ruleset(1)] }).holds,
    ).toBe(true)
  })

  it('stops at a repository GitHub answers under another name, and keeps the name it answered', () => {
    const verdict = judged({ repository: repository({ full_name: 'other/iac' }) })
    expect(verdict).toMatchObject({ holds: false, missing: ['renamed'], renamedTo: 'other/iac' })
    // A name outside GitHub's grammar is not kept to be printed.
    const odd = judged({ repository: repository({ full_name: 'other/\u001b[2Jiac' }) })
    expect(odd).toMatchObject({ holds: false, missing: ['renamed'] })
    expect(odd.renamedTo).toBeUndefined()
  })

  it('stops at an account that cannot push, whose role is read', () => {
    const verdict = judged({ repository: repository({ push: false }) })
    expect(verdict).toMatchObject({ holds: false, missing: ['no-push'] })
    expect(verdict.reported.role).toBe('read')
  })

  it('names every failure of item 1 at once, in the type’s order', () => {
    const verdict = judged({ repository: repository({ archived: true, push: false, full_name: 'other/iac' }) })
    expect(verdict.missing).toEqual(['archived', 'no-push', 'renamed'])
  })

  it('reads the role from the repository’s permissions', () => {
    const rules = protectedBy(1)
    const rulesets = [ruleset(1)]
    expect(judged({ repository: repository({ admin: true, maintain: true }), rules, rulesets }).reported.role).toBe('admin')
    expect(judged({ repository: repository({ maintain: true }), rules, rulesets }).reported.role).toBe('maintain')
    expect(judged({ repository: repository(), rules, rulesets }).reported.role).toBe('write')
  })
})

describe('judgeProtection: what is reported, not required (§ 8, item 5)', () => {
  it('reports the status checks, signed commits, a merge queue and review from Code Owners', () => {
    const verdict = judged({
      rules: [
        ...protectedBy(1, { require_code_owner_review: true }),
        rule('required_status_checks', 3, {
          required_status_checks: [{ context: 'deploy/tufin' }, { context: 'ci', integration_id: 15368 }],
          strict_required_status_checks_policy: false,
        }),
        rule('required_signatures', 3),
        rule('merge_queue', 3, { merge_method: 'MERGE' }),
      ],
      rulesets: [ruleset(1)],
    })
    expect(verdict.holds).toBe(true)
    // A ruleset that supplies only what is reported is not read: it decides nothing.
    expect(verdict.rulesets).toEqual([1])
    expect(verdict.reported).toMatchObject({
      statusChecks: ['ci', 'deploy/tufin'],
      signatures: true,
      mergeQueue: true,
      codeOwners: true,
    })
  })
})

describe('the answers, as the schemas read them', () => {
  it('refuses a pull request rule whose parameters it cannot read', () => {
    expect(rulesAnswer.safeParse([rule('pull_request', 1, { required_approving_review_count: 'one' })]).success).toBe(false)
    expect(rulesAnswer.safeParse([rule('pull_request', 1)]).success).toBe(false)
  })

  it('refuses a rule with no ruleset to hold it to', () => {
    expect(rulesAnswer.safeParse([{ type: 'deletion' }]).success).toBe(false)
    expect(rulesAnswer.safeParse([{ type: 'deletion', ruleset_id: 0 }]).success).toBe(false)
  })

  it('keeps only the fields it reads', () => {
    const parsed = repositoryAnswer.parse({ ...repository(), owner: { login: 'acme' }, description: 'x', canary: 'kept?' })
    expect(parsed).not.toHaveProperty('canary')
    expect(parsed).not.toHaveProperty('description')
  })
})

describe('PROTECTION_SETTINGS', () => {
  it('prints § 8’s nine lines, in its order', () => {
    expect(PROTECTION_SETTINGS).toEqual([
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
    ])
    expect(protectionText()).toEqual([
      '  required · require a pull request before merging — 1 approval',
      '  required · require approval of the most recent reviewable push (or dismiss stale approvals when new commits are pushed)',
      '  required · block force pushes; restrict deletions',
      '  required · nobody who submits in the bypass list',
      '  advised  · no deploy key and no app in the bypass list',
      '  advised  · GitHub Actions may not approve pull requests (Settings → Actions → General → Workflow permissions)',
      '  advised  · set it at the organisation level, where a repository administrator cannot change it',
      '  advised  · require review from Code Owners',
      '  advised  · the downstream decision as a required status check, once one reports (ADR-0012)',
    ])
  })
})
