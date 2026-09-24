import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { answerQuestion } from '../../src/agents/analyst.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import { renderOverview } from '../../src/cli/render/overview.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { overviewOf } from '../../src/context/graph/overview.js'
import { answerSchema } from '../../src/core/schemas/query.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'

/**
 * "Talk about this project" used to end on `cannot answer`, exit 3: the Answer
 * had no member for it. The model now CHOOSES an overview and writes none of
 * it — the engine describes the graph (ADR-0007, the overview addendum).
 */

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

/** What a model might say while choosing. None of it may reach stdout. */
const PROSE = 'This project is a thriving platform of 12 microservices run by the Falcon team.'

const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      seen.push(request)
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

const calling = (name: string, args: unknown, text = ''): GenerateResult => ({
  text,
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const OVERVIEW_TURNS = {
  supervisor: [{ text: 'QUESTION', toolCalls: [], finishReason: 'stop' }],
  analyst: [calling('answer', { outcome: 'overview' }, PROSE)],
} satisfies Partial<Record<AgentName, GenerateResult[]>>

const run = async (argv: string[], deps: MainDeps = {}) => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(argv, {
    root: FIXTURES,
    client: scripted(OVERVIEW_TURNS),
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
  })
  return { code, out: out.join(''), err: err.join(''), events }
}

describe('ask for an overview, end to end', () => {
  it('answers "Talk about this project" with the overview the engine wrote, exit 0', async () => {
    const { code, out, events } = await run(['ask', 'Talk about this project'])
    const { entities } = await new FixtureProvider(FIXTURES).load()
    const expected = renderOverview(
      overviewOf(EntityGraph.from(entities), { ignored: [], rejected: 0 }),
      {},
    )

    expect(code).toBe(0)
    // Byte for byte what the engine renders from the graph, and so nothing else.
    expect(out).toBe(`${expected}\n`)
    expect(out).toMatch(/demo SI/)
    expect(out).not.toContain('Falcon')
    expect(out).not.toContain('thriving')
    expect(events).toContainEqual({ type: 'answer:ready', outcome: 'overview', refs: [] })
  })

  it('names the repository it read, and counts what it set aside and rejected', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ask-overview-'))
    await cp(FIXTURES, path.join(cwd, 'iac'), { recursive: true })
    const group = [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Group',
      'metadata:',
      '  name: tiger',
      'spec:',
      '  type: team',
      '  children: []',
      '',
    ].join('\n')
    await writeFile(path.join(cwd, 'iac', 'tiger.yml'), group, 'utf8')
    await writeFile(
      path.join(cwd, 'iac', 'broken.yml'),
      'apiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: Not A Name\n',
      'utf8',
    )

    const { code, out, err } = await run(['ask', '--repo', 'iac', 'what is in this SI?'], { cwd })

    expect(code).toBe(0)
    expect(out.split('\n')[0]).toContain('iac')
    expect(out).not.toMatch(/demo SI/)
    expect(out).toMatch(/not loaded\s+1 document this tool does not model/)
    expect(out).toMatch(/^\s+Group\s+1$/m)
    expect(out).toMatch(/rejected\s+1 document/)
    // The skipped line the rejection is named on is still where it always was.
    expect(err).toContain('skipped broken.yml')
  })

  it('names the repository by its folder, however it was reached', async () => {
    // "Overview of the repository .: 2 entities" was the headline `--repo .`
    // printed: the argument as typed, which names nothing.
    const parent = await mkdtemp(path.join(tmpdir(), 'ask-overview-folder-'))
    const repo = path.join(parent, 'IaC')
    await cp(FIXTURES, repo, { recursive: true })
    await mkdir(path.join(parent, 'elsewhere'))
    const headline = /^Overview of the repository IaC: 33 entities$/

    for (const [argv, cwd] of [
      [['ask', '--repo', '.', 'what is in this SI?'], repo],
      [['ask', '--repo', '../IaC', 'what is in this SI?'], path.join(parent, 'elsewhere')],
      [['ask', '--repo', `${repo}/`, 'what is in this SI?'], parent],
      [['ask', 'what is in this SI?'], repo],
    ] as const) {
      const { code, out } = await run([...argv], { cwd })
      expect(code).toBe(0)
      expect(out.split('\n')[0]).toMatch(headline)
    }
  })
})

describe('the answer tool, for an overview', () => {
  it('has no field for prose: whatever rides along is discarded, never kept', () => {
    // A model shown the flat advertisement fills `refs` and `reason` on every
    // outcome. Refusing them cost three turns and ended on a false "nothing
    // matched"; stripping them keeps the guarantee, because the overview is
    // written from the graph and nothing the model sent is read at all.
    expect(answerSchema.parse({ outcome: 'overview' })).toEqual({ outcome: 'overview' })
    expect(answerSchema.parse({ outcome: 'overview', text: PROSE })).toEqual({ outcome: 'overview' })
    expect(
      answerSchema.parse({ outcome: 'overview', refs: ['component:default/x'], reason: PROSE }),
    ).toEqual({ outcome: 'overview' })
  })

  it('discards the same extras on every other outcome, and keeps each one\'s own field', () => {
    const extras = { refs: ['component:default/x'], reason: PROSE, summary: PROSE }
    expect(answerSchema.parse({ ...extras, outcome: 'nothing' })).toEqual({ outcome: 'nothing' })
    expect(answerSchema.parse({ ...extras, outcome: 'entities' })).toEqual({
      outcome: 'entities',
      refs: ['component:default/x'],
    })
    expect(answerSchema.parse({ ...extras, outcome: 'unanswerable' })).toEqual({
      outcome: 'unanswerable',
      reason: PROSE,
    })
  })

  it('takes an overview with prose the first time, and keeps none of it', async () => {
    const { entities } = await new FixtureProvider(FIXTURES).load()
    const events: AgentEvent[] = []
    const client = scripted({
      analyst: [
        calling('answer', { outcome: 'overview', text: PROSE }),
        calling('answer', { outcome: 'overview' }),
      ],
    })
    const outcome = await answerQuestion(
      client,
      buildTools(EntityGraph.from(entities)),
      { intent: 'give me an overview of the catalogue', summary: '', vocabulary: '' },
      (event) => void events.push(event),
    )
    expect(outcome.answer).toEqual({ outcome: 'overview' })
    expect(client.seen).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('thriving')
  })

  it('tells the Analyst when to choose it, and never to refuse it', async () => {
    const client = scripted({ analyst: [calling('answer', { outcome: 'overview' })] })
    const { entities } = await new FixtureProvider(FIXTURES).load()
    await answerQuestion(
      client,
      buildTools(EntityGraph.from(entities)),
      { intent: 'Talk about this project', summary: '', vocabulary: '' },
      () => {},
    )
    const [request] = client.seen
    expect(request?.system).toMatch(/overview/)
    // The half that fixes the reported bug: an open question used to end as
    // `unanswerable`, and both places the model reads must say it never does.
    expect(request?.system).toMatch(/never answer\s+"unanswerable" for such a request/)
    const answer = request?.tools.find((tool) => tool.name === 'answer')
    expect(answer?.description).toMatch(/"overview"/)
    expect(answer?.description).toMatch(/never "unanswerable" for that/)
  })

  it('takes an overview chosen after a search: unlike "nothing", it contradicts nothing', async () => {
    const { entities } = await new FixtureProvider(FIXTURES).load()
    const events: AgentEvent[] = []
    const client = scripted({
      analyst: [
        calling('search_entities', { type: 'database', env: 'prod' }),
        calling('answer', { outcome: 'overview' }),
      ],
    })
    const outcome = await answerQuestion(
      client,
      buildTools(EntityGraph.from(entities)),
      { intent: 'what is in this SI?', summary: '', vocabulary: '' },
      (event) => void events.push(event),
    )
    // The search did witness entities, so a "nothing" here would be refused.
    expect(JSON.stringify(client.seen[1]?.transcript)).toMatch(/resource:default\//)
    expect(outcome.answer).toEqual({ outcome: 'overview' })
    expect(events.some((event) => event.type === 'refused')).toBe(false)
  })

  it('prints the overview, exit 0, when the Analyst searched before choosing it', async () => {
    const { code, out } = await run(['ask', 'Talk about this project'], {
      client: scripted({
        supervisor: OVERVIEW_TURNS.supervisor,
        analyst: [
          calling('search_entities', { kind: 'Resource' }),
          calling('answer', { outcome: 'overview' }, PROSE),
        ],
      }),
    })
    expect(code).toBe(0)
    expect(out).toMatch(/^Overview of the demo SI/)
    expect(out).not.toContain('thriving')
  })
})
