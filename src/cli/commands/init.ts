import path from 'node:path'
import { draftPlan } from '../../agents/architect.js'
import type { EventSink } from '../../agents/events.js'
import { inspect } from '../../agents/inspector.js'
import { formatSummary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import type { ProjectFacts } from '../../agents/tools/project-tools.js'
import { EntityGraph } from '../../context/graph/entity-graph.js'
import { summariseGraph } from '../../context/graph/summary.js'
import { readProject } from '../../context/project-fs/snapshot.js'
import type { FileEdit } from '../../core/diff/unified.js'
import { questionsOf, type Question } from '../../core/plan/clarify.js'
import { materialise } from '../../core/plan/materialise.js'
import type { Provenance } from '../../core/plan/provenance.js'
import { signPlan } from '../../core/plan/sign.js'
import { COMPONENT_LIFECYCLES, ownerRefSchema } from '../../core/schemas/entity.js'
import { planSchema, proposedName, type Operation, type Plan } from '../../core/schemas/plan.js'
import { reasonOf } from '../../core/schemas/reject.js'
import { documentNames, parseDocuments, serializeEntity } from '../../core/yaml/serialize.js'
import { insertDocument } from '../../core/yaml/surgery.js'
import type { LlmClient } from '../../llm/client.js'
import { readConfig, seededVocabulary } from '../config.js'
import { budgetNotice, selectionNotice } from '../repository.js'
import { loadTemplates } from '../../scaffold/templates.js'
import { scaffoldLayout } from '../../scaffold/layout.js'
import { writeScaffold, type FileIO } from '../../scaffold/write.js'
import { readRegistrationFile } from '../../context/iac-fs/snapshot.js'
import {
  REGISTRATION_FILE,
  registers,
  renderRegistration,
} from '../../core/validate/registration.js'
import {
  ASK_LIMITS,
  fillAnswers,
  questionLines,
  renderPreview,
  renderRefusedAnswer,
  type Ask,
} from './plan.js'
import { inertLine } from '../render/plain.js'
import type { CommandResult } from './result.js'

/**
 * Printed on every run, including the one that writes nothing. The second
 * reader of a repository is as entitled to it as the first, and a tool that
 * only admits its limits once has not admitted them.
 */
const BRANCH_PROTECTION = `Branch protection is set in the forge, not here. Required on the default branch:
  · require a pull request before merging — 1 approval
  · require review from Code Owners
  · dismiss stale approvals on a new push
  · no force push, no branch deletion
  · include administrators
This build cannot verify these. The live check — that the token which opens a
request cannot merge it — arrives at stage 6.`

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
  const report = await writeScaffold(options.root, files, io)
  const notice = await registrationNotice(options.root, report.kept)

  const listed = [...report.written, ...report.kept].sort()
  return {
    ...(notice !== undefined ? { notice } : {}),
    text: [
      `wrote ${report.written.length} · kept ${report.kept.length}`,
      ...listed.map((file) => `  ${report.written.includes(file) ? '+' : '=' } ${file}`),
      '',
      BRANCH_PROTECTION,
    ].join('\n'),
    found: true,
  }
}

/**
 * `idp-agent init --repo <dir>` — once per application (design §7.3).
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
 * Where a service declares itself when it keeps no catalog-info yet.
 * Backstage's own convention, at the root of the repository the CLI was
 * pointed at.
 *
 * Never a field: §5.2 says the engine chooses where a declaration is filed,
 * and this is that choice for the one operation whose file lives outside the
 * declarations repository. A repository that already keeps one — a `.yml`,
 * or one in another folder — is added to where it keeps it (`targetOf`).
 */
export const CATALOG_INFO = 'catalog-info.yaml'

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
 * write**, and only where the inspection actually established them — and
 * those four, placed at the fields they were read for (`inspected`), are what
 * the signature is measured against. That is the guarantee this buys: a name,
 * a type, a lifecycle or an owner the Architect invents is vouched for by
 * nothing, enumerated by nothing, and becomes a question the CLI puts to the
 * user (design §4.1). The Architect cannot introduce a fact the repository
 * does not state.
 *
 * The type was the one of the four that did not hold, and the sentence above is
 * only true because `sign.ts` stopped classifying a Component's `spec.type`
 * structurally. It is `z.string().min(1).max(63)`, not the closed union a
 * Resource's is, so an invented one signed `derived` and reached the
 * `catalog-info.yaml` below without anyone being asked. On this road the
 * vocabulary is empty — the graph is `EntityGraph.from([])`, see `runInitRepo`
 * — so a Component type is the one the inspection read or it is a question,
 * and there is no third answer.
 *
 * `forgeHandle` is deliberately absent, and its absence is the point of the
 * field: `@acme/platform` is a forge handle and `group:default/platform` is an
 * entity reference, two namespaces that do not survive translation. It is
 * stated to the model as a handle — `formatFacts` prints it — and kept out of
 * this sentence and out of `inspected`, so it can never vouch for itself as an
 * owner. `runtime` is absent too: it is evidence for `spec.type`, not a value
 * any proposal field carries.
 *
 * What this does NOT cover, and it is the reason nothing here writes: the
 * Inspector is a model reading files, so this request is not a human's words.
 * The signature says a value matches what the inspection established. It says
 * nothing about whether the inspection was right — §7.3's "confirms the owner
 * it inferred rather than assuming it" is a human reading the diff below.
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
 *     that vanishes is an operation nobody can argue with.
 *   - The engine mints the real operation, and does it AFTER the signature has
 *     judged what the model proposed. See `runInitRepo`.
 */
function componentsOf(
  operations: readonly Operation[],
): { proposals: Operation[] } | { refusals: string[] } {
  const proposals: Operation[] = []
  const refusals: string[] = []

  for (const [opIndex, operation] of operations.entries()) {
    if (operation.op === 'create-entity' && operation.entity.kind === 'Component') {
      proposals.push(operation)
      continue
    }
    refusals.push(
      `operations.${String(opIndex)}: init declares this repository and nothing else; ` +
        `a ${operation.op === 'create-entity' ? operation.entity.kind : operation.op} ` +
        'belongs to a plan, not to an init',
    )
  }

  return refusals.length > 0 ? { refusals } : { proposals }
}

/**
 * What the inspection read, as answers at the fields it read them for.
 *
 * The four values `requestOf` names, placed where a Component carries each one
 * — its name, its type, its lifecycle, its owner — in every Component the
 * Architect proposed. A fact vouches for the field it was read for and for no
 * other: the lifecycle the inspection read as `production` says nothing about
 * a `spec.type` spelled the same way, and a set of values used to say it did.
 * A fact that is `{unknown}` places nothing, and neither does a field the
 * inspection has no fact for; both leave the value vouched for by nothing,
 * which is a question — the safe direction.
 */
function inspected(facts: ProjectFacts, proposals: readonly Operation[]): Map<string, string> {
  const fields = [
    ['metadata.name', facts.name],
    ['spec.type', facts.type],
    ['spec.lifecycle', facts.lifecycle],
    ['spec.owner', facts.owner],
  ] as const
  const answers = new Map<string, string>()
  for (const [index] of proposals.entries()) {
    for (const [field, fact] of fields) {
      const value = known(fact)
      if (value !== undefined) answers.set(`operations.${String(index)}.entity.${field}`, value)
    }
  }
  return answers
}

/**
 * The operation §7.3 names, minted by the engine out of a proposal the
 * signature has already vouched for.
 *
 * The order is the whole of it. Minting first put `repoPath` in front of
 * `signPlan`, which classifies a leaf by where it came from and has no class
 * for "the engine wrote this" — so `catalog-info.yaml` came out `novel` and the
 * CLI asked the user which path it should be, about a path chosen by the code
 * putting the question. Provenance is a question about what a MODEL wrote, and
 * this field was never the model's to write.
 *
 * One argument, as stage 5's plan moves it (docs/stage-8-brief.md §11); the
 * file a repository already keeps is a second step, `filedIn`.
 */
const asCatalogInfo = (operation: Operation): Operation =>
  operation.op === 'create-entity' && operation.entity.kind === 'Component'
    ? { op: 'create-catalog-info', repoPath: CATALOG_INFO, entity: operation.entity }
    : operation

/** A minted operation, filed where the engine chose (`targetOf`), never the model. */
const filedIn = (operation: Operation, repoPath: string): Operation =>
  operation.op === 'create-catalog-info' ? { ...operation, repoPath } : operation

/**
 * The person's own values for the three fields no file of a service states
 * reliably (review, gap-init-real-repos-2): its catalogue name, its lifecycle —
 * no common file states one — and its owner, which CODEOWNERS states only as
 * a forge handle the Inspector is forbidden to translate. Passed as flags,
 * they are what an answer at the prompt is: the user's word about one field,
 * vouched for as answered, and held to what that field accepts.
 */
export interface InitAnswers {
  readonly name?: string
  readonly lifecycle?: string
  readonly owner?: string
}

/** The field each flag answers, and the flag, for the line that names it. */
const INIT_FLAGS = [
  ['metadata.name', 'name', '--name'],
  ['spec.lifecycle', 'lifecycle', '--lifecycle'],
  ['spec.owner', 'owner', '--owner'],
] as const

/**
 * The flags, held to the rules an answer typed at the prompt is held to: a
 * lifecycle outside the closed set `questionsOf` offers, an owner that is not
 * an entity reference, a name Backstage would refuse. Refused before a model
 * is chosen — a bad flag is exit 2, and a paid inspection is not how a typo is
 * found. Each refusal quotes the value, cleaned: it is what was typed.
 */
export function initAnswersOf(values: {
  readonly name?: string | undefined
  readonly lifecycle?: string | undefined
  readonly owner?: string | undefined
}): { answers: InitAnswers } | { refused: string } {
  const { name, lifecycle, owner } = values
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
      ...(lifecycle !== undefined ? { lifecycle } : {}),
      ...(owner !== undefined ? { owner } : {}),
    },
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

/** A document's identity as it states it: kind + namespace + name, unchecked. */
interface Identity {
  readonly kind: string | undefined
  readonly namespace: string
  readonly name: string
}

/**
 * The identities a file states, and whether one of its documents states a kind
 * or a name nobody can read.
 *
 * Read by `documentNames`, which reads the stream as `parseDocuments` does —
 * with or without `---`, in CRLF or not — and without the schema: a Component
 * this tool would not write (a lifecycle of `unknown`, a name in upper case)
 * is still that Component to Backstage, and to this. Identity is kind +
 * namespace + name (review, core-yaml-4): an API or a Resource of the same
 * name is another entity. A namespace a document does not state is
 * Backstage's `default`.
 */
function identitiesOf(text: string): { identities: Identity[]; unreadable: boolean } {
  const { named, unreadable } = documentNames(text)
  return {
    identities: named.map((document) => ({
      kind: document.kind,
      namespace: document.namespace ?? 'default',
      name: document.name,
    })),
    // A document with a name and no kind is refused by the reader, and may be
    // a Component: nobody can say, so it counts as unreadable.
    unreadable: unreadable || named.some((document) => document.kind === undefined),
  }
}

/** Backstage compares references case-insensitively. */
const fold = (text: string): string => text.toLowerCase()

const isComponent = (identity: Identity): boolean => fold(identity.kind ?? '') === 'component'

/** The reference as the file states it, for the line that quotes it. */
const refOf = (identity: Identity): string =>
  `component:${identity.namespace}/${identity.name}`

/** Whether `identity` is `component:default/<name>` — what init writes. */
const isThis = (identity: Identity, name: string): boolean =>
  isComponent(identity) && fold(identity.namespace) === 'default' && fold(identity.name) === fold(name)

/** Whether a file declares the Component init would write under `name`. */
const declaresComponent = (text: string, name: string): boolean =>
  identitiesOf(text).identities.some((identity) => isThis(identity, name))

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

/** A catalog-info by Backstage's own name, `.yaml` or `.yml`. */
const isPlainCatalogInfo = (file: string): boolean =>
  /^catalog-info\.ya?ml$/i.test(file.split('/').at(-1) ?? '')

/**
 * Folders whose catalog-info describes something other than the service: a
 * test's fixture, an example, a template not rendered yet. Never where init
 * files the service, never what it compares with, and never what stops it.
 */
const SET_ASIDE = new Set([
  '__fixtures__',
  '__snapshots__',
  '__tests__',
  'e2e',
  'example',
  'examples',
  'fixture',
  'fixtures',
  'sample',
  'samples',
  'skeleton',
  'spec',
  'template',
  'templates',
  'test',
  'testdata',
  'tests',
])

const isSetAside = (file: string): boolean =>
  file
    .toLowerCase()
    .split('/')
    .slice(0, -1)
    .some((folder) => SET_ASIDE.has(folder))

/**
 * Which file a new Component is added to — the engine's choice, never the
 * model's (§5.2): the root's `catalog-info.yaml`, else the root's `.yml`, else
 * the one plain catalog-info the repository keeps elsewhere, else a new
 * `catalog-info.yaml` at the root. A catalog-info in a workspace — a folder
 * with its own package manifest — is that workspace's, and one in a test's or
 * an example's folder is set aside before this is asked (`isSetAside`). Two
 * or more elsewhere and none at the root is a monorepo's, each folder's own,
 * and none of them is this one.
 */
function targetOf(declarations: readonly { readonly path: string; readonly workspace?: string }[]): string {
  for (const root of [CATALOG_INFO, 'catalog-info.yml']) {
    if (declarations.some((file) => file.path === root)) return root
  }
  const elsewhere = declarations.filter(
    (file) => isPlainCatalogInfo(file.path) && file.workspace === undefined,
  )
  return elsewhere.length === 1 && elsewhere[0] !== undefined ? elsewhere[0].path : CATALOG_INFO
}

/** The service's own: a catalog-info at the root, or the file init would add to. */
const isOwn = (file: string, target: string): boolean => !file.includes('/') || file === target

/** The Component names a signed plan has settled, by operation — a question is no name yet. */
const settledNames = (plan: Plan): { name: string; index: number }[] =>
  plan.operations.flatMap((operation, index) =>
    operation.op === 'create-entity' &&
    operation.entity.kind === 'Component' &&
    typeof operation.entity.metadata.name === 'string'
      ? [{ name: operation.entity.metadata.name, index }]
      : [],
  )

/**
 * Exit 0: the run had nothing to change, and says which file already says it —
 * `plan`'s `= <file> already declares <ref>`, for the same reason: an empty
 * diff is only an answer when it is visible (§4.3).
 */
const renderDeclared = (
  found: readonly { declaredIn: string; ref: string; refused: readonly string[] }[],
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
    '',
    '0 files · nothing written',
  ].join('\n'),
  found: true,
})

/**
 * Exit 3, as every question is — and a close this command can keep. `plan`'s
 * "fill them in" names a plan file `init` has none of; here the answers are
 * the three flags, or a terminal, and a field no flag answers says so.
 */
function renderInitQuestions(
  questions: readonly Question[],
  /** At a terminal already, and declined: only the flags are left to name. */
  declined = false,
): CommandResult {
  const flagOf = (question: Question): string | undefined =>
    INIT_FLAGS.find(([field]) => question.path.endsWith(`.entity.${field}`))?.[2]
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
  readonly client: LlmClient
  readonly emit: EventSink
  /** The person's `--name`, `--lifecycle` and `--owner`, already held to their fields. */
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
}

export async function runInitRepo(options: InitOptions): Promise<CommandResult> {
  // Read before a single agent runs. A committed file that does not parse is
  // not a repository that declared nothing, and this one is about to be
  // rewritten by §7.3 — answering a typo by ignoring it is the worst of both.
  const config = await readConfig(options.project)
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

  const facts = await inspect(options.client, snapshot, options.emit)
  const request = requestOf(facts)

  // An empty catalogue, stated as such. This build has no local declarations
  // repository at init time — §7.0's `iacRepo` is a URL and nothing here clones
  // one — so the Architect reads nothing and witnesses nothing. What that does
  // NOT cover: it cannot tell whether this component is already declared in
  // the declarations repository (stage 8 reads it); what the SERVICE's own
  // repository declares is read below, from `kept`.
  const graph = EntityGraph.from([])
  // The Architect's tools, as `plan` builds them. An empty catalogue refuses
  // no value anyway; the option is here so the two Architects cannot drift.
  const tools = buildTools(graph, { refuseUnusedValues: false })
  const { summary, vocabulary } = summariseGraph(graph)
  const seeded = seededVocabulary(vocabulary, config)

  const drafted = await draftPlan(
    options.client,
    tools,
    { intent: request, facts, summary: formatSummary(summary, seeded), vocabulary: '' },
    options.emit,
  )

  if (drafted.plan === undefined) {
    // `draftPlan` has already emitted `refused` with the model's own account of
    // why. Repeated here because an exit code is not a sentence.
    return {
      text: 'the Architect proposed nothing, so there is no catalog-info to show.',
      found: false,
    }
  }

  const narrowed = componentsOf(drafted.plan.operations)
  if ('refusals' in narrowed) {
    return {
      text: [
        'refused before signing — init declares one Component, this repository’s own:',
        ...narrowed.refusals.map((refusal) => `  ${inertLine(refusal)}`),
      ].join('\n'),
      found: false,
    }
  }

  // The flags first: they are the person's, and replace whatever the draft
  // put at their fields before anything judges the draft.
  const flagged = withFlags(narrowed.proposals, options.answers ?? {})
  let proposals = flagged.proposals
  /** Every value the person gave — a flag, or an answer at the prompt — by the field it answered. */
  const answered = new Map(flagged.answers)

  // The ask loop `plan --from` runs, over the one operation init proposes:
  // sign, ask what nobody can vouch for, fill, re-parse, and sign again. The
  // plan never moves between rounds — nothing redrafts it — so an answer stays
  // at the path it was typed at.
  for (let round = 0; ; round += 1) {
    // `requestOf` wrote this sentence, so it vouches for no word in it — a
    // Component named `repository-files` used to sign echoed against "declare
    // this repository ... from what its own files state", which is the engine
    // vouching for the model with its own prose.
    //
    // What the inspection actually READ out of the project stands behind
    // itself, as answers at the fields it was read for: the same four values
    // the sentence names — a name, type, lifecycle or owner the Architect
    // invents is vouched for by nothing and becomes a question. What the
    // PERSON said, by flag or at the prompt, is laid over it: their word about
    // a field outranks what a model read in a file.
    const provenance: Provenance = {
      intent: request,
      wordsOf: 'engine',
      answers: new Map([...inspected(facts, proposals), ...answered]),
    }
    const draft: Plan = { intent: request, operations: proposals }
    const signed = signPlan(
      draft,
      {
        // Nothing the engine returned, because nothing was read: see the graph
        // above. Every value is vouched for by the inspection, the person, or
        // by nothing.
        witnessed: tools.witnessed,
        vocabulary: seeded,
        repoRoot: options.project,
        declared: new Map(),
      },
      provenance,
    )
    if ('outcome' in signed) {
      return {
        text: [
          'refused at the signature — the engine signs what it can vouch for:',
          // A reason quotes at most a name the schema has held to Backstage's
          // characters; cleaned anyway, for the refusal that quotes more.
          ...signed.refusals.map((refusal) => `  ${refusal.path}: ${inertLine(refusal.reason)}`),
        ].join('\n'),
        found: false,
      }
    }

    // Recognised before anything is asked about it: a service whose own
    // catalog-info already declares it has nothing to answer (review,
    // gap-init-real-repos-3). Only a name the signature settled is looked up —
    // a name that is still a question names nothing yet.
    const names = settledNames(signed.plan)
    const recognised = names.map(({ name, index }) => ({
      name,
      index,
      found: recognise(kept, name, answered.has(`operations.${String(index)}.entity.metadata.name`), target),
    }))
    const declared = recognised.flatMap(({ found }) =>
      found !== undefined && 'declaredIn' in found ? [found] : [],
    )
    if (names.length > 0 && declared.length === names.length) return renderDeclared(declared)

    // The file init would add to already declares another Component: in a
    // service's own file, most likely this service under another name or
    // namespace. Appending would declare it twice, so the name is asked —
    // that name, and nothing is added; another, and it is added beside.
    const conflict = recognised.find(({ found }) => found !== undefined && 'conflictIn' in found)
    if (conflict?.found !== undefined && 'conflictIn' in conflict.found) {
      const { conflictIn, refs } = conflict.found
      const path = `operations.${String(conflict.index)}.entity.metadata.name`
      const reason =
        `${inertLine(conflictIn, Number.POSITIVE_INFINITY)} already declares ${refs.join(', ')}. ` +
        'If this service is that one, answer its name and nothing is added; if it is another, ' +
        'answer this one’s name and it is added beside'
      const question: Question = { path, question: reason, proposed: conflict.name }
      if (options.ask === undefined || round >= ASK_LIMITS.maxRounds) {
        return renderInitQuestions([question])
      }
      const asked: Plan = {
        ...signed.plan,
        operations: signed.plan.operations.map((operation, index) =>
          index === conflict.index && operation.op === 'create-entity'
            ? ({
                ...operation,
                entity: {
                  ...operation.entity,
                  // A name is a string in the plan's type and a question at run
                  // time, as the signature leaves one (`questionsOf`).
                  metadata: { ...operation.entity.metadata, name: { unknown: reason } },
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
      proposals = reparsed.data.operations
      for (const one of filled.answers) answered.set(one.path, one.value)
      continue
    }

    const questions = questionsOf(signed.plan, { draft })
    if (questions.length === 0) return previewOf(signed, request, kept, target, options)
    if (options.ask === undefined || round >= ASK_LIMITS.maxRounds) {
      return renderInitQuestions(questions)
    }

    const filled = await fillAnswers(signed.plan, questions, options.ask)
    if (filled.outcome === 'refused') return renderRefusedAnswer(filled.reason)
    if (filled.outcome === 'declined') return renderInitQuestions(filled.unanswered, true)

    // Gate [1] over the plan the person just changed: an answer is a value
    // entering the plan, and the schema decides whether it may be there — an
    // owner typed as `tiger` is refused here, naming the field, rather than
    // reaching a catalog-info because the person said it.
    const reparsed = planSchema.safeParse(filled.plan)
    if (!reparsed.success) return renderRefusedAnswer(reasonOf(reparsed.error))
    proposals = reparsed.data.operations
    for (const one of filled.answers) answered.set(one.path, one.value)
  }
}

/** The signed Component, minted into the file the engine chose, and its diff. */
function previewOf(
  signed: Parameters<typeof renderPreview>[0]['signed'],
  request: string,
  kept: readonly Kept[],
  target: string,
  options: InitOptions,
): CommandResult {
  // Only now. The plan boundary is re-crossed because this is a different
  // object from the one `draftPlan` parsed — the same reason `repair` runs gate
  // [1] over a callback's output rather than trusting the callback.
  const minted = planSchema.safeParse({
    intent: request,
    operations: signed.plan.operations.map((operation) => filedIn(asCatalogInfo(operation), target)),
  })
  if (!minted.success) {
    return {
      text: `the composed plan is not a plan — ${inertLine(reasonOf(minted.error))}`,
      found: false,
    }
  }

  return renderPreview({
    signed,
    // The `before` is the file as the repository keeps it, read whole and
    // outside the budget — never a capped snapshot, which previewed a creation
    // over a file the budget had left out (review, gap-stage5-readiness-8).
    edits: catalogInfoEdits(minted.data, { files: kept }),
    // Every operation produced bytes; `planEdits` is what drops a
    // create-catalog-info, and it drops it because it describes the OTHER
    // repository — the one this function is standing in.
    dropped: [],
    ...(options.colour !== undefined ? { colour: options.colour } : {}),
    apply: APPLY,
  })
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

/**
 * The bytes a `create-catalog-info` would leave behind, in the SERVICE's own
 * repository.
 *
 * `planEdits` cannot do this and says so where it drops the operation: it
 * composes bytes for the declarations repository, and `repoPath` names a file
 * in a different one. What this does NOT do is compose them differently —
 * `materialise` is still the one translation from a proposal to an entity,
 * `serializeEntity` the one serialiser and `insertDocument` the one thing that
 * writes a document marker. This function supplies the repository those three
 * have no reader for, and nothing else.
 *
 * `files` are the catalog-info files the repository keeps, whole: the
 * `before` of every edit is read from them, so they must never be a capped
 * snapshot's.
 */
export function catalogInfoEdits(
  plan: Plan,
  snapshot: { readonly files: readonly { readonly path: string; readonly text: string }[] },
): FileEdit[] {
  /**
   * Keyed by PATH, never by operation — the same rule `planEdits` states and
   * for the same reason, which is why it is repeated here rather than assumed:
   * every `create-catalog-info` in a plan points at the SAME
   * `catalog-info.yaml`, so one edit per operation printed two "create this
   * file from /dev/null" hunks for one path, each computed against the
   * untouched original, and called it two files. A diff is a statement about a
   * file, not about the work that produced it.
   */
  const buffered = new Map<string, string>()
  const order: string[] = []
  const original = new Map<string, string | undefined>()

  for (const operation of plan.operations) {
    if (operation.op !== 'create-catalog-info') continue
    const entity = materialise(operation.entity)
    if (entity === undefined) continue

    const path = operation.repoPath
    if (!order.includes(path)) {
      order.push(path)
      original.set(path, snapshot.files.find((file) => file.path === path)?.text)
    }
    // Through the buffer, so a second component composes onto the first rather
    // than replacing it.
    const existing = buffered.get(path) ?? original.get(path)
    // Decided by kind, namespace and name as the documents state them —
    // never by a scan for `name:` lines, which needed a `---` and took an API
    // of the same name for this Component (review, core-yaml-4).
    const declared = existing !== undefined && declaresComponent(existing, entity.metadata.name)
    // Already declared there: an edit whose two sides are equal, so the diff
    // comes out empty rather than absent. Absent means already done (§4.3),
    // but only if it is visible — and a repository re-inits after a merge.
    buffered.set(
      path,
      declared ? existing : insertDocument(existing ?? '', serializeEntity(entity)),
    )
  }

  return order.map((path) => ({
    path,
    before: original.get(path),
    after: buffered.get(path) ?? '',
  }))
}
