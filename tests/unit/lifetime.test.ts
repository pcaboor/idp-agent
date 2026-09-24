import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { asAgent } from '../../src/agents/lifetime.js'

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

describe('asAgent', () => {
  it('announces the agent before its first turn and after its last', async () => {
    const { events, emit } = collect()

    const value = await asAgent('architect', emit, async () => {
      emit({ type: 'plan:ready', operations: 1 })
      return 42
    })

    expect(value).toBe(42)
    expect(events).toEqual([
      { type: 'agent:start', agent: 'architect' },
      { type: 'plan:ready', operations: 1 },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])
  })

  it('ends the agent it started even when the agent throws, and says that it threw', async () => {
    // A stream showing an agent that began and never ended is the defect the
    // Architect and the Reviewer each patched by hand with a `refused` before
    // rethrowing. This closes it for all five, on every path out.
    const { events, emit } = collect()
    const thrown = new Error('502 from the gateway')

    await expect(asAgent('reviewer', emit, () => Promise.reject(thrown))).rejects.toBe(thrown)

    expect(events).toEqual([
      { type: 'agent:start', agent: 'reviewer' },
      { type: 'agent:end', agent: 'reviewer', threw: true },
    ])
  })
})
