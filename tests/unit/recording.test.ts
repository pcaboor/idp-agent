import { describe, expect, it, vi } from 'vitest'
import { RecordingMissError, openRecording, resolveMode } from '../../src/llm/recording.js'
import type { Recording, RecordingStore } from '../../src/llm/recording.js'

const recorded: Recording = {
  version: 1,
  scenario: 'demo',
  turns: [
    {
      agent: 'supervisor',
      turn: 0,
      provider: 'anthropic',
      model: 'claude-opus-5',
      digest: 'sha256:aaa',
      call: { prompt: [{ role: 'user', content: 'hello' }] },
      result: { content: [{ type: 'text', text: 'QUESTION' }], finishReason: 'stop' },
    },
  ],
}

const storeOf = (recording?: Recording): RecordingStore & { written: Recording[] } => {
  const written: Recording[] = []
  return {
    written,
    read: async () => recording,
    write: async (_scenario, value) => void written.push(value),
  }
}

const open = async (recording?: Recording, warn: (message: string) => void = () => {}) =>
  openRecording({ scenario: 'demo', store: storeOf(recording), mode: 'replay', warn })

describe('resolveMode', () => {
  it('replays when nothing is set', () => {
    expect(resolveMode(undefined)).toBe('replay')
    expect(resolveMode('')).toBe('replay')
  })

  it('records only on the documented value', () => {
    expect(resolveMode('record')).toBe('record')
  })

  it('refuses a value it does not recognise, rather than guessing a mode', () => {
    // A contributor who types IDP_RECORDING=1 must not silently diverge from CI.
    expect(() => resolveMode('1')).toThrow(/IDP_RECORDING/)
    expect(() => resolveMode('replay')).toThrow(/IDP_RECORDING/)
  })
})

describe('recording replay', () => {
  it('returns the recorded turn for its key', async () => {
    const played = await open(recorded)
    expect(played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:aaa').result.finishReason).toBe(
      'stop',
    )
  })

  it('fails on a missing entry, naming how to record it', async () => {
    // A warning here would let a brand new scenario pass green replaying nothing.
    const played = await open(recorded)
    expect(() => played.replay({ agent: 'analyst', turn: 0 }, 'sha256:aaa')).toThrow(
      RecordingMissError,
    )
    expect(() => played.replay({ agent: 'analyst', turn: 0 }, 'sha256:aaa')).toThrow(
      /IDP_RECORDING=record/,
    )
  })

  it('fails when the whole recording is absent', async () => {
    const played = await open(undefined)
    expect(() => played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:aaa')).toThrow(
      RecordingMissError,
    )
  })

  it('warns and still replays when the prompt changed since recording', async () => {
    // design 9.3: a prompt that changed produces a warning, not an error.
    const warn = vi.fn()
    const played = await open(recorded, warn)
    expect(played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:different').result.finishReason)
      .toBe('stop')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/supervisor turn 0/))
  })

  it('is keyed on the turn, never on the prompt', async () => {
    // Keying on a hash would invalidate every recording on a single changed
    // comma, which is exactly what design 9.3 forbids.
    const played = await open(recorded)
    expect(() => played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:zzz')).not.toThrow()
  })

  it('does not warn when the prompt is unchanged', async () => {
    const warn = vi.fn()
    const played = await open(recorded, warn)
    played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:aaa')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps two turns of the same agent apart', async () => {
    const twoTurns: Recording = {
      ...recorded,
      turns: [
        recorded.turns[0]!,
        { ...recorded.turns[0]!, turn: 1, result: { content: [], finishReason: 'tool-calls' } },
      ],
    }
    const played = await open(twoTurns)
    expect(played.replay({ agent: 'supervisor', turn: 1 }, 'sha256:aaa').result.finishReason).toBe(
      'tool-calls',
    )
  })
})

describe('recording record', () => {
  it('writes the turns it was given, sorted by agent and turn', async () => {
    const store = storeOf(undefined)
    const played = await openRecording({
      scenario: 'demo',
      store,
      mode: 'record',
      warn: () => {},
    })
    played.record({ agent: 'analyst', turn: 1 }, { ...recorded.turns[0]!, agent: 'analyst', turn: 1 })
    played.record({ agent: 'analyst', turn: 0 }, { ...recorded.turns[0]!, agent: 'analyst', turn: 0 })
    played.record({ agent: 'supervisor', turn: 0 }, recorded.turns[0]!)
    await played.save()
    expect(store.written[0]?.turns.map((turn) => `${turn.agent}#${turn.turn}`)).toEqual([
      'analyst#0',
      'analyst#1',
      'supervisor#0',
    ])
  })

  it('re-recording a turn replaces it rather than appending a second one', async () => {
    const store = storeOf(recorded)
    const played = await openRecording({
      scenario: 'demo',
      store,
      mode: 'record',
      warn: () => {},
    })
    played.record(
      { agent: 'supervisor', turn: 0 },
      { ...recorded.turns[0]!, digest: 'sha256:new' },
    )
    await played.save()
    expect(store.written[0]?.turns).toHaveLength(1)
    expect(store.written[0]?.turns[0]?.digest).toBe('sha256:new')
  })
})
