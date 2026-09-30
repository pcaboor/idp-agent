import { execFile } from 'node:child_process'
import path from 'node:path'
import { spawnedEnvironment } from './environment.js'
import { SUBMISSION_REF, isBranch, isHex } from './grammar.js'
import { LauncherRefusal } from './refusal.js'

export { SUBMISSION_REF } from './grammar.js'

/**
 * One of the two modules in `src/` that start a process (`gh.ts` is the
 * other), and an architecture test holds that. The Inspector's `git ls-files`,
 * everything the local forge (`forge/local/`) does to a repository, and the
 * one push form of stage 6 (brief § 4) go through here — `gitIn` for every
 * read and write, `pushIn` for the push — so every line below applies to every
 * call or to none.
 *
 * Each call runs only a vector the allow-list admits: `checkGitArgv` holds the
 * FINISHED vector, the one `execFile` is handed, to an explicit list of shapes
 * (brief § 6) before anything starts, and a vector outside it throws
 * `LauncherRefusal`. The check is on the final vector, not on a request, so a
 * caller's bug cannot pass a shape the grammar does not know.
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
 *     for either, and what it runs no right to them (ADR-0011). The push alone
 *     keeps four, the person's way of reaching GitHub (`PUSH_VARIABLES`).
 *   - `cwd` is Node's own directory, the repository named by `-C` and an
 *     absolute path: Windows looks a program up in the working directory
 *     first, so a `git.exe` at a repository's root ran as soon as the
 *     repository was inspected; a relative PATH entry does the same anywhere.
 *   - a timeout and an output cap — past either, nothing is read rather than
 *     something partial.
 *   - `execFile`, no shell — no argument is ever interpreted.
 *
 * What this does NOT do: sandbox git. It reads the user's global
 * configuration (their identity lives there, and their way of pushing), and
 * `/dev/null` is not a directory name on Windows, which CI does not run.
 */

export interface GitLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

/** A listing is about 60 bytes a file: this reads a repository of half a million. */
export const GIT_LIMITS: GitLimits = { timeoutMs: 15_000, maxOutputBytes: 32 * 1024 * 1024 }

/**
 * A push may wait on the person: ssh asks for a key's passphrase on the
 * terminal, as for their own push (brief § 5, § 15). Its answer is a few
 * porcelain lines.
 */
export const PUSH_LIMITS: GitLimits = { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 }

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

/**
 * What the push pins beyond `HARDENING` (brief § 4), each outranking every
 * configuration file: no transport that runs a command line, none that
 * reaches this machine (a push to GitHub never needs it, and git starts a
 * local `git-receive-pack` without these pins, so the target's hooks would
 * run), no redirect carrying the push to a renamed repository's new home, no
 * tags, no submodules, no signature (`push.gpgSign` would run `gpg.program`).
 */
export const PUSH_PINS: readonly string[] = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'http.followRedirects=false',
  '-c',
  'push.followTags=false',
  '-c',
  'push.recurseSubmodules=no',
  '-c',
  'push.gpgSign=false',
]

/** The push's flags, in order: one machine-readable line per ref, no `pre-push` hook, and the pins again as flags. */
export const PUSH_FLAGS: readonly string[] = [
  '--porcelain',
  '--no-verify',
  '--no-follow-tags',
  '--no-recurse-submodules',
  '--no-signed',
]

/**
 * The four `GIT_*` variables the push keeps (brief § 5): the person's way of
 * reaching GitHub, set in their shell — the environment counterparts of
 * `core.sshCommand` and `core.askPass` in their global configuration. Every
 * other call drops them with every other `GIT_*`.
 */
export const PUSH_VARIABLES: readonly string[] = ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_ASKPASS']

/**
 * The five GitHub remote URL forms (brief § 13), the only destinations a push
 * names: HTTPS, the scp-like and `ssh://` SSH forms, SSH over the HTTPS port,
 * and the `org-<id>@` form of an organisation's SSH certificate authority. An
 * owner of letters, digits and hyphens up to 39, not starting with a hyphen; a
 * repository of letters, digits, `.`, `_` and `-` up to 100, never `.` or
 * `..`, and `.git` after it or not. No userinfo but the SSH forms' own user,
 * no port but 443 on `ssh.github.com`, nothing after the repository. The
 * engine's copy is `core/github/remote.ts`'s `parseRemoteUrl`, held to the
 * same verdict by `tests/unit/grammar-agreement.test.ts`, which found that a
 * name of 97 to 100 characters written with `.git` was refused here.
 */
export const GITHUB_PUSH_URL =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|ssh:\/\/git@ssh\.github\.com:443\/|org-[0-9]{1,20}@github\.com:)[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?(?:\.git)?$)(?:(?![A-Za-z0-9._-]*\.git$)[A-Za-z0-9._-]{1,100}|[A-Za-z0-9._-]{1,100}\.git)$/

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

// ---------------------------------------------------------------- the grammar

/** A token of a shape: a literal, or a predicate over one argument. */
type Token = string | ((word: string) => boolean)

const isSubmissionRef = (word: string): boolean => SUBMISSION_REF.test(word)

/**
 * A remote's name, read from a hostile configuration (brief § 13): letters,
 * digits, `.`, `_`, `-` and `/`, 1 to 100, not starting with `-` or `.`.
 * Always placed after `--` as well, so it can never be read as an option.
 */
const isRemoteName = (word: string): boolean => /^(?![-.])[A-Za-z0-9._/-]{1,100}$/.test(word)

/** `<prefix><middle><suffix>`, the middle held to `middle`. */
const framed =
  (prefix: string, middle: (word: string) => boolean, suffix: string) =>
  (word: string): boolean =>
    word.length > prefix.length + suffix.length &&
    word.startsWith(prefix) &&
    word.endsWith(suffix) &&
    middle(word.slice(prefix.length, word.length - suffix.length))

const isHeadOrSubmission = (word: string): boolean => word === 'HEAD' || isSubmissionRef(word)

/**
 * Every vector `gitIn` may run after `-C <repository>`, one entry per
 * alternative: stage 5's shapes exactly as the forge and the Inspector build
 * them, and what stage 6 adds (brief § 6). Nothing here writes but rows 10 to
 * 12 — objects, and one ref created where none exists (ADR-0010).
 */
const SHAPES: readonly (readonly Token[])[] = [
  // 1. `openLocalForge`, `project-fs`.
  ['rev-parse', '--is-inside-work-tree'],
  ['rev-parse', '--show-prefix'],
  ['rev-parse', '--show-object-format'],
  ['rev-parse', '--show-toplevel'],
  // 2. `base()`, `existing()`.
  ['rev-parse', '--verify', '--quiet', framed('', isHeadOrSubmission, '^{commit}')],
  // 3. `submit()`.
  ['rev-parse', framed('', isHex, '^{tree}')],
  // 4. `openLocalForge`.
  ['var', 'GIT_AUTHOR_IDENT'],
  ['var', 'GIT_COMMITTER_IDENT'],
  // 5. `base()`, `existing()`.
  ['symbolic-ref', '--quiet', isHeadOrSubmission],
  // 6 to 8. `existing()`.
  ['rev-list', '--parents', '-n', '1', isHex],
  ['diff-tree', '-r', '-z', '--name-only', '--no-renames', isHex, isHex],
  ['cat-file', 'commit', isHex],
  // 9. `submit()`; the remote's name and the base are read by stage 6.
  ['check-ref-format', isSubmissionRef],
  ['check-ref-format', framed('refs/remotes/', isRemoteName, '/HEAD')],
  ['check-ref-format', '--branch', isBranch],
  // 10 to 12. `submit()`, `writeTree`: objects, then the one ref, created
  // only where none exists (the empty old value).
  ['hash-object', '-w', '--stdin', '--no-filters'],
  ['mktree', '-z'],
  ['commit-tree', isHex, '-p', isHex, '-F', '-'],
  ['update-ref', '--no-deref', '-m', 'idp-agent: submitted for review', isSubmissionRef, isHex, ''],
  // 13, 14. `treeOf`, `writeTree`; `project-fs`.
  ['ls-tree', '-r', '-z', '--full-tree', isHex],
  ['ls-tree', '-z', isHex],
  ['ls-files', '-z', '--cached'],
  // 15, 16. The clone's own configuration and the remote its branch tracks,
  // read and never written; the remote's name after `--`.
  ['config', '--list', '--show-scope', '-z'],
  ['config', '--get', framed('branch.', isBranch, '.remote')],
  ['config', '--get', framed('branch.', isBranch, '.merge')],
  ['remote', 'get-url', '--all', '--', isRemoteName],
  ['remote', 'get-url', '--push', '--all', '--', isRemoteName],
  // 17. The older base of § 14.
  ['merge-base', '--is-ancestor', isHex, isHex],
]

const matches = (args: readonly string[], shape: readonly Token[]): boolean =>
  args.length === shape.length &&
  shape.every((token, at) => (typeof token === 'string' ? args[at] === token : token(args[at] ?? '')))

/** `args` begins with every element of `prefix`, in order. */
const startsWith = (args: readonly string[], prefix: readonly string[]): boolean =>
  prefix.every((element, at) => args[at] === element)

/** A repository named by `-C`: absolute, so it cannot be read as an option. */
const isRepository = (word: string): boolean => path.isAbsolute(word) && !word.startsWith('-')

/**
 * The command word a refusal names: the argument after `-C <repository>`, or
 * `(none)`. Only a word shaped like one of git's commands is named; anything
 * else may be a repository's content, and is not quoted.
 */
const commandWord = (argv: readonly string[]): string => {
  const at = argv.indexOf('-C')
  const word = at === -1 ? undefined : argv[at + 2]
  if (word === undefined) return '(none)'
  return /^[a-z][a-z-]{0,31}$/.test(word) ? word : '(unnamed)'
}

/** The one push form (brief § 4), after `-C <repository>`: a create-only lease, a GitHub URL, one refspec. */
const isPush = (args: readonly string[]): boolean => {
  if (args.length !== 1 + PUSH_FLAGS.length + 3) return false
  if (args[0] !== 'push' || !startsWith(args.slice(1), PUSH_FLAGS)) return false
  const [lease = '', url = '', refspec = ''] = args.slice(1 + PUSH_FLAGS.length)
  const leased = /^--force-with-lease=(.*):$/.exec(lease)?.[1]
  const colon = refspec.indexOf(':')
  const commit = refspec.slice(0, colon)
  const ref = refspec.slice(colon + 1)
  return (
    leased !== undefined &&
    isSubmissionRef(leased) &&
    GITHUB_PUSH_URL.test(url) &&
    colon !== -1 &&
    isHex(commit) &&
    ref === leased
  )
}

/**
 * Holds the FULL vector `execFile` receives to the grammar: `HARDENING`
 * element for element, then either `PUSH_PINS`, `-C` and a repository and the
 * one push form, or `-C` and a repository and one of `SHAPES`. Anything else
 * throws `LauncherRefusal` naming the command word, and nothing starts.
 */
export function checkGitArgv(argv: readonly string[]): void {
  const refuse = (): never => {
    throw new LauncherRefusal('git', commandWord(argv))
  }
  if (!startsWith(argv, HARDENING)) refuse()
  let rest = argv.slice(HARDENING.length)
  const pinned = startsWith(rest, PUSH_PINS)
  if (pinned) rest = rest.slice(PUSH_PINS.length)
  if (rest[0] !== '-C' || !isRepository(rest[1] ?? '')) refuse()
  const args = rest.slice(2)
  if (pinned ? !isPush(args) : !SHAPES.some((shape) => matches(args, shape))) refuse()
}

// ---------------------------------------------------------------- environments

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

/**
 * The push's environment: `gitEnvironment`'s, except that it keeps the four
 * `PUSH_VARIABLES`, whatever their case (brief § 5). The person's ssh-agent,
 * HOME, proxy and credential variables pass as they pass every call: the
 * table names what is removed, not what may pass.
 */
export function pushEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(spawnedEnvironment(env))) {
    const upper = name.toUpperCase()
    if (!upper.startsWith('GIT_') || PUSH_VARIABLES.includes(upper)) kept[name] = value
  }
  return { ...kept, LC_ALL: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
}

// ---------------------------------------------------------------- the launchers

/** git, bound to one repository: `repo` is absolute, so it cannot be read as an option. */
export function gitIn(
  repo: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly limits?: GitLimits } = {},
): Git {
  const limits = options.limits ?? GIT_LIMITS
  return (args, input) =>
    new Promise((resolve, reject) => {
      const argv = [...HARDENING, '-C', repo, ...args]
      // Before anything starts: a refusal rejects, and no process exists.
      checkGitArgv(argv)
      const child = execFile(
        'git',
        argv,
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

/** What one push is asked to do: send `commit`, exactly, to `branch` under `refs/heads/`, at `url`. */
export interface PushRequest {
  /** The URL `git remote get-url --push` printed, one of `GITHUB_PUSH_URL`'s forms: never a remote's name. */
  readonly url: string
  /** The commit the local forge cut, 40 or 64 hex. */
  readonly commit: string
  /** The bare branch, `idp-agent/<slug>-<8 hex>`. */
  readonly branch: string
}

/** What the porcelain line of the pushed ref says: `*` a new ref, `=` up to date, `!` rejected. */
export type PushFlag = 'created' | 'up-to-date' | 'rejected'

export interface PushOutcome {
  readonly flag: PushFlag
  /**
   * The line's summary, as git wrote it: `[new branch]`, `[up to date]`,
   * `[rejected] (stale info)` when the lease found the ref, or a remote's
   * refusal such as `[remote rejected] (push declined due to repository rule
   * violations)` — on stdout with `--porcelain`, so a caller tells a lease
   * from a ruleset by the outcome, never by printed text.
   */
  readonly summary: string
}

export type Push = (request: PushRequest) => Promise<PushOutcome>

const FLAGS: readonly PushFlag[] = ['created', 'up-to-date', 'rejected']

/** The porcelain character of each flag this push can meet. */
const characterOf = (flag: PushFlag): string => {
  switch (flag) {
    case 'created':
      return '*'
    case 'up-to-date':
      return '='
    case 'rejected':
      return '!'
    default: {
      const _exhaustive: never = flag
      return _exhaustive
    }
  }
}

/**
 * The outcome for `ref`, read from the one porcelain line that names it as
 * its destination (`<flag>\t<from>:<to>\t<summary>`), line ends `\n` or
 * `\r\n`. A fast-forward, a forced update or a deletion is nothing this push
 * does, and no line for `ref` says nothing reached the remote: each is a
 * `GitError`.
 */
export function parsePorcelain(stdout: Buffer, ref: string): PushOutcome {
  for (const line of stdout.toString('utf8').split('\n')) {
    const fields = /^(.)\t([^\t]*)\t(.*?)\r?$/.exec(line)
    if (fields === null) continue
    const [, character = '', spec = '', summary = ''] = fields
    if (spec.slice(spec.indexOf(':') + 1) !== ref) continue
    const flag = FLAGS.find((candidate) => characterOf(candidate) === character)
    if (flag === undefined) break
    return { flag, summary }
  }
  throw new GitError(['push'], undefined, '', false)
}

/**
 * The one push (brief § 4), bound to one repository: `HARDENING`, then
 * `PUSH_PINS`, then `-C` and the repository, `push`, `PUSH_FLAGS`, a lease
 * whose expected value is empty — the ref must not exist on the remote, the
 * create-only write — the URL, and one refspec from the commit to the lease's
 * ref. It resolves the porcelain line's outcome whatever git's exit code (git
 * exits 1 on a `!` line), and rejects a `GitError` only when no line names the
 * ref: nothing reached the remote — authentication, the host key, the network
 * — or the call was stopped at a bound.
 */
export function pushIn(
  repo: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly limits?: GitLimits } = {},
): Push {
  const limits = options.limits ?? PUSH_LIMITS
  return (request) =>
    new Promise((resolve, reject) => {
      const ref = `refs/heads/${request.branch}`
      const argv = [
        ...HARDENING,
        ...PUSH_PINS,
        '-C',
        repo,
        'push',
        ...PUSH_FLAGS,
        `--force-with-lease=${ref}:`,
        request.url,
        `${request.commit}:${ref}`,
      ]
      checkGitArgv(argv)
      const child = execFile(
        'git',
        argv,
        {
          cwd: NEUTRAL_DIRECTORY,
          env: pushEnvironment(options.env),
          encoding: 'buffer',
          timeout: limits.timeoutMs,
          maxBuffer: limits.maxOutputBytes,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const failed = (): GitError =>
            new GitError(['push'], error?.code ?? undefined, stderr.toString('utf8'), error?.killed === true)
          // Past a bound, nothing is read rather than something partial.
          if (error !== null && (error.killed === true || typeof error.code === 'string')) {
            reject(failed())
            return
          }
          try {
            resolve(parsePorcelain(stdout, ref))
          } catch {
            reject(failed())
          }
        },
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end()
    })
}
