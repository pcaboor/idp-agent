import type { CatalogueFetch } from '../../src/context/backstage/transport.js'
import { handler } from '../../tools/fake-backstage.js'

/**
 * The fake Backstage of `tools/fake-backstage.ts` as the `fetch` a test hands
 * the transport: in process, no socket (the offline setup would throw on
 * one). Every request is kept in `sent`, and `faults` make it answer what a
 * catalogue, a proxy or a network can do wrong, on the request they name.
 *
 * Every test above the transport reads a catalogue through this, so the
 * checks of the load are proven against the paging a real Backstage does,
 * not against answers written for the case.
 */

export type FakeOptions = Parameters<typeof handler>[0]

/** A request as the fake received it. Headers as `Headers` names them, lower case. */
export interface Sent {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly redirect: RequestInit['redirect']
  readonly body: string | undefined
}

/** Which request a fault is on: its index among every request sent, from 0. */
interface At {
  readonly at: number
}

export interface Faults {
  /** A status instead of the answer, with its headers: a 401, a 429 with `Retry-After`, a 302 with a `location`. */
  readonly status?: At & { readonly status: number; readonly headers?: Record<string, string> }
  /** The answer, marked as coming from `url`. */
  readonly responseUrl?: At & { readonly url: string }
  /** A body that repeats the request's headers back. */
  readonly echoHeaders?: At
  /** No answer until the signal ends the wait. */
  readonly hang?: At
  /** A body that is not JSON. */
  readonly notJson?: At
  /** A body of `size` bytes. */
  readonly bytes?: At & { readonly size: number }
  /** A page that is not the envelope `{ items, totalItems, pageInfo }`. */
  readonly notEnvelope?: At
  /** The page after the first answers with the first page's `nextCursor` again. */
  readonly sameCursorTwice?: true
  /** Every page's `nextCursor` is this, and a request carrying it gets an empty page with it again. */
  readonly nextCursor?: string
  /**
   * The last item of a read's first page is served again at the head of its
   * second page; with `leaveOut`, the second page's last item is left out as
   * well — a read with a repeat and a gap.
   */
  readonly repeatUid?: { readonly leaveOut: boolean }
  /** The first item of the first page of `entities/by-query` has no `metadata.uid`. */
  readonly noUid?: true
  /** `totalItems` above what is served, by this many, on every page of every read. */
  readonly totalItemsAbove?: number
  /** Kinds the facets leave out, though the catalogue serves them. */
  readonly facetsOmit?: readonly string[]
  /** Items served in the reverse of the catalogue's order, page by page. */
  readonly reverse?: true
  /** An item added at the end of the page answered to request `at`: one the read did not ask for, or a uid another read served. */
  readonly extraItem?: At & { readonly item: Record<string, unknown> }
}

const abortError = (): Error => new DOMException('This operation was aborted', 'AbortError')

/** A promise that settles only when `signal` ends it. */
const hanging = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_, reject) => {
    if (signal === null || signal === undefined) return
    if (signal.aborted) reject(abortError())
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

interface Envelope {
  items: Record<string, unknown>[]
  totalItems: number
  pageInfo: { nextCursor?: string }
}

export function fakeBackstage(options: FakeOptions & { faults?: Faults }): { fetch: CatalogueFetch; sent: Sent[] } {
  const { faults = {}, ...served } = options
  const serve = handler(served)
  const sent: Sent[] = []
  // What the paging faults remember between requests.
  let firstCursor: string | undefined
  let repeatNext: Record<string, unknown> | undefined
  let queries = 0

  /** The handler's page, with the paging faults applied. */
  async function page(request: Request, response: Response, index: number): Promise<Response> {
    queries += 1
    const cursor = new URL(request.url).searchParams.get('cursor')
    if (faults.nextCursor !== undefined && cursor === faults.nextCursor) {
      return json({ items: [], totalItems: 0, pageInfo: { nextCursor: faults.nextCursor } })
    }
    if (response.status !== 200) return response
    const body = (await response.json()) as Envelope
    if (faults.sameCursorTwice === true) {
      if (cursor === null) firstCursor = body.pageInfo.nextCursor
      else if (cursor === firstCursor) body.pageInfo.nextCursor = firstCursor
    }
    if (faults.nextCursor !== undefined) body.pageInfo.nextCursor = faults.nextCursor
    if (faults.repeatUid !== undefined) {
      if (cursor === null) {
        repeatNext = body.items.at(-1)
      } else if (repeatNext !== undefined) {
        if (faults.repeatUid.leaveOut) body.items.pop()
        body.items.unshift(repeatNext)
        repeatNext = undefined
      }
    }
    if (faults.noUid === true && queries === 1) {
      const [first] = body.items
      if (first !== undefined) {
        const metadata = { ...(first['metadata'] as Record<string, unknown>) }
        delete metadata['uid']
        body.items[0] = { ...first, metadata }
      }
    }
    if (faults.totalItemsAbove !== undefined) body.totalItems += faults.totalItemsAbove
    if (faults.reverse === true) body.items.reverse()
    if (faults.extraItem?.at === index) body.items.push(structuredClone(faults.extraItem.item))
    return json(body)
  }

  /** The handler's facets, with the kinds `facetsOmit` names left out. */
  async function facets(response: Response): Promise<Response> {
    if (faults.facetsOmit === undefined || response.status !== 200) return response
    const body = (await response.json()) as { facets: { kind: { value: string }[] } }
    const omitted = new Set(faults.facetsOmit.map((kind) => kind.toLowerCase()))
    body.facets.kind = body.facets.kind.filter(({ value }) => !omitted.has(value.toLowerCase()))
    return json(body)
  }

  const fetch: CatalogueFetch = async (url, init) => {
    const request = new Request(url, init)
    const index = sent.length
    sent.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      redirect: init.redirect,
      body: typeof init.body === 'string' ? init.body : undefined,
    })
    const on = (fault: At | undefined): boolean => fault?.at === index
    if (init.signal?.aborted === true) throw abortError()
    if (on(faults.hang)) return hanging(init.signal)
    if (faults.status !== undefined && on(faults.status)) {
      return new Response(null, { status: faults.status.status, headers: faults.status.headers ?? {} })
    }
    if (on(faults.echoHeaders)) return json({ headers: Object.fromEntries(request.headers) })
    if (on(faults.notJson)) return new Response('<html>not a catalogue</html>', { status: 200 })
    if (faults.bytes !== undefined && on(faults.bytes)) return new Response(new Uint8Array(faults.bytes.size), { status: 200 })
    if (on(faults.notEnvelope)) return json({ entities: [] })

    const answered = await serve(request)
    const response = url.pathname.endsWith('/entity-facets') ? await facets(answered) : await page(request, answered, index)
    if (faults.responseUrl !== undefined && on(faults.responseUrl)) {
      Object.defineProperty(response, 'url', { value: faults.responseUrl.url })
    }
    return response
  }

  return { fetch, sent }
}
