#!/usr/bin/env node
/**
 * `pnpm demo:github`: `idpa protection`'s three answers, offline, the
 * counterpart of `pnpm demo:backstage` (stage 6 brief § 10). No GitHub, no
 * gh, no ssh, no model and no key: the built binary runs against
 * `tools/fake-gh.ts`, put first on PATH as `gh`, over a clone of the demo SI
 * whose `main` tracks `git@github.com:acme/iac.git` — set with `git config`,
 * nothing fetched.
 *
 * Every step states what it expects and the demo fails on anything else, so
 * `pnpm smoke`, which runs this script, fails with it:
 *   1. the repository has no ruleset yet: exit 1, and the ruleset to add;
 *   2. after the ruleset of docs/submitting.md: exit 0;
 *   3. gh logged out: exit 2.
 *
 * What it runs cannot reach the person's GitHub: the binary's environment
 * loses every `IDP_*`, `*_API_KEY`, `GH_*`, `GITHUB_*` and `GIT_*` variable,
 * `SSH_AUTH_SOCK` and `SSH_ASKPASS`; `HOME`, `XDG_CONFIG_HOME` and
 * `GH_CONFIG_DIR` point into a scratch folder of this run, removed when it
 * ends; and an `ssh` that refuses to run sits beside the fake `gh`, first on
 * PATH. Nothing is pushed: this step of stage 6 pushes nothing at all.
 *
 * Run after `pnpm build`. The fake is TypeScript that Node runs as it is,
 * which needs Node 22.18 or later (`scripts/type-stripping.mjs`), and it is
 * put on PATH as a shell script, which needs a POSIX system.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
fixtureGit('remote', 'add', 'origin', 'git@github.com:acme/iac.git')
fixtureGit('config', 'branch.main.remote', 'origin')
fixtureGit('config', 'branch.main.merge', 'refs/heads/main')

// 2. The programs first on PATH: the fake as gh, and an ssh that refuses.
const BIN_DIR = path.join(scratch, 'bin')
mkdirSync(BIN_DIR)
const program = (name, body) => {
  const file = path.join(BIN_DIR, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}
// Node 22 warns that type stripping is experimental; the warning is not the demo's.
program('gh', `exec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(ROOT, 'tools/fake-gh.ts')}" "$@"`)
program('ssh', 'echo "pnpm demo:github started ssh, and it pushes nothing" >&2\nexit 97')

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
})
mkdirSync(environment.HOME)

/** The fake GitHub: gh 2.40.0, the person `ada` — logged in unless `loggedIn` is false — and `acme/iac` as `repository` says. */
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

/** One step: the world the fake answers from, the command as a person types it, what it printed, its exit checked. */
function step(title, state, expected) {
  writeFileSync(STATE, JSON.stringify(state))
  console.log(`\n${bold(title)}`)
  console.log('$ node dist/cli/bin.js protection --repo iac')
  const run = spawnSync(process.execPath, [BIN, 'protection', '--repo', 'iac'], {
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
}

step('1. The repository has no ruleset yet', world({}), 1)
step('2. After the ruleset of docs/submitting.md', world(PROTECTED), 0)
step('3. gh logged out', world(PROTECTED, false), 2)

if (failed) {
  console.error('\nThe GitHub demo did not run as documented.')
  process.exit(1)
}
console.log(`\n${bold('Done.')} No model was called, nothing was pushed, and the only gh this ran was the fake.`)
