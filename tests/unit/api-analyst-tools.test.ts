import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTools, type ToolOutcome } from '../../src/agents/tools/graph-tools.js'
import { runAsk } from '../../src/cli/commands/ask.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import type { AgentName, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { apiSearchCriteriaSchema, searchCriteriaSchema } from '../../src/core/schemas/query.js'
import { offeredTools } from '../support/offered-tools.js'

/**
 * The Analyst finds and uses Backstage's APIs; the Architect is handed exactly
 * the tools it was handed before. Its specs are part of every request a
 * plan-mode recording's digest is taken over, so they are held here to the
 * bytes the build this change started from produced
 * (`tests/golden/architect-tools.json`), and not only to the tapes.
 */

const GOLDEN = path.resolve(import.meta.dirname, '../golden/backstage-apis')
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ARCHITECT = path.resolve(import.meta.dirname, '../golden/architect-tools.json')

const load = async (root: string = GOLDEN): Promise<EntityGraph> => {
  const loaded = await new FixtureProvider(root).load()
  return EntityGraph.from(
    loaded.entities,
    loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
  )
}

const call = (name: string, args: unknown) => ({ id: 'c1', name, args })
const rows = (outcome: ToolOutcome): Array<Record<string, unknown>> =>
  (outcome.result as { rows: Array<Record<string, unknown>> }).rows

/** A spec as a recording's digest reads it: `JSON.stringify` of the request. */
const asDigested = (specs: unknown): unknown => JSON.parse(JSON.stringify(specs))

describe("the Architect's registry", () => {
  it('is byte for byte the one it was, over a graph holding APIs or none', async () => {
    const expected = JSON.parse(await readFile(ARCHITECT, 'utf8')) as unknown
    for (const graph of [EntityGraph.from([]), await load(DEMO), await load()]) {
      const { specs } = buildTools(graph, { refuseUnusedValues: false })
      expect(asDigested(specs)).toEqual(expected)
    }
  })

  it('has no API tool and no API kind to search on', async () => {
    const { specs, run } = buildTools(await load(), { refuseUnusedValues: false })
    expect(specs.map((spec) => spec.name)).not.toContain('get_apis')
    expect(run(call('search_entities', { kind: 'API' })).error).toMatch(/^search_entities: /)
    expect(run(call('get_apis', { ref: 'api:default/billing', direction: 'providedBy' })).error).toBe(
      'unknown tool "get_apis"',
    )
  })
})

describe("the Analyst's registry", () => {
  const analyst = async (root?: string) => buildTools(await load(root), { apis: true })

  it('adds one tool, get_apis, before the terminal one', async () => {
    expect((await analyst()).specs.map((spec) => spec.name)).toEqual([
      'search_entities',
      'get_entity',
      'get_dependencies',
      'get_apis',
      'answer',
    ])
  })

  it('shares every spec with the Architect but the search and the new tool', async () => {
    const architect = buildTools(await load(), { refuseUnusedValues: false })
    const own = (await analyst()).specs
    for (const name of ['get_entity', 'get_dependencies', 'answer']) {
      expect(asDigested(own.find((spec) => spec.name === name))).toEqual(
        asDigested(architect.specs.find((spec) => spec.name === name)),
      )
    }
  })

  it('searches on kind API', async () => {
    const built = await analyst()
    const outcome = built.run(call('search_entities', { kind: 'API' }))
    expect(rows(outcome).map((row) => row.ref)).toEqual(['api:default/billing', 'api:default/payments'])
    expect(built.witnessed.has('api:default/payments')).toBe(true)
  })

  it('refuses kind API where the catalogue holds none, naming the kinds in use', async () => {
    const outcome = (await analyst(DEMO)).run(call('search_entities', { kind: 'API' }))
    expect(outcome.error).toBe(
      'search_entities: kind "API" matches no entity; kinds in use: Component, Resource',
    )
  })

  it('reads an API as the card shows it, and never its definition', async () => {
    const outcome = (await analyst()).run(call('get_entity', { ref: 'api:default/billing' }))
    expect(rows(outcome)).toEqual([
      {
        ref: 'api:default/billing',
        name: 'billing',
        kind: 'API',
        type: 'openapi',
        lifecycle: 'production',
        definition: 'declared',
        env: '(undeclared)',
        owner: 'group:default/tiger',
        // What the file says the API is, as the card prints it: a question
        // about what the billing API does is answered from its own words.
        description: 'Invoices and credit notes, as billing-api serves them',
        system: 'system:default/payments',
        tags: ['rest', 'invoices'],
        links: [{ url: 'https://docs.example.com/billing', title: 'Reference' }],
        providedBy: ['component:default/billing-api'],
      },
    ])
    const payments = (await analyst()).run(call('get_entity', { ref: 'api:default/payments' }))
    expect(JSON.stringify(payments.result)).not.toMatch(/DEFINITION-BODY|proto3/)
  })

  it('reads what a component provides on its row, and witnesses it', async () => {
    const built = await analyst()
    const outcome = built.run(call('get_entity', { ref: 'component:default/billing-api' }))
    expect(rows(outcome)).toEqual([
      {
        ref: 'component:default/billing-api',
        name: 'billing-api',
        kind: 'Component',
        type: 'service',
        env: 'prod',
        owner: 'group:default/tiger',
        provides: ['api:default/billing'],
      },
    ])
    // Returned by the engine, so it may be answered with; the dangling one was not.
    expect(built.witnessed.has('api:default/billing')).toBe(true)
    expect(built.witnessed.has('api:default/ghost')).toBe(false)
  })

  it('answers get_apis in both directions, and witnesses what it returned', async () => {
    const built = await analyst()
    const provides = built.run(
      call('get_apis', { ref: 'component:default/billing-api', direction: 'provides' }),
    )
    expect(rows(provides).map((row) => row.ref)).toEqual(['api:default/billing'])
    const providers = built.run(call('get_apis', { ref: 'api:default/billing', direction: 'providedBy' }))
    expect(rows(providers).map((row) => row.ref)).toEqual(['component:default/billing-api'])
    expect(built.witnessed.has('component:default/billing-api')).toBe(true)
  })

  it('refuses a get_apis call that does not parse, naming the tool', async () => {
    const outcome = (await analyst()).run(call('get_apis', { ref: 'billing', direction: 'up' }))
    expect(outcome.error).toMatch(/^get_apis: /)
    expect(outcome.rows).toBe(0)
  })

  it('walks the consumers of an API through the rights over it', async () => {
    const outcome = (await analyst()).run(
      call('get_dependencies', { ref: 'api:default/payments', direction: 'consumers' }),
    )
    expect(rows(outcome).map((row) => row.ref)).toEqual(['component:default/orders-api'])
    // The walk passes through a reference whether or not it names an entity;
    // what changed is that the API those rights reach is one the Analyst
    // reads, with who provides it. Set aside, it had no row.
    const api = (await analyst()).run(call('get_entity', { ref: 'api:default/payments' }))
    expect(rows(api)).toEqual([
      expect.objectContaining({ ref: 'api:default/payments', kind: 'API', providedBy: [] }),
    ])
  })

  it('returns what it returned before for every entity with no API data', async () => {
    // The demo SI declares no API, so every read of it must be the Architect's
    // read, byte for byte — and so must a component of the golden repository
    // that provides nothing.
    for (const root of [DEMO, GOLDEN]) {
      const graph = await load(root)
      const own = buildTools(graph, { apis: true })
      const theirs = buildTools(graph, { refuseUnusedValues: false })
      for (const entity of graph.all()) {
        const ref = refOf(entity)
        if (entity.kind === 'API') continue
        if (entity.kind === 'Component' && (entity.spec.providesApis ?? []).length > 0) continue
        expect(own.run(call('get_entity', { ref })).result).toEqual(
          theirs.run(call('get_entity', { ref })).result,
        )
        if (root === GOLDEN) continue
        for (const direction of ['dependencies', 'dependants', 'consumers']) {
          expect(own.run(call('get_dependencies', { ref, direction })).result).toEqual(
            theirs.run(call('get_dependencies', { ref, direction })).result,
          )
        }
      }
    }
  })

  it('is what the offered-tools contract checks, get_apis included', async () => {
    expect((await offeredTools()).map((spec) => spec.name)).toContain('get_apis')
  })

  it("is checked beside the Architect's search, not in place of it", async () => {
    // Two specs of one name, both sent to a provider: the contract checks
    // every distinct spec an agent offers, and the Architect's is the one the
    // plan-mode tapes were recorded against.
    const searches = (await offeredTools()).filter((spec) => spec.name === 'search_entities')
    const offered = new Set(searches.map((spec) => spec.parameters))
    expect(offered.has(searchCriteriaSchema)).toBe(true)
    expect(offered.has(apiSearchCriteriaSchema)).toBe(true)
    expect(searches).toHaveLength(2)
  })
})

describe('an answer about APIs', () => {
  const calling = (name: string, args: unknown): GenerateResult => ({
    text: '',
    toolCalls: [{ id: `c-${name}`, name, args }],
    finishReason: 'tool-calls',
  })
  const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })
  const byAgent = (turns: Partial<Record<AgentName, GenerateResult[]>>): LlmClient => {
    const spent = new Map<AgentName, number>()
    return {
      generate: async (request) => {
        const index = spent.get(request.agent) ?? 0
        spent.set(request.agent, index + 1)
        return turns[request.agent]?.[index] ?? saying('')
      },
    }
  }

  const ask = async (analyst: GenerateResult[]) => {
    const errors: string[] = []
    const result = await runAsk({
      graph: await load(),
      client: byAgent({ supervisor: [saying('QUESTION')], analyst }),
      intent: 'who provides an API here?',
      source: { ignored: [], rejected: 0 },
      emit: () => {},
      err: (chunk) => void errors.push(chunk),
    })
    return { result, errors: errors.join('') }
  }

  it('prints the providers the tool returned, and keeps a sentence naming what it read', async () => {
    const { result, errors } = await ask([
      calling('get_apis', { ref: 'api:default/billing', direction: 'providedBy' }),
      calling('answer', {
        outcome: 'entities',
        refs: ['component:default/billing-api'],
        conclusion: 'billing-api provides the billing API.',
      }),
    ])
    expect(result.found).toBe(true)
    expect(result.text.startsWith('component:default/billing-api\n')).toBe(true)
    expect(result.text).toContain('\nprovides\n  api:default/billing\n')
    expect(result.text).toContain('› billing-api provides the billing API.')
    expect(errors).toBe('')
  })

  it('drops a sentence naming, in a plain word, an API no tool returned', async () => {
    // "billing" is a word of prose to anything that does not know the API of
    // that name. The check knows it because every API is one of its entities.
    const { result, errors } = await ask([
      calling('get_entity', { ref: 'component:default/orders-api' }),
      calling('answer', {
        outcome: 'entities',
        refs: ['component:default/orders-api'],
        conclusion: 'It does not use billing.',
      }),
    ])
    expect(result.found).toBe(true)
    expect(result.text).not.toContain('›')
    expect(errors).toContain("! the model's commentary named billing, which no tool returned")
  })

  it('refuses an answer naming an API the tools never returned', async () => {
    const { result, errors } = await ask([
      calling('search_entities', { kind: 'Component' }),
      calling('answer', { outcome: 'entities', refs: ['api:default/payments'] }),
    ])
    expect(result.found).toBe(false)
    expect(errors).toContain('api:default/payments, which no tool returned')
  })
})
