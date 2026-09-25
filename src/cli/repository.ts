import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  DECLARATION_ROOTS,
  isApplicationRepository,
  isDeclarationsRepository,
} from '../context/iac-fs/snapshot.js'
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

/**
 * The commands whose `--repo` names the declarations repository, as their
 * refusals name them: `idpa` is the phrase, `idpa "<phrase>"`, which is typed
 * with no command word and is told so in none.
 */
export type DeclarationsCommand = 'plan' | 'graph' | 'show' | 'ask' | 'idpa'

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
 * What the Inspector reads on a `plan "<intent>"` run: the application
 * repository at `root`, or none — and then `reason`, the parenthesis of the
 * one line on stderr that says so (`skipNotice`).
 */
export type Inspection =
  | { readonly kind: 'project'; readonly root: string }
  | { readonly kind: 'none'; readonly reason: string }

/** What asked for a change's repositories, as its refusals name it. */
export type ChangeCommand = 'plan' | 'idpa'

/**
 * The two repositories `plan "<intent>"` reads, as absolute directories: the
 * declarations repository `--repo` names, and the application repository the
 * Inspector reads — the one `--project` names, the working directory when it
 * is one, or none.
 *
 * The run this exists for: standing in his declarations repository, somebody
 * typed `plan "<intent>" --repo .`. Both directories were the same one, the
 * Inspector read the declarations repository as if it were the service's —
 * eight files, and a "name" it had to correct — and the Architect drafted from
 * that. Nothing refused it, because nothing asked which directory was which.
 *
 * **`--project` given** is an argument, and three things are refused, each
 * exit 2, each before a model is chosen:
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
 * **No `--project`** refuses nothing: `idpa` is typed from anywhere, and the
 * directory it is typed in is not an argument. It is inspected only when it is
 * an application repository by its markers (`isApplicationRepository`), lies
 * nowhere in the declarations repository, and is neither the home directory
 * nor the filesystem root; otherwise the Inspector is skipped, and the reason
 * comes back to be said. The Architect then drafts from the catalogue alone,
 * told that nothing was inspected — which is what running from inside the
 * declarations repository, the owner's run, now does.
 *
 * `--repo` is checked first, by the guard every command shares, because the
 * comparison needs it — and because it is an argument too, and an argument is
 * refused before the configuration is read (`cli/index.ts`). The one returned
 * is the one `runIntent` reads, so the directory compared is the directory
 * read.
 *
 * The working directory is asked for only when a path is relative or
 * `--project` is absent: a shell can stand in a directory since removed, where
 * `process.cwd()` throws, and two absolute paths need none. Gone, it holds no
 * application repository.
 *
 * What `--project` is NOT refused for: any other folder inside the
 * declarations repository, or one holding it. A monorepo that keeps its
 * declarations beside its services is a real layout, and `services/billing-api`
 * is a service's — named, because standing in it is not enough.
 */
export async function applicationRoot(options: {
  /** Named in the refusals: `plan`, or `idpa` for a phrase. */
  readonly who: ChangeCommand
  readonly repo: string
  /** As typed. Absent means the directory the user is standing in, if it is a service's. */
  readonly project: string | undefined
  readonly cwd: () => string
  /** The home directory the environment names (`personal.ts`'s `homeOf`), never inspected unasked. */
  readonly home: string | undefined
}): Promise<{ readonly repo: string; readonly project: Inspection }> {
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
  const { who } = options
  const repo = await declarationsRoot(who, options.repo, here)
  if (options.project === undefined) {
    return { repo, project: await standingIn(repo, options.cwd, options.home) }
  }

  const root = await projectRoot(who, options.project, here)
  const inside = await declaredIn(repo, root)
  if (inside === 'same') {
    throw new RepositoryArgumentError(
      `${who} would inspect ${folderOf(root)}, and --repo names the same directory: --repo ` +
        `names the declarations repository, and ${who} reads the service's own. Run it from ` +
        "the service's repository, or name it with --project <dir>.",
    )
  }
  if (inside !== undefined) {
    throw new RepositoryArgumentError(
      `${who} reads the application repository of the service you are declaring, and ` +
        `${inside} is where the declarations repository --repo names keeps its ` +
        "declarations. Run it from the service's repository, or name it with --project <dir>.",
    )
  }
  return { repo, project: { kind: 'project', root } }
}

/**
 * The directory `--project` names, absolute, refused for what it is on its own
 * — empty, no directory, a declarations repository — and never for where it
 * sits: that needs a declarations repository to compare it with
 * (`applicationRoot`). Exported for the phrase, which has none to compare with
 * when it reads the demo SI, and still refuses a bad `--project` before a model
 * is chosen rather than only when the Supervisor says it is a change.
 */
export async function projectRoot(
  who: ChangeCommand,
  project: string,
  cwd: () => string,
): Promise<string> {
  const flag = projectFlag(who)
  // Refused before it is resolved, for the reason `declarationsRoot` gives:
  // `--project "$SERVICE"` with the variable unset is the working directory,
  // which is the directory the flag was typed to avoid.
  if (project.trim() === '') throw new RepositoryArgumentError(`--project is empty; ${flag}`)
  const root = path.isAbsolute(project) ? path.resolve(project) : path.resolve(cwd(), project)
  const stats = await stat(root).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new RepositoryArgumentError(`${project} is not a directory; ${flag}`)
  }
  // Named by its folder, flattened: a folder is called whatever someone called
  // it. `cli/index.ts` cleans the whole message again on the way out.
  if (await isDeclarationsRepository(root)) {
    throw new RepositoryArgumentError(
      `${who} --project names the application repository of the service you are declaring, ` +
        `and ${folderOf(root)} is a declarations repository; --repo names that one.`,
    )
  }
  return root
}

/**
 * The working directory as the Inspector's input: inspected when it is a
 * service's repository, skipped with the reason otherwise. The same three
 * directories `--project` is refused for are skipped here, in the same order,
 * and more, because standing somewhere is not naming it:
 *
 *   - any other folder of the declarations repository — `IaC/scripts` with a
 *     package.json of its own is the repository's tooling, not the service; a
 *     monorepo's service is named with `--project`;
 *   - the home directory and the filesystem root, whatever they hold. A
 *     terminal opens in `~`, a stray `npm i` leaves a package.json there, and
 *     the Inspector would be handed a listing of someone's home and the text
 *     of their documents;
 *   - a directory with no marker of a service at its root.
 */
async function standingIn(
  repo: string,
  cwd: () => string,
  home: string | undefined,
): Promise<Inspection> {
  let root: string
  try {
    root = path.resolve(cwd())
  } catch {
    return { kind: 'none', reason: 'it no longer exists' }
  }
  const folder = folderOf(root)
  if (await isDeclarationsRepository(root)) {
    return { kind: 'none', reason: `${folder} is a declarations repository` }
  }
  const inside = await declaredIn(repo, root)
  if (inside === 'same') return { kind: 'none', reason: `${folder} is the declarations repository` }
  if (inside !== undefined) {
    return {
      kind: 'none',
      reason: `${inside} is where the declarations repository keeps its declarations`,
    }
  }
  const within = await under(repo, root)
  if (within !== undefined) {
    return { kind: 'none', reason: `${within} is inside the declarations repository` }
  }
  const real = await realpath(root)
  if (path.parse(real).root === real) {
    return { kind: 'none', reason: `${oneLine(real)} is the filesystem root` }
  }
  if (home !== undefined && real === (await realpath(home).catch(() => undefined))) {
    return { kind: 'none', reason: `${folder} is your home directory` }
  }
  if (!(await isApplicationRepository(root))) {
    return {
      kind: 'none',
      reason: `${folder} holds no catalog-info.yaml or package manifest at its root`,
    }
  }
  return { kind: 'project', root }
}

/** A directory's name as a line may quote it: its folder, flattened. */
const folderOf = (root: string): string => oneLine(path.basename(root) || root)

/**
 * Where `root` sits against the declarations repository `repo`, both by real
 * path: `same` directory, the `IaC/catalog/…` it is under one of its
 * declaration roots as, or `undefined` for anywhere else.
 *
 * A prefix test on the two real paths, and nothing read: `relative` climbs
 * out with `..` when the project is not under the repository at all.
 */
async function declaredIn(repo: string, root: string): Promise<'same' | string | undefined> {
  const [real, declarations] = [await realpath(root), await realpath(repo)]
  if (real === declarations) return 'same'
  const inside = path.relative(declarations, real).split(path.sep)
  if (!DECLARATION_ROOTS.some((name) => name === inside[0])) return undefined
  return [path.basename(declarations) || declarations, ...inside]
    .map((segment) => oneLine(segment))
    .join('/')
}

/**
 * `root` as `IaC/scripts` when it lies anywhere under the declarations
 * repository `repo`, both by real path, or `undefined`. `declaredIn` has
 * already answered for the repository itself and its declaration folders.
 */
async function under(repo: string, root: string): Promise<string | undefined> {
  const [real, declarations] = [await realpath(root), await realpath(repo)]
  const inside = path.relative(declarations, real)
  const climbs = inside === '..' || inside.startsWith(`..${path.sep}`)
  if (inside === '' || climbs || path.isAbsolute(inside)) return undefined
  return [path.basename(declarations) || declarations, ...inside.split(path.sep)]
    .map((segment) => oneLine(segment))
    .join('/')
}

/**
 * The line on stderr that says the Inspector was skipped, and why: one line,
 * and the flag that inspects a service instead.
 */
export const skipNotice = (reason: string): string =>
  `no application repository in the current directory (${reason}); drafting from the ` +
  'catalogue alone — --project <dir> inspects a service'

const projectFlag = (who: ChangeCommand): string =>
  `${who} --project names the application repository the Inspector reads, the service being declared`
