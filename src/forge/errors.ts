/**
 * The refusals that are the user's arguments — a repository that is not a
 * working tree's root, a detached HEAD, no `git` on PATH, no committer
 * identity. `cli/index.ts` turns them into exit 2, as it does
 * `PlanInputError`.
 */
export class ForgeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForgeInputError'
  }
}
