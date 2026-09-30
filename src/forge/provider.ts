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

export type Submitted =
  | { readonly outcome: 'created'; readonly branch: string; readonly commit: string }
  /** The same bytes, already submitted on this base: the branch is named and nothing is written (§9.2). */
  | { readonly outcome: 'already-submitted'; readonly branch: string; readonly commit: string }
  /** No edit changes a byte: no branch, no commit. */
  | { readonly outcome: 'unchanged' }
  /**
   * Refused at the moment of acting. Nothing observable was written. `reason`
   * names paths and branches read from the repository — its own content, which
   * may hold a control or bidi character — so `cli/` prints it through
   * `inertLine`, as it does `GitError.stderr`.
   */
  | { readonly outcome: 'refused'; readonly reason: string }

/** What a look at the branch, before any write, can say of it. */
export type Recognised = Extract<Submitted, { readonly outcome: 'already-submitted' | 'refused' }>

/**
 * A forge can do four things, one of them a write, and the absences are the design (ADR-0006,
 * ADR-0010).
 *
 * No `merge`: the merge is the act of authorisation, and a tool that could
 * perform it would make that sentence a matter of not calling a method. There
 * is no method. Stage 6's negative test calls the forge's merge endpoint
 * directly with the token this interface holds, and requires it to FAIL.
 *
 * No `delete`, no push to a base, no way to name the branch: `submit` takes a
 * `Cleared`, whose branch the engine computed from its bytes, and creates it —
 * it can never move a ref that exists, `main` included.
 *
 * Opened for ONE repository (check §5): a clearance of the other is refused
 * before anything else.
 */
export interface ForgeProvider {
  readonly name: 'local'
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
   * `refused` when it is somebody else's, `undefined` when there is none. It
   * writes no object and no ref, so a run can answer a second submission
   * before anyone is asked to confirm it; `submit` checks again at the moment
   * of writing, for the branch created in between.
   */
  recognise(change: Cleared, base: Base): Promise<Recognised | undefined>
  /** Re-reads the base, re-checks divergence, then creates one branch — or says why not. */
  submit(change: Cleared, base: Base): Promise<Submitted>
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
