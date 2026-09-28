import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { REASON_LENGTH, REASONS, REFS, VALUE_LENGTH, VALUES } from '../../src/cli/render/catalogue-read.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * SECURITY.md: what a repository file wrote reaches the terminal with nothing a
 * terminal obeys. The cleaning is applied where each text is printed, not on
 * the stream, so each command that prints repository text is driven here
 * through `main` against a repository whose every free-text field carries an
 * erase-screen, a cursor move, an OSC 52 clipboard write, a C1 CSI, a bell and
 * a carriage return — and its whole output, stdout and stderr, is searched for
 * any byte of C0 but the line feed, DEL or C1. `ask` is driven the same way on
 * a scripted model whose sentences carry the same bytes. `plan` and `relations`
 * have theirs in `plan-project.test.ts` and `relations-command.test.ts`.
 */

const HOSTILE = '\\e[2J\\e[H\\e]52;c;ZXZpbA==\\a\\u009b31m\\r'

let repo: string

const write = async (folder: string, name: string, lines: string[]): Promise<void> => {
  await mkdir(path.join(repo, folder), { recursive: true })
  await writeFile(path.join(repo, folder, '.witness.yml'), '# witness\n')
  await writeFile(path.join(repo, folder, `${name}.yml`), [...lines, ''].join('\n'))
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'idp-hostile-'))
  await write('components', 'app', [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    '  name: app',
    `  title: "App${HOSTILE}"`,
    `  description: "serves${HOSTILE}everyone"`,
    '  tags:',
    `    - "tag${HOSTILE}"`,
    '  links:',
    '    - url: https://example.com',
    `      title: "docs${HOSTILE}"`,
    'spec:',
    `  type: "svc${HOSTILE}"`,
    '  lifecycle: production',
    '  owner: group:default/tiger',
    '  dependsOn:',
    '    - resource:default/db',
  ])
  await write('catalog/databases', 'db', [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: db',
    `  description: "the${HOSTILE}database"`,
    '  annotations:',
    `    company.fr/env: "dev${HOSTILE}"`,
    'spec:',
    '  type: database',
    '  owner: group:default/tiger',
  ])
})

afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
})

/** None of these reads a model. */
const untouchable: LlmClient = {
  generate: () => {
    throw new Error('a read command called a model')
  },
}

const run = async (argv: string[]): Promise<{ code: number; text: string }> => {
  const chunks: string[] = []
  const code = await main(argv, {
    env: {},
    client: untouchable,
    out: (chunk) => void chunks.push(chunk),
    err: (chunk) => void chunks.push(chunk),
    events: () => {},
  })
  return { code, text: chunks.join('') }
}

describe('what a repository file wrote, as the read commands print it', () => {
  it.each([
    ['show', 'app'],
    ['show', 'db'],
    ['graph'],
    ['graph', '--kind', 'Resource'],
    ['validate'],
  ])('%s %s reaches no terminal with a byte it obeys', async (...argv) => {
    const args = argv[0] === 'validate' ? ['validate', repo] : [...argv, '--repo', repo]
    const { text } = await run(args)
    // Not vacuous: the entity was read and printed.
    expect(text.length).toBeGreaterThan(0)
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
  })

  it('ask: the overview it prints and the model sentences around it reach no terminal with a byte it obeys', async () => {
    // The model's sentences are free text too: ESC and C1 in JSON arrive as
    // the bytes themselves once the arguments are parsed.
    const turn: GenerateResult = {
      text: '',
      toolCalls: [
        {
          id: 'call-answer',
          name: 'answer',
          args: {
            outcome: 'overview',
            intro: 'Here is the overview.\u001b[2J\u001b]52;c;ZXZpbA==\u0007',
            conclusion: 'That is all\u009b31m.\r',
          },
        },
      ],
      finishReason: 'tool-calls',
    }
    const scripted: LlmClient = {
      generate: async (request) =>
        request.agent === 'supervisor'
          ? { text: 'QUESTION', toolCalls: [], finishReason: 'stop' }
          : turn,
    }
    const chunks: string[] = []
    const code = await main(['ask', 'what is there?', '--repo', repo], {
      env: {},
      client: scripted,
      out: (chunk) => void chunks.push(chunk),
      err: (chunk) => void chunks.push(chunk),
      events: () => {},
    })
    const text = chunks.join('')
    expect(code, text).toBe(0)
    expect(text).toContain('svc')
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
  })

  it('still prints the words around what it removed', async () => {
    const { text } = await run(['show', 'app', '--repo', repo])
    expect(text).toContain('app')
    expect(text).toMatch(/serves.*everyone/)
  })
})

describe('what a catalogue served, as the read commands print it', () => {
  // The same bytes as the file's, as the JSON a catalogue serves carries them:
  // parsed, they are the control characters themselves.
  const BYTES = '\u001b[2J\u001b[H\u001b]52;c;ZXZpbA==\u0007\u009b31m\r'
  const LONG = `ns${BYTES}${'x'.repeat(10_000)}`
  const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'
  const where = (name: string): string => `url:https://github.com/acme/si/blob/main/${name}${BYTES}.yaml`

  const item = (kind: string, name: string, spec: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    apiVersion: 'backstage.io/v1alpha1',
    kind,
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${kind}-${name}-${String(metadata['namespace'] ?? '')}`.slice(0, 64),
      annotations: { 'backstage.io/managed-by-location': where(name) },
      ...metadata,
    },
    spec,
  })

  const served = [
    item(
      'Component',
      'app',
      {
        type: `svc${BYTES}`,
        lifecycle: 'production',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/db', 'resource:default/gone'],
      },
      {
        title: `App${BYTES}`,
        description: `serves${BYTES}everyone`,
        tags: [`tag${BYTES}`],
        links: [{ url: 'https://example.com', title: `docs${BYTES}` }],
      },
    ),
    item('Resource', 'db', { type: 'database', owner: 'group:default/tiger' }, {
      description: `the${BYTES}database`,
      annotations: { 'backstage.io/managed-by-location': where('db'), 'company.fr/env': `dev${BYTES}` },
    }),
    // Set aside by the pre-pass: a namespace, a lifecycle, a Resource type.
    item('Component', 'far', { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' }, { namespace: LONG }),
    item('Component', 'young', { type: 'service', lifecycle: `beta${BYTES}`, owner: 'group:default/tiger' }),
    item('Resource', 'odd', { type: `queue${BYTES}`, owner: 'group:default/tiger' }),
    // Skipped by the reader: an owner that is no reference, which its reason quotes.
    item('Component', 'bad', { type: 'service', lifecycle: 'production', owner: `group:default/ti ger${BYTES}` }),
    // A kind this tool does not model, read as refs.
    item('Group', 'tiger', { type: 'team', children: [] }),
  ]

  const run = async (argv: string[], entities: readonly Record<string, unknown>[] = served) => {
    const chunks: string[] = []
    const catalogue = fakeBackstage({ entities })
    const scripted: LlmClient = {
      generate: async (request) =>
        request.agent === 'supervisor'
          ? { text: 'QUESTION', toolCalls: [], finishReason: 'stop' }
          : { text: '', toolCalls: [{ id: 'a', name: 'answer', args: { outcome: 'overview' } }], finishReason: 'tool-calls' },
    }
    const code = await main(argv, {
      env: { IDP_BACKSTAGE_URL: LOOPBACK },
      client: scripted,
      catalogueFetch: catalogue.fetch,
      out: (chunk) => void chunks.push(chunk),
      err: (chunk) => void chunks.push(chunk),
      events: () => {},
    })
    return { code, text: chunks.join(''), sent: catalogue.sent }
  }

  it.each([['graph'], ['show', 'app'], ['show', 'db'], ['relations', 'app'], ['ask', 'what is there?']])(
    '%s %s reaches no terminal with a byte it obeys, and no grouped line past its bound',
    async (...argv) => {
      const { code, text, sent } = await run(argv)
      expect(code, text).toBe(0)
      // Not vacuous: the catalogue was read, and what it said was printed.
      expect(sent.length).toBeGreaterThan(0)
      expect(text).toMatch(/set aside by the catalogue read: /)
      expect(text).toMatch(/skipped 1: /)
      // eslint-disable-next-line no-control-regex -- asserting their absence
      expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
      for (const line of text.split('\n')) {
        if (/^(set aside by the catalogue read|skipped)/.test(line)) expect(line.length, line.slice(0, 80)).toBeLessThan(2000)
      }
      expect(text).not.toContain('x'.repeat(200))
    },
  )

  it('holds each grouped line to the bounds catalogue-read.ts states, however much was set aside or skipped', async () => {
    // More distinct values than a group lists, more refs than a line names,
    // more reasons than get a line: every bound is reached.
    // A value cut at its bound ends on the ellipsis that says so.
    const CUT = (bound: number): number => bound + 1
    const young = Array.from({ length: VALUES + 3 }, (_, index) =>
      item('Component', `young-${String(index)}`, {
        type: 'service',
        lifecycle: `beta${BYTES}${String(index)}${'y'.repeat(200)}`,
        owner: 'group:default/tiger',
      }),
    )
    // Eight ways a Component is skipped, each its own reason, each twice.
    const broken: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ owner: 3 }, {}],
      [{ owner: `group:default/ti ger${BYTES}${'z'.repeat(400)}` }, {}],
      [{ dependsOn: 'resource:default/db' }, {}],
      [{ dependsOn: [`resource:default/d b${BYTES}`] }, {}],
      [{ type: 3 }, {}],
      [{}, { tags: 'one' }],
      [{}, { links: 'https://example.com' }],
      // A reason that names the key it refused: past its own bound.
      [{}, { labels: { [`l${BYTES}${'l'.repeat(400)}`]: 3 } }],
    ]
    const refused = broken.flatMap(([spec, metadata], index) =>
      [0, 1].map((twice) =>
        item(
          'Component',
          `bad-${String(index)}-${String(twice)}`,
          { type: 'service', lifecycle: 'production', owner: 'group:default/tiger', ...spec },
          metadata,
        ),
      ),
    )

    const { code, text } = await run(['graph'], [...served, ...young, ...refused])
    expect(code, text).toBe(0)
    const lines = text.split('\n')
    const [aside, ...others] = lines.filter((line) => line.startsWith('set aside by the catalogue read: '))
    expect(others).toEqual([])
    const [groups = '', first = ''] = (aside ?? '').slice('set aside by the catalogue read: '.length).split('; first: ')
    const listings = [...groups.matchAll(/\d+ [a-z ]+ \(([^()]*)\)/g)].map((match) => match[1] ?? '')
    expect(listings.length).toBeGreaterThan(0)
    for (const listing of listings) {
      const values = listing.split(', ').filter((each) => !/^and \d+ more$/.test(each))
      expect(values.length).toBeLessThanOrEqual(VALUES)
      for (const each of values) expect([...each.replace(/ ×\d+$/, '')].length).toBeLessThanOrEqual(CUT(VALUE_LENGTH))
    }
    expect(listings.some((listing) => /, and \d+ more$/.test(listing))).toBe(true)
    expect(first.split(', ')).toHaveLength(REFS + 1)
    expect(first.endsWith(', …')).toBe(true)
    for (const ref of first.split(', ')) expect([...ref].length).toBeLessThanOrEqual(CUT(VALUE_LENGTH))
    const skipped = lines.filter((line) => /^skipped \d+: /.test(line))
    expect(skipped).toHaveLength(REASONS)
    expect(lines.filter((line) => /^skipped \d+ more, for \d+ other reasons?$/.test(line))).toHaveLength(1)
    for (const line of skipped) {
      const open = line.lastIndexOf(' (')
      const reason = line.slice(line.indexOf(': ') + 2, open)
      expect([...reason].length).toBeLessThanOrEqual(CUT(REASON_LENGTH))
      const refs = line.slice(open + 2, -1).split(', ')
      expect(refs.length).toBeLessThanOrEqual(REFS + 1)
      for (const ref of refs) expect([...ref].length).toBeLessThanOrEqual(CUT(VALUE_LENGTH))
    }
  })

  it('ends the run on one cleaned line for a kind the grammar refuses', async () => {
    const { code, text } = await run(['graph'], [...served, item(`Us${BYTES}er`, 'ada', {})])
    expect(code).toBe(1)
    expect(text.trimEnd().split('\n')).toHaveLength(1)
    expect(text).toMatch(/^the Backstage catalogue at 127\.0\.0\.1:7007 \(IDP_BACKSTAGE_URL\) named a kind/)
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
  })
})
