import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { LONGEST_NOTE, MERGE_NOTE } from '../../src/core/github/protection.js'
import { pullRequestBody } from '../../src/core/github/pull-request.js'
import type { Cleared } from '../../src/core/plan/clear.js'
import { preflight } from '../../src/forge/github/preflight.js'
import { classifyPushFailure, type PushFailure } from '../../src/forge/github/push.js'
import { openLocalForge } from '../../src/forge/local/forge.js'
import type { Submitted } from '../../src/forge/provider.js'
import { GitError, gitIn, pushIn, type Git, type Push } from '../../src/process/git.js'
import { clearedFor, removeClones, scratch } from '../support/forge-fixture.js'
import { protectingRuleset } from '../support/fake-gh.js'
import { fakeSsh, githubClone, githubForge, remoteRefs, unprotect, type GitHubClone } from '../support/github-fixture.js'
import { git, observable } from '../support/git.js'

/**
 * The GitHub forge (stage 6 brief § 3 steps 6 and 8 to 12, § 4, § 14), over a
 * committed clone whose `main` tracks `git@github.com:acme/iac.git`, a bare
 * repository on disk standing for GitHub's side of it, a fake ssh that
 * serves that bare repository, and the fake gh reading its refs. The push is
 * the person's real `git push`, with the real lease; nothing leaves the
 * machine and no real gh or ssh starts (`tests/setup/forge.ts`).
 *
 * "Nothing written" is always three facts: the clone as a person sees it,
 * the bare repository's refs, and the fake's pull requests.
 */

afterAll(removeClones)

/**
 * A seam into `GITHUB_LIMITS.bodyBytes`: the real 1 MiB unless a case of
 * *the body's bound* sets another, read each time the forge reads it. A body
 * of 1 MiB would take a clearance of thousands of files to build.
 */
const bound = vi.hoisted(() => ({ bodyBytes: undefined as number | undefined }))
vi.mock('../../src/forge/github/limits.js', async (original) => {
  const real = await original<typeof import('../../src/forge/github/limits.js')>()
  return {
    ...real,
    GITHUB_LIMITS: {
      ...real.GITHUB_LIMITS,
      get bodyBytes(): number {
        return bound.bodyBytes ?? real.GITHUB_LIMITS.bodyBytes
      },
    },
  }
})
afterEach(() => {
  bound.bodyBytes = undefined
})

const WHERE = 'github.com/acme/iac'

/** What a person, GitHub's refs and the fake's pull requests show, together. */
const state = async (clone: GitHubClone): Promise<string> =>
  [await observable(clone.repo), await remoteRefs(clone.bare), JSON.stringify(clone.gh.state.pulls ?? [])].join('\n--\n')

/** One clone, its clearance, and the forge over them. */
const setUp = async (options: Parameters<typeof githubForge>[1] = {}, clone?: GitHubClone) => {
  const made = clone ?? (await githubClone())
  const change = await clearedFor(made.repo)
  const opened = await githubForge(made, options)
  return { clone: made, change, ...opened, base: await opened.forge.base() }
}

/** The commit a branch is at on GitHub's side, or undefined. */
const onGitHub = async (clone: GitHubClone, branch: string): Promise<string | undefined> =>
  git(clone.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => undefined)

/** Our commit, cut by the local forge alone, as stage 5 cuts it. */
const cutLocally = async (clone: GitHubClone, change: Cleared): Promise<string> => {
  const local = await openLocalForge(clone.repo, 'declarations')
  const cut = await local.submit(change, await local.base())
  if (cut.outcome !== 'created') throw new Error(cut.outcome)
  return cut.commit
}

/** A commit placed on GitHub's side by the test's own git. */
const place = async (clone: GitHubClone, commit: string, branch: string): Promise<void> => {
  await git(clone.repo, 'push', '-q', clone.bare, `${commit}:refs/heads/${branch}`)
}

/** One unrelated commit on `main`, here and on GitHub: the base moves on both sides, level. Returns the old `main`. */
const advance = async (clone: GitHubClone): Promise<string> => {
  const old = await git(clone.repo, 'rev-parse', 'main')
  await writeFile(path.join(clone.repo, 'README.md'), `# merged since, ${String(Math.random())}\n`)
  await git(clone.repo, 'add', '-A')
  await git(clone.repo, 'commit', '-q', '-m', 'merged since')
  await place(clone, await git(clone.repo, 'rev-parse', 'main'), 'main')
  return old
}

/** A whole submission through `forge`, which must open pull request `number`. */
const submitted = async (forge: Awaited<ReturnType<typeof setUp>>, number = 1): Promise<Submitted> => {
  const result = await forge.forge.submit(forge.change, forge.base)
  expect(result).toMatchObject({ outcome: 'created', pullRequest: { number } })
  return result
}

const pull = (clone: GitHubClone, number: number) => {
  const found = (clone.gh.state.pulls ?? []).find((one) => one.number === number)
  if (found === undefined) throw new Error(`no pull request #${String(number)}`)
  return found
}

/** The one pull request's body holds the owner's note on a line of its own, above the provisioning sentence. */
const noted = (clone: GitHubClone): void => {
  expect(clone.gh.state.pulls ?? []).toHaveLength(1)
  const lines = pull(clone, 1).body.split('\n')
  const at = lines.indexOf(MERGE_NOTE)
  expect(at).toBeGreaterThan(-1)
  expect(lines.indexOf('Nothing is provisioned yet. The merge is what authorises it.')).toBeGreaterThan(at)
}

/** GitHub's refs moved by the one branch, added, and nothing else. */
const movedByTheBranch = (clone: GitHubClone, before: string, after: string, branch: string): void => {
  const added = after.split('\n').filter((line) => !before.split('\n').includes(line))
  expect(added).toHaveLength(1)
  expect(added[0]).toContain(`refs/heads/${branch}`)
  expect(before.split('\n').every((line) => after.split('\n').includes(line))).toBe(true)
  expect(clone.gh.state.pulls ?? []).toHaveLength(1)
}

// Real git processes, a push and a bare repository per test: seconds alone,
// past vitest's 5 s default beside the rest of the suite.
describe('recognition, one test per row of § 14', { timeout: 30_000 }, () => {
  it('finds nothing to recognise when neither side holds the branch', async () => {
    const opened = await setUp()
    const before = await state(opened.clone)
    const calls = opened.api.calls()

    expect(await opened.forge.recognise(opened.change, opened.base)).toBeUndefined()

    // The ref and the pull requests; no commit read.
    expect(opened.api.calls() - calls).toBe(2)
    expect(await state(opened.clone)).toBe(before)
  })

  it('submits: the local branch, the same commit on GitHub, and one pull request into main', async () => {
    const opened = await setUp()
    const main = await git(opened.clone.repo, 'rev-parse', 'main')
    expect(await opened.forge.recognise(opened.change, opened.base)).toBeUndefined()

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toEqual({
      outcome: 'created',
      branch: opened.change.branch,
      commit: await git(opened.clone.repo, 'rev-parse', `refs/heads/${opened.change.branch}`),
      pushed: true,
      pullRequest: {
        host: 'github.com',
        repository: 'acme/iac',
        number: 1,
        url: 'https://github.com/acme/iac/pull/1',
        state: 'opened',
        base: 'main',
      },
      statusChecks: [],
    })
    expect(await onGitHub(opened.clone, opened.change.branch)).toBe(
      await git(opened.clone.repo, 'rev-parse', `refs/heads/${opened.change.branch}`),
    )
    expect(await git(opened.clone.repo, 'rev-parse', 'main')).toBe(main)
    expect(await onGitHub(opened.clone, 'main')).toBe(main)
    const opens = pull(opened.clone, 1)
    expect(opens).toMatchObject({ head: opened.change.branch, base: 'main', draft: false, author: 'ada', state: 'open' })
    expect(opens.body).toBe(
      pullRequestBody({
        message: opened.change.message,
        request: opened.change.request,
        road: 'from',
        branch: opened.change.branch,
      }).body,
    )
    expect(opened.clone.gh.state.pulls).toHaveLength(1)
  })

  it('pushes a local branch a stage-5 run cut, and opens its pull request', async () => {
    const clone = await githubClone()
    const change = await clearedFor(clone.repo)
    const commit = await cutLocally(clone, change)
    const opened = await setUp({}, clone)

    expect(await opened.forge.recognise(change, opened.base)).toBeUndefined()
    const result = await opened.forge.submit(change, opened.base)

    expect(result).toMatchObject({ outcome: 'created', commit, pushed: true, pullRequest: { number: 1 } })
    expect(await git(clone.repo, 'rev-parse', `refs/heads/${change.branch}`)).toBe(commit)
    expect(await onGitHub(clone, change.branch)).toBe(commit)
  })

  it('opens the pull request of a branch an earlier run pushed, and writes nothing else', async () => {
    const clone = await githubClone()
    const change = await clearedFor(clone.repo)
    const commit = await cutLocally(clone, change)
    await place(clone, commit, change.branch)
    await git(clone.repo, 'update-ref', '-d', `refs/heads/${change.branch}`)
    const opened = await setUp({}, clone)
    const refs = await remoteRefs(clone.bare)
    const seen = await observable(clone.repo)

    expect(await opened.forge.recognise(change, opened.base)).toEqual({
      outcome: 'pushed-without-pull-request',
      branch: change.branch,
      commit,
      reason: 'the branch was pushed by an earlier run; opening its pull request',
    })
    expect(await opened.forge.submit(change, opened.base)).toMatchObject({
      outcome: 'created',
      commit,
      pushed: false,
      pullRequest: { number: 1, state: 'opened' },
    })
    expect(await observable(clone.repo)).toBe(seen)
    expect(await remoteRefs(clone.bare)).toBe(refs)
  })

  it('names the pull request already open, and writes nothing', async () => {
    const first = await setUp()
    const made = await submitted(first)
    const again = await setUp({}, first.clone)
    const before = await state(first.clone)

    expect(await again.forge.recognise(again.change, again.base)).toEqual({
      outcome: 'already-submitted',
      branch: again.change.branch,
      commit: made.outcome === 'created' ? made.commit : '',
      pushed: false,
      pullRequest: {
        host: 'github.com',
        repository: 'acme/iac',
        number: 1,
        url: 'https://github.com/acme/iac/pull/1',
        state: 'open',
        base: 'main',
      },
    })
    // At the moment of acting too: named, and no second POST.
    expect(await again.forge.submit(again.change, again.base)).toMatchObject({
      outcome: 'already-submitted',
      pullRequest: { number: 1, state: 'open' },
    })
    expect(await state(first.clone)).toBe(before)
  })

  it('names the pull request open on an older base', async () => {
    const first = await setUp()
    await submitted(first)
    const old = await advance(first.clone)
    const again = await setUp({}, first.clone)
    const before = await state(first.clone)

    expect(await again.forge.recognise(again.change, again.base)).toMatchObject({
      outcome: 'already-submitted',
      olderBase: old,
      pullRequest: { number: 1, state: 'open' },
    })
    expect(await state(first.clone)).toBe(before)
  })

  it('opens the pull request of a branch pushed on an older base', async () => {
    const first = await setUp()
    first.clone.gh.fault({ route: 'open-pull-request', status: 502, times: 1 })
    expect(await first.forge.submit(first.change, first.base)).toMatchObject({ outcome: 'pushed-without-pull-request' })
    const old = await advance(first.clone)
    const again = await setUp({}, first.clone)

    expect(await again.forge.recognise(again.change, again.base)).toMatchObject({ outcome: 'pushed-without-pull-request' })
    expect(await again.forge.submit(again.change, again.base)).toMatchObject({
      outcome: 'created',
      pushed: false,
      olderBase: old,
      pullRequest: { number: 1, state: 'opened' },
    })
  })

  it('refuses a local branch on an older base that GitHub never received', async () => {
    const clone = await githubClone()
    const change = await clearedFor(clone.repo)
    await cutLocally(clone, change)
    const old = await advance(clone)
    const opened = await setUp({}, clone)
    const before = await state(clone)
    const reason =
      `${change.branch} is in this clone on main@${old.slice(0, 7)}, an older main, and was never opened for review; ` +
      `delete it (git branch -D ${change.branch}) and run this again`

    expect(await opened.forge.recognise(change, opened.base)).toEqual({ outcome: 'refused', reason })
    expect(await opened.forge.submit(change, opened.base)).toEqual({ outcome: 'refused', reason })
    expect(await state(clone)).toBe(before)
  })

  it('refuses a closed pull request, never reopening it', async () => {
    const first = await setUp()
    await submitted(first)
    Object.assign(pull(first.clone, 1), { state: 'closed', closed_at: '2026-10-02T09:30:00Z' })
    const again = await setUp({}, first.clone)
    const closed = { outcome: 'closed', branch: again.change.branch, number: 1, merged: false, at: '2026-10-02' }

    // The branch still on GitHub, then deleted there: closed either way, and
    // closed again at the moment of acting — the pull request closed while
    // the person was confirming is not opened a second time.
    for (const deleted of [false, true]) {
      if (deleted) await git(first.clone.bare, 'update-ref', '-d', `refs/heads/${again.change.branch}`)
      const before = await state(first.clone)
      expect(await again.forge.recognise(again.change, again.base), String(deleted)).toEqual(closed)
      expect(await again.forge.submit(again.change, again.base), String(deleted)).toEqual(closed)
      expect(await state(first.clone), String(deleted)).toBe(before)
    }
    expect(pull(first.clone, 1).state).toBe('closed')
  })

  it("refuses a merged pull request whose change the base no longer carries", async () => {
    const first = await setUp()
    await submitted(first)
    Object.assign(pull(first.clone, 1), {
      state: 'closed',
      closed_at: '2026-10-03T09:30:00Z',
      merged_at: '2026-10-03T09:30:00Z',
    })
    const again = await setUp({}, first.clone)
    const merged = { outcome: 'closed', branch: again.change.branch, number: 1, merged: true, at: '2026-10-03' }
    const before = await state(first.clone)

    expect(await again.forge.recognise(again.change, again.base)).toEqual(merged)
    expect(await again.forge.submit(again.change, again.base)).toEqual(merged)
    expect(await state(first.clone)).toBe(before)
  })

  it('refuses an open pull request into another base, naming it', async () => {
    const first = await setUp()
    await submitted(first)
    Object.assign(pull(first.clone, 1), { base: 'release' })
    const again = await setUp({}, first.clone)

    const before = await state(first.clone)
    const known = await again.forge.recognise(again.change, again.base)
    expect(known).toMatchObject({ outcome: 'refused' })
    expect(known?.outcome === 'refused' ? known.reason : '').toContain('release')
    expect(await again.forge.submit(again.change, again.base)).toEqual(known)
    expect(await state(first.clone)).toBe(before)
  })

  it('refuses an open pull request whose branch GitHub does not hold, claiming nothing of it', async () => {
    const first = await setUp()
    await submitted(first)
    await git(first.clone.bare, 'update-ref', '-d', `refs/heads/${first.change.branch}`)
    const again = await setUp({}, first.clone)
    const before = await state(first.clone)
    const refused = {
      outcome: 'refused',
      reason: `pull request #1 on ${WHERE} is open from ${again.change.branch}, which GitHub does not hold; it is not this submission`,
    }

    expect(await again.forge.recognise(again.change, again.base)).toEqual(refused)
    expect(await again.forge.submit(again.change, again.base)).toEqual(refused)
    expect(await state(first.clone)).toBe(before)
  })

  it('refuses a branch on GitHub that is not ours, whatever it holds', async () => {
    // One commit, whose parent is the base or an ancestor of it (§ 14): a merge
    // whose first parent is the base is not one.
    const strangers: Record<string, (clone: GitHubClone, change: Cleared, ours: string) => Promise<string>> = {
      'on another parent': async (clone, change, ours) => {
        const side = await git(clone.repo, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'a side change')
        return git(clone.repo, 'commit-tree', `${ours}^{tree}`, '-p', side, '-m', change.message)
      },
      'with one more file': async (clone, change, ours) => {
        await git(clone.repo, 'checkout', '-q', '--detach', ours)
        await writeFile(path.join(clone.repo, 'catalog', 'databases', 'more.yml'), 'one: more\n')
        await git(clone.repo, 'add', '-A')
        await git(clone.repo, 'commit', '-q', '--amend', '--cleanup=verbatim', '-m', change.message)
        const made = await git(clone.repo, 'rev-parse', 'HEAD')
        await git(clone.repo, 'checkout', '-q', 'main')
        return made
      },
      'with our bytes as executables': async (clone, change, ours) => {
        await git(clone.repo, 'checkout', '-q', '--detach', ours)
        for (const edit of change.edits) await git(clone.repo, 'update-index', '--chmod=+x', edit.path)
        await git(clone.repo, 'commit', '-q', '--amend', '--cleanup=verbatim', '-m', change.message)
        const made = await git(clone.repo, 'rev-parse', 'HEAD')
        // The index says executable and the files on disk do not: set aside.
        await git(clone.repo, 'checkout', '-q', '-f', 'main')
        return made
      },
      'with two parents, the first the base': async (clone, change, ours) => {
        const side = await git(clone.repo, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'a side change')
        return git(clone.repo, 'commit-tree', `${ours}^{tree}`, '-p', 'main', '-p', side, '-m', change.message)
      },
      'under another message': async (clone, _change, ours) =>
        git(clone.repo, 'commit-tree', `${ours}^{tree}`, '-p', 'main', '-m', 'somebody else wrote this'),
    }
    for (const [name, make] of Object.entries(strangers)) {
      const clone = await githubClone()
      const change = await clearedFor(clone.repo)
      const ours = await cutLocally(clone, change)
      await git(clone.repo, 'update-ref', '-d', `refs/heads/${change.branch}`)
      await place(clone, await make(clone, change, ours), change.branch)
      const opened = await setUp({}, clone)
      const before = await state(clone)
      const refused = { outcome: 'refused', reason: `${change.branch} exists on ${WHERE} and carries a different change` }

      expect(await opened.forge.recognise(change, opened.base), name).toEqual(refused)
      expect(await opened.forge.submit(change, opened.base), name).toEqual(refused)
      expect(await state(clone), name).toBe(before)
    }
  })

  it('refuses a local branch that is not ours before reading anything on GitHub', async () => {
    const opened = await setUp()
    await git(opened.clone.repo, 'update-ref', `refs/heads/${opened.change.branch}`, 'main')
    const sent = opened.clone.gh.sent.length

    expect(await opened.forge.recognise(opened.change, opened.base)).toEqual({
      outcome: 'refused',
      reason: `${opened.change.branch} already exists and carries a different change`,
    })
    expect(opened.clone.gh.sent).toHaveLength(sent)
  })
})

describe('the moment of acting', { timeout: 30_000 }, () => {
  it('reads the rules again at the moment of acting, and a ruleset dropped after the confirmation opens the pull request with the note in its body', async () => {
    const opened = await setUp()
    expect(await opened.forge.recognise(opened.change, opened.base)).toBeUndefined()
    unprotect(opened.clone.gh)
    const main = await git(opened.clone.repo, 'rev-parse', 'main')
    const refs = await remoteRefs(opened.clone.bare)

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toMatchObject({ outcome: 'created', note: 'author-may-merge', pullRequest: { number: 1 } })
    noted(opened.clone)
    movedByTheBranch(opened.clone, refs, await remoteRefs(opened.clone.bare), opened.change.branch)
    expect(await git(opened.clone.repo, 'rev-parse', 'main')).toBe(main)
    expect(await git(opened.clone.repo, 'rev-parse', `refs/heads/${opened.change.branch}`)).toBe(
      await onGitHub(opened.clone, opened.change.branch),
    )
  })

  it('re-checks the base: main moved on GitHub after the confirmation', async () => {
    const opened = await setUp()
    const moved = await git(opened.clone.repo, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'merged on GitHub')
    await place(opened.clone, moved, 'main')
    const before = await state(opened.clone)

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toMatchObject({ outcome: 'refused' })
    expect(result.outcome === 'refused' ? result.reason : '').toContain('bring them level')
    expect(await state(opened.clone)).toBe(before)
  })

  it("re-checks the clone's configuration at the moment of acting", async () => {
    const opened = await setUp()
    await git(opened.clone.repo, 'config', '--local', 'credential.helper', 'hostile-value-0123')
    const before = await state(opened.clone)

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toMatchObject({ outcome: 'refused' })
    const reason = result.outcome === 'refused' ? result.reason : ''
    expect(reason).toContain('credential.helper')
    expect(reason).toContain('(local)')
    expect(reason).not.toContain('hostile-value-0123')
    expect(await state(opened.clone)).toBe(before)
  })

  it("re-checks the road: an upstream or a push URL changed after the confirmation", async () => {
    const moved: Record<string, readonly [readonly string[], string]> = {
      // Another base: the road reads, and is not the one the forge was opened on.
      'the upstream': [
        ['branch.main.merge', 'refs/heads/release'],
        `main's upstream changed during the run: it no longer names ${WHERE}'s main; run this again. Nothing was written.`,
      ],
      // Another repository to push to: the road itself is refused.
      'the push URL': [['remote.origin.pushurl', 'git@github.com:acme/other.git'], 'github.com/acme/other'],
    }
    for (const [name, [[key, value], says]] of Object.entries(moved)) {
      const opened = await setUp()
      await git(opened.clone.repo, 'config', '--local', key ?? '', value ?? '')
      const before = await state(opened.clone)

      const result = await opened.forge.submit(opened.change, opened.base)

      expect(result, name).toMatchObject({ outcome: 'refused' })
      expect(result, name).not.toHaveProperty('kept')
      expect(result.outcome === 'refused' ? result.reason : '', name).toContain(says)
      expect(await state(opened.clone), name).toBe(before)
    }
  })

  it('refuses a base GitHub does not show', async () => {
    const opened = await setUp()
    await git(opened.clone.bare, 'update-ref', '-d', 'refs/heads/main')
    const before = await state(opened.clone)

    expect(await opened.forge.submit(opened.change, opened.base)).toEqual({
      outcome: 'refused',
      reason: `${WHERE} shows no branch main to your account; nothing is submitted into it. Nothing was written.`,
    })
    expect(await state(opened.clone)).toBe(before)
  })

  it("pushes to the URL the remote printed, never to the remote's name", async () => {
    const opened = await setUp()
    // Read, never refused: not a key of § 7's list, and a push to a URL never consults it.
    await git(opened.clone.repo, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/elsewhere/*')

    await submitted(opened)

    expect(await onGitHub(opened.clone, opened.change.branch)).toBeDefined()
    expect(await remoteRefs(opened.clone.bare)).not.toContain('elsewhere')
  })
})

describe('the body’s bound', { timeout: 30_000 }, () => {
  /** The body step 11 builds when its read calls for no note. */
  const bareBytes = (change: Cleared): number =>
    Buffer.byteLength(
      pullRequestBody({ message: change.message, request: change.request, road: 'from', branch: change.branch }).body,
      'utf8',
    )

  it('refuses at step 8 a body that fits only without room for the longest note, and writes nothing', async () => {
    const opened = await setUp()
    // The body alone fits; with the longest note and its blank line, one byte over.
    bound.bodyBytes = bareBytes(opened.change) + Buffer.byteLength(`${LONGEST_NOTE}\n\n`, 'utf8') - 1
    const before = await state(opened.clone)

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toEqual({
      outcome: 'refused',
      reason: "the pull request's body would be over 1 MiB, more than this build sends. Nothing was written.",
    })
    expect(await state(opened.clone)).toBe(before)
  })

  it('opens a body that fits with room for the longest note', async () => {
    const opened = await setUp()
    bound.bodyBytes = bareBytes(opened.change) + Buffer.byteLength(`${LONGEST_NOTE}\n\n`, 'utf8')

    expect(await opened.forge.submit(opened.change, opened.base)).toMatchObject({ outcome: 'created', pullRequest: { number: 1 } })
  })

  it('checks the body step 11 built once more, and opens nothing over the bound, the branch pushed', async () => {
    const clone = await githubClone()
    const inner = pushIn(clone.repo, { env: clone.env })
    const opened = await setUp(
      {
        // Step 8 passed; the bound moves under the body before step 11, standing
        // for a body step 8 did not foresee.
        push: async (request) => {
          const answer = await inner(request)
          bound.bodyBytes = 1
          return answer
        },
      },
      clone,
    )

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toMatchObject({
      outcome: 'pushed-without-pull-request',
      branch: opened.change.branch,
      reason: "the pull request was not opened: its body would be over 1 MiB, more than this build sends.",
    })
    expect(await onGitHub(clone, opened.change.branch)).toBe(result.outcome === 'pushed-without-pull-request' ? result.commit : '')
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })
})

describe('races and failures', { timeout: 30_000 }, () => {
  it('never moves a branch a stranger pushed between the re-check and the push', async () => {
    const clone = await githubClone()
    const stranger = await git(clone.bare, 'rev-parse', 'main')
    let branch = ''
    const inner = pushIn(clone.repo, { env: clone.env })
    const racing: Push = async (request) => {
      branch = request.branch
      await git(clone.bare, 'update-ref', `refs/heads/${request.branch}`, stranger)
      return inner(request)
    }
    const opened = await setUp({ push: racing }, clone)

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toEqual({
      outcome: 'refused',
      reason: `${opened.change.branch} exists on ${WHERE} and carries a different change`,
      kept: opened.change.branch,
    })
    expect(await onGitHub(clone, branch)).toBe(stranger)
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })

  it('takes as its own a push that landed and whose answer was lost', async () => {
    const clone = await githubClone()
    const inner = pushIn(clone.repo, { env: clone.env })
    const opened = await setUp(
      {
        push: async (request) => {
          await inner(request)
          throw new Error('the answer was lost')
        },
      },
      clone,
    )

    expect(await opened.forge.submit(opened.change, opened.base)).toMatchObject({
      outcome: 'created',
      pushed: false,
      pullRequest: { number: 1 },
    })
    expect(clone.gh.state.pulls).toHaveLength(1)
  })

  it('reads the branch back with its waits when the push lost its answer', async () => {
    const clone = await githubClone()
    const inner = pushIn(clone.repo, { env: clone.env })
    const waited: number[] = []
    const opened = await setUp(
      {
        // The push lands, GitHub's API lags behind it, and git's answer is lost.
        push: async (request) => {
          await inner(request)
          clone.gh.fault({ route: 'ref', status: 404, times: 2 })
          throw new Error('the answer was lost')
        },
        wait: async (ms) => {
          waited.push(ms)
        },
      },
      clone,
    )

    expect(await opened.forge.submit(opened.change, opened.base)).toMatchObject({
      outcome: 'created',
      pushed: false,
      pullRequest: { number: 1 },
    })
    expect(waited).toEqual([500, 1500])
  })

  it("tells a ruleset's refusal from any other, and says nothing of either's words", async () => {
    // A hook on GitHub's side declines the push: the remote refused it, and no
    // ruleset is named.
    const hooked = await githubClone()
    const hook = path.join(hooked.bare, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\necho canary-hook-0123 >&2\nexit 1\n')
    await chmod(hook, 0o755)
    const declined = await setUp({ wait: async () => {} }, hooked)
    const other = await declined.forge.submit(declined.change, declined.base)
    expect(other).toEqual({
      outcome: 'refused',
      reason:
        'the push to github.com failed; `git push` in this clone would say why. ' +
        `${declined.change.branch} was cut in this clone and nothing is on GitHub`,
      kept: declined.change.branch,
    })
    expect(await onGitHub(hooked, declined.change.branch)).toBeUndefined()

    // GitHub's own words for a ruleset, on the porcelain line: the ruleset is named.
    const ruled = await setUp({
      push: async () => ({ flag: 'rejected', summary: '[remote rejected] (push declined due to repository rule violations)' }),
      wait: async () => {},
    })
    expect(await ruled.forge.submit(ruled.change, ruled.base)).toEqual({
      outcome: 'refused',
      reason:
        `a ruleset on ${WHERE} forbids creating idp-agent/… branches. ` +
        `${ruled.change.branch} was cut in this clone and nothing is on GitHub`,
      kept: ruled.change.branch,
    })
  })

  it('reads the branch back before opening anything', async () => {
    for (const times of [2, 3]) {
      const clone = await githubClone()
      const inner = pushIn(clone.repo, { env: clone.env })
      const waited: number[] = []
      const opened = await setUp(
        {
          push: async (request) => {
            const outcome = await inner(request)
            clone.gh.fault({ route: 'ref', status: 404, times })
            return outcome
          },
          wait: async (ms) => {
            waited.push(ms)
          },
        },
        clone,
      )

      const result = await opened.forge.submit(opened.change, opened.base)

      expect(waited, String(times)).toEqual([500, 1500])
      if (times === 2) {
        expect(result).toMatchObject({ outcome: 'created', pushed: true })
        continue
      }
      expect(result).toEqual({
        outcome: 'refused',
        reason:
          `${opened.change.branch} was pushed, and ${WHERE} does not show it yet. If your git configuration rewrites ` +
          'this URL or your ssh configuration this host, the push went elsewhere; otherwise run the same command again, ' +
          'which opens the pull request once GitHub shows the branch',
        kept: opened.change.branch,
      })
      expect(clone.gh.state.pulls ?? []).toEqual([])
      expect(await onGitHub(clone, opened.change.branch)).toBe(
        await git(clone.repo, 'rev-parse', `refs/heads/${opened.change.branch}`),
      )
    }
  })

  it('opens nothing when the push went elsewhere', async () => {
    const clone = await githubClone()
    const elsewhere = path.join(await scratch('idp-elsewhere-'), 'elsewhere.git')
    await git(path.dirname(elsewhere), 'init', '-q', '--bare', elsewhere)
    const ssh = await fakeSsh(path.dirname(elsewhere), elsewhere)
    // The person's global configuration names another ssh, and no variable outranks it.
    delete clone.env['GIT_SSH_COMMAND']
    await writeFile(path.join(clone.env['HOME'] ?? '', '.gitconfig'), `[core]\n\tsshCommand = ${ssh}\n`)
    const opened = await setUp({ wait: async () => {} }, clone)

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toMatchObject({ outcome: 'refused', kept: opened.change.branch })
    expect(await git(elsewhere, 'rev-parse', `refs/heads/${opened.change.branch}`)).toBeDefined()
    expect(await onGitHub(clone, opened.change.branch)).toBeUndefined()
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })

  it('opens the pull request with the note when the rules stop holding during the push', async () => {
    const clone = await githubClone()
    const inner = pushIn(clone.repo, { env: clone.env })
    const opened = await setUp(
      {
        push: async (request) => {
          unprotect(clone.gh)
          return inner(request)
        },
      },
      clone,
    )
    const refs = await remoteRefs(clone.bare)

    const result = await opened.forge.submit(opened.change, opened.base)

    expect(result).toMatchObject({ outcome: 'created', note: 'author-may-merge', pushed: true, pullRequest: { number: 1 } })
    noted(clone)
    movedByTheBranch(clone, refs, await remoteRefs(clone.bare), opened.change.branch)
    expect((await preflight(opened.api, opened.road, opened.base)).verdict.holds).toBe(false)
  })

  it('says so when GitHub refuses to open the pull request, and opens it on the next run', async () => {
    const opened = await setUp()
    opened.clone.gh.fault({ route: 'open-pull-request', status: 502, times: 1 })

    expect(await opened.forge.submit(opened.change, opened.base)).toEqual({
      outcome: 'pushed-without-pull-request',
      branch: opened.change.branch,
      commit: await git(opened.clone.repo, 'rev-parse', `refs/heads/${opened.change.branch}`),
      reason: 'the pull request was not opened: GitHub answered 502 through gh. Run the same command again to open it.',
    })
    const again = await setUp({}, opened.clone)
    expect(await again.forge.recognise(again.change, again.base)).toMatchObject({ outcome: 'pushed-without-pull-request' })
    expect(await again.forge.submit(again.change, again.base)).toMatchObject({
      outcome: 'created',
      pushed: false,
      pullRequest: { number: 1 },
    })
  })

  it('answers a 422 by listing again', async () => {
    const opened = await setUp()
    opened.clone.gh.fault({ route: 'open-pull-request', status: 422, times: 1, made: true })

    expect(await opened.forge.submit(opened.change, opened.base)).toMatchObject({
      outcome: 'created',
      pullRequest: { number: 1, state: 'open' },
    })
    expect(opened.clone.gh.state.pulls).toHaveLength(1)
  })

  it('does not claim a pull request whose answer was lost, nor deny one', async () => {
    const after = await setUp()
    after.clone.gh.fault({ route: 'open-pull-request', status: 'lost', times: 1, made: true })
    expect(await after.forge.submit(after.change, after.base)).toMatchObject({
      outcome: 'created',
      pullRequest: { number: 1, state: 'open' },
    })

    const before = await setUp()
    before.clone.gh.fault({ route: 'open-pull-request', status: 'lost', times: 1, made: false })
    expect(await before.forge.submit(before.change, before.base)).toMatchObject({
      outcome: 'pushed-without-pull-request',
      reason: 'gh did not say whether the pull request was opened. Run the same command again: it names the pull request, or opens it.',
    })
    expect(before.clone.gh.state.pulls ?? []).toEqual([])
  })

  it("classifies a failed push, and prints none of git's words", async () => {
    const CANARY = 'canary-stderr-0123'
    const failure = (stderr: string, timedOut = false): GitError =>
      new GitError(['push'], timedOut ? 'SIGTERM' : 128, `${stderr}\n${CANARY}\n`, timedOut)
    const table: readonly [GitError, PushFailure][] = [
      [failure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'authentication'],
      [failure('remote: Invalid username or password.\nfatal: Authentication failed for x'), 'authentication'],
      [failure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), 'authentication'],
      [failure('Host key verification failed.\nfatal: Could not read from remote repository.'), 'host-key'],
      [failure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@'), 'host-key'],
      [failure(' ! [rejected] x -> x (stale info)'), 'lease'],
      [failure('remote: error: GH013: Repository rule violations found for refs/heads/idp-agent/x.'), 'ruleset'],
      [failure('ssh: Could not resolve hostname github.com'), 'network'],
      [failure('ssh: connect to host github.com port 22: Connection refused'), 'network'],
      [failure('ssh: connect to host github.com port 22: Connection timed out'), 'network'],
      [failure('Connection reset by peer'), 'network'],
      [failure('', true), 'network'],
      [failure('fatal: something else entirely'), 'other'],
    ]
    for (const [error, expected] of table) expect(classifyPushFailure(error), error.stderr).toBe(expected)

    for (const refuse of ['publickey', 'host-key'] as const) {
      const clone = await githubClone()
      clone.env['GIT_SSH_COMMAND'] = await fakeSsh(path.dirname(clone.bare), clone.bare, refuse)
      const opened = await setUp({ wait: async () => {} }, clone)

      const result = await opened.forge.submit(opened.change, opened.base)

      expect(result, refuse).toMatchObject({ outcome: 'refused', kept: opened.change.branch })
      const reason = result.outcome === 'refused' ? result.reason : ''
      expect(reason, refuse).toContain(
        refuse === 'publickey' ? 'your git could not authenticate to github.com' : "your ssh does not trust github.com's host key",
      )
      expect(reason, refuse).toContain(`${opened.change.branch} was cut in this clone and nothing is on GitHub`)
      expect(reason, refuse).not.toMatch(/Permission denied|Host key verification|fatal:/)
      expect(await onGitHub(clone, opened.change.branch), refuse).toBeUndefined()
    }
  })

  it('stops at 180 s', async () => {
    // Before the push: the clock passes the bound while the local branch is cut.
    let time = 1_000
    const late = await githubClone()
    const inner = gitIn(late.repo, { env: late.env })
    const slow: Git = async (args, input) => {
      if (args[0] === 'update-ref') time += 181_000
      return inner(args, input)
    }
    let pushes = 0
    const counting = pushIn(late.repo, { env: late.env })
    const before = await setUp(
      {
        git: slow,
        now: () => time,
        push: async (request) => {
          pushes += 1
          return counting(request)
        },
      },
      late,
    )
    const stopped = await before.forge.submit(before.change, before.base)
    expect(stopped).toMatchObject({ outcome: 'refused', kept: before.change.branch })
    expect(stopped.outcome === 'refused' ? stopped.reason : '').toContain('180 s')
    expect(pushes).toBe(0)

    // Between the push and the pull request.
    let clock = 1_000
    const between = await githubClone()
    const pushing = pushIn(between.repo, { env: between.env })
    const after = await setUp(
      {
        now: () => clock,
        push: async (request) => {
          const outcome = await pushing(request)
          clock += 181_000
          return outcome
        },
      },
      between,
    )
    const result = await after.forge.submit(after.change, after.base)
    expect(result).toMatchObject({ outcome: 'pushed-without-pull-request' })
    expect(result.outcome === 'pushed-without-pull-request' ? result.reason : '').toBe(
      'the pull request was not opened: the submission took longer than 180 s. Run the same command again to open it.',
    )
    expect(between.gh.state.pulls ?? []).toEqual([])
  })

  it('stays within 48 gh calls on its longest path', async () => {
    // Ten supplying rulesets, read at the re-check and again before the pull
    // request; the read-back faulted 404 twice; the POST answered 422 after
    // opening, so the pull requests are listed again. (A branch already on
    // GitHub skips the push and its read-back, so it is not on this path.)
    const rulesets = Array.from({ length: 10 }, (_, at) => protectingRuleset(at + 1))
    const clone = await githubClone()
    clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({ ...one, rulesets }))
    const inner = pushIn(clone.repo, { env: clone.env })
    const opened = await setUp(
      {
        push: async (request) => {
          const outcome = await inner(request)
          clone.gh.fault({ route: 'ref', status: 404, times: 2 })
          return outcome
        },
        wait: async () => {},
      },
      clone,
    )
    clone.gh.fault({ route: 'open-pull-request', status: 422, times: 1, made: true })

    expect(await opened.forge.recognise(opened.change, opened.base)).toBeUndefined()
    expect(await opened.forge.submit(opened.change, opened.base)).toMatchObject({ outcome: 'created' })

    expect(opened.api.calls()).toBeLessThanOrEqual(48)
    expect(opened.api.calls()).toBe(clone.gh.sent.length)
    expect(clone.gh.sent.filter((sent) => sent.argv[4] === 'POST')).toHaveLength(1)
    // What is left of the budget, spent; then one more is refused before gh starts.
    while (opened.api.calls() < 48) await opened.api.ref('main')
    await expect(opened.api.ref('main')).rejects.toThrow('more than 48 gh calls')
    expect(clone.gh.sent).toHaveLength(48)
  })
})
