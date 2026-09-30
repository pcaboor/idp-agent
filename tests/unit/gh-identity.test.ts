import { describe, expect, it } from 'vitest'
import { GH_MINIMUM_VERSION, isAtLeast, parseGhVersion } from '../../src/core/github/gh-version.js'
import type { GitHubRepository } from '../../src/core/github/remote.js'
import { ForgeInputError } from '../../src/forge/errors.js'
import { GitHubAnswerError, githubApi, githubClient } from '../../src/forge/github/api.js'
import { readIdentity } from '../../src/forge/github/identity.js'
import { GITHUB_LIMITS } from '../../src/forge/github/limits.js'
import type { GhIdentity, GitHubRoad } from '../../src/forge/provider.js'
import { GhError, type GhAnswer, type GhClient, type GhProcess } from '../../src/process/gh.js'
import { FAKE_GH_VERSION, fakeGitHub, type FakeGitHub, type FakeModel } from '../support/fake-gh.js'

/**
 * Who gh is (stage 6 brief § 5, § 9): installed, recent enough, logged in to
 * github.com, and as a person. Every refusal is exit 2, before anything is
 * written, and says the one command that fixes it. gh is the fake
 * (`tests/support/fake-gh.ts`), handed to the launcher as its process: no
 * real gh is ever started.
 */

describe("gh's version", () => {
  it('reads the version gh prints first', () => {
    expect(parseGhVersion('gh version 2.40.0 (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v2.40.0\n')).toBe('2.40.0')
    expect(parseGhVersion('gh version 2.62.0-rc.1 (2024-11-14)\n')).toBe('2.62.0')
    expect(parseGhVersion('gh version DEV\n')).toBeUndefined()
    expect(parseGhVersion('')).toBeUndefined()
    expect(parseGhVersion('hub version 2.40.0\n')).toBeUndefined()
    expect(parseGhVersion(`gh version ${'9'.repeat(12)}.0.0\n`)).toBeUndefined()
  })

  it('compares by number, part by part', () => {
    expect(isAtLeast('2.9.0', '2.40.0')).toBe(false)
    expect(isAtLeast('2.40.0', '2.40.0')).toBe(true)
    expect(isAtLeast('2.40.1', '2.40.0')).toBe(true)
    expect(isAtLeast('2.39.9', '2.40.0')).toBe(false)
    expect(isAtLeast('3.0.0', '2.40.0')).toBe(true)
    expect(isAtLeast('10.0.0', '9.99.99')).toBe(true)
  })

  it('holds the fake to the oldest version this build reads', () => {
    expect(FAKE_GH_VERSION).toBe(GH_MINIMUM_VERSION)
  })
})

const ACME: GitHubRepository = { host: 'github.com', owner: 'acme', name: 'iac' }

/** The GitHub road of `road.test.ts`'s second row. */
const ROAD: GitHubRoad = {
  kind: 'github',
  repository: ACME,
  remote: 'origin',
  base: 'main',
  branch: 'main',
  pushUrl: 'git@github.com:acme/iac.git',
}

const LOCAL = '; or add --local to cut the branch in this clone only'

/** The refusal `readIdentity` throws over `fake`, which must be the user's to fix: exit 2. */
const refusal = async (fake: FakeGitHub, purpose?: 'submission' | 'protection'): Promise<string> => {
  const error: unknown = await readIdentity(githubClient({ run: fake.process }), ROAD, purpose).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(ForgeInputError)
  return (error as Error).message
}

const LOGGED_OUT =
  'main tracks github.com/acme/iac, and gh is not logged in to github.com, so idpa cannot read the rules that ' +
  'keep a pull request from merging unreviewed. Run `gh auth login --hostname github.com`, then run this again' +
  `${LOCAL}. Nothing was written.`

/** Each refusal of the table, as the fake is set up for it, and its sentence for a submission. */
const REFUSALS: readonly { readonly name: string; readonly model: FakeModel; readonly sentence: string }[] = [
  {
    name: 'gh not installed',
    model: { installed: false },
    sentence:
      'main tracks github.com/acme/iac, and gh is not installed, so idpa cannot read the rules that keep a pull ' +
      `request from merging unreviewed. Install it (https://cli.github.com) and run this again${LOCAL}. Nothing was written.`,
  },
  { name: 'gh logged out (its exit 4)', model: { session: undefined }, sentence: LOGGED_OUT },
  { name: 'an expired login (401 on /user)', model: { session: { login: 'ada', expired: true } }, sentence: LOGGED_OUT },
  {
    name: 'gh older than the oldest this build reads',
    model: { version: '2.39.2' },
    sentence: `gh 2.39.2 is older than 2.40.0, the oldest this build reads; update gh, then run this again${LOCAL}. Nothing was written.`,
  },
  {
    name: 'gh printing no version this build reads',
    model: { version: 'DEV' },
    sentence: `gh printed no version this build reads; update gh, then run this again${LOCAL}. Nothing was written.`,
  },
  {
    name: 'gh logged in as a Bot',
    model: { accounts: [{ login: 'robot', type: 'Bot' }], session: { login: 'robot' } },
    sentence:
      "gh is logged in to github.com as robot, which GitHub says is a Bot, not a person: the pull request's author " +
      'would be a bot, and whoever asked could approve it. Log gh in as yourself (gh auth login --hostname github.com), ' +
      'or add --local to cut the branch in this clone only. Nothing was written.',
  },
  {
    name: 'gh logged in as an organisation',
    model: { accounts: [{ login: 'acme', type: 'Organization' }], session: { login: 'acme' } },
    sentence:
      "gh is logged in to github.com as acme, which GitHub says is an Organization, not a person: the pull request's " +
      'author would be a bot, and whoever asked could approve it. Log gh in as yourself (gh auth login --hostname ' +
      'github.com), or add --local to cut the branch in this clone only. Nothing was written.',
  },
  {
    name: '/user refused (403: a workflow’s or an installation’s token)',
    model: { userRefused: true },
    sentence:
      'gh is logged in to github.com with a token GitHub will not describe as a user (it answered 403 to /user), as ' +
      "a workflow's or an app's is: the pull request's author would be a bot, and whoever asked could approve it. " +
      'Log gh in as yourself (gh auth login --hostname github.com), or add --local to cut the branch in this clone ' +
      'only. Nothing was written.',
  },
]

describe('readIdentity', () => {
  it('a person: the login, no role, and two gh calls', async () => {
    const fake = fakeGitHub()
    const gh = githubClient({ run: fake.process })
    const identity: GhIdentity = await readIdentity(gh, ROAD)
    expect(identity).toEqual({ login: 'ada', role: undefined })
    expect(gh.calls()).toBe(2)
    expect(fake.sent.map((call) => call.argv)).toEqual([
      ['--version'],
      ['api', '--hostname', 'github.com', '--method', 'GET', '--include', 'user'],
    ])
  })

  for (const { name, model, sentence } of REFUSALS) {
    it(`refuses ${name}, exit 2, naming the one command that fixes it`, async () => {
      expect(await refusal(fakeGitHub(model))).toBe(sentence)
    })

    it(`refuses ${name} for idpa protection without offering --local`, async () => {
      const without = sentence.replace(LOCAL, '').replace(', or add --local to cut the branch in this clone only', '')
      expect(without).not.toContain('--local')
      expect(await refusal(fakeGitHub(model), 'protection')).toBe(without)
    })
  }

  it('refuses a login outside the grammar, unquoted', async () => {
    const fake = fakeGitHub({ accounts: [{ login: 'ada\u202Eevil', type: 'User' }], session: { login: 'ada\u202Eevil' } })
    const message = await refusal(fake)
    expect(message).toBe('gh is logged in to github.com as an account whose name this build does not read. Nothing was written.')
  })

  it('reads nothing past a refused version', async () => {
    const fake = fakeGitHub({ version: '2.39.2' })
    await refusal(fake)
    expect(fake.sent.map((call) => call.argv)).toEqual([['--version']])
  })

  it('a gh that hangs or fails on --version is not told to update: exit 1', async () => {
    const exits: readonly [string, Partial<Awaited<ReturnType<GhProcess>>>, GitHubAnswerError['status']][] = [
      ['timed out', { code: undefined, timedOut: true }, 'timeout'],
      ['past the bound', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'too-large'],
      ['failed', { code: 1 }, 'unreadable'],
    ]
    for (const [name, exit, status] of exits) {
      const fake = fakeGitHub()
      const failing: GhProcess = async (argv, options) =>
        argv[0] === '--version'
          ? { code: 0, stdout: Buffer.alloc(0), stderr: '', timedOut: false, ...exit }
          : fake.process(argv, options)
      const error: unknown = await readIdentity(githubClient({ run: failing }), ROAD).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(error, name).toBeInstanceOf(GitHubAnswerError)
      expect(error, name).toMatchObject({ route: 'version', status })
      expect((error as Error).message, name).not.toContain('update gh')
      expect(fake.sent, name).toEqual([])
    }
  })

  it('an answer GitHub fails to give is not the person’s to fix: exit 1', async () => {
    const fake = fakeGitHub()
    const failing: GhProcess = async (argv, options) =>
      argv.at(-1) === 'user'
        ? { code: 1, stdout: Buffer.from('HTTP/2.0 502 Bad Gateway\r\n\r\n{}', 'utf8'), stderr: '', timedOut: false }
        : fake.process(argv, options)
    const error: unknown = await readIdentity(githubClient({ run: failing }), ROAD).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(GitHubAnswerError)
    expect(error).not.toBeInstanceOf(ForgeInputError)
    expect(error).toMatchObject({ route: 'user', status: 502 })
  })
})

/** A client that answers every `get` with `answer`, or throws `error`, and says it has made `made` calls. */
const clientOf = (options: { made?: number; answer?: GhAnswer; error?: Error }): GhClient & { gets: number } => {
  const client = {
    gets: 0,
    version: async () => 'gh version 2.40.0 (2023-12-07)\n',
    get: async () => {
      client.gets += 1
      if (options.error !== undefined) throw options.error
      return options.answer ?? { status: 200, hasNext: false, body: '{"login":"ada","type":"User"}' }
    },
    openPullRequest: async () => {
      throw new Error('not a read')
    },
    calls: () => options.made ?? 0,
  }
  return client
}

describe('githubApi', () => {
  it('reads /user: the login and the type, whatever else GitHub sends', async () => {
    const client = clientOf({ answer: { status: 200, hasNext: false, body: '{"login":"ada","type":"User","id":1,"name":null}' } })
    expect(await githubApi(client, ACME).user()).toEqual({ login: 'ada', type: 'User' })
  })

  it('stops at the budget before a call: 48 gh calls add up exactly', async () => {
    expect(GITHUB_LIMITS.ghCalls).toBe(48)
    const client = clientOf({ made: 48 })
    await expect(githubApi(client, ACME).user()).rejects.toThrow('idp-agent made more than 48 gh calls in one run')
    expect(client.gets).toBe(0)
    const under = clientOf({ made: 47 })
    await githubApi(under, ACME).user()
    expect(under.gets).toBe(1)
  })

  it('refuses an answer it cannot read', async () => {
    for (const body of ['not json', '{"login":"ada"}', '{"login":1,"type":"User"}', '[]']) {
      const client = clientOf({ answer: { status: 200, hasNext: false, body } })
      await expect(githubApi(client, ACME).user(), body).rejects.toMatchObject({ route: 'user', status: 'unreadable' })
    }
  })

  it('classifies a status other than 200', async () => {
    for (const status of [401, 403, 404, 422, 500, 502]) {
      const client = clientOf({ answer: { status, hasNext: false, body: '{"message":"canary"}' } })
      const error: unknown = await githubApi(client, ACME).user().catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(GitHubAnswerError)
      expect(error).toMatchObject({ route: 'user', status })
      expect((error as Error).message).not.toContain('canary')
    }
  })

  it("wraps gh's own failures by what they mean", async () => {
    const cases: readonly [GhError['kind'], GitHubAnswerError['status']][] = [
      ['auth', 401],
      ['timeout', 'timeout'],
      ['too-large', 'too-large'],
      ['missing', 'unreadable'],
      ['unreadable', 'unreadable'],
      ['failed', 'unreadable'],
    ]
    for (const [kind, status] of cases) {
      const client = clientOf({ error: new GhError(kind, 'api') })
      await expect(githubApi(client, ACME).user(), kind).rejects.toMatchObject({ route: 'user', status })
    }
  })
})

describe('GitHubAnswerError', () => {
  it("says each class of failure in this build's words, never GitHub's", () => {
    const said = (status: GitHubAnswerError['status']): string => new GitHubAnswerError('user', status, ACME).message
    expect(said(401)).toBe(
      "github.com refused gh's login during the run (401 on user): run gh auth login --hostname github.com again. " +
        'Nothing was written.',
    )
    expect(said(403)).toBe(
      'github.com answered 403 through gh on user: your account cannot do this on acme/iac, or GitHub is limiting how ' +
        'fast it may be asked; it does not say which. Nothing was written.',
    )
    expect(said(404)).toBe(
      'github.com answered 404 through gh on user: acme/iac does not exist, or your account cannot see it; GitHub ' +
        'does not say which. Nothing was written.',
    )
    expect(said(502)).toBe('github.com answered 502 through gh on user; try again later. Nothing was written.')
    expect(said(422)).toBe('github.com answered 422 through gh on user, which this build does not read. Nothing was written.')
    expect(said('timeout')).toBe('gh did not answer within 15 s on user. Nothing was written.')
    expect(said('too-large')).toBe("gh's answer on user was over 1 MiB, more than this build reads. Nothing was written.")
    expect(said('unreadable')).toBe("gh's answer on user could not be read. Nothing was written.")
    expect(new GitHubAnswerError('version', 'timeout', ACME).message).toBe(
      'gh did not answer within 15 s on version. Nothing was written.',
    )
    expect(said('paginated')).toBe(
      "github.com's answer on user runs to more than one page, which this build does not read. Nothing was written.",
    )
  })
})
