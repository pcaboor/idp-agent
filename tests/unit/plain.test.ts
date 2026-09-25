import { describe, expect, it } from 'vitest'
import { inert, inertLine, oneLine, plain, visible } from '../../src/cli/render/plain.js'

/**
 * Written as escapes throughout, never as literal control bytes: a file
 * carrying a real ESC renders as a blank in every diff and review that reads
 * it, which is the whole reason this module exists.
 */
const ESC = '\u001B'

describe('plain', () => {
  it('removes a CSI sequence, keeping the text around it', () => {
    expect(plain(`${ESC}[31mred${ESC}[0m`)).toBe('red')
  })

  it('removes the clear-screen and cursor-home pair a fake diff opens with', () => {
    // The shape the audit demonstrated: clear the screen, go home, print a
    // plausible diff under the tool's own closing line.
    const payload = `${ESC}[2J${ESC}[H+++ b/dependencies/access/fake.yml`
    expect(plain(payload)).toBe('+++ b/dependencies/access/fake.yml')
  })

  it('removes an OSC sequence, whichever terminator it uses', () => {
    // A window title is the mild version. OSC 8 is a hyperlink, and OSC 52
    // writes the system clipboard on terminals that allow it.
    expect(plain(`${ESC}]0;title\u0007after`)).toBe('after')
    expect(plain(`${ESC}]8;;https://example.com${ESC}\\link`)).toBe('link')
  })

  it('removes a bare ESC, which is what a truncated sequence leaves behind', () => {
    // `oneLine` cuts at 200 characters, so a sequence can arrive half-written
    // and the half that remains must not reach a terminal either.
    expect(plain(`before${ESC}`)).toBe('before')
    expect(plain(`${ESC}[31`)).toBe('')
  })

  it('removes C0 controls that move a cursor or ring a bell', () => {
    expect(plain('a\u0008b')).toBe('ab')
    expect(plain('a\u0007b')).toBe('ab')
    expect(plain('a\rb')).toBe('ab')
  })

  it('removes C1 controls, including the 8-bit CSI introducer', () => {
    // A terminal in 8-bit mode reads U+009B as CSI, so stripping only the
    // two-byte form would leave the same attack in another encoding.
    expect(plain('a\u009Bb')).toBe('ab')
    expect(plain('a\u0085b')).toBe('ab')
  })

  it('keeps newlines and tabs, which the questions are laid out with', () => {
    // `renderQuestions` prints a path and its reason on two lines. Stripping
    // every control would flatten the one output this exists to protect.
    expect(plain('one\ntwo\tthree')).toBe('one\ntwo\tthree')
  })

  it('leaves ordinary text alone, in any script', () => {
    for (const text of ['prod', 'accès en lecture', 'prod環境', 'доступ', 'قراءة']) {
      expect(plain(text)).toBe(text)
    }
  })

  it('is idempotent, so applying it twice is never a bug', () => {
    const once = plain(`${ESC}[2Jx`)
    expect(plain(once)).toBe(once)
  })
})

describe('oneLine', () => {
  it('flattens every run of whitespace to one space, and trims the ends', () => {
    expect(oneLine('  The place to be,\n\tfor great   artists \n')).toBe(
      'The place to be, for great artists',
    )
  })

  it('removes what a terminal obeys before it cuts, so no half sequence survives', () => {
    const text = `${'a'.repeat(9)}${ESC}[31mred`
    expect(oneLine(text, 10)).toBe('aaaaaaaaar…')
    expect(oneLine(`${ESC}]52;c;ZXZpbA==\u0007copied`)).toBe('copied')
  })

  it('cuts at the bound it is given, 200 by default, and says it cut', () => {
    expect(oneLine('x'.repeat(200))).toBe('x'.repeat(200))
    expect(oneLine('x'.repeat(201))).toBe(`${'x'.repeat(200)}…`)
    expect(oneLine('abcdef', 3)).toBe('abc…')
    expect(oneLine('abc', 3)).toBe('abc')
  })
})

describe('visible', () => {
  it('spells out what plain would remove, instead of removing it', () => {
    expect(visible(`a${ESC}[2Jb`)).toBe('a\\u001b[2Jb')
    expect(visible('a\u009Bb\u007Fc')).toBe('a\\u009bb\\u007fc')
    expect(visible('a\u0007b')).toBe('a\\u0007b')
  })

  it('spells out the bidi overrides and isolates, and leaves the marks', () => {
    // U+202E is what makes `lmy.evil` read `live.yml`. The marks move no run
    // of text, and right-to-left writing is typed with them.
    expect(visible('a\u202Eb\u2066c\u2069')).toBe('a\\u202eb\\u2066c\\u2069')
    expect(visible('\u200F\u05E9\u05DC\u05D5\u05DD\u200E')).toBe(
      '\u200F\u05E9\u05DC\u05D5\u05DD\u200E',
    )
  })

  it('keeps newline, tab and the carriage return that ends a line', () => {
    expect(visible('one\ttwo\r\nthree\n')).toBe('one\ttwo\r\nthree\n')
    // One in the middle of a line returns the cursor over what is printed.
    expect(visible('safe\rforged')).toBe('safe\\u000dforged')
  })

  it('leaves JSON as JSON, and as the same value', () => {
    const value = { owner: `x${ESC}]52;c;ZXZpbA==\u0007\u009B\u202Ey\u007F` }
    const text = visible(JSON.stringify(value, null, 2))
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E]/)
    expect(JSON.parse(text)).toEqual(value)
  })

  it('leaves ordinary text alone, in any script', () => {
    for (const text of ['prod', 'accès en lecture', 'prod環境', 'доступ', 'قراءة']) {
      expect(visible(text)).toBe(text)
    }
  })
})

describe('inertLine and inert', () => {
  it('flatten and clean like oneLine, and spell out the overrides', () => {
    expect(inertLine(`first\n${ESC}[2Jsecond\u202Ethird`)).toBe('first second\\u202ethird')
    expect(inertLine('x'.repeat(1_001))).toBe(`${'x'.repeat(1_000)}…`)
    expect(inertLine('abcdef', 3)).toBe('abc…')
  })

  it('keeps the lines of a message it cleans whole', () => {
    expect(inert(`one\n${ESC}]0;title\u0007two\u202E`)).toBe('one\ntwo\\u202e')
  })
})
