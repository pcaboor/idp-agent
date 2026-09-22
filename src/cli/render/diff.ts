/**
 * Colour, and nothing else.
 *
 * `renderUnifiedDiff` in `core/` produces the text; this decides what a
 * terminal paints it. The split is the same one `renderTable` and
 * `renderEntityDetail` live on — data in, string out — so the diff stays
 * assertable without a TTY, and a change of palette can never change a byte of
 * what a reviewer would merge.
 */

const RESET = '\u001B[0m'

const BOLD = '\u001B[1m'
const DIM = '\u001B[2m'
const RED = '\u001B[31m'
const GREEN = '\u001B[32m'
const CYAN = '\u001B[36m'

/**
 * The file headers are tested before the single-character markers: `---` and
 * `+++` also start with `-` and `+`, and painting them as a removal and an
 * addition would say the header itself changed.
 *
 * The trailing space is load-bearing. A header is always `--- a/<path>`,
 * `--- /dev/null` or `+++ b/<path>`, whereas a REMOVED document marker is
 * `----`: every entity document in this repository opens on `---`, so that is
 * the likeliest removal line there is, and without the space it was claimed as
 * a header and painted bold.
 */
function colourOf(line: string): string | undefined {
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return BOLD
  if (line.startsWith('@@')) return CYAN
  if (line.startsWith('+')) return GREEN
  if (line.startsWith('-')) return RED
  // `\ No newline at end of file` belongs to the line above it, not to either
  // side of the change.
  if (line.startsWith('\\')) return DIM
  return undefined
}

/**
 * `colour` is decided by the caller, because only the caller knows whether it
 * is talking to a terminal. Handed false, this returns the diff unchanged
 * rather than a stripped approximation of it.
 */
export function paintDiff(diff: string, colour: boolean): string {
  if (!colour || diff === '') return diff

  // The trailing newline is preserved by splitting on it and rejoining: an
  // escape sequence after the last line would paint whatever the shell prints
  // next.
  return diff
    .split('\n')
    .map((line) => {
      const code = colourOf(line)
      return code === undefined || line === '' ? line : `${code}${line}${RESET}`
    })
    .join('\n')
}

/**
 * Whether this run should paint at all. `NO_COLOR` wins over `FORCE_COLOR`
 * because a user who set it is asking for plain text everywhere, and a tool
 * that honours it only when nothing else is set has not honoured it.
 * no-color.org: present and non-empty, whatever the value.
 */
export function wantsColour(env: Record<string, string | undefined>, tty: boolean): boolean {
  const no = env['NO_COLOR']
  if (no !== undefined && no !== '') return false
  const force = env['FORCE_COLOR']
  if (force !== undefined && force !== '0') return true
  return tty
}
