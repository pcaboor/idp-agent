import { it } from 'vitest'
import { openRecording, type Recording, type RecordingStore } from '../../src/llm/recording.js'
import { createClient } from '../../src/llm/runtime.js'

const turn = (agent: string, n: number, text: string, extra: Record<string, unknown> = {}) => ({
  agent, turn: n, provider: 'p', model: 'm', digest: 'sha256:x',
  call: {}, result: { content: [{ type: 'text', text }], finishReason: 'stop' }, ...extra,
})
const storeOf = (rec: unknown) => {
  const written: Recording[] = []
  const store: RecordingStore & { written: Recording[] } = {
    written, read: async () => rec as Recording, write: async (_s, r) => void written.push(r),
  }
  return store
}
const req = (agent: 'supervisor' | 'analyst') => ({ agent, system: 's', transcript: [], tools: [], toolChoice: 'none' as const })
const say = (label: string, value: unknown) => console.log(`[AUDIT-GAP] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

it('audit: what recording.ts / recording-fs.ts accept without complaint', async () => {
  const warns: string[] = []
  const warn = (m: string) => void warns.push(m)

  // 1. The file's own `scenario` and `version` fields are never compared to anything.
  const wrongName = await openRecording({ scenario: 'link-db-exists', store: storeOf({ version: 99, scenario: 'SOMETHING-ELSE', turns: [turn('supervisor', 0, 'from the wrong scenario')] }), mode: 'replay', warn })
  say('file says scenario=SOMETHING-ELSE version=99, opened as link-db-exists -> replay returns', (wrongName.replay({ agent: 'supervisor', turn: 0 }, 'sha256:x').result.content[0] as { text: string }).text)

  // 2. Duplicate (agent, turn) keys: the LAST one silently wins.
  const dup = await openRecording({ scenario: 'd', store: storeOf({ version: 1, scenario: 'd', turns: [turn('supervisor', 0, 'FIRST'), turn('supervisor', 0, 'SECOND')] }), mode: 'replay', warn })
  say('two entries keyed supervisor#0 -> replay returns', (dup.replay({ agent: 'supervisor', turn: 0 }, 'sha256:x').result.content[0] as { text: string }).text)

  // 3. turn as a string "0", and an agent name that is not an AgentName: both accepted.
  const loose = await openRecording({ scenario: 'd', store: storeOf({ version: 1, scenario: 'd', turns: [turn('supervisor', '0' as never, 'string turn'), turn('archittect', 0, 'typo agent')] }), mode: 'replay', warn })
  say('turn:"0" (string) -> replay for turn 0 returns', (loose.replay({ agent: 'supervisor', turn: 0 }, 'sha256:x').result.content[0] as { text: string }).text)
  say('agent "archittect" entry -> replay for architect#0 throws', (() => { try { loose.replay({ agent: 'architect', turn: 0 }, 'sha256:x'); return 'no' } catch (e) { return String(e).slice(0, 90) } })())

  // 4. A malformed turn (no result / no content) is not caught by any validation.
  const broken = await openRecording({ scenario: 'd', store: storeOf({ version: 1, scenario: 'd', turns: [{ agent: 'supervisor', turn: 0, digest: 'sha256:x' }] }), mode: 'replay', warn })
  const client = createClient({ tape: broken, mode: 'replay' })
  say('turn with no `result` -> client.generate throws', await client.generate(req('supervisor')).then(() => 'no', (e) => String(e).slice(0, 120)))
  const broken2 = await openRecording({ scenario: 'd', store: storeOf({ version: 1, scenario: 'd', turns: [{ agent: 'supervisor', turn: 0, digest: 'sha256:x', result: { content: [{ type: 'text', text: 'ok' }] } }] }), mode: 'replay', warn })
  say('turn with no finishReason, no provider, no model, no call -> client.generate returns', await createClient({ tape: broken2, mode: 'replay' }).generate(req('supervisor')))

  // 5. handAuthored: only the literal `true` is refused by the scenario test; these all pass it.
  say('scenario test predicate turn.handAuthored !== true, for handAuthored = "yes"', ('yes' as unknown) !== true)
  say('... for handAuthored = 1', (1 as unknown) !== true)
  say('... for handAuthored omitted', (undefined as unknown) !== true)

  // 6. Re-recording MERGES into the existing file: turns the new run never produced survive.
  const merged = storeOf({ version: 1, scenario: 'd', turns: [turn('supervisor', 0, 'old'), turn('analyst', 0, 'old'), turn('analyst', 1, 'old'), turn('analyst', 2, 'STALE, from a longer earlier run')] })
  const rec = await openRecording({ scenario: 'd', store: merged, mode: 'record', warn })
  rec.record({ agent: 'supervisor', turn: 0 }, turn('supervisor', 0, 'new') as never)
  rec.record({ agent: 'analyst', turn: 0 }, turn('analyst', 0, 'new') as never)
  await rec.save()
  say('re-record produced supervisor#0 + analyst#0 only; file written contains', merged.written[0]!.turns.map((t) => `${t.agent}#${t.turn}=${(t.result.content[0] as { text: string }).text}`))

  // 7. Digest mismatch is a warning string to `warn` and nothing else: no flag on the result, no count.
  const drift = await openRecording({ scenario: 'd', store: storeOf({ version: 1, scenario: 'd', turns: [turn('supervisor', 0, 'x')] }), mode: 'replay', warn })
  const r = drift.replay({ agent: 'supervisor', turn: 0 }, 'sha256:different')
  say('after a mismatched replay, keys on the returned record', Object.keys(r))
  say('warnings collected so far', warns)
})
