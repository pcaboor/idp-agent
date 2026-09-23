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
import { questionsOf } from '../../core/plan/clarify.js'
import { materialise } from '../../core/plan/materialise.js'
import { signPlan } from '../../core/plan/sign.js'
import { planSchema, type Operation, type Plan } from '../../core/schemas/plan.js'
import { reasonOf } from '../../core/schemas/reject.js'
import { serializeEntity } from '../../core/yaml/serialize.js'
import { insertDocument, listDocumentNames } from '../../core/yaml/surgery.js'
import type { LlmClient } from '../../llm/client.js'
import { readConfig, seededVocabulary } from '../config.js'
import { loadTemplates } from '../../scaffold/templates.js'
import { scaffoldLayout } from '../../scaffold/layout.js'
import { writeScaffold, type FileIO } from '../../scaffold/write.js'
import { renderPreview, renderQuestions } from './plan.js'
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

export async function runInitPlatform(
  options: InitPlatformOptions,
  io?: FileIO,
): Promise<CommandResult> {
  const files = scaffoldLayout(
    { owner: options.owner, version: options.version },
    await loadTemplates(),
  )
  const report = await writeScaffold(options.root, files, io)

  const listed = [...report.written, ...report.kept].sort()
  return {
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
 * Inspector → Architect → the catalog-info.yml it would write. It stops one
 * step short of §7.3's last two clauses on purpose: writing the file and
 * writing `.idp-agent.yml` are writes, and writing arrives at stage 5. What
 * lands here is the preview and the questions, rendered by `plan.ts` — the same
 * renderer `plan --from` ends on, because a second one would be a second answer
 * to "what would this do?".
 */

/**
 * Where a service declares itself. Backstage's own convention, at the root of
 * the repository the CLI was pointed at.
 *
 * A constant and not a computation, and certainly not a field: §5.2 says the
 * engine chooses where a declaration is filed, and this is that choice for the
 * one operation whose file lives outside the declarations repository.
 */
export const CATALOG_INFO = 'catalog-info.yaml'

/**
 * The request, composed by the ENGINE out of what the inspection established.
 *
 * `init` has no sentence a user typed — the gesture is "declare this
 * repository" and the answer is in its own files — but `signPlan` measures
 * every proposed value against `plan.intent`, so something has to be there, and
 * what is there decides what the gate can vouch for.
 *
 * It names **exactly the four values `proposedComponentSchema` lets a model
 * write**, and only where the inspection actually established them. That is the
 * guarantee this buys: a name, a type, a lifecycle or an owner the Architect
 * invents is echoed by nothing, enumerated by nothing, and becomes a question
 * the CLI puts to the user (design §4.1). The Architect cannot introduce a fact
 * the repository does not state.
 *
 * The type was the one of the four that did not hold, and the sentence above is
 * only true because `sign.ts` stopped classifying a Component's `spec.type`
 * structurally. It is `z.string().min(1).max(63)`, not the closed union a
 * Resource's is, so an invented one signed `derived` and reached the
 * `catalog-info.yaml` below without anyone being asked. On this road the
 * vocabulary is empty — the graph is `EntityGraph.from([])`, see `runInitRepo`
 * — so a Component type is echoed by this request or it is a question, and
 * there is no third answer.
 *
 * `forgeHandle` is deliberately absent, and its absence is the point of the
 * field: `@acme/platform` is a forge handle and `group:default/platform` is an
 * entity reference, two namespaces that do not survive translation. It is
 * stated to the model as a handle — `formatFacts` prints it — and kept out of
 * the one string that could make it vouch for itself as an owner.
 * `runtime` is absent too: it is evidence for `spec.type`, not a value any
 * proposal field carries, and a value in the request is a value that signs.
 *
 * What this does NOT cover, and it is the reason nothing here writes: the
 * Inspector is a model reading files, so this request is not a human's words.
 * The signature says a value matches what the inspection established. It says
 * nothing about whether the inspection was right — §7.3's "confirms the owner
 * it inferred rather than assuming it" is a human reading the diff below.
 */
const stated = (value: ProjectFacts[keyof ProjectFacts]): string | undefined =>
  typeof value === 'string' ? value : undefined

export function requestOf(facts: ProjectFacts): string {
  const values = [facts.name, facts.type, facts.lifecycle, facts.owner]
    .map(stated)
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
 * The operation §7.3 names, minted by the engine out of a proposal the
 * signature has already vouched for.
 *
 * The order is the whole of it. Minting first put `repoPath` in front of
 * `signPlan`, which classifies a leaf by where it came from and has no class
 * for "the engine wrote this" — so `catalog-info.yaml` came out `novel` and the
 * CLI asked the user which path it should be, about a path chosen by the code
 * putting the question. Provenance is a question about what a MODEL wrote, and
 * this field was never the model's to write.
 */
const asCatalogInfo = (operation: Operation): Operation =>
  operation.op === 'create-entity' && operation.entity.kind === 'Component'
    ? { op: 'create-catalog-info', repoPath: CATALOG_INFO, entity: operation.entity }
    : operation

export interface InitOptions {
  /** The application repository: read, inspected, and never written. */
  readonly project: string
  readonly client: LlmClient
  readonly emit: EventSink
  /** Only a caller that knows it holds a terminal asks for colour. */
  readonly colour?: boolean
}

export async function runInitRepo(options: InitOptions): Promise<CommandResult> {
  // Read before a single agent runs. A committed file that does not parse is
  // not a repository that declared nothing, and this one is about to be
  // rewritten by §7.3 — answering a typo by ignoring it is the worst of both.
  const config = await readConfig(options.project)
  // Taken on this side of the line, with every exclusion and cap applied:
  // `agents/` reaches no disk, so the bytes are read here and handed over.
  const snapshot = await readProject(options.project)

  const facts = await inspect(options.client, snapshot, options.emit)
  const request = requestOf(facts)

  // An empty catalogue, stated as such. This build has no local declarations
  // repository at init time — §7.0's `iacRepo` is a URL and nothing here clones
  // one — so the Architect reads nothing and witnesses nothing. What that does
  // NOT cover: it cannot tell whether this component is already declared
  // somewhere, and a duplicate is caught by the merge request rather than here.
  const graph = EntityGraph.from([])
  const tools = buildTools(graph)
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
        ...narrowed.refusals.map((refusal) => `  ${refusal}`),
      ].join('\n'),
      found: false,
    }
  }

  const signed = signPlan({ intent: request, operations: narrowed.proposals }, {
    // Nothing the engine returned, because nothing was read: see the graph
    // above. Every value is vouched for by the request or by nothing.
    witnessed: tools.witnessed,
    vocabulary: seeded,
    repoRoot: options.project,
    declared: new Map(), answered: new Set<string>(),
  })
  if ('outcome' in signed) {
    return {
      text: [
        'refused at the signature — the engine signs what it can vouch for:',
        ...signed.refusals.map((refusal) => `  ${refusal.path}: ${refusal.reason}`),
      ].join('\n'),
      found: false,
    }
  }

  const questions = questionsOf(signed.plan)
  if (questions.length > 0) return renderQuestions(questions)

  // Only now. The plan boundary is re-crossed because this is a different
  // object from the one `draftPlan` parsed — the same reason `repair` runs gate
  // [1] over a callback's output rather than trusting the callback.
  const minted = planSchema.safeParse({
    intent: request,
    operations: signed.plan.operations.map(asCatalogInfo),
  })
  if (!minted.success) {
    return { text: `the composed plan is not a plan — ${reasonOf(minted.error)}`, found: false }
  }

  return renderPreview({
    signed,
    edits: catalogInfoEdits(minted.data, snapshot),
    // Every operation produced bytes; `planEdits` is what drops a
    // create-catalog-info, and it drops it because it describes the OTHER
    // repository — the one this function is standing in.
    dropped: [],
    ...(options.colour !== undefined ? { colour: options.colour } : {}),
  })
}

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
    const declared =
      existing !== undefined && listDocumentNames(existing).includes(entity.metadata.name)
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
