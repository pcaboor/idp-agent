import { judgeInFlight, type InFlightEntry, type InFlightPull, type InFlightVerdict } from '../../core/github/in-flight.js'
import { LONGEST_BESIDE, pullRequestBody, pullRequestUrl, type PullRequestInput } from '../../core/github/pull-request.js'
import { LONGEST_NOTE, noteOf } from '../../core/github/protection.js'
import { printedRepository, sameRepository } from '../../core/github/remote.js'
import { isCleared, type Cleared } from '../../core/plan/clear.js'
import { gitIn, pushIn, type Git, type Push } from '../../process/git.js'
import { ForgeInputError } from '../errors.js'
import { blobId, objectFormat } from '../local/objects.js'
import { treeFor } from '../local/tree.js'
import type { Base, ForgeProvider, GitHubRoad, PullRequest, Recognised, Road, Submitted } from '../provider.js'
import { GitHubAnswerError, type GitHubApi, type PullRequestFrom } from './api.js'
import { readInFlight, rereadInFlight } from './in-flight.js'
import { GITHUB_LIMITS } from './limits.js'
import { readRules } from './preflight.js'
import { pushChange } from './push.js'
import { readRoad } from './road.js'

/**
 * The GitHub forge (stage 6 brief § 3, § 4, § 14): stage 5's local forge, and
 * the remote half of a submission — through the person's own git and gh,
 * holding no credential of its own.
 *
 * `recognise` reads only: the local forge's answer first (a local branch that
 * is not ours is refused before anything is read on GitHub), then the branch
 * on GitHub, its commit when it is not the local one, and the pull requests
 * from it (§ 14's table, first match wins).
 *
 * `inFlight` reads too (Task 6.3.6): the open idp-agent pull requests into
 * the base and their files, once per forge, kept, and every later judgement
 * answered from that read.
 *
 * `submit` writes, and only past step 8, the re-check at the moment of acting:
 * the clone's upstream and its own configuration read again (`readRoad`), the
 * base's rules (`readRules`, for their status checks), GitHub's base at the
 * commit the clone's is, what is in flight read again and judged — the same
 * bytes already proposed are named and a competing change refused, nothing
 * written on either side — and the branch on GitHub and the pull requests from
 * it judged again, by § 14's table as `recognise` judges them. Then step 9,
 * stage 5's local branch; step 10, the push of that very commit, create-only;
 * step 11, the branch read back through gh and the rules read once more;
 * step 12, the one pull request, its body the engine's.
 *
 * The rules never refuse a submission (the owner's decision of 2026-10-01):
 * whether a pull request's author may merge it alone is the company's rule.
 * `readRules` judges items 2 and 3 alone, so neither read holds an item-1
 * kind — an account that lost its push access meanwhile is refused by the
 * push — and step 11's read decides the note in the body, never whether to
 * open.
 *
 * What it is not: atomic across the two systems. Its only writes on GitHub
 * are one ref and one pull request, each atomic on its own; the two together
 * are not, and every state a failure leaves between them is a row of § 4's
 * table that the same command, run again, completes
 * (`tests/invariants/github-forge.test.ts`). It has no merge, no approval, no
 * deletion and no push but the create-only one, and it takes no branch name
 * from anyone: the name is the clearance's, which the engine computed.
 */

type Remote =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ours'; readonly commit: string; readonly olderBase?: string }
  | { readonly kind: 'other' }

const short = (commit: string): string => commit.slice(0, 7)

const refused = (reason: string, kept?: string): Submitted =>
  kept === undefined ? { outcome: 'refused', reason } : { outcome: 'refused', reason, kept }

/** A sentence ends on its stop. */
const stopped = (sentence: string): string => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`)

/**
 * What a throw after step 9 says, in this build's words: a `GitHubAnswerError`
 * names the route and the status and never GitHub's words, and a `GitError`'s
 * message never quotes git. "Nothing was written" is dropped: by then
 * something was.
 */
const reasonOf = (error: unknown): string => {
  const said = error instanceof Error ? error.message : String(error)
  return stopped(said.replace(/\s*Nothing was written\.$/, '').trim())
}

/** The same road, field for field: what step 8 requires of the one read at the moment of acting. */
const sameRoad = (now: Road, then: GitHubRoad): boolean =>
  now.kind === 'github' &&
  sameRepository(now.repository, then.repository) &&
  now.remote === then.remote &&
  now.base === then.base &&
  now.branch === then.branch &&
  now.pushUrl === then.pushUrl

export function openGitHubForge(input: {
  readonly repo: string
  /** Opened with `acceptOlderBase: true`, for the same repository. */
  readonly local: ForgeProvider
  readonly road: GitHubRoad
  /**
   * gh's API, opened by `openGitHub` once gh's identity was read and found a
   * person. `readRules` judges the rules as the preflight found them.
   */
  readonly api: GitHubApi
  /**
   * gh's login, from `readIdentity`: only `judgeInFlight` reads it, to leave
   * gh's own pull request from this very branch to recognition. Never said,
   * traced or posted.
   */
  readonly login: string
  readonly env: NodeJS.ProcessEnv
  /** The road that made the change, which the pull request's block names (D4). */
  readonly route: PullRequestInput['road']
  /** `gitIn(repo, { env })` unless a test hands a failing one. */
  readonly git?: Git
  /** `pushIn(repo, { env })` unless a test hands a failing one. */
  readonly push?: Push
  /** How the read-back waits between reads (§ 4). */
  readonly wait?: (ms: number) => Promise<void>
  /** The clock of the 180 s bound (§ 15). */
  readonly now?: () => number
}): ForgeProvider {
  const { local, road, api, route } = input
  const git = input.git ?? gitIn(input.repo, { env: input.env })
  const push = input.push ?? pushIn(input.repo, { env: input.env })
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const where = printedRepository(road.repository)
  const seconds = String(GITHUB_LIMITS.submissionMs / 1000)

  let format: Promise<'sha1' | 'sha256'> | undefined
  const formatOf = (): Promise<'sha1' | 'sha256'> => (format ??= objectFormat(git))

  /** The commit a branch is at on GitHub; `undefined` for GitHub's 404. */
  const refOf = async (branch: string): Promise<string | undefined> =>
    api.ref(branch).catch((error: unknown) => {
      if (error instanceof GitHubAnswerError && error.status === 404) return undefined
      throw error
    })

  const notOurs = (change: Cleared): string => `${change.branch} exists on ${where} and carries a different change`

  /** The first read of what is in flight, made once per forge and kept: a failed read stays failed. */
  let first: Promise<readonly InFlightPull[]> | undefined
  const firstRead = (): Promise<readonly InFlightPull[]> => (first ??= readInFlight(api, road))

  /** A change as `judgeInFlight` reads it: each write's bytes as the blob id GitHub reports for them. */
  const judgedFor = async (
    pulls: readonly InFlightPull[],
    target: Parameters<NonNullable<ForgeProvider['inFlight']>>[0],
  ): Promise<InFlightVerdict> => {
    const objects = await formatOf()
    return judgeInFlight(pulls, {
      writes: target.writes.map((write) =>
        write.after === undefined ? { path: write.path } : { path: write.path, blob: blobId(Buffer.from(write.after, 'utf8'), objects) },
      ),
      related: target.related,
      ...(target.branch === undefined ? {} : { branch: target.branch }),
      me: input.login,
    })
  }

  const inFlight: NonNullable<ForgeProvider['inFlight']> = async (target) => judgedFor(await firstRead(), target)

  /** Step 8's reading of what is in flight, for the very change being submitted. */
  const inFlightNow = async (change: Cleared): Promise<InFlightVerdict> =>
    judgedFor(await rereadInFlight(api, road, await firstRead()), {
      writes: change.edits.map((edit) => ({ path: edit.path, after: edit.after })),
      related: change.related,
      branch: change.branch,
    })

  /** What a competing pull request makes of a submission: refused, its entries for the CLI to show. */
  const competing = (pulls: readonly InFlightEntry[]): Submitted => ({
    outcome: 'refused',
    reason:
      pulls
        .map(
          (one) =>
            `pull request #${String(one.pull.number)} on ${where} already changes ${one.paths.join(', ')}, differently: ` +
            pullRequestUrl(road.repository, one.pull.number),
        )
        .join('\n') + ' Nothing was written.',
    inFlight: pulls,
  })

  const pullRequestOf = (number: number, state: PullRequest['state']): PullRequest => ({
    host: 'github.com',
    repository: `${road.repository.owner}/${road.repository.name}`,
    number,
    url: pullRequestUrl(road.repository, number),
    state,
    base: road.base,
  })

  /**
   * The branch on GitHub, judged as the local forge judges its own: ours when
   * its commit is the local branch's, or — for a commit this clone never made
   * — one commit, on the base or an ancestor of it (`merge-base
   * --is-ancestor`, any failure of it "not an ancestor"), under the message
   * the engine wrote (with or without its final newline, which GitHub may
   * drop), whose tree is the one these edits give that parent (`treeFor`,
   * computed and never written). Anything else is somebody else's.
   */
  const remoteOf = async (change: Cleared, base: Base, known: Recognised | undefined): Promise<Remote> => {
    const sha = await refOf(change.branch)
    if (sha === undefined) return { kind: 'absent' }
    if (known?.outcome === 'already-submitted' && known.commit === sha) {
      return { kind: 'ours', commit: sha, ...(known.olderBase === undefined ? {} : { olderBase: known.olderBase }) }
    }
    const commit = await api.commit(sha)
    const [parent] = commit.parents
    if (commit.parents.length !== 1 || parent === undefined) return { kind: 'other' }
    if (commit.message !== change.message && commit.message !== change.message.replace(/\n$/, '')) {
      return { kind: 'other' }
    }
    const older =
      parent !== base.commit &&
      (await git(['merge-base', '--is-ancestor', parent, base.commit]).then(
        () => true,
        () => false,
      ))
    if (parent !== base.commit && !older) return { kind: 'other' }
    const tree = await treeFor(git, parent, change.edits, await formatOf()).catch(() => undefined)
    if (tree !== commit.tree) return { kind: 'other' }
    return { kind: 'ours', commit: sha, ...(older ? { olderBase: parent } : {}) }
  }

  /** § 14's table, first match wins. */
  const decided = (
    change: Cleared,
    base: Base,
    remote: Remote,
    pulls: readonly PullRequestFrom[],
    known: Recognised | undefined,
  ): Recognised | undefined => {
    switch (remote.kind) {
      case 'other':
        return { outcome: 'refused', reason: notOurs(change) }
      case 'absent':
      case 'ours':
        break
      default: {
        const _exhaustive: never = remote
        return _exhaustive
      }
    }
    const open = pulls.filter((one) => one.state === 'open')
    const [first] = open
    // GitHub closes a pull request whose branch is deleted: an open one with
    // no branch is not a state this tool made, and nothing is claimed of it.
    if (remote.kind === 'absent' && first !== undefined) {
      return {
        outcome: 'refused',
        reason: `pull request #${String(first.number)} on ${where} is open from ${change.branch}, which GitHub does not hold; it is not this submission`,
      }
    }
    if (remote.kind === 'ours') {
      const into = open.find((one) => one.base === road.base)
      if (into !== undefined) {
        return {
          outcome: 'already-submitted',
          branch: change.branch,
          commit: remote.commit,
          pushed: false,
          pullRequest: pullRequestOf(into.number, 'open'),
          ...(remote.olderBase === undefined ? {} : { olderBase: remote.olderBase }),
        }
      }
    }
    if (first !== undefined) {
      return {
        outcome: 'refused',
        reason: `${change.branch} has pull request #${String(first.number)} open on ${where} into ${first.base}, not ${road.base}; it is not this submission`,
      }
    }
    const [latest] = pulls.flatMap((one) => (one.state === 'closed' ? [one] : [])).sort((a, b) => b.number - a.number)
    if (latest !== undefined) {
      return { outcome: 'closed', branch: change.branch, number: latest.number, merged: latest.merged, at: latest.at }
    }
    if (remote.kind === 'ours') {
      return {
        outcome: 'pushed-without-pull-request',
        branch: change.branch,
        commit: remote.commit,
        reason: 'the branch was pushed by an earlier run; opening its pull request',
      }
    }
    if (known?.outcome === 'already-submitted' && known.olderBase !== undefined) {
      return { outcome: 'refused', reason: stale(change, base, known.olderBase) }
    }
    return undefined
  }

  /** § 14's fifth row: our local branch, on an older base, that GitHub never received. The tool never deletes. */
  const stale = (change: Cleared, base: Base, older: string): string =>
    `${change.branch} is in this clone on ${base.branch}@${short(older)}, an older ${base.branch}, and was never ` +
    `opened for review; delete it (git branch -D ${change.branch}) and run this again`

  const recognise = async (change: Cleared, base: Base): Promise<Recognised | undefined> => {
    // § 14's last row: a local branch that is not ours is refused before
    // anything is read on GitHub, and so is a clearance that is not one.
    const known = await local.recognise(change, base)
    if (known?.outcome === 'refused') return known
    if (change.edits.length === 0) return undefined
    const remote = await remoteOf(change, base, known)
    return decided(change, base, remote, await api.pulls(change.branch), known)
  }

  /** Step 8: the road, the clone's own configuration with it, read again; a sentence when it moved. */
  const roadMoved = async (): Promise<string | undefined> => {
    let read: Road
    try {
      read = await readRoad(git, { local: false })
    } catch (error) {
      // Mid-run, a refused key or a detached HEAD is the repository moving,
      // not an argument: a refusal, exit 1.
      if (error instanceof ForgeInputError) return error.message
      throw error
    }
    if (sameRoad(read, road)) return undefined
    return `${road.branch}'s upstream changed during the run: it no longer names ${where}'s ${road.base}; run this again. Nothing was written.`
  }

  /** The pull request's text for a change, with the note step 11's read calls for, and the pull requests beside it, if any. */
  const textOf = (
    change: Cleared,
    note?: PullRequestInput['note'],
    beside: readonly InFlightEntry[] = [],
  ): { readonly title: string; readonly body: string } =>
    pullRequestBody({
      message: change.message,
      request: change.request,
      road: route,
      branch: change.branch,
      ...(note === undefined ? {} : { note }),
      ...(beside.length === 0 ? {} : { beside: { numbers: beside.map((one) => one.pull.number), base: road.base } }),
      // Stage 8's report, after the engine's block: inside the bound checked
      // below, on `textOf(change)`, before anything is written.
      ...(change.coverage === undefined ? {} : { coverage: change.coverage }),
    })

  const overBound = (body: string): boolean => Buffer.byteLength(body, 'utf8') > GITHUB_LIMITS.bodyBytes

  /**
   * Steps 11 and 12: the rules once more, then the one pull request. The
   * branch is on GitHub at `commit`. The read decides the note in the body,
   * never whether to open: rules that weakened while the person read the diff
   * are said, and rules that strengthened leave a body without a note, which
   * is true.
   */
  const opened = async (
    change: Cleared,
    commit: string,
    pushed: boolean,
    olderBase: string | undefined,
    deadline: number,
    beside: readonly InFlightEntry[],
  ): Promise<Submitted> => {
    const stop = (reason: string): Submitted => ({
      outcome: 'pushed-without-pull-request',
      branch: change.branch,
      commit,
      reason,
    })
    const again = await readRules(api, road)
    const note = noteOf(again)
    const text = textOf(change, note === undefined ? undefined : { kind: note, base: road.base, missing: again.missing }, beside)
    // Step 8 checked the body with the longest note and paragraph, so this never holds; checked all the same, before the POST.
    if (overBound(text.body)) {
      return stop(`the pull request was not opened: its body would be over 1 MiB, more than this build sends.`)
    }
    if (now() > deadline) {
      return stop(`the pull request was not opened: the submission took longer than ${seconds} s. Run the same command again to open it.`)
    }
    const created = (number: number, state: PullRequest['state']): Submitted => ({
      outcome: 'created',
      branch: change.branch,
      commit,
      pushed,
      pullRequest: pullRequestOf(number, state),
      statusChecks: again.reported.statusChecks,
      ...(olderBase === undefined ? {} : { olderBase }),
      ...(note === undefined ? {} : { note, missing: again.missing }),
      ...(beside.length === 0 ? {} : { beside }),
    })
    try {
      const { number } = await api.openPullRequest({ ...text, head: change.branch, base: road.base })
      return created(number, 'opened')
    } catch (error) {
      const status = error instanceof GitHubAnswerError ? error.status : undefined
      const answered = (code: number): Submitted =>
        stop(`the pull request was not opened: GitHub answered ${String(code)} through gh. Run the same command again to open it.`)
      if (typeof status === 'number' && status !== 422) return answered(status)
      // A 422 is most often "a pull request already exists"; a lost answer
      // says nothing either way. Listed again, never claimed nor denied.
      const listed = (await api.pulls(change.branch)).find((one) => one.state === 'open' && one.base === road.base)
      if (listed !== undefined) return created(listed.number, 'open')
      if (status === 422) return answered(422)
      return stop('gh did not say whether the pull request was opened. Run the same command again: it names the pull request, or opens it.')
    }
  }

  /** Step 11's read-back: our commit, another, or still nothing after the last wait (§ 4). */
  const readBack = async (branch: string, commit: string): Promise<'ours' | 'other' | 'absent'> => {
    for (let read = 0; ; read++) {
      const found = await refOf(branch)
      if (found === commit) return 'ours'
      if (found !== undefined) return 'other'
      const pause = GITHUB_LIMITS.readBack[read]
      if (pause === undefined) return 'absent'
      await wait(pause)
    }
  }

  const submit = async (change: Cleared, base: Base): Promise<Submitted> => {
    // Stage 5's two checks and the empty change, answered by the local forge
    // before any gh call: a clearance that is not ours costs nothing on GitHub.
    if (!isCleared(change) || change.repository !== local.repository || change.edits.length === 0) {
      return local.submit(change, base)
    }
    const deadline = now() + GITHUB_LIMITS.submissionMs

    // Step 8, reads only: a refusal here leaves nothing on either side.
    const moved = await roadMoved()
    if (moved !== undefined) return refused(moved)
    // The rules, read again: they refuse nothing now (the owner's decision of
    // 2026-10-01), but an answer past its bound — more than ten supplying
    // rulesets, a paginated answer — still stops the run here, before anything
    // is written, and § 15's budget is unchanged.
    await readRules(api, road)
    const tip = await refOf(road.base)
    if (tip === undefined) {
      return refused(`${where} shows no branch ${road.base} to your account; nothing is submitted into it. Nothing was written.`)
    }
    if (tip !== base.commit) {
      return refused(
        `${where}'s ${road.base} is at ${short(tip)} and this clone's ${base.branch} is at ${short(base.commit)}: ` +
          'bring them level (git pull), then run this again. If you submitted this change before, the next run ' +
          'names its pull request. Nothing was written.',
      )
    }
    // What is in flight, read again at the moment of writing (AGENTS.md,
    // Reconciliation) and judged before § 14's table: another person's run of
    // this very change lands on the same branch name under other words, and is
    // named rather than refused as "a different change"; a competing one is
    // refused. Either way nothing is written, here or on GitHub.
    const flight = await inFlightNow(change)
    let beside: readonly InFlightEntry[] = []
    switch (flight.kind) {
      case 'clear':
        break
      case 'same':
        return {
          outcome: 'already-proposed',
          branch: change.branch,
          number: flight.pull.number,
          url: pullRequestUrl(road.repository, flight.pull.number),
          by: flight.pull.by,
        }
      case 'competing':
        return competing(flight.pulls)
      case 'beside':
        beside = flight.pulls
        break
      default: {
        const _exhaustive: never = flight
        return _exhaustive
      }
    }
    const known = await local.recognise(change, base)
    if (known?.outcome === 'refused') return known
    const remote = await remoteOf(change, base, known)
    // The pull requests too, judged as recognition judges them: one closed,
    // merged or opened into another base while the person was confirming is
    // answered as it is, never opened a second time; one open into the base is
    // named, and nothing is written.
    const judged = decided(change, base, remote, await api.pulls(change.branch), known)
    if (judged !== undefined && judged.outcome !== 'pushed-without-pull-request') return judged
    // The bound, checked on the longest body step 11 could build: this one,
    // with the longest note and the longest paragraph of pull requests beside
    // it (each line and its blank line).
    const bare = Buffer.byteLength(textOf(change).body, 'utf8')
    if (bare + Buffer.byteLength(`${LONGEST_NOTE}\n\n${LONGEST_BESIDE}\n\n`, 'utf8') > GITHUB_LIMITS.bodyBytes) {
      return refused(`the pull request's body would be over 1 MiB, more than this build sends. Nothing was written.`)
    }
    switch (remote.kind) {
      case 'other':
        // `decided` refused it already.
        return refused(notOurs(change))
      case 'ours':
        // A push that landed on an earlier run: nothing is written in this
        // clone, and the pull request is the one write left.
        return opened(change, remote.commit, false, remote.olderBase, deadline, beside).catch((error: unknown) => ({
          outcome: 'pushed-without-pull-request' as const,
          branch: change.branch,
          commit: remote.commit,
          reason: `the pull request was not opened: ${reasonOf(error)} Run the same command again to open it.`,
        }))
      case 'absent':
        break
      default: {
        const _exhaustive: never = remote
        return _exhaustive
      }
    }
    if (now() > deadline) return refused(`the submission took longer than ${seconds} s. Nothing was written.`)

    // Step 9: stage 5's branch, as stage 5 cuts it.
    const cut = await local.submit(change, base)
    if (cut.outcome !== 'created' && cut.outcome !== 'already-submitted') return cut
    if (cut.olderBase !== undefined) return refused(stale(change, base, cut.olderBase))
    const kept = change.branch
    let pushed = false
    let onGitHub = false
    try {
      if (now() > deadline) {
        return refused(`the submission took longer than ${seconds} s. ${kept} was cut in this clone and nothing is on GitHub`, kept)
      }
      // Step 10: that very commit, create-only, to the URL the remote printed.
      const sent = await pushChange({
        push,
        request: { url: road.pushUrl, commit: cut.commit, branch: change.branch },
        where,
        readBack: () => readBack(change.branch, cut.commit),
        notOurs: notOurs(change),
      })
      switch (sent.kind) {
        case 'refused':
          return refused(sent.reason, kept)
        case 'ours':
          break
        case 'landed': {
          // Step 11: GitHub shows exactly that commit, or nothing is opened.
          const seen = await readBack(change.branch, cut.commit)
          if (seen === 'other') return refused(notOurs(change), kept)
          if (seen === 'absent') {
            return refused(
              `${change.branch} was pushed, and ${where} does not show it yet. If your git configuration rewrites this ` +
                'URL or your ssh configuration this host, the push went elsewhere; otherwise run the same command ' +
                'again, which opens the pull request once GitHub shows the branch',
              kept,
            )
          }
          pushed = sent.pushed
          break
        }
        default: {
          const _exhaustive: never = sent
          return _exhaustive
        }
      }
      onGitHub = true
      return await opened(change, cut.commit, pushed, undefined, deadline, beside)
    } catch (error) {
      // A run that cut or pushed a branch never ends on a sentence that says
      // nothing was written.
      if (onGitHub) {
        return {
          outcome: 'pushed-without-pull-request',
          branch: change.branch,
          commit: cut.commit,
          reason: `the pull request was not opened: ${reasonOf(error)} Run the same command again to open it.`,
        }
      }
      return refused(`${reasonOf(error)} ${kept} was cut in this clone; run the same command again, which takes it up`, kept)
    }
  }

  return {
    name: 'github',
    repository: local.repository,
    base: () => local.base(),
    diverges: (base, expected) => local.diverges(base, expected),
    recognise,
    submit,
    inFlight,
  }
}
