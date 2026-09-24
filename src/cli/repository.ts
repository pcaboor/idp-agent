import { stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * A `--repo` that names no directory. The user's argument, so exit 2 — thrown
 * and turned into a code in `cli/index.ts`, the way `PlanInputError` is.
 */
export class RepositoryArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryArgumentError'
  }
}

/** The commands whose `--repo` names the declarations repository. */
export type DeclarationsCommand = 'plan' | 'graph' | 'show' | 'ask'

/**
 * The declarations repository a `--repo` names, as an absolute directory — the
 * one guard `plan`, `ask`, `graph` and `show` share, so the four refuse the
 * same argument in the same words.
 *
 * `readRepository` swallows a failed `readdir` and returns an empty snapshot,
 * which is right for a repository holding an empty folder and wrong for a path
 * that is not there: a preview against nothing would look like a clean creation
 * of everything, and a read against nothing like an SI with no entity in it.
 *
 * The refusal names the path as typed and what the flag means, because the two
 * `--repo` flags name different repositories and pointing one at the other is
 * the commonest way to get here.
 *
 * An empty value is refused before it is resolved, because resolving it gives
 * back the working directory — a directory, so the guard would pass. That is
 * `--repo "$IAC"` with the variable unset, and reading wherever the command
 * happens to run as the declarations repository is the wrong answer to it.
 */
export async function declarationsRoot(
  command: DeclarationsCommand,
  repo: string,
  cwd: string = process.cwd(),
): Promise<string> {
  if (repo.trim() === '') {
    throw new RepositoryArgumentError(
      `--repo is empty; ${command} --repo names the declarations repository`,
    )
  }
  const root = path.resolve(cwd, repo)
  const stats = await stat(root).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new RepositoryArgumentError(
      `${repo} is not a directory; ${command} --repo names the declarations repository`,
    )
  }
  return root
}
