import {
  coverageHeading,
  coverageSections,
  coverageSentence,
  type Coverage,
  type CoverageLine,
} from '../../core/discovery/report.js'
import { inertLine } from './plain.js'

/**
 * The discovery report on a terminal (plan, Task 1.4): what `idpa init`
 * prints between its diff and its closing lines — a heading, § 9's six
 * parts with their labels aligned, and the sentence, which `init` also says
 * on stderr. Built from `coverageSections`, as the pull request's body is, so
 * the two cannot disagree about what was read.
 *
 * Every path is a repository's bytes — git tracks a name holding ESC or a
 * line break as readily as any other — so each is written through `spelled`:
 * every control, format, bidi and line-separator character spelled out as a
 * `\u` escape, then `inertLine`. No line holds a byte a terminal obeys, and a
 * name that held one is still seen to.
 */

/** The column the parts' lines start at; a longer label is a line of its own. */
const LABEL_WIDTH = 16

/** Where a finding's place and its sentence are apart. */
const GAP = '   '

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** A path, a value or a rendering, every character a terminal could obey or hide spelled out, on one line. */
const spelled = (text: string): string =>
  inertLine(
    text.replace(INVISIBLE, (char) => {
      const point = char.codePointAt(0) ?? 0
      return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`
    }),
    Number.POSITIVE_INFINITY,
  )

/** One part's lines, its label in the first column, a finding's sentence and rendering aligned past its place. */
function sectionLines(label: string, lines: readonly CoverageLine[]): string[] {
  const indent = ' '.repeat(LABEL_WIDTH)
  const width = Math.max(0, ...lines.map((line) => [...(line.at ?? '')].length))
  const body = lines.flatMap((line) => {
    if (line.at === undefined) return [line.text]
    const at = line.at.padEnd(line.at.length + width - [...line.at].length)
    return [
      `${at}${GAP}${line.text}`,
      ...(line.shown === undefined ? [] : [`${' '.repeat(width)}${GAP}${line.shown}`]),
    ]
  })
  const [first = '', ...rest] = body
  const head = label.length < LABEL_WIDTH ? [`${label.padEnd(LABEL_WIDTH)}${first}`] : [label, `${indent}${first}`]
  return [...head, ...rest.map((line) => `${indent}${line}`)]
}

/** The report's lines on a terminal: heading, six parts, sentence. */
export function coverageLines(coverage: Coverage): string[] {
  return [
    coverageHeading(coverage, spelled),
    ...coverageSections(coverage, spelled).flatMap((section) => sectionLines(section.label, section.lines)),
    coverageSentence(coverage),
  ]
}
