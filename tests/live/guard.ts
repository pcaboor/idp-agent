import path from 'node:path'
import { isBranch, isLogin } from '../../src/core/github/remote.js'
import { SUBMISSION_PREFIX } from '../../src/core/plan/clear.js'
import { pushEnvironment } from '../../src/process/git.js'

/**
 * The live test's guard (stage 6 plan, Task 6.4.1), pure so the default suite
 * can test it without importing `tests/live/setup.ts`, whose import throws by
 * design: the two variables the live run reads, the grammar of the throwaway
 * repository it names, the environment it keeps, the environments its own gh
 * and git run in, and what its cleanup may delete.
 *
 * The live test reaches GitHub with the owner's own gh and git, on purpose and
 * only against a repository whose name says it is the throwaway one. A value
 * this guard refuses is never quoted: it is the owner's shell, and a message is
 * read by whoever reads the terminal.
 */

/** The only variables the live run reads, and the only `IDP_*` it keeps. */
export const LIVE_VARIABLES = ['IDP_GITHUB_LIVE_REPO', 'IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR'] as const

const WHERE = '(docs/submitting.md, "Proving it on your repository")'

/** GitHub's repository names: letters, digits, `.`, `_`, `-`, up to 100, never `.` or `..`. */
const isName = (word: string): boolean => /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/.test(word)

/**
 * `IDP_GITHUB_LIVE_REPO`, `<owner>/<name>`: the owner a GitHub login (an
 * account's, never a bot's), the name GitHub's grammar holding `idpa-live`.
 * Throws naming the variable, never quoting its value.
 */
export function liveRepository(env: NodeJS.ProcessEnv): { owner: string; name: string } {
  const value = env['IDP_GITHUB_LIVE_REPO']
  if (value === undefined || value === '') {
    throw new Error(
      `IDP_GITHUB_LIVE_REPO is not set: the live test runs only on purpose, against your throwaway repository ${WHERE}.`,
    )
  }
  const parts = value.split('/')
  const [owner = '', name = ''] = parts
  if (parts.length !== 2 || !isLogin(owner) || owner.endsWith(']') || !isName(name) || !name.includes('idpa-live')) {
    throw new Error(
      'IDP_GITHUB_LIVE_REPO is not <owner>/<name> on github.com, the owner a login and the name holding idpa-live: ' +
        `the live test runs only against your throwaway repository ${WHERE}.`,
    )
  }
  return { owner, name }
}

/**
 * The second account's gh configuration directory, absolute, or undefined
 * when unset: the account is optional (the owner's decision of 2026-10-01),
 * and only the steps that need another person — the approval, and the same
 * change proposed by someone else — are skipped without it. Throws on a
 * relative path, which would be read from wherever vitest runs.
 */
export function reviewerConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const value = env['IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR']
  if (value === undefined || value === '') return undefined
  if (!path.isAbsolute(value)) {
    throw new Error(
      'IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR is not an absolute path: name the second account’s gh configuration ' +
        `directory in full, or unset it to skip the steps that need a second account ${WHERE}.`,
    )
  }
  return value
}

const KEPT: ReadonlySet<string> = new Set(LIVE_VARIABLES)

/**
 * Removes every `*_API_KEY` and every `IDP_*` but `LIVE_VARIABLES` (exactly
 * as they are spelled), whatever the case of a name — Windows reads a
 * variable by any case — and touches nothing else: gh's own variables, `HOME`,
 * `SSH_AUTH_SOCK` and `PATH` are how the owner's gh and git reach GitHub.
 * No model is reachable, no trace is written, no catalogue is read.
 */
export function scrubLiveEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase()
    if (upper.endsWith('_API_KEY') || (upper.startsWith('IDP_') && !KEPT.has(name))) delete env[name]
  }
}

/**
 * The setup file's whole work (`tests/live/setup.ts`): the environment
 * scrubbed, then the throwaway repository required. Throws as
 * `liveRepository` does, after the scrub.
 */
export function prepareLiveRun(env: NodeJS.ProcessEnv): { owner: string; name: string } {
  scrubLiveEnvironment(env)
  return liveRepository(env)
}

/** The variables that outrank `GH_CONFIG_DIR` in gh: any of them would answer as the owner. */
export const GH_TOKEN_VARIABLES: readonly string[] = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/**
 * The second account's environment: `env` with its gh configuration
 * directory, `dir`, and without any of `GH_TOKEN_VARIABLES` or another
 * `GH_CONFIG_DIR`, whatever the case of a name. `env` is not changed.
 */
export function reviewerEnvironment(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const [variable, value] of Object.entries(env)) {
    const upper = variable.toUpperCase()
    if (GH_TOKEN_VARIABLES.includes(upper) || upper === 'GH_CONFIG_DIR') continue
    kept[variable] = value
  }
  return { ...kept, GH_CONFIG_DIR: dir }
}

/**
 * The environment the test's own git runs in — its clone, its pushes, the
 * push door: the push's environment as `process/git.ts` builds it for the CLI,
 * every `GIT_*` removed but the four ways of reaching GitHub
 * (`PUSH_VARIABLES`), so an exported `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_COUNT` cannot send a push from the
 * test's clone to another repository's `origin`. The test's git is never
 * weaker than the code it proves.
 */
export function liveGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return pushEnvironment(env)
}

/** The base with a slash in its name the run pushes in step 1, and deletes after. */
export const liveBaseOf = (stamp: string): string => `live/${stamp}/base`

const SUBMITTED_BRANCH = String.raw`idp-agent\/[a-z0-9-]+-[0-9a-f]{8}`

/**
 * Every pull request and branch a CLI run's stdout says it made: `Pull request
 * #<n> opened on`, `submitted as <branch> `, and the line of a branch pushed
 * whose pull request was not opened, `· <branch> is on <repository>, and …`.
 */
export function remembered(stdout: string): { readonly pulls: readonly number[]; readonly branches: readonly string[] } {
  const pulls = [...stdout.matchAll(/^Pull request #([1-9][0-9]*) opened on /gm)].map(([, number]) => Number(number))
  const branches = [
    ...stdout.matchAll(new RegExp(`submitted as (${SUBMITTED_BRANCH}) `, 'g')),
    ...stdout.matchAll(new RegExp(`· (${SUBMITTED_BRANCH}) is on `, 'g')),
  ].map(([, branch]) => branch ?? '')
  return { pulls, branches }
}

/**
 * The `idp-agent/` branches `git ls-remote` lists whose name holds the run's
 * stamp, `-<stamp>-`: every entity the run submits carries it, so a branch the
 * CLI pushed is found even when its stdout never named it — a pull request
 * not opened, a run killed at its bound.
 */
export function stampedBranches(lsRemote: string, stamp: string): string[] {
  const found: string[] = []
  for (const line of lsRemote.split(/\r?\n/)) {
    const branch = /^[0-9a-f]{40,64}\trefs\/heads\/(idp-agent\/\S+)$/.exec(line)?.[1]
    if (branch !== undefined && branch.includes(`-${stamp}-`)) found.push(branch)
  }
  return found
}

/**
 * What the cleanup may delete, out of what it was handed: a branch under
 * `idp-agent/`, or the run's own `live/<stamp>/base`, each a branch name git
 * takes — never the base, whatever else it is. `refused` is the rest, which
 * the cleanup says and leaves.
 */
export function cleanupTargets(input: {
  readonly branches: Iterable<string>
  readonly base: string | undefined
  readonly stamp: string
}): { readonly targets: readonly string[]; readonly refused: readonly string[] } {
  const targets: string[] = []
  const refused: string[] = []
  for (const branch of [...new Set(input.branches)].sort()) {
    const ours = branch.startsWith(SUBMISSION_PREFIX) || branch === liveBaseOf(input.stamp)
    if (branch === input.base || !ours || !isBranch(branch)) refused.push(branch)
    else targets.push(branch)
  }
  return { targets, refused }
}

/**
 * One look, at the end of the run, at what it opened: each pull request's
 * `merged`, as GitHub answered it, and the base's commit; `undefined` where a
 * read failed.
 */
export interface EndLook {
  readonly merged: readonly (boolean | undefined)[]
  readonly baseSha: string | undefined
}

/**
 * Whether nothing the run opened was merged, over every look at its end —
 * before the cleanup closes anything, and after it: `false` as soon as one
 * look saw a pull request merged or the base elsewhere than `start`, the
 * commit the run found it at; `true` when every look read everything and saw
 * neither; `null` otherwise. A read that failed, or no look at all,
 * establishes nothing, and is never taken for true.
 */
export function neverMerged(looks: readonly EndLook[], start: string): boolean | null {
  const seen = looks.some((look) => look.merged.includes(true) || (look.baseSha !== undefined && look.baseSha !== start))
  if (seen) return false
  const read = looks.length > 0 && looks.every((look) => look.baseSha !== undefined && !look.merged.includes(undefined))
  return read ? true : null
}

/**
 * Whether a mention in a pull request's rendered body (`body_html`) stayed
 * code: present inside a `<pre>` or `<code>` block, absent from every text
 * node outside them, and never rendered as a user mention. Attributes are not
 * text: GitHub's copy button repeats a fenced block's content in
 * `data-snippet-clipboard-copy-content`, outside the `<pre>` (2026-10-02).
 */
export function mentionRenderedAsCode(html: string, mention: string): boolean {
  const wanted = mention.toLowerCase()
  const lower = html.toLowerCase()
  const blocks = lower.match(/<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/g) ?? []
  const inside = blocks.some((block) => block.replace(/<[^>]*>/g, '').includes(wanted))
  const outside = lower
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/<code[\s\S]*?<\/code>/g, '')
    .replace(/<[^>]*>/g, '')
  const linked = /class="[^"]*\buser-mention\b/.test(lower)
  return inside && !outside.includes(wanted) && !linked
}

