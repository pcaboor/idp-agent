import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { assertInsideRepo, PathEscapeError } from '../../core/paths/entity-path.js'
import type { ProjectFile, ProjectSnapshot, SkippedFile } from './types.js'

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
 * The three shapes live in `types.ts`, which imports nothing. `agents/` has to
 * name `ProjectSnapshot` and the architecture test walks its import closure, so
 * a type reachable only through this module would drag `node:fs/promises` into
 * that closure. Re-exported here so this file stays the one import site for
 * everyone who wants the bytes as well as the shape.
 */
export type { ProjectFile, ProjectSnapshot, SkippedFile } from './types.js'

/**
 * A walk budget the three public caps do not provide. They bound what is READ
 * and what is SENT, which is the security property; this bounds the walk
 * itself, so a directory graph made pathological by symlinks cannot hold the
 * process. Internal on purpose: it is a floor against abuse, not a knob.
 */
const MAX_DIRECTORIES = 5_000

/**
 * Rule 2: a name is whatever its author chose, so the name test below can
 * always be dodged. This is the test underneath it. `[A-Z0-9 ]` covers RSA,
 * DSA, EC, OPENSSH and PGP headers without letting the wildcard run to the end
 * of a file.
 */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY/

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
  return undefined
}

/** Why this file is never read, or undefined to read it. */
function fileReason(name: string): string | undefined {
  // Lowercased before every comparison: APFS and NTFS would serve `ID_RSA` for
  // `id_rsa`, so a case-sensitive list is a list with a hole in it.
  const lower = name.toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.') || lower === '.envrc') {
    // `.env.example` included: it is a template until someone pastes a real
    // value into it, and that is a weekly occurrence. `.envrc` is direnv's,
    // and its entire content is exported shell variables.
    return 'excluded: an environment file is where credentials live'
  }
  if (PRIVATE_KEY_NAMES.has(lower)) return 'excluded: this is the name of a private key'
  if (CREDENTIAL_NAMES.has(lower)) return 'excluded: this file exists to hold a credential'
  if (lower.endsWith('.tfstate.backup')) return 'excluded: Terraform state holds secrets in clear'
  const extension = path.extname(lower)
  if (SECRET_EXTENSIONS.has(extension)) {
    return `excluded: ${extension} carries key material or secret state`
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

interface Candidate {
  /** Project-relative, POSIX. */
  readonly path: string
  /** The real path to read: a contained symlink is resolved, not re-followed. */
  readonly absolute: string
  readonly size: number
}

interface Walk {
  readonly realRoot: string
  readonly candidates: Candidate[]
  readonly skipped: SkippedFile[]
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

export async function readProject(root: string): Promise<ProjectSnapshot> {
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
    }
  }

  const state: Walk = {
    realRoot,
    candidates: [],
    skipped: [],
    directories: 1,
    truncated: false,
  }
  await walk(state, realRoot, '', [realRoot])

  // Sorted before the caps are applied, not after: the caps decide WHICH files
  // are read, so two runs agree on the content only if they agree on the order
  // first. That is what lets a recording replay (design § 6.2).
  state.candidates.sort(byPath)

  const files: ProjectFile[] = []
  let total = 0
  for (const candidate of state.candidates) {
    if (files.length >= PROJECT_LIMITS.maxFiles) {
      state.skipped.push({
        path: candidate.path,
        reason: `not read: the ${PROJECT_LIMITS.maxFiles}-file cap stopped the read here`,
      })
      state.truncated = true
      break
    }
    if (total >= PROJECT_LIMITS.maxTotalBytes) {
      state.skipped.push({
        path: candidate.path,
        reason: `not read: the ${PROJECT_LIMITS.maxTotalBytes}-byte total cap stopped the read here`,
      })
      state.truncated = true
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
    if (PRIVATE_KEY_HEADER.test(bytes.toString('latin1'))) {
      state.skipped.push({
        path: candidate.path,
        reason: 'excluded: the content is a private key, whatever the file is called',
      })
      continue
    }

    if (total + bytes.length > PROJECT_LIMITS.maxTotalBytes) {
      // Checked on the bytes in hand as well as before the read: `lstat` said
      // how big the file was a moment ago, and a snapshot that overruns its
      // own total cap by a whole file is a cap that does not hold.
      state.skipped.push({
        path: candidate.path,
        reason: `not read: the ${PROJECT_LIMITS.maxTotalBytes}-byte total cap stopped the read here`,
      })
      state.truncated = true
      break
    }

    files.push({ path: candidate.path, text: bytes.toString('utf8') })
    total += bytes.length
  }

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
  }
}
