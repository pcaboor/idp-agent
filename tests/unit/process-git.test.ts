import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  GIT_LIMITS,
  GitError,
  HARDENING,
  PUSH_FLAGS,
  PUSH_LIMITS,
  PUSH_PINS,
  PUSH_VARIABLES,
  SUBMISSION_REF,
  checkGitArgv,
  gitEnvironment,
  gitIn,
  parsePorcelain,
  pushEnvironment,
  pushIn,
  type PushRequest,
} from '../../src/process/git.js'
import { LauncherRefusal } from '../../src/process/refusal.js'
import { GIT_DOORS } from '../support/fake-gh.js'
import { fakeSsh } from '../support/github-fixture.js'
import { committed, git } from '../support/git.js'
import { onPath, removeStubs, stubGit } from '../support/stub-gh.js'

/**
 * The launcher every git command `src/` runs goes through: the Inspector's
 * `git ls-files`, the forge's plumbing (ADR-0010), and from stage 6 the one
 * push form (stage 6 brief § 4). Each case of "the one process" is a hardening
 * line of `process/git.ts`, run against a real repository with the line's
 * reason planted in it — a hook, an fsmonitor, a `git` at the root, a key in
 * the environment — through a vector the allow-list admits, and each was seen
 * failing without its line. What git is handed is read by a stub `git` first
 * on PATH, which records its vector, its environment and its directory.
 *
 * NO REAL KEY IS WRITTEN HERE: the canaries were never issued by anyone. And
 * no push leaves this machine: every push goes to `git@github.com:` through a
 * fake ssh named by GIT_SSH_COMMAND, which serves a bare repository in the run
 * directory (`tests/setup/forge.ts` holds the rest of the floor).
 */

const made: string[] = []

const temp = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  made.push(directory)
  return directory
}

afterAll(async () => {
  await Promise.all(made.map((directory) => rm(directory, { recursive: true, force: true })))
})

afterEach(removeStubs)

const repository = async (): Promise<string> => {
  const repo = await temp('idp-git-')
  await committed(repo)
  return repo
}

/** A shell script that leaves a mark where it ran, for "did git run this?". */
const marking = async (file: string, marker: string): Promise<void> => {
  await writeFile(file, `#!/bin/sh\ntouch '${marker}'\n`, 'utf8')
  await chmod(file, 0o755)
}

const HEAD_COMMIT = ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']
const PROBE_REF = 'refs/heads/idp-agent/probe-0123abcd'
const text = (bytes: Buffer): string => bytes.toString('utf8').trim()

describe('the one process', () => {
  it('cannot be redirected to another repository by an inherited GIT_DIR', async () => {
    // Measured: `GIT_DIR=<other>/.git git -C <repo>` answers for <other>. The
    // other repository holds one more commit, so the two answers differ.
    const repo = await repository()
    const other = await repository()
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'one more')
    const run = gitIn(repo, { env: { ...process.env, GIT_DIR: path.join(other, '.git') } })
    const answered = text(await run(HEAD_COMMIT))
    expect(answered).toBe(await git(repo, 'rev-parse', 'HEAD'))
    expect(answered).not.toBe(await git(other, 'rev-parse', 'HEAD'))
  })

  it("does not run the repository's hooks", async () => {
    // Measured: a reference-transaction hook runs inside `update-ref`.
    const repo = await repository()
    const marker = path.join(await temp('idp-hook-'), 'ran')
    await marking(path.join(repo, '.git', 'hooks', 'reference-transaction'), marker)
    const head = await git(repo, 'rev-parse', 'HEAD')

    await gitIn(repo)(['update-ref', '--no-deref', '-m', 'idp-agent: submitted for review', PROBE_REF, head, ''])

    expect(await git(repo, 'rev-parse', PROBE_REF)).toBe(head)
    await expect(stat(marker)).rejects.toThrow()
  })

  it("does not run the fsmonitor the repository's configuration names", async () => {
    // `core.fsmonitor` is a command line, and `ls-files` runs it: a
    // repository's `.git/config` is whatever its author left in it.
    const repo = await repository()
    const marker = path.join(await temp('idp-fsmonitor-'), 'ran')
    await git(repo, 'config', 'core.fsmonitor', `touch '${marker}'; echo`)

    await gitIn(repo)(['ls-files', '-z', '--cached'])

    await expect(stat(marker)).rejects.toThrow()
  })

  it('never runs a git planted in the repository', async () => {
    // Windows looks a program up in the working directory first, and a
    // relative PATH entry does it anywhere: git is started from Node's own
    // directory and reaches the repository by -C. The test stands in the
    // repository, as `plan "<intent>"` does when the Inspector reads the
    // directory the user is in: a launcher that set no `cwd` would start git
    // there, and only standing there tells that apart from a `cwd` that is
    // right.
    const repo = await repository()
    const marker = path.join(await temp('idp-planted-'), 'ran')
    await marking(path.join(repo, 'git'), marker)
    const env = { ...process.env, PATH: `.${path.delimiter}${process.env['PATH'] ?? ''}` }

    const before = process.cwd()
    process.chdir(repo)
    try {
      await gitIn(repo, { env })(HEAD_COMMIT)
    } finally {
      process.chdir(before)
    }

    await expect(stat(marker)).rejects.toThrow()
  })

  it('hands git, and whatever git runs, no provider key, no catalogue variable and no identity', async () => {
    // ADR-0011 and SECURITY.md: no child process is handed either. Read from
    // the child's side: a stub `git` first on PATH records the environment it
    // was started with — what git would run its own children in — and the
    // directory it was started from.
    const repo = await repository()
    const stub = await stubGit({ stdout: 'true\n' })
    const env = onPath(stub.bin, {
      ...process.env,
      OPENAI_API_KEY: 'canary-provider-key-for-git',
      IDP_BACKSTAGE_TOKEN: 'canary-backstage-token-for-git',
      IDP_BACKSTAGE_URL: 'canary-backstage-url-for-git',
      GIT_AUTHOR_NAME: 'canary-author',
      GIT_COMMITTER_EMAIL: 'canary-committer@idp-agent.invalid',
    })
    await gitIn(repo, { env })(['rev-parse', '--is-inside-work-tree'])

    const [call] = await stub.calls()
    expect(call?.names).toContain('PATH')
    expect(call?.env['PATH']).toBe(env['PATH'])
    expect(call?.names.filter((name) => /^(OPENAI_API_KEY|IDP_BACKSTAGE_\w+|GIT_AUTHOR_\w+|GIT_COMMITTER_\w+)$/.test(name))).toEqual([])
    expect(realpathSync(call?.cwd ?? '')).toBe(realpathSync(path.dirname(process.execPath)))
    expect(call?.argv).toEqual([...HARDENING, '-C', repo, 'rev-parse', '--is-inside-work-tree'])
  })

  it('never lets git guess who is committing', async () => {
    // Measured (git 2.46): with no user.name/user.email in any configuration,
    // `git var GIT_COMMITTER_IDENT` printed `<login> <<login>@<host>.localdomain>`,
    // exit 0 — the identity `commit-tree` would have signed a branch with.
    // With user.useConfigOnly it refuses, exit 128 (D13). The system file
    // cannot be switched off here: GIT_CONFIG_NOSYSTEM is a GIT_* variable and
    // the launcher scrubs it. An identity written there in full is a
    // configured one, not a guess, so on such a machine the probe is expected
    // to succeed; half of one still refuses, for the half that is missing.
    // Asserted by git's own reason: any other failure of `git var` is not
    // this refusal. `EMAIL` was measured not to get around it.
    expect(HARDENING).toContain('user.useConfigOnly=true')
    const repo = await repository()
    await git(repo, 'config', '--unset', 'user.name')
    await git(repo, 'config', '--unset', 'user.email')
    const home = await temp('idp-home-')
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, EMAIL: 'canary-email@idp-agent.invalid' }
    // Read as the launcher reads it: the suite sets GIT_CONFIG_NOSYSTEM for
    // its own git, and the launcher removes every GIT_*.
    const launcherLike: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.toUpperCase().startsWith('GIT_')) launcherLike[name] = value
    }
    const system = (key: string): Promise<boolean> =>
      promisify(execFile)('git', ['config', '--system', '--get', key], { env: launcherLike }).then(
        () => true,
        () => false,
      )
    const configured = (await system('user.name')) && (await system('user.email'))

    const probe = gitIn(repo, { env })(['var', 'GIT_COMMITTER_IDENT'])

    if (configured) {
      await expect(probe).resolves.toBeDefined()
      return
    }
    const error = await probe.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe(128)
    expect((error as GitError).stderr).toMatch(/auto-detection is disabled/)
  })

  it('hands stdin over byte for byte, carriage returns included', async () => {
    // A blob's id is a hash of its exact bytes, computed here the way git
    // computes it. A runner that re-encoded, trimmed or line-ended its input
    // would produce a different id.
    const repo = await repository()
    const bytes = Buffer.from('a\r\nb\n', 'utf8')
    const expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const oid = text(await gitIn(repo)(['hash-object', '-w', '--stdin', '--no-filters'], bytes))
    expect(oid).toBe(expected)
  })

  it('says git is missing rather than failing somewhere else', async () => {
    const repo = await repository()
    const error = await gitIn(repo, { env: { PATH: '' } })(['rev-parse', '--is-inside-work-tree']).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('ENOENT')
  })

  it('stops a call past its output bound, and reads nothing of it', async () => {
    // The answer is a commit's id and a line end, 41 bytes, against 8.
    const repo = await repository()
    const error = await gitIn(repo, { limits: { timeoutMs: GIT_LIMITS.timeoutMs, maxOutputBytes: 8 } })(
      HEAD_COMMIT,
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect((error as GitError).timedOut).toBe(false)
  })

  it('stops a call past its time bound, and says so', async () => {
    const repo = await repository()
    const stub = await stubGit({ sleepMs: 2000 })
    const error = await gitIn(repo, {
      env: onPath(stub.bin),
      limits: { timeoutMs: 100, maxOutputBytes: GIT_LIMITS.maxOutputBytes },
    })(['rev-parse', '--is-inside-work-tree']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).timedOut).toBe(true)
    expect((error as GitError).message).toBe('git rev-parse failed: timed out')
  })

  it('bounds every call it is not told how to bound', () => {
    // A listing is about 60 bytes a file: half a million files, or 15 seconds.
    expect(GIT_LIMITS).toEqual({ timeoutMs: 15_000, maxOutputBytes: 32 * 1024 * 1024 })
    // A push may wait for a key's passphrase, typed at ssh's own prompt (§ 15).
    expect(PUSH_LIMITS).toEqual({ timeoutMs: 120_000, maxOutputBytes: 64 * 1024 })
  })

  it("keeps git's own words out of the message, where a repository's content can reach them", async () => {
    const repo = await repository()
    const error = await gitIn(repo)([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/idp-agent/none-0123abcd^{commit}',
    ]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe('git rev-parse failed')
    expect((error as GitError).code).toBe(1)
  })
})

describe('gitEnvironment', () => {
  it('is spawnedEnvironment minus every GIT_ variable, in the C locale, never prompting', () => {
    const env = gitEnvironment({
      PATH: '/bin',
      HOME: '/h',
      OPENAI_API_KEY: 'k',
      IDP_BACKSTAGE_TOKEN: 't',
      GIT_DIR: '/elsewhere/.git',
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp/hooks'",
      Git_Work_Tree: '/elsewhere',
      GIT_SSH_COMMAND: 'ssh -i canary',
      GITHUB_TOKEN: 'g',
    })
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GITHUB_TOKEN: 'g',
      LC_ALL: 'C',
      LANGUAGE: 'C',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    })
  })
})

// ---------------------------------------------------------------- the allow-list

const REPO = '/work/iac'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHA256 = '0123456789abcdef'.repeat(4)
const SUB = 'refs/heads/idp-agent/orders-api-to-payments-e9e6183f'
const full = (...args: string[]): string[] => [...HARDENING, '-C', REPO, ...args]

/** Every vector stage 5 builds, and the reads stage 6 adds (§ 6), one sample each. */
const ADMITTED: readonly (readonly string[])[] = [
  ['rev-parse', '--is-inside-work-tree'],
  ['rev-parse', '--show-prefix'],
  ['rev-parse', '--show-object-format'],
  ['rev-parse', '--show-toplevel'],
  ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
  ['rev-parse', '--verify', '--quiet', `${SUB}^{commit}`],
  ['rev-parse', `${SHA}^{tree}`],
  ['rev-parse', `${SHA256}^{tree}`],
  ['var', 'GIT_AUTHOR_IDENT'],
  ['var', 'GIT_COMMITTER_IDENT'],
  ['symbolic-ref', '--quiet', 'HEAD'],
  ['symbolic-ref', '--quiet', SUB],
  ['rev-list', '--parents', '-n', '1', SHA],
  ['diff-tree', '-r', '-z', '--name-only', '--no-renames', SHA, SHA256],
  ['cat-file', 'commit', SHA],
  ['check-ref-format', SUB],
  ['check-ref-format', 'refs/remotes/origin/HEAD'],
  ['check-ref-format', 'refs/remotes/team/upstream/HEAD'],
  ['check-ref-format', '--branch', 'main'],
  ['check-ref-format', '--branch', 'release/1'],
  ['hash-object', '-w', '--stdin', '--no-filters'],
  ['mktree', '-z'],
  ['commit-tree', SHA, '-p', SHA, '-F', '-'],
  ['update-ref', '--no-deref', '-m', 'idp-agent: submitted for review', SUB, SHA, ''],
  ['ls-tree', '-r', '-z', '--full-tree', SHA],
  ['ls-tree', '-z', SHA],
  ['ls-files', '-z', '--cached'],
  ['config', '--list', '--show-scope', '-z'],
  ['config', '--get', 'branch.main.remote'],
  ['config', '--get', 'branch.release/1.merge'],
  ['remote', 'get-url', '--all', '--', 'origin'],
  ['remote', 'get-url', '--push', '--all', '--', 'origin'],
  ['merge-base', '--is-ancestor', SHA, SHA],
]

/** Branch names git may accept and the grammar does not: each could carry something past a check. */
const REFUSED_BRANCHES = [
  '-main',
  '.hidden',
  'a..b',
  'a//b',
  'a/.b',
  'a@{1}',
  'x.lock',
  'x/',
  'x.',
  'a b',
  'a~1',
  'a^',
  'a:b',
  'a?',
  'a*',
  'a[b',
  'a\\b',
  'a{b}',
  'a%2Fb',
  'main\u202e',
  'main\u2066',
  'a\u200bb',
  'a\u0007b',
  '',
  'x'.repeat(256),
]

describe('the allow-list', () => {
  it('admits every vector stage 5 builds, and nothing else', () => {
    for (const args of ADMITTED) expect(() => checkGitArgv(full(...args)), args.join(' ')).not.toThrow()
    for (const door of GIT_DOORS) expect(() => checkGitArgv(door.argv), door.name).toThrow(LauncherRefusal)
    for (const branch of REFUSED_BRANCHES) {
      expect(() => checkGitArgv(full('check-ref-format', '--branch', branch)), JSON.stringify(branch)).toThrow(
        LauncherRefusal,
      )
      expect(() => checkGitArgv(full('config', '--get', `branch.${branch}.merge`)), JSON.stringify(branch)).toThrow(
        LauncherRefusal,
      )
    }
    // The submission's own names: `branchFor` writes `[a-z0-9]` runs joined by
    // `-`, then `-` and eight hex.
    expect(SUBMISSION_REF.test(SUB)).toBe(true)
    for (const ref of ['refs/heads/main', 'refs/heads/idp-agent/X-0123abcd', 'refs/heads/idp-agent/x-0123abc', 'refs/tags/idp-agent/x-0123abcd']) {
      expect(SUBMISSION_REF.test(ref), ref).toBe(false)
    }
  })

  it('refuses before git starts, and names the command word alone', async () => {
    const repo = await repository()
    const stub = await stubGit()
    const run = gitIn(repo, { env: onPath(stub.bin) })

    const refused = await run(['fetch']).catch((caught: unknown) => caught)
    expect(refused).toBeInstanceOf(LauncherRefusal)
    expect((refused as Error).message).toBe('git fetch is not a command idp-agent runs')
    const hostile = await run(['rev-parse', '--verify', '--quiet', 'refs/heads/main\u202e^{commit}']).catch(
      (caught: unknown) => caught,
    )
    expect((hostile as Error).message).toBe('git rev-parse is not a command idp-agent runs')

    expect(await stub.calls()).toEqual([])
  })

  it("reads a remote's name only after --", () => {
    expect(() => checkGitArgv(full('remote', 'get-url', '--all', '--', 'origin'))).not.toThrow()
    // § 10's named case: a remote called `--push`, whose
    // `refs/remotes/--push/HEAD` git's check-ref-format accepts (measured).
    for (const args of [
      ['remote', 'get-url', '--all', 'origin'],
      ['remote', 'get-url', '--all', '--', '--push'],
      ['remote', 'get-url', '--push', '--all', '--', '-x'],
      ['remote', 'get-url', '--all', '--', '.origin'],
      ['check-ref-format', 'refs/remotes/--push/HEAD'],
    ]) {
      expect(() => checkGitArgv(full(...args)), args.join(' ')).toThrow(LauncherRefusal)
    }
  })
})

// ---------------------------------------------------------------- the push

const BRANCH = 'idp-agent/x-0123abcd'
const REF = `refs/heads/${BRANCH}`
/** The push fixture's URL: an ssh form, so GIT_SSH_COMMAND decides where it goes. */
const URL = 'git@github.com:acme/iac.git'

describe('the push', () => {
  it('pushes the one form, and only it', async () => {
    const repo = await repository()
    const stub = await stubGit({ stdout: `To ${URL}\n*\t${SHA}:${REF}\t[new branch]\nDone\n` })
    const push = pushIn(repo, { env: onPath(stub.bin) })

    expect(await push({ url: URL, commit: SHA, branch: BRANCH })).toEqual({ flag: 'created', summary: '[new branch]' })
    const [call] = await stub.calls()
    expect(call?.argv).toEqual([
      ...HARDENING,
      ...PUSH_PINS,
      '-C',
      repo,
      'push',
      ...PUSH_FLAGS,
      `--force-with-lease=${REF}:`,
      URL,
      `${SHA}:${REF}`,
    ])

    const hostile: PushRequest[] = [
      { url: 'git@evil.example:acme/iac.git', commit: SHA, branch: BRANCH },
      { url: 'https://x:y@github.com/acme/iac.git', commit: SHA, branch: BRANCH },
      { url: '-uhttps://github.com/acme/iac', commit: SHA, branch: BRANCH },
      { url: URL, commit: SHA, branch: 'main' },
      { url: URL, commit: SHA, branch: 'idp-agent/X' },
      { url: URL, commit: SHA.slice(0, 7), branch: BRANCH },
    ]
    for (const request of hostile) {
      await expect(push(request), JSON.stringify(request)).rejects.toBeInstanceOf(LauncherRefusal)
    }
    expect(await stub.calls()).toHaveLength(1)
  })

  it('admits the five GitHub URL forms, and no other', async () => {
    const push = pushIn(await repository(), { env: onPath((await stubGit()).bin) })
    const vector = (url: string): string[] => [
      ...HARDENING,
      ...PUSH_PINS,
      '-C',
      REPO,
      'push',
      ...PUSH_FLAGS,
      `--force-with-lease=${REF}:`,
      url,
      `${SHA}:${REF}`,
    ]
    for (const url of [
      'https://github.com/acme/iac',
      'https://github.com/acme/iac.git',
      'git@github.com:acme/iac.git',
      'ssh://git@github.com/acme/iac.git',
      'ssh://git@ssh.github.com:443/acme/iac.git',
      'org-123456@github.com:acme/iac.git',
    ]) {
      expect(() => checkGitArgv(vector(url)), url).not.toThrow()
    }
    for (const url of [
      'http://github.com/acme/iac',
      'https://github.com.evil.example/acme/iac',
      'https://github.com/acme',
      'https://github.com/acme/iac/extra',
      'https://github.com/acme/..',
      'https://github.com/-acme/iac',
      'git@github.com:acme/iac.git ',
      'ssh://git@ssh.github.com:22/acme/iac.git',
      'org-x@github.com:acme/iac.git',
      '/srv/git/iac.git',
      'file:///srv/git/iac.git',
      'ext::sh -c touch% /tmp/x',
    ]) {
      expect(() => checkGitArgv(vector(url)), url).toThrow(LauncherRefusal)
    }
    await expect(push({ url: 'origin', commit: SHA, branch: BRANCH })).rejects.toBeInstanceOf(LauncherRefusal)
  })

  it('hands the push its four variables, and every call none', async () => {
    const handed = {
      PATH: '/bin',
      HOME: '/h',
      OPENAI_API_KEY: 'k',
      IDP_BACKSTAGE_TOKEN: 't',
      IDP_BACKSTAGE_CACHE: 'c',
      GIT_DIR: '/elsewhere/.git',
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp/hooks'",
      GIT_SSH_COMMAND: 'ssh -i canary',
      GIT_SSH: '/usr/bin/canary-ssh',
      git_ssh_variant: 'ssh',
      GIT_ASKPASS: '/usr/bin/canary-askpass',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GITHUB_TOKEN: 'g',
    }
    expect(PUSH_VARIABLES).toEqual(['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_ASKPASS'])
    expect(pushEnvironment(handed)).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GIT_SSH_COMMAND: 'ssh -i canary',
      GIT_SSH: '/usr/bin/canary-ssh',
      git_ssh_variant: 'ssh',
      GIT_ASKPASS: '/usr/bin/canary-askpass',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GITHUB_TOKEN: 'g',
      LC_ALL: 'C',
      LANGUAGE: 'C',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    })
    for (const name of PUSH_VARIABLES) expect(gitEnvironment(handed), name).not.toHaveProperty(name)

    // Through the child: the push is handed them, every other call is not.
    const repo = await repository()
    const values = ['GIT_SSH_COMMAND', 'LC_ALL', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT']
    const stub = await stubGit({ values, stdout: `*\t${SHA}:${REF}\t[new branch]\n` })
    const env = onPath(stub.bin, { ...process.env, ...handed, PATH: process.env['PATH'] })
    await pushIn(repo, { env })({ url: URL, commit: SHA, branch: BRANCH })
    await gitIn(repo, { env })(['rev-parse', '--is-inside-work-tree'])
    const [pushed, read] = await stub.calls()
    const reaching = (names: readonly string[] = []): string[] =>
      names.filter((name) => /^(GIT_|OPENAI_|IDP_BACKSTAGE_)/i.test(name) || name === 'GITHUB_TOKEN').sort()
    expect(reaching(pushed?.names)).toEqual([
      'GITHUB_TOKEN',
      'GIT_ASKPASS',
      'GIT_OPTIONAL_LOCKS',
      'GIT_SSH',
      'GIT_SSH_COMMAND',
      'GIT_TERMINAL_PROMPT',
      'git_ssh_variant',
    ])
    expect(pushed?.env).toEqual({
      GIT_SSH_COMMAND: 'ssh -i canary',
      LC_ALL: 'C',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(reaching(read?.names)).toEqual(['GITHUB_TOKEN', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'])
  })

  it('really pushes, create-only, and says what happened', async () => {
    // Why a real push in a change that opens no road: the grammar pins a
    // vector nothing calls yet, and only git can say it is one git runs.
    const repo = await repository()
    const bare = await temp('idp-bare-')
    await git(bare, 'init', '-q', '--bare')
    // Ignores the host and serves the bare repository: nothing leaves this machine.
    const ssh = await fakeSsh(await temp('idp-fake-ssh-'), bare)
    const marker = path.join(await temp('idp-pre-push-'), 'ran')
    await marking(path.join(repo, '.git', 'hooks', 'pre-push'), marker)
    // The push fixture's half of the floor: an ssh form, so the variable
    // below decides where the push goes, whatever a configuration says.
    expect(URL.startsWith('git@github.com:')).toBe(true)
    // Unless a configuration rewrites the URL itself, or names another ssh:
    // read as the launcher's git reads it, every GIT_* removed, so the system
    // file too, and by key alone. Checked here as well as in offline.test.ts,
    // which does not stop this file in the same run. A configuration read,
    // which talks to no remote.
    const launcherLike: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.toUpperCase().startsWith('GIT_')) launcherLike[name] = value
    }
    const redirects = await promisify(execFile)(
      'git',
      ['config', '--includes', '--name-only', '--get-regexp', '^(core\\.sshcommand|url\\..*\\.(push)?insteadof)$'],
      { env: launcherLike, cwd: repo, encoding: 'utf8' },
    ).then(
      ({ stdout }) => stdout.split('\n').filter((line) => line !== ''),
      (error: { code?: unknown; stdout?: unknown }) => (error.code === 1 ? [] : [`git config failed: ${String(error.code)}`]),
    )
    expect(redirects, 'a git configuration could carry this push elsewhere').toEqual([])
    const push = pushIn(repo, { env: { ...process.env, GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: 'ssh' } })
    const head = await git(repo, 'rev-parse', 'HEAD')

    expect(await push({ url: URL, commit: head, branch: BRANCH })).toEqual({ flag: 'created', summary: '[new branch]' })
    expect(await git(bare, 'rev-parse', REF)).toBe(head)

    // The same commit again: measured on git 2.46, the ref is up to date, and
    // git reports so before it weighs the lease.
    expect(await push({ url: URL, commit: head, branch: BRANCH })).toEqual({ flag: 'up-to-date', summary: '[up to date]' })

    // Another commit to the same name: the lease says the ref must not exist.
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'another')
    const other = await git(repo, 'rev-parse', 'HEAD')
    expect(await push({ url: URL, commit: other, branch: BRANCH })).toEqual({
      flag: 'rejected',
      summary: '[rejected] (stale info)',
    })
    expect(await git(bare, 'rev-parse', REF)).toBe(head)
    await expect(stat(marker)).rejects.toThrow()
  })

  it('never pushes to this machine, whatever a remote section named after the URL says', async () => {
    // git looks the push's URL up as a remote's name first (measured, git
    // 2.46), and a push over the file transport starts git-receive-pack
    // without the command line's pins, so the target's pre-receive hook would
    // run. readRoad refuses such a section; this pin is the floor under it.
    const repo = await repository()
    const bare = await temp('idp-planted-')
    await git(bare, 'init', '-q', '--bare')
    const marker = path.join(await temp('idp-pre-receive-'), 'ran')
    await marking(path.join(bare, 'hooks', 'pre-receive'), marker)
    await git(repo, 'config', `remote.${URL}.url`, bare)
    const push = pushIn(repo)
    const head = await git(repo, 'rev-parse', 'HEAD')

    await expect(push({ url: URL, commit: head, branch: BRANCH })).rejects.toBeInstanceOf(GitError)
    await expect(stat(marker)).rejects.toThrow()
    await expect(git(bare, 'rev-parse', '--verify', '--quiet', REF)).rejects.toThrow()
  })

  it('reads the porcelain line of its ref, and no other', () => {
    const line = (flag: string, ref: string, summary: string): string => `${flag}\t${SHA}:${ref}\t${summary}`
    const other = 'refs/heads/idp-agent/y-0123abcd'
    const porcelain = (...lines: string[]): Buffer => Buffer.from(`To ${URL}\n${lines.join('\n')}\nDone\n`)
    expect(parsePorcelain(porcelain(line('*', REF, '[new branch]')), REF)).toEqual({ flag: 'created', summary: '[new branch]' })
    expect(parsePorcelain(porcelain(line('=', REF, '[up to date]')), REF)).toEqual({ flag: 'up-to-date', summary: '[up to date]' })
    expect(
      parsePorcelain(
        porcelain(line('!', other, '[new branch]'), line('!', REF, '[remote rejected] (push declined due to repository rule violations)')),
        REF,
      ),
    ).toEqual({ flag: 'rejected', summary: '[remote rejected] (push declined due to repository rule violations)' })
    expect(
      parsePorcelain(Buffer.from(`To ${URL}\r\n${line('*', other, '[new branch]')}\r\n${line('!', REF, '[rejected] (stale info)')}\r\nDone\r\n`), REF),
    ).toEqual({ flag: 'rejected', summary: '[rejected] (stale info)' })
    // A fast-forward, a forced update and a deletion are nothing this push
    // does; a line for another ref alone, or none, says nothing of ours.
    for (const stdout of [
      porcelain(line(' ', REF, `${SHA.slice(0, 7)}..${SHA.slice(0, 7)}`)),
      porcelain(line('+', REF, '[forced update]')),
      porcelain(`-\t:${REF}\t[deleted]`),
      porcelain(line('*', other, '[new branch]')),
      Buffer.from(''),
    ]) {
      expect(() => parsePorcelain(stdout, REF)).toThrow(GitError)
    }
  })

  // What the GitHub road would read as "pushed" if these gave way: nothing is
  // known, and a GitError says so (§ 15).
  it("rejects a push no line names, and keeps git's words out of the message", async () => {
    // Authentication, the host key, the network: git exits 128 before any
    // porcelain line, and what it says can hold a server's words.
    const canary = 'Permission denied (publickey) canary-stderr-of-the-push'
    const stub = await stubGit({ exit: 128, stderr: `${canary}\n` })
    const error = await pushIn(await repository(), { env: onPath(stub.bin) })({ url: URL, commit: SHA, branch: BRANCH }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe('git push failed')
    expect((error as GitError).message).not.toContain('canary')
    expect((error as GitError).code).toBe(128)
    expect((error as GitError).timedOut).toBe(false)
  })

  it('reads nothing of a push stopped at its output bound, a created line included', async () => {
    // The line that would say "created" arrives first; the rest runs past the
    // cap, and a partial answer is no answer.
    const stub = await stubGit({ stdout: `*\t${SHA}:${REF}\t[new branch]\n${'x'.repeat(200)}\n` })
    const error = await pushIn(await repository(), {
      env: onPath(stub.bin),
      limits: { timeoutMs: PUSH_LIMITS.timeoutMs, maxOutputBytes: 100 },
    })({ url: URL, commit: SHA, branch: BRANCH }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  })

  it('stops a push past its time bound, and says so', async () => {
    const stub = await stubGit({ sleepMs: 2000, stdout: `*\t${SHA}:${REF}\t[new branch]\n` })
    const error = await pushIn(await repository(), {
      env: onPath(stub.bin),
      limits: { timeoutMs: 200, maxOutputBytes: PUSH_LIMITS.maxOutputBytes },
    })({ url: URL, commit: SHA, branch: BRANCH }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).timedOut).toBe(true)
    expect((error as GitError).message).toBe('git push failed: timed out')
  })
})
