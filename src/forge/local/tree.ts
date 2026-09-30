import type { FileEdit } from '../../core/diff/unified.js'
import type { Git } from '../../process/git.js'
import { blobId, buildTree, treeId } from './objects.js'

/**
 * The tree a change would have on `parent`, computed and never written (stage
 * 6 brief § 4, "Comparing trees without writing one"): what recognition
 * compares a commit GitHub holds with, when this clone never made that commit
 * — another clone pushed it, or the local branch was deleted — and what an
 * older base's branch is judged by (§ 14).
 *
 * `writeTree`'s own walk (`buildTree`), with each blob id computed by
 * `blobId` and each level by `treeId` instead of `hash-object -w` and
 * `mktree`: it reads the parent's trees with the `rev-parse` and `ls-tree`
 * shapes the local forge already runs, so the git grammar gains nothing, and
 * a recognition that writes nothing stays one. The same refusals as
 * `writeTree`, in the same words.
 */
export async function treeFor(
  git: Git,
  parent: string,
  edits: readonly FileEdit[],
  format: 'sha1' | 'sha256',
): Promise<string> {
  const root = (await git(['rev-parse', `${parent}^{tree}`])).toString('utf8').trim()
  const blobs = new Map(edits.map((edit) => [edit.path, blobId(Buffer.from(edit.after, 'utf8'), format)]))
  return buildTree(git, root, blobs, async (entries) => treeId(entries, format))
}
