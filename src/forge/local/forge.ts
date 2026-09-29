import type { Cleared, Expectation, Repository } from '../../core/plan/clear.js'
import { branchFor, isCleared, SUBMISSION_PREFIX } from '../../core/plan/clear.js'
import { isCataloguePath } from '../../core/paths/catalogue.js'
import { GitError, gitIn, type Git } from '../../process/git.js'
import { ForgeInputError } from '../errors.js'
import type { Base, ForgeProvider, Recognised, Submitted } from '../provider.js'
import { blobId, treeOf, writeTree, type TreeEntry } from './objects.js'

/**
 * The local forge: a submission becomes one new branch in a clone on this
 * machine, cut from `HEAD` through git's plumbing (ADR-0010).
 *
 * It becomes visible at exactly one point — `update-ref <ref> <commit> ""`,
 * whose empty old value means create, and refuse if it exists. Everything
 * before it writes only objects no ref reaches: `hash-object`, `mktree`,
 * `commit-tree`. Nothing is checked out; `HEAD`, the index and the working tree
 * are never written. That is the whole of the atomicity argument, and
 * `tests/invariants/forge.test.ts` checks it by failing every git call of a
 * submission, before it runs and after.
 *
 * Every call goes through `process/git.ts`: no hook and no fsmonitor of the
 * repository runs — a team relying on a `pre-commit` hook reviews the branch
 * in the merge request instead — and no `GIT_*` variable reaches git.
 *
 * Limits, stated rather than closed:
 *   - Working-tree bytes that differ from the `HEAD` blob only through
 *     `core.autocrlf` or a CRLF checkout are refused as divergence: the gates
 *     judged the working tree, the branch is cut from `HEAD`, and the two are
 *     different bytes.
 *   - The preview still reads a file through a symbolic link; the submission
 *     refuses one (B3, after stage 5; D17). A person sees the preview and the
 *     refusal disagree, which is the safe direction.
 *   - The hidden files the gates judged — the `.witness.yml` files and
 *     `.idp-agent.yml` — are not in a clearance's expectation (`Expectation`,
 *     `clear.ts`), so a witness removed between clearance and submission is not
 *     a divergence this can prove; `validate` over the branch still reports it.
 *   - An aborted submission leaves unreachable objects, for `git gc`.
 *   - A symbolic ref at the branch name is refused, and the one write never
 *     follows one (`--no-deref`). One planted between the check and the write
 *     is another matter: git's create-only test reads a DANGLING symbolic ref
 *     as absent (measured, git 2.46), so the branch replaces it. Nothing
 *     outside `idp-agent/` is written either way.
 */

const text = (bytes: Buffer): string => bytes.toString('utf8').trim()
const short = (commit: string): string => commit.slice(0, 7)
const refused = (reason: string): Submitted => ({ outcome: 'refused', reason })

/** The digest half of a branch name: what the forge can recompute from the bytes alone. */
const digestOf = (branch: string): string => branch.slice(branch.lastIndexOf('-') + 1)

/** The mode a written file gets: an executable one stays executable, anything else is regular. */
const modeAfter = (atBase: TreeEntry | undefined): string =>
  atBase?.mode === '100755' ? '100755' : '100644'

/**
 * A forge over a clone on this machine, for ONE repository — the declarations
 * repository or the service's (check §5). It cuts a branch; it opens no merge
 * request — there is nothing here to open one on, and the CLI says so.
 *
 * Opening it is where the arguments are judged, once and before any model: a
 * working tree, at its ROOT — `git -C <dir>` walks upwards, and measured on this
 * very repository, `fixtures/si-demo` answered for idp-agent, so a branch cut
 * there would have been cut in the parent, with paths computed for the child —
 * and an author and a committer identity, which `commit-tree` needs and the
 * scrub of `GIT_AUTHOR_*` and `GIT_COMMITTER_*` leaves to git's configuration —
 * configured, never guessed: the launcher's `user.useConfigOnly=true` makes
 * this probe fail where git would otherwise have made one up from the login
 * and host names (D13). Both, because git configures them apart
 * (`author.*`, `committer.*`): measured, a repository with only `committer.*`
 * passed a committer-only probe and failed at `commit-tree`, after the run.
 */
export async function openLocalForge(
  repo: string,
  repository: Repository,
  git: Git = gitIn(repo),
): Promise<ForgeProvider> {
  const inside = await git(['rev-parse', '--is-inside-work-tree']).catch((error: unknown) => {
    if (error instanceof GitError && error.code === 'ENOENT') {
      throw new ForgeInputError('git is not on PATH; --submit cuts a branch with it')
    }
    throw new ForgeInputError(`${repo} is not a git working tree; --submit needs a clone`)
  })
  if (text(inside) !== 'true') {
    throw new ForgeInputError(`${repo} is not a git working tree; --submit needs a clone`)
  }
  const prefix = text(await git(['rev-parse', '--show-prefix']))
  if (prefix !== '') {
    throw new ForgeInputError(
      repository === 'service'
        ? // D12: `init` previews a service in a subfolder, and its paths would
          // need the folder's prefix on a branch cut at the root — a follow-up.
          `${repo} is the folder ${prefix} of a git repository, not at its root; ` +
            'a service in a subfolder of its repository is not submitted at stage 5 — ' +
            'init without --submit previews it'
        : `${repo} is the folder ${prefix} of a git repository, not at its root; ` +
            '--submit needs the root, or the branch would be cut in someone else’s repository',
    )
  }
  const format = text(await git(['rev-parse', '--show-object-format'])) === 'sha256' ? 'sha256' : 'sha1'
  for (const who of ['author', 'committer'] as const) {
    await git(['var', `GIT_${who.toUpperCase()}_IDENT`]).catch(() => {
      throw new ForgeInputError(
        `git has no ${who} identity here; set user.name and user.email ` +
          '(git config --global user.name …), then run this again',
      )
    })
  }

  const base = async (): Promise<Base> => {
    const head = await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => undefined)
    if (head === undefined) {
      throw new ForgeInputError('HEAD is detached; check out the branch this request is for')
    }
    const branch = text(head).replace(/^refs\/heads\//, '')
    const commit = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => undefined)
    if (commit === undefined) {
      throw new ForgeInputError(`${branch} has no commit yet; a submission is cut from one`)
    }
    return { branch, commit: text(commit) }
  }

  const diverges = async (at: Base, expected: Expectation): Promise<readonly string[]> => {
    const listing = await treeOf(git, at.commit)
    const where = `${at.branch}@${short(at.commit)}`
    const found: string[] = []
    for (const [file, bytes] of expected.files) {
      const entry = listing.get(file)
      if (bytes === undefined) {
        if (entry !== undefined) found.push(`${file} exists at ${where}, and was read as absent`)
        continue
      }
      if (entry === undefined) {
        found.push(`${file} was read but is not in ${where} — uncommitted, untracked or ignored`)
        continue
      }
      // A symlink's blob is its target's NAME; the reader followed it. Refused
      // rather than reasoned about: the gates judged bytes git does not hold.
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        found.push(`${file} is a symbolic link at ${where}; a submission carries files, never links`)
        continue
      }
      if (entry.oid !== blobId(Buffer.from(bytes, 'utf8'), format)) {
        found.push(`${file} differs from ${where} — the gates judged the working tree, not the commit`)
      }
    }
    if (expected.scope === 'catalogue') {
      for (const [file, entry] of listing) {
        if (entry.type === 'blob' && isCataloguePath(file) && !expected.files.has(file)) {
          found.push(`${file} is in ${where} and was never read — the gates did not judge it`)
        }
      }
    }
    return found
  }

  /**
   * The branch as it stands, compared with the change: ours, someone else's, or
   * absent.
   *
   * "Ours" means EXACTLY this change: a branch, not a symbolic ref; one
   * commit, on THE BASE, differing from it at these paths and no others,
   * holding these bytes with the modes this forge gives them, under the
   * message the engine wrote for it. Checking only that our blobs are present was
   * measured wrong: branch names are predictable — they are a hash of the
   * content — so a branch pre-created with our files AND one more passed, and
   * "already submitted" would have put somebody else's file under this user's
   * request. The same holds for a parent carrying an unrelated change (D7): at
   * stage 6 it would travel in this user's merge request. And the message: the
   * subject is the engine's (D18), and at stage 6 it is the merge request's
   * text, so our tree under somebody else's words is not this submission —
   * nor is the same bytes requested in other words, whose commit records a
   * request this run did not make.
   */
  const existing = async (ref: string, change: Cleared, at: Base): Promise<Submitted | undefined> => {
    // First, because `rev-parse` follows one: a symbolic ref at our name —
    // dangling, or naming a branch that holds this very change — is somebody
    // else's, and is neither followed nor claimed.
    const symbolic = await git(['symbolic-ref', '--quiet', ref]).then(
      () => true,
      () => false,
    )
    if (symbolic) {
      return refused(`${change.branch} already exists as a symbolic ref; it is not this submission`)
    }
    const found = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => undefined)
    if (found === undefined) return undefined
    const head = text(found)
    const other = refused(`${change.branch} already exists and carries a different change`)

    const parents = text(await git(['rev-list', '--parents', '-n', '1', head])).split(' ').slice(1)
    const [parent] = parents
    if (parents.length !== 1 || parent === undefined) return other
    if (parent !== at.commit) {
      return refused(
        `${change.branch} already exists on ${short(parent)}, not on ${at.branch}@${short(at.commit)}; ` +
          'it is not this submission',
      )
    }
    const touched = (await git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', parent, head]))
      .toString('utf8')
      .split('\0')
      .filter((line) => line !== '')
      .sort()
    const ours = change.edits.map((edit) => edit.path).sort()
    if (touched.length !== ours.length || touched.some((file, index) => file !== ours[index])) return other

    const before = await treeOf(git, parent)
    const after = await treeOf(git, head)
    const same = change.edits.every((edit) => {
      const entry = after.get(edit.path)
      return (
        entry?.oid === blobId(Buffer.from(edit.after, 'utf8'), format) &&
        entry.mode === modeAfter(before.get(edit.path))
      )
    })
    if (!same) return other

    // A commit object is its headers, a blank line, then the message verbatim.
    const commit = (await git(['cat-file', 'commit', head])).toString('utf8')
    if (commit.slice(commit.indexOf('\n\n') + 2) !== change.message) {
      return refused(
        `${change.branch} already exists with these files under a message idp-agent ` +
          'did not write for this request',
      )
    }
    return { outcome: 'already-submitted', branch: change.branch, commit: head }
  }

  /**
   * First, and before any git call: the value is one `clear.ts` minted (D3) —
   * a spread, a cast or a clone of one is not — and it is for the repository
   * this forge was opened on (check §5). Undefined: it may go on.
   */
  const unfit = (change: Cleared): Submitted | undefined => {
    if (!isCleared(change)) return refused('not a clearance minted by clearPlan or clearService')
    if (change.repository !== repository) {
      return refused(
        `a clearance for the ${change.repository} repository was handed to a forge on the ${repository} repository`,
      )
    }
    return undefined
  }

  /**
   * A second submission answered before a person is asked to confirm it — the
   * owner's report of 2026-09-29: the level question, the diff and `[y/N]`,
   * and only then "already submitted". `existing()` is the whole test, the one
   * `submit` makes, and it only reads: `symbolic-ref`, `rev-parse`,
   * `rev-list`, `diff-tree`, `ls-tree`, `cat-file` — blob ids are computed
   * here, never written. Nothing is claimed for an empty change, whose branch
   * name is the digest of nothing.
   */
  const recognise = async (
    change: Cleared,
    at: Base,
  ): Promise<Recognised | undefined> => {
    const wrong = unfit(change)
    if (wrong?.outcome === 'refused') return wrong
    if (change.edits.length === 0) return undefined
    const found = await existing(`refs/heads/${change.branch}`, change, at)
    if (found?.outcome === 'already-submitted' || found?.outcome === 'refused') return found
    return undefined
  }

  const submit = async (change: Cleared, at: Base): Promise<Submitted> => {
    const wrong = unfit(change)
    if (wrong !== undefined) return wrong
    // §4.4: check the repository again at the moment of writing. A HEAD that
    // became detached or unborn DURING the run is not an argument the user
    // typed wrong — it is the repository moving — so it is a refusal (exit 1),
    // never the ForgeInputError `base()` throws when the run starts (exit 2).
    const now = await base().catch((error: unknown) => {
      if (error instanceof ForgeInputError) return error
      throw error
    })
    if (now instanceof ForgeInputError) return refused(`${at.branch} changed during the run: ${now.message}`)
    if (now.branch !== at.branch || now.commit !== at.commit) {
      return refused(
        `${at.branch} moved from ${short(at.commit)} to ${now.branch}@${short(now.commit)} ` +
          'since the plan was read; run it again',
      )
    }
    const divergent = await diverges(at, change.expected)
    if (divergent.length > 0) {
      return refused(`the repository is not what the gates judged:\n  ${divergent.join('\n  ')}`)
    }
    // An empty clearance names the same branch for every plan — the digest of
    // nothing — so it must never reach a ref: the repository already says it.
    if (change.edits.length === 0) return { outcome: 'unchanged' }

    // The engine computed this name; checked anyway, where the write happens —
    // its namespace, and its digest recomputed from the bytes, never trusted.
    const ref = `refs/heads/${change.branch}`
    if (!change.branch.startsWith(SUBMISSION_PREFIX)) {
      return refused(`${change.branch} is outside ${SUBMISSION_PREFIX}; a submission creates nothing else`)
    }
    if (digestOf(branchFor(change.edits)) !== digestOf(change.branch)) {
      return refused(`${change.branch} does not name these bytes`)
    }
    const valid = await git(['check-ref-format', ref]).then(
      () => true,
      () => false,
    )
    if (!valid) return refused(`${change.branch} is not a name git accepts`)

    const already = await existing(ref, change, at)
    if (already !== undefined) return already

    const blobs = new Map<string, string>()
    for (const edit of change.edits) {
      // `--no-filters`: the bytes the preview showed, not what a clean filter
      // or `core.autocrlf` of this repository would make of them.
      blobs.set(
        edit.path,
        text(await git(['hash-object', '-w', '--stdin', '--no-filters'], Buffer.from(edit.after, 'utf8'))),
      )
    }
    const tree = await writeTree(git, text(await git(['rev-parse', `${at.commit}^{tree}`])), blobs)
    const commit = text(
      await git(['commit-tree', tree, '-p', at.commit, '-F', '-'], Buffer.from(change.message, 'utf8')),
    )

    try {
      // The one visible act. `""` as the old value: create, and refuse if it
      // exists — so this can never move a ref, main included. `--no-deref`: a
      // symbolic ref planted at our name after `existing()` looked must not
      // aim this write at its target (measured: without it, a dangling one
      // made this create `refs/heads/release`).
      await git(['update-ref', '--no-deref', '-m', 'idp-agent: submitted for review', ref, commit, ''])
    } catch (error) {
      // Either somebody created the ref between our check and our write, or
      // the ref is ours and something failed after git made it — the
      // atomicity property found the second: a failure just after a
      // successful `update-ref` was reported "already submitted" by the very
      // call that submitted it. Ours is the commit we just built.
      const raced = await existing(ref, change, at)
      if (raced?.outcome === 'already-submitted' && raced.commit === commit) {
        return { outcome: 'created', branch: change.branch, commit }
      }
      if (raced !== undefined) return raced
      throw error
    }
    return { outcome: 'created', branch: change.branch, commit }
  }

  return { name: 'local', repository, base, diverges, recognise, submit }
}
