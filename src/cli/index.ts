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
import type { CommandResult } from './commands/result.js'

export type Command =
  | { name: 'graph'; options: GraphOptions }
  | { name: 'show'; query: string }
  | { name: 'ask'; intent: string }
  | { name: 'help' }
  | { name: 'error'; message: string }

const HELP = `idp-agent - read-only view of the service catalogue

  idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource]
  idp-agent show <name-or-reference>
  idp-agent ask "<question>"     needs IDP_PROVIDER and IDP_MODEL
`

export function parseArguments(argv: string[]): Command {
  const [commandName, ...rest] = argv
  if (commandName === undefined || commandName === 'help' || commandName === '--help') {
    return { name: 'help' }
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

  // A scenario means a test replaying a recording: no model, no credential.
  // Without one this is a real run, which calls the model and records nothing
  // unless asked to. Replay is never the default for a real run — it would
  // send someone hunting for a recording they never made.
  const mode: ClientMode =
    deps.scenario !== undefined ? 'replay' : recording === 'record' ? 'record' : 'live'

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

  return runAsk({
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
}
