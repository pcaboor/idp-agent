import path from 'node:path'
import { RESOURCE_TYPE_NAMES, folderOf } from '../schemas/resource-types.js'
import { readDocuments } from '../yaml/serialize.js'

/**
 * The Backstage registration: the `kind: Location` at the root of a
 * declarations repository, whose targets are the folders this tool files
 * entities in. One `catalog.locations` entry naming this file ingests the
 * whole repository (docs/adopting-backstage.md), so adopting Backstage later
 * is one registration, not a migration (design note `backstage-http`, slice 0).
 *
 * Everything the writer and the reader know about it is here, once: the file,
 * its targets, its name and bytes, and what `validate` holds it to. `init
 * platform` writes it from these functions and `validate` reads it back through
 * them, so a registration the tool writes is one the tool accepts.
 *
 * What Backstage does with the file, verified against its source (master at
 * 43e352a, 2026-09-25):
 *
 * - A relative target is resolved against the Location file's own URL
 *   (`toAbsoluteUrl`, `integrations.resolveUrl`) only when the Location's type
 *   is the registration's — so this one states none, and `validate` refuses one
 *   that does: the tool cannot know how the file is registered.
 * - A target with `*` or `?` in its path is a search: GitHub's and GitLab's URL
 *   readers list the repository tree and filter it with `minimatch`, whose
 *   defaults match no dotfile. A witness is never ingested.
 * - A search matching nothing is an error on the Location unless its presence
 *   is `optional`: a folder with nothing in it yet is not a fault here, and a
 *   fresh repository has nothing anywhere.
 */

/** Where Backstage's own convention puts a repository's catalogue file. */
export const REGISTRATION_FILE = 'catalog-info.yaml'

/** The folders the path registry files entities in, sorted. */
const FOLDERS = [...new Set(RESOURCE_TYPE_NAMES.map(folderOf))].sort()

/** Their first segments — `catalog`, `dependencies` — from the registry, never a literal. */
/**
 * Where a declarations repository keeps its Components when it keeps them
 * centrally: the demo SI's layout, the owner's, and stage 8's default for a new
 * Component (docs/stage-8-brief.md § 13, answer 4). It is not in the path
 * registry, because no operation files a Component here yet; it is registered
 * all the same, or a repository laid out that way would have its services left
 * out of Backstage. `presence: optional` covers a repository with none.
 */
export const COMPONENT_FOLDER = 'components'

const ROOTS = [
  ...new Set([...FOLDERS.map((folder) => folder.split('/')[0] ?? ''), COMPONENT_FOLDER]),
]
  .filter((root) => root !== '')
  .sort()

/**
 * One target per root and extension. `.yml` is what the engine writes; `.yaml`
 * is what a person may add, and `validate` reads both, so Backstage ingests
 * what `validate` checked. No brace expansion: GitLab's reader finds the fixed
 * part of a glob by the first segment holding `*` or `?`, and a `{` in a URL is
 * percent-encoded on the way.
 */
export function registrationTargets(): readonly string[] {
  return ROOTS.flatMap((root) => [`./${root}/**/*.yml`, `./${root}/**/*.yaml`])
}

/** Backstage's name grammar, lower case as this tool writes names, 63 at most. */
const NAME = /^([a-z0-9]+[-_.])*[a-z0-9]+$/
/** The grammar Backstage accepts, upper case included, which a person may have written. */
const BACKSTAGE_NAME = /^([A-Za-z0-9]+[-_.])*[A-Za-z0-9]+$/
const NAME_LENGTH = 63
const FALLBACK_NAME = 'declarations'

/**
 * The Location's name, derived from the directory `init platform` created:
 * accents dropped, every run of anything else than a letter or a digit one `-`,
 * cut to 63. A directory in another script gives no name Backstage accepts —
 * its grammar is ASCII — and gets `declarations`.
 */
export function registrationName(directory: string): string {
  const name = directory
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, NAME_LENGTH)
    .replace(/-+$/, '')
  return NAME.test(name) ? name : FALLBACK_NAME
}

/** The bytes `init platform` writes, for the directory it created. */
export function renderRegistration(directory: string): string {
  const named = ROOTS.map((root) => `${root}/`)
  const folders =
    named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1) ?? ''}` : (named[0] ?? '')
  return [
    '# The Backstage registration of this repository. Register this file once, in',
    "# catalog.locations of your Backstage's app-config.yaml, and Backstage ingests",
    '# every entity filed below. `idp-agent validate` holds it to that.',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Location',
    'metadata:',
    `  name: ${registrationName(directory)}`,
    `  description: Every entity this declarations repository keeps under ${folders}.`,
    'spec:',
    '  # A folder with nothing in it yet is not an error.',
    '  presence: optional',
    '  targets:',
    ...registrationTargets().map((target) => `    - ${target}`),
    '',
  ].join('\n')
}

/** One `kind: Location` in the root file, as `validate` reads it. */
export interface Registration {
  /** What Backstage would refuse, or what reads outside the repository: errors. */
  readonly faults: readonly string[]
  /** The registry's folders no target reaches: Backstage never ingests them. */
  readonly unreached: readonly string[]
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A document is the registration's by its kind, whatever its case, as
 * `parseDocuments` sets one aside by its kind. Backstage follows only `kind:
 * Location` (`isLocationEntity`), so another case is taken out here to be
 * refused, not set aside with a warning: it is a registration that ingests
 * nothing, in silence.
 */
export const isLocationKind = (kind: unknown): boolean =>
  typeof kind === 'string' && kind.toLowerCase() === 'location'

const LOCATION_KIND = 'Location'

const API_VERSIONS = ['backstage.io/v1alpha1', 'backstage.io/v1beta1']
const PRESENCES = ['required', 'optional']

/** Printed as data: a target reaches a CI log and a terminal. */
const quoted = (text: string): string => JSON.stringify(text)

/** Why a target does not stay in this repository, or undefined when it does. */
function targetFault(target: string): string | undefined {
  if (target === '') return 'has a target that is empty'
  const shown = quoted(target)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    return `target ${shown} is an absolute URL; a target is a path in this repository, from ./`
  }
  if (target.startsWith('/') || target.startsWith('\\')) {
    return `target ${shown} is an absolute path; a target is a path in this repository, from ./`
  }
  const normalised = path.posix.normalize(target.replaceAll('\\', '/'))
  if (normalised === '..' || normalised.startsWith('../')) {
    return `target ${shown} leaves the repository`
  }
  // A house rule, not Backstage's: a `url` registration resolves a bare
  // `catalog/...` against this file too, a `file` one only a target starting
  // with a dot. From ./, the targets read the same under either.
  if (!target.startsWith('./')) {
    return (
      `target ${shown} does not start with ./; every target is written from ./, ` +
      'which a url and a file registration both read against this file'
    )
  }
  return undefined
}

/**
 * One glob segment against one path segment: `*` and `?`, as minimatch reads
 * them. Its dotfile rule is left out: what is matched here is a registry folder
 * and the engine's `entity.yml`, and neither starts with a dot. Anything else
 * in a glob (braces, classes) is read as written, so a target using them may be
 * called unreaching: a warning too many, never a folder called reached that is
 * not.
 */
const segmentMatches = (glob: string, name: string): boolean => {
  const pattern = [...glob]
    .map((char) => {
      if (char === '*') return '[^/]*'
      if (char === '?') return '[^/]'
      return char.replace(/[\\^$.|+()[\]{}]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${pattern}$`).test(name)
}

const globMatches = (glob: readonly string[], file: readonly string[]): boolean => {
  const [head, ...rest] = glob
  if (head === undefined) return file.length === 0
  if (head === '**') {
    if (globMatches(rest, file)) return true
    const [first, ...others] = file
    return first !== undefined && globMatches(glob, others)
  }
  const [first, ...others] = file
  return first !== undefined && segmentMatches(head, first) && globMatches(rest, others)
}

/** Whether a target reaches a file the engine would file in `folder`. */
const reaches = (target: string, folder: string): boolean =>
  globMatches(
    path.posix.normalize(target).split('/').filter((segment) => segment !== ''),
    [...folder.split('/'), 'entity.yml'],
  )

/** What `validate` makes of one Location document at the root. */
function readRegistration(value: Record<string, unknown>): Registration {
  const faults: string[] = []
  const { apiVersion, kind, metadata, spec } = value

  if (kind !== LOCATION_KIND) {
    faults.push(`is written kind: ${quoted(String(kind))}; Backstage follows it only as kind: Location`)
  }
  if (typeof apiVersion !== 'string' || !API_VERSIONS.includes(apiVersion)) {
    faults.push(`is not under Backstage's apiVersion (${API_VERSIONS.join(' or ')})`)
  }
  const name = isMapping(metadata) ? metadata.name : undefined
  if (typeof name !== 'string' || name.length > NAME_LENGTH || !BACKSTAGE_NAME.test(name)) {
    faults.push('has no metadata.name Backstage accepts')
  }
  if (!isMapping(spec)) {
    faults.push('has no spec; spec.targets lists the folders Backstage reads')
    return { faults, unreached: FOLDERS }
  }
  // Backstage reads a Location's targets as `spec.type`, or the registration's
  // type when it states none, and resolves a relative one against this file
  // only when the two agree (`toAbsoluteUrl`). This tool cannot know how the
  // file is registered, and writes no type; one stated sends `./catalog/...`
  // to another reader — under `file`, the backend's own disk — and, the
  // presence being optional, Backstage ingests nothing and says nothing.
  if ('type' in spec) {
    faults.push(
      `states spec.type ${JSON.stringify(spec.type) ?? 'null'}; its targets are read ` +
        'against this file only when it states none and takes the registration\'s',
    )
  }
  if ('presence' in spec && !PRESENCES.includes(spec.presence as string)) {
    faults.push(`has a presence Backstage does not define (${PRESENCES.join(' or ')})`)
  }

  const targets: string[] = []
  let unreadable = false
  if ('target' in spec) {
    if (typeof spec.target === 'string') targets.push(spec.target)
    else {
      faults.push('has a spec.target that is not text')
      unreadable = true
    }
  }
  if ('targets' in spec) {
    const listed: unknown = spec.targets
    if (Array.isArray(listed) && listed.every((target) => typeof target === 'string')) {
      targets.push(...(listed as string[]))
    } else {
      faults.push('has a spec.targets that is not a list of text')
      unreadable = true
    }
  }
  if (targets.length === 0 && !unreadable) {
    faults.push('targets nothing; spec.targets lists the folders Backstage reads')
  }

  const inside: string[] = []
  for (const target of targets) {
    const fault = targetFault(target)
    if (fault === undefined) inside.push(target)
    else faults.push(fault)
  }
  const unreached = FOLDERS.filter((folder) => !inside.some((target) => reaches(target, folder)))
  return { faults, unreached }
}

/** Every `kind: Location` in a root file's text, read as the registration. */
export function registrationsIn(text: string): Registration[] {
  return readDocuments(text).flatMap((reading) =>
    'value' in reading && isMapping(reading.value) && isLocationKind(reading.value.kind)
      ? [readRegistration(reading.value)]
      : [],
  )
}

/**
 * Whether a root file registers the whole repository: a Location with no
 * fault, reaching every folder.
 */
export function registers(
  file: { readonly registrations?: readonly Registration[] | undefined } | undefined,
): boolean {
  return (file?.registrations ?? []).some(
    (registration) => registration.faults.length === 0 && registration.unreached.length === 0,
  )
}
