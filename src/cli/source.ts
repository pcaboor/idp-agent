import { stat } from 'node:fs/promises'
import path from 'node:path'
import { isDeclarationsRepository } from '../context/iac-fs/snapshot.js'
import {
  expandHome,
  flat,
  pathOf,
  personalConfigFile,
  readPersonalConfig,
  shownPath,
  type Env,
} from './personal.js'
import { oneLine } from './render/plain.js'
import { RepositoryArgumentError, declarationsRoot, type DeclarationsCommand } from './repository.js'

/**
 * Where the SI a command reads comes from, decided once, here, for `graph`,
 * `show`, `ask` and `plan` alike.
 *
 * The project has two uses: `init platform` creates the declarations
 * repository once, and then the CLI is used from anywhere to question it — not
 * only from inside it. `--repo` on every command, or standing in the
 * repository, was the only way to name it; a configured default is the third,
 * set once in `IDP_REPO` or the personal configuration file (`personal.ts`).
 *
 * A `Source` is a value rather than a provider so that the decision is
 * testable apart from reading, and so that `backstage-http` (design §3) fits
 * as one more variant — `{ kind: 'backstage', url, label, origin }` — with the
 * callers' exhaustive switches the only places that learn about it.
 */

/** The environment variable that names the declarations repository by default. */
export const REPO_VARIABLE = 'IDP_REPO'

/**
 * What named the source — which is also what the user changes to name another.
 * `flag` is `--repo` or `--demo`; `default` is nothing at all, which only the
 * demo SI can be reached by.
 */
export type Origin =
  | { by: 'flag' }
  | { by: 'working-directory' }
  | { by: 'variable'; name: typeof REPO_VARIABLE }
  | { by: 'file'; file: string }
  | { by: 'default' }

/** A declarations repository on disk, read through `iac-fs`. */
export interface RepositorySource {
  readonly kind: 'repo'
  /** Absolute. */
  readonly root: string
  /** Its folder's name — never the path as typed: `--repo .` names nothing. */
  readonly label: string
  readonly origin: Origin
}

/** The fictional SI shipped with the tool. */
export interface DemoSource {
  readonly kind: 'demo'
  readonly label: string
  readonly origin: Origin
}

export type Source = RepositorySource | DemoSource

type ReadCommand = Exclude<DeclarationsCommand, 'plan'>

/** What the command line said. `demo` exists only for the read commands. */
export type SourceRequest =
  | { command: ReadCommand; repo?: string | undefined; demo?: boolean | undefined }
  | { command: 'plan'; repo?: string | undefined }

export interface SourceContext {
  /**
   * The working directory, asked for only on the roads that need it: a shell
   * can stand in a directory since removed, where `process.cwd()` throws, and
   * the demo SI or a configured path — always absolute — needs none.
   */
  readonly cwd: () => string
  /** The environment — `MainDeps.env` in a test, `process.env` in a real run. */
  readonly env: Env
  readonly platform?: NodeJS.Platform
}

/** The demo SI's name wherever one is printed. */
const DEMO_LABEL = 'the demo SI'

/**
 * A repository's name: its folder's. The root of the filesystem has none, so it
 * is its path. `root` is normalised first, by whoever resolved it — `IaC/.`
 * would otherwise be named `.`.
 */
const folderOf = (root: string, p: path.PlatformPath): string => p.basename(root) || root

/**
 * `p` is the host's `path` for what the host handed over — `--repo`, resolved
 * against its working directory, and that directory — and the injected
 * platform's for what the environment names.
 */
const repository = (root: string, origin: Origin, p: path.PlatformPath = path): RepositorySource => ({
  kind: 'repo',
  root,
  label: folderOf(root, p),
  origin,
})

/** The working directory, or none when it has been removed from under the shell. */
const standingIn = (context: SourceContext): string | undefined => {
  try {
    return path.resolve(context.cwd())
  } catch {
    return undefined
  }
}

/**
 * The source a command reads, first match wins.
 *
 * `graph`, `show`, `ask`: `--repo` or `--demo` → the working directory when its
 * markers say it is a declarations repository → `IDP_REPO` → the personal
 * file's `repo` → the demo SI. Always a source.
 *
 * `plan`: the same, bar `--demo` and the demo SI — `--repo` → the working
 * directory when its markers say it is a declarations repository → `IDP_REPO`
 * → the file's `repo` — and `undefined` when none names one: a write preview
 * is decided against a repository, never the demo SI or a catalogue (§4.4).
 * The working directory used to be left out, as the service `plan` declares;
 * it is taken only on its markers, and a service's repository carries none, so
 * `cd IaC && idpa "<intent>"` decides against IaC and a run from the service
 * still reads what is configured. Which directory the Inspector reads is
 * another question, answered by `repository.ts`'s `applicationRoot`.
 *
 * First match wins, so what is not reached is not read: a malformed file
 * cannot refuse a run that `IDP_REPO` or `--repo` already answered. A
 * configured path that is not a directory is refused, exit 2, naming the
 * variable or the file — never answered from the demo SI, because the user
 * asked for that repository. A configured directory with no declarations
 * markers is read all the same, as `--repo` reads one: it was named.
 */
export async function sourceOf(
  request: { command: 'plan'; repo?: string | undefined },
  context: SourceContext,
): Promise<RepositorySource | undefined>
export async function sourceOf(
  request: { command: ReadCommand; repo?: string | undefined; demo?: boolean | undefined },
  context: SourceContext,
): Promise<Source>
export async function sourceOf(
  request: SourceRequest,
  context: SourceContext,
): Promise<Source | undefined> {
  if (request.repo !== undefined) {
    const root = await declarationsRoot(request.command, request.repo, context.cwd())
    return repository(root, { by: 'flag' })
  }
  if (request.command !== 'plan' && request.demo === true) {
    return { kind: 'demo', label: DEMO_LABEL, origin: { by: 'flag' } }
  }
  const root = standingIn(context)
  if (root !== undefined && (await isDeclarationsRepository(root))) {
    return repository(root, { by: 'working-directory' })
  }
  const configured = await configuredRepository(request.command, context)
  if (configured !== undefined) return configured
  return request.command === 'plan'
    ? undefined
    : { kind: 'demo', label: DEMO_LABEL, origin: { by: 'default' } }
}

/** `IDP_REPO`, else the personal file's `repo`, checked to be a directory. */
async function configuredRepository(
  command: DeclarationsCommand,
  context: SourceContext,
): Promise<RepositorySource | undefined> {
  const platform = context.platform ?? process.platform
  const p = pathOf(platform)
  const variable = context.env[REPO_VARIABLE]
  // Empty is unset, as for every IDP_ variable: `IDP_REPO= idpa graph` is how a
  // shell turns it off for one command.
  if (variable !== undefined && variable !== '') {
    const expanded = expandHome(variable, context.env, platform)
    if (expanded === undefined) {
      throw refusal(
        `${REPO_VARIABLE}=${variable} starts with ~, and no home directory is set to expand it against`,
      )
    }
    // Refused rather than resolved against the working directory, for the
    // reason a relative XDG_CONFIG_HOME is ignored: a default set once must
    // name one repository from every directory, and `IDP_REPO=.` would make
    // the service `plan` declares its own declarations repository.
    if (!p.isAbsolute(expanded)) {
      throw refusal(
        `${REPO_VARIABLE}=${variable} is relative; it must be absolute or start with ~, ` +
          'so that it names the same declarations repository from every directory',
      )
    }
    // Normalised, so `IaC/.` is named IaC; an absolute path needs no working directory.
    const root = p.resolve(expanded)
    await mustBeDirectory(
      root,
      `${REPO_VARIABLE}=${variable} is not a directory; ${REPO_VARIABLE} names the declarations repository ${command} reads when no --repo is given`,
    )
    return repository(root, { by: 'variable', name: REPO_VARIABLE }, p)
  }

  const config = await readPersonalConfig(context.env, platform)
  if (config?.repo === undefined) return undefined
  await mustBeDirectory(
    config.repo,
    `${config.shown}: repo ${config.repo} is not a directory; ` +
      `it names the declarations repository ${command} reads when no --repo is given`,
  )
  return repository(config.repo, { by: 'file', file: config.shown }, p)
}

/**
 * Exit 2, in one line: what it quotes is what someone wrote in a variable or a
 * file, escape sequences and line breaks included.
 */
const refusal = (message: string): RepositoryArgumentError =>
  new RepositoryArgumentError(flat(message))

async function mustBeDirectory(root: string, message: string): Promise<void> {
  const stats = await stat(root).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) throw refusal(message)
}

/** Where the personal file would be, as a person reads it — for a sentence that tells them to write one. */
export function personalFileHint(env: Env, platform: NodeJS.Platform = process.platform): string {
  const file = personalConfigFile(env, platform)
  return file === undefined ? '~/.config/idp-agent/config.yml' : shownPath(file, env, platform)
}

/** What named a source, in the words its line on stderr uses. */
export function originText(origin: Origin): string {
  switch (origin.by) {
    case 'flag':
      return 'the command line'
    case 'working-directory':
      return 'the current directory'
    case 'variable':
      return origin.name
    case 'file':
      return origin.file
    case 'default':
      return 'the default'
    default: {
      const exhaustive: never = origin
      return exhaustive
    }
  }
}

/**
 * The repository `ask`'s overview is headed with — its folder — or `undefined`
 * for the demo SI, which the overview does not name. Exhaustive, so a new kind
 * of source is a compile error here rather than an overview naming nothing.
 */
export function overviewName(source: Source): string | undefined {
  switch (source.kind) {
    case 'repo':
      return source.label
    case 'demo':
      return undefined
    default: {
      const exhaustive: never = source
      return exhaustive
    }
  }
}

/**
 * What to blame when the source turns out to declare nothing — the thing the
 * user should look at — or `undefined` when there is nothing to blame: the demo
 * SI declares plenty. Exhaustive for the reason `overviewName` is.
 */
export function blameOf(source: Source): string | undefined {
  switch (source.kind) {
    case 'repo':
      return namedBy(source.origin)
    case 'demo':
      return undefined
    default: {
      const exhaustive: never = source
      return exhaustive
    }
  }
}

/**
 * What named a repository, as a blame. `undefined` for the working directory,
 * which is read because its witnesses say what it is: an empty one is freshly
 * scaffolded, and there is nothing to blame.
 */
function namedBy(origin: Origin): string | undefined {
  switch (origin.by) {
    case 'flag':
      return '--repo'
    case 'variable':
      return origin.name
    case 'file':
      return `repo in ${origin.file}`
    case 'working-directory':
    case 'default':
      return undefined
    default: {
      const exhaustive: never = origin
      return exhaustive
    }
  }
}

/**
 * The one line on stderr that says what is being read, or `undefined` when the
 * user said it themselves with `--repo`.
 *
 * Every other road is said: an answer about an invented company that does not
 * say it is invented is read as one about the user's own, and an answer about a
 * configured repository, or the directory someone stands in, as one about the
 * demo they expected. The folder and what named it, both — the second is what
 * the user changes to read another. Flattened: a folder's name, and a file's
 * path, are whatever someone called them, escape sequences included.
 *
 * A phrase's line is said before the Supervisor has decided which road it
 * takes, so its `--demo` is named for the one road that takes it: a change is
 * never previewed against the demo SI.
 */
export function sourceNotice(
  command: DeclarationsCommand,
  source: Source,
  context: Pick<SourceContext, 'env' | 'platform'>,
): string | undefined {
  switch (source.kind) {
    case 'repo': {
      if (source.origin.by === 'flag') return undefined
      const alternatives =
        command === 'plan'
          ? '--repo <directory> decides against another'
          : command === 'idpa'
            ? '--repo <directory> reads another, --demo the fictional SI for a question'
            : '--repo <directory> reads another, --demo the fictional SI'
      return (
        `reading the declarations repository ${oneLine(source.label)} ` +
        `(${oneLine(originText(source.origin))}); ${alternatives}`
      )
    }
    case 'demo': {
      const own = 'pass --repo <directory> to read your own declarations repository'
      if (source.origin.by === 'flag') return `reading the demo SI, a fictional company; ${own}`
      const file = oneLine(personalFileHint(context.env, context.platform))
      return (
        `reading the demo SI, a fictional company; ${own}, ` +
        `or set ${REPO_VARIABLE} or repo in ${file} to make it the default`
      )
    }
    default: {
      const exhaustive: never = source
      return exhaustive
    }
  }
}

/**
 * The declarations repository a change is previewed against, or `undefined`
 * when the source is none: the demo SI is a catalogue to question, never a
 * repository to decide a write against (§4.4). Exhaustive, for the reason
 * `overviewName` is — a Backstage source is not one either.
 */
export function declarationsOf(source: Source): RepositorySource | undefined {
  switch (source.kind) {
    case 'repo':
      return source
    case 'demo':
      return undefined
    default: {
      const exhaustive: never = source
      return exhaustive
    }
  }
}

/**
 * Why a change is refused when nothing names a declarations repository: every
 * way of naming one, in the order they are tried. `who` is what asked —
 * `plan`, or the phrase the Supervisor classified as a change.
 */
export function planNeedsRepository(
  context: Pick<SourceContext, 'env' | 'platform'>,
  who = 'plan',
): string {
  const file = flat(personalFileHint(context.env, context.platform))
  return (
    `${who} needs a declarations repository: --repo <directory>, the current directory ` +
    `when it is one, or ${REPO_VARIABLE} or repo in ${file} set once; ` +
    'a write preview is decided against the repository, never against the catalogue'
  )
}
