import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { link, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openToRead } from '../../src/confine/confine.js'
import { readDiscovery, type DiscoveryRead } from '../../src/context/discovery/read.js'
import { committed, git, observable, stored } from '../support/git.js'
import { PROPERTY_TIMEOUT } from '../invariants/budget.js'

/**
 * Stage 8's discovery read (plan, Task 1.2): from what git tracks in a
 * service's repository, it opens only the allow-listed configuration files,
 * through the confinement primitive, and keeps their bytes only when they are
 * `HEAD`'s. Every repository below is a temporary one made with the git on the
 * machine, because "tracked" and "committed" are facts only git can state.
 *
 * `openToRead` is wrapped in a spy that calls the real function through: what
 * it was called with is the proof of what was opened. The absence of an
 * `unreadable` reason is not, because a run as root reads a `chmod 000` file.
 *
 * NO REAL SECRET IS WRITTEN HERE: every password below is a marked placeholder.
 */

vi.mock('../../src/confine/confine.js', async (original) => {
  const real = await original<typeof import('../../src/confine/confine.js')>()
  return { ...real, openToRead: vi.fn(real.openToRead) }
})

const opens = vi.mocked(openToRead)

beforeEach(() => {
  opens.mockClear()
})

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-discovery-'))

const write = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

/** The paths `openToRead` was handed, relative to `root`, in call order. */
const openedPaths = async (root: string): Promise<string[]> => {
  const real = await realpath(root)
  return opens.mock.calls.map(([, absolute]) => path.relative(real, absolute).split(path.sep).join('/'))
}

/** The read as JSON, every byte of a file left out: what a report or a trace could carry. */
const named = (read: DiscoveryRead): string =>
  JSON.stringify(read, (key, value: unknown) => (key === 'bytes' ? undefined : value))

/** Every string the read holds, a file's bytes decoded among them. */
const leaves = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Buffer.isBuffer(value)) return [value.toString('latin1')]
  if (Array.isArray(value)) return value.flatMap(leaves)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...leaves(inner)])
  }
  return []
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const PACKAGE = '{\n  "name": "invoicing-worker",\n  "dependencies": { "mysql2": "^3.9.0" }\n}\n'
const SAMPLE = 'DATABASE_URL=mysql://app_billing:placeholder-not-a-secret@localhost:3306/billing\n'

/**
 * Whether the filesystem under the temporary folder folds case, and Unicode
 * normalization, probed once: a file written under one spelling, asked for
 * under another. APFS folds both, and git on macOS (`core.ignorecase`,
 * `core.precomposeunicode`) then tracks a file under a spelling its folder
 * does not list. Linux's filesystems fold neither: two spellings are two
 * files there, git tracks each under its own, and a test of one file under
 * two spellings skips, because nothing there can stage one.
 */
const probe = await mkdtemp(path.join(tmpdir(), 'idp-discovery-probe-'))
await writeFile(path.join(probe, 'probe-\u00e9'), '')
const FOLDS_CASE = await lstat(path.join(probe, 'PROBE-\u00e9')).then(
  () => true,
  () => false,
)
const FOLDS_NORMALIZATION = await lstat(path.join(probe, 'probe-e\u0301')).then(
  () => true,
  () => false,
)
await rm(probe, { recursive: true, force: true })

/** `café`, composed (NFC) as git on macOS commits it, and decomposed (NFD) as Finder writes it. */
const COMPOSED = 'caf\u00e9'
const DECOMPOSED = 'cafe\u0301'

/**
 * git, isolated as `tests/support/git.ts` isolates it, handed bytes on its
 * standard input: the one way a path that is not UTF-8 reaches an index, since
 * an argument is a string and APFS refuses such a name on disk.
 */
const gitWithInput = (repo: string, input: Buffer, ...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], {
    input,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
}

describe('the discovery read', () => {
  it('opens the allow-listed files a commit holds, and nothing else', async () => {
    const repo = await temp()
    await write(repo, {
      'package.json': PACKAGE,
      '.env.example': SAMPLE,
      'README.md': '# invoicing-worker\n',
      'src/index.ts': 'export const start = () => 0\n',
      'deploy/prod.env': 'DATABASE_URL=mysql://app_billing:placeholder-prod-marker@db:3306/billing\n',
      id_rsa: 'placeholder, not a key\n',
      '.aws/credentials': '[default]\nplaceholder = not-a-key\n',
      // Allow-listed names where credentials live, and where code is
      // generated: ruled out before the allow-list is consulted, so never
      // opened. `secrets/`, not `.aws/`, for the sample: APFS folds case.
      '.ssh/package.json': '{ "name": "placeholder-ssh-marker" }\n',
      'secrets/.env.example': 'TOKEN=placeholder-secrets-marker\n',
      'node_modules/pg/package.json': '{ "name": "pg" }\n',
    })
    const head = await committed(repo)

    const read = await readDiscovery(repo)

    expect(await openedPaths(repo)).toEqual(['.env.example', 'package.json'])
    for (const call of opens.mock.calls) expect(call[2]).toEqual({ nonBlocking: true })
    expect(read.selection).toBe('git')
    expect(read.head).toBe(head)
    expect(read.objectFormat).toBe('sha1')
    expect(read.opened).toEqual(['.env.example', 'package.json'])
    expect(read.files.map((file) => [file.path, file.bytes.toString('utf8'), file.sha256])).toEqual([
      ['.env.example', SAMPLE, sha256(SAMPLE)],
      ['package.json', PACKAGE, sha256(PACKAGE)],
    ])
    expect(read.files.map((file) => [file.extractor, file.format, file.standing])).toEqual([
      ['env-file', 'dotenv', 'sample'],
      ['npm', 'json', 'evidence'],
    ])
    expect(read.notAnalysed).toEqual([
      { path: 'README.md', why: 'no-rule' },
      { path: 'node_modules/pg/package.json', why: 'generated' },
      { path: 'src/index.ts', why: 'code' },
    ])
    expect(read.byDesign).toEqual([
      { path: '.aws/credentials', why: 'cloud-credentials' },
      { path: '.ssh/package.json', why: 'key-material' },
      { path: 'deploy/prod.env', why: 'environment-file' },
      { path: 'id_rsa', why: 'key-material' },
      { path: 'secrets/.env.example', why: 'credential-store' },
    ])
    expect(read.untracked).toBe(0)
    expect(read.truncated).toBe(false)
    for (const marker of ['placeholder-prod-marker', 'placeholder-ssh-marker', 'placeholder-secrets-marker']) {
      expect(leaves(read).some((leaf) => leaf.includes(marker)), marker).toBe(false)
    }
  })

  it(
    'puts every walked path HEAD holds in exactly one group, and counts the rest',
    async () => {
      const POOL = [
        'package.json',
        'svc/package.json',
        '.env.example',
        'cfg/.env.sample',
        '.env',
        'id_rsa',
        '.ssh/config',
        'src/a.ts',
        'src/b.py',
        'README.md',
        'docs/guide.md',
        'node_modules/x/package.json',
        'dist/out.js',
        'notes/n.md',
        'Dockerfile',
      ] as const
      // `staged`: added after the commit and never committed, so in the index
      // and not in HEAD; `staged-gone` is that, then removed from the working tree.
      const FATES = ['committed', 'untracked', 'deleted', 'staged', 'staged-gone'] as const
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 12 }),
          fc.array(fc.constantFrom(...FATES), { minLength: 12, maxLength: 12 }),
          fc.constantFrom('none', 'tracked', 'untracked'),
          async (files, fates, linked) => {
            const repo = await temp()
            await write(repo, Object.fromEntries(files.map((file) => [file, `${file}\n`])))
            // A folder that is a link: git tracks the link, never what it leads to.
            if (linked !== 'none') await symlink('src', path.join(repo, 'lnk'))
            await git(repo, 'init', '-q', '-b', 'main')
            await git(repo, 'config', 'user.name', 'idp-agent tests')
            await git(repo, 'config', 'user.email', 'tests@idp-agent.invalid')
            const fated = (...wanted: (typeof FATES)[number][]): string[] =>
              files.filter((_, at) => wanted.includes(fates[at] ?? 'committed'))
            const added = fated('committed', 'deleted')
            if (linked === 'tracked') added.push('lnk')
            if (added.length > 0) await git(repo, 'add', '-f', '--', ...added)
            await git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
            const staged = fated('staged', 'staged-gone')
            if (staged.length > 0) await git(repo, 'add', '-f', '--', ...staged)
            for (const file of fated('deleted', 'staged-gone')) await rm(path.join(repo, file))

            const read = await readDiscovery(repo)

            const groups = [
              ...read.opened,
              ...read.notAnalysed.map((entry) => entry.path),
              ...read.byDesign.map((entry) => entry.path),
            ]
            const list = async (...args: string[]): Promise<string[]> =>
              (await git(repo, ...args)).split('\0').filter((entry) => entry !== '')
            const tracked = await list('ls-files', '-z', '--cached')
            const atHead = new Set(await list('ls-tree', '-r', '-z', '--full-tree', '--name-only', 'HEAD'))
            // Named: what HEAD holds and the index still lists. Counted and
            // never named: what the index holds and HEAD does not.
            expect(new Set(groups).size).toBe(groups.length)
            expect([...groups].sort()).toEqual(tracked.filter((entry) => atHead.has(entry)).sort())
            expect(read.staged).toBe(tracked.filter((entry) => !atHead.has(entry)).length)
            expect(read.unlisted).toBe(0)
            const others = await list('ls-files', '-z', '--others', '--directory')
            expect(read.untracked).toBe(others.length)
            expect(read.truncated).toBe(false)
          },
        ),
        { numRuns: 20 },
      )
    },
    PROPERTY_TIMEOUT,
  )

  it('keeps nothing of a file changed since HEAD, staged or not', async () => {
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE, '.env.example': SAMPLE })
    await committed(repo)
    await write(repo, {
      '.env.example': 'DATABASE_URL=mysql://app:Qz7-edited@localhost:3306/billing\n',
      'package.json': '{ "name": "Qz7-staged" }\n',
    })
    await git(repo, 'add', 'package.json')

    const read = await readDiscovery(repo)

    expect(read.notAnalysed).toEqual([
      { path: '.env.example', why: 'not-committed' },
      { path: 'package.json', why: 'not-committed' },
    ])
    expect(read.opened).toEqual([])
    expect(read.files).toEqual([])
    const strings = leaves(read)
    expect(strings.some((leaf) => leaf.includes('Qz7-edited') || leaf.includes('Qz7-staged'))).toBe(false)
    // Read once to be hashed, and never again.
    expect(await openedPaths(repo)).toEqual(['.env.example', 'package.json'])
  })

  it('counts what git does not track, and names none of it', async () => {
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE, 'README.md': '# x\n' })
    await committed(repo)
    await write(repo, {
      '.env': 'DATABASE_URL=mysql://app:placeholder-untracked@db:3306/billing\n',
      'notes/customer-x.md': 'an incident\n',
    })

    const read = await readDiscovery(repo)

    expect(read.untracked).toBe(2)
    expect(read.opened).toEqual(['package.json'])
    const text = named(read)
    expect(text).not.toContain('.env')
    expect(text).not.toContain('customer-x')
    expect(await openedPaths(repo)).toEqual(['package.json'])
  })

  it('never names a path staged and never committed, and counts it', async () => {
    // `ls-files --cached` lists the index: a file someone ran `git add` on is
    // tracked before any commit holds it, and its name is not committed.
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE })
    await committed(repo)
    await write(repo, { 'notes/customer-x.md': 'an incident, placeholder-staged-marker\n' })
    await git(repo, 'add', '--', 'notes/customer-x.md')

    const read = await readDiscovery(repo)

    expect(leaves(read).filter((leaf) => leaf.includes('customer-x') || leaf.includes('placeholder-staged-marker'))).toEqual(
      [],
    )
    expect(read.staged).toBe(1)
    expect(read.untracked).toBe(0)
    expect(read.opened).toEqual(['package.json'])
    expect(await openedPaths(repo)).toEqual(['package.json'])
  })

  it('follows no link, and no second name', async () => {
    const repo = await temp()
    await write(repo, {
      'manifest.json': PACKAGE,
      'config/copy.txt': SAMPLE,
      '.env.example': '',
    })
    await symlink('manifest.json', path.join(repo, 'package.json'))
    await link(path.join(repo, 'config/copy.txt'), path.join(repo, 'config/.env.example'))
    await committed(repo)
    // Committed as an empty file, then replaced by a pipe nobody writes to:
    // an open of it would wait forever.
    await rm(path.join(repo, '.env.example'))
    execFileSync('mkfifo', [path.join(repo, '.env.example')])

    const read = await readDiscovery(repo)

    expect(read.notAnalysed).toEqual([
      { path: '.env.example', why: 'not-a-file' },
      { path: 'config/.env.example', why: 'link' },
      { path: 'config/copy.txt', why: 'no-rule' },
      { path: 'manifest.json', why: 'no-rule' },
      { path: 'package.json', why: 'link' },
    ])
    expect(read.opened).toEqual([])
    expect(opens).not.toHaveBeenCalled()
  })

  it('takes no link HEAD holds for a file of the same bytes', async () => {
    // A committed link's blob is its target's name. A regular file holding
    // exactly that name hashes to the same blob, and was never committed as a
    // file: only the mode of HEAD's entry tells the two apart.
    const repo = await temp()
    await write(repo, { 'target.txt': PACKAGE })
    await symlink('target.txt', path.join(repo, 'package.json'))
    await committed(repo)
    await rm(path.join(repo, 'package.json'))
    await writeFile(path.join(repo, 'package.json'), 'target.txt')

    const read = await readDiscovery(repo)

    expect(read.notAnalysed).toEqual([
      { path: 'package.json', why: 'not-committed' },
      { path: 'target.txt', why: 'no-rule' },
    ])
    expect(read.opened).toEqual([])
    expect(read.files).toEqual([])
    expect(opens).not.toHaveBeenCalled()
  })

  it('reads nothing when the repository names another directory as its work tree', async () => {
    // `core.worktree` is the repository's own configuration: git answers about
    // the folder it names, and lists that folder's index as if it were this
    // one's — so without the check, the `package.json` beside `.git` would be
    // read as committed.
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE })
    await committed(repo)
    await git(repo, 'config', 'core.worktree', await temp())

    const read = await readDiscovery(repo)

    expect(read.selection).toBe('none')
    expect(read.opened).toEqual([])
    expect(read.notAnalysed).toEqual([])
    expect(opens).not.toHaveBeenCalled()
  })

  it('reads no file over the cap, and cuts none', async () => {
    const repo = await temp()
    const frame = '{ "name": "x", "description": "" }\n'
    const large = frame.replace('""', `"${'a'.repeat(70_000 - frame.length)}"`)
    expect(Buffer.byteLength(large)).toBe(70_000)
    await write(repo, { 'package.json': large, '.env.example': SAMPLE })
    await committed(repo)

    const read = await readDiscovery(repo)

    expect(read.notAnalysed).toEqual([{ path: 'package.json', why: 'over-size' }])
    expect(read.opened).toEqual(['.env.example'])
  })

  it('opens nothing and names nothing outside a git repository', async () => {
    const folder = await temp()
    await write(folder, {
      'package.json': PACKAGE,
      '.env.example': SAMPLE,
      'notes/customer-x.md': 'an incident\n',
    })

    const read = await readDiscovery(folder)

    expect(read.selection).toBe('walk')
    expect(read.head).toBeUndefined()
    expect(read.opened).toEqual([])
    expect(read.notAnalysed).toEqual([])
    expect(read.byDesign).toEqual([])
    expect(read.files).toEqual([])
    expect(read.untracked).toBe(3)
    expect(opens).not.toHaveBeenCalled()
    const text = named(read)
    expect(text).not.toContain('customer-x')
    expect(text).not.toContain('.env.example')
  })

  it('reads nothing where git cannot list', async () => {
    const folder = await temp()
    await write(folder, {
      '.git': 'gitdir: /nonexistent/idp-agent/worktrees/gone\n',
      'package.json': PACKAGE,
    })

    const read = await readDiscovery(folder)

    expect(read.selection).toBe('none')
    expect(read.opened).toEqual([])
    expect(read.notAnalysed).toEqual([])
    expect(read.byDesign).toEqual([])
    expect(read.untracked).toBe(0)
    expect(opens).not.toHaveBeenCalled()
  })

  it('changes nothing in the repository', async () => {
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE, '.env.example': SAMPLE, 'src/index.ts': 'export {}\n' })
    await committed(repo)
    await write(repo, { '.env.example': 'CHANGED=1\n', 'notes.md': 'untracked\n' })
    const before = [await observable(repo), await stored(repo)]

    await readDiscovery(repo)

    expect([await observable(repo), await stored(repo)]).toEqual(before)
  })

  it('says how far the walk went', async () => {
    const repo = await temp()
    await write(repo, { 'a/x.md': 'a\n', 'b/x.md': 'b\n', 'c/x.md': 'c\n', 'd/x.md': 'd\n' })
    await committed(repo)

    expect((await readDiscovery(repo)).truncated).toBe(false)
    expect((await readDiscovery(repo, { limits: { maxDirectories: 2 } })).truncated).toBe(true)
  })

  it('discards a SOPS-encrypted sample whole', async () => {
    const repo = await temp()
    await write(repo, {
      '.env.example': 'DATABASE_URL=ENC[AES256_GCM,data:placeholder,type:str]\nsops_version=3.8.1\n',
      'package.json': PACKAGE,
    })
    await committed(repo)

    const read = await readDiscovery(repo)

    expect(read.byDesign).toEqual([{ path: '.env.example', why: 'discarded-sops' }])
    expect(read.opened).toEqual(['package.json'])
    expect(read.files.map((file) => file.path)).toEqual(['package.json'])
  })

  it('reads a service in a folder of its repository', async () => {
    const repo = await temp()
    await write(repo, {
      'package.json': '{ "name": "monorepo" }\n',
      'services/api/package.json': PACKAGE,
      'services/api/.env.example': SAMPLE,
      'services/web/package.json': '{ "name": "web" }\n',
    })
    await committed(repo)

    const read = await readDiscovery(path.join(repo, 'services/api'))

    expect(read.selection).toBe('git')
    expect(read.opened).toEqual(['.env.example', 'package.json'])
    expect(read.files.map((file) => file.bytes.toString('utf8'))).toEqual([SAMPLE, PACKAGE])
    expect(await openedPaths(path.join(repo, 'services/api'))).toEqual(['.env.example', 'package.json'])
  })

  it('opens nothing and names nothing when HEAD cannot be listed whole', async () => {
    // Nothing can be shown committed, so every path git tracks is counted, for
    // the one reason the report prints, and none is named.
    const repo = await temp()
    await write(repo, {
      'package.json': PACKAGE,
      '.env.example': SAMPLE,
      'README.md': '# x\n',
      'deploy/prod.env': 'DATABASE_URL=mysql://app:placeholder-unlisted@db:3306/billing\n',
    })
    const head = await committed(repo)

    const read = await readDiscovery(repo, { git: { maxOutputBytes: 64 } })

    expect(opens).not.toHaveBeenCalled()
    expect(read.head).toBe(head)
    expect(read.opened).toEqual([])
    expect(read.notAnalysed).toEqual([])
    expect(read.byDesign).toEqual([])
    expect(read.unlisted).toBe(4)
    expect(read.staged).toBe(0)
    expect(read.untracked).toBe(0)
    const text = named(read)
    for (const name of ['package.json', '.env.example', 'README.md', 'prod.env']) expect(text).not.toContain(name)
  })

  it('names a tracked file deleted from the working tree', async () => {
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE, '.env.example': SAMPLE, 'z/notes.md': 'z\n' })
    await committed(repo)
    await rm(path.join(repo, 'package.json'))

    const read = await readDiscovery(repo)

    expect(read.notAnalysed).toEqual([
      { path: 'package.json', why: 'deleted' },
      { path: 'z/notes.md', why: 'no-rule' },
    ])
    expect(read.opened).toEqual(['.env.example'])
  })

  it('names nothing under an unborn HEAD, and counts what is staged', async () => {
    // Nothing is committed yet: every path the index holds is staged and
    // never committed, so counted, and none is named or opened.
    const repo = await temp()
    await write(repo, {
      'package.json': PACKAGE,
      '.env.example': SAMPLE,
      'deploy/prod.env': 'DATABASE_URL=mysql://app:placeholder-unborn@db:3306/billing\n',
      'notes.md': 'never added\n',
    })
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'add', '--', 'package.json', '.env.example', 'deploy/prod.env')

    const read = await readDiscovery(repo)

    expect(read.selection).toBe('git')
    expect(read.head).toBeUndefined()
    expect(read.opened).toEqual([])
    expect(read.notAnalysed).toEqual([])
    expect(read.byDesign).toEqual([])
    expect(read.staged).toBe(3)
    expect(read.untracked).toBe(1)
    expect(read.unlisted).toBe(0)
    const text = named(read)
    for (const name of ['package.json', '.env.example', 'prod.env', 'notes.md']) expect(text).not.toContain(name)
    expect(opens).not.toHaveBeenCalled()
  })

  it.skipIf(!FOLDS_CASE)('reads a committed file its folder spells in another case, under git’s name', async () => {
    // APFS folds case: renamed on disk only by case, `package.json` is one
    // file under either spelling, and git (`core.ignorecase`) calls it
    // unchanged. Skipped where the filesystem keeps case.
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE, 'README.md': '# x\n' })
    await committed(repo)
    await rename(path.join(repo, 'package.json'), path.join(repo, 'PACKAGE.JSON'))
    expect(await git(repo, 'status', '--porcelain', '-uall')).toBe('')

    const read = await readDiscovery(repo)

    expect(read.opened).toEqual(['package.json'])
    expect(read.files.map((file) => [file.path, file.bytes.toString('utf8')])).toEqual([['package.json', PACKAGE]])
    expect(read.notAnalysed).toEqual([{ path: 'README.md', why: 'no-rule' }])
    expect(read.untracked).toBe(0)
    // Opened under the spelling the folder lists, named under git's alone.
    expect(await openedPaths(repo)).toEqual(['PACKAGE.JSON'])
    expect(named(read)).not.toContain('PACKAGE.JSON')
  })

  it.skipIf(!FOLDS_NORMALIZATION)(
    'reads a committed folder its parent spells decomposed, under git’s name',
    async () => {
      // Finder writes `café` decomposed (NFD); git on macOS
      // (`core.precomposeunicode`) commits it composed (NFC), and APFS serves
      // the one folder under either spelling. Skipped where the filesystem
      // keeps the two apart.
      const repo = await temp()
      await write(repo, {
        [`${DECOMPOSED}/package.json`]: PACKAGE,
        [`${DECOMPOSED}/notes-${DECOMPOSED}.md`]: 'notes\n',
      })
      await committed(repo)
      const tracked = (await git(repo, 'ls-files', '-z')).split('\0').filter((entry) => entry !== '')
      expect(tracked).toEqual([`${COMPOSED}/notes-${COMPOSED}.md`, `${COMPOSED}/package.json`])
      expect(await git(repo, 'status', '--porcelain', '-uall')).toBe('')

      const read = await readDiscovery(repo)

      expect(read.opened).toEqual([`${COMPOSED}/package.json`])
      expect(read.files.map((file) => file.bytes.toString('utf8'))).toEqual([PACKAGE])
      expect(read.notAnalysed).toEqual([{ path: `${COMPOSED}/notes-${COMPOSED}.md`, why: 'no-rule' }])
      expect(read.untracked).toBe(0)
      expect(await openedPaths(repo)).toEqual([`${DECOMPOSED}/package.json`])
      expect(named(read)).not.toContain(DECOMPOSED)
    },
  )

  it('counts a spelling git tracks in no folder of its own, and names it nowhere', async () => {
    // `b/PACKAGE.JSON` folds to a name git tracks in `a/`, never in `b/`: git
    // does not track it, on any filesystem.
    const repo = await temp()
    await write(repo, { 'a/package.json': PACKAGE, 'b/notes.md': 'b\n' })
    await committed(repo)
    await write(repo, { 'b/PACKAGE.JSON': '{ "name": "placeholder-lookalike-marker" }\n' })

    const read = await readDiscovery(repo)

    expect(read.opened).toEqual(['a/package.json'])
    expect(read.notAnalysed).toEqual([{ path: 'b/notes.md', why: 'no-rule' }])
    expect(read.untracked).toBe(1)
    expect(named(read)).not.toContain('PACKAGE.JSON')
    expect(leaves(read).some((leaf) => leaf.includes('placeholder-lookalike-marker'))).toBe(false)
    expect(await openedPaths(repo)).toEqual(['a/package.json'])
  })

  it.skipIf(FOLDS_CASE)('takes no second name of a tracked file for git’s spelling of it', async () => {
    // Where the filesystem keeps case, `PACKAGE.JSON` beside `package.json` is
    // an entry of its own, here a hard link to it: one file, two entries the
    // folder lists, so not git's spelling of one entry. Skipped on APFS, where
    // the two cannot sit in one folder.
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE })
    await committed(repo)
    await link(path.join(repo, 'package.json'), path.join(repo, 'PACKAGE.JSON'))

    const read = await readDiscovery(repo)

    expect(read.notAnalysed).toEqual([{ path: 'package.json', why: 'link' }])
    expect(read.untracked).toBe(1)
    expect(named(read)).not.toContain('PACKAGE.JSON')
    expect(opens).not.toHaveBeenCalled()
  })

  it.skipIf(FOLDS_CASE)('reads no lookalike for a committed file deleted where case is kept', async () => {
    // Where the filesystem keeps case, `PACKAGE.JSON` is another file than the
    // `package.json` it folds to, which is gone: git's spelling names nothing
    // on disk, so the lookalike is counted and the committed path is deleted,
    // even with `HEAD`'s very bytes. Skipped on APFS, where the two are one.
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE })
    await committed(repo)
    await rm(path.join(repo, 'package.json'))
    await write(repo, { 'PACKAGE.JSON': PACKAGE })

    const read = await readDiscovery(repo)

    expect(read.notAnalysed).toEqual([{ path: 'package.json', why: 'deleted' }])
    expect(read.opened).toEqual([])
    expect(read.untracked).toBe(1)
    expect(named(read)).not.toContain('PACKAGE.JSON')
    expect(opens).not.toHaveBeenCalled()
  })

  it('names no path that is not UTF-8, and merges no two of them', async () => {
    // git's paths are bytes. `HEAD` holds `n\xff.md` beside `package.json`,
    // and the index adds `n\xfe.md`: decoded with replacement, both would be
    // `n\uFFFD.md`, one key, and the second's staging would vanish. Made with
    // plumbing alone, since no file of either name can sit on APFS.
    const repo = await temp()
    await write(repo, { 'package.json': PACKAGE })
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'config', 'user.name', 'idp-agent tests')
    await git(repo, 'config', 'user.email', 'tests@idp-agent.invalid')
    await git(repo, 'add', '--', 'package.json')
    const blob = await git(repo, 'rev-parse', ':package.json')
    const entry = (name: Buffer): Buffer => Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from([0])])
    const ff = Buffer.from([0x6e, 0xff, 0x2e, 0x6d, 0x64])
    const fe = Buffer.from([0x6e, 0xfe, 0x2e, 0x6d, 0x64])
    gitWithInput(repo, entry(ff), 'update-index', '-z', '--index-info')
    await git(repo, 'commit', '-q', '-m', 'base')
    gitWithInput(repo, entry(fe), 'update-index', '-z', '--index-info')

    const read = await readDiscovery(repo)

    expect(read.opened).toEqual(['package.json'])
    expect(read.notAnalysed).toEqual([])
    expect(read.byDesign).toEqual([])
    expect(read.staged).toBe(1)
    expect(read.unnameable).toBe(1)
    expect(read.untracked).toBe(0)
    expect(leaves(read).filter((leaf) => leaf.includes('\uFFFD') || leaf.includes('.md'))).toEqual([])
    expect(await openedPaths(repo)).toEqual(['package.json'])
  })
})
