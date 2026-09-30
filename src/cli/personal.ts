import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, YAMLParseError } from 'yaml'
import { z } from 'zod'
import { reasonOf } from '../core/schemas/reject.js'
import { ConfigError } from './config.js'
import { oneLine } from './render/plain.js'

/**
 * The personal configuration: `$XDG_CONFIG_HOME/idp-agent/config.yml`, else
 * `~/.config/idp-agent/config.yml` — on Windows, `%APPDATA%\idp-agent\config.yml`
 * when no XDG_CONFIG_HOME is set.
 *
 * The other half of design §7.0. `.idp-agent.yml` is committed to an
 * application repository and shared by a team; this file is one person's, on
 * one machine, and never enters a repository. What it holds is where that
 * person's declarations repository is, so `graph`, `show`, `ask` and `plan` can
 * be run from any directory without `--repo`, and the Backstage catalogue they
 * read for a question (`source.ts`). That catalogue takes its token from an
 * environment variable, `IDP_BACKSTAGE_TOKEN`, like the model keys, never from
 * here: there is deliberately no field that could carry a credential, and the
 * schema is strict, so `token:` is refused by name rather than read.
 *
 * Located from the environment it is handed and nothing else — never
 * `os.homedir()`, which reads the process's own — so a test that injects an
 * environment cannot reach the developer's file, and one with no home in it
 * has no personal configuration at all.
 *
 * Absent is not an error: nobody has to write this file. Present and malformed
 * is, and names the file, for the reason `.idp-agent.yml` does — the user wrote
 * it on purpose, and a typo answered with a silent fall back to the demo SI is
 * an answer about the wrong company.
 */

export type Env = Record<string, string | undefined>

/** `path` for the platform the file is located on, which a test can choose. */
type Platform = NodeJS.Platform

const DIRECTORY = 'idp-agent'
const FILE = 'config.yml'

/** An empty string is unset: that is what an unset shell variable yields. */
const valueOf = (raw: string | undefined): string | undefined =>
  raw === undefined || raw === '' ? undefined : raw

export const pathOf = (platform: Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

/** The home directory the environment names: HOME, or USERPROFILE on Windows. */
export function homeOf(env: Env, platform: Platform = process.platform): string | undefined {
  return platform === 'win32'
    ? (valueOf(env['USERPROFILE']) ?? valueOf(env['HOME']))
    : valueOf(env['HOME'])
}

/**
 * Where the file is, or nowhere when the environment names no directory for it.
 *
 * A relative XDG_CONFIG_HOME is ignored, as the XDG specification requires:
 * relative to what would depend on where the command was run, and this file is
 * the one that must not.
 */
export function personalConfigFile(
  env: Env,
  platform: Platform = process.platform,
): string | undefined {
  const p = pathOf(platform)
  const xdg = valueOf(env['XDG_CONFIG_HOME'])
  if (xdg !== undefined && p.isAbsolute(xdg)) return p.join(xdg, DIRECTORY, FILE)
  if (platform === 'win32') {
    const appData = valueOf(env['APPDATA'])
    if (appData !== undefined) return p.join(appData, DIRECTORY, FILE)
  }
  const home = homeOf(env, platform)
  return home === undefined ? undefined : p.join(home, '.config', DIRECTORY, FILE)
}

/** The variable that turns the catalogue cache off: `off` is its one value (`source.ts` refuses any other). */
export const CACHE_VARIABLE = 'IDP_BACKSTAGE_CACHE'

/**
 * Where a catalogue read is kept (`context/backstage/cache.ts`), or why none
 * is: the root the store makes `idp-agent/backstage/` under.
 */
export type CacheRoot =
  | { readonly dir: string }
  /**
   * `off`: IDP_BACKSTAGE_CACHE says so. `no-home`: neither XDG_CACHE_HOME nor
   * HOME names an absolute folder. `platform`: Windows, where `confine/` cannot open a
   * file without following a link. `root`: a run as root keeps nothing, since
   * `sudo` can keep the caller's home, and one run would leave company data
   * owned by root in it that none of their own runs may read or remove.
   */
  | { readonly none: 'off' | 'no-home' | 'platform' | 'root' }

/**
 * `$XDG_CACHE_HOME` when it is absolute, else `$HOME/.cache` when HOME is — resolved as
 * `personalConfigFile` resolves XDG_CONFIG_HOME, from the environment it is
 * handed, never `os.homedir()`. Called by `bin.ts` alone: `main` keeps
 * nothing unless it is handed a root, so no test keeps a copy without asking.
 */
export function cacheRootOf(env: Env, platform: Platform = process.platform, uid?: number): CacheRoot {
  if (env['IDP_BACKSTAGE_CACHE'] === 'off') return { none: 'off' }
  if (platform === 'win32') return { none: 'platform' }
  if (uid === 0) return { none: 'root' }
  const p = pathOf(platform)
  const xdg = valueOf(env['XDG_CACHE_HOME'])
  if (xdg !== undefined && p.isAbsolute(xdg)) return { dir: xdg }
  // A relative HOME would resolve against the working directory, and put the
  // copy and its secret in the repository a run was started from.
  const home = homeOf(env, platform)
  return home === undefined || !p.isAbsolute(home) ? { none: 'no-home' } : { dir: p.join(home, '.cache') }
}

/**
 * A path as a person reads it: under `~` when it is in their home directory,
 * whole otherwise. Only for what is printed — nothing reads the shown form.
 */
export function shownPath(file: string, env: Env, platform: Platform = process.platform): string {
  const home = homeOf(env, platform)
  if (home === undefined) return file
  const p = pathOf(platform)
  const relative = p.relative(home, file)
  if (relative === '' || relative.startsWith('..') || p.isAbsolute(relative)) return file
  return `~${p.sep}${relative}`
}

/**
 * `~` and `~/…` expanded against the environment's home; anything else as it
 * is. `~user` is not expanded — that is a shell's job and needs a user
 * database — and reads as a path like any other.
 *
 * Returns `undefined` when the value needs a home and the environment names
 * none, so the caller can say which setting could not be read.
 */
export function expandHome(
  value: string,
  env: Env,
  platform: Platform = process.platform,
): string | undefined {
  const separators = platform === 'win32' ? ['/', '\\'] : ['/']
  const home = value === '~' || separators.some((sep) => value.startsWith(`~${sep}`))
  if (!home) return value
  const directory = homeOf(env, platform)
  return directory === undefined ? undefined : pathOf(platform).join(directory, value.slice(1))
}

/**
 * Two fields. `strictObject`, so a misspelt key — or a credential somebody
 * tried to put here — is a named refusal rather than a key dropped in silence.
 */
const personalSchema = z.strictObject({
  /** The local declarations repository: `~` expanded, relative to this file's directory. */
  repo: z.string().min(1).max(4096).optional(),
  /**
   * The Backstage catalogue API's base, a URL as written: never home-expanded
   * nor resolved against anything. `source.ts` checks it, and only when a run
   * reaches it.
   */
  backstage: z.string().min(1).max(4096).optional(),
})

export interface PersonalConfig {
  /** The file it was read from, absolute. */
  readonly file: string
  /** The same, as a person reads it — `~/.config/idp-agent/config.yml`. */
  readonly shown: string
  /** The declarations repository, absolute; absent when the file sets none. */
  readonly repo?: string
  /** The catalogue API's base, as written; absent when the file sets none. */
  readonly backstage?: string
}

/**
 * A refusal in one line and whole: what it quotes — the value written, a key,
 * the parser's excerpt of the file — is whatever someone put in the file,
 * escape sequences and line breaks included. Not cut, because a path cut short
 * is another path.
 */
export const flat = (text: string): string => oneLine(text, Number.POSITIVE_INFINITY)

const refuse = (message: string): ConfigError => new ConfigError(flat(message))

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The read errors that mean "no such file", as opposed to "unreadable". */
const isAbsent = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The personal configuration, or `undefined` when there is none to read.
 *
 * Throws `ConfigError` — exit 2 — for a file that is there and cannot be used:
 * unreadable, not YAML, a key the schema does not have, or a `~` with no home
 * to expand it against. Every refusal names the file.
 */
export async function readPersonalConfig(
  env: Env,
  platform: Platform = process.platform,
): Promise<PersonalConfig | undefined> {
  const file = personalConfigFile(env, platform)
  if (file === undefined) return undefined
  const shown = shownPath(file, env, platform)

  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw refuse(`cannot read ${shown}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let value: unknown
  try {
    value = parse(text)
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error
    throw refuse(`${shown} is not YAML: ${error.message}`)
  }

  // An empty file, or one holding only comments, sets nothing: it is a file
  // somebody created before deciding what to put in it.
  // `repo: ~` reads as a home directory and is YAML's null, as `repo:` is: the
  // schema's "expected string, received null" would leave the user guessing.
  if (isMapping(value) && Object.hasOwn(value, 'repo') && value['repo'] === null) {
    throw refuse(
      `${shown}: repo is empty — a bare ~ is YAML's null; write repo: "~" to name the home directory`,
    )
  }
  if (isMapping(value) && Object.hasOwn(value, 'backstage') && value['backstage'] === null) {
    throw refuse(`${shown}: backstage is empty; it names the catalogue API's base, https://<backend host>/api/catalog`)
  }
  const parsed = personalSchema.safeParse(value ?? {})
  if (!parsed.success) {
    throw refuse(`${shown} is not a configuration — ${reasonOf(parsed.error)}`)
  }

  const { backstage } = parsed.data
  const read = { file, shown, ...(backstage === undefined ? {} : { backstage }) }
  const written = parsed.data.repo
  if (written === undefined) return read
  const expanded = expandHome(written, env, platform)
  if (expanded === undefined) {
    throw refuse(
      `${shown}: repo ${written} starts with ~, and no home directory is set to expand it against`,
    )
  }
  // Against the file's own directory, never the working one: the same file
  // must name the same repository wherever the command is run from.
  return { ...read, repo: pathOf(platform).resolve(pathOf(platform).dirname(file), expanded) }
}
