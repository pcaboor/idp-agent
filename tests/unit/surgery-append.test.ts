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

  it('refuses when it cannot find the entity in the file', () => {
    // This used to return the text unchanged, citing "absent means already
    // done" — which is a rule about REMOVAL (§4.3): a line that is gone is a
    // removal that happened. An append whose target cannot be found has done
    // nothing, and the unchanged text it returned was byte-identical to "the
    // consumer is already listed": `nothing to change.`, exit 0.
    expect(() => appendSequenceItem(existing, 'ghost', 'dependencyOf', CONSUMER)).toThrow(
      SurgeryError,
    )
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

  it('refuses when the document has no spec block', () => {
    // Same falsehood as above: nothing appended, reported as already listed.
    const file = lines('---', 'kind: Resource', 'metadata:', `  name: ${ACCESS}`)
    expect(() => appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toThrow(
      /no spec block/,
    )
  })

  it('refuses a spec written as a flow mapping', () => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec: {type: database-access, owner: group:default/tiger}',
    )
    expect(() => appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toThrow(
      SurgeryError,
    )
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

describe('the shapes a catalogue file is found in', () => {
  // Every case here is a file the YAML parser reads and `validate` calls
  // conformant, so `planEdits` finds the entity in it. The surgery used to
  // find none of them, and returned the text unchanged: "already listed".
  // Exact bytes, because the only acceptable output is the input plus one line.

  const GRANT = [
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    `  name: ${ACCESS}`,
    'spec:',
    '  type: database-access',
    '  dependencyOf:',
    '    - component:default/checkout',
  ]
  const ADDED = `    - ${CONSUMER}`

  it('amends a first document that has no --- line', () => {
    const file = lines(...GRANT)
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(...GRANT, ADDED),
    )
  })

  it('amends an implicit first document behind a header comment and blank lines', () => {
    const file = lines('# owned by tiger', '', ...GRANT)
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines('# owned by tiger', '', ...GRANT, ADDED),
    )
  })

  it('amends the second document of a file whose first has no --- line', () => {
    const other = GRANT.map((line) => line.replace(ACCESS, 'other-access-prod'))
    const file = lines(...other, '', '---', ...GRANT)
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(...other, '', '---', ...GRANT, ADDED),
    )
  })

  it('keeps a byte-order mark where it was', () => {
    const file = `﻿${lines('---', ...GRANT)}`
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      `﻿${lines('---', ...GRANT, ADDED)}`,
    )
  })

  it('keeps a byte-order mark in front of an implicit first document', () => {
    const file = `﻿${lines(...GRANT)}`
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      `﻿${lines(...GRANT, ADDED)}`,
    )
  })

  it('reads a file indented by four spaces, and writes four', () => {
    const file = lines(
      '---',
      'kind: Resource',
      'metadata:',
      `    name: ${ACCESS}`,
      'spec:',
      '    type: database-access',
      '    dependencyOf:',
      '        - component:default/checkout',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'kind: Resource',
        'metadata:',
        `    name: ${ACCESS}`,
        'spec:',
        '    type: database-access',
        '    dependencyOf:',
        '        - component:default/checkout',
        `        - ${CONSUMER}`,
      ),
    )
  })

  it('opens the field at four spaces in a spec indented by four', () => {
    const file = lines(
      'kind: Resource',
      'metadata:',
      `    name: ${ACCESS}`,
      'spec:',
      '    type: database-access',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        'kind: Resource',
        'metadata:',
        `    name: ${ACCESS}`,
        'spec:',
        '    type: database-access',
        '    dependencyOf:',
        `        - ${CONSUMER}`,
      ),
    )
  })

  it('reads keys that carry a trailing comment', () => {
    const file = lines(
      '---',
      'metadata: # identity',
      `  name: ${ACCESS} # do not rename`,
      'spec: # the grant',
      '  dependencyOf: # consumers',
      '    - component:default/checkout',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata: # identity',
        `  name: ${ACCESS} # do not rename`,
        'spec: # the grant',
        '  dependencyOf: # consumers',
        '    - component:default/checkout',
        ADDED,
      ),
    )
  })

  it('reads a quoted name', () => {
    const file = lines('---', 'metadata:', `  name: "${ACCESS}"`, 'spec:', '  type: x')
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata:',
        `  name: "${ACCESS}"`,
        'spec:',
        '  type: x',
        '  dependencyOf:',
        ADDED,
      ),
    )
  })

  it('is not closed by a comment at column zero inside the spec', () => {
    // A comment is not a key. Read as one, it closed the spec above the
    // existing `dependencyOf:`, and a second key of that name was opened:
    // a duplicate key, which is not YAML any more.
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  type: database-access',
      '# who may read it',
      '  dependencyOf:',
      '    - component:default/checkout',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata:',
        `  name: ${ACCESS}`,
        'spec:',
        '  type: database-access',
        '# who may read it',
        '  dependencyOf:',
        '    - component:default/checkout',
        ADDED,
      ),
    )
  })

  it('is not closed by a comment at column zero inside metadata', () => {
    const file = lines(
      '---',
      'metadata:',
      '# the name is the identity',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf:',
      '    - component:default/checkout',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata:',
        '# the name is the identity',
        `  name: ${ACCESS}`,
        'spec:',
        '  dependencyOf:',
        '    - component:default/checkout',
        ADDED,
      ),
    )
  })

  it.each([
    ['a space before the colon', '  dependencyOf :'],
    ['double quotes', '  "dependencyOf":'],
    ['single quotes', "  'dependencyOf':"],
  ])('recognises the key written with %s, rather than opening a second one', (_, key) => {
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      key,
      '    - component:default/checkout',
      '  owner: group:default/tiger',
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        '---',
        'metadata:',
        `  name: ${ACCESS}`,
        'spec:',
        key,
        '    - component:default/checkout',
        ADDED,
        '  owner: group:default/tiger',
      ),
    )
  })

  it('refuses a key it cannot read rather than opening a second one', () => {
    // An explicit key is legal YAML and rare enough not to be worth parsing.
    // Opening `dependencyOf:` beside it would be a duplicate key.
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  ? dependencyOf',
      '  : - component:default/checkout',
    )
    expect(() => appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toThrow(
      SurgeryError,
    )
  })

  it('reads an item through its trailing comment', () => {
    // Unstripped, `- x # why` read as a different item from `x`, and the
    // consumer was listed a second time.
    const file = lines(
      '---',
      'metadata:',
      `  name: ${ACCESS}`,
      'spec:',
      '  dependencyOf:',
      `    - ${CONSUMER} # since the migration`,
    )
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(file)
  })
})

describe('a file written with CRLF line endings', () => {
  // A file saved on Windows ends every line in `\r\n`. The classifiers read
  // the `\r` as part of the line, so `---`, `metadata:` and `name:` matched
  // nothing: the document was not found, and a grant the parser read fine was
  // refused as unfindable. The added lines take the file's own ending, so the
  // result is still one line added rather than a file of mixed endings.
  const crlf = (...body: string[]) => body.join('\r\n') + '\r\n'
  const GRANT = [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    `  name: ${ACCESS}`,
    'spec:',
    '  type: database-access',
  ]

  it('appends an item, ending it the way the file ends its lines', () => {
    const file = crlf(...GRANT, '  dependencyOf:', '    - component:default/checkout')
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      crlf(...GRANT, '  dependencyOf:', '    - component:default/checkout', `    - ${CONSUMER}`),
    )
  })

  it('opens the field with the file’s ending', () => {
    expect(appendSequenceItem(crlf(...GRANT), ACCESS, 'dependencyOf', CONSUMER)).toBe(
      crlf(...GRANT, '  dependencyOf:', `    - ${CONSUMER}`),
    )
  })

  it('rewrites an empty flow sequence without losing the key line’s ending', () => {
    expect(
      appendSequenceItem(crlf(...GRANT, '  dependencyOf: []'), ACCESS, 'dependencyOf', CONSUMER),
    ).toBe(crlf(...GRANT, '  dependencyOf:', `    - ${CONSUMER}`))
  })

  it('keeps a CRLF file that ends without a line break ending without one', () => {
    const file = crlf(...GRANT).slice(0, -2)
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      crlf(...GRANT, '  dependencyOf:', `    - ${CONSUMER}`).slice(0, -2),
    )
  })

  it('finds a consumer already listed, and returns the file as it was', () => {
    const file = crlf(...GRANT, '  dependencyOf:', `    - ${CONSUMER}`)
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(file)
  })

  it('reads a file whose endings are mixed, and leaves each line’s ending as it was', () => {
    // An LF file with lines pasted from somewhere else. They keep their `\r`;
    // a file with no single ending has none to copy, so the added ones get `\n`.
    const pasted = ['metadata:\r', `  name: ${ACCESS}\r`]
    const file = lines(...GRANT.slice(0, 3), ...pasted, ...GRANT.slice(5))
    expect(appendSequenceItem(file, ACCESS, 'dependencyOf', CONSUMER)).toBe(
      lines(
        ...GRANT.slice(0, 3),
        ...pasted,
        ...GRANT.slice(5),
        '  dependencyOf:',
        `    - ${CONSUMER}`,
      ),
    )
  })
})

describe('an empty flow sequence written with blanks inside', () => {
  it('is rewritten the way `[]` is, not refused as a flow sequence', () => {
    const head = ['---', 'metadata:', `  name: ${ACCESS}`, 'spec:']
    expect(
      appendSequenceItem(lines(...head, '  dependencyOf: [ ]'), ACCESS, 'dependencyOf', CONSUMER),
    ).toBe(lines(...head, '  dependencyOf:', `    - ${CONSUMER}`))
  })
})
