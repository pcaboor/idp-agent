import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A character a reviewer cannot see is a character a reviewer cannot review.
 * The bidi embeddings, override and isolates (U+202A–U+202E, U+2066–U+2069)
 * reorder what an editor shows without changing what the compiler reads —
 * the trojan-source attack — and the zero-widths, joiners and marks
 * (U+200B–U+200F, U+2060–U+2064, U+061C, the soft hyphen U+00AD and the
 * byte-order mark U+FEFF) split or join a word nobody sees split. Both kinds
 * turned up raw in the very code written to strip them from a commit message,
 * and in tests that meant them as inputs.
 *
 * So the source spells every one of them as an escape — `\u202E`, or
 * `String.fromCodePoint` — and the diff a reviewer reads shows what the file
 * holds. The pattern below is written the same way, or this file would fail
 * itself.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

const HIDDEN = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full)
    return [full]
  })

const SOURCES = ['src', 'tests', 'scripts'].flatMap((dir) => files(path.join(ROOT, dir)))

describe('hidden controls in the source', () => {
  it('reads the trees it is about', () => {
    // An empty read passes every filter: a moved folder must not leave this green.
    expect(SOURCES.some((file) => file.endsWith(path.join('src', 'core', 'plan', 'sign.ts')))).toBe(
      true,
    )
    expect(SOURCES.some((file) => file.endsWith(path.join('tests', 'unit', 'echoes.test.ts')))).toBe(
      true,
    )
  })

  it('holds no raw bidi control, zero-width, joiner or mark — each is written as an escape', () => {
    const found = SOURCES.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          [...line.matchAll(HIDDEN)].map(
            (match) =>
              `${path.relative(ROOT, file)}:${index + 1} U+${match[0]
                .codePointAt(0)!
                .toString(16)
                .toUpperCase()
                .padStart(4, '0')}`,
          ),
        ),
    )
    expect(found).toEqual([])
  })
})
