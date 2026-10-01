import { protectionText, type Missing, type ProtectionVerdict } from '../../core/github/protection.js'
import { printedRepository } from '../../core/github/remote.js'
import type { GhIdentity, GitHubRoad } from '../../forge/provider.js'
import { inertLine } from './plain.js'

/**
 * What `idpa protection` prints on stdout, and what a submission refused on
 * the rules prints (stage 6 brief § 8). Every value in it came from a clone's
 * configuration or from GitHub — a repository, a base, a login, a status
 * check's context — and every line that can hold one passes `inertLine`,
 * whole: a shortened name is another name. The list of settings is the
 * engine's own constant, printed as it is.
 */

/** One line, nothing a terminal obeys, never cut; its indentation, which `inertLine` would trim, kept. */
const shown = (line: string): string => {
  const indent = /^ */.exec(line)?.[0] ?? ''
  return `${indent}${inertLine(line.slice(indent.length), Number.POSITIVE_INFINITY)}`
}

/** `github.com/<o>/<r>'s <base>`, as every block opens. */
const baseOf = (road: GitHubRoad): string => `${printedRepository(road.repository)}'s ${road.base}`

/** `ruleset 1`, `rulesets 1 and 2`, `rulesets 1, 2 and 3`. */
const rulesetsOf = (ids: readonly number[]): string => {
  const named = ids.map(String)
  if (named.length <= 1) return `ruleset ${named.join('')}`
  return `rulesets ${named.slice(0, -1).join(', ')} and ${named.at(-1) ?? ''}`
}

/** The missing rules a ruleset would supply: the list of settings follows them. */
const RULESET_WOULD_HELP: ReadonlySet<Missing> = new Set([
  'pull-request',
  'approvals',
  'last-push',
  'non-fast-forward',
  'deletion',
  'bypassable',
  'deploy-key',
  'classic-only',
])

/** What each missing thing is, in one line after `missing: `. */
function missingText(missing: Missing, verdict: ProtectionVerdict, road: GitHubRoad, login: string): string {
  switch (missing) {
    case 'pull-request':
      return 'a pull request rule requiring 1 approval'
    case 'approvals':
      return 'at least 1 required approval (the pull request rule requires 0)'
    case 'last-push':
      return 'approval of the most recent push'
    case 'non-fast-forward':
      return 'block force pushes'
    case 'deletion':
      return 'restrict deletions'
    case 'bypassable':
      return `rules ${login} cannot bypass: a ruleset that supplies them lets gh's account bypass it`
    case 'deploy-key': {
      const one = (verdict.deployKeys ?? []).length === 1
      return (
        `no deploy key in the bypass list: ${rulesetsOf(verdict.deployKeys ?? [])} ${one ? 'lets' : 'let'} a deploy ` +
        `key bypass ${one ? 'it' : 'them'}, and a deploy key pushes with git, where gh cannot see it`
      )
    }
    case 'classic-only':
      return `a ruleset: ${road.base} is protected by classic branch protection only, which idpa does not read`
    case 'archived':
      return `a repository that is not archived: ${printedRepository(road.repository)} is`
    case 'no-push':
      return `push access: ${login} cannot push to ${road.repository.owner}/${road.repository.name}`
    case 'renamed':
      return (
        `the remote's name: GitHub answers ${verdict.renamedTo ?? 'another name'}, so the repository was renamed ` +
        "or transferred; update the remote's URL"
      )
    default: {
      const _exhaustive: never = missing
      return _exhaustive
    }
  }
}

/**
 * The `missing:` lines, then the list of settings when a ruleset would supply
 * what is missing, each line shown — the list is the engine's own, and
 * printed as it is: `inertLine` would fold its aligned columns.
 */
const refusal = (verdict: ProtectionVerdict, road: GitHubRoad, login: string): string[] => [
  ...verdict.missing.map((missing) => shown(`  missing: ${missingText(missing, verdict, road, login)}`)),
  ...(verdict.missing.some((missing) => RULESET_WOULD_HELP.has(missing))
    ? [shown(`Add a ruleset on ${road.base} (Settings → Rules → Rulesets):`), ...protectionText()]
    : []),
]

/** An actor type as a person reads it, singular and plural; a type GitHub adds later, as it wrote it when it is a word. */
const actorWords = (type: string): readonly [string, string] => {
  switch (type) {
    case 'Integration':
      return ['app', 'apps']
    case 'Team':
      return ['team', 'teams']
    case 'RepositoryRole':
      return ['repository role', 'repository roles']
    case 'OrganizationAdmin':
      return ['organisation administrators', 'organisation administrators']
    case 'EnterpriseOwner':
      return ['enterprise owners', 'enterprise owners']
    case 'DeployKey':
      return ['deploy key', 'deploy keys']
    default:
      return /^[A-Z][A-Za-z]{0,39}$/.test(type) ? [type, type] : ['other actor', 'other actors']
  }
}

/** `1 app and 1 team`, `2 apps, 1 team and 1 repository role`. */
const actorsOf = (actors: readonly { readonly type: string; readonly count: number }[]): string => {
  const said = actors.map(({ type, count }) => {
    const [one, many] = actorWords(type)
    return `${String(count)} ${count === 1 ? one : many}`
  })
  return said.length === 1 ? (said[0] ?? '') : `${said.slice(0, -1).join(', ')} and ${said.at(-1) ?? ''}`
}

/**
 * `idpa protection`'s answer: why the base holds, what is reported and what
 * no read can see (exit 0); or what it lacks and the ruleset to add (exit 1).
 */
export function renderProtection(verdict: ProtectionVerdict, road: GitHubRoad, identity: GhIdentity): string {
  const login = identity.login
  if (!verdict.holds) {
    return [
      shown(`${baseOf(road)} does not stop the person who would open a pull request from merging it:`),
      ...refusal(verdict, road, login),
      'Then run idpa protection again.',
    ].join('\n')
  }
  const { reported } = verdict
  const from = `(${rulesetsOf(verdict.binding)})`
  const pushRule =
    reported.dismissStaleOnly
      ? `  stale approvals dismissed on a new push ${from}; approval of the most recent push is not set, so the ` +
        'account your git pushes with could approve a pull request gh opened'
      : `  approval of the most recent push ${from}`
  // GitHub shows a ruleset's bypass list only to someone who may edit the
  // ruleset: an organisation's is hidden from a repository's administrator.
  const hidden = reported.bypassHidden
  const unseen = (whom: string): string =>
    `not shown to ${login}, who cannot edit ${whom}, so a deploy key there would go unseen`
  const actors =
    reported.bypassActors === 'unreadable' || reported.bypassActors.length === 0
      ? 'empty'
      : `${actorsOf(reported.bypassActors)}; none is you, as gh reads you`
  const bypassList =
    reported.bypassActors === 'unreadable'
      ? [`  bypass list: ${unseen(rulesetsOf(hidden))}`]
      : hidden.length === 0
        ? [`  bypass list: ${actors}`]
        : [
            `  bypass list of ${rulesetsOf(verdict.binding.filter((id) => !hidden.includes(id)))}: ${actors}`,
            `  bypass list of ${rulesetsOf(hidden)}: ${unseen(hidden.length === 1 ? 'it' : 'them')}`,
          ]
  return [
    `${baseOf(road)} keeps a pull request from merging until someone other than its opener approves its latest ` +
      `commit, as gh reads it for ${login}:`,
    `  a pull request before merging, ${String(reported.approvals)} approval${reported.approvals === 1 ? '' : 's'} ${from}`,
    pushRule,
    `  force pushes blocked, deletions restricted ${from}`,
    `  ${login} (gh, ${reported.role}) cannot bypass ${rulesetsOf(verdict.binding)} (current_user_can_bypass: never)`,
    ...bypassList,
    'Reported, not required:',
    `  review from Code Owners: ${reported.codeOwners ? 'required' : 'not required'}`,
    `  status checks: ${
      reported.statusChecks.length === 0
        ? 'none required, so a system downstream could not refuse a merge (ADR-0012)'
        : reported.statusChecks.join(', ')
    }`,
    `  signed commits: ${reported.signatures ? 'required' : 'not required'}`,
    `  merge queue: ${reported.mergeQueue ? 'required' : 'none'}`,
    'What no read can see:',
    "  an administrator can edit or disable the ruleset outside idpa, and then merge; GitHub records it in the ruleset's history",
    `  the credential your git pushes with: a deploy key or another account's key in the bypass list could move ` +
      `${road.base} without a pull request; push as ${login} (docs/submitting.md)`,
    '  whether GitHub Actions or an app may approve pull requests here (Settings → Actions → General → Workflow permissions)',
    'Also advised: a ruleset on refs/heads/idp-agent/** blocking force pushes and deletions, so a branch under review is never rewritten.',
  ]
    .map(shown)
    .join('\n')
}

/**
 * What a submission refused on the rules prints (stage 6 brief § 8): the same
 * `missing:` lines, the ruleset to add, and that nothing was written:
 * `refuseUnprotected`'s, on the GitHub road of a submission.
 */
export function renderUnprotected(verdict: ProtectionVerdict, road: GitHubRoad, identity: GhIdentity): string {
  return [
    shown(`not submitted — nothing on ${baseOf(road)} stops the person who would open this pull request from merging it:`),
    ...refusal(verdict, road, identity.login),
    'Then run this again. Nothing was written.',
  ].join('\n')
}
