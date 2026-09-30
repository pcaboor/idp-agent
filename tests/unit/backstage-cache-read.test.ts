import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, type MainDeps } from '../../src/cli/index.js'
import type { CatalogueFetch } from '../../src/context/backstage/transport.js'
import type { AgentName, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults, type Sent } from '../support/fake-backstage.js'
import { memorySink, onlyTrace } from '../support/trace.js'

/**
 * A run that reads a Backstage catalogue with a cache root handed in, as
 * `bin.ts` hands one (docs/plans/backstage-http-slice-2.md, Task 2.3, Step 3):
 * a second run within five minutes answers from the kept copy, sends the
 * catalogue nothing and says how old the copy is; `--refresh` reads Backstage
 * again; `--cached` answers from the copy whatever its age and never asks;
 * a copy that could not be used or kept is said in one line; after a failure
 * of reach the failure line names `--cached` when a copy is kept, never after
 * a 401. Every run goes through `main` with the fake as `catalogueFetch`, and
 * every root is a folder under the run directory.
 *
 * Only the wall clock is faked (`toFake: ['Date']`): the copy's age and the
 * store's TTL read it, and no timer the transport arms is touched. The clock
 * starts at the real one, so the pruning, which reads a file's real `mtime`,
 * sees copies as old as the rows say.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORG_YAML = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
const LOOPBACK = 'http://127.0.0.1:7007/api/catalog'
const AT = 'the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL)'
const WAY_OUT = '; --repo <directory> reads a repository instead, and `idpa plan` decides a change without the catalogue'
const TAIL = 'it may lag the declarations repository by minutes; --repo <directory> reads a repository'
const OWNER = process.getuid?.() ?? -1
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.now()

type Item = Record<string, unknown>

const catalogue = (): Item[] => catalogueOf(DEMO, { org: ORG_YAML })

interface Ran {
  code: number
  out: string
  err: string
  sent: Sent[]
}

interface Options extends MainDeps {
  entities?: readonly Item[]
  faults?: Faults
}

/** One run at `when` after T0, the catalogue the fake unless `catalogueFetch` says otherwise. */
const run = async (argv: string[], when: number, options: Options = {}): Promise<Ran> => {
  vi.setSystemTime(T0 + when)
  const { entities = catalogue(), faults, ...deps } = options
  const fake = fakeBackstage({ entities, ...(faults === undefined ? {} : { faults }) })
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    root: DEMO,
    env: { IDP_BACKSTAGE_URL: LOOPBACK },
    catalogueFetch: fake.fetch,
    events: () => {},
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join(''), sent: fake.sent }
}

const scratch = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-cache-read-'))

/** A cache root made for one row, and the options that hand it to `main`. */
const rooted = async (): Promise<{ dir: string; cacheRoot: { dir: string } }> => {
  const dir = await scratch()
  return { dir, cacheRoot: { dir } }
}

const STORE = (dir: string): string => path.join(dir, 'idp-agent', 'backstage')

/** The key folders under `dir`, each 32 hex characters. */
const keys = async (dir: string): Promise<string[]> =>
  (await readdir(STORE(dir)).catch(() => [] as string[])).filter((name) => /^[0-9a-f]{32}$/.test(name))

/** The one copy under `dir`. */
const theCopy = async (dir: string): Promise<string> => {
  const found = await keys(dir)
  expect(found).toHaveLength(1)
  return path.join(STORE(dir), found[0] ?? '', 'served.json')
}

/** A fetch that never reaches anything: a refused connection, as `fetch` throws one. */
const unreachable: CatalogueFetch = () =>
  Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }))

/** A `fetch` no request may reach. */
const untouchable: CatalogueFetch = async () => {
  throw new Error('the catalogue was requested')
}

const notice = (err: string): string => err.split('\n')[0] ?? ''

const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `c-${name}`, name, args }],
  finishReason: 'tool-calls',
})
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

/** Scripted turns per agent. */
const scripted = (turns: Partial<Record<AgentName, readonly GenerateResult[]>>): LlmClient => {
  const spent = new Map<AgentName, number>()
  return {
    generate: async (request) => {
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? saying('')
    },
  }
}

/** A question answered with the overview: a run that is traced. */
const overviewClient = (): LlmClient =>
  scripted({ supervisor: [saying('QUESTION')], analyst: [calling('answer', { outcome: 'overview' })] })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe.skipIf(process.platform === 'win32' || OWNER === 0)('a catalogue read kept, and read again', () => {
  it('first run: reads Backstage, says what it always said, and keeps a copy', async () => {
    const { dir, cacheRoot } = await rooted()
    const first = await run(['show', 'billing-api'], 0, { cacheRoot })
    const bare = await run(['show', 'billing-api'], 0)
    expect(first.code).toBe(0)
    expect(first.sent.length).toBeGreaterThan(0)
    expect(first.err).toBe(bare.err)
    expect(first.out).toBe(bare.out)
    const copy = await theCopy(dir)
    expect((await lstat(copy)).isFile()).toBe(true)
  })

  it('first run into a root not yet made: makes it 0700; with its parent missing too, answers and says it was not kept', async () => {
    const parent = await scratch()
    const dir = path.join(parent, 'cache')
    const made = await run(['show', 'billing-api'], 0, { cacheRoot: { dir } })
    expect(made.code).toBe(0)
    expect((await lstat(dir)).mode & 0o777).toBe(0o700)
    expect(await keys(dir)).toHaveLength(1)

    const deeper = path.join(parent, 'missing', 'cache')
    const unmade = await run(['show', 'billing-api'], 0, { cacheRoot: { dir: deeper } })
    expect(unmade.code).toBe(0)
    expect(unmade.sent.length).toBeGreaterThan(0)
    expect(unmade.err.split('\n').slice(0, 2)).toEqual([
      notice(made.err),
      `this read of the catalogue was not kept: ${deeper} does not exist, nor does the folder above it`,
    ])
    expect(await readdir(parent)).toEqual(['cache'])
  })

  it('second run, 3 minutes later: sends nothing, prints the same answer, and says how old the copy is', async () => {
    const { cacheRoot } = await rooted()
    const first = await run(['show', 'billing-api'], 0, { cacheRoot })
    const second = await run(['show', 'billing-api'], 3 * MINUTE, { cacheRoot })
    expect(second.code).toBe(0)
    expect(second.sent).toEqual([])
    expect(second.out).toBe(first.out)
    expect(notice(second.err)).toBe(
      `reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 40 entities: 40 read, 0 not modelled; ` +
        `read from cache, 3 min old; --refresh reads Backstage again; ${TAIL}`,
    )
    expect(second.err.split('\n').slice(1)).toEqual(first.err.split('\n').slice(1))
  })

  it('says less than a minute for a copy 40 seconds old', async () => {
    const { cacheRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot })
    const second = await run(['graph'], 40_000, { cacheRoot })
    expect(second.sent).toEqual([])
    expect(notice(second.err)).toContain('; read from cache, less than a minute old; --refresh reads Backstage again; ')
  })

  it('reads Backstage again after five minutes, and replaces the copy', async () => {
    const { dir, cacheRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot })
    const before = await readFile(await theCopy(dir))
    const later = await run(['graph'], 6 * MINUTE, { cacheRoot })
    expect(later.sent.length).toBeGreaterThan(0)
    expect(later.err).not.toMatch(/cache/)
    expect(await readFile(await theCopy(dir))).not.toEqual(before)
  })

  it('reads Backstage again with --refresh a minute later, and replaces the copy', async () => {
    const { dir, cacheRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot })
    const before = await readFile(await theCopy(dir))
    const refreshed = await run(['graph', '--refresh'], MINUTE, { cacheRoot })
    expect(refreshed.code).toBe(0)
    expect(refreshed.sent.length).toBeGreaterThan(0)
    expect(refreshed.err).not.toMatch(/cache/)
    expect(await readFile(await theCopy(dir))).not.toEqual(before)
  })

  it('reads a partial copy as the read it was made from, and another bound is another key', async () => {
    const { dir, cacheRoot } = await rooted()
    const entities = catalogueOf(DEMO, { org: ORG_YAML, scale: 12 })
    const bound = { modelledEntities: 40 }
    const first = await run(['show', 'billing-api'], 0, { cacheRoot, entities, catalogueLimits: bound })
    expect(notice(first.err)).toContain('5 past the bound; it may lag')
    const second = await run(['show', 'billing-api'], MINUTE, { cacheRoot, entities, catalogueLimits: bound })
    expect(second.sent).toEqual([])
    expect(second.out).toBe(first.out)
    expect(notice(second.err)).toBe(
      notice(first.err).replace('; it may lag', '; read from cache, 1 min old; --refresh reads Backstage again; it may lag'),
    )
    expect(second.err.split('\n')[1]).toBe(first.err.split('\n')[1])
    expect(second.err.split('\n')[1]).toMatch(/^past the bound: /)
    const other = await run(['show', 'billing-api'], 2 * MINUTE, { cacheRoot, entities, catalogueLimits: { modelledEntities: 45 } })
    expect(other.sent.length).toBeGreaterThan(0)
    expect(await keys(dir)).toHaveLength(2)
  })

  it('answers from a copy 2 days old with --cached, Backstage unreachable and never asked', async () => {
    const { cacheRoot } = await rooted()
    const first = await run(['show', 'billing-api'], 0, { cacheRoot })
    const cached = await run(['show', 'billing-api', '--cached'], 2 * DAY, { cacheRoot, catalogueFetch: untouchable })
    expect(cached.code).toBe(0)
    expect(cached.out).toBe(first.out)
    expect(notice(cached.err)).toContain('; read from cache, 2 days old, as --cached asks: Backstage was not asked; it may lag')
  })

  it('ends --cached with no copy in one line, exit 1, and no request', async () => {
    const { cacheRoot } = await rooted()
    const cached = await run(['show', 'billing-api', '--cached'], 0, { cacheRoot, catalogueFetch: untouchable })
    expect(cached.code).toBe(1)
    expect(cached.out).toBe('')
    expect(cached.err).toBe(
      `${AT} was not read: no copy of it read with this token is kept on this machine (--cached); run without --cached to read it\n`,
    )
  })

  it('names --cached and the copy’s age after a failure of reach, with or without --refresh', async () => {
    const { cacheRoot } = await rooted()
    await run(['show', 'billing-api'], 0, { cacheRoot })
    const failed = await run(['show', 'billing-api'], 2 * HOUR, { cacheRoot, catalogueFetch: unreachable })
    expect(failed.code).toBe(1)
    expect(failed.err).toBe(`${AT} could not be reached (ECONNREFUSED); --cached reads the copy kept 2 h ago${WAY_OUT}\n`)

    const { cacheRoot: fresh } = await rooted()
    await run(['show', 'billing-api'], 0, { cacheRoot: fresh })
    const refreshed = await run(['show', 'billing-api', '--refresh'], 2 * MINUTE, { cacheRoot: fresh, catalogueFetch: unreachable })
    expect(refreshed.code).toBe(1)
    expect(refreshed.err).toBe(`${AT} could not be reached (ECONNREFUSED); --cached reads the copy kept 2 min ago${WAY_OUT}\n`)
  })

  it('never names --cached after a 401, byte for byte the line without a cache', async () => {
    const { cacheRoot } = await rooted()
    await run(['show', 'billing-api'], 0, { cacheRoot })
    const faults = { status: { at: 0, status: 401 } }
    const refused = await run(['show', 'billing-api', '--refresh'], MINUTE, { cacheRoot, faults })
    const bare = await run(['show', 'billing-api'], MINUTE, { faults })
    expect(refused.code).toBe(1)
    expect(refused.err).toBe(bare.err)
    expect(refused.err).not.toContain('--cached')
  })

  it('never answers from a copy dated ahead of this clock, and says so with --cached', async () => {
    const { cacheRoot } = await rooted()
    await run(['graph'], 10 * MINUTE, { cacheRoot })
    const ahead = await run(['graph'], 0, { cacheRoot })
    expect(ahead.sent.length).toBeGreaterThan(0)
    expect(ahead.err).not.toMatch(/cache/)

    const { cacheRoot: other } = await rooted()
    await run(['graph'], 10 * MINUTE, { cacheRoot: other })
    const cached = await run(['graph', '--cached'], 0, { cacheRoot: other, catalogueFetch: untouchable })
    expect(cached.code).toBe(0)
    expect(notice(cached.err)).toContain(
      '; read from cache, of an age this clock cannot tell (dated 10 min ahead of it), as --cached asks: Backstage was not asked; ',
    )

    // After a failure of reach, --cached is named, and no age this clock cannot tell.
    const failed = await run(['graph'], 0, { cacheRoot: other, catalogueFetch: unreachable })
    expect(failed.code).toBe(1)
    expect(failed.err).toBe(`${AT} could not be reached (ECONNREFUSED); --cached reads the kept copy, of an age this clock cannot tell${WAY_OUT}\n`)
  })

  it('says a store others may open was not used, and changes nothing', async () => {
    const { dir, cacheRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot })
    await chmod(STORE(dir), 0o755)
    const open = await run(['graph'], MINUTE, { cacheRoot })
    expect(open.code).toBe(0)
    expect(open.sent.length).toBeGreaterThan(0)
    expect(open.err.split('\n')[1]).toBe(
      `the cache at ${path.join(dir, 'idp-agent', 'backstage')} was not used and this read was not kept: others may open it (mode 0755); nothing was changed`,
    )
    expect((await lstat(STORE(dir))).mode & 0o777).toBe(0o755)

    // --refresh never uses a copy, so only the read not kept is news.
    const refreshed = await run(['graph', '--refresh'], MINUTE, { cacheRoot })
    expect(refreshed.code).toBe(0)
    expect(refreshed.err.split('\n')[1]).toBe(
      `the cache at ${path.join(dir, 'idp-agent', 'backstage')} could not keep this read: others may open it (mode 0755); nothing was changed`,
    )

    // With --cached, no write is tried: it was not used, and the kept read ends.
    const cached = await run(['graph', '--cached'], MINUTE, { cacheRoot, catalogueFetch: untouchable })
    expect(cached.code).toBe(1)
    expect(cached.err).toBe(
      `the cache at ${path.join(dir, 'idp-agent', 'backstage')} was not used: others may open it (mode 0755); nothing was changed\n` +
        `${AT} was not read: no copy of it read with this token is kept on this machine (--cached); run without --cached to read it\n`,
    )
  })

  it('says a copy that does not verify was not used, and replaces it', async () => {
    const { dir, cacheRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot })
    const file = await theCopy(dir)
    const bytes = await readFile(file)
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0x01
    await writeFile(file, bytes)
    const replaced = await run(['graph'], MINUTE, { cacheRoot })
    expect(replaced.code).toBe(0)
    expect(replaced.sent.length).toBeGreaterThan(0)
    expect(replaced.err.split('\n')[1]).toBe(
      'the kept copy of this catalogue did not verify (its MAC) and was not used; it is replaced by this read',
    )
    expect(await readFile(file)).not.toEqual(bytes)
  })

  it('says a served.json that is a link was neither used nor replaced, and leaves the link and its target', async () => {
    const { dir, cacheRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot })
    const file = await theCopy(dir)
    const target = path.join(await scratch(), 'elsewhere.json')
    await writeFile(target, 'not a copy\n')
    await rm(file)
    await symlink(target, file)
    const linked = await run(['graph'], MINUTE, { cacheRoot })
    expect(linked.code).toBe(0)
    expect(linked.sent.length).toBeGreaterThan(0)
    expect(linked.err.split('\n')[1]).toBe(
      `the cache at ${file} was not used and this read was not kept: it is a symbolic link, never followed; nothing was changed`,
    )
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('not a copy\n')
  })

  it('says a key that is a file in one line, since both facts say one thing', async () => {
    const { dir, cacheRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot })
    const [key] = await keys(dir)
    const folder = path.join(STORE(dir), key ?? '')
    await rm(folder, { recursive: true })
    await writeFile(folder, 'a file\n')
    const filed = await run(['graph'], MINUTE, { cacheRoot })
    expect(filed.code).toBe(0)
    const said = filed.err.split('\n').filter((line) => line.includes('cache'))
    expect(said).toEqual([
      `the cache at ${folder} was not used and this read was not kept: it is not a folder; nothing was changed`,
    ])
  })

  it('says the served-twice clause again on a cached answer, as a fact of the read the copy kept', async () => {
    // The copy keeps the census of the load that made it: its counts, and the
    // uids that load was served twice. Said of that read, never of this run's,
    // which sent nothing.
    const { cacheRoot } = await rooted()
    const twice = structuredClone(catalogue().find((item) => item['kind'] === 'Component') as Item)
    const faults = { extraItem: { at: 1, item: twice } }
    const first = await run(['graph'], 0, { cacheRoot, faults })
    expect(notice(first.err)).toContain('; the catalogue changed while it was read (1 served twice); it may lag')
    const second = await run(['graph'], MINUTE, { cacheRoot })
    expect(second.sent).toEqual([])
    // After `read from cache`, so the reader learns the answer is a copy before
    // meeting a change, and worded as the earlier read's.
    expect(notice(second.err)).toContain(
      ': 40 entities: 40 read, 0 not modelled; read from cache, 1 min old; the catalogue changed during the read this copy keeps (1 served twice); --refresh reads Backstage again; it may lag',
    )
    const cached = await run(['graph', '--cached'], 2 * MINUTE, { cacheRoot, catalogueFetch: untouchable })
    expect(notice(cached.err)).toContain(
      '; read from cache, 2 min old, as --cached asks: Backstage was not asked; the catalogue changed during the read this copy keeps (1 served twice); it may lag',
    )
  })

  it('traces what the cache did, and a run that sent no request as one that sent none', async () => {
    const { cacheRoot } = await rooted()
    const traced = async (argv: string[], when: number, options: Options = {}): Promise<Record<string, unknown>> => {
      const sink = memorySink()
      const ran = await run(argv, when, { cacheRoot, traceSinks: [sink], client: overviewClient(), cwd: await scratch(), ...options })
      expect(ran.code, ran.err).toBe(0)
      return onlyTrace(sink).spans[0]?.attributes ?? {}
    }
    const question = 'which databases are in prod?'
    // A slow catalogue, so the load that makes the copy takes longer than any
    // read of the copy, and the two times cannot be mistaken for each other.
    const behind = fakeBackstage({ entities: catalogue() })
    const slow: CatalogueFetch = async (...request) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return behind.fetch(...request)
    }
    const first = await traced([question], 0, { catalogueFetch: slow })
    expect(first).toMatchObject({ 'idp.source.cache_read': 'absent', 'idp.source.cache_written': 'written', 'idp.source.pages': 2 })
    expect(first['idp.source.ms']).toBeGreaterThanOrEqual(500)
    expect(first).not.toHaveProperty('idp.source.cache_age_s')

    const second = await traced([question], 3 * MINUTE)
    // No request: no page and no byte, whatever the copy's census says of the load that made it.
    expect(second).toMatchObject({
      'idp.source.cache_read': 'fresh',
      'idp.source.cache_age_s': 180,
      'idp.source.pages': 0,
      'idp.source.bytes': 0,
      'idp.source.entities': 40,
    })
    expect(second).not.toHaveProperty('idp.source.cache_written')
    // This run's own time, reading the copy: not the time the load that made it took.
    expect(typeof second['idp.source.ms']).toBe('number')
    expect(second['idp.source.ms']).toBeLessThan(first['idp.source.ms'] as number)

    expect(await traced([question, '--refresh'], 4 * MINUTE)).toMatchObject({
      'idp.source.cache_read': 'skipped',
      'idp.source.cache_written': 'written',
    })
    expect(await traced([question], 10 * MINUTE)).toMatchObject({ 'idp.source.cache_read': 'stale', 'idp.source.cache_written': 'written' })
    const kept = await traced([question, '--cached'], DAY, { catalogueFetch: untouchable })
    expect(kept).toMatchObject({ 'idp.source.cache_read': 'kept', 'idp.source.cache_age_s': DAY / 1000 - 600, 'idp.source.pages': 0 })
    expect(kept).not.toHaveProperty('idp.source.cache_written')

    const { dir: open, cacheRoot: openRoot } = await rooted()
    await run(['graph'], 0, { cacheRoot: openRoot })
    await chmod(STORE(open), 0o755)
    expect(await traced([question], MINUTE, { cacheRoot: openRoot })).toMatchObject({
      'idp.source.cache_read': 'not-used',
      'idp.source.cache_written': 'not-written',
    })
    expect(await traced([question, '--refresh'], MINUTE, { cacheRoot: openRoot })).toMatchObject({
      'idp.source.cache_read': 'skipped',
      'idp.source.cache_written': 'not-written',
    })

    const sink = memorySink()
    await run([question], 0, { traceSinks: [sink], client: overviewClient(), cwd: await scratch() })
    const none = onlyTrace(sink).spans[0]?.attributes ?? {}
    expect(none).toMatchObject({ 'idp.source.cache_read': 'off', 'idp.source.pages': 2 })
    expect(none).not.toHaveProperty('idp.source.cache_written')
  })

  it('keeps nothing and says nothing of a cache when no root is handed in', async () => {
    const bare = await run(['show', 'billing-api'], 0)
    const again = await run(['show', 'billing-api'], MINUTE)
    expect(again.sent.length).toBeGreaterThan(0)
    expect(again.err).toBe(bare.err)
    expect(bare.err).not.toMatch(/cache/)
    // Nothing under the suite's XDG_CACHE_HOME, which main never reads.
    await expect(lstat(path.join(process.env['XDG_CACHE_HOME'] ?? '/nowhere', 'idp-agent'))).rejects.toThrow(/ENOENT/)
  })
})
