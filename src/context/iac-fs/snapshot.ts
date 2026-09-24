import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RepositoryFile, RepositorySnapshot } from '../../core/validate/rules.js'
import { parseDocuments } from '../../core/yaml/serialize.js'

/**
 * Reads a repository laid out the way `init platform` produces one, keeping
 * the provenance a ContextProvider throws away: every rule in
 * `core/validate/` is anchored on a path, so the path has to survive the read.
 *
 * This is also the reading half of the `iac-fs` provider design § 3 schedules
 * for stage 4.
 */


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
      // A hidden directory is tooling, not catalogue: .github holds workflows
      // that are YAML and are not entities, .git holds objects. Parsing them
      // as entities would make the repository this tool just scaffolded fail
      // its own validator — which is how this rule was found.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      await walk(root, full, found)
      continue
    }
    // And a hidden FILE is tooling for the same reason, which the rule above
    // did not say for far longer than it looks. `.idp-agent.yml` is §7.0's
    // configuration — this tool's own file, at the root every repository puts
    // it — and it was read as a catalogue entry, rejected as `invalid-entity`,
    // and `recheckPlan` then refused a whole plan on one of those. So `plan` could
    // not land in a CONFIGURED repository at all, while every fixture that had
    // no config passed. `.witness.yml` needed no rule of its
    // own once this one existed, and its named skip went with it.
    if (entry.name.startsWith('.')) continue
    if (YAML_EXTENSIONS.has(path.extname(entry.name))) found.files.push(full)
  }
}

async function readOne(root: string, absolute: string): Promise<RepositoryFile> {
  const where = relative(root, absolute)
  let content: string
  try {
    content = await readFile(absolute, 'utf8')
  } catch (error) {
    // A file the walk found and the read could not open — no permission, a
    // link to a directory or to nothing, a file deleted in between. One of
    // those ended `validate` on a stack trace that reported none of the other
    // files; it is a rejection for this path instead, the same shape as a
    // document the schema refused, and `invalid-entity` reports it.
    const why = (error as NodeJS.ErrnoException).code ?? String(error)
    return { path: where, entities: [], rejections: [`could not be read: ${why}`], documents: 0 }
  }

  // The same reader `core/` uses on the bytes a plan would write, so a file
  // cannot be conformant here and broken there.
  return { path: where, ...parseDocuments(content) }
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
