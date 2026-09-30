import { z } from 'zod'
import { ORGANISATION_KINDS, type OrganisationKind } from '../../core/schemas/entity.js'
import type { Census, PartialRead, ReadScope } from '../provider.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from './limits.js'
import { CatalogueReadError, type CatalogueFailure, type CatalogueTransport } from './transport.js'

/**
 * The load (docs/backstage-http-brief.md § 6): a whole catalogue, or one read
 * up to a stated bound and said to be (`Served.bounded`, ADR-0013), or a
 * `CatalogueReadError` and nothing. A count ceiling is a fact about the
 * catalogue's size, so a read that reaches one stops there and says how far
 * it got; every other bound — bytes, time, the cursor, an item the read
 * cannot count — is what a broken or hostile server does, cut wherever the
 * server chose, and is refused.
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
 *   5. Each read's ceiling is a bound, counted in distinct uids as items
 *      arrive. A first page whose `totalItems` passes it only records the
 *      total; the read stops when a new uid would pass the ceiling, or when
 *      it reaches it at the end of a page and `totalItems` says there is
 *      more. The items of that page past the ceiling are not kept, no next
 *      page is asked for, and the read is `bounded`: the part kept is the
 *      first in the server's order, and nothing else. Fewer uids than
 *      announced is judged only on a read that did not stop.
 *   6. The load's own time is the transport's: `BackstageProvider` hands it
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
   * them, when the organisation read was whole: none when it stopped at its
   * bound. What a reference to one of them is judged against
   * (`EntityGraph`), and nothing else is.
   */
  readonly judged: OrganisationKind[]
  /** The reads that stopped at their ceiling, in the order they were sent; empty when every read was whole. */
  readonly bounded: readonly PartialRead[]
  readonly census: Census
  /**
   * The kinds the organisation and refs reads asked for, lower case, as their
   * filters named them: what a kept copy's account of its own reads is held
   * to (`accountHolds`), and what its `judged` is recomputed from.
   */
  readonly asked: { readonly organisation: readonly string[]; readonly refs: readonly string[] }
  /** When the load began (`Date.now()`): a kept copy's `fetchedAt`, so its age is never understated. */
  readonly startedAt: number
}

/** Backstage's kind grammar: nothing a filter's `,` or `=` could hide in. */
const KIND = /^[A-Za-z][A-Za-z0-9]*$/

/** The kinds read whole: the two this tool models, and the API it reads. */
const MODELLED = ['component', 'resource', 'api'] as const

/** The kinds the modelled read asks for, lower case: what a kept copy's modelled items are admitted against. */
export const MODELLED_KINDS: readonly string[] = MODELLED

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
export const ORGANISATION_FIELDS =
  'apiVersion,kind,metadata.name,metadata.namespace,metadata.uid,' +
  'spec.type,spec.parent,spec.children,spec.members,spec.memberOf,spec.owner,spec.domain,spec.subdomainOf'

/** What a refs read asks for: enough for `readValue` to name the document it sets aside, and the uid it is counted by. */
export const REFS_FIELDS = 'kind,metadata.namespace,metadata.name,metadata.uid'

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

/** One read, as `admitted` judges its items: the kinds its filters named, its ceiling, and which read it is. */
export interface ReadRule {
  readonly asked: ReadonlySet<string>
  readonly ceiling: number
  readonly scope: ReadScope
}

/**
 * What `admitted` made of some items: those kept, how many were kept already
 * by this read or another, and whether the ceiling stopped it — or the
 * failure that ends the read.
 */
export type Admission =
  | { readonly refused: Extract<CatalogueFailure, { kind: 'no-uid' | 'unasked-kind' }> }
  | { readonly items: unknown[]; readonly repeated: number; readonly stopped: boolean }

/**
 * Every item of one page, or of one read of a kept copy, by one rule: a
 * string uid, or the read cannot be counted; a kind its read asked for, or
 * the server ignored `filter`; each uid once across every read (`kept`),
 * counted when it comes again; and no more distinct uids in this read
 * (`seen`) than its ceiling — the item that would pass it, and every one
 * after it, left out. The load reads a stop as a bound reached; a copy, which
 * never holds more than a read kept, reads it as a copy no load wrote.
 */
export function admitted(
  items: readonly unknown[],
  rule: ReadRule,
  seen: Set<string>,
  kept: Set<string>,
): Admission {
  const admitted: unknown[] = []
  let repeated = 0
  for (const item of items) {
    const uid = uidOf(item)
    if (uid === undefined) return { refused: { kind: 'no-uid' } }
    const kind = kindOf(item)
    if (kind === undefined || !rule.asked.has(kind)) return { refused: { kind: 'unasked-kind', scope: rule.scope } }
    // One more distinct uid would pass the bound: this one and the rest are not loaded.
    if (!seen.has(uid) && seen.size >= rule.ceiling) return { items: admitted, repeated, stopped: true }
    seen.add(uid)
    if (kept.has(uid)) {
      repeated += 1
      continue
    }
    kept.add(uid)
    admitted.push(item)
  }
  return { items: admitted, repeated, stopped: false }
}

/**
 * The organisation kinds a load judges, as `ORGANISATION_KINDS` spells them:
 * those its organisation read asked for, unless that read stopped at its
 * bound — a reference naming nothing a bounded read read is a name, which
 * says nothing about what is declared. The load's rule, and a copy's
 * recomputation: a copy never states it.
 */
export function judgedOf(asked: readonly string[], bounded: readonly PartialRead[]): OrganisationKind[] {
  if (bounded.some(({ scope }) => scope === 'organisation')) return []
  return asked.flatMap((kind) => ORGANISATION.get(kind) ?? [])
}

/** The ceiling of each read under `limits`. */
const ceilingOf = (scope: ReadScope, limits: BackstageLimits): number => {
  switch (scope) {
    case 'modelled':
      return limits.modelledEntities
    case 'organisation':
      return limits.organisationEntities
    case 'refs':
      return limits.otherRefs
    default: {
      const exhaustive: never = scope
      return exhaustive
    }
  }
}

const SCOPES: readonly ReadScope[] = ['modelled', 'organisation', 'refs']

/** Strictly increasing by `rank`: in order, and each once. */
const inOrder = <T>(values: readonly T[], rank: (value: T) => number): boolean =>
  values.every((value, at) => rank(value) >= 0 && (at === 0 || rank(values[at - 1] as T) < rank(value)))

/**
 * Whether `asked` and `bounded` are what a live load under `limits` could
 * have derived. A live read derives them — from the facets, its own filters
 * and its own count — and a kept copy only states them, so a copy is held to
 * exactly what a load could give, and can choose nothing a hostile Backstage
 * cannot: the organisation kinds in `ORGANISATION_KINDS`' order, each once;
 * the refs sorted, each once, lower case, of the kind grammar, and none the
 * modelled or organisation reads take; at most one bounded entry per read, in
 * the order the reads are sent, over the kinds that read asked, at the
 * effective ceiling, read to it, and announcing more or nothing.
 */
export function accountHolds(asked: Served['asked'], bounded: readonly PartialRead[], limits: BackstageLimits): boolean {
  const organisationOrder = [...ORGANISATION.keys()]
  if (!inOrder(asked.organisation, (kind) => organisationOrder.indexOf(kind))) return false
  const refs = asked.refs
  if (!refs.every((kind, at) => at === 0 || (refs[at - 1] as string) < kind)) return false
  const refsHold = refs.every(
    (kind) =>
      KIND.test(kind) &&
      kind === kind.toLowerCase() &&
      !(MODELLED as readonly string[]).includes(kind) &&
      !ORGANISATION.has(kind),
  )
  if (!refsHold) return false
  if (!inOrder(bounded, ({ scope }) => SCOPES.indexOf(scope))) return false
  const kindsOf = (scope: ReadScope): readonly string[] =>
    scope === 'modelled' ? MODELLED : scope === 'organisation' ? asked.organisation : asked.refs
  return bounded.every(({ scope, kinds, read, total, limit }) => {
    const expected = kindsOf(scope)
    const ceiling = ceilingOf(scope, limits)
    return (
      expected.length > 0 &&
      kinds.length === expected.length &&
      kinds.every((kind, at) => kind === expected[at]) &&
      limit === ceiling &&
      read === ceiling &&
      (total === undefined || total > ceiling)
    )
  })
}

/**
 * What a read asks for and how much of it it keeps: the fields of the
 * organisation and refs reads, the three ceilings and the two byte bounds of
 * `limits`. Part of a kept copy's key, so a version that asks for other
 * fields, or a run under other bounds — a test's lowered ones included —
 * never reads a copy made under these.
 */
export function readShapeOf(limits: BackstageLimits): string {
  return JSON.stringify({
    fields: { modelled: null, organisation: ORGANISATION_FIELDS, refs: REFS_FIELDS },
    ceilings: {
      modelled: limits.modelledEntities,
      organisation: limits.organisationEntities,
      refs: limits.otherRefs,
    },
    bytes: { response: limits.bytesPerResponse, run: limits.bytesPerRun },
  })
}

export async function loadCatalogue(transport: CatalogueTransport, limits: Partial<BackstageLimits> = {}): Promise<Served> {
  const bounds: BackstageLimits = { ...BACKSTAGE_LIMITS, ...limits }
  const fail = (failure: CatalogueFailure): CatalogueReadError => new CatalogueReadError(failure, transport.origin)
  const startedAt = Date.now()
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

  const bounded: PartialRead[] = []

  /**
   * Every item of one read, each uid once, up to `ceiling` distinct uids —
   * the read then recorded in `bounded` — or the failure that ends the load.
   */
  async function read(filters: readonly string[], fields: string | undefined, ceiling: number, scope: ReadScope): Promise<unknown[]> {
    const pageQuery = (first: URLSearchParams): URLSearchParams => {
      if (fields !== undefined) first.append('fields', fields)
      first.append('limit', String(bounds.pageSize))
      return first
    }
    let query = pageQuery(new URLSearchParams(filters.map((kind): [string, string] => ['filter', `kind=${kind}`])))
    const rule: ReadRule = { asked: new Set(filters), ceiling, scope }
    const cursors = new Set<string>()
    // This read's distinct uids, which its totalItems and its ceiling count.
    const seen = new Set<string>()
    const items: unknown[] = []
    let expected: number | undefined
    let stopped = false

    for (;;) {
      const page = pageSchema.safeParse(await transport.request('GET', 'entities/by-query', query))
      if (!page.success) throw fail({ kind: 'not-envelope', route: 'entities/by-query' })
      pages += 1
      expected ??= page.data.totalItems
      const admission = admitted(page.data.items, rule, seen, kept)
      if ('refused' in admission) throw fail(admission.refused)
      items.push(...admission.items)
      repeated += admission.repeated
      if (admission.stopped) {
        stopped = true
        break
      }
      const next = page.data.pageInfo.nextCursor
      if (next === undefined) break
      if (seen.size >= ceiling && expected > ceiling) {
        // At the bound with more announced: the next page would only be left out.
        stopped = true
        break
      }
      if (cursors.has(next)) throw fail({ kind: 'same-page' })
      cursors.add(next)
      query = pageQuery(new URLSearchParams([['cursor', next]]))
    }

    if (stopped) {
      bounded.push({
        scope,
        kinds: [...filters],
        read: seen.size,
        // Announced past the bound, it is how many there are; announced
        // within it, the server served more than it said, and how many is
        // not known.
        total: expected !== undefined && expected > ceiling ? expected : undefined,
        limit: ceiling,
      })
      return items
    }
    if (seen.size < (expected ?? 0)) throw fail({ kind: 'changed', expected: expected ?? 0, read: seen.size })
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
    judged: judgedOf(organisation, bounded),
    bounded,
    census: { served: kept.size, pages, bytes, ms: Math.round(performance.now() - started), repeated },
    asked: { organisation, refs: rest },
    startedAt,
  }
}
