import { describe, expect, it, vi } from 'vitest'
import {
  RecordingMissError,
  RecordingUnplayedError,
  openRecording,
  resolveMode,
} from '../../src/llm/recording.js'
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
    expect(played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:aaa']).result.finishReason).toBe(
      'stop',
    )
  })

  it('fails on a missing entry, naming how to record it', async () => {
    // A warning here would let a brand new scenario pass green replaying nothing.
    const played = await open(recorded)
    expect(() => played.replay({ agent: 'analyst', turn: 0 }, ['sha256:aaa'])).toThrow(
      RecordingMissError,
    )
    expect(() => played.replay({ agent: 'analyst', turn: 0 }, ['sha256:aaa'])).toThrow(
      /IDP_RECORDING=record/,
    )
  })

  it('fails when the whole recording is absent', async () => {
    const played = await open(undefined)
    expect(() => played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:aaa'])).toThrow(
      RecordingMissError,
    )
  })

  it('warns and still replays when the prompt changed since recording', async () => {
    // design 9.3: a prompt that changed produces a warning, not an error.
    const warn = vi.fn()
    const played = await open(recorded, warn)
    expect(played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:different']).result.finishReason)
      .toBe('stop')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/supervisor turn 0/))
  })

  it('is keyed on the turn, never on the prompt', async () => {
    // Keying on a hash would invalidate every recording on a single changed
    // comma, which is exactly what design 9.3 forbids.
    const played = await open(recorded)
    expect(() => played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:zzz'])).not.toThrow()
  })

  it('does not warn when the prompt is unchanged', async () => {
    const warn = vi.fn()
    const played = await open(recorded, warn)
    played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:aaa'])
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
    expect(played.replay({ agent: 'supervisor', turn: 1 }, ['sha256:aaa']).result.finishReason).toBe(
      'tool-calls',
    )
  })
})

describe('a digest compared in the scheme it was taken under', () => {
  // A request has one digest per scheme (src/llm/runtime.ts, `digestsOf`): a
  // turn recorded before the tool schemas were digested as sent keeps the
  // verdict it had — stale or fresh — and a turn recorded since is compared
  // with the digest of what is sent. Neither scheme stands in for the other.
  const under = (digest: string): Recording => ({
    ...recorded,
    turns: [{ ...recorded.turns[0]!, digest }],
  })
  const key = { agent: 'supervisor', turn: 0 } as const

  it('compares an old turn with the old digest, whatever the new one says', async () => {
    const warn = vi.fn()
    const played = await open(under('sha256:aaa'), warn)
    played.replay(key, ['sha256:aaa', 'sent:sha256:bbb'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('still reports an old turn stale when only the old digest moved', async () => {
    const warn = vi.fn()
    const played = await open(under('sha256:aaa'), warn)
    played.replay(key, ['sha256:moved', 'sent:sha256:bbb'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/prompt changed since recording/))
  })

  it('compares a new turn with the digest of what is sent', async () => {
    const warn = vi.fn()
    const played = await open(under('sent:sha256:bbb'), warn)
    played.replay(key, ['sha256:moved', 'sent:sha256:bbb'])
    expect(warn).not.toHaveBeenCalled()
    played.replay(key, ['sha256:aaa', 'sent:sha256:moved'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/prompt changed since recording/))
  })

  it('reports a turn stale when the request has no digest in its scheme', async () => {
    // A scheme this build does not compute cannot vouch for anything.
    const warn = vi.fn()
    const played = await open(under('other:sha256:aaa'), warn)
    played.replay(key, ['sha256:aaa', 'sent:sha256:aaa'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/prompt changed since recording/))
  })
})

describe('a turn the replay never reached', () => {
  const three: Recording = {
    ...recorded,
    turns: [
      recorded.turns[0]!,
      { ...recorded.turns[0]!, agent: 'analyst', turn: 0 },
      { ...recorded.turns[0]!, agent: 'analyst', turn: 1 },
    ],
  }

  it('is an error, naming every such turn', async () => {
    // A tape re-recorded over an older one kept the older run's turns, and a
    // replay that never reached them said nothing: 16 of 91 turns were dead
    // weight nobody could tell from the turns a scenario plays (tests-5).
    const played = await open(three)
    played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:aaa'])
    played.replay({ agent: 'analyst', turn: 0 }, ['sha256:aaa'])
    expect(() => played.assertAllReplayed()).toThrow(RecordingUnplayedError)
    expect(() => played.assertAllReplayed()).toThrow(
      'recording demo: analyst turn 1 was never replayed',
    )
  })

  it('is no error once every turn was replayed, however often', async () => {
    const played = await open(three)
    for (const key of [
      { agent: 'supervisor', turn: 0 },
      { agent: 'analyst', turn: 0 },
      { agent: 'analyst', turn: 1 },
      { agent: 'analyst', turn: 1 },
    ] as const) {
      played.replay(key, ['sha256:aaa'])
    }
    expect(() => played.assertAllReplayed()).not.toThrow()
  })

  it('names them all, in the tape\'s order', async () => {
    const played = await open(three)
    expect(() => played.assertAllReplayed()).toThrow(
      'recording demo: analyst turn 0, analyst turn 1 and supervisor turn 0 were never replayed',
    )
  })

  it('names the earlier of two entries for one turn, which no replay can reach', async () => {
    // The tape is keyed on the turn, so the later entry is the one replayed and
    // the earlier one is a turn of the file nothing consumes.
    const twice: Recording = {
      ...recorded,
      turns: [recorded.turns[0]!, { ...recorded.turns[0]!, model: 'another' }],
    }
    const played = await open(twice)
    expect(played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:aaa']).model).toBe('another')
    expect(() => played.assertAllReplayed()).toThrow(RecordingUnplayedError)
    expect(() => played.assertAllReplayed()).toThrow(
      'recording demo: an earlier supervisor turn 0 was never replayed',
    )
  })

  it('is asked of a replay alone: a recording writes what it made', async () => {
    const played = await openRecording({
      scenario: 'demo',
      store: storeOf(three),
      mode: 'record',
      warn: () => {},
    })
    expect(() => played.assertAllReplayed()).not.toThrow()
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

  it('starts from an empty tape, so a turn the new run did not make is not kept', async () => {
    // Merged into the old tape, a re-recording kept every turn of the run
    // before it that this one did not reach (tests-5).
    const store = storeOf({
      ...recorded,
      turns: [
        recorded.turns[0]!,
        { ...recorded.turns[0]!, agent: 'analyst', turn: 0 },
        { ...recorded.turns[0]!, agent: 'analyst', turn: 1 },
      ],
    })
    const played = await openRecording({ scenario: 'demo', store, mode: 'record', warn: () => {} })
    played.record({ agent: 'supervisor', turn: 0 }, { ...recorded.turns[0]!, digest: 'sha256:new' })
    await played.save()
    expect(store.written[0]?.turns.map((turn) => `${turn.agent}#${turn.turn}:${turn.digest}`)).toEqual([
      'supervisor#0:sha256:new',
    ])
  })

  it('replays nothing from the tape it replaces', async () => {
    const played = await openRecording({
      scenario: 'demo',
      store: storeOf(recorded),
      mode: 'record',
      warn: () => {},
    })
    expect(() => played.replay({ agent: 'supervisor', turn: 0 }, ['sha256:aaa'])).toThrow(
      RecordingMissError,
    )
  })
})
