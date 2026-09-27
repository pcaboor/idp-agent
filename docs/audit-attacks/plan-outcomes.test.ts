import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'
import { it } from './oracle.js'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { confirmingEnvironment } from '../../tests/support/ask.js'

const RECORDINGS = path.resolve(import.meta.dirname, '../../tests/recordings')
const ORDERS_DB = `---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: orders-db-prod\n  annotations:\n    company.fr/env: prod\nspec:\n  type: database\n  owner: group:default/tiger\n`
const BILLING_API = `---\napiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\n  annotations:\n    company.fr/env: prod\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger\n`
const ACCESS = `---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: billing-api-orders-db-prod\n  annotations:\n    company.fr/env: prod\nspec:\n  type: database-access\n  # The level this grant states, and the one the request asks for.\n  access: read\n  owner: group:default/tiger\n  dependsOn:\n    - resource:default/orders-db-prod\n  dependencyOf:\n    - component:default/billing-api\n`
const PACKAGE_JSON = JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8.11.0' } }, null, 2)
const declarations = async (entities: Record<string, string>) => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-audit-')), 'iac')
  await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0-test' })
  for (const [relative, text] of Object.entries(entities)) {
    const absolute = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(path.join(path.dirname(absolute), '.witness.yml'), '---\n', { flag: 'w' })
    await writeFile(absolute, text, 'utf8')
  }
  return root
}
const CONFIG = 'iacRepo: acme/iac\nenvironments:\n  - dev\n  - staging\n  - prod\n'
interface Outcome { scenario: string; code: number; out: string; events: AgentEvent[] }
// Each fixture is the scenario's own, to the byte: the tapes replay only the
// run they recorded (tests/scenarios/plan-mode.test.ts).
const run = async (scenario: string, intent: string, entities: Record<string, string>, confirmsEnvironment = true): Promise<Outcome> => {
  const repo = await declarations(entities)
  const project = await mkdtemp(path.join(tmpdir(), 'idp-audit-app-'))
  await writeFile(path.join(project, 'package.json'), PACKAGE_JSON, 'utf8')
  // §7.0: the configuration in the application repository, where the
  // re-recorded scenarios write it. Written into the declarations repository,
  // as this fixture did, every turn replayed under a prompt the tapes were not
  // recorded with, and the outcomes logged were not what the model did.
  await writeFile(path.join(project, '.idp-agent.yml'), CONFIG, 'utf8')
  const out: string[] = []; const err: string[] = []; const events: AgentEvent[] = []
  const code = await main(['plan', intent, '--repo', repo], { cwd: project, recordingDir: RECORDINGS, scenario, env: process.env,
    out: (c) => void out.push(c), err: (c) => void err.push(c), events: (e) => void events.push(e),
    // Answered as the plan-mode scenarios answer them: since the audit, the
    // level and the environment are asked, and a run that stops at them never
    // reaches the re-check this test is about.
    ask: async (question) => (question.path.endsWith('.access') ? 'read' : confirmsEnvironment ? confirmingEnvironment(question) : undefined) })
  const o = out.join('')
  const counts: Record<string, number> = {}
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
  console.log(`[AUDIT-OUTCOME] ${scenario}: exit=${code} diff=${/^\+\+\+ /m.test(o)} err=${JSON.stringify(err.join(''))}\n   out[0:220]=${JSON.stringify(o.slice(0, 220))}\n   events=${JSON.stringify(counts)} refused=${JSON.stringify(events.filter((e) => e.type === 'refused').map((e) => (e as { agent: string; reason: string }).agent + ': ' + (e as { reason: string }).reason.slice(0, 120)))}`)
  // A stale tape replays anyway, and what it makes the CLI do is not what the
  // recorded model did: a crash, not a closure (oracle.ts).
  if (/prompt changed since recording/.test(err.join(''))) throw new Error(`${scenario} replayed a stale tape`)
  return { scenario, code, out: o, events }
}
it('audit: what each shipped plan recording makes the CLI do, and F6 under it', async () => {
  const both = { 'catalog/databases/orders-db-prod.yml': ORDERS_DB, 'systems/billing-api.yml': BILLING_API }
  const outcomes = [
    await run('link-db-exists', 'give billing-api read access to orders-db in prod', both),
    await run('link-db-missing', 'give billing-api read access to orders-db in prod', { 'systems/billing-api.yml': BILLING_API }),
    await run('link-ambiguous-env', 'give billing-api read access to orders-db', both, false),
    await run('link-already-declared', 'give billing-api read access to orders-db in prod', { ...both, 'dependencies/access/billing-api-orders-db-prod.yml': ACCESS }),
    await run('repair-malformed-owner', 'give billing-api read access to orders-db in prod, owned by group:default/platform-wizards', both),
  ]
  // A tape that started no agent replayed nothing, and proves nothing either
  // way: a crash, not a closure (oracle.ts). It is how this test passed for
  // weeks reading a `docs/recordings` that never existed.
  for (const { scenario, events } of outcomes) {
    if (!events.some((e) => e.type === 'agent:start')) throw new Error(`${scenario} replayed nothing`)
  }
  // F6: a hidden file at the root of a declarations repository — this tool's
  // own `.idp-agent.yml`, a `.gitlab-ci.yml` — was read as an entity, and the
  // re-check refused a plan over a file the plan never touched. What that
  // refusal looks like has changed since (a rejection outside the plan's files
  // is now a warning), so the defect is asked of the reader, where it lives.
  const root = await declarations({})
  await writeFile(path.join(root, '.idp-agent.yml'), CONFIG, 'utf8')
  await writeFile(path.join(root, '.gitlab-ci.yml'), 'stages:\n  - test\n', 'utf8')
  const read = (await readRepository(root)).files.map((file) => file.path)
  expect(read.filter((file) => file.startsWith('.'))).not.toEqual([])
}, 300_000)
