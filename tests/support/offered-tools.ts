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
 * Deduplicated by name, first seen wins: the Analyst and the Architect are
 * each handed their own `buildTools`, and a `ToolSet` is keyed by name anyway.
 */
export async function offeredTools(): Promise<ModelToolSpec[]> {
  const seen = new Map<string, ModelToolSpec>()
  const barren: LlmClient = {
    generate: async (request): Promise<GenerateResult> => {
      for (const spec of request.tools) if (!seen.has(spec.name)) seen.set(spec.name, spec)
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
    answerQuestion(barren, buildTools(graph), { intent, summary: '', vocabulary: '' }, emit),
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

  return [...seen.values()]
}
