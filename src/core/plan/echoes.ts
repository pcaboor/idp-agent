/**
 * Did the request name this value?
 *
 * The question the signature turns on: a value the user wrote is `echoed`, and
 * `echoed` is the strongest claim a value can carry — stronger than "the
 * catalogue has one", because it is their request rather than something that
 * merely exists somewhere. `environment-mismatch` asks the same question from
 * the other side. They were two copies of this function, which is two places
 * for the answer to drift, and this repository has paid for that shape before.
 *
 * **The request is in whatever language the person wrote it in.** Nothing here
 * chooses one, and nothing may: the model decides what it understands, and
 * this is the deterministic half that has to hold for all of them.
 *
 * **A value is named when a whole token of the request IS it** — never when a
 * token merely contains it. A token is letters, marks and digits of any
 * script, joined by `.`, `_` or `-` where one of those stands between two of
 * them, so `orders-db`, `prod.eu` and `billing_api` are one token each and the
 * full stop ending "in prod." is not part of one. The typographic hyphens,
 * U+2010 and U+2011, are `-` here (`fold`). The hyphen used to be a word
 * boundary, and three things followed from it:
 *
 *   "non-prod", "pre-prod" and "hors-prod" named `prod`, and
 *   `environment-mismatch` took each as a request for production
 *   `lion` was found in "lion-ops", on the owner's side
 *   `preprod` was not found in "pre-prod" — and still is not: `pre-prod` is
 *   another word, and an environment the request did not spell is asked
 *
 * A value that is itself several tokens — a reference, `group:default/lion` —
 * is named when it stands in the request with a boundary on both sides, which
 * for a one-token value is the same test.
 *
 * **The boundary is also a change of SCRIPT.** Every identifier this compares
 * is Latin — a Backstage name, an environment, a type — so a Latin letter next
 * to one continues the word, whatever its accent, while a letter from any
 * other script ends it, listed anywhere or not (`differ`):
 *
 *   `prodüksiyon` is one Turkish word, not `prod` and a remainder
 *   `devět` is one Czech word, `devåkning` one Swedish word
 *   `prod環境` is `prod` and a Japanese word, and the request did name prod
 *   `prod환경의` is `prod` and a Korean word, the particle attached
 *
 * An `[^a-z0-9]` boundary got the first three wrong, because `ü`, `ě` and `å`
 * are not in `a-z`. Each was an environment the request never asked for,
 * signing cleanly — the escape §4.1 exists to close. A request with no spaces
 * between words is ordinary in several scripts, which is why the script, and
 * not only the space, ends a token.
 *
 * Both sides are compared after NFKC and without regard to case, so `ＰＲＯＤ`
 * typed full-width names `prod`.
 *
 * What this does NOT do is understand the request. It answers whether a string
 * appears in it as a word, nothing more: a request that names `prod` to say
 * "anything but prod" reads, HERE, the same as one asking for it — and so does
 * "not prod", "hors prod", "non–prod" with a dash, "prodではなく", or a
 * negation attached across a change of script, `非prod` or `비prod`. That is
 * why no environment is ever read through this (`requestedEnvironment`), in
 * any language, as no level is (`signPlan`): a word test cannot read a
 * negation, and no list of negations is ever complete. What it reads is the
 * words a value may be vouched for by — a name, an owner, the references a
 * request names in full, which is how a request points at a declaration whose
 * environment it then has, never at a name that merely spells one.
 *
 * Also true of the text as the person saw it: characters nobody sees are not
 * read (`fold`), so a soft hyphen or a zero-width space splits no word.
 */
export function echoes(intent: string, value: string): boolean {
  const text = Array.from(fold(intent))
  const wanted = Array.from(fold(value))
  const first = wanted[0]
  const last = wanted[wanted.length - 1]
  if (first === undefined || last === undefined) return false

  for (let start = 0; start + wanted.length <= text.length; start += 1) {
    if (!wanted.every((char, offset) => text[start + offset] === char)) continue
    const end = start + wanted.length
    if (continues(first, text[start - 1], text[start - 2])) continue
    if (continues(last, text[end], text[end + 1])) continue
    return true
  }
  return false
}

/**
 * The words of a text as prose splits them, folded (`fold`): letters, marks
 * and digits of one script, ended by anything else — a hyphen, a dash, a
 * space — and by a change of script (`differ`).
 *
 * Finer than a token on purpose: `echoes` keeps "non-prod" one token so that
 * it names no `prod`, and this splits it into `non` and `prod`, so a negation
 * joined to its word is still found (`negates`). Read for markers only, never
 * for a value.
 */
export function proseWords(text: string): string[] {
  const words: string[] = []
  let current = ''
  let previous: string | undefined
  for (const char of fold(text)) {
    if (!WORD.test(char)) {
      if (current !== '') words.push(current)
      current = ''
      previous = undefined
      continue
    }
    if (previous !== undefined && differ(previous, char)) {
      words.push(current)
      current = ''
    }
    current += char
    previous = char
  }
  if (current !== '') words.push(current)
  return words
}

const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu

/**
 * Nothing invisible, NFKC, lower case, and one hyphen.
 *
 * The invisible first, before anything else reads the text: the
 * default-ignorable code points — a soft hyphen, a zero-width space or
 * joiner, a word joiner, the bidi controls, the variation selectors — show
 * nothing, and left in they were a boundary no reader sees. "non\u00ADprod" is
 * "nonprod" on screen and once named `prod` here, core-plan-4 in a form the
 * hyphen rule never reached. Taken out as the commentary takes them out
 * (`answer/commentary.ts`), so `non\u200Bprod` is `nonprod` and
 * `orders-db\u200B-dev` is `orders-db-dev`.
 *
 * U+2010 HYPHEN is what a word processor, a wiki or French typography writes
 * for `-`, and U+2011, the non-breaking one, is what NFKC leaves as U+2010:
 * both are hyphens by Unicode's definition, not dashes. Left apart,
 * "non‐prod" split into `non` and `prod` — core-plan-4 again, in text that
 * looks identical to the case it closes.
 */
export const fold = (text: string): string =>
  text
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010\u2011]/gu, '-')

const WORD = /^[\p{L}\p{M}\p{N}]$/u
const LETTER = /^\p{L}$/u
const JOINER = /^[._-]$/u

/**
 * Does the character next to the value's `edge` carry its token on — so the
 * value is only part of a longer one? `beyond` is the character past it, for a
 * joiner: `-` continues a token only where a letter or a digit follows it.
 */
function continues(
  edge: string,
  neighbour: string | undefined,
  beyond: string | undefined,
): boolean {
  if (neighbour === undefined || !WORD.test(edge)) return false
  if (WORD.test(neighbour)) return !differ(edge, neighbour)
  return JOINER.test(neighbour) && beyond !== undefined && WORD.test(beyond)
}

const LATIN = /^[\p{Script=Latin}0-9]$/u
const MARK = /^\p{M}$/u

/**
 * Two characters of two scripts, which are two words with no space between
 * them. Total, and not a list someone kept: every value compared is an
 * identifier — a Backstage name, a type, an environment the repository
 * already uses — written in Latin letters and digits, so a letter of ANY
 * other script next to a Latin side ends the token, whatever script it is.
 * Tifinagh, Cherokee, Yi and Adlam read as Japanese does. A digit counts on
 * the Latin side, where the identifier's own digits are; a mark continues the
 * letter it sits on, whatever it is.
 *
 * Between two letters of other scripts — a value that is not Latin, which
 * nothing forbids an environment to be — the listed scripts tell them apart,
 * and two letters of scripts not listed continue each other: a value named
 * less is asked.
 */
function differ(one: string, other: string): boolean {
  if (MARK.test(one) || MARK.test(other)) return false
  const latin = [LATIN.test(one), LATIN.test(other)]
  if (latin[0] !== latin[1]) return LETTER.test(one) || LETTER.test(other)
  if (latin[0] === true || !LETTER.test(one) || !LETTER.test(other)) return false
  const [a, b] = [scriptOf(one), scriptOf(other)]
  return a !== -1 && b !== -1 && a !== b
}

/** The scripts two non-Latin letters are told apart by. See `differ`. */
const SCRIPTS = [
  /\p{Script=Greek}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Georgian}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Syriac}/u,
  /\p{Script=Thaana}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Bengali}/u,
  /\p{Script=Gurmukhi}/u,
  /\p{Script=Gujarati}/u,
  /\p{Script=Oriya}/u,
  /\p{Script=Tamil}/u,
  /\p{Script=Telugu}/u,
  /\p{Script=Kannada}/u,
  /\p{Script=Malayalam}/u,
  /\p{Script=Sinhala}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Lao}/u,
  /\p{Script=Tibetan}/u,
  /\p{Script=Myanmar}/u,
  /\p{Script=Khmer}/u,
  /\p{Script=Mongolian}/u,
  /\p{Script=Ethiopic}/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Hiragana}/u,
  /\p{Script=Katakana}/u,
  /\p{Script=Bopomofo}/u,
  /\p{Script=Han}/u,
] as const

const scriptOf = (letter: string): number => SCRIPTS.findIndex((script) => script.test(letter))
