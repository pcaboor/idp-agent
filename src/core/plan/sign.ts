import type { Plan } from '../schemas/plan.js'
import { PLAN_LIMITS } from '../schemas/plan.js'
import { computeEntityPath } from '../paths/entity-path.js'
import type { ResourceType } from '../schemas/resource-types.js'
import type { Vocabulary } from '../schemas/vocabulary.js'

/**
 * The write-side guarantee ADR-0007 said propose() owed.
 *
 * The read-side one worked because an Answer carries nothing but identifiers,
 * so one membership test covered all of it. A Plan carries values that were
 * never in the catalogue — that is what proposing means — so membership has
 * nothing to test against. Instead every leaf is classified by WHERE IT CAME
 * FROM, and a value nobody can vouch for becomes a question.
 *
 * What this does not cover, stated as plainly as ADR-0007 stated its own:
 * the signature says where a value came from. It says NOTHING about whether
 * the value is right. An owner that exists and is the wrong team is
 * `enumerated` and signs cleanly. That is what the diff is for, and why the
 * merge — not the signature — is the act of authorisation.
 */

declare const signature: unique symbol

export type LeafClass = 'echoed' | 'enumerated' | 'derived' | 'novel'

export interface LeafFinding {
  readonly opIndex: number
  /** The dotted form findUnknowns returns, so a report reads like a question. */
  readonly path: string
  readonly class: LeafClass
}

export interface LeafRefusal {
  readonly opIndex: number
  readonly path: string
  readonly reason: string
}

export interface PlanRefusal {
  readonly outcome: 'refused'
  readonly gate: 'signature'
  readonly refusals: readonly LeafRefusal[]
}

export interface SignatureContext {
  /** References the ENGINE returned — the propose tool's witness set. */
  readonly witnessed: ReadonlySet<string>
  readonly vocabulary: Vocabulary
  readonly repoRoot: string
  /** ref → the file already declaring it. The re-check decides what that means. */
  readonly declared: ReadonlyMap<string, string>
}

/**
 * Only `signPlan` can mint one: the brand is not exported, so everything
 * downstream takes a SignedPlan and a bare Plan will not typecheck. "The
 * engine signs" becomes a compile error rather than a slogan.
 */
export interface SignedPlan {
  readonly plan: Plan
  /** Engine-computed, repository-relative. Never read from the proposal. */
  readonly paths: ReadonlyMap<number, string>
  readonly refs: ReadonlyMap<number, string>
  readonly classified: readonly LeafFinding[]
  readonly [signature]: true
}

const isUnknown = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'unknown' in value

/** Whole-word, case-insensitive: "prod" in "in prod" counts, "pro" does not. */
function echoes(intent: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(intent)
}

/**
 * A name is the one thing design 5.2 hands the model outright, and a composed
 * name is never echoed whole: nobody writes "billing-api-orders-db-prod" in a
 * request. So a name is vouched for when **every segment of it** is — each
 * hyphen-separated piece either appears in the request or is a value the
 * catalogue already uses. `billing-api-orders-db-prod` from "give billing-api
 * access to orders-db in prod" passes; `billing-api-secret-backdoor` does not.
 */
function composed(
  intent: string,
  vocabulary: Vocabulary,
  witnessed: ReadonlySet<string>,
  name: string,
): boolean {
  const segments = name.split('-').filter((segment) => segment.length > 0)
  if (segments.length === 0) return false

  const known = [
    ...vocabulary.environments,
    ...vocabulary.types,
    ...[...witnessed].flatMap((ref) => (ref.split('/').pop() ?? '').split('-')),
  ]

  return segments.every(
    (segment) => echoes(intent, segment) || known.includes(segment),
  )
}

function enumerated(vocabulary: Vocabulary, path: string, value: string): boolean {
  if (path.endsWith('.owner')) return vocabulary.owners.includes(value)
  if (path.endsWith('.type')) return vocabulary.types.includes(value)
  // Deliberately no `.env`. An environment is the one field where "the
  // catalogue already uses this value" is not provenance: `prod` always
  // exists, so enumerating it would let a model pick production for a request
  // that named no environment at all, and the plan would sign cleanly. §4.1
  // says being authorised in dev grants nothing elsewhere; an environment is
  // therefore echoed — the user named it — or novel, and novel means asked.
  if (path.endsWith('.kind')) return vocabulary.kinds.includes(value)
  return false
}

interface Frame {
  readonly value: unknown
  readonly path: string
  readonly opIndex: number
}

/**
 * Iterative, bounded by PLAN_LIMITS, in the shape of findUnknowns — a
 * recursive walk would make a deeply nested proposal a denial of service, and
 * the guarantee has to be total over leaves or a field escapes by being nested.
 */
export function signPlan(plan: Plan, context: SignatureContext): SignedPlan | PlanRefusal {
  const classified: LeafFinding[] = []
  const refusals: LeafRefusal[] = []
  const asked = new Map<string, string>()

  const stack: Frame[] = plan.operations.map((operation, index) => ({
    value: operation,
    path: `operations.${index}`,
    opIndex: index,
  }))
  let nodes = 0

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    nodes += 1
    if (nodes > PLAN_LIMITS.maxNodes) {
      return {
        outcome: 'refused',
        gate: 'signature',
        refusals: [{ opIndex: 0, path: '', reason: 'plan holds more values than can be signed' }],
      }
    }

    const { value, path, opIndex } = frame

    if (isUnknown(value)) {
      // Already a question. Nothing to vouch for, nothing to refuse.
      classified.push({ opIndex, path, class: 'derived' })
      continue
    }

    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        stack.push({ value: item, path: `${path}.${index}`, opIndex })
      }
      continue
    }

    if (typeof value === 'object' && value !== null) {
      for (const [key, nested] of Object.entries(value)) {
        stack.push({ value: nested, path: `${path}.${key}`, opIndex })
      }
      continue
    }

    // A leaf.
    const text = String(value)
    let leafClass: LeafClass = 'novel'

    if (path.endsWith('.op') || path.endsWith('.patch') || path.endsWith('.kind')) {
      // Structural: the closed union already decided these.
      leafClass = 'derived'
    } else if (echoes(plan.intent, text)) {
      // Checked before the vocabulary on purpose. A value can be both, and
      // "the user asked for this" is the stronger claim: it is their request,
      // not merely something that happens to exist somewhere.
      leafClass = 'echoed'
    } else if (context.witnessed.has(text) || enumerated(context.vocabulary, path, text)) {
      leafClass = 'enumerated'
    } else if (
      path.endsWith('.name') &&
      composed(plan.intent, context.vocabulary, context.witnessed, text)
    ) {
      leafClass = 'echoed'
    }

    classified.push({ opIndex, path, class: leafClass })
    if (leafClass === 'novel') asked.set(path, text)
  }

  // A value nobody can vouch for becomes a question rather than a refusal:
  // "declare, never infer" means asking, not guessing and not giving up.
  const withQuestions = asked.size === 0 ? plan : askAbout(plan, asked)

  const paths = new Map<number, string>()
  const refs = new Map<number, string>()

  for (const [index, operation] of withQuestions.operations.entries()) {
    if (operation.op !== 'create-entity') continue
    const entity = operation.entity
    const name = entity.metadata.name
    if (entity.kind !== 'Resource') continue
    const type = entity.spec.type
    // A path cannot be computed from a question. The plan is not applicable
    // anyway — the CLI asks first.
    if (isUnknown(type) || isUnknown(name) || typeof name !== 'string') continue
    try {
      paths.set(index, computeEntityPath(type as ResourceType, name))
      refs.set(index, `resource:default/${name}`)
    } catch (error) {
      refusals.push({
        opIndex: index,
        path: `operations.${index}.entity.metadata.name`,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (refusals.length > 0) return { outcome: 'refused', gate: 'signature', refusals }

  // The brand exists only in the type: `declare const` has no runtime value,
  // and constructing the property would let anyone forge one. The cast here is
  // the whole point — this module is the only place it is allowed.
  return { plan: withQuestions, paths, refs, classified } as unknown as SignedPlan
}

/** Replaces each novel leaf with the question the CLI will put to the user. */
function askAbout(plan: Plan, asked: ReadonlyMap<string, string>): Plan {
  const clone = structuredClone(plan) as Record<string, unknown>
  for (const [path] of asked) {
    const parts = path.split('.')
    const field = parts.pop()
    if (field === undefined) continue
    let cursor: Record<string, unknown> = clone
    for (const part of parts) {
      const next = cursor[part]
      if (typeof next !== 'object' || next === null) break
      cursor = next as Record<string, unknown>
    }
    cursor[field] = { unknown: `nothing vouches for this ${field}; which one is it?` }
  }
  return clone as unknown as Plan
}
