import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCataloguePath } from '../../src/core/paths/catalogue.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'

const PATHS = [
  'root.yml',
  // The Backstage registration `init platform` scaffolds: catalogue, and read
  // by iac-fs like any other file.
  'catalog-info.yaml',
  'catalog/databases/orders-db-prod.yml',
  'catalog/databases/orders.yaml',
  'catalog/databases/.witness.yml',
  '.idp-agent.yml',
  '.github/workflows/validate.yml',
  'node_modules/pkg/entity.yml',
  'docs/readme.md',
  'catalog/.hidden/inner.yml',
]

describe('which files are catalogue', () => {
  it('says what the reader reads, and nothing else', () => {
    expect(PATHS.filter(isCataloguePath)).toEqual([
      'root.yml',
      'catalog-info.yaml',
      'catalog/databases/orders-db-prod.yml',
      'catalog/databases/orders.yaml',
    ])
  })

  it('agrees with readRepository on a real directory', async () => {
    // Two readers of one repository — iac-fs, and the forge proving the base
    // holds what the gates judged — must not disagree about what a catalogue
    // file is. This guards against the two DRIFTING apart; it passes before
    // the refactor too, because the old walker applied the same rules, so it
    // is not the proof that iac-fs now calls the predicate — reading the diff is.
    const root = await mkdtemp(path.join(tmpdir(), 'idp-catalogue-'))
    for (const file of PATHS) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), '# comment only\n', 'utf8')
    }
    const read = (await readRepository(root)).files.map((file) => file.path).sort()
    expect(read).toEqual(PATHS.filter(isCataloguePath).sort())
  })
})
