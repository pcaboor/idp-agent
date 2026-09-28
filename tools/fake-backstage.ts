/**
 * A fake Backstage catalogue: what a real one serves, from a folder of YAML,
 * answering the two routes this tool reads (docs/backstage-http-brief.md § 9).
 *
 * Imported, it starts nothing: `tests/support/fake-backstage.ts` wraps
 * `handler` as the `fetch` a test hands the transport, and no test opens a
 * socket. Run as a program, it listens with node:http on 127.0.0.1, which is
 * how the demo reads a catalogue with no Backstage installed:
 *
 *     node tools/fake-backstage.ts [--port <n>] [--token <t>] [--root <folder>] [--no-groups]
 *
 * It runs under Node's type stripping (22.18 or later), so it holds no syntax
 * stripping cannot erase — no enum, no parameter property, no namespace — and
 * imports only node: modules and `yaml`. It is typechecked through the test
 * support that imports it.
 *
 * Its paging is Backstage's own, read on backstage/backstage master
 * (docs/plans/backstage-http-slice-1.md, row 22): the cursor carries the
 * filter, the position and the first page's `totalItems`, and nothing else;
 * `limit` and `fields` are read from each request, so a next page sent with
 * its cursor alone comes back at 200 items and whole; a `filter` beside a
 * cursor is ignored (`parseQueryEntitiesParams.ts`); there is no maximum
 * `limit` (`DefaultEntitiesCatalog.ts`); items are ordered by uid, as
 * Backstage breaks ties on `entity_id`.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

type Item = Record<string, unknown>

/** Where the demo SI would live if it were a repository: the location every served entity names. */
const DEMO_LOCATION = 'url:https://github.com/acme/si-demo/blob/main/'

/** The two annotations Backstage's `ProcessorOutputCollector` overwrites on every entity it emits. */
const MANAGED_BY = 'backstage.io/managed-by-location'
const MANAGED_BY_ORIGIN = 'backstage.io/managed-by-origin-location'

/** Backstage's default page size, when a request sends no `limit`. */
const DEFAULT_LIMIT = 200

const isMapping = (value: unknown): value is Item =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every `.yml`/`.yaml` under `dir`, hidden folders and node_modules skipped, in path order — as `FixtureProvider` reads them. */
function yamlFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') found.push(...yamlFiles(full))
    } else if (/\.ya?ml$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found.sort()
}

/** A stable uid, shaped as Backstage's are: a hash of where the entity was read. */
function uidOf(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** `[kind:][namespace/]name` in full and lower case, or undefined when no kind can be told. */
function fullRef(ref: unknown, defaultKind: string | undefined, namespace: string): string | undefined {
  if (typeof ref !== 'string') return undefined
  const match = /^(?:([^:/]+):)?(?:([^:/]+)\/)?([^:/]+)$/.exec(ref)
  if (match === null) return undefined
  const kind = match[1] ?? defaultKind
  if (kind === undefined) return undefined
  return `${kind}:${match[2] ?? namespace}/${match[3] ?? ''}`.toLowerCase()
}

/**
 * The relations Backstage derives from a spec, as the built-in processor emits
 * them for the entity itself: what it owns, depends on, is a dependency of and
 * provides. Derived, never declared — which is why the reader drops them.
 */
function relationsOf(spec: unknown, namespace: string): Item[] {
  if (!isMapping(spec)) return []
  const relations: Item[] = []
  const add = (type: string, refs: unknown, defaultKind: string | undefined): void => {
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      const targetRef = fullRef(ref, defaultKind, namespace)
      if (targetRef !== undefined) relations.push({ type, targetRef })
    }
  }
  if (spec['owner'] !== undefined) add('ownedBy', spec['owner'], 'group')
  if (spec['dependsOn'] !== undefined) add('dependsOn', spec['dependsOn'], undefined)
  if (spec['dependencyOf'] !== undefined) add('dependencyOf', spec['dependencyOf'], undefined)
  if (spec['providesApis'] !== undefined) add('providesApi', spec['providesApis'], 'api')
  return relations
}

/** One document as the catalogue serves it: a namespace, a uid, an etag, the two locations, relations; `spec` as written. */
function served(document: Item, location: string, seed: string): Item {
  const metadata: Item = isMapping(document['metadata']) ? { ...document['metadata'] } : {}
  const namespace = typeof metadata['namespace'] === 'string' ? metadata['namespace'] : 'default'
  metadata['namespace'] = namespace
  metadata['uid'] = uidOf(seed)
  metadata['etag'] = createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 40)
  // The entity's own annotations first, the two locations after: the catalogue's win.
  metadata['annotations'] = {
    ...(isMapping(metadata['annotations']) ? metadata['annotations'] : {}),
    [MANAGED_BY]: location,
    [MANAGED_BY_ORIGIN]: location,
  }
  return { ...document, metadata, relations: relationsOf(document['spec'], namespace) }
}

/**
 * What a catalogue serves for the folder at `root`: every document of every
 * YAML file in path order, null documents (a witness) and documents that do
 * not parse skipped, each as `served` makes it, located at `location` (the
 * demo SI's repository by default) plus its path from the root. With
 * `groups`, one `kind: Group` per name.
 */
export function catalogueOf(root: string, options: { groups?: readonly string[]; location?: string } = {}): Item[] {
  const prefix = options.location ?? DEMO_LOCATION
  const items: Item[] = []
  for (const file of yamlFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    parseAllDocuments(readFileSync(file, 'utf8')).forEach((document, position) => {
      if (document.errors.length > 0) return
      const value: unknown = document.toJS()
      if (!isMapping(value)) return
      items.push(served(value, `${prefix}${relative}`, `${relative}#${String(position)}`))
    })
  }
  for (const name of options.groups ?? []) {
    const group = { apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name }, spec: { type: 'team', children: [] } }
    items.push(served(group, `${prefix}org/groups.yaml`, `group:${name}`))
  }
  return items
}

/** A value at a dot path of `item`, or undefined. */
function at(item: unknown, dotted: string): unknown {
  let value: unknown = item
  for (const key of dotted.split('.')) {
    if (!isMapping(value)) return undefined
    value = value[key]
  }
  return value
}

/** `item` projected to `fields`, as Backstage's `fields` parameter does. */
function projected(item: Item, fields: readonly string[]): Item {
  const out: Item = {}
  for (const dotted of fields) {
    const value = at(item, dotted)
    if (value === undefined) continue
    const keys = dotted.split('.')
    let into = out
    for (const key of keys.slice(0, -1)) {
      if (!isMapping(into[key])) into[key] = {}
      into = into[key] as Item
    }
    into[keys[keys.length - 1] ?? ''] = value
  }
  return out
}

/**
 * Whether `item` meets the filters: repeated filters are ORed, the
 * `key=value` pairs of one filter ANDed, values compared without case.
 */
function matches(item: Item, filters: readonly string[]): boolean {
  if (filters.length === 0) return true
  return filters.some((filter) =>
    filter.split(',').every((pair) => {
      const [key = '', ...rest] = pair.split('=')
      const value = at(item, key.trim())
      return typeof value === 'string' && value.toLowerCase() === rest.join('=').trim().toLowerCase()
    }),
  )
}

/** What a cursor holds, and nothing else: the filter, the position, the first page's count. */
interface Cursor {
  filter: string[]
  after: string
  totalItems: number
}

const encode = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64')

function decode(text: string): Cursor | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64').toString('utf8'))
    if (!isMapping(value)) return undefined
    const { filter, after, totalItems } = value
    if (!Array.isArray(filter) || !filter.every((each) => typeof each === 'string')) return undefined
    if (typeof after !== 'string' || typeof totalItems !== 'number') return undefined
    return { filter, after, totalItems }
  } catch {
    return undefined
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const uid = (item: Item): string => String(at(item, 'metadata.uid'))

/**
 * The two routes, as a function from a request to a response. `base` is the
 * catalogue API's path (`/api/catalog` by default); with `token`, a request
 * whose bearer is not it is answered 401, as a real backend's auth does
 * before any route. Any other path is a 404, any other method a 405.
 */
export function handler(options: {
  entities: readonly Item[]
  token?: string
  base?: string
}): (request: Request) => Promise<Response> {
  const base = options.base ?? '/api/catalog'
  const ordered = [...options.entities].sort((left, right) => (uid(left) < uid(right) ? -1 : uid(left) > uid(right) ? 1 : 0))

  return async (request) => {
    const url = new URL(request.url)
    if (options.token !== undefined && request.headers.get('authorization') !== `Bearer ${options.token}`) {
      return json(401, { error: { name: 'AuthenticationError', message: 'Missing or invalid token' } })
    }
    const route = url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length + 1) : undefined
    if (route !== 'entity-facets' && route !== 'entities/by-query') {
      return json(404, { error: { name: 'NotFoundError', message: 'Not found' } })
    }
    if (request.method !== 'GET') return json(405, { error: { name: 'MethodNotAllowed' } }, { allow: 'GET' })

    const query = url.searchParams
    if (route === 'entity-facets') {
      const counts = new Map<string, number>()
      for (const item of ordered) {
        const kind = at(item, 'kind')
        if (typeof kind === 'string') counts.set(kind, (counts.get(kind) ?? 0) + 1)
      }
      const kind = [...counts]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([value, count]) => ({ value, count }))
      return json(200, { facets: Object.fromEntries(query.getAll('facet').map((facet) => [facet, facet === 'kind' ? kind : []])) })
    }

    const limitText = query.get('limit')
    const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText)
    if (!Number.isInteger(limit) || limit < 0) return json(400, { error: { name: 'InputError', message: 'invalid limit' } })
    const fields = query.getAll('fields').flatMap((each) => each.split(',')).map((each) => each.trim()).filter((each) => each !== '')

    // A cursor carries the filter: one sent beside it is ignored.
    const cursorText = query.get('cursor')
    let cursor: Cursor
    if (cursorText === null) {
      const filter = query.getAll('filter')
      cursor = { filter, after: '', totalItems: ordered.filter((item) => matches(item, filter)).length }
    } else {
      const decoded = decode(cursorText)
      if (decoded === undefined) return json(400, { error: { name: 'InputError', message: 'Malformed cursor' } })
      cursor = decoded
    }

    const left = ordered.filter((item) => matches(item, cursor.filter) && uid(item) > cursor.after)
    const page = left.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor =
      left.length > page.length && last !== undefined ? encode({ ...cursor, after: uid(last) }) : undefined
    return json(200, {
      items: page.map((item) => (fields.length === 0 ? item : projected(item, fields))),
      totalItems: cursor.totalItems,
      pageInfo: nextCursor === undefined ? {} : { nextCursor },
    })
  }
}

/**
 * What the demo's server answers one incoming request, apart from the socket,
 * and never a throw: a request no `Request` can be built from — a method
 * `fetch` forbids (TRACE, CONNECT, TRACK), or a target holding credentials —
 * is a 405 or a 400, and a handler that throws is a 500, so no request can
 * stop the demo.
 */
export async function answerOf(
  serve: (request: Request) => Promise<Response>,
  incoming: { readonly method?: string | undefined; readonly url?: string | undefined; readonly headers: IncomingHttpHeaders },
): Promise<Response> {
  const method = incoming.method ?? 'GET'
  let request: Request
  try {
    const headers = new Headers()
    for (const [name, header] of Object.entries(incoming.headers)) {
      if (typeof header === 'string') headers.set(name, header)
    }
    request = new Request(new URL(incoming.url ?? '/', 'http://127.0.0.1'), { method, headers })
  } catch {
    return method === 'GET'
      ? json(400, { error: { name: 'InputError', message: 'Unreadable request' } })
      : json(405, { error: { name: 'MethodNotAllowed' } }, { allow: 'GET' })
  }
  try {
    return await serve(request)
  } catch {
    return json(500, { error: { name: 'Error', message: 'The fake failed to answer' } })
  }
}

/** The path a request line names, for the log: never its query, never what would not parse. */
const pathOf = (target: string | undefined): string => {
  try {
    return new URL(target ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '(unreadable)'
  }
}

/** Run as a program: listen on 127.0.0.1 until stopped. */
function main(argv: readonly string[]): void {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const port = Number(value('--port') ?? '7007')
  const token = value('--token')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(value('--root') ?? path.join(here, '..', 'fixtures', 'si-demo'))
  const groups = argv.includes('--no-groups') ? [] : ['tiger', 'elephant', 'dodowarriors']
  const serve = handler({ entities: catalogueOf(root, { groups }), ...(token === undefined ? {} : { token }) })

  const server = createServer((incoming, outgoing) => {
    answerOf(serve, incoming)
      .then(async (response) => {
        // One line per request, which is how the demo counts what it was asked:
        // never a header, so never a token.
        process.stderr.write(`${incoming.method ?? 'GET'} ${pathOf(incoming.url)} ${String(response.status)}\n`)
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(await response.text())
      })
      .catch(() => {
        // The client went away mid-answer: nothing is left to say to it.
        if (!outgoing.headersSent) outgoing.writeHead(500)
        outgoing.end()
      })
  })
  server.listen(port, '127.0.0.1', () => {
    const address = server.address()
    const bound = typeof address === 'object' && address !== null ? address.port : port
    process.stdout.write(`listening on http://127.0.0.1:${String(bound)}/api/catalog\n`)
  })
  const stop = (): void => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
