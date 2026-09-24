import type { FileEdit } from '../diff/unified.js'
import type { Entity } from '../schemas/entity.js'
import { findUnknowns } from '../schemas/plan.js'
import { parseDocuments, serializeEntity } from '../yaml/serialize.js'
import { appendSequenceItem, insertDocument, SurgeryError } from '../yaml/surgery.js'
import { appendedOnly, insertedOnly, listsConsumer } from './effect.js'
import { declaredLevel, proposedLevel, restates, statedAs } from './grant.js'
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
 * **What it guarantees**: every edit it returns carries its operations out,
 * as the parser reads the result back, and changes nothing else. An update's
 * file lists the consumer under that entity, every other document and every
 * other field reading back as before; a creation's file holds one more
 * document, the entity, and the others unchanged; and neither holds a YAML
 * error. An operation whose bytes fail that is DROPPED, with a reason naming
 * the file, and leaves that file as the operations before it had left it.
 * An edit whose two sides are equal means the parser found the work already
 * done, never that the surgery could not find where to do it. Stage 5 writes
 * these bytes to disk, so this is the guarantee that write inherits — design
 * 9.2's effectiveness. `effect.ts` holds the checks; the surgery underneath is
 * a best-effort heuristic, and this is what makes it safe for it to be wrong.
 *
 * What this does NOT do is judge. Whether the entity already lives in some
 * other file is `recheckPlan`'s 'moved' verdict, whether the folder was ever
 * declared is a policy, and whether the result satisfies the seven rules is
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
      // Parsed and resolved by REFERENCE, the same way `declaredAt` above is
      // and for the same reason: a name is not a reference, and a document the
      // entity schema refuses is not a declaration of anything —
      // `checkRepository` is what reports that.
      const there =
        existing === undefined
          ? undefined
          : parseDocuments(existing).entities.find(
              (candidate) => refOf(candidate) === refOf(entity),
            )

      // Already declared there means the file states the same GRANT, never
      // merely a document of the same name. Asked by name, a plan stating
      // `read` against a file granting `readwrite` produced an edit whose two
      // sides were equal — an empty diff, and a run reporting "the repository
      // already says it" about the opposite authorisation.
      //
      // When the levels disagree there is no honest edit to show: appending
      // cannot rewrite a scalar (§4.3), so the operation produces no bytes and
      // NAMES the two levels. The `declared-level-mismatch` policy refuses
      // such a plan before a preview is offered at all; this is the same fact
      // where the bytes are computed, so a caller reaching here without that
      // gate still cannot be told "nothing to change".
      if (there !== undefined && !restates(there, operation.entity)) {
        dropped.push({
          opIndex,
          reason:
            `${path} already declares ${refOf(entity)} and ${statedAs(declaredLevel(there))}, ` +
            `while this plan ${statedAs(proposedLevel(operation.entity))}; a level is not ` +
            `something an append can rewrite`,
        })
        continue
      }

      // Already declared, identically: an edit whose two sides are equal, so
      // the diff comes out empty rather than absent. "Nothing to do" and "the
      // operation was dropped" are different answers, and the caller has to
      // tell them apart — absent means already done (§4.3), but only if it is
      // visible.
      const after =
        there !== undefined && existing !== undefined
          ? existing
          : insertDocument(existing ?? '', serializeEntity(entity))
      const wrong = after === existing ? undefined : insertedOnly(existing, after, entity)
      if (wrong !== undefined) {
        dropped.push({ opIndex, reason: `could not add ${refOf(entity)} to ${path}: ${wrong}` })
        continue
      }
      touch(path, after)
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

      const { entityRef: ref, patch } = operation
      const failed = (why: string): void => {
        dropped.push({
          opIndex,
          reason: `could not add ${patch.consumer} to ${ref} in ${path}: ${why}`,
        })
      }

      // Already listed is the parser's answer, never the surgery's: a flow
      // sequence the surgery would refuse to split can hold the consumer, and
      // an unchanged file is then the truth rather than a failure to find it.
      if (listsConsumer(existing, ref, patch.consumer)) {
        touch(path, existing)
        continue
      }

      const name = ref.slice(ref.lastIndexOf('/') + 1)
      let after: string
      try {
        // One line, appended — and refused loudly on a shape the surgery
        // cannot edit textually, which is caught here so one unamendable file
        // does not lose the rest of the plan.
        //
        // `patch.access` writes NOTHING, and that is not an oversight. §5.3
        // put the level in the operation so the signature can classify it and
        // `declared-level-mismatch` can compare it to the declaration; it is a
        // claim about the grant being extended, and the grant already states
        // its level. Appending cannot rewrite that scalar (§4.3), so the level
        // is also the one thing this edit cannot show a reviewer: `access:`
        // sits further from the inserted line than the three lines of context
        // a hunk carries, and it stays an unchanged line.
        after = appendSequenceItem(existing, name, 'dependencyOf', patch.consumer)
      } catch (error) {
        if (!(error instanceof SurgeryError)) throw error
        failed(error.message)
        continue
      }

      // The parser said the consumer is not listed, so an unchanged file is a
      // surgery that found nothing to amend — the exact shape of "nothing to
      // change" that granted nothing. And a changed one is checked for what
      // it changed: the surgery finds documents by name, not by reference.
      const wrong =
        after === existing
          ? 'the edit left the file as it was'
          : appendedOnly(existing, after, ref, patch.consumer)
      if (wrong !== undefined) {
        failed(wrong)
        continue
      }
      touch(path, after)
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
