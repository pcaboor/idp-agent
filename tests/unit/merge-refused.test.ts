import { afterAll, describe, expect, it } from 'vitest'
import { MERGE_NOTE, noteOf } from '../../src/core/github/protection.js'
import { preflight } from '../../src/forge/github/preflight.js'
import { GH_LIMITS, parseIncluded, type GhExit } from '../../src/process/gh.js'
import { clearedFor, removeClones } from '../support/forge-fixture.js'
import { DOORS, MERGE_DOOR, MODELLED_DOORS, protectedMain, protectingRuleset, repository, type FakeGitHub } from '../support/fake-gh.js'
import { githubClone, githubForge, type GitHubClone } from '../support/github-fixture.js'
import { git } from '../support/git.js'
import { REFUSED_EXIT, type FakeRepository } from '../../tools/fake-gh.js'

/**
 * Design §9.4's first test, in the owner's words (stage 6 brief § 10): the
 * identity that opens a pull request cannot merge it until someone else has
 * approved the exact commit that would merge. Against the fake's model, never
 * through the launcher, which refuses every door before a process starts
 * (tests/unit/launcher-doors.test.ts): here each door is tried as gh would
 * send it, as the account that opened the pull request. The doors come from
 * `tests/support/fake-gh.ts`; this file names none.
 *
 * These prove the fake, not GitHub: the owner's live test (6.4.1) tries the
 * same doors there, and its recorded answers hold the fake to them. Of the
 * doors, the fake's model judges a merge, an approval and a write to a base
 * (`MODELLED_DOORS`); every other is refused as a vector idp-agent never
 * sends, and is asserted as exactly that, never counted as GitHub refusing it.
 */

afterAll(removeClones)

/** `ada` opened it; `grace` and `linus` may review it. */
const ACCOUNTS = [
  { login: 'ada', type: 'User' as const },
  { login: 'grace', type: 'User' as const },
  { login: 'linus', type: 'User' as const },
]
const GRACE = { admin: false, maintain: false, push: true }

/**
 * How the fake answered a door: a door its model judges is refused as GitHub
 * would refuse it — a 4xx through `gh api`, or `gh pr`'s own failure — and
 * any other is refused as a vector idp-agent never sends (`REFUSED_EXIT`),
 * which proves nothing of GitHub: 6.4.1's live test tries those there.
 */
const answered = (door: (typeof DOORS)[number], exit: GhExit): string => {
  if (!MODELLED_DOORS.has(door.name)) return exit.code === REFUSED_EXIT ? 'not modelled' : `exit ${String(exit.code)}`
  if (door.argv[0] === 'api') {
    const status = parseIncluded(exit.stdout)?.status ?? 0
    return status >= 400 && status < 500 ? 'refused by the model' : `status ${String(status)}`
  }
  return exit.code === 1 && /was not (merged|approved)/.test(exit.stderr) ? 'refused by the model' : `exit ${String(exit.code)}`
}

const tryDoor = (gh: FakeGitHub, door: (typeof DOORS)[number]): Promise<GhExit> =>
  gh.process(door.argv, {
    ...(door.stdin === undefined ? {} : { stdin: Buffer.from(door.stdin) }),
    env: {},
    limits: GH_LIMITS,
  })

/** A clone whose GitHub is `change` of `protectedMain`, with `grace` beside `ada`. */
const withModel = async (change: (bare: string) => FakeRepository): Promise<GitHubClone> => {
  const clone = await githubClone({ model: { accounts: ACCOUNTS } })
  clone.gh.state.repositories = [change(clone.bare)]
  return clone
}

/** Pull request #1, opened by the forge as `ada`: its head. */
const opened = async (clone: GitHubClone) => {
  const change = await clearedFor(clone.repo)
  const { forge, api, road } = await githubForge(clone)
  const base = await forge.base()
  const result = await forge.submit(change, base)
  if (result.outcome !== 'created') throw new Error(result.outcome)
  return { change, api, road, base, head: result.commit }
}

/** A commit on top of `head`, its objects on GitHub's side under a ref of the test's own. */
const onTop = async (clone: GitHubClone, head: string): Promise<string> => {
  const commit = await git(clone.repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'pushed on top of the approved head')
  await git(clone.repo, 'push', '-q', clone.bare, `${commit}:refs/test/on-top`)
  return commit
}

// Real git processes and a bare repository per test: under 2 s alone, past
// vitest's 5 s default beside the rest of the suite (github-forge.test.ts).
describe('the identity that opened the pull request cannot merge it', { timeout: 30_000 }, () => {
  it('refuses every door to the identity that opened the pull request, and leaves it open and main where it was', async () => {
    const clone = await withModel((bare) =>
      protectedMain({ bare, permissions: { ada: { admin: true, maintain: false, push: true }, grace: GRACE } }),
    )
    await opened(clone)
    const main = await git(clone.bare, 'rev-parse', 'main')

    for (const door of DOORS) {
      const exit = await tryDoor(clone.gh, door)
      expect(answered(door, exit), door.name).toBe(MODELLED_DOORS.has(door.name) ? 'refused by the model' : 'not modelled')
      expect(clone.gh.state.pulls?.[0]?.state, door.name).toBe('open')
      expect(await git(clone.bare, 'rev-parse', 'main'), door.name).toBe(main)
    }
  })

  it("refuses the author's merge after a push on top of an approved head, and lets it through once someone else approves the new head", async () => {
    const clone = await withModel((bare) => protectedMain({ bare, permissions: { ada: GRACE, grace: GRACE } }))
    const { change, head } = await opened(clone)
    const main = await git(clone.bare, 'rev-parse', 'main')

    clone.gh.approve(1, 'grace')
    const top = await onTop(clone, head)
    expect(clone.gh.pushAs({ type: 'User', login: 'ada' }, `refs/heads/${change.branch}`, top)).toBe(200)

    const once = await tryDoor(clone.gh, MERGE_DOOR)
    expect(parseIncluded(once.stdout)?.status).toBe(405)
    expect(await git(clone.bare, 'rev-parse', 'main')).toBe(main)

    // The limit of § 5, pinned rather than hidden: an approval of the new head
    // by someone else is all the author then needs.
    clone.gh.approve(1, 'grace')
    const twice = await tryDoor(clone.gh, MERGE_DOOR)
    expect(parseIncluded(twice.stdout)?.status).toBe(200)
    const merged = await git(clone.bare, 'rev-parse', 'main')
    expect(merged).not.toBe(main)
    expect(await git(clone.bare, 'rev-parse', `${merged}^{tree}`)).toBe(await git(clone.bare, 'rev-parse', `${top}^{tree}`))
    expect(await git(clone.bare, 'merge-base', '--is-ancestor', top, merged).then(() => true)).toBe(true)
    expect(clone.gh.state.pulls?.[0]?.state).toBe('closed')
  })

  it("counts neither the author's own approval nor the last pusher's", async () => {
    const clone = await withModel((bare) => protectedMain({ bare, permissions: { ada: GRACE, grace: GRACE, linus: GRACE } }))
    const { change, head } = await opened(clone)
    const main = await git(clone.bare, 'rev-parse', 'main')
    const status = async (): Promise<number | undefined> => parseIncluded((await tryDoor(clone.gh, MERGE_DOOR)).stdout)?.status

    // grace pushes on top of the head, then approves it: the last push's approval must be someone else's.
    const top = await onTop(clone, head)
    expect(clone.gh.pushAs({ type: 'User', login: 'grace' }, `refs/heads/${change.branch}`, top)).toBe(200)
    clone.gh.approve(1, 'grace')
    expect(await status()).toBe(405)

    // A review by ada of the head, which GitHub refuses to record (422), put in
    // the model all the same: an author's approval never counts.
    const pull = clone.gh.state.pulls?.[0]
    if (pull === undefined) throw new Error('no pull request #1')
    pull.reviews.push({ login: 'ada', commit: top })
    expect(await status()).toBe(405)
    expect(await git(clone.bare, 'rev-parse', 'main')).toBe(main)

    // Someone who neither opened nor pushed it approves the head: the merge goes through.
    clone.gh.approve(1, 'linus')
    expect(await status()).toBe(200)
    expect(await git(clone.bare, 'rev-parse', 'main')).not.toBe(main)
  })

  it('opens the pull request with the note wherever the rules let its author merge it alone, and the author can merge it', async () => {
    // In each, the forge opens the pull request with the owner's note (the
    // decision of 2026-10-01), grace approves the head, the author pushes on
    // top of it, and the author merges a commit nobody else approved: the note
    // was true. The protected base of the test above refuses exactly that.
    const weak: Record<string, readonly [(bare: string) => FakeRepository, (missing: readonly string[]) => void]> = {
      'no ruleset': [
        (bare) => repository({ bare, permissions: { ada: GRACE, grace: GRACE } }),
        (missing) => expect(missing).toContain('pull-request'),
      ],
      'the push rule unset': [
        (bare) =>
          protectedMain({
            bare,
            permissions: { ada: { admin: true, maintain: false, push: true }, grace: GRACE },
            rulesets: [
              protectingRuleset(1, {
                rules: [
                  {
                    type: 'pull_request',
                    parameters: {
                      required_approving_review_count: 1,
                      require_last_push_approval: false,
                      dismiss_stale_reviews_on_push: false,
                    },
                  },
                  { type: 'non_fast_forward' },
                  { type: 'deletion' },
                ],
              }),
            ],
          }),
        (missing) => expect(missing).toEqual(['last-push']),
      ],
      'the author in the bypass list': [
        (bare) =>
          protectedMain({
            bare,
            permissions: { ada: { admin: true, maintain: false, push: true }, grace: GRACE },
            rulesets: [protectingRuleset(1, { bypass: [{ actor_type: 'User', actor_id: 1000, bypass_mode: 'always' }] })],
          }),
        (missing) => expect(missing).toContain('bypassable'),
      ],
      'classic protection only': [
        (bare) =>
          repository({
            bare,
            permissions: { ada: { admin: true, maintain: false, push: true }, grace: GRACE },
            branches: { main: { protected: true } },
          }),
        (missing) => expect(missing).toEqual(['classic-only']),
      ],
    }
    for (const [name, [model, says]] of Object.entries(weak)) {
      const clone = await withModel(model)
      const change = await clearedFor(clone.repo)
      const { forge, api, road } = await githubForge(clone)
      const base = await forge.base()

      // The preflight says what is missing, and that the note is the owner's.
      const { verdict } = await preflight(api, road, base)
      expect(verdict.holds, name).toBe(false)
      says(verdict.missing)
      expect(noteOf(verdict), name).toBe('author-may-merge')

      // The forge itself opens the pull request, as the author, with the note.
      const result = await forge.submit(change, base)
      expect(result, name).toMatchObject({ outcome: 'created', note: 'author-may-merge', pullRequest: { number: 1 } })
      if (result.outcome !== 'created') throw new Error(result.outcome)
      expect(clone.gh.state.pulls?.[0]?.body.split('\n'), name).toContain(MERGE_NOTE)
      clone.gh.approve(1, 'grace')
      const top = await onTop(clone, result.commit)
      expect(clone.gh.pushAs({ type: 'User', login: 'ada' }, `refs/heads/${change.branch}`, top), name).toBe(200)
      const main = await git(clone.bare, 'rev-parse', 'main')

      const exit = await tryDoor(clone.gh, MERGE_DOOR)

      expect(parseIncluded(exit.stdout)?.status, name).toBe(200)
      expect(await git(clone.bare, 'rev-parse', 'main'), name).not.toBe(main)
    }
  })

  it('notes a deploy key it can see in the bypass list, and opens the pull request', async () => {
    const deployKey = { actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' as const }
    const visible = await withModel((bare) =>
      protectedMain({ bare, permissions: { ada: { admin: true, maintain: false, push: true }, grace: GRACE }, rulesets: [protectingRuleset(1, { bypass: [deployKey] })] }),
    )
    const { forge, api, road } = await githubForge(visible)
    const base = await forge.base()
    const { verdict: shown } = await preflight(api, road, base)
    expect(shown.missing).toEqual(['deploy-key'])
    expect(noteOf(shown)).toBe('author-may-merge')
    const result = await forge.submit(await clearedFor(visible.repo), base)
    expect(result).toMatchObject({ outcome: 'created', note: 'author-may-merge', pullRequest: { number: 1 } })
    expect(visible.gh.state.pulls?.[0]?.body.split('\n')).toContain(MERGE_NOTE)

    // The note is true of the deploy key: a fast-forward of main nobody reviewed.
    const main = await git(visible.bare, 'rev-parse', 'main')
    const top = await onTop(visible, main)
    expect(visible.gh.pushAs({ type: 'DeployKey', id: 7 }, 'refs/heads/main', top)).toBe(200)
    expect(await git(visible.bare, 'rev-parse', 'main')).toBe(top)

    // The same list, hidden from an account that may not edit the ruleset: it holds, and notes nothing.
    const hidden = await withModel((bare) =>
      protectedMain({ bare, permissions: { ada: GRACE, grace: GRACE }, rulesets: [protectingRuleset(1, { bypass: [deployKey] })] }),
    )
    const seen = await githubForge(hidden)
    const { verdict } = await preflight(seen.api, seen.road, await seen.forge.base())
    expect(verdict.holds).toBe(true)
    expect(verdict.reported.bypassActors).toBe('unreadable')
    expect(noteOf(verdict)).toBeUndefined()
  })
})
