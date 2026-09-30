import type { ReadScope } from '../provider.js'
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
  /**
   * The organisation the graph holds, bucketed as the entities are — present
   * only when it holds a Group, a User, a System or a Domain, so a summary of
   * a source that holds none is the one every recording was made against.
   * Not among `entities`, and its references not among `danglingReferences`:
   * those are the write model's (`EntityGraph.all()`).
   */
  organisation?: { groups: Bucket; users: Bucket; systems: Bucket; domains: Bucket }
  /**
   * The reads of a catalogue that stopped at a bound, by scope and bound —
   * never their counts, which would move the prompt with every entity a
   * catalogue gains: that it was read in part is the health fact, as the
   * dangling references are. Present only on a partial graph, so a whole
   * one is summarised as every recording was made against.
   */
  partial?: Array<{ scope: ReadScope; limit: number }>
}

export type { Vocabulary } from '../../core/schemas/vocabulary.js'

/**
 * How many entities state each value of each list: what the Supervisor's and
 * the Analyst's summary keeps when a list is longer than it shows
 * (`shownVocabulary`). Beside the vocabulary, never in it — `Vocabulary` is
 * what the gates read, and they read every value.
 */
export type VocabularyCounts = { readonly [K in keyof Vocabulary]: ReadonlyMap<string, number> }

const bucket = (count: number): Bucket =>
  count === 0 ? '0' : count < 10 ? '1-9' : count < 100 ? '10-99' : '100+'

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

/** Each value and how many times it came. */
const counted = (values: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

export function summariseGraph(graph: EntityGraph): {
  summary: SiSummary
  vocabulary: Vocabulary
  counts: VocabularyCounts
} {
  const entities = graph.all()
  const environments: string[] = []

  for (const entity of entities) {
    const declared = entity.metadata.annotations[ENV_ANNOTATION]
    // Declare, never infer: an entity with no environment contributes none.
    if (declared !== undefined) environments.push(declared)
  }
  const kinds = entities.map((entity) => entity.kind)
  const types = entities.map((entity) => entity.spec.type)
  const owners = entities.map((entity) => entity.spec.owner)
  const nodes = graph.nodes()
  const ofKind = (kind: string): Bucket => bucket(nodes.filter((node) => node.kind === kind).length)

  return {
    summary: {
      entities: bucket(entities.length),
      components: bucket(entities.filter((entity) => entity.kind === 'Component').length),
      resources: bucket(entities.filter((entity) => entity.kind === 'Resource').length),
      danglingReferences: graph.danglingReferences().length,
      ...(graph.holdsOrganisation
        ? {
            organisation: {
              groups: ofKind('Group'),
              users: ofKind('User'),
              systems: ofKind('System'),
              domains: ofKind('Domain'),
            },
          }
        : {}),
      ...(graph.partial.length === 0
        ? {}
        : { partial: graph.partial.map(({ scope, limit }) => ({ scope, limit })) }),
    },
    // Deliberately no `levels`. A level is not vocabulary: `sign.ts` reads this
    // list to decide that a proposed value was already in use rather than
    // invented, and `read` is in use in every catalogue that has one grant — so
    // enumerating it would flip `spec.access` — and `patch.access`, which §5.3
    // put on an update for the same reason — from `novel` to `enumerated`, and
    // stop the signature asking about a level nobody vouched for. That question
    // is the only thing that reads the REQUEST: `declared-level-mismatch`
    // compares the plan to the repository and never to a word of it. The level
    // of a PARTICULAR grant is a fact about that grant; the tools carry it on
    // the row.
    vocabulary: {
      kinds: sorted(kinds),
      types: sorted(types),
      environments: sorted(environments),
      owners: sorted(owners),
    },
    counts: {
      kinds: counted(kinds),
      types: counted(types),
      environments: counted(environments),
      owners: counted(owners),
    },
  }
}
