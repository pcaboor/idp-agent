import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runPlan, type Ask } from '../../src/cli/commands/plan.js'
import { questionsOf, type Question } from '../../src/core/plan/clarify.js'
import { namesakesOf, type Namesakes } from '../../src/core/plan/environment.js'
import { checkPolicies, type PolicyContext } from '../../src/core/plan/policies.js'
import { recordAnswers, reapplyAnswers } from '../../src/core/plan/reapply.js'
import { signPlan, type SignatureContext, type SignedPlan } from '../../src/core/plan/sign.js'
import type { Provenance } from '../../src/core/plan/provenance.js'
import { findUnknowns, planSchema, type Plan } from '../../src/core/schemas/plan.js'
import type { Nature } from '../../src/core/schemas/resource-types.js'
import { hashTree } from '../support/tree.js'
import { userSaid } from '../support/provenance.js'

/**
 * The owner's decision of 2026-09-27: an environment is NEVER taken from the
 * words of a request — exactly as an access level is not (`sign.ts`). A word
 * test cannot read a negation, and no list of negations is ever complete:
 * "prodではなく", "dont use prod" and "nao em prod" each named prod, and each
 * ended on a production diff.
 *
 * So the environment comes from one of two places. The declaration of the
 * thing the person designates by its reference in full — every thing the
 * grant is over, `kind:namespace/name` or `kind:name` in the default
 * namespace, each declaring the one environment, nothing the request mentions
 * declared in another, and no negation anywhere (the pointing rule of #79,
 * now for a right the draft creates as much as for one it extends). Or the
 * person's answer. Otherwise it is asked, the environments in use listed.
 */

const PROD_DB = 'resource:default/orders-db-prod'
const DEV_DB = 'resource:default/orders-db-dev'
const PROD_GRANT = 'resource:default/orders-api-orders-db-prod'
const DEV_GRANT = 'resource:default/orders-api-orders-db-dev'
const BILLING = 'component:default/billing-api'
const ENVIRONMENT = 'operations.0.environment'
const CREATED_ENV = 'operations.0.entity.metadata.env'
const LEVEL = 'operations.0.entity.spec.access'

/** The owner's phrase: every thing named by its reference in full, no environment word. */
const OWNER =
  'donne à component:default/billing-api un accès en lecture à resource:default/orders-db-prod'

/** Requests naming prod as a word, in several languages. None of them states it. */
const WORDS: readonly (readonly [string, string])[] = [
  ['English', 'give billing-api read access to orders-db in prod'],
  ['French', 'donne à billing-api un accès en lecture à orders-db en prod'],
  ['German', 'gib billing-api Lesezugriff auf orders-db in prod'],
  ['Japanese', 'billing-apiにprod環境のorders-dbへの読み取りアクセスを付与'],
  ['Korean', 'billing-api에 prod 환경의 orders-db 읽기 권한을 부여'],
]

/** Requests negating prod, including the forms no lexicon held (the verifier's). */
const NEGATED: readonly (readonly [string, string])[] = [
  ['English', 'give billing-api read access to orders-db, not prod'],
  ['English, no apostrophe', 'give billing-api read access to orders-db, dont use prod'],
  ['English, anywhere but', 'give billing-api read access to orders-db anywhere but prod'],
  ['French', 'donne à billing-api un accès en lecture à orders-db, pas en prod'],
  ['Portuguese, no accent', 'da ao billing-api acesso ao orders-db, nao em prod'],
  ['Japanese, ではなく', 'billing-apiにorders-dbへの読み取りアクセスを付与、prodではなくdev'],
  ['Swedish', 'ge billing-api läsåtkomst till orders-db, inte i prod'],
]

/**
 * A reference in full to the prod database, beside a word saying another
 * environment — the verifier's, each once ending on the prod diff. No word
 * states an environment; one saying another than the declaration pointed at
 * cancels the pointing, as a negation does.
 */
const FULL = 'give component:default/billing-api read access to resource:default/orders-db-prod'
const CONTRADICTED: readonly (readonly [string, string])[] = [
  ['in dev', `${FULL} in dev`],
  ['but in dev', `${FULL}, but in dev`],
  ['for dev', `${FULL} for dev`],
  ['(dev)', `${FULL} (dev)`],
  ['the dev copy', 'give component:default/billing-api read access to the dev copy of resource:default/orders-db-prod'],
  ['scratch that, the dev one', `${FULL} — scratch that, the dev one`],
  ['nope, dev', `${FULL}, nope, dev`],
  ['dev-side', `${FULL}, dev-side`],
  ['in Japanese', 'component:default/billing-apiにresource:default/orders-db-prodへの読み取りアクセスを付与、dev環境で'],
]

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access'],
  environments: ['dev', 'prod'],
  owners: ['group:default/tiger'],
}

/** What the repository declares, as `contextsOf` reads it. */
const DECLARED = new Map([
  [PROD_GRANT, 'prod'],
  [DEV_GRANT, 'dev'],
  [PROD_DB, 'prod'],
  [DEV_DB, 'dev'],
])
const NATURES = new Map<string, Nature>([
  [PROD_GRANT, 'right'],
  [DEV_GRANT, 'right'],
  [PROD_DB, 'object'],
  [DEV_DB, 'object'],
  [BILLING, 'object'],
])
const OVER = new Map([
  [PROD_GRANT, [PROD_DB]],
  [DEV_GRANT, [DEV_DB]],
])
const namesakesFrom = (entries: Iterable<readonly [string, string | undefined]>): Namesakes =>
  namesakesOf([...entries].map(([ref, env]) => ({ name: ref.slice(ref.indexOf('/') + 1), env })))
/** Every name the repository in miniature holds; billing-api declares no environment. */
const KNOWN = namesakesFrom([...NATURES.keys()].map((ref) => [ref, DECLARED.get(ref)] as const))

const signature = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: new Set([PROD_DB, DEV_DB, PROD_GRANT, DEV_GRANT, BILLING]),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
  environments: DECLARED,
  namesakes: KNOWN,
  ...over,
})

/** A grant billing-api would hold over the database of `env`, declared `declares`. */
const access = (env: string, declares: string = env, name = `billing-api-orders-db-${env}`) => ({
  kind: 'Resource' as const,
  metadata: { name, env: declares },
  spec: {
    type: 'database-access' as const,
    access: 'read',
    owner: 'group:default/tiger',
    dependsOn: [`resource:default/orders-db-${env}`],
    dependencyOf: [BILLING],
  },
})

const creating = (intent: string, entity: unknown = access('prod')): Plan =>
  planSchema.parse({ intent, operations: [{ op: 'create-entity', entity }] })

const joining = (intent: string, grant = PROD_GRANT): Plan =>
  planSchema.parse({
    intent,
    operations: [
      {
        op: 'update-entity',
        entityRef: grant,
        patch: { patch: 'add-dependency-of', consumer: BILLING, access: 'read' },
      },
    ],
  })

/** The level answered, as a run answers it; the environment only when given. */
const said = (plan: Plan, answers: Record<string, string> = {}): Provenance =>
  userSaid(plan.intent, { [LEVEL]: 'read', ...answers })

const signed = (
  plan: Plan,
  provenance: Provenance = said(plan),
  context: SignatureContext = signature(),
): SignedPlan => {
  const result = signPlan(plan, context, provenance)
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

const envClass = (plan: Plan, provenance?: Provenance, context?: SignatureContext) =>
  signed(plan, provenance, context).classified.find((leaf) => leaf.path === CREATED_ENV)?.class

const asks = (plan: Plan, answers: Record<string, string> = {}): string[] =>
  questionsOf(plan, {
    environments: ['dev', 'prod'],
    declared: DECLARED,
    natures: NATURES,
    namesakes: KNOWN,
    over: OVER,
    provenance: userSaid(plan.intent, answers),
  }).map((question) => question.path)

const policies: PolicyContext = {
  vocabulary,
  witnesses: new Set(['dependencies/access']),
  environments: DECLARED,
  levels: new Map([
    [PROD_GRANT, 'read'],
    [DEV_GRANT, 'read'],
  ]),
  natures: NATURES,
  over: OVER,
  namesakes: KNOWN,
}

const mismatches = (plan: Plan, provenance: Provenance): string[] =>
  checkPolicies(signed(plan, provenance), policies, provenance)
    .filter((violation) => violation.policy === 'environment-mismatch')
    .map((violation) => violation.message)

describe('an environment word states nothing', () => {
  it.each(WORDS)('asks the environment of a creation, in %s', (_language, intent) => {
    const result = signed(creating(intent))

    expect(result.classified.find((leaf) => leaf.path === CREATED_ENV)?.class).toBe('novel')
    expect(findUnknowns(result.plan)).toContain(CREATED_ENV)
  })

  it.each(WORDS)('asks the environment of an update, in %s', (_language, intent) => {
    expect(asks(joining(intent))).toEqual([ENVIRONMENT])
  })

  it.each(NEGATED)('asks a creation, never taking the other environment, in %s', (_how, intent) => {
    expect(envClass(creating(intent))).toBe('novel')
    expect(envClass(creating(intent, access('dev')))).toBe('novel')
  })

  it.each(NEGATED)('asks an update of either grant, in %s', (_how, intent) => {
    expect(asks(joining(intent))).toEqual([ENVIRONMENT])
    expect(asks(joining(intent, DEV_GRANT))).toEqual([ENVIRONMENT])
  })

  it('signs an environment the person answered for the creation', () => {
    const plan = creating(WORDS[0]?.[1] ?? '')

    expect(envClass(plan, said(plan, { [CREATED_ENV]: 'prod' }))).toBe('echoed')
    // The answer is about this field and this value: `dev` answered vouches
    // for no `prod`.
    expect(envClass(plan, said(plan, { [CREATED_ENV]: 'dev' }))).toBe('novel')
  })

  it('does not ask an update again once answered, whatever the answer', () => {
    for (const env of ['prod', 'dev']) {
      expect(asks(joining(WORDS[0]?.[1] ?? ''), { [ENVIRONMENT]: env })).toEqual([])
    }
  })

  it('never vouches through a name’s words either: a composed name is not an environment', () => {
    // `billing-api-orders-db-prod` is still vouched for segment by segment —
    // a name is the model's to choose — while its environment is asked.
    const result = signed(creating(WORDS[0]?.[1] ?? ''))

    expect(
      result.classified.find((leaf) => leaf.path === 'operations.0.entity.metadata.name')?.class,
    ).toBe('echoed')
    expect(result.classified.find((leaf) => leaf.path === CREATED_ENV)?.class).toBe('novel')
  })
})

describe('the declaration the person points at', () => {
  it('derives the environment of a right the draft creates over it', () => {
    const plan = creating(OWNER)

    expect(envClass(plan)).toBe('derived')
    expect(findUnknowns(signed(plan).plan)).toEqual([])
  })

  it.each([
    ['kind:name in the default namespace', 'donne à billing-api un accès en lecture à resource:orders-db-prod'],
    ['in Japanese', 'billing-apiにresource:default/orders-db-prodへの読み取りアクセスを付与'],
  ])('derives it through %s', (_how, intent) => {
    expect(envClass(creating(intent))).toBe('derived')
  })

  it('asks when the draft declares another environment than the one pointed at', () => {
    expect(envClass(creating(OWNER, access('prod', 'dev')))).toBe('novel')
  })

  it.each([
    ['a negation beside the reference', `${OWNER}, pas en dev`],
    ['the reference negated', 'donne à component:default/billing-api un accès en lecture, pas à resource:default/orders-db-prod'],
    ['a negation elsewhere', `${OWNER}, sans urgence`],
    ['a negation the lexicon learnt from the verifier', `${OWNER}, dont rush`],
  ])('does not point when the request holds %s', (_how, intent) => {
    // The lexicon is a veto on the pointing, never a reading of the sentence.
    expect(envClass(creating(intent))).toBe('novel')
    expect(asks(joining(intent))).toEqual([ENVIRONMENT])
  })

  it.each(CONTRADICTED)('does not point when the request says another environment: %s', (_how, intent) => {
    // A word never states an environment, and it can still cancel one: what
    // the person typed contradicts the declaration, so it is asked.
    expect(envClass(creating(intent))).toBe('novel')
    expect(asks(joining(intent))).toEqual([ENVIRONMENT])
  })

  it('still points when the only environment word is the one pointed at', () => {
    const intent = `${OWNER}, en prod`

    expect(envClass(creating(intent))).toBe('derived')
    expect(asks(joining(intent))).toEqual([])
  })

  it('does not read the pointed reference’s own name as a word', () => {
    // `orders-db-pre-prod` spells `prod` as a part, and pointing at it is not
    // saying prod: the references pointed at are set aside before the words
    // are read.
    const PRE = 'resource:default/orders-db-pre-prod'
    const environments = new Map([...DECLARED, [PRE, 'pre-prod']])
    const context = signature({
      vocabulary: { ...vocabulary, environments: ['dev', 'pre-prod', 'prod'] },
      witnessed: new Set([PRE, BILLING]),
      environments,
      namesakes: namesakesFrom([...environments]),
    })
    const intent = `donne à ${BILLING} un accès en lecture à ${PRE}`

    expect(envClass(creating(intent, access('pre-prod')), undefined, context)).toBe('derived')
  })

  it('asks when an environment word stands elsewhere — the cost of failing closed', () => {
    expect(envClass(creating(`${OWNER}, pour l’équipe dev`))).toBe('novel')
  })

  it('does not point when the request mentions an entity of another environment', () => {
    const intent = `${OWNER}, comme orders-db-dev`

    expect(envClass(creating(intent))).toBe('novel')
    expect(asks(joining(intent))).toEqual([ENVIRONMENT])
  })

  it('does not point through a bare name', () => {
    const intent = 'donne à billing-api un accès en lecture à orders-db-prod'

    expect(envClass(creating(intent))).toBe('novel')
    expect(asks(joining(intent))).toEqual([ENVIRONMENT])
  })

  it('does not point at a thing the same plan creates', () => {
    // Its environment is a question of its own, or the plan's word about
    // itself — never a declaration the person pointed at.
    const staging = 'resource:default/orders-db-staging'
    const plan = planSchema.parse({
      intent: `donne à component:default/billing-api un accès en lecture à ${staging}`,
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'orders-db-staging', env: 'staging' },
            spec: { type: 'database', owner: 'group:default/tiger' },
          },
        },
        { op: 'create-entity', entity: access('staging') },
      ],
    })
    const context = signature({
      environments: new Map([...DECLARED, [staging, 'staging']]),
      namesakes: namesakesFrom([
        ...[...NATURES.keys()].map((ref) => [ref, DECLARED.get(ref)] as const),
        [staging, 'staging'],
      ]),
    })
    const result = signed(plan, userSaid(plan.intent, { 'operations.1.entity.spec.access': 'read' }), context)

    expect(findUnknowns(result.plan)).toEqual([
      'operations.0.entity.metadata.env',
      'operations.1.entity.metadata.env',
    ])
  })

  it('does not point at a thing declaring no environment', () => {
    const context = signature({ environments: new Map([[DEV_DB, 'dev']]) })

    expect(envClass(creating(OWNER), undefined, context)).toBe('novel')
  })

  it('does not point without the repository’s names', () => {
    const { namesakes: _namesakes, ...unknown } = signature()

    expect(envClass(creating(OWNER), undefined, unknown)).toBe('novel')
  })

  it('does not point for a thing, only for a right over one', () => {
    // A database declared on another names its own environment, and that one
    // is asked: the rule is about the access a grant hands out.
    const plan = planSchema.parse({
      intent: `declare a replica of ${PROD_DB}`,
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'orders-db-prod-replica', env: 'prod' },
            spec: { type: 'database', owner: 'group:default/tiger', dependsOn: [PROD_DB] },
          },
        },
      ],
    })

    expect(envClass(plan)).toBe('novel')
  })
})

describe('environment-mismatch, with no words to read', () => {
  it('stays silent while the environment is a question', () => {
    const plan = creating(WORDS[0]?.[1] ?? '', access('dev'))

    expect(mismatches(plan, said(plan))).toEqual([])
  })

  it('refuses a plan touching an environment nobody answered', () => {
    // prod answered, and the name the draft chose says dev.
    const plan = creating('give billing-api read access to orders-db', access('prod', 'prod', 'billing-api-orders-db-dev'))
    const provenance = said(plan, { [CREATED_ENV]: 'prod' })

    expect(mismatches(plan, provenance)).toEqual([
      'the plan touches dev, but prod was answered at operations.0.entity.metadata.env. ' +
        'An environment is never inferred.',
    ])
  })

  it('refuses a plan touching an environment the person did not point at', () => {
    const plan = creating(OWNER, access('prod', 'prod', 'billing-api-orders-db-dev'))

    expect(mismatches(plan, said(plan))).toEqual([
      `the plan touches dev, but the request named ${PROD_DB}, which is declared prod. ` +
        'An environment is never inferred.',
    ])
  })

  it('refuses an update joining a grant in another environment than the one answered', () => {
    const plan = joining('give billing-api read access to orders-db')
    const provenance = userSaid(plan.intent, {
      'operations.0.patch.access': 'read',
      [ENVIRONMENT]: 'dev',
    })

    expect(mismatches(plan, provenance)).toHaveLength(1)
  })

  it('does not refuse a plan whose environment was answered, or pointed at', () => {
    const answered = creating(WORDS[0]?.[1] ?? '')
    const pointed = creating(OWNER)
    const joined = joining(WORDS[0]?.[1] ?? '')

    expect(mismatches(answered, said(answered, { [CREATED_ENV]: 'prod' }))).toEqual([])
    expect(mismatches(pointed, said(pointed))).toEqual([])
    expect(
      mismatches(
        joined,
        userSaid(joined.intent, { 'operations.0.patch.access': 'read', [ENVIRONMENT]: 'prod' }),
      ),
    ).toEqual([])
  })
})

describe('the answer, reapplied to a redraft', () => {
  it('follows the access into a grant the redraft names otherwise, and vouches there', () => {
    const intent = WORDS[0]?.[1] ?? ''
    const first = creating(intent)
    const recorded = recordAnswers(first, [{ path: CREATED_ENV, value: 'prod' }], OVER)
    const redraft = creating(intent, access('prod', 'dev', 'billing-api-reads-orders-db-prod'))

    const reapplication = reapplyAnswers(redraft, recorded, OVER)
    const provenance = userSaid(intent, { [LEVEL]: 'read', ...Object.fromEntries(reapplication.answers) })

    expect(reapplication.answers.get(CREATED_ENV)).toBe('prod')
    expect(envClass(reapplication.plan, provenance)).toBe('echoed')
  })
})

/** End to end, through `plan --from` and a person at the keyboard. */
describe('plan --from', () => {
  const document = (lines: readonly string[]): string => ['---', ...lines, ''].join('\n')
  const component = (name: string): string =>
    document([
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      `  name: ${name}`,
      'spec:',
      '  type: service',
      '  lifecycle: production',
      '  owner: group:default/tiger',
    ])
  const database = (env: string): string =>
    document([
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      `  name: orders-db-${env}`,
      '  annotations:',
      `    company.fr/env: ${env}`,
      'spec:',
      '  type: database',
      '  owner: group:default/tiger',
    ])
  const grant = (env: string): string =>
    document([
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      `  name: orders-api-orders-db-${env}`,
      '  annotations:',
      `    company.fr/env: ${env}`,
      'spec:',
      '  type: database-access',
      '  access: read',
      '  owner: group:default/tiger',
      '  dependsOn:',
      `    - resource:default/orders-db-${env}`,
      '  dependencyOf:',
      '    - component:default/orders-api',
    ])

  const repository = async (): Promise<string> => {
    const repo = path.join(await mkdtemp(path.join(tmpdir(), 'idp-env-decl-')), 'IaC')
    await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
    const files: Record<string, string> = {
      'components/.witness.yml': '---\n',
      'components/billing-api.yml': component('billing-api'),
      'components/orders-api.yml': component('orders-api'),
      'catalog/databases/orders-db-prod.yml': database('prod'),
      'catalog/databases/orders-db-dev.yml': database('dev'),
      'dependencies/access/orders-api-orders-db-prod.yml': grant('prod'),
      'dependencies/access/orders-api-orders-db-dev.yml': grant('dev'),
    }
    for (const [relative, text] of Object.entries(files)) {
      const absolute = path.join(repo, ...relative.split('/'))
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, text, 'utf8')
    }
    return repo
  }

  const planFile = async (repo: string, plan: unknown): Promise<string> => {
    const file = path.join(path.dirname(repo), 'plan.json')
    await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    return file
  }

  /** Answers a level `read`, an environment `environment`, and declines the rest. */
  const answering = (environment: string | undefined): { ask: Ask; asked: Question[] } => {
    const asked: Question[] = []
    const ask: Ask = async (question) => {
      asked.push(question)
      if (question.path.endsWith('.access')) return 'read'
      if (question.path.endsWith('.environment') || question.path.endsWith('.metadata.env')) {
        return environment
      }
      return undefined
    }
    return { ask, asked }
  }

  const environmentsAsked = (asked: readonly Question[]): Question[] =>
    asked.filter(
      (question) =>
        question.path.endsWith('.environment') || question.path.endsWith('.metadata.env'),
    )

  const joiningOp = {
    op: 'update-entity',
    entityRef: PROD_GRANT,
    patch: { patch: 'add-dependency-of', consumer: BILLING, access: 'read' },
  }
  const creatingOp = { op: 'create-entity', entity: access('prod') }

  it.each([
    ['an update', joiningOp, ENVIRONMENT, '+++ b/dependencies/access/orders-api-orders-db-prod.yml'],
    ['a creation', creatingOp, CREATED_ENV, '+++ b/dependencies/access/billing-api-orders-db-prod.yml'],
  ])('asks the environment of %s named in words, and ends on the diff answered', async (_what, operation, where, diff) => {
    const repo = await repository()
    const before = await hashTree(repo)
    const { ask, asked } = answering('prod')

    const result = await runPlan({
      from: await planFile(repo, { intent: WORDS[0]?.[1], operations: [operation] }),
      repo,
      ask,
    })

    expect(environmentsAsked(asked).map((question) => [question.path, question.proposed])).toEqual([
      [where, 'prod'],
    ])
    expect(environmentsAsked(asked)[0]?.inUse).toEqual(['dev', 'prod'])
    expect(result.found).toBe(true)
    expect(result.text).toContain(diff)
    expect(await hashTree(repo)).toBe(before)
  })

  it.each([
    ['an update', joiningOp],
    ['a creation', creatingOp],
  ])('ends %s on the questions when nobody answers the environment', async (_what, operation) => {
    const repo = await repository()
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent: WORDS[0]?.[1], operations: [operation] }),
      repo,
      ask,
    })

    expect(environmentsAsked(asked)).toHaveLength(1)
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })

  it.each(NEGATED)('asks a request negating prod, in %s, end to end', async (_how, intent) => {
    const repo = await repository()
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [creatingOp] }),
      repo,
      ask,
    })

    expect(environmentsAsked(asked).map((question) => question.proposed)).toEqual(['prod'])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })

  it('ends the owner’s phrase joining a grant on the diff, asking only the level', async () => {
    const repo = await repository()
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent: OWNER, operations: [joiningOp] }),
      repo,
      ask,
    })

    expect(asked.map((question) => question.path)).toEqual(['operations.0.patch.access'])
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/orders-api-orders-db-prod.yml')
  })

  it('ends the owner’s phrase creating a grant on the diff, its environment derived', async () => {
    const repo = await repository()
    const before = await hashTree(repo)
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent: OWNER, operations: [creatingOp] }),
      repo,
      ask,
    })

    expect(asked.map((question) => question.path)).toEqual([LEVEL])
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/billing-api-orders-db-prod.yml')
    expect(result.text).toContain('+    company.fr/env: prod')
    expect(await hashTree(repo)).toBe(before)
  })

  it.each(
    CONTRADICTED.flatMap(([how, intent]) => [
      [`an update, ${how}`, intent, joiningOp, ENVIRONMENT],
      [`a creation, ${how}`, intent, creatingOp, CREATED_ENV],
    ] as const),
  )('asks a reference beside another environment’s word, %s, end to end', async (_what, intent, operation, where) => {
    const repo = await repository()
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [operation] }),
      repo,
      ask,
    })

    expect(environmentsAsked(asked).map((question) => question.path)).toEqual([where])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })

  it.each([
    ['a negation', 'donne à component:default/billing-api un accès en lecture, pas à resource:default/orders-db-prod'],
    ['another environment’s entity', `${OWNER}, comme orders-db-dev`],
  ])('asks the owner’s phrase beside %s, end to end', async (_what, intent) => {
    const repo = await repository()
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [creatingOp] }),
      repo,
      ask,
    })

    expect(environmentsAsked(asked).map((question) => question.path)).toEqual([CREATED_ENV])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })
})
