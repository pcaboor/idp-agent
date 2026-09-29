#!/usr/bin/env node
/**
 * Docker Compose on the demo Backstage's file, one line per call:
 * `pnpm backstage:up`, `backstage:down` and `backstage:clean` run it, and
 * `scripts/demo-backstage-docker.mjs` makes every compose call through it.
 *
 *     node scripts/backstage-compose.mjs up -d --build --wait
 *
 * Compose redraws its progress on a terminal, and piped it prints every redraw
 * as a line: dozens of `[+] Running 2/3` per call. Here it runs with
 * `--progress plain`, which never redraws, and its output is held, stdout and
 * stderr in one file, in the order compose wrote them. A call that succeeds
 * prints one line; one that fails prints everything compose printed — the
 * build's own log up to the step that failed, and compose's error — on stderr,
 * then the line saying how it exited, and exits with compose's status.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
export const COMPOSE_FILE = path.join(ROOT, 'tools/backstage/compose.yml')

/**
 * Runs `docker compose -f tools/backstage/compose.yml --progress plain <args>`
 * with `env`: its status, and everything it printed on stdout and stderr, in
 * the order it printed it (both go to one file, which is removed).
 */
function run(args, env) {
  const held = mkdtempSync(path.join(tmpdir(), 'idpa-compose-'))
  try {
    const file = path.join(held, 'output')
    const fd = openSync(file, 'w')
    let ran
    try {
      ran = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, '--progress', 'plain', ...args], {
        env,
        stdio: ['ignore', fd, fd],
      })
    } finally {
      closeSync(fd)
    }
    return { status: ran.status, signal: ran.signal, error: ran.error, output: readFileSync(file, 'utf8') }
  } finally {
    rmSync(held, { recursive: true, force: true })
  }
}

/** How a call that did not succeed ended, on stderr; the status to exit with. */
function failed(call, ran) {
  if (ran.error !== undefined) console.error(`${call}: ${ran.error.message}`)
  else console.error(`${call} exited ${ran.status ?? ran.signal}`)
  return ran.status === null || ran.status === 0 ? 1 : ran.status
}

/**
 * docker compose with `args` and `env`, and its exit status: 0 after one line
 * on stdout, anything else after compose's whole output on stderr.
 */
export function compose(args, env = process.env) {
  const call = `docker compose ${args.join(' ')}`
  const ran = run(args, env)
  if (ran.status === 0) {
    console.log(`${call}: done`)
    return 0
  }
  process.stderr.write(ran.output)
  return failed(call, ran)
}

/**
 * docker compose with `args` and `env`, for what it prints — `logs` —: its
 * whole output on stderr, or a line saying it printed nothing, and its exit
 * status, with the line saying how it exited when it failed.
 */
export function shown(args, env = process.env) {
  const call = `docker compose ${args.join(' ')}`
  const ran = run(args, env)
  process.stderr.write(ran.output === '' ? `${call} printed nothing\n` : ran.output)
  return ran.status === 0 ? 0 : failed(call, ran)
}

const invoked = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1])
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(compose(process.argv.slice(2)))
}
