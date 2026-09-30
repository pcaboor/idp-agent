import type { AgentName } from './client.js'

export interface TurnKey {
  agent: AgentName
  turn: number
}

export interface TurnRecord extends TurnKey {
  provider: string
  model: string
  /**
   * Compared, never keyed on. See `replay`. Prefixed with the scheme it was
   * taken under, which `runtime.ts` (`digestsOf`) documents: `sha256:` on a
   * turn recorded before 2026-09-30, `sent:sha256:` since.
   */
  digest: string
  recordedAt?: string
  /** Set only when a turn was written by hand because no key was available. */
  handAuthored?: boolean
  call: unknown
  result: { content: unknown[]; finishReason: string; usage?: unknown }
}

export interface Recording {
  version: 1
  scenario: string
  turns: TurnRecord[]
}

/** Where recordings live. An interface, so nothing here touches a disk. */
export interface RecordingStore {
  read(scenario: string): Promise<Recording | undefined>
  write(scenario: string, recording: Recording): Promise<void>
}

export class RecordingMissError extends Error {}

/** A replay that left turns of its tape unplayed: the tape holds more than its scenario makes. */
export class RecordingUnplayedError extends Error {}

const keyOf = (key: TurnKey): string => `${key.agent}#${key.turn}`

/** A digest's scheme: everything before its hex, `sha256:` or `sent:sha256:`. */
const schemeOf = (digest: string): string => digest.slice(0, digest.lastIndexOf(':') + 1)

const named = (key: TurnKey): string => `${key.agent} turn ${key.turn}`

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * The mode comes from IDP_RECORDING alone — never from whether a key happens to
 * be present, or a contributor's run diverges from CI without either noticing.
 */
export function resolveMode(raw: string | undefined): 'replay' | 'record' {
  if (raw === undefined || raw === '') return 'replay'
  if (raw === 'record') return 'record'
  throw new Error(`IDP_RECORDING must be unset or "record", got "${raw}"`)
}

export interface OpenRecording {
  /** `digests` is the request's digest in every scheme the runtime computes. */
  replay(key: TurnKey, digests: readonly string[]): TurnRecord
  record(key: TurnKey, record: TurnRecord): void
  save(): Promise<void>
  /**
   * Throws when a replay left a turn of the tape unplayed. Asked once a run
   * has succeeded; a recording has nothing to check, and returns.
   */
  assertAllReplayed(): void
}

export async function openRecording(options: {
  scenario: string
  store: RecordingStore
  mode: 'replay' | 'record'
  warn: (message: string) => void
}): Promise<OpenRecording> {
  // A recording starts from an empty tape and never reads the one it replaces.
  // Merged into it, a re-recording kept every turn of an earlier run that this
  // one did not make: 16 dead turns of 91, and diffs nobody could review
  // (tests-5).
  const existing = options.mode === 'record' ? undefined : await options.store.read(options.scenario)
  const turns = new Map((existing?.turns ?? []).map((turn) => [keyOf(turn), turn]))
  const replayed = new Set<string>()

  return {
    replay(key, digests) {
      const found = turns.get(keyOf(key))
      if (found === undefined) {
        // Fatal, where a changed prompt only warns: a warning here would let a
        // brand new scenario pass green having replayed nothing at all.
        throw new RecordingMissError(
          `no recording for ${options.scenario} ${key.agent} turn ${key.turn}. ` +
            'Record it with IDP_RECORDING=record pnpm test.',
        )
      }

      replayed.add(keyOf(key))

      // A prompt that changed since recording warns and replays anyway
      // (design § 9.3). Keying on the digest instead would invalidate every
      // recording on a single changed comma. Note that turn n embeds turn n-1's
      // tool output, so one changed fixture cascades warnings down a scenario.
      //
      // Compared in the scheme the turn was recorded under, and only that one:
      // a turn made before the tool schemas were digested as sent keeps the
      // verdict it had, and one whose scheme this build no longer computes is
      // stale, since nothing here can vouch for it.
      const current = digests.find((digest) => schemeOf(digest) === schemeOf(found.digest))
      if (current !== found.digest) {
        options.warn(
          `recording ${options.scenario} ${key.agent} turn ${key.turn}: ` +
            'the prompt changed since recording; replaying anyway',
        )
      }
      return found
    },

    record(key, record) {
      turns.set(keyOf(key), record)
    },

    assertAllReplayed() {
      if (options.mode === 'record') return
      // Fatal, as a miss is: a turn no run reaches is a tape that holds more
      // than its scenario makes, and silence would keep it there for good.
      // Walked over the file, not the map: of two entries for one turn the map
      // keeps the later, and the earlier is a turn nothing can ever replay.
      const left = (existing?.turns ?? [])
        .filter((turn) => turns.get(keyOf(turn)) !== turn || !replayed.has(keyOf(turn)))
        .map((turn) => ({
          turn,
          name: turns.get(keyOf(turn)) === turn ? named(turn) : `an earlier ${named(turn)}`,
        }))
        .sort(
          (left, right) =>
            left.turn.agent.localeCompare(right.turn.agent) || left.turn.turn - right.turn.turn,
        )
      if (left.length === 0) return
      throw new RecordingUnplayedError(
        `recording ${options.scenario}: ${listed(left.map((each) => each.name))} ` +
          `${left.length === 1 ? 'was' : 'were'} never replayed. ` +
          'Re-record it with IDP_RECORDING=record pnpm test, which writes only the turns the run makes.',
      )
    },

    async save() {
      const sorted = [...turns.values()].sort(
        (left, right) => left.agent.localeCompare(right.agent) || left.turn - right.turn,
      )
      await options.store.write(options.scenario, {
        version: 1,
        scenario: options.scenario,
        turns: sorted,
      })
    },
  }
}
