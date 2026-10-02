import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { refuseUnprotected } from '../../src/cli/commands/submit.js'
import { MERGE_NOTE, consequenceOf, noteOf, refusesPush, type Missing } from '../../src/core/github/protection.js'
import type { Cleared } from '../../src/core/plan/clear.js'
import { preflight } from '../../src/forge/github/preflight.js'
import type { Submitted } from '../../src/forge/provider.js'
import { GH_LIMITS, parseIncluded, type GhProcess } from '../../src/process/gh.js'
import { gitIn, pushIn, type Git, type Push } from '../../src/process/git.js'
import type { FakeRepository, FakeRuleset } from '../../tools/fake-gh.js'
import { MERGE_DOOR, protectedMain, protectingRuleset, repository } from '../support/fake-gh.js'
import { clearedFor, removeClones } from '../support/forge-fixture.js'
import { githubClone, githubForge, remoteRefs, type GitHubClone } from '../support/github-fixture.js'
import { git, observable, show } from '../support/git.js'

/**
 * Two systems, every failure (stage 6 brief § 4's table, § 10): a submission
 * to GitHub failing at any git call, the push, or any gh call — before the
 * call runs, or after it ran and its answer was lost — leaves one of four
 * states, each a row of § 4's table, and the same command run again
 * completes it: one local branch, the same commit on GitHub, exactly one
 * pull request, the files byte for byte the edits'. Each system is atomic on
 * its own; the two together are not, and are not claimed to be.
 *
 * Every call, not a sample, as `tests/invariants/forge.test.ts` does for the
 * local forge. Some two hundred clones and bare repositories: each attempt's
 * directories are removed as soon as it is judged. Run it targeted, after
 * `df -h "$TMPDIR"`.
 */

type Outcome = Submitted | 'threw'

afterAll(removeClones)

/** One counter across the three ways a submission reaches a process. */
const counted = (clone: GitHubClone, hook: (call: number, run: () => Promise<void>) => Promise<void>) => {
  let armed = false
  let seen = 0
  const around = async <T>(call: () => Promise<T>): Promise<T> => {
    if (!armed) return call()
    const at = ++seen
    let result: T | undefined
    let ran = false
    await hook(at, async () => {
      result = await call()
      ran = true
    })
    if (!ran) result = await call()
    return result as T
  }
  const inner = gitIn(clone.repo, { env: clone.env })
  const pushing = pushIn(clone.repo, { env: clone.env })
  const git: Git = (args, input) => around(() => inner(args, input))
  const push: Push = (request) => around(() => pushing(request))
  let posts = 0
  const gh: GhProcess = (argv, options) => {
    if (argv[4] === 'POST') posts += 1
    return around(() => clone.gh.process(argv, options))
  }
  return {
    git,
    push,
    gh,
    posts: () => posts,
    arm: () => {
      armed = true
    },
    calls: () => seen,
  }
}

/** A failure at call `k`: thrown before it runs, or after it ran with its answer lost. */
const failingAt =
  (k: number, late: boolean) =>
  async (call: number, run: () => Promise<void>): Promise<void> => {
    if (call !== k) return run()
    if (!late) throw new Error(`injected before call ${String(k)}`)
    await run()
    throw new Error(`injected after call ${String(k)}`)
  }

/** A run as the CLI makes one: recognition, then the submission when nothing was recognised or it is ours to finish. */
const run = async (clone: GitHubClone, change: Cleared, options: Parameters<typeof githubForge>[1] = {}, arm = () => {}) => {
  const { forge } = await githubForge(clone, { wait: async () => {}, ...options })
  const base = await forge.base()
  arm()
  const outcome: Outcome = await (async () => {
    const known = await forge.recognise(change, base)
    if (known !== undefined && known.outcome !== 'pushed-without-pull-request') return known
    return forge.submit(change, base)
  })().catch(() => 'threw' as const)
  return outcome
}

/** The four states § 4's table leaves, by what exists where. */
const stateOf = async (clone: GitHubClone, change: Cleared) => {
  const local = await git(clone.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${change.branch}`).catch(() => undefined)
  const remote = await git(clone.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${change.branch}`).catch(() => undefined)
  const pulls = clone.gh.state.pulls ?? []
  if (local === undefined && remote === undefined && pulls.length === 0) return 'nothing'
  if (local !== undefined && remote === undefined && pulls.length === 0) return 'local'
  if (local !== undefined && remote === local && pulls.length === 0) return 'pushed'
  if (local !== undefined && remote === local && pulls.length === 1) return 'opened'
  return `no row of § 4: local ${String(local)}, GitHub ${String(remote)}, ${String(pulls.length)} pull request(s)`
}

/** The lines `after` holds that `before` does not, and the ones it lost, other than the branch's own. */
const movedBesides = (before: string, after: string, branch: string): string[] => {
  const was = before.split('\n')
  const is = after.split('\n')
  return [...is.filter((line) => !was.includes(line)), ...was.filter((line) => !is.includes(line))].filter(
    (line) => !line.startsWith(`refs/heads/${branch} `),
  )
}

const discard = async (clone: GitHubClone): Promise<void> => {
  await rm(path.dirname(clone.repo), { recursive: true, force: true })
}

describe('§ 4 — a submission to GitHub across two systems', () => {
  it('a submission failing at any git, push or gh call leaves a row of § 4\'s table, and the next run converges', async () => {
    const first = await githubClone()
    const change = await clearedFor(first.repo)
    const clean = counted(first, (_, call) => call())
    const outcome = await run(first, change, clean, clean.arm)
    expect(outcome).toMatchObject({ outcome: 'created', pushed: true })
    // Non-vacuous: a submission that makes no call proves nothing.
    const calls = clean.calls()
    expect(calls).toBeGreaterThan(20)
    await discard(first)

    const seen = new Set<string>()
    for (let k = 1; k <= calls; k++) {
      for (const late of [false, true]) {
        const where = `call ${String(k)} failing ${late ? 'after' : 'before'} it ran`
        const clone = await githubClone()
        const before = { repo: await observable(clone.repo), refs: await remoteRefs(clone.bare) }
        const failing = counted(clone, failingAt(k, late))
        const faulted = await run(clone, change, failing, failing.arm)

        const reached = await stateOf(clone, change)
        seen.add(reached)
        expect(['nothing', 'local', 'pushed', 'opened'], where).toContain(reached)
        expect(movedBesides(before.repo, await observable(clone.repo), change.branch), where).toEqual([])
        expect(movedBesides(before.refs, await remoteRefs(clone.bare), change.branch), where).toEqual([])
        if (faulted !== 'threw' && (faulted.outcome === 'created' || faulted.outcome === 'already-submitted')) {
          expect(reached, where).toBe('opened')
        }
        if (faulted === 'threw' || (faulted.outcome === 'refused' && faulted.kept === undefined)) {
          expect(reached, where).toBe('nothing')
        }
        // A POST refused before it ran counts as sent.
        expect(failing.posts(), where).toBeLessThanOrEqual(1)

        // The same command again, with no fault, completes it.
        const again = await run(clone, change)
        expect(again === 'threw' ? again : again.outcome, where).toMatch(/^(created|already-submitted)$/)
        expect(await stateOf(clone, change), where).toBe('opened')
        const branch = await git(clone.repo, 'rev-parse', `refs/heads/${change.branch}`)
        expect(await git(clone.repo, 'rev-parse', `${branch}^`), where).toBe(await git(clone.repo, 'rev-parse', 'main'))
        for (const edit of change.edits) expect(await show(clone.repo, branch, edit.path), where).toBe(edit.after)
        await discard(clone)
      }
    }
    // Every row was reached, the first and the last included.
    expect([...seen].sort()).toEqual(['local', 'nothing', 'opened', 'pushed'])
  }, 300_000)

  it('a branch a stranger pushes at any moment is never moved, nor claimed', async () => {
    const first = await githubClone()
    const change = await clearedFor(first.repo)
    const clean = counted(first, (_, call) => call())
    await run(first, change, clean, clean.arm)
    const calls = clean.calls()
    await discard(first)

    let raced = 0
    for (let k = 1; k <= calls; k++) {
      const where = `a stranger's branch before call ${String(k)}`
      const clone = await githubClone()
      const stranger = await git(clone.bare, 'rev-parse', 'main')
      let landed = false
      const racing = counted(clone, async (call, next) => {
        if (call === k) {
          // Created only where none is: once our push landed, there is nothing to race.
          landed = await git(clone.bare, 'update-ref', `refs/heads/${change.branch}`, stranger, '').then(
            () => true,
            () => false,
          )
        }
        await next()
      })
      const outcome = await run(clone, change, racing, racing.arm)
      if (!landed) {
        await discard(clone)
        continue
      }
      raced++

      expect(outcome, where).toMatchObject({ outcome: 'refused' })
      expect(await git(clone.bare, 'rev-parse', `refs/heads/${change.branch}`), where).toBe(stranger)
      expect(clone.gh.state.pulls ?? [], where).toEqual([])
      expect(await run(clone, change), where).toMatchObject({ outcome: 'refused' })
      expect(await git(clone.bare, 'rev-parse', `refs/heads/${change.branch}`), where).toBe(stranger)
      await discard(clone)
    }
    // The race was run up to the push, at least: every call before it.
    expect(raced).toBeGreaterThan(20)
  }, 300_000)
})

// ---------------------------------------------------------------------------
// The owner's decision of 2026-10-01: the pull request is always opened, and
// says when its author may merge it alone. Every shape of rules the fake
// models, one submission each through the forge.

/** `ada` opens the pull request; `grace` may review it. */
const ACCOUNTS = [
  { login: 'ada', type: 'User' as const },
  { login: 'grace', type: 'User' as const },
]
const ADMIN = { admin: true, maintain: false, push: true }
const WRITE = { admin: false, maintain: false, push: true }

/** One shape of rules on `main`: its name, the repository the fake models, and whether a deploy key is in a bypass list. */
interface Shape {
  readonly name: string
  readonly model: (bare: string) => FakeRepository
  readonly deployKey: boolean
}

const pullRequestRule = (approvals: number, lastPush: boolean): FakeRuleset['rules'][number] => ({
  type: 'pull_request',
  parameters: {
    required_approving_review_count: approvals,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: lastPush,
    required_review_thread_resolution: false,
  },
})

/** Every combination: the pull request rule absent, of 0 approvals, of 1 without and with the last push's; force pushes and deletions blocked or not. */
const RULE_SHAPES: readonly Shape[] = (() => {
  const shapes: Shape[] = []
  const pulls = [
    ['no pull request rule', undefined],
    ['0 approvals', pullRequestRule(0, true)],
    ['1 approval, no push rule', pullRequestRule(1, false)],
    ['1 approval and the last push', pullRequestRule(1, true)],
  ] as const
  for (const [pullName, pull] of pulls) {
    for (const forcePushes of [true, false]) {
      for (const deletions of [true, false]) {
        const rules = [
          ...(pull === undefined ? [] : [pull]),
          ...(forcePushes ? [{ type: 'non_fast_forward' }] : []),
          ...(deletions ? [{ type: 'deletion' }] : []),
        ]
        shapes.push({
          name: `${pullName}; force pushes ${forcePushes ? 'blocked' : 'not blocked'}; deletions ${deletions ? 'restricted' : 'not restricted'}`,
          model: (bare) =>
            protectedMain({ bare, permissions: { ada: ADMIN, grace: WRITE }, rulesets: [protectingRuleset(1, { rules })] }),
          deployKey: false,
        })
      }
    }
  }
  // gh's account in the bypass list of the ruleset docs/submitting.md asks for, in each mode.
  for (const mode of ['always', 'pull_request', 'exempt'] as const) {
    shapes.push({
      name: `the author bypasses the whole ruleset (${mode})`,
      model: (bare) =>
        protectedMain({
          bare,
          permissions: { ada: ADMIN, grace: WRITE },
          rulesets: [protectingRuleset(1, { bypass: [{ actor_type: 'User', actor_id: 1000, bypass_mode: mode }] })],
        }),
      deployKey: false,
    })
  }
  // A binding pull request rule beside a ruleset the author bypasses that alone supplies one guard: § 8's bypassable.
  for (const [guard, other] of [
    ['non_fast_forward', 'deletion'],
    ['deletion', 'non_fast_forward'],
  ] as const) {
    shapes.push({
      name: `a binding pull request rule; ${guard} only in a ruleset the author bypasses`,
      model: (bare) =>
        protectedMain({
          bare,
          permissions: { ada: ADMIN, grace: WRITE },
          rulesets: [
            protectingRuleset(1, { rules: [pullRequestRule(1, true), { type: other }] }),
            protectingRuleset(2, { rules: [{ type: guard }], bypass: [{ actor_type: 'User', actor_id: 1000, bypass_mode: 'always' }] }),
          ],
        }),
      deployKey: false,
    })
  }
  // A bypassed ruleset that alone supplies the pull request rule.
  shapes.push({
    name: 'the pull request rule only in a ruleset the author bypasses',
    model: (bare) =>
      protectedMain({
        bare,
        permissions: { ada: ADMIN, grace: WRITE },
        rulesets: [
          protectingRuleset(1, { rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }] }),
          protectingRuleset(2, { rules: [pullRequestRule(1, true)], bypass: [{ actor_type: 'User', actor_id: 1000, bypass_mode: 'always' }] }),
        ],
      }),
    deployKey: false,
  })
  // A deploy key in the bypass list, shown to an administrator and hidden from a writer.
  const deployKey = { actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' as const }
  for (const [who, permission] of [
    ['shown', ADMIN],
    ['hidden', WRITE],
  ] as const) {
    shapes.push({
      name: `a deploy key in a bypass list ${who} to the author`,
      model: (bare) =>
        protectedMain({ bare, permissions: { ada: permission, grace: WRITE }, rulesets: [protectingRuleset(1, { bypass: [deployKey] })] }),
      deployKey: true,
    })
  }
  shapes.push({
    name: 'classic branch protection alone',
    model: (bare) => repository({ bare, permissions: { ada: ADMIN, grace: WRITE }, branches: { main: { protected: true } } }),
    deployKey: false,
  })
  return shapes
})()

/**
 * Whether the author can merge pull request #1 alone, as the note claims: grace
 * approves its head, the author pushes a commit on top of it, and the author
 * merges through the fake. True when the merge answered 200 and `main` moved.
 */
const mergedAlone = async (clone: GitHubClone, outcome: Submitted, branch: string): Promise<boolean> => {
  if (outcome.outcome !== 'created') throw new Error(outcome.outcome)
  clone.gh.approve(1, 'grace')
  const top = await git(clone.repo, 'commit-tree', `${outcome.commit}^{tree}`, '-p', outcome.commit, '-m', 'pushed on top of the approved head')
  await git(clone.repo, 'push', '-q', clone.bare, `${top}:refs/test/on-top`)
  expect(clone.gh.pushAs({ type: 'User', login: 'ada' }, `refs/heads/${branch}`, top)).toBe(200)
  const main = await git(clone.bare, 'rev-parse', 'main')
  const exit = await clone.gh.process(MERGE_DOOR.argv, { env: {}, limits: GH_LIMITS })
  const status = parseIncluded(exit.stdout)?.status
  const moved = (await git(clone.bare, 'rev-parse', 'main')) !== main
  expect(moved).toBe(status === 200)
  return status === 200
}

describe('the owner’s decision of 2026-10-01 — the pull request is always opened', () => {
  it('opens the pull request on every shape of rules, and says the note exactly when judgeProtection does not hold', async () => {
    const notes = new Set<string>()
    const kinds = new Set<Missing>()
    for (const shape of RULE_SHAPES) {
      const clone = await githubClone({ model: { accounts: ACCOUNTS } })
      clone.gh.state.repositories = [shape.model(clone.bare)]
      const change = await clearedFor(clone.repo)
      const { forge, api, road } = await githubForge(clone, { wait: async () => {} })
      const base = await forge.base()
      const verdict = (await preflight(api, road, base)).verdict
      expect(refusesPush(verdict), shape.name).toBe(false)
      const outcome = await forge.submit(change, base)

      expect(outcome.outcome, shape.name).toBe('created')
      expect(clone.gh.state.pulls ?? [], shape.name).toHaveLength(1)
      const body = clone.gh.state.pulls?.[0]?.body ?? ''
      const noted = outcome.outcome === 'created' ? outcome.note : undefined
      expect(noted !== undefined, shape.name).toBe(!verdict.holds)
      expect(noted, shape.name).toBe(noteOf(verdict))
      expect(body.split('\n').includes(MERGE_NOTE), shape.name).toBe(noted === 'author-may-merge')
      expect(body.split('\n').some((line) => line.startsWith('note: ')), shape.name).toBe(noted !== undefined)
      if (noted !== undefined) notes.add(noted)
      for (const kind of verdict.missing) kinds.add(kind)
      // The note is true, not only present: the author merges alone exactly where it says so. A deploy
      // key's note is true of the deploy key (merge-refused.test.ts), not of the author.
      if (!shape.deployKey) expect(await mergedAlone(clone, outcome, change.branch), shape.name).toBe(noted === 'author-may-merge')
      await discard(clone)
    }
    // Never vacuous: both notes said, and every kind but item 1's met.
    expect([...notes].sort()).toEqual(['author-may-merge', 'base-unguarded'])
    const noteKinds: readonly Missing[] = [
      'pull-request',
      'approvals',
      'last-push',
      'non-fast-forward',
      'deletion',
      'bypassable',
      'deploy-key',
      'classic-only',
    ]
    expect([...kinds].sort()).toEqual([...noteKinds].sort())
    for (const kind of noteKinds) expect(consequenceOf(kind)).not.toBe('refused')
  }, 300_000)

  it('refuses the push itself on every item-1 kind, and writes nothing on either side', async () => {
    const itemOne: Record<string, (bare: string) => FakeRepository> = {
      archived: (bare) => protectedMain({ bare, archived: true }),
      'no-push': (bare) => protectedMain({ bare, permissions: { ada: { admin: false, maintain: false, push: false } } }),
      renamed: (bare) => protectedMain({ bare, fullName: 'acme/renamed' }),
    }
    for (const [kind, model] of Object.entries(itemOne)) {
      const clone = await githubClone()
      clone.gh.state.repositories = [model(clone.bare)]
      const before = { repo: await observable(clone.repo), refs: await remoteRefs(clone.bare) }
      const { forge, api, road, identity } = await githubForge(clone, { wait: async () => {} })
      const base = await forge.base()
      const { verdict } = await preflight(api, road, base)
      expect(verdict.missing, kind).toEqual([kind])
      expect(refusesPush(verdict), kind).toBe(true)
      expect(noteOf(verdict), kind).toBeUndefined()

      // As every road runs it, before the preview: refused, exit 1, nothing said on stderr.
      const said: string[] = []
      const refused = await refuseUnprotected(
        { root: clone.repo, forge, base, road, github: { identity, api } },
        { notice: (line) => said.push(line) },
      )
      expect(refused, kind).toMatchObject({ found: false })
      expect(refused?.text.split('\n')[0], kind).toBe('not submitted — github.com/acme/iac cannot take a pull request from this run:')
      expect(said, kind).toEqual([])
      expect(await observable(clone.repo), kind).toBe(before.repo)
      expect(await remoteRefs(clone.bare), kind).toBe(before.refs)
      expect(clone.gh.state.pulls ?? [], kind).toEqual([])
      await discard(clone)
    }
  })
})
