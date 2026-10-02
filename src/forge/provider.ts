import type { InFlightEntry, InFlightVerdict } from '../core/github/in-flight.js'
import type { MergeNote, Missing } from '../core/github/protection.js'
import type { GitHubRepository } from '../core/github/remote.js'
import type { Cleared, Expectation, Repository } from '../core/plan/clear.js'

/**
 * Where a submission is cut from, and where a merge request will point.
 *
 * Types only, like `llm/client.ts`, and for the same reason: another layer
 * may name a forge's shapes without being able to call one — the
 * architecture test "only cli/ reaches forge/ at runtime" holds that line.
 */
export interface Base {
  /** The branch HEAD names — `main`, not `refs/heads/main`. */
  readonly branch: string
  readonly commit: string
}

/**
 * A pull request on GitHub, as the engine names it: the host and the
 * repository parsed from the remote, the number GitHub answered, and a URL
 * built from those three (`pullRequestUrl`), never GitHub's `html_url`.
 * `opened`: this run opened it; `open`: it was open already.
 */
export interface PullRequest {
  readonly host: 'github.com'
  /** `acme/iac`: the host is its own field. */
  readonly repository: string
  readonly number: number
  readonly url: string
  readonly state: 'opened' | 'open'
  readonly base: string
}

export type Submitted =
  | {
      readonly outcome: 'created'
      readonly branch: string
      readonly commit: string
      /** Whether THIS run pushed the branch. Absent on the local forge. */
      readonly pushed?: boolean
      readonly pullRequest?: PullRequest
      /** The parent, when it is an ancestor of the base and not the base (stage 6 brief § 14). */
      readonly olderBase?: string
      /** The contexts the rules read before the pull request require, for the closing line (§ 11). */
      readonly statusChecks?: readonly string[]
      /** The note step 11's read called for: the body carries it, and the CLI says its line if the preflight did not. */
      readonly note?: MergeNote
      /** What step 11's read found missing, set with `note`: the `base-unguarded` line names the rules among them. */
      readonly missing?: readonly Missing[]
      /**
       * The idp-agent pull requests in flight beside it, on other files of the
       * same entities, as step 8 judged them: the body names them by number
       * (Task 6.3.6). Each pull request's author, branch and patch are for the
       * CLI's stderr lines; the report and the statuses drop them.
       */
      readonly beside?: readonly InFlightEntry[]
    }
  /** The same bytes, already submitted on this base: the branch is named and nothing is written (§9.2). */
  | {
      readonly outcome: 'already-submitted'
      readonly branch: string
      readonly commit: string
      readonly pushed?: boolean
      readonly pullRequest?: PullRequest
      readonly olderBase?: string
    }
  /** No edit changes a byte: no branch, no commit. */
  | { readonly outcome: 'unchanged' }
  /**
   * Refused at the moment of acting. Nothing observable was written, but for
   * `kept`: the local branch a refusal after it was cut leaves in the clone,
   * which the same command, run again, takes up. `reason` names paths and
   * branches read from the repository — its own content, which may hold a
   * control or bidi character — so `cli/` prints it through `inertLine`, as it
   * does `GitError.stderr`.
   */
  | {
      readonly outcome: 'refused'
      readonly reason: string
      readonly kept?: string
      /**
       * Refused because an idp-agent pull request in flight already changes a
       * file this change writes, differently: each, with the paths of this
       * change it changes, for the CLI to show (Task 6.3.6).
       */
      readonly inFlight?: readonly InFlightEntry[]
    }
  /**
   * The same bytes, already proposed by another account's pull request in
   * flight: named, and nothing is written on either side (the owner's decision
   * of 2026-10-01). `by` is that pull request's author, for stderr alone.
   */
  | {
      readonly outcome: 'already-proposed'
      readonly branch: string
      readonly number: number
      readonly url: string
      readonly by: string
    }
  /**
   * Our branch is on GitHub and no pull request is open from it. Recognised,
   * it is a submission an earlier run stopped at step 12, which `submit`
   * completes; answered by `submit`, this run stopped there (exit 1), and
   * `reason` says why and that running it again opens it. The GitHub forge's
   * alone.
   */
  | {
      readonly outcome: 'pushed-without-pull-request'
      readonly branch: string
      readonly commit: string
      readonly reason: string
    }
  /** A pull request from this branch was closed (`merged` or not) on `at`: never reopened by this tool. */
  | {
      readonly outcome: 'closed'
      readonly branch: string
      readonly number: number
      readonly merged: boolean
      /** The day it was merged or closed, `YYYY-MM-DD`, as GitHub dated it. */
      readonly at: string
    }

/** What a look at the branch, before any write, can say of it. */
export type Recognised = Extract<
  Submitted,
  { readonly outcome: 'already-submitted' | 'refused' | 'pushed-without-pull-request' | 'closed' }
>

/**
 * A forge can do four things, one of them a write, and the absences are the design (ADR-0006,
 * ADR-0010); on GitHub a fifth, a read of what is in flight (Task 6.3.6).
 *
 * No `merge`: the merge is the act of authorisation, and a tool that could
 * perform it would make that sentence a matter of not calling a method. There
 * is no method, and the interface holds no credential: the person's git pushes
 * and the person's gh reads and opens. `tests/unit/merge-refused.test.ts` tries
 * every door as the identity that opened the pull request, against the fake gh,
 * and requires each to FAIL; the owner's live test does the same on GitHub.
 *
 * No `delete`, no approval, no close, no push to a base, no way to name the
 * branch: `submit` takes a `Cleared`, whose branch the engine computed from its
 * bytes, and creates it — it can never move a ref that exists, `main`
 * included, here or on GitHub (`tests/unit/forge-types.test.ts`).
 *
 * Opened for ONE repository (check §5): a clearance of the other is refused
 * before anything else.
 */
export interface ForgeProvider {
  /** `local`: stage 5's branch in a clone. `github`: that branch, pushed, and a pull request (stage 6). */
  readonly name: 'local' | 'github'
  readonly repository: Repository
  /** HEAD as a branch and a commit. Refuses a detached or unborn HEAD. */
  base(): Promise<Base>
  /**
   * Each way the base differs from what the gates judged, as a sentence. Empty: it does not.
   * A sentence names paths the repository holds: `cli/` prints it through `inertLine`.
   */
  diverges(base: Base, expected: Expectation): Promise<readonly string[]>
  /**
   * Read-only: is the branch this change names already there? `already-submitted`
   * when it is exactly this change — the test `submit` makes, the same code —
   * `refused` when it is somebody else's, `undefined` when there is none; on
   * GitHub also `pushed-without-pull-request` and `closed`. It writes no object
   * and no ref, and opens nothing, so a run can answer a second submission
   * before anyone is asked to confirm it; `submit` checks again at the moment
   * of writing, for the branch created in between.
   */
  recognise(change: Cleared, base: Base): Promise<Recognised | undefined>
  /** Re-reads the base, re-checks divergence, then creates one branch — or says why not. */
  submit(change: Cleared, base: Base): Promise<Submitted>
  /**
   * What is in flight, judged for a change (the GitHub forge's; the local
   * forge has none): the open idp-agent pull requests into the base, read once
   * per forge, then answered from what was read. `after` is an edit's bytes,
   * hashed by the forge to the blob id GitHub reports; absent when the bytes
   * are not drafted yet (`init`, before the model). Reads only. `submit` reads
   * again at step 8 on its own.
   */
  readonly inFlight?: (target: {
    readonly writes: readonly { readonly path: string; readonly after?: string }[]
    readonly related: readonly string[]
    readonly branch?: string
  }) => Promise<InFlightVerdict>
}

/**
 * The road a submission takes, decided once, before anything is read on
 * GitHub (stage 6 brief § 13), by `forge/github/road.ts`'s `readRoad`: the
 * branch HEAD names tracks a branch on github.com, or it does not.
 */
export type Road = GitHubRoad | LocalRoad

/**
 * The checked-out branch tracks a branch on github.com, both of its remote's
 * URLs name the same repository, and the clone's own configuration sets no
 * key that could redirect the push or run a program during it (§ 7).
 */
export interface GitHubRoad {
  readonly kind: 'github'
  readonly repository: GitHubRepository
  /** The remote the branch tracks, `origin` usually: named in sentences, never pushed to by name. */
  readonly remote: string
  /** The branch on GitHub a pull request goes into: what `branch.<branch>.merge` names. */
  readonly base: string
  /** The checked-out branch, whose upstream `base` is. */
  readonly branch: string
  /** The URL `git remote get-url --push` printed, one of `GITHUB_PUSH_URL`'s forms: what the push names. */
  readonly pushUrl: string
}

/**
 * The local branch only, as stage 5, and why: the branch tracks nothing, its
 * remote is on another host (`this machine` for a path), or `--local` asked.
 */
export type LocalRoad =
  | { readonly kind: 'local'; readonly why: 'no-upstream'; readonly branch: string }
  | { readonly kind: 'local'; readonly why: 'other-host'; readonly host: string }
  | { readonly kind: 'local'; readonly why: 'asked' }

/**
 * Who gh acts as on github.com: a person, by GitHub's own answer (§ 5). The
 * role is `undefined` out of `readIdentity`, which spends the two gh calls §
 * 15 gives the identity on the version and `/user`; the preflight reads it
 * from the repository's `permissions` (stage 6 plan, Task 6.1.3).
 */
export interface GhIdentity {
  readonly login: string
  readonly role: 'admin' | 'maintain' | 'write' | undefined
}
