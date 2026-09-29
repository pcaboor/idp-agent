import { isUtf8 } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { assertInsideRepo, PathEscapeError } from '../../core/paths/entity-path.js'
import { GitError, gitIn } from '../../process/git.js'
import { secretIn, type SecretClass } from './secrets.js'
import type { Declaration, ProjectFile, ProjectRead, Selection, SkippedFile } from './types.js'

/**
 * Reads the APPLICATION repository — the one a service lives in, not the
 * declarations repository `iac-fs/snapshot.ts` reads.
 *
 * Design § 6 gives the Inspector "the local repository" as its input, and says
 * in the same breath that it is confined to it: escaping paths refused, `.env`,
 * `.git/` and key files excluded, size capped. The reading lives here rather
 * than in `agents/` because no module reachable from `agents/` may import a
 * filesystem — an architecture test walks the import closure to keep that true
 * — so the bytes are read on this side of the line and handed over.
 *
 * Everything this module returns is on its way to a MODEL, over a network, at a
 * third party. That single fact is the reason for every rule below, and the
 * reason each one errs towards returning less: a file wrongly skipped is a fact
 * an Inspector will report as unknown, which is recoverable; a key wrongly
 * returned is not.
 *
 * What this does NOT do: judge, parse, or summarise. It returns text and the
 * list of what it refused to return. `agents/inspector.ts` turns that into
 * `ProjectFacts`.
 */

export const PROJECT_LIMITS = {
  /**
   * `skipped` travels in the same snapshot as `files` and reaches the same
   * model, so a cap on what is read is not a cap on what is sent: a project of
   * fifty thousand excluded files produced a multi-megabyte snapshot with
   * `truncated: false`. Bounded too, and its own overflow is stated.
   */
  maxSkipped: 500,
  maxFiles: 200,
  maxFileBytes: 65_536,
  maxTotalBytes: 1_048_576,
} as const

/**
 * The shapes live in `types.ts`, which imports nothing. `agents/` has to
 * name `ProjectSnapshot` and the architecture test walks its import closure, so
 * a type reachable only through this module would drag `node:fs/promises` into
 * that closure. Re-exported here so this file stays the one import site for
 * everyone who wants the bytes as well as the shape.
 */
export type {
  ProjectFile,
  Declaration,
  ProjectRead,
  ProjectSnapshot,
  Selection,
  SkippedFile,
} from './types.js'

/**
 * A walk budget the three public caps do not provide. They bound what is READ
 * and what is SENT, which is the security property; this bounds the walk
 * itself, so a directory graph made pathological by symlinks cannot hold the
 * process. Internal on purpose: it is a floor against abuse, not a knob.
 */
const MAX_DIRECTORIES = 5_000

/**
 * What a secret looks like INSIDE a file lives in `secrets.ts`, as data: key
 * material, the shapes issuers stamp on their tokens, and a secret assigned a
 * literal. It is the backstop for "a name is its author's to choose", and it is
 * applied to every file this module is about to hand over, whatever its name.
 * Everything below is about names, places and git.
 */

/**
 * Directories holding credentials rather than code. `.git/` earns its place
 * twice: `config` carries a remote URL, which carries a token often enough,
 * and the object store is bytes no Inspector can use anyway.
 */
const CREDENTIAL_DIRECTORIES = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  '.gcloud',
  '.azure',
  '.terraform',
])

/**
 * Generated or vendored: someone else's code, or this project's own output.
 * Excluded for the budget rather than for secrecy — the caps are small and a
 * `dist/` sorted before `package.json` would spend them all before reaching the
 * manifest, which is the one file an Inspector genuinely needs.
 */
const GENERATED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
])

/**
 * The one hidden directory read on purpose: a workflow says how a service is
 * built and deployed, which is exactly what `ProjectFacts` is after, and it
 * holds no credential — a workflow names a secret, it does not contain one.
 * Everything else hidden stays unread; that is where `.config/gh/hosts.yml`
 * and its kind live.
 */
const READABLE_HIDDEN_DIRECTORIES = new Set(['.github'])

/**
 * Words that name a file's PURPOSE, matched as the stem rather than the whole
 * name, because every one of these shipped one token away from a listed name:
 * `secret.yml`, `secrets.toml`, `secrets.properties`, `credentials.json`,
 * `auth.json`, `kubeconfig.yaml`, `accessKeys.csv`.
 */
const CREDENTIAL_STEMS = new Set([
  'secret',
  'secrets',
  'credential',
  'credentials',
  'auth',
  'kubeconfig',
  'accesskeys',
  'access-keys',
  'service-account',
  'serviceaccount',
  'vault',
  'passwd',
  'password',
  'passwords',
])

/** Private keys, by the names ssh-keygen actually writes. */
const PRIVATE_KEY_NAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
])

/**
 * Credential files by name. Each one is a file whose entire purpose is to hold
 * a token: a registry auth, an FTP login, a Postgres password, a basic-auth
 * table, a git credential store.
 */
const CREDENTIAL_NAMES = new Set([
  '.npmrc',
  '.yarnrc',
  '.netrc',
  '_netrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  '.pypirc',
  '.dockercfg',
  '.s3cfg',
  '.boto',
  'credentials',
  'secrets.yml',
  'secrets.yaml',
  'secrets.json',
])

/**
 * Extensions that carry key material or state. `.crt` and `.cer` are absent on
 * purpose: a certificate is public by construction. `.pem` is present because
 * it is not — a PEM file is as often a private key as a certificate.
 * `.tfvars` and `.tfstate` are Terraform's two plaintext secret stores, and
 * this is a tool for infrastructure repositories.
 */
const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.p8',
  '.keystore',
  '.jks',
  '.ppk',
  '.asc',
  '.gpg',
  '.kdbx',
  '.tfvars',
  '.tfstate',
])

/** Why this directory is not descended into, or undefined to descend. */
function directoryReason(name: string): string | undefined {
  const lower = name.toLowerCase()
  if (CREDENTIAL_DIRECTORIES.has(lower)) return 'not descended: it holds credentials, not source'
  if (GENERATED_DIRECTORIES.has(lower)) {
    return 'not descended: generated or vendored, not this project’s source'
  }
  if (lower.startsWith('.') && !READABLE_HIDDEN_DIRECTORIES.has(lower)) {
    return 'not descended: a hidden directory is tooling, and tooling is where credentials sit'
  }
  // A directory named for what it holds. The word list applied to basenames
  // only, so `secrets/db.yml` and `credentials/aws.json` walked out under
  // names nothing objected to — the folder said what they were and nobody
  // read the folder.
  if (CREDENTIAL_STEMS.has(lower)) {
    return 'not descended: the directory is named for what it holds'
  }
  return undefined
}

/** Why this file is never read, or undefined to read it. */
/**
 * Hidden files a model may read, and the list is short on purpose.
 *
 * A hidden DIRECTORY was refused and a hidden FILE was not, which is where
 * `.terraformrc`, `.my.cnf`, `.bash_history`, `.gitconfig` and `.vault_pass`
 * walked out. The rule is inverted now: a dotted file is refused unless it is
 * named here, because the ones that carry facts about a project are few and
 * the ones that carry credentials are not enumerable.
 */
const READABLE_HIDDEN_FILES = new Set([
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.ruby-version',
  '.tool-versions',
  '.prettierrc',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.babelrc',
  '.browserslistrc',
])

/** Why this file is never read, or undefined to read it. */
function fileReason(name: string): string | undefined {
  // Lowercased before every comparison: APFS and NTFS would serve `ID_RSA` for
  // `id_rsa`, so a case-sensitive list is a list with a hole in it.
  const lower = name.toLowerCase()

  // `.env` anywhere in the name, not anchored to the front. The rule was
  // `=== '.env' || startsWith('.env.')`, which read `.env` and let
  // `prod.env`, `secrets.env`, `docker.env`, `.flaskenv`, `env.local`, `.env~`
  // and `.env-local` through — every shape a real project actually uses.
  if (/(^|[.\-_])env([.\-_~]|$)/.test(lower) || lower.includes('.env')) {
    // `.env.example` included: it is a template until someone pastes a real
    // value into it, and that is a weekly occurrence.
    return 'excluded: an environment file is where credentials live'
  }

  // `.git` and `.gitmodules` as FILES. A worktree or submodule checkout writes
  // `.git` as a file holding `gitdir: /Users/<name>/…` — an absolute path
  // outside the project, which `types.ts` says must never reach a model — and
  // `.gitmodules` carries submodule URLs, which carry `user:TOKEN@` often
  // enough. Only the DIRECTORY was refused.
  if (lower === '.git' || lower === '.gitmodules') {
    return 'excluded: it names a path or a remote outside this project'
  }

  if (PRIVATE_KEY_NAMES.has(lower)) return 'excluded: this is the name of a private key'
  if (CREDENTIAL_NAMES.has(lower)) return 'excluded: this file exists to hold a credential'

  // The same words, as a stem rather than an exact name: `secret.yml`,
  // `secrets.toml`, `credentials.json`, `auth.json`, `kubeconfig.yaml`,
  // `accessKeys.csv` were each one token off a listed name and each shipped.
  // Up to the FIRST dot, not the last: `path.extname` sees `.example` on
  // `secrets.yml.example`, so the stem came out `secrets.yml` and matched
  // nothing. A file named for what it holds keeps that name through every
  // suffix someone appends to it.
  const stem = lower.split('.')[0] ?? lower
  if (CREDENTIAL_STEMS.has(stem)) return 'excluded: this file exists to hold a credential'

  if (lower.endsWith('.tfstate.backup') || lower.endsWith('.tfvars.json')) {
    // `path.extname` sees `.json` on `terraform.tfvars.json`, so the extension
    // list could never reach Terraform's JSON variable files.
    return 'excluded: Terraform state holds secrets in clear'
  }
  const extension = path.extname(lower)
  if (SECRET_EXTENSIONS.has(extension)) {
    return `excluded: ${extension} carries key material or secret state`
  }

  // Hidden, and not one of the few worth reading. Last, so a dotted file that
  // one of the rules above already named keeps that reason — `.env` says what
  // it is more usefully than "hidden".
  if (lower.startsWith('.') && !READABLE_HIDDEN_FILES.has(lower)) {
    return 'excluded: a hidden file is tooling, and tooling is where credentials sit'
  }

  return undefined
}

/**
 * Containment. `root + sep` rather than a bare prefix, so `/repo-evil` is never
 * accepted for `/repo` — the same stance as `assertInsideRepo`. The root itself
 * is accepted here, unlike there: a link to the root is a cycle, not an escape,
 * and the ancestor check below gives it the reason it deserves.
 */
const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root + path.sep)

/**
 * Why this RESOLVED path is never read.
 *
 * The rule that matters, and the one this module first got wrong: exclusion is
 * decided on where a path actually leads, never on what the directory entry is
 * called. Deciding on the entry's name made the whole list defeatable by a
 * symlink — `notes.md -> .env` returned the environment file in a snapshot
 * that listed `.env` as excluded on the line above, and `docs -> .git` was
 * descended into and handed over `config`, remote token and all.
 *
 * Every segment is tested, not just the last one, because a link can aim
 * straight into an excluded directory: `notes -> .git/config` has an innocent
 * basename and an ancestor that is the whole point of the list.
 */
function resolvedReason(realRoot: string, target: string, isDirectory: boolean): string | undefined {
  const relative = path.relative(realRoot, target)
  if (relative === '') return undefined
  const segments = relative.split(path.sep).filter((segment) => segment !== '')

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    const reason = last && !isDirectory ? fileReason(segment) : directoryReason(segment)
    if (reason !== undefined) {
      // The offending segment is named, never the absolute path: this string
      // goes to a model like every other string in a snapshot.
      return last ? reason : `${reason} (reached through ${segment}/)`
    }
  }
  return undefined
}

/**
 * The reason a model reads for each class `secretIn` returns — the same three
 * sentences as before the rules moved to `secrets.ts`, so a recorded prompt
 * that quotes one still matches.
 */
const WITHHELD: Readonly<Record<SecretClass, string>> = {
  'key-material': 'excluded: the content is key material, whatever the file is called',
  assigned: 'excluded: a secret is assigned a literal value in it',
  shaped: 'excluded: the content carries something shaped like a credential',
}

/**
 * What git tracks under the root, as real-path-relative POSIX paths: the
 * files, and every directory holding one.
 */
interface Tracked {
  readonly files: ReadonlySet<string>
  readonly directories: ReadonlySet<string>
}

type Tracking =
  | { readonly selection: 'git'; readonly tracked: Tracked }
  | { readonly selection: 'walk' }
  | { readonly selection: 'none' }

type GitOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly missing: boolean; readonly stderr: string }

/**
 * One git call, through the one launcher every process `src/` starts goes
 * through (`process/git.ts`): no shell, bounded in time and in output,
 * started outside the repository, which it reaches by `-C` and an absolute
 * path, with no hook, no fsmonitor, no `GIT_*` variable, no catalogue token
 * and no provider key. Past a bound nothing is read rather than something
 * unlisted. Its answer keeps the shape `tracking` reads: the listing as
 * UTF-8, or whether git is missing and what it said.
 */
const git = async (root: string, args: readonly string[]): Promise<GitOutcome> => {
  try {
    return { ok: true, stdout: (await gitIn(root)(args)).toString('utf8') }
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    return { ok: false, missing: error.code === 'ENOENT', stderr: error.stderr }
  }
}

/** Whether a `.git` entry — a directory, or the file a worktree writes — sits at `from` or above it. */
async function gitMarkerAbove(from: string): Promise<boolean> {
  let directory = from
  for (;;) {
    if ((await lstat(path.join(directory, '.git')).catch(() => undefined)) !== undefined) return true
    const parent = path.dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

/**
 * Which files are candidates at all: the ones git tracks, when the root is in
 * a repository (review, security-2 and security-3). An untracked `.env`, a
 * local override, a build artefact — none of them is part of the service, and
 * each is exactly where a secret sits; `.gitignore` is where their authors
 * said so.
 *
 * Three answers, and the one that matters is the third:
 *
 *   - git says the root is in NO repository, and no `.git` sits at the root
 *     or above it: `walk`, today's rules on whatever the directory holds. A
 *     fresh project and a test's temporary directory are this, and so is
 *     every plan-mode recording's application repository — refusing here
 *     would inspect nothing where nothing CAN be tracked yet, and the CLI
 *     says on stderr that the walk was used.
 *   - git lists the tracked files: `git`.
 *   - anything else — git absent beside a `.git`, a `.git` file whose gitdir
 *     is gone (a submodule or a worktree copied out of its superproject), a
 *     repository git will not read (a foreign owner, a broken index), a top
 *     level that does not hold the root, a listing past its bounds: `none`,
 *     and nothing is read. Each is a repository, and walking it would read
 *     what it holds untracked, the one thing this rule exists to refuse.
 */
async function tracking(realRoot: string): Promise<Tracking> {
  const top = await git(realRoot, ['rev-parse', '--show-toplevel'])
  if (!top.ok) {
    const unknown = top.missing || /not a git repository/.test(top.stderr)
    // git's "not a git repository" is also its answer about a `.git` FILE
    // whose gitdir no longer exists; the marker on disk decides.
    return { selection: unknown && !(await gitMarkerAbove(realRoot)) ? 'walk' : 'none' }
  }
  // The repository git answered about must hold the root. `core.worktree` in a
  // repository's own configuration can name any directory as its work tree,
  // and a listing of that one is not a listing of this.
  const realTop = await realpath(top.stdout.trim()).catch(() => undefined)
  if (realTop === undefined || !isInside(realTop, realRoot)) return { selection: 'none' }

  // Relative to the root, and only under it: `ls-files` run in a folder of a
  // monorepo lists that folder. `-z`, so no path is quoted or split.
  const listed = await git(realRoot, ['ls-files', '-z', '--cached'])
  if (!listed.ok) return { selection: 'none' }

  const files = new Set<string>()
  const directories = new Set<string>([''])
  for (const entry of listed.stdout.split('\0')) {
    if (entry === '') continue
    files.add(entry)
    const segments = entry.split('/')
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join('/'))
    }
  }
  return { selection: 'git', tracked: { files, directories } }
}

/** A real path as git names it: relative to the real root, POSIX. */
const trackedName = (realRoot: string, target: string): string =>
  path.relative(realRoot, target).split(path.sep).join('/')

interface Candidate {
  /** Project-relative, POSIX. */
  readonly path: string
  /** The real path to read: a contained symlink is resolved, not re-followed. */
  readonly absolute: string
  readonly size: number
}

interface Walk {
  readonly realRoot: string
  /** Undefined outside a git repository: then every file the walk reaches is a candidate. */
  readonly tracked: Tracked | undefined
  readonly candidates: Candidate[]
  /**
   * Every catalog-info the walk reached, whatever its size: read apart from
   * the candidates and outside their budget (`declarations`).
   */
  readonly catalogs: Candidate[]
  readonly skipped: SkippedFile[]
  /** Entries git does not track: counted, never named. */
  untracked: number
  directories: number
  truncated: boolean
}

/**
 * One directory, entries in sorted order.
 *
 * `ancestors` is the chain of real directory paths on the current descent, not
 * a global visited set: a monorepo legitimately links one directory in two
 * places and both are the project's, while a link to an ancestor is the only
 * shape that cannot terminate.
 */
async function walk(
  state: Walk,
  directory: string,
  prefix: string,
  ancestors: readonly string[],
): Promise<void> {
  const names = await readdir(directory).catch(() => undefined)
  if (names === undefined) {
    state.skipped.push({ path: prefix === '' ? '.' : prefix, reason: 'skipped: unreadable' })
    return
  }

  for (const name of [...names].sort()) {
    const absolute = path.join(directory, name)
    const here = prefix === '' ? name : `${prefix}/${name}`

    // An entry git does not track is counted, and neither read nor NAMED:
    // `skipped` goes to the provider with the files, and the name of a file
    // nobody committed — `notes/customer-x-incident.md`, a `.env` — is no
    // more the service's to send than its content (review). Decided on the
    // entry's own name, first, so no rule below gets to quote it; a tracked
    // link to an untracked target is still refused on its target further on.
    // `directory` is always a real path, so this is the name git lists the
    // entry under, even below a tracked link to a directory.
    if (state.tracked !== undefined) {
      const listed = trackedName(state.realRoot, absolute)
      if (!state.tracked.files.has(listed) && !state.tracked.directories.has(listed)) {
        state.untracked += 1
        continue
      }
    }

    // The relative path through the audited check in `core/paths`, which also
    // refuses a NUL — a NUL truncates a path inside a syscall, so a test after
    // one sees a different path from the one that was opened. A name out of
    // readdir cannot normally traverse; this is the belt to realpath's braces.
    try {
      assertInsideRepo(state.realRoot, here.split('/').join(path.sep))
    } catch (error) {
      if (!(error instanceof PathEscapeError)) throw error
      state.skipped.push({ path: here, reason: 'refused: this path escapes the project' })
      continue
    }

    // lstat, never stat: stat follows the link and reports the TARGET's type,
    // so a link out of the project would arrive here as an ordinary file.
    const entry = await lstat(absolute).catch(() => undefined)
    if (entry === undefined) {
      state.skipped.push({ path: here, reason: 'skipped: it could not be read' })
      continue
    }

    let target = absolute
    let stats = entry
    if (entry.isSymbolicLink()) {
      // realpath before deciding anything: `..` and an intermediate link are
      // both resolved by it and by nothing short of it.
      const resolved = await realpath(absolute).catch(() => undefined)
      if (resolved === undefined) {
        state.skipped.push({ path: here, reason: 'skipped: a symlink that resolves to nothing' })
        continue
      }
      if (!isInside(state.realRoot, resolved)) {
        // The target is NOT named: it is a path outside the project, and this
        // string is handed to a model like every other string here.
        state.skipped.push({
          path: here,
          reason: 'refused: a symlink resolving outside the project',
        })
        continue
      }
      // `resolved` has no link left in it, so this lstat is a stat that
      // follows nothing.
      const targetStats = await lstat(resolved).catch(() => undefined)
      if (targetStats === undefined) {
        state.skipped.push({ path: here, reason: 'skipped: it could not be read' })
        continue
      }
      target = resolved
      stats = targetStats
    }

    if (stats.isDirectory()) {
      const reason = resolvedReason(state.realRoot, target, true)
      if (reason !== undefined) {
        state.skipped.push({ path: here, reason })
        continue
      }
      // Named once, not file by file: an ignored `tmp/` or `out/` holds
      // thousands, and not one of them is the project's.
      if (
        state.tracked !== undefined &&
        !state.tracked.directories.has(trackedName(state.realRoot, target))
      ) {
        state.skipped.push({ path: here, reason: 'not descended: git tracks nothing in it' })
        continue
      }
      // `target` is already a real path — a descent only ever passes one, so a
      // name joined onto it is real unless it is itself a link, and a link was
      // resolved above. No second realpath is needed to compare ancestors.
      if (ancestors.includes(target)) {
        state.skipped.push({ path: here, reason: 'not descended: it leads back into itself' })
        continue
      }
      if (state.directories >= MAX_DIRECTORIES) {
        state.skipped.push({
          path: here,
          reason: `not descended: the ${MAX_DIRECTORIES}-directory walk budget was spent`,
        })
        state.truncated = true
        continue
      }
      state.directories += 1
      await walk(state, target, here, [...ancestors, target])
      continue
    }

    if (!stats.isFile()) {
      // A socket, a FIFO, a device. Reading one can block forever.
      state.skipped.push({ path: here, reason: 'skipped: not a regular file' })
      continue
    }

    // A hard link has no target to resolve, so `realpath` cannot say where it
    // leads and containment has nothing to test: the name inside the project
    // and a name outside it are the same inode, equally real. The link count
    // is the only signal there is, so a file with more than one name is
    // refused — rare in a source tree, and the alternative is reading
    // /etc/shadow because someone linked it in. A legitimate one is named,
    // never silent, so the cost is a line in `skipped`.
    if (stats.nlink > 1) {
      state.skipped.push({
        path: here,
        reason: 'refused: a hard link has no target to resolve, so it cannot be shown to lead inside',
      })
      continue
    }

    const excluded = resolvedReason(state.realRoot, target, false)
    if (excluded !== undefined) {
      state.skipped.push({ path: here, reason: excluded })
      continue
    }

    // Decided on the TARGET, as every rule here is: a tracked link to an
    // untracked file leads to bytes git does not hold, and those are the bytes
    // that would be read. Never opened, so its content cannot reach anything.
    if (
      state.tracked !== undefined &&
      !state.tracked.files.has(trackedName(state.realRoot, target))
    ) {
      state.skipped.push({ path: here, reason: 'not read: git does not track it' })
      continue
    }

    // Before the size rule, which only decides what a MODEL is sent: a
    // catalog-info over the cap is still a declaration, and `declarations`
    // says it could not be read rather than letting it vanish.
    if (isCatalogInfo(name)) state.catalogs.push({ path: here, absolute: target, size: stats.size })

    if (stats.size > PROJECT_LIMITS.maxFileBytes) {
      // Skipped, never truncated: half a file is a lie, and a model told half
      // a manifest will answer confidently about the missing half.
      state.skipped.push({
        path: here,
        reason: `skipped: ${stats.size} bytes, over the ${PROJECT_LIMITS.maxFileBytes}-byte file cap`,
      })
      continue
    }

    state.candidates.push({ path: here, absolute: target, size: stats.size })
  }
}

/**
 * The bytes of one file, bounded, read through a descriptor that cannot have
 * become something else.
 *
 * `readFile(path)` re-resolves the path, so the containment decided during the
 * walk and the bytes taken after it were about two different opens — a window
 * as long as the whole walk, in which a file can be replaced by a symlink
 * pointing anywhere. `O_NOFOLLOW` closes it: the open fails outright if the
 * final component has become a link, and everything after happens on the
 * descriptor, which names an inode rather than a path.
 *
 * It also bounds the read. One byte past the cap is enough to know the file is
 * over it, so an enormous file is never pulled into memory to be rejected.
 */
async function readBounded(
  absolute: string,
): Promise<{ bytes: Buffer; over: boolean } | undefined> {
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    const stats = await handle.stat()
    // A descriptor can point at a directory or a device even when the walk saw
    // a file; refusing here costs nothing and a read on one can block forever.
    if (!stats.isFile()) return undefined
    if (stats.size > PROJECT_LIMITS.maxFileBytes) return { bytes: Buffer.alloc(0), over: true }

    const buffer = Buffer.alloc(PROJECT_LIMITS.maxFileBytes + 1)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    if (filled > PROJECT_LIMITS.maxFileBytes) return { bytes: Buffer.alloc(0), over: true }
    return { bytes: buffer.subarray(0, filled), over: false }
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/**
 * A catalog-info, by its base name: Backstage's `catalog-info.yaml`, the
 * `.yml` people write as often, and the `catalog-info.<part>.yaml` a repository
 * splits one into.
 */
export const isCatalogInfo = (name: string): boolean => /^catalog-info([.-].*)?\.ya?ml$/i.test(name)

/** Package manifests other than `package.json`, which outranks them all. */
const MANIFESTS = new Set([
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'pipfile',
  'gemfile',
  'composer.json',
  'mix.exs',
  'deno.json',
])

/** Folders whose YAML is a deployment: Kubernetes manifests, charts, overlays. */
const DEPLOYMENT_DIRECTORIES = new Set([
  'k8s',
  'kubernetes',
  'kube',
  'manifests',
  'deploy',
  'deployment',
  'deployments',
  'helm',
  'chart',
  'charts',
  'kustomize',
  'overlays',
])

/**
 * The files that state what a service IS — its manifest, who owns it, how it
 * is declared, packaged and deployed — ranked, or undefined for the rest.
 *
 * The budget used to be spent in path order, so on a real repository an
 * `app/` or a `__generated__/` of two hundred files was read and the
 * `package.json` after it was not (review, gap-init-real-repos-1). The ranks
 * are the order the Inspector is after them in: the manifest first, and
 * `package.json` before any other, because the owner's services are Node.
 *
 * `.idp-agent.yml` is absent on purpose. It is a hidden file, which this
 * module never hands a model (`READABLE_HIDDEN_FILES`); the engine reads it
 * (`cli/config.ts`), and the plan-mode recordings were made with it withheld.
 */
function signalOf(relative: string): number | undefined {
  const segments = relative.toLowerCase().split('/')
  const name = segments.at(-1) ?? ''
  if (name === 'package.json') return 0
  if (MANIFESTS.has(name) || name.endsWith('.csproj')) return 1
  if (name === 'codeowners') return 2
  if (isCatalogInfo(name)) return 3
  if (name === 'chart.yaml' || /^values([.-].*)?\.ya?ml$/.test(name)) return 4
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) {
    return 5
  }
  if (/^(docker-)?compose([.-].*)?\.ya?ml$/.test(name)) return 6
  if (
    /\.ya?ml$/.test(name) &&
    (/^kustomization\./.test(name) ||
      segments.slice(0, -1).some((segment) => DEPLOYMENT_DIRECTORIES.has(segment)))
  ) {
    return 7
  }
  if (/^readme(\..+)?$/.test(name)) return 8
  return undefined
}

/**
 * The order the budget is spent in: every signal file before any other file,
 * the shallower first within each — a repository's own `package.json` before
 * the two hundred of its workspaces — and then the rank, then the path, so
 * two runs over one disk read the same files (design § 6.2).
 *
 * The order the files are READ in, never the order they are handed over:
 * `readProject` returns them in path order, as it always has, so a repository
 * the budget does not cap — every plan-mode recording's — sends the model the
 * very bytes it sent before.
 */
function byBudget(a: Candidate, b: Candidate): number {
  const rank = (candidate: Candidate): readonly [number, number, number] => {
    const signal = signalOf(candidate.path)
    return [signal === undefined ? 1 : 0, candidate.path.split('/').length, signal ?? 0]
  }
  const [one, other] = [rank(a), rank(b)]
  for (let index = 0; index < one.length; index += 1) {
    const difference = (one[index] ?? 0) - (other[index] ?? 0)
    if (difference !== 0) return difference
  }
  return byPath(a, b)
}

/**
 * The root's `catalog-info.yaml` and `.yml` when the walk did not offer them —
 * untracked, or in a repository git could not list. The model is never sent
 * these, so tracking is not what decides here: the root file is what `init`
 * would write over, and its `before` is what is on the disk. A link or a
 * second name for another file is not followed, and said so.
 */
async function rootCatalogs(realRoot: string, known: ReadonlySet<string>): Promise<Declaration[]> {
  const found: Declaration[] = []
  for (const name of ['catalog-info.yaml', 'catalog-info.yml']) {
    if (known.has(name)) continue
    const stats = await lstat(path.join(realRoot, name)).catch(() => undefined)
    if (stats === undefined) continue
    if (!stats.isFile() || stats.nlink > 1) {
      found.push({ path: name, unreadable: 'it is not a plain file, and it was not followed' })
      continue
    }
    found.push(await declarationOf({ path: name, absolute: path.join(realRoot, name), size: stats.size }))
  }
  return found
}

/** One catalog-info, whole, or why not. The same bounded read as every file here. */
async function declarationOf(candidate: Candidate): Promise<Declaration> {
  const read = await readBounded(candidate.absolute)
  if (read === undefined) return { path: candidate.path, unreadable: 'it could not be read' }
  if (read.over) {
    return {
      path: candidate.path,
      unreadable: `it is over the ${PROJECT_LIMITS.maxFileBytes}-byte file cap`,
    }
  }
  if (read.bytes.includes(0)) return { path: candidate.path, unreadable: 'it is not text' }
  return { path: candidate.path, text: read.bytes.toString('utf8') }
}

/**
 * Every catalog-info the walk reached, whole, each with the workspace it sits
 * in when one holds it: a folder below the root with a package manifest of its
 * own (`signalOf`'s first two ranks) among the files the walk offered.
 */
async function declarationsOf(
  realRoot: string,
  catalogs: readonly Candidate[],
  candidates: readonly Candidate[],
): Promise<Declaration[]> {
  const workspaces = new Set(
    candidates
      .filter((candidate) => (signalOf(candidate.path) ?? Number.POSITIVE_INFINITY) <= 1)
      .map((candidate) => path.posix.dirname(candidate.path))
      .filter((folder) => folder !== '.'),
  )
  const workspaceOf = (file: string): string | undefined => {
    const folders = file.split('/').slice(0, -1)
    for (let depth = folders.length; depth > 0; depth -= 1) {
      const folder = folders.slice(0, depth).join('/')
      if (workspaces.has(folder)) return folder
    }
    return undefined
  }
  const read: Declaration[] = []
  for (const catalog of [...catalogs].sort(byPath)) {
    const declaration = await declarationOf(catalog)
    const workspace = workspaceOf(catalog.path)
    read.push(workspace === undefined ? declaration : { ...declaration, workspace })
  }
  const root = await rootCatalogs(realRoot, new Set(catalogs.map((catalog) => catalog.path)))
  return [...read, ...root].sort(byPath)
}

export async function readProject(root: string): Promise<ProjectRead> {
  const resolved = path.resolve(root)
  // The root is resolved once, and every containment decision is made against
  // the REAL one: on macOS a temp directory is reached through a symlink, so
  // comparing against the path that was typed refuses the whole project.
  const realRoot = await realpath(resolved).catch(() => undefined)
  const rootStats = realRoot === undefined ? undefined : await lstat(realRoot).catch(() => undefined)
  if (realRoot === undefined || rootStats === undefined || !rootStats.isDirectory()) {
    // An empty snapshot and a missing repository must not look alike: the
    // second is a user error, and silence would make it look like an empty
    // project that was read successfully.
    return {
      root: resolved,
      files: [],
      skipped: [{ path: '.', reason: 'refused: the project root is not a readable directory' }],
      truncated: false,
      selection: 'none',
      leftOut: 0,
      signalsLeftOut: 0,
      declarations: [],
    }
  }

  const chosen = await tracking(realRoot)
  if (chosen.selection === 'none') {
    // The reason names no git message: git's stderr can quote a path outside
    // the project, and this string goes to a model.
    return {
      root: realRoot,
      files: [],
      skipped: [
        {
          path: '.',
          reason: 'refused: git could not list the files this repository tracks, so none was read',
        },
      ],
      truncated: false,
      selection: 'none',
      leftOut: 0,
      signalsLeftOut: 0,
      // Nothing is sent to a model here, and nothing of this is: what `init`
      // would write over is still what the root holds.
      declarations: await rootCatalogs(realRoot, new Set()),
    }
  }
  const selection: Selection = chosen.selection

  const state: Walk = {
    realRoot,
    tracked: chosen.selection === 'git' ? chosen.tracked : undefined,
    candidates: [],
    catalogs: [],
    skipped: [],
    untracked: 0,
    directories: 1,
    truncated: false,
  }
  await walk(state, realRoot, '', [realRoot])
  if (state.untracked > 0) {
    state.skipped.push({
      path: '.',
      reason: `not read: ${state.untracked} ${state.untracked === 1 ? 'path' : 'paths'} git does not track, and not named`,
    })
  }

  // Ordered before the caps are applied, not after: the caps decide WHICH
  // files are read, so two runs agree on the content only if they agree on the
  // order first. That is what lets a recording replay (design § 6.2). The
  // signal files come first (`byBudget`), so a cap leaves out the files that
  // say least about the service.
  state.candidates.sort(byBudget)

  const files: ProjectFile[] = []
  let total = 0
  let leftOut = 0
  let signalsLeftOut = 0
  /**
   * The one entry a cap earns: the file it stopped at, and how many it left
   * out with it — counted, because "stopped here" on a list read in an order
   * nobody sees says nothing about how much was missed.
   */
  const stop = (at: number, cap: string): void => {
    leftOut = state.candidates.length - at
    signalsLeftOut = state.candidates
      .slice(at)
      .filter((candidate) => signalOf(candidate.path) !== undefined).length
    state.skipped.push({
      path: state.candidates[at]?.path ?? '.',
      reason:
        `not read: the ${cap} cap stopped the read here, leaving ${leftOut} ` +
        `${leftOut === 1 ? 'file' : 'files'} out — ` +
        (signalsLeftOut === 0
          ? 'manifests, ownership, catalogue and deployment files were read first'
          : `${signalsLeftOut} of them manifests, ownership, catalogue or deployment files`),
    })
    state.truncated = true
  }
  for (const [index, candidate] of state.candidates.entries()) {
    if (files.length >= PROJECT_LIMITS.maxFiles) {
      stop(index, `${PROJECT_LIMITS.maxFiles}-file`)
      break
    }
    if (total >= PROJECT_LIMITS.maxTotalBytes) {
      stop(index, `${PROJECT_LIMITS.maxTotalBytes}-byte total`)
      break
    }

    const read = await readBounded(candidate.absolute)
    if (read === undefined) {
      state.skipped.push({ path: candidate.path, reason: 'skipped: it could not be read' })
      continue
    }
    if (read.over) {
      // Measured on the bytes in hand, never on the bytes `lstat` promised: a
      // file may grow between the two, and `readFile` would have pulled all of
      // it into memory before anyone checked. Skipped, never truncated — half
      // a file is a lie, and a model told half a manifest answers confidently
      // about the missing half.
      state.skipped.push({
        path: candidate.path,
        reason: `skipped: over the ${PROJECT_LIMITS.maxFileBytes}-byte file cap`,
      })
      continue
    }
    const bytes = read.bytes

    if (bytes.includes(0)) {
      state.skipped.push({
        path: candidate.path,
        reason: 'skipped: not text — it holds a NUL byte',
      })
      continue
    }
    // The WHOLE file, not its first 8 KiB. This rule is the backstop for "a
    // name is the author's to choose", and a backstop that stops looking part
    // way through is one a key can be placed past. The read is capped at
    // maxFileBytes anyway, so scanning all of it is bounded work.
    //
    // latin1: every byte maps to a character, so the header test cannot be
    // defeated by an invalid UTF-8 sequence before it.
    const text = bytes.toString('latin1')
    const secret = secretIn(text)
    if (secret !== undefined) {
      // Withheld whole, never redacted — `secrets.ts` says why — and named by
      // the class, never the token: this string travels to a model in the
      // snapshot's own `skipped` list, and quoting the secret to explain why
      // the secret was withheld would be the whole defect again.
      state.skipped.push({ path: candidate.path, reason: WITHHELD[secret] })
      continue
    }

    if (total + bytes.length > PROJECT_LIMITS.maxTotalBytes) {
      // Checked on the bytes in hand as well as before the read: `lstat` said
      // how big the file was a moment ago, and a snapshot that overruns its
      // own total cap by a whole file is a cap that does not hold.
      stop(index, `${PROJECT_LIMITS.maxTotalBytes}-byte total`)
      break
    }

    files.push({
      path: candidate.path,
      text: bytes.toString('utf8'),
      // Said, not left for the model to infer from U+FFFD: a file that holds
      // one on purpose would read the same (gap-init-real-repos-9).
      ...(isUtf8(bytes) ? {} : { undecodable: true as const }),
    })
    total += bytes.length
  }
  // Handed over in path order, whatever order they were read in (`byBudget`).
  files.sort(byPath)

  const skipped = state.skipped.sort(byPath)
  if (skipped.length > PROJECT_LIMITS.maxSkipped) {
    const dropped = skipped.length - PROJECT_LIMITS.maxSkipped
    skipped.length = PROJECT_LIMITS.maxSkipped
    // The one place a list is shortened rather than refused, and it says so in
    // its own last entry: a reason list that grows without bound is a second
    // way to fill a model's context, and dropping entries in silence would
    // break the very rule this list exists to keep.
    skipped.push({
      path: '.',
      reason: `and ${dropped} more not listed: the ${PROJECT_LIMITS.maxSkipped}-entry cap on reasons`,
    })
    state.truncated = true
  }

  return {
    root: realRoot,
    files,
    skipped,
    truncated: state.truncated,
    selection,
    leftOut,
    signalsLeftOut,
    declarations: await declarationsOf(realRoot, state.catalogs, state.candidates),
  }
}
