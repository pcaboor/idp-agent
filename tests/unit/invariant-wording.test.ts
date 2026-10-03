import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The invariant stage 6 built, in the owner's words, and nowhere paraphrased.
 *
 * On GitHub the right to push a branch is the right that merges, so the
 * sentence stage 5 carried — one token per capability, the token that opens a
 * merge request cannot merge it — cannot be delivered by any credential's
 * scope. The owner reworded the invariant on 2026-10-01 (design §4.2), and a
 * document that states it in other words is read as stating another rule. So
 * each document that states it is held to the words themselves, and none may
 * still state the old sentence as a guarantee: only in a sentence, a list item's
 * sentence or a table row that says ADR-0015 replaced it.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

/** The owner's words (the decision of 2026-10-01, design §4.2), stated once here and nowhere else in tests/. */
const INVARIANT =
  'idpa never merges and never writes to the base: it opens a pull request, and the ' +
  "base's rules decide who may merge it"

const STATING = [
  'docs/design.md',
  'AGENTS.md',
  'SECURITY.md',
  'docs/adr/0015-a-submission-is-a-pull-request-the-rules-hold.md',
  'docs/submitting.md',
]

const SWEPT = [...STATING, 'README.md', 'docs/adr/0006-the-merge-request-is-authorisation.md']

/** The words of a stage-5 guarantee no GitHub credential can deliver. */
const REPLACED = [/one token per capability/i, /the token that opens a merge request cannot merge it/i]

const read = (document: string): string => readFileSync(path.join(ROOT, document), 'utf8')

/** Emphasis removed and every run of white space one space, so a line break or a bold run is no difference. */
const flat = (text: string): string => text.replaceAll('*', '').replace(/\s+/g, ' ')

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The invariant word for word, its first letter in either case, as a sentence may begin with it. */
const STATED = new RegExp(
  `[${INVARIANT[0]!.toLowerCase()}${INVARIANT[0]!.toUpperCase()}]${escaped(INVARIANT.slice(1))}`,
)

const paragraphs = (text: string): string[] => text.split(/\n\s*\n/)

/** A line that begins a block of its own: a table row, a list item or a heading. */
const OPENS = /^\s*(\||[-*+]\s|\d+[.)]\s|#)/

const isRow = (block: string): boolean => block.trimStart().startsWith('|')

/**
 * The units a replaced sentence is judged in: each table row, and each sentence of a list item
 * or of prose. Never the paragraph: a table or a list is one paragraph, thousands of characters
 * long, and one row citing ADR-0015 would vouch for every other.
 */
const units = (text: string): string[] =>
  paragraphs(text).flatMap((paragraph) => {
    const blocks: string[] = []
    for (const line of paragraph.split('\n')) {
      if (blocks.length === 0 || OPENS.test(line) || isRow(blocks.at(-1)!)) blocks.push(line)
      else blocks[blocks.length - 1] += `\n${line}`
    }
    return blocks.flatMap((block) =>
      isRow(block) ? [flat(block).trim()] : flat(block).trim().split(/(?<=[.!?])\s+(?=[^a-z])/),
    )
  })

/** A unit may name a replaced sentence only to say that ADR-0015 replaced it. */
const saysReplaced = (unit: string): boolean => unit.includes('ADR-0015') && /\breplac(e|es|ed|ing)\b/i.test(unit)

/** Every unit of a document that states a replaced sentence as a guarantee. */
const guarantees = (text: string): string[] =>
  units(text)
    .filter((unit) => REPLACED.some((words) => words.test(unit)))
    .filter((unit) => !saysReplaced(unit))

describe('the invariant, in the owner’s words', () => {
  it.each(STATING)('%s states it word for word', (document) => {
    expect(flat(read(document))).toMatch(STATED)
  })

  it('no document states "one token per capability" or "the token that opens a merge request cannot merge it" as a guarantee', () => {
    const stated = SWEPT.flatMap((document) =>
      guarantees(read(document)).map((unit) => `${document}: ${unit.slice(0, 120)}`),
    )
    expect(stated).toEqual([])
  })

  it('reads a table row and a list item on their own, whatever else their block cites', () => {
    const table = [
      '| Guaranteed | Held by |',
      '|---|---|',
      '| ADR-0015: the pull request is always opened | `tests/unit/github-forge.test.ts` |',
      '| One token per capability: the token that opens a merge request cannot merge it | `tests/unit/merge-refused.test.ts` |',
    ].join('\n')
    const list = [
      '- The base\'s rules decide who may merge it (ADR-0015).',
      '- One token per capability: the token that opens a merge request cannot merge it, and a',
      '  test asserts that this action *fails*.',
    ].join('\n')
    expect(guarantees(table)).toEqual([
      '| One token per capability: the token that opens a merge request cannot merge it | `tests/unit/merge-refused.test.ts` |',
    ])
    expect(guarantees(list)).toEqual([
      '- One token per capability: the token that opens a merge request cannot merge it, and a test asserts that this action fails.',
    ])
    expect(guarantees('"One token per capability", stage 5\'s sentence, cannot be delivered, and ADR-0015 replaces it.')).toEqual([])
    expect(guarantees('One token per capability holds. See ADR-0015.')).toEqual(['One token per capability holds.'])
  })

  it('reads a sentence that begins with it, and refuses one that paraphrases it', () => {
    expect(flat(`**Idpa never merges and never writes to the base: it opens a pull request,\nand the base's rules decide who may merge it.**`)).toMatch(STATED)
    expect(flat("idpa never merges: it opens a pull request, and the base's rules decide who may merge it")).not.toMatch(STATED)
  })
})
