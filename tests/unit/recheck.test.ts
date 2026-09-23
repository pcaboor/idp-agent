import { describe, expect, it } from 'vitest'
import { planEdits } from '../../src/core/plan/edits.js'
import { recheckPlan } from '../../src/core/plan/recheck.js'
import { signPlan } from '../../src/core/plan/sign.js'
import type { SignatureContext, SignedPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { serializeEntity } from '../../src/core/yaml/serialize.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'
import type { RepositoryFile, RepositorySnapshot } from '../../src/core/validate/rules.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger'],
}

const signature = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: new Set(['resource:default/orders-db-prod', 'component:default/billing-api']),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
  // The level is asked, never read out of the request, so a fixture that
  // wants a complete plan answers for it — which is what a run does.
  answered: new Set(['read']),
  ...over,
})

const access = {
  kind: 'Resource' as const,
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access' as const, access: 'read',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'],
    dependencyOf: ['component:default/billing-api'],
  },
}

const sign = (entity: unknown = access, over: Partial<SignatureContext> = {}): SignedPlan => {
  const parsed = planSchema.parse({
    intent: 'give billing-api read access to orders-db in prod',
    operations: [{ op: 'create-entity', entity }],
  })
  const result = signPlan(parsed, signature(over))
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

/** A parsed file the way readRepository would have handed it over. */
const fileHolding = (
  path: string,
  name: string,
  env = 'prod',
  /** 'none' writes no level at all — §4.1's unstated level. */
  level: 'read' | 'readwrite' | 'none' = 'read',
): RepositoryFile => ({
  path,
  entities: [
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name, annotations: { [ENV_ANNOTATION]: env } },
      spec: {
        type: 'database-access',
        ...(level === 'none' ? {} : { access: level }),
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/orders-db-prod'],
        dependencyOf: ['component:default/billing-api'],
      },
    },
  ],
  rejections: [],
  documents: 1,
})

const snapshot = (files: RepositoryFile[] = []): RepositorySnapshot => ({
  folders: ['dependencies/access', 'catalog/databases', 'systems'],
  witnesses: ['dependencies/access', 'catalog/databases', 'systems'],
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
    {
      // The consumer, declared. A right names one — the schema refuses one
      // that does not — so a snapshot holding only the database makes every
      // grant below a dangling reference.
      path: 'systems/billing-api.yml',
      entities: [
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Component',
          metadata: { name: 'billing-api', annotations: { [ENV_ANNOTATION]: 'prod' } },
          spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
        },
      ],
      rejections: [],
      documents: 1,
    },
    ...files,
  ],
})


/**
 * The re-check reads the bytes a plan would leave, so a test has to hand it
 * the same edits the preview would show. Computing them here rather than
 * hand-writing a virtual file is the point: the check and the preview are one
 * object, and a test that built its own would stop proving that.
 */
const bytesOf = (snap: RepositorySnapshot): ReadonlyMap<string, string> =>
  new Map(snap.files.map((file) => [file.path, textOf(file)]))

const textOf = (file: RepositoryFile): string =>
  file.entities.map((entity) => `---\n${serializeEntity(entity)}`).join('\n')

const recheck = (signed: SignedPlan, snap: RepositorySnapshot) =>
  recheckPlan(signed, snap, planEdits(signed, bytesOf(snap)).edits)

describe('recheckPlan', () => {
  it('reports fresh when nothing changed', () => {
    expect(recheck(sign(), snapshot()).outcomes.get(0)).toBe('fresh')
  })

  it('reports already-declared when the entity appeared meanwhile', () => {
    // The catalogue lags the repository by about two minutes (§4.4), so what
    // was true when the plan was drafted may not be true now. The plan was
    // signed against a catalogue that had never heard of this entity.
    const already = fileHolding(
      'dependencies/access/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )

    expect(recheck(sign(), snapshot([already])).outcomes.get(0)).toBe('already-declared')
  })

  it('reports differs when that file states another level than the plan does', () => {
    // Already-declared was decided by NAME alone, so a plan stating `read`
    // against a file granting `readwrite` came out "the repository already
    // says it" with an empty diff — the tool asserting a falsehood about an
    // authorisation, in the direction that hands out write.
    const wider = fileHolding(
      'dependencies/access/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
      'prod',
      'readwrite',
    )

    expect(recheck(sign(), snapshot([wider])).outcomes.get(0)).toBe('differs')
  })

  it('reports differs when that file states no level and the plan states one', () => {
    const unstated = fileHolding(
      'dependencies/access/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
      'prod',
      'none',
    )

    expect(recheck(sign(), snapshot([unstated])).outcomes.get(0)).toBe('differs')
  })

  it('reports moved when the entity exists at a different path', () => {
    // Same name, different file. Writing the engine-computed path would make
    // a duplicate the catalogue ingests in silence, letting the first source
    // win (§4.4) — the exact failure the repository is the gate against.
    const elsewhere = fileHolding(
      'systems/billing/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )

    expect(recheck(sign(), snapshot([elsewhere])).outcomes.get(0)).toBe('moved')
  })

  it('refuses a plan that would introduce a duplicate', () => {
    // Applied virtually, then checkRepository over the result: the same six
    // rules CI runs, asked about a repository that does not exist yet.
    const elsewhere = fileHolding(
      'systems/billing/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )

    const { violations } = recheck(sign(), snapshot([elsewhere]))

    expect(violations.some((violation) => violation.rule === 'duplicate-name')).toBe(true)
  })

  it('reports a violation the plan would introduce even when nothing moved', () => {
    // A dangling reference is the plan's doing, not the repository's: the
    // entity it points at has to exist once the plan lands, not before.
    const dangling = {
      ...access,
      spec: { ...access.spec, dependsOn: ['resource:default/ghost'] },
    }
    const { violations } = recheck(
      sign(dangling, {
        witnessed: new Set(['resource:default/ghost', 'component:default/billing-api']),
      }),
      snapshot(),
    )

    expect(violations.some((violation) => violation.rule === 'dangling-reference')).toBe(true)
  })

  it('finds no violation in a plan that lands cleanly', () => {
    expect(recheck(sign(), snapshot()).violations).toEqual([])
  })

  it('leaves the snapshot it was handed untouched', () => {
    // Applied virtually means virtually. A re-check that mutated the snapshot
    // would make the second call disagree with the first.
    const given = snapshot()
    const before = JSON.stringify(given)

    recheck(sign(), given)

    expect(JSON.stringify(given)).toBe(before)
  })

  it('says nothing about an operation whose path is still a question', () => {
    // No path, no virtual file. The CLI asks before any of this matters.
    const unnamed = { ...access, metadata: { name: 'ghost-backdoor-prod', env: 'prod' } }

    expect(recheck(sign(unnamed), snapshot()).outcomes.get(0)).toBe('unresolved')
  })

  it('does not report an already-declared entity as a duplicate of itself', () => {
    // The re-check used to model the plan a second time and push a virtual
    // file for an operation it had just called 'already-declared' — so the
    // entity came out declared in one file, named twice, and a PARTIALLY
    // applied plan was refused with no diff at all.
    const already = fileHolding(
      'dependencies/access/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )
    const snap = snapshot([already])

    const { outcomes, violations } = recheck(sign(), snap)

    expect(outcomes.get(0)).toBe('already-declared')
    expect(violations.filter((violation) => violation.rule === 'duplicate-name')).toEqual([])
  })

  it('sees what an update-entity would change, not creations alone', () => {
    // Modelling creations only made an update invisible here: `plan` exited 0
    // on a diff these same six rules reject once applied. Reading the edits
    // back is what closed it — the check and the preview are one object.
    const existing = fileHolding(
      'dependencies/access/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )
    const parsed = planSchema.parse({
      intent: 'let ghost-service consume orders-db in prod',
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/billing-api-orders-db-prod',
          patch: { patch: 'add-dependency-of', consumer: 'component:default/ghost-service' },
        },
      ],
    })
    const result = signPlan(
      parsed,
      // Both references must be vouched for or the signer turns them into
      // questions — which is the signature doing its job, not a fixture detail.
      // ghost-service is in the catalogue and in no file yet: exactly the lag
      // §4.4 describes, and exactly what the re-check exists to catch.
      signature({
        witnessed: new Set([
          'component:default/ghost-service',
          'resource:default/billing-api-orders-db-prod',
        ]),
      }),
    )
    if ('outcome' in result) throw new Error('refused')

    const snap = snapshot([existing])
    const { violations } = recheckPlan(result, snap, planEdits(result, bytesOf(snap)).edits)

    // The consumer the patch adds is declared nowhere, and the rules say so —
    // which they could only do by reading the amended file.
    expect(violations.some((violation) => violation.rule === 'dangling-reference')).toBe(true)
    expect(
      violations.some((violation) => violation.message.includes('ghost-service')),
    ).toBe(true)
  })
})
