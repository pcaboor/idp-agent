import { BACKSTAGE_TOKEN_VARIABLE } from '../../process/environment.js'
import type { CacheRefusal, ReadScope } from '../provider.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from './limits.js'

/**
 * The one function that sends a catalogue token (docs/backstage-http-brief.md
 * § 4). Everything a request carries is decided here, and each guard is proven
 * by `tests/unit/backstage-transport.test.ts` against an injected `fetch`:
 *
 *   - a closed list of (method, route) pairs, and no path segment built from
 *     anything else — the only variable part is a query `URLSearchParams`
 *     encodes;
 *   - the URL's origin and pathname checked, once built, before the header is
 *     attached;
 *   - `redirect: 'error'`, and a 3xx, a response marked redirected or one
 *     whose `url` is another address refused as well, so the guard does not
 *     rest on the `fetch` it was handed;
 *   - every body counted while it streams, per response and per run, and
 *     every request bounded in time, the wait for its headers and its body
 *     both raced against the bound;
 *   - a 429 waited for when it says how long, within bounds, the wait ended
 *     by the load's own signal;
 *   - no error that quotes a response, a header, a cause or the token.
 *
 * The token is a value cli/ reads from the environment and hands over; it is
 * held in a closure, never in a field of what this module returns or throws.
 * The `fetch` is handed over too: nothing in context/ names the global
 * (`tests/architecture/dependencies.test.ts`). `BackstageProvider` builds it
 * and the load (`load.ts`) sends through it; cli/ constructs the provider,
 * handing it the token and the `fetch` (`providerOf`).
 */

/** The requests the catalogue is ever sent: both read entities, and both check `catalog.entity.read` alone. */
export const CATALOGUE_REQUESTS = [
  ['GET', 'entities/by-query'],
  ['GET', 'entity-facets'],
] as const

export type CatalogueRoute = (typeof CATALOGUE_REQUESTS)[number][1]

/**
 * The only variable the token is read from. cli/ reads it; no child process is
 * handed it. Declared in `process/environment.ts`, beside the function that
 * keeps it out of every child, and re-exported here for everything that reads it.
 */
export { BACKSTAGE_TOKEN_VARIABLE }

/** The hosts `http:` may reach, and that need no token: this machine, by the three names the note allows. */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

export function isLoopback(url: URL): boolean {
  return LOOPBACK.has(url.hostname)
}

/** Which of a load's three reads a failure is about: declared beside `LoadResult`, and re-exported for this layer's importers. */
export type { ReadScope }

/**
 * Why a read ended. Each case carries what a person needs to act on it, and
 * nothing a server wrote: a status, a class, a code, a bound.
 */
export type CatalogueFailure =
  /** DNS, a refused connection, TLS: the error's code alone, or its class when it has none. */
  | { readonly kind: 'unreachable'; readonly cause: string }
  /** A request past its bound, or the load's own signal ended it; the bound is stated. */
  | { readonly kind: 'timeout'; readonly scope: 'request' | 'load'; readonly limit: number }
  /** 401, 403, 404, 5xx: any status outside 2xx but a 3xx and a 429. */
  | { readonly kind: 'status'; readonly status: number }
  /** A 3xx; `undefined` when the `fetch` refused the redirect itself, or followed one. */
  | { readonly kind: 'redirect'; readonly status: number | undefined }
  /** An answer from another address than the one asked. */
  | { readonly kind: 'foreign-response' }
  /** A 429 with no `Retry-After` this reads, one too long, or past the run's retries. */
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'too-large'; readonly scope: 'response' | 'run'; readonly limit: number }
  /** A body that is not UTF-8, or not JSON. */
  | { readonly kind: 'not-json' }
  // The load's own (load.ts): what a server that does not page as Backstage does serves is not answered from.
  /** JSON that is not what the route serves: the facets, or the page envelope `{ items, totalItems, pageInfo }`. */
  | { readonly kind: 'not-envelope'; readonly route: CatalogueRoute }
  /** A kind the facets name that the kind grammar refuses: a filter is never built from it. */
  | { readonly kind: 'facets-kind' }
  /** A `nextCursor` already seen: the catalogue would page forever. */
  | { readonly kind: 'same-page' }
  /** An item with no string `metadata.uid`: a read whose items cannot be counted cannot be proved whole. */
  | { readonly kind: 'no-uid' }
  /** An item whose kind its read's filters did not name: a server that ignores `filter` does not page as Backstage does. */
  | { readonly kind: 'unasked-kind'; readonly scope: ReadScope }
  /** Fewer distinct uids than the first page's `totalItems`, repeats or not. */
  | { readonly kind: 'changed'; readonly expected: number; readonly read: number }
  // The store's (cache.ts): a read that was to answer from a kept copy alone.
  /** A kept read — which never asks the catalogue — and no copy read with this token verifies. */
  | { readonly kind: 'not-kept' }

/** A size in the unit it was set in: MiB when it is a whole number of them, bytes otherwise. */
const sizeOf = (bytes: number): string =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`

const secondsOf = (ms: number): string => `${ms / 1000} s`

/** A count as the note writes one: `20,000`. */
const countOf = (count: number): string => count.toLocaleString('en-US')

/** What a status says, in words, beside its number. */
const statusClass = (status: number): string => {
  if (status === 401) return 'the token was refused'
  if (status === 403) return 'the token may not read the catalogue'
  if (status === 404) return 'no catalogue API at this address'
  if (status >= 500) return 'the server failed'
  return 'the request was refused'
}

/** The sentence a failure is, naming the origin and nothing a server wrote. */
function sentenceOf(failure: CatalogueFailure, origin: string): string {
  const at = `the catalogue at ${origin}`
  switch (failure.kind) {
    case 'unreachable':
      return `${at} could not be reached (${failure.cause})`
    case 'timeout':
      return failure.scope === 'request'
        ? `${at} did not answer a request within ${secondsOf(failure.limit)}`
        : `${at} was not read within ${secondsOf(failure.limit)}, the time a load is given`
    case 'status':
      return `${at} answered ${failure.status} (${statusClass(failure.status)})`
    case 'redirect':
      return failure.status === undefined
        ? `${at} answered with a redirect, which is never followed`
        : `${at} answered with a redirect (${failure.status}), which is never followed`
    case 'foreign-response':
      return `${at} answered from another address than the one asked, which is refused`
    case 'rate-limited':
      return `${at} limited the rate of requests (429) past what a run waits for`
    case 'too-large':
      return failure.scope === 'response'
        ? `${at} sent a response larger than ${sizeOf(failure.limit)}`
        : `${at} sent more than ${sizeOf(failure.limit)} in one run`
    case 'not-json':
      return `${at} answered with a body that is not UTF-8 JSON`
    case 'not-envelope':
      return `${at} answered ${failure.route} with a body that is not what the route serves`
    case 'facets-kind':
      return `${at} named a kind this tool cannot put in a filter, which is refused`
    case 'same-page':
      return `${at} returned the same page twice`
    case 'no-uid':
      return `${at} served an entity with no metadata.uid, so the read cannot be proved whole`
    case 'unasked-kind':
      return `${at} served an entity of a kind the read did not ask for, so it does not filter as Backstage does`
    case 'changed':
      return `${at} changed while it was read (${countOf(failure.expected)} expected, ${countOf(failure.read)} read)`
    case 'not-kept':
      return `${at} has no copy kept on this machine that verifies, and a kept read never asks it`
    default: {
      const exhaustive: never = failure
      return exhaustive
    }
  }
}

/**
 * A read that ended, exit 1 once cli/ renders it (`catalogueFailureLine`). The message is built
 * from the failure and the origin alone (`scheme://host:port`), and no cause
 * is kept: a cause is a way for a message this module did not write — a
 * server's echo of the request's headers, say — to reach whoever prints it.
 */
export class CatalogueReadError extends Error {
  constructor(
    readonly failure: CatalogueFailure,
    readonly origin: string,
    /**
     * A copy of this catalogue kept on this machine that verifies, said after
     * a failure of reach (`BackstageProvider`) so the person can be pointed at
     * it; its age undefined when it is dated after this clock's now. Never set
     * after a 401 or a 403, which may be a revoked token.
     */
    readonly kept?: { readonly ageMs: number | undefined },
    /**
     * On a `not-kept` failure: why the copy kept was not read — a store that
     * could not be used, or a copy that did not verify — so the person is told
     * what to look at. Absent when there was simply none.
     */
    readonly notUsed?: CacheRefusal,
  ) {
    super(sentenceOf(failure, origin))
    this.name = 'CatalogueReadError'
  }
}

export interface CatalogueTransport {
  request(method: 'GET', route: CatalogueRoute, query: URLSearchParams): Promise<unknown>
  /** What the run has spent so far, for the census (1.4). */
  readonly spent: { readonly requests: number; readonly bytes: number; readonly ms: number }
  /** `scheme://host:port`, which a failure of the load names as this module's do. */
  readonly origin: string
}

/**
 * The function the transport sends with. A type of its own, not the global's:
 * no file in context/ names the global, not even in a type. The global is
 * assignable to it, and cli/ hands it over.
 */
export type CatalogueFetch = (url: URL, init: RequestInit) => Promise<Response>

/**
 * A token as a header carries it: visible ASCII, no space. Anything else would
 * make `Headers` throw with the value in its message, and that message would
 * reach stderr; this refusal says what is wrong and not what it is.
 */
const HEADER_TOKEN = /^[\x21-\x7e]+$/

/** Whether a header can carry `token` (`HEADER_TOKEN`): `cli/source.ts` refuses one it cannot, exit 2, before any request. */
export const headerCarries = (token: string): boolean => HEADER_TOKEN.test(token)

/** One or more non-empty segments, and no trailing slash: the base, stated exactly. */
const BASE_PATH = /^(\/[^/]+)+$/

/**
 * Why `base` cannot be a catalogue's, or undefined when it can. cli/ checks
 * the URL as the person typed it (`catalogueBase`); this is the same rule on the parsed
 * one, again, because the transport exists two pull requests before
 * `catalogueBase` and must not rest on it. No reason quotes the URL: its
 * userinfo, query or fragment is where a credential would be.
 */
function refusedBase(base: URL): string | undefined {
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopback(base))) {
    return 'is neither https: nor http: to 127.0.0.1, [::1] or localhost'
  }
  if (base.username !== '' || base.password !== '') return 'holds userinfo'
  if (base.search !== '') return 'holds a query'
  if (base.hash !== '') return 'holds a fragment'
  if (!BASE_PATH.test(base.pathname)) {
    return 'does not have a path of one or more non-empty segments, with no trailing slash'
  }
  return undefined
}

/**
 * `Retry-After` as a wait, or undefined when it cannot be read: a number of
 * seconds, or an IMF-fixdate, the HTTP-date a server sends. The two obsolete
 * date forms are not read; a header this does not read is refused, never
 * guessed at.
 */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** A code as Node's errors write one, and a class name; anything else is not quoted. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Why a request that never answered failed: the error's `code`, or its
 * cause's, when it is one; otherwise the class of the cause, or of what was
 * thrown. Never a message: a message is text the transport did not write.
 */
function causeOf(thrown: unknown): string {
  const cause = (thrown as { cause?: unknown } | null | undefined)?.cause
  for (const candidate of [thrown, cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code
  }
  for (const candidate of [cause, thrown]) {
    if (candidate instanceof Error) {
      const name = candidate.constructor.name
      return CLASS_NAME.test(name) ? name : 'Error'
    }
  }
  return typeof thrown
}

/**
 * What undici rejects with under `redirect: 'error'`: a TypeError whose cause
 * is an Error saying `unexpected redirect`, with no code
 * (lib/web/fetch/index.js, makeNetworkError).
 */
const isRefusedRedirect = (thrown: unknown): boolean =>
  thrown instanceof TypeError && thrown.cause instanceof Error && thrown.cause.message === 'unexpected redirect'

/** Lets a body go without reading any of it. */
const discard = (response: Response): void => {
  response.body?.cancel().catch(() => undefined)
}

/**
 * `pending`, or `timedOut()` as soon as `signal` fires, whichever comes first;
 * and `timedOut()` when `pending` fails once the signal has fired. A bound
 * that does not rest on what it bounds watching the signal.
 */
async function raced<T>(pending: Promise<T>, signal: AbortSignal, timedOut: () => Error): Promise<T> {
  let onAbort = (): void => undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(timedOut())
  })
  aborted.catch(() => undefined)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } catch (thrown) {
    if (signal.aborted) throw timedOut()
    throw thrown
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Whether a response's `url` is the address that was asked: the same origin and path. */
function sameAddress(answered: string, asked: URL): boolean {
  try {
    const url = new URL(answered)
    return url.origin === asked.origin && url.pathname === asked.pathname
  } catch {
    return false
  }
}

/**
 * The URL of `route` under `base`, or a TypeError. The only variable part is
 * the query, which `URLSearchParams` encodes. Once built, its origin and
 * pathname are checked against the base's, before any header exists: a base
 * whose path starts with `//`, rebuilt from its parts, names another host,
 * and the construction's own check is not the only thing that says so.
 */
export function catalogueUrl(base: URL, route: CatalogueRoute, query: URLSearchParams): URL {
  if (!(query instanceof URLSearchParams)) throw new TypeError('a catalogue query is a URLSearchParams')
  const pathname = `${base.pathname}/${route}`
  const url = new URL(pathname, base.origin)
  url.search = query.toString()
  if (url.origin !== base.origin || url.pathname !== pathname) {
    throw new TypeError(`${route} does not stay under the catalogue base`)
  }
  return url
}

/**
 * Throws a TypeError, before any request, for a base that is not https: or
 * loopback http:, holds userinfo, a query or a fragment, or whose pathname is
 * not one or more non-empty segments; for a base that is not loopback and no
 * token; and for a token a header cannot carry.
 */
export function catalogueTransport(options: {
  /** Checked by cli/ (`catalogueBase`); checked again here, at construction. */
  base: URL
  /** A value, never read from the environment here. */
  token: string | undefined
  /** Injected by cli/, never defaulted here. */
  catalogueFetch: CatalogueFetch
  limits?: Partial<BackstageLimits>
  sleep?: (ms: number) => Promise<void>
  /** The load's own timeout (1.4). */
  signal?: AbortSignal
}): CatalogueTransport {
  // A copy: the URL handed over is the caller's object, and changing it
  // afterwards must re-aim nothing.
  const base = new URL(options.base.href)
  const refused = refusedBase(base)
  if (refused !== undefined) throw new TypeError(`the catalogue base ${refused}`)

  const token = options.token === '' ? undefined : options.token
  if (token === undefined && !isLoopback(base)) {
    throw new TypeError(`a catalogue that is not on this machine is read with a token, in ${BACKSTAGE_TOKEN_VARIABLE}`)
  }
  if (token !== undefined && !headerCarries(token)) {
    throw new TypeError(`the value of ${BACKSTAGE_TOKEN_VARIABLE} holds a character a header cannot carry`)
  }

  const limits: BackstageLimits = { ...BACKSTAGE_LIMITS, ...options.limits }
  // The default wait clears its timer when the load ends, so a load that is
  // over leaves nothing pending behind it.
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        options.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })
      }))
  const origin = base.origin
  const fail = (failure: CatalogueFailure): CatalogueReadError => new CatalogueReadError(failure, origin)
  const loadOver = (): CatalogueReadError => fail({ kind: 'timeout', scope: 'load', limit: limits.loadMs })

  let requests = 0
  let bytes = 0
  let ms = 0
  let retries = 0

  /**
   * The body, counted while it streams, then decoded and parsed. Each read
   * races the signal: a `fetch` that stops watching it once the headers came,
   * or a body that stops arriving, still ends at the bound.
   */
  async function bodyOf(
    response: Response,
    signal: AbortSignal,
    timedOut: () => CatalogueReadError,
  ): Promise<unknown> {
    const chunks: Uint8Array[] = []
    let size = 0
    if (response.body !== null) {
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await raced(reader.read(), signal, timedOut)
          if (done) break
          if (!(value instanceof Uint8Array)) throw fail({ kind: 'not-json' })
          size += value.byteLength
          bytes += value.byteLength
          if (size > limits.bytesPerResponse) {
            throw fail({ kind: 'too-large', scope: 'response', limit: limits.bytesPerResponse })
          }
          if (bytes > limits.bytesPerRun) throw fail({ kind: 'too-large', scope: 'run', limit: limits.bytesPerRun })
          chunks.push(value)
        }
      } catch (thrown) {
        reader.cancel().catch(() => undefined)
        if (thrown instanceof CatalogueReadError) throw thrown
        // The stream failed under the read: the connection.
        throw fail({ kind: 'unreachable', cause: causeOf(thrown) })
      }
    }
    const whole = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      whole.set(chunk, at)
      at += chunk.byteLength
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(whole))
    } catch {
      throw fail({ kind: 'not-json' })
    }
  }

  /** One request, and its body read: the JSON, a 429 for the caller to wait on, or the failure it ended on. */
  async function once(method: 'GET', url: URL): Promise<{ readonly json: unknown } | { readonly limited: Response }> {
    if (options.signal?.aborted === true) throw loadOver()
    const requestSignal = AbortSignal.timeout(limits.requestMs)
    const signal = options.signal === undefined ? requestSignal : AbortSignal.any([requestSignal, options.signal])
    const timedOut = (): CatalogueReadError =>
      options.signal?.aborted === true
        ? loadOver()
        : fail({ kind: 'timeout', scope: 'request', limit: limits.requestMs })

    // Built here, after the URL was checked, and nowhere else.
    const headers = new Headers({ accept: 'application/json' })
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`)

    const started = performance.now()
    requests += 1
    try {
      // The wait for the headers races the signal too: the bound does not
      // rest on the `fetch` watching it. A response that comes after the
      // bound is let go unread.
      const answering = (async () => options.catalogueFetch(url, { method, headers, redirect: 'error', signal }))()
      let response: Response
      try {
        response = await raced(answering, signal, timedOut)
      } catch (thrown) {
        if (signal.aborted) {
          answering.then(discard, () => undefined)
          throw timedOut()
        }
        if (isRefusedRedirect(thrown)) throw fail({ kind: 'redirect', status: undefined })
        throw fail({ kind: 'unreachable', cause: causeOf(thrown) })
      }

      if (response.status >= 300 && response.status < 400) {
        discard(response)
        throw fail({ kind: 'redirect', status: response.status })
      }
      if (response.url !== '' && !sameAddress(response.url, url)) {
        discard(response)
        throw fail({ kind: 'foreign-response' })
      }
      if (response.redirected) {
        discard(response)
        throw fail({ kind: 'redirect', status: undefined })
      }
      if (response.status === 429) {
        discard(response)
        return { limited: response }
      }
      if (response.status < 200 || response.status > 299) {
        discard(response)
        throw fail({ kind: 'status', status: response.status })
      }
      return { json: await bodyOf(response, signal, timedOut) }
    } finally {
      ms += performance.now() - started
    }
  }

  return {
    async request(method, route, query) {
      // A programming error, never a run's failure: the list is closed.
      if (!CATALOGUE_REQUESTS.some(([known, name]) => known === method && name === route)) {
        throw new TypeError(`${String(method)} ${String(route)} is not a request the catalogue is sent`)
      }
      const url = catalogueUrl(base, route, query)

      for (;;) {
        const answered = await once(method, url)
        if ('json' in answered) return answered.json
        // A 429: waited for when it says how long, within the bound, while the
        // run has retries left; refused at once otherwise.
        const wait = retryAfterMs(answered.limited.headers.get('retry-after'), Date.now())
        if (wait === undefined || wait > limits.retryAfterMs || retries >= limits.retriesPerRun) {
          throw fail({ kind: 'rate-limited' })
        }
        retries += 1
        // The load's bound covers the wait as well as the requests.
        await (options.signal === undefined ? sleep(wait) : raced(sleep(wait), options.signal, loadOver))
      }
    },
    get spent() {
      return { requests, bytes, ms }
    },
    origin,
  }
}
