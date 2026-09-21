import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import { entitySchema } from '../../core/schemas/entity.js'
import type { Entity } from '../../core/schemas/entity.js'
import type { RepositoryFile, RepositorySnapshot } from '../../core/validate/rules.js'

/**
 * Reads a repository laid out the way `init platform` produces one, keeping
 * the provenance a ContextProvider throws away: every rule in
 * `core/validate/` is anchored on a path, so the path has to survive the read.
 *
 * This is also the reading half of the `iac-fs` provider design § 3 schedules
 * for stage 4.
 */

/**
 * Zod puts the offending field in the issue's path and not in its message, so
 * `issues[0].message` alone says something is wrong without saying what. The
 * dotted path is the half a reader needs — the same form `findUnknowns`
 * already reports for a Plan.
 */
function reasonOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid entity'
  const where = issue.path.map(String).join('.')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}

const YAML_EXTENSIONS = new Set(['.yml', '.yaml'])
const WITNESS = '.witness.yml'

/** POSIX separators whatever the platform: a violation names a path a human types. */
const relative = (root: string, absolute: string): string =>
  path.relative(root, absolute).split(path.sep).join('/')

interface Walked {
  folders: string[]
  witnesses: string[]
  files: string[]
}

async function walk(root: string, directory: string, found: Walked): Promise<void> {
  // readdir, never a glob: a witness is a dotfile, and the rule that makes an
  // empty folder an error rests entirely on seeing it.
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return

  const here = relative(root, directory)
  if (here !== '') found.folders.push(here)
  if (entries.some((entry) => entry.isFile() && entry.name === WITNESS)) {
    found.witnesses.push(here)
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      await walk(root, full, found)
      continue
    }
    if (entry.name === WITNESS) continue
    if (YAML_EXTENSIONS.has(path.extname(entry.name))) found.files.push(full)
  }
}

async function readOne(root: string, absolute: string): Promise<RepositoryFile> {
  const content = await readFile(absolute, 'utf8')
  const entities: Entity[] = []
  const rejections: string[] = []
  let documents = 0

  for (const document of parseAllDocuments(content)) {
    const value: unknown = document.toJS()
    documents += 1
    // A null document declares nothing — a comment-only file is one, and that
    // is what a witness is made of.
    if (value === null || value === undefined) continue

    const parsed = entitySchema.safeParse(value)
    if (parsed.success) entities.push(parsed.data)
    else rejections.push(reasonOf(parsed.error))
  }

  return { path: relative(root, absolute), entities, rejections, documents }
}

export async function readRepository(root: string): Promise<RepositorySnapshot> {
  const found: Walked = { folders: [], witnesses: [], files: [] }
  await walk(root, root, found)

  const files = await Promise.all(found.files.sort().map((file) => readOne(root, file)))

  return {
    folders: found.folders.sort(),
    witnesses: found.witnesses.sort(),
    files,
  }
}
