import { createHash } from 'node:crypto'
import type { FileEdit } from '../diff/unified.js'
import {
  CONFIG_FILE,
  holdsInvisible,
  repositoryConfigSchema,
  serializeConfig,
  type RepositoryConfig,
  type WrittenConfig,
} from '../schemas/config.js'
import { planSchema, type Plan } from '../schemas/plan.js'
import { reasonOf } from '../schemas/reject.js'
import { repositoryFileOf, type RepositorySnapshot } from '../validate/rules.js'
import { asCatalogInfo, catalogInfoEdits, filedIn } from './catalog-info.js'
import { questionsOf } from './clarify.js'
import { planEdits } from './edits.js'
import { checkPolicies, type PolicyContext } from './policies.js'
import { recheckPlan } from './recheck.js'
import { sealed } from './seal.js'
import type { SignedPlan } from './sign.js'

/**
 * What a forge is allowed to see: bytes every deterministic gate has passed,
 * the bytes they were computed against, and the repository they are for.
 *
 * `SignedPlan`'s brand proves the plan was signed. It does not prove a policy
 * passed, that the re-check found no error, that no question is left, or that
 * every operation produced bytes — those facts live in the wiring of `cli/`,
 * and a writer that trusted the wiring would be the one place the engine took
 * a caller's word for it. So minting RE-RUNS the free gates rather than taking
 * their verdicts as arguments: §4.2's "any check that guards against
 * destruction is repeated engine-side, at the moment of acting". Against the
 * provenance the plan was signed with (D1); the edits and the re-check over
 * one reading of the bytes — the `PolicyContext` is the caller's, built from
 * the first read, a limit stated beside gap-stage5-readiness-6.
 *
 * What this does NOT prove: that the Reviewer approved. That gate is a model,
 * it cannot be re-run for free, and the `--from` road has none. The merge is
 * still the act of authorisation (ADR-0006).
 */

declare const cleared: unique symbol

/** Every branch a submission may create lives under this, and nowhere else. */
export const SUBMISSION_PREFIX = 'idp-agent/'

const SEALED = 'a clearance is what the gates judged; clear the plan again'

/**
 * Which repository a clearance writes into (check §5). A `FileEdit` names a
 * path and nothing says whose: since #86 the declarations repository has a
 * root `catalog-info.yaml` too, so the same path names a file in both. The
 * role goes on the value that crosses to a forge, set here and nowhere else,
 * and the forge is opened for one.
 */
export type Repository = 'declarations' | 'service'

/**
 * What the gates judged: path → bytes, or `undefined` for a path judged ABSENT.
 * The forge proves the base still holds exactly this before it writes.
 *
 * `catalogue` means every catalogue file of the base must be in `files` — the
 * gates judged the whole catalogue. `touched` means only the listed paths
 * matter: a service repository is not a catalogue. The scope follows from the
 * repository, and `mint` alone sets it.
 *
 * What `catalogue` does NOT hold: the hidden files the gates also judged. A
 * `.witness.yml` decides `unwitnessed-folder`, and `.idp-agent.yml`'s
 * `environments` widens what every gate sees, but neither is a catalogue path
 * (`isCataloguePath`) and neither is in `files` — the policies read them
 * through the caller's `PolicyContext`, not as bytes this module holds. A
 * witness removed or the configuration changed between clearance and
 * submission is therefore not a divergence a forge can prove; `validate` run
 * over the branch still reports the missing witness, as an error. Stated beside
 * gap-stage5-readiness-6, whose `PolicyContext` limit it is.
 */
export interface Expectation {
  readonly files: ReadonlyMap<string, string | undefined>
  readonly scope: 'catalogue' | 'touched'
}

export interface Cleared {
  /**
   * Only the edits that change a byte, in path order. Empty means the
   * repository already says every operation (#83): there is nothing to submit,
   * and a forge answers `unchanged` without creating a ref.
   */
  readonly edits: readonly FileEdit[]
  readonly expected: Expectation
  /**
   * Computed by the engine from the bytes; a forge never takes a name from a
   * caller. With no edits it is the same name for every plan — the digest of
   * nothing — which is harmless only because no ref is ever cut for it.
   */
  readonly branch: string
  readonly message: string
  readonly repository: Repository
  readonly [cleared]: true
}

export interface ClearRefusal {
  readonly outcome: 'refused'
  readonly reasons: readonly string[]
}

/** No provenance here: it is the one the plan was signed with (D1). */
export interface ClearInput {
  readonly policy: PolicyContext
  readonly snapshot: RepositorySnapshot
  /** The bytes of that snapshot, path → text, as the preview composed against. */
  readonly contents: ReadonlyMap<string, string>
}

/**
 * Every `Cleared` this module minted — and nothing else (D3). The compile-time
 * brand stops a hand-built literal; a spread, a cast or `structuredClone` of a
 * real one still type-checks, and would put arbitrary bytes on an `idp-agent/`
 * branch. A `WeakSet` holds identities no other module can add to, and lets go
 * of them with the value.
 */
const minted = new WeakSet<object>()

/** Did `clear.ts` mint exactly this object? What `submit()` checks first. */
export const isCleared = (value: unknown): value is Cleared =>
  typeof value === 'object' && value !== null && minted.has(value)

const refused = (reasons: readonly string[]): ClearRefusal => ({ outcome: 'refused', reasons })

const byPath = (a: FileEdit, b: FileEdit): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

export function clearPlan(signed: SignedPlan, input: ClearInput): Cleared | ClearRefusal {
  // D6: a branch is cut in one repository. `planEdits` drops a
  // create-catalog-info as "writes into the service repository", so it would
  // come back below as "produced no change": true, and misleading.
  const service = signed.plan.operations.flatMap((operation, index) =>
    operation.op === 'create-catalog-info' ? [index] : [],
  )
  if (service.length > 0) {
    return refused(
      service.map(
        (index) =>
          `operations.${String(index)} declares a service in its own repository; ` +
          'plan --submit cuts a branch in the declarations repository only — submit it with init --submit',
      ),
    )
  }

  // One reading of the bytes. The edits and the re-check judge the files
  // rebuilt from `contents`, which are the bytes the forge proves; a snapshot
  // that disagrees with them, or could not list a folder, judged something
  // else. Only the paths are compared: `input.policy` was built from the
  // snapshot's own read, so its natures and environments may be a moment
  // older than these bytes (the limit beside gap-stage5-readiness-6).
  if (input.snapshot.unreadable !== undefined && input.snapshot.unreadable.length > 0) {
    return refused(
      input.snapshot.unreadable.map(
        (one) => `${one.path === '' ? 'the root' : one.path} could not be read: ${one.reason}`,
      ),
    )
  }
  const listed = new Set(input.snapshot.files.map((file) => file.path))
  const disagree = [
    ...[...listed].filter((file) => !input.contents.has(file)),
    ...[...input.contents.keys()].filter((file) => !listed.has(file)),
  ]
  if (disagree.length > 0) {
    return refused(
      disagree.map((file) => `${file} changed between two reads of the repository; run this again`),
    )
  }
  const snapshot: RepositorySnapshot = {
    ...input.snapshot,
    files: [...input.contents].map(([file, text]) => repositoryFileOf(file, text)),
  }

  const provenance = signed.provenance
  // The context `runPlan` gives: without `natures`, an update's implied
  // environment question is never raised (core-plan-3), and a plan whose
  // preview stopped on it would clear.
  const questions = questionsOf(signed.plan, {
    environments: input.policy.vocabulary.environments,
    over: input.policy.over,
    declared: input.policy.environments,
    namesakes: input.policy.namesakes,
    natures: input.policy.natures,
    provenance,
  })
  if (questions.length > 0) {
    return refused(questions.map((question) => `${question.path}: still a question`))
  }

  const policies = checkPolicies(signed, input.policy, provenance)
  if (policies.length > 0) {
    return refused(policies.map((one) => `${one.policy} at ${one.path}: ${one.message}`))
  }

  const { edits, dropped } = planEdits(signed, input.contents)
  // The preview lists a drop and still exits 0; a branch may not. A branch
  // holding the database without the grant is exactly the plan that "grants
  // nothing", and the unit of meaning here is the plan, never the file.
  if (dropped.length > 0) {
    return refused(
      dropped.map(
        (one) =>
          `operations.${String(one.opIndex)} produced no change — ${one.reason}; ` +
          'a branch carries the whole plan or nothing',
      ),
    )
  }

  const recheck = recheckPlan(signed, snapshot, edits)
  const errors = recheck.violations.filter((violation) => violation.severity === 'error')
  if (errors.length > 0) {
    return refused(errors.map((one) => `${one.rule} at ${one.file}: ${one.message}`))
  }

  const changed = edits.filter((edit) => edit.before !== edit.after)
  // #83: an empty change is an answer only when the repository already says
  // every operation (`changedNothing` in `cli/commands/plan.ts`). Anything else
  // behind no bytes was not carried out, and exit 0 would say it was.
  if (changed.length === 0) {
    const unaccounted = signed.plan.operations.flatMap((_, index) =>
      recheck.outcomes.get(index) === 'already-declared' ? [] : [index],
    )
    if (unaccounted.length > 0) {
      return refused(
        unaccounted.map(
          (index) =>
            `operations.${String(index)} produced no change, and the repository does not already say it`,
        ),
      )
    }
  }

  // A created file's name is the engine's; an amended one's is the
  // repository's, read through the entity's annotation, and nothing but
  // `.yml` constrains it. A line break or a bidi control there would be a tree
  // entry nobody can read and a line of the commit body — a trailer, say —
  // that no gate wrote. Refused, never cleaned: a cleaned name is another file.
  const unshowable = changed.filter((edit) => HAS_UNSAFE.test(edit.path))
  if (unshowable.length > 0) {
    return refused(
      unshowable.map(
        (edit) =>
          `${visible(edit.path)} is a file name holding a control or bidi character; ` +
          'a branch will not carry it — rename the file in the repository first',
      ),
    )
  }

  // Every file the gates read, plus every file this plan creates, judged
  // absent: a file that appeared at the base meanwhile is a divergence.
  const files = new Map<string, string | undefined>(input.contents)
  for (const edit of changed) if (edit.before === undefined) files.set(edit.path, undefined)
  return mint(changed, files, 'declarations', signed.plan)
}

/**
 * The only place a `Cleared` is made. Both producers go through it — this file's
 * `clearPlan` and `clearService` — so the freeze, the scope and the runtime
 * brand cannot differ between them.
 */
function mint(
  changed: readonly FileEdit[],
  files: ReadonlyMap<string, string | undefined>,
  repository: Repository,
  plan: Plan,
  label?: string,
): Cleared {
  const edits = [...changed].sort(byPath).map((edit) => Object.freeze({ ...edit }))
  const value = Object.freeze({
    edits: Object.freeze(edits),
    expected: Object.freeze({
      files: sealed(files, SEALED),
      scope: repository === 'declarations' ? ('catalogue' as const) : ('touched' as const),
    }),
    branch: branchFor(edits, label),
    message: messageFor(plan, edits),
    repository,
  })
  minted.add(value)
  return value as unknown as Cleared
}

export interface ServiceInput {
  /** Where `init` files the Component: `targetOf`'s choice, the file the preview shows. */
  readonly target: string
  /**
   * Every catalog-info the service keeps, read whole and outside the budget
   * (`ProjectRead.declarations` less `isSetAside`, #82) — the befores, and what
   * the "already declared" and name decisions read.
   */
  readonly kept: readonly { readonly path: string; readonly text: string }[]
  /**
   * `.idp-agent.yml` as it stands — its bytes, for the forge to prove, and its
   * parsed value, to compare — or undefined when there is none.
   */
  readonly existing: { readonly text: string; readonly config: RepositoryConfig } | undefined
  /** What the person typed for it; undefined when nothing is to be written. */
  readonly config: WrittenConfig | undefined
}

/**
 * The service repository's clearance: its Component, filed where `init`
 * previews it, and `.idp-agent.yml` when a person supplied one (design §7.3).
 * No model value reaches the configuration — `config` comes from flags or
 * answers, never from the plan — and a committed configuration is never
 * rewritten: it seeds the vocabulary every gate measures against, and changing
 * it is a reviewed edit by hand.
 *
 * It does not stand in for `init`'s own verdicts, which run before any model
 * and stay in `cli/commands/init.ts` (design §7.3): an own catalog-info nobody
 * can read whole is refused, a Component already declared exits 0 with no
 * branch, a target declaring another name asks it. What it re-runs is what a
 * forge must not take on trust: no question left, nothing dropped, the file
 * `init` previews and nothing else, the configuration never rewritten. It
 * mints from the same `target` and `kept` the preview composed against — one
 * reading, never a second.
 */
export function clearService(signed: SignedPlan, input: ServiceInput): Cleared | ClearRefusal {
  const questions = questionsOf(signed.plan, { provenance: signed.provenance })
  if (questions.length > 0) {
    return refused(questions.map((question) => `${question.path}: still a question`))
  }

  // Re-crossed for the reason `init.ts` gives: the minted plan is a different
  // object from the one that was signed. Filed where the preview files it.
  const minted = planSchema.safeParse({
    intent: signed.plan.intent,
    operations: signed.plan.operations.map((operation) =>
      filedIn(asCatalogInfo(operation), input.target),
    ),
  })
  if (!minted.success) {
    return refused([`the composed plan is not a plan — ${reasonOf(minted.error)}`])
  }
  // A right, or a Resource, has no place in a service's repository: the
  // preview never shows one there, so a clearance must not carry one either.
  const other = minted.data.operations.flatMap((operation, index) =>
    operation.op === 'create-catalog-info' ? [] : [index],
  )
  if (other.length > 0) {
    return refused(
      other.map(
        (index) =>
          `operations.${String(index)} is not this service's Component; ` +
          'init --submit writes nothing else',
      ),
    )
  }

  const { edits, dropped } = catalogInfoEdits(minted.data, { files: input.kept })
  if (dropped.length > 0) {
    return refused(
      dropped.map(
        (one) =>
          `operations.${String(one.opIndex)} produced no change — ${one.reason}; ` +
          'a branch carries the whole plan or nothing',
      ),
    )
  }

  if (input.config !== undefined) {
    // What a person typed, so refused here rather than thrown by the
    // serialiser's own parse: a flag left empty is a refusal naming its field,
    // never an exception that reads as a failure nobody expected. Only the
    // two written fields, as `serializeConfig` hands them over.
    const typed = repositoryConfigSchema.safeParse({
      iacRepo: input.config.iacRepo,
      environments: input.config.environments,
    })
    if (!typed.success) return refused([`${CONFIG_FILE}: ${reasonOf(typed.error)}`])
    // The file is committed and seeds every gate's vocabulary: a direction
    // override in it is a value a reviewer reads the wrong way round. The class
    // a catalog-info path is held to (`isCatalogInfoPath`), since JSON's
    // escaping leaves format characters and line separators as they are.
    if ([typed.data.iacRepo, ...typed.data.environments].some((value) => holdsInvisible(value))) {
      return refused([
        `${CONFIG_FILE}: a value holds a control, format or bidi character; ` +
          'type it again without one',
      ])
    }
    const after = serializeConfig(typed.data)
    if (input.existing === undefined) {
      edits.push({ path: CONFIG_FILE, before: undefined, after })
    } else if (serializeConfig(input.existing.config) !== after) {
      // Compared by VALUE, through the one serialiser: a hand-written file
      // says `iacRepo: github.com/acme/iac` where this writes it quoted, and
      // comparing bytes refused a re-run over a file that agreed with every
      // flag (measured). A `backstage:` the file holds is not compared: it is
      // never written (D9), so it is never something to disagree about.
      return refused([
        `${CONFIG_FILE} already says something else; a committed configuration is ` +
          'changed by hand, in a reviewed change, never by this command',
      ])
    }
  }

  const changed = edits.filter((edit) => edit.before !== edit.after)
  // What the gates read, proved at the base (check §5.2, 3): the target's bytes
  // or its absence, every kept declaration, and the configuration's bytes or
  // its absence — never `CATALOG_INFO` by name.
  const files = new Map<string, string | undefined>(
    input.kept.map((file) => [file.path, file.text] as const),
  )
  if (!files.has(input.target)) files.set(input.target, undefined)
  files.set(CONFIG_FILE, input.existing?.text)
  const component = minted.data.operations.find(
    (operation) => operation.op === 'create-catalog-info',
  )
  const label =
    component?.op === 'create-catalog-info' ? `init-${component.entity.metadata.name}` : 'init'
  return mint(changed, files, 'service', minted.data, label)
}

const stemOf = (file: string | undefined): string =>
  file === undefined ? 'change' : file.slice(file.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '')

/**
 * The branch a set of bytes becomes. A function of the BYTES, so the same
 * submission made twice names the same branch and the forge can recognise its
 * own work (§9.2, applied at the forge); the order edits arrive in is not part
 * of a change. It is also the plan's identity (gap-stage5-readiness-12): two
 * submissions of one plan are one branch.
 *
 * Every run of characters git would refuse in a ref component — `..`, a
 * leading dot, `.lock` — becomes one `-`. An entity name may legally hold them;
 * a ref may not.
 */
export function branchFor(edits: readonly FileEdit[], label?: string): string {
  const sorted = [...edits].sort(byPath)
  const digest = createHash('sha256')
  for (const edit of sorted) digest.update(edit.path).update('\0').update(edit.after).update('\0')
  const slug =
    (label ?? stemOf(sorted[0]?.path))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'change'
  return `${SUBMISSION_PREFIX}${slug}-${digest.digest('hex').slice(0, 8)}`
}

/**
 * C0 and C1 controls, and the bidi controls that reorder what follows them —
 * the embeddings and override (U+202A–U+202E) and the isolates (U+2066–U+2069),
 * the set `cli/render/plain.ts` treats as dangerous. A copy, because `core/`
 * does not import `cli/`; the marks (LRM, RLM, ALM) are left, as there, since
 * they are how right-to-left writing is typed.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]+/g
/** The same set without `/g`, whose `lastIndex` would carry from one `test` to the next. */
const HAS_UNSAFE = new RegExp(UNSAFE.source)

/** Each unsafe character spelled as its code point: what a name holds, shown and inert. */
const visible = (text: string): string =>
  text.replace(UNSAFE, (run) =>
    [...run].map((one) => `\\u{${one.codePointAt(0)!.toString(16).toUpperCase()}}`).join(''),
  )

/** One line, cut at a code point — never inside a surrogate pair — and said to be cut. */
const cut = (text: string, max: number): string => {
  const points = [...text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('')
}

/** The name a reference ends on: what a person reads in a subject line. */
const nameOf = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1)

/** What an operation does, in the engine's words: the verb is ours, the name the schema held. */
const actionOf = (operation: Plan['operations'][number]): string => {
  switch (operation.op) {
    case 'create-entity':
    case 'create-catalog-info':
      return `declare ${operation.entity.metadata.name}`
    case 'update-entity': {
      const { patch } = operation
      switch (patch.patch) {
        case 'add-dependency-of':
          return `add ${nameOf(patch.consumer)} to ${nameOf(operation.entityRef)}`
        default: {
          const _exhaustive: never = patch.patch
          return _exhaustive
        }
      }
    }
    default: {
      const _exhaustive: never = operation
      return _exhaustive
    }
  }
}

/**
 * The commit message (D18). The subject is the ENGINE's, written from the
 * operations: `plan.intent` is a record, not evidence (`provenance.ts`), and on
 * `--from` it is the file's own words — a subject a person reads first in a
 * forge must not be whatever a plan file said. The request is carried in the
 * body, labelled as recorded, cleaned of what a terminal obeys and cut by code
 * point: a request comes in any script.
 */
export function messageFor(plan: Plan, edits: readonly FileEdit[]): string {
  return [
    cut(`idp-agent: ${plan.operations.map(actionOf).join(', ')}`, 72),
    '',
    'Submitted by idp-agent for review. Nothing is provisioned until this is merged.',
    '',
    // `clearPlan` refuses a name that needs it; this is exported, and holds the line anyway.
    ...edits.map((edit) => `  ${edit.before === undefined ? '+' : '~'} ${visible(edit.path)}`),
    '',
    'Requested, as recorded with the plan (no gate reads it):',
    `  ${cut(plan.intent, 500)}`,
    '',
  ].join('\n')
}
