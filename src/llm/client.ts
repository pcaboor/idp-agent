import type { z } from 'zod'

/**
 * The single crossing point between the model and the deterministic side
 * (design § 10). This file holds **types only** on purpose: `agents/` imports
 * it, and the architecture test walks the transitive closure — a runtime
 * import here would put `ai` or `node:fs` inside the agent closure and break
 * the guarantee SECURITY.md makes.
 */

export type AgentName = 'supervisor' | 'analyst' | 'inspector' | 'architect' | 'reviewer'

export interface ModelToolSpec {
  name: string
  description: string
  parameters: z.ZodType
}

/** `args` is UNVALIDATED: it came from the model. Parse before use. */
export interface ModelToolCall {
  id: string
  name: string
  args: unknown
}

export type Transcript =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ModelToolCall[] }
  | { role: 'tool'; id: string; name: string; result: unknown }

export interface GenerateRequest {
  agent: AgentName
  system: string
  transcript: Transcript[]
  tools: ModelToolSpec[]
  toolChoice: 'auto' | 'none' | { tool: string }
}

export interface GenerateResult {
  text: string
  toolCalls: ModelToolCall[]
  finishReason: string
}

export interface LlmClient {
  generate(request: GenerateRequest): Promise<GenerateResult>
}
