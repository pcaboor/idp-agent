/**
 * Model-authored text, with everything a terminal would obey removed.
 *
 * ADR-0007's consequence — "no model-authored text reaches stdout" — was
 * stated for the read path and did not hold for the write path. An audit
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
 * So every string a model wrote passes through here before it reaches a
 * terminal: `renderQuestions` and `renderStopped` on stdout, `oneLine` on the
 * event stream and on `ask`'s stderr, `promptOnTerminal` on the prompt itself.
 * So does every string a repository file wrote, wherever `show`, `ask`,
 * `graph` and `validate` print one — the card, a table cell, the overview, a
 * `skipped` line, a violation: a description, a tag, a link, a file name and
 * a key a reason quotes are as much a file's words as a free-text type is.
 * `plan` and `init` are not in that list.
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
 *     printable character, not a control, and stays. Bidi spoofing of a path
 *     is a different problem from cursor control, and the diff is rendered
 *     from engine-computed paths rather than model text.
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
 * Newline and tab stay, because `renderQuestions` prints a path and its reason
 * on two lines and flattening that would break the one output this exists to
 * protect. Carriage return does NOT: on its own it returns the cursor to the
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
