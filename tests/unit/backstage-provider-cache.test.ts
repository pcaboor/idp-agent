import { createHmac } from 'node:crypto'
import { chmod, lstat, mkdtemp, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { catalogueCache } from '../../src/context/backstage/cache.js'
import { BACKSTAGE_LIMITS, type BackstageLimits } from '../../src/context/backstage/limits.js'
import { BackstageProvider } from '../../src/context/backstage/provider.js'
import { CatalogueReadError, type CatalogueFetch } from '../../src/context/backstage/transport.js'
import type { LoadResult } from '../../src/context/provider.js'
import { catalogueOf } from '../../tools/fake-backstage.js'
import { fakeBackstage, type Faults } from '../support/fake-backstage.js'

/**
 * The provider's three uses of the store (docs/plans/backstage-http-slice-2.md,
 * Task 2.2, Step 7): `fresh`, a run with neither flag; `refresh`, which never
 * answers from a copy; `kept`, which never asks the catalogue. Each row asserts
 * the whole report — what was read and what was written — and whether the
 * catalogue was asked. Every root is a folder under the run directory.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const ORG = path.resolve(import.meta.dirname, '../../tools/backstage/org.yaml')
const BASE = new URL('https://backstage.canary.example/api/catalog')
const TOKEN = 'canary-backstage-token-0123456789'
const OWNER = process.getuid?.() ?? -1
const MINUTE = 60_000

type Item = Record<string, unknown>

const scratch = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-provider-cache-'))
const catalogue = (): Item[] => catalogueOf(DEMO, { org: ORG })

/** The fake, and what it was sent. */
const fake = (faults: Faults = {}, token = TOKEN) => fakeBackstage({ entities: catalogue(), token, faults })

const loading = (
  root: string,
  use: 'fresh' | 'refresh' | 'kept',
  fetch: CatalogueFetch,
  now: () => number = Date.now,
  limits: Partial<BackstageLimits> = {},
): Promise<LoadResult> =>
  new BackstageProvider({ base: BASE, token: TOKEN, catalogueFetch: fetch, limits, cache: { root, owner: OWNER, use, now } }).load()

/** The error a load ended on; the test fails if it returned. */
async function errorOf(load: Promise<LoadResult>): Promise<CatalogueReadError> {
  const thrown = await load.then(
    () => new Error('the load returned'),
    (error: unknown) => error,
  )
  expect(thrown).toBeInstanceOf(CatalogueReadError)
  return thrown as CatalogueReadError
}

const STORE = (root: string): string => path.join(root, 'idp-agent/backstage')

/** Every copy under `root`, by its key. */
async function copies(root: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>()
  for (const name of await readdir(STORE(root)).catch(() => [])) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue
    found.set(name, await readFile(path.join(STORE(root), name, 'served.json')))
  }
  return found
}

/** The one copy under `root`, and when its load began. */
async function theCopy(root: string): Promise<{ key: string; file: string; fetchedAt: number }> {
  const keys = [...(await copies(root)).keys()]
  expect(keys).toHaveLength(1)
  const key = keys[0] ?? ''
  const file = path.join(STORE(root), key, 'served.json')
  const header = JSON.parse((await readFile(file, 'utf8')).split('\n')[0] ?? '') as { fetchedAt: string }
  return { key, file, fetchedAt: Date.parse(header.fetchedAt) }
}

/** A root holding one copy, made by a fresh load, and when its load began. */
async function kept(): Promise<{ root: string; first: LoadResult; key: string; file: string; fetchedAt: number }> {
  const root = await scratch()
  const first = await loading(root, 'fresh', fake().fetch)
  return { root, first, ...(await theCopy(root)) }
}

const withoutCache = ({ cache: _cache, ...rest }: LoadResult): LoadResult => rest

/** A fetch that never reaches anything: a refused connection, as `fetch` throws one. */
const unreachable: CatalogueFetch = () =>
  Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }))

describe.skipIf(process.platform === 'win32' || OWNER === 0)('BackstageProvider with a cache', () => {
  it('fresh, an empty root: one load, the copy written', async () => {
    const root = await scratch()
    const { fetch, sent } = fake()
    const result = await loading(root, 'fresh', fetch)
    expect(sent.length).toBeGreaterThan(0)
    expect(result.cache).toEqual({ read: { state: 'absent' }, written: { state: 'written' } })
    expect((await copies(root)).size).toBe(1)
  })

  it('fresh, a copy 4 min old: no request, the result the load gave, and the copy’s age', async () => {
    const { root, first, fetchedAt } = await kept()
    const { fetch, sent } = fake()
    const result = await loading(root, 'fresh', fetch, () => fetchedAt + 4 * MINUTE)
    expect(sent).toEqual([])
    expect(result.cache).toEqual({ read: { state: 'fresh', fetchedAt, ageMs: 4 * MINUTE } })
    expect(withoutCache(result)).toEqual(withoutCache(first))
  })

  it.each([
    ['6 min old', 6 * MINUTE],
    ['dated ahead of now', -MINUTE],
  ])('fresh, a copy %s: a load, the copy replaced', async (_, age) => {
    const { root, file, fetchedAt } = await kept()
    const before = await readFile(file)
    const { fetch, sent } = fake()
    const result = await loading(root, 'fresh', fetch, () => fetchedAt + age)
    expect(sent.length).toBeGreaterThan(0)
    expect(result.cache).toEqual({ read: { state: 'stale' }, written: { state: 'written' } })
    expect(await readFile(file)).not.toEqual(before)
  })

  it('fresh, a copy that does not verify: a load, the copy replaced', async () => {
    const { root, file, fetchedAt } = await kept()
    const text = await readFile(file)
    text[text.length - 10] = (text[text.length - 10] ?? 0) ^ 0x01
    await writeFile(file, text)
    const { fetch, sent } = fake()
    const result = await loading(root, 'fresh', fetch, () => fetchedAt + MINUTE)
    expect(sent.length).toBeGreaterThan(0)
    expect(result.cache).toEqual({
      read: { state: 'not-used', refusal: { kind: 'unverified', reason: 'mac' } },
      written: { state: 'written' },
    })
    expect(await readFile(file)).not.toEqual(text)
  })

  it('fresh, a key that is a file: a load, neither read nor written', async () => {
    const root = await scratch()
    const made = await catalogueCache({ root, base: BASE, token: TOKEN, owner: OWNER, limits: BACKSTAGE_LIMITS })
    if (!('cache' in made)) throw new Error('unusable')
    await writeFile(path.join(STORE(root), made.cache.key), 'a file', { mode: 0o600 })
    const refusal = { kind: 'not-a-folder', path: `idp-agent/backstage/${made.cache.key}` }
    const result = await loading(root, 'fresh', fake().fetch)
    expect(result.cache).toEqual({
      read: { state: 'not-used', refusal },
      written: { state: 'not-written', refusal },
    })
    expect(await readFile(path.join(STORE(root), made.cache.key), 'utf8')).toBe('a file')
  })

  it('fresh, a store open to others: a load, nothing read or written, no mode changed', async () => {
    const root = await scratch()
    await catalogueCache({ root, base: BASE, token: TOKEN, owner: OWNER, limits: BACKSTAGE_LIMITS })
    await chmod(STORE(root), 0o755)
    const { fetch, sent } = fake()
    const result = await loading(root, 'fresh', fetch)
    const refusal = { kind: 'open', path: 'idp-agent/backstage', mode: 0o755 }
    expect(sent.length).toBeGreaterThan(0)
    expect(result.cache).toEqual({
      read: { state: 'not-used', refusal },
      written: { state: 'not-written', refusal },
    })
    expect(await readdir(STORE(root))).toEqual(['secret'])
    expect((await lstat(STORE(root))).mode & 0o777).toBe(0o755)
  })

  it.each([
    ['a 503', (): CatalogueFetch => fake({ status: { at: 0, status: 503 } }).fetch, { kind: 'status', status: 503 }],
    ['a refused connection', (): CatalogueFetch => unreachable, { kind: 'unreachable', cause: 'ECONNREFUSED' }],
    ['a 429 past what a run waits', (): CatalogueFetch => fake({ status: { at: 0, status: 429 } }).fetch, { kind: 'rate-limited' }],
  ])('fresh, a load that fails for reach (%s), a copy 2 h old kept: the failure says the copy’s age; nothing written', async (_, fetch, failure) => {
    const { root, file, fetchedAt } = await kept()
    const before = await readFile(file)
    const error = await errorOf(loading(root, 'fresh', fetch(), () => fetchedAt + 120 * MINUTE))
    expect(error.failure).toEqual(failure)
    expect(error.kept).toEqual({ ageMs: 120 * MINUTE })
    expect(await readFile(file)).toEqual(before)
  })

  it.each([
    ['a 401', (): CatalogueFetch => fake({}, 'another-token').fetch],
    ['a 403', (): CatalogueFetch => fake({ status: { at: 0, status: 403 } }).fetch],
    ['a 404', (): CatalogueFetch => fake({ status: { at: 0, status: 404 } }).fetch],
  ])('fresh, a load that fails with %s, a copy kept: the failure names no copy', async (_, fetch) => {
    const { root, fetchedAt } = await kept()
    const error = await errorOf(loading(root, 'fresh', fetch(), () => fetchedAt + 120 * MINUTE))
    expect(error.kept).toBeUndefined()
  })

  it('refresh, a copy 1 min old: a load, the copy replaced', async () => {
    const { root, file, fetchedAt } = await kept()
    const before = await readFile(file)
    const { fetch, sent } = fake()
    const result = await loading(root, 'refresh', fetch, () => fetchedAt + MINUTE)
    expect(sent.length).toBeGreaterThan(0)
    expect(result.cache).toEqual({ read: { state: 'skipped' }, written: { state: 'written' } })
    expect(await readFile(file)).not.toEqual(before)
  })

  it('refresh, a load that fails for reach, a copy 1 min old: the failure says its age; the copy kept', async () => {
    const { root, file, fetchedAt } = await kept()
    const before = await readFile(file)
    const error = await errorOf(loading(root, 'refresh', unreachable, () => fetchedAt + MINUTE))
    expect(error.kept).toEqual({ ageMs: MINUTE })
    expect(await readFile(file)).toEqual(before)
  })

  it('kept, a copy 3 days old: no request, the copy and its age', async () => {
    const { root, first, fetchedAt } = await kept()
    const { fetch, sent } = fake()
    const result = await loading(root, 'kept', fetch, () => fetchedAt + 3 * 24 * 60 * MINUTE)
    expect(sent).toEqual([])
    expect(result.cache).toEqual({ read: { state: 'kept', fetchedAt, ageMs: 3 * 24 * 60 * MINUTE } })
    expect(withoutCache(result)).toEqual(withoutCache(first))
  })

  it('kept, a copy dated ahead of now: read, of an age this clock cannot tell', async () => {
    const { root, fetchedAt } = await kept()
    const result = await loading(root, 'kept', fake().fetch, () => fetchedAt - 10 * MINUTE)
    expect(result.cache).toEqual({ read: { state: 'kept', fetchedAt, ageMs: undefined } })
  })

  it('kept, no copy, one that does not verify, or a store that cannot be used: not-kept, and no request', async () => {
    const empty = await scratch()
    const { fetch, sent } = fake()
    expect((await errorOf(loading(empty, 'kept', fetch))).failure).toEqual({ kind: 'not-kept' })
    // A kept read writes nothing: no folder, no secret, and not a missing root either.
    expect(await readdir(empty)).toEqual([])
    expect((await errorOf(loading(path.join(empty, 'cache'), 'kept', fetch))).failure).toEqual({ kind: 'not-kept' })
    expect(await readdir(empty)).toEqual([])
    const secretless = await scratch()
    await loading(secretless, 'fresh', fake().fetch)
    await unlink(path.join(STORE(secretless), 'secret'))
    const layout = await readdir(secretless, { recursive: true })
    expect((await errorOf(loading(secretless, 'kept', fetch))).failure).toEqual({ kind: 'not-kept' })
    expect(await readdir(secretless, { recursive: true })).toEqual(layout)

    const { root, file, fetchedAt } = await kept()
    const text = await readFile(file)
    text[text.length - 10] = (text[text.length - 10] ?? 0) ^ 0x01
    await writeFile(file, text)
    expect((await errorOf(loading(root, 'kept', fetch, () => fetchedAt))).failure).toEqual({ kind: 'not-kept' })

    await chmod(STORE(root), 0o755)
    const error = await errorOf(loading(root, 'kept', fetch, () => fetchedAt))
    expect(error.failure).toEqual({ kind: 'not-kept' })
    expect(error.message).toBe(
      'the catalogue at https://backstage.canary.example has no copy kept on this machine that verifies, and a kept read never asks it',
    )
    expect(sent).toEqual([])
  })

  it('fresh, under other limits than the copy was made under: another key, a load, the other copy never read', async () => {
    const { root, file, fetchedAt } = await kept()
    const before = await readFile(file)
    const { fetch, sent } = fake()
    const result = await loading(root, 'fresh', fetch, () => fetchedAt + MINUTE, { modelledEntities: 40 })
    expect(sent.length).toBeGreaterThan(0)
    expect(result.cache).toEqual({ read: { state: 'absent' }, written: { state: 'written' } })
    expect((await copies(root)).size).toBe(2)
    expect(await readFile(file)).toEqual(before)
  })

  it('with no cache option: exactly the load of today, no cache key on the result', async () => {
    const { fetch } = fake()
    const result = await new BackstageProvider({ base: BASE, token: TOKEN, catalogueFetch: fetch }).load()
    expect(Object.hasOwn(result, 'cache')).toBe(false)
  })

  it('runs the pre-pass and the reader on a copy: an item edited on disk to a lifecycle this tool does not write is set aside, as on a page', async () => {
    const { root, key, file, fetchedAt } = await kept()
    const secret = Buffer.from((await readFile(path.join(STORE(root), 'secret'), 'utf8')).trim(), 'hex')
    const text = await readFile(file, 'utf8')
    const [headerLine = '', envelope = '', ...items] = text.split('\n')
    const at = items.findIndex((line) => line.includes('"kind":"Component"') && line.includes('"name":"billing-api"'))
    expect(at).toBeGreaterThanOrEqual(0)
    const item = JSON.parse(items[at] ?? '') as Item
    items[at] = JSON.stringify({ ...item, spec: { ...(item['spec'] as Item), lifecycle: 'beta' } })
    const body = Buffer.from([envelope, ...items].join('\n'), 'utf8')
    const { mac: _mac, ...header } = JSON.parse(headerLine) as Item
    const sealed: Item = { ...header, bytes: body.length }
    const canonical = JSON.stringify({
      format: sealed['format'],
      origin: sealed['origin'],
      fetchedAt: sealed['fetchedAt'],
      count: sealed['count'],
      bytes: sealed['bytes'],
    })
    const mac = createHmac('sha256', secret).update(`idp-agent/backstage-cache/1\n${key}\n${canonical}\n`).update(body).digest('hex')
    await writeFile(file, Buffer.concat([Buffer.from(`${JSON.stringify({ ...sealed, mac })}\n`), body]))

    const result = await loading(root, 'fresh', fake().fetch, () => fetchedAt + MINUTE)
    expect(result.cache?.read).toMatchObject({ state: 'fresh' })
    expect(result.entities.map((entity) => entity.metadata.name)).not.toContain('billing-api')
    expect(result.ignored).toContainEqual(
      expect.objectContaining({ ref: 'component:default/billing-api', prePass: { rule: 'lifecycle', value: 'beta' } }),
    )
  })
})
