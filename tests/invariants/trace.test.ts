import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import type { Gate } from '../../src/agents/repair.js'
import type { Answer } from '../../src/core/schemas/query.js'
import type { AgentName, GenerateRequest, GenerateResult } from '../../src/llm/client.js'
import { createTraceBuilder } from '../../src/trace/builder.js'
import type { Span, Trace } from '../../src/trace/model.js'
import { fakeClock, fakeIds } from '../support/trace.js'

const agent = fc.constantFrom<AgentName>('supervisor', 'analyst', 'inspector', 'architect', 'reviewer')
const attempt = fc.constantFrom<1 | 2 | 3>(1, 2, 3)
const gate = fc.constantFrom<Gate>('zod', 'signature', 'policy', 'reviewer', 'recheck')
const id = fc.constantFrom('c1', 'c2', 'c3')
const words = fc.string({ maxLength: 12 })
const args = fc.jsonValue({ maxDepth: 2 })

/** The events that bound nothing: each lands on whatever span is open. */
const note: fc.Arbitrary<AgentEvent> = fc.oneof(
  fc.record({
    type: fc.constant('classified' as const),
    classification: fc.constantFrom<'MUTATION' | 'QUESTION'>('MUTATION', 'QUESTION'),
  }),
  fc.record({ type: fc.constant('retry' as const), agent, reason: words }),
  fc.record({ type: fc.constant('plan:ready' as const), operations: fc.nat() }),
  fc.record({
    type: fc.constant('answer:ready' as const),
    outcome: fc.constantFrom<Answer['outcome']>('entities', 'nothing', 'overview', 'unanswerable'),
    refs: fc.array(words, { maxLength: 3 }),
  }),
  fc.record({
    type: fc.constant('derived' as const),
    path: words,
    owner: words,
    from: fc.array(words, { maxLength: 3 }),
  }),
  fc.record({
    type: fc.constant('overridden' as const),
    path: words,
    owner: words,
    determined: words,
    from: fc.array(words, { maxLength: 3 }),
  }),
  fc.record(
    {
      type: fc.constant('reapplied' as const),
      path: words,
      value: words,
      entity: words,
      answeredAt: words,
      replaced: words,
    },
    { requiredKeys: ['type', 'path', 'value', 'entity', 'answeredAt'] },
  ),
  fc.record({ type: fc.constant('ask' as const), question: fc.record({ path: words, question: words }) }),
)

/** Every member of the union, in any order — including every order no agent would produce. */
const event: fc.Arbitrary<AgentEvent> = fc.oneof(
  fc.record({ type: fc.constant('agent:start' as const), agent }),
  fc.record({ type: fc.constant('agent:end' as const), agent, threw: fc.boolean() }),
  fc.record({ type: fc.constant('attempt:start' as const), attempt }),
  fc.record(
    { type: fc.constant('attempt:end' as const), attempt, stopped: words },
    { requiredKeys: ['type', 'attempt'] },
  ),
  fc.record({ type: fc.constant('gate:passed' as const), attempt, gate }),
  fc.record({ type: fc.constant('repair' as const), attempt, gate, reason: words }),
  fc.record({ type: fc.constant('tool:call' as const), id, name: words, args }),
  fc.record(
    {
      type: fc.constant('tool:result' as const),
      id,
      name: words,
      rows: fc.nat(),
      truncated: fc.nat(),
      error: words,
    },
    { requiredKeys: ['type', 'id', 'name', 'rows', 'truncated'] },
  ),
  fc.record({ type: fc.constant('refused' as const), agent, reason: words }),
  fc.record({ type: fc.constant('stopped' as const), agent, reason: words }),
  note,
)

type Step =
  | { readonly kind: 'event'; readonly event: AgentEvent }
  | { readonly kind: 'call'; readonly agent: AgentName }
  | { readonly kind: 'return'; readonly which: number; readonly fails: boolean }

const step: fc.Arbitrary<Step> = fc.oneof(
  event.map((one) => ({ kind: 'event' as const, event: one })),
  agent.map((one) => ({ kind: 'call' as const, agent: one })),
  fc.record({ kind: fc.constant('return' as const), which: fc.nat(), fails: fc.boolean() }),
)

/**
 * A run as the harness produces one: every block closed by its own event, in
 * the order it opened. Generated as a tree, then walked into steps.
 */
type Block =
  | {
      readonly kind: 'agent'
      readonly agent: AgentName
      readonly threw: boolean
      readonly body: readonly Block[]
    }
  | {
      readonly kind: 'attempt'
      readonly attempt: 1 | 2 | 3
      /** Why it ended with no verdict — no opinion, no draft, a throw — when it did. */
      readonly stopped: string | undefined
      readonly body: readonly Block[]
    }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly args: unknown
      readonly rows: number
      /** The tool refused the call. */
      readonly error: string | undefined
    }
  | { readonly kind: 'model'; readonly agent: AgentName; readonly fails: boolean }
  | { readonly kind: 'gate'; readonly attempt: 1 | 2 | 3; readonly gate: Gate }
  | {
      readonly kind: 'repair'
      readonly attempt: 1 | 2 | 3
      readonly gate: Gate
      readonly reason: string
    }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly reason: string }
  | { readonly kind: 'note'; readonly event: AgentEvent }

const { block } = fc.letrec<{ block: Block; body: readonly Block[] }>((tie) => ({
  block: fc.oneof(
    // The leaves come first: that is where oneof goes once the tree is deep.
    // The blocks that nest weigh three: at one, half the runs held no agent.
    { depthSize: 'small', withCrossShrink: true },
    fc.record({ kind: fc.constant('note' as const), event: note }),
    fc.record({ kind: fc.constant('gate' as const), attempt, gate }),
    fc.record({ kind: fc.constant('repair' as const), attempt, gate, reason: words }),
    fc.record({ kind: fc.constant('refused' as const), reason: words }),
    fc.record({ kind: fc.constant('stopped' as const), reason: words }),
    fc.record({
      kind: fc.constant('tool' as const),
      id,
      name: words,
      args,
      rows: fc.nat(),
      error: fc.option(words, { nil: undefined }),
    }),
    fc.record({ kind: fc.constant('model' as const), agent, fails: fc.boolean() }),
    {
      arbitrary: fc.record({
        kind: fc.constant('agent' as const),
        agent,
        threw: fc.boolean(),
        body: tie('body'),
      }),
      weight: 3,
    },
    {
      arbitrary: fc.record({
        kind: fc.constant('attempt' as const),
        attempt,
        stopped: fc.option(words, { nil: undefined }),
        body: tie('body'),
      }),
      weight: 3,
    },
  ),
  body: fc.array(tie('block'), { maxLength: 6 }),
}))
/** About fifty steps on average, and three runs in four with an agent in them. */
const run = fc.array(block, { maxLength: 10, size: 'max' })

/**
 * What an agent's span must say: its first refusal or stop, else whether it
 * threw.
 */
interface Verdict {
  failure: string | undefined
  readonly threw: boolean
}

interface OpenAgent {
  readonly agent: AgentName
  readonly verdict: Verdict
}

/** What an attempt's span must say: the gate that first refused it, else why it stopped. */
interface AttemptVerdict {
  failure: string | undefined
}

interface OpenAttempt {
  readonly attempt: 1 | 2 | 3
  readonly verdict: AttemptVerdict
}

/** What each span of a well-formed run must end on, each kind in the order it began. */
interface Verdicts {
  readonly agents: Verdict[]
  readonly attempts: AttemptVerdict[]
  /** A tool's own error, or undefined when it answered. */
  readonly tools: (string | undefined)[]
}

/**
 * The steps a well-formed run emits, and the verdict each span must end on.
 * A refusal or a stop names the innermost open agent and a repair the
 * innermost open attempt, as they do in the harness; one with nothing open to
 * name is emitted as the nearest event that needs nothing.
 */
function walk(body: readonly Block[]): { steps: Step[]; verdicts: Verdicts } {
  const steps: Step[] = []
  const verdicts: Verdicts = { agents: [], attempts: [], tools: [] }
  let calls = 0
  const emit = (one: AgentEvent): void => {
    steps.push({ kind: 'event', event: one })
  }
  const visit = (
    blocks: readonly Block[],
    agents: readonly OpenAgent[],
    attempts: readonly OpenAttempt[],
  ): void => {
    for (const block of blocks) {
      switch (block.kind) {
        case 'agent': {
          const verdict: Verdict = { failure: undefined, threw: block.threw }
          verdicts.agents.push(verdict)
          emit({ type: 'agent:start', agent: block.agent })
          visit(block.body, [...agents, { agent: block.agent, verdict }], attempts)
          emit({ type: 'agent:end', agent: block.agent, threw: block.threw })
          break
        }
        case 'attempt': {
          const verdict: AttemptVerdict = { failure: undefined }
          verdicts.attempts.push(verdict)
          emit({ type: 'attempt:start', attempt: block.attempt })
          visit(block.body, agents, [...attempts, { attempt: block.attempt, verdict }])
          // The first failure stands: a gate that refused it outranks the stop.
          if (block.stopped !== undefined) verdict.failure ??= block.stopped
          emit({
            type: 'attempt:end',
            attempt: block.attempt,
            ...(block.stopped === undefined ? {} : { stopped: block.stopped }),
          })
          break
        }
        case 'tool':
          verdicts.tools.push(block.error)
          emit({ type: 'tool:call', id: block.id, name: block.name, args: block.args })
          emit({
            type: 'tool:result',
            id: block.id,
            name: block.name,
            rows: block.rows,
            truncated: 0,
            ...(block.error === undefined ? {} : { error: block.error }),
          })
          break
        case 'model':
          steps.push({ kind: 'call', agent: block.agent })
          steps.push({ kind: 'return', which: calls, fails: block.fails })
          calls += 1
          break
        case 'gate':
          emit({ type: 'gate:passed', attempt: attempts.at(-1)?.attempt ?? block.attempt, gate: block.gate })
          break
        case 'repair': {
          const open = attempts.at(-1)
          if (open === undefined) {
            emit({ type: 'gate:passed', attempt: block.attempt, gate: block.gate })
            break
          }
          open.verdict.failure ??= `refused at the ${block.gate} gate`
          emit({ type: 'repair', attempt: open.attempt, gate: block.gate, reason: block.reason })
          break
        }
        case 'refused':
        case 'stopped': {
          const open = agents.at(-1)
          if (open === undefined) {
            emit({ type: 'retry', agent: 'architect', reason: block.reason })
            break
          }
          open.verdict.failure ??= block.reason
          emit({ type: block.kind, agent: open.agent, reason: block.reason })
          break
        }
        case 'note':
          emit(block.event)
          break
        default: {
          const exhaustive: never = block
          return exhaustive
        }
      }
    }
  }
  visit(body, [], [])
  return { steps, verdicts }
}

const request = (who: AgentName): GenerateRequest => ({
  agent: who,
  system: 's',
  transcript: [],
  tools: [],
  toolChoice: 'none',
})
const RESULT: GenerateResult = { text: '', toolCalls: [], finishReason: 'stop' }

function traceOf(steps: readonly Step[], threw: boolean): Trace {
  const builder = createTraceBuilder({
    clock: fakeClock(),
    ids: fakeIds(),
    name: 'idp-agent plan',
    inputs: {},
  })
  const handles: string[] = []
  for (const one of steps) {
    if (one.kind === 'event') builder.onEvent(one.event)
    else if (one.kind === 'call') handles.push(builder.modelCallStarted(request(one.agent)))
    else {
      // A handle already closed, or none at all, is as legal an input as a live one.
      const handle = handles[one.which % Math.max(handles.length, 1)] ?? 'model:none:0'
      builder.modelCallEnded(handle, one.fails ? { error: new Error('boom') } : { result: RESULT })
    }
  }
  return builder.finish(threw ? { outputs: {}, error: 'boom' } : { outputs: {} })
}

const isGate = (span: Span): boolean => span.type === 'CHAIN' && span.name.startsWith('gate ')

/** What holds of any trace, whatever it was fed. */
function holdsOfAnyTrace(trace: Trace, steps: readonly Step[]): void {
  // One closed tree: unique ids, one root and it comes first, every parent in it.
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]))
  expect(byId.size).toBe(trace.spans.length)
  expect(trace.spans[0]?.parentId).toBeUndefined()
  expect(trace.spans.filter((span) => span.parentId === undefined)).toHaveLength(1)
  for (const span of trace.spans) {
    expect(span.end >= span.start).toBe(true)
    if (span.parentId === undefined) continue
    const parent = byId.get(span.parentId)
    expect(parent).toBeDefined()
    if (parent === undefined) continue
    // Inside its parent in time, not only in the tree: MLflow draws the one
    // from the other.
    expect(span.start >= parent.start).toBe(true)
    expect(span.end <= parent.end).toBe(true)
  }
  for (const span of trace.spans.filter(isGate)) expect(span.end).toBe(span.start)

  // Nothing dropped: every span something asked for is in the trace.
  const events = steps.flatMap((one) => (one.kind === 'event' ? [one.event] : []))
  const emitted = (type: AgentEvent['type']): number => events.filter((one) => one.type === type).length
  const spans = (test: (span: Span) => boolean): number => trace.spans.filter(test).length
  expect(spans((span) => span.type === 'AGENT')).toBe(emitted('agent:start'))
  expect(spans((span) => span.type === 'CHAT_MODEL')).toBe(steps.filter((one) => one.kind === 'call').length)
  expect(spans((span) => span.type === 'TOOL')).toBe(emitted('tool:call'))
  expect(spans(isGate)).toBe(emitted('gate:passed') + emitted('repair'))
  expect(spans((span) => span.type === 'CHAIN' && span.name.startsWith('attempt '))).toBe(
    emitted('attempt:start'),
  )
}

describe('the trace builder, over any sequence of events', () => {
  it('never throws, drops nothing, and always hands back one closed tree nested in time', () => {
    fc.assert(
      // `size: 'max'`, or fast-check's default size keeps the array near ten
      // steps whatever maxLength says, and a call rarely meets its result.
      fc.property(fc.array(step, { maxLength: 80, size: 'max' }), fc.boolean(), (steps, threw) => {
        holdsOfAnyTrace(traceOf(steps, threw), steps)
      }),
    )
  })
})

describe('the trace builder, over a run the harness could produce', () => {
  it('closes every span by its own event, and fails a span only for a reason of its own', () => {
    fc.assert(
      fc.property(run, fc.boolean(), (body, threw) => {
        const { steps, verdicts } = walk(body)
        const trace = traceOf(steps, threw)
        holdsOfAnyTrace(trace, steps)

        expect(trace.spans.filter((span) => span.name === 'unbalanced event')).toEqual([])
        const forced = trace.spans.filter(
          (span) => span.status.code === 'ERROR' && span.status.message.includes('by no event of its own'),
        )
        expect(forced).toEqual([])
        // In the order they began, which is the order the walk met them. An
        // agent: its first refusal or stop, else its throw. An attempt: the
        // gate that first refused it, else why it stopped. A tool: its error.
        const statuses = (test: (span: Span) => boolean): unknown[] =>
          trace.spans.filter(test).map((span) => span.status)
        const failedWith = (failure: string | undefined): unknown =>
          failure === undefined ? { code: 'OK' } : { code: 'ERROR', message: failure }
        expect(statuses((span) => span.type === 'AGENT')).toEqual(
          verdicts.agents.map((verdict) =>
            failedWith(verdict.failure ?? (verdict.threw ? 'the agent threw' : undefined)),
          ),
        )
        expect(statuses((span) => span.type === 'CHAIN' && span.name.startsWith('attempt '))).toEqual(
          verdicts.attempts.map((verdict) => failedWith(verdict.failure)),
        )
        expect(statuses((span) => span.type === 'TOOL')).toEqual(verdicts.tools.map(failedWith))
      }),
    )
  })
})
