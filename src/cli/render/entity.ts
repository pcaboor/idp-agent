import type { Entity } from '../../core/schemas/entity.js'
import { natureOf } from '../../core/schemas/resource-types.js'
import { ENV_ANNOTATION, refOf, type EntityGraph } from '../../context/graph/entity-graph.js'

/** Declare, never infer: an absent environment is stated as absent (design 4.1). */
const UNDECLARED = '(undeclared)'

export function renderEntityDetail(graph: EntityGraph, entity: Entity): string {
  const lines: string[] = [
    refOf(entity),
    '',
    `  kind         ${entity.kind}`,
    `  type         ${entity.spec.type}`,
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
    `  owner        ${entity.spec.owner}`,
    `  environment  ${entity.metadata.annotations[ENV_ANNOTATION] ?? UNDECLARED}`,
  ]

  // A service lists rights from several environments at once, and being
  // authorised in dev grants nothing in prod (design 4.1). Reading that off the
  // name would be reading a convention; the annotation is the declaration.
  const section = (title: string, entities: Entity[]): void => {
    lines.push('', title)
    if (entities.length === 0) {
      lines.push('  none')
      return
    }
    const width = Math.max(...entities.map((found) => refOf(found).length))
    for (const found of entities) {
      const env =
        found.kind === 'Resource'
          ? (found.metadata.annotations[ENV_ANNOTATION] ?? UNDECLARED)
          : ''
      lines.push(`  ${refOf(found).padEnd(width)}  ${env}`.trimEnd())
    }
  }

  section('depends on', graph.dependenciesOf(refOf(entity)))
  section('used by', graph.dependantsOf(refOf(entity)))

  const consumers = graph.consumersOf(refOf(entity))
  if (consumers.length > 0) section('reached by services', consumers)

  return lines.join('\n')
}
