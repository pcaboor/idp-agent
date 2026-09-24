import type { Entity } from '../../core/schemas/entity.js'
import { levelledOf, natureOf } from '../../core/schemas/resource-types.js'
import { ENV_ANNOTATION } from '../../core/schemas/vocabulary.js'
import type { Ignored } from '../provider.js'
import { refOf, type EntityGraph } from './entity-graph.js'

/**
 * What the engine says when asked to describe the catalogue as a whole — the
 * `overview` answer (ADR-0007). The model chooses it and writes none of it, so
 * every figure here is computed from the graph and from what the reader set
 * aside, and nothing is carried over from the conversation that chose it.
 *
 * Exact, where `summariseGraph` buckets. That summary is a prompt, and a count
 * moving from 33 to 34 must not re-record every scenario; this is read by a
 * person, and "10-99 entities" is not a description of anybody's catalogue.
 *
 * Data only: `cli/render/overview.ts` decides how much of each list a reader
 * sees. Every list is complete here and sorted count first, then name, so the
 * same graph always reads the same whatever order a provider loaded it in.
 */
export interface Tally {
  name: string
  count: number
}

export interface Overview {
  entities: number
  kinds: Tally[]
  types: Tally[]
  /**
   * Declared through the annotation, and the entities that declare none apart.
   * An undeclared environment is counted, never named: `(undeclared)` as a
   * tally would collide with an environment someone did call that.
   */
  environments: { declared: Tally[]; undeclared: number }
  owners: Tally[]
  /**
   * Entities by the system they declare, and those declaring none apart —
   * counted, never named, for the reason an undeclared environment is.
   */
  systems: { declared: Tally[]; none: number }
  /** Each tag, counted once per entity carrying it. */
  tags: Tally[]
  /**
   * Every entity that describes itself, sorted by reference, with the
   * description as its file wrote it. The one place the overview carries
   * prose, and none of it is the model's: it is what the repository says its
   * entities are. Unbounded and unflattened here, like every list — the
   * renderer cleans and cuts it. A blank description describes nothing.
   */
  described: Array<{ ref: string; description: string }>
  /**
   * Every right, and the level each states. `undeclared` is a levelled right
   * that states none — never read as readwrite (design 4.1); `unlevelled` is a
   * right of a type that has no level to state, a network flow or a route.
   */
  rights: { total: number; read: number; readwrite: number; undeclared: number; unlevelled: number }
  /**
   * Objects by what reaches them through any chain: the services, as
   * `consumersOf` walks them for `show`, then the rights on the way. Both,
   * because a declarations repository names services another repository
   * declares — its grants reach every database and no declared service does.
   * Objects only: a right is how an object is reached, not what is. Objects
   * nothing reaches are left out; they are not "most reached" at any rank.
   */
  reached: Array<{ ref: string; services: number; rights: number }>
  /** Every dangling reference, sorted. Reported, never pruned (design 4.4). */
  dangling: Array<{ from: string; to: string }>
  /** The documents set aside as kinds this tool does not model. */
  setAside: { total: number; kinds: Tally[]; unkinded: number }
  /** Documents refused; `main` names each one on a `skipped` line. */
  rejected: number
}

/** What the reader could not turn into entities, as `LoadResult` carries it. */
export interface Unread {
  ignored: readonly Ignored[]
  rejected: number
}

const byCountThenName = (left: Tally, right: Tally): number =>
  right.count - left.count || compare(left.name, right.name)

/** Code-unit order, not locale order: the output must not move with LANG. */
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function tally(values: Iterable<string>): Tally[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort(byCountThenName)
}

/** A blank annotation declares nothing: counted with the undeclared, never named "". */
const envOf = (entity: Entity): string | undefined => {
  const env = entity.metadata.annotations[ENV_ANNOTATION]
  return env === undefined || env.trim() === '' ? undefined : env
}

/**
 * The services and the rights reaching `ref`, walked as `consumersOf` walks:
 * breadth-first over dependants, a Component ending its chain, everything
 * else walked through, a visited set against a hand-edited cycle.
 */
function reachersOf(graph: EntityGraph, ref: string): { services: number; rights: number } {
  const seen = new Set<string>([ref])
  const queue = [ref]
  const counts = { services: 0, rights: 0 }
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const dependant of graph.dependantsOf(current)) {
      const dependantRef = refOf(dependant)
      if (seen.has(dependantRef)) continue
      seen.add(dependantRef)
      if (dependant.kind === 'Component') {
        counts.services += 1
        continue
      }
      if (natureOf(dependant.spec.type) === 'right') counts.rights += 1
      queue.push(dependantRef)
    }
  }
  return counts
}

export function overviewOf(graph: EntityGraph, unread: Unread): Overview {
  const entities = graph.all()
  const declared = entities.flatMap((entity) => envOf(entity) ?? [])

  const rights = { total: 0, read: 0, readwrite: 0, undeclared: 0, unlevelled: 0 }
  const reached: Overview['reached'] = []
  for (const entity of entities) {
    if (entity.kind !== 'Resource') continue
    if (natureOf(entity.spec.type) === 'object') {
      const { services, rights } = reachersOf(graph, refOf(entity))
      if (services + rights > 0) reached.push({ ref: refOf(entity), services, rights })
      continue
    }
    rights.total += 1
    if (!levelledOf(entity.spec.type)) rights.unlevelled += 1
    else rights[entity.spec.access ?? 'undeclared'] += 1
  }

  const kinded = unread.ignored.flatMap(({ kind }) => (kind === undefined ? [] : [kind]))
  const systems = entities.flatMap((entity) => entity.spec.system ?? [])
  const described = entities
    .flatMap((entity) => {
      const { description } = entity.metadata
      return description === undefined || description.trim() === ''
        ? []
        : [{ ref: refOf(entity), description }]
    })
    .sort((left, right) => compare(left.ref, right.ref))

  return {
    entities: entities.length,
    kinds: tally(entities.map((entity) => entity.kind)),
    types: tally(entities.map((entity) => entity.spec.type)),
    environments: { declared: tally(declared), undeclared: entities.length - declared.length },
    owners: tally(entities.map((entity) => entity.spec.owner)),
    systems: { declared: tally(systems), none: entities.length - systems.length },
    tags: tally(entities.flatMap((entity) => [...new Set(entity.metadata.tags ?? [])])),
    described,
    rights,
    reached: reached.sort(
      (left, right) =>
        right.services - left.services ||
        right.rights - left.rights ||
        compare(left.ref, right.ref),
    ),
    dangling: graph
      .danglingReferences()
      .sort((left, right) => compare(left.from, right.from) || compare(left.to, right.to)),
    setAside: {
      total: unread.ignored.length,
      kinds: tally(kinded),
      unkinded: unread.ignored.length - kinded.length,
    },
    rejected: unread.rejected,
  }
}
