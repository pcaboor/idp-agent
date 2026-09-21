import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Recording, RecordingStore } from '../llm/recording.js'

/**
 * The only place `node:fs` meets a recording, and it lives under `cli/` rather
 * than `llm/` so that nothing reachable from `agents/` can touch the disk —
 * the architecture test walks that closure through `llm/client.ts`.
 */
export function fileRecordingStore(directory: string): RecordingStore {
  const fileOf = (scenario: string): string => path.join(directory, `${scenario}.json`)

  return {
    async read(scenario) {
      const raw = await readFile(fileOf(scenario), 'utf8').catch(() => undefined)
      return raw === undefined ? undefined : (JSON.parse(raw) as Recording)
    },

    async write(scenario, recording) {
      await mkdir(directory, { recursive: true })
      await writeFile(fileOf(scenario), `${JSON.stringify(recording, null, 2)}\n`, 'utf8')
    },
  }
}
