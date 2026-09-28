import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackstageProvider } from '../../src/context/backstage/provider.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import type { CatalogueFetch } from '../../src/context/backstage/transport.js'
import { prePass, refOfItem } from '../../src/context/backstage/translate.js'
import { refOf } from '../../src/context/graph/entity-graph.js'
import type { CatalogueEntity } from '../../src/core/schemas/entity.js'
import { readValue } from '../../src/core/yaml/serialize.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * The contract fixture of docs/backstage-http-brief.md § 9: one `by-query`
 * page recorded from a real Backstage — 1.55.2, the demo Backstage in Docker
 * (tools/backstage/), holding the demo SI — answering the provider's modelled
 * read. Recorded by `pnpm demo:backstage:docker --record`; the demo SI only,
 * from a loopback catalogue, with no token in it. Its uids and etags are the
 * ones that run drew: the note asks for none to be normalised.
 *
 * Every other catalogue test reads what `tools/fake-backstage.ts` serves. This
 * one holds the page to fixed expectations of its own — what the demo SI's
 * files read, with no fake in between — and holds the fake to what Backstage
 * served: the page, read through the pre-pass and `readValue`, gives what the
 * fake's page gives for the same files, entity for entity, and in the same
 * order.
 *
 * The page holds no `status` on any item: Backstage 1.55.2 serves it only
 * when an entity's processing failed, and none of the demo SI's did. That the
 * pre-pass drops `status` stays proven by tests/unit/backstage-prepass.test.ts.
 */

/** The release the fixture came from: the demo Backstage's, which names the file. */
const VERSION = (
  JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../tools/backstage/app/backstage.json'), 'utf8')) as {
    version: string
  }
).version
const PAGE = path.resolve(import.meta.dirname, `backstage/by-query-${VERSION}.json`)
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const BASE = new URL('http://127.0.0.1:7007/api/catalog')
const MANAGED_BY = 'backstage.io/managed-by-location'
const ORIGIN = 'backstage.io/managed-by-origin-location'

type Item = Record<string, unknown>
interface Page {
  items: Item[]
  totalItems: number
  pageInfo: { nextCursor?: string }
}

const recorded = readFileSync(PAGE, 'utf8')
const page = JSON.parse(recorded) as Page

const metadataOf = (item: Item): Item => item['metadata'] as Item
const annotationsOf = (item: Item): Record<string, string> => metadataOf(item)['annotations'] as Record<string, string>

/** An entity without the two annotations the catalogue sets: the only difference a served one may carry. */
const withoutCatalogueAnnotations = (entity: CatalogueEntity): CatalogueEntity => {
  const { [MANAGED_BY]: _location, [ORIGIN]: _origin, ...annotations } = entity.metadata.annotations
  return { ...entity, metadata: { ...entity.metadata, annotations } } as CatalogueEntity
}

/**
 * A catalogue that answers the modelled read with the recorded page, byte for
 * byte, and the facets with the kinds that page holds. Every by-query request
 * is kept, to check it is the one the page was recorded for.
 */
function recordedCatalogue(): { fetch: CatalogueFetch; queries: string[] } {
  const queries: string[] = []
  const fetch: CatalogueFetch = async (url) => {
    await Promise.resolve()
    if (url.pathname === `${BASE.pathname}/entity-facets`) {
      const counts = new Map<string, number>()
      for (const item of page.items) counts.set(String(item['kind']), (counts.get(String(item['kind'])) ?? 0) + 1)
      const kind = [...counts].map(([value, count]) => ({ value, count }))
      return new Response(JSON.stringify({ facets: { kind } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    queries.push(url.search)
    return new Response(recorded, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
  }
  return { fetch, queries }
}

describe(`the contract fixture: a by-query page from Backstage ${VERSION}`, () => {
  it('is the envelope the load reads, the demo SI whole on one page, with what a catalogue adds', () => {
    expect(Object.keys(page).sort()).toEqual(['items', 'pageInfo', 'totalItems'])
    expect(page.totalItems).toBe(33)
    expect(page.items).toHaveLength(33)
    expect(page.pageInfo).toEqual({})
    for (const item of page.items) {
      expect(metadataOf(item)).toMatchObject({ namespace: 'default', uid: expect.any(String), etag: expect.any(String) })
      expect(annotationsOf(item)[MANAGED_BY]).toMatch(/^file:\/app\/si-demo\/(catalog|components|dependencies)\/.+\.yml$/)
      // Unlike the fake, Backstage names the registration as every entity's origin.
      expect(annotationsOf(item)[ORIGIN]).toBe('file:/app/si-demo/catalog-info.yaml')
      expect(item['relations']).toEqual(expect.any(Array))
    }
  })

  it('holds relations no spec of the entity declares, which the pre-pass drops', () => {
    // Backstage stitches the inverse of every relation onto its target:
    // billing-db-prod is served `dependencyOf` the two rights over it, which
    // its own file never states. The fake emits an entity's own relations
    // only, so this page is where the drop is proven against a real one.
    const database = page.items.find((item) => metadataOf(item)['name'] === 'billing-db-prod')
    expect(database?.['spec']).not.toHaveProperty('dependencyOf')
    expect(database?.['relations']).toEqual(
      expect.arrayContaining([{ type: 'dependencyOf', targetRef: 'resource:default/billing-api-billing-db-prod' }]),
    )
    const passed = prePass(database)
    expect(passed).not.toHaveProperty('aside')
    expect('value' in passed ? passed.value : {}).not.toHaveProperty('relations')
  })

  it("loads as the demo SI's files read, with no fake in between", async () => {
    const files = await new FixtureProvider(DEMO).load()
    const real = await new BackstageProvider({ base: BASE, token: 'contract', catalogueFetch: recordedCatalogue().fetch }).load()
    // The two annotations the catalogue sets are the only difference an entity may carry:
    // no relation, uid or etag reaches an entity, and nothing is left unread that the files read.
    expect(real.entities.map(withoutCatalogueAnnotations)).toEqual(files.entities)
    expect(real.rejected).toEqual(files.rejected)
    expect(real.ignored).toEqual(files.ignored)
    expect(real.unread).toEqual(files.unread)
    expect(real.census).toMatchObject({ served: 33, pages: 1, repeated: 0 })
  })

  it('reads, item by item through the pre-pass and readValue, as the fake serving the same files', () => {
    const fake = new Map(catalogueOf(DEMO).map((item) => [refOfItem(item), item]))
    expect([...fake.keys()].sort()).toEqual(page.items.map((item) => refOfItem(item)).sort())
    for (const item of page.items) {
      const real = prePass(item)
      const twin = prePass(fake.get(refOfItem(item)))
      if (!('value' in real) || !('value' in twin)) throw new Error(`${String(refOfItem(item))} was set aside`)
      const [left, right] = [readValue(real.value), readValue(twin.value)]
      if (left.as !== 'entity' || right.as !== 'entity') throw new Error(`${String(refOfItem(item))} was not read as an entity`)
      expect(withoutCatalogueAnnotations(left.entity)).toEqual(withoutCatalogueAnnotations(right.entity))
      expect(left.unread).toEqual(right.unread)
    }
  })

  it('loads as the fake loads: the same entities in the same order, nothing refused or set aside', async () => {
    const catalogue = recordedCatalogue()
    const real = await new BackstageProvider({ base: BASE, token: 'contract', catalogueFetch: catalogue.fetch }).load()
    const fake = await new BackstageProvider({
      base: BASE,
      token: 'contract',
      catalogueFetch: fakeBackstage({ entities: catalogueOf(DEMO), token: 'contract' }).fetch,
    }).load()

    // The page answers exactly the request the provider sends.
    expect(catalogue.queries).toEqual(['?filter=kind%3Dcomponent&filter=kind%3Dresource&filter=kind%3Dapi&limit=250'])
    expect(real.entities.map(refOf)).toEqual(fake.entities.map(refOf))
    expect(real.entities.map(withoutCatalogueAnnotations)).toEqual(fake.entities.map(withoutCatalogueAnnotations))
    expect(real.rejected).toEqual([])
    expect(real.ignored).toEqual(fake.ignored)
    expect(real.unread).toEqual(fake.unread)
    expect(real.census).toMatchObject({ served: 33, pages: 1, repeated: 0 })
  })
})
