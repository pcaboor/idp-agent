import { GH_MINIMUM_VERSION, isAtLeast, parseGhVersion } from '../../core/github/gh-version.js'
import { isLogin, printedRepository } from '../../core/github/remote.js'
import { GhError, type GhClient } from '../../process/gh.js'
import { ForgeInputError } from '../errors.js'
import type { GhIdentity, GitHubRoad } from '../provider.js'
import { GitHubAnswerError, githubApi, statusOf } from './api.js'

/**
 * Who gh is, before anything else is read on GitHub (stage 6 brief § 5, § 9):
 * installed, at least `GH_MINIMUM_VERSION`, logged in to github.com, and as a
 * person — two gh calls, `--version` and `GET user`, the two § 15 budgets.
 *
 * Every refusal here is the person's to fix with one command, so each is exit
 * 2 (`ForgeInputError`), before anything is written, and says the command.
 * Logged out and expired are one case: gh's exit 4 when it holds no login,
 * GitHub's 401 when the login it holds was revoked or has expired. A `Bot`, or
 * a token GitHub will not describe as a user (403 on `/user`: a workflow's
 * `GITHUB_TOKEN`, an App's installation token), is refused: the pull
 * request's author would be a bot, and the person who asked could approve
 * their own request, which is what the invariant forbids. Any other answer
 * GitHub fails to give is a `GitHubAnswerError`, exit 1, and so is a gh that
 * hangs or fails on `--version` (route `version`): no update fixes that.
 *
 * `purpose` is `protection` for `idpa protection`, which takes no `--local`:
 * its sentences leave out the offer to cut the branch in this clone only.
 */
export async function readIdentity(
  gh: GhClient,
  road: GitHubRoad,
  purpose: 'submission' | 'protection' = 'submission',
): Promise<GhIdentity> {
  const offer = purpose === 'submission' ? '; or add --local to cut the branch in this clone only' : ''
  const orOffer = purpose === 'submission' ? ', or add --local to cut the branch in this clone only' : ''
  const tracks = `${road.branch} tracks ${printedRepository(road.repository)}`
  const cannotRead = 'so idpa cannot read the rules that keep a pull request from merging unreviewed'
  const refuse = (message: string): never => {
    throw new ForgeInputError(`${message} Nothing was written.`)
  }
  const asYourself =
    "the pull request's author would be a bot, and whoever asked could approve it. " +
    `Log gh in as yourself (gh auth login --hostname github.com)${orOffer}.`

  let printed: string
  try {
    printed = await gh.version()
  } catch (error) {
    if (!(error instanceof GhError)) throw error
    if (error.kind === 'missing') {
      return refuse(
        `${tracks}, and gh is not installed, ${cannotRead}. Install it (https://cli.github.com) and run this again${offer}.`,
      )
    }
    // A gh that hung, said too much or failed printed no version at all:
    // updating it is not the remedy, so this is not the person's to fix.
    throw new GitHubAnswerError('version', statusOf(error), road.repository)
  }
  const version = parseGhVersion(printed)
  if (version === undefined) return refuse(`gh printed no version this build reads; update gh, then run this again${offer}.`)
  if (!isAtLeast(version, GH_MINIMUM_VERSION)) {
    return refuse(
      `gh ${version} is older than ${GH_MINIMUM_VERSION}, the oldest this build reads; update gh, then run this again${offer}.`,
    )
  }

  let user: { readonly login: string; readonly type: string }
  try {
    user = await githubApi(gh, road.repository).user()
  } catch (error) {
    if (error instanceof GitHubAnswerError && error.status === 401) {
      return refuse(
        `${tracks}, and gh is not logged in to github.com, ${cannotRead}. ` +
          `Run \`gh auth login --hostname github.com\`, then run this again${offer}.`,
      )
    }
    if (error instanceof GitHubAnswerError && error.status === 403) {
      return refuse(
        'gh is logged in to github.com with a token GitHub will not describe as a user (it answered 403 to /user), ' +
          `as a workflow's or an app's is: ${asYourself}`,
      )
    }
    throw error
  }

  if (!isLogin(user.login)) return refuse('gh is logged in to github.com as an account whose name this build does not read.')
  if (user.type !== 'User') {
    // A type is GitHub's word, printed only when it is one.
    const type = /^[A-Z][A-Za-z]{0,39}$/.test(user.type) ? user.type : undefined
    const says =
      type === undefined
        ? 'which GitHub does not describe as a person'
        : `which GitHub says is ${/^[AEIOU]/.test(type) ? 'an' : 'a'} ${type}, not a person`
    return refuse(`gh is logged in to github.com as ${user.login}, ${says}: ${asYourself}`)
  }
  return { login: user.login, role: undefined }
}
