/**
 * The script a letter belongs to, and whether a word mixes two: moved here
 * from `core/answer/commentary.ts`, unchanged in behaviour, so the engine's
 * check on a model's sentences and stage 8's grammars for a database or an
 * account refuse one look-alike by one rule — `lеdger`, with a Cyrillic `е`,
 * is no name the graph holds and no database a finding keeps.
 */

/** Any letter, of any script. */
const LETTER = /\p{L}/u

/**
 * Letters of two scripts in one word, where no script written without spaces
 * explains it. No word of any language is spelled so; a lookalike is — `lеdger`
 * with a Cyrillic `е` prints as `ledger` and is no name the graph holds.
 */
export function mixesScripts(token: string): boolean {
  let first: string | undefined
  for (const char of token) {
    const script = scriptOf(char)
    if (script === undefined) continue
    if (first === undefined) first = script
    else if (script !== first) return true
  }
  return false
}

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

export function scriptOf(char: string): string | undefined {
  if (!LETTER.test(char)) return undefined
  for (const [name, pattern] of SCRIPTS) if (pattern.test(char)) return name
  return SHARED.test(char) ? undefined : 'other'
}
