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
