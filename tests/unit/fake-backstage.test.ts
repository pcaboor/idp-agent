import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { answerOf, catalogueOf, handler } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * The fake Backstage is what every test above the transport reads, and what
 * the demo serves: if it paged differently from a real catalogue, the load's
 * checks would be proven against a server nobody runs. So it is held here to
 * Backstage's own paging (docs/plans/backstage-http-slice-1.md, row 22): the
 * cursor carries the filter, the order and `totalItems`; `limit` and `fields`
 * are read from each request; a `filter` beside a cursor is ignored; 200 when
 * no `limit` is sent, and no cap.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const BASE = 'https://backstage.canary.example/api/catalog'
const REFS = 'kind,metadata.namespace,metadata.name,metadata.uid'

interface Page {
  items: Record<string, unknown>[]
  totalItems: number
  pageInfo: { nextCursor?: string }
}

const ask = async (serve: (request: Request) => Promise<Response>, query: string, init: RequestInit = {}): Promise<Response> =>
  serve(new Request(`${BASE}/entities/by-query?${query}`, init))

const page = async (serve: (request: Request) => Promise<Response>, query: string): Promise<Page> => {
  const response = await ask(serve, query)
  expect(response.status).toBe(200)
  return (await response.json()) as Page
}

const next = (cursor: string | undefined, rest: Record<string, string> = {}): string => {
  expect(cursor).toBeDefined()
  return new URLSearchParams({ cursor: cursor ?? '', ...rest }).toString()
}

const uidOf = (item: Record<string, unknown>): unknown => (item['metadata'] as Record<string, unknown>)['uid']

/** Group names enough to fill more than one page of the default size. */
const groups = (count: number): string[] => Array.from({ length: count }, (_, at) => `team-${String(at).padStart(4, '0')}`)

describe('catalogueOf', () => {
  it('serves the demo SI as a catalogue does: a namespace, a uid, an etag, relations and the two locations', async () => {
    const served = catalogueOf(DEMO)
    expect(served).toHaveLength(33)
    const billing = served.find((item) => (item['metadata'] as { name: string }).name === 'billing-api')!
    const metadata = billing['metadata'] as Record<string, unknown>
    expect(metadata['namespace']).toBe('default')
    expect(metadata['uid']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(typeof metadata['etag']).toBe('string')
    expect(metadata['annotations']).toMatchObject({
      'backstage.io/managed-by-location': 'url:https://github.com/acme/si-demo/blob/main/components/billing-api.yml',
      'backstage.io/managed-by-origin-location': 'url:https://github.com/acme/si-demo/blob/main/components/billing-api.yml',
    })
    // `spec` as written, short references included.
    const file = parse(await readFile(path.join(DEMO, 'components/billing-api.yml'), 'utf8')) as Record<string, unknown>
    expect(billing['spec']).toEqual(file['spec'])
    expect(billing['relations']).toContainEqual({ type: 'ownedBy', targetRef: 'group:default/tiger' })
  })

  it('gives the same uids on every call, and a Group per name asked for', () => {
    const once = catalogueOf(DEMO).map(uidOf)
    expect(catalogueOf(DEMO).map(uidOf)).toEqual(once)
    expect(new Set(once).size).toBe(33)
    const withGroups = catalogueOf(DEMO, { groups: ['tiger', 'elephant', 'dodowarriors'] })
    expect(withGroups.filter((item) => item['kind'] === 'Group').map((item) => (item['metadata'] as { name: string }).name)).toEqual([
      'tiger',
      'elephant',
      'dodowarriors',
    ])
  })
})

describe('handler', () => {
  const serve = handler({ entities: catalogueOf(DEMO), base: '/api/catalog' })

  it('serves the demo SI over pages of 10, ordered by uid, totalItems on every page', async () => {
    const seen: unknown[] = []
    let answer = await page(serve, 'limit=10')
    for (let pages = 1; ; pages += 1) {
      expect(answer.totalItems).toBe(33)
      seen.push(...answer.items.map(uidOf))
      if (answer.pageInfo.nextCursor === undefined) {
        expect(pages).toBe(4)
        break
      }
      answer = await page(serve, next(answer.pageInfo.nextCursor, { limit: '10' }))
    }
    expect(seen).toHaveLength(33)
    expect(seen).toEqual([...seen].sort())
  })

  it('answers a next page sent with its cursor alone at the default 200, whole', async () => {
    const big = handler({ entities: catalogueOf(DEMO, { groups: groups(300) }) })
    const first = await page(big, `limit=10&fields=${REFS}`)
    expect(first.items).toHaveLength(10)
    const second = await page(big, next(first.pageInfo.nextCursor))
    expect(second.items).toHaveLength(200)
    expect(second.items.every((item) => 'apiVersion' in item)).toBe(true)
    expect(second.totalItems).toBe(333)
  })

  it('answers a next page sent with limit and fields at that size, projected', async () => {
    const first = await page(serve, 'limit=10')
    const second = await page(serve, next(first.pageInfo.nextCursor, { limit: '5', fields: REFS }))
    expect(second.items).toHaveLength(5)
    for (const item of second.items) {
      expect(Object.keys(item).sort()).toEqual(['kind', 'metadata'])
      expect(Object.keys(item['metadata'] as object).sort()).toEqual(['name', 'namespace', 'uid'])
    }
  })

  it('ignores a filter beside a cursor: the cursor carries the first page’s', async () => {
    const first = await page(serve, 'filter=kind%3Dcomponent&limit=2')
    expect(first.totalItems).toBe(5)
    const second = await page(serve, next(first.pageInfo.nextCursor, { filter: 'kind=resource', limit: '10' }))
    expect(second.items.map((item) => item['kind'])).toEqual(['Component', 'Component', 'Component'])
    expect(second.totalItems).toBe(5)
    expect(second.pageInfo.nextCursor).toBeUndefined()
  })

  it('ORs repeated filters, compares kind= without case, and caps nothing', async () => {
    const all = await page(serve, 'filter=kind%3DCOMPONENT&filter=kind%3Dresource&limit=1000')
    expect(all.items).toHaveLength(33)
    expect(all.totalItems).toBe(33)
  })

  it('returns refs only when fields asks for them', async () => {
    const refs = await page(serve, `filter=kind%3Dresource&fields=${REFS}&limit=100`)
    expect(refs.items).toHaveLength(28)
    expect(refs.items[0]).toEqual({
      kind: 'Resource',
      metadata: { namespace: 'default', name: expect.any(String), uid: expect.any(String) },
    })
  })

  it('counts every kind in its facets', async () => {
    const withGroups = handler({ entities: catalogueOf(DEMO, { groups: ['tiger', 'elephant', 'dodowarriors'] }) })
    const response = await withGroups(new Request(`${BASE}/entity-facets?facet=kind`))
    expect(await response.json()).toEqual({
      facets: {
        kind: [
          { value: 'Component', count: 5 },
          { value: 'Group', count: 3 },
          { value: 'Resource', count: 28 },
        ],
      },
    })
  })

  it('answers 405 to another method, 404 to another path', async () => {
    expect((await ask(serve, 'limit=1', { method: 'POST' })).status).toBe(405)
    expect((await serve(new Request(`${BASE}/entities`))).status).toBe(404)
    expect((await serve(new Request('https://backstage.canary.example/api/other/entities/by-query'))).status).toBe(404)
  })

  it('answers 401 to a missing or wrong bearer when a token is configured, and serves the right one', async () => {
    const guarded = handler({ entities: catalogueOf(DEMO), token: 'canary-token' })
    expect((await ask(guarded, 'limit=1')).status).toBe(401)
    expect((await ask(guarded, 'limit=1', { headers: { authorization: 'Bearer other' } })).status).toBe(401)
    expect((await ask(guarded, 'limit=1', { headers: { authorization: 'Bearer canary-token' } })).status).toBe(200)
  })
})

describe('fakeBackstage', () => {
  it('is a fetch that keeps every request, the headers and the redirect mode included', async () => {
    const { fetch, sent } = fakeBackstage({ entities: catalogueOf(DEMO) })
    const response = await fetch(new URL(`${BASE}/entity-facets?facet=kind`), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    expect(response.status).toBe(200)
    expect(sent).toEqual([
      {
        method: 'GET',
        url: `${BASE}/entity-facets?facet=kind`,
        headers: { accept: 'application/json' },
        redirect: 'error',
        body: undefined,
      },
    ])
  })

  it('answers a fault instead of the catalogue on the request it names', async () => {
    const { fetch } = fakeBackstage({
      entities: catalogueOf(DEMO),
      faults: { status: { at: 1, status: 429, headers: { 'retry-after': '2' } } },
    })
    const url = new URL(`${BASE}/entity-facets?facet=kind`)
    expect((await fetch(url, {})).status).toBe(200)
    const limited = await fetch(url, {})
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('2')
    expect((await fetch(url, {})).status).toBe(200)
  })

  it('answers every other fault it defines on the request it names, and the catalogue on the others', async () => {
    const url = new URL(`${BASE}/entity-facets?facet=kind`)
    const echoing = fakeBackstage({ entities: catalogueOf(DEMO), token: 'canary', faults: { echoHeaders: { at: 1 } } })
    const init = { headers: { authorization: 'Bearer canary', accept: 'application/json' } }
    expect(await (await echoing.fetch(url, init)).json()).toHaveProperty('facets')
    expect(await (await echoing.fetch(url, init)).json()).toEqual({
      headers: { authorization: 'Bearer canary', accept: 'application/json' },
    })

    const moved = fakeBackstage({ entities: catalogueOf(DEMO), faults: { responseUrl: { at: 0, url: 'https://evil.example/x' } } })
    const answered = await moved.fetch(url, {})
    expect(answered.url).toBe('https://evil.example/x')
    expect(answered.status).toBe(200)

    const html = fakeBackstage({ entities: catalogueOf(DEMO), faults: { notJson: { at: 0 } } })
    await expect((await html.fetch(url, {})).json()).rejects.toThrow()

    const sized = fakeBackstage({ entities: catalogueOf(DEMO), faults: { bytes: { at: 0, size: 4096 } } })
    expect((await (await sized.fetch(url, {})).arrayBuffer()).byteLength).toBe(4096)
  })

  it('rejects when the signal it is handed aborts, a hang included', async () => {
    const { fetch } = fakeBackstage({ entities: catalogueOf(DEMO), faults: { hang: { at: 0 } } })
    const controller = new AbortController()
    const pending = fetch(new URL(`${BASE}/entity-facets?facet=kind`), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
  })
})

describe('answerOf', () => {
  // What the demo's server answers one incoming request, apart from the
  // socket: it never throws, so no request can stop the demo.
  const serve = handler({ entities: catalogueOf(DEMO) })

  it('answers the handler’s response to a request it can build', async () => {
    const response = await answerOf(serve, { method: 'GET', url: '/api/catalog/entity-facets?facet=kind', headers: {} })
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('facets.kind')
  })

  it('answers 405 to a method no Request can carry: TRACE, CONNECT, TRACK', async () => {
    for (const method of ['TRACE', 'CONNECT', 'TRACK']) {
      const response = await answerOf(serve, { method, url: '/api/catalog/entity-facets', headers: {} })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
    }
  })

  it('answers 400 to a target no Request can be built from: one holding credentials', async () => {
    const response = await answerOf(serve, { method: 'GET', url: 'http://user:secret@127.0.0.1/api/catalog/entity-facets', headers: {} })
    expect(response.status).toBe(400)
  })

  it('answers 500 when the handler throws', async () => {
    const response = await answerOf(
      async () => {
        throw new Error('boom')
      },
      { method: 'GET', url: '/api/catalog/entity-facets', headers: {} },
    )
    expect(response.status).toBe(500)
  })
})
