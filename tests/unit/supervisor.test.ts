import { describe, expect, it } from 'vitest'
import { ClassificationError, classify } from '../../src/agents/supervisor.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'

const saying = (text: string): LlmClient => ({
  generate: async (): Promise<GenerateResult> => ({ text, toolCalls: [], finishReason: 'stop' }),
})

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

const INPUT = { intent: 'which databases are in prod?', summary: 'si:\n  entities: 10-99' }

describe('classify', () => {
  it('reads the two classifications the design allows', async () => {
    const { emit } = collect()
    expect(await classify(saying('QUESTION'), INPUT, emit)).toBe('QUESTION')
    expect(await classify(saying('MUTATION'), INPUT, emit)).toBe('MUTATION')
  })

  it('tolerates surrounding whitespace and case, which is formatting, not meaning', async () => {
    const { emit } = collect()
    expect(await classify(saying('  question\n'), INPUT, emit)).toBe('QUESTION')
  })

  it('refuses a third answer rather than defaulting to one of the two', async () => {
    // Declare, never infer: a model that answered UNCLEAR has not classified,
    // and picking QUESTION for it would be guessing on the user's behalf.
    const { emit } = collect()
    await expect(classify(saying('UNCLEAR'), INPUT, emit)).rejects.toThrow(ClassificationError)
  })

  it('refuses a classification buried in a sentence', async () => {
    // It was asked for one word. A sentence is a refusal to classify, not a
    // classification to rescue by substring matching.
    const { emit } = collect()
    await expect(
      classify(saying('I think this is a QUESTION about databases'), INPUT, emit),
    ).rejects.toThrow(ClassificationError)
  })

  it('refuses an empty answer', async () => {
    const { emit } = collect()
    await expect(classify(saying('   '), INPUT, emit)).rejects.toThrow(ClassificationError)
  })

  it('quotes what it got, so the failure can be diagnosed', async () => {
    const { emit } = collect()
    await expect(classify(saying('PERHAPS'), INPUT, emit)).rejects.toThrow(/PERHAPS/)
  })

  it('emits the start of the agent, then what it decided, in that order', async () => {
    const { events, emit } = collect()
    await classify(saying('QUESTION'), INPUT, emit)
    expect(events).toEqual([
      { type: 'agent:start', agent: 'supervisor' },
      { type: 'classified', classification: 'QUESTION' },
    ])
  })

  it('emits a refusal before it throws, so the failure is never silent', async () => {
    const { events, emit } = collect()
    await classify(saying('UNCLEAR'), INPUT, emit).catch(() => {})
    expect(events.at(-1)).toMatchObject({ type: 'refused', agent: 'supervisor' })
  })

  it('gives the model no tools, as the design specifies', async () => {
    const seen: GenerateRequest[] = []
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request)
        return { text: 'QUESTION', toolCalls: [], finishReason: 'stop' }
      },
    }
    const { emit } = collect()
    await classify(client, INPUT, emit)
    expect(seen[0]?.tools).toEqual([])
    expect(seen[0]?.toolChoice).toBe('none')
    expect(seen[0]?.agent).toBe('supervisor')
  })

  it('sends the request and the summary, and nothing it was not given', async () => {
    const seen: GenerateRequest[] = []
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request)
        return { text: 'QUESTION', toolCalls: [], finishReason: 'stop' }
      },
    }
    const { emit } = collect()
    await classify(client, INPUT, emit)
    const sent = JSON.stringify(seen[0]?.transcript)
    expect(sent).toContain('which databases are in prod?')
    expect(sent).toContain('entities: 10-99')
  })
})
