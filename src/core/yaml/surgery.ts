/**
 * Whole-document insertion and removal, line by line.
 *
 * A file is never rebuilt from a parsed tree: rewriting YAML from an AST
 * reformats everything, loses comments and reorders keys. A reviewer must see an
 * added line, and review is what authorises the change (design 4.3).
 */

const NEWLINE = '\n'
const MARKER = '---'

interface Block {
  /** first line of the document, header comments included */
  start: number
  /** the `---` line */
  marker: number
  /** last content line, trailing blanks and the next header excluded */
  end: number
}

const isBlank = (line: string | undefined): boolean => line !== undefined && line.trim() === ''
const isComment = (line: string | undefined): boolean =>
  line !== undefined && line.trimStart().startsWith('#')

function splitLines(content: string): { lines: string[]; trailing: boolean } {
  const trailing = content.endsWith(NEWLINE)
  const body = trailing ? content.slice(0, -1) : content
  return { lines: body === '' ? [] : body.split(NEWLINE), trailing }
}

function joinLines(lines: string[], trailing: boolean): string {
  if (lines.length === 0) return ''
  return lines.join(NEWLINE) + (trailing ? NEWLINE : '')
}

function findBlocks(lines: string[]): Block[] {
  const markers: number[] = []
  lines.forEach((line, index) => {
    if (line.trimEnd() === MARKER) markers.push(index)
  })

  return markers.map((marker, i) => {
    // Comments sitting directly above a marker introduce that document, the way
    // a comment in YAML precedes what it describes. They move with it.
    let start = marker
    while (start > 0 && isComment(lines[start - 1])) start -= 1

    const next = markers[i + 1]
    let end = next === undefined ? lines.length - 1 : next - 1
    while (end > marker && (isBlank(lines[end]) || isComment(lines[end]))) end -= 1

    return { start, marker, end }
  })
}

/**
 * The `name:` under `metadata:`, not any other key indented by two spaces:
 * a `spec.name` in a hand-written file must not be mistaken for the identity.
 */
function blockName(lines: string[], block: Block): string | undefined {
  let inMetadata = false
  for (let i = block.marker; i <= block.end; i += 1) {
    const line = lines[i]
    if (line === undefined) continue
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true
      continue
    }
    if (inMetadata && /^\S/.test(line)) inMetadata = false
    if (!inMetadata) continue
    const match = /^ {2}name:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/.exec(line)
    if (match) return match[1] ?? match[2] ?? match[3]
  }
  return undefined
}

/** Append a document, preceded by a blank line when the file is not empty. */
export function insertDocument(fileContent: string, documentText: string): string {
  const body = documentText.endsWith(NEWLINE) ? documentText.slice(0, -1) : documentText
  const documentLines = [MARKER, ...body.split(NEWLINE)]
  const { lines } = splitLines(fileContent)
  if (lines.length === 0) return joinLines(documentLines, true)
  return joinLines([...lines, '', ...documentLines], true)
}

/**
 * Remove the document declaring `entityName`, along with the blank line that
 * separated it. Absent means already done: a branch may be replayed, so a
 * document that is not there is not an error (design 4.3).
 */
export function removeDocument(fileContent: string, entityName: string): string {
  const { lines, trailing } = splitLines(fileContent)
  const blocks = findBlocks(lines)
  const target = blocks.find((block) => blockName(lines, block) === entityName)
  if (target === undefined) return fileContent

  let from = target.start
  let to = target.end
  // Drop the separator on whichever side it sits, so what remains is exactly
  // what was there before this document was inserted.
  if (from > 0 && isBlank(lines[from - 1])) from -= 1
  else if (isBlank(lines[to + 1])) to += 1

  return joinLines([...lines.slice(0, from), ...lines.slice(to + 1)], trailing)
}

export function listDocumentNames(fileContent: string): string[] {
  const { lines } = splitLines(fileContent)
  return findBlocks(lines)
    .map((block) => blockName(lines, block))
    .filter((name): name is string => name !== undefined)
}
