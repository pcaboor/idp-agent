import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import type { AgentEvent } from '../../src/agents/events.js'

const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')
const declarations = async (entities: Record<string, string>): Promise<string> => {
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
const ORDERS_DB = `---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: orders-db-prod\n  annotations:\n    company.fr/env: prod\nspec:\n  type: database\n  owner: group:default/tiger\n`
const BILLING_API = `---\napiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\n  annotations:\n    company.fr/env: prod\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger\n`
const PACKAGE_JSON = JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8.11.0' } }, null, 2)

const run = async (recordingDir: string, scenario: string, intent: string) => {
  const repo = await declarations({ 'catalog/databases/orders-db-prod.yml': ORDERS_DB, 'systems/billing-api.yml': BILLING_API })
  const project = await mkdtemp(path.join(tmpdir(), 'idp-audit-app-'))
  await writeFile(path.join(project, 'package.json'), PACKAGE_JSON, 'utf8')
  const out: string[] = []; const err: string[] = []; const events: AgentEvent[] = []
  let code = -1; let thrown = ''
  try {
    code = await main(['plan', intent, '--repo', repo], { cwd: project, recordingDir, scenario, env: process.env,
      out: (c) => void out.push(c), err: (c) => void err.push(c), events: (e) => void events.push(e) })
  } catch (e) { thrown = String(e) }
  return { code, thrown, out: out.join(''), err: err.join(''), events }
}
const endedWell = (code: number, out: string): string => {
  try {
    expect([0, 1, 3]).toContain(code)
    if (code === 0) { expect(out).toMatch(/^\+\+\+ /m); expect(out).toContain('nothing written'); return 'PASS' }
    expect(out).not.toMatch(/^\+\+\+ /m); expect(out).toMatch(/asked rather than guessed|refused/); expect(out.trim().length).toBeGreaterThan(0)
    return 'PASS'
  } catch (e) { return `FAIL: ${String(e).split('\n')[0]}` }
}
const summarise = (label: string, r: Awaited<ReturnType<typeof run>>) => {
  const kinds = r.events.map((e) => e.type === 'agent:start' ? `start:${e.agent}` : e.type === 'retry' ? `retry(${(e as { reason: string }).reason.slice(0, 60)})` : e.type === 'refused' ? `refused:${(e as { agent: string }).agent}` : e.type === 'tool:call' ? `call:${(e as { name: string }).name}` : e.type)
  console.log(`[AUDIT-DRIFT] ${label}\n   exit=${r.code} thrown=${r.thrown || '-'}\n   endedWell => ${endedWell(r.code, r.out)}\n   out=${JSON.stringify(r.out.slice(0, 300))}\n   err=${JSON.stringify(r.err.slice(0, 600))}\n   events=${kinds.join(' ')}`)
}

it('audit: a recorded propose call that no longer parses', async () => {
  const intent = 'give billing-api read access to orders-db in prod'
  summarise('BASELINE link-db-exists (shipped recording)', await run(RECORDINGS, 'link-db-exists', intent))

  const drifted = await mkdtemp(path.join(tmpdir(), 'idp-audit-rec-'))
  await cp(RECORDINGS, drifted, { recursive: true })
  const file = path.join(drifted, 'link-db-exists.json')
  const rec = JSON.parse(await readFile(file, 'utf8')) as { turns: { agent: string; turn: number; result: { content: { type: string; toolName?: string; input?: unknown }[] } }[] }
  // Simulate "the propose schema gained a required field": the recorded call is
  // now missing it. Equivalent, from the loop's point of view, to leaving the
  // recording alone and adding `z.object({..., newField: z.string()})` in src.
  let mutated = 0
  for (const t of rec.turns) if (t.agent === 'architect') for (const c of t.result.content) if (c.type === 'tool-call' && c.toolName === 'propose') {
    const input = c.input as { operations: { op: string; entity: Record<string, unknown> }[] }
    for (const op of input.operations) { if (op.entity) delete (op.entity as { spec?: unknown }).spec; else delete (op as { patch?: unknown }).patch }
    mutated += 1
  }
  await writeFile(file, JSON.stringify(rec, null, 2))
  console.log(`[AUDIT-DRIFT] mutated ${mutated} recorded propose call(s): removed entity.spec from every operation (digest left untouched, so NO prompt-changed warning fires for these turns)`)
  summarise('DRIFTED link-db-exists (every recorded propose no longer parses)', await run(drifted, 'link-db-exists', intent))
}, 300_000)
