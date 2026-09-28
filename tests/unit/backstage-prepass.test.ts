import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackstageProvider } from '../../src/context/backstage/provider.js'
import { prePass } from '../../src/context/backstage/translate.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import type { LoadResult } from '../../src/context/provider.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * The catalogue pre-pass (docs/backstage-http-brief.md § 5), one test per
 * row of its table: what Backstage adds is removed before the reader, and
 * what it accepted and this tool does not model is set aside and said,
 * never refused and never read as something else.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const BASE = new URL('https://backstage.canary.example/api/catalog')
const TOKEN = 'canary-backstage-token-0123456789'

type Item = Record<string, unknown>

/** The demo SI as a catalogue serves it, changed by `change`. */
const demoWith = (change: (items: Item[]) => Item[]): Item[] => change(structuredClone(catalogueOf(DEMO)))

const metadataOf = (item: Item): Item => item['metadata'] as Item
const specOf = (item: Item): Item => item['spec'] as Item
const refOfItem = (item: Item): string =>
  `${String(item['kind'])}:${String(metadataOf(item)['namespace'])}/${String(metadataOf(item)['name'])}`.toLowerCase()

/** `items` with one more relation on the item `ref`: an edge Backstage derived and no spec declares. */
const addRelation = (items: Item[], ref: string, type: string, targetRef: string): Item[] =>
  items.map((item) =>
    refOfItem(item) === ref ? { ...item, relations: [...(item['relations'] as Item[]), { type, targetRef }] } : item,
  )

/** A served item like `template` under another uid, changed by `change`. */
const another = (template: Item, uid: string, change: (item: Item) => void): Item => {
  const item = structuredClone(template)
  metadataOf(item)['uid'] = uid
  change(item)
  return item
}

const find = (items: readonly Item[], name: string): Item => items.find((item) => metadataOf(item)['name'] === name)!

const provider = (entities: readonly Item[]): BackstageProvider =>
  new BackstageProvider({ base: BASE, token: TOKEN, catalogueFetch: fakeBackstage({ entities, token: TOKEN }).fetch })

const graphOf = (result: LoadResult): EntityGraph =>
  EntityGraph.from(
    result.entities,
    result.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
  )

describe('the catalogue pre-pass', () => {
  it('drops relations and status, so a relation naming what no spec names creates no edge', async () => {
    const served = demoWith((items) =>
      addRelation(items, 'component:default/billing-api', 'dependsOn', 'resource:default/ghost').map((item) => ({
        ...item,
        status: { items: [{ type: 'backstage.io/catalog-processing', level: 'error', message: 'x' }] },
      })),
    )
    const result = await provider(served).load()
    const graph = graphOf(result)
    expect(graph.dependenciesOf('component:default/billing-api').map(refOf)).not.toContain('resource:default/ghost')
    expect(graph.danglingReferences()).toEqual([])
    expect(result.unread.filter((field) => field === 'relations' || field === 'status')).toEqual([])
  })

  it('keeps uid and etag out of the entity, so the not read: line is the file road’s', async () => {
    const files = await new FixtureProvider(DEMO).load()
    const result = await provider(catalogueOf(DEMO)).load()
    expect(result.unread).toEqual(files.unread)
    expect(result.unread.filter((field) => /^metadata\.(uid|etag)$/.test(field))).toEqual([])
    // And the uid is still what the pre-pass hands back, beside the value.
    const [item] = catalogueOf(DEMO)
    const passed = prePass(item)
    expect('value' in passed && passed.uid).toBe(metadataOf(item!)['uid'])
    expect('value' in passed && metadataOf(passed.value)).not.toHaveProperty('uid')
    expect('value' in passed && metadataOf(passed.value)).not.toHaveProperty('etag')
  })

  it('sets a Component of namespace payments aside, and it does not replace component:default/billing-api', async () => {
    const served = demoWith((items) => [
      ...items,
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000001', (item) => {
        metadataOf(item)['namespace'] = 'payments'
        specOf(item)['owner'] = 'group:payments/lion'
      }),
    ])
    const result = await provider(served).load()
    expect(result.ignored).toEqual([
      expect.objectContaining({
        kind: 'Component',
        ref: 'component:payments/billing-api',
        reason: 'namespace payments is not modelled by this tool',
        prePass: { rule: 'namespace', value: 'payments' },
      }),
    ])
    const billing = result.entities.filter((entity) => entity.metadata.name === 'billing-api')
    expect(billing).toHaveLength(1)
    expect(billing[0]!.spec.owner).toBe('group:default/tiger')
  })

  it('sets aside a namespace that is default only without case, or is not text: neither shadows its default namesake', async () => {
    // A real Backstage validates a namespace as lower-case text; only another server serves these.
    const served = demoWith((items) => [
      ...items,
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000011', (item) => {
        metadataOf(item)['namespace'] = 'DEFAULT'
        specOf(item)['owner'] = 'group:default/elephant'
      }),
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000012', (item) => {
        metadataOf(item)['namespace'] = ['payments']
        metadataOf(item)['name'] = 'arr-ns'
      }),
    ])
    const result = await provider(served).load()
    expect(result.ignored).toEqual([
      expect.objectContaining({
        ref: 'component:default/arr-ns',
        reason: 'a namespace that is not text is not modelled by this tool',
        prePass: { rule: 'namespace', value: '["payments"]' },
      }),
      expect.objectContaining({
        ref: 'component:default/billing-api',
        reason: 'namespace DEFAULT is not modelled by this tool',
        prePass: { rule: 'namespace', value: 'DEFAULT' },
      }),
    ])
    expect(result.entities.map(refOf).filter((ref) => ref === 'component:default/arr-ns')).toEqual([])
    const billing = result.entities.filter((entity) => entity.metadata.name === 'billing-api')
    expect(billing).toHaveLength(1)
    expect(billing[0]!.spec.owner).toBe('group:default/tiger')
  })

  it('sets aside lifecycle beta, and a reference to it is not dangling', async () => {
    const served = demoWith((items) => [
      ...items,
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000002', (item) => {
        metadataOf(item)['name'] = 'checkout-web'
        specOf(item)['lifecycle'] = 'beta'
      }),
      another(find(items, 'billing-db-dev'), 'f0000000-0000-4000-8000-000000000003', (item) => {
        metadataOf(item)['name'] = 'checkout-db'
        specOf(item)['dependsOn'] = ['component:default/checkout-web']
      }),
    ])
    const result = await provider(served).load()
    expect(result.ignored).toEqual([
      expect.objectContaining({
        ref: 'component:default/checkout-web',
        reason: 'lifecycle beta is not one this tool models',
        prePass: { rule: 'lifecycle', value: 'beta' },
      }),
    ])
    expect(result.rejected).toEqual([])
    expect(graphOf(result).danglingReferences()).toEqual([])
  })

  it('sets aside a Resource type it does not model: kafka-topic', async () => {
    const served = demoWith((items) => [
      ...items,
      another(find(items, 'billing-db-dev'), 'f0000000-0000-4000-8000-000000000004', (item) => {
        metadataOf(item)['name'] = 'orders-topic'
        specOf(item)['type'] = 'kafka-topic'
      }),
    ])
    const result = await provider(served).load()
    expect(result.ignored).toEqual([
      expect.objectContaining({
        kind: 'Resource',
        ref: 'resource:default/orders-topic',
        reason: 'resource type kafka-topic is not one this tool models',
        prePass: { rule: 'resource-type', value: 'kafka-topic' },
      }),
    ])
    expect(result.rejected).toEqual([])
  })

  it('sets aside an upper-case name and a backstage.io/v1beta1 Component, with the reason', async () => {
    const served = demoWith((items) => [
      ...items,
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000005', (item) => {
        metadataOf(item)['name'] = 'Checkout-Web'
      }),
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000006', (item) => {
        metadataOf(item)['name'] = 'legacy-web'
        item['apiVersion'] = 'backstage.io/v1beta1'
      }),
    ])
    const result = await provider(served).load()
    expect(result.ignored).toEqual([
      expect.objectContaining({
        ref: 'component:default/checkout-web',
        reason: 'a name in upper case is not one this tool reads',
        prePass: { rule: 'name-case', value: 'Checkout-Web' },
      }),
      expect.objectContaining({
        ref: 'component:default/legacy-web',
        reason: 'apiVersion backstage.io/v1beta1 is not one this tool reads',
        prePass: { rule: 'api-version', value: 'backstage.io/v1beta1' },
      }),
    ])
    expect(result.rejected).toEqual([])
  })

  it('sets aside an item nested deeper than 64, or holding a __proto__ or constructor key', async () => {
    /** `{ a: { a: … } }`, `levels` mappings deep. */
    const nested = (levels: number): unknown => {
      let value: unknown = 'bottom'
      for (let level = 0; level < levels; level += 1) value = { a: value }
      return value
    }
    const served = demoWith((items) => [
      ...items,
      // The item is level 1 and its metadata level 2: 62 more make 64, which is read.
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000007', (item) => {
        metadataOf(item)['name'] = 'deep-enough'
        metadataOf(item)['extra'] = nested(62)
      }),
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000008', (item) => {
        metadataOf(item)['name'] = 'too-deep'
        metadataOf(item)['extra'] = nested(63)
      }),
      // As JSON.parse leaves them: an own key, never a prototype.
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-000000000009', (item) => {
        metadataOf(item)['name'] = 'proto-key'
        specOf(item)['extra'] = JSON.parse('{"__proto__": {"polluted": true}}')
      }),
      another(find(items, 'billing-api'), 'f0000000-0000-4000-8000-00000000000a', (item) => {
        metadataOf(item)['name'] = 'constructor-key'
        metadataOf(item)['labels'] = JSON.parse('{"constructor": "x"}')
      }),
    ])
    const result = await provider(served).load()
    expect(result.ignored.map(({ ref, prePass: rule }) => [ref, rule])).toEqual([
      ['component:default/constructor-key', { rule: 'shape', value: 'constructor' }],
      ['component:default/proto-key', { rule: 'shape', value: '__proto__' }],
      ['component:default/too-deep', { rule: 'shape', value: 'depth' }],
    ])
    expect(result.entities.map((entity) => entity.metadata.name)).toContain('deep-enough')
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('reads a dependsOn naming a custom kind read as refs only as not dangling', async () => {
    const served = demoWith((items) => [
      ...items,
      {
        apiVersion: 'acme.example/v1',
        kind: 'Topic',
        metadata: { name: 'orders-events', namespace: 'default', uid: 'f0000000-0000-4000-8000-00000000000b' },
        spec: { payload: 'x'.repeat(10) },
      },
      another(find(items, 'billing-db-dev'), 'f0000000-0000-4000-8000-00000000000c', (item) => {
        metadataOf(item)['name'] = 'orders-reader'
        specOf(item)['dependsOn'] = ['topic:default/orders-events']
      }),
    ])
    const { fetch, sent } = fakeBackstage({ entities: served, token: TOKEN })
    const result = await new BackstageProvider({ base: BASE, token: TOKEN, catalogueFetch: fetch }).load()
    // Read as refs only: the spec never crossed.
    expect(sent.some(({ url }) => new URL(url).searchParams.getAll('filter').includes('kind=topic'))).toBe(true)
    expect(result.ignored).toEqual([expect.objectContaining({ kind: 'Topic', ref: 'topic:default/orders-events' })])
    expect(result.ignored[0]).not.toHaveProperty('prePass')
    expect(graphOf(result).danglingReferences()).toEqual([])
  })
})
