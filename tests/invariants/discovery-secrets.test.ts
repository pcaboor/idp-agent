import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { main } from '../../src/cli/index.js'
import { ENGINE_BLOCK_END } from '../../src/core/github/pull-request.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { removeClones } from '../support/forge-fixture.js'
import { githubClone } from '../support/github-fixture.js'
import { memorySink, onlyTrace } from '../support/trace.js'
import { PROPERTY_TIMEOUT, freshSeed } from './budget.js'
import { composeConnection, parseConnection, type Connection } from '../../src/core/discovery/connection.js'
import { mintFinding } from '../../src/core/discovery/finding.js'
import type { HostPort } from '../../src/core/discovery/finding.js'

/**
 * No fragment of a password reaches a finding (plan, Task 1.1, Step 4).
 *
 * A password is generated as fragments joined by the delimiters a parser could
 * stop at, and every fragment carries a numbered marker (`Qz7a`, `Qz7b`, …),
 * so a fragment that leaked alone is still seen. Hosts, users and databases
 * are drawn from `[a-z0-9-]`, which cannot spell a marker.
 *
 * The password sits in each form's slot, quoted as the form quotes; in a
 * quarter of the runs unquoted, holding a delimiter but never `=`
 * (`Password=a;Database=b` is another valid string, not a misparse); and in a
 * quarter under a key the parser does not name, which is how keeping only the
 * named parts drops it. In some runs a key is written twice, and that string
 * must come back `ambiguous`.
 *
 * The oracle is exact: a `parsed` outcome must equal the generated hosts,
 * ports, database and user, field for field, with `password` dropped where one
 * was written. A parse that keeps a fragment as a host or a port is a misparse
 * even when no marker shows. And the leak check reads raw strings, every leaf,
 * never `JSON.stringify`, which escapes `"` and `\` and would hide `a\"Qz7`.
 */

const MARKER = 'Qz7'
const DELIMITERS = ['@', ':', '/', '?', '#', '%', ';', '=', "'", '"', '\\', ' '] as const
const UNQUOTED = DELIMITERS.filter((delimiter) => delimiter !== '=')
const HASH = 'a'.repeat(64)

const label = fc.stringMatching(/^[a-z](?:[a-z0-9-]{0,8}[a-z0-9])?$/)
const hostName = fc.array(label, { minLength: 1, maxLength: 3 }).map((labels) => labels.join('.'))
const identifier = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/)
const port = fc.integer({ min: 1, max: 65_535 })

/** A password: fragments, each opening on its own marker, joined by `delimiters`. */
const passwordOf = (delimiters: readonly string[]): fc.Arbitrary<string> =>
  fc
    .array(fc.tuple(fc.stringMatching(/^[A-Za-z0-9]{0,5}$/), fc.constantFrom(...delimiters)), {
      minLength: 1,
      maxLength: 6,
    })
    .map((parts) =>
      parts
        .map(([rest, delimiter], index) => `${index === 0 ? '' : delimiter}${MARKER}${String.fromCharCode(97 + index)}${rest}`)
        .join(''),
    )

type Placement = 'quoted' | 'unquoted' | 'unnamed'

/** Half quoted, a quarter unquoted, a quarter under a key the parser does not name. */
const placement = fc.constantFrom<Placement>('quoted', 'quoted', 'unquoted', 'unnamed')

/** A placement and its password, and whether a key is written twice; twice only quoted, so nothing else refuses it first. */
const secret = fc
  .record({ placement, twice: fc.integer({ min: 1, max: 5 }).map((n) => n === 1) })
  .chain(({ placement: where, twice }) =>
    fc.record({
      placement: fc.constant<Placement>(twice ? 'quoted' : where),
      twice: fc.constant(twice),
      password: passwordOf(where === 'quoted' || twice ? DELIMITERS : UNQUOTED),
    }),
  )

interface Generated {
  readonly input: string
  readonly hosts: readonly HostPort[]
  readonly database?: string
  readonly user?: string
  /** A password written where the form keeps one, which must come back dropped. */
  readonly written: boolean
  readonly twice: boolean
}

/** Every string a value holds, raw. */
function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(leaves)
}

const hostPort = (host: HostPort, separator = ':'): string =>
  host.port === undefined ? host.host : `${host.host}${separator}${String(host.port)}`

const counts = () => ({ parsed: 0, ambiguous: 0, dropped: 0 })

/**
 * Parses, renders and mints `generated`, and holds the result to the oracle
 * and the leak check. Counts what it met, so a property that never met a
 * parse proves nothing about one.
 */
function check(generated: Generated, seen: ReturnType<typeof counts>): void {
  const connection: Connection = parseConnection(generated.input)
  const finding = mintFinding({
    rule: 'env-file.url',
    path: '.env.example',
    lines: [1, 1],
    fileSha256: HASH,
    standing: 'sample',
    variable: 'DATABASE_URL',
    value: { connection },
  })
  const rendered = connection.outcome === 'parsed' ? composeConnection(connection) : ''
  for (const leaf of [...leaves(connection), rendered, ...leaves(finding)]) {
    expect(leaf.includes(MARKER), `${leaf} from ${generated.input}`).toBe(false)
  }

  if (generated.twice) {
    expect(connection, generated.input).toEqual({ outcome: 'unparsed', why: 'ambiguous' })
    seen.ambiguous += 1
    return
  }
  expect(['parsed', 'placeholder', 'unparsed', 'withheld']).toContain(connection.outcome)
  if (connection.outcome !== 'parsed') return
  seen.parsed += 1
  expect(connection.hosts, generated.input).toEqual(generated.hosts)
  expect(connection.database, generated.input).toBe(generated.database)
  expect(connection.user, generated.input).toBe(generated.user)
  expect(connection.dropped.includes('password'), generated.input).toBe(generated.written)
  if (generated.written) seen.dropped += 1
}

const URL_SCHEMES = ['postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'amqp'] as const

/**
 * What a URL's query says a second time beside its authority: the user, as
 * written, in capitals or percent-encoded as a driver decodes it, or a part of
 * the target a driver lets the query override (libpq's URI, mysql2). Each must
 * come back ambiguous, never with the authority's value kept as if it held.
 */
const SAID_AGAIN = ['user', 'USER', '%75ser', 'username', 'host', 'hostaddr', 'port', 'dbname', 'database'] as const

const urlForm = fc
  .record({
    scheme: fc.constantFrom(...URL_SCHEMES),
    hosts: fc.array(fc.record({ host: hostName, port: fc.option(port, { nil: undefined }) }), {
      minLength: 1,
      maxLength: 3,
    }),
    database: identifier,
    user: identifier,
    secret,
    again: fc.constantFrom(...SAID_AGAIN),
  })
  .map(({ scheme, hosts, database, user, secret: { placement: where, twice, password }, again }): Generated => {
    const list: HostPort[] = hosts.map(({ host, port: at }) => (at === undefined ? { host } : { host, port: at }))
    const authority = list.map((host) => hostPort(host)).join(',')
    const repeated = twice ? `?${again}=${user}` : ''
    const input =
      where === 'unnamed'
        ? `${scheme}://${user}@${authority}/${database}?auth_token_x=${password}`
        : `${scheme}://${user}:${where === 'quoted' ? encodeURIComponent(password) : password}@${authority}/${database}${repeated}`
    return { input, hosts: list, database, user, written: where !== 'unnamed', twice }
  })

const jdbcForm = fc
  .record({
    dialect: fc.constantFrom('postgres', 'sqlserver', 'oracle'),
    host: hostName,
    hosts: fc.array(fc.record({ host: hostName, port }), { minLength: 1, maxLength: 3 }),
    port: fc.option(port, { nil: undefined }),
    database: identifier,
    user: identifier,
    secret,
  })
  .map(({ dialect, host, hosts, port: at, database, user, secret: { placement: where, twice, password } }): Generated => {
    const one: HostPort = at === undefined ? { host } : { host, port: at }
    switch (dialect) {
      case 'postgres': {
        const authority = hosts.map((each) => hostPort(each)).join(',')
        const repeated = twice ? `&user=${user}` : ''
        const input =
          where === 'unnamed'
            ? `jdbc:postgresql://${authority}/${database}?user=${user}&auth_token_x=${password}`
            : `jdbc:postgresql://${authority}/${database}?user=${user}${repeated}&password=${where === 'quoted' ? encodeURIComponent(password) : password}`
        return { input, hosts, database, user, written: where !== 'unnamed', twice }
      }
      case 'sqlserver': {
        const repeated = twice ? `;databaseName=${database}` : ''
        const value = where === 'quoted' ? `{${password.replaceAll('}', '}}')}}` : password
        const input =
          where === 'unnamed'
            ? `jdbc:sqlserver://${hostPort(one)};databaseName=${database};user=${user};accessToken=${password}`
            : `jdbc:sqlserver://${hostPort(one)};databaseName=${database}${repeated};user=${user};password=${value};encrypt=true`
        return { input, hosts: [one], database, user, written: where !== 'unnamed', twice }
      }
      case 'oracle': {
        // Oracle's thin form has no key to write twice: a run drawn twice is
        // read as a quoted one.
        const value = where === 'unquoted' ? password : `"${password}"`
        const input =
          where === 'unnamed'
            ? `jdbc:oracle:thin:${user}@//${hostPort(one)}/${database}?auth_token_x=${password}`
            : `jdbc:oracle:thin:${user}/${value}@//${hostPort(one)}/${database}`
        return { input, hosts: [one], database, user, written: where !== 'unnamed', twice: false }
      }
      default: {
        const _exhaustive: never = dialect
        return _exhaustive
      }
    }
  })

const libpqForm = fc
  .record({
    hosts: fc.array(hostName, { minLength: 1, maxLength: 3 }),
    ports: fc.option(fc.array(port, { minLength: 3, maxLength: 3 }), { nil: undefined }),
    database: identifier,
    user: identifier,
    secret,
  })
  .map(({ hosts, ports, database, user, secret: { placement: where, twice, password } }): Generated => {
    const list: HostPort[] = hosts.map((host, index) =>
      ports === undefined ? { host } : { host, port: ports[index] ?? 1 },
    )
    const portList = ports === undefined ? '' : ` port=${list.map((host) => String(host.port)).join(',')}`
    const repeated = twice ? ` dbname=${database}` : ''
    const quoted = `'${password.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
    const slot =
      where === 'unnamed' ? `sslpassword=${password}` : `password=${where === 'quoted' ? quoted : password}`
    const input = `host=${hosts.join(',')}${portList} dbname=${database}${repeated} user=${user} ${slot} sslmode=require`
    return { input, hosts: list, database, user, written: where !== 'unnamed', twice }
  })

const adonetForm = fc
  .record({ host: hostName, port: fc.option(port, { nil: undefined }), database: identifier, user: identifier, secret })
  .map(({ host, port: at, database, user, secret: { placement: where, twice, password } }): Generated => {
    const one: HostPort = at === undefined ? { host } : { host, port: at }
    const repeated = twice ? `;Initial Catalog=${database}` : ''
    const slot =
      where === 'unnamed'
        ? `Token=${password}`
        : `Password=${where === 'quoted' ? `"${password.replaceAll('"', '""')}"` : password}`
    const input = `Server=${hostPort(one, ',')};Database=${database}${repeated};User ID=${user};${slot};Encrypt=true`
    return { input, hosts: [one], database, user, written: where !== 'unnamed', twice }
  })

const httpForm = fc
  .record({
    scheme: fc.constantFrom('http', 'https'),
    host: hostName,
    port: fc.option(port, { nil: undefined }),
    token: passwordOf(DELIMITERS),
  })
  .map(({ scheme, host, port: at, token }) => {
    const one: HostPort = at === undefined ? { host } : { host, port: at }
    return { input: `${scheme}://${hostPort(one)}/hooks/${token}`, origin: `${scheme}://${hostPort(one)}`, one }
  })

describe('a password reaches no finding', { timeout: PROPERTY_TIMEOUT }, () => {
  const forms: readonly (readonly [string, fc.Arbitrary<Generated>])[] = [
    ['the URL form', urlForm],
    ["JDBC, in PostgreSQL's, SQL Server's and Oracle's dialects", jdbcForm],
    ['libpq', libpqForm],
    ['ADO.NET', adonetForm],
  ]

  it.each(forms)('in %s', (_, form) => {
    const seen = counts()
    const seed = freshSeed()
    fc.assert(
      fc.property(form, (generated) => check(generated, seen)),
      { numRuns: 500, seed },
    )
    // Measured over 20 runs once the parser was written: 309 to 419 of 500
    // parsed, 233 to 338 of them with a password dropped, and 52 to 124 keys
    // written twice, across the four forms. The floors sit well below the
    // lowest, so no seed trips them, and a parser that read nothing would.
    expect(seen.parsed, `seed ${String(seed)}`).toBeGreaterThan(150)
    expect(seen.dropped, `seed ${String(seed)}`).toBeGreaterThan(100)
    expect(seen.ambiguous, `seed ${String(seed)}`).toBeGreaterThan(30)
  })

  it('in an http URL whose path carries a token', () => {
    let parsed = 0
    const seed = freshSeed()
    fc.assert(
      fc.property(httpForm, ({ input, origin, one }) => {
        const connection = parseConnection(input)
        const finding = mintFinding({
          rule: 'env-file.url',
          path: '.env.example',
          lines: [1, 1],
          fileSha256: HASH,
          standing: 'sample',
          variable: 'WEBHOOK_URL',
          value: { connection },
        })
        const rendered = connection.outcome === 'parsed' ? composeConnection(connection) : ''
        for (const leaf of [...leaves(connection), rendered, ...leaves(finding)]) {
          expect(leaf.includes(MARKER), `${leaf} from ${input}`).toBe(false)
        }
        expect(['parsed', 'unparsed']).toContain(connection.outcome)
        if (connection.outcome !== 'parsed') return
        parsed += 1
        expect(connection.hosts, input).toEqual([one])
        expect(connection.url, input).toBe(origin)
        expect(connection.dropped, input).toContain('path')
      }),
      { numRuns: 500, seed },
    )
    // 396 to 427 of 500 over the same 20 runs: the rest held an `@` in the path.
    expect(parsed, `seed ${String(seed)}`).toBeGreaterThan(150)
  })
})

/**
 * Task 1.4, test 13: end to end, through `main`, a password in a service's
 * configuration reaches no line `init` writes, no trace and no pull request
 * body. One password, marked in every fragment, sits in the three slots of
 * environment files — `.env.example`'s URL (committed, opened, extracted),
 * `deploy/prod.env` (committed, never opened) and an untracked `.env` — and a
 * second, marked otherwise, in the two of `package.json`: one that fails to
 * parse with the password beside its fault, and one whose dependency spec
 * carries it in a git URL's userinfo. The Inspector's snapshot reads those two
 * and sends them to the model as it does today, governed by `project-fs`'s
 * own filter and tests, so their marker is looked for everywhere but the
 * model calls' spans; the first marker is looked for everywhere.
 *
 * First the report is asserted where it goes — stdout, and after the engine's
 * block in the body — so the property fails for its own reason before the
 * report exists, not for an import. Then no marker: every string leaf, walked,
 * never `JSON.stringify`.
 */
describe('a password reaches no line init writes, no trace and no pull request body', { timeout: PROPERTY_TIMEOUT }, () => {
  const PACKAGE_MARKER = 'Qz8'
  const passwords = fc.record({
    environment: passwordOf(DELIMITERS),
    manifest: passwordOf(DELIMITERS).map((password) => password.replaceAll(MARKER, PACKAGE_MARKER)),
  })

  const call = (name: string, args: unknown): GenerateResult => ({
    text: '',
    toolCalls: [{ id: `call-${name}`, name, args }],
    finishReason: 'tool-calls',
  })
  const client = (): LlmClient => {
    const turns: Partial<Record<AgentName, GenerateResult[]>> = {
      inspector: [
        {
          text: '',
          toolCalls: ['package.json', 'CODEOWNERS', 'README.md'].map((file) => ({
            id: `read-${file}`,
            name: 'read_file',
            args: { path: file },
          })),
          finishReason: 'tool-calls',
        },
        call(REPORT_TOOL, {
          name: 'billing-api',
          type: 'service',
          lifecycle: 'production',
          runtime: 'node',
          owner: 'group:default/tiger',
          forgeHandle: '@acme/platform',
        }),
      ],
      architect: [
        call(PROPOSE_TOOL, {
          operations: [
            {
              op: 'create-entity',
              entity: {
                kind: 'Component',
                metadata: { name: 'billing-api' },
                spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
              },
            },
          ],
        }),
      ],
      reviewer: [call(VERDICT_TOOL, { verdict: 'ok' })],
    }
    const spent = new Map<AgentName, number>()
    return {
      generate: async (request: GenerateRequest): Promise<GenerateResult> => {
        const index = spent.get(request.agent) ?? 0
        spent.set(request.agent, index + 1)
        return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      },
    }
  }

  afterAll(removeClones)

  it('in five places, through init --submit to GitHub', async () => {
    await fc.assert(
      fc.asyncProperty(passwords, async ({ environment, manifest }) => {
        const source = await mkdtemp(path.join(tmpdir(), 'idp-discovery-secret-'))
        try {
          const write = async (file: string, text: string): Promise<void> => {
            await mkdir(path.dirname(path.join(source, file)), { recursive: true })
            await writeFile(path.join(source, file), text, 'utf8')
          }
          await write('package.json', `${JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8.0.0' } }, null, 2)}\n`)
          await write('CODEOWNERS', '* @acme/platform\n')
          await write('README.md', 'type: service\nlifecycle: production\nruntime: node\nowner: group:default/tiger\n')
          await write('.gitignore', '.env\n')
          await write('.env.example', `DATABASE_URL=mysql://app_billing:${environment}@localhost:3306/billing\n`)
          await write('deploy/prod.env', `DATABASE_URL=mysql://app_billing:${environment}@billing-db.prod.internal:3306/billing\n`)
          await write('packages/a/package.json', `{\n  "name": "a", ${manifest}\n}\n`)
          await write(
            'packages/b/package.json',
            `${JSON.stringify({ name: 'b', dependencies: { x: `git+https://user:${manifest}@host/x.git` } }, null, 2)}\n`,
          )
          const clone = await githubClone({ source, repository: 'acme/billing-api' })
          await writeFile(path.join(clone.repo, '.env'), `DATABASE_URL=mysql://app:${environment}@db.internal/x\n`, 'utf8')

          const sink = memorySink()
          const out: string[] = []
          const err: string[] = []
          // The Component's four fields typed: what the Inspector reads is a
          // hint, never an answer (stage 8, slice 2, Task 2.1).
          const typed = ['--name', 'billing-api', '--type', 'service', '--lifecycle', 'production', '--owner', 'group:default/tiger']
          const code = await main(
            ['init', '--project', clone.repo, '--submit', '--iac-repo', 'github.com/acme/iac', '--environment', 'dev', ...typed],
            {
              cwd: clone.repo,
              env: clone.env,
              gh: clone.gh.process,
              client: client(),
              traceSinks: [sink],
              out: (chunk) => void out.push(chunk),
              err: (chunk) => void err.push(chunk),
            },
          )
          const stdout = out.join('')
          const stderr = err.join('')
          const posted = clone.gh.sent.filter(({ argv }) => argv.includes('POST'))
          const { body = '' } = JSON.parse(posted[0]?.stdin?.toString('utf8') ?? '{}') as { body?: string }

          // The report is where it goes: the property is about it.
          expect(code, stderr).toBe(0)
          expect(stdout).toMatch(/^discovery — /m)
          const end = body.split('\n').indexOf(ENGINE_BLOCK_END)
          expect(end).toBeGreaterThan(-1)
          expect(body.split('\n').slice(end + 1).join('\n')).toContain('no dependency evidenced')

          const trace = onlyTrace(sink)
          const everywhere = [stdout, stderr, body, ...leaves(trace)]
          for (const leaf of everywhere) expect(leaf.includes(MARKER), leaf).toBe(false)
          const outsideModels = [stdout, stderr, body, ...leaves(trace.spans.filter((span) => span.type !== 'CHAT_MODEL'))]
          for (const leaf of outsideModels) expect(leaf.includes(PACKAGE_MARKER), leaf).toBe(false)
        } finally {
          await rm(source, { recursive: true, force: true })
        }
      }),
      { numRuns: 5 },
    )
  })

  /**
   * Task 2.4: a Kubernetes manifest is a road of its own. The password sits
   * in a Deployment's `value:` in each of the parser's four forms, quoted as
   * YAML and as each form quotes, and in a Secret's `stringData` beside it;
   * the run asserts it read the one and set the other aside before it looks
   * for the marker, everywhere, the model calls' spans included: the scripted
   * Inspector opens neither file.
   */
  it('in a Deployment’s environment and a Secret, through init --submit to GitHub', async () => {
    const seen = { evidenced: 0 }
    await fc.assert(
      fc.asyncProperty(passwordOf(DELIMITERS), async (password) => {
        const source = await mkdtemp(path.join(tmpdir(), 'idp-discovery-k8s-secret-'))
        try {
          const write = async (file: string, text: string): Promise<void> => {
            await mkdir(path.dirname(path.join(source, file)), { recursive: true })
            await writeFile(path.join(source, file), text, 'utf8')
          }
          const values: readonly (readonly [string, string])[] = [
            ['DATABASE_URL', `mysql://app_billing:${encodeURIComponent(password)}@billing-db.prod.internal:3306/billing`],
            ['LEDGER_JDBC', `jdbc:postgresql://pg-01.prod.internal:5432/ledger?user=app&password=${encodeURIComponent(password)}`],
            ['LEDGER_DSN', `host=pg-01.prod.internal dbname=ledger user=app password='${password.replace(/['\\]/g, '\\$&')}'`],
            ['REPORTS_DSN', `Server=sql.prod.internal;Database=reports;User Id=app;Password="${password.replaceAll('"', '""')}";`],
          ]
          // JSON's string is a YAML double-quoted scalar: whatever the password holds, the value is one scalar.
          const env = values.map(([name, value]) => `            - name: ${name}\n              value: ${JSON.stringify(value)}\n`).join('')
          await write('package.json', `${JSON.stringify({ name: 'billing-api' }, null, 2)}\n`)
          await write('CODEOWNERS', '* @acme/platform\n')
          await write('README.md', 'type: service\nlifecycle: production\nruntime: node\nowner: group:default/tiger\n')
          await write(
            'k8s/deployment.yaml',
            'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: billing-api\nspec:\n  template:\n    spec:\n' +
              `      containers:\n        - name: api\n          image: acme/billing-api:1.0.0\n          env:\n${env}`,
          )
          // Under a name the read opens, so it is recognised by parsing it, and discarded whole.
          await write(
            'k8s/billing-db.yaml',
            `apiVersion: v1\nkind: Secret\nmetadata:\n  name: billing-db-creds\nstringData:\n  password: ${JSON.stringify(password)}\n`,
          )
          const clone = await githubClone({ source, repository: 'acme/billing-api' })

          const sink = memorySink()
          const out: string[] = []
          const err: string[] = []
          const typed = ['--name', 'billing-api', '--type', 'service', '--lifecycle', 'production', '--owner', 'group:default/tiger']
          const code = await main(
            ['init', '--project', clone.repo, '--submit', '--iac-repo', 'github.com/acme/iac', '--environment', 'dev', ...typed],
            {
              cwd: clone.repo,
              env: clone.env,
              gh: clone.gh.process,
              client: client(),
              traceSinks: [sink],
              out: (chunk) => void out.push(chunk),
              err: (chunk) => void err.push(chunk),
            },
          )
          const stdout = out.join('')
          const stderr = err.join('')
          const posted = clone.gh.sent.filter(({ argv }) => argv.includes('POST'))
          const { body = '' } = JSON.parse(posted[0]?.stdin?.toString('utf8') ?? '{}') as { body?: string }

          // The road it is about: the manifest read, the Secret set aside, in the report and the body.
          expect(code, stderr).toBe(0)
          expect(stdout).toContain('k8s/deployment.yaml:12   the repository states mysql database billing')
          expect(stdout).toContain('a Secret or a SealedSecret, discarded whole: k8s/billing-db.yaml')
          const end = body.split('\n').indexOf(ENGINE_BLOCK_END)
          expect(end).toBeGreaterThan(-1)
          expect(body.split('\n').slice(end + 1).join('\n')).toContain('`k8s/deployment.yaml`:12')
          if (/^[1-9]\d* dependenc(?:y|ies) evidenced/m.test(stdout)) seen.evidenced += 1

          for (const leaf of [stdout, stderr, body, ...leaves(onlyTrace(sink))]) expect(leaf.includes(MARKER), leaf).toBe(false)
        } finally {
          await rm(source, { recursive: true, force: true })
        }
      }),
      { numRuns: 5 },
    )
    // Not vacuous: a URL whose password is percent-encoded is always read.
    expect(seen.evidenced).toBe(5)
  })
})
