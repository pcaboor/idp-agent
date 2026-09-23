import type { Entity } from '../schemas/entity.js'
import { findUnknowns } from '../schemas/plan.js'
import { ENV_ANNOTATION } from '../schemas/vocabulary.js'

/**
 * The entity a proposal would become.
 *
 * A proposal is not an Entity, and the difference is deliberate. It carries
 * `metadata.env` where an entity carries the `company.fr/env` annotation, and
 * it carries no `apiVersion` at all — the proposal schema lists both absences
 * as guarantees, because an annotation map is also where a model would put
 * `idp-agent.dev/source-file` and aim at its own path (design 5.2).
 *
 * So the translation has to happen somewhere, and this is the somewhere: one
 * function, shared by the two callers that need it. `recheckPlan` uses it to
 * build the repository the plan WOULD leave behind, `planEdits` to produce the
 * bytes that would be in it — the same proposal turning into the same entity
 * twice would be two places for the annotation to drift.
 *
 * What this does NOT do is validate. The proposal has been through the strict
 * schema, so its shape is known, but a shape is not an entity: a right's
 * consumer list on an object passes the proposal schema and fails
 * `entitySchema`. Judging that belongs to the rules, which is exactly what
 * `checkRepository` is asked about the virtual snapshot. Here the cast is the
 * seam, admitted: nothing below reads a field the proposal schema did not check.
 *
 * THE ONE THING IT DOES REFUSE is a proposal still carrying `{unknown}`. That
 * is not validation creeping back in; it is the difference between a question
 * and a value, and this function's whole job is to produce something that gets
 * SERIALISED. Without the guard, `owner: {unknown: "which team?"}` becomes a
 * YAML mapping under `owner:` — a question written into a declaration as
 * though it were an answer.
 *
 * Both callers already check: `planEdits` drops an operation that carries one,
 * and `catalogInfoEdits` relies on ITS caller having checked. The audit's
 * point (F12) is that relying is not the same as being unable to, and the
 * cheap end of that is here, in the one function both of them go through.
 */
export function materialise(entity: unknown): Entity | undefined {
  if (typeof entity !== 'object' || entity === null) return undefined
  const { kind, metadata, spec } = entity as {
    kind?: unknown
    metadata?: unknown
    spec?: unknown
  }
  if (typeof metadata !== 'object' || metadata === null) return undefined
  if (typeof spec !== 'object' || spec === null) return undefined

  const { name, env, description } = metadata as {
    name?: unknown
    env?: unknown
    description?: unknown
  }
  if (typeof name !== 'string') return undefined
  // Structural, not defensive. See above: a question serialised as a value is
  // the shape this whole design exists to prevent, and no caller should have
  // to remember to check.
  if (findUnknowns(entity).length > 0) return undefined

  const annotations: Record<string, string> = {}
  if (typeof env === 'string') annotations[ENV_ANNOTATION] = env

  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind,
    metadata: {
      name,
      annotations,
      ...(typeof description === 'string' ? { description } : {}),
    },
    spec,
  } as unknown as Entity
}
