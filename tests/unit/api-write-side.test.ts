import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import type { Ask } from '../../src/cli/commands/plan.js'
import { operationSchema, planSchema } from '../../src/core/schemas/plan.js'
import { hashTree } from '../support/tree.js'

/**
 * The read model is wider than the write model, and only the read model grew:
 * a proposal can declare neither an API nor what a component provides, and a
 * plan against a repository that holds both is decided exactly as it was.
 */

const GOLDEN = path.resolve(import.meta.dirname, '../golden/backstage-apis')

const component = {
  kind: 'Component',
  metadata: { name: 'billing-api' },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
}

describe('a proposal', () => {
  it('declares a Component as it did', () => {
    expect(operationSchema.safeParse({ op: 'create-entity', entity: component }).success).toBe(true)
  })

  it('cannot say what a Component provides', () => {
    const parsed = operationSchema.safeParse({
      op: 'create-entity',
      entity: { ...component, spec: { ...component.spec, providesApis: ['api:default/billing'] } },
    })
    expect(parsed.success).toBe(false)
  })

  it('cannot declare an API', () => {
    const parsed = planSchema.safeParse({
      intent: 'declare the billing API',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'API',
            metadata: { name: 'billing' },
            spec: {
              type: 'openapi',
              lifecycle: 'production',
              owner: 'group:default/tiger',
              definition: 'openapi: 3.1.0',
            },
          },
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})

const answering = (value: string): Ask => async (question) =>
  question.path.endsWith('.access') ? value : undefined

const run = async (args: string[], ask?: Ask) => {
  const io = { out: [] as string[], err: [] as string[] }
  const code = await main(args, {
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
    ...(ask === undefined ? {} : { ask }),
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

/** A scaffolded repository that is also the golden Backstage catalogue. */
const catalogue = async (): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-plan-apis-')), 'repo')
  await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0-test' })
  await cp(GOLDEN, root, { recursive: true })
  return root
}

const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

const PLAN = {
  intent: INTENT,
  operations: [
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
  ],
}

describe('a plan against a repository holding APIs', () => {
  it('renders its diff, writes nothing, and counts what was already wrong as standing', async () => {
    const repo = await catalogue()
    const from = path.join(path.dirname(repo), 'plan.json')
    await writeFile(from, JSON.stringify(PLAN), 'utf8')
    const before = await hashTree(repo)

    const { code, out } = await run(['plan', '--from', from, '--repo', repo], answering('read'))

    expect(code).toBe(0)
    expect(out).toContain('+++ b/catalog/databases/orders-db-prod.yml')
    expect(out).toContain('+++ b/dependencies/access/billing-api-orders-db-prod.yml')
    // The broken API, the Group and the dangling providesApis are the
    // repository's, in files this plan does not touch.
    expect(out).toContain('1 error and 2 warnings already in the repository, in files this plan does not touch')
    // No API file is edited, and none is written.
    expect(out).not.toMatch(/^\+\+\+ b\/apis\//m)
    expect(await hashTree(repo)).toBe(before)
  })

  it('amends no API: an update aimed at one is dropped, as it was', async () => {
    const repo = await catalogue()
    const from = path.join(path.dirname(repo), 'plan.json')
    await writeFile(
      from,
      JSON.stringify({
        intent: 'give component:default/billing-api access to api:default/payments',
        operations: [
          {
            op: 'update-entity',
            entityRef: 'api:default/payments',
            patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api' },
          },
        ],
      }),
      'utf8',
    )
    const before = await hashTree(repo)

    const { code, out, err } = await run(['plan', '--from', from, '--repo', repo], answering('read'))

    expect(code).toBe(3)
    expect(err).toBe('')
    // Dropped for the reason it always was: an API is in no file the write
    // side reads, so the edit has nothing to amend.
    expect(out).toContain(
      '  ! operations.0 — api:default/payments is declared in no file this plan can see\n',
    )
    expect(out).not.toMatch(/^\+\+\+ b\//m)
    expect(await hashTree(repo)).toBe(before)
  })
})
