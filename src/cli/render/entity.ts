import type { Entity } from '../../core/schemas/entity.js'
import { ENV_ANNOTATION, refOf, type EntityGraph } from '../../context/graph/entity-graph.js'

/** Declare, never infer: an absent environment is stated as absent (design 4.1). */
const UNDECLARED = '(undeclared)'

export function renderEntityDetail(graph: EntityGraph, entity: Entity): string {
  const lines: string[] = [
    refOf(entity),
    '',
    `  kind         ${entity.kind}`,
    `  type         ${entity.spec.type}`,
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
