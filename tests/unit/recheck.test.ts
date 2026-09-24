import { describe, expect, it } from 'vitest'
import { planEdits } from '../../src/core/plan/edits.js'
import { recheckPlan } from '../../src/core/plan/recheck.js'
import { signPlan } from '../../src/core/plan/sign.js'
import type { SignatureContext, SignedPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { parseDocuments, serializeEntity } from '../../src/core/yaml/serialize.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'
import type { RepositoryFile, RepositorySnapshot } from '../../src/core/validate/rules.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger'],
}

const signature = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  // A person's own request, which is what every fixture here models.
  wordsOf: 'user',
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
  ignored: [],
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
      ignored: [],
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
      ignored: [],
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

/**
 * Whose violation it is. The six rules run over the whole repository the plan
 * would leave behind, and that repository includes everything that was already
 * wrong with it — so reporting all of them as the plan's refused every plan on a
 * real repository over a fault it never touched, and handed the Architect a
 * repair report it could do nothing about.
 */
describe('recheckPlan attributes each violation', () => {
  /** A document the schema refused, the way the reader reports one. */
  const rejected = (path: string): RepositoryFile => ({
    path,
    entities: [],
    rejections: ['spec: Invalid input: expected object, received undefined'],
    ignored: [],
    documents: 1,
  })

  /** A grant filed where convention would not put it: misplaced before any plan. */
  const legacyGrant = fileHolding(
    'dependencies/access/legacy-grant.yml',
    'billing-api-orders-db-prod',
  )

  /** An update of the grant, which edits whichever file declares it at its computed path. */
  const updateGrant = (): SignedPlan => {
    const parsed = planSchema.parse({
      intent: 'let billing-api consume the legacy grant',
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/billing-api-orders-db-prod',
          patch: { patch: 'add-dependency-of', consumer: 'component:default/orders-api' },
        },
      ],
    })
    const signed = signPlan(
      parsed,
      signature({
        witnessed: new Set([
          'component:default/orders-api',
          'resource:default/billing-api-orders-db-prod',
        ]),
      }),
    )
    if ('outcome' in signed) throw new Error('refused')
    return signed
  }

  it('leaves an error elsewhere in the repository standing, not the plan’s', () => {
    const snap = snapshot([rejected('catalog/databases/legacy.yml')])

    const { violations, standing } = recheck(sign(), snap)

    expect(violations).toEqual([])
    expect(standing.map((violation) => [violation.rule, violation.file])).toEqual([
      ['invalid-entity', 'catalog/databases/legacy.yml'],
    ])
  })

  it('leaves a warning elsewhere standing too', () => {
    // A dangling reference somewhere else in the repository is reported by
    // `validate`, and was never this plan's to print above its diff.
    const dangling: RepositoryFile = {
      path: 'dependencies/access/other-grant-prod.yml',
      entities: [
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Resource',
          metadata: { name: 'other-grant-prod', annotations: { [ENV_ANNOTATION]: 'prod' } },
          spec: {
            type: 'database-access',
            owner: 'group:default/tiger',
            dependsOn: ['resource:default/nowhere'],
            dependencyOf: ['component:default/billing-api'],
          },
        },
      ],
      rejections: [],
      ignored: [],
      documents: 1,
    }

    const { violations, standing } = recheck(sign(), snapshot([dangling]))

    expect(violations).toEqual([])
    expect(standing.map((violation) => violation.rule)).toEqual(['dangling-reference'])
  })

  it('makes an introduced duplicate the plan’s', () => {
    const elsewhere = fileHolding(
      'systems/billing/billing-api-orders-db-prod.yml',
      'billing-api-orders-db-prod',
    )

    const { violations, standing } = recheck(sign(), snapshot([elsewhere]))

    expect(violations.map((violation) => violation.rule)).toEqual(['duplicate-name'])
    // systems/billing holds an entity and no witness, before the plan and
    // after it, and the plan writes nothing there.
    expect(standing.map((violation) => [violation.rule, violation.file])).toEqual([
      ['missing-witness', 'systems/billing'],
    ])
  })

  it('makes an introduced duplicate anchored in a file the plan leaves alone the plan’s', () => {
    // The rule anchors a duplicate on its first file in sort order, and here
    // that is the old copy, which the plan never opens. Being new is what makes
    // it the plan's.
    const earlier = 'catalog/aaa/billing-api-orders-db-prod.yml'

    const { violations, standing } = recheck(
      sign(),
      snapshot([fileHolding(earlier, 'billing-api-orders-db-prod')]),
    )

    expect(violations.map((violation) => [violation.rule, violation.file])).toEqual([
      ['duplicate-name', earlier],
    ])
    expect(standing.map((violation) => violation.rule)).not.toContain('duplicate-name')
  })

  it('makes a duplicate the plan makes worse the plan’s', () => {
    // Two files already declare it; the plan adds a third. Both old copies sort
    // before the plan's file, so the duplicate is anchored, before and after,
    // on a file the plan leaves alone: what changed is that it now names one
    // more file, and making an existing fault worse is the plan's doing.
    const first = 'catalog/aaa/billing-api-orders-db-prod.yml'
    const second = 'catalog/bbb/billing-api-orders-db-prod.yml'

    const { violations, standing } = recheck(
      sign(),
      snapshot([
        fileHolding(first, 'billing-api-orders-db-prod'),
        fileHolding(second, 'billing-api-orders-db-prod'),
      ]),
    )

    const duplicate = violations.find((violation) => violation.rule === 'duplicate-name')
    expect(duplicate?.file).toBe(first)
    expect(duplicate?.message).toContain('dependencies/access/billing-api-orders-db-prod.yml')
    expect(standing.map((violation) => violation.rule)).not.toContain('duplicate-name')
  })

  it('makes a standing duplicate the plan’s when the plan edits a copy other than its anchor', () => {
    // Declared twice, and the plan updates the copy at the computed path, which
    // sorts second. The fault reads the same before and after, and its anchor
    // is a file the plan leaves alone — yet the merge request carries one of
    // the two files CI refuses, and Backstage lets the first source win (§4.4),
    // so the update may never take effect.
    const anchor = 'catalog/aaa/grant.yml'
    const snap = snapshot([
      fileHolding('dependencies/access/billing-api-orders-db-prod.yml', 'billing-api-orders-db-prod'),
      fileHolding(anchor, 'billing-api-orders-db-prod'),
    ])

    const { violations, standing } = recheck(updateGrant(), snap)

    expect(violations.map((violation) => [violation.rule, violation.file])).toContainEqual([
      'duplicate-name',
      anchor,
    ])
    expect(standing.map((violation) => violation.rule)).not.toContain('duplicate-name')
  })

  it('makes an introduced misplaced entity the plan’s', () => {
    // No signed plan files an entity away from its computed path, so the edit
    // is written by hand: what is under test is the attribution, and it has to
    // hold whatever bytes the plan carries.
    const misfiled = {
      path: 'catalog/databases/billing-api-orders-db-prod.yml',
      before: undefined,
      after: textOf(fileHolding('x', 'billing-api-orders-db-prod')),
    }

    const { violations } = recheckPlan(sign(), snapshot(), [misfiled])

    expect(violations.map((violation) => [violation.rule, violation.file])).toEqual([
      ['misplaced-entity', 'catalog/databases/billing-api-orders-db-prod.yml'],
    ])
  })

  it('makes a fault the plan causes in a file it leaves alone the plan’s', () => {
    // No operation takes a declaration away today, so the edit is written by
    // hand: bytes that stop declaring the database leave the grant in another
    // file pointing at nothing. Only being new makes that warning the plan's —
    // nothing the plan writes is where the rule anchors it.
    const database = 'catalog/databases/orders-db-prod.yml'
    const grant = 'dependencies/access/billing-api-orders-db-prod.yml'
    const snap = snapshot([fileHolding(grant, 'billing-api-orders-db-prod')])
    const emptied = { path: database, before: bytesOf(snap).get(database), after: '' }

    const { violations, standing } = recheckPlan(sign(), snap, [emptied])

    expect(violations.map((violation) => [violation.rule, violation.file])).toEqual([
      ['dangling-reference', grant],
    ])
    expect(standing).toEqual([])
  })

  it('makes a pre-existing error in a file the plan edits the plan’s', () => {
    // The fault predates the plan, but the merge request carries the file, and
    // a merge request carrying a file CI refuses has to say so.
    const { violations } = recheck(updateGrant(), snapshot([legacyGrant]))

    expect(violations.map((violation) => [violation.rule, violation.file])).toContainEqual([
      'misplaced-entity',
      'dependencies/access/legacy-grant.yml',
    ])
  })

  it('does not count a file the plan leaves byte-identical as edited', () => {
    // `already-declared` still hands the re-check an edit, whose two sides are
    // equal. The merge request carries no such file, so a fault in it stands.
    const path = 'dependencies/access/billing-api-orders-db-prod.yml'
    // Bytes first, then parsed, so the snapshot and the bytes the edit starts
    // from agree about the document the schema refuses.
    const bytes = `${textOf(fileHolding(path, 'billing-api-orders-db-prod'))}\n---\nkind: Resource\n`
    const snap = snapshot([{ path, ...parseDocuments(bytes) }])
    const contents = new Map([...bytesOf(snap), [path, bytes]])

    const { outcomes, violations, standing } = recheckPlan(
      sign(),
      snap,
      planEdits(sign(), contents).edits,
    )

    expect(outcomes.get(0)).toBe('already-declared')
    expect(violations).toEqual([])
    expect(standing.map((violation) => violation.rule)).toEqual(['invalid-entity'])
  })

  it('makes a missing witness the plan’s when it writes into that folder', () => {
    // The folder rule anchors on the folder, so "a file the plan edits" means a
    // file the plan edits in it.
    const unwitnessed: RepositorySnapshot = {
      ...snapshot([
        fileHolding('dependencies/access/other-grant-prod.yml', 'other-grant-prod'),
      ]),
      witnesses: ['catalog/databases', 'systems'],
    }

    const { violations, standing } = recheck(sign(), unwitnessed)

    expect(violations.map((violation) => [violation.rule, violation.file])).toEqual([
      ['missing-witness', 'dependencies/access'],
    ])
    expect(standing).toEqual([])
  })

  it('leaves a missing witness standing in a folder the plan does not write into', () => {
    const unwitnessed: RepositorySnapshot = {
      ...snapshot(),
      witnesses: ['catalog/databases', 'dependencies/access'],
    }

    const { violations, standing } = recheck(sign(), unwitnessed)

    expect(violations).toEqual([])
    expect(standing.map((violation) => [violation.rule, violation.file])).toEqual([
      ['missing-witness', 'systems'],
    ])
  })
})
