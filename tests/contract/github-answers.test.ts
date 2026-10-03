import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GH_MINIMUM_VERSION, isAtLeast, parseGhVersion } from '../../src/core/github/gh-version.js'
import { classifyPushFailure } from '../../src/forge/github/push.js'
import { GH_LIMITS, ghArgv, ghIn, parseIncluded, type GhExit, type GhRoute } from '../../src/process/gh.js'
import { GitError } from '../../src/process/git.js'
import { LIVE_DOORS } from '../live/github/doors.js'
import { DOORS, FAKE_GH_VERSION, MODELLED_DOORS, fakeGitHub, repository, type FakeGitHub } from '../support/fake-gh.js'
import { removeClones } from '../support/forge-fixture.js'
import { answersFiles, fakeWithin, identifying, shapeOf, unheld, type AnswersFile, type DoorEntry, type RouteEntry } from '../support/github-answers.js'
import { openedPullRequest, type GitHubClone } from '../support/github-fixture.js'
import { git } from '../support/git.js'

/**
 * The fake gh, held to what GitHub answered (stage 6 brief § 10; stage 6
 * plan, Task 6.4.1). Each file of `tests/contract/github/` is one run of the
 * owner's live test (`pnpm test:live:github`), logins removed: the status and
 * the shape of each route as GitHub answered it, the answer to each door tried
 * as the identity that opened the pull request, the `remote:` lines of the
 * refused push, and what `--include` printed for an answer that was not 2xx.
 * The fake must answer each route with the same status and say nothing GitHub
 * did not — the schemas of `core/github/answers.ts` are tested on the fake's
 * answers, so what they read is then in GitHub's — and refuse each door it
 * models as GitHub did: the merge GitHub judges later answered as GitHub
 * answered it (202 on 2026-10-02), and never carried out while the rules
 * refuse it. Offline: the files are read, the fake is asked.
 *
 * Until the owner's first run is committed there is no file, and this is the
 * one red test of the suite, by design: a pattern with no match is a read
 * error. This file names no door: it reads their names from the files, from
 * `LIVE_DOORS` and from `DOORS`.
 */

afterAll(removeClones)

const files = (): { readonly file: string; readonly text: string; readonly answers: AnswersFile }[] =>
  answersFiles().map((file) => {
    const text = readFileSync(file, 'utf8')
    return { file: path.basename(file), text, answers: JSON.parse(text) as AnswersFile }
  })

/** The fake's account for a recorded one: the owner is `ada`, who opened the pull request; the reviewer `grace`. */
const LOGIN: Readonly<Record<RouteEntry['account'], string>> = { owner: 'ada', reviewer: 'grace' }

/** The base whose name holds a slash, in the fake's world. */
const LIVE_BASE = 'live/20261002000000/base'

/** Pull request #1 opened, and a base whose name holds a slash beside `main`, as the live run's step 1 pushes one. */
const world = async (): Promise<{ readonly clone: GitHubClone; readonly head: string; readonly branch: string }> => {
  const { clone, change, head } = await openedPullRequest()
  await git(clone.repo, 'push', '-q', clone.bare, `main:refs/heads/${LIVE_BASE}`)
  clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
    ...one,
    branches: { ...one.branches, [LIVE_BASE]: { protected: false } },
  }))
  return { clone, head, branch: change.branch }
}

/** The route a recorded entry names, in the fake's world; `pull` has none — it is the one POST's answer. */
const routeOf = (entry: RouteEntry, world: { readonly head: string; readonly branch: string }): GhRoute | undefined => {
  const repository = { owner: 'acme', name: 'iac' }
  const branch = entry.subject === 'live-base' ? LIVE_BASE : entry.subject === 'submission' ? world.branch : 'main'
  switch (entry.route) {
    case 'user':
      return { route: 'user' }
    case 'repository':
      return { route: 'repository', ...repository }
    case 'branch':
    case 'rules':
    case 'ref':
      return { route: entry.route, ...repository, branch }
    case 'ruleset':
      return { route: 'ruleset', ...repository, id: 1 }
    case 'commit':
      return { route: 'commit', ...repository, sha: world.head }
    case 'pulls':
      return { route: 'pulls', ...repository, head: world.branch }
    case 'open-pulls':
      return { route: 'open-pulls', ...repository, base: 'main', page: 1 }
    case 'pull-files':
      return { route: 'pull-files', ...repository, number: 1 }
    case 'pull':
      return undefined
    default:
      throw new Error(`a recorded route this build does not read: ${entry.route}`)
  }
}

/** A vector handed to the fake as the launcher would hand it. */
const tried = (gh: FakeGitHub, argv: readonly string[], stdin?: string): Promise<GhExit> =>
  gh.process(argv, { ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin, 'utf8') }), env: {}, limits: GH_LIMITS })

/** The live door a recorded entry is, by its name and its step. */
const liveDoorOf = (entry: DoorEntry) => LIVE_DOORS.find((door) => door.name === entry.door && door.step === entry.step)

// Real git processes and bare repositories, as in merge-refused.test.ts.
describe('the fake gh, held to what GitHub answered', { timeout: 60_000 }, () => {
  it('reads at least one answers file, each from a run that passed, step 5 made or skipped for want of a second account', () => {
    const read = files()
    expect(read.length).toBeGreaterThan(0)
    for (const { file, text, answers } of read) {
      expect(answers.version, file).toBe(1)
      expect(answers.passed, file).toBe(true)
      // The second account is optional (2026-10-01): a run without it skips step 5, saying so.
      expect(['made', 'skipped'], file).toContain(answers.steps.afterApproval)
      expect(identifying(text, []), file).toEqual([])
      expect(answers.repository, file).toMatch(/^<owner>\//)
    }
  })

  it('has each hand-filled field answered, and bypassListEmpty true, agreeing with the bypass actors read when they were readable', () => {
    for (const { file, answers } of files()) {
      const { actionsCanApprovePullRequests, gitPushesAsGhAccount, bypassListEmpty } = answers.handFilled
      expect(typeof actionsCanApprovePullRequests, file).toBe('boolean')
      expect(typeof gitPushesAsGhAccount, file).toBe('boolean')
      expect(bypassListEmpty, file).toBe(true)
      const actors = answers.bypass?.bypassActors
      if (Array.isArray(actors)) expect(actors.length === 0, file).toBe(bypassListEmpty)
      expect(answers.bypass?.currentUserCanBypass, file).toBe('never')
    }
  })

  it('pins GH_MINIMUM_VERSION to the oldest gh a committed run used, and the fake answers that version', async () => {
    const versions = files().map(({ file, answers }) => {
      if (answers.gh === null) throw new Error(`${file} records no gh version`)
      return answers.gh.version
    })
    const oldest = versions.reduce((lowest, version) => (isAtLeast(version, lowest) ? lowest : version))
    expect(isAtLeast(oldest, GH_MINIMUM_VERSION) && isAtLeast(GH_MINIMUM_VERSION, oldest)).toBe(true)
    expect(FAKE_GH_VERSION).toBe(GH_MINIMUM_VERSION)
    expect(parseGhVersion(await ghIn({ run: fakeGitHub().process }).version())).toBe(GH_MINIMUM_VERSION)
  })

  it('answers each route with the status GitHub answered, and says nothing GitHub did not', async () => {
    const differences: string[] = []
    for (const { file, answers } of files()) {
      const here = await world()
      for (const entry of answers.routes) {
        const where = `${file}: ${entry.account} ${entry.route}${entry.subject === undefined ? '' : ` (${entry.subject})`}`
        here.clone.gh.as(LOGIN[entry.account])
        const route = routeOf(entry, here)
        if (route === undefined) {
          // The single pull request: the fake's answer to the one POST is the element its pulls route lists.
          const listed = await ghIn({ run: here.clone.gh.process }).get({ route: 'pulls', owner: 'acme', name: 'iac', head: here.branch })
          const [pull] = JSON.parse(listed.body) as unknown[]
          for (const at of fakeWithin(shapeOf(pull), entry.shape)) differences.push(`${where}: ${at}`)
          continue
        }
        const answer = await ghIn({ run: here.clone.gh.process }).get(route)
        if (answer.status !== entry.status) differences.push(`${where}: status ${String(answer.status)}, GitHub ${String(entry.status)}`)
        if (answer.hasNext !== entry.hasNext) differences.push(`${where}: a next page ${String(answer.hasNext)}, GitHub ${String(entry.hasNext)}`)
        for (const at of fakeWithin(shapeOf(JSON.parse(answer.body)), entry.shape)) differences.push(`${where}: ${at}`)
      }
    }
    expect(differences).toEqual([])
  })

  it('answers each modelled door as GitHub did, as the owner, and the after-approval merge after an approval and a push', async () => {
    const differences: string[] = []
    for (const { file, answers } of files()) {
      // Every door, modelled or not, was refused by GitHub with the base unchanged — a queued one observed
      // never merged — and nothing the run opened was merged at its end: that is what a passed run is.
      expect(unheld(answers), file).toEqual([])
      const doors = answers.doors.filter((entry) => liveDoorOf(entry)?.modelled === true)
      for (const step of ['doors', 'after-approval'] as const) {
        const recorded = doors.filter((entry) => entry.step === step)
        if (recorded.length === 0) continue
        const here = await world()
        if (step === 'after-approval') {
          // Someone else approved the head, then its author pushed on top of it.
          here.clone.gh.approve(1, 'grace')
          const top = await git(here.clone.repo, 'commit-tree', `${here.head}^{tree}`, '-p', here.head, '-m', 'pushed on top of the approved head')
          await git(here.clone.repo, 'push', '-q', here.clone.bare, `${top}:refs/test/on-top`)
          expect(here.clone.gh.pushAs({ type: 'User', login: 'ada' }, `refs/heads/${here.branch}`, top)).toBe(200)
        }
        here.clone.gh.as('ada')
        for (const entry of recorded) {
          const door = DOORS.find((one) => one.name === entry.door)
          if (door === undefined) {
            differences.push(`${file}: ${entry.door} is modelled and DOORS holds no door of that name`)
            continue
          }
          const main = await git(here.clone.bare, 'rev-parse', 'main')
          const exit = await tried(here.clone.gh, door.argv, door.stdin)
          const where = `${file}: ${entry.door} (${entry.step})`
          switch (entry.via) {
            case 'gh':
              if (exit.code !== entry.exit) differences.push(`${where}: exit ${String(exit.code)}, gh ${String(entry.exit)}`)
              break
            case 'gh-api': {
              const status = parseIncluded(exit.stdout)?.status
              if (status !== entry.status) differences.push(`${where}: status ${String(status)}, GitHub ${String(entry.status)}`)
              break
            }
            case 'graphql':
            case 'git-push':
              differences.push(`${where}: a door through ${entry.via} is marked modelled, and the fake answers none`)
              break
            default: {
              const _exhaustive: never = entry.via
              throw new Error(`a door through ${String(_exhaustive)}`)
            }
          }
          // A queued door's 2xx is gh's exit 0 and no merge: what the fake did after it says whether it let it through.
          if (exit.code === 0 && entry.reason !== 'queued') differences.push(`${where}: the fake let it through`)
          if ((await git(here.clone.bare, 'rev-parse', 'main')) !== main) differences.push(`${where}: the fake moved main`)
          const pull = here.clone.gh.state.pulls?.[0]
          if (pull?.state !== 'open' || pull.merged_at !== null) differences.push(`${where}: the fake merged or closed the pull request`)
        }
      }
    }
    expect(differences).toEqual([])
  })

  it('holds every modelled live door to a DOORS entry of the same name', () => {
    const named = new Set(DOORS.map((door) => door.name))
    const modelled = LIVE_DOORS.filter((door) => door.modelled)
    expect(modelled.length).toBeGreaterThan(0)
    for (const door of modelled) {
      expect(named.has(door.name), door.name).toBe(true)
      expect(MODELLED_DOORS.has(door.name), door.name).toBe(true)
    }
    // A door the fake does not model carries a name DOORS does not use, so no file's entry is held to the wrong vector.
    for (const door of LIVE_DOORS.filter((one) => !one.modelled)) expect(named.has(door.name), door.name).toBe(false)
  })

  it('classifies the recorded push rejection as a ruleset refusal', () => {
    let pushes = 0
    for (const { file, answers } of files()) {
      for (const entry of answers.doors.filter((one) => one.via === 'git-push')) {
        pushes += 1
        expect(entry.remote.length, file).toBeGreaterThan(0)
        expect(classifyPushFailure(new GitError(['push'], 1, entry.remote.join('\n'), false)), file).toBe('ruleset')
      }
    }
    expect(pushes).toBeGreaterThan(0)
  })

  it('reads a non-2xx answer through --include as GitHub printed it, exiting as gh did', async () => {
    for (const { file, answers } of files()) {
      const recorded = answers.include
      if (recorded === null) throw new Error(`${file} records no answer that was not 2xx`)
      expect(recorded.nonSuccessParsed, file).toBe(true)
      // A branch the repository does not hold, as the live run read one.
      const fake = fakeGitHub({ repositories: [repository()] })
      const exit = await tried(fake, ghArgv({ kind: 'get', route: { route: 'ref', owner: 'acme', name: 'iac', branch: 'live/absent' } }))
      const included = parseIncluded(exit.stdout)
      expect(included?.status, file).toBe(recorded.status)
      expect(exit.code, file).toBe(recorded.exitOnNonSuccess)
    }
  })
})
