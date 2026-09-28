import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, type MainDeps } from '../../src/cli/index.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import { overviewOf } from '../../src/context/graph/overview.js'
import { summariseGraph } from '../../src/context/graph/summary.js'
import type { GraphNode, OrganisationKind } from '../../src/core/schemas/entity.js'
import { readValue } from '../../src/core/yaml/serialize.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

const ORGANISATION = path.resolve(import.meta.dirname, '../golden/organisation')
const BACKSTAGE_APIS = path.resolve(import.meta.dirname, '../golden/backstage-apis')
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'

const EVERY_KIND: readonly OrganisationKind[] = ['Group', 'User', 'System', 'Domain']

/**
 * The graph `main` builds over a folder: its entities, the refs it set aside,
 * and its organisation — judged as `judged` says, as the catalogue road judges
 * what it read whole; the file road judges nothing.
 */
const graphOf = async (
  root: string,
  options: { judged?: readonly OrganisationKind[]; without?: readonly string[]; aside?: readonly string[] } = {},
): Promise<EntityGraph> => {
  const loaded = await new FixtureProvider(root).load()
  const without = new Set(options.without ?? [])
  return EntityGraph.from(
    loaded.entities,
    [...loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])), ...(options.aside ?? [])],
    {
      nodes: (loaded.organisation ?? []).filter((node) => !without.has(refOf(node))),
      judged: new Set(options.judged ?? []),
    },
  )
}

/** The graph f8bcb43 built over a folder: every organisation document set aside, its ref kept. */
const asOnF8bcb43 = async (root: string): Promise<EntityGraph> => {
  const loaded = await new FixtureProvider(root).load()
  return EntityGraph.from(loaded.entities, [
    ...loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
    ...(loaded.organisation ?? []).map(refOf),
  ])
}

const refs = (nodes: readonly GraphNode[]): string[] => nodes.map(refOf)

const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** One turn calling each tool of `calls`, as a model may: at most three a turn (`LOOP_LIMITS`). */
const calling = (...calls: Array<readonly [string, unknown]>): GenerateResult => ({
  text: '',
  toolCalls: calls.map(([name, args], at) => ({ id: `call-${String(at)}-${name}`, name, args })),
  finishReason: 'tool-calls',
})

/**
 * Every request a question sends, as `digestOf` hashes it, when the Analyst
 * searches every kind and reads every entity of the source — so each row
 * `search_entities` and `get_entity` can return is in a request, and so is the
 * summary both agents open on.
 */
async function sentOver(refs: readonly string[], deps: MainDeps & { argv?: string[] }): Promise<string[]> {
  const { argv = [], ...rest } = deps
  const turns: Partial<Record<AgentName, GenerateResult[]>> = {
    supervisor: [{ text: 'QUESTION', toolCalls: [], finishReason: 'stop' }],
    // Three searches, then every entity three at a time, within the Analyst's
    // four turns: a source of up to six entities is read whole.
    analyst: [
      calling(['search_entities', { kind: 'Component' }], ['search_entities', { kind: 'Resource' }], ['search_entities', { kind: 'API' }]),
      calling(...refs.slice(0, 3).map((ref) => ['get_entity', { ref }] as const)),
      calling(...refs.slice(3, 6).map((ref) => ['get_entity', { ref }] as const)),
      calling(['answer', { outcome: 'nothing' }]),
    ],
  }
  const spent = new Map<AgentName, number>()
  const sent: string[] = []
  const client: LlmClient = {
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      sent.push(`${request.agent}#${digest(JSON.stringify(request))}`)
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
  await main(['ask', 'what is declared here?', ...argv], {
    client,
    events: () => {},
    out: () => {},
    err: () => {},
    ...rest,
  })
  return sent
}

/** The stdout of a read command, hashed. */
async function printed(argv: string[], deps: MainDeps = {}): Promise<string> {
  const out: string[] = []
  await main(argv, { out: (chunk) => void out.push(chunk), err: () => {}, ...deps })
  return digest(out.join(''))
}

const APIS_REFS = [
  'api:default/billing',
  'api:default/payments',
  'resource:default/payments',
  'component:default/billing-api',
  'component:default/orders-api',
  'resource:default/orders-api-to-payments',
]

const ORGANISATION_REFS = [
  'resource:default/billing-db-prod',
  'component:default/billing-api',
  'component:default/checkout-web',
  'component:default/invoicing-worker',
  'resource:default/billing-api-billing-db-prod',
]

/** Measured on f8bcb43, before backstage-http slice 3, by the functions above. */
const ON_F8BCB43 = {
  apisSent: [
    'supervisor#sha256:6e078911b036e08df2bd4013ef75f95ae837bbe9e1d3761b6a8aae1b17830e08',
    'analyst#sha256:85b7bb91ae132ab86d63ae3e420f7a80474ff750f11a0cf51252754b24b3b8ac',
    'analyst#sha256:23c3c6a87f609328ba514cffbf68ab329d4226cd4e45a85504eddf68d38401a1',
    'analyst#sha256:85cf47d2e0876788791d9640f74c79daaa42c8c9b3a75224008438772be51e13',
    'analyst#sha256:4875ad45e6dddaf055653f64a7a3b3f47f06a7e3b0ca0eb10ec643373d837caa',
  ],
  apisGraph: 'sha256:cef7bda1ddfa2c773e7bd74e8f2f658d738b5c81e56127cb1f19575465d8c86b',
  apisPayments: 'sha256:5622848329daa9fdf1801e60a7f16aa6926fcf963cb7dd363e564db54a2483ca',
  // The same requests over the files and over the fake: the equivalence of § 9.
  organisationSent: [
    'supervisor#sha256:05dc98125b40dbac15b73a604c36355bd317d2e98e3333c89444ad0219daccda',
    'analyst#sha256:22dad2680d76923ea40ea1956b2cd92971840120537a2517abe31dd8bfaa166a',
    'analyst#sha256:6f641c7003119a5a9d73f471edf072bcc506a745c07c26aa4da436323830ce03',
    'analyst#sha256:9d9df8bbdc8fc8f649fee20ac503728824c56278deb3e3768df4f05ba65ba916',
    'analyst#sha256:af3be4b9a577f9d22afba3477433d57fa0b801b700a1d524e81daa38b05f26e0',
  ],
}

describe('the organisation beside the entities', () => {
  it('keeps all(), get(), search(), danglingReferences() and unresolvedOf(ref) of every graph exactly as they were without the organisation', async () => {
    for (const root of [ORGANISATION, BACKSTAGE_APIS, DEMO]) {
      const before = await asOnF8bcb43(root)
      for (const judged of [[], EVERY_KIND]) {
        const graph = await graphOf(root, { judged })
        expect(graph.all()).toEqual(before.all())
        expect(graph.size).toBe(before.size)
        expect(graph.search({})).toEqual(before.search({}))
        expect(graph.danglingReferences()).toEqual(before.danglingReferences())
        for (const entity of before.all()) {
          expect(graph.get(refOf(entity))).toEqual(before.get(refOf(entity)))
          expect(graph.unresolvedOf(refOf(entity))).toEqual(before.unresolvedOf(refOf(entity)))
          expect(graph.dependenciesOf(refOf(entity))).toEqual(before.dependenciesOf(refOf(entity)))
          expect(graph.dependantsOf(refOf(entity))).toEqual(before.dependantsOf(refOf(entity)))
        }
      }
    }
  })

  it('keeps the organisation out of all(): graph, the summary and the overview’s kinds do not see a Group', async () => {
    const graph = await graphOf(ORGANISATION, { judged: EVERY_KIND })
    const before = await asOnF8bcb43(ORGANISATION)
    expect(graph.all().map(({ kind }) => kind)).not.toContain('Group')
    expect(summariseGraph(graph)).toEqual(summariseGraph(before))
    expect(overviewOf(graph, { ignored: [], rejected: 0 }).kinds.map(({ name }) => name)).toEqual([
      'Component',
      'Resource',
    ])
    expect(graph.get('group:default/tiger')).toBeUndefined()
  })

  it('finds a node by reference with node(), an entity or a Group, and lists them all with nodes()', async () => {
    const graph = await graphOf(ORGANISATION)
    expect(graph.node('component:default/billing-api')?.kind).toBe('Component')
    expect(graph.node('group:default/tiger')?.kind).toBe('Group')
    expect(graph.node('group:default/lion')).toBeUndefined()
    expect(graph.holdsOrganisation).toBe(true)
    expect(refs(graph.nodes())).toEqual([
      ...refs(graph.all()),
      'domain:default/finance',
      'group:default/common',
      'group:default/engineering',
      'group:default/tiger',
      'system:default/billing',
      'user:default/ada',
      'user:default/grace',
    ])
    expect((await graphOf(DEMO)).holdsOrganisation).toBe(false)
  })

  it('reads a parent from both ends: children on engineering and parent on common are one edge each', async () => {
    const graph = await graphOf(ORGANISATION)
    expect(refs(graph.childrenOf('group:default/engineering'))).toEqual(['group:default/common', 'group:default/tiger'])
    // tiger names no parent: engineering's children say it.
    expect(refs(graph.parentsOf('group:default/tiger'))).toEqual(['group:default/engineering'])
    // common says it on both ends, and is listed once.
    expect(refs(graph.parentsOf('group:default/common'))).toEqual(['group:default/engineering'])
    expect(graph.parentsOf('group:default/engineering')).toEqual([])
  })

  it('reads membership from both ends: members on tiger and memberOf on ada are one', async () => {
    const graph = await graphOf(ORGANISATION)
    expect(refs(graph.membersOf('group:default/tiger'))).toEqual(['user:default/ada'])
    expect(refs(graph.groupsOf('user:default/ada'))).toEqual(['group:default/tiger'])
    // grace's group is declared nowhere: no node, so no member and no group.
    expect(graph.groupsOf('user:default/grace')).toEqual([])
  })

  it('lists what a Group, a User owns: every node whose owner names it, sorted', async () => {
    const graph = await graphOf(ORGANISATION)
    expect(refs(graph.ownedBy('group:default/tiger'))).toEqual([
      'component:default/billing-api',
      'resource:default/billing-api-billing-db-prod',
      'resource:default/billing-db-prod',
      'system:default/billing',
    ])
    expect(refs(graph.ownedBy('user:default/ada'))).toEqual(['component:default/checkout-web'])
    expect(refs(graph.ownedBy('group:default/engineering'))).toEqual(['domain:default/finance'])
    // An owner no node is: what names it is still listed, as a name.
    expect(refs(graph.ownedBy('group:default/lion'))).toEqual(['component:default/invoicing-worker'])
  })

  it('lists a System’s parts and a Domain’s Systems, and what holds a node', async () => {
    const graph = await graphOf(ORGANISATION)
    expect(refs(graph.partsOf('system:default/billing'))).toEqual([
      'component:default/billing-api',
      'component:default/invoicing-worker',
      'resource:default/billing-db-prod',
    ])
    expect(refs(graph.partsOf('domain:default/finance'))).toEqual(['system:default/billing'])
    expect(refs(graph.wholeOf('component:default/billing-api'))).toEqual(['system:default/billing'])
    expect(refs(graph.wholeOf('system:default/billing'))).toEqual(['domain:default/finance'])
    expect(graph.wholeOf('component:default/checkout-web')).toEqual([])
  })

  it('calls an owner naming no Group declared nowhere where Groups are judged, and nowhere else', async () => {
    const served = await graphOf(ORGANISATION, { judged: EVERY_KIND }) // as the catalogue road builds it
    expect(served.unresolvedOrganisationOf('component:default/invoicing-worker', 'owner')).toEqual([
      { from: 'component:default/invoicing-worker', field: 'owner', to: 'group:default/lion', sameName: [] },
    ])
    expect(served.unresolvedOrganisationOf('user:default/grace', 'memberOf')).toEqual([
      { from: 'user:default/grace', field: 'memberOf', to: 'group:default/ghost', sameName: [] },
    ])
    expect(served.unresolvedOrganisationOf('component:default/billing-api', 'owner')).toEqual([])
    // The file road.
    expect((await graphOf(ORGANISATION)).unresolvedOrganisationOf('component:default/invoicing-worker', 'owner')).toEqual([])
    // One Group file is not the organisation.
    expect((await graphOf(BACKSTAGE_APIS)).unresolvedOrganisationOf('api:default/payments', 'owner')).toEqual([])
    expect((await graphOf(DEMO)).danglingReferences()).toEqual([])
    // Never in the write model's list.
    expect(served.danglingReferences()).toEqual([])
    expect(served.unresolvedOf('component:default/invoicing-worker')).toEqual([])
  })

  it('judges an owner user:… only when Users are judged, and a system only when Systems are', async () => {
    const without = ['user:default/ada', 'system:default/billing']
    const groups = await graphOf(ORGANISATION, { judged: ['Group'], without })
    expect(groups.unresolvedOrganisationOf('component:default/checkout-web', 'owner')).toEqual([])
    expect(groups.unresolvedOrganisationOf('component:default/billing-api', 'system')).toEqual([])
    const all = await graphOf(ORGANISATION, { judged: EVERY_KIND, without })
    expect(all.unresolvedOrganisationOf('component:default/checkout-web', 'owner')).toEqual([
      { from: 'component:default/checkout-web', field: 'owner', to: 'user:default/ada', sameName: [] },
    ])
    expect(all.unresolvedOrganisationOf('component:default/billing-api', 'system')).toEqual([
      { from: 'component:default/billing-api', field: 'system', to: 'system:default/billing', sameName: [] },
    ])
    // An owner the organisation holds resolves, judged or not.
    expect(all.unresolvedOrganisationOf('domain:default/finance', 'owner')).toEqual([])
  })

  it('resolves a judged owner naming a Group set aside — of another namespace, in upper case, refused — against aside: never declared nowhere', async () => {
    const setAside = [
      { apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name: 'Lion' }, spec: { type: 'team', children: [] } },
      { apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name: 'lion' }, spec: { type: 'team' } },
    ].map((value) => {
      const read = readValue(value)
      return read.as === 'ignored' ? String(read.document.ref) : ''
    })
    expect(setAside).toEqual(['group:default/lion', 'group:default/lion'])
    for (const ref of setAside) {
      const graph = await graphOf(ORGANISATION, { judged: EVERY_KIND, aside: [ref] })
      expect(graph.unresolvedOrganisationOf('component:default/invoicing-worker', 'owner')).toEqual([])
    }
  })

  it('counts Groups read, not Groups set aside, as what a node() finds', async () => {
    const graph = await graphOf(DEMO, { judged: EVERY_KIND, aside: ['group:default/tiger'] })
    expect(graph.node('group:default/tiger')).toBeUndefined()
    expect(graph.holdsOrganisation).toBe(false)
    expect(graph.nodes()).toEqual(graph.all())
    // And no owner of the demo SI is declared nowhere for it: tiger is set aside, the rest judged.
    expect(graph.unresolvedOrganisationOf('component:default/billing-api', 'owner')).toEqual([])
  })

  it('does not call a dependsOn naming a Group dangling, as before', async () => {
    const [billing] = (await new FixtureProvider(ORGANISATION).load()).entities.filter(
      (entity) => refOf(entity) === 'component:default/billing-api',
    )
    const loaded = await new FixtureProvider(ORGANISATION).load()
    const consumer = { ...billing!, spec: { ...billing!.spec, dependsOn: ['group:default/tiger', 'group:default/nobody'] } }
    const graph = EntityGraph.from([consumer as typeof billing & object], [], {
      nodes: loaded.organisation ?? [],
      judged: new Set(EVERY_KIND),
    })
    expect(graph.danglingReferences()).toEqual([{ from: 'component:default/billing-api', to: 'group:default/nobody' }])
  })

  it('leaves graph’s dangling list, the show api:default/payments card and every search_entities and get_entity row over tests/golden/backstage-apis byte for byte', async () => {
    // Its Group file is read, lion is not judged, and no row gains a
    // danglingReferences entry: the rows and the summary are in the requests.
    expect(await sentOver(APIS_REFS, { argv: ['--repo', BACKSTAGE_APIS] })).toEqual(ON_F8BCB43.apisSent)
    expect(await printed(['graph', '--repo', BACKSTAGE_APIS])).toBe(ON_F8BCB43.apisGraph)
    expect(await printed(['show', 'api:default/payments', '--repo', BACKSTAGE_APIS])).toBe(
      ON_F8BCB43.apisPayments,
    )
  })

  it('leaves what a model is sent where it was over a source that holds and judges an organisation', async () => {
    // tests/golden/organisation read as files, and served by the fake: on
    // f8bcb43 its seven organisation documents were set aside, and the
    // requests are the ones they were. invoicing-worker's row carries no owner
    // among its danglingReferences, and declaredNowhere does not grow.
    expect(await sentOver(ORGANISATION_REFS, { argv: ['--repo', ORGANISATION] })).toEqual(
      ON_F8BCB43.organisationSent,
    )
    const served = await sentOver(ORGANISATION_REFS, {
      root: DEMO,
      env: { IDP_BACKSTAGE_URL: LOOPBACK },
      catalogueFetch: fakeBackstage({ entities: catalogueOf(ORGANISATION) }).fetch,
    })
    expect(served).toEqual(ON_F8BCB43.organisationSent)
  })
})
