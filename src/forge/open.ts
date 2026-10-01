import type { PullRequestInput } from '../core/github/pull-request.js'
import type { Repository } from '../core/plan/clear.js'
import type { GhProcess } from '../process/gh.js'
import { gitIn } from '../process/git.js'
import { ForgeInputError } from './errors.js'
import type { GitHubApi } from './github/api.js'
import { openGitHubForge } from './github/forge.js'
import { openGitHub } from './github/open.js'
import { readRoad } from './github/road.js'
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

/** The roads that open a pull request in this build; the others are refused toward GitHub (stage 6 plan, 6.3). */
const OPENS_PULL_REQUESTS: readonly PullRequestInput['road'][] = ['from']

/**
 * Why a road that does not open pull requests yet stops toward GitHub, before
 * gh starts: no road starts gh before the test that proves what reaches it
 * lands with it (stage 6 plan, Global Constraint 1). 6.3.1, 6.3.2 and 6.3.3
 * each remove their entry, and the last removes both constants.
 */
const NOT_YET: Readonly<Partial<Record<PullRequestInput['road'], string>>> = {
  intent:
    'the intent road opens pull requests from the next release; add --local to cut the branch in ' +
    'this clone only, or submit a plan file with plan --from <plan.json> --submit. Nothing was written.',
  init:
    "init opens a pull request on the service's repository from the next release; add --local to cut " +
    'the branch in this clone only. Nothing was written.',
  phrase:
    'idpa "<phrase>" does not submit yet; a change is submitted with plan --from <plan.json> --submit. ' +
    'Nothing was written.',
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

  if (!OPENS_PULL_REQUESTS.includes(route)) {
    const road = await readRoad(git, { local })
    if (road.kind !== 'github') return { forge, road }
    const said = NOT_YET[route]
    if (said === undefined) throw new Error(`the ${route} road neither opens pull requests nor says why not`)
    throw new ForgeInputError(said)
  }

  const side = await openGitHub({ repo, env, ...(input.gh === undefined ? {} : { gh: input.gh }), local, git })
  const { road, identity, api } = side
  if (road.kind === 'local') return { forge, road }
  if (identity === undefined || api === undefined) throw new Error('openGitHub opened the GitHub road without gh')
  // Opened again, its checks four reads already passed: the option is fixed
  // at opening, and the local road's forge keeps D7 as stage 5 wrote it.
  const older = await openLocalForge(repo, repository, git, { acceptOlderBase: true })
  return {
    forge: openGitHubForge({ repo, local: older, road, api, env, git, route }),
    road,
    github: { identity, api },
  }
}
