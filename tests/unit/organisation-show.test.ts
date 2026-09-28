import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, type MainDeps } from '../../src/cli/index.js'
import { renderOverview } from '../../src/cli/render/overview.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { overviewOf } from '../../src/context/graph/overview.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * What `show` and the overview say of the organisation
 * (docs/plans/backstage-http-slice-3.md, Task 3.1, Step 8), over
 * tests/golden/organisation read as files and served by the fake: the two
 * outputs are one but for the source's words and the marks a catalogue's
 * whole read allows.
 */

const ORGANISATION = path.resolve(import.meta.dirname, '../golden/organisation')
const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORG_YAML = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
const BEFORE = path.resolve(import.meta.dirname, '../golden/demo-read')
const LOOPBACK = 'http://127.0.0.1:7008/api/catalog'
const MARK = 'declared nowhere in the catalogue this token reads'

type Item = Record<string, unknown>

interface Ran {
  code: number
  out: string
  err: string
}

const run = async (argv: string[], deps: MainDeps = {}): Promise<Ran> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    events: () => {},
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join('') }
}

/** `show` over the folder read as files. */
const overFiles = (query: string, root: string = ORGANISATION): Promise<Ran> => run(['show', query, '--repo', root])

/** `show` over `items`, served by the fake. */
const overFake = (query: string, items: readonly Item[] = catalogueOf(ORGANISATION)): Promise<Ran> =>
  run(['show', query], {
    root: DEMO,
    env: { IDP_BACKSTAGE_URL: LOOPBACK },
    catalogueFetch: fakeBackstage({ entities: items }).fetch,
  })

const TIGER = [
  'group:default/tiger',
  '',
  '  kind         Group',
  '  type         team',
  '',
  'parent',
  '  group:default/engineering',
  '',
  'children',
  '  none',
  '',
  'members',
  '  user:default/ada',
  '',
  'owns',
  '  component:default/billing-api',
  '  resource:default/billing-api-billing-db-prod  prod',
  '  resource:default/billing-db-prod              prod',
  '  system:default/billing',
  '',
].join('\n')

/** invoicing-worker's card as f8bcb43 printed it over --repo. */
const INVOICING_WORKER = [
  'component:default/invoicing-worker',
  '',
  '  kind         Component',
  '  type         service',
  '  owner        group:default/lion',
  '  environment  (undeclared)',
  '  system       system:default/billing',
  '',
  'depends on',
  '  none',
  '',
  'used by',
  '  none',
  '',
].join('\n')

/** A copy of tests/golden/organisation with `extra` files written over it. */
const copyWith = async (extra: Record<string, string>): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-org-show-')), 'repo')
  await cp(ORGANISATION, root, { recursive: true })
  for (const [relative, text] of Object.entries(extra)) {
    await writeFile(path.join(root, relative), text, 'utf8')
  }
  return root
}

const doc = (value: object): string => `---\n${JSON.stringify(value)}\n`
const group = (name: string, spec: Item): string =>
  doc({ apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name }, spec: { type: 'team', children: [], ...spec } })
const userDoc = (name: string, memberOf: readonly string[]): string =>
  doc({ apiVersion: 'backstage.io/v1alpha1', kind: 'User', metadata: { name }, spec: { memberOf } })
const component = (name: string, spec: Item): string =>
  doc({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger', ...spec },
  })
const thirty = (prefix: string): string[] =>
  Array.from({ length: 30 }, (_, at) => `${prefix}-${String(at).padStart(2, '0')}`)

describe('show over the organisation', () => {
  it('prints a Group: its type, its parent read from the other end, its members and what it owns', async () => {
    const files = await overFiles('tiger')
    expect(files).toMatchObject({ code: 0, out: TIGER })
    const served = await overFake('tiger')
    expect(served).toMatchObject({ code: 0, out: TIGER })
    expect(served.err).toContain('12 entities: 12 read, 0 not modelled')
  })

  it('marks an owner naming no Group the catalogue serves, and leaves it a name over --repo, as it was', async () => {
    expect(await overFiles('invoicing-worker')).toMatchObject({ code: 0, out: INVOICING_WORKER })
    expect(await overFake('invoicing-worker')).toMatchObject({
      code: 0,
      out: INVOICING_WORKER.replace('  owner        group:default/lion\n', `  owner        group:default/lion  ${MARK}\n`),
    })
  })

  it('prints a User: the groups it is a member of and what it owns, and nothing of its profile', async () => {
    const expected = [
      'user:default/ada',
      '',
      '  kind         User',
      '',
      'member of',
      '  group:default/tiger',
      '',
      'owns',
      '  component:default/checkout-web',
      '',
    ].join('\n')
    for (const ran of [await overFiles('ada'), await overFake('ada')]) {
      expect(ran).toMatchObject({ code: 0, out: expected })
      expect(ran.out).not.toMatch(/@|data:image|Ada\b/)
    }
  })

  it('prints a System: its owner, its domain and what it contains; a Domain: its owner and its systems', async () => {
    const system = [
      'system:default/billing',
      '',
      '  kind         System',
      '  type         product',
      '  owner        group:default/tiger',
      '  domain       domain:default/finance',
      '',
      'contains',
      '  component:default/billing-api',
      '  component:default/invoicing-worker',
      '  resource:default/billing-db-prod    prod',
      '',
    ].join('\n')
    const domain = [
      'domain:default/finance',
      '',
      '  kind         Domain',
      '  owner        group:default/engineering',
      '',
      'systems',
      '  system:default/billing',
      '',
    ].join('\n')
    for (const [query, expected] of [['system:default/billing', system], ['finance', domain]] as const) {
      expect(await overFiles(query)).toMatchObject({ code: 0, out: expected })
      expect(await overFake(query)).toMatchObject({ code: 0, out: expected })
    }
  })

  it('marks a membership naming nothing the catalogue serves, and lists it unmarked over --repo', async () => {
    const card = (after: string): string =>
      ['user:default/grace', '', '  kind         User', '', 'member of', `  group:default/ghost${after}`, '', 'owns', '  none', ''].join('\n')
    expect(await overFiles('grace')).toMatchObject({ code: 0, out: card('') })
    expect(await overFake('grace')).toMatchObject({ code: 0, out: card(`  ${MARK}`) })
  })

  it('lists 25 rows of any list on an organisation card, then how many more', async () => {
    const root = await copyWith({
      'org/crowd.yml': [
        group('crowd', { children: thirty('squad'), members: thirty('person') }),
        ...thirty('squad').map((name) => group(name, {})),
        ...thirty('person').map((name) => userDoc(name, ['crowd'])),
        userDoc('joiner', thirty('squad')),
      ].join(''),
      'components/owned.yml': thirty('owned').map((name) => component(name, { owner: 'crowd' })).join(''),
    })
    const crowd = (await overFiles('crowd', root)).out
    const section = (title: string): string[] => {
      const lines = crowd.split('\n')
      const start = lines.indexOf(title)
      const end = lines.indexOf('', start)
      return lines.slice(start + 1, end)
    }
    for (const title of ['children', 'members', 'owns']) {
      expect(section(title)).toHaveLength(26)
      expect(section(title).at(-1)).toBe('  +5 more')
    }
    const joiner = (await overFiles('joiner', root)).out.split('\n')
    expect(joiner.slice(joiner.indexOf('member of') + 1, joiner.indexOf('member of') + 27).at(-1)).toBe('  +5 more')
  })

  it('resolves an entity first: a System named as a Component prints the Component, and is shown by its ref', async () => {
    const root = await copyWith({ 'components/billing.yml': component('billing', {}) })
    const byName = await overFiles('billing', root)
    expect(byName.code).toBe(0)
    expect(byName.out.split('\n')[0]).toBe('component:default/billing')
    const byRef = await overFiles('system:default/billing', root)
    expect(byRef.out.split('\n')[0]).toBe('system:default/billing')
  })

  it('prints a node only the organisation names, and lists 25 candidates and how many more when only names hold the query', async () => {
    expect((await overFiles('engineering')).out.split('\n')[0]).toBe('group:default/engineering')
    const root = await copyWith({ 'org/people.yml': thirty('person').map((name) => userDoc(name, [])).join('') })
    const ran = await overFiles('person', root)
    expect(ran.code).toBe(1)
    const lines = ran.out.trimEnd().split('\n')
    expect(lines[0]).toBe('"person" matches 30 nodes:')
    expect(lines.slice(1, 26)).toEqual(thirty('person').slice(0, 25).map((name) => `  user:default/${name}`))
    expect(lines[26]).toBe('  +5 more')
    expect(lines).toHaveLength(27)
  })

  it('refuses a name two organisation nodes carry, calling them nodes, and a name only entities hold, calling them entities', async () => {
    const root = await copyWith({ 'org/tiger-the-person.yml': userDoc('tiger', ['tiger']) })
    const tiger = await overFiles('tiger', root)
    expect(tiger).toMatchObject({ code: 1, out: '"tiger" matches 2 nodes:\n  group:default/tiger\n  user:default/tiger\n' })
    expect((await overFiles('billing-', root)).out.split('\n')[0]).toMatch(/^"billing-" matches \d+ entities:$/)
  })

  it('prints every show of the demo SI as f8bcb43 did, over files and over the fake serving the demo organisation', async () => {
    const withOrganisation = catalogueOf(DEMO, { org: ORG_YAML })
    for (const [golden, query] of [
      ['show-billing-api.txt', 'billing-api'],
      ['show-inpi-api.txt', 'inpi-api'],
      ['show-billing-db-prod.txt', 'billing-db-prod'],
      ['show-billing.txt', 'billing'],
    ] as const) {
      const expected = await readFile(path.join(BEFORE, golden), 'utf8')
      expect((await run(['show', query, '--demo'])).out).toBe(expected)
      expect((await overFake(query, withOrganisation)).out).toBe(expected)
    }
  })
})

describe('the overview over the organisation', () => {
  it('counts the organisation on one line after the APIs, and says nothing of it where there is none', async () => {
    const loaded = await new FixtureProvider(ORGANISATION).load()
    const graph = EntityGraph.from(loaded.entities, [], { nodes: loaded.organisation ?? [], judged: new Set() })
    const text = renderOverview(overviewOf(graph, { ignored: loaded.ignored, rejected: 0 }), { from: 'repo', repo: 'organisation' })
    expect(text).toContain('\n\norganisation  3 groups, 2 users, 1 system, 1 domain\n\n')
    expect(text).not.toContain('not loaded')
    const demo = await readFile(path.join(BEFORE, 'overview.txt'), 'utf8')
    const demoGraph = EntityGraph.from((await new FixtureProvider(DEMO).load()).entities)
    expect(renderOverview(overviewOf(demoGraph, { ignored: [], rejected: 0 }), { from: 'demo' })).toBe(demo)
  })
})
