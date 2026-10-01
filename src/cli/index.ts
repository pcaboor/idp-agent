import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { BackstageLimits } from '../context/backstage/limits.js'
import { BackstageProvider } from '../context/backstage/provider.js'
import {
  BACKSTAGE_TOKEN_VARIABLE,
  CatalogueReadError,
  type CatalogueFetch,
} from '../context/backstage/transport.js'
import { FixtureProvider } from '../context/fixtures/index.js'
import { IacFsProvider } from '../context/iac-fs/provider.js'
import type { CacheReport, ContextProvider, Ignored, LoadResult } from '../context/provider.js'
import { PLAN_LIMITS } from '../core/schemas/plan.js'
import { ModelCallError } from '../llm/failures.js'
import {
  ModelSettingError,
  NoModelConfiguredError,
  agentModelsOf,
  chooseModel,
  timeoutOf,
} from '../llm/providers.js'
import { openRecording, resolveMode } from '../llm/recording.js'
import { createClient, type ClientMode } from '../llm/runtime.js'
import { fileRecordingStore } from './recording-fs.js'
import { runAsk } from './commands/ask.js'
import { runEntry } from './commands/entry.js'
import { randomBytes } from 'node:crypto'
import type { AgentEvent, EventSink } from '../agents/events.js'
import { ClassificationError } from '../agents/supervisor.js'
import { createTraceBuilder } from '../trace/builder.js'
import { traced } from '../trace/client.js'
import { counted, usageLine } from './usage.js'
import type { Attributes } from '../trace/model.js'
import { exportTrace, sinksFromEnv, type TraceSink } from './trace-sink.js'
import { EntityGraph } from '../context/graph/entity-graph.js'
import { runGraph, type GraphOptions } from './commands/graph.js'
import { runShow } from './commands/show.js'
import { runRelations } from './commands/relations.js'
import { RELATION_LIMITS } from '../context/graph/relations.js'
import {
  ORGANISATION_RELATIONS,
  OWN_RELATIONS,
  type OrganisationRelation,
  type OwnRelation,
} from '../core/schemas/query.js'
import { runValidate } from './commands/validate.js'
import { PlanInputError, questionLines, runIntent, runPlan, type Ask } from './commands/plan.js'
import {
  openForSubmission,
  reopening,
  type Confirm,
  type SubmissionSummary,
  type SubmitOptions,
} from './commands/submit.js'
import { ForgeInputError } from '../forge/errors.js'
import { GitHubAnswerError } from '../forge/github/api.js'
import type { GitError } from '../process/git.js'
import type { GhError, GhProcess } from '../process/gh.js'
import { runProtection } from './commands/protection.js'
import { wantsColour } from './render/diff.js'
import {
  configFlagsOf,
  initAnswersOf,
  runInitPlatform,
  runInitRepo,
  type ConfigFlags,
  type InitAnswers,
} from './commands/init.js'
import { ConfigError } from './config.js'
import { isForgeHandle } from '../scaffold/codeowners.js'
import { VERSION } from '../core/index.js'
import type { LlmClient } from '../llm/client.js'
import type { CommandResult } from './commands/result.js'
import { cacheLines, copyAge, partialLine, pastBoundOf, setAsideLine, skippedLines } from './render/catalogue-read.js'
import { NOWHERE, NOWHERE_IN_CATALOGUE } from './render/entity.js'
import { inert, inertLine, oneLine, plain } from './render/plain.js'
import { homeOf, shownPath, type CacheRoot } from './personal.js'
import {
  RepositoryArgumentError,
  applicationRoot,
  initRoot,
  platformRoot,
  projectRoot,
  skipNotice,
  validateRoot,
  type DeclarationsCommand,
  type Inspection,
} from './repository.js'
import {
  blameOf,
  cacheFlagRefusal,
  cacheFlagWords,
  catalogueConfigured,
  catalogueFailureLine,
  declarationsFor,
  noCacheRefusal,
  overviewName,
  planNeedsRepository,
  protectionNeedsRepository,
  sourceNotice,
  sourceOf,
  type BackstageSource,
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
 * Where the read commands read from: `repo`, the declarations repository as
 * `plan --repo` means it, `demo`, the fictional SI, or `backstage`, the
 * configured catalogue. None is the rest of the chain — the working directory
 * when it is a declarations repository, what is configured, the demo SI —
 * absences rather than values, which is what exactOptionalPropertyTypes keeps
 * them. Two of them is unrepresentable, and refused at parsing.
 */
export type ReadFrom = ReadSource & CacheUse

/** `--repo`, `--demo` or `--backstage`: one of them, or none. */
type ReadSource =
  | { repo?: string; demo?: never; backstage?: never }
  | { demo: true; repo?: never; backstage?: never }
  | { backstage: true; repo?: never; demo?: never }

/**
 * How a catalogue's kept copy is used (`context/backstage/cache.ts`): neither,
 * a copy younger than five minutes answers; `refresh`, Backstage is read again
 * whatever is kept; `cached`, the kept copy answers whatever its age and
 * Backstage is never asked. Omitted when absent, never false; both at once,
 * or either beside --repo or --demo, is refused at parsing, and either
 * against a source that is not a catalogue once it is resolved.
 */
export type CacheUse =
  | { refresh?: never; cached?: never }
  | { refresh: true; cached?: never }
  | { cached: true; refresh?: never }

export type Command =
  | ({ name: 'graph'; options: GraphOptions } & ReadFrom)
  | ({ name: 'show'; query: string } & ReadFrom)
  /**
   * `relation` absent is every relation that holds something; `to` is every
   * path to another entity, and never comes with a relation. `depth` absent
   * is each relation's own bound (`RELATION_LIMITS`).
   */
  | ({
      name: 'relations'
      query: string
      relation?: OwnRelation | OrganisationRelation
      to?: string
      depth?: number
    } & ReadFrom)
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
  | {
      name: 'plan'
      source: PlanSource
      repo?: string
      json: boolean
      /**
       * `--submit`: the preview becomes a branch for review. Omitted rather
       * than false when absent, like every flag here that changes what a run
       * does: absent is stage 4's preview, byte for byte.
       */
      submit?: true
      /** `--local`: the branch stays in the clone, whatever the road; only beside `--submit`. */
      local?: true
    }
  /**
   * `idpa protection`: absent `repo` is found as `plan` finds it, never the
   * demo SI and never a catalogue (`source.ts`).
   */
  | { name: 'protection'; repo?: string }
  | { name: 'init-platform'; directory: string; owner: string }
  /**
   * Absent `repo` means the repository the user is standing in (§7.3).
   * `answers` are the person's own values for the three fields no file of a
   * service states reliably — its catalogue name, lifecycle and owner —
   * already held to what each field accepts.
   */
  | {
      name: 'init'
      repo?: string
      answers: InitAnswers
      /** `--submit`: the preview becomes a branch in the service's repository. Omitted when absent. */
      submit?: true
      /** `--local`: the branch stays in the clone, whatever the road; only beside `--submit`. */
      local?: true
      /**
       * `--iac-repo` and `--environment`, what `.idp-agent.yml` says — omitted
       * when neither was typed. No `backstage`: init has no --backstage option,
       * and a URL is never taken from a command line (D9, ADR-0011).
       */
      flags?: ConfigFlags
    }
  /**
   * `usage`, present when a command was asked for its own (`show --help`):
   * that command's lines of HELP, rather than all of it.
   */
  | { name: 'help'; usage?: Usage }
  | { name: 'version' }
  | { name: 'error'; message: string }

/**
 * What HELP has a usage line for: every command, `init platform` apart from
 * `init`, and `entry`, the phrase. `help` has none — it IS the help.
 */
export type Usage = Exclude<(typeof COMMANDS)[number], 'help'> | 'init-platform' | 'entry'

export const HELP = `idp-agent - turn an intent into reviewed infrastructure declarations

  idpa "<phrase>" [--repo <directory> | --demo | --backstage] [--refresh | --cached] [--project <directory>] [--json] [--quiet]

  The one gesture, from anywhere: a question about the SI is answered, an
  intent to change it is previewed as a plan, and the phrase need not say
  which. Quote it when it holds ?, *, !, quotes or parentheses, which the
  shell would read. --project and --json apply to a change only. ask and plan
  force a road: plan previews without classifying, and ask classifies and
  only answers, declining a change.

  An answer is the engine's, verified against the catalogue. The model may
  frame it with a sentence before and a few after, each checked by the engine
  and marked with ›; --quiet prints the verified answer alone.

  idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource|API] [--repo <directory> | --demo | --backstage] [--refresh | --cached]
  idp-agent show <name-or-reference> [--repo <directory> | --demo | --backstage] [--refresh | --cached]
  idp-agent relations <name-or-reference> [--consumes | --consumed-by | --depends-on | --impacts | --provides | --provided-by | --owns | --owned-by | --member-of | --has-member | --part-of | --has-part | --to <name-or-reference>] [--depth <n>] [--repo <directory> | --demo | --backstage] [--refresh | --cached]
  idp-agent ask "<question>" [--repo <directory> | --demo | --backstage] [--refresh | --cached] [--quiet]
  idp-agent validate <directory>
  idp-agent plan "<intent>" [--repo <directory>] [--project <directory>] [--json] [--submit [--local]]
  idp-agent plan --from <plan.json> [--repo <directory>] [--json] [--submit [--local]]
  idp-agent protection [--repo <directory>]
  idp-agent init [--repo <directory>] [--name <name>] [--lifecycle experimental|production|deprecated] [--owner group:<namespace>/<name>] [--submit [--local]] [--iac-repo <locator>] [--environment <name>]...
  idp-agent init platform <directory> --owner @org/team
  idp-agent version

  -h and --help print this; <command> --help prints that command's usage.
  --version and -v print the version, as version does.

  relations traces an entity's declared relations, each with its whole path
  and the rights and levels on it: what it consumes through its rights and
  who consumes it, what it depends on and what depends on it, the APIs it
  provides, or every path to another entity with --to. It traces the
  organisation too: what a team or a person owns, down its child teams, who
  owns something and the groups above, a person's groups and a group's
  members, and what a System or a Domain holds and what holds it. Without a
  flag, every relation that holds something. It needs no model and no key.

  protection checks, through your gh and with reads only, that the branch the
  clone tracks on github.com keeps a pull request from merging until someone
  other than its opener approves its latest commit, and prints the ruleset to
  add when it does not. It needs gh logged in to github.com as you, and no
  model; it writes nothing.

  init previews the catalog-info.yaml of the service it is run in, or adds to
  the one the repository keeps. --name, --lifecycle and --owner answer what
  its files do not state; at a terminal it asks instead. --iac-repo and
  --environment, repeated, state the service's .idp-agent.yml, which is
  previewed beside it — from what was typed or answered, never from the
  inspection, and never over a committed one that says otherwise. With
  --submit, both go on one branch idp-agent/… cut from HEAD in the service's
  repository, which must be a git clone's root; a service in a subfolder of
  its repository is not submitted yet.

  idpa is idp-agent. Every command but init and validate finds the
  declarations repository the same way: --repo, else the current directory
  when it is one, else IDP_REPO, else repo in the personal config.yml
  ($XDG_CONFIG_HOME/idp-agent/, else ~/.config/idp-agent/). With none, graph,
  show, relations and a question read the fictional demo SI, as --demo does,
  and a change or idpa protection is refused. A change inspects the service
  --project names, or the current directory when it is an application
  repository (a catalog-info.yaml or a package manifest at its root), and
  otherwise drafts from the catalogue alone.
  A Backstage catalogue answers graph, show, relations and a question when
  IDP_BACKSTAGE_URL, or backstage in the personal config.yml, names its API's
  base (https://<backend host>/api/catalog), ahead of IDP_REPO and repo but
  never of --repo or the current directory; --backstage chooses it over both.
  It is read once per run, with the token in IDP_BACKSTAGE_TOKEN, and a
  change is still decided against a declarations repository, never it.
  A read is kept five minutes under $XDG_CACHE_HOME/idp-agent/backstage
  (else ~/.cache/…), for your account alone, and a run within them answers
  from it and says how old it is; --refresh reads Backstage again, --cached
  answers from the kept copy whatever its age and never asks Backstage, and
  IDP_BACKSTAGE_CACHE=off keeps nothing.
  A phrase, ask, plan "<intent>" and init need IDP_PROVIDER and IDP_MODEL. None
  of them writes, and neither do plan and init without --submit. With it, plan cuts
  a branch idp-agent/… from HEAD in the declarations repository, which must
  be a git clone's root, for review. When the checked-out branch tracks one
  on github.com, both forms of plan push that branch with your git and open
  a pull request into it with your gh, once gh is logged in and the base's
  ruleset keeps you from merging it unreviewed (idpa protection says whether
  it does); --local keeps the branch in the clone. plan "<intent>" --submit
  crosses five gates, the Reviewer last, and reads the road, gh and the
  base's rules before any model is paid, refusing a repository that cannot
  take the branch, or a service whose .idp-agent.yml names another
  repository; plan --from crosses four gates and no Reviewer. Either way
  the merge authorises. Every model-backed command also needs that
  provider's key (ANTHROPIC_API_KEY, MISTRAL_API_KEY or OPENAI_API_KEY);
  IDP_TIMEOUT bounds each model call, in seconds, 120 by default.
  IDP_SUPERVISOR_MODEL gives the Supervisor, which only classifies a phrase,
  another model of the same provider; unset, it uses IDP_MODEL.
`

/** `--local` alone: it says where a submission's branch goes, and nothing is submitted. */
const LOCAL_WITHOUT_SUBMIT =
  '--local says where --submit cuts its branch, and there is no --submit here: add --submit, or leave --local out'

export function parseArguments(argv: string[]): Command {
  const [commandName, ...rest] = argv
  if (
    commandName === undefined ||
    commandName === 'help' ||
    commandName === '--help' ||
    commandName === '-h'
  ) {
    return { name: 'help' }
  }
  // A command asked for its usage is answered before its arguments are read:
  // `show --help` was refused as an unknown option, on exit 2 with the whole
  // HELP, and `ask --help` once went to a model as the question.
  const usage = usageAsked(commandName, rest)
  if (usage !== undefined) return { name: 'help', usage }

  if (commandName === 'version' || commandName === '--version' || commandName === '-v') {
    // Nothing after it: `idpa version of billing-api` is a question that
    // begins like a command, as `idpa show me the databases` is, and it is
    // refused rather than answered with a version number — and so is
    // `--version` with a word after it, or the two spellings would disagree.
    if (rest.length > 0) {
      return {
        name: 'error',
        message: `${commandName} takes no argument; to ask something, quote the whole phrase: idpa "<phrase>"`,
      }
    }
    return { name: 'version' }
  }

  if (commandName === 'init') {
    if (rest[0] !== 'platform') {
      try {
        const { values } = parseArgs({
          args: rest,
          options: {
            repo: { type: 'string' },
            name: { type: 'string' },
            lifecycle: { type: 'string' },
            owner: { type: 'string' },
            submit: { type: 'boolean' },
            local: { type: 'boolean' },
            // Several, so a second is refused rather than kept in silence (`configFlagsOf`).
            'iac-repo': { type: 'string', multiple: true },
            environment: { type: 'string', multiple: true },
          },
          strict: true,
        })
        // Refused here, as a bad flag, rather than after an inspection a
        // model was paid for: the same rules an answer typed at the prompt is
        // held to (`initAnswersOf`, `configFlagsOf`).
        const answers = initAnswersOf(values)
        if ('refused' in answers) return { name: 'error', message: answers.refused }
        const config = configFlagsOf(values)
        if ('refused' in config) return { name: 'error', message: config.refused }
        if (values.local === true && values.submit !== true) return { name: 'error', message: LOCAL_WITHOUT_SUBMIT }
        // Omitted rather than passed as undefined: exactOptionalPropertyTypes
        // draws the distinction, and "the directory I am standing in" is an
        // absence rather than a value main has to invent here.
        return {
          name: 'init',
          ...(values.repo !== undefined ? { repo: values.repo } : {}),
          answers: answers.answers,
          ...(values.submit === true ? { submit: true as const } : {}),
          ...(values.local === true ? { local: true as const } : {}),
          ...(Object.keys(config.flags).length > 0 ? { flags: config.flags } : {}),
        }
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
      const directory = oneDirectory('init platform', positionals)
      if (typeof directory !== 'string') return directory
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
    try {
      // Strict, where the first argument used to be the directory whatever it
      // was: `validate --help` read a folder named "--help", found nothing
      // there, and answered "0 violations" on exit 0.
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true, strict: true })
      const directory = oneDirectory('validate', positionals)
      if (typeof directory !== 'string') return directory
      return { name: 'validate', directory }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
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
          submit: { type: 'boolean' },
          local: { type: 'boolean' },
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
      if (values.local === true && values.submit !== true) return { name: 'error', message: LOCAL_WITHOUT_SUBMIT }
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
        ...(values.submit === true ? { submit: true as const } : {}),
        ...(values.local === true ? { local: true as const } : {}),
      }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  if (commandName === 'protection') {
    try {
      // Strict, and no positional: a word after it would otherwise be read
      // as nothing at all, and --local, --json or --demo mean nothing here.
      const { values, positionals } = parseArgs({
        args: rest,
        options: { repo: { type: 'string' } },
        allowPositionals: true,
        strict: true,
      })
      if (positionals.length > 0) {
        return { name: 'error', message: `protection takes no argument but --repo, not ${positionals.join(', ')}` }
      }
      return { name: 'protection', ...(values.repo !== undefined ? { repo: values.repo } : {}) }
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

  if (commandName === 'relations') return parseRelations(rest)

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
export const COMMANDS = [
  'graph',
  'show',
  'relations',
  'ask',
  'validate',
  'plan',
  'protection',
  'init',
  'help',
  'version',
] as const

const isCommand = (word: string): word is (typeof COMMANDS)[number] =>
  COMMANDS.some((name) => name === word)

/**
 * The usage a command's arguments ask for with `--help` or `-h`, or
 * `undefined`. Only before a `--`: after it every argument is a word, as
 * parseArgs reads it, so `ask -- --help` asks about "--help". A phrase asks
 * for its own line, `idpa "<phrase>"`, and `help` never gets here.
 */
function usageAsked(first: string, rest: readonly string[]): Usage | undefined {
  const all = [first, ...rest]
  const end = all.indexOf('--')
  const options = end === -1 ? all : all.slice(0, end)
  if (!options.some((argument) => argument === '--help' || argument === '-h')) return undefined
  return usageOfArguments(all)
}

/**
 * Whose usage an argument list is about: the command it starts with — `init
 * platform` apart from `init`, `--version` and `-v` as `version` — or the
 * phrase. A command typed after its options (`idpa --repo x show …`) is about
 * the phrase too; its refusal names the command.
 */
function usageOfArguments(argv: readonly string[]): Usage {
  const [first, second] = argv
  if (first === 'init' && second === 'platform') return 'init-platform'
  if (first === '--version' || first === '-v') return 'version'
  if (first === undefined || !isCommand(first) || first === 'help') return 'entry'
  return first
}

/**
 * The lines of HELP for one command: a usage, not the whole page, which a
 * refused argument used to print in full under a one-line reason.
 */
export function usageOf(usage: Usage): string {
  const starts =
    usage === 'entry'
      ? ['  idpa "<phrase>"']
      : usage === 'init-platform'
        ? ['  idp-agent init platform ']
        : [`  idp-agent ${usage} `, `  idp-agent ${usage}\n`]
  const lines = HELP.split('\n').filter(
    (line) =>
      starts.some((start) => `${line}\n`.startsWith(start)) &&
      // `init`'s lines are not `init platform`'s.
      !(usage === 'init' && line.startsWith('  idp-agent init platform')),
  )
  return `usage:\n${lines.join('\n')}\n\nidpa --help describes every command.\n`
}

/**
 * The one directory a command takes, or its refusal: none, an empty one — which
 * resolves to the working directory, the one directory the argument was typed
 * to avoid (`"$IAC"` with the variable unset) — or a second, which used to be
 * dropped in silence. A directory that starts with a dash is refused before
 * this, by parseArgs, as an option it does not know; `-- -dir` names one.
 */
function oneDirectory(
  command: 'validate' | 'init platform',
  positionals: readonly string[],
): string | { name: 'error'; message: string } {
  const [directory] = positionals
  if (directory === undefined) return { name: 'error', message: `${command} needs a directory` }
  if (positionals.length > 1) {
    return {
      name: 'error',
      message: `${command} takes one directory, not ${positionals.length}: ${positionals.join(', ')}`,
    }
  }
  if (directory.trim() === '') {
    return { name: 'error', message: `${command} needs a directory, and "${directory}" names none` }
  }
  return directory
}

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
        // Read only to be refused in words (D8), rather than as an option
        // this does not know.
        submit: { type: 'boolean' },
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
    // D8: a phrase reaches the Supervisor before it is known to be a change,
    // and a submission refuses a repository that cannot take it before any
    // model is paid. Until the entry does that too, a change is submitted by
    // plan, by either road.
    if (values.submit === true) {
      return {
        name: 'error',
        message:
          'idpa "<phrase>" does not submit; a change is submitted with plan "<intent>" --submit, ' +
          'or plan --from <plan.json> --submit',
      }
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

/** The commands that read the declarations and call no model. */
const KEYLESS: ReadonlySet<string> = new Set(['graph', 'show', 'relations', 'validate', 'protection', 'help', 'version'])

/**
 * What to say after a phrase could not reach a model, when its first word is
 * a slip of a command — `idpa relation billing-api` is `relations`, typed
 * one letter short, followed by a name. Said only then: parsing is not
 * changed by it, for a sentence may begin with any word, and a phrase that
 * reached a model was the model's to classify. A first word that IS a
 * command is not a slip; `show me the databases` is a sentence.
 */
function slipHint(phrase: string): string | undefined {
  const first = phrase.split(/\s+/)[0] ?? ''
  if (isCommand(first)) return undefined
  const meant = nearestCommand(first)
  if (meant === undefined) return undefined
  return `"${first}" is not a command; did you mean idpa ${meant}?${KEYLESS.has(meant) ? ' It needs no model' : ''}`
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
 * Two commands share a first letter, `validate` and `version`, and the nearer
 * of the two is the one meant; no word is within a slip of both — they are
 * seven edits apart — so there is never a tie to break.
 */
function nearestCommand(word: string): string | undefined {
  const typed = word.toLowerCase()
  const within = COMMANDS.flatMap((name) => {
    if (typed[0] !== name[0]) return []
    const long = name.length >= 4
    const tolerated = typed.length === name.length ? (long ? 2 : 1) : long ? 1 : 0
    const distance = edits(typed, name)
    return distance <= tolerated ? [{ name, distance }] : []
  })
  return within.sort((left, right) => left.distance - right.distance)[0]?.name
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

/**
 * A relation flag, and the relation it asks for: `--consumed-by` is
 * `consumed-by`. An entity's relations, then the organisation's.
 */
const RELATION_FLAGS: ReadonlyArray<OwnRelation | OrganisationRelation> = [
  ...OWN_RELATIONS,
  ...ORGANISATION_RELATIONS,
]

/**
 * `relations <name-or-reference>`: one name, as `show` takes it; at most one
 * relation flag, or `--to` and none; a depth that is a whole number within
 * the bound. Each refusal is the arguments', exit 2, before anything is read.
 */
function parseRelations(rest: string[]): Command {
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        ...Object.fromEntries(RELATION_FLAGS.map((flag) => [flag, { type: 'boolean' as const }])),
        to: { type: 'string' },
        depth: { type: 'string' },
        ...READ_OPTIONS,
      },
      allowPositionals: true,
      strict: true,
    })
    const query = positionals[0]
    if (query === undefined) {
      return { name: 'error', message: 'relations needs a name or a reference' }
    }
    if (positionals.length > 1) {
      return {
        name: 'error',
        message: `relations takes one name or reference, not ${positionals.length}: ${positionals.join(', ')}`,
      }
    }
    const flags = values as Record<string, unknown>
    const chosen = RELATION_FLAGS.filter((flag) => flags[flag] === true)
    if (chosen.length > 1) {
      return {
        name: 'error',
        message:
          `relations takes one of ${RELATION_FLAGS.map((flag) => `--${flag}`).join(', ')}, ` +
          `not ${chosen.map((flag) => `--${flag}`).join(' and ')}`,
      }
    }
    const [relation] = chosen
    const to = typeof flags['to'] === 'string' ? flags['to'] : undefined
    if (to !== undefined && relation !== undefined) {
      return {
        name: 'error',
        message: `--to asks for the paths between two entities, and takes no relation: drop --${relation}`,
      }
    }
    const typed = typeof flags['depth'] === 'string' ? flags['depth'] : undefined
    const depth = typed === undefined ? undefined : Number(typed)
    if (
      typed !== undefined &&
      (!/^\d+$/.test(typed) || depth === undefined || depth < 1 || depth > RELATION_LIMITS.maxDepth)
    ) {
      return {
        name: 'error',
        message: `--depth takes a whole number from 1 to ${RELATION_LIMITS.maxDepth}`,
      }
    }
    const from = readFrom('relations', values)
    if ('message' in from) return from
    return {
      name: 'relations',
      query,
      ...(relation !== undefined ? { relation } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...from,
    }
  } catch (error) {
    return { name: 'error', message: (error as Error).message }
  }
}

/**
 * The three options that say where a read command's SI comes from.
 * `--backstage` takes no value: it chooses the configured catalogue, and a URL
 * typed here would send the configured token to whatever was typed.
 */
const READ_OPTIONS = {
  repo: { type: 'string' },
  demo: { type: 'boolean' },
  backstage: { type: 'boolean' },
  refresh: { type: 'boolean' },
  cached: { type: 'boolean' },
} as const

/**
 * `--repo`, `--demo` or `--backstage`, each omitted rather than undefined when
 * not given. Two of them is refused rather than one winning: the user named
 * two sources and there is no answer to which one they meant.
 */
function readFrom(
  command: 'graph' | 'show' | 'relations' | 'ask' | 'idpa',
  values: {
    repo?: string | undefined
    demo?: boolean | undefined
    backstage?: boolean | undefined
    refresh?: boolean | undefined
    cached?: boolean | undefined
  },
): ReadFrom | { name: 'error'; message: string } {
  const source = sourceFrom(command, values)
  if ('message' in source) return source
  if (values.refresh === true && values.cached === true) {
    return {
      name: 'error',
      message: `${command} takes --refresh or --cached, never both: one reads Backstage again and the other only the kept copy`,
    }
  }
  const flag = values.cached === true ? '--cached' : values.refresh === true ? '--refresh' : undefined
  if (flag === undefined) return source
  // A repository or the fictional SI keeps no copy: the flag would do nothing, and silence would say it did.
  if (values.repo !== undefined || values.demo === true) {
    return {
      name: 'error',
      message: `${cacheFlagWords(flag)}, and ${values.repo !== undefined ? '--repo names a repository' : '--demo names the fictional SI'}`,
    }
  }
  return { ...source, ...(values.cached === true ? { cached: true as const } : { refresh: true as const }) }
}

/** `--repo`, `--demo` or `--backstage`, as `readFrom` takes them. */
function sourceFrom(
  command: 'graph' | 'show' | 'relations' | 'ask' | 'idpa',
  values: { repo?: string | undefined; demo?: boolean | undefined; backstage?: boolean | undefined },
): ReadSource | { name: 'error'; message: string } {
  if (values.demo === true && values.repo !== undefined) {
    return {
      name: 'error',
      message: `${command} takes --repo <directory> or --demo, never both: one names your declarations repository and the other the fictional SI`,
    }
  }
  if (values.backstage === true && (values.demo === true || values.repo !== undefined)) {
    return {
      name: 'error',
      message:
        `${command} takes one of --repo <directory>, --demo or --backstage, never two: --backstage ` +
        'reads the configured catalogue, and the others a repository or the fictional SI',
    }
  }
  if (values.demo === true) return { demo: true }
  if (values.backstage === true) return { backstage: true }
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
  /**
   * How a submission is confirmed (§7.4 step 7). Injected for the reason `ask`
   * is; left out, `confirmOf` decides from the process whether anyone is there.
   */
  confirm?: Confirm
  /**
   * Where a finished run's trace goes, beside the sinks the environment
   * configures (`IDP_MLFLOW_TRACKING_URI`, `IDP_TRACE_DIR`). Injected so a test
   * reads the trace itself rather than a file or a server. With neither this
   * nor those variables, which is every run by default, nothing is traced.
   */
  traceSinks?: readonly TraceSink[]
  /** The MLflow sink's transport. Injected for tests; a real run uses the global one. */
  fetch?: typeof globalThis.fetch
  /**
   * The catalogue's transport. Injected for tests; a real run hands the global
   * one to the transport, which never reaches for it itself. Distinct from
   * `fetch`: the catalogue's token is sent through this and nothing else.
   */
  catalogueFetch?: CatalogueFetch
  /**
   * How a vector reaches gh: the fake GitHub a test hands in
   * (`tests/support/fake-gh.ts`), and the real gh otherwise — the launcher's
   * own `spawnGh`, which `cli/` never loads. A type, erased: only
   * `forge/github/` loads the gh launcher.
   */
  gh?: GhProcess
  /** Lowered by a test to reach a bound of the catalogue read; a run keeps `BACKSTAGE_LIMITS`. */
  catalogueLimits?: Partial<BackstageLimits>
  /**
   * Where a catalogue read is kept (`cacheRootOf`), or why none is. Absent is
   * none, as in every test but the cache's own: `bin.ts` passes
   * `cacheRootOf(process.env, process.platform, process.getuid?.())`, and
   * nothing here defaults it, so no test that passes a HOME keeps a copy
   * between two of its runs.
   */
  cacheRoot?: CacheRoot
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
      // No reason: it is the error `failed` prints, as the run's last line,
      // and said here too it would reach the user twice.
      return `! ${event.agent} stopped`
    case 'ask':
    case 'answer:ready':
      return undefined
    case 'usage':
      // One per model call, which is noise on a terminal: the run's total is
      // one line at its end (`usageLine`), said by `agentBacked`.
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

/** A line the CLI says on stderr, whole and inert: it quotes a folder's name. */
const toStderr =
  (err: (chunk: string) => void) =>
  (line: string): void =>
    err(`${whole(line)}\n`)

/**
 * A reason on the event stream: one line, bounded at `oneLine`'s 200, and the
 * bidi controls spelled out as well — `plan` streams the Reviewer's and the
 * gates' reasons here, the same words its stdout quotes.
 */
const said = (text: string): string => inertLine(text, 200)

/**
 * The terminal's sink, one per run.
 *
 * A `derived` line is said once per path and owner per run, whoever emitted it.
 * `repair` says it once per path per call, but a run that asks is a call per
 * round, and the owner's `idpa "<change>"` printed the same owner line twice —
 * `plan --from` would print it once per round too. The stream keeps every
 * emission, because the trace draws each round's derivation on that round's
 * span; the reader of stderr needs the fact, not the count. A second owner for
 * the same path is news — the terminal saw the first — and is printed.
 */
const progress = (err: (chunk: string) => void): EventSink => {
  const derived = new Set<string>()
  return (event) => {
    if (event.type === 'derived') {
      const key = `${event.path}\u0000${event.owner}`
      if (derived.has(key)) return
      derived.add(key)
    }
    const line = renderEvent(event)
    if (line !== undefined) err(`${line}\n`)
  }
}

/**
 * 0 succeeded · 1 the query resolved nothing · 2 the arguments were refused ·
 * 3 the request was understood and this build will not act on it · 130 the
 * person pressed Ctrl-C at a question, the code a shell gives a command
 * SIGINT ended (128 + 2), which is what a script checks for.
 */
export const EXIT = { ok: 0, notFound: 1, badUsage: 2, unsupported: 3, interrupted: 130 } as const

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
    out(command.usage === undefined ? HELP : usageOf(command.usage))
    return EXIT.ok
  }
  if (command.name === 'version') {
    out(`${VERSION}\n`)
    return EXIT.ok
  }
  if (command.name === 'error') {
    // The usage of the command that was refused, not the whole page: a
    // reason of one line read as a footnote to eighty. A phrase refused still
    // gets every command — a slip, or a command typed after its options, is
    // exactly the reader who needs the list.
    const refused = usageOfArguments(argv)
    err(`${command.message}\n\n${refused === 'entry' ? HELP : usageOf(refused)}`)
    return EXIT.badUsage
  }

  if (command.name === 'init') {
    // Resolved against the working directory, because §7.3 is run once per
    // application from inside it, and `--repo` is how someone standing
    // elsewhere says which one.
    //
    // Refused before a model is chosen when it is not a directory, or is the
    // home directory or the filesystem root, as `plan` skips those two
    // (security-3): a directory is an argument, and an argument is refused
    // before the configuration is. One that did not exist was inspected — as
    // nothing — by a model somebody paid for (review, gap-init-real-repos-6).
    let project: string
    try {
      project = await initRoot({
        repo: command.repo,
        cwd: () => deps.cwd ?? process.cwd(),
        home: homeOf(deps.env ?? process.env),
      })
    } catch (error) {
      return failed(error, err)
    }
    // --submit's repository, the service's own, opened before a model is
    // configured, as `plan "<intent>"` opens its own: a directory that cannot
    // take a branch — not a clone's root, a service in a subfolder of its
    // repository (D12), nobody to commit as, a detached HEAD — is an argument,
    // refused before anyone is told to set a key. `runInitRepo` is handed this
    // forge and reads its base again. Toward GitHub, init does not open a
    // pull request yet, and says so here, before gh and before any model.
    let submit: SubmitOptions | undefined
    if (command.submit === true) {
      const confirm = confirmOf(deps, false)
      try {
        const opened = await openForSubmission(project, 'service', {
          ...submissionOf(deps, command.local === true, err),
          route: 'init',
        })
        submit = {
          ...(confirm !== undefined ? { confirm } : {}),
          open: reopening(opened, project, 'service'),
        }
      } catch (error) {
        return failed(error, err)
      }
    }
    return agentBacked(
      deps,
      err,
      out,
      { command: 'init', scenario: 'init', inputs: { command: 'init', project } },
      async (client, emit) => {
        // The terminal, as `plan` asks (§7.5): a question `init` cannot answer
        // from the repository's files is put to the person when there is one.
        const ask = askOf(deps)
        return runInitRepo({
          project,
          client,
          emit,
          answers: command.answers,
          ...(ask !== undefined ? { ask } : {}),
          colour: colourOf(deps),
          notice: toStderr(err),
          ...(submit !== undefined ? { submit } : {}),
          ...(command.flags !== undefined ? { flags: command.flags } : {}),
        })
      },
    )
  }

  if (command.name === 'init-platform') {
    // Resolved, not contained. This command CREATES the repository, so its
    // root has no reason to sit under the working directory —
    // `init platform ~/my-iac` is the first thing anyone types. Containment
    // belongs to the files written UNDER that root, and `scaffold/write.ts`
    // checks every one of them against it; applying it to the root itself
    // refused a path the user typed in their own shell. A file there is
    // refused, exit 2, as `init --repo` refuses one.
    let root: string
    try {
      root = await platformRoot(command.directory, () => deps.cwd ?? process.cwd())
    } catch (error) {
      return failed(error, err)
    }
    const result = await runInitPlatform({ root, owner: command.owner, version: VERSION })
    out(`${result.text}\n`)
    // stderr, like every line meant for a person: stdout stays the file list —
    // the sentence about a failed write included.
    if (result.notice !== undefined) err(`${result.notice}\n`)
    // A write that failed part-way: the list says what it left, and the run
    // failed — something failed unexpectedly is exit 1.
    return result.found ? EXIT.ok : EXIT.notFound
  }

  // The branch a declarations repository's clone tracks on github.com,
  // through the person's gh: found as `plan` finds its repository, never the
  // demo SI or a catalogue, and said on stderr when it was not typed. No
  // model is chosen, so none can be called, and nothing is written.
  if (command.name === 'protection') {
    const context = sourceContextOf(deps)
    let declarations: RepositorySource | undefined
    try {
      declarations = await sourceOf({ command: 'protection', repo: command.repo }, context)
    } catch (error) {
      return failed(error, err)
    }
    if (declarations === undefined) {
      err(`${protectionNeedsRepository(context)}\n\n${usageOf('protection')}`)
      return EXIT.badUsage
    }
    const notice = sourceNotice('protection', declarations, context)
    if (notice !== undefined) err(`${notice}\n`)
    let result: CommandResult
    try {
      result = await runProtection({
        repo: declarations.root,
        env: deps.env ?? process.env,
        ...(deps.gh === undefined ? {} : { gh: deps.gh }),
        notice: toStderr(err),
      })
    } catch (error) {
      return failed(error, err)
    }
    return report(result, out)
  }

  // Reads the directory it was handed, so it must not go through the fixture
  // load every other command needs.
  //
  // The directory is refused on exit 2 when it is none, as every other
  // command's is: this is the command CI runs, and a path that was not there
  // — or a file — answered "0 violations" on exit 0 (review, cli-ux-1).
  if (command.name === 'validate') {
    let result: CommandResult
    try {
      const root = await validateRoot(command.directory, () => deps.cwd ?? process.cwd())
      result = await runValidate(root)
    } catch (error) {
      return failed(error, err)
    }
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
      err(`${planNeedsRepository(context)}\n\n${usageOf('plan')}`)
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
      // A Plan in a file: no model is involved and none can be. With --submit
      // it crosses four gates — the schema, the signature, the policies, the
      // re-check — and no Reviewer, and its branch still cannot reach the
      // default one: the merge authorises (ADR-0006, D4).
      const confirm = confirmOf(deps, command.json)
      const submit: SubmitOptions | undefined =
        command.submit === true
          ? { ...(confirm !== undefined ? { confirm } : {}), ...submissionOf(deps, command.local === true, err) }
          : undefined
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
          ...(submit !== undefined ? { submit } : {}),
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

    // --submit's repository, opened on this side of the model too, and for
    // the same reason: a directory that cannot take a branch — not a clone's
    // root, nobody to commit as, a detached HEAD — is an argument, and is
    // refused before the configuration is. So, where the checked-out branch
    // tracks one on github.com, are the road and gh (stage 6 brief § 3, steps
    // 2 and 3): a clone configured to redirect the push, a remote that does
    // not parse, a gh missing, logged out, too old or not a person. Every
    // exit 2 of a submission is said here, before the configuration, and the
    // line naming the GitHub road with it. Nobody is told to set a key only to
    // learn the directory could never take the branch, and nothing is paid
    // for a refusal. `runIntent` is handed this forge, reads its base again
    // and judges the working tree against it, before its Inspector.
    //
    // Divergence is judged there, AFTER the configuration, and so are the
    // service's iacRepo and the base's rules (§ 8, § 13): none is an
    // argument, each is a repository's state, a negative answer (exit 1), and
    // judging it here would read the catalogue or GitHub before a model is
    // known to exist. So a clone with an uncommitted catalogue file and no
    // model configured answers "no model configured" first, and the
    // divergence once one is. Neither order pays a model for a refusal.
    let submit: SubmitOptions | undefined
    if (command.submit === true) {
      const confirm = confirmOf(deps, command.json)
      try {
        const opened = await openForSubmission(roots.repo, 'declarations', {
          ...submissionOf(deps, command.local === true, err),
          route: 'intent',
        })
        submit = {
          ...(confirm !== undefined ? { confirm } : {}),
          open: reopening(opened, roots.repo, 'declarations'),
        }
      } catch (error) {
        return failed(error, err)
      }
    }

    return agentBacked(
      deps,
      err,
      out,
      {
        command: 'plan',
        scenario: 'plan',
        // The repositories the run reads, resolved: what was typed may be
        // nothing at all, and a trace says where the preview was decided.
        inputs: {
          command: 'plan',
          intent: source.intent,
          repo: roots.repo,
          ...(project !== undefined ? { project } : {}),
        },
        // A skipped Inspector is a line on stderr and an absent `project`; the
        // root keeps the line, or a trace would show the absence and not why.
        ...(roots.project.kind === 'none'
          ? { attributes: { 'idp.inspector': 'skipped', 'idp.inspector.reason': roots.project.reason } }
          : {}),
      },
      async (client, emit) =>
      runIntent({
        intent: source.intent,
        repo: roots.repo,
        ...(ask !== undefined ? { ask } : {}),
        project,
        client,
        emit,
        json: command.json,
        colour,
        notice: toStderr(err),
        ...(submit !== undefined ? { submit } : {}),
      }),
    )
  }

  // The one decision the read commands make about where the SI comes from;
  // everything after the provider is the same for all three roads.
  const name = command.name === 'entry' ? 'idpa' : command.name
  const context = sourceContextOf(deps)
  let read: Read
  try {
    // A phrase finds its SI as `ask` does, and says so in `ask`'s line: its
    // question road IS `ask`'s. Its refusals name `idpa`, which is what was
    // typed.
    read = await providerOf(name, command, deps)
  } catch (error) {
    return failed(error, err)
  }
  // What a phrase's change is decided against, resolved on its own: `plan`'s
  // chain, whatever the question side reads, and none for `--demo`. A
  // catalogue answers the read ahead of IDP_REPO and the file's repo, so this
  // is what still refuses a broken one, exit 2 — and before the load, so
  // before any request to the catalogue (backstage-read.test.ts pins it).
  let declarations: RepositorySource | undefined
  if (command.name === 'entry') {
    try {
      declarations = await declarationsFor(
        { command: 'idpa', repo: command.repo, demo: command.demo },
        context,
      )
    } catch (error) {
      return failed(error, err)
    }
  }
  const { provider, source } = read

  // Once per run, before any model is chosen or called. A catalogue that
  // cannot be read ends the run in one line, exit 1, and is never answered
  // from a repository or the demo SI instead. One read up to a stated bound
  // is answered from, and every answer says it is partial (ADR-0013).
  let loaded: LoadResult
  // This run's own time to load: what a run answered from a copy is traced
  // with, rather than the census the copy keeps of the load that made it.
  const loadStarted = performance.now()
  try {
    loaded = await provider.load()
  } catch (error) {
    if (error instanceof CatalogueReadError && source.kind === 'backstage') {
      // Why `--cached` found no copy it could read, before the line that says it found none.
      const why = error.notUsed === undefined ? [] : cacheLinesOf({ read: { state: 'not-used', refusal: error.notUsed } }, deps, context)
      for (const line of why) err(`${line}\n`)
      err(`${inertLine(catalogueFailureLine(error, source, tokenOf(context) !== undefined), Number.POSITIVE_INFINITY)}\n`)
      return EXIT.notFound
    }
    return failed(error, err)
  }
  const loadMs = Math.round(performance.now() - loadStarted)
  const { entities, rejected, ignored, unread } = loaded
  // Read beside the entities, and counted as read: a Group is no longer a
  // document this tool does not model.
  const organisation = loaded.organisation ?? []
  // The set-asides of a catalogue read's pre-pass are counted under their own
  // term, never among the kinds not modelled, so nothing is counted twice.
  const notModelled = ignored.filter(({ prePass }) => prePass === undefined)
  const setAside = ignored.length - notModelled.length

  // Said after the load, so a catalogue's line carries what it served.
  // Nothing is printed during a load, so a repository's or the demo SI's
  // stderr is what it always was.
  const notice = sourceNotice(name, source, context, {
    counts: {
      ...(loaded.census === undefined ? {} : { census: loaded.census }),
      entities: entities.length + organisation.length,
      notModelled: notModelled.length,
      setAside,
      skipped: rejected.length,
      ...(loaded.partial === undefined ? {} : { pastBound: pastBoundOf(loaded.partial) }),
    },
    catalogue:
      source.kind === 'repo' && source.origin.by === 'working-directory' && (await catalogueConfigured(context)),
    ...(answeredFromCopy(loaded.cache)
      ? { copy: { age: copyAge(loaded.cache.read, Date.now()), cached: loaded.cache.read.state === 'kept' } }
      : {}),
  })
  if (notice !== undefined) err(`${notice}\n`)
  // A copy that was not used, a read that was not kept: said once, after the notice.
  if (loaded.cache !== undefined) for (const line of cacheLinesOf(loaded.cache, deps, context)) err(`${line}\n`)
  // Reported, never dropped in silence: that silent drop is the catalogue
  // behaviour this tool exists to compensate for (design 4.4).
  // Both halves are the file's own words: a path is a name somebody chose, and
  // a reason quotes the key it faults. Flattened and cleaned, never cut — the
  // line is how the user finds the file and what to fix in it. A catalogue's
  // are grouped by reason instead: one line each would flood a terminal on a
  // catalogue of thousands (`catalogue-read.ts`).
  if (source.kind === 'backstage') {
    for (const line of skippedLines(rejected)) err(`${line}\n`)
  } else {
    for (const rejection of rejected) {
      err(`skipped ${whole(rejection.source)}: ${whole(rejection.reason)}\n`)
    }
  }
  if (notModelled.length > 0) err(`${notLoaded(notModelled)}\n`)
  // After the kinds not modelled, whose `not loaded:` it never begins with:
  // what a bound left out is counted in words of its own, and said only when
  // a read stopped at one, so a whole read's stderr is what it always was.
  if (loaded.partial !== undefined && loaded.partial.length > 0) err(`${partialLine(loaded.partial)}\n`)
  const aside = setAsideLine(ignored)
  if (aside !== undefined) err(`${aside}\n`)
  if (unread.length > 0) err(`${notRead(unread)}\n`)
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
  // catalogue, only not of anything this tool models — and so is one whose
  // Groups and Users are read. A mkdocs.yml alone is what an application
  // repository looks like, so that still gets the line.
  const catalogue = organisation.length > 0 || ignored.some((document) => document.kind !== undefined)
  // Only for a repository something named — `--repo`, IDP_REPO, the personal
  // file — and naming that something, which is what the user goes and fixes.
  // A working directory is read because its witnesses say it is a declarations
  // repository, so an empty one is the freshly scaffolded state and there is
  // nothing to blame. A catalogue that serves nothing is blamed as one: what
  // it serves is what its token may read.
  const blamed = blameOf(source)
  if (blamed !== undefined && entities.length === 0 && rejected.length === 0 && !catalogue) {
    err(
      source.kind === 'backstage'
        ? `the Backstage catalogue at ${oneLine(source.label)} serves no entity this token reads; ${oneLine(blamed)} names it\n`
        : `${oneLine(source.label)} declares no entity; ${oneLine(blamed)} names the declarations repository\n`,
    )
  }

  // The organisation beside the entities, and never among them: every table,
  // summary and tool row built from `all()` is what it was. Its references
  // are judged only where a catalogue read their kind whole.
  const graph = EntityGraph.from(
    entities,
    ignored.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
    { nodes: organisation, judged: new Set(loaded.judged ?? []) },
    // A reference into what a bound left out is not loaded, never declared nowhere.
    loaded.partial ?? [],
  )
  // A catalogue serves only what its token may read, so a reference it does
  // not serve may be declared all the same; a repository's is declared
  // nowhere. What the agents' tools say to a model does not change.
  const said = source.kind === 'backstage' ? NOWHERE_IN_CATALOGUE : NOWHERE
  // The overview names what it read and counts what it could not: the same
  // facts as the lines above, for the answer that describes the whole source.
  const asking = {
    ...overviewName(source),
    ignored,
    rejected: rejected.length,
    ...(source.kind === 'backstage' ? { nowhere: said } : {}),
  }
  // The load precedes `agentBacked`, so no span covers it: a catalogue read is
  // said as root attributes of the run, as the Inspector's skip is, and never
  // its token (brief § 8).
  const attributes = source.kind === 'backstage' ? sourceAttributes(source, loaded, loadMs) : undefined

  if (command.name === 'entry') {
    // What `ask` is handed, word for word, so the question road is `ask`'s —
    // its events included, which `agentBacked` hands both roads below.
    const asked = {
      graph,
      intent: command.phrase,
      source: asking,
      err,
      colour: colourOf(deps),
      quiet: command.quiet === true,
    }
    // The change road's repositories, decided before any model is chosen, for
    // the reason `plan`'s are: a `--project` is an argument, and it is checked
    // whichever road the Supervisor then takes. None when `declarations` is
    // none — `--demo`, or nothing named a repository — and a change is never
    // previewed against the demo SI: refused below, once the Supervisor has
    // said it is a change. A `--project` is still refused for what it is on
    // its own, so the same argument meets the same refusal wherever the SI
    // came from.
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
    const hint = slipHint(command.phrase)
    return agentBacked(
      deps,
      err,
      out,
      {
        command: 'entry',
        scenario: 'entry',
        ...(hint === undefined ? {} : { hint }),
        ...(attributes === undefined ? {} : { attributes }),
        // Resolved, as `plan`'s are: the repositories a change would read,
        // when there are any, whichever road the Supervisor then takes.
        inputs: {
          command: 'entry',
          phrase: command.phrase,
          ...(roots !== undefined ? { repo: roots.repo } : {}),
          ...(roots?.project.kind === 'project' ? { project: roots.project.root } : {}),
        },
      },
      async (client, emit) =>
        runEntry({
          ...asked,
          client,
          emit,
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
              emit,
              json: command.json,
              colour: colourOf(deps),
              notice: toStderr(err),
            })
          },
        }),
    )
  }

  if (command.name === 'ask') {
    return agentBacked(
      deps,
      err,
      out,
      {
        command: 'ask',
        scenario: 'question',
        inputs: { command: 'ask', intent: command.intent },
        ...(attributes === undefined ? {} : { attributes }),
      },
      async (client, emit) =>
      runAsk({
        graph,
        client,
        intent: command.intent,
        source: asking,
        emit,
        err,
        colour: colourOf(deps),
        quiet: command.quiet === true,
      }),
    )
  }

  switch (command.name) {
    case 'graph':
      return report(runGraph(graph, command.options), out)
    case 'show':
      return report(runShow(graph, command.query, said), out)
    case 'relations':
      // Keyless: computed from the declarations, and no model is chosen.
      return report(
        runRelations(graph, {
          query: command.query,
          ...(command.relation !== undefined ? { relation: command.relation } : {}),
          ...(command.to !== undefined ? { to: command.to } : {}),
          ...(command.depth !== undefined ? { depth: command.depth } : {}),
          nowhere: said,
        }),
        out,
      )
    default: {
      const exhaustive: never = command
      return exhaustive
    }
  }
}

/** What a read command reads, and where that came from (`source.ts`). */
interface Read {
  source: Source
  provider: ContextProvider
}

/**
 * The provider for a read command's source. The decision — `--repo`, `--demo`,
 * `--backstage`, the working directory, IDP_BACKSTAGE_URL, IDP_REPO, the
 * personal file, the demo SI — is `sourceOf`'s, shared with `plan`; this turns
 * it into a reader. `main` says what is being read once it is loaded.
 *
 * A catalogue's token is read here, from the environment the source was
 * resolved in, and nowhere else: `source.ts` only checks that it is there. It
 * is handed to the provider as a value, with the `fetch` the transport sends
 * through — the injected one in a test, the global one in a real run.
 */
async function providerOf(
  name: Exclude<DeclarationsCommand, 'plan' | 'protection'>,
  from: ReadFrom,
  deps: MainDeps,
): Promise<Read> {
  const context = sourceContextOf(deps)
  const source = await sourceOf(
    { command: name, repo: from.repo, demo: from.demo, backstage: from.backstage },
    context,
  )
  const flag = from.cached === true ? '--cached' : from.refresh === true ? '--refresh' : undefined
  // Before any request: a flag about a catalogue's copy against a source that
  // keeps none would do nothing, and running on would say it did.
  if (flag !== undefined && source.kind !== 'backstage') throw await cacheFlagRefusal(flag, source, context)
  switch (source.kind) {
    case 'repo':
      return { source, provider: new IacFsProvider(source.root) }
    case 'demo':
      return { source, provider: new FixtureProvider(deps.root ?? DEFAULT_ROOT) }
    case 'backstage': {
      const cache = cacheOf(from, deps.cacheRoot)
      return {
        source,
        provider: new BackstageProvider({
          base: new URL(source.url),
          token: tokenOf(context),
          catalogueFetch: deps.catalogueFetch ?? globalThis.fetch,
          ...(deps.catalogueLimits === undefined ? {} : { limits: deps.catalogueLimits }),
          ...(cache === undefined ? {} : { cache }),
        }),
      }
    }
    default: {
      const exhaustive: never = source
      return exhaustive
    }
  }
}

/**
 * The store a catalogue read is kept in, and how this run uses it — or none,
 * when no root was handed in (`cacheRootOf` said none, or a test's `main`
 * call). `--cached` with none is refused, exit 2, naming why: a kept read
 * with no store could only fail, and the reason is the setting to look at.
 */
function cacheOf(
  from: CacheUse,
  root: CacheRoot | undefined,
): { root: string; owner: number; use: 'fresh' | 'refresh' | 'kept' } | undefined {
  const owner = process.getuid?.()
  if (root === undefined || !('dir' in root) || owner === undefined) {
    if (from.cached === true) throw noCacheRefusal(root === undefined ? undefined : 'none' in root ? root.none : 'platform')
    return undefined
  }
  return { root: root.dir, owner, use: from.cached === true ? 'kept' : from.refresh === true ? 'refresh' : 'fresh' }
}

/** The catalogue's token, from the environment a source is resolved in; empty is unset. */
const tokenOf = (context: SourceContext): string | undefined => {
  const token = context.env[BACKSTAGE_TOKEN_VARIABLE]
  return token === undefined || token === '' ? undefined : token
}

/**
 * A catalogue read as a trace's root says it (brief § 8): where — scheme,
 * host, port and path, never a token, which the URL cannot hold — what it
 * served, what of that was not read, and what it cost.
 */
function sourceAttributes(source: BackstageSource, loaded: LoadResult, loadMs: number): Attributes {
  const url = new URL(source.url)
  // An organisation node is read, not set aside.
  const read = loaded.entities.length + (loaded.organisation?.length ?? 0)
  const served = loaded.census?.served ?? read + loaded.ignored.length + loaded.rejected.length
  const cache = loaded.cache
  // A run answered from a copy sent no request: no page and no byte, and the
  // time is this run's own, reading the copy. The census the copy keeps is the
  // load's that made it, and describes what the copy holds, not this run.
  const copy = answeredFromCopy(cache)
  return {
    'idp.source.kind': 'backstage',
    'idp.source.origin': `${url.protocol}//${url.host}${url.pathname}`,
    'idp.source.entities': served,
    'idp.source.set_aside': served - read,
    // What a bound left out, at least: 0 on a whole read.
    'idp.source.not_loaded': pastBoundOf(loaded.partial ?? []).count,
    'idp.source.pages': copy ? 0 : (loaded.census?.pages ?? 0),
    'idp.source.bytes': copy ? 0 : (loaded.census?.bytes ?? 0),
    'idp.source.ms': copy ? loadMs : (loaded.census?.ms ?? 0),
    // `off`: no cache root, as a test's run or IDP_BACKSTAGE_CACHE=off.
    'idp.source.cache_read': cache?.read.state ?? 'off',
    ...(cache?.written === undefined ? {} : { 'idp.source.cache_written': cache.written.state }),
    // Negative for a copy dated after this clock's now, which only --cached reads.
    ...(copy ? { 'idp.source.cache_age_s': Math.floor((cache.read.ageMs ?? Date.now() - cache.read.fetchedAt) / 1000) } : {}),
  }
}

/** Whether a load was answered from a kept copy: `fresh` or `kept`, and then no request was sent. */
function answeredFromCopy(
  cache: CacheReport | undefined,
): cache is CacheReport & { read: Extract<CacheReport['read'], { state: 'fresh' | 'kept' }> } {
  return cache !== undefined && (cache.read.state === 'fresh' || cache.read.state === 'kept')
}

/**
 * The lines a cache report adds after the notice, each cleaned: a path under
 * the cache root is one the person's environment named. Shown under `~` when
 * it is in the home directory.
 */
function cacheLinesOf(report: CacheReport, deps: MainDeps, context: SourceContext): string[] {
  const root = deps.cacheRoot !== undefined && 'dir' in deps.cacheRoot ? deps.cacheRoot.dir : ''
  return cacheLines(report, root, (file) => shownPath(file, context.env)).map((line) =>
    inertLine(line, Number.POSITIVE_INFINITY),
  )
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
 * Every field the read model does not read, as ONE line, counted by path for
 * the reason `notLoaded` counts by kind: a catalogue whose every Component
 * lists `consumesApis` would otherwise say so once per Component. A path is
 * a key a file wrote, so it is flattened like any other text this tool did
 * not write (domain-backstage-7).
 */
function notRead(unread: readonly string[]): string {
  const byPath = new Map<string, number>()
  for (const field of unread) {
    const label = oneLine(field)
    byPath.set(label, (byPath.get(label) ?? 0) + 1)
  }
  const counts = [...byPath]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([field, count]) => `${field} ×${String(count)}`)
  const fields = unread.length === 1 ? 'field' : 'fields'
  return `not read: ${String(unread.length)} ${fields} this tool does not model (${counts.join(', ')})`
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
 *
 * The streams are parameters for one reason: this is the only thing a person
 * at a terminal actually sees, and a test that checks the lines it is built
 * from rather than what it writes would stay green with it reverted. Exported
 * for that test; `askOf` is its only caller.
 */
export const promptOnTerminal = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Ask => async (question) => {
  const reader = createInterface({ input, output })
  try {
    // Raced against `close`, because Ctrl-D ends the input without ever
    // answering: a closed stdin is a decline — which is what `undefined` means
    // — and not a reason to hang a run or throw at the user.
    const closed = new Promise<undefined>((resolve) => {
      reader.once('close', () => resolve(undefined))
    })
    // And against Ctrl-C, which is not a decline. A terminal in raw mode
    // hands it to readline as a key, not to the process as a signal, and
    // readline with nobody listening closes — so it read as Ctrl-D, and the
    // run exited 3 with its questions printed, as if the person had declined
    // them (review, cli-ux-6). Listened for, it stops the run: exit 130.
    const interrupted = new Promise<never>((_resolve, reject) => {
      reader.once('SIGINT', () => reject(new InterruptedError()))
    })
    return await Promise.race([
      // The lines `renderQuestions` prints, so the prompt and the printed form
      // ask the same thing — the model's reason, the engine's path, and what
      // the field accepts — each cleaned there.
      reader.question(`${questionLines(question).join('\n')}\n  > `),
      closed,
      interrupted,
    ])
  } finally {
    reader.close()
  }
}

/**
 * The one question `--submit` asks, at a terminal (§7.4 step 7).
 *
 * The diff goes where the preview always goes, stdout; the question goes to
 * stderr, where every prompt goes (§6.2). Only `y` or `yes` submits: an empty
 * line, Ctrl-D or anything else declines, which is the reading that writes
 * nothing. Ctrl-C is not a decline, as at a question: it stops the run, exit
 * 130. The wording says what is being done — submitting for review — and what
 * is not: nothing is provisioned until someone else merges it (§4.2).
 *
 * The streams are parameters for `promptOnTerminal`'s reason: this is what a
 * person at a terminal sees. Exported for that test; `confirmOf` is its only
 * caller.
 */
export const confirmOnTerminal = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  diff: NodeJS.WritableStream = process.stdout,
): Confirm => async (summary) => {
  diff.write(`${summary.preview}\n`)
  const reader = createInterface({ input, output })
  try {
    const closed = new Promise<undefined>((resolve) => {
      reader.once('close', () => resolve(undefined))
    })
    const interrupted = new Promise<never>((_resolve, reject) => {
      reader.once('SIGINT', () => reject(new InterruptedError()))
    })
    const said = await Promise.race([reader.question(questionOf(summary)), closed, interrupted])
    return said !== undefined && /^(y|yes)$/i.test(said.trim())
  } finally {
    reader.close()
  }
}

/**
 * The question itself. The root, the branch, the base and the repository come
 * from the repository, its files and its remote: one line each, whatever they
 * hold. On GitHub's road it names both acts and whose they are — the push
 * with the person's git, the pull request with their gh — or, when an earlier
 * run pushed the branch, the pull request alone (stage 6 brief § 3); the
 * local road's is stage 5's, byte for byte.
 */
const questionOf = (summary: SubmissionSummary): string => {
  const one = (value: string): string => inertLine(value, Number.POSITIVE_INFINITY)
  const { github } = summary
  if (github === undefined) {
    return (
      `Submit this for review as ${one(summary.branch)} in ${one(summary.root)}? ` +
      'Nothing is provisioned until someone else merges it. [y/N] '
    )
  }
  const where = `${github.host}/${one(github.repository)}`
  const provisioned = 'Nothing is provisioned until someone else approves it and it is merged. [y/N] '
  return github.pushedAlready
    ? `Open a pull request from ${one(summary.branch)} into ${one(github.base)} on ${where} with your gh? ` +
        `The branch was pushed by an earlier run. ${provisioned}`
    : `Push ${one(summary.branch)} to ${where} with your git, and open a pull request into ${one(github.base)} ` +
        `with your gh? ${provisioned}`
}

/**
 * What every submission's opener is handed from `main`: `--local`, the
 * person's environment for git and gh, the gh a test injects, and stderr for
 * the line naming the GitHub road.
 */
const submissionOf = (
  deps: MainDeps,
  local: boolean,
  err: (chunk: string) => void,
): Pick<SubmitOptions, 'local' | 'env' | 'gh' | 'notice'> => ({
  ...(local ? { local: true } : {}),
  env: deps.env ?? process.env,
  ...(deps.gh === undefined ? {} : { gh: deps.gh }),
  notice: toStderr(err),
})

/**
 * Who confirms a submission. A person at a terminal gets the prompt; a
 * script, a pipe or `--json` has `--submit` as its answer — safe, because the
 * confirmation was never the guard: the merge is (ADR-0006, §4.2).
 *
 * `--json` first, before an injected one: a `--json` run is read by a
 * program, and a program is never asked.
 */
const confirmOf = (deps: MainDeps, json: boolean): Confirm | undefined => {
  if (json) return undefined
  if (deps.confirm !== undefined) return deps.confirm
  if (deps.out !== undefined || deps.err !== undefined) return undefined
  return process.stdin.isTTY === true ? confirmOnTerminal() : undefined
}

/**
 * Ctrl-C at a question: the person stopped the run, and `main` exits 130, the
 * code a shell gives a command an interrupt ended. Thrown rather than
 * returned, because nothing between the prompt and `main` has anything to do
 * with it but let it through — a decline is an answer, and this is not one.
 */
export class InterruptedError extends Error {
  constructor() {
    super('interrupted; nothing was written')
    this.name = 'InterruptedError'
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
 * no key for it, an IDP_TIMEOUT that is not a number of seconds, or an
 * IDP_SUPERVISOR_MODEL that is not a model name.
 *
 * A model call that could not succeed — it timed out, the provider refused the
 * key or failed, the output limit or a content filter stopped it — is exit 1,
 * in the one line `llm/failures.ts` wrote for it. Nothing the user typed was
 * wrong, and the same command may well succeed on the next run.
 *
 * Ctrl-C at a question is exit 130 (`InterruptedError`): the person stopped
 * the run, which is neither a refusal of what they typed nor a declined
 * question.
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
  if (
    error instanceof PlanInputError ||
    error instanceof RepositoryArgumentError ||
    // A repository that cannot take a branch: not a clone's root, no git, no
    // committer identity, a detached or unborn HEAD. It quotes the path.
    error instanceof ForgeInputError
  ) {
    err(`${inertLine(error.message, Number.POSITIVE_INFINITY)}\n`)
    return EXIT.badUsage
  }
  // git failed where it should not have: exit 1, with git's own words — a
  // repository's content can reach them, so one line each, cleaned.
  if (isGitError(error)) {
    const said = error.stderr
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => `  ${inertLine(line, Number.POSITIVE_INFINITY)}`)
    err([`${inertLine(error.message, Number.POSITIVE_INFINITY)}; nothing was submitted`, ...said, ''].join('\n'))
    return EXIT.notFound
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
  // GitHub's answer through gh, at run time: exit 1, in the sentence this
  // build wrote for the route and the status — never GitHub's or gh's words,
  // which a repository or a server can reach. A GhError the forge did not
  // wrap says only gh's command word and a reason of ours.
  if (error instanceof GitHubAnswerError || isGhError(error)) {
    err(`${inertLine(error.message, Number.POSITIVE_INFINITY)}\n`)
    return EXIT.notFound
  }
  // The Supervisor's model gave no word, twice: exit 1, as a call that could
  // not succeed is, not 3 — nothing was understood and declined
  // (gap-ask-grounding-7). One line, never cut: it quotes the model's text.
  if (error instanceof ClassificationError) {
    err(`${inertLine(error.message, Number.POSITIVE_INFINITY)}\n`)
    return EXIT.notFound
  }
  if (error instanceof InterruptedError) {
    // On a line of its own: the prompt it interrupted left the cursor after
    // its `> `.
    err(`\n${error.message}\n`)
    return EXIT.interrupted
  }
  err(`${inert(error instanceof Error ? error.message : String(error))}\n`)
  return EXIT.notFound
}

/**
 * By name, not by class: `process/git.ts` is the launcher, and only the modules
 * that run git may load it (`tests/architecture`). The type is erased.
 */
const isGitError = (error: unknown): error is GitError =>
  error instanceof Error && error.name === 'GitError' && typeof (error as { stderr?: unknown }).stderr === 'string'

/** By name, for the reason `isGitError` is: only `forge/github/` loads the gh launcher. */
const isGhError = (error: unknown): error is GhError =>
  error instanceof Error && error.name === 'GhError' && typeof (error as { kind?: unknown }).kind === 'string'

/**
 * Runs one command that needs a model, closes the tape afterwards, and traces
 * the run when a sink asks for it.
 *
 * The client is built here and not inside the command, for the reason every
 * other seam in this file exists: a command that chose its own provider could
 * not be driven by a scripted one, and every agent-backed test would need a key
 * or a recording.
 *
 * The trace starts once the session is open — a run refused for want of a
 * model has no run to trace — and is finished and exported on both paths out,
 * the result and the throw, because the run that failed is the one most worth
 * reading. Nothing about it reaches the exit code: an export that fails is one
 * line on stderr (ADR-0009).
 */
async function agentBacked(
  deps: MainDeps,
  err: (chunk: string) => void,
  out: (chunk: string) => void,
  run: AgentRun,
  execute: (client: LlmClient, emit: EventSink) => Promise<CommandResult>,
): Promise<number> {
  let session: Session
  try {
    session = await openSession(deps, err, run.scenario)
  } catch (error) {
    const code = failed(error, err)
    if (run.hint !== undefined) err(`${run.hint}\n`)
    return code
  }

  const shown = deps.events ?? progress(err)
  const sinks = [
    ...sinksFromEnv(deps.env ?? process.env, deps.fetch ?? globalThis.fetch),
    ...(deps.traceSinks ?? []),
  ]
  const builder =
    sinks.length === 0
      ? undefined
      : createTraceBuilder({
          clock: traceClock(),
          ids: TRACE_IDS,
          name: `idp-agent ${run.command}`,
          inputs: run.inputs,
          attributes: { ...session.attributes, ...run.attributes },
        })
  // MLflow's own id for the trace, `tr-` and the OTLP id, so the line pastes
  // straight into its search.
  if (builder !== undefined) err(`· trace tr-${builder.traceId}\n`)
  const emit: EventSink =
    builder === undefined
      ? shown
      : (event) => {
          builder.onEvent(event)
          shown(event)
        }
  // Every call counted, on both paths out, and the count said once: after what
  // the command printed as its result, and before a failure's line, which
  // stays the run's last (product-gap-10). Once, though both paths ask: a tape
  // that fails to save is a failure after the result.
  const metered = counted(
    builder === undefined ? session.client : traced(session.client, builder),
    emit,
  )
  const client = metered.client
  let costSaid = false
  const cost = (): void => {
    const line = costSaid ? undefined : usageLine(metered.usage())
    costSaid = true
    if (line !== undefined) err(`${line}\n`)
  }

  let code: number
  let outputs: unknown
  let thrown: string | undefined
  let said: Attributes | undefined
  try {
    const result = await execute(client, emit)
    said = result.attributes
    // Recording in memory and never writing it down is the whole run wasted,
    // and it is silent: the turns are there, the file never appears.
    await session.save()
    cost()
    code = report(result, out)
    // Without the terminal's escape sequences: the diff may be coloured, and
    // MLflow's preview of the root prints them as they are.
    outputs = { exitCode: code, text: plain(result.text) }
  } catch (error) {
    cost()
    code = failed(error, err)
    thrown = error instanceof Error ? error.message : String(error)
    outputs = { exitCode: code, error: thrown }
  }

  if (builder !== undefined) {
    const trace = builder.finish({
      outputs,
      // What the command said of its run — where a submission went — beside its exit.
      attributes: { ...said, 'idp.exit_code': code },
      ...(thrown !== undefined ? { error: thrown } : {}),
    })
    await exportTrace(trace, sinks, err)
  }
  return code
}

/** One agent-backed command: what it is called, which tape it replays, and what it was asked. */
interface AgentRun {
  readonly command: 'ask' | 'entry' | 'init' | 'plan'
  readonly scenario: string
  readonly inputs: Readonly<Record<string, unknown>>
  /** What the command decided before a model was chosen, for the trace's root. */
  readonly attributes?: Attributes
  /** Said after the refusal when no model could be opened (`slipHint`). */
  readonly hint?: string
}

/** The model, the tape, and what a trace's root says about where the answers came from. */
interface Session {
  readonly client: LlmClient
  save(): Promise<void>
  readonly attributes: Attributes
}

/** Unix nanoseconds, monotonic within a run: the wall clock read once, the high-resolution timer after. */
function traceClock(): () => bigint {
  const epoch = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint()
  return () => epoch + process.hrtime.bigint()
}

const TRACE_IDS = {
  traceId: (): string => randomBytes(16).toString('hex'),
  spanId: (): string => randomBytes(8).toString('hex'),
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
): Promise<Session> {
  // An injected client is a test on scripted turns. It reads no credential and
  // opens no tape, which is what makes "no model configured" a real assertion
  // rather than something every test has to work around.
  if (deps.client !== undefined) {
    return {
      client: deps.client,
      save: async (): Promise<void> => {},
      attributes: { 'idp.mode': 'scripted' },
    }
  }

  const env = deps.env ?? process.env
  const recording = resolveMode(env['IDP_RECORDING'])
  const mode: ClientMode =
    recording === 'record' ? 'record' : deps.scenario !== undefined ? 'replay' : 'live'

  // All three read before a tape is opened or an agent started: a missing key,
  // a bad IDP_SUPERVISOR_MODEL or a bad IDP_TIMEOUT is a refusal of the
  // configuration, said up front, and not a failure discovered at the first
  // request. Replay reads none — a recording names its own model and needs no
  // key.
  const choice = mode === 'replay' ? undefined : chooseModel(env)
  const models = choice === undefined ? undefined : agentModelsOf(env, choice)
  const timeout = mode === 'replay' ? undefined : timeoutOf(env)
  // Empty is unset, as for every IDP_ variable.
  const named = env['IDP_SCENARIO']
  const name = deps.scenario ?? (named === undefined || named === '' ? scenario : named)
  const tape =
    mode === 'live'
      ? undefined
      : await openRecording({
          scenario: name,
          store: fileRecordingStore(deps.recordingDir ?? DEFAULT_RECORDINGS),
          mode: mode === 'record' ? 'record' : 'replay',
          warn: (message) => err(`${message}\n`),
        })

  return {
    client: createClient({
      mode,
      ...(tape !== undefined ? { tape } : {}),
      ...(choice !== undefined ? { choice } : {}),
      ...(models !== undefined ? { models } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      // A retry is progress, and said as the other progress lines are: one
      // line on stderr, inert, while the run waits.
      notice: (line) => err(`  ! ${whole(line)}\n`),
    }),
    // After a run that succeeded, and only then: a failed run stopped short of
    // its tape, and its failure is what it says. A replay that left a turn
    // unplayed fails the run — the tape holds more than its scenario makes.
    save: async (): Promise<void> => {
      if (tape === undefined) return
      if (mode === 'record') await tape.save()
      else tape.assertAllReplayed()
    },
    // A replayed trace's latencies measure the tape, not the model; `idp.mode`
    // is how a reader of the trace knows which.
    attributes: {
      'idp.mode': mode,
      ...(tape !== undefined ? { 'idp.scenario': name } : {}),
      ...(choice !== undefined ? { 'idp.provider': choice.provider, 'idp.model': choice.model } : {}),
      // `idp.model` is every other call's; the Supervisor's is said apart, or
      // the trace would name a model one of its calls never went to.
      ...(models?.supervisor !== undefined ? { 'idp.supervisor.model': models.supervisor.model } : {}),
    },
  }
}
