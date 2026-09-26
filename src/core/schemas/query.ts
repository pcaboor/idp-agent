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

/**
 * The Analyst's search: the same criteria, and Backstage's API among the kinds.
 *
 * A schema of its own rather than a wider `kind` on the one above, which the
 * Architect is handed too: a tool's parameters are part of every request a
 * recording's digest is taken over, so the Architect's stay byte for byte what
 * they were, and it is never offered a kind it cannot propose.
 */
export const apiSearchCriteriaSchema = z
  .object({
    kind: z.enum(['Component', 'Resource', 'API']).optional(),
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
 * Providing an API, read from either end: `provides` is what a component
 * declares in `spec.providesApis`, `providedBy` the components that declare
 * an API — Backstage's `providesApi` and `apiProvidedBy`, named as this tool's
 * other directions are (`dependencies`, `dependants`), and the Backstage names
 * given in the tool's description. Not a direction of `get_dependencies`: providing is not depending,
 * and a relation named apart is one a model cannot pick by accident. Who
 * consumes an API is a right over it, walked by `get_dependencies`.
 */
export const getApisInputSchema = z.object({
  ref: entityRefSchema,
  direction: z.enum(['provides', 'providedBy']),
})

/**
 * The relations the engine computes from one entity (`context/graph/relations.ts`),
 * each a walk over the graph's own edges, and each named apart for the reason
 * `get_dependencies`' directions are: a relation a model picks by name is one
 * it cannot pick by accident.
 *
 *   - `depends-on`: everything it needs, transitively;
 *   - `impacts`: everything that needs it, transitively — what is affected if
 *     it fails;
 *   - `consumes`: what a consumer reaches through the rights granted to it,
 *     each with the right and the level it states;
 *   - `consumed-by`: the services that reach it, through any chain, each with
 *     the right on its path;
 *   - `provides` / `provided-by`: Backstage's `providesApis`, read from either
 *     end;
 *   - `between`: every path of declared dependencies linking it to another
 *     entity, whichever of the two depends on the other.
 */
export const RELATIONS = [
  'consumes',
  'consumed-by',
  'depends-on',
  'impacts',
  'provides',
  'provided-by',
  'between',
] as const

export type Relation = (typeof RELATIONS)[number]

/** A relation read from one entity alone: every one but `between`, which needs another end. */
export type OwnRelation = Exclude<Relation, 'between'>

/** `RELATIONS` less `between`, in the same order: `idpa relations`' flags and its overview. */
export const OWN_RELATIONS: readonly OwnRelation[] = RELATIONS.filter(
  (relation): relation is OwnRelation => relation !== 'between',
)

/**
 * `between`'s other end, wherever a relation is asked for. Read as absent
 * when it is not a reference — blank, null, a bare name — rather than
 * refused: the field is shown flat beside every relation, a model fills it,
 * and on any relation but `between` it is discarded unread. On `between` an
 * absent one is still refused, by the `.refine` beside each use. The
 * advertised JSON Schema is the reference's, as `commentaryField`'s is the
 * string's: stricter than what is accepted, never looser.
 */
const otherEnd = () => entityRefSchema.optional().catch(undefined)

/**
 * The Analyst's `get_relations`: a relation from one entity, and the other
 * end when it is `between`. Refused without one there, rather than answered
 * with nothing: a path to no entity is not a question.
 */
export const getRelationsInputSchema = z
  .object({
    ref: entityRefSchema,
    relation: z.enum(RELATIONS),
    to: otherEnd(),
  })
  .refine((input) => input.relation !== 'between' || input.to !== undefined, {
    message: '"between" needs "to", the other entity',
    path: ['to'],
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

/** Built per branch, so every branch that carries it advertises one identical field. */
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
 * `relation` is a request for one entity's relations, and the model CHOOSES
 * the entity, the relation and — for `between` — the other end, each a
 * reference a tool returned, checked against the witness set as `entities`'
 * refs are. The engine computes the relation from the declarations and writes
 * every path (`context/graph/relations.ts`, rendered as `idpa relations`
 * prints it), so nothing in the block is the model's (ADR-0007, the relation
 * addendum). A `between` with no other end — or one that is not a reference —
 * is refused at the parse and handed back; a `to` on any other relation is
 * discarded, never read, whatever it holds (`otherEnd`).
 *
 * What rides along with any outcome is DISCARDED, never refused. The tool is
 * advertised flat (llm/tool-schema.ts), so `refs` and `reason` are optional
 * properties a model sees beside every outcome, and a real one fills them all:
 * an overview carrying an invented ref and a blank reason was refused three
 * times, and the question ended on "nothing matched". Stripping is safe
 * because a discarded field is gone at the parse — nothing downstream can read
 * it, put it in an event or print it. Three fields are kept: `entities` refs
 * and a `relation`'s references, checked against the witness set and re-read
 * before printing, and `unanswerable`'s reason, which is the model's prose,
 * unchecked, and reaches stderr only.
 *
 * `entities`, `nothing`, `overview` and `relation` also carry the model's
 * commentary (ADR-0008): an `intro` and a `conclusion` around the block the
 * engine prints. Neither is trusted — each sentence is checked against what
 * the tools returned before it is printed, marked as the model's
 * (`checkCommentary`) — and neither is worth a refusal: one that is not a
 * string, or is past its raw bound, is dropped at the parse and the answer
 * kept. An `unanswerable` discards both; its reason already says why.
 */
const entitiesAnswer = () =>
  z.object({
    outcome: z.literal('entities'),
    refs: z.array(entityRefSchema).min(1).max(QUERY_LIMITS.maxRows),
    ...commentary(),
  })
const nothingAnswer = () => z.object({ outcome: z.literal('nothing'), ...commentary() })
const overviewAnswer = () => z.object({ outcome: z.literal('overview'), ...commentary() })
const unanswerableAnswer = () =>
  z.object({
    outcome: z.literal('unanswerable'),
    reason: z.string().min(1).max(QUERY_LIMITS.maxReason),
  })

export const answerSchema = z.discriminatedUnion('outcome', [
  entitiesAnswer(),
  nothingAnswer(),
  overviewAnswer(),
  z
    .object({
      outcome: z.literal('relation'),
      ref: entityRefSchema.describe('The entity the relation is read from: a reference a tool returned.'),
      relation: z
        .enum(RELATIONS)
        .describe(
          'What to trace from "ref": "consumes" (what it reaches through its rights), ' +
            '"consumed-by" (who reaches it), "depends-on", "impacts" (what needs it), ' +
            '"provides", "provided-by", or "between" with "to".',
        ),
      to: otherEnd().describe(
        'With "between" only: the other entity, a reference a tool returned.',
      ),
      ...commentary(),
    })
    .refine((answer) => answer.relation !== 'between' || answer.to !== undefined, {
      message: '"between" needs "to", the other entity',
      path: ['to'],
    }),
  unanswerableAnswer(),
])

/**
 * The same union less `relation`, for the registry the Architect is built
 * from. The Architect is never offered `answer` (`architect.ts` filters it
 * out), but its registry's specs are held byte for byte to
 * `tests/golden/architect-tools.json`, the build every plan-mode tape was
 * recorded against — so they stay what they were, as `searchCriteriaSchema`
 * does beside the Analyst's wider search.
 */
export const answerSchemaWithoutRelation = z.discriminatedUnion('outcome', [
  entitiesAnswer(),
  nothingAnswer(),
  overviewAnswer(),
  unanswerableAnswer(),
])

export type Answer = z.infer<typeof answerSchema>
/** Either search's criteria: the Analyst's is the wider. */
export type SearchCriteria = z.infer<typeof apiSearchCriteriaSchema>
