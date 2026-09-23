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
            spec: { type: 'database-access', access: 'read', owner: 'group:default/tiger' },
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
