import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeScaffold } from '../../src/scaffold/write.js'
import { scaffoldLayout } from '../../src/scaffold/layout.js'
import { loadTemplates } from '../../src/scaffold/templates.js'
import type { FileIO } from '../../src/scaffold/write.js'

const files = async () =>
  scaffoldLayout({ owner: '@acme/platform', version: '0.1.0-rc.1' }, await loadTemplates())

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-scaffold-'))

describe('writeScaffold', () => {
  it('writes every file and reports them', async () => {
    const root = await temp()
    const report = await writeScaffold(root, await files())
    expect(report.written).toHaveLength(12)
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
    expect(again.kept).toHaveLength(12)
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
