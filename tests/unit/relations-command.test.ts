import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS, HELP, main, parseArguments } from '../../src/cli/index.js'
import { runRelations } from '../../src/cli/commands/relations.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { RELATION_LIMITS } from '../../src/context/graph/relations.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import type { LlmClient } from '../../src/llm/client.js'

/**
 * `idpa relations`: every relation of one entity, computed from the
 * declarations and printed with its path — no model, no key, and the same
 * bytes whatever the order the files were read in. The owner's three
 * questions are asked of `tests/golden/relations-owner/`; the demo SI's
 * answers are held to `tests/golden/relations-demo/`.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const OWNER = path.resolve(import.meta.dirname, '../golden/relations-owner')
const GOLDEN = path.resolve(import.meta.dirname, '../golden/relations-demo')

/** No client, and one that throws if anything reaches for a model anyway. */
const untouchable: LlmClient = {
  generate: () => {
    throw new Error('relations called a model')
  },
}

const run = async (argv: string[]) => {
  const io = { out: [] as string[], err: [] as string[] }
  const code = await main(argv, {
    client: untouchable,
    env: {},
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
    events: () => {},
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

const golden = (name: string): Promise<string> => readFile(path.join(GOLDEN, name), 'utf8')

describe("the owner's questions, keyless", () => {
  it('what payments-api consumes: billing-db-dev, readwrite, dev, via the right', async () => {
    const { code, out, err } = await run(['relations', 'payments-api', '--consumes', '--repo', OWNER])
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'component:default/payments-api',
        '',
        'consumes (1)',
        '  ENTITY                           TYPE      ENV  ACCESS     VIA                                                DEPTH  PATH',
        '  resource:default/billing-db-dev  database  dev  readwrite  resource:default/billing-api-billing-db-dev (dev)  2      payments-api → billing-api-billing-db-dev (readwrite) → billing-db-dev',
        '  what these depend on is not listed; --depth 3 follows it',
        '',
      ].join('\n'),
    )
  })

  it('which services use billing-db-dev: billing-api and payments-api, each through the readwrite dev right', async () => {
    const { code, out } = await run(['relations', 'billing-db-dev', '--consumed-by', '--repo', OWNER])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'resource:default/billing-db-dev',
        '',
        'consumed by (2)',
        '  ENTITY                          TYPE     ENV  ACCESS     VIA                                                DEPTH  PATH',
        '  component:default/billing-api   service  -    readwrite  resource:default/billing-api-billing-db-dev (dev)  2      billing-db-dev ← billing-api-billing-db-dev (readwrite) ← billing-api',
        '  component:default/payments-api  service  -    readwrite  resource:default/billing-api-billing-db-dev (dev)  2      billing-db-dev ← billing-api-billing-db-dev (readwrite) ← payments-api',
        '',
      ].join('\n'),
    )
  })

  it('the dependency between payments-api and billing-db-dev: one path, through the readwrite right', async () => {
    const { code, out } = await run([
      'relations',
      'payments-api',
      '--to',
      'billing-db-dev',
      '--repo',
      OWNER,
    ])
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'component:default/payments-api',
        '',
        'paths to resource:default/billing-db-dev (1)',
        '  payments-api → billing-api-billing-db-dev (readwrite) → billing-db-dev',
        '    STEP                                         TYPE             ENV  ACCESS',
        '    component:default/payments-api               service          -',
        '    resource:default/billing-api-billing-db-dev  database-access  dev  readwrite',
        '    resource:default/billing-db-dev              database         dev',
        '',
      ].join('\n'),
    )
  })

  it('a right with no level and a target declared nowhere, on the path they are on', async () => {
    const { code, out } = await run(['relations', 'billing-api', '--consumes', '--repo', OWNER])
    expect(code).toBe(0)
    const lines = out.split('\n')
    const missing = lines.find((line) => line.includes('resource:default/payments-api'))
    // Declared nowhere: no type, no environment; the right over it states no level.
    expect(missing).toMatch(/^ {2}resource:default\/payments-api +- +- +- +resource:default\/billing-api-to-payments \(prod\) +2 +/)
    expect(missing).toContain(
      'billing-api → billing-api-to-payments → payments-api — declared nowhere; component:default/payments-api has this name',
    )
  })
})

describe('each row says what its own entity is, and what the right on its path grants', () => {
  const service = (name: string): Entity => ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name, annotations: {} },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  })
  const resource = (name: string, type: string, env: string, spec: Record<string, unknown> = {}): Entity =>
    ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name, annotations: { 'company.fr/env': env } },
      spec: { type, owner: 'group:default/tiger', ...spec },
    }) as Entity
  // A right declared in dev over a database declared in prod: what the file
  // says, inconsistent as it is, and what the table must not paper over.
  const crossed = EntityGraph.from([
    service('app'),
    resource('db-prod', 'database', 'prod', { dependsOn: ['resource:default/host-prod'] }),
    resource('host-prod', 'database', 'prod'),
    resource('app-db', 'database-access', 'dev', {
      access: 'read',
      dependsOn: ['resource:default/db-prod'],
      dependencyOf: ['component:default/app'],
    }),
  ])

  it("consumes: the object's own environment, the right's beside the right", () => {
    const { text } = runRelations(crossed, { query: 'app', relation: 'consumes' })
    const row = text.split('\n').find((line) => line.startsWith('  resource:default/db-prod'))
    expect(row).toMatch(/^ {2}resource:default\/db-prod +database +prod +read +resource:default\/app-db \(dev\) +2 +/)
  })

  it('consumed-by: the service has no environment of its own; the right is dev', () => {
    const { text } = runRelations(crossed, { query: 'db-prod', relation: 'consumed-by' })
    const row = text.split('\n').find((line) => line.startsWith('  component:default/app'))
    expect(row).toMatch(/^ {2}component:default\/app +service +- +read +resource:default\/app-db \(dev\) +2 +/)
  })

  it('past the object a right is over, no level: the right grants nothing on the host', () => {
    const { text } = runRelations(crossed, { query: 'app', relation: 'consumes', depth: 3 })
    const row = text.split('\n').find((line) => line.startsWith('  resource:default/host-prod'))
    // The ACCESS cell is empty; the path still shows the level where it is declared.
    expect(row).toMatch(/^ {2}resource:default\/host-prod +database +prod +resource:default\/app-db \(dev\) +3 +app → app-db \(read\) → db-prod → host-prod$/)
  })

  it("the owner's host, at depth 3: listed without the right's level", async () => {
    const { out } = await run(['relations', 'payments-api', '--consumes', '--depth', '3', '--repo', OWNER])
    const row = out.split('\n').find((line) => line.startsWith('  resource:default/mysql-disi6-dev'))
    expect(row).not.toContain('readwrite  ')
    expect(row).toMatch(/^ {2}resource:default\/mysql-disi6-dev +database +dev +resource:default\/billing-api-billing-db-dev \(dev\) +3 +/)
  })
})

describe('a reference declared nowhere, where the relation reaches it', () => {
  const DANGLING = path.resolve(import.meta.dirname, '../golden/dangling-shown')

  it('is a consumer, marked, beside the one it shares a name with', async () => {
    const { code, out } = await run(['relations', 'billing-db-dev', '--consumed-by', '--repo', DANGLING])
    expect(code).toBe(0)
    expect(out).toContain(
      '  component:default/payments-api  -        -    readwrite  resource:default/billing-api-billing-db-dev (dev)  2      ' +
        'billing-db-dev ← billing-api-billing-db-dev (readwrite) ← payments-api — declared nowhere; ' +
        'resource:default/payments-api has this name\n',
    )
  })

  it('is said between two entities, beside the paths and never counted as one', async () => {
    const { code, out } = await run([
      'relations',
      'resource:default/payments-api',
      '--to',
      'billing-db-dev',
      '--repo',
      DANGLING,
    ])
    // billing-api depends on both: that relates them, and is exit 0. The near
    // miss is said apart, and counted apart.
    expect(code).toBe(0)
    expect(out).toBe(
      [
        'resource:default/payments-api',
        '',
        'paths to resource:default/billing-db-dev (0)',
        '  no path where one depends on the other',
        '',
        'depend on both (1)',
        '  component:default/billing-api',
        '    payments-api ← billing-api-to-payments ← billing-api',
        '    billing-db-dev ← billing-api-billing-db-dev (readwrite) ← billing-api',
        '    STEP                                         TYPE             ENV   ACCESS',
        '    resource:default/payments-api                api              prod',
        '    resource:default/billing-api-to-payments     network-access   prod  -',
        '    component:default/billing-api                service          -',
        '    resource:default/billing-db-dev              database         dev',
        '    resource:default/billing-api-billing-db-dev  database-access  dev   readwrite',
        '',
        'near misses, declared nowhere (1)',
        '  billing-db-dev ← billing-api-billing-db-dev (readwrite) ← payments-api — declared nowhere; resource:default/payments-api has this name',
        '    STEP                                         TYPE             ENV  ACCESS',
        '    resource:default/billing-db-dev              database         dev',
        '    resource:default/billing-api-billing-db-dev  database-access  dev  readwrite',
        '    component:default/payments-api               -                -',
        '',
      ].join('\n'),
    )
  })

  it('a near miss alone is no relation: exit 1', () => {
    // A right over the database names a consumer declared nowhere that has
    // the service's name under another kind; nothing else links the two.
    const graph = EntityGraph.from([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Resource',
        metadata: { name: 'app', annotations: {} },
        spec: { type: 'api', owner: 'group:default/tiger' },
      },
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Resource',
        metadata: { name: 'db', annotations: {} },
        spec: { type: 'database', owner: 'group:default/tiger' },
      },
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Resource',
        metadata: { name: 'app-db', annotations: {} },
        spec: {
          type: 'database-access',
          access: 'read',
          owner: 'group:default/tiger',
          dependsOn: ['resource:default/db'],
          dependencyOf: ['component:default/app'],
        },
      },
    ] as Entity[])
    const result = runRelations(graph, { query: 'resource:default/app', to: 'db' })
    expect(result.found).toBe(false)
    expect(result.text).toContain('paths to resource:default/db (0)\n  no path where one depends on the other\n')
    expect(result.text).toContain('near misses, declared nowhere (1)\n')
    expect(result.text).toContain('db ← app-db (read) ← app — declared nowhere; resource:default/app has this name')
  })
})

describe('between two entities neither of which depends on the other', () => {
  it("the owner's two services: both depend on the one right that names them", async () => {
    const { code, out } = await run(['relations', 'payments-api', '--to', 'billing-api', '--repo', OWNER])
    expect(code).toBe(0)
    expect(out).toContain(
      [
        'paths to component:default/billing-api (0)',
        '  no path where one depends on the other',
        '',
        'both depend on (1)',
        '  resource:default/billing-api-billing-db-dev',
        '    payments-api → billing-api-billing-db-dev (readwrite)',
        '    billing-api → billing-api-billing-db-dev (readwrite)',
      ].join('\n'),
    )
    // The right naming component:default/payments-api where only the Resource
    // exists is said apart, and did not make the answer.
    expect(out).toContain('near misses, declared nowhere (1)')
  })

  it('two consumers of one database, on the demo SI: they meet at the database', async () => {
    const { code, out } = await run(['relations', 'reporting-worker', '--to', 'billing-api', '--demo'])
    expect(code).toBe(0)
    expect(out).toBe(await golden('reporting-worker-to-billing-api.txt'))
  })

  it('1 where they share nothing either', async () => {
    const { code, out } = await run(['relations', 'inpi-api', '--to', 'compliance-db-prod', '--demo'])
    expect(code).toBe(1)
    expect(out).toBe(
      'resource:default/inpi-api\n\npaths to resource:default/compliance-db-prod (0)\n  no path where one depends on the other\n',
    )
  })
})

describe('the demo SI, byte for byte', () => {
  it.each([
    ['billing-db-prod.txt', ['relations', 'billing-db-prod', '--demo']],
    ['mysql-prod-01-impacts.txt', ['relations', 'mysql-prod-01', '--impacts', '--demo']],
    ['billing-api-depends-on.txt', ['relations', 'billing-api', '--depends-on', '--demo']],
    ['reporting-worker-to-mysql-prod-01.txt', ['relations', 'reporting-worker', '--to', 'mysql-prod-01', '--demo']],
    ['mcp-inpi.txt', ['relations', 'component:default/mcp-inpi', '--demo']],
  ])('%s', async (file, argv) => {
    const { code, out, err } = await run(argv)
    expect(code).toBe(0)
    expect(err).toBe('reading the demo SI, a fictional company; pass --repo <directory> to read your own declarations repository\n')
    expect(out).toBe(await golden(file))
  })

  it('reads the same whatever order the entities came in', async () => {
    const loaded = await new FixtureProvider(DEMO).load()
    const graph = EntityGraph.from(loaded.entities)
    const shuffled = EntityGraph.from([...loaded.entities].reverse())
    for (const entity of loaded.entities) {
      expect(runRelations(shuffled, { query: entity.metadata.name })).toEqual(
        runRelations(graph, { query: entity.metadata.name }),
      )
    }
  })

  it('impacts of a host: the databases, the rights over them, the services behind, by depth', async () => {
    const out = await golden('mysql-prod-01-impacts.txt')
    const entities = out
      .split('\n')
      .flatMap((line) => /^ {2}((?:resource|component):default\/\S+) /.exec(line)?.[1] ?? [])
    expect(entities).toEqual([
      'resource:default/billing-db-prod',
      'resource:default/compliance-db-prod',
      'resource:default/orders-db-prod',
      'resource:default/billing-api-billing-db-prod',
      'resource:default/orders-api-orders-db-prod',
      'resource:default/reporting-billing-db-prod',
      'component:default/billing-api',
      'component:default/orders-api',
      'component:default/reporting-worker',
    ])
  })
})

describe('exit codes, and names resolved as show resolves them', () => {
  it('1 for a name that names nothing, with show’s words', async () => {
    const { code, out } = await run(['relations', 'nothing-here', '--demo'])
    expect(code).toBe(1)
    expect(out).toBe('No entity named "nothing-here".\n')
  })

  it('1 for an ambiguous name, listing the candidates rather than picking one', async () => {
    const { code, out } = await run(['relations', 'billing-db', '--demo'])
    expect(code).toBe(1)
    expect(out).toMatch(/^"billing-db" matches 5 entities:\n {2}resource:default\/billing-db-dev\n/)
    expect(out).toBe((await run(['show', 'billing-db', '--demo'])).out)
  })

  it('1 for an ambiguous --to, said of --to', async () => {
    const { code, out } = await run(['relations', 'billing-api', '--to', 'billing-db', '--demo'])
    expect(code).toBe(1)
    expect(out).toBe((await run(['show', 'billing-db', '--demo'])).out)
  })

  it('1 for a relation that holds nothing, saying none', async () => {
    const { code, out } = await run(['relations', 'billing-db-prod', '--consumes', '--demo'])
    expect(code).toBe(1)
    expect(out).toBe('resource:default/billing-db-prod\n\nconsumes (0)\n  none\n')
  })

  it('0 for two entities no path links that share a host, saying so', async () => {
    const { code, out } = await run(['relations', 'billing-api', '--to', 'orders-db-prod', '--demo'])
    expect(code).toBe(0)
    expect(out).toContain('paths to resource:default/orders-db-prod (0)\n  no path where one depends on the other\n')
    expect(out).toContain('both depend on (1)\n  resource:default/mysql-prod-01\n')
  })

  it('1 for an entity asked about its paths to itself', async () => {
    const { code, out } = await run(['relations', 'billing-api', '--to', 'component:default/billing-api', '--demo'])
    expect(code).toBe(1)
    expect(out).toBe('"billing-api" and "component:default/billing-api" are the same entity: component:default/billing-api\n')
  })

  it('1 for an entity that declares no relation at all', async () => {
    const { code, out } = await run(['relations', 'mysql-disi6-rec', '--demo'])
    expect(code).toBe(1)
    expect(out).toBe('resource:default/mysql-disi6-rec\n\nno relation declared\n')
  })

  it.each([
    [['relations'], 'relations needs a name or a reference'],
    [['relations', 'a', 'b'], 'relations takes one name or reference, not 2: a, b'],
    [['relations', 'a', '--consumes', '--impacts'], 'relations takes one of'],
    [['relations', 'a', '--consumes', '--to', 'b'], '--to asks for the paths between two entities'],
    [['relations', 'a', '--depth', '0'], '--depth takes a whole number from 1 to 100'],
    [['relations', 'a', '--depth', 'two'], '--depth takes a whole number from 1 to 100'],
    [['relations', 'a', '--depth', '101'], '--depth takes a whole number from 1 to 100'],
    [['relations', 'a', '--demo', '--repo', 'x'], 'relations takes --repo <directory> or --demo, never both'],
    [['relations', 'a', '--wat'], "Unknown option '--wat'"],
  ])('2 for %j', async (argv, message) => {
    const { code, out, err } = await run(argv)
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain(message)
  })

  it('follows --depth past the object a right is over', async () => {
    const { code, out } = await run(['relations', 'payments-api', '--consumes', '--depth', '3', '--repo', OWNER])
    expect(code).toBe(0)
    expect(out).toContain('resource:default/mysql-disi6-dev')
    expect(out).not.toContain('stopped at depth')
    expect(out).not.toContain('not listed')
  })

  it('an exact name two entities share is ambiguous, for relations and show alike', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'idp-relations-'))
    const write = async (folder: string, name: string, text: string): Promise<void> => {
      await mkdir(path.join(repo, folder), { recursive: true })
      await writeFile(path.join(repo, folder, '.witness.yml'), '# witness\n')
      await writeFile(path.join(repo, folder, `${name}.yml`), text)
    }
    const owned = ['  owner: group:default/tiger', '']
    await write('components', 'payments-api', ['---', 'apiVersion: backstage.io/v1alpha1', 'kind: Component', 'metadata:', '  name: payments-api', 'spec:', '  type: service', '  lifecycle: production', ...owned].join('\n'))
    await write('catalog/apis', 'payments-api', ['---', 'apiVersion: backstage.io/v1alpha1', 'kind: Resource', 'metadata:', '  name: payments-api', 'spec:', '  type: api', ...owned].join('\n'))
    for (const command of ['relations', 'show']) {
      const { code, out } = await run([command, 'payments-api', '--repo', repo])
      expect(code, command).toBe(1)
      expect(out, command).toBe(
        '"payments-api" matches 2 entities:\n  component:default/payments-api\n  resource:default/payments-api\n',
      )
    }
    // A full reference is never ambiguous.
    expect((await run(['relations', 'resource:default/payments-api', '--repo', repo])).out).toMatch(
      /^resource:default\/payments-api\n/,
    )
  })

  it('reads a full reference, and a name', async () => {
    const byRef = await run(['relations', 'resource:default/billing-db-prod', '--demo'])
    const byName = await run(['relations', 'billing-db-prod', '--demo'])
    expect(byRef.out).toBe(byName.out)
  })
})

describe('every bound is stated where it is printed', () => {
  const resource = (name: string, dependsOn: string[] = []): Entity => ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name, annotations: {} },
    spec: { type: 'database', owner: 'group:default/tiger', ...(dependsOn.length > 0 ? { dependsOn } : {}) },
  })
  const ref = (name: string): string => `resource:default/${name}`
  const names = (count: number, prefix: string): string[] =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, '0')}`)

  it('a row count past the bound: how many more were found', () => {
    const leaves = names(RELATION_LIMITS.rows + 50, 'leaf')
    const graph = EntityGraph.from([resource('hub', leaves.map(ref)), ...leaves.map((name) => resource(name))])
    const { text, found } = runRelations(graph, { query: 'hub', relation: 'depends-on' })
    expect(found).toBe(true)
    expect(text).toContain(`depends on (${String(RELATION_LIMITS.rows + 50)})\n`)
    expect(text.split('\n').filter((line) => line.startsWith('  resource:default/leaf'))).toHaveLength(RELATION_LIMITS.rows)
    expect(text.endsWith('\n  50 more not shown')).toBe(true)
  })

  it('a cycle: named, and not followed', () => {
    const graph = EntityGraph.from([resource('a', [ref('b')]), resource('b', [ref('a')])])
    const { text } = runRelations(graph, { query: 'a', relation: 'depends-on' })
    expect(text).toContain('\n  a cycle, not followed: a → b → a')
  })

  it('past five cycles, the rest counted', () => {
    const spokes = names(RELATION_LIMITS.cycles + 2, 'spoke')
    const graph = EntityGraph.from([
      resource('hub', spokes.map(ref)),
      ...spokes.map((name) => resource(name, [ref('hub')])),
    ])
    const { text } = runRelations(graph, { query: 'hub', relation: 'depends-on' })
    expect(text.split('\n').filter((line) => line.startsWith('  a cycle, not followed: '))).toHaveLength(
      RELATION_LIMITS.cycles,
    )
    expect(text).toContain('\n  +2 more cycles')
  })

  it('a between search that spent its budget: there may be more paths', () => {
    // Five layers of ten, each entity depending on every one of the next:
    // 10^5 paths from top to bottom, far past what one question may walk.
    const layers = Array.from({ length: 5 }, (_, layer) => names(10, `l${String(layer)}-`))
    const graph = EntityGraph.from([
      resource('top', (layers[0] as string[]).map(ref)),
      ...layers.flatMap((layer, index) =>
        layer.map((name) => resource(name, index === layers.length - 1 ? [ref('bottom')] : (layers[index + 1] as string[]).map(ref))),
      ),
      resource('bottom'),
    ])
    const { text, found } = runRelations(graph, { query: 'top', to: 'bottom' })
    expect(found).toBe(true)
    expect(text).toMatch(/\n {2}\d+ more not shown\n/)
    expect(text).toContain(`\n  the search stopped after ${String(RELATION_LIMITS.paths)} steps; there may be more paths`)
  })

  it('under an answer, a bound names the command that goes further', () => {
    const chain = EntityGraph.from(
      names(RELATION_LIMITS.depth + 2, 'n').map((name, index, all) =>
        resource(name, index < all.length - 1 ? [ref(all[index + 1] as string)] : []),
      ),
    )
    const asked = runRelations(chain, { query: 'n000', relation: 'depends-on', asked: true })
    expect(asked.text).toContain(
      `\n  stopped at depth ${String(RELATION_LIMITS.depth)}; idpa relations resource:default/n000 --depends-on --depth <n> goes further`,
    )
    expect(runRelations(chain, { query: 'n000', relation: 'depends-on' }).text).toContain(
      `\n  stopped at depth ${String(RELATION_LIMITS.depth)}; --depth <n> goes further`,
    )
  })

  it("under an answer, the owner's consumes names the command that follows the host", async () => {
    const loaded = await new FixtureProvider(OWNER).load()
    const graph = EntityGraph.from(loaded.entities)
    const { text } = runRelations(graph, { query: 'component:default/payments-api', relation: 'consumes', asked: true })
    expect(text).toContain(
      '\n  what these depend on is not listed; idpa relations component:default/payments-api --consumes --depth 3 follows it',
    )
    expect(text).not.toContain('--depth <n>')
  })
})

describe('what a file wrote is printed cleaned', () => {
  it('a hostile type, environment and name reach no terminal', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'idp-relations-'))
    const write = async (folder: string, name: string, text: string): Promise<void> => {
      await mkdir(path.join(repo, folder), { recursive: true })
      await writeFile(path.join(repo, folder, '.witness.yml'), '# witness\n')
      await writeFile(path.join(repo, folder, `${name}.yml`), text)
    }
    await write(
      'components',
      'app',
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: app',
        'spec:',
        '  type: "svc\\e[2J\\e[H+++ owned"',
        '  lifecycle: production',
        '  owner: group:default/tiger',
        '',
      ].join('\n'),
    )
    await write(
      'dependencies/access',
      'app-db',
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: app-db',
        '  annotations:',
        '    company.fr/env: "dev\\nprod\\r\\e]52;c;evil\\a"',
        'spec:',
        '  type: database-access',
        '  access: read',
        '  owner: group:default/tiger',
        '  dependsOn:',
        '    - resource:default/db',
        '  dependencyOf:',
        '    - component:default/app',
        '',
      ].join('\n'),
    )
    await write(
      'catalog/databases',
      'db',
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: db',
        'spec:',
        '  type: database',
        '  owner: group:default/tiger',
        '',
      ].join('\n'),
    )
    for (const [argv, typed] of [
      [['relations', 'db', '--repo', repo], true],
      [['relations', 'app', '--repo', repo], false],
      [['relations', 'app', '--to', 'db', '--repo', repo], true],
    ] as const) {
      const { code, out } = await run([...argv])
      expect(code).toBe(0)
      // eslint-disable-next-line no-control-regex -- asserting their absence
      expect(out).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/)
      // The service's type where the service is a row or a step, and the
      // right's environment on one line wherever the right is.
      if (typed) expect(out).toContain('svc+++ owned')
      expect(out).toContain('dev prod')
    }
  })
})

describe('the command line', () => {
  it('is a command, listed in HELP, never a phrase', () => {
    expect(COMMANDS).toContain('relations')
    expect(HELP).toMatch(/^ {2}idp-agent relations <name-or-reference>/m)
    expect(parseArguments(['relations', 'billing-api'])).toEqual({ name: 'relations', query: 'billing-api' })
    expect(parseArguments(['relations', 'billing-api', '--impacts', '--depth', '3', '--demo'])).toEqual({
      name: 'relations',
      query: 'billing-api',
      relation: 'impacts',
      depth: 3,
      demo: true,
    })
    expect(parseArguments(['relations', 'a', '--to', 'b'])).toEqual({ name: 'relations', query: 'a', to: 'b' })
    // A quoted phrase that starts with the word is still a phrase.
    expect(parseArguments(['relations of billing-api?'])).toMatchObject({ name: 'entry' })
  })

  it.each(['relation', 'relatoins', 'Relations', 'relatons'])(
    'suggests relations for %s, and calls no model',
    async (typed) => {
      const { code, err } = await run([typed])
      expect(code).toBe(2)
      expect(err).toContain(`unknown command "${typed}"; did you mean relations?`)
    },
  )

  it('a slip of relations before a name stays a phrase, and with no model says which command was meant', async () => {
    expect(parseArguments(['relation', 'billing-api', '--demo'])).toMatchObject({ name: 'entry' })
    const err: string[] = []
    const out: string[] = []
    // No client and no provider: the entry road fails before any model is chosen.
    const code = await main(['relation', 'billing-api', '--demo'], {
      env: {},
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      events: () => {},
    })
    expect(code).toBe(2)
    expect(out.join('')).toBe('')
    expect(err.join('')).toContain('no model configured')
    expect(err.join('')).toContain('"relation" is not a command; did you mean idpa relations? It needs no model')
  })

  it('a sentence that begins with a command word is not told it slipped', async () => {
    const err: string[] = []
    await main(['show me the databases', '--demo'], { env: {}, out: () => {}, err: (chunk) => void err.push(chunk), events: () => {} })
    expect(err.join('')).toContain('no model configured')
    expect(err.join('')).not.toContain('did you mean')
  })

  it('leaves a word that is not a slip a phrase', () => {
    expect(parseArguments(['related'])).toMatchObject({ name: 'entry' })
    expect(parseArguments(['release'])).toMatchObject({ name: 'entry' })
  })
})
