import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNew,
  followInside,
  LinkRefused,
  makeFolders,
  openNew,
  openToRead,
  realRootOf,
} from '../../src/confine/confine.js'

/**
 * The one primitive every reader and writer of a user's repository confines a
 * path with: lstat, realpath, and `O_NOFOLLOW` (batch B3). The writers and the
 * readers have their own tests over whole repositories; this file holds the
 * cases only the primitive can stage — a link planted between the check and
 * the open, which no caller leaves a seam for.
 *
 * Real directories and real links: a link is only a link on a disk. Windows
 * gives a symbolic link to an administrator or to developer mode alone, so
 * the runner may not be able to make one; every case is skipped there, by
 * this condition, rather than failing on the setup.
 */
/**
 * A seam into the call `makeFolders` asks the disk with before it makes a
 * name: `lstat`, passed through untouched unless a case sets `after`, which
 * runs once the real answer is in, found or not — the instant between a
 * folder checked and the next one made, when the checked one can be swapped.
 */
const race = vi.hoisted(() => ({ after: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      try {
        return await real.lstat(...args)
      } finally {
        const after = race.after
        if (after !== undefined) await after(String(args[0]))
      }
    },
  }
})
afterEach(() => {
  race.after = undefined
})

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-confine-'))

const refusedAt = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(LinkRefused)
  return (error as LinkRefused).path
}

describe.skipIf(process.platform === 'win32')('confine', () => {
  describe('openToRead', () => {
    it('reads a regular file inside the root', async () => {
      const root = await realRootOf(await temp())
      await writeFile(path.join(root, 'a.yml'), 'kind: Resource\n')
      const handle = await openToRead(root, path.join(root, 'a.yml'))
      try {
        expect(await handle.readFile('utf8')).toBe('kind: Resource\n')
      } finally {
        await handle.close()
      }
    })

    it('opens a pipe at once with nonBlocking, a descriptor its caller asks and refuses, and reads a file the same', async () => {
      const root = await realRootOf(await temp())
      execFileSync('mkfifo', [path.join(root, 'pipe')])
      const opened = await Promise.race([
        openToRead(root, path.join(root, 'pipe'), { nonBlocking: true }),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 1000)),
      ])
      if (opened === 'waiting') throw new Error('the open waited for a writer')
      try {
        const stats = await opened.stat()
        expect(stats.isFIFO()).toBe(true)
        expect(stats.isFile()).toBe(false)
      } finally {
        await opened.close()
      }

      await writeFile(path.join(root, 'a.yml'), 'kind: Resource\n')
      const handle = await openToRead(root, path.join(root, 'a.yml'), { nonBlocking: true })
      try {
        expect(await handle.readFile('utf8')).toBe('kind: Resource\n')
      } finally {
        await handle.close()
      }
    })

    it('refuses a file swapped for a link after it was decided on', async () => {
      // The walk saw a regular file; by the open it is a link to a secret.
      const outside = await temp()
      await writeFile(path.join(outside, 'secret'), 'SUPER_SECRET_VALUE')
      const root = await realRootOf(await temp())
      const file = path.join(root, 'a.yml')
      await writeFile(file, 'kind: Resource\n')

      await rename(file, path.join(root, 'moved.yml'))
      await symlink(path.join(outside, 'secret'), file)

      expect(await refusedAt(openToRead(root, file))).toBe('a.yml')
    })

    it('refuses a file whose folder was swapped for a link outside after it was decided on', async () => {
      // O_NOFOLLOW guards the last name only; the folder above is checked
      // once the descriptor is open, against where the file really is.
      const outside = await temp()
      await writeFile(path.join(outside, 'a.yml'), 'SUPER_SECRET_VALUE')
      const root = await realRootOf(await temp())
      await mkdir(path.join(root, 'catalog'))
      await writeFile(path.join(root, 'catalog/a.yml'), 'kind: Resource\n')

      await rename(path.join(root, 'catalog'), path.join(root, 'moved'))
      await symlink(outside, path.join(root, 'catalog'))

      expect(await refusedAt(openToRead(root, path.join(root, 'catalog/a.yml')))).toBe('catalog/a.yml')
    })

    it('refuses a file whose folder was swapped for a link inside the root after it was decided on', async () => {
      // Resolved, the link leads inside, and the name there is the file that
      // was opened: both of those hold, and the file is still another one's
      // bytes under the path the walk listed. A folder that is a link is
      // refused wherever it leads.
      const root = await realRootOf(await temp())
      await mkdir(path.join(root, 'catalog/databases'), { recursive: true })
      await mkdir(path.join(root, 'catalog/other'))
      await writeFile(path.join(root, 'catalog/databases/a.yml'), 'REAL')
      await writeFile(path.join(root, 'catalog/other/a.yml'), 'OTHER')

      await rename(path.join(root, 'catalog/databases'), path.join(root, 'moved'))
      await symlink(path.join(root, 'catalog/other'), path.join(root, 'catalog/databases'))

      expect(await refusedAt(openToRead(root, path.join(root, 'catalog/databases/a.yml')))).toBe(
        'catalog/databases/a.yml',
      )
    })
  })

  describe('followInside', () => {
    it('says where a link leads, and never past the root', async () => {
      const outside = await temp()
      await writeFile(path.join(outside, 'secret'), 'x')
      const root = await realRootOf(await temp())
      await writeFile(path.join(root, 'real'), 'x')
      await symlink(path.join(root, 'real'), path.join(root, 'inside'))
      await symlink(path.join(outside, 'secret'), path.join(root, 'outside'))
      await symlink(path.join(root, 'gone'), path.join(root, 'dangling'))

      expect(await followInside(root, path.join(root, 'inside'))).toMatchObject({
        outcome: 'inside',
        real: path.join(root, 'real'),
      })
      expect(await followInside(root, path.join(root, 'outside'))).toEqual({ outcome: 'outside' })
      expect(await followInside(root, path.join(root, 'dangling'))).toEqual({ outcome: 'nowhere' })
    })
  })

  describe('makeFolders', () => {
    it('makes every folder that is missing, one at a time', async () => {
      const root = await realRootOf(await temp())
      await makeFolders(root, 'catalog/databases')
      expect(await readdir(path.join(root, 'catalog'))).toEqual(['databases'])
    })

    it('refuses a link on the way, inside, outside or dangling, and makes nothing through it', async () => {
      const outside = await temp()
      const root = await realRootOf(await temp())
      await mkdir(path.join(root, 'real'))
      await symlink(outside, path.join(root, 'out'))
      await symlink(path.join(root, 'real'), path.join(root, 'in'))
      await symlink(path.join(outside, 'gone'), path.join(root, 'dangling'))

      expect(await refusedAt(makeFolders(root, 'out/x'))).toBe('out')
      expect(await refusedAt(makeFolders(root, 'in/x'))).toBe('in')
      expect(await refusedAt(makeFolders(root, 'dangling/x'))).toBe('dangling')
      expect(await readdir(outside)).toEqual([])
      expect(await readdir(path.join(root, 'real'))).toEqual([])
    })

    it.each(['outside', 'inside'])(
      'refuses a folder swapped for a link %s between two names, and leaves at most the one folder made in that instant',
      async (where) => {
        // `catalog` is checked; `catalog/databases` is found missing; then
        // `catalog` is swapped, and `catalog/databases` is made through it —
        // `mkdir` follows every name above the last. Each name down to the one
        // just made is asked again, so the refusal comes before a deeper
        // folder or a file goes where the link leads.
        const root = await realRootOf(await temp())
        const led = where === 'outside' ? await temp() : path.join(root, 'elsewhere')
        await mkdir(led, { recursive: true })
        await mkdir(path.join(root, 'catalog'))
        race.after = async (asked) => {
          if (asked !== path.join(root, 'catalog/databases')) return
          race.after = undefined
          await rename(path.join(root, 'catalog'), path.join(root, 'moved'))
          await symlink(led, path.join(root, 'catalog'))
        }

        expect(await refusedAt(createNew(root, 'catalog/databases/team/a.yml', 'x'))).toBe('catalog')
        expect(await readdir(led, { recursive: true })).toEqual(['databases'])
      },
    )
  })

  describe('the modes it makes', () => {
    /** Under a umask of 022, the one a person's shell usually has: the mode asked is the mode made. */
    const underUmask = async <T>(run: () => Promise<T>): Promise<T> => {
      const before = process.umask(0o022)
      try {
        return await run()
      } finally {
        process.umask(before)
      }
    }

    it('makes folders 0700 and a new file 0600 when asked, under a umask of 022', async () => {
      const root = await realRootOf(await temp())
      await underUmask(async () => {
        await makeFolders(root, 'a/b', { mode: 0o700 })
        const handle = await openNew(root, 'a/b/f', { mode: 0o600 })
        await handle?.close()
      })
      expect((await lstat(path.join(root, 'a'))).mode & 0o777).toBe(0o700)
      expect((await lstat(path.join(root, 'a/b'))).mode & 0o777).toBe(0o700)
      expect((await lstat(path.join(root, 'a/b/f'))).mode & 0o777).toBe(0o600)
    })

    it('keeps what makeFolders and openNew make with no option, as init platform relies on', async () => {
      const root = await realRootOf(await temp())
      await underUmask(async () => {
        await makeFolders(root, 'a/b')
        const handle = await openNew(root, 'a/b/f')
        await handle?.close()
      })
      expect((await lstat(path.join(root, 'a'))).mode & 0o777).toBe(0o755)
      expect((await lstat(path.join(root, 'a/b/f'))).mode & 0o777).toBe(0o644)
    })
  })

  describe('createNew', () => {
    it('creates a file, and keeps one that is already there', async () => {
      const root = await realRootOf(await temp())
      expect(await createNew(root, 'a.yml', 'first\n')).toBe(true)
      expect(await createNew(root, 'a.yml', 'second\n')).toBe(false)
      expect(await readFile(path.join(root, 'a.yml'), 'utf8')).toBe('first\n')
    })

    it('refuses a folder on the way that is a link', async () => {
      const outside = await temp()
      const root = await realRootOf(await temp())
      await symlink(outside, path.join(root, 'catalog'))
      expect(await refusedAt(createNew(root, 'catalog/a.yml', 'x'))).toBe('catalog')
      expect(await readdir(outside)).toEqual([])
    })
  })

  describe('openNew', () => {
    it('keeps a link planted where the file goes after the folders were checked, and follows it nowhere', async () => {
      // O_CREAT | O_EXCL | O_NOFOLLOW: the open neither follows the link nor
      // creates what it names; the link is kept as a file would be.
      const outside = await temp()
      await writeFile(path.join(outside, 'owners'), '* @outside/team\n')
      const root = await realRootOf(await temp())
      await makeFolders(root, 'catalog')

      await symlink(path.join(outside, 'owners'), path.join(root, 'catalog/a.yml'))
      await symlink(path.join(outside, 'planted'), path.join(root, 'catalog/b.yml'))

      expect(await openNew(root, 'catalog/a.yml')).toBeUndefined()
      expect(await openNew(root, 'catalog/b.yml')).toBeUndefined()
      expect(await readFile(path.join(outside, 'owners'), 'utf8')).toBe('* @outside/team\n')
      expect(await readdir(outside)).toEqual(['owners'])
    })

    it('refuses a folder swapped for a link after it was checked, before a byte is written', async () => {
      // The open cannot be told not to follow a folder above the last name,
      // so the descriptor is checked against where the file really is, and
      // refused before anything is written through it. What the open itself
      // made is an empty file, named in the refusal (SECURITY.md).
      const outside = await temp()
      const root = await realRootOf(await temp())
      await makeFolders(root, 'catalog')

      await rename(path.join(root, 'catalog'), path.join(root, 'moved'))
      await symlink(outside, path.join(root, 'catalog'))

      expect(await refusedAt(openNew(root, 'catalog/a.yml'))).toBe('catalog/a.yml')
      const planted = await readdir(outside)
      for (const name of planted) expect(await readFile(path.join(outside, name), 'utf8')).toBe('')
    })

    it('refuses a folder swapped for a link inside the root after it was checked, before a byte is written', async () => {
      const root = await realRootOf(await temp())
      await makeFolders(root, 'catalog/databases')
      await makeFolders(root, 'elsewhere')

      await rename(path.join(root, 'catalog/databases'), path.join(root, 'moved'))
      await symlink(path.join(root, 'elsewhere'), path.join(root, 'catalog/databases'))

      expect(await refusedAt(openNew(root, 'catalog/databases/.witness.yml'))).toBe(
        'catalog/databases/.witness.yml',
      )
      const planted = await readdir(path.join(root, 'elsewhere'))
      for (const name of planted) {
        expect(await readFile(path.join(root, 'elsewhere', name), 'utf8')).toBe('')
      }
    })
  })
})
