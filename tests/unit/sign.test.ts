import { describe, expect, it } from 'vitest'
import { signPlan } from '../../src/core/plan/sign.js'
import type { SignatureContext, SignedPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { findUnknowns } from '../../src/core/schemas/plan.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger', 'group:default/common'],
}

const context = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: new Set(['resource:default/orders-db-prod']),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
  ...over,
})

const plan = (entity: unknown, intent = 'give billing-api read access to orders-db in prod') =>
  planSchema.parse({ intent, operations: [{ op: 'create-entity', entity }] })

const access = {
  kind: 'Resource' as const,
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access' as const, access: 'read',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'],
  },
}

const signed = (p: ReturnType<typeof plan>, c = context()) => {
  const result = signPlan(p, c)
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

describe('signPlan', () => {
  it('signs a plan whose every value can be vouched for', () => {
    const result = signed(plan(access))
    expect(result.paths.get(0)).toBe('dependencies/access/billing-api-orders-db-prod.yml')
    expect(result.refs.get(0)).toBe('resource:default/billing-api-orders-db-prod')
  })

  it('classifies every leaf, so nothing escapes by being nested', () => {
    const result = signed(plan(access))
    const classified = result.classified.map((leaf) => leaf.path)
    expect(classified).toContain('operations.0.entity.spec.owner')
    expect(classified).toContain('operations.0.entity.metadata.env')
    expect(classified).toContain('operations.0.entity.spec.type')
  })

  it('turns an owner nobody can vouch for into a question, not a value', () => {
    // The hole task 2 could not close: group:default/ghost-team is
    // syntactically perfect. Only the vocabulary knows it is fiction.
    const result = signPlan(
      plan({ ...access, spec: { ...access.spec, owner: 'group:default/ghost-team' } }),
      context(),
    )
    if ('outcome' in result) throw new Error('should have signed with an unknown')
    expect(findUnknowns(result.plan)).toContain('operations.0.entity.spec.owner')
  })

  it('accepts a value lifted verbatim from the request', () => {
    // echoed: the user said "prod", so prod is theirs, not the model's.
    const result = signed(plan(access, 'give billing-api read access to orders-db in prod'))
    const env = result.classified.find((l) => l.path.endsWith('metadata.env'))
    expect(env?.class).toBe('echoed')
  })

  it('accepts a value the catalogue already uses', () => {
    const result = signed(plan(access, 'set up the access'))
    const owner = result.classified.find((l) => l.path.endsWith('spec.owner'))
    expect(owner?.class).toBe('enumerated')
  })

  it('computes the path itself, whatever else the proposal says', () => {
    // Two plans differing only in fields that are neither name nor type must
    // produce the same path: nothing the model wrote can steer it.
    const a = signed(plan(access))
    const b = signed(plan({ ...access, spec: { ...access.spec, dependsOn: [] } }))
    expect(a.paths.get(0)).toBe(b.paths.get(0))
  })

  it('keeps every path it produces inside the repository', () => {
    const result = signed(plan(access))
    for (const produced of result.paths.values()) {
      expect(produced.startsWith('/')).toBe(false)
      expect(produced).not.toContain('..')
    }
  })

  it('leaves an entity that is already declared to the re-check', () => {
    // The signer says where a value came from. Whether the entity exists is a
    // fact about the repository now, and the re-check owns that.
    const result = signPlan(
      plan(access),
      context({ declared: new Map([['resource:default/billing-api-orders-db-prod', 'x.yml']]) }),
    )
    expect('outcome' in result).toBe(false)
  })

  it('says nothing about whether a vouched-for value is the right one', () => {
    // The limit, asserted rather than left in a comment: an owner that exists
    // and is the wrong team signs cleanly. That is what the diff is for.
    const wrongButReal = { ...access, spec: { ...access.spec, owner: 'group:default/common' } }
    expect(() => signed(plan(wrongButReal))).not.toThrow()
  })
})

describe('the environment', () => {
  it('asks which one when the request named none, rather than picking prod', () => {
    // The one field where "the catalogue already uses this value" is not
    // provenance. `prod` always exists, so enumerating it would let a model
    // choose production for a request that named no environment at all — and
    // the plan would sign cleanly. §4.1 says being authorised in dev grants
    // nothing elsewhere; nobody asked for anything here.
    const result = signed(plan(access, 'give billing-api read access to orders-db'))

    const env = result.classified.find((leaf) => leaf.path.endsWith('.env'))
    expect(env?.class).toBe('novel')
    expect(findUnknowns(result.plan)).toContain('operations.0.entity.metadata.env')
  })

  it('accepts the one the request named', () => {
    const result = signed(plan(access, 'give billing-api read access to orders-db in prod'))

    const env = result.classified.find((leaf) => leaf.path.endsWith('.env'))
    expect(env?.class).toBe('echoed')
    expect(findUnknowns(result.plan)).toEqual([])
  })
})

describe('the level a grant is for', () => {
  const at = (level: unknown) => ({ ...access, spec: { ...access.spec, access: level } })

  it('is echoed when the request said read access', () => {
    // The word boundary is by SCRIPT (see echoes.ts), so `read` in "give
    // billing-api read access to orders-db in prod" is a word with a space
    // either side and not a fragment of one. The user asked for it, which is
    // the strongest claim a value can carry.
    const result = signed(plan(at('read'), 'give billing-api read access to orders-db in prod'))

    const level = result.classified.find((leaf) => leaf.path.endsWith('spec.access'))
    expect(level?.class).toBe('echoed')
    expect(findUnknowns(result.plan)).toEqual([])
  })

  it('asks about readwrite when the request only said read', () => {
    // The accident the field exists to prevent, from the other side. A level
    // is not enumerable, for the reason an environment is not: `readwrite`
    // exists in any repository that has granted it once, so letting the
    // catalogue vouch for it would hand out write on a request that said read.
    const result = signPlan(
      plan(at('readwrite'), 'give billing-api read access to orders-db in prod'),
      context(),
    )

    if ('outcome' in result) throw new Error('should have signed with an unknown')
    expect(findUnknowns(result.plan)).toContain('operations.0.entity.spec.access')
  })

  it('never turns a level it was not told into readwrite', () => {
    // The one forbidden guess. The proposal schema now refuses a levelled
    // right that states nothing, so the honest "I do not know" is `{unknown}`
    // — and it stays a question rather than becoming the wider of the two.
    const unsure = {
      ...access,
      spec: { ...access.spec, access: { unknown: 'read or write?' } },
    }
    const result = signed(plan(unsure, 'give billing-api access to orders-db in prod'))

    expect(JSON.stringify(result.plan)).not.toContain('readwrite')
    expect(findUnknowns(result.plan)).toContain('operations.0.entity.spec.access')
  })
})

describe('the closed union', () => {
  it('refuses a type outside it rather than asking about it', () => {
    // The plan's own words. A vocabulary miss is a question because the
    // catalogue could always grow one; a type miss is not, because
    // RESOURCE_TYPE_NAMES is closed and the folder layout is derived from it.
    // So the schema rejects it before signPlan is ever reached — signPlan
    // assumes a plan that already parsed, and this test is what makes that
    // assumption safe to rely on.
    const outside = {
      ...access,
      spec: { ...access.spec, type: 'quantum-link' },
    }
    const parsed = planSchema.safeParse({
      intent: 'give billing-api a quantum-link',
      operations: [{ op: 'create-entity', entity: outside }],
    })

    expect(parsed.success).toBe(false)
    const issue = parsed.error?.issues.find((candidate) =>
      candidate.path.join('.').endsWith('spec.type'),
    )
    expect(issue, 'the rejection must name the field').toBeDefined()
  })
})

describe('the brand', () => {
  it('cannot be forged, even with every field in place', () => {
    // "The engine signs" is a compile error rather than a slogan. The forged
    // object below is structurally complete — plan, paths, refs, classified —
    // so only the brand can reject it. @ts-expect-error asserts it does: if
    // the brand were removed, this directive would become unused and the
    // typecheck would fail on that instead.
    const complete = {
      plan: plan(access),
      paths: new Map([[0, 'dependencies/access/x.yml']]),
      refs: new Map([[0, 'resource:default/x']]),
      classified: [],
    }
    // @ts-expect-error structurally complete, and still not signed
    const forged: SignedPlan = complete
    expect(forged.paths.get(0)).toBe('dependencies/access/x.yml')
  })
})

describe('the question it writes', () => {
  it('names the list an array element belongs to, not its index', () => {
    // "nothing vouches for this 0" names nothing a person can act on.
    const result = signed(
      plan({
        ...access,
        spec: { ...access.spec, dependsOn: ['resource:default/never-seen'] },
      }),
    )

    const asked = result.plan.operations[0]
    expect(JSON.stringify(asked)).toContain('dependsOn entry')
    expect(JSON.stringify(asked)).not.toContain('this 0;')
  })
})

describe('a vocabulary is not a request', () => {
  it('does not let a declared environment vouch for a name segment', () => {
    // The same hole `enumerated` had, one layer along. An environment is never
    // provenance: `prod` always exists, and one declared in a config file
    // exists more trivially still. Letting the vocabulary vouch for it flipped
    // `metadata.name` from a question to `echoed` — the strongest claim a
    // value can carry — for a name the request never mentioned, on a request
    // that said dev. Three documents stated the opposite guarantee verbatim.
    const wrongEnv = {
      ...access,
      metadata: { name: 'billing-api-orders-db-prod', env: 'dev' },
    }
    const result = signed(
      plan(wrongEnv, 'give billing-api read access to orders-db in dev'),
      context({
        witnessed: new Set(['component:default/billing-api', 'resource:default/orders-db']),
      }),
    )

    const name = result.classified.find((leaf) => leaf.path.endsWith('.name'))
    expect(name?.class).toBe('novel')
  })

  it('still vouches for a segment a witnessed reference carries', () => {
    // The catalogue actually returned this entity, so its segments are facts.
    const result = signed(
      plan(access, 'give billing-api read access to orders-db in prod'),
      context({
        witnessed: new Set([
          'component:default/billing-api',
          'resource:default/orders-db-prod',
        ]),
      }),
    )

    expect(result.classified.find((leaf) => leaf.path.endsWith('.name'))?.class).toBe('echoed')
  })
})

describe('a closed union is not a vocabulary', () => {
  it('vouches for a resource type the repository has never used yet', () => {
    // The circular block this closed. `spec.type` is `z.enum(RESOURCE_TYPE_NAMES)`
    // — a model cannot write one that is not in it, and a type outside the
    // union is refused by the schema before the signature ever sees it.
    // Measuring it against `vocabulary.types` — what the repository ALREADY
    // uses — meant the FIRST access of a repository could never be proposed:
    // no access exists, so `database-access` is in no vocabulary, so it is a
    // question, so no access is ever written. Structural, like `kind`.
    const firstEver = signed(
      plan(access, 'give billing-api read access to orders-db in prod'),
      context({
        // A repository holding one database and nothing else.
        vocabulary: { ...vocabulary, types: ['database'] },
      }),
    )

    expect(firstEver.classified.find((leaf) => leaf.path.endsWith('.type'))?.class).toBe(
      'derived',
    )
    expect(findUnknowns(firstEver.plan)).toEqual([])
  })
})
