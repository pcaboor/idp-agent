import type { z } from 'zod'
import type { CatalogueEntity } from '../../core/schemas/entity.js'
import {
  QUERY_LIMITS,
  answerSchema,
  apiSearchCriteriaSchema,
  getApisInputSchema,
  getDependenciesInputSchema,
  getEntityInputSchema,
  searchCriteriaSchema,
  type SearchCriteria,
} from '../../core/schemas/query.js'
import { levelledOf } from '../../core/schemas/resource-types.js'
import {
  ENV_ANNOTATION,
  refOf,
  type DeclaredField,
  type EntityGraph,
  type Unresolved,
} from '../../context/graph/entity-graph.js'
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
  field: DeclaredField
  declaredBy: string
  sameName: string[]
}

const danglingOf = ({ to, field, from, sameName }: Unresolved): Dangling => ({
  ref: to,
  declared: false,
  field,
  declaredBy: from,
  sameName: [...sameName],
})

/**
 * At most as many as a result's rows, and the cut stated beside them as the
 * rows' is: a consumers walk over an object many rights reach can name any
 * number, and a model that believed it had seen them all would say so.
 */
const boundedOf = (
  unresolved: readonly Unresolved[],
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
function unusedCriteria(graph: EntityGraph, criteria: SearchCriteria): string[] {
  const entities = graph.all()
  if (entities.length === 0) return []
  const unused: string[] = []

  const check = (
    label: string,
    plural: string,
    value: string | undefined,
    of: (entity: CatalogueEntity) => string,
  ): void => {
    if (value === undefined) return
    const inUse = new Set(entities.map(of))
    if (!inUse.has(value)) {
      unused.push(`${label} "${value}" matches no entity; ${plural} in use: ${listed(inUse)}`)
    }
  }
  check('kind', 'kinds', criteria.kind, (entity) => entity.kind)
  check('type', 'types', criteria.type, (entity) => entity.spec.type)

  // An entity with no environment is matched by no env value — unchanged, and
  // said, since omitting env is then the only way to reach it.
  if (criteria.env !== undefined) {
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

  check('owner', 'owners', criteria.owner, (entity) => entity.spec.owner)
  return unused
}

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
} {
  // What the ENGINE returned. The answer tool never adds to it: a model that
  // could witness its own invention would defeat the check entirely.
  const witnessed = new Set<string>()
  const declaredNowhere = new Set<string>()
  const apis = options.apis ?? false

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
   * The rows of a query, and — on the Analyst's registry, when there are any —
   * what the query's subject declares on that side and nothing answers to.
   * Its entity references (who declares it, what shares its name) are
   * witnessed as a row's are: the engine returned them. The reference itself
   * never is, so an answer naming it as an entity is refused.
   */
  const report = (entities: CatalogueEntity[], unresolved: Unresolved[] = []): ToolOutcome => {
    const shown = entities.slice(0, QUERY_LIMITS.maxRows)
    const truncated = entities.length - shown.length
    const readings = shown.map(read)
    for (const { refs } of readings) for (const ref of refs) witnessed.add(ref)
    const dangling = boundedOf(apis ? unresolved : [])
    for (const { ref, declaredBy, sameName } of dangling.shown) {
      declaredNowhere.add(ref)
      for (const entity of [declaredBy, ...sameName]) witnessed.add(entity)
    }
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
      ...(dangling.shown.length === 0 ? {} : { dangling: dangling.shown.length }),
    }
  }

  const search = apis ? apiSearchCriteriaSchema : searchCriteriaSchema
  const specs: ModelToolSpec[] = [
    {
      name: 'search_entities',
      description:
        'Find entities by kind, type, environment, owner or name fragment. At least one ' +
        'criterion is required. Returns at most 25 rows and says so when it truncated.',
      parameters: search,
    },
    {
      name: 'get_entity',
      description:
        'Read one entity by its full reference, such as resource:default/billing-db-prod. ' +
        'Returns an error if no entity has that reference; it never guesses a near match.',
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
    {
      name: 'answer',
      description:
        'End the search. Give outcome "entities" with the references you actually read, ' +
        '"nothing" if no entity matches, "overview" when asked to describe or summarise ' +
        'the catalogue as a whole (the engine writes it; never "unanswerable" for that), ' +
        'or "unanswerable" with a reason if the question cannot be answered from this ' +
        'catalogue. You must call this to finish.',
      parameters: answerSchema,
    },
  ]

  return {
    specs,
    witnessed,
    declaredNowhere,

    run(call: ModelToolCall): ToolOutcome {
      if (call.name === 'search_entities') {
        const parsed = search.safeParse(call.args)
        if (!parsed.success) return failed('search_entities', parsed.error)
        const { kind, type, env, owner, nameContains } = parsed.data
        if (options.refuseUnusedValues ?? true) {
          const unused = unusedCriteria(graph, parsed.data)
          // Every criterion named, not the first: a model corrects one and
          // comes back with the next invented one otherwise.
          if (unused.length > 0) return refused(`search_entities: ${unused.join('. ')}`)
        }
        // Omitted rather than passed as undefined: exactOptionalPropertyTypes
        // draws the distinction, and so does the shipped code in cli/index.ts.
        return report(
          graph.search({
            ...(kind !== undefined ? { kind } : {}),
            ...(type !== undefined ? { type } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(owner !== undefined ? { owner } : {}),
            ...(nameContains !== undefined ? { nameContains } : {}),
          }),
        )
      }

      if (call.name === 'get_entity') {
        const parsed = getEntityInputSchema.safeParse(call.args)
        if (!parsed.success) return failed('get_entity', parsed.error)
        const found = graph.get(parsed.data.ref)
        // No nearest match, deliberately. Declare, never infer (design 4.1).
        if (found === undefined) return refused('no such entity')
        return report([found])
      }

      if (call.name === 'get_dependencies') {
        const parsed = getDependenciesInputSchema.safeParse(call.args)
        if (!parsed.success) return failed('get_dependencies', parsed.error)
        const { ref, direction } = parsed.data
        if (direction === 'dependencies') {
          return report(graph.dependenciesOf(ref), graph.unresolvedOf(ref, 'dependsOn'))
        }
        if (direction === 'dependants') {
          return report(graph.dependantsOf(ref), graph.unresolvedOf(ref, 'dependencyOf'))
        }
        if (direction === 'consumers') {
          return report(graph.consumersOf(ref), graph.unresolvedConsumersOf(ref))
        }
        const _exhaustive: never = direction
        return _exhaustive
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
