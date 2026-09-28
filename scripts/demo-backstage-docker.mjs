#!/usr/bin/env node
/**
 * `pnpm demo:backstage:docker`: the README's relations, read from a real
 * Backstage (tools/backstage/README.md). It builds and starts the demo
 * Backstage with Docker, waits until its catalogue holds the demo SI, runs the
 * built binary against it as a person would, and stops it. No model, no key.
 *
 * Every step states what it expects, and the demo fails on anything else:
 *   1. the catalogue serves every entity of the demo SI, the demo's
 *      organisation (five Groups, two Users) and three Locations — the
 *      registration and the one Backstage generates for each
 *      catalog.locations entry — which is Backstage's file reader resolving
 *      the registration's globs, and its rules admitting Resources;
 *   2. `relations mysql-prod-01 --impacts` prints the README's table: stdout
 *      is `--demo`'s, byte for byte, and the golden file's;
 *   3. `show billing-api` prints what `--demo` prints;
 *   4. `show tiger` prints the team read from the catalogue, as it prints it
 *      read from the same files (the demo SI and org.yaml), which is what the
 *      fake serves;
 *   5. without the token, the catalogue answers 401 and idpa says so, exit 1;
 *   6. the token reads and does nothing else: a refresh is refused (403).
 *
 *     pnpm build && pnpm demo:backstage:docker            # build, run, stop
 *     pnpm demo:backstage:docker --keep                   # leave it running: http://127.0.0.1:7007
 *     pnpm demo:backstage:docker --record                 # also rewrite the contract fixture
 *
 * `--record`, once every step above went as expected, writes the page the
 * provider's modelled read is answered with to tests/contract/backstage/, the contract fixture of
 * docs/backstage-http-brief.md § 9: the demo SI only, from this loopback
 * Backstage, no token — and the first page of the organisation read beside
 * it (`org-by-query-<version>.json`), which proves the real Backstage honours
 * `fields`: no profile, no annotation — a page holding either is not written.
 * Needs Docker and the network for the first build.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const BIN = path.join(ROOT, 'dist/cli/bin.js')
const COMPOSE = path.join(ROOT, 'tools/backstage/compose.yml')
const BASE = 'http://127.0.0.1:7007/api/catalog'
/**
 * compose.yml's default, public in this repository: a demo value, never a
 * secret. The demo hands it to compose itself, so one exported for another
 * run of `pnpm backstage:up` does not change what this script sends.
 */
const DEMO_TOKEN = 'idpa-demo-read-only-token'
const TOKEN = DEMO_TOKEN
const BACKSTAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'tools/backstage/app/backstage.json'), 'utf8')).version
const FIXTURE = path.join(ROOT, `tests/contract/backstage/by-query-${BACKSTAGE_VERSION}.json`)
/** The provider's modelled read, as `loadCatalogue` sends it: the request the fixture answers. */
const MODELLED_QUERY = 'filter=kind%3Dcomponent&filter=kind%3Dresource&filter=kind%3Dapi&limit=250'
const ORGANISATION_FIXTURE = path.join(ROOT, `tests/contract/backstage/org-by-query-${BACKSTAGE_VERSION}.json`)
/** The organisation read, as `loadCatalogue` sends it over this catalogue's Groups and Users. */
const ORGANISATION_QUERY = new URLSearchParams([
  ['filter', 'kind=group'],
  ['filter', 'kind=user'],
  [
    'fields',
    'apiVersion,kind,metadata.name,metadata.namespace,metadata.uid,' +
      'spec.type,spec.parent,spec.children,spec.members,spec.memberOf,spec.owner,spec.domain,spec.subdomainOf',
  ],
  ['limit', '250'],
]).toString()

const keep = process.argv.includes('--keep')
const record = process.argv.includes('--record')

const tty = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined
const bold = (text) => (tty ? `\u001b[1m${text}\u001b[0m` : text)

function fail(message) {
  console.error(`pnpm demo:backstage:docker: ${message}`)
  process.exit(1)
}

try {
  readFileSync(BIN)
} catch {
  fail('dist/cli/bin.js is missing: run pnpm build first')
}
if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
  fail('needs Docker with Compose v2 (docker compose version)')
}

/** docker compose on the demo's file, its output shown; exits on a failure. */
function compose(args) {
  const run = spawnSync('docker', ['compose', '-f', COMPOSE, ...args], {
    stdio: 'inherit',
    env: { ...process.env, IDPA_CATALOG_TOKEN: TOKEN },
  })
  if (run.status !== 0) fail(`docker compose ${args.join(' ')} exited ${run.status}`)
}

let stopped = false
function down() {
  if (keep || stopped) return
  stopped = true
  console.log(`\n${bold('Stopping the demo Backstage')}`)
  spawnSync('docker', ['compose', '-f', COMPOSE, 'down'], { stdio: 'inherit' })
}
process.on('exit', down)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

/** Every entity file of the demo SI: one entity each, witnesses excepted. */
function demoFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return demoFiles(full)
    return !entry.name.startsWith('.') && /\.ya?ml$/.test(entry.name) ? [full] : []
  })
}
const DEMO_ENTITIES = demoFiles(path.join(ROOT, 'fixtures/si-demo')).length

/** One GET of the catalogue, with the token or without it: its status and its body. */
async function get(route, query, withToken = true) {
  const response = await fetch(`${BASE}/${route}?${query}`, {
    headers: withToken ? { authorization: `Bearer ${TOKEN}` } : {},
  })
  return { status: response.status, body: await response.text() }
}

/** The count of each kind the catalogue serves, from its facets. */
async function kinds() {
  const { status, body } = await get('entity-facets', 'facet=kind')
  if (status !== 200) return undefined
  return Object.fromEntries(JSON.parse(body).facets.kind.map(({ value, count }) => [value, count]))
}

console.log(bold(`Building and starting Backstage ${BACKSTAGE_VERSION} (tools/backstage/compose.yml)`))
const started = performance.now()
compose(['up', '-d', '--build', '--wait'])
console.log(`ready in ${Math.round((performance.now() - started) / 1000)} s`)

// The backend is ready before the catalogue has read every file: the
// processing loop ingests the Location, then its targets, then stitches.
console.log(`\n${bold('1. Waiting for the catalogue to hold the demo SI')}`)
const expected = { Group: 5, User: 2, Location: 3 }
let served
const until = Date.now() + 180_000
for (;;) {
  served = await kinds().catch(() => undefined)
  const modelled = (served?.['Component'] ?? 0) + (served?.['Resource'] ?? 0) + (served?.['API'] ?? 0)
  if (
    modelled === DEMO_ENTITIES &&
    served?.['Group'] === expected.Group &&
    served?.['User'] === expected.User &&
    served?.['Location'] === expected.Location
  ) {
    break
  }
  if (Date.now() > until) fail(`the catalogue did not hold the demo SI within 3 minutes: ${JSON.stringify(served)}`)
  await new Promise((resolve) => setTimeout(resolve, 2_000))
}
console.log(`the catalogue serves ${JSON.stringify(served)}: the ${DEMO_ENTITIES} entities of fixtures/si-demo, its registration and the organisation`)

let failed = false
const scratch = mkdtempSync(path.join(tmpdir(), 'idpa-docker-demo-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

/** The environment a person's shell would have: no repository, no personal file, this catalogue. */
function environmentWith(variables) {
  const environment = { ...process.env, XDG_CONFIG_HOME: scratch, ...variables }
  delete environment['IDP_REPO']
  if (!('IDP_BACKSTAGE_TOKEN' in variables)) delete environment['IDP_BACKSTAGE_TOKEN']
  if (!('IDP_BACKSTAGE_URL' in variables)) delete environment['IDP_BACKSTAGE_URL']
  return environment
}

/** Runs the binary from a directory that is not a declarations repository. */
function idpa(args, variables) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: scratch,
    env: environmentWith(variables),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** One step against the catalogue, compared with `--demo` and, when given, a golden file. */
function step(title, args, golden) {
  console.log(`\n${bold(title)}`)
  console.log(`$ env -u IDP_REPO IDP_BACKSTAGE_URL=${BASE} IDP_BACKSTAGE_TOKEN=${TOKEN} idpa ${args.join(' ')}`)
  const run = idpa(args, { IDP_BACKSTAGE_URL: BASE, IDP_BACKSTAGE_TOKEN: TOKEN })
  process.stdout.write(run.stderr)
  process.stdout.write(run.stdout)
  const demo = idpa([...args, '--demo'], {})
  if (run.status !== 0) {
    console.log(`(exit ${run.status}; this step expects 0)`)
    failed = true
    return
  }
  console.log('(exit 0)')
  if (run.stdout === demo.stdout) console.log('stdout is what --demo prints, byte for byte')
  else {
    console.log('stdout is not what --demo prints')
    failed = true
  }
  if (golden !== undefined && run.stdout !== readFileSync(path.join(ROOT, golden), 'utf8')) {
    console.log(`stdout is not ${golden}, byte for byte`)
    failed = true
  }
}

step(
  '2. What breaks if the database server mysql-prod-01 fails, read from a real Backstage?',
  ['relations', 'mysql-prod-01', '--impacts'],
  'tests/golden/relations-demo/mysql-prod-01-impacts.txt',
)
step('3. What billing-api is, from the same catalogue', ['show', 'billing-api'], 'tests/golden/demo-read/show-billing-api.txt')

console.log(`\n${bold('4. A team, read from the same catalogue')}`)
{
  // The same documents as files: the demo SI and org.yaml, in a folder of its own.
  const files = path.join(scratch, 'si-demo-with-org')
  cpSync(path.join(ROOT, 'fixtures/si-demo'), files, { recursive: true })
  mkdirSync(path.join(files, 'org'), { recursive: true })
  cpSync(path.join(ROOT, 'tools/backstage/org.yaml'), path.join(files, 'org/org.yaml'))
  console.log(`$ env -u IDP_REPO IDP_BACKSTAGE_URL=${BASE} IDP_BACKSTAGE_TOKEN=${TOKEN} idpa show tiger`)
  const run = idpa(['show', 'tiger'], { IDP_BACKSTAGE_URL: BASE, IDP_BACKSTAGE_TOKEN: TOKEN })
  process.stdout.write(run.stderr)
  process.stdout.write(run.stdout)
  const asFiles = idpa(['show', 'tiger', '--repo', files], {})
  console.log(`(exit ${run.status}; this step expects 0)`)
  if (run.status !== 0) failed = true
  if (run.stdout === asFiles.stdout) console.log('stdout is what the same files print, byte for byte')
  else {
    console.log('stdout is not what the same files print')
    failed = true
  }
}

console.log(`\n${bold('5. Without the token, the catalogue refuses and idpa says so')}`)
const bare = await get('entities/by-query', 'limit=1', false)
console.log(`GET ${BASE}/entities/by-query with no token: ${bare.status}`)
if (bare.status !== 401) failed = true
console.log(`$ env -u IDP_REPO -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=${BASE} idpa relations mysql-prod-01 --impacts`)
const refused = idpa(['relations', 'mysql-prod-01', '--impacts'], { IDP_BACKSTAGE_URL: BASE })
process.stdout.write(refused.stderr)
console.log(`(exit ${refused.status}; stdout ${refused.stdout === '' ? 'empty' : 'NOT empty'})`)
if (refused.status !== 1 || refused.stdout !== '' || !refused.stderr.includes('(401)')) failed = true

console.log(`\n${bold('6. The token reads, and nothing else')}`)
const refresh = await fetch(`${BASE}/refresh`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ entityRef: 'resource:default/mysql-prod-01' }),
})
console.log(`POST ${BASE}/refresh with the read token: ${refresh.status}`)
if (refresh.status !== 403) failed = true

if (failed) {
  // Before any recording: a run that did not go as documented never replaces the contract fixture.
  console.error(`\nThe Docker Backstage demo did not run as documented${record ? '; the contract fixture was not rewritten' : ''}.`)
  process.exit(1)
}

if (record) {
  const page = await get('entities/by-query', MODELLED_QUERY)
  if (page.status !== 200) fail(`the modelled read answered ${page.status}; the contract fixture was not rewritten`)
  writeFileSync(FIXTURE, `${JSON.stringify(JSON.parse(page.body), null, 2)}\n`)
  console.log(`\nrecorded ${path.relative(ROOT, FIXTURE)}: GET ${BASE}/entities/by-query?${MODELLED_QUERY}`)
  const organisation = await get('entities/by-query', ORGANISATION_QUERY)
  if (organisation.status !== 200) fail(`the organisation read answered ${organisation.status}; its fixture was not rewritten`)
  const served = JSON.parse(organisation.body)
  // The fixture is the proof that Backstage honours `fields`: a page that
  // carries what was not asked for proves the opposite, and is not written.
  const overserved = (served.items ?? []).filter(
    (item) => item?.spec?.profile !== undefined || item?.metadata?.annotations !== undefined,
  )
  if (overserved.length > 0) {
    fail(
      `the organisation read served ${overserved.length} items with a profile or annotations it did not ask for: ` +
        'the catalogue did not honour `fields`; its fixture was not rewritten',
    )
  }
  writeFileSync(ORGANISATION_FIXTURE, `${JSON.stringify(served, null, 2)}\n`)
  console.log(`recorded ${path.relative(ROOT, ORGANISATION_FIXTURE)}: GET ${BASE}/entities/by-query?${ORGANISATION_QUERY}`)
}
console.log(`\n${bold('Done.')} No model was called and no key was read.`)
if (keep) {
  console.log(`The demo Backstage is still running: http://127.0.0.1:7007 (guest sign-in). Stop it with pnpm backstage:down.`)
}
