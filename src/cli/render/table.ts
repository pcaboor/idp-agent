import { oneLine } from './plain.js'

const GUTTER = '  '

/**
 * The last column is never padded: trailing whitespace shows up in a diff, in a
 * copied paste and in a golden test, and it never carries meaning.
 *
 * Every cell is flattened to one line with nothing a terminal obeys: a row is
 * an entity, and a Component's type and an environment are free text from its
 * file. A line break in one would print a row that is not there. Not cut: a
 * table is read for its values, and a value shortened here would be wrong.
 */
export function renderTable(headers: string[], cells: string[][]): string {
  const rows = cells.map((row) => row.map((cell) => oneLine(cell, Number.POSITIVE_INFINITY)))
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )

  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join(GUTTER)
      .trimEnd()

  return [line(headers), ...rows.map(line)].join('\n')
}
