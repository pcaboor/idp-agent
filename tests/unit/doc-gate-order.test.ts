import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The five gates run `zod`, `signature`, `policy`, `recheck`, `reviewer`:
 * `repair.test.ts` asserts the order observed, not the order written. The
 * re-check moved ahead of the Reviewer, and AGENTS.md, SECURITY.md's table of
 * guarantees and three other documents went on saying Reviewer, then re-check
 * — the one guarantee in SECURITY.md contradicting the test it cites (review,
 * docs-3, security-9, architecture-12, gap-stage5-readiness-14).
 *
 * So wherever a living document lists the gates, what follows the policies is
 * the re-check. A list is found by its words, read with punctuation, arrows
 * and markup taken out: "signature" (or "provenance") then "policy" (or
 * "policies"), then the gate after them.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

const DOCUMENTS = [
  'AGENTS.md',
  'SECURITY.md',
  'README.md',
  'docs/design.md',
  'docs/stage-8-brief.md',
  'src/agents/README.md',
]

const words = (text: string): string =>
  text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .toLowerCase()

const LIST = /\b(?:signature|provenance) (?:policy|policies) (?:blind )?([\p{L}-]+)/gu

const lists = DOCUMENTS.flatMap((document) =>
  [...words(readFileSync(path.join(ROOT, document), 'utf8')).matchAll(LIST)].map((match) => ({
    document,
    next: match[1]!,
  })),
)

/**
 * Not every list is one the regex above finds: "provenance (can each value be
 * traced to a source?), policy, an independent Reviewer …, and a re-check"
 * named the gates in prose, the wrong way round, one line under a diagram that
 * had them right. So no sentence goes from the policies to the Reviewer with
 * no re-check between them, and to a re-check after. The Reviewer and the
 * re-check alone are not a list — "the Reviewer is shown what only the
 * re-check computes" is right. A sentence ends at a full stop, a question or
 * exclamation mark before a space, or a blank line.
 */
const REVIEWER_FIRST = /\bpolic(?:y|ies)\b(?:(?!\bre-?check\b).)*\breviewer\b.*\bre-?check\b/u

const reviewerFirst = DOCUMENTS.flatMap((document) =>
  readFileSync(path.join(ROOT, document), 'utf8')
    .split(/(?<=[.!?])\s+|\n\s*\n/)
    .filter((sentence) => REVIEWER_FIRST.test(words(sentence)))
    .map((sentence) => `${document}: ${sentence.replace(/\s+/g, ' ').trim()}`),
)

describe('the gate order the documents state', () => {
  it('is stated in every one of them', () => {
    // Guards the regex, not the prose: a list nobody finds is a list nobody checks.
    expect(new Set(lists.map((list) => list.document))).toEqual(new Set(DOCUMENTS))
  })

  it('puts the re-check after the policies, before the Reviewer', () => {
    const wrong = lists
      .filter(({ next }) => next !== 're-check' && next !== 'recheck')
      .map(({ document, next }) => `${document}: the policies, then ${next}`)
    expect(wrong).toEqual([])
  })

  it('names the Reviewer after the re-check, in prose too', () => {
    expect(reviewerFirst).toEqual([])
  })
})
