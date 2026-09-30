import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { LinkRefused, openToRead, realRootOf } from '../../confine/confine.js'
import {
  repositoryFileOf,
  type RepositoryFile,
  type RepositorySnapshot,
  type UnreadableFolder,
} from '../../core/validate/rules.js'
import { REGISTRATION_FILE } from '../../core/validate/registration.js'
import { isCatalogueFolder, isCataloguePath } from '../../core/paths/catalogue.js'

/**
 * Reads a repository laid out the way `init platform` produces one, keeping
 * the provenance a ContextProvider throws away: every rule in
 * `core/validate/` is anchored on a path, so the path has to survive the read.
 *
 * This is also the reading half of the `iac-fs` provider design § 3 schedules
 * for stage 4.
 */


const WITNESS = '.witness.yml'

/**
 * Why a symbolic link is not read. A declarations repository holds none: the
 * one `init platform` writes holds none, the forge refuses one tracked in
 * `HEAD`, and a reviewer reads the file a link names while the gates would
 * judge the one it leads to (gap-stage5-readiness-4). So every link the walk
 * meets is named for what it is, and nothing is read through it — inside or
 * out, to a file, to a folder or to nothing.
 */
const LINK = 'a symbolic link, never followed'

/** POSIX separators whatever the platform: a violation names a path a human types. */
const relative = (root: string, absolute: string): string =>
  path.relative(root, absolute).split(path.sep).join('/')

interface Walked {
  folders: string[]
  witnesses: string[]
  files: string[]
  unreadable: UnreadableFolder[]
}

async function walk(root: string, directory: string, found: Walked): Promise<void> {
  // readdir, never a glob: a witness is a dotfile, and the rule that makes an
  // empty folder an error rests entirely on seeing it.
  //
  // A folder it cannot list is kept, with why, and never read as an empty
  // one: that swallowed every entity under a folder at chmod 000, and
  // `validate` called the repository compliant (review, runtime-probe-3).
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error)
    found.unreadable.push({ path: relative(root, directory), reason })
    return
  }

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
      if (!isCatalogueFolder(entry.name)) continue
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
    const where = relative(root, full)
    if (isCataloguePath(where)) {
      // A link among them too: `readOne` opens with O_NOFOLLOW, and names it.
      found.files.push(full)
      continue
    }
    // A link by any other name was dropped here in silence, and a link to a
    // folder is one: `catalog/caches -> ../outside` held entities nobody
    // checked, and `validate` said nothing. It is not followed to learn
    // whether it is a folder the walk would have entered, so every link the
    // walk would have looked at is named beside the folders it could not
    // list — as a link, since `NOTES.md -> README.md` is no folder, and
    // nothing says it could not be listed. A hidden one is tooling whatever
    // it leads to, as a hidden folder is.
    if (entry.isSymbolicLink() && isCatalogueFolder(entry.name)) {
      found.unreadable.push({ path: where, reason: LINK, link: true })
    }
  }
}

async function readOne(root: string, absolute: string): Promise<RepositoryFile> {
  const where = relative(root, absolute)
  let content: string
  try {
    // Through a descriptor that cannot be a link (`confine/`): a link was
    // followed here, wherever it pointed, so a `.yml` linked outside the
    // repository was read, previewed and judged as though it were in it.
    const handle = await openToRead(root, absolute)
    try {
      content = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    // A file the walk found and the read could not open — no permission, a
    // link, a file deleted in between. One of those ended `validate` on a
    // stack trace that reported none of the other files; it is a rejection
    // for this path instead, the same shape as a document the schema refused,
    // and `invalid-entity` reports it.
    const why =
      error instanceof LinkRefused
        ? `not read: ${error.through ? `reached through ${LINK}` : LINK}`
        : `could not be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    return {
      path: where,
      entities: [],
      apis: [],
      rejections: [why],
      ignored: [],
      documents: 0,
    }
  }

  // The same reader `core/` uses on the bytes a plan would write, so a file
  // cannot be conformant here and broken there.
  return repositoryFileOf(where, content)
}

/**
 * The two roots `init platform` lays its witnessed folders under. Exported for
 * `cli/repository.ts`, which refuses to inspect a folder under either as a
 * service's repository.
 */
export const DECLARATION_ROOTS = ['catalog', 'dependencies'] as const

/**
 * Whether `directory` is a declarations repository, told by its markers: a
 * `catalog/` or a `dependencies/` holding at least one folder with a witness in
 * it, which is the layout `init platform` writes. An application repository
 * declares itself in a `catalog-info.yaml` at its root and has neither.
 *
 * One `readdir` of the root, one of each of those two and one `lstat` per
 * folder they list, never a walk: this runs wherever `ask` is typed, $HOME
 * included, and a guess about the directory must not cost a scan of it. A
 * declarations repository one folder down is therefore not found, which is
 * right — `--repo` names it.
 *
 * Entries are judged as `walk` judges them, by what `readdir` reports, so a
 * `catalog/` that is a symbolic link is not followed here because it is not
 * followed there, and a root that can be searched but not listed is a no
 * because `walk` cannot list it: saying yes would announce a repository and
 * then read nothing. Anything unreadable is a no, and the demo SI is read, as
 * without this.
 */
export async function isDeclarationsRepository(directory: string): Promise<boolean> {
  const top = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const name of DECLARATION_ROOTS) {
    if (!top.some((entry) => entry.name === name && entry.isDirectory())) continue
    const folder = path.join(directory, name)
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const witness = await lstat(path.join(folder, entry.name, WITNESS)).catch(() => undefined)
      if (witness?.isFile() === true) return true
    }
  }
  return false
}

/**
 * What an application repository carries at its root: the file Backstage
 * registers a service by, or the manifest of the language it is built in.
 * `.csproj` is a suffix, and matched as one below.
 */
export const APPLICATION_MARKERS = [
  'catalog-info.yaml',
  'catalog-info.yml',
  'package.json',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
] as const

const PROJECT_SUFFIX = '.csproj'

const isMarker = (name: string): boolean =>
  (APPLICATION_MARKERS as readonly string[]).includes(name) ||
  (name.endsWith(PROJECT_SUFFIX) && name.length > PROJECT_SUFFIX.length)

/**
 * Whether `directory` is an application repository — the service a plan may
 * inspect when no `--project` names one: a regular file among
 * `APPLICATION_MARKERS`, or a `*.csproj`, at its root, and not a declarations
 * repository whatever else sits there.
 *
 * At the root only, one `readdir`, for the reason `isDeclarationsRepository`
 * gives: `idpa` is typed from anywhere, $HOME included, and $HOME holds a
 * service or two a few folders down. A yes hands the directory to a model, so
 * a no is the answer whenever there is doubt — anything unreadable, a marker
 * that is a directory or a symbolic link — and a run that said no drafts from
 * the catalogue alone, which `--project` corrects.
 */
export async function isApplicationRepository(directory: string): Promise<boolean> {
  if (await isDeclarationsRepository(directory)) return false
  const top = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return top.some((entry) => entry.isFile() && isMarker(entry.name))
}

/**
 * The repository's root `catalog-info.yaml`, read as `readRepository` reads it,
 * or undefined when there is no regular file by that name. What `init platform`
 * asks of a file it kept: does it register the repository with Backstage?
 */
export async function readRegistrationFile(root: string): Promise<RepositoryFile | undefined> {
  const real = await realOrAsNamed(root)
  const absolute = path.join(real, REGISTRATION_FILE)
  const entry = await lstat(absolute).catch(() => undefined)
  if (entry?.isFile() !== true) return undefined
  return readOne(real, absolute)
}

/**
 * The root every path is judged against, with no link left in it: the
 * directory the user named is theirs, by whatever path, and below it nothing
 * is followed. One that does not resolve is walked as named, and `walk` says
 * it could not be listed.
 */
const realOrAsNamed = (root: string): Promise<string> =>
  realRootOf(root).catch(() => path.resolve(root))

/**
 * The text of one file `readRepository` listed, read as it reads one: through
 * a descriptor that is never a link, inside the root. For `plan`, which
 * composes its edits against bytes the snapshot does not keep — it read them
 * with `readFile`, through any link, so a `.yml` linked outside the repository
 * was diffed although the snapshot refused it. A link throws the refusal
 * `confine/` names it with; anything else, the error with its code.
 */
export async function readRepositoryText(root: string, file: string): Promise<string> {
  const real = await realOrAsNamed(root)
  const handle = await openToRead(real, path.join(real, ...file.split('/')))
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

export async function readRepository(root: string): Promise<RepositorySnapshot> {
  const found: Walked = { folders: [], witnesses: [], files: [], unreadable: [] }
  const real = await realOrAsNamed(root)
  await walk(real, real, found)

  const files = await Promise.all(found.files.sort().map((file) => readOne(real, file)))

  return {
    folders: found.folders.sort(),
    witnesses: found.witnesses.sort(),
    files,
    // Omitted when there is none, which is every repository anyone can read,
    // so a snapshot compares equal to the one it always was.
    ...(found.unreadable.length > 0
      ? { unreadable: found.unreadable.sort((left, right) => left.path.localeCompare(right.path)) }
      : {}),
  }
}
