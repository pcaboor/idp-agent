import { describe, expect, it } from 'vitest'
import { echoes } from '../../src/core/plan/echoes.js'
import { environmentsNamedBy } from '../../src/core/plan/environment.js'

/**
 * The request is written by a person, in their language. Nothing in this tool
 * chooses one: the model decides what it understands, and `echoes` is the
 * deterministic half that has to hold for all of them — it is what decides
 * whether a value was ASKED FOR or merely plausible, and a wrong answer either
 * way is an environment nobody named or a question nobody needed.
 */
describe('echoes, across scripts', () => {
  const asked: Array<[string, string, string]> = [
    ['English', 'give billing-api read access to orders-db in prod', 'prod'],
    ['French', "donne à billing-api l'accès à orders-db en prod", 'prod'],
    ['Spanish', 'da a billing-api acceso a orders-db en prod', 'prod'],
    ['German', 'gib billing-api Zugriff auf orders-db in prod', 'prod'],
    ['Japanese', 'billing-apiにprod環境のorders-dbへのアクセスを付与', 'prod'],
    ['Chinese', '给 billing-api 在 prod 环境访问 orders-db 的权限', 'prod'],
    ['Korean', 'billing-api에 prod의 orders-db 접근 권한 부여', 'prod'],
    ['Russian', 'дай billing-api доступ к orders-db в prod', 'prod'],
    ['Arabic', 'امنح billing-api حق الوصول إلى orders-db في prod', 'prod'],
    ['Hindi', 'billing-api को prod में orders-db तक पहुंच दें', 'prod'],
    ['Greek', 'δώσε πρόσβαση στο prod τώρα', 'prod'],
    ['Hebrew', 'תן גישה ב prod עכשיו', 'prod'],
    ['Thai', 'prodสภาพแวดล้อม', 'prod'],
  ]

  it.each(asked)('reads %s as naming the value', (_language, intent, value) => {
    expect(echoes(intent, value)).toBe(true)
  })

  /**
   * The other half, and the one the ASCII-boundary version got wrong. A word
   * that merely CONTAINS the value has not named it — and a Latin letter
   * outside a-z is still a letter, so `prodüksiyon` is one Turkish word, not
   * `prod` followed by something. Getting this wrong means an environment the
   * request never asked for signs cleanly, which is the escape §4.1 exists to
   * close.
   */
  const notAsked: Array<[string, string, string]> = [
    ['Turkish prodüksiyon', 'prodüksiyon ortamı', 'prod'],
    ['Swedish devåkning', 'devåkning pågår', 'dev'],
    ['Czech devět', 'devět serverů', 'dev'],
    ['Vietnamese prodữ', 'môi trường prodữ', 'prod'],
    ['French développement', 'le développement de billing-api', 'dev'],
    ['English production', 'the production of billing-api', 'prod'],
    ['Spanish desarrollo', 'el desarrollo de billing-api', 'dev'],
    ['Portuguese produção', 'a produção de billing-api', 'prod'],
  ]

  it.each(notAsked)('does not read %s as naming it', (_language, intent, value) => {
    expect(echoes(intent, value)).toBe(false)
  })

  it('is case-insensitive, because a request is prose', () => {
    expect(echoes('Give access in PROD', 'prod')).toBe(true)
  })

  it('treats a digit as part of the word, so prod2 is not prod', () => {
    expect(echoes('access in prod2', 'prod')).toBe(false)
  })

  it('escapes a value that would otherwise be a pattern', () => {
    expect(echoes('the file a.b', 'a.b')).toBe(true)
    expect(echoes('the file axb', 'a.b')).toBe(false)
  })

  it('matches a value at either end of the request', () => {
    expect(echoes('prod', 'prod')).toBe(true)
    expect(echoes('prod first', 'prod')).toBe(true)
    expect(echoes('finally prod', 'prod')).toBe(true)
  })
})

/**
 * core-plan-4. A hyphen served as a word boundary, so "non-prod" named prod —
 * and `environment-mismatch` took it as asked for — while "lion" was found in
 * "lion-ops". A value echoes only when some whole token of the request IS it:
 * letters, marks and digits of any script, joined by `.`, `_` or `-`.
 */
describe('echoes, on whole tokens', () => {
  const inside: Array<[string, string, string]> = [
    ['non-prod', 'deploy it to non-prod', 'prod'],
    ['pre-prod', 'déploie-le en pre-prod', 'prod'],
    ['hors-prod', "donne l'accès hors-prod", 'prod'],
    ['prod-like', 'a prod-like copy', 'prod'],
    ['lion-ops', 'owned by lion-ops', 'lion'],
    ['billing-api-orders-db', 'the billing-api-orders-db grant', 'billing-api'],
    ['prod.eu', 'the prod.eu cluster', 'prod'],
    ['prod_eu', 'the prod_eu cluster', 'prod'],
    ['pre-prod is not preprod', 'déploie-le en pre-prod', 'preprod'],
  ]

  it.each(inside)('does not read %s as naming the value', (_case, intent, value) => {
    expect(echoes(intent, value)).toBe(false)
  })

  const whole: Array<[string, string, string]> = [
    ['pre-prod, whole', 'déploie-le en pre-prod', 'pre-prod'],
    ['preprod, whole', 'déploie-le en preprod', 'preprod'],
    ['lion-ops, whole', 'owned by lion-ops', 'lion-ops'],
    ['a full stop', 'give billing-api access in prod.', 'prod'],
    ['parentheses', 'give billing-api access (prod)', 'prod'],
    ['a comma', 'in prod, owned by tiger', 'prod'],
    ['a semicolon', 'in prod; owned by tiger', 'prod'],
    ['quotes', 'in "prod" only', 'prod'],
    ['guillemets', 'en «prod» seulement', 'prod'],
    ['a trailing hyphen', 'prod- and dev', 'prod'],
    ['a reference', 'owned by group:default/platform-wizards', 'group:default/platform-wizards'],
    ['French', "donne à billing-api l'accès en lecture", 'billing-api'],
    ['Japanese', 'billing-apiにprod環境のorders-dbへのアクセスを付与', 'billing-api'],
    ['Arabic', 'امنح billing-api حق الوصول إلى orders-db في prod', 'billing-api'],
    ['Korean', 'billing-api에 prod환경의 orders-db 접근 권한 부여', 'prod'],
    ['full-width letters', 'ｐｒｏｄ で', 'prod'],
  ]

  it.each(whole)('reads %s as naming the value', (_case, intent, value) => {
    expect(echoes(intent, value)).toBe(true)
  })

  it('does not read a longer reference as naming a shorter one', () => {
    expect(
      echoes('owned by group:default/platform-wizards-2', 'group:default/platform-wizards'),
    ).toBe(false)
  })

  it('reads "en production" as naming no prod — the environment is asked instead', () => {
    expect(echoes('donne à billing-api un accès en production', 'prod')).toBe(false)
  })

  it('names nothing with an empty value', () => {
    expect(echoes('give billing-api access', '')).toBe(false)
    expect(echoes('', '')).toBe(false)
  })
})

/**
 * A hyphen is a hyphen however it was typed. A word processor, a wiki or
 * French typography writes "non‐prod" with U+2010 HYPHEN, or U+2011, the
 * non-breaking one — which NFKC turns into U+2010 and no further. Both are
 * hyphens by Unicode's own definition, not dashes, and the token they join is
 * the one the ASCII hyphen joins.
 */
describe('echoes, across typographic hyphens', () => {
  it.each([
    ['U+2010', 'orders-db non\u2010prod'],
    ['U+2011', 'orders-db non\u2011prod'],
    ['U+2011, pre-prod', 'orders-db pre\u2011prod'],
  ])('reads a word joined by %s as one token', (_hyphen, intent) => {
    expect(echoes(intent, 'prod')).toBe(false)
  })

  it('names a hyphenated value typed with one', () => {
    expect(echoes('orders-db en pre\u2011prod', 'pre-prod')).toBe(true)
    expect(echoes('give billing\u2010api access', 'billing-api')).toBe(true)
  })

  it('reads a name the same way', () => {
    expect(environmentsNamedBy('orders-db-pre\u2011prod', ['prod', 'pre-prod'])).toEqual([
      'pre-prod',
    ])
    expect(environmentsNamedBy('orders-db-non\u2010prod', ['prod'])).toEqual(
      environmentsNamedBy('orders-db-non-prod', ['prod']),
    )
  })
})

/**
 * A character nobody sees is no character of the request. A soft hyphen, a
 * zero-width space, a zero-width joiner or a word joiner inside "nonprod"
 * shows "nonprod" on screen, and read as a boundary it split the word into
 * `non` and `prod` — core-plan-4 again, in text that looks like the case it
 * closes. Taken out before anything else is read, as the commentary does.
 */
describe('echoes, across invisible characters', () => {
  it.each([
    ['a soft hyphen', 'orders-db non­prod'],
    ['a zero-width space', 'orders-db non​prod'],
    ['a zero-width joiner', 'orders-db non‍prod'],
    ['a word joiner', 'orders-db non⁠prod'],
  ])('reads a word split by %s as one token', (_what, intent) => {
    expect(echoes(intent, 'prod')).toBe(false)
  })

  it('names a value an invisible character sits inside', () => {
    expect(echoes('give billing­-api access', 'billing-api')).toBe(true)
    expect(echoes('orders-db in pr​od', 'prod')).toBe(true)
  })

  it('reads a name the same way', () => {
    expect(environmentsNamedBy('orders-db-non­prod', ['prod'])).toEqual([])
  })
})

/**
 * The script break is total. The values compared are identifiers, written in
 * Latin letters and digits, so a letter of ANY other script next to one ends
 * the token — not only a letter of a script someone thought to list. A
 * request in Tifinagh, Cherokee, Yi or Adlam, with no space after the value,
 * names it as a Japanese one does.
 */
describe('echoes, next to a letter of any script', () => {
  it.each([
    ['Tifinagh', 'prod\u2D53\u2D59'],
    ['Cherokee', 'prod\u13E3\u13B3\u13A9'],
    ['Yi', 'prod\uA188\uA320'],
    ['Adlam', 'prod\u{1E900}\u{1E901}'],
    ['Javanese', 'prod\uA98F\uA9B8'],
    ['Tai Tham', 'prod\u1A20\u1A61'],
    ['Japanese', 'prod環境'],
  ])('reads prod followed by %s as naming prod', (_script, intent) => {
    expect(echoes(intent, 'prod')).toBe(true)
  })

  it('and before one', () => {
    expect(echoes('\u2D53\u2D59prod', 'prod')).toBe(true)
    expect(echoes('\u{1E900}billing-api', 'billing-api')).toBe(true)
  })

  it('reads a digit ending an identifier the same way', () => {
    expect(echoes('orders-db2環境', 'orders-db2')).toBe(true)
  })

  it('still reads a Latin letter of any accent as continuing the word', () => {
    expect(echoes('prodüksiyon', 'prod')).toBe(false)
    expect(echoes('prodŋ ortamı', 'prod')).toBe(false)
  })
})

describe('echoes, next to a combining mark', () => {
  it('reads a mark NFKC cannot compose as part of the letter it sits on', () => {
    // q with a combining acute has no precomposed form.
    expect(echoes('in prodq́', 'prodq')).toBe(false)
    expect(echoes('in proḏ', 'prod')).toBe(false)
  })
})
