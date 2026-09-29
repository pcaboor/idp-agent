import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { fillAnswers, runIntent, runPlan, type Ask } from '../../src/cli/commands/plan.js'
import { questionsOf, type Question } from '../../src/core/plan/clarify.js'
import { namesakesOf, type Namesakes } from '../../src/core/plan/environment.js'
import { recordAnswers, reapplyAnswers } from '../../src/core/plan/reapply.js'
import { planSchema, type Plan } from '../../src/core/schemas/plan.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'
import type { Nature } from '../../src/core/schemas/resource-types.js'
import { hashTree } from '../support/tree.js'
import { userSaid } from '../support/provenance.js'

/**
 * core-plan-3. An `update-entity` joins a consumer to a grant that already
 * exists, and the grant's environment is whatever the repository declares — so
 * the environment the consumer is handed was the model's choice. The patch has
 * no environment leaf for the signature to classify, and a policy only
 * measured the grant against an environment somebody stated: when nobody
 * stated one, nothing asked, and the model picked the dev grant or the prod
 * grant freely.
 *
 * §7.5: a picker, never a default. Unless the person answered it, or pointed
 * at what the grant is over by its reference in full, the environment of the
 * grant an update targets is asked — shown the grant the draft chose and its
 * environment, and the environments in use — and the answer is held to it: an
 * answer naming another environment is refused, with the grant of that
 * environment as the remedy, and never retargeted. A word of the request never
 * states one (the owner's decision of 2026-09-27), in any language.
 */

const PROD_GRANT = 'resource:default/orders-api-orders-db-prod'
const DEV_GRANT = 'resource:default/orders-api-orders-db-dev'
const BILLING = 'component:default/billing-api'
const ENVIRONMENT = 'operations.0.environment'
/** No environment in any script: "orders-db" names none, and "lecture" is a level. */
const UNSCOPED = 'donne à billing-api un accès en lecture à orders-db'

const joining = (entityRef: string, consumer = BILLING) => ({
  op: 'update-entity',
  entityRef,
  patch: { patch: 'add-dependency-of', consumer, access: 'read' },
})

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

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-update-env-'))

/**
 * The owner's repository in miniature: orders-api holds a grant over the prod
 * database, and — unless `dev` is false — one over the dev database too.
 */
const repository = async ({ dev = true }: { readonly dev?: boolean } = {}): Promise<string> => {
  const repo = path.join(await temp(), 'IaC')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  const files: Record<string, string> = {
    'components/.witness.yml': '---\n',
    'components/billing-api.yml': component('billing-api'),
    'components/orders-api.yml': component('orders-api'),
    'catalog/databases/orders-db-prod.yml': database('prod'),
    'catalog/databases/orders-db-dev.yml': database('dev'),
    'dependencies/access/orders-api-orders-db-prod.yml': grant('prod'),
    ...(dev ? { 'dependencies/access/orders-api-orders-db-dev.yml': grant('dev') } : {}),
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

/** Answers a level `read`, the environment `environment`, and declines the rest. */
const answering = (environment: string | undefined): { ask: Ask; asked: Question[] } => {
  const asked: Question[] = []
  const ask: Ask = async (question) => {
    asked.push(question)
    if (question.path.endsWith('.access')) return 'read'
    if (question.path.endsWith('.environment')) return environment
    return undefined
  }
  return { ask, asked }
}

const environmentQuestions = (asked: readonly Question[]): Question[] =>
  asked.filter((question) => question.path.endsWith('.environment'))

const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

/**
 * The Architect reads what it proposes before proposing it: a reference its
 * tools never returned is one nothing vouches for, and would be asked first.
 */
const reading = (...refs: string[]): GenerateResult[] =>
  refs.map((ref) => turnCalling('get_entity', { ref }))

const openingOf = (request: GenerateRequest | undefined): string => {
  const first = request?.transcript[0]
  return first !== undefined && first.role === 'user' ? first.text : ''
}

/** What the repository declares, as `contextsOf` reads it. */
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

const parsed = (intent: string, operations: unknown[]): Plan =>
  planSchema.parse({ intent, operations })

/** The names of `entries`, each with the environment its entity declares. */
const namesakesFrom = (
  entries: Iterable<readonly [string, string | undefined]>,
): Namesakes =>
  namesakesOf([...entries].map(([ref, env]) => ({ name: ref.slice(ref.indexOf('/') + 1), env })))

/** Every name the repository in miniature holds, and what each declares. */
const KNOWN = namesakesFrom([...NATURES.keys()].map((ref) => [ref, DECLARED.get(ref)] as const))

describe('the question', () => {
  const context = (intent: string, answers: Record<string, string> = {}) => ({
    environments: ['dev', 'prod'],
    declared: DECLARED,
    natures: NATURES,
    namesakes: KNOWN,
    over: OVER,
    provenance: userSaid(intent, answers),
  })

  it('is asked when the user neither answered nor pointed at the environment of the grant', () => {
    const questions = questionsOf(parsed(UNSCOPED, [joining(PROD_GRANT)]), context(UNSCOPED))

    expect(questions).toEqual([
      {
        path: ENVIRONMENT,
        question:
          `the draft joins ${BILLING} to ${PROD_GRANT}, which is declared prod, and an ` +
          'environment is never read from the words of a request; which environment is this ' +
          'access for?',
        proposed: 'prod',
        inUse: ['dev', 'prod'],
        implied: true,
      },
    ])
  })

  it.each([
    ['English', 'give billing-api read access to orders-db in prod'],
    ['French', 'donne à billing-api un accès en lecture à orders-db en prod'],
    ['Japanese', 'billing-apiにprod環境のorders-dbへの読み取りアクセスを付与'],
  ])('is asked when the %s request names the grant’s environment in words', (_language, intent) => {
    // A word states no environment, as it states no level: "not prod" and
    // "prodではなく" leave `prod` a whole word, and no list of negations is
    // complete.
    expect(
      questionsOf(parsed(intent, [joining(PROD_GRANT)]), context(intent)).map(
        (question) => question.path,
      ),
    ).toEqual([ENVIRONMENT])
  })

  it('is asked when the request says "non-prod": a word containing prod names none', () => {
    const intent = 'give billing-api read access to orders-db in non-prod'
    const questions = questionsOf(parsed(intent, [joining(PROD_GRANT)]), context(intent))

    expect(questions.map((question) => question.path)).toEqual([ENVIRONMENT])
  })

  it('is not asked again once answered, whatever the answer', () => {
    for (const env of ['prod', 'dev']) {
      const answered = context(UNSCOPED, { [ENVIRONMENT]: env })
      expect(questionsOf(parsed(UNSCOPED, [joining(PROD_GRANT)]), answered)).toEqual([])
    }
  })

  it('is not asked of a thing, which carries no consumers', () => {
    // `consumer-on-an-object` refuses it.
    const thing = parsed(UNSCOPED, [joining('resource:default/orders-db-prod')])

    expect(questionsOf(thing, context(UNSCOPED))).toEqual([])
  })

  it('is asked of a grant that declares no environment, with none shown as the draft’s', () => {
    // Over nothing the repository declares an environment for: there is no
    // environment to show as the draft's, and still one handed out.
    const unscoped = parsed(UNSCOPED, [joining('resource:default/legacy-grant')])
    const natures = new Map([...NATURES, ['resource:default/legacy-grant', 'right' as const]])

    expect(questionsOf(unscoped, { ...context(UNSCOPED), natures })).toEqual([
      {
        path: ENVIRONMENT,
        question:
          `the draft joins ${BILLING} to resource:default/legacy-grant, which declares no ` +
          'environment, and an environment is never read from the words of a request; which ' +
          'environment is this access for?',
        inUse: ['dev', 'prod'],
        implied: true,
      },
    ])
  })

  it('is recorded, never written into the plan', async () => {
    const plan = parsed(UNSCOPED, [joining(PROD_GRANT)])
    const questions = questionsOf(plan, context(UNSCOPED))

    const filled = await fillAnswers(plan, questions, async () => 'prod')

    expect(filled).toEqual({
      outcome: 'answered',
      plan,
      answers: [{ path: ENVIRONMENT, value: 'prod' }],
    })
  })
})

/**
 * The owner's own phrase: "donne à component:default/billing-api un accès en
 * lecture à resource:default/orders-db-prod". It names no environment, and it
 * names the thing the grant is over — and that thing declares prod. The
 * environment then follows from a declaration the person pointed at, and
 * nothing is inferred: asking "which environment?" of it was the engine
 * ignoring what it had been told.
 *
 * The rule, which fails closed: every thing the grant is over is named by its
 * reference in full — `kind:namespace/name`, or `kind:name` in the default
 * namespace — as a whole token (`echoes`), and declares the one environment
 * the grant hands out (`scopeOf`); and no name the repository holds that the
 * request so much as CONTAINS — any kind, set aside or refused, in any
 * namespace — is declared in another environment by any of its documents.
 * A bare name never points. Anything short of that is asked.
 */
describe('a request naming the thing the grant is over', () => {
  const OWNER =
    'donne à component:default/billing-api un accès en lecture à resource:default/orders-db-prod'
  const BARE = 'donne à billing-api un accès en lecture à orders-db-prod'
  const USERS_DB = 'resource:default/users-db-prod'
  const WIDE_GRANT = 'resource:default/orders-api-everything-prod'
  const CACHE = 'resource:default/orders-cache'
  const CACHE_GRANT = 'resource:default/orders-api-orders-cache'
  const MISDECLARED = 'resource:default/orders-api-orders-db-misdeclared'
  const LEGACY = 'resource:default/legacy-orders-grant'
  const declared = new Map([
    ...DECLARED,
    [USERS_DB, 'prod'],
    [WIDE_GRANT, 'prod'],
    [CACHE_GRANT, 'prod'],
    [MISDECLARED, 'dev'],
  ])
  const natures = new Map<string, Nature>([
    ...NATURES,
    [USERS_DB, 'object'],
    [CACHE, 'object'],
    [WIDE_GRANT, 'right'],
    [CACHE_GRANT, 'right'],
    [MISDECLARED, 'right'],
    [LEGACY, 'right'],
  ])
  /** Every entity of the repository, and the environment each declares. */
  const everyEntity = (extra: readonly (readonly [string, string | undefined])[] = []) =>
    namesakesFrom([
      ...[...natures.keys()].map((ref) => [ref, declared.get(ref)] as const),
      ...extra,
    ])
  const context = (intent: string, namesakes: Namesakes = everyEntity()) => ({
    environments: ['dev', 'prod'],
    declared,
    natures,
    namesakes,
    over: new Map([
      ...OVER,
      [WIDE_GRANT, ['resource:default/orders-db-prod', USERS_DB]],
      [CACHE_GRANT, [CACHE]],
      [MISDECLARED, ['resource:default/orders-db-prod']],
      [LEGACY, ['resource:default/orders-db-prod']],
    ]),
    provenance: userSaid(intent),
  })
  const asks = (intent: string, grant = PROD_GRANT, namesakes?: Namesakes): string[] =>
    questionsOf(parsed(intent, [joining(grant)]), context(intent, namesakes)).map(
      (question) => question.path,
    )

  it.each([
    ['by its full reference', OWNER],
    ['by kind:name', 'donne à billing-api un accès en lecture à resource:orders-db-prod'],
    ['in capitals', 'donne à billing-api un accès en lecture à Resource:Default/Orders-DB-Prod'],
    ['in Japanese', 'billing-apiにresource:default/orders-db-prodへの読み取りアクセスを付与'],
  ])('is not asked when the request names it %s and it declares the grant’s', (_how, intent) => {
    expect(asks(intent)).toEqual([])
  })

  it.each([
    ['in French', BARE],
    ['in Japanese', 'billing-apiにorders-db-prodへの読み取りアクセスを付与'],
  ])('is asked when the request names it by its bare name, %s', (_how, intent) => {
    // A bare name is not a reference: whichever entity carries it, it never points.
    expect(asks(intent)).toEqual([ENVIRONMENT])
  })

  it('is not asked of a grant declaring none, whose thing the request names', () => {
    // `scopeOf` hands out the thing's environment, and that is what was named.
    expect(asks(OWNER, LEGACY)).toEqual([])
  })

  it('is still asked when the request names no such entity', () => {
    expect(asks(UNSCOPED)).toEqual([ENVIRONMENT])
  })

  it('is asked when the request names another thing than the one the grant is over', () => {
    const intent =
      'donne à component:default/billing-api un accès en lecture à resource:default/orders-db-dev'
    const questions = questionsOf(parsed(intent, [joining(PROD_GRANT)]), context(intent))

    expect(questions.map((question) => question.path)).toEqual([ENVIRONMENT])
    expect(questions[0]?.question).toContain(`${PROD_GRANT}, which is declared prod`)
  })

  it('is asked when the thing named declares no environment', () => {
    expect(asks(`donne à billing-api un accès en lecture à ${CACHE}`, CACHE_GRANT)).toEqual([
      ENVIRONMENT,
    ])
  })

  it('is asked when the grant declares another environment than the thing named', () => {
    expect(asks(OWNER, MISDECLARED)).toEqual([ENVIRONMENT])
  })

  it('is asked of a grant over two things when only one is named, and not when both are', () => {
    expect(asks(OWNER, WIDE_GRANT)).toEqual([ENVIRONMENT])
    expect(asks(`${OWNER} et ${USERS_DB}`, WIDE_GRANT)).toEqual([])
    // Named bare, the second one points at nothing.
    expect(asks(`${OWNER} et users-db-prod`, WIDE_GRANT)).toEqual([ENVIRONMENT])
  })

  it.each([
    ['in English', 'give billing-api read access to orders-db-dev, not orders-db-prod'],
    ['in French', 'donne à billing-api un accès en lecture à orders-db-dev, pas à orders-db-prod'],
    [
      'by full references',
      'give billing-api read access to resource:default/orders-db-dev, not ' +
        'resource:default/orders-db-prod',
    ],
  ])('is asked when the request names things in two environments, %s', (_how, intent) => {
    // Both grants: the request names the thing each is over, and another
    // thing in another environment beside it — which one it meant is the
    // person's to say. What "not" or "pas" is about is not read: a negation
    // anywhere withdraws the pointing on its own (`negates`).
    expect(asks(intent)).toEqual([ENVIRONMENT])
    expect(asks(intent, DEV_GRANT)).toEqual([ENVIRONMENT])
  })

  it('is asked when the consumer the request names declares another environment', () => {
    expect(asks(OWNER, PROD_GRANT, everyEntity([[BILLING, 'dev']]))).toEqual([ENVIRONMENT])
  })

  it.each([
    ['a Component', 'component:default/orders-db-prod'],
    ['an API', 'api:default/orders-db-prod'],
    ['a System set aside', 'system:default/orders-db-prod'],
    ['an entity of another namespace', 'resource:legacy/orders-db-prod'],
  ])('is asked when %s carries the same name in another environment', (_what, namesake) => {
    // "orders-db-prod" is in the request either way, full reference or not:
    // a name two environments declare is a question, whoever carries it.
    const namesakes = everyEntity([[namesake, 'dev']])

    expect(asks(BARE, PROD_GRANT, namesakes)).toEqual([ENVIRONMENT])
    expect(asks(OWNER, PROD_GRANT, namesakes)).toEqual([ENVIRONMENT])
  })

  it('still points through a name its namesake declares no environment for', () => {
    // One environment across everything mentioned: a namesake declaring none
    // adds no second one.
    const namesakes = everyEntity([['component:default/orders-db-prod', undefined]])

    expect(asks(OWNER, PROD_GRANT, namesakes)).toEqual([])
  })

  it('is asked when the repository’s names are not known', () => {
    const { namesakes: _namesakes, ...unknown } = context(OWNER)

    expect(
      questionsOf(parsed(OWNER, [joining(PROD_GRANT)]), unknown).map((question) => question.path),
    ).toEqual([ENVIRONMENT])
  })

  it('is asked when the repository holds a refused document whose name cannot be read', () => {
    const unreadable: Namesakes = { ...everyEntity(), unreadable: true }

    expect(asks(OWNER, PROD_GRANT, unreadable)).toEqual([ENVIRONMENT])
  })

  it.each([
    ['a longer reference', 'donne à billing-api un accès à resource:default/orders-db-prod-replica'],
    ['a file name', 'donne à billing-api un accès à orders-db-prod.yml'],
    ['a longer name', 'donne à billing-api un accès à billing-api-orders-db-prod'],
    ['another kind’s reference', 'donne à billing-api un accès à component:default/orders-db-prod'],
    ['a reference doubled at its tail', 'donne à billing-api un accès à resource:default/orders-db-prod-prod'],
  ])('is asked when the name is only part of %s', (_what, intent) => {
    expect(asks(intent)).toEqual([ENVIRONMENT])
  })

  /**
   * Each of these once pointed. The name of another environment's entity sat
   * after a `:` or a `/` — a URL, a full-width colon NFKC reads as `:`, a
   * `namespace/name` — and was taken for the tail of a reference and struck
   * out before anything was looked for; or an invisible character split it.
   * A mention is now a plain substring of the request, tails and all.
   */
  it.each([
    ['in a URL', `${OWNER}, voir https://wiki.example/orders-db-dev`],
    ['after a full-width colon', `${OWNER}（参照：orders-db-dev）`],
    ['as namespace/name', `${OWNER}, comme legacy/orders-db-dev`],
    ['after a colon', `${OWNER}, comme resource:orders-db-dev`],
    ['split by a soft hyphen', `${OWNER}, comme orders-db-\u00ADdev`],
    ['split by a zero-width space', `${OWNER}, comme orders-db\u200B-dev`],
    ['split by a zero-width joiner', `${OWNER}, comme orders-\u200Ddb-dev`],
    ['split by a word joiner', `${OWNER}, comme orders\u2060-db-dev`],
  ])('is asked when another environment’s entity is mentioned %s', (_how, intent) => {
    expect(asks(intent)).toEqual([ENVIRONMENT])
  })

  it('is asked of a component whose name carries the bare name twice', () => {
    // `component:default/shared-shared` struck `/shared` out and left
    // `-shared`, a bare `shared` that pointed at the database of that name.
    const SHARED = 'resource:default/shared'
    const SHARED_GRANT = 'resource:default/g-shared-prod'
    const intent = 'donne à billing-api un accès en lecture à component:default/shared-shared'
    const plan = parsed(intent, [joining(SHARED_GRANT)])

    const questions = questionsOf(plan, {
      ...context(intent, everyEntity([[SHARED, 'prod'], ['component:default/shared-shared', undefined]])),
      declared: new Map([...declared, [SHARED, 'prod'], [SHARED_GRANT, 'prod']]),
      natures: new Map<string, Nature>([...natures, [SHARED, 'object'], [SHARED_GRANT, 'right']]),
      over: new Map([[SHARED_GRANT, [SHARED]]]),
    })

    expect(questions.map((question) => question.path)).toEqual([ENVIRONMENT])
  })

  it('is asked when the request names an environment and an entity of another', () => {
    // "in prod" beside the dev database: the draft picking the prod grant, over
    // a thing nobody named, was the model's choice passed off as the word's.
    const intent = 'give component:default/billing-api read access to orders-db-dev in prod'

    expect(asks(intent)).toEqual([ENVIRONMENT])
    expect(asks(intent, DEV_GRANT)).toEqual([ENVIRONMENT])
    // The word alone states nothing; beside an entity of its own environment,
    // named in full, the pointing still says it.
    expect(asks('give billing-api read access to orders-db in prod')).toEqual([ENVIRONMENT])
    expect(asks(`${OWNER} en prod`)).toEqual([])
  })

  it('ends the owner’s phrase on the diff, asking only the level', async () => {
    const repo = await repository()
    const before = await hashTree(repo)
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent: OWNER, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(asked.map((question) => question.path)).toEqual(['operations.0.patch.access'])
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/orders-api-orders-db-prod.yml')
    expect(result.text).toContain(`+    - ${BILLING}`)
    expect(await hashTree(repo)).toBe(before)
  })

  it('asks the same phrase with the bare name', async () => {
    const repo = await repository()
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent: BARE, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual(['prod'])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })

  it('never ends on prod when the request named the dev database', async () => {
    const repo = await repository()
    const intent = 'donne à billing-api un accès en lecture à orders-db-dev'
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual(['prod'])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })

  /**
   * What the repository holds besides the write model is read for names too:
   * a document refused, a kind set aside, a namesake in another namespace —
   * every document's environment, never the last file's.
   */
  describe('against every document the repository holds', () => {
    const header = (kind: string, name: string, extra: readonly string[] = []): string[] => [
      'apiVersion: backstage.io/v1alpha1',
      `kind: ${kind}`,
      'metadata:',
      `  name: ${name}`,
      ...extra,
      '  annotations:',
      '    company.fr/env: dev',
    ]

    it.each([
      [
        'a refused document',
        'components/orders-db-prod.yml',
        // No owner: the schema refuses it, and its name is still in the request.
        document([...header('Component', 'orders-db-prod'), 'spec:', '  type: service']),
      ],
      [
        'a System set aside',
        'systems/orders-db-prod.yml',
        document([...header('System', 'orders-db-prod'), 'spec:', '  owner: group:default/tiger']),
      ],
      [
        'a namesake in another namespace, read first',
        'catalog/databases/a-orders-db-prod.yml',
        document([
          ...header('Resource', 'orders-db-prod', ['  namespace: legacy']),
          'spec:',
          '  type: database',
          '  owner: group:default/tiger',
        ]),
      ],
      [
        'a refused document whose name cannot be read',
        'components/broken.yml',
        '---\napiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: [\n',
      ],
    ])('asks the owner’s phrase when the repository holds %s', async (_what, relative, text) => {
      const repo = await repository()
      await mkdir(path.dirname(path.join(repo, ...relative.split('/'))), { recursive: true })
      await writeFile(path.join(repo, ...relative.split('/')), text, 'utf8')
      const before = await hashTree(repo)
      const { ask, asked } = answering(undefined)

      const result = await runPlan({
        from: await planFile(repo, { intent: OWNER, operations: [joining(PROD_GRANT)] }),
        repo,
        ask,
      })

      expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual(['prod'])
      expect(result.found).toBe(false)
      expect(result.text).not.toMatch(/^\+\+\+ /m)
      expect(await hashTree(repo)).toBe(before)
    })
  })

  it('asks a request whose "non\u00ADprod" shows no hyphen, end to end', async () => {
    // It named prod once — the soft hyphen was a boundary — and the prod
    // grant then passed as the environment asked for.
    const repo = await repository()
    const intent = 'give billing-api read access to orders-db in non\u00ADprod'
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual(['prod'])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })

  it.each([
    ['a space', 'give billing-api read access to orders-db, not prod'],
    ['a space, in French', 'donne à billing-api un accès en lecture à orders-db hors prod'],
    ['an en dash', 'donne à billing-api un accès en lecture à orders-db en non–prod'],
    ['a pointing beside it', `${OWNER}, pas en prod`],
  ])('asks a request negating prod with %s, end to end', async (_how, intent) => {
    // Each named prod as a whole word, and the prod grant passed as the
    // environment asked for. A word states none now, negated or not, and a
    // negation anywhere withdraws the pointing (`negates`).
    const repo = await repository()
    const before = await hashTree(repo)
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual(['prod'])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
    expect(await hashTree(repo)).toBe(before)
  })
})

/**
 * A name two entities carry. "give billing-api read access to shared" names
 * component:default/shared, declared dev, and resource:default/shared,
 * declared prod, alike: a bare name is not a reference, and resolving it to
 * the one the draft's grant is over was the model's choice of environment
 * passed off as the person's — whichever grant the draft joined, the
 * environment counted as stated. A bare name never points, and a name two
 * environments declare is asked even written in full.
 */
describe('a request naming things in more than one environment', () => {
  const SHARED_DEV = 'resource:default/g-shared-dev'
  const SHARED_PROD = 'resource:default/g-shared-prod'

  const shared = (kind: 'Component' | 'API'): string =>
    document([
      'apiVersion: backstage.io/v1alpha1',
      `kind: ${kind}`,
      'metadata:',
      '  name: shared',
      '  annotations:',
      '    company.fr/env: dev',
      'spec:',
      ...(kind === 'API'
        ? ['  type: openapi', '  lifecycle: production', '  owner: group:default/tiger', '  definition: openapi 3.1']
        : ['  type: service', '  lifecycle: production', '  owner: group:default/tiger']),
    ])

  const sharedDatabase = document([
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: shared',
    '  annotations:',
    '    company.fr/env: prod',
    'spec:',
    '  type: database',
    '  owner: group:default/tiger',
  ])

  const sharedGrant = (env: string, over: string): string =>
    document([
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      `  name: g-shared-${env}`,
      '  annotations:',
      `    company.fr/env: ${env}`,
      'spec:',
      '  type: database-access',
      '  access: read',
      '  owner: group:default/tiger',
      '  dependsOn:',
      `    - ${over}`,
      '  dependencyOf:',
      '    - component:default/orders-api',
    ])

  /** The owner's repository, and a namesake of kind `kind` beside the shared database. */
  const namesakes = async (kind: 'Component' | 'API'): Promise<string> => {
    const repo = await repository()
    const namesake = kind === 'API' ? 'api:default/shared' : 'component:default/shared'
    const files: Record<string, string> = {
      [kind === 'API' ? 'catalog/apis/shared.yml' : 'components/shared.yml']: shared(kind),
      'catalog/databases/shared.yml': sharedDatabase,
      'dependencies/access/g-shared-dev.yml': sharedGrant('dev', namesake),
      'dependencies/access/g-shared-prod.yml': sharedGrant('prod', 'resource:default/shared'),
    }
    for (const [relative, text] of Object.entries(files)) {
      const absolute = path.join(repo, ...relative.split('/'))
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, text, 'utf8')
    }
    return repo
  }

  it.each([
    ['a Component', SHARED_PROD, 'shared', 'Component', 'prod'],
    ['a Component', SHARED_DEV, 'shared', 'Component', 'dev'],
    ['an API', SHARED_PROD, 'shared', 'API', 'prod'],
    ['an API', SHARED_DEV, 'shared', 'API', 'dev'],
    ['a Component', SHARED_PROD, 'resource:default/shared', 'Component', 'prod'],
    ['a Component', SHARED_DEV, 'component:default/shared', 'Component', 'dev'],
    ['an API', SHARED_PROD, 'resource:default/shared', 'API', 'prod'],
    ['an API', SHARED_DEV, 'api:default/shared', 'API', 'dev'],
  ] as const)(
    'asks the environment of a name %s shares with a database, joined to %s, named %s',
    async (_what, grantRef, named, kind, env) => {
      const repo = await namesakes(kind)
      const before = await hashTree(repo)
      const intent = `give billing-api read access to ${named}`
      const { ask, asked } = answering(undefined)

      const result = await runPlan({
        from: await planFile(repo, { intent, operations: [joining(grantRef)] }),
        repo,
        ask,
      })

      expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual([env])
      expect(result.found).toBe(false)
      expect(result.text).not.toMatch(/^\+\+\+ /m)
      expect(await hashTree(repo)).toBe(before)
    },
  )

  it('asks the environment when the request names the dev database and not the prod one', async () => {
    const repo = await repository()
    const intent = 'give billing-api read access to orders-db-dev, not orders-db-prod'
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual(['prod'])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })

  it('still ends a full reference to a name the repository holds once on the diff', async () => {
    const repo = await namesakes('Component')
    const intent =
      'give component:default/billing-api read access to resource:default/orders-db-prod'
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked)).toEqual([])
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/orders-api-orders-db-prod.yml')
  })
})

describe('the answer follows its access', () => {
  it('is recorded by the access, the consumer and the thing its grant is over', () => {
    const plan = parsed(UNSCOPED, [joining(PROD_GRANT)])

    expect(recordAnswers(plan, [{ path: ENVIRONMENT, value: 'prod' }], OVER)).toEqual([
      {
        path: ENVIRONMENT,
        value: 'prod',
        about: { entity: PROD_GRANT, field: 'environment', consumer: BILLING },
        environmentOf: { consumer: BILLING, resource: 'resource:default/orders-db-prod' },
      },
    ])
  })

  it('vouches for the same update where a redraft moved it', () => {
    const typed = parsed(UNSCOPED, [joining(PROD_GRANT)])
    const recorded = recordAnswers(typed, [{ path: ENVIRONMENT, value: 'prod' }], OVER)
    const redraft = parsed(UNSCOPED, [
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: { name: 'orders-db-staging', env: 'staging' },
          spec: { type: 'database', owner: 'group:default/tiger' },
        },
      },
      joining(PROD_GRANT),
    ])

    const reapplied = reapplyAnswers(redraft, recorded, OVER)

    expect(reapplied.answers.get('operations.1.environment')).toBe('prod')
    expect(reapplied.answers.has(ENVIRONMENT)).toBe(false)
    expect(reapplied.plan).toEqual(redraft)
  })

  it('follows a redraft that declares a grant of its own for the same access', () => {
    const typed = parsed(UNSCOPED, [joining(PROD_GRANT)])
    const recorded = recordAnswers(typed, [{ path: ENVIRONMENT, value: 'prod' }], OVER)
    const own = parsed(UNSCOPED, [
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: { name: 'billing-api-orders-db-prod', env: { unknown: 'which?' } },
          spec: {
            type: 'database-access',
            access: 'read',
            owner: 'group:default/tiger',
            dependsOn: ['resource:default/orders-db-prod'],
            dependencyOf: [BILLING],
          },
        },
      },
    ])

    const reapplied = reapplyAnswers(own, recorded, OVER)

    const operation = reapplied.plan.operations[0]
    expect(operation?.op === 'create-entity' && operation.entity.kind === 'Resource'
      ? operation.entity.metadata.env
      : undefined).toBe('prod')
    expect(reapplied.answers.get('operations.0.entity.metadata.env')).toBe('prod')
  })

  it('and the other way: an environment answered for a new grant vouches for the update', () => {
    const own = parsed(UNSCOPED, [
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
          spec: {
            type: 'database-access',
            access: 'read',
            owner: 'group:default/tiger',
            dependsOn: ['resource:default/orders-db-prod'],
            dependencyOf: [BILLING],
          },
        },
      },
    ])
    const recorded = recordAnswers(
      own,
      [{ path: 'operations.0.entity.metadata.env', value: 'prod' }],
      OVER,
    )

    const reapplied = reapplyAnswers(parsed(UNSCOPED, [joining(PROD_GRANT)]), recorded, OVER)

    expect(reapplied.answers.get(ENVIRONMENT)).toBe('prod')
  })

  it('is asked again for another consumer joined to the same grant', () => {
    const typed = parsed(UNSCOPED, [joining(PROD_GRANT)])
    const recorded = recordAnswers(typed, [{ path: ENVIRONMENT, value: 'prod' }], OVER)
    const other = parsed(UNSCOPED, [joining(PROD_GRANT, 'component:default/payments-api')])

    expect(reapplyAnswers(other, recorded, OVER).answers.size).toBe(0)
  })
})

describe('plan --from: the environment of the grant it extends', () => {
  const PLAN = { intent: UNSCOPED, operations: [joining(PROD_GRANT)] }

  it('ends on the question with nobody to ask, showing the grant and the environments', async () => {
    const repo = await repository()
    const before = await hashTree(repo)

    const result = await runPlan({ from: await planFile(repo, PLAN), repo })

    expect(result.found).toBe(false)
    expect(result.unsupported).toBe(true)
    expect(result.text).toContain(`  ${ENVIRONMENT}\n`)
    expect(result.text).toContain(
      `the draft joins ${BILLING} to ${PROD_GRANT}, which is declared prod`,
    )
    expect(result.text).toContain('the draft says prod · in use: dev, prod')
    expect(await hashTree(repo)).toBe(before)
  })

  it('asks it once and ends on the diff when the answer is the grant’s environment', async () => {
    const repo = await repository()
    const before = await hashTree(repo)
    const { ask, asked } = answering('prod')

    const result = await runPlan({ from: await planFile(repo, PLAN), repo, ask })

    expect(environmentQuestions(asked)).toHaveLength(1)
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/orders-api-orders-db-prod.yml')
    expect(result.text).toContain(`+    - ${BILLING}`)
    expect(await hashTree(repo)).toBe(before)
  })

  it('refuses another environment, naming the grant of that one as the remedy', async () => {
    const repo = await repository()
    const before = await hashTree(repo)
    const { ask } = answering('dev')

    const result = await runPlan({ from: await planFile(repo, PLAN), repo, ask })

    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
    expect(result.text).toContain('policy  environment-mismatch at operations.0.entityRef')
    expect(result.text).toContain(
      `${PROD_GRANT} is declared prod, and dev was answered at ${ENVIRONMENT} for ` +
        `${BILLING}'s access. An environment is never inferred, and a grant is never ` +
        `retargeted for you: join ${BILLING} to ${DEV_GRANT} — declared dev, held by the ` +
        'same consumers as this one, and over resource:default/orders-db-dev — if that is ' +
        `what was asked, or declare a separate grant in dev for ${BILLING}, instead of ` +
        'joining this one.',
    )
    expect(await hashTree(repo)).toBe(before)
  })

  it('names a separate grant when the repository holds none in that environment', async () => {
    const repo = await repository({ dev: false })
    const { ask } = answering('dev')

    const result = await runPlan({ from: await planFile(repo, PLAN), repo, ask })

    expect(result.found).toBe(false)
    expect(result.text).toContain(
      `declare a separate grant in dev for ${BILLING} instead of joining this one.`,
    )
  })

  it('refuses an environment the repository has never used just the same', async () => {
    const repo = await repository()
    const { ask } = answering('qa')

    const result = await runPlan({ from: await planFile(repo, PLAN), repo, ask })

    expect(result.found).toBe(false)
    expect(result.text).toContain(`${PROD_GRANT} is declared prod, and qa was answered`)
  })
})

describe('plan "<intent>": the environment of the grant it extends', () => {
  const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
    const events: AgentEvent[] = []
    return { events, emit: (event) => void events.push(event) }
  }

  it('asks, carries the answer into the next round, and ends on the diff', async () => {
    const repo = await repository()
    const before = await hashTree(repo)
    const client = scripted({
      architect: [
        ...reading(PROD_GRANT, BILLING),
        turnCalling(PROPOSE_TOOL, { operations: [joining(PROD_GRANT)] }),
      ],
      reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })
    const { ask, asked } = answering('prod')

    const result = await runIntent({
      intent: UNSCOPED,
      repo,
      project: undefined,
      client,
      emit: collect().emit,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual(['prod'])
    expect(result.found).toBe(true)
    expect(result.text).toContain(`+    - ${BILLING}`)
    // The filled plan seeds the next round: no second draft, one review.
    const drafts = client.seen.filter((request) => request.agent === 'architect')
    expect(new Set(drafts.map(openingOf)).size).toBe(1)
    expect(drafts).toHaveLength(3)
    expect(client.seen.filter((request) => request.agent === 'reviewer')).toHaveLength(1)
    expect(await hashTree(repo)).toBe(before)
  })

  it('hands a mismatching answer to the Architect with the remedy, never retargeting', async () => {
    const repo = await repository()
    const before = await hashTree(repo)
    const client = scripted({
      architect: [
        ...reading(PROD_GRANT, BILLING),
        turnCalling(PROPOSE_TOOL, { operations: [joining(PROD_GRANT)] }),
        ...reading(DEV_GRANT),
        turnCalling(PROPOSE_TOOL, { operations: [joining(DEV_GRANT)] }),
      ],
      reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })
    const { ask, asked } = answering('dev')

    const result = await runIntent({
      intent: UNSCOPED,
      repo,
      project: undefined,
      client,
      emit: collect().emit,
      ask,
    })

    const drafts = client.seen.filter((request) => request.agent === 'architect')
    // A draft is one opening message and its turns; the redraft's is the one
    // carrying the report.
    const openings = [...new Set(drafts.map(openingOf))]
    expect(openings).toHaveLength(2)
    expect(openings[1]).toContain(`join ${BILLING} to ${DEV_GRANT} — declared dev`)
    // The answer is about billing-api's access to orders-db-prod, and the
    // redraft reaches orders-db-dev: another access, so its environment is
    // asked again — the safe direction — naming the grant the redraft chose.
    expect(environmentQuestions(asked).map((question) => question.proposed)).toEqual([
      'prod',
      'dev',
    ])
    expect(environmentQuestions(asked)[1]?.question).toContain(DEV_GRANT)
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/orders-api-orders-db-dev.yml')
    expect(await hashTree(repo)).toBe(before)
  })
})

describe('idpa "<phrase>", end to end', () => {
  it('asks the environment of the grant a request naming none would extend', async () => {
    const repo = await repository()
    const before = await hashTree(repo)
    const client = scripted({
      supervisor: [saying('MUTATION')],
      architect: [
        ...reading(PROD_GRANT, BILLING),
        turnCalling(PROPOSE_TOOL, { operations: [joining(PROD_GRANT)] }),
      ],
    })
    const out: string[] = []
    const err: string[] = []

    const code = await main([UNSCOPED], {
      client,
      cwd: await temp(),
      env: { IDP_REPO: repo },
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
    })

    expect(code).toBe(3)
    expect(out.join('')).toContain(`  ${ENVIRONMENT}\n`)
    expect(out.join('')).toContain('the draft says prod · in use: dev, prod')
    expect(client.seen.map((request) => request.agent)).not.toContain('reviewer')
    expect(await hashTree(repo)).toBe(before)
  })
})

/**
 * An answer about an update's environment has no value in the plan to check
 * it against — the operation has no such field — so where it is held by its
 * path alone, the path must still hold the update it was typed for. Two
 * consumers joined to one grant is the natural draft for "give billing-api and
 * reporting read access to orders-db", and the grant, amended twice, holds
 * neither answer: each is carried by its access. Kept at its path as well, the
 * answer vouched for whichever grant a redraft put at that index.
 */
describe('an answer typed where one grant is amended twice', () => {
  const USERS_GRANT = 'resource:default/orders-api-users-db-prod'
  const WIDE_GRANT = 'resource:default/orders-api-everything-prod'
  const REPORTING = 'component:default/reporting'
  const PAYMENTS = 'component:default/payments-api'
  const TWO = 'give billing-api and reporting read access to orders-db'
  const over = new Map([
    ...OVER,
    [USERS_GRANT, ['resource:default/users-db-prod']],
    [WIDE_GRANT, ['resource:default/orders-db-prod', 'resource:default/users-db-prod']],
  ])
  const context = (answers: ReadonlyMap<string, string>) => ({
    environments: ['dev', 'prod'],
    declared: new Map([...DECLARED, [USERS_GRANT, 'prod'], [WIDE_GRANT, 'prod']]),
    natures: new Map<string, Nature>([
      ...NATURES,
      [USERS_GRANT, 'right'],
      [WIDE_GRANT, 'right'],
    ]),
    over,
    provenance: { ...userSaid(TWO), answers },
  })
  const both = [
    { path: 'operations.0.environment', value: 'prod' },
    { path: 'operations.1.environment', value: 'prod' },
  ]

  it('never vouches for the grant a redraft puts at its path', () => {
    const typed = parsed(TWO, [joining(PROD_GRANT), joining(PROD_GRANT, REPORTING)])
    const recorded = recordAnswers(typed, both, over)
    expect(recorded[0]).toEqual({
      path: 'operations.0.environment',
      value: 'prod',
      environmentOf: { consumer: BILLING, resource: 'resource:default/orders-db-prod' },
    })

    const redraft = parsed(TWO, [joining(USERS_GRANT, PAYMENTS)])
    const reapplied = reapplyAnswers(redraft, recorded, over)

    expect(reapplied.answers.size).toBe(0)
    expect(questionsOf(reapplied.plan, context(reapplied.answers)).map((q) => q.path)).toEqual([
      ENVIRONMENT,
    ])
  })

  it('still vouches for both on the plan they were typed into', () => {
    const typed = parsed(TWO, [joining(PROD_GRANT), joining(PROD_GRANT, REPORTING)])
    const reapplied = reapplyAnswers(typed, recordAnswers(typed, both, over), over)

    expect([...reapplied.answers]).toEqual([
      ['operations.0.environment', 'prod'],
      ['operations.1.environment', 'prod'],
    ])
    expect(questionsOf(typed, context(reapplied.answers))).toEqual([])
  })

  it('held by its path alone, vouches only where it joins that consumer to that grant', () => {
    // A grant over two things states no one access, and amended twice it
    // holds no answer either: the path is all there is to keep it by.
    const typed = parsed(TWO, [joining(WIDE_GRANT), joining(WIDE_GRANT, REPORTING)])
    const recorded = recordAnswers(typed, both, over)
    expect(recorded.every((one) => one.about === undefined && one.environmentOf === undefined))
      .toBe(true)

    expect(reapplyAnswers(typed, recorded, over).answers.size).toBe(2)
    const redraft = parsed(TWO, [joining(USERS_GRANT, PAYMENTS), joining(WIDE_GRANT, PAYMENTS)])
    expect(reapplyAnswers(redraft, recorded, over).answers.size).toBe(0)
  })

  it('asks the redraft’s grants again, end to end', async () => {
    const repo = await repository()
    const extra: Record<string, string> = {
      'components/reporting.yml': component('reporting'),
      'components/payments-api.yml': component('payments-api'),
      'catalog/databases/users-db-prod.yml': database('prod').replaceAll('orders-db', 'users-db'),
      'dependencies/access/orders-api-users-db-prod.yml': grant('prod').replaceAll(
        'orders-db',
        'users-db',
      ),
    }
    for (const [relative, text] of Object.entries(extra)) {
      await writeFile(path.join(repo, ...relative.split('/')), text, 'utf8')
    }
    const before = await hashTree(repo)
    const rejected = turnCalling(VERDICT_TOOL, { verdict: 'reject', reason: 'not what was asked' })
    const client = scripted({
      architect: [
        ...reading(PROD_GRANT, BILLING, REPORTING),
        turnCalling(PROPOSE_TOOL, {
          operations: [joining(PROD_GRANT), joining(PROD_GRANT, REPORTING)],
        }),
        ...reading(USERS_GRANT, PAYMENTS),
        turnCalling(PROPOSE_TOOL, {
          operations: [joining(USERS_GRANT, PAYMENTS), joining(USERS_GRANT)],
        }),
      ],
      reviewer: [rejected, turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })
    const { ask, asked } = answering('prod')

    await runIntent({ intent: TWO, repo, project: undefined, client, emit: () => {}, ask })

    const questions = environmentQuestions(asked).map((question) => question.question)
    expect(questions.filter((question) => question.includes(PROD_GRANT))).toHaveLength(2)
    expect(questions.filter((question) => question.includes(USERS_GRANT))).toHaveLength(2)
    expect(await hashTree(repo)).toBe(before)
  })
})

/**
 * A grant that declares no environment still hands one out: the environment
 * of what it reaches, which the repository declares. Joining a consumer to it
 * is asked like any other update, and the answer is held to what it reaches.
 */
describe('a grant that declares no environment', () => {
  const LEGACY = 'resource:default/legacy-orders-grant'
  const legacy = document([
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: legacy-orders-grant',
    'spec:',
    '  type: database-access',
    '  access: read',
    '  owner: group:default/tiger',
    '  dependsOn:',
    '    - resource:default/orders-db-prod',
    '  dependencyOf:',
    '    - component:default/orders-api',
  ])
  const withLegacy = async (): Promise<string> => {
    const repo = await repository()
    await writeFile(
      path.join(repo, 'dependencies', 'access', 'legacy-orders-grant.yml'),
      legacy,
      'utf8',
    )
    return repo
  }
  const PLAN = { intent: UNSCOPED, operations: [joining(LEGACY)] }

  it('is asked about, naming what it reaches and that thing’s environment', async () => {
    const repo = await withLegacy()

    const result = await runPlan({ from: await planFile(repo, PLAN), repo })

    expect(result.found).toBe(false)
    expect(result.text).toContain(`  ${ENVIRONMENT}\n`)
    expect(result.text).toContain(
      `the draft joins ${BILLING} to ${LEGACY}, which declares no environment and is over ` +
        'resource:default/orders-db-prod, declared prod',
    )
    expect(result.text).toContain('the draft says prod · in use: dev, prod')
  })

  it('ends on the diff when the answer is the environment of what it reaches', async () => {
    const repo = await withLegacy()
    const { ask, asked } = answering('prod')

    const result = await runPlan({ from: await planFile(repo, PLAN), repo, ask })

    expect(environmentQuestions(asked)).toHaveLength(1)
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/dependencies/access/legacy-orders-grant.yml')
  })

  it('refuses another environment, with the grant of that one as the remedy', async () => {
    const repo = await withLegacy()
    const { ask } = answering('dev')

    const result = await runPlan({ from: await planFile(repo, PLAN), repo, ask })

    expect(result.found).toBe(false)
    expect(result.text).toContain('policy  environment-mismatch at operations.0.entityRef')
    expect(result.text).toContain(
      `${LEGACY} declares no environment and is over resource:default/orders-db-prod, ` +
        `declared prod, and dev was answered at ${ENVIRONMENT}`,
    )
    expect(result.text).toContain(`join ${BILLING} to ${DEV_GRANT}`)
  })

  it('asks a request naming another environment than the one it reaches, in words', async () => {
    const repo = await withLegacy()
    const intent = 'give billing-api read access to orders-db in dev'
    const { ask, asked } = answering(undefined)

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [joining(LEGACY)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.path)).toEqual([ENVIRONMENT])
    expect(result.found).toBe(false)
    expect(result.text).not.toMatch(/^\+\+\+ /m)
  })
})

/**
 * A request naming an environment in words has stated nothing — the owner's
 * decision of 2026-09-27, as a level word states nothing. It used to be what
 * `environment-mismatch` refused the grant against, until "not prod" and
 * "prodではなく" each named prod. So it is asked, and the answer is what the
 * grant is held to: the person answering the word they wrote is refused
 * against the grant exactly as the word used to be.
 */
describe('a request naming another environment than the grant’s', () => {
  const intent = 'give billing-api read access to orders-db in dev'

  it('is asked, and the grant is refused against the answer', async () => {
    const repo = await repository()
    const { ask, asked } = answering('dev')

    const result = await runPlan({
      from: await planFile(repo, { intent, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(environmentQuestions(asked).map((question) => question.path)).toEqual([ENVIRONMENT])
    expect(result.found).toBe(false)
    expect(result.text).toContain('policy  environment-mismatch at operations.0.entityRef')
    expect(result.text).toContain(`dev was answered at ${ENVIRONMENT}`)
    expect(result.text).not.toContain('the request named dev')
  })

  it('is asked by the question function too', () => {
    const plan = parsed(intent, [joining(PROD_GRANT)])
    expect(
      questionsOf(plan, {
        environments: ['dev', 'prod'],
        declared: DECLARED,
        natures: NATURES,
        namesakes: KNOWN,
        over: OVER,
        provenance: userSaid(intent),
      }).map((question) => question.path),
    ).toEqual([ENVIRONMENT])
  })
})

/**
 * The grant of the answered environment is found by who holds it, never by a
 * name — so it can be over another thing than the one asked about. The remedy
 * says what it is over, and offers a separate grant beside it.
 */
describe('the remedy for an answered environment', () => {
  it('says what the grant of that environment is over, and offers a separate grant', async () => {
    const repo = await repository({ dev: false })
    const usersDev = grant('dev').replaceAll('orders-db', 'users-db')
    await writeFile(
      path.join(repo, 'dependencies', 'access', 'orders-api-users-db-dev.yml'),
      usersDev,
      'utf8',
    )
    await writeFile(
      path.join(repo, 'catalog', 'databases', 'users-db-dev.yml'),
      database('dev').replaceAll('orders-db', 'users-db'),
      'utf8',
    )
    const { ask } = answering('dev')

    const result = await runPlan({
      from: await planFile(repo, { intent: UNSCOPED, operations: [joining(PROD_GRANT)] }),
      repo,
      ask,
    })

    expect(result.found).toBe(false)
    expect(result.text).toContain(
      `join ${BILLING} to resource:default/orders-api-users-db-dev — declared dev, held by ` +
        'the same consumers as this one, and over resource:default/users-db-dev — if that ' +
        `is what was asked, or declare a separate grant in dev for ${BILLING}`,
    )
  })
})

/**
 * An update's environment is asked at a path the plan has no field for, so
 * "fill them in" cannot be followed for it: `update-entity` is a strict
 * object, and an `environment` written into it is refused at the schema.
 * And no word of the request states one. With nobody to ask, the way to
 * settle it is the request naming what the grant is over by its reference in
 * full, or a terminal.
 */
describe('an update’s environment, with nobody to ask', () => {
  it('says how to answer it, since the plan has no field to fill', async () => {
    const repo = await repository()

    const result = await runPlan({
      from: await planFile(repo, { intent: UNSCOPED, operations: [joining(PROD_GRANT)] }),
      repo,
    })

    expect(result.text).toContain(
      `${ENVIRONMENT} is not a field of the plan: name what the grant is over by its ` +
        'reference in full in the request — a plan’s intent — or run this at a terminal to ' +
        'be asked.',
    )
    expect(result.text).not.toContain('Fill them in')
    expect(result.text).toMatch(/Nothing was previewed, and nothing was written\.$/)
  })

  it('still says to fill in the questions the plan does hold', async () => {
    const repo = await repository()
    const open = {
      ...joining(PROD_GRANT),
      patch: {
        patch: 'add-dependency-of',
        consumer: BILLING,
        access: { unknown: 'which?' },
      },
    }

    const result = await runPlan({
      from: await planFile(repo, { intent: UNSCOPED, operations: [open] }),
      repo,
    })

    expect(result.text).toContain('  operations.0.patch.access\n')
    expect(result.text).toContain(`${ENVIRONMENT} is not a field of the plan`)
    expect(result.text).toContain(
      'Fill in the rest and run this again. Nothing was previewed, and nothing was written.',
    )
  })
})
