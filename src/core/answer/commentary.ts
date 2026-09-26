/**
 * The engine's check on the model's own sentences (ADR-0008).
 *
 * An answer to a question is the engine's block — a table, a card, the
 * overview — and, around it, an introduction and a conclusion the model wrote
 * in the same terminal call. The block is the authority; the sentences only
 * frame it, and they cross the boundary under this check, never on trust:
 *
 *   1. each field is split into sentences (`Intl.Segmenter`, every script —
 *      `。`, `؟` and `!` end one as `.` does). Unicode's rules read a full stop
 *      followed by a lower-case word as no end (`e.g. this`); entity names are
 *      lower-case, so a full stop after a word of two characters or more, then
 *      a space, ends a sentence here too when the next word is read as a name
 *      (`sentencesOf`) — "… tiger. orders-db-dev …" is two sentences, and
 *      the first is not dropped with the second;
 *   2. each sentence is cleaned by the cleaner the terminal line is printed
 *      through, less its soft hyphens, and matched as that cleaned text reads
 *      — normalised for the match only: NFKC, lower case, every character
 *      that prints as nothing removed (zero-width joiners, variation
 *      selectors, the combining grapheme joiner, invisible fillers), and the
 *      hyphen, slash and colon lookalikes read as the characters they
 *      imitate. `billing\u200B-db`, `billing˗db` and full-width letters are
 *      `billing-db`;
 *   3. a sentence is DROPPED, whole and never edited, when it
 *        - names an entity the graph holds and no tool returned in this
 *          conversation — by its name, its full reference or a short one
 *          (`kind:name`, `namespace/name`), at a script-aware word boundary,
 *          with any dash or line between its parts read as a hyphen
 *          (`billing–api`, `billing─api`); or
 *        - carries an identifier nobody read — letters or digits joined by
 *          `_` `.` `/` or `:`, or holding a digit (`orders_db`, `db.yml`,
 *          `api-v2`); letters joined by hyphens alone only when a catalogue
 *          name could be spelled so and a part of it is a part of one
 *          (`payments-db`, but never `peut-être`, `sous-système` or
 *          `read-only`: a word of prose is not a name) — or a word that mixes
 *          the letters of two scripts (`lеdger`, a Cyrillic `е`), that is
 *          neither the name or a reference of a witnessed entity, nor a value
 *          one declares, nor a value of the vocabulary the model was shown, nor
 *          a token of the question itself (a question about `payments-db` may
 *          be answered "payments-db is not declared");
 *   4. what is kept is bounded: the introduction is the first kept sentence
 *      and only it, the conclusion at most three, each field under a bound in
 *      characters. The cut is only ever at a sentence boundary: a sentence
 *      that alone exceeds its bound is dropped, never cut.
 *
 * What it guarantees is narrow, and ADR-0008 says so: a kept sentence names no
 * entity of the graph that no tool returned, by its name or its reference, and
 * carries no identifier nobody read. Everything written in ordinary words
 * passes — a team, a product, a place, a paraphrase of an unread entity ("the
 * billing API"), a figure — and so does a sentence wrong about what WAS read:
 * "billing-api writes to billing-db-prod" when the grant says read. That is
 * why every kept line is printed marked as the model's.
 *
 * Plain data in and out: `core/` holds no graph and imports no renderer, so
 * the entities arrive as `KnownEntity` values and the cleaner is handed in.
 */

/** The bounds on what is printed, in characters (code points) of cleaned text. */
export const COMMENTARY_LIMITS = {
  introChars: 240,
  conclusionChars: 480,
  conclusionSentences: 3,
} as const

/** An entity the graph holds, as the check needs it. */
export interface KnownEntity {
  /** `kind:namespace/name`, lower-case kind, as `refOf` writes it. */
  readonly ref: string
  readonly name: string
  /**
   * Values the entity declares, which a sentence about it may quote once a
   * tool returned it: its owner, system, type, environment, lifecycle, the
   * level a right grants, its tags, and the references it declares that name
   * nothing, once a tool showed them.
   */
  readonly declares: readonly string[]
}

export interface CommentaryFacts {
  /** Every entity the graph holds, witnessed or not. */
  readonly entities: readonly KnownEntity[]
  /** The references the read tools returned in this conversation. */
  readonly witnessed: ReadonlySet<string>
  /**
   * The values the model's opening message listed — kinds, types,
   * environments, owners (`formatSummary`). It read them there.
   */
  readonly vocabulary: readonly string[]
  /** The request, in the user's own words. */
  readonly question: string
  /**
   * What a kept sentence is printed through — `inertLine`, one line with
   * nothing a terminal obeys. Handed in because `core/` imports no renderer;
   * the match is taken over its output, so what is checked is what is read.
   */
  readonly clean: (text: string) => string
}

export type DroppedSentence =
  /** It named something no tool returned: an entity of the graph, or an identifier. */
  | {
      readonly why: 'unread'
      readonly sentence: string
      readonly names: readonly string[]
    }
  /** It was past the bound of its field: a second introduction, a fourth conclusion, too long. */
  | { readonly why: 'bound'; readonly sentence: string }

export interface CheckedCommentary {
  readonly intro: string | undefined
  /** One sentence per element, in the model's order. */
  readonly conclusion: readonly string[]
  /** Every sentence left out, cleaned, in the order met: the introduction's first. */
  readonly dropped: readonly DroppedSentence[]
}

export function checkCommentary(
  commentary: {
    readonly intro?: string | undefined
    readonly conclusion?: string | undefined
  },
  facts: CommentaryFacts,
): CheckedCommentary {
  const known = namesOf(facts)
  const dropped: DroppedSentence[] = []

  const introKept = kept(commentary.intro ?? '', known, facts.clean, dropped)
  const [first, ...more] = introKept
  let intro: string | undefined
  if (first !== undefined) {
    if (length(first) <= COMMENTARY_LIMITS.introChars) intro = first
    else dropped.push({ why: 'bound', sentence: first })
  }
  for (const sentence of more) dropped.push({ why: 'bound', sentence })

  const conclusion: string[] = []
  let total = 0
  let full = false
  for (const sentence of kept(commentary.conclusion ?? '', known, facts.clean, dropped)) {
    const size = length(sentence)
    // A sentence too long on its own is dropped and the next one considered;
    // one that would carry the whole past its bound ends the conclusion there,
    // at the boundary before it.
    if (
      full ||
      size > COMMENTARY_LIMITS.conclusionChars ||
      conclusion.length === COMMENTARY_LIMITS.conclusionSentences
    ) {
      dropped.push({ why: 'bound', sentence })
      continue
    }
    if (total + size > COMMENTARY_LIMITS.conclusionChars) {
      full = true
      dropped.push({ why: 'bound', sentence })
      continue
    }
    conclusion.push(sentence)
    total += size
  }

  return { intro, conclusion, dropped }
}

/** In code points, as `oneLine` counts: a bound never splits a surrogate pair. */
const length = (text: string): number => [...text].length

/**
 * The sentences of one field that name nothing unread, cleaned. The ones that
 * do go to `dropped` with what they named.
 */
function kept(
  text: string,
  known: Names,
  clean: (text: string) => string,
  dropped: DroppedSentence[],
): string[] {
  const result: string[] = []
  for (const segment of sentencesOf(text, known)) {
    const sentence = clean(segment.replace(SOFT_HYPHEN, ''))
    if (sentence === '') continue
    const names = unread(sentence, known)
    if (names.length > 0) dropped.push({ why: 'unread', sentence, names })
    else result.push(sentence)
  }
  return result
}

/**
 * The root locale: the segmentation rules of Unicode's own annex, the same on
 * every machine, whatever language the question was asked in.
 */
const SENTENCES = new Intl.Segmenter('und', { granularity: 'sentence' })

/**
 * The sentences of a text: Unicode's, each cut again where a full stop after
 * a word of two characters or more, then a space, comes before a word the
 * check reads as a name — an identifier-shaped token, or a name or reference
 * of an entity the graph holds. Unicode reads a full stop before a lower-case
 * word as the sentence going on (`e.g. this`), and entity names are
 * lower-case: without the cut, "It is owned by tiger. orders-db-dev is not."
 * would be one sentence, and the first half dropped with the second. Nowhere
 * else: after an abbreviation of single letters (`e.g.`, `i.e.`) or before a
 * word of prose (`bzw. einem`, `etc. and`), Unicode's reading stands.
 */
function sentencesOf(text: string, known: Names): string[] {
  const result: string[] = []
  for (const { segment } of SENTENCES.segment(text)) {
    let from = 0
    for (const stop of segment.matchAll(FULL_STOP)) {
      const end = stop.index + stop[0].length
      if (
        AFTER_WORD.test(normalised(segment.slice(from, stop.index))) &&
        startsWithName(segment.slice(end), known)
      ) {
        result.push(segment.slice(from, end))
        from = end
      }
    }
    result.push(segment.slice(from))
  }
  return result
}

/**
 * A full stop in any of its forms (Unicode's `ATerm`: `.`, `․`, `﹒`, `．`),
 * the closing brackets and quotes after it, and the space that follows.
 */
const FULL_STOP = /[.\u2024\uFE52\uFF0E][\p{Ps}\p{Pe}\p{Pi}\p{Pf}"']*\s+/gu

/** What a text ends on before a full stop that may end a sentence: a word of two characters or more. */
const AFTER_WORD = /[\p{L}\p{N}\p{M}]{2,}[\p{Pe}\p{Pf}"']*$/u

/** Whether a text starts with a word the check reads as a name, in either reading. */
function startsWithName(text: string, known: Names): boolean {
  const strict = normalised(text)
  if (!STARTS_WITH_WORD.test(strict)) return false
  const [first] = tokensOf(strict)
  const [joined] = tokensOf(dashed(strict))
  return (
    (first !== undefined && (invented(first, known) || known.graph.has(first))) ||
    (joined !== undefined && known.graph.has(joined))
  )
}

const STARTS_WITH_WORD = /^[\p{L}\p{N}\p{M}]/u

/**
 * The soft hyphen, removed from what is PRINTED, not only from what is matched.
 * It says where a word may break across lines, which means nothing on one, and
 * terminals disagree on it — some draw `-`, some nothing — so `billing­db­dev`
 * would be checked as one reading and seen as the other. Gone, it has one.
 */
const SOFT_HYPHEN = /\u00AD/gu

interface Names {
  /** Every form of every entity the graph holds, witnessed or not. */
  readonly graph: ReadonlySet<string>
  /** Every form of every entity no tool returned, less what `allowed` holds. */
  readonly unwitnessed: ReadonlySet<string>
  /** The witnessed entities' forms and values, and the vocabulary's. */
  readonly allowed: ReadonlySet<string>
  /** The question's tokens: kept when identifier-shaped, never a way to name an unread entity. */
  readonly question: ReadonlySet<string>
  /** Every part of every name the graph holds: `billing`, `db`, `prod` of `billing-db-prod`. */
  readonly parts: ReadonlySet<string>
}

function namesOf(facts: CommentaryFacts): Names {
  const allowed = new Set<string>()
  const unwitnessed = new Set<string>()
  const graph = new Set<string>()
  const parts = new Set<string>()
  for (const entity of facts.entities) {
    for (const form of formsOf(entity.ref, entity.name)) graph.add(form)
    for (const part of normalised(entity.name).match(PARTS) ?? []) parts.add(part)
    if (facts.witnessed.has(entity.ref)) {
      for (const form of formsOf(entity.ref, entity.name)) allowed.add(form)
      for (const value of entity.declares) for (const form of valueForms(value)) allowed.add(form)
    } else {
      for (const form of formsOf(entity.ref, entity.name)) unwitnessed.add(form)
    }
  }
  for (const value of facts.vocabulary) for (const form of valueForms(value)) allowed.add(form)
  // A name two entities share, one of them witnessed, is read as the
  // witnessed one: nothing tells the two apart, and the full reference of
  // the other is still caught.
  for (const form of allowed) unwitnessed.delete(form)
  const question = normalised(facts.question)
  return {
    graph,
    unwitnessed,
    allowed,
    question: new Set([...tokensOf(question), ...tokensOf(dashed(question))]),
    parts,
  }
}

/** The ways a sentence can name an entity: its reference in full, its short forms, its name. */
function formsOf(ref: string, name: string): string[] {
  const forms = [normalised(ref), normalised(name)]
  const match = REF.exec(ref)
  if (match !== null) {
    const [, kind = '', namespace = '', named = ''] = match
    forms.push(normalised(`${namespace}/${named}`))
    if (namespace === 'default') forms.push(normalised(`${kind}:${named}`))
  }
  return forms
}

const REF = /^([^:/]+):([^:/]+)\/(.+)$/

/** A declared value, and its short forms when it is a reference (`group:default/tiger`). */
function valueForms(value: string): string[] {
  const match = REF.exec(value)
  if (match === null) return [normalised(value)]
  const [, , , name = ''] = match
  return formsOf(value, name)
}

/**
 * What a cleaned sentence names that nobody read, in the order met and each
 * once. Empty when it names nothing unread.
 *
 * Read twice. Once with every dash taken for the hyphen it looks like, to find
 * a name the graph holds however it was joined — `billing–api`, `billing—api`
 * — and a word that mixes scripts. Once with the joiners alone, to find an
 * identifier nobody read: a dash between two words is prose as often as not
 * ("the database—the one in prod—"), and reading it as a joiner there would
 * make an identifier of every closed dash.
 */
function unread(sentence: string, known: Names): string[] {
  const names: string[] = []
  const add = (name: string): void => {
    if (!names.includes(name)) names.push(name)
  }
  const strict = normalised(sentence)
  for (const token of tokensOf(dashed(strict))) {
    if (known.allowed.has(token)) continue
    // Any run of whole parts of the token, so a name hidden inside a longer
    // identifier — `orders-db-prod.yml` — is still that name.
    const inside = spans(token).find((span) => known.unwitnessed.has(span))
    if (inside !== undefined) add(inside)
    else if (mixesScripts(token) && !known.question.has(token)) add(token)
  }
  for (const token of tokensOf(strict)) {
    if (known.allowed.has(token) || known.question.has(token)) continue
    const inside = spans(token).find((span) => known.unwitnessed.has(span))
    if (inside !== undefined) add(inside)
    else if (invented(token, known)) add(token)
  }
  return names
}

/** Letters, digits and marks, of any script. */
const WORD = '[\\p{L}\\p{N}\\p{M}]'
/** What joins the parts of an identifier. */
const JOINER = '[-_./:]'

/**
 * A run of letters and digits joined by joiners, starting and ending on a
 * letter or digit — so the full stop that ends a sentence is not part of the
 * name before it, and a neighbour that is neither a letter, a digit, a mark
 * nor a joiner is a boundary: `(billing-db).`, `«billing-db»`, `billing-db’s`.
 */
const TOKEN = new RegExp(`${WORD}+(?:${JOINER}+${WORD}+)*`, 'gu')
const JOINED = new RegExp(JOINER, 'u')
const PARTS = new RegExp(`${WORD}+`, 'gu')
const LETTER = /\p{L}/u

/** Every token of a normalised text, split where the script changes. */
function tokensOf(text: string): string[] {
  return (text.match(TOKEN) ?? []).flatMap(byScript)
}

/**
 * A token cut where a script written without spaces meets another, so a name
 * followed by a word with no space between — `billing-dbは本番です`,
 * `billing-db는` — is still a name at a boundary. Only there: two scripts
 * that separate their words with spaces are not cut apart, so a Cyrillic `ԁ`
 * beside each hyphen of `billing-ԁb-ԁev` leaves one identifier, not three
 * plain words, and a word that mixes them is read as the lookalike it is
 * (`mixesScripts`). Digits and marks belong to no script and cut nothing.
 */
function byScript(token: string): string[] {
  const pieces: string[] = []
  let current = ''
  let script: string | undefined
  for (const char of token) {
    const next = scriptOf(char)
    if (
      next !== undefined &&
      script !== undefined &&
      next !== script &&
      (GLUED.has(next) || GLUED.has(script))
    ) {
      pieces.push(current)
      current = ''
    }
    if (next !== undefined) script = next
    current += char
  }
  pieces.push(current)
  return pieces.map(trimJoiners).filter((piece) => piece !== '')
}

/**
 * The scripts that take a foreign word with no space before or after it:
 * Chinese, Japanese and the scripts of South-East Asia write none, and Korean
 * glues its particles to the word they follow.
 */
const GLUED: ReadonlySet<string> = new Set(['cjk', 'southeast-asian', 'hangul'])

/**
 * Letters of two scripts in one word, where no script written without spaces
 * explains it. No word of any language is spelled so; a lookalike is — `lеdger`
 * with a Cyrillic `е` prints as `ledger` and is no name the graph holds.
 */
function mixesScripts(token: string): boolean {
  let first: string | undefined
  for (const char of token) {
    const script = scriptOf(char)
    if (script === undefined) continue
    if (first === undefined) first = script
    else if (script !== first) return true
  }
  return false
}

const trimJoiners = (text: string): string => text.replace(/^[-_./:]+|[-_./:]+$/gu, '')

/**
 * The scripts a letter is told apart by. Japanese writes one word in Han,
 * hiragana and katakana, so they are one; a letter of a script not listed
 * here is `other`, and one every script shares (Unicode's `Common`, with no
 * script named beside it) belongs to none and cuts nothing.
 */
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['latin', /\p{Script_Extensions=Latin}/u],
  ['greek', /\p{Script_Extensions=Greek}/u],
  ['cyrillic', /\p{Script_Extensions=Cyrillic}/u],
  ['armenian', /\p{Script_Extensions=Armenian}/u],
  ['hebrew', /\p{Script_Extensions=Hebrew}/u],
  [
    'arabic',
    /[\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Thaana}]/u,
  ],
  [
    'indic',
    /[\p{Script_Extensions=Devanagari}\p{Script_Extensions=Bengali}\p{Script_Extensions=Gurmukhi}\p{Script_Extensions=Gujarati}\p{Script_Extensions=Oriya}\p{Script_Extensions=Tamil}\p{Script_Extensions=Telugu}\p{Script_Extensions=Kannada}\p{Script_Extensions=Malayalam}\p{Script_Extensions=Sinhala}]/u,
  ],
  [
    'southeast-asian',
    /[\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}\p{Script_Extensions=Tibetan}]/u,
  ],
  ['georgian', /\p{Script_Extensions=Georgian}/u],
  ['ethiopic', /\p{Script_Extensions=Ethiopic}/u],
  ['hangul', /\p{Script_Extensions=Hangul}/u],
  [
    'cjk',
    /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Bopomofo}]/u,
  ],
]
const SHARED = /[\p{Script=Common}\p{Script=Inherited}]/u

function scriptOf(char: string): string | undefined {
  if (!LETTER.test(char)) return undefined
  for (const [name, pattern] of SCRIPTS) if (pattern.test(char)) return name
  return SHARED.test(char) ? undefined : 'other'
}

/**
 * Every run of whole parts of a token, the token itself included:
 * `a-b.c` gives `a`, `a-b`, `a-b.c`, `b`, `b.c`, `c`.
 */
function spans(token: string): string[] {
  const parts = [...token.matchAll(PARTS)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  const result: string[] = []
  for (let from = 0; from < parts.length; from += 1) {
    for (let to = from; to < parts.length; to += 1) {
      result.push(token.slice(parts[from]!.start, parts[to]!.end))
    }
  }
  return result
}

/**
 * Letters or digits joined by a joiner, and more than a number or an
 * abbreviation. A token with no letter — `2026-09-25`, `10:30`, `3.5` — and one
 * whose every part is a single character — `e.g`, `i.e`, `c.-à-d` — names no
 * entity the model could have invented; an entity that really is called that
 * is still caught by its name.
 */
function identifierShaped(token: string): boolean {
  if (!JOINED.test(token) || !LETTER.test(token)) return false
  return (token.match(PARTS) ?? []).some((part) => [...part].length > 1)
}

/**
 * An identifier-shaped token the model may have made up, as rule (ii) reads
 * one. A hyphen joins the words of prose in more languages than it joins
 * names — `peut-être`, `c'est-à-dire`, `sous-système`, `read-only`,
 * `well-known` — and dropping every sentence that holds one would leave a
 * French conclusion with nothing in it. So letters joined by hyphens alone
 * are an identifier only when they could be a name of this catalogue: every
 * character one Backstage allows (a name is `[A-Za-z0-9]` joined by `-_.`, so
 * `ê` or `à` is prose) and a part shared with a name the graph holds —
 * `payments-db` beside a `billing-db`. Anything else identifier-shaped — an
 * underscore, a dot, a slash, a colon or a digit in it — is a name as before.
 *
 * What passes is an invented name that shares no part with the catalogue's
 * (`ghost-gateway` in a catalogue with no `ghost` and no `gateway`): it reads
 * as a word, and the label is what covers it.
 */
function invented(token: string, known: Names): boolean {
  if (!identifierShaped(token)) return false
  if (!PROSE_COMPOUND.test(token)) return true
  if (!NAME_SPELLING.test(token)) return false
  return token.split('-').some((part) => known.parts.has(part))
}

/** Letters joined by hyphens and nothing else: no digit, no other joiner. */
const PROSE_COMPOUND = /^[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)+$/u
/** What a catalogue name can be spelled with, once lower-cased. */
const NAME_SPELLING = /^[a-z0-9-]+$/

/**
 * Invisible, and removed before matching: every default-ignorable character —
 * the format characters (zero-width space and joiners, the word joiner, the
 * bidi controls), the variation selectors, the combining grapheme joiner, the
 * Mongolian selectors, the Khmer inherent vowels, the tag characters and the
 * Hangul fillers. Most are marks or letters to a regular expression, so left
 * in they would sit inside a word and spell another: `led͏ger` is `ledger` on
 * screen and must be `ledger` here.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu

/**
 * What NFKC leaves and a reader takes for a joiner, read as that joiner in
 * every reading: the hyphens and the minus signs (U+2010 to U+2012, U+2043,
 * U+2212, U+FE63, U+02D7, U+2796), the slashes (U+2044, U+2215, U+29F8) and the
 * colons (U+2236, U+A789). None of them has a use between two letters but to
 * join them.
 */
const LOOKALIKES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2010-\u2012\u2043\u2212\uFE63\u02D7\u2796]/gu, '-'],
  [/[\u2044\u2215\u29F8]/gu, '/'],
  [/[\u2236\uA789]/gu, ':'],
]

/** A text as the check matches it. Never printed: the reader sees the cleaned original. */
function normalised(text: string): string {
  let result = text
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKC')
    .replace(INVISIBLE, '')
  for (const [pattern, replacement] of LOOKALIKES) result = result.replace(pattern, replacement)
  return result
}

/**
 * What a terminal draws one cell wide as a line, and a reader takes for `-`
 * between two letters: every dash (Unicode's `Pd`, less the wave dashes and
 * the double hyphen, which do not look like one), and the horizontal box
 * drawings. Read as a hyphen only to find a name the graph holds (`unread`).
 */
const DASHES = new RegExp(
  [
    '[\\p{Pd}\\u23AF\\u2500\\u2501\\u2504\\u2505\\u2508\\u2509\\u254C\\u254D',
    '\\u2574\\u2576\\u2578\\u257A\\u257C\\u257E]',
    // The character just matched, looked at again: not a wave dash, not `゠`.
    '(?<![\\u301C\\u3030\\u30A0])',
  ].join(''),
  'gu',
)

/**
 * Letters that are a line — the prolonged sound mark (U+30FC, half-width
 * U+FF70), the ideograph for one (U+4E00), the Hangul vowel eu (U+3161,
 * U+1173) — read as a hyphen when neither neighbour is of their own scripts:
 * between two kana `ー` lengthens a vowel (`データ`), between two Latin letters
 * it only draws the hyphen of a name.
 */
const LINES = (() => {
  const own = [
    '[\\p{Script_Extensions=Han}\\p{Script_Extensions=Hiragana}',
    '\\p{Script_Extensions=Katakana}\\p{Script_Extensions=Hangul}]',
  ].join('')
  const line = '[\\u30FC\\uFF70\\u4E00\\u3161\\u1173]'
  return new RegExp(`(?<=${WORD})(?<!${own})${line}(?=${WORD})(?!${own})`, 'gu')
})()

/** A normalised text with every dash and line read as the hyphen it looks like. */
const dashed = (text: string): string => text.replace(DASHES, '-').replace(LINES, '-')
