import type { CatalogueEntity } from '../../core/schemas/entity.js'
import { ENV_ANNOTATION } from '../../core/schemas/vocabulary.js'

export interface SearchCriteria {
  kind?: CatalogueEntity['kind']
  type?: string
  env?: string
  nameContains?: string
  owner?: string
}

export { ENV_ANNOTATION } from '../../core/schemas/vocabulary.js'

/** `kind:namespace/name`, the form Backstage uses in dependsOn and dependencyOf. */
export function refOf(entity: CatalogueEntity): string {
  return `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`
}

const envOf = (entity: CatalogueEntity): string | undefined =>
  entity.metadata.annotations[ENV_ANNOTATION]

/** What an entity declares it depends on. An API declares nothing of the kind. */
const dependsOnOf = (entity: CatalogueEntity): string[] =>
  entity.kind === 'API' ? [] : (entity.spec.dependsOn ?? [])

/** The APIs a Component declares it provides, in file order. Nothing else provides one. */
const providesOf = (entity: CatalogueEntity): string[] =>
  entity.kind === 'Component' ? (entity.spec.providesApis ?? []) : []

export class EntityGraph {
  private readonly byRef: Map<string, CatalogueEntity>
  private readonly dependants: Map<string, Set<string>>
  private readonly derived: Map<string, Set<string>>
  /** API reference → the components that declare they provide it. */
  private readonly providers: Map<string, Set<string>>

  private constructor(
    private readonly entities: CatalogueEntity[],
    private readonly aside: ReadonlySet<string>,
  ) {
    this.byRef = new Map(entities.map((entity) => [refOf(entity), entity]))
    this.dependants = new Map()
    this.derived = new Map()
    this.providers = new Map()

    // A dependency is declared from either side: `dependsOn` on the consumer, or
    // `dependencyOf` on the access. Which side wrote the edge down decides which
    // file a reviewer sees, never which question may be answered — so both feed
    // both indexes, and the two are exact transposes of each other.
    //
    // Providing an API is a relation of its own, and not a dependency either
    // way: `spec.providesApis` is written on the Component only, and read back
    // from the API by `providersOf`. Who CONSUMES an API is a right over it —
    // a Resource that `dependsOn` the API — so `consumersOf` walks it as it
    // walks any object, and `spec.consumesApis` is not read at all (design 4.1).
    for (const entity of entities) {
      const ref = refOf(entity)
      for (const target of dependsOnOf(entity)) this.link(this.dependants, target, ref)
      for (const api of providesOf(entity)) this.link(this.providers, api, ref)
      if (entity.kind === 'Resource') {
        for (const consumer of entity.spec.dependencyOf ?? []) {
          this.link(this.dependants, ref, consumer)
          this.link(this.derived, consumer, ref)
        }
      }
    }
  }

  private link(index: Map<string, Set<string>>, key: string, value: string): void {
    const set = index.get(key) ?? new Set<string>()
    set.add(value)
    index.set(key, set)
  }

  /** Present entities only, in the order given. A missing one is dangling. */
  private present(refs: string[]): CatalogueEntity[] {
    return refs
      .map((ref) => this.byRef.get(ref))
      .filter((found): found is CatalogueEntity => found !== undefined)
  }

  /**
   * `aside` holds the references of documents read and not modelled — a Group,
   * a System. They are no entity of this graph, but a reference to one is not
   * dangling: the repository declares it. `plan` puts the repository's APIs
   * there too: it decides against the write model, where an API is a
   * reference that resolves and never a node.
   */
  static from(entities: readonly CatalogueEntity[], aside: Iterable<string> = []): EntityGraph {
    return new EntityGraph([...entities], new Set(aside))
  }

  get size(): number {
    return this.entities.length
  }

  all(): CatalogueEntity[] {
    return [...this.entities]
  }

  get(ref: string): CatalogueEntity | undefined {
    return this.byRef.get(ref)
  }

  search(criteria: SearchCriteria): CatalogueEntity[] {
    return this.entities.filter((entity) => {
      if (criteria.kind !== undefined && entity.kind !== criteria.kind) return false
      if (criteria.type !== undefined && entity.spec.type !== criteria.type) return false
      if (criteria.env !== undefined && envOf(entity) !== criteria.env) return false
      if (criteria.owner !== undefined && entity.spec.owner !== criteria.owner) return false
      if (
        criteria.nameContains !== undefined &&
        !entity.metadata.name.includes(criteria.nameContains)
      ) {
        return false
      }
      return true
    })
  }

  /**
   * One declared hop, whichever side wrote it down. An access reached this way
   * is returned as itself: composing it with its own `dependsOn` would be a
   * traversal, and would drop the environment that is part of a right's
   * identity (design 4.1). The multi-hop walk is `consumersOf`, named as such.
   *
   * Present entities only; a missing target is dangling, and reported as such.
   * The subject must exist: a dangling `dependencyOf` must not make the entity
   * it names answerable.
   */
  dependenciesOf(ref: string): CatalogueEntity[] {
    const entity = this.byRef.get(ref)
    if (entity === undefined) return []
    // Declared here first, in file order — a fact a reviewer can see. Then the
    // edges written on the other side, sorted, so the answer does not depend on
    // the order a provider happened to return entities in.
    const own = dependsOnOf(entity)
    const derived = [...(this.derived.get(ref) ?? [])].filter((r) => !own.includes(r)).sort()
    return this.present([...own, ...derived])
  }

  dependantsOf(ref: string): CatalogueEntity[] {
    return this.present([...(this.dependants.get(ref) ?? [])].sort())
  }

  /**
   * The APIs a component declares it provides: `spec.providesApis`, one
   * declared hop, in file order. Present entities only, and a subject that
   * exists, as `dependenciesOf` — a reference naming nothing is dangling.
   */
  providedApisOf(ref: string): CatalogueEntity[] {
    const entity = this.byRef.get(ref)
    return entity === undefined ? [] : this.present(providesOf(entity))
  }

  /**
   * The components that declare they provide `ref`, sorted: the exact
   * transpose of `providedApisOf`, read from the other end (design 4.1).
   */
  providersOf(ref: string): CatalogueEntity[] {
    if (!this.byRef.has(ref)) return []
    return this.present([...(this.providers.get(ref) ?? [])].sort())
  }

  /**
   * Components reached through any chain of dependants. Breadth-first with a
   * visited set: a repository is edited by hand, so a cycle happens, and
   * answering a read-only question must never hang.
   */
  consumersOf(ref: string): CatalogueEntity[] {
    const seen = new Set<string>([ref])
    const queue = [ref]
    const found: CatalogueEntity[] = []

    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      for (const dependant of this.dependantsOf(current)) {
        const dependantRef = refOf(dependant)
        if (seen.has(dependantRef)) continue
        seen.add(dependantRef)
        if (dependant.kind === 'Component') found.push(dependant)
        else queue.push(dependantRef)
      }
    }

    return found
  }

  /**
   * References pointing at nothing. Reported rather than pruned: a reference to
   * a missing entity inflates a usage count, and "this flow is still in use"
   * must never be answered by an entity that no longer exists (design 4.4).
   */
  danglingReferences(): Array<{ from: string; to: string }> {
    const dangling: Array<{ from: string; to: string }> = []
    for (const entity of this.entities) {
      const from = refOf(entity)
      const targets = [
        ...dependsOnOf(entity),
        ...(entity.kind === 'Resource' ? (entity.spec.dependencyOf ?? []) : []),
        ...providesOf(entity),
      ]
      for (const to of targets) {
        if (!this.byRef.has(to) && !this.aside.has(to)) dangling.push({ from, to })
      }
    }
    return dangling
  }
}
