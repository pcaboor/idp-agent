import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from '../../src/context/backstage/limits.js'
import type { CatalogueFetch } from '../../src/context/backstage/transport.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults, type Sent } from '../support/fake-backstage.js'
import { memorySink, onlyTrace } from '../support/trace.js'

/**
 * A run that reads a Backstage catalogue (docs/backstage-http-brief.md § 3,
 * § 9, § 10), every one through `main` with the fake as `catalogueFetch`:
 * what the catalogue serves is read as the files read it, said once after
 * the load, and answered from — `graph`, `show`, `relations`, `ask` and a
 * phrase's question; a change is still decided against the declarations
 * repository, and nothing the catalogue holds vouches for a plan. A read
 * that fails is one line and exit 1, never an answer from part of it.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const OWNER = path.resolve(import.meta.dirname, '../golden/relations-owner')
const EXAMPLES = path.resolve(import.meta.dirname, '../../examples')
const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'
const REMOTE = 'https://backstage.acme.example/api/catalog'
const TOKEN = 'canary-backstage-token-0123456789'
const GROUPS = ['tiger', 'elephant', 'dodowarriors']
const MARKER = 'group:default/only-in-catalogue'
const WAY_OUT = '; --repo <directory> reads a repository instead, and `idpa plan` decides a change without the catalogue\n'

type Item = Record<string, unknown>

/** A Component as a catalogue serves it: a uid, a namespace, where it was read. */
const component = (name: string, spec: Item, metadata: Item = {}): Item => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name,
    namespace: 'default',
    uid: `uid-${name}`,
    annotations: { 'backstage.io/managed-by-location': `url:https://github.com/acme/extra/blob/main/${name}.yaml` },
    ...metadata,
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger', ...spec },
})

const demo = (): Item[] => catalogueOf(DEMO)
/** The demo SI with three of the four teams its entities name: common is missing. */
const withGroups = (): Item[] => catalogueOf(DEMO, { groups: GROUPS })
const ORG_YAML = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
/** The demo SI with the demo's organisation, as the fake program and the Docker Backstage serve it. */
const withOrganisation = (): Item[] => catalogueOf(DEMO, { org: ORG_YAML })

interface Ran {
  code: number
  out: string
  err: string
  sent: Sent[]
}

interface Options extends MainDeps {
  env?: Record<string, string | undefined>
  entities?: readonly Item[]
  faults?: Faults
  token?: string
}

const run = async (argv: string[], options: Options = {}): Promise<Ran> => {
  const { entities = withOrganisation(), faults, token, env = { IDP_BACKSTAGE_URL: LOOPBACK }, ...deps } = options
  const catalogue = fakeBackstage({ entities, ...(faults === undefined ? {} : { faults }), ...(token === undefined ? {} : { token }) })
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    root: DEMO,
    env,
    catalogueFetch: catalogue.fetch,
    events: () => {},
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join(''), sent: catalogue.sent }
}

const calling = (name: string, args: unknown, id = `c-${name}`): GenerateResult => ({
  text: '',
  toolCalls: [{ id, name, args }],
  finishReason: 'tool-calls',
})
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

/** Scripted turns per agent; every request kept, each with what the catalogue had been sent when it was made. */
const scripted = (
  turns: Partial<Record<AgentName, readonly GenerateResult[]>>,
  sent: () => number = () => 0,
): LlmClient & { seen: Array<GenerateRequest & { sentBefore: number }> } => {
  const spent = new Map<AgentName, number>()
  const seen: Array<GenerateRequest & { sentBefore: number }> = []
  return {
    seen,
    generate: async (request) => {
      seen.push({ ...request, transcript: [...request.transcript], sentBefore: sent() })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? saying('')
    },
  }
}

/** A client no run here may reach. */
const untouchable: LlmClient = {
  generate: () => {
    throw new Error('a model was called')
  },
}

/** A `fetch` no request may reach. */
const unreached = (): { fetch: CatalogueFetch; calls: number } => {
  const kept = {
    calls: 0,
    fetch: (async () => {
      kept.calls += 1
      throw new Error('the catalogue was requested')
    }) as CatalogueFetch,
  }
  return kept
}

/** A copy of the demo SI, and a HOME whose config.yml names it and, when given, a catalogue. */
const configured = async (backstage?: string): Promise<{ repo: string; home: string }> => {
  const base = await mkdtemp(path.join(tmpdir(), 'backstage-read-'))
  const repo = path.join(base, 'iac')
  const home = path.join(base, 'home')
  await cp(DEMO, repo, { recursive: true })
  const file = path.join(home, '.config', 'idp-agent', 'config.yml')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `repo: ${repo}\n${backstage === undefined ? '' : `backstage: ${backstage}\n`}`, 'utf8')
  return { repo, home }
}

/** A directory that is no repository at all, to stand in. */
const elsewhere = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'backstage-elsewhere-'))

describe('the demo SI, served by a catalogue', () => {
  it.each([
    [['graph']],
    [['graph', '--kind', 'Component']],
    [['show', 'billing-api']],
    [['relations', 'mysql-prod-01', '--impacts']],
    [['relations', 'reporting-worker', '--to', 'billing-api']],
  ])('%j prints what --demo prints, byte for byte', async (argv) => {
    const files = await run([...argv, '--demo'], { env: {} })
    const catalogue = await run(argv, { entities: demo() })
    expect(catalogue.out).toBe(files.out)
    expect(catalogue.code).toBe(files.code)
    expect(catalogue.sent.length).toBeGreaterThan(0)
  })

  it('ask: the overview is the demo’s from its second line, and its first names the catalogue', async () => {
    const overview = (): LlmClient =>
      scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] })
    const files = await run(['ask', 'what is there?', '--demo'], { env: {}, client: overview() })
    const catalogue = await run(['ask', 'what is there?'], { entities: demo(), client: overview() })
    expect(files.code).toBe(0)
    expect(catalogue.code).toBe(0)
    const [first, ...rest] = catalogue.out.split('\n')
    expect(first).toBe('Overview of the Backstage catalogue at 127.0.0.1:7007: 33 entities')
    expect(rest).toEqual(files.out.split('\n').slice(1))
  })
})

describe('what is said about the read', () => {
  it('prints the notice after the load, with the counts', async () => {
    const { code, err } = await run(['relations', 'mysql-prod-01', '--impacts'])
    expect(code).toBe(0)
    expect(err).toBe(
      'reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 40 entities: 40 read, 0 not modelled; ' +
        'it may lag the declarations repository by minutes; --repo <directory> reads a repository\n',
    )
  })

  it('counts what the pre-pass set aside once, apart from the kinds not modelled', async () => {
    const entities = [
      ...withOrganisation(),
      component('beta-svc', { lifecycle: 'beta' }),
      component('pay-svc', {}, { namespace: 'payments' }),
    ]
    const { code, err } = await run(['graph', '--kind', 'Component'], { entities })
    expect(code).toBe(0)
    expect(err).toBe(
      'reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 42 entities: 40 read, 0 not modelled, 2 set aside; ' +
        'it may lag the declarations repository by minutes; --repo <directory> reads a repository\n' +
        'set aside by the catalogue read: 1 lifecycle not modelled (beta ×1), 1 outside namespace default (payments ×1); first: component:default/beta-svc, component:payments/pay-svc\n',
    )
  })

  it('counts what the reader skipped, grouped by reason, and in the notice', async () => {
    const entities = [...demo(), component('no-owner', { owner: undefined })]
    const { code, err } = await run(['graph', '--kind', 'Component'], { entities })
    expect(code).toBe(0)
    const lines = err.trimEnd().split('\n')
    expect(lines[0]).toMatch(/: 34 entities: 33 read, 0 not modelled, 1 skipped; it may lag/)
    expect(lines[1]).toMatch(/^skipped 1: .*owner.* \(component:default\/no-owner\)$/)
    expect(lines).toHaveLength(2)
  })

  it('says the catalogue changed while it was read when a uid came twice and the read was still whole', async () => {
    const twice = structuredClone(withOrganisation().find((item) => item['kind'] === 'Component') as Item)
    const { code, err } = await run(['graph'], { faults: { extraItem: { at: 1, item: twice } } })
    expect(code).toBe(0)
    expect(err.split('\n')[0]).toBe(
      'reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 40 entities: 40 read, 0 not modelled; ' +
        'the catalogue changed while it was read (1 served twice); ' +
        'it may lag the declarations repository by minutes; --repo <directory> reads a repository',
    )
  })

  it('marks on show exactly the owners naming a team the catalogue does not serve, and adds nothing to graph’s dangling list', async () => {
    // Three of the demo's four teams: common, which 13 entities name, is missing.
    const graph = await run(['graph'], { entities: withGroups() })
    expect(graph.code).toBe(0)
    expect(graph.out).not.toMatch(/dangling/)
    const refs = [...graph.out.matchAll(/^(\S+)\s+(Component|Resource)\s/gm)].map(([, name, kind]) => `${String(kind).toLowerCase()}:default/${String(name)}`)
    expect(refs).toHaveLength(33)
    const marked: string[] = []
    for (const ref of refs) {
      const { out } = await run(['show', ref], { entities: withGroups() })
      const owner = out.split('\n').find((line) => line.startsWith('  owner '))
      if (owner?.endsWith('declared nowhere in the catalogue this token reads') === true) marked.push(owner)
    }
    expect(marked).toHaveLength(13)
    expect(new Set(marked)).toEqual(
      new Set(['  owner        group:default/common  declared nowhere in the catalogue this token reads']),
    )
  })

  it('blames the catalogue, not a repository, when it serves no entity', async () => {
    const { code, err } = await run(['graph'], { entities: [] })
    expect(code).toBe(1)
    expect(err.trimEnd().split('\n').at(-1)).toBe(
      'the Backstage catalogue at 127.0.0.1:7007 serves no entity this token reads; IDP_BACKSTAGE_URL names it',
    )
  })

  it('refuses a question, exit 2 before any request, when the repository a change would use is misconfigured', async () => {
    // The one proof of 1.2's placement of `declarationsFor` before `provider.load()`.
    const client = scripted({})
    const { code, out, err, sent } = await run(['who owns billing-api?'], {
      env: { IDP_BACKSTAGE_URL: LOOPBACK, IDP_REPO: 'relative' },
      client,
    })
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toMatch(/^IDP_REPO=relative is relative/)
    expect(sent).toEqual([])
    expect(client.seen).toEqual([])
  })
})

describe('a reference the catalogue does not serve', () => {
  const PHRASE = 'declared nowhere in the catalogue this token reads'
  const owner = (): Item[] => catalogueOf(OWNER)
  const NETWORK = 'resource:default/billing-api-to-payments'
  const BILLING = 'component:default/billing-api'

  it('reads "declared nowhere in the catalogue this token reads" on show and relations', async () => {
    const shown = await run(['show', 'billing-api-to-payments'], { entities: owner() })
    expect(shown.code).toBe(0)
    expect(shown.out).toContain(PHRASE)
    const related = await run(['relations', 'billing-api'], { entities: owner() })
    expect(related.out).toContain(PHRASE)
    // The same references read from a repository still read as they did.
    for (const argv of [['show', 'billing-api-to-payments'], ['relations', 'billing-api']]) {
      const files = await run([...argv, '--repo', OWNER], { env: {} })
      expect(files.out).toContain('declared nowhere')
      expect(files.out).not.toContain('catalogue this token')
    }
  })

  it('reads it in an answer too: an entity, and a relations block', async () => {
    const entity = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [calling('get_entity', { ref: NETWORK }), calling('answer', { outcome: 'entities', refs: [NETWORK] })],
    })
    const card = await run(['what is billing-api-to-payments?'], { entities: owner(), client: entity })
    expect(card.code, card.err).toBe(0)
    expect(card.out).toContain(PHRASE)
    const relation = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('get_relations', { ref: BILLING, relation: 'consumes' }),
        calling('answer', { outcome: 'relation', ref: BILLING, relation: 'consumes' }),
      ],
    })
    const block = await run(['what does billing-api consume?'], { entities: owner(), client: relation })
    expect(block.code, block.err).toBe(0)
    expect(block.out).toContain(PHRASE)
  })
})

describe('when the catalogue is read', () => {
  it('reads it once, before the first model call, on both roads', async () => {
    const { repo, home } = await configured(LOOPBACK)
    const operations = JSON.parse(await readFile(path.join(EXAMPLES, 'open-network.json'), 'utf8')) as {
      intent: string
      operations: unknown[]
    }
    for (const [phrase, turns] of [
      ['which databases are in prod?', { supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] }],
      [
        operations.intent,
        {
          supervisor: [saying('MUTATION')],
          architect: [calling(PROPOSE_TOOL, { operations: operations.operations })],
          reviewer: [calling(VERDICT_TOOL, { verdict: 'ok' })],
        },
      ],
    ] as const) {
      const catalogue = fakeBackstage({ entities: withOrganisation() })
      const client = scripted(turns, () => catalogue.sent.length)
      const out: string[] = []
      const err: string[] = []
      const code = await main([phrase], {
        env: { HOME: home },
        cwd: await elsewhere(),
        catalogueFetch: catalogue.fetch,
        client,
        events: () => {},
        out: (chunk) => void out.push(chunk),
        err: (chunk) => void err.push(chunk),
      })
      expect(code, err.join('')).toBe(0)
      expect(client.seen.length).toBeGreaterThan(0)
      expect(client.seen[0]?.sentBefore).toBe(catalogue.sent.length)
      expect(catalogue.sent.filter((sent) => sent.url.includes('/entity-facets'))).toHaveLength(1)
      void repo
    }
  })

  it('never reads it for plan, nor for a phrase given --repo', async () => {
    const unread = unreached()
    const plan = await run(['plan', '--from', path.join(EXAMPLES, 'open-network.json'), '--repo', DEMO], {
      catalogueFetch: unread.fetch,
    })
    expect(plan.code).toBe(0)
    const phrase = await run(['which databases are in prod?', '--repo', DEMO], {
      catalogueFetch: unread.fetch,
      client: scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] }),
    })
    expect(phrase.code).toBe(0)
    expect(phrase.out).toMatch(/^Overview of the repository si-demo/)
    expect(unread.calls).toBe(0)
  })
})

describe('a change, with a catalogue configured', () => {
  const intent = (): Promise<{ intent: string; operations: unknown[] }> =>
    readFile(path.join(EXAMPLES, 'open-network.json'), 'utf8').then((text) => JSON.parse(text) as never)

  it('is decided against the configured repo, never the catalogue it was classified from', async () => {
    const { repo, home } = await configured(LOOPBACK)
    const example = await intent()
    const client = scripted({
      supervisor: [saying('MUTATION')],
      architect: [calling(PROPOSE_TOOL, { operations: example.operations })],
      reviewer: [calling(VERDICT_TOOL, { verdict: 'ok' })],
    })
    const entities = [...withOrganisation(), component('catalogue-only-canary', { owner: MARKER })]
    const { code, out, err } = await run([example.intent], { env: { HOME: home }, cwd: await elsewhere(), entities, client })
    expect(code, err).toBe(0)
    expect(out).toContain('+++ b/dependencies/network/orders-api-to-payments.yml')
    // The Supervisor was shown the catalogue; the Architect and the Reviewer the repository.
    expect(JSON.stringify(client.seen.filter((request) => request.agent === 'supervisor'))).toContain(MARKER)
    for (const agent of ['architect', 'reviewer'] as const) {
      const requests = client.seen.filter((request) => request.agent === agent)
      expect(requests.length, agent).toBeGreaterThan(0)
      expect(JSON.stringify(requests), agent).not.toContain(MARKER)
    }
    void repo
  })

  it('lets nothing in the catalogue vouch: an owner only the catalogue holds is asked, exit 3', async () => {
    const { home } = await configured(LOOPBACK)
    const client = scripted({
      supervisor: [saying('MUTATION')],
      architect: [
        calling(PROPOSE_TOOL, {
          operations: [
            {
              op: 'create-entity',
              entity: {
                kind: 'Resource',
                metadata: { name: 'ledger-db-prod', env: 'prod' },
                spec: { type: 'database', owner: MARKER },
              },
            },
          ],
        }),
      ],
    })
    const entities = [...withOrganisation(), component('catalogue-only-canary', { owner: MARKER })]
    const { code, out } = await run(['declare the database ledger-db-prod in prod'], {
      env: { HOME: home },
      cwd: await elsewhere(),
      entities,
      client,
    })
    expect(code).toBe(3)
    expect(out).toContain('spec.owner')
  })

  it('is refused with a catalogue and no repository, in planNeedsRepository’s words', async () => {
    const client = scripted({ supervisor: [saying('MUTATION')] })
    const { code, err, sent } = await run(['let reporting-worker read orders-db-prod'], { cwd: await elsewhere(), client })
    expect(code).toBe(2)
    // The question side read the catalogue before the Supervisor called it a change.
    expect(sent.length).toBeGreaterThan(0)
    expect(err).toContain('that is a change request, and it needs a declarations repository')
    expect(err).toContain('never against the catalogue')
  })
})

describe('a read that fails', () => {
  const lowered = (limits: Partial<BackstageLimits>): Pick<MainDeps, 'catalogueLimits'> => ({ catalogueLimits: limits })
  const refused: CatalogueFetch = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7007'), { code: 'ECONNREFUSED' }) })
  }

  const FAILURES: Array<[string, Options, string]> = [
    ['401', { faults: { status: { at: 0, status: 401 } } }, 'refused the token (401): IDP_BACKSTAGE_TOKEN is not set, and this catalogue asks for one'],
    ['403', { faults: { status: { at: 0, status: 403 } } }, 'refused the read (403): the token may not read the catalogue (catalog.entity.read)'],
    ['404 on the first request', { faults: { status: { at: 0, status: 404 } } }, `answered 404: ${LOOPBACK} is not a catalogue API base (expected ${LOOPBACK}/entities/by-query)`],
    ['429 with no Retry-After', { faults: { status: { at: 0, status: 429 } } }, 'limited the rate of requests (429) past what a run waits for'],
    ['500', { faults: { status: { at: 1, status: 500 } } }, 'failed (500)'],
    ['a hang', { faults: { hang: { at: 1 } }, ...lowered({ requestMs: 50 }) }, 'did not answer a request within 0.05 s'],
    ['301', { faults: { status: { at: 0, status: 301, headers: { location: 'https://evil.example/' } } } }, 'answered with a redirect (301), which is never followed'],
    ['302', { faults: { status: { at: 1, status: 302, headers: { location: 'https://evil.example/' } } } }, 'answered with a redirect (302), which is never followed'],
    ['307', { faults: { status: { at: 1, status: 307, headers: { location: 'https://evil.example/' } } } }, 'answered with a redirect (307), which is never followed'],
    ['a foreign url', { faults: { responseUrl: { at: 1, url: 'https://evil.example/api/catalog/entities/by-query' } } }, 'answered from another address than the one asked, which is refused'],
    ['over the byte bound', { faults: { bytes: { at: 1, size: 2048 } }, ...lowered({ bytesPerResponse: 1024 }) }, 'sent a response larger than 1024 bytes'],
    ['non-JSON', { faults: { notJson: { at: 1 } } }, 'answered with a body that is not UTF-8 JSON'],
    ['a cursor loop', { faults: { nextCursor: 'again' } }, 'returned the same page twice'],
    ['fewer than totalItems', { faults: { totalItemsAbove: 1 } }, 'changed while it was read (34 expected, 33 read)'],
    ['more modelled entities than a run reads', lowered({ modelledEntities: 20 }), 'holds more than 20 Components, Resources and APIs as this token reads it; this version reads at most 20 and does not answer from part of a catalogue'],
    ['unreachable', { catalogueFetch: refused }, 'could not be reached (ECONNREFUSED)'],
  ]

  it.each(FAILURES)('%s: one classified line, exit 1, nothing on stdout', async (_, options, why) => {
    const { code, out, err } = await run(['graph'], { client: untouchable, ...options })
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toBe(`the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL) ${why}${WAY_OUT}`)
  })

  it('waits for a 429 that says how long, as many times as a run may, then fails on the next', async () => {
    let requests = 0
    const limited: CatalogueFetch = async () => {
      requests += 1
      return new Response(null, { status: 429, headers: { 'retry-after': '0' } })
    }
    const { code, out, err } = await run(['graph'], { client: untouchable, catalogueFetch: limited })
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toBe(
      `the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL) limited the rate of requests (429) past what a run waits for${WAY_OUT}`,
    )
    // The first request, then one per retry the run has.
    expect(requests).toBe(BACKSTAGE_LIMITS.retriesPerRun + 1)
  })

  it('names what named the catalogue, and whether a token was sent', async () => {
    const { home } = await configured(REMOTE)
    const { code, err } = await run(['graph'], {
      env: { HOME: home, IDP_BACKSTAGE_TOKEN: TOKEN },
      token: 'another-token',
      cwd: await elsewhere(),
    })
    expect(code).toBe(1)
    expect(err).toBe(
      'the Backstage catalogue at backstage.acme.example (~/.config/idp-agent/config.yml) refused the token (401): ' +
        `IDP_BACKSTAGE_TOKEN is set and not accepted${WAY_OUT}`,
    )
  })

  it('fails a phrase whichever road it would take: idpa "<change>" with the catalogue unreachable', async () => {
    const { home } = await configured(LOOPBACK)
    const { code, out, err } = await run(['let reporting-worker read orders-db-prod'], {
      env: { HOME: home },
      cwd: await elsewhere(),
      catalogueFetch: refused,
      client: untouchable,
    })
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toBe(`the Backstage catalogue at 127.0.0.1:7007 (~/.config/idp-agent/config.yml) could not be reached (ECONNREFUSED)${WAY_OUT}`)
  })
})

describe('the trace of a run that read a catalogue', () => {
  it('records the source as root attributes, and never the token', async () => {
    const sink = memorySink()
    const { code } = await run(['which databases are in prod?'], {
      env: { IDP_BACKSTAGE_URL: REMOTE, IDP_BACKSTAGE_TOKEN: TOKEN },
      token: TOKEN,
      cwd: await elsewhere(),
      traceSinks: [sink],
      client: scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] }),
    })
    expect(code).toBe(0)
    const trace = onlyTrace(sink)
    const root = trace.spans[0]?.attributes ?? {}
    expect(root).toMatchObject({
      'idp.source.kind': 'backstage',
      'idp.source.origin': REMOTE,
      // The organisation is read, not set aside: its read replaces the refs read.
      'idp.source.entities': 40,
      'idp.source.set_aside': 0,
      'idp.source.pages': 2,
    })
    expect(root['idp.source.bytes']).toBeGreaterThan(0)
    expect(typeof root['idp.source.ms']).toBe('number')
    const text = JSON.stringify(trace, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))
    expect(text).not.toContain(TOKEN)
  })

  it('adds no source attribute for a repository or the demo SI', async () => {
    const sink = memorySink()
    await run(['which databases are in prod?', '--demo'], {
      env: {},
      traceSinks: [sink],
      client: scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] }),
    })
    const root = onlyTrace(sink).spans[0]?.attributes ?? {}
    expect(Object.keys(root).filter((key) => key.startsWith('idp.source.'))).toEqual([])
  })
})
