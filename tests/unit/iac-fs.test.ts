import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

  it('does not read a hidden file as catalogue either', async () => {
    // The rule about hidden directories was written first and read as though
    // it covered both, which it did not. `.idp-agent.yml` is §7.0's own
    // configuration and sits at the root of every repository that has been
    // configured: read as an entity it fails `entitySchema`, and one
    // `invalid-entity` makes `recheckPlan` refuse the whole plan. So `plan`
    // could not land in a configured repository, and every fixture without a
    // config passed.
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-hidden-'))
    await mkdir(path.join(repo, 'catalog/databases'), { recursive: true })
    await writeFile(path.join(repo, 'catalog/databases/.witness.yml'), '---\n')
    await writeFile(
      path.join(repo, '.idp-agent.yml'),
      'iacRepo: acme/iac\nenvironments:\n  - prod\n',
    )

    const snapshot = await readRepository(repo)

    expect(snapshot.files.map((file) => file.path)).not.toContain('.idp-agent.yml')
    expect(snapshot.files.flatMap((file) => file.rejections)).toEqual([])
  })

  it('does not read a hidden directory as catalogue', async () => {
    // .github holds workflows: YAML, and not entities. Reading them would make
    // a freshly scaffolded repository fail its own validator.
    const snapshot = await readRepository(FIXTURES)
    expect(snapshot.files.map((file) => file.path).join()).not.toContain('.github')
    expect(snapshot.folders.join()).not.toContain('.github')
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

describe('readRepository, over files it cannot read', () => {
  // One unreadable file used to end `validate` on a raw stack trace, which
  // reports nothing about the other files. A file that cannot be read is a
  // rejection for that path — the same shape as one the schema refused.
  const repositoryWith = async (): Promise<string> => {
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-unreadable-'))
    await mkdir(path.join(repo, 'catalog/databases'), { recursive: true })
    await writeFile(path.join(repo, 'catalog/databases/.witness.yml'), '---\n')
    return repo
  }
  const rejectionsAt = async (repo: string, file: string): Promise<readonly string[]> => {
    const snapshot = await readRepository(repo)
    return snapshot.files.find((one) => one.path === file)?.rejections ?? []
  }

  it.skipIf(process.getuid?.() === 0)('rejects a file it has no permission to read', async () => {
    // Root reads through a mode of 000, so the case cannot be staged as root.
    const repo = await repositoryWith()
    const file = path.join(repo, 'catalog/databases/locked.yml')
    await writeFile(file, '---\nkind: Resource\n')
    await chmod(file, 0o000)
    try {
      expect(await rejectionsAt(repo, 'catalog/databases/locked.yml')).toEqual([
        expect.stringContaining('EACCES'),
      ])
    } finally {
      await chmod(file, 0o600)
    }
  })

  it('walks a directory whose name ends in .yml, rather than reading it as a file', async () => {
    // Not a regression test for the rejection: `walk()` already told a
    // directory from a file. It pins that the new catch does not turn one into
    // a rejection — only a LINK to a directory is read, and fails, as a file.
    const repo = await repositoryWith()
    await mkdir(path.join(repo, 'catalog/databases/odd.yml'))
    await writeFile(path.join(repo, 'catalog/databases/odd.yml/.witness.yml'), '---\n')
    const snapshot = await readRepository(repo)
    expect(snapshot.files.map((file) => file.path)).not.toContain('catalog/databases/odd.yml')
  })

  it('rejects a symbolic link that leads nowhere', async () => {
    const repo = await repositoryWith()
    await symlink(path.join(repo, 'gone.yml'), path.join(repo, 'catalog/databases/dangling.yml'))
    expect(await rejectionsAt(repo, 'catalog/databases/dangling.yml')).toEqual([
      expect.stringContaining('ENOENT'),
    ])
  })

  it('rejects a loop of symbolic links', async () => {
    const repo = await repositoryWith()
    const at = (name: string) => path.join(repo, 'catalog/databases', name)
    await symlink(at('b.yml'), at('a.yml'))
    await symlink(at('a.yml'), at('b.yml'))
    expect(await rejectionsAt(repo, 'catalog/databases/a.yml')).toEqual([
      expect.stringContaining('ELOOP'),
    ])
  })

  it('rejects a symbolic link to a directory', async () => {
    const repo = await repositoryWith()
    await symlink(path.join(repo, 'catalog'), path.join(repo, 'catalog/databases/loop.yml'))
    expect(await rejectionsAt(repo, 'catalog/databases/loop.yml')).toEqual([
      expect.stringContaining('EISDIR'),
    ])
  })

  it('rejects a duplicate key with its line and column, instead of reading the last one', async () => {
    const repo = await repositoryWith()
    await writeFile(
      path.join(repo, 'catalog/databases/twice.yml'),
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: twice',
        'spec:',
        '  type: database',
        '  owner: group:default/tiger',
        '  owner: group:default/lion',
        '',
      ].join('\n'),
    )
    const snapshot = await readRepository(repo)
    const twice = snapshot.files.find((file) => file.path === 'catalog/databases/twice.yml')
    expect(twice?.entities).toEqual([])
    expect(twice?.rejections).toEqual([expect.stringMatching(/^9:3 DUPLICATE_KEY /)])
  })
})
