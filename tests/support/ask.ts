import type { Question } from '../../src/core/plan/clarify.js'

/**
 * Is this the question of an environment — a creation's `metadata.env`, or
 * the environment an update hands its grant out in?
 */
export const asksEnvironment = (question: Question): boolean =>
  question.path.endsWith('.metadata.env') || question.path.endsWith('.environment')

/**
 * The environment the draft proposed, confirmed, as a person at the prompt
 * does; undefined for any other question, and when the draft proposed none.
 *
 * An environment is never read out of a request's words (the owner's decision
 * of 2026-09-27), as a level is not: unless the request points at what an
 * access is over by its reference in full, it is asked. So a fixture that
 * wants a diff answers it — which is what a run does — and a fixture about
 * any other question still declines that one.
 */
export const confirmingEnvironment = (question: Question): string | undefined =>
  asksEnvironment(question) ? question.proposed : undefined
