import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ScaffoldWriteError, writeScaffold } from '../../src/scaffold/write.js'
import { scaffoldLayout } from '../../src/scaffold/layout.js'
import { loadTemplates } from '../../src/scaffold/templates.js'
import type { FileIO } from '../../src/scaffold/write.js'

const files = async () =>
  scaffoldLayout(
    { owner: '@acme/platform', version: '0.1.0-rc.2', repository: 'iac' },
    await loadTemplates(),
  )

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-scaffold-'))

describe('writeScaffold', () => {
  it('writes every file and reports them', async () => {
    const root = await temp()
    const report = await writeScaffold(root, await files())
    expect(report.written).toHaveLength(13)
    expect(report.kept).toEqual([])
    expect(await readFile(path.join(root, 'CODEOWNERS'), 'utf8')).toContain('@acme/platform')
  })

  it('writes nothing the second time, and does not raise', async () => {
    // Absent means already done (design 4.3): a branch may be replayed, and a
    // scaffolder that fails on a re-run is one nobody runs twice.
    const root = await temp()
    await writeScaffold(root, await files())
    const again = await writeScaffold(root, await files())
    expect(again.written).toEqual([])
    expect(again.kept).toHaveLength(13)
  })

  it('leaves a hand-edited file byte for byte', async () => {
    // The one that matters. Someone will edit CODEOWNERS the day after
    // scaffolding, and re-running must not silently undo it.
    const root = await temp()
    await writeScaffold(root, await files())
    const mine = '* @someone/else\n# my edit\n'
    await writeFile(path.join(root, 'CODEOWNERS'), mine)
    await writeScaffold(root, await files())
    expect(await readFile(path.join(root, 'CODEOWNERS'), 'utf8')).toBe(mine)
  })

  it('creates the nested folders it needs', async () => {
    const root = await temp()
    await writeScaffold(root, await files())
    expect(await readFile(path.join(root, '.github/workflows/validate.yml'), 'utf8')).toContain(
      'validate',
    )
  })

  it('reports only what it genuinely wrote when a write fails', async () => {
    // Injected, so the suite never needs a read-only filesystem.
    const root = await temp()
    const written: string[] = []
    const failing: FileIO = {
      mkdir: async () => {},
      writeNew: async (file) => {
        if (file.endsWith('CODEOWNERS')) throw new Error('disk full')
        written.push(file)
        return true
      },
    }
    await expect(writeScaffold(root, await files(), failing)).rejects.toThrow(/CODEOWNERS/)
    expect(written.some((file) => file.endsWith('CODEOWNERS'))).toBe(false)
  })

  it('says what it wrote and kept before the file it could not write', async () => {
    // A failure part-way used to lose the list: the error named the file that
    // failed and nothing of the ones already on disk, so `init platform` could
    // not say what it had left behind (gap-stage5-readiness-7).
    const root = await temp()
    const failing: FileIO = {
      mkdir: async () => {},
      writeNew: async (file) => {
        if (file.endsWith('CODEOWNERS')) throw new Error('disk full')
        return !file.endsWith('plan.schema.json')
      },
    }

    const error = await writeScaffold(root, await files(), failing).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(ScaffoldWriteError)
    if (!(error instanceof ScaffoldWriteError)) return
    expect(error.failed).toBe('CODEOWNERS')
    expect(error.message).toContain('disk full')
    expect(error.written).toContain('.github/workflows/validate.yml')
    expect(error.written).not.toContain('CODEOWNERS')
    expect(error.kept).toEqual(['schemas/plan.schema.json'])
    // Nothing after the failure was attempted, so nothing after it is listed.
    expect(error.written).not.toContain('README.md')
  })

  it('reports a folder it could not create the same way', async () => {
    const root = await temp()
    const failing: FileIO = {
      mkdir: async (directory) => {
        if (directory.endsWith('workflows')) throw new Error('not a directory')
      },
      writeNew: async () => true,
    }

    const error = await writeScaffold(root, await files(), failing).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(ScaffoldWriteError)
    if (!(error instanceof ScaffoldWriteError)) return
    expect(error.failed).toBe('.github/workflows/validate.yml')
    expect(error.written).toContain('schemas/plan.schema.json')
  })

  it('refuses a file that would land outside the root', async () => {
    const root = await temp()
    await expect(
      writeScaffold(root, [{ path: '../escaped.yml', content: 'x' }]),
    ).rejects.toThrow()
  })

  it('does not delete anything that was already there', async () => {
    const root = await temp()
    await mkdir(path.join(root, 'catalog/databases'), { recursive: true })
    await writeFile(path.join(root, 'catalog/databases/mine.yml'), 'keep me\n')
    await writeScaffold(root, await files())
    expect(await readFile(path.join(root, 'catalog/databases/mine.yml'), 'utf8')).toBe('keep me\n')
  })
})

/**
 * Real directories and real links, as `project-fs.test.ts` stages them: a link
 * is only a link on a disk. Windows gives a symbolic link to an administrator
 * or to developer mode alone, so the runner may not be able to make one; these
 * cases are skipped there, by this condition, rather than failing on the setup.
 */
const LINKS = process.platform !== 'win32'

describe.skipIf(!LINKS)('writeScaffold, over symbolic links (runtime-probe-11, core-yaml-5)', () => {
  /** What `dir` holds, every path under it, so "nothing landed there" is a comparison. */
  const listing = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { recursive: true })).map(String).sort()

  const refusal = async (root: string): Promise<ScaffoldWriteError> => {
    const error = await writeScaffold(root, await files()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ScaffoldWriteError)
    return error as ScaffoldWriteError
  }

  it('never writes through a folder linked outside the root', async () => {
    // The review's probe: `catalog -> ../outside` put three witnesses outside.
    const outside = await temp()
    const root = await temp()
    await symlink(outside, path.join(root, 'dependencies'))

    const error = await refusal(root)

    expect(error.failed).toBe('dependencies/access/.witness.yml')
    expect(error.message).toContain('dependencies is a symbolic link')
    expect(await listing(outside)).toEqual([])
    // Nothing is undone: what came before the link is written, and said.
    expect(error.written).toContain('catalog/databases/.witness.yml')
  })

  it('never writes through a folder linked inside the root either', async () => {
    // Inside is no excuse: the file a reviewer is shown lands at another path.
    const root = await temp()
    await mkdir(path.join(root, 'elsewhere'))
    await symlink(path.join(root, 'elsewhere'), path.join(root, 'catalog'))

    const error = await refusal(root)

    expect(error.message).toContain('catalog is a symbolic link')
    expect(await listing(path.join(root, 'elsewhere'))).toEqual([])
  })

  it('never writes through a linked folder deeper down', async () => {
    const outside = await temp()
    const root = await temp()
    await mkdir(path.join(root, '.github'))
    await symlink(outside, path.join(root, '.github/workflows'))

    const error = await refusal(root)

    expect(error.failed).toBe('.github/workflows/validate.yml')
    expect(error.message).toContain('.github/workflows is a symbolic link')
    expect(await listing(outside)).toEqual([])
  })

  it('never creates the folder a dangling link names', async () => {
    // `mkdir -p` through the link made the folder it led to, outside.
    const outside = await temp()
    const root = await temp()
    await mkdir(path.join(root, 'catalog'))
    await symlink(path.join(outside, 'gone'), path.join(root, 'catalog/databases'))

    const error = await refusal(root)

    expect(error.failed).toBe('catalog/databases/.witness.yml')
    expect(error.message).toContain('catalog/databases is a symbolic link')
    expect(await listing(outside)).toEqual([])
  })

  it('keeps a file that is a link, and writes nothing through it', async () => {
    // `wx` never followed one and still does not: a link where a file goes is
    // kept as a hand-edited file is, and `init platform` says a kept
    // registration is not a regular file (init-command.test.ts).
    const outside = await temp()
    await writeFile(path.join(outside, 'owners'), '* @outside/team\n')
    const root = await temp()
    await symlink(path.join(outside, 'owners'), path.join(root, 'CODEOWNERS'))

    const report = await writeScaffold(root, await files())

    expect(report.kept).toEqual(['CODEOWNERS'])
    expect(await readFile(path.join(outside, 'owners'), 'utf8')).toBe('* @outside/team\n')
  })

  it('keeps a dangling link where a file goes, and creates nothing at its target', async () => {
    const outside = await temp()
    const root = await temp()
    await symlink(path.join(outside, 'planted'), path.join(root, 'CODEOWNERS'))

    const report = await writeScaffold(root, await files())

    expect(report.kept).toEqual(['CODEOWNERS'])
    expect(await listing(outside)).toEqual([])
  })

  it('writes into the directory it was named, when that name is itself a link', async () => {
    // The user chose that directory, by whatever path; below it, nothing is
    // followed. A temporary directory on macOS is reached through /var, a link.
    const target = await temp()
    const holder = await temp()
    await symlink(target, path.join(holder, 'repo'))

    const report = await writeScaffold(path.join(holder, 'repo'), await files())

    expect(report.written).toHaveLength(13)
    expect(await readFile(path.join(target, 'CODEOWNERS'), 'utf8')).toContain('@acme/platform')
  })

  it('creates the directory it was named when it does not exist yet', async () => {
    const holder = await temp()
    const report = await writeScaffold(path.join(holder, 'new/iac'), await files())
    expect(report.written).toHaveLength(13)
  })
})
