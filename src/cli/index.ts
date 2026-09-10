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

/** Returns the exit code rather than calling process.exit, so it is testable. */
export async function main(argv: string[]): Promise<number> {
  const command = parseArguments(argv)

  if (command.name === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (command.name === 'error') {
    process.stderr.write(`${command.message}\n\n${HELP}`)
    return 2
  }

  const fixtures = path.resolve(fileURLToPath(import.meta.url), '../../../fixtures/si-demo')
  const { entities, rejected } = await new FixtureProvider(fixtures).load()
  for (const rejection of rejected) {
    process.stderr.write(`skipped ${rejection.source}: ${rejection.reason}\n`)
  }

  const graph = EntityGraph.from(entities)
  const output =
    command.name === 'graph' ? runGraph(graph, command.options) : runShow(graph, command.query)
  process.stdout.write(`${output}\n`)
  return 0
}
