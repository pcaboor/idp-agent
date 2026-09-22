import { link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_LIMITS, readProject } from '../../src/context/project-fs/snapshot.js'
import type { ProjectSnapshot } from '../../src/context/project-fs/snapshot.js'

const temp = (prefix = 'idp-project-'): Promise<string> => mkdtemp(path.join(tmpdir(), prefix))

/**
 * A real directory, with real files and real symlinks, because every guarantee
 * under test is a filesystem fact: a symlink is only a symlink on a disk, and a
 * stubbed `readdir` would answer whatever the test wished were true — which is
 * the one failure mode this module cannot afford.
 */
const projectWith = async (files: Record<string, string>): Promise<string> => {
  const root = await temp()
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

const pathsOf = (snapshot: ProjectSnapshot): string[] => snapshot.files.map((file) => file.path)

const reasonFor = (snapshot: ProjectSnapshot, candidate: string): string | undefined =>
  snapshot.skipped.find((entry) => entry.path === candidate)?.reason

describe('readProject', () => {
  it('never returns a secret, and says what it skipped', async () => {
    // §6: escaping paths refused, .env, .git/ and key files excluded, size
    // capped. "Never ignore in silence" applies to exclusions too — a file
    // dropped without a word is a file the user thinks was read.
    const root = await projectWith({
      '.env': 'MISTRAL_API_KEY=secret',
      'src/index.ts': 'export const x = 1',
      id_rsa: '-----BEGIN PRIVATE KEY-----',
      'huge.txt': 'x'.repeat(200_000),
    })
    const snapshot = await readProject(root)
    const text = JSON.stringify(snapshot.files)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('PRIVATE KEY')
    expect(snapshot.skipped.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['.env', 'id_rsa', 'huge.txt']),
    )
    expect(snapshot.skipped.every((entry) => entry.reason.length > 0)).toBe(true)
    expect(pathsOf(snapshot)).toEqual(['src/index.ts'])
  })

  it('reads a manifest', async () => {
    const root = await projectWith({
      'package.json': '{\n  "name": "billing-api"\n}\n',
      'src/index.ts': 'export const x = 1\n',
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['package.json', 'src/index.ts'])
    expect(snapshot.files.find((file) => file.path === 'package.json')?.text).toContain(
      'billing-api',
    )
    expect(snapshot.skipped).toEqual([])
    expect(snapshot.truncated).toBe(false)
    // The root the containment decisions were actually made against, not the
    // one that was typed: on macOS a temp directory is reached through a link.
    expect(snapshot.root).toBe(await realpath(root))
  })

  it('uses POSIX separators whatever the platform', async () => {
    const snapshot = await readProject(await projectWith({ 'src/deep/file.ts': 'ok' }))
    expect(pathsOf(snapshot)).toEqual(['src/deep/file.ts'])
  })

  it('excludes every environment file, whatever its case or suffix', async () => {
    const root = await projectWith({
      '.env': 'A=1',
      '.env.local': 'B=2',
      '.env.production': 'C=3',
      // A separate folder on purpose: a case-insensitive filesystem would make
      // `.ENV` and `.env` the same file in one directory.
      'config/.ENV': 'D=4',
      'src/app.ts': 'ok',
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['src/app.ts'])
    for (const excluded of ['.env', '.env.local', '.env.production', 'config/.ENV']) {
      expect(reasonFor(snapshot, excluded)).toBeTruthy()
    }
  })

  it('excludes key material by name, whatever the case', async () => {
    const root = await projectWith({
      'keys/ID_RSA': 'x',
      'keys/id_ed25519': 'x',
      'certs/server.PEM': 'x',
      'certs/tls.key': 'x',
      'certs/bundle.p12': 'x',
      '.npmrc': '//registry.npmjs.org/:_authToken=tok',
      '.netrc': 'machine example.com password tok',
      'terraform.tfvars': 'db_password = "tok"',
      'README.md': 'ok',
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['README.md'])
    expect(JSON.stringify(snapshot.files)).not.toContain('tok')
    expect(snapshot.skipped.every((entry) => entry.reason.length > 0)).toBe(true)
  })

  it('skips a private key hiding behind an innocent name', async () => {
    // Rule 1 is a name test and a name is the attacker's to choose. This is the
    // content test underneath it.
    const root = await projectWith({
      'notes.txt': '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n',
      'src/config.ts': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb==\n',
      'src/real.ts': 'export const x = 1\n',
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['src/real.ts'])
    expect(reasonFor(snapshot, 'notes.txt')).toBeTruthy()
    expect(reasonFor(snapshot, 'src/config.ts')).toBeTruthy()
    expect(JSON.stringify(snapshot.files)).not.toContain('PRIVATE KEY')
  })

  it('skips a binary file', async () => {
    const root = await projectWith({
      // A PNG header, written as escapes: a raw NUL in a source file is a
      // trap for every tool that reads it, grep included.
      'logo.png': '\u0089PNG\u0000\u0000\u0000\u0000IHDR',
      'src/app.ts': 'ok',
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['src/app.ts'])
    expect(reasonFor(snapshot, 'logo.png')).toBeTruthy()
  })

  it('refuses a symlink pointing outside the project', async () => {
    const outside = await temp('idp-outside-')
    await writeFile(path.join(outside, 'secret.txt'), 'SUPER_SECRET_VALUE')
    const root = await projectWith({ 'src/app.ts': 'ok' })
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    // A positive control: the link really does reach the secret, so this test
    // cannot pass because the setup quietly failed to build one.
    expect(await readFile(path.join(root, 'leak.txt'), 'utf8')).toBe('SUPER_SECRET_VALUE')

    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['src/app.ts'])
    expect(JSON.stringify(snapshot.files)).not.toContain('SUPER_SECRET_VALUE')
    expect(reasonFor(snapshot, 'leak.txt')).toBeTruthy()
    // The reason must not name the target: it is a path outside the project,
    // and this string is handed to a model.
    expect(reasonFor(snapshot, 'leak.txt')).not.toContain(outside)
  })

  it('refuses a symlinked directory pointing outside the project', async () => {
    const outside = await temp('idp-outside-')
    await mkdir(path.join(outside, 'nested'), { recursive: true })
    await writeFile(path.join(outside, 'nested/secret.txt'), 'SUPER_SECRET_VALUE')
    const root = await projectWith({ 'src/app.ts': 'ok' })
    await symlink(outside, path.join(root, 'leak-dir'))
    expect(await readFile(path.join(root, 'leak-dir/nested/secret.txt'), 'utf8')).toBe(
      'SUPER_SECRET_VALUE',
    )

    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['src/app.ts'])
    expect(JSON.stringify(snapshot.files)).not.toContain('SUPER_SECRET_VALUE')
    expect(reasonFor(snapshot, 'leak-dir')).toBeTruthy()
    expect(pathsOf(snapshot).some((entry) => entry.startsWith('leak-dir'))).toBe(false)
  })

  it('refuses a symlink whose target climbs out with ..', async () => {
    const outer = await temp('idp-outer-')
    await writeFile(path.join(outer, 'secret.txt'), 'SUPER_SECRET_VALUE')
    const root = path.join(outer, 'project')
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/app.ts'), 'ok')
    await symlink('../../secret.txt', path.join(root, 'src/climb.txt'))
    expect(await readFile(path.join(root, 'src/climb.txt'), 'utf8')).toBe('SUPER_SECRET_VALUE')

    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['src/app.ts'])
    expect(JSON.stringify(snapshot.files)).not.toContain('SUPER_SECRET_VALUE')
    expect(reasonFor(snapshot, 'src/climb.txt')).toBeTruthy()
  })

  it('reads a symlink that stays inside the project', async () => {
    // Refusing every symlink would be easy and wrong: a monorepo links a shared
    // config into a package, and that file is a fact about the project.
    const root = await projectWith({ 'src/real.ts': 'export const x = 1\n' })
    await symlink(path.join(root, 'src/real.ts'), path.join(root, 'src/alias.ts'))
    await symlink(path.join(root, 'src'), path.join(root, 'linked'))

    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toContain('src/alias.ts')
    expect(snapshot.files.find((file) => file.path === 'src/alias.ts')?.text).toBe(
      'export const x = 1\n',
    )
    expect(pathsOf(snapshot)).toContain('linked/real.ts')
  })

  it('does not spin on a symlink loop', async () => {
    const root = await projectWith({ 'src/app.ts': 'ok' })
    await symlink(root, path.join(root, 'src/self'))
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toContain('src/app.ts')
    expect(snapshot.files.length).toBeLessThan(PROJECT_LIMITS.maxFiles)
  })

  it('skips a broken symlink rather than failing the read', async () => {
    const root = await projectWith({ 'src/app.ts': 'ok' })
    await symlink(path.join(root, 'nowhere.txt'), path.join(root, 'dangling.txt'))
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['src/app.ts'])
    expect(reasonFor(snapshot, 'dangling.txt')).toBeTruthy()
  })

  it('never descends into node_modules, .git or a credential directory', async () => {
    const root = await projectWith({
      'node_modules/left-pad/index.js': 'module.exports = 1',
      '.git/config': '[remote "origin"]\n  url = https://tok@example.com/a.git',
      '.ssh/id_rsa': 'KEYBYTES',
      '.aws/credentials': 'aws_secret_access_key = tok',
      'dist/bundle.js': 'built',
      'package.json': '{"name":"a"}',
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['package.json'])
    expect(JSON.stringify(snapshot.files)).not.toContain('tok')
    for (const directory of ['node_modules', '.git', '.ssh', '.aws', 'dist']) {
      expect(reasonFor(snapshot, directory)).toBeTruthy()
    }
  })

  it('reads .github, the one hidden directory that describes the project', async () => {
    const root = await projectWith({
      '.github/workflows/deploy.yml': 'on: push\n',
      '.vscode/settings.json': '{}',
      'package.json': '{"name":"a"}',
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['.github/workflows/deploy.yml', 'package.json'])
    expect(reasonFor(snapshot, '.vscode')).toBeTruthy()
  })

  it('keeps a file exactly at the byte cap and skips the one a byte over', async () => {
    const root = await projectWith({
      'at-cap.txt': 'x'.repeat(PROJECT_LIMITS.maxFileBytes),
      'over-cap.txt': 'y'.repeat(PROJECT_LIMITS.maxFileBytes + 1),
    })
    const snapshot = await readProject(root)
    expect(pathsOf(snapshot)).toEqual(['at-cap.txt'])
    expect(snapshot.files[0]?.text).toHaveLength(PROJECT_LIMITS.maxFileBytes)
    expect(reasonFor(snapshot, 'over-cap.txt')).toContain(String(PROJECT_LIMITS.maxFileBytes))
    // Skipping one oversized file is not a walk that stopped: the rest of the
    // project was read, and `truncated` must not claim otherwise.
    expect(snapshot.truncated).toBe(false)
  })

  it('stops at the file cap and says it truncated', async () => {
    const root = await temp()
    for (let index = 0; index < PROJECT_LIMITS.maxFiles + 50; index += 1) {
      await writeFile(path.join(root, `f${String(index).padStart(3, '0')}.txt`), 'x')
    }
    const snapshot = await readProject(root)
    expect(snapshot.files).toHaveLength(PROJECT_LIMITS.maxFiles)
    expect(snapshot.truncated).toBe(true)
    expect(pathsOf(snapshot)[0]).toBe('f000.txt')
    expect(pathsOf(snapshot).at(-1)).toBe('f199.txt')
    expect(reasonFor(snapshot, 'f200.txt')).toContain(String(PROJECT_LIMITS.maxFiles))
  })

  it('stops at the total-bytes cap and says it truncated', async () => {
    const root = await temp()
    const each = PROJECT_LIMITS.maxFileBytes
    const count = Math.floor(PROJECT_LIMITS.maxTotalBytes / each) + 1
    for (let index = 0; index < count; index += 1) {
      await writeFile(path.join(root, `b${String(index).padStart(2, '0')}.txt`), 'x'.repeat(each))
    }
    const snapshot = await readProject(root)
    expect(snapshot.files).toHaveLength(count - 1)
    expect(snapshot.truncated).toBe(true)
    const total = snapshot.files.reduce((sum, file) => sum + file.text.length, 0)
    expect(total).toBeLessThanOrEqual(PROJECT_LIMITS.maxTotalBytes)
    expect(reasonFor(snapshot, `b${String(count - 1).padStart(2, '0')}.txt`)).toContain(
      String(PROJECT_LIMITS.maxTotalBytes),
    )
  })

  it('returns the same snapshot twice, in the same order', async () => {
    // A recording replays only if the read is a function of the disk and
    // nothing else — readdir order is not sorted, and on some filesystems it
    // is not even stable.
    const root = await projectWith({
      'src/b.ts': 'b',
      'src/a.ts': 'a',
      'z/last.ts': 'z',
      'README.md': 'r',
      'a/nested/deep.ts': 'd',
    })
    const first = await readProject(root)
    const second = await readProject(root)
    expect(second).toEqual(first)
    expect(pathsOf(first)).toEqual([
      'README.md',
      'a/nested/deep.ts',
      'src/a.ts',
      'src/b.ts',
      'z/last.ts',
    ])
  })

  it('reads an empty project without pretending it failed', async () => {
    const snapshot = await readProject(await temp())
    expect(snapshot.files).toEqual([])
    expect(snapshot.skipped).toEqual([])
    expect(snapshot.truncated).toBe(false)
  })

  it('says so when the root does not exist', async () => {
    // An empty snapshot and a missing repository must not look alike: the
    // second is a user error and has to be visible as one.
    const root = path.join(await temp(), 'nowhere')
    const snapshot = await readProject(root)
    expect(snapshot.files).toEqual([])
    expect(snapshot.skipped).toHaveLength(1)
    expect(snapshot.skipped[0]?.reason.length).toBeGreaterThan(0)
    expect(snapshot.truncated).toBe(false)
  })

  it('says so when the root is a file', async () => {
    const root = await projectWith({ 'package.json': '{}' })
    const snapshot = await readProject(path.join(root, 'package.json'))
    expect(snapshot.files).toEqual([])
    expect(snapshot.skipped).toHaveLength(1)
  })

  it('reports a reason for every single thing it did not read', async () => {
    const root = await projectWith({
      '.env': 'A=1',
      'node_modules/a/index.js': 'x',
      'logo.png': 'P\u0000G',
      'huge.txt': 'x'.repeat(PROJECT_LIMITS.maxFileBytes + 1),
      'src/app.ts': 'ok',
    })
    const snapshot = await readProject(root)
    expect(snapshot.skipped.map((entry) => entry.path)).toEqual([
      '.env',
      'huge.txt',
      'logo.png',
      'node_modules',
    ])
    expect(snapshot.skipped.every((entry) => entry.reason.trim().length > 0)).toBe(true)
  })
})

describe('an alias is not a disguise', () => {
  // The defect this module first shipped, found by attacking it rather than by
  // reading it: exclusion was decided on the directory entry's NAME. Every rule
  // in the list was then one symlink away from being defeated, and the snapshot
  // said so in the same breath — `.env` listed as excluded, and its bytes
  // returned under another name two lines below.

  it('refuses a link whose target is an excluded file', async () => {
    const root = await projectWith({
      '.env': 'MISTRAL_API_KEY=sk-super-secret',
      'package.json': '{"name":"x"}',
    })
    await symlink(path.join(root, '.env'), path.join(root, 'notes.md'))

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot.files)).not.toContain('sk-super-secret')
    expect(snapshot.files.map((file) => file.path)).toEqual(['package.json'])
    expect(snapshot.skipped.map((one) => one.path)).toContain('notes.md')
  })

  it('refuses a link whose target is an excluded directory', async () => {
    const root = await projectWith({
      '.git/config': '[remote]\n  url = https://TOKEN@github.com/x',
      'package.json': '{"name":"x"}',
    })
    await symlink(path.join(root, '.git'), path.join(root, 'docs'))

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot.files)).not.toContain('TOKEN@')
    expect(snapshot.skipped.map((one) => one.path)).toContain('docs')
  })

  it('refuses a link that aims INTO an excluded directory', async () => {
    // The basename is innocent; the ancestor is the whole point of the list.
    const root = await projectWith({
      '.git/config': '[remote]\n  url = https://TOKEN@github.com/x',
      'nested/keep.md': '# notes',
    })
    await symlink(path.join(root, '.git', 'config'), path.join(root, 'nested', 'readme.txt'))

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot.files)).not.toContain('TOKEN@')
    const refusal = snapshot.skipped.find((one) => one.path === 'nested/readme.txt')
    expect(refusal?.reason).toContain('.git/')
  })

  it('still reads a link that stays inside and aims at nothing excluded', async () => {
    // Refusing every link would be easy and wrong: a monorepo links a shared
    // config into a package, and that file is a fact about the project.
    const root = await projectWith({ 'shared/tsconfig.json': '{"strict":true}' })
    await symlink(path.join(root, 'shared', 'tsconfig.json'), path.join(root, 'tsconfig.json'))

    const snapshot = await readProject(root)

    expect(snapshot.files.map((file) => file.path)).toContain('tsconfig.json')
  })
})

describe('the content rule has no blind spot', () => {
  it('finds a private key past the first 8 KiB', async () => {
    // The backstop for "a name is the author's to choose". One that stops
    // looking part way through is one a key can simply be placed past.
    const root = await projectWith({
      'notes.md': `${'filler line\n'.repeat(900)}-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n`,
    })

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot.files)).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(snapshot.skipped.find((one) => one.path === 'notes.md')?.reason).toContain(
      'private key',
    )
  })

  it('excludes .envrc, whose whole content is exported secrets', async () => {
    const root = await projectWith({ '.envrc': 'export AWS_SECRET_ACCESS_KEY=abcd' })

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot.files)).not.toContain('abcd')
    expect(snapshot.skipped.map((one) => one.path)).toContain('.envrc')
  })
})

describe('what leaves this module is bounded, all of it', () => {
  it('caps the reason list too, and says how many it did not list', async () => {
    // `skipped` travels in the same snapshot as `files` and reaches the same
    // model. A cap on what is read is not a cap on what is sent.
    const files: Record<string, string> = {}
    for (let index = 0; index < PROJECT_LIMITS.maxSkipped + 40; index += 1) {
      files[`secrets/key-${String(index).padStart(4, '0')}.pem`] = 'x'
    }
    const root = await projectWith(files)

    const snapshot = await readProject(root)

    expect(snapshot.skipped.length).toBeLessThanOrEqual(PROJECT_LIMITS.maxSkipped + 1)
    expect(snapshot.skipped.at(-1)?.reason).toMatch(/more not listed/)
    expect(snapshot.truncated).toBe(true)
  })

  it('refuses a hard link, which has no target to resolve', async () => {
    // A hard link inside the project and a name outside it are the same inode,
    // equally real: realpath cannot say where it leads, so containment has
    // nothing to test. Named, never silent.
    const root = await projectWith({ 'package.json': '{"name":"x"}' })
    const outside = path.join(await temp(), 'secret.txt')
    await writeFile(outside, 'SECRET_FROM_OUTSIDE')
    await link(outside, path.join(root, 'innocent.txt'))

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot.files)).not.toContain('SECRET_FROM_OUTSIDE')
    expect(snapshot.skipped.find((one) => one.path === 'innocent.txt')?.reason).toContain(
      'hard link',
    )
  })
})
