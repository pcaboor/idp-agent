import type { Question } from '../core/plan/clarify.js'
import type { AgentName } from '../llm/client.js'

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
  | { type: 'answer:ready'; refs: string[] }
  | { type: 'refused'; agent: AgentName; reason: string }
  /** A proposal was refused and handed back for correction, with the reason. */
  | { type: 'repair'; attempt: 1 | 2 | 3; reason: string }
  | { type: 'plan:ready'; operations: number }
  | { type: 'ask'; question: Question }

export type EventSink = (event: AgentEvent) => void
