import type { z } from 'zod'
import type { Entity } from '../../core/schemas/entity.js'
import {
  QUERY_LIMITS,
  answerSchema,
  getDependenciesInputSchema,
  getEntityInputSchema,
  searchCriteriaSchema,
} from '../../core/schemas/query.js'
import { ENV_ANNOTATION, refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import type { ModelToolCall, ModelToolSpec } from '../../llm/client.js'

export interface ToolOutcome {
  result: unknown
  rows: number
  truncated: number
}

/** The same shape `renderTable` consumes, so an answer and a table cannot disagree. */
interface Row {
  ref: string
  name: string
  kind: string
  type: string
  env: string
  owner: string
}

const rowOf = (entity: Entity): Row => ({
  ref: refOf(entity),
  name: entity.metadata.name,
  kind: entity.kind,
  type: entity.spec.type,
  env: entity.metadata.annotations[ENV_ANNOTATION] ?? '(undeclared)',
  owner: entity.spec.owner,
})

const failed = (tool: string, error: z.ZodError): ToolOutcome => ({
  // Returned, not thrown: the loop has to be able to continue after a bad call,
  // and the model has to be able to read what was wrong with it.
  result: { error: `${tool}: ${error.issues[0]?.message ?? 'invalid arguments'}` },
  rows: 0,
  truncated: 0,
})

export function buildTools(graph: EntityGraph): {
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
        '"nothing" if no entity matches, or "unanswerable" with a reason if the question ' +
        'cannot be answered from this catalogue. You must call this to finish.',
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
        if (found === undefined) {
          return { result: { error: 'no such entity' }, rows: 0, truncated: 0 }
        }
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

      return { result: { error: `unknown tool "${call.name}"` }, rows: 0, truncated: 0 }
    },
  }
}
