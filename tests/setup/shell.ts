/**
 * The suite must not depend on the contributor's shell. The README asks for
 * IDP_PROVIDER and IDP_MODEL to be exported, and a test that calls `main`
 * without injecting an environment reads `process.env`: with them exported,
 * two tests that expect "no model configured" failed on "no key for openai".
 * A key in the shell is worse — a key some forgotten path could spend.
 *
 * So every IDP_ variable is removed, and every `*_API_KEY`, before any test
 * runs. IDP_TRACE_DIR is kept, for the reason `personal.ts` gives: it writes
 * files on this machine, sends nothing, and it is how the tapes are traced on
 * purpose.
 *
 * Recording is the one run that needs them, and only a scenario records:
 * IDP_RECORDING=record in the shell of a whole `pnpm test` used to record
 * every unit test that reached `main` into a tape of its own. In any other
 * file the switch is removed with the rest, and `offline.ts` blocks the
 * network there as in replay.
 *
 * A setup file, run first in every worker, and each test file has its own.
 * `tests/unit/offline.test.ts` fails if any of that stops being true.
 */
import path from 'node:path'
import { expect } from 'vitest'

/** The repository this suite belongs to. */
const REPOSITORY = path.resolve(import.meta.dirname, '../..')

/**
 * Whether the test file at `file` may record: IDP_RECORDING=record, and a
 * scenario — a file under `tests/scenarios/` of the repository at `root`. Any
 * folder named `scenarios` used to do, the checkout's own parent included.
 */
export function mayRecord(
  env: Readonly<Record<string, string | undefined>>,
  file: string | undefined,
  root: string = REPOSITORY,
): boolean {
  if (env['IDP_RECORDING'] !== 'record' || file === undefined) return false
  const [first, second] = path.relative(root, file).split(/[\\/]/)
  return first === 'tests' && second === 'scenarios'
}

/** The variables of `env` a test file must not see; none while a scenario records. */
export function shellVariables(
  env: Readonly<Record<string, string | undefined>>,
  recording: boolean,
): string[] {
  if (recording) return []
  return Object.keys(env).filter(
    (name) => (name.startsWith('IDP_') && name !== 'IDP_TRACE_DIR') || name.endsWith('_API_KEY'),
  )
}

/** This test file records a scenario. Read by `offline.ts`, which opens the network only then. */
export const recording = mayRecord(process.env, expect.getState().testPath)

for (const name of shellVariables(process.env, recording)) delete process.env[name]
