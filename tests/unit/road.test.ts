import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { configRefusal } from '../../src/core/github/config.js'
import { ForgeInputError } from '../../src/forge/errors.js'
import { readRoad } from '../../src/forge/github/road.js'
import type { Road } from '../../src/forge/provider.js'
import { gitIn, type Git } from '../../src/process/git.js'
import { removeClones, scratch } from '../support/forge-fixture.js'
import { committed, git } from '../support/git.js'

/**
 * The road a submission takes, read before anything is read on GitHub (stage
 * 6 brief § 13): the branch HEAD names, the remote it tracks and the branch
 * on it, both URLs the person's own git prints, and — on the GitHub road
 * only — the clone's own configuration, refused by key and scope (§ 7).
 *
 * Over real clones, read through the real launcher (`gitIn`); nothing talks
 * to a remote — `git remote add` and `git config` write `.git/config` and
 * nothing else. Each case hands the launcher a HOME of its own, so the
 * "global" configuration a case writes is that case's and no other test's.
 *
 * NO REAL TOKEN IS WRITTEN HERE: the canaries were never issued by anyone.
 */

afterAll(removeClones)

const GITHUB = 'git@github.com:acme/iac.git'
const ACME = { host: 'github.com', owner: 'acme', name: 'iac' } as const

/** A committed clone on `main`, and a HOME of its own with nothing in it yet. */
const cloneWith = async (...remote: string[]): Promise<{ repo: string; home: string; git: Git }> => {
  const root = await scratch('idp-road-')
  const repo = path.join(root, 'iac')
  const home = path.join(root, 'home')
  await mkdir(repo)
  await mkdir(home)
  await committed(repo)
  if (remote.length > 0) {
    await git(repo, 'remote', 'add', 'origin', ...remote)
    await git(repo, 'config', 'branch.main.remote', 'origin')
    await git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
  }
  return {
    repo,
    home,
    git: gitIn(repo, { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } }),
  }
}

/** The refusal `readRoad` throws, which must be the user's argument: exit 2. */
const refusal = async (road: Promise<Road>): Promise<string> => {
  const error: unknown = await road.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(ForgeInputError)
  return (error as Error).message
}

/** The key as git lists it: section and variable lower-cased, a subsection as written. */
const listed = (key: string): string => {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  return first === last
    ? key.toLowerCase()
    : `${key.slice(0, first).toLowerCase()}${key.slice(first, last + 1)}${key.slice(last + 1).toLowerCase()}`
}

describe('readRoad: which road', () => {
  it('a branch that tracks nothing: the local branch, nothing pushed', async () => {
    const clone = await cloneWith()
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'no-upstream', branch: 'main' })
  })

  it('a remote set but no branch named on it: no upstream', async () => {
    const clone = await cloneWith()
    await git(clone.repo, 'remote', 'add', 'origin', GITHUB)
    await git(clone.repo, 'config', 'branch.main.remote', 'origin')
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'no-upstream', branch: 'main' })
  })

  it('a branch that tracks a branch on github.com: the GitHub road', async () => {
    const clone = await cloneWith(GITHUB)
    expect(await readRoad(clone.git, { local: false })).toEqual({
      kind: 'github',
      repository: ACME,
      remote: 'origin',
      base: 'main',
      branch: 'main',
      pushUrl: GITHUB,
    })
  })

  it('the base is the branch it tracks, not the default branch', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'branch', 'feature')
    await git(clone.repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature')
    await git(clone.repo, 'config', 'branch.feature.remote', 'origin')
    await git(clone.repo, 'config', 'branch.feature.merge', 'refs/heads/release/1')
    expect(await readRoad(clone.git, { local: false })).toMatchObject({ kind: 'github', base: 'release/1', branch: 'feature' })
  })

  it('a remote of another host: the local branch', async () => {
    const clone = await cloneWith('git@gitlab.example.com:acme/iac.git')
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'other-host', host: 'gitlab.example.com' })
  })

  it('a remote on this machine: the local branch, as stage 5', async () => {
    const bare = path.join(await scratch('idp-road-bare-'), 'iac.git')
    await mkdir(bare)
    await git(bare, 'init', '-q', '--bare')
    const clone = await cloneWith(bare)
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'other-host', host: 'this machine' })
  })

  it('--local: the local branch, and no git call made', async () => {
    let calls = 0
    const counting: Git = async () => {
      calls += 1
      throw new Error('no call expected')
    }
    expect(await readRoad(counting, { local: true })).toEqual({ kind: 'local', why: 'asked' })
    expect(calls).toBe(0)
  })

  it("the person's global configuration is theirs: a rewrite to github.com's SSH form", async () => {
    const clone = await cloneWith('https://github.com/acme/iac')
    await writeFile(path.join(clone.home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n')
    expect(await readRoad(clone.git, { local: false })).toEqual({
      kind: 'github',
      repository: ACME,
      remote: 'origin',
      base: 'main',
      branch: 'main',
      pushUrl: 'git@github.com:acme/iac',
    })
  })

  it('a local rewrite of github.com to another host is read as that host: nothing is pushed', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'url.git@evil.example:.insteadOf', 'git@github.com:')
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'other-host', host: 'evil.example' })
  })
})

describe('readRoad: the remote, refused before anything is read on GitHub', () => {
  const FORK =
    'origin fetches from github.com/acme/iac and pushes to github.com/evil/iac; idpa pushes only where it reads ' +
    '(a fork set-up is not supported). Nothing was written.'

  it('a push URL naming another repository', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'remote.origin.pushurl', 'git@github.com:evil/iac.git')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(FORK)
  })

  it('a local pushInsteadOf sending the push elsewhere', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'url.git@github.com:evil/.pushInsteadOf', 'git@github.com:acme/')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(FORK)
  })

  it('a push to another host than the fetch', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'remote.origin.pushurl', 'git@gitlab.example.com:acme/iac.git')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(
      'origin fetches from github.com/acme/iac and pushes to gitlab.example.com; idpa pushes only where it reads ' +
        '(a fork set-up is not supported). Nothing was written.',
    )
  })

  it('the same repository, whatever the case it is written in', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'remote.origin.pushurl', 'https://github.com/ACME/IaC')
    expect(await readRoad(clone.git, { local: false })).toMatchObject({ kind: 'github', pushUrl: 'https://github.com/ACME/IaC' })
  })

  it('two fetch URLs, or two push URLs', async () => {
    const fetches = await cloneWith(GITHUB)
    await git(fetches.repo, 'config', '--add', 'remote.origin.url', 'https://github.com/acme/iac')
    expect(await refusal(readRoad(fetches.git, { local: false }))).toBe('origin has 2 fetch URLs; idpa reads one. Nothing was written.')

    const pushes = await cloneWith(GITHUB)
    await git(pushes.repo, 'config', '--add', 'remote.origin.pushurl', GITHUB)
    await git(pushes.repo, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/iac')
    expect(await refusal(readRoad(pushes.git, { local: false }))).toBe('origin has 2 push URLs; idpa reads one. Nothing was written.')
  })

  it('a URL that carries a credential, never quoted', async () => {
    const clone = await cloneWith('https://x-access-token:canary@github.com/acme/iac.git')
    const message = await refusal(readRoad(clone.git, { local: false }))
    expect(message).toBe("origin's URL carries a credential; set it to https://github.com/acme/iac. Nothing was written.")
    expect(message).not.toContain('canary')
  })

  it('a URL that carries a credential and a path this build does not read, neither quoted', async () => {
    const clone = await cloneWith('https://canary@github.com/acme/iac?canary=1')
    const message = await refusal(readRoad(clone.git, { local: false }))
    expect(message).toBe("origin's URL carries a credential; set it to a URL without one (git remote set-url). Nothing was written.")
  })

  it('a GitHub URL that does not parse, unquoted', async () => {
    const clone = await cloneWith('https://github.com/acme')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(
      "origin's URL does not parse as a GitHub repository (https://github.com/<owner>/<name>, " +
        'git@github.com:<owner>/<name> and the three SSH forms docs/submitting.md lists). Nothing was written.',
    )
  })

  const SET_UPSTREAM =
    '; idpa pushes to a named remote. Set its upstream to one (git branch --set-upstream-to <remote>/<branch>), ' +
    'then run this again. Nothing was written.'

  it('a branch that tracks this clone itself', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'branch.main.remote', '.')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(
      `main tracks this clone itself (branch.main.remote is .)${SET_UPSTREAM}`,
    )
  })

  it('a branch that tracks a URL rather than a remote', async () => {
    for (const url of [GITHUB, '/srv/iac.git', '../iac']) {
      const clone = await cloneWith(GITHUB)
      await git(clone.repo, 'config', 'branch.main.remote', url)
      const message = await refusal(readRoad(clone.git, { local: false }))
      expect(message, url).toBe(`branch.main.remote is a URL, not a remote's name${SET_UPSTREAM}`)
    }
  })

  it("a remote's name outside the grammar, or one git would not take, unquoted", async () => {
    for (const name of ['--push', '.hidden', 'a b', 'a.lock', 'a//b']) {
      const clone = await cloneWith(GITHUB)
      await git(clone.repo, 'config', 'branch.main.remote', name)
      expect(await refusal(readRoad(clone.git, { local: false })), name).toBe(
        "branch.main.remote names a remote this build does not read (a name is 1 to 100 letters, digits, '.', '_', " +
          "'-' and '/', not beginning with '-' or '.'). Nothing was written.",
      )
    }
  })

  it('an upstream that is not a branch', async () => {
    // refs/heads/HEAD passes the grammar and is git's to refuse: check-ref-format
    // --branch says no with die(), exit 128, not 1 (measured, git 2.46).
    for (const merge of ['refs/tags/v1', 'refs/pull/1/head', 'main', 'refs/heads/a%b', 'refs/heads/HEAD']) {
      const clone = await cloneWith(GITHUB)
      await git(clone.repo, 'config', 'branch.main.merge', merge)
      expect(await refusal(readRoad(clone.git, { local: false })), merge).toBe(
        "main's upstream is not a branch this build reads (branch.main.merge must be refs/heads/ and a branch name). " +
          'Nothing was written.',
      )
    }
  })

  it('a remote this clone does not define', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'branch.main.remote', 'upstream')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(
      'main tracks upstream, which this clone does not define (git remote -v lists its remotes). Nothing was written.',
    )
  })

  it('a detached HEAD, in stage 5’s words', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'checkout', '-q', '--detach')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe('HEAD is detached; check out the branch this request is for')
  })

  /** HEAD on a new branch `name`, tracking origin's main when `tracked`. */
  const onBranch = async (clone: { repo: string }, name: string, tracked: boolean): Promise<void> => {
    await git(clone.repo, 'branch', name)
    await git(clone.repo, 'symbolic-ref', 'HEAD', `refs/heads/${name}`)
    if (!tracked) return
    await git(clone.repo, 'config', `branch.${name}.remote`, 'origin')
    await git(clone.repo, 'config', `branch.${name}.merge`, 'refs/heads/main')
  }

  it('a checked-out branch whose name GitHub would read as an escape, once it tracks a branch', async () => {
    const clone = await cloneWith(GITHUB)
    await onBranch(clone, 'a%b', true)
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(
      "a%b is a branch name this build does not read ('%' is read as an escape in GitHub's paths); rename it " +
        '(git branch -m <name>), or add --local to cut the branch in this clone only. Nothing was written.',
    )
  })

  it('a checked-out branch whose name this build does not read, unquoted, once it tracks a branch', async () => {
    const clone = await cloneWith(GITHUB)
    await onBranch(clone, 'a{b', true)
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(
      "the checked-out branch has a name this build does not read (no '{', '}', '%' or invisible character); " +
        'rename it (git branch -m <name>), or add --local to cut the branch in this clone only. Nothing was written.',
    )
  })

  it('offers no --local to idpa protection, which takes none', async () => {
    const clone = await cloneWith(GITHUB)
    await onBranch(clone, 'a%b', true)
    expect(await refusal(readRoad(clone.git, { local: false, purpose: 'protection' }))).toBe(
      "a%b is a branch name this build does not read ('%' is read as an escape in GitHub's paths); rename it " +
        '(git branch -m <name>). Nothing was written.',
    )
  })

  // A branch that tracks nothing pushes nothing and is read on no GitHub
  // path: stage 5's road, whatever its name, as it was before the road was
  // read (the brief's § 13 table). Its name is printed, inert, by `cli/`.
  it.each(['a%b', 'a{b', 'safe\u202egnp.exe'])('a branch that tracks nothing, whatever its name: no upstream (%j)', async (name) => {
    const clone = await cloneWith(GITHUB)
    await onBranch(clone, name, false)
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'no-upstream', branch: name })
    await git(clone.repo, 'config', `branch.${name}.remote`, 'origin')
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'no-upstream', branch: name })
  })
})

describe("readRoad: the clone's own configuration, on the GitHub road", () => {
  /** § 7's refused keys, each with a value that holds a canary. */
  const REFUSED: readonly (readonly [string, string])[] = [
    ['url.git@evil.example:.insteadOf', 'git@nowhere.example:'],
    ['credential.helper', 'store --file=/tmp/canary'],
    ['credential.https://github.com.helper', 'canary'],
    ['http.proxy', 'http://canary.example:1'],
    ['http.https://github.com/.extraHeader', 'AUTHORIZATION: basic canary'],
    ['protocol.allow', 'canary'],
    ['ssh.variant', 'canary'],
    ['gpg.program', '/tmp/canary'],
    ['push.pushOption', 'canary'],
    ['core.sshCommand', 'ssh -i /tmp/canary'],
    ['core.askPass', '/tmp/canary'],
    ['core.gitProxy', '/tmp/canary'],
    ['remote.origin.vcs', 'canary'],
    ['remote.origin.receivepack', '/tmp/canary'],
    ['remote.origin.uploadpack', '/tmp/canary'],
    ['remote.origin.proxy', 'http://canary.example:1'],
    ['remote.origin.proxyAuthMethod', 'canary'],
  ]

  it('refuses each key set locally, by key and scope, never by value', async () => {
    const clone = await cloneWith(GITHUB)
    for (const [key, value] of REFUSED) {
      await git(clone.repo, 'config', key, value)
      const message = await refusal(readRoad(clone.git, { local: false }))
      expect(message, key).toBe(configRefusal({ scope: 'local', key: listed(key) }, 0))
      expect(message, key).not.toContain('canary')
      await git(clone.repo, 'config', '--unset-all', key)
    }
    expect(await readRoad(clone.git, { local: false })).toMatchObject({ kind: 'github' })
  })

  it('refuses a remote section named after the push URL: git would push where it says', async () => {
    // git looks a push's URL up as a remote's name before it reads it as a URL,
    // so this section, not origin's URL, would decide where the push goes.
    for (const variable of ['url', 'pushurl']) {
      const clone = await cloneWith(GITHUB)
      const key = `remote.${GITHUB}.${variable}`
      await git(clone.repo, 'config', key, path.join(clone.home, 'canary.git'))
      const message = await refusal(readRoad(clone.git, { local: false }))
      expect(message, key).toBe(configRefusal({ scope: 'local', key }, 0))
      expect(message, key).toContain('remote.<a name this build does not print>.')
      expect(message, key).not.toContain('canary')
    }
  })

  it('refuses a key an include.path brings in, as local', async () => {
    const clone = await cloneWith(GITHUB)
    const included = path.join(path.dirname(clone.repo), 'included.gitconfig')
    await writeFile(included, '[credential]\n\thelper = store --file=/tmp/canary\n')
    await git(clone.repo, 'config', 'include.path', included)
    const message = await refusal(readRoad(clone.git, { local: false }))
    expect(message).toBe(configRefusal({ scope: 'local', key: 'credential.helper' }, 0))
    expect(message).not.toContain('canary')
  })

  it('names the first key the listing holds, and counts the others', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'credential.helper', 'canary')
    await git(clone.repo, 'config', 'http.proxy', 'canary')
    // git writes it into the [core] section `init` wrote, which comes first.
    await git(clone.repo, 'config', 'core.sshCommand', 'canary')
    expect(await refusal(readRoad(clone.git, { local: false }))).toBe(
      configRefusal({ scope: 'local', key: 'core.sshcommand' }, 2),
    )
  })

  it("leaves the person's global configuration alone", async () => {
    const clone = await cloneWith(GITHUB)
    await writeFile(
      path.join(clone.home, '.gitconfig'),
      '[credential]\n\thelper = store\n[core]\n\tsshCommand = ssh -o BatchMode=yes\n[http]\n\tproxy = http://proxy.example:3128\n',
    )
    expect(await readRoad(clone.git, { local: false })).toMatchObject({ kind: 'github' })
  })

  it('keeps the harmless two-part keys set locally', async () => {
    const clone = await cloneWith(GITHUB)
    await git(clone.repo, 'config', 'http.postBuffer', '524288000')
    await git(clone.repo, 'config', 'push.autoSetupRemote', 'true')
    await git(clone.repo, 'config', 'gpg.format', 'ssh')
    expect(await readRoad(clone.git, { local: false })).toMatchObject({ kind: 'github' })
  })

  it('does not judge the configuration off the GitHub road: nothing is pushed there', async () => {
    const clone = await cloneWith('git@gitlab.example.com:acme/iac.git')
    await git(clone.repo, 'config', 'credential.helper', 'canary')
    expect(await readRoad(clone.git, { local: false })).toEqual({ kind: 'local', why: 'other-host', host: 'gitlab.example.com' })
  })
})
