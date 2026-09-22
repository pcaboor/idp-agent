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

/**
 * Raised when a document is in a shape textual surgery cannot edit without
 * reflowing it. Never silence: an unchanged file is the same answer as "the
 * edit was already made", and those are different facts.
 */
export class SurgeryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SurgeryError'
  }
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

/** Leading blanks. YAML forbids a tab here, so anything else is malformed input. */
const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * The text of a sequence item, quotes removed, so `'x'` and `x` are one item.
 * A trailing comment is not stripped: it stays part of the value and the item
 * reads as a different one, which errs towards leaving the line alone.
 */
function itemValue(line: string): string {
  const raw = line.trimStart().replace(/^-\s*/, '')
  const quoted = /^'([^']*)'$|^"([^"]*)"$/.exec(raw.trim())
  if (quoted === null) return raw.trim()
  return quoted[1] ?? quoted[2] ?? raw.trim()
}

interface SpecBlock {
  /** the `spec:` line */
  key: number
  /** last content line under it, trailing blanks excluded */
  end: number
  /** indentation of the keys sitting directly under `spec:` */
  childIndent: number
}

/**
 * `spec:` at the top level, the way blockName reads `metadata:`: a `spec:`
 * nested inside another key is a different thing with the same name.
 */
function findSpecBlock(lines: string[], block: Block): SpecBlock | undefined {
  let key: number | undefined
  for (let i = block.marker; i <= block.end; i += 1) {
    const line = lines[i]
    if (line !== undefined && /^spec:\s*$/.test(line)) {
      key = i
      break
    }
  }
  if (key === undefined) return undefined

  let end = key
  let childIndent: number | undefined
  for (let i = key + 1; i <= block.end; i += 1) {
    const line = lines[i]
    if (line === undefined) break
    if (isBlank(line)) continue
    // The next key at column zero closes the block; a blank line does not, so a
    // spec spaced out by hand keeps everything a human put in it.
    if (/^\S/.test(line)) break
    end = i
    if (childIndent === undefined && !isComment(line)) childIndent = indentOf(line)
  }
  // Two spaces only when the spec has no child to copy from — what the
  // serialiser emits, so the file stays in one style.
  return { key, end, childIndent: childIndent ?? 2 }
}

/**
 * Append `item` to the `field:` sequence under the `spec:` of the document
 * declaring `entityName`, as one added line.
 *
 * The indentation comes from the items already in that sequence, never from an
 * assumption: a block sequence may sit at its key's own indentation, and
 * re-indenting the ones that were there would turn an added line into a
 * rewritten block — which is the one thing this module exists to avoid (§4.3).
 *
 * Unchanged, for the same reason removeDocument leaves an absent document
 * alone (design 4.3, a branch may be replayed): the entity is not in the file,
 * it has no `spec:` to amend, or the item is already in the sequence. What is
 * not touched is a non-empty flow sequence: splitting `[a, b]` means parsing
 * flow syntax, and this module never parses.
 *
 * `item` is written verbatim. Quoting it, when it needs quoting, is the
 * caller's business — this layer only ever moves text.
 */
export function appendSequenceItem(
  text: string,
  entityName: string,
  field: string,
  item: string,
): string {
  const { lines, trailing } = splitLines(text)
  const blocks = findBlocks(lines)
  const target = blocks.find((block) => blockName(lines, block) === entityName)
  if (target === undefined) return text

  const spec = findSpecBlock(lines, target)
  if (spec === undefined) return text

  const prefix = `${' '.repeat(spec.childIndent)}${field}:`
  let key: number | undefined
  let keyLine = ''
  for (let i = spec.key + 1; i <= spec.end; i += 1) {
    const line = lines[i]
    // The prefix carries the indentation, so a key of the same name nested
    // deeper in the spec cannot match.
    if (line === undefined || !line.startsWith(prefix)) continue
    key = i
    keyLine = line
    break
  }

  const opened = [prefix, `${' '.repeat(spec.childIndent + 2)}- ${item}`]

  if (key === undefined) {
    return joinLines(
      [...lines.slice(0, spec.end + 1), ...opened, ...lines.slice(spec.end + 1)],
      trailing,
    )
  }

  const after = keyLine.slice(prefix.length).trim()
  // A comment is not a value: `dependencyOf: # consumers` still opens a block
  // sequence. A scalar that began with `#` would have been quoted.
  const value = after.startsWith('#') ? '' : after
  if (value === '[]') {
    // An empty flow sequence cannot take a line, so the key is rewritten as the
    // block form. One line replaced, one added — still a diff a reviewer reads.
    return joinLines([...lines.slice(0, key), ...opened, ...lines.slice(key + 1)], trailing)
  }
  if (value !== '') {
    // A non-empty flow sequence, hand-written: the serialiser never emits that
    // form. Editing it means parsing flow syntax — quotes, commas, nesting —
    // and this module's whole premise is that it never parses (§4.3).
    //
    // So it refuses, loudly. Returning the text unchanged was the original
    // behaviour and is the worse one: it is byte-identical to "the consumer is
    // already listed", so a plan that grants nothing previews as "nothing to
    // change" and exits 0. A caller can catch this and say which operation it
    // could not carry out; it cannot catch silence.
    throw new SurgeryError(
      `${entityName}.${field} is written as a flow sequence; this edit cannot be made textually`,
    )
  }

  let last = key
  let indent: number | undefined
  for (let i = key + 1; i <= spec.end; i += 1) {
    const line = lines[i]
    if (line === undefined) break
    // A comment or a blank line between the key and its items is not the end
    // of the sequence. Treating it as one made the new item land ABOVE the
    // existing ones — an append that prepends.
    if (isBlank(line) || line.trimStart().startsWith('#')) continue
    const at = indentOf(line)
    if (at >= spec.childIndent && line.trimStart().startsWith('-')) {
      if (itemValue(line) === item) return text
      last = i
      indent ??= at
      continue
    }
    // A line more indented than the items continues the one above it. Inserting
    // between an item and its continuation would produce YAML nobody wrote.
    if (indent !== undefined && at > indent) {
      last = i
      continue
    }
    break
  }

  const written = `${' '.repeat(indent ?? spec.childIndent + 2)}- ${item}`
  return joinLines([...lines.slice(0, last + 1), written, ...lines.slice(last + 1)], trailing)
}

export function listDocumentNames(fileContent: string): string[] {
  const { lines } = splitLines(fileContent)
  return findBlocks(lines)
    .map((block) => blockName(lines, block))
    .filter((name): name is string => name !== undefined)
}
