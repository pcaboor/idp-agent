/**
 * Model-authored text, with everything a terminal would obey removed.
 *
 * ADR-0007's consequence — "no model-authored text reaches stdout", since
 * ADR-0008 "none unlabelled or unchecked" — was stated for the read path and
 * did not hold for the write path. An audit
 * demonstrated it (F5): a `{unknown}` reason is up to 8 192 characters the
 * model writes, and `renderQuestions` printed it raw. A question reading
 *
 *     ESC[2JESC[H+++ b/dependencies/access/fake.yml
 *     1 file · nothing written
 *
 * clears the screen, homes the cursor, and prints a plausible diff under the
 * tool's own closing line. Nothing is written — the deception is of the person
 * reading, which is the whole basis on which they decide to merge.
 *
 * So every string a model or a repository file wrote passes through here
 * before it reaches a terminal, at one of two strengths:
 *
 *   - `inertLine`: one line, nothing a terminal obeys, the bidi overrides and
 *     isolates spelled out. On the event stream of every command, `ask`'s
 *     included (`said` and `whole` in `cli/index.ts`), on every reason `plan`
 *     and `init` print, on the `skipped` lines and on the question
 *     `promptOnTerminal` puts. And on an answer's commentary (ADR-0008), the
 *     one place the read path prints model-authored text on stdout: every
 *     sentence the engine's check keeps (`core/answer/commentary.ts`, handed
 *     this as its cleaner, so it matches the text as it will print), and
 *     every name the line about a dropped one quotes on stderr
 *     (`cli/commands/ask.ts`). `inert` is the same on as many lines as the
 *     text has, for the refusals `failed` prints on the way out of any
 *     command.
 *   - `oneLine`: the same, less the bidi escape. On what `show`, `graph`,
 *     `ask` and `validate` print from a file — `show`'s card, a table cell,
 *     the overview, a violation — and on `ask`'s two model-authored lines on
 *     stderr. A description, a tag, a link, a file name and a key a reason
 *     quotes are as much a file's words as a free-text type is.
 *
 * Two outputs are escaped rather than cleaned, by `visible`, because removing
 * a byte from them would change what they say: the partial plan a stop shows,
 * which is JSON, and the diff, whose context lines are a repository file's own
 * bytes.
 *
 * What this does NOT cover, and is worth knowing:
 *
 *   - **The JSON report.** `--json` escapes the sequence correctly, so the
 *     bytes a machine reads still carry it and a wrapper that prints a decoded
 *     value is exposed exactly as a terminal was. Escaping is the right
 *     behaviour for a machine channel; sanitising the human channel does not
 *     make the machine one safe, and the audit's own test says so.
 *   - **Meaning.** A reason can still lie in plain words — "approved by the
 *     platform team" is a sentence, not a sequence. This removes what a
 *     terminal OBEYS, never what a reader believes.
 *   - **Width.** A right-to-left override or a zero-width joiner is a
 *     printable character, not a control, and `plain` leaves it. `inertLine`,
 *     `inert` and `visible` spell the overrides and isolates out, because a
 *     reason `plan` prints sits on the line a reader decides a merge by;
 *     `oneLine` does not yet, so `show`'s card, the tables, `validate`'s
 *     violations and `ask`'s stderr print one as it is. U+2028 and U+2029
 *     are flattened wherever a line is (`\s` holds them) and left in the diff
 *     and the partial plan, where a terminal breaks no line on either.
 */

/**
 * Everything that starts with ESC, longest shape first.
 *
 *   1. a complete CSI — `ESC[`, parameter bytes (0x30–0x3F), intermediate
 *      bytes (0x20–0x2F), one final byte (0x40–0x7E), ECMA-48's shape;
 *   2. an INCOMPLETE one, because `oneLine` truncates at 200 characters and a
 *      sequence can arrive with its final byte cut off — the half that remains
 *      must not survive either;
 *   3. OSC, DCS, SOS, PM and APC, up to their string terminator (BEL or
 *      `ESC \`) or to the end if it never comes. OSC 8 is a hyperlink and
 *      OSC 52 writes the system clipboard on terminals that allow it;
 *   4. any other two-byte escape, and then a bare ESC.
 *
 * The alternatives are ordered because the regex engine takes the first that
 * matches: putting the bare ESC earlier would leave `[31` behind as text.
 */
const SEQUENCE =
  // eslint-disable-next-line no-control-regex -- removing them is the point
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\[[0-?]*[ -/]*|\u001B[\]PX^_][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-Z\\-_]|\u001B/g

/**
 * What is left once the sequences are gone: C0 except the two that lay text
 * out, DEL, and C1 — including U+009B, which a terminal in 8-bit mode reads as
 * CSI on its own.
 *
 * Newline and tab stay, because some text this cleans is several lines on
 * purpose — a refusal `inert` prints whole — and the callers that want one
 * line, `oneLine` and `inertLine`, flatten the whitespace themselves.
 * Carriage return does NOT: on its own it returns the cursor to the
 * start of the line, which overwrites what is already there — the same
 * deception as a clear-screen, spelled with one byte.
 */
const CONTROL =
  // eslint-disable-next-line no-control-regex -- removing them is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

export function plain(text: string): string {
  return text.replace(SEQUENCE, '').replace(CONTROL, '')
}

/**
 * Text this tool did not write, as one line of at most `max` characters: an
 * event on the stream, a model's reason on stderr, a description on `show`.
 *
 * `plain` first, then the flatten: stripping after truncating would leave the
 * front half of a sequence whose final byte the cut removed, and a
 * half-written CSI is still a CSI to whatever renders the line next. A cut
 * says so with an ellipsis — a line that stops without saying so is read as
 * complete. Counted in code points, so a cut never splits a surrogate pair.
 */
export function oneLine(text: string, max = 200): string {
  const flat = [...plain(text).replace(/\s+/g, ' ').trim()]
  return flat.length > max ? `${flat.slice(0, max).join('')}…` : flat.join('')
}

/**
 * The bidi controls that reorder what follows them: the embeddings and the
 * override (U+202A–U+202E) and the isolates (U+2066–U+2069). U+202E is the
 * one that makes `lmy.evil` read `live.yml`.
 *
 * The marks — LRM, RLM, ALM — are left alone. They move no run of text, only
 * the neutral character beside them, and they are how right-to-left writing
 * is actually typed: escaping them would deface Arabic and Hebrew to defend
 * against nothing (a request comes in any language).
 */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g

/**
 * What `visible` spells out: `CONTROL` and `BIDI` together, less the one
 * carriage return that ends a line. ESC is among them, so a whole sequence
 * comes out as its introducer spelled out and the rest as the text it was.
 */
const ESCAPED =
  // eslint-disable-next-line no-control-regex -- matching them is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]|\r(?!\n)/g

/**
 * Everything `plain` removes, plus the bidi controls, but spelled out as a
 * `\u` escape instead of removed — for the two outputs where removing a byte
 * would change what they say.
 *
 *   - **The partial plan a stop shows** is `JSON.stringify` output, which
 *     escapes C0 and leaves DEL, C1 and the bidi controls raw. `\u009b` is
 *     what JSON already spells U+009B as, so the text is still JSON and still
 *     that plan: parsed back, it is equal to the one that was refused.
 *   - **The diff** quotes three lines of context from the file it edits, and
 *     those are a repository file's bytes — YAML accepts a raw ESC in a
 *     comment, and the reader loads the file. A reviewer has to see that the
 *     line holds something there, and a line with a byte silently missing is
 *     a statement about a file that is not that file.
 *
 * Newline and tab stay, as in `plain`. So does a carriage return that ends a
 * line, which is how a file with CRLF endings reads and moves no cursor that
 * the newline after it does not; one in the middle of a line is the
 * overwrite, and is spelled out.
 *
 * Not reversible, and not meant to be: a file that already holds the six
 * characters `\u001b` prints exactly as one holding an ESC does. What it tells
 * the reader is that something is there; the file, or `--json`, says which.
 */
export function visible(text: string): string {
  return text.replace(ESCAPED, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** A reason's bound on stdout: three Reviewer reasons, and room to say which gate. */
export const REASON_LIMIT = 1_000

/**
 * A reason `plan` or `init` prints on stdout: one line, nothing a terminal
 * obeys, the bidi controls spelled out, cut at `max` with an ellipsis.
 *
 * One line, because each of them is printed where the engine's own lines are
 * — a question under its path, a refusal above the closing sentence — and a
 * newline in a model's reason is how it prints a line of ours. Bounded, and
 * more generously than the event stream: this is the answer rather than a
 * progress line, and the `--json` report carries every character of it.
 */
export function inertLine(text: string, max = REASON_LIMIT): string {
  return oneLine(text, max).replace(BIDI, (char) => visible(char))
}

/**
 * Text this tool did not write, kept on as many lines as it has: `plain`, with
 * the bidi controls spelled out. For a refusal `cli/index.ts` prints whole —
 * a message that quotes a file name, a key or a parser's excerpt of a file.
 */
export const inert = (text: string): string => plain(text).replace(BIDI, (char) => visible(char))
