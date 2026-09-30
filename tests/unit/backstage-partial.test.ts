import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import type { PartialRead } from '../../src/context/provider.js'
import type { Entity, OrganisationEntity } from '../../src/core/schemas/entity.js'
import { readValue } from '../../src/core/yaml/serialize.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults, type Sent } from '../support/fake-backstage.js'
import { memorySink, onlyTrace } from '../support/trace.js'

/**
 * A catalogue past a bound of this version, read in part and said so
 * (docs/plans/backstage-http-slice-2.md, Task 2.1; ADR-0013). What a bound
 * left out is not loaded, a state beside declared nowhere: a reference into
 * it is never called dangling, and every answer from a partial graph says it
 * is partial — only then, so a whole read prints and sends what it did.
 */

const MODELLED: PartialRead = { scope: 'modelled', kinds: ['component', 'resource', 'api'], read: 2, total: 5, limit: 2 }
const ORGANISATION_READ: PartialRead = { scope: 'organisation', kinds: ['group', 'system'], read: 1, total: 4, limit: 1 }

const service = (name: string, spec: Record<string, unknown> = {}): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, annotations: {} },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger', ...spec },
})

const WORKER_DEPENDING_ON_MISSING_DB = service('worker', { dependsOn: ['resource:default/missing-db'] })

/** A node of the organisation, read as the reader reads one. */
const organisationNode = (value: Record<string, unknown>): OrganisationEntity => {
  const reading = readValue(value)
  if (reading.as !== 'organisation') throw new Error(`not an organisation node: ${reading.as}`)
  return reading.entity
}

const TIGER = organisationNode({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name: 'tiger' },
  spec: { type: 'team', children: [] },
})

/** Another Group: the source holds one, and not the one the owner names. */
const TIGER_CUB = organisationNode({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name: 'tiger-cub' },
  spec: { type: 'team', children: [] },
})

describe('a graph read in part', () => {
  it('calls a reference into a bounded kind not loaded, and never dangling', () => {
    const graph = EntityGraph.from([WORKER_DEPENDING_ON_MISSING_DB], [], undefined, [MODELLED])
    expect(graph.danglingReferences()).toEqual([])
    expect(graph.unresolvedOf('component:default/worker')).toEqual([])
    expect(graph.notLoadedOf('component:default/worker', 'dependsOn')).toEqual([
      { from: 'component:default/worker', field: 'dependsOn', to: 'resource:default/missing-db' },
    ])
    expect(graph.notLoadedOf('component:default/worker', 'dependencyOf')).toEqual([])
    expect(graph.notLoadedOf('component:default/worker')).toHaveLength(1)
    expect(graph.partial).toEqual([MODELLED])
  })

  it('still calls a reference into a kind read whole declared nowhere: a template the catalogue does not hold', () => {
    const worker = service('worker', { dependsOn: ['template:default/scaffolder', 'resource:default/missing-db'] })
    const graph = EntityGraph.from([worker], [], undefined, [MODELLED])
    expect(graph.danglingReferences()).toEqual([{ from: 'component:default/worker', to: 'template:default/scaffolder' }])
    expect(graph.notLoadedReferences()).toEqual([
      { from: 'component:default/worker', field: 'dependsOn', to: 'resource:default/missing-db' },
    ])
  })

  it('is whole, with no not-loaded reference, when built with no partial read, as every graph on 55fb995 is', () => {
    const graph = EntityGraph.from([WORKER_DEPENDING_ON_MISSING_DB])
    expect(graph.partial).toEqual([])
    expect(graph.notLoadedReferences()).toEqual([])
    expect(graph.notLoadedOf('component:default/worker')).toEqual([])
    expect(graph.danglingReferences()).toEqual([{ from: 'component:default/worker', to: 'resource:default/missing-db' }])
    expect(EntityGraph.from([WORKER_DEPENDING_ON_MISSING_DB], [], undefined, []).danglingReferences()).toHaveLength(1)
  })

  it('leaves an owner naming no Group a name when the organisation read was bounded: not judged', () => {
    const orphan = service('orphan', { owner: 'group:default/nobody' })
    // The load judges nothing of a bounded organisation read (`Served.judged`).
    const graph = EntityGraph.from([orphan], [], { nodes: [TIGER], judged: new Set() }, [ORGANISATION_READ])
    expect(graph.unresolvedOrganisationOf('component:default/orphan', 'owner')).toEqual([])
    expect(graph.unreadOrganisationOf('component:default/orphan', 'owner')).toEqual([
      { from: 'component:default/orphan', field: 'owner', to: 'group:default/nobody', kind: 'Group', judged: false },
    ])
    expect(graph.notLoadedReferences()).toEqual([])
  })

  it('calls a dependsOn naming a System not loaded when the organisation read was bounded', () => {
    const worker = service('worker', { dependsOn: ['system:default/payments', 'group:default/tiger'] })
    const graph = EntityGraph.from([worker], [], { nodes: [TIGER], judged: new Set() }, [ORGANISATION_READ])
    // The Group read resolves; the System the bounded read did not reach is not loaded.
    expect(graph.danglingReferences()).toEqual([])
    expect(graph.notLoadedOf('component:default/worker', 'dependsOn').map(({ to }) => to)).toEqual(['system:default/payments'])
  })

  it('keeps a reference the grammar cannot split declared nowhere, whatever kind it starts with', () => {
    // `providesApis` keeps what it cannot split as written: no served entity is ever called that.
    const worker = service('worker', { providesApis: ['api:Bad Name!', 'api:Bad/Name!'] })
    const graph = EntityGraph.from([worker], [], undefined, [MODELLED])
    expect(graph.notLoadedReferences()).toEqual([])
    expect(graph.danglingReferences()).toEqual(EntityGraph.from([worker]).danglingReferences())
    expect(graph.danglingReferences().map(({ to }) => to)).toEqual(['api:Bad Name!', 'api:Bad/Name!'])
  })

  it('tells the Analyst an owner is a name because Groups past the bound were not loaded, never that none is held', () => {
    const tools = (organisation: readonly OrganisationEntity[]) =>
      buildTools(
        EntityGraph.from([service('worker')], [], { nodes: organisation, judged: new Set() }, [ORGANISATION_READ]),
        { apis: true, organisation: true },
      )
    for (const held of [[], [TIGER_CUB]]) {
      const outcome = tools(held).run({ id: 'c', name: 'get_relations', args: { ref: 'component:default/worker', relation: 'owned-by' } })
      expect((outcome.result as Record<string, unknown>)['readAsNames']).toEqual([
        {
          ref: 'group:default/tiger',
          field: 'owner',
          declaredBy: 'component:default/worker',
          why: "read as a name: Groups past this version's bound of 1 were not loaded",
        },
      ])
    }
  })

  it('lists notLoadedReferences() in the order danglingReferences() would have', () => {
    const entities = [
      service('b-worker', { dependsOn: ['resource:default/z-db', 'resource:default/a-db'], providesApis: ['api:default/gone'] }),
      service('a-worker', { dependsOn: ['component:default/missing'] }),
    ]
    const whole = EntityGraph.from(entities).danglingReferences()
    const partial = EntityGraph.from(entities, [], undefined, [MODELLED]).notLoadedReferences()
    expect(partial.map(({ from, to }) => ({ from, to }))).toEqual(whole)
    expect(partial.map(({ field }) => field)).toEqual(['dependsOn', 'dependsOn', 'providesApis', 'dependsOn'])
  })

  it('names the services along a consumers walk that were not loaded, as unresolvedConsumersOf names those declared nowhere', () => {
    const db = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'orders-db', annotations: {} },
      spec: { type: 'database', owner: 'group:default/tiger' },
    } as Entity
    const grant = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'orders-db-access', annotations: {} },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/orders-db'],
        dependencyOf: ['component:default/scale-00009'],
      },
    } as Entity
    const graph = EntityGraph.from([db, grant], [], undefined, [MODELLED])
    expect(graph.unresolvedConsumersOf('resource:default/orders-db')).toEqual([])
    expect(graph.notLoadedConsumersOf('resource:default/orders-db')).toEqual([
      { from: 'resource:default/orders-db-access', field: 'dependencyOf', to: 'component:default/scale-00009' },
    ])
  })
})

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const GOLDEN = path.resolve(import.meta.dirname, '../golden/demo-read')
const ORG_YAML = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'

type Item = Record<string, unknown>

/** The demo SI, its organisation, and 12 generated Components: 45 modelled, 40 read under the lowered bound. */
const scaled = (): Item[] => catalogueOf(DEMO, { org: ORG_YAML, scale: 12 })
const BOUND = { modelledEntities: 40 }

interface Ran {
  code: number
  out: string
  err: string
  sent: Sent[]
}

const run = async (
  argv: string[],
  options: MainDeps & { entities?: readonly Item[]; faults?: Faults; bounded?: boolean } = {},
): Promise<Ran> => {
  const { entities = scaled(), faults, bounded = true, ...deps } = options
  const catalogue = fakeBackstage({ entities, ...(faults === undefined ? {} : { faults }) })
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    root: DEMO,
    env: { IDP_BACKSTAGE_URL: LOOPBACK },
    catalogueFetch: catalogue.fetch,
    events: () => {},
    ...(bounded ? { catalogueLimits: BOUND } : {}),
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join(''), sent: catalogue.sent }
}

/** What `--demo` prints for the same command: the whole read's bytes. */
const demoOut = async (argv: string[]): Promise<string> => {
  const out: string[] = []
  await main([...argv, '--demo'], { root: DEMO, env: {}, events: () => {}, out: (chunk) => void out.push(chunk), err: () => {} })
  return out.join('')
}

const calling = (name: string, args: unknown, id = `c-${name}`): GenerateResult => ({
  text: '',
  toolCalls: [{ id, name, args }],
  finishReason: 'tool-calls',
})
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

/** Scripted turns per agent; every request kept. */
const scripted = (turns: Partial<Record<AgentName, readonly GenerateResult[]>>): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request) => {
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? saying('')
    },
  }
}

const PARTIAL = "5 Components, Resources and APIs were not loaded, past this version's bound of 40"
const PAST_LINE =
  "past the bound: 5 Components, Resources and APIs, beyond this version's bound of 40, were not loaded; " +
  'the graph is partial, and a reference to one of them is not loaded, never declared nowhere'
const lines = (text: string): string[] => text.split('\n')

describe('what a person reads of a catalogue past a bound', () => {
  it('answers, and says what was left out on the notice and on a line of its own', async () => {
    const { code, err } = await run(['show', 'billing-api'])
    expect(code).toBe(0)
    const [notice, next] = lines(err)
    expect(notice).toBe(
      'reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 52 entities: 47 read, 0 not modelled, ' +
        '5 past the bound; it may lag the declarations repository by minutes; --repo <directory> reads a repository',
    )
    expect(next).toBe(PAST_LINE)
    // `not loaded:` stays the line of the kinds this tool does not model, and there is none here.
    expect(lines(err).filter((line) => line.startsWith('not loaded:'))).toEqual([])
  })

  it('prints the line of the kinds not modelled as it always did, then the bound’s', async () => {
    const locations = Array.from({ length: 3 }, (_, at) => ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Location',
      metadata: { name: `location-${String(at)}`, namespace: 'default', uid: `10000000-0000-4000-8000-${String(at).padStart(12, '0')}` },
      spec: { type: 'url', target: `https://github.com/acme/repo-${String(at)}/blob/main/catalog-info.yaml` },
    }))
    const { code, err } = await run(['graph'], { entities: [...scaled(), ...locations] })
    expect(code).toBe(0)
    const said = lines(err)
    const at = said.indexOf('not loaded: 3 documents this tool does not model (Location ×3)')
    expect(at).toBeGreaterThan(0)
    expect(said[at + 1]).toBe(PAST_LINE)
  })

  it('says a total it does not know is not known: a server that served more than it announced', async () => {
    const { code, err } = await run(['graph'], {
      entities: catalogueOf(DEMO, { scale: 12 }),
      faults: { totalItemsAbove: -10 },
    })
    expect(code).toBe(0)
    const [notice, next] = lines(err)
    expect(notice).toContain('(IDP_BACKSTAGE_URL): at least 41 entities: 40 read, 0 not modelled, at least 1 past the bound; ')
    expect(next).toBe(
      "past the bound: Components, Resources and APIs beyond this version's bound of 40 were not loaded, how many is not known; " +
        'the graph is partial, and a reference to one of them is not loaded, never declared nowhere',
    )
  })

  it('lists on graph what names what was not loaded, and closes on the partial line', async () => {
    const { code, out } = await run(['graph'])
    expect(code).toBe(0)
    const table = lines(out).slice(0, 41)
    expect(table).toHaveLength(41)
    expect(table.filter((line) => line.startsWith('scale-'))).toHaveLength(7)
    expect(out).not.toContain('dangling')
    expect(out.endsWith(
      '\n\n1 reference names what was not loaded:\n' +
        '  component:default/scale-00007 -> component:default/scale-00008\n\n' +
        `partial: ${PARTIAL}; what they declare is not in this table\n`,
    )).toBe(true)
  })

  /**
   * The demo SI, 60 generated Components, and two read first by uid: a
   * service depending on 30 of those past the bound, and a grant of
   * billing-db-prod's to one of them — 40 read, 32 references not loaded.
   */
  const wide = (): Item[] => [
    ...catalogueOf(DEMO, { org: ORG_YAML, scale: 60 }),
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'fan-out', namespace: 'default', uid: '00000000-0000-4000-8000-00000000000a' },
      spec: {
        type: 'service',
        lifecycle: 'production',
        owner: 'group:default/tiger',
        dependsOn: Array.from({ length: 30 }, (_, at) => `component:default/scale-${String(20 + at).padStart(5, '0')}`),
      },
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: 'scale-00030-billing-db-prod',
        namespace: 'default',
        uid: '00000000-0000-4000-8000-00000000000b',
        annotations: { 'company.fr/env': 'prod' },
      },
      spec: {
        type: 'database-access',
        access: 'read',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/billing-db-prod'],
        dependencyOf: ['component:default/scale-00030'],
      },
    },
  ]

  it('lists on graph at most 25 references to what was not loaded, then how many more', async () => {
    const { code, out } = await run(['graph'], { entities: wide() })
    expect(code).toBe(0)
    const [listed] = out.split('\n\n').filter((block) => block.includes('name what was not loaded:'))
    const rows = lines(listed ?? '')
    expect(rows[0]).toBe('32 references name what was not loaded:')
    expect(rows).toHaveLength(27)
    expect(rows.slice(1, 26).every((row) => /^ {2}\S+ -> \S+$/.test(row))).toBe(true)
    expect(rows[26]).toBe('  +7 more')
  })

  it('lists on an overview at most five references past the bound, then how many more', async () => {
    const client = scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] })
    const { code, out } = await run(['ask', 'describe the catalogue'], { client, entities: wide() })
    expect(code).toBe(0)
    const block = out.split('\n\n').find((each) => each.startsWith('past the bound'))
    const rows = lines((block ?? '').trimEnd())
    expect(rows[0]).toBe('past the bound  32')
    expect(rows).toHaveLength(7)
    expect(rows[6]).toBe('  +27 more')
  })

  it('marks a service past the bound not loaded among those a database is reached by', async () => {
    const { code, out } = await run(['show', 'billing-db-prod'], { entities: wide() })
    expect(code).toBe(0)
    const [reached] = out.split('\n\n').filter((block) => block.startsWith('reached by services'))
    expect(lines(reached ?? '')).toContainEqual(expect.stringMatching(/^ {2}component:default\/scale-00030 +not loaded$/))
    expect(out).not.toContain('declared nowhere')
  })

  it('marks a reference past the bound not loaded on show, and closes on the partial line', async () => {
    const { code, out } = await run(['show', 'scale-00007'])
    expect(code).toBe(0)
    expect(out).toContain('depends on\n  component:default/scale-00008  not loaded\n')
    expect(out).not.toContain('declared nowhere')
    expect(lines(out.trimEnd()).at(-1)).toBe(`partial: ${PARTIAL}; what they declare is not in these sections`)
  })

  it('prints show billing-api as the golden, then the one partial line and nothing else', async () => {
    const golden = await readFile(path.join(GOLDEN, 'show-billing-api.txt'), 'utf8')
    const { code, out } = await run(['show', 'billing-api'])
    expect(code).toBe(0)
    expect(out).toBe(`${golden.trimEnd()}\n\npartial: ${PARTIAL}; what they declare is not in these sections\n`)
  })

  it('names the part it looked in when show finds nothing', async () => {
    const { code, out } = await run(['show', 'scale-00011'])
    expect(code).toBe(1)
    expect(out).toBe(`No entity named "scale-00011" in the part of the catalogue read: ${PARTIAL}.\n`)
  })

  it('says an owner and a membership are names because the Groups past the bound were not loaded', async () => {
    const served = (uid: string, value: Item): Item => ({
      ...value,
      metadata: { ...(value['metadata'] as Item), namespace: 'default', uid },
    })
    // Users first by uid, the Group past a bound of 2.
    const users = ['ada', 'bob'].map((name, at) =>
      served(`00000000-0000-4000-8000-00000000000${String(at + 1)}`, {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'User',
        metadata: { name },
        spec: { memberOf: ['group:default/tiger'] },
      }),
    )
    const tiger = served('fffffff0-0000-4000-8000-000000000000', {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Group',
      metadata: { name: 'tiger' },
      spec: { type: 'team', children: [] },
    })
    const options = {
      entities: [...catalogueOf(DEMO), ...users, tiger],
      bounded: false,
      catalogueLimits: { organisationEntities: 2 },
    }
    const why = "is read as a name here: Groups past this version's bound of 2 were not loaded"
    const owned = await run(['relations', 'billing-api', '--owned-by'], options)
    expect(owned.out).toContain(`none: group:default/tiger, the owner billing-api names, ${why}\n`)
    const member = await run(['relations', 'ada', '--member-of'], options)
    expect(member.out).toContain(`none: group:default/tiger, the group ada names, ${why}\n`)
    // A part that holds a Group of that kind is still no declarations repository.
    const held = await run(['relations', 'billing-api', '--owned-by'], {
      ...options,
      entities: [...catalogueOf(DEMO), ...users, tiger, served('00000000-0000-4000-8000-000000000000', { ...tiger, metadata: { name: 'tiger-cub' } })],
      catalogueLimits: { organisationEntities: 3 },
    })
    expect(held.out).toContain("none: group:default/tiger, the owner billing-api names, is read as a name here: Groups past this version's bound of 3 were not loaded\n")
    for (const { out } of [owned, member, held]) {
      expect(out).not.toContain('holds no')
      expect(out).not.toContain('declarations repository')
    }
  })

  it('words a count of one as one: a single entity past the bound', async () => {
    const { err, out } = await run(['show', 'billing-api'], { catalogueLimits: { modelledEntities: 44 }, bounded: false })
    expect(lines(err)[1]).toBe(
      "past the bound: 1 of the Components, Resources and APIs, beyond this version's bound of 44, was not loaded; " +
        'the graph is partial, and a reference to one of them is not loaded, never declared nowhere',
    )
    expect(lines(out.trimEnd()).at(-1)).toBe(
      "partial: 1 of the Components, Resources and APIs was not loaded, past this version's bound of 44; " +
        'what they declare is not in these sections',
    )
  })

  it('ends a relations path past the bound not loaded, and closes the block on the partial line', async () => {
    const { code, out } = await run(['relations', 'scale-00006', '--depends-on'])
    expect(code).toBe(0)
    expect(out).toMatch(/scale-00006 → scale-00007 → scale-00008 — not loaded/)
    expect(lines(out.trimEnd()).at(-1)).toBe(`partial: ${PARTIAL}; what they declare is not in these rows`)
  })

  it('prints relations mysql-prod-01 --impacts as --demo does, then the one closing line', async () => {
    const { code, out } = await run(['relations', 'mysql-prod-01', '--impacts'])
    expect(code).toBe(0)
    const whole = await demoOut(['relations', 'mysql-prod-01', '--impacts'])
    expect(out).toBe(`${whole.trimEnd()}\n\npartial: ${PARTIAL}; what they declare is not in these rows\n`)
  })

  it('opens an overview on the partial block, and lists the references past the bound apart from the dangling ones', async () => {
    const client = scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] })
    const { code, out } = await run(['ask', 'describe the catalogue'], { client })
    expect(code).toBe(0)
    const blocks = out.trimEnd().split('\n\n')
    expect(blocks[0]).toMatch(/^Overview of the Backstage catalogue at 127\.0\.0\.1:7007: 40 entities$/)
    expect(blocks[1]).toBe(
      "partial  40 of 45 Components, Resources and APIs read, this version's bound; every count below is of what was read",
    )
    expect(blocks).toContain('dangling references  none')
    expect(blocks).toContain('past the bound  1\n  component:default/scale-00007 → component:default/scale-00008')
    expect(blocks.some((block) => block.startsWith('not loaded'))).toBe(false)
  })

  it('names the part it looked in when a question finds nothing', async () => {
    const client = scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'nothing' })] })
    const { code, out } = await run(['ask', 'which service is called scale-00011?'], { client })
    expect(code).toBe(1)
    expect(out).toBe(`No entity matches that question in the part of the catalogue read: ${PARTIAL}.\n`)
  })

  it('closes a question’s relation block on the partial line, as relations does', async () => {
    const client = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('get_entity', { ref: 'component:default/scale-00006' }),
        calling('answer', { outcome: 'relation', ref: 'component:default/scale-00006', relation: 'depends-on' }),
      ],
    })
    const { code, out } = await run(['ask', 'what does scale-00006 depend on?', '--quiet'], { client })
    expect(code).toBe(0)
    expect(out).toContain('— not loaded')
    expect(lines(out.trimEnd()).at(-1)).toBe(`partial: ${PARTIAL}; what they declare is not in these rows`)
  })

  it('traces how many were past the bound, and 0 on a whole read', async () => {
    const turns = (): LlmClient =>
      scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] })
    const partial = memorySink()
    await run(['which databases are in prod?'], { client: turns(), traceSinks: [partial] })
    expect(onlyTrace(partial).spans[0]?.attributes).toMatchObject({ 'idp.source.not_loaded': 5 })
    const whole = memorySink()
    await run(['which databases are in prod?'], { client: turns(), traceSinks: [whole], bounded: false })
    expect(onlyTrace(whole).spans[0]?.attributes).toMatchObject({ 'idp.source.not_loaded': 0 })
  })

  it.each([
    [['graph']],
    [['show', 'billing-api']],
    [['show', 'no-such-entity']],
    [['relations', 'mysql-prod-01', '--impacts']],
    [['relations', 'billing-api']],
  ])('prints %j over the same catalogue read whole what --demo prints', async (argv) => {
    const { out, err } = await run(argv, { entities: catalogueOf(DEMO, { org: ORG_YAML }), bounded: false })
    expect(out).toBe(await demoOut(argv))
    expect(err).not.toContain('past the bound')
    expect(out).not.toContain('partial')
  })
})

/** Every request's bytes, as a provider would be sent them. */
const bytesOf = (seen: readonly GenerateRequest[]): string[] => seen.map((request) => JSON.stringify(request))

/** The opening message an agent was sent: its first turn's text. */
const opening = (request: GenerateRequest | undefined): string => JSON.stringify(request?.transcript[0] ?? null)

const READ_IN_PART =
  "The catalogue was read in part: Components, Resources and APIs past this version's bound of 40 were not loaded; " +
  'a reference to one is not loaded, never declared nowhere.'

describe('what a model is sent about a catalogue past a bound', () => {
  const asked = () =>
    scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('get_entity', { ref: 'component:default/scale-00007' }),
        calling('answer', {
          outcome: 'entities',
          refs: ['component:default/scale-00007'],
          conclusion: 'It depends on component:default/scale-00008, which was not loaded.',
        }),
      ],
    })

  it('tells the Supervisor and the Analyst, after the vocabulary, that the catalogue was read in part', async () => {
    const client = asked()
    const { code } = await run(['ask', 'what does scale-00007 depend on?'], { client })
    expect(code).toBe(0)
    const supervisor = client.seen.find(({ agent }) => agent === 'supervisor')
    const analyst = client.seen.find(({ agent }) => agent === 'analyst')
    for (const request of [supervisor, analyst]) {
      const text = opening(request)
      expect(text).toContain(READ_IN_PART)
      expect(text.indexOf(READ_IN_PART)).toBeGreaterThan(text.indexOf('  owners: '))
    }
  })

  it('puts what a row declares past the bound under notLoaded, never among the dangling references', async () => {
    const client = asked()
    await run(['ask', 'what does scale-00007 depend on?'], { client })
    const after = client.seen.filter(({ agent }) => agent === 'analyst')[1]
    const text = JSON.stringify(after?.transcript ?? [])
    expect(text).toContain('"notLoaded":["component:default/scale-00008"]')
    expect(text).not.toContain('danglingReferences')
  })

  it('lets a sentence name a reference past the bound once a row showed it, as it lets one declared nowhere', async () => {
    const { code, out } = await run(['ask', 'what does scale-00007 depend on?'], { client: asked() })
    expect(code).toBe(0)
    expect(out).toContain('› It depends on component:default/scale-00008, which was not loaded.')
    // The card closes on the partial line, as show's does, before the model's words.
    expect(out).toContain(`\n\npartial: ${PARTIAL}; what they declare is not in these sections\n\n› It depends on`)
  })

  it('sends over the same catalogue read whole what a run over the demo SI sends: no partial line, no notLoaded', async () => {
    const whole = asked()
    await run(['ask', 'what does orders-api depend on?'], { client: whole, entities: catalogueOf(DEMO), bounded: false })
    const demo = asked()
    await main(['ask', 'what does orders-api depend on?', '--demo'], {
      root: DEMO,
      env: {},
      events: () => {},
      client: demo,
      out: () => {},
      err: () => {},
    })
    expect(bytesOf(whole.seen)).toEqual(bytesOf(demo.seen))
    for (const text of bytesOf(whole.seen)) {
      expect(text).not.toContain('read in part')
      expect(text).not.toContain('notLoaded')
    }
  })
})
