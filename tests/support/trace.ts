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
 * What must hold whatever the model chose: every span was closed by an event
 * of its own, except a tool call the stream never answered, every model call
 * sits inside an agent, there is one AGENT span per `agent:start`, and every
 * gate verdict on the stream is a marker with the same verdict under its
 * attempt, in the same order.
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
  const unanswered =
    events.filter((event) => event.type === 'tool:call').length -
    events.filter((event) => event.type === 'tool:result').length
  const orphans = forced.filter((span) => span.type === 'TOOL').length
  if (orphans !== unanswered) {
    problems.push(`${orphans} tool span(s) closed by no event of their own; the stream left ${unanswered} call(s) unanswered`)
  }
  for (const span of trace.spans) {
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
