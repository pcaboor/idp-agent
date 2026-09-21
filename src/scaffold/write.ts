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
    await io.mkdir(path.dirname(absolute))

    try {
      if (await io.writeNew(absolute, file.content)) written.push(file.path)
      else kept.push(file.path)
    } catch (error) {
      // Named, and only what was genuinely written is reported.
      throw new Error(
        `could not write ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return { written, kept }
}
