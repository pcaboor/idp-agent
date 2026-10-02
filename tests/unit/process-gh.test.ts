import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GH_LIMITS,
  GH_REMOVED,
  GH_SET,
  GhError,
  encodeRefPath,
  ghArgv,
  ghEnvironment,
  ghIn,
  parseIncluded,
  type GhRoute,
} from '../../src/process/gh.js'
import { LauncherRefusal } from '../../src/process/refusal.js'
import { onPath, removeStubs, stubGh } from '../support/stub-gh.js'

/**
 * The second launcher (stage 6 brief § 6): gh, started by name through
 * `execFile`, from Node's own directory, with § 5's environment, a timeout and
 * a cap, and only for `--version`, eight `GET` templates and one `POST`. A
 * stub `gh` first on PATH records the vector, the environment and the
 * directory it was started with; no real gh is ever run (the suite's floor
 * puts a failing one first on PATH, `tests/setup/forge.ts`).
 *
 * NO REAL TOKEN IS WRITTEN HERE: the canaries were never issued by anyone.
 */

afterEach(removeStubs)

const PULL = JSON.stringify({
  title: 'idp-agent: a change',
  head: 'idp-agent/x-0123abcd',
  base: 'main',
  body: 'what was requested\r\nand a second line',
  draft: false,
  maintainer_can_modify: false,
})

describe('the gh launcher', () => {
  it("starts gh by name, from the neutral directory, with the grammar's vector", async () => {
    const stub = await stubGh()
    const gh = ghIn({ env: onPath(stub.bin) })

    expect(await gh.get({ route: 'user' })).toEqual({ status: 200, hasNext: false, body: '{}' })

    const [call] = await stub.calls()
    expect(call?.argv).toEqual(['api', '--hostname', 'github.com', '--method', 'GET', '--include', 'user'])
    expect(realpathSync(call?.cwd ?? '')).toBe(realpathSync(path.dirname(process.execPath)))
  })

  it("hands gh § 5's environment", async () => {
    // gh's own login stays gh's: GH_TOKEN and GITHUB_TOKEN reach it unchanged,
    // and nothing here reads them. What would point gh at another host or
    // repository, log its traffic, or decorate what idp-agent parses does not.
    const kept = ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GH_CONFIG_DIR', 'HTTPS_PROXY']
    const stub = await stubGh({ values: [...kept, ...Object.keys(GH_SET)] })
    const env = onPath(stub.bin, {
      ...process.env,
      GH_TOKEN: 'canary-gh-token',
      GITHUB_TOKEN: 'canary-github-token',
      OPENAI_API_KEY: 'canary-provider-key-for-gh',
      IDP_BACKSTAGE_TOKEN: 'canary-backstage-token-for-gh',
      GH_HOST: 'evil.example',
      GH_REPO: 'evil/repo',
      GH_DEBUG: 'api',
      DEBUG: '1',
      GODEBUG: 'http2debug=2',
      GH_FORCE_TTY: '1',
      CLICOLOR_FORCE: '1',
      GH_ENTERPRISE_TOKEN: 'canary-enterprise-token',
      gh_host: 'evil.example',
      GIT_DIR: '/elsewhere/.git',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GH_CONFIG_DIR: '/tmp/gh-config',
      HTTPS_PROXY: 'http://proxy.example:3128',
    })
    await ghIn({ env }).get({ route: 'user' })

    const [call] = await stub.calls()
    expect(call?.env).toEqual({
      GH_TOKEN: 'canary-gh-token',
      GITHUB_TOKEN: 'canary-github-token',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GH_CONFIG_DIR: '/tmp/gh-config',
      HTTPS_PROXY: 'http://proxy.example:3128',
      ...GH_SET,
    })
    const refused = [
      'OPENAI_API_KEY',
      'IDP_BACKSTAGE_TOKEN',
      'GH_HOST',
      'GH_REPO',
      'GH_DEBUG',
      'DEBUG',
      'GODEBUG',
      'GH_FORCE_TTY',
      'CLICOLOR_FORCE',
      'GH_ENTERPRISE_TOKEN',
      'gh_host',
      'GIT_DIR',
    ]
    expect(call?.names.filter((name) => refused.includes(name))).toEqual([])
    expect(GH_SET).toEqual({
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      NO_COLOR: '1',
      GH_PAGER: 'cat',
    })
    expect(GH_REMOVED).toEqual(expect.arrayContaining(['GIT_*', 'GH_HOST', 'GH_REPO', 'GODEBUG']))
  })

  it('is idempotent in its environment', () => {
    // `ghIn` builds it, and `spawnGh` builds it again from what it is handed,
    // so a fake handed the first sees what gh would.
    const env = { PATH: '/bin', GH_HOST: 'evil.example', Git_Dir: '/x', OPENAI_API_KEY: 'k', GH_TOKEN: 'canary' }
    expect(ghEnvironment(ghEnvironment(env))).toEqual(ghEnvironment(env))
    expect(ghEnvironment(env)).toEqual({ PATH: '/bin', GH_TOKEN: 'canary', ...GH_SET })
  })

  it("writes the pull request's body to stdin, never to an argument", async () => {
    const stub = await stubGh({ stdout: 'HTTP/2.0 201 Created\r\n\r\n{"number":1}' })
    const answer = await ghIn({ env: onPath(stub.bin) }).openPullRequest('acme', 'iac', PULL)

    expect(answer).toEqual({ status: 201, hasNext: false, body: '{"number":1}' })
    const [call] = await stub.calls()
    expect(call?.argv).toEqual([
      'api',
      '--hostname',
      'github.com',
      '--method',
      'POST',
      '--include',
      'repos/acme/iac/pulls',
      '--input',
      '-',
    ])
    expect((await stub.stdin()).toString('utf8')).toBe(PULL)
  })

  it('reads the status from the included head, not from the exit code', async () => {
    const missing = await stubGh({ stdout: 'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}', exit: 1 })
    expect(await ghIn({ env: onPath(missing.bin) }).get({ route: 'repository', owner: 'acme', name: 'iac' })).toEqual({
      status: 404,
      hasNext: false,
      body: '{"message":"Not Found"}',
    })
    const paged = await stubGh({
      stdout: 'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"\r\n\r\n[]',
    })
    const answer = await ghIn({ env: onPath(paged.bin) }).get({ route: 'rules', owner: 'acme', name: 'iac', branch: 'main' })
    expect(answer).toEqual({ status: 200, hasNext: true, body: '[]' })
  })

  it("names what failed, and never gh's words", async () => {
    const failure = async (make: () => Promise<unknown>): Promise<GhError> => {
      const error = await make().then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(GhError)
      return error as GhError
    }
    const user: GhRoute = { route: 'user' }

    const logged = await stubGh({ stdout: '', stderr: 'canary-gh-said: gh auth login', exit: 4 })
    const auth = await failure(() => ghIn({ env: onPath(logged.bin) }).get(user))
    expect(auth.kind).toBe('auth')

    const missing = await failure(() => ghIn({ env: { PATH: '' } }).get(user))
    expect(missing.kind).toBe('missing')

    const slow = await stubGh({ sleepMs: 2000 })
    const timeout = await failure(() =>
      ghIn({ env: onPath(slow.bin), limits: { timeoutMs: 100, maxOutputBytes: GH_LIMITS.maxOutputBytes } }).version(),
    )
    expect(timeout.kind).toBe('timeout')
    expect(timeout.message).toBe('gh --version failed: timed out')

    const large = await stubGh({ stdout: `HTTP/2.0 200 OK\r\n\r\n${'x'.repeat(2048)}` })
    const tooLarge = await failure(() =>
      ghIn({ env: onPath(large.bin), limits: { timeoutMs: GH_LIMITS.timeoutMs, maxOutputBytes: 1024 } }).get(user),
    )
    expect(tooLarge.kind).toBe('too-large')

    const headless = await stubGh({ stdout: '{"login":"ada"}' })
    expect((await failure(() => ghIn({ env: onPath(headless.bin) }).get(user))).kind).toBe('unreadable')

    const said = await stubGh({ stdout: '', stderr: 'canary-gh-stderr', exit: 1 })
    const failed = await failure(() => ghIn({ env: onPath(said.bin) }).get(user))
    expect(failed.kind).toBe('failed')
    expect(failed.message).toBe('gh api failed')

    for (const error of [auth, missing, timeout, tooLarge, failed]) {
      expect(error.message).not.toContain('canary')
      expect(error.message).not.toContain('gh auth login')
    }
  })

  it('counts what it starts', async () => {
    const stub = await stubGh()
    const gh = ghIn({ env: onPath(stub.bin) })
    await gh.get({ route: 'user' })
    await gh.get({ route: 'repository', owner: 'acme', name: 'iac' })
    await gh.get({ route: 'ruleset', owner: 'acme', name: 'iac', id: 42 })
    await expect(gh.get({ route: 'ruleset', owner: 'acme', name: 'iac', id: 0 })).rejects.toBeInstanceOf(LauncherRefusal)
    expect(gh.calls()).toBe(3)
    expect(await stub.calls()).toHaveLength(3)
  })

  it('bounds every call', () => {
    expect(GH_LIMITS).toEqual({ timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 })
  })

  it('is witnessed by a stub wherever the run directory is, a space and a quote in its path', async () => {
    // The stub is how every launcher test reads what a child was handed: a
    // path it cannot run from would fail them all, for a reason of its own.
    const saved = process.env['TMPDIR']
    const odd = await mkdtemp(path.join(tmpdir(), "stub's dir "))
    process.env['TMPDIR'] = odd
    let stub: Awaited<ReturnType<typeof stubGh>>
    try {
      stub = await stubGh()
    } finally {
      if (saved === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = saved
    }
    try {
      expect(stub.bin.startsWith(odd)).toBe(true)
      expect(await ghIn({ env: onPath(stub.bin) }).get({ route: 'user' })).toEqual({ status: 200, hasNext: false, body: '{}' })
      expect(await stub.calls()).toHaveLength(1)
    } finally {
      await removeStubs()
      await rm(odd, { recursive: true, force: true })
    }
  })
})

describe('the vectors it builds', () => {
  it('addresses each route by its template, a ref name split on /', () => {
    const at = (route: GhRoute): string => ghArgv({ kind: 'get', route }).at(-1) ?? ''
    const repo = { owner: 'acme', name: 'iac' }
    expect(at({ route: 'user' })).toBe('user')
    expect(at({ route: 'repository', ...repo })).toBe('repos/acme/iac')
    expect(at({ route: 'branch', ...repo, branch: 'release/1' })).toBe('repos/acme/iac/branches/release/1')
    expect(at({ route: 'rules', ...repo, branch: 'main' })).toBe('repos/acme/iac/rules/branches/main?per_page=100')
    expect(at({ route: 'ruleset', ...repo, id: 42 })).toBe('repos/acme/iac/rulesets/42')
    expect(at({ route: 'ref', ...repo, branch: 'idp-agent/x-0123abcd' })).toBe('repos/acme/iac/git/ref/heads/idp-agent/x-0123abcd')
    expect(at({ route: 'commit', ...repo, sha: '0123456789abcdef0123456789abcdef01234567' })).toBe(
      'repos/acme/iac/git/commits/0123456789abcdef0123456789abcdef01234567',
    )
    expect(at({ route: 'pulls', ...repo, head: 'idp-agent/x-0123abcd' })).toBe(
      'repos/acme/iac/pulls?head=acme%3Aidp-agent%2Fx-0123abcd&state=all&per_page=100',
    )
    // What is in flight (6.3.6): the open pull requests into a base, newest first, one page
    // asked at a time; and one pull request's files, one page.
    expect(at({ route: 'open-pulls', ...repo, base: 'main', page: 2 })).toBe(
      'repos/acme/iac/pulls?state=open&base=main&sort=created&direction=desc&per_page=100&page=2',
    )
    expect(at({ route: 'open-pulls', ...repo, base: 'release/1', page: 1 })).toBe(
      'repos/acme/iac/pulls?state=open&base=release%2F1&sort=created&direction=desc&per_page=100&page=1',
    )
    expect(at({ route: 'pull-files', ...repo, number: 12 })).toBe('repos/acme/iac/pulls/12/files?per_page=100')
    expect(ghArgv({ kind: 'version' })).toEqual(['--version'])
  })

  it('encodes each component of a ref, and keeps the slashes between them', () => {
    expect(encodeRefPath('release/1')).toBe('release/1')
    expect(encodeRefPath('a+b')).toBe('a%2Bb')
    expect(encodeRefPath('feature/é#1')).toBe('feature/%C3%A9%231')
  })
})

describe("gh's included answer", () => {
  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')

  it('reads the status, whether a next page exists, and the body', () => {
    expect(parseIncluded(bytes('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"a":1}'))).toEqual({
      status: 200,
      hasNext: false,
      body: '{"a":1}',
    })
    expect(parseIncluded(bytes('HTTP/1.1 201 Created\nlocation: x\n\n{}'))).toEqual({ status: 201, hasNext: false, body: '{}' })
    expect(
      parseIncluded(bytes('HTTP/2.0 200 OK\r\nlink: <https://x?page=1>; rel="prev", <https://x?page=3>; rel="next"\r\n\r\n[]')),
    ).toEqual({ status: 200, hasNext: true, body: '[]' })
    expect(parseIncluded(bytes('HTTP/2.0 200 OK\r\nLINK: <https://x?page=9>; rel="last"\r\n\r\n[]'))?.hasNext).toBe(false)
    expect(parseIncluded(bytes('HTTP/2.0 204 No Content\r\n\r\n'))).toEqual({ status: 204, hasNext: false, body: '' })
  })

  it('reads nothing that is not an included answer', () => {
    for (const text of ['', '{"login":"ada"}', 'HTTP/2.0 2000 OK\r\n\r\n{}', 'HTTP/2.0 abc OK\r\n\r\n{}', 'HTTP/2.0 200 OK\r\nContent-Type: x']) {
      expect(parseIncluded(bytes(text)), JSON.stringify(text)).toBeUndefined()
    }
  })
})
