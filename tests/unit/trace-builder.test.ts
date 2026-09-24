import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../../src/agents/events.js'
import type { AgentName, GenerateRequest, GenerateResult } from '../../src/llm/client.js'
import { createTraceBuilder, type TraceBuilder } from '../../src/trace/builder.js'
import { fakeClock, fakeIds, skeletonOf, spanNamed } from '../support/trace.js'

const building = (): TraceBuilder =>
  createTraceBuilder({
    clock: fakeClock(),
    ids: fakeIds(),
    name: 'idp-agent plan',
    inputs: { command: 'plan', intent: 'give billing-api read access' },
    attributes: { 'idp.mode': 'scripted' },
  })

const request = (agent: AgentName): GenerateRequest => ({
  agent,
  system: 'system',
  transcript: [{ role: 'user', text: 'hello' }],
  tools: [],
  toolChoice: 'none',
})

const RESULT: GenerateResult = { text: 'QUESTION', toolCalls: [], finishReason: 'stop' }
const DONE = { outputs: { exitCode: 0 } }

const emitAll = (builder: TraceBuilder, events: readonly AgentEvent[]): void => {
  for (const event of events) builder.onEvent(event)
}

describe('the root', () => {
  it('is the command, with what it was asked and what it answered', () => {
    const trace = building().finish({ outputs: { exitCode: 3 }, attributes: { 'idp.exit_code': 3 } })
    const root = trace.spans[0]

    expect(trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(root?.parentId).toBeUndefined()
    expect(root?.name).toBe('idp-agent plan')
    expect(root?.type).toBe('CHAIN')
    expect(root?.inputs).toEqual({ command: 'plan', intent: 'give billing-api read access' })
    expect(root?.outputs).toEqual({ exitCode: 3 })
    expect(root?.attributes).toEqual({ 'idp.mode': 'scripted', 'idp.exit_code': 3 })
    expect(root?.status).toEqual({ code: 'OK' })
  })

  it('fails when the run threw, with the message', () => {
    const trace = building().finish({ outputs: { exitCode: 1 }, error: 'recording needs a configured model' })
    expect(trace.spans[0]?.status).toEqual({ code: 'ERROR', message: 'recording needs a configured model' })
  })
})

describe('agents, model calls and tools', () => {
  it('nests an agent’s model calls and tools inside it', () => {
    const builder = building()
    builder.onEvent({ type: 'agent:start', agent: 'analyst' })
    builder.modelCallEnded(builder.modelCallStarted(request('analyst')), { result: RESULT })
    builder.onEvent({ type: 'tool:call', id: 'c1', name: 'search_entities', args: { env: 'prod' } })
    builder.onEvent({ type: 'tool:result', id: 'c1', name: 'search_entities', rows: 3, truncated: 1 })
    builder.onEvent({ type: 'agent:end', agent: 'analyst', threw: false })
    const trace = builder.finish(DONE)

    expect(skeletonOf(trace)).toEqual({
      name: 'idp-agent plan',
      type: 'CHAIN',
      status: 'OK',
      children: [
        {
          name: 'analyst',
          type: 'AGENT',
          status: 'OK',
          children: [
            { name: 'analyst call 0', type: 'CHAT_MODEL', status: 'OK', children: [] },
            { name: 'search_entities', type: 'TOOL', status: 'OK', children: [] },
          ],
        },
      ],
    })
    expect(spanNamed(trace, 'search_entities').inputs).toEqual({
      id: 'c1',
      name: 'search_entities',
      args: { env: 'prod' },
    })
    // Truncation is stated in the trace as on stderr: never silent.
    expect(spanNamed(trace, 'search_entities').outputs).toEqual({ rows: 3, truncated: 1 })
  })

  it('records what the model was sent and what it answered', () => {
    const builder = building()
    builder.modelCallEnded(builder.modelCallStarted(request('supervisor')), { result: RESULT })
    const call = spanNamed(builder.finish(DONE), 'supervisor call 0')

    expect(call.inputs).toEqual({
      system: 'system',
      transcript: [{ role: 'user', text: 'hello' }],
      tools: [],
      toolChoice: 'none',
    })
    expect(call.outputs).toEqual({ text: 'QUESTION', toolCalls: [], finishReason: 'stop' })
  })

  it('names the tools a model was offered, never their schemas', () => {
    const builder = building()
    const offered: GenerateRequest = {
      ...request('analyst'),
      tools: [
        { name: 'search_entities', description: 'find entities', parameters: z.object({ env: z.string() }) },
      ],
    }
    builder.modelCallEnded(builder.modelCallStarted(offered), { result: RESULT })

    expect(spanNamed(builder.finish(DONE), 'analyst call 0').inputs).toMatchObject({
      tools: [{ name: 'search_entities', description: 'find entities' }],
    })
  })

  it('numbers each agent’s model calls on their own', () => {
    const builder = building()
    for (const agent of ['supervisor', 'supervisor', 'analyst'] as const) {
      builder.modelCallEnded(builder.modelCallStarted(request(agent)), { result: RESULT })
    }
    expect(builder.finish(DONE).spans.map((span) => span.name)).toEqual([
      'idp-agent plan',
      'supervisor call 0',
      'supervisor call 1',
      'analyst call 0',
    ])
  })

  it('keeps the usage a provider reported, and says so when it reported none', () => {
    const builder = building()
    builder.modelCallEnded(builder.modelCallStarted(request('architect')), {
      result: { ...RESULT, usage: { inputTokens: 900, outputTokens: 40 } },
    })
    builder.modelCallEnded(builder.modelCallStarted(request('architect')), { result: RESULT })
    const trace = builder.finish(DONE)

    expect(spanNamed(trace, 'architect call 0').usage).toEqual({ inputTokens: 900, outputTokens: 40 })
    expect(spanNamed(trace, 'architect call 0').attributes).toEqual({})
    // Absent is not zero: a recording made before usage was stored has none.
    expect(spanNamed(trace, 'architect call 1').usage).toBeUndefined()
    expect(spanNamed(trace, 'architect call 1').attributes).toEqual({ 'idp.usage': 'absent' })
  })

  it('closes a model call that failed as an error, with what the provider said', () => {
    const builder = building()
    builder.modelCallEnded(builder.modelCallStarted(request('reviewer')), {
      error: new Error('502 from the gateway'),
    })
    expect(spanNamed(builder.finish(DONE), 'reviewer call 0').status).toEqual({
      code: 'ERROR',
      message: '502 from the gateway',
    })
  })
})

describe('an agent’s outcome', () => {
  it('fails an agent that refused, and keeps the refusal as an event on it', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'architect' },
      { type: 'refused', agent: 'architect', reason: 'the draft ended with no proposal' },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])
    const trace = builder.finish(DONE)

    expect(spanNamed(trace, 'architect').status).toEqual({
      code: 'ERROR',
      message: 'the draft ended with no proposal',
    })
    expect(spanNamed(trace, 'architect').events.map((event) => [event.name, event.attributes])).toEqual([
      ['refused', { agent: 'architect', reason: 'the draft ended with no proposal' }],
    ])
  })

  it('fails an agent that threw', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'reviewer' },
      { type: 'agent:end', agent: 'reviewer', threw: true },
    ])
    expect(spanNamed(builder.finish(DONE), 'reviewer').status).toEqual({
      code: 'ERROR',
      message: 'the agent threw',
    })
  })

  it('keeps what happened inside an agent as events on it, in order, without failing it', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'architect' },
      { type: 'retry', agent: 'architect', reason: 'spec.owner: invalid' },
      { type: 'plan:ready', operations: 2 },
      {
        type: 'derived',
        path: 'operations.0.entity.spec.owner',
        owner: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
      {
        type: 'overridden',
        path: 'operations.1.entity.spec.owner',
        owner: 'group:default/lion',
        determined: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
      { type: 'ask', question: { path: 'operations.0.entity.metadata.env', question: 'which environment?' } },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])
    const architect = spanNamed(builder.finish(DONE), 'architect')

    // A retry is a correction inside the agent, not its outcome.
    expect(architect.status).toEqual({ code: 'OK' })
    expect(architect.events.map((event) => [event.name, event.attributes])).toEqual([
      ['retry', { agent: 'architect', reason: 'spec.owner: invalid' }],
      ['plan:ready', { operations: 2 }],
      [
        'derived',
        { path: 'operations.0.entity.spec.owner', owner: 'group:default/tiger', from: 'component:default/billing-api' },
      ],
      [
        'overridden',
        {
          path: 'operations.1.entity.spec.owner',
          owner: 'group:default/lion',
          determined: 'group:default/tiger',
          from: 'component:default/billing-api',
        },
      ],
      ['ask', { path: 'operations.0.entity.metadata.env', question: 'which environment?' }],
    ])
  })

  it('keeps a classification and an answer on the agent that gave them', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'supervisor' },
      { type: 'classified', classification: 'QUESTION' },
      { type: 'agent:end', agent: 'supervisor', threw: false },
      { type: 'agent:start', agent: 'analyst' },
      { type: 'answer:ready', outcome: 'entities', refs: ['resource:default/a', 'resource:default/b'] },
      { type: 'agent:end', agent: 'analyst', threw: false },
    ])
    const trace = builder.finish(DONE)

    expect(spanNamed(trace, 'supervisor').events.map((event) => [event.name, event.attributes])).toEqual([
      ['classified', { classification: 'QUESTION' }],
    ])
    expect(spanNamed(trace, 'analyst').events.map((event) => [event.name, event.attributes])).toEqual([
      ['answer:ready', { outcome: 'entities', refs: 'resource:default/a, resource:default/b' }],
    ])
  })
})

describe('the repair loop', () => {
  it('puts each attempt’s gates under it, and fails the attempt a gate refused', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'attempt:start', attempt: 1 },
      { type: 'gate:passed', attempt: 1, gate: 'zod' },
      { type: 'gate:passed', attempt: 1, gate: 'signature' },
      { type: 'repair', attempt: 1, gate: 'policy', reason: 'environment-mismatch at operations.0' },
      { type: 'attempt:end', attempt: 1 },
      { type: 'attempt:start', attempt: 2 },
      { type: 'gate:passed', attempt: 2, gate: 'zod' },
      { type: 'attempt:end', attempt: 2 },
    ])

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'attempt 1',
        type: 'CHAIN',
        status: 'ERROR: refused at the policy gate',
        children: [
          { name: 'gate zod', type: 'CHAIN', status: 'OK', children: [] },
          { name: 'gate signature', type: 'CHAIN', status: 'OK', children: [] },
          {
            name: 'gate policy',
            type: 'CHAIN',
            status: 'ERROR: environment-mismatch at operations.0',
            children: [],
          },
        ],
      },
      {
        name: 'attempt 2',
        type: 'CHAIN',
        status: 'OK',
        children: [{ name: 'gate zod', type: 'CHAIN', status: 'OK', children: [] }],
      },
    ])
  })

  it('puts the agents an attempt ran inside it, beside its gates', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'attempt:start', attempt: 1 },
      { type: 'agent:start', agent: 'architect' },
      { type: 'agent:end', agent: 'architect', threw: false },
      { type: 'gate:passed', attempt: 1, gate: 'zod' },
      { type: 'agent:start', agent: 'reviewer' },
      { type: 'agent:end', agent: 'reviewer', threw: false },
      { type: 'gate:passed', attempt: 1, gate: 'reviewer' },
      { type: 'attempt:end', attempt: 1 },
    ])

    expect(skeletonOf(builder.finish(DONE)).children[0]?.children.map((child) => child.name)).toEqual([
      'architect',
      'gate zod',
      'reviewer',
      'gate reviewer',
    ])
  })
})

describe('an event that fits nowhere', () => {
  it('is reported as an unbalanced event, never thrown and never dropped', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:end', agent: 'reviewer', threw: false },
      { type: 'tool:result', id: 'c9', name: 'read_file', rows: 1, truncated: 0 },
      { type: 'attempt:end', attempt: 2 },
    ])
    builder.modelCallEnded('model:reviewer:7', { result: RESULT })

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: agent:end matched no open agent reviewer',
        children: [],
      },
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: tool:result matched no open tool call c9',
        children: [],
      },
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: attempt:end matched no open attempt 2',
        children: [],
      },
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: model call end matched no open model:reviewer:7',
        children: [],
      },
    ])
  })

  it('closes what an agent left open when the agent ends, as an error that says so', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'architect' },
      { type: 'tool:call', id: 'c1', name: 'read_file', args: {} },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'architect',
        type: 'AGENT',
        status: 'OK',
        children: [
          {
            name: 'read_file',
            type: 'TOOL',
            status: 'ERROR: closed when agent:architect ended, by no event of its own',
            children: [],
          },
        ],
      },
    ])
  })

  it('closes what nothing closed at finish, as an error that says so', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'inspector' },
      { type: 'tool:call', id: 'c1', name: 'read_file', args: {} },
    ])

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'inspector',
        type: 'AGENT',
        status: 'ERROR: closed by finish, by no event of its own',
        children: [
          {
            name: 'read_file',
            type: 'TOOL',
            status: 'ERROR: closed by finish, by no event of its own',
            children: [],
          },
        ],
      },
    ])
  })
})

describe('finish', () => {
  it('hands back the same trace twice, and ignores what arrives after it', () => {
    const builder = building()
    const first = builder.finish(DONE)

    builder.onEvent({ type: 'agent:start', agent: 'analyst' })
    builder.modelCallEnded(builder.modelCallStarted(request('analyst')), { result: RESULT })

    expect(builder.finish({ outputs: { exitCode: 1 } })).toBe(first)
    expect(first.spans).toHaveLength(1)
  })

  it('lists the root first, then every span in the order it began', () => {
    const builder = building()
    emitAll(builder, [{ type: 'agent:start', agent: 'supervisor' }])
    builder.modelCallEnded(builder.modelCallStarted(request('supervisor')), { result: RESULT })
    emitAll(builder, [
      { type: 'agent:end', agent: 'supervisor', threw: false },
      { type: 'attempt:start', attempt: 1 },
      { type: 'gate:passed', attempt: 1, gate: 'zod' },
      { type: 'attempt:end', attempt: 1 },
    ])
    const spans = builder.finish(DONE).spans

    expect(spans.map((span) => span.name)).toEqual([
      'idp-agent plan',
      'supervisor',
      'supervisor call 0',
      'attempt 1',
      'gate zod',
    ])
    const starts = spans.map((span) => span.start)
    expect(starts).toEqual([...starts].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
  })
})
