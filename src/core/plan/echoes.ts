/**
 * Did the request name this value?
 *
 * The question the signature turns on: a value the user wrote is `echoed`, and
 * `echoed` is the strongest claim a value can carry — stronger than "the
 * catalogue has one", because it is their request rather than something that
 * merely exists somewhere. `environment-mismatch` asks the same question from
 * the other side. They were two copies of this function, which is two places
 * for the answer to drift, and this repository has paid for that shape before.
 *
 * **The request is in whatever language the person wrote it in.** Nothing here
 * chooses one, and nothing may: the model decides what it understands, and
 * this is the deterministic half that has to hold for all of them.
 *
 * So the word boundary is defined by SCRIPT, not by ASCII. Every identifier
 * this compares is ASCII Latin — a Backstage name, an environment, a type — so
 * a Latin letter next to one continues the word, whatever its accent, while a
 * character from another script ends it:
 *
 *   `prodüksiyon` is one Turkish word, not `prod` and a remainder
 *   `devět` is one Czech word, `devåkning` one Swedish word
 *   `prod環境` is `prod` and a Japanese word, and the request did name prod
 *
 * An `[^a-z0-9]` boundary got the first three wrong, because `ü`, `ě` and `å`
 * are not in `a-z`. Each was an environment the request never asked for,
 * signing cleanly — the escape §4.1 exists to close.
 *
 * What this does NOT do is understand the request. It answers whether a string
 * appears in it as a word, nothing more: a request that names `prod` to say
 * "anything but prod" reads the same as one asking for it. That is what the
 * diff is for, and why the merge is the act of authorisation.
 */
export function echoes(intent: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const boundary = '[^\\p{Script=Latin}0-9]'
  return new RegExp(`(^|${boundary})${escaped}(${boundary}|$)`, 'iu').test(intent)
}
