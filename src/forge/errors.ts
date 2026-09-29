/**
 * The refusals that are the user's arguments — a repository that is not a
 * working tree's root, a detached HEAD, no `git` on PATH, no committer
 * identity. `cli/index.ts` will turn them into exit 2, the way it already
 * does `PlanInputError`, once `--submit` exists (stage 5, task 5).
 */
export class ForgeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForgeInputError'
  }
}
