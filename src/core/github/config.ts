import { isRemoteName } from './remote.js'

/**
 * A clone's own configuration, judged by key and scope and never by value
 * (stage 6 brief § 7). A clone's `.git/config` is the one thing on the
 * person's machine someone else wrote, git reads it on every call, and git
 * has no switch that skips it for a push. So the keys that choose where a
 * push goes, who authenticates it, or what program runs during it are
 * refused when they are set at the `local` or `worktree` scope — the
 * person's global and system configuration is theirs, as for their own
 * `git push`.
 *
 * The listing is `git config --list --show-scope -z`'s (measured on git
 * 2.46): `<scope>\0<key>\n<value>\0`, or `<scope>\0<key>\0` for a key with no
 * value; a key from an `include.path` is reported with the scope of the file
 * that includes it, so an include cannot hide one; the launcher's own `-c`
 * pins report `command`. The values are dropped as they are read: nothing
 * here holds one, so no sentence can print one.
 */

/** A key and the scope it is set at. There is no value field, ever. */
export interface ConfigEntry {
  readonly scope: string
  readonly key: string
}

/** The scopes a clone's author writes: the repository's `.git/config`, and a worktree's. */
const HOSTILE_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree'])

/**
 * Whole sections, on purpose: git adds keys to `http`, `ssh` and `credential`
 * in most releases, and a list of dangerous keys that missed one would let a
 * repository redirect a push. The false positives are `KEPT_LOCAL_KEYS`.
 */
export const REFUSED_SECTIONS: readonly string[] = ['url', 'credential', 'http', 'protocol', 'ssh', 'gpg', 'push']

/** Two-part keys of `core` that run a program for a push, or choose its proxy. */
export const REFUSED_KEYS: readonly string[] = ['core.sshcommand', 'core.askpass', 'core.gitproxy']

/** `remote.<name>.<variable>`: what a remote may run or route through, for any remote's name. */
const REFUSED_REMOTE_VARIABLES: ReadonlySet<string> = new Set(['vcs', 'receivepack', 'uploadpack', 'proxy', 'proxyauthmethod'])

/** Of those, the ones that choose a program rather than a route: a `git-remote-<vcs>` helper, a transport's command. */
const REMOTE_PROGRAMS: ReadonlySet<string> = new Set(['vcs', 'receivepack', 'uploadpack'])

/**
 * The refused sections' harmless two-part keys, with no subsection: a buffer,
 * a timeout, what a push to a remote's NAME does (this build pushes to a
 * URL), and a signing format the push never uses (signing is pinned off).
 */
export const KEPT_LOCAL_KEYS: readonly string[] = [
  'http.postbuffer',
  'http.lowspeedlimit',
  'http.lowspeedtime',
  'push.default',
  'push.autosetupremote',
  'gpg.format',
]

/**
 * Every key of `bytes`, with its scope, in order. A listing whose fields do
 * not pair is not read at all: a key this build cannot see is a key it
 * cannot refuse.
 */
export function parseConfigListing(bytes: Buffer): ConfigEntry[] {
  if (bytes.length === 0) return []
  const fields = bytes.toString('utf8').split('\0')
  // Every entry ends with NUL, so the last field is the empty one after it.
  if (fields.pop() !== '' || fields.length % 2 !== 0) {
    throw new Error('git config --list printed a listing this build does not read')
  }
  const entries: ConfigEntry[] = []
  for (let at = 0; at < fields.length; at += 2) {
    const scope = fields[at] ?? ''
    const line = fields[at + 1] ?? ''
    const end = line.indexOf('\n')
    entries.push({ scope, key: end === -1 ? line : line.slice(0, end) })
  }
  return entries
}

/** `section[.subsection].variable`: the subsection is everything between the first dot and the last. */
interface KeyParts {
  readonly section: string
  readonly subsection: string | undefined
  readonly variable: string
}

const partsOf = (key: string): KeyParts | undefined => {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first <= 0 || last === key.length - 1) return undefined
  return {
    section: key.slice(0, first),
    subsection: first === last ? undefined : key.slice(first + 1, last),
    variable: key.slice(last + 1),
  }
}

/**
 * Would `key` choose where a push goes, who authenticates it, or what runs
 * during it? Compared as git compares.
 *
 * A remote's section counts twice. Its programs and its proxy are refused for
 * any remote. And a section whose name is not a remote's name this build
 * reads is refused whole: git looks the destination of `git push <url>` up as
 * a remote's name before it reads it as a URL (measured, git 2.46), so a
 * hand-written `[remote "git@github.com:acme/iac.git"]` would decide where the
 * push goes, whatever `readRoad` read of the tracked remote. Every push form
 * holds ':', which `isRemoteName` never does; `git remote add` writes no such
 * name, since git's own rule for one refuses ':' too.
 */
const isRefusedKey = (key: string): boolean => {
  const parts = partsOf(key)
  if (parts === undefined) return false
  const section = parts.section.toLowerCase()
  const variable = parts.variable.toLowerCase()
  if (parts.subsection === undefined) {
    const twoPart = `${section}.${variable}`
    if (REFUSED_KEYS.includes(twoPart)) return true
    if (KEPT_LOCAL_KEYS.includes(twoPart)) return false
  }
  if (REFUSED_SECTIONS.includes(section)) return true
  if (section !== 'remote' || parts.subsection === undefined) return false
  return REFUSED_REMOTE_VARIABLES.has(variable) || !isRemoteName(parts.subsection)
}

/** The entries a submission refuses: a refused key at the `local` or `worktree` scope, in the listing's order. */
export function refusedConfigKeys(entries: readonly ConfigEntry[]): ConfigEntry[] {
  return entries.filter((entry) => HOSTILE_SCOPES.has(entry.scope) && isRefusedKey(entry.key))
}

/**
 * A subsection that is a URL, printed only when it is a scheme, a host and a
 * port and nothing else — no user, no path past `/`, no query, no fragment,
 * no escape, no `;` — the shapes a credential never sits in. A path is left
 * out because one can hold a secret, as a webhook's does.
 */
const PRINTABLE_URL = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/?$/

/** The sections whose subsection is a URL. */
const URL_SECTIONS: ReadonlySet<string> = new Set(['url', 'http', 'credential'])

/** A section or variable name as git writes one. */
const isWord = (word: string): boolean => /^[A-Za-z][A-Za-z0-9-]*$/.test(word)

/**
 * `key` as a sentence may print it. A subsection is printed only when it has
 * a shape that cannot carry a credential — a URL of `PRINTABLE_URL`'s shape
 * in the three URL sections, a remote's name elsewhere — and never on the
 * absence of one character: `url.https://x-access-token:<token>@github.com/.insteadof`
 * is one key, and so is `http.https://example.com/?access_token=<token>.extraheader`.
 * Both shapes are ASCII without a control character, so what is printed is
 * what a terminal shows. `whole` is false when part of the key is elided.
 */
const printedKey = (key: string): { readonly text: string; readonly whole: boolean } => {
  const parts = partsOf(key)
  if (parts === undefined || !isWord(parts.section) || !isWord(parts.variable)) {
    return { text: '<a key this build does not print>', whole: false }
  }
  if (parts.subsection === undefined) return { text: key, whole: true }
  const isUrl = URL_SECTIONS.has(parts.section.toLowerCase())
  const printable = isUrl ? PRINTABLE_URL.test(parts.subsection) : isRemoteName(parts.subsection)
  if (printable) return { text: key, whole: true }
  const elided = isUrl ? '<a URL this build does not print>' : '<a name this build does not print>'
  return { text: `${parts.section}.${elided}.${parts.variable}`, whole: false }
}

/**
 * What a key would decide for the person, in the words the refusal uses: by
 * its section, and for a remote by its variable — `vcs`, `receivepack` and
 * `uploadpack` choose a program; a proxy, a URL or any other key of a section
 * named after a URL, a route.
 */
const decides = (key: string): string => {
  const parts = partsOf(key)
  const section = (parts?.section ?? '').toLowerCase()
  if (section === 'credential') return 'who pushes for you'
  if (section === 'remote' && REMOTE_PROGRAMS.has((parts?.variable ?? '').toLowerCase())) {
    return 'what program runs during your push'
  }
  if (section === 'url' || section === 'http' || section === 'protocol' || section === 'remote') {
    return 'where your push goes'
  }
  return 'what program runs during your push'
}

/**
 * The exit-2 sentence for `entry`, and `more` keys of the same kind after it:
 * the key and its scope, what it would decide, and the command that removes
 * it — `--unset-all` naming the key when the key is printed whole, the
 * scope's `--edit` when it is not, so a key holding a token is never printed
 * to be copied.
 */
export function configRefusal(entry: ConfigEntry, more: number): string {
  const key = printedKey(entry.key)
  const scope = entry.scope === 'worktree' ? 'worktree' : 'local'
  const remove = key.whole ? `git config --${scope} --unset-all ${key.text}` : `git config --${scope} --edit`
  const others =
    more > 0 ? ` It sets ${String(more)} more ${more === 1 ? 'key' : 'keys'} of this kind; each is refused the same way.` : ''
  return (
    `this clone's own configuration sets ${key.text} (${scope}), which would decide ${decides(entry.key)}; ` +
    'idpa pushes only with your global git configuration. ' +
    `Remove it with \`${remove}\`, or set it globally, then run this again.${others} Nothing was written.`
  )
}
