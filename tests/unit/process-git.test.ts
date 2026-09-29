import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { GIT_LIMITS, GitError, HARDENING, gitEnvironment, gitIn } from '../../src/process/git.js'
import { committed, git } from '../support/git.js'

/**
 * The one launcher every process `src/` starts goes through: the Inspector's
 * `git ls-files` today, the forge's plumbing next (ADR-0010). Each case below
 * is a hardening line of `process/git.ts`, run against a real repository with
 * the line's reason planted in it — a hook, an fsmonitor, a `git` at the root,
 * a key in the environment — and each was seen failing without its line.
 *
 * NO REAL KEY IS WRITTEN HERE: the canaries were never issued by anyone.
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

describe('the one process', () => {
  it('cannot be redirected to another repository by an inherited GIT_DIR', async () => {
    // Measured: `GIT_DIR=<other>/.git git -C <repo>` answers for <other>.
    const repo = await repository()
    const other = await repository()
    const run = gitIn(repo, { env: { ...process.env, GIT_DIR: path.join(other, '.git') } })
    const answered = (await run(['rev-parse', '--absolute-git-dir'])).toString('utf8').trim()
    expect(answered).toBe(await git(repo, 'rev-parse', '--absolute-git-dir'))
  })

  it("does not run the repository's hooks", async () => {
    // Measured: a reference-transaction hook runs inside `update-ref`.
    const repo = await repository()
    const marker = path.join(await temp('idp-hook-'), 'ran')
    await marking(path.join(repo, '.git', 'hooks', 'reference-transaction'), marker)

    await gitIn(repo)(['update-ref', 'refs/heads/idp-agent/probe', 'HEAD', ''])

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
      await gitIn(repo, { env })(['rev-parse', 'HEAD'])
    } finally {
      process.chdir(before)
    }

    await expect(stat(marker)).rejects.toThrow()
  })

  it('hands git, and whatever git runs, no provider key, no catalogue variable and no identity', async () => {
    // ADR-0011 and SECURITY.md: no child process is handed either. Hooks are
    // off, so an alias that runs a shell is what prints the environment git
    // hands the programs it starts.
    const repo = await repository()
    await git(repo, 'config', 'alias.env', '!env')
    const env = {
      ...process.env,
      OPENAI_API_KEY: 'canary-provider-key-for-git',
      IDP_BACKSTAGE_TOKEN: 'canary-backstage-token-for-git',
      IDP_BACKSTAGE_URL: 'canary-backstage-url-for-git',
      GIT_AUTHOR_NAME: 'canary-author',
      GIT_COMMITTER_EMAIL: 'canary-committer@idp-agent.invalid',
    }
    const printed = (await gitIn(repo, { env })(['env'])).toString('utf8')
    expect(printed).toMatch(/^PATH=/m)
    expect(printed).not.toContain('canary-')
    expect(printed).not.toMatch(/^(OPENAI_API_KEY|IDP_BACKSTAGE_\w+|GIT_AUTHOR_\w+|GIT_COMMITTER_\w+)=/m)
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
    const system = (key: string): Promise<boolean> =>
      promisify(execFile)('git', ['config', '--system', '--get', key]).then(
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
    const oid = (await gitIn(repo)(['hash-object', '--stdin', '--no-filters'], bytes)).toString('utf8').trim()
    expect(oid).toBe(expected)
  })

  it('says git is missing rather than failing somewhere else', async () => {
    const repo = await repository()
    const error = await gitIn(repo, { env: { PATH: '' } })(['--version']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('ENOENT')
  })

  it('stops a call past its output bound, and reads nothing of it', async () => {
    const repo = await repository()
    const error = await gitIn(repo, { limits: { timeoutMs: GIT_LIMITS.timeoutMs, maxOutputBytes: 8 } })([
      'log',
      '--format=%H%H%H',
    ]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect((error as GitError).timedOut).toBe(false)
  })

  it('stops a call past its time bound, and says so', async () => {
    const repo = await repository()
    await git(repo, 'config', 'alias.slow', '!sleep 2')
    const error = await gitIn(repo, { limits: { timeoutMs: 100, maxOutputBytes: GIT_LIMITS.maxOutputBytes } })([
      'slow',
    ]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).timedOut).toBe(true)
    expect((error as GitError).message).toBe('git slow failed: timed out')
  })

  it('bounds every call it is not told how to bound', () => {
    // A listing is about 60 bytes a file: half a million files, or 15 seconds.
    expect(GIT_LIMITS).toEqual({ timeoutMs: 15_000, maxOutputBytes: 32 * 1024 * 1024 })
  })

  it("keeps git's own words out of the message, where a repository's content can reach them", async () => {
    const repo = await repository()
    const error = await gitIn(repo)(['rev-parse', '--verify', 'refs/heads/no-such-branch']).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe('git rev-parse failed')
    expect((error as GitError).code).toBe(128)
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
