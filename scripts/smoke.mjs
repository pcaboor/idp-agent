#!/usr/bin/env node
/**
 * Runs the packaged binary, which the unit suite never does: it imports the
 * modules instead. What only breaks here is the shape of the package — `bin.js`
 * resolves the fixture SI from `import.meta.url`, so a layout change, a missing
 * `files` entry or a bad `bin` mapping passes every test and ships broken.
 *
 * The binary is the one in the TARBALL, `npm pack`ed and extracted outside the
 * clone, never the clone's own `dist/`: run from there, taking `fixtures` out of
 * `files` left every check green, because the clone still had the folder the
 * package did not (review, build-ci-2).
 *
 * Run after `pnpm build`. No network beyond a loopback fake it starts itself
 * (`pnpm demo:backstage`), no API key, no Docker.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strippingRefusal } from './type-stripping.mjs'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')

// Deliberately not the repository root: the binary must find the fixture SI
// from its own location, not from wherever the user happens to stand.
const ELSEWHERE = mkdtempSync(path.join(tmpdir(), 'idp-agent-smoke-'))
// Where the tarball is packed and extracted. Apart from ELSEWHERE, which the
// checks below hash to prove the binary wrote nothing where it ran.
const INSTALLED = mkdtempSync(path.join(tmpdir(), 'idp-agent-package-'))

/**
 * Removed at the end of the run, and on the way out of one that threw: a smoke
 * run used to leave its directory behind every time, and those piled up with
 * the suite's until a disk filled. On that second path the error that ended
 * the run is the report; a failed removal is said alongside it, never instead.
 */
const removeElsewhere = () => {
  rmSync(ELSEWHERE, { recursive: true, force: true })
  rmSync(INSTALLED, { recursive: true, force: true })
}
process.on('exit', () => {
  try {
    removeElsewhere()
  } catch (error) {
    console.error(`could not remove ${ELSEWHERE} or ${INSTALLED}: ${error.message}`)
  }
})

/**
 * The package as a registry would hand it over: `npm pack`, then the tarball
 * extracted, then its `dependencies` — those alone, not the devDependencies —
 * linked from the clone's install, since a smoke run reaches no network. A
 * module the binary imports that the package does not declare, or a file it
 * reads that `files` leaves out, fails here.
 *
 * `--ignore-scripts`: `prepack` runs this script, and this script packs.
 * `--dry-run=false`: under `npm pack --dry-run`, the `prepack` that runs this
 * inherits `npm_config_dry_run`, and the pack below then wrote no tarball to
 * extract. A flag outranks the environment, so the rest of it is kept — an
 * `npm_config_cache` or `npm_config_offline` someone set on purpose included —
 * and `--no-update-notifier` keeps npm from asking the registry for its own
 * latest version.
 */
const [packed] = JSON.parse(
  execFileSync(
    'npm',
    [
      'pack',
      '--json',
      '--ignore-scripts',
      '--dry-run=false',
      '--no-update-notifier',
      '--pack-destination',
      INSTALLED,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // npm is npm.cmd on Windows, which only a shell runs.
      shell: process.platform === 'win32',
    },
  ),
)
execFileSync('tar', ['-xzf', packed.filename], { cwd: INSTALLED, stdio: 'ignore' })
const PACKAGE = path.join(INSTALLED, 'package')
const MANIFEST = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'))
for (const dependency of Object.keys(MANIFEST.dependencies ?? {})) {
  const link = path.join(PACKAGE, 'node_modules', dependency)
  mkdirSync(path.dirname(link), { recursive: true })
  // A junction on Windows, which needs no privilege; the type is ignored elsewhere.
  symlinkSync(path.join(ROOT, 'node_modules', dependency), link, 'junction')
}
const BIN = path.join(PACKAGE, MANIFEST.bin['idp-agent'])

/**
 * Whatever the contributor has exported, the binary must behave the same here
 * as it does in CI. An IDP_PROVIDER left in a shell would silently flip the
 * "no model configured" checks from a refusal to a live API call, and an
 * IDP_REPO — dropped with the rest of IDP_ — or a personal
 * `~/.config/idp-agent/config.yml` would make every check that expects the
 * demo SI read the contributor's own repository instead. XDG_CONFIG_HOME is
 * the first place the binary looks for that file, on every platform, so
 * pointing it inside ELSEWHERE, where none is until a check below writes one,
 * keeps HOME's out of reach.
 */
const CONFIG_HOME = path.join(ELSEWHERE, 'config')
const CLEAN_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('IDP_'))),
  XDG_CONFIG_HOME: CONFIG_HOME,
  // Where the binary keeps a catalogue read: a folder no one makes, which the
  // store makes one name deep, so no smoke run writes under the contributor's
  // ~/.cache. `pnpm demo:backstage` sets its own.
  XDG_CACHE_HOME: path.join(ELSEWHERE, 'cache'),
}

const failures = []
// Counted, never written down. The total was a literal, it had drifted from the
// number of checks, and a smoke run that miscounts its own checks is the one
// thing this script may not do.
let checks = 0

/**
 * `absentFromStdout` / `absentFromStderr` say where something must NOT be: a
 * line meant for a person has to stay out of the stream that gets piped.
 *
 * `cwd` is where the binary runs, ELSEWHERE unless a check is about the
 * directory the user is standing in. `env` is added to CLEAN_ENV, for a check
 * about a configured declarations repository.
 *
 * @param {{args: string[], code: number, stdout?: RegExp, stderr?: RegExp,
 *   absentFromStdout?: RegExp, absentFromStderr?: RegExp, cwd?: string,
 *   env?: Record<string, string>}} expected
 */
function check({ args, code, stdout, stderr, absentFromStdout, absentFromStderr, cwd, env }) {
  checks += 1
  const where = cwd === undefined ? '' : `(in ${path.basename(cwd)}) `
  const set = Object.keys(env ?? {})
    .map((name) => `${name}=… `)
    .join('')
  // Paths inside the clone are shown from its root, as a person would type them.
  const label = `${where}${set}idp-agent ${args.join(' ')}`.replaceAll(`${ROOT}${path.sep}`, '')
  // spawnSync, not execFileSync: the latter hands back stderr only when the
  // process fails, and a check on what a SUCCESSFUL run says on stderr — or
  // keeps off it — then passes or fails on an empty string.
  const run = spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? ELSEWHERE,
    env: { ...CLEAN_ENV, ...env },
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
 * `skipGit` leaves out the root's `.git/`: a submission legitimately writes
 * objects and one ref there, and the working tree is the claim.
 *
 * @param {string} dir @param {{skipGit?: boolean}} [options] @returns {string}
 */
function hashTree(dir, { skipGit = false } = {}) {
  const digest = createHash('sha256')
  /** @param {string} current @param {string} prefix */
  const walk = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true })
    // Sorted, so the digest is about the tree and not about the order the
    // filesystem happened to hand it over in.
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (skipGit && prefix === '' && entry.name === '.git') continue
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
// The edges of the command line (review, batch A1): help and the version by
// their usual flags, one command's usage, and a directory that is none refused
// on exit 2 before any model is chosen — so with nothing configured, the
// refusal is about the path, not about the model.
check({ args: ['--version'], code: 0, stdout: new RegExp(`^${MANIFEST.version.replaceAll('.', '\\.')}\n$`) })
check({ args: ['-h'], code: 0, stdout: /idp-agent graph/ })
check({ args: ['show', '--help'], code: 0, stdout: /^usage:\n {2}idp-agent show /, absentFromStdout: /idp-agent graph/ })
check({
  args: ['validate', '/nonexistent'],
  code: 2,
  stderr: /^\/nonexistent is not a directory; validate names the declarations repository/,
  absentFromStdout: /violations/,
})
check({
  args: ['init', '--repo', '/nonexistent'],
  code: 2,
  stderr: /^\/nonexistent is not a directory; init --repo names the application repository/,
  absentFromStderr: /no model configured/,
})
check({ args: ['graph', '--env', 'prod'], code: 0, stdout: /billing-db-prod/ })
check({ args: ['show', 'billing-db-prod'], code: 0, stdout: /reached by services/ })
check({ args: ['show', 'billing-api'], code: 0, stdout: /billing-api-billing-db-prod/ })
check({ args: ['show', 'no-such-entity'], code: 1, stdout: /No entity named/ })
// The relations of one entity, computed from the declarations: keyless, so
// with nothing configured it answers rather than refusing for want of a model.
check({
  args: ['relations', 'billing-db-prod', '--demo'],
  code: 0,
  stdout: /consumed by \(2\)[\s\S]*component:default\/billing-api +service +- +readwrite +resource:default\/billing-api-billing-db-prod \(prod\)/,
  absentFromStderr: /no model configured/,
})
check({
  args: ['relations', 'mysql-prod-01', '--impacts', '--demo'],
  code: 0,
  stdout: /mysql-prod-01 ← billing-db-prod ← reporting-billing-db-prod \(read\) ← reporting-worker/,
})
check({ args: ['relation'], code: 2, stderr: /did you mean relations\?/, absentFromStderr: /no model configured/ })
// A slip followed by a name is a phrase, and with no model the refusal says
// which keyless command it looks like.
check({
  args: ['relation', 'billing-api', '--demo'],
  code: 2,
  stderr: /no model configured[\s\S]*did you mean idpa relations\? It needs no model/,
})
// Two services neither of which depends on the other: what both reach.
check({
  args: ['relations', 'reporting-worker', '--to', 'billing-api', '--demo'],
  code: 0,
  stdout: /both depend on \(1\)\n {2}resource:default\/billing-db-prod\n/,
})
check({ args: ['graph', '--env', 'nowhere'], code: 1 })
check({ args: ['graph', '--wat', 'x'], code: 2 })
// A first word that is no command is a phrase for the Supervisor, so with
// nothing configured it is refused for want of a model; a word one slip away
// from a command is a typo, and is refused before any model is chosen.
check({ args: ['nope'], code: 2, stderr: /no model configured/ })
check({ args: ['which databases are in prod?'], code: 2, stderr: /no model configured/ })
check({
  args: ['grpah'],
  code: 2,
  stderr: /unknown command "grpah"; did you mean graph\? To ask something, write a sentence/,
  absentFromStderr: /no model configured/,
})
// With nothing configured — the state a reviewing agent who just cloned the
// repository is in — the built binary must refuse cleanly, not crash.
check({ args: ['ask', 'which databases are in prod?'], code: 2, stderr: /no model configured/ })
check({ args: ['ask'], code: 2, stderr: /needs a question/ })
// `init` and `plan "<intent>"` both reach a model now, so with nothing
// configured they must refuse for want of one — not for want of a recording,
// and not by walking a repository first.
check({ args: ['init'], code: 2, stderr: /no model configured/ })
check({
  args: ['plan', 'give billing-api access to orders-db', '--repo', path.join(ROOT, 'fixtures/si-demo')],
  code: 2,
  stderr: /no model configured/,
})
check({ args: ['plan', '--repo', '.'], code: 2, stderr: /needs an intent/ })
check({ args: ['init', 'platform', 'repo'], code: 2, stderr: /--owner/ })
check({
  args: ['init', 'platform', 'repo', '--owner', '@acme/platform'],
  code: 0,
  stdout: /wrote 13/,
  absentFromStderr: /catalog-info\.yaml/,
})
// The Backstage registration: one `catalog.locations` entry ingests the
// repository. Present at the root, a Location, and counted by `validate` in
// silence — no warning on every repository `init platform` creates.
const REGISTRATION = path.join(ELSEWHERE, 'repo', 'catalog-info.yaml')
assert(
  'init platform writes the Backstage registration at the root',
  existsSync(REGISTRATION) && /^kind: Location$/m.test(readFileSync(REGISTRATION, 'utf8')),
  `${REGISTRATION} is missing or is not a kind: Location`,
)
check({ args: ['validate', 'repo'], code: 0, stdout: /0 violations/, absentFromStdout: /warning|error/ })

// `plan --from` against the repository the two checks above just scaffolded and
// validated, using the plans that ship with the project. No model is involved and
// none can be — the whole point of the file form — so this is the one
// agent-adjacent path the built binary can be driven down with nothing
// configured.
//
// The example is resolved from this script's own location, not from the working
// directory: the binary runs in ELSEWHERE, and `examples/` is not packaged.
const PREVIEWED = path.join(ELSEWHERE, 'repo')
const untouched = hashTree(PREVIEWED)
// ELSEWHERE as well, not just the repository inside it. The binary RUNS in
// ELSEWHERE, so a command writing into its own working directory — a stray
// log, a cache, a lockfile — passed a check named "writes nothing" while
// hashing only the directory the diff was about.
const cwdUntouched = hashTree(ELSEWHERE)

// Every example against both repositories `examples/README.md` names, with
// the exit code and the outcome its table states — read from the table, so the
// page a newcomer follows cannot drift from the binary again: it once announced
// a diff and exit 0 for `add-access.json`, which exits 3 outside a terminal.
// Nobody is at this keyboard — stdin is not a TTY in a smoke run, exactly as in
// CI — so a question is printed and the preview withheld. A file in examples/
// with no row, or a row naming no file, fails too.
const DEMO_SI = path.join(ROOT, 'fixtures/si-demo')
const demoUntouched = hashTree(DEMO_SI)
const OUTCOMES = {
  diff: { stdout: /^\+\+\+ b\/[\s\S]*^\d+ files? · nothing written$/m },
  'nothing to change': { stdout: /^nothing to change/m, absentFromStdout: /^\+\+\+ /m },
  question: { stdout: /^\d+ questions?, asked rather than guessed:/m, absentFromStdout: /^\+\+\+ /m },
  refused: { stdout: /policy violation/, absentFromStdout: /^\+\+\+ /m },
}
const table = readFileSync(path.join(ROOT, 'examples/README.md'), 'utf8')
const rows = [...table.matchAll(/^\| `([\w-]+\.json)` \|[^|]*\| (\d) · ([a-z ]+) \| (\d) · ([a-z ]+) \|$/gm)]
const onDisk = readdirSync(path.join(ROOT, 'examples')).filter((name) => name.endsWith('.json')).sort()
assert(
  'examples/README.md has one row per example file',
  JSON.stringify(rows.map((row) => row[1]).sort()) === JSON.stringify(onDisk),
  `examples/README.md rows ${rows.map((row) => row[1]).join(', ')} do not match examples/ ${onDisk.join(', ')}`,
)
for (const [, file, freshCode, freshOutcome, demoCode, demoOutcome] of rows) {
  for (const [repo, code, outcome] of [
    ['repo', freshCode, freshOutcome],
    [DEMO_SI, demoCode, demoOutcome],
  ]) {
    const expected = OUTCOMES[outcome]
    if (expected === undefined) {
      assert(`${file}: outcome "${outcome}"`, false, `examples/README.md: unknown outcome "${outcome}" for ${file}`)
      continue
    }
    check({
      args: ['plan', '--from', path.join(ROOT, 'examples', file), '--repo', repo],
      code: Number(code),
      ...expected,
    })
  }
}

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

assert(
  'plan --from left the demo SI byte for byte',
  hashTree(DEMO_SI) === demoUntouched,
  'plan --from changed fixtures/si-demo; stage 4 writes nothing',
)

// Stage 5: --submit, against a CLONE — a copy of the demo SI committed on
// main, where open-network.json ends on a diff with nobody at the keyboard.
// The binary is the one that must cut the branch; git here only builds the
// fixture, isolated from the contributor's configuration. No TTY: --submit is
// the whole confirmation, as in CI.
const SUBMITTED = path.join(ELSEWHERE, 'submitted')
cpSync(DEMO_SI, SUBMITTED, { recursive: true })
const fixtureGit = (...args) =>
  execFileSync('git', ['-C', SUBMITTED, ...args], {
    env: { ...CLEAN_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim()
fixtureGit('init', '-q', '-b', 'main')
fixtureGit('config', 'user.name', 'smoke')
fixtureGit('config', 'user.email', 'smoke@idp-agent.invalid')
fixtureGit('add', '-A')
fixtureGit('commit', '-q', '-m', 'base')
const mainBefore = fixtureGit('rev-parse', 'main')
const worktreeBefore = hashTree(SUBMITTED, { skipGit: true })
const OPEN_NETWORK = path.join(ROOT, 'examples/open-network.json')

check({
  args: ['plan', '--from', OPEN_NETWORK, '--repo', 'submitted', '--submit'],
  code: 0,
  stdout: /^1 file · submitted as idp-agent\/[a-z0-9-]+-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched$/m,
})
check({
  args: ['plan', '--from', OPEN_NETWORK, '--repo', 'submitted', '--submit'],
  code: 0,
  stdout: /^1 file · already submitted as idp-agent\/[a-z0-9-]+-[0-9a-f]{8} · nothing written$/m,
})
assert('--submit left main where it was', fixtureGit('rev-parse', 'main') === mainBefore, '--submit moved main')
assert(
  '--submit left the working tree byte for byte',
  hashTree(SUBMITTED, { skipGit: true }) === worktreeBefore,
  '--submit wrote into the working tree',
)
assert(
  '--submit cut exactly one branch, and a second run none',
  fixtureGit('for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/').split('\n').filter(Boolean).length === 1,
  '--submit cut no branch, or more than one',
)
check({ args: ['plan', '--from', OPEN_NETWORK, '--repo', 'repo', '--submit'], code: 2, stderr: /not a git working tree/ })
// The intent road with no model configured, as here: a directory that cannot
// take a branch is refused before the configuration is, so the answer is about
// the repository and no model could have been called. Over a clone, the forge
// opens and the refusal is the configuration's — and nothing is written.
const INTENT = 'declare the database orders-db-prod in prod'
check({
  args: ['plan', INTENT, '--repo', 'repo', '--submit'],
  code: 2,
  stderr: /not a git working tree/,
  absentFromStderr: /no model configured/,
})
check({ args: ['plan', INTENT, '--repo', 'submitted', '--submit'], code: 2, stderr: /no model configured/ })
assert(
  'plan "<intent>" --submit with no model cut nothing',
  fixtureGit('for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/').split('\n').filter(Boolean).length === 1 &&
    fixtureGit('rev-parse', 'main') === mainBefore,
  'plan "<intent>" --submit with no model moved a ref',
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

// No --repo, standing in a declarations repository as `init platform` writes
// one, with one entity the demo SI does not declare: it is read, and named by
// its folder, and the demo line is not printed. A copy of the scaffolded one,
// which the hashes above say must stay as it was.
const STANDING = path.join(ELSEWHERE, 'IaC')
cpSync(PREVIEWED, STANDING, { recursive: true })
writeFileSync(
  path.join(STANDING, 'catalog/databases/ledger-db-prod.yml'),
  '---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: ledger-db-prod\n' +
    'spec:\n  type: database\n  owner: group:default/tiger\n',
)
check({
  args: ['show', 'ledger-db-prod'],
  cwd: STANDING,
  code: 0,
  stdout: /resource:default\/ledger-db-prod/,
  stderr: /^reading the declarations repository IaC \(the current directory\)/,
  absentFromStderr: DEMO,
})

// The same repository from anywhere, configured once rather than stood in:
// IDP_REPO, then `repo` in the personal configuration file. Each says so in
// its one line, naming the folder and what named it; `plan` takes the same
// default and no longer needs --repo.
check({
  args: ['show', 'ledger-db-prod'],
  env: { IDP_REPO: STANDING },
  code: 0,
  stdout: /resource:default\/ledger-db-prod/,
  stderr: /^reading the declarations repository IaC \(IDP_REPO\)/,
  absentFromStderr: DEMO,
})
check({
  args: ['graph'],
  env: { IDP_REPO: path.join(ELSEWHERE, 'missing') },
  code: 2,
  stderr: /IDP_REPO=.*missing is not a directory/,
})
// Relative is refused: a default set once names one repository from everywhere.
check({ args: ['graph'], env: { IDP_REPO: 'IaC' }, code: 2, stderr: /IDP_REPO=IaC is relative/ })
// Relative to the file's own directory, ELSEWHERE/config/idp-agent: ../../IaC is
// the repository above, wherever the binary runs.
mkdirSync(path.join(CONFIG_HOME, 'idp-agent'), { recursive: true })
writeFileSync(path.join(CONFIG_HOME, 'idp-agent', 'config.yml'), 'repo: ../../IaC\n')
check({
  args: ['show', 'ledger-db-prod'],
  code: 0,
  stdout: /resource:default\/ledger-db-prod/,
  stderr: /^reading the declarations repository IaC \(.*config\.yml\)/,
  absentFromStderr: DEMO,
})
// Decided against IaC, and asked: the database's environment is named only in
// words, which state none, and nobody is at this keyboard.
check({
  args: ['plan', '--from', path.join(ROOT, 'examples/declare-database.json')],
  code: 3,
  stdout: /^1 question, asked rather than guessed:[\s\S]*operations\.0\.entity\.metadata\.env/m,
  stderr: /^reading the declarations repository IaC \(.*config\.yml\)/,
})
// Removed again: every check below expects nothing configured.
rmSync(CONFIG_HOME, { recursive: true, force: true })
// And with nothing configured, plan says every way of naming one.
check({
  args: ['plan', '--from', path.join(ROOT, 'examples/declare-database.json')],
  code: 2,
  stderr:
    /^plan needs a declarations repository: --repo <directory>, the current directory when it is one, or IDP_REPO or repo in .*config\.yml/,
})
// The owner's run: `plan "<intent>"` typed from inside his declarations
// repository. It is the repository the preview is decided against, and it is
// no service's, so the Inspector is skipped and said to be — before the
// missing model is, because that line walks nothing and needs no model.
check({
  args: ['plan', 'give billing-api read access to the orders database in prod', '--repo', '.'],
  cwd: STANDING,
  code: 2,
  stderr:
    /no application repository in the current directory \(IaC is a declarations repository\)[\s\S]*no model configured/,
})
// And the one gesture from there, with nothing configured: IaC is found where
// the user stands, and the phrase needs a model to be classified.
check({
  args: ['give billing-api read access to the orders database in prod'],
  cwd: STANDING,
  code: 2,
  stderr: /^reading the declarations repository IaC \(the current directory\)[\s\S]*no model configured/,
})

// A repository that was already wrong before the plan, as a real one usually
// is: one document the reader rejects, in a file the plan never touches. The
// re-check refused every plan over it; it is counted in one line now, and the
// plan is previewed. A copy of the demo SI, where `open-network.json` points at
// a declaration and so needs nobody to answer its environment: on a scaffolded
// repository it would point at nothing, and stop at the question.
cpSync(path.join(ROOT, 'fixtures/si-demo'), path.join(ELSEWHERE, 'untidy'), { recursive: true })
writeFileSync(
  path.join(ELSEWHERE, 'untidy/catalog/databases/legacy.yml'),
  '---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: legacy\n',
)
check({
  args: ['plan', '--from', path.join(ROOT, 'examples/open-network.json'), '--repo', 'untidy'],
  code: 0,
  stdout:
    /1 error already in the repository, in files this plan does not touch[\s\S]*\+\+\+ b\/dependencies\/network\/orders-api-to-payments\.yml/,
})

// A declarations repository that is also the company's Backstage catalogue: a
// Group beside the entities is read and counted, and one Backstage would
// refuse is set aside with a warning, never refused — the generated CI runs
// exactly this, and a red build here would push people to move their Groups
// out.
const CATALOGUE = path.join(ELSEWHERE, 'catalogue')
cpSync(path.join(ROOT, 'fixtures/si-demo'), CATALOGUE, { recursive: true })
mkdirSync(path.join(CATALOGUE, 'org'), { recursive: true })
writeFileSync(
  path.join(CATALOGUE, 'org/tiger.yml'),
  '---\napiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata:\n  name: tiger\nspec:\n  type: team\n  children: []\n',
)
check({
  args: ['validate', 'catalogue'],
  code: 0,
  stdout: /^34 entities in 34 files, 0 violations$/m,
})
writeFileSync(
  path.join(CATALOGUE, 'org/lonely.yml'),
  '---\napiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata:\n  name: lonely\nspec:\n  type: team\n',
)
check({
  args: ['validate', 'catalogue'],
  code: 0,
  stdout:
    /^warning org\/lonely\.yml: Group lonely is not read: spec\.children: required, which Backstage requires\n\n34 entities in 35 files, 0 violations$/m,
})

// `pnpm demo`, the tour the README points a newcomer at: run to the end with
// nothing configured, every step at the exit code it states, and the demo SI
// hashed around the preview. It once stopped at its second step under
// `set -e`, and nothing ran it.
{
  checks += 1
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/demo.mjs')], {
    cwd: ELSEWHERE,
    env: CLEAN_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = run.stdout ?? ''
  const before = failures.length
  if (run.status !== 0) failures.push(`pnpm demo: expected exit 0, got ${run.status}\n${run.stderr}`)
  for (const shown of [
    /^impacts \(9\)$/m,
    /^component:default\/billing-api$/m,
    /^\+\+\+ b\/dependencies\/network\/orders-api-to-payments\.yml$/m,
    /^unchanged: same files, same bytes, same folders$/m,
    /^2 questions, asked rather than guessed:$[\s\S]*^\(exit 3\)$/m,
    /^Done\. No model was called/m,
  ]) {
    if (!shown.test(out)) failures.push(`pnpm demo: stdout ${shown}`)
  }
  console.log(`  ${failures.length === before ? 'ok  ' : 'FAIL'} pnpm demo`)
}

// `pnpm demo:backstage`: the same relations read from a fake Backstage the
// script starts on 127.0.0.1, on a port the system chooses so two runs never
// collide, and stops. The fake is TypeScript Node runs as it is, which
// `engines` does not promise: where this Node cannot, the demo is skipped and
// said to be, and the smoke goes on (CI's Node 22 and 24 run it).
//
// It runs with a token and a URL exported, as in a shell set up for the
// company's Backstage: CLEAN_ENV drops every IDP_ name, so without them the
// demo's removal of the token would never run here. The token holds a newline,
// which no header carries: a step handed it is refused before any request
// (exit 2), and a step handed the URL reads a host that does not exist.
{
  const refusal = strippingRefusal()
  if (refusal !== undefined) {
    console.log(`  skipped pnpm demo:backstage: ${refusal}`)
  } else {
    checks += 1
    const DEMO_TOKEN = 'smoke-demo-token\nno header carries this'
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/demo-backstage.mjs')], {
      cwd: ELSEWHERE,
      env: {
        ...CLEAN_ENV,
        IDP_BACKSTAGE_TOKEN: DEMO_TOKEN,
        IDP_BACKSTAGE_URL: 'https://example.invalid/api/catalog',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    const out = run.stdout ?? ''
    const before = failures.length
    if (run.status !== 0) {
      failures.push(`pnpm demo:backstage: expected exit 0, got ${run.status}\n${run.stderr}`)
    }
    if (`${out}${run.stderr ?? ''}`.includes('smoke-demo-token')) {
      failures.push('pnpm demo:backstage: the exported token reached its output')
    }
    for (const shown of [
      /^\$ env -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=http:\/\/127\.0\.0\.1:\d+\/api\/catalog node dist\/cli\/bin\.js relations mysql-prod-01 --impacts$/m,
      /^reading the Backstage catalogue at 127\.0\.0\.1:\d+ \(IDP_BACKSTAGE_URL\): 40 entities: 40 read, 0 not modelled;/m,
      // The second read answered from the copy the first kept: bin.ts hands the
      // cache root in, and smoke fails if the second read reaches the fake.
      /^reading the Backstage catalogue at 127\.0\.0\.1:\d+ \(IDP_BACKSTAGE_URL\): 40 entities: 40 read, 0 not modelled; read from cache, less than a minute old; --refresh reads Backstage again;/m,
      /^the fake Backstage was sent no request for the second read$/m,
      /^impacts \(9\)$/m,
      /^component:default\/billing-api$/m,
      /^\+\+\+ b\/dependencies\/network\/orders-api-to-payments\.yml$/m,
      /^the fake Backstage was sent no request while the change was previewed$/m,
      /^Done\. No model was called and no key was read; the fake Backstage is stopped\.$/m,
    ]) {
      if (!shown.test(out)) failures.push(`pnpm demo:backstage: stdout ${shown}`)
    }
    console.log(`  ${failures.length === before ? 'ok  ' : 'FAIL'} pnpm demo:backstage`)
  }
}

// The templates live outside dist/, so nothing in the suite notices if they
// are missing from the tarball — and `npx idp-agent init platform` would then
// fail on a machine that never cloned this repository. `init platform` above
// ran from the tarball; these two are the files it would miss in silence.
const shipped = packed.files.map((file) => file.path)
for (const required of ['templates/iac-repo/witness.yml', 'templates/iac-repo/gitignore']) {
  assert(
    `packaged ${required}`,
    shipped.includes(required),
    `the tarball does not carry ${required}`,
  )
}

// Nothing in dist/ that no source compiles to. `tsc` never deletes, so a
// module renamed or removed in src/ — or a probe dropped into dist/ by hand —
// stayed in every build after it, and `__before_probe.js` was packed (review,
// build-ci-3). `pnpm build` empties dist/ first now; this is the check that
// says so about what is actually packed.
const stale = shipped.filter((file) => {
  const compiled = /^dist\/(.+?)(?:\.d\.ts|\.js)$/.exec(file)
  if (compiled === null) return file.startsWith('dist/')
  return !existsSync(path.join(ROOT, 'src', `${compiled[1]}.ts`))
})
assert(
  'the tarball carries nothing in dist/ that src/ does not compile to',
  stale.length === 0,
  `stale files in the tarball, compiled from no source: ${stale.join(', ')} — run pnpm build`,
)

// Counted like any other check: the directories are gone before the verdict,
// not merely scheduled to go.
removeElsewhere()
assert(
  'the run left nothing in the temp directory',
  !existsSync(ELSEWHERE) && !existsSync(INSTALLED),
  `${ELSEWHERE} or ${INSTALLED} is still there after the run`,
)

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke failure(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`\n${checks} smoke checks passed against the packed ${packed.filename}`)
