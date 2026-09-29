import type { z } from 'zod'
import {
  ORGANISATION_KINDS,
  entityRefSchema,
  type CatalogueEntity,
  type GraphNode,
  type OrganisationEntity,
} from '../../core/schemas/entity.js'
import {
  QUERY_LIMITS,
  answerSchema,
  answerSchemaWithoutRelation,
  apiSearchCriteriaSchema,
  getApisInputSchema,
  getDependenciesInputSchema,
  getEntityInputSchema,
  getRelationsInputSchema,
  organisationAnswerSchema,
  organisationRelationsInputSchema,
  organisationSearchCriteriaSchema,
  searchCriteriaSchema,
  type SearchCriteria,
} from '../../core/schemas/query.js'
import { levelledOf } from '../../core/schemas/resource-types.js'
import {
  ENV_ANNOTATION,
  refOf,
  type DeclaredField,
  type EntityGraph,
  type OrganisationField,
  type OrganisationUnresolved,
  type Unresolved,
} from '../../context/graph/entity-graph.js'
import {
  RELATION_LIMITS,
  reachedBy,
  relationsOf,
  type Meeting,
  type Named,
  type RelationResult,
  type RelationRow,
  type Step,
} from '../../context/graph/relations.js'
import type { ModelToolCall, ModelToolSpec } from '../../llm/client.js'

export interface ToolOutcome {
  result: unknown
  rows: number
  truncated: number
  /**
   * What the tool refused the call with, when it did: the same text the model
   * reads in `result`. Beside it, not dug back out of it, so the stream can say
   * a call was refused — a refused call reads no rows, and "0 row(s)" is what a
   * search that ran and found nothing looks like.
   */
  error?: string
  /**
   * Every entity this call returned — its rows, what a row names, the steps of
   * a path — as `witnessed` gained them. Not sent to the model: it is what
   * says which search an answer's references came from, and so whose cut
   * rows the answer is short by (`answerQuestion`'s `truncated`). Absent when
   * the call returned none.
   */
  returned?: readonly string[]
  /**
   * The references beside the rows that name nothing (`danglingReferences`),
   * on the Analyst's registry. Not rows, since none is an entity, but read: a
   * turn that showed one found what the catalogue declares, and is not a
   * turn that read nothing.
   */
  dangling?: number
}

/** Returned, never thrown: the loop continues and the model reads the reason. */
export const refused = (error: string): ToolOutcome => ({
  result: { error },
  rows: 0,
  truncated: 0,
  error,
})

/** Declare, never infer: an absent value is stated as absent (design 4.1). */
const UNDECLARED = '(undeclared)'

/**
 * The columns `renderTable` prints, plus what a right grants — so an answer and
 * a table cannot disagree about which entities were read.
 *
 * `access` is the one field the table has not got, and the asymmetry is the
 * point: a reader who wants the level of one grant runs `show`, which prints
 * it; a model has only the row. Without it, deciding whether an existing grant
 * already covers the request — or may be joined with `add-dependency-of`, whose
 * `access` states that grant's level — is a guess, and `declared-level-mismatch`
 * then refuses the plan for a fact the model was never shown.
 */
interface Row {
  ref: string
  name: string
  kind: string
  type: string
  access?: string
  env: string
  owner: string
}

/**
 * The Analyst's row, which also says what an entity declares about Backstage's
 * APIs (`buildTools`' `apis`). An API's row carries what `show`'s card prints
 * of it — its lifecycle, that its definition is declared (never the
 * definition), what its file says it is (description, system, tags, links)
 * and the components that provide it: the Architect never reads an API row,
 * so it is free to say all of that. A Component's row carries the APIs it
 * provides, and only when it provides one; any row other than an API's
 * carries `danglingReferences` when its entity declares a reference that
 * names nothing (`Dangling`). Every other row is the Architect's row, byte
 * for byte.
 */
interface ApiRow extends Row {
  lifecycle?: string
  definition?: string
  description?: string
  system?: string
  tags?: string[]
  links?: Array<{ url: string; title?: string }>
  provides?: string[]
  providedBy?: string[]
  danglingReferences?: Dangling[]
  danglingTruncated?: string
}

/**
 * A Group, a User, a System or a Domain as the Analyst reads it, on the
 * organisation registry: its reference, name, kind and the type it states,
 * then what its card lists (`renderOrganisationDetail`) — a Group's parent,
 * children, members and what it owns; a User's groups and what it owns; a
 * System's owner, domain and what it contains; a Domain's owner, parent
 * domain, systems and subdomains — each list read from both ends, at most
 * `maxRows` with `<list>Truncated` beside it, and `danglingReferences` for
 * what it declares that is declared nowhere where its kind was read whole.
 * Nothing else: no title, no annotation, no profile, which the reader never
 * keeps.
 */
interface OrganisationRow {
  ref: string
  name: string
  kind: string
  [field: string]: unknown
}

/**
 * A reference the catalogue declares and no entity answers to, as the
 * Analyst reads it: on the row of the entity that declares it, and beside
 * the rows of a query whose answer it belongs to — never among them, since
 * `rows` are entities, each one witnessed, and this is none. `declared:
 * false` says so in the object itself, whatever the key it sits under, and
 * `sameName` names the entities of its name — real ones, which the model may
 * read and answer with, and which the prompt tells it not to take for the
 * reference. The summary's "dangling references" are these.
 */
interface Dangling {
  ref: string
  declared: false
  /**
   * An `OrganisationField` only on the organisation registry: an
   * organisation row's own references, and the steps of an organisation
   * relation. An entity's row carries the write model's three alone.
   */
  field: DeclaredField | OrganisationField
  declaredBy: string
  sameName: string[]
}

const danglingOf = ({ to, field, from, sameName }: Unresolved | OrganisationUnresolved): Dangling => ({
  ref: to,
  declared: false,
  field,
  declaredBy: from,
  sameName: [...sameName],
})

/**
 * Whether an organisation reference is one: `kind:namespace/name`, as the
 * reader qualifies every reference its grammar splits. One it cannot split is
 * kept as the file wrote it (`organisationRefSchema`), and can be anything a
 * person typed there — an email among a Group's members, an address as a
 * System's owner. The model is never shown one, only how many (SECURITY.md:
 * of a person, a User's name and groups reach the provider, nothing else).
 */
const isReference = (ref: string): boolean => entityRefSchema.safeParse(ref).success

/** What a list, a row or a result says in place of what it declares that is no reference. */
const notReferences = (count: number): string =>
  `${count} not shown: ${count === 1 ? 'it is not an entity reference' : 'they are not entity references'}`

/** What a field that names one says in place of a value that is no reference. */
const NOT_A_REFERENCE = 'not shown: not an entity reference'

/**
 * At most as many as a result's rows, and the cut stated beside them as the
 * rows' is: a consumers walk over an object many rights reach can name any
 * number, and a model that believed it had seen them all would say so.
 */
const boundedOf = (
  unresolved: ReadonlyArray<Unresolved | OrganisationUnresolved>,
): { shown: Dangling[]; fields: Pick<ApiRow, 'danglingReferences' | 'danglingTruncated'> } => {
  const shown = unresolved.slice(0, QUERY_LIMITS.maxRows).map(danglingOf)
  const cut = unresolved.length - shown.length
  return {
    shown,
    fields: {
      ...(shown.length === 0 ? {} : { danglingReferences: shown }),
      ...(cut > 0 ? { danglingTruncated: `${cut} more not shown` } : {}),
    },
  }
}

/**
 * What a row says about the level a right grants.
 *
 * Only a levelled type gets the field at all. An object grants nothing, and a
 * `network-access` is opened or it is not — `proposedResourceSchema` refuses a
 * level on either, so offering one here would invite the model to state a field
 * the plan boundary then rejects. This is where the tool and `show` differ on
 * purpose: `show` prints the line for every right because the registry was not
 * the thing it was reading; a row is read by the agent that has to propose.
 *
 * On a levelled right the field is always present, `(undeclared)` included.
 * `resourceSchema` leaves `access` optional so a repository written before the
 * field still parses, and an absent KEY would read as "this tool does not
 * report levels", which is a different fact from "the repository states none".
 * What is never written is a level nobody declared: that is the guess
 * `serialize.ts` refuses on the write side, refused here on the read side.
 */
const accessOf = (entity: CatalogueEntity): { access: string } | Record<string, never> =>
  entity.kind === 'Resource' && levelledOf(entity.spec.type)
    ? { access: entity.spec.access ?? UNDECLARED }
    : {}

const rowOf = (entity: CatalogueEntity): Row => ({
  ref: refOf(entity),
  name: entity.metadata.name,
  kind: entity.kind,
  type: entity.spec.type,
  // Directly after the type, for the reason `serialize.ts` files it there: "a
  // database-access, granting read" is one statement, not two.
  ...accessOf(entity),
  env: entity.metadata.annotations[ENV_ANNOTATION] ?? UNDECLARED,
  owner: entity.spec.owner,
})

const failed = (tool: string, error: z.ZodError): ToolOutcome =>
  // Returned, not thrown: the loop has to be able to continue after a bad call,
  // and the model has to be able to read what was wrong with it.
  refused(`${tool}: ${error.issues[0]?.message ?? 'invalid arguments'}`)

/** How many values in use a refusal names before it counts the rest. */
const MAX_NAMED = 10

const listed = (values: ReadonlySet<string>): string => {
  const sorted = [...values].sort()
  const named = sorted.slice(0, MAX_NAMED).join(', ')
  return sorted.length > MAX_NAMED ? `${named} and ${sorted.length - MAX_NAMED} more` : named
}

/**
 * The criteria of a search that no entity in the catalogue carries, each said
 * with the values that are in use.
 *
 * A real model fills every optional criterion it is shown, and an invented one
 * — `env: "default"` on a catalogue that declares no environment — used to
 * come back as an empty result: a search that could never have matched,
 * reading exactly like one that ran and found nothing, and the question ended
 * on "No entity matches". Said as an error, it is something the model can act
 * on. Only an exact value is checked: `nameContains` is a fragment, and an
 * empty result for one is an answer.
 *
 * An empty catalogue refuses nothing: every value is unused there, and the
 * empty result is the whole truth.
 */
function unusedCriteria(graph: EntityGraph, criteria: SearchCriteria, organisation: boolean): string[] {
  const entities = graph.all()
  // The organisation's kinds, types and owners are in use as much as the
  // entities' are, on the registry that searches them.
  const nodes: GraphNode[] = organisation ? graph.nodes() : entities
  if (nodes.length === 0) return []
  const unused: string[] = []

  const check = (
    label: string,
    plural: string,
    value: string | undefined,
    of: (node: GraphNode) => string | undefined,
  ): void => {
    if (value === undefined) return
    const inUse = new Set(nodes.flatMap((node) => of(node) ?? []))
    if (!inUse.has(value)) {
      unused.push(`${label} "${value}" matches no entity; ${plural} in use: ${listed(inUse)}`)
    }
  }
  check('kind', 'kinds', criteria.kind, (node) => node.kind)
  check('type', 'types', criteria.type, typeOf)

  const kind = criteria.kind
  if (criteria.env !== undefined && kind !== undefined && isOrganisationKind(kind)) {
    // No Group, User, System or Domain states an environment: a search for
    // one of them with an env could never match, whatever the entities use.
    unused.push(`env "${criteria.env}" matches no ${kind}: a ${kind} declares no environment — omit env`)
  } else if (criteria.env !== undefined) {
    // An entity with no environment is matched by no env value — unchanged, and
    // said, since omitting env is then the only way to reach it.
    const declared = entities.map((entity) => entity.metadata.annotations[ENV_ANNOTATION])
    const inUse = new Set(declared.filter((env): env is string => env !== undefined))
    const none = declared.length - declared.filter((env) => env !== undefined).length
    if (inUse.size === 0) {
      unused.push(
        `env "${criteria.env}" matches no entity: this catalogue declares no environment — omit env`,
      )
    } else if (!inUse.has(criteria.env)) {
      unused.push(
        `env "${criteria.env}" matches no entity; environments in use: ${listed(inUse)}` +
          (none > 0
            ? `; ${none} ${none === 1 ? 'entity declares' : 'entities declare'} none — omit env to include it`
            : ''),
      )
    }
  }

  // An owner a System or a Domain wrote that is no reference is not named:
  // it can be a person's address. Every entity's owner is one.
  check('owner', 'owners', criteria.owner, (node) => {
    const owner = ownerOf(node)
    return owner !== undefined && isReference(owner) ? owner : undefined
  })
  return unused
}

const ORGANISATION: ReadonlySet<string> = new Set(ORGANISATION_KINDS)
const isOrganisationKind = (kind: string): boolean => ORGANISATION.has(kind)
const isOrganisation = (node: GraphNode): node is OrganisationEntity => isOrganisationKind(node.kind)

/** The type a node states: every entity one, a Group one, a System or a Domain when it does, a User none. */
function typeOf(node: GraphNode): string | undefined {
  switch (node.kind) {
    case 'Component':
    case 'Resource':
    case 'API':
    case 'Group':
    case 'System':
    case 'Domain':
      return node.spec.type
    case 'User':
      return undefined
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

/** The owner a node declares: every entity, a System and a Domain; a Group and a User none. */
function ownerOf(node: GraphNode): string | undefined {
  switch (node.kind) {
    case 'Component':
    case 'Resource':
    case 'API':
    case 'System':
    case 'Domain':
      return node.spec.owner
    case 'Group':
    case 'User':
      return undefined
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

/**
 * The organisation `search_entities` finds: the nodes of the kind asked for,
 * or of every organisation kind when none is, by their type, their owner and
 * a fragment of their name. None states an environment, so a search with one
 * finds none of them — refused before it runs when the kind is theirs.
 */
function organisationSearch(graph: EntityGraph, criteria: SearchCriteria): OrganisationEntity[] {
  if (criteria.env !== undefined) return []
  if (criteria.kind !== undefined && !isOrganisationKind(criteria.kind)) return []
  return graph.nodes().filter(isOrganisation).filter((node) => {
    if (criteria.kind !== undefined && node.kind !== criteria.kind) return false
    if (criteria.type !== undefined && typeOf(node) !== criteria.type) return false
    if (criteria.owner !== undefined && ownerOf(node) !== criteria.owner) return false
    if (criteria.nameContains !== undefined && !node.metadata.name.includes(criteria.nameContains)) {
      return false
    }
    return true
  })
}

/**
 * One step of a path as the Analyst reads it: the entity, its environment —
 * `(undeclared)` when it declares none, as a row says it — and, on a right,
 * that it is one and the level it states when its type states one
 * (`accessOf`'s rule: a `network-access` has no level to state).
 */
interface PathStep {
  ref: string
  kind: string
  type: string
  env: string
  right?: true
  access?: string
}

/**
 * A step of the organisation — a Group, a User, a System, a Domain — as the
 * Analyst reads it: its kind, and its type when it states one. Never an
 * environment, which none of them has, and never a right. Only an
 * organisation relation reaches one.
 */
interface OrganisationStep {
  ref: string
  kind: string
  type?: string
}

type AnyStep = PathStep | OrganisationStep

/**
 * A row of `get_relations`: what was reached, how far, and the whole path to
 * it. An entity reached is read as its step is, less the right; a node of the
 * organisation, as its step.
 */
type RelationReading = (Omit<PathStep, 'right'> | OrganisationStep) & {
  depth: number
  path: AnyStep[]
  /** `between` only: which of the two depends on the other. */
  direction?: string
}

const pathStepOf = (step: Step): AnyStep =>
  step.kind !== undefined && isOrganisationKind(step.kind)
    ? { ref: step.ref, kind: step.kind, ...(step.type === undefined ? {} : { type: step.type }) }
    : {
        ref: step.ref,
        kind: step.kind ?? UNDECLARED,
        type: step.type ?? UNDECLARED,
        env: step.env ?? UNDECLARED,
        ...(step.right === undefined ? {} : { right: true as const }),
        ...(step.right?.levelled === true ? { access: step.right.level ?? UNDECLARED } : {}),
      }

const FORWARD = 'the first entity depends on the last'
const BACKWARD = 'the last entity depends on the first'

/** `between`'s entity both ends reach, as the Analyst reads it: which way, and the path from each end. */
interface SharedReading {
  both: string
  ref: string
  kind: string
  type: string
  env: string
  access?: string
  paths: [PathStep[], PathStep[]]
}

const BOTH: Record<Meeting['relation'], string> = {
  'depends-on': 'both depend on it',
  impacts: 'it depends on both',
}

/** A step of `between`, whose two ends and every step between are entities. */
const entityPathStepOf = (step: Step): PathStep => pathStepOf(step) as PathStep

function sharedOf(meeting: Meeting): SharedReading {
  const [mine, theirs] = meeting.paths
  const { ref, kind, type, env, access } = entityPathStepOf(reachedBy(mine))
  return {
    both: BOTH[meeting.relation],
    ref,
    kind,
    type,
    env,
    ...(access === undefined ? {} : { access }),
    paths: [mine.steps.map(entityPathStepOf), theirs.steps.map(entityPathStepOf)],
  }
}

function readingOf(result: RelationResult, row: RelationRow): RelationReading {
  const path = row.steps.map(pathStepOf)
  const last = path[path.length - 1] as AnyStep
  const reached: Omit<PathStep, 'right'> | OrganisationStep =
    'env' in last
      ? {
          ref: last.ref,
          kind: last.kind,
          type: last.type,
          env: last.env,
          ...(last.access === undefined ? {} : { access: last.access }),
        }
      : last
  return {
    ...reached,
    depth: row.steps.length - 1,
    path,
    ...(result.relation === 'between'
      ? { direction: row.backward === true ? BACKWARD : FORWARD }
      : {}),
  }
}

/**
 * A reference an organisation relation reached that the catalogue serves and
 * this tool set aside — a Group Backstage would refuse: in the catalogue, not
 * read, and never an entity or a node the model may answer with.
 */
interface SetAside {
  ref: string
  read: false
  why: string
  path: AnyStep[]
}

const SET_ASIDE = 'in the catalogue, and set aside: not read'

/**
 * What the subject of an organisation relation declares for its first hop
 * that is read as a name, and why (`Named`): never a row, never witnessed.
 */
interface NameRead {
  ref: string
  field: OrganisationField
  declaredBy: string
  why: string
}

const nameReadOf = (name: Named): NameRead => ({
  ref: name.to,
  field: name.field,
  declaredBy: name.from,
  why:
    name.kind === undefined
      ? 'this source holds nothing of that name'
      : name.held
        ? `read as a name: the ${name.kind} files this source holds are not the whole organisation`
        : `read as a name: this source holds no ${name.kind}`,
})

export function buildTools(
  graph: EntityGraph,
  options: {
    /**
     * Refuse a search on a value no entity carries (see `unusedCriteria`).
     * Off for the Architect alone (`plan` and `init`), pending a decision. Its
     * plan-mode tapes were recorded against the silent empty result, a tool
     * result is part of every later request's digest, and four of its five
     * searched on a kind, type or owner the catalogue does not use. But turning
     * it on is not only a re-recording: the Architect reads an empty result as
     * a finding — no `database-access` grant yet is how it learns to propose
     * one — and an error there changes what it is told on a normal path. The
     * follow-up is to decide that, re-record those four tapes, and delete this
     * option.
     */
    refuseUnusedValues?: boolean
    /**
     * The Analyst's registry: Backstage's APIs are found and read. A search
     * may ask for kind `API`, `get_apis` reads who provides what, and a row
     * says what its entity declares about APIs (`ApiRow`). Off for the
     * Architect (`plan` and `init`), whose specs, and whose rows for any entity
     * that declares nothing about an API, are the ones its plan-mode tapes were
     * recorded against — and which proposes neither an API nor what provides
     * one, so has nothing to look one up for.
     */
    apis?: boolean
    /**
     * The organisation, on the Analyst's registry (`apis`) and only there:
     * Groups, Users, Systems and Domains are found with `search_entities`,
     * read with `get_entity` (`OrganisationRow`) and walked with the six
     * organisation relations of `get_relations`, and `answer` may name one of
     * those. `ask` sets it when the graph holds an organisation node
     * (`holdsOrganisation`): over a source that holds none — the demo SI,
     * every tape's — the specs are the ones those tapes were recorded
     * against, byte for byte, and so is every row.
     */
    organisation?: boolean
  } = {},
): {
  specs: ModelToolSpec[]
  run(call: ModelToolCall): ToolOutcome
  witnessed: ReadonlySet<string>
  /**
   * The references naming nothing that a result showed, as `declared: false`
   * objects: values the model read, which a sentence may quote (ask.ts's
   * `known`). Never entities, so never in `witnessed`. Empty on the
   * Architect's registry, which shows none.
   */
  declaredNowhere: ReadonlySet<string>
  /** The answer schema `answer` advertises: the loop parses the answer with it. */
  answer: typeof answerSchema | typeof organisationAnswerSchema | typeof answerSchemaWithoutRelation
  /** Whether the registry reads the organisation: the Analyst's prompt then says how. */
  organisation: boolean
} {
  // What the ENGINE returned. The answer tool never adds to it: a model that
  // could witness its own invention would defeat the check entirely.
  const witnessed = new Set<string>()
  const declaredNowhere = new Set<string>()
  const apis = options.apis ?? false
  const organisation = apis && (options.organisation ?? false)

  /**
   * A row, and every reference it names: the entity's own, and — on the
   * Analyst's row — the APIs and providers it lists, which are present
   * entities the engine returned and so may be answered with.
   */
  const read = (entity: CatalogueEntity): { row: Row | ApiRow; refs: string[] } => {
    const row = rowOf(entity)
    if (!apis) return { row, refs: [row.ref] }
    if (entity.kind === 'API') {
      const providedBy = graph.providersOf(row.ref).map(refOf)
      const { ref, name, kind, type, env, owner } = row
      const { description, tags, links } = entity.metadata
      return {
        row: {
          ref,
          name,
          kind,
          type,
          lifecycle: entity.spec.lifecycle,
          definition: entity.spec.definition,
          env,
          owner,
          ...(description === undefined ? {} : { description }),
          ...(entity.spec.system === undefined ? {} : { system: entity.spec.system }),
          ...(tags === undefined || tags.length === 0 ? {} : { tags }),
          ...(links === undefined || links.length === 0
            ? {}
            : {
                links: links.map(({ url, title }) => ({
                  url,
                  ...(title === undefined ? {} : { title }),
                })),
              }),
          providedBy,
        },
        refs: [ref, ...providedBy],
      }
    }
    const provides = graph.providedApisOf(row.ref).map(refOf)
    const dangling = boundedOf(graph.unresolvedOf(row.ref))
    for (const { ref } of dangling.shown) declaredNowhere.add(ref)
    return {
      row: { ...row, ...(provides.length === 0 ? {} : { provides }), ...dangling.fields },
      refs: [row.ref, ...provides, ...dangling.shown.flatMap(({ sameName }) => sameName)],
    }
  }

  /**
   * A Group, a User, a System or a Domain as the Analyst reads it
   * (`OrganisationRow`), and every reference it names that resolves — a
   * node the engine returned, which the model may then answer with.
   */
  const readOrganisation = (node: OrganisationEntity): { row: OrganisationRow; refs: string[] } => {
    const ref = refOf(node)
    const refs = [ref]
    const row: OrganisationRow = { ref, name: node.metadata.name, kind: node.kind }
    const type = typeOf(node)
    if (type !== undefined) row['type'] = type

    /**
     * A reference the node declares in one field, as written; witnessed when a
     * node answers to it. One that is no reference is said not to be, never
     * shown.
     */
    const scalar = (field: string, value: string | undefined): void => {
      if (value === undefined) return
      row[field] = isReference(value) ? value : NOT_A_REFERENCE
      if (graph.node(value) !== undefined) refs.push(value)
    }

    /**
     * One list, as the card prints it (`renderOrganisationDetail`): the nodes
     * read from both ends, then what the node declares there that no node
     * carries and is not declared nowhere — a name, or a document set aside,
     * neither of them witnessed. At most `maxRows`, the cut stated beside it;
     * what it declares that is no reference is counted beside it, never shown.
     */
    const list = (
      field: string,
      nodes: readonly GraphNode[],
      at?: OrganisationField,
      declared: readonly string[] = [],
    ): void => {
      const nowhere = new Set(
        at === undefined ? [] : graph.unresolvedOrganisationOf(ref, at).map(({ to }) => to),
      )
      const unique = declared.filter((target, index) => declared.indexOf(target) === index)
      const names = unique.filter(
        (target) => isReference(target) && graph.node(target) === undefined && !nowhere.has(target),
      )
      const all = [...nodes.map(refOf), ...names]
      const shown = all.slice(0, QUERY_LIMITS.maxRows)
      row[field] = shown
      if (all.length > shown.length) row[`${field}Truncated`] = `${all.length - shown.length} more not shown`
      const hidden = unique.filter((target) => !isReference(target)).length
      if (hidden > 0) row[`${field}NotShown`] = notReferences(hidden)
      for (const target of shown) if (graph.node(target) !== undefined) refs.push(target)
    }

    let fields: OrganisationField[]
    switch (node.kind) {
      case 'Group':
        list('parent', graph.parentsOf(ref), 'parent', node.spec.parent === undefined ? [] : [node.spec.parent])
        list('children', graph.childrenOf(ref), 'children', node.spec.children)
        list('members', graph.membersOf(ref), 'members', node.spec.members ?? [])
        list('owns', graph.ownedBy(ref))
        fields = ['parent', 'children', 'members']
        break
      case 'User':
        list('memberOf', graph.groupsOf(ref), 'memberOf', node.spec.memberOf)
        list('owns', graph.ownedBy(ref))
        fields = ['memberOf']
        break
      case 'System':
        scalar('owner', node.spec.owner)
        scalar('domain', node.spec.domain)
        list('contains', graph.partsOf(ref))
        fields = ['owner', 'domain']
        break
      case 'Domain': {
        scalar('owner', node.spec.owner)
        scalar('subdomainOf', node.spec.subdomainOf)
        const parts = graph.partsOf(ref)
        list('systems', parts.filter(({ kind }) => kind === 'System'))
        // Only when it has some, as the card lists them.
        const subdomains = parts.filter(({ kind }) => kind === 'Domain')
        if (subdomains.length > 0) list('subdomains', subdomains)
        fields = ['owner', 'subdomainOf']
        break
      }
      default: {
        const exhaustive: never = node
        return exhaustive
      }
    }

    // What it declares and nothing answers to, where its kind was read whole:
    // declared nowhere, as an entity's own dangling references are shown —
    // less what is no reference, which its field already counts.
    const dangling = boundedOf(
      fields.flatMap((field) => graph.unresolvedOrganisationOf(ref, field)).filter(({ to }) => isReference(to)),
    )
    for (const { ref: nowhere } of dangling.shown) declaredNowhere.add(nowhere)
    return {
      row: { ...row, ...dangling.fields },
      refs: [...refs, ...dangling.shown.flatMap(({ sameName }) => sameName)],
    }
  }

  /**
   * The rows of a query, and — on the Analyst's registry, when there are any —
   * what the query's subject declares on that side and nothing answers to.
   * Its entity references (who declares it, what shares its name) are
   * witnessed as a row's are: the engine returned them. The reference itself
   * never is, so an answer naming it as an entity is refused.
   */
  const report = (
    entities: GraphNode[],
    unresolved: Unresolved[] = [],
    start?: string,
  ): ToolOutcome => {
    const shown = entities.slice(0, QUERY_LIMITS.maxRows)
    const truncated = entities.length - shown.length
    // A node of the organisation is found only on the registry that reads it.
    const readings = shown.map((node) => (isOrganisation(node) ? readOrganisation(node) : read(node)))
    const returned = new Set<string>(start === undefined ? [] : [start])
    for (const { refs } of readings) for (const ref of refs) returned.add(ref)
    const dangling = boundedOf(apis ? unresolved : [])
    for (const { ref, declaredBy, sameName } of dangling.shown) {
      declaredNowhere.add(ref)
      for (const entity of [declaredBy, ...sameName]) returned.add(entity)
    }
    for (const ref of returned) witnessed.add(ref)
    return {
      // Truncation is stated, never silent: a model that believed it had seen
      // everything would answer "those are all of them" and be wrong.
      result: {
        rows: readings.map(({ row }) => row),
        ...(truncated > 0 ? { truncated: `${truncated} more not shown` } : {}),
        ...dangling.fields,
      },
      rows: shown.length,
      truncated,
      ...(returned.size === 0 ? {} : { returned: [...returned] }),
      ...(dangling.shown.length === 0 ? {} : { dangling: dangling.shown.length }),
    }
  }

  /**
   * A relation's rows, bounded as every result is, with what the walk could
   * not follow said beside them. Every entity on a path is one the engine
   * returned, so every one is witnessed — the rights and objects in the
   * middle of a path as much as its end. A step declared nowhere is beside
   * the rows, under `danglingReferences` as a row's are, with the path that
   * led to it; its reference joins `declaredNowhere`, never `witnessed`.
   * `between`'s near misses are such steps, and are listed there too, never
   * among the paths. The cycles are bounded as the rows are, and only what
   * the model is shown is witnessed. On the organisation registry, what a
   * walk ends on that is no reference is counted beside the rows and never
   * shown, and the names read are bounded as the rows are.
   */
  const related = (result: RelationResult): ToolOutcome => {
    const returned = new Set<string>()
    const witness = (ref: string): void => {
      witnessed.add(ref)
      returned.add(ref)
    }
    witness(result.subject.ref)
    if (result.to !== undefined) witness(result.to.ref)
    const rows: RelationReading[] = []
    const dangling: Array<Dangling & { path: AnyStep[] }> = []
    const aside: SetAside[] = []
    let hidden = 0
    for (const row of [...result.rows, ...(result.nearMisses?.rows ?? [])]) {
      const reached = reachedBy(row)
      const ends = reached.nowhere !== undefined || reached.setAside === true
      const before = ends ? row.steps.slice(0, -1) : row.steps
      for (const step of before) witness(step.ref)
      if (organisation && ends && !isReference(reached.ref)) {
        hidden += 1
        continue
      }
      // An organisation relation only: a reference in the catalogue that was
      // set aside is no node, so never witnessed, and said beside the rows.
      if (reached.setAside === true) {
        aside.push({ ref: reached.ref, read: false, why: SET_ASIDE, path: before.map(pathStepOf) })
        continue
      }
      if (reached.nowhere === undefined) {
        rows.push(readingOf(result, row))
        continue
      }
      const shown = danglingOf(reached.nowhere)
      declaredNowhere.add(shown.ref)
      for (const entity of [shown.declaredBy, ...shown.sameName]) witness(entity)
      dangling.push({ ...shown, path: before.map(pathStepOf) })
    }
    const shared = result.shared?.rows ?? []
    for (const meeting of shared) {
      for (const row of meeting.paths) for (const step of row.steps) witness(step.ref)
    }
    // A cycle names entities of the graph too, each one the walk returned.
    const cycles = result.cycles.slice(0, RELATION_LIMITS.cycles)
    for (const cycle of cycles) for (const ref of cycle) witness(ref)
    const truncated = result.total - result.rows.length
    const cut = (list: { rows: readonly unknown[]; total: number } | undefined): number =>
      list === undefined ? 0 : list.total - list.rows.length
    const moreCycles = result.cycles.length - cycles.length
    const named = (result.named ?? []).filter(({ to }) => !organisation || isReference(to))
    hidden += (result.named?.length ?? 0) - named.length
    const names = named.slice(0, QUERY_LIMITS.maxRows)
    return {
      result: {
        relation: result.relation,
        subject: pathStepOf(result.subject),
        ...(result.to === undefined ? {} : { to: pathStepOf(result.to) }),
        rows,
        ...(truncated > 0 ? { truncated: `${truncated} more not shown` } : {}),
        ...(shared.length === 0 ? {} : { shared: shared.map(sharedOf) }),
        ...(cut(result.shared) > 0
          ? { sharedTruncated: `${cut(result.shared)} more not shown` }
          : {}),
        ...(result.stopped
          ? { stoppedAtDepth: `${result.depth}: hops further than this were not followed` }
          : {}),
        ...(result.exhausted === true
          ? { searchExhausted: 'the search stopped before it finished; there may be more paths' }
          : {}),
        ...(cycles.length === 0 ? {} : { cycles: cycles.map((cycle) => [...cycle]) }),
        ...(moreCycles > 0 ? { moreCycles: `${moreCycles} more cycles not shown` } : {}),
        ...(dangling.length === 0 ? {} : { danglingReferences: dangling }),
        ...(aside.length === 0 ? {} : { setAside: aside }),
        ...(names.length === 0 ? {} : { readAsNames: names.map(nameReadOf) }),
        ...(named.length > names.length
          ? { readAsNamesTruncated: `${named.length - names.length} more not shown` }
          : {}),
        ...(hidden === 0 ? {} : { notShown: notReferences(hidden) }),
        ...(cut(result.nearMisses) > 0
          ? { nearMissesTruncated: `${cut(result.nearMisses)} more not shown` }
          : {}),
      },
      rows: rows.length,
      truncated,
      ...(returned.size === 0 ? {} : { returned: [...returned] }),
      ...(dangling.length + aside.length === 0 ? {} : { dangling: dangling.length + aside.length }),
    }
  }

  const search = organisation
    ? organisationSearchCriteriaSchema
    : apis
      ? apiSearchCriteriaSchema
      : searchCriteriaSchema
  const relationsInput = organisation ? organisationRelationsInputSchema : getRelationsInputSchema
  const answer = organisation ? organisationAnswerSchema : apis ? answerSchema : answerSchemaWithoutRelation
  /** One sentence more on the organisation registry, and not a byte elsewhere. */
  const alsoOrganisation = (description: string, sentence: string): string =>
    organisation ? `${description} ${sentence}` : description
  const specs: ModelToolSpec[] = [
    {
      name: 'search_entities',
      description: alsoOrganisation(
        'Find entities by kind, type, environment, owner or name fragment. At least one ' +
          'criterion is required. Returns at most 25 rows and says so when it truncated.',
        "Groups, Users, Systems and Domains are read here too: search them by kind, and a name " +
          "fragment with no kind finds them after the entities; none declares an environment.",
      ),
      parameters: search,
    },
    {
      name: 'get_entity',
      description: alsoOrganisation(
        'Read one entity by its full reference, such as resource:default/billing-db-prod. ' +
          'Returns an error if no entity has that reference; it never guesses a near match.',
        "Groups, Users, Systems and Domains are read here too, such as group:default/tiger: a " +
          "team's parent, children, members and what it owns; a person's groups; a system's parts.",
      ),
      parameters: getEntityInputSchema,
    },
    {
      name: 'get_dependencies',
      description:
        'Walk one declared hop from an entity: "dependencies" for what it depends on, ' +
        '"dependants" for what depends on it, or "consumers" for the services that reach ' +
        'it through any chain. These are three different questions; pick deliberately.',
      parameters: getDependenciesInputSchema,
    },
    ...(apis
      ? [
          {
            name: 'get_relations',
            description: alsoOrganisation(
              "Trace one entity's relations through the declarations, several hops deep. Each " +
                'row is an entity reached, with its depth and its whole path: every step with its ' +
                'environment, and each right on it with the level it states. "consumes": what it ' +
                'reaches through its access rights; "consumed-by": the services that reach it; ' +
                '"depends-on": everything it needs; "impacts": everything that needs it, what is ' +
                'affected if it fails; "provides" / "provided-by": Backstage APIs; "between" with ' +
                '"to": every path where one depends on the other, and where there is none, the ' +
                'nearest entities both reach ("shared"). A step declared nowhere is listed beside ' +
                'the rows. Returns at most 25 rows and says so when it cut them or stopped at a depth.',
              'Groups, Users, Systems and Domains are walked here too: "owns" (what a team or a ' +
                'person owns, down its child teams), "owned-by" (who owns it, and the teams above), ' +
                '"member-of" (its groups, and theirs), "has-member" (who is in a team, and its ' +
                'child teams), "part-of" (its system and domain), "has-part" (what a system or a ' +
                'domain holds).',
            ),
            parameters: relationsInput,
          },
          {
            name: 'get_apis',
            description:
              'Read who provides a Backstage API: "provides" for the APIs a component ' +
              'provides (Backstage\'s providesApi relation), "providedBy" for the components ' +
              'that provide an API (apiProvidedBy). Who consumes an API is an access right ' +
              'over it: get_dependencies "consumers" walks those.',
            parameters: getApisInputSchema,
          },
        ]
      : []),
    // The Analyst's answer can name a relation; the one on the Architect's
    // registry is the one its golden holds (`answerSchemaWithoutRelation`).
    organisation
      ? {
          name: 'answer',
          description:
            'End the search. Give outcome "entities" with the references you actually read, ' +
            '"relation" with "ref" and "relation" (and "to" for "between") when asked what an ' +
            'entity consumes, what uses it, what it depends on, what breaks if it fails, what ' +
            'it provides or how two entities are related, or, of a Group, a User, a System or ' +
            'a Domain, what it "owns", who it is "owned-by", what it is a "member-of", who ' +
            '"has-member" in it, what it is "part-of" or what it "has-part" (the engine writes ' +
            'every path), "nothing" if no entity matches, "overview" when asked to describe or ' +
            'summarise the catalogue as a whole (the engine writes it; never "unanswerable" for ' +
            'that), or "unanswerable" with a reason if the question cannot be answered from ' +
            'this catalogue. You must call this to finish.',
          parameters: organisationAnswerSchema,
        }
      : apis
      ? {
          name: 'answer',
          description:
            'End the search. Give outcome "entities" with the references you actually read, ' +
            '"relation" with "ref" and "relation" (and "to" for "between") when asked what an ' +
            'entity consumes, what uses it, what it depends on, what breaks if it fails, what ' +
            'it provides or how two entities are related (the engine writes every path), ' +
            '"nothing" if no entity matches, "overview" when asked to describe or summarise ' +
            'the catalogue as a whole (the engine writes it; never "unanswerable" for that), ' +
            'or "unanswerable" with a reason if the question cannot be answered from this ' +
            'catalogue. You must call this to finish.',
          parameters: answerSchema,
        }
      : {
          name: 'answer',
          description:
            'End the search. Give outcome "entities" with the references you actually read, ' +
            '"nothing" if no entity matches, "overview" when asked to describe or summarise ' +
            'the catalogue as a whole (the engine writes it; never "unanswerable" for that), ' +
            'or "unanswerable" with a reason if the question cannot be answered from this ' +
            'catalogue. You must call this to finish.',
          parameters: answerSchemaWithoutRelation,
        },
  ]

  return {
    specs,
    witnessed,
    declaredNowhere,
    answer,
    organisation,

    run(call: ModelToolCall): ToolOutcome {
      if (call.name === 'search_entities') {
        const parsed = search.safeParse(call.args)
        if (!parsed.success) return failed('search_entities', parsed.error)
        const { kind, type, env, owner, nameContains } = parsed.data
        if (options.refuseUnusedValues ?? true) {
          const unused = unusedCriteria(graph, parsed.data, organisation)
          // Every criterion named, not the first: a model corrects one and
          // comes back with the next invented one otherwise.
          if (unused.length > 0) return refused(`search_entities: ${unused.join('. ')}`)
        }
        // The entities, then — on the organisation registry — the
        // organisation's nodes the criteria match: none of a kind asked for
        // that is an entity's, none but that kind when it is theirs.
        const entities =
          kind !== undefined && isOrganisationKind(kind)
            ? []
            : // Omitted rather than passed as undefined: exactOptionalPropertyTypes
              // draws the distinction, and so does the shipped code in cli/index.ts.
              graph.search({
                ...(kind !== undefined ? { kind: kind as CatalogueEntity['kind'] } : {}),
                ...(type !== undefined ? { type } : {}),
                ...(env !== undefined ? { env } : {}),
                ...(owner !== undefined ? { owner } : {}),
                ...(nameContains !== undefined ? { nameContains } : {}),
              })
        return report([...entities, ...(organisation ? organisationSearch(graph, parsed.data) : [])])
      }

      if (call.name === 'get_entity') {
        const parsed = getEntityInputSchema.safeParse(call.args)
        if (!parsed.success) return failed('get_entity', parsed.error)
        // A Group, a User, a System or a Domain only on the registry that reads them.
        const found = organisation ? graph.node(parsed.data.ref) : graph.get(parsed.data.ref)
        // No nearest match, deliberately. Declare, never infer (design 4.1).
        if (found === undefined) return refused('no such entity')
        return report([found])
      }

      if (call.name === 'get_dependencies') {
        const parsed = getDependenciesInputSchema.safeParse(call.args)
        if (!parsed.success) return failed('get_dependencies', parsed.error)
        const { ref, direction } = parsed.data
        // The entity walked from is one the engine looked up, so on the
        // Analyst's registry an answer may name it, as `get_relations` lets it
        // name its subject. Not on the Architect's: its witness set is what a
        // proposed value's provenance is measured against, and its plan-mode
        // tapes were recorded against that set as it was. A reference the graph
        // does not hold witnesses nothing.
        const found = apis ? graph.get(ref) : undefined
        const start = found === undefined ? undefined : refOf(found)
        if (direction === 'dependencies') {
          return report(graph.dependenciesOf(ref), graph.unresolvedOf(ref, 'dependsOn'), start)
        }
        if (direction === 'dependants') {
          return report(graph.dependantsOf(ref), graph.unresolvedOf(ref, 'dependencyOf'), start)
        }
        if (direction === 'consumers') {
          return report(graph.consumersOf(ref), graph.unresolvedConsumersOf(ref), start)
        }
        const _exhaustive: never = direction
        return _exhaustive
      }

      if (call.name === 'get_relations' && apis) {
        const parsed = relationsInput.safeParse(call.args)
        if (!parsed.success) return failed('get_relations', parsed.error)
        const { ref, relation, to } = parsed.data
        const result = relationsOf(graph, ref, relation, {
          rows: QUERY_LIMITS.maxRows,
          ...(relation === 'between' && to !== undefined ? { to } : {}),
        })
        // No nearest match, as `get_entity`: an entity is named or it is not.
        // Which of the two references named nothing is said, so the model
        // knows which one to fix. A Group, a System — which `relationsOf`
        // also answers of — is a node here only on the organisation
        // registry; and `between` links two entities, so one of the
        // organisation at either end is said to be one, `ref` first.
        const known = (at: string): GraphNode | undefined => (organisation ? graph.node(at) : graph.get(at))
        if (result === undefined || known(ref) === undefined) {
          const blamed = known(ref) === undefined || (relation === 'between' && graph.get(ref) === undefined)
          const [name, at] = blamed ? ['ref', ref] : ['to', to ?? '']
          const node = organisation ? graph.node(at) : undefined
          return refused(
            node === undefined
              ? `no such entity: "${name}" ${at}`
              : `"between" links two entities: "${name}" ${at} is a ${node.kind}`,
          )
        }
        return related(result)
      }

      if (call.name === 'get_apis' && apis) {
        const parsed = getApisInputSchema.safeParse(call.args)
        if (!parsed.success) return failed('get_apis', parsed.error)
        const { ref, direction } = parsed.data
        switch (direction) {
          case 'provides':
            return report(graph.providedApisOf(ref), graph.unresolvedOf(ref, 'providesApis'))
          case 'providedBy':
            return report(graph.providersOf(ref))
          default: {
            const _exhaustive: never = direction
            return _exhaustive
          }
        }
      }

      if (call.name === 'answer') {
        // Returned as given. The loop validates it and the engine signs it;
        // witnessing it here would let the model vouch for itself.
        return { result: call.args, rows: 0, truncated: 0 }
      }

      return refused(`unknown tool "${call.name}"`)
    },
  }
}
