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

/** The consumers a Resource declares it is a dependency of. Nothing else declares one. */
const dependencyOfOf = (entity: CatalogueEntity): string[] =>
  entity.kind === 'Resource' ? (entity.spec.dependencyOf ?? []) : []

/** The three fields a reference to another entity is declared in. */
export type DeclaredField = 'dependsOn' | 'dependencyOf' | 'providesApis'

/**
 * A reference an entity declares and nothing in the catalogue answers to: a
 * dangling reference, with what the graph can say about it and no more.
 */
export interface Unresolved {
  /** The entity whose file declares it. */
  readonly from: string
  readonly field: DeclaredField
  /** The reference as the reader normalised it (`entitySchema`), never corrected. */
  readonly to: string
  /**
   * The entities whose name is the reference's own, under another kind or
   * namespace, sorted — none, one or several. Said beside it, never put in
   * its place: that `component:` meant `resource:` is a guess (design 4.1).
   */
  readonly sameName: readonly string[]
}

/**
 * The name part of a reference: after the `/` of `kind:namespace/name`, or
 * the `:` of `kind:name`. A `providesApis` the grammar could not split is kept
 * as written, and is its own name.
 */
const nameOf = (ref: string): string => {
  const slash = ref.lastIndexOf('/')
  if (slash !== -1) return ref.slice(slash + 1)
  return ref.slice(ref.indexOf(':') + 1)
}

export class EntityGraph {
  private readonly byRef: Map<string, CatalogueEntity>
  private readonly dependants: Map<string, Set<string>>
  private readonly derived: Map<string, Set<string>>
  /** API reference → the components that declare they provide it. */
  private readonly providers: Map<string, Set<string>>
  /**
   * Every reference declared that resolves to nothing, entity by entity in the
   * order given, and each entity's in file order, field by field: the one
   * reading of "dangling" every command shares. `unresolved` indexes it.
   */
  private readonly dangling: Unresolved[]
  /** Entity reference → its own entries of `dangling`, the entity `get` returns. */
  private readonly unresolved: Map<string, Unresolved[]>

  private constructor(
    private readonly entities: CatalogueEntity[],
    private readonly aside: ReadonlySet<string>,
  ) {
    this.byRef = new Map(entities.map((entity) => [refOf(entity), entity]))
    this.dependants = new Map()
    this.derived = new Map()
    this.providers = new Map()
    this.dangling = []
    this.unresolved = new Map()

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

    // What declares a name, whatever its kind: said beside a reference that
    // resolves to nothing, so the reader sees the near miss and decides.
    const byName = new Map<string, string[]>()
    for (const ref of this.byRef.keys()) {
      const name = nameOf(ref)
      byName.set(name, [...(byName.get(name) ?? []), ref])
    }
    for (const entity of entities) {
      const from = refOf(entity)
      const declared: Array<[DeclaredField, string[]]> = [
        ['dependsOn', dependsOnOf(entity)],
        ['dependencyOf', dependencyOfOf(entity)],
        ['providesApis', providesOf(entity)],
      ]
      const found: Unresolved[] = []
      for (const [field, targets] of declared) {
        for (const to of targets) {
          if (this.byRef.has(to) || this.aside.has(to)) continue
          const sameName = [...(byName.get(nameOf(to)) ?? [])].sort()
          found.push({ from, field, to, sameName })
        }
      }
      this.dangling.push(...found)
      // Keyed as `byRef` is, so a duplicate is read as `get` reads it: the last.
      this.unresolved.set(from, found)
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
    return this.dangling.map(({ from, to }) => ({ from, to }))
  }

  /**
   * What an entity declares that resolves to nothing, in file order — all of
   * it, or one field's. Shown where the entity's relations are shown, marked
   * as declared nowhere: a relation the file states is part of what the
   * entity says, broken or not, and leaving it off a card makes the card
   * answer "nothing declared" about a file that declares something.
   *
   * Nothing here is resolved: no edge is added, and no query above answers
   * with it.
   */
  unresolvedOf(ref: string, field?: DeclaredField): Unresolved[] {
    const all = this.unresolved.get(ref) ?? []
    return field === undefined ? [...all] : all.filter((found) => found.field === field)
  }

  /**
   * The services declared along the walk `consumersOf` takes that nothing
   * declares: the `dependencyOf` of the target and of every right or object
   * reached through it, in the order met. A service named by a right and
   * declared nowhere is still named — as reaching nothing, since nothing is
   * there to reach. Only a `component:` one: what `consumersOf` would list
   * if it resolved. A missing Resource would be walked through, not listed,
   * and saying it reaches the target as a service is a statement no file
   * makes; it is shown where its right's own `dependencyOf` is.
   */
  unresolvedConsumersOf(ref: string): Unresolved[] {
    if (!this.byRef.has(ref)) return []
    const seen = new Set<string>([ref])
    const queue = [ref]
    const found: Unresolved[] = []

    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      found.push(
        ...this.unresolvedOf(current, 'dependencyOf').filter(({ to }) =>
          to.startsWith('component:'),
        ),
      )
      for (const dependant of this.dependantsOf(current)) {
        const dependantRef = refOf(dependant)
        if (seen.has(dependantRef)) continue
        seen.add(dependantRef)
        if (dependant.kind !== 'Component') queue.push(dependantRef)
      }
    }

    return found
  }
}
