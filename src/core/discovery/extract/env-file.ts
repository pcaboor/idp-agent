import { looksLikeConnection, parseConnection } from '../connection.js'
import type { FileFacts, ParseFailure } from '../extractors.js'
import { mintFinding, type Finding } from '../finding.js'

/**
 * `env-file.url` (plan, Task 1.4): the connection strings a sample
 * environment file states — `.env.example` and its family, which the allow-
 * list names and the snapshot a model is sent withholds. One finding a line,
 * each `sample` (or `mention`, by where the file is, or `placeholder`, when
 * its value names another value), so none of them can vouch.
 *
 * It reads a dotenv file's syntax and nothing else: a line is a comment, a
 * blank, or `[export ]KEY=value`, the value bare (ending at ` #`), single- or
 * double-quoted. A quoted value that does not close on its line is
 * `unparsed`, and the lines dotenv carries it over are read as nothing, up to
 * its closing quote. A comment is skipped by its `#`, in whatever language it is
 * written, so no word of one is ever read. A value is a connection only when
 * the parser says it opens like one — a scheme it reads, `jdbc:`, a libpq or
 * ADO.NET key — and never because of its variable's name: `DATABASE_URL`
 * says nothing, and `PORT=3000` or `API_KEY=…` is no connection. A whole value
 * that is a reference (`X=${X}`) opens like none either, so it states nothing.
 */

/** `[export ]KEY=`: the key is everything up to `=` but white space and `#`; the grammar of `variable` judges it after. */
const ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([^\s=#]+)[ \t]*=/

type Quote = "'" | '"'

type Value = { readonly value: string } | { readonly unclosed: Quote }

/**
 * Whether a line carried inside a quoted value closes it: a double-quoted
 * value's `\"` and `\\` are escaped, a single-quoted one escapes nothing.
 */
function closes(text: string, quote: Quote): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    if (char === quote) return true
    if (quote === '"' && char === '\\') at += 1
  }
  return false
}

/**
 * A value as dotenv reads it, from just after `=`: quoted, up to its closing
 * quote (a double-quoted value's `\"` and `\\` escaped), whatever follows the
 * quote being a comment; bare, up to ` #` or the line's end, trimmed. A
 * quote that does not close on its line is a value this version cannot read:
 * dotenv may carry it over several lines, and `envFile` reads none of those
 * lines as keys, which would read the inside of a value.
 */
function valueOf(rest: string): Value {
  const text = rest.replace(/^[ \t]+/, '')
  const quote = text[0]
  if (quote === "'" || quote === '"') {
    let value = ''
    for (let at = 1; at < text.length; at += 1) {
      const char = text[at] ?? ''
      if (char === quote) return { value }
      if (quote === '"' && char === '\\' && at + 1 < text.length) {
        const next = text[at + 1] ?? ''
        value += next === '"' || next === '\\' ? next : `\\${next}`
        at += 1
        continue
      }
      value += char
    }
    return { unclosed: quote }
  }
  const comment = text.search(/[ \t]#/)
  return { value: (comment === -1 ? text : text.slice(0, comment)).trimEnd() }
}

export function envFile(facts: FileFacts): readonly Finding[] | ParseFailure {
  const findings: Finding[] = []
  const lines = facts.text.split('\n')
  /** The quote of a value carried over from an earlier line: every line until it closes is inside that value. */
  let open: Quote | undefined
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (open !== undefined) {
      // Inside a value: no key, no value, and what follows its closing quote
      // is a comment. One that never closes leaves the rest of the file in it.
      if (closes(line, open)) open = undefined
      continue
    }
    const assignment = ASSIGNMENT.exec(line)
    // A comment, a blank, or a line that assigns nothing: no key, no value.
    if (assignment === null) continue
    const variable = assignment[1] ?? ''
    const read = valueOf(line.slice(assignment[0].length))
    const draft = {
      rule: 'env-file.url' as const,
      path: facts.path,
      lines: [index + 1, index + 1] as const,
      fileSha256: facts.fileSha256,
      standing: facts.standing,
      variable,
    }
    if ('unclosed' in read) {
      // Reported, never dropped: a value nobody can say the end of here.
      open = read.unclosed
      findings.push(mintFinding({ ...draft, value: { connection: { outcome: 'unparsed', why: 'form' } } }))
      continue
    }
    if (read.value === '' || looksLikeConnection(read.value) === undefined) continue
    findings.push(mintFinding({ ...draft, value: { connection: parseConnection(read.value) } }))
  }
  return findings
}
