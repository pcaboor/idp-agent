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
 * A repository-relative path that cannot leave the tree.
 *
 * Checked here as well as in `assertInsideRepo` on purpose: this runs on values
 * read from an entity annotation, which an agent or a repository file controls,
 * and a caller that forgets the containment check should still be safe.
 */
function assertRelativeSafe(candidate: string): string {
  if (candidate === '' || candidate.includes(NUL) || path.isAbsolute(candidate)) {
    throw new PathEscapeError(candidate)
  }
  const normalised = path.normalize(candidate)
  // Segment equality, not a prefix test: `..foo` is a legitimate file name and
  // must not be mistaken for a traversal.
  if (normalised === '.' || normalised.split(path.sep).includes('..')) {
    throw new PathEscapeError(candidate)
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
  if (declared !== undefined && declared !== '') return assertRelativeSafe(declared)
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
