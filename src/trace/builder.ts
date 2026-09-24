import type { AgentEvent } from '../agents/events.js'
import type { GenerateRequest, GenerateResult, TokenUsage } from '../llm/client.js'
import type {
  AttributeValue,
  Attributes,
  Span,
  SpanEvent,
  SpanStatus,
  SpanType,
  Trace,
} from './model.js'

/**
 * Folds one run into a span tree: the `AgentEvent` stream, plus each model
 * call as `traced` reports it (ADR-0009).
 *
 * Nothing is guessed. A span is closed by the event that ends it; one that
 * nothing closed is closed at `finish` as an error that says so, and an event
 * that fits no open span becomes an `unbalanced event` span — never a throw,
 * which would take the run down with the trace, and never a silent drop.
 * tests/invariants/trace.test.ts holds that over any sequence of events.
 */

export interface TraceIds {
  /** 32 lowercase hex characters. */
  traceId(): string
  /** 16 lowercase hex characters. */
  spanId(): string
}

export interface RunOutcome {
  readonly outputs: unknown
  /** The message, when the run threw. The root then closes as an error. */
  readonly error?: string
  readonly attributes?: Attributes
}

export type ModelCallOutcome = { readonly result: GenerateResult } | { readonly error: unknown }

export interface TraceBuilder {
  readonly traceId: string
  onEvent(event: AgentEvent): void
  /** Opens a CHAT_MODEL span and returns the handle that closes it. */
  modelCallStarted(request: GenerateRequest): string
  modelCallEnded(handle: string, outcome: ModelCallOutcome): void
  /** Idempotent: a second call returns the trace the first one built. */
  finish(outcome: RunOutcome): Trace
}

interface Open {
  readonly spanId: string
  readonly parentId: string | undefined
  readonly name: string
  readonly type: SpanType
  readonly start: bigint
  /** What closes it: `agent:<name>`, `attempt:<n>`, `tool:<id>`, `model:<agent>:<n>`. */
  readonly key: string
  readonly order: number
  inputs: unknown
  outputs: unknown
  usage: TokenUsage | undefined
  readonly attributes: Record<string, AttributeValue>
  readonly events: SpanEvent[]
  /** Set by the event that makes this span a failure: a refusal, a refused gate. */
  failure: string | undefined
}

const OK: SpanStatus = { code: 'OK' }
const failed = (message: string): SpanStatus => ({ code: 'ERROR', message })
const messageOf = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown)

export function createTraceBuilder(options: {
  clock: () => bigint
  ids: TraceIds
  name: string
  inputs: unknown
  attributes?: Attributes
}): TraceBuilder {
  const traceId = options.ids.traceId()
  const closed: Span[] = []
  const orders = new Map<string, number>()
  const calls = new Map<string, number>()
  let order = 0
  let finished: Trace | undefined

  const open = (
    parent: Open | undefined,
    name: string,
    type: SpanType,
    key: string,
    inputs?: unknown,
  ): Open => ({
    spanId: options.ids.spanId(),
    parentId: parent?.spanId,
    name,
    type,
    key,
    start: options.clock(),
    order: order++,
    inputs,
    outputs: undefined,
    usage: undefined,
    attributes: {},
    events: [],
    failure: undefined,
  })

  const root = open(undefined, options.name, 'CHAIN', 'root', options.inputs)
  Object.assign(root.attributes, options.attributes ?? {})
  const stack: Open[] = [root]

  const top = (): Open => stack[stack.length - 1] ?? root

  const close = (span: Open, status: SpanStatus): void => {
    orders.set(span.spanId, span.order)
    closed.push({
      spanId: span.spanId,
      parentId: span.parentId,
      name: span.name,
      type: span.type,
      start: span.start,
      end: options.clock(),
      status,
      inputs: span.inputs,
      outputs: span.outputs,
      usage: span.usage,
      attributes: { ...span.attributes },
      events: [...span.events],
    })
  }

  const statusOf = (span: Open): SpanStatus =>
    span.failure === undefined ? OK : failed(span.failure)

  const find = (key: string): Open | undefined => {
    for (let index = stack.length - 1; index >= 1; index -= 1) {
      const span = stack[index]
      if (span?.key === key) return span
    }
    return undefined
  }

  /** Closes the span `key` names, and first everything opened inside it that is still open. */
  const closeTo = (key: string, status: (span: Open) => SpanStatus = statusOf): boolean => {
    const target = find(key)
    if (target === undefined) return false
    while (top() !== target) {
      const inner = stack.pop()
      if (inner !== undefined) close(inner, failed(`closed when ${key} ended, by no event of its own`))
    }
    stack.pop()
    close(target, status(target))
    return true
  }

  /** A span with no duration of its own: a gate's verdict, or an event that fitted nowhere. */
  const marker = (name: string, status: SpanStatus, attributes: Attributes = {}): void => {
    const span = open(top(), name, 'CHAIN', 'marker')
    Object.assign(span.attributes, attributes)
    close(span, status)
  }

  const unbalanced = (what: string, expected: string): void =>
    marker('unbalanced event', failed(`${what} matched no open ${expected}`), { 'idp.event': what })

  const note = (name: string, attributes: Attributes): void => {
    top().events.push({ name, time: options.clock(), attributes })
  }

  /** The first failure stands: a later one on the same span does not overwrite why it failed. */
  const fail = (key: string, message: string): void => {
    const span = find(key)
    if (span !== undefined && span.failure === undefined) span.failure = message
  }

  const onEvent = (event: AgentEvent): void => {
    // After `finish` the trace has been handed over; there is no span left to
    // put anything under.
    if (finished !== undefined) return
    switch (event.type) {
      case 'agent:start':
        stack.push(open(top(), event.agent, 'AGENT', `agent:${event.agent}`))
        return
      case 'agent:end': {
        const threw = event.threw
        const ended = closeTo(`agent:${event.agent}`, (span) =>
          span.failure === undefined && threw ? failed('the agent threw') : statusOf(span),
        )
        if (!ended) unbalanced('agent:end', `agent ${event.agent}`)
        return
      }
      case 'attempt:start':
        stack.push(open(top(), `attempt ${event.attempt}`, 'CHAIN', `attempt:${event.attempt}`))
        return
      case 'attempt:end':
        if (!closeTo(`attempt:${event.attempt}`)) unbalanced('attempt:end', `attempt ${event.attempt}`)
        return
      case 'tool:call':
        stack.push(
          open(top(), event.name, 'TOOL', `tool:${event.id}`, {
            id: event.id,
            name: event.name,
            args: event.args,
          }),
        )
        return
      case 'tool:result': {
        const span = find(`tool:${event.id}`)
        if (span === undefined) {
          unbalanced('tool:result', `tool call ${event.id}`)
          return
        }
        span.outputs = { rows: event.rows, truncated: event.truncated }
        closeTo(span.key)
        return
      }
      case 'gate:passed':
        marker(`gate ${event.gate}`, OK, { 'idp.attempt': event.attempt })
        return
      case 'repair':
        marker(`gate ${event.gate}`, failed(event.reason), { 'idp.attempt': event.attempt })
        fail(`attempt:${event.attempt}`, `refused at the ${event.gate} gate`)
        return
      case 'refused':
        note('refused', { agent: event.agent, reason: event.reason })
        fail(`agent:${event.agent}`, event.reason)
        return
      case 'stopped':
        note('stopped', { agent: event.agent, reason: event.reason })
        fail(`agent:${event.agent}`, event.reason)
        return
      case 'retry':
        note('retry', { agent: event.agent, reason: event.reason })
        return
      case 'classified':
        note('classified', { classification: event.classification })
        return
      case 'answer:ready':
        note('answer:ready', { outcome: event.outcome, refs: event.refs.join(', ') })
        return
      case 'plan:ready':
        note('plan:ready', { operations: event.operations })
        return
      case 'derived':
        note('derived', { path: event.path, owner: event.owner, from: event.from.join(', ') })
        return
      case 'overridden':
        note('overridden', {
          path: event.path,
          owner: event.owner,
          determined: event.determined,
          from: event.from.join(', '),
        })
        return
      case 'reapplied':
        note('reapplied', {
          path: event.path,
          value: event.value,
          entity: event.entity,
          answeredAt: event.answeredAt,
          ...(event.replaced !== undefined ? { replaced: event.replaced } : {}),
        })
        return
      case 'ask':
        note('ask', { path: event.question.path, question: event.question.question })
        return
      default: {
        // A new event with no span is a compile error rather than a silent gap.
        const exhaustive: never = event
        return exhaustive
      }
    }
  }

  const modelCallStarted = (request: GenerateRequest): string => {
    const index = calls.get(request.agent) ?? 0
    calls.set(request.agent, index + 1)
    const key = `model:${request.agent}:${index}`
    if (finished !== undefined) return key
    stack.push(
      open(top(), `${request.agent} call ${index}`, 'CHAT_MODEL', key, {
        system: request.system,
        transcript: request.transcript,
        // Named, never serialised: a tool's Zod schema is code, and what the
        // model was offered is its name and what it was told the tool does.
        tools: request.tools.map((spec) => ({ name: spec.name, description: spec.description })),
        toolChoice: request.toolChoice,
      }),
    )
    return key
  }

  const modelCallEnded = (handle: string, outcome: ModelCallOutcome): void => {
    if (finished !== undefined) return
    const span = find(handle)
    if (span === undefined) {
      unbalanced('model call end', handle)
      return
    }
    if ('error' in outcome) {
      const message = messageOf(outcome.error)
      closeTo(handle, () => failed(message))
      return
    }
    const { text, toolCalls, finishReason, usage } = outcome.result
    span.outputs = { text, toolCalls, finishReason }
    span.usage = usage
    // Absent is not zero, and a reader of the trace must not have to know that
    // a missing attribute means "not reported" rather than "nothing spent".
    if (usage === undefined) span.attributes['idp.usage'] = 'absent'
    closeTo(handle)
  }

  const finish = (outcome: RunOutcome): Trace => {
    if (finished !== undefined) return finished
    while (stack.length > 1) {
      const span = stack.pop()
      if (span !== undefined) close(span, failed('closed by finish, by no event of its own'))
    }
    root.outputs = outcome.outputs
    Object.assign(root.attributes, outcome.attributes ?? {})
    close(root, outcome.error === undefined ? OK : failed(outcome.error))
    const spans = [...closed].sort(
      (left, right) => (orders.get(left.spanId) ?? 0) - (orders.get(right.spanId) ?? 0),
    )
    finished = { traceId, spans }
    return finished
  }

  return { traceId, onEvent, modelCallStarted, modelCallEnded, finish }
}
