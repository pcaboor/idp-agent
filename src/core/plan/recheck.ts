import type { Entity } from '../schemas/entity.js'
import { ENV_ANNOTATION } from '../schemas/vocabulary.js'
import type { RepositoryFile, RepositorySnapshot, Violation } from '../validate/rules.js'
import { checkRepository } from '../validate/rules.js'
import type { SignedPlan } from './sign.js'

/**
 * The sixth step of §7.4, which exists because the catalogue lags the
 * repository by about two minutes (§4.4). What was true when the plan was
 * drafted may not be true now — the entity may have appeared, or appeared
 * somewhere else — and the plan was signed against the older truth.
 *
 * The check is not a second set of rules. It applies the plan **virtually** —
 * builds the snapshot that would exist if the plan landed — and runs
 * `checkRepository` over the result: the same six rules CI runs, asked about a
 * repository that does not exist yet. That reuse is the whole reason stage 3
 * put those rules in `core/` with no `node:` import.
 */

export type RecheckOutcome =
  | 'fresh'
  /** The entity is already in the repository, at the path the plan computed. */
  | 'already-declared'
  /** Same name, different file. Writing would make a duplicate. */
  | 'moved'
  /** Still carries a question, so there is no path to check. */
  | 'unresolved'

export interface Recheck {
  readonly outcomes: ReadonlyMap<number, RecheckOutcome>
  /** What CI would say about the repository the plan would leave behind. */
  readonly violations: readonly Violation[]
}

const refOf = (entity: Entity): string =>
  `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`

/**
 * The entity a proposal would become. A proposal is not an Entity: it carries
 * `metadata.env` where an entity carries an annotation, and no `apiVersion` at
 * all — task 5 owns that translation for real. Here it only has to be faithful
 * enough for the six rules, which read kind, name, annotations and references.
 */
function materialise(entity: unknown): Entity | undefined {
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
    // The cast is the seam this module admits to: a proposal has been through
    // the strict schema, so its shape is known, but it is not an Entity until
    // task 5 writes one. Nothing here reads a field the schema did not check.
  } as unknown as Entity
}

export function recheckPlan(signed: SignedPlan, snapshot: RepositorySnapshot): Recheck {
  const outcomes = new Map<number, RecheckOutcome>()

  // Where the repository already declares each reference. Built once: a plan
  // with n operations over a repository with m files must not be n×m.
  const declaredAt = new Map<string, string>()
  for (const file of snapshot.files) {
    for (const entity of file.entities) declaredAt.set(refOf(entity), file.path)
  }

  const added: RepositoryFile[] = []

  for (const [opIndex] of signed.plan.operations.entries()) {
    const path = signed.paths.get(opIndex)
    const ref = signed.refs.get(opIndex)
    if (path === undefined || ref === undefined) {
      outcomes.set(opIndex, 'unresolved')
      continue
    }

    const existing = declaredAt.get(ref)
    outcomes.set(
      opIndex,
      existing === undefined ? 'fresh' : existing === path ? 'already-declared' : 'moved',
    )

    const operation = signed.plan.operations[opIndex]
    if (operation === undefined) continue
    if (operation.op !== 'create-entity' && operation.op !== 'create-catalog-info') continue

    const entity = materialise(operation.entity)
    if (entity === undefined) continue
    added.push({ path, entities: [entity], rejections: [], documents: 1 })
  }

  // Virtually means virtually: a new snapshot, never a mutation of the one we
  // were handed, or the second call would disagree with the first.
  const folder = (path: string): string => {
    const cut = path.lastIndexOf('/')
    return cut === -1 ? '' : path.slice(0, cut)
  }

  const would: RepositorySnapshot = {
    folders: [...new Set([...snapshot.folders, ...added.map((file) => folder(file.path))])],
    witnesses: snapshot.witnesses,
    files: [...snapshot.files, ...added],
  }

  return { outcomes, violations: checkRepository(would) }
}
