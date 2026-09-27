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

  it.each(['Question.', '**QUESTION**', '`mutation`', '"Question"', 'QUESTION!', '*Mutation*.'])(
    'reads %s as the word it decorates: punctuation and markdown are formatting',
    async (said) => {
      // A decorated word used to end the run on exit 3, as though the request
      // had been understood and declined (gap-ask-grounding-7).
      const { emit } = collect()
      expect(await classify(saying(said), INPUT, emit)).toBe(
        said.toUpperCase().includes('QUESTION') ? 'QUESTION' : 'MUTATION',
      )
    },
  )

  it('asks once more when the answer is no word, and reads the second', async () => {
    const seen: GenerateRequest[] = []
    const answers = ['I think this is a QUESTION about databases', 'QUESTION']
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request)
        return { text: answers[seen.length - 1] ?? '', toolCalls: [], finishReason: 'stop' }
      },
    }
    const { events, emit } = collect()
    expect(await classify(client, INPUT, emit)).toBe('QUESTION')
    expect(seen).toHaveLength(2)
    // The first request as it always was, then the answer handed back with
    // what was asked: the model reads why it is asked again.
    expect(seen[1]?.transcript.slice(0, 1)).toEqual(seen[0]?.transcript)
    expect(seen[1]?.transcript[1]).toEqual({
      role: 'assistant',
      text: 'I think this is a QUESTION about databases',
      toolCalls: [],
    })
    expect(seen[1]?.transcript[2]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(seen[1]?.transcript[2])).toMatch(/QUESTION or MUTATION/)
    expect(events.map((event) => event.type)).toEqual([
      'agent:start',
      'retry',
      'classified',
      'agent:end',
    ])
  })

  it('stops after a second answer that is no word either, quoting both and naming the model setting', async () => {
    let calls = 0
    const client: LlmClient = {
      generate: async () => {
        calls += 1
        return { text: calls === 1 ? 'PERHAPS' : 'MAYBE', toolCalls: [], finishReason: 'stop' }
      },
    }
    const { events, emit } = collect()
    const error = await classify(client, INPUT, emit).catch((thrown: unknown) => thrown)
    expect(calls).toBe(2)
    // No `retry`: it reads as the Supervisor having corrected itself, and a
    // second answer that is no word either is not a correction. The stop's
    // reason quotes both answers.
    expect(events.map((event) => event.type)).toEqual(['agent:start', 'stopped', 'agent:end'])
    expect(error).toBeInstanceOf(ClassificationError)
    const message = (error as Error).message
    expect(message).toContain('"PERHAPS"')
    expect(message).toContain('"MAYBE"')
    expect(message).toContain('IDP_SUPERVISOR_MODEL')
    expect(message).not.toContain('\n')
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
      { type: 'agent:end', agent: 'supervisor', threw: false },
    ])
  })

  it('says it stopped before it throws, so the failure is never silent', async () => {
    // `stopped`, not `refused`: nothing was judged, the model gave no word to
    // judge. Its reason is the error the command prints, once, as its last line.
    const { events, emit } = collect()
    await classify(saying('UNCLEAR'), INPUT, emit).catch(() => {})
    expect(events.at(-2)).toMatchObject({ type: 'stopped', agent: 'supervisor' })
    expect(events.at(-1)).toEqual({ type: 'agent:end', agent: 'supervisor', threw: true })
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
