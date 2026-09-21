import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { FixtureProvider } from '../context/fixtures/index.js'
import { PLAN_LIMITS } from '../core/schemas/plan.js'
import { NoModelConfiguredError, chooseModel } from '../llm/providers.js'
import { openRecording, resolveMode } from '../llm/recording.js'
import { createClient, type ClientMode } from '../llm/runtime.js'
import { fileRecordingStore } from './recording-fs.js'
import { runAsk } from './commands/ask.js'
import type { AgentEvent } from '../agents/events.js'
import { EntityGraph } from '../context/graph/entity-graph.js'
import { runGraph, type GraphOptions } from './commands/graph.js'
import { runShow } from './commands/show.js'
import { runValidate } from './commands/validate.js'
import { INIT_DEFERRED, runInit, runInitPlatform } from './commands/init.js'
import { isForgeHandle } from '../scaffold/codeowners.js'
import { assertInsideRepo } from '../core/paths/entity-path.js'
import { VERSION } from '../core/index.js'
import type { CommandResult } from './commands/result.js'

export type Command =
  | { name: 'graph'; options: GraphOptions }
  | { name: 'show'; query: string }
  | { name: 'ask'; intent: string }
  | { name: 'validate'; directory: string }
  | { name: 'init-platform'; directory: string; owner: string }
  | { name: 'init' }
  | { name: 'help' }
  | { name: 'error'; message: string }

const HELP = `idp-agent - read-only view of the service catalogue

  idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource]
  idp-agent show <name-or-reference>
  idp-agent ask "<question>"     needs IDP_PROVIDER and IDP_MODEL
  idp-agent validate <directory>
  idp-agent init platform <directory> --owner @org/team
`

export function parseArguments(argv: string[]): Command {
  const [commandName, ...rest] = argv
  if (commandName === undefined || commandName === 'help' || commandName === '--help') {
    return { name: 'help' }
  }

  if (commandName === 'init') {
    if (rest[0] !== 'platform') return { name: 'init' }
    try {
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        options: { owner: { type: 'string' } },
        allowPositionals: true,
        strict: true,
      })
      const directory = positionals[0]
      if (directory === undefined) {
        return { name: 'error', message: 'init platform needs a directory' }
      }
      const owner = values.owner
      if (owner === undefined) {
        return {
          name: 'error',
          message: 'init platform needs --owner, e.g. --owner @acme/platform',
        }
      }
      if (!isForgeHandle(owner)) {
        return {
          name: 'error',
          message: `"${owner}" is not a forge handle; CODEOWNERS wants @user or @org/team, not an entity owner reference`,
        }
      }
      return { name: 'init-platform', directory, owner }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  if (commandName === 'validate') {
    const directory = rest[0]
    if (directory === undefined) return { name: 'error', message: 'validate needs a directory' }
    return { name: 'validate', directory }
  }

  if (commandName === 'ask') {
    const intent = rest.join(' ').trim()
    if (intent === '') return { name: 'error', message: 'ask needs a question' }
    if (intent.length > PLAN_LIMITS.maxIntentLength) {
      return { name: 'error', message: `a question is limited to ${PLAN_LIMITS.maxIntentLength} characters` }
    }
    return { name: 'ask', intent }
  }

  if (commandName === 'show') {
    const query = rest[0]
    if (query === undefined) return { name: 'error', message: 'show needs a name or a reference' }
    return { name: 'show', query }
  }

  if (commandName === 'graph') {
    try {
      const { values } = parseArgs({
        args: rest,
        options: {
          env: { type: 'string' },
          type: { type: 'string' },
          kind: { type: 'string' },
        },
        strict: true,
      })
      const kind = values.kind
      if (kind !== undefined && kind !== 'Component' && kind !== 'Resource') {
        return { name: 'error', message: 'kind must be Component or Resource' }
      }
      return {
        name: 'graph',
        options: {
          ...(values.env !== undefined ? { env: values.env } : {}),
          ...(values.type !== undefined ? { type: values.type } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
      }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  return { name: 'error', message: `unknown command "${commandName}"` }
}

/**
 * What main writes to and reads from. Injected so the command is tested without
 * a process, and against a catalogue other than the fixture SI.
 */
export interface MainDeps {
  root?: string
  /** Where a relative directory argument is resolved from. Injected for tests. */
  cwd?: string
  out?: (chunk: string) => void
  err?: (chunk: string) => void
  /** Injected so a test never reads the real environment. */
  env?: Record<string, string | undefined>
  recordingDir?: string
  scenario?: string
  events?: (event: AgentEvent) => void
}

/**
 * 0 succeeded · 1 the query resolved nothing · 2 the arguments were refused ·
 * 3 the request was understood and this build will not act on it.
 */
export const EXIT = { ok: 0, notFound: 1, badUsage: 2, unsupported: 3 } as const

const DEFAULT_RECORDINGS = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../tests/recordings',
)

const DEFAULT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../fixtures/si-demo')

/** Returns the exit code rather than calling process.exit, so it is testable. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? ((chunk: string): void => void process.stdout.write(chunk))
  const err = deps.err ?? ((chunk: string): void => void process.stderr.write(chunk))
  const command = parseArguments(argv)

  if (command.name === 'help') {
    out(HELP)
    return EXIT.ok
  }
  if (command.name === 'error') {
    err(`${command.message}\n\n${HELP}`)
    return EXIT.badUsage
  }

  if (command.name === 'init') {
    err(`${INIT_DEFERRED}\n`)
    const result = runInit()
    return result.unsupported === true ? EXIT.unsupported : EXIT.ok
  }

  if (command.name === 'init-platform') {
    let root: string
    try {
      root = assertInsideRepo(deps.cwd ?? process.cwd(), command.directory)
    } catch (error) {
      err(`${error instanceof Error ? error.message : String(error)}\n`)
      return EXIT.badUsage
    }
    const result = await runInitPlatform({ root, owner: command.owner, version: VERSION })
    out(`${result.text}\n`)
    return EXIT.ok
  }

  // Reads the directory it was handed, so it must not go through the fixture
  // load every other command needs.
  if (command.name === 'validate') {
    const result = await runValidate(command.directory)
    out(`${result.text}\n`)
    return result.found ? EXIT.ok : EXIT.notFound
  }

  const { entities, rejected } = await new FixtureProvider(deps.root ?? DEFAULT_ROOT).load()
  // Reported, never dropped in silence: that silent drop is the catalogue
  // behaviour this tool exists to compensate for (design 4.4).
  for (const rejection of rejected) {
    err(`skipped ${rejection.source}: ${rejection.reason}\n`)
  }

  const graph = EntityGraph.from(entities)

  let result
  if (command.name === 'ask') {
    try {
      result = await ask(graph, command.intent, deps, err)
    } catch (error) {
      if (error instanceof NoModelConfiguredError) {
        err(`${error.message}\n`)
        return EXIT.badUsage
      }
      // Anything else is still a failure, and must not leave as exit 0 with a
      // stack trace: that is indistinguishable from success to a script.
      err(`${error instanceof Error ? error.message : String(error)}\n`)
      return EXIT.notFound
    }
  } else {
    result =
      command.name === 'graph' ? runGraph(graph, command.options) : runShow(graph, command.query)
  }

  if (result.text !== '') out(`${result.text}\n`)
  // Three outcomes, three codes: acted, asked and found nothing, or understood
  // and declined. Collapsing the last two would lose the only distinction the
  // exit codes exist to draw.
  if (result.unsupported === true) return EXIT.unsupported
  return result.found ? EXIT.ok : EXIT.notFound
}

async function ask(
  graph: EntityGraph,
  intent: string,
  deps: MainDeps,
  err: (chunk: string) => void,
): Promise<CommandResult> {
  const env = deps.env ?? process.env
  const recording = resolveMode(env['IDP_RECORDING'])

  // IDP_RECORDING=record wins: that is the one run that is meant to call a
  // model and write the turns down, scenario or not. Otherwise a scenario
  // means a test replaying a recording — no model, no credential — and no
  // scenario means a real run, which calls the model and records nothing.
  // Replay is never the default for a real run: it would send someone hunting
  // for a recording they never made.
  const mode: ClientMode =
    recording === 'record' ? 'record' : deps.scenario !== undefined ? 'replay' : 'live'

  const choice = mode === 'replay' ? undefined : chooseModel(env)
  const tape =
    mode === 'live'
      ? undefined
      : await openRecording({
          scenario: deps.scenario ?? env['IDP_SCENARIO'] ?? 'question',
          store: fileRecordingStore(deps.recordingDir ?? DEFAULT_RECORDINGS),
          mode: mode === 'record' ? 'record' : 'replay',
          warn: (message) => err(`${message}\n`),
        })

  const result = await runAsk({
    graph,
    client: createClient({
      mode,
      ...(tape !== undefined ? { tape } : {}),
      ...(choice !== undefined ? { choice } : {}),
    }),
    intent,
    emit: deps.events ?? ((): void => {}),
    err,
  })

  // Recording in memory and never writing it down is the whole run wasted,
  // and it is silent: the turns are there, the file never appears.
  if (mode === 'record' && tape !== undefined) await tape.save()

  return result
}
