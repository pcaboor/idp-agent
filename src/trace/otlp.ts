import type { TokenUsage } from '../llm/client.js'
import type { AttributeValue, Attributes, Span, Trace } from './model.js'

/**
 * A trace as the OTLP/JSON body MLflow's `/v1/traces` accepts.
 *
 * MLflow's own keys carry JSON strings — that is how MLflow writes them itself,
 * and `spanInputs`/`spanOutputs` have to be JSON anyway. The project's own
 * `idp.*` keys carry typed values. tests/contract/otlp/accepted.json is this
 * encoding of one trace, read back as sent by the MLflow this project pins.
 */

export interface OtlpResource {
  readonly serviceVersion: string
}

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }

interface OtlpAttribute {
  key: string
  value: OtlpValue
}

const attribute = (key: string, value: AttributeValue): OtlpAttribute => {
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  // int64 travels as a string in OTLP/JSON.
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } }
}

const mlflow = (key: string, value: unknown): OtlpAttribute => ({
  key,
  value: { stringValue: JSON.stringify(value) },
})

const attributesOf = (attributes: Attributes): OtlpAttribute[] =>
  Object.entries(attributes).map(([key, value]) => attribute(key, value))

/** MLflow's names for the counts, and only the counts the provider reported. */
const usageOf = (usage: TokenUsage): Record<string, number> => ({
  ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
  ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
  ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
})

const SPAN_KIND_INTERNAL = 1
const STATUS_OK = 1
const STATUS_ERROR = 2

function spanOf(traceId: string, span: Span): object {
  const { status } = span
  return {
    traceId,
    spanId: span.spanId,
    ...(span.parentId !== undefined ? { parentSpanId: span.parentId } : {}),
    name: span.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: String(span.start),
    endTimeUnixNano: String(span.end),
    attributes: [
      mlflow('mlflow.spanType', span.type),
      ...(span.inputs !== undefined ? [mlflow('mlflow.spanInputs', span.inputs)] : []),
      ...(span.outputs !== undefined ? [mlflow('mlflow.spanOutputs', span.outputs)] : []),
      ...(span.usage !== undefined ? [mlflow('mlflow.chat.tokenUsage', usageOf(span.usage))] : []),
      ...attributesOf(span.attributes),
    ],
    events: span.events.map((event) => ({
      timeUnixNano: String(event.time),
      name: event.name,
      attributes: attributesOf(event.attributes),
    })),
    status:
      status.code === 'OK'
        ? { code: STATUS_OK }
        : { code: STATUS_ERROR, message: status.message },
  }
}

export function toOtlpJson(trace: Trace, resource: OtlpResource): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute('service.name', 'idp-agent'),
            attribute('service.version', resource.serviceVersion),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'idp-agent', version: resource.serviceVersion },
            spans: trace.spans.map((span) => spanOf(trace.traceId, span)),
          },
        ],
      },
    ],
  }
}
