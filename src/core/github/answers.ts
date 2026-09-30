import { z } from 'zod'

/**
 * The fields this build reads of each GitHub answer (stage 6 brief § 6, § 8):
 * one schema per route, holding exactly what a decision needs. A field nobody
 * reads is no reason to refuse an answer — GitHub adds fields — and it is
 * never passed on: `user()` keeps two fields by name, and every other schema
 * strips what it does not name, so what the forge keeps of an answer is what
 * these name, and nothing of it is printed without its own grammar.
 */

/** `GET user`: who gh acts as. `type` is `User` for a person; a `Bot`, or anything else, is not one. */
export const userAnswer = z.looseObject({ login: z.string(), type: z.string() })

export type UserAnswer = z.infer<typeof userAnswer>

/**
 * `GET repos/<o>/<r>` (§ 8, item 1): its name as GitHub answers it — a
 * renamed or transferred repository answers under its new one — whether it is
 * archived, and what the account gh acts as may do there. `maintain` is
 * absent from some answers; absent is not held.
 */
export const repositoryAnswer = z.object({
  full_name: z.string(),
  archived: z.boolean(),
  permissions: z.object({
    admin: z.boolean(),
    maintain: z.boolean().optional(),
    push: z.boolean(),
  }),
})

export type RepositoryAnswer = z.infer<typeof repositoryAnswer>

/** A ruleset's id, as the gh grammar takes one: a positive whole number a double holds exactly. */
const rulesetId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/** A `pull_request` rule's parameters: the approvals, the two rules on a new push, and Code Owners. */
export const pullRequestParameters = z.object({
  required_approving_review_count: z.number().int().min(0),
  require_last_push_approval: z.boolean().optional(),
  dismiss_stale_reviews_on_push: z.boolean().optional(),
  require_code_owner_review: z.boolean().optional(),
})

/** A `required_status_checks` rule's parameters: the contexts it requires. */
export const statusChecksParameters = z.object({
  required_status_checks: z.array(z.object({ context: z.string() })),
})

/**
 * One rule of `GET repos/<o>/<r>/rules/branches/<b>` (§ 8, item 2): its type,
 * the ruleset it comes from, and its parameters — held to a schema for the
 * two types whose parameters a decision or a report reads, and the whole
 * answer refused when they do not parse: a pull request rule this build
 * cannot read is not one it counts as protecting anything.
 */
const ruleAnswer = z
  .object({ type: z.string(), ruleset_id: rulesetId, parameters: z.unknown().optional() })
  .superRefine((rule, context) => {
    const schema =
      rule.type === 'pull_request'
        ? pullRequestParameters
        : rule.type === 'required_status_checks'
          ? statusChecksParameters
          : undefined
    if (schema !== undefined && !schema.safeParse(rule.parameters).success) {
      context.addIssue({ code: 'custom', message: `a ${rule.type} rule whose parameters this build does not read` })
    }
  })

export const rulesAnswer = z.array(ruleAnswer)

export type RulesAnswer = z.infer<typeof rulesAnswer>

/**
 * `GET repos/<o>/<r>/rulesets/<id>` (§ 8, item 3): whether the account gh acts
 * as can bypass it, and — shown only to someone who may edit it — who can.
 * `current_user_can_bypass` is kept as GitHub wrote it: only `never` binds,
 * and a word GitHub adds later is not `never` either. An actor is kept by its
 * type alone: it is counted, never named.
 */
export const rulesetAnswer = z.object({
  id: rulesetId,
  current_user_can_bypass: z.string().optional(),
  bypass_actors: z.array(z.object({ actor_type: z.string() })).optional(),
})

export type RulesetAnswer = z.infer<typeof rulesetAnswer>

/** `GET repos/<o>/<r>/branches/<b>` (§ 8, item 4): whether classic branch protection covers it. */
export const branchAnswer = z.object({ protected: z.boolean() })

export type BranchAnswer = z.infer<typeof branchAnswer>

/** `GET repos/<o>/<r>/git/ref/heads/<b>`: the commit a branch is at on GitHub. */
export const refAnswer = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal('commit'), sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }),
})

export type RefAnswer = z.infer<typeof refAnswer>

/** A commit or tree id, as GitHub writes one: SHA-1 or SHA-256, lower case, whole. */
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

/**
 * `GET repos/<o>/<r>/git/commits/<sha>`: what recognition compares a branch
 * this clone never made with (§ 14) — the commit, its tree, its parents and
 * its message. Whether GitHub keeps the message's final newline is one of the
 * answers the owner's live run records (6.4.1); the forge accepts either.
 */
export const commitAnswer = z.object({
  sha: objectId,
  tree: z.object({ sha: objectId }),
  parents: z.array(z.object({ sha: objectId })),
  message: z.string(),
})

export type CommitAnswer = z.infer<typeof commitAnswer>

/** A pull request's number: a positive whole number a double holds exactly. */
const pullNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/**
 * `POST repos/<o>/<r>/pulls`'s answer: the number GitHub gave the pull
 * request, and what it says it opened, which must be what was asked.
 */
export const pullAnswer = z.object({
  number: pullNumber,
  state: z.string(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string() }),
})

export type PullAnswer = z.infer<typeof pullAnswer>

/**
 * `GET repos/<o>/<r>/pulls?head=<o>:<branch>&state=all&per_page=100` (§ 14):
 * every pull request from the branch, closed and merged ones included, one
 * page. `merged_at` says a closed one was merged; the two dates are GitHub's
 * words, and only a day read from their start is ever printed.
 */
export const pullsAnswer = z.array(
  z.object({
    number: pullNumber,
    state: z.enum(['open', 'closed']),
    merged_at: z.string().nullable(),
    closed_at: z.string().nullable(),
    base: z.object({ ref: z.string() }),
    head: z.object({ ref: z.string() }),
  }),
)

export type PullsAnswer = z.infer<typeof pullsAnswer>
