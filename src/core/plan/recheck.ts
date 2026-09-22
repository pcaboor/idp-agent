import type { FileEdit } from '../diff/unified.js'
import type { Entity } from '../schemas/entity.js'
import { parseDocuments } from '../yaml/serialize.js'
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

export function recheckPlan(
  signed: SignedPlan,
  snapshot: RepositorySnapshot,
  edits: readonly FileEdit[],
): Recheck {
  const outcomes = new Map<number, RecheckOutcome>()

  // Where the repository already declares each reference. Built once: a plan
  // with n operations over a repository with m files must not be n×m.
  const declaredAt = new Map<string, string>()
  for (const file of snapshot.files) {
    for (const entity of file.entities) declaredAt.set(refOf(entity), file.path)
  }

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
  }

  /**
   * The repository the plan would leave behind, read back from the very bytes
   * the reviewer is about to see.
   *
   * This used to re-model the plan a second time — materialise each proposal
   * and push a virtual file per create operation — and that second model
   * disagreed with the first in two ways. It pushed a file for an operation it
   * had just called `already-declared`, so the entity came out a duplicate of
   * itself and a partially applied plan was refused. And it modelled creations
   * only, so an update-entity was invisible: `plan` exited 0 on a diff these
   * same six rules reject once applied.
   *
   * Parsing the edits instead makes the check and the preview the same object.
   * It is the repository's own habit — write then read back — applied to a
   * write that has not happened.
   */
  const edited = new Map<string, RepositoryFile>()
  for (const edit of edits) {
    const { entities, rejections } = parseDocuments(edit.after)
    edited.set(edit.path, {
      path: edit.path,
      entities,
      rejections,
      documents: entities.length + rejections.length,
    })
  }

  // Virtually means virtually: a new snapshot, never a mutation of the one we
  // were handed, or the second call would disagree with the first.
  const folder = (path: string): string => {
    const cut = path.lastIndexOf('/')
    return cut === -1 ? '' : path.slice(0, cut)
  }

  const kept = snapshot.files.filter((file) => !edited.has(file.path))
  const would: RepositorySnapshot = {
    folders: [...new Set([...snapshot.folders, ...[...edited.keys()].map(folder)])],
    witnesses: snapshot.witnesses,
    files: [...kept, ...edited.values()],
  }

  return { outcomes, violations: checkRepository(would) }
}
