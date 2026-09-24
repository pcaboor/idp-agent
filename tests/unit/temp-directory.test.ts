import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeAbandonedRuns, removeTree } from '../setup/tmp.js'

// Every run used to leave its temp directories behind — 243 entries a run, and
// on one laptop 79,410 entries and 6.7 GB before the disk filled. The suite now
// runs inside one directory that its global setup removes (tests/setup/tmp.ts).
// These tests fail when that stops holding, so a new test that calls
// `mkdtemp(path.join(tmpdir(), …))` is contained without having to know it.

const RUN = /^idp-agent-test-\d+-[A-Za-z0-9]{6}$/

describe('the run directory', () => {
  it('is what os.tmpdir() answers inside a test', () => {
    expect(path.basename(tmpdir())).toMatch(RUN)
  })

  it('is what TMPDIR, TMP and TEMP name, so Windows answers the same', () => {
    expect([process.env['TMPDIR'], process.env['TMP'], process.env['TEMP']]).toEqual([
      tmpdir(),
      tmpdir(),
      tmpdir(),
    ])
  })

  it('holds what a test makes the usual way', async () => {
    const made = await mkdtemp(path.join(tmpdir(), 'idp-contained-'))
    expect(path.dirname(made)).toBe(tmpdir())
  })

  it('is inherited by a process a test starts, such as the CLI', () => {
    const child = spawnSync(process.execPath, ['-p', "require('node:os').tmpdir()"], {
      encoding: 'utf8',
    })
    expect(child.stdout.trim()).toBe(tmpdir())
  })

  it("holds vitest's own copies of the modules it hands its workers", () => {
    // vitest writes them to `<nanoid>/ssr/` under the temp directory it read
    // when it was constructed, and never removes that directory. They land in
    // here only because vitest.config.ts moves TMPDIR while the config loads;
    // moved any later — in the global setup, say — they land in the shared
    // temp directory again, one directory per run. If vitest stops making
    // them, this fails too: check the shared temp directory, then drop it.
    const copies = readdirSync(tmpdir()).filter(
      (name) => /^[A-Za-z0-9_-]{21}$/.test(name) && existsSync(path.join(tmpdir(), name, 'ssr')),
    )
    expect(copies).not.toEqual([])
  })
})

describe('removeTree', () => {
  it.skipIf(process.getuid?.() === 0)(
    'removes what a test locked, without following a link out of the tree',
    async () => {
      // Root lists a directory of mode 000 anyway, so the lock cannot be staged.
      const tree = await mkdtemp(path.join(tmpdir(), 'idp-locked-'))
      const outside = await mkdtemp(path.join(tmpdir(), 'idp-outside-'))
      await writeFile(path.join(outside, 'kept.txt'), 'kept')
      await mkdir(path.join(tree, 'deep/er'), { recursive: true })
      await writeFile(path.join(tree, 'deep/er/file.txt'), 'x')
      await chmod(path.join(tree, 'deep/er/file.txt'), 0o000)
      await chmod(path.join(tree, 'deep/er'), 0o000)
      await chmod(path.join(tree, 'deep'), 0o000)
      await symlink(outside, path.join(tree, 'link'))
      await chmod(outside, 0o500)
      try {
        removeTree(tree)
        expect(existsSync(tree)).toBe(false)
        expect(await readdir(outside)).toEqual(['kept.txt'])
        expect((await stat(outside)).mode & 0o777).toBe(0o500)
      } finally {
        await chmod(outside, 0o700)
      }
    },
  )

  it('is quiet about a tree that is already gone', () => {
    expect(() => removeTree(path.join(tmpdir(), 'never-made'))).not.toThrow()
  })
})

describe('removeAbandonedRuns', () => {
  it('removes the run directory of a process that is gone, and only that', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'idp-runs-'))
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    const named = {
      abandoned: `idp-agent-test-${exited}-aB3dE6`,
      running: `idp-agent-test-${process.ppid}-aB3dE6`,
      ours: `idp-agent-test-${process.pid}-aB3dE6`,
      // Not a name mkdtemp makes of the prefix: somebody else's, left alone.
      lookalike: `idp-agent-test-${exited}-kept`,
      unrelated: 'idp-agent-smoke-aB3dE6',
    }
    for (const name of Object.values(named)) await mkdir(path.join(parent, name))

    removeAbandonedRuns(parent)

    const left = readdirSync(parent)
    expect(left).not.toContain(named.abandoned)
    expect(left.sort()).toEqual(
      [named.running, named.ours, named.lookalike, named.unrelated].sort(),
    )
  })
})
