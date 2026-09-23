import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/** Every replay() the harness performs, by scenario and key, with digest match. */
const log: { scenario: string; key: string; hit: boolean; digestMatch: boolean }[] = []

vi.mock('../../src/llm/recording.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/recording.js')>()
  return {
    ...actual,
    openRecording: async (options: Parameters<typeof actual.openRecording>[0]) => {
      const tape = await actual.openRecording(options)
      const existing = await options.store.read(options.scenario)
      const digests = new Map(
        (existing?.turns ?? []).map((t) => [`${t.agent}#${t.turn}`, t.digest]),
      )
      return {
        ...tape,
        replay(key: { agent: string; turn: number }, digest: string) {
          const k = `${key.agent}#${key.turn}`
          const stored = digests.get(k)
          log.push({
            scenario: options.scenario,
            key: k,
            hit: stored !== undefined,
            digestMatch: stored === digest,
          })
          return tape.replay(key as never, digest)
        },
      }
    },
  }
})

const { main } = await import('../../src/cli/index.js')
const { runInitPlatform } = await import('../../src/cli/commands/init.js')

const RECORDINGS = path.resolve(import.meta.dirname, '../recordings')
const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

const declarations = async (entities: Record<string, string> = {}): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-audit-')), 'iac')
  await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0-test' })
  for (const [relative, text] of Object.entries(entities)) {
    const absolute = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(path.join(path.dirname(absolute), '.witness.yml'), '---\n', { flag: 'w' })
    await writeFile(absolute, text, 'utf8')
  }
  await writeFile(
    path.join(root, '.idp-agent.yml'),
    'iacRepo: acme/iac\nenvironments:\n  - dev\n  - staging\n  - prod\n',
    'utf8',
  )
  return root
}
const application = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'idp-audit-app-'))
  for (const [relative, text] of Object.entries(files)) {
    await writeFile(path.join(root, relative), text, 'utf8')
  }
  return root
}
const ORDERS_DB = `---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: orders-db-prod
  annotations:
    company.fr/env: prod
spec:
  type: database
  owner: group:default/tiger
`
const BILLING_API = `---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: billing-api
  annotations:
    company.fr/env: prod
spec:
  type: service
  lifecycle: production
  owner: group:default/tiger
`
const ACCESS = `---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: billing-api-orders-db-prod
  annotations:
    company.fr/env: prod
spec:
  type: database-access
  owner: group:default/tiger
  dependsOn:
    - resource:default/orders-db-prod
  dependencyOf:
    - component:default/billing-api
`
const PACKAGE_JSON = JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8.11.0' } }, null, 2)

const plan = async (scenario: string, intent: string, entities: Record<string, string>) => {
  const repo = await declarations(entities)
  const project = await application({ 'package.json': PACKAGE_JSON })
  let code = -1
  let error = ''
  try {
    code = await main(['plan', intent, '--repo', repo], {
      cwd: project, recordingDir: RECORDINGS, scenario, env: process.env,
      out: () => {}, err: () => {}, events: () => {},
    })
  } catch (e) { error = String(e) }
  return { code, error }
}
const ask = async (scenario: string, intent: string) => {
  let code = -1
  let error = ''
  try {
    code = await main(['ask', intent], {
      root: FIXTURES, recordingDir: RECORDINGS, scenario, env: process.env,
      out: () => {}, err: () => {}, events: () => {},
    })
  } catch (e) { error = String(e) }
  return { code, error }
}

describe('audit: which recorded turns a replay actually uses', () => {
  it('runs every scenario and reports used / unused / digest-mismatched turns', async () => {
    const both = { 'catalog/databases/orders-db-prod.yml': ORDERS_DB, 'systems/billing-api.yml': BILLING_API }
    const results: Record<string, { code: number; error: string }> = {}
    results['link-db-exists'] = await plan('link-db-exists', 'give billing-api read access to orders-db in prod', both)
    results['link-db-missing'] = await plan('link-db-missing', 'give billing-api read access to orders-db in prod', { 'systems/billing-api.yml': BILLING_API })
    results['link-ambiguous-env'] = await plan('link-ambiguous-env', 'give billing-api read access to orders-db', both)
    results['link-already-declared'] = await plan('link-already-declared', 'give billing-api read access to orders-db in prod', { ...both, 'dependencies/access/billing-api-orders-db-prod.yml': ACCESS })
    results['repair-malformed-owner'] = await plan('repair-malformed-owner', 'give billing-api read access to orders-db in prod, owned by group:default/platform-wizards', both)
    results['question-prod-databases'] = await ask('question-prod-databases', 'which databases are in prod?')
    results['question-consumers-of-billing-db'] = await ask('question-consumers-of-billing-db', 'which services use the billing database in prod?')
    results['question-unanswerable-ranking'] = await ask('question-unanswerable-ranking', 'which database is the most expensive to run?')
    results['mutation-classified-link'] = await ask('mutation-classified-link', 'give billing-api read access to orders-db in prod')

    const files = (await readdir(RECORDINGS)).filter((n) => n.endsWith('.json'))
    for (const file of files.sort()) {
      const scenario = file.replace(/\.json$/, '')
      const rec = JSON.parse(await readFile(path.join(RECORDINGS, file), 'utf8')) as { turns: { agent: string; turn: number }[] }
      const present = rec.turns.map((t) => `${t.agent}#${t.turn}`)
      const entries = log.filter((l) => l.scenario === scenario)
      const used = [...new Set(entries.map((l) => l.key))]
      const unused = present.filter((k) => !used.includes(k))
      const misses = entries.filter((l) => !l.hit).map((l) => l.key)
      const mismatched = entries.filter((l) => l.hit && !l.digestMatch).map((l) => l.key)
      const matched = entries.filter((l) => l.hit && l.digestMatch).map((l) => l.key)
      console.log(`[AUDIT-TURNS] ${scenario}: exit=${results[scenario]?.code} error=${results[scenario]?.error || '-'}\n   present(${present.length})=[${present.join(' ')}]\n   used(${used.length})   =[${used.join(' ')}]\n   UNUSED(${unused.length}) =[${unused.join(' ')}]\n   digest-matched(${matched.length})=[${matched.join(' ')}]\n   digest-MISMATCH(${mismatched.length})=[${mismatched.join(' ')}]\n   misses=[${misses.join(' ')}]`)
    }
    expect(log.length).toBeGreaterThan(0)
  }, 600_000)
})
