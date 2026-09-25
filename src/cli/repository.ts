import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { DECLARATION_ROOTS, isDeclarationsRepository } from '../context/iac-fs/snapshot.js'
import { oneLine } from './render/plain.js'

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
  /** Asked for only when `repo` is relative: see `applicationRoot`. */
  cwd: string | (() => string) = () => process.cwd(),
): Promise<string> {
  if (repo.trim() === '') {
    throw new RepositoryArgumentError(
      `--repo is empty; ${command} --repo names the declarations repository`,
    )
  }
  const root = path.isAbsolute(repo)
    ? path.resolve(repo)
    : path.resolve(typeof cwd === 'string' ? cwd : cwd(), repo)
  const stats = await stat(root).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new RepositoryArgumentError(
      `${repo} is not a directory; ${command} --repo names the declarations repository`,
    )
  }
  return root
}

/**
 * The two repositories `plan "<intent>"` reads, as absolute directories: the
 * declarations repository `--repo` names, and the application repository the
 * Inspector reads — the one `--project` names, or the working directory — and
 * never a declarations repository.
 *
 * The run this exists for: standing in his declarations repository, somebody
 * typed `plan "<intent>" --repo .`. Both directories were the same one, the
 * Inspector read the declarations repository as if it were the service's —
 * eight files, and a "name" it had to correct — and the Architect drafted from
 * that. Nothing refused it, because nothing asked which directory was which.
 * So three things are refused here, each exit 2, each before a model is chosen:
 *
 *   - a directory whose root carries the markers `init platform` writes
 *     (`isDeclarationsRepository`, which looks there and never walks);
 *   - the directory `--repo` names, compared by real path, so `.`, a trailing
 *     slash or a symbolic link does not make one directory two. A declarations
 *     repository nobody scaffolded carries no marker, and this is what still
 *     catches it; and
 *   - a folder under that directory's `catalog/` or `dependencies/`: the same
 *     run one `cd` deeper, told by the two real paths alone.
 *
 * `--repo` is checked first, by the guard every command shares, because the
 * comparison needs it — and because it is an argument too, and an argument is
 * refused before the configuration is read (`cli/index.ts`). The one returned
 * is the one `runIntent` reads, so the directory compared is the directory
 * read.
 *
 * The working directory is asked for only when a path is relative or
 * `--project` is absent: a shell can stand in a directory since removed, where
 * `process.cwd()` throws, and two absolute paths need none.
 *
 * What this does NOT refuse: any other folder inside the declarations
 * repository, or one holding it. A monorepo that keeps its declarations beside
 * its services is a real layout, and `services/billing-api` is a service's.
 */
export async function applicationRoot(options: {
  readonly repo: string
  /** As typed. Absent means the directory the user is standing in (§7.4, step 3). */
  readonly project: string | undefined
  readonly cwd: () => string
}): Promise<{ readonly repo: string; readonly project: string }> {
  const here = (): string => {
    try {
      return options.cwd()
    } catch {
      throw new RepositoryArgumentError(
        'the working directory no longer exists; name both repositories by absolute path, ' +
          '--repo <dir> and --project <dir>',
      )
    }
  }
  const repo = await declarationsRoot('plan', options.repo, here)
  // Refused before it is resolved, for the reason `declarationsRoot` gives:
  // `--project "$SERVICE"` with the variable unset is the working directory,
  // which is the directory the flag was typed to avoid.
  if (options.project?.trim() === '') {
    throw new RepositoryArgumentError(`--project is empty; ${PROJECT_FLAG}`)
  }
  const root =
    options.project !== undefined && path.isAbsolute(options.project)
      ? path.resolve(options.project)
      : path.resolve(here(), options.project ?? '.')
  const stats = await stat(root).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new RepositoryArgumentError(
      `${options.project ?? root} is not a directory; ${PROJECT_FLAG}`,
    )
  }

  // Named by its folder, flattened: a folder is called whatever someone called
  // it. `cli/index.ts` cleans the whole message again on the way out.
  const folder = oneLine(path.basename(root) || root)
  if (await isDeclarationsRepository(root)) {
    throw new RepositoryArgumentError(
      options.project === undefined
        ? `plan reads the application repository of the service you are declaring, and ${folder} ` +
            "is a declarations repository. Run it from the service's repository, or name it " +
            'with --project <dir>.'
        : `plan --project names the application repository of the service you are declaring, ` +
            `and ${folder} is a declarations repository; --repo names that one.`,
    )
  }
  const [real, declarations] = [await realpath(root), await realpath(repo)]
  if (real === declarations) {
    throw new RepositoryArgumentError(
      `plan would inspect ${folder}, and --repo names the same directory: --repo names the ` +
        "declarations repository, and plan reads the service's own. Run it from the " +
        "service's repository, or name it with --project <dir>.",
    )
  }
  // A prefix test on the two real paths, and nothing read: `relative` climbs
  // out with `..` when the project is not under the repository at all.
  const inside = path.relative(declarations, real).split(path.sep)
  if (DECLARATION_ROOTS.some((name) => name === inside[0])) {
    const where = [path.basename(declarations) || declarations, ...inside].map((segment) =>
      oneLine(segment),
    )
    throw new RepositoryArgumentError(
      `plan reads the application repository of the service you are declaring, and ` +
        `${where.join('/')} is where the declarations repository --repo names keeps its ` +
        "declarations. Run it from the service's repository, or name it with --project <dir>.",
    )
  }
  return { repo, project: root }
}

const PROJECT_FLAG =
  'plan --project names the application repository the Inspector reads, the service being declared'
