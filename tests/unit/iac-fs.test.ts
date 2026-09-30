import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IacFsProvider } from '../../src/context/iac-fs/provider.js'
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
    // `invalid-entity` made `recheckPlan` refuse the whole plan. So `plan`
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
    // a rejection — only a LINK to a directory is, and it is named as a link.
    const repo = await repositoryWith()
    await mkdir(path.join(repo, 'catalog/databases/odd.yml'))
    await writeFile(path.join(repo, 'catalog/databases/odd.yml/.witness.yml'), '---\n')
    const snapshot = await readRepository(repo)
    expect(snapshot.files.map((file) => file.path)).not.toContain('catalog/databases/odd.yml')
  })

  // A link of any shape is named for what it is, before anything is followed
  // (batch B3): each of these was read through, and failed on its target's
  // errno — ENOENT, ELOOP, EISDIR — which named the target, not the link.
  const LINK = 'not read: a symbolic link, never followed'

  it.skipIf(process.platform === 'win32')('rejects a symbolic link that leads nowhere, as a link', async () => {
    const repo = await repositoryWith()
    await symlink(path.join(repo, 'gone.yml'), path.join(repo, 'catalog/databases/dangling.yml'))
    expect(await rejectionsAt(repo, 'catalog/databases/dangling.yml')).toEqual([LINK])
  })

  it.skipIf(process.platform === 'win32')('rejects a loop of symbolic links, as links', async () => {
    const repo = await repositoryWith()
    const at = (name: string) => path.join(repo, 'catalog/databases', name)
    await symlink(at('b.yml'), at('a.yml'))
    await symlink(at('a.yml'), at('b.yml'))
    expect(await rejectionsAt(repo, 'catalog/databases/a.yml')).toEqual([LINK])
  })

  it.skipIf(process.platform === 'win32')('rejects a symbolic link to a directory, as a link', async () => {
    const repo = await repositoryWith()
    await symlink(path.join(repo, 'catalog'), path.join(repo, 'catalog/databases/loop.yml'))
    expect(await rejectionsAt(repo, 'catalog/databases/loop.yml')).toEqual([LINK])
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

/**
 * A declarations repository holds no symbolic link: the one this tool writes
 * holds none, the forge refuses one tracked in HEAD, and a reviewer reads the
 * file a link names, not the file it leads to. So every link the walk meets is
 * named, never followed and never dropped in silence — what it leads to, a
 * file or a folder, inside or out, is never read (gap-stage5-readiness-4,
 * runtime-probe-11). Real links on a real disk; Windows gives one to an
 * administrator or to developer mode alone, so the runner may not be able to
 * make one, and these cases are skipped there by this condition.
 */
describe.skipIf(process.platform === 'win32')('readRepository, over symbolic links', () => {
  const ENTITY = [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: planted-db',
    'spec:',
    '  type: database',
    '  owner: group:default/tiger',
    '',
  ].join('\n')

  const repositoryWith = async (): Promise<string> => {
    const repo = await mkdtemp(path.join(tmpdir(), 'iac-links-'))
    await mkdir(path.join(repo, 'catalog/databases'), { recursive: true })
    await writeFile(path.join(repo, 'catalog/databases/.witness.yml'), '---\n')
    return repo
  }
  const outsideWith = async (): Promise<string> => {
    const outside = await mkdtemp(path.join(tmpdir(), 'iac-outside-'))
    await writeFile(path.join(outside, 'planted-db.yml'), ENTITY)
    return outside
  }
  const LINK = 'not read: a symbolic link, never followed'

  it('names a file linked outside, and never reads what it leads to', async () => {
    const outside = await outsideWith()
    const repo = await repositoryWith()
    const at = path.join(repo, 'catalog/databases/planted-db.yml')
    await symlink(path.join(outside, 'planted-db.yml'), at)
    // A positive control: the link does reach the entity.
    expect(await readFile(at, 'utf8')).toBe(ENTITY)

    const snapshot = await readRepository(repo)

    const file = snapshot.files.find((one) => one.path === 'catalog/databases/planted-db.yml')
    expect(file?.rejections).toEqual([LINK])
    expect(file?.entities).toEqual([])
    // What it leads to is never read: no name, no owner, anywhere.
    expect(JSON.stringify(snapshot.files.map((one) => one.entities))).not.toContain('planted-db')
    expect(JSON.stringify(snapshot)).not.toContain('tiger')
    expect(checkRepository(snapshot)).toContainEqual(
      expect.objectContaining({
        rule: 'invalid-entity',
        file: 'catalog/databases/planted-db.yml',
        severity: 'error',
      }),
    )
  })

  it('names a file linked inside the repository too, and reads it once, where it is', async () => {
    const repo = await repositoryWith()
    await writeFile(path.join(repo, 'catalog/databases/real-db.yml'), ENTITY.replace(/planted-db/g, 'real-db'))
    await symlink(
      path.join(repo, 'catalog/databases/real-db.yml'),
      path.join(repo, 'catalog/databases/alias-db.yml'),
    )

    const snapshot = await readRepository(repo)

    const byPath = new Map(snapshot.files.map((one) => [one.path, one]))
    expect(byPath.get('catalog/databases/alias-db.yml')?.rejections).toEqual([LINK])
    expect(byPath.get('catalog/databases/real-db.yml')?.entities).toHaveLength(1)
  })

  it('names a folder linked outside, rather than dropping it in silence, and walks nothing in it', async () => {
    const outside = await outsideWith()
    await writeFile(path.join(outside, '.witness.yml'), '---\n')
    const repo = await repositoryWith()
    await symlink(outside, path.join(repo, 'catalog/caches'))
    expect(await readFile(path.join(repo, 'catalog/caches/planted-db.yml'), 'utf8')).toBe(ENTITY)

    const snapshot = await readRepository(repo)

    expect(snapshot.unreadable).toEqual([
      { path: 'catalog/caches', reason: 'a symbolic link, never followed', link: true },
    ])
    expect(snapshot.files.map((one) => one.path)).toEqual([])
    expect(snapshot.folders).not.toContain('catalog/caches')
    expect(checkRepository(snapshot)).toContainEqual(
      expect.objectContaining({ rule: 'unreadable-folder', file: 'catalog/caches', severity: 'error' }),
    )
  })

  it('names a folder linked inside the repository, and walks it once, where it is', async () => {
    const repo = await repositoryWith()
    await writeFile(path.join(repo, 'catalog/databases/real-db.yml'), ENTITY.replace(/planted-db/g, 'real-db'))
    await symlink(path.join(repo, 'catalog/databases'), path.join(repo, 'catalog/mirror'))

    const snapshot = await readRepository(repo)

    expect(snapshot.unreadable).toEqual([
      { path: 'catalog/mirror', reason: 'a symbolic link, never followed', link: true },
    ])
    expect(snapshot.files.map((one) => one.path)).toEqual(['catalog/databases/real-db.yml'])
  })

  it('names a link at the root, whatever it is called', async () => {
    // Not a catalogue path, and still named: a link is not followed to learn
    // whether it is a folder the walk would have entered.
    const outside = await outsideWith()
    const repo = await repositoryWith()
    await symlink(outside, path.join(repo, 'dependencies'))
    const snapshot = await readRepository(repo)
    expect(snapshot.unreadable).toEqual([
      { path: 'dependencies', reason: 'a symbolic link, never followed', link: true },
    ])
  })

  it('says a link is a link, never a folder it could not list, whatever the link names', async () => {
    // `NOTES.md -> README.md` is no folder, and it is not followed to find out
    // what it is: every reader of the snapshot says what it knows — a link,
    // not followed, and nothing behind it checked.
    const repo = await repositoryWith()
    await writeFile(path.join(repo, 'README.md'), '# declarations\n')
    await symlink(path.join(repo, 'README.md'), path.join(repo, 'NOTES.md'))

    const snapshot = await readRepository(repo)

    expect(snapshot.unreadable).toEqual([
      { path: 'NOTES.md', reason: 'a symbolic link, never followed', link: true },
    ])
    expect(checkRepository(snapshot)).toEqual([
      {
        rule: 'unreadable-folder',
        file: 'NOTES.md',
        severity: 'error',
        message: 'a symbolic link, never followed; nothing it leads to was checked',
      },
    ])
    const { rejected } = await new IacFsProvider(repo).load()
    expect(rejected).toEqual([{ source: 'NOTES.md', reason: 'a symbolic link, never followed' }])
  })

  it('leaves a hidden link alone, as it leaves a hidden folder: tooling, never catalogue', async () => {
    const outside = await outsideWith()
    const repo = await repositoryWith()
    await symlink(outside, path.join(repo, '.github'))
    const snapshot = await readRepository(repo)
    expect(snapshot.unreadable).toBeUndefined()
    expect(snapshot.files).toEqual([])
  })
})
