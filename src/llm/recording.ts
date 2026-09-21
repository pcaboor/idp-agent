import type { AgentName } from './client.js'

export interface TurnKey {
  agent: AgentName
  turn: number
}

export interface TurnRecord extends TurnKey {
  provider: string
  model: string
  /** Compared, never keyed on. See `replay`. */
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

const keyOf = (key: TurnKey): string => `${key.agent}#${key.turn}`

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
  replay(key: TurnKey, digest: string): TurnRecord
  record(key: TurnKey, record: TurnRecord): void
  save(): Promise<void>
}

export async function openRecording(options: {
  scenario: string
  store: RecordingStore
  mode: 'replay' | 'record'
  warn: (message: string) => void
}): Promise<OpenRecording> {
  const existing = await options.store.read(options.scenario)
  const turns = new Map((existing?.turns ?? []).map((turn) => [keyOf(turn), turn]))

  return {
    replay(key, digest) {
      const found = turns.get(keyOf(key))
      if (found === undefined) {
        // Fatal, where a changed prompt only warns: a warning here would let a
        // brand new scenario pass green having replayed nothing at all.
        throw new RecordingMissError(
          `no recording for ${options.scenario} ${key.agent} turn ${key.turn}. ` +
            'Record it with IDP_RECORDING=record pnpm test.',
        )
      }

      // A prompt that changed since recording warns and replays anyway
      // (design § 9.3). Keying on the digest instead would invalidate every
      // recording on a single changed comma. Note that turn n embeds turn n-1's
      // tool output, so one changed fixture cascades warnings down a scenario.
      if (found.digest !== digest) {
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
