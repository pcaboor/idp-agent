import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * "Preview only — writes nothing" is the claim every command in this stage
 * makes, and this is how it is checked: a hash of the whole tree either side of
 * a run, rather than a sentence in a comment.
 *
 * It lives here rather than in one test file because three suites now make that
 * claim — `plan --from`, `plan "<intent>"` and `init --repo` — and three copies
 * of a checker are three chances for one of them to check less than the others.
 * That has already happened once inside a single file: hashing contents alone
 * let an added file pass, and hashing files alone let an `mkdir` pass a check
 * named "writes nothing".
 */

/**
 * Every ENTRY under `root`, repository-relative, POSIX, dotfiles included —
 * directories among them, marked with a trailing slash.
 */
export async function entriesUnder(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      if (entry.isDirectory()) return [`${relative}/`, ...(await entriesUnder(root, full))]
      return [relative]
    }),
  )
  return found.flat()
}

/**
 * Paths as well as contents, and directories as well as files. Hashing contents
 * alone would let a file appear or disappear without moving the digest, and an
 * added file is exactly the failure "writes nothing" is a claim about. Hashing
 * files alone let an mkdir pass the very check that names it.
 */
export async function hashTree(root: string): Promise<string> {
  const entries = (await entriesUnder(root)).sort()
  const digest = createHash('sha256')
  for (const entry of entries) {
    digest.update(entry)
    digest.update('\x00')
    // A directory has no bytes; its presence in the list is the whole point.
    if (!entry.endsWith('/')) {
      digest.update(await readFile(path.join(root, ...entry.split('/'))))
    }
    digest.update('\x00')
  }
  return digest.digest('hex')
}

/**
 * Both repositories at once, for a command that reads one and previews changes
 * to the other.
 *
 * Hashing only the declarations repository left every other outcome path free
 * to write into the user's OWN repository unseen — and the Inspector is the
 * half that stands in it. "Writes nothing" is a claim about every directory a
 * run touches, not about the one the diff is for.
 */
export async function hashBoth(declarations: string, project: string): Promise<string> {
  return `${await hashTree(declarations)}·${await hashTree(project)}`
}
