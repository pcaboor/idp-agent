import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackstageProvider } from '../../src/context/backstage/provider.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import type { CatalogueFetch } from '../../src/context/backstage/transport.js'
import { prePass, refOfItem } from '../../src/context/backstage/translate.js'
import { refOf } from '../../src/context/graph/entity-graph.js'
import type { CatalogueEntity, OrganisationEntity } from '../../src/core/schemas/entity.js'
import { parseDocuments, readValue } from '../../src/core/yaml/serialize.js'
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
 *
 * Beside it, recorded by the same run, the first page of the organisation read
 * (`org-by-query-<version>.json`): tools/backstage/org.yaml's Groups and Users
 * as Backstage served them for the fields the provider asks for. It is the
 * proof that a real Backstage honours `fields` — ada's profile and email
 * annotation are ingested and never served — and the run that records it
 * refuses to write a page holding either.
 */

/** The release the fixture came from: the demo Backstage's, which names the file. */
const VERSION = (
  JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../tools/backstage/app/backstage.json'), 'utf8')) as {
    version: string
  }
).version
const PAGE = path.resolve(import.meta.dirname, `backstage/by-query-${VERSION}.json`)
const ORGANISATION_PAGE = path.resolve(import.meta.dirname, `backstage/org-by-query-${VERSION}.json`)
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORG = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
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

/** The organisation read, as `loadCatalogue` sends it and `pnpm demo:backstage:docker --record` recorded it. */
const ORGANISATION_QUERY =
  '?filter=kind%3Dgroup&filter=kind%3Duser' +
  '&fields=apiVersion%2Ckind%2Cmetadata.name%2Cmetadata.namespace%2Cmetadata.uid%2Cspec.type%2Cspec.parent' +
  '%2Cspec.children%2Cspec.members%2Cspec.memberOf%2Cspec.owner%2Cspec.domain%2Cspec.subdomainOf&limit=250'

const organisationRecorded = readFileSync(ORGANISATION_PAGE, 'utf8')
const organisationPage = JSON.parse(organisationRecorded) as Page

/** An item through the pre-pass and `readValue`, which must read it as an organisation node. */
function organisationReading(item: unknown): { entity: OrganisationEntity; unread: readonly string[] } {
  const passed = prePass(item)
  if (!('value' in passed)) throw new Error(`${String(refOfItem(item as Item))} was set aside`)
  const reading = readValue(passed.value)
  if (reading.as !== 'organisation') throw new Error(`${String(refOfItem(item as Item))} was read as ${reading.as}`)
  return { entity: reading.entity, unread: reading.unread }
}

/** What org.yaml declares, as the read model holds it: written out, so a change to the reader shows here. */
const ORGANISATION: OrganisationEntity[] = [
  ...['common', 'dodowarriors', 'elephant'].map((name) => ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group' as const,
    metadata: { name },
    spec: { type: 'team', children: [] },
  })),
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name: 'engineering' },
    spec: {
      type: 'department',
      children: ['group:default/common', 'group:default/dodowarriors', 'group:default/elephant', 'group:default/tiger'],
    },
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name: 'tiger' },
    spec: { type: 'team', children: [] },
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name: 'ada' },
    spec: { memberOf: ['group:default/tiger'] },
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name: 'linus' },
    spec: { memberOf: ['group:default/common'] },
  },
] as OrganisationEntity[]

const byRef = (left: OrganisationEntity, right: OrganisationEntity): number =>
  refOf(left) < refOf(right) ? -1 : refOf(left) > refOf(right) ? 1 : 0

/**
 * A catalogue that answers the facets with the kinds of both recorded pages,
 * the modelled read with the one and the organisation read with the other,
 * byte for byte; every by-query request is kept.
 */
function recordedWithOrganisation(): { fetch: CatalogueFetch; queries: string[] } {
  const queries: string[] = []
  const fetch: CatalogueFetch = async (url) => {
    await Promise.resolve()
    const headers = { 'content-type': 'application/json; charset=utf-8' }
    if (url.pathname === `${BASE.pathname}/entity-facets`) {
      const counts = new Map<string, number>()
      for (const item of [...page.items, ...organisationPage.items]) {
        counts.set(String(item['kind']), (counts.get(String(item['kind'])) ?? 0) + 1)
      }
      const kind = [...counts].map(([value, count]) => ({ value, count }))
      return new Response(JSON.stringify({ facets: { kind } }), { status: 200, headers })
    }
    queries.push(url.search)
    const body = url.searchParams.getAll('filter').includes('kind=group') ? organisationRecorded : recorded
    return new Response(body, { status: 200, headers })
  }
  return { fetch, queries }
}

describe(`the contract fixture: the organisation page from Backstage ${VERSION}`, () => {
  it('holds what was asked for and nothing else: no profile, no annotation, no @', () => {
    expect(Object.keys(organisationPage).sort()).toEqual(['items', 'pageInfo', 'totalItems'])
    expect(organisationPage.totalItems).toBe(7)
    expect(organisationPage.pageInfo).toEqual({})
    expect(organisationPage.items.map((item) => `${String(item['kind'])}:${String(metadataOf(item)['name'])}`).sort()).toEqual([
      'Group:common',
      'Group:dodowarriors',
      'Group:elephant',
      'Group:engineering',
      'Group:tiger',
      'User:ada',
      'User:linus',
    ])
    for (const item of organisationPage.items) {
      expect(Object.keys(item).sort()).toEqual(['apiVersion', 'kind', 'metadata', 'spec'])
      expect(Object.keys(metadataOf(item)).sort()).toEqual(['name', 'namespace', 'uid'])
      expect(item['spec']).not.toHaveProperty('profile')
    }
    // ada's email is in org.yaml twice, and Backstage ingested both: served, either would carry an @.
    expect(readFileSync(ORG, 'utf8')).toContain('ada@acme.example')
    expect(organisationRecorded).not.toContain('@')
  })

  it('reads, item by item through the pre-pass and readValue, as org.yaml declares the organisation', () => {
    const read = organisationPage.items.map(organisationReading)
    expect(read.map(({ entity }) => entity).sort(byRef)).toEqual(ORGANISATION)
    expect(read.flatMap(({ unread }) => unread)).toEqual([])
    // The file road reads the same nodes out of the same file.
    expect([...parseDocuments(readFileSync(ORG, 'utf8')).organisation].sort(byRef)).toEqual(ORGANISATION)
  })

  it('reads a server that ignored `fields` as this page: the profile goes no further than the pre-pass', () => {
    const ada = organisationPage.items.find((item) => metadataOf(item)['name'] === 'ada')
    const profile = { displayName: 'Ada', email: 'ada@acme.example', picture: 'data:image/png;base64,iVBORw0KGgo=' }
    const overserved = { ...ada, spec: { ...(ada?.['spec'] as Item), profile } }
    expect(organisationReading(overserved)).toEqual(organisationReading(ada))
    expect(organisationReading(overserved).unread).toEqual([])
  })

  it("loads as the fake's organisation loads, answering exactly the request the provider sends", async () => {
    const catalogue = recordedWithOrganisation()
    const real = await new BackstageProvider({ base: BASE, token: 'contract', catalogueFetch: catalogue.fetch }).load()
    const fake = await new BackstageProvider({
      base: BASE,
      token: 'contract',
      catalogueFetch: fakeBackstage({ entities: catalogueOf(DEMO, { org: ORG }), token: 'contract' }).fetch,
    }).load()

    expect(catalogue.queries).toEqual(['?filter=kind%3Dcomponent&filter=kind%3Dresource&filter=kind%3Dapi&limit=250', ORGANISATION_QUERY])
    expect(real.organisation).toEqual(fake.organisation)
    expect([...(real.organisation ?? [])].sort(byRef)).toEqual(ORGANISATION)
    expect(real.judged).toEqual(fake.judged)
    expect(real.unread).toEqual(fake.unread)
    expect(real.entities.map(withoutCatalogueAnnotations)).toEqual(fake.entities.map(withoutCatalogueAnnotations))
  })
})
