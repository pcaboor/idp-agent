import { referenceShape } from '../secrets/shapes.js'
import { credentialShaped, isHost, isHttpUrl, isIdentifier, isPort } from './grammar.js'
import { DISCOVERY_LIMITS } from './limits.js'
import type { Engine, HostPort } from './finding.js'

/**
 * The connection-string parser of stage 8's discovery (brief § 8, plan Task
 * 1.1): four forms read — a URL, JDBC, libpq's `key=value` and ADO.NET's
 * `Key=Value;` — and of each, only the parts it names kept.
 *
 *   - It KEEPS ONLY WHAT IT NAMES. In the URL form that is the scheme, the
 *     hosts, the database, the userinfo's user and a query's `user` or
 *     `username`; in libpq `host`, `hostaddr`, `port`, `dbname` and `user`; in
 *     ADO.NET the server, database and user synonyms. Everything else is
 *     dropped and only said to have been (`dropped`), so a secret under a key
 *     nobody listed (`?auth_token_x=…`, `sslpassword=`, `Token=`) cannot
 *     survive: a deny list would be the complement, and need a list.
 *   - IT RETURNS NOTHING A GRAMMAR REFUSES. A connection comes back `parsed`
 *     with every field inside its grammar and shaped like no credential, or as
 *     `placeholder`, `unparsed` or `withheld` with no field at all.
 *   - NO `@` PAST THE AUTHORITY. The authority ends at the first `/`, `?` or
 *     `#` after `//`, and an `@` after that point makes the string ambiguous:
 *     `postgres://app:7777#Qz7x@pg-01/ledger` read by its authority alone
 *     gives host `app` and port `7777`, each inside its grammar. Inside the
 *     authority, the userinfo ends at its last `@`, so `p@ss` is read right.
 *   - A KEY WRITTEN TWICE IS AMBIGUOUS, synonyms included (`Initial Catalog`
 *     and `Database`): neither the first nor the last wins. A URL's query
 *     key is compared decoded and in any case, as a driver reads it, so
 *     `?%75ser=` is a second `user`; and a query key naming the target
 *     (`?host=`, `?port=`, `?dbname=`) is ambiguous wherever it is written,
 *     because a driver lets it override the authority.
 *   - ONE LEFT-TO-RIGHT SCAN PER FORM, no regular expression run over the
 *     value that could backtrack, and nothing read past
 *     `DISCOVERY_LIMITS.maxConnectionLength`.
 *
 * What it shows is COMPOSED from the parts it kept (`composeConnection`),
 * with `•••` where a password or a userinfo was and `…` where options or a
 * path were dropped — never the line cut at offsets, which would carry every
 * byte the offsets did not cover.
 */

export const CONNECTION_FORMS = ['url', 'jdbc', 'libpq', 'adonet'] as const
export type ConnectionForm = (typeof CONNECTION_FORMS)[number]
export type Dropped = 'password' | 'userinfo' | 'options' | 'path'

export type Connection =
  | {
      readonly outcome: 'parsed'
      readonly form: ConnectionForm
      readonly engine: Engine
      /** As written: `postgresql`, `jdbc:sqlserver`; libpq and ADO.NET write none, and their form's name stands in. */
      readonly scheme: string
      readonly hosts: readonly HostPort[]
      readonly database?: string
      readonly user?: string
      /** An http URL's origin: its scheme, host and port, never its path. */
      readonly url?: string
      readonly dropped: readonly Dropped[]
    }
  /** A host, a database or a user is a reference (`${DB_HOST}`): configured outside this repository. */
  | { readonly outcome: 'placeholder'; readonly form: ConnectionForm; readonly engine: Engine; readonly scheme: string }
  | {
      readonly outcome: 'unparsed'
      readonly why: 'form' | 'ambiguous' | 'grammar' | 'length'
      readonly field?: 'host' | 'port' | 'database' | 'user' | 'url'
    }
  /** A kept field is shaped like a credential. */
  | { readonly outcome: 'withheld' }

type Parsed = Extract<Connection, { outcome: 'parsed' }>
type Unparsed = Extract<Connection, { outcome: 'unparsed' }>

/** The order `dropped` is listed in, whatever order the scan met each. */
const DROPPED_ORDER: readonly Dropped[] = ['password', 'userinfo', 'path', 'options']

/** The URL schemes read, each to its engine. A scheme not here is no connection: `ftp://` is not a dependency. */
const URL_SCHEMES: ReadonlyMap<string, Engine> = new Map([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['mariadb', 'mariadb'],
  ['mongodb', 'mongodb'],
  ['mongodb+srv', 'mongodb'],
  ['redis', 'redis'],
  ['rediss', 'redis'],
  ['amqp', 'amqp'],
  ['amqps', 'amqp'],
  ['http', 'http'],
  ['https', 'http'],
])

/** JDBC's subprotocols read, each to its engine. Another is a connection this version cannot read: `unparsed`. */
const JDBC_DIALECTS: ReadonlyMap<string, Engine> = new Map([
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['mariadb', 'mariadb'],
  ['sqlserver', 'mssql'],
  ['oracle', 'oracle'],
])

/** libpq's keywords a string may open on. They are lower case in libpq, and compared so. */
const LIBPQ_FIRST = new Set(['host', 'hostaddr', 'port', 'dbname', 'user', 'password'])

/**
 * The query keys a driver reads as the target, and lets win over the
 * authority: libpq's URI takes any of its parameters in the query
 * (`?host=`, `?hostaddr=`, `?port=`, `?dbname=`, `?service=`), pgjdbc its
 * `PG…` properties, mysql2 every option, a Redis client a `db`. Read beside
 * the authority the target is said twice; read alone, it would be a target no
 * grammar here was written for. Either way the string is ambiguous.
 */
const TARGET_KEYS = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'database',
  'db',
  'service',
  'pghost',
  'pgport',
  'pgdbname',
])

type Named = 'host' | 'database' | 'user' | 'password'

/** ADO.NET's keywords, lower case and single-spaced, each to the part it names. */
const ADONET_KEYS: ReadonlyMap<string, Named> = new Map([
  ['server', 'host'],
  ['data source', 'host'],
  ['address', 'host'],
  ['addr', 'host'],
  ['network address', 'host'],
  ['database', 'database'],
  ['initial catalog', 'database'],
  ['user id', 'user'],
  ['uid', 'user'],
  ['user', 'user'],
  ['password', 'password'],
  ['pwd', 'password'],
])

/** Keys an ADO.NET string opens on besides the named ones, so it is recognised and its options dropped. */
const ADONET_FIRST = new Set([
  ...ADONET_KEYS.keys(),
  'integrated security',
  'trusted_connection',
  'encrypt',
  'persist security info',
  'application name',
])

/** SQL Server's JDBC properties, lower case, each to the part it names. */
const SQLSERVER_KEYS: ReadonlyMap<string, Named | 'port'> = new Map([
  ['databasename', 'database'],
  ['database', 'database'],
  ['user', 'user'],
  ['username', 'user'],
  ['password', 'password'],
  ['servername', 'host'],
  ['portnumber', 'port'],
  ['port', 'port'],
])

const unparsed = (why: Unparsed['why'], field?: Unparsed['field']): Unparsed =>
  Object.freeze(field === undefined ? { outcome: 'unparsed', why } : { outcome: 'unparsed', why, field })

const AMBIGUOUS = unparsed('ambiguous')
const NO_FORM = unparsed('form')

/** What a scan read, before any grammar: each value as written, the port a string. */
interface Read {
  readonly form: ConnectionForm
  readonly engine: Engine
  readonly scheme: string
  readonly hosts: readonly { readonly host: string; readonly port?: string }[]
  readonly database?: string
  readonly user?: string
  /** The user and the database are percent-encoded, as a URL writes them. */
  readonly encoded?: true
  readonly dropped: ReadonlySet<Dropped>
}

/** The key a string opens on, as written, or undefined when none is there in its first 64 characters. */
function firstKey(value: string): string | undefined {
  let index = 0
  while (index < value.length && (value[index] === ' ' || value[index] === '\t')) index += 1
  const start = index
  while (index < value.length && index - start < 64) {
    const char = value[index]
    if (char === '=') return value.slice(start, index).trim()
    if (char === ';' || char === '\n') return undefined
    index += 1
  }
  return undefined
}

/** Whether a `;` comes before the first blank, in one scan. */
function semicolonFirst(value: string): boolean {
  for (const char of value) {
    if (char === ';') return true
    if (char === ' ' || char === '\t') return false
  }
  return false
}

const normalisedKey = (key: string): string => key.trim().toLowerCase().split(/[ \t]+/).join(' ')

/** The scheme before `://`, as written, when it is one a URL could hold. */
function urlScheme(value: string): string | undefined {
  const at = value.indexOf('://')
  if (at < 1 || at > 32) return undefined
  const scheme = value.slice(0, at)
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) ? scheme : undefined
}

/** `jdbc:<subprotocol>:`, the subprotocol as written. */
function jdbcDialect(value: string): string | undefined {
  if (value.slice(0, 5).toLowerCase() !== 'jdbc:') return undefined
  const end = value.indexOf(':', 5)
  if (end < 6 || end > 5 + 32) return undefined
  const dialect = value.slice(5, end)
  return /^[A-Za-z0-9]+$/.test(dialect) ? dialect : undefined
}

/**
 * Which form `value` is written in, or undefined when it is none: then it is
 * no connection, and no finding. Decided by the opening alone — a URL scheme
 * this parser reads, `jdbc:`, or a first key of libpq's or ADO.NET's — never
 * by a variable's name, which says nothing (`DATABASE_URL`).
 */
export function looksLikeConnection(value: string): ConnectionForm | undefined {
  const scheme = urlScheme(value)
  if (scheme !== undefined) return URL_SCHEMES.has(scheme.toLowerCase()) ? 'url' : undefined
  if (jdbcDialect(value) !== undefined) return 'jdbc'
  const key = firstKey(value)
  if (key === undefined) return undefined
  // `user` and `password` open both forms, and ADO.NET's keys take any case:
  // a `;` before the first blank ends a pair of ADO.NET's, never a value of
  // libpq's, whose password would otherwise run on over the rest.
  if (LIBPQ_FIRST.has(key) && !(ADONET_FIRST.has(key) && semicolonFirst(value))) return 'libpq'
  if (ADONET_FIRST.has(normalisedKey(key))) return 'adonet'
  return undefined
}

export function parseConnection(value: string): Connection {
  if (value.length > DISCOVERY_LIMITS.maxConnectionLength) return unparsed('length')
  const form = looksLikeConnection(value)
  let read: Read | Unparsed
  switch (form) {
    case undefined:
      return NO_FORM
    case 'url': {
      const scheme = urlScheme(value) ?? ''
      const engine = URL_SCHEMES.get(scheme.toLowerCase())
      if (engine === undefined) return NO_FORM
      read = readUrl(value, scheme.length + 3, 'url', engine, scheme)
      break
    }
    case 'jdbc':
      read = readJdbc(value)
      break
    case 'libpq':
      read = readLibpq(value)
      break
    case 'adonet':
      read = readAdonet(value)
      break
    default: {
      const _exhaustive: never = form
      return _exhaustive
    }
  }
  return 'outcome' in read ? read : judged(read)
}

/** `%XX` decoded, or undefined for an escape that decodes to nothing. */
function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

/** One host of an authority: `host`, `host:port`, `[v6]` or `[v6]:port`. An empty port is no port. */
function hostEntry(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close > 0 && entry[close + 1] === ':') {
      const port = entry.slice(close + 2)
      return port === '' ? { host: entry.slice(0, close + 1) } : { host: entry.slice(0, close + 1), port }
    }
    return { host: entry }
  }
  const colon = entry.indexOf(':')
  if (colon < 0) return { host: entry }
  const port = entry.slice(colon + 1)
  return port === '' ? { host: entry.slice(0, colon) } : { host: entry.slice(0, colon), port }
}

/**
 * The URL form, and JDBC's URL-shaped dialects: `start` is where the
 * authority begins, just after `//`. An http URL keeps its origin and drops
 * its userinfo, path, query and fragment whole; a database URL keeps its
 * user, its hosts and its first path segment as the database.
 */
function readUrl(value: string, start: number, form: ConnectionForm, engine: Engine, scheme: string): Read | Unparsed {
  let end = start
  while (end < value.length && value[end] !== '/' && value[end] !== '?' && value[end] !== '#') end += 1
  const authority = value.slice(start, end)
  const tail = value.slice(end)
  if (tail.includes('@')) return AMBIGUOUS

  const http = engine === 'http'
  const dropped = new Set<Dropped>()
  const at = authority.lastIndexOf('@')
  const hostList = authority.slice(at + 1)
  let user: string | undefined
  let password = false
  if (at >= 0) {
    const userinfo = authority.slice(0, at)
    if (http) {
      dropped.add('userinfo')
    } else {
      const colon = userinfo.indexOf(':')
      const name = colon < 0 ? userinfo : userinfo.slice(0, colon)
      if (name !== '') user = name
      if (colon >= 0 && colon < userinfo.length - 1) {
        password = true
        dropped.add('password')
      }
    }
  }

  const hash = tail.indexOf('#')
  if (hash >= 0 && hash < tail.length - 1) dropped.add('options')
  const beforeHash = hash < 0 ? tail : tail.slice(0, hash)
  const question = beforeHash.indexOf('?')
  const path = question < 0 ? beforeHash : beforeHash.slice(0, question)
  const query = question < 0 ? '' : beforeHash.slice(question + 1)

  const hosts = http ? [hostEntry(hostList)] : hostList === '' ? [] : hostList.split(',').map(hostEntry)
  if (http) {
    if (path !== '' && path !== '/') dropped.add('path')
    if (query !== '') dropped.add('options')
    return { form, engine, scheme, hosts, dropped }
  }

  const segment = path.startsWith('/') ? path.slice(1) : ''
  const database = segment === '' ? undefined : segment
  const keys = new Set<string>()
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const equals = pair.indexOf('=')
    // Decoded as a driver decodes it: `%75ser` is `user`, and a key that does
    // not decode is one no driver could read either.
    const key = decoded(equals < 0 ? pair : pair.slice(0, equals))?.toLowerCase()
    if (key === undefined) return unparsed('grammar')
    if (keys.has(key) || TARGET_KEYS.has(key)) return AMBIGUOUS
    keys.add(key)
    if (key === 'user' || key === 'username') {
      if (user !== undefined) return AMBIGUOUS
      user = equals < 0 ? '' : pair.slice(equals + 1)
    } else if (key === 'password') {
      if (password) return AMBIGUOUS
      password = true
      dropped.add('password')
    } else {
      dropped.add('options')
    }
  }
  return {
    form,
    engine,
    scheme,
    hosts,
    ...(database === undefined ? {} : { database }),
    ...(user === undefined || user === '' ? {} : { user }),
    encoded: true,
    dropped,
  }
}

/** `jdbc:<dialect>:…`, by dialect. */
function readJdbc(value: string): Read | Unparsed {
  const dialect = jdbcDialect(value)
  const engine = dialect === undefined ? undefined : JDBC_DIALECTS.get(dialect.toLowerCase())
  if (dialect === undefined || engine === undefined) return NO_FORM
  const after = 5 + dialect.length + 1
  switch (engine) {
    case 'oracle': {
      if (value.slice(after, after + 5).toLowerCase() !== 'thin:') return NO_FORM
      return readOracle(value, after + 5, value.slice(0, after + 4))
    }
    case 'mssql':
      if (value.slice(after, after + 2) !== '//') return NO_FORM
      return readSqlServer(value, after + 2, value.slice(0, after - 1))
    default:
      if (value.slice(after, after + 2) !== '//') return NO_FORM
      return readUrl(value, after + 2, 'jdbc', engine, value.slice(0, after - 1))
  }
}

/**
 * Oracle's thin driver, in its `@//host:port/service` form only:
 * `jdbc:oracle:thin:[user[/password]]@//host[:port]/service[?…]`. The
 * credentials end at the FIRST `@//`, and an `@` after it is ambiguous, as in
 * a URL: a password holding `@//` is refused rather than read as an address.
 * The older `@host:port:SID` and a TNS descriptor are not read.
 */
function readOracle(value: string, start: number, scheme: string): Read | Unparsed {
  const rest = value.slice(start)
  const at = rest.indexOf('@//')
  if (at < 0) return NO_FORM
  const credentials = rest.slice(0, at)
  const address = rest.slice(at + 3)
  if (address.includes('@')) return AMBIGUOUS

  const dropped = new Set<Dropped>()
  const slash = credentials.indexOf('/')
  const user = slash < 0 ? credentials : credentials.slice(0, slash)
  if (slash >= 0 && slash < credentials.length - 1) dropped.add('password')

  let end = 0
  while (end < address.length && address[end] !== '/' && address[end] !== '?' && address[end] !== '#') end += 1
  const tail = address.slice(end)
  let cut = 0
  while (cut < tail.length && tail[cut] !== '?' && tail[cut] !== '#') cut += 1
  if (cut === tail.length) cut = -1
  const path = cut < 0 ? tail : tail.slice(0, cut)
  if (cut >= 0 && cut < tail.length - 1) dropped.add('options')
  const service = path.startsWith('/') ? path.slice(1) : ''
  return {
    form: 'jdbc',
    engine: 'oracle',
    scheme,
    hosts: [hostEntry(address.slice(0, end))],
    ...(service === '' ? {} : { database: service }),
    ...(user === '' ? {} : { user }),
    dropped,
  }
}

/**
 * One `key=value` of a list separated by `separator`, from `at`: the key as
 * written, the value unquoted, and where the next pair starts. A value opening
 * on one of `quotes` runs to the matching close, a doubled close being one
 * character of it; anything but blanks between that close and the separator
 * is no form. Undefined when the scan reaches no `=` before the separator.
 */
function pairAt(
  value: string,
  at: number,
  separator: string,
  quotes: ReadonlyMap<string, string>,
): { key: string; value: string; next: number } | Unparsed | undefined {
  let index = at
  while (index < value.length && value[index] !== '=' && value[index] !== separator) index += 1
  if (index >= value.length || value[index] !== '=') return undefined
  const key = value.slice(at, index)
  if (key.trim() === '') return NO_FORM
  index += 1
  while (value[index] === ' ' || value[index] === '\t') index += 1
  const close = quotes.get(value[index] ?? '')
  if (close === undefined) {
    const end = value.indexOf(separator, index)
    const stop = end < 0 ? value.length : end
    return { key, value: value.slice(index, stop).trim(), next: stop + 1 }
  }
  let text = ''
  index += 1
  for (;;) {
    if (index >= value.length) return NO_FORM
    const char = value[index]
    if (char === close) {
      if (value[index + 1] === close) {
        text += close
        index += 2
        continue
      }
      index += 1
      break
    }
    text += char
    index += 1
  }
  while (value[index] === ' ' || value[index] === '\t') index += 1
  if (index < value.length && value[index] !== separator) return NO_FORM
  return { key, value: text, next: index + 1 }
}

/** `Key=Value;` pairs, empty ones skipped, each key normalised; a pair with no `=` is no form. */
function pairsOf(
  value: string,
  from: number,
  quotes: ReadonlyMap<string, string>,
): { key: string; value: string }[] | Unparsed {
  const pairs: { key: string; value: string }[] = []
  let at = from
  while (at < value.length) {
    if (value[at] === ';' || value[at] === ' ' || value[at] === '\t') {
      at += 1
      continue
    }
    const pair = pairAt(value, at, ';', quotes)
    if (pair === undefined) return NO_FORM
    if ('outcome' in pair) return pair
    pairs.push({ key: normalisedKey(pair.key), value: pair.value })
    at = pair.next
  }
  return pairs
}

/**
 * Pairs to the named parts, each named part once and each other key once:
 * a key written twice, or two synonyms of one part, is ambiguous.
 */
function namedParts<N extends string>(
  pairs: readonly { key: string; value: string }[],
  names: ReadonlyMap<string, N>,
  already: ReadonlySet<N> = new Set(),
): { parts: Map<N, string>; options: boolean } | Unparsed {
  const parts = new Map<N, string>()
  const others = new Set<string>()
  let options = false
  for (const { key, value } of pairs) {
    const name = names.get(key)
    if (name === undefined) {
      if (others.has(key)) return AMBIGUOUS
      others.add(key)
      options = true
    } else {
      if (parts.has(name) || already.has(name)) return AMBIGUOUS
      parts.set(name, value)
    }
  }
  return { parts, options }
}

const BRACES: ReadonlyMap<string, string> = new Map([['{', '}']])
const ADONET_QUOTES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["'", "'"],
])

/** SQL Server's JDBC: `//host[:port];key=value;…`, a value braced as `{…}` to hold a `;`. */
function readSqlServer(value: string, start: number, scheme: string): Read | Unparsed {
  let end = start
  while (end < value.length && value[end] !== ';') end += 1
  const server = value.slice(start, end)
  const pairs = pairsOf(value, end, BRACES)
  if ('outcome' in pairs) return pairs
  const entry = hostEntry(server)
  const already = new Set<Named | 'port'>()
  if (server !== '') already.add('host')
  if (entry.port !== undefined) already.add('port')
  const named = namedParts(pairs, SQLSERVER_KEYS, already)
  if ('outcome' in named) return named
  const host = server === '' ? named.parts.get('host') : entry.host
  if (host === undefined) return NO_FORM
  const port = entry.port ?? named.parts.get('port')
  return finished('jdbc', 'mssql', scheme, [port === undefined ? { host } : { host, port }], named)
}

/** ADO.NET: `Key=Value;…`, a value quoted `"…"` or `'…'` with the quote doubled inside. */
function readAdonet(value: string): Read | Unparsed {
  const pairs = pairsOf(value, 0, ADONET_QUOTES)
  if ('outcome' in pairs) return pairs
  const named = namedParts(pairs, ADONET_KEYS)
  if ('outcome' in named) return named
  const server = named.parts.get('host')
  if (server === undefined) return NO_FORM
  // `tcp:` names the protocol, the only one a host over a network is reached by.
  const address = server.slice(0, 4).toLowerCase() === 'tcp:' ? server.slice(4) : server
  const comma = address.lastIndexOf(',')
  const host = comma < 0 ? { host: address } : { host: address.slice(0, comma), port: address.slice(comma + 1) }
  return finished('adonet', 'mssql', 'adonet', [host], named)
}

function finished(
  form: ConnectionForm,
  engine: Engine,
  scheme: string,
  hosts: Read['hosts'],
  named: { parts: ReadonlyMap<string, string>; options: boolean },
): Read {
  const dropped = new Set<Dropped>()
  if (named.parts.has('password')) dropped.add('password')
  if (named.options) dropped.add('options')
  const database = named.parts.get('database')
  const user = named.parts.get('user')
  return {
    form,
    engine,
    scheme,
    hosts,
    ...(database === undefined ? {} : { database }),
    ...(user === undefined ? {} : { user }),
    dropped,
  }
}

const LIBPQ_KEYS: ReadonlyMap<string, 'host' | 'hostaddr' | 'port' | 'database' | 'user' | 'password'> = new Map([
  ['host', 'host'],
  ['hostaddr', 'hostaddr'],
  ['port', 'port'],
  ['dbname', 'database'],
  ['user', 'user'],
  ['password', 'password'],
] as const)

/**
 * libpq's `key=value` list, separated by blanks: a value quoted `'…'` with
 * `\'` and `\\` inside, or unquoted to the next blank, a `\` escaping the
 * character after it in either. `host` and `port` may each list several,
 * separated by commas, as libpq takes them; `hostaddr` stands in for an
 * absent `host`, and is an option beside one.
 */
function readLibpq(value: string): Read | Unparsed {
  const pairs: { key: string; value: string }[] = []
  let index = 0
  const blank = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r'
  for (;;) {
    while (blank(value[index])) index += 1
    if (index >= value.length) break
    const start = index
    while (index < value.length && value[index] !== '=' && !blank(value[index])) index += 1
    const key = value.slice(start, index)
    while (blank(value[index])) index += 1
    if (value[index] !== '=' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return NO_FORM
    index += 1
    while (blank(value[index])) index += 1
    let text = ''
    if (value[index] === "'") {
      index += 1
      for (;;) {
        if (index >= value.length) return NO_FORM
        const char = value[index]
        if (char === '\\') {
          text += value[index + 1] ?? ''
          index += 2
          continue
        }
        index += 1
        if (char === "'") break
        text += char
      }
      if (index < value.length && !blank(value[index])) return NO_FORM
    } else {
      while (index < value.length && !blank(value[index])) {
        if (value[index] === '\\') {
          text += value[index + 1] ?? ''
          index += 2
          continue
        }
        text += value[index]
        index += 1
      }
    }
    pairs.push({ key, value: text })
  }

  const parts = new Map<string, string>()
  let options = false
  for (const { key, value: text } of pairs) {
    if (parts.has(key)) return AMBIGUOUS
    parts.set(key, text)
    if (!LIBPQ_KEYS.has(key)) options = true
  }
  const host = parts.get('host')
  const hostaddr = parts.get('hostaddr')
  if (host !== undefined && hostaddr !== undefined) options = true
  const names = host ?? hostaddr
  // A string that names no host, database or user names no target: a
  // password alone is no connection, as an ADO.NET string with no server is not.
  if (names === undefined && !parts.has('dbname') && !parts.has('user')) return NO_FORM
  // A port with no host to put it on is the local socket's, which a host's
  // grammar cannot say; never kept as no port, which would be a silent drop.
  if (names === undefined && parts.has('port')) return unparsed('grammar', 'host')
  const ports = parts.get('port')?.split(',')
  const listed = names === undefined ? [] : names.split(',')
  if (ports !== undefined && ports.length !== 1 && ports.length !== listed.length) {
    return unparsed('grammar', 'port')
  }
  const hosts = listed.map((name, at) => {
    const port = ports === undefined ? undefined : ports.length === 1 ? ports[0] : ports[at]
    return port === undefined || port === '' ? { host: name } : { host: name, port }
  })
  const dropped = new Set<Dropped>()
  if (parts.has('password')) dropped.add('password')
  if (options) dropped.add('options')
  const database = parts.get('dbname')
  const user = parts.get('user')
  return {
    form: 'libpq',
    engine: 'postgres',
    scheme: 'libpq',
    hosts,
    ...(database === undefined ? {} : { database }),
    ...(user === undefined ? {} : { user }),
    dropped,
  }
}

/**
 * A value that names another value (`${DB_HOST}`, `{{ .Values.host }}`) and is
 * no value of its own grammar. Only the reference shapes count, never the
 * secret filter's wider placeholder test: a run of six `a`, a version or a
 * `file:` in a host is a value outside its grammar, `unparsed`, not one
 * configured elsewhere.
 */
const reference = (value: string | undefined, grammar: (value: string) => boolean): boolean =>
  value !== undefined && referenceShape(value) && !grammar(value)

const isPortText = (port: string): boolean => /^\d{1,5}$/.test(port) && isPort(Number(port))

/**
 * A read held to the grammars: a reference anywhere makes it `placeholder`;
 * a field outside its grammar, `unparsed` and named; a field shaped like a
 * credential, `withheld`. Only then is it `parsed`.
 */
function judged(read: Read): Connection {
  const user = read.user === undefined || read.encoded !== true ? read.user : decoded(read.user)
  const decodedDatabase = read.database === undefined || read.encoded !== true ? read.database : decoded(read.database)
  // AMQP's default virtual host is `/`, written `%2F`: no database is named.
  const database = read.engine === 'amqp' && decodedDatabase === '/' ? undefined : decodedDatabase

  if (
    reference(read.user, isIdentifier) ||
    reference(read.database, isIdentifier) ||
    read.hosts.some((entry) => reference(entry.host, isHost) || reference(entry.port, isPortText))
  ) {
    return { outcome: 'placeholder', form: read.form, engine: read.engine, scheme: read.scheme }
  }

  if (read.hosts.length > DISCOVERY_LIMITS.maxHosts) return unparsed('grammar', 'host')
  const hosts: HostPort[] = []
  for (const entry of read.hosts) {
    if (!isHost(entry.host)) return unparsed('grammar', 'host')
    if (entry.port !== undefined && !isPortText(entry.port)) return unparsed('grammar', 'port')
    hosts.push(entry.port === undefined ? { host: entry.host } : { host: entry.host, port: Number(entry.port) })
  }
  if (read.database !== undefined) {
    if (decodedDatabase === undefined) return unparsed('grammar', 'database')
    if (database !== undefined && !isIdentifier(database)) return unparsed('grammar', 'database')
  }
  if (read.user !== undefined && (user === undefined || !isIdentifier(user))) return unparsed('grammar', 'user')

  let url: string | undefined
  if (read.engine === 'http') {
    const [only] = hosts
    url = only === undefined ? '' : `${read.scheme.toLowerCase()}://${hostText(only)}`
    if (!isHttpUrl(url)) return unparsed('grammar', 'url')
  }

  const kept = [...hosts.map((entry) => entry.host), database, user, url]
  if (kept.some((field) => field !== undefined && credentialShaped(field))) return { outcome: 'withheld' }

  return {
    outcome: 'parsed',
    form: read.form,
    engine: read.engine,
    scheme: read.scheme,
    hosts,
    ...(database === undefined ? {} : { database }),
    ...(user === undefined ? {} : { user }),
    ...(url === undefined ? {} : { url }),
    dropped: DROPPED_ORDER.filter((part) => read.dropped.has(part)),
  }
}

const hostText = (entry: HostPort, separator = ':'): string =>
  entry.port === undefined ? entry.host : `${entry.host}${separator}${String(entry.port)}`

/** A user or a database in a URL's userinfo or path: its `@` written `%40`, as it would have to be. */
const inUrl = (part: string): string => part.replaceAll('%', '%25').replaceAll('@', '%40')

const PASSWORD = '•••'
const ELIDED = '…'

/**
 * What a parsed connection shows: composed from the parts kept, in its own
 * form, `•••` where a password or a userinfo was and `…` where options or a
 * path were dropped. The user sits in the userinfo of the URL form even when
 * it was read from `?user=`. A rendering, never a quote of the line.
 */
export function composeConnection(connection: Parsed): string {
  const { form, scheme, hosts, database, user, dropped } = connection
  const password = dropped.includes('password')
  const options = dropped.includes('options')
  switch (form) {
    case 'url': {
      const list = hosts.map((entry) => hostText(entry)).join(',')
      if (connection.engine === 'http') {
        const userinfo = dropped.includes('userinfo') ? `${PASSWORD}@` : ''
        const after = dropped.includes('path') || options ? `/${ELIDED}` : ''
        return `${scheme}://${userinfo}${list}${after}`
      }
      const name = user === undefined ? '' : inUrl(user)
      const userinfo = password ? `${name}:${PASSWORD}@` : user === undefined ? '' : `${name}@`
      const path = database === undefined ? '' : `/${inUrl(database)}`
      return `${scheme}://${userinfo}${list}${path}${options ? `?${ELIDED}` : ''}`
    }
    case 'jdbc': {
      if (connection.engine === 'mssql') {
        const parts = [
          `${scheme}://${hosts.map((entry) => hostText(entry)).join(',')}`,
          ...(database === undefined ? [] : [`databaseName=${database}`]),
          ...(user === undefined ? [] : [`user=${user}`]),
          ...(password ? [`password=${PASSWORD}`] : []),
          ...(options ? [ELIDED] : []),
        ]
        return parts.join(';')
      }
      if (connection.engine === 'oracle') {
        const credentials = `${user ?? ''}${password ? `/${PASSWORD}` : ''}`
        const service = database === undefined ? '' : `/${database}`
        const list = hosts.map((entry) => hostText(entry)).join(',')
        return `${scheme}:${credentials}@//${list}${service}${options ? `?${ELIDED}` : ''}`
      }
      const parameters = [
        ...(user === undefined ? [] : [`user=${inUrl(user)}`]),
        ...(password ? [`password=${PASSWORD}`] : []),
        ...(options ? [ELIDED] : []),
      ]
      const path = database === undefined ? '' : `/${inUrl(database)}`
      const query = parameters.length === 0 ? '' : `?${parameters.join('&')}`
      return `${scheme}://${hosts.map((entry) => hostText(entry)).join(',')}${path}${query}`
    }
    case 'libpq': {
      const ports = hosts.some((entry) => entry.port !== undefined)
      return [
        ...(hosts.length === 0 ? [] : [`host=${hosts.map((entry) => entry.host).join(',')}`]),
        ...(ports ? [`port=${hosts.map((entry) => (entry.port === undefined ? '' : String(entry.port))).join(',')}`] : []),
        ...(database === undefined ? [] : [`dbname=${database}`]),
        ...(user === undefined ? [] : [`user=${user}`]),
        ...(password ? [`password=${PASSWORD}`] : []),
        ...(options ? [ELIDED] : []),
      ].join(' ')
    }
    case 'adonet':
      return [
        `Server=${hosts.map((entry) => hostText(entry, ',')).join(',')}`,
        ...(database === undefined ? [] : [`Database=${database}`]),
        ...(user === undefined ? [] : [`User ID=${user}`]),
        ...(password ? [`Password=${PASSWORD}`] : []),
        ...(options ? [ELIDED] : []),
      ].join(';')
    default: {
      const _exhaustive: never = form
      return _exhaustive
    }
  }
}
