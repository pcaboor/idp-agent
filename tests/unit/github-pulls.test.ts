import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GitHubRepository } from '../../src/core/github/remote.js'
import { GitHubAnswerError, githubApi, githubClient, type GitHubApi } from '../../src/forge/github/api.js'
import type { GhExit, GhProcess } from '../../src/process/gh.js'
import { removeClones, scratch } from '../support/forge-fixture.js'
import { fakeGitHub, repository } from '../support/fake-gh.js'
import { committed, git } from '../support/git.js'

/**
 * The three routes the forge adds (stage 6 plan, Task 6.2.1): a commit, the
 * pull requests from one branch, and the one write. Each against the fake gh,
 * over a bare repository on disk, and against a stub process answering chosen
 * bytes, so what the launcher hands a process is read back from the vector.
 */

afterAll(removeClones)

const ACME: GitHubRepository = { host: 'github.com', owner: 'acme', name: 'iac' }
const BRANCH = 'idp-agent/orders-db-prod-0123abcd'
const SHA = '0123456789abcdef0123456789abcdef01234567'

/** A process answering `answers` in turn, as gh prints an `--include` answer, and keeping what it was handed. */
const stub = (...answers: (readonly [number, unknown, (readonly string[])?] | 'timeout')[]) => {
  const sent: { argv: readonly string[]; stdin: Buffer | undefined }[] = []
  const process: GhProcess = async (argv, options) => {
    sent.push({ argv: [...argv], stdin: options.stdin })
    const next = answers[Math.min(sent.length - 1, answers.length - 1)]
    if (next === undefined || next === 'timeout') {
      return { code: 'SIGTERM', stdout: Buffer.alloc(0), stderr: '', timedOut: true } satisfies GhExit
    }
    const [status, body, headers = []] = next
    return {
      code: status >= 200 && status < 300 ? 0 : 1,
      stdout: Buffer.from(
        `HTTP/2.0 ${String(status)} Status\r\n${headers.map((header) => `${header}\r\n`).join('')}\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`,
      ),
      stderr: 'canary-stderr',
      timedOut: false,
    }
  }
  return { process, sent, api: (): GitHubApi => githubApi(githubClient({ run: process }), ACME) }
}

const thrown = async (read: Promise<unknown>): Promise<unknown> =>
  read.then(
    () => undefined,
    (reason: unknown) => reason,
  )

const PULL = {
  number: 7,
  state: 'open',
  merged_at: null,
  closed_at: null,
  base: { ref: 'main', sha: SHA },
  head: { ref: BRANCH, sha: SHA },
  user: { login: 'ada' },
  html_url: 'https://evil.example/acme/iac/pull/7',
}

describe('the commit route', () => {
  it("reads a commit's parents, tree and message, and nothing else", async () => {
    const root = await scratch('idp-pulls-')
    const repo = path.join(root, 'iac')
    await mkdir(repo)
    const first = await committed(repo)
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'second\n\nwith a body')
    const second = await git(repo, 'rev-parse', 'HEAD')
    const fake = fakeGitHub({ repositories: [repository({ bare: path.join(repo, '.git') })] })
    const api = githubApi(githubClient({ run: fake.process }), ACME)

    expect(await api.commit(second)).toEqual({
      sha: second,
      tree: await git(repo, 'rev-parse', `${second}^{tree}`),
      parents: [first],
      message: 'second\n\nwith a body\n',
    })
    expect((await api.commit(first)).parents).toEqual([])
    const missing = await thrown(api.commit('f'.repeat(40)))
    expect(missing).toBeInstanceOf(GitHubAnswerError)
    expect((missing as GitHubAnswerError).status).toBe(404)
  })

  it('reads an answer with fields it does not name, and refuses one without a tree', async () => {
    const body = { sha: SHA, tree: { sha: SHA, url: 'x' }, parents: [{ sha: SHA, url: 'x' }], message: 'm', author: {}, verification: {} }
    expect(await stub([200, body]).api().commit(SHA)).toEqual({ sha: SHA, tree: SHA, parents: [SHA], message: 'm' })
    const error = await thrown(stub([200, { ...body, tree: undefined }]).api().commit(SHA))
    expect(error).toBeInstanceOf(GitHubAnswerError)
    expect((error as GitHubAnswerError).status).toBe('unreadable')
    // An answer about another commit is not an answer about this one.
    const other = await thrown(stub([200, { ...body, sha: 'f'.repeat(40) }]).api().commit(SHA))
    expect((other as GitHubAnswerError).status).toBe('unreadable')
  })
})

describe('the pull requests route', () => {
  it('lists the pull requests from one branch, closed ones included, on one page', async () => {
    const closed = { ...PULL, number: 3, state: 'closed', merged_at: '2026-10-02T10:00:00Z', closed_at: '2026-10-02T10:00:00Z' }
    const one = stub([200, [PULL, closed]])

    expect(await one.api().pulls(BRANCH)).toEqual([
      { number: 7, state: 'open', merged: false, at: undefined, base: 'main', head: BRANCH },
      { number: 3, state: 'closed', merged: true, at: '2026-10-02', base: 'main', head: BRANCH },
    ])
    const address = one.sent[0]?.argv[6] ?? ''
    const [route, query = ''] = address.split('?')
    expect(route).toBe('repos/acme/iac/pulls')
    const parameters = new URLSearchParams(query)
    expect(parameters.get('head')).toBe(`acme:${BRANCH}`)
    expect(parameters.get('state')).toBe('all')
    expect(parameters.get('per_page')).toBe('100')

    const paged = await thrown(stub([200, [PULL], ['Link: <https://api.github.com/x?page=2>; rel="next"']]).api().pulls(BRANCH))
    expect((paged as GitHubAnswerError).status).toBe('paginated')
    // A pull request from another head is not one from this branch.
    const stranger = await thrown(stub([200, [{ ...PULL, head: { ref: 'main', sha: SHA } }]]).api().pulls(BRANCH))
    expect((stranger as GitHubAnswerError).status).toBe('unreadable')
    // A closed pull request GitHub gives no day for: nothing is put in a date's place.
    for (const at of [null, 'yesterday']) {
      const undated = await thrown(stub([200, [{ ...closed, merged_at: null, closed_at: at }]]).api().pulls(BRANCH))
      expect((undated as GitHubAnswerError).status, String(at)).toBe('unreadable')
    }
  })
})

describe('what is in flight: the open pull requests and one pull request’s files (6.3.6)', () => {
  const OPEN = {
    ...PULL,
    title: 'canary-title-91c',
    body: 'canary-body-91c',
    head: { ref: BRANCH, sha: SHA, repo: { full_name: 'acme/iac' } },
  }

  it('reads one page of open pull requests into the base, says whether a next one is linked, and keeps no title', async () => {
    const one = stub([200, [OPEN, { ...OPEN, number: 8, user: null, head: { ref: 'feature/x', sha: SHA, repo: null } }], ['Link: <https://api.github.com/x?page=3>; rel="next"']])

    const read = await one.api().openPulls('main', 2)

    expect(read).toEqual({
      pulls: [
        { number: 7, by: 'ada', branch: BRANCH, head: SHA, repository: 'acme/iac' },
        { number: 8, by: undefined, branch: 'feature/x', head: SHA, repository: null },
      ],
      more: true,
    })
    expect(JSON.stringify(read)).not.toContain('canary')
    expect(one.sent[0]?.argv[6]).toBe('repos/acme/iac/pulls?state=open&base=main&sort=created&direction=desc&per_page=100&page=2')
    // A pull request into another base is not one into this base: none of it is read.
    const elsewhere = await thrown(stub([200, [{ ...OPEN, base: { ref: 'release', sha: SHA } }]]).api().openPulls('main', 1))
    expect((elsewhere as GitHubAnswerError).status).toBe('unreadable')
    const unpaired = await thrown(stub([200, [{ ...OPEN, head: { ref: BRANCH, sha: 'abc' } }]]).api().openPulls('main', 1))
    expect((unpaired as GitHubAnswerError).status).toBe('unreadable')
  })

  it("reads one page of a pull request's files, and says when it was not the whole list", async () => {
    const files = [
      { filename: 'catalog/a.yml', status: 'added', sha: SHA, patch: '@@ -0,0 +1 @@\n+a', additions: 1 },
      { filename: 'catalog/b.yml', status: 'renamed', sha: SHA, previous_filename: 'catalog/old.yml' },
      { filename: 'catalog/c.yml', status: 'removed', sha: SHA },
    ]
    const one = stub([200, files])

    expect(await one.api().pullFiles(7)).toEqual({
      files: [
        { path: 'catalog/a.yml', removed: false, blob: SHA, patch: '@@ -0,0 +1 @@\n+a' },
        { path: 'catalog/b.yml', removed: false, blob: SHA, previous: 'catalog/old.yml' },
        { path: 'catalog/c.yml', removed: true },
      ],
      complete: true,
    })
    expect(one.sent[0]?.argv[6]).toBe('repos/acme/iac/pulls/7/files?per_page=100')
    const cut = await stub([200, files, ['Link: <https://api.github.com/x?page=2>; rel="next"']]).api().pullFiles(7)
    expect(cut.complete).toBe(false)
    const odd = await thrown(stub([200, [{ ...files[0], status: 'moved' }]]).api().pullFiles(7))
    expect((odd as GitHubAnswerError).status).toBe('unreadable')
  })
})

describe('the one write', () => {
  const INPUT = { title: 'idp-agent: declare orders-db-prod', head: BRANCH, base: 'main', body: 'the body' }

  it('opens a pull request with the engine\'s body on standard input, and never as an argument', async () => {
    const one = stub([201, PULL])

    expect(await one.api().openPullRequest(INPUT)).toEqual({ number: 7 })
    const [sent] = one.sent
    expect(sent?.argv).toEqual(['api', '--hostname', 'github.com', '--method', 'POST', '--include', 'repos/acme/iac/pulls', '--input', '-'])
    expect(sent?.argv.some((word) => word === '-f' || word === '-F' || word.startsWith('--field') || word.startsWith('--raw-field'))).toBe(false)
    expect(sent?.stdin?.toString('utf8')).toBe(
      JSON.stringify({ ...INPUT, draft: false, maintainer_can_modify: false }),
    )
    expect(Object.keys(JSON.parse(sent?.stdin?.toString('utf8') ?? '{}') as object)).toEqual([
      'title',
      'head',
      'base',
      'body',
      'draft',
      'maintainer_can_modify',
    ])

    const refused = await thrown(stub([422, { message: 'Validation Failed' }]).api().openPullRequest(INPUT))
    expect(refused).toBeInstanceOf(GitHubAnswerError)
    expect((refused as GitHubAnswerError).status).toBe(422)
    expect((refused as GitHubAnswerError).message).not.toContain('Validation Failed')

    // An answer about another head or another base is not the pull request asked for.
    for (const moved of [{ base: { ref: 'release', sha: SHA } }, { head: { ref: 'idp-agent/other-0123abcd', sha: SHA } }]) {
      const elsewhere = await thrown(stub([201, { ...PULL, ...moved }]).api().openPullRequest(INPUT))
      expect(elsewhere).toBeInstanceOf(GitHubAnswerError)
      expect((elsewhere as GitHubAnswerError).status).toBe('unreadable')
    }

    const heavy = stub([201, PULL])
    const big = await thrown(heavy.api().openPullRequest({ ...INPUT, body: 'x'.repeat(1024 * 1024 + 1) }))
    expect(big).toBeInstanceOf(Error)
    expect(heavy.sent).toEqual([])
  })

  it('opens at most one pull request per run, whatever the first answered', async () => {
    for (const first of [[201, PULL] as const, [422, { message: 'x' }] as const, 'timeout' as const]) {
      const one = stub(first)
      const api = one.api()
      await thrown(api.openPullRequest(INPUT))
      const second = await thrown(api.openPullRequest(INPUT))
      expect(second).toEqual(new Error('idp-agent asked to open a second pull request in one run'))
      expect(one.sent.filter((sent) => sent.argv[4] === 'POST')).toHaveLength(1)
    }
  })

  it('counts every call it made', async () => {
    const one = stub([200, [PULL]], [200, [PULL]], [201, PULL])
    const api = one.api()
    await api.pulls(BRANCH)
    await thrown(api.commit(SHA))
    await api.openPullRequest(INPUT)
    expect(api.calls()).toBe(one.sent.length)
    expect(api.calls()).toBe(3)
  })
})
