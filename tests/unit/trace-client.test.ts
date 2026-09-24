import { describe, expect, it } from 'vitest'
import type { GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { createTraceBuilder } from '../../src/trace/builder.js'
import { traced } from '../../src/trace/client.js'
import { fakeClock, fakeIds, skeletonOf, spanNamed } from '../support/trace.js'

const REQUEST: GenerateRequest = {
  agent: 'supervisor',
  system: 'system',
  transcript: [{ role: 'user', text: 'hello' }],
  tools: [],
  toolChoice: 'none',
}

const building = () =>
  createTraceBuilder({ clock: fakeClock(), ids: fakeIds(), name: 'idp-agent ask', inputs: {} })

describe('traced', () => {
  it('hands the inner client the request it was given, and returns its result untouched', async () => {
    const result: GenerateResult = {
      text: 'QUESTION',
      toolCalls: [],
      finishReason: 'stop',
      usage: { totalTokens: 7 },
    }
    const seen: GenerateRequest[] = []
    const inner: LlmClient = {
      generate: async (request) => {
        seen.push(request)
        return result
      },
    }
    const builder = building()

    expect(await traced(inner, builder).generate(REQUEST)).toBe(result)
    expect(seen[0]).toBe(REQUEST)
    const call = spanNamed(builder.finish({ outputs: {} }), 'supervisor call 0')
    expect(call.status).toEqual({ code: 'OK' })
    expect(call.usage).toEqual({ totalTokens: 7 })
  })

  it('rethrows the very error the inner client threw, after closing the call as failed', async () => {
    const thrown = new Error('502 from the gateway')
    const inner: LlmClient = { generate: () => Promise.reject(thrown) }
    const builder = building()

    await expect(traced(inner, builder).generate(REQUEST)).rejects.toBe(thrown)
    expect(skeletonOf(builder.finish({ outputs: {} })).children).toEqual([
      {
        name: 'supervisor call 0',
        type: 'CHAT_MODEL',
        status: 'ERROR: 502 from the gateway',
        children: [],
      },
    ])
  })
})
