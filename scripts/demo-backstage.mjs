#!/usr/bin/env node
/**
 * `pnpm demo:backstage`: the README's relations, read from a Backstage
 * catalogue rather than from files, with no Backstage installed. It starts
 * `tools/fake-backstage.ts` on 127.0.0.1, on a port the system chooses, runs
 * the built binary against it, and stops it. No model, no key, and no network
 * beyond that loopback fake (docs/backstage-http-brief.md § 9).
 *
 * Every step states what it expects and the demo fails on anything else, so
 * `pnpm smoke`, which runs this script, fails with it:
 *   1. `relations mysql-prod-01 --impacts` prints the README's table, the
 *      bytes of `tests/golden/relations-demo/mysql-prod-01-impacts.txt`;
 *   2. `show billing-api` prints what `--demo` prints, answered from the
 *      copy step 1 kept: the fake is sent no request, and the notice says the
 *      copy's age;
 *   3. a change is decided against the declarations repository alone: `plan
 *      --from` sends the catalogue no request, which the fake's log shows.
 *
 * `IDP_BACKSTAGE_TOKEN` is removed from everything it runs. A token is sent to
 * a loopback catalogue too, and one exported for the company's Backstage has
 * no business reaching a fake. `XDG_CACHE_HOME` points into a scratch folder
 * of this run, removed when it ends, so the copy step 1 keeps lands nowhere
 * near the contributor's own `~/.cache`; `IDP_BACKSTAGE_CACHE` is removed, so
 * a shell that turned the cache off still sees what the demo shows.
 *
 * Run after `pnpm build`. The fake is TypeScript that Node runs as it is,
 * which needs Node 22.18 or later (`scripts/type-stripping.mjs`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strippingRefusal } from './type-stripping.mjs'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const BIN = path.join(ROOT, 'dist/cli/bin.js')

const tty = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined
const bold = (text) => (tty ? `\u001b[1m${text}\u001b[0m` : text)

const refusal = strippingRefusal()
if (refusal !== undefined) {
  console.error(`pnpm demo:backstage: ${refusal}, which runs tools/fake-backstage.ts as it is`)
  process.exit(1)
}
if (!existsSync(BIN)) {
  console.error('dist/cli/bin.js is missing: run pnpm build first')
  process.exit(1)
}

/** Where the binary keeps the catalogue it reads: this run's, removed when it ends. */
const scratch = mkdtempSync(path.join(tmpdir(), 'idp-demo-backstage-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

/** The environment of everything this script starts: no catalogue token, ever, and a cache of its own. */
const environment = { ...process.env, XDG_CACHE_HOME: path.join(scratch, 'cache') }
delete environment['IDP_BACKSTAGE_TOKEN']
delete environment['IDP_BACKSTAGE_URL']
delete environment['IDP_BACKSTAGE_CACHE']

// Node 22 warns that type stripping is experimental; the warning is not the demo's.
const fake = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', 'tools/fake-backstage.ts', '--port', '0'],
  { cwd: ROOT, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
)
// However this script ends — a failed step, a throw, Ctrl-C — the fake goes
// with it: a port left listening is a demo that cannot run twice.
process.on('exit', () => fake.kill())
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

/** One line per request the fake answered, as it logs them: never a header, so never a token. */
const requests = []
let pending = ''
fake.stderr.setEncoding('utf8')
fake.stderr.on('data', (chunk) => {
  pending += chunk
  const lines = pending.split('\n')
  pending = lines.pop() ?? ''
  requests.push(...lines.filter((line) => line !== ''))
})

/** The catalogue's base, from the fake's one line on stdout. */
const base = await new Promise((resolve, reject) => {
  let out = ''
  const timer = setTimeout(() => reject(new Error('the fake Backstage did not start within 10 seconds')), 10_000)
  fake.stdout.setEncoding('utf8')
  fake.stdout.on('data', (chunk) => {
    out += chunk
    const listening = /^listening on (http:\/\/127\.0\.0\.1:\d+\/api\/catalog)$/m.exec(out)
    if (listening !== null) {
      clearTimeout(timer)
      resolve(listening[1])
    }
  })
  fake.on('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`the fake Backstage exited (${code}) before it listened`))
  })
}).catch((error) => {
  console.error(`pnpm demo:backstage: ${error.message}`)
  process.exit(1)
})

/**
 * The fake's log up to this moment. Its answers are written after its log
 * line, so a step that has exited has had every request logged — but the pipe
 * may not have been read yet. A request of this script's own, to a path the
 * fake answers 404, is logged after all of them: once it is read, so are they.
 */
async function logged() {
  const mark = `/demo-mark-${requests.length}`
  await fetch(new URL(base).origin + mark).then((response) => response.arrayBuffer())
  const until = Date.now() + 5_000
  while (!requests.some((line) => line.includes(mark))) {
    if (Date.now() > until) throw new Error('the fake Backstage did not log a request within 5 seconds')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return requests.filter((line) => !line.includes('/demo-mark-')).length
}

let failed = false

/**
 * One step: the command as a person types it from the clone, what it printed,
 * its exit code checked, and, when given, stdout checked against a golden
 * file's bytes. `spawnSync` holds this script, never the fake, which is a
 * process of its own: its log waits in the pipe until `logged` reads it.
 */
function step(title, args, expected, golden) {
  console.log(`\n${bold(title)}`)
  // As a person must type it: a token exported for the company's Backstage
  // would otherwise be sent to the fake too.
  console.log(`$ env -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=${base} node dist/cli/bin.js ${args.join(' ')}`)
  const run = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...environment, IDP_BACKSTAGE_URL: base },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  process.stdout.write(run.stderr ?? '')
  process.stdout.write(run.stdout ?? '')
  const code = run.status ?? -1
  if (code === expected) {
    console.log(`(exit ${code})`)
  } else {
    console.log(`(exit ${code}; this step expects ${expected})`)
    failed = true
  }
  if (golden !== undefined && run.stdout !== readFileSync(path.join(ROOT, golden), 'utf8')) {
    console.log(`stdout is not ${golden}, byte for byte`)
    failed = true
  }
  return run
}

step(
  '1. What breaks if the database server mysql-prod-01 fails, read from a Backstage?',
  ['relations', 'mysql-prod-01', '--impacts'],
  0,
  'tests/golden/relations-demo/mysql-prod-01-impacts.txt',
)
const first = await logged()
console.log(`\nthe fake Backstage answered ${first} requests for the first read`)

const second = step(
  '2. What billing-api is, from the same catalogue: answered from the copy step 1 kept',
  ['show', 'billing-api'],
  0,
  'tests/golden/demo-read/show-billing-api.txt',
)
const read = await logged()
if (read === first) {
  console.log('the fake Backstage was sent no request for the second read')
} else {
  console.log(`the fake Backstage was sent ${read - first} requests for the second read`)
  failed = true
}
if (!/; read from cache, less than a minute old; --refresh reads Backstage again; /.test(second.stderr ?? '')) {
  console.log('the second read does not say it was read from the copy step 1 kept')
  failed = true
}

step(
  '3. A change is decided against the declarations repository, never the catalogue',
  ['plan', '--from', 'examples/open-network.json', '--repo', 'fixtures/si-demo'],
  0,
)
const sent = (await logged()) - read
if (sent === 0) {
  console.log('the fake Backstage was sent no request while the change was previewed')
} else {
  console.log(`the fake Backstage was sent ${sent} requests while the change was previewed`)
  failed = true
}

fake.kill()
await new Promise((resolve) => (fake.exitCode !== null || fake.signalCode !== null ? resolve() : fake.once('exit', resolve)))

if (failed) {
  console.error('\nThe Backstage demo did not run as documented.')
  process.exit(1)
}
console.log(`\n${bold('Done.')} No model was called and no key was read; the fake Backstage is stopped.`)
