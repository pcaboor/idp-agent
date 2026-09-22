import { describe, expect, it } from 'vitest'
import { appendSequenceItem, SurgeryError } from '../../src/core/yaml/surgery.js'

const NEWLINE = '\n'

/**
 * Whole lines gained and lost, the way a reviewer reads a diff. Counting rather
 * than comparing position by position: an implementation that reparsed and
 * re-emitted would keep every value and still show up here, because every line
 * it re-indented or re-quoted counts as one removed and one added.
 */
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const tally = (text: string): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const line of text.split(NEWLINE)) counts.set(line, (counts.get(line) ?? 0) + 1)
    return counts
  }
  const b = tally(before)
  const a = tally(after)
  const added: string[] = []
  const removed: string[] = []
  for (const [line, count] of a) {
    for (let i = 0; i < count - (b.get(line) ?? 0); i += 1) added.push(line)
  }
  for (const [line, count] of b) {
    for (let i = 0; i < count - (a.get(line) ?? 0); i += 1) removed.push(line)
  }
  return { added, removed }
}

const lines = (...body: string[]) => body.join(NEWLINE) + NEWLINE

const existing = lines(
  '---',
  'apiVersion: backstage.io/v1alpha1',
  'kind: Resource',
  'metadata:',
  '  name: billing-api-orders-db-prod',
  'spec:',
  '  type: database-access',
  '  owner: group:default/tiger',
  '  dependsOn:',
  '    - resource:default/orders-db-prod',
  '  dependencyOf:',
  '    - component:default/checkout',
)

const ACCESS = 'billing-api-orders-db-prod'
const CONSUMER = 'component:default/billing-api'

describe('appendSequenceItem', () => {
  it('adds a consumer as an added line, not a rewritten document', () => {
    // Textual surgery, never a reparse (§4.3): a reviewer must see one line
    // added, not a file reformatted. A remove-then-reinsert passes a
    // round-trip test and fails a reviewer.
    const after = appendSequenceItem(existing, ACCESS, 'dependencyOf', CONSUMER)
    const { added, removed } = lineDiff(existing, after)
    expect(removed).toEqual([])
    expect(added).toEqual(['    - component:default/billing-api'])
  })

  it('appends after the last item, leaving the keys that follow in place', () => {
    const file = lines(
      '---',
      'kind: Resource',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf:',
      '    - component:default/checkout',
      '  owner: group:default/tiger',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'kind: Resource',
        'metadata:',
        `  name: ${ACCESS}`,
        'spec:',
        '  dependencyOf:',
        '    - component:default/checkout',
        `    - ${CONSUMER}`,
        '  owner: group:default/tiger',
      ),
    )
  })

  it('matches the indentation the sequence already uses, not two spaces', () => {
    // A block sequence may sit at its key's own indentation. Copying what is
    // there keeps the added line invisible in review; guessing would re-indent
    // the sequence or, worse, leave two styles in one file.
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf:',
      '  - component:default/checkout',
    )
    const { added, removed } = lineDiff(file, appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER))
    expect(removed).toEqual([])
    expect(added).toEqual([`  - ${CONSUMER}`])
  })

  it('turns an empty flow sequence into a block sequence', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  owner: group:default/tiger',
      '  dependencyOf: []',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata:',
        `  name: ${ACCESS}`,
        'spec:',
        '  owner: group:default/tiger',
        '  dependencyOf:',
        `    - ${CONSUMER}`,
      ),
    )
  })

  it('opens the field at the end of the spec block when it is absent', () => {
    const file = lines(
      '---',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  type: database-access',
      '  owner: group:default/tiger',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        `  name: ${ACCESS}`,
        'spec:',
        '  type: database-access',
        '  owner: group:default/tiger',
        '  dependencyOf:',
        `    - ${CONSUMER}`,
      ),
    )
  })

  it('opens the field before the blank line that closed the document', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  owner: group:default/tiger',
      '',
      '---',
      'metadata:',
      '  name: other',
      'spec:',
      '  owner: group:default/tiger',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata:',
        `  name: ${ACCESS}`,
        'spec:',
        '  owner: group:default/tiger',
        '  dependencyOf:',
        `    - ${CONSUMER}`,
        '',
        '---',
        'metadata:',
        '  name: other',
        'spec:',
        '  owner: group:default/tiger',
      ),
    )
  })

  it('returns the text unchanged when the entity is not in the file', () => {
    // Absent means already done: a branch may be replayed (design 4.3).
    expect(appendSequenceItem(existing, 'ghost', 'dependencyOf', CONSUMER)).toBe(existing)
  })

  it('returns the text unchanged when the item is already in the sequence', () => {
    expect(appendSequenceItem(existing, ACCESS, 'dependencyOf', 'component:default/checkout')).toBe(
      existing,
    )
  })

  it('is idempotent — appending twice adds one line', () => {
    const once = appendSequenceItem(existing, ACCESS, 'dependencyOf', CONSUMER)
    expect(appendSequenceItem(once, ACCESS, 'dependencyOf', CONSUMER)).toBe(once)
  })

  it('reads an existing item through its quotes', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf:',
      `    - '${CONSUMER}'`,
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(file)
  })

  it('appends under a key that carries a trailing comment', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf: # who reads this database',
      '    - component:default/checkout',
    )
    const { added, removed } = lineDiff(file, appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER))
    expect(removed).toEqual([])
    expect(added).toEqual([`    - ${CONSUMER}`])
  })

  it('refuses a non-empty flow sequence rather than returning the text unchanged', () => {
    // Splitting `[a, b]` correctly means parsing flow syntax — quotes, commas,
    // nesting — and this module's whole premise is that it never parses. But
    // returning the text unchanged is byte-identical to "already listed", so a
    // plan that grants nothing would preview as "nothing to change", exit 0.
    // A caller can catch a refusal and name the operation; it cannot catch
    // silence.
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf: [component:default/checkout]',
    )
    expect(() => appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toThrow(SurgeryError)
  })

  it('returns the text unchanged when the document has no spec block', () => {
    const file = lines('---', 'kind: Resource', 'metadata:', `  name: ${ACCESS}`)
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(file)
  })

  it('reads the field from spec, not from a key of the same name elsewhere', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      '  dependencyOf:',
      '    - component:default/decoy',
      'spec:',
      '  owner: group:default/tiger',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata:',
        `  name: ${ACCESS}`,
        '  dependencyOf:',
        '    - component:default/decoy',
        'spec:',
        '  owner: group:default/tiger',
        '  dependencyOf:',
        `    - ${CONSUMER}`,
      ),
    )
  })

  it('does not mistake a key of the same name nested deeper in the spec', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  overrides:',
      '    dependencyOf:',
      '      - component:default/decoy',
      '  dependencyOf:',
      '    - component:default/checkout',
    )
    const { added, removed } = lineDiff(file, appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER))
    expect(removed).toEqual([])
    expect(added).toEqual([`    - ${CONSUMER}`])
  })

  it('touches only the document it was aimed at', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf:',
      '    - component:default/checkout',
      '',
      '---',
      'metadata:',
      '  name: other-access-prod',
      'spec:',
      '  dependencyOf:',
      '    - component:default/checkout',
    )
    const after = appendSequenceItem(file, 'other-access-prod', 'dependencyOf', CONSUMER)
    expect(after).toBe(
      lines(
        '---',
        'metadata:',
        `  name: ${ACCESS}`,
        'spec:',
        '  dependencyOf:',
        '    - component:default/checkout',
        '',
        '---',
        'metadata:',
        '  name: other-access-prod',
        'spec:',
        '  dependencyOf:',
        '    - component:default/checkout',
        `    - ${CONSUMER}`,
      ),
    )
  })

  it('keeps a file that ends without a newline ending without one', () => {
    const file = '---\nmetadata:\n  name: ' + ACCESS + '\nspec:\n  dependencyOf:\n    - a:b/c'
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      file + NEWLINE + `    - ${CONSUMER}`,
    )
  })
})

describe('shapes a hand-written file can be in', () => {
  // The repository tolerates files nobody's serialiser wrote — that is what
  // arbitraryHandWrittenFile exists for in the invariants. A surgery that
  // silently declines on one of those shapes is worse than one that refuses:
  // "unchanged" is the same answer as "already listed".

  const withComment = `---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: billing-api-orders-db-prod
spec:
  type: database-access
  owner: group:default/tiger
  dependencyOf:
    # the ones we know about
    - component:default/billing-api
`

  it('appends below a comment sitting between the key and its items', () => {
    const after = appendSequenceItem(
      withComment,
      'billing-api-orders-db-prod',
      'dependencyOf',
      'component:default/invoicing',
    )

    const lines = after.split('\n')
    const comment = lines.findIndex((line) => line.includes('# the ones'))
    const existing = lines.findIndex((line) => line.includes('- component:default/billing-api'))
    const added = lines.findIndex((line) => line.includes('invoicing'))

    // Appended, not prepended: the new consumer goes below the ones there.
    expect(added).toBeGreaterThan(existing)
    expect(existing).toBeGreaterThan(comment)
  })
})
