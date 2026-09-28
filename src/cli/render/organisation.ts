import type { GraphNode, OrganisationEntity } from '../../core/schemas/entity.js'
import {
  refOf,
  type EntityGraph,
  type OrganisationField,
} from '../../context/graph/entity-graph.js'
import { NOWHERE, referenceLine, sectionLines, shown } from './entity.js'

/**
 * How many rows each list of an organisation card prints before it counts the
 * rest: an all-staff Group has thousands of members, and a person can be in
 * hundreds of groups. The relation (`idpa relations`) lists them all.
 */
export const ORGANISATION_LIMITS = { rows: 25 } as const

/**
 * The card of a Group, a User, a System or a Domain, laid out as an entity's
 * is (`renderEntityDetail`): header lines, then sections, each "none" when
 * empty. Every relation is read from both ends — a parent named by the child
 * or by the parent's `children`, a member by the Group's `members` or the
 * User's `memberOf` — so the card says what either file declares.
 *
 * A reference naming nothing is marked where a catalogue read its kind whole
 * (`unresolvedOrganisationOf`), and listed unmarked everywhere else: a
 * declarations repository's Group files are not the organisation, so a name
 * none of them carries is a name, never "declared nowhere". Nothing of a
 * User's profile is on it: the reader keeps none.
 */
export function renderOrganisationDetail(
  graph: EntityGraph,
  node: OrganisationEntity,
  said: string = NOWHERE,
): string {
  const ref = refOf(node)
  const lines: string[] = [shown(ref), '', `  kind         ${node.kind}`]

  /** A section of this card, bounded, with what its subject declares and nothing answers to. */
  const section = (
    title: string,
    nodes: readonly GraphNode[],
    field?: OrganisationField,
    declared: readonly string[] = [],
  ): void => {
    const unresolved = field === undefined ? [] : graph.unresolvedOrganisationOf(ref, field)
    const judged = new Set(unresolved.map(({ to }) => to))
    const named = declared.filter(
      (target, at) =>
        graph.node(target) === undefined && !judged.has(target) && declared.indexOf(target) === at,
    )
    lines.push(
      ...sectionLines(title, nodes, { unresolved, named, said, limit: ORGANISATION_LIMITS.rows }),
    )
  }

  switch (node.kind) {
    case 'Group':
      lines.push(`  type         ${shown(node.spec.type)}`)
      section('parent', graph.parentsOf(ref), 'parent', node.spec.parent === undefined ? [] : [node.spec.parent])
      section('children', graph.childrenOf(ref), 'children', node.spec.children)
      section('members', graph.membersOf(ref), 'members', node.spec.members ?? [])
      section('owns', graph.ownedBy(ref))
      break
    case 'User':
      section('member of', graph.groupsOf(ref), 'memberOf', node.spec.memberOf)
      section('owns', graph.ownedBy(ref))
      break
    case 'System':
      if (node.spec.type !== undefined) lines.push(`  type         ${shown(node.spec.type)}`)
      lines.push(referenceLine(graph, 'owner', node.spec.owner, ref, 'owner', said))
      if (node.spec.domain !== undefined) {
        lines.push(referenceLine(graph, 'domain', node.spec.domain, ref, 'domain', said))
      }
      section('contains', graph.partsOf(ref))
      break
    case 'Domain': {
      if (node.spec.type !== undefined) lines.push(`  type         ${shown(node.spec.type)}`)
      lines.push(referenceLine(graph, 'owner', node.spec.owner, ref, 'owner', said))
      if (node.spec.subdomainOf !== undefined) {
        lines.push(referenceLine(graph, 'part of', node.spec.subdomainOf, ref, 'subdomainOf', said))
      }
      const parts = graph.partsOf(ref)
      section('systems', parts.filter(({ kind }) => kind === 'System'))
      // A domain's subdomains, only when it has some: a card without them
      // reads as a System's does.
      const subdomains = parts.filter(({ kind }) => kind === 'Domain')
      if (subdomains.length > 0) section('subdomains', subdomains)
      break
    }
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }

  return lines.join('\n')
}
