import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatSummary } from '../../src/agents/summary.js'
import { main, parseArguments } from '../../src/cli/index.js'
import { renderEntityDetail } from '../../src/cli/render/entity.js'
import { renderOverview } from '../../src/cli/render/overview.js'
import { renderTable } from '../../src/cli/render/table.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { overviewOf } from '../../src/context/graph/overview.js'
import { summariseGraph } from '../../src/context/graph/summary.js'
import { parseDocuments } from '../../src/core/yaml/serialize.js'

/**
 * What a person sees of Backstage's APIs: `show`'s card, `graph`'s rows and
 * `--kind API`, the overview's figure. And, over the demo SI, which declares
 * none, exactly what they saw before — every byte of it, against what `main`
 * printed (`tests/golden/demo-read/`, captured from the build this change
 * started from).
 */

const GOLDEN = path.resolve(import.meta.dirname, '../golden/backstage-apis')
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const BEFORE = path.resolve(import.meta.dirname, '../golden/demo-read')
const before = (name: string): Promise<string> => readFile(path.join(BEFORE, name), 'utf8')

const run = async (argv: string[]) => {
  const io = { out: [] as string[], err: [] as string[] }
  const code = await main(argv, {
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
    events: () => {},
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

const HEADERS = ['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER']
const DANGLING = '\n\n1 dangling reference(s):\n  component:default/billing-api -> api:default/ghost\n'

describe('graph', () => {
  it('lists an API as a row whose kind is API', async () => {
    const { code, out, err } = await run(['graph', '--repo', GOLDEN])
    expect(code).toBe(0)
    expect(out).toBe(
      renderTable(HEADERS, [
        ['billing', 'API', 'openapi', '-', 'group:default/tiger'],
        ['payments', 'API', 'grpc', '-', 'group:default/lion'],
        ['payments', 'Resource', 'api', 'prod', 'group:default/lion'],
        ['billing-api', 'Component', 'service', 'prod', 'group:default/tiger'],
        ['orders-api', 'Component', 'service', 'prod', 'group:default/lion'],
        ['orders-api-to-payments', 'Resource', 'network-access', 'prod', 'group:default/lion'],
      ]) + DANGLING,
    )
    // The broken API is named, the Group is counted, and no API is "not loaded".
    expect(err).toMatch(/^skipped apis\/ledger\.yml: spec\.definition: /m)
    expect(err).toContain('not loaded: 1 document this tool does not model (Group ×1)\n')
  })

  it('filters on --kind API', async () => {
    const { code, out } = await run(['graph', '--kind', 'API', '--repo', GOLDEN])
    expect(code).toBe(0)
    expect(out).toBe(
      renderTable(HEADERS, [
        ['billing', 'API', 'openapi', '-', 'group:default/tiger'],
        ['payments', 'API', 'grpc', '-', 'group:default/lion'],
      ]) + DANGLING,
    )
  })

  it('parses --kind API, and names it among the kinds a bad one may be', () => {
    expect(parseArguments(['graph', '--kind', 'API'])).toEqual({
      name: 'graph',
      options: { kind: 'API' },
    })
    expect(parseArguments(['graph', '--kind', 'Group'])).toEqual({
      name: 'error',
      message: 'kind must be Component, Resource or API',
    })
  })

  it('finds no API in the demo SI, and says so as it says any empty filter', async () => {
    const { code, out } = await run(['graph', '--kind', 'API', '--demo'])
    expect(code).toBe(1)
    expect(out).toBe('No entity matches those filters.\n')
  })
})

describe('show', () => {
  it('prints an API: what it is, that its definition is declared, and who provides it', async () => {
    const { code, out } = await run(['show', 'api:default/billing', '--repo', GOLDEN])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'api:default/billing',
        '',
        '  kind         API',
        '  type         openapi',
        '  lifecycle    production',
        '  definition   declared',
        '  owner        group:default/tiger',
        '  environment  (undeclared)',
        '  description  Invoices and credit notes, as billing-api serves them',
        '  system       system:default/payments',
        '  tags         rest, invoices',
        '',
        'links',
        '  Reference — https://docs.example.com/billing',
        '',
        'provided by',
        '  component:default/billing-api',
        '',
        'depends on',
        '  none',
        '',
        'used by',
        '  none',
        '',
      ].join('\n'),
    )
  })

  it('prints the rights over an API and the services they reach, as for any object', async () => {
    const { code, out } = await run(['show', 'api:default/payments', '--repo', GOLDEN])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'api:default/payments',
        '',
        '  kind         API',
        '  type         grpc',
        '  lifecycle    experimental',
        '  definition   declared',
        '  owner        group:default/lion',
        '  environment  (undeclared)',
        '',
        'provided by',
        '  none',
        '',
        'depends on',
        '  none',
        '',
        'used by',
        '  resource:default/orders-api-to-payments  prod',
        '',
        'reached by services',
        '  component:default/orders-api',
        '',
      ].join('\n'),
    )
    expect(out).not.toContain('DEFINITION-BODY-NEVER-PRINTED')
    expect(out).not.toContain('proto3')
  })

  it('prints what a component provides, when it provides anything', async () => {
    // `ghost` names no API: it is listed after what resolves, and said to be
    // declared nowhere, rather than left off a card that would then read as
    // providing one API.
    const { code, out } = await run(['show', 'billing-api', '--repo', GOLDEN])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'component:default/billing-api',
        '',
        '  kind         Component',
        '  type         service',
        '  owner        group:default/tiger',
        '  environment  prod',
        '',
        'provides',
        '  api:default/billing',
        '  api:default/ghost    declared nowhere',
        '',
        'depends on',
        '  none',
        '',
        'used by',
        '  none',
        '',
      ].join('\n'),
    )
  })

  it('prints no provides section for a component that provides nothing', async () => {
    const { out } = await run(['show', 'orders-api', '--repo', GOLDEN])
    expect(out).not.toContain('provides')
    expect(out).toContain('\ndepends on\n  resource:default/orders-api-to-payments  prod\n')
  })

  it('resolves a bare name an API holds alone', async () => {
    const { code, out } = await run(['show', 'billing', '--repo', GOLDEN])
    expect(code).toBe(0)
    expect(out.startsWith('api:default/billing\n')).toBe(true)
  })

  it('resolves a name an API and a Resource share as it resolves any shared name: the first', async () => {
    // How `show` has always told two entities of one name apart: the first the
    // graph holds, and the reference for the other.
    const { code, out } = await run(['show', 'payments', '--repo', GOLDEN])
    expect(code).toBe(0)
    expect(out.startsWith('api:default/payments\n')).toBe(true)
    const resource = await run(['show', 'resource:default/payments', '--repo', GOLDEN])
    expect(resource.code).toBe(0)
    expect(resource.out.startsWith('resource:default/payments\n')).toBe(true)
  })

  it('says who provides an entity of another kind a providesApis names, at both ends', () => {
    // Backstage keeps an explicit kind as written; the relation is then shown
    // on the card of what it names too, and not only on the component's.
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
        '  providesApis: [resource:payments]',
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: payments',
        'spec:',
        '  type: api',
        '  owner: tiger',
        '',
      ].join('\n'),
    )
    const graph = EntityGraph.from([...entities, ...apis])
    const card = (ref: string): string => renderEntityDetail(graph, graph.get(ref)!)
    expect(card('component:default/one')).toContain('\nprovides\n  resource:default/payments  (undeclared)\n')
    expect(card('resource:default/payments')).toContain('\nprovided by\n  component:default/one\n')
    // And a card nothing provides reads as it did.
    expect(card('component:default/one')).not.toContain('provided by')
  })
})

describe('the overview', () => {
  const golden = async () => {
    const loaded = await new FixtureProvider(GOLDEN).load()
    const graph = EntityGraph.from(
      loaded.entities,
      loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
    )
    return renderOverview(
      overviewOf(graph, { ignored: loaded.ignored, rejected: loaded.rejected.length }),
      { repo: 'backstage-apis' },
    )
  }

  it('counts the APIs, and how many a service provides', async () => {
    const text = await golden()
    expect(text).toContain('\n\nkinds\n  API        2\n  Component  2\n  Resource   2\n\n')
    expect(text).toContain('\n\napis  2\n  provided by a service  1\n  provided by none       1\n\n')
  })

  it('counts an API among what the rights reach', async () => {
    expect(await golden()).toContain(
      '\n\nmost reached\n  api:default/payments  1 service, 1 right\n\n',
    )
  })

  it('says nothing of APIs where there are none', async () => {
    const loaded = await new FixtureProvider(DEMO).load()
    const text = renderOverview(
      overviewOf(EntityGraph.from(loaded.entities), { ignored: [], rejected: 0 }),
      {},
    )
    expect(text).toBe(await before('overview.txt'))
    expect(text).not.toMatch(/^apis/m)
  })
})

describe('the summary the agents are shown', () => {
  it('lists API among the kinds the graph holds', async () => {
    const loaded = await new FixtureProvider(GOLDEN).load()
    const { summary, vocabulary } = summariseGraph(EntityGraph.from(loaded.entities))
    expect(vocabulary.kinds).toEqual(['API', 'Component', 'Resource'])
    expect(formatSummary(summary, vocabulary)).toContain('  kinds: API, Component, Resource\n')
  })

  it('is byte for byte what it was over the demo SI', async () => {
    const loaded = await new FixtureProvider(DEMO).load()
    const { summary, vocabulary } = summariseGraph(EntityGraph.from(loaded.entities))
    expect(formatSummary(summary, vocabulary)).toBe(await before('summary.txt'))
  })
})

describe('the demo SI, which declares no API', () => {
  it.each([
    ['graph.txt', ['graph', '--demo']],
    ['graph-component.txt', ['graph', '--kind', 'Component', '--demo']],
    ['graph-resource.txt', ['graph', '--kind', 'Resource', '--demo']],
    ['show-billing-api.txt', ['show', 'billing-api', '--demo']],
    ['show-inpi-api.txt', ['show', 'inpi-api', '--demo']],
    ['show-billing-db-prod.txt', ['show', 'billing-db-prod', '--demo']],
    ['show-billing.txt', ['show', 'billing', '--demo']],
  ])('prints %s byte for byte as before', async (file, argv) => {
    const { out } = await run(argv)
    expect(out).toBe(await before(file))
  })
})
