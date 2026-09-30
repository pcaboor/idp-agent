import type { RulesAnswer, RulesetAnswer } from '../../core/github/answers.js'
import { judgeProtection, repositoryMissing, type ProtectionVerdict } from '../../core/github/protection.js'
import { printedRepository } from '../../core/github/remote.js'
import type { Base, GitHubRoad } from '../provider.js'
import { GitHubAnswerError, type GitHubApi } from './api.js'
import { GITHUB_LIMITS } from './limits.js'

/**
 * What every submission checks on GitHub before anything is written, and
 * what `idpa protection` checks on its own (stage 6 brief § 8): through gh,
 * with `GET` only, in this order, and judged by `core/github/protection.ts`.
 *
 *   1. the repository — not archived, under the name the remote gives, and
 *      gh's account may push to it; any of the three stops the read here;
 *   2. the rules for the base, one page, refused past it;
 *   3. each ruleset that supplies a required rule, at most ten, refused
 *      before the first is read when there are more;
 *   4. the branch, for classic protection, only when no ruleset supplies a
 *      required rule — so the two reads are never both made;
 *   5. what is reported without being required, from the same answers.
 *
 * `readProtection` is those; `preflight` adds the base's ref, what a
 * submission needs and `idpa protection`, which has no local base, does not;
 * `readRules` is items 2 and 3 alone, what the GitHub forge reads again.
 * The run's budget is § 15's: 13 at most, the ref's included.
 */

/** The rule types a ruleset must supply for its id to be read (§ 8, item 3). */
const REQUIRED: ReadonlySet<string> = new Set(['pull_request', 'non_fast_forward', 'deletion'])

/** Items 2 and 3: the rules for the base, and each ruleset that supplies a required rule, at most ten. */
async function rulesOf(
  api: GitHubApi,
  road: GitHubRoad,
): Promise<{ readonly rules: RulesAnswer; readonly rulesets: ReadonlyMap<number, RulesetAnswer> }> {
  const expected = road.repository
  const rules = await api.rules(road.base)
  const supplying = [...new Set(rules.filter((rule) => REQUIRED.has(rule.type)).map((rule) => rule.ruleset_id))].sort(
    (a, b) => a - b,
  )
  if (supplying.length > GITHUB_LIMITS.rulesets) {
    throw new GitHubAnswerError(
      'rules',
      'too-large',
      expected,
      `${printedRepository(expected)}'s ${road.base} draws its rules from more than ${String(GITHUB_LIMITS.rulesets)} ` +
        'rulesets, more than this build reads. Nothing was written.',
    )
  }
  const rulesets = new Map<number, RulesetAnswer>()
  for (const id of supplying) rulesets.set(id, await api.ruleset(id))
  return { rules, rulesets }
}

export async function readProtection(api: GitHubApi, road: GitHubRoad): Promise<ProtectionVerdict> {
  const expected = road.repository
  const repository = await api.repository()
  if (repositoryMissing(expected, repository).length > 0) {
    return judgeProtection({ expected, repository, rulesets: new Map() })
  }

  const { rules, rulesets } = await rulesOf(api, road)
  if (rulesets.size > 0) return judgeProtection({ expected, repository, rules, rulesets })
  const { protected: classic } = await api.branch(road.base)
  return judgeProtection({ expected, repository, rules, rulesets, classic })
}

/**
 * Items 2 and 3 alone, at most eleven reads: what a submission reads again at
 * the moment of acting (§ 3, step 8) and once more before the pull request
 * (step 11), once the preflight has read the repository. Item 1 is the
 * preflight's, and a repository that failed it never reaches a submission, so
 * it is judged here as the preflight found it; the account's role is not read
 * again, and `reported.role` says nothing here. With no ruleset supplying a
 * required rule, the branch is not read: whether classic protection covers
 * it, the base does not hold.
 */
export async function readRules(api: GitHubApi, road: GitHubRoad): Promise<ProtectionVerdict> {
  const { owner, name } = road.repository
  const { rules, rulesets } = await rulesOf(api, road)
  return judgeProtection({
    expected: road.repository,
    repository: { full_name: `${owner}/${name}`, archived: false, permissions: { admin: false, push: true } },
    rules,
    rulesets,
  })
}

/** The rules, and whether GitHub's base is at the commit the clone's is. */
export interface Preflight {
  readonly verdict: ProtectionVerdict
  /** `level`, or the commit GitHub's base is at instead: the clone is behind it, ahead of it, or elsewhere. */
  readonly level: 'level' | { readonly github: string }
}

export async function preflight(api: GitHubApi, road: GitHubRoad, base: Base): Promise<Preflight> {
  const verdict = await readProtection(api, road)
  const github = await api.ref(road.base)
  return { verdict, level: github === base.commit ? 'level' : { github } }
}
