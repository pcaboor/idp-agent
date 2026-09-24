#!/usr/bin/env node
/**
 * Runs the packaged binary, which the unit suite never does: it imports the
 * modules instead. What only breaks here is the shape of `dist` — `bin.js`
 * resolves the fixture SI from `import.meta.url`, so a layout change, a missing
 * `files` entry or a bad `bin` mapping passes every test and ships broken.
 *
 * Run after `pnpm build`. No network, no API key, no Docker.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const BIN = path.join(ROOT, 'dist/cli/bin.js')

// Deliberately not the repository root: the binary must find the fixture SI
// from its own location, not from wherever the user happens to stand.
const ELSEWHERE = mkdtempSync(path.join(tmpdir(), 'idp-agent-smoke-'))

/**
 * Whatever the contributor has exported, the binary must behave the same here
 * as it does in CI. An IDP_PROVIDER left in a shell would silently flip the
 * "no model configured" checks from a refusal to a live API call.
 */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('IDP_')),
)

const failures = []
// Counted, never written down. The total was a literal, it had drifted from the
// number of checks, and a smoke run that miscounts its own checks is the one
// thing this script may not do.
let checks = 0

/**
 * `absentFromStdout` / `absentFromStderr` say where something must NOT be: a
 * line meant for a person has to stay out of the stream that gets piped.
 *
 * @param {{args: string[], code: number, stdout?: RegExp, stderr?: RegExp,
 *   absentFromStdout?: RegExp, absentFromStderr?: RegExp}} expected
 */
function check({ args, code, stdout, stderr, absentFromStdout, absentFromStderr }) {
  checks += 1
  const label = `idp-agent ${args.join(' ')}`
  // spawnSync, not execFileSync: the latter hands back stderr only when the
  // process fails, and a check on what a SUCCESSFUL run says on stderr — or
  // keeps off it — then passes or fails on an empty string.
  const run = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ELSEWHERE,
    env: CLEAN_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const actual = run.status ?? -1
  const out = run.stdout ?? ''
  const err = run.stderr ?? ''

  const before = failures.length
  if (actual !== code) failures.push(`${label}: expected exit ${code}, got ${actual}`)
  if (stdout !== undefined && !stdout.test(out)) failures.push(`${label}: stdout ${stdout}`)
  if (stderr !== undefined && !stderr.test(err)) failures.push(`${label}: stderr ${stderr}`)
  if (absentFromStdout?.test(out)) failures.push(`${label}: stdout carries ${absentFromStdout}`)
  if (absentFromStderr?.test(err)) failures.push(`${label}: stderr carries ${absentFromStderr}`)
  console.log(`  ${failures.length === before ? 'ok  ' : 'FAIL'} ${label}`)
}

/**
 * A check that is not a process invocation, counted by the same counter. Two
 * counting disciplines is how the total drifted from the checks in the first
 * place.
 *
 * @param {string} label @param {boolean} held @param {string} failure
 */
function assert(label, held, failure) {
  checks += 1
  if (!held) failures.push(failure)
  console.log(`  ${held ? 'ok  ' : 'FAIL'} ${label}`)
}

/**
 * Every path and every byte under a directory, as one digest.
 *
 * Stage 4's whole claim is that a preview reads a repository and leaves it
 * exactly as it found it, and an exit code does not state that: a command that
 * wrote the two files its diff describes and then printed the diff exits 0 too.
 * The unit suite hashes both repositories around a run for the same reason
 * (`tests/support/tree.ts`); this is that assertion made about the SHIPPED
 * binary, which is the one thing `pnpm test` never runs.
 *
 * @param {string} dir @returns {string}
 */
function hashTree(dir) {
  const digest = createHash('sha256')
  /** @param {string} current @param {string} prefix */
  const walk = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true })
    // Sorted, so the digest is about the tree and not about the order the
    // filesystem happened to hand it over in.
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        // The directory itself, named: an emptied folder and a deleted one are
        // different facts, and a digest over file contents alone conflates them.
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

check({ args: ['help'], code: 0, stdout: /idp-agent graph/ })
check({ args: ['graph', '--env', 'prod'], code: 0, stdout: /billing-db-prod/ })
check({ args: ['show', 'billing-db-prod'], code: 0, stdout: /reached by services/ })
check({ args: ['show', 'billing-api'], code: 0, stdout: /billing-api-billing-db-prod/ })
check({ args: ['show', 'no-such-entity'], code: 1, stdout: /No entity named/ })
check({ args: ['graph', '--env', 'nowhere'], code: 1 })
check({ args: ['graph', '--wat', 'x'], code: 2 })
check({ args: ['nope'], code: 2 })
// With nothing configured — the state a reviewing agent who just cloned the
// repository is in — the built binary must refuse cleanly, not crash.
check({ args: ['ask', 'which databases are in prod?'], code: 2, stderr: /no model configured/ })
check({ args: ['ask'], code: 2, stderr: /needs a question/ })
// `init` and `plan "<intent>"` both reach a model now, so with nothing
// configured they must refuse for want of one — not for want of a recording,
// and not by walking a repository first.
check({ args: ['init'], code: 2, stderr: /no model configured/ })
check({ args: ['plan', 'give billing-api access to orders-db', '--repo', '.'], code: 2, stderr: /no model configured/ })
check({ args: ['plan', '--repo', '.'], code: 2, stderr: /needs an intent/ })
check({ args: ['init', 'platform', 'repo'], code: 2, stderr: /--owner/ })
check({ args: ['init', 'platform', 'repo', '--owner', '@acme/platform'], code: 0, stdout: /wrote 12/ })
check({ args: ['validate', 'repo'], code: 0, stdout: /0 violations/ })

// `plan --from` against the repository the two checks above just scaffolded and
// validated, using a plan that ships with the project. No model is involved and
// none can be — the whole point of the file form — so this is the one
// agent-adjacent path the built binary can be driven down with nothing
// configured.
//
// The example is resolved from this script's own location, not from the working
// directory: the binary runs in ELSEWHERE, and `examples/` is not packaged.
const PREVIEWED = path.join(ELSEWHERE, 'repo')
const EXAMPLE = path.join(ROOT, 'examples/add-access.json')
const untouched = hashTree(PREVIEWED)
// ELSEWHERE as well, not just the repository inside it. The binary RUNS in
// ELSEWHERE, so a command writing into its own working directory — a stray
// log, a cache, a lockfile — passed a check named "writes nothing" while
// hashing only the directory the diff was about.
const cwdUntouched = hashTree(ELSEWHERE)

// Exit 3, and that is the shape of a non-interactive run now: the plan
// declares a database AND a grant, and a grant's access level is asked rather
// than read out of the request. Nobody is at this keyboard — stdin is not a
// TTY in a smoke run, exactly as in CI — so the question is printed and the
// preview is withheld. A wrapper that wants a diff for a grant has to answer.
check({
  args: ['plan', '--from', EXAMPLE, '--repo', 'repo'],
  code: 3,
  stdout: /asked rather than guessed[\s\S]*spec\.access/,
})

// The diff itself, on the half of the same plan that carries no level: an
// object is not read or write, so nothing about it is a question.
check({
  args: ['plan', '--from', path.join(ROOT, 'examples/declare-database.json'), '--repo', 'repo'],
  code: 0,
  stdout: /\+\+\+ b\/catalog\/databases\/orders-db-prod\.yml[\s\S]*nothing written/,
})

// The stage's claim, and the reason the check above is not enough on its own.
assert(
  'plan --from left the repository byte for byte',
  hashTree(PREVIEWED) === untouched,
  'plan --from changed the repository it previewed against; stage 4 writes nothing',
)

assert(
  'plan --from wrote nothing into its working directory either',
  hashTree(ELSEWHERE) === cwdUntouched,
  'plan --from wrote into the directory it ran in; stage 4 writes nothing anywhere',
)

// The read commands over a declarations repository of the user's own, and the
// line that says when they are NOT reading one. A copy of the demo SI, so the
// answer is known; placed after the hashes above, which cover ELSEWHERE.
const DEMO = /demo SI/
cpSync(path.join(ROOT, 'fixtures/si-demo'), path.join(ELSEWHERE, 'declarations'), {
  recursive: true,
})
check({ args: ['graph', '--env', 'prod'], code: 0, stderr: DEMO, absentFromStdout: DEMO })
check({
  args: ['show', 'billing-db-prod', '--repo', 'declarations'],
  code: 0,
  stdout: /reached by services/,
  absentFromStderr: DEMO,
})
check({ args: ['graph', '--repo', 'missing'], code: 2, stderr: /missing is not a directory/ })

// A repository that was already wrong before the plan, as a real one usually
// is: one document the reader rejects, in a file the plan never touches. The
// re-check refused every plan over it; it is counted in one line now, and the
// plan is previewed. The scaffolded repository rather than the demo SI, which
// already declares orders-db-prod and would leave no diff to look for.
cpSync(PREVIEWED, path.join(ELSEWHERE, 'untidy'), { recursive: true })
writeFileSync(
  path.join(ELSEWHERE, 'untidy/catalog/databases/legacy.yml'),
  '---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: legacy\n',
)
check({
  args: ['plan', '--from', path.join(ROOT, 'examples/declare-database.json'), '--repo', 'untidy'],
  code: 0,
  stdout:
    /1 error already in the repository, in files this plan does not touch[\s\S]*\+\+\+ b\/catalog\/databases\/orders-db-prod\.yml/,
})

// The one check that can catch "green tests, broken package": the templates
// live outside dist/, so nothing in the suite notices if they are missing from
// the tarball — and `npx idp-agent init platform` would then fail on a machine
// that never cloned this repository.
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
)[0]

const shipped = packed.files.map((file) => file.path)
for (const required of ['templates/iac-repo/witness.yml', 'templates/iac-repo/gitignore']) {
  assert(
    `packaged ${required}`,
    shipped.includes(required),
    `the tarball does not carry ${required}`,
  )
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke failure(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`\n${checks} smoke checks passed against ${path.relative(process.cwd(), BIN)}`)
