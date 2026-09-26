import path from 'node:path'
import { answerQuestion } from '../../src/agents/analyst.js'
import { draftPlan } from '../../src/agents/architect.js'
import { inspect } from '../../src/agents/inspector.js'
import { reviewPlan } from '../../src/agents/reviewer.js'
import { classify } from '../../src/agents/supervisor.js'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import type { GenerateResult, LlmClient, ModelToolSpec } from '../../src/llm/client.js'

/**
 * Every tool spec the five agents hand a client, collected by running them.
 *
 * Read off the requests rather than listed by hand: a list written here would
 * cover the tools someone remembered, and the tool that breaks a provider is
 * the one nobody thought to add. Each agent is driven on a client that never
 * calls anything, so every loop runs to its bound — the forced last turn
 * included — and stops on its own.
 *
 * Deduplicated by what a provider is sent — the name, the description and
 * the parameters — and not by name alone: the Analyst and the Architect are
 * each handed their own `buildTools`, the Analyst's with `apis` as `ask`
 * builds it, so two `search_entities` differ in the kinds they take, and each
 * is a spec some request carries. The Architect's is the one the plan-mode
 * recordings were made against; keyed by name, the first seen would hide it.
 * One request never carries two tools of one name — a `ToolSet` is keyed by
 * name — so a caller sending them all at once sends `requests(specs)`.
 */
export async function offeredTools(): Promise<ModelToolSpec[]> {
  const seen: ModelToolSpec[] = []
  const barren: LlmClient = {
    generate: async (request): Promise<GenerateResult> => {
      for (const spec of request.tools) {
        const same = (known: ModelToolSpec): boolean =>
          known.name === spec.name &&
          known.description === spec.description &&
          known.parameters === spec.parameters
        if (!seen.some(same)) seen.push(spec)
      }
      return { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
  const emit = (): void => {}
  // A loop that ends without its terminal call may throw; which one does is
  // each agent's business, and only the requests it made matter here.
  const settle = async (run: Promise<unknown>): Promise<void> => void (await run.catch(() => {}))

  const root = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
  const graph = EntityGraph.from((await new FixtureProvider(root).load()).entities)
  const intent = 'give billing-api read access to orders-db in prod'

  await settle(classify(barren, { intent, summary: '' }, emit))
  await settle(
    answerQuestion(
      barren,
      buildTools(graph, { apis: true }),
      { intent, summary: '', vocabulary: '' },
      emit,
    ),
  )
  const facts = await inspect(
    barren,
    { root: '/nowhere', files: [], skipped: [], truncated: false },
    emit,
  )
  await settle(
    draftPlan(barren, buildTools(graph), { intent, facts, summary: '', vocabulary: '' }, emit),
  )
  const plan = planSchema.parse({
    intent,
    operations: [
      {
        op: 'update-entity',
        entityRef: 'resource:default/orders-db-prod',
        patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api' },
      },
    ],
  })
  await settle(reviewPlan(barren, { plan, intent, derived: [], targets: [], effects: [] }, emit))

  return seen
}

/**
 * `specs` as the fewest requests that each carry a name once, in the order
 * they were offered: every first spec of a name in the first, the variants
 * after it.
 */
export function requests(specs: readonly ModelToolSpec[]): ModelToolSpec[][] {
  const batches: ModelToolSpec[][] = []
  for (const spec of specs) {
    const free = batches.find((batch) => batch.every((taken) => taken.name !== spec.name))
    if (free === undefined) batches.push([spec])
    else free.push(spec)
  }
  return batches
}
