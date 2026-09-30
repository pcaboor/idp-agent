import { printedRepository } from '../../core/github/remote.js'
import { ForgeInputError } from '../../forge/errors.js'
import { openGitHub } from '../../forge/github/open.js'
import { readProtection } from '../../forge/github/preflight.js'
import type { LocalRoad } from '../../forge/provider.js'
import type { GhProcess } from '../../process/gh.js'
import { renderProtection } from '../render/protection.js'
import type { CommandResult } from './result.js'

/**
 * `idpa protection`: whether the branch a clone tracks on github.com keeps a
 * pull request from merging until someone other than its opener approves its
 * latest commit (stage 6 brief § 8). Through the person's own gh, with reads
 * only: no model, and nothing written, here or on GitHub.
 *
 * `found` is whether the rules hold — exit 0, or 1 with the ruleset to add. A
 * clone that is not one, is on no GitHub road, or whose own configuration
 * would decide a push, and a gh that is missing, logged out, too old or not a
 * person, are refused before anything is read on GitHub (`ForgeInputError`,
 * exit 2); what GitHub fails to answer is a `GitHubAnswerError`, exit 1.
 */
export async function runProtection(input: {
  readonly repo: string
  readonly env: NodeJS.ProcessEnv
  readonly gh?: GhProcess
  /** Where the `checking` line goes: stderr, through `inertLine`. */
  readonly notice: (line: string) => void
}): Promise<CommandResult> {
  const side = await openGitHub({
    repo: input.repo,
    env: input.env,
    ...(input.gh === undefined ? {} : { gh: input.gh }),
    local: false,
    purpose: 'protection',
  })
  const { road, identity, api } = side
  if (road.kind === 'local') throw new ForgeInputError(noGitHubBase(road))
  if (identity === undefined || api === undefined) {
    throw new Error('openGitHub opened the GitHub road without gh')
  }
  input.notice(
    `checking ${printedRepository(road.repository)}'s ${road.base} (${road.remote}, ${road.branch}'s upstream), ` +
      `as ${identity.login} (gh)`,
  )
  const verdict = await readProtection(api, road)
  return { text: renderProtection(verdict, road, identity), found: verdict.holds }
}

/** Why a clone on a local road has nothing to check: there is no base on github.com. */
function noGitHubBase(road: LocalRoad): string {
  switch (road.why) {
    case 'no-upstream':
      return (
        `${road.branch} tracks no remote: idpa protection checks a branch on github.com, and there is none to check ` +
        'here. Nothing was read.'
      )
    case 'other-host':
      return (
        `the remote is on ${road.host}: idpa protection checks a branch on github.com, and this build reads no ` +
        'other host. Nothing was read.'
      )
    case 'asked':
      // `--local` is refused at parsing, and openGitHub is handed `local: false`.
      throw new Error('idpa protection read the road --local asks for')
    default: {
      const _exhaustive: never = road
      return _exhaustive
    }
  }
}
