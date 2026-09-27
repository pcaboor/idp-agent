import path from 'node:path'
import { SOURCE_FILE_ANNOTATION, type Entity } from '../schemas/entity.js'
import { folderOf, type ResourceType } from '../schemas/resource-types.js'

export class PathEscapeError extends Error {
  constructor(candidate: string) {
    // The candidate is quoted and escaped: it may come from a model or from a
    // repository file, and printing it raw would let it forge the log line.
    super(`path escapes the repository: ${JSON.stringify(candidate)}`)
    this.name = 'PathEscapeError'
  }
}

/** A NUL truncates a path inside a syscall, so a check before it sees nothing. */
const NUL = String.fromCharCode(0)

/**
 * A relative path, in the platform's own form, that cannot leave the tree.
 *
 * Checked by segments as well as by `assertInsideRepo`'s containment test, on
 * purpose: a caller whose root is itself wrong should still be refused a `..`.
 * The platform's form, because `assertInsideRepo` hands the path to
 * `path.resolve`; an annotation is in the repository's form, and is read by
 * `assertAnnotationSafe` below.
 */
function assertRelativeSafe(candidate: string): void {
  if (candidate === '' || candidate.includes(NUL) || path.isAbsolute(candidate)) {
    throw new PathEscapeError(candidate)
  }
  const normalised = path.normalize(candidate)
  // Segment equality, not a prefix test: `..foo` is a legitimate file name and
  // must not be mistaken for a traversal.
  if (normalised === '.' || normalised.split(path.sep).includes('..')) {
    throw new PathEscapeError(candidate)
  }
}

/**
 * The path an entity's annotation names, as the repository writes it.
 *
 * A path in a repository is written with `/` on every platform — git's own
 * form, and the form `validate` compares against — so it is normalised the
 * POSIX way here, never by `path.normalize`: on Windows that turned every `/`
 * into `\`, and an entity filed exactly where its annotation says was
 * reported misplaced (review, product-gap-14). A backslash is read as a
 * separator for the refusal all the same, and a drive letter or a `\` root as
 * absolute, on every platform: one repository gets one verdict, from CI on
 * Linux and from a laptop on Windows alike.
 */
function assertAnnotationSafe(candidate: string): string {
  const normalised = path.posix.normalize(candidate)
  // The backslash read as a separator BEFORE normalising, too: to the POSIX
  // module `a\..` is one segment, and the `..` after it cancelled it, so
  // `a\../../x.yml` came out `x.yml` where Windows reads `..\x.yml`.
  const separated = path.posix.normalize(candidate.replaceAll('\\', '/'))
  // Every form is judged, the one returned included: `x/../C:\x.yml` is
  // relative as written and absolute once normalised.
  for (const form of [candidate, normalised, separated]) {
    if (
      form.includes(NUL) ||
      path.posix.isAbsolute(form) ||
      path.win32.isAbsolute(form) ||
      /^[A-Za-z]:/.test(form)
    ) {
      throw new PathEscapeError(candidate)
    }
  }
  for (const form of [normalised, separated]) {
    if (form === '.' || form.split(/[\\/]/).includes('..')) {
      throw new PathEscapeError(candidate)
    }
  }
  return normalised
}

/**
 * Convention for a new entity. The model never chooses this: it supplies a name
 * and a type, and the folder follows from the type's nature.
 */
export function computeEntityPath(type: ResourceType, name: string): string {
  if (
    name === '' ||
    name.includes(NUL) ||
    name.includes('/') ||
    name.includes('\\') ||
    name.startsWith('.')
  ) {
    throw new PathEscapeError(name)
  }
  return `${folderOf(type)}/${name}.yml`
}

/**
 * Where an entity actually lives. Read from the entity when it says so; only
 * derived from its type when it does not (design 5.2). If someone filed an
 * entity elsewhere, the change goes where it is, not where convention wants it.
 */
export function resolveEntityPath(entity: Entity): string {
  const declared = entity.metadata.annotations[SOURCE_FILE_ANNOTATION]
  if (declared !== undefined && declared !== '') return assertAnnotationSafe(declared)
  if (entity.kind === 'Component') {
    throw new Error('a Component has no conventional location; it lives in its own repository')
  }
  return computeEntityPath(entity.spec.type, entity.metadata.name)
}

/**
 * Resolve `candidate` against `repoRoot` and refuse anything landing outside.
 * Compares against `repoRoot + sep` so `/repo-evil` is never accepted for `/repo`,
 * and refuses the root itself, which is a directory rather than a file.
 */
export function assertInsideRepo(repoRoot: string, candidate: string): string {
  assertRelativeSafe(candidate)
  const root = path.resolve(repoRoot)
  const resolved = path.resolve(root, candidate)
  if (!resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(candidate)
  }
  return resolved
}
