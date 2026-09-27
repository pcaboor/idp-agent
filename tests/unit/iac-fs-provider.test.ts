import { chmod, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
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
    expect(repository.ignored).toEqual([])
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

  it('sets aside a document it does not model, against the file it came from', async () => {
    // Neither refused nor dropped: a Group beside the entities is part of a
    // real catalogue, and `main` counts what was set aside.
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-provider-'))
    await cp(FIXTURES, repo, { recursive: true })
    await mkdir(path.join(repo, 'org'), { recursive: true })
    await writeFile(
      path.join(repo, 'org/tiger.yml'),
      'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata:\n  name: tiger\n',
    )

    const { entities, rejected, ignored } = await new IacFsProvider(repo).load()

    expect(rejected).toEqual([])
    expect(ignored).toEqual([
      {
        source: 'org/tiger.yml',
        kind: 'Group',
        ref: 'group:default/tiger',
        reason: 'kind Group is not modelled by this tool; group tiger left as is',
      },
    ])
    expect(entities).toHaveLength(33)
  })

  it('reads an empty directory as no entity and no rejection', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-provider-empty-'))
    expect(await new IacFsProvider(repo).load()).toEqual({ entities: [], rejected: [], ignored: [] })
  })
  it.skipIf(process.getuid?.() === 0)('reports a folder it could not list, rather than reading it as empty', async () => {
    // The entities under it are missing from every answer `graph`, `show` and
    // `ask` give, and a folder read as empty would say nothing about it.
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-provider-'))
    await cp(FIXTURES, repo, { recursive: true })
    const locked = path.join(repo, 'catalog/databases')
    await chmod(locked, 0o000)
    try {
      const { entities, rejected } = await new IacFsProvider(repo).load()
      expect(rejected).toEqual([{ source: 'catalog/databases', reason: 'could not be listed (EACCES)' }])
      expect(entities.some((entity) => entity.metadata.name === 'billing-api')).toBe(true)

      // And `graph` says it, as it says a file it skipped.
      const err: string[] = []
      const code = await main(['graph', '--repo', repo], {
        env: {},
        out: () => {},
        err: (chunk) => void err.push(chunk),
      })
      expect(code).toBe(0)
      expect(err.join('')).toContain('skipped catalog/databases: could not be listed (EACCES)\n')
    } finally {
      await chmod(locked, 0o755)
    }
  })
})
