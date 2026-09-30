import { GitError, gitIn, type Git } from '../../process/git.js'
import type { GhProcess } from '../../process/gh.js'
import { ForgeInputError } from '../errors.js'
import type { GhIdentity, Road } from '../provider.js'
import { githubApi, githubClient, type GitHubApi } from './api.js'
import { readIdentity } from './identity.js'
import { readRoad } from './road.js'

/**
 * The GitHub side of a clone, opened: the road, and on GitHub's road who gh
 * is and the API through it. What `idpa protection` opens, and from the
 * stage 6 plan's 6.2.2 on, every submission after its local forge.
 */
export interface GitHubSide {
  readonly road: Road
  readonly identity?: GhIdentity
  readonly api?: GitHubApi
}

const text = (bytes: Buffer): string => bytes.toString('utf8').trim()

/**
 * The clone's root, and a checked-out branch: `git -C` walks upwards, and a
 * folder of another repository would read that repository's upstream. The
 * local forge judges the same for a submission, in stage 5's words; these
 * are `idpa protection`'s, which cuts nothing.
 */
async function requireCloneRoot(git: Git, repo: string, purpose: 'submission' | 'protection'): Promise<void> {
  const needs = purpose === 'protection' ? "idpa protection needs a clone's root" : '--submit needs a clone'
  const inside = await git(['rev-parse', '--is-inside-work-tree']).catch((error: unknown) => {
    if (error instanceof GitError && error.code === 'ENOENT') {
      throw new ForgeInputError(`git is not on PATH; ${purpose === 'protection' ? 'idpa protection' : '--submit'} reads the clone with it`)
    }
    throw new ForgeInputError(`${repo} is not a git working tree; ${needs}`)
  })
  if (text(inside) !== 'true') throw new ForgeInputError(`${repo} is not a git working tree; ${needs}`)
  const prefix = text(await git(['rev-parse', '--show-prefix']))
  if (prefix !== '') {
    throw new ForgeInputError(`${repo} is the folder ${prefix} of a git repository, not at its root; ${needs}`)
  }
  if (purpose === 'protection') {
    // readRoad refuses a detached HEAD in a submission's words.
    const head = await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => undefined)
    if (head === undefined) {
      throw new ForgeInputError('HEAD is detached; check out the branch whose upstream idpa protection checks')
    }
  }
}

/**
 * The road and, on GitHub's, gh's identity: before the road, the clone's
 * root; on another road, no gh starts. `gh` is the fake a test hands in
 * (`MainDeps.gh`), and `spawnGh` otherwise; `env` is the person's, which both
 * launchers pass on minus what they remove.
 */
export async function openGitHub(input: {
  readonly repo: string
  readonly env: NodeJS.ProcessEnv
  readonly gh?: GhProcess
  readonly local: boolean
  readonly git?: Git
  readonly purpose?: 'submission' | 'protection'
}): Promise<GitHubSide> {
  const purpose = input.purpose ?? 'submission'
  const git = input.git ?? gitIn(input.repo, { env: input.env })
  await requireCloneRoot(git, input.repo, purpose)
  const road = await readRoad(git, { local: input.local })
  if (road.kind === 'local') return { road }
  const gh = githubClient({ env: input.env, ...(input.gh === undefined ? {} : { run: input.gh }) })
  const identity = await readIdentity(gh, road, purpose)
  return { road, identity, api: githubApi(gh, road.repository) }
}
