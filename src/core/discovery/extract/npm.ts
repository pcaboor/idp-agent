import { isMap, isScalar, LineCounter, parseDocument, type Pair } from 'yaml'
import type { FileFacts, ParseFailure } from '../extractors.js'
import { mintFinding, type Engine, type Finding, type Standing } from '../finding.js'
import { DISCOVERY_LIMITS } from '../limits.js'

/**
 * npm's `package.json` (plan, Task 1.4): two rules. `npm.name`, the package's
 * name, at its line; and `npm.dependency`, one finding for each client of a
 * closed table it installs, at its line. A package in a dependency list says
 * a client is installed, never what it is reached for, so the finding is of a
 * kind and nothing else (`RULES`). A version spec is never read: it is where a
 * git URL carries its userinfo (`git+https://user:…@host/x.git`).
 *
 * The file must be plainly JSON, and is refused in a closed reason
 * otherwise: nesting deeper than `maxJsonDepth` is refused by a scan of the
 * bytes before either parser runs, so no input overflows a stack; then
 * `JSON.parse`, so a file only YAML reads is not JSON; then `yaml`'s
 * `parseDocument` with unique keys and a `LineCounter`, which gives each key's
 * line and refuses a key written twice — `JSON.parse` would silently keep the
 * last, and a name written twice is no name.
 */

/**
 * The clients `npm.dependency` version 1 reads, each to the engine it
 * reaches. Closed: an ORM (`prisma`, `typeorm`, `sequelize`, `knex`) names no
 * engine, and an embedded store (`better-sqlite3`) reaches nothing over a
 * network, so neither is here. Without a prototype, so `toString` or
 * `__proto__` in a manifest is no client. A change here is a new version of
 * the rule.
 */
export const NPM_CLIENTS: Readonly<Record<string, Engine>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Engine>, {
    pg: 'postgres',
    postgres: 'postgres',
    'pg-promise': 'postgres',
    mysql: 'mysql',
    mysql2: 'mysql',
    mariadb: 'mariadb',
    mssql: 'mssql',
    tedious: 'mssql',
    oracledb: 'oracle',
    mongodb: 'mongodb',
    mongoose: 'mongodb',
    redis: 'redis',
    ioredis: 'redis',
    kafkajs: 'kafka',
    'node-rdkafka': 'kafka',
    amqplib: 'amqp',
    'amqp-connection-manager': 'amqp',
  } satisfies Record<string, Engine>),
)

/**
 * The dependency lists read, each to the standing it gives a client found in
 * it: what the service installs to run is `evidence`; what it installs to be
 * developed or tested, or asks its host for, is a `mention` — a test's
 * database client is not the service's dependency.
 */
const SECTIONS: ReadonlyMap<string, 'evidence' | 'mention'> = new Map([
  ['dependencies', 'evidence'],
  ['optionalDependencies', 'evidence'],
  ['devDependencies', 'mention'],
  ['peerDependencies', 'mention'],
])

/**
 * How deep the bytes nest, outside strings, or why they cannot be measured:
 * one pass, no recursion, stopped at the bound. A string that never closes is
 * said here, before a parser quotes it.
 */
function depthFailure(text: string): ParseFailure | undefined {
  let depth = 0
  let inString = false
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    if (inString) {
      if (char === '\\') at += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') {
      depth += 1
      if (depth > DISCOVERY_LIMITS.maxJsonDepth) return 'too-deep'
    } else if (char === '}' || char === ']') depth -= 1
  }
  return inString ? 'unclosed-quote' : undefined
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function npm(facts: FileFacts): readonly Finding[] | ParseFailure {
  const deep = depthFailure(facts.text)
  if (deep !== undefined) return deep
  let value: unknown
  try {
    value = JSON.parse(facts.text)
  } catch {
    // Its message quotes the bytes around the fault: never kept.
    return 'not-json'
  }
  if (!isRecord(value)) return 'not-an-object'

  const lines = new LineCounter()
  let document
  try {
    document = parseDocument(facts.text, { lineCounter: lines, uniqueKeys: true, prettyErrors: false })
  } catch {
    return 'not-json'
  }
  if (document.errors.some((error) => error.code === 'DUPLICATE_KEY')) return 'duplicate-key'
  // JSON.parse read it and yaml did not: not a file this version reads.
  if (document.errors.length > 0 || !isMap(document.contents)) return 'not-json'

  const lineOf = (pair: Pair): number => {
    const start = isScalar(pair.key) ? pair.key.range?.[0] : undefined
    return start === undefined ? 0 : lines.linePos(start).line
  }
  const keyOf = (pair: Pair): unknown => (isScalar(pair.key) ? pair.key.value : undefined)
  const draft = (line: number, standing: Standing) => ({
    path: facts.path,
    lines: [line, line] as const,
    fileSha256: facts.fileSha256,
    standing,
  })

  const findings: Finding[] = []
  for (const pair of document.contents.items) {
    const key = keyOf(pair)
    const line = lineOf(pair)
    if (line < 1 || typeof key !== 'string') continue
    if (key === 'name') {
      // JSON's own reading of the value, never yaml's: a name that is not a
      // string becomes the empty name, outside npm's grammar, so `unparsed`.
      const name = value['name']
      findings.push(
        mintFinding({ rule: 'npm.name', ...draft(line, facts.standing), value: { name: typeof name === 'string' ? name : '' } }),
      )
      continue
    }
    const section = SECTIONS.get(key)
    const listed = value[key]
    if (section === undefined || !isRecord(listed) || !isMap(pair.value)) continue
    // A file under a test or an example folder mentions, whatever list it is.
    const standing: Standing = facts.standing === 'mention' ? 'mention' : section === 'evidence' ? facts.standing : 'mention'
    for (const entry of pair.value.items) {
      const client = keyOf(entry)
      const at = lineOf(entry)
      if (typeof client !== 'string' || at < 1 || !Object.hasOwn(NPM_CLIENTS, client)) continue
      const engine = NPM_CLIENTS[client]
      if (engine === undefined) continue
      findings.push(mintFinding({ rule: 'npm.dependency', ...draft(at, standing), value: { package: client, engine } }))
    }
  }
  return findings.sort((a, b) => a.lines[0] - b.lines[0])
}
