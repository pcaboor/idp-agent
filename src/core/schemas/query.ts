import { z } from 'zod'
import { entityRefSchema, ownerRefSchema } from './entity.js'

/**
 * Bounds on what a model may ask for and what it may emit. Untrusted input,
 * exactly like a Plan (design § 5.4).
 */
export const QUERY_LIMITS = {
  maxRows: 25,
  maxName: 63,
  maxReason: 300,
  /**
   * The raw bound on one commentary field, far above what is printed
   * (`core/answer/commentary.ts` bounds that, at a sentence boundary). Past it
   * the field is dropped, not refused.
   */
  maxCommentary: 2_000,
} as const

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
 * One commentary field: optional, and DROPPED rather than refused when it is
 * malformed — `.catch` turns any failure into `undefined`, which no reader
 * tells from an absent field, so the answer it rode on is kept and no repair
 * turn is spent on a sentence.
 *
 * The advertised JSON Schema cannot say "dropped, not refused": it shows a
 * string of at most `maxCommentary` characters, which is stricter than what is
 * accepted, never looser, and the description says the rest (json-schema.ts:
 * "a schema quietly weaker than the validator is worse than no schema at
 * all"). Both count characters as code points, as zod's `.max` does.
 */
const commentaryField = (what: string) =>
  z
    .string()
    .max(QUERY_LIMITS.maxCommentary)
    .optional()
    .catch(undefined)
    .describe(
      `${what}, in the language of the question. Optional. Dropped, never refused, when it ` +
        `is not a string or is longer than ${QUERY_LIMITS.maxCommentary} characters.`,
    )

/** Built per branch, so the three branches advertise one identical field. */
const commentary = () => ({
  intro: commentaryField('One short sentence introducing the answer'),
  conclusion: commentaryField(
    'At most three short sentences on what the result means for the question',
  ),
})

/**
 * The terminal channel — the read side of propose(). Refusal is a MEMBER of
 * the union, not a parse failure: the model has a legal way to say "I cannot",
 * so it never has to approximate in order to stay in schema. `refs` carries
 * identifiers the engine itself returned; it authorises nothing.
 *
 * `overview` is a request for the catalogue described as a whole, and the
 * model only CHOOSES it: the engine computes and writes the description from
 * the graph (ADR-0007). It carries no field but the commentary below.
 *
 * What rides along with any outcome is DISCARDED, never refused. The tool is
 * advertised flat (llm/tool-schema.ts), so `refs` and `reason` are optional
 * properties a model sees beside every outcome, and a real one fills them all:
 * an overview carrying an invented ref and a blank reason was refused three
 * times, and the question ended on "nothing matched". Stripping is safe
 * because a discarded field is gone at the parse — nothing downstream can read
 * it, put it in an event or print it. Two fields are kept, as before: `entities`
 * refs, checked against the witness set and re-read before printing, and
 * `unanswerable`'s reason, which is the model's prose, unchecked, and reaches
 * stderr only.
 *
 * `entities`, `nothing` and `overview` also carry the model's commentary
 * (ADR-0008): an `intro` and a `conclusion` around the block the engine
 * prints. Neither is trusted — each sentence is checked against what the
 * tools returned before it is printed, marked as the model's (`checkCommentary`)
 * — and neither is worth a refusal: one that is not a string, or is past its
 * raw bound, is dropped at the parse and the answer kept. An `unanswerable`
 * discards both; its reason already says why.
 */
export const answerSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('entities'),
    refs: z.array(entityRefSchema).min(1).max(QUERY_LIMITS.maxRows),
    ...commentary(),
  }),
  z.object({ outcome: z.literal('nothing'), ...commentary() }),
  z.object({ outcome: z.literal('overview'), ...commentary() }),
  z.object({
    outcome: z.literal('unanswerable'),
    reason: z.string().min(1).max(QUERY_LIMITS.maxReason),
  }),
])

export type Answer = z.infer<typeof answerSchema>
export type SearchCriteria = z.infer<typeof searchCriteriaSchema>
