import { execFileSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LinkRefused, openNew, openToRead, realRootOf } from '../../src/confine/confine.js'
import { acceptable, catalogueCache, type CatalogueCache, type NameStats } from '../../src/context/backstage/cache.js'
import { CATALOGUE_CACHE } from '../../src/context/backstage/limits.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from '../../src/context/backstage/limits.js'
import { loadCatalogue, type Served } from '../../src/context/backstage/load.js'
import { catalogueTransport, type CatalogueFetch } from '../../src/context/backstage/transport.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage } from '../support/fake-backstage.js'

/**
 * The store a catalogue read is kept in (docs/plans/backstage-http-slice-2.md,
 * Task 2.2, and "The cache as company data at rest"): the folders only the
 * person's account may open, the per-machine secret, the key, a copy written
 * and read back, every refusal, the races, the clock and the pruning. Every
 * root is a folder made under the run directory; nothing here writes under a
 * real home. POSIX only, as the store is: Windows keeps no cache.
 */

const BASE = new URL('https://backstage.canary.example/api/catalog')
const TOKEN = 'canary-backstage-token-0123456789'
const OWNER = process.getuid?.() ?? -1
const NOW = Date.parse('2026-10-01T09:14:03.120Z')

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORG = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')

type Item = Record<string, unknown>

const scratch = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-cache-'))

/** An API as a catalogue serves one, its definition text: the one thing a copy keeps of it is that it is there. */
const API: Item = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'API',
  metadata: { name: 'billing-events', namespace: 'default', uid: 'a0000000-0000-4000-8000-000000000001' },
  spec: {
    type: 'openapi',
    lifecycle: 'production',
    owner: 'group:default/tiger',
    definition: 'openapi: 3.0.0\ninfo:\n  title: DEFINITION-TEXT-NEVER-KEPT\n',
  },
}

/** A Location, read as refs. */
const LOCATION: Item = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Location',
  metadata: { name: 'si-demo', namespace: 'default', uid: 'b0000000-0000-4000-8000-000000000001' },
  spec: { type: 'url', target: 'https://github.com/acme/si-demo/blob/main/catalog-info.yaml' },
}

/** The demo SI, its organisation, an API and a Location: every read a load sends. */
const catalogue = (): Item[] => [...catalogueOf(DEMO, { org: ORG }), API, LOCATION]

/** A catalogue read as a load reads it, through the fake; `ignoreFields` is a server that serves every field whatever is asked. */
async function servedOf(
  entities: readonly Item[] = catalogue(),
  options: { limits?: Partial<BackstageLimits>; ignoreFields?: boolean } = {},
): Promise<Served> {
  const fake = fakeBackstage({ entities, token: TOKEN })
  const fetch: CatalogueFetch = options.ignoreFields
    ? (url, init) => {
        const whole = new URL(url)
        whole.searchParams.delete('fields')
        return fake.fetch(whole, init)
      }
    : fake.fetch
  const limits = options.limits ?? {}
  return loadCatalogue(catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch, limits }), limits)
}

/** An API's text definition as a copy keeps it. */
const declared = (item: unknown): unknown => {
  const entity = item as Item
  if (entity['kind'] !== 'API') return item
  return { ...entity, spec: { ...(entity['spec'] as Item), definition: 'declared' } }
}

/** The one copy under `root`: its folder's name and its path. */
async function copyIn(root: string): Promise<{ key: string; file: string }> {
  const store = path.join(root, 'idp-agent/backstage')
  const keys = (await readdir(store)).filter((name) => /^[0-9a-f]{32}$/.test(name))
  expect(keys).toHaveLength(1)
  const key = keys[0] ?? ''
  return { key, file: path.join(store, key, 'served.json') }
}

type Made = Awaited<ReturnType<typeof catalogueCache>>

const storeAt = (
  root: string,
  overrides: Partial<{ base: URL; token: string | undefined; limits: BackstageLimits; now: () => number }> = {},
): Promise<Made> =>
  catalogueCache({ root, base: BASE, token: TOKEN, owner: OWNER, limits: BACKSTAGE_LIMITS, now: () => NOW, ...overrides })

/** The store, or the test fails with why it could not be used. */
const usable = async (made: Promise<Made>): Promise<CatalogueCache> => {
  const result = await made
  if (!('cache' in result)) throw new Error(`the store is unusable: ${JSON.stringify(result)}`)
  return result.cache
}

const modeOf = async (at: string): Promise<number> => (await lstat(at)).mode & 0o777

/** Every name under `root`, and every file's bytes, as one text. */
async function everything(root: string): Promise<string> {
  const names = await readdir(root, { recursive: true })
  const parts: string[] = [...names]
  for (const name of names) {
    const at = path.join(root, name)
    if ((await lstat(at)).isFile()) parts.push(await readFile(at, 'latin1'))
  }
  return parts.join('\n')
}

describe.skipIf(process.platform === 'win32' || OWNER === 0)('catalogueCache', () => {
  // A umask of 022, the one a person's shell usually has, whatever the runner's: under 077 a
  // store that asked no mode would still make 0700 and 0600, and every mode row would pass.
  let umask: number | undefined
  beforeAll(() => {
    umask = process.umask(0o022)
  })
  afterAll(() => {
    if (umask !== undefined) process.umask(umask)
  })

  describe('the root, the key and the secret', () => {
    it('makes idp-agent/ and backstage/ 0700 and a secret 0600 of 64 hex characters and a line break', async () => {
      const root = await scratch()
      await usable(storeAt(root))
      expect(await modeOf(path.join(root, 'idp-agent'))).toBe(0o700)
      expect(await modeOf(path.join(root, 'idp-agent/backstage'))).toBe(0o700)
      expect(await modeOf(path.join(root, 'idp-agent/backstage/secret'))).toBe(0o600)
      expect(await readFile(path.join(root, 'idp-agent/backstage/secret'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
      expect(await readdir(path.join(root, 'idp-agent/backstage'))).toEqual(['secret'])
    })

    it('makes a missing root 0700 when its parent is a folder, and nothing when its parent is missing too', async () => {
      const parent = await scratch()
      await usable(storeAt(path.join(parent, 'cache')))
      expect(await modeOf(path.join(parent, 'cache'))).toBe(0o700)
      expect(await modeOf(path.join(parent, 'cache/idp-agent/backstage/secret'))).toBe(0o600)

      const empty = await scratch()
      expect(await storeAt(path.join(empty, 'missing/cache'))).toEqual({ unusable: { kind: 'no-parent' } })
      expect(await readdir(empty)).toEqual([])
    })

    it('follows a missing root’s parent when it is a link to a folder, as a root is, and makes the root there', async () => {
      const home = await scratch()
      const elsewhere = await scratch()
      await symlink(elsewhere, path.join(home, '.cache'))
      await usable(storeAt(path.join(home, '.cache/xdg')))
      expect(await readdir(elsewhere)).toEqual(['xdg'])
      expect(await modeOf(path.join(elsewhere, 'xdg'))).toBe(0o700)
    })

    it('keys a copy by 32 hex characters of the base, the token, the secret and the effective limits', async () => {
      const root = await scratch()
      const one = await usable(storeAt(root))
      expect(one.key).toMatch(/^[0-9a-f]{32}$/)
      expect((await usable(storeAt(root))).key).toBe(one.key)
      const others = [
        (await usable(storeAt(root, { token: 'another-token' }))).key,
        (await usable(storeAt(root, { token: undefined }))).key,
        (await usable(storeAt(root, { base: new URL('https://backstage.canary.example/other/api/catalog') }))).key,
        (await usable(storeAt(root, { limits: { ...BACKSTAGE_LIMITS, modelledEntities: 40 } }))).key,
        (await usable(storeAt(await scratch()))).key,
      ]
      expect(new Set([one.key, ...others]).size).toBe(6)
    })

    it('keeps no name and no byte that holds the token or its sha256', async () => {
      const root = await scratch()
      await usable(storeAt(root))
      const all = await everything(root)
      expect(all).not.toContain(TOKEN)
      expect(all).not.toContain(createHash('sha256').update(TOKEN).digest('hex'))
    })

    it('makes a secret of another shape again, owned and closed, and every key changes with it', async () => {
      const root = await scratch()
      const before = (await usable(storeAt(root))).key
      await writeFile(path.join(root, 'idp-agent/backstage/secret'), 'abc\n', { mode: 0o600 })
      const after = await usable(storeAt(root))
      expect(after.key).not.toBe(before)
      expect(await readFile(path.join(root, 'idp-agent/backstage/secret'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
      expect(await modeOf(path.join(root, 'idp-agent/backstage/secret'))).toBe(0o600)
      expect(await readdir(path.join(root, 'idp-agent/backstage'))).toEqual(['secret'])
    })

    it('ends two stores made at once on an empty root with one secret and no temporary file', async () => {
      const root = await scratch()
      await Promise.all([usable(storeAt(root)), usable(storeAt(root)), usable(storeAt(root))])
      expect(await readdir(path.join(root, 'idp-agent/backstage'))).toEqual(['secret'])
    })

    it('keeps and reads nothing for a run as root, and makes nothing, not even a missing root', async () => {
      const parent = await scratch()
      expect(await catalogueCache({ root: path.join(parent, 'cache'), base: BASE, token: TOKEN, owner: 0, limits: BACKSTAGE_LIMITS })).toEqual({
        unusable: { kind: 'root' },
      })
      expect(await readdir(parent)).toEqual([])
    })

    it('keeps no copy whose header no read would take', async () => {
      const root = await scratch()
      const served = await servedOf()
      const long = new URL(`https://backstage.canary.example/${'a'.repeat(4100)}/api/catalog`)
      const cache = await usable(storeAt(root, { base: long, now: () => served.startedAt }))
      expect(await cache.write(served)).toEqual({ written: false, refusal: { kind: 'unverified', reason: 'header' } })
      expect(await readdir(path.join(root, 'idp-agent/backstage', cache.key))).toEqual([])
    })

    it('never makes a folder of its own in the root a person named but idp-agent/', async () => {
      const root = await scratch()
      await mkdir(path.join(root, 'other'))
      await usable(storeAt(root))
      expect((await readdir(root)).sort()).toEqual(['idp-agent', 'other'])
    })
  })

  describe('a copy written and read back', () => {
    const within = (served: Served, ms = 60_000) => () => served.startedAt + ms

    it('reads back the Served it was given, the organisation as its fields and an API’s definition as declared', async () => {
      const root = await scratch()
      const served = await servedOf()
      const cache = await usable(storeAt(root, { now: within(served) }))
      expect(await cache.write(served)).toEqual({ written: true })
      const read = await cache.read('fresh')
      if (!('kept' in read)) throw new Error(`no copy: ${JSON.stringify(read)}`)
      expect(read.kept.fetchedAt).toBe(served.startedAt)
      expect(read.kept.served).toEqual({ ...served, whole: served.whole.map(declared) })
      expect(served.whole.map(declared)).not.toEqual(served.whole)
    })

    it('keeps one file, 0600, one link, the account’s: a header, the envelope with no judged, then one line per item', async () => {
      const root = await scratch()
      const served = await servedOf()
      const cache = await usable(storeAt(root, { now: within(served) }))
      await cache.write(served)
      const { key, file } = await copyIn(root)
      expect(key).toBe(cache.key)
      expect(await readdir(path.dirname(file))).toEqual(['served.json'])
      expect(await modeOf(path.dirname(file))).toBe(0o700)
      const stats = await lstat(file)
      expect(stats.mode & 0o777).toBe(0o600)
      expect(stats.nlink).toBe(1)
      expect(stats.uid).toBe(OWNER)
      const text = await readFile(file, 'utf8')
      const lines = text.split('\n')
      expect(lines.at(-1)).toBe('')
      const [header = '', envelope = ''] = lines
      expect(Buffer.byteLength(header)).toBeLessThan(4096)
      expect(JSON.parse(header)).toEqual({
        format: 'idp-agent/backstage-cache/1',
        origin: BASE.href,
        fetchedAt: new Date(served.startedAt).toISOString(),
        count: served.census.served,
        bytes: Buffer.byteLength(text) - Buffer.byteLength(header) - 1,
        mac: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
      expect(Object.keys(JSON.parse(header))).toEqual(['format', 'origin', 'fetchedAt', 'count', 'bytes', 'mac'])
      const parsed = JSON.parse(envelope) as Item
      expect(Object.keys(parsed).sort()).toEqual(['asked', 'bounded', 'census', 'counts', 'startedAt'])
      expect(parsed['counts']).toEqual({
        whole: served.whole.length,
        organisation: served.organisation.length,
        refs: served.refs.length,
      })
      expect(lines).toHaveLength(2 + served.whole.length + served.organisation.length + served.refs.length + 1)
      const all = await everything(root)
      expect(all).not.toContain(TOKEN)
      expect(all).not.toContain(createHash('sha256').update(TOKEN).digest('hex'))
      expect(all).not.toContain('DEFINITION-TEXT-NEVER-KEPT')
    })

    it('keeps a bounded read bounded, and gives back the judged the load gave, recomputed', async () => {
      for (const limits of [{ organisationEntities: 2 }, { modelledEntities: 20, otherRefs: 1 }, {}]) {
        const root = await scratch()
        const served = await servedOf(catalogue(), { limits })
        const cache = await usable(storeAt(root, { now: within(served), limits: { ...BACKSTAGE_LIMITS, ...limits } }))
        await cache.write(served)
        const read = await cache.read('fresh')
        if (!('kept' in read)) throw new Error(`no copy: ${JSON.stringify(read)}`)
        expect(read.kept.served.bounded).toEqual(served.bounded)
        expect(read.kept.served.judged).toEqual(served.judged)
      }
    })

    it('keeps nothing of a User’s profile or annotations when the server ignored fields', async () => {
      const root = await scratch()
      const served = await servedOf(catalogue(), { ignoreFields: true })
      expect(JSON.stringify(served.organisation)).toContain('ada@acme.example')
      const cache = await usable(storeAt(root, { now: within(served) }))
      await cache.write(served)
      const all = await everything(root)
      expect(all).not.toContain('ada@acme.example')
      expect(all).not.toContain('data:image/png')
      expect(all).not.toContain('microsoft.com/email')
      const read = await cache.read('fresh')
      if (!('kept' in read)) throw new Error(`no copy: ${JSON.stringify(read)}`)
      // As a Backstage honouring fields serves them.
      expect(read.kept.served.organisation).toEqual((await servedOf()).organisation)
      expect(read.kept.served.refs).toEqual((await servedOf()).refs)
    })

    it('keeps no API’s definition text whatever the case of its kind, as the load and the reader read the kind', async () => {
      for (const kind of ['Api', 'api', 'aPI']) {
        const root = await scratch()
        const spelled = { ...API, kind, metadata: { ...(API['metadata'] as Item), name: `spelled-${kind}` } }
        const served = await servedOf([...catalogue().filter((item) => item !== API), spelled])
        expect(JSON.stringify(served.whole)).toContain(`"kind":"${kind}"`)
        const cache = await usable(storeAt(root, { now: within(served) }))
        expect(await cache.write(served)).toEqual({ written: true })
        expect(await everything(root)).not.toContain('DEFINITION-TEXT-NEVER-KEPT')
        expect(await cache.read('fresh')).toHaveProperty('kept')
      }
    })
  })

  describe('every refusal', () => {
    /** Stats as `lstat` gives them, made up: the one way to stage a file of another account inside folders the test owns. */
    const stats = (type: 'folder' | 'file' | 'link', mode: number, uid = OWNER, nlink = 1): NameStats => ({
      mode,
      uid,
      nlink,
      isDirectory: () => type === 'folder',
      isFile: () => type === 'file',
      isSymbolicLink: () => type === 'link',
    })

    it.each([
      ['a folder of another account', stats('folder', 0o700, OWNER + 1), 'folder', 'foreign'],
      ['a file of another account', stats('file', 0o600, OWNER + 1), 'file', 'foreign'],
      ['idp-agent/ of another account', stats('folder', 0o700, OWNER + 1), 'top', 'foreign'],
      ['a group bit on a folder below idp-agent/', stats('folder', 0o750), 'folder', 'open'],
      ['an other bit on a folder below idp-agent/', stats('folder', 0o701), 'folder', 'open'],
      ['a group bit on a file', stats('file', 0o640), 'file', 'open'],
      ['an other bit on a file', stats('file', 0o604), 'file', 'open'],
      ['a group write bit on idp-agent/', stats('folder', 0o770), 'top', 'open'],
      ['an other write bit on idp-agent/', stats('folder', 0o757), 'top', 'open'],
      ['a file with two links', stats('file', 0o600, OWNER, 2), 'file', 'linked'],
      ['a file with three links', stats('file', 0o600, OWNER, 3), 'file', 'linked'],
      ['a link where a folder goes', stats('link', 0o777), 'folder', 'link'],
      ['a link where idp-agent/ goes', stats('link', 0o777), 'top', 'link'],
      ['a link where a file goes', stats('link', 0o777), 'file', 'link'],
      ['a file where a folder goes', stats('file', 0o700), 'folder', 'not-a-folder'],
      ['a folder where a file goes', stats('folder', 0o600), 'file', 'not-a-file'],
    ] as const)('refuses %s', (_, given, kind, refusal) => {
      expect(acceptable(given, OWNER, kind)).toBe(refusal)
    })

    it('accepts what the store makes, and read bits on idp-agent/', () => {
      expect(acceptable(stats('folder', 0o700), OWNER, 'top')).toBeUndefined()
      expect(acceptable(stats('folder', 0o755), OWNER, 'top')).toBeUndefined()
      expect(acceptable(stats('folder', 0o700), OWNER, 'folder')).toBeUndefined()
      expect(acceptable(stats('file', 0o600), OWNER, 'file')).toBeUndefined()
      expect(acceptable(stats('file', 0o400), OWNER, 'file')).toBeUndefined()
      // A descriptor on a copy another run has since renamed over: no name left, so no second one.
      expect(acceptable(stats('file', 0o600, OWNER, 0), OWNER, 'file')).toBeUndefined()
    })

    /** A root holding one copy of the demo catalogue, written by the store, read within its TTL. */
    async function kept(limits: BackstageLimits = BACKSTAGE_LIMITS) {
      const root = await scratch()
      const served = await servedOf()
      const now = () => served.startedAt + 60_000
      const cache = await usable(storeAt(root, { now, limits }))
      expect(await cache.write(served)).toEqual({ written: true })
      const { key, file } = await copyIn(root)
      const secret = Buffer.from((await readFile(path.join(root, 'idp-agent/backstage/secret'), 'utf8')).trim(), 'hex')
      return { root, served, now, cache, key, file, secret, copy: `idp-agent/backstage/${key}/served.json` }
    }

    /**
     * The copy at `file` edited and sealed again with the test's knowledge of
     * the secret: what only the person's own account could do, and what the
     * checks after the MAC are for.
     */
    async function resealed(
      at: { file: string; key: string; secret: Buffer },
      edit: { header?: (header: Item) => Item; lines?: (lines: string[]) => string[]; body?: (body: Buffer) => Buffer },
    ): Promise<void> {
      const text = await readFile(at.file)
      const end = text.indexOf(0x0a)
      const { mac: _mac, ...header } = JSON.parse(text.subarray(0, end).toString('utf8')) as Item
      let body: Buffer = text.subarray(end + 1)
      if (edit.lines !== undefined) {
        const lines = body.toString('utf8').split('\n').slice(0, -1)
        body = Buffer.from(`${edit.lines(lines).join('\n')}\n`, 'utf8')
      }
      if (edit.body !== undefined) body = edit.body(body)
      const edited = (edit.header ?? ((same: Item) => same))({ ...header, bytes: body.length })
      const canonical = JSON.stringify({
        format: edited['format'],
        origin: edited['origin'],
        fetchedAt: edited['fetchedAt'],
        count: edited['count'],
        bytes: edited['bytes'],
      })
      const mac = createHmac('sha256', at.secret)
        .update(`idp-agent/backstage-cache/1\n${at.key}\n${canonical}\n`)
        .update(body)
        .digest('hex')
      await writeFile(at.file, Buffer.concat([Buffer.from(`${JSON.stringify({ ...edited, mac })}\n`, 'utf8'), body]))
    }

    /** The copy's bytes edited in place, nothing sealed again. */
    async function edited(file: string, edit: (text: Buffer) => Buffer): Promise<void> {
      await writeFile(file, edit(await readFile(file)))
    }

    const envelopeEdit =
      (edit: (envelope: Item) => Item) =>
      (lines: string[]): string[] => [JSON.stringify(edit(JSON.parse(lines[0] ?? '') as Item)), ...lines.slice(1)]

    it('refuses the store when backstage/ or idp-agent/ is a link, and never reads or writes the folder it leads to', async () => {
      for (const linked of ['idp-agent/backstage', 'idp-agent']) {
        const root = await scratch()
        const elsewhere = await scratch()
        await mkdir(path.join(root, 'idp-agent'), { mode: 0o700 })
        if (linked === 'idp-agent') await rename(path.join(root, 'idp-agent'), path.join(elsewhere, 'moved'))
        await symlink(elsewhere, path.join(root, linked))
        const before = await readdir(elsewhere, { recursive: true })
        expect(await storeAt(root)).toEqual({ unusable: { kind: 'link', path: linked } })
        expect(await readdir(elsewhere, { recursive: true })).toEqual(before)
      }
    })

    it('refuses a key folder that is a link, for a read and a write, and leaves where it leads as it was', async () => {
      const { root, served, cache, key } = await kept()
      const folder = path.join(root, 'idp-agent/backstage', key)
      const elsewhere = await scratch()
      await rename(folder, path.join(elsewhere, 'moved'))
      await symlink(path.join(elsewhere, 'moved'), folder)
      const before = await readFile(path.join(elsewhere, 'moved/served.json'))
      const refusal = { kind: 'link', path: `idp-agent/backstage/${key}` }
      expect(await cache.read('fresh')).toEqual({ none: refusal })
      expect(await cache.write(served)).toEqual({ written: false, refusal })
      expect(await readdir(path.join(elsewhere, 'moved'))).toEqual(['served.json'])
      expect(await readFile(path.join(elsewhere, 'moved/served.json'))).toEqual(before)
    })

    it('refuses a copy that is a link, for a read and a write: the link kept, its target untouched, no temporary file left', async () => {
      const { root, served, cache, file, copy } = await kept()
      const elsewhere = await scratch()
      await writeFile(path.join(elsewhere, 'target'), 'NOT A COPY')
      await rename(file, path.join(elsewhere, 'moved'))
      await symlink(path.join(elsewhere, 'target'), file)
      expect(await cache.read('fresh')).toEqual({ none: { kind: 'link', path: copy } })
      expect(await cache.write(served)).toEqual({ written: false, refusal: { kind: 'link', path: copy } })
      expect((await lstat(file)).isSymbolicLink()).toBe(true)
      expect(await readFile(path.join(elsewhere, 'target'), 'utf8')).toBe('NOT A COPY')
      expect(await readdir(path.dirname(file))).toEqual(['served.json'])
      expect(await readdir(root)).toEqual(['idp-agent'])
    })

    it('refuses a copy with a second name', async () => {
      const { root, cache, file, copy } = await kept()
      await link(file, path.join(root, 'second-name'))
      expect(await cache.read('fresh')).toEqual({ none: { kind: 'linked', path: copy } })
    })

    it('refuses a pipe at the copy or the secret as not a file, at once, never waiting for a writer', async () => {
      const soon = <T>(work: Promise<T>): Promise<T | 'waiting'> =>
        Promise.race([work, new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 1000))])

      const { cache, file, copy } = await kept()
      await rename(file, `${file}.moved`)
      execFileSync('mkfifo', ['-m', '600', file])
      expect(await soon(cache.read('fresh'))).toEqual({ none: { kind: 'not-a-file', path: copy } })

      const root = await scratch()
      await usable(storeAt(root))
      const secret = path.join(root, 'idp-agent/backstage/secret')
      await rename(secret, path.join(root, 'moved'))
      execFileSync('mkfifo', ['-m', '600', secret])
      expect(await soon(storeAt(root))).toEqual({ unusable: { kind: 'not-a-file', path: 'idp-agent/backstage/secret' } })
    })

    it('refuses a store or a copy open to others, and changes no mode', async () => {
      const root = await scratch()
      await usable(storeAt(root))
      await chmod(path.join(root, 'idp-agent/backstage'), 0o755)
      expect(await storeAt(root)).toEqual({ unusable: { kind: 'open', path: 'idp-agent/backstage', mode: 0o755 } })
      expect(await modeOf(path.join(root, 'idp-agent/backstage'))).toBe(0o755)

      const { cache, file, copy } = await kept()
      await chmod(file, 0o644)
      expect(await cache.read('fresh')).toEqual({ none: { kind: 'open', path: copy, mode: 0o644 } })
      expect(await modeOf(file)).toBe(0o644)
    })

    it('refuses a secret that is a link, open to others or linked twice, and never makes it again', async () => {
      const secretAt = (root: string): string => path.join(root, 'idp-agent/backstage/secret')
      const SECRET = 'idp-agent/backstage/secret'

      const linked = await scratch()
      await usable(storeAt(linked))
      const elsewhere = await scratch()
      await writeFile(path.join(elsewhere, 'target'), `${'f'.repeat(64)}\n`)
      await rename(secretAt(linked), path.join(elsewhere, 'moved'))
      await symlink(path.join(elsewhere, 'target'), secretAt(linked))
      expect(await storeAt(linked)).toEqual({ unusable: { kind: 'link', path: SECRET } })
      expect((await lstat(secretAt(linked))).isSymbolicLink()).toBe(true)
      expect(await readFile(path.join(elsewhere, 'target'), 'utf8')).toBe(`${'f'.repeat(64)}\n`)

      const open = await scratch()
      await usable(storeAt(open))
      const kept = await readFile(secretAt(open), 'utf8')
      await chmod(secretAt(open), 0o644)
      expect(await storeAt(open)).toEqual({ unusable: { kind: 'open', path: SECRET, mode: 0o644 } })
      expect(await readFile(secretAt(open), 'utf8')).toBe(kept)
      expect(await modeOf(secretAt(open))).toBe(0o644)

      const twice = await scratch()
      await usable(storeAt(twice))
      const same = await readFile(secretAt(twice), 'utf8')
      await link(secretAt(twice), path.join(twice, 'other-name'))
      expect(await storeAt(twice)).toEqual({ unusable: { kind: 'linked', path: SECRET } })
      expect(await readFile(secretAt(twice), 'utf8')).toBe(same)
      expect(await readFile(path.join(twice, 'other-name'), 'utf8')).toBe(same)
    })

    it.each([
      ['truncated at half', 'length', (text: Buffer) => text.subarray(0, Math.floor(text.length / 2))],
      [
        'one byte of the body flipped',
        'mac',
        (text: Buffer) => {
          const flipped = Buffer.from(text)
          const at = text.length - 10
          flipped[at] = (flipped[at] ?? 0) ^ 0x01
          return flipped
        },
      ],
      [
        'one digit of the header’s fetchedAt changed',
        'mac',
        (text: Buffer) => Buffer.from(text.toString('utf8').replace(/("fetchedAt":"[^"]*\.\d\d)(\d)Z"/, (_, head: string, digit: string) => `${head}${String((Number(digit) + 1) % 10)}Z"`), 'utf8'),
      ],
      [
        'the MAC changed',
        'mac',
        (text: Buffer) => Buffer.from(text.toString('utf8').replace(/"mac":"(.)/, (_, first: string) => `"mac":"${first === '0' ? '1' : '0'}`), 'utf8'),
      ],
      ['the format 2', 'format', (text: Buffer) => Buffer.from(text.toString('utf8').replace('backstage-cache/1', 'backstage-cache/2'), 'utf8')],
      ['the origin another base', 'origin', (text: Buffer) => Buffer.from(text.toString('utf8').replace('/api/catalog"', '/other/api/catalog"'), 'utf8')],
      ['bytes another length', 'length', (text: Buffer) => Buffer.from(text.toString('utf8').replace(/"bytes":(\d+)/, (_, n: string) => `"bytes":${String(Number(n) + 1)}`), 'utf8')],
      ['a header that is not JSON', 'header', (text: Buffer) => Buffer.concat([Buffer.from('not json'), text])],
      ['no header line within 4 KiB', 'header', (text: Buffer) => Buffer.concat([Buffer.from(`{"pad":"${'x'.repeat(5000)}",`), text.subarray(1)])],
      ['a header of another shape', 'header', (text: Buffer) => Buffer.from(text.toString('utf8').replace('"count":', '"counted":'), 'utf8')],
    ] as const)('refuses a copy %s', async (_, reason, edit) => {
      const { cache, file } = await kept()
      await edited(file, edit)
      expect(await cache.read('fresh')).toEqual({ none: { kind: 'unverified', reason } })
    })

    it('refuses a copy moved into another key’s folder: the MAC covers the key', async () => {
      const { root, file } = await kept()
      const other = await usable(storeAt(root, { token: 'another-token' }))
      const folder = path.join(root, 'idp-agent/backstage', other.key)
      await mkdir(folder, { mode: 0o700 })
      await copyFile(file, path.join(folder, 'served.json'))
      await chmod(path.join(folder, 'served.json'), 0o600)
      expect(await other.read('kept')).toEqual({ none: { kind: 'unverified', reason: 'mac' } })
    })

    it.each([
      ['a body that is not JSON', 'envelope', { lines: (lines: string[]) => ['not json', ...lines.slice(1)] }],
      ['an envelope line of invalid UTF-8', 'envelope', { body: (body: Buffer) => Buffer.concat([Buffer.from([0xff, 0xfe]), body]) }],
      ['counts.whole not a number', 'envelope', { lines: envelopeEdit((envelope) => ({ ...envelope, counts: { ...(envelope['counts'] as Item), whole: 'many' } })) }],
      ['an envelope with a key it does not hold', 'envelope', { lines: envelopeEdit((envelope) => ({ ...envelope, judged: ['Group'] })) }],
      ['an envelope startedAt other than the header’s fetchedAt', 'envelope', { lines: envelopeEdit((envelope) => ({ ...envelope, startedAt: (envelope['startedAt'] as number) - 1 })) }],
      ['asked.refs holding component', 'account', { lines: envelopeEdit((envelope) => ({ ...envelope, asked: { ...(envelope['asked'] as Item), refs: ['component', 'location'] } })) }],
      ['asked.organisation holding template', 'account', { lines: envelopeEdit((envelope) => ({ ...envelope, asked: { ...(envelope['asked'] as Item), organisation: ['group', 'template', 'user'] } })) }],
      ['a bounded organisation read of limit 5 against the default ceiling', 'account', { lines: envelopeEdit((envelope) => ({ ...envelope, bounded: [{ scope: 'organisation', kinds: ['group', 'user'], read: 5, total: 7, limit: 5 }] })) }],
      ['census.served one more than the items', 'account', { lines: envelopeEdit((envelope) => ({ ...envelope, census: { ...(envelope['census'] as Item), served: ((envelope['census'] as Item)['served'] as number) + 1 } })) }],
      ['an item without a uid', 'items', { lines: (lines: string[]) => [lines[0] ?? '', JSON.stringify({ ...(JSON.parse(lines[1] ?? '') as Item), metadata: { name: 'no-uid' } }), ...lines.slice(2)] }],
      ['an item of a kind its read did not ask for', 'items', { lines: (lines: string[]) => [lines[0] ?? '', JSON.stringify({ ...(JSON.parse(lines[1] ?? '') as Item), kind: 'Location' }), ...lines.slice(2)] }],
      ['an item line that is not JSON', 'items', { lines: (lines: string[]) => [lines[0] ?? '', '{', ...lines.slice(2)] }],
      ['one item line fewer than its counts', 'items', { lines: (lines: string[]) => lines.slice(0, -1) }],
      ['a uid kept twice', 'items', { lines: (lines: string[]) => [...lines.slice(0, 2), lines[1] ?? '', ...lines.slice(3)] }],
      ['a count one more than the distinct uids', 'items', { header: (header: Item) => ({ ...header, count: (header['count'] as number) + 1 }) }],
    ] as const)('refuses a copy sealed again with %s', async (_, reason, edit) => {
      const at = await kept()
      await resealed(at, edit)
      const read = await at.cache.read('fresh')
      expect(read).toEqual({ none: { kind: 'unverified', reason } })
    })

    it('refuses more items than a read’s ceiling, and a body line longer than a page may be', async () => {
      const served = await servedOf()
      const whole = served.whole.length
      const under = { ...BACKSTAGE_LIMITS, modelledEntities: whole - 1 }
      const root = await scratch()
      const cache = await usable(storeAt(root, { now: () => served.startedAt, limits: under }))
      await cache.write(served)
      expect(await cache.read('fresh')).toEqual({ none: { kind: 'unverified', reason: 'items' } })

      const longest = Math.max(...served.whole.map((item) => Buffer.byteLength(JSON.stringify(item))))
      const short = { ...BACKSTAGE_LIMITS, bytesPerResponse: longest - 1 }
      const other = await usable(storeAt(await scratch(), { now: () => served.startedAt, limits: short }))
      await other.write(served)
      expect(await other.read('fresh')).toEqual({ none: { kind: 'unverified', reason: 'size' } })
    })

    it('refuses a file larger than a run may read, reading no further than its size: not even its header', async () => {
      const served = await servedOf()
      const small = { ...BACKSTAGE_LIMITS, bytesPerRun: 1000 }
      const root = await scratch()
      const cache = await usable(storeAt(root, { now: () => served.startedAt, limits: small }))
      await cache.write(served)
      const { file } = await copyIn(root)
      await edited(file, (text) => Buffer.concat([Buffer.from('not a header'), text]))
      expect(await cache.read('fresh')).toEqual({ none: { kind: 'unverified', reason: 'size' } })
    })

    it('refuses a copy whose folder was swapped for a link between the check and the open, as openToRead does', async () => {
      const { root, served, key, copy } = await kept()
      const folder = path.join(root, 'idp-agent/backstage', key)
      const elsewhere = await scratch()
      const swapped = await usable(
        catalogueCache({
          root,
          base: BASE,
          token: TOKEN,
          owner: OWNER,
          limits: BACKSTAGE_LIMITS,
          now: () => served.startedAt,
          openRead: async (realRoot, absolute, options) => {
            if (absolute.endsWith('served.json')) {
              await copyFile(path.join(folder, 'served.json'), path.join(elsewhere, 'served.json'))
              await rename(folder, path.join(root, 'moved'))
              await symlink(elsewhere, folder)
            }
            return openToRead(realRoot, absolute, options)
          },
        }),
      )
      expect(await swapped.read('fresh')).toEqual({ none: { kind: 'link', path: copy } })
    })

    it('refuses a write whose key folder was swapped for a link after the temporary file was written, before the rename', async () => {
      const root = await scratch()
      const served = await servedOf()
      const moved = path.join(await scratch(), 'moved')
      let folder = ''
      const swapped = await usable(
        catalogueCache({
          root,
          base: BASE,
          token: TOKEN,
          owner: OWNER,
          limits: BACKSTAGE_LIMITS,
          now: () => served.startedAt,
          // The temporary copy written whole and closed, then the key folder moved away and a link to it put in its place.
          openWrite: async (realRoot, relative, options) => {
            const handle = await openNew(realRoot, relative, options)
            if (handle === undefined || !relative.endsWith('.tmp') || relative.includes('/secret.')) return handle
            folder = path.join(realRoot, path.dirname(relative))
            const close = handle.close.bind(handle)
            return Object.assign(handle, {
              close: async () => {
                await close()
                await rename(folder, moved)
                await symlink(moved, folder)
              },
            })
          },
        }),
      )
      expect(await swapped.write(served)).toEqual({
        written: false,
        refusal: { kind: 'link', path: `idp-agent/backstage/${swapped.key}` },
      })
      expect(folder).toBe(path.join(await realRootOf(root), 'idp-agent/backstage', swapped.key))
      expect((await lstat(folder)).isSymbolicLink()).toBe(true)
      expect(await readdir(moved)).toEqual([])
    })
  })

  describe('races, the clock and the pruning', () => {
    const SECRET = 'idp-agent/backstage/secret'

    /** A root holding one copy of `first`, and a second whole copy of another read set aside, sealed under the same key. */
    async function twoCopies() {
      const root = await scratch()
      const first = await servedOf()
      const second = await servedOf(catalogue().slice(1))
      const now = () => first.startedAt + 60_000
      const cache = await usable(storeAt(root, { now }))
      await cache.write(second)
      const { key, file } = await copyIn(root)
      const aside = path.join(await scratch(), 'second.json')
      await copyFile(file, aside)
      await cache.write(first)
      return { root, first, second, now, key, file, aside, copy: `idp-agent/backstage/${key}/served.json` }
    }

    /**
     * An open that stages a sibling run's rename exactly where it lands between
     * `openToRead`'s open and its check: a new whole file renamed over the name,
     * and the refusal `openToRead` then throws. `times` renames, then the real open.
     */
    function replacing(name: string, replacement: () => Promise<string>, times: number) {
      const calls: string[] = []
      const openRead: typeof openToRead = async (realRoot, absolute, options) => {
        calls.push(absolute)
        if (absolute.endsWith(name) && calls.filter((call) => call.endsWith(name)).length <= times) {
          await rename(await replacement(), absolute)
          throw new LinkRefused(path.relative(realRoot, absolute).split(path.sep).join('/'), true)
        }
        return openToRead(realRoot, absolute, options)
      }
      return { openRead, calls }
    }

    /** A fresh copy of `file` beside it, to be renamed over a name. */
    const copyOf = (file: string) => async (): Promise<string> => {
      const fresh = `${file}.${String(Math.random()).slice(2)}`
      await copyFile(file, fresh)
      await chmod(fresh, 0o600)
      return fresh
    }

    const storeWith = (root: string, now: () => number, openRead: typeof openToRead) =>
      catalogueCache({ root, base: BASE, token: TOKEN, owner: OWNER, limits: BACKSTAGE_LIMITS, now, openRead })

    it('opens a copy replaced between the open and its check again, and reads the new one whole', async () => {
      const { root, second, now, aside } = await twoCopies()
      const { openRead, calls } = replacing('served.json', copyOf(aside), 1)
      const read = await (await usable(storeWith(root, now, openRead))).read('fresh')
      if (!('kept' in read)) throw new Error(`no copy: ${JSON.stringify(read)}`)
      expect(read.kept.served).toEqual({ ...second, whole: second.whole.map(declared) })
      expect(calls.filter((call) => call.endsWith('served.json'))).toHaveLength(2)
    })

    it('says busy after a copy replaced under three opens in a row', async () => {
      const { root, now, aside, copy } = await twoCopies()
      const { openRead, calls } = replacing('served.json', copyOf(aside), 3)
      const cache = await usable(storeWith(root, now, openRead))
      expect(await cache.read('fresh')).toEqual({ none: { kind: 'busy', path: copy } })
      expect(calls.filter((call) => call.endsWith('served.json'))).toHaveLength(3)
    })

    it('refuses a real link at the copy on the first open, and never retries it as a replacement', async () => {
      const { root, now, file, copy } = await twoCopies()
      const elsewhere = await scratch()
      await rename(file, path.join(elsewhere, 'moved'))
      await symlink(path.join(elsewhere, 'moved'), file)
      const calls: string[] = []
      const openRead: typeof openToRead = (realRoot, absolute, options) => {
        calls.push(absolute)
        return openToRead(realRoot, absolute, options)
      }
      expect(await (await usable(storeWith(root, now, openRead))).read('fresh')).toEqual({ none: { kind: 'link', path: copy } })
      expect(calls.filter((call) => call.endsWith('served.json'))).toHaveLength(1)
    })

    it('opens a secret replaced between the open and its check again, and says busy after three', async () => {
      const root = await scratch()
      await usable(storeAt(root))
      const secretFile = path.join(root, SECRET)
      const newSecret = async (): Promise<string> => {
        const fresh = path.join(root, 'idp-agent/backstage', `secret.${String(Math.random()).slice(2)}`)
        await writeFile(fresh, `${'a'.repeat(64)}\n`, { mode: 0o600 })
        return fresh
      }
      const once = replacing('secret', newSecret, 1)
      const replaced = await usable(storeWith(root, () => NOW, once.openRead))
      expect(await readFile(secretFile, 'utf8')).toBe(`${'a'.repeat(64)}\n`)
      expect(replaced.key).toBe((await usable(storeAt(root))).key)
      expect(once.calls.filter((call) => call.endsWith('secret'))).toHaveLength(2)

      const thrice = replacing('secret', newSecret, 3)
      expect(await storeWith(root, () => NOW, thrice.openRead)).toEqual({ unusable: { kind: 'busy', path: SECRET } })

      const linked = await scratch()
      await usable(storeAt(linked))
      await rename(path.join(linked, SECRET), path.join(linked, 'moved'))
      await symlink(path.join(linked, 'moved'), path.join(linked, SECRET))
      const calls: string[] = []
      const counting: typeof openToRead = (realRoot, absolute, options) => {
        calls.push(absolute)
        return openToRead(realRoot, absolute, options)
      }
      expect(await storeWith(linked, () => NOW, counting)).toEqual({ unusable: { kind: 'link', path: SECRET } })
      expect(calls).toHaveLength(1)
    })

    it('reads a copy whole from its descriptor when a second is renamed over its name mid-read: rename never mixes two', async () => {
      const { root, first, now, aside, file } = await twoCopies()
      const openRead: typeof openToRead = async (realRoot, absolute, options) => {
        const handle = await openToRead(realRoot, absolute, options)
        if (absolute.endsWith('served.json')) await rename(await copyOf(aside)(), file)
        return handle
      }
      const read = await (await usable(storeWith(root, now, openRead))).read('fresh')
      if (!('kept' in read)) throw new Error(`no copy: ${JSON.stringify(read)}`)
      expect(read.kept.served).toEqual({ ...first, whole: first.whole.map(declared) })
    })

    it('never takes a copy dated after now as fresh, and reads it when kept is asked for', async () => {
      const root = await scratch()
      const served = await servedOf()
      const cache = await usable(storeAt(root, { now: () => served.startedAt - 10 * 60_000 }))
      await cache.write(served)
      expect(await cache.read('fresh')).toEqual({ none: 'stale' })
      const kept = await cache.read('kept')
      if (!('kept' in kept)) throw new Error(`no copy: ${JSON.stringify(kept)}`)
      expect(kept.kept.fetchedAt).toBe(served.startedAt)
    })

    it('skips a stale copy by its header before verifying it; kept verifies it and refuses it', async () => {
      const root = await scratch()
      const served = await servedOf()
      const cache = await usable(storeAt(root, { now: () => served.startedAt + 6 * 60_000 }))
      await cache.write(served)
      const { file } = await copyIn(root)
      const text = await readFile(file)
      text[text.length - 10] = (text[text.length - 10] ?? 0) ^ 0x01
      await writeFile(file, text)
      expect(await cache.read('fresh')).toEqual({ none: 'stale' })
      expect(await cache.read('kept')).toEqual({ none: { kind: 'unverified', reason: 'mac' } })
    })

    it('prunes, after a write, a copy older than seven days and its folder, and a temporary file older than the TTL', async () => {
      const root = await scratch()
      const served = await servedOf()
      const now = served.startedAt + 60_000
      const cache = await usable(storeAt(root, { now: () => now }))
      const store = path.join(root, 'idp-agent/backstage')
      const aged = async (at: string, ms: number): Promise<void> => {
        await utimes(at, (now - ms) / 1000, (now - ms) / 1000)
      }
      const sibling = async (name: string, files: Record<string, number>): Promise<string> => {
        const folder = path.join(store, name)
        await mkdir(folder, { mode: 0o700 })
        for (const [file, age] of Object.entries(files)) {
          await writeFile(path.join(folder, file), 'x', { mode: 0o600 })
          await aged(path.join(folder, file), age)
        }
        return folder
      }
      const DAY = 24 * 60 * 60_000
      const old = await sibling('0'.repeat(32), { 'served.json': CATALOGUE_CACHE.keepMs + DAY })
      const young = await sibling('1'.repeat(32), { 'served.json': CATALOGUE_CACHE.keepMs - DAY })
      const temporary = await sibling('2'.repeat(32), {
        'served.json.123.abcdef.tmp': CATALOGUE_CACHE.ttlMs + 60_000,
        'served.json.456.abcdef.tmp': CATALOGUE_CACHE.ttlMs - 60_000,
      })
      const otherwise = await sibling('3'.repeat(32), { 'served.json': CATALOGUE_CACHE.keepMs + DAY, 'notes.txt': 3 * CATALOGUE_CACHE.keepMs })
      const named = await sibling('not-a-key', { 'served.json': CATALOGUE_CACHE.keepMs + DAY })
      const elsewhere = await scratch()
      await writeFile(path.join(elsewhere, 'served.json'), 'x')
      await aged(path.join(elsewhere, 'served.json'), CATALOGUE_CACHE.keepMs + DAY)
      await symlink(elsewhere, path.join(store, '4'.repeat(32)))
      await writeFile(path.join(store, 'loose.tmp'), 'x', { mode: 0o600 })
      await aged(path.join(store, 'loose.tmp'), CATALOGUE_CACHE.keepMs + DAY)

      expect(await cache.write(served)).toEqual({ written: true })

      expect((await readdir(store)).sort()).toEqual(
        [cache.key, '1'.repeat(32), '2'.repeat(32), '3'.repeat(32), '4'.repeat(32), 'loose.tmp', 'not-a-key', 'secret'].sort(),
      )
      expect(old).not.toBe(young)
      expect(await readdir(young)).toEqual(['served.json'])
      expect(await readdir(temporary)).toEqual(['served.json.456.abcdef.tmp'])
      expect(await readdir(otherwise)).toEqual(['notes.txt'])
      expect(await readdir(named)).toEqual(['served.json'])
      expect(await readdir(elsewhere)).toEqual(['served.json'])
      expect(await readdir(path.join(store, cache.key))).toEqual(['served.json'])
    })

    it('leaves an empty key folder another run has just made for its copy, and removes one empty for longer than the TTL', async () => {
      const root = await scratch()
      const served = await servedOf()
      const now = served.startedAt + 60_000
      const cache = await usable(storeAt(root, { now: () => now }))
      const store = path.join(root, 'idp-agent/backstage')
      const emptied = async (name: string, ms: number): Promise<string> => {
        const folder = path.join(store, name)
        await mkdir(folder, { mode: 0o700 })
        await utimes(folder, (now - ms) / 1000, (now - ms) / 1000)
        return folder
      }
      // Another run's folder between its mkdir and its temporary file, while it seals a large catalogue.
      const making = await emptied('5'.repeat(32), 1_000)
      const abandoned = await emptied('6'.repeat(32), CATALOGUE_CACHE.ttlMs + 60_000)

      expect(await cache.write(served)).toEqual({ written: true })

      expect(await readdir(making)).toEqual([])
      expect((await readdir(store)).sort()).toEqual([cache.key, '5'.repeat(32), 'secret'].sort())
      expect(abandoned).not.toBe(making)
    })

    it('prunes nothing when a read is only read, and nothing in a folder of another mode', async () => {
      const root = await scratch()
      const served = await servedOf()
      const now = served.startedAt + 60_000
      const cache = await usable(storeAt(root, { now: () => now }))
      await cache.write(served)
      const store = path.join(root, 'idp-agent/backstage')
      const folder = path.join(store, '0'.repeat(32))
      await mkdir(folder, { mode: 0o700 })
      await writeFile(path.join(folder, 'served.json'), 'x', { mode: 0o600 })
      const past = (now - 2 * CATALOGUE_CACHE.keepMs) / 1000
      await utimes(path.join(folder, 'served.json'), past, past)
      await cache.read('fresh')
      expect(await readdir(folder)).toEqual(['served.json'])
      await chmod(folder, 0o750)
      await cache.write(served)
      expect(await readdir(folder)).toEqual(['served.json'])
    })
  })
})
