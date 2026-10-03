/**
 * Tapes the owner decided to leave as they were recorded, each with the date of that decision in
 * docs/roadmap.md. Empty unless the owner decides otherwise (stage 6, Task 6.4.3, Step 2): a
 * scenario named here is exempt from the two staleness checks (plan-mode.test.ts's "records every
 * turn under the digest of what the provider is sent" and question-mode.test.ts's) and from
 * nothing else.
 */
export const LEFT_BY_THE_OWNER: readonly string[] = []
