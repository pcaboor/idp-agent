import type { PullRequestInput } from '../core/github/pull-request.js'
import type { Repository } from '../core/plan/clear.js'
import type { GhProcess } from '../process/gh.js'
import { gitIn } from '../process/git.js'
import type { GitHubApi } from './github/api.js'
import { openGitHubForge } from './github/forge.js'
import { openGitHub } from './github/open.js'
import { openLocalForge } from './local/forge.js'
import type { ForgeProvider, GhIdentity, Road } from './provider.js'

/**
 * The forge a submission is cut with, opened once for one repository, before
 * anything is read and before any model (stage 6 brief § 3, steps 1 to 3):
 * stage 5's local forge, whose checks come first — a directory that is not a
 * clone's root, nobody to commit as, a detached HEAD — then the road (§ 13),
 * then, on GitHub's road, who gh is; and on that road the GitHub forge over a
 * local forge that takes our commit on an older base as ours (§ 14). Every
 * refusal here is the person's to fix, exit 2 (`ForgeInputError`), and none
 * writes anything.
 *
 * `cli/` reaches the launchers only through this: it names `GhProcess` as a
 * type, and the git launcher and the gh client are built here, in `forge/`.
 */

export interface OpenedForge {
  readonly forge: ForgeProvider
  readonly road: Road
  /** On GitHub's road: who gh is, and GitHub through it. */
  readonly github?: { readonly identity: GhIdentity; readonly api: GitHubApi }
}

export async function openSubmissionForge(input: {
  readonly repo: string
  readonly repository: Repository
  /** The person's environment, which every launcher of the submission is handed (minus what each removes). */
  readonly env: NodeJS.ProcessEnv
  /** The fake a test hands in (`MainDeps.gh`); `spawnGh` otherwise. */
  readonly gh?: GhProcess
  /** `--local`: stage 5's branch, on purpose; nothing is read on GitHub. */
  readonly local: boolean
  /** The road that made the change, which the pull request's block names (D4). */
  readonly route: PullRequestInput['road']
}): Promise<OpenedForge> {
  const { repo, repository, env, local, route } = input
  const git = gitIn(repo, { env })
  // Stage 5's checks first, in stage 5's words.
  const forge = await openLocalForge(repo, repository, git)

  const side = await openGitHub({ repo, env, ...(input.gh === undefined ? {} : { gh: input.gh }), local, git })
  const { road, identity, api } = side
  if (road.kind === 'local') return { forge, road }
  if (identity === undefined || api === undefined) throw new Error('openGitHub opened the GitHub road without gh')
  // Opened again, its checks four reads already passed: the option is fixed
  // at opening, and the local road's forge keeps D7 as stage 5 wrote it.
  const older = await openLocalForge(repo, repository, git, { acceptOlderBase: true })
  return {
    forge: openGitHubForge({ repo, local: older, road, api, env, git, route, login: identity.login }),
    road,
    github: { identity, api },
  }
}
