import type { Plan } from '../schemas/plan.js'
import { findUnknowns } from '../schemas/plan.js'
import { ACCESS_LEVELS } from '../schemas/resource-types.js'
import { levelledSiteOf, type GrantedOver } from './grant.js'

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
  /**
   * The reason, as the plan carries it — the model's own `{unknown}`, or the
   * signer's "nothing vouches for this …". Byte for byte: the Reviewer and the
   * repair loop read the same string in the plan, so it is never reworded here.
   */
  readonly question: string
  /**
   * What the draft had put at this path before the signature asked instead —
   * a value nobody could vouch for, shown as the draft's and never as a
   * default. Absent when the draft itself asked.
   */
  readonly proposed?: string
  /**
   * Every value this field accepts, when the set is closed and the engine owns
   * it: the level of a grant whose type states one. An answer outside it is
   * refused at the prompt, before any gate.
   */
  readonly accepted?: readonly string[]
  /**
   * The values the repository already uses here, when the set is open: an
   * environment. Shown and never enforced — `prod` always exists, and the
   * first `qa` is a legitimate answer (§4.1).
   */
  readonly inUse?: readonly string[]
  /**
   * What the person just typed, when it was outside `accepted` and the same
   * question is put to them again. Set by the prompt loop, never by
   * `questionsOf`: a question as the plan asks it has not been answered yet.
   */
  readonly refused?: string
}

/**
 * What the engine knows beyond the plan, for the person answering. Both are
 * optional, and a question with neither is the one the plan alone can state.
 */
export interface QuestionContext {
  /** The plan as it stood before the signature turned values into questions. */
  readonly draft?: Plan
  /** The environments the repository uses — the vocabulary's. */
  readonly environments?: readonly string[]
  /**
   * The levelled grants the repository declares (`GrantedOver`): what says an
   * update's grant states a level at all. Without it an update's level is
   * asked with no set, and nothing is refused at the prompt.
   */
  readonly over?: GrantedOver
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

const OPERATION_PATH = /^operations\.(\d+)\.(.+)$/

/**
 * What the person is told a field takes, by what the field IS — a level is
 * where its operation states the level of a grant that has one
 * (`levelledSiteOf`), an environment is `metadata.env` — and from the engine's
 * own lists, never a literal here.
 *
 * A level by its operation, never by a path ending in `.access`: a network
 * flow has no level, and a set of "read, readwrite" enforced at its prompt
 * would leave the person no way to say so.
 */
function valuesOf(
  plan: Plan,
  path: string,
  context: QuestionContext,
): Pick<Question, 'accepted' | 'inUse'> {
  const match = OPERATION_PATH.exec(path)
  const operation = match === null ? undefined : plan.operations[Number(match[1])]
  const site =
    operation === undefined ? undefined : levelledSiteOf(operation, context.over ?? new Map())
  if (site !== undefined && match?.[2] === site.field) return { accepted: [...ACCESS_LEVELS] }
  if (path.endsWith('.metadata.env') && context.environments !== undefined) {
    return context.environments.length === 0 ? {} : { inUse: [...context.environments] }
  }
  return {}
}

export function questionsOf(plan: Plan, context: QuestionContext = {}): Question[] {
  const questions: Question[] = []

  for (const path of findUnknowns(plan)) {
    const found = parentOf(plan, path)
    const value = found?.parent[found.field]
    const before = context.draft === undefined ? undefined : parentOf(context.draft, path)
    const proposed = before?.parent[before.field]
    questions.push({
      path,
      question: isUnknown(value) ? value.unknown : `what should ${path} be?`,
      ...(typeof proposed === 'string' ? { proposed } : {}),
      ...valuesOf(plan, path, context),
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
