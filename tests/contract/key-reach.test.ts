import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/cli/index.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { PROVIDER_NAMES, type ProviderName } from '../../src/llm/providers.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults, type Sent as ToCatalogue } from '../support/fake-backstage.js'
import { memorySink, onlyTrace } from '../support/trace.js'

/**
 * Every process a run starts, with the environment it was handed — or the
 * process's own, which is what a child is given when none is. Called through:
 * the Inspector's `git` runs as it always does.
 */
const spawned = vi.hoisted(() => ({ environments: [] as unknown[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const execFile = (...args: unknown[]): unknown => {
    const options = args
      .slice(1)
      .find((arg): arg is { env?: unknown } => typeof arg === 'object' && arg !== null && !Array.isArray(arg))
    spawned.environments.push(options?.env ?? { ...process.env })
    return (original.execFile as (...all: unknown[]) => unknown)(...args)
  }
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
