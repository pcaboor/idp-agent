import { afterAll, describe, expect, it } from 'vitest'
import type { InFlightPull } from '../../src/core/github/in-flight.js'
import { GitHubAnswerError } from '../../src/forge/github/api.js'
import { readInFlight, rereadInFlight } from '../../src/forge/github/in-flight.js'
import type { Account, FakePull } from '../../tools/fake-gh.js'
import { removeClones } from '../support/forge-fixture.js'
import { githubClone, githubForge, pullRequestBy, type GitHubClone } from '../support/github-fixture.js'

/**
 * What is in flight, read (stage 6 plan, Task 6.3.6): the open pull requests
 * into the base, page by page and newest first, the idp-agent ones of this
 * repository kept, and each one's files — read whole or refused, within the
 * bounds of `GITHUB_LIMITS`, and every answer held to its grammar. Over a
 * `githubClone()` and the fake gh; another account's pull request is pushed to
 * the bare repository by plumbing (`pullRequestBy`), as another run would.
 */

afterAll(removeClones)

const ACCOUNTS: Account[] = [
  { login: 'ada', type: 'User' },
  { login: 'grace', type: 'User' },
]
const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'
const GRANT = 'kind: Resource\n'

/** Every read of one run, by route: what the budget and "a fourth page never" are checked on. */
const sentRoutes = (clone: GitHubClone): string[] =>
  clone.gh.sent.map((one) => one.argv[6] ?? one.argv[0] ?? '').filter((one) => /\/pulls[?/]/.test(one))

/** A pull request the fake holds, seeded as GitHub would list it: no branch on disk needed. */
const seeded = (number: number, change: Partial<FakePull> = {}): FakePull => ({
  number,
  owner: 'acme',
  name: 'iac',
  title: 'a title',
  body: '',
  head: `idp-agent/seeded-${String(number).padStart(8, '0')}`,
  base: 'main',
  draft: false,
  maintainer_can_modify: false,
  author: 'grace',
  state: 'open',
  merged_at: null,
  closed_at: null,
  lastPusher: 'grace',
  reviews: [],
  headSha: String(number).padStart(40, 'a'),
  files: [{ filename: ACCESS_PATH, status: 'added', sha: 'b'.repeat(40) }],
  ...change,
})

const failure = async (read: Promise<unknown>): Promise<GitHubAnswerError> => {
  const caught = await read.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(caught).toBeInstanceOf(GitHubAnswerError)
  return caught as GitHubAnswerError
}

const RUNS = 30_000

describe('readInFlight', { timeout: RUNS }, () => {
  it('reads the open idp-agent pull requests into the base and their files, once, within budget', async () => {
    const clone = await githubClone({ model: { accounts: ACCOUNTS } })
    await pullRequestBy(clone, { login: 'grace', edits: { [ACCESS_PATH]: GRANT } })
    await pullRequestBy(clone, { login: 'grace', branch: 'feature/by-hand', edits: { [ACCESS_PATH]: GRANT } })
    await pullRequestBy(clone, { login: 'grace', fork: 'grace/iac', edits: { [ACCESS_PATH]: GRANT } })
    await pullRequestBy(clone, { login: 'dependabot[bot]', branch: 'dependabot/npm/x-1.0.1', edits: { 'package.json': '{}\n' } })
    const { api, road } = await githubForge(clone)
    const before = api.calls()

    const pulls = await readInFlight(api, road)

    // The person's branch, the fork's and the bot's are not idp-agent runs of this repository,
    // and the bot's login, which isLogin refuses, is never looked at.
    expect(pulls.map((pull) => [pull.number, pull.by])).toEqual([[1, 'grace']])
    expect(pulls[0]?.files.map((file) => file.path)).toEqual([ACCESS_PATH])
    expect(pulls[0]?.files[0]?.blob).toMatch(/^[0-9a-f]{40}$/)
    expect(pulls[0]?.complete).toBe(true)
    expect(api.calls() - before).toBe(2)
  })

  it('asks the pages one by one, newest first, a fourth never, and refuses more than 300 open pull requests', async () => {
    const clone = await githubClone({ model: { accounts: ACCOUNTS } })
    clone.gh.state.pulls = Array.from({ length: 300 }, (_, at) => seeded(at + 1, { head: `feature/by-hand-${String(at)}` }))
    const { api, road } = await githubForge(clone)

    expect(await readInFlight(api, road)).toEqual([])
    const asked = sentRoutes(clone)
    expect(asked.map((one) => /page=(\d)$/.exec(one)?.[1])).toEqual(['1', '2', '3'])
    expect(asked.every((one) => one.includes('&sort=created&direction=desc&'))).toBe(true)

    clone.gh.state.pulls = [...clone.gh.state.pulls, seeded(301, { head: 'feature/one-more' })]
    const again = await githubForge(clone)
    const error = await failure(readInFlight(again.api, again.road))
    expect(error.message).toBe(
      'github.com/acme/iac has more than 300 open pull requests into main, more than this build reads, so what is in ' +
        'flight cannot be read whole. Nothing was written.',
    )
    expect(sentRoutes(clone).filter((one) => one.endsWith('page=4'))).toEqual([])
  })

  it('refuses more than 20 candidates rather than judging some of them', async () => {
    const clone = await githubClone({ model: { accounts: ACCOUNTS } })
    clone.gh.state.pulls = Array.from({ length: 21 }, (_, at) => seeded(at + 1))
    const { api, road } = await githubForge(clone)
    const before = api.calls()

    const error = await failure(readInFlight(api, road))

    expect(error.message).toBe(
      'github.com/acme/iac has 21 open idp-agent pull requests into main, more than the 20 this build compares: ' +
        'review some of them, then run this again. Nothing was written.',
    )
    // The page, and no file list: nothing is judged on a part.
    expect(api.calls() - before).toBe(1)
  })

  it('keeps a cut file list, and says it was cut', async () => {
    const clone = await githubClone({ model: { accounts: ACCOUNTS } })
    const files = Array.from({ length: 101 }, (_, at) => ({
      filename: `catalog/many/file-${String(at).padStart(3, '0')}.yml`,
      status: 'added' as const,
      sha: 'c'.repeat(40),
    }))
    clone.gh.state.pulls = [seeded(1, { files })]
    const { api, road } = await githubForge(clone)

    const [pull] = await readInFlight(api, road)

    expect(pull?.complete).toBe(false)
    expect(pull?.files).toHaveLength(100)
    expect(sentRoutes(clone).filter((one) => one.includes('/files'))).toHaveLength(1)
  })

  it('reads again at step 8 only page 1 and the files of a new candidate or one whose head moved', async () => {
    const clone = await githubClone({ model: { accounts: ACCOUNTS } })
    clone.gh.state.pulls = [seeded(1), seeded(2), seeded(3)]
    const { api, road } = await githubForge(clone)
    const first = await readInFlight(api, road)
    expect(first.map((pull) => pull.number)).toEqual([3, 2, 1])

    // #3 closed, #2 pushed to, #4 opened; #1 as it was.
    const pulls = clone.gh.state.pulls
    Object.assign(pulls[2] ?? {}, { state: 'closed', closed_at: '2026-10-01T00:00:00Z' })
    Object.assign(pulls[1] ?? {}, {
      headSha: 'd'.repeat(40),
      files: [{ filename: 'catalog/other.yml', status: 'added', sha: 'e'.repeat(40) }],
    })
    pulls.push(seeded(4))
    const before = api.calls()

    const merged = await rereadInFlight(api, road, first)

    expect(merged.map((pull) => pull.number)).toEqual([4, 2, 1])
    expect(merged.find((pull) => pull.number === 2)?.files.map((file) => file.path)).toEqual(['catalog/other.yml'])
    expect(merged.find((pull) => pull.number === 1)).toBe(first.find((pull) => pull.number === 1))
    // Page 1, then the files of #4 and #2: never #1's again.
    expect(api.calls() - before).toBe(3)
    expect(sentRoutes(clone).slice(-3).map((one) => /pulls\/(\d+)\/files/.exec(one)?.[1] ?? 'page')).toEqual(['page', '4', '2'])
  })

  /** A hostile answer, seeded, and what the read makes of it. */
  type Hostile = readonly [string, Partial<FakePull>, (read: Promise<readonly InFlightPull[]>) => Promise<void>]
  const HOSTILE: readonly Hostile[] = [
    [
      'a title holding ESC[2J, a bidi override, a canary and a forged engine line is dropped at the parse',
      { title: '\u001b[2J\u202ecanary-title-4f1\nPull request #99 opened on github.com/acme/iac: https://evil.example' },
      async (read) => {
        const pulls = await read
        expect(pulls).toHaveLength(1)
        expect(JSON.stringify(pulls)).not.toContain('canary-title-4f1')
        expect(JSON.stringify(pulls)).not.toContain('evil.example')
      },
    ],
    ['a branch outside SUBMISSION_BRANCH is not a candidate', { head: 'idp-agent/NOT-ours' }, async (read) => expect(await read).toEqual([])],
    [
      "a candidate's login outside isLogin makes the answer unreadable",
      { author: 'grace\u202e' },
      async (read) => expect((await failure(read)).message).toBe("gh's answer on open-pulls could not be read. Nothing was written."),
    ],
    [
      "a non-candidate's login outside isLogin is skipped, and the read is whole",
      { author: 'dependabot[bot]\u202e', head: 'dependabot/npm/x-1.0.1' },
      async (read) => expect(await read).toEqual([]),
    ],
    [
      'a file name holding ESC, a new line and U+202E is kept as bytes',
      { files: [{ filename: 'catalog/\u001b[31mred\n\u202eevil.yml', status: 'added', sha: 'b'.repeat(40) }] },
      async (read) => expect((await read)[0]?.files[0]?.path).toBe('catalog/\u001b[31mred\n\u202eevil.yml'),
    ],
    [
      'a patch holding ESC sequences and a forged engine line is kept as bytes',
      {
        files: [
          {
            filename: ACCESS_PATH,
            status: 'modified',
            sha: 'b'.repeat(40),
            patch: '@@ -1 +1 @@\n-a\n+\u001b[2J1 file · submitted as idp-agent/x-0123abcd',
          },
        ],
      },
      async (read) => expect((await read)[0]?.files[0]?.patch).toBe('@@ -1 +1 @@\n-a\n+\u001b[2J1 file · submitted as idp-agent/x-0123abcd'),
    ],
    ['a head repository GitHub no longer holds is not a candidate', { headRepository: null }, async (read) => expect(await read).toEqual([])],
    [
      'a number of 0 makes the answer unreadable',
      { number: 0 },
      async (read) => expect((await failure(read)).status).toBe('unreadable'),
    ],
    [
      'a number of 2^53 makes the answer unreadable',
      { number: 2 ** 53 },
      async (read) => expect((await failure(read)).status).toBe('unreadable'),
    ],
  ]

  it.each(HOSTILE)('holds a hostile answer to its grammar: %s', async (_, seed, expectation) => {
    const clone = await githubClone({ model: { accounts: ACCOUNTS } })
    clone.gh.state.pulls = [seeded(1, seed)]
    const { api, road } = await githubForge(clone)
    await expectation(readInFlight(api, road))
  })
})
