import { echoes } from './echoes.js'

/**
 * What the user stated, and the one definition of it every gate reads.
 *
 * Three gates ask whether a value is the user's: the derivation keeps a right's
 * owner the user stated, the signature classifies a value the user stated as
 * `echoed`, and the environment policies measure a plan against the
 * environments the user stated. Each used to hold its own idea of it. The
 * signature counted an answer typed at a prompt; the other two read only the
 * request. So an owner the user answered was withdrawn on the next pass and
 * asked again until the rounds ran out, and an environment the user answered
 * did not count as asked — a plan refused with `dev` typed into the request
 * passed with `dev` typed at a prompt.
 *
 * **The words live here, and nowhere else is read for them.** `intent` is the
 * request as the caller that read it holds it, and no gate measures a value
 * against `plan.intent`: that field arrives with the plan, from whoever drafted
 * it, and a drafter that wrote its own could name the owner it wanted and have
 * every gate vouch for it. `plan.intent` is still imposed by the callers, but
 * as the record a report carries, not as evidence.
 *
 * **An answer is indexed by the field it answered.** A value typed at a prompt
 * is the user's word about THAT question: answering one grant's level `read`
 * says nothing about another grant's level, and answering an owner says
 * nothing about a lifecycle spelled the same way. A set of answered values
 * vouched for the value wherever it appeared.
 *
 * What this does NOT cover:
 *
 *   - An answer's path is the plan's own index, so `answers` describes ONE
 *     plan. The callers record each answer by what it is about — the entity
 *     its operation declares or amends, and the field — and `reapplyAnswers`
 *     builds this map for every plan a gate judges, a redraft included: an
 *     answer sits at the path its entity has in THAT plan, and nowhere else.
 *     What is still keyed by a bare path is what has no entity to follow — an
 *     answer about an operation with no name to know it by, or about an entity
 *     two operations of its plan share, and answers a caller vouches for at a
 *     fixed path (`init`'s inspection,
 *     `RepairInput.provenance`). Those vouch for the same value at the same
 *     field of whatever operation sits there. The value still has to be the
 *     one typed.
 *   - It says what the user stated, never whether it is right. The diff is
 *     where a person reads it, and the merge is the act of authorisation.
 */
export interface Provenance {
  /** The request, from the caller that read it. */
  readonly intent: string
  /**
   * Whose words `intent` is, which decides whether they vouch for anything.
   *
   * `echoed` rests entirely on the intent being a person's own sentence. `init`
   * composes one out of what its inspection read, and measured against that, a
   * Component named `repository-files` signed echoed on two words the engine
   * wrote about itself. An engine's sentence vouches for nothing; what an
   * inspection legitimately establishes arrives as `answers`, at the fields it
   * establishes.
   */
  readonly wordsOf: 'user' | 'engine'
  /** Dotted path — the form a question carries — to the value given for it. */
  readonly answers: ReadonlyMap<string, string>
}

/**
 * Did the request name this value? Only a person's request can; see `wordsOf`.
 *
 * Exported apart from `stated` for the two readers that ask about the words
 * alone: a composed name vouched for segment by segment, and the environments
 * a request names for every operation of a plan at once.
 */
export const named = (provenance: Provenance, value: string): boolean =>
  provenance.wordsOf === 'user' && echoes(provenance.intent, value)

/** Was exactly this value given for exactly this field? */
export const answered = (provenance: Provenance, path: string, value: string): boolean =>
  provenance.answers.get(path) === value

/**
 * Did the user state this value at this field — in the request, or answering
 * for it? The question the derivation asks of an owner, the signature of most
 * leaves, and the policies of an operation's own environment. The two
 * exceptions compose the halves on purpose: a level only an answer vouches for
 * (`answered`), and a composed name only the request's words can (`named`).
 */
export const stated = (provenance: Provenance, path: string, value: string): boolean =>
  named(provenance, value) || answered(provenance, path, value)

/**
 * Nothing stated: no words that vouch, no answers. What a signature is measured
 * against when its caller names no provenance — every value it does not
 * otherwise vouch for becomes a question, which is the safe direction.
 *
 * A function, never a shared constant: `Object.freeze` does not freeze a
 * Map's entries and `ReadonlyMap` is a promise only the type system keeps, so
 * one default that a caller cast and wrote to would vouch for every default
 * call after it.
 */
export const nothingStated = (): Provenance => ({
  intent: '',
  wordsOf: 'engine',
  answers: new Map<string, string>(),
})
