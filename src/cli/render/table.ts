const GUTTER = '  '

/**
 * The last column is never padded: trailing whitespace shows up in a diff, in a
 * copied paste and in a golden test, and it never carries meaning.
 */
export function renderTable(headers: string[], rows: string[][]): string {
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
