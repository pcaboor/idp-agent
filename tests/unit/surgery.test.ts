import { describe, expect, it } from 'vitest'
import {
  insertDocument,
  listDocumentNames,
  removeDocument,
} from '../../src/core/yaml/surgery.js'

const doc = (name: string) =>
  `apiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: ${name}\n`

const docA = doc('alpha')
const docB = doc('beta')
const docC = doc('gamma')

describe('insertDocument', () => {
  it('writes a document marker into an empty file', () => {
    expect(insertDocument('', docA)).toBe(`---\n${docA}`)
  })

  it('separates documents with exactly one blank line', () => {
    expect(insertDocument(insertDocument('', docA), docB)).toBe(`---\n${docA}\n---\n${docB}`)
  })

  it('leaves existing lines byte for byte untouched, comments included', () => {
    const withComment = `# written by hand, do not reformat\n---\n${docA}`
    const grown = insertDocument(withComment, docB)
    expect(grown.startsWith(withComment)).toBe(true)
  })
})

describe('removeDocument', () => {
  it('returns the file unchanged when the document is not there', () => {
    const file = `---\n${docA}`
    expect(removeDocument(file, 'ghost')).toBe(file)
  })

  it('removes a document and the blank line that preceded it', () => {
    const original = `---\n${docA}`
    expect(removeDocument(insertDocument(original, docB), 'beta')).toBe(original)
  })

  it('removes the first document without leaving a leading blank line', () => {
    const grown = insertDocument(`---\n${docA}`, docB)
    expect(removeDocument(grown, 'alpha')).toBe(`---\n${docB}`)
  })

  it('removes a document from the middle of three', () => {
    let file = ''
    for (const d of [docA, docB, docC]) file = insertDocument(file, d)
    expect(removeDocument(file, 'beta')).toBe(`---\n${docA}\n---\n${docC}`)
  })

  it('empties a file that held a single document', () => {
    expect(removeDocument(`---\n${docA}`, 'alpha')).toBe('')
  })

  it('is idempotent — absent means already done', () => {
    const once = removeDocument(`---\n${docA}`, 'alpha')
    expect(removeDocument(once, 'alpha')).toBe(once)
  })

  it('does not mistake a longer name that starts the same', () => {
    const file = insertDocument(insertDocument('', doc('alpha')), doc('alpha-2'))
    expect(removeDocument(file, 'alpha')).toBe(`---\n${doc('alpha-2')}`)
    expect(removeDocument(file, 'alpha-2')).toBe(`---\n${doc('alpha')}`)
  })

  it('reads the name from metadata, not from any other two-space key', () => {
    const decoy =
      'apiVersion: backstage.io/v1alpha1\n' +
      'kind: Resource\n' +
      'spec:\n' +
      '  name: decoy\n' +
      'metadata:\n' +
      '  name: real\n'
    const file = insertDocument('', decoy)
    expect(removeDocument(file, 'decoy')).toBe(file)
    expect(removeDocument(file, 'real')).toBe('')
  })

  it('takes a header comment with the document it introduces', () => {
    const file = `---\n${docA}\n# why beta exists\n---\n${docB}`
    expect(removeDocument(file, 'beta')).toBe(`---\n${docA}`)
  })

  it('keeps a header comment that introduces a neighbouring document', () => {
    const file = `---\n${docA}\n# why beta exists\n---\n${docB}`
    expect(removeDocument(file, 'alpha')).toBe(`# why beta exists\n---\n${docB}`)
  })
})

describe('listDocumentNames', () => {
  it('lists names in document order', () => {
    let file = ''
    for (const d of [docA, docB, docC]) file = insertDocument(file, d)
    expect(listDocumentNames(file)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns nothing for an empty file', () => {
    expect(listDocumentNames('')).toEqual([])
  })
})

describe('the same documents, whichever function is looking', () => {
  // `init` asks `listDocumentNames` whether an entity is already declared, and
  // `removeDocument` finds its target the same way `appendSequenceItem` does.
  // A document one of them can see and another cannot is a file where the
  // three give contradicting answers about the same bytes.

  it('lists a first document that has no --- line', () => {
    expect(listDocumentNames(`${docA}\n---\n${docB}`)).toEqual(['alpha', 'beta'])
  })

  it('lists behind a byte-order mark, a header comment, and four-space indentation', () => {
    const file =
      '﻿# hand written\n' +
      'kind: Resource\n' +
      'metadata: # identity\n' +
      '    name: alpha # kept\n'
    expect(listDocumentNames(file)).toEqual(['alpha'])
  })

  it('does not read a directive or a comment above the first --- as a document', () => {
    expect(listDocumentNames(`%YAML 1.2\n# note\n---\n${docA}`)).toEqual(['alpha'])
  })

  it('removes a first document that has no --- line', () => {
    expect(removeDocument(`${docA}\n---\n${docB}`, 'alpha')).toBe(`---\n${docB}`)
  })

  it('removes the document after an implicit first one, and the blank line before it', () => {
    expect(removeDocument(`${docA}\n---\n${docB}`, 'beta')).toBe(docA)
  })

  it('keeps a file header that a blank line separates from the removed document', () => {
    expect(removeDocument(`# licence\n\n${docA}\n---\n${docB}`, 'alpha')).toBe(
      `# licence\n\n---\n${docB}`,
    )
  })

  it('keeps a byte-order mark when the first document goes', () => {
    expect(removeDocument(`﻿---\n${docA}\n---\n${docB}`, 'alpha')).toBe(`﻿---\n${docB}`)
  })
})

describe('a file written with CRLF line endings', () => {
  // `init` asks `listDocumentNames` whether a catalog-info.yaml already
  // declares the component. Blind to `\r\n`, it answered no, and a second
  // document of the same name was proposed.
  const crlf = (text: string) => text.replaceAll('\n', '\r\n')

  it('lists its documents', () => {
    expect(listDocumentNames(crlf(`---\n${docA}\n---\n${docB}`))).toEqual(['alpha', 'beta'])
  })

  it('lists an implicit first document', () => {
    expect(listDocumentNames(crlf(`${docA}\n---\n${docB}`))).toEqual(['alpha', 'beta'])
  })

  it('removes a document and the blank line that preceded it', () => {
    expect(removeDocument(crlf(`---\n${docA}\n---\n${docB}`), 'beta')).toBe(crlf(`---\n${docA}`))
  })

  it('inserts a document with the file’s own line endings', () => {
    expect(insertDocument(crlf(`---\n${docA}`), docB)).toBe(crlf(`---\n${docA}\n---\n${docB}`))
  })

  it('removes what it inserted, byte for byte', () => {
    const file = crlf(`# hand written\n---\n${docA}`)
    expect(removeDocument(insertDocument(file, docB), 'beta')).toBe(file)
  })
})
