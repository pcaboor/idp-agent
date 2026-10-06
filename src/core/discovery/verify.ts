import { createHash } from 'node:crypto'
import path from 'node:path'
import { blobId } from '../git/blob.js'
import { assertInsideRepo } from '../paths/entity-path.js'
import { findingId, isMinted, type Finding, type Standing } from './finding.js'
import { DISCOVERY_LIMITS } from './limits.js'
import { RULES, type ExtractorName } from './rules.js'

/**
 * The witness re-read (stage 8 brief § 5, plan Task 1.3): before a finding is
 * reported, its file is read again and the finding is held to five checks, in
 * the note's order — path, content, span, support, standing — after a first
 * that asks whether anything minted it at all.
 *
 * Pure over the bytes it is handed. `core/` cannot open a file, nor know
 * whether one was opened, so the caller hands in what the discovery read
 * opened (`opened`) and what it read again (`Reread`, `context/discovery`'s
 * `reread`), and the extractors to run again, as a table: 1.4 passes the real
 * ones, and the tests pass their own.
 *
 * Only a finding of standing `evidence` comes out branded `Verified`, the
 * type 2.6 will carry in `Provenance`. In slice 1 nothing reads the brand but
 * its tests and the count of verified findings `init`'s exit reads (1.4).
 */

declare const verified: unique symbol

/** A finding whose file was read again and held to every check, of standing evidence. Only verifyFinding mints one. */
export type Verified = Finding & { readonly [verified]: true }

/**
 * One file, read again: its bytes now, and HEAD's blob id for its path
 * (undefined: not at HEAD). `context/discovery`'s `reread` hands one back only
 * when the bytes are that blob and the read's rules keep them, so it never
 * hands in `committed: undefined`; a value made by hand may.
 */
export interface Reread {
  readonly path: string
  readonly bytes: Buffer
  readonly committed: string | undefined
  readonly objectFormat: 'sha1' | 'sha256'
}

/**
 * One file, read again and not kept: its bytes are not HEAD's blob any more
 * (`changed`), or HEAD's new blob is one the read discards whole. Its bytes
 * were read only to be hashed or recognised, then zeroed, and are kept
 * nowhere, so no caller can hand them to an extractor.
 */
export interface Dropped {
  readonly path: string
  readonly dropped: 'changed' | 'discarded-sops' | 'discarded-secret' | 'parse-failure'
}

/** An extractor, run again on a file's bytes: every finding it makes of them. */
export type Extract = (path: string, bytes: Buffer) => readonly Finding[]

/** The checks that refuse. Content does not: a file that changed is handed back (`stale`), to be extracted again. */
export type Check = 'minted' | 'path' | 'span' | 'support'

export type Checked =
  | { readonly outcome: 'vouches'; readonly finding: Verified }
  | { readonly outcome: 'cannot-vouch'; readonly finding: Finding; readonly standing: Exclude<Standing, 'evidence'> }
  | { readonly outcome: 'stale'; readonly finding: Finding }
  /** `id` only when it has an ID's form (`^[0-9a-f]{64}$`); the reason then says "an ID of no valid form". */
  | { readonly outcome: 'refused'; readonly id: string | undefined; readonly check: Check; readonly reason: string }

export interface VerifyContext {
  /** The paths the discovery read opened through the confined read: no other path can vouch. */
  readonly opened: ReadonlySet<string>
  readonly extract: { readonly [E in ExtractorName]: Extract }
}

/**
 * Every finding this module let vouch, and nothing else. The brand is put on
 * the minted finding itself, never on a copy, so a `Verified` checked again —
 * at the signature, at the moment of writing — is still minted, and passes
 * or fails on its file alone: one that fails then loses the brand.
 */
const vouched = new WeakSet<object>()

/** Did `verifyFinding` let exactly this object vouch, and is it still the finding it minted? */
export const isVerified = (value: unknown): value is Verified =>
  typeof value === 'object' && value !== null && vouched.has(value) && isMinted(value)

const ID = /^[0-9a-f]{64}$/

/**
 * A finding's ID, only when it has an ID's form. The object handed in may
 * come from anywhere — 2.6 hands in IDs out of a model's plan — so a value of
 * any other form is never echoed, in `id` or in a reason.
 */
function idOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  let id: unknown
  try {
    // A getter, or a proxy, may throw: refused, never thrown, and its
    // message — the caller's words — kept nowhere.
    id = (value as { readonly id?: unknown }).id
  } catch {
    return undefined
  }
  return typeof id === 'string' && ID.test(id) ? id : undefined
}

/** A root no path is resolved against but here, for `assertInsideRepo`'s lexical test. */
const ROOT = path.resolve('/repository')

/**
 * A repository-relative POSIX path, as git names one: not empty, no NUL, no
 * backslash, not absolute in any platform's form, and no empty, `.` or `..`
 * segment — then `assertInsideRepo`, the lexical test the snapshot reads a
 * path through. One written otherwise is not a path the read names, so it is
 * refused rather than normalised into one.
 */
function isRepositoryPath(candidate: string): boolean {
  if (candidate === '' || candidate.includes('\0') || candidate.includes('\\')) return false
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) return false
  if (candidate.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  try {
    assertInsideRepo(ROOT, candidate)
    return true
  } catch {
    return false
  }
}

const NEWLINE = 0x0a

/**
 * The bytes a span covers, from the start of its first line to the end of
 * its last, that line's newline left out; undefined when the file has no such
 * lines. A last line with no newline is a line; an empty file has none.
 */
function spanBytes(bytes: Buffer, start: number, end: number): number | undefined {
  const starts = [0]
  for (let at = bytes.indexOf(NEWLINE); at !== -1 && at + 1 < bytes.length; at = bytes.indexOf(NEWLINE, at + 1)) {
    starts.push(at + 1)
  }
  const count = bytes.length === 0 ? 0 : starts.length
  if (start < 1 || end < start || end > count) return undefined
  const first = starts[start - 1] ?? 0
  const next = starts[end]
  const last = next !== undefined ? next - 1 : bytes[bytes.length - 1] === NEWLINE ? bytes.length - 1 : bytes.length
  return last - first
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Whether a file read again is `HEAD`'s: git's blob for its bytes is the one
 * `HEAD` holds at its path. Bytes that are not are never handed to an
 * extractor: the support check comes after content, and the real `reread`
 * hands back no such bytes at all (`Dropped`), so 1.4's `discover` extracts
 * a stale file again only from bytes that are committed and not discarded
 * whole (Global Constraints, *Evidence only from committed bytes*). Checked
 * here all the same, for a `Reread` made by hand.
 */
export const isCommitted = (file: Reread): boolean =>
  file.committed !== undefined && blobId(file.bytes, file.objectFormat) === file.committed

/**
 * Hold a finding to its file, read again, in the note's order: minted, path,
 * content, span, support, standing. The first that fails decides. Content
 * does not refuse: the file changed, so its findings are handed back `stale`,
 * to be extracted again from the bytes just read (1.4's `discover`) when the
 * re-read kept any, never reused. Only `evidence` vouches; any other standing
 * passes every check and says what it is. A finding that vouched before and
 * does not now loses its brand.
 */
export function verifyFinding(finding: unknown, file: Reread | Dropped | undefined, context: VerifyContext): Checked {
  // 0. Minted: a spread copy, a cast, a parsed JSON or a finding written by
  // hand is refused before anything else is looked at.
  if (!isMinted(finding)) {
    const id = idOf(finding)
    return id === undefined
      ? { outcome: 'refused', id: undefined, check: 'minted', reason: 'an ID of no valid form' }
      : { outcome: 'refused', id, check: 'minted', reason: `no extractor minted finding ${id}` }
  }
  const checked = checkMinted(finding, file, context)
  if (checked.outcome !== 'vouches') vouched.delete(finding)
  return checked
}

/** The checks after the first, of a finding something minted. */
function checkMinted(finding: Finding, file: Reread | Dropped | undefined, context: VerifyContext): Checked {
  // Minted, so its ID recomputes from its content: an ID's form, and nothing
  // the repository wrote. Every reason below names the finding by it alone,
  // never by its path or a value.
  const id = finding.id
  const refused = (check: Check, why: string): Checked => ({ outcome: 'refused', id, check, reason: `finding ${id}: ${why}` })

  // 1. Path: a repository path, one the read opened, and the file read again.
  if (!isRepositoryPath(finding.path)) return refused('path', 'its path is not a path inside the repository')
  if (!context.opened.has(finding.path)) return refused('path', 'its path is not one the read opened')
  if (file === undefined) {
    return refused('path', 'its file is not one HEAD still holds as a file, or could not be opened again through the confined read')
  }
  if (file.path !== finding.path) return refused('path', 'its file was read again under another path')

  // 2. Content: the bytes it was read from, and HEAD's blob for them. A file
  // the re-read dropped changed, or is now one the read discards whole.
  if ('dropped' in file || sha256(file.bytes) !== finding.fileSha256 || !isCommitted(file)) return { outcome: 'stale', finding }

  // 3. Span: lines the file holds, few enough that a span is never a quote of it.
  const [start, end] = finding.lines
  const covered = spanBytes(file.bytes, start, end)
  if (
    covered === undefined ||
    end - start + 1 > DISCOVERY_LIMITS.maxSpanLines ||
    covered > DISCOVERY_LIMITS.maxSpanBytes
  ) {
    return refused(
      'span',
      `its span is not 1 to ${String(DISCOVERY_LIMITS.maxSpanLines)} lines and at most ${DISCOVERY_LIMITS.maxSpanBytes.toLocaleString('en')} bytes of its file`,
    )
  }

  // 4. Support: the rule, run again on those bytes, says the same kind,
  // fields and standing at a span inside the finding's. An extractor that throws supports
  // nothing, and its message — which may quote the bytes — is kept nowhere.
  const rule = RULES[finding.rule]
  let again: readonly Finding[]
  try {
    again = context.extract[rule.extractor](file.path, file.bytes)
  } catch {
    again = []
  }
  // The same content at the finding's own span is the finding's own ID: the
  // rule, its version, the path, the fields and the file's hash all agree.
  const says = (other: Finding): boolean =>
    isMinted(other) &&
    other.rule === finding.rule &&
    other.path === finding.path &&
    other.kind === finding.kind &&
    other.standing === finding.standing &&
    other.lines[0] >= start &&
    other.lines[1] <= end &&
    findingId({ ...other, lines: finding.lines }) === id
  if (!again.some(says)) return refused('support', 'its rule no longer says it on those bytes')

  // 5. Standing: only evidence vouches.
  const standing = finding.standing
  switch (standing) {
    case 'evidence': {
      vouched.add(finding)
      return { outcome: 'vouches', finding: finding as Verified }
    }
    case 'sample':
    case 'mention':
    case 'placeholder':
    case 'local':
    case 'claimed':
      return { outcome: 'cannot-vouch', finding, standing }
    default: {
      const _exhaustive: never = standing
      throw new Error(`a standing nobody named (${String(_exhaustive)}), an engine bug`)
    }
  }
}
