import { isSubmissionBranch, mergeReads, type InFlightPull } from '../../core/github/in-flight.js'
import { isLogin, printedRepository } from '../../core/github/remote.js'
import type { GitHubRoad } from '../provider.js'
import { GitHubAnswerError, type GitHubApi, type OpenPull } from './api.js'
import { GITHUB_LIMITS } from './limits.js'

/**
 * What is in flight, read (the owner's decision of 2026-10-01, stage 6 plan
 * Task 6.3.6): the open pull requests into the base, page by page and newest
 * first, and the files of each idp-agent one of this repository — read whole,
 * within `GITHUB_LIMITS`, or refused as a `GitHubAnswerError`, never judged on
 * a part, as a catalogue that cannot be read whole is never answered from.
 * Reads only: nothing here writes to GitHub, and another person's pull request
 * is never edited, commented on or closed. `core/github/in-flight.ts` judges.
 *
 * A candidate is a pull request whose head is a branch of this very
 * repository named as an idp-agent run names one. Only a candidate's login is
 * held to `isLogin`: a bot's (`dependabot[bot]`) or one GitHub shows as
 * nobody's is not looked at, and must not stop every submission into the
 * base. A candidate whose login the grammar refuses makes the read
 * unreadable: it is one of the pull requests this run must compare with.
 */

const NOTHING = 'Nothing was written.'

/** A branch of this repository, named as an idp-agent run names one: a fork's never is. */
const isCandidate = (pull: OpenPull, road: GitHubRoad): boolean =>
  pull.repository !== null &&
  // GitHub's comparison: an owner and a name whatever their case.
  pull.repository.toLowerCase() === `${road.repository.owner}/${road.repository.name}`.toLowerCase() &&
  isSubmissionBranch(pull.branch)

/** The candidates on a list of open pull requests, each login held to its grammar, more than the bound refused. */
const candidatesOf = (listed: readonly OpenPull[], road: GitHubRoad): readonly (OpenPull & { readonly by: string })[] => {
  const where = printedRepository(road.repository)
  const candidates = listed.filter((pull) => isCandidate(pull, road))
  if (candidates.length > GITHUB_LIMITS.inFlightPulls) {
    throw new GitHubAnswerError(
      'open-pulls',
      'paginated',
      road.repository,
      `${where} has ${String(candidates.length)} open idp-agent pull requests into ${road.base}, more than the ` +
        `${String(GITHUB_LIMITS.inFlightPulls)} this build compares: review some of them, then run this again. ${NOTHING}`,
    )
  }
  return candidates.map((pull) => {
    if (pull.by === undefined || !isLogin(pull.by)) throw new GitHubAnswerError('open-pulls', 'unreadable', road.repository)
    return { ...pull, by: pull.by }
  })
}

/** A candidate and its files, one page of them. */
const withFiles = async (api: GitHubApi, pull: OpenPull & { readonly by: string }): Promise<InFlightPull> => {
  const { files, complete } = await api.pullFiles(pull.number)
  return { number: pull.number, by: pull.by, branch: pull.branch, head: pull.head, files, complete }
}

/** The candidates, read whole or refused: at most three pages, then one file list each, at most twenty. */
export async function readInFlight(api: GitHubApi, road: GitHubRoad): Promise<readonly InFlightPull[]> {
  const listed = new Map<number, OpenPull>()
  for (let page = 1; ; page += 1) {
    const { pulls, more } = await api.openPulls(road.base, page)
    // A pull request opened between two pages pushes one already listed onto
    // the next: listed once.
    for (const pull of pulls) if (!listed.has(pull.number)) listed.set(pull.number, pull)
    if (!more) break
    if (page >= GITHUB_LIMITS.inFlightPages) {
      throw new GitHubAnswerError(
        'open-pulls',
        'paginated',
        road.repository,
        `${printedRepository(road.repository)} has more than ${String(GITHUB_LIMITS.inFlightPages * GITHUB_LIMITS.pullsPage)} ` +
          `open pull requests into ${road.base}, more than this build reads, so what is in flight cannot be read whole. ${NOTHING}`,
      )
    }
  }
  const read: InFlightPull[] = []
  // One after the other: twenty file lists at most, and an order a test can read.
  for (const pull of candidatesOf([...listed.values()], road)) read.push(await withFiles(api, pull))
  return read.sort((a, b) => b.number - a.number)
}

/**
 * Step 8's read, at the moment of writing: page 1 again — the hundred most
 * recently created, so a pull request opened since the first read is on it —
 * and the files of each candidate on it that the first read did not hold or
 * whose head moved since; then the first read updated by it (`mergeReads`).
 */
export async function rereadInFlight(
  api: GitHubApi,
  road: GitHubRoad,
  first: readonly InFlightPull[],
): Promise<readonly InFlightPull[]> {
  const { pulls, more } = await api.openPulls(road.base, 1)
  const known = new Map(first.map((pull) => [pull.number, pull] as const))
  const page: InFlightPull[] = []
  for (const pull of candidatesOf(pulls, road)) {
    const held = known.get(pull.number)
    page.push(held !== undefined && held.head === pull.head && held.branch === pull.branch ? held : await withFiles(api, pull))
  }
  return mergeReads(first, page, { listed: pulls.map((pull) => pull.number), whole: !more })
}
