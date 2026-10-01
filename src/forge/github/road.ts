import { configRefusal, parseConfigListing, refusedConfigKeys } from '../../core/github/config.js'
import {
  baseOfMerge,
  isBranch,
  isRemoteName,
  parseRemoteUrl,
  printedRepository,
  sameRepository,
  type GitHubRepository,
  type RemoteUrl,
} from '../../core/github/remote.js'
import { GitError, type Git } from '../../process/git.js'
import { ForgeInputError } from '../errors.js'
import type { Road } from '../provider.js'

/**
 * The road a submission takes, decided once and before anything is read on
 * GitHub (stage 6 brief § 13, § 7): the branch HEAD names, the remote it
 * tracks and the branch on it, both URLs the person's own git prints —
 * `insteadOf` and `pushInsteadOf` expanded, so a rewrite is seen as where it
 * leads — and, on the GitHub road only, the clone's own configuration.
 *
 * Everything here comes from a clone's configuration, which § 7 treats as
 * hostile, so every value is held to its grammar before it reaches a process
 * or a sentence: a value outside one is refused and not quoted. What a
 * sentence names — a branch, a remote's name, a repository — has passed its
 * grammar, and `cli/` still prints it through `inertLine`; the one exception is
 * a branch that tracks nothing, whose name no process is handed and which the
 * local road's line prints inert, as stage 5 printed it. Every refusal is
 * the user's to fix, exit 2 (`ForgeInputError`), and nothing was written: this
 * only reads.
 *
 * The configuration is judged on the GitHub road only, after the URLs: on the
 * other roads nothing is pushed, and a GitLab clone with a local
 * `credential.helper` is not refused for a push that will not happen. So a
 * local `url.*.insteadOf` sending github.com elsewhere lands on the
 * other-host road — nothing pushed, the safe direction — and a local
 * `pushInsteadOf` sending only the push elsewhere is a fork set-up, refused.
 */

const NOTHING = 'Nothing was written.'

/** How a branch is given an upstream that is a named remote. */
const SET_UPSTREAM =
  '; idpa pushes to a named remote. Set its upstream to one (git branch --set-upstream-to <remote>/<branch>), ' +
  `then run this again. ${NOTHING}`

/** Who reads the road: a submission, or `idpa protection`, which takes no `--local`. */
type Purpose = 'submission' | 'protection'

/** The user's to fix: exit 2. */
function refuse(message: string): never {
  throw new ForgeInputError(message)
}

/** git's answer, the line end it adds taken off. */
const line = (bytes: Buffer): string => bytes.toString('utf8').replace(/\r?\n$/, '')

/**
 * A git call that answers yes by exit 0 and no by one of `no`'s codes;
 * anything else is not an answer. `check-ref-format <ref>` says no with 1,
 * and `check-ref-format --branch` with `die()`, 128 (measured, git 2.46).
 */
const answers = async (git: Git, args: readonly string[], no: readonly number[] = [1]): Promise<boolean> => {
  try {
    await git(args)
    return true
  } catch (error) {
    if (error instanceof GitError && typeof error.code === 'number' && no.includes(error.code)) return false
    throw error
  }
}

/** `git config --get <key>`, or undefined when the key is not set (git's exit 1). */
const configValue = async (git: Git, key: string): Promise<string | undefined> => {
  try {
    return line(await git(['config', '--get', key]))
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return undefined
    throw error
  }
}

/** The branch HEAD names, as git holds it: its grammar is judged by `readRoad`. */
const checkedOut = async (git: Git): Promise<string> => {
  let head: string
  try {
    head = line(await git(['symbolic-ref', '--quiet', 'HEAD']))
  } catch (error) {
    if (error instanceof GitError && error.code === 1) {
      return refuse('HEAD is detached; check out the branch this request is for')
    }
    throw error
  }
  if (!head.startsWith('refs/heads/')) return refuse('HEAD is detached; check out the branch this request is for')
  return head.slice('refs/heads/'.length)
}

/**
 * A checked-out branch outside the grammar a base and a submission's branch
 * are held to, which tracks a branch: refused, its name unquoted when it is
 * not otherwise clean. `idpa protection` takes no `--local`, so its sentence
 * leaves that offer out.
 */
const refuseBranch = (branch: string, purpose: Purpose): never => {
  const local = purpose === 'submission' ? ', or add --local to cut the branch in this clone only' : ''
  const remedy = `; rename it (git branch -m <name>)${local}. ${NOTHING}`
  // git takes '%' in a branch name; GitHub's paths read it as an escape. Such
  // a name is otherwise clean, and naming it is how the person finds it.
  if (isBranch(branch.replaceAll('%', '_'))) {
    return refuse(`${branch} is a branch name this build does not read ('%' is read as an escape in GitHub's paths)${remedy}`)
  }
  return refuse(`the checked-out branch has a name this build does not read (no '{', '}', '%' or invisible character)${remedy}`)
}

/**
 * Whether a branch outside the grammar tracks one: both keys set, in any
 * scope. Read from the keys git lists, never their values, because the
 * launcher reads no key named after such a branch (`process/git.ts`).
 */
const tracksAnything = async (git: Git, branch: string): Promise<boolean> => {
  const keys = new Set(parseConfigListing(await git(['config', '--list', '--show-scope', '-z'])).map((entry) => entry.key))
  return keys.has(`branch.${branch}.remote`) && keys.has(`branch.${branch}.merge`)
}

/** `branch.<branch>.remote` names a remote this build reads, or the run stops here. */
const holdRemote = async (git: Git, branch: string, remote: string): Promise<void> => {
  if (remote === '.') refuse(`${branch} tracks this clone itself (branch.${branch}.remote is .)${SET_UPSTREAM}`)
  // A remote's name holds no ':'; a path begins with '/', './' or '../'.
  if (/:|^\.{0,2}\//.test(remote)) refuse(`branch.${branch}.remote is a URL, not a remote's name${SET_UPSTREAM}`)
  if (!isRemoteName(remote) || !(await answers(git, ['check-ref-format', `refs/remotes/${remote}/HEAD`]))) {
    refuse(
      `branch.${branch}.remote names a remote this build does not read (a name is 1 to 100 letters, digits, ` +
        `'.', '_', '-' and '/', not beginning with '-' or '.'). ${NOTHING}`,
    )
  }
}

/** The one URL `git remote get-url` prints for `remote`, fetch or push. */
const urlOf = async (git: Git, branch: string, remote: string, which: 'fetch' | 'push'): Promise<string> => {
  const args = which === 'fetch' ? ['remote', 'get-url', '--all', '--', remote] : ['remote', 'get-url', '--push', '--all', '--', remote]
  let printed: Buffer
  try {
    printed = await git(args)
  } catch (error) {
    // Measured, git 2.46: "error: No such remote", exit 2.
    if (error instanceof GitError && error.code === 2) {
      return refuse(
        `${branch} tracks ${remote}, which this clone does not define (git remote -v lists its remotes). ${NOTHING}`,
      )
    }
    throw error
  }
  const urls = printed
    .toString('utf8')
    .split('\n')
    .filter((url) => url !== '')
  const [only] = urls
  if (urls.length === 1 && only !== undefined) return only
  return refuse(
    urls.length === 0
      ? `${remote} has no ${which} URL; idpa reads one. ${NOTHING}`
      : `${remote} has ${String(urls.length)} ${which} URLs; idpa reads one. ${NOTHING}`,
  )
}

/** Where a URL this build will name points: a repository on GitHub, or another host. */
type Target = { readonly github: GitHubRepository } | { readonly host: string }

const printedTarget = (target: Target): string => ('github' in target ? printedRepository(target.github) : target.host)

/** The HTTPS form of a credential-carrying URL's path, when it names a repository; otherwise no URL at all. */
const withoutCredential = (path: string): string => {
  const plain = parseRemoteUrl(`https://github.com/${path}`)
  return plain.kind === 'github'
    ? `https://github.com/${plain.repository.owner}/${plain.repository.name}`
    : 'a URL without one (git remote set-url)'
}

/** Refuses a URL no push may name, and says where any other one points. */
const targetOf = (remote: string, url: RemoteUrl): Target => {
  switch (url.kind) {
    case 'github':
      return { github: url.repository }
    case 'other-host':
      return { host: url.host }
    case 'userinfo':
      return refuse(`${remote}'s URL carries a credential; set it to ${withoutCredential(url.path)}. ${NOTHING}`)
    case 'unreadable':
      return refuse(
        `${remote}'s URL does not parse as a GitHub repository (https://github.com/<owner>/<name>, ` +
          `git@github.com:<owner>/<name> and the three SSH forms docs/submitting.md lists). ${NOTHING}`,
      )
    default: {
      const _exhaustive: never = url
      return _exhaustive
    }
  }
}

/** The configuration keys of the clone's own that no push is made under (§ 7). */
const holdConfiguration = async (git: Git): Promise<void> => {
  const listing = parseConfigListing(await git(['config', '--list', '--show-scope', '-z']))
  const [first, ...others] = refusedConfigKeys(listing)
  if (first !== undefined) refuse(configRefusal(first, others.length))
}

/**
 * The road, read in this order: HEAD's branch, and outside its grammar no
 * upstream, or a refusal when it tracks a branch; `branch.<b>.remote` (unset:
 * no upstream) and its grammar, then git's own rule for a remote's name;
 * `branch.<b>.merge` (unset: no upstream), `baseOfMerge`, then `git
 * check-ref-format --branch`; the fetch URL and the push URL, one each; both
 * parsed, and compared; on the GitHub road, the clone's own configuration.
 * `--local` reads nothing.
 */
export async function readRoad(
  git: Git,
  options: { readonly local: boolean; readonly purpose?: Purpose },
): Promise<Road> {
  if (options.local) return { kind: 'local', why: 'asked' }
  const branch = await checkedOut(git)
  // The grammar guards the sentences that quote the branch and what GitHub's
  // paths read; a branch that tracks nothing is read on no path, and takes
  // stage 5's road whatever its name, as it did before the road was read.
  if (!isBranch(branch)) {
    if (await tracksAnything(git, branch)) refuseBranch(branch, options.purpose ?? 'submission')
    return { kind: 'local', why: 'no-upstream', branch }
  }

  const remote = await configValue(git, `branch.${branch}.remote`)
  if (remote === undefined) return { kind: 'local', why: 'no-upstream', branch }
  await holdRemote(git, branch, remote)

  const merge = await configValue(git, `branch.${branch}.merge`)
  if (merge === undefined) return { kind: 'local', why: 'no-upstream', branch }
  const base = baseOfMerge(merge)
  if (base === undefined || !(await answers(git, ['check-ref-format', '--branch', base], [128]))) {
    refuse(
      `${branch}'s upstream is not a branch this build reads (branch.${branch}.merge must be refs/heads/ and a ` +
        `branch name). ${NOTHING}`,
    )
  }

  const fetchUrl = await urlOf(git, branch, remote, 'fetch')
  const pushUrl = await urlOf(git, branch, remote, 'push')
  const fetch = targetOf(remote, parseRemoteUrl(fetchUrl))
  const push = targetOf(remote, parseRemoteUrl(pushUrl))
  const fork =
    `${remote} fetches from ${printedTarget(fetch)} and pushes to ${printedTarget(push)}; idpa pushes only where ` +
    `it reads (a fork set-up is not supported). ${NOTHING}`

  if ('github' in fetch && 'github' in push) {
    if (!sameRepository(fetch.github, push.github)) refuse(fork)
    await holdConfiguration(git)
    return { kind: 'github', repository: fetch.github, remote, base, branch, pushUrl }
  }
  if ('github' in fetch || 'github' in push) refuse(fork)
  return { kind: 'local', why: 'other-host', host: fetch.host }
}
