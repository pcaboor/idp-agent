import type { Plan } from '../schemas/plan.js'
import { findUnknowns } from '../schemas/plan.js'

/**
 * The other half of "declare, never infer": the signature turns a value nobody
 * can vouch for into a question, and this turns that question into something a
 * person can be asked and can answer.
 *
 * It sits on `findUnknowns`, which already walks a Plan iteratively and returns
 * dotted paths in traversal order. Nothing here re-walks — a second traversal
 * would be a second chance to disagree about what a leaf is.
 */

export interface Question {
  /** The dotted path, the same form a policy violation and a refusal carry. */
  readonly path: string
  readonly question: string
}

export class AnswerError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`)
    this.name = 'AnswerError'
  }
}

const isUnknown = (value: unknown): value is { unknown: string } =>
  typeof value === 'object' && value !== null && 'unknown' in value

/** Walks to the parent of a dotted path, or undefined if the path is not there. */
function parentOf(
  plan: Plan,
  path: string,
): { parent: Record<string, unknown>; field: string } | undefined {
  const parts = path.split('.')
  const field = parts.pop()
  if (field === undefined || field === '') return undefined

  let cursor: unknown = plan
  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  if (typeof cursor !== 'object' || cursor === null) return undefined
  return { parent: cursor as Record<string, unknown>, field }
}

export function questionsOf(plan: Plan): Question[] {
  const questions: Question[] = []

  for (const path of findUnknowns(plan)) {
    const found = parentOf(plan, path)
    const value = found?.parent[found.field]
    questions.push({
      path,
      question: isUnknown(value) ? value.unknown : `what should ${path} be?`,
    })
  }

  return questions
}

/**
 * Fills one question. Refuses anything else — including a path that is settled.
 * Silently ignoring an answer would let a caller believe a field was set; worse,
 * an answer aimed at a settled field is how a value the engine vouched for gets
 * overwritten by one nobody did.
 */
export function answer(plan: Plan, path: string, value: string): Plan {
  const clone = structuredClone(plan)
  const found = parentOf(clone, path)
  if (found === undefined) throw new AnswerError(path, 'no such field in this plan')

  const current = found.parent[found.field]
  if (!isUnknown(current)) {
    throw new AnswerError(path, 'this field is not a question; nothing here was asked')
  }

  found.parent[found.field] = value
  return clone
}
