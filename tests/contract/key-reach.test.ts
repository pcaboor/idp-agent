import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { main, type MainDeps } from '../../src/cli/index.js'
import { MERGE_NOTE } from '../../src/core/github/protection.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { PROVIDER_NAMES, type ProviderName } from '../../src/llm/providers.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults, type Sent as ToCatalogue } from '../support/fake-backstage.js'
import { fakeGitHub, protectedMain } from '../support/fake-gh.js'
import { CLOSED_PROXY, PROXY_VARIABLES } from '../setup/forge.js'
import { fakeSsh, githubClone, requireUnrewritten, type GitHubClone } from '../support/github-fixture.js'
import type { GhProcess } from '../../src/process/gh.js'
import { git } from '../support/git.js'
import { removeClones } from '../support/forge-fixture.js'
import { confirmingEnvironment } from '../support/ask.js'
import { memorySink, onlyTrace } from '../support/trace.js'

/**
 * Every process a run starts, with the environment it was handed — or the
 * process's own, which is what a child is given when none is. Called through:
 * the Inspector's `git` runs as it always does.
 */
const spawned = vi.hoisted(() => ({
  environments: [] as unknown[],
  /** The same calls, with the argument vector each was handed beside its environment. */
  calls: [] as { readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }[],
}))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const record = (args: unknown[]): void => {
    const options = args
      .slice(1)
      .find((arg): arg is { env?: unknown } => typeof arg === 'object' && arg !== null && !Array.isArray(arg))
    const env = options?.env ?? { ...process.env }
    spawned.environments.push(env)
    spawned.calls.push({ args: Array.isArray(args[1]) ? (args[1] as string[]) : [], env: env as NodeJS.ProcessEnv })
  }
  const execFile = (...args: unknown[]): unknown => {
    record(args)
    return (original.execFile as (...all: unknown[]) => unknown)(...args)
  }
  // Promisified, as the tests' own git is (tests/support/git.ts): recorded
  // too, and answering `{ stdout, stderr }` as the original does, so a
  // fixture can build a clone through it before a test empties the record.
  const promised = (original.execFile as unknown as Record<symbol, (...all: unknown[]) => unknown>)[promisify.custom]
  Object.assign(execFile, {
    [promisify.custom]: (...args: unknown[]): unknown => {
      record(args)
      return promised?.(...args)
    },
  })
  return { ...original, execFile }
})

/**
 * Where the key goes on a real run: to its provider, in the header that
 * provider reads it from, and nowhere else — not into a request body, not onto
 * stdout or stderr, not into a trace, and not to a tracking server.
 *
 * SECURITY.md states this as a guarantee for every provider and for both roads,
 * and a guarantee not enforced by a test is not claimed there. So every
 * provider in `PROVIDER_NAMES` runs each road as a person types it:
 * `idpa "<question>"` (Supervisor, Analyst) and `idpa "<change>"` (Supervisor,
 * Inspector, Architect, the gates, Reviewer). The runs are `live` — no injected
 * client, so `chooseModel` reads the key from the environment and the real
 * adapter sends the requests — with only the transports replaced: `fetch`
 * answers in that provider's own wire format, and the MLflow sink's is a second
 * stub. The key is a fake that no provider would accept, and no host is reached.
 */

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const EXAMPLE = path.resolve(import.meta.dirname, '../../examples/open-network.json')
const KEY = 'canary-key-that-is-not-a-real-one-0123456789'
const MLFLOW = 'http://127.0.0.1:5055'

type Body = Record<string, unknown>

interface Wire {
  key: string
  model: string
  /** Any variable that would move the endpoint, cleared so the URL is the documented one. */
  moves: string[]
  url: string
  /** The one header this provider reads the key from, lower-cased. */
  header: string
  carrying(key: string): string
  /** The names of the tools a request body offers. */
  offered(body: Body): string[]
  calling(tool: string, args: unknown): unknown
  saying(text: string): unknown
}

const records = (value: unknown): Body[] => (Array.isArray(value) ? (value as Body[]) : [])

const WIRES: Record<ProviderName, Wire> = {
  anthropic: {
    key: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-5',
    moves: ['ANTHROPIC_BASE_URL'],
    url: 'https://api.anthropic.com/v1/messages',
    header: 'x-api-key',
    carrying: (key) => key,
    offered: (body) => records(body['tools']).map((tool) => tool['name'] as string),
    calling: (tool, args) => ({
      type: 'message',
      id: 'msg_01',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'tool_use', id: 'toolu_01', name: tool, input: args }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    saying: (text) => ({
      type: 'message',
      id: 'msg_02',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },

  mistral: {
    key: 'MISTRAL_API_KEY',
    model: 'mistral-large-latest',
    moves: [],
    url: 'https://api.mistral.ai/v1/chat/completions',
    header: 'authorization',
    carrying: (key) => `Bearer ${key}`,
    offered: (body) =>
      records(body['tools']).map((tool) => (tool['function'] as Body)['name'] as string),
    calling: (tool, args) => ({
      id: 'cmpl_01',
      object: 'chat.completion',
      created: 0,
      model: 'mistral-large-latest',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call01234',
                type: 'function',
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    saying: (text) => ({
      id: 'cmpl_02',
      object: 'chat.completion',
      created: 0,
      model: 'mistral-large-latest',
      choices: [
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  },

  // `createOpenAI()(model)` is the Responses API: a function tool is flat.
  openai: {
    key: 'OPENAI_API_KEY',
    model: 'gpt-5',
    moves: ['OPENAI_BASE_URL'],
    url: 'https://api.openai.com/v1/responses',
    header: 'authorization',
    carrying: (key) => `Bearer ${key}`,
    offered: (body) => records(body['tools']).map((tool) => tool['name'] as string),
    calling: (tool, args) => ({
      id: 'resp_01',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5',
      output: [
        {
          type: 'function_call',
          id: 'fc_01',
          call_id: 'call_01',
          name: tool,
          arguments: JSON.stringify(args),
          status: 'completed',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    saying: (text) => ({
      id: 'resp_02',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          id: 'msg_01',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  },
}

/** What the Inspector reports about the application repository below. */
const FACTS = {
  name: 'orders-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: { unknown: 'no CODEOWNERS file' },
  dependencies: [],
}

interface Road {
  /** The phrase, as typed. */
  phrase: string
  /** The Supervisor's one word. */
  word: 'QUESTION' | 'MUTATION'
  /** What stdout holds when the run went the whole way. */
  shows: string
  /** The terminal tool of every agent that must have reached the provider. */
  offered: string[]
}

/**
 * Answers each request by the tool it offers, so neither road depends on how
 * many turns an agent spent: the Analyst's `answer`, the Inspector's report,
 * the Architect's proposal, the Reviewer's verdict — and, with none of those
 * offered, the Supervisor's word.
 */
const answering =
  (wire: Wire, word: Road['word'], operations: unknown[]) =>
  (body: Body): unknown => {
    const offered = wire.offered(body)
    if (offered.includes('answer')) return wire.calling('answer', { outcome: 'overview' })
    if (offered.includes(REPORT_TOOL)) return wire.calling(REPORT_TOOL, FACTS)
    if (offered.includes(PROPOSE_TOOL)) return wire.calling(PROPOSE_TOOL, { operations })
    if (offered.includes(VERDICT_TOOL)) return wire.calling(VERDICT_TOOL, { verdict: 'ok' })
    return wire.saying(word)
  }

interface Sent {
  url: string
  headers: Record<string, string>
  body: string
}

const headersOf = (raw: unknown): Record<string, string> => {
  if (raw instanceof Headers) return Object.fromEntries(raw.entries())
  const entries = Array.isArray(raw)
    ? (raw as Array<[string, unknown]>)
    : Object.entries((raw ?? {}) as Record<string, unknown>)
  return Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), String(value)]))
}

const keeping = (sent: Sent[], reply: (body: string) => Response) =>
  (async (input: unknown, init?: { headers?: unknown; body?: unknown }): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    const body = String(init?.body ?? '')
    sent.push({ url, headers: headersOf(init?.headers), body })
    return reply(body)
  }) as typeof globalThis.fetch

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const temporary: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A copy of the demo SI, and an application repository beside it. */
const repositories = async (): Promise<{ repo: string; project: string }> => {
  const base = await mkdtemp(path.join(tmpdir(), 'idp-key-reach-'))
  temporary.push(base)
  const repo = path.join(base, 'iac')
  const project = path.join(base, 'orders-api')
  await cp(FIXTURES, repo, { recursive: true })
  await mkdir(project)
  await writeFile(
    path.join(project, 'package.json'),
    `${JSON.stringify({ name: 'orders-api', dependencies: { redis: '^4' } }, null, 2)}\n`,
    'utf8',
  )
  return { repo, project }
}

describe.each(PROVIDER_NAMES)('the %s key on a real run', (provider) => {
  const wire = WIRES[provider]

  const run = async (road: Road, argv: string[], operations: unknown[] = []): Promise<void> => {
    const toProvider: Sent[] = []
    const reply = answering(wire, road.word, operations)
    vi.stubGlobal(
      'fetch',
      keeping(toProvider, (body) => json(reply(JSON.parse(body) as Body))),
    )
    // `chooseModel` checks the environment `main` is handed; the adapter reads
    // its key from the process's, as the SDK does. In a real run they are the
    // same object. Anything that would move the endpoint is cleared.
    vi.stubEnv(wire.key, KEY)
    for (const variable of wire.moves) vi.stubEnv(variable, undefined)
    const toMlflow: Sent[] = []
    const sink = memorySink()
    const out: string[] = []
    const err: string[] = []

    const code = await main(argv, {
      root: FIXTURES,
      env: {
        IDP_PROVIDER: provider,
        IDP_MODEL: wire.model,
        [wire.key]: KEY,
        IDP_MLFLOW_TRACKING_URI: MLFLOW,
      },
      fetch: keeping(toMlflow, () => new Response('{}', { status: 200 })),
      traceSinks: [sink],
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      events: () => {},
    })

    expect(code, err.join('')).toBe(0)
    expect(out.join('')).toContain(road.shows)

    // Every model call went to the provider's documented endpoint, carrying the
    // key in the one header that provider reads it from. Every agent of the
    // road reached it, so the searches below are not vacuous.
    for (const tool of road.offered) {
      expect(
        toProvider.some((sent) => wire.offered(JSON.parse(sent.body) as Body).includes(tool)),
        `no request offered ${tool}`,
      ).toBe(true)
    }
    for (const sent of toProvider) {
      expect(sent.url).toBe(wire.url)
      expect(sent.headers[wire.header]).toBe(wire.carrying(KEY))
      const others = Object.entries(sent.headers).filter(([name]) => name !== wire.header)
      expect(JSON.stringify(others)).not.toContain(KEY)
      expect(sent.body).not.toContain(KEY)
    }

    // The trace went where it was configured, and holds no key.
    expect(toMlflow.length).toBeGreaterThan(0)
    for (const sent of toMlflow) {
      expect(sent.url.startsWith(`${MLFLOW}/`)).toBe(true)
      expect(JSON.stringify(sent)).not.toContain(KEY)
    }
    expect(toMlflow.some((sent) => sent.body.includes(road.phrase))).toBe(true)
    // Timestamps are bigints; the phrase is there, so the search is not vacuous.
    const trace = JSON.stringify(onlyTrace(sink), (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    )
    expect(trace).toContain(road.phrase)
    expect(trace).not.toContain(KEY)

    expect(out.join('')).not.toContain(KEY)
    expect(err.join('')).not.toContain(KEY)
  }

  it('reaches its provider in its header, and nothing else, on a question', async () => {
    const phrase = 'which databases are in prod?'
    await run(
      { phrase, word: 'QUESTION', shows: 'Overview of the demo SI', offered: ['answer'] },
      [phrase, '--demo'],
    )
  })

  it('reaches its provider in its header, and nothing else, on a change', async () => {
    // The Architect proposes what `examples/open-network.json` holds, which
    // signs cleanly against the demo SI: every value is in the request or in
    // the repository, its environment is the declaration the request points
    // at, and nothing needs asking.
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as {
      intent: string
      operations: unknown[]
    }
    const { repo, project } = await repositories()
    await run(
      {
        phrase: example.intent,
        word: 'MUTATION',
        shows: '+++ b/',
        offered: [REPORT_TOOL, PROPOSE_TOOL, VERDICT_TOOL],
      },
      [example.intent, '--repo', repo, '--project', project],
      example.operations,
    )
  })
})

/**
 * The Backstage leg (docs/backstage-http-brief.md § 4): a run whose personal
 * file names both a declarations repository and a catalogue, the catalogue's
 * token in `IDP_BACKSTAGE_TOKEN`, as a person configures them. The token goes
 * to the configured catalogue, on its two GET routes, in one header — never
 * to a model provider, to MLflow, to a child process, onto stdout or stderr,
 * or into a trace; and a model key never goes to the catalogue. Catalogue
 * content reaches the Supervisor and the Analyst, and never the Architect,
 * which is shown the repository alone (§ 3): only the catalogue declares the
 * marker, so the searches for it are not vacuous.
 */
const TOKEN = 'canary-backstage-token-that-is-not-real-0123456789'
/** Whether this machine keeps a copy at all: none on Windows, and none for root. */
const KEEPS = process.platform !== 'win32' && process.getuid?.() !== 0
const CATALOGUE = 'https://backstage.canary.example/api/catalog'
const MARKER = 'group:default/only-in-catalogue'

/** The demo SI with three Groups, and one Component only the catalogue holds. */
const catalogueEntities = (): Record<string, unknown>[] => [
  ...catalogueOf(FIXTURES, { groups: ['tiger', 'elephant', 'dodowarriors'] }),
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'catalogue-only-canary',
      namespace: 'default',
      uid: 'uid-catalogue-only-canary',
      annotations: { 'backstage.io/managed-by-location': 'url:https://github.com/acme/elsewhere/blob/main/catalog-info.yaml' },
    },
    spec: { type: 'service', lifecycle: 'production', owner: MARKER },
  },
]

describe.each(PROVIDER_NAMES)('the %s key and the catalogue token on a real run', (provider) => {
  const wire = WIRES[provider]

  interface Ran {
    code: number
    /** The cache root the run was handed, as `bin.ts` hands one: every byte under it is searched. */
    cache: string
    toCatalogue: ToCatalogue[]
    toProvider: Sent[]
    toMlflow: Sent[]
    out: string
    err: string
    trace: string
  }

  const runRoad = async (argv: string[], word: Road['word'], operations: unknown[] = [], faults?: Faults): Promise<Ran> => {
    const { repo } = await repositories()
    const xdg = path.join(path.dirname(repo), 'xdg')
    // A folder no one made: the store makes it, one name deep.
    const cache = path.join(path.dirname(repo), 'cache')
    await mkdir(path.join(xdg, 'idp-agent'), { recursive: true })
    await writeFile(path.join(xdg, 'idp-agent', 'config.yml'), `repo: ${repo}\nbackstage: ${CATALOGUE}\n`, 'utf8')

    const toProvider: Sent[] = []
    const reply = answering(wire, word, operations)
    vi.stubGlobal('fetch', keeping(toProvider, (body) => json(reply(JSON.parse(body) as Body))))
    // As a real shell holds them: a child process that inherited the
    // environment would carry both.
    vi.stubEnv(wire.key, KEY)
    vi.stubEnv('IDP_BACKSTAGE_TOKEN', TOKEN)
    for (const variable of wire.moves) vi.stubEnv(variable, undefined)
    spawned.environments.length = 0

    const catalogue = fakeBackstage({ entities: catalogueEntities(), token: TOKEN, ...(faults === undefined ? {} : { faults }) })
    const toMlflow: Sent[] = []
    const sink = memorySink()
    const out: string[] = []
    const err: string[] = []
    const code = await main(argv, {
      root: FIXTURES,
      env: {
        IDP_PROVIDER: provider,
        IDP_MODEL: wire.model,
        [wire.key]: KEY,
        IDP_MLFLOW_TRACKING_URI: MLFLOW,
        XDG_CONFIG_HOME: xdg,
        IDP_BACKSTAGE_TOKEN: TOKEN,
      },
      catalogueFetch: catalogue.fetch,
      cacheRoot: { dir: cache },
      fetch: keeping(toMlflow, () => new Response('{}', { status: 200 })),
      traceSinks: [sink],
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      events: () => {},
    })
    const trace = JSON.stringify(sink.traces, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))
    return { code, cache, toCatalogue: catalogue.sent, toProvider, toMlflow, out: out.join(''), err: err.join(''), trace }
  }

  /** Nothing the token or the key could be found in but where each belongs. */
  const heldNowhere = (ran: Ran): void => {
    for (const sent of [...ran.toProvider, ...ran.toMlflow]) expect(JSON.stringify(sent)).not.toContain(TOKEN)
    for (const environment of spawned.environments) {
      expect(JSON.stringify(environment)).not.toContain(TOKEN)
      expect(JSON.stringify(environment)).not.toContain(KEY)
    }
    for (const text of [ran.out, ran.err, ran.trace]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(KEY)
    }
  }

  /** The token, its sha256 and its base64: none is at rest under the cache root, in a name or a byte. */
  const noneAtRest = async (cache: string): Promise<number> => {
    const forms = [TOKEN, createHash('sha256').update(TOKEN).digest('hex'), Buffer.from(TOKEN).toString('base64')]
    const names = (await readdir(cache, { recursive: true, withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile())
    for (const entry of names) {
      const file = path.join(entry.parentPath, entry.name)
      const bytes = await readFile(file, 'latin1')
      for (const form of forms) {
        expect(path.relative(cache, file)).not.toContain(form)
        expect(bytes, file).not.toContain(form)
      }
    }
    return names.length
  }

  it('reaches the catalogue only, in one header, on a question and on a change', async () => {
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { intent: string; operations: unknown[] }
    const question = 'which databases are in prod?'
    for (const road of ['question', 'change'] as const) {
      const { project } = await repositories()
      const ran =
        road === 'question'
          ? await runRoad([question], 'QUESTION')
          : await runRoad([example.intent, '--project', project], 'MUTATION', example.operations)
      expect(ran.code, ran.err).toBe(0)
      expect(ran.out).toContain(road === 'question' ? 'Overview of the Backstage catalogue at backstage.canary.example' : '+++ b/')

      expect(ran.toCatalogue.length).toBeGreaterThan(0)
      for (const sent of ran.toCatalogue) {
        const url = new URL(sent.url)
        expect(`${url.origin}${url.pathname}`).toMatch(
          /^https:\/\/backstage\.canary\.example\/api\/catalog\/(entities\/by-query|entity-facets)$/,
        )
        expect(sent.method).toBe('GET')
        expect(sent.redirect).toBe('error')
        expect(Object.entries(sent.headers).filter(([, value]) => value.includes(TOKEN))).toEqual([
          ['authorization', `Bearer ${TOKEN}`],
        ])
        expect(JSON.stringify(sent)).not.toContain(KEY)
      }
      // The transport never falls back to the global fetch.
      expect(ran.toProvider.filter(({ url }) => url.startsWith('https://backstage.canary.example'))).toEqual([])

      // Catalogue content reaches the provider and MLflow on both roads — the
      // Supervisor's summary, and on a question the Analyst's — so the token
      // searches are not vacuous.
      const offering = (tool: string): Sent[] =>
        ran.toProvider.filter(({ body }) => wire.offered(JSON.parse(body) as Body).includes(tool))
      expect(ran.toProvider.some(({ body }) => body.includes(MARKER))).toBe(true)
      expect(ran.toMlflow.some(({ body }) => body.includes(MARKER))).toBe(true)
      if (road === 'question') expect(offering('answer').some(({ body }) => body.includes(MARKER))).toBe(true)
      // The Architect is shown the repository, never the catalogue (§ 3).
      if (road === 'change') {
        expect(offering(PROPOSE_TOOL).length).toBeGreaterThan(0)
        expect(offering(PROPOSE_TOOL).some(({ body }) => body.includes(MARKER))).toBe(false)
        expect(offering(VERDICT_TOOL).some(({ body }) => body.includes(MARKER))).toBe(false)
        // The Inspector's `git rev-parse` ran, so the search below is not vacuous.
        expect(spawned.environments.length).toBeGreaterThan(0)
      } else {
        expect(spawned.environments).toEqual([])
      }
      heldNowhere(ran)
      // A copy and the secret were kept, so the search is not vacuous — where a copy is kept at all.
      const kept = await noneAtRest(ran.cache)
      if (KEEPS) expect(kept).toBeGreaterThanOrEqual(2)
    }
  })

  it.skipIf(!KEEPS)('keys a copy by the token under the secret: two roots, two secrets, two keys, neither the token’s hash', async () => {
    const sha = createHash('sha256').update(TOKEN).digest('hex')
    const keyOf = async (): Promise<string> => {
      const cache = await mkdtemp(path.join(tmpdir(), 'key-reach-cache-'))
      const catalogue = fakeBackstage({ entities: catalogueEntities(), token: TOKEN })
      const code = await main(['graph', '--backstage'], {
        root: FIXTURES,
        env: { IDP_BACKSTAGE_URL: CATALOGUE, IDP_BACKSTAGE_TOKEN: TOKEN },
        catalogueFetch: catalogue.fetch,
        cacheRoot: { dir: cache },
        out: () => {},
        err: () => {},
      })
      expect(code).toBe(0)
      await noneAtRest(cache)
      const keys = (await readdir(path.join(cache, 'idp-agent', 'backstage'))).filter((name) => /^[0-9a-f]{32}$/.test(name))
      expect(keys).toHaveLength(1)
      return keys[0] ?? ''
    }
    const [one, two] = [await keyOf(), await keyOf()]
    expect(one).not.toBe(two)
    for (const key of [one, two]) expect(sha.startsWith(key)).toBe(false)
  })

  it.each<[string, Faults]>([
    ['401', { status: { at: 0, status: 401 } }],
    ['403', { status: { at: 0, status: 403 } }],
    ['500', { status: { at: 1, status: 500 } }],
    ['a body echoing the request', { echoHeaders: { at: 0 } }],
  ])('puts the token nowhere when the catalogue answers %s', async (_, faults) => {
    const ran = await runRoad(['which databases are in prod?'], 'QUESTION', [], faults)
    expect(ran.code).toBe(1)
    expect(ran.out).toBe('')
    expect(ran.err.trimEnd().split('\n')).toHaveLength(1)
    expect(ran.err).toMatch(/^the Backstage catalogue at backstage\.canary\.example \(/)
    // Refused before any model: nothing reached the provider or MLflow.
    expect(ran.toProvider).toEqual([])
    heldNowhere(ran)
  })
})

/**
 * The gh leg (stage 6 brief § 5, § 16): `idpa protection`, the first command
 * that starts gh. idpa holds no GitHub credential: gh reads its own login —
 * here `GH_TOKEN` and `GITHUB_TOKEN`, as a person may export them — and the
 * environment it is handed is the person's, passed on unread, minus what the
 * gh launcher removes: the variable that would point gh at another host, and
 * every provider key and catalogue variable `spawnedEnvironment` removes. No
 * credential reaches an argument, stdin, stdout or stderr. gh is the fake,
 * handed in as `MainDeps.gh`; the git that reads the clone runs for real,
 * through the mocked `execFile` above, and is held to the same.
 */
describe('idpa protection', () => {
  const GH_CANARY = 'canary-gh-token-that-is-not-real-0123456789'

  it('hands gh the person’s login variables unread, and no model key, catalogue token or host', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'idp-key-reach-gh-'))
    temporary.push(base)
    const repo = path.join(base, 'iac')
    const home = path.join(base, 'home')
    await mkdir(repo)
    await mkdir(home)
    // The fixture's own git, synchronous: the mocked execFile above is the
    // run's, and a clone built through it would be counted as the run's.
    const fixture = (...args: string[]): void =>
      void execFileSync('git', ['-C', repo, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'ignore',
      })
    fixture('init', '-q', '-b', 'main')
    fixture('config', 'user.name', 'key reach')
    fixture('config', 'user.email', 'key-reach@idp-agent.invalid')
    fixture('commit', '-q', '--allow-empty', '-m', 'base')
    fixture('remote', 'add', 'origin', 'git@github.com:acme/iac.git')
    fixture('config', 'branch.main.remote', 'origin')
    fixture('config', 'branch.main.merge', 'refs/heads/main')
    spawned.environments.length = 0

    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const out: string[] = []
    const err: string[] = []
    const code = await main(['protection', '--repo', repo], {
      gh: fake.process,
      env: {
        PATH: process.env['PATH'],
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        GH_TOKEN: GH_CANARY,
        GITHUB_TOKEN: GH_CANARY,
        OPENAI_API_KEY: KEY,
        IDP_BACKSTAGE_TOKEN: TOKEN,
        GH_HOST: 'evil.example',
      },
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
    })

    // gh was started — the version, whom it acts as, and § 8's reads — so the
    // searches below are not vacuous.
    expect(fake.sent.length).toBeGreaterThanOrEqual(5)
    expect(code, err.join('')).toBe(0)
    for (const sent of fake.sent) {
      expect(sent.env['GH_TOKEN']).toBe(GH_CANARY)
      expect(sent.env['GITHUB_TOKEN']).toBe(GH_CANARY)
      expect(Object.keys(sent.env).map((name) => name.toUpperCase())).not.toContain('GH_HOST')
      const environment = JSON.stringify(sent.env)
      for (const secret of [KEY, TOKEN, 'evil.example']) expect(environment).not.toContain(secret)
      const handed = JSON.stringify([sent.argv, sent.stdin?.toString('utf8') ?? ''])
      for (const secret of [GH_CANARY, KEY, TOKEN, 'evil.example']) expect(handed).not.toContain(secret)
    }

    // The git that read the clone's upstream: no model key, no catalogue token.
    expect(spawned.environments.length).toBeGreaterThan(0)
    for (const environment of spawned.environments) {
      const shown = JSON.stringify(environment)
      expect(shown).not.toContain(KEY)
      expect(shown).not.toContain(TOKEN)
    }

    for (const text of [out.join(''), err.join('')]) {
      for (const secret of [GH_CANARY, KEY, TOKEN]) expect(text).not.toContain(secret)
    }
  })
})

/**
 * The push leg (stage 6 brief § 5, § 16): `plan --from … --submit` on a
 * GitHub road, the first road that pushes. gh reads its own login and git
 * pushes with the person's — here `GH_TOKEN` and `GITHUB_TOKEN`, as a person
 * may export them, which both are handed unread — and neither is handed
 * anything of idpa's: no provider key, no catalogue token, and none of the
 * inherited variables that would point gh at another host or repository, make
 * it print its traffic, or move git's repository, configuration or askpass.
 * The push keeps exactly the four variables of § 5 the person set. gh is the
 * fake, handed in as `MainDeps.gh`; the remote is a bare repository on disk,
 * reached through a fake ssh; every git call runs for real, through the
 * mocked `execFile` above.
 */
describe('plan --from --submit, to GitHub', () => {
  const GH_CANARY = 'canary-gh-token-that-is-not-real-0123456789'
  const ENTERPRISE = 'enterprise-canary'
  /** What the launchers must drop, each planted with a value of its own. */
  const INHERITED = {
    GIT_DIR: '/nonexistent/git-dir',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/nonexistent'",
    GIT_ASKPASS: '/nonexistent/askpass',
    GH_HOST: 'evil.example',
    GH_REPO: 'evil/repo',
    GH_DEBUG: 'api',
    GODEBUG: 'http2debug=2',
    GH_ENTERPRISE_TOKEN: ENTERPRISE,
  }
  const gitVariables = (env: NodeJS.ProcessEnv): Record<string, string | undefined> =>
    Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase().startsWith('GIT_')))

  it("hands gh and the push nothing of idpa's, and passes the person's gh login unread, on plan --from --submit", async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'idp-key-reach-push-'))
    temporary.push(base)
    const repo = path.join(base, 'iac')
    const bare = path.join(base, 'github.git')
    const home = path.join(base, 'home')
    await cp(FIXTURES, repo, { recursive: true })
    await mkdir(home)
    // The fixture's own git, synchronous: the mocked execFile above is the
    // run's, and a clone built through it would be counted as the run's.
    const isolated = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const fixture = (...args: string[]): void =>
      void execFileSync('git', ['-C', repo, ...args], { env: isolated, stdio: 'ignore' })
    fixture('init', '-q', '-b', 'main')
    fixture('config', 'user.name', 'key reach')
    fixture('config', 'user.email', 'key-reach@idp-agent.invalid')
    fixture('add', '-A')
    fixture('commit', '-q', '-m', 'the demo catalogue')
    execFileSync('git', ['init', '-q', '--bare', bare], { env: isolated, stdio: 'ignore' })
    fixture('push', '-q', bare, 'main:refs/heads/main')
    fixture('remote', 'add', 'origin', 'git@github.com:acme/iac.git')
    fixture('config', 'branch.main.remote', 'origin')
    fixture('config', 'branch.main.merge', 'refs/heads/main')
    const ssh = await fakeSsh(base, bare)
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      // Built by hand, so the worker's closed proxy is carried over by hand.
      ...Object.fromEntries(PROXY_VARIABLES.map((name) => [name, CLOSED_PROXY])),
      GIT_SSH_COMMAND: ssh,
      GIT_SSH_VARIANT: 'simple',
      ...Object.fromEntries(PROVIDER_NAMES.map((name) => [WIRES[name].key, KEY])),
      IDP_BACKSTAGE_URL: TOKEN,
      IDP_BACKSTAGE_TOKEN: TOKEN,
      GH_TOKEN: GH_CANARY,
      GITHUB_TOKEN: GH_CANARY,
      ...INHERITED,
    }
    // The push goes where the fake ssh serves, never to a URL this machine's
    // git configuration rewrites github.com's into.
    requireUnrewritten(repo, env)
    spawned.environments.length = 0
    spawned.calls.length = 0

    const fake = fakeGitHub({ repositories: [protectedMain({ bare })] })
    const out: string[] = []
    const err: string[] = []
    const code = await main(['plan', '--from', EXAMPLE, '--repo', repo, '--submit', '--json'], {
      gh: fake.process,
      ask: async (question) => (question.path.endsWith('.access') ? 'read' : confirmingEnvironment(question)),
      env,
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
    })

    expect(code, err.join('')).toBe(0)
    const submission = (JSON.parse(out.join('')) as { submission: { outcome: string; pushed: boolean; pullRequest?: unknown } })
      .submission
    expect(submission).toMatchObject({ outcome: 'created', pushed: true, pullRequest: { number: 1 } })
    expect(fake.state.pulls).toHaveLength(1)

    const secrets = [KEY, TOKEN, GH_CANARY, ENTERPRISE]
    // gh: the person's login variables, unread; nothing of idpa's, nothing inherited that moves it.
    expect(fake.sent.length).toBeGreaterThanOrEqual(8)
    for (const sent of fake.sent) {
      expect(sent.env['GH_TOKEN']).toBe(GH_CANARY)
      expect(sent.env['GITHUB_TOKEN']).toBe(GH_CANARY)
      expect(sent.env['GH_PROMPT_DISABLED']).toBe('1')
      const names = Object.keys(sent.env).map((name) => name.toUpperCase())
      for (const name of ['GH_HOST', 'GH_REPO', 'GH_DEBUG', 'GODEBUG', 'GH_ENTERPRISE_TOKEN', 'IDP_BACKSTAGE_URL', 'IDP_BACKSTAGE_TOKEN']) {
        expect(names, name).not.toContain(name)
      }
      expect(names.filter((name) => name.startsWith('GIT_'))).toEqual([])
      expect(names.filter((name) => name.endsWith('_API_KEY'))).toEqual([])
      const environment = JSON.stringify(sent.env)
      for (const secret of [KEY, TOKEN, ENTERPRISE]) expect(environment).not.toContain(secret)
      const handed = JSON.stringify([sent.argv, sent.stdin?.toString('utf8') ?? ''])
      for (const secret of secrets) expect(handed).not.toContain(secret)
    }

    // git: every call, the push among them.
    const pushes = spawned.calls.filter((call) => call.args.includes('push'))
    expect(pushes).toHaveLength(1)
    expect(spawned.calls.length).toBeGreaterThan(pushes.length)
    for (const call of spawned.calls) {
      // The suite's closed proxy, which this hand-built environment carries
      // as the worker's does (tests/setup/forge.ts): git over HTTPS goes nowhere.
      for (const name of PROXY_VARIABLES) expect(call.env[name], name).toBe(CLOSED_PROXY)
      expect(call.env['GH_TOKEN']).toBe(GH_CANARY)
      expect(call.env['GITHUB_TOKEN']).toBe(GH_CANARY)
      // The person's own variables are git's to read, unread by idpa (§ 5);
      // nothing of idpa's is in them.
      const environment = JSON.stringify(call.env)
      for (const secret of [KEY, TOKEN]) expect(environment).not.toContain(secret)
      for (const secret of secrets) expect(JSON.stringify(call.args)).not.toContain(secret)
      expect(gitVariables(call.env)).toEqual(
        call.args.includes('push')
          ? {
              GIT_SSH_COMMAND: ssh,
              GIT_SSH_VARIANT: 'simple',
              GIT_ASKPASS: INHERITED.GIT_ASKPASS,
              GIT_OPTIONAL_LOCKS: '0',
              GIT_TERMINAL_PROMPT: '0',
            }
          : { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      )
    }

    for (const text of [out.join(''), err.join(''), JSON.stringify(fake.state.pulls)]) {
      for (const secret of secrets) expect(text).not.toContain(secret)
    }
  })
})

/**
 * The submission legs (stage 6 brief § 5, § 12, § 16): a model-backed road
 * that ends on GitHub, as a person runs it — the provider's key exported, gh
 * logged in through `GH_TOKEN` and `GITHUB_TOKEN`, the clone's `main`
 * tracking github.com. The model is reached through its real adapter, with
 * only `fetch` replaced, as in the first block; gh is the fake, handed in as
 * `MainDeps.gh` and recorded; git runs for real, through the mocked
 * `execFile` above, and pushes to a bare repository over the fake ssh.
 *
 * Two places are sent different things, and each is held to its own (§ 12):
 * the provider is sent nothing of GitHub; the trace says where the submission
 * went, and never who made it or with what. gh and the push are handed the
 * person's login variables unread, and nothing of idpa's.
 */
describe.each(PROVIDER_NAMES)("the %s key, and the person's gh and git, on a submission to GitHub", (provider) => {
  const wire = WIRES[provider]
  const GH_CANARY = 'canary-gh-token-that-is-not-real-0123456789'
  /** Whom gh is logged in as: a login no prompt holds by chance, as `ada` is in every `metadata`. */
  const LOGIN = 'canary-login-0e7a'

  interface Handed {
    readonly argv: readonly string[]
    readonly stdin: string
    readonly env: NodeJS.ProcessEnv
  }

  interface Submitted {
    code: number
    out: string
    err: string
    toProvider: Sent[]
    toMlflow: Sent[]
    /** The trace the sink kept, serialised. */
    trace: string
    /** Its root's attributes. */
    root: Record<string, unknown>
    /** Every gh call: its vector, its standard input, its environment. */
    toGh: Handed[]
    /** The base's commit, which nothing of git's may carry to a prompt. */
    base: string
    /** The pull requests the fake GitHub holds after the run. */
    pulls: unknown
  }

  afterAll(removeClones)

  /**
   * The first block's run, with a clone on github.com — the demo SI's as
   * `acme/iac` unless `cloned` names another source and repository — the
   * person's gh, and `--repo` appended. Handed a `catalogue`, the run reads
   * it instead, as a person configures one — `IDP_BACKSTAGE_URL` ahead of
   * `IDP_REPO`, the token in `IDP_BACKSTAGE_TOKEN` — and the clone is named
   * by `IDP_REPO`, with no `--repo`, so the catalogue is what is read.
   */
  const submittingRun = async (
    argv: string[],
    word: Road['word'],
    operations: unknown[],
    arrange: (clone: GitHubClone) => void = () => {},
    cloned: { readonly source: string; readonly repository: string } = { source: FIXTURES, repository: 'acme/iac' },
    catalogue?: ReturnType<typeof fakeBackstage>,
    more: Pick<MainDeps, 'propose'> = {},
  ): Promise<Submitted> => {
    const clone = await githubClone({ ...cloned, login: LOGIN })
    arrange(clone)
    const base = await git(clone.repo, 'rev-parse', 'main')
    const toGh: Handed[] = []
    const gh: GhProcess = async (vector, options) => {
      toGh.push({ argv: [...vector], stdin: options.stdin?.toString('utf8') ?? '', env: { ...options.env } })
      return clone.gh.process(vector, options)
    }
    const toProvider: Sent[] = []
    const reply = answering(wire, word, operations)
    vi.stubGlobal('fetch', keeping(toProvider, (body) => json(reply(JSON.parse(body) as Body))))
    // As a real shell holds them: a child process that inherited the
    // environment would carry all three.
    vi.stubEnv(wire.key, KEY)
    vi.stubEnv('GH_TOKEN', GH_CANARY)
    vi.stubEnv('GITHUB_TOKEN', GH_CANARY)
    if (catalogue !== undefined) vi.stubEnv('IDP_BACKSTAGE_TOKEN', TOKEN)
    for (const variable of wire.moves) vi.stubEnv(variable, undefined)
    // The clone was built through the mocked execFile: none of it is the run's.
    spawned.environments.length = 0
    spawned.calls.length = 0

    const toMlflow: Sent[] = []
    const sink = memorySink()
    const out: string[] = []
    const err: string[] = []
    const code = await main(catalogue === undefined ? [...argv, '--repo', clone.repo] : argv, {
      root: FIXTURES,
      gh,
      env: {
        ...clone.env,
        IDP_PROVIDER: provider,
        IDP_MODEL: wire.model,
        [wire.key]: KEY,
        IDP_MLFLOW_TRACKING_URI: MLFLOW,
        GH_TOKEN: GH_CANARY,
        GITHUB_TOKEN: GH_CANARY,
        ...(catalogue === undefined
          ? {}
          : { IDP_REPO: clone.repo, IDP_BACKSTAGE_URL: CATALOGUE, IDP_BACKSTAGE_TOKEN: TOKEN }),
      },
      ...(catalogue === undefined ? {} : { catalogueFetch: catalogue.fetch }),
      fetch: keeping(toMlflow, () => new Response('{}', { status: 200 })),
      traceSinks: [sink],
      ...more,
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      events: () => {},
    })
    // A run refused before the model writes no trace: `code` says why.
    const kept = sink.traces.length === 0 ? undefined : onlyTrace(sink)
    return {
      code,
      out: out.join(''),
      err: err.join(''),
      toProvider,
      toMlflow,
      trace: JSON.stringify(kept ?? null, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
      root: { ...(kept?.spans[0]?.attributes ?? {}) },
      toGh,
      base,
      pulls: clone.gh.state.pulls ?? [],
    }
  }

  /**
   * What the provider, the trace, gh, git, stdout and stderr were each handed,
   * held to § 12 and § 5. `typed`: what the person typed that spells
   * `github.com` and the run's output quotes — `init`'s `--iac-repo`, which
   * the diff of `.idp-agent.yml` previews and a trace keeps with the output.
   * It is the person's, not GitHub's, and is set aside from the search of the
   * trace and of MLflow only; the provider is held to never seeing it.
   */
  const heldToGitHub = (ran: Submitted, repository: string, typed: readonly string[] = []): void => {
    const login = /as ([A-Za-z0-9-]+) \(gh\)$/m.exec(ran.err)?.[1] ?? ''
    expect(login, ran.err).toBe(LOGIN)

    // The provider: its URL, the key in its one header, and nothing of GitHub.
    expect(ran.toProvider.length).toBeGreaterThan(0)
    for (const sent of ran.toProvider) {
      expect(sent.url).toBe(wire.url)
      expect(sent.headers[wire.header]).toBe(wire.carrying(KEY))
      const others = Object.entries(sent.headers).filter(([name]) => name !== wire.header)
      expect(JSON.stringify(others)).not.toContain(KEY)
      expect(sent.body).not.toContain(KEY)
      const shown = JSON.stringify(sent)
      for (const github of ['github.com', login, GH_CANARY, ran.base]) expect(shown, github).not.toContain(github)
    }

    // The trace: where the submission went, and never who or with what.
    expect(ran.root).toMatchObject({
      'idp.forge.kind': 'github',
      'idp.forge.host': 'github.com',
      'idp.forge.repository': repository,
      'idp.forge.pull_request': 1,
    })
    // `github.com` is held to two places: the root's `idp.forge.host`, and the
    // run's output, which a trace keeps on every road — whose one line naming
    // GitHub is the engine-built pull request line, the host, the repository
    // and the number the attributes already carry. Nothing else of GitHub's.
    const opened = `Pull request #1 opened on github.com/${repository}: https://github.com/${repository}/pull/1`
    expect(ran.out).toContain(opened)
    const elsewhere = (text: string, attribute: string): string =>
      typed.reduce((left, value) => left.replaceAll(value, ''), text.replaceAll(attribute, '').replaceAll(opened, ''))
    expect(elsewhere(ran.trace, '"idp.forge.host":"github.com"')).not.toContain('github.com')
    const shipped = '{"key":"idp.forge.host","value":{"stringValue":"github.com"}}'
    expect(ran.toMlflow.some((sent) => sent.body.includes(shipped))).toBe(true)
    for (const sent of ran.toMlflow) expect(elsewhere(sent.body, shipped)).not.toContain('github.com')
    for (const text of [ran.trace, ...ran.toMlflow.map((sent) => JSON.stringify(sent))]) {
      for (const secret of [login, GH_CANARY, KEY]) expect(text).not.toContain(secret)
    }

    // gh: the person's login variables unread, and no model key anywhere.
    expect(ran.toGh.length).toBeGreaterThanOrEqual(8)
    for (const call of ran.toGh) {
      expect(call.env['GH_TOKEN']).toBe(GH_CANARY)
      expect(call.env['GITHUB_TOKEN']).toBe(GH_CANARY)
      expect(JSON.stringify(call.env)).not.toContain(KEY)
      for (const secret of [KEY, GH_CANARY]) {
        expect(JSON.stringify(call.argv)).not.toContain(secret)
        expect(call.stdin).not.toContain(secret)
      }
    }
    // The pull request's body went on standard input, so the search above is not vacuous.
    expect(ran.toGh.some((call) => call.stdin !== '')).toBe(true)

    // git, the push among them: no model key in any environment.
    expect(spawned.calls.filter((call) => call.args.includes('push'))).toHaveLength(1)
    for (const environment of spawned.environments) expect(JSON.stringify(environment)).not.toContain(KEY)

    for (const text of [ran.out, ran.err]) {
      for (const secret of [KEY, GH_CANARY]) expect(text).not.toContain(secret)
    }
  }

  it('reaches its provider in its header, and nothing of GitHub reaches it, on plan "<intent>" --submit', async () => {
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { intent: string; operations: unknown[] }
    const { project } = await repositories()
    const ran = await submittingRun(['plan', example.intent, '--project', project, '--submit'], 'MUTATION', example.operations)

    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('Pull request #1 opened on github.com/acme/iac')
    heldToGitHub(ran, 'acme/iac')
  }, 30_000)

  it('reaches its provider in its header, and nothing of GitHub reaches it, on idpa "<phrase>" --submit', async () => {
    // The phrase road: the forge, gh and the base's rules read before the
    // Supervisor, whose request is among the provider's, held to the same.
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { intent: string; operations: unknown[] }
    const { project } = await repositories()
    const ran = await submittingRun([example.intent, '--project', project, '--submit'], 'MUTATION', example.operations)

    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('Pull request #1 opened on github.com/acme/iac')
    // The first request is the Supervisor's, and the only one: its
    // instructions, the request it classifies, and no tool offered at all.
    const supervisor = ran.toProvider.filter(({ body }) => body.includes('You classify a request about an infrastructure catalogue'))
    expect(supervisor).toHaveLength(1)
    expect(supervisor[0]).toBe(ran.toProvider[0])
    expect(supervisor[0]?.body).toContain(JSON.stringify(`request: ${example.intent}`).slice(1, -1))
    expect(wire.offered(JSON.parse(supervisor[0]?.body ?? '{}') as Body)).toEqual([])
    heldToGitHub(ran, 'acme/iac')
  }, 30_000)

  it('reaches its provider in its header, and nothing of GitHub reaches it, when idpa "<phrase>" proposes at a terminal and is answered y', async () => {
    // The proposal road (2026-10-01): no --submit typed, and gh started only
    // after the last model call; the question's answer stands for the terminal.
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { intent: string; operations: unknown[] }
    const { project } = await repositories()
    const ran = await submittingRun([example.intent, '--project', project], 'MUTATION', example.operations, undefined, undefined, undefined, {
      propose: async () => true,
    })

    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('Pull request #1 opened on github.com/acme/iac')
    expect(ran.root['idp.forge.proposed']).toBe(true)
    heldToGitHub(ran, 'acme/iac')
  }, 30_000)

  it('sends the catalogue token to the catalogue alone when idpa "<phrase>" --submit reads one and opens a pull request', async () => {
    // The one run shape new to this road: a change that reads a catalogue —
    // the Supervisor is shown it — then starts gh and a push. The token goes
    // in the catalogue's one header, and nowhere gh, git, the provider, the
    // pull request, the trace or the terminal could carry it; nothing only
    // the catalogue declares reaches gh either, the pull request included.
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { intent: string; operations: unknown[] }
    const { project } = await repositories()
    const catalogue = fakeBackstage({ entities: catalogueEntities(), token: TOKEN })
    const ran = await submittingRun(
      [example.intent, '--project', project, '--submit'],
      'MUTATION',
      example.operations,
      () => {},
      undefined,
      catalogue,
    )

    expect(ran.code, ran.err).toBe(0)
    expect(ran.err).toMatch(/^reading the Backstage catalogue at backstage\.canary\.example/m)
    expect(ran.out).toContain('Pull request #1 opened on github.com/acme/iac')

    // The catalogue was read, with the token in its one header and nowhere else of the request.
    expect(catalogue.sent.length).toBeGreaterThan(0)
    for (const sent of catalogue.sent) {
      expect(Object.entries(sent.headers).filter(([, value]) => value.includes(TOKEN))).toEqual([
        ['authorization', `Bearer ${TOKEN}`],
      ])
      expect(sent.url).not.toContain(TOKEN)
    }
    // What only the catalogue declares reached the Supervisor, so the searches below are not vacuous.
    expect(ran.toProvider.some(({ body }) => body.includes(MARKER))).toBe(true)

    for (const sent of [...ran.toProvider, ...ran.toMlflow]) expect(JSON.stringify(sent)).not.toContain(TOKEN)
    for (const call of ran.toGh) {
      expect(Object.keys(call.env).map((name) => name.toUpperCase()).filter((name) => name.startsWith('IDP_BACKSTAGE'))).toEqual([])
      for (const handed of [JSON.stringify(call.env), JSON.stringify(call.argv), call.stdin]) {
        expect(handed).not.toContain(TOKEN)
        expect(handed).not.toContain(MARKER)
        expect(handed).not.toContain('catalogue-only-canary')
      }
    }
    expect(spawned.calls.filter((call) => call.args.includes('push'))).toHaveLength(1)
    for (const call of spawned.calls) expect(JSON.stringify([call.args, call.env])).not.toContain(TOKEN)
    for (const environment of spawned.environments) expect(JSON.stringify(environment)).not.toContain(TOKEN)
    const pulls = JSON.stringify(ran.pulls)
    expect(pulls).toContain('This change was drafted by a model from a phrase idpa took for a change')
    for (const text of [pulls, ran.trace, ran.out, ran.err]) {
      expect(text).not.toContain(TOKEN)
    }
    expect(pulls).not.toContain(MARKER)
    heldToGitHub(ran, 'acme/iac')
  }, 30_000)

  it('reaches its provider in its header, and nothing of GitHub reaches it, on init --submit', async () => {
    // The service's own repository on github.com, the Inspector and the
    // Architect answered as the first block answers them. The flags answer
    // every field FACTS leaves open — its forge handle is unknown — so
    // nothing is asked of a run with no terminal, and it ends on exit 0.
    const { project } = await repositories()
    const ran = await submittingRun(
      [
        'init',
        '--submit',
        '--iac-repo',
        'github.com/acme/iac',
        '--environment',
        'prod',
        '--name',
        'orders-api',
        '--lifecycle',
        'production',
        '--owner',
        'group:default/tiger',
      ],
      'MUTATION',
      [
        {
          op: 'create-entity',
          entity: {
            kind: 'Component',
            metadata: { name: 'orders-api' },
            spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
          },
        },
      ],
      () => {},
      { source: project, repository: 'acme/orders-api' },
    )

    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('Pull request #1 opened on github.com/acme/orders-api')
    // The declarations repository the service names is another than the one
    // the pull request is opened on, so setting its locator aside sets aside
    // nothing GitHub answered about acme/orders-api.
    expect(ran.out).toContain('+iacRepo: "github.com/acme/iac"')
    heldToGitHub(ran, 'acme/orders-api', ['github.com/acme/iac'])
  }, 30_000)

  it('keeps gh\'s login off the trace and MLflow when the rules let the author merge alone, or refuse the push, on plan "<intent>" --submit, in prose and in --json', async () => {
    // The preflight comes after the configuration, inside the traced run: the
    // two misses that would name whom gh acts as (§ 8, § 12). A rule gh's
    // account bypasses is a note since the owner's decision of 2026-10-01 —
    // the pull request is opened, the provider reached, and the note said on
    // stderr — and push access is still the refusal it was, before any model.
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { intent: string; operations: unknown[] }
    const { project } = await repositories()
    const misses: readonly [string, (clone: GitHubClone) => void][] = [
      [
        'rules',
        (clone) => {
          clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
            ...one,
            rulesets: one.rulesets.map((ruleset) => ({ ...ruleset, canBypass: 'always' })),
          }))
        },
      ],
      [
        'push access',
        (clone) => {
          clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
            ...one,
            permissions: { ...one.permissions, [LOGIN]: { admin: true, maintain: false, push: false } },
          }))
        },
      ],
    ]
    for (const [missing, arrange] of misses) {
      for (const json of [[], ['--json']]) {
        const ran = await submittingRun(
          ['plan', example.intent, '--project', project, '--submit', ...json],
          'MUTATION',
          example.operations,
          arrange,
        )

        if (missing === 'rules') {
          expect(ran.code, ran.err).toBe(0)
          expect(ran.toProvider.length).toBeGreaterThan(0)
          expect(ran.err.split('\n').filter((line) => line === MERGE_NOTE)).toHaveLength(1)
          expect(ran.out).not.toContain(MERGE_NOTE)
          expect(ran.root).toMatchObject({ 'idp.forge.kind': 'github', 'idp.forge.outcome': 'created' })
          expect(JSON.stringify(ran.pulls)).toContain(JSON.stringify(MERGE_NOTE).slice(1, -1))
        } else {
          expect(ran.code, ran.err).toBe(1)
          expect(ran.toProvider).toEqual([])
          expect(ran.out).toContain(`missing: ${missing}`)
          expect(ran.root).toMatchObject({ 'idp.forge.kind': 'github', 'idp.forge.outcome': 'refused' })
        }
        expect(ran.toMlflow.length).toBeGreaterThan(0)
        // The pull request's body and title: the fake records its author, the login, beside them.
        for (const text of [
          ran.out,
          ran.trace,
          JSON.stringify((ran.pulls as readonly { title: string; body: string }[]).map((pull) => [pull.title, pull.body])),
          ...ran.toMlflow.map((sent) => JSON.stringify(sent)),
        ]) {
          for (const secret of [LOGIN, GH_CANARY, KEY]) expect(text).not.toContain(secret)
        }
      }
    }
  }, 60_000)

  it("keeps gh's login off the trace and MLflow when the rules let the author merge alone, or refuse the push, on init --submit, naming --local", async () => {
    // init's refusal on push access is the same renderer's, with --local
    // offered (decision 17), inside the traced run like the intent road's; a
    // rule gh's account bypasses opens the service's pull request with the
    // note (2026-10-01). Neither miss that would name whom gh acts as reaches
    // the trace, MLflow or the pull request.
    const { project } = await repositories()
    const misses: readonly [string, (clone: GitHubClone) => void][] = [
      [
        'rules',
        (clone) => {
          clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
            ...one,
            rulesets: one.rulesets.map((ruleset) => ({ ...ruleset, canBypass: 'always' })),
          }))
        },
      ],
      [
        'push access',
        (clone) => {
          clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
            ...one,
            permissions: { ...one.permissions, [LOGIN]: { admin: true, maintain: false, push: false } },
          }))
        },
      ],
    ]
    for (const [missing, arrange] of misses) {
      // Every field FACTS leaves open answered by a flag, so the run that goes on asks nothing.
      const ran = await submittingRun(
        [
          'init',
          '--submit',
          '--iac-repo',
          'github.com/acme/iac',
          '--environment',
          'prod',
          '--name',
          'orders-api',
          '--lifecycle',
          'production',
          '--owner',
          'group:default/tiger',
        ],
        'MUTATION',
        [
          {
            op: 'create-entity',
            entity: {
              kind: 'Component',
              metadata: { name: 'orders-api' },
              spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
            },
          },
        ],
        arrange,
        { source: project, repository: 'acme/orders-api' },
      )

      if (missing === 'rules') {
        expect(ran.code, ran.err).toBe(0)
        expect(ran.toProvider.length).toBeGreaterThan(0)
        expect(ran.err.split('\n').filter((line) => line === MERGE_NOTE)).toHaveLength(1)
        expect(ran.out).toContain('Pull request #1 opened on github.com/acme/orders-api')
        expect(ran.root).toMatchObject({ 'idp.forge.kind': 'github', 'idp.forge.outcome': 'created' })
        expect(JSON.stringify(ran.pulls)).toContain(JSON.stringify(MERGE_NOTE).slice(1, -1))
      } else {
        expect(ran.code, ran.err).toBe(1)
        expect(ran.toProvider).toEqual([])
        expect(ran.out).toContain(`missing: ${missing}`)
        expect(ran.out).toContain('or add --local to cut the branch in this clone only')
        expect(ran.root).toMatchObject({ 'idp.forge.kind': 'github', 'idp.forge.outcome': 'refused' })
      }
      expect(ran.toMlflow.length).toBeGreaterThan(0)
      // The pull request's body and title: the fake records its author, the login, beside them.
      for (const text of [
        ran.out,
        ran.trace,
        JSON.stringify((ran.pulls as readonly { title: string; body: string }[]).map((pull) => [pull.title, pull.body])),
        ...ran.toMlflow.map((sent) => JSON.stringify(sent)),
      ]) {
        for (const secret of [LOGIN, GH_CANARY, KEY]) expect(text).not.toContain(secret)
      }
    }
  }, 60_000)
})
