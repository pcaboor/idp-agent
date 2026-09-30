import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  BACKSTAGE_TOKEN_VARIABLE,
  headerCarries,
  isLoopback,
  type CatalogueFailure,
  type CatalogueReadError,
} from '../context/backstage/transport.js'
import { isDeclarationsRepository } from '../context/iac-fs/snapshot.js'
import type { Census } from '../context/provider.js'
import {
  CACHE_VARIABLE,
  expandHome,
  flat,
  pathOf,
  personalConfigFile,
  readPersonalConfig,
  shownPath,
  type CacheRoot,
  type Env,
  type PersonalConfig,
} from './personal.js'
import { ageWords } from './render/catalogue-read.js'
import type { OverviewSource } from './render/overview.js'
import { oneLine } from './render/plain.js'
import { RepositoryArgumentError, declarationsRoot, type DeclarationsCommand } from './repository.js'

/** Why no catalogue read is kept on this run (`cacheRootOf`). */
type NoCache = Extract<CacheRoot, { none: unknown }>['none']

/**
 * Where the SI a command reads comes from, decided here for `graph`, `show`,
 * `ask` and `plan` alike — and, for a phrase, what its change is decided
 * against.
 *
 * The project has two uses: `init platform` creates the declarations
 * repository once, and then the CLI is used from anywhere to question it — not
 * only from inside it. `--repo` on every command, or standing in the
 * repository, was the only way to name it; a configured default is the third,
 * set once in `IDP_REPO` or the personal configuration file (`personal.ts`).
 *
 * A `Source` is a value rather than a provider so that the decision is
 * testable apart from reading, and so that a Backstage catalogue
 * (docs/backstage-http-brief.md § 10) is one more variant —
 * `{ kind: 'backstage', url, label, origin }` — with the callers' exhaustive
 * switches the only places that learn about it.
 *
 * A run resolves twice: what it reads (`sourceOf`) and, for a phrase, what a
 * change is decided against (`declarationsFor`). Both walk one chain; a
 * catalogue answers the first ahead of IDP_REPO and the file's repo, and
 * never the second.
 */

/** The environment variable that names the declarations repository by default. */
export const REPO_VARIABLE = 'IDP_REPO'

/**
 * The environment variable that names a Backstage catalogue API's base. Its
 * token is `IDP_BACKSTAGE_TOKEN` (`BACKSTAGE_TOKEN_VARIABLE`), whose presence
 * is checked here and whose value only `cli/index.ts` reads.
 */
export const BACKSTAGE_URL_VARIABLE = 'IDP_BACKSTAGE_URL'

/**
 * What named the source — which is also what the user changes to name another.
 * `flag` is `--repo` or `--demo`; `default` is nothing at all, which only the
 * demo SI can be reached by. A catalogue `--backstage` chose is named by where
 * its URL came from, never by the flag: that is the setting a person fixes.
 */
export type Origin =
  | { by: 'flag' }
  | { by: 'working-directory' }
  | { by: 'variable'; name: typeof REPO_VARIABLE | typeof BACKSTAGE_URL_VARIABLE }
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

/**
 * A Backstage catalogue, read over HTTP for a question and never for a change
 * (docs/backstage-http-brief.md § 3). It carries no token: the token's
 * presence is checked when the source is resolved, and its value is read by
 * `cli/index.ts` alone, from the same environment.
 */
export interface BackstageSource {
  readonly kind: 'backstage'
  /** The catalogue API's base, checked (`catalogueBase`). Never printed whole: the notice names the host. */
  readonly url: string
  /** The host and port, flattened. */
  readonly label: string
  /** Where the URL came from: `IDP_BACKSTAGE_URL` or the file, also when `--backstage` chose it. */
  readonly origin: Extract<Origin, { by: 'variable' } | { by: 'file' }>
}

export type Source = RepositorySource | DemoSource | BackstageSource

type ReadCommand = Exclude<DeclarationsCommand, 'plan'>

/** What the command line said. `demo` and `backstage` exist only for the read commands. */
export type SourceRequest =
  | {
      command: ReadCommand
      repo?: string | undefined
      demo?: boolean | undefined
      backstage?: boolean | undefined
    }
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
 * `graph`, `show`, `relations`, `ask` and a phrase: `--repo`, `--demo` or
 * `--backstage` → the working directory when its markers say it is a
 * declarations repository → `IDP_BACKSTAGE_URL` → `IDP_REPO` → the personal
 * file's `backstage` → its `repo` → the demo SI. Always a source. At each
 * level a catalogue beats a repository: a person who names both has named the
 * catalogue for reading and the repository for deciding (brief § 10).
 * `--backstage` reads the configured catalogue — the variable, else the file
 * — and is refused when none is: it takes no value, because a URL typed on a
 * command line would send the configured token to whatever was typed.
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
 * cannot refuse a run that `IDP_REPO`, `IDP_BACKSTAGE_URL` or `--repo`
 * already answered, and the file is read once, only when reached. A
 * configured path that is not a directory is refused, exit 2, naming the
 * variable or the file — never answered from the demo SI, because the user
 * asked for that repository. A configured directory with no declarations
 * markers is read all the same, as `--repo` reads one: it was named. A
 * configured catalogue URL is checked before any request (`catalogueBase`),
 * and a host that is not this machine is refused without a token.
 */
export async function sourceOf(
  request: { command: 'plan'; repo?: string | undefined },
  context: SourceContext,
): Promise<RepositorySource | undefined>
export async function sourceOf(
  request: {
    command: ReadCommand
    repo?: string | undefined
    demo?: boolean | undefined
    backstage?: boolean | undefined
  },
  context: SourceContext,
): Promise<Source>
export async function sourceOf(
  request: SourceRequest,
  context: SourceContext,
): Promise<Source | undefined> {
  if (request.command === 'plan') return repositoryChain('plan', request.repo, context, false)
  // `--repo` first, as the chain takes it: the command line refuses two of
  // the three together, and a caller that passes both reads the repository.
  if (request.repo === undefined && request.demo === true) {
    return { kind: 'demo', label: DEMO_LABEL, origin: { by: 'flag' } }
  }
  if (request.repo === undefined && request.backstage === true) return chosenCatalogue(context)
  const found = await repositoryChain(request.command, request.repo, context, true)
  return found ?? { kind: 'demo', label: DEMO_LABEL, origin: { by: 'default' } }
}

/**
 * The declarations repository a phrase's change is decided against: `plan`'s
 * chain — --repo, the working directory on its markers, IDP_REPO, the file's
 * repo — and nothing when --demo was typed. Never derived from what the run
 * reads.
 *
 * With no Backstage configured it is the repository `sourceOf` found for the
 * read, or nothing where the read fell to the demo SI: two walks of one chain
 * over a filesystem that holds still — not one value shared, so markers or a
 * personal file changed between the walks are read as they then are. A
 * catalogue answers the read ahead of IDP_REPO and the file; a change still
 * takes this chain, never the catalogue (backstage-http brief § 3), which is
 * why a broken IDP_REPO or file `repo` is refused here on a question too.
 * `command` is the read command that was typed, so a refusal here names it
 * as the read's does.
 */
export async function declarationsFor(
  request: { command: ReadCommand; repo?: string | undefined; demo?: boolean | undefined },
  context: SourceContext,
): Promise<RepositorySource | undefined> {
  if (request.repo === undefined && request.demo === true) return undefined
  return repositoryChain(request.command, request.repo, context, false)
}

/**
 * The one chain both resolutions walk, first match wins: `--repo`, the working
 * directory when its markers say it is a declarations repository,
 * `IDP_BACKSTAGE_URL` when `catalogue`, `IDP_REPO`, the file's `backstage`
 * when `catalogue`, the file's `repo`. `command` is what a refusal names.
 * `catalogue` is false for what a change is decided against: that chain never
 * holds one.
 */
async function repositoryChain(
  command: DeclarationsCommand,
  repo: string | undefined,
  context: SourceContext,
  catalogue: false,
): Promise<RepositorySource | undefined>
async function repositoryChain(
  command: DeclarationsCommand,
  repo: string | undefined,
  context: SourceContext,
  catalogue: boolean,
): Promise<RepositorySource | BackstageSource | undefined>
async function repositoryChain(
  command: DeclarationsCommand,
  repo: string | undefined,
  context: SourceContext,
  catalogue: boolean,
): Promise<RepositorySource | BackstageSource | undefined> {
  if (repo !== undefined) {
    const root = await declarationsRoot(command, repo, context.cwd())
    return repository(root, { by: 'flag' })
  }
  const root = standingIn(context)
  if (root !== undefined && (await isDeclarationsRepository(root))) {
    return repository(root, { by: 'working-directory' })
  }
  if (catalogue) {
    const url = catalogueVariable(context)
    if (url !== undefined) return url
  }
  const variable = await repositoryVariable(command, context)
  if (variable !== undefined) return variable
  const config = await readPersonalConfig(context.env, context.platform ?? process.platform)
  if (catalogue && config?.backstage !== undefined) return catalogueInFile(config, config.backstage, context)
  return repositoryInFile(command, config, context)
}

/** `IDP_REPO`, checked to be a directory, or `undefined` when it is unset. */
async function repositoryVariable(
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
  return undefined
}

/** The personal file's `repo`, checked to be a directory, or `undefined` when it sets none. */
async function repositoryInFile(
  command: DeclarationsCommand,
  config: PersonalConfig | undefined,
  context: SourceContext,
): Promise<RepositorySource | undefined> {
  const p = pathOf(context.platform ?? process.platform)
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

/** `IDP_BACKSTAGE_URL`, checked, or `undefined` when it is unset. Empty is unset, as for every IDP_ variable. */
function catalogueVariable(context: SourceContext): BackstageSource | undefined {
  const url = context.env[BACKSTAGE_URL_VARIABLE]
  if (url === undefined || url === '') return undefined
  return catalogueAt(url, { by: 'variable', name: BACKSTAGE_URL_VARIABLE }, `${BACKSTAGE_URL_VARIABLE}=`, context)
}

/** The personal file's `backstage`, checked. */
function catalogueInFile(config: PersonalConfig, url: string, context: SourceContext): BackstageSource {
  return catalogueAt(url, { by: 'file', file: config.shown }, `${config.shown}: backstage `, context)
}

/**
 * `--backstage`: the configured catalogue — `IDP_BACKSTAGE_URL`, else the
 * file's `backstage` — ahead of the working directory and every repository,
 * and refused when none is configured. It takes no value (brief § 8).
 */
async function chosenCatalogue(context: SourceContext): Promise<BackstageSource> {
  const variable = catalogueVariable(context)
  if (variable !== undefined) return variable
  const config = await readPersonalConfig(context.env, context.platform ?? process.platform)
  if (config?.backstage !== undefined) return catalogueInFile(config, config.backstage, context)
  const file = personalFileHint(context.env, context.platform)
  throw refusal(
    `--backstage reads the configured catalogue, and none is: set ${BACKSTAGE_URL_VARIABLE}, or backstage in ${file}, ` +
      "to the catalogue API's base, https://<backend host>/api/catalog",
  )
}

/**
 * A catalogue at `raw`, checked, with its token checked too: a host that is
 * not this machine is never read without one (brief § 4), and a token a header
 * cannot carry is a setting to fix, refused here, exit 2, rather than by the
 * transport once the read has begun. Neither refusal quotes the token, and it
 * is not part of the source.
 */
function catalogueAt(
  raw: string,
  origin: BackstageSource['origin'],
  where: string,
  context: SourceContext,
): BackstageSource {
  const base = catalogueBase(raw, where)
  const label = flat(base.host)
  // `off` is the one value, so a typo never keeps what was meant to be kept
  // nowhere; empty is unset, as for every IDP_ variable. Refused here, where a
  // catalogue is resolved: nothing else reads a copy.
  const cache = context.env['IDP_BACKSTAGE_CACHE']
  if (cache !== undefined && cache !== '' && cache !== 'off') {
    throw refusal(
      `${CACHE_VARIABLE}=${cache} is not off, its one value; unset it to keep a catalogue read five minutes`,
    )
  }
  const token = context.env[BACKSTAGE_TOKEN_VARIABLE]
  if (token !== undefined && token !== '' && !headerCarries(token)) {
    throw refusal(
      `${BACKSTAGE_TOKEN_VARIABLE} holds a character a header cannot carry: a token is visible ASCII, with no space (docs/adopting-backstage.md)`,
    )
  }
  if (!isLoopback(base)) {
    if (token === undefined || token === '') {
      throw refusal(
        `${BACKSTAGE_TOKEN_VARIABLE} is not set; the Backstage catalogue at ${label} needs a read token (docs/adopting-backstage.md)`,
      )
    }
  }
  return { kind: 'backstage', url: base.href, label, origin }
}

/** What every refusal of a catalogue URL ends on: the one form it takes. */
const CATALOGUE_BASE = "the catalogue API's base is stated exactly: https://<backend host>/api/catalog"

/** A scheme, as RFC 3986 spells one. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** `raw` cut where a URL's parts begin, as typed: the scheme, the slashes, the authority, the rest. */
function partsOf(raw: string): { scheme: string; slashes: string; authority: string; rest: string } {
  const scheme = SCHEME.exec(raw)?.[0] ?? ''
  const afterScheme = raw.slice(scheme.length)
  const slashes = /^[/\\]*/.exec(afterScheme)?.[0] ?? ''
  const afterSlashes = afterScheme.slice(slashes.length)
  const end = afterSlashes.search(/[/\\?#]/)
  return {
    scheme,
    slashes,
    authority: end === -1 ? afterSlashes : afterSlashes.slice(0, end),
    rest: end === -1 ? '' : afterSlashes.slice(end),
  }
}

/**
 * A space, a C0 control or DEL: a URL parser drops them at either end, and
 * drops every tab and line break wherever it is, so the parts it reads are not
 * where the text as typed puts them — and quoting that text could print the
 * userinfo it found.
 */
const SPACED = /[\u0000-\u0020\u007f]/

/** Whether `raw` parses as an http: or https: URL. */
function parsed(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * `raw` as a refusal may quote it: its userinfo, its query and its fragment
 * each `***`, since those are where a token is put, and a swapped pair puts
 * the token in the URL's place. A value that does not parse as an http: or
 * https: URL is described by its length alone: it may be the token itself.
 * So is one holding a space or a control character (`SPACED`), since the
 * parts cut from the text as typed are not the ones the parser reads.
 * Flattened, as every value a person wrote is.
 */
export function shownUrl(raw: string): string {
  const length = String([...raw].length)
  if (SPACED.test(raw)) return `a value of ${length} characters with a space or a control character in it`
  if (parsed(raw) === undefined) {
    return URL.canParse(raw)
      ? `a value of ${length} characters that is not an http: or https: URL`
      : `a value of ${length} characters that does not parse as a URL`
  }
  const { scheme, slashes, authority, rest } = partsOf(raw)
  const at = authority.lastIndexOf('@')
  const host = at === -1 ? authority : `***@${authority.slice(at + 1)}`
  const hash = rest.indexOf('#')
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash)
  const mark = beforeHash.indexOf('?')
  const path = mark === -1 ? beforeHash : `${beforeHash.slice(0, mark)}?***`
  return flat(`${scheme}${slashes}${host}${path}${hash === -1 ? '' : '#***'}`)
}

/** A path segment the parser would read as a dot, or two: `.`, `..`, `%2e`, `.%2E` and the rest. */
const DOT_SEGMENT = /^(\.|%2e){1,2}$/i

/**
 * The catalogue API's base, or a refusal (exit 2) naming where the value came
 * from — `where` is `IDP_BACKSTAGE_URL=` or `<file>: backstage ` — and quoting
 * it as `shownUrl` does, never whole (brief § 8). Refused: a space or a
 * control character, which the parser drops; a `\`, which the
 * parser reads as `/`; a value that does not parse; any scheme but https:,
 * and http: to anything but this machine; userinfo, a query or a fragment,
 * as typed (a bare `?` is a query) or parsed; no path; an empty, `.` or `..`
 * segment, encoded or not; and a path the parser would rewrite, since the
 * base is stated exactly and never guessed (`/api/%2e%2e/catalog` parses to
 * `/catalog`).
 */
export function catalogueBase(raw: string, where: string): URL {
  const quoted = shownUrl(raw)
  const refuse = (why: string): Error => refusal(`${where}${quoted} ${why}; ${CATALOGUE_BASE}`)
  if (SPACED.test(raw)) throw refusal(`${where}(${quoted}); ${CATALOGUE_BASE}`)
  if (raw.includes('\\')) throw refuse('holds a \\, which a URL parser reads as /')
  const url = parsed(raw)
  if (url === undefined) throw refusal(`${where}(${quoted}); ${CATALOGUE_BASE}`)
  if (url.protocol !== 'https:' && !isLoopback(url)) {
    throw refuse('is http: to another machine; a catalogue is read over https:, or http: to 127.0.0.1, ::1 or localhost')
  }
  const { authority, rest } = partsOf(raw)
  if (url.username !== '' || url.password !== '' || authority.includes('@')) {
    throw refuse(`holds userinfo, where a credential would be; the token is read from ${BACKSTAGE_TOKEN_VARIABLE} alone`)
  }
  const hash = rest.indexOf('#')
  if (url.search !== '' || (hash === -1 ? rest : rest.slice(0, hash)).includes('?')) throw refuse('holds a query')
  if (url.hash !== '' || hash !== -1) throw refuse('holds a fragment')
  if (rest === '' || rest === '/') throw refuse("has no path, and the catalogue API's base has one")
  for (const segment of rest.split('/').slice(1)) {
    if (segment === '') throw refuse('has an empty path segment')
    if (DOT_SEGMENT.test(segment)) throw refuse(`has the path segment ${segment}, which a URL parser reads as a dot`)
  }
  if (url.pathname !== rest) throw refuse('has a path a URL parser would rewrite')
  return url
}

/**
 * Whether a catalogue is configured, for the one line that names
 * `--backstage` beside a repository the working directory answered: the
 * variable, or the file's `backstage`. The file is read for this alone, and a
 * file that cannot be read configures nothing here — the read did not reach
 * it, so it refuses nothing.
 */
export async function catalogueConfigured(context: SourceContext): Promise<boolean> {
  const url = context.env[BACKSTAGE_URL_VARIABLE]
  if (url !== undefined && url !== '') return true
  const config = await readPersonalConfig(context.env, context.platform ?? process.platform).catch(() => undefined)
  return config?.backstage !== undefined
}

/**
 * Why `--refresh` or `--cached` is refused once the source is resolved and
 * is not a catalogue — the directory the person stands in, a configured
 * repository, the demo SI — exit 2, before any request: what was read, and
 * the way to the catalogue when one is configured.
 */
export async function cacheFlagRefusal(
  flag: '--refresh' | '--cached',
  source: RepositorySource | DemoSource,
  context: SourceContext,
): Promise<RepositoryArgumentError> {
  const what =
    source.kind === 'repo'
      ? `the declarations repository ${source.label} (${originText(source.origin)})`
      : `the demo SI (${originText(source.origin)})`
  const way = (await catalogueConfigured(context))
    ? '--backstage reads the catalogue'
    : `no catalogue is configured: ${BACKSTAGE_URL_VARIABLE}, or backstage in ${personalFileHint(context.env, context.platform)}`
  return refusal(`${cacheFlagWords(flag)}, and this run reads ${what}; ${way}`)
}

/** What `--cached` and `--refresh` read, as the start of a refusal of one: at parsing, and once the source is resolved. */
export const cacheFlagWords = (flag: '--cached' | '--refresh'): string =>
  flag === '--cached'
    ? '--cached reads a kept copy of a Backstage catalogue'
    : '--refresh reads a Backstage catalogue again'

/**
 * Why `--cached` is refused when this tool keeps no copy here (`cacheRootOf`),
 * exit 2 — or, `undefined`, when this run was handed no cache root at all,
 * which only an embedding or a test does.
 */
export function noCacheRefusal(reason: NoCache | undefined): RepositoryArgumentError {
  return refusal(`--cached reads a copy this tool keeps, and none is kept here: ${noCacheWords(reason)}`)
}

/** Why no copy is kept, in the words of `--cached`'s refusal. */
function noCacheWords(reason: NoCache | undefined): string {
  switch (reason) {
    case 'off':
      return `${CACHE_VARIABLE} is off`
    case 'no-home':
      return 'neither XDG_CACHE_HOME nor HOME names an absolute folder'
    case 'platform':
      return 'this tool keeps none on Windows'
    case 'root':
      return 'this tool keeps none for root, so a sudo run never leaves company data owned by root in a home'
    case undefined:
      return 'this run was given no cache folder'
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
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
 * What `ask`'s overview is headed with: a repository by its folder, a
 * catalogue by its host, and the demo SI, which the overview names on its
 * own. Exhaustive, as `render/overview.ts`'s `fromOf` is over what this
 * returns, so a new kind of source is a compile error in both.
 */
export function overviewName(source: Source): OverviewSource {
  switch (source.kind) {
    case 'repo':
      return { from: 'repo', repo: source.label }
    case 'backstage':
      return { from: 'catalogue', catalogue: source.label }
    case 'demo':
      return { from: 'demo' }
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
    case 'backstage':
      return catalogueNamedBy(source.origin)
    case 'demo':
      return undefined
    default: {
      const exhaustive: never = source
      return exhaustive
    }
  }
}

/**
 * What named a catalogue, as a blame: the setting that holds its URL. Never
 * `namedBy`, which names a repository (`--repo`, `repo in <file>`).
 */
function catalogueNamedBy(origin: BackstageSource['origin']): string {
  switch (origin.by) {
    case 'variable':
      return origin.name
    case 'file':
      return `backstage in ${origin.file}`
    default: {
      const exhaustive: never = origin
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
 * What a load read, for a catalogue's notice (brief § 10): the distinct uids
 * served (`census`), the entities read, the documents of a kind not modelled,
 * those the catalogue read set aside, those the reader skipped, and — only
 * when a read stopped at its bound — how many the bounds left out
 * (`pastBoundOf`), exact or at least.
 */
export interface ReadCounts {
  readonly census?: Census
  readonly entities: number
  readonly notModelled: number
  readonly setAside: number
  readonly skipped: number
  readonly pastBound?: { readonly count: number; readonly exact: boolean }
}

/** A count as the note writes one: `8,412`. */
const countOf = (count: number): string => count.toLocaleString('en-US')

/**
 * The one line on stderr that says what is being read, or `undefined` when the
 * user said it themselves with `--repo`. Said once the source is loaded, so a
 * catalogue's line carries what it served; nothing is printed during a load,
 * so a repository's line is where it always was.
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
 *
 * A catalogue's line names its host, never its path or a token, and counts
 * what it served — N entities: M read, K not modelled, then S set aside,
 * R skipped and P past the bound when there are any, so the terms add up to
 * N — and says when a uid came twice in a read that was still whole. What a
 * bound left out was announced, not served, so it is added to the uids
 * served; "at least" both, when a server announced fewer than it served. A repository the working
 * directory answered while a catalogue is configured (`catalogue`) names
 * `--backstage` among its alternatives.
 */
export function sourceNotice(
  command: DeclarationsCommand,
  source: Source,
  context: Pick<SourceContext, 'env' | 'platform'>,
  read: {
    readonly counts?: ReadCounts
    readonly catalogue?: boolean
    /**
     * A catalogue answered from its kept copy: its age as the notice says it
     * (`copyAge`), and whether `--cached` asked for it whatever its age.
     */
    readonly copy?: { readonly age: string; readonly cached: boolean }
  } = {},
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
      const catalogue =
        command !== 'plan' && source.origin.by === 'working-directory' && read.catalogue === true
          ? ', --backstage the catalogue'
          : ''
      return (
        `reading the declarations repository ${oneLine(source.label)} ` +
        `(${oneLine(originText(source.origin))}); ${alternatives}${catalogue}`
      )
    }
    case 'backstage': {
      const { counts, copy } = read
      const past = counts?.pastBound
      const atLeast = past !== undefined && !past.exact ? 'at least ' : ''
      const served =
        counts === undefined
          ? ''
          : `: ${atLeast}${countOf((counts.census?.served ?? counts.entities + counts.notModelled + counts.setAside + counts.skipped) + (past?.count ?? 0))} entities: ` +
            `${countOf(counts.entities)} read, ${countOf(counts.notModelled)} not modelled` +
            (counts.setAside > 0 ? `, ${countOf(counts.setAside)} set aside` : '') +
            (counts.skipped > 0 ? `, ${countOf(counts.skipped)} skipped` : '') +
            (past !== undefined && past.count > 0 ? `, ${atLeast}${countOf(past.count)} past the bound` : '')
      const repeated = counts?.census?.repeated ?? 0
      // This run sent nothing: the counts are the kept copy's, and so is a
      // uid served twice — said after `read from cache`, of the read that made
      // the copy, never of this run.
      const kept =
        copy === undefined
          ? repeated > 0
            ? `; the catalogue changed while it was read (${countOf(repeated)} served twice)`
            : ''
          : `; read from cache, ${copy.age}` +
            (copy.cached ? ', as --cached asks: Backstage was not asked' : '') +
            (repeated > 0 ? `; the catalogue changed during the read this copy keeps (${countOf(repeated)} served twice)` : '') +
            (copy.cached ? '' : '; --refresh reads Backstage again')
      return (
        `reading the Backstage catalogue at ${oneLine(source.label)} (${oneLine(originText(source.origin))})${served}${kept}; ` +
        'it may lag the declarations repository by minutes; --repo <directory> reads a repository'
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

/** A size in the unit it was set in: MiB when it is a whole number of them, bytes otherwise. */
const sizeOf = (bytes: number): string =>
  bytes % (1024 * 1024) === 0 ? `${String(bytes / (1024 * 1024))} MiB` : `${String(bytes)} bytes`

const secondsOf = (ms: number): string => `${String(ms / 1000)} s`

/**
 * The one line a failed catalogue read prints, exit 1 (brief § 10): the host
 * and what named it, what happened, and the way out — never a fall back to a
 * repository or the demo SI, and nothing a server wrote. `token` is whether a
 * token was sent, which is what a 401 turns on.
 */
export function catalogueFailureLine(error: CatalogueReadError, source: BackstageSource, token: boolean): string {
  const at = `the Backstage catalogue at ${oneLine(source.label)} (${oneLine(originText(source.origin))})`
  // `--cached` never asks the catalogue, so its way out is the other road.
  if (error.failure.kind === 'not-kept') return `${at} ${whatFailed(error.failure, source, token)}`
  // A copy is kept, and the read failed for reach: the provider sets `kept`
  // then and never after a 401 or a 403, which may be a revoked token.
  const kept =
    error.kept === undefined
      ? ''
      : error.kept.ageMs === undefined
        ? '; --cached reads the kept copy, of an age this clock cannot tell'
        : `; --cached reads the copy kept ${ageWords(error.kept.ageMs)} ago`
  return (
    `${at} ${whatFailed(error.failure, source, token)}${kept}; ` +
    '--repo <directory> reads a repository instead, and `idpa plan` decides a change without the catalogue'
  )
}

/** What happened to a catalogue read, in the words of its line. */
function whatFailed(failure: CatalogueFailure, source: BackstageSource, token: boolean): string {
  switch (failure.kind) {
    case 'unreachable':
      return `could not be reached (${oneLine(failure.cause)})`
    case 'timeout':
      return failure.scope === 'request'
        ? `did not answer a request within ${secondsOf(failure.limit)}`
        : `was not read within ${secondsOf(failure.limit)}, the time a load is given`
    case 'status': {
      const { status } = failure
      if (status === 401) {
        return token
          ? `refused the token (401): ${BACKSTAGE_TOKEN_VARIABLE} is set and not accepted`
          : `refused the token (401): ${BACKSTAGE_TOKEN_VARIABLE} is not set, and this catalogue asks for one`
      }
      if (status === 403) return 'refused the read (403): the token may not read the catalogue (catalog.entity.read)'
      if (status === 404) {
        const base = oneLine(source.url, Number.POSITIVE_INFINITY)
        return `answered 404: ${base} is not a catalogue API base (expected ${base}/entities/by-query)`
      }
      return status >= 500 ? `failed (${String(status)})` : `refused the request (${String(status)})`
    }
    case 'redirect':
      return failure.status === undefined
        ? 'answered with a redirect, which is never followed'
        : `answered with a redirect (${String(failure.status)}), which is never followed`
    case 'foreign-response':
      return 'answered from another address than the one asked, which is refused'
    case 'rate-limited':
      return 'limited the rate of requests (429) past what a run waits for'
    case 'too-large':
      return failure.scope === 'response'
        ? `sent a response larger than ${sizeOf(failure.limit)}`
        : `sent more than ${sizeOf(failure.limit)} in one run`
    case 'not-json':
      return 'answered with a body that is not UTF-8 JSON'
    case 'not-envelope':
      return `answered ${failure.route} with a body that is not what the route serves`
    case 'facets-kind':
      return 'named a kind this tool cannot put in a filter, which is refused'
    case 'same-page':
      return 'returned the same page twice'
    case 'no-uid':
      return 'served an entity with no metadata.uid, so the read cannot be proved whole'
    case 'unasked-kind':
      return 'served an entity of a kind the read did not ask for, so it does not filter as Backstage does'
    case 'changed':
      return `changed while it was read (${countOf(failure.expected)} expected, ${countOf(failure.read)} read)`
    case 'not-kept':
      return 'was not read: no copy of it read with this token is kept on this machine (--cached); run without --cached to read it'
    default: {
      const exhaustive: never = failure
      return exhaustive
    }
  }
}
