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
 * nothing closed is closed — by `finish`, or by the end of the span around it
 * — as an error that says so, and an event that fits no open span becomes an
 * `unbalanced event` span — never a throw, which would take the run down with
 * the trace, and never a silent drop. tests/invariants/trace.test.ts holds
 * that over any sequence of events, and holds a well-formed run to closing
 * every span by its own event.
 *
 * Events and model calls arrive one at a time, and no two model calls
 * overlap: every agent awaits each `generate` before it emits or calls again,
 * and one agent runs at a time. That is what lets the spans that contain
 * others — agents, attempts, model calls — sit on one stack, and what makes
 * the top of it the span any event belongs to. A model call sits there too:
 * nothing is emitted while one is awaited. If two calls ever run at once, a
 * stack is the wrong structure, and this is the assumption to revisit.
 *
 * A tool call is a leaf and never goes on the stack. It is paired with its
 * result by id, and a call that never gets one — the Architect emits a
 * refused `answer` call and moves on — must not become the parent of
 * everything after it, nor the span later events land on.
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

/** A closed span, and when it began relative to the others — whatever ids it was handed. */
interface Closed {
  readonly order: number
  readonly span: Span
}

const OK: SpanStatus = { code: 'OK' }
const failed = (message: string): SpanStatus => ({ code: 'ERROR', message })

/**
 * What a failure says, and always a string. `traced` records a failure before
 * rethrowing it, so a throw here would replace the provider's error with ours:
 * `String(Object.create(null))` throws, and so does a `message` getter.
 */
const messageOf = (thrown: unknown): string => {
  try {
    return thrown instanceof Error ? String(thrown.message) : String(thrown)
  } catch {
    return 'an error that could not be printed'
  }
}

export function createTraceBuilder(options: {
  clock: () => bigint
  ids: TraceIds
  name: string
  inputs: unknown
  attributes?: Attributes
}): TraceBuilder {
  const traceId = options.ids.traceId()
  const closed: Closed[] = []
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
  /**
   * Tool calls waiting for their result, oldest first. Not keyed by id alone:
   * a model may reuse an id, and the earlier call must still be closed.
   */
  const pending: Open[] = []

  const top = (): Open => stack[stack.length - 1] ?? root

  const record = (span: Open, status: SpanStatus, end: bigint = options.clock()): void => {
    closed.push({
      order: span.order,
      span: {
        spanId: span.spanId,
        parentId: span.parentId,
        name: span.name,
        type: span.type,
        start: span.start,
        end,
        status,
        inputs: span.inputs,
        outputs: span.outputs,
        usage: span.usage,
        attributes: { ...span.attributes },
        events: [...span.events],
      },
    })
  }

  const statusOf = (span: Open): SpanStatus =>
    span.failure === undefined ? OK : failed(span.failure)

  /**
   * The status of a span something else had to close. Why it had already
   * failed is kept, not replaced: "closed by finish" says how the span ended,
   * a refusal says what went wrong, and a reader needs the second more.
   */
  const forced = (span: Open, reason: string): SpanStatus =>
    failed(span.failure === undefined ? reason : `${span.failure} (${reason})`)

  /**
   * Closes a span off the stack, and first every tool still waiting under it,
   * so no child outlives its parent. `reason` is what the tools are told.
   */
  const close = (span: Open, status: SpanStatus, reason: string): void => {
    for (let index = 0; index < pending.length; ) {
      const tool = pending[index]
      if (tool?.parentId === span.spanId) {
        pending.splice(index, 1)
        record(tool, forced(tool, reason))
      } else {
        index += 1
      }
    }
    record(span, status)
  }

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
    const reason = `closed when ${key} ended, by no event of its own`
    while (top() !== target) {
      const inner = stack.pop()
      if (inner !== undefined) close(inner, forced(inner, reason), reason)
    }
    stack.pop()
    close(target, status(target), reason)
    return true
  }

  /**
   * A span with no duration of its own: a gate's verdict, or an event that
   * fitted nowhere. It ends where it starts — a verdict is a moment, and a
   * length would be the clock's, not the gate's.
   */
  const marker = (name: string, status: SpanStatus, attributes: Attributes = {}): void => {
    const span = open(top(), name, 'CHAIN', 'marker')
    Object.assign(span.attributes, attributes)
    record(span, status, span.start)
  }

  const unbalanced = (what: string, expected: string): void =>
    marker('unbalanced event', failed(`${what} matched no open ${expected}`), { 'idp.event': what })

  const note = (name: string, attributes: Attributes): void => {
    top().events.push({ name, time: options.clock(), attributes })
  }

  /**
   * The first failure stands: a later one on the same span does not overwrite
   * why it failed. False when nothing open answers to `key`.
   */
  const fail = (key: string, message: string): boolean => {
    const span = find(key)
    if (span === undefined) return false
    span.failure ??= message
    return true
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
        // A leaf, beside whatever is open: never on the stack (see the header).
        pending.push(
          open(top(), event.name, 'TOOL', `tool:${event.id}`, {
            id: event.id,
            name: event.name,
            args: event.args,
          }),
        )
        return
      case 'tool:result': {
        // The latest call of that id: an earlier one still waiting is closed
        // with its parent, as an error that says so.
        const index = pending.findLastIndex((tool) => tool.key === `tool:${event.id}`)
        const [tool] = index === -1 ? [] : pending.splice(index, 1)
        if (tool === undefined) {
          unbalanced('tool:result', `tool call ${event.id}`)
          return
        }
        tool.outputs = { rows: event.rows, truncated: event.truncated }
        record(tool, statusOf(tool))
        return
      }
      case 'gate:passed':
        marker(`gate ${event.gate}`, OK, { 'idp.attempt': event.attempt })
        return
      case 'repair':
        marker(`gate ${event.gate}`, failed(event.reason), { 'idp.attempt': event.attempt })
        if (!fail(`attempt:${event.attempt}`, `refused at the ${event.gate} gate`)) {
          unbalanced('repair', `attempt ${event.attempt}`)
        }
        return
      case 'refused':
        // Kept wherever it lands, and said to have landed nowhere when no
        // agent of that name is open: a refusal that fails nothing is still news.
        note('refused', { agent: event.agent, reason: event.reason })
        if (!fail(`agent:${event.agent}`, event.reason)) unbalanced('refused', `agent ${event.agent}`)
        return
      case 'stopped':
        // As a refusal is: the run's own reason for ending an agent, said to
        // have landed nowhere when no agent of that name is open.
        note('stopped', { agent: event.agent, reason: event.reason })
        if (!fail(`agent:${event.agent}`, event.reason)) unbalanced('stopped', `agent ${event.agent}`)
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
        // Copied: every agent keeps one transcript and pushes onto it after
        // each call, so the array itself would show every call the agent's
        // last one. Shallow is enough, because agents only append — an entry
        // already sent is never changed.
        transcript: [...request.transcript],
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
    const reason = 'closed by finish, by no event of its own'
    while (stack.length > 1) {
      const span = stack.pop()
      if (span !== undefined) close(span, forced(span, reason), reason)
    }
    root.outputs = outcome.outputs
    Object.assign(root.attributes, outcome.attributes ?? {})
    // Closing the root closes the tools still waiting under it.
    close(root, outcome.error === undefined ? OK : failed(outcome.error), reason)
    // By the order each span opened, which travels with it: sorting on a map
    // keyed by span id put the root last the day two spans shared an id.
    const spans = [...closed].sort((left, right) => left.order - right.order).map((one) => one.span)
    finished = { traceId, spans }
    return finished
  }

  return { traceId, onEvent, modelCallStarted, modelCallEnded, finish }
}
