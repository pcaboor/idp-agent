/**
 * The suite owns every variable that can carry a child process to GitHub
 * (stage 6 brief § 10). `offline.ts` blocks the network in THIS process; a
 * child opens its own sockets, and a developer's exported GIT_SSH_COMMAND
 * outranks every core.sshCommand, so a push test would otherwise reach the
 * real git@github.com with their own key. Applied in every worker, a scenario
 * being recorded included, as a catalogue's variables are (`shell.ts`).
 *
 *   - removed: the ways git and ssh reach a remote, gh's tokens and the two
 *     variables that point gh at another host or repository, and NO_PROXY,
 *     which would exempt a host from the closed proxy below;
 *   - HOME and GH_CONFIG_DIR moved into the run directory, one of each per
 *     worker (XDG_CONFIG_HOME is `personal.ts`'s): the developer's
 *     ~/.gitconfig, a global core.sshCommand naming an absolute path past the
 *     guard below, and gh's stored login are never read, and a test that
 *     writes under its HOME leaves another worker's empty;
 *   - every proxy variable set to a closed port on loopback, since curl reads
 *     the lower-case names and gh the upper;
 *   - GIT_CONFIG_NOSYSTEM=1 for the git the tests start themselves (the
 *     launcher removes every GIT_*, so the system file is checked instead, in
 *     `tests/unit/offline.test.ts`);
 *   - a `gh` and an `ssh` that fail loudly, first on PATH.
 *
 * Node's own NODE_USE_ENV_PROXY is removed too, and the `--use-env-proxy`
 * flag that does the same from NODE_OPTIONS: the closed proxy is for git and
 * gh, and Node reads the switch, with the proxy variables, when a process
 * starts. This worker's `fetch` was set up before this file ran, and a Node
 * process the suite starts after it sees neither form of the switch, so no
 * Node `fetch` — a recording's provider call included — is sent to the closed
 * port, and a recording shell has nothing to unset. `tests/unit/offline.test.ts` fails if
 * any of that stops being true.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const FORGE_REMOVED = [
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'NO_PROXY',
] as const
export const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const
/** The discard port on loopback: nothing listens, so a proxied request fails at once. */
export const CLOSED_PROXY = 'http://127.0.0.1:9'
/** What the guard `gh` and `ssh` exit with, so a test that started one says so. */
export const GUARD_EXIT = 97
/**
 * Node's own switch for reading the proxy variables, read when a process
 * starts, as a variable and as a flag in NODE_OPTIONS. The closed proxy is for
 * git and gh: without the switch, no Node process the suite starts sends its
 * `fetch` there.
 */
const NODE_PROXY_SWITCH = 'NODE_USE_ENV_PROXY'
const NODE_PROXY_FLAG = '--use-env-proxy'

// Compared by upper-cased name: `no_proxy` and `gh_token` are the same
// variables to the programs that read them.
const removed = new Set<string>([...FORGE_REMOVED, NODE_PROXY_SWITCH])
for (const name of Object.keys(process.env)) {
  if (removed.has(name.toUpperCase())) delete process.env[name]
}
// Rewritten word by word, and only when the flag is there: NODE_OPTIONS
// without it is left exactly as it was written.
const nodeOptions = process.env['NODE_OPTIONS']
if (nodeOptions !== undefined && nodeOptions.split(/\s+/).includes(NODE_PROXY_FLAG)) {
  process.env['NODE_OPTIONS'] = nodeOptions
    .split(/\s+/)
    .filter((word) => word !== '' && word !== NODE_PROXY_FLAG)
    .join(' ')
}
for (const name of PROXY_VARIABLES) process.env[name] = CLOSED_PROXY
process.env['HOME'] = path.join(tmpdir(), `home-${String(process.pid)}`)
process.env['GH_CONFIG_DIR'] = path.join(tmpdir(), `gh-config-${String(process.pid)}`)
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
mkdirSync(process.env['HOME'], { recursive: true })

/** One directory per worker, written once and renamed into place: two workers never race on a file. */
const guard = path.join(tmpdir(), `guard-bin-${process.pid}`)
if (!existsSync(guard)) {
  const staging = `${guard}.${Date.now()}`
  mkdirSync(staging, { recursive: true })
  for (const [program, why] of [
    ['gh', 'a test reaches gh only through the fake (tests/support/fake-gh.ts), injected as MainDeps.gh'],
    ['ssh', 'a push test reaches its bare repository through a fake ssh named by GIT_SSH_COMMAND'],
  ] as const) {
    const file = path.join(staging, program)
    writeFileSync(file, `#!/bin/sh\necho "the test suite started ${program}: ${why}" >&2\nexit ${GUARD_EXIT}\n`)
    chmodSync(file, 0o755)
  }
  renameSync(staging, guard)
}
process.env['PATH'] = `${guard}${path.delimiter}${process.env['PATH'] ?? ''}`
