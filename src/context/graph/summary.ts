import { type EntityGraph } from './entity-graph.js'
import { ENV_ANNOTATION, type Vocabulary } from '../../core/schemas/vocabulary.js'

/**
 * Counts are bucketed, never exact. Stages 3 and 4 both add fixtures, and
 * 33 -> 41 entities must not move the prompt the model sees — moving it
 * re-records every scenario. Dangling references are the exception: that is a
 * health fact, not a scale, and it must move the prompt when it moves.
 */
export type Bucket = '0' | '1-9' | '10-99' | '100+'

export interface SiSummary {
  entities: Bucket
  components: Bucket
  resources: Bucket
  danglingReferences: number
}

export type { Vocabulary } from '../../core/schemas/vocabulary.js'

const bucket = (count: number): Bucket =>
  count === 0 ? '0' : count < 10 ? '1-9' : count < 100 ? '10-99' : '100+'

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

export function summariseGraph(graph: EntityGraph): {
  summary: SiSummary
  vocabulary: Vocabulary
} {
  const entities = graph.all()
  const environments: string[] = []

  for (const entity of entities) {
    const declared = entity.metadata.annotations[ENV_ANNOTATION]
    // Declare, never infer: an entity with no environment contributes none.
    if (declared !== undefined) environments.push(declared)
  }

  return {
    summary: {
      entities: bucket(entities.length),
      components: bucket(entities.filter((entity) => entity.kind === 'Component').length),
      resources: bucket(entities.filter((entity) => entity.kind === 'Resource').length),
      danglingReferences: graph.danglingReferences().length,
    },
    vocabulary: {
      kinds: sorted(entities.map((entity) => entity.kind)),
      types: sorted(entities.map((entity) => entity.spec.type)),
      environments: sorted(environments),
      owners: sorted(entities.map((entity) => entity.spec.owner)),
    },
  }
}
