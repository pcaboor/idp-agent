import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackstageProvider } from '../../src/context/backstage/provider.js'
import { CatalogueReadError, type CatalogueFetch } from '../../src/context/backstage/transport.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { refOf } from '../../src/context/graph/entity-graph.js'
import type { LoadResult } from '../../src/context/provider.js'
import type { CatalogueEntity, GraphNode } from '../../src/core/schemas/entity.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults } from '../support/fake-backstage.js'

/**
 * The proof of "the same reader" (docs/backstage-http-brief.md § 5, § 9): a
 * repository served by a catalogue reads as its files read. The fake adds
 * what Backstage adds — a namespace, a uid, an etag, relations, the two
 * locations — and the provider takes it all back off before the file
 * reader's own `readValue` sees the item.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const GOLDEN = path.resolve(import.meta.dirname, '../golden')
const BASE = new URL('https://backstage.canary.example/api/catalog')
const TOKEN = 'canary-backstage-token-0123456789'
const MANAGED_BY = 'backstage.io/managed-by-location'

type Item = Record<string, unknown>

/** The options of a provider over the fake serving `entities`. */
const over = (entities: readonly Item[], faults: Faults = {}) => ({
  base: BASE,
  token: TOKEN,
  catalogueFetch: fakeBackstage({ entities, token: TOKEN, faults }).fetch,
})

/** The options of a provider over the fake serving the folder at `root`. */
const fromFolder = (root: string, faults: Faults = {}) => over(catalogueOf(root), faults)

/** An entity without the two annotations the catalogue sets: the only difference a served one may carry. */
const withoutCatalogueAnnotations = (entity: CatalogueEntity): CatalogueEntity => {
  const {
    [MANAGED_BY]: _location,
    ['backstage.io/managed-by-origin-location']: _origin,
    ...annotations
  } = entity.metadata.annotations
  return { ...entity, metadata: { ...entity.metadata, annotations } } as CatalogueEntity
}

const byRef = (entities: readonly CatalogueEntity[]): Map<string, CatalogueEntity> =>
  new Map(entities.map((entity) => [refOf(entity), entity]))

const sorted = (values: readonly string[]): string[] => [...values].sort()

const ORGANISATION = path.join(GOLDEN, 'organisation')

/** A fake that ignores `fields`, as a server may: every item comes back whole. */
const ignoringFields = (entities: readonly Item[]): CatalogueFetch => {
  const { fetch } = fakeBackstage({ entities, token: TOKEN })
  return async (url, init) => {
    const whole = new URL(url)
    whole.searchParams.delete('fields')
    return fetch(whole, init)
  }
}

const metadataOf = (item: Item): Item => item['metadata'] as Item

describe('BackstageProvider', () => {
  it('reads the demo SI served by a catalogue as the files read it', async () => {
    const files = await new FixtureProvider(DEMO).load()
    const served = await new BackstageProvider(fromFolder(DEMO)).load()
    // The two annotations the catalogue sets (managed-by-location, managed-by-origin-location)
    // are the only difference an entity may carry.
    expect(served.entities.map(withoutCatalogueAnnotations)).toEqual(files.entities)
    expect(served.rejected).toEqual(files.rejected)
    expect(served.ignored).toEqual(files.ignored)
    expect(served.unread).toEqual(files.unread)
    expect(served.census).toMatchObject({ served: 33, pages: 1, repeated: 0 })
    expect(files.census).toBeUndefined()
  })

  it.each(['backstage-apis', 'backstage-namespaces'])(
    'reads %s as the files do, as sets, apart from what the pre-pass sets aside',
    async (golden) => {
      const root = path.join(GOLDEN, golden)
      const files = await new FixtureProvider(root).load()
      const served: LoadResult = await new BackstageProvider(fromFolder(root)).load()

      const servedEntities = byRef(served.entities.map(withoutCatalogueAnnotations))
      expect(sorted([...servedEntities.keys()])).toEqual(sorted(files.entities.map(refOf)))
      for (const entity of files.entities) expect(servedEntities.get(refOf(entity))).toEqual(entity)

      const read = served.ignored.filter((row) => row.prePass === undefined)
      const prePassed = served.ignored.filter((row) => row.prePass !== undefined)
      expect(sorted(read.map(({ ref }) => String(ref)))).toEqual(sorted(files.ignored.map(({ ref }) => String(ref))))
      expect(sorted(read.map(({ reason }) => reason))).toEqual(sorted(files.ignored.map(({ reason }) => reason)))
      expect(prePassed).toEqual([])
      expect(sorted(served.unread)).toEqual(sorted(files.unread))
      expect(sorted(served.rejected.map(({ reason }) => reason))).toEqual(sorted(files.rejected.map(({ reason }) => reason)))
    },
  )

  it('orders by managed-by-location, then by ref, whatever order the pages came in', async () => {
    const files = await new FixtureProvider(DEMO).load()
    // The fake serves by uid, which is a hash; reversed, the page is in no order of any file.
    const served = await new BackstageProvider(fromFolder(DEMO, { reverse: true })).load()
    expect(served.entities.map(refOf)).toEqual(files.entities.map(refOf))
  })

  it('puts an entity with no managed-by-location last, by ref', async () => {
    const items = structuredClone(catalogueOf(DEMO))
    for (const item of items) {
      if (['orders-api', 'billing-api'].includes(String(metadataOf(item)['name']))) {
        delete (metadataOf(item)['annotations'] as Item)[MANAGED_BY]
      }
    }
    const served = await new BackstageProvider(over(items)).load()
    expect(served.entities.map(refOf).slice(-2)).toEqual(['component:default/billing-api', 'component:default/orders-api'])
    expect(served.entities).toHaveLength(33)
  })

  it('names a rejection by its ref and its location', async () => {
    const [template] = catalogueOf(DEMO).filter((item) => metadataOf(item)['name'] === 'billing-api')
    const legacy = structuredClone(template!)
    metadataOf(legacy)['name'] = 'legacy-batch'
    metadataOf(legacy)['uid'] = 'f0000000-0000-4000-8000-0000000000bb'
    ;(metadataOf(legacy)['annotations'] as Item)[MANAGED_BY] = 'url:https://github.com/acme/legacy/blob/main/legacy.yml'
    delete (legacy['spec'] as Item)['owner']
    const served = await new BackstageProvider(over([...catalogueOf(DEMO), legacy])).load()
    expect(served.rejected).toEqual([
      {
        source: 'component:default/legacy-batch (url:https://github.com/acme/legacy/blob/main/legacy.yml)',
        ref: 'component:default/legacy-batch',
        reason: expect.stringMatching(/owner/),
      },
    ])
  })

  it('reads a catalogue past a bound up to it, as a whole read of what it read, and says how far it got', async () => {
    const items = catalogueOf(DEMO)
    const bounded = await new BackstageProvider({ ...over(items), limits: { modelledEntities: 30 } }).load()
    expect(bounded.entities).toHaveLength(30)
    expect(bounded.partial).toEqual([{ scope: 'modelled', kinds: ['component', 'resource', 'api'], read: 30, total: 33, limit: 30 }])
    // The fake serves in uid order: the first 30 of them, read whole, give what the bounded read gave.
    const uid = (item: Item): string => String(metadataOf(item)['uid'])
    const first = [...items].sort((left, right) => (uid(left) < uid(right) ? -1 : 1)).slice(0, 30)
    const whole = await new BackstageProvider(over(first)).load()
    expect(bounded.entities).toEqual(whole.entities)
    expect(bounded.rejected).toEqual(whole.rejected)
    expect(bounded.ignored).toEqual(whole.ignored)
    expect(bounded.unread).toEqual(whole.unread)
    // A whole read has no `partial` key at all, so every LoadResult elsewhere is unchanged.
    expect(whole).not.toHaveProperty('partial')
    expect(await new BackstageProvider(fromFolder(DEMO)).load()).not.toHaveProperty('partial')
  })

  it('never returns part of a catalogue on a failure: a failure on the last page throws, with nothing returned', async () => {
    // Requests: the facets, the modelled read, then three pages of refs; the last one fails.
    const provider = new BackstageProvider(over(catalogueOf(DEMO, { groups: Array.from({ length: 600 }, (_, at) => `team-${String(at)}`) }), {
      status: { at: 4, status: 500 },
    }))
    const outcome = await provider.load().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    expect(outcome).not.toHaveProperty('result')
    expect((outcome as { error: unknown }).error).toBeInstanceOf(CatalogueReadError)
    expect(((outcome as { error: CatalogueReadError }).error).failure).toEqual({ kind: 'status', status: 500 })
  })

  it('reads a User served whole by a server that ignores fields, and keeps no email, no directory id and no picture', async () => {
    const picture = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
    const ada: Item = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: {
        name: 'ada.lovelace_acme.example',
        namespace: 'default',
        uid: 'a0000000-0000-4000-8000-000000000001',
        annotations: {
          'microsoft.com/email': 'ada.lovelace@acme.example',
          'graph.microsoft.com/user-id': '0f9d3c1e-user-id',
          [MANAGED_BY]: 'msgraph:default/acme',
        },
      },
      spec: { profile: { displayName: 'Ada Lovelace', email: 'ada.lovelace@acme.example', picture }, memberOf: ['tiger'] },
    }
    const loaded = await new BackstageProvider({ base: BASE, token: TOKEN, catalogueFetch: ignoringFields([...catalogueOf(DEMO), ada]) }).load()
    expect(loaded.organisation).toEqual([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'User',
        metadata: { name: 'ada.lovelace_acme.example' },
        spec: { memberOf: ['group:default/tiger'] },
      },
    ])
    // The pre-pass drops the profile before the reader sees it; the annotations
    // are the reader's to drop, and to name as not read.
    expect(loaded.unread).toEqual(['metadata.annotations'])
    expect(JSON.stringify(loaded)).not.toMatch(/@|user-id|data:image|Lovelace/)
  })

  it('reads tests/golden/organisation served by a catalogue as the files read it, as sets, but for judged and what was not asked for', async () => {
    const files = await new FixtureProvider(ORGANISATION).load()
    const served = await new BackstageProvider(fromFolder(ORGANISATION)).load()
    const refs = (nodes: readonly GraphNode[] | undefined): string[] => sorted((nodes ?? []).map(refOf))
    expect(refs(served.entities)).toEqual(refs(files.entities))
    expect(refs(served.organisation)).toEqual(refs(files.organisation))
    expect(refs(files.organisation)).toHaveLength(7)
    const byRefOf = (nodes: readonly GraphNode[] | undefined): Map<string, GraphNode> =>
      new Map((nodes ?? []).map((node) => [refOf(node), node]))
    const served_ = byRefOf(served.organisation)
    for (const [ref, node] of byRefOf(files.organisation)) expect(served_.get(ref)).toEqual(node)
    expect(served.ignored).toEqual(files.ignored)
    expect(served.rejected).toEqual(files.rejected)
    // The files never judge; the catalogue judges the kinds it read whole.
    expect(files.judged).toBeUndefined()
    expect(served.judged).toEqual(['Group', 'User', 'System', 'Domain'])
    // ada's annotations and profile are named from the file, and never asked of a catalogue.
    expect(files.unread).toEqual(['metadata.annotations', 'spec.profile'])
    expect(served.unread).toEqual([])
  })
})