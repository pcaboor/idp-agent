import { afterAll, describe, expect, it } from 'vitest'
import type { Cleared } from '../../src/core/plan/clear.js'
import { openLocalForge } from '../../src/forge/local/forge.js'
import type { Submitted } from '../../src/forge/provider.js'
import { gitIn, type Git } from '../../src/process/git.js'
import { clearedFor, clone, removeClones } from '../support/forge-fixture.js'
import { git, observable, show } from '../support/git.js'

/**
 * §9.2's atomicity invariant, over real repositories: a submission that fails
 * at any git call — before the call runs, or just after it succeeded — leaves
 * the observable state (every ref, what HEAD is, the index, the working tree)
 * as it found it, or holds the whole branch. Never part of one.
 *
 * Every call, not a sample: the calls of a clean submission are counted first,
 * then each one is made to fail both ways, in a fresh repository. The eee67d6
 * plan drew 24 random (step, side) pairs from twelve mutating steps, which
 * could leave a step untried and never failed a read; a read failing is how a
 * submission would take a wrong turn, not only a write.
 */

type Outcome = Submitted | 'threw'

/** A runner that throws at its k-th call once armed, before the call runs or just after. */
const failingAt = (inner: Git, k: number, late: boolean) => {
  let armed = false
  let seen = 0
  const run: Git = async (args, input) => {
    const counted = armed ? ++seen : -1
    if (counted === k && !late) throw new Error(`injected before git ${args[0] ?? ''}`)
    const out = await inner(args, input)
    if (counted === k && late) throw new Error(`injected after git ${args[0] ?? ''}`)
    return out
  }
  return {
    run,
    arm: () => {
      armed = true
    },
    calls: () => seen,
  }
}

describe('§9.2 — application is atomic', () => {
  // Some fifty real repositories per run: removed at the end, because the
  // temporary directories of a test run fill a small disk (run it targeted).
  afterAll(removeClones)

  /** One submission, failing at call k of `submit` (0: none). */
  const attempt = async (change: Cleared | undefined, k: number, late: boolean) => {
    const repo = await clone()
    // Every clone holds the same bytes, so one clearance serves them all; it
    // names no commit, and each submission re-reads its own base.
    const cleared = change ?? (await clearedFor(repo))
    const before = await observable(repo)
    const runner = failingAt(gitIn(repo), k, late)
    const forge = await openLocalForge(repo, 'declarations', runner.run)
    const base = await forge.base()
    runner.arm()
    const outcome: Outcome = await forge.submit(cleared, base).catch(() => 'threw' as const)
    return { repo, change: cleared, before, after: await observable(repo), outcome, calls: runner.calls() }
  }

  it('a submission failing at any git call leaves the initial state, or the complete branch', async () => {
    const clean = await attempt(undefined, 0, false)
    expect(clean.outcome).toMatchObject({ outcome: 'created' })
    // Non-vacuous: a submission that makes no call proves nothing.
    expect(clean.calls).toBeGreaterThan(10)

    const seen = { initial: 0, whole: 0 }
    for (let k = 1; k <= clean.calls; k++) {
      for (const late of [false, true]) {
        const { repo, change, before, after, outcome } = await attempt(clean.change, k, late)
        const where = `call ${String(k)} failing ${late ? 'after' : 'before'} it ran`

        if (after === before) {
          seen.initial++
          // Nothing moved: a run that says it created or found a branch lies.
          expect(outcome === 'threw' || outcome.outcome === 'refused', where).toBe(true)
          continue
        }
        seen.whole++
        // The one other acceptable state: the ref was created, and it is the
        // only line that moved — nothing else a person sees, and the branch whole.
        const branch = await git(repo, 'rev-parse', '--verify', `refs/heads/${change.branch}`)
        const was = before.split('\n')
        const is = after.split('\n')
        expect(is.filter((line) => !was.includes(line)), where).toEqual([`refs/heads/${change.branch} ${branch}`])
        expect(was.filter((line) => !is.includes(line)), where).toEqual([])
        expect(await git(repo, 'rev-parse', `${branch}^`), where).toBe(await git(repo, 'rev-parse', 'main'))
        for (const edit of change.edits) {
          expect(await show(repo, branch, edit.path), where).toBe(edit.after)
        }
        expect(outcome === 'threw' || outcome.outcome === 'created', where).toBe(true)
      }
    }
    // Both halves were reached: failures before the ref, and after it.
    expect(seen.initial).toBeGreaterThan(0)
    expect(seen.whole).toBeGreaterThan(0)
    // Some fifty real repositories: well past vitest's 5 s default inside the
    // full parallel suite.
  }, 120_000)

  it('a branch a stranger creates at any moment of a submission is never moved, nor claimed', async () => {
    // The race `update-ref`'s empty old value exists for, at every call rather
    // than the one a unit test picks: the stranger's ref appears before call k
    // runs. Whenever it lands — before the forge looks, or between its look and
    // its write — the result is the initial state plus the stranger's line.
    const clean = await attempt(undefined, 0, false)
    let raced = 0
    for (let k = 1; k <= clean.calls; k++) {
      const repo = await clone()
      const before = await observable(repo)
      const stranger = await git(repo, 'rev-parse', 'HEAD')
      const inner = gitIn(repo)
      let armed = false
      let seen = 0
      const racing: Git = async (args, input) => {
        if (armed && ++seen === k) {
          await git(repo, 'update-ref', `refs/heads/${clean.change.branch}`, stranger)
        }
        return inner(args, input)
      }
      const forge = await openLocalForge(repo, 'declarations', racing)
      const base = await forge.base()
      armed = true
      const outcome: Outcome = await forge.submit(clean.change, base).catch(() => 'threw' as const)
      const where = `a stranger's ref before call ${String(k)}`

      expect(outcome, where).toMatchObject({ outcome: 'refused' })
      const after = (await observable(repo)).split('\n')
      const was = before.split('\n')
      expect(after.filter((line) => !was.includes(line)), where).toEqual([
        `refs/heads/${clean.change.branch} ${stranger}`,
      ])
      expect(was.filter((line) => !after.includes(line)), where).toEqual([])
      raced++
    }
    expect(raced).toBe(clean.calls)
  }, 120_000)
})
