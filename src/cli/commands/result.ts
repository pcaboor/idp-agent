/**
 * What a command produced, and whether it resolved what was asked for. The
 * commands state the fact; only `cli/index.ts` turns it into an exit code, so
 * a command stays testable without a process.
 */
export interface CommandResult {
  text: string
  /**
   * The answer is positive. For a query, something matched; for a command that
   * inspects, the subject conforms. False becomes exit 1 — a negative answer,
   * not a failure of the tool.
   */
  found: boolean
  /**
   * The request was understood, and this build will not act on it. Distinct
   * from `found: false`, which means the graph was asked and answered nothing.
   * Writing arrives at stage 5 and turns this branch into a plan.
   */
  unsupported?: boolean
}
