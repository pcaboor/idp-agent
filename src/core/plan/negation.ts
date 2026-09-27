import { fold, proseWords } from './echoes.js'

/**
 * Does the request hold a negation — anywhere, about anything?
 *
 * **A veto on pointing, and nothing more.** An environment is never read out
 * of a request's words (`requestedEnvironment`): it is the declaration the
 * person points at by its reference in full, or their answer. What this
 * guards is the pointing: "donne à component:default/billing-api un accès en
 * lecture, pas à resource:default/orders-db-prod" names the prod database by
 * its reference — to exclude it — and read as a pointing it would hand out
 * prod. So a request holding any marker below points at nothing, and the
 * environment is asked.
 *
 * **It fails closed, and does not read what the negation is about.** Telling
 * "not orders-db-prod" from "no rush, orders-db-prod" is understanding the
 * sentence, which is the model's half and never this one's. What that costs,
 * stated: "…à resource:default/orders-db-prod, no rush" is asked too.
 *
 * **It is a list, and a list is never complete.** A request comes in any
 * language the model supports, and this covers the ones named below — no
 * privileged one among them, and every other one missing. That is why it is a
 * veto and no longer the rule it once was: when an environment WORD counted
 * unless a negation withdrew it, a verifier found the phrasings the list did
 * not hold — "prodではなく", "dont use prod", "nao em prod", Swedish "inte" —
 * and each ended on a production diff. With words stating nothing, a
 * negation the list misses costs this: a request naming a reference in full
 * and negating it in a form not listed still points, at the declaration it
 * named, whose environment the diff shows the person before the merge — unless
 * it says another environment too ("…in place of
 * resource:default/orders-db-prod, in dev"), a word that cancels the pointing
 * on its own (`requestedEnvironment`). Stated as a debt (docs/roadmap.md), not
 * a guarantee. A second verifier's exclusions — "avoiding", "in place of",
 * "hormis", "の代わりに", "대신" — are rows now; the next ones are not.
 *
 * **A marker is a whole word** of the request as prose splits it
 * (`proseWords`): a hyphen, a dash and a change of script end a word, so
 * "non-prod", "non–prod" and `非prod` each hold one, while "notify", "nonce"
 * and "another" hold none. A marker of several words is those words in a row.
 * A marker written in a script that puts no space between words — Han, kana,
 * Hangul, Thai — is found wherever it stands, since there a word has no
 * boundary to test: `prod以外` and `prod가 아닌` hold one. English's
 * contraction, `n't`, is found where it ends a word, and a marker written with
 * a slash, `w/o`, where no letter or digit touches it. The accents of Latin
 * letters are not read, on either side: "nao", "plutot que" and "degil" are
 * the markers typed without them, which a terminal often does.
 */
export function negates(intent: string): boolean {
  const text = bare(fold(intent).replace(APOSTROPHES, "'"))
  const words = proseWords(intent).map(bare)
  return MARKERS.some((marker) => {
    switch (marker.form) {
      case 'spaceless':
        return text.includes(marker.text)
      case 'contraction':
        return contracted(text, marker.text)
      case 'symbol':
        return standing(text, marker.text)
      case 'words':
        return inARow(words, marker.words)
    }
  })
}

/**
 * The markers, by language, in their folded form (`fold`): NFKC, lower case.
 * Data, in one place; adding a language is adding a row, and the tests hold
 * every row to its folded form.
 *
 * A word two languages share is listed in each: the lists say what each
 * language is covered by, not what is unique to it.
 */
export const NEGATIONS = {
  english: [
    'not', 'no', 'non', 'none', 'nor', 'neither', 'never', 'without', 'w/o', 'except',
    'excluding', 'exclude', 'excluded', 'excludes', 'besides', 'outside', 'cannot', "n't",
    'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'cant', 'wont', 'shouldnt',
    'wouldnt', 'couldnt', 'mustnt', 'havent', 'hasnt', 'anything but', 'anywhere but',
    'everywhere but', 'all but', 'apart from', 'other than', 'rather than', 'instead of',
    'in place of', 'unless', 'excl', 'avoid', 'avoids', 'avoiding', 'skip', 'skipping',
    'scratch that', 'nope', 'off limits',
  ],
  french: [
    'non', 'hors', 'pas', 'sans', 'sauf', 'excepté', 'jamais', 'ni', 'aucun', 'aucune',
    'à part', 'au lieu de', 'plutôt que', 'autre que', 'hormis', 'à la place de', 'exception',
    'en dehors de', 'évite', 'évitez', 'éviter',
  ],
  spanish: [
    'no', 'sin', 'excepto', 'salvo', 'nunca', 'ni', 'ningún', 'ninguno', 'ninguna', 'menos',
    'en vez de', 'en lugar de', 'fuera de',
  ],
  portuguese: [
    'não', 'sem', 'exceto', 'salvo', 'nunca', 'nem', 'nenhum', 'nenhuma', 'menos', 'em vez de',
    'ao invés de', 'em lugar de',
  ],
  italian: [
    'non', 'senza', 'tranne', 'eccetto', 'salvo', 'fuorché', 'nessun', 'nessuno', 'nessuna',
    'anziché', 'invece di', 'al posto di',
  ],
  german: [
    'nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'ohne', 'außer', 'ausser', 'nie',
    'niemals', 'statt', 'anstatt', 'anstelle',
  ],
  dutch: ['niet', 'geen', 'zonder', 'behalve', 'nooit', 'in plaats van'],
  swedish: ['inte', 'ej', 'utan', 'förutom', 'aldrig'],
  norwegian: ['ikke', 'uten', 'unntatt', 'aldri'],
  danish: ['ikke', 'uden', 'undtagen', 'aldrig'],
  finnish: ['ei', 'ilman', 'paitsi'],
  czech: ['ne', 'bez', 'kromě', 'nikdy'],
  russian: ['не', 'нет', 'без', 'кроме', 'никогда', 'вместо'],
  polish: ['nie', 'bez', 'oprócz', 'poza', 'nigdy'],
  greek: ['όχι', 'δεν', 'μη', 'χωρίς', 'εκτός'],
  turkish: ['değil', 'hariç', 'olmadan', 'yok'],
  indonesian: ['bukan', 'tidak', 'tanpa', 'kecuali'],
  vietnamese: ['không', 'trừ'],
  hindi: ['नहीं', 'बिना', 'अलावा'],
  arabic: ['ليس', 'غير', 'بدون', 'لا', 'عدا'],
  hebrew: ['לא', 'בלי', 'חוץ'],
  thai: ['ไม่', 'ยกเว้น'],
  chinese: ['非', '不', '没', '沒', '无', '無', '别', '別', '除', '以外', '代替', '而非'],
  japanese: [
    'ない', 'なく', 'なし', '無し', '以外', '除く', '除いて', '除外', '非', '不', '代わり', '避け',
  ],
  korean: ['아닌', '아니', '말고', '없이', '빼고', '제외', '대신'],
} as const satisfies Readonly<Record<string, readonly string[]>>

type Marker =
  | { readonly form: 'spaceless'; readonly text: string }
  | { readonly form: 'contraction'; readonly text: string }
  | { readonly form: 'symbol'; readonly text: string }
  | { readonly form: 'words'; readonly words: readonly string[] }

/** The scripts that write words with no space between them. */
const SPACELESS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

/**
 * The apostrophes a request types: the typographic ones, the modifier letters,
 * the grave and acute accents and the prime a keyboard puts in their place.
 */
const APOSTROPHES = /[‘’ʼʻ`´′]/gu

/**
 * A Latin letter without its accents: `não` is `nao`, `değil` is `degil`.
 * Only a Latin one, because a mark elsewhere is part of the letter — Hindi
 * writes its vowels as marks, and `नहीं` stripped of them would be another
 * word. Composed back afterwards, so Hangul and kana keep their form.
 */
const bare = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')

const MARKERS: readonly Marker[] = [
  ...new Set((Object.values(NEGATIONS).flat() as readonly string[]).map(bare)),
].map((marker): Marker => {
  if (SPACELESS.test(marker)) return { form: 'spaceless', text: marker }
  if (marker.includes("'")) return { form: 'contraction', text: marker }
  if (marker.includes('/')) return { form: 'symbol', text: marker }
  return { form: 'words', words: marker.split(' ') }
})

const LETTER = /^\p{L}$/u
const WORD = /^[\p{L}\p{M}\p{N}]$/u

/** `n't` ending a word: a letter before it, and no letter, mark or digit after. */
function contracted(text: string, marker: string): boolean {
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const before = text[at - 1]
    const after = text[at + marker.length]
    if (before !== undefined && LETTER.test(before) && (after === undefined || !WORD.test(after))) {
      return true
    }
  }
  return false
}

/** A marker such as `w/o`, with no letter, mark or digit touching either end. */
function standing(text: string, marker: string): boolean {
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const before = text[at - 1]
    const after = text[at + marker.length]
    if ((before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after))) {
      return true
    }
  }
  return false
}

function inARow(words: readonly string[], wanted: readonly string[]): boolean {
  for (let start = 0; start + wanted.length <= words.length; start += 1) {
    if (wanted.every((word, offset) => words[start + offset] === word)) return true
  }
  return false
}
