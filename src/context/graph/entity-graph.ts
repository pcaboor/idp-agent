import type {
  CatalogueEntity,
  GraphNode,
  OrganisationEntity,
  OrganisationKind,
} from '../../core/schemas/entity.js'
import { ENV_ANNOTATION } from '../../core/schemas/vocabulary.js'

export interface SearchCriteria {
  kind?: CatalogueEntity['kind']
  type?: string
  env?: string
  nameContains?: string
  owner?: string
}

export { ENV_ANNOTATION } from '../../core/schemas/vocabulary.js'

/**
 * `kind:namespace/name`, the form Backstage uses in dependsOn and dependencyOf.
 * Any node's: it reads the kind and the name alone.
 */
export function refOf(entity: GraphNode): string {
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
 * The fields a reference to the organisation is declared in: an owner and a
 * system on an entity, an API, a System or a Domain; a domain on a System; a
 * parent domain on a Domain; the memberships of a Group and a User. Kept apart
 * from `DeclaredField`, which the write model's summary, rows and gates read:
 * nothing read here reaches one of them.
 */
export type OrganisationField =
  | 'owner'
  | 'system'
  | 'domain'
  | 'subdomainOf'
  | 'memberOf'
  | 'members'
  | 'parent'
  | 'children'

/**
 * A reference to the organisation that nothing answers to, where the kind it
 * names was read whole (`OrganisationRead.judged`): declared nowhere in what
 * was read. Shaped as `Unresolved`, and never among its entries.
 */
export interface OrganisationUnresolved {
  readonly from: string
  readonly field: OrganisationField
  readonly to: string
  readonly sameName: readonly string[]
}

/**
 * A reference to the organisation that no node carries and that is not
 * declared nowhere either: `judged`, its kind read whole and the reference in
 * the catalogue, set aside and not read (a Group Backstage would refuse);
 * otherwise a name, of a kind this source was not read whole for, which
 * says nothing about whether it is declared.
 */
export interface OrganisationUnread {
  readonly from: string
  readonly field: OrganisationField
  readonly to: string
  /** The kind it names, by its own prefix or its field's default (`kindNamed`); absent when neither is one of the four. */
  readonly kind?: OrganisationKind
  readonly judged: boolean
}

/**
 * The organisation a graph holds beside its entities, and the kinds of it that
 * were read whole — a catalogue's, never a repository's (`LoadResult.judged`).
 */
export interface OrganisationRead {
  readonly nodes: readonly OrganisationEntity[]
  readonly judged: ReadonlySet<OrganisationKind>
}

/**
 * Each organisation reference a node declares, field by field in the order
 * Backstage's processor reads them. A kind without the field declares none.
 */
function organisationRefsOf(node: GraphNode): Array<[OrganisationField, string[]]> {
  switch (node.kind) {
    case 'Component':
    case 'Resource':
    case 'API':
      return [
        ['owner', [node.spec.owner]],
        ['system', node.spec.system === undefined ? [] : [node.spec.system]],
      ]
    case 'System':
      return [
        ['owner', [node.spec.owner]],
        ['domain', node.spec.domain === undefined ? [] : [node.spec.domain]],
      ]
    case 'Domain':
      return [
        ['owner', [node.spec.owner]],
        ['subdomainOf', node.spec.subdomainOf === undefined ? [] : [node.spec.subdomainOf]],
      ]
    case 'Group':
      return [
        ['parent', node.spec.parent === undefined ? [] : [node.spec.parent]],
        ['children', node.spec.children],
        ['members', node.spec.members ?? []],
      ]
    case 'User':
      return [['memberOf', node.spec.memberOf]]
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

/**
 * The kind a reference to the organisation names — its own when it states
 * one, as the reader wrote it in full, else the one its field defaults to —
 * which decides whether it is judged at all.
 */
const FIELD_KINDS: Readonly<Record<OrganisationField, OrganisationKind>> = {
  owner: 'Group',
  system: 'System',
  domain: 'Domain',
  subdomainOf: 'Domain',
  memberOf: 'Group',
  members: 'User',
  parent: 'Group',
  children: 'Group',
}
const JUDGED_KINDS: ReadonlyMap<string, OrganisationKind> = new Map([
  ['group', 'Group'],
  ['user', 'User'],
  ['system', 'System'],
  ['domain', 'Domain'],
])
const kindNamed = (ref: string, field: OrganisationField): OrganisationKind | undefined => {
  const stated = /^([a-z]+):/.exec(ref)?.[1]
  return stated === undefined ? FIELD_KINDS[field] : JUDGED_KINDS.get(stated)
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
  /**
   * The organisation, by reference, the first declaration of each winning as
   * for entities. A map of its own and never `byRef`, which `get()`, `all()`
   * and the dangling check read: a Group there would reach every one of them.
   */
  private readonly organisationByRef: Map<string, OrganisationEntity>
  /** Owner reference → the nodes that name it their owner. */
  private readonly owners: Map<string, Set<string>>
  /** Group → its Users, and User → its Groups, each read from both ends. */
  private readonly members: Map<string, Set<string>>
  private readonly groups: Map<string, Set<string>>
  /** Group → its child Groups, and child → its parents, each read from both ends. */
  private readonly children: Map<string, Set<string>>
  private readonly parents: Map<string, Set<string>>
  /** System or Domain → what names it as its system, domain or parent domain; and back. */
  private readonly parts: Map<string, Set<string>>
  private readonly wholes: Map<string, Set<string>>
  /** Node reference → what it declares of the organisation, judged and naming nothing. */
  private readonly organisationUnresolved: Map<string, OrganisationUnresolved[]>
  /** The organisation kinds read whole (`OrganisationRead.judged`). */
  private readonly judged: ReadonlySet<OrganisationKind>
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
    organisation: OrganisationRead,
  ) {
    // A reference two documents declare is the FIRST of them, whole: its
    // fields and the references it declares. That is how the catalogue
    // resolves a duplicate (design 4.4), and how the plan does — `planEdits`
    // amends the first, the re-check names it, the Reviewer is told it — so
    // `show`, the Analyst and the relations describe the declaration a plan
    // would touch. The graph kept the last (domain-backstage-10). The second
    // is still in `all()`: the duplicate is `validate`'s to report, never
    // this graph's to drop in silence.
    this.byRef = new Map()
    for (const entity of entities) {
      if (!this.byRef.has(refOf(entity))) this.byRef.set(refOf(entity), entity)
    }
    const declarations = [...this.byRef.values()]
    this.organisationByRef = new Map()
    for (const node of organisation.nodes) {
      if (!this.organisationByRef.has(refOf(node))) this.organisationByRef.set(refOf(node), node)
    }
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
    for (const entity of declarations) {
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
    for (const entity of declarations) {
      const from = refOf(entity)
      const declared: Array<[DeclaredField, string[]]> = [
        ['dependsOn', dependsOnOf(entity)],
        ['dependencyOf', dependencyOfOf(entity)],
        ['providesApis', providesOf(entity)],
      ]
      const found: Unresolved[] = []
      for (const [field, targets] of declared) {
        for (const to of targets) {
          // The organisation read resolves a reference as a document set aside
          // did: it exists, and is no entity of this graph.
          if (this.byRef.has(to) || this.organisationByRef.has(to) || this.aside.has(to)) continue
          const sameName = [...(byName.get(nameOf(to)) ?? [])].sort()
          found.push({ from, field, to, sameName })
        }
      }
      this.dangling.push(...found)
      // Keyed as `byRef` is, so a duplicate is read as `get` reads it: the first.
      this.unresolved.set(from, found)
    }

    // The organisation, read from both ends as a dependency is: a Group's
    // `children` and a child's `parent` are one edge, a Group's `members` and
    // a User's `memberOf` another, and a part names its whole — a System is
    // what its parts' `spec.system` say, as Backstage's processor emits
    // `partOf` from the part. Over the first declaration of every node.
    this.owners = new Map()
    this.members = new Map()
    this.groups = new Map()
    this.children = new Map()
    this.parents = new Map()
    this.parts = new Map()
    this.wholes = new Map()
    this.organisationUnresolved = new Map()
    this.judged = new Set(organisation.judged)
    const nodes: GraphNode[] = [...declarations, ...this.organisationByRef.values()]
    for (const node of nodes) {
      const ref = refOf(node)
      for (const [field, targets] of organisationRefsOf(node)) {
        for (const target of targets) {
          switch (field) {
            case 'owner':
              this.link(this.owners, target, ref)
              break
            case 'system':
            case 'domain':
            case 'subdomainOf':
              this.link(this.parts, target, ref)
              this.link(this.wholes, ref, target)
              break
            case 'memberOf':
              this.link(this.members, target, ref)
              this.link(this.groups, ref, target)
              break
            case 'members':
              this.link(this.members, ref, target)
              this.link(this.groups, target, ref)
              break
            case 'parent':
              this.link(this.children, target, ref)
              this.link(this.parents, ref, target)
              break
            case 'children':
              this.link(this.children, ref, target)
              this.link(this.parents, target, ref)
              break
            default: {
              const exhaustive: never = field
              return exhaustive
            }
          }
        }
      }
    }

    // A reference to the organisation is judged only where its kind was read
    // whole — a catalogue's read, never a repository's Group files, which are
    // what it happens to hold and not the organisation. Judged, it resolves
    // against every node and every document set aside — a Group of another
    // namespace or one Backstage would refuse is there, only not read — and
    // names nothing only when none holds it.
    const allByName = new Map<string, string[]>()
    for (const ref of [...this.byRef.keys(), ...this.organisationByRef.keys()]) {
      const name = nameOf(ref)
      allByName.set(name, [...(allByName.get(name) ?? []), ref])
    }
    for (const node of nodes) {
      const from = refOf(node)
      const found: OrganisationUnresolved[] = []
      for (const [field, targets] of organisationRefsOf(node)) {
        for (const to of targets) {
          const kind = kindNamed(to, field)
          if (kind === undefined || !organisation.judged.has(kind)) continue
          if (this.byRef.has(to) || this.organisationByRef.has(to) || this.aside.has(to)) continue
          found.push({ from, field, to, sameName: [...(allByName.get(nameOf(to)) ?? [])].sort() })
        }
      }
      this.organisationUnresolved.set(from, found)
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
   * `aside` holds the references of documents read and not modelled — a
   * Location, a Group Backstage would refuse. They are no entity of this
   * graph, but a reference to one is not dangling: the repository declares
   * it. `plan` puts the repository's APIs and organisation there too: it
   * decides against the write model, where each is a reference that resolves
   * and never a node.
   *
   * `organisation` is the organisation read beside the entities: never in
   * `all()`, `get()` or `search()`, so nothing built from them — a table, a
   * summary, a vocabulary, a tool's row — sees a Group. `node()` and
   * `nodes()` read both, and the organisation's own queries below.
   */
  static from(
    entities: readonly CatalogueEntity[],
    aside: Iterable<string> = [],
    organisation: OrganisationRead = { nodes: [], judged: new Set() },
  ): EntityGraph {
    return new EntityGraph([...entities], new Set(aside), organisation)
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

  /** An entity, or an organisation node: what `show` and `relations` resolve a reference to. */
  node(ref: string): GraphNode | undefined {
    return this.byRef.get(ref) ?? this.organisationByRef.get(ref)
  }

  /** `all()`, then the organisation — each node once, the first declaration — sorted by reference. */
  nodes(): GraphNode[] {
    return [...this.entities, ...this.organisationNodes()]
  }

  /** Whether the graph holds at least one organisation node: a Group, a User, a System or a Domain read. */
  get holdsOrganisation(): boolean {
    return this.organisationByRef.size > 0
  }

  /** The organisation, each node once, sorted by reference. */
  private organisationNodes(): OrganisationEntity[] {
    return [...this.organisationByRef.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, node]) => node)
  }

  /** Present nodes only, entities or organisation, sorted by reference. */
  private presentNodes(refs: Iterable<string>): GraphNode[] {
    return [...refs]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap((ref) => this.node(ref) ?? [])
  }

  /** What names `ref` as its owner — entities, APIs, Systems and Domains — sorted. */
  ownedBy(ref: string): GraphNode[] {
    return this.presentNodes(this.owners.get(ref) ?? [])
  }

  /** A Group's Users: its `members`, and every User whose `memberOf` names it. Sorted. */
  membersOf(ref: string): GraphNode[] {
    return this.presentNodes(this.members.get(ref) ?? [])
  }

  /** A User's Groups: its `memberOf`, and every Group whose `members` names it. Sorted. */
  groupsOf(ref: string): GraphNode[] {
    return this.presentNodes(this.groups.get(ref) ?? [])
  }

  /** A Group's child Groups: its `children`, and every Group whose `parent` names it. Sorted. */
  childrenOf(ref: string): GraphNode[] {
    return this.presentNodes(this.children.get(ref) ?? [])
  }

  /** A Group's parents: its `parent`, and every Group whose `children` names it. Sorted. */
  parentsOf(ref: string): GraphNode[] {
    return this.presentNodes(this.parents.get(ref) ?? [])
  }

  /** A System's entities, a Domain's Systems and subdomains: what names it. Sorted. */
  partsOf(ref: string): GraphNode[] {
    return this.presentNodes(this.parts.get(ref) ?? [])
  }

  /** What a node's system, domain or parent domain names, present nodes only. */
  wholeOf(ref: string): GraphNode[] {
    return this.presentNodes(this.wholes.get(ref) ?? [])
  }

  /**
   * What a node declares of the organisation, in one field, that nothing
   * answers to — judged only (`OrganisationRead.judged`), so empty wherever
   * the kind it names was not read whole. Never among `unresolvedOf` or
   * `danglingReferences`: those are the write model's, and what the summary,
   * the Analyst's rows and `ask` read.
   */
  unresolvedOrganisationOf(ref: string, field: OrganisationField): OrganisationUnresolved[] {
    return (this.organisationUnresolved.get(ref) ?? []).filter((found) => found.field === field)
  }

  /**
   * What a node declares of the organisation, in one field, that no node
   * carries and that `unresolvedOrganisationOf` does not call declared
   * nowhere: set aside where its kind is judged, a name where it is not. In
   * the order the file declares them, each once. The relations end a path on
   * the first and say the second is read as a name (`context/graph/relations.ts`).
   */
  unreadOrganisationOf(ref: string, field: OrganisationField): OrganisationUnread[] {
    const node = this.node(ref)
    if (node === undefined) return []
    const declared = organisationRefsOf(node).flatMap(([at, targets]) => (at === field ? targets : []))
    return [...new Set(declared)].flatMap((to): OrganisationUnread[] => {
      if (this.node(to) !== undefined) return []
      const kind = kindNamed(to, field)
      const judged = kind !== undefined && this.judged.has(kind)
      if (judged && !this.aside.has(to)) return []
      return [{ from: ref, field, to, ...(kind === undefined ? {} : { kind }), judged }]
    })
  }

  /** Whether the graph holds at least one organisation node of `kind`. */
  holdsKind(kind: OrganisationKind): boolean {
    for (const node of this.organisationByRef.values()) if (node.kind === kind) return true
    return false
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
