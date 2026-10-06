import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { coverageLines } from '../../src/cli/render/coverage.js'
import { allowed, type Walked } from '../../src/core/discovery/allow.js'
import { parseConnection } from '../../src/core/discovery/connection.js'
import { EXTRACTORS, findingsOf, type Extracted } from '../../src/core/discovery/extractors.js'
import { mintFinding } from '../../src/core/discovery/finding.js'
import {
  coverageOf,
  coverageSections,
  coverageSentence,
  evidencedDependencies,
  isComplete,
  verifiedFindings,
  type Coverage,
} from '../../src/core/discovery/report.js'
import { verifyFinding, type Checked, type Verified } from '../../src/core/discovery/verify.js'
import { blobId } from '../../src/core/git/blob.js'
import { coverageMarkdown } from '../../src/core/github/pull-request.js'

/**
 * The coverage report of stage 8's discovery (plan, Task 1.4; brief § 9): six
 * parts in the note's order, every path the walk reached in exactly one, what
 * nobody committed counted and never named, and one sentence that names what
 * `init`'s exit reads. Pure over what the read, the extractors and the
 * re-read established; the terminal's rendering and the body's are built from
 * the one list of sections.
 *
 * NO REAL SECRET IS WRITTEN HERE: every password is a marked placeholder.
 */

const HEAD = 'c0ffee1'.padEnd(40, '0')
const HASH = 'a'.repeat(64)

const walked = (over: Partial<Walked> = {}): Walked => ({
  selection: 'git',
  head: HEAD,
  opened: [],
  notAnalysed: [],
  byDesign: [],
  untracked: 0,
  staged: 0,
  unlisted: 0,
  unnameable: 0,
  truncated: false,
  ...over,
})

/** The kit's fixture (Task 1.2's commands), as committed. */
const PACKAGE =
  '{\n  "name": "invoicing-worker",\n  "dependencies": {\n    "mysql2": "^3.9.0",\n    "ioredis": "^5.4.0",\n    "kafkajs": "^2.2.0"\n  }\n}\n'
const SAMPLE =
  'DATABASE_URL=mysql://app_billing:S4mple-Passw0rd-7Qz@localhost:3306/billing\n' +
  'REDIS_URL=redis://localhost:6379\n' +
  'PAYMENTS_URL=https://${PAYMENTS_HOST}/v1\n'

/** Files extracted and read again as committed, every finding held to the re-read. */
function readAll(files: Readonly<Record<string, string>>): { extracted: Map<string, Extracted>; checked: Checked[] } {
  const opened = new Set(Object.keys(files))
  const extracted = new Map<string, Extracted>()
  const checked: Checked[] = []
  for (const [file, text] of Object.entries(files)) {
    const bytes = Buffer.from(text)
    const rule = allowed(file)
    if (rule === undefined) throw new Error(`${file} is not on the allow-list`)
    const result = EXTRACTORS[rule.extractor](file, bytes)
    extracted.set(file, result)
    if (result.outcome !== 'read') continue
    const reread = { path: file, bytes, committed: blobId(bytes, 'sha1'), objectFormat: 'sha1' as const }
    for (const finding of result.findings) {
      checked.push(verifyFinding(finding, reread, { opened, extract: findingsOf(EXTRACTORS) }))
    }
  }
  return { extracted, checked }
}

const FIXTURE_WALK = walked({
  opened: ['.env.example', 'package.json'],
  notAnalysed: [
    { path: '.gitignore', why: 'no-rule' },
    { path: 'src/index.ts', why: 'code' },
  ],
  byDesign: [{ path: 'deploy/prod.env', why: 'environment-file' }],
  untracked: 1,
})

const fixture = (): Coverage => {
  const { extracted, checked } = readAll({ '.env.example': SAMPLE, 'package.json': PACKAGE })
  return coverageOf(FIXTURE_WALK, extracted, checked)
}

/** A coverage of nothing but `over`'s walk. */
const only = (over: Partial<Walked>): Coverage => coverageOf(walked(over), new Map(), [])

const LABELS = [
  'analysed',
  'findings',
  'not proposed',
  'declared, not evidenced by this repository',
  'not analysed',
  'present, not read by design',
]

const plainQuote = (text: string): string => text

/** Every line's text and rendering in a section of the terminal's quoting. */
const textsOf = (coverage: Coverage, label: string): string[] =>
  coverageSections(coverage, plainQuote)
    .find((section) => section.label === label)
    ?.lines.map((line) => line.text) ?? []

describe('the coverage report', () => {
  it('puts every path in exactly one part', () => {
    const role = fc.constantFrom('opened', 'notAnalysed', 'byDesign')
    const fate = fc.constantFrom('vouches', 'cannot-vouch', 'stale', 'refused')
    const file = fc.record({
      role,
      sample: fc.boolean(),
      outcome: fc.constantFrom('read', 'read', 'read', 'parse-failure', 'over-finding-cap'),
      fates: fc.array(fate, { maxLength: 3 }),
    })
    const walk = fc.record({
      files: fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 12 }).chain((names) =>
        fc.tuple(fc.constant(names), fc.array(file, { minLength: names.length, maxLength: names.length })),
      ),
      untracked: fc.nat(5),
      staged: fc.nat(5),
      unlisted: fc.nat(5),
      unnameable: fc.nat(5),
    })
    fc.assert(
      fc.property(walk, ({ files: [names, fates], untracked, staged, unlisted, unnameable }) => {
        const opened: string[] = []
        const notAnalysed: { path: string; why: 'no-rule' }[] = []
        const byDesign: { path: string; why: 'key-material' }[] = []
        const extracted = new Map<string, Extracted>()
        const checked: Checked[] = []
        names.forEach((name, index) => {
          const one = fates[index]
          if (one === undefined) return
          if (one.role === 'notAnalysed') return void notAnalysed.push({ path: `${name}/README.md`, why: 'no-rule' })
          if (one.role === 'byDesign') return void byDesign.push({ path: `${name}/id_rsa`, why: 'key-material' })
          const file = `${name}/${one.sample ? '.env.example' : 'package.json'}`
          opened.push(file)
          if (one.outcome === 'parse-failure') return void extracted.set(file, { outcome: 'parse-failure', why: 'not-json' })
          if (one.outcome === 'over-finding-cap') return void extracted.set(file, { outcome: 'over-finding-cap', count: 201 })
          const findings = one.fates.map((_, line) =>
            mintFinding({
              rule: 'npm.dependency',
              path: file,
              lines: [line + 1, line + 1],
              fileSha256: HASH,
              standing: 'evidence',
              value: { package: 'pg', engine: 'postgres' },
            }),
          )
          extracted.set(file, { outcome: 'read', findings })
          findings.forEach((finding, at) => {
            const fated = one.fates[at]
            if (fated === 'vouches') checked.push({ outcome: 'vouches', finding: finding as Verified })
            else if (fated === 'cannot-vouch') checked.push({ outcome: 'cannot-vouch', finding, standing: 'sample' })
            else if (fated === 'stale') checked.push({ outcome: 'stale', finding })
            else checked.push({ outcome: 'refused', id: finding.id, check: 'span', reason: `finding ${finding.id}: refused` })
          })
        })
        const sorted = opened.sort()
        const coverage = coverageOf(
          walked({ opened: sorted, notAnalysed, byDesign, untracked, staged, unlisted, unnameable }),
          extracted,
          checked,
        )
        const seen = [
          ...coverage.analysed.map((one) => one.path),
          ...coverage.notAnalysed.map((one) => one.path),
          ...coverage.byDesign.map((one) => one.path),
        ]
        const walkedPaths = [...sorted, ...notAnalysed.map((one) => one.path), ...byDesign.map((one) => one.path)]
        expect(seen.sort()).toEqual([...walkedPaths].sort())
        expect(new Set(seen).size).toBe(seen.length)

        const counted = /in (\d+) files? analysed .*; (\d+) paths? not analysed;/.exec(coverageSentence(coverage))
        expect(counted).not.toBeNull()
        const total = Number(counted?.[1]) + Number(counted?.[2])
        expect(total).toBe(walkedPaths.length + untracked + staged + unlisted + unnameable)
      }),
      { numRuns: 200 },
    )
  })

  it("writes § 9's six parts, in order", () => {
    const sections = coverageSections(fixture(), plainQuote)
    expect(sections.map((section) => section.label)).toEqual(LABELS)
    expect(sections[2]?.lines.map((line) => line.text)).toEqual([
      'every finding: this version reports what the configuration states and proposes nothing from it',
    ])
    expect(sections[3]?.lines.map((line) => line.text)).toEqual([
      'not read: init reads no declarations repository in this version',
    ])
  })

  it('never says "no dependencies"', () => {
    const coverage = fixture()
    expect(coverageSentence(coverage)).toBe(
      'no dependency evidenced in 2 files analysed (4 findings verified); 4 paths not analysed; 1 reference configured outside this repository',
    )
    const none = coverageOf(walked({ notAnalysed: [{ path: 'README.md', why: 'no-rule' }] }), new Map(), [])
    expect(coverageSentence(none)).toBe(
      'no dependency evidenced in 0 files analysed (no finding verified); 1 path not analysed; 0 references configured outside this repository',
    )
    const { extracted, checked } = readAll({ 'package.json': '{ "name": "billing-api" }\n' })
    const one = coverageOf(walked({ opened: ['package.json'] }), extracted, checked)
    expect(coverageSentence(one)).toBe(
      'no dependency evidenced in 1 file analysed (1 finding verified); 0 paths not analysed; 0 references configured outside this repository',
    )
    for (const each of [coverage, none, one]) {
      expect([...coverageLines(each), coverageSentence(each), ...coverageMarkdown(each)].join('\n')).not.toMatch(/no dependencies/)
    }
  })

  it("counts the fixture's verified findings, and no evidenced dependency", () => {
    const coverage = fixture()
    expect(verifiedFindings(coverage)).toBe(4)
    const verified = new Set(coverage.verified)
    const sample = coverage.findings.filter((finding) => finding.path === '.env.example')
    expect(sample).toHaveLength(3)
    expect(sample.some((finding) => verified.has(finding.id))).toBe(false)
    expect(evidencedDependencies(coverage)).toBe(0)
    expect(isComplete(coverage)).toBe(false)
    expect(isComplete(only({ notAnalysed: [{ path: 'README.md', why: 'no-rule' }] }))).toBe(false)
    expect(isComplete(only({}))).toBe(true)
    expect(Object.isFrozen(coverage)).toBe(true)
    expect(Object.isFrozen(coverage.findings)).toBe(true)
  })

  it('bounds every list', () => {
    const paths = Array.from({ length: 25 }, (_, index) => `docs/page-${String(index).padStart(2, '0')}.md`)
    const coverage = only({ notAnalysed: paths.map((path) => ({ path, why: 'no-rule' as const })) })
    const [line] = textsOf(coverage, 'not analysed')
    expect(line).toBe(`no rule for this format: ${paths.slice(0, 20).join(', ')} and 5 more`)
    expect(line).not.toContain('page-20')
  })

  it('counts what git does not track, and names none of it', () => {
    expect(textsOf(only({ untracked: 1 }), 'not analysed')).toEqual(['git does not track 1 path, not named'])
    expect(textsOf(only({ untracked: 3, staged: 2, unnameable: 2 }), 'not analysed')).toEqual([
      'git does not track 3 paths, not named',
      '2 paths staged and never committed, not named',
      '2 paths whose names are not valid UTF-8, not named',
    ])
    expect(textsOf(only({ staged: 1, unnameable: 1 }), 'not analysed')).toEqual([
      '1 path staged and never committed, not named',
      '1 path whose name is not valid UTF-8, not named',
    ])
    const unlisted = only({ unlisted: 7 })
    expect(textsOf(unlisted, 'not analysed')).toEqual(['7 paths git tracks, not named: HEAD could not be listed whole'])
    expect(coverageSentence(unlisted)).toContain('; 7 paths not analysed;')
    expect(coverageSentence(only({ untracked: 3, staged: 2, unnameable: 2 }))).toContain('; 7 paths not analysed;')
    expect(textsOf(only({ selection: 'walk', head: undefined, untracked: 9 }), 'not analysed')).toEqual([
      'not a git repository: 9 paths, none analysed, none named',
    ])
  })

  it('names in Markdown only what a body can show', () => {
    const finding = mintFinding({
      rule: 'env-file.url',
      path: '.env.example',
      lines: [1, 1],
      fileSha256: HASH,
      standing: 'sample',
      variable: 'DATABASE_URL',
      value: { connection: parseConnection('mysql://%40acme-sre:Qz7-placeholder@localhost:3306/%40someone') },
    })
    expect(finding.fields).toMatchObject({ account: '@acme-sre', database: '@someone' })
    const coverage = coverageOf(
      walked({
        opened: ['.env.example'],
        notAnalysed: [
          { path: 'a`b.md', why: 'no-rule' },
          { path: '@someone/x', why: 'no-rule' },
          { path: 'bidi\u202Eevil.md', why: 'no-rule' },
        ],
        byDesign: [{ path: 'line\nbreak.env', why: 'environment-file' }],
      }),
      new Map([['.env.example', { outcome: 'read', findings: [finding] }]]),
      [{ outcome: 'cannot-vouch', finding, standing: 'sample' }],
    )
    const body = coverageMarkdown(coverage)
    const text = body.join('\n')
    expect(text).toContain('``a`b.md``')
    expect(text).toContain('`@someone/x`')
    expect(text).toContain('`@acme-sre`')
    expect(text).toContain('`@someone`')
    expect(text).toContain('`DATABASE_URL=mysql://%40acme-sre:•••@localhost:3306/%40someone`')
    // Outside every code span, no `@`: nobody is mentioned.
    for (const line of body) expect(line.replace(/(`+)(?:(?!\1).)*?\1/g, '')).not.toContain('@')
    expect(text).not.toContain('\u202E')
    expect(text).not.toContain('line\nbreak')
    expect(body.filter((line) => line.includes('1 path whose name a body cannot show'))).toHaveLength(2)
  })

  it('shows no rendering of an unparsed or withheld finding', () => {
    const make = (value: string) =>
      mintFinding({
        rule: 'env-file.url',
        path: '.env.example',
        lines: [2, 2],
        fileSha256: HASH,
        standing: 'sample',
        variable: 'LEDGER_URL',
        value: { connection: parseConnection(value) },
      })
    const unparsed = make('postgres://app@bіlling-db:5432/ledger')
    const withheld = make(`postgres://${'AK'}${'IA'}Z7Q4M2LXV9TRN3KD@pg-01.internal/ledger`)
    expect([unparsed.kind, withheld.kind]).toEqual(['unparsed', 'withheld'])
    for (const finding of [unparsed, withheld]) {
      const coverage = coverageOf(
        walked({ opened: ['.env.example'] }),
        new Map([['.env.example', { outcome: 'read', findings: [finding] }]]),
        [{ outcome: 'cannot-vouch', finding, standing: 'sample' }],
      )
      const [line] = coverageSections(coverage, plainQuote)[1]?.lines ?? []
      expect(line?.at).toBe('.env.example:2')
      expect(line?.shown).toBeUndefined()
      expect(line?.text).toMatch(/\(LEDGER_URL\)$/)
      expect(coverageLines(coverage).join('\n')).not.toMatch(/bіlling|AKIA|pg-01/)
    }
  })

  it('names a found engine this registry cannot express', () => {
    const lines = coverageLines(fixture())
    expect(lines).toContain(
      '                package.json:6   a kafka client is installed: kafkajs — found, not expressible: no resource type for it in this registry',
    )
  })

  it('names no path raw on a terminal', () => {
    const coverage = only({
      notAnalysed: [
        { path: 'a\u001b[31mred.md', why: 'no-rule' },
        { path: 'line\nbreak.md', why: 'no-rule' },
        { path: 'zero\u200Bwidth\u2067.md', why: 'no-rule' },
      ],
    })
    const lines = coverageLines(coverage)
    for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    const text = lines.join('\n')
    expect(text).toContain('a\\u001b[31mred.md')
    expect(text).toContain('line\\u000abreak.md')
    expect(text).toContain('zero\\u200bwidth\\u2067.md')
  })
})

describe('what the re-read drops', () => {
  /** A manifest npm would never write: one line, over the span check's 1,024 bytes. */
  const MINIFIED = JSON.stringify({
    name: 'billing-api',
    scripts: { start: 'node index.js' },
    dependencies: {
      ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`dep-${String(index).padStart(2, '0')}`, '^1.0.0'])),
      pg: '^8.0.0',
    },
  })

  it('names the file and the line a finding the re-read refused was read at', () => {
    expect(MINIFIED.includes('\n')).toBe(false)
    expect(Buffer.byteLength(MINIFIED)).toBeGreaterThan(1_024)
    const { extracted, checked } = readAll({ 'package.json': MINIFIED })
    expect(checked.map((one) => one.outcome)).toEqual(['refused', 'refused'])
    const coverage = coverageOf(walked({ opened: ['package.json'] }), extracted, checked)
    expect(coverage.dropped.map((one) => [one.path, one.line, one.check])).toEqual([
      ['package.json', 1, 'span'],
      ['package.json', 1, 'span'],
    ])
    expect(verifiedFindings(coverage)).toBe(0)
    const lines = coverageLines(coverage)
    expect(lines).toContain('analysed        package.json (npm: 0 findings, 2 dropped by the re-read)')
    const dropped = lines.filter((line) => line.includes('dropped by the re-read, at its span check'))
    expect(dropped).toHaveLength(2)
    for (const line of dropped) expect(line).toMatch(/^(?:findings {8}| {16})package\.json:1 {3}dropped by the re-read, at its span check: finding [0-9a-f]{64}: /)
    expect(coverageMarkdown(coverage).filter((line) => line.startsWith('- `package.json`:1 dropped by the re-read'))).toHaveLength(2)
  })

  it('bounds the findings it lists as dropped, on a terminal and in a body', () => {
    const files = Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [`packages/p${String(index).padStart(2, '0')}/package.json`, MINIFIED]),
    )
    const { extracted, checked } = readAll(files)
    const coverage = coverageOf(walked({ opened: Object.keys(files) }), extracted, checked)
    expect(coverage.dropped).toHaveLength(26)
    for (const lines of [coverageLines(coverage), coverageMarkdown(coverage)]) {
      expect(lines.filter((line) => line.includes('dropped by the re-read, at its'))).toHaveLength(20)
      expect(lines.some((line) => line.includes('and 6 more dropped by the re-read'))).toBe(true)
    }
  })

  it('does not count a name it could not read, though the re-read lets it vouch', () => {
    // Owner's answer 7 (2026-10-06): a finding counts as verified only when it
    // vouches and holds a value the engine could read. It is still listed, as
    // what it is; only the count, the sentence's and the exit's, leaves it out.
    for (const [text, kind, says] of [
      ['{ "name": 5, "devDependencies": { "pg": "1" } }\n', 'unparsed', 'a value this version could not read'],
      ['{ "name": "Not An npm Name!" }\n', 'unparsed', 'a value this version could not read'],
      // An npm token's shape, inside npm's grammar for a name, assembled at run time.
      [
        `{ "name": "${'np'}${'m_'}${'qz7placeholderabcdefghijklmnopqrstuv'.slice(0, 36)}" }\n`,
        'withheld',
        'a value shaped like a credential, not shown',
      ],
    ] as const) {
      const { extracted, checked } = readAll({ 'package.json': text })
      const coverage = coverageOf(
        walked({ opened: ['package.json'], notAnalysed: [{ path: 'README.md', why: 'no-rule' }] }),
        extracted,
        checked,
      )
      const name = coverage.findings.find((finding) => finding.rule === 'npm.name')
      expect(name?.kind).toBe(kind)
      expect(coverage.verified).toContain(name?.id)
      expect(verifiedFindings(coverage)).toBe(0)
      expect(coverageSentence(coverage)).toContain('(no finding verified)')
      expect(coverageLines(coverage).filter((line) => line.endsWith(` package.json:1   ${says}`))).toHaveLength(1)
    }
  })

  it('counts a name it could read beside one it could not', () => {
    const { extracted, checked } = readAll({
      'package.json': '{\n  "name": "billing-api"\n}\n',
      'packages/a/package.json': '{ "name": 5 }\n',
    })
    const coverage = coverageOf(walked({ opened: ['package.json', 'packages/a/package.json'] }), extracted, checked)
    expect(coverage.verified).toHaveLength(2)
    expect(verifiedFindings(coverage)).toBe(1)
    expect(coverageSentence(coverage)).toContain('(1 finding verified)')
  })
})

describe('the run cap', () => {
  it('keeps the files discover set past the cap there, whatever their findings say after', () => {
    const { extracted, checked } = readAll({ 'package.json': PACKAGE, 'packages/a/package.json': PACKAGE })
    const opened = ['package.json', 'packages/a/package.json']
    const past = new Set(['packages/a/package.json'])
    const coverage = coverageOf(walked({ opened }), extracted, checked, past)
    expect(coverage.analysed.map((one) => one.path)).toEqual(['package.json'])
    expect(coverage.notAnalysed).toEqual([{ path: 'packages/a/package.json', why: 'past-run-cap' }])
    expect(coverage.findings.every((finding) => finding.path === 'package.json')).toBe(true)
    expect(verifiedFindings(coverage)).toBe(4)
  })
})

describe('isComplete', () => {
  it('is never true outside a git repository, or of a read that listed nothing', () => {
    expect(isComplete(only({}))).toBe(true)
    expect(isComplete(only({ selection: 'walk', head: undefined }))).toBe(false)
    expect(isComplete(only({ selection: 'none', head: undefined }))).toBe(false)
  })
})

describe('the terminal rendering', () => {
  it("prints the fixture's report as the plan shows it", () => {
    expect(coverageLines(fixture())).toEqual([
      "discovery — what this repository's committed configuration states, read at commit c0ffee1; renderings, not quotes; nothing is proposed from it in this version",
      'analysed        .env.example (env-file, a sample: 3 findings)',
      '                package.json (npm: 4 findings)',
      'findings        .env.example:1   a sample states mysql database billing on localhost:3306 as app_billing',
      '                                 DATABASE_URL=mysql://app_billing:•••@localhost:3306/billing',
      '                .env.example:2   a sample states redis on localhost:6379',
      '                                 REDIS_URL=redis://localhost:6379',
      '                .env.example:3   configured outside this repository: an https endpoint (PAYMENTS_URL)',
      '                package.json:2   the package is named invoicing-worker',
      '                package.json:4   a mysql client is installed: mysql2',
      '                package.json:5   a redis client is installed: ioredis',
      '                package.json:6   a kafka client is installed: kafkajs — found, not expressible: no resource type for it in this registry',
      'not proposed    every finding: this version reports what the configuration states and proposes nothing from it',
      'declared, not evidenced by this repository',
      '                not read: init reads no declarations repository in this version',
      'not analysed    no rule for this format: .gitignore',
      '                code, not read for dependencies: src/index.ts',
      '                git does not track 1 path, not named',
      'present, not read by design',
      '                a real environment file, never opened: deploy/prod.env',
      'no dependency evidenced in 2 files analysed (4 findings verified); 4 paths not analysed; 1 reference configured outside this repository',
    ])
  })
})
