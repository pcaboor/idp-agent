/**
 * What is in flight, judged (the owner's decision of 2026-10-01, stage 6 plan
 * Task 6.3.6): the open idp-agent pull requests into the base, each with the
 * files it changes, against what this change writes and the files of the
 * entities it names. Pure; `forge/github/in-flight.ts` reads, and the forge
 * and the CLI say what the verdict means.
 *
 * Decided from paths and blob ids, which is all a pull request's file list
 * says — never from a file's bytes on GitHub, nor from a pull request's title
 * or body, which nothing here has a field for.
 */

/** One file a pull request changes, as GitHub lists it. */
export interface InFlightFile {
  readonly path: string
  /** A rename's old path: a pull request that moves a file changes both. */
  readonly previous?: string
  /** The blob GitHub reports at the head; absent for a removed file. */
  readonly blob?: string
  readonly removed: boolean
  /** GitHub's patch, as it gave it: printed only on stderr, in the competing block, never sent anywhere. */
  readonly patch?: string
}

/** An open idp-agent pull request into the base, and what it changes. */
export interface InFlightPull {
  readonly number: number
  /** Its author's login, held to `isLogin`: said on stderr, never traced, sent or reported. */
  readonly by: string
  /** Its head, held to `SUBMISSION_BRANCH`: said on stderr only. */
  readonly branch: string
  /** The head commit: step 8 reads the files again only where it moved. */
  readonly head: string
  readonly files: readonly InFlightFile[]
  /** False when the list ran past one page of 100. */
  readonly complete: boolean
}

export interface InFlightTarget {
  /** What this change writes; `blob` absent when the bytes are not drafted yet (`init`, before the model). */
  readonly writes: readonly { readonly path: string; readonly blob?: string }[]
  /** The files of the same entities that this change does not write. */
  readonly related: readonly string[]
  /** This change's branch and gh's login: gh's own pull request from it leaves the run to recognition. */
  readonly branch?: string
  readonly me: string
}

/** A pull request a verdict names, and the paths of this change's that put it there. */
export interface InFlightEntry {
  readonly pull: InFlightPull
  readonly paths: readonly string[]
}

export type InFlightVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'same'; readonly pull: InFlightPull }
  | { readonly kind: 'competing'; readonly pulls: readonly InFlightEntry[] }
  | { readonly kind: 'beside'; readonly pulls: readonly InFlightEntry[] }

/** 40 lines of a patch per path, 120 per run, each cut at 200 code points. */
export const PATCH_LINES = { perPath: 40, perRun: 120, perLine: 200 } as const

/** `idp-agent/<slug>-<8 hex>`: the names an idp-agent run pushes (core's copy of `SUBMISSION_BRANCH`). */
export const isSubmissionBranch = (name: string): boolean => /^idp-agent\/[a-z0-9-]+-[0-9a-f]{8}$/.test(name)

/** Sorted by UTF-16 code unit, as a path compares to a path here: byte for byte. */
const sorted = (paths: Iterable<string>): string[] => [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** Every path a pull request changes: each file's, and a rename's old one. */
const changedBy = (pull: InFlightPull): Set<string> =>
  new Set(pull.files.flatMap((one) => (one.previous === undefined ? [one.path] : [one.path, one.previous])))

/**
 * Row 1: exactly the writes, each to the blob this change's bytes hash to,
 * nothing removed, nothing renamed, the list whole. A write with no blob is
 * never the same: before the bytes exist nothing can be.
 */
const isSame = (pull: InFlightPull, target: InFlightTarget): boolean => {
  if (!pull.complete || target.writes.length === 0 || pull.files.length !== target.writes.length) return false
  const blobs = new Map(target.writes.map((write) => [write.path, write.blob] as const))
  if (blobs.size !== target.writes.length) return false
  return pull.files.every(
    (one) =>
      !one.removed &&
      one.previous === undefined &&
      one.blob !== undefined &&
      blobs.has(one.path) &&
      blobs.get(one.path) === one.blob,
  )
}

/**
 * The verdict table's rows in order, over every candidate, whatever order
 * GitHub listed them in: the same bytes (the lowest number named), a change to
 * a written path otherwise, a change to a related path and no written one,
 * else clear. Every path a verdict carries is one of the target's own.
 *
 * gh's own pull request from this very branch makes the whole verdict clear:
 * the change is already proposed by this person, and § 14's recognition names
 * it — `already submitted`, exit 0 — whatever else is in flight beside it. A
 * competing one opened since (the race both runs passed, an older build, a
 * hand-pushed branch) meets it at the merge, never as a refusal of a change
 * that is already open.
 */
export function judgeInFlight(pulls: readonly InFlightPull[], target: InFlightTarget): InFlightVerdict {
  const own = (pull: InFlightPull): boolean =>
    target.branch !== undefined && pull.branch === target.branch && pull.by === target.me
  if (pulls.some(own)) return { kind: 'clear' }
  const candidates = [...pulls].sort((a, b) => a.number - b.number)
  const [same] = candidates.filter((pull) => isSame(pull, target))
  if (same !== undefined) return { kind: 'same', pull: same }
  const writes = new Set(target.writes.map((write) => write.path))
  const related = new Set(target.related.filter((path) => !writes.has(path)))
  const competing: InFlightEntry[] = []
  const beside: InFlightEntry[] = []
  for (const pull of candidates) {
    const changed = changedBy(pull)
    const written = sorted([...changed].filter((path) => writes.has(path)))
    if (written.length > 0) {
      competing.push({ pull, paths: written })
      continue
    }
    const near = sorted([...changed].filter((path) => related.has(path)))
    if (near.length > 0) beside.push({ pull, paths: near })
  }
  if (competing.length > 0) return { kind: 'competing', pulls: competing }
  if (beside.length > 0) return { kind: 'beside', pulls: beside }
  return { kind: 'clear' }
}

/**
 * The first read updated by step 8's: a pull request on page 1 replaces its
 * older self; one the first read held that page 1 no longer lists, though it
 * would (GitHub lists newest first, and numbers grow with creation), closed
 * since and is gone; one beyond page 1 is kept as read. `newest` is every open
 * pull request page 1 listed, candidate or not, and whether that was the whole
 * list. Newest first.
 */
export function mergeReads(
  first: readonly InFlightPull[],
  page: readonly InFlightPull[],
  newest: { readonly listed: readonly number[]; readonly whole: boolean },
): readonly InFlightPull[] {
  const listed = new Set(newest.listed)
  const oldest = Math.min(...newest.listed)
  const fresh = new Map(page.map((pull) => [pull.number, pull] as const))
  const kept = first.filter((pull) => {
    if (fresh.has(pull.number) || listed.has(pull.number)) return false
    // Not listed on page 1: closed, unless page 1 stops before it.
    return !newest.whole && pull.number < oldest
  })
  return [...fresh.values(), ...kept].sort((a, b) => b.number - a.number)
}
