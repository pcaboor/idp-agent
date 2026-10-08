import { zodSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { draftPlan } from '../../src/agents/architect.js'
import { INSPECTOR_LIMITS, inspect } from '../../src/agents/inspector.js'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import { REPORT_TOOL, buildProjectTools } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { renderEvent } from '../../src/cli/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import type { ProjectSnapshot } from '../../src/context/project-fs/snapshot.js'
import { objectRooted } from '../../src/llm/tool-schema.js'
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
  files: Array<{ path: string; text: string; undecodable?: true }>,
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
  ...over,
})

/**
 * A repository whose files state every value `report()` carries, by each
 * field's rule, and the turn that reads them all: a report is held to the
 * files read before it, so a test about something else reads them first.
 */
const STATED = snapshotOf([
  { path: 'package.json', text: '{\n  "name": "billing-api",\n  "engines": { "node": ">=22" }\n}\n' },
  { path: 'catalog-info.yaml', text: 'spec:\n  type: service\n  lifecycle: production\n' },
  { path: '.tool-versions', text: 'node 22\n' },
])
const readingAll: GenerateResult = {
  text: '',
  toolCalls: STATED.files.map((file, index) => ({
    id: `r${String(index)}`,
    name: 'read_file',
    args: { path: file.path },
  })),
  finishReason: 'tool-calls',
}

const FACT_FIELDS = [
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
      readingAll,
      turnCalling('report_facts', withoutName),
      turnCalling('report_facts', report()),
    ])
    const { emit } = collect()
    expect((await inspect(client, STATED, emit)).name).toBe('billing-api')
  })

  it('refuses a report that lists dependencies, and hands it back', async () => {
    // What a service installs is the discovery's, with its file and line, and
    // reaches no model. A report still listing them is refused by the strict
    // schema and handed back, never accepted with the list set aside.
    const reported = report()
    const client = capturing([
      readingAll,
      turnCalling('report_facts', { ...reported, dependencies: [{ name: 'pg', type: 'database' }] }),
      turnCalling('report_facts', reported),
    ])
    const { events, emit } = collect()
    const facts = await inspect(client, STATED, emit)
    expect(client.seen).toHaveLength(3)
    expect(events.filter((event) => event.type === 'retry')).toEqual([
      { type: 'retry', agent: 'inspector', reason: expect.stringContaining('dependencies') },
    ])
    const handedBack = client.seen[2]?.transcript.find(
      (entry) => entry.role === 'tool' && entry.name === REPORT_TOOL,
    )
    expect(JSON.stringify(handedBack)).toContain('dependencies')
    expect(Object.keys(facts).sort()).toEqual(FACT_FIELDS)
    expect(facts.name).toBe('billing-api')
  })

  it('advertises a report tool with no dependencies', async () => {
    // As a provider is shown it (llm/tool-schema.ts): a field it is shown is a
    // field it fills, and the digest of every Inspector turn covers it.
    const spec = buildProjectTools(EMPTY).specs.find((each) => each.name === REPORT_TOOL)
    if (spec === undefined) throw new Error('no report tool')
    const advertised = objectRooted(await zodSchema(spec.parameters).jsonSchema, spec.name)
    expect(Object.keys(advertised.properties ?? {}).sort()).toEqual(FACT_FIELDS)
    expect(JSON.stringify(advertised)).not.toContain('dependencies')
    expect(JSON.stringify(advertised)).not.toContain('dependency')
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
      readingAll,
      turnCalling('report_facts', report({ runtime: 'node 22' })),
    ])
    const { emit } = collect()
    const facts = await inspect(client, STATED, emit)
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
      readingAll,
      turnCalling('report_facts', { name: 42 }),
      turnCalling('report_facts', report()),
    ])
    const { emit } = collect()
    expect((await inspect(client, STATED, emit)).name).toBe('billing-api')
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
      'agent:end',
    ])
    expect(events.at(0)).toEqual({ type: 'agent:start', agent: 'inspector' })
    expect(events.at(-2)).toEqual({ type: 'refused', agent: 'inspector', reason: expect.any(String) })
    expect(events.at(-1)).toEqual({ type: 'agent:end', agent: 'inspector', threw: false })
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
    // case is about the forced tool choice and nothing else. The manifest they
    // read states the name the report carries.
    const facts = await inspect(client, STATED, emit)
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
      { type: 'agent:end', agent: 'inspector', threw: true },
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

  it('reads a path written with ./, a doubled slash or a dot segment as the file it names', () => {
    // gap-init-real-repos-9: "./package.json" answered "no file at that path",
    // and a model told so reports a manifest it could have read as unknown.
    const tools = buildProjectTools(snapshot)
    for (const path of ['./package.json', 'src//index.ts', 'src/./index.ts', 'src/lib/../index.ts']) {
      expect(tools.run(toolCall('read_file', { path })).rows, path).toBe(1)
    }
    expect(tools.run(toolCall('read_file', { path: './src/index.ts' })).result).toEqual({
      path: 'src/index.ts',
      text: 'export {}',
    })
    // Nothing above the root, whatever the segments say.
    expect(tools.run(toolCall('read_file', { path: '../billing-api/package.json' })).rows).toBe(0)
  })

  it('reads a path in either Unicode normalisation as the file it names', () => {
    // macOS writes a name decomposed; a model writes it composed.
    const decomposed = 'docs/cafe\u0301.md'
    const tools = buildProjectTools(snapshotOf([{ path: decomposed, text: 'menu' }]))
    const outcome = tools.run(toolCall('read_file', { path: 'docs/caf\u00e9.md' }))
    expect(outcome.result).toEqual({ path: decomposed, text: 'menu' })
  })

  it('says a file under an excluded folder was not read, naming the folder and why', () => {
    const tools = buildProjectTools(
      snapshotOf(
        [{ path: 'package.json', text: '{}' }],
        [{ path: 'deploy/secrets', reason: 'excluded: a folder that exists to hold secrets' }],
      ),
    )
    const outcome = tools.run(toolCall('read_file', { path: 'deploy/secrets/values.yaml' }))
    expect(outcome.error).toBe(
      'not read: it is under deploy/secrets/, excluded: a folder that exists to hold secrets',
    )
  })

  it('says a file may lie past the cap when a cap stopped the read', () => {
    const capped = snapshotOf([{ path: 'package.json', text: '{}' }], [], true)
    expect(buildProjectTools(capped).run(toolCall('read_file', { path: 'zz/late.ts' })).error).toBe(
      'this snapshot holds no file at that path; a cap stopped the read, and a file past it ' +
        'is neither read nor listed',
    )
    // Uncapped, a missing file is only missing.
    expect(buildProjectTools(snapshot).run(toolCall('read_file', { path: 'zz/late.ts' })).error).toBe(
      'this snapshot holds no file at that path',
    )
  })

  it('says a file that is not UTF-8 was read with replacement characters', () => {
    const tools = buildProjectTools(
      snapshotOf([{ path: 'README.md', text: 'caf\ufffd', undecodable: true }]),
    )
    expect(tools.run(toolCall('read_file', { path: 'README.md' })).result).toEqual({
      path: 'README.md',
      text: 'caf\ufffd',
      encoding:
        'not UTF-8: each byte sequence that does not decode reads as U+FFFD, so this text is ' +
        'not all the file says',
    })
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

describe('what a file it read states', () => {
  /** `billing-api`'s manifest as every Inspector tape reads it: six lines, `pg` alone. */
  const PACKAGE_JSON = `${JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8.11.0' } }, null, 2)}\n`
  const BILLING = snapshotOf([{ path: 'package.json', text: PACKAGE_JSON }])

  /** One turn of several calls, each with an id of its own. */
  const turnOf = (...calls: Array<[string, unknown]>): GenerateResult => ({
    text: '',
    toolCalls: calls.map(([name, args], index) => ({ id: `c${String(index)}`, name, args })),
    finishReason: 'tool-calls',
  })

  /** What the tapes report: the name, everything else unknown. */
  const HONEST = {
    name: 'billing-api',
    type: { unknown: 'package.json gives the package name but does not state the application type.' },
    lifecycle: { unknown: 'no file states a lifecycle' },
    runtime: { unknown: 'no file states a runtime' },
    owner: { unknown: 'no entity reference is stated in this repository' },
    forgeHandle: { unknown: 'this repository has no CODEOWNERS' },
  }

  /** The 2026-10-02 report, reconstructed: everything it stated, no file states. */
  const INVENTED = {
    ...HONEST,
    name: 'gorilla-service',
    type: 'service',
    lifecycle: 'production',
    runtime: 'Node.js',
  }

  const SCALAR = (field: string): string => `no file the Inspector read states the ${field} it reported`

  const unwitnessed = (events: readonly AgentEvent[]): AgentEvent[] =>
    events.filter((event) => event.type === 'unwitnessed')

  it('withdraws the 2026-10-02 invention: a package.json passed as content is read by nobody', async () => {
    // The tape's Inspector wrote a manifest of its own into read_file's
    // arguments, with no path. The call was refused, and the report that
    // followed stated the manifest nobody read. A value is kept only where a
    // file the Inspector was handed states it.
    const client = scripted([
      turnCalling('read_file', {
        content:
          '{"name":"@thronecode/gorilla-service","dependencies":{"fastify":"^4","redis":"^4","jsonwebtoken":"^9","bcrypt":"^5"}}',
      }),
      turnCalling('report_facts', INVENTED),
    ])
    const { events, emit } = collect()
    const facts = await inspect(client, BILLING, emit)

    expect(facts).toEqual({
      name: { unknown: SCALAR('name') },
      type: { unknown: SCALAR('type') },
      lifecycle: { unknown: SCALAR('lifecycle') },
      runtime: { unknown: SCALAR('runtime') },
      owner: HONEST.owner,
      forgeHandle: HONEST.forgeHandle,
    })
    for (const invented of ['gorilla', 'thronecode', 'Node.js']) {
      expect(JSON.stringify(facts)).not.toContain(invented)
    }
    expect(unwitnessed(events)).toEqual([
      { type: 'unwitnessed', agent: 'inspector', field: 'name', value: 'gorilla-service', reason: SCALAR('name') },
      { type: 'unwitnessed', agent: 'inspector', field: 'type', value: 'service', reason: SCALAR('type') },
      { type: 'unwitnessed', agent: 'inspector', field: 'lifecycle', value: 'production', reason: SCALAR('lifecycle') },
      { type: 'unwitnessed', agent: 'inspector', field: 'runtime', value: 'Node.js', reason: SCALAR('runtime') },
    ])
  })

  it('keeps what package.json states, and changes nothing else', async () => {
    // An honest report is handed on in the bytes it came in, and nothing is
    // said about it.
    const client = scripted([
      turnCalling('read_file', { path: 'package.json' }),
      turnCalling('report_facts', HONEST),
    ])
    const { events, emit } = collect()
    expect(await inspect(client, BILLING, emit)).toEqual(HONEST)
    expect(unwitnessed(events)).toEqual([])
  })

  it('does not count a file read in the turn that reports', async () => {
    // The model had not seen the text when it wrote the report beside the call.
    const client = scripted([
      turnOf(['read_file', { path: 'package.json' }], ['report_facts', HONEST]),
    ])
    const { emit } = collect()
    expect((await inspect(client, BILLING, emit)).name).toEqual({ unknown: SCALAR('name') })
  })

  interface Row {
    readonly files: Array<{ path: string; text: string }>
    readonly skipped?: Array<{ path: string; reason: string }>
    /** The reads of the turn before the report, `list_files` or a path to `read_file`. */
    readonly reads: readonly string[]
    readonly over: Record<string, unknown>
    /** The field the row is about, as the facts carry it. */
    readonly at: (facts: Record<string, unknown>) => unknown
    readonly kept: boolean
  }

  const ALL_UNKNOWN = {
    ...HONEST,
    name: { unknown: 'not looked for' },
  }
  const name = (facts: Record<string, unknown>): unknown => facts.name
  const field = (key: string) => (facts: Record<string, unknown>): unknown => facts[key]
  const reading = (path: string, text: string): Pick<Row, 'files' | 'reads'> => ({
    files: [{ path, text }],
    reads: [path],
  })

  const rows: Array<[string, Row]> = [
    ['a name, from "name": "billing-api"', { ...reading('package.json', PACKAGE_JSON), over: { name: 'billing-api' }, at: name, kept: true }],
    ['a name, from "name": "@acme/billing-api"', { ...reading('package.json', '{\n  "name": "@acme/billing-api"\n}\n'), over: { name: 'billing-api' }, at: name, kept: true }],
    ['a name, from go.mod', { ...reading('go.mod', 'module github.com/acme/billing-api\n\ngo 1.22\n'), over: { name: 'billing-api' }, at: name, kept: true }],
    ['a name, from pom.xml', { ...reading('pom.xml', '<project>\n  <artifactId>billing-api</artifactId>\n</project>\n'), over: { name: 'billing-api' }, at: name, kept: true }],
    ['no name, from a path list_files gave', { files: [{ path: 'billing-api/README.md', text: 'hello\n' }], reads: ['list_files', 'billing-api/README.md'], over: { name: 'billing-api' }, at: name, kept: false }],
    // A path is no witness for a field whose rule IS the whole token, so this
    // row fails if a path list_files gave, or the path of a file read, ever
    // counts as read: `node` stands in `node/README.md` as a token.
    ['no runtime, from a path list_files gave', { files: [{ path: 'node/README.md', text: 'hello\n' }], reads: ['list_files', 'node/README.md'], over: { runtime: 'node' }, at: field('runtime'), kept: false }],
    ['no name, from an excluded file’s reason', { files: [{ path: 'README.md', text: 'hello\n' }], skipped: [{ path: '.env', reason: 'excluded: name billing-api' }], reads: ['.env', 'README.md'], over: { name: 'billing-api' }, at: name, kept: false }],
    ['no name, from a README’s heading', { ...reading('README.md', '# billing-api\n'), over: { name: 'billing-api' }, at: name, kept: false }],
    ['no name, from container_name', { ...reading('docker-compose.yml', 'services:\n  api:\n    container_name: billing-api\n'), over: { name: 'billing-api' }, at: name, kept: false }],
    ['no name billing, from "name": "billing-api"', { ...reading('package.json', PACKAGE_JSON), over: { name: 'billing' }, at: name, kept: false }],
    ['no name pg, from a dependency', { ...reading('package.json', PACKAGE_JSON), over: { name: 'pg' }, at: name, kept: false }],
    ['no lifecycle, from NODE_ENV=production', { ...reading('Dockerfile', 'FROM node:22\nENV NODE_ENV=production\n'), over: { lifecycle: 'production' }, at: field('lifecycle'), kept: false }],
    ['a lifecycle, from lifecycle: production', { ...reading('catalog-info.yaml', 'spec:\n  lifecycle: production\n'), over: { lifecycle: 'production' }, at: field('lifecycle'), kept: true }],
    ['a type, from type: service', { ...reading('catalog-info.yaml', 'spec:\n  type: service\n'), over: { type: 'service' }, at: field('type'), kept: true }],
    ['no type, from prose', { ...reading('README.md', 'This service bills.\n'), over: { type: 'service' }, at: field('type'), kept: false }],
    ['an owner, from the reference in full', { ...reading('catalog-info.yaml', 'spec:\n  owner: group:default/tiger\n'), over: { owner: 'group:default/tiger' }, at: field('owner'), kept: true }],
    ['an owner, from group:tiger', { ...reading('catalog-info.yaml', 'spec:\n  owner: group:tiger\n'), over: { owner: 'group:default/tiger' }, at: field('owner'), kept: true }],
    ['no owner, from owner: tiger', { ...reading('catalog-info.yaml', 'spec:\n  owner: tiger\n'), over: { owner: 'group:default/tiger' }, at: field('owner'), kept: false }],
    ['no owner, from another namespace', { ...reading('catalog-info.yaml', 'spec:\n  owner: group:other/tiger\n'), over: { owner: 'group:default/tiger' }, at: field('owner'), kept: false }],
    ['a forge handle, from CODEOWNERS', { ...reading('CODEOWNERS', '* @acme/platform\n'), over: { forgeHandle: '@acme/platform' }, at: field('forgeHandle'), kept: true }],
    ['a runtime, from engines', { ...reading('package.json', '{\n  "engines": { "node": ">=22" }\n}\n'), over: { runtime: 'node' }, at: field('runtime'), kept: true }],
    ['no runtime Node.js, from engines', { ...reading('package.json', '{\n  "engines": { "node": ">=22" }\n}\n'), over: { runtime: 'Node.js' }, at: field('runtime'), kept: false }],
    // A value is compared folded, and kept as reported: one folding would hide
    // a difference in is never stated, since the diff would show its bytes and
    // a person reading it would not see that difference.
    ['no type with a soft hyphen, from type: service', { ...reading('catalog-info.yaml', 'spec:\n  type: service\n'), over: { type: 'serv\u00ADice' }, at: field('type'), kept: false }],
    ['no type with a soft hyphen, even from a file that holds it', { ...reading('catalog-info.yaml', 'spec:\n  type: serv\u00ADice\n'), over: { type: 'serv\u00ADice' }, at: field('type'), kept: false }],
    ['no full-width type, from type: service', { ...reading('catalog-info.yaml', 'spec:\n  type: service\n'), over: { type: '\uFF53\uFF45\uFF52\uFF56\uFF49\uFF43\uFF45' }, at: field('type'), kept: false }],
    ['no runtime behind a bidi control, from runtime node', { ...reading('README.md', 'runtime node\n'), over: { runtime: '\u202Enode' }, at: field('runtime'), kept: false }],
    ['no runtime with a typographic hyphen, from node-js', { ...reading('README.md', 'runtime: node-js\n'), over: { runtime: 'node\u2010js' }, at: field('runtime'), kept: false }],
    // The documented limits, kept today: tightening a rule is a visible change here.
    ['limit: a value in another case is stated: Service from type: service', { ...reading('catalog-info.yaml', 'spec:\n  type: service\n'), over: { type: 'Service' }, at: field('type'), kept: true }],
    ['limit: "type": "module" states the type module', { ...reading('package.json', '{\n  "type": "module"\n}\n'), over: { type: 'module' }, at: field('type'), kept: true }],
    ['limit: a workflow’s name: ci states the name ci', { ...reading('.github/workflows/ci.yml', 'name: ci\non: push\n'), over: { name: 'ci' }, at: name, kept: true }],
    ['limit: LIFECYCLE=production states the lifecycle', { ...reading('.env.example', 'LIFECYCLE=production\n'), over: { lifecycle: 'production' }, at: field('lifecycle'), kept: true }],
    ['limit: a one-line file is one line', { ...reading('package.json', '{"scripts":{"lifecycle":"run"},"config":{"env":"production"}}'), over: { lifecycle: 'production' }, at: field('lifecycle'), kept: true }],
    ['limit: bob@acme.com states the handle @acme.com', { ...reading('CODEOWNERS', '* bob@acme.com\n'), over: { forgeHandle: '@acme.com' }, at: field('forgeHandle'), kept: true }],
  ]

  it.each(rows)('states a value by the field’s rule: %s', async (_title, row) => {
    const reads = row.reads.map(
      (read): [string, unknown] =>
        read === 'list_files' ? ['list_files', {}] : ['read_file', { path: read }],
    )
    const reported = { ...ALL_UNKNOWN, ...row.over }
    const client = scripted([turnOf(...reads), turnCalling('report_facts', reported)])
    const { emit } = collect()
    const facts = await inspect(client, snapshotOf(row.files, row.skipped), emit)
    const value = row.at(facts as Record<string, unknown>)
    if (row.kept) expect(value).toEqual(row.at(reported))
    else expect(value).toEqual({ unknown: expect.any(String) })
  })

  it('prints a withdrawn value as one cleaned line', async () => {
    const client = scripted([turnCalling('report_facts', INVENTED)])
    const { events, emit } = collect()
    await inspect(client, BILLING, emit)
    const named = unwitnessed(events)[0]
    expect(named === undefined ? undefined : renderEvent(named)).toBe(
      '  = name is unknown, not gorilla-service: no file the Inspector read states the name it reported',
    )

    // A value is the model's: nothing in it reaches a terminal as a control.
    const line = renderEvent({
      type: 'unwitnessed',
      agent: 'inspector',
      field: 'type',
      value: 'serv\u001b[2Jice\u202e\nlive',
      reason: SCALAR('type'),
    })
    expect(line).toBe(
      '  = type is unknown, not service\\u202e live: no file the Inspector read states the type it reported',
    )
  })

  it('does not hand the Architect what the model said when no report came', async () => {
    // Every turn in prose: the barren bound ends the inspection on a forced
    // last turn that answers in prose too. The words are a person's to read on
    // the refusal, never the reason an unknown is handed on with.
    const prose: GenerateResult = {
      text: 'billing-api is a fastify service using redis',
      toolCalls: [],
      finishReason: 'stop',
    }
    const client = scripted([prose, prose, prose, prose])
    const { events, emit } = collect()
    const facts = await inspect(client, BILLING, emit)

    for (const value of Object.values(facts)) {
      expect(value).toEqual({
        unknown: 'the inspection ended with no report, so nothing about this repository was established',
      })
    }
    expect(JSON.stringify(facts)).not.toContain('fastify')
    const refused = events.find((event) => event.type === 'refused')
    expect(refused?.type === 'refused' ? refused.reason : '').toContain('fastify')
  })

  it('keeps a model’s own unknown reason off the Architect’s opening', async () => {
    // The witness holds values, and the reason a model gives for its own
    // unknown is not one: it is neither held nor handed on. The Architect
    // reads the engine's fixed reason for the field, whatever the report said
    // (the witness plan's question 5, closed by stage 8).
    const why = 'a Node.js fastify service using postgresql and redis, named gorilla-service'
    const inspector = scripted([
      turnCalling('read_file', { path: 'package.json' }),
      turnCalling('report_facts', { ...HONEST, runtime: { unknown: why } }),
    ])
    const { events, emit } = collect()
    const facts = await inspect(inspector, BILLING, emit)
    expect(unwitnessed(events)).toEqual([])

    const built = buildTools(EntityGraph.from([]))
    const architect = capturing([turnCalling(PROPOSE_TOOL, { operations: [] })])
    await draftPlan(
      architect,
      { ...built, specs: built.specs.filter((spec) => spec.name !== 'answer') },
      { intent: 'declare billing-api', facts, summary: 'si:\n  entities: 0', vocabulary: '' },
      emit,
    )
    const first = architect.seen[0]?.transcript[0]
    const opening = first?.role === 'user' ? first.text : ''
    expect(opening).toContain("  runtime: unknown (the inspection did not establish this service's runtime)\n")
    const sent = JSON.stringify(architect.seen)
    for (const word of [why, 'fastify', 'gorilla', 'postgresql']) expect(sent).not.toContain(word)
  })
})
