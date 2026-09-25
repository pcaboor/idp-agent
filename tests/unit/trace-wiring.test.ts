import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import type { AgentName, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { disagreements, memorySink, onlyTrace, skeletonOf } from '../support/trace.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })
const answering = (args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: 'c1', name: 'answer', args }],
  finishReason: 'tool-calls',
})

/** The Supervisor classifies, the Analyst answers "nothing": two agents, two model calls. */
const scripted = (): LlmClient => {
  const turns = [saying('QUESTION'), answering({ outcome: 'nothing' })]
  let index = 0
  return { generate: async () => turns[index++] ?? saying('') }
}

const ask = async (deps: MainDeps = {}): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(['ask', 'which databases are in prod?'], {
    root: FIXTURES,
    env: {},
    client: scripted(),
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    ...deps,
  })
  return { code, out: out.join(''), err: err.join('') }
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('tracing an agent-backed run', () => {
  it('traces nothing, and says nothing about a trace, when none is configured', async () => {
    const { err } = await ask()
    expect(err).not.toContain('· trace')
    expect(err).not.toContain('not exported')
  })

  it('calls no sink and traces nothing when the session cannot open for want of a model', async () => {
    const sent: string[] = []
    const fetch = (async (url: string | URL | Request) => {
      sent.push(String(url))
      return new Response('', { status: 200 })
    }) as typeof globalThis.fetch
    const err: string[] = []

    // No `client` injected and no `IDP_PROVIDER`/`IDP_MODEL` in `env`: the
    // session never opens, so there is no run to trace at all — the sink
    // must never even be asked, and nothing is said about a trace.
    const code = await main(['ask', 'which databases are in prod?'], {
      root: FIXTURES,
      env: { IDP_MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055' },
      fetch,
      out: () => {},
      err: (chunk) => void err.push(chunk),
    })

    expect(code).toBe(2)
    expect(sent).toEqual([])
    expect(err.join('')).not.toContain('· trace')
  })

  it('leaves stdout and the exit code exactly as an untraced run leaves them', async () => {
    const untraced = await ask()
    const traced = await ask({ traceSinks: [memorySink()] })

    expect(traced.out).toBe(untraced.out)
    expect(traced.code).toBe(untraced.code)
  })

  it('hands each sink one trace, rooted at the command, with both agents inside it', async () => {
    const sink = memorySink()
    const { code } = await ask({ traceSinks: [sink] })
    const trace = onlyTrace(sink)

    expect(skeletonOf(trace)).toEqual({
      name: 'idp-agent ask',
      type: 'CHAIN',
      status: 'OK',
      children: [
        {
          name: 'supervisor',
          type: 'AGENT',
          status: 'OK',
          children: [{ name: 'supervisor call 0', type: 'CHAT_MODEL', status: 'OK', children: [] }],
        },
        {
          name: 'analyst',
          type: 'AGENT',
          status: 'OK',
          children: [{ name: 'analyst call 0', type: 'CHAT_MODEL', status: 'OK', children: [] }],
        },
      ],
    })
    expect(trace.spans[0]?.inputs).toEqual({ command: 'ask', intent: 'which databases are in prod?' })
    expect(trace.spans[0]?.outputs).toMatchObject({ exitCode: code })
    expect(trace.spans[0]?.attributes).toEqual({ 'idp.mode': 'scripted', 'idp.exit_code': code })
  })

  it('names the trace on stderr as MLflow does, so the line pastes into its search', async () => {
    const sink = memorySink()
    const { err } = await ask({ traceSinks: [sink] })
    const { traceId } = onlyTrace(sink)

    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    // MLflow's own id for the trace is `tr-` and the OTLP trace id.
    expect(err).toContain(`· trace tr-${traceId}\n`)
  })

  it('traces nothing when only MLflow’s own MLFLOW_TRACKING_URI is set', async () => {
    const sent: string[] = []
    const fetch = (async (url: string | URL | Request) => {
      sent.push(String(url))
      return new Response('', { status: 200 })
    }) as typeof globalThis.fetch

    const { err } = await ask({
      env: { MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055', MLFLOW_EXPERIMENT_ID: '12' },
      fetch,
    })

    expect(sent).toEqual([])
    expect(err).not.toContain('· trace')
  })

  it('posts the trace to MLflow when IDP_MLFLOW_TRACKING_URI is set', async () => {
    const sent: string[] = []
    const headers: unknown[] = []
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(url))
      headers.push(init?.headers)
      return new Response('', { status: 200 })
    }) as typeof globalThis.fetch

    const { err } = await ask({
      env: { IDP_MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055', IDP_MLFLOW_EXPERIMENT_ID: '12' },
      fetch,
    })

    expect(sent).toEqual(['http://127.0.0.1:5055/v1/traces'])
    expect(headers[0]).toMatchObject({ 'x-mlflow-experiment-id': '12' })
    expect(err).not.toContain('not exported')
  })

  it('says so on one line when MLflow cannot be reached, and exits as it would have', async () => {
    // Injected explicitly rather than left to tests/setup/offline.ts's global
    // thrower: under IDP_RECORDING=record that guard steps aside and fetch is
    // real, so this must hold on its own rather than borrow that guard's
    // message. `fetch failed` is what a real connection refusal throws.
    const unreachableFetch = (() => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch

    const untraced = await ask()
    const unreachable = await ask({
      env: { IDP_MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055' },
      fetch: unreachableFetch,
    })

    expect(unreachable.err).toContain('! trace not exported to mlflow: fetch failed')
    expect(unreachable.code).toBe(untraced.code)
    expect(unreachable.out).toBe(untraced.out)
  })

  it('writes one file per run under IDP_TRACE_DIR', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idp-trace-'))
    dirs.push(dir)
    const sink = memorySink()

    await ask({ env: { IDP_TRACE_DIR: dir }, traceSinks: [sink] })

    expect(await readdir(dir)).toEqual([`${onlyTrace(sink).traceId}.json`])
  })

  it('resolves a relative IDP_TRACE_DIR against process.cwd()', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idp-trace-'))
    dirs.push(dir)
    // The path handed to sinksFromEnv, in the shell's own words: relative to
    // where the variable was typed, never to --repo.
    const relative = path.relative(process.cwd(), dir)

    await ask({ env: { IDP_TRACE_DIR: relative } })

    expect(await readdir(dir)).toHaveLength(1)
  })

  it('still exports the trace of a run that threw, and marks it failed', async () => {
    const sink = memorySink()
    const failing: LlmClient = { generate: () => Promise.reject(new Error('502 from the gateway')) }

    const untraced = await ask({ client: failing })
    const traced = await ask({ client: failing, traceSinks: [sink] })
    const trace = onlyTrace(sink)

    expect(traced.code).toBe(untraced.code)
    expect(trace.spans[0]?.status).toEqual({ code: 'ERROR', message: '502 from the gateway' })
    expect(skeletonOf(trace).children[0]).toMatchObject({ name: 'supervisor', status: 'ERROR: the agent threw' })
  })
})

/**
 * Scripted turns, keyed by agent — the helper `entry.test.ts` and
 * `init-command.test.ts` use — so a whole command runs with no key and no tape.
 */
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

const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'idp-trace-'))
  dirs.push(dir)
  return dir
}

/** A declarations repository as `init platform` leaves one, as `<parent>/IaC`. */
const declarations = async (): Promise<{ parent: string; repo: string }> => {
  const parent = await scratch()
  const repo = path.join(parent, 'IaC')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  return { parent, repo }
}

/** An application repository: a package manifest at its root. */
const application = async (): Promise<string> => {
  const root = await scratch()
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'billing-api' })}\n`, 'utf8')
  return root
}

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [],
}

const INTENT = 'declare the database orders-db-prod in prod owned by group:default/tiger'

const DATABASE = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db-prod', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

/** A change, drafted and accepted; the Supervisor and the Inspector answer when they are asked. */
const changing = (): LlmClient =>
  byAgent({
    supervisor: [saying('MUTATION')],
    inspector: [calling('list_files', {}), calling(REPORT_TOOL, FACTS)],
    architect: [calling(PROPOSE_TOOL, { operations: [DATABASE] })],
    reviewer: [calling(VERDICT_TOOL, { verdict: 'ok' })],
  })

interface Ran {
  code: number
  out: string
  err: string
  events: AgentEvent[]
}

const running = async (argv: string[], deps: MainDeps): Promise<Ran> => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(argv, {
    ask: async (question) => (question.path.endsWith('.access') ? 'read' : undefined),
    events: (event) => void events.push(event),
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    ...deps,
  })
  return { code, out: out.join(''), err: err.join(''), events }
}

describe('tracing idpa "<phrase>", as idp-agent entry', () => {
  const QUESTION = 'which databases are in prod?'

  it('roots a question at the command, with the phrase, the Supervisor then the Analyst', async () => {
    const sink = memorySink()
    const { code, events } = await running([QUESTION], {
      client: byAgent({ supervisor: [saying('QUESTION')], analyst: [answering({ outcome: 'nothing' })] }),
      env: {},
      cwd: await scratch(),
      traceSinks: [sink],
    })
    const trace = onlyTrace(sink)

    expect(code).toBe(1)
    expect(trace.spans[0]?.name).toBe('idp-agent entry')
    // The demo SI: no declarations repository, so no repository in what was asked.
    expect(trace.spans[0]?.inputs).toEqual({ command: 'entry', phrase: QUESTION })
    expect(skeletonOf(trace).children.map((child) => [child.name, child.type])).toEqual([
      ['supervisor', 'AGENT'],
      ['analyst', 'AGENT'],
    ])
    expect(disagreements(trace, events)).toEqual([])
  })

  it('records the repository --repo names as an absolute path, however it was typed', async () => {
    const { parent, repo } = await declarations()
    const sink = memorySink()

    await running([QUESTION, '--repo', 'IaC'], {
      client: byAgent({ supervisor: [saying('QUESTION')], analyst: [answering({ outcome: 'nothing' })] }),
      env: {},
      cwd: parent,
      traceSinks: [sink],
    })
    const inputs = onlyTrace(sink).spans[0]?.inputs as { repo?: string }

    expect(path.isAbsolute(inputs.repo ?? '')).toBe(true)
    expect(await realpath(inputs.repo ?? '')).toBe(await realpath(repo))
  })

  it.each([
    ['from a directory that is no service', false],
    ['with --project naming a service', true],
  ])('tells a change the way its stream does: %s', async (_label, withProject) => {
    const { repo } = await declarations()
    const project = await application()
    const sink = memorySink()

    const { code, events } = await running([INTENT, ...(withProject ? ['--project', project] : [])], {
      client: changing(),
      env: { IDP_REPO: repo },
      cwd: await scratch(),
      traceSinks: [sink],
    })
    const trace = onlyTrace(sink)
    const inputs = trace.spans[0]?.inputs as Record<string, unknown>

    expect(code).toBe(0)
    expect(disagreements(trace, events)).toEqual([])
    expect(inputs).toMatchObject({ command: 'entry', phrase: INTENT })
    if (withProject) {
      expect(await realpath(String(inputs['project']))).toBe(await realpath(project))
      expect(skeletonOf(trace).children.map((child) => child.name)).toContain('inspector')
    } else {
      expect(inputs).not.toHaveProperty('project')
      expect(skeletonOf(trace).children.map((child) => child.name)).not.toContain('inspector')
    }
  })

  it('leaves stdout and the exit code of a change exactly as an untraced run leaves them', async () => {
    const { repo } = await declarations()
    const cwd = await scratch()
    const deps = (): MainDeps => ({ client: changing(), env: { IDP_REPO: repo }, cwd })

    const untraced = await running([INTENT], deps())
    const traced = await running([INTENT], { ...deps(), traceSinks: [memorySink()] })

    expect(untraced.out).toContain('+++ b/catalog/databases/orders-db-prod.yml')
    expect(traced.out).toBe(untraced.out)
    expect(traced.code).toBe(untraced.code)
  })

  it('fails the root with the refusal when a change is asked of the demo SI, after the Supervisor ran', async () => {
    const sink = memorySink()

    const { code } = await running([INTENT], {
      client: changing(),
      env: {},
      cwd: await scratch(),
      traceSinks: [sink],
    })
    const trace = onlyTrace(sink)

    // The run threw, and failed() made that exit 2; the root is the one span
    // that says so, and the Supervisor that got it there is a success.
    expect(code).toBe(2)
    expect(trace.spans[0]?.status).toMatchObject({
      code: 'ERROR',
      message: expect.stringContaining('needs a declarations repository'),
    })
    expect(trace.spans[0]?.attributes).toMatchObject({ 'idp.exit_code': 2 })
    expect(skeletonOf(trace).children).toEqual([
      expect.objectContaining({ name: 'supervisor', type: 'AGENT', status: 'OK' }),
    ])
  })
})

describe('tracing plan "<intent>"', () => {
  it('records the resolved repository, and says on the root why no project was inspected', async () => {
    const { parent, repo } = await declarations()
    const sink = memorySink()

    const { code, events } = await running(['plan', INTENT, '--repo', 'IaC'], {
      client: changing(),
      env: {},
      cwd: parent,
      traceSinks: [sink],
    })
    const trace = onlyTrace(sink)
    const root = trace.spans[0]
    const inputs = root?.inputs as Record<string, unknown>

    expect(code).toBe(0)
    expect(disagreements(trace, events)).toEqual([])
    expect(inputs).toMatchObject({ command: 'plan', intent: INTENT })
    expect(path.isAbsolute(String(inputs['repo']))).toBe(true)
    expect(await realpath(String(inputs['repo']))).toBe(await realpath(repo))
    // Skipped: no `project` key, and the root keeps the reason stderr gave.
    expect(inputs).not.toHaveProperty('project')
    expect(root?.attributes).toMatchObject({
      'idp.inspector': 'skipped',
      'idp.inspector.reason': expect.stringContaining('holds no catalog-info.yaml or package manifest'),
    })
  })

  it('records the project it inspected, and no skip', async () => {
    const { repo } = await declarations()
    const project = await application()
    const sink = memorySink()

    await running(['plan', INTENT, '--repo', repo, '--project', project], {
      client: changing(),
      env: {},
      cwd: await scratch(),
      traceSinks: [sink],
    })
    const root = onlyTrace(sink).spans[0]

    expect(await realpath(String((root?.inputs as Record<string, unknown>)['project']))).toBe(
      await realpath(project),
    )
    expect(root?.attributes).not.toHaveProperty('idp.inspector')
  })
})

describe('what the root says a run printed', () => {
  it('is the text without a terminal’s escape sequences, so MLflow’s preview reads', async () => {
    // Colour is on only when nothing injected `out` and the terminal wants it;
    // FORCE_COLOR stands in for the terminal, and stdout is held so the diff
    // does not land in the test log.
    const written: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    const sink = memorySink()
    try {
      const code = await main(['init', '--repo', await application()], {
        client: byAgent({
          inspector: [calling(REPORT_TOOL, FACTS)],
          architect: [
            calling(PROPOSE_TOOL, {
              operations: [
                {
                  op: 'create-entity',
                  entity: {
                    kind: 'Component',
                    metadata: { name: 'billing-api' },
                    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
                  },
                },
              ],
            }),
          ],
        }),
        env: { FORCE_COLOR: '1' },
        err: () => {},
        traceSinks: [sink],
      })
      expect(code).toBe(0)
    } finally {
      stdout.mockRestore()
    }
    const text = (onlyTrace(sink).spans[0]?.outputs as { text?: string }).text ?? ''

    // The terminal got colour, and the trace got the same words without it.
    expect(written.join('')).toContain('\u001b[')
    expect(text).toContain('+++ b/catalog-info.yaml')
    expect(text).not.toContain('\u001b')
  })
})

/**
 * A memory sink is a passive reader of the event stream (ADR-0009): asking one
 * to look must change nothing that a person sees. One road per way a run can
 * be driven — `ask`, `ask --quiet`, the bare phrase (`idpa` / entry), and
 * `init` — each compared against itself, traced and untraced, and each
 * checked with `disagreements()` against the very events that built the trace.
 */
describe('a memory sink changes nothing a person sees, on any road', () => {
  const QUESTION = 'which databases are in prod?'

  /** Supervisor classifies, Analyst answers "nothing" — but with commentary framing it. */
  const askingWithCommentary = (): LlmClient => {
    const turns = [
      saying('QUESTION'),
      answering({ outcome: 'nothing', intro: 'Nothing turned up.', conclusion: 'The search covered every environment.' }),
    ]
    let index = 0
    return { generate: async () => turns[index++] ?? saying('') }
  }

  const COMPONENT = {
    op: 'create-entity',
    entity: {
      kind: 'Component',
      metadata: { name: 'billing-api' },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    },
  }

  /**
   * The Architect asking for `answer` before proposing: refused, drawn as an
   * ERROR TOOL span closed by its own `tool:result` — not a forced close, so
   * `disagreements()` stays empty over it (architect.ts's own note: every
   * other test here filtered `answer` out by hand, so this combination was
   * never exercised until now).
   */
  const initClient = (): LlmClient =>
    byAgent({
      inspector: [calling(REPORT_TOOL, FACTS)],
      architect: [calling('answer', { outcome: 'nothing' }), calling(PROPOSE_TOOL, { operations: [COMPONENT] })],
    })

  const ROADS: ReadonlyArray<[string, () => Promise<{ argv: string[]; deps: MainDeps }>]> = [
    [
      'ask, whose answer carries commentary',
      async () => ({
        argv: ['ask', QUESTION],
        deps: { root: FIXTURES, env: {}, client: askingWithCommentary() },
      }),
    ],
    [
      'ask --quiet',
      async () => ({
        argv: ['ask', '--quiet', QUESTION],
        deps: { root: FIXTURES, env: {}, client: askingWithCommentary() },
      }),
    ],
    [
      'idpa / entry, on a question whose answer carries commentary',
      async () => ({
        argv: [QUESTION],
        deps: { env: {}, cwd: await scratch(), client: askingWithCommentary() },
      }),
    ],
    [
      'init',
      async () => ({
        argv: ['init', '--repo', await application()],
        deps: { env: {}, client: initClient() },
      }),
    ],
  ]

  it.each(ROADS)('%s', async (_label, road) => {
    const first = await road()
    const untraced = await running(first.argv, first.deps)

    const second = await road()
    const sink = memorySink()
    const traced = await running(second.argv, { ...second.deps, traceSinks: [sink] })

    expect(traced.out).toBe(untraced.out)
    expect(traced.code).toBe(untraced.code)
    expect(disagreements(onlyTrace(sink), traced.events)).toEqual([])
  })
})
