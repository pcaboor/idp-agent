import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Cleared } from '../../src/core/plan/clear.js'
import type { Submitted } from '../../src/forge/provider.js'
import type { GhProcess } from '../../src/process/gh.js'
import { gitIn, pushIn, type Git, type Push } from '../../src/process/git.js'
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
