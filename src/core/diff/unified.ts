/**
 * A unified diff, rendered as a string.
 *
 * No colour, no terminal, no dependency: this is `core/`, so it computes text
 * and stops there. The CLI paints it in `src/cli/render/`, which is also why
 * these lines are testable without a TTY, a repository or a model.
 *
 * The change itself is found with an LCS table walked into an edit script. The
 * files this tool edits are single entities — tens of lines — and a hand-rolled
 * Myers would buy nothing a reviewer could see. Lines shared by the head and
 * the tail of both versions never enter the table, so the quadratic part only
 * ever sees the part that actually moved.
 *
 * What this does *not* do: it never reads a file. `before` and `after` are the
 * buffers the engine already holds, and a diff that agreed with the disk when
 * it was rendered may not by the time it is applied — the re-check at the
 * moment of writing is a separate guarantee and lives elsewhere.
 */

/** One file's two versions, as the engine buffered them. */
export interface FileEdit {
  readonly path: string
  /** undefined when the file does not exist yet — a creation. */
  readonly before: string | undefined
  readonly after: string
}

/** Three lines either side, the window `diff -u` and every reviewer expect. */
const DEFAULT_CONTEXT = 3

const NO_NEWLINE = '\\ No newline at end of file'

interface Line {
  /** the text without its terminator — what gets printed */
  readonly text: string
  /**
   * The text *with* its terminator, or without one on a final line that has
   * none. This, not `text`, is the line's identity: a file ending `b` and one
   * ending `b\n` differ on that line, and `diff` says so rather than calling
   * them equal and hiding the change.
   */
  readonly key: string
}

type ChangeKind = 'equal' | 'remove' | 'insert'

interface Change {
  readonly kind: ChangeKind
  /** how many `before` lines precede this change — 0-based, so a count */
  readonly beforeIndex: number
  /** how many `after` lines precede it */
  readonly afterIndex: number
  readonly line: Line
}

/** Where a hunk starts and stops in the edit script, end exclusive. */
interface Window {
  readonly start: number
  readonly end: number
}

function linesOf(content: string): Line[] {
  if (content === '') return []
  const terminated = content.endsWith('\n')
  const texts = (terminated ? content.slice(0, -1) : content).split('\n')
  return texts.map((text, index) => ({
    text,
    key: !terminated && index === texts.length - 1 ? text : `${text}\n`,
  }))
}

function editScript(before: readonly Line[], after: readonly Line[]): Change[] {
  let head = 0
  while (head < before.length && head < after.length && before[head]!.key === after[head]!.key) {
    head++
  }
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail]!.key === after[after.length - 1 - tail]!.key
  ) {
    tail++
  }

  const changes: Change[] = []
  for (let k = 0; k < head; k++) {
    changes.push({ kind: 'equal', beforeIndex: k, afterIndex: k, line: before[k]! })
  }

  const midBefore = before.slice(head, before.length - tail)
  const midAfter = after.slice(head, after.length - tail)
  const n = midBefore.length
  const m = midAfter.length

  // lcs[i][j] is the longest common subsequence of midBefore[i..] and
  // midAfter[j..]. Filled backwards so the walk below can go forwards, which is
  // the order the hunks are emitted in.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        midBefore[i]!.key === midAfter[j]!.key
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && midBefore[i]!.key === midAfter[j]!.key) {
      changes.push({
        kind: 'equal',
        beforeIndex: head + i,
        afterIndex: head + j,
        line: midBefore[i]!,
      })
      i++
      j++
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Removals win the tie, so a replaced line reads `-old` then `+new`.
      // `diff` makes the same choice and reviewers read it that way.
      changes.push({
        kind: 'remove',
        beforeIndex: head + i,
        afterIndex: head + j,
        line: midBefore[i]!,
      })
      i++
    } else {
      changes.push({
        kind: 'insert',
        beforeIndex: head + i,
        afterIndex: head + j,
        line: midAfter[j]!,
      })
      j++
    }
  }

  for (let k = 0; k < tail; k++) {
    const index = before.length - tail + k
    changes.push({
      kind: 'equal',
      beforeIndex: index,
      afterIndex: after.length - tail + k,
      line: before[index]!,
    })
  }
  return changes
}

/**
 * Two changed runs share a hunk when at most `2 * context` unchanged lines
 * separate them: that is exactly the span their two context windows cover
 * between them, so the hunk would be contiguous anyway and `diff` prints one.
 * One line more and the windows no longer touch — second hunk. The boundary is
 * inclusive, and it is the case these implementations get wrong.
 */
function windowsOf(changes: readonly Change[], context: number): Window[] {
  const windows: Window[] = []
  const widen = (from: number, to: number): Window => ({
    start: Math.max(0, from - context),
    end: Math.min(changes.length, to + context + 1),
  })

  let first = -1
  let last = -1
  for (let k = 0; k < changes.length; k++) {
    if (changes[k]!.kind === 'equal') continue
    if (first !== -1 && k - last - 1 > 2 * context) {
      windows.push(widen(first, last))
      first = -1
    }
    if (first === -1) first = k
    last = k
  }
  if (first !== -1) windows.push(widen(first, last))
  return windows
}

function renderHunk(changes: readonly Change[], window: Window): string[] {
  const slice = changes.slice(window.start, window.end)
  const first = slice[0]
  if (first === undefined) return []

  const body: string[] = []
  let beforeCount = 0
  let afterCount = 0
  for (const change of slice) {
    if (change.kind !== 'insert') beforeCount++
    if (change.kind !== 'remove') afterCount++
    const marker = change.kind === 'equal' ? ' ' : change.kind === 'remove' ? '-' : '+'
    body.push(`${marker}${change.line.text}`)
    // A missing final newline belongs to the line that misses it, not to the
    // end of the hunk: a context line can carry it too, when both versions end
    // that way.
    if (!change.line.key.endsWith('\n')) body.push(NO_NEWLINE)
  }

  // A side contributing no lines numbers from the line *before* the hunk, which
  // is how `-0,0` says "this file had nothing here". The count is always
  // printed, `,1` included: `diff` elides it, and a reviewer reading a machine's
  // output is better served by one shape than by two.
  const beforeStart = first.beforeIndex + (beforeCount === 0 ? 0 : 1)
  const afterStart = first.afterIndex + (afterCount === 0 ? 0 : 1)
  return [`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`, ...body]
}

export function renderUnifiedDiff(
  edits: readonly FileEdit[],
  options?: { context?: number },
): string {
  // A fractional or negative width would widen the window backwards and cut the
  // change out of its own hunk, silently.
  const context = Math.max(0, Math.trunc(options?.context ?? DEFAULT_CONTEXT))

  const out: string[] = []
  for (const edit of edits) {
    // An edit that changes nothing renders nothing — not an empty hunk, not a
    // header. A plan whose target was already declared must produce an empty
    // diff, because there is nothing for a reviewer to authorise (design 4.3).
    if (edit.before === edit.after) continue

    const changes = editScript(linesOf(edit.before ?? ''), linesOf(edit.after))
    // A creation is announced even when the created file is empty: `diff -u
    // /dev/null empty` prints nothing, and a file appearing in the repository
    // with no line of the diff mentioning it is the failure this avoids. The
    // right-hand side stays `b/<path>` when `after` is empty, because an emptied
    // file and a deleted one are not the same act and `FileEdit` cannot tell
    // them apart — v0.1 has no delete operation.
    out.push(edit.before === undefined ? '--- /dev/null' : `--- a/${edit.path}`)
    out.push(`+++ b/${edit.path}`)
    for (const window of windowsOf(changes, context)) out.push(...renderHunk(changes, window))
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}
