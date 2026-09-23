import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import type { AgentEvent } from '../../src/agents/events.js'

const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')
const ORDERS_DB = `---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: orders-db-prod\n  annotations:\n    company.fr/env: prod\nspec:\n  type: database\n  owner: group:default/tiger\n`
const BILLING_API = `---\napiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\n  annotations:\n    company.fr/env: prod\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger\n`
const ACCESS = `---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: billing-api-orders-db-prod\n  annotations:\n    company.fr/env: prod\nspec:\n  type: database-access\n  owner: group:default/tiger\n  dependsOn:\n    - resource:default/orders-db-prod\n  dependencyOf:\n    - component:default/billing-api\n`
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
  await writeFile(path.join(root, '.idp-agent.yml'), 'iacRepo: acme/iac\nenvironments:\n  - dev\n  - staging\n  - prod\n', 'utf8')
  return root
}
const run = async (scenario: string, intent: string, entities: Record<string, string>) => {
  const repo = await declarations(entities)
  const project = await mkdtemp(path.join(tmpdir(), 'idp-audit-app-'))
  await writeFile(path.join(project, 'package.json'), PACKAGE_JSON, 'utf8')
  const out: string[] = []; const err: string[] = []; const events: AgentEvent[] = []
  const code = await main(['plan', intent, '--repo', repo], { cwd: project, recordingDir: RECORDINGS, scenario, env: process.env,
    out: (c) => void out.push(c), err: (c) => void err.push(c), events: (e) => void events.push(e) })
  const o = out.join('')
  const counts: Record<string, number> = {}
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
  console.log(`[AUDIT-OUTCOME] ${scenario}: exit=${code} diff=${/^\+\+\+ /m.test(o)} err=${JSON.stringify(err.join(''))}\n   out[0:220]=${JSON.stringify(o.slice(0, 220))}\n   events=${JSON.stringify(counts)} refused=${JSON.stringify(events.filter((e) => e.type === 'refused').map((e) => (e as { agent: string; reason: string }).agent + ': ' + (e as { reason: string }).reason.slice(0, 120)))}`)
}
it('audit: what each shipped plan recording makes the CLI do', async () => {
  const both = { 'catalog/databases/orders-db-prod.yml': ORDERS_DB, 'systems/billing-api.yml': BILLING_API }
  await run('link-db-exists', 'give billing-api read access to orders-db in prod', both)
  await run('link-db-missing', 'give billing-api read access to orders-db in prod', { 'systems/billing-api.yml': BILLING_API })
  await run('link-ambiguous-env', 'give billing-api read access to orders-db', both)
  await run('link-already-declared', 'give billing-api read access to orders-db in prod', { ...both, 'dependencies/access/billing-api-orders-db-prod.yml': ACCESS })
  await run('repair-malformed-owner', 'give billing-api read access to orders-db in prod, owned by group:default/platform-wizards', both)
}, 300_000)
