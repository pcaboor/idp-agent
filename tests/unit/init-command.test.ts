import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { checkRepository } from '../../src/core/validate/rules.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'

const capture = (): { out: string[]; err: string[] } => ({ out: [], err: [] })
const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-init-'))

const init = async (args: string[], cwd?: string) => {
  const io = capture()
  const code = await main(args, {
    // Omitted rather than passed as undefined: exactOptionalPropertyTypes
    // draws the distinction.
    ...(cwd !== undefined ? { cwd } : {}),
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

describe('init platform', () => {
  it('scaffolds a repository that passes its own validator', async () => {
    // The round trip, and the one failure this stage cannot ship: a scaffold
    // its own rules reject. Two independent oracles.
    const root = await temp()
    const { code, out } = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    expect(code).toBe(0)
    expect(out).toContain('wrote 12')

    const built = path.join(root, 'repo')
    expect(checkRepository(await readRepository(built))).toEqual([])

    const loaded = await new FixtureProvider(built).load()
    expect(loaded.entities).toEqual([])
    expect(loaded.rejected).toEqual([])
  })

  it('writes nothing on a re-run and keeps a hand edit', async () => {
    const root = await temp()
    await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    const owners = path.join(root, 'repo/CODEOWNERS')
    await writeFile(owners, '* @someone/else\n')

    const { code, out } = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    expect(code).toBe(0)
    expect(out).toContain('wrote 0')
    expect(out).toContain('kept 12')
    expect(await readFile(owners, 'utf8')).toBe('* @someone/else\n')
  })

  it('prints the branch protection it cannot set, on every run', async () => {
    // "An automaton that verifies its own powerlessness, out loud." The
    // no-op run must say it too, or the second reader never sees it.
    const root = await temp()
    const first = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    const second = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    for (const run of [first, second]) {
      expect(run.out).toContain('Branch protection is set in the forge')
      expect(run.out).toMatch(/cannot verify/i)
      expect(run.out).toContain('stage 6')
    }
  })

  it('needs an owner, and says what one looks like', async () => {
    const root = await temp()
    const { code, err } = await init(['init', 'platform', 'repo'], root)
    expect(code).toBe(2)
    expect(err).toContain('--owner')
    expect(err).toContain('@')
  })

  it('refuses an entity owner reference, which is a different notation', async () => {
    const root = await temp()
    const { code, err } = await init(
      ['init', 'platform', 'repo', '--owner', 'group:default/tiger'],
      root,
    )
    expect(code).toBe(2)
    expect(err).toContain('group:default/tiger')
  })

  it('creates the repository where it was told to, absolute path included', async () => {
    // `init platform` CREATES the repository: its root has no reason to sit
    // under the working directory, and `idp-agent init platform ~/my-iac` is
    // the first thing anyone types. Containment belongs to the files written
    // UNDER that root — `write.ts` checks every one of them against it — not
    // to the root the user named in their own shell.
    const elsewhere = path.join(await temp(), 'somewhere-else')
    const cwd = await temp()

    const { code } = await init(['init', 'platform', elsewhere, '--owner', '@a/b'], cwd)

    expect(code).toBe(0)
    // The witness of the folder layout itself, read straight off the disk:
    // readRepository reports catalogue documents, and a fresh scaffold has
    // none — the folders and their witnesses are what it wrote.
    expect(await readFile(path.join(elsewhere, 'README.md'), 'utf8')).toContain('#')
  })

  it('writes every file under the root it was given, and none outside it', async () => {
    // The containment that actually matters, asserted where it lives.
    const root = path.join(await temp(), 'iac')
    await init(['init', 'platform', root, '--owner', '@a/b'], await temp())

    // Every path the scaffold reports is repository-relative, and every one of
    // them resolves back under the root it was given.
    const { out } = await init(['init', 'platform', root, '--owner', '@a/b'], await temp())
    const listed = out
      .split('\n')
      .filter((line) => /^ {2}[+=] /.test(line))
      .map((line) => line.slice(4))

    expect(listed.length).toBeGreaterThan(0)
    for (const file of listed) {
      expect(path.isAbsolute(file)).toBe(false)
      expect(file.split('/')).not.toContain('..')
      expect(path.resolve(root, file).startsWith(`${root}${path.sep}`)).toBe(true)
    }
  })

  it('needs a directory', async () => {
    const { code, err } = await init(['init', 'platform', '--owner', '@a/b'])
    expect(code).toBe(2)
    expect(err).toContain('directory')
  })
})

describe('init, per application', () => {
  it('refuses, naming the stage it waits for', async () => {
    // Not a stub: a boundary with a test. It needs the Inspector and
    // propose(), which arrive at stage 4.
    const { code, err } = await init(['init'])
    expect(code).toBe(3)
    expect(err).toContain('stage 4')
    expect(err).toMatch(/propose/)
  })
})
