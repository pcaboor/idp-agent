import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createNew, makeFolders, realRootOf } from '../confine/confine.js'
import { assertInsideRepo } from '../core/paths/entity-path.js'
import type { ScaffoldFile } from './layout.js'

/**
 * The only module in `scaffold/` that writes. It stays the writer for a
 * repository being created — `init platform` makes one, and a repository being
 * created has no branch to write to; a branch in an existing one is
 * `forge/local/`'s (ADR-0010).
 */

export interface WriteReport {
  readonly written: readonly string[]
  readonly kept: readonly string[]
}

/**
 * A write that failed part-way, with what came before it.
 *
 * `writeNew` never deletes and nothing here rolls back, so a failure leaves
 * the files already written on the disk, and the only honest report of that is
 * the list. It was lost: the error named the file that failed and none of the
 * ones before it, so `init platform` could not say what it had left behind
 * (gap-stage5-readiness-7). The message is the one it always was.
 */
export class ScaffoldWriteError extends Error {
  constructor(
    /** Repository-relative, as a `ScaffoldFile` names it. */
    readonly failed: string,
    readonly written: readonly string[],
    readonly kept: readonly string[],
    reason: string,
  ) {
    super(`could not write ${failed}: ${reason}`)
    this.name = 'ScaffoldWriteError'
  }
}

/** Injected so a failing write is testable without a read-only filesystem. */
export interface FileIO {
  mkdir(absoluteDir: string): Promise<void>
  /** Returns false when the file already exists. Never clobbers, never deletes. */
  writeNew(absoluteFile: string, content: string): Promise<boolean>
}

/**
 * The disk, confined to `root` physically as well as by name (runtime-probe-11,
 * core-yaml-5). `assertInsideRepo` below is lexical: `catalog -> ../outside`
 * passed it, and three witnesses were written outside. Every folder is made
 * one name at a time and every file created with `O_EXCL | O_NOFOLLOW`
 * (`confine/`), so a folder on the way that is a link — to outside, to
 * inside or to nothing — is refused by name, a link where a file goes is kept
 * as a file there is, and nothing is written through either. `root` itself is
 * the directory the user named, by whatever path, and is made when it does
 * not exist yet, as it always was.
 */
async function confinedIO(root: string): Promise<FileIO> {
  const named = path.resolve(root)
  await mkdir(named, { recursive: true })
  const real = await realRootOf(named)
  // Every path handed in came out of `assertInsideRepo(root, …)`, so it is
  // `named` joined with a relative path that stays under it.
  const under = (absolute: string): string => path.relative(named, absolute)
  return {
    mkdir: (directory) => makeFolders(real, under(directory)),
    writeNew: (file, content) => createNew(real, under(file), content),
  }
}

export async function writeScaffold(
  root: string,
  files: readonly ScaffoldFile[],
  io?: FileIO,
): Promise<WriteReport> {
  const written: string[] = []
  const kept: string[] = []

  let disk = io
  if (disk === undefined) {
    try {
      disk = await confinedIO(root)
    } catch (error) {
      // The root could not be made or resolved: the first file is where it
      // stopped, as when its folder could not be made, with nothing written.
      const first = files[0]
      if (first === undefined) return { written, kept }
      const reason = error instanceof Error ? error.message : String(error)
      throw new ScaffoldWriteError(first.path, [], [], reason)
    }
  }

  for (const file of files) {
    // Every path through the same check the entity writer uses: a template
    // naming `../` must not reach outside the directory the user named.
    const absolute = assertInsideRepo(root, file.path)

    try {
      // Inside, so a folder that cannot be made — a file already where it
      // belongs — is reported as the file it was for, with the same list.
      await disk.mkdir(path.dirname(absolute))
      if (await disk.writeNew(absolute, file.content)) written.push(file.path)
      else kept.push(file.path)
    } catch (error) {
      // Named, and only what was genuinely written is reported.
      throw new ScaffoldWriteError(
        file.path,
        [...written],
        [...kept],
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return { written, kept }
}
