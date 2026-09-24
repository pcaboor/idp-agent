import type { z } from 'zod'
import type { Entity } from '../../core/schemas/entity.js'
import {
  QUERY_LIMITS,
  answerSchema,
  getDependenciesInputSchema,
  getEntityInputSchema,
  searchCriteriaSchema,
  type SearchCriteria,
} from '../../core/schemas/query.js'
import { levelledOf } from '../../core/schemas/resource-types.js'
import { ENV_ANNOTATION, refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
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
const accessOf = (entity: Entity): { access: string } | Record<string, never> =>
  entity.kind === 'Resource' && levelledOf(entity.spec.type)
    ? { access: entity.spec.access ?? UNDECLARED }
    : {}

const rowOf = (entity: Entity): Row => ({
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
    of: (entity: Entity) => string,
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
  } = {},
): {
  specs: ModelToolSpec[]
  run(call: ModelToolCall): ToolOutcome
  witnessed: ReadonlySet<string>
} {
  // What the ENGINE returned. The answer tool never adds to it: a model that
  // could witness its own invention would defeat the check entirely.
  const witnessed = new Set<string>()

  const report = (entities: Entity[]): ToolOutcome => {
    const shown = entities.slice(0, QUERY_LIMITS.maxRows)
    const truncated = entities.length - shown.length
    for (const entity of shown) witnessed.add(refOf(entity))
    return {
      // Truncation is stated, never silent: a model that believed it had seen
      // everything would answer "those are all of them" and be wrong.
      result: {
        rows: shown.map(rowOf),
        ...(truncated > 0 ? { truncated: `${truncated} more not shown` } : {}),
      },
      rows: shown.length,
      truncated,
    }
  }

  const specs: ModelToolSpec[] = [
    {
      name: 'search_entities',
      description:
        'Find entities by kind, type, environment, owner or name fragment. At least one ' +
        'criterion is required. Returns at most 25 rows and says so when it truncated.',
      parameters: searchCriteriaSchema,
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

    run(call: ModelToolCall): ToolOutcome {
      if (call.name === 'search_entities') {
        const parsed = searchCriteriaSchema.safeParse(call.args)
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
        if (direction === 'dependencies') return report(graph.dependenciesOf(ref))
        if (direction === 'dependants') return report(graph.dependantsOf(ref))
        if (direction === 'consumers') return report(graph.consumersOf(ref))
        const _exhaustive: never = direction
        return _exhaustive
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
