import path from 'node:path'
import {
  CREDENTIAL_DIRECTORIES,
  CREDENTIAL_NAMES,
  CREDENTIAL_STEMS,
  GENERATED_DIRECTORIES,
  isEnvironmentName,
  PRIVATE_KEY_NAMES,
  SECRET_EXTENSIONS,
} from '../secrets/names.js'
import { readDocuments } from '../yaml/serialize.js'
import { DISCOVERY_LIMITS } from './limits.js'
import type { ExtractorName } from './rules.js'

/**
 * What stage 8's discovery read may open, decided by the path alone, and what
 * it says about every path it walks (plan, Task 1.2). Pure: the read in
 * `context/discovery/read.ts` asks these of each path git tracks, in this
 * order — never opened, generated, allowed, then code or no rule — and opens
 * only what `allowed` names.
 *
 * The allow-list is closed and by name. Each later extractor adds its names by
 * its own pull request, never by a pattern a repository could aim at.
 */

export type FileFormat = 'json' | 'dotenv' | 'yaml'

/** Why a path is never opened, or a file was discarded whole after parsing. */
export const BY_DESIGN = [
  'environment-file',
  'key-material',
  'credential-store',
  'git',
  'cloud-credentials',
  'kubeconfig',
  'terraform-state',
  'discarded-sops',
  'discarded-secret',
] as const
export type ByDesign = (typeof BY_DESIGN)[number]

/**
 * Why a walked path was not analysed. The last four are produced by the
 * re-read (1.3) and the extractors (1.4); `parse-failure` is also what the
 * read says of a YAML stream it cannot read whole (`discardedWhole`).
 * `head-unlisted` is said once, of `Walked`'s `unlisted` count, and never
 * beside a path (`PathNotAnalysed`): under a `HEAD` that could not be listed
 * whole, no path can be shown committed, so none is named.
 */
export const NOT_ANALYSED = [
  'no-rule',
  'code',
  'generated',
  'over-size',
  'not-committed',
  'deleted',
  'head-unlisted',
  'link',
  'not-a-file',
  'unreadable',
  'changed-during-run',
  'parse-failure',
  'over-finding-cap',
  'past-run-cap',
] as const
export type NotAnalysed = (typeof NOT_ANALYSED)[number]

/** Why a path named in `notAnalysed` was not analysed: every reason but `head-unlisted`, which is said of a count alone. */
export type PathNotAnalysed = Exclude<NotAnalysed, 'head-unlisted'>

/** A standing a whole file gives its findings: the first of `mention`, then `sample` or `evidence`. */
export type FileStanding = 'evidence' | 'sample' | 'mention'

export interface Allowed {
  readonly extractor: ExtractorName
  readonly format: FileFormat
  readonly standing: FileStanding
}

/**
 * What the read establishes, as core names it: what `coverageOf` (1.4) is
 * handed. A path is named only when git tracks it and `HEAD` holds it: its
 * name is committed. Everything else is counted and never named, because the
 * name of a file nobody committed is no more the service's to print than its
 * content: what git does not track, and every path outside a repository, in
 * `untracked`; what the index holds and `HEAD` does not, staged and never
 * committed, in `staged` (owner's answer to question 5, 2026-10-06); every
 * path git tracks where `HEAD` could not be listed whole, in `unlisted`; and a
 * path `HEAD` holds whose name is not valid UTF-8, in `unnameable`. A path is
 * named under git's spelling of it, never the one its folder lists.
 */
export interface Walked {
  readonly selection: 'git' | 'walk' | 'none'
  /** `HEAD`'s commit, hex; undefined when unborn or not git. */
  readonly head: string | undefined
  /** Sorted. */
  readonly opened: readonly string[]
  /** Paths `HEAD` holds; empty under `walk`, under an unborn `HEAD` and under one not listed whole. */
  readonly notAnalysed: readonly { readonly path: string; readonly why: PathNotAnalysed }[]
  /** Paths `HEAD` holds; empty under `walk`, under an unborn `HEAD` and under one not listed whole. */
  readonly byDesign: readonly { readonly path: string; readonly why: ByDesign }[]
  /** What git does not track: counted, never named; under `walk`, every path. */
  readonly untracked: number
  /**
   * Staged, never committed: in the index and not in `HEAD`, in the working
   * tree or not. Counted, never named; under an unborn `HEAD`, every path git
   * tracks.
   */
  readonly staged: number
  /**
   * Every path git tracks, when `HEAD` could not be listed whole: counted,
   * none named and none opened, for the one reason the report prints beside
   * the count (`head-unlisted`). 0 otherwise.
   */
  readonly unlisted: number
  /**
   * A path git holds whose name is not valid UTF-8: counted, never named,
   * never opened. Of what `HEAD` holds and the index lists; one `HEAD` does
   * not hold is in `staged`. 0 where `HEAD` is unborn or not listed whole.
   */
  readonly unnameable: number
  readonly truncated: boolean
}

/** A path's segments, lowercased: APFS and NTFS serve `ID_RSA` for `id_rsa`, so every comparison is on these. */
const segmentsOf = (file: string): string[] => file.toLowerCase().split('/')

/**
 * The sample family: `.env.example`, `.env.sample`, `.env.template`, and
 * `.env.<part>.example|sample|template` (`.env.local.example`). The only
 * environment files the read opens: a template states the shape of a
 * configuration, and every finding of one is a `sample` that cannot vouch.
 */
const SAMPLE = /^\.env(\.[a-z0-9_-]+)?\.(example|sample|template)$/

/**
 * Folders whose files mention a configuration rather than state the
 * service's: an example, documentation, a test and its fixtures. A finding of
 * one is a `mention`, whatever the file.
 */
const MENTION_DIRECTORIES: ReadonlySet<string> = new Set([
  'examples',
  'example',
  'docs',
  'doc',
  'test',
  'tests',
  '__tests__',
  'spec',
  'fixtures',
  '__fixtures__',
  'e2e',
])

/** Source code, by extension: not read for dependencies in slice 1, and said apart from a format with no rule (brief § 9). */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.rs',
  '.scala',
  '.swift',
  '.ex',
  '.exs',
  '.vue',
])

/** A credential folder by its own name, and what it holds. */
function directoryReason(lower: string): ByDesign | undefined {
  if (CREDENTIAL_DIRECTORIES.has(lower)) {
    switch (lower) {
      case '.git':
        return 'git'
      case '.ssh':
      case '.gnupg':
        return 'key-material'
      case '.kube':
        return 'kubeconfig'
      case '.terraform':
        return 'terraform-state'
      case '.docker':
        return 'credential-store'
      default:
        return 'cloud-credentials'
    }
  }
  // A folder named for what it holds, as the snapshot refuses to descend it.
  if (CREDENTIAL_STEMS.has(lower)) return lower === 'kubeconfig' ? 'kubeconfig' : 'credential-store'
  return undefined
}

/** A credential file by its own name, the snapshot's rules in the snapshot's order, the sample family let through. */
function fileReason(lower: string): ByDesign | undefined {
  if (isEnvironmentName(lower) && !SAMPLE.test(lower)) return 'environment-file'
  if (lower === '.git') return 'git'
  if (PRIVATE_KEY_NAMES.has(lower)) return 'key-material'
  if (CREDENTIAL_NAMES.has(lower)) return 'credential-store'
  // Up to the FIRST dot, as the snapshot reads it: a file named for what it
  // holds keeps that name through every suffix someone appends to it.
  const stem = lower.split('.')[0] ?? lower
  if (CREDENTIAL_STEMS.has(stem)) return stem === 'kubeconfig' ? 'kubeconfig' : 'credential-store'
  if (lower.endsWith('.tfstate.backup') || lower.endsWith('.tfvars.json')) return 'terraform-state'
  const extension = path.posix.extname(lower)
  if (SECRET_EXTENSIONS.has(extension)) {
    return extension === '.tfvars' || extension === '.tfstate' ? 'terraform-state' : 'key-material'
  }
  return undefined
}

/**
 * Why a path is never opened, or undefined. Every folder of it first, then its
 * name, each lowercased: `.ssh/package.json` and `.SSH/package.json` are never
 * opened, whatever the allow-list says of `package.json`. The cost, in the
 * safe direction, is the snapshot's: `packages/auth/package.json` is named
 * and not read.
 */
export function neverOpened(file: string): ByDesign | undefined {
  const segments = segmentsOf(file)
  for (const folder of segments.slice(0, -1)) {
    const reason = directoryReason(folder)
    if (reason !== undefined) return reason
  }
  return fileReason(segments.at(-1) ?? '')
}

/** Generated or vendored: a segment in the snapshot's list, so `node_modules/pg/package.json` is never read as the service's. */
export function isGenerated(file: string): boolean {
  return segmentsOf(file)
    .slice(0, -1)
    .some((folder) => GENERATED_DIRECTORIES.has(folder))
}

/** Source code, by its extension. */
export function isCode(file: string): boolean {
  return CODE_EXTENSIONS.has(path.posix.extname(file.toLowerCase()))
}

/**
 * The extractor, the format and the file's standing of an allow-listed path,
 * or undefined: `package.json` and the sample family, at any depth, and
 * nothing else. The read asks `neverOpened` and `isGenerated` first.
 */
export function allowed(file: string): Allowed | undefined {
  const segments = segmentsOf(file)
  const name = segments.at(-1) ?? ''
  const mention = segments.slice(0, -1).some((folder) => MENTION_DIRECTORIES.has(folder))
  if (name === 'package.json') return { extractor: 'npm', format: 'json', standing: mention ? 'mention' : 'evidence' }
  if (SAMPLE.test(name)) return { extractor: 'env-file', format: 'dotenv', standing: mention ? 'mention' : 'sample' }
  return undefined
}

/** A dotenv key, `export` or not: the name before `=`, a comment line being none. */
const DOTENV_KEY = /^\s*(?:export\s+)?([^\s=#]+)\s*=/

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A document SOPS encrypted, or one that holds a Secret: what it is, or undefined. */
function discardedDocument(value: unknown): 'discarded-sops' | 'discarded-secret' | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value['sops'])) return 'discarded-sops'
  if (value['kind'] === 'Secret' || value['kind'] === 'SealedSecret') return 'discarded-secret'
  return undefined
}

/**
 * Whether a file is discarded whole, after parsing, before any extraction: a
 * dotenv file with a `sops_*` key, a JSON file with a top-level `sops` object,
 * and a YAML document of `kind: Secret` or `SealedSecret` or with a top-level
 * `sops`. Recognising them requires parsing them (brief § 8), so "never
 * opened" would promise what the reader cannot do; nothing in one becomes a
 * finding, and no field of it is kept.
 *
 * A YAML stream that cannot be read whole — a document the parser faulted, an
 * alias bomb past `readDocuments`'s bound, more documents than
 * `maxYamlDocuments` — cannot be shown to hold no Secret, so it is a
 * `parse-failure` and nothing of it is read either. A JSON file that does not
 * parse is not discarded here: no extractor reads it, and the npm extractor
 * (1.4) says why in a closed reason of its own. No parser's message is kept:
 * it quotes the bytes around the fault.
 */
export function discardedWhole(
  text: string,
  format: FileFormat,
): 'discarded-sops' | 'discarded-secret' | 'parse-failure' | undefined {
  switch (format) {
    case 'dotenv': {
      for (const line of text.split(/\r?\n/)) {
        const key = DOTENV_KEY.exec(line)?.[1]
        if (key !== undefined && key.toLowerCase().startsWith('sops_')) return 'discarded-sops'
      }
      return undefined
    }
    case 'json': {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        return undefined
      }
      return isRecord(value) && isRecord(value['sops']) ? 'discarded-sops' : undefined
    }
    case 'yaml': {
      let readings
      try {
        readings = readDocuments(text)
      } catch {
        return 'parse-failure'
      }
      if (readings.length > DISCOVERY_LIMITS.maxYamlDocuments) return 'parse-failure'
      for (const reading of readings) {
        if ('error' in reading) return 'parse-failure'
        const discarded = discardedDocument(reading.value)
        if (discarded !== undefined) return discarded
      }
      return undefined
    }
    default: {
      const _exhaustive: never = format
      return _exhaustive
    }
  }
}

/** The words for a path not read by design (brief § 9), which the report prints beside it. */
export function byDesignReason(why: ByDesign): string {
  switch (why) {
    case 'environment-file':
      return 'a real environment file, never opened'
    case 'key-material':
      return 'key material, never opened'
    case 'credential-store':
      return 'a file or folder that exists to hold a credential, never opened'
    case 'git':
      return 'git’s own files, never opened'
    case 'cloud-credentials':
      return 'a cloud provider’s credentials folder, never opened'
    case 'kubeconfig':
      return 'a kubeconfig, never opened'
    case 'terraform-state':
      return 'Terraform state or variables, which hold secrets in clear, never opened'
    case 'discarded-sops':
      return 'encrypted with SOPS, discarded whole'
    case 'discarded-secret':
      return 'a Secret or a SealedSecret, discarded whole'
    default: {
      const _exhaustive: never = why
      return _exhaustive
    }
  }
}

/** The words for a path not analysed (brief § 9), which the report prints beside it. */
export function notAnalysedReason(why: NotAnalysed): string {
  switch (why) {
    case 'no-rule':
      return 'no rule for this format'
    case 'code':
      return 'code, not read for dependencies'
    case 'generated':
      return 'generated or vendored'
    case 'over-size':
      return `over the ${String(DISCOVERY_LIMITS.maxFileBytes)}-byte size cap, and never cut`
    case 'not-committed':
      // Said only of a path `HEAD` holds: one it does not hold is never named.
      return 'not committed: changed since HEAD'
    case 'deleted':
      return 'tracked, not in the working tree: deleted, or not checked out'
    case 'head-unlisted':
      return 'HEAD could not be listed whole'
    case 'link':
      return 'a link, or a file with a second name, not followed'
    case 'not-a-file':
      return 'not a regular file'
    case 'unreadable':
      return 'it could not be read'
    case 'changed-during-run':
      return 'changed during the run'
    case 'parse-failure':
      return 'it could not be parsed'
    case 'over-finding-cap':
      return 'over the finding cap of a file'
    case 'past-run-cap':
      return 'past the run’s finding cap'
    default: {
      const _exhaustive: never = why
      return _exhaustive
    }
  }
}
