import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { BACKSTAGE_LIMITS } from '../../src/context/backstage/limits.js'
import {
  BACKSTAGE_TOKEN_VARIABLE,
  CATALOGUE_REQUESTS,
  CatalogueReadError,
  catalogueTransport,
  catalogueUrl,
  isLoopback,
  type CatalogueFetch,
  type CatalogueRoute,
} from '../../src/context/backstage/transport.js'

/**
 * The transport is the only code that will ever send a catalogue token
 * (docs/backstage-http-brief.md § 4), so every guard it keeps is proven here,
 * against a hand-written `fetch` that keeps every call and answers what the
 * case needs. No socket is opened: the offline setup leaves the global `fetch`
 * a thrower, and every test also spies on it, so a transport that fell back to
 * it would fail here as well as there.
 *
 * NO REAL TOKEN IS WRITTEN HERE. The canary below was never issued by anyone,
 * and the host is under `.example`, which resolves nowhere.
 */

const BASE = new URL('https://backstage.canary.example/api/catalog')
const ORIGIN = 'https://backstage.canary.example'
const TOKEN = 'canary-backstage-token-0123456789'
const LOOPBACK = new URL('http://127.0.0.1:7007/api/catalog')
const EMPTY = { items: [], totalItems: 0, pageInfo: {} }

interface Sent {
  url: string
  init: RequestInit
}

/** A `fetch` that keeps every call and answers with `answer`, told how many came before. */
const keeping = (
  answer: (url: URL, init: RequestInit, index: number) => Response | Promise<Response>,
): { fetch: CatalogueFetch; sent: Sent[] } => {
  const sent: Sent[] = []
  const fetch: CatalogueFetch = async (url, init) => {
    sent.push({ url: url.href, init })
    return answer(url, init, sent.length - 1)
  }
  return { fetch, sent }
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

const headerEntries = (init: RequestInit): [string, string][] => [...new Headers(init.headers).entries()]

/**
 * A body of `chunks` that says whether it was read: `highWaterMark: 0`, so
 * nothing is pulled before a reader asks, and `cancel` is recorded. Finite,
 * so a transport that read what it should not fails an assertion rather than
 * hanging the suite.
 */
const watched = (
  ...chunks: (string | Uint8Array)[]
): { stream: ReadableStream<Uint8Array>; pulls: () => number; cancelled: () => boolean } => {
  let pulls = 0
  let cancelled = false
  const left = chunks.map((chunk) => (typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk))
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1
        const next = left.shift()
        if (next === undefined) controller.close()
        else controller.enqueue(next)
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, pulls: () => pulls, cancelled: () => cancelled }
}

type Options = Omit<Parameters<typeof catalogueTransport>[0], 'catalogueFetch'>

/** The error one request ends on, with the transport that sent it. */
const failure = async (fetch: CatalogueFetch, options: Partial<Options> = {}): Promise<CatalogueReadError> => {
  const transport = catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch, ...options })
  const error = await transport
    .request('GET', 'entities/by-query', new URLSearchParams({ limit: '250' }))
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
  expect(error).toBeInstanceOf(CatalogueReadError)
  return error as CatalogueReadError
}

/** Everything an error could carry to a person, a trace or a log. */
const everything = (error: unknown): string =>
  `${String(error)}\n${(error as Error).stack ?? ''}\n${inspect(error, { depth: 10, showHidden: true })}\n${JSON.stringify(error)}`

let globalFetch: MockInstance
let written: MockInstance[]

beforeEach(() => {
  globalFetch = vi.spyOn(globalThis, 'fetch')
  // The transport says nothing: what reaches a person is 1.5's line, built
  // from the failure. A token cannot reach stderr through a module that never
  // writes there.
  written = [
    vi.spyOn(process.stderr, 'write'),
    vi.spyOn(process.stdout, 'write'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'warn'),
    vi.spyOn(console, 'log'),
  ]
})

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled()
  for (const spy of written) expect(spy).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

describe('the requests the transport sends', () => {
  it('sends GET to the base and route, the token in one header, and redirect: error', async () => {
    const { fetch, sent } = keeping(() => json(EMPTY))
    const answer = await catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch }).request(
      'GET',
      'entities/by-query',
      new URLSearchParams({ limit: '250' }),
    )
    expect(answer).toEqual(EMPTY)
    expect(sent).toHaveLength(1)
    expect(new URL(sent[0]!.url).origin).toBe(BASE.origin)
    expect(new URL(sent[0]!.url).pathname).toBe('/api/catalog/entities/by-query')
    expect(new URL(sent[0]!.url).search).toBe('?limit=250')
    expect(sent[0]!.init.method).toBe('GET')
    expect(sent[0]!.init.redirect).toBe('error')
    expect(headerEntries(sent[0]!.init).filter(([, value]) => value.includes(TOKEN))).toEqual([
      ['authorization', `Bearer ${TOKEN}`],
    ])
    expect(headerEntries(sent[0]!.init)).toEqual([
      ['accept', 'application/json'],
      ['authorization', `Bearer ${TOKEN}`],
    ])
    // Nothing else of the request holds it: no body, no field of init.
    const { headers, ...rest } = sent[0]!.init
    expect(JSON.stringify(rest)).not.toContain(TOKEN)
    expect(headers).toBeDefined()
  })

  it('sends the facets route the same way', async () => {
    const { fetch, sent } = keeping(() => json({ facets: {} }))
    await catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch }).request(
      'GET',
      'entity-facets',
      new URLSearchParams({ facet: 'kind' }),
    )
    expect(new URL(sent[0]!.url).pathname).toBe('/api/catalog/entity-facets')
    expect(sent[0]!.init.redirect).toBe('error')
  })

  it('lists two requests, both GET', () => {
    expect(CATALOGUE_REQUESTS).toEqual([
      ['GET', 'entities/by-query'],
      ['GET', 'entity-facets'],
    ])
    expect(BACKSTAGE_TOKEN_VARIABLE).toBe('IDP_BACKSTAGE_TOKEN')
  })

  it('sends no Authorization header without a token, to a loopback host', async () => {
    for (const token of [undefined, '']) {
      const { fetch, sent } = keeping(() => json(EMPTY))
      await catalogueTransport({ base: LOOPBACK, token, catalogueFetch: fetch }).request(
        'GET',
        'entities/by-query',
        new URLSearchParams(),
      )
      expect(headerEntries(sent[0]!.init)).toEqual([['accept', 'application/json']])
      expect(sent[0]!.url).toBe('http://127.0.0.1:7007/api/catalog/entities/by-query')
    }
  })

  it('refuses to be built without a token for a host that is not loopback, and sends nothing', () => {
    for (const token of [undefined, '']) {
      const { fetch, sent } = keeping(() => json(EMPTY))
      expect(() => catalogueTransport({ base: BASE, token, catalogueFetch: fetch })).toThrow(TypeError)
      expect(sent).toEqual([])
    }
  })

  it('refuses a token a header cannot carry, without quoting it', () => {
    // `Headers` would throw with the value in its message, and that message
    // would reach stderr: the transport says what is wrong and not what it is.
    for (const token of [`${TOKEN}\r\nx-evil: 1`, `${TOKEN} two`, `${TOKEN}é`]) {
      const { fetch, sent } = keeping(() => json(EMPTY))
      let thrown: unknown
      try {
        catalogueTransport({ base: BASE, token, catalogueFetch: fetch })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(TypeError)
      expect(everything(thrown)).not.toContain(TOKEN)
      expect(sent).toEqual([])
    }
  })

  it.each([
    // Rebuilt from its parts, it would reach https://evil.example.
    ['a pathname that starts with two slashes', 'https://backstage.canary.example//evil.example/api/catalog'],
    // Rebuilt, https://entities/by-query.
    ['the root pathname', 'https://backstage.canary.example/'],
    ['a trailing slash', 'https://backstage.canary.example/api/catalog/'],
    ['an empty segment', 'https://backstage.canary.example/api//catalog'],
    ['http: to a host that is not loopback', 'http://backstage.canary.example/api/catalog'],
    ['http: to a loopback name that is not one of the three', 'http://127.0.0.2/api/catalog'],
    ['a scheme that is not http: or https:', 'ftp://backstage.canary.example/api/catalog'],
    ['userinfo', 'https://me:pw-canary-secret@backstage.canary.example/api/catalog'],
    ['a password alone', 'https://:pw-canary-secret@backstage.canary.example/api/catalog'],
    ['a query', 'https://backstage.canary.example/api/catalog?token=pw-canary-secret'],
    ['a fragment', 'https://backstage.canary.example/api/catalog#pw-canary-secret'],
  ])('refuses to be built on a base with %s, and sends nothing', (_, base) => {
    const { fetch, sent } = keeping(() => json(EMPTY))
    let thrown: unknown
    try {
      catalogueTransport({ base: new URL(base), token: TOKEN, catalogueFetch: fetch })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    // A refusal never quotes what could be a credential.
    expect(everything(thrown)).not.toContain('pw-canary-secret')
    expect(everything(thrown)).not.toContain(TOKEN)
    expect(sent).toEqual([])
  })

  it('reads loopback as 127.0.0.1, [::1] and localhost, and nothing else', () => {
    for (const url of ['http://127.0.0.1:7007/x', 'http://[::1]:7007/x', 'http://localhost/x', 'http://LOCALHOST/x']) {
      expect(isLoopback(new URL(url)), url).toBe(true)
    }
    for (const url of ['http://127.0.0.2/x', 'http://localhost.evil.example/x', 'http://0.0.0.0/x', 'https://backstage.canary.example/x']) {
      expect(isLoopback(new URL(url)), url).toBe(false)
    }
  })

  it('checks the URL it built, origin and pathname, whatever base it is given', () => {
    // The construction refuses these bases first; the URL is checked on its
    // own all the same, so the guard does not rest on that one.
    for (const base of [
      'https://backstage.canary.example//evil.example/api/catalog',
      'https://backstage.canary.example/',
    ]) {
      expect(() => catalogueUrl(new URL(base), 'entities/by-query', new URLSearchParams()), base).toThrow(TypeError)
    }
    expect(catalogueUrl(BASE, 'entity-facets', new URLSearchParams({ facet: 'kind' })).href).toBe(
      'https://backstage.canary.example/api/catalog/entity-facets?facet=kind',
    )
  })

  it('keeps its own copy of the base: changing the URL it was given later re-aims nothing', async () => {
    const { fetch, sent } = keeping(() => json(EMPTY))
    const base = new URL(BASE.href)
    const transport = catalogueTransport({ base, token: TOKEN, catalogueFetch: fetch })
    base.host = 'evil.example'
    base.pathname = '/steal'
    await transport.request('GET', 'entities/by-query', new URLSearchParams())
    expect(sent[0]!.url).toBe('https://backstage.canary.example/api/catalog/entities/by-query')
  })

  it('throws before any request for a method or a route outside the list', async () => {
    const { fetch, sent } = keeping(() => json(EMPTY))
    const transport = catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch })
    await expect(transport.request('POST' as 'GET', 'entities/by-query', new URLSearchParams())).rejects.toThrow(TypeError)
    await expect(transport.request('GET', 'locations' as CatalogueRoute, new URLSearchParams())).rejects.toThrow(TypeError)
    await expect(transport.request('GET', 'entities' as CatalogueRoute, new URLSearchParams())).rejects.toThrow(TypeError)
    await expect(
      transport.request('GET', '../../entities/by-query' as CatalogueRoute, new URLSearchParams()),
    ).rejects.toThrow(TypeError)
    await expect(
      transport.request('GET', 'entities/by-query', 'limit=1' as unknown as URLSearchParams),
    ).rejects.toThrow(TypeError)
    expect(sent).toEqual([])
  })

  it('keeps the path whatever a query value holds: only URLSearchParams builds the query', async () => {
    const { fetch, sent } = keeping(() => json(EMPTY))
    const hostile = 'kind=../../x?y#z&/%2e%2e/@evil.example'
    await catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch }).request(
      'GET',
      'entities/by-query',
      new URLSearchParams({ filter: hostile }),
    )
    const url = new URL(sent[0]!.url)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/api/catalog/entities/by-query')
    expect(url.hash).toBe('')
    expect([...url.searchParams]).toEqual([['filter', hostile]])
  })

  it('counts what it spent: requests, bytes and time', async () => {
    const body = JSON.stringify(EMPTY)
    const { fetch } = keeping(() => new Response(body))
    const transport = catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch })
    expect(transport.spent).toEqual({ requests: 0, bytes: 0, ms: 0 })
    await transport.request('GET', 'entities/by-query', new URLSearchParams())
    await transport.request('GET', 'entity-facets', new URLSearchParams())
    expect(transport.spent.requests).toBe(2)
    expect(transport.spent.bytes).toBe(2 * Buffer.byteLength(body))
    expect(transport.spent.ms).toBeGreaterThanOrEqual(0)
    // The transport holds the token in a closure: nothing it hands out has it.
    expect(inspect(transport, { depth: 10, showHidden: true })).not.toContain(TOKEN)
    expect(JSON.stringify(transport)).not.toContain(TOKEN)
  })
})

describe('what the transport refuses', () => {
  it.each([301, 302, 303, 307, 308])('refuses a %s without reading its body, naming the origin', async (status) => {
    const body = watched(`{"echo":"Bearer ${TOKEN}"}`)
    const { fetch, sent } = keeping(
      () => new Response(body.stream, { status, headers: { location: 'https://evil.example/steal' } }),
    )
    const error = await failure(fetch)
    expect(error.failure).toEqual({ kind: 'redirect', status })
    expect(error.message).toContain(ORIGIN)
    expect(everything(error)).not.toContain(TOKEN)
    expect(everything(error)).not.toContain('evil.example')
    expect(sent).toHaveLength(1)
    expect(body.pulls()).toBe(0)
    expect(body.cancelled()).toBe(true)
  })

  it("classifies the redirect Node's fetch itself refuses, and does not retry", async () => {
    // With redirect: 'error', undici never hands back a 3xx: it rejects with
    // TypeError('fetch failed', { cause: Error('unexpected redirect') }), a
    // cause with no code (undici lib/web/fetch/index.js,
    // makeNetworkError('unexpected redirect'); response.js wraps the string
    // in an Error).
    const { fetch, sent } = keeping(() => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
    })
    const error = await failure(fetch)
    expect(error.failure).toEqual({ kind: 'redirect', status: undefined })
    expect(error.message).toContain('https://backstage.canary.example')
    expect(sent).toHaveLength(1)
  })

  it('refuses a response whose url is on another origin, or another path, without reading it', async () => {
    for (const elsewhere of ['https://evil.example/api/catalog/entities/by-query', `${ORIGIN}/api/other`]) {
      const body = watched(JSON.stringify(EMPTY))
      const { fetch } = keeping(() => {
        const response = new Response(body.stream)
        Object.defineProperty(response, 'url', { value: elsewhere })
        return response
      })
      const error = await failure(fetch)
      expect(error.failure).toEqual({ kind: 'foreign-response' })
      expect(error.message).toContain(ORIGIN)
      expect(error.message).not.toContain('evil.example')
      expect(body.pulls()).toBe(0)
      expect(body.cancelled()).toBe(true)
    }
  })

  it('refuses a response marked redirected, even from the same address', async () => {
    const { fetch } = keeping((url) => {
      const response = json(EMPTY)
      Object.defineProperty(response, 'url', { value: url.href })
      Object.defineProperty(response, 'redirected', { value: true })
      return response
    })
    const error = await failure(fetch)
    expect(error.failure).toEqual({ kind: 'redirect', status: undefined })
  })

  it('reads a response whose url is the one it sent', async () => {
    const { fetch } = keeping((url) => {
      const response = json(EMPTY)
      Object.defineProperty(response, 'url', { value: url.href })
      return response
    })
    const answer = await catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch }).request(
      'GET',
      'entities/by-query',
      new URLSearchParams({ limit: '250' }),
    )
    expect(answer).toEqual(EMPTY)
  })

  it.each([[400], [401], [403], [404], [405], [500], [502], [503]])(
    'classifies a %s, and quotes nothing of the body',
    async (status) => {
      const body = watched(`echo: Bearer ${TOKEN}`)
      const { fetch, sent } = keeping(() => new Response(body.stream, { status }))
      const error = await failure(fetch)
      expect(error.failure).toEqual({ kind: 'status', status })
      expect(error.message).toContain(ORIGIN)
      expect(error.message).toContain(String(status))
      expect(everything(error)).not.toContain(TOKEN)
      expect(everything(error)).not.toContain('echo')
      expect(body.pulls()).toBe(0)
      expect(sent).toHaveLength(1)
    },
  )

  it('waits a Retry-After of up to 10 s and retries, three times per run at most', async () => {
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms)
    }
    const retryAfter = ['2', '0', '10']
    const { fetch, sent } = keeping((_, __, index) =>
      index < retryAfter.length
        ? new Response('slow down', { status: 429, headers: { 'retry-after': retryAfter[index]! } })
        : json(EMPTY),
    )
    const transport = catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch, sleep })
    expect(await transport.request('GET', 'entities/by-query', new URLSearchParams())).toEqual(EMPTY)
    expect(waits).toEqual([2_000, 0, 10_000])
    expect(sent).toHaveLength(4)
    // Every retry is the same request: the same URL, the one header.
    expect(new Set(sent.map(({ url }) => url)).size).toBe(1)
    for (const { init } of sent) expect(init.redirect).toBe('error')

    // The three are the run's, not the request's: the next 429 is refused.
    // Ten 429s, then an answer: without the run's count, the first request
    // would wait through them and succeed.
    const again = keeping((_, __, index) =>
      index < 10 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : json(EMPTY),
    )
    const spent = catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: again.fetch, sleep })
    for (let request = 0; request < 3; request += 1) {
      await expect(spent.request('GET', 'entity-facets', new URLSearchParams())).rejects.toThrow(CatalogueReadError)
    }
    expect(again.sent).toHaveLength(6)
    const refused = await spent.request('GET', 'entity-facets', new URLSearchParams()).catch((error: unknown) => error)
    expect((refused as CatalogueReadError).failure).toEqual({ kind: 'rate-limited' })
  })

  it('reads a Retry-After given as an HTTP date', async () => {
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms)
    }
    const at = new Date(Date.now() + 5_000).toUTCString()
    const { fetch } = keeping((_, __, index) =>
      index === 0 ? new Response('', { status: 429, headers: { 'retry-after': at } }) : json(EMPTY),
    )
    await catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch, sleep }).request(
      'GET',
      'entities/by-query',
      new URLSearchParams(),
    )
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(3_000)
    expect(waits[0]).toBeLessThanOrEqual(5_000)
  })

  it('refuses a 429 with no Retry-After, an unreadable one or one over 10 s, naming the rate limit', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString()
    for (const header of [undefined, 'soon', '1.5', '-1', '11', '99999999999999999999', at]) {
      const sleep = vi.fn(async () => undefined)
      const { fetch, sent } = keeping(
        () => new Response('', { status: 429, headers: header === undefined ? {} : { 'retry-after': header } }),
      )
      const error = await failure(fetch, { sleep })
      expect(error.failure, String(header)).toEqual({ kind: 'rate-limited' })
      expect(error.message).toContain('429')
      expect(error.message).toContain(ORIGIN)
      expect(sleep).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
    }
  })

  it('refuses a body over the bound while it streams, and stops reading it', async () => {
    const body = watched(...Array.from({ length: 64 }, () => new Uint8Array(512).fill(0x20)))
    const { fetch } = keeping(() => new Response(body.stream))
    const error = await failure(fetch, { limits: { bytesPerResponse: 1024 } })
    expect(error.failure).toEqual({ kind: 'too-large', scope: 'response', limit: 1024 })
    expect(error.message).toContain(ORIGIN)
    // Three chunks of 512 cross 1024; nothing after them is asked for.
    expect(body.pulls()).toBe(3)
    expect(body.cancelled()).toBe(true)
  })

  it('refuses a run past its byte bound across requests', async () => {
    const body = JSON.stringify({ padding: 'x'.repeat(780) })
    const { fetch } = keeping(() => new Response(body))
    const transport = catalogueTransport({
      base: BASE,
      token: TOKEN,
      catalogueFetch: fetch,
      limits: { bytesPerResponse: 1024, bytesPerRun: 1500 },
    })
    await transport.request('GET', 'entities/by-query', new URLSearchParams())
    const error = await transport.request('GET', 'entities/by-query', new URLSearchParams()).catch((e: unknown) => e)
    expect((error as CatalogueReadError).failure).toEqual({ kind: 'too-large', scope: 'run', limit: 1500 })
  })

  it('bounds at the constants of limits.ts unless told otherwise', () => {
    expect(BACKSTAGE_LIMITS).toEqual({
      pageSize: 250,
      modelledEntities: 20_000,
      otherRefs: 200_000,
      bytesPerResponse: 32 * 1024 * 1024,
      bytesPerRun: 256 * 1024 * 1024,
      requestMs: 15_000,
      loadMs: 120_000,
      retryAfterMs: 10_000,
      retriesPerRun: 3,
      jsonDepth: 64,
    })
  })

  it('refuses a body that is not JSON, or not UTF-8', async () => {
    const bodies: ConstructorParameters<typeof Response>[0][] = [
      'not json',
      '',
      new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), // {"a":"<0xff>"}
    ]
    for (const body of bodies) {
      const { fetch } = keeping(() => new Response(body))
      const error = await failure(fetch)
      expect(error.failure).toEqual({ kind: 'not-json' })
      expect(error.message).toContain(ORIGIN)
      expect(error.message).not.toContain('not json')
    }
  })

  it('refuses a request that outlives its bound, naming the origin', async () => {
    const { fetch, sent } = keeping(
      (_, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const error = await failure(fetch, { limits: { requestMs: 20 } })
    expect(error.failure).toEqual({ kind: 'timeout', scope: 'request', limit: 20 })
    expect(error.message).toContain(ORIGIN)
    expect(sent).toHaveLength(1)
  })

  it('refuses a body that stops arriving, within the same bound', async () => {
    // Headers came, then nothing: the bound covers the body, not only the
    // wait for the headers, whatever the fetch it was handed does with the
    // signal.
    const hanging = new ReadableStream<Uint8Array>(
      { pull: () => new Promise(() => undefined) },
      { highWaterMark: 0 },
    )
    const { fetch } = keeping(() => new Response(hanging))
    const error = await failure(fetch, { limits: { requestMs: 20 } })
    expect(error.failure).toEqual({ kind: 'timeout', scope: 'request', limit: 20 })
  })

  it('refuses a request whose headers never come, whatever the fetch does with the signal', async () => {
    // The wait for the headers is raced against the signal, as the body is:
    // the bound does not rest on the `fetch` it was handed watching it. A
    // response that comes after the bound is let go unread.
    const late = watched('{}')
    let answer = (_: Response): void => undefined
    const { fetch, sent } = keeping(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
    )
    const started = performance.now()
    const error = await failure(fetch, { limits: { requestMs: 20 } })
    expect(error.failure).toEqual({ kind: 'timeout', scope: 'request', limit: 20 })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(sent).toHaveLength(1)
    answer(new Response(late.stream))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(late.pulls()).toBe(0)
    expect(late.cancelled()).toBe(true)
  })

  it("ends a 429's wait when the load's signal fires, naming the load's bound", async () => {
    // The load's bound covers every wait of a 429 (limits.ts), not only the
    // requests either side of one.
    const load = new AbortController()
    const sleep = vi.fn(
      () =>
        new Promise<void>(() => {
          load.abort(new DOMException('the load is over', 'TimeoutError'))
        }),
    )
    const { fetch, sent } = keeping(() => new Response('', { status: 429, headers: { 'retry-after': '10' } }))
    const error = await failure(fetch, { sleep, signal: load.signal })
    expect(error.failure).toEqual({ kind: 'timeout', scope: 'load', limit: BACKSTAGE_LIMITS.loadMs })
    expect(sleep).toHaveBeenCalledWith(10_000)
    expect(sent).toHaveLength(1)
  })

  it("names the load's own bound when the load's signal ends a request, and sends nothing once it has", async () => {
    const load = new AbortController()
    const { fetch, sent } = keeping(
      (_, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          load.abort(new DOMException('the load is over', 'TimeoutError'))
        }),
    )
    const error = await failure(fetch, { signal: load.signal })
    expect(error.failure).toEqual({ kind: 'timeout', scope: 'load', limit: BACKSTAGE_LIMITS.loadMs })
    expect(sent).toHaveLength(1)

    const after = await failure(fetch, { signal: load.signal })
    expect(after.failure).toEqual({ kind: 'timeout', scope: 'load', limit: BACKSTAGE_LIMITS.loadMs })
    expect(sent).toHaveLength(1)
  })

  it('classifies an unreachable host by its code alone', async () => {
    const cases: [unknown, string][] = [
      [new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: `Bearer ${TOKEN}` } }), 'ECONNREFUSED'],
      [new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ${TOKEN}`), { code: 'ENOTFOUND' }) }), 'ENOTFOUND'],
      [new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) }), 'CERT_HAS_EXPIRED'],
      // A code that is not one is not quoted: its class is.
      [new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: `Bearer ${TOKEN}` }) }), 'Error'],
      [new RangeError(`Bearer ${TOKEN}`), 'RangeError'],
      [`Bearer ${TOKEN}`, 'string'],
    ]
    for (const [thrown, cause] of cases) {
      const { fetch } = keeping(() => {
        throw thrown
      })
      const error = await failure(fetch)
      expect(error.failure).toEqual({ kind: 'unreachable', cause })
      expect(error.message).toContain(ORIGIN)
      expect(everything(error)).not.toContain(TOKEN)
    }
  })

  it('never puts the token in an error, whatever the failure', async () => {
    const answers: (() => Response)[] = [
      () => new Response(`Bearer ${TOKEN}`, { status: 401 }),
      () => new Response(`Bearer ${TOKEN}`, { status: 302, headers: { location: `https://evil.example/${TOKEN}` } }),
      () => new Response(`Bearer ${TOKEN}`, { status: 429, headers: { 'retry-after': TOKEN } }),
      () => new Response(`Bearer ${TOKEN} is not JSON`),
      () => {
        throw new Error(`Bearer ${TOKEN}`)
      },
    ]
    for (const answer of answers) {
      const error = await failure(keeping(answer).fetch)
      expect(everything(error)).not.toContain(TOKEN)
      expect(everything(error.failure)).not.toContain(TOKEN)
      // No cause is kept: a cause is a way for a message the transport did
      // not write to reach whoever prints the error.
      expect(error.cause).toBeUndefined()
    }
  })
})
