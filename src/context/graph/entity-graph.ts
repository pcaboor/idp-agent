import type { Entity } from '../../core/schemas/entity.js'

export interface SearchCriteria {
  kind?: 'Component' | 'Resource'
  type?: string
  env?: string
  nameContains?: string
  owner?: string
}

export const ENV_ANNOTATION = 'company.fr/env'

/** `kind:namespace/name`, the form Backstage uses in dependsOn and dependencyOf. */
export function refOf(entity: Entity): string {
  return `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`
}

const envOf = (entity: Entity): string | undefined => entity.metadata.annotations[ENV_ANNOTATION]

export class EntityGraph {
  private readonly byRef: Map<string, Entity>
  private readonly dependants: Map<string, Set<string>>

  private constructor(private readonly entities: Entity[]) {
    this.byRef = new Map(entities.map((entity) => [refOf(entity), entity]))
    this.dependants = new Map()

    // A dependency is declared from either side: `dependsOn` on the consumer, or
    // `dependencyOf` on the access. Both feed the same reverse index, so asking
    // who consumes something does not depend on which side wrote it down.
    for (const entity of entities) {
      const ref = refOf(entity)
      for (const target of entity.spec.dependsOn ?? []) this.link(target, ref)
      if (entity.kind === 'Resource') {
        for (const consumer of entity.spec.dependencyOf ?? []) this.link(ref, consumer)
      }
    }
  }

  private link(target: string, dependant: string): void {
    const set = this.dependants.get(target) ?? new Set<string>()
    set.add(dependant)
    this.dependants.set(target, set)
  }

  static from(entities: Entity[]): EntityGraph {
    return new EntityGraph(entities)
  }

  get size(): number {
    return this.entities.length
  }

  all(): Entity[] {
    return [...this.entities]
  }

  get(ref: string): Entity | undefined {
    return this.byRef.get(ref)
  }

  search(criteria: SearchCriteria): Entity[] {
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

  /** Present entities only. A missing target is dangling, and reported as such. */
  dependenciesOf(ref: string): Entity[] {
    const entity = this.byRef.get(ref)
    if (entity === undefined) return []
    return (entity.spec.dependsOn ?? [])
      .map((target) => this.byRef.get(target))
      .filter((found): found is Entity => found !== undefined)
  }

  dependantsOf(ref: string): Entity[] {
    return [...(this.dependants.get(ref) ?? [])]
      .map((dependant) => this.byRef.get(dependant))
      .filter((found): found is Entity => found !== undefined)
  }

  /**
   * Components reached through any chain of dependants. Breadth-first with a
   * visited set: a repository is edited by hand, so a cycle happens, and
   * answering a read-only question must never hang.
   */
  consumersOf(ref: string): Entity[] {
    const seen = new Set<string>([ref])
    const queue = [ref]
    const found: Entity[] = []

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
        ...(entity.spec.dependsOn ?? []),
        ...(entity.kind === 'Resource' ? (entity.spec.dependencyOf ?? []) : []),
      ]
      for (const to of targets) {
        if (!this.byRef.has(to)) dangling.push({ from, to })
      }
    }
    return dangling
  }
}
