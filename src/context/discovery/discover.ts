import type { Walked } from '../../core/discovery/allow.js'
import { EXTRACTORS, findingsOf, type Extracted } from '../../core/discovery/extractors.js'
import { coverageOf, pastRunCap, type Coverage } from '../../core/discovery/report.js'
import { DISCOVERY_LIMITS } from '../../core/discovery/limits.js'
import { isCommitted, verifyFinding, type Checked, type Dropped, type Reread } from '../../core/discovery/verify.js'
import { readDiscovery, type DiscoveryOptions, type DiscoveryRead } from './read.js'

/**
 * Stage 8's discovery, whole (plan, Task 1.4): read, extract, read again,
 * verify, cover. What `idpa init` reports between its diff and its closing
 * lines, and in its pull request's body. No model is sent any of it: an
 * architecture rule keeps this folder out of everything `agents/` reaches.
 *
 * It touches no disk of its own; `read.ts` does, and opens what the
 * allow-list names alone. In order, for each file the read kept:
 *
 *   1. the file's extractor runs on its bytes — committed at `HEAD`, never a
 *      file changed since (owner's answer 4);
 *   2. the files past the run's finding cap are named and go no further —
 *      decided once, here, and kept: a file past it is never read again;
 *   3. each finding is held to its file read again (`reread`, then
 *      `verifyFinding`). A file that changed since its first read comes back
 *      `stale`: when the re-read kept its bytes and they are `HEAD`'s
 *      (`isCommitted`, which `read.ts` already holds them to) — a commit made
 *      during the run — it is extracted once more from those and checked once
 *      more against a third read, and a second `stale` makes it *changed
 *      during the run*. A file the re-read dropped, or whose bytes are not
 *      `HEAD`'s, is extracted from nothing: changed since `HEAD`, it is
 *      *changed during the run*; turned into one the read discards whole, it
 *      is set aside as the read would set it.
 *
 * Every byte it was handed, and every re-read's, is zeroed once used, on
 * every path out of a file's step.
 *
 * It NEVER THROWS. Whatever a file's step throws is that file's reason
 * (`parse-failure`), and its message — which might quote the bytes — is kept
 * nowhere, so no repository byte reaches stderr or a trace's `error`. A read
 * that throws is a read of nothing (`none`).
 */

export interface Discovery {
  readonly coverage: Coverage
  /** Every finding's last check, as `coverageOf` read it. */
  readonly checked: readonly Checked[]
}

const NOTHING: Walked = {
  selection: 'none',
  head: undefined,
  opened: [],
  notAnalysed: [],
  byDesign: [],
  untracked: 0,
  staged: 0,
  unlisted: 0,
  unnameable: 0,
  truncated: false,
}

const EXTRACT = findingsOf(EXTRACTORS)

/** One extractor on one file's bytes: what it says, or a parse failure that names nothing it read. */
function extracted(extractor: keyof typeof EXTRACTORS, path: string, bytes: Buffer): Extracted | 'threw' {
  try {
    return EXTRACTORS[extractor](path, bytes)
  } catch {
    return 'threw'
  }
}

/** A file read again, or undefined when the re-read could not say. */
async function again(read: DiscoveryRead, path: string): Promise<Reread | Dropped | undefined> {
  try {
    return await read.reread(path)
  } catch {
    return undefined
  }
}

export async function discover(root: string, options: DiscoveryOptions = {}): Promise<Discovery> {
  let read: DiscoveryRead
  try {
    read = await readDiscovery(root, options)
  } catch {
    return { coverage: coverageOf(NOTHING, new Map(), []), checked: [] }
  }
  const opened = new Set(read.opened)
  const context = { opened, extract: EXTRACT }

  // What the walk said, less what this run learns of a file after it.
  const notAnalysed: Walked['notAnalysed'][number][] = [...read.notAnalysed]
  const byDesign: Walked['byDesign'][number][] = [...read.byDesign]
  const removed = new Set<string>()
  const results = new Map<string, Extracted>()

  for (const file of read.files) {
    const result = extracted(file.extractor, file.path, file.bytes)
    if (result === 'threw') {
      removed.add(file.path)
      notAnalysed.push({ path: file.path, why: 'parse-failure' })
      continue
    }
    results.set(file.path, result)
  }

  const cap = options.limits?.maxFindingsPerRun ?? DISCOVERY_LIMITS.maxFindingsPerRun
  const past = pastRunCap(read.opened, results, cap)
  const checked: Checked[] = []
  for (const file of read.files) {
    const result = results.get(file.path)
    if (result?.outcome !== 'read' || result.findings.length === 0 || past.has(file.path)) continue
    const first = await again(read, file.path)
    try {
      let mine = result.findings.map((finding) => verifyFinding(finding, first, context))
      if (mine.some((one) => one.outcome === 'stale') && first !== undefined) {
        if ('dropped' in first) {
          // Extracted from nothing: changed since `HEAD` is a change during the
          // run, and one the read now discards is set aside as the read sets it.
          const why = first.dropped
          if (why === 'discarded-sops' || why === 'discarded-secret') {
            removed.add(file.path)
            byDesign.push({ path: file.path, why })
            continue
          }
          if (why === 'parse-failure') {
            removed.add(file.path)
            notAnalysed.push({ path: file.path, why })
            continue
          }
        } else if (isCommitted(first)) {
          // Committed bytes a commit made during the run: read once more, and
          // checked once more against a third read.
          const redone = extracted(file.extractor, file.path, first.bytes)
          if (redone === 'threw') {
            removed.add(file.path)
            notAnalysed.push({ path: file.path, why: 'parse-failure' })
            continue
          }
          results.set(file.path, redone)
          if (redone.outcome !== 'read') continue
          const second = await again(read, file.path)
          try {
            mine = redone.findings.map((finding) => verifyFinding(finding, second, context))
          } finally {
            if (second !== undefined && !('dropped' in second)) second.bytes.fill(0)
          }
        }
        // Bytes the re-read handed back that are not `HEAD`'s: never
        // extracted, so the file's findings stay stale — changed during the run.
      }
      checked.push(...mine)
    } finally {
      if (first !== undefined && !('dropped' in first)) first.bytes.fill(0)
    }
  }

  for (const file of read.files) file.bytes.fill(0)
  const kept = read.opened.filter((file) => !removed.has(file))
  // The cap as decided before the re-read, and as the files' last extraction
  // counts it: a file past either is past it, so the report lists no file
  // nobody read again and never more findings than the cap.
  const final = new Set([...past, ...pastRunCap(kept, results, cap)])
  const walked: Walked = {
    selection: read.selection,
    head: read.head,
    opened: kept,
    notAnalysed,
    byDesign,
    untracked: read.untracked,
    staged: read.staged,
    unlisted: read.unlisted,
    unnameable: read.unnameable,
    truncated: read.truncated,
  }
  return { coverage: coverageOf(walked, results, checked, final), checked }
}
