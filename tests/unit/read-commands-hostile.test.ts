import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'

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
