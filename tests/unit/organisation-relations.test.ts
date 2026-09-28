import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import { runRelations } from '../../src/cli/commands/relations.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import {
  RELATION_LIMITS,
  reachedBy,
  relationsOf,
  type RelationResult,
} from '../../src/context/graph/relations.js'
import type {
  CatalogueEntity,
  OrganisationEntity,
  OrganisationKind,
} from '../../src/core/schemas/entity.js'
import { ORGANISATION_RELATIONS } from '../../src/core/schemas/query.js'
import type { LlmClient } from '../../src/llm/client.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * `idpa relations` over the organisation (docs/plans/backstage-http-slice-3.md,
 * Task 3.2): what a team or a person owns, who owns something and the groups
 * above them, who is a member of what, and what a System or a Domain holds —
 * both directions, several hops, bounded, each row with its whole path, no
 * model. Over tests/golden/organisation read as files, and served by the fake,
 * where the roads differ only by the source's words and the ends a
 * catalogue's whole read may judge.
 */

const ORGANISATION = path.resolve(import.meta.dirname, '../golden/organisation')
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORG_YAML = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
const GOLDEN = path.resolve(import.meta.dirname, '../golden/relations-organisation')
const DEMO_GOLDEN = path.resolve(import.meta.dirname, '../golden/relations-demo')
const LOOPBACK = 'http://127.0.0.1:7008/api/catalog'
const IN_CATALOGUE = 'declared nowhere in the catalogue this token reads'
/** What `--repo tests/golden/organisation` says on stderr of every run: ada's file holds what is never read. */
const NOT_READ = 'not read: 2 fields this tool does not model (metadata.annotations ×1, spec.profile ×1)\n'
const EVERY_KIND: readonly OrganisationKind[] = ['Group', 'User', 'System', 'Domain']

type Item = Record<string, unknown>

/** No client, and one that throws if anything reaches for a model anyway. */
const untouchable: LlmClient = {
  generate: () => {
    throw new Error('relations called a model')
  },
}

interface Ran {
  code: number
  out: string
  err: string
}

const run = async (argv: string[], deps: MainDeps = {}): Promise<Ran> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    client: untouchable,
    env: {},
    events: () => {},
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join('') }
}

/** `relations` over tests/golden/organisation read as files. */
const overFiles = (...argv: string[]): Promise<Ran> => run(['relations', ...argv, '--repo', ORGANISATION])

/** `relations` over `items`, served by the fake. */
const overFake = (argv: string[], items: readonly Item[] = catalogueOf(ORGANISATION)): Promise<Ran> =>
  run(['relations', ...argv], {
    root: DEMO,
    env: { IDP_BACKSTAGE_URL: LOOPBACK },
    catalogueFetch: fakeBackstage({ entities: items }).fetch,
  })

const golden = (name: string): Promise<string> => readFile(path.join(GOLDEN, name), 'utf8')

/**
 * The graph `main` builds over a folder: judged as `judged` says, as the
 * catalogue road judges what it read whole; the file road judges nothing.
 * `reversed` hands every list over in the opposite order, as another
 * provider might read the files.
 */
const graphOf = async (
  root: string,
  options: { judged?: readonly OrganisationKind[]; aside?: readonly string[]; reversed?: boolean } = {},
): Promise<EntityGraph> => {
  const loaded = await new FixtureProvider(root).load()
  const order = <T>(list: readonly T[]): T[] => (options.reversed === true ? [...list].reverse() : [...list])
  return EntityGraph.from(
    order(loaded.entities),
    [...loaded.ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])), ...(options.aside ?? [])],
    { nodes: order(loaded.organisation ?? []), judged: new Set(options.judged ?? []) },
  )
}

const rowsOf = (result: RelationResult | undefined) =>
  (result?.rows ?? []).map((row) => ({
    ref: reachedBy(row).ref,
    depth: row.steps.length - 1,
    path: row.steps.map((step) => step.ref),
  }))

const TIGER = 'group:default/tiger'
const ENGINEERING = 'group:default/engineering'
const COMMON = 'group:default/common'
const ADA = 'user:default/ada'
const BILLING_API = 'component:default/billing-api'
const GRANT = 'resource:default/billing-api-billing-db-prod'
const BILLING_DB = 'resource:default/billing-db-prod'
const INVOICING = 'component:default/invoicing-worker'
const BILLING = 'system:default/billing'
const FINANCE = 'domain:default/finance'

const group = (name: string, spec: { parent?: string; children?: string[]; members?: string[] } = {}): OrganisationEntity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name },
  spec: { type: 'team', children: [], ...spec },
})
const user = (name: string, memberOf: string[]): OrganisationEntity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'User',
  metadata: { name },
  spec: { memberOf },
})
const component = (name: string, owner: string, system?: string): CatalogueEntity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, annotations: {} },
  spec: { type: 'service', lifecycle: 'production', owner, ...(system === undefined ? {} : { system }) },
})
const system = (name: string, owner: string, domain?: string): OrganisationEntity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'System',
  metadata: { name },
  spec: { owner, ...(domain === undefined ? {} : { domain }) },
})
const ref = (kind: string, name: string): string => `${kind}:default/${name}`

/** Each row as [what it reached, its depth], the way the walks below are read. */
const reached = (result: RelationResult | undefined): Array<[string, number]> =>
  rowsOf(result).map(({ ref: end, depth }) => [end, depth])

describe('relations over the organisation', () => {
  it('lists what tiger owns: billing-api, its grant, billing-db-prod and the System billing, depth 1', async () => {
    expect(rowsOf(relationsOf(await graphOf(ORGANISATION), TIGER, 'owns'))).toEqual(
      [BILLING_API, GRANT, BILLING_DB, BILLING].map((owned) => ({ ref: owned, depth: 1, path: [TIGER, owned] })),
    )
    const ran = await overFiles('tiger', '--owns')
    expect(ran).toMatchObject({ code: 0, err: NOT_READ, out: await golden('tiger-owns.txt') })
  })

  it('lists what engineering owns, through its children: finance at depth 1, then tiger’s and common’s at depth 2, each path from engineering', async () => {
    const rows = rowsOf(relationsOf(await graphOf(ORGANISATION), ENGINEERING, 'owns'))
    expect(rows).toContainEqual({ ref: BILLING_API, depth: 2, path: [ENGINEERING, TIGER, BILLING_API] })
    expect(rows).toEqual([
      { ref: FINANCE, depth: 1, path: [ENGINEERING, FINANCE] },
      ...[BILLING_API, GRANT, BILLING_DB, BILLING].map((owned) => ({
        ref: owned,
        depth: 2,
        path: [ENGINEERING, TIGER, owned],
      })),
    ])
    // checkout-web is ada's, a User of tiger: a member is not a child group.
    expect(rows.map(({ ref: reached }) => reached)).not.toContain('component:default/checkout-web')
    expect(await overFiles('engineering', '--owns')).toMatchObject({ code: 0, out: await golden('engineering-owns.txt') })
  })

  it('reads a child from either end: tiger is engineering’s by children, common by children and parent, each listed once', async () => {
    const rows = rowsOf(relationsOf(await graphOf(ORGANISATION), ENGINEERING, 'has-member'))
    expect(rows.filter(({ ref: reached }) => reached.startsWith('group:'))).toEqual([
      { ref: COMMON, depth: 1, path: [ENGINEERING, COMMON] },
      { ref: TIGER, depth: 1, path: [ENGINEERING, TIGER] },
    ])
    // tiger names no parent: engineering's children say it, and member-of reads that end too.
    expect(rowsOf(relationsOf(await graphOf(ORGANISATION), TIGER, 'member-of'))).toEqual([
      { ref: ENGINEERING, depth: 1, path: [TIGER, ENGINEERING] },
    ])
  })

  it('names billing-api’s owner and the groups above it: tiger, then engineering', async () => {
    expect(rowsOf(relationsOf(await graphOf(ORGANISATION), BILLING_API, 'owned-by'))).toEqual([
      { ref: TIGER, depth: 1, path: [BILLING_API, TIGER] },
      { ref: ENGINEERING, depth: 2, path: [BILLING_API, TIGER, ENGINEERING] },
    ])
  })

  it('over the fake, ends invoicing-worker’s owned-by on group:default/lion, declared nowhere, and lists no group past it', async () => {
    const ran = await overFake(['invoicing-worker', '--owned-by'])
    expect(ran).toMatchObject({ code: 0, out: await golden('invoicing-worker-owned-by.txt') })
    expect(ran.out).toContain(`invoicing-worker → lion — ${IN_CATALOGUE}`)
    const served = await graphOf(ORGANISATION, { judged: EVERY_KIND })
    expect(rowsOf(relationsOf(served, INVOICING, 'owned-by'))).toEqual([
      { ref: 'group:default/lion', depth: 1, path: [INVOICING, 'group:default/lion'] },
    ])
  })

  it('over --repo, answers invoicing-worker’s owned-by with the one line: lion is read as a name here, exit 1', async () => {
    expect(await overFiles('invoicing-worker', '--owned-by')).toEqual({
      code: 1,
      err: NOT_READ,
      out:
        'component:default/invoicing-worker\n\nowned by (0)\n' +
        '  none: group:default/lion, the owner invoicing-worker names, is read as a name here: ' +
        "a declarations repository's Group files are not read as the whole organisation\n",
    })
  })

  it('over the fake, ends grace’s member-of on group:default/ghost, declared nowhere', async () => {
    const ran = await overFake(['grace', '--member-of'])
    expect(ran.code).toBe(0)
    expect(ran.out).toContain('member of (1)\n')
    expect(ran.out).toContain(`grace → ghost — ${IN_CATALOGUE}`)
    // Over the files, a name: this source's Group files are not the organisation.
    expect((await overFiles('grace', '--member-of')).out).toContain(
      '  none: group:default/ghost, the group grace names, is read as a name here: ',
    )
  })

  it('ends a judged owner naming a Group set aside on that Group, in the catalogue and not read, never declared nowhere', async () => {
    // A Group lion Backstage would refuse — no children — served beside the
    // rest: set aside with its ref, so the owner naming it resolves.
    const items = catalogueOf(ORGANISATION)
    const common = items.find((item) => (item['metadata'] as Item)['name'] === 'common') as Item
    const lion: Item = {
      ...common,
      metadata: { ...(common['metadata'] as Item), name: 'lion', uid: '00000000-0000-4000-8000-00000000110a' },
      spec: { type: 'team' },
    }
    const ran = await overFake(['invoicing-worker', '--owned-by'], [...items, lion])
    expect(ran.code).toBe(0)
    expect(ran.out).toContain('invoicing-worker → lion — in the catalogue, not read')
    expect(ran.out).not.toContain('declared nowhere')
    const served = await graphOf(ORGANISATION, { judged: EVERY_KIND, aside: ['group:default/lion'] })
    const result = relationsOf(served, INVOICING, 'owned-by')
    expect(rowsOf(result)).toEqual([{ ref: 'group:default/lion', depth: 1, path: [INVOICING, 'group:default/lion'] }])
    expect(result?.rows[0]?.steps[1]).toEqual({ ref: 'group:default/lion', setAside: true })
  })

  it('lists engineering’s members, users and groups, down its children', async () => {
    expect(rowsOf(relationsOf(await graphOf(ORGANISATION), ENGINEERING, 'has-member'))).toEqual([
      { ref: COMMON, depth: 1, path: [ENGINEERING, COMMON] },
      { ref: TIGER, depth: 1, path: [ENGINEERING, TIGER] },
      { ref: ADA, depth: 2, path: [ENGINEERING, TIGER, ADA] },
    ])
    expect(await overFiles('engineering', '--has-member')).toMatchObject({
      code: 0,
      out: await golden('engineering-has-member.txt'),
    })
    expect(await overFiles('ada', '--member-of')).toMatchObject({ code: 0, out: await golden('ada-member-of.txt') })
  })

  it('walks billing-api up to billing, then finance; and finance down to billing, then its three parts', async () => {
    const graph = await graphOf(ORGANISATION)
    expect(rowsOf(relationsOf(graph, BILLING_API, 'part-of'))).toEqual([
      { ref: BILLING, depth: 1, path: [BILLING_API, BILLING] },
      { ref: FINANCE, depth: 2, path: [BILLING_API, BILLING, FINANCE] },
    ])
    expect(rowsOf(relationsOf(graph, FINANCE, 'has-part'))).toEqual([
      { ref: BILLING, depth: 1, path: [FINANCE, BILLING] },
      ...[BILLING_API, INVOICING, BILLING_DB].sort().map((part) => ({ ref: part, depth: 2, path: [FINANCE, BILLING, part] })),
    ])
    expect(await overFiles('billing-api', '--part-of')).toMatchObject({ code: 0, out: await golden('billing-api-part-of.txt') })
    expect(await overFiles('finance', '--has-part')).toMatchObject({ code: 0, out: await golden('finance-has-part.txt') })
  })

  it('reports a parent loop as a cycle, walked once, whatever order the files came in', () => {
    // a's parent is b and b's is a; u is in both.
    const nodes = [group('a', { parent: ref('group', 'b') }), group('b', { parent: ref('group', 'a') }), user('u', [ref('group', 'a'), ref('group', 'b')])]
    for (const order of [nodes, [...nodes].reverse()]) {
      const graph = EntityGraph.from([], [], { nodes: order, judged: new Set() })
      const members = relationsOf(graph, ref('group', 'a'), 'has-member')
      expect(rowsOf(members).map(({ ref: reached, depth }) => [reached, depth])).toEqual([
        [ref('group', 'b'), 1],
        [ref('user', 'u'), 1],
        [ref('user', 'u'), 2],
      ])
      expect(members?.cycles).toEqual([[ref('group', 'a'), ref('group', 'b'), ref('group', 'a')]])
      const groups = relationsOf(graph, ref('user', 'u'), 'member-of')
      // One loop, found once: the walk goes through each Group once.
      expect(groups?.cycles).toEqual([[ref('user', 'u'), ref('group', 'a'), ref('group', 'b'), ref('group', 'a')]])
      expect(rowsOf(groups).map(({ ref: reached, depth }) => [reached, depth])).toEqual([
        [ref('group', 'a'), 1],
        [ref('group', 'b'), 1],
        [ref('group', 'a'), 2],
        [ref('group', 'b'), 2],
      ])
      expect(groups?.stopped).toBe(false)
      expect(runRelations(graph, { query: 'a', relation: 'has-member' }).text).toContain(
        '\n  a cycle, not followed: a ← b ← a',
      )
    }
  })

  it('follows only the kinds each walk names: a child, a parent or a member of the wrong kind is no edge of it', () => {
    // The reader keeps a reference's own kind, so a Group's children can name
    // a Component and a User, its parent a User, its members a Group; and a
    // part's system can name a Component. None of these is ownership,
    // membership or system membership as the table reads them.
    const graph = EntityGraph.from(
      [
        component('x', ref('group', 'other')),
        component('y', TIGER),
        component('z', ref('user', 'p')),
        component('w', ref('group', 'c')),
        component('q', TIGER, ref('component', 'y')),
      ],
      [],
      {
        nodes: [
          group('tiger', {
            children: [ref('component', 'x'), ref('user', 'bob'), ref('group', 'c')],
            parent: ref('user', 'p'),
            members: [ref('group', 'm')],
          }),
          group('c'),
          group('m'),
          group('other'),
          group('g2', { children: [ADA] }),
          user('ada', [TIGER]),
          user('bob', []),
          user('p', []),
        ],
        judged: new Set(),
      },
    )
    // tiger owns q and y, and w through its child Group c: not x, not bob.
    expect(reached(relationsOf(graph, TIGER, 'owns'))).toEqual([
      [ref('component', 'q'), 1],
      [ref('component', 'y'), 1],
      [ref('component', 'w'), 2],
    ])
    // p owns z, and not what tiger owns: a User named as a parent is no parent.
    expect(reached(relationsOf(graph, ref('user', 'p'), 'owns'))).toEqual([[ref('component', 'z'), 1]])
    // x's owner is other, whatever tiger's children say.
    expect(reached(relationsOf(graph, ref('component', 'x'), 'owned-by'))).toEqual([[ref('group', 'other'), 1]])
    // y is tiger's, and above tiger no Group: p is a User.
    expect(reached(relationsOf(graph, ref('component', 'y'), 'owned-by'))).toEqual([[TIGER, 1]])
    // ada is a member of tiger; g2 names her as a child, which is no membership.
    expect(reached(relationsOf(graph, ADA, 'member-of'))).toEqual([[TIGER, 1]])
    // m is named among tiger's members, which are Users: m is no child of tiger.
    expect(reached(relationsOf(graph, ref('group', 'm'), 'member-of'))).toEqual([])
    // tiger's members are ada, and its child Group c: not bob, not m, not x.
    expect(reached(relationsOf(graph, TIGER, 'has-member'))).toEqual([
      [ref('group', 'c'), 1],
      [ADA, 1],
    ])
    // q's system names a Component: no System, so q is part of nothing.
    expect(reached(relationsOf(graph, ref('component', 'q'), 'part-of'))).toEqual([])
  })

  it('ends a path on each field a walk reads at every hop, not only the first: a parent, a child, a member and a domain naming nothing', () => {
    // Every kind judged, as a catalogue's read is. a's parent and one of its
    // children name nothing, its other child is a Group set aside, and one of
    // its members names nothing; s's domain names nothing, and d's parent
    // domain.
    const REFUSED = ref('group', 'refused')
    const graph = EntityGraph.from(
      [
        component('app', ref('group', 'a'), ref('system', 's')),
        component('app2', ref('group', 'b')),
        component('app3', ref('group', 'o'), ref('system', 's2')),
      ],
      [REFUSED],
      {
        nodes: [
          group('a', {
            parent: ref('group', 'ghostparent'),
            children: [ref('group', 'ghostchild'), REFUSED],
            members: [ref('user', 'ghostuser')],
          }),
          group('b', { parent: REFUSED }),
          group('o'),
          user('u', [ref('group', 'a')]),
          system('s', ref('group', 'a'), ref('domain', 'ghostdomain')),
          system('s2', ref('group', 'o'), ref('domain', 'd')),
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Domain',
            metadata: { name: 'd' },
            spec: { owner: ref('group', 'o'), subdomainOf: ref('domain', 'ghostup') },
          },
        ],
        judged: new Set(EVERY_KIND),
      },
    )
    const ends = (result: RelationResult | undefined) =>
      (result?.rows ?? []).map((row) => {
        const end = reachedBy(row)
        return [end.ref, row.steps.length - 1, end.nowhere?.field ?? (end.setAside === true ? 'set aside' : '-')]
      })
    expect(ends(relationsOf(graph, 'component:default/app', 'owned-by'))).toEqual([
      [ref('group', 'a'), 1, '-'],
      [ref('group', 'ghostparent'), 2, 'parent'],
    ])
    expect(ends(relationsOf(graph, ref('user', 'u'), 'member-of'))).toEqual([
      [ref('group', 'a'), 1, '-'],
      [ref('group', 'ghostparent'), 2, 'parent'],
    ])
    expect(ends(relationsOf(graph, ref('group', 'a'), 'owns'))).toEqual([
      ['component:default/app', 1, '-'],
      [ref('group', 'ghostchild'), 1, 'children'],
      [REFUSED, 1, 'set aside'],
      [ref('system', 's'), 1, '-'],
    ])
    expect(ends(relationsOf(graph, ref('group', 'a'), 'has-member'))).toEqual([
      [ref('group', 'ghostchild'), 1, 'children'],
      [REFUSED, 1, 'set aside'],
      [ref('user', 'ghostuser'), 1, 'members'],
      [ref('user', 'u'), 1, '-'],
    ])
    expect(ends(relationsOf(graph, 'component:default/app', 'part-of'))).toEqual([
      [ref('system', 's'), 1, '-'],
      [ref('domain', 'ghostdomain'), 2, 'domain'],
    ])
    expect(ends(relationsOf(graph, 'component:default/app3', 'part-of'))).toEqual([
      [ref('system', 's2'), 1, '-'],
      [ref('domain', 'd'), 2, '-'],
      [ref('domain', 'ghostup'), 3, 'subdomainOf'],
    ])
    // At the depth bound, a set-aside parent is an edge left unfollowed.
    const bounded = relationsOf(graph, 'component:default/app2', 'owned-by', { depth: 1 })
    expect(ends(bounded)).toEqual([[ref('group', 'b'), 1, '-']])
    expect(bounded?.stopped).toBe(true)
    expect(relationsOf(graph, 'component:default/app2', 'owned-by', { depth: 2 })?.stopped).toBe(false)
  })

  it('stops a hierarchy deeper than the bound where it says so, and a child loop of the whole chain as a cycle', () => {
    // g00 ← g01 ← … ← g14, each naming the one before as its parent, and g00 naming g14.
    const names = Array.from({ length: 15 }, (_, at) => `g${String(at).padStart(2, '0')}`)
    const chain = names.map((name, at) => group(name, { parent: ref('group', names[(at + names.length - 1) % names.length] as string) }))
    const graph = EntityGraph.from([component('app', ref('group', 'g14'))], [], { nodes: chain, judged: new Set() })
    const above = relationsOf(graph, 'component:default/app', 'owned-by')
    expect(above?.rows).toHaveLength(RELATION_LIMITS.depth)
    expect(above?.stopped).toBe(true)
    expect(runRelations(graph, { query: 'app', relation: 'owned-by' }).text).toContain(
      `\n  stopped at depth ${String(RELATION_LIMITS.depth)}; --depth <n> goes further`,
    )
    const whole = relationsOf(graph, ref('group', 'g00'), 'has-member', { depth: 100 })
    expect(whole?.rows).toHaveLength(14)
    expect(whole?.stopped).toBe(false)
    expect(whole?.cycles).toHaveLength(1)
  })

  it('bounds the rows a Group owning thousands lists, and counts the rest', () => {
    const owned = Array.from({ length: RELATION_LIMITS.rows + 50 }, (_, at) => component(`app-${String(at).padStart(3, '0')}`, TIGER))
    const graph = EntityGraph.from(owned, [], { nodes: [group('tiger')], judged: new Set() })
    const { text, found } = runRelations(graph, { query: 'tiger', relation: 'owns' })
    expect(found).toBe(true)
    expect(text).toContain(`owns (${String(RELATION_LIMITS.rows + 50)})\n`)
    expect(text.endsWith('\n  50 more not shown')).toBe(true)
  })

  it('computes the same rows whatever order the provider read the files in', async () => {
    for (const judged of [[], EVERY_KIND]) {
      const graph = await graphOf(ORGANISATION, { judged })
      const reversed = await graphOf(ORGANISATION, { judged, reversed: true })
      for (const node of graph.nodes()) {
        for (const relation of ORGANISATION_RELATIONS) {
          expect(relationsOf(reversed, refOf(node), relation)).toEqual(relationsOf(graph, refOf(node), relation))
        }
      }
    }
  })

  it('holds nothing, and says so, for an organisation relation over a source that holds none of its kinds', async () => {
    const ran = await run(['relations', 'billing-api', '--owned-by', '--demo'])
    expect(ran).toMatchObject({ code: 1 })
    expect(ran.out).toContain('none: group:default/tiger, the owner billing-api names, is read as a name here: this source holds no Group')
  })

  it('computes no row for a relation asked of a kind it does not start from', async () => {
    expect(await overFiles('billing-api', '--owns')).toEqual({
      code: 1,
      err: NOT_READ,
      out: 'component:default/billing-api\n\nowns (0)\n  none\n',
    })
    expect(await overFiles('tiger', '--depends-on')).toEqual({
      code: 1,
      err: NOT_READ,
      out: 'group:default/tiger\n\ndepends on (0)\n  none\n',
    })
    // A dependsOn or a providesApis naming a Group makes it no dependency and
    // no API: an entity's relations are asked of an entity.
    const named: CatalogueEntity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'y', annotations: {} },
      spec: { type: 'service', lifecycle: 'production', owner: TIGER, dependsOn: [TIGER], providesApis: [TIGER] },
    }
    const graph = EntityGraph.from([named, component('x', TIGER)], [], {
      nodes: [group('tiger')],
      judged: new Set(),
    })
    for (const relation of ['impacts', 'consumed-by', 'provided-by', 'depends-on', 'consumes', 'provides'] as const) {
      const result = relationsOf(graph, TIGER, relation)
      expect([relation, result?.total, result?.rows]).toEqual([relation, 0, []])
    }
    // The walk from y is untouched: its dependsOn names a node, so it is no dangling reference.
    expect(reached(relationsOf(graph, ref('component', 'y'), 'depends-on'))).toEqual([])
  })

  it('answers --to between two entities only, whichever end names a Group', async () => {
    const refused = { code: 1, err: NOT_READ, out: 'No entity named "tiger".\n' }
    expect(await overFiles('tiger', '--to', 'billing-api')).toEqual(refused)
    expect(await overFiles('billing-api', '--to', 'tiger')).toEqual(refused)
    expect(relationsOf(await graphOf(ORGANISATION), TIGER, 'between', { to: BILLING_API })).toBeUndefined()
  })

  it('resolves relations billing through the Component when a System billing is also read', () => {
    const graph = EntityGraph.from([component('billing', TIGER, BILLING)], [], {
      nodes: [
        group('tiger'),
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'System',
          metadata: { name: 'billing' },
          spec: { owner: TIGER },
        },
      ],
      judged: new Set(),
    })
    const byName = runRelations(graph, { query: 'billing' })
    expect(byName.text).toMatch(/^component:default\/billing\n/)
    expect(byName).toEqual(runRelations(graph, { query: 'component:default/billing' }))
    expect(runRelations(graph, { query: BILLING }).text).toBe(
      [
        'system:default/billing',
        '',
        'owned by (1)',
        '  NODE                 TYPE  ENV  DEPTH  PATH',
        '  group:default/tiger  team  -    1      billing → tiger',
        '',
        'has parts (1)',
        '  NODE                       TYPE     ENV  DEPTH  PATH',
        '  component:default/billing  service  -    1      billing ← billing',
      ].join('\n'),
    )
  })

  it('leaves every existing relation of every entity exactly as it was: tests/golden/relations-demo, byte for byte', async () => {
    const cases: Array<[string, string[]]> = [
      ['billing-db-prod.txt', ['billing-db-prod']],
      ['mysql-prod-01-impacts.txt', ['mysql-prod-01', '--impacts']],
      ['billing-api-depends-on.txt', ['billing-api', '--depends-on']],
      ['reporting-worker-to-mysql-prod-01.txt', ['reporting-worker', '--to', 'mysql-prod-01']],
      ['reporting-worker-to-billing-api.txt', ['reporting-worker', '--to', 'billing-api']],
      ['mcp-inpi.txt', ['component:default/mcp-inpi']],
    ]
    for (const [file, argv] of cases) {
      const expected = await readFile(path.join(DEMO_GOLDEN, file), 'utf8')
      expect(await run(['relations', ...argv, '--demo'])).toMatchObject({ code: 0, out: expected })
      // The demo SI served with the demo's organisation beside it: the same bytes.
      expect(await overFake(argv, catalogueOf(DEMO, { org: ORG_YAML }))).toMatchObject({ code: 0, out: expected })
    }
  })

  it('leaves relations <entity> with no flag as it was: an entity’s overview lists the relations it listed', async () => {
    const loaded = await new FixtureProvider(ORGANISATION).load()
    const withOrganisation = await graphOf(ORGANISATION, { judged: EVERY_KIND })
    const without = EntityGraph.from(loaded.entities, (loaded.organisation ?? []).map(refOf))
    for (const entity of loaded.entities) {
      expect(runRelations(withOrganisation, { query: refOf(entity) })).toEqual(
        runRelations(without, { query: refOf(entity) }),
      )
    }
  })

  it('prints an organisation node’s overview: the relations of its kind that hold something', async () => {
    expect(await overFiles('tiger')).toMatchObject({ code: 0, err: NOT_READ, out: await golden('tiger.txt') })
    const out = (await overFiles('tiger')).out
    expect(out.split('\n').filter((line) => /^\S.* \(\d+\)$/.test(line))).toEqual([
      'owns (4)',
      'member of (1)',
      'has members (1)',
    ])
    // A relation whose first hop is only read as a name is said, and not
    // dropped: "no relation declared" alone is false of grace, who names ghost.
    expect(await overFiles('grace')).toEqual({
      code: 1,
      err: NOT_READ,
      out:
        'user:default/grace\n\nmember of (0)\n' +
        '  none: group:default/ghost, the group grace names, is read as a name here: ' +
        "a declarations repository's Group files are not read as the whole organisation\n",
    })
    // A node that holds none of its kind's relations says so, as an entity does.
    const lone = EntityGraph.from([], [], { nodes: [group('lone')], judged: new Set() })
    expect(runRelations(lone, { query: 'lone' })).toEqual({
      text: 'group:default/lone\n\nno relation declared',
      found: false,
    })
  })

  it('refuses two relation flags, naming all twelve', async () => {
    const ran = await run(['relations', 'a', '--impacts', '--owns'])
    expect(ran.code).toBe(2)
    expect(ran.err).toContain(
      'relations takes one of --consumes, --consumed-by, --depends-on, --impacts, --provides, --provided-by, ' +
        '--owns, --owned-by, --member-of, --has-member, --part-of, --has-part, not --impacts and --owns',
    )
    expect((await run(['relations', 'a', '--owns', '--to', 'b'])).err).toContain(
      '--to asks for the paths between two entities, and takes no relation: drop --owns',
    )
  })

  it('leaves the Analyst’s get_relations where it was: a Group is no entity of it until 3.3', async () => {
    const tools = buildTools(await graphOf(ORGANISATION, { judged: EVERY_KIND }), { apis: true })
    const outcome = tools.run({ id: 'c-1', name: 'get_relations', args: { ref: TIGER, relation: 'impacts' } })
    expect(outcome.error).toBe(`no such entity: "ref" ${TIGER}`)
  })
})
