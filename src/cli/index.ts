import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { FixtureProvider } from '../context/fixtures/index.js'
import { IacFsProvider } from '../context/iac-fs/provider.js'
import type { ContextProvider, Ignored } from '../context/provider.js'
import { PLAN_LIMITS } from '../core/schemas/plan.js'
import { ModelCallError } from '../llm/failures.js'
import {
  ModelSettingError,
  NoModelConfiguredError,
  chooseModel,
  timeoutOf,
} from '../llm/providers.js'
import { openRecording, resolveMode } from '../llm/recording.js'
import { createClient, type ClientMode } from '../llm/runtime.js'
import { fileRecordingStore } from './recording-fs.js'
import { runAsk } from './commands/ask.js'
import { runEntry } from './commands/entry.js'
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
import { inert, inertLine, oneLine } from './render/plain.js'
import { homeOf } from './personal.js'
import {
  RepositoryArgumentError,
  applicationRoot,
  projectRoot,
  skipNotice,
  type DeclarationsCommand,
  type Inspection,
} from './repository.js'
import {
  blameOf,
  declarationsOf,
  overviewName,
  planNeedsRepository,
  sourceNotice,
  sourceOf,
  type RepositorySource,
  type Source,
  type SourceContext,
} from './source.js'

/**
 * Where a Plan comes from, and it is a union rather than two optional fields so
 * that "both" and "neither" are unrepresentable. They are two roads to one
 * renderer (see `commands/plan.ts`): one reads a file and calls no model, the
 * other drafts one and calls three.
 *
 * `project` belongs to the intent alone, which makes `--project` with `--from`
 * unrepresentable too: a plan in a file has no Inspector to point. Absent
 * means the directory the user is standing in when it is a service's, and no
 * inspection when it is not (`repository.ts`'s `applicationRoot`).
 */
export type PlanSource = { from: string } | { intent: string; project?: string }

/**
 * Where the three read commands read from: `repo`, the declarations repository
 * as `plan --repo` means it, or `demo`, the fictional SI. Neither is the
 * working directory when it is a declarations repository and the demo SI when
 * it is not — absences rather than values, which is what
 * exactOptionalPropertyTypes keeps them. Both is unrepresentable, and refused
 * at parsing.
 */
export type ReadFrom = { repo?: string; demo?: never } | { demo: true; repo?: never }

export type Command =
  | ({ name: 'graph'; options: GraphOptions } & ReadFrom)
  | ({ name: 'show'; query: string } & ReadFrom)
  /**
   * `quiet`, present only when `--quiet` was given: the verified block alone,
   * without the model's commentary around it (ADR-0008).
   */
  | ({ name: 'ask'; intent: string; quiet?: true } & ReadFrom)
  /**
   * `idpa "<phrase>"`: a first word that is no command. The Supervisor decides
   * which road it takes (`commands/entry.ts`); `project` and `json` belong to
   * the plan road and are carried whichever is taken — a bad `--project`
   * refuses a question too, and `--json` on one is said to do nothing.
   * `quiet` belongs to the question road, and does nothing on a change.
   */
  | ({ name: 'entry'; phrase: string; project?: string; json: boolean; quiet?: true } & ReadFrom)
  | { name: 'validate'; directory: string }
  /**
   * Absent `repo` means the working directory when it is a declarations
   * repository, else the one configured, and a refusal when none is (`source.ts`).
   */
  | { name: 'plan'; source: PlanSource; repo?: string; json: boolean }
  | { name: 'init-platform'; directory: string; owner: string }
  /** Absent `repo` means the repository the user is standing in (§7.3). */
  | { name: 'init'; repo?: string }
  | { name: 'help' }
  | { name: 'error'; message: string }

export const HELP = `idp-agent - turn an intent into reviewed infrastructure declarations

  idpa "<phrase>" [--repo <directory> | --demo] [--project <directory>] [--json] [--quiet]

  The one gesture, from anywhere: a question about the SI is answered, an
  intent to change it is previewed as a plan, and the phrase need not say
  which. Quote it when it holds ?, *, !, quotes or parentheses, which the
  shell would read. --project and --json apply to a change only. ask and plan
  force a road: plan previews without classifying, and ask classifies and
  only answers, declining a change.

  An answer is the engine's, verified against the catalogue. The model may
  frame it with a sentence before and a few after, each checked by the engine
  and marked with ›; --quiet prints the verified answer alone.

  idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource|API] [--repo <directory> | --demo]
  idp-agent show <name-or-reference> [--repo <directory> | --demo]
  idp-agent ask "<question>" [--repo <directory> | --demo] [--quiet]
  idp-agent validate <directory>
  idp-agent plan "<intent>" [--repo <directory>] [--project <directory>] [--json]
  idp-agent plan --from <plan.json> [--repo <directory>] [--json]
  idp-agent init [--repo <directory>]
  idp-agent init platform <directory> --owner @org/team

  idpa is idp-agent. Every command but init and validate finds the
  declarations repository the same way: --repo, else the current directory
  when it is one, else IDP_REPO, else repo in the personal config.yml
  ($XDG_CONFIG_HOME/idp-agent/, else ~/.config/idp-agent/). With none, graph,
  show and a question read the fictional demo SI, as --demo does, and a change
  is refused. A change inspects the service --project names, or the current
  directory when it is an application repository (a catalog-info.yaml or a
  package manifest at its root), and otherwise drafts from the catalogue alone.
  A phrase, ask, plan "<intent>" and init need IDP_PROVIDER and IDP_MODEL, and
  none of them writes. Every model-backed command also needs that provider's
  key (ANTHROPIC_API_KEY, MISTRAL_API_KEY or OPENAI_API_KEY); IDP_TIMEOUT
  bounds each model call, in seconds, 120 by default.
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
          project: { type: 'string' },
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
      const project = values.project
      if (from !== undefined && project !== undefined) {
        return {
          name: 'error',
          message:
            'plan --from reads a plan and inspects nothing, so --project has nothing to point: ' +
            'it names the application repository plan "<intent>" inspects',
        }
      }
      if (intent.length > PLAN_LIMITS.maxIntentLength) {
        return {
          name: 'error',
          message: `an intent is limited to ${PLAN_LIMITS.maxIntentLength} characters`,
        }
      }
      // No --repo is not refused here: IDP_REPO or the personal configuration
      // may name one, and parsing reads neither (`sourceOf`, in main).
      const repo = values.repo
      return {
        name: 'plan',
        source:
          from !== undefined
            ? { from }
            : // Omitted rather than undefined: "where I am standing" is an absence.
              { intent, ...(project !== undefined ? { project } : {}) },
        ...(repo !== undefined ? { repo } : {}),
        json: values.json === true,
      }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  if (commandName === 'ask') {
    try {
      // Strict, where every argument used to be the question: an option this
      // command does not know would otherwise reach a third party as words of
      // the sentence it was asked. A question that really starts with a dash
      // goes after `--`, which parseArgs' own refusal says.
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...READ_OPTIONS, quiet: { type: 'boolean' } },
        allowPositionals: true,
        strict: true,
      })
      // Joined, for the same reason as `plan`'s intent: a shell that lost the
      // quotes hands the words over one at a time.
      const intent = positionals.join(' ').trim()
      if (intent === '') return { name: 'error', message: 'ask needs a question' }
      if (intent.length > PLAN_LIMITS.maxIntentLength) {
        return { name: 'error', message: `a question is limited to ${PLAN_LIMITS.maxIntentLength} characters` }
      }
      const from = readFrom('ask', values)
      if ('message' in from) return from
      return { name: 'ask', intent, ...from, ...(values.quiet === true ? { quiet: true } : {}) }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  if (commandName === 'show') {
    try {
      const { values, positionals } = parseArgs({
        args: rest,
        options: READ_OPTIONS,
        allowPositionals: true,
        strict: true,
      })
      const query = positionals[0]
      if (query === undefined) return { name: 'error', message: 'show needs a name or a reference' }
      // Refused rather than reading the first: which of two names was meant is
      // not something to guess, and the second was silently dropped before.
      if (positionals.length > 1) {
        return {
          name: 'error',
          message: `show takes one name or reference, not ${positionals.length}: ${positionals.join(', ')}`,
        }
      }
      const from = readFrom('show', values)
      if ('message' in from) return from
      return { name: 'show', query, ...from }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  if (commandName === 'graph') {
    try {
      const { values } = parseArgs({
        args: rest,
        options: {
          env: { type: 'string' },
          type: { type: 'string' },
          kind: { type: 'string' },
          ...READ_OPTIONS,
        },
        strict: true,
      })
      const kind = values.kind
      if (kind !== undefined && kind !== 'Component' && kind !== 'Resource' && kind !== 'API') {
        return { name: 'error', message: 'kind must be Component, Resource or API' }
      }
      const from = readFrom('graph', values)
      if ('message' in from) return from
      return {
        name: 'graph',
        options: {
          ...(values.env !== undefined ? { env: values.env } : {}),
          ...(values.type !== undefined ? { type: values.type } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
        ...from,
      }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  return parsePhrase(argv)
}

/**
 * Every first word that is a command, and so never the start of a phrase —
 * `parseArguments`' if-chain, which `entry.test.ts` holds this list to, and to
 * HELP's.
 */
export const COMMANDS = ['graph', 'show', 'ask', 'validate', 'plan', 'init', 'help'] as const

const isCommand = (word: string): word is (typeof COMMANDS)[number] =>
  COMMANDS.some((name) => name === word)

/**
 * `idpa "<phrase>"`: every argument that is not an option, joined — a shell
 * that lost the quotes hands the words over one at a time, exactly as `ask`
 * and `plan` take them — with the options both roads know. Strict, for the
 * reason `ask` is: an option this does not know would otherwise reach a third
 * party as a word of the phrase.
 *
 * Two things are refused, and only two, both before a model could see them:
 *
 *   - a command behind its options. `idpa --repo IaC show billing-api` is
 *     `show`, typed in the wrong order, and would otherwise reach the
 *     Supervisor as the phrase "show billing-api";
 *   - a phrase of a single word a slip away from a command name. `idpa grpah`
 *     is a typo, and sending it to a model would spend a round-trip to have a
 *     mistyped command classified; a sentence is never a typo, and no other
 *     phrase is judged here.
 */
function parsePhrase(argv: string[]): Command {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        ...READ_OPTIONS,
        project: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    })
    // Only reached with an option first: a command in first place was
    // dispatched above, and a phrase's first word, quoted, holds a space.
    const first = positionals[0]
    if (first !== undefined && isCommand(first)) {
      const option = argv.find((argument) => argument.startsWith('-')) ?? ''
      return { name: 'error', message: `options go after the command: idpa ${first} … ${option}` }
    }
    const phrase = positionals.join(' ').trim()
    if (phrase === '') {
      return { name: 'error', message: 'idpa needs a question or an intent: idpa "<phrase>"' }
    }
    if (!/\s/.test(phrase)) {
      const meant = nearestCommand(phrase)
      if (meant !== undefined) {
        return {
          name: 'error',
          message: `unknown command "${phrase}"; did you mean ${meant}? To ask something, write a sentence`,
        }
      }
    }
    if (phrase.length > PLAN_LIMITS.maxIntentLength) {
      return { name: 'error', message: `a phrase is limited to ${PLAN_LIMITS.maxIntentLength} characters` }
    }
    const from = readFrom('idpa', values)
    if ('message' in from) return from
    return {
      name: 'entry',
      phrase,
      ...from,
      ...(values.project !== undefined ? { project: values.project } : {}),
      json: values.json === true,
      ...(values.quiet === true ? { quiet: true } : {}),
    }
  } catch (error) {
    return { name: 'error', message: (error as Error).message }
  }
}

/**
 * The command a word is a slip away from, or `undefined`. Case is not a slip.
 *
 * A slip is an edit — a letter added, dropped, changed, or two neighbours
 * swapped — and it keeps the first letter: `who`, `now`, `edit`, `task` and
 * `clean` are words, and each is told from a command by its first letter
 * already. Keeping the length, a name of four letters or more tolerates two
 * (`palm` is `plan`, `valdiate` is `validate`); changing it, one (`grap`,
 * `helo`) — so `hello` is not `help`, nor `it` or `in` `init`. `ask`, three
 * letters, tolerates one at its own length and none beside it, so `as` and
 * `asks` are words too.
 *
 * No two commands share a first letter, so at most one name is a candidate
 * and there is no nearest to choose.
 */
function nearestCommand(word: string): string | undefined {
  const typed = word.toLowerCase()
  return COMMANDS.find((name) => {
    if (typed[0] !== name[0]) return false
    const long = name.length >= 4
    const tolerated = typed.length === name.length ? (long ? 2 : 1) : long ? 1 : 0
    return edits(typed, name) <= tolerated
  })
}

/** Edit distance with a swap of neighbours counted as one edit (optimal string alignment). */
function edits(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1)
      }
      rows[i]![j] = best
    }
  }
  return rows[a.length]![b.length]!
}

/** The two options that say where a read command's SI comes from. */
const READ_OPTIONS = { repo: { type: 'string' }, demo: { type: 'boolean' } } as const

/**
 * `--repo` or `--demo`, each omitted rather than undefined when not given.
 * Both is refused rather than one of them winning: the user named two sources
 * and there is no answer to which one they meant.
 */
function readFrom(
  command: 'graph' | 'show' | 'ask' | 'idpa',
  values: { repo?: string | undefined; demo?: boolean | undefined },
): ReadFrom | { name: 'error'; message: string } {
  if (values.demo === true && values.repo !== undefined) {
    return {
      name: 'error',
      message: `${command} takes --repo <directory> or --demo, never both: one names your declarations repository and the other the fictional SI`,
    }
  }
  if (values.demo === true) return { demo: true }
  return values.repo !== undefined ? { repo: values.repo } : {}
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
      // A refused call reads no rows, and "0 row(s)" is what a search that ran
      // and found nothing looks like; the reason is what tells them apart. One
      // bounded line, like every reason: it can quote a value the model sent.
      if (event.error !== undefined) return `  ← refused: ${said(event.error)}`
      // Truncation is stated, never silent — the rule the whole tool layer is
      // built on, and the one a reader has to see too.
      return `  ← ${event.rows} row(s)${event.truncated > 0 ? ` · ${event.truncated} more not shown` : ''}`
    case 'retry':
      return `  ! ${event.agent} corrected itself: ${said(event.reason)}`
    case 'repair':
      return `  ! attempt ${event.attempt} refused at the ${event.gate} gate: ${said(event.reason)}`
    case 'plan:ready':
      return `· a draft with ${event.operations} operation(s)`
    case 'derived':
      // The consumers, not just the owner. A line saying only that an owner
      // appeared would be the engine asserting a value; naming who it was read
      // off is what makes it checkable against the diff below it.
      //
      // Every name on it is cleaned: a consumer is a reference a model wrote,
      // and an owner is one a repository file declares.
      return (
        `  = ${event.path} follows from ${event.from.map(whole).join(', ')}: ` +
        whole(event.owner)
      )
    case 'overridden':
      // Both owners and where the second came from, for the reason `derived`
      // names its consumers: the line is checked against the diff below it.
      return (
        `  = ${event.path} is ${whole(event.owner)}, as stated; ` +
        `${event.from.map(whole).join(', ')} would give ${whole(event.determined)}`
      )
    case 'reapplied':
      // The entity, not the path it was typed at: that path belongs to a plan
      // the user no longer sees. What the draft said instead is a model's
      // value, so it is one bounded line like every reason.
      return (
        `  = ${event.path} is ${oneLine(event.value)}, as answered for ${event.entity}` +
        (event.replaced === undefined ? '' : `; the draft said ${oneLine(event.replaced)}`)
      )
    case 'refused':
      return `! ${event.agent} refused: ${said(event.reason)}`
    case 'stopped':
      // No reason: it is the error the command prints next, as its last line,
      // and said here too it would reach the user twice.
      return `! ${event.agent} stopped`
    case 'ask':
    case 'answer:ready':
      return undefined
    case 'agent:end':
    case 'attempt:start':
    case 'attempt:end':
    case 'gate:passed':
      // Structure, not news. They bound what the lines above already say — an
      // agent's `·`, an attempt's `!` — and a trace needs them to draw spans;
      // a reader of stderr does not need four more lines per attempt.
      return undefined
    default: {
      // A new event with no line is a compile error rather than a silent gap.
      const exhaustive: never = event
      return exhaustive
    }
  }
}

/**
 * One line with nothing a terminal obeys, the bidi controls spelled out, and
 * nothing cut: a file name on a `skipped` line, a reference on a `derived`
 * one. A shortened name is another file, and a shortened reference another
 * entity; an override in either is how `lmy.evil` reads `live.yml`.
 */
const whole = (text: string): string => inertLine(text, Number.POSITIVE_INFINITY)

/**
 * A reason on the event stream: one line, bounded at `oneLine`'s 200, and the
 * bidi controls spelled out as well — `plan` streams the Reviewer's and the
 * gates' reasons here, the same words its stdout quotes.
 */
const said = (text: string): string => inertLine(text, 200)

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
    // The declarations repository, found the way every command finds it:
    // --repo, the working directory when it is one, IDP_REPO, the personal
    // file — and never the demo SI.
    const context = sourceContextOf(deps)
    let declarations: RepositorySource | undefined
    try {
      declarations = await sourceOf({ command: 'plan', repo: command.repo }, context)
    } catch (error) {
      return failed(error, err)
    }
    if (declarations === undefined) {
      err(`${planNeedsRepository(context)}\n\n${HELP}`)
      return EXIT.badUsage
    }
    const notice = sourceNotice('plan', declarations, context)
    if (notice !== undefined) err(`${notice}\n`)
    // As typed when typed, so every line that quotes it back is unchanged;
    // the resolved directory when it was configured. A typed relative path is
    // therefore resolved twice: `sourceOf` checked it against `deps.cwd`, and
    // runPlan / runIntent resolve it again against `process.cwd()`. The two are
    // the same directory in every real run; a test that injects `cwd` for plan
    // passes an absolute --repo, or none.
    const repo = command.repo ?? declarations.root
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
          repo,
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

    // §7.4 step 3: the Inspector reads "the local repository" — the one
    // `--project` names, or the one the user is standing in when it is a
    // service's. `--repo` names the declarations repository the preview is
    // decided against, and they are two different repositories;
    // `applicationRoot` refuses a `--project` that confuses them, and skips a
    // working directory that is not a service's.
    //
    // Here, before `agentBacked` chooses a model, and not inside `runIntent`:
    // a directory is an argument, and an argument is refused before the
    // configuration is. The other order told someone with a wrong --project
    // and nothing configured to configure a model, which they would do, only
    // to be refused for the directory next. It walks nothing, so it costs a
    // few `stat`s — and the line saying the Inspector is skipped comes before
    // anything a model is asked, for the same reason.
    //
    // Both roots come back resolved, and `runIntent` is handed those: the
    // directory compared with the project is the directory the preview reads.
    let roots: Roots
    try {
      roots = await applicationRoot({
        who: 'plan',
        repo,
        project: source.project,
        cwd: () => deps.cwd ?? process.cwd(),
        home: homeOf(deps.env ?? process.env),
      })
    } catch (error) {
      return failed(error, err)
    }
    const project = inspected(roots.project, err)

    return agentBacked(deps, err, out, 'plan', async (client) =>
      runIntent({
        intent: source.intent,
        repo: roots.repo,
        ...(ask !== undefined ? { ask } : {}),
        project,
        client,
        emit: deps.events ?? progress(err),
        json: command.json,
        colour,
      }),
    )
  }

  // The one decision the read commands make about where the SI comes from;
  // everything after the provider is the same for all three roads.
  let read: Read
  try {
    // A phrase finds its SI as `ask` does, and says so in `ask`'s line: its
    // question road IS `ask`'s, and a change is decided against the same
    // repository, when one was found. Its refusals name `idpa`, which is what
    // was typed.
    read = await providerOf(command.name === 'entry' ? 'idpa' : command.name, command, deps, err)
  } catch (error) {
    return failed(error, err)
  }
  const { provider, source } = read
  const repository = overviewName(source)

  const { entities, rejected, ignored } = await provider.load()
  // Reported, never dropped in silence: that silent drop is the catalogue
  // behaviour this tool exists to compensate for (design 4.4).
  // Both halves are the file's own words: a path is a name somebody chose, and
  // a reason quotes the key it faults. Flattened and cleaned, never cut — the
  // line is how the user finds the file and what to fix in it.
  for (const rejection of rejected) {
    err(`skipped ${whole(rejection.source)}: ${whole(rejection.reason)}\n`)
  }
  if (ignored.length > 0) err(`${notLoaded(ignored)}\n`)
  // A repository that declares nothing answers every question with a miss —
  // "No entity named", "No entity matches" — which reads as a fact about the
  // name or the filter. The likeliest cause is the other one: `--repo` pointed
  // at an application repository, which is what `init --repo` names. Said on
  // stderr so stdout stays the command's own answer, and not an error, because
  // an empty declarations repository is a real, freshly scaffolded state.
  // Not when something was rejected: those files were entity declarations
  // that did not parse, the `skipped` lines above say which, and blaming the
  // flag would send the user to look for another repository. Nor when a
  // document with a kind was set aside: a repository of Groups and Users is a
  // catalogue, only not of anything this tool models. A mkdocs.yml alone is
  // what an application repository looks like, so that still gets the line.
  const catalogue = ignored.some((document) => document.kind !== undefined)
  // Only for a repository something named — `--repo`, IDP_REPO, the personal
  // file — and naming that something, which is what the user goes and fixes.
  // A working directory is read because its witnesses say it is a declarations
  // repository, so an empty one is the freshly scaffolded state and there is
  // nothing to blame.
  const blamed = blameOf(source)
  if (blamed !== undefined && entities.length === 0 && rejected.length === 0 && !catalogue) {
    err(`${oneLine(source.label)} declares no entity; ${oneLine(blamed)} names the declarations repository\n`)
  }

  const graph = EntityGraph.from(
    entities,
    ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
  )

  if (command.name === 'entry') {
    // What `ask` is handed, word for word, so the question road is `ask`'s.
    const asked = {
      graph,
      intent: command.phrase,
      source: {
        ...(repository !== undefined ? { repo: repository } : {}),
        ignored,
        rejected: rejected.length,
      },
      emit: deps.events ?? progress(err),
      err,
      colour: colourOf(deps),
      quiet: command.quiet === true,
    }
    // The change road's repositories, decided before any model is chosen, for
    // the reason `plan`'s are: a `--project` is an argument, and it is checked
    // whichever road the Supervisor then takes. None for the demo SI, which a
    // change is never previewed against — refused below, once the Supervisor
    // has said it is a change — but a `--project` is still refused for what it
    // is on its own, so the same argument meets the same refusal wherever the
    // SI came from.
    const declarations = declarationsOf(source)
    const cwd = (): string => deps.cwd ?? process.cwd()
    let roots: Roots | undefined
    try {
      if (declarations !== undefined) {
        roots = await applicationRoot({
          who: 'idpa',
          repo: declarations.root,
          project: command.project,
          cwd,
          home: homeOf(deps.env ?? process.env),
        })
      } else if (command.project !== undefined) {
        await projectRoot('idpa', command.project, cwd)
      }
    } catch (error) {
      return failed(error, err)
    }
    const ask = askOf(deps)
    return agentBacked(deps, err, out, 'entry', async (client) =>
      runEntry({
        ...asked,
        client,
        json: command.json,
        change: async () => {
          if (roots === undefined) {
            throw new RepositoryArgumentError(
              planNeedsRepository(sourceContextOf(deps), 'that is a change request, and it'),
            )
          }
          return runIntent({
            intent: command.phrase,
            repo: roots.repo,
            ...(ask !== undefined ? { ask } : {}),
            project: inspected(roots.project, err),
            client,
            emit: asked.emit,
            json: command.json,
            colour: colourOf(deps),
          })
        },
      }),
    )
  }

  if (command.name === 'ask') {
    return agentBacked(deps, err, out, 'question', async (client) =>
      runAsk({
        graph,
        client,
        intent: command.intent,
        // An overview names what it read and counts what it could not: the
        // same facts as the lines above, for the answer that describes the
        // whole catalogue.
        source: {
          ...(repository !== undefined ? { repo: repository } : {}),
          ignored,
          rejected: rejected.length,
        },
        emit: deps.events ?? progress(err),
        err,
        colour: colourOf(deps),
        quiet: command.quiet === true,
      }),
    )
  }

  const result =
    command.name === 'graph' ? runGraph(graph, command.options) : runShow(graph, command.query)
  return report(result, out)
}

/** What a read command reads, and where that came from (`source.ts`). */
interface Read {
  source: Source
  provider: ContextProvider
}

/**
 * The provider for a read command's source. The decision — `--repo`, `--demo`,
 * the working directory, IDP_REPO, the personal file, the demo SI — is
 * `sourceOf`'s, shared with `plan`; this turns it into a reader and says, in one
 * line on stderr before anything else, what is being read. Only `--repo` is
 * silent. stderr, because stdout is the answer and gets piped.
 */
async function providerOf(
  name: Exclude<DeclarationsCommand, 'plan'>,
  from: ReadFrom,
  deps: MainDeps,
  err: (chunk: string) => void,
): Promise<Read> {
  const context = sourceContextOf(deps)
  const source = await sourceOf({ command: name, repo: from.repo, demo: from.demo }, context)
  const notice = sourceNotice(name, source, context)
  if (notice !== undefined) err(`${notice}\n`)
  switch (source.kind) {
    case 'repo':
      return { source, provider: new IacFsProvider(source.root) }
    case 'demo':
      return { source, provider: new FixtureProvider(deps.root ?? DEFAULT_ROOT) }
    default: {
      const exhaustive: never = source
      return exhaustive
    }
  }
}

/** The two repositories a change reads (`applicationRoot`). */
type Roots = Awaited<ReturnType<typeof applicationRoot>>

/**
 * The application repository to hand the Inspector, or `undefined` for none —
 * and then the one line on stderr that says the Inspector is skipped and why,
 * cleaned whole: the reason names a folder, and a folder is called whatever
 * someone called it.
 */
function inspected(inspection: Inspection, err: (chunk: string) => void): string | undefined {
  switch (inspection.kind) {
    case 'project':
      return inspection.root
    case 'none':
      err(`${whole(skipNotice(inspection.reason))}\n`)
      return undefined
    default: {
      const exhaustive: never = inspection
      return exhaustive
    }
  }
}

/**
 * The working directory and the environment a source is resolved in: the
 * injected ones in a test, the process's otherwise. The directory is asked for
 * lazily, because `process.cwd()` throws in a directory since removed.
 */
const sourceContextOf = (deps: MainDeps): SourceContext => ({
  cwd: () => deps.cwd ?? process.cwd(),
  env: deps.env ?? process.env,
})

/**
 * Everything the read commands set aside, as ONE line. A real catalogue holds
 * hundreds of Users, and a line each would bury the answer under what is, in
 * that repository, expected; counted by kind, because the kind is what tells a
 * reader whether the count is. The kind comes from a file, so it is flattened
 * like any other text this tool did not write.
 */
function notLoaded(ignored: readonly Ignored[]): string {
  const byKind = new Map<string, number>()
  let unkinded = 0
  for (const { kind } of ignored) {
    if (kind === undefined) {
      unkinded += 1
      continue
    }
    const label = oneLine(kind)
    byKind.set(label, (byKind.get(label) ?? 0) + 1)
  }
  const counts = [...byKind]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind} ×${String(count)}`)
  if (unkinded > 0) counts.push(`not an entity ×${String(unkinded)}`)
  const documents = ignored.length === 1 ? 'document' : 'documents'
  return `not loaded: ${String(ignored.length)} ${documents} this tool does not model (${counts.join(', ')})`
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
      // The model wrote the question; the path beside it is the engine's.
      reader.question(`  ${question.path}\n      ${inertLine(question.question)}\n  > `),
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
 * These refusals are the user's arguments and earn exit 2 — a plan file that is
 * not a plan, a `--repo` that is not a directory or holds a file `plan` cannot
 * read, a `.idp-agent.yml` that does not parse, a run with no model configured,
 * no key for it, or an IDP_TIMEOUT that is not a number of seconds.
 *
 * A model call that could not succeed — it timed out, the provider refused the
 * key or failed, the output limit or a content filter stopped it — is exit 1,
 * in the one line `llm/failures.ts` wrote for it. Nothing the user typed was
 * wrong, and the same command may well succeed on the next run.
 *
 * Anything else is still a failure and must not leave as exit 0 with a stack
 * trace: that is indistinguishable from success to a script.
 */
function failed(error: unknown, err: (chunk: string) => void): number {
  // Cleaned, every one: a refusal quotes what it refuses — a plan file's key,
  // the parser's excerpt of a file that is not JSON, a folder's name, a
  // provider's own words — and none of that is this tool's to print raw.
  //
  // These two are one sentence each by construction, so they are kept to one
  // line, and never cut: the parser quotes a file's bytes, line breaks
  // included, and one would print a line of the file as a line of ours.
  if (error instanceof PlanInputError || error instanceof RepositoryArgumentError) {
    err(`${inertLine(error.message, Number.POSITIVE_INFINITY)}\n`)
    return EXIT.badUsage
  }
  if (
    error instanceof ConfigError ||
    error instanceof NoModelConfiguredError ||
    error instanceof ModelSettingError
  ) {
    err(`${inert(error.message)}\n`)
    return EXIT.badUsage
  }
  if (error instanceof ModelCallError) {
    err(`${inert(error.message)}\n`)
    return EXIT.notFound
  }
  err(`${inert(error instanceof Error ? error.message : String(error))}\n`)
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

  // Both read before a tape is opened or an agent started: a missing key or a
  // bad IDP_TIMEOUT is a refusal of the configuration, said up front, and not a
  // failure discovered at the first request. Replay reads neither — a recording
  // names its own model and needs no key.
  const choice = mode === 'replay' ? undefined : chooseModel(env)
  const timeout = mode === 'replay' ? undefined : timeoutOf(env)
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
      ...(timeout !== undefined ? { timeout } : {}),
    }),
    save: async (): Promise<void> => {
      if (mode === 'record' && tape !== undefined) await tape.save()
    },
  }
}
