import { z } from 'zod'
import { PLAN_LIMITS, operationSchema, type Plan } from '../../core/schemas/plan.js'
import type { ModelToolCall, ModelToolSpec } from '../../llm/client.js'
import type { ToolOutcome } from './graph-tools.js'

/** The terminal tool. Named once so the loop and the spec cannot disagree. */
export const PROPOSE_TOOL = 'propose'

/**
 * `operationSchema`'s own members, selected rather than restated. A second
 * spelling of "what a create-entity looks like" is a second place for the two to
 * drift, and the copy in front of the model would be the one that won.
 *
 * `create-catalog-info` is absent, and the absence is design 5.2 made
 * structural: that operation carries `repoPath`, and a path field in front of a
 * model is a path a model chooses. It is a real operation — `init` (design 7.3)
 * needs it — but the engine composes that one from the repository it is already
 * standing in, so nothing the model writes reaches it.
 */
const [createEntity, updateEntity] = operationSchema.options

const proposableOperationSchema = z.discriminatedUnion('op', [createEntity, updateEntity])

/**
 * What crosses the boundary, and it is only operations.
 *
 * There is **no `intent` field**, and that is not an economy of tokens.
 * `signPlan` classifies a proposed value by where it came from, and a value that
 * appears in the request is `echoed` — which signs cleanly. A model that wrote
 * its own intent would be writing both sides of that comparison: put
 * "secret-backdoor" in the intent and every leaf of the plan vouches for itself.
 * The intent is the user's words; `draftPlan` fills them in.
 *
 * There is no floor on the operation count either. Design 7.5 makes an empty
 * plan a legitimate outcome — the entity already exists, nothing to do, exit 0 —
 * and a floor of one would make that outcome inexpressible. An inexpressible
 * outcome is an invented one.
 */
const proposeInputSchema = z.strictObject({
  // At least one. `planSchema` says the same thing and says why; this says it
  // at the boundary the model actually writes through, so the refusal arrives
  // as a tool error naming `operations` rather than as a plan-level rejection
  // one layer later. Both are needed: this tool never sees the assembled plan,
  // and the plan boundary is reached by callers that never touch this tool.
  operations: z
    .array(proposableOperationSchema)
    .min(1, 'a plan with no operations is not a proposal; end the draft instead')
    .max(PLAN_LIMITS.maxOperations),
})

/**
 * The first issue, with the field it is about.
 *
 * `plan.ts` says why a rejection that cannot name the field is a rejection
 * nobody can act on, and discriminates on `kind` so that this one can. The
 * dotted path it produces — `operations.0.entity.spec.owner` — is the same
 * string `findUnknowns` and the signer use, so a model repairing this is
 * repairing the field a human would read out, not a paraphrase of it.
 *
 * A second copy of `inspector.ts`'s, on the reasoning that file already states
 * about the forced turn: two is not a pattern. Whoever writes the third should
 * be the one to extract it.
 */
function issueOf(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid'
  const where = issue.path.map(String).join('.')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}

/**
 * The one way a plan leaves the model (design 10, write side).
 *
 * It fills a typed buffer and returns **nothing**: not the plan, not a path, not
 * a count of what it accepted. The model learns that the call was accepted, or
 * it learns exactly which field failed so it can correct itself — and nothing
 * else. A tool that echoed the buffer back would put the model's own proposal
 * into its context as if a tool had returned it, which is the shape every other
 * guarantee here is built to prevent.
 */
export function buildProposeTool(): {
  spec: ModelToolSpec
  /** Fills the buffer. Returns what the MODEL sees, which is as close to nothing as a result gets. */
  run(call: ModelToolCall): ToolOutcome
  taken(): Plan | undefined
  /**
   * Always empty, and that is the fact it exists to state.
   *
   * `witnessed` is what `signPlan` later tests a proposed value against, and it
   * holds references the ENGINE returned. This tool returns nothing, so it
   * witnesses nothing: a reference arriving here came from the model, and a
   * tool that added its own arguments to this set would make the signature
   * vouch for exactly the fabrications it exists to catch.
   */
  witnessed: ReadonlySet<string>
} {
  let buffered: Plan | undefined

  const refused = (message: string): ToolOutcome => ({
    // Returned, not thrown: the loop has to be able to continue after a bad
    // call, and the model has to be able to read what was wrong with it.
    result: { error: `${PROPOSE_TOOL}: ${message}` },
    rows: 0,
    truncated: 0,
  })

  return {
    spec: {
      name: PROPOSE_TOOL,
      description:
        'Submit the plan. Give the operations you are proposing: an entity to create, or ' +
        'an existing entity to patch. Propose an empty list when the catalogue already ' +
        'declares everything the request asks for — that is an answer, not a failure. You ' +
        'choose no file and no path; the engine computes those from the type and the name. ' +
        'A value nothing states is {"unknown": "<why>"}. You must call this to finish, and ' +
        'it returns nothing.',
      parameters: proposeInputSchema,
    },

    witnessed: new Set<string>(),

    run(call: ModelToolCall): ToolOutcome {
      if (call.name !== PROPOSE_TOOL) return refused(`unknown tool "${call.name}"`)

      // First accepted proposal wins. A buffer that the last call overwrites is
      // a buffer whose contents depend on the order tool calls happen to arrive
      // in; saying so is cheaper than making the loop responsible for it.
      if (buffered !== undefined) return refused('a plan was already proposed; propose once')

      const parsed = proposeInputSchema.safeParse(call.args)
      if (!parsed.success) return refused(issueOf(parsed.error))

      // The intent is not this tool's to know and not the model's to write, so
      // the buffer carries an empty one and `planSchema` refuses it outright.
      // `draftPlan` fills it from the request. A caller that skips `draftPlan`
      // fails at the boundary rather than signing a plan against an intent
      // nobody typed.
      buffered = { intent: '', operations: parsed.data.operations }

      // Accepted, and that is the whole message.
      return { result: {}, rows: 0, truncated: 0 }
    },

    taken: () => buffered,
  }
}
