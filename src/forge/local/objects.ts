import { createHash } from 'node:crypto'
import type { Git } from '../../process/git.js'

/**
 * Reading and writing git objects, and never a ref. Nothing here is visible to
 * a person: an object no ref reaches is garbage `git gc` collects, which is the
 * whole of why a submission is atomic.
 */

export interface TreeEntry {
  readonly mode: string
  readonly type: string
  readonly oid: string
}

/**
 * A blob's id computed here rather than asked of git, one call instead of one
 * per file. Measured equal to `git hash-object` for sha1; sha256 repositories
 * hash the same header with the other function.
 */
export function blobId(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex')
}

/** One `ls-tree -z` line: `<mode> <type> <oid>\t<name>`, the name taken whole. */
const entryOf = (line: string): { readonly name: string; readonly entry: TreeEntry } => {
  const tab = line.indexOf('\t')
  const [mode = '', type = '', oid = ''] = line.slice(0, tab).split(' ')
  return { name: line.slice(tab + 1), entry: { mode, type, oid } }
}

/** Every blob of a commit, path → entry, from one `ls-tree -r -z`. */
export async function treeOf(git: Git, commit: string): Promise<Map<string, TreeEntry>> {
  const listing = (await git(['ls-tree', '-r', '-z', '--full-tree', commit])).toString('utf8')
  const entries = new Map<string, TreeEntry>()
  for (const line of listing.split('\0')) {
    if (line === '') continue
    const { name, entry } = entryOf(line)
    entries.set(name, entry)
  }
  return entries
}

/**
 * The tree `tree` becomes once each path in `blobs` holds that blob. Built
 * with `mktree`, level by level, so no index is written — not the user's, not
 * a temporary one — and the only side effect is objects.
 *
 * An existing file keeps its mode; a new one is `100644`. A path whose folder
 * is a FILE at the base, or a file that is a FOLDER there, cannot be written,
 * and says so: the gates never judged such a repository.
 */
export async function writeTree(
  git: Git,
  tree: string | undefined,
  blobs: ReadonlyMap<string, string>,
): Promise<string> {
  const entries = new Map<string, TreeEntry>()
  if (tree !== undefined) {
    for (const line of (await git(['ls-tree', '-z', tree])).toString('utf8').split('\0')) {
      if (line === '') continue
      const { name, entry } = entryOf(line)
      entries.set(name, entry)
    }
  }

  const here = new Map<string, string>()
  const below = new Map<string, Map<string, string>>()
  for (const [file, blob] of blobs) {
    const slash = file.indexOf('/')
    if (slash === -1) {
      here.set(file, blob)
      continue
    }
    const folder = file.slice(0, slash)
    const rest = below.get(folder) ?? new Map<string, string>()
    rest.set(file.slice(slash + 1), blob)
    below.set(folder, rest)
  }

  for (const [name, oid] of here) {
    const existing = entries.get(name)
    if (existing !== undefined && existing.type !== 'blob') {
      throw new Error(`${name} is a folder at the base, not a file`)
    }
    // An executable file stays executable; anything else — a new file, and a
    // symlink, which `diverges` has already refused — becomes a regular one.
    const mode = existing?.mode === '100755' ? '100755' : '100644'
    entries.set(name, { mode, type: 'blob', oid })
  }
  for (const [folder, rest] of below) {
    const existing = entries.get(folder)
    if (existing !== undefined && existing.type !== 'tree') {
      throw new Error(`${folder} is a file at the base, not a folder`)
    }
    entries.set(folder, { mode: '040000', type: 'tree', oid: await writeTree(git, existing?.oid, rest) })
  }

  // mktree normalises the order itself (measured): no sort needed here.
  const input = [...entries].map(([name, one]) => `${one.mode} ${one.type} ${one.oid}\t${name}\0`).join('')
  return (await git(['mktree', '-z'], Buffer.from(input, 'utf8'))).toString('utf8').trim()
}
