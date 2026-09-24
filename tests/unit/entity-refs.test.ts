import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { entitySchema } from '../../src/core/schemas/entity.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { parseDocuments } from '../../src/core/yaml/serialize.js'

/**
 * A reference as a real Backstage catalogue writes it: `[<kind>:][<namespace>/]<name>`,
 * the omitted parts filled in the way Backstage fills them. The reader accepts
 * that and yields the full form; a proposal does not.
 */

/**
 * Backstage's own example entity, verbatim as the owner's repository held it
 * when it loaded empty: `spec.owner` names a group the way nearly every real
 * catalogue does, with neither kind nor namespace.
 */
const ARTIST_WEB = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: artist-web
  description: The place to be, for great artists
  labels:
    example.com/custom: custom_label_value
  annotations:
    example.com/service-discovery: artistweb
    circleci.com/project-slug: github/example-org/artist-website
  tags:
    - java
  links:
    - url: https://admin.example-org.com
      title: Admin Dashboard
      icon: dashboard
      type: admin-dashboard
spec:
  type: website
  lifecycle: production
  owner: artist-relations-team
  system: public-websites
`

const component = (spec: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'artist-web', ...metadata },
  spec: { type: 'website', lifecycle: 'production', owner: 'group:default/tiger', ...spec },
})

const grant = (spec: Record<string, unknown>) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'artists-db-access' },
  spec: { type: 'database-access', owner: 'group:default/tiger', ...spec },
})

const read = (value: unknown) => {
  const parsed = entitySchema.safeParse(value)
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
  return parsed.data
}

const refusal = (value: unknown): string[] => {
  const parsed = entitySchema.safeParse(value)
  expect(parsed.success).toBe(false)
  return (parsed.error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`)
}

describe('the reader, on the owner a real catalogue writes', () => {
  it("reads Backstage's own artist-web as a Component owned by a group", () => {
    const { entities, rejections } = parseDocuments(ARTIST_WEB)

    expect(rejections).toEqual([])
    expect(entities).toHaveLength(1)
    expect(entities[0]?.kind).toBe('Component')
    expect(entities[0]?.metadata.name).toBe('artist-web')
    expect(entities[0]?.spec.owner).toBe('group:default/artist-relations-team')
  })

  it.each([
    ['team-a', 'group:default/team-a'],
    ['user:jdoe', 'user:default/jdoe'],
    ['payments/team-a', 'group:payments/team-a'],
    ['Group:team-a', 'group:default/team-a'],
    ['USER:Payments/jdoe', 'user:payments/jdoe'],
    ['group:default/team-a', 'group:default/team-a'],
  ])('reads owner %s as %s', (owner, full) => {
    expect(read(component({ owner })).spec.owner).toBe(full)
  })

  it('refuses an owner of any kind but a group or a user', () => {
    expect(refusal(component({ owner: 'component:team-a' }))).toEqual([
      'spec.owner: expected group:... or user:...',
    ])
  })

  it('still refuses a name with an upper-case letter, in the words it always had', () => {
    // Only the kind and the namespace compare case-insensitively; a name
    // outside the grammar is the refusal it was before short forms were read.
    expect(refusal(component({ owner: 'Team-A' }))).toEqual([
      'spec.owner: expected group:... or user:...',
    ])
    expect(refusal(component({ dependsOn: ['resource:default/Artists-DB'] }))).toEqual([
      'spec.dependsOn.0: expected kind:namespace/name',
    ])
  })
})

describe('the reader, on a dependency', () => {
  it('fills in the namespace of a dependency that names its kind', () => {
    expect(read(component({ dependsOn: ['resource:artists-db'] })).spec.dependsOn).toEqual([
      'resource:default/artists-db',
    ])
    const consumers = read(grant({ dependencyOf: ['Component:artist-web'] }))
    expect(consumers.kind === 'Resource' && consumers.spec.dependencyOf).toEqual([
      'component:default/artist-web',
    ])
  })

  it('refuses a dependency that names no kind, and says the kind is required', () => {
    // Backstage gives spec.dependsOn and spec.dependencyOf no default kind:
    // supplying one here would be inference.
    const [dependsOn] = refusal(component({ dependsOn: ['artists-db'] }))
    expect(dependsOn).toMatch(/^spec\.dependsOn\.0: .*kind.*required/)
    const [dependencyOf] = refusal(grant({ dependencyOf: ['default/artist-web'] }))
    expect(dependencyOf).toMatch(/^spec\.dependencyOf\.0: .*kind.*required/)
  })
})

describe("the reader, on the referring entity's namespace", () => {
  it('fills an omitted namespace from metadata.namespace, lower-cased', () => {
    const entity = read(
      component({ owner: 'team-a', dependsOn: ['resource:artists-db'] }, { namespace: 'Payments' }),
    )
    expect(entity.spec.owner).toBe('group:payments/team-a')
    expect(entity.spec.dependsOn).toEqual(['resource:payments/artists-db'])
  })

  it('leaves a namespace the reference states alone', () => {
    const entity = read(component({ owner: 'shared/team-a' }, { namespace: 'payments' }))
    expect(entity.spec.owner).toBe('group:shared/team-a')
  })

  it('takes default only when metadata.namespace is absent', () => {
    // Backstage's documented default is for a namespace left out. One that is
    // present and not a string is malformed, not absent: reading it as default
    // would be a guess.
    expect(read(component({ owner: 'team-a' })).spec.owner).toBe('group:default/team-a')
    for (const namespace of [42, true, null, { name: 'payments' }]) {
      expect(refusal(component({ owner: 'team-a' }, { namespace }))).toEqual([
        'spec.owner: names no namespace, and metadata.namespace is not a valid one',
      ])
    }
  })

  it('refuses a short reference that would take a namespace no reference can name', () => {
    expect(refusal(component({ owner: 'team-a' }, { namespace: 'pay_ments' }))).toEqual([
      'spec.owner: names no namespace, and metadata.namespace is not a valid one',
    ])
    expect(refusal(component({ owner: 'team-a' }, { namespace: '' }))).toEqual([
      'spec.owner: names no namespace, and metadata.namespace is not a valid one',
    ])
    // Only when the reference needs it: a full one reads as it always did.
    expect(read(component({}, { namespace: 'pay_ments' })).spec.owner).toBe(
      'group:default/tiger',
    )
  })

  it('checks metadata.namespace before lower-casing it', () => {
    // U+212A KELVIN SIGN lower-cases to an ASCII 'k': folded first, a
    // lookalike would resolve to a real namespace. Backstage's grammar is ASCII.
    const kelvin = '\u212Aube'
    expect(kelvin.toLowerCase()).toBe('kube')
    expect(
      refusal(component({ owner: 'team-a', dependsOn: ['resource:db'] }, { namespace: kelvin })),
    ).toEqual([
      'spec.owner: names no namespace, and metadata.namespace is not a valid one',
      'spec.dependsOn.0: names no namespace, and metadata.namespace is not a valid one',
    ])
  })

  it('does not repeat metadata.namespace back into the reason', () => {
    // The reason reaches a CI log and a terminal: a value from the file is not
    // echoed there, escape sequences included.
    const namespace = '\u001b[2J\u001b[H+++ 0 violations\u001b]52;c;ZXZpbA==\u0007'
    const [reason] = refusal(component({ owner: 'team-a' }, { namespace }))
    expect(reason).toBe('spec.owner: names no namespace, and metadata.namespace is not a valid one')
    const declared = `  name: artist-web\n  namespace: ${JSON.stringify(namespace)}\n`
    const { rejections } = parseDocuments(ARTIST_WEB.replace('  name: artist-web\n', declared))
    expect(rejections).toHaveLength(1)
    expect(JSON.stringify(rejections)).not.toMatch(/\\u001b|\\u0007/)
    expect(JSON.stringify(rejections)).not.toContain('violations')
  })

  it('does not start carrying metadata.namespace', () => {
    // Namespaces are separate work: every entity is still keyed as default.
    expect(read(component({}, { namespace: 'payments' })).metadata).not.toHaveProperty(
      'namespace',
    )
  })
})

describe('a proposal', () => {
  const proposal = (spec: Record<string, unknown>) => ({
    intent: 'declare orders-db in prod owned by team-a',
    operations: [
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: { name: 'orders-db-prod', env: 'prod' },
          spec: { type: 'database', owner: 'group:default/team-a', ...spec },
        },
      },
    ],
  })

  it('is still refused at the schema gate for an owner in short form', () => {
    // The engine only ever writes the full form; a proposal is not a catalogue
    // to be read generously.
    expect(planSchema.safeParse(proposal({})).success).toBe(true)
    expect(planSchema.safeParse(proposal({ owner: 'team-a' })).success).toBe(false)
    expect(planSchema.safeParse(proposal({ owner: 'Group:default/team-a' })).success).toBe(false)
  })

  it('is still refused for a dependency in short form', () => {
    expect(planSchema.safeParse(proposal({ dependsOn: ['resource:other-db'] })).success).toBe(
      false,
    )
  })
})

describe('the commands, over a catalogue written in short form', () => {
  const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

  const repository = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'idp-short-refs-'))
    await cp(FIXTURES, root, { recursive: true })
    await mkdir(path.join(root, 'catalog/apis'), { recursive: true })
    await writeFile(path.join(root, 'catalog/apis/.witness.yml'), '# Declares nothing.\n')
    await writeFile(path.join(root, 'catalog/apis/api-1.yml'), ARTIST_WEB)
    return root
  }

  const run = async (argv: string[]) => {
    const io = { out: [] as string[], err: [] as string[] }
    const code = await main(argv, {
      out: (chunk) => io.out.push(chunk),
      err: (chunk) => io.err.push(chunk),
    })
    return { code, out: io.out.join(''), err: io.err.join('') }
  }

  it('validate reports no violation for it', async () => {
    const { code, out } = await run(['validate', await repository()])
    expect(out).not.toMatch(/^error/m)
    expect(out).toMatch(/34 entities in \d+ files, 0 violations/)
    expect(code).toBe(0)
  })

  it('graph and show find artist-web, owned by its group', async () => {
    const root = await repository()

    const graph = await run(['graph', '--repo', root])
    expect(graph.err).not.toContain('skipped')
    expect(graph.out).toContain('artist-web')
    expect(graph.code).toBe(0)

    const show = await run(['show', 'artist-web', '--repo', root])
    expect(show.out).toContain('group:default/artist-relations-team')
    expect(show.code).toBe(0)
  })
})
