import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { hashWorktree } from './tree.js'

const run = promisify(execFile)

/**
 * Test-side git, isolated from the developer's configuration so a test means
 * the same thing on every machine. The launcher under test deliberately is NOT
 * isolated this way — it scrubs GIT_* and reads the user's own config, where
 * their identity lives — which is why every repository here sets its identity
 * locally.
 */
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], { env: ENV, encoding: 'utf8' })
  return stdout.trim()
}

/**
 * A file's bytes at a revision, untrimmed. `git()` trims, which is right for a
 * ref and wrong for a file: "the branch holds exactly the bytes of the diff" is
 * a byte-for-byte claim, trailing newline included.
 */
export async function show(repo: string, revision: string, file: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, 'show', `${revision}:${file}`], {
    env: ENV,
    encoding: 'utf8',
  })
  return stdout
}

/** A directory made into a repository on `main`, holding every file it had. Returns HEAD. */
export async function committed(repo: string): Promise<string> {
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.name', 'idp-agent tests')
  await git(repo, 'config', 'user.email', 'tests@idp-agent.invalid')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
  return git(repo, 'rev-parse', 'HEAD')
}

/**
 * Everything a person can observe of a repository without reading its object
 * store: every ref, what HEAD is, the index's bytes, and the working tree.
 * §9.2's "initial state intact" is this string being equal — and deliberately
 * not `.git/objects`, where an aborted write leaves an unreachable blob.
 */
export async function observable(repo: string): Promise<string> {
  const index = await readFile(path.join(repo, '.git', 'index')).catch(() => Buffer.alloc(0))
  return [
    await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    await git(repo, 'symbolic-ref', '-q', 'HEAD').catch(() => 'detached'),
    await git(repo, 'rev-parse', 'HEAD'),
    createHash('sha256').update(index).digest('hex'),
    await hashWorktree(repo),
  ].join('\n')
}
