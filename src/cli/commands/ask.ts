import { answerQuestion } from '../../agents/analyst.js'
import { classify } from '../../agents/supervisor.js'
import { formatSummary, shownVocabulary } from '../../agents/summary.js'
import { buildTools } from '../../agents/tools/graph-tools.js'
import { summariseGraph } from '../../context/graph/summary.js'
import {
  ENV_ANNOTATION,
  refOf,
  type EntityGraph,
  type OrganisationField,
} from '../../context/graph/entity-graph.js'
import { overviewOf, type Unread } from '../../context/graph/overview.js'
import {
  checkCommentary,
  type CheckedCommentary,
  type KnownEntity,
} from '../../core/answer/commentary.js'
import {
  ORGANISATION_KINDS,
  type CatalogueEntity,
  type GraphNode,
  type OrganisationEntity,
} from '../../core/schemas/entity.js'
import { QUERY_LIMITS, type Answer } from '../../core/schemas/query.js'
import type { EventSink } from '../../agents/events.js'
import type { LlmClient } from '../../llm/client.js'
import { NOWHERE, renderEntityDetail } from '../render/entity.js'
import { renderOrganisationDetail } from '../render/organisation.js'
import { renderOverview, type OverviewSource } from '../render/overview.js'
import { inertLine, oneLine } from '../render/plain.js'
import { renderTable } from '../render/table.js'
import { runRelations } from './relations.js'
import type { CommandResult } from './result.js'

/**
 * Where the graph was read from, and what the reader could not turn into it.
 * The overview prints these; `main` has them, so it hands them over rather
 * than this command reading anything a second time. `nowhere` is what the
 * answer's blocks call a reference naming nothing, chosen by the source
 * (`NOWHERE`); what the agents' tools say to a model does not change.
 */
export type AskSource = OverviewSource & Unread & { readonly nowhere?: string }

/** What `ask` and the one gesture, `idpa "<phrase>"`, both hand over. */
export interface AskOptions {
  readonly graph: EntityGraph
  readonly client: LlmClient
  /** The request, in the user's own words. */
  readonly intent: string
  readonly source: AskSource
  readonly emit: EventSink
  readonly err: (chunk: string) => void
  /**
   * Whether stdout is a terminal that wants colour (`colourOf` in `main`):
   * the model's lines are dimmed there. Absent is no colour.
   */
  readonly colour?: boolean
  /** `--quiet`: the verified block alone — no commentary, and no line about it. */
  readonly quiet?: boolean
}

/**
 * The model chooses which question to ask the graph; the engine answers it and
 * prints it. What the model wrote reaches stdout in one form only: the
 * commentary around the engine's block, each sentence checked against what the
 * tools returned, cleaned, bounded and marked `› ` as the model's (ADR-0008).
 * Its other words — an `unanswerable` reason, the Supervisor's refusal to
 * classify — go to stderr as one cleaned, bounded line each (design § 5.2,
 * ADR-0007).
 *
 * `ask` is the command that forces the read road, so a change request is
 * understood and declined here, pointing at the gesture that previews it.
 */
export async function runAsk(options: AskOptions): Promise<CommandResult> {
  return classified(options, async () => {
    // Understood, and declined: `ask` only reads. Not a failed query.
    options.err('that is a change request; run it as idpa "<phrase>" to preview the plan\n')
    return { text: '', found: false, unsupported: true }
  })
}

/**
 * The Supervisor's one decision, taken once: a question is answered here, and
 * a change is handed to `change` — `ask`'s refusal, or the entry's preview
 * (`entry.ts`). One function for both, so the question road of `idpa
 * "<phrase>"` is `ask`'s to the byte: the same summary, the same classifier
 * turn, the same Analyst, the same exit codes.
 */
export async function classified(
  options: AskOptions,
  change: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const { graph, client, intent, emit } = options
  // With the counts: each list capped at 30 (domain-backstage-8). The Supervisor
  // and the Analyst may be reading a whole company catalogue; the gates never
  // read this summary, and keep every value.
  const { summary, vocabulary, counts } = summariseGraph(graph)
  const summaryText = formatSummary(summary, vocabulary, counts)
  const shown = shownVocabulary(vocabulary, counts)

  // A Supervisor that gave no word twice throws `ClassificationError`, and it
  // is let through: exit 1, as a call that could not succeed is, and printed
  // where every failure is, after the run's usage line (`failed`,
  // gap-ask-grounding-7).
  const classification = await classify(client, { intent, summary: summaryText }, emit)

  switch (classification) {
    case 'MUTATION':
      return change()
    case 'QUESTION':
      return answered(options, summaryText, [
        ...shown.kinds.values,
        ...shown.types.values,
        ...shown.environments.values,
        ...shown.owners.values,
      ])
    default: {
      const exhaustive: never = classification
      return exhaustive
    }
  }
}

/**
 * The Analyst over the graph, shown the summary the Supervisor was shown, and
 * its answer printed: the engine's block, framed by the model's commentary
 * once the engine has checked it. `vocabulary` is every value that summary
 * printed, as it printed them.
 */
async function answered(
  options: AskOptions,
  summaryText: string,
  vocabulary: readonly string[],
): Promise<CommandResult> {
  const { graph, client, intent, emit } = options
  // The Analyst's registry: Backstage's APIs are found and read, and the
  // Architect's, which proposes neither, stays the one it was (`buildTools`).
  // The organisation is read only where the graph holds some: over a source
  // that holds none, what the Analyst is sent is what every tape recorded.
  const tools = buildTools(graph, { apis: true, organisation: graph.holdsOrganisation })
  const { answer, witnessed, truncated } = await answerQuestion(
    client,
    tools,
    { intent, summary: summaryText, vocabulary: '' },
    emit,
  )
  const result = block(options, answer, truncated)
  if (answer.outcome === 'unanswerable' || options.quiet === true) return result

  // Every node the graph holds, the organisation's included, on purpose: a
  // sentence naming a team, a person or a system no tool returned is dropped
  // as one naming an unread entity is (ADR-0008) — and so is one using such a
  // name as a word ("the platform"), which fails closed. Over a source that
  // holds no organisation, `nodes()` is `all()`.
  const commentary = checkCommentary(answer, {
    entities: graph.nodes().map((node) => known(graph, node, tools.declaredNowhere)),
    witnessed,
    // As the opening message listed them: a value a line break was flattened
    // out of was read in its one-line spelling, and a value past a list's 30
    // was never read at all (`shownVocabulary`).
    vocabulary,
    question: intent,
    clean: (text) => inertLine(text, Number.POSITIVE_INFINITY),
  })
  const left = leftOut(commentary)
  if (left !== undefined) options.err(`${left}\n`)
  return { ...result, text: framed(result.text, commentary, options.colour === true) }
}

/** The engine's block for an answer: what `ask` printed before there was commentary. */
function block(options: AskOptions, answer: Answer, truncated: number): CommandResult {
  const { graph, source, err } = options
  switch (answer.outcome) {
    case 'unanswerable':
      // The model's own prose (review finding security-4): cleaned, and kept
      // to the one line a reason is, so it cannot draw anything under it. The
      // bound is the schema's, so an honest reason is never cut here.
      err(`cannot answer: ${oneLine(answer.reason, QUERY_LIMITS.maxReason)}\n`)
      return { text: '', found: false, unsupported: true }
    case 'nothing':
      return { text: 'No entity matches that question.', found: false }
    case 'overview':
      // Chosen by the model, written by the engine: every figure comes from
      // the graph and the reader, and nothing from the conversation. Whatever
      // the search cut on the way is not part of it, so no truncation line.
      return { text: renderOverview(overviewOf(graph, source), source), found: true }
    case 'entities':
      return renderEntities(graph, answer.refs, truncated, source.nowhere ?? NOWHERE)
    case 'relation':
      // Chosen by the model, computed and written by the engine: the entity
      // and the relation are references a tool returned (the Analyst's
      // witness check), every row and path comes from the declarations, and
      // the block is the one `idpa relations` prints, byte for byte — save
      // that a bound names the whole command where the command names a flag,
      // `--depth` being no option of a question. What the search cut on the
      // way is not part of it; the block states its own bounds.
      return runRelations(graph, {
        query: answer.ref,
        ...(answer.relation === 'between'
          ? { to: answer.to ?? answer.ref }
          : { relation: answer.relation }),
        asked: true,
        ...(source.nowhere === undefined ? {} : { nowhere: source.nowhere }),
      })
    default: {
      const exhaustive: never = answer
      return exhaustive
    }
  }
}

function renderEntities(
  graph: EntityGraph,
  refs: readonly string[],
  truncated: number,
  said: string,
): CommandResult {
  // Re-read from the graph and sorted: the model's ordering is not one anybody
  // verified, and the entity it named is not the entity we print unless the
  // graph still holds it. A Group, a User, a System or a Domain is read as
  // `show` reads one: its card alone, a row among several.
  const found = [...refs]
    .sort()
    .map((ref) => graph.node(ref))
    .filter((node): node is GraphNode => node !== undefined)

  if (found.length === 0) return { text: 'No entity matches that question.', found: false }
  if (found.length === 1) {
    const [only] = found as [GraphNode]
    const card = isOrganisation(only)
      ? renderOrganisationDetail(graph, only, said)
      : renderEntityDetail(graph, only, said)
    return { text: withTruncation(card, truncated), found: true }
  }

  // What a node of the organisation does not state is `-`, as an absent
  // environment is: a Group has no environment, a User no type or owner.
  const rows = found.map((node) =>
    isOrganisation(node)
      ? [node.metadata.name, node.kind, organisationType(node) ?? '-', '-', organisationOwner(node) ?? '-']
      : [
          node.metadata.name,
          node.kind,
          node.spec.type,
          node.metadata.annotations[ENV_ANNOTATION] ?? '-',
          node.spec.owner,
        ],
  )
  return {
    text: withTruncation(renderTable(['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER'], rows), truncated),
    found: true,
  }
}

const ORGANISATION: ReadonlySet<string> = new Set(ORGANISATION_KINDS)
const isOrganisation = (node: GraphNode): node is OrganisationEntity => ORGANISATION.has(node.kind)

/** The type a node of the organisation states: a Group's, a System's or a Domain's when it does. */
function organisationType(node: OrganisationEntity): string | undefined {
  switch (node.kind) {
    case 'Group':
    case 'System':
    case 'Domain':
      return node.spec.type
    case 'User':
      return undefined
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

/** The owner a node of the organisation declares: a System's and a Domain's. */
function organisationOwner(node: OrganisationEntity): string | undefined {
  switch (node.kind) {
    case 'System':
    case 'Domain':
      return node.spec.owner
    case 'Group':
    case 'User':
      return undefined
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

/**
 * An entity as the commentary check needs it: every reference and name the
 * graph holds, and what each declares that a sentence about it may quote.
 *
 * A reference it declares and nothing answers to is one of those values once
 * a result showed it, marked `declared: false` (`shown`, the tools'
 * `declaredNowhere`), so "the right names component:default/payments-api,
 * which is declared nowhere" says what was read. Not before: an entity is
 * witnessed without its row being read — as an API's provider, or as what
 * declares another reference — and a value is quoted by its bare name too,
 * which is the name of the entity it is mistaken for; allowing it unread
 * would let a sentence name that entity with no tool having returned it. A
 * result that shows the reference returns those entities with it
 * (`sameName`). The references that DO resolve are not values at all: each
 * names an entity of the graph, and a sentence may name one only once a tool
 * returned it — which a row of the declaring entity does not do.
 */
function known(graph: EntityGraph, node: GraphNode, shown: ReadonlySet<string>): KnownEntity {
  return isOrganisation(node) ? knownOrganisation(graph, node, shown) : knownEntity(graph, node, shown)
}

/**
 * A node of the organisation as the check needs it: its reference and name,
 * and the values it declares — its type, its owner, its domain or parent
 * domain, and what it declares that is declared nowhere once a result showed
 * it. A membership is not a value: it names another node, which a sentence
 * may name only once a tool returned it.
 */
function knownOrganisation(
  graph: EntityGraph,
  node: OrganisationEntity,
  shown: ReadonlySet<string>,
): KnownEntity {
  const ref = refOf(node)
  const declared = (field: OrganisationField): string[] =>
    graph.unresolvedOrganisationOf(ref, field).flatMap(({ to }) => (shown.has(to) ? [to] : []))
  const values = ((): string[] => {
    switch (node.kind) {
      case 'Group':
        return [node.spec.type, ...declared('parent'), ...declared('children'), ...declared('members')]
      case 'User':
        return declared('memberOf')
      case 'System':
        return [
          ...(node.spec.type === undefined ? [] : [node.spec.type]),
          node.spec.owner,
          ...(node.spec.domain === undefined ? [] : [node.spec.domain]),
          ...declared('owner'),
          ...declared('domain'),
        ]
      case 'Domain':
        return [
          ...(node.spec.type === undefined ? [] : [node.spec.type]),
          node.spec.owner,
          ...(node.spec.subdomainOf === undefined ? [] : [node.spec.subdomainOf]),
          ...declared('owner'),
          ...declared('subdomainOf'),
        ]
      default: {
        const exhaustive: never = node
        return exhaustive
      }
    }
  })()
  return { ref, name: node.metadata.name, declares: values }
}

function knownEntity(
  graph: EntityGraph,
  entity: CatalogueEntity,
  shown: ReadonlySet<string>,
): KnownEntity {
  const env = entity.metadata.annotations[ENV_ANNOTATION]
  const access = entity.kind === 'Resource' ? entity.spec.access : undefined
  // A Component's and an API's lifecycle both; an API's definition is not a
  // value a sentence may quote — it is kept as `declared`, and never read.
  const lifecycle = entity.kind === 'Resource' ? undefined : entity.spec.lifecycle
  return {
    ref: refOf(entity),
    name: entity.metadata.name,
    declares: [
      entity.spec.owner,
      entity.spec.type,
      ...(entity.spec.system === undefined ? [] : [entity.spec.system]),
      ...(env === undefined ? [] : [env]),
      ...(lifecycle === undefined ? [] : [lifecycle]),
      ...(access === undefined ? [] : [access]),
      ...(entity.metadata.tags ?? []),
      ...graph
        .unresolvedOf(refOf(entity))
        .flatMap(({ to }) => (shown.has(to) ? [to] : [])),
    ],
  }
}

/**
 * What marks a line as the model's. The engine's blocks never start with it —
 * a table starts with its header, a card with a name, the overview with its
 * headline — so the mark survives a pipe with no colour, where the dimming
 * does not.
 */
const MODEL = '› '

/** SGR 2, faint, and 22, back to normal intensity: nothing else is touched. */
const dim = (line: string): string => `\u001B[2m${line}\u001B[22m`

/**
 * The block, with the introduction above it and the conclusion under it, a
 * blank line between each. The block's bytes are the ones printed without
 * commentary; one conclusion sentence per line, so every line carries the mark.
 */
function framed(text: string, commentary: CheckedCommentary, colour: boolean): string {
  const mark = (line: string): string => (colour ? dim(`${MODEL}${line}`) : `${MODEL}${line}`)
  return [
    ...(commentary.intro === undefined ? [] : [mark(commentary.intro)]),
    text,
    ...(commentary.conclusion.length === 0 ? [] : [commentary.conclusion.map(mark).join('\n')]),
  ].join('\n\n')
}

/** How many names the stderr line quotes before it counts the rest. */
const MAX_QUOTED = 5
/** A quoted name's bound: it is an identifier the model wrote, not a reference we print. */
const NAME_LIMIT = 60

/**
 * The one line that says the engine left sentences out, or `undefined` when it
 * left none out for what they named. A sentence cut for length is not said:
 * it named nothing unread, and the bound is the check's own, not a finding.
 */
function leftOut(commentary: CheckedCommentary): string | undefined {
  const unread = commentary.dropped.filter((drop) => drop.why === 'unread')
  if (unread.length === 0) return undefined
  const names = [...new Set(unread.flatMap((drop) => drop.names))].map((name) =>
    inertLine(name, NAME_LIMIT),
  )
  const quoted = names.slice(0, MAX_QUOTED)
  const rest = names.length - quoted.length
  const listed =
    rest > 0
      ? `${quoted.join(', ')} and ${String(rest)} more`
      : quoted.length === 1
        ? (quoted[0] ?? '')
        : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1) ?? ''}`
  const sentences =
    unread.length === 1
      ? 'that sentence was left out'
      : `those ${String(unread.length)} sentences were left out`
  return `! the model's commentary named ${listed}, which no tool returned; ${sentences}`
}

/**
 * A short list that does not say it is short is worse than an error: the
 * reader leaves with a wrong answer believing it complete. The tools tell the
 * model when they cut rows; this is where the reader is told too.
 */
function withTruncation(text: string, truncated: number): string {
  if (truncated === 0) return text
  return `${text}\n\n${truncated} further row(s) were not shown; narrow the question to see them.`
}
