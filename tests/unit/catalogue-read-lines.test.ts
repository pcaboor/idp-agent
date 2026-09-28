import { describe, expect, it } from 'vitest'
import { setAsideLine, skippedLines } from '../../src/cli/render/catalogue-read.js'
import type { Ignored, Rejection } from '../../src/context/provider.js'

/**
 * What a catalogue read says on stderr (docs/backstage-http-brief.md § 5):
 * grouped by reason, each with its count, because a catalogue of thousands
 * would flood a line per entity. Every value quoted there — a kind, a
 * namespace, a lifecycle, a type, a ref, a location — is chosen by the
 * catalogue, so each is cleaned and cut to 80 characters, each reason lists
 * at most five values, and each line at most three refs.
 */

/** `count` rows the pre-pass set aside under `rule` for `value`, refs from `names`. */
const rows = (rule: NonNullable<Ignored['prePass']>['rule'], value: string, names: readonly string[]): Ignored[] =>
  names.map((name) => ({
    source: `component:default/${name} (url:https://github.com/acme/${name}/blob/main/catalog-info.yaml)`,
    reason: `${rule} ${value}`,
    kind: 'Component',
    ref: `component:default/${name}`,
    prePass: { rule, value },
  }))

const named = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, at) => `${prefix}-${String(at).padStart(3, '0')}`)

const beta = (count: number): Ignored[] => rows('lifecycle', 'beta', ['a', 'b', 'c', ...named('beta', count - 3)])
const development = (count: number): Ignored[] => rows('lifecycle', 'development', named('dev', count))
const payments = (count: number): Ignored[] => rows('namespace', 'payments', named('pay', count))

/** The escape bytes of `read-commands-hostile.test.ts`, as the characters they decode to. */
const HOSTILE = '\u001b[2J\u001b[H\u001b]52;c;ZXZpbA==\u0007\u009b31m\r'

/** C0 but the line feed, DEL and C1: what a terminal obeys. */
// eslint-disable-next-line no-control-regex -- matching them is the point
const OBEYED = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/

describe('setAsideLine', () => {
  it('groups what the pre-pass set aside by rule, five values then "and K more", three refs', () => {
    expect(setAsideLine([...beta(120), ...development(60), ...payments(34)])).toBe(
      'set aside by the catalogue read: 180 lifecycle not modelled (beta ×120, development ×60), ' +
        '34 outside namespace default (payments ×34); first: component:default/a, component:default/b, component:default/c, …',
    )
  })

  it('says nothing when the pre-pass set nothing aside, and leaves the kinds not modelled to their own line', () => {
    expect(setAsideLine([])).toBeUndefined()
    expect(setAsideLine([{ source: 'org.yml', reason: 'kind Group is not modelled by this tool', kind: 'Group', ref: 'group:default/tiger' }])).toBeUndefined()
  })

  it('lists five values of a rule, then how many more', () => {
    const types = ['kafka-topic', 'queue', 's3-bucket', 'dns-zone', 'vault', 'lambda', 'cdn'].flatMap((type, at) =>
      rows('resource-type', type, named(type, 7 - at)),
    )
    expect(setAsideLine(types)).toBe(
      'set aside by the catalogue read: 28 resource type not modelled ' +
        '(kafka-topic ×7, queue ×6, s3-bucket ×5, dns-zone ×4, vault ×3, and 2 more); ' +
        'first: component:default/kafka-topic-000, component:default/kafka-topic-001, component:default/kafka-topic-002, …',
    )
  })

  it('names every rule in its own words', () => {
    const line = setAsideLine([
      ...rows('name-case', 'Checkout', ['x']),
      ...rows('api-version', 'backstage.io/v1beta1', ['y']),
      ...rows('shape', 'depth', ['z']),
    ])
    expect(line).toBe(
      'set aside by the catalogue read: 1 apiVersion not read (backstage.io/v1beta1 ×1), ' +
        '1 name in upper case (Checkout ×1), 1 shape not read (depth ×1); ' +
        'first: component:default/x, component:default/y, component:default/z',
    )
  })
})

describe('skippedLines', () => {
  const rejection = (name: string, reason: string): Rejection => ({
    source: `component:default/${name} (url:https://github.com/acme/${name}/blob/main/catalog-info.yaml)`,
    ref: `component:default/${name}`,
    reason,
  })

  it('groups what the reader skipped by reason, the five most common, three refs each', () => {
    const rejected = [
      rejection('legacy-batch', 'spec.owner is required'),
      rejection('old-batch', 'spec.owner is required'),
      ...['r1', 'r2', 'r3', 'r4'].map((name) => rejection(name, 'spec.type is required')),
      ...['one', 'two', 'three', 'four', 'five'].map((name, at) => rejection(name, `reason ${String(at)}`)),
    ]
    expect(skippedLines(rejected)).toEqual([
      'skipped 4: spec.type is required (component:default/r1, component:default/r2, component:default/r3, …)',
      'skipped 2: spec.owner is required (component:default/legacy-batch, component:default/old-batch)',
      'skipped 1: reason 0 (component:default/one)',
      'skipped 1: reason 1 (component:default/two)',
      'skipped 1: reason 2 (component:default/three)',
      'skipped 2 more, for 2 other reasons',
    ])
  })

  it('names a rejection by its source when it has no ref', () => {
    expect(skippedLines([{ source: 'an item of the catalogue', reason: 'kind is required' }])).toEqual([
      'skipped 1: kind is required (an item of the catalogue)',
    ])
  })
})

describe('the grouped lines, over what a hostile catalogue serves', () => {
  it('cleans and cuts every catalogue value to 80 characters: no C0, DEL or C1 survives', () => {
    const long = `${HOSTILE}${'x'.repeat(200)}`
    const ignored: Ignored[] = [
      ...rows('lifecycle', `beta${long}`, [`a${long}`]),
      ...rows('namespace', `pay${long}`, ['b']),
      ...rows('resource-type', `type${long}`, ['c']),
      { ...rows('shape', 'depth', ['d'])[0]!, kind: `Kind${long}`, ref: `kind${long}:default/d` },
    ]
    const rejected: Rejection[] = [
      { source: `url:https://evil.example/${long}`, reason: `spec.owner ${HOSTILE}` },
      { source: 'x', ref: `component:default/${long}`, reason: `spec.type ${HOSTILE}` },
    ]
    const lines = [setAsideLine(ignored)!, ...skippedLines(rejected)]
    for (const line of lines) {
      expect(line).not.toMatch(OBEYED)
      expect(line).not.toContain('\n')
      // No value is longer than its bound: 80 characters, and the ellipsis a cut adds.
      expect(line).not.toMatch(/[^\s(),;:]{82,}/)
    }
    // The bidi controls are spelled out, as the file road's skipped line does:
    // U+202E is what makes `lmy.evil` read `live.yml`.
    const bidi = [
      ...rows('lifecycle', 'beta\u2066x\u2069', ['\u202elmy.evil']),
      ...rows('namespace', 'pay\u202ements', ['b']),
    ]
    const turned = [
      setAsideLine(bidi)!,
      ...skippedLines([{ source: 'x', ref: 'component:default/\u202elmy.evil', reason: 'spec.owner \u202eis required' }]),
    ]
    for (const line of turned) expect(line).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/)
    expect(turned[0]).toContain('beta\\u2066x\\u2069 ×1')
    expect(turned[1]).toBe('skipped 1: spec.owner \\u202eis required (component:default/\\u202elmy.evil)')
  })

  it('cleans a reason and cuts it at 200 characters: the reader’s words quote what the catalogue wrote', () => {
    const [line] = skippedLines([{ source: 'x', reason: `spec.owner ${HOSTILE}${'y'.repeat(500)}` }])
    expect(line).not.toMatch(OBEYED)
    // The C1 CSI goes and its parameters stay, as text: `plain` removes what a terminal obeys.
    expect(line).toMatch(/^skipped 1: spec\.owner 31my{186}… \(x\)$/)
  })
})
