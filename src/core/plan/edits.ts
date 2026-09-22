import type { FileEdit } from '../diff/unified.js'
import type { Entity } from '../schemas/entity.js'
import { findUnknowns } from '../schemas/plan.js'
import { parseDocuments, serializeEntity } from '../yaml/serialize.js'
import {
  appendSequenceItem,
  insertDocument,
  listDocumentNames,
  SurgeryError,
} from '../yaml/surgery.js'
import { materialise } from './materialise.js'
import type { SignedPlan } from './sign.js'

/**
 * The bytes a signed plan would leave behind.
 *
 * It takes the bytes that exist and returns the bytes that would exist, and it
 * reads nothing: `before` is handed in because this is `core/`, which never
 * touches a disk. That is not an inconvenience worked around — it is what makes
 * the diff a reviewer sees and the write that follows the same computation,
 * rather than two implementations that agree until they do not.
 *
 * Where each file goes is `signed.paths`, never the proposal (design 5.2), and
 * the translation from a proposal to an entity lives in `materialise.ts` —
 * a proposal carries `metadata.env` where an entity carries an annotation, and
 * no apiVersion at all. `recheckPlan` needs the same translation, so neither
 * module owns it.
 *
 * What this does NOT do is judge. Whether the entity already lives in some
 * other file is `recheckPlan`'s 'moved' verdict, whether the folder was ever
 * declared is a policy, and whether the result satisfies the six rules is
 * `checkRepository`. This function computes text; the gates upstream decide
 * whether that text is ever offered.
 */
/**
 * An operation that produced no bytes, and why. Never a silent skip: a caller
 * printing a diff has to be able to say "this plan grants nothing" rather than
 * "nothing to change", which is the same sentence for the opposite fact.
 */
export interface DroppedOperation {
  readonly opIndex: number
  readonly reason: string
}

export interface PlanEdits {
  /** One edit per FILE, never per operation. See below. */
  readonly edits: readonly FileEdit[]
  readonly dropped: readonly DroppedOperation[]
}

const refOf = (entity: Entity): string =>
  `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`

export function planEdits(signed: SignedPlan, before: ReadonlyMap<string, string>): PlanEdits {
  const dropped: DroppedOperation[] = []

  /**
   * path → the bytes as this plan has left them so far, and the order paths
   * were first touched in.
   *
   * Keyed by PATH, not by operation. Two operations touching one file are one
   * edit whose `after` is the second applied to the first: emitting one edit
   * each produces two `--- a/<path>` sections for the same file, the second
   * numbered against the intermediate buffer rather than the repository, which
   * `patch` garbles. A diff is a statement about a file, not about the work
   * that produced it.
   */
  const buffered = new Map<string, string>()
  const order: string[] = []
  const contentOf = (path: string): string | undefined => buffered.get(path) ?? before.get(path)
  const touch = (path: string, after: string): void => {
    if (!buffered.has(path)) order.push(path)
    buffered.set(path, after)
  }

  // ref → the file declaring it, built once: a plan with n operations over a
  // repository with m files must not be n×m. Keyed by the FULL reference,
  // kind included: `component:default/x` and `resource:default/x` are two
  // entities, and resolving by bare name let an operation naming one patch
  // the other. First declaration wins, the way the catalogue resolves a
  // duplicate (design 4.4); a name in two files is a violation the rules
  // already report.
  const declaredAt = new Map<string, string>()
  for (const [path, content] of before) {
    // Parsed, not just named: `listDocumentNames` returns names, and a name is
    // not a reference. Resolving an update by the bare name let an operation
    // naming `component:default/x` amend `resource:default/x` — two entities
    // that share nothing but a string.
    for (const entity of parseDocuments(content).entities) {
      if (!declaredAt.has(refOf(entity))) declaredAt.set(refOf(entity), path)
    }
  }

  for (const [opIndex, operation] of signed.plan.operations.entries()) {
    // A question is not a value. Serialising one would write
    // `owner: {unknown: which one is it?}` into the repository, which is the
    // opposite of declare-never-infer (design 4.1); the CLI asks instead.
    if (findUnknowns(operation).length > 0) {
      dropped.push({ opIndex, reason: 'still carries a question' })
      continue
    }

    if (operation.op === 'create-entity') {
      const path = signed.paths.get(opIndex)
      if (path === undefined) {
        dropped.push({ opIndex, reason: 'the engine computed no path for it' })
        continue
      }
      const entity = materialise(operation.entity)
      if (entity === undefined) {
        dropped.push({ opIndex, reason: 'the proposal could not be read as an entity' })
        continue
      }

      const existing = contentOf(path)
      const declared =
        existing !== undefined && listDocumentNames(existing).includes(entity.metadata.name)
      // Already declared there: an edit whose two sides are equal, so the diff
      // comes out empty rather than absent. "Nothing to do" and "the operation
      // was dropped" are different answers, and the caller has to tell them
      // apart — absent means already done (§4.3), but only if it is visible.
      touch(path, declared ? existing : insertDocument(existing ?? '', serializeEntity(entity)))
      // Declared by THIS plan now, so a later operation can patch it. Without
      // this an update naming an entity the same plan creates was dropped in
      // silence, and the preview showed the creation without the grant.
      if (!declaredAt.has(refOf(entity))) declaredAt.set(refOf(entity), path)
      continue
    }

    if (operation.op === 'update-entity') {
      // The file is found in the bytes, because that is the only place this
      // function is allowed to look: `signed.paths` holds the paths the engine
      // COMPUTED, and an entity that already exists was filed by whoever wrote
      // it — possibly not where convention would have put it (design 5.2).
      const path = declaredAt.get(operation.entityRef)
      if (path === undefined) {
        dropped.push({
          opIndex,
          reason: `${operation.entityRef} is declared in no file this plan can see`,
        })
        continue
      }
      const existing = contentOf(path)
      if (existing === undefined) {
        dropped.push({ opIndex, reason: `${path} holds no bytes to amend` })
        continue
      }

      const name = operation.entityRef.slice(operation.entityRef.lastIndexOf('/') + 1)
      try {
        // One line, appended. `appendSequenceItem` leaves the text alone when
        // the consumer is already listed, which surfaces as before === after
        // for the same reason a re-declared entity does — and refuses loudly
        // on a shape it cannot edit textually, which is caught here so one
        // unamendable file does not lose the rest of the plan.
        touch(path, appendSequenceItem(existing, name, 'dependencyOf', operation.patch.consumer))
      } catch (error) {
        if (!(error instanceof SurgeryError)) throw error
        dropped.push({ opIndex, reason: error.message })
      }
      continue
    }

    // create-catalog-info contributes nothing to THIS repository, and the
    // omission is the rule rather than a gap: its `repoPath` names a file in
    // the service's own repository, not in the declarations repository these
    // edits describe. It is still reported, because an operation that
    // produces no bytes must never be invisible.
    dropped.push({
      opIndex,
      reason: 'writes into the service repository, which this preview does not cover',
    })
  }

  const edits: FileEdit[] = order.map((path) => ({
    path,
    before: before.get(path),
    after: buffered.get(path) ?? '',
  }))

  return { edits, dropped }
}
