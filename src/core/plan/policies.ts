import type { Vocabulary } from '../schemas/vocabulary.js'
import type { SignedPlan } from './sign.js'

/**
 * The second gate of §6.1, which the design named four times and defined
 * nowhere.
 *
 * **A Policy is a deterministic predicate over a signed Plan.** No model, no
 * disk. That is the whole definition, and it is what makes these three
 * testable without a repository and free to run: the first gate (the schema)
 * rejects what cannot be expressed, the signature asks about what nobody can
 * vouch for, and a policy refuses what is expressible, vouched for, and still
 * wrong.
 *
 * Three ship in v0.1. A configurable rule engine — `governance/`, and the
 * `get_governance_rule` tool of §6 — is deferred: three predicates that run
 * are worth more than an extension point that does not.
 */

export type PolicyName =
  | 'environment-mismatch'
  | 'unwitnessed-folder'
  | 'cross-environment-consumer'

export interface PolicyViolation {
  readonly policy: PolicyName
  readonly opIndex: number
  /** The dotted path, so a violation reads like the questions do. */
  readonly path: string
  readonly message: string
}

export interface PolicyContext {
  readonly vocabulary: Vocabulary
  /** Folders holding a witness, repository-relative. §7.2's structure. */
  readonly witnesses: ReadonlySet<string>
  /** ref → the environment that entity declares, from the snapshot. */
  readonly environments: ReadonlyMap<string, string>
}

/** Whole-word and case-insensitive, the same test the signature echoes with. */
function names(intent: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(intent)
}

const folderOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Every environment the plan touches: the one an entity declares, and the ones
 * its name carries. A name is checked because the signature lets a name keep a
 * segment a witnessed reference vouches for — `billing-api-orders-db-prod`
 * passes on a dev request, because `orders-db-prod` exists. The value is right
 * about where it came from and wrong about what it says, which is exactly the
 * gap a policy is for.
 */
function environmentsTouched(entity: unknown, vocabulary: Vocabulary): string[] {
  if (typeof entity !== 'object' || entity === null) return []
  const metadata = (entity as { metadata?: unknown }).metadata
  if (typeof metadata !== 'object' || metadata === null) return []

  const touched = new Set<string>()
  const { env, name } = metadata as { env?: unknown; name?: unknown }

  if (typeof env === 'string') touched.add(env)
  if (typeof name === 'string') {
    for (const segment of name.split('-')) {
      if (vocabulary.environments.includes(segment)) touched.add(segment)
    }
  }
  return [...touched]
}

const referencesOf = (entity: unknown): string[] => {
  if (typeof entity !== 'object' || entity === null) return []
  const spec = (entity as { spec?: unknown }).spec
  if (typeof spec !== 'object' || spec === null) return []
  const { dependsOn, dependencyOf } = spec as { dependsOn?: unknown; dependencyOf?: unknown }
  return [...(Array.isArray(dependsOn) ? dependsOn : []), ...(Array.isArray(dependencyOf) ? dependencyOf : [])]
    .filter((reference): reference is string => typeof reference === 'string')
}

export function checkPolicies(
  signed: SignedPlan,
  context: PolicyContext,
): PolicyViolation[] {
  const violations: PolicyViolation[] = []
  const { intent, operations } = signed.plan

  // The environments the request itself named. When it named none, every
  // environment policy stays silent: the signer already turned that into a
  // question, and firing here would report the same thing twice.
  const asked = context.vocabulary.environments.filter((environment) =>
    names(intent, environment),
  )

  for (const [opIndex, operation] of operations.entries()) {
    if (operation.op !== 'create-entity' && operation.op !== 'create-catalog-info') continue
    const entity: unknown = operation.entity

    if (asked.length > 0) {
      for (const touched of environmentsTouched(entity, context.vocabulary)) {
        if (asked.includes(touched)) continue
        violations.push({
          policy: 'environment-mismatch',
          opIndex,
          path: `operations.${opIndex}.entity.metadata`,
          message:
            `the plan touches ${touched}, but the request named ` +
            `${asked.join(' and ')}. An environment is never inferred.`,
        })
      }
    }

    const produced = signed.paths.get(opIndex)
    if (produced !== undefined) {
      const folder = folderOf(produced)
      if (!context.witnesses.has(folder)) {
        violations.push({
          policy: 'unwitnessed-folder',
          opIndex,
          path: `operations.${opIndex}`,
          message:
            `${folder} holds no witness, so the repository never declared it. ` +
            `Writing there would invent structure.`,
        })
      }
    }

    // An access is the shape §4.1 is about: it grants one thing to another,
    // and the grant is scoped to an environment. A reference the repository
    // has never seen is dangling-reference's business, and CI already runs
    // that rule — guessing here would report a worse second version of it.
    const declared = environmentsTouched(entity, context.vocabulary)
    for (const reference of referencesOf(entity)) {
      const theirs = context.environments.get(reference)
      if (theirs === undefined) continue
      if (declared.length === 0 || declared.includes(theirs)) continue
      violations.push({
        policy: 'cross-environment-consumer',
        opIndex,
        path: `operations.${opIndex}.entity.spec`,
        message:
          `${reference} lives in ${theirs}, but this declaration is scoped to ` +
          `${declared.join(' and ')}. Being authorised in one environment ` +
          `grants nothing in another.`,
      })
    }
  }

  // Every violation, never the first: a caller fixing them one round-trip at
  // a time is the repair loop's worst case, and each round-trip is paid for.
  return violations
}
