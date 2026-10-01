import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openGitHubForge } from '../../src/forge/github/forge.js'
import type { GitHubApi } from '../../src/forge/github/api.js'
import { openGitHub } from '../../src/forge/github/open.js'
import { openLocalForge } from '../../src/forge/local/forge.js'
import type { ForgeProvider, GhIdentity, GitHubRoad } from '../../src/forge/provider.js'
import type { GhProcess } from '../../src/process/gh.js'
import { gitIn, type Git, type Push } from '../../src/process/git.js'
import { fakeGitHub, protectedMain, type FakeGitHub, type FakeModel } from './fake-gh.js'
import { clone, scratch } from './forge-fixture.js'
import { committed, git } from './git.js'

/**
 * A clone of `github.com/acme/iac` whose GitHub is on this machine (stage 6
 * brief § 10): a committed declarations repository whose `main` tracks
 * `git@github.com:acme/iac.git`, level with a bare repository beside it that
 * stands for GitHub's side; a fake ssh, named by `GIT_SSH_COMMAND` in the
 * environment the forge is handed, that serves that bare repository whatever
 * host it is asked for; and the fake gh, logged in as `ada`, reading its refs
 * and commits from the same bare repository. The push is the person's real
 * `git push`, the real lease, over the real ssh transport; nothing leaves the
 * machine. Everything is made under one directory of `scratch`, so stage 5's
 * `removeClones` removes it, and removing the clone's parent removes it all.
 */

export const GITHUB_URL = 'git@github.com:acme/iac.git'

export interface GitHubClone {
  /** The clone, at the root of a git working tree. */
  readonly repo: string
  /** GitHub's side of it. */
  readonly bare: string
  /** What the forge is handed: a scratch `HOME`, the fake ssh, and `GIT_SSH_VARIANT=simple`. */
  readonly env: NodeJS.ProcessEnv
  readonly gh: FakeGitHub
}

/**
 * A fake ssh: a `sh` script that ignores the host and runs `git receive-pack`
 * (or `upload-pack`) on `bare`, or prints ssh's own refusal and exits 255 as
 * ssh does. With `GIT_SSH_VARIANT=simple` git hands it the host and the one
 * command, and never probes it with `-G`.
 */
export async function fakeSsh(dir: string, bare: string, refuse?: 'publickey' | 'host-key'): Promise<string> {
  const file = path.join(dir, refuse === undefined ? 'ssh' : `ssh-${refuse}`)
  const body =
    refuse === 'publickey'
      ? 'echo "git@github.com: Permission denied (publickey)." >&2\nexit 255\n'
      : refuse === 'host-key'
        ? 'echo "Host key verification failed." >&2\nexit 255\n'
        : [
            'for last; do :; done',
            'case "$last" in',
            `  git-receive-pack*) exec git receive-pack '${bare}' ;;`,
            `  git-upload-pack*) exec git upload-pack '${bare}' ;;`,
            '  *) echo "fake ssh: not a git command" >&2; exit 255 ;;',
            'esac',
            '',
          ].join('\n')
  await writeFile(file, `#!/bin/sh\n${body}`)
  await chmod(file, 0o755)
  return file
}

/** Every ref of the bare repository and the commit it names: what "nothing was written on GitHub" compares. */
export async function remoteRefs(bare: string): Promise<string> {
  return git(bare, 'for-each-ref', '--format=%(refname) %(objectname)')
}

/**
 * The floor's sixth leg (tests/setup/forge.ts, tests/unit/offline.test.ts),
 * for every clone a test pushes from: `origin`'s push URL, read as the
 * launcher's git will read it — every GIT_* removed, so the system file too —
 * must be the one the fake ssh serves. A configuration that rewrites it
 * would send the push, and the machine's credential helper, to the real
 * GitHub. Synchronous, so a test that counts the processes it starts through
 * a mocked `execFile` (`tests/contract/key-reach.test.ts`) counts none here.
 */
export function requireUnrewritten(repo: string, env: NodeJS.ProcessEnv, url: string = GITHUB_URL): void {
  const launcherLike: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith('GIT_')) launcherLike[name] = value
  }
  const stdout = execFileSync('git', ['-C', repo, 'remote', 'get-url', '--push', 'origin'], {
    env: launcherLike,
    encoding: 'utf8',
  })
  if (stdout.trim() !== url) {
    throw new Error(
      `this machine's git configuration rewrites ${url} (git config --system --list says where): ` +
        'a push test would reach somewhere else, and does not run',
    )
  }
}

/**
 * The clone, the bare repository level with it, the fake ssh, and the fake gh
 * over `protectedMain` — `main` protected as `docs/submitting.md` says, `ada`
 * its administrator and logged in — with `model`'s changes.
 *
 * `source`, a directory whose files are the first commit on `main` (stage 5's
 * `clone()`, `init platform`'s scaffold, when absent); `repository`,
 * `'<owner>/<name>'` (`acme/iac` when absent), which names both the remote's
 * URL and the repository the fake models; `login`, a person gh is logged in
 * as instead of `ada`, the repository's administrator as she is — for a test
 * that searches a prompt or a trace for the login, where `ada` is in every
 * `metadata` and the search would find it there.
 */
export async function githubClone(
  options: {
    readonly model?: FakeModel
    readonly source?: string
    readonly repository?: string
    readonly login?: string
  } = {},
): Promise<GitHubClone> {
  const [owner = 'acme', name = 'iac'] = (options.repository ?? 'acme/iac').split('/')
  const url = `git@github.com:${owner}/${name}.git`
  const repo = options.source === undefined ? await clone() : await copied(options.source)
  const root = path.dirname(repo)
  const bare = path.join(root, 'github.git')
  const home = path.join(root, 'home')
  await mkdir(home)
  await git(root, 'init', '-q', '--bare', bare)
  await git(repo, 'push', '-q', bare, 'main:refs/heads/main')
  await git(repo, 'remote', 'add', 'origin', url)
  await git(repo, 'config', 'branch.main.remote', 'origin')
  await git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_SSH_COMMAND: await fakeSsh(root, bare),
    GIT_SSH_VARIANT: 'simple',
  }
  requireUnrewritten(repo, env, url)
  const gh = fakeGitHub({ repositories: [protectedMain({ bare, owner, name })], ...options.model })
  const { login } = options
  if (login !== undefined) {
    gh.state.accounts = [...gh.state.accounts, { login, type: 'User' }]
    gh.state.repositories = gh.state.repositories.map((one) => ({
      ...one,
      permissions: { ...one.permissions, [login]: { admin: true, maintain: false, push: true } },
    }))
    gh.as(login)
  }
  return { repo, bare, env, gh }
}

/** `source`'s files, committed on `main` in a clone of their own under `scratch`. */
const copied = async (source: string): Promise<string> => {
  const repo = path.join(await scratch('idp-forge-'), 'iac')
  await cp(source, repo, { recursive: true })
  await committed(repo)
  return repo
}

/** Every ruleset gone from the fake's model: a base nothing protects, from the next gh call on. */
export function unprotect(gh: FakeGitHub): void {
  gh.state.repositories = gh.state.repositories.map((one) => ({ ...one, rulesets: [] }))
}

/**
 * One commit on GitHub's `main` that the clone does not hold — somebody
 * merged — made with the test's own git in the bare repository: `main`'s
 * tree, `main` its parent, then `update-ref`.
 */
export async function moveGitHubBase(clone: GitHubClone): Promise<void> {
  const ahead = await git(
    clone.bare,
    '-c',
    'user.name=somebody else',
    '-c',
    'user.email=somebody@idp-agent.invalid',
    'commit-tree',
    'main^{tree}',
    '-p',
    'main',
    '-m',
    'somebody merged',
  )
  await git(clone.bare, 'update-ref', 'refs/heads/main', ahead)
}

/**
 * What `openSubmissionForge` opens for a submission, piece by piece: `openGitHub` for
 * the road and gh's identity, the local forge with `acceptOlderBase`, then
 * the GitHub forge, the road `from`. `git`, `push` and `gh` are the fixture's
 * unless a test hands failing ones.
 */
export async function githubForge(
  clone: GitHubClone,
  options: {
    readonly git?: Git
    readonly push?: Push
    readonly gh?: GhProcess
    readonly wait?: (ms: number) => Promise<void>
    readonly now?: () => number
  } = {},
): Promise<{ forge: ForgeProvider; road: GitHubRoad; identity: GhIdentity; api: GitHubApi }> {
  const git = options.git ?? gitIn(clone.repo, { env: clone.env })
  const side = await openGitHub({ repo: clone.repo, env: clone.env, gh: options.gh ?? clone.gh.process, local: false, git })
  if (side.road.kind !== 'github' || side.identity === undefined || side.api === undefined) {
    throw new Error(`the fixture's clone is on the ${side.road.kind} road`)
  }
  const local = await openLocalForge(clone.repo, 'declarations', git, { acceptOlderBase: true })
  const forge = openGitHubForge({
    repo: clone.repo,
    local,
    road: side.road,
    api: side.api,
    env: clone.env,
    route: 'from',
    git,
    ...(options.push === undefined ? {} : { push: options.push }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { forge, road: side.road, identity: side.identity, api: side.api }
}
