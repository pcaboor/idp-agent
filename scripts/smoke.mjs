#!/usr/bin/env node
/**
 * Runs the packaged binary, which the unit suite never does: it imports the
 * modules instead. What only breaks here is the shape of `dist` — `bin.js`
 * resolves the fixture SI from `import.meta.url`, so a layout change, a missing
 * `files` entry or a bad `bin` mapping passes every test and ships broken.
 *
 * Run after `pnpm build`. No network, no API key, no Docker.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = path.resolve(fileURLToPath(import.meta.url), '../../dist/cli/bin.js')

// Deliberately not the repository root: the binary must find the fixture SI
// from its own location, not from wherever the user happens to stand.
const ELSEWHERE = mkdtempSync(path.join(tmpdir(), 'idp-agent-smoke-'))

const failures = []

/** @param {{args: string[], code: number, stdout?: RegExp, stderr?: RegExp}} expected */
function check({ args, code, stdout, stderr }) {
  const label = `idp-agent ${args.join(' ')}`
  let out = ''
  let err = ''
  let actual = 0
  try {
    out = execFileSync(process.execPath, [BIN, ...args], {
      cwd: ELSEWHERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    actual = error.status ?? -1
    out = error.stdout ?? ''
    err = error.stderr ?? ''
  }

  const before = failures.length
  if (actual !== code) failures.push(`${label}: expected exit ${code}, got ${actual}`)
  if (stdout !== undefined && !stdout.test(out)) failures.push(`${label}: stdout ${stdout}`)
  if (stderr !== undefined && !stderr.test(err)) failures.push(`${label}: stderr ${stderr}`)
  console.log(`  ${failures.length === before ? 'ok  ' : 'FAIL'} ${label}`)
}

check({ args: ['help'], code: 0, stdout: /idp-agent graph/ })
check({ args: ['graph', '--env', 'prod'], code: 0, stdout: /billing-db-prod/ })
check({ args: ['show', 'billing-db-prod'], code: 0, stdout: /reached by services/ })
check({ args: ['show', 'billing-api'], code: 0, stdout: /billing-api-billing-db-prod/ })
check({ args: ['show', 'no-such-entity'], code: 1, stdout: /No entity named/ })
check({ args: ['graph', '--env', 'nowhere'], code: 1 })
check({ args: ['graph', '--wat', 'x'], code: 2 })
check({ args: ['nope'], code: 2 })

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke failure(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`\n8 smoke checks passed against ${path.relative(process.cwd(), BIN)}`)
