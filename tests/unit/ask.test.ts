import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { runAsk } from '../../src/cli/commands/ask.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { QUERY_LIMITS } from '../../src/core/schemas/query.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const load = async (): Promise<EntityGraph> =>
  EntityGraph.from((await new FixtureProvider(ROOT).load()).entities)

const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: 'c1', name, args }],
  finishReason: 'tool-calls',
})
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

const scripted = (turns: GenerateResult[]): LlmClient => {
  let index = 0
  return { generate: async () => turns[index++] ?? saying('') }
}

const ask = async (turns: GenerateResult[], intent = 'which databases are in prod?') => {
  const events: AgentEvent[] = []
  const errors: string[] = []
  const result = await runAsk({
    graph: await load(),
    client: scripted(turns),
    intent,
    source: { ignored: [], rejected: 0 },
    emit: (event) => void events.push(event),
    err: (chunk) => void errors.push(chunk),
  })
  return { result, events, errors: errors.join('') }
}

const FOUND = [
  saying('QUESTION'),
  calling('search_entities', { type: 'database', env: 'prod' }),
]

describe('runAsk on a question', () => {
  it('prints the table the graph would print, not what the model wrote', async () => {
    const { result } = await ask([
      ...FOUND,
      calling('answer', {
        outcome: 'entities',
        refs: ['resource:default/billing-db-prod', 'resource:default/orders-db-prod'],
      }),
    ])
    expect(result.found).toBe(true)
    expect(result.text).toContain('billing-db-prod')
    expect(result.text).toContain('orders-db-prod')
    expect(result.text).toContain('NAME')
  })

  it('renders one entity as a detail view rather than a one-row table', async () => {
    const { result } = await ask([
      ...FOUND,
      calling('answer', { outcome: 'entities', refs: ['resource:default/billing-db-prod'] }),
    ])
    expect(result.text).toContain('reached by services')
  })

  it('sorts the references, since the model order is not one anybody verified', async () => {
    const { result } = await ask([
      ...FOUND,
      calling('answer', {
        outcome: 'entities',
        refs: ['resource:default/orders-db-prod', 'resource:default/billing-db-prod'],
      }),
    ])
    expect(result.text.indexOf('billing-db-prod')).toBeLessThan(
      result.text.indexOf('orders-db-prod'),
    )
  })

  it('reports nothing found without claiming it is an error', async () => {
    const { result } = await ask([saying('QUESTION'), calling('answer', { outcome: 'nothing' })])
    expect(result.found).toBe(false)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain('No entity matches')
  })

  it('sends an unanswerable reason to stderr and never to stdout', async () => {
    // The only model-authored text in the build. It does not get to look like
    // an answer.
    const { result, errors } = await ask([
      saying('QUESTION'),
      calling('answer', { outcome: 'unanswerable', reason: 'the catalogue holds no cost data' }),
    ])
    expect(result.unsupported).toBe(true)
    expect(errors).toContain('the catalogue holds no cost data')
    expect(result.text).not.toContain('cost data')
  })

  it('refuses an invented reference and says which one', async () => {
    const { result, errors } = await ask([
      ...FOUND,
      calling('answer', { outcome: 'entities', refs: ['resource:default/ghost-db'] }),
    ])
    expect(result.unsupported).toBe(true)
    expect(errors).toContain('ghost-db')
  })
})

describe('runAsk when the tools had to cut the result', () => {
  it('says how many rows are missing instead of printing a short list in silence', async () => {
    // What you see must not look complete when it is not. This is the failure
    // the tool exists to prevent, and it reached a user before it reached a
    // test: `ask "list all resources"` printed 25 of 28.
    const { result } = await ask([
      saying('QUESTION'),
      calling('search_entities', { kind: 'Resource' }),
      calling('answer', {
        outcome: 'entities',
        refs: [
          'resource:default/billing-db-prod',
          'resource:default/orders-db-prod',
        ],
      }),
    ], 'list every resource')
    expect(result.found).toBe(true)
    expect(result.text).toMatch(/more not shown|not shown/i)
  })

  it('says nothing about truncation when nothing was cut', async () => {
    const { result } = await ask([
      saying('QUESTION'),
      calling('search_entities', { type: 'database', env: 'prod' }),
      calling('answer', {
        outcome: 'entities',
        refs: ['resource:default/billing-db-prod', 'resource:default/orders-db-prod'],
      }),
    ])
    expect(result.text).not.toMatch(/not shown/i)
  })
})

describe('runAsk on a change request', () => {
  it('refuses it as unsupported rather than as a failed query', async () => {
    const { result, errors } = await ask(
      [saying('MUTATION')],
      'give billing-api read access to orders-db',
    )
    expect(result.unsupported).toBe(true)
    expect(errors).toContain('this build only reads')
  })

  it('never reaches the graph for a change request', async () => {
    const { events } = await ask([saying('MUTATION')], 'delete the billing database')
    expect(events.some((event) => event.type === 'tool:call')).toBe(false)
  })
})

describe('runAsk when the model will not classify', () => {
  it('reports the refusal instead of guessing which branch was meant', async () => {
    const { result, errors } = await ask([saying('PERHAPS')])
    expect(result.unsupported).toBe(true)
    expect(errors).toContain('PERHAPS')
  })
})

describe('runAsk, on what it hands a terminal', () => {
  /** Everything a terminal obeys, and a line break a stream would read as two. */
  // eslint-disable-next-line no-control-regex -- asserting their absence
  const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/

  it("cleans the model's reason for not answering, and keeps it to one bounded line", async () => {
    // A reason is the model's own prose (review finding security-4): a
    // clear-screen and a fake closing line would print on stderr as though
    // this tool had written them.
    const reason =
      'no cost data\u001B[2J\u001B[H\nexit 0: 3 grants mer\u009Bged\u001B]52;c;ZXZpbA==\u0007' +
      ' and more'.repeat(25)
    expect(reason.length).toBeLessThanOrEqual(QUERY_LIMITS.maxReason)
    const { result, errors } = await ask([
      saying('QUESTION'),
      calling('answer', { outcome: 'unanswerable', reason }),
    ])
    expect(result.unsupported).toBe(true)
    // Cleaned and flattened, and not cut: the schema already bounds a reason,
    // and an honest one is printed whole.
    expect(errors).toBe(
      `cannot answer: no cost data exit 0: 3 grants merged${' and more'.repeat(25)}\n`,
    )
    expect(errors.slice(0, -1)).not.toMatch(CONTROLS)
  })

  it("cleans the Supervisor's excerpt when it will not classify", async () => {
    const { errors } = await ask([saying('PER\u001B[2JHAPS\u001B]52;c;eA==\u0007\rx')])
    expect(errors).toContain('PERHAPS')
    expect(errors.slice(0, -1)).not.toMatch(CONTROLS)
  })

  it('cleans every cell of a table of entities, free-text types and environments included', async () => {
    const hostile = (name: string): Entity => ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name, annotations: { 'company.fr/env': 'prod\u001B[2J\nfake' } },
      spec: { type: 'web\u001B]52;c;eA==\u0007site', lifecycle: 'production', owner: 'group:default/tiger' },
    })
    const graph = EntityGraph.from([hostile('artist-web'), hostile('artist-api')])
    const result = await runAsk({
      graph,
      client: scripted([
        saying('QUESTION'),
        calling('search_entities', { kind: 'Component' }),
        calling('answer', {
          outcome: 'entities',
          refs: ['component:default/artist-api', 'component:default/artist-web'],
        }),
      ]),
      intent: 'which websites are there?',
      source: { ignored: [], rejected: 0 },
      emit: () => {},
      err: () => {},
    })
    expect(result.text.split('\n')).toHaveLength(3)
    // One row per entity, so a newline is the only control left, and only between rows.
    for (const line of result.text.split('\n')) expect(line).not.toMatch(CONTROLS)
    expect(result.text).toMatch(/artist-api\s+Component\s+website\s+prod fake\s+group:default\/tiger/)
  })
})
