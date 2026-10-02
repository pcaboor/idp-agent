import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openGitHubForge } from '../../src/forge/github/forge.js'
import type { GitHubApi } from '../../src/forge/github/api.js'
import { openGitHub } from '../../src/forge/github/open.js'
import { openLocalForge } from '../../src/forge/local/forge.js'
import type { ForgeProvider, GhIdentity, GitHubRoad } from '../../src/forge/provider.js'
import type { GhProcess } from '../../src/process/gh.js'
import { gitIn, type Git, type Push } from '../../src/process/git.js'
import type { FakePull } from '../../tools/fake-gh.js'
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

/**
 * `files` committed on the clone's `main` and pushed to GitHub's: the base
 * moves on both sides, level — a declaration the repository already held
 * before the run began.
 */
export async function onMain(clone: GitHubClone, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(clone.repo, file)), { recursive: true })
    await writeFile(path.join(clone.repo, file), text, 'utf8')
  }
  await git(clone.repo, 'add', '-A')
  await git(clone.repo, 'commit', '-q', '-m', 'declared before the run')
  await git(clone.repo, 'push', '-q', clone.bare, 'main:refs/heads/main')
}

/**
 * A grant that names `component:default/billing-api`, as the demo SI declares
 * one: a file of the same entities as any change that names billing-api.
 */
export const BILLING_GRANT_PATH = 'dependencies/access/billing-api-cache-dev.yml'
export const BILLING_GRANT = [
  '---',
  'apiVersion: backstage.io/v1alpha1',
  'kind: Resource',
  'metadata:',
  '  name: billing-api-cache-dev',
  '  annotations:',
  '    company.fr/env: dev',
  'spec:',
  '  type: database-access',
  '  access: readwrite',
  '  owner: group:default/tiger',
  '  dependsOn:',
  '    - resource:default/billing-cache-dev',
  '  dependencyOf:',
  '    - component:default/billing-api',
  '',
].join('\n')

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
 * Another account's pull request, in flight (stage 6 plan, Task 6.3.6): its
 * branch pushed to the bare repository by plumbing — one commit on GitHub's
 * `main` holding `edits` — as another person's run would push it, and the
 * pull request the fake records as theirs, open into `main`. `branch` is an
 * idp-agent name of its own unless a test names one (this change's own, for
 * another person's run of the very same change); `fork` makes it a fork's
 * branch, as `head.repo.full_name` answers it; `files` seeds the list GitHub
 * would answer instead of computing it. Returns the pull request's number.
 */
export async function pullRequestBy(
  clone: GitHubClone,
  options: {
    readonly login: string
    readonly edits: Readonly<Record<string, string>>
    readonly branch?: string
    readonly fork?: string
    readonly title?: string
    readonly files?: FakePull['files']
  },
): Promise<number> {
  const digest = createHash('sha256').update(JSON.stringify([options.login, options.edits, options.fork ?? ''])).digest('hex')
  const slug = options.login.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'someone'
  const branch = options.branch ?? `idp-agent/by-${slug}-${digest.slice(0, 8)}`
  const index = path.join(await mkdtemp(path.join(path.dirname(clone.bare), 'index-')), 'index')
  const inBare = (args: readonly string[], input?: string): string =>
    execFileSync('git', ['--git-dir', clone.bare, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_INDEX_FILE: index },
      ...(input === undefined ? {} : { input }),
    }).trim()
  inBare(['read-tree', 'refs/heads/main'])
  for (const [file, text] of Object.entries(options.edits)) {
    const blob = inBare(['hash-object', '-w', '--stdin'], text)
    inBare(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`])
  }
  const tree = inBare(['write-tree'])
  const commit = inBare([
    '-c',
    `user.name=${options.login}`,
    '-c',
    `user.email=${slug}@idp-agent.invalid`,
    'commit-tree',
    tree,
    '-p',
    'refs/heads/main',
    '-m',
    `${options.login}'s change`,
  ])
  inBare(['update-ref', `refs/heads/${branch}`, commit])
  await rm(path.dirname(index), { recursive: true, force: true })
  const pulls = (clone.gh.state.pulls ??= [])
  const number = Math.max(0, ...pulls.map((one) => one.number)) + 1
  const [held] = clone.gh.state.repositories
  pulls.push({
    number,
    owner: held?.owner ?? 'acme',
    name: held?.name ?? 'iac',
    title: options.title ?? `${options.login}'s change`,
    body: '',
    head: branch,
    base: 'main',
    draft: false,
    maintainer_can_modify: false,
    author: options.login,
    state: 'open',
    merged_at: null,
    closed_at: null,
    lastPusher: options.login,
    reviews: [],
    headSha: commit,
    ...(options.fork === undefined ? {} : { headRepository: options.fork }),
    ...(options.files === undefined ? {} : { files: options.files }),
  })
  return number
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
    login: side.identity.login,
    git,
    ...(options.push === undefined ? {} : { push: options.push }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { forge, road: side.road, identity: side.identity, api: side.api }
}
