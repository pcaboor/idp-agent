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
  /** Refused at the moment of acting. Nothing observable was written. */
  | { readonly outcome: 'refused'; readonly reason: string }

/**
 * A forge can do three things, and the absences are the design (ADR-0006,
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
  /** Each way the base differs from what the gates judged, as a sentence. Empty: it does not. */
  diverges(base: Base, expected: Expectation): Promise<readonly string[]>
  /** Re-reads the base, re-checks divergence, then creates one branch — or says why not. */
  submit(change: Cleared, base: Base): Promise<Submitted>
}
