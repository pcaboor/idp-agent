import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { checkRepository } from '../../src/core/validate/rules.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const GOLDEN = path.resolve(import.meta.dirname, '../golden')

describe('readRepository', () => {
  it('sees the witness in every folder that has one', async () => {
    // readdir, never a glob: a witness is a dotfile, and the whole rule rests
    // on being able to see it.
    const snapshot = await readRepository(FIXTURES)
    expect(snapshot.witnesses).toContain('catalog/databases')
    expect(snapshot.witnesses).toContain('dependencies/gateway')
  })

  it('keeps the path of every file it parsed', async () => {
    const snapshot = await readRepository(FIXTURES)
    expect(snapshot.files.map((file) => file.path)).toContain(
      'catalog/databases/billing-db-prod.yml',
    )
  })

  it('uses POSIX separators whatever the platform', async () => {
    const snapshot = await readRepository(FIXTURES)
    expect(snapshot.files.every((file) => !file.path.includes('\\'))).toBe(true)
  })

  it('does not treat a witness as a file to parse', async () => {
    const snapshot = await readRepository(FIXTURES)
    expect(snapshot.files.map((file) => file.path).join()).not.toContain('.witness.yml')
  })

  it('counts documents, not only entities', async () => {
    const snapshot = await readRepository(path.join(GOLDEN, 'multi-doc'))
    expect(snapshot.files[0]?.documents).toBe(2)
    expect(snapshot.files[0]?.entities).toHaveLength(2)
  })

  it('reports what the schema refused instead of dropping it', async () => {
    const snapshot = await readRepository(path.join(GOLDEN, 'broken-si'))
    const invalid = snapshot.files.find((file) => file.path.endsWith('invalid.yml'))
    expect(invalid?.rejections).toHaveLength(1)
    expect(invalid?.entities).toHaveLength(0)
  })

  it('returns an empty snapshot for a directory that does not exist', async () => {
    const snapshot = await readRepository(path.join(FIXTURES, 'nowhere'))
    expect(snapshot.files).toEqual([])
    expect(snapshot.folders).toEqual([])
  })

  it('finds the fixture SI clean, which is the only proof the rules are usable', async () => {
    // If the repository this project ships as exemplary does not pass its own
    // validator, either the rules or the fixtures are wrong.
    const violations = checkRepository(await readRepository(FIXTURES))
    expect(violations.filter((violation) => violation.severity === 'error')).toEqual([])
  })
})
