/**
 * What a command produced, and whether it resolved what was asked for. The
 * commands state the fact; only `cli/index.ts` turns it into an exit code, so
 * a command stays testable without a process.
 */
export interface CommandResult {
  text: string
  found: boolean
}
