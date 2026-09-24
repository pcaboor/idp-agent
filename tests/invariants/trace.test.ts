import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import type { Gate } from '../../src/agents/repair.js'
import type { Answer } from '../../src/core/schemas/query.js'
import type { AgentName, GenerateRequest, GenerateResult } from '../../src/llm/client.js'
import { createTraceBuilder } from '../../src/trace/builder.js'
import { fakeClock, fakeIds } from '../support/trace.js'

const agent = fc.constantFrom<AgentName>('supervisor', 'analyst', 'inspector', 'architect', 'reviewer')
const attempt = fc.constantFrom<1 | 2 | 3>(1, 2, 3)
const gate = fc.constantFrom<Gate>('zod', 'signature', 'policy', 'reviewer', 'recheck')
const id = fc.constantFrom('c1', 'c2', 'c3')
const words = fc.string({ maxLength: 12 })

/** Every member of the union, in any order — including every order no agent would produce. */
const event: fc.Arbitrary<AgentEvent> = fc.oneof(
  fc.record({ type: fc.constant('agent:start' as const), agent }),
  fc.record({ type: fc.constant('agent:end' as const), agent, threw: fc.boolean() }),
  fc.record({ type: fc.constant('attempt:start' as const), attempt }),
  fc.record({ type: fc.constant('attempt:end' as const), attempt }),
  fc.record({ type: fc.constant('gate:passed' as const), attempt, gate }),
  fc.record({ type: fc.constant('repair' as const), attempt, gate, reason: words }),
  fc.record({ type: fc.constant('tool:call' as const), id, name: words, args: fc.jsonValue() }),
  fc.record({
    type: fc.constant('tool:result' as const),
    id,
    name: words,
    rows: fc.nat(),
    truncated: fc.nat(),
  }),
  fc.record({
    type: fc.constant('classified' as const),
    classification: fc.constantFrom<'MUTATION' | 'QUESTION'>('MUTATION', 'QUESTION'),
  }),
  fc.record({ type: fc.constant('refused' as const), agent, reason: words }),
  fc.record({ type: fc.constant('stopped' as const), agent, reason: words }),
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

type Step =
  | { readonly kind: 'event'; readonly event: AgentEvent }
  | { readonly kind: 'call'; readonly agent: AgentName }
  | { readonly kind: 'return'; readonly which: number; readonly fails: boolean }

const step: fc.Arbitrary<Step> = fc.oneof(
  event.map((one) => ({ kind: 'event' as const, event: one })),
  agent.map((one) => ({ kind: 'call' as const, agent: one })),
  fc.record({ kind: fc.constant('return' as const), which: fc.nat(), fails: fc.boolean() }),
)

const request = (who: AgentName): GenerateRequest => ({
  agent: who,
  system: 's',
  transcript: [],
  tools: [],
  toolChoice: 'none',
})
const RESULT: GenerateResult = { text: '', toolCalls: [], finishReason: 'stop' }

describe('the trace builder, over any sequence of events', () => {
  it('never throws, and always hands back one closed tree with every parent in it', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 80 }), fc.boolean(), (steps, threw) => {
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
        const trace = builder.finish(threw ? { outputs: {}, error: 'boom' } : { outputs: {} })

        const byId = new Map(trace.spans.map((span) => [span.spanId, span]))
        expect(byId.size).toBe(trace.spans.length)
        expect(trace.spans[0]?.parentId).toBeUndefined()
        expect(trace.spans.filter((span) => span.parentId === undefined)).toHaveLength(1)
        for (const span of trace.spans) {
          expect(span.end >= span.start).toBe(true)
          if (span.parentId === undefined) continue
          const parent = byId.get(span.parentId)
          expect(parent).toBeDefined()
          expect((parent?.start ?? span.start + 1n) <= span.start).toBe(true)
        }
      }),
    )
  })
})
