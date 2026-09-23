import { describe, expect, it } from 'vitest'
import { plain } from '../../src/cli/render/plain.js'

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
