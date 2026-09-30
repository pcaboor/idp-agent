import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import type { FileEdit } from '../../src/core/diff/unified.js'
import { treeId, writeTree, type TreeEntry } from '../../src/forge/local/objects.js'
import { treeFor } from '../../src/forge/local/tree.js'
import { gitIn } from '../../src/process/git.js'
import { clone, removeClones, scratch } from '../support/forge-fixture.js'
import { git, stored } from '../support/git.js'

/**
 * The tree a change would have, computed without writing one (stage 6 brief §
 * 4, "Comparing trees without writing one"): recognition meets a branch on
 * GitHub whose commit this clone never made, and must say whether its tree is
 * the one these edits give its parent — before anything is written, since it
 * runs before anyone is asked. Every expectation here is git's own answer,
 * over real repositories.
 */

afterAll(removeClones)

/** A blob written with test-side git, its id returned. */
const blob = async (repo: string, bytes: string): Promise<string> => {
  const file = path.join(path.dirname(repo), `blob-${String(Math.random()).slice(2)}`)
  await writeFile(file, bytes)
  return git(repo, 'hash-object', '-w', '--no-filters', file)
}

/** What `git mktree` makes of a listing: git's own id for it. */
const mktree = async (repo: string, entries: ReadonlyMap<string, TreeEntry>): Promise<string> => {
  const input = [...entries].map(([name, entry]) => `${entry.mode} ${entry.type} ${entry.oid}\t${name}\0`).join('')
  const child = promisify(execFile)('git', ['-C', repo, 'mktree', '-z'], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  })
  child.child.stdin?.end(input)
  return (await child).stdout.trim()
}

describe('treeId', () => {
  it('computes the id git itself gives a tree', async () => {
    const repo = await clone()
    const file = await blob(repo, 'a file\n')
    const executable = await blob(repo, '#!/bin/sh\n')
    const inner = await mktree(repo, new Map([['inner.yml', { mode: '100644', type: 'blob', oid: file }]]))
    // Named so that git's order differs from a plain sort of the names: a
    // folder sorts as `a/`, after `a-b` and `a.yml` and before `a0`.
    const listing = new Map<string, TreeEntry>([
      ['a0', { mode: '100644', type: 'blob', oid: file }],
      ['a', { mode: '040000', type: 'tree', oid: inner }],
      ['a.yml', { mode: '100644', type: 'blob', oid: file }],
      ['a-b', { mode: '100755', type: 'blob', oid: executable }],
    ])

    expect(treeId(listing, 'sha1')).toBe(await mktree(repo, listing))
    // As ls-tree prints a folder (040000) and as the object holds it (40000): the same id.
    expect(treeId(new Map([['a', { mode: '40000', type: 'tree', oid: inner }]]), 'sha1')).toBe(
      treeId(new Map([['a', { mode: '040000', type: 'tree', oid: inner }]]), 'sha1'),
    )
    expect(treeId(new Map(), 'sha1')).toBe(await mktree(repo, new Map()))
  })
})

describe('treeFor', () => {
  /** Paths the property draws edits from: new and existing folders, three deep, amended, executable. */
  const setUp = async (): Promise<{ repo: string; head: string; amended: readonly string[] }> => {
    const repo = await clone()
    await writeFile(path.join(repo, 'run.yml'), '# run\n')
    await chmod(path.join(repo, 'run.yml'), 0o755)
    await mkdir(path.join(repo, 'deep', 'er'), { recursive: true })
    await writeFile(path.join(repo, 'deep', 'er', 'kept.yml'), 'kept: true\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'an executable, and a deep folder')
    const head = await git(repo, 'rev-parse', 'HEAD')
    const amended = (await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n').filter((line) => line !== '')
    return { repo, head, amended }
  }

  const NEW = [
    'new.yml',
    'fresh/one.yml',
    'catalog/databases/new-db.yml',
    'deep/er/new.yml',
    'deep/er/still/deeper.yml',
    'x/y/z/three.yml',
  ]

  it('computes the tree writeTree builds, and writes nothing', async () => {
    const { repo, head, amended } = await setUp()
    const run = gitIn(repo)
    const paths = [...NEW, ...amended.filter((file) => !file.endsWith('.witness.yml')).slice(0, 6), 'run.yml']
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...paths), { minLength: 1, maxLength: 6 }),
        fc.string({ minLength: 0, maxLength: 12 }),
        async (chosen, text) => {
          const edits: FileEdit[] = chosen.map((file, at) => ({
            path: file,
            before: amended.includes(file) ? 'was' : undefined,
            after: `${text}\n${String(at)}\n`,
          }))
          const objects = await stored(repo)
          const computed = await treeFor(run, head, edits, 'sha1')
          expect(await stored(repo)).toBe(objects)

          const blobs = new Map<string, string>()
          for (const edit of edits) blobs.set(edit.path, await blob(repo, edit.after))
          const written = await writeTree(run, await git(repo, 'rev-parse', `${head}^{tree}`), blobs)
          expect(computed).toBe(written)
        },
      ),
      { numRuns: 25 },
    )
  }, 60_000)

  it('keeps an executable executable, as writeTree does', async () => {
    const { repo, head } = await setUp()
    const run = gitIn(repo)
    const computed = await treeFor(run, head, [{ path: 'run.yml', before: '# run\n', after: '# ran\n' }], 'sha1')
    // Computed, never written: git does not have it until writeTree writes it.
    expect(await git(repo, 'ls-tree', computed, 'run.yml').catch(() => 'absent')).toBe('absent')
    const blobs = new Map([['run.yml', await blob(repo, '# ran\n')]])
    const written = await writeTree(run, await git(repo, 'rev-parse', `${head}^{tree}`), blobs)
    expect(computed).toBe(written)
    expect(await git(repo, 'ls-tree', written, 'run.yml')).toMatch(/^100755 /)
  })

  it('refuses what writeTree refuses', async () => {
    const { repo, head } = await setUp()
    const run = gitIn(repo)
    await expect(
      treeFor(run, head, [{ path: 'run.yml/inner.yml', before: undefined, after: 'x\n' }], 'sha1'),
    ).rejects.toThrow('run.yml is a file at the base, not a folder')
    await expect(treeFor(run, head, [{ path: 'deep', before: undefined, after: 'x\n' }], 'sha1')).rejects.toThrow(
      'deep is a folder at the base, not a file',
    )
  })

  it('hashes a sha256 repository with sha256', async (context) => {
    const repo = path.join(await scratch('idp-sha256-'), 'iac')
    await mkdir(repo)
    const made = await git(repo, 'init', '-q', '--object-format=sha256', '-b', 'main').then(
      () => true,
      () => false,
    )
    if (!made) context.skip('the git on this machine cannot create a sha256 repository')
    await git(repo, 'config', 'user.name', 'idp-agent tests')
    await git(repo, 'config', 'user.email', 'tests@idp-agent.invalid')
    await mkdir(path.join(repo, 'catalog'))
    await writeFile(path.join(repo, 'catalog', 'one.yml'), 'one: 1\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'base')
    const head = await git(repo, 'rev-parse', 'HEAD')
    const run = gitIn(repo)
    const edits: FileEdit[] = [
      { path: 'catalog/two.yml', before: undefined, after: 'two: 2\n' },
      { path: 'other/three.yml', before: undefined, after: 'three: 3\n' },
    ]

    const computed = await treeFor(run, head, edits, 'sha256')

    expect(computed).toMatch(/^[0-9a-f]{64}$/)
    const blobs = new Map<string, string>()
    for (const edit of edits) blobs.set(edit.path, await blob(repo, edit.after))
    expect(computed).toBe(await writeTree(run, await git(repo, 'rev-parse', `${head}^{tree}`), blobs))
  })
})
