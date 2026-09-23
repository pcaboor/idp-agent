import path from 'node:path'
import { createInterface } from 'node:readline/promises'
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
import { PlanInputError, runIntent, runPlan, type Ask } from './commands/plan.js'
import { wantsColour } from './render/diff.js'
import { runInitPlatform, runInitRepo } from './commands/init.js'
import { ConfigError } from './config.js'
import { isForgeHandle } from '../scaffold/codeowners.js'
import { VERSION } from '../core/index.js'
import type { LlmClient } from '../llm/client.js'
import type { CommandResult } from './commands/result.js'

/**
 * Where a Plan comes from, and it is a union rather than two optional fields so
 * that "both" and "neither" are unrepresentable. They are two roads to one
 * renderer (see `commands/plan.ts`): one reads a file and calls no model, the
 * other drafts one and calls three.
 */
export type PlanSource = { from: string } | { intent: string }

export type Command =
  | { name: 'graph'; options: GraphOptions }
  | { name: 'show'; query: string }
  | { name: 'ask'; intent: string }
  | { name: 'validate'; directory: string }
  | { name: 'plan'; source: PlanSource; repo: string; json: boolean }
  | { name: 'init-platform'; directory: string; owner: string }
  /** Absent `repo` means the repository the user is standing in (§7.3). */
  | { name: 'init'; repo?: string }
  | { name: 'help' }
  | { name: 'error'; message: string }

const HELP = `idp-agent - turn an intent into reviewed infrastructure declarations

  idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource]
  idp-agent show <name-or-reference>
  idp-agent ask "<question>"     needs IDP_PROVIDER and IDP_MODEL
  idp-agent validate <directory>
  idp-agent plan "<intent>" --repo <directory> [--json]
  idp-agent plan --from <plan.json> --repo <directory> [--json]
  idp-agent init [--repo <directory>]
  idp-agent init platform <directory> --owner @org/team

  plan "<intent>" and init need IDP_PROVIDER and IDP_MODEL. Both write nothing.
`

export function parseArguments(argv: string[]): Command {
  const [commandName, ...rest] = argv
  if (commandName === undefined || commandName === 'help' || commandName === '--help') {
    return { name: 'help' }
  }

  if (commandName === 'init') {
    if (rest[0] !== 'platform') {
      try {
        const { values } = parseArgs({
          args: rest,
          options: { repo: { type: 'string' } },
          strict: true,
        })
        // Omitted rather than passed as undefined: exactOptionalPropertyTypes
        // draws the distinction, and "the directory I am standing in" is an
        // absence rather than a value main has to invent here.
        return { name: 'init', ...(values.repo !== undefined ? { repo: values.repo } : {}) }
      } catch (error) {
        return { name: 'error', message: (error as Error).message }
      }
    }
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

  if (commandName === 'plan') {
    try {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          from: { type: 'string' },
          repo: { type: 'string' },
          json: { type: 'boolean' },
        },
        // The intent is a positional: §7.4's daily gesture is a sentence in
        // quotes, not a flag.
        allowPositionals: true,
        strict: true,
      })
      const from = values.from
      // Joined, because a shell that lost the quotes hands the words over one
      // at a time, and refusing that would refuse the commonest typo there is.
      const intent = positionals.join(' ').trim()

      if (from !== undefined && intent !== '') {
        return {
          name: 'error',
          message:
            'plan takes an intent or --from <plan.json>, never both: one drafts a plan and ' +
            'the other reads one, and there is no answer to which of the two won',
        }
      }
      if (from === undefined && intent === '') {
        return { name: 'error', message: 'plan needs an intent, or --from <plan.json>' }
      }
      if (intent.length > PLAN_LIMITS.maxIntentLength) {
        return {
          name: 'error',
          message: `an intent is limited to ${PLAN_LIMITS.maxIntentLength} characters`,
        }
      }
      const repo = values.repo
      if (repo === undefined) {
        return {
          name: 'error',
          message:
            'plan needs --repo <directory>: a write preview is decided against the repository, never against the catalogue',
        }
      }
      return {
        name: 'plan',
        source: from !== undefined ? { from } : { intent },
        repo,
        json: values.json === true,
      }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
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
  /**
   * Injected so a test drives a whole agent-backed command on scripted turns —
   * no key, no recording, no network. Supplying one skips the provider choice
   * and the tape entirely; leaving it out is what every real run does, and what
   * the "no model configured" refusal is asserted on.
   */
  client?: LlmClient
  /**
   * How a question reaches a person (§7.5). Injected for the same reason `out`
   * and `client` are: the whole interactive path is then driven from a test
   * with no terminal and no stdin. Leaving it out is what a real run does, and
   * `askOf` decides from the process whether there is anybody there.
   */
  ask?: Ask
}

/**
 * One event, one line, on **stderr** (design §6.2).
 *
 * Stage 7 draws these with Ink. This is the minimum that makes a run legible
 * before then, and the two decisions in it are about what a terminal is for:
 *
 *   - stderr, never stdout. stdout carries the diff and the `--json` report,
 *     and both are piped — into `patch`, into `jq`. Progress on stdout would
 *     corrupt the one output this command exists to produce.
 *   - one line, appended. No spinner, no cursor movement, no redraw and no
 *     colour: those need a TTY and a renderer that owns the screen, which is
 *     precisely what stage 7 adds. A log survives being piped to a file; a
 *     re-drawn line does not.
 *
 * Two events render nothing, and the absences are deliberate rather than
 * forgotten: `ask` and `answer:ready` ARE the command's answer, and they reach
 * the user on stdout. A stderr copy would state the same fact twice and read as
 * two different things having happened.
 *
 * What stage 7 is left: the shape of a run rather than a list of its moments —
 * the agents as a live sequence, a tool's arguments, the transcript, the
 * questions as a form to fill in rather than a list to read.
 */
export function renderEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'agent:start':
      return `· ${event.agent}`
    case 'classified':
      return `· ${event.classification.toLowerCase()}`
    case 'tool:call':
      // The name, never the arguments. They are model-authored, unbounded in
      // practice, and a terminal line is not where an arbitrary string belongs;
      // the transcript is what stage 7 shows.
      return `  → ${event.name}`
    case 'tool:result':
      // Truncation is stated, never silent — the rule the whole tool layer is
      // built on, and the one a reader has to see too.
      return `  ← ${event.rows} row(s)${event.truncated > 0 ? ` · ${event.truncated} more not shown` : ''}`
    case 'retry':
      return `  ! ${event.agent} corrected itself: ${oneLine(event.reason)}`
    case 'repair':
      return `  ! attempt ${event.attempt} refused at the ${event.gate} gate: ${oneLine(event.reason)}`
    case 'plan:ready':
      return `· a draft with ${event.operations} operation(s)`
    case 'derived':
      // The consumers, not just the owner. A line saying only that an owner
      // appeared would be the engine asserting a value; naming who it was read
      // off is what makes it checkable against the diff below it.
      return `  = ${event.path} follows from ${event.from.join(', ')}: ${event.owner}`
    case 'refused':
      return `! ${event.agent} refused: ${oneLine(event.reason)}`
    case 'ask':
    case 'answer:ready':
      return undefined
    default: {
      // A new event with no line is a compile error rather than a silent gap.
      const exhaustive: never = event
      return exhaustive
    }
  }
}

/** Bounded and flattened: one event is one line, and a reason is model-authored. */
const oneLine = (reason: string): string => {
  const flat = reason.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

const progress =
  (err: (chunk: string) => void) =>
  (event: AgentEvent): void => {
    const line = renderEvent(event)
    if (line !== undefined) err(`${line}\n`)
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
    // Resolved against the working directory, because §7.3 is run once per
    // application from inside it, and `--repo` is how someone standing
    // elsewhere says which one.
    const project = path.resolve(deps.cwd ?? process.cwd(), command.repo ?? '.')
    return agentBacked(deps, err, out, 'init', async (client) =>
      runInitRepo({
        project,
        client,
        emit: deps.events ?? progress(err),
        colour: colourOf(deps),
      }),
    )
  }

  if (command.name === 'init-platform') {
    // Resolved, not contained. This command CREATES the repository, so its
    // root has no reason to sit under the working directory —
    // `init platform ~/my-iac` is the first thing anyone types. Containment
    // belongs to the files written UNDER that root, and `scaffold/write.ts`
    // checks every one of them against it; applying it to the root itself
    // refused a path the user typed in their own shell.
    const root = path.resolve(deps.cwd ?? process.cwd(), command.directory)
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

  // Reads the repository it was handed, like validate. Neither form goes
  // through the fixture load below: a write preview is decided against the
  // repository, never against the catalogue (§4.4).
  if (command.name === 'plan') {
    const colour = colourOf(deps)
    const source = command.source
    // Both roads, because both end on the same outcome: a question is a question
    // whether a model drafted the plan or a file held it (§7.5).
    const ask = askOf(deps)

    if ('from' in source) {
      // A Plan in a file: no model is involved and none can be.
      let result: CommandResult
      try {
        result = await runPlan({
          from: source.from,
          repo: command.repo,
          json: command.json,
          colour,
          // Omitted rather than passed as undefined: exactOptionalPropertyTypes
          // draws the distinction, and "there is nobody to ask" is an absence.
          ...(ask !== undefined ? { ask } : {}),
          emit: deps.events ?? progress(err),
        })
      } catch (error) {
        return failed(error, err)
      }
      return report(result, out)
    }

    return agentBacked(deps, err, out, 'plan', async (client) =>
      runIntent({
        intent: source.intent,
        repo: command.repo,
        ...(ask !== undefined ? { ask } : {}),
        // §7.4 step 3: the Inspector reads "the local repository", which is the
        // one the user is standing in. `--repo` names the declarations
        // repository the preview is decided against, and they are two different
        // repositories — the whole reason the flag exists.
        project: path.resolve(deps.cwd ?? process.cwd()),
        client,
        emit: deps.events ?? progress(err),
        json: command.json,
        colour,
      }),
    )
  }

  const { entities, rejected } = await new FixtureProvider(deps.root ?? DEFAULT_ROOT).load()
  // Reported, never dropped in silence: that silent drop is the catalogue
  // behaviour this tool exists to compensate for (design 4.4).
  for (const rejection of rejected) {
    err(`skipped ${rejection.source}: ${rejection.reason}\n`)
  }

  const graph = EntityGraph.from(entities)

  if (command.name === 'ask') {
    return agentBacked(deps, err, out, 'question', async (client) =>
      runAsk({
        graph,
        client,
        intent: command.intent,
        emit: deps.events ?? progress(err),
        err,
      }),
    )
  }

  const result =
    command.name === 'graph' ? runGraph(graph, command.options) : runShow(graph, command.query)
  return report(result, out)
}

/**
 * Colour belongs to a terminal, and only main knows whether it holds one: an
 * injected `out` is a string sink — a test, a pipe, the TUI at stage 7 — and
 * painting it would put escape codes in someone's assertion.
 */
const colourOf = (deps: MainDeps): boolean =>
  deps.out === undefined && wantsColour(deps.env ?? process.env, process.stdout.isTTY === true)

/**
 * The only implementation that touches a keyboard, and the two decisions in it
 * are about what a terminal is for.
 *
 *   - The prompt goes to **stderr**, never stdout. stdout carries the diff and
 *     the `--json` report, and both are piped — into `patch`, into `jq`. A
 *     prompt on it would corrupt the one output this command exists to produce,
 *     which is the same rule the progress lines already follow (§6.2).
 *   - The interface is opened per question and closed again. A readline
 *     interface owns stdin while it lives, and a run that never asks anything
 *     must not take it at all.
 *
 * The wording is the wording the non-interactive form prints, unchanged: the
 * dotted path says which field, and the model's own reason IS the question — a
 * prompt showing one without the other asks about a path, or about nothing in
 * particular.
 */
const promptOnTerminal = (): Ask => async (question) => {
  const reader = createInterface({ input: process.stdin, output: process.stderr })
  try {
    // Raced against `close`, because Ctrl-D ends the input without ever
    // answering: a closed stdin is a decline — which is what `undefined` means
    // — and not a reason to hang a run or throw at the user.
    const closed = new Promise<undefined>((resolve) => {
      reader.once('close', () => resolve(undefined))
    })
    return await Promise.race([
      reader.question(`  ${question.path}\n      ${question.question}\n  > `),
      closed,
    ])
  } finally {
    reader.close()
  }
}

/**
 * Who answers a question, and the default turns on one fact: is there a person
 * at the other end.
 *
 * An injected sink is the same signal `colourOf` reads, for a stronger reason.
 * There, painting a string sink puts escape codes in someone's assertion; here,
 * reading the real stdin under one would block a run nobody is watching, which
 * is the worst thing a CLI in a pipeline can do. A script has nobody to ask, so
 * it gets the behaviour this build has always had: the questions print, and the
 * run exits 3.
 */
const askOf = (deps: MainDeps): Ask | undefined => {
  if (deps.ask !== undefined) return deps.ask
  if (deps.out !== undefined || deps.err !== undefined) return undefined
  return process.stdin.isTTY === true ? promptOnTerminal() : undefined
}

/**
 * Three outcomes, three codes: acted, asked and found nothing, or understood
 * and declined. Collapsing the last two would lose the only distinction the
 * exit codes exist to draw.
 */
function report(result: CommandResult, out: (chunk: string) => void): number {
  if (result.text !== '') out(`${result.text}\n`)
  if (result.unsupported === true) return EXIT.unsupported
  return result.found ? EXIT.ok : EXIT.notFound
}

/**
 * What a command threw, turned into a code.
 *
 * Three refusals are the user's arguments and earn exit 2 — a plan file that is
 * not a plan, a `--repo` that is not a directory, a `.idp-agent.yml` that does
 * not parse, a run with no model configured. Anything else is still a failure
 * and must not leave as exit 0 with a stack trace: that is indistinguishable
 * from success to a script.
 */
function failed(error: unknown, err: (chunk: string) => void): number {
  if (
    error instanceof PlanInputError ||
    error instanceof ConfigError ||
    error instanceof NoModelConfiguredError
  ) {
    err(`${error.message}\n`)
    return EXIT.badUsage
  }
  err(`${error instanceof Error ? error.message : String(error)}\n`)
  return EXIT.notFound
}

/**
 * Runs one command that needs a model, and closes the tape afterwards.
 *
 * The client is built here and not inside the command, for the reason every
 * other seam in this file exists: a command that chose its own provider could
 * not be driven by a scripted one, and every agent-backed test would need a key
 * or a recording.
 */
async function agentBacked(
  deps: MainDeps,
  err: (chunk: string) => void,
  out: (chunk: string) => void,
  scenario: string,
  run: (client: LlmClient) => Promise<CommandResult>,
): Promise<number> {
  try {
    const session = await openSession(deps, err, scenario)
    const result = await run(session.client)
    // Recording in memory and never writing it down is the whole run wasted,
    // and it is silent: the turns are there, the file never appears.
    await session.save()
    return report(result, out)
  } catch (error) {
    return failed(error, err)
  }
}

/**
 * The model, and the tape if there is one.
 *
 * IDP_RECORDING=record wins: that is the one run that is meant to call a model
 * and write the turns down, scenario or not. Otherwise a scenario means a test
 * replaying a recording — no model, no credential — and no scenario means a
 * real run, which calls the model and records nothing. Replay is never the
 * default for a real run: it would send someone hunting for a recording they
 * never made.
 */
async function openSession(
  deps: MainDeps,
  err: (chunk: string) => void,
  scenario: string,
): Promise<{ client: LlmClient; save: () => Promise<void> }> {
  // An injected client is a test on scripted turns. It reads no credential and
  // opens no tape, which is what makes "no model configured" a real assertion
  // rather than something every test has to work around.
  if (deps.client !== undefined) {
    return { client: deps.client, save: async (): Promise<void> => {} }
  }

  const env = deps.env ?? process.env
  const recording = resolveMode(env['IDP_RECORDING'])
  const mode: ClientMode =
    recording === 'record' ? 'record' : deps.scenario !== undefined ? 'replay' : 'live'

  const choice = mode === 'replay' ? undefined : chooseModel(env)
  const tape =
    mode === 'live'
      ? undefined
      : await openRecording({
          scenario: deps.scenario ?? env['IDP_SCENARIO'] ?? scenario,
          store: fileRecordingStore(deps.recordingDir ?? DEFAULT_RECORDINGS),
          mode: mode === 'record' ? 'record' : 'replay',
          warn: (message) => err(`${message}\n`),
        })

  return {
    client: createClient({
      mode,
      ...(tape !== undefined ? { tape } : {}),
      ...(choice !== undefined ? { choice } : {}),
    }),
    save: async (): Promise<void> => {
      if (mode === 'record' && tape !== undefined) await tape.save()
    },
  }
}
