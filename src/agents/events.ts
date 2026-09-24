import type { Question } from '../core/plan/clarify.js'
import type { Answer } from '../core/schemas/query.js'
import type { AgentName } from '../llm/client.js'
import type { Gate } from './repair.js'

/**
 * The harness renders nothing; it emits. Ink draws these at stage 7, and the
 * tests consume the same stream and assert the sequence (design § 6.2).
 *
 * `plan:ready` carries no plan. A plan reaches a reviewer as a diff and reaches
 * the engine as a signed object; an event is for saying that something
 * happened, and one carrying the plan itself would be a second way for it to
 * travel — which is the shape design § 10 spends the whole signature avoiding.
 */
export type AgentEvent =
  | { type: 'agent:start'; agent: AgentName }
  | { type: 'classified'; classification: 'MUTATION' | 'QUESTION' }
  | { type: 'tool:call'; name: string; args: unknown }
  | { type: 'tool:result'; name: string; rows: number; truncated: number }
  /**
   * The Analyst's answer, signed. `outcome` is there because `refs` alone
   * cannot tell an overview from an empty result — both carry none — and a
   * renderer reading the stream must not have to guess which it is drawing.
   */
  | { type: 'answer:ready'; outcome: Answer['outcome']; refs: string[] }
  | { type: 'refused'; agent: AgentName; reason: string }
  /**
   * A proposal was refused and handed back for correction, with the reason.
   *
   * `gate` is optional, and the optionality is what keeps the union honest
   * rather than a gap in it. The five names belong to the gates §6.1 runs over
   * a **Plan**, and `repair()` is the only thing that runs them; an agent
   * handing its own malformed tool call back to the model inside its own loop
   * has not failed one of them — the Inspector's report and the Reviewer's
   * verdict are not Plans at all. Naming a gate there would be inventing one,
   * and a renderer that reads the field would print it. So the field is present
   * when a gate refused a plan and absent otherwise; it is never a paraphrase
   * dug back out of `reason`, which is what putting it in the prose would have
   * forced on whoever draws this (design §6.2).
   */
  /**
   * One attempt of the repair loop (design §6.1), and only that. `repair()` is
   * the only thing that emits it, and `gate` is required: an attempt that
   * cannot say which of the five gates refused it is a number with no fact
   * attached.
   */
  | { type: 'repair'; attempt: 1 | 2 | 3; gate: Gate; reason: string }
  /**
   * An agent handing its own malformed terminal call back to the model.
   *
   * A different fact from `repair`, and it used to share its field: two
   * counters under one name, one restarting inside every attempt of the other,
   * so the rendered sequence was non-monotonic and repeated within a run. This
   * one is internal to an agent and has no attempt number worth showing — what
   * matters is which agent is correcting itself, and why.
   */
  | { type: 'retry'; agent: AgentName; reason: string }
  | { type: 'plan:ready'; operations: number }
  /**
   * The engine took a field away from the model rather than asking for it.
   *
   * A right's owner follows from its consumer, so `deriveOwners` computes it
   * the way the engine already computes the path — and in doing so it
   * overwrites a model's explicit `{unknown}` with a value the model never
   * wrote. That is a decision, and a decision nobody can see is the shape this
   * repository argues against everywhere else. It carries `from` because "who
   * says so" is the whole of why the value is allowed to be there.
   */
  | { type: 'derived'; path: string; owner: string; from: readonly string[] }
  /**
   * The engine kept an owner the user stated where the consumers determine
   * another. The user's word outranks the consumers, and that is a decision
   * about two facts that disagree: said, so a diff carrying one team's
   * authorisation and another team's consumer is not the first place anyone
   * sees it. `determined` and `from` are what the consumers would have given.
   */
  | {
      type: 'overridden'
      path: string
      owner: string
      determined: string
      from: readonly string[]
    }
  | { type: 'ask'; question: Question }

export type EventSink = (event: AgentEvent) => void
