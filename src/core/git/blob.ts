import { createHash } from 'node:crypto'

/**
 * A blob's id computed here rather than asked of git, one call instead of one
 * per file. Measured equal to `git hash-object` for sha1; sha256 repositories
 * hash the same header with the other function.
 *
 * Moved here from `forge/local/objects.ts`, which re-exports it, so stage 8's
 * discovery read can compare the bytes it read with `HEAD`'s blob for that
 * path: `core/` may import nothing of `forge/`.
 */
export function blobId(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex')
}
