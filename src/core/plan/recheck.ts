import type { FileEdit } from '../diff/unified.js'
import type { Entity } from '../schemas/entity.js'
import { consumerRestatement, restatementOf, type DeclaredField } from './grant.js'
import type { RepositoryFile, RepositorySnapshot, Violation } from '../validate/rules.js'
import { checkRepository, repositoryFileOf } from '../validate/rules.js'
import type { SignedPlan } from './sign.js'

/**
 * The sixth step of §7.4, which exists because the catalogue lags the
 * repository by about two minutes (§4.4). What was true when the plan was
 * drafted may not be true now — the entity may have appeared, or appeared
 * somewhere else — and the plan was signed against the older truth.
 *
 * The check is not a second set of rules. It applies the plan **virtually** —
 * builds the snapshot that would exist if the plan landed — and runs
 * `checkRepository` over the result: the same nine rules CI runs, asked about a
 * repository that does not exist yet. That reuse is the whole reason stage 3
 * put those rules in `core/` with no `node:` import.
 *
 * What it refuses a plan for is what THE PLAN does to that repository, never
 * the repository as a whole. The rules are asked twice — about the snapshot and
 * about the result — and a violation of the result is the plan's when it is new
 * or sits in a file the plan edits (a duplicate: names one); anything else was
 * there before and stays untouched, and is `standing`. Refusing on the whole
 * list blocked every plan on a real repository over one fault anywhere in it,
 * and sent that fault to the Architect as a repair report it could not act on,
 * three paid times.
 */

export type RecheckOutcome =
  /**
   * Nothing declares what it states yet: a creation of a reference the
   * repository does not hold, or a consumer appended to a grant that does not
   * list it.
   */
  | 'fresh'
  /**
   * Everything the operation states is already declared (`grant.ts`): the
   * entity at the path the plan computed, or the consumer on the grant an
   * update extends, at the level it states. What the CLI reports as "nothing
   * to change — the repository already says it", naming the file and the
   * fields (`restated`).
   */
  | 'already-declared'
  /**
   * Same reference, same file, and it says something else: another level,
   * owner, environment, type, target, or a grant that does not list the
   * consumer the plan states. Decided by name, or by level alone, this came
   * out `already-declared`, so an access nobody had was reported as work
   * already done. See `grant.ts` for what is compared.
   */
  | 'differs'
  /** Same name, different file. Writing would make a duplicate. */
  | 'moved'
  /**
   * Nothing to check: a creation still carrying a question, so there is no
   * path, or an update of a reference the repository declares nowhere, which
   * `planEdits` drops by name.
   */
  | 'unresolved'

/** An operation the repository already declares, and where and what it says. */
export interface Restated {
  /** The file declaring it, repository-relative: the one a reader opens. */
  readonly path: string
  readonly ref: string
  /** Every field the operation states, as the file says it. */
  readonly fields: readonly DeclaredField[]
}

export interface Recheck {
  readonly outcomes: ReadonlyMap<number, RecheckOutcome>
  /**
   * opIndex → what the repository already says, for every operation whose
   * outcome is `already-declared` and only those. A person told "the
   * repository already says it" has to be able to check that it does.
   */
  readonly restated: ReadonlyMap<number, Restated>
  /**
   * The PLAN's violations, errors and warnings: those of the repository it
   * would leave behind that it introduces — including a fault it changes, such
   * as a duplicate that gains a file — or that sit in a file it edits (a
   * duplicate: name one; a missing witness: be its folder), since a merge
   * request carrying a file CI refuses has to say so whoever broke it.
   * An error here is a reason to refuse the plan.
   */
  readonly violations: readonly Violation[]
  /**
   * Every other violation of that repository: already in the snapshot, word
   * for word, in a file this plan leaves alone. Reported, never a reason to
   * refuse, and never the Architect's to repair — `validate` is where it is
   * fixed, and no plan can be expected to fix it in passing.
   */
  readonly standing: readonly Violation[]
}

const refOf = (entity: Entity): string =>
  `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`

const folderOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** Where the plan writes, as each rule anchors a violation. */
interface Written {
  /** The files whose bytes it changes. */
  readonly files: ReadonlySet<string>
  /** The folders those files are in. */
  readonly folders: ReadonlySet<string>
  /** The anchor of every duplicate one of whose copies it changes. */
  readonly duplicates: ReadonlySet<string>
}

/** Whether `violation` is anchored where the plan writes. */
const anchoredIn = (violation: Violation, written: Written): boolean => {
  switch (violation.rule) {
    // A folder rule anchors on the folder: writing any file into it is
    // writing into the thing CI refuses.
    case 'missing-witness':
    case 'unreadable-folder':
      return written.folders.has(violation.file)
    // A duplicate names every file involved but anchors on the first in sort
    // order, so asking about that file alone would clear a plan that edits
    // the second copy — or refuse it, depending on how the paths sort.
    case 'duplicate-name':
      return written.duplicates.has(violation.file)
    case 'invalid-entity':
    case 'multiple-entities':
    case 'misplaced-entity':
    case 'dangling-reference':
    case 'not-modelled':
    case 'registration':
      return written.files.has(violation.file)
    default: {
      const _exhaustive: never = violation.rule
      return _exhaustive
    }
  }
}

/**
 * Splits what CI would say about `after` into the plan's and the rest.
 *
 * Identity is rule, file and message, counted rather than merely present: two
 * identical violations before and three after means the plan added one. The
 * message is part of it on purpose — a duplicate that gains a file reads
 * differently, and making an existing fault worse is the plan's doing.
 *
 * Under today's two operations neither the count nor the message decides
 * anything `anchoredIn` does not. Identical violations share a file, so a plan
 * can only add one by changing that file; and an operation only ever adds a
 * declaration, so a duplicate can only change by gaining a file the plan
 * changes, which `written.duplicates` anchors. Both stay, so that "new" keeps
 * meaning new for a rule or an operation that breaks either fact.
 */
const attribute = (
  before: readonly Violation[],
  after: readonly Violation[],
  written: Written,
): Pick<Recheck, 'violations' | 'standing'> => {
  const key = (violation: Violation): string =>
    JSON.stringify([violation.rule, violation.file, violation.message])
  const remaining = new Map<string, number>()
  for (const violation of before) {
    remaining.set(key(violation), (remaining.get(key(violation)) ?? 0) + 1)
  }

  const violations: Violation[] = []
  const standing: Violation[] = []
  for (const violation of after) {
    const left = remaining.get(key(violation)) ?? 0
    if (left > 0) remaining.set(key(violation), left - 1)
    const introduced = left === 0
    if (introduced || anchoredIn(violation, written)) violations.push(violation)
    else standing.push(violation)
  }
  return { violations, standing }
}

export function recheckPlan(
  signed: SignedPlan,
  snapshot: RepositorySnapshot,
  edits: readonly FileEdit[],
): Recheck {
  const outcomes = new Map<number, RecheckOutcome>()
  const restated = new Map<number, Restated>()

  // Where the repository already declares each reference, and what it
  // declares there. Built once: a plan with n operations over a repository
  // with m files must not be n×m. The FIRST declaration wins, the way the
  // catalogue resolves a duplicate (§4.4) and the way `planEdits` finds the
  // file an update amends: the last one used to win here, so the two could
  // name different files for one operation (core-plan-12).
  const declaredAt = new Map<string, string>()
  const declares = new Map<string, Entity>()
  for (const file of snapshot.files) {
    for (const entity of file.entities) {
      if (declares.has(refOf(entity))) continue
      declaredAt.set(refOf(entity), file.path)
      declares.set(refOf(entity), entity)
    }
  }

  for (const [opIndex, operation] of signed.plan.operations.entries()) {
    // An update names its grant by reference and computes no path: the file
    // is wherever the repository declares it. It used to be `unresolved`
    // whatever that file said, so an access that existed was never named.
    if (operation.op === 'update-entity') {
      const { entityRef, patch } = operation
      const there = declares.get(entityRef)
      const where = declaredAt.get(entityRef)
      if (there === undefined || where === undefined) {
        outcomes.set(opIndex, 'unresolved')
        continue
      }
      const listed =
        there.kind === 'Resource' && (there.spec.dependencyOf ?? []).includes(patch.consumer)
      if (!listed) {
        outcomes.set(opIndex, 'fresh')
        continue
      }
      const restatement = consumerRestatement(there, patch.consumer, patch.access)
      if (restatement.restates) {
        outcomes.set(opIndex, 'already-declared')
        restated.set(opIndex, { path: where, ref: entityRef, fields: restatement.fields })
      } else {
        outcomes.set(opIndex, 'differs')
      }
      continue
    }

    const path = signed.paths.get(opIndex)
    const ref = signed.refs.get(opIndex)
    if (path === undefined || ref === undefined) {
      outcomes.set(opIndex, 'unresolved')
      continue
    }

    const existing = declaredAt.get(ref)
    if (existing === undefined) {
      outcomes.set(opIndex, 'fresh')
      continue
    }
    if (existing !== path) {
      outcomes.set(opIndex, 'moved')
      continue
    }

    // The reference is there, at the path the engine computed. Whether that is
    // "already declared" depends on what the file SAYS: this outcome is what
    // the CLI prints as "the repository already says it", so it has to mean
    // the repository says everything the plan says. Decided by the reference
    // alone, then by the level alone, it reported an access nobody had as work
    // already done, with an empty diff and exit 0. `grant.ts` is the one place
    // that rule lives — the question `planEdits` asks to decide whether to
    // write any bytes.
    const there = declares.get(ref)
    const restatement =
      there === undefined || operation.op !== 'create-entity'
        ? undefined
        : restatementOf(there, operation.entity)
    if (restatement?.restates === true) {
      outcomes.set(opIndex, 'already-declared')
      restated.set(opIndex, { path, ref, fields: restatement.fields })
    } else {
      outcomes.set(opIndex, 'differs')
    }
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
   * same nine rules reject once applied.
   *
   * Parsing the edits instead makes the check and the preview the same object.
   * It is the repository's own habit — write then read back — applied to a
   * write that has not happened.
   */
  const edited = new Map<string, RepositoryFile>()
  for (const edit of edits) {
    edited.set(edit.path, repositoryFileOf(edit.path, edit.after))
  }

  // Virtually means virtually: a new snapshot, never a mutation of the one we
  // were handed, or the second call would disagree with the first.
  const kept = snapshot.files.filter((file) => !edited.has(file.path))
  const would: RepositorySnapshot = {
    folders: [...new Set([...snapshot.folders, ...[...edited.keys()].map(folderOf)])],
    witnesses: snapshot.witnesses,
    files: [...kept, ...edited.values()],
    ...(snapshot.unreadable !== undefined ? { unreadable: snapshot.unreadable } : {}),
  }

  // A file the plan EDITS is one whose bytes it changes. `already-declared`
  // still arrives as an edit, with two equal sides, and the merge request
  // carries no such file — so a fault in it is no more the plan's than a fault
  // in any other file it never opened.
  const changed = new Set(
    edits.filter((edit) => edit.before !== edit.after).map((edit) => edit.path),
  )

  // Every file declaring each reference in the result, to find the duplicates
  // the plan changes a copy of. Keyed by anchor, as the rule reports them: a
  // file anchoring two duplicates holds two entities, which is already an
  // error in that file, and naming both the plan's is the lesser mistake.
  const declaring = new Map<string, string[]>()
  for (const file of would.files) {
    for (const entity of file.entities) {
      declaring.set(refOf(entity), [...(declaring.get(refOf(entity)) ?? []), file.path])
    }
  }
  const duplicates = new Set<string>()
  for (const paths of declaring.values()) {
    if (paths.length < 2 || !paths.some((path) => changed.has(path))) continue
    duplicates.add([...paths].sort()[0] ?? '')
  }

  return {
    outcomes,
    restated,
    ...attribute(checkRepository(snapshot), checkRepository(would), {
      files: changed,
      folders: new Set([...changed].map(folderOf)),
      duplicates,
    }),
  }
}
