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
 * JSON.stringify — the digest `digestOf` (src/llm/runtime.ts) takes. Measured
 * on f8bcb43, before backstage-http slice 3. The Analyst's turns of three tapes
 * already warn "the prompt changed since recording" (docs/roadmap.md), so a
 * warning cannot tell a further change; this can. A change that must move one
 * updates it in the commit that says why.
 */
const SENT: Record<string, readonly string[]> = {
  'question-prod-databases': [
    'supervisor#sha256:cfdbd5db34a0c21501ccde70968e7de6671a535ea0d8bd34266b38f6398567b3',
    'analyst#sha256:762c55add1db89643c7b51c052e9cade238a43f32534dcce6998437edddd1033',
    'analyst#sha256:f898850354890b7ecdb4f62d6d9267de3feddbd42b7c25ae39a198d48876c2df',
  ],
  'question-consumers-of-billing-db': [
    'supervisor#sha256:10a76bc6dc9d810695131ef10fec847abd1d8a6781ff94d7b3c59f146ae04b46',
    'analyst#sha256:00c682854999312f41d21dc42c93fe18930561273ae45c834b6a3771bf737596',
    'analyst#sha256:f8365065ec21673ce1a98b69a9b67324da3ad5d33bf80658fdbb02a1010b8caf',
    'analyst#sha256:00f447605fc6a2b9ab43c89b74ed11602a739a0036989af4ee98e62c493f5030',
  ],
  'question-unanswerable-ranking': [
    'supervisor#sha256:cadf97785012fdc5c241a6c18561ff50a6e0bc4a978733cbf30930a9191b8c5e',
    'analyst#sha256:29f57cdafd883ea7e3b5e2feba2fca31d88cf1c8c0ddde8fc7861da6f2379598',
    'analyst#sha256:d650ac1718cbb2eeb505d53d637dada491e945123f3bcf5e5c1db990ed611d4e',
    'analyst#sha256:62f1ba31b2abc2f11b4340ecac8584058281d4ba8ef91d2cfb8203e106b474e4',
    'analyst#sha256:0dc58960d87f5a46cf0e8d050dfde4adad3b1643cdb8d2574d615e7576a279ea',
  ],
  'mutation-classified-link': [
    'supervisor#sha256:6bc36572214ea385aa1cca11e1128aa049b974de1dccef4e6096e66cb1b3958d',
  ],
}

describe('what the question tapes send', () => {
  it.each(Object.entries(QUESTIONS))(
    '%s sends the requests it sent on f8bcb43',
    async (scenario, intent) => {
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
      expect(sent).toEqual(SENT[scenario])
    },
  )
})
