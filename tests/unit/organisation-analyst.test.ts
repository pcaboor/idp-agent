import { createHash } from 'node:crypto'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { formatSummary } from '../../src/agents/summary.js'
import { buildTools, type ToolOutcome } from '../../src/agents/tools/graph-tools.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import type { CatalogueFetch } from '../../src/context/backstage/transport.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import { summariseGraph } from '../../src/context/graph/summary.js'
import {
  entitySchema,
  organisationSchema,
  type CatalogueEntity,
  type OrganisationEntity,
  type OrganisationKind,
} from '../../src/core/schemas/entity.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient, ModelToolSpec } from '../../src/llm/client.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * The Analyst over the organisation (backstage-http slice 3, 3.3): over a
 * source that holds Groups, Users, Systems or Domains it finds them, reads
 * them and walks the six organisation relations with the tools it has, under
 * the same caps; over a source that holds none, what it is sent is byte for
 * byte what it was on f8bcb43.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORGANISATION = path.resolve(import.meta.dirname, '../golden/organisation')
const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'
const EVERY_KIND: readonly OrganisationKind[] = ['Group', 'User', 'System', 'Domain']
const TIGER = 'group:default/tiger'
const BILLING_API = 'component:default/billing-api'

const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

/**
 * The graph `main` builds over a folder: the file road judges nothing; a
 * catalogue judges the kinds it read whole, which `judged` stands in for.
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

const call = (name: string, args: unknown) => ({ id: `c-${name}`, name, args })
const resultOf = (outcome: ToolOutcome): Record<string, unknown> => outcome.result as Record<string, unknown>
const rowsOf = (outcome: ToolOutcome): Array<Record<string, unknown>> =>
  resultOf(outcome)['rows'] as Array<Record<string, unknown>>
const specOf = (specs: readonly ModelToolSpec[], name: string): string =>
  JSON.stringify(z.toJSONSchema(specs.find((spec) => spec.name === name)!.parameters as z.ZodType, { io: 'input' }))

/**
 * A Group `many` with thirty Users and thirty Components it owns: past every
 * bound a row or a relation has.
 */
const crowded = (): EntityGraph => {
  const users: OrganisationEntity[] = Array.from({ length: 30 }, (_, at) =>
    organisationSchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: { name: `person-${String(at).padStart(2, '0')}` },
      spec: { memberOf: ['many'] },
    }),
  )
  const group = organisationSchema.parse({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name: 'many' },
    spec: { type: 'team', children: [] },
  })
  const components = Array.from({ length: 30 }, (_, at) =>
    entitySchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: `service-${String(at).padStart(2, '0')}` },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/many' },
    }),
  ) as CatalogueEntity[]
  return EntityGraph.from(components, [], { nodes: [group, ...users], judged: new Set(EVERY_KIND) })
}

const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })
const calling = (name: string, args: unknown, id = `c-${name}`): GenerateResult => ({
  text: '',
  toolCalls: [{ id, name, args }],
  finishReason: 'tool-calls',
})

/** Scripted turns per agent; every request kept as it was sent. */
const scripted = (
  turns: Partial<Record<AgentName, readonly GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
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

/** Measured on d6858d8, whose question requests prompt-digests.test.ts holds to f8bcb43's. */
const ON_F8BCB43 = {
  specs: 'sha256:806bac5675208d8a2c51712b8ea3788c28ed8f5892e127f2d9e4f354ce7033d0',
  system: 'sha256:c3de6ac1173e6e8eeab586ca94beac9e1b74a0b60799f9b9782458bb10419803',
  summary: 'sha256:80578063b59e3033149cbced4269029222f668a8acde5fadb30d86751a1b45dd',
}

describe('the Analyst over a source that holds no organisation', () => {
  it('is handed the specs, the system prompt and the summary of f8bcb43, byte for byte', async () => {
    const graph = await graphOf(DEMO)
    expect(digest(JSON.stringify(buildTools(graph, { apis: true }).specs))).toBe(ON_F8BCB43.specs)
    const { summary, vocabulary, counts } = summariseGraph(graph)
    expect(digest(formatSummary(summary, vocabulary, counts))).toBe(ON_F8BCB43.summary)

    const client = scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] })
    await main(['ask', 'what is there?', '--demo'], { client, env: {}, events: () => {}, out: () => {}, err: () => {} })
    const analyst = client.seen.find((request) => request.agent === 'analyst')
    expect(digest(analyst?.system ?? '')).toBe(ON_F8BCB43.system)
  })
})

describe('the Analyst over a source that holds an organisation', () => {
  it('advertises the four kinds in search_entities, and the six relations in get_relations and answer, only then', async () => {
    const graph = await graphOf(ORGANISATION)
    const { specs } = buildTools(graph, { apis: true, organisation: true })
    for (const kind of EVERY_KIND) expect(specOf(specs, 'search_entities')).toContain(`"${kind}"`)
    for (const relation of ['owns', 'owned-by', 'member-of', 'has-member', 'part-of', 'has-part']) {
      expect(specOf(specs, 'get_relations')).toContain(`"${relation}"`)
      expect(specOf(specs, 'answer')).toContain(`"${relation}"`)
      expect(specs.find((spec) => spec.name === 'answer')?.description).toContain(`"${relation}"`)
    }
    for (const name of ['search_entities', 'get_entity', 'get_relations']) {
      expect(specs.find((spec) => spec.name === name)?.description).toMatch(/Groups, Users, Systems and Domains/)
    }
    // The same graph without the option, and the demo SI with it as `ask`
    // sets it: the specs of f8bcb43.
    expect(digest(JSON.stringify(buildTools(graph, { apis: true }).specs))).toBe(ON_F8BCB43.specs)
    const demo = await graphOf(DEMO)
    expect(digest(JSON.stringify(buildTools(demo, { apis: true, organisation: demo.holdsOrganisation }).specs))).toBe(
      ON_F8BCB43.specs,
    )
  })

  it('says the organisation in one summary line, after resources, only when the graph holds one', async () => {
    const { summary, vocabulary, counts } = summariseGraph(await graphOf(ORGANISATION))
    const lines = formatSummary(summary, vocabulary, counts).split('\n')
    expect(lines.slice(3, 5)).toEqual([
      '  resources: 1-9',
      '  organisation: groups 1-9, users 1-9, systems 1-9, domains 1-9',
    ])
    const noDomain = summariseGraph(await graphOf(ORGANISATION, { without: ['domain:default/finance'] }))
    expect(formatSummary(noDomain.summary, noDomain.vocabulary, noDomain.counts)).toContain(
      '  organisation: groups 1-9, users 1-9, systems 1-9, domains 0\n',
    )
    const demo = summariseGraph(await graphOf(DEMO))
    expect(demo.summary).not.toHaveProperty('organisation')
  })

  it('finds a Group by kind and by name, its row bounded at 25 of each list, the cut stated', async () => {
    const { run } = buildTools(await graphOf(ORGANISATION), { apis: true, organisation: true })
    expect(rowsOf(run(call('search_entities', { kind: 'Group' }))).map(({ ref }) => ref)).toEqual([
      'group:default/common',
      'group:default/engineering',
      TIGER,
    ])
    expect(rowsOf(run(call('search_entities', { kind: 'Group', nameContains: 'tiger' })))).toEqual([
      {
        ref: TIGER,
        name: 'tiger',
        kind: 'Group',
        type: 'team',
        parent: ['group:default/engineering'],
        children: [],
        members: ['user:default/ada'],
        owns: [
          BILLING_API,
          'resource:default/billing-api-billing-db-prod',
          'resource:default/billing-db-prod',
          'system:default/billing',
        ],
      },
    ])
    // A name with no kind finds the organisation after the entities.
    expect(rowsOf(run(call('search_entities', { nameContains: 'billing' }))).map(({ ref }) => ref)).toEqual([
      'resource:default/billing-db-prod',
      BILLING_API,
      'resource:default/billing-api-billing-db-prod',
      'system:default/billing',
    ])

    const many = buildTools(crowded(), { apis: true, organisation: true })
    const [row] = rowsOf(many.run(call('get_entity', { ref: 'group:default/many' })))
    expect(row?.['members']).toHaveLength(25)
    expect(row?.['membersTruncated']).toBe('5 more not shown')
    expect(row?.['owns']).toHaveLength(25)
    expect(row?.['ownsTruncated']).toBe('5 more not shown')
  })

  it('refuses a kind nothing carries, naming the kinds in use, the organisation’s included', async () => {
    const { run } = buildTools(await graphOf(ORGANISATION, { without: ['domain:default/finance'] }), {
      apis: true,
      organisation: true,
    })
    expect(run(call('search_entities', { kind: 'Domain' })).error).toBe(
      'search_entities: kind "Domain" matches no entity; kinds in use: Component, Group, Resource, System, User',
    )
    expect(run(call('search_entities', { type: 'department' })).error).toBeUndefined()
    expect(run(call('search_entities', { kind: 'Group', env: 'prod' })).error).toBe(
      'search_entities: env "prod" matches no Group: a Group declares no environment — omit env',
    )
  })

  it('witnesses the Group get_entity read, and the references its row resolves; never one declared nowhere', async () => {
    const tools = buildTools(await graphOf(ORGANISATION, { judged: EVERY_KIND }), { apis: true, organisation: true })
    tools.run(call('get_entity', { ref: TIGER }))
    expect([...tools.witnessed].sort()).toEqual([
      BILLING_API,
      'group:default/engineering',
      TIGER,
      'resource:default/billing-api-billing-db-prod',
      'resource:default/billing-db-prod',
      'system:default/billing',
      'user:default/ada',
    ])
    const grace = tools.run(call('get_entity', { ref: 'user:default/grace' }))
    expect(rowsOf(grace)).toEqual([
      {
        ref: 'user:default/grace',
        name: 'grace',
        kind: 'User',
        memberOf: [],
        owns: [],
        danglingReferences: [
          { ref: 'group:default/ghost', declared: false, field: 'memberOf', declaredBy: 'user:default/grace', sameName: [] },
        ],
      },
    ])
    expect(tools.witnessed.has('group:default/ghost')).toBe(false)
    expect([...tools.declaredNowhere]).toEqual(['group:default/ghost'])
    // Read as files, nothing is judged: the ghost is a name, listed, and not witnessed either.
    const files = buildTools(await graphOf(ORGANISATION), { apis: true, organisation: true })
    expect(rowsOf(files.run(call('get_entity', { ref: 'user:default/grace' })))[0]?.['memberOf']).toEqual([
      'group:default/ghost',
    ])
    expect(files.witnessed.has('group:default/ghost')).toBe(false)
    expect(files.declaredNowhere.size).toBe(0)
  })

  it('walks owns from group:default/many at 25 rows, stating the cut', async () => {
    const tools = buildTools(crowded(), { apis: true, organisation: true })
    const walked = resultOf(tools.run(call('get_relations', { ref: 'group:default/many', relation: 'owns' })))
    expect(walked['subject']).toEqual({ ref: 'group:default/many', kind: 'Group', type: 'team' })
    expect(walked['rows']).toHaveLength(25)
    expect(walked['truncated']).toBe('5 more not shown')
    expect(tools.witnessed.has('component:default/service-24')).toBe(true)
    expect(tools.witnessed.has('component:default/service-25')).toBe(false)
    // `between` links two entities; a Group at either end is said to be one.
    const golden = buildTools(await graphOf(ORGANISATION), { apis: true, organisation: true })
    expect(golden.run(call('get_relations', { ref: BILLING_API, relation: 'between', to: TIGER })).error).toBe(
      '"between" links two entities: "to" group:default/tiger is a Group',
    )
    for (const to of [BILLING_API, 'component:default/nope']) {
      expect(golden.run(call('get_relations', { ref: TIGER, relation: 'between', to })).error).toBe(
        '"between" links two entities: "ref" group:default/tiger is a Group',
      )
    }
  })

  it('reads at most 25 names beside the rows, the cut stated, where the kind was not read whole', async () => {
    const unknown = (prefix: string): string[] =>
      Array.from({ length: 30 }, (_, at) => `${prefix}-${String(at).padStart(2, '0')}`)
    const big = organisationSchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Group',
      metadata: { name: 'big' },
      spec: { type: 'team', children: unknown('team'), members: unknown('person') },
    })
    const lone = organisationSchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: { name: 'lone' },
      spec: { memberOf: unknown('team') },
    })
    const { run } = buildTools(EntityGraph.from([], [], { nodes: [big, lone], judged: new Set() }), {
      apis: true,
      organisation: true,
    })
    for (const [ref, relation] of [
      ['group:default/big', 'has-member'],
      ['user:default/lone', 'member-of'],
    ] as const) {
      const walked = resultOf(run(call('get_relations', { ref, relation })))
      expect(walked['readAsNames']).toHaveLength(25)
      expect(walked['readAsNamesTruncated']).toMatch(/^\d+ more not shown$/)
    }
  })

  it('says an owner set aside, or read as a name, beside the rows of owned-by, and witnesses neither', async () => {
    const LION = 'group:default/lion'
    const WORKER = 'component:default/invoicing-worker'
    // Served and set aside — a Group Backstage would refuse: in the catalogue, not read.
    const judged = buildTools(await graphOf(ORGANISATION, { judged: EVERY_KIND, aside: [LION] }), {
      apis: true,
      organisation: true,
    })
    const aside = resultOf(judged.run(call('get_relations', { ref: WORKER, relation: 'owned-by' })))
    expect(aside['rows']).toEqual([])
    expect(aside['setAside']).toEqual([
      {
        ref: LION,
        read: false,
        why: 'in the catalogue, and set aside: not read',
        path: [{ ref: WORKER, kind: 'Component', type: 'service', env: '(undeclared)' }],
      },
    ])
    expect(judged.witnessed.has(LION)).toBe(false)
    // Read as files, Groups are not judged: lion is a name.
    const files = buildTools(await graphOf(ORGANISATION), { apis: true, organisation: true })
    const named = resultOf(files.run(call('get_relations', { ref: WORKER, relation: 'owned-by' })))
    expect(named['readAsNames']).toEqual([
      {
        ref: LION,
        field: 'owner',
        declaredBy: WORKER,
        why: 'read as a name: the Group files this source holds are not the whole organisation',
      },
    ])
    expect(files.witnessed.has(LION)).toBe(false)
  })

  it('refuses a relation answer about a Group no tool returned', async () => {
    const client = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        // billing-api's system and domain: engineering, the domain's owner, is never returned.
        calling('get_relations', { ref: BILLING_API, relation: 'part-of' }),
        calling('answer', { outcome: 'relation', ref: 'group:default/engineering', relation: 'has-member' }),
      ],
    })
    const asked = await question('who is in engineering?', client)
    expect(asked.err).toContain('the answer named group:default/engineering, which no tool returned')
    expect(asked.code).toBe(3)
  })

  it('returns an entity’s row as f8bcb43 did: invoicing-worker’s carries no owner among its danglingReferences', async () => {
    const now = buildTools(await graphOf(ORGANISATION, { judged: EVERY_KIND }), { apis: true, organisation: true })
    const then = buildTools(await asOnF8bcb43(ORGANISATION), { apis: true })
    for (const args of [{ ref: 'component:default/invoicing-worker' }, { ref: BILLING_API }]) {
      expect(now.run(call('get_entity', args)).result).toEqual(then.run(call('get_entity', args)).result)
    }
    expect(rowsOf(now.run(call('get_entity', { ref: 'component:default/invoicing-worker' })))[0]).not.toHaveProperty(
      'danglingReferences',
    )
  })

  it('sends no @, no directory id and no picture: a User served whole with microsoft.com/email and a profile', async () => {
    const ada = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: {
        name: 'ada.lovelace_acme.example',
        namespace: 'default',
        uid: 'a0000000-0000-4000-8000-000000000001',
        annotations: {
          'microsoft.com/email': 'ada.lovelace@acme.example',
          'graph.microsoft.com/user-id': '0f9d3c1e-user-id',
        },
      },
      spec: {
        profile: { displayName: 'Ada Lovelace', email: 'ada.lovelace@acme.example', picture: 'data:image/png;base64,iVBORw0KGgo=' },
        memberOf: ['tiger'],
      },
    }
    const person = 'user:default/ada.lovelace_acme.example'
    const client = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        {
          text: '',
          toolCalls: [
            { id: 'c1', name: 'search_entities', args: { kind: 'User' } },
            { id: 'c2', name: 'get_entity', args: { ref: person } },
            { id: 'c3', name: 'get_relations', args: { ref: TIGER, relation: 'has-member' } },
          ],
          finishReason: 'tool-calls',
        },
        calling('answer', { outcome: 'relation', ref: person, relation: 'member-of' }),
      ],
    })
    const asked = await question('who is in tiger?', client, { catalogueFetch: ignoringFields([...catalogueOf(ORGANISATION), ada]) })
    expect(asked.code, asked.err).toBe(0)
    expect(asked.out).toContain(TIGER)
    expect(client.seen.length).toBe(3)
    for (const request of client.seen) expect(JSON.stringify(request)).not.toMatch(/@|user-id|data:image|Lovelace/)
    expect(asked.out + asked.err).not.toMatch(/@|user-id|data:image|Lovelace/)
  })

  it('sends no @ written where a reference goes: a Group’s members and children, a System’s owner and domain, from a catalogue and from files', async () => {
    const LIONS = 'group:default/lions'
    const PAYROLL = 'system:default/payroll'
    const lions = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Group',
      metadata: { name: 'lions', namespace: 'default', uid: 'a0000000-0000-4000-8000-000000000002' },
      spec: { type: 'team', children: ['cubs@acme.example'], members: ['ada.lovelace@acme.example', 'ada'] },
    }
    const payroll = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'System',
      metadata: { name: 'payroll', namespace: 'default', uid: 'a0000000-0000-4000-8000-000000000003' },
      spec: { owner: 'user:default/grace.hopper@acme.example', domain: 'hr@acme.example' },
    }
    const client = (): LlmClient & { seen: GenerateRequest[] } =>
      scripted({
        supervisor: [saying('QUESTION')],
        analyst: [
          {
            text: '',
            toolCalls: [
              { id: 'c1', name: 'search_entities', args: { kind: 'Group' } },
              { id: 'c2', name: 'get_entity', args: { ref: LIONS } },
              { id: 'c3', name: 'search_entities', args: { kind: 'System' } },
              { id: 'c4', name: 'get_relations', args: { ref: LIONS, relation: 'has-member' } },
              { id: 'c5', name: 'get_relations', args: { ref: LIONS, relation: 'member-of' } },
              { id: 'c6', name: 'get_relations', args: { ref: PAYROLL, relation: 'owned-by' } },
              { id: 'c7', name: 'get_relations', args: { ref: PAYROLL, relation: 'part-of' } },
              // Refused, naming the owners in use.
              { id: 'c8', name: 'search_entities', args: { owner: 'group:default/nobody' } },
            ],
            finishReason: 'tool-calls',
          },
          calling('answer', { outcome: 'relation', ref: LIONS, relation: 'has-member' }),
        ],
      })
    /** What the model was sent, which holds no @, and the tool results it read. */
    const sent = (seen: readonly GenerateRequest[]): string => {
      expect(seen.length).toBe(3)
      const all = seen.map((request) => JSON.stringify(request)).join('\n')
      expect(all).not.toMatch(/@|acme/)
      expect(all).toContain('user:default/ada')
      return JSON.stringify(seen[2]?.transcript)
    }

    const catalogue = client()
    const fromCatalogue = await question('who is in lions?', catalogue, {
      catalogueFetch: fakeBackstage({ entities: [...catalogueOf(ORGANISATION), lions, payroll] }).fetch,
    })
    expect(fromCatalogue.code, fromCatalogue.err).toBe(0)
    expect(sent(catalogue.seen)).toContain('not an entity reference')

    const repo = await mkdtemp(path.join(tmpdir(), 'organisation-at-'))
    await cp(ORGANISATION, repo, { recursive: true })
    await writeFile(path.join(repo, 'org', 'lions.yml'), JSON.stringify(lions), 'utf8')
    await writeFile(path.join(repo, 'org', 'payroll.yml'), JSON.stringify(payroll), 'utf8')
    const files = client()
    const fromFiles = await question('who is in lions?', files, { root: repo, env: {} })
    expect(fromFiles.code, fromFiles.err).toBe(0)
    expect(sent(files.seen)).toContain('not an entity reference')
  })
})

/** A fake that ignores `fields`, as a server may: every item comes back whole. */
const ignoringFields = (entities: readonly Record<string, unknown>[]): CatalogueFetch => {
  const { fetch } = fakeBackstage({ entities })
  return async (url, init) => {
    const whole = new URL(url)
    whole.searchParams.delete('fields')
    return fetch(whole, init)
  }
}

interface Asked {
  code: number
  out: string
  err: string
}

/** `idpa "<phrase>"` against the fake serving tests/golden/organisation, on `client`. */
async function question(phrase: string, client: LlmClient, deps: MainDeps = {}): Promise<Asked> {
  return ran([phrase], { client, ...deps })
}

/** A command against the fake serving tests/golden/organisation, and what it printed. */
async function ran(argv: string[], deps: MainDeps = {}): Promise<Asked> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    root: DEMO,
    env: { IDP_BACKSTAGE_URL: LOOPBACK },
    catalogueFetch: fakeBackstage({ entities: catalogueOf(ORGANISATION) }).fetch,
    events: () => {},
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join('') }
}

describe('the two questions, end to end on a scripted client, over the fake serving tests/golden/organisation', () => {
  it('answers "what does team tiger own?" with idpa relations group:default/tiger --owns, byte for byte', async () => {
    const client = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('search_entities', { kind: 'Group', nameContains: 'tiger' }),
        calling('answer', { outcome: 'relation', ref: TIGER, relation: 'owns' }),
      ],
    })
    const asked = await question('what does team tiger own?', client)
    expect(asked.code, asked.err).toBe(0)
    const relations = await ran(['relations', TIGER, '--owns'])
    expect(relations.code).toBe(0)
    expect(asked.out).toBe(relations.out)
    expect(asked.out).toContain(BILLING_API)
  })

  it('answers "which system is billing-api in?" with the part-of block, system:default/billing witnessed', async () => {
    const client = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('get_relations', { ref: BILLING_API, relation: 'part-of' }),
        calling('answer', {
          outcome: 'relation',
          ref: BILLING_API,
          relation: 'part-of',
          conclusion: 'billing-api is part of system:default/billing.',
        }),
      ],
    })
    const asked = await question('which system is billing-api in?', client)
    expect(asked.code, asked.err).toBe(0)
    const relations = await ran(['relations', 'billing-api', '--part-of'])
    expect(asked.out).toBe(`${relations.out.trimEnd()}\n\n› billing-api is part of system:default/billing.\n`)
    expect(asked.out).toContain('system:default/billing')
    expect(asked.err).not.toContain('left out')
  })

  it('drops a conclusion naming group:default/engineering when no tool returned it', async () => {
    const client = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('get_relations', { ref: TIGER, relation: 'owns' }),
        calling('answer', {
          outcome: 'relation',
          ref: TIGER,
          relation: 'owns',
          conclusion: 'Tiger owns four entities. Its department is engineering.',
        }),
      ],
    })
    const asked = await question('what does team tiger own?', client)
    expect(asked.code, asked.err).toBe(0)
    expect(asked.out).toContain('› Tiger owns four entities.')
    expect(asked.out).not.toContain('engineering')
    expect(asked.err).toContain("! the model's commentary named engineering, which no tool returned")
  })

  it('drops a conclusion using the word "platform" over a source holding a Group platform no tool returned, and keeps it where none is read', async () => {
    const turns = (): LlmClient =>
      scripted({
        supervisor: [saying('QUESTION')],
        analyst: [
          calling('get_relations', { ref: TIGER, relation: 'owns' }),
          calling('answer', {
            outcome: 'relation',
            ref: TIGER,
            relation: 'owns',
            conclusion: 'None of it runs on the shared platform.',
          }),
        ],
      })
    const withPlatform = await question('what does team tiger own?', turns(), {
      catalogueFetch: fakeBackstage({ entities: catalogueOf(ORGANISATION, { groups: ['platform'] }) }).fetch,
    })
    expect(withPlatform.code, withPlatform.err).toBe(0)
    expect(withPlatform.out).not.toContain('platform')
    expect(withPlatform.err).toContain('named platform, which no tool returned')
    const without = await question('what does team tiger own?', turns())
    expect(without.out).toContain('› None of it runs on the shared platform.')
  })

  it('prints a card for an entities answer naming one Group, and a table for several', async () => {
    const one = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('search_entities', { kind: 'Group', nameContains: 'tiger' }),
        calling('answer', { outcome: 'entities', refs: [TIGER] }),
      ],
    })
    const card = await question('who is tiger?', one)
    expect(card.code, card.err).toBe(0)
    expect(card.out).toBe((await ran(['show', TIGER])).out)

    const several = scripted({
      supervisor: [saying('QUESTION')],
      analyst: [
        calling('get_entity', { ref: TIGER }),
        calling('answer', { outcome: 'entities', refs: [TIGER, 'user:default/ada', BILLING_API] }),
      ],
    })
    const table = await question('what is in tiger?', several)
    expect(table.code, table.err).toBe(0)
    expect(table.out).toBe(
      [
        'NAME         KIND       TYPE     ENV  OWNER',
        'billing-api  Component  service  -    group:default/tiger',
        'tiger        Group      team     -    -',
        'ada          User       -        -    -',
        '',
      ].join('\n'),
    )
  })
})
