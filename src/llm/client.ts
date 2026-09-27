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

/** What a provider reported about one call. A count it did not report is absent, never 0. */
export interface TokenUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface GenerateResult {
  text: string
  toolCalls: ModelToolCall[]
  finishReason: string
  /** Absent when the provider reported none — and on every recording made before it was stored. */
  usage?: TokenUsage
}

/**
 * What a caller hands `generate` beside the request, never inside it: the
 * recording digest is taken over the request, and nothing here may move it.
 */
export interface GenerateOptions {
  /**
   * Stops the call: it rejects with the signal's reason, and nothing is sent
   * again. Joined to IDP_TIMEOUT's bound, which still holds beside it. No
   * command passes one yet — nothing stops a run mid-call before stage 7's
   * chat — and a replay honours it too (agents-llm-10).
   */
  readonly signal?: AbortSignal
}

export interface LlmClient {
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResult>
}
