import { describe, expect, it } from 'vitest'
import { paintDiff } from '../../src/cli/render/diff.js'
import { renderTable } from '../../src/cli/render/table.js'
import { ENTITY_LIMITS, renderEntityDetail } from '../../src/cli/render/entity.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import type { Entity } from '../../src/core/schemas/entity.js'

describe('renderTable', () => {
  it('aligns columns to the widest cell', () => {
    // Asserting the exact run of spaces would mean counting them by hand and
    // getting it wrong; assert the alignment itself.
    const lines = renderTable(['NAME', 'ENV'], [['a', 'dev'], ['longer-name', 'prod']]).split('\n')
    expect(lines).toHaveLength(3)
    const column = lines[0]?.indexOf('ENV')
    expect(lines[1]?.indexOf('dev')).toBe(column)
    expect(lines[2]?.indexOf('prod')).toBe(column)
    expect(lines[2]?.startsWith('longer-name  ')).toBe(true)
  })

  it('renders headers alone when there are no rows', () => {
    expect(renderTable(['NAME'], [])).toBe('NAME')
  })

  it('never pads the last column, so no line carries trailing space', () => {
    const output = renderTable(['A', 'B'], [['x', 'y']])
    expect(output.split('\n').every((line) => line === line.trimEnd())).toBe(true)
  })
})

describe('renderEntityDetail', () => {
  const db: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name: 'billing-db-dev', annotations: { 'company.fr/env': 'dev' } },
    spec: { type: 'database', owner: 'group:default/tiger' },
  }

  it('states what is known', () => {
    const output = renderEntityDetail(EntityGraph.from([db]), db)
    expect(output).toContain('billing-db-dev')
    expect(output).toContain('database')
    expect(output).toContain('group:default/tiger')
    expect(output).toContain('dev')
  })

  it('says an environment is undeclared rather than guessing one', () => {
    const bare: Entity = { ...db, metadata: { name: 'x', annotations: {} } }
    expect(renderEntityDetail(EntityGraph.from([bare]), bare)).toContain('undeclared')
  })

  it('states the level a right grants, and says undeclared rather than guessing one', () => {
    // A grant whose level nobody can read is a grant nobody can review, and
    // `show` is where a human reads one. Printing nothing would read as "no
    // level was asked for"; the two are not the same fact (design 4.1).
    const granting: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-api-billing-db-dev', annotations: { 'company.fr/env': 'dev' } },
      spec: { type: 'database-access', access: 'read', owner: 'group:default/tiger' },
    }
    const unstated: Entity = {
      ...granting,
      metadata: { name: 'billing-api-to-payments', annotations: {} },
      spec: { type: 'network-access', owner: 'group:default/tiger' },
    }

    expect(renderEntityDetail(EntityGraph.from([granting]), granting)).toContain('access       read')
    expect(renderEntityDetail(EntityGraph.from([unstated]), unstated)).toContain(
      'access       (undeclared)',
    )
  })

  it('says nothing about an access level on an object, which has none to have', () => {
    // The line exists for a right. A database is not a grant, and a row saying
    // its access is undeclared would invent a question about it.
    expect(renderEntityDetail(EntityGraph.from([db]), db)).not.toContain('access ')
  })

  it('states the environment of every resource it lists, since dev and prod are two rights', () => {
    // A service lists accesses from several environments at once, and being
    // authorised in dev grants nothing in prod (design 4.1). Reading it off the
    // name would be reading a convention instead of the declaration.
    const service: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'billing-api', annotations: {} },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    }
    const accessIn = (env: string): Entity => ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: `billing-api-db-${env}`, annotations: { 'company.fr/env': env } },
      spec: {
        type: 'database-access', access: 'read',
        owner: 'group:default/tiger',
        dependencyOf: ['component:default/billing-api'],
      },
    })
    const graph = EntityGraph.from([service, accessIn('dev'), accessIn('prod')])
    const listed = renderEntityDetail(graph, service)
      .split('\n')
      .filter((line) => line.includes('billing-api-db-'))

    expect(listed).toHaveLength(2)
    expect(listed[0]?.endsWith('dev')).toBe(true)
    expect(listed[1]?.endsWith('prod')).toBe(true)
  })
})

describe('renderEntityDetail, on what an entity is', () => {
  const artistWeb: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'artist-web',
      description: 'The place to be, for great artists',
      annotations: {},
      tags: ['java'],
      links: [
        {
          url: 'https://admin.example-org.com',
          title: 'Admin Dashboard',
          icon: 'dashboard',
          type: 'admin-dashboard',
        },
      ],
    },
    spec: {
      type: 'website',
      lifecycle: 'production',
      owner: 'group:default/artist-relations-team',
      system: 'system:default/public-websites',
    },
  }
  const card = (entity: Entity): string => renderEntityDetail(EntityGraph.from([entity]), entity)

  it('says what it is: its description, its system, its tags and its links', () => {
    expect(card(artistWeb)).toBe(
      [
        'component:default/artist-web',
        '',
        '  kind         Component',
        '  type         website',
        '  owner        group:default/artist-relations-team',
        '  environment  (undeclared)',
        '  description  The place to be, for great artists',
        '  system       system:default/public-websites',
        '  tags         java',
        '',
        'links',
        '  Admin Dashboard — https://admin.example-org.com',
        '',
        'depends on',
        '  none',
        '',
        'used by',
        '  none',
      ].join('\n'),
    )
  })

  it('omits each line an entity has nothing for, rather than printing it empty', () => {
    const bare: Entity = {
      ...artistWeb,
      metadata: { name: 'artist-web', annotations: {}, tags: [], links: [] },
      spec: { type: 'website', lifecycle: 'production', owner: 'group:default/tiger' },
    }
    const text = card(bare)
    expect(text).not.toMatch(/description|system|tags|links/)
    expect(text.split('\n').slice(0, 7)).toEqual([
      'component:default/artist-web',
      '',
      '  kind         Component',
      '  type         website',
      '  owner        group:default/tiger',
      '  environment  (undeclared)',
      '',
    ])
  })

  it('prints a link with no title as its url alone', () => {
    const untitled: Entity = {
      ...artistWeb,
      metadata: { ...artistWeb.metadata, links: [{ url: 'https://x.example' }] },
    }
    expect(card(untitled)).toContain('\nlinks\n  https://x.example\n')
  })

  it('bounds the description to one line, the tags and the links to a few', () => {
    const long: Entity = {
      ...artistWeb,
      metadata: {
        ...artistWeb.metadata,
        description: `first line\nsecond line ${'word '.repeat(200)}`,
        tags: Array.from({ length: 14 }, (_, index) => `tag-${String(index)}`),
        links: Array.from({ length: 8 }, (_, index) => ({
          url: `https://example.org/${String(index)}`,
          title: `Link ${String(index)}`,
        })),
      },
    }
    const lines = card(long).split('\n')
    const description = lines.find((line) => line.startsWith('  description'))
    expect(description).toMatch(/^ {2}description {2}first line second line word/)
    expect(description?.endsWith('…')).toBe(true)
    expect(description!.length).toBeLessThanOrEqual(15 + ENTITY_LIMITS.text + 1)

    const tags = lines.find((line) => line.startsWith('  tags'))
    expect(tags).toBe(
      `  tags         ${Array.from({ length: ENTITY_LIMITS.tags }, (_, index) => `tag-${String(index)}`).join(', ')}, +${String(14 - ENTITY_LIMITS.tags)} more`,
    )

    const links = lines.slice(lines.indexOf('links') + 1, lines.indexOf('depends on') - 1)
    expect(links).toHaveLength(ENTITY_LIMITS.links + 1)
    expect(links.at(-1)).toBe(`  +${String(8 - ENTITY_LIMITS.links)} more`)
  })

  it('leaves out a tag, a system or a link that is nothing once cleaned', () => {
    // Checked after cleaning, not before: a tag that is only a clear-screen is
    // no tag, and printing it would leave a bare separator and a trailing space.
    const blank: Entity = {
      ...artistWeb,
      metadata: {
        ...artistWeb.metadata,
        tags: ['\u001B[2J', 'a,b', '', '   '],
        links: [
          { url: '\u001B[2J', title: 't0' },
          { url: '   ', title: 't1' },
          { url: 'https://x.example' },
        ],
      },
      spec: { ...artistWeb.spec, system: '  \u001B[2J ' },
    }
    const text = card(blank)
    expect(text).toContain('  tags         a,b\n')
    expect(text).toContain('\nlinks\n  https://x.example\n\n')
    expect(text).not.toMatch(/t0|t1|system/)
    expect(text.split('\n').every((line) => line === line.trimEnd())).toBe(true)

    const nothing: Entity = {
      ...blank,
      metadata: { ...blank.metadata, tags: ['', '\u0007'], links: [{ url: '\u009B' }] },
    }
    expect(card(nothing)).not.toMatch(/tags|links/)
  })

  it('prints a link whole, never a shortened address, and says when one is too long to print', () => {
    // A cut URL is a different URL, and a terminal that makes it a link
    // follows the wrong one.
    const long = `https://example.org/${'a'.repeat(400)}`
    const huge = `https://example.org/${'b'.repeat(ENTITY_LIMITS.url)}`
    const linked: Entity = {
      ...artistWeb,
      metadata: {
        ...artistWeb.metadata,
        links: [
          { url: long, title: 'Long' },
          { url: huge, title: 'Huge' },
        ],
      },
    }
    const text = card(linked)
    expect(text).toContain(`\n  Long — ${long}\n`)
    expect(text).toContain(
      `\n  Huge — (a URL of ${String([...huge].length)} characters, too long to print)\n`,
    )
    expect(text).not.toContain('bbbb')
  })

  it('removes everything a terminal would obey from what the file wrote', () => {
    // Every string on the card came from a repository file, and a terminal
    // obeys what is in it: a clear-screen, a clipboard write (OSC 52), an
    // 8-bit CSI, a carriage return over the line already printed.
    const hostile: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: 'artist-web',
        description: 'great\u001B[2J\u001B[H+++ b/fake.yml\r0 violations',
        annotations: { 'company.fr/env': 'prod\u001B[31m' },
        tags: ['java\u001B]52;c;ZXZpbA==\u0007', 're\u009Bd'],
        links: [
          { url: 'https://x.example/\u001B]8;;https://evil.example\u0007', title: 'Ad\u0085min\u001B[1m' },
        ],
      },
      spec: {
        type: 'web\u001B[2Jsite',
        lifecycle: 'production',
        owner: 'group:default/tiger',
        system: 'system:default/public-websites',
      },
    }
    const text = card(hostile)
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
    expect(text).toContain('  type         website')
    expect(text).toContain('  environment  prod')
    expect(text).toContain('  description  great+++ b/fake.yml0 violations')
    expect(text).toContain('  tags         java, red')
    expect(text).toContain('  Admin — https://x.example/')
    expect(text.split('\n').every((line) => line === line.trimEnd())).toBe(true)
  })
})

describe('paintDiff', () => {
  const RED = '\u001B[31m'
  const BOLD = '\u001B[1m'

  it('paints a removed document marker as a removal, not as a file header', () => {
    // Every entity document in this repository starts with `---`, so a removed
    // one is `----`: four dashes. Testing `startsWith('---')` claimed it as a
    // file header and painted it bold — the likeliest removal line there is,
    // shown as though the header itself had changed.
    const painted = paintDiff('--- a/x.yml\n+++ b/x.yml\n@@ -1,1 +0,0 @@\n----\n', true)
    const lines = painted.split('\n')

    expect(lines[0]?.startsWith(BOLD)).toBe(true)
    expect(lines[3]?.startsWith(RED)).toBe(true)
  })

  it('still paints the file headers bold', () => {
    const painted = paintDiff('--- /dev/null\n+++ b/x.yml\n', true)

    expect(painted.split('\n')[0]?.startsWith(BOLD)).toBe(true)
  })
})
