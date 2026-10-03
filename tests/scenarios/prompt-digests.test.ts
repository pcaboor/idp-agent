import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { fileRecordingStore } from '../../src/cli/recording-fs.js'
import type { LlmClient } from '../../src/llm/client.js'
import { openRecording } from '../../src/llm/recording.js'
import { createClient } from '../../src/llm/runtime.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')

/** `question-mode.test.ts`'s intents, word for word. */
const QUESTIONS: Record<string, string> = {
  'question-prod-databases': 'which databases are in prod?',
  'question-consumers-of-billing-db': 'which services use the billing database in prod?',
  'question-unanswerable-ranking': 'which database is the most expensive to run?',
  'mutation-classified-link': 'give billing-api read access to orders-db in prod',
}

/**
 * Every request the question-mode tapes are replayed with, as sha256 of
 * JSON.stringify — the old scheme's digest (`sha256:`, `digestsOf` in
 * src/llm/runtime.ts), computed here whatever scheme a tape holds. Measured on
 * chore/s6-tapes (stage 6, Task 6.4.3), after the owner recorded the four tapes
 * again on 2026-10-02 under `sent:sha256:`, the digest over what the provider
 * is sent, tools included: from each agent's second request on, a request
 * carries what the model answered, so these moved with the tapes while
 * `FIRST_SENT` did not. Until then they were measured on f8bcb43, over tapes
 * whose Analyst turns warned "the prompt changed since recording". A tape
 * replays its own digests and warns on a change; this pins the whole sequence,
 * so a turn added or dropped is caught too. A change that must move one
 * updates it in the commit that says why.
 */
const SENT: Record<string, readonly string[]> = {
  'question-prod-databases': [
    'supervisor#sha256:cfdbd5db34a0c21501ccde70968e7de6671a535ea0d8bd34266b38f6398567b3',
    'analyst#sha256:762c55add1db89643c7b51c052e9cade238a43f32534dcce6998437edddd1033',
    'analyst#sha256:986a06da62aeec3e8e4cb21e70131783a8fdc53a32c68c36b8a02d28ba92ab2a',
  ],
  'question-consumers-of-billing-db': [
    'supervisor#sha256:10a76bc6dc9d810695131ef10fec847abd1d8a6781ff94d7b3c59f146ae04b46',
    'analyst#sha256:00c682854999312f41d21dc42c93fe18930561273ae45c834b6a3771bf737596',
    'analyst#sha256:315f3dfbfceb38d8d04b80391a0402de257190bfc39a6af732b735cbf26dc2a3',
    'analyst#sha256:06fd3ddfcbcd5aa4a6efa21780286a25f461f7b7b0c408483eeae50ac37d8952',
  ],
  'question-unanswerable-ranking': [
    'supervisor#sha256:cadf97785012fdc5c241a6c18561ff50a6e0bc4a978733cbf30930a9191b8c5e',
    'analyst#sha256:29f57cdafd883ea7e3b5e2feba2fca31d88cf1c8c0ddde8fc7861da6f2379598',
    'analyst#sha256:0ab062e234657822a1ee53ef99d43e783f84553c521fc0198dee98e8dd8fbbb5',
    'analyst#sha256:57f80d0dbaa7a09c0c947c0b6387be368c421078a1349caed6a39b0a2eb414f7',
  ],
  'mutation-classified-link': [
    'supervisor#sha256:6bc36572214ea385aa1cca11e1128aa049b974de1dccef4e6096e66cb1b3958d',
  ],
}

/**
 * Each agent's first request of every question tape, copied from `SENT` as it
 * stood on 2b2250e (where it had not moved since f8bcb43). Neither depends on a
 * recorded answer: the Supervisor is sent the request and the summary, and the
 * Analyst the request and the same summary, never the Supervisor's words
 * (`ask.ts`, `classified` and `answered`). So these hold across a re-record of
 * the tapes (stage 6, Task 6.4.3), when `SENT`, whose later requests carry what
 * the models answered, moves: they are the proof that the code still sends what
 * it sent. A change that must move one updates it in the commit that says why.
 */
const FIRST_SENT: Record<string, readonly string[]> = {
  'question-prod-databases': [
    'supervisor#sha256:cfdbd5db34a0c21501ccde70968e7de6671a535ea0d8bd34266b38f6398567b3',
    'analyst#sha256:762c55add1db89643c7b51c052e9cade238a43f32534dcce6998437edddd1033',
  ],
  'question-consumers-of-billing-db': [
    'supervisor#sha256:10a76bc6dc9d810695131ef10fec847abd1d8a6781ff94d7b3c59f146ae04b46',
    'analyst#sha256:00c682854999312f41d21dc42c93fe18930561273ae45c834b6a3771bf737596',
  ],
  'question-unanswerable-ranking': [
    'supervisor#sha256:cadf97785012fdc5c241a6c18561ff50a6e0bc4a978733cbf30930a9191b8c5e',
    'analyst#sha256:29f57cdafd883ea7e3b5e2feba2fca31d88cf1c8c0ddde8fc7861da6f2379598',
  ],
  'mutation-classified-link': [
    'supervisor#sha256:6bc36572214ea385aa1cca11e1128aa049b974de1dccef4e6096e66cb1b3958d',
  ],
}

/** Every request `ask` sends for `intent`, replayed from the tape of `scenario`, in order. */
const sentFor = async (scenario: string, intent: string): Promise<string[]> => {
  const tape = await openRecording({
    scenario,
    store: fileRecordingStore(RECORDINGS),
    mode: 'replay',
    warn: () => {},
  })
  const replay = createClient({ mode: 'replay', tape })
  const sent: string[] = []
  const client: LlmClient = {
    generate: (request, call) => {
      const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
      sent.push(`${request.agent}#sha256:${digest}`)
      return replay.generate(request, call)
    },
  }
  await main(['ask', intent], {
    root: FIXTURES,
    client,
    env: process.env,
    out: () => {},
    err: () => {},
  })
  return sent
}

/** The first request each agent was sent, in the order the agents were first called. */
const firstOfEachAgent = (sent: readonly string[]): string[] => {
  const seen = new Set<string>()
  return sent.filter((entry) => {
    const agent = entry.slice(0, entry.indexOf('#'))
    if (seen.has(agent)) return false
    seen.add(agent)
    return true
  })
}

describe('what the question tapes send', () => {
  it.each(Object.entries(QUESTIONS))(
    '%s sends the requests its tape was recorded with',
    async (scenario, intent) => {
      expect(await sentFor(scenario, intent)).toEqual(SENT[scenario])
    },
  )

  it.each(Object.entries(QUESTIONS))(
    "%s sends each agent's first request unchanged, whatever the models answered",
    async (scenario, intent) => {
      expect(firstOfEachAgent(await sentFor(scenario, intent))).toEqual(FIRST_SENT[scenario])
    },
  )

  it('pins a first request for every question tape, and only those', () => {
    expect(Object.keys(FIRST_SENT).sort()).toEqual(Object.keys(QUESTIONS).sort())
  })
})
