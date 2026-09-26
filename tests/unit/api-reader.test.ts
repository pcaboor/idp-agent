import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { apiSchema, componentSchema, entitySchema } from '../../src/core/schemas/entity.js'
import { parseDocuments, parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'

/**
 * Backstage's own API kind, read (design § 4.1): a real catalogue declares its
 * APIs as `kind: API` and ties a service to them with `spec.providesApis`. Both
 * are read faithfully and neither is ever proposed — the read model is wider
 * than the write model.
 */

const GOLDEN = path.resolve(import.meta.dirname, '../golden/backstage-apis')
const golden = (relative: string): Promise<string> =>
  readFile(path.join(GOLDEN, relative), 'utf8')

const document = (...lines: string[]): string => `---\n${lines.join('\n')}\n`

const API_HEAD = ['apiVersion: backstage.io/v1alpha1', 'kind: API', 'metadata:', '  name: billing']

const api = (...spec: string[]): string => document(...API_HEAD, 'spec:', ...spec)

const VALID_SPEC = [
  '  type: openapi',
  '  lifecycle: production',
  '  owner: group:default/tiger',
  '  definition: openapi 3.1',
]

describe('kind: API', () => {
  it('is read as an entity of its own, beside the modelled ones and not among them', async () => {
    const read = parseDocuments(await golden('apis/billing.yml'))
    expect(read.rejections).toEqual([])
    expect(read.ignored).toEqual([])
    // Not a Component or a Resource: the write side never meets it.
    expect(read.entities).toEqual([])
    expect(read.apis).toHaveLength(1)
    expect(read.apis[0]).toMatchObject({
      kind: 'API',
      metadata: {
        name: 'billing',
        description: 'Invoices and credit notes, as billing-api serves them',
        tags: ['rest', 'invoices'],
        links: [{ url: 'https://docs.example.com/billing', title: 'Reference' }],
      },
      spec: { type: 'openapi', lifecycle: 'production', definition: 'declared' },
    })
  })

  it('normalises its owner and its system as the other kinds do', async () => {
    const [billing] = parseDocuments(await golden('apis/billing.yml')).apis
    expect(billing?.spec.owner).toBe('group:default/tiger')
    expect(billing?.spec.system).toBe('system:default/payments')
  })

  it('keeps that a definition is declared, and never what it says', async () => {
    const text = await golden('apis/payments.yml')
    expect(text).toContain('DEFINITION-BODY-NEVER-PRINTED')
    const [payments] = parseDocuments(text).apis
    expect(payments?.spec.definition).toBe('declared')
    expect(JSON.stringify(payments)).not.toContain('DEFINITION-BODY-NEVER-PRINTED')
    expect(JSON.stringify(payments)).not.toContain('proto3')

    const [billing] = parseDocuments(await golden('apis/billing.yml')).apis
    expect(JSON.stringify(billing)).not.toContain('openapi/billing.yaml')
  })

  it('takes a definition as text or as one Backstage placeholder', () => {
    for (const definition of [
      ['  definition: openapi 3.1'],
      ['  definition:', '    $text: ./openapi.yaml'],
      ['  definition:', '    $openapi: https://example.com/openapi.yaml'],
      ['  definition:', '    $asyncapi: ./asyncapi.yaml'],
    ]) {
      const spec = [...VALID_SPEC.slice(0, 3), ...definition]
      const { apis, rejections } = parseDocuments(api(...spec))
      expect(rejections).toEqual([])
      expect(apis[0]?.spec.definition).toBe('declared')
    }
  })

  it.each([
    ['no definition', VALID_SPEC.slice(0, 3), /^spec\.definition: /],
    ['an empty definition', [...VALID_SPEC.slice(0, 3), "  definition: ''"], /^spec\.definition: /],
    [
      'a definition that is a mapping and no placeholder',
      [...VALID_SPEC.slice(0, 3), '  definition:', '    openapi: 3.1.0', '    info: {}'],
      /^spec\.definition: /,
    ],
    // Backstage parses these two into structured data, and its API schema
    // then refuses the definition, which must be text.
    [
      'a $yaml placeholder, which Backstage resolves to data and not text',
      [...VALID_SPEC.slice(0, 3), '  definition:', '    $yaml: ./openapi.yaml'],
      /^spec\.definition: /,
    ],
    [
      'a $json placeholder, which Backstage resolves to data and not text',
      [...VALID_SPEC.slice(0, 3), '  definition:', '    $json: ./openapi.json'],
      /^spec\.definition: /,
    ],
    [
      'a placeholder that names nothing',
      [...VALID_SPEC.slice(0, 3), '  definition:', '    $text: 42'],
      /^spec\.definition: /,
    ],
    ['no type', VALID_SPEC.filter((line) => !line.includes('type')), /^spec\.type: /],
    ['no lifecycle', VALID_SPEC.filter((line) => !line.includes('lifecycle')), /^spec\.lifecycle: /],
    ['no owner', VALID_SPEC.filter((line) => !line.includes('owner')), /^spec\.owner: /],
  ])('refuses an API with %s, and says which field', (_, spec, reason) => {
    const { apis, rejections, ignored } = parseDocuments(api(...spec))
    expect(apis).toEqual([])
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toMatch(reason)
  })

  it('never quotes a refused definition in the reason', () => {
    const [reason] = parseDocuments(
      api(...VALID_SPEC.slice(0, 3), '  definition:', '    SECRET-KEY: SECRET-VALUE'),
    ).rejections
    expect(reason).toBeDefined()
    expect(reason).not.toMatch(/SECRET/)
  })

  it('refuses the API missing its definition in the golden repository', async () => {
    const { apis, rejections } = parseDocuments(await golden('apis/ledger.yml'))
    expect(apis).toEqual([])
    expect(rejections).toEqual([expect.stringMatching(/^spec\.definition: /)])
  })

  it('reads the kind in any case, as it reads Component and Resource: to the schema', () => {
    // `kind: api` is not someone else's kind to set aside: it is an API, and
    // the schema says what Backstage says of it — the kind is spelled API.
    const { apis, rejections, ignored } = parseDocuments(
      document('apiVersion: backstage.io/v1alpha1', 'kind: api', 'metadata:', '  name: billing', 'spec:', ...VALID_SPEC),
    )
    expect(apis).toEqual([])
    expect(ignored).toEqual([])
    expect(rejections).toEqual([expect.stringMatching(/^kind: /)])
  })

  it('reads an API under Backstage\'s v1beta1 as under v1alpha1, as Backstage does', () => {
    const { apis, rejections } = parseDocuments(
      document('apiVersion: backstage.io/v1beta1', 'kind: API', 'metadata:', '  name: billing', 'spec:', ...VALID_SPEC),
    )
    expect(rejections).toEqual([])
    expect(apis.map((one) => one.metadata.name)).toEqual(['billing'])
  })

  it('refuses an API under an apiVersion Backstage has no API schema for', () => {
    const { apis, rejections } = parseDocuments(
      document('apiVersion: backstage.io/v2', 'kind: API', 'metadata:', '  name: billing', 'spec:', ...VALID_SPEC),
    )
    expect(apis).toEqual([])
    expect(rejections).toEqual([expect.stringMatching(/^apiVersion: /)])
  })

  it('refuses an API with no apiVersion at all: a broken header, not somebody else\'s kind', () => {
    const { apis, ignored, rejections } = parseDocuments(
      document('kind: API', 'metadata:', '  name: billing', 'spec:', ...VALID_SPEC),
    )
    expect(apis).toEqual([])
    expect(ignored).toEqual([])
    expect(rejections).toEqual([expect.stringMatching(/^apiVersion: /)])
  })

  it('sets aside a kind API of another tool\'s apiVersion, as it did every API before', () => {
    // WSO2's API gateway declares `kind: API` under its own apiVersion: not a
    // Backstage entity, and not this tool's to refuse.
    const { apis, ignored, rejections } = parseDocuments(
      document(
        'apiVersion: dp.wso2.com/v1alpha2',
        'kind: API',
        'metadata:',
        '  name: http-bin-api',
        'spec:',
        '  apiDisplayName: HTTP Bin API',
        '  apiVersion: v1.0',
      ),
    )
    expect(apis).toEqual([])
    expect(rejections).toEqual([])
    expect(ignored).toEqual([
      {
        kind: 'API',
        ref: 'api:default/http-bin-api',
        reason: "kind API under dp.wso2.com/v1alpha2 is not Backstage's; api http-bin-api left as is",
      },
    ])
  })

  it('sets aside an API outside the default namespace, under its own reference, as before', () => {
    // Every entity of the graph is keyed `kind:default/name`: read, an API of
    // namespace payments would take the reference of another, and two of one
    // name in two namespaces would be a duplicate.
    const namespaced = (namespace: string): string =>
      document(
        'apiVersion: backstage.io/v1alpha1',
        'kind: API',
        'metadata:',
        '  name: billing',
        `  namespace: ${namespace}`,
        'spec:',
        ...VALID_SPEC,
      )
    const { apis, ignored, rejections } = parseDocuments(namespaced('payments'))
    expect(apis).toEqual([])
    expect(rejections).toEqual([])
    expect(ignored).toEqual([
      {
        kind: 'API',
        ref: 'api:payments/billing',
        reason:
          'namespace payments is not modelled by this tool; api billing left as is',
      },
    ])
    // The default namespace, said or not and in any case, is the one read.
    for (const namespace of ['default', 'Default']) {
      expect(parseDocuments(namespaced(namespace)).apis).toHaveLength(1)
    }
  })

  it('sets aside an API whose name Backstage allows and this tool does not read', () => {
    // Backstage allows upper case in a name; this tool's grammar is lower
    // case, and it never writes an API. Refusing one would turn validate red
    // over a document Backstage ingests; it is left as is, as it was.
    const { apis, ignored, rejections } = parseDocuments(
      document('apiVersion: backstage.io/v1alpha1', 'kind: API', 'metadata:', '  name: PetStore', 'spec:', ...VALID_SPEC),
    )
    expect(apis).toEqual([])
    expect(rejections).toEqual([])
    expect(ignored).toEqual([
      {
        kind: 'API',
        ref: 'api:default/petstore',
        reason: 'a name in upper case is not one this tool reads; api PetStore left as is',
      },
    ])
  })

  it('refuses an API whose name Backstage refuses too', () => {
    for (const name of ['-billing', 'Pet Store', 'Billing-', 'x'.repeat(64)]) {
      const { apis, ignored, rejections } = parseDocuments(
        document('apiVersion: backstage.io/v1alpha1', 'kind: API', 'metadata:', `  name: "${name}"`, 'spec:', ...VALID_SPEC),
      )
      expect(apis).toEqual([])
      expect(ignored).toEqual([])
      expect(rejections).toEqual([expect.stringMatching(/^metadata\.name: /)])
    }
  })

  it('still sets aside a Group, a System and a Domain, exactly as before', () => {
    const { apis, ignored, rejections } = parseDocuments(
      [
        document('apiVersion: backstage.io/v1alpha1', 'kind: Group', 'metadata:', '  name: tiger'),
        document('apiVersion: backstage.io/v1alpha1', 'kind: System', 'metadata:', '  name: payments'),
        document('apiVersion: backstage.io/v1alpha1', 'kind: Domain', 'metadata:', '  name: money'),
      ].join('\n'),
    )
    expect(apis).toEqual([])
    expect(rejections).toEqual([])
    expect(ignored).toEqual([
      {
        kind: 'Group',
        ref: 'group:default/tiger',
        reason: 'kind Group is not modelled by this tool; group tiger left as is',
      },
      {
        kind: 'System',
        ref: 'system:default/payments',
        reason: 'kind System is not modelled by this tool; system payments left as is',
      },
      {
        kind: 'Domain',
        ref: 'domain:default/money',
        reason: 'kind Domain is not modelled by this tool; domain money left as is',
      },
    ])
  })

  it('is not an entity the write model accepts', () => {
    const value = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'API',
      metadata: { name: 'billing' },
      spec: { type: 'openapi', lifecycle: 'production', owner: 'tiger', definition: 'x' },
    }
    expect(apiSchema.safeParse(value).success).toBe(true)
    expect(entitySchema.safeParse(value).success).toBe(false)
  })
})

describe('spec.providesApis on a Component', () => {
  const component = (...spec: string[]): string =>
    document(
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: billing-api',
      '  namespace: payments',
      'spec:',
      '  type: service',
      '  lifecycle: production',
      '  owner: tiger',
      ...spec,
    )

  it('is read, a short reference taking the API kind and the entity namespace', () => {
    const { entities, rejections } = parseDocuments(
      component(
        '  providesApis:',
        '    - billing',
        '    - ledger/events',
        '    - API:Default/invoices',
        '    - component:shop',
      ),
    )
    expect(rejections).toEqual([])
    const [billing] = entities
    expect(billing?.kind === 'Component' ? billing.spec.providesApis : undefined).toEqual([
      'api:payments/billing',
      'api:ledger/events',
      'api:default/invoices',
      // An explicit other kind is kept as written: Backstage defaults the
      // kind, it does not overrule one.
      'component:payments/shop',
    ])
  })

  it('compares a name in upper case as Backstage does, without regard to case', () => {
    // Backstage allows upper case in a name and compares references
    // case-insensitively; the API such a name declares is set aside under
    // its lower-cased reference (`ignoredOf`), which this one then names.
    const { entities, rejections } = parseDocuments(
      component(
        '  providesApis:',
        '    - PetStore',
        '    - Ledger/petstore-API',
        '    - api:default/Invoices',
        '    - petstore',
      ),
    )
    expect(rejections).toEqual([])
    const [billing] = entities
    expect(billing?.kind === 'Component' ? billing.spec.providesApis : undefined).toEqual([
      'api:payments/petstore',
      'api:ledger/petstore-api',
      'api:default/invoices',
    ])
  })

  it('keeps a reference its grammar cannot split as written, and never refuses the Component', () => {
    // Refusing would take the service out of every command, and turn validate
    // red, over a line of its card — readSystemRefSchema's case. Nothing
    // declares what it names, so it is reported dangling.
    const { entities, rejections } = parseDocuments(
      component('  providesApis:', '    - "not a ref!"', '    - api:pet store'),
    )
    expect(rejections).toEqual([])
    const [billing] = entities
    expect(billing?.kind === 'Component' ? billing.spec.providesApis : undefined).toEqual([
      'not a ref!',
      'api:pet store',
    ])
  })

  it('refuses an empty reference, which names nothing at all', () => {
    const { rejections } = parseDocuments(component('  providesApis:', "    - ''"))
    expect(rejections).toEqual([expect.stringMatching(/^spec\.providesApis\.0: /)])
  })

  it('reads an API provided twice as provided once, first spelling first', () => {
    // Backstage keeps relations as a set: listing an API twice provides it once.
    const { entities } = parseDocuments(
      component(
        '  providesApis:',
        '    - billing',
        '    - ledger',
        '    - api:payments/billing',
        '    - API:Payments/billing',
        '    - billing',
      ),
    )
    const [billing] = entities
    expect(billing?.kind === 'Component' ? billing.spec.providesApis : undefined).toEqual([
      'api:payments/billing',
      'api:payments/ledger',
    ])
  })

  it('is optional, and absent when a Component declares none', async () => {
    const [orders] = parseDocuments(await golden('components/orders-api.yml')).entities
    expect(orders?.spec).not.toHaveProperty('providesApis')
  })

  it('drops spec.consumesApis: consumption is an access right, and a second truth is none', async () => {
    const [billing] = parseDocuments(await golden('components/billing-api.yml')).entities
    expect(billing?.spec).not.toHaveProperty('consumesApis')
    expect(billing?.kind === 'Component' ? billing.spec.providesApis : undefined).toEqual([
      'api:default/billing',
      'api:default/ghost',
    ])
  })

  it('is not read on a Resource, which provides no API in Backstage', () => {
    const [resource] = parseDocuments(
      document(
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: orders-db',
        'spec:',
        '  type: database',
        '  owner: group:default/tiger',
        '  providesApis:',
        '    - billing',
      ),
    ).entities
    expect(resource?.spec).not.toHaveProperty('providesApis')
  })

  it('round-trips through the serialiser, as a system and links do', async () => {
    const [billing] = parseDocuments(await golden('components/billing-api.yml')).entities
    expect(billing).toBeDefined()
    expect(parseEntity(serializeEntity(billing!))).toEqual(billing)
    expect(serializeEntity(billing!)).toContain(
      '  providesApis:\n    - api:default/billing\n    - api:default/ghost\n',
    )
  })

  it('leaves a Component that declares none serialised exactly as before', () => {
    const plain = componentSchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'orders-api' },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/lion' },
    })
    expect(serializeEntity(plain)).not.toContain('providesApis')
  })
})
