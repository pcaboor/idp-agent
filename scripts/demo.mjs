#!/usr/bin/env node
/**
 * `pnpm demo`: the README's keyless tour, run end to end against the fictional
 * demo SI in `fixtures/si-demo/`. No model, no key, no network, and nothing
 * written — step 4 hashes the repository the plan was previewed against, and
 * the demo fails if a single byte moved.
 *
 * Every step states the exit code it expects and the demo fails when the
 * binary returns another, so `pnpm smoke`, which runs this script, fails with
 * it: the tour a newcomer is pointed at cannot stop halfway again unnoticed.
 *
 * Run after `pnpm build`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const BIN = path.join(ROOT, 'dist/cli/bin.js')
const DEMO_SI = 'fixtures/si-demo'

const tty = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined
const bold = (text) => (tty ? `\u001b[1m${text}\u001b[0m` : text)

if (!existsSync(BIN)) {
  console.error('dist/cli/bin.js is missing: run pnpm build first')
  process.exit(1)
}

/** Every path and every byte under a directory, as one digest. */
function hashTree(dir) {
  const digest = createHash('sha256')
  const walk = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        digest.update(`d ${relative}\n`)
        walk(full, relative)
      } else {
        digest.update(`f ${relative}\n`)
        digest.update(readFileSync(full))
      }
    }
  }
  walk(dir, '')
  return digest.digest('hex')
}

let failed = false

/**
 * One step: the command as a person types it from the clone, what it printed,
 * and its exit code checked against the one expected. stdin is closed, as in
 * CI: a question is printed and the run exits 3, rather than waiting at a
 * prompt nobody is told to answer.
 */
function step(title, args, expected) {
  console.log(`\n${bold(title)}`)
  console.log(`$ node dist/cli/bin.js ${args.join(' ')}`)
  const run = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
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
}

step('1. What breaks if the database server mysql-prod-01 fails?', ['relations', 'mysql-prod-01', '--impacts', '--demo'], 0)
step('2. What billing-api is, and what it depends on', ['show', 'billing-api', '--demo'], 0)

const before = hashTree(path.join(ROOT, DEMO_SI))
step(
  '3. A change, as the diff it would make — the plan comes from a file, so no model is involved',
  ['plan', '--from', 'examples/open-network.json', '--repo', DEMO_SI],
  0,
)

console.log(`\n${bold(`4. Did ${DEMO_SI} move?`)}`)
if (hashTree(path.join(ROOT, DEMO_SI)) === before) {
  console.log('unchanged: same files, same bytes, same folders')
} else {
  console.log(`CHANGED: the preview wrote into ${DEMO_SI}`)
  failed = true
}

step(
  '5. A value nobody can vouch for is asked, not guessed (3: understood, and not acted on)',
  ['plan', '--from', 'examples/needs-an-owner.json', '--repo', DEMO_SI],
  3,
)

if (failed) {
  console.error('\nThe demo did not run as documented.')
  process.exit(1)
}
console.log(
  `\n${bold('Done.')} No model was called, no key was read, and nothing was written.` +
    '\nWith a key of your own: README.md, "With your own key".',
)
