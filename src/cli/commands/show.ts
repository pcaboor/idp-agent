import { refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import {
  ORGANISATION_KINDS,
  type CatalogueEntity,
  type GraphNode,
  type OrganisationEntity,
} from '../../core/schemas/entity.js'
import { missIn, partialClosing } from '../render/catalogue-read.js'
import { NOWHERE, renderEntityDetail } from '../render/entity.js'
import { ORGANISATION_LIMITS, renderOrganisationDetail } from '../render/organisation.js'
import type { CommandResult } from './result.js'

/**
 * A bare name resolves to a reference; an ambiguous one lists the candidates
 * instead of picking the first. Declare, never infer (design 4.1). `said` is
 * what a reference naming nothing is called, which `main` chooses by the
 * source (`NOWHERE`).
 */
export function runShow(graph: EntityGraph, query: string, said: string = NOWHERE): CommandResult {
  const found = resolveNode(graph, query)
  if ('text' in found) return found
  // A card's sections are what was read: on a partial graph they cannot count
  // a dependant past the bound, and stdout says so under them.
  const closing = partialClosing(graph.partial, 'these sections')
  const card = cardOf(graph, found.node, said)
  return { text: closing === undefined ? card : `${card}\n\n${closing}`, found: true }
}

/** A node's card: an entity's, or a Group's, a User's, a System's or a Domain's. */
function cardOf(graph: EntityGraph, node: GraphNode, said: string): string {
  switch (node.kind) {
    case 'Component':
    case 'Resource':
    case 'API':
      return renderEntityDetail(graph, node, said)
    case 'Group':
    case 'User':
    case 'System':
    case 'Domain':
      return renderOrganisationDetail(graph, node, said)
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

const byRef = (left: GraphNode, right: GraphNode): number => refOf(left).localeCompare(refOf(right), 'en')

const ORGANISATION: ReadonlySet<string> = new Set(ORGANISATION_KINDS)
const isOrganisation = (node: GraphNode): node is OrganisationEntity => ORGANISATION.has(node.kind)

/**
 * What `show` resolves a name or a reference to: a node, entity or
 * organisation, or the negative answer to print instead. An entity first, so
 * that nothing the organisation holds turns a `show` that found an entity into
 * an ambiguity — a System named after its service, a Group after its team, or
 * a User a catalogue named like a Component, which would otherwise shadow it:
 * a reference to an entity, then a reference to an organisation node, then
 * the entities of exactly that name as `resolveEntity` reads them, and only
 * when no entity carries the name, the organisation nodes of that name; then
 * the entities whose name holds it, and when none does, the organisation's,
 * that list cut at `ORGANISATION_LIMITS.rows` and the rest counted.
 */
export function resolveNode(
  graph: EntityGraph,
  query: string,
): { node: GraphNode } | CommandResult {
  const entity = graph.get(query)
  if (entity !== undefined) return { node: entity }
  const node = graph.node(query)
  if (node !== undefined) return { node }

  const organisation = graph.nodes().filter(isOrganisation)
  const entityNamed = graph.all().some((found) => found.metadata.name === query)
  if (!entityNamed) {
    const named = organisation.filter((found) => found.metadata.name === query)
    if (named.length === 1) return { node: named[0] as GraphNode }
    if (named.length > 1) return ambiguous(query, [...named].sort(byRef))
  }

  const found = resolveEntity(graph, query)
  if ('entity' in found) return { node: found.entity }
  // Decided on the graph, not on the words `resolveEntity` printed: an entity
  // of that name, or one whose name holds it, is its answer to give.
  if (entityNamed || graph.search({ nameContains: query }).length > 0) return found
  const candidates = organisation.filter((each) => each.metadata.name.includes(query))
  return candidates.length === 0 ? found : ambiguous(query, candidates)
}

/**
 * Every organisation candidate for a name, cut at the organisation card's
 * bound: exit 1, never a pick. They are nodes, not entities — the read model's
 * word for what a plan can touch — so the heading says so.
 */
function ambiguous(query: string, candidates: readonly OrganisationEntity[]): CommandResult {
  const shown = candidates.slice(0, ORGANISATION_LIMITS.rows).map((node) => `  ${refOf(node)}`)
  const hidden = candidates.length - shown.length
  return {
    text: [
      `"${query}" matches ${candidates.length} nodes:`,
      ...shown,
      ...(hidden > 0 ? [`  +${String(hidden)} more`] : []),
    ].join('\n'),
    found: false,
  }
}

/**
 * What a name or a reference typed on the command line names: an entity, or
 * the negative answer to print instead — no entity by that name, or every
 * entity whose name holds it. `show` and `relations` resolve through this one
 * function, so a name means the same entity to both, and an ambiguous one is
 * refused by both in the same words.
 */
export function resolveEntity(
  graph: EntityGraph,
  query: string,
): { entity: CatalogueEntity } | CommandResult {
  const byRef = graph.get(query)
  if (byRef !== undefined) return { entity: byRef }

  // A name two entities carry — a component and the Resource of its API, say
  // — names neither: which one the reader meant is theirs to say, with the
  // reference. Only the entities of exactly that name are listed then.
  const named = graph.all().filter((entity) => entity.metadata.name === query)
  if (named.length === 1) return { entity: named[0] as CatalogueEntity }

  const candidates =
    named.length > 1
      ? [...named].sort((left, right) => refOf(left).localeCompare(refOf(right), 'en'))
      : graph.search({ nameContains: query })
  // On a partial graph, said with the part it looked in: a miss there is not
  // a fact about the catalogue.
  if (candidates.length === 0) return { text: missIn(graph.partial, `No entity named "${query}"`), found: false }

  // Ambiguous is not found: the query resolved no entity, and a caller that
  // treated this as success would be picking the first candidate by accident.
  const lines = candidates.map((entity) => `  ${refOf(entity)}`)
  return {
    text: [`"${query}" matches ${candidates.length} entities:`, ...lines].join('\n'),
    found: false,
  }
}
