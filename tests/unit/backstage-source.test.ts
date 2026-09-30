import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { main, parseArguments, type MainDeps } from '../../src/cli/index.js'
import { shownUrl } from '../../src/cli/source.js'
import type { CatalogueFetch } from '../../src/context/backstage/transport.js'
import type { AgentName, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Sent } from '../support/fake-backstage.js'

/**
 * The catalogue's settings, checked before any request (docs/backstage-http-brief.md
 * § 8, § 10): the URL comes from `IDP_BACKSTAGE_URL` or `backstage:` in the
 * personal `config.yml` and from nowhere else, is refused on exit 2 when it
 * could aim the token anywhere but a catalogue API's base, and a refusal
 * never quotes what could be a credential. The token comes from
 * `IDP_BACKSTAGE_TOKEN` alone, and a host that is not this machine is never
 * read without one.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const EXAMPLES = path.resolve(import.meta.dirname, '../../examples')
const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'
const REMOTE = 'https://backstage.acme.example/api/catalog'
const CANARY = 'canary-secret-0123456789'
const SPACED = /\(a value of \d+ characters with a space or a control character in it\)/

interface Ran {
  code: number
  out: string
  err: string
  catalogue: { sent: Sent[] }
}

const run = async (
  argv: string[],
  deps: MainDeps & { env: Record<string, string | undefined>; token?: string } = { env: {} },
): Promise<Ran> => {
  const { token, ...rest } = deps
  const catalogue = fakeBackstage({ entities: catalogueOf(DEMO), ...(token === undefined ? {} : { token }) })
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    root: DEMO,
    catalogueFetch: catalogue.fetch,
    ...rest,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: () => {},
  })
  return { code, out: out.join(''), err: err.join(''), catalogue }
}

/** A HOME holding `~/.config/idp-agent/config.yml` with `text`. */
const home = async (text: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'backstage-source-'))
  const file = path.join(directory, '.config', 'idp-agent', 'config.yml')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return directory
}

const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `c-${name}`, name, args }],
  finishReason: 'tool-calls',
})
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

/** Scripted turns per agent. */
const scripted = (turns: Partial<Record<AgentName, readonly GenerateResult[]>>): LlmClient => {
  const spent = new Map<AgentName, number>()
  return {
    generate: async (request) => {
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? saying('')
    },
  }
}

/** What the Inspector reports of the application repository. */
const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [],
}

/** A `fetch` no request may reach. */
const untouchable: CatalogueFetch = async () => {
  throw new Error('the catalogue was requested')
}

describe('the catalogue URL, checked before any request', () => {
  it.each([
    ['not a URL', 'backstage', /does not parse/],
    ['the token where the URL goes', CANARY, /a value of 24 characters that does not parse as a URL/],
    ['http to a host that is not loopback', 'http://backstage.acme.example/api/catalog', /https:, or http: to 127\.0\.0\.1, ::1 or localhost/],
    ['userinfo', `https://me:${CANARY}@backstage.acme.example/api/catalog`, /userinfo/],
    ['a query', `https://backstage.acme.example/api/catalog?token=${CANARY}`, /query/],
    ['a bare query mark', 'https://backstage.acme.example/api/catalog?', /query/],
    ['a fragment', `https://backstage.acme.example/api/catalog#${CANARY}`, /fragment/],
    ['a dot segment', 'https://backstage.acme.example/api/./catalog', /segment/],
    ['a dot-dot segment', 'https://backstage.acme.example/api/../catalog', /segment/],
    ['an encoded dot-dot segment', 'https://backstage.acme.example/api/%2e%2e/catalog', /segment/],
    ['an encoded dot segment', 'https://backstage.acme.example/api/%2E/catalog', /segment/],
    ['a backslash', 'https://backstage.acme.example\\api\\catalog', /\\/],
    ['an empty segment', 'https://backstage.acme.example/api/catalog/', /segment/],
    ['no path', 'https://backstage.acme.example', /catalogue API's base/],
    // A URL parser drops a leading or trailing space or control character,
    // and every tab and line break: the userinfo it finds is not where the
    // text as typed puts it.
    ['userinfo behind a leading space', ` https://me:${CANARY}@backstage.acme.example/api/catalog`, SPACED],
    ['userinfo behind a leading tab', `\thttps://me:${CANARY}@backstage.acme.example/api/catalog`, SPACED],
    ['userinfo behind a tab inside the scheme', `ht\ttps://me:${CANARY}@backstage.acme.example/api/catalog`, SPACED],
    ['userinfo behind a line break between the slashes', `https:/\n/me:${CANARY}@backstage.acme.example/api/catalog`, SPACED],
    ['userinfo before a trailing line break', `https://me:${CANARY}@backstage.acme.example/api/catalog\n`, SPACED],
  ])('refuses %s with 2, naming IDP_BACKSTAGE_URL, before any request, quoting no secret', async (_, url, why) => {
    const { code, out, err, catalogue } = await run(['graph'], { env: { IDP_BACKSTAGE_URL: url, IDP_BACKSTAGE_TOKEN: 't' } })
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toMatch(/^IDP_BACKSTAGE_URL=/)
    expect(err).toMatch(why)
    expect(err).not.toContain(CANARY)
    expect(err.trimEnd().split('\n')).toHaveLength(1)
    expect(catalogue.sent).toEqual([])
  })

  it('quotes a refused URL with its userinfo, query and fragment starred', () => {
    expect(shownUrl(`https://me:${CANARY}@backstage.acme.example/api/catalog?t=${CANARY}#${CANARY}`)).toBe(
      'https://***@backstage.acme.example/api/catalog?***#***',
    )
    expect(shownUrl(REMOTE)).toBe(REMOTE)
    expect(shownUrl(CANARY)).toBe('a value of 24 characters that does not parse as a URL')
    expect(shownUrl(` https://me:${CANARY}@backstage.acme.example/api/catalog`)).toBe(
      'a value of 71 characters with a space or a control character in it',
    )
  })

  it.each([
    ['a leading space', ' '],
    ['a leading tab', '\t'],
  ])('quotes no secret from config.yml behind %s', async (_, before) => {
    const HOME = await home(`backstage: ${JSON.stringify(`${before}https://me:${CANARY}@backstage.acme.example/api/catalog`)}\n`)
    const { code, err, catalogue } = await run(['graph'], { env: { HOME, IDP_BACKSTAGE_TOKEN: 't' } })
    expect(code).toBe(2)
    expect(err).toMatch(/^~\/\.config\/idp-agent\/config\.yml: backstage \(a value of 71 characters with a space or a control character in it\)/)
    expect(err).not.toContain(CANARY)
    expect(catalogue.sent).toEqual([])
  })

  it('names the file for a backstage: in config.yml, quoting no secret', async () => {
    const HOME = await home(`backstage: https://me:${CANARY}@backstage.acme.example/api/catalog\n`)
    const { code, err, catalogue } = await run(['graph'], { env: { HOME, IDP_BACKSTAGE_TOKEN: 't' } })
    expect(code).toBe(2)
    expect(err).toMatch(/^~\/\.config\/idp-agent\/config\.yml: backstage https:\/\/\*\*\*@backstage\.acme\.example\/api\/catalog holds userinfo/)
    expect(err).not.toContain(CANARY)
    expect(catalogue.sent).toEqual([])
  })

  it.each([
    ['unset', {}],
    ['empty', { IDP_BACKSTAGE_TOKEN: '' }],
  ])('refuses a token %s for a host that is not this machine, naming IDP_BACKSTAGE_TOKEN and the host', async (_, token) => {
    const { code, out, err, catalogue } = await run(['graph'], { env: { IDP_BACKSTAGE_URL: REMOTE, ...token } })
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toBe(
      'IDP_BACKSTAGE_TOKEN is not set; the Backstage catalogue at backstage.acme.example needs a read token (docs/adopting-backstage.md)\n',
    )
    expect(catalogue.sent).toEqual([])
  })

  it.each([
    ['a line break', `${CANARY}\npart-two`, REMOTE],
    ['a space', `${CANARY} part-two`, REMOTE],
    ['a character past ASCII', `${CANARY}é`, REMOTE],
    ['a line break, for a catalogue on this machine', `${CANARY}\r\n`, LOOPBACK],
  ])('refuses a token holding %s with 2, before any request, quoting none of it', async (_, token, url) => {
    const { code, out, err, catalogue } = await run(['graph'], { env: { IDP_BACKSTAGE_URL: url, IDP_BACKSTAGE_TOKEN: token } })
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toBe(
      'IDP_BACKSTAGE_TOKEN holds a character a header cannot carry: a token is visible ASCII, with no space ' +
        '(docs/adopting-backstage.md)\n',
    )
    expect(catalogue.sent).toEqual([])
  })

  it('reads a loopback host with no token, and sends no Authorization header', async () => {
    for (const url of [LOOPBACK, 'http://localhost:7007/api/catalog', 'http://[::1]:7007/api/catalog']) {
      const { code, out, catalogue } = await run(['graph', '--kind', 'Component'], { env: { IDP_BACKSTAGE_URL: url } })
      expect(code, url).toBe(0)
      expect(out).toContain('billing-api')
      expect(catalogue.sent.length).toBeGreaterThan(0)
      for (const sent of catalogue.sent) expect(Object.keys(sent.headers)).not.toContain('authorization')
    }
  })

  it('sends the token to the catalogue it names, in one header', async () => {
    const { code, catalogue } = await run(['graph'], { env: { IDP_BACKSTAGE_URL: REMOTE, IDP_BACKSTAGE_TOKEN: CANARY }, token: CANARY })
    expect(code).toBe(0)
    expect(catalogue.sent.length).toBeGreaterThan(0)
    for (const sent of catalogue.sent) {
      expect(new URL(sent.url).origin).toBe('https://backstage.acme.example')
      expect(sent.headers['authorization']).toBe(`Bearer ${CANARY}`)
    }
  })

  it('refuses --backstage with nothing configured, and --backstage beside --repo or --demo', async () => {
    const none = await run(['graph', '--backstage'], { env: {}, catalogueFetch: untouchable })
    expect(none.code).toBe(2)
    expect(none.err).toMatch(/^--backstage reads the configured catalogue, and none is: set IDP_BACKSTAGE_URL, or backstage in /)
    for (const other of [['--repo', DEMO], ['--demo']]) {
      const both = await run(['graph', '--backstage', ...other], { env: { IDP_BACKSTAGE_URL: LOOPBACK }, catalogueFetch: untouchable })
      expect(both.code).toBe(2)
      expect(both.err).toMatch(/^graph takes one of --repo <directory>, --demo or --backstage, never two/)
    }
  })

  it('reads the catalogue --backstage chooses, naming where its URL came from', async () => {
    const variable = await run(['graph', '--backstage'], { env: { IDP_BACKSTAGE_URL: LOOPBACK } })
    expect(variable.code).toBe(0)
    expect(variable.err).toMatch(/^reading the Backstage catalogue at 127\.0\.0\.1:7007 \(IDP_BACKSTAGE_URL\): /)
    const HOME = await home(`backstage: ${LOOPBACK}\n`)
    const file = await run(['graph', '--backstage'], { env: { HOME } })
    expect(file.code).toBe(0)
    expect(file.err).toMatch(/^reading the Backstage catalogue at 127\.0\.0\.1:7007 \(~\/\.config\/idp-agent\/config\.yml\): /)
  })

  it('refuses token: in config.yml by name, as before', async () => {
    const HOME = await home(`backstage: ${LOOPBACK}\ntoken: ${CANARY}\n`)
    const { code, err, catalogue } = await run(['graph'], { env: { HOME } })
    expect(code).toBe(2)
    expect(err).toMatch(/token/)
    expect(catalogue.sent).toEqual([])
  })

  it('never reads backstage: in .idp-agent.yml: a committed URL is not requested, on the road that reads the file', async () => {
    // The change road reads the application repository's `.idp-agent.yml`
    // (`runIntent`), and its schema takes a `backstage:`. The catalogue a run
    // reads is chosen before any model, from the shell and the personal file
    // alone: a committed URL aims no request, and no token, anywhere.
    const base = await mkdtemp(path.join(tmpdir(), 'backstage-committed-'))
    const repo = path.join(base, 'iac')
    const project = path.join(base, 'svc')
    await cp(DEMO, repo, { recursive: true })
    await mkdir(project)
    await writeFile(path.join(project, 'package.json'), '{"name":"billing-api"}\n', 'utf8')
    const example = JSON.parse(await readFile(path.join(EXAMPLES, 'open-network.json'), 'utf8')) as {
      intent: string
      operations: unknown[]
    }
    const change = async (committed: string): Promise<Ran & { fetched: number }> => {
      await writeFile(path.join(project, '.idp-agent.yml'), committed, 'utf8')
      let fetched = 0
      const counted: CatalogueFetch = async (...args) => {
        fetched += 1
        return untouchable(...args)
      }
      const ran = await run([example.intent, '--project', project], {
        env: { IDP_REPO: repo, IDP_BACKSTAGE_TOKEN: CANARY },
        cwd: project,
        catalogueFetch: counted,
        client: scripted({
          supervisor: [saying('MUTATION')],
          inspector: [calling('list_files', {}), calling(REPORT_TOOL, FACTS)],
          architect: [calling(PROPOSE_TOOL, { operations: example.operations })],
          reviewer: [calling(VERDICT_TOOL, { verdict: 'ok' })],
        }),
      })
      return { ...ran, fetched }
    }
    // The road reads the file, `backstage:` included: one it cannot take is refused by name.
    const unread = await change('iacRepo: github.com/acme/iac\nbackstage: [https://evil.example/api/catalog]\nenvironments: [prod]\n')
    expect(unread.code).toBe(2)
    expect(unread.err).toMatch(/\.idp-agent\.yml is not a configuration — backstage/)
    // And one it can take is never requested.
    const committed = await change('iacRepo: github.com/acme/iac\nbackstage: https://evil.example/api/catalog\nenvironments: [prod]\n')
    expect(committed.code, committed.err).toBe(0)
    expect(committed.out).toContain('+++ b/dependencies/network/orders-api-to-payments.yml')
    expect(committed.fetched).toBe(0)
    expect(committed.err).not.toContain('evil.example')
    expect(committed.err).toMatch(/^reading the declarations repository /)
  })
})

describe('--refresh and --cached, refused where they would read nothing kept', () => {
  // Two booleans on the read commands and the phrase alone: plan, validate and
  // init read no catalogue. Each refusal is the arguments', exit 2, before any
  // request (backstage-http slice 2, Task 2.3).
  it('parses either flag on every read command and the phrase', () => {
    expect(parseArguments(['graph', '--refresh'])).toMatchObject({ name: 'graph', refresh: true })
    expect(parseArguments(['show', 'x', '--cached'])).toMatchObject({ name: 'show', query: 'x', cached: true })
    expect(parseArguments(['relations', 'x', '--impacts', '--refresh'])).toMatchObject({
      name: 'relations',
      relation: 'impacts',
      refresh: true,
    })
    expect(parseArguments(['ask', 'q', '--cached'])).toMatchObject({ name: 'ask', intent: 'q', cached: true })
    expect(parseArguments(['which databases are in prod', '--refresh'])).toMatchObject({ name: 'entry', refresh: true })
    // Absent is omitted, never false: a run with neither is what it always was.
    expect(parseArguments(['graph'])).toStrictEqual({ name: 'graph', options: {} })
  })

  it('refuses both at once, and either beside --repo or --demo', () => {
    expect(parseArguments(['graph', '--refresh', '--cached'])).toStrictEqual({
      name: 'error',
      message: 'graph takes --refresh or --cached, never both: one reads Backstage again and the other only the kept copy',
    })
    expect(parseArguments(['graph', '--cached', '--repo', 'x'])).toStrictEqual({
      name: 'error',
      message: '--cached reads a kept copy of a Backstage catalogue, and --repo names a repository',
    })
    expect(parseArguments(['show', 'x', '--refresh', '--demo'])).toStrictEqual({
      name: 'error',
      message: '--refresh reads a Backstage catalogue again, and --demo names the fictional SI',
    })
  })

  it('is an unknown option where no catalogue is read, as before', () => {
    for (const argv of [['plan', 'x', '--refresh'], ['validate', 'd', '--cached'], ['init', '--cached']]) {
      expect(parseArguments(argv)).toStrictEqual({ name: 'error', message: expect.stringMatching(/^Unknown option '--(refresh|cached)'/) })
    }
  })

  it('refuses either against a source that is not a catalogue, naming what was read, before any request', async () => {
    const standing = await mkdtemp(path.join(tmpdir(), 'backstage-flags-'))
    await cp(DEMO, standing, { recursive: true })
    const repo = await run(['graph', '--cached'], {
      env: { IDP_BACKSTAGE_URL: LOOPBACK },
      cwd: standing,
      catalogueFetch: untouchable,
      cacheRoot: { dir: standing },
    })
    expect(repo.code).toBe(2)
    expect(repo.err).toBe(
      `--cached reads a kept copy of a Backstage catalogue, and this run reads the declarations repository ${path.basename(standing)} (the current directory); --backstage reads the catalogue\n`,
    )
    const demo = await run(['show', 'billing-api', '--refresh'], { env: {}, catalogueFetch: untouchable })
    expect(demo.code).toBe(2)
    expect(demo.err).toMatch(
      /^--refresh reads a Backstage catalogue again, and this run reads the demo SI \(the default\); no catalogue is configured: IDP_BACKSTAGE_URL, or backstage in /,
    )
  })

  it('refuses --cached where this tool keeps no copy, naming why', async () => {
    const reasons = {
      off: 'IDP_BACKSTAGE_CACHE is off',
      'no-home': 'neither XDG_CACHE_HOME nor HOME names an absolute folder',
      platform: 'this tool keeps none on Windows',
      root: 'this tool keeps none for root, so a sudo run never leaves company data owned by root in a home',
    } as const
    for (const [none, why] of Object.entries(reasons)) {
      const { code, err } = await run(['graph', '--cached'], {
        env: { IDP_BACKSTAGE_URL: LOOPBACK },
        catalogueFetch: untouchable,
        cacheRoot: { none: none as keyof typeof reasons },
      })
      expect(code, none).toBe(2)
      expect(err).toBe(`--cached reads a copy this tool keeps, and none is kept here: ${why}\n`)
    }
    // A run handed no root at all — every test's, since only bin.ts resolves one.
    const unrooted = await run(['graph', '--cached'], { env: { IDP_BACKSTAGE_URL: LOOPBACK }, catalogueFetch: untouchable })
    expect(unrooted.code).toBe(2)
    expect(unrooted.err).toBe('--cached reads a copy this tool keeps, and none is kept here: this run was given no cache folder\n')
  })

  it('refuses an IDP_BACKSTAGE_CACHE other than off, so a typo never keeps what was meant to be kept nowhere', async () => {
    for (const value of ['of', 'OFF', 'no', '0']) {
      const { code, err } = await run(['graph'], {
        env: { IDP_BACKSTAGE_URL: LOOPBACK, IDP_BACKSTAGE_CACHE: value },
        catalogueFetch: untouchable,
      })
      expect(code, value).toBe(2)
      expect(err).toBe(`IDP_BACKSTAGE_CACHE=${value} is not off, its one value; unset it to keep a catalogue read five minutes\n`)
    }
    // Empty is unset, as for every IDP_ variable.
    expect((await run(['graph'], { env: { IDP_BACKSTAGE_URL: LOOPBACK, IDP_BACKSTAGE_CACHE: '' } })).code).toBe(0)
  })
})
