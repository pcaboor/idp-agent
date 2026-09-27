import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertInsideRepo } from '../core/paths/entity-path.js'
import type { ScaffoldFile } from './layout.js'

/**
 * The only module in `scaffold/` that writes. Stage 5's atomic applier
 * replaces this seam, which is why it is one file and not five.
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

const realIO: FileIO = {
  mkdir: async (directory) => void (await mkdir(directory, { recursive: true })),
  writeNew: async (file, content) => {
    try {
      // 'wx' is the whole guarantee: it fails rather than truncate. Checking
      // for existence first would leave a window where a concurrent write is
      // silently lost.
      await writeFile(file, content, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  },
}

export async function writeScaffold(
  root: string,
  files: readonly ScaffoldFile[],
  io: FileIO = realIO,
): Promise<WriteReport> {
  const written: string[] = []
  const kept: string[] = []

  for (const file of files) {
    // Every path through the same check the entity writer uses: a template
    // naming `../` must not reach outside the directory the user named.
    const absolute = assertInsideRepo(root, file.path)

    try {
      // Inside, so a folder that cannot be made — a file already where it
      // belongs — is reported as the file it was for, with the same list.
      await io.mkdir(path.dirname(absolute))
      if (await io.writeNew(absolute, file.content)) written.push(file.path)
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
