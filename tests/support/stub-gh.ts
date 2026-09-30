import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * A `gh` or a `git` that records how it was started and answers what it is
 * told: the program a launcher test puts first on `PATH`, so the vector, the
 * environment and the working directory the launcher hands a child are read
 * from the child's side — a stronger proof than an alias, which only shows
 * what git hands on (stage 6 brief § 10, "one real-launcher test").
 *
 * Each call appends one JSON line to `calls.jsonl` beside the program and
 * copies its stdin to `stdin.bin`. The program is a two-line shell script that
 * `exec`s Node on `record.mjs`, so no argument passes through shell quoting.
 * `names` is every variable's name in the child's environment; `env` holds the
 * VALUES of the names `values` lists and of no other: a launcher handed
 * `process.env` passes on whatever the developer exported that it keeps, and
 * the suite's temporary directories outlive the run, so the file holds no
 * value nobody asked for. A test that asserts a variable is absent reads
 * `names`. Every file using a stub removes it with `removeStubs` in
 * `afterEach`.
 */

export interface StubOptions {
  /** The names whose values are recorded (default `PATH` and `HOME`). */
  readonly values?: readonly string[]
  /** How long the program waits before answering. */
  readonly sleepMs?: number
  /** What it prints on stdout; a gh stub prints an included `200` with `{}` by default, a git stub nothing. */
  readonly stdout?: string
  readonly stderr?: string
  /** Its exit code (default 0). */
  readonly exit?: number
}

export interface StubCall {
  readonly argv: string[]
  readonly cwd: string
  readonly names: string[]
  readonly env: Record<string, string>
}

export interface Stub {
  /** The directory the program is in: put it first on `PATH`. */
  readonly bin: string
  calls(): Promise<StubCall[]>
  /** The bytes the last call read on stdin. */
  stdin(): Promise<Buffer>
}

const GH_ANSWER = 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{}'

/** The program's body: records, then sleeps, prints and exits as told. */
const RECORDER = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const options = JSON.parse(readFileSync(path.join(dir, 'options.json'), 'utf8'))
let stdin = Buffer.alloc(0)
try { stdin = readFileSync(0) } catch {}
writeFileSync(path.join(dir, 'stdin.bin'), stdin)
const env = {}
for (const name of options.values) if (process.env[name] !== undefined) env[name] = process.env[name]
appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  names: Object.keys(process.env).sort(),
  env,
}) + '\\n')
setTimeout(() => {
  process.stdout.write(options.stdout)
  process.stderr.write(options.stderr)
  process.exitCode = options.exit
}, options.sleepMs)
`

const made: string[] = []

/** `word` as one shell word, whatever it holds: single-quoted, each `'` closed, escaped and reopened. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

async function stub(program: 'gh' | 'git', options: StubOptions): Promise<Stub> {
  const bin = await mkdtemp(path.join(tmpdir(), `idp-stub-${program}-`))
  made.push(bin)
  await writeFile(
    path.join(bin, 'options.json'),
    JSON.stringify({
      values: options.values ?? ['PATH', 'HOME'],
      sleepMs: options.sleepMs ?? 0,
      stdout: options.stdout ?? (program === 'gh' ? GH_ANSWER : ''),
      stderr: options.stderr ?? '',
      exit: options.exit ?? 0,
    }),
  )
  await writeFile(path.join(bin, 'record.mjs'), RECORDER)
  const file = path.join(bin, program)
  await writeFile(file, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(path.join(bin, 'record.mjs'))} "$@"\n`)
  await chmod(file, 0o755)
  return {
    bin,
    calls: async () => {
      const text = await readFile(path.join(bin, 'calls.jsonl'), 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as StubCall)
    },
    stdin: () => readFile(path.join(bin, 'stdin.bin')),
  }
}

/** A recording `gh`. */
export const stubGh = (options: StubOptions = {}): Promise<Stub> => stub('gh', options)

/** A recording `git`. */
export const stubGit = (options: StubOptions = {}): Promise<Stub> => stub('git', options)

/** `env` with `bin` first on its `PATH`. */
export const onPath = (bin: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...env,
  PATH: `${bin}${path.delimiter}${env['PATH'] ?? ''}`,
})

/** Removes every stub made so far. */
export async function removeStubs(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}
