import fc from 'fast-check'
import { parseAllDocuments } from 'yaml'
import { describe, expect, it } from 'vitest'
import { planEdits } from '../../src/core/plan/edits.js'
import { signPlan, type SignedPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'

/**
 * Effectiveness: a plan's bytes carry out the plan, or the plan says they do
 * not. Never an unchanged file while the consumer is absent — the shape that
 * printed "nothing to change." on exit 0 and granted nothing.
 *
 * The files are generated the way people write them, each trait varied on its
 * own: a leading `---` or none, two or four spaces, comments trailing the keys,
 * a comment at column zero inside the spec, a byte-order mark, CRLF line
 * endings, consumers already listed or none, a neighbouring document. The generators are local on
 * purpose — `arbitraries.ts` builds files for the byte-for-byte properties,
 * and these traits are about locating a document, not about removing one.
 *
 * Checked against the PARSER, reading the result back, and against the model
 * the file was generated from — never against `effect.ts`, which would make
 * the property agree with the code it tests.
 */

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('')
const alnum = [...letters, ...'0123456789'.split('')]
/**
 * A letter first, and never a YAML 1.2 keyword: `name: 24` or `name: null` is
 * not a string, and the entity it names does not exist to amend.
 */
const name = fc
  .tuple(
    fc.constantFrom(...letters),
    fc.array(fc.constantFrom(...alnum, '-'), { maxLength: 12 }),
    fc.constantFrom(...alnum),
  )
  .map(([first, body, last]) => first + body.join('') + last)
  .filter((candidate) => !['true', 'false', 'null'].includes(candidate))

const shape = fc.record({
  target: name,
  consumer: name.map((one) => `component:default/${one}`),
  listed: fc.uniqueArray(name.map((one) => `component:default/${one}`), { maxLength: 3 }),
  alreadyListed: fc.boolean(),
  emptyAs: fc.constantFrom('absent', 'flow'),
  marker: fc.boolean(),
  bom: fc.boolean(),
  crlf: fc.boolean(),
  header: fc.boolean(),
  indent: fc.constantFrom(2, 4),
  flushItems: fc.boolean(),
  trailingComments: fc.boolean(),
  columnZero: fc.constantFrom('none', 'after-type', 'before-items'),
  neighbour: fc.constantFrom('none', 'before', 'after'),
})

type Shape = typeof shape extends fc.Arbitrary<infer T> ? T : never

/** The consumers the file lists before the plan runs. */
const consumersOf = (shape: Shape): string[] =>
  shape.alreadyListed && !shape.listed.includes(shape.consumer)
    ? [...shape.listed, shape.consumer]
    : shape.listed

function grant(shape: Shape, name: string, consumers: readonly string[]): string[] {
  const pad = ' '.repeat(shape.indent)
  const note = (text: string): string => (shape.trailingComments ? ` # ${text}` : '')
  const items = consumers.map(
    (consumer) => `${shape.flushItems ? pad : pad + pad}- ${consumer}`,
  )
  const dependencyOf =
    consumers.length > 0
      ? [
          `${pad}dependencyOf:${note('who reads it')}`,
          ...(shape.columnZero === 'before-items' ? ['# reviewed by tiger'] : []),
          ...items,
        ]
      : shape.emptyAs === 'flow'
        ? [`${pad}dependencyOf: []${note('nobody yet')}`]
        : []
  return [
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    `metadata:${note('identity')}`,
    `${pad}name: ${name}${note('do not rename')}`,
    `${pad}annotations:`,
    `${pad}${pad}company.fr/env: prod`,
    `spec:${note('the grant')}`,
    `${pad}type: database-access`,
    ...(shape.columnZero === 'after-type' ? ['# owner below'] : []),
    `${pad}owner: group:default/tiger`,
    ...dependencyOf,
  ]
}

function fileOf(shape: Shape): string {
  const neighbourName = `${shape.target}-other`
  const target = grant(shape, shape.target, consumersOf(shape))
  const neighbour = grant(shape, neighbourName, ['component:default/elsewhere'])
  const documents =
    shape.neighbour === 'before'
      ? [neighbour, target]
      : shape.neighbour === 'after'
        ? [target, neighbour]
        : [target]
  const body = documents
    .map((lines, index) => [...(index > 0 || shape.marker ? ['---'] : []), ...lines].join('\n'))
    .join('\n\n')
  const text = `${shape.bom ? '\uFEFF' : ''}${shape.header ? '# hand written\n' : ''}${body}\n`
  return shape.crlf ? text.replaceAll('\n', '\r\n') : text
}

const PATH = (shape: Shape): string => `dependencies/access/${shape.target}.yml`
const refOf = (shape: Shape): string => `resource:default/${shape.target}`

function signed(shape: Shape): SignedPlan {
  const plan = planSchema.parse({
    intent: `let ${shape.consumer} use ${refOf(shape)}`,
    operations: [
      {
        op: 'update-entity',
        entityRef: refOf(shape),
        patch: { patch: 'add-dependency-of', consumer: shape.consumer },
      },
    ],
  })
  const result = signPlan(plan, {
    wordsOf: 'user',
    witnessed: new Set([refOf(shape), shape.consumer]),
    vocabulary: {
      kinds: ['Component', 'Resource'],
      types: ['database-access'],
      environments: ['prod'],
      owners: ['group:default/tiger'],
    },
    repoRoot: '/repo',
    declared: new Map(),
    answered: new Set(),
  })
  if ('outcome' in result) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result
}

/** The file as the parser reads it: every non-empty document, errors thrown. */
function read(text: string): unknown[] {
  return parseAllDocuments(text).flatMap((document) => {
    expect(document.errors).toEqual([])
    const value: unknown = document.toJS()
    return value === null ? [] : [value]
  })
}

/** What the file must read as once the consumer is listed: that, and only that. */
function expected(shape: Shape, before: unknown[]): unknown[] {
  return before.map((value) => {
    const document = value as { metadata: { name: string }; spec: Record<string, unknown> }
    if (document.metadata.name !== shape.target) return value
    const listed = (document.spec.dependencyOf ?? []) as string[]
    if (listed.includes(shape.consumer)) return value
    return { ...document, spec: { ...document.spec, dependencyOf: [...listed, shape.consumer] } }
  })
}

describe('a plan carries out what it says, or says it could not', () => {
  it('lists the consumer and changes nothing else, or drops the operation with a reason', () => {
    fc.assert(
      fc.property(shape, (one) => {
        const file = fileOf(one)
        const { edits, dropped } = planEdits(signed(one), new Map([[PATH(one), file]]))

        if (dropped.length > 0) {
          expect(dropped[0]?.reason).toContain(PATH(one))
          // Dropped means untouched: no edit carries half of it.
          expect(edits).toEqual([])
          return
        }
        const edit = edits.find((candidate) => candidate.path === PATH(one))
        expect(edit).toBeDefined()
        const after = edit?.after ?? ''
        expect(read(after)).toEqual(expected(one, read(file)))
        // The shape that granted nothing: an unchanged file, consumer absent.
        if (after === file) expect(consumersOf(one)).toContain(one.consumer)
      }),
    )
  })

  it('amends every one of these shapes, rather than dropping it', () => {
    // Stronger than the above, and deliberately separate: that one holds for
    // an implementation that drops everything. These are the shapes catalogue
    // files are really written in, and each must come out as a one-line edit —
    // or none, when the consumer is already listed.
    fc.assert(
      fc.property(shape, (one) => {
        const file = fileOf(one)
        const { edits, dropped } = planEdits(signed(one), new Map([[PATH(one), file]]))

        expect(dropped).toEqual([])
        const after = edits[0]?.after ?? ''
        const gained = after.split('\n').length - file.split('\n').length
        const absent = consumersOf(one).length === 0 && one.emptyAs === 'absent'
        expect(gained).toBe(
          consumersOf(one).includes(one.consumer) ? 0 : absent ? 2 : 1,
        )
        if (one.bom) expect(after.startsWith('\uFEFF')).toBe(true)
        // An added line ends the way the file's lines do.
        if (one.crlf) expect(after).not.toMatch(/(?:^|[^\r])\n/)
      }),
    )
  })
})
