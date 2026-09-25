import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { createTraceBuilder, type TraceBuilder } from '../../src/trace/builder.js'
import { disagreements, fakeClock, fakeIds } from '../support/trace.js'

/**
 * `disagreements` itself, built directly through the builder API — never
 * through `main` — so each case isolates one way a trace can tell the run
 * differently from the stream it was built from.
 */
const building = (): TraceBuilder =>
  createTraceBuilder({
    clock: fakeClock(),
    ids: fakeIds(),
    name: 'idp-agent ask',
    inputs: { command: 'ask' },
  })

describe('disagreements', () => {
  it('an honest orphan — a tool:call with no result — is not a disagreement', () => {
    const call: AgentEvent = { type: 'tool:call', id: 'B', name: 'search_entities', args: {} }
    const builder = building()
    builder.onEvent(call)
    const trace = builder.finish({ outputs: { exitCode: 0 } })

    expect(disagreements(trace, [call])).toEqual([])
  })

  it('catches a trace and a stream that disagree about which call went unanswered', () => {
    // The trace: A gets its result, B is left hanging and force-closed at finish.
    const builder = building()
    builder.onEvent({ type: 'tool:call', id: 'A', name: 'search_entities', args: {} })
    builder.onEvent({ type: 'tool:call', id: 'B', name: 'search_entities', args: {} })
    builder.onEvent({ type: 'tool:result', id: 'A', name: 'search_entities', rows: 1, truncated: 0 })
    const trace = builder.finish({ outputs: { exitCode: 0 } })

    // A stream telling the opposite story: B answered, A left hanging. Same
    // calls, a different result — checked against the trace built above.
    const claimed: AgentEvent[] = [
      { type: 'tool:call', id: 'A', name: 'search_entities', args: {} },
      { type: 'tool:call', id: 'B', name: 'search_entities', args: {} },
      { type: 'tool:result', id: 'B', name: 'search_entities', rows: 1, truncated: 0 },
    ]

    expect(disagreements(trace, claimed)).not.toEqual([])
  })

  it('an extra agent:end yields a disagreement naming the unbalanced event', () => {
    const event: AgentEvent = { type: 'agent:end', agent: 'analyst', threw: false }
    const builder = building()
    builder.onEvent(event)
    const trace = builder.finish({ outputs: { exitCode: 0 } })

    expect(disagreements(trace, [event])).toEqual([expect.stringContaining('unbalanced event')])
  })

  it('a forced close on an AGENT span — agent:start never ended — is a disagreement', () => {
    const event: AgentEvent = { type: 'agent:start', agent: 'analyst' }
    const builder = building()
    builder.onEvent(event)
    const trace = builder.finish({ outputs: { exitCode: 0 } })

    expect(disagreements(trace, [event])).toEqual([
      expect.stringContaining('closed by finish, by no event of its own'),
    ])
  })
})
