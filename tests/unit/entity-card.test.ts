import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'
import { parseDocuments, parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import { ARTIST_WEB } from '../support/artist-web.js'

/**
 * The owner's case: `show artist-web` printed kind, type, owner and
 * environment, and "Talk about this project" answered with counts — the
 * description, the system, the tags and the links were read and thrown away.
 * The document is Backstage's own example, owner and system in short form.
 */

const repository = async (files: Record<string, string> = {}): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'idp-entity-card-'))
  await mkdir(path.join(root, 'catalog/apis'), { recursive: true })
  await writeFile(path.join(root, 'catalog/apis/api-1.yml'), ARTIST_WEB)
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(root, 'catalog/apis', name), text)
  }
  return root
}

const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

/** The Supervisor says QUESTION; the Analyst chooses the overview, and writes none of it. */
const choosingOverview = (): LlmClient => {
  const turns: GenerateResult[] = [
    saying('QUESTION'),
    {
      text: 'This project is a thriving platform.',
      toolCalls: [{ id: 'c1', name: 'answer', args: { outcome: 'overview' } }],
      finishReason: 'tool-calls',
    },
  ]
  let index = 0
  return { generate: async () => turns[index++] ?? saying('') }
}

const run = async (argv: string[], client?: LlmClient) => {
  const io = { out: [] as string[], err: [] as string[] }
  const code = await main(argv, {
    ...(client === undefined ? {} : { client }),
    out: (chunk) => io.out.push(chunk),
    err: (chunk) => io.err.push(chunk),
    events: () => {},
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

describe("artist-web, the owner's own case", () => {
  it('reads back as itself once serialised, links and system included', () => {
    const { entities, rejections } = parseDocuments(ARTIST_WEB)
    expect(rejections).toEqual([])
    const [entity] = entities
    expect(entity?.spec.system).toBe('system:default/public-websites')
    expect(entity?.metadata.links).toHaveLength(1)
    expect(parseEntity(serializeEntity(entity!))).toEqual(entity)
  })

  it('show says what it is: its description, its system, its tags and its links', async () => {
    const { code, out, err } = await run(['show', 'artist-web', '--repo', await repository()])
    expect(err).not.toContain('skipped')
    expect(code).toBe(0)
    expect(out).toContain('  owner        group:default/artist-relations-team\n')
    expect(out).toContain('  description  The place to be, for great artists\n')
    expect(out).toContain('  system       system:default/public-websites\n')
    expect(out).toContain('  tags         java\n')
    expect(out).toContain('\nlinks\n  Admin Dashboard — https://admin.example-org.com\n')
  })

  it('"Talk about this project" says what the catalogue contains, in its own words', async () => {
    const { code, out } = await run(
      ['ask', '--repo', await repository(), 'Talk about this project'],
      choosingOverview(),
    )
    expect(code).toBe(0)
    expect(out).toMatch(/^systems\n {2}system:default\/public-websites {2}1$/m)
    expect(out).toMatch(/^tags\n {2}java {2}1$/m)
    expect(out).toMatch(
      /^entities {2}1 of 1 carries a description\n {2}component:default\/artist-web {2}The place to be, for great artists$/m,
    )
    expect(out).not.toContain('thriving')
  })
})

describe('the read commands, on a file that writes escapes into its own rejection', () => {
  // eslint-disable-next-line no-control-regex -- asserting their absence
  const CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/
  /** A clipboard write (OSC 52) and a clear-screen, in a key and in a file name. */
  const HOSTILE = '\u001B]52;c;ZXZpbA==\u0007\u001B[2J'
  const rejected = ARTIST_WEB.replace('  name: artist-web', '  name: bad').replace(
    '    example.com/service-discovery: artistweb',
    `    "k${HOSTILE}": 5`,
  )

  it.each([
    ['show', 'artist-web'],
    ['graph'],
  ])('%s cleans the skipped line: the reason quotes a key the file wrote', async (...argv) => {
    const root = await repository({ [`bad${HOSTILE}.yml`]: rejected })
    const { err } = await run([...argv, '--repo', root])
    expect(err).toMatch(/^skipped catalog\/apis\/bad\S*\.yml: metadata\.annotations\.k/m)
    expect(err.split('\n').filter((line) => line.startsWith('skipped'))).toHaveLength(1)
    expect(err).not.toMatch(CONTROLS)
  })

  it('validate cleans its violation lines the same way', async () => {
    const root = await repository({ [`bad${HOSTILE}.yml`]: rejected })
    const { code, out } = await run(['validate', root])
    expect(code).toBe(1)
    expect(out).toMatch(/^error {3}catalog\/apis\/bad\S*\.yml: metadata\.annotations\.k/m)
    expect(out).not.toMatch(CONTROLS)
  })
})
