import { z } from 'zod'

/**
 * The fields this build reads of each GitHub answer (stage 6 brief § 6, § 8):
 * one schema per route, holding exactly what a decision needs. Loose on
 * purpose — GitHub adds fields, and a field nobody reads is no reason to
 * refuse an answer — and never passed on: what the forge keeps of an answer
 * is what these name, and nothing of it is printed without its own grammar.
 */

/** `GET user`: who gh acts as. `type` is `User` for a person; a `Bot`, or anything else, is not one. */
export const userAnswer = z.looseObject({ login: z.string(), type: z.string() })

export type UserAnswer = z.infer<typeof userAnswer>
