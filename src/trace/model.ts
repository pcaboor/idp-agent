import type { TokenUsage } from '../llm/client.js'

/**
 * A run, as MLflow is handed it. Plain data: `builder.ts` builds it, `otlp.ts`
 * encodes it, and nothing in between reaches a disk or a network.
 */

/** The four MLflow span types this project emits — each checked to render (ADR-0009). */
export type SpanType = 'CHAIN' | 'AGENT' | 'CHAT_MODEL' | 'TOOL'

export type AttributeValue = string | number | boolean
export type Attributes = Readonly<Record<string, AttributeValue>>

export type SpanStatus =
  | { readonly code: 'OK' }
  | { readonly code: 'ERROR'; readonly message: string }

export interface SpanEvent {
  readonly name: string
  /** Unix nanoseconds. */
  readonly time: bigint
  readonly attributes: Attributes
}

export interface Span {
  readonly spanId: string
  /** Absent on the root, and only there. */
  readonly parentId: string | undefined
  readonly name: string
  readonly type: SpanType
  /** Unix nanoseconds. */
  readonly start: bigint
  readonly end: bigint
  readonly status: SpanStatus
  /** `undefined` means not recorded, and is encoded as no attribute at all. */
  readonly inputs: unknown
  readonly outputs: unknown
  /** What the provider reported, and only that. Absent is not zero. */
  readonly usage: TokenUsage | undefined
  readonly attributes: Attributes
  readonly events: readonly SpanEvent[]
}

export interface Trace {
  readonly traceId: string
  /** The root first, then every other span in the order it began. */
  readonly spans: readonly Span[]
}
