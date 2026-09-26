import type { CatalogueEntity } from '../../core/schemas/entity.js'
import { natureOf } from '../../core/schemas/resource-types.js'
import {
  ENV_ANNOTATION,
  refOf,
  type EntityGraph,
  type Unresolved,
} from '../../context/graph/entity-graph.js'
import { oneLine } from './plain.js'

/** Declare, never infer: an absent environment is stated as absent (design 4.1). */
const UNDECLARED = '(undeclared)'

/**
 * How much of what an entity says about itself the card prints. A description
 * is one line, cut at `text` and ended with `…` when it is; a tag is cut at
 * Backstage's own 63 (`TAG_LENGTH`); the tags and the links are cut at a
 * count, and the remainder is counted — a list that stops without saying so is
 * read as complete. A URL is never cut: one longer than `url` is not printed,
 * and the card says so.
 */
export const ENTITY_LIMITS = { text: 160, tags: 10, links: 5, url: 2048 } as const

/**
 * The widest reference to an entity in the default namespace: the longest
 * kind, and a name of Backstage's 63 characters. A bound on alignment, never
 * a check.
 */
const REF_WIDTH = 'component:default/'.length + 63

/** Backstage's limit on a tag, used here as a bound and never as a check. */
export const TAG_LENGTH = 63

/**
 * Every string on the card came from a repository file — a Component's type
 * is free text, and so are a description, a tag and a link — and a terminal
 * obeys what is in them. So each goes through `oneLine`, the names and
 * references the schema already constrains included: one rule for the whole
 * card is one nobody has to re-check when a field is added.
 */
const shown = (text: string, max: number = ENTITY_LIMITS.text): string => oneLine(text, max)

/** `head, head, head, +N more`: the first few, then how many were cut. */
function counted(values: readonly string[], limit: number): string {
  const head = values.slice(0, limit)
  const hidden = values.length - head.length
  return hidden > 0 ? [...head, `+${String(hidden)} more`].join(', ') : head.join(', ')
}

/**
 * A link's address, whole or not at all: a URL cut short is another URL, and
 * a terminal that turns it into a link follows that one.
 */
function address(url: string): string {
  const whole = oneLine(url, Number.POSITIVE_INFINITY)
  const length = [...whole].length
  return length > ENTITY_LIMITS.url
    ? `(a URL of ${String(length)} characters, too long to print)`
    : whole
}

/**
 * What a reference naming nothing is said to be, beside it: declared nowhere,
 * and the entities that share its name when there are any. Beside, never in
 * place of: which of them the file meant, if any, is the reader's to decide.
 */
function nowhere(unresolved: Unresolved): string {
  const names = unresolved.sameName.map((ref) => shown(ref))
  if (names.length === 0) return 'declared nowhere'
  const listed =
    names.length === 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
  return `declared nowhere; ${listed} ${names.length === 1 ? 'has' : 'have'} this name`
}

export function renderEntityDetail(graph: EntityGraph, entity: CatalogueEntity): string {
  const { description, tags = [], links = [] } = entity.metadata
  // Each judged empty once cleaned, not before: a tag that is only a
  // clear-screen is no tag, and would print as a bare separator.
  const described = description === undefined ? '' : shown(description)
  const system = entity.spec.system === undefined ? '' : shown(entity.spec.system)
  const tagged = tags.map((tag) => shown(tag, TAG_LENGTH)).filter((tag) => tag !== '')
  const linked = links.flatMap(({ url, title }) =>
    oneLine(url) === ''
      ? []
      : [{ url: address(url), title: title === undefined ? '' : shown(title) }],
  )
  const lines: string[] = [
    shown(refOf(entity)),
    '',
    `  kind         ${entity.kind}`,
    `  type         ${shown(entity.spec.type)}`,
    // An API's contract, after its type for the reason a right's level is: "a
    // grpc API, experimental, its definition declared" is one statement. The
    // definition itself is never printed — the reader keeps only that there
    // is one (`apiSchema`) — and a Component's lifecycle is left off, as it
    // always was, so no card but an API's moves.
    ...(entity.kind === 'API'
      ? [
          `  lifecycle    ${shown(entity.spec.lifecycle)}`,
          `  definition   ${entity.spec.definition}`,
        ]
      : []),
    // Only for a right, and only there: an object grants nothing, so a line
    // saying its access is undeclared would invent a question about it. On a
    // right the line is always printed — a grant whose level nobody can read
    // is a grant nobody can review, and an omitted line reads as "no level was
    // asked for", which is a different fact (design 4.1).
    //
    // What this does NOT distinguish is a level left out from a level there is
    // none of: a `network-access` is not read or write, and it still reads as
    // undeclared here. Telling the two apart needs a registry of which rights
    // are levelled, which is the type split §4.1 rejects — and of the two
    // errors, a database-access showing no level at all is the worse one.
    ...(entity.kind === 'Resource' && natureOf(entity.spec.type) === 'right'
      ? [`  access       ${entity.spec.access ?? UNDECLARED}`]
      : []),
    `  owner        ${shown(entity.spec.owner)}`,
    `  environment  ${shown(entity.metadata.annotations[ENV_ANNOTATION] ?? UNDECLARED)}`,
    // What the entity says it is, in its file's own words. Each line only when
    // there is something on it: unlike an environment, a missing description
    // or system is not a gap in a declaration this tool reviews.
    ...(described === '' ? [] : [`  description  ${described}`]),
    ...(system === '' ? [] : [`  system       ${system}`]),
    ...(tagged.length === 0 ? [] : [`  tags         ${counted(tagged, ENTITY_LIMITS.tags)}`]),
  ]

  if (linked.length > 0) {
    lines.push('', 'links')
    for (const { url, title } of linked.slice(0, ENTITY_LIMITS.links)) {
      lines.push(`  ${title === '' ? '' : `${title} — `}${url}`)
    }
    const hidden = linked.length - ENTITY_LIMITS.links
    if (hidden > 0) lines.push(`  +${String(hidden)} more`)
  }

  // A service lists rights from several environments at once, and being
  // authorised in dev grants nothing in prod (design 4.1). Reading that off the
  // name would be reading a convention; the annotation is the declaration.
  //
  // What the entity declares of the relation and nothing answers to comes
  // after what resolves, one per line, marked where an environment would be
  // (`nowhere`). A section with none of it prints as it always did.
  const section = (
    title: string,
    entities: CatalogueEntity[],
    unresolved: readonly Unresolved[] = [],
  ): void => {
    lines.push('', title)
    if (entities.length === 0 && unresolved.length === 0) {
      lines.push('  none')
      return
    }
    const resolved = entities.map((found): [string, string] => [
      shown(refOf(found)),
      found.kind === 'Resource'
        ? shown(found.metadata.annotations[ENV_ANNOTATION] ?? UNDECLARED)
        : '',
    ])
    const missing = unresolved.map((ref): [string, string] => [shown(ref.to), nowhere(ref)])
    // A reference nothing answers to is as long as its file made it — a
    // `providesApis` the grammar could not split is kept as written — so it
    // sets the column only while it is as short as an entity's can be. A
    // longer one is printed with its marker after it, and pads nothing else.
    const width = Math.max(
      0,
      ...resolved.map(([ref]) => ref.length),
      ...missing.map(([ref]) => ref.length).filter((length) => length <= REF_WIDTH),
    )
    for (const [ref, after] of [...resolved, ...missing]) {
      lines.push(`  ${ref.padEnd(width)}  ${after}`.trimEnd())
    }
  }

  // Who provides an API is always said of one, "none" included: an API no
  // service provides is a fact about it. Of another kind only when a
  // `providesApis` names it — Backstage keeps an explicit kind as written — so
  // the relation reads at both ends. What a component provides is said only
  // when it provides something, so a card without APIs reads as before.
  const ref = refOf(entity)
  const providers = graph.providersOf(ref)
  if (entity.kind === 'API' || providers.length > 0) section('provided by', providers)
  const provides = graph.providedApisOf(ref)
  const unprovided = graph.unresolvedOf(ref, 'providesApis')
  if (provides.length > 0 || unprovided.length > 0) section('provides', provides, unprovided)

  section('depends on', graph.dependenciesOf(ref), graph.unresolvedOf(ref, 'dependsOn'))
  section('used by', graph.dependantsOf(ref), graph.unresolvedOf(ref, 'dependencyOf'))

  // One line per reference: two rights naming the same missing service are
  // one service the walk cannot reach, as `consumersOf` lists one per service.
  const consumers = graph.consumersOf(ref)
  const unreached = graph
    .unresolvedConsumersOf(ref)
    .filter((missing, at, all) => all.findIndex(({ to }) => to === missing.to) === at)
  if (consumers.length > 0 || unreached.length > 0) {
    section('reached by services', consumers, unreached)
  }

  return lines.join('\n')
}
