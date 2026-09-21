import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { FixtureProvider } from '../context/fixtures/index.js'
import { EntityGraph } from '../context/graph/entity-graph.js'
import { runGraph, type GraphOptions } from './commands/graph.js'
import { runShow } from './commands/show.js'

export type Command =
  | { name: 'graph'; options: GraphOptions }
  | { name: 'show'; query: string }
  | { name: 'help' }
  | { name: 'error'; message: string }

const HELP = `idp-agent - read-only view of the service catalogue

  idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource]
  idp-agent show <name-or-reference>
`

export function parseArguments(argv: string[]): Command {
  const [commandName, ...rest] = argv
  if (commandName === undefined || commandName === 'help' || commandName === '--help') {
    return { name: 'help' }
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
}

/** 0 succeeded · 1 the query resolved nothing · 2 the arguments were refused. */
export const EXIT = { ok: 0, notFound: 1, badUsage: 2 } as const

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
  const result =
    command.name === 'graph' ? runGraph(graph, command.options) : runShow(graph, command.query)
  out(`${result.text}\n`)
  // A query that resolved nothing is not a failure of the tool, but it is not a
  // success of the question either: a script must be able to tell.
  return result.found ? EXIT.ok : EXIT.notFound
}
