import type { Operation } from '../schemas/plan.js'
import { fold } from './echoes.js'
import { levelFieldOf, type AccessSubject, type GrantedOver } from './grant.js'
import { named, type Provenance } from './provenance.js'
import { documentNames, type DocumentName } from '../yaml/serialize.js'

/**
 * The environment an operation is about, where it is stated and where it is
 * only implied — and the one place a name is read for one.
 *
 * §4.1 makes the environment part of an access's identity, and "an
 * environment is never inferred" is the guarantee every gate here serves. Three
 * readings of it live in this module because several modules ask them: which
 * environments a NAME says (`checkPolicies`), where an operation's environment
 * is answered (`questionsOf`, `recordAnswers`, `reapplyAnswers`,
 * `checkPolicies`), and what a request states about the environment of the
 * grant an update extends — its words, or the thing it points at, measured
 * against every name the repository holds (`requestedEnvironment`, read by
 * `questionsOf` and `checkPolicies`).
 */

/**
 * The field an `update-entity`'s environment is answered at, relative to the
 * operation. No such field exists in the operation, and that is the point: an
 * update names its grant by reference, the grant's environment is whatever the
 * repository declares, and the patch carries none — so the model chose the dev
 * grant or the prod grant and nothing asked. The question is put at this path
 * (`questionsOf`), its answer is recorded there and never written into the
 * plan (`fillAnswers`), and the policies measure the grant against it.
 *
 * Not a patch field because the patch is what the Architect is shown and
 * proposes: a field there is a change to the tool every recording carries.
 */
export const ENVIRONMENT_FIELD = 'environment'

/** The dotted path an update's environment is asked and answered at. */
export const environmentPath = (opIndex: number): string =>
  `operations.${opIndex}.${ENVIRONMENT_FIELD}`

/**
 * Where an operation states — or, for an update, is asked — the environment
 * of an access, and which access that is: the consumer and the thing, when
 * there is exactly one of each (`levelFieldOf`, the key #72 gave a level).
 *
 * An answer to "which environment?" is about the access — at which
 * environment billing-api reaches orders-db — so it is carried by the access,
 * as a level is: typed at a grant the draft declared, it follows the redraft
 * that joins billing-api to an existing grant over the same thing instead, and
 * the other way round. Only for a right whose type states a level, for the
 * reason a level is: a network flow over the same database is not that
 * access, and is never counted as it.
 */
export interface EnvironmentField {
  /** Dotted, relative to the operation: `environment` or `entity.metadata.env`. */
  readonly field: string
  readonly access: AccessSubject
}

export function environmentFieldOf(
  operation: Operation,
  over: GrantedOver,
): EnvironmentField | undefined {
  const level = levelFieldOf(operation, over)
  if (level === undefined) return undefined
  return {
    field: operation.op === 'update-entity' ? ENVIRONMENT_FIELD : 'entity.metadata.env',
    access: level.access,
  }
}

/**
 * The environments a grant hands out, and the words for where they come from:
 * the one it declares, or — when it declares none — those of what it is over,
 * each as the repository declares it. Never a name: a grant with neither is
 * scoped to nothing known, and says so.
 *
 * Read by `questionsOf` and `checkPolicies`, which holds an answer to the same scope the
 * question showed: two readings of one grant would be two engines.
 */
export function scopeOf(
  entityRef: string,
  declared: ReadonlyMap<string, string>,
  over: GrantedOver,
): { readonly environments: readonly string[]; readonly words: string } {
  const own = declared.get(entityRef)
  if (own !== undefined) return { environments: [own], words: `is declared ${own}` }
  const reached = (over.get(entityRef) ?? []).flatMap((ref) => {
    const env = declared.get(ref)
    return env === undefined ? [] : [{ ref, env }]
  })
  if (reached.length === 0) return { environments: [], words: 'declares no environment' }
  return {
    environments: [...new Set(reached.map(({ env }) => env))],
    words:
      'declares no environment and is over ' +
      reached.map(({ ref, env }) => `${ref}, declared ${env}`).join(', and '),
  }
}

/**
 * Every name the repository holds, each with every environment a document of
 * that name declares — what a request can MENTION.
 *
 * Wider than any model the engine writes, on purpose: an entity, an API, a
 * document refused whose name can be read, a document set aside that carries
 * one (a System annotated dev), and every namesake across kinds and
 * namespaces. The environments are a SET per name, never the last file's: two
 * `orders-db-prod` in two namespaces, one declared dev, are a name declared in
 * two environments, whichever file was read last.
 *
 * `unreadable` when the repository holds a refused document whose name — or
 * environment — cannot be read: its name may be in the request, and what is
 * not known is not taken to be absent (`mentioned`).
 */
export interface Namesakes {
  /** Folded name (`fold`) → the environments its documents declare. */
  readonly names: ReadonlyMap<string, readonly string[]>
  readonly unreadable: boolean
}

/** Namesakes of these documents: a name declaring no environment declares none. */
export function namesakesOf(
  documents: Iterable<{ readonly name: string; readonly env?: string | undefined }>,
  unreadable = false,
): Namesakes {
  const names = new Map<string, string[]>()
  for (const { name, env } of documents) {
    const key = fold(name)
    const environments = names.get(key) ?? []
    if (env !== undefined && !environments.includes(env)) environments.push(env)
    names.set(key, environments)
  }
  return { names, unreadable }
}

/** Namesakes of every document in these files, read by `documentNames`. */
export function namesakesIn(texts: Iterable<string>): Namesakes {
  const documents: DocumentName[] = []
  let unreadable = false
  for (const text of texts) {
    const read = documentNames(text)
    documents.push(...read.named)
    unreadable ||= read.unreadable
  }
  return namesakesOf(documents, unreadable)
}

/**
 * The environments of every name the request MENTIONS, or undefined when that
 * cannot be known.
 *
 * Mentioned is deliberately crude: the name occurs anywhere in the request,
 * both folded (`fold`), as a plain substring — no token boundary, no
 * reference form, no tail struck out. Every finer reading was bypassed: text
 * after a `:` or a `/` — a URL, a full-width colon NFKC reads as `:`, a
 * `namespace/name` — was taken for the tail of a reference and dropped, and
 * the name of another environment's entity sat there unread. A substring
 * cannot be hidden that way, and what it over-reads — `orders-db-dev` found in
 * `orders-db-dev-replica` — is a question asked, the safe direction.
 *
 * Unknown, and so undefined, when the names are not known at all, or when the
 * repository holds a refused document whose name cannot be read.
 */
function mentioned(
  namesakes: Namesakes | undefined,
  provenance: Provenance,
): readonly string[] | undefined {
  if (namesakes === undefined || namesakes.unreadable) return undefined
  const request = fold(provenance.intent)
  const environments = new Set<string>()
  for (const [name, declared] of namesakes.names) {
    if (name === '' || !request.includes(name)) continue
    for (const env of declared) environments.add(env)
  }
  return [...environments]
}

/**
 * The environment the request points at by naming what a grant is over, and
 * the things it named.
 *
 * "donne à component:default/billing-api un accès en lecture à
 * resource:default/orders-db-prod" names no environment, and asking it which
 * one was the engine ignoring what it had been told: it names the thing the
 * grant is over, and that thing DECLARES prod. The environment follows from a
 * declaration the person pointed at, which is not an inference — the same
 * reading of the repository `scopeOf` already hands a grant declaring none.
 *
 * It fails closed, and each condition is one a verifier got past before it
 * was there:
 *
 *   EVERY thing the grant is over declares an environment, and the grant
 *   hands out that one and no other (`scopeOf`). A grant over two things with
 *   one named hands out access to the other too; a thing declaring none
 *   points at none; a grant declared dev over a thing declared prod is a
 *   contradiction to ask about.
 *
 *   Every one of them is named by its REFERENCE, a whole token of the request
 *   (`echoes`): `kind:namespace/name` in full, or `kind:name` when its
 *   namespace is the default one, which is how Backstage writes that
 *   reference short. Never by its name alone: a bare name is not a reference,
 *   and two entities can carry it — "…read access to shared" names the
 *   Component declared dev as much as the database declared prod, and taking
 *   it for the one the draft's grant is over was the model's choice of
 *   environment passed off as the person's.
 *
 *   No name the request mentions (`mentioned`) is declared in another
 *   environment by any document of the repository — the consumer, a
 *   namesake of the thing in another kind or namespace, a System set aside, a
 *   document refused — and the repository holds no refused document whose
 *   name cannot be read. "orders-db-dev, not orders-db-prod" mentions both
 *   databases, and "not" is a word this reads no more than any other.
 *
 * What this costs, stated: a request naming the thing by its bare name, or
 * mentioning the entities of several environments, is asked — the safe
 * direction, and the owner's own phrases use references in full.
 *
 * Read through `requestedEnvironment` alone, by the question (`questionsOf`)
 * and by the policies (`checkPolicies`), so what stops the question is what
 * the gates hold the plan to.
 */
export interface PointedAt {
  readonly env: string
  /** What the grant is over, every one of it named by the request. */
  readonly things: readonly string[]
}

function pointedAt(
  entityRef: string,
  declared: ReadonlyMap<string, string>,
  over: GrantedOver,
  namesakes: Namesakes | undefined,
  provenance: Provenance,
): PointedAt | undefined {
  const things = over.get(entityRef) ?? []
  if (things.length === 0) return undefined
  const [env, ...others] = scopeOf(entityRef, declared, over).environments
  if (env === undefined || others.length > 0) return undefined
  if (!things.every((thing) => declared.get(thing) === env)) return undefined
  if (!things.every((thing) => referenced(provenance, thing))) return undefined
  const all = mentioned(namesakes, provenance)
  if (all === undefined || all.some((one) => one !== env)) return undefined
  return { env, things }
}

const REFERENCE = /^([^:/]+):([^:/]+)\/([^:/]+)$/u

/**
 * Does the request name this entity by its reference — in full, or as
 * `kind:name` when its namespace is the default one? A whole token either way
 * (`named`), so `resource:default/orders-db-prod-replica` names no
 * `resource:default/orders-db-prod`. Never by the name alone.
 */
function referenced(provenance: Provenance, ref: string): boolean {
  const match = REFERENCE.exec(ref)
  if (match === null) return false
  const [, kind = '', namespace = '', name = ''] = match
  return named(provenance, ref) || (namespace === 'default' && named(provenance, `${kind}:${name}`))
}

/**
 * What the request states about the environment of the grant an update
 * extends: the environments its words name, or the one it points at through
 * what the grant is over — the one definition the question (`questionsOf`)
 * and the policies (`checkPolicies`) both read.
 *
 * An environment named as a whole word (`named`) — any the repository uses,
 * or the grant's own — is what was asked, unless the request also mentions a
 * name declared in another (`mentioned`): "give billing-api read access to
 * orders-db-dev in prod" is two environments, and the draft extending the
 * prod grant, over a database nobody named, was the model's choice passed off
 * as the word's. So is a request naming two environments. Either way it is
 * treated as stating none, and asked; so is a word beside a repository whose
 * names cannot all be read. A request naming no environment may point
 * (`pointedAt`).
 *
 * `vocabulary` is the environments the repository uses. For an update alone:
 * a creation's environment is signed where it is written, and nothing here
 * changes what the signature does with it.
 */
export interface RequestedEnvironment {
  /** The environments the request's words name for this update: none, or one. */
  readonly named: readonly string[]
  /** The one it points at, when it names none. */
  readonly pointed: PointedAt | undefined
}

export function requestedEnvironment(
  entityRef: string,
  vocabulary: readonly string[],
  declared: ReadonlyMap<string, string>,
  over: GrantedOver,
  namesakes: Namesakes | undefined,
  provenance: Provenance,
): RequestedEnvironment {
  const scope = scopeOf(entityRef, declared, over).environments
  const words = [...new Set([...vocabulary, ...scope])].filter((env) => named(provenance, env))
  if (words.length === 0) {
    return { named: [], pointed: pointedAt(entityRef, declared, over, namesakes, provenance) }
  }
  const all = mentioned(namesakes, provenance)
  const stated = all === undefined ? [] : [...new Set([...words, ...all])]
  return { named: stated.length === 1 ? words : [], pointed: undefined }
}

const JOINER = /^[._-]$/u

/**
 * The environments a name says: the vocabulary's environments it spells as a
 * whole part of itself, between its ends and the `.`, `_` and `-` that join
 * its parts — the token rule `echoes` applies to a request, one level down,
 * since a name is one token of a request. Never a substring: `product-api`
 * says no `prod`, and `orders-db-preprod` no `prod` either.
 *
 * The longest wins where two overlap, so `orders-db-pre-prod` says `pre-prod`
 * and not also `prod`, when both are environments.
 *
 * What this is for is a contradiction, never a scope: a name is the model's to
 * choose (§5.2), so what it says is checked against the environment the right
 * declares and never adds to it (`checkPolicies`).
 */
export function environmentsNamedBy(name: string, environments: readonly string[]): string[] {
  const text = Array.from(fold(name))
  const found: { env: string; start: number; end: number }[] = []
  for (const env of environments) {
    const wanted = Array.from(fold(env))
    if (wanted.length === 0) continue
    for (let start = 0; start + wanted.length <= text.length; start += 1) {
      const end = start + wanted.length
      if (!wanted.every((char, offset) => text[start + offset] === char)) continue
      const before = text[start - 1]
      const after = text[end]
      if (before !== undefined && !JOINER.test(before)) continue
      if (after !== undefined && !JOINER.test(after)) continue
      found.push({ env, start, end })
    }
  }
  const outermost = found.filter(
    (one) =>
      !found.some(
        (other) =>
          other !== one &&
          other.start <= one.start &&
          one.end <= other.end &&
          other.end - other.start > one.end - one.start,
      ),
  )
  const named: string[] = []
  for (const { env } of outermost.sort((one, other) => one.start - other.start)) {
    if (!named.includes(env)) named.push(env)
  }
  return named
}
