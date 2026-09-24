/**
 * Whole-document insertion and removal, line by line.
 *
 * A file is never rebuilt from a parsed tree: rewriting YAML from an AST
 * reformats everything, loses comments and reorders keys. A reviewer must see an
 * added line, and review is what authorises the change (design 4.3).
 *
 * So documents are found by reading lines, and that reading is a heuristic: it
 * knows the shapes catalogue files are actually written in — an implicit first
 * document, a byte-order mark, CRLF line endings, any consistent indentation,
 * comments anywhere — and no more. What it cannot locate it refuses, loudly. It is not what
 * guarantees an edit is right: `planEdits` reads every result back with the
 * parser and drops an operation whose bytes do not carry it out.
 */

const NEWLINE = '\n'
const CRLF = '\r\n'
const MARKER = '---'
const BOM = '﻿'

interface Block {
  /** first line of the document, header comments included */
  start: number
  /** the `---` line, or undefined for an implicit first document, which has none */
  marker: number | undefined
  /** the first line that may hold the document's own keys */
  body: number
  /** last content line, trailing blanks and the next header excluded */
  end: number
}

/**
 * A line without the `\r` a CRLF break leaves on it when the file mixes its
 * endings. Anchored patterns read that `\r` as part of the value, so `---` and
 * `metadata:` matched nothing; the line itself keeps it, since it is a byte.
 */
const bare = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)
const isBlank = (line: string | undefined): boolean => line !== undefined && line.trim() === ''
const isComment = (line: string | undefined): boolean =>
  line !== undefined && line.trimStart().startsWith('#')
/** `---` alone, or followed by blanks or a comment. `---x` is a scalar, not a marker. */
const isMarker = (line: string): boolean => /^---(?:[ \t]|$)/.test(bare(line))
/** A line of a document rather than of the stream: `%YAML` is a directive. */
const isContent = (line: string): boolean =>
  !isBlank(line) && !isComment(line) && !line.startsWith('%')

/**
 * `\r\n` when every line of the file ends in it, and `\n` otherwise. A file
 * saved on Windows is split on its own ending, so its lines read as any other
 * file's and an added line ends the way its neighbours do. A file that mixes
 * the two has no ending to copy: it is split on `\n`, each line keeps its `\r`,
 * and `bare` reads past it.
 */
function endingOf(content: string): string {
  return content.includes(CRLF) && !/(?:^|[^\r])\n/.test(content) ? CRLF : NEWLINE
}

function splitLines(content: string, eol: string): { lines: string[]; trailing: boolean } {
  const trailing = content.endsWith(eol)
  const body = trailing ? content.slice(0, -eol.length) : content
  return { lines: body === '' ? [] : body.split(eol), trailing }
}

/**
 * The lines of a file about to be searched. A byte-order mark is set aside
 * rather than left on the first line, where it made `---` and `metadata:`
 * unrecognisable, and joinLines puts it back: dropping bytes nobody asked to
 * drop is a reformat too.
 */
function readLines(content: string): {
  lines: string[]
  trailing: boolean
  bom: boolean
  eol: string
} {
  const bom = content.startsWith(BOM)
  const eol = endingOf(content)
  return { ...splitLines(bom ? content.slice(BOM.length) : content, eol), bom, eol }
}

function joinLines(lines: string[], trailing: boolean, bom: boolean, eol: string): string {
  if (lines.length === 0) return ''
  return (bom ? BOM : '') + lines.join(eol) + (trailing ? eol : '')
}

function findBlocks(lines: string[]): Block[] {
  const markers: number[] = []
  lines.forEach((line, index) => {
    if (isMarker(line)) markers.push(index)
  })

  const lastContent = (from: number, to: number): number => {
    let end = to
    while (end > from && (isBlank(lines[end]) || isComment(lines[end]))) end -= 1
    return end
  }
  // Comments sitting directly above a document introduce it, the way a comment
  // in YAML precedes what it describes. They move with it.
  const headerOf = (first: number): number => {
    let start = first
    while (start > 0 && isComment(lines[start - 1])) start -= 1
    return start
  }

  const blocks: Block[] = []

  // A file need not open with `---`: YAML reads whatever precedes the first
  // marker as a document of its own, and a hand-written single-entity file
  // often has no marker at all. Found by markers alone, such a file declared
  // nothing, while the parser read an entity in it.
  const first = markers[0] ?? lines.length
  const content = lines.slice(0, first).findIndex(isContent)
  if (content !== -1) {
    blocks.push({
      start: headerOf(content),
      marker: undefined,
      body: content,
      end: lastContent(content, first - 1),
    })
  }

  markers.forEach((marker, i) => {
    const next = markers[i + 1]
    blocks.push({
      start: headerOf(marker),
      marker,
      body: marker + 1,
      end: lastContent(marker, next === undefined ? lines.length - 1 : next - 1),
    })
  })

  return blocks
}

/** Leading blanks. YAML forbids a tab here, so anything else is malformed input. */
const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * A scalar as a line states it: quotes removed, so `'x'` and `x` are one
 * value, and a trailing comment dropped, so `x # why` is still `x`. A plain
 * scalar cannot contain ` #`, so the first one starts the comment.
 */
function scalarOf(raw: string): string {
  const text = raw.trim()
  const quoted = /^'([^']*)'|^"([^"]*)"/.exec(text)
  if (quoted !== null) return quoted[1] ?? quoted[2] ?? ''
  const comment = text.search(/(?:^|\s)#/)
  return (comment === -1 ? text : text.slice(0, comment)).trim()
}

/**
 * What a line assigns to `key` when it writes that key at exactly `indent`,
 * comment excluded; undefined when it does not write that key there.
 *
 * Bare, quoted, or with blanks before the colon — the forms YAML accepts for a
 * simple key. A form this does not recognise is a key a caller could open a
 * second time, which is why `appendSequenceItem` also looks for one it cannot
 * read before it opens anything.
 */
function valueOf(line: string, indent: number, key: string): string | undefined {
  if (indentOf(line) !== indent) return undefined
  const match = /^(?:([^\s'"#:][^:#]*?)|'([^']*)'|"([^"]*)")[ \t]*:(?:[ \t]+(.*))?$/.exec(
    bare(line).slice(indent),
  )
  if (match === null || (match[1] ?? match[2] ?? match[3]) !== key) return undefined
  return scalarOf(match[4] ?? '')
}

interface Mapping {
  /** the `key:` line */
  key: number
  /** what that line assigns, comment excluded: '' for a block mapping */
  value: string
  /** last content line under it, trailing blanks excluded */
  end: number
  /** indentation of the keys sitting directly under it, when it has any */
  childIndent: number | undefined
}

/**
 * A top-level key of a document and the block under it.
 *
 * Top-level only: a `spec:` nested inside another key is a different thing
 * with the same name, and so is a `name:` in a hand-written spec. The block
 * is closed by the next line at column zero — unless that line is a comment. A
 * comment is not a key: read as one, it closed a spec above its own
 * `dependencyOf:`, and a second key of that name was opened below it.
 */
function findMapping(lines: string[], block: Block, key: string): Mapping | undefined {
  let at: number | undefined
  let value = ''
  for (let i = block.body; i <= block.end; i += 1) {
    const found = valueOf(lines[i] ?? '', 0, key)
    if (found === undefined) continue
    at = i
    value = found
    break
  }
  if (at === undefined) return undefined

  let end = at
  let childIndent: number | undefined
  for (let i = at + 1; i <= block.end; i += 1) {
    const line = lines[i]
    if (line === undefined) break
    // A blank line does not close the block either, so a spec spaced out by
    // hand keeps everything a human put in it.
    if (isBlank(line)) continue
    if (isComment(line)) {
      if (indentOf(line) > 0) end = i
      continue
    }
    if (indentOf(line) === 0) break
    end = i
    childIndent ??= indentOf(line)
  }
  return { key: at, value, end, childIndent }
}

/** The `name:` under `metadata:`, at the indentation metadata's own keys use. */
function blockName(lines: string[], block: Block): string | undefined {
  const metadata = findMapping(lines, block, 'metadata')
  if (metadata?.childIndent === undefined || metadata.value !== '') return undefined
  for (let i = metadata.key + 1; i <= metadata.end; i += 1) {
    const name = valueOf(lines[i] ?? '', metadata.childIndent, 'name')
    if (name !== undefined) return name === '' ? undefined : name
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
  const eol = endingOf(fileContent)
  const { lines } = splitLines(fileContent, eol)
  if (lines.length === 0) return joinLines(documentLines, true, false, eol)
  return joinLines([...lines, '', ...documentLines], true, false, eol)
}

/**
 * Remove the document declaring `entityName`, along with the blank line that
 * separated it. Absent means already done: a branch may be replayed, so a
 * document that is not there is not an error (design 4.3).
 */
export function removeDocument(fileContent: string, entityName: string): string {
  const { lines, trailing, bom, eol } = readLines(fileContent)
  const blocks = findBlocks(lines)
  const target = blocks.find((block) => blockName(lines, block) === entityName)
  if (target === undefined) return fileContent

  let from = target.start
  let to = target.end
  // Drop the separator on whichever side it sits, so what remains is exactly
  // what was there before this document was inserted. An implicit first
  // document gives up the one after it: the one before separates it from the
  // file's own header, which stays where it was.
  if (target.marker === undefined && isBlank(lines[to + 1])) to += 1
  else if (from > 0 && isBlank(lines[from - 1])) from -= 1
  else if (isBlank(lines[to + 1])) to += 1

  return joinLines([...lines.slice(0, from), ...lines.slice(to + 1)], trailing, bom, eol)
}

/**
 * The key a line writes at `indent`, as far as it can be told without parsing:
 * `? `, quotes and blanks removed. Only used to notice a key `valueOf` did not
 * recognise.
 */
function keyTextOf(line: string, indent: number): string {
  const rest = line.slice(indent).replace(/^\?[ \t]*/, '')
  const colon = rest.indexOf(':')
  return (colon === -1 ? rest : rest.slice(0, colon)).trim().replace(/^['"]|['"]$/g, '')
}

/**
 * Append `item` to the `field:` sequence under the `spec:` of the document
 * declaring `entityName`, as one added line.
 *
 * The indentation comes from the file, never from an assumption: the field is
 * opened at whatever indentation the spec's first key uses, and an item is
 * written at whatever the sequence already uses — a block sequence may sit at
 * its key's own indentation, and re-indenting the ones that were there would
 * turn an added line into a rewritten block, which is the one thing this module
 * exists to avoid (§4.3).
 *
 * Unchanged only when the item is already in the sequence. Anything it cannot
 * do, it refuses with a SurgeryError: the entity is in no document it can find,
 * the document has no block `spec:`, the field is written in a form it cannot
 * extend. It used to return the text unchanged for the first two, citing
 * "absent means already done" — but that is a rule about removal, and an
 * unchanged file is byte-identical to "already listed": a plan that granted
 * nothing previewed as "nothing to change" and exited 0.
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
  const { lines, trailing, bom, eol } = readLines(text)
  const target = findBlocks(lines).find((block) => blockName(lines, block) === entityName)
  if (target === undefined) {
    throw new SurgeryError(
      `no document here declares ${entityName} in a shape a line edit can find`,
    )
  }

  const spec = findMapping(lines, target, 'spec')
  if (spec === undefined) throw new SurgeryError(`${entityName} has no spec block`)
  if (spec.value !== '') {
    throw new SurgeryError(
      `${entityName}.spec is not written as a block mapping; this edit cannot be made textually`,
    )
  }
  // Two spaces only when the spec has no child to copy from — what the
  // serialiser emits, so the file stays in one style.
  const childIndent = spec.childIndent ?? 2
  const join = (edited: string[]): string => joinLines(edited, trailing, bom, eol)

  let key: number | undefined
  let value = ''
  for (let i = spec.key + 1; i <= spec.end; i += 1) {
    const line = lines[i] ?? ''
    const found = valueOf(line, childIndent, field)
    if (found !== undefined) {
      key = i
      value = found
      break
    }
    // A key of that name this cannot read — `? dependencyOf`, say. Opening
    // `dependencyOf:` beside it would write a duplicate key, which is not YAML.
    if (
      !isComment(line) &&
      indentOf(line) === childIndent &&
      keyTextOf(line, childIndent) === field
    ) {
      throw new SurgeryError(
        `${entityName}.${field} is written in a form this edit cannot read, ` +
          'and it will not open a second one',
      )
    }
  }

  const opened = [
    `${' '.repeat(childIndent)}${field}:`,
    `${' '.repeat(childIndent * 2)}- ${item}`,
  ]

  if (key === undefined) {
    return join([...lines.slice(0, spec.end + 1), ...opened, ...lines.slice(spec.end + 1)])
  }

  if (/^\[[ \t]*\]$/.test(value)) {
    // An empty flow sequence cannot take a line, so the key is rewritten as the
    // block form, its spelling, comment and ending kept. One line replaced, one
    // added — still a diff a reviewer reads.
    const raw = lines[key] ?? ''
    const keyLine =
      bare(raw).replace(/[ \t]*\[[ \t]*\][ \t]*/, ' ').trimEnd() + raw.slice(bare(raw).length)
    return join([...lines.slice(0, key), keyLine, ...opened.slice(1), ...lines.slice(key + 1)])
  }
  if (value !== '') {
    // A non-empty flow sequence, an anchor, an alias, a tag — hand-written: the
    // serialiser emits none of them. Editing one means parsing YAML, and this
    // module's whole premise is that it never parses (§4.3).
    //
    // So it refuses, loudly. A caller can catch this and say which operation
    // it could not carry out; it cannot catch silence.
    throw new SurgeryError(
      value.startsWith('[')
        ? `${entityName}.${field} is written as a flow sequence; this edit cannot be made textually`
        : `${entityName}.${field} is written as \`${value}\`; this edit cannot be made textually`,
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
    if (isBlank(line) || isComment(line)) continue
    const at = indentOf(line)
    if (at >= childIndent && line.trimStart().startsWith('-')) {
      if (scalarOf(line.trimStart().replace(/^-\s*/, '')) === item) return text
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

  const written = `${' '.repeat(indent ?? childIndent * 2)}- ${item}`
  return join([...lines.slice(0, last + 1), written, ...lines.slice(last + 1)])
}

export function listDocumentNames(fileContent: string): string[] {
  const { lines } = readLines(fileContent)
  return findBlocks(lines)
    .map((block) => blockName(lines, block))
    .filter((name): name is string => name !== undefined)
}
