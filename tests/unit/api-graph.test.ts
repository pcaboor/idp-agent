import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runValidate } from '../../src/cli/commands/validate.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import { IacFsProvider } from '../../src/context/iac-fs/provider.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { checkRepository } from '../../src/core/validate/rules.js'
import { parseDocuments } from '../../src/core/yaml/serialize.js'

/**
 * A repository that is also a Backstage catalogue: two APIs, a service that
 * provides one of them and a second that does not exist, a flow over the
 * other, an API missing its definition, and a Group. What the graph makes of
 * it, and what `validate` says of it.
 */

const GOLDEN = path.resolve(import.meta.dirname, '../golden/backstage-apis')
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
/** Two APIs named billing, in namespaces payments and ledger, and a right over one. */
const NAMESPACES = path.resolve(import.meta.dirname, '../golden/backstage-namespaces')

const load = async (root: string = GOLDEN) => {
  const loaded = await new IacFsProvider(root).load()
  const graph = EntityGraph.from(
    loaded.entities,
    loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
  )
  return { ...loaded, graph }
}

const refs = (entities: readonly { kind: string; metadata: { name: string } }[]): string[] =>
  entities.map((entity) => `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`)

describe('the providers', () => {
  it('load APIs as entities, and no longer as documents set aside', async () => {
    const { entities, rejected, ignored } = await load()
    expect(refs(entities)).toEqual([
      'api:default/billing',
      'api:default/payments',
      'resource:default/payments',
      'component:default/billing-api',
      'component:default/orders-api',
      'resource:default/orders-api-to-payments',
    ])
    expect(rejected).toEqual([
      { source: 'apis/ledger.yml', reason: expect.stringMatching(/^spec\.definition: /) },
    ])
    expect(ignored.map(({ kind }) => kind)).toEqual(['Group'])
  })

  it('agree with each other: the fixture reader reads the same entities', async () => {
    const fixture = await new FixtureProvider(GOLDEN).load()
    expect(refs(fixture.entities)).toEqual(refs((await load()).entities))
  })
})

describe('the graph', () => {
  it('holds an API as a node, under its own reference', async () => {
    const { graph } = await load()
    expect(graph.get('api:default/payments')?.kind).toBe('API')
    // A Resource of the same name is another entity: the kind is part of the reference.
    expect(graph.get('resource:default/payments')?.kind).toBe('Resource')
    expect(refOf(graph.get('api:default/billing')!)).toBe('api:default/billing')
  })

  it('answers the APIs a component provides, present ones only, in declared order', async () => {
    const { graph } = await load()
    expect(refs(graph.providedApisOf('component:default/billing-api'))).toEqual([
      'api:default/billing',
    ])
    expect(graph.providedApisOf('component:default/orders-api')).toEqual([])
  })

  it('answers the components that provide an API', async () => {
    const { graph } = await load()
    expect(refs(graph.providersOf('api:default/billing'))).toEqual(['component:default/billing-api'])
    expect(graph.providersOf('api:default/payments')).toEqual([])
  })

  it('makes the two exact transposes of each other', async () => {
    const { graph } = await load()
    for (const component of graph.all()) {
      for (const api of graph.all()) {
        const provides = refs(graph.providedApisOf(refOf(component))).includes(refOf(api))
        const provided = refs(graph.providersOf(refOf(api))).includes(refOf(component))
        expect(provides).toBe(provided)
      }
    }
  })

  it('resolves a right over an API to the API, so its consumers are walked as for any object', async () => {
    const { graph } = await load()
    expect(refs(graph.dependenciesOf('resource:default/orders-api-to-payments'))).toEqual([
      'api:default/payments',
    ])
    expect(refs(graph.dependantsOf('api:default/payments'))).toEqual([
      'resource:default/orders-api-to-payments',
    ])
    expect(refs(graph.consumersOf('api:default/payments'))).toEqual(['component:default/orders-api'])
    // The Resource sharing the name is not what the right is over.
    expect(graph.dependantsOf('resource:default/payments')).toEqual([])
  })

  it('does not count providing an API as depending on it, either way', async () => {
    const { graph } = await load()
    expect(graph.dependenciesOf('component:default/billing-api')).toEqual([])
    expect(graph.dependantsOf('api:default/billing')).toEqual([])
    expect(graph.consumersOf('api:default/billing')).toEqual([])
  })

  it('reports a providesApis naming nothing as dangling, and only that', async () => {
    const { graph } = await load()
    expect(graph.danglingReferences()).toEqual([
      { from: 'component:default/billing-api', to: 'api:default/ghost' },
    ])
  })

  it('reads an API a component lists twice as provided once, and names that component once', () => {
    const { entities, apis } = parseDocuments(
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: one',
        'spec:',
        '  type: service',
        '  lifecycle: production',
        '  owner: tiger',
        '  providesApis: [billing, billing, api:default/billing]',
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: API',
        'metadata:',
        '  name: billing',
        'spec:',
        '  type: openapi',
        '  lifecycle: production',
        '  owner: tiger',
        '  definition: openapi 3.1',
        '',
      ].join('\n'),
    )
    const graph = EntityGraph.from([...entities, ...apis])
    expect(refs(graph.providedApisOf('component:default/one'))).toEqual(['api:default/billing'])
    expect(refs(graph.providersOf('api:default/billing'))).toEqual(['component:default/one'])
  })

  it('resolves a providesApis naming, in any case, an API set aside for its upper-case name', () => {
    // Backstage allows the name and compares references without regard to
    // case: the service provides the API the repository declares, which is
    // no dangling reference.
    const { entities, apis, ignored } = parseDocuments(
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: one',
        'spec:',
        '  type: service',
        '  lifecycle: production',
        '  owner: tiger',
        '  providesApis: [PetStore]',
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: API',
        'metadata:',
        '  name: PetStore',
        'spec:',
        '  type: openapi',
        '  lifecycle: production',
        '  owner: tiger',
        '  definition: openapi 3.1',
        '',
      ].join('\n'),
    )
    const graph = EntityGraph.from(
      [...entities, ...apis],
      ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
    )
    expect(graph.danglingReferences()).toEqual([])
  })

  it('finds APIs by kind, type and owner', async () => {
    const { graph } = await load()
    expect(refs(graph.search({ kind: 'API' }))).toEqual(['api:default/billing', 'api:default/payments'])
    expect(refs(graph.search({ type: 'grpc' }))).toEqual(['api:default/payments'])
    expect(refs(graph.search({ kind: 'API', owner: 'group:default/tiger' }))).toEqual([
      'api:default/billing',
    ])
  })

  it('answers exactly as before over the demo SI, which declares no API', async () => {
    const { graph } = await load(DEMO)
    expect(graph.search({ kind: 'API' })).toEqual([])
    for (const entity of graph.all()) {
      expect(graph.providedApisOf(refOf(entity))).toEqual([])
      expect(graph.providersOf(refOf(entity))).toEqual([])
    }
    expect(graph.danglingReferences()).toEqual([])
  })
})

describe('validate', () => {
  it('refuses the broken API, and calls the providesApis to nothing dangling', async () => {
    const violations = checkRepository(await readRepository(GOLDEN))
    expect(violations.map(({ rule, file, severity, message }) => [severity, rule, file, message])).toEqual([
      ['error', 'invalid-entity', 'apis/ledger.yml', expect.stringMatching(/^spec\.definition: /)],
      [
        'warning',
        'not-modelled',
        'org/teams.yml',
        'kind Group is not modelled by this tool; group tiger left as is',
      ],
      [
        'warning',
        'dangling-reference',
        'components/billing-api.yml',
        'component:default/billing-api names api:default/ghost, which nothing declares',
      ],
    ])
  })

  it('demands no witness and no conventional path of an API: this tool never files one', async () => {
    const violations = checkRepository(await readRepository(GOLDEN))
    expect(violations.filter(({ file }) => file.startsWith('apis/') && file !== 'apis/ledger.yml')).toEqual([])
    expect(violations.map(({ rule }) => rule)).not.toContain('missing-witness')
    expect(violations.map(({ rule }) => rule)).not.toContain('misplaced-entity')
  })

  it('calls two APIs of one name a duplicate, as it does any entity', async () => {
    const snapshot = await readRepository(GOLDEN)
    const billing = snapshot.files.find((file) => file.path === 'apis/billing.yml')!
    const violations = checkRepository({
      ...snapshot,
      files: [...snapshot.files, { ...billing, path: 'apis/billing-copy.yml' }],
    })
    expect(violations).toContainEqual({
      rule: 'duplicate-name',
      file: 'apis/billing-copy.yml',
      severity: 'error',
      message: 'api:default/billing is declared in apis/billing-copy.yml, apis/billing.yml',
    })
  })

  it('does not count an API beside its Component as a second entity in the file', async () => {
    // catalog-info.yaml holding a service and the API it provides is the most
    // common shape a Backstage catalogue has. One file per entity is how this
    // tool files what it writes, and it never writes an API.
    const snapshot = await readRepository(GOLDEN)
    const component = snapshot.files.find((file) => file.path === 'components/billing-api.yml')!
    const api = snapshot.files.find((file) => file.path === 'apis/billing.yml')!
    const violations = checkRepository({
      ...snapshot,
      files: [
        ...snapshot.files.filter((file) => file !== component && file !== api),
        { ...component, apis: api.apis, documents: 2 },
      ],
    })
    expect(violations.map(({ rule }) => rule)).not.toContain('multiple-entities')
  })

  it('counts the APIs it read among the entities', async () => {
    const { text, found } = await runValidate(GOLDEN)
    expect(found).toBe(false)
    expect(text.split('\n').at(-1)).toBe('6 entities in 8 files, 1 violations')
  })

  it('reads APIs outside the default namespace as it did before: set aside, under their own reference', async () => {
    // Keyed `kind:default/name`, the two would be one duplicate, the right over
    // api:payments/billing would dangle, and a lookup of api:default/billing
    // would find one of them.
    expect(await runValidate(NAMESPACES)).toEqual({
      text: [
        'warning apis/billing-ledger.yml: namespace ledger is not modelled by this tool; api billing left as is',
        'warning apis/billing-payments.yml: namespace payments is not modelled by this tool; api billing left as is',
        '',
        '2 entities in 4 files, 0 violations',
      ].join('\n'),
      found: true,
    })
    const { graph, ignored } = await load(NAMESPACES)
    expect(ignored.map(({ ref }) => ref)).toEqual(['api:ledger/billing', 'api:payments/billing'])
    expect(graph.get('api:default/billing')).toBeUndefined()
    // The right's dependsOn and the component's providesApis both resolve.
    expect(graph.danglingReferences()).toEqual([])
  })

  it('prints over the demo SI exactly what it printed before', async () => {
    expect(await runValidate(DEMO)).toEqual({
      text: '33 entities in 33 files, 0 violations',
      found: true,
    })
  })
})
