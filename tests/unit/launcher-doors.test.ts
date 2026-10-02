import { afterEach, describe, expect, it } from 'vitest'
import { checkGhArgv, ghIn, type GhRoute } from '../../src/process/gh.js'
import { checkGitArgv, gitIn, pushIn, type PushRequest } from '../../src/process/git.js'
import { LauncherRefusal } from '../../src/process/refusal.js'
import { DOORS, GIT_DOORS } from '../support/fake-gh.js'
import { onPath, removeStubs, stubGh, stubGit } from '../support/stub-gh.js'

/**
 * Every door of stage 6 brief § 6 — each git push variant, each gh command,
 * each forbidden flag, each path outside the templates, a second host — is
 * refused before a process starts, and a stub first on PATH records no call.
 * The doors are `tests/support/fake-gh.ts`'s, and so are these titles: this
 * file spells none (the architecture rule on tests/ holds that).
 */

afterEach(removeStubs)

const stdinOf = (text: string | undefined): Buffer | undefined => (text === undefined ? undefined : Buffer.from(text, 'utf8'))

describe('the gh grammar refuses every door', () => {
  for (const door of DOORS) {
    it(door.name, () => {
      expect(() => checkGhArgv(door.argv, stdinOf(door.stdin))).toThrow(LauncherRefusal)
    })
  }
})

describe('the git grammar refuses every door', () => {
  for (const door of GIT_DOORS) {
    it(door.name, () => {
      expect(() => checkGitArgv(door.argv)).toThrow(LauncherRefusal)
    })
  }
})

describe('the launchers start nothing for a hostile value', () => {
  it('gh: a placeholder, an id, a short sha, a hostile body', async () => {
    const stub = await stubGh()
    const gh = ghIn({ env: onPath(stub.bin) })
    const routes: GhRoute[] = [
      { route: 'repository', owner: '{owner}', name: 'iac' },
      { route: 'repository', owner: 'acme', name: '..' },
      { route: 'ref', owner: 'acme', name: 'iac', branch: 'release/{x}' },
      { route: 'ref', owner: 'acme', name: 'iac', branch: 'main\u202e' },
      { route: 'branch', owner: 'acme', name: 'iac', branch: '../../user' },
      { route: 'rules', owner: 'acme', name: 'iac', branch: 'a\ud800' },
      { route: 'ruleset', owner: 'acme', name: 'iac', id: 0 },
      { route: 'ruleset', owner: 'acme', name: 'iac', id: 1.5 },
      { route: 'commit', owner: 'acme', name: 'iac', sha: 'abc1234' },
      { route: 'pulls', owner: 'acme', name: 'iac', head: 'main' },
      { route: 'pulls', owner: 'acme/evil', name: 'iac', head: 'idp-agent/x-0123abcd' },
      { route: 'open-pulls', owner: 'acme', name: 'iac', base: 'main', page: 4 },
      { route: 'open-pulls', owner: 'acme', name: 'iac', base: 'main', page: 0 },
      { route: 'open-pulls', owner: 'acme', name: 'iac', base: '{branch}', page: 1 },
      { route: 'open-pulls', owner: 'acme', name: 'iac', base: 'main\u202e', page: 1 },
      { route: 'pull-files', owner: 'acme', name: 'iac', number: 0 },
      { route: 'pull-files', owner: 'acme', name: 'iac', number: 2.5 },
    ]
    for (const route of routes) {
      await expect(gh.get(route), JSON.stringify(route)).rejects.toBeInstanceOf(LauncherRefusal)
    }
    const bodies = DOORS.filter((door) => door.argv.includes('repos/acme/iac/pulls') && door.stdin !== undefined)
    expect(bodies.length).toBeGreaterThan(5)
    for (const door of bodies) {
      await expect(gh.openPullRequest('acme', 'iac', door.stdin ?? ''), door.name).rejects.toBeInstanceOf(LauncherRefusal)
    }
    await expect(gh.openPullRequest('acme', 'iac', 'not json')).rejects.toBeInstanceOf(LauncherRefusal)
    expect(gh.calls()).toBe(0)
    expect(await stub.calls()).toEqual([])
  })

  it('gh: a refusal names the command word, never the value refused', async () => {
    // A value can hold a repository's content: the message is the launcher's.
    const gh = ghIn({ env: onPath((await stubGh()).bin) })
    const refusals = [
      gh.get({ route: 'repository', owner: 'canary-owner-value', name: '..' }),
      gh.get({ route: 'ref', owner: 'acme', name: 'iac', branch: 'canary-branch-value\u202e' }),
      gh.openPullRequest('acme', 'iac', JSON.stringify({ title: 'canary-title-value', merge_method: 'squash' })),
    ]
    for (const refusal of refusals) {
      const error = await refusal.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LauncherRefusal)
      expect((error as LauncherRefusal).message).toBe('gh api is not a command idp-agent runs')
    }
  })

  it('git: a command outside the list, a push outside its form', async () => {
    const stub = await stubGit()
    const repo = '/work/iac'
    await expect(gitIn(repo, { env: onPath(stub.bin) })(['fetch'])).rejects.toBeInstanceOf(LauncherRefusal)
    const sha = '0123456789abcdef0123456789abcdef01234567'
    const url = 'git@github.com:acme/iac.git'
    const branch = 'idp-agent/x-0123abcd'
    const requests: PushRequest[] = [
      { url: 'git@evil.example:acme/iac.git', commit: sha, branch },
      { url: 'https://x:y@github.com/acme/iac.git', commit: sha, branch },
      { url: '-uhttps://github.com/acme/iac', commit: sha, branch },
      { url: 'origin', commit: sha, branch },
      { url, commit: sha, branch: 'main' },
      { url, commit: sha, branch: 'idp-agent/X' },
      { url, commit: sha, branch: `${branch}:refs/heads/main` },
      { url, commit: sha.slice(0, 7), branch },
      { url, commit: `+${sha}`, branch },
    ]
    const push = pushIn(repo, { env: onPath(stub.bin) })
    for (const request of requests) {
      await expect(push(request), JSON.stringify(request)).rejects.toBeInstanceOf(LauncherRefusal)
    }
    expect(await stub.calls()).toEqual([])
  })
})
