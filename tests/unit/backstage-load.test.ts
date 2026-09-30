import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  accountHolds,
  admitted,
  judgedOf,
  loadCatalogue,
  readShapeOf,
  type Served,
} from '../../src/context/backstage/load.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from '../../src/context/backstage/limits.js'
import { BackstageProvider } from '../../src/context/backstage/provider.js'
import {
  CatalogueReadError,
  catalogueTransport,
  type CatalogueFailure,
  type CatalogueFetch,
} from '../../src/context/backstage/transport.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults } from '../support/fake-backstage.js'

/**
 * The load (docs/backstage-http-brief.md § 6): the facet call, the
 * kind-split reads, the cursor, and every check that keeps a partial read
 * from being answered from. Each failure is a `CatalogueFailure`, and no
 * `Served` comes back with it. Every catalogue here is the fake's, paging as
 * Backstage pages (docs/plans/backstage-http-slice-1.md, row 22).
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const BASE = new URL('https://backstage.canary.example/api/catalog')
const ORIGIN = 'https://backstage.canary.example'
const TOKEN = 'canary-backstage-token-0123456789'
const REFS = 'kind,metadata.namespace,metadata.name,metadata.uid'
const ORGANISATION_FIELDS =
  'apiVersion,kind,metadata.name,metadata.namespace,metadata.uid,' +
  'spec.type,spec.parent,spec.children,spec.members,spec.memberOf,spec.owner,spec.domain,spec.subdomainOf'

type Item = Record<string, unknown>

const demo = catalogueOf(DEMO)

/** Group names: `count` of them, made up here. */
const teams = (count: number): string[] => Array.from({ length: count }, (_, at) => `team-${String(at).padStart(4, '0')}`)

/** The demo SI with Groups: the demo's three, or `count` of them for a read of several pages. */
const demoWithGroups = (count?: number): Item[] =>
  catalogueOf(DEMO, { groups: count === undefined ? ['tiger', 'elephant', 'dodowarriors'] : teams(count) })

/** `count` Locations, as a catalogue serves one: a kind read as refs, since the organisation is read whole. */
const locations = (count: number): Item[] =>
  Array.from({ length: count }, (_, at) => ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Location',
    metadata: {
      name: `location-${String(at).padStart(4, '0')}`,
      namespace: 'default',
      uid: `10000000-0000-4000-8000-${String(at).padStart(12, '0')}`,
    },
    spec: { type: 'url', target: `https://github.com/acme/repo-${String(at)}/blob/main/catalog-info.yaml` },
  }))

/** The demo SI with Locations: three, or `count` of them for a refs read of several pages. */
const demoWithLocations = (count = 3): Item[] => [...demo, ...locations(count)]

/** A User as a catalogue serves one. */
const user = (name: string, memberOf: readonly string[]): Item => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'User',
  metadata: { name, namespace: 'default', uid: `20000000-0000-4000-8000-${name.padStart(12, '0')}` },
  spec: { memberOf },
})

/** The demo SI with `count` more Resources: a modelled read of several pages. */
const demoWithResources = (count: number): Item[] => {
  const [template] = demo.filter((item) => item['kind'] === 'Resource')
  const extra = Array.from({ length: count }, (_, at) => {
    const item = structuredClone(template!)
    const metadata = item['metadata'] as Item
    metadata['name'] = `extra-db-${String(at).padStart(4, '0')}`
    metadata['uid'] = `e0000000-0000-4000-8000-${String(at).padStart(12, '0')}`
    return item
  })
  return [...demo, ...extra]
}

const transportOf = (fetch: CatalogueFetch, limits: Partial<BackstageLimits> = {}) =>
  catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch, limits })

/** The route and query of a request, as it follows the base. */
const routeAndQuery = (url: string): string => url.slice(BASE.href.length + 1)

/** The error a load ended on; the test fails if it returned anything. */
const errorOf = async (loading: Promise<unknown>): Promise<CatalogueReadError> => {
  const thrown = await loading.then(
    (served) => {
      throw new Error(`the load returned ${JSON.stringify(served).slice(0, 200)}`)
    },
    (error: unknown) => error,
  )
  expect(thrown).toBeInstanceOf(CatalogueReadError)
  return thrown as CatalogueReadError
}

/** The failure a load ended on. */
const failureOf = async (loading: Promise<unknown>): Promise<CatalogueFailure> => (await errorOf(loading)).failure

const loaded = (entities: readonly Item[], faults: Faults = {}, limits: Partial<BackstageLimits> = {}) => {
  const fake = fakeBackstage({ entities, token: TOKEN, faults })
  return { ...fake, loading: loadCatalogue(transportOf(fake.fetch, limits), limits) }
}

describe('loadCatalogue', () => {
  it('asks the facets once, then reads Components, Resources and APIs whole, the organisation for what the read model reads, and every other kind as refs', async () => {
    const { fetch, sent } = fakeBackstage({
      entities: [...demoWithGroups(), user('ada', ['tiger']), ...locations(2)],
      token: TOKEN,
    })
    const served = await loadCatalogue(transportOf(fetch))
    expect(sent.map(({ url }) => routeAndQuery(url))).toEqual([
      'entity-facets?facet=kind',
      'entities/by-query?filter=kind%3Dcomponent&filter=kind%3Dresource&filter=kind%3Dapi&limit=250',
      `entities/by-query?filter=kind%3Dgroup&filter=kind%3Duser&fields=${encodeURIComponent(ORGANISATION_FIELDS)}&limit=250`,
      'entities/by-query?filter=kind%3Dlocation&fields=kind%2Cmetadata.namespace%2Cmetadata.name%2Cmetadata.uid&limit=250',
    ])
    expect(served.whole).toHaveLength(33)
    expect(served.organisation).toHaveLength(4)
    expect(served.organisation).toContainEqual({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Group',
      metadata: { name: 'tiger', namespace: 'default', uid: expect.any(String) },
      spec: { type: 'team', children: [] },
    })
    expect(served.judged).toEqual(['Group', 'User'])
    expect(served.refs).toHaveLength(2)
    expect(served.refs[0]).toEqual({ kind: 'Location', metadata: { namespace: 'default', name: expect.any(String), uid: expect.any(String) } })
    expect(served.census).toMatchObject({ served: 39, pages: 3, repeated: 0 })
    expect(served.census.bytes).toBeGreaterThan(0)
  })

  it('sends no refs read when the facets name no other kind', async () => {
    const { fetch, sent } = fakeBackstage({ entities: demo, token: TOKEN })
    await loadCatalogue(transportOf(fetch))
    expect(sent).toHaveLength(2)
  })

  it('sends no organisation read when the facets name none of the four: the requests of today, and judged empty', async () => {
    const { fetch, sent } = fakeBackstage({ entities: demoWithLocations(), token: TOKEN })
    const served = await loadCatalogue(transportOf(fetch))
    expect(sent.map(({ url }) => routeAndQuery(url))).toEqual([
      'entity-facets?facet=kind',
      'entities/by-query?filter=kind%3Dcomponent&filter=kind%3Dresource&filter=kind%3Dapi&limit=250',
      'entities/by-query?filter=kind%3Dlocation&fields=kind%2Cmetadata.namespace%2Cmetadata.name%2Cmetadata.uid&limit=250',
    ])
    expect(served.organisation).toEqual([])
    expect(served.judged).toEqual([])
  })

  it('judges the kinds the facets named: a catalogue serving Groups and no Users judges Group alone', async () => {
    const { fetch } = fakeBackstage({ entities: demoWithGroups(), token: TOKEN })
    expect((await loadCatalogue(transportOf(fetch))).judged).toEqual(['Group'])
  })

  it('sends each next page of the organisation read its cursor, limit=250 and the same fields; never filter', async () => {
    const { fetch, sent } = fakeBackstage({ entities: demoWithGroups(600), token: TOKEN }) // 600 Groups: three pages
    const served = await loadCatalogue(transportOf(fetch))
    const next = sent.map(({ url }) => new URL(url)).filter((url) => url.searchParams.has('cursor'))
    expect(next).toHaveLength(2)
    for (const url of next) {
      expect(url.searchParams.getAll('filter')).toEqual([])
      expect(url.searchParams.get('limit')).toBe('250')
      expect(url.searchParams.get('fields')).toBe(ORGANISATION_FIELDS)
    }
    expect(served.organisation).toHaveLength(600)
    expect(served.refs).toEqual([])
  })

  it('sends each next page its cursor, limit=250 and, for the refs read, the same fields; never filter', async () => {
    // Backstage's cursor carries the filter, the order and totalItems, not limit or fields
    // (parseQueryEntitiesParams.ts, createRouter.ts); CatalogClient.queryEntities re-sends both.
    const { fetch, sent } = fakeBackstage({ entities: demoWithLocations(600), token: TOKEN }) // 600 Locations: three pages of refs
    const served = await loadCatalogue(transportOf(fetch))
    const refsPages = sent
      .map(({ url }) => new URL(url))
      .filter((url) => url.searchParams.getAll('filter').includes('kind=location') || url.searchParams.has('cursor'))
    const next = refsPages.filter((url) => url.searchParams.has('cursor'))
    expect(next).toHaveLength(2)
    for (const url of next) {
      expect(url.searchParams.getAll('filter')).toEqual([])
      expect(url.searchParams.get('limit')).toBe('250')
      expect(url.searchParams.get('fields')).toBe(REFS)
    }
    expect(served.refs).toHaveLength(600)
    // Projected on every page: a next page sent without fields would come back whole.
    expect(served.refs.every((item) => !('spec' in (item as Item)))).toBe(true)
  })

  it('sends the modelled read’s next pages no fields: it is read whole', async () => {
    const { fetch, sent } = fakeBackstage({ entities: demoWithResources(300), token: TOKEN })
    const served = await loadCatalogue(transportOf(fetch))
    const next = sent.map(({ url }) => new URL(url)).filter((url) => url.searchParams.has('cursor'))
    expect(next).toHaveLength(1)
    expect([...next[0]!.searchParams.keys()].sort()).toEqual(['cursor', 'limit'])
    expect(served.whole).toHaveLength(333)
  })

  it('sends a nextCursor that is a URL on another origin only as the value of cursor, to the base', async () => {
    const foreign = 'https://evil.example/api/catalog/entities/by-query?x=1'
    const { fetch, sent } = fakeBackstage({ entities: demo, token: TOKEN, faults: { nextCursor: foreign } })
    const failure = await failureOf(loadCatalogue(transportOf(fetch))) // the cursor loop refuses the second sight
    expect(failure).toEqual({ kind: 'same-page' })
    const second = new URL(sent.find(({ url }) => new URL(url).searchParams.has('cursor'))!.url)
    expect(`${second.origin}${second.pathname}`).toBe('https://backstage.canary.example/api/catalog/entities/by-query')
    expect(second.searchParams.get('cursor')).toBe(foreign)
    expect(sent.every(({ url }) => new URL(url).origin === ORIGIN)).toBe(true)
  })

  it('sends the modelled read even when the facets name no Component, Resource or API', async () => {
    const { fetch, sent } = fakeBackstage({
      entities: demoWithLocations(),
      token: TOKEN,
      faults: { facetsOmit: ['Component', 'Resource'] },
    })
    const served = await loadCatalogue(transportOf(fetch))
    expect(sent.map(({ url }) => routeAndQuery(url))[1]).toBe(
      'entities/by-query?filter=kind%3Dcomponent&filter=kind%3Dresource&filter=kind%3Dapi&limit=250',
    )
    expect(served.whole).toHaveLength(33)
  })

  it('refuses a kind the facets name that the kind grammar refuses: filters are never built from other text', async () => {
    const odd: Item = { ...structuredClone(demo[0]!), kind: 'Group,kind=user' }
    ;(odd['metadata'] as Item)['uid'] = 'f0000000-0000-4000-8000-0000000000aa'
    const { fetch, sent } = fakeBackstage({ entities: [...demo, odd], token: TOKEN })
    expect(await failureOf(loadCatalogue(transportOf(fetch)))).toEqual({ kind: 'facets-kind' })
    expect(sent).toHaveLength(1)
  })

  it('refuses the same page twice: "the catalogue returned the same page twice"', async () => {
    const { loading } = loaded(demoWithLocations(600), { sameCursorTwice: true })
    const failure = await failureOf(loading)
    expect(failure).toEqual({ kind: 'same-page' })
    expect(new CatalogueReadError(failure, ORIGIN).message).toBe(
      'the catalogue at https://backstage.canary.example returned the same page twice',
    )
  })

  it('keeps a uid seen on two pages once, and counts it in census.repeated, when the read is still whole', async () => {
    const { loading } = loaded(demoWithLocations(600), { repeatUid: { leaveOut: false } })
    const served = await loading
    expect(served.refs).toHaveLength(600)
    expect(served.census).toMatchObject({ served: 633, repeated: 1 })
  })

  it('refuses fewer distinct uids than totalItems announced, with no uid repeated', async () => {
    const { loading } = loaded(demo, { totalItemsAbove: 1 })
    const failure = await failureOf(loading)
    expect(failure).toEqual({ kind: 'changed', expected: 34, read: 33 })
    expect(new CatalogueReadError(failure, ORIGIN).message).toBe(
      'the catalogue at https://backstage.canary.example changed while it was read (34 expected, 33 read)',
    )
  })

  it('refuses one uid served twice and another left out: fewer distinct than announced, repeats or not', async () => {
    const { loading } = loaded(demoWithLocations(600), { repeatUid: { leaveOut: true } })
    expect(await failureOf(loading)).toEqual({ kind: 'changed', expected: 600, read: 599 })
  })

  it('refuses an item of a kind its read did not ask for: a Component in the refs read, a Location in the modelled one', async () => {
    // A server that ignores filter does not page as Backstage does: a whole
    // entity smuggled into the refs read would pass the modelled ceiling.
    const smuggled = structuredClone(demo.find((item) => item['kind'] === 'Component')!)
    ;(smuggled['metadata'] as Item)['name'] = 'smuggled'
    ;(smuggled['metadata'] as Item)['uid'] = 'f0000000-0000-4000-8000-0000000000bb'
    const inRefs = loaded(demoWithLocations(), { extraItem: { at: 2, item: smuggled } })
    const failure = await failureOf(inRefs.loading)
    expect(failure).toEqual({ kind: 'unasked-kind', scope: 'refs' })
    expect(new CatalogueReadError(failure, ORIGIN).message).toBe(
      'the catalogue at https://backstage.canary.example served an entity of a kind the read did not ask for, ' +
        'so it does not filter as Backstage does',
    )
    const location: Item = { kind: 'Location', metadata: { namespace: 'default', name: 'tiger', uid: 'f0000000-0000-4000-8000-0000000000cc' } }
    expect(await failureOf(loaded(demoWithLocations(), { extraItem: { at: 1, item: location } }).loading)).toEqual({
      kind: 'unasked-kind',
      scope: 'modelled',
    })
    // And a Location in the organisation read, which asked for Groups.
    expect(await failureOf(loaded(demoWithGroups(), { extraItem: { at: 2, item: location } }).loading)).toEqual({
      kind: 'unasked-kind',
      scope: 'organisation',
    })
    const noKind: Item = { metadata: { namespace: 'default', name: 'nothing', uid: 'f0000000-0000-4000-8000-0000000000dd' } }
    expect(await failureOf(loaded(demo, { extraItem: { at: 1, item: noKind } }).loading)).toEqual({
      kind: 'unasked-kind',
      scope: 'modelled',
    })
  })

  it('keeps a uid served in both reads once, counts it in census.repeated, and counts it once in census.served', async () => {
    const billing = demo.find((item) => (item['metadata'] as Item)['name'] === 'billing-api')!
    const uid = (billing['metadata'] as Item)['uid']
    const twin: Item = { kind: 'Location', metadata: { namespace: 'default', name: 'billing-team', uid } }
    const served = await loaded(demoWithLocations(), { extraItem: { at: 2, item: twin } }).loading
    expect(served.whole).toHaveLength(33)
    expect(served.refs).toHaveLength(3)
    expect(served.census).toMatchObject({ served: 36, repeated: 1 })
  })

  it('names the base’s origin in the error it throws: scheme, host and port, never the path', async () => {
    // The message comes from transport.origin, not from this file's constant.
    const base = new URL('https://backstage.canary.example:8443/api/catalog')
    const { fetch } = fakeBackstage({ entities: demo, token: TOKEN, faults: { sameCursorTwice: true } })
    const transport = catalogueTransport({ base, token: TOKEN, catalogueFetch: fetch })
    expect(transport.origin).toBe('https://backstage.canary.example:8443')
    const error = await errorOf(loadCatalogue(transport, { pageSize: 10 }))
    expect(error.message).toBe('the catalogue at https://backstage.canary.example:8443 returned the same page twice')
  })

  it('refuses an item with no string metadata.uid', async () => {
    const { loading } = loaded(demo, { noUid: true })
    const error = await errorOf(loading)
    expect(error.failure).toEqual({ kind: 'no-uid' })
    expect(error.message).toBe(
      'the catalogue at https://backstage.canary.example served an entity with no metadata.uid, so the read cannot be proved whole',
    )
  })

  it('reads the modelled kinds up to their ceiling and says how far it got, the other reads still sent', async () => {
    const { loading, sent } = loaded(demoWithLocations(), {}, { modelledEntities: 32 })
    const served = await loading
    expect(served.whole).toHaveLength(32)
    expect(served.bounded).toEqual([{ scope: 'modelled', kinds: ['component', 'resource', 'api'], read: 32, total: 33, limit: 32 }])
    expect(sent.map(({ url }) => new URL(url).searchParams.getAll('filter'))).toContainEqual(['kind=location'])
    expect(served.refs).toHaveLength(3)
    // Counted as kept: the item past the bound was served, and is not read.
    expect(served.census.served).toBe(35)
  })

  it('asks for no page after the one that reaches the ceiling, and keeps that page up to it', async () => {
    // 333 announced, 250 on the first page: the second reaches 300, and no third is asked for.
    const { loading, sent } = loaded(demoWithResources(300), {}, { modelledEntities: 300 })
    const served = await loading
    expect(served.whole).toHaveLength(300)
    expect(served.bounded[0]).toMatchObject({ read: 300, total: 333 })
    expect(sent.filter(({ url }) => url.includes('entities/by-query'))).toHaveLength(2)
  })

  it('stops at the end of a page that reaches the ceiling when totalItems says there is more', async () => {
    const { loading, sent } = loaded(demoWithResources(300), {}, { modelledEntities: 250 })
    const served = await loading
    expect(served.whole).toHaveLength(250)
    expect(served.bounded).toEqual([{ scope: 'modelled', kinds: ['component', 'resource', 'api'], read: 250, total: 333, limit: 250 }])
    expect(sent.filter(({ url }) => url.includes('entities/by-query'))).toHaveLength(1)
  })

  it('stops as items arrive past the ceiling whatever totalItems says, and calls the total unknown', async () => {
    const served = await loaded(demo, { totalItemsAbove: -30 }, { modelledEntities: 32 }).loading
    expect(served.whole).toHaveLength(32)
    expect(served.bounded[0]).toMatchObject({ read: 32, total: undefined })
  })

  it('judges no organisation kind when the organisation read stopped at its ceiling', async () => {
    const served = await loaded([...demoWithGroups(), ...locations(3)], {}, { organisationEntities: 2 }).loading
    expect(served.judged).toEqual([])
    expect(served.organisation).toHaveLength(2)
    expect(served.bounded).toEqual([{ scope: 'organisation', kinds: ['group'], read: 2, total: 3, limit: 2 }])
    // The refs read is still sent, and read whole.
    expect(served.refs).toHaveLength(3)
  })

  it('reads the refs up to their ceiling', async () => {
    const served = await loaded(demoWithLocations(), {}, { otherRefs: 2 }).loading
    expect(served.whole).toHaveLength(33)
    expect(served.refs).toHaveLength(2)
    expect(served.bounded).toEqual([{ scope: 'refs', kinds: ['location'], read: 2, total: 3, limit: 2 }])
  })

  it('still refuses fewer uids than announced on a read that did not reach its ceiling', async () => {
    const { loading } = loaded(demo, { totalItemsAbove: 1 }, { modelledEntities: 40 })
    expect(await failureOf(loading)).toEqual({ kind: 'changed', expected: 34, read: 33 })
  })

  it('is whole, bounded: [], judged as before, on every catalogue under its ceilings', async () => {
    // A ceiling met exactly is no bound passed: 33 of 33 is whole.
    const exact = await loaded(demoWithLocations(), {}, { modelledEntities: 33, otherRefs: 3 }).loading
    expect(exact.bounded).toEqual([])
    expect(exact.whole).toHaveLength(33)
    const organised = await loaded([...demoWithGroups(), user('ada', ['tiger'])], {}, { organisationEntities: 4 }).loading
    expect(organised.bounded).toEqual([])
    expect(organised.judged).toEqual(['Group', 'User'])
  })

  it('refuses a page that is not the envelope { items, totalItems, pageInfo }', async () => {
    expect(await failureOf(loaded(demo, { notEnvelope: { at: 1 } }).loading)).toEqual({
      kind: 'not-envelope',
      route: 'entities/by-query',
    })
    expect(await failureOf(loaded(demo, { notEnvelope: { at: 0 } }).loading)).toEqual({
      kind: 'not-envelope',
      route: 'entity-facets',
    })
    expect(new CatalogueReadError({ kind: 'not-envelope', route: 'entities/by-query' }, ORIGIN).message).toBe(
      'the catalogue at https://backstage.canary.example answered entities/by-query with a body that is not what the route serves',
    )
  })

  it('refuses a load past 120 s', async () => {
    // limits.loadMs lowered; the request's own bound, 15 s, is not what ends it.
    const { fetch } = fakeBackstage({ entities: demo, token: TOKEN, faults: { hang: { at: 1 } } })
    const loading = new BackstageProvider({ base: BASE, token: TOKEN, catalogueFetch: fetch, limits: { loadMs: 50 } }).load()
    expect(await failureOf(loading)).toEqual({ kind: 'timeout', scope: 'load', limit: 50 })
  })
})

/**
 * The checks a page meets, as functions a kept copy meets too (plan 2.2): an
 * item is admitted by one rule wherever it came from, and what a copy states
 * of its own reads is held to what a live load could have derived.
 */
describe('one check for a page and a copy', () => {
  const component = (uid: string): Item => ({ kind: 'Component', metadata: { name: `c-${uid}`, uid } })
  const MODELLED_READ = { asked: new Set(['component', 'resource', 'api']), ceiling: 3, scope: 'modelled' as const }

  it('admits items of an asked kind with a uid, each uid once, counting the one kept already', () => {
    const kept = new Set(['b'])
    const seen = new Set<string>()
    const result = admitted([component('a'), component('b'), component('a')], MODELLED_READ, seen, kept)
    expect(result).toEqual({ items: [component('a')], repeated: 2, stopped: false })
    expect([...seen]).toEqual(['a', 'b'])
    expect([...kept].sort()).toEqual(['a', 'b'])
  })

  it('refuses an item with no string uid, and one of a kind its read did not ask for', () => {
    expect(admitted([{ kind: 'Component', metadata: {} }], MODELLED_READ, new Set(), new Set())).toEqual({
      refused: { kind: 'no-uid' },
    })
    expect(
      admitted([{ kind: 'Location', metadata: { uid: 'x' } }], MODELLED_READ, new Set(), new Set()),
    ).toEqual({ refused: { kind: 'unasked-kind', scope: 'modelled' } })
  })

  it('stops at the ceiling, as the read does: the item that would pass it and the rest are left out', () => {
    const seen = new Set<string>()
    const result = admitted(['a', 'b', 'c', 'd', 'e'].map(component), MODELLED_READ, seen, new Set())
    expect(result).toEqual({ items: ['a', 'b', 'c'].map(component), repeated: 0, stopped: true })
    expect(seen.size).toBe(3)
  })

  it.each([
    ['Groups and Users', [...demoWithGroups(), user('ada', ['tiger'])], {}],
    ['no organisation', demoWithLocations(), {}],
    ['Groups alone', demoWithGroups(), {}],
    ['a bounded organisation read', [...demoWithGroups(), ...locations(3)], { organisationEntities: 2 }],
    ['an organisation read met exactly', [...demoWithGroups(), user('ada', ['tiger'])], { organisationEntities: 4 }],
  ] as const)('judges what the load judges: %s', async (_, entities, limits) => {
    const served = await loaded(entities, {}, limits).loading
    expect(judgedOf(served.asked.organisation, served.bounded)).toEqual(served.judged)
  })

  it('says what the organisation and refs reads asked for, lower case, and when the load began', async () => {
    const before = Date.now()
    const served = await loaded([...demoWithGroups(), user('ada', ['tiger']), ...locations(2)]).loading
    expect(served.asked).toEqual({ organisation: ['group', 'user'], refs: ['location'] })
    expect(served.startedAt).toBeGreaterThanOrEqual(before)
    expect(served.startedAt).toBeLessThanOrEqual(Date.now())
    expect((await loaded(demo).loading).asked).toEqual({ organisation: [], refs: [] })
  })

  describe('accountHolds: what a copy states of its reads, held to what a live load could give', () => {
    const asked: Served['asked'] = { organisation: ['group', 'user'], refs: ['location', 'template'] }
    const bound = (scope: 'modelled' | 'organisation' | 'refs', kinds: readonly string[], limit: number) => ({
      scope,
      kinds,
      read: limit,
      total: limit + 10,
      limit,
    })
    const modelled = bound('modelled', ['component', 'resource', 'api'], BACKSTAGE_LIMITS.modelledEntities)
    const organisation = bound('organisation', ['group', 'user'], BACKSTAGE_LIMITS.organisationEntities)
    const refs = bound('refs', ['location', 'template'], BACKSTAGE_LIMITS.otherRefs)

    it('holds what a live load gives: none bounded, or each read bounded once at its ceiling', () => {
      expect(accountHolds(asked, [], BACKSTAGE_LIMITS)).toBe(true)
      expect(accountHolds(asked, [modelled, organisation, refs], BACKSTAGE_LIMITS)).toBe(true)
      expect(accountHolds(asked, [{ ...modelled, total: undefined }], BACKSTAGE_LIMITS)).toBe(true)
      expect(accountHolds({ organisation: [], refs: [] }, [], BACKSTAGE_LIMITS)).toBe(true)
      const lowered = { ...BACKSTAGE_LIMITS, modelledEntities: 40 }
      expect(accountHolds(asked, [bound('modelled', ['component', 'resource', 'api'], 40)], lowered)).toBe(true)
    })

    it.each([
      ['an organisation kind out of order', { ...asked, organisation: ['user', 'group'] }, []],
      ['an organisation kind twice', { ...asked, organisation: ['group', 'group'] }, []],
      ['a kind that is not the organisation’s', { ...asked, organisation: ['template'] }, []],
      ['refs unsorted', { ...asked, refs: ['template', 'location'] }, []],
      ['a refs kind the grammar refuses', { ...asked, refs: ['loc=ation'] }, []],
      ['a refs kind in upper case', { ...asked, refs: ['Location'] }, []],
      ['a modelled kind among the refs', { ...asked, refs: ['component', 'location'] }, []],
      ['an organisation kind among the refs', { ...asked, refs: ['group', 'location'] }, []],
      ['two bounded entries of one scope', asked, [modelled, modelled]],
      ['a bound other than the ceiling', asked, [{ ...organisation, limit: 5, read: 5 }]],
      ['a read other than the bound', asked, [{ ...modelled, read: modelled.limit - 1 }]],
      ['a total at the bound', asked, [{ ...modelled, total: modelled.limit }]],
      ['a total under it', asked, [{ ...modelled, total: 3 }]],
      ['kinds other than its read asked', asked, [{ ...refs, kinds: ['location'] }]],
      ['a bounded read that was never asked', { ...asked, refs: [] }, [refs]],
      ['bounded reads out of the order they are sent', asked, [refs, modelled]],
    ] as const)('refuses %s', (_, stated, bounded) => {
      expect(accountHolds(stated as Served['asked'], bounded, BACKSTAGE_LIMITS)).toBe(false)
    })
  })

  it('states the read shape: both field lists, the three ceilings and the two byte bounds, each moving it', () => {
    const shape = readShapeOf(BACKSTAGE_LIMITS)
    expect(shape).toContain(ORGANISATION_FIELDS)
    expect(shape).toContain(REFS)
    for (const bound of ['modelledEntities', 'organisationEntities', 'otherRefs', 'bytesPerResponse', 'bytesPerRun'] as const) {
      expect(readShapeOf({ ...BACKSTAGE_LIMITS, [bound]: BACKSTAGE_LIMITS[bound] - 1 })).not.toBe(shape)
    }
    expect(readShapeOf({ ...BACKSTAGE_LIMITS, modelledEntities: 40 })).not.toBe(shape)
    // A bound that changes nothing a copy holds does not move it.
    expect(readShapeOf({ ...BACKSTAGE_LIMITS, requestMs: 1 })).toBe(shape)
  })
})
