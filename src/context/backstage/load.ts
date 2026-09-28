import { z } from 'zod'
import { ORGANISATION_KINDS, type OrganisationKind } from '../../core/schemas/entity.js'
import type { Census } from '../provider.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from './limits.js'
import {
  CatalogueReadError,
  type CatalogueFailure,
  type CatalogueTransport,
  type ReadScope,
} from './transport.js'

/**
 * The load (docs/backstage-http-brief.md § 6): a whole catalogue, or a
 * `CatalogueReadError` and nothing. A partial read is refused, never answered
 * from — a reference left unloaded would read as declared nowhere.
 *
 *   1. `entity-facets?facet=kind` names every kind the token sees. A kind is
 *      a filter's value only when the kind grammar allows it: `,` and `=` are
 *      the filter grammar, and a filter is never built from other text.
 *   2. Components, Resources and APIs are read whole, **always** — a facets
 *      answer that omitted one would otherwise leave an empty graph that is
 *      answered from. Groups, Users, Systems and Domains, those the facets
 *      name, are read for the fields the read model reads of them and
 *      nothing else (`ORGANISATION_FIELDS`), and only when the facets name
 *      one: a catalogue with none is sent the requests it always was. Every
 *      other kind the facets name is read as refs (`fields`).
 *   3. Pages follow `pageInfo.nextCursor`. Backstage's cursor carries the
 *      filter, the order and `totalItems`, and reads `limit` and `fields`
 *      from each request (`parseQueryEntitiesParams.ts`, `createRouter.ts`),
 *      so each next page sends the cursor, `limit` and the same `fields`, and
 *      never `filter`. The cursor is only ever a query value, sent to the
 *      base; one seen before is refused.
 *   4. Every item holds a string `metadata.uid`, or the read cannot be
 *      counted and is refused, and a kind its read's filters named, or the
 *      server ignored `filter` and is refused: a whole entity served in the
 *      refs read would pass the modelled ceiling. A uid seen before, in
 *      any read, is kept once and counted, so `census.served` is the
 *      distinct uids of every read. At the end of a read, fewer distinct
 *      uids than the first page's `totalItems` is refused, repeats or not:
 *      Backstage pages by keyset on
 *      `entity_id`, which an update does not change, so a legitimate read
 *      never repeats one, and a read that repeats one and misses another
 *      would otherwise pass (the plan's Choices; it amends the note's table).
 *      Each read's ceiling is checked as items arrive, and against
 *      `totalItems` on a read's first page.
 *   5. The load's own time is the transport's: `BackstageProvider` hands it
 *      one `AbortSignal.timeout(loadMs)`.
 */

/** What a catalogue served: the modelled kinds whole, the organisation, the others as refs, and what it cost. */
export interface Served {
  readonly whole: unknown[]
  /** Groups, Users, Systems and Domains, for the fields the read model reads. */
  readonly organisation: unknown[]
  readonly refs: unknown[]
  /**
   * The organisation kinds the facets named, as `ORGANISATION_KINDS` spells
   * them: each was read to the end, or the load failed. What a reference to
   * one of them is judged against (`EntityGraph`), and nothing else is.
   */
  readonly judged: OrganisationKind[]
  readonly census: Census
}

/** Backstage's kind grammar: nothing a filter's `,` or `=` could hide in. */
const KIND = /^[A-Za-z][A-Za-z0-9]*$/

/** The kinds read whole: the two this tool models, and the API it reads. */
const MODELLED = ['component', 'resource', 'api'] as const

/** The organisation, by the lower-case kind a filter names. */
const ORGANISATION: ReadonlyMap<string, OrganisationKind> = new Map(
  ORGANISATION_KINDS.map((kind) => [kind.toLowerCase(), kind]),
)

/**
 * What the organisation read asks for: the fields the read model reads of the
 * four kinds, and nothing else — no annotation (an organisation provider puts
 * a person's email and directory id there), no title, no `spec.profile` (a
 * picture can be a data URI of any size). A server that ignores `fields` sends
 * the rest, which the reader drops and names as not read, as a file's — but
 * for a User's or a Group's profile, which the pre-pass drops first.
 */
const ORGANISATION_FIELDS =
  'apiVersion,kind,metadata.name,metadata.namespace,metadata.uid,' +
  'spec.type,spec.parent,spec.children,spec.members,spec.memberOf,spec.owner,spec.domain,spec.subdomainOf'

/** What a refs read asks for: enough for `readValue` to name the document it sets aside, and the uid it is counted by. */
const REFS_FIELDS = 'kind,metadata.namespace,metadata.name,metadata.uid'

const facetsSchema = z.object({
  facets: z.object({
    kind: z.array(z.object({ value: z.string(), count: z.number() })),
  }),
})

const pageSchema = z.object({
  items: z.array(z.unknown()),
  totalItems: z.number().int().nonnegative(),
  pageInfo: z.object({ nextCursor: z.string().optional() }),
})

/** The item's `kind`, lower case, when it is text: a filter's `kind=` is compared without case. */
const kindOf = (item: unknown): string | undefined => {
  const kind = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['kind'] : undefined
  return typeof kind === 'string' ? kind.toLowerCase() : undefined
}

/** The item's `metadata.uid`, when it is text. */
const uidOf = (item: unknown): string | undefined => {
  const metadata = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['metadata'] : undefined
  const uid = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>)['uid'] : undefined
  return typeof uid === 'string' ? uid : undefined
}

export async function loadCatalogue(transport: CatalogueTransport, limits: Partial<BackstageLimits> = {}): Promise<Served> {
  const bounds: BackstageLimits = { ...BACKSTAGE_LIMITS, ...limits }
  const fail = (failure: CatalogueFailure): CatalogueReadError => new CatalogueReadError(failure, transport.origin)
  const started = performance.now()
  let pages = 0
  let repeated = 0
  // Every uid kept, across every read: an item is kept once, whichever read served it again.
  const kept = new Set<string>()

  const facets = facetsSchema.safeParse(
    await transport.request('GET', 'entity-facets', new URLSearchParams({ facet: 'kind' })),
  )
  if (!facets.success) throw fail({ kind: 'not-envelope', route: 'entity-facets' })
  const kinds = facets.data.facets.kind.map(({ value }) => value)
  if (!kinds.every((kind) => KIND.test(kind))) throw fail({ kind: 'facets-kind' })
  const others = [...new Set(kinds.map((kind) => kind.toLowerCase()))]
    .filter((kind) => !(MODELLED as readonly string[]).includes(kind))
    .sort()
  // In ORGANISATION_KINDS' order, so a filter's order never moves with the facets'.
  const organisation = [...ORGANISATION.keys()].filter((kind) => others.includes(kind))
  const rest = others.filter((kind) => !ORGANISATION.has(kind))

  /** Every item of one read, each uid once, or the failure that ends the load. */
  async function read(filters: readonly string[], fields: string | undefined, ceiling: number, scope: ReadScope): Promise<unknown[]> {
    const pageQuery = (first: URLSearchParams): URLSearchParams => {
      if (fields !== undefined) first.append('fields', fields)
      first.append('limit', String(bounds.pageSize))
      return first
    }
    let query = pageQuery(new URLSearchParams(filters.map((kind): [string, string] => ['filter', `kind=${kind}`])))
    const asked: ReadonlySet<string> = new Set(filters)
    const cursors = new Set<string>()
    // This read's distinct uids, which its totalItems and its ceiling count.
    const seen = new Set<string>()
    const items: unknown[] = []
    let expected: number | undefined

    for (;;) {
      const page = pageSchema.safeParse(await transport.request('GET', 'entities/by-query', query))
      if (!page.success) throw fail({ kind: 'not-envelope', route: 'entities/by-query' })
      pages += 1
      if (expected === undefined) {
        expected = page.data.totalItems
        if (expected > ceiling) throw fail({ kind: 'too-many', scope, limit: ceiling })
      }
      for (const item of page.data.items) {
        const uid = uidOf(item)
        if (uid === undefined) throw fail({ kind: 'no-uid' })
        const kind = kindOf(item)
        if (kind === undefined || !asked.has(kind)) throw fail({ kind: 'unasked-kind', scope })
        seen.add(uid)
        if (seen.size > ceiling) throw fail({ kind: 'too-many', scope, limit: ceiling })
        if (kept.has(uid)) {
          repeated += 1
          continue
        }
        kept.add(uid)
        items.push(item)
      }
      const next = page.data.pageInfo.nextCursor
      if (next === undefined) break
      if (cursors.has(next)) throw fail({ kind: 'same-page' })
      cursors.add(next)
      query = pageQuery(new URLSearchParams([['cursor', next]]))
    }

    if (seen.size < expected) throw fail({ kind: 'changed', expected, read: seen.size })
    return items
  }

  const whole = await read(MODELLED, undefined, bounds.modelledEntities, 'modelled')
  const organised =
    organisation.length === 0
      ? []
      : await read(organisation, ORGANISATION_FIELDS, bounds.organisationEntities, 'organisation')
  const refs = rest.length === 0 ? [] : await read(rest, REFS_FIELDS, bounds.otherRefs, 'refs')
  const { bytes } = transport.spent
  return {
    whole,
    organisation: organised,
    refs,
    judged: organisation.flatMap((kind) => ORGANISATION.get(kind) ?? []),
    census: { served: kept.size, pages, bytes, ms: Math.round(performance.now() - started), repeated },
  }
}
