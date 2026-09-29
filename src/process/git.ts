import { execFile } from 'node:child_process'
import path from 'node:path'
import { spawnedEnvironment } from './environment.js'

/**
 * The only module in `src/` that starts a process, and an architecture test
 * holds that. The Inspector's `git ls-files` and everything the local forge
 * (`forge/local/`) does to a repository go through `gitIn` — no command reaches
 * the forge until `--submit` — so every line below applies to every call or to
 * none.
 *
 * What was measured, and what each line answers:
 *
 *   - `-c core.hooksPath=/dev/null` — a `reference-transaction` hook in the
 *     user's repository RAN inside `update-ref`. A repository's hooks are its
 *     owner's code, and this tool does not run it.
 *   - `-c core.fsmonitor=false`, `-c core.untrackedCache=false` — a configured
 *     fsmonitor is a command line git runs, and `ls-files` runs it; a
 *     repository's `.git/config` is whatever its author left in it. A
 *     command-line `-c` outranks every configuration file.
 *   - `-c user.useConfigOnly=true` — with no `user.name`/`user.email`
 *     configured, git GUESSED an identity from the login and host names and
 *     `git var GIT_COMMITTER_IDENT` exited 0, so `commit-tree` would have
 *     signed a branch with it. With this, both refuse (exit 128): an identity
 *     is configured or there is none (D13).
 *   - `spawnedEnvironment()` minus every `GIT_*` — an inherited `GIT_DIR` sent
 *     `git -C <repo>` to another repository entirely, and a pre-commit hook
 *     sets `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` all three;
 *     `GIT_CONFIG_PARAMETERS` would undo the overrides above;
 *     `GIT_AUTHOR_*`/`GIT_COMMITTER_*` are a caller's choice of identity
 *     (D13). And no provider key and no catalogue variable: git has no use
 *     for either, and what it runs no right to them (ADR-0011).
 *   - `cwd` is Node's own directory, the repository named by `-C` and an
 *     absolute path: Windows looks a program up in the working directory
 *     first, so a `git.exe` at a repository's root ran as soon as the
 *     repository was inspected; a relative PATH entry does the same anywhere.
 *   - a timeout and an output cap — past either, nothing is read rather than
 *     something partial.
 *   - `execFile`, no shell — no argument is ever interpreted.
 *
 * What this does NOT do: sandbox git. It reads the user's global
 * configuration (their identity lives there), and `/dev/null` is not a
 * directory name on Windows, which CI does not run.
 */

export interface GitLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

/** A listing is about 60 bytes a file: this reads a repository of half a million. */
export const GIT_LIMITS: GitLimits = { timeoutMs: 15_000, maxOutputBytes: 32 * 1024 * 1024 }

/** Configuration no repository gets to choose, on every call. */
export const HARDENING: readonly string[] = [
  '--no-pager',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'user.useConfigOnly=true',
]

/** Where git is started from: the directory of the running Node binary, never a repository. */
const NEUTRAL_DIRECTORY = path.dirname(process.execPath)

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    /** The exit code, or Node's code for a git that never ran (`ENOENT`) or said too much. */
    readonly code: string | number | undefined,
    /** git's own words: a repository's content can reach them, so `cli/` prints them through `inertLine`. */
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(`git ${args[0] ?? ''} failed${timedOut ? ': timed out' : ''}`)
    this.name = 'GitError'
  }
}

/** One git invocation: arguments, optional stdin, stdout as bytes. */
export type Git = (args: readonly string[], input?: Buffer) => Promise<Buffer>

/**
 * The environment every git call runs in: a spawned one, from `env` when a
 * caller hands one (a test does) and the process's otherwise, minus every
 * `GIT_` variable whatever its case. The C locale makes a message read the
 * same on every machine; optional locks off means a read never writes the
 * index; no terminal prompt means git refuses rather than waits.
 */
export function gitEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(spawnedEnvironment(env))) {
    if (!name.toUpperCase().startsWith('GIT_')) kept[name] = value
  }
  return { ...kept, LC_ALL: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
}

/** git, bound to one repository: `repo` is absolute, so it cannot be read as an option. */
export function gitIn(
  repo: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly limits?: GitLimits } = {},
): Git {
  const limits = options.limits ?? GIT_LIMITS
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...HARDENING, '-C', repo, ...args],
        {
          cwd: NEUTRAL_DIRECTORY,
          env: gitEnvironment(options.env),
          encoding: 'buffer',
          timeout: limits.timeoutMs,
          maxBuffer: limits.maxOutputBytes,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            // `killed` is Node's word for the timeout; an output past its cap
            // is reported by its own code instead.
            reject(new GitError(args, error.code ?? undefined, stderr.toString('utf8'), error.killed === true))
            return
          }
          resolve(stdout)
        },
      )
      // A git that failed to start, or exited before reading, closes its end
      // of the pipe; the write then fails with EPIPE on the stream. The
      // failure that matters is already reported by the callback above, and
      // an unhandled stream error would crash the CLI instead of refusing.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
}
