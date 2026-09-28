import type { CatalogueEntity } from '../../core/schemas/entity.js'
import { readValue } from '../../core/yaml/serialize.js'
import { refOf } from '../graph/entity-graph.js'
import type { ContextProvider, Ignored, LoadResult, Rejection } from '../provider.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from './limits.js'
import { loadCatalogue } from './load.js'
import { catalogueOrder, prePass, refOfItem, sourceOf } from './translate.js'
import { catalogueTransport, type CatalogueFetch } from './transport.js'

/**
 * A Backstage catalogue as a `ContextProvider` (docs/backstage-http-brief.md
 * § 5, § 6): read whole, once, into the same `LoadResult` a folder of YAML
 * fills, through the same reader. Every item of both reads goes through the
 * pre-pass (`translate.ts`) and then `readValue`, the file road's per-value
 * reader, so a catalogue meets the very decisions a file does and the same
 * refusal words; `tests/unit/backstage-provider.test.ts` proves the demo SI
 * served by a catalogue reads as its files read.
 *
 * `load()` throws a `CatalogueReadError` for every failure and returns
 * nothing partial. It names no `fetch`: `catalogueFetch` is handed to the
 * transport as it came, and cli/ constructs this from 1.5.
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
    },
  ) {}

  async load(): Promise<LoadResult> {
    const limits: BackstageLimits = { ...BACKSTAGE_LIMITS, ...this.options.limits }
    const transport = catalogueTransport({
      base: this.options.base,
      token: this.options.token,
      catalogueFetch: this.options.catalogueFetch,
      limits,
      // One bound for the whole load, every request and every wait included.
      signal: AbortSignal.timeout(limits.loadMs),
    })
    const served = await loadCatalogue(transport, limits)

    const read: { entity: CatalogueEntity; ref: string; location?: string; unread: readonly string[] }[] = []
    const rejected: { rejection: Rejection; ref: string; location?: string }[] = []
    const ignored: Ignored[] = []

    for (const item of [...served.whole, ...served.refs]) {
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
      unread: read.flatMap(({ unread }) => unread),
      census: served.census,
    }
  }
}
