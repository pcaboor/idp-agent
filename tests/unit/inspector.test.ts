import { describe, expect, it } from 'vitest'
import { INSPECTOR_LIMITS, inspect } from '../../src/agents/inspector.js'
import { buildProjectTools } from '../../src/agents/tools/project-tools.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { renderEvent } from '../../src/cli/index.js'
import type { ProjectSnapshot } from '../../src/context/project-fs/snapshot.js'
import type {
  GenerateRequest,
  GenerateResult,
  LlmClient,
  ModelToolCall,
} from '../../src/llm/client.js'

/** Replays a scripted sequence of model turns, so the loop is tested without a model. */
const scripted = (turns: GenerateResult[]): LlmClient & { calls: number } => {
  const client = {
    calls: 0,
    generate: async (): Promise<GenerateResult> => {
      const turn = turns[client.calls] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      client.calls += 1
      return turn
    },
  }
  return client
}

/** The same replay, keeping every request so a test can assert what the model was told. */
const capturing = (
  turns: GenerateResult[],
): LlmClient & { seen: GenerateRequest[] } => {
  const client = {
    seen: [] as GenerateRequest[],
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      client.seen.push(request)
      return turns[client.seen.length - 1] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
  return client
}

const toolCall = (name: string, args: unknown): ModelToolCall => ({ id: 'c1', name, args })
const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [toolCall(name, args)],
  finishReason: 'tool-calls',
})

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

/**
 * An absolute path of the shape `readProject` really returns, and the string
 * every "hands over no filesystem path" assertion below looks for. Its last
 * segment is a plausible service name on purpose: deriving `name` from it is
 * exactly the guess rule 1 of the schema forbids.
 */
const ROOT = '/private/var/folders/zz/billing-api'

const snapshotOf = (
  files: Array<{ path: string; text: string }>,
  skipped: Array<{ path: string; reason: string }> = [],
  truncated = false,
): ProjectSnapshot => ({ root: ROOT, files, skipped, truncated })

const EMPTY = snapshotOf([])

/** Every field of a report, so a test can override one and keep the rest valid. */
const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: { unknown: 'no entity reference is stated in this repository' },
  forgeHandle: { unknown: 'this repository has no CODEOWNERS' },
  dependencies: [],
  ...over,
})

const FACT_FIELDS = [
  'dependencies',
  'forgeHandle',
  'lifecycle',
  'name',
  'owner',
  'runtime',
  'type',
]

describe('projectFactsSchema', () => {
  it('holds every fact the Architect needs and no field nobody consumes', async () => {
    const client = scripted([turnCalling('report_facts', report())])
    const { emit } = collect()
    expect(Object.keys(await inspect(client, EMPTY, emit)).sort()).toEqual(FACT_FIELDS)
  })

  it('refuses a report that omits a field, because an omission reads as a value', async () => {
    // Never omitted, never guessed (design 5.4). A ProjectFacts missing `owner`
    // and one carrying `{unknown}` look the same to `findUnknowns`, and only the
    // second stops the plan and asks.
    const { name: _dropped, ...withoutName } = report()
    const client = scripted([
      turnCalling('report_facts', withoutName),
      turnCalling('report_facts', report()),
    ])
    const { emit } = collect()
    expect((await inspect(client, EMPTY, emit)).name).toBe('billing-api')
  })
})

describe('inspect', () => {
  it('carries the error of a refused read on its tool:result, and the terminal prints it', async () => {
    // A refused read counts no rows; without the error the stream drew it as
    // "← 0 row(s)", a read that ran and found nothing.
    const client = scripted([
      turnCalling('read_file', { path: 'missing.json' }),
      turnCalling('report_facts', report()),
    ])
    const { events, emit } = collect()
    await inspect(client, EMPTY, emit)
    const result = events.find((event) => event.type === 'tool:result')
    expect(result).toMatchObject({
      type: 'tool:result',
      name: 'read_file',
      rows: 0,
      error: 'this snapshot holds no file at that path',
    })
    expect(result === undefined ? undefined : renderEvent(result)).toBe(
      '  ← refused: this snapshot holds no file at that path',
    )
  })

  it('returns the facts the model signed off through the terminal tool', async () => {
    const client = scripted([
      turnCalling('list_files', {}),
      turnCalling('report_facts', report({ runtime: 'node 22' })),
    ])
    const { emit } = collect()
    const facts = await inspect(client, snapshotOf([{ path: 'package.json', text: '{}' }]), emit)
    expect(facts.runtime).toBe('node 22')
  })

  it('reports a repository with no manifest as unknown, never a name taken from its root', async () => {
    // The whole of rule 1. `/private/var/folders/zz/billing-api` makes a very
    // convincing `billing-api`, and no file in this snapshot says so.
    const client = scripted([turnCalling('list_files', {})])
    const { emit } = collect()
    const facts = await inspect(client, snapshotOf([{ path: 'README.md', text: 'hello' }]), emit)
    expect(facts.name).toEqual({ unknown: expect.any(String) })
    expect(JSON.stringify(facts)).not.toContain('billing-api')
  })

  it('leaves every fact unknown when the model never reports, rather than half-filling one', async () => {
    const client = scripted([{ text: 'looks like a service', toolCalls: [], finishReason: 'stop' }])
    const { emit } = collect()
    const facts = await inspect(client, EMPTY, emit)
    for (const value of Object.values(facts)) {
      expect(value).toEqual({ unknown: expect.any(String) })
    }
  })

  it('does not turn a forge handle in CODEOWNERS into an owner reference', async () => {
    // `scaffold/codeowners.ts` refuses this round trip in the other direction:
    // "@acme/platform" and "group:default/platform" are different namespaces and
    // one flag cannot be both. Translating here would invent a reference nobody
    // declared, and an owner is who gets to authorise.
    const client = scripted([
      turnCalling('read_file', { path: 'CODEOWNERS' }),
      turnCalling('report_facts', report({ owner: '@acme/platform' })),
      turnCalling(
        'report_facts',
        report({
          owner: { unknown: 'CODEOWNERS states a forge handle, which is not an entity reference' },
          forgeHandle: '@acme/platform',
        }),
      ),
    ])
    const { emit } = collect()
    const facts = await inspect(
      client,
      snapshotOf([{ path: 'CODEOWNERS', text: '*  @acme/platform\n' }]),
      emit,
    )
    expect(facts.owner).toEqual({ unknown: expect.any(String) })
    expect(facts.forgeHandle).toBe('@acme/platform')
    expect(JSON.stringify(facts)).not.toContain('group:')
  })

  it('puts a malformed report back in the transcript instead of failing the inspection', async () => {
    // Same repair the Analyst makes for a malformed `answer`: the model gets to
    // correct itself rather than the whole inspection ending on one bad call.
    const client = scripted([
      turnCalling('report_facts', { name: 42 }),
      turnCalling('report_facts', report()),
    ])
    const { emit } = collect()
    expect((await inspect(client, EMPTY, emit)).name).toBe('billing-api')
  })

  it('names the field a malformed report got wrong, so the model can repair it', async () => {
    const client = capturing([
      turnCalling('report_facts', report({ owner: '@acme/platform' })),
      turnCalling('report_facts', report()),
    ])
    const { emit } = collect()
    await inspect(client, EMPTY, emit)
    expect(JSON.stringify(client.seen.at(-1)?.transcript)).toContain('owner')
  })

  it('stops at its turn bound and refuses rather than reporting a partial guess', async () => {
    const client = scripted(
      Array.from({ length: 20 }, () => turnCalling('read_file', { path: 'package.json' })),
    )
    const { events, emit } = collect()
    const facts = await inspect(
      client,
      snapshotOf([{ path: 'package.json', text: '{"name":"billing"}' }]),
      emit,
    )
    expect(client.calls).toBeLessThanOrEqual(INSPECTOR_LIMITS.maxTurns)
    expect(facts.name).toEqual({ unknown: expect.any(String) })
    expect(events.map((event) => event.type)).toEqual([
      'agent:start',
      ...Array.from({ length: INSPECTOR_LIMITS.maxTurns }, () => ['tool:call', 'tool:result']).flat(),
      'refused',
    ])
    expect(events.at(0)).toEqual({ type: 'agent:start', agent: 'inspector' })
    expect(events.at(-1)).toEqual({ type: 'refused', agent: 'inspector', reason: expect.any(String) })
  })

  it('gives up early when the reads keep returning nothing', async () => {
    const client = scripted(
      Array.from({ length: 20 }, () => turnCalling('read_file', { path: 'nowhere.json' })),
    )
    const { emit } = collect()
    await inspect(client, EMPTY, emit)
    expect(client.calls).toBeLessThanOrEqual(INSPECTOR_LIMITS.maxBarrenTurns + 1)
    expect(client.calls).toBeLessThan(INSPECTOR_LIMITS.maxTurns)
  })

  it('caps the calls it executes in one turn and says the rest were not run', async () => {
    const many = Array.from({ length: 9 }, () => toolCall('list_files', {}))
    const client = capturing([
      { text: '', toolCalls: many, finishReason: 'tool-calls' },
      turnCalling('report_facts', report()),
    ])
    const { events, emit } = collect()
    await inspect(client, snapshotOf([{ path: 'package.json', text: '{}' }]), emit)
    expect(events.filter((event) => event.type === 'tool:call')).toHaveLength(
      INSPECTOR_LIMITS.maxCallsPerTurn,
    )
    expect(JSON.stringify(client.seen.at(-1)?.transcript)).toContain('not executed')
  })

  it('degrades to an open tool choice when the provider rejects a forced one', async () => {
    const seen: unknown[] = []
    let calls = 0
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request.toolChoice)
        calls += 1
        if (typeof request.toolChoice === 'object') {
          throw new Error("Model response did not contain a call to the required tool 'report_facts'.")
        }
        return calls > 3
          ? turnCalling('report_facts', report())
          : turnCalling('read_file', { path: 'package.json' })
      },
    }
    const { emit } = collect()
    // Productive reads, so the barren bound does not end the loop first: this
    // case is about the forced tool choice and nothing else.
    const facts = await inspect(
      client,
      snapshotOf([{ path: 'package.json', text: '{}' }]),
      emit,
    )
    expect(seen).toContain('auto')
    expect(facts.name).toBe('billing-api')
  })

  it('does not swallow a failure that has nothing to do with the tool choice', async () => {
    const client: LlmClient = {
      generate: async () => {
        throw new Error('the provider is down')
      },
    }
    const { emit } = collect()
    await expect(inspect(client, EMPTY, emit)).rejects.toThrow(/provider is down/)
  })

  it('closes the event stream as stopped, not refused, before letting a failure through', async () => {
    // Nothing was judged: the call beneath the agent threw. The caller prints
    // the error; the stream only has to show the agent ended.
    const client: LlmClient = {
      generate: () => Promise.reject(new Error('502 from the gateway')),
    }
    const { events, emit } = collect()
    await expect(inspect(client, EMPTY, emit)).rejects.toThrow('502')
    expect(events).toEqual([
      { type: 'agent:start', agent: 'inspector' },
      { type: 'stopped', agent: 'inspector', reason: '502 from the gateway' },
    ])
  })

  it('tells the model what the snapshot excluded, without being asked for it', async () => {
    // A model told "here is the repository" about a snapshot that silently
    // dropped half of it answers confidently about the missing half. No tool
    // returns this list, so it cannot be discovered — it has to arrive unasked.
    const client = capturing([turnCalling('report_facts', report())])
    const { emit } = collect()
    await inspect(
      client,
      snapshotOf(
        [{ path: 'README.md', text: 'hello' }],
        [
          { path: '.env', reason: 'excluded: an environment file is where credentials live' },
          { path: 'src/id_rsa', reason: 'excluded: this is the name of a private key' },
        ],
      ),
      emit,
    )
    const opening = JSON.stringify(client.seen[0]?.transcript[0])
    expect(opening).toContain('.env')
    expect(opening).toContain('an environment file is where credentials live')
    expect(opening).toContain('src/id_rsa')
  })

  it('says when a cap stopped the harvest, so absence is not read as emptiness', async () => {
    const client = capturing([turnCalling('report_facts', report())])
    const { emit } = collect()
    await inspect(client, snapshotOf([{ path: 'a.ts', text: '' }], [], true), emit)
    expect(JSON.stringify(client.seen[0]?.transcript[0])).toMatch(/cap stopped/i)
  })

  it('never puts the repository root in front of the model', async () => {
    const client = capturing([
      turnCalling('list_files', {}),
      turnCalling('read_file', { path: 'package.json' }),
      turnCalling('report_facts', report()),
    ])
    const { emit } = collect()
    await inspect(
      client,
      snapshotOf([{ path: 'package.json', text: '{}' }], [{ path: '.env', reason: 'excluded' }]),
      emit,
    )
    expect(JSON.stringify(client.seen)).not.toContain(ROOT)
    expect(JSON.stringify(client.seen)).not.toContain('/private/var')
  })
})

describe('buildProjectTools', () => {
  const snapshot = snapshotOf(
    [
      { path: 'package.json', text: '{"name":"billing"}' },
      { path: 'src/index.ts', text: 'export {}' },
    ],
    [{ path: '.env', reason: 'excluded: an environment file is where credentials live' }],
  )

  it('hands over no filesystem path: it speaks only in project-relative paths', () => {
    // The snapshot knows where the repository is; nothing the model sees does.
    // An absolute path is the user's machine, and it is also the one string a
    // steered model could use to ask for something outside the project.
    const tools = buildProjectTools(snapshot)
    const shown = [
      JSON.stringify(tools.specs.map((spec) => [spec.name, spec.description])),
      JSON.stringify(tools.run(toolCall('list_files', {})).result),
      JSON.stringify(tools.run(toolCall('read_file', { path: 'package.json' })).result),
      JSON.stringify(tools.run(toolCall('read_file', { path: '.env' })).result),
      JSON.stringify(tools.run(toolCall('read_file', { path: 'nowhere' })).result),
    ]
    for (const output of shown) {
      expect(output).not.toContain(ROOT)
      expect(output).not.toContain('/private/var')
    }
  })

  it('lists the files the snapshot actually holds', () => {
    const outcome = buildProjectTools(snapshot).run(toolCall('list_files', {}))
    expect(outcome.result).toEqual({ paths: ['package.json', 'src/index.ts'] })
    expect(outcome.rows).toBe(2)
  })

  it('reads one file by its exact path, and refuses a near miss', () => {
    const tools = buildProjectTools(snapshot)
    expect(tools.run(toolCall('read_file', { path: 'package.json' })).result).toEqual({
      path: 'package.json',
      text: '{"name":"billing"}',
    })
    // No nearest match, deliberately — the same refusal `get_entity` makes.
    expect(tools.run(toolCall('read_file', { path: 'package.jso' })).rows).toBe(0)
  })

  it('gives the exclusion reason for a path that was skipped, not "no such file"', () => {
    // A model told the manifest is missing looks elsewhere; a model told it was
    // excluded knows the fact is unknowable from here and reports it unknown.
    const outcome = buildProjectTools(snapshot).run(toolCall('read_file', { path: '.env' }))
    expect(JSON.stringify(outcome.result)).toContain('credentials')
    expect(outcome.rows).toBe(0)
  })

  it('returns an error rather than throwing when arguments do not parse', () => {
    const tools = buildProjectTools(snapshot)
    expect(tools.run(toolCall('read_file', { wrong: 1 })).result).toHaveProperty('error')
    expect(tools.run(toolCall('who_knows', {})).result).toHaveProperty('error')
  })

  it('offers a terminal tool and returns its arguments unvouched for', () => {
    const tools = buildProjectTools(snapshot)
    expect(tools.specs.map((spec) => spec.name)).toEqual([
      'list_files',
      'read_file',
      'report_facts',
    ])
    expect(tools.run(toolCall('report_facts', { name: 'x' })).result).toEqual({ name: 'x' })
  })
})
