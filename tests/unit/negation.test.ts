import { describe, expect, it } from 'vitest'
import { questionsOf } from '../../src/core/plan/clarify.js'
import { namesakesOf } from '../../src/core/plan/environment.js'
import { NEGATIONS, negates } from '../../src/core/plan/negation.js'
import { checkPolicies, type PolicyContext } from '../../src/core/plan/policies.js'
import { signPlan, type SignedPlan } from '../../src/core/plan/sign.js'
import { findUnknowns, planSchema, type Plan } from '../../src/core/schemas/plan.js'
import type { Nature } from '../../src/core/schemas/resource-types.js'
import { saidWithLevels, userSaid } from '../support/provenance.js'

/**
 * A negation, as the veto on pointing it now is.
 *
 * "not prod", "hors prod", "pas en prod" and "non–prod" with an en dash leave
 * `prod` a whole word of the request, so a word test read each as a request
 * FOR production. A lexicon of negations then withdrew the word, and a
 * verifier found the forms it did not hold — "prodではなく", "dont use prod",
 * "nao em prod" — each ending on a production diff. No list is complete, so
 * the owner decided (2026-09-27) that an environment word states nothing, in
 * any language, negated or not: the environment is the declaration the
 * request points at by its reference in full, or an answer.
 *
 * The lexicon stays as a VETO on that pointing: "…pas à
 * resource:default/orders-db-prod" names the prod database by its reference
 * to exclude it, and a request holding any marker, anywhere, points at
 * nothing (`negates`, read by `requestedEnvironment`). It fails closed — an
 * unrelated "no" withdraws the pointing too — and it is a veto, never a
 * guarantee: a negation it does not hold, beside a reference in full, still
 * points, at the declaration the diff then shows.
 */

const PROD_GRANT = 'resource:default/orders-api-orders-db-prod'
const DEV_GRANT = 'resource:default/orders-api-orders-db-dev'
const BILLING = 'component:default/billing-api'
const ENVIRONMENT = 'operations.0.environment'
const OWNER =
  'donne à component:default/billing-api un accès en lecture à resource:default/orders-db-prod'

/** Each language's "not prod", spaced and with an en dash where one reads naturally. */
const NEGATED: readonly (readonly [string, string])[] = [
  ['English, spaced', 'give billing-api read access to orders-db, not prod'],
  ['English, non', 'give billing-api read access to orders-db in non prod'],
  ['English, en dash', 'give billing-api read access to orders-db in non–prod'],
  ['English, em dash', 'give billing-api read access to orders-db in non—prod'],
  ['English, minus', 'give billing-api read access to orders-db in non−prod'],
  ['English, without', 'give billing-api read access to orders-db without prod'],
  ['English, contraction', 'give billing-api read access to orders-db, but don’t use prod'],
  ['French, hors', 'donne à billing-api un accès en lecture à orders-db hors prod'],
  ['French, pas', 'donne à billing-api un accès en lecture à orders-db, pas en prod'],
  ['French, non', 'donne à billing-api un accès en lecture à orders-db en non prod'],
  ['French, en dash', 'donne à billing-api un accès en lecture à orders-db en non–prod'],
  ['French, sauf', 'donne à billing-api un accès en lecture à orders-db sauf prod'],
  ['Spanish', 'da a billing-api acceso de lectura a orders-db, no en prod'],
  ['Spanish, sin', 'da a billing-api acceso de lectura a orders-db sin prod'],
  ['Portuguese', 'dá ao billing-api acesso de leitura ao orders-db, não em prod'],
  ['Portuguese, exceto', 'dá ao billing-api acesso de leitura ao orders-db exceto prod'],
  ['Italian', 'dai a billing-api accesso in lettura a orders-db, non in prod'],
  ['Italian, tranne', 'dai a billing-api accesso in lettura a orders-db tranne prod'],
  ['German', 'gib billing-api Lesezugriff auf orders-db, nicht in prod'],
  ['German, außer', 'gib billing-api Lesezugriff auf orders-db außer prod'],
  ['German, kein', 'gib billing-api Lesezugriff auf orders-db, kein prod'],
  ['Dutch', 'geef billing-api leestoegang tot orders-db, niet in prod'],
  ['Dutch, zonder', 'geef billing-api leestoegang tot orders-db zonder prod'],
  ['Russian', 'дай billing-api доступ на чтение к orders-db, не в prod'],
  ['Polish', 'daj billing-api dostęp do odczytu orders-db, nie w prod'],
  ['Turkish', 'billing-api için orders-db okuma erişimi ver, prod değil'],
  ['Chinese, 非', '给billing-api授予orders-db的读取权限，非prod环境'],
  ['Chinese, 不', '给billing-api授予orders-db的读取权限，不要prod'],
  ['Chinese, 除了', '除了prod以外，给billing-api授予orders-db的读取权限'],
  ['Japanese', 'billing-apiにorders-dbへの読み取りアクセスを付与、prod以外で'],
  ['Japanese, ない', 'billing-apiにorders-dbへの読み取りアクセスを付与、prodではない'],
  ['Korean', 'billing-api에 orders-db 읽기 권한을 부여, prod가 아닌 환경'],
  ['Korean, 제외', 'billing-api에 orders-db 읽기 권한을 부여, prod 제외'],
  // The verifier's: forms the first lexicon did not hold.
  ['English, no apostrophe', 'give billing-api read access to orders-db, dont use prod'],
  ['English, isnt', 'give billing-api read access to orders-db, it isnt prod'],
  ['English, cant', 'give billing-api read access to orders-db, we cant touch prod'],
  ['English, anywhere but', 'give billing-api read access to orders-db anywhere but prod'],
  ['English, apart from', 'give billing-api read access to orders-db apart from prod'],
  ['English, besides', 'give billing-api read access to orders-db besides prod'],
  ['English, exclude', 'give billing-api read access to orders-db, exclude prod'],
  ['English, w/o', 'give billing-api read access to orders-db w/o prod'],
  ['French, no accent', 'donne à billing-api un accès en lecture à orders-db en dev plutot que prod'],
  ['Portuguese, no accent', 'da ao billing-api acesso de leitura ao orders-db, nao em prod'],
  ['Turkish, no accent', 'billing-api için orders-db okuma erişimi ver, prod degil'],
  ['Swedish', 'ge billing-api läsåtkomst till orders-db, inte i prod'],
  ['Japanese, ではなく', 'billing-apiにorders-dbへの読み取りアクセスを付与、prodではなくdev'],
  ['Japanese, じゃなくて', 'billing-apiにorders-dbへの読み取りアクセスを付与、prodじゃなくて'],
]

/**
 * The second verifier's: forms a request excludes a reference with, and no
 * environment word beside it — so no word vetoes the pointing, only these.
 * One row per marker added.
 */
const REF = 'resource:default/orders-db-prod'
const EXCLUDED: readonly (readonly [string, string])[] = [
  ['English, unless', `give component:default/billing-api read access, unless it is ${REF}`],
  ['English, excl.', `give component:default/billing-api read access to all, excl. ${REF}`],
  ['English, avoid', `give component:default/billing-api read access, avoid ${REF}`],
  ['English, avoiding', `give component:default/billing-api read access to orders, avoiding ${REF}`],
  ['English, skip', `give component:default/billing-api read access, skip ${REF}`],
  ['English, in place of', `give component:default/billing-api read access to the replica in place of ${REF}`],
  ['English, scratch that', `give component:default/billing-api read access to ${REF} — actually scratch that`],
  ['English, nope', `give component:default/billing-api read access to ${REF}, nope`],
  ['English, off limits', `give component:default/billing-api read access, ${REF} is off limits`],
  ['English, off-limits', `give component:default/billing-api read access, ${REF} is off-limits`],
  ['French, hormis', `donne à component:default/billing-api un accès en lecture à tout, hormis ${REF}`],
  ['French, à la place de', `donne à component:default/billing-api un accès en lecture à la réplique à la place de ${REF}`],
  ['French, à l’exception de', `donne à component:default/billing-api un accès en lecture à tout, à l’exception de ${REF}`],
  ['French, en dehors de', `donne à component:default/billing-api un accès en lecture en dehors de ${REF}`],
  ['French, évite', `donne à component:default/billing-api un accès en lecture, évite ${REF}`],
  ['French, éviter', `donne à component:default/billing-api un accès en lecture, à éviter : ${REF}`],
  ['French, no accent', `donne à component:default/billing-api un accès en lecture, evite ${REF}`],
  ['Portuguese, ao invés de', `dá ao component:default/billing-api acesso de leitura à réplica ao invés de ${REF}`],
  ['Portuguese, em lugar de', `dá ao component:default/billing-api acesso de leitura à réplica em lugar de ${REF}`],
  ['Spanish, fuera de', `da a component:default/billing-api acceso de lectura a todo fuera de ${REF}`],
  ['Italian, al posto di', `dai a component:default/billing-api accesso in lettura alla replica al posto di ${REF}`],
  ['German, anstelle', `gib component:default/billing-api Lesezugriff auf die Replik anstelle von ${REF}`],
  ['German, anstatt', `gib component:default/billing-api Lesezugriff auf die Replik anstatt ${REF}`],
  ['Russian, вместо', `дай component:default/billing-api доступ на чтение к реплике вместо ${REF}`],
  ['Japanese, 代わり', `component:default/billing-apiに${REF}の代わりに読み取りアクセスを付与`],
  ['Japanese, 避け', `component:default/billing-apiに読み取りアクセスを付与、${REF}は避けて`],
  ['Korean, 대신', `component:default/billing-api에 ${REF} 대신 읽기 권한을 부여`],
  ['Chinese, 代替', `给component:default/billing-api授予读取权限，用副本代替${REF}`],
  ['Chinese, 而非', `给component:default/billing-api授予副本而非${REF}的读取权限`],
]

/**
 * Requests naming prod with no negation in them, in several languages. They
 * state no environment either (`requestedEnvironment`): a word never does.
 */
const STATED: readonly (readonly [string, string])[] = [
  ['English', 'give billing-api read access to orders-db in prod'],
  ['French', 'donne à billing-api un accès en lecture à orders-db en prod'],
  ['German', 'gib billing-api Lesezugriff auf orders-db in prod'],
  ['Japanese', 'billing-apiにprod環境のorders-dbへの読み取りアクセスを付与'],
  ['Chinese', '给billing-api授予prod环境中orders-db的读取权限'],
  ['Korean', 'billing-api에 prod 환경의 orders-db 읽기 권한을 부여'],
]

describe('negates', () => {
  it.each(NEGATED)('reads a negation in %s', (_how, intent) => {
    expect(negates(intent)).toBe(true)
  })

  it.each(EXCLUDED)('reads an exclusion in %s', (_how, intent) => {
    expect(negates(intent)).toBe(true)
  })

  it.each(STATED)('reads none in %s', (_how, intent) => {
    expect(negates(intent)).toBe(false)
  })

  it('reads none in the owner’s phrase', () => {
    expect(negates(OWNER)).toBe(false)
  })

  it.each([
    'notify billing-api in prod',
    'another billing-api in prod',
    'the knot service in prod',
    'a nonce store in prod',
    'donne un accès à la base sansonnet en prod',
    'give read access to orders-db-nonprod',
    'gib billing-api Nichtraucher-Zugriff in prod',
  ])('reads a marker only as a whole word, not inside one: "%s"', (intent) => {
    expect(negates(intent)).toBe(false)
  })

  it.each([
    ['inside a hyphenated word', 'give billing-api read access to orders-db in non-prod'],
    ['across a change of script', '给billing-api授予非prod的读取权限'],
    ['in capitals', 'give billing-api read access to orders-db, NOT prod'],
    ['full-width', 'give billing-api read access to orders-db, ＮＯＴ prod'],
    ['split by a soft hyphen', 'give billing-api read access to orders-db, n­ot prod'],
    ['as two words', 'give billing-api read access to anything but prod'],
  ])('reads a marker %s', (_how, intent) => {
    expect(negates(intent)).toBe(true)
  })

  it('keeps every marker in its folded form, and every language non-empty', () => {
    for (const [language, markers] of Object.entries(NEGATIONS)) {
      expect(markers.length, language).toBeGreaterThan(0)
      for (const marker of markers) expect(marker, language).toBe(marker.normalize('NFKC').toLowerCase())
    }
  })
})

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access'],
  environments: ['dev', 'prod'],
  owners: ['group:default/tiger'],
}

const access = (env: string) => ({
  kind: 'Resource' as const,
  metadata: { name: `billing-api-orders-db-${env}`, env },
  spec: {
    type: 'database-access' as const,
    access: 'read',
    owner: 'group:default/tiger',
    dependsOn: [`resource:default/orders-db-${env}`],
    dependencyOf: [BILLING],
  },
})

const creating = (intent: string, env = 'prod'): Plan =>
  planSchema.parse({ intent, operations: [{ op: 'create-entity', entity: access(env) }] })

const signed = (plan: Plan): SignedPlan => {
  const result = signPlan(
    plan,
    {
      witnessed: new Set([
        'resource:default/orders-db-prod',
        'resource:default/orders-db-dev',
        BILLING,
      ]),
      vocabulary,
      repoRoot: '/repo',
      declared: new Map(),
      // What the repository declares, so a request naming a database by its
      // reference in full points at it (`requestedEnvironment`).
      environments: new Map([
        ['resource:default/orders-db-prod', 'prod'],
        ['resource:default/orders-db-dev', 'dev'],
      ]),
      namesakes: namesakesOf([
        { name: 'orders-db-prod', env: 'prod' },
        { name: 'orders-db-dev', env: 'dev' },
        { name: 'billing-api' },
      ]),
    },
    saidWithLevels(plan),
  )
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

const envClass = (plan: Plan): string | undefined =>
  signed(plan).classified.find((leaf) => leaf.path.endsWith('.metadata.env'))?.class

describe('a creation declaring the environment a request negates', () => {
  it.each(NEGATED)('asks it, in %s', (_how, intent) => {
    const result = signed(creating(intent))

    expect(result.classified.find((leaf) => leaf.path.endsWith('.metadata.env'))?.class).toBe(
      'novel',
    )
    expect(findUnknowns(result.plan)).toContain('operations.0.entity.metadata.env')
  })

  it.each(NEGATED)('never takes the other environment for it, in %s', (_how, intent) => {
    // "not prod" is not "dev": the environment is asked, whichever was drafted.
    expect(envClass(creating(intent, 'dev'))).toBe('novel')
  })

  it.each(STATED)('asks it without a negation too — a word states none, in %s', (_how, intent) => {
    expect(envClass(creating(intent))).toBe('novel')
  })

  it('signs the one answered for it, negation or not', () => {
    const plan = creating('give billing-api read access to orders-db, not prod', 'dev')
    const result = signPlan(
      plan,
      {
        witnessed: new Set(['resource:default/orders-db-dev', BILLING]),
        vocabulary,
        repoRoot: '/repo',
        declared: new Map(),
      },
      userSaid(plan.intent, {
        'operations.0.entity.spec.access': 'read',
        'operations.0.entity.metadata.env': 'dev',
      }),
    )
    if ('outcome' in result) throw new Error('refused')

    expect(result.classified.find((leaf) => leaf.path.endsWith('.metadata.env'))?.class).toBe(
      'echoed',
    )
  })

  it('derives it from the reference the owner’s phrase points at, which negates nothing', () => {
    expect(envClass(creating(OWNER))).toBe('derived')
  })

  it('asks a pointing request with an unrelated "no" — the cost of failing closed', () => {
    expect(envClass(creating(`no rush, ${OWNER}`))).toBe('novel')
  })

  it.each(EXCLUDED)('asks a creation over a reference excluded, in %s', (_how, intent) => {
    expect(envClass(creating(intent))).toBe('novel')
  })

  it('asks a request negating the very reference it names', () => {
    const intent =
      'donne à component:default/billing-api un accès en lecture, pas à resource:default/orders-db-prod'
    expect(envClass(creating(intent))).toBe('novel')
  })

  it('still asks "non-prod", which names no prod (#79)', () => {
    expect(envClass(creating('give billing-api read access to orders-db in non-prod'))).toBe(
      'novel',
    )
  })
})

describe('environment-mismatch, against a request that negates', () => {
  const policies: PolicyContext = {
    vocabulary,
    witnesses: new Set(['dependencies/access']),
    environments: new Map([
      ['resource:default/orders-db-prod', 'prod'],
      ['resource:default/orders-db-dev', 'dev'],
      [BILLING, 'dev'],
    ]),
    levels: new Map(),
    natures: new Map(),
    over: new Map(),
    namesakes: namesakesOf([
      { name: 'orders-db-prod', env: 'prod' },
      { name: 'orders-db-dev', env: 'dev' },
      { name: 'billing-api', env: 'dev' },
    ]),
  }

  it('does not read "not prod" as a request for prod, and refuse dev against it', () => {
    const plan = creating('give billing-api read access to orders-db, not prod', 'dev')
    const violations = checkPolicies(signed(plan), policies, userSaid(plan.intent))

    expect(violations.filter((violation) => violation.policy === 'environment-mismatch')).toEqual(
      [],
    )
  })

  it('does not read "in prod" as a request for prod either: it asks, it does not refuse', () => {
    // A word states nothing, so there is nothing to refuse dev against: the
    // environment is a question, and the policies stay silent while it is one.
    const plan = creating('give billing-api read access to orders-db in prod', 'dev')
    const result = signed(plan)
    const violations = checkPolicies(result, policies, userSaid(plan.intent))

    expect(findUnknowns(result.plan)).toContain('operations.0.entity.metadata.env')
    expect(violations.filter((violation) => violation.policy === 'environment-mismatch')).toEqual(
      [],
    )
  })
})

describe('an update joining a grant, against a request that negates', () => {
  const DECLARED = new Map([
    [PROD_GRANT, 'prod'],
    [DEV_GRANT, 'dev'],
    ['resource:default/orders-db-prod', 'prod'],
    ['resource:default/orders-db-dev', 'dev'],
  ])
  const NATURES = new Map<string, Nature>([
    [PROD_GRANT, 'right'],
    [DEV_GRANT, 'right'],
    ['resource:default/orders-db-prod', 'object'],
    ['resource:default/orders-db-dev', 'object'],
    [BILLING, 'object'],
  ])
  const OVER = new Map([
    [PROD_GRANT, ['resource:default/orders-db-prod']],
    [DEV_GRANT, ['resource:default/orders-db-dev']],
  ])
  const NAMESAKES = namesakesOf(
    [...NATURES.keys()].map((ref) => ({
      name: ref.slice(ref.indexOf('/') + 1),
      env: DECLARED.get(ref),
    })),
  )
  const asks = (intent: string, grant = PROD_GRANT): string[] =>
    questionsOf(
      planSchema.parse({
        intent,
        operations: [
          {
            op: 'update-entity',
            entityRef: grant,
            patch: { patch: 'add-dependency-of', consumer: BILLING, access: 'read' },
          },
        ],
      }),
      {
        environments: ['dev', 'prod'],
        declared: DECLARED,
        natures: NATURES,
        namesakes: NAMESAKES,
        over: OVER,
        provenance: userSaid(intent),
      },
    ).map((question) => question.path)

  it.each(NEGATED)('asks the environment of the prod grant, in %s', (_how, intent) => {
    expect(asks(intent)).toEqual([ENVIRONMENT])
  })

  it.each(NEGATED)('asks the environment of the dev grant too, in %s', (_how, intent) => {
    // Never the other environment: "not prod" does not state dev.
    expect(asks(intent, DEV_GRANT)).toEqual([ENVIRONMENT])
  })

  it.each(STATED)('asks when the request names the grant’s in words, in %s', (_how, intent) => {
    expect(asks(intent)).toEqual([ENVIRONMENT])
  })

  it('asks a request with an unrelated "no" beside the reference — the cost of failing closed', () => {
    expect(asks(`no rush, ${OWNER}`)).toEqual([ENVIRONMENT])
  })

  it('still asks "non-prod" (#79)', () => {
    expect(asks('give billing-api read access to orders-db in non-prod')).toEqual([ENVIRONMENT])
  })

  it('still points through the owner’s phrase, which negates nothing', () => {
    expect(asks(OWNER)).toEqual([])
  })

  it.each(EXCLUDED)('does not point through a reference excluded, in %s', (_how, intent) => {
    expect(asks(intent)).toEqual([ENVIRONMENT])
  })

  it.each([
    ['a negation beside the reference', `${OWNER}, pas en dev`],
    ['a negation elsewhere', `${OWNER}, sans urgence`],
    ['a negation in another language', `${OWNER}, not urgent`],
    ['the reference negated', 'donne à component:default/billing-api un accès en lecture, pas à resource:default/orders-db-prod'],
    ['a negation without its apostrophe', `${OWNER}, dont wait`],
    ['a negation without its accents', `${OWNER}, nao urgente`],
    ['a negation in Japanese', `${OWNER}、急ぎではなく`],
  ])('does not point when the request holds %s', (_how, intent) => {
    // Fail closed: what the negation is about is not read, so the pointing is
    // withdrawn whatever it is about.
    expect(asks(intent)).toEqual([ENVIRONMENT])
  })
})
