import type { AgentName } from '../llm/client.js'

/**
 * The harness renders nothing; it emits. Ink draws these at stage 7, and the
 * tests consume the same stream and assert the sequence (design § 6.2).
 *
 * `repair`, `plan:ready` and `ask` arrive with the write path at stage 4.
 */
export type AgentEvent =
  | { type: 'agent:start'; agent: AgentName }
  | { type: 'classified'; classification: 'MUTATION' | 'QUESTION' }
  | { type: 'tool:call'; name: string; args: unknown }
  | { type: 'tool:result'; name: string; rows: number; truncated: number }
  | { type: 'answer:ready'; refs: string[] }
  | { type: 'refused'; agent: AgentName; reason: string }

export type EventSink = (event: AgentEvent) => void
