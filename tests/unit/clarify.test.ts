import { describe, expect, it } from 'vitest'
import { answer, questionsOf, AnswerError } from '../../src/core/plan/clarify.js'
import { findUnknowns, planSchema } from '../../src/core/schemas/plan.js'
import type { Plan } from '../../src/core/schemas/plan.js'

const asking = (): Plan =>
  planSchema.parse({
    intent: 'give billing-api read access to orders-db',
    operations: [
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: {
            name: 'billing-api-orders-db-prod',
            env: { unknown: 'nothing vouches for this env; which one is it?' },
          },
          spec: {
            type: 'database-access', access: 'read',
            owner: { unknown: 'nothing vouches for this owner; which one is it?' },
            dependsOn: ['resource:default/orders-db-prod'],
            dependencyOf: ['component:default/billing-api'],
          },
        },
      },
    ],
  })

describe('questionsOf', () => {
  it('turns each unknown into a question carrying its dotted path', () => {
    const questions = questionsOf(asking())

    expect(questions.map((question) => question.path).sort()).toEqual([
      'operations.0.entity.metadata.env',
      'operations.0.entity.spec.owner',
    ])
    expect(questions[0]?.question).toMatch(/which one/)
  })

  it('returns nothing for a plan that carries no question', () => {
    const settled = planSchema.parse({
      intent: 'give billing-api read access to orders-db in prod',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
            spec: {
              type: 'database-access', access: 'read', owner: 'group:default/tiger',
              dependsOn: ['resource:default/orders-db-prod'], dependencyOf: ['component:default/billing-api'],
            },
          },
        },
      ],
    })

    expect(questionsOf(settled)).toEqual([])
  })
})

describe('answer', () => {
  it('fills the named leaf and leaves the others untouched', () => {
    const filled = answer(asking(), 'operations.0.entity.spec.owner', 'group:default/tiger')

    expect(findUnknowns(filled)).toEqual(['operations.0.entity.metadata.env'])
  })

  it('returns a new plan rather than editing the one it was given', () => {
    // A caller holding the unanswered plan — the CLI printing it while asking —
    // must not watch it change under them.
    const before = asking()
    const snapshot = JSON.stringify(before)

    answer(before, 'operations.0.entity.spec.owner', 'group:default/tiger')

    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('refuses an answer aimed at a path that is not a question', () => {
    // Silently ignoring it would let a caller believe a field was set. Worse,
    // an answer aimed at a settled field is how a value the engine vouched for
    // would get overwritten by one nobody did.
    expect(() =>
      answer(asking(), 'operations.0.entity.metadata.name', 'billing-api-backdoor-prod'),
    ).toThrow(AnswerError)
  })

  it('refuses an answer aimed at a path that does not exist', () => {
    expect(() => answer(asking(), 'operations.7.entity.spec.owner', 'group:default/tiger')).toThrow(
      AnswerError,
    )
  })

  it('names the path it refused, so the caller can say which one', () => {
    expect(() => answer(asking(), 'operations.0.entity.metadata.name', 'x')).toThrow(
      /operations\.0\.entity\.metadata\.name/,
    )
  })

  it('answers every question when asked one at a time', () => {
    let plan = asking()
    for (const question of questionsOf(plan)) {
      plan = answer(plan, question.path, question.path.endsWith('.env') ? 'prod' : 'group:default/tiger')
    }

    expect(findUnknowns(plan)).toEqual([])
  })
})

/**
 * What a question tells the person, beyond the reason: the value the draft had
 * put there, and what the field accepts. The owner's run asked "nothing
 * vouches for this access; which one is it?" and left them to guess that
 * `read` and `readwrite` were the words it would take.
 */
describe('what a question says it accepts', () => {
  const ACCESS_PATH = 'operations.0.patch.access'
  const ENV_PATH = 'operations.0.entity.metadata.env'
  const ASKED = 'nothing vouches for this access; which one is it?'
  const GRANT = 'resource:default/orders-api-orders-db-prod'
  /** The levelled grants the repository declares, and what each is over. */
  const OVER = new Map([[GRANT, ['resource:default/orders-db-prod']]])

  const joining = (access: unknown, entityRef = GRANT): Plan =>
    planSchema.parse({
      intent: 'donne à billing-api un accès en lecture à orders-db en prod',
      operations: [
        {
          op: 'update-entity',
          entityRef,
          patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api', access },
        },
      ],
    })

  it('names the value the draft proposed, and the levels a grant can state', () => {
    const questions = questionsOf(joining({ unknown: ASKED }), {
      draft: joining('readwrite'),
      environments: ['dev', 'prod'],
      over: OVER,
    })

    expect(questions).toEqual([
      {
        path: ACCESS_PATH,
        question: ASKED,
        proposed: 'readwrite',
        accepted: ['read', 'readwrite'],
      },
    ])
  })

  it('proposes nothing when the draft itself asked', () => {
    const own = { unknown: 'the request does not say which level' }
    const [question] = questionsOf(joining(own), { draft: joining(own), over: OVER })

    expect(question?.proposed).toBeUndefined()
    expect(question?.accepted).toEqual(['read', 'readwrite'])
    // The reason is the model's, and it is handed back byte for byte.
    expect(question?.question).toBe('the request does not say which level')
  })

  it("shows an environment's values in use without closing the set", () => {
    // `prod` always exists, and a first `qa` is a legitimate answer: the set
    // is the repository's so far, shown and never enforced.
    const question = questionsOf(asking(), { draft: asking(), environments: ['dev', 'prod'] }).find(
      (one) => one.path === ENV_PATH,
    )

    expect(question?.inUse).toEqual(['dev', 'prod'])
    expect(question?.accepted).toBeUndefined()
  })

  it("knows a creation's levels from its type, and adds nothing it has no facts for", () => {
    const declaring = (access: unknown, type = 'database-access'): Plan =>
      planSchema.parse({
        ...asking(),
        operations: [
          {
            op: 'create-entity',
            entity: {
              kind: 'Resource',
              metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
              spec: {
                type,
                access,
                owner: 'group:default/tiger',
                dependsOn: ['resource:default/orders-db-prod'],
                dependencyOf: ['component:default/billing-api'],
              },
            },
          },
        ],
      })

    expect(questionsOf(declaring({ unknown: ASKED }))).toEqual([
      { path: 'operations.0.entity.spec.access', question: ASKED, accepted: ['read', 'readwrite'] },
    ])
    expect(Object.keys(questionsOf(asking())[0] ?? {})).toEqual(['path', 'question'])
  })

  it('closes no set on the level of a grant not known to state one', () => {
    // An update names its grant, and whether that grant has a level is the
    // repository's to say (`over` holds the ones that do). A network flow has
    // none: offering "read, readwrite" there, and refusing anything else,
    // would leave the person no way to say so. Asked, and left open.
    const network = 'resource:default/billing-api-to-orders-db-prod'
    const [unknownGrant] = questionsOf(joining({ unknown: ASKED }, network), { over: OVER })
    const [noContext] = questionsOf(joining({ unknown: ASKED }))

    expect(unknownGrant).toEqual({ path: ACCESS_PATH, question: ASKED })
    expect(noContext).toEqual({ path: ACCESS_PATH, question: ASKED })
  })
})
