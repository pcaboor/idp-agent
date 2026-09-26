import { declaredLevel } from '../../core/plan/grant.js'
import type { CatalogueEntity } from '../../core/schemas/entity.js'
import type { Relation } from '../../core/schemas/query.js'
import { levelledOf, natureOf, type AccessLevel } from '../../core/schemas/resource-types.js'
import { ENV_ANNOTATION, refOf, type EntityGraph, type Unresolved } from './entity-graph.js'

/**
 * Every relation of one entity, computed from the declarations: what it
 * depends on and what depends on it, transitively; what a consumer reaches
 * through its rights and who reaches an object through theirs; the APIs it
 * provides or who provides it; and every path linking it to another entity,
 * or, where neither depends on the other, the nearest entities both reach.
 * Each row carries the whole path from the entity asked about, every step
 * with its kind, type and environment, the rights on it with the level each
 * states, and a step declared nowhere marked where the path ends.
 *
 * Nothing here is a second definition. An edge is `dependenciesOf`,
 * `dependantsOf`, `providedApisOf` or `providersOf`; a right is `natureOf`,
 * whether it states a level `levelledOf`, the level `declaredLevel`; a
 * reference naming nothing is `unresolvedOf`, and the walk to the services
 * behind an object stops where `consumersOf`'s does — `relations.test.ts`
 * holds the two to one answer. This composes; it never infers (design 4.1).
 *
 * Bounded twice, and each bound is stated when it is reached, never silent: a
 * depth, past which the walk says it stopped, and a row count, past which the
 * rows cut are counted. A cycle is never walked twice (a hand-edited
 * repository has them) and is reported as the path that closes on itself —
 * found on the edges the walk followed, not only on the path it took, since
 * a walk goes through an entity once.
 */

/** What a right grants, as the declaration says it: never a default (design 4.1). */
export interface Grant {
  /** Whether a right of this type states read or write at all (`levelledOf`). */
  readonly levelled: boolean
  /** The level declared, absent when it states none. */
  readonly level?: AccessLevel
}

/**
 * One entity on a path, as the graph holds it — or a reference that names
 * nothing, which has no kind, type or environment to give, only `nowhere`:
 * who declares it, in which field, and the entities that share its name.
 */
export interface Step {
  readonly ref: string
  readonly kind?: CatalogueEntity['kind']
  readonly type?: string
  /** Absent when the entity declares none: stated as absent, never filled. */
  readonly env?: string
  /** Only on a right. */
  readonly right?: Grant
  readonly nowhere?: Unresolved
}

export interface RelationRow {
  /** From the entity asked about, first, to the one reached, last. */
  readonly steps: readonly Step[]
  /**
   * `between` only: each step depends on the one before it, where on a
   * forward path each depends on the next. A path always runs from the entity
   * asked about to the other end; a near miss, which ends on a reference
   * declared nowhere, runs from whichever end it was found from.
   */
  readonly backward?: true
}

/**
 * `between`, where neither end depends on the other: an entity both reach.
 * `depends-on`: both ends depend on it; `impacts`: it depends on both. Only
 * the nearest are listed — one each end reaches without passing another —
 * so two services on one database meet there, and not again at its host.
 */
export interface Meeting {
  readonly relation: 'depends-on' | 'impacts'
  /** The shortest path to it from the entity asked about, then from the other end. */
  readonly paths: readonly [RelationRow, RelationRow]
}

/** A list the row bound applies to: what is returned, and how many were found. */
export interface Bounded<T> {
  readonly rows: readonly T[]
  readonly total: number
}

export interface RelationResult {
  readonly relation: Relation
  readonly subject: Step
  /** `between`'s other end. */
  readonly to?: Step
  /**
   * Ordered by depth, then by the reference reached, then by path. For
   * `between`, the declared paths linking the two, and only those.
   */
  readonly rows: readonly RelationRow[]
  /** Every row found; more than `rows` when the row bound cut some. */
  readonly total: number
  /**
   * `between` only, when no path links the two: the nearest entities both
   * reach. Present only when there is one.
   */
  readonly shared?: Bounded<Meeting>
  /**
   * `between` only: a declaration on the way from one end that names nothing
   * and carries the other end's name. Beside the paths, never among them: it
   * reaches nothing, and which entity it meant is the reader's to decide.
   * Present only when there is one.
   */
  readonly nearMisses?: Bounded<RelationRow>
  /** The depth bound the walk ran under. */
  readonly depth: number
  /** The depth bound was reached with declared edges left unfollowed. */
  readonly stopped: boolean
  /** Each cycle met, as the path that closes on itself; sorted. */
  readonly cycles: readonly (readonly string[])[]
  /**
   * `between` only: the search spent its budget before it finished, so
   * `total` is how many paths were found, not how many there are.
   */
  readonly exhausted?: true
}

export interface RelationOptions {
  /** How many declared hops from the entity asked about. */
  readonly depth?: number
  /** How many rows are returned; the rest are counted in `total`. */
  readonly rows?: number
  /** `between`'s other end. */
  readonly to?: string
}

/**
 * `depth` is ten hops, far past any chain a declarations repository holds
 * today, so a question about one never meets it. `consumes` stops at the
 * object each right is over — the answer to "what does it consume" — and goes
 * further only when asked. `paths` bounds the work `between` may do: the
 * simple paths of a graph can be exponential in number, and a read-only
 * question must end. `cycles` is how many cycles a reader is shown before the
 * rest are counted: every one is computed, and each is a path's length.
 */
export const RELATION_LIMITS = {
  depth: 10,
  consumesDepth: 2,
  rows: 100,
  paths: 10_000,
  cycles: 5,
  /** The deepest a caller may ask for: `--depth`'s bound. */
  maxDepth: 100,
} as const

/** The last step of a row: what the relation reached. */
export const reachedBy = (row: RelationRow): Step => row.steps[row.steps.length - 1] as Step

/** The rights a row's path runs through, in path order — the entity reached is not one of them. */
export const rightsOn = (row: RelationRow): Step[] =>
  row.steps.slice(0, -1).filter((step) => step.right !== undefined)

const isRight = (entity: CatalogueEntity): boolean =>
  entity.kind === 'Resource' && natureOf(entity.spec.type) === 'right'

export function stepOf(entity: CatalogueEntity): Step {
  const env = entity.metadata.annotations[ENV_ANNOTATION]
  const level = entity.kind === 'Resource' ? declaredLevel(entity) : undefined
  return {
    ref: refOf(entity),
    kind: entity.kind,
    type: entity.spec.type,
    ...(env === undefined ? {} : { env }),
    ...(entity.kind === 'Resource' && isRight(entity)
      ? {
          right: {
            levelled: levelledOf(entity.spec.type),
            ...(level === undefined ? {} : { level }),
          },
        }
      : {}),
  }
}

const nowhereOf = (unresolved: Unresolved): Step => ({ ref: unresolved.to, nowhere: unresolved })

const byRef = (left: CatalogueEntity, right: CatalogueEntity): number =>
  refOf(left) < refOf(right) ? -1 : refOf(left) > refOf(right) ? 1 : 0

const pathKey = (row: RelationRow): string => row.steps.map((step) => step.ref).join('\n')

/** By depth, then by what was reached, then by the path: never by the order a provider read files in. */
function ordered(rows: RelationRow[]): RelationRow[] {
  return rows.sort((left, right) => {
    const depth = left.steps.length - right.steps.length
    if (depth !== 0) return depth
    const reached = reachedBy(left).ref.localeCompare(reachedBy(right).ref, 'en')
    if (reached !== 0) return reached
    return pathKey(left).localeCompare(pathKey(right), 'en')
  })
}

/**
 * How one relation walks: which declared hop it follows, which of the
 * subject's own hops it takes, which entities it walks through and which it
 * lists, and what it reports as declared nowhere at each entity it walks.
 */
interface Walk {
  readonly next: (ref: string) => CatalogueEntity[]
  readonly first: (entity: CatalogueEntity) => boolean
  readonly through: (entity: CatalogueEntity) => boolean
  readonly listed: (entity: CatalogueEntity) => boolean
  readonly dangling: (ref: string, depth: number) => Unresolved[]
}

/**
 * Every cycle on the edges a walk followed, each as the path from the entity
 * asked about that closes on itself: depth-first over those edges, an edge
 * back to an entity still open is one. On the edges and not on the walk's
 * paths, since the walk goes through an entity once: two entities reached
 * along two branches and each depending on the other close on neither
 * branch's path. Iterative, so a long chain cannot overflow the stack.
 */
function cyclesOf(start: string, edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const open = new Set<string>([start])
  const done = new Set<string>()
  const cycles = new Map<string, string[]>()
  const stack: Array<{ ref: string; next: number }> = [{ ref: start, next: 0 }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as { ref: string; next: number }
    const out = edges.get(top.ref) ?? []
    if (top.next >= out.length) {
      open.delete(top.ref)
      done.add(top.ref)
      stack.pop()
      continue
    }
    const to = out[top.next] as string
    top.next += 1
    if (open.has(to)) {
      const cycle = [...stack.map((frame) => frame.ref), to]
      cycles.set(cycle.join('\n'), cycle)
    } else if (!done.has(to)) {
      open.add(to)
      stack.push({ ref: to, next: 0 })
    }
  }
  return [...cycles.values()].sort((left, right) =>
    left.join('\n').localeCompare(right.join('\n'), 'en'),
  )
}

/**
 * Breadth-first, with a visited set. Every declared edge from an entity the
 * walk goes through is a row when its end is one the relation lists — so two
 * rights to one object are two rows, each with its own level — and an entity
 * is walked through once, along the first path that reached it. An edge back
 * to an entity already on its own path is not a row; every edge the walk met
 * is kept, and the cycles among them are reported (`cyclesOf`).
 */
function walked(
  subject: CatalogueEntity,
  walk: Walk,
  depth: number,
): { rows: RelationRow[]; stopped: boolean; cycles: string[][] } {
  const start = stepOf(subject)
  const paths = new Map<string, Step[]>([[start.ref, [start]]])
  const seen = new Set<string>([start.ref])
  const queue = [start.ref]
  const rows: RelationRow[] = []
  // What each entity walked through leads to, among what can be walked
  // through: a cycle needs a way out of every entity on it.
  const edges = new Map<string, string[]>()
  let stopped = false

  for (let at = 0; at < queue.length; at += 1) {
    const current = queue[at] as string
    const path = paths.get(current) ?? []
    const hops = path.length - 1
    const onPath = new Set(path.map((step) => step.ref))
    const next = walk
      .next(current)
      .filter((entity) => hops > 0 || walk.first(entity))
      .sort(byRef)
    const dangling = walk.dangling(current, hops)
    // Kept at the depth bound too: an edge from there back to an entity the
    // walk listed leaves nothing unlisted, and still closes a cycle.
    edges.set(current, next.filter(walk.through).map(refOf))

    if (hops >= depth) {
      if (dangling.length > 0 || next.some((entity) => !onPath.has(refOf(entity)))) stopped = true
      continue
    }

    for (const unresolved of dangling) rows.push({ steps: [...path, nowhereOf(unresolved)] })
    for (const entity of next) {
      const ref = refOf(entity)
      if (onPath.has(ref)) continue
      const steps = [...path, stepOf(entity)]
      if (walk.listed(entity)) rows.push({ steps })
      if (seen.has(ref)) continue
      seen.add(ref)
      if (walk.through(entity)) {
        paths.set(ref, steps)
        queue.push(ref)
      }
    }
  }

  return { rows, stopped, cycles: cyclesOf(start.ref, edges) }
}

/**
 * Every simple path from `from` to `goal` along declared dependencies,
 * depth-first, shortest listed first by the caller. Bounded by the depth and
 * by a budget of entities visited; each bound says when it was reached.
 */
function searched(
  graph: EntityGraph,
  from: CatalogueEntity,
  goal: string,
  depth: number,
  budget: { left: number },
): { paths: Step[][]; stopped: boolean; exhausted: boolean } {
  const paths: Step[][] = []
  let stopped = false
  let exhausted = false

  const visit = (path: Step[], onPath: Set<string>): void => {
    if (exhausted) return
    const current = path[path.length - 1] as Step
    if (current.ref === goal && path.length > 1) {
      paths.push(path)
      return
    }
    const next = graph
      .dependenciesOf(current.ref)
      .filter((entity) => !onPath.has(refOf(entity)))
      .sort(byRef)
    if (path.length - 1 >= depth) {
      if (next.length > 0) stopped = true
      return
    }
    for (const entity of next) {
      if (budget.left <= 0) {
        exhausted = true
        return
      }
      budget.left -= 1
      const ref = refOf(entity)
      onPath.add(ref)
      visit([...path, stepOf(entity)], onPath)
      onPath.delete(ref)
    }
  }

  const start = stepOf(from)
  visit([start], new Set([start.ref]))
  return { paths, stopped, exhausted }
}

/**
 * The relation `relation` from the entity `ref`, or `undefined` when `ref` —
 * or `between`'s `to` — names no entity, or `between` has none: a relation is
 * asked of something declared, and the answer about nothing is not "none".
 */
export function relationsOf(
  graph: EntityGraph,
  ref: string,
  relation: Relation,
  options: RelationOptions = {},
): RelationResult | undefined {
  const subject = graph.get(ref)
  if (subject === undefined) return undefined
  const limit = options.rows ?? RELATION_LIMITS.rows
  const depth =
    relation === 'provides' || relation === 'provided-by'
      ? 1
      : (options.depth ??
        (relation === 'consumes' ? RELATION_LIMITS.consumesDepth : RELATION_LIMITS.depth))

  const cut = <T>(found: readonly T[]): Bounded<T> => ({
    rows: found.slice(0, limit),
    total: found.length,
  })
  const bounded = (
    found: RelationRow[],
    rest: Pick<RelationResult, 'stopped' | 'cycles'> & {
      exhausted?: boolean
      to?: Step
      shared?: Meeting[]
      nearMisses?: RelationRow[]
    },
  ): RelationResult => {
    const rows = ordered(found)
    return {
      relation,
      subject: stepOf(subject),
      ...(rest.to === undefined ? {} : { to: rest.to }),
      rows: rows.slice(0, limit),
      total: rows.length,
      ...(rest.shared === undefined || rest.shared.length === 0
        ? {}
        : { shared: cut(rest.shared) }),
      ...(rest.nearMisses === undefined || rest.nearMisses.length === 0
        ? {}
        : { nearMisses: cut(ordered(rest.nearMisses)) }),
      depth,
      stopped: rest.stopped,
      cycles: rest.cycles,
      ...(rest.exhausted === true ? { exhausted: true as const } : {}),
    }
  }

  const walkedBy = (walk: Walk): RelationResult => {
    const found = walked(subject, walk, depth)
    return bounded(found.rows, found)
  }
  const every = (): boolean => true
  const never = (): boolean => false

  /**
   * `between`'s near misses: from one end, a declaration on the way that
   * names nothing and whose name is the other end's, under another kind or
   * namespace — the right naming `component:default/payments-api` beside
   * `resource:default/payments-api`. Not a path, since nothing is there to
   * reach, and not dropped either: "no path" alone is read as "no relation"
   * of two entities a file relates. Listed from the end it was found from,
   * marked declared nowhere with the entity of its name, beside the paths
   * and never counted among them: which entity the file meant is the
   * reader's to decide (design 4.1).
   */
  const namedAfter = (end: CatalogueEntity, other: string): RelationRow[] => {
    const named = ({ sameName }: Unresolved): boolean => sameName.includes(other)
    const down = walked(end, {
      next: (at) => graph.dependenciesOf(at),
      first: every,
      through: every,
      listed: never,
      dangling: (at) => graph.unresolvedOf(at, 'dependsOn').filter(named),
    }, depth)
    const up = walked(end, {
      next: (at) => graph.dependantsOf(at),
      first: every,
      through: every,
      listed: never,
      dangling: (at) => graph.unresolvedOf(at, 'dependencyOf').filter(named),
    }, depth)
    return [...down.rows, ...up.rows.map((row) => ({ ...row, backward: true as const }))]
  }
  const component = (entity: CatalogueEntity): boolean => entity.kind === 'Component'

  /**
   * `between`'s meeting points, where no path links the two ends: the
   * entities both reach, walking one way — what both depend on, or what
   * depends on both. The nearest only: an entity is dropped when the shortest
   * path to it from each end already passes another one both reach, so two
   * services on one database meet at the database and not again at its host.
   * The one nearest either end is never dropped, so there is always one when
   * the two reach anything in common.
   */
  const meetings = (
    other: CatalogueEntity,
    toward: Meeting['relation'],
  ): { found: Meeting[]; stopped: boolean } => {
    const walk: Walk = {
      next: (at) => (toward === 'depends-on' ? graph.dependenciesOf(at) : graph.dependantsOf(at)),
      first: every,
      through: every,
      listed: every,
      dangling: () => [],
    }
    const shortest = (end: CatalogueEntity) => {
      const found = walked(end, walk, depth)
      const first = new Map<string, RelationRow>()
      for (const row of ordered(found.rows)) {
        const reached = reachedBy(row).ref
        if (!first.has(reached)) first.set(reached, row)
      }
      return { first, stopped: found.stopped }
    }
    const mine = shortest(subject)
    const theirs = shortest(other)
    const ends = new Set([ref, refOf(other)])
    const both = new Set(
      [...mine.first.keys()].filter((reached) => theirs.first.has(reached) && !ends.has(reached)),
    )
    const passes = (row: RelationRow): boolean =>
      row.steps.slice(1, -1).some((step) => both.has(step.ref))
    const found = [...both].sort().flatMap((reached): Meeting[] => {
      const from = mine.first.get(reached) as RelationRow
      const to = theirs.first.get(reached) as RelationRow
      return passes(from) && passes(to) ? [] : [{ relation: toward, paths: [from, to] }]
    })
    return { found, stopped: mine.stopped || theirs.stopped }
  }

  switch (relation) {
    case 'depends-on':
      return walkedBy({
        next: (at) => graph.dependenciesOf(at),
        first: every,
        through: every,
        listed: every,
        dangling: (at) => graph.unresolvedOf(at, 'dependsOn'),
      })
    case 'impacts':
      return walkedBy({
        next: (at) => graph.dependantsOf(at),
        first: every,
        through: every,
        listed: every,
        dangling: (at) => graph.unresolvedOf(at, 'dependencyOf'),
      })
    case 'consumes':
      // Through the subject's rights only, then onward: the objects a right is
      // over, and what they run on when asked. A service a right is over is
      // reached, and what IT consumes is its own question.
      return walkedBy({
        next: (at) => graph.dependenciesOf(at),
        first: isRight,
        through: (entity) => !component(entity),
        listed: (entity) => !isRight(entity),
        // What the subject itself declares and nothing answers to is not
        // known to be a right, so it is `depends-on`'s, not this.
        dangling: (at, hops) => (hops === 0 ? [] : graph.unresolvedOf(at, 'dependsOn')),
      })
    case 'consumed-by':
      // `consumersOf`'s walk: through everything that is not a service, to the
      // services behind it — and the services a right names and nothing
      // declares, as `unresolvedConsumersOf` lists them.
      return walkedBy({
        next: (at) => graph.dependantsOf(at),
        first: every,
        through: (entity) => !component(entity),
        listed: component,
        dangling: (at) =>
          graph.unresolvedOf(at, 'dependencyOf').filter(({ to }) => to.startsWith('component:')),
      })
    case 'provides': {
      const start = stepOf(subject)
      const found = [
        ...graph.providedApisOf(ref).map((api) => ({ steps: [start, stepOf(api)] })),
        ...graph.unresolvedOf(ref, 'providesApis').map((missing) => ({
          steps: [start, nowhereOf(missing)],
        })),
      ]
      return bounded(found, { stopped: false, cycles: [] })
    }
    case 'provided-by': {
      const start = stepOf(subject)
      const found = graph.providersOf(ref).map((provider) => ({ steps: [start, stepOf(provider)] }))
      return bounded(found, { stopped: false, cycles: [] })
    }
    case 'between': {
      if (options.to === undefined) return undefined
      const other = graph.get(options.to)
      if (other === undefined) return undefined
      const budget = { left: RELATION_LIMITS.paths }
      const forward = searched(graph, subject, options.to, depth, budget)
      const backward = searched(graph, other, ref, depth, budget)
      const found: RelationRow[] = [
        ...forward.paths.map((steps) => ({ steps })),
        ...backward.paths.map((steps) => ({ steps: [...steps].reverse(), backward: true as const })),
      ]
      // Where neither depends on the other, what relates them is what both
      // reach: "no path" alone is read as "no relation" of two services one
      // right names together.
      const shared =
        found.length === 0
          ? [meetings(other, 'depends-on'), meetings(other, 'impacts')]
          : []
      // A path is not ordered by the entity it reaches — they all reach `to` —
      // so by length, then by the path itself.
      return bounded(found, {
        stopped: forward.stopped || backward.stopped || shared.some((side) => side.stopped),
        cycles: [],
        exhausted: forward.exhausted || backward.exhausted,
        to: stepOf(other),
        shared: shared.flatMap((side) => side.found),
        nearMisses: [...namedAfter(subject, options.to), ...namedAfter(other, ref)],
      })
    }
    default: {
      const exhaustive: never = relation
      return exhaustive
    }
  }
}
