import { describe, expect, it } from 'vitest'
import { recheckPlan } from '../../src/core/plan/recheck.js'
import { signPlan } from '../../src/core/plan/sign.js'
import type { SignatureContext, SignedPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'
import type { RepositoryFile, RepositorySnapshot } from '../../src/core/validate/rules.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger'],
}

const signature = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: new Set(['resource:default/orders-db-prod']),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
  ...over,
})

const access = {
  kind: 'Resource' as const,
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access' as const,
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'],
  },
}

const sign = (entity: unknown = access, over: Partial<SignatureContext> = {}): SignedPlan => {
  const parsed = planSchema.parse({
    intent: 'give billing-api access to orders-db in prod',
    operations: [{ op: 'create-entity', entity }],
  })
  const result = signPlan(parsed, signature(over))
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

/** A parsed file the way readRepository would have handed it over. */
const fileHolding = (path: string, name: string, env = 'prod'): RepositoryFile => ({
  path,
  entities: [
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name, annotations: { [ENV_ANNOTATION]: env } },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/orders-db-prod'],
      },
    },
  ],
  rejections: [],
  documents: 1,
})

const snapshot = (files: RepositoryFile[] = []): RepositorySnapshot => ({
  folders: ['dependencies/access', 'catalog/databases'],
  witnesses: ['dependencies/access', 'catalog/databases'],
  files: [
    {
      path: 'catalog/databases/orders-db-prod.yml',
      entities: [
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Resource',
          metadata: { name: 'orders-db-prod', annotations: { [ENV_ANNOTATION]: 'prod' } },
          spec: { type: 'database', owner: 'group:default/tiger' },
        },
      ],
      rejections: [],
      documents: 1,
    },
    ...files,
  ],
})

describe('recheckPlan', () => {
  it('reports fresh when nothing changed', () => {
    expect(recheckPlan(sign(), snapshot()).outcomes.get(0)).toBe('fresh')
  })

  it('reports already-declared when the entity appeared meanwhile', () => {
    // The catalogue lags the repository by about two minutes (§4.4), so what
    // was true when the plan was drafted may not be true now. The plan was
    // signed against a catalogue that had never heard of this entity.
    const already = fileHolding(
      'dependencies/access/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )

    expect(recheckPlan(sign(), snapshot([already])).outcomes.get(0)).toBe('already-declared')
  })

  it('reports moved when the entity exists at a different path', () => {
    // Same name, different file. Writing the engine-computed path would make
    // a duplicate the catalogue ingests in silence, letting the first source
    // win (§4.4) — the exact failure the repository is the gate against.
    const elsewhere = fileHolding(
      'systems/billing/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )

    expect(recheckPlan(sign(), snapshot([elsewhere])).outcomes.get(0)).toBe('moved')
  })

  it('refuses a plan that would introduce a duplicate', () => {
    // Applied virtually, then checkRepository over the result: the same six
    // rules CI runs, asked about a repository that does not exist yet.
    const elsewhere = fileHolding(
      'systems/billing/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )

    const { violations } = recheckPlan(sign(), snapshot([elsewhere]))

    expect(violations.some((violation) => violation.rule === 'duplicate-name')).toBe(true)
  })

  it('reports a violation the plan would introduce even when nothing moved', () => {
    // A dangling reference is the plan's doing, not the repository's: the
    // entity it points at has to exist once the plan lands, not before.
    const dangling = {
      ...access,
      spec: { ...access.spec, dependsOn: ['resource:default/ghost'] },
    }
    const { violations } = recheckPlan(
      sign(dangling, { witnessed: new Set(['resource:default/ghost']) }),
      snapshot(),
    )

    expect(violations.some((violation) => violation.rule === 'dangling-reference')).toBe(true)
  })

  it('finds no violation in a plan that lands cleanly', () => {
    expect(recheckPlan(sign(), snapshot()).violations).toEqual([])
  })

  it('leaves the snapshot it was handed untouched', () => {
    // Applied virtually means virtually. A re-check that mutated the snapshot
    // would make the second call disagree with the first.
    const given = snapshot()
    const before = JSON.stringify(given)

    recheckPlan(sign(), given)

    expect(JSON.stringify(given)).toBe(before)
  })

  it('says nothing about an operation whose path is still a question', () => {
    // No path, no virtual file. The CLI asks before any of this matters.
    const unnamed = { ...access, metadata: { name: 'ghost-backdoor-prod', env: 'prod' } }

    expect(recheckPlan(sign(unnamed), snapshot()).outcomes.get(0)).toBe('unresolved')
  })
})
