import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import {
  isDeclarationsRepository,
  readRepository,
} from '../../src/context/iac-fs/snapshot.js'

/**
 * Whether the directory the user is standing in is a declarations repository,
 * which is what `ask`, `graph` and `show` read when no `--repo` says otherwise.
 * By markers at its root only: a run from $HOME must not become a scan of it.
 */

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'declarations-'))

/** Files under `root`, each created with its folders. */
const lay = async (root: string, files: readonly string[]): Promise<void> => {
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), '', 'utf8')
  }
}

describe('isDeclarationsRepository', () => {
  it('recognises the layout init platform writes', async () => {
    const root = await temp()
    await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0' })
    expect(await isDeclarationsRepository(root)).toBe(true)
  })

  it.each([
    ['a witnessed folder under catalog/', ['catalog/databases/.witness.yml']],
    ['a witnessed folder under dependencies/ alone', ['dependencies/access/.witness.yml']],
  ])('recognises %s', async (_, files) => {
    const root = await temp()
    await lay(root, files)
    expect(await isDeclarationsRepository(root)).toBe(true)
  })

  it.each([
    ['an empty directory', []],
    [
      'an application repository, which declares itself in catalog-info.yaml',
      ['catalog-info.yaml', 'package.json', 'src/index.ts', '.github/workflows/ci.yml'],
    ],
    ['a folder of YAML with no layout', ['notes.yml', 'docs/index.md', 'config/app.yaml']],
    ['a catalog/ whose folders hold no witness', ['catalog/databases/orders-db.yml']],
    ['a witness in catalog/ itself rather than in a folder of it', ['catalog/.witness.yml']],
    ['a witness two folders down', ['catalog/databases/legacy/.witness.yml']],
    ['a catalog/ that is a file', ['catalog']],
    // What $HOME looks like with the repository cloned into it: recognising
    // this would mean walking the tree, and the read would then be of $HOME.
    ['a declarations repository one folder down', ['IaC/catalog/databases/.witness.yml']],
  ])('does not take %s for one', async (_, files) => {
    const root = await temp()
    await lay(root, files)
    expect(await isDeclarationsRepository(root)).toBe(false)
  })

  it('does not take a .witness.yml that is a directory for a witness', async () => {
    const root = await temp()
    await mkdir(path.join(root, 'catalog', 'databases', '.witness.yml'), { recursive: true })
    expect(await isDeclarationsRepository(root)).toBe(false)
  })

  it('answers no, rather than throwing, for a path that is not there', async () => {
    expect(await isDeclarationsRepository(path.join(await temp(), 'nowhere'))).toBe(false)
  })

  // Root ignores permissions, so the case cannot be built under it.
  it.skipIf(process.getuid?.() === 0)(
    'does not take a root it can search but not list for one, because the reader cannot list it',
    async () => {
      // Said yes to, this would announce a repository over a read of nothing:
      // `readRepository` lists the root, and a failed listing reads as empty.
      const root = await temp()
      await lay(root, ['catalog/databases/.witness.yml'])
      await chmod(root, 0o311)
      try {
        expect(await isDeclarationsRepository(root)).toBe(false)
        expect((await readRepository(root)).witnesses).toEqual([])
      } finally {
        await chmod(root, 0o755)
      }
    },
  )

  it('does not follow a catalog/ that is a symbolic link, because the reader does not', async () => {
    // Said yes to, this would print "reading the declarations repository"
    // over a read of nothing: `readRepository` walks directories as readdir
    // reports them and does not descend into a link.
    const target = await temp()
    await lay(target, ['databases/.witness.yml'])
    const root = await temp()
    await symlink(target, path.join(root, 'catalog'), 'dir')

    expect(await isDeclarationsRepository(root)).toBe(false)
    expect((await readRepository(root)).witnesses).toEqual([])
  })
})
