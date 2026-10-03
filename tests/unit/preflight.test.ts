import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GitHubRepository } from '../../src/core/github/remote.js'
import { GitHubAnswerError, githubApi, githubClient, type GitHubApi } from '../../src/forge/github/api.js'
import { preflight, readProtection } from '../../src/forge/github/preflight.js'
import type { GitHubRoad } from '../../src/forge/provider.js'
import type { GhProcess } from '../../src/process/gh.js'
import { removeClones, scratch } from '../support/forge-fixture.js'
import { fakeGitHub, protectedMain, protectingRuleset, repository, type FakeGitHub } from '../support/fake-gh.js'
import { committed, git } from '../support/git.js'
import type { FakeRepository } from '../../tools/fake-gh.js'

/**
 * The reads of stage 6 brief § 8, items 1 to 5, through gh with `GET` only
 * and in order, and the base's level check a submission adds: over the fake
 * gh, handed to the launcher as its process, so every vector passes the
 * launcher's grammar and then the fake's own. No real gh starts; the bare
 * repositories the fake reads refs from are made here, on disk, and nothing
 * talks to a remote.
 */

afterAll(removeClones)

const ACME: GitHubRepository = { host: 'github.com', owner: 'acme', name: 'iac' }

const roadTo = (base: string): GitHubRoad => ({
  kind: 'github',
  repository: ACME,
  remote: 'origin',
  base,
  branch: base,
  pushUrl: 'git@github.com:acme/iac.git',
})

const ROAD = roadTo('main')

/** The API over the fake, as the forge builds it. */
const over = (fake: FakeGitHub): GitHubApi => githubApi(githubClient({ run: fake.process }), ACME)

/** The paths the fake was asked for, in order. */
const paths = (fake: FakeGitHub): string[] => fake.sent.map((sent) => sent.argv[6] ?? '')

/** A committed clone, whose own git directory serves as the bare repository GitHub's refs are read from. */
const clone = async (): Promise<{ root: string; bare: string; head: string }> => {
  const root = await scratch('idp-preflight-')
  const repo = path.join(root, 'iac')
  await mkdir(repo)
  const head = await committed(repo)
  return { root, bare: path.join(repo, '.git'), head }
}

/** The error a read threw, which must be GitHub's answer: exit 1. */
const thrown = async (read: Promise<unknown>): Promise<GitHubAnswerError> => {
  const error: unknown = await read.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(GitHubAnswerError)
  return error as GitHubAnswerError
}

describe('readProtection: § 8, items 1 to 5', () => {
  it('reads what § 8 needs, in order, and nothing more', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const api = over(fake)
    const verdict = await readProtection(api, ROAD)
    expect(verdict).toMatchObject({ holds: true, missing: [], rulesets: [1] })
    expect(verdict.reported).toMatchObject({ role: 'admin', bypassActors: [] })
    expect(api.calls()).toBe(3)
    expect(paths(fake)).toEqual([
      'repos/acme/iac',
      'repos/acme/iac/rules/branches/main?per_page=100',
      'repos/acme/iac/rulesets/1',
    ])
    for (const sent of fake.sent) expect(sent.argv.slice(0, 6)).toEqual(['api', '--hostname', 'github.com', '--method', 'GET', '--include'])
  })

  it('reads the branch only when the rules route answers no rule at all', async () => {
    const classic = fakeGitHub({ repositories: [repository({ branches: { main: { protected: true } } })] })
    expect(await readProtection(over(classic), ROAD)).toMatchObject({ holds: false, missing: ['classic-only'] })
    expect(paths(classic)).toEqual([
      'repos/acme/iac',
      'repos/acme/iac/rules/branches/main?per_page=100',
      'repos/acme/iac/branches/main',
    ])

    const guarded = fakeGitHub({ repositories: [protectedMain({ branches: { main: { protected: true } } })] })
    expect((await readProtection(over(guarded), ROAD)).holds).toBe(true)
    expect(paths(guarded).some((sent) => sent.includes('/branches/main') && !sent.includes('/rules/'))).toBe(false)
  })

  it('does not read the branch under a ruleset that supplies none of the three, and names the four rules it lacks', async () => {
    // GitHub answers `protected: true` for a branch any active ruleset covers (2026-10-02):
    // read here, it would call this base protected by classic protection only.
    const signaturesOnly = protectingRuleset(1, { rules: [{ type: 'required_signatures' }] })
    for (const classic of [false, true]) {
      const fake = fakeGitHub({ repositories: [repository({ rulesets: [signaturesOnly], branches: { main: { protected: classic } } })] })
      const verdict = await readProtection(over(fake), ROAD)
      expect(verdict, `classic: ${String(classic)}`).toMatchObject({
        holds: false,
        missing: ['pull-request', 'last-push', 'non-fast-forward', 'deletion'],
        rulesets: [],
      })
      expect(verdict.reported.signatures).toBe(true)
      expect(paths(fake)).toEqual(['repos/acme/iac', 'repos/acme/iac/rules/branches/main?per_page=100'])
    }
  })

  it('reads a ruleset in evaluate mode as no ruleset, as GitHub returns none of its rules', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain({ rulesets: [protectingRuleset(1, { enforcement: 'evaluate' })] })] })
    expect(await readProtection(over(fake), ROAD)).toMatchObject({
      holds: false,
      missing: ['pull-request', 'last-push', 'non-fast-forward', 'deletion'],
    })
  })

  it('stops at item 1: an archived repository is read once', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain({ archived: true })] })
    const api = over(fake)
    expect(await readProtection(api, ROAD)).toMatchObject({ holds: false, missing: ['archived'], rulesets: [] })
    expect(api.calls()).toBe(1)
    expect(paths(fake)).toEqual(['repos/acme/iac'])
  })

  it('reads the bypass of the account gh acts as, and the list only an administrator is shown', async () => {
    const writer = fakeGitHub({
      repositories: [protectedMain({ permissions: { ada: { admin: false, maintain: false, push: true } } })],
    })
    const verdict = await readProtection(over(writer), ROAD)
    expect(verdict).toMatchObject({ holds: true })
    expect(verdict.reported).toMatchObject({ role: 'write', bypassActors: 'unreadable' })

    const bypassing = fakeGitHub({
      repositories: [
        protectedMain({
          rulesets: [protectingRuleset(1, { bypass: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }] })],
        }),
      ],
    })
    expect(await readProtection(over(bypassing), ROAD)).toMatchObject({ holds: false, missing: expect.arrayContaining(['bypassable']) })

    const keyed = fakeGitHub({
      repositories: [
        protectedMain({
          rulesets: [protectingRuleset(1, { bypass: [{ actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' }] })],
        }),
      ],
    })
    expect(await readProtection(over(keyed), ROAD)).toMatchObject({ holds: false, missing: ['deploy-key'] })
  })

  it('refuses more than it reasons about: a second page of rules, and more than ten rulesets', async () => {
    const many: FakeRepository = protectedMain({
      rulesets: [protectingRuleset(1, { rules: Array.from({ length: 101 }, () => ({ type: 'deletion' })) })],
    })
    const paged = await thrown(readProtection(over(fakeGitHub({ repositories: [many] })), ROAD))
    expect(paged.status).toBe('paginated')
    expect(paged.message).toBe(
      "github.com/acme/iac's main has more than 100 rules, more than this build reasons about. Nothing was written.",
    )

    const eleven = fakeGitHub({
      repositories: [
        protectedMain({
          rulesets: Array.from({ length: 11 }, (_, index) => protectingRuleset(index + 1, { rules: [{ type: 'deletion' }] })),
        }),
      ],
    })
    const wide = await thrown(readProtection(over(eleven), ROAD))
    expect(wide.status).toBe('too-large')
    expect(wide.message).toBe(
      "github.com/acme/iac's main draws its rules from more than 10 rulesets, more than this build reads. Nothing was written.",
    )
    expect(paths(eleven).some((sent) => sent.includes('/rulesets/'))).toBe(false)
  })

  it('refuses a repository GitHub will not show, in this build’s words', async () => {
    const error = await thrown(readProtection(over(fakeGitHub()), ROAD))
    expect(error).toMatchObject({ route: 'repository', status: 404 })
    expect(error.message).toMatch(/^github\.com answered 404 through gh on repository: acme\/iac does not exist/)
  })
})

describe('preflight: the rules, and the base level with the clone’s', () => {
  it('says whether the base is level: the same commit, one ahead, or not there at all', async () => {
    const { root, bare, head } = await clone()

    const level = fakeGitHub({ repositories: [protectedMain({ bare })] })
    const api = over(level)
    expect(await preflight(api, ROAD, { branch: 'main', commit: head })).toMatchObject({
      verdict: { holds: true },
      level: 'level',
    })
    expect(api.calls()).toBe(4)
    expect(paths(level).at(-1)).toBe('repos/acme/iac/git/ref/heads/main')

    const ahead = path.join(root, 'ahead.git')
    await cp(bare, ahead, { recursive: true })
    const tree = await git(ahead, 'rev-parse', `${head}^{tree}`)
    const moved = await git(ahead, 'commit-tree', tree, '-p', head, '-m', 'merged on GitHub')
    await git(ahead, 'update-ref', 'refs/heads/main', moved)
    const later = fakeGitHub({ repositories: [protectedMain({ bare: ahead })] })
    expect(await preflight(over(later), ROAD, { branch: 'main', commit: head })).toMatchObject({ level: { github: moved } })

    const empty = path.join(root, 'empty.git')
    await git(root, 'init', '-q', '--bare', empty)
    const missing = await thrown(
      preflight(over(fakeGitHub({ repositories: [protectedMain({ bare: empty })] })), ROAD, { branch: 'main', commit: head }),
    )
    expect(missing).toMatchObject({ route: 'ref', status: 404 })
    expect(missing.message).toBe(
      'github.com answered 404 through gh on ref: github.com/acme/iac has no branch main, or your account cannot see it; ' +
        'GitHub does not say which. Nothing was written.',
    )
  })

  it('reads a base with a slash as GitHub addresses it', async () => {
    const { root, bare, head } = await clone()
    const release = path.join(root, 'release.git')
    await cp(bare, release, { recursive: true })
    await git(release, 'update-ref', 'refs/heads/release/1', head)
    const fake = fakeGitHub({
      repositories: [protectedMain({ bare: release, rulesets: [protectingRuleset(1, { branches: ['release/1'] })] })],
    })
    const read = await preflight(over(fake), roadTo('release/1'), { branch: 'release/1', commit: head })
    expect(read).toMatchObject({ verdict: { holds: true }, level: 'level' })
    expect(paths(fake)).toEqual([
      'repos/acme/iac',
      'repos/acme/iac/rules/branches/release/1?per_page=100',
      'repos/acme/iac/rulesets/1',
      'repos/acme/iac/git/ref/heads/release/1',
    ])
  })
})

describe('the reads, as the API holds them', () => {
  /** A gh that answers every call with `body`, as GitHub would, status 200. */
  const answering =
    (body: unknown): GhProcess =>
    async () => ({
      code: 0,
      stdout: Buffer.from(`HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`),
      stderr: '',
      timedOut: false,
    })
  const apiOf = (body: unknown): GitHubApi => githubApi(githubClient({ run: answering(body) }), ACME)

  it('reads no field it does not need', async () => {
    const read = await apiOf({
      full_name: 'acme/iac',
      archived: false,
      owner: { login: 'acme' },
      description: 'the declarations',
      canary: 'never kept',
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    }).repository()
    expect(read).toEqual({ full_name: 'acme/iac', archived: false, permissions: { admin: false, maintain: false, push: true } })
  })

  it('refuses a ruleset answer without its id, or with another one', async () => {
    expect(await thrown(apiOf({ current_user_can_bypass: 'never' }).ruleset(1))).toMatchObject({
      route: 'ruleset',
      status: 'unreadable',
    })
    expect(await thrown(apiOf({ id: 2, current_user_can_bypass: 'never' }).ruleset(1))).toMatchObject({
      route: 'ruleset',
      status: 'unreadable',
    })
  })

  it('refuses a ref answer about another branch than the one asked for', async () => {
    const sha = 'a'.repeat(40)
    expect(await apiOf({ ref: 'refs/heads/main', object: { type: 'commit', sha } }).ref('main')).toBe(sha)
    for (const ref of ['refs/heads/other', 'refs/heads/main/x', 'refs/tags/main', 'main']) {
      expect(await thrown(apiOf({ ref, object: { type: 'commit', sha } }).ref('main')), ref).toMatchObject({
        route: 'ref',
        status: 'unreadable',
      })
    }
  })
})
