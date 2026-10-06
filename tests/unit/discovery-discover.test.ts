import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Walked } from '../../src/core/discovery/allow.js'
import { verifiedFindings } from '../../src/core/discovery/report.js'
import type { Dropped, Reread } from '../../src/core/discovery/verify.js'
import { blobId } from '../../src/core/git/blob.js'
import { discover } from '../../src/context/discovery/discover.js'
import { readDiscovery, type DiscoveryRead, type OpenedFile } from '../../src/context/discovery/read.js'

/**
 * `discover`, step by step (plan, Task 1.4): what it does with each outcome
 * of the re-read, with an extractor that throws, and at the run's finding
 * cap. The read is scripted (`readDiscovery` mocked), so a re-read can say
 * what no repository on this disk would at that moment: a commit made during
 * the run, a file changed since `HEAD`, one now discarded whole. The
 * extractors are the real ones, counted, and made to throw on a path asked.
 *
 * A stale file is extracted again only from a committed `Reread`, never from
 * a `Dropped`, and a file the re-read drops is extracted from nothing.
 */

const state = vi.hoisted(() => ({ calls: [] as string[], throwing: new Set<string>() }))

vi.mock('../../src/context/discovery/read.js', () => ({ readDiscovery: vi.fn() }))

vi.mock('../../src/core/discovery/extractors.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/discovery/extractors.js')>()
  const counted =
    (name: keyof typeof real.EXTRACTORS) =>
    (path: string, bytes: Buffer): ReturnType<(typeof real.EXTRACTORS)[typeof name]> => {
      state.calls.push(path)
      if (state.throwing.has(path)) throw new Error('an extractor failed on a file, an engine bug')
      return real.EXTRACTORS[name](path, bytes)
    }
  return { ...real, EXTRACTORS: Object.freeze({ 'env-file': counted('env-file'), npm: counted('npm') }) }
})

afterEach(() => {
  state.calls.length = 0
  state.throwing.clear()
  vi.mocked(readDiscovery).mockReset()
})

const manifest = (name: string, clients: readonly string[] = ['pg']): string =>
  `${JSON.stringify({ name, dependencies: Object.fromEntries(clients.map((client) => [client, '^1.0.0'])) }, null, 2)}\n`

/** Every buffer the scripted read handed out, so the test can see each was zeroed. */
let handed: Buffer[] = []

const committedAs = (path: string, text: string): Reread => {
  const bytes = Buffer.from(text)
  handed.push(bytes)
  return { path, bytes, committed: blobId(Buffer.from(text), 'sha1'), objectFormat: 'sha1' }
}

type Script = (path: string, asked: number) => Reread | Dropped | undefined

/**
 * A read of `files`, all committed at `HEAD`; `again` scripts each re-read of
 * a path by how many times it was asked (1 first), and is `HEAD`'s same bytes
 * when it says nothing.
 */
function scripted(files: Readonly<Record<string, string>>, again: Readonly<Record<string, Script>> = {}) {
  const asked: string[] = []
  const opened = Object.keys(files)
  const read: DiscoveryRead = {
    selection: 'git',
    head: 'c0ffee1'.padEnd(40, '0'),
    opened,
    notAnalysed: [],
    byDesign: [],
    untracked: 0,
    staged: 0,
    unlisted: 0,
    unnameable: 0,
    truncated: false,
    objectFormat: 'sha1',
    files: opened.map((path): OpenedFile => {
      const bytes = Buffer.from(files[path] ?? '')
      handed.push(bytes)
      return {
        path,
        bytes,
        sha256: '',
        extractor: path.endsWith('package.json') ? 'npm' : 'env-file',
        format: path.endsWith('package.json') ? 'json' : 'dotenv',
        standing: path.endsWith('package.json') ? 'evidence' : 'sample',
      } as OpenedFile
    }),
    reread: (path: string) => {
      asked.push(path)
      const script = again[path]
      const reply = script === undefined ? committedAs(path, files[path] ?? '') : script(path, asked.filter((one) => one === path).length)
      return Promise.resolve(reply)
    },
  }
  vi.mocked(readDiscovery).mockResolvedValue(read)
  return { asked }
}

const zeroed = (): void => {
  for (const bytes of handed) expect(bytes.every((byte) => byte === 0)).toBe(true)
  handed = []
}

const reasons = (walked: { readonly notAnalysed: Walked['notAnalysed'] }) =>
  walked.notAnalysed.map((entry) => [entry.path, entry.why])

describe('discover', () => {
  it('extracts a file again from a commit made during the run, and checks it against a third read', async () => {
    const before = manifest('billing-api')
    const after = manifest('billing-service', ['pg', 'ioredis'])
    scripted({ 'package.json': before }, { 'package.json': (path) => committedAs(path, after) })
    const { coverage } = await discover('/repository')
    expect(coverage.analysed).toEqual([
      { path: 'package.json', extractor: 'npm', standing: 'evidence', findings: 3, dropped: 0 },
    ])
    expect(coverage.findings.map((finding) => finding.fields.name ?? finding.fields.package)).toEqual([
      'billing-service',
      'pg',
      'ioredis',
    ])
    expect(verifiedFindings(coverage)).toBe(3)
    zeroed()
  })

  it('says a file that changed again at the third read changed during the run, and keeps none of it', async () => {
    scripted(
      { 'package.json': manifest('billing-api') },
      { 'package.json': (path, asked) => committedAs(path, manifest(asked === 1 ? 'second' : 'third')) },
    )
    const { coverage } = await discover('/repository')
    expect(coverage.analysed).toEqual([])
    expect(reasons(coverage)).toEqual([['package.json', 'changed-during-run']])
    expect(coverage.findings).toEqual([])
    zeroed()
  })

  it('extracts nothing from a file the re-read dropped as changed since HEAD', async () => {
    const { asked } = scripted(
      { 'package.json': manifest('billing-api') },
      { 'package.json': (path) => ({ path, dropped: 'changed' }) },
    )
    const { coverage } = await discover('/repository')
    expect(reasons(coverage)).toEqual([['package.json', 'changed-during-run']])
    expect(coverage.findings).toEqual([])
    expect(asked).toEqual(['package.json'])
    // The first extraction, and no other: a Dropped has no bytes to read.
    expect(state.calls).toEqual(['package.json'])
    zeroed()
  })

  it('extracts nothing from bytes the re-read hands back that are not HEAD’s', async () => {
    scripted(
      { 'package.json': manifest('billing-api') },
      {
        'package.json': (path) => {
          const bytes = Buffer.from(manifest('not-committed'))
          handed.push(bytes)
          return { path, bytes, committed: undefined, objectFormat: 'sha1' }
        },
      },
    )
    const { coverage } = await discover('/repository')
    expect(reasons(coverage)).toEqual([['package.json', 'changed-during-run']])
    expect(coverage.findings).toEqual([])
    expect(state.calls).toEqual(['package.json'])
    zeroed()
  })

  it.each(['discarded-secret', 'discarded-sops'] as const)(
    'sets aside by design a file the re-read finds %s, as the read would',
    async (why) => {
      scripted({ '.env.example': 'REDIS_URL=redis://localhost:6379\n' }, { '.env.example': (path) => ({ path, dropped: why }) })
      const { coverage } = await discover('/repository')
      expect(coverage.analysed).toEqual([])
      expect(coverage.byDesign).toEqual([{ path: '.env.example', why }])
      expect(coverage.notAnalysed).toEqual([])
      expect(coverage.findings).toEqual([])
      expect(state.calls).toEqual(['.env.example'])
      zeroed()
    },
  )

  it('says a file the re-read could not parse is not analysed for that reason', async () => {
    scripted({ 'package.json': manifest('billing-api') }, { 'package.json': (path) => ({ path, dropped: 'parse-failure' }) })
    const { coverage } = await discover('/repository')
    expect(reasons(coverage)).toEqual([['package.json', 'parse-failure']])
    expect(coverage.findings).toEqual([])
    zeroed()
  })

  it('makes an extractor that throws the file’s parse failure, and never rethrows', async () => {
    state.throwing.add('packages/a/package.json')
    scripted({ 'package.json': manifest('billing-api'), 'packages/a/package.json': manifest('a') })
    const { coverage } = await discover('/repository')
    expect(coverage.analysed.map((file) => file.path)).toEqual(['package.json'])
    expect(coverage.notAnalysed).toEqual([{ path: 'packages/a/package.json', why: 'parse-failure' }])
    expect(verifiedFindings(coverage)).toBe(2)
    zeroed()
  })

  it('makes an extractor that throws on a commit made during the run the file’s parse failure', async () => {
    scripted(
      { 'package.json': manifest('billing-api') },
      {
        'package.json': (path) => {
          state.throwing.add(path)
          return committedAs(path, manifest('billing-service'))
        },
      },
    )
    const { coverage } = await discover('/repository')
    expect(coverage.notAnalysed).toEqual([{ path: 'package.json', why: 'parse-failure' }])
    expect(coverage.analysed).toEqual([])
    zeroed()
  })

  it('names every file past the run’s cap, and never reads one again', async () => {
    const { asked } = scripted({
      'a/package.json': manifest('a', ['pg', 'ioredis']),
      'b/package.json': manifest('b', ['pg', 'ioredis']),
      'c/package.json': manifest('c'),
    })
    const { coverage } = await discover('/repository', { limits: { maxFindingsPerRun: 4 } })
    expect(coverage.analysed.map((file) => file.path)).toEqual(['a/package.json'])
    expect(reasons(coverage)).toEqual([
      ['b/package.json', 'past-run-cap'],
      ['c/package.json', 'past-run-cap'],
    ])
    expect(asked).toEqual(['a/package.json'])
    zeroed()
  })

  it('keeps a file past the cap there when a file before it says less once read again', async () => {
    // a: 3 findings, b: 2, cap 4, so b is past it. a, extracted again from a
    // commit made during the run, says 1: b would fit now, and was never read
    // again, so it stays past the cap rather than be listed with no finding.
    const { asked } = scripted(
      { 'a/package.json': manifest('a', ['pg', 'ioredis']), 'b/package.json': manifest('b') },
      { 'a/package.json': (path) => committedAs(path, manifest('a', [])) },
    )
    const { coverage } = await discover('/repository', { limits: { maxFindingsPerRun: 4 } })
    expect(coverage.analysed).toEqual([
      { path: 'a/package.json', extractor: 'npm', standing: 'evidence', findings: 1, dropped: 0 },
    ])
    expect(reasons(coverage)).toEqual([['b/package.json', 'past-run-cap']])
    expect(asked.filter((path) => path === 'b/package.json')).toEqual([])
    zeroed()
  })

  it('is a read of nothing when the read throws', async () => {
    vi.mocked(readDiscovery).mockRejectedValue(new Error('Qz7 a message that quotes the bytes'))
    const { coverage, checked } = await discover('/repository')
    expect(coverage.selection).toBe('none')
    expect(checked).toEqual([])
  })
})
