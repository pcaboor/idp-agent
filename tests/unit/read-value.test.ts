import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { IacFsProvider } from '../../src/context/iac-fs/provider.js'
import {
  parseDocuments,
  readDocuments,
  readValue,
  type ValueReading,
} from '../../src/core/yaml/serialize.js'

/**
 * The reader of entity documents is two halves: `readDocuments` turns YAML
 * into values, and `readValue` reads one value. The `backstage-http` provider
 * will call the second on each item a catalogue serves, so a file and a
 * catalogue meet one reader and one set of refusal words. The extraction
 * changed nothing, and the digests below are how that is known rather than
 * claimed.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Every folder the YAML road is pinned over: the demo SI and each golden that holds YAML. */
const FOLDERS = [
  'fixtures/si-demo',
  'tests/golden/backstage-apis',
  'tests/golden/backstage-namespaces',
  'tests/golden/broken-si',
  'tests/golden/dangling-shown',
  'tests/golden/multi-doc',
  'tests/golden/relations-owner',
] as const

const PER_FILE = 'parseDocuments, every YAML file of every folder above'

/**
 * Recorded on 60974de, before `readValue` existed. A later change of the YAML
 * road updates one in the commit that explains why.
 *
 * backstage-http slice 3 moved two: `tests/golden/backstage-apis` holds a Group
 * (`org/teams.yml`), read now as an organisation node where it was set aside,
 * and every `parseDocuments` result gained its `organisation` list, empty but
 * in that file. Nothing else moved, which `ELSE_ON_F8BCB43` pins.
 */
const BEFORE: Record<string, string> = {
  'fixtures/si-demo': 'ea6c835a2e313c2f2dff94ebd5ec5fbfe372ad6652fed4a45f4033bf5fa0905c',
  'tests/golden/backstage-apis': '30bb2e086bd4b15bbebca2b9cd6e43b460821bffa51507bc3a23ef8f445270ff',
  'tests/golden/backstage-namespaces': '9e221886cd5ff96e1632730068f33b446c1978eecef204d988e58af859cbf382',
  'tests/golden/broken-si': '8bb4de03c34aa3321806bb9f051d3a3b274933cd7d4f2e93984e9e92b6c9b8cb',
  'tests/golden/dangling-shown': 'f027b9b117fd5e96c4be2a89dcdf297f6c58e829a17bbadc272145356828c9f4',
  'tests/golden/multi-doc': 'e3b544e49967eee353459ef3ca0435606e295470bf9499f49220a5f4c2335c88',
  'tests/golden/relations-owner': '9e4bc25f8b48f8dbc10b3f25879901afc76d085ded91c8f44628e54339399001',
  [PER_FILE]: '73fb051c200f75e3ef019defed043718028fb5128fce351299bea4950e7574a8',
}

/** The one file whose reading slice 3 changed: a Group, read. */
const TEAMS = 'tests/golden/backstage-apis/org/teams.yml'

/**
 * `parseDocuments` of every file but `TEAMS`, an empty `organisation` list
 * left out, as f8bcb43 read them — measured there, before backstage-http slice
 * 3, and equal to 60974de's reading of the same files.
 */
const ELSE_ON_F8BCB43 = '9d039c9bf82d056bb7e4371e8202767c20bca09e368d250709dcc0700328e4ef'

/**
 * JSON with every object's keys sorted and `undefined` kept as a marker, so a
 * field that turns from absent into `undefined` moves the digest too. Arrays
 * keep their order: the order of what a reader returns is part of what it
 * returns.
 */
function canonical(value: unknown): unknown {
  if (value === undefined) return '<undefined>'
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

const digestOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
}

async function readingsOf(folder: string): Promise<unknown> {
  const root = path.join(ROOT, folder)
  return {
    fixtures: await new FixtureProvider(root).load(),
    iacFs: await new IacFsProvider(root).load(),
  }
}

async function perFileReadings(): Promise<unknown> {
  const readings: Record<string, unknown> = {}
  for (const folder of FOLDERS) {
    for (const file of await yamlFiles(path.join(ROOT, folder))) {
      readings[path.relative(ROOT, file)] = parseDocuments(await readFile(file, 'utf8'))
    }
  }
  return readings
}

describe('the YAML road, pinned across the extraction of readValue', () => {
  it.each(FOLDERS)('reads %s exactly as it did before readValue', async (folder) => {
    expect(digestOf(await readingsOf(folder))).toBe(BEFORE[folder])
  })

  it('reads every file exactly as it did before readValue', async () => {
    expect(digestOf(await perFileReadings())).toBe(BEFORE[PER_FILE])
  })

  it('reads every file but the one holding a Group as it did before the organisation was read', async () => {
    const readings = (await perFileReadings()) as Record<string, ReturnType<typeof parseDocuments>>
    const rest: Record<string, unknown> = {}
    for (const [file, reading] of Object.entries(readings)) {
      if (file === TEAMS) continue
      const { organisation, ...before } = reading
      rest[file] = organisation.length === 0 ? before : reading
    }
    expect(digestOf(rest)).toBe(ELSE_ON_F8BCB43)
    expect(readings[TEAMS]?.organisation.map(({ kind, metadata }) => `${kind} ${metadata.name}`)).toEqual(['Group tiger'])
    expect(readings[TEAMS]?.ignored).toEqual([])
  })
})

const HEAD = { apiVersion: 'backstage.io/v1alpha1' } as const

const GROUP = {
  ...HEAD,
  kind: 'Group',
  metadata: { name: 'tiger' },
  spec: { type: 'team', children: [] },
}

const BILLING_API = {
  ...HEAD,
  kind: 'Component',
  metadata: { name: 'billing-api' },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
}

const API = (namespace: string): unknown => ({
  ...HEAD,
  kind: 'API',
  metadata: { name: 'billing', namespace },
  spec: {
    type: 'openapi',
    lifecycle: 'production',
    owner: 'group:default/tiger',
    definition: 'openapi 3.1',
  },
})

/**
 * What `parseDocuments` returns, rebuilt from the two halves by hand: the
 * definition of the fold, written apart from the one in `serialize.ts` so the
 * two can disagree.
 */
function fold(text: string): ReturnType<typeof parseDocuments> {
  const folded: ReturnType<typeof parseDocuments> = {
    entities: [],
    apis: [],
    organisation: [],
    rejections: [],
    ignored: [],
    unread: [],
    documents: 0,
  }
  for (const reading of readDocuments(text)) {
    folded.documents += 1
    if ('error' in reading) {
      folded.rejections.push(reading.error)
      continue
    }
    const read: ValueReading = readValue(reading.value)
    if (read.as === 'rejected') folded.rejections.push(read.reason)
    if (read.as === 'ignored') folded.ignored.push(read.document)
    if (read.as === 'api') folded.apis.push(read.api)
    if (read.as === 'organisation') folded.organisation.push(read.entity)
    if (read.as === 'entity') folded.entities.push(read.entity)
    if (read.as === 'api' || read.as === 'organisation' || read.as === 'entity') {
      folded.unread.push(...read.unread)
    }
  }
  return folded
}

describe('readValue, one value as a file reads it', () => {
  it('reads null as a witness, not a rejection', () => {
    expect(readValue(null)).toEqual({ as: 'witness' })
    expect(readValue(undefined)).toEqual({ as: 'witness' })
  })

  it('refuses a kind Backstage does not define under its own apiVersion, naming the kinds it does', () => {
    const read = readValue({ ...HEAD, kind: 'Resouce', metadata: { name: 'x' } })
    expect(read).toEqual({
      as: 'rejected',
      reason: expect.stringContaining('API, Component, Domain'),
    })
  })

  it('reads a Group, and sets one Backstage would refuse aside with its reference, so a dependsOn naming it is not dangling', () => {
    expect(readValue(GROUP)).toMatchObject({
      as: 'organisation',
      entity: { kind: 'Group', metadata: { name: 'tiger' } },
    })
    expect(readValue({ ...GROUP, spec: { type: 'team' } })).toMatchObject({
      as: 'ignored',
      document: { kind: 'Group', ref: 'group:default/tiger' },
    })
  })

  it('sets an API of another namespace aside, and reads one of default', () => {
    expect(readValue(API('payments'))).toMatchObject({
      as: 'ignored',
      document: { kind: 'API', ref: 'api:payments/billing' },
    })
    expect(readValue(API('default'))).toMatchObject({
      as: 'api',
      api: { kind: 'API', metadata: { name: 'billing' }, spec: { definition: 'declared' } },
      unread: [],
    })
  })

  it('reads an API, and counts what it holds that the read model does not read', () => {
    // No fixture or golden holds such an API, so the digests above cannot see this branch.
    expect(readValue({ ...(API('default') as object), relations: [] })).toMatchObject({
      as: 'api',
      api: { kind: 'API', metadata: { name: 'billing' } },
      unread: ['relations'],
    })
  })

  it('reads a Component, and counts what it holds that the read model does not read', () => {
    expect(readValue({ ...BILLING_API, relations: [] })).toMatchObject({
      as: 'entity',
      entity: { kind: 'Component', metadata: { name: 'billing-api' } },
      unread: ['relations'],
    })
  })

  it("refuses a Component missing its owner in reasonOf's words", () => {
    const spec = { type: 'service', lifecycle: 'production' }
    expect(readValue({ ...BILLING_API, spec })).toEqual({
      as: 'rejected',
      reason: 'spec.owner: required',
    })
  })

  it('is what parseDocuments folds: the same readings for every document of every file', async () => {
    let files = 0
    for (const folder of FOLDERS) {
      for (const file of await yamlFiles(path.join(ROOT, folder))) {
        const text = await readFile(file, 'utf8')
        expect(parseDocuments(text), path.relative(ROOT, file)).toEqual(fold(text))
        files += 1
      }
    }
    // Not vacuous: the loop met the files the digests above are taken over.
    expect(files).toBeGreaterThan(50)
  })
})
