import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runPlan, type Ask } from '../../src/cli/commands/plan.js'
import type { Cleared, ClearRefusal } from '../../src/core/plan/clear.js'
import { confirmingEnvironment } from './ask.js'
import { committed } from './git.js'

/**
 * A committed declarations repository, and a `Cleared` minted over it the way
 * the CLI mints one: by `runPlan` itself, through its `clearance` seam — the
 * signature, the contexts and the bytes the preview is decided on — never a
 * `PolicyContext` rebuilt here by hand, which is how the eee67d6 fixture
 * drifted from `main`'s shapes (check §3 P4).
 */

export const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

export const OPERATIONS = [
  {
    op: 'create-entity',
    entity: {
      kind: 'Resource',
      metadata: { name: 'orders-db-prod', env: 'prod' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    },
  },
  {
    op: 'create-entity',
    entity: {
      kind: 'Resource',
      metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
      spec: {
        type: 'database-access',
        access: 'read',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/orders-db-prod'],
        dependencyOf: ['component:default/billing-api'],
      },
    },
  },
]

export const DATABASE_PATH = 'catalog/databases/orders-db-prod.yml'
export const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'

/**
 * Every temporary directory this module made, so a suite removes them in
 * `afterAll` (`removeClones`): a test run's leftovers fill a small disk.
 */
const made: string[] = []

/** A directory under the system's temporary folder, remembered for `removeClones`. */
export const scratch = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** Removes every directory `scratch` and `clone` made in this worker. */
export const removeClones = async (): Promise<void> => {
  const all = made.splice(0)
  await Promise.all(all.map((dir) => rm(dir, { recursive: true, force: true })))
}

/** A committed declarations repository, exactly as `init platform` leaves one. */
export const clone = async (): Promise<string> => {
  const repo = path.join(await scratch('idp-forge-'), 'iac')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  await committed(repo)
  return repo
}

/** A person at the prompt: `read` for a level, the draft's environment confirmed, nothing else. */
const answering: Ask = async (question) =>
  question.path.endsWith('.access') ? 'read' : confirmingEnvironment(question)

/**
 * What the CLI mints over `repo` as it stands: the plan file is written beside
 * the repository, never inside it, and the last clearance of the run is kept —
 * the ask loop previews once per round, and the last round is the one a
 * submission would take.
 */
export const clearedFor = async (repo: string): Promise<Cleared> => {
  const from = path.join(path.dirname(repo), 'plan.json')
  await writeFile(from, `${JSON.stringify({ intent: INTENT, operations: OPERATIONS }, null, 2)}\n`, 'utf8')
  let clearance: Cleared | ClearRefusal | undefined
  await runPlan({
    from,
    repo,
    ask: answering,
    clearance: (one) => {
      clearance = one
    },
  })
  if (clearance === undefined) throw new Error('runPlan cleared nothing')
  if ('outcome' in clearance) throw new Error(clearance.reasons.join('\n'))
  return clearance
}
