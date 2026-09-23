import { describe, expect, it } from 'vitest'
import { echoes } from '../../src/core/plan/echoes.js'

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
