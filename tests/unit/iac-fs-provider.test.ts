import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { IacFsProvider } from '../../src/context/iac-fs/provider.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

describe('IacFsProvider', () => {
  it('is named for the reader it wraps', () => {
    expect(new IacFsProvider(FIXTURES).name).toBe('iac-fs')
  })

  it('loads the same entities the fixture provider does from the same repository', async () => {
    // The seam's whole promise: two providers, one directory, one SI. Compared
    // by reference, since each reader orders files its own way.
    const refs = (entities: { kind: string; metadata: { name: string } }[]): string[] =>
      entities.map((entity) => `${entity.kind}:${entity.metadata.name}`).sort()

    const fixtures = await new FixtureProvider(FIXTURES).load()
    const repository = await new IacFsProvider(FIXTURES).load()

    expect(repository.rejected).toEqual([])
    expect(refs(repository.entities)).toEqual(refs(fixtures.entities))
  })

  it('reports each rejection against the file it came from, relative to the repository', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-provider-'))
    await cp(FIXTURES, repo, { recursive: true })
    await mkdir(path.join(repo, 'catalog/databases'), { recursive: true })
    await writeFile(
      path.join(repo, 'catalog/databases/broken-db-prod.yml'),
      'apiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: broken-db-prod\n',
    )

    const { entities, rejected } = await new IacFsProvider(repo).load()

    expect(rejected).toHaveLength(1)
    // POSIX and relative: a path a human types, never the scratch directory.
    expect(rejected[0]?.source).toBe('catalog/databases/broken-db-prod.yml')
    expect(rejected[0]?.reason).not.toBe('')
    // One bad file costs one entity, never the rest of the repository.
    expect(entities.some((entity) => entity.metadata.name === 'billing-db-prod')).toBe(true)
  })

  it('reads an empty directory as no entity and no rejection', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-provider-empty-'))
    expect(await new IacFsProvider(repo).load()).toEqual({ entities: [], rejected: [] })
  })
})
