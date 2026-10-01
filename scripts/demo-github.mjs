#!/usr/bin/env node
/**
 * `pnpm demo:github`: `idpa protection`'s three answers, then `plan --from …
 * --submit` to a pull request, offline, the counterpart of `pnpm
 * demo:backstage` (stage 6 brief § 10). No GitHub, no gh, no ssh, no model
 * and no key: the built binary runs against `tools/fake-gh.ts`, put first on
 * PATH as `gh`, over a clone of the demo SI whose `main` tracks
 * `git@github.com:acme/iac.git` — set with `git config`, nothing fetched —
 * and a bare repository in the scratch folder stands for GitHub's side of it,
 * which the binary's own `git push` reaches through a fake ssh named by
 * `GIT_SSH_COMMAND`.
 *
 * Every step states what it expects and the demo fails on anything else, so
 * `pnpm smoke`, which runs this script, fails with it:
 *   1. the repository has no ruleset yet: exit 1, and the ruleset to add;
 *   2. after the ruleset of docs/submitting.md: exit 0;
 *   3. gh logged out: exit 2;
 *   4. plan --from … --submit --local: exit 0, nothing pushed and gh never
 *      started;
 *   5. plan --from … --submit: exit 0, the branch pushed and pull request #1
 *      opened;
 *   6. the same again: exit 0, pull request #1 named, nothing written;
 *   7. gh logged out, the same again: exit 2, nothing written.
 *
 * What it runs cannot reach the person's GitHub: the binary's environment
 * loses every `IDP_*`, `*_API_KEY`, `GH_*`, `GITHUB_*` and `GIT_*` variable,
 * `SSH_AUTH_SOCK` and `SSH_ASKPASS`, and is given back only the fake ssh's
 * `GIT_SSH_COMMAND` and `GIT_SSH_VARIANT`; `HOME`, `XDG_CONFIG_HOME` and
 * `GH_CONFIG_DIR` point into a scratch folder of this run, removed when it
 * ends; and an `ssh` that refuses to run sits beside the fake `gh`, first on
 * PATH. The one push goes to the bare repository in that folder.
 *
 * Run after `pnpm build`. The fake is TypeScript that Node runs as it is,
 * which needs Node 22.18 or later (`scripts/type-stripping.mjs`), and it is
 * put on PATH as a shell script, which needs a POSIX system.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  console.error(`pnpm demo:github: ${refusal}, which runs tools/fake-gh.ts as it is`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.error('pnpm demo:github: it puts its fake gh on PATH as a shell script, which needs a POSIX system')
  process.exit(1)
}
if (!existsSync(BIN)) {
  console.error('dist/cli/bin.js is missing: run pnpm build first')
  process.exit(1)
}

/** Everything this run makes: the clone, the fake's state, the programs on PATH, a HOME. Removed when it ends. */
const scratch = mkdtempSync(path.join(tmpdir(), 'idp-demo-github-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// 1. The clone: the demo SI committed on main by the fixture's own git,
// isolated from the contributor's configuration, and its upstream on github.com.
const IAC = path.join(scratch, 'iac')
cpSync(path.join(ROOT, 'fixtures/si-demo'), IAC, { recursive: true })
const fixtureGit = (...args) =>
  execFileSync('git', ['-C', IAC, ...args], {
    env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'ignore',
  })
fixtureGit('init', '-q', '-b', 'main')
fixtureGit('config', 'user.name', 'demo')
fixtureGit('config', 'user.email', 'demo@idp-agent.invalid')
fixtureGit('add', '-A')
fixtureGit('commit', '-q', '-m', 'the demo catalogue')
// GitHub's side: a bare repository level with the clone's main.
const BARE = path.join(scratch, 'github.git')
fixtureGit('init', '-q', '--bare', BARE)
fixtureGit('push', '-q', BARE, 'main:refs/heads/main')
fixtureGit('remote', 'add', 'origin', 'git@github.com:acme/iac.git')
fixtureGit('config', 'branch.main.remote', 'origin')
fixtureGit('config', 'branch.main.merge', 'refs/heads/main')
/** A ref of either side, or nothing; `git -C` for the clone, `--git-dir` for the bare repository. */
const readGit = (where, ...args) => {
  const run = spawnSync('git', [...where, ...args], {
    env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  })
  return run.status === 0 ? run.stdout.trim() : ''
}
const ourBranches = (where) =>
  readGit(where, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/idp-agent/')

// 2. The programs first on PATH: the fake as gh, and an ssh that refuses.
const BIN_DIR = path.join(scratch, 'bin')
mkdirSync(BIN_DIR)
const program = (name, body) => {
  const file = path.join(BIN_DIR, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}
// Node 22 warns that type stripping is experimental; the warning is not the demo's.
// Each start of gh is counted in a file, so a step can say gh never started.
const CALLS = path.join(scratch, 'gh-calls')
program(
  'gh',
  `echo started >> "${CALLS}"\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(ROOT, 'tools/fake-gh.ts')}" "$@"`,
)
program('ssh', 'echo "pnpm demo:github started ssh, which only the fake ssh below may be" >&2\nexit 97')
// The fake ssh the push is given: whatever host it is asked for, it serves
// the bare repository, and nothing else. Not on PATH: only the push names it.
const SSH = path.join(scratch, 'fake-ssh')
writeFileSync(
  SSH,
  [
    '#!/bin/sh',
    'for last; do :; done',
    'case "$last" in',
    `  git-receive-pack*) exec git receive-pack '${BARE}' ;;`,
    `  git-upload-pack*) exec git upload-pack '${BARE}' ;;`,
    '  *) echo "fake ssh: not a git command" >&2; exit 255 ;;',
    'esac',
    '',
  ].join('\n'),
)
chmodSync(SSH, 0o755)

// 3. The binary's environment: nothing of the person's GitHub, git, ssh or models.
const STATE = path.join(scratch, 'fake-gh.json')
const REMOVED = /^(?:IDP_|GH_|GITHUB_|GIT_)|_API_KEY$|^SSH_AUTH_SOCK$|^SSH_ASKPASS$/i
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !REMOVED.test(name)))
// Named once more, for whoever reads this for where a GitHub token goes: nowhere.
delete environment['GH_TOKEN']
delete environment['GITHUB_TOKEN']
Object.assign(environment, {
  HOME: path.join(scratch, 'home'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'),
  XDG_CACHE_HOME: path.join(scratch, 'cache'),
  GH_CONFIG_DIR: path.join(scratch, 'gh-config'),
  PATH: `${BIN_DIR}${path.delimiter}${process.env['PATH'] ?? ''}`,
  FAKE_GH_STATE: STATE,
  // The push's way to the bare repository: the two variables of § 5 git keeps.
  GIT_SSH_COMMAND: SSH,
  GIT_SSH_VARIANT: 'simple',
})
mkdirSync(environment.HOME)

// The URL the push will name, read as the binary's git reads it — every GIT_*
// removed, so the system file is read too — must be the one the fake ssh
// serves: a system `url."https://github.com/".insteadOf git@github.com:`
// would send the push, and this machine's credential helper, to the real
// GitHub (tests/support/github-fixture.ts holds the suite to the same).
const pushUrl = spawnSync('git', ['-C', IAC, 'remote', 'get-url', '--push', 'origin'], {
  env: Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name))),
  encoding: 'utf8',
})
if (pushUrl.status !== 0 || pushUrl.stdout.trim() !== 'git@github.com:acme/iac.git') {
  console.error(
    "this machine's git configuration rewrites git@github.com:acme/iac.git (git config --system --list says where): " +
      'the demo would push somewhere else, and does not run',
  )
  process.exit(1)
}

/** The fake GitHub: gh 2.40.0, the person `ada` — logged in unless `loggedIn` is false — and `acme/iac` as `repository` says, its refs the bare repository's. */
const world = (repository, loggedIn = true) => ({
  installed: true,
  version: '2.40.0',
  accounts: [{ login: 'ada', type: 'User' }],
  ...(loggedIn ? { session: { login: 'ada' } } : {}),
  repositories: [
    {
      owner: 'acme',
      name: 'iac',
      archived: false,
      permissions: { ada: { admin: false, maintain: false, push: true } },
      branches: { main: { protected: false } },
      rulesets: [],
      bare: BARE,
      ...repository,
    },
  ],
})

/** The ruleset docs/submitting.md asks for, as GitHub lists it; `ada` administers the repository. */
const PROTECTED = {
  permissions: { ada: { admin: true, maintain: false, push: true } },
  rulesets: [
    {
      id: 1,
      enforcement: 'active',
      branches: ['main'],
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: true,
            required_review_thread_resolution: false,
          },
        },
        { type: 'non_fast_forward' },
        { type: 'deletion' },
      ],
      bypass: [],
    },
  ],
}

let failed = false

/** What the fake holds now, as its file says. */
const fakeState = () => JSON.parse(readFileSync(STATE, 'utf8'))

/**
 * One step: the world the fake answers from (or, absent, the one the last
 * step left), what it expects, the command as a person types it, what it
 * printed, its exit checked, then each `check` — a sentence, and whether it
 * holds.
 */
function step(title, { state, expects, args, expected, checks = () => [] }) {
  if (state !== undefined) writeFileSync(STATE, JSON.stringify(state))
  console.log(`\n${bold(title)}`)
  console.log(`expects exit ${expected}: ${expects}`)
  // A file of this repository is shown as a person in it would type it.
  const typed = args.map((arg) => (arg.startsWith(`${ROOT}${path.sep}`) ? path.relative(ROOT, arg) : arg))
  console.log(`$ node dist/cli/bin.js ${typed.join(' ')}`)
  const run = spawnSync(process.execPath, [BIN, ...args], {
    cwd: scratch,
    env: environment,
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
  for (const [said, holds] of checks(run)) {
    if (holds) continue
    console.log(`(this step expects ${said})`)
    failed = true
  }
}

const PROTECTION = ['protection', '--repo', 'iac']
const SUBMIT = ['plan', '--from', path.join(ROOT, 'examples/open-network.json'), '--repo', 'iac', '--submit']
const CLONE = ['-C', IAC]
const GITHUB = ['--git-dir', BARE]

step('1. The repository has no ruleset yet', { state: world({}), expects: 'the ruleset to add', args: PROTECTION, expected: 1 })
step('2. After the ruleset of docs/submitting.md', { state: world(PROTECTED), expects: 'the rules hold', args: PROTECTION, expected: 0 })
step('3. gh logged out', { state: world(PROTECTED, false), expects: 'gh to log in', args: PROTECTION, expected: 2 })

// Steps 1 to 3 started gh; the count starts again here.
rmSync(CALLS, { force: true })
step('4. Submitted with --local: the branch stays in the clone', {
  state: world(PROTECTED),
  expects: 'the branch cut in the clone, nothing pushed, and gh never started',
  args: [...SUBMIT, '--local'],
  expected: 0,
  checks: (run) => [
    ['"--local: nothing pushed by this run"', /^--local: nothing pushed by this run$/m.test(run.stdout ?? '')],
    ['no idp-agent/ branch on GitHub', ourBranches(GITHUB) === ''],
    ['gh never started', !existsSync(CALLS)],
  ],
})
step('5. Submitted: pushed with your git, and a pull request opened with your gh', {
  expects: 'the branch pushed, and pull request #1 opened',
  args: SUBMIT,
  expected: 0,
  checks: (run) => [
    [
      "the line naming the road",
      /^submitting to github\.com\/acme\/iac, into main \(origin, main's upstream\), as ada \(gh\)$/m.test(run.stderr ?? ''),
    ],
    [
      'pull request #1, at the URL the engine built',
      /^Pull request #1 opened on github\.com\/acme\/iac: https:\/\/github\.com\/acme\/iac\/pull\/1$/m.test(run.stdout ?? ''),
    ],
    ["GitHub's branch to be the clone's", ourBranches(GITHUB) !== '' && ourBranches(GITHUB) === ourBranches(CLONE)],
    ['one pull request', (fakeState().pulls ?? []).length === 1],
  ],
})
step('6. The same again', {
  expects: 'pull request #1 named, and nothing written',
  args: SUBMIT,
  expected: 0,
  checks: (run) => [
    ['"pull request #1 is open · nothing written"', /pull request #1 is open · nothing written$/m.test(run.stdout ?? '')],
    ['still one pull request', (fakeState().pulls ?? []).length === 1],
  ],
})
const before = { clone: ourBranches(CLONE), github: ourBranches(GITHUB) }
step('7. gh logged out, the same again', {
  state: { ...fakeState(), session: undefined },
  expects: 'gh to log in, or --local, and nothing written',
  args: SUBMIT,
  expected: 2,
  checks: (run) => [
    ['"gh is not logged in to github.com"', /gh is not logged in to github\.com/.test(run.stderr ?? '')],
    [
      'nothing written',
      ourBranches(CLONE) === before.clone && ourBranches(GITHUB) === before.github && (fakeState().pulls ?? []).length === 1,
    ],
  ],
})
// The clone's main, on both sides, where it was.
if (readGit(CLONE, 'rev-parse', 'main') !== readGit(GITHUB, 'rev-parse', 'main')) {
  console.log('(main moved on one side; nothing here moves it)')
  failed = true
}

if (failed) {
  console.error('\nThe GitHub demo did not run as documented.')
  process.exit(1)
}
console.log(
  `\n${bold('Done.')} No model was called, the one push went to a bare repository in a scratch folder, and the only gh this ran was the fake.`,
)
