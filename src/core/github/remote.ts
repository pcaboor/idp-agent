/**
 * The remote a submission pushes to, and the grammars every value read from a
 * clone's own configuration is held to (stage 6 brief § 13). Pure: the URL is
 * the one the person's own git printed (`git remote get-url`), which the
 * forge reads through the launcher; this module only says what it is.
 *
 * `process/` imports nothing of ours, so the launchers hold copies of these
 * grammars (`process/grammar.ts`'s `isBranch`, `process/git.ts`'s remote name
 * and `GITHUB_PUSH_URL`, `process/gh.ts`'s owner and name), and
 * `tests/unit/grammar-agreement.test.ts` holds each pair to one verdict. A
 * change to one is a change to both.
 */

/** A repository on github.com, as its remote's URL names it. Printed `github.com/<owner>/<name>`. */
export interface GitHubRepository {
  readonly host: 'github.com'
  readonly owner: string
  readonly name: string
}

/**
 * What a remote's URL is to this build:
 *   - `github`: one of the five forms, the owner and the name held to
 *     GitHub's grammar; `url` is the string as given, the one a push names;
 *   - `other-host`: any other host, where this build opens no pull request —
 *     `this machine` for a path or a `file://` URL;
 *   - `userinfo`: a GitHub URL carrying a user or a password beyond the SSH
 *     forms' own, which is where a copied token sits; `path` is as written,
 *     and named only once it parses;
 *   - `unreadable`: a GitHub URL in none of the five forms, or a URL holding
 *     a control or format character anywhere.
 */
export type RemoteUrl =
  | { readonly kind: 'github'; readonly repository: GitHubRepository; readonly url: string }
  | { readonly kind: 'other-host'; readonly host: string }
  | { readonly kind: 'userinfo'; readonly host: string; readonly path: string }
  | { readonly kind: 'unreadable' }

/** The host of a path or a `file://` URL: nothing leaves this machine. */
export const THIS_MACHINE = 'this machine'

/** What a host that is no host name is called, rather than quoted. */
export const UNNAMED_HOST = 'a host this build does not name'

/** GitHub's account names: letters, digits and hyphens, up to 39, not starting with a hyphen. */
const isOwner = (word: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(word)

/** GitHub's repository names: letters, digits, `.`, `_`, `-`, up to 100, never `.` or `..`. */
const isName = (word: string): boolean => /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/.test(word)

/**
 * The five forms (brief § 13), exactly as GitHub prints them — lower-case
 * hosts, no port but 443 on `ssh.github.com`, no user but the SSH forms' own —
 * then `<owner>/<last>` and nothing after.
 */
const FORMS =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|ssh:\/\/git@ssh\.github\.com:443\/|org-[0-9]{1,20}@github\.com:)([^/]*)\/([^/]*)$/

/**
 * The name a GitHub URL's last segment holds: the segment without a trailing
 * `.git`, when there is one, held to GitHub's grammar — so `.git` alone,
 * `..git` and a 101-character name are none. `process/git.ts`'s
 * `GITHUB_PUSH_URL` reads the segment the same way.
 */
const nameOf = (segment: string): string | undefined => {
  const bare = segment.endsWith('.git') ? segment.slice(0, -'.git'.length) : segment
  return isName(bare) ? bare : undefined
}

/** A control or format character: a bidi override, a zero-width mark, a newline. */
const HIDDEN = /[\p{Cc}\p{Cf}]/u

/** The hosts GitHub answers on, whatever the case they are written in. */
const isGitHubHost = (host: string): boolean => {
  const lower = host.toLowerCase()
  return lower === 'github.com' || lower === 'ssh.github.com'
}

/** A host as it is printed on the other-host road: a name, lower-cased, or `UNNAMED_HOST`. */
const hostNamed = (host: string): string =>
  /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/.test(host) ? host.toLowerCase() : UNNAMED_HOST

/**
 * The user an SSH form carries, which is not a credential: `git`, and the
 * `org-<id>` of an organisation's SSH certificate authority.
 */
const isSshUser = (user: string): boolean => user === 'git' || /^org-[0-9]{1,20}$/.test(user)

/** A URL with a scheme: `scheme://[userinfo@]host[:port][/path]`. */
const SCHEMED = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s

/** git's scp-like form: `[user@]host:path`, no `/` before the host's colon. */
const SCP_LIKE = /^(?:([^/]*)@)?([^@:/]+):(.*)$/s

/** Reads `url` as one of the four kinds. Never throws. */
export function parseRemoteUrl(url: string): RemoteUrl {
  if (HIDDEN.test(url)) return { kind: 'unreadable' }
  const form = FORMS.exec(url)
  if (form !== null) {
    const [, owner = '', segment = ''] = form
    const name = nameOf(segment)
    if (!isOwner(owner) || name === undefined) return { kind: 'unreadable' }
    return { kind: 'github', repository: { host: 'github.com', owner, name }, url }
  }

  const schemed = SCHEMED.exec(url)
  if (schemed !== null) {
    const [, scheme = '', authority = '', rest = ''] = schemed
    if (scheme.toLowerCase() === 'file') return { kind: 'other-host', host: THIS_MACHINE }
    const at = authority.lastIndexOf('@')
    const user = at === -1 ? undefined : authority.slice(0, at)
    const hostPort = authority.slice(at + 1)
    const host = hostPort.startsWith('[') ? hostPort : hostPort.replace(/:[^:]*$/, '')
    if (!isGitHubHost(host)) return { kind: 'other-host', host: hostNamed(host) }
    const sshUser = scheme.toLowerCase() === 'ssh' && user !== undefined && isSshUser(user)
    if (user !== undefined && !sshUser) return { kind: 'userinfo', host: 'github.com', path: rest.replace(/^\//, '') }
    return { kind: 'unreadable' }
  }

  const scp = SCP_LIKE.exec(url)
  if (scp !== null) {
    const [, user, host = '', rest = ''] = scp
    if (!isGitHubHost(host)) return { kind: 'other-host', host: hostNamed(host) }
    if (user !== undefined && !isSshUser(user)) return { kind: 'userinfo', host: 'github.com', path: rest }
    return { kind: 'unreadable' }
  }

  // No scheme and no host: a path, absolute or relative, which git reads as
  // a repository on this machine.
  return { kind: 'other-host', host: THIS_MACHINE }
}

/**
 * A remote's name, read from a hostile configuration: 1 to 100 letters,
 * digits, `.`, `_`, `-` and `/`, not starting with `-` or `.`. The forge also
 * asks git whether `refs/remotes/<name>/HEAD` is a ref name, git's own rule,
 * and passes the name after `--`.
 */
export const isRemoteName = (name: string): boolean => /^(?![-.])[A-Za-z0-9._/-]{1,100}$/.test(name)

/**
 * A branch name this build hands git or gh: what `git check-ref-format
 * --branch` accepts, narrowed — 1 to 255 bytes, not starting with `-` or
 * `.`; no control or format character, no white space, none of
 * `~ ^ : ? * [ \ { } %`; no `..`, `@{`, `//`, `/.`, no component ending in
 * `.lock`, not ending in `/` or `.`, never `@` alone. The copy of
 * `process/grammar.ts`'s `isBranch`, which says why each is refused.
 */
export const isBranch = (word: string): boolean =>
  word !== '' &&
  word !== '@' &&
  Buffer.byteLength(word, 'utf8') <= 255 &&
  !/^[-.]/.test(word) &&
  !/[\p{Cc}\p{Cf}\s~^:?*[\\{}%]/u.test(word) &&
  !/\.\.|@\{|\/\/|\/\./.test(word) &&
  !/\.lock(?:\/|$)/.test(word) &&
  !/[/.]$/.test(word)

/**
 * The base `branch.<name>.merge` names: `refs/heads/` and a branch, or
 * undefined — a tag, a pull request's ref, a bare name, anything outside
 * `isBranch`.
 */
export function baseOfMerge(merge: string): string | undefined {
  const prefix = 'refs/heads/'
  if (!merge.startsWith(prefix)) return undefined
  const base = merge.slice(prefix.length)
  return isBranch(base) ? base : undefined
}

/**
 * A GitHub login: an account's name (letters, digits and hyphens, up to 39,
 * not starting with a hyphen), and an App's bot, the same with `[bot]` after.
 */
export const isLogin = (login: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(login)

/** GitHub's own comparison: an owner and a name are the same whatever their case. */
export function sameRepository(a: GitHubRepository, b: GitHubRepository): boolean {
  return (
    a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
  )
}

/** `github.com/<owner>/<name>`, as every sentence names a repository. */
export const printedRepository = (repository: GitHubRepository): string =>
  `${repository.host}/${repository.owner}/${repository.name}`

/**
 * `.idp-agent.yml`'s `iacRepo` read as a repository on github.com, or undefined:
 * `github.com/<owner>/<name>`, optionally behind `https://` or `ssh://`, optionally ending
 * `.git` or `/`, the scheme and the host in any case (RFC 3986 § 3.1 and § 3.2.2). The schema has already refused userinfo, a query and
 * a fragment (`carriesCredential`), so nothing here can hold a credential. The owner and the
 * name are held to the grammar `parseRemoteUrl` holds them to. Anything else — another
 * host, a path of one or three segments, a bare word — is undefined: a locator this build
 * cannot compare with a remote, which the cross-check refuses rather than skips.
 */
export function locatorRepository(iacRepo: string): GitHubRepository | undefined {
  if (HIDDEN.test(iacRepo)) return undefined
  const unschemed = iacRepo.replace(/^(?:https|ssh):\/\//i, '')
  const unslashed = unschemed.endsWith('/') ? unschemed.slice(0, -1) : unschemed
  const segments = (unslashed.endsWith('.git') ? unslashed.slice(0, -'.git'.length) : unslashed).split('/')
  if (segments.length !== 3) return undefined
  const [host = '', owner = '', name = ''] = segments
  if (host.toLowerCase() !== 'github.com' || !isOwner(owner) || !isName(name)) return undefined
  return { host: 'github.com', owner, name }
}
