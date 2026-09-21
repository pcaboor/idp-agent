import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

const capture = (): { out: string[]; err: string[] } => ({ out: [], err: [] })

const run = async (directory: string) => {
  const io = capture()
  const code = await main(['validate', directory], {
    out: (chunk) => io.out.push(chunk),
    err: (chunk) => io.err.push(chunk),
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

const WITNESS = '# Declares nothing.\n'
const database = (name: string): string =>
  `---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: ${name}\nspec:\n  type: database\n  owner: group:default/tiger\n`

/** A repository built for one fault. No fixture is added for a shape meant to be wrong. */
const repositoryWith = async (
  files: Record<string, string>,
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'idp-validate-'))
  await mkdir(path.join(root, 'catalog/databases'), { recursive: true })
  await writeFile(path.join(root, 'catalog/databases/.witness.yml'), WITNESS)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, 'catalog/databases', name), content)
  }
  return root
}

describe('validate', () => {
  it('accepts the fixture SI and says what it read', async () => {
    const { code, out } = await run(FIXTURES)
    expect(code).toBe(0)
    expect(out).toMatch(/33 entities/)
    expect(out).toMatch(/0 violations/)
  })

  it('refuses a duplicate and names both files', async () => {
    // This is the whole reason the command exists: the catalogue would take
    // the first and say nothing.
    const root = await repositoryWith({
      'a.yml': database('billing-db'),
      'copy.yml': database('billing-db'),
    })
    const { code, out } = await run(root)
    expect(code).toBe(1)
    expect(out).toContain('a.yml')
    expect(out).toContain('copy.yml')
    expect(out).toContain('error')
  })

  it('reports a dangling reference and still exits 0', async () => {
    // Reported, never pruned — and not what turns a build red, or people
    // would delete the declaration to get green.
    const root = await repositoryWith({
      'a.yml': `${database('a')}  dependsOn:\n    - resource:default/gone\n`,
    })
    const { code, out } = await run(root)
    expect(code).toBe(0)
    expect(out).toContain('warning')
    expect(out).toContain('resource:default/gone')
  })

  it('refuses a folder holding entities with no witness', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'idp-validate-'))
    await mkdir(path.join(root, 'catalog/databases'), { recursive: true })
    await writeFile(path.join(root, 'catalog/databases/a.yml'), database('a'))
    const { code, out } = await run(root)
    expect(code).toBe(1)
    expect(out).toContain('witness')
  })

  it('reports an entity the schema refused, rather than passing over it', async () => {
    const root = await repositoryWith({
      'broken.yml': '---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: x\nspec:\n  type: database\n',
    })
    const { code, out } = await run(root)
    expect(code).toBe(1)
    expect(out).toMatch(/owner/i)
  })

  it('anchors every line on a file, so a reader knows where to go', async () => {
    const root = await repositoryWith({
      'a.yml': database('dup'),
      'b.yml': database('dup'),
    })
    const { out } = await run(root)
    for (const line of out.split('\n').filter((l) => l.startsWith('error') || l.startsWith('warning'))) {
      expect(line).toMatch(/\.yml|catalog/)
    }
  })

  it('needs a directory', async () => {
    const io = capture()
    const code = await main(['validate'], {
      out: (chunk) => io.out.push(chunk),
      err: (chunk) => io.err.push(chunk),
    })
    expect(code).toBe(2)
    expect(io.err.join('')).toContain('needs a directory')
  })

  it('says so when the directory holds nothing, rather than reporting success', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'idp-validate-'))
    const { code, out } = await run(root)
    expect(code).toBe(0)
    expect(out).toMatch(/0 entities/)
  })
})
