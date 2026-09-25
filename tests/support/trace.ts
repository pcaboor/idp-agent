import type { AgentEvent } from '../../src/agents/events.js'
import type { TraceSink } from '../../src/cli/trace-sink.js'
import type { TraceIds } from '../../src/trace/builder.js'
import type { Span, SpanType, Trace } from '../../src/trace/model.js'

/** Unix nanoseconds that advance one millisecond per reading, so every span has a length. */
export const fakeClock = (): (() => bigint) => {
  let now = 1_727_000_000_000_000_000n
  return () => (now += 1_000_000n)
}

/** One trace id, and span ids counted up from 1: the same tree on every run. */
export const fakeIds = (): TraceIds => {
  let span = 0
  return {
    traceId: () => '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: () => (span += 1).toString(16).padStart(16, '0'),
  }
}

/** A span's place in the tree and its verdict, without the bytes. What assertions compare. */
export interface Skeleton {
  readonly name: string
  readonly type: SpanType
  /** `OK`, or `ERROR: <message>`. */
  readonly status: string
  readonly children: readonly Skeleton[]
}

export function skeletonOf(trace: Trace): Skeleton {
  const children = new Map<string, Span[]>()
  for (const span of trace.spans) {
    if (span.parentId === undefined) continue
    children.set(span.parentId, [...(children.get(span.parentId) ?? []), span])
  }
  const build = (span: Span): Skeleton => ({
    name: span.name,
    type: span.type,
    status: span.status.code === 'OK' ? 'OK' : `ERROR: ${span.status.message}`,
    children: (children.get(span.spanId) ?? []).map(build),
  })
  const root = trace.spans[0]
  if (root === undefined) throw new Error('a trace with no span')
  return build(root)
}

/** The first span with this name — for reading its inputs, outputs, usage or events. */
export function spanNamed(trace: Trace, name: string): Span {
  const span = trace.spans.find((one) => one.name === name)
  if (span === undefined) {
    throw new Error(`no span named "${name}" among ${trace.spans.map((one) => one.name).join(', ')}`)
  }
  return span
}

/** A sink that keeps the trace itself, so a test reads the tree rather than a file or a server. */
export const memorySink = (): TraceSink & { readonly traces: Trace[] } => {
  const traces: Trace[] = []
  return { name: 'memory', traces, export: async (trace) => void traces.push(trace) }
}

export function onlyTrace(sink: { readonly traces: readonly Trace[] }): Trace {
  const [trace, ...more] = sink.traces
  if (trace === undefined || more.length > 0) {
    throw new Error(`expected one trace, got ${sink.traces.length}`)
  }
  return trace
}

/**
 * Where a trace tells a run differently from the stream it was built from.
 *
 * What is checked:
 *   - every TOOL span the builder force-closed with "…by no event of its
 *     own" carries, in `(span.inputs as { id }).id`, exactly the id of a
 *     `tool:call` the stream left unanswered — ids counted as a multiset,
 *     and the two id lists compared sorted;
 *   - a forced close on any span that is not a TOOL is a disagreement in its
 *     own right — nothing but an unanswered tool call may be forced closed;
 *   - every span named `unbalanced event` is a disagreement, named with its
 *     status message — the trace saw an event that fit no open span;
 *   - every model call sits inside an agent;
 *   - there is one AGENT span per `agent:start`;
 *   - every gate verdict on the stream is a marker with the same verdict
 *     under its attempt, in the same order.
 */
export function disagreements(trace: Trace, events: readonly AgentEvent[]): string[] {
  const problems: string[] = []
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]))

  // A tool call the stream never answered — the Architect emits one for a
  // tool it does not have, refuses it, and moves on — is an unclosed span in
  // the trace, and rightly so. Exactly those may be forced closed; any other
  // forced close is a disagreement.
  const isForcedClose = (span: Span): span is Span & { status: { code: 'ERROR'; message: string } } =>
    span.status.code === 'ERROR' && span.status.message.includes('by no event of its own')
  const forced = trace.spans.filter(isForcedClose)
  for (const span of forced) {
    if (span.type !== 'TOOL') problems.push(`${span.name}: ${span.status.message}`)
  }

  // The builder records `inputs: { id, name, args }` on every TOOL span, so
  // the id a forced-closed one carries is read off the same field a real
  // reader of the trace would.
  const orphanedIds = forced
    .filter((span) => span.type === 'TOOL')
    .map((span) => (span.inputs as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
    .sort()
  const unansweredIds = unansweredToolCallIds(events)
  if (JSON.stringify(orphanedIds) !== JSON.stringify(unansweredIds)) {
    problems.push(
      `tool spans closed by no event of their own: ${JSON.stringify(orphanedIds)}; ` +
        `the stream left unanswered: ${JSON.stringify(unansweredIds)}`,
    )
  }

  for (const span of trace.spans) {
    if (span.name === 'unbalanced event' && span.status.code === 'ERROR') {
      problems.push(`unbalanced event: ${span.status.message}`)
    }
    if (span.type === 'CHAT_MODEL' && byId.get(span.parentId ?? '')?.type !== 'AGENT') {
      problems.push(`${span.name} is not inside an agent`)
    }
  }

  const started = events.filter((event) => event.type === 'agent:start').length
  const agents = trace.spans.filter((span) => span.type === 'AGENT').length
  if (started !== agents) problems.push(`${started} agent:start events, ${agents} AGENT spans`)

  const told = events.flatMap((event) =>
    event.type === 'gate:passed'
      ? [`attempt ${event.attempt} / gate ${event.gate} / OK`]
      : event.type === 'repair'
        ? [`attempt ${event.attempt} / gate ${event.gate} / ERROR`]
        : [],
  )
  const drawn = trace.spans
    .filter((span) => span.name.startsWith('gate '))
    .map((span) => `${byId.get(span.parentId ?? '')?.name} / ${span.name} / ${span.status.code}`)
  if (JSON.stringify(told) !== JSON.stringify(drawn)) {
    problems.push(`gates: the stream told ${JSON.stringify(told)}, the trace drew ${JSON.stringify(drawn)}`)
  }
  return problems
}

/**
 * The ids of `tool:call` events the stream itself never paired with a
 * `tool:result` of the same id — ids counted as a multiset: each result of
 * an id answers one call of that id, so which ids stay unanswered does not
 * depend on the order they are paired in.
 */
function unansweredToolCallIds(events: readonly AgentEvent[]): string[] {
  const resultsById = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'tool:result') resultsById.set(event.id, (resultsById.get(event.id) ?? 0) + 1)
  }
  const unanswered: string[] = []
  for (const event of events) {
    if (event.type !== 'tool:call') continue
    const remaining = resultsById.get(event.id) ?? 0
    if (remaining > 0) resultsById.set(event.id, remaining - 1)
    else unanswered.push(event.id)
  }
  return unanswered.sort()
}
