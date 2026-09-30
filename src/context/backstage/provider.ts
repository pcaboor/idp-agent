import type { CatalogueEntity, OrganisationEntity } from '../../core/schemas/entity.js'
import { readValue } from '../../core/yaml/serialize.js'
import { refOf } from '../graph/entity-graph.js'
import type { CacheReport, ContextProvider, Ignored, LoadResult, Rejection } from '../provider.js'
import { catalogueCache } from './cache.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from './limits.js'
import { loadCatalogue, type Served } from './load.js'
import { catalogueOrder, prePass, refOfItem, sourceOf } from './translate.js'
import { CatalogueReadError, catalogueTransport, type CatalogueFailure, type CatalogueFetch } from './transport.js'

/**
 * A Backstage catalogue as a `ContextProvider` (docs/backstage-http-brief.md
 * § 5, § 6): read once, into the same `LoadResult` a folder of YAML
 * fills, through the same reader. Every item of every read goes through the
 * pre-pass (`translate.ts`) and then `readValue`, the file road's per-value
 * reader, so a catalogue meets the very decisions a file does and the same
 * refusal words; `tests/unit/backstage-provider.test.ts` proves the demo SI
 * served by a catalogue reads as its files read. The one thing a catalogue
 * gives that a folder never does is `judged`: the organisation kinds it read
 * whole, which a reference to is then judged against.
 *
 * `load()` throws a `CatalogueReadError` for every failure and returns
 * nothing then. A read that stopped at a count ceiling is no failure: what it
 * read is returned, the reads that stopped in `partial` (ADR-0013). It names
 * no `fetch`: `catalogueFetch` is handed to the transport as it came, and
 * cli/ constructs this (`providerOf`).
 *
 * Given a `cache`, it keeps what it reads on disk (`cache.ts`) and may answer
 * from a copy — and a copy is a `Served` like a load's, whose every item goes
 * through the same loop, the pre-pass and `readValue`, as a page's. This is
 * the one module that may load the store (`tests/architecture/`), so no copy
 * reaches anything but that loop. Its three uses:
 *
 *   - `fresh`: a copy younger than the TTL answers, and nothing is asked;
 *     otherwise the catalogue is read and the read kept.
 *   - `refresh`: the catalogue is read and the read kept, whatever is kept —
 *     `--refresh`, and slice 4's gate, which must prove the token still reads.
 *   - `kept`: a copy that verifies answers whatever its age, and the
 *     catalogue is never asked; with none, a `not-kept` failure.
 *
 * A load that fails is never answered from a copy. When it failed for reach
 * and a copy verifies, the failure says the copy's age, so the person can be
 * pointed at `--cached` — never after a 401 or a 403, which may be a revoked
 * token, and a copy would route around the revocation.
 */
export class BackstageProvider implements ContextProvider {
  readonly name = 'backstage-http'

  constructor(
    private readonly options: {
      base: URL
      /** A value, never read from the environment here. */
      token: string | undefined
      catalogueFetch: CatalogueFetch
      /** Lowered by a test to reach a bound; a run keeps `BACKSTAGE_LIMITS`. */
      limits?: Partial<BackstageLimits>
      /**
       * The store a read is kept in, and how it is used; absent, none is, and
       * the load is what it was before the store existed.
       */
      cache?: {
        /** `$XDG_CACHE_HOME` or `~/.cache`, handed down by cli/. */
        root: string
        /** The account every name of the store must belong to. */
        owner: number
        use: 'fresh' | 'refresh' | 'kept'
        now?: () => number
      }
    },
  ) {}

  async load(): Promise<LoadResult> {
    const limits: BackstageLimits = { ...BACKSTAGE_LIMITS, ...this.options.limits }
    if (this.options.cache === undefined) return translated(await this.live(limits))
    const { served, report } = await this.cached(this.options.cache, limits)
    return { ...translated(served), cache: report }
  }

  /** The catalogue, read over the transport. */
  private live(limits: BackstageLimits): Promise<Served> {
    const transport = catalogueTransport({
      base: this.options.base,
      token: this.options.token,
      catalogueFetch: this.options.catalogueFetch,
      limits,
      // One bound for the whole load, every request and every wait included.
      signal: AbortSignal.timeout(limits.loadMs),
    })
    return loadCatalogue(transport, limits)
  }

  /** A `Served` from a copy or from the catalogue, by the use asked, and what the store did. */
  private async cached(
    cache: NonNullable<(typeof this.options)['cache']>,
    limits: BackstageLimits,
  ): Promise<{ served: Served; report: CacheReport }> {
    const now = cache.now ?? Date.now
    const ageOf = (fetchedAt: number): number | undefined => {
      const age = now() - fetchedAt
      return age >= 0 ? age : undefined
    }
    const notKept = (): CatalogueReadError => new CatalogueReadError({ kind: 'not-kept' }, this.options.base.origin)
    // The effective limits: a copy made under other bounds is under another key, and never read.
    const made = await catalogueCache({
      root: cache.root,
      base: this.options.base,
      token: this.options.token,
      owner: cache.owner,
      limits,
      now,
      // A kept read writes nothing: not a copy, and not the folders or the secret a first run makes.
      readOnly: cache.use === 'kept',
    })
    if (!('cache' in made)) {
      if (cache.use === 'kept') throw notKept()
      if (!('unusable' in made)) throw new Error('only a read-only store is ever absent')
      const refusal = made.unusable
      return {
        served: await this.live(limits),
        report: { read: { state: 'not-used', refusal }, written: { state: 'not-written', refusal } },
      }
    }
    const store = made.cache

    let read: CacheReport['read']
    switch (cache.use) {
      case 'kept': {
        const copy = await store.read('kept')
        if (!('kept' in copy)) throw notKept()
        const { served, fetchedAt } = copy.kept
        return { served, report: { read: { state: 'kept', fetchedAt, ageMs: ageOf(fetchedAt) } } }
      }
      case 'fresh': {
        const copy = await store.read('fresh')
        if ('kept' in copy) {
          const { served, fetchedAt } = copy.kept
          return { served, report: { read: { state: 'fresh', fetchedAt, ageMs: ageOf(fetchedAt) } } }
        }
        read = typeof copy.none === 'string' ? { state: copy.none } : { state: 'not-used', refusal: copy.none }
        break
      }
      case 'refresh':
        read = { state: 'skipped' }
        break
      default: {
        const exhaustive: never = cache.use
        return exhaustive
      }
    }

    let served: Served
    try {
      served = await this.live(limits)
    } catch (error) {
      if (error instanceof CatalogueReadError && ofReach(error.failure)) {
        // Only so the failure can name the copy and its age: it is never answered from.
        const copy = await store.read('kept')
        if ('kept' in copy) throw new CatalogueReadError(error.failure, error.origin, { ageMs: ageOf(copy.kept.fetchedAt) })
      }
      throw error
    }
    const written = await store.write(served)
    return {
      served,
      report: {
        read,
        written: written.written ? { state: 'written' } : { state: 'not-written', refusal: written.refusal },
      },
    }
  }
}

/**
 * Whether a read failed for reach — the catalogue could not be reached, did
 * not answer in time, failed, or limited the rate — rather than refused this
 * token or answered what a catalogue does not: the failures after which a
 * kept copy is worth naming.
 */
function ofReach(failure: CatalogueFailure): boolean {
  switch (failure.kind) {
    case 'unreachable':
    case 'timeout':
    case 'rate-limited':
      return true
    case 'status':
      return failure.status >= 500
    case 'redirect':
    case 'foreign-response':
    case 'too-large':
    case 'not-json':
    case 'not-envelope':
    case 'facets-kind':
    case 'same-page':
    case 'no-uid':
    case 'unasked-kind':
    case 'changed':
    case 'not-kept':
      return false
    default: {
      const exhaustive: never = failure
      return exhaustive
    }
  }
}

/** What a catalogue served, through the pre-pass and the file road's reader, as a `LoadResult`. */
function translated(served: Served): LoadResult {
  const read: { entity: CatalogueEntity; ref: string; location?: string; unread: readonly string[] }[] = []
  // Asked for no annotation, so none has a location: in ref order.
  const organisation: { node: OrganisationEntity; ref: string; unread: readonly string[] }[] = []
  const rejected: { rejection: Rejection; ref: string; location?: string }[] = []
  const ignored: Ignored[] = []

  for (const item of [...served.whole, ...served.organisation, ...served.refs]) {
    const passed = prePass(item)
    if ('aside' in passed) {
      ignored.push(passed.aside)
      continue
    }
    const { value, location } = passed
    const ref = refOfItem(value)
    const source = sourceOf(ref, location)
    const reading = readValue(value)
    switch (reading.as) {
      case 'witness':
        break
      case 'rejected':
        rejected.push({
          rejection: { source, reason: reading.reason, ...(ref !== undefined && { ref }) },
          ref: ref ?? '',
          ...(location !== undefined && { location }),
        })
        break
      case 'ignored':
        ignored.push({ source, ...reading.document })
        break
      case 'api':
        read.push({ entity: reading.api, ref: refOf(reading.api), ...(location !== undefined && { location }), unread: reading.unread })
        break
      case 'organisation':
        organisation.push({ node: reading.entity, ref: refOf(reading.entity), unread: reading.unread })
        break
      case 'entity':
        read.push({ entity: reading.entity, ref: refOf(reading.entity), ...(location !== undefined && { location }), unread: reading.unread })
        break
      default: {
        const exhaustive: never = reading
        return exhaustive
      }
    }
  }

  read.sort(catalogueOrder)
  organisation.sort(catalogueOrder)
  rejected.sort(catalogueOrder)
  // By ref, in code-unit order as the rest; a row with none last, by where it came from.
  ignored.sort((a, b) =>
    a.ref !== undefined && b.ref !== undefined
      ? catalogueOrder({ ref: a.ref }, { ref: b.ref })
      : a.ref !== undefined
        ? -1
        : b.ref !== undefined
          ? 1
          : catalogueOrder({ ref: a.source }, { ref: b.source }),
  )

  return {
    entities: read.map(({ entity }) => entity),
    rejected: rejected.map(({ rejection }) => rejection),
    ignored,
    unread: [...read, ...organisation].flatMap(({ unread }) => unread),
    census: served.census,
    ...(organisation.length > 0 && { organisation: organisation.map(({ node }) => node) }),
    ...(served.judged.length > 0 && { judged: served.judged }),
    // Only when a read stopped at its bound: a whole read's result is what it always was.
    ...(served.bounded.length > 0 && { partial: served.bounded }),
  }
}
