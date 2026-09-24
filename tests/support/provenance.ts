import type { Provenance } from '../../src/core/plan/provenance.js'
import type { Plan } from '../../src/core/schemas/plan.js'

/**
 * What a person stated: their request, and what they typed at a prompt, each
 * answer at the field it answered.
 */
export const userSaid = (intent: string, answers: Record<string, string> = {}): Provenance => ({
  intent,
  wordsOf: 'user',
  answers: new Map(Object.entries(answers)),
})

/**
 * Every field of `plan` that states a grant's level, as the dotted path a
 * question about it carries.
 */
export const levelPaths = (plan: Plan): string[] =>
  plan.operations.flatMap((operation, index) => {
    if (operation.op === 'create-entity' && operation.entity.kind === 'Resource') {
      return operation.entity.spec.access === undefined
        ? []
        : [`operations.${index}.entity.spec.access`]
    }
    if (operation.op === 'update-entity') {
      return operation.patch.access === undefined ? [] : [`operations.${index}.patch.access`]
    }
    return []
  })

/**
 * `level` answered at every level `plan` states.
 *
 * A level is asked and never read out of the request, so a fixture that wants
 * a complete plan answers for it — which is what a run does, one prompt per
 * grant. Answered at each field, never as a value: an answer vouches for the
 * question it answered and nowhere else.
 */
export const levelsAnswered = (plan: Plan, level = 'read'): Record<string, string> =>
  Object.fromEntries(levelPaths(plan).map((path) => [path, level]))

/** The request `plan` carries, with `level` answered at each of its levels. */
export const saidWithLevels = (plan: Plan, level = 'read'): Provenance =>
  userSaid(plan.intent, levelsAnswered(plan, level))
