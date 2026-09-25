import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { runAsk, type AskOptions } from '../../src/cli/commands/ask.js'
import { runEntry } from '../../src/cli/commands/entry.js'
import { HELP, main, parseArguments } from '../../src/cli/index.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import type { AgentName, GenerateResult, LlmClient } from '../../src/llm/client.js'

/**
 * An answer reads like a chat (ADR-0008): a sentence of introduction the
 * model wrote, the engine's verified block exactly as it prints without one,
 * and a short conclusion. Every line of the model's is marked `› ` — the
 * engine's blocks never start with it — so a reader tells them apart in a pipe
 * with no colour; dimmed when the run wants colour. What the engine's check
 * left out is said once, on stderr.
 */

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const load = async (): Promise<EntityGraph> =>
  EntityGraph.from((await new FixtureProvider(ROOT).load()).entities)

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

const PROD_DBS = ['resource:default/billing-db-prod', 'resource:default/orders-db-prod']
const SEARCH = calling('search_entities', { type: 'database', env: 'prod' })

const analyst = (answer: Record<string, unknown>): Partial<Record<AgentName, GenerateResult[]>> => ({
  supervisor: [saying('QUESTION')],
  analyst: [SEARCH, calling('answer', answer)],
})

const ask = async (
  answer: Record<string, unknown>,
  options: Partial<Pick<AskOptions, 'colour' | 'quiet' | 'intent'>> = {},
) => {
  const events: AgentEvent[] = []
  const errors: string[] = []
  const result = await runAsk({
    graph: await load(),
    client: byAgent(analyst(answer)),
    intent: 'which databases are in prod?',
    source: { ignored: [], rejected: 0 },
    emit: (event) => void events.push(event),
    err: (chunk) => void errors.push(chunk),
    ...options,
  })
  return { result, events, errors: errors.join('') }
}

const TABLE = { outcome: 'entities', refs: PROD_DBS }
const INTRO = 'Two databases run in production.'
const CONCLUSION = 'Both belong to the billing and orders domains. Neither is shared.'

describe('runAsk frames the verified block with the model commentary', () => {
  it('prints intro, blank line, the block unchanged, blank line, conclusion', async () => {
    const bare = await ask(TABLE)
    const framed = await ask({ ...TABLE, intro: INTRO, conclusion: CONCLUSION })

    expect(framed.result.found).toBe(true)
    expect(framed.result.text).toBe(
      `› ${INTRO}\n\n${bare.result.text}\n\n` +
        '› Both belong to the billing and orders domains.\n› Neither is shared.',
    )
    expect(framed.errors).toBe('')
  })

  it('marks every line of the model with a sign no engine line starts with', async () => {
    const bare = await ask(TABLE)
    for (const line of bare.result.text.split('\n')) expect(line.startsWith('›')).toBe(false)
  })

  it('prints only what there is: an introduction alone, a conclusion alone', async () => {
    const bare = await ask(TABLE)
    expect((await ask({ ...TABLE, intro: INTRO })).result.text).toBe(
      `› ${INTRO}\n\n${bare.result.text}`,
    )
    expect((await ask({ ...TABLE, conclusion: 'Neither is shared.' })).result.text).toBe(
      `${bare.result.text}\n\n› Neither is shared.`,
    )
  })

  it('frames a single entity card, a "nothing" and an overview the same way', async () => {
    const card = await ask({ outcome: 'entities', refs: [PROD_DBS[0]], intro: 'Here it is.' })
    expect(card.result.text.startsWith('› Here it is.\n\n')).toBe(true)
    expect(card.result.text).toContain('reached by services')

    const events: AgentEvent[] = []
    const nothing = await runAsk({
      graph: await load(),
      client: byAgent({
        supervisor: [saying('QUESTION')],
        analyst: [calling('answer', { outcome: 'nothing', intro: 'I looked.', conclusion: 'None.' })],
      }),
      intent: 'is there a mainframe?',
      source: { ignored: [], rejected: 0 },
      emit: (event) => void events.push(event),
      err: () => {},
    })
    expect(nothing.found).toBe(false)
    expect(nothing.text).toBe('› I looked.\n\nNo entity matches that question.\n\n› None.')

    const overview = await runAsk({
      graph: await load(),
      client: byAgent({
        supervisor: [saying('QUESTION')],
        analyst: [calling('answer', { outcome: 'overview', intro: 'Here is the catalogue.' })],
      }),
      intent: 'talk about this project',
      source: { ignored: [], rejected: 0 },
      emit: () => {},
      err: () => {},
    })
    expect(overview.text).toMatch(/^› Here is the catalogue\.\n\nOverview of the demo SI/)
  })

  it('dims the model lines when the run wants colour, and leaves the block alone', async () => {
    const bare = await ask(TABLE)
    const { result } = await ask(
      { ...TABLE, intro: INTRO, conclusion: 'Neither is shared.' },
      { colour: true },
    )
    expect(result.text).toBe(
      `\u001B[2m› ${INTRO}\u001B[22m\n\n${bare.result.text}\n\n\u001B[2m› Neither is shared.\u001B[22m`,
    )
  })

  it('keeps the commentary off the event stream', async () => {
    const { events } = await ask({ ...TABLE, intro: INTRO, conclusion: CONCLUSION })
    const stream = JSON.stringify(events)
    expect(stream).not.toContain('Two databases')
    expect(stream).not.toContain('Neither')
    expect(events).toContainEqual({ type: 'answer:ready', outcome: 'entities', refs: PROD_DBS })
  })
})

describe('runAsk, when the engine leaves a sentence out', () => {
  it('prints the rest, and says on stderr what the left-out sentence named', async () => {
    const bare = await ask(TABLE)
    const { result, errors } = await ask({
      ...TABLE,
      intro: INTRO,
      conclusion: 'Both are in prod. The same holds for billing-db-dev.',
    })
    expect(result.text).toBe(`› ${INTRO}\n\n${bare.result.text}\n\n› Both are in prod.`)
    expect(result.text).not.toContain('billing-db-dev')
    expect(errors).toBe(
      "! the model's commentary named billing-db-dev, which no tool returned; " +
        'that sentence was left out\n',
    )
  })

  it('says it once per answer, naming each thing once, in the plural when it is', async () => {
    const { errors } = await ask({
      ...TABLE,
      intro: 'It is not billing-db-dev.',
      conclusion: 'Nor ghost-db. Nor billing-db-dev again.',
    })
    expect(errors).toBe(
      "! the model's commentary named billing-db-dev and ghost-db, which no tool returned; " +
        'those 3 sentences were left out\n',
    )
  })

  it('cleans and bounds what it quotes', async () => {
    const hostile = `ghost\u001B[2J-db-${'x'.repeat(300)}`
    const { errors } = await ask({ ...TABLE, conclusion: `Also ${hostile}.` })
    expect(errors).not.toContain('\u001B')
    expect(errors.split('\n')).toHaveLength(2)
    expect(errors.length).toBeLessThan(260)
  })

  it('says nothing about a sentence left out only for length', async () => {
    const { result, errors } = await ask({ ...TABLE, intro: 'One. Two.' })
    expect(result.text.startsWith('› One.\n\n')).toBe(true)
    expect(errors).toBe('')
  })
})

describe('--quiet', () => {
  it('prints the verified block alone: no commentary, no line about it', async () => {
    const bare = await ask(TABLE)
    const { result, errors } = await ask(
      { ...TABLE, intro: INTRO, conclusion: 'Nor ghost-db.' },
      { quiet: true },
    )
    expect(result.text).toBe(bare.result.text)
    expect(errors).toBe('')
  })

  it('is parsed on ask and on a phrase, and is absent unless given', () => {
    expect(parseArguments(['ask', '--quiet', 'which databases?'])).toStrictEqual({
      name: 'ask',
      intent: 'which databases?',
      quiet: true,
    })
    expect(parseArguments(['ask', 'which databases?'])).toStrictEqual({
      name: 'ask',
      intent: 'which databases?',
    })
    expect(parseArguments(['which databases?', '--quiet'])).toStrictEqual({
      name: 'entry',
      phrase: 'which databases?',
      json: false,
      quiet: true,
    })
    expect(parseArguments(['show', 'billing-api', '--quiet']).name).toBe('error')
  })

  it('is in the help', () => {
    expect(HELP).toMatch(/idp-agent ask "<question>" \[--repo <directory> \| --demo\] \[--quiet\]/)
    expect(HELP).toMatch(/idpa "<phrase>" .*\[--quiet\]/)
  })

  it('does nothing on the change road, and says nothing about it', async () => {
    const errors: string[] = []
    const result = await runEntry({
      graph: await load(),
      client: byAgent({ supervisor: [saying('MUTATION')] }),
      intent: 'give billing-api read access to orders-db-prod',
      source: { ignored: [], rejected: 0 },
      emit: () => {},
      err: (chunk) => void errors.push(chunk),
      json: false,
      quiet: true,
      change: async () => ({ text: 'the preview', found: true }),
    })
    expect(result).toEqual({ text: 'the preview', found: true })
    expect(errors).toEqual([])
  })

  it('reaches the answer through main, on ask and on a phrase', async () => {
    for (const argv of [
      ['ask', '--demo', '--quiet', 'which databases are in prod?'],
      ['which databases are in prod?', '--demo', '--quiet'],
    ]) {
      const out: string[] = []
      const err: string[] = []
      const code = await main(argv, {
        root: ROOT,
        client: byAgent(analyst({ ...TABLE, intro: INTRO, conclusion: 'Nor ghost-db.' })),
        out: (chunk) => void out.push(chunk),
        err: (chunk) => void err.push(chunk),
        events: () => {},
      })
      expect(code, argv.join(' ')).toBe(0)
      expect(out.join('')).not.toContain('›')
      expect(out.join('')).toContain('billing-db-prod')
      expect(err.join('')).not.toContain('commentary')
    }
  })
})

describe('main, on a question answered with commentary', () => {
  it('prints it uncoloured into an injected sink, with the drop line on stderr', async () => {
    const out: string[] = []
    const err: string[] = []
    const events: AgentEvent[] = []
    const code = await main(['which databases are in prod?', '--demo'], {
      root: ROOT,
      client: byAgent(
        analyst({ ...TABLE, intro: INTRO, conclusion: 'Both are in prod. Nor ghost-db.' }),
      ),
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      events: (event) => void events.push(event),
    })
    expect(code).toBe(0)
    const printed = out.join('')
    expect(printed.startsWith(`› ${INTRO}\n\nNAME`)).toBe(true)
    expect(printed.endsWith('\n\n› Both are in prod.\n')).toBe(true)
    expect(printed).not.toContain('\u001B')
    expect(err.join('')).toContain(
      "! the model's commentary named ghost-db, which no tool returned; that sentence was left out\n",
    )
    expect(JSON.stringify(events)).not.toContain('Both are in prod')
  })
})

describe('main, writing to the terminal itself', () => {
  // Every other test injects `out`, and an injected sink is never painted. Here
  // main writes to process.stdout, so what decides the colour is the one thing
  // that decides it for a person: the environment (NO_COLOR, FORCE_COLOR). No
  // HOME in it, so no personal configuration is read.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const printed = async (argv: string[], env: Record<string, string>): Promise<string> => {
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    const code = await main(argv, {
      root: ROOT,
      client: byAgent(analyst({ ...TABLE, intro: 'Two.', conclusion: 'Neither is shared.' })),
      err: () => {},
      events: () => {},
      env,
    })
    vi.restoreAllMocks()
    expect(code, argv.join(' ')).toBe(0)
    return written.join('')
  }

  for (const argv of [
    ['ask', '--demo', 'which databases are in prod?'],
    ['which databases are in prod?', '--demo'],
  ]) {
    it(`dims the model's lines when colour is wanted: ${argv[0] ?? ''}`, async () => {
      const text = await printed(argv, { FORCE_COLOR: '1' })
      expect(text.startsWith('\u001B[2m› Two.\u001B[22m\n\nNAME')).toBe(true)
      expect(text.endsWith('\n\n\u001B[2m› Neither is shared.\u001B[22m\n')).toBe(true)
    })

    it(`leaves them plain, and still marked, under NO_COLOR: ${argv[0] ?? ''}`, async () => {
      const text = await printed(argv, { FORCE_COLOR: '1', NO_COLOR: '1' })
      expect(text.startsWith('› Two.\n\nNAME')).toBe(true)
      expect(text.endsWith('\n\n› Neither is shared.\n')).toBe(true)
      expect(text).not.toContain('\u001B')
    })
  }
})

describe('main, on commentary the check cannot see through', () => {
  // ADR-0008's documented limit, pinned: a sentence in ordinary words names no
  // entity and no identifier, so it passes — an invented team, a figure that
  // contradicts the block under it. It is printed, and it is printed marked.
  it('prints it labelled as the model, and says nothing on stderr', async () => {
    const out: string[] = []
    const err: string[] = []
    const intro = 'This project is a platform of 12 microservices run by the Falcon team.'
    const code = await main(['talk about this project', '--demo'], {
      root: ROOT,
      client: byAgent({
        supervisor: [saying('QUESTION')],
        analyst: [calling('answer', { outcome: 'overview', intro })],
      }),
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      events: () => {},
    })
    expect(code).toBe(0)
    expect(out.join('')).toMatch(/^› This project is a platform of 12 microservices run by the Falcon team\.\n\nOverview of the demo SI/)
    expect(err.join('')).not.toContain('commentary')
  })
})

describe("the README's example", () => {
  it('prints what the README says it prints, byte for byte', async () => {
    // README.md shows this answer; a README that drifted from the code would
    // be read as the behaviour.
    const readme = await (await import('node:fs/promises')).readFile(
      path.resolve(import.meta.dirname, '../../README.md'),
      'utf8',
    )
    const shown = /```console\n\$ idpa "which databases are in prod\?"\n([\s\S]*?)```/.exec(readme)?.[1]
    expect(shown).toBeDefined()

    const out: string[] = []
    const code = await main(['which databases are in prod?', '--demo'], {
      root: ROOT,
      client: byAgent({
        supervisor: [saying('QUESTION')],
        analyst: [
          SEARCH,
          calling('answer', {
            outcome: 'entities',
            refs: [
              'resource:default/billing-db-prod',
              'resource:default/compliance-db-prod',
              'resource:default/mysql-prod-01',
              'resource:default/orders-db-prod',
            ],
            intro: 'These are the databases declared in production.',
            conclusion:
              'The search matched on type and environment only. ' +
              'A database with no environment declared would not be listed here.',
          }),
        ],
      }),
      out: (chunk) => void out.push(chunk),
      err: () => {},
      events: () => {},
    })
    expect(code).toBe(0)
    expect(out.join('')).toBe(shown)
  })
})
