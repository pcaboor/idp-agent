import { describe, expect, it } from 'vitest'
import { renderUnifiedDiff, type FileEdit } from '../../src/core/diff/unified.js'

/** A file of `count` numbered lines, `line-1` … `line-<count>`, newline-terminated. */
const numbered = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line-${index + 1}\n`).join('')

/** The same file with one line replaced, by 1-based line number. */
const changedAt = (count: number, ...lines: number[]): string => {
  const changed = new Set(lines)
  return Array.from(
    { length: count },
    (_, index) => `line-${index + 1}${changed.has(index + 1) ? '-changed' : ''}\n`,
  ).join('')
}

const headers = (diff: string): string[] => diff.split('\n').filter((line) => line.startsWith('@@'))

describe('renderUnifiedDiff', () => {
  it('returns the empty string for no edits at all', () => {
    expect(renderUnifiedDiff([])).toBe('')
  })

  it('renders a creation against /dev/null', () => {
    const edit: FileEdit = {
      path: 'catalog/resources/billing-db.yml',
      before: undefined,
      after: 'apiVersion: backstage.io/v1alpha1\nkind: Resource\nname: billing-db\n',
    }
    expect(renderUnifiedDiff([edit])).toBe(
      [
        '--- /dev/null',
        '+++ b/catalog/resources/billing-db.yml',
        '@@ -0,0 +1,3 @@',
        '+apiVersion: backstage.io/v1alpha1',
        '+kind: Resource',
        '+name: billing-db',
        '',
      ].join('\n'),
    )
  })

  it('renders a pure addition with its surrounding context', () => {
    const diff = renderUnifiedDiff([{ path: 'f.txt', before: 'a\nb\nc\n', after: 'a\nb\nnew\nc\n' }])
    expect(diff).toBe(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,4 @@', ' a', ' b', '+new', ' c', ''].join('\n'),
    )
  })

  it('renders a pure removal with its surrounding context', () => {
    const diff = renderUnifiedDiff([{ path: 'f.txt', before: 'a\nb\nc\n', after: 'a\nc\n' }])
    expect(diff).toBe(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,2 @@', ' a', '-b', ' c', ''].join('\n'),
    )
  })

  it('numbers a whole-file emptying as a zero-length right side', () => {
    const diff = renderUnifiedDiff([{ path: 'f.txt', before: 'a\nb\n', after: '' }])
    expect(diff).toBe(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n'),
    )
  })

  it('trims a long file to three lines of context and numbers the hunk from there', () => {
    const diff = renderUnifiedDiff([
      { path: 'long.txt', before: numbered(20), after: changedAt(20, 10) },
    ])
    expect(diff).toBe(
      [
        '--- a/long.txt',
        '+++ b/long.txt',
        '@@ -7,7 +7,7 @@',
        ' line-7',
        ' line-8',
        ' line-9',
        '-line-10',
        '+line-10-changed',
        ' line-11',
        ' line-12',
        ' line-13',
        '',
      ].join('\n'),
    )
  })

  it('honours an explicit context width', () => {
    const diff = renderUnifiedDiff(
      [{ path: 'long.txt', before: numbered(20), after: changedAt(20, 10) }],
      { context: 1 },
    )
    expect(diff).toBe(
      [
        '--- a/long.txt',
        '+++ b/long.txt',
        '@@ -9,3 +9,3 @@',
        ' line-9',
        '-line-10',
        '+line-10-changed',
        ' line-11',
        '',
      ].join('\n'),
    )
  })

  it('emits a bare changed line when the context is zero', () => {
    const diff = renderUnifiedDiff(
      [{ path: 'long.txt', before: numbered(20), after: changedAt(20, 10) }],
      { context: 0 },
    )
    expect(diff).toBe(
      [
        '--- a/long.txt',
        '+++ b/long.txt',
        '@@ -10,1 +10,1 @@',
        '-line-10',
        '+line-10-changed',
        '',
      ].join('\n'),
    )
  })

  it('splits two changes that are far apart into two hunks, each correctly numbered', () => {
    const diff = renderUnifiedDiff([
      { path: 'long.txt', before: numbered(30), after: changedAt(30, 5, 25) },
    ])
    expect(diff).toBe(
      [
        '--- a/long.txt',
        '+++ b/long.txt',
        '@@ -2,7 +2,7 @@',
        ' line-2',
        ' line-3',
        ' line-4',
        '-line-5',
        '+line-5-changed',
        ' line-6',
        ' line-7',
        ' line-8',
        '@@ -22,7 +22,7 @@',
        ' line-22',
        ' line-23',
        ' line-24',
        '-line-25',
        '+line-25-changed',
        ' line-26',
        ' line-27',
        ' line-28',
        '',
      ].join('\n'),
    )
  })

  it('merges two changes whose context windows touch into a single hunk', () => {
    // Lines 5 and 12 change: six unchanged lines separate them, exactly the
    // 2 * context that the two windows cover between them.
    const diff = renderUnifiedDiff([
      { path: 'long.txt', before: numbered(20), after: changedAt(20, 5, 12) },
    ])
    expect(headers(diff)).toEqual(['@@ -2,14 +2,14 @@'])
    expect(diff).toBe(
      [
        '--- a/long.txt',
        '+++ b/long.txt',
        '@@ -2,14 +2,14 @@',
        ' line-2',
        ' line-3',
        ' line-4',
        '-line-5',
        '+line-5-changed',
        ' line-6',
        ' line-7',
        ' line-8',
        ' line-9',
        ' line-10',
        ' line-11',
        '-line-12',
        '+line-12-changed',
        ' line-13',
        ' line-14',
        ' line-15',
        '',
      ].join('\n'),
    )
  })

  it('keeps two hunks when one more unchanged line separates the changes', () => {
    // One line further apart than the test above: the windows no longer touch.
    const diff = renderUnifiedDiff([
      { path: 'long.txt', before: numbered(20), after: changedAt(20, 5, 13) },
    ])
    expect(headers(diff)).toEqual(['@@ -2,7 +2,7 @@', '@@ -10,7 +10,7 @@'])
  })

  it('contributes nothing when before and after are identical', () => {
    expect(renderUnifiedDiff([{ path: 'f.txt', before: 'a\nb\n', after: 'a\nb\n' }])).toBe('')
    expect(renderUnifiedDiff([{ path: 'f.txt', before: '', after: '' }])).toBe('')
  })

  it('skips a no-op edit without disturbing the edits around it', () => {
    const diff = renderUnifiedDiff([
      { path: 'first.txt', before: 'a\n', after: 'b\n' },
      { path: 'already.txt', before: 'same\n', after: 'same\n' },
      { path: 'last.txt', before: 'c\n', after: 'd\n' },
    ])
    expect(diff).toContain('--- a/first.txt')
    expect(diff).toContain('--- a/last.txt')
    expect(diff).not.toContain('already.txt')
  })

  it('marks a missing newline at end of file on the side that misses it', () => {
    const diff = renderUnifiedDiff([{ path: 'f.txt', before: 'a\nb', after: 'a\nc' }])
    expect(diff).toBe(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+c',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
  })

  it('treats appending the final newline as a change to that line', () => {
    const diff = renderUnifiedDiff([{ path: 'f.txt', before: 'a\nb', after: 'a\nb\n' }])
    expect(diff).toBe(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+b',
        '',
      ].join('\n'),
    )
  })

  it('renders several edits one after another, in the order given', () => {
    const edits: readonly FileEdit[] = [
      { path: 'b.yml', before: 'one\n', after: 'two\n' },
      { path: 'a.yml', before: undefined, after: 'fresh\n' },
    ]
    expect(renderUnifiedDiff(edits)).toBe(
      [
        '--- a/b.yml',
        '+++ b/b.yml',
        '@@ -1,1 +1,1 @@',
        '-one',
        '+two',
        '--- /dev/null',
        '+++ b/a.yml',
        '@@ -0,0 +1,1 @@',
        '+fresh',
        '',
      ].join('\n'),
    )
  })

  it('shows a creation even when the created file is empty', () => {
    // `diff -u /dev/null empty` prints nothing; a reviewer being shown nothing
    // for a file the plan creates is the failure mode this avoids.
    expect(renderUnifiedDiff([{ path: 'placeholder.yml', before: undefined, after: '' }])).toBe(
      ['--- /dev/null', '+++ b/placeholder.yml', ''].join('\n'),
    )
  })
})
