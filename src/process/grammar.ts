/**
 * The values both launchers hold an argument to (stage 6 brief § 6, § 13): an
 * object id, a submission's branch, a branch name. One module, because the git
 * launcher and the gh launcher check the same names — a base is read from the
 * clone's configuration and then addressed on GitHub — and neither may import
 * the other (only `context/project-fs`, `context/discovery/read.ts` and
 * `forge/` load `git.ts`). It starts nothing and imports nothing.
 *
 * The engine's own judgement will hold the same grammars in
 * `core/github/remote.ts` (stage 6 plan, Task 6.1.2, "Two copies of the
 * grammars"): this leaf imports nothing of ours, and a test will hold the two
 * copies to one answer.
 */

/** A commit, tree or blob id: SHA-1 or SHA-256, lower case, whole. */
export const isHex = (word: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(word)

/**
 * A submission's branch, bare: what `branchFor` writes — `[a-z0-9]` runs
 * joined by `-`, then `-` and eight hex — under `idp-agent/`.
 */
export const SUBMISSION_BRANCH = /^idp-agent\/[a-z0-9-]+-[0-9a-f]{8}$/

/** The same, as the ref it is under `refs/heads/`: the only ref a launcher writes, locally or on GitHub. */
export const SUBMISSION_REF = /^refs\/heads\/idp-agent\/[a-z0-9-]+-[0-9a-f]{8}$/

/**
 * A branch name a launcher hands git, or gh a path of: what
 * `git check-ref-format --branch` accepts, narrowed. 1 to 255 bytes, not
 * starting with `-` or `.`; no control character, no format character (the
 * bidi overrides and isolates, the zero-width marks among them), no white
 * space, none of `~ ^ : ? * [ \ { } %`; no `..`, `@{`, `//`, `/.`, no component
 * ending in `.lock`, not ending in `/` or `.`, never `@` alone.
 *
 * Narrowed where git is not: git accepts a bidi override in a branch name, and
 * a hostile `branch.<name>.merge` would otherwise carry one past `inertLine`,
 * which cleans only the terminal, into a pull request's base; `%` would be read
 * as an escape in a gh path; `{` and `}` are gh's placeholders. White space is
 * refused whatever its kind, not only the space git refuses.
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
