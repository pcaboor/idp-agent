import { z } from 'zod'
import { entityRefSchema, ownerRefSchema } from './entity.js'

/**
 * Bounds on what a model may ask for and what it may emit. Untrusted input,
 * exactly like a Plan (design § 5.4).
 */
export const QUERY_LIMITS = { maxRows: 25, maxName: 63, maxReason: 300 } as const

export const searchCriteriaSchema = z
  .object({
    kind: z.enum(['Component', 'Resource']).optional(),
    type: z.string().min(1).max(QUERY_LIMITS.maxName).optional(),
    env: z.string().min(1).max(QUERY_LIMITS.maxName).optional(),
    owner: ownerRefSchema.optional(),
    nameContains: z.string().min(1).max(QUERY_LIMITS.maxName).optional(),
  })
  .refine((criteria) => Object.keys(criteria).length > 0, 'a search needs at least one criterion')

export const getEntityInputSchema = z.object({ ref: entityRefSchema })

/**
 * Three named directions, never one "related to" verb: dependenciesOf is the
 * exact transpose of dependantsOf, and consumersOf is a separate multi-hop
 * walk (design § 4.1). Collapsing them would let a model pick by accident.
 */
export const getDependenciesInputSchema = z.object({
  ref: entityRefSchema,
  direction: z.enum(['dependencies', 'dependants', 'consumers']),
})

/**
 * The terminal channel — the read side of propose(). Refusal is a MEMBER of
 * the union, not a parse failure: the model has a legal way to say "I cannot",
 * so it never has to approximate in order to stay in schema. `refs` carries
 * identifiers the engine itself returned; it authorises nothing.
 *
 * `overview` is a request for the catalogue described as a whole, and the
 * model only CHOOSES it: the engine computes and writes the description from
 * the graph (ADR-0007). It carries no field, and is strict so that it stays
 * that way — a `summary` riding along would be refused and handed back rather
 * than stripped in silence, so a model is never led to think it has a place
 * to write one.
 */
export const answerSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('entities'),
    refs: z.array(entityRefSchema).min(1).max(QUERY_LIMITS.maxRows),
  }),
  z.object({ outcome: z.literal('nothing') }),
  z.strictObject({ outcome: z.literal('overview') }),
  z.object({
    outcome: z.literal('unanswerable'),
    reason: z.string().min(1).max(QUERY_LIMITS.maxReason),
  }),
])

export type Answer = z.infer<typeof answerSchema>
export type SearchCriteria = z.infer<typeof searchCriteriaSchema>
