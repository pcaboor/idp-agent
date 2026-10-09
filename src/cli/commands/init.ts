import path from 'node:path'
import { draftPlan } from '../../agents/architect.js'
import type { EventSink } from '../../agents/events.js'
import { inspect } from '../../agents/inspector.js'
import { repair } from '../../agents/repair.js'
import { reviewPlan } from '../../agents/reviewer.js'
import { formatSummary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import type { ProjectFacts } from '../../agents/tools/project-tools.js'
import { discover } from '../../context/discovery/discover.js'
import { readProject } from '../../context/project-fs/snapshot.js'
import {
  asCatalogInfo,
  catalogInfoEdits,
  filedIn,
  fold,
  identitiesOf,
  isComponent,
  isSetAside,
  isThis,
  targetOf,
  type Identity,
} from '../../core/plan/catalog-info.js'
import { coverageSentence, isComplete, verifiedFindings, type Coverage } from '../../core/discovery/report.js'
import { protectionText } from '../../core/github/protection.js'
import { clearService } from '../../core/plan/clear.js'
import type { Hint, Question } from '../../core/plan/clarify.js'
import type { RecordedAnswer } from '../../core/plan/reapply.js'
import type { SignedPlan } from '../../core/plan/sign.js'
import {
  CONFIG_FILE,
  holdsInvisible,
  repositoryConfigSchema,
  serializeConfig,
  type RepositoryConfig,
  type WrittenConfig,
} from '../../core/schemas/config.js'
import { COMPONENT_LIFECYCLES, ownerRefSchema } from '../../core/schemas/entity.js'
import { planSchema, proposedName, type Operation, type Plan } from '../../core/schemas/plan.js'
import { reasonOf } from '../../core/schemas/reject.js'
import { parseDocuments } from '../../core/yaml/serialize.js'
import type { LlmClient } from '../../llm/client.js'
import { ConfigError, readConfigFile } from '../config.js'
import { budgetNotice, selectionNotice } from '../repository.js'
import { isForgeHandle } from '../../scaffold/codeowners.js'
import { loadTemplates } from '../../scaffold/templates.js'
import { scaffoldLayout } from '../../scaffold/layout.js'
import {
  ScaffoldWriteError,
  writeScaffold,
  type FileIO,
  type WriteReport,
} from '../../scaffold/write.js'
import { readRegistrationFile, readRepository } from '../../context/iac-fs/snapshot.js'
import {
  REGISTRATION_FILE,
  registers,
  renderRegistration,
} from '../../core/validate/registration.js'
import type { RepositorySnapshot, Violation } from '../../core/validate/rules.js'
import {
  ASK_LIMITS,
  contextsOf,
  fillAnswers,
  graphOf,
  questionLines,
  readContents,
  renderPreview,
  renderRefusedAnswer,
  renderStopped,
  type Ask,
} from './plan.js'
import { coverageLines } from '../render/coverage.js'
import type { PreviewStatus } from '../render/footer.js'
import { inertLine, spelledOut } from '../render/plain.js'
import type { CommandResult } from './result.js'
import {
  openForSubmission,
  refuseDivergence,
  refuseUnprotected,
  sayInFlight,
  submit,
  type Opened,
  type SubmissionReport,
  type SubmitOptions,
} from './submit.js'

/**
 * Printed on every run, including the one that writes nothing. The second
 * reader of a repository is as entitled to it as the first, and a tool that
 * only admits its limits once has not admitted them. The list is
 * `PROTECTION_SETTINGS`, the one `idpa protection` checks and prints, so
 * the two cannot drift; a directory with no remote yet has nothing to
 * check, so this says what will.
 */
const RULESET_NOTICE = [
  'Branch protection is set in the forge, not here. Add a ruleset on the default branch (Settings → Rules → Rulesets):',
  ...protectionText(),
  'idpa protection checks them once the repository is on GitHub.',
].join('\n')

export interface InitPlatformOptions {
  /** Absolute, already through assertInsideRepo. */
  readonly root: string
  /** A forge handle, already validated. */
  readonly owner: string
  readonly version: string
}

/**
 * What `init platform` says on stderr when the root `catalog-info.yaml` was
 * there already and does not register the repository: the file is kept, as
 * every file is, and the Location it needs is printed whole, to be added by the
 * person who owns the file. Undefined when there is nothing to say.
 */
async function registrationNotice(
  root: string,
  kept: readonly string[],
): Promise<string | undefined> {
  if (!kept.includes(REGISTRATION_FILE)) return undefined
  const file = await readRegistrationFile(root)
  if (registers(file)) return undefined
  const held = (file?.registrations ?? []).length > 0
  // What is said of the file is what was read of it: one this tool cannot
  // read is never said to hold no Location, and adding a document to text
  // that does not parse registers nothing.
  const [why, add] =
    file === undefined
      ? [
          'it is not a regular file, and this tool reads no other, so it cannot tell whether it registers this repository',
          'Make it hold this Location, as a document of its own:',
        ]
      : held
        ? [
            'the Location it holds does not register every folder here (`idp-agent validate` says why)',
            'Add this Location to it, in place of the one it holds:',
          ]
        : file.rejections.length > 0
          ? [
              'part of it does not read (`idp-agent validate` says why), and no Location in it does',
              'Once it reads, add this Location to it, as a document of its own:',
            ]
          : [
              'it holds no Location, so Backstage cannot ingest this repository in one registration',
              'Add this Location to it, as a document of its own:',
            ]
  return [
    `${REGISTRATION_FILE} was already there and is kept; ${why}.`,
    add,
    '',
    '---',
    renderRegistration(path.basename(root)).trimEnd(),
  ].join('\n')
}

export async function runInitPlatform(
  options: InitPlatformOptions,
  io?: FileIO,
): Promise<CommandResult & { readonly notice?: string }> {
  const files = scaffoldLayout(
    {
      owner: options.owner,
      version: options.version,
      repository: path.basename(options.root),
    },
    await loadTemplates(),
  )
  let report: WriteReport
  try {
    report = await writeScaffold(options.root, files, io)
  } catch (error) {
    if (!(error instanceof ScaffoldWriteError)) throw error
    // What it left behind, in the list a whole run prints, and the file it
    // stopped at: nothing is rolled back, so what was written is on the disk,
    // and a re-run keeps every one of those and writes the rest. The sentence
    // is a notice, as the registration's is: stdout stays the file list.
    return {
      notice:
        `stopped: ${inertLine(error.message)}. Nothing it wrote was removed; run it again ` +
        'once that is fixed, and it keeps every file already there.',
      text: listing(error).join('\n'),
      found: false,
    }
  }
  const notice = await registrationNotice(options.root, report.kept)

  return {
    ...(notice !== undefined ? { notice } : {}),
    text: [...listing(report), '', RULESET_NOTICE].join('\n'),
    found: true,
  }
}

/** The files a run wrote and kept, `+` and `=`, in path order under a count. */
const listing = (report: WriteReport): string[] => [
  `wrote ${report.written.length} · kept ${report.kept.length}`,
  ...[...report.written, ...report.kept]
    .sort()
    .map((file) => `  ${report.written.includes(file) ? '+' : '=' } ${file}`),
]

/**
 * `idp-agent init --project <dir>` — once per application (design §7.3).
 *
 * Stage 3 shipped this as a tested refusal naming what it waited for: the
 * Inspector, and `propose()`. Both exist, so this is the refusal answered.
 *
 * Inspector → Architect → the catalog-info.yaml it would write. It stops one
 * step short of §7.3's last two clauses on purpose: writing the file and
 * writing `.idp-agent.yml` are writes, and writing arrives at stage 5. What
 * lands here is the preview and the questions, rendered by `plan.ts` — the same
 * renderer `plan --from` ends on, because a second one would be a second answer
 * to "what would this do?".
 */

/**
 * The request, composed by the ENGINE out of what the inspection established.
 *
 * `init` has no sentence a user typed — the gesture is "declare this
 * repository" and the answer is in its own files — but a plan carries its
 * request and the Architect is handed one, so something has to be there. It is
 * the engine's sentence, and it vouches for nothing: the provenance `runInitRepo`
 * signs with says so (`wordsOf: 'engine'`).
 *
 * It names **exactly the four values `proposedComponentSchema` lets a model
 * write**, and only where the inspection actually established them — a value
 * a file the Inspector read before its report states, by the field's rule
 * (`agents/tools/project-witness.ts`); one no file states arrives here as an
 * unknown and is named nowhere. None of them vouches for anything (stage 8,
 * slice 2, Task 2.1): what the inspection read is a model's reading, shown
 * beside the question at the field it was read for (`withHints`) and never
 * an answer. A name, a type, a lifecycle or an owner nobody typed is vouched
 * for by nothing, enumerated by nothing, and becomes a question the CLI puts
 * to the person (design §4.1), the Inspector's reading under it.
 *
 * The type was the one of the four that did not hold, and the sentence above is
 * only true because `sign.ts` stopped classifying a Component's `spec.type`
 * structurally. It is `z.string().min(1).max(63)`, not the closed union a
 * Resource's is, so an invented one signed `derived` and reached the
 * `catalog-info.yaml` below without anyone being asked. Since stage 8's slice
 * 2 (Task 2.3) this road signs against the declarations repository's graph,
 * whose vocabulary holds the types and owners it uses, and the signature is
 * told the Component is the person's (`ownComponent`, which `runInitRepo`
 * passes): its type, like its name, lifecycle, owner and every `dependsOn`
 * entry, is typed, answered or a question — never enumerated off the
 * catalogue — and there is no fourth answer.
 *
 * `forgeHandle` is deliberately absent, and its absence is the point of the
 * field: `@acme/platform` is a forge handle and `group:default/platform` is an
 * entity reference, two namespaces that do not survive translation. It is
 * stated to the model as a handle — `formatFacts` prints it — and kept out of
 * this sentence, so it can never vouch for itself as an owner; beside the
 * owner's question it is shown as what it is, a handle that names no group.
 * `runtime` is absent too: it is evidence for `spec.type`, not a value any
 * proposal field carries.
 *
 * What this does NOT cover: the Inspector is a model reading files, so this
 * request is not a human's words. The witness says a value matches what a
 * file the Inspector read states; it says nothing about whether the file is
 * right, or about this field — the keyed rule reads a line, not a format —
 * which is why a witnessed fact is a hint and not an answer: §7.3's "confirms the owner it inferred rather than
 * assuming it" is the person answering the question, the hint in front of
 * them, and then reading the diff below.
 */
const known = (value: ProjectFacts[keyof ProjectFacts]): string | undefined =>
  typeof value === 'string' ? value : undefined

export function requestOf(facts: ProjectFacts): string {
  const values = [facts.name, facts.type, facts.lifecycle, facts.owner]
    .map(known)
    .filter((value): value is string => value !== undefined)

  return [
    'declare this repository in the catalogue, from what its own files state',
    ...(values.length === 0 ? [] : [`— they state ${values.join(', ')}`]),
  ].join(' ')
}

/**
 * "Restricted to `create-catalog-info`", made structural rather than asked for.
 *
 * There is no prompt instruction here and there could not usefully be one. The
 * restriction is one absence, one refusal and one substitution:
 *
 *   - `propose-tool.ts` builds its schema from `operationSchema`'s members
 *     **minus** `create-catalog-info`, precisely because that operation carries
 *     `repoPath` and a path field in front of a model is a path a model
 *     chooses. So the Architect has no way to express one, and there is no
 *     field to put a path in — `JSON.stringify` of its tool specs holds no
 *     `repoPath` at all. That absence is the restriction; a sentence in a
 *     system prompt would be a request.
 *   - What it CAN express is a Component creation, and anything else — a
 *     Resource, a patch — is refused by path here. Not dropped: an operation
 *     that vanishes is an operation nobody can argue with. Since stage 8's
 *     slice 2 (Task 2.3) the refusal is `repair`'s scope: reported at gate [1]
 *     in these words, so the Architect drafts again rather than the run ending.
 *   - The engine mints the real operation, and does it AFTER the gates have
 *     judged what the model proposed. See `runInitRepo`.
 */
function componentsOf(plan: Plan): string[] {
  return plan.operations.flatMap((operation, opIndex) =>
    operation.op === 'create-entity' && operation.entity.kind === 'Component'
      ? []
      : [
          `operations.${String(opIndex)}: init declares this repository and nothing else; ` +
            `a ${operation.op === 'create-entity' ? operation.entity.kind : operation.op} ` +
            'belongs to a plan, not to an init',
        ],
  )
}

/** The close of a stop on `componentsOf`: what init takes, since the person has no value to name. */
const SCOPE_STOP = [
  "Nothing was previewed, and nothing was written. init declares this service's Component and nothing " +
    'else, and every draft declared more; run it again, and a plan declares the rest.',
]

/** The four facts a hint is shown for, and the forge handle beside the owner. */
type HintField = 'name' | 'type' | 'lifecycle' | 'owner' | 'forgeHandle'

/**
 * Backstage's conventional shape for a Component's type — `service`,
 * `website`, `grpc-service` — and the only one a hint of it is shown in. The
 * schema takes any 1 to 63 characters, since a person may type another
 * (`--type`); a model's reading is held tighter: no space, so no prose.
 */
const TYPE_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * What each field's hint is held to before it is attached: the grammar the
 * field itself takes, or tighter. A record over every field, so a field with
 * no grammar does not compile. A value outside it gives no hint at all —
 * never a hint cut down to what passes.
 */
const hintGrammar: { readonly [K in HintField]: (value: string) => boolean } = {
  name: (value) => proposedName.safeParse(value).success,
  type: (value) => value.length <= 63 && TYPE_TOKEN.test(value),
  lifecycle: (value) => (COMPONENT_LIFECYCLES as readonly string[]).includes(value),
  owner: (value) => ownerRefSchema.safeParse(value).success,
  forgeHandle: isForgeHandle,
}

/** The fact read for each field a question can be at, by the end of its path. */
const HINTED: readonly (readonly [string, HintField])[] = [
  ['.entity.metadata.name', 'name'],
  ['.entity.spec.type', 'type'],
  ['.entity.spec.lifecycle', 'lifecycle'],
  ['.entity.spec.owner', 'owner'],
]

/** One fact as a hint, when the witness kept it and its field's grammar holds it. */
const hintOf = (facts: ProjectFacts, field: HintField): Hint[] => {
  const value = known(facts[field])
  if (value === undefined || !hintGrammar[field](value)) return []
  return [
    field === 'forgeHandle'
      ? { source: 'inspector', value, as: 'forge-handle' }
      : { source: 'inspector', value },
  ]
}

/**
 * The questions, each with the Inspector's witnessed value for its field,
 * when it read one (stage 8, slice 2, Task 2.1).
 *
 * The four values `requestOf` names used to be placed as answers at the
 * fields they were read for, so a model's reading of a file signed as the
 * person's word. They are hints now: shown under the question, labelled as a
 * model's reading, and never a value an empty line accepts. The facts reach
 * here witnessed (`witnessFacts`): a value no file the Inspector read states
 * is an unknown, and an unknown gives no hint — nor does the reason a model
 * wrote for one, which is never shown. The forge handle goes beside the
 * owner's question, as a handle: it names no group, and is never translated.
 */
export function withHints(questions: readonly Question[], facts: ProjectFacts): Question[] {
  return questions.map((question) => {
    const field = HINTED.find(([suffix]) => question.path.endsWith(suffix))?.[1]
    if (field === undefined) return question
    const hints = [...hintOf(facts, field), ...(field === 'owner' ? hintOf(facts, 'forgeHandle') : [])]
    return hints.length === 0 ? question : { ...question, hints }
  })
}

/**
 * The person's own values for the four fields of the Component (review,
 * gap-init-real-repos-2): its catalogue name, its type, its lifecycle — no
 * common file states one — and its owner, which CODEOWNERS states only as a
 * forge handle the Inspector is forbidden to translate. Passed as flags, they
 * are what an answer at the prompt is: the user's word about one field,
 * vouched for as answered, and held to what that field accepts. Nothing else
 * is: what the Inspector read is a hint beside the question (`withHints`).
 */
export interface InitAnswers {
  readonly name?: string
  readonly type?: string
  readonly lifecycle?: string
  readonly owner?: string
}

/** The field each flag answers, and the flag, for the line that names it. */
const INIT_FLAGS = [
  ['metadata.name', 'name', '--name'],
  ['spec.type', 'type', '--type'],
  ['spec.lifecycle', 'lifecycle', '--lifecycle'],
  ['spec.owner', 'owner', '--owner'],
] as const

/** What a Component's type takes, the schema's bound (`proposedComponentSchema`). */
const MAX_TYPE_LENGTH = 63

/**
 * The flags, held to the rules an answer typed at the prompt is held to: a
 * lifecycle outside the closed set `questionsOf` offers, an owner that is not
 * an entity reference, a name Backstage would refuse, a type of more than 63
 * characters or none, holding a control, format or bidi character — which
 * `fillAnswers` refuses at the prompt too — or beginning or ending with a
 * space, which the prompt trims, and is blank when it is nothing else. Refused
 * before a model is chosen — a bad flag is exit 2, and a paid inspection is
 * not how a typo is found. Each refusal quotes the value, cleaned: it is what
 * was typed.
 */
export function initAnswersOf(values: {
  readonly name?: string | undefined
  readonly type?: string | undefined
  readonly lifecycle?: string | undefined
  readonly owner?: string | undefined
}): { answers: InitAnswers } | { refused: string } {
  const { name, type, lifecycle, owner } = values
  if (type !== undefined && (type.length === 0 || type.length > MAX_TYPE_LENGTH)) {
    return {
      refused: `--type ${inertLine(type)} is not a Component type: 1 to ${String(MAX_TYPE_LENGTH)} characters`,
    }
  }
  // Spelled out, as a configuration flag's is: a type is a value a reviewer
  // reads in the catalog-info, and a direction override in it reads the
  // wrong way round.
  if (type !== undefined && holdsInvisible(type)) {
    return {
      refused:
        `--type ${spelledOut(type)} holds a control, format or bidi character, which a ` +
        "Component's type never holds; type it again without one",
    }
  }
  // A flag gives no value the prompt could not. Quoted as typed, so the spaces
  // show — `inertLine` would trim them — which is safe only here: 63
  // characters at most, and none a control, format or bidi character.
  if (type !== undefined && type.trim() !== type) {
    return {
      refused:
        `--type "${type}" begins or ends with a space, which a Component's type ` +
        'never does; type it again without one',
    }
  }
  if (lifecycle !== undefined && !(COMPONENT_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    return {
      refused:
        `--lifecycle ${inertLine(lifecycle)} is not one of the values it accepts: ` +
        COMPONENT_LIFECYCLES.join(', '),
    }
  }
  if (owner !== undefined && !ownerRefSchema.safeParse(owner).success) {
    return {
      refused:
        `--owner ${inertLine(owner)} is not an entity reference: group:<namespace>/<name> or ` +
        'user:<namespace>/<name>' +
        (owner.startsWith('@')
          ? ' — a CODEOWNERS entry is a forge handle, another namespace, and is never translated'
          : ''),
    }
  }
  if (name !== undefined && !proposedName.safeParse(name).success) {
    return {
      refused:
        `--name ${inertLine(name)} is not a Backstage name: lower case letters, digits, ` +
        '".", "_" and "-", 63 at most, starting and ending with a letter or a digit',
    }
  }
  return {
    answers: {
      ...(name !== undefined ? { name } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(lifecycle !== undefined ? { lifecycle } : {}),
      ...(owner !== undefined ? { owner } : {}),
    },
  }
}

/** What a person typed for `.idp-agent.yml`: `--iac-repo`, and each `--environment`. */
export interface ConfigFlags {
  readonly iacRepo?: string
  readonly environments?: readonly string[]
}

/**
 * The configuration flags as typed, refused before a model is chosen — exit 2,
 * naming the flag, the way `initAnswersOf` refuses a lifecycle — when
 * `--iac-repo` is typed more than once (parseArgs would keep the last in
 * silence), when a field of the schema refuses a value — an empty locator, one
 * carrying a credential, an environment too long — or when a value holds a
 * control, format or bidi character (`holdsInvisible`). The schema first: its
 * reasons never quote a value, and a locator it refuses is one whose userinfo
 * may be a token. The schema stays the gate: `configFor` parses the whole
 * configuration again, flags and answers together, before any model is paid.
 */
export function configFlagsOf(values: {
  readonly 'iac-repo'?: readonly string[] | undefined
  readonly environment?: readonly string[] | undefined
}): { flags: ConfigFlags } | { refused: string } {
  const locators = values['iac-repo'] ?? []
  if (locators.length > 1) {
    // Neither value quoted: either may be the one carrying a credential.
    return {
      refused:
        `--iac-repo was typed ${String(locators.length)} times; a ${CONFIG_FILE} names one ` +
        'declarations repository, so type it once',
    }
  }
  const [iacRepo] = locators
  const fields = repositoryConfigSchema.shape
  const refusal = [
    ['--iac-repo', iacRepo === undefined ? undefined : fields.iacRepo.safeParse(iacRepo)],
    ['--environment', values.environment === undefined ? undefined : fields.environments.safeParse(values.environment)],
  ] as const
  for (const [flag, parsed] of refusal) {
    if (parsed !== undefined && !parsed.success) {
      return { refused: `${flag} does not make a ${CONFIG_FILE} — ${inertLine(reasonOf(parsed.error))}` }
    }
  }
  const typed: [string, string][] = [
    ...(iacRepo !== undefined ? [['--iac-repo', iacRepo] as [string, string]] : []),
    ...(values.environment ?? []).map((one) => ['--environment', one] as [string, string]),
  ]
  const unseen = typed.find(([, value]) => holdsInvisible(value))
  if (unseen !== undefined) {
    return {
      refused:
        `${unseen[0]} ${spelledOut(unseen[1])} holds a control, format or bidi character, ` +
        `which ${CONFIG_FILE} never holds; type it again without one`,
    }
  }
  return {
    flags: {
      ...(iacRepo !== undefined ? { iacRepo } : {}),
      ...(values.environment !== undefined ? { environments: [...values.environment] } : {}),
    },
  }
}

/** The two questions `.idp-agent.yml` can put to a person, and the flag that answers each. */
const CONFIG_QUESTIONS = {
  iacRepo: {
    path: `${CONFIG_FILE}.iacRepo`,
    question: 'Where do the declarations live? A repository locator, e.g. github.com/acme/iac',
  },
  environments: {
    path: `${CONFIG_FILE}.environments`,
    question: 'Which environments does this organisation have? Comma-separated, e.g. dev, staging, prod',
  },
} as const satisfies Record<string, Question>

const CONFIG_FLAGS: readonly (readonly [string, string])[] = [
  [CONFIG_QUESTIONS.iacRepo.path, '--iac-repo'],
  [CONFIG_QUESTIONS.environments.path, '--environment'],
]

type ConfigDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'write'; readonly config: WrittenConfig }
  | { readonly kind: 'missing'; readonly questions: readonly Question[] }
  /** A committed configuration says otherwise: it is never rewritten. */
  | { readonly kind: 'differs' }

/**
 * What `.idp-agent.yml` should say, from what a PERSON typed and nothing else.
 * The inspection is deliberately not a parameter: the configuration seeds the
 * vocabulary every gate measures against (§7.0), so a model's reading of the
 * project must never be where it came from. `backstage:` is never written
 * (D9): it is never requested either, and a URL is never taken from a command
 * line (ADR-0011).
 *
 * No flag, no configuration: a person who typed none of it has not asked for
 * one, and is not asked two questions about the organisation on every
 * service's submission — so `init` without a flag prints what it printed at
 * stage 4, and `init --submit` without one submits the catalog-info alone. A
 * flag starts the configuration, and what it leaves out is asked — with or
 * without `--submit`, since a preview that silently dropped a typed flag
 * would be a flag ignored in silence. A value the committed file already
 * holds is not asked again.
 *
 * Flags and file agreeing, however the file happens to be written, is nothing
 * to write — compared by value, through the one serialiser. Disagreeing is
 * `differs`, and refused here, by `runInitRepo`, before anything else: a
 * configuration is changed by hand, in a reviewed change. `clearService` is
 * never handed one to write over an existing file that disagrees; a file
 * changed after this read is refused at the moment of acting by the forge's
 * divergence check on `.idp-agent.yml`'s bytes (`refuseDivergence`).
 */
function configFor(flags: ConfigFlags, existing: RepositoryConfig | undefined): ConfigDecision {
  if (flags.iacRepo === undefined && flags.environments === undefined) return { kind: 'none' }
  const iacRepo = flags.iacRepo ?? existing?.iacRepo
  const environments = flags.environments ?? existing?.environments
  const missing = [
    ...(iacRepo === undefined ? [CONFIG_QUESTIONS.iacRepo] : []),
    ...(environments === undefined ? [CONFIG_QUESTIONS.environments] : []),
  ]
  if (missing.length > 0) return { kind: 'missing', questions: missing }
  const parsed = repositoryConfigSchema.safeParse({ iacRepo, environments })
  if (!parsed.success) {
    throw new ConfigError(
      `the configuration flags do not make a ${CONFIG_FILE} — ${reasonOf(parsed.error)}`,
    )
  }
  const config = { iacRepo: parsed.data.iacRepo, environments: parsed.data.environments }
  if (existing === undefined) return { kind: 'write', config }
  return serializeConfig(existing) === serializeConfig(config) ? { kind: 'none' } : { kind: 'differs' }
}

/**
 * The configuration's questions put to the person, before `readProject` and
 * the Inspector: a question is a person's time, and it is not asked after
 * three paid round-trips. An answer is held to what a flag is held to — no
 * invisible character, then the schema — and refused as an ANSWER (exit 1),
 * the way `plan` refuses one, not as an argument.
 */
async function settleConfig(
  decided: ConfigDecision,
  flags: ConfigFlags,
  existing: RepositoryConfig | undefined,
  ask: Ask | undefined,
): Promise<ConfigDecision | CommandResult> {
  if (decided.kind !== 'missing') return decided
  if (ask === undefined) return renderInitQuestions(decided.questions)
  const answers = new Map<string, string>()
  for (const [index, question] of decided.questions.entries()) {
    const said = (await ask(question))?.trim()
    if (said === undefined || said === '') return renderInitQuestions(decided.questions.slice(index), true)
    // The locator's field first, as for the flag: a locator it refuses may
    // carry a token, and its reason quotes nothing.
    if (question === CONFIG_QUESTIONS.iacRepo) {
      const locator = repositoryConfigSchema.shape.iacRepo.safeParse(said)
      if (!locator.success) return renderRefusedAnswer(`${question.path}: ${reasonOf(locator.error)}`)
    }
    if (holdsInvisible(said)) {
      return renderRefusedAnswer(
        `${question.path}: ${spelledOut(said)} holds a control, format or bidi character, which ${CONFIG_FILE} never holds`,
      )
    }
    answers.set(question.path, said)
  }
  const iacRepo = answers.get(CONFIG_QUESTIONS.iacRepo.path)
  const environments = answers.get(CONFIG_QUESTIONS.environments.path)
  try {
    return configFor(
      {
        ...flags,
        ...(iacRepo !== undefined ? { iacRepo } : {}),
        ...(environments !== undefined
          ? { environments: environments.split(',').map((one) => one.trim()).filter((one) => one !== '') }
          : {}),
      },
      existing,
    )
  } catch (error) {
    if (error instanceof ConfigError) return renderRefusedAnswer(error.message)
    throw error
  }
}

/**
 * The flags, put into every Component the Architect proposed, and recorded as
 * answers at the fields they fill — whatever the draft had there, a value or
 * an `{unknown}`. What the person said replaces what a model wrote, as an
 * answer at the prompt replaces a redraft's value (`reapplyAnswers`).
 */
function withFlags(
  proposals: readonly Operation[],
  flags: InitAnswers,
): { proposals: Operation[]; answers: Map<string, string> } {
  const answers = new Map<string, string>()
  const filled = proposals.map((operation, index) => {
    if (operation.op !== 'create-entity' || operation.entity.kind !== 'Component') return operation
    for (const [field, key] of INIT_FLAGS) {
      const value = flags[key]
      if (value !== undefined) answers.set(`operations.${String(index)}.entity.${field}`, value)
    }
    const { entity } = operation
    return {
      ...operation,
      entity: {
        ...entity,
        metadata: { ...entity.metadata, ...(flags.name !== undefined ? { name: flags.name } : {}) },
        spec: {
          ...entity.spec,
          ...(flags.type !== undefined ? { type: flags.type } : {}),
          ...(flags.lifecycle !== undefined ? { lifecycle: flags.lifecycle } : {}),
          ...(flags.owner !== undefined ? { owner: flags.owner } : {}),
        },
      },
    } as Operation
  })
  return { proposals: filled, answers }
}

/** A catalog-info the repository keeps, read whole (`ProjectRead.declarations`). */
interface Kept {
  readonly path: string
  readonly text: string
  readonly workspace?: string
}

/** The reference as the file states it, for the line that quotes it. */
const refOf = (identity: Identity): string =>
  `component:${identity.namespace}/${identity.name}`

type Recognition =
  /** Declared already: `refused` holds the reader's reasons when this tool would not write that document. */
  | { readonly declaredIn: string; readonly ref: string; readonly refused: readonly string[] }
  /** The file init would add to already declares another Component, which may be this service. */
  | { readonly conflictIn: string; readonly refs: readonly string[] }

/**
 * Where the repository already declares this Component — or, in the file
 * init would add to, a Component under another namespace or name that may be
 * this very service — or nothing.
 *
 * `named` says the PERSON gave this name, by flag or at the prompt. Their
 * word settles the second case: a name one of that file's Components has, in
 * any namespace, is "that one", and any other name is another Component.
 */
function recognise(
  kept: readonly Kept[],
  name: string,
  named: boolean,
  target: string,
): Recognition | undefined {
  const declared = (file: Kept, identity: Identity): Recognition => {
    const parsed = parseDocuments(file.text)
    const read = parsed.entities.some(
      (entity) => entity.kind === 'Component' && entity.metadata.name === identity.name,
    )
    return { declaredIn: file.path, ref: refOf(identity), refused: read ? [] : parsed.rejections }
  }
  for (const file of kept) {
    const found = identitiesOf(file.text).identities.find((identity) => isThis(identity, name))
    if (found !== undefined) return declared(file, found)
  }
  const file = kept.find((one) => one.path === target)
  const components = file === undefined ? [] : identitiesOf(file.text).identities.filter(isComponent)
  if (file === undefined || components.length === 0) return undefined
  if (named) {
    const same = components.find((identity) => fold(identity.name) === fold(name))
    return same === undefined ? undefined : declared(file, same)
  }
  return { conflictIn: file.path, refs: components.map(refOf) }
}

/**
 * The Component whose name is still a question, by operation, and the name the
 * draft gave it — shown as the draft's (`Question.proposed`). Undefined when
 * every Component's name is settled.
 */
function unnamedOf(
  plan: Plan,
  questions: readonly Question[],
): { readonly index: number; readonly name: string | undefined } | undefined {
  const index = plan.operations.findIndex(
    (operation) =>
      operation.op === 'create-entity' &&
      operation.entity.kind === 'Component' &&
      typeof operation.entity.metadata.name !== 'string',
  )
  if (index === -1) return undefined
  const path = `operations.${String(index)}.entity.metadata.name`
  return { index, name: questions.find((question) => question.path === path)?.proposed }
}

/**
 * The file init would add to already declares a Component, and this one's
 * name is still a question: it is asked as a conflict is, so the person reads
 * what that file declares before naming this service. Before stage 8's slice
 * 2 the name the Inspector read settled the name, and reached the conflict on
 * its own (`recognise`); it is a hint now (`withHints`), and the question it
 * left is this one. The draft's name, when it had one, is shown as the
 * draft's. Undefined when the name is settled, or that file declares none.
 */
function unnamedConflict(
  plan: Plan,
  questions: readonly Question[],
  kept: readonly Kept[],
  target: string,
): Conflict | undefined {
  const file = kept.find((one) => one.path === target)
  const components = file === undefined ? [] : identitiesOf(file.text).identities.filter(isComponent)
  const unnamed = unnamedOf(plan, questions)
  if (file === undefined || components.length === 0 || unnamed === undefined) return undefined
  return {
    ...unnamed,
    reason:
      `${inertLine(file.path, Number.POSITIVE_INFINITY)} already declares ${components.map(refOf).join(', ')}. ` +
      'If this service is that one, answer its name and nothing is added; if it is another, ' +
      'answer this one’s name and it is added beside',
  }
}

/** A name question asked as a conflict: the operation, the draft's name, and what is already declared. */
interface Conflict {
  readonly index: number
  readonly name: string | undefined
  readonly reason: string
}

/** A Component the declarations repository declares: the file, and its name as the file states it. */
interface DeclaredComponent {
  readonly path: string
  readonly name: string
}

/**
 * The Component the declarations repository already gives `name`, compared
 * case-folded and in any namespace, as `recognise` compares a service's own
 * file (stage 8, slice 2, Task 2.3). The first declaration wins, as the
 * catalogue resolves a duplicate (§4.4). A name is all this compares: it says
 * what is declared, and nothing about whether this repository is that
 * Component's — the source location decides that from 2.5, never a name
 * (§ 14).
 */
function declaredComponent(snapshot: RepositorySnapshot, name: string): DeclaredComponent | undefined {
  for (const file of snapshot.files) {
    for (const entity of file.entities) {
      if (entity.kind === 'Component' && fold(entity.metadata.name) === fold(name)) {
        return { path: file.path, name: entity.metadata.name }
      }
    }
  }
  return undefined
}

/**
 * The Architect proposed a name nobody typed, and the declarations repository
 * gives it to a Component already: the name is asked, the declaration shown.
 * Answering that name proposes nothing (`renderNamed`); answering another
 * proposes this one under it.
 */
function declaredConflict(
  plan: Plan,
  questions: readonly Question[],
  snapshot: RepositorySnapshot,
): Conflict | undefined {
  const unnamed = unnamedOf(plan, questions)
  const found = unnamed?.name === undefined ? undefined : declaredComponent(snapshot, unnamed.name)
  if (unnamed === undefined || found === undefined) return undefined
  return {
    ...unnamed,
    reason:
      `${inertLine(found.path, Number.POSITIVE_INFINITY)} in the declarations repository already declares ` +
      `a Component named ${inertLine(found.name)}. If this service is that one, answer its name and ` +
      'nothing is proposed; if it is another, answer this one’s name',
  }
}

/** The service's own: a catalog-info at the root, or the file init would add to. */
const isOwn = (file: string, target: string): boolean => !file.includes('/') || file === target

/**
 * The run had nothing to change, and says which file already says it —
 * `plan`'s `= <file> already declares <ref>`, for the same reason: an empty
 * diff is only an answer when it is visible (§4.3). Exit 0, unless `initExit`
 * makes it 1: the discovery report goes before the count, as it goes before a
 * preview's closing lines.
 */
const renderDeclared = (
  found: readonly { declaredIn: string; ref: string; refused: readonly string[] }[],
  /**
   * The configuration a flag asked for, left unwritten: it rides on the
   * Component's branch, and there is no Component to add. Said, never dropped
   * in silence.
   */
  unwritten?: string,
  /** The discovery report's lines (`coverageLines`). */
  report?: readonly string[],
): CommandResult => ({
  text: [
    'nothing to change — the repository already declares it:',
    '',
    ...found.flatMap(({ declaredIn, ref, refused }) => [
      `  = ${inertLine(declaredIn, Number.POSITIVE_INFINITY)} already declares ${inertLine(ref)}`,
      // Backstage may accept what this tool's reader holds a proposal to — a
      // lifecycle outside the three it writes, a name in upper case — and the
      // service is declared all the same. Said, and left as it is.
      ...(refused.length === 0
        ? []
        : [
            '    this tool would not write that document as it stands, and leaves it as it is:',
            ...refused.map((reason) => `      ${inertLine(reason)}`),
          ]),
    ]),
    ...(unwritten === undefined
      ? []
      : [
          '',
          `${unwritten} is not written either: init writes it beside a Component it adds, and ` +
            'there is none to add — write it by hand, in a reviewed change.',
        ]),
    ...(report === undefined ? [] : ['', ...report]),
    '',
    '0 files · nothing written',
  ].join('\n'),
  found: true,
})

/**
 * The name the person typed is one the declarations repository already gives
 * a Component (stage 8, slice 2, Task 2.3): nothing is proposed, and the run
 * says what is declared and where — in the declarations repository, not in
 * the service, so `renderDeclared`'s "the repository already declares it"
 * would name the wrong one. It claims nothing about which repository that
 * Component is (§ 14 rejects recognising a consumer by name), and writes
 * nothing, the safe direction. Exit 0, unless `initExit` makes it 1.
 */
const renderNamed = (found: DeclaredComponent, unwritten?: string, report?: readonly string[]): CommandResult => ({
  text: [
    `nothing to change — a Component named ${inertLine(found.name)} is already declared ` +
      `(${inertLine(found.path, Number.POSITIVE_INFINITY)}); nothing is proposed`,
    ...(unwritten === undefined
      ? []
      : [
          '',
          `${unwritten} is not written either: init writes it beside a Component it adds, and ` +
            'there is none to add — write it by hand, in a reviewed change.',
        ]),
    ...(report === undefined ? [] : ['', ...report]),
    '',
    '0 files · nothing written',
  ].join('\n'),
  found: true,
})

/**
 * Exit 3, as every question is — and a close this command can keep. `plan`'s
 * "fill them in" names a plan file `init` has none of; here the answers are
 * the four flags, or a terminal, and a field no flag answers says so.
 */
function renderInitQuestions(
  questions: readonly Question[],
  /** At a terminal already, and declined: only the flags are left to name. */
  declined = false,
): CommandResult {
  const flagOf = (question: Question): string | undefined =>
    INIT_FLAGS.find(([field]) => question.path.endsWith(`.entity.${field}`))?.[2] ??
    CONFIG_FLAGS.find(([path]) => question.path === path)?.[1]
  const flags = [...new Set(questions.map(flagOf).filter((flag) => flag !== undefined))]
  const unflagged = questions.filter((question) => flagOf(question) === undefined)
  const count = questions.length
  return {
    text: [
      `${String(count)} ${count === 1 ? 'question' : 'questions'}, asked rather than guessed:`,
      '',
      ...questions.flatMap(questionLines),
      '',
      ...(flags.length > 0
        ? [
            `Answer ${flags.join(', ')} on the command line` +
              (declined ? '.' : ', or run this at a terminal to be asked.'),
          ]
        : []),
      ...(unflagged.length > 0
        ? [
            `${unflagged.map((question) => question.path).join(', ')} ` +
              `${unflagged.length === 1 ? 'has' : 'have'} no flag: ` +
              (declined ? 'answer it at the prompt when this runs again.' : 'run this at a terminal to be asked.'),
          ]
        : []),
      'Nothing was previewed, and nothing was written.',
    ].join('\n'),
    found: false,
    unsupported: true,
  }
}

export interface InitOptions {
  /** The application repository: read, inspected, and never written. */
  readonly project: string
  /**
   * The declarations repository `plan`'s chain found — `IDP_REPO`, or `repo`
   * in the personal config.yml — absolute, and read, never written (stage 8,
   * slice 2, Task 2.3). The Architect drafts over its graph and the gates
   * judge against it, as `plan`'s do. Absent: none was found, `cli/index.ts`
   * has said so on stderr, and the five gates judge against an empty one.
   */
  readonly declarations?: string
  readonly client: LlmClient
  readonly emit: EventSink
  /** The person's `--name`, `--type`, `--lifecycle` and `--owner`, already held to their fields. */
  readonly answers?: InitAnswers
  /**
   * How a question reaches a person (§7.5), as `plan` is handed one. Absent
   * means nobody is there to ask: the questions print, and the run exits 3.
   */
  readonly ask?: Ask
  /** Only a caller that knows it holds a terminal asks for colour. */
  readonly colour?: boolean
  /**
   * Where a line about how the application repository was read goes — stderr,
   * from `cli/index.ts` — when its files were not chosen from what git tracks
   * (`selectionNotice`), or the budget left some unread (`budgetNotice`) —
   * and about a catalog-info that is not the service's own and could not be
   * read, which is compared with no further. Absent, nothing is said.
   */
  readonly notice?: (line: string) => void
  /**
   * `--submit`: the preview becomes one new branch in the service's own
   * repository, cut from `HEAD`, for review (`commands/submit.ts`). Absent,
   * this run writes nothing, and prints what stage 4 printed.
   */
  readonly submit?: SubmitOptions
  /** `--iac-repo` and `--environment`: what `.idp-agent.yml` says, as a person typed it. */
  readonly flags?: ConfigFlags
}

/** No declarations repository was found: the gates judge against this, an empty one. */
const NO_DECLARATIONS: RepositorySnapshot = { folders: [], witnesses: [], files: [] }

export async function runInitRepo(options: InitOptions): Promise<CommandResult> {
  // Everything free, and every question for a person, before the first model
  // call — in this order (D12 and the owner's order of 2026-09-29, one step
  // added by stage 6): the forge — and, from `main`, the road and gh — the
  // configuration's questions, the project's files, init's own verdicts on
  // them, the divergence, the preflight, and only then the Inspector.
  //
  // First, before anything is read: a directory that cannot take a branch —
  // not a clone's root (a service in a subfolder of its repository, which
  // this build does not submit), nobody to commit as, a detached HEAD — is an
  // argument, exit 2.
  const opened =
    options.submit === undefined
      ? undefined
      : await openForSubmission(options.project, 'service', { ...options.submit, route: 'init' })
  // Read before a single agent runs. A committed file that does not parse is
  // not a repository that declared nothing, and this one is about to be
  // rewritten by §7.3 — answering a typo by ignoring it is the worst of both.
  // Its bytes too: a submission proves the base still holds them.
  const read = await readConfigFile(options.project)
  const config = read?.config
  const flags = options.flags ?? {}
  const settled = await settleConfig(configFor(flags, config), flags, config, options.ask)
  if (!('kind' in settled)) return settled
  if (settled.kind === 'differs') {
    return {
      text: [
        `${CONFIG_FILE} already says something else, and a configuration is changed by ` +
          'hand, in a reviewed change — never by this command.',
        'Run this again without --iac-repo and --environment, or with what it says.',
        'Nothing was previewed, and nothing was written.',
      ].join('\n'),
      found: false,
    }
  }
  const written = settled.kind === 'write' ? settled.config : undefined
  // Taken on this side of the line, with every exclusion and cap applied:
  // `agents/` reaches no disk, so the bytes are read here and handed over.
  const snapshot = await readProject(options.project)
  for (const notice of [
    selectionNotice(options.project, snapshot),
    budgetNotice(options.project, snapshot),
  ]) {
    if (notice !== undefined) options.notice?.(notice)
  }

  // What the repository already declares, read whole and outside the budget
  // (review, gap-stage5-readiness-8). A test's or an example's catalog-info
  // is set aside (`isSetAside`). The service's own — the root's, and the file
  // init would add to — must be read whole, every kind and name in it: one
  // nobody can read is one nobody can say anything about, so nothing is
  // previewed over it, and before a model is paid to draft what would be. Any
  // other is said on stderr, and compared with no further.
  const considered = snapshot.declarations.filter((declaration) => !isSetAside(declaration.path))
  const target = targetOf(considered)
  const kept: Kept[] = []
  for (const declaration of considered) {
    const shown = inertLine(declaration.path, Number.POSITIVE_INFINITY)
    const whole = 'unreadable' in declaration ? undefined : declaration
    const trouble =
      whole === undefined
        ? `${'unreadable' in declaration ? declaration.unreadable : ''}`
        : identitiesOf(whole.text).unreadable
          ? 'a document in it states no kind or name that can be read'
          : undefined
    if (trouble === undefined && whole !== undefined) {
      kept.push(whole)
      continue
    }
    if (!isOwn(declaration.path, target)) {
      options.notice?.(
        `${shown} could not be read whole — ${trouble ?? ''} — so init compares with the other ` +
          'catalog-info files, and not with it',
      )
      continue
    }
    const reasons = whole === undefined ? [] : parseDocuments(whole.text).rejections
    return {
      text: [
        `${shown} could not be read whole — ${trouble ?? ''} — so nobody can say what it declares, ` +
          'and init previews nothing over it.',
        ...reasons.map((reason) => `  ${inertLine(reason)}`),
        ...(whole === undefined ? [] : ['Correct that document, and run this again.']),
      ].join('\n'),
      found: false,
    }
  }

  // The declarations repository, read whole before any model is paid, as
  // `plan` reads it (stage 8, slice 2, Task 2.3): a file it cannot read is
  // refused, named, exit 2, rather than judged as absent. Read and never
  // written — slice 2's `init --submit` writes into the service's repository
  // alone, so its preflight and what it has in flight are slice 4's.
  let declared: { readonly snapshot: RepositorySnapshot; readonly contents: ReadonlyMap<string, string> } = {
    snapshot: NO_DECLARATIONS,
    contents: new Map(),
  }
  if (options.declarations !== undefined) {
    const repository = await readRepository(options.declarations)
    declared = { snapshot: repository, contents: await readContents(options.declarations, repository, 'init') }
  }

  if (opened !== undefined) {
    // The gates are about to judge these bytes, and the branch is cut from
    // HEAD: the target's bytes or its absence, every kept declaration the
    // "already declared" and name decisions read, and the configuration's
    // bytes or its absence (check §5.2) — never CATALOG_INFO by name. Refused
    // here, before the Inspector is paid for a diff that cannot be submitted.
    //
    // A limit, stated: the Inspector reads the working tree, uncommitted
    // CODEOWNERS and package.json included, and this proves only what init
    // decides on and writes. An owner read out of an uncommitted file is
    // vouched for though the branch does not carry that file; the diff and
    // the merge request are where a person sees it. Proving every file the
    // Inspector read would refuse init in any repository with one dirty
    // unrelated file, which is the worse trade.
    const files = new Map<string, string | undefined>(kept.map((file) => [file.path, file.text] as const))
    if (!files.has(target)) files.set(target, undefined)
    files.set(CONFIG_FILE, read?.text)
    const refused = await refuseDivergence(opened, { files, scope: 'touched' })
    if (refused !== undefined) return refused
    // § 8 on the service's own repository (decision 17): read before the Inspector is paid
    // for a branch the repository could not take (item 1, refused "with --local named",
    // which the declarations roads do not offer), and the note on who may merge said there,
    // the run going on (2026-10-01). `init` has no --json, so a refusal is prose. A local
    // road reads nothing here.
    const unprotected = await refuseUnprotected(opened, {
      offerLocal: true,
      ...(options.submit?.notice === undefined ? {} : { notice: options.submit.notice }),
    })
    if (unprotected !== undefined) return unprotected
    // 2026-10-01: what is in flight, read before the Inspector is paid. The
    // pull requests changing the service's catalog-info or its configuration
    // are said here; the change is judged once the Architect's bytes exist,
    // and again at the moment of writing.
    const flight = await sayInFlight(
      opened,
      {
        what: "the service's catalog-info",
        paths: ['catalog-info.yaml', 'catalog-info.yml', ...(written === undefined ? [] : [CONFIG_FILE])],
      },
      options.submit?.notice === undefined ? {} : { notice: options.submit.notice },
    )
    if (flight !== undefined) return flight
  }

  // Stage 8's discovery (plan, Task 1.4): after every refusal before the
  // model, so a refused run reads nothing more, and before the Inspector. Its
  // report is printed after the diff and carried to the pull request; no
  // model is sent a byte of it. It never throws.
  const { coverage } = await discover(options.project)
  /** A run that ended where the report is printed: the report said on stderr too, and the exit `initExit`'s. */
  const reported = (result: CommandResult, ending: InitEnding): CommandResult => {
    options.notice?.(coverageSentence(coverage))
    return { ...result, found: initExit(ending, result.found, coverage) }
  }

  const facts = await inspect(options.client, snapshot, options.emit)
  const request = requestOf(facts)

  // The catalogue the Architect drafts over and the gates judge against: the
  // declarations repository `plan` reads, built as `plan` builds it — the
  // graph, the read tools and their witness set, the vocabulary seeded from
  // the service's `.idp-agent.yml`, the owners — so the two commands cannot
  // measure one repository two ways (stage 8, slice 2, Task 2.3). With none
  // found, an empty one, stated as such: every Component is new, and the gates
  // run all the same, so there is one road and the Reviewer reads every init.
  const graph = graphOf(declared.snapshot)
  const tools = buildTools(graph, { refuseUnusedValues: false })
  const contexts = contextsOf(
    options.declarations ?? options.project,
    declared.snapshot,
    declared.contents,
    graph,
    { config, witnessed: tools.witnessed },
  )
  const summary = formatSummary(contexts.summary, contexts.vocabulary)

  /**
   * What the person typed for the four fields of the Component — a flag, or
   * an answer at the prompt. Their word about the one Component `init`
   * declares, whatever a draft calls it: put into every Component the
   * Architect drafts, a redraft included, as a flag always was (`withFlags`),
   * and vouched for at operation 0's fields, where the one Component of a
   * draft the scope accepts sits. Not `recordAnswers`: that follows an answer
   * by its entity's name, and here the name is one of the answers.
   */
  const typed: { -readonly [K in keyof InitAnswers]: InitAnswers[K] } = { ...(options.answers ?? {}) }
  /** Every other answer typed at the prompt, at the path it was typed at. */
  const elsewhere = new Map<string, string>()
  const answersNow = (): RecordedAnswer[] => [
    ...INIT_FLAGS.flatMap(([field, key]) => {
      const value = typed[key]
      return value === undefined ? [] : [{ path: `operations.0.entity.${field}`, value }]
    }),
    ...[...elsewhere].map(([path, value]) => ({ path, value })),
  ]
  /** An answer typed at the prompt: one of the four fields, or another. */
  const heard = (answers: readonly { readonly path: string; readonly value: string }[]): void => {
    for (const { path, value } of answers) {
      const field = /^operations\.\d+\.entity\.(.+)$/.exec(path)?.[1]
      const key = INIT_FLAGS.find(([one]) => one === field)?.[1]
      if (key !== undefined) typed[key] = value
      elsewhere.set(path, value)
    }
  }

  /**
   * The plan the person just filled, which the next run of the gates starts
   * from — `runIntent`'s seed: a filled plan cost no round-trip, and goes
   * through all five gates as a draft does.
   */
  let seed: Plan | undefined

  // The loop `plan "<intent>"` runs (§7.5): the five gates, the questions put
  // to a person, the filled plan through the five gates again.
  for (let round = 0; ; round += 1) {
    // Recognised before anything is drafted or asked about it: a name the
    // person gave — by flag or at the prompt — that the service's own
    // catalog-info already declares (review, gap-init-real-repos-3), or that
    // the declarations repository already gives a Component (stage 8, slice
    // 2, Task 2.3), has nothing more to answer, and no Reviewer is paid for
    // it. Only the person's name: what the Inspector read is a hint (Task
    // 2.1), and a name the Architect drafted is asked, the declaration shown.
    if (typed.name !== undefined) {
      const own = recognise(kept, typed.name, true, target)
      if (own !== undefined && 'declaredIn' in own) {
        return reported(
          renderDeclared([own], written === undefined ? undefined : CONFIG_FILE, coverageLines(coverage)),
          { kind: 'nothing-to-change' },
        )
      }
      const there = declaredComponent(declared.snapshot, typed.name)
      if (there !== undefined) {
        return reported(
          renderNamed(there, written === undefined ? undefined : CONFIG_FILE, coverageLines(coverage)),
          { kind: 'nothing-to-change' },
        )
      }
    }

    let seeded = seed
    seed = undefined
    const outcome = await repair(
      {
        // `requestOf` wrote this sentence, so it vouches for no word in it — a
        // Component named `repository-files` used to sign echoed against
        // "declare this repository ... from what its own files state", which
        // is the engine vouching for the model with its own prose. What the
        // PERSON said is `answers`, and nothing else: what the inspection
        // read is a model's reading, a hint beside the question (`withHints`).
        provenance: { intent: request, wordsOf: 'engine', answers: new Map() },
        answers: answersNow(),
        draft: async (report) => {
          if (seeded !== undefined) {
            const filled = seeded
            seeded = undefined
            return { plan: filled, truncated: 0, rejections: 0 }
          }
          const drafted = await draftPlan(
            options.client,
            tools,
            // The report in the trailing slot, never in `intent`: see
            // `runIntent`, which does the same for the same reason.
            { intent: request, facts, summary, vocabulary: report === undefined ? '' : `\n${report}` },
            options.emit,
          )
          // The person's values replace whatever the draft put at their
          // fields, before anything judges it.
          return drafted.plan === undefined
            ? drafted
            : { ...drafted, plan: { ...drafted.plan, operations: withFlags(drafted.plan.operations, typed).proposals } }
        },
        // The plan and the engine's sentence, and nothing of the Architect's:
        // `runIntent`'s Reviewer, told what the Component writes in the
        // service's repository (`elsewhere`).
        review: (plan, reviewed) => reviewPlan(options.client, { plan, intent: request, ...reviewed }, options.emit),
        // The service's own Component is the person's (row 10b): its name,
        // type, lifecycle and owner are typed or asked, never enumerated off
        // the catalogue this graph now holds.
        signature: { ...contexts.signature, ownComponent: 'stated-or-asked' },
        policy: contexts.policy,
        owners: contexts.owners,
        snapshot: declared.snapshot,
        contents: declared.contents,
        scope: componentsOf,
        elsewhere: (signed) => {
          const minted = mintedEdits(signed, request, kept, target)
          return 'refused' in minted ? [] : minted.edits
        },
      },
      options.emit,
    )

    if (outcome.outcome === 'stopped') {
      // A stop on the scope: every draft parsed and declared more than the
      // service, so there is no value for the person to name — the close says
      // what init takes instead. Read off the last refusal's own words.
      const scoped =
        outcome.gate === 'zod' &&
        outcome.plan !== undefined &&
        componentsOf(outcome.plan).some((line) => outcome.reason.includes(line))
      return renderStopped(outcome.plan, outcome.gate, outcome.reason, outcome.kept, scoped ? SCOPE_STOP : undefined)
    }
    if (outcome.outcome === 'planned') {
      const ended = await concluded(outcome.signed, request, kept, target, options, {
        opened,
        read,
        config: written,
        coverage,
        // What was already wrong in the declarations repository, counted as
        // `plan` counts it; nothing when none was read.
        ...(options.declarations === undefined
          ? {}
          : { standing: { violations: outcome.recheck.standing, repo: options.declarations } }),
      })
      return ended.ending === undefined ? ended.result : reported(ended.result, ended.ending)
    }

    const questions = withHints(outcome.questions, facts)
    // The name is still a question, and something already declares the
    // draft's: the file init would add to (`unnamedConflict`), or the
    // declarations repository (`declaredConflict`). Asked as that conflict,
    // naming what is declared, so the person reads it before naming this
    // service; that name, and nothing is added.
    const conflict =
      unnamedConflict(outcome.plan, questions, kept, target) ??
      declaredConflict(outcome.plan, questions, declared.snapshot)
    if (conflict !== undefined) {
      const path = `operations.${String(conflict.index)}.entity.metadata.name`
      const bare: Question = {
        path,
        question: conflict.reason,
        ...(conflict.name === undefined ? {} : { proposed: conflict.name }),
      }
      const question = withHints([bare], facts)[0] ?? bare
      if (options.ask === undefined || round >= ASK_LIMITS.maxRounds) {
        // Nobody to ask: the name as this conflict, and every other question
        // the run has, so a script learns every flag it needs in one run.
        return renderInitQuestions([question, ...questions.filter((one) => one.path !== path)])
      }
      const asked: Plan = {
        ...outcome.plan,
        operations: outcome.plan.operations.map((operation, index) =>
          index === conflict.index && operation.op === 'create-entity'
            ? ({
                ...operation,
                entity: {
                  ...operation.entity,
                  // A name is a string in the plan's type and a question at run
                  // time, as the signature leaves one (`questionsOf`).
                  metadata: { ...operation.entity.metadata, name: { unknown: conflict.reason } },
                },
              } as unknown as Operation)
            : operation,
        ),
      }
      const filled = await fillAnswers(asked, [question], options.ask)
      if (filled.outcome === 'refused') return renderRefusedAnswer(filled.reason)
      if (filled.outcome === 'declined') return renderInitQuestions(filled.unanswered, true)
      const reparsed = planSchema.safeParse(filled.plan)
      if (!reparsed.success) return renderRefusedAnswer(reasonOf(reparsed.error))
      heard(filled.answers)
      seed = reparsed.data
      continue
    }

    if (options.ask === undefined || round >= ASK_LIMITS.maxRounds) {
      return renderInitQuestions(questions)
    }
    const filled = await fillAnswers(outcome.plan, questions, options.ask)
    if (filled.outcome === 'refused') return renderRefusedAnswer(filled.reason)
    if (filled.outcome === 'declined') return renderInitQuestions(filled.unanswered, true)

    // Gate [1] over the plan the person just changed: an answer is a value
    // entering the plan, and the schema decides whether it may be there — an
    // owner typed as `tiger` is refused here, naming the field, rather than
    // reaching a catalog-info because the person said it.
    const reparsed = planSchema.safeParse(filled.plan)
    if (!reparsed.success) return renderRefusedAnswer(reasonOf(reparsed.error))
    heard(filled.answers)
    seed = reparsed.data
  }
}

/**
 * The signed plan's Components, minted into the file the engine chose, and
 * what that does to the service's repository — the catalog-info `previewOf`
 * shows, and what the Reviewer is told the Component writes there
 * (`RepairInput.elsewhere`). The plan boundary is re-crossed because this is
 * a different object from the one the gates parsed — the same reason `repair`
 * runs gate [1] over a callback's output rather than trusting the callback.
 * Refused, with the schema's reason, when the composed plan is not one.
 */
function mintedEdits(
  signed: SignedPlan,
  request: string,
  kept: readonly Kept[],
  target: string,
): ReturnType<typeof catalogInfoEdits> | { readonly refused: string } {
  const minted = planSchema.safeParse({
    intent: request,
    operations: signed.plan.operations.map((operation) => filedIn(asCatalogInfo(operation), target)),
  })
  if (!minted.success) return { refused: reasonOf(minted.error) }
  return catalogInfoEdits(minted.data, { files: kept })
}

/**
 * The signed Component, minted into the file the engine chose, and its diff.
 * Exported for its test alone: no signed plan reaches a drop through
 * `runInitRepo` today (see below), so the exit a drop gets is pinned here.
 */
export function previewOf(
  signed: Parameters<typeof renderPreview>[0]['signed'],
  request: string,
  kept: readonly Kept[],
  target: string,
  options: Pick<InitOptions, 'colour'>,
  /** The discovery report's lines, after the diff (`coverageLines`). */
  report?: readonly string[],
  /** What was already wrong in the declarations repository the gates judged against (`Standing`). */
  standing?: Standing,
): CommandResult {
  // Only now: `mintedEdits` re-crosses the plan boundary.
  //
  // The `before` is the file as the repository keeps it, read whole and
  // outside the budget — never a capped snapshot, which previewed a creation
  // over a file the budget had left out (review, gap-stage5-readiness-8). The
  // same composition `clearService` mints from, so the branch carries the file
  // this showed.
  //
  // `planEdits` is not what drops here: it drops every create-catalog-info,
  // because it describes the OTHER repository — the one this function is
  // standing in. A drop is `catalogInfoEdits`' own effect check, rendered as
  // `plan` renders one. No signed plan reaches it today: a question stops
  // before this, and an own catalog-info nobody can read whole is refused
  // before the model (`runInitRepo`).
  const minted = mintedEdits(signed, request, kept, target)
  if ('refused' in minted) {
    return { text: `the composed plan is not a plan — ${inertLine(minted.refused)}`, found: false }
  }
  const { edits, dropped } = minted
  const preview = renderPreview({
    signed,
    edits,
    dropped,
    ...(options.colour !== undefined ? { colour: options.colour } : {}),
    apply: APPLY,
    ...(report === undefined ? {} : { report }),
    ...(standing === undefined ? {} : { standing: standing.violations, repo: standing.repo }),
  })
  // A drop is a negative answer, whatever else the diff shows: `renderPreview`
  // has no re-check to read one from here, and would end a plan whose only
  // Component was swallowed on "nothing to change." at exit 0 (#83).
  // `clearService` refuses the same plan, so a preview never succeeds where
  // the submission would not.
  return dropped.length > 0 ? { ...preview, found: false } : preview
}

/**
 * Where a signed Component ends: the stage-4 preview, byte for byte, when
 * nothing about it is submitted or configured; otherwise the clearance.
 *
 * With `--submit` or a configuration flag, the diff is the clearance's —
 * `clearService` mints from the very `target` and `kept` the preview composes
 * against, and adds `.idp-agent.yml` — so what is previewed is what would be
 * submitted, filed at the same place. A clearance refused is refused with or
 * without `--submit`: a preview of bytes that cannot be submitted would be a
 * diff of something this command will never write.
 */
async function concluded(
  signed: Parameters<typeof renderPreview>[0]['signed'],
  request: string,
  kept: readonly Kept[],
  target: string,
  options: InitOptions,
  submission: {
    readonly opened: Opened | undefined
    readonly read: Parameters<typeof clearService>[1]['existing']
    readonly config: WrittenConfig | undefined
    readonly coverage: Coverage
    readonly standing?: Standing
  },
): Promise<{ readonly result: CommandResult; readonly ending: InitEnding | undefined }> {
  const { opened, read, config, coverage, standing } = submission
  const report = coverageLines(coverage)
  if (opened === undefined && config === undefined) {
    return { result: previewOf(signed, request, kept, target, options, report, standing), ending: { kind: 'preview' } }
  }
  const cleared = clearService(signed, { target, kept, existing: read, config, coverage })
  if ('outcome' in cleared) {
    // Refused before any Component is concluded: no report, and the exit it had.
    return {
      result: {
        text: [
          'refused — nothing was previewed, and nothing was written:',
          ...cleared.reasons.map((reason) => `  ${inertLine(reason)}`),
        ].join('\n'),
        found: false,
      },
      ending: undefined,
    }
  }
  const render = (status: PreviewStatus): CommandResult =>
    renderPreview({
      signed,
      edits: cleared.edits,
      dropped: [],
      status,
      apply: APPLY,
      report,
      ...(standing === undefined ? {} : { standing: standing.violations, repo: standing.repo }),
      ...(options.colour !== undefined ? { colour: options.colour } : {}),
    })
  // Without --submit, the tail is APPLY, as a preview's always was.
  if (opened === undefined || cleared.edits.length === 0) {
    return { result: render({ kind: 'applied-by-hand', apply: APPLY }), ending: { kind: 'preview' } }
  }
  // Kept whole: what `submit` did decides the exit as much as its text does.
  const { result, report: submitted } = await submit({
    opened,
    cleared,
    render,
    ...(options.submit?.confirm !== undefined ? { confirm: options.submit.confirm } : {}),
    ...(options.submit?.notice !== undefined ? { notice: options.submit.notice } : {}),
  })
  return { result, ending: { kind: 'submitted', report: submitted } }
}

/**
 * What was already wrong in the declarations repository the gates judged
 * against, in files no plan of `init`'s touches, and the repository, for the
 * one line `plan` prints about it (`renderPreview`'s `standing`).
 */
interface Standing {
  readonly violations: readonly Violation[]
  readonly repo: string
}

/** How an init run ended where the report is printed: the preview, nothing to change, or what `submit` reported. */
export type InitEnding =
  | { readonly kind: 'preview' }
  | { readonly kind: 'nothing-to-change' }
  | { readonly kind: 'submitted'; readonly report: SubmissionReport }

/**
 * The one place `init`'s exit is decided (owner's answer 2, settled
 * 2026-10-04, read literally): today's `found`, turned false where the run
 * wrote nothing for review — a preview, nothing to change, nothing to submit,
 * a confirmation declined — while its discovery verified no finding and read
 * the repository in part. A finding verified is one `verifiedFindings` counts,
 * the count the sentence says: a value the engine could not read is not one
 * (owner's answer 7, 2026-10-06). A branch cut or a pull request opened keeps its 0,
 * and every other outcome its code. It never turns a `false` into `true`.
 * Exported for its table's test: `unchanged` is not reachable through
 * `runInitRepo`, which previews a change with no edit before `submit`.
 */
export function initExit(ending: InitEnding, found: boolean, coverage: Coverage): boolean {
  const unverified = verifiedFindings(coverage) === 0 && !isComplete(coverage)
  switch (ending.kind) {
    case 'preview':
    case 'nothing-to-change':
      return found && !unverified
    case 'submitted': {
      const outcome = ending.report.outcome
      switch (outcome) {
        case 'unchanged':
        case 'declined':
          return found && !unverified
        case 'created':
        case 'already-submitted':
        case 'already-proposed':
        case 'pushed-without-pull-request':
        case 'closed':
        case 'refused':
          return found
        default: {
          const _exhaustive: never = outcome
          return _exhaustive
        }
      }
    }
    default: {
      const _exhaustive: never = ending
      return _exhaustive
    }
  }
}

/**
 * The line a preview of `init` ends on: how to apply it. `plan`'s — "the merge
 * is what authorises it" — is about the declarations repository, and a
 * catalog-info lands in the service's own, so it sent nobody anywhere (review,
 * gap-init-real-repos-8). The diff's paths are the service's, `a/` and `b/`
 * prefixed, and the lines around it are not a patch, so `git apply` takes
 * stdout as it is; the questions and the progress are on stderr.
 *
 * A file, not a pipe: `idpa init | git apply` runs the Inspector and the
 * Architect again, a live model can draft other bytes the second time, and
 * those are applied unread — or, when that run ends on a question, nothing is.
 */
const APPLY =
  "Nothing is written. To write it, save a run to a file, read it, and apply that file in the " +
  "service's repository — another run may draft other bytes than these: " +
  'idpa init > catalog-info.diff, then git apply catalog-info.diff'
