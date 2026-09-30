import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { strippingRefusal } from '../../scripts/type-stripping.mjs'
import { GH_LIMITS, ghArgv, ghIn, parseIncluded, type GhRequest } from '../../src/process/gh.js'
import { answer } from '../../tools/fake-gh.js'
import { removeClones, scratch } from '../support/forge-fixture.js'
import { DOORS, FAKE_GH_VERSION, fakeGitHub, protectedMain } from '../support/fake-gh.js'

afterAll(removeClones)

/**
 * The fake gh every test that reaches gh is handed (stage 6 brief § 10): it
 * reads the argument vector with its own patterns, independently of the
 * launcher's grammar, so a drift between the two fails here, and it answers
 * as gh prints an `--include` answer. It models the accounts and the session
 * (`--version`, `GET user`) and, from 6.1.3, the repositories § 8 reads: the
 * repository, the rules for a branch, a ruleset, a branch and a ref. The
 * other routes the launcher builds are recognised and answered "not
 * modelled" by name, and every door is not a vector idp-agent sends.
 */

const text = (bytes: Buffer): string => bytes.toString('utf8')

describe('the fake gh', () => {
  it('answers --version as gh 2.40.0 does', async () => {
    const fake = fakeGitHub()
    expect(FAKE_GH_VERSION).toBe('2.40.0')
    const version = await ghIn({ run: fake.process }).version()
    expect(version).toBe(
      'gh version 2.40.0 (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v2.40.0\n',
    )
  })

  it('answers GET user for the account gh is logged in as, with fields the reader never reads', async () => {
    const fake = fakeGitHub()
    const answer = await ghIn({ run: fake.process }).get({ route: 'user' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({ login: 'ada', type: 'User', id: expect.any(Number), site_admin: false })
  })

  it('answers as a bot when logged in as one', async () => {
    const fake = fakeGitHub({ accounts: [{ login: 'ada', type: 'User' }, { login: 'robot', type: 'Bot' }] })
    fake.as('robot')
    const answer = await ghIn({ run: fake.process }).get({ route: 'user' })
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('"type":"Bot"')
    expect(() => fake.as('nobody')).toThrow(/nobody/)
  })

  it('exits 4 with nothing on stdout once logged out, in its own words on stderr', async () => {
    const fake = fakeGitHub()
    fake.logout()
    const exit = await fake.process(ghArgv({ kind: 'get', route: { route: 'user' } }), { env: {}, limits: GH_LIMITS })
    expect(exit.code).toBe(4)
    expect(exit.stdout.length).toBe(0)
    expect(exit.stderr).toMatch(/gh auth login/)
    await expect(ghIn({ run: fake.process }).get({ route: 'user' })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('answers 401 for an expired session, and 403 where /user is refused', async () => {
    const expired = fakeGitHub({ session: { login: 'ada', expired: true } })
    const argv = ghArgv({ kind: 'get', route: { route: 'user' } })
    const exit = await expired.process(argv, { env: {}, limits: GH_LIMITS })
    expect(exit.code).toBe(1)
    expect(parseIncluded(exit.stdout)?.status).toBe(401)
    const refused = fakeGitHub({ userRefused: true })
    expect((await ghIn({ run: refused.process }).get({ route: 'user' })).status).toBe(403)
  })

  it('is not installed when told so', async () => {
    const fake = fakeGitHub({ installed: false })
    const exit = await fake.process(['--version'], { env: {}, limits: GH_LIMITS })
    expect(exit.code).toBe('ENOENT')
    await expect(ghIn({ run: fake.process }).version()).rejects.toMatchObject({ kind: 'missing' })
  })

  it('keeps each call it received: the vector, stdin and environment', async () => {
    const fake = fakeGitHub()
    await ghIn({ run: fake.process, env: { PATH: '/bin', GH_HOST: 'evil.example' } }).get({ route: 'user' })
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]?.argv).toEqual(ghArgv({ kind: 'get', route: { route: 'user' } }))
    expect(fake.sent[0]?.stdin).toBeUndefined()
    expect(fake.sent[0]?.env).toMatchObject({ PATH: '/bin', GH_PROMPT_DISABLED: '1' })
    expect(fake.sent[0]?.env).not.toHaveProperty('GH_HOST')
  })
})

describe("the fake's own grammar", () => {
  const repo = { owner: 'acme', name: 'iac' }
  const SAMPLES: readonly [string, GhRequest][] = [
    ['repository', { kind: 'get', route: { route: 'repository', ...repo } }],
    ['branch', { kind: 'get', route: { route: 'branch', ...repo, branch: 'release/1' } }],
    ['rules', { kind: 'get', route: { route: 'rules', ...repo, branch: 'main' } }],
    ['ruleset', { kind: 'get', route: { route: 'ruleset', ...repo, id: 42 } }],
    ['ref', { kind: 'get', route: { route: 'ref', ...repo, branch: 'idp-agent/x-0123abcd' } }],
    ['commit', { kind: 'get', route: { route: 'commit', ...repo, sha: '0123456789abcdef0123456789abcdef01234567' } }],
    ['pulls', { kind: 'get', route: { route: 'pulls', ...repo, head: 'idp-agent/x-0123abcd' } }],
    [
      'open-pull-request',
      {
        kind: 'open-pull-request',
        ...repo,
        body: JSON.stringify({
          title: 't',
          head: 'idp-agent/x-0123abcd',
          base: 'main',
          body: 'b',
          draft: false,
          maintainer_can_modify: false,
        }),
      },
    ],
  ]

  /** The five reads of § 8, which the fake answers from its model: 404 for a repository it does not hold. */
  const MODELLED = new Set(['repository', 'branch', 'rules', 'ruleset', 'ref'])

  it('recognises every vector the launcher builds, and names what it does not model yet', async () => {
    const fake = fakeGitHub()
    for (const [route, request] of SAMPLES) {
      const stdin = request.kind === 'open-pull-request' ? Buffer.from(request.body) : undefined
      const exit = await fake.process(ghArgv(request), { ...(stdin === undefined ? {} : { stdin }), env: {}, limits: GH_LIMITS })
      if (MODELLED.has(route)) {
        expect(parseIncluded(exit.stdout)?.status, route).toBe(404)
      } else {
        expect(exit.code, route).toBe(97)
        expect(exit.stderr, route).toBe(`fake gh: ${route} is not modelled\n`)
      }
    }
  })

  it('answers the five reads of § 8 from its model, and asks a login for each', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const gh = ghIn({ run: fake.process })
    const repo = { owner: 'acme', name: 'iac' }
    const read = await gh.get({ route: 'repository', ...repo })
    expect(read.status).toBe(200)
    expect(JSON.parse(read.body)).toMatchObject({ full_name: 'acme/iac', archived: false, permissions: { admin: true, push: true } })
    const rules = JSON.parse((await gh.get({ route: 'rules', ...repo, branch: 'main' })).body) as { type: string }[]
    expect(rules.map((rule) => rule.type)).toEqual(['pull_request', 'non_fast_forward', 'deletion'])
    expect(JSON.parse((await gh.get({ route: 'ruleset', ...repo, id: 1 })).body)).toMatchObject({
      id: 1,
      current_user_can_bypass: 'never',
      bypass_actors: [],
    })
    expect(JSON.parse((await gh.get({ route: 'branch', ...repo, branch: 'main' })).body)).toMatchObject({ protected: false })
    expect((await gh.get({ route: 'ruleset', ...repo, id: 2 })).status).toBe(404)
    // No bare repository: GitHub has no ref to give.
    expect((await gh.get({ route: 'ref', ...repo, branch: 'main' })).status).toBe(404)
    fake.logout()
    await expect(gh.get({ route: 'repository', ...repo })).rejects.toMatchObject({ kind: 'auth' })
  })

  // Four Node starts that strip types: well inside a minute, but past
  // vitest's five seconds on a loaded machine, so the bound is the test's own.
  it(
    'runs as a program, reading its world from FAKE_GH_STATE, with the in-process answer’s bytes',
    async (context) => {
      const refusal = strippingRefusal()
      if (refusal !== undefined) context.skip(`the fake gh runs as a program only where Node strips types: ${refusal}`)
      const state = { ...fakeGitHub({ repositories: [protectedMain()] }).state }
      const file = path.join(await scratch('idp-fake-gh-'), 'state.json')
      await writeFile(file, JSON.stringify(state), 'utf8')
      for (const request of [
        { kind: 'version' },
        { kind: 'get', route: { route: 'user' } },
        { kind: 'get', route: { route: 'rules', owner: 'acme', name: 'iac', branch: 'main' } },
        { kind: 'get', route: { route: 'repository', owner: 'acme', name: 'elsewhere' } },
      ] satisfies GhRequest[]) {
        const argv = ghArgv(request)
        const run = spawnSync(
          process.execPath,
          ['--disable-warning=ExperimentalWarning', path.resolve(import.meta.dirname, '../../tools/fake-gh.ts'), ...argv],
          { env: { PATH: process.env['PATH'] ?? '', FAKE_GH_STATE: file }, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        const expected = answer(state, argv, undefined)
        expect(run.stdout.toString('utf8'), argv.join(' ')).toBe(expected.stdout.toString('utf8'))
        expect(run.status, argv.join(' ')).toBe(expected.code)
      }
    },
    60_000,
  )

  it('answers every door as a vector idp-agent never sends', async () => {
    const fake = fakeGitHub()
    for (const door of DOORS) {
      const stdin = door.stdin === undefined ? undefined : Buffer.from(door.stdin)
      const exit = await fake.process(door.argv, { ...(stdin === undefined ? {} : { stdin }), env: {}, limits: GH_LIMITS })
      expect(exit.code, door.name).toBe(97)
      expect(text(exit.stdout), door.name).toBe('')
      expect(exit.stderr, door.name).toBe('fake gh: not a vector idp-agent sends\n')
    }
  })
})
