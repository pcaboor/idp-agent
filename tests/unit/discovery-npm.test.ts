import { describe, expect, it } from 'vitest'
import { EXTRACTORS, type Extracted } from '../../src/core/discovery/extractors.js'
import { NPM_CLIENTS } from '../../src/core/discovery/extract/npm.js'
import type { Finding } from '../../src/core/discovery/finding.js'

/**
 * npm's extractor (plan, Task 1.4): a `package.json`'s name, and the clients
 * of a closed table it installs, each at its line. It reads the field names of
 * the format and never a version spec, and a file that is not plainly JSON is
 * refused in a closed reason of the engine's, never a parser's message.
 *
 * NO REAL SECRET IS WRITTEN HERE: every password is a marked placeholder.
 */

const extract = (text: string, file = 'package.json'): Extracted => EXTRACTORS.npm(file, Buffer.from(text))

const findingsOf = (text: string, file?: string): readonly Finding[] => {
  const extracted = extract(text, file)
  if (extracted.outcome !== 'read') throw new Error(`not read: ${extracted.outcome}`)
  return extracted.findings
}

/** Every string a value holds, raw. */
function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(leaves)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(leaves)
  return []
}

const manifest = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

describe('the npm extractor', () => {
  it("reads the package's name at its line", () => {
    const [plain] = findingsOf('{\n  "version": "1.0.0",\n  "name": "invoicing-worker"\n}\n')
    expect(plain).toMatchObject({ rule: 'npm.name', kind: 'package-name', lines: [3, 3], standing: 'evidence' })
    expect(plain?.fields).toEqual({ name: 'invoicing-worker' })

    const [scoped] = findingsOf(manifest({ name: '@acme/api' }))
    expect(scoped?.fields).toEqual({ name: '@acme/api' })

    for (const name of ['Not A Name', 'billing\u202Eipa', 42]) {
      const [refused] = findingsOf(manifest({ name }))
      expect(refused?.kind).toBe('unparsed')
      expect(refused?.fields).toEqual({})
    }
  })

  it('reads one finding per known client, at its line', () => {
    const text = manifest({ name: 'invoicing-worker', dependencies: { mysql2: '^3.9.0', ioredis: '^5.4.0', kafkajs: '^2.2.0' } })
    const found = findingsOf(text).filter((finding) => finding.rule === 'npm.dependency')
    expect(found.map((finding) => [finding.kind, finding.fields.package, finding.lines[0], finding.standing])).toEqual([
      ['mysql', 'mysql2', 4, 'evidence'],
      ['redis', 'ioredis', 5, 'evidence'],
      ['kafka', 'kafkajs', 6, 'evidence'],
    ])

    const optional = findingsOf(manifest({ optionalDependencies: { pg: '^8.0.0' } }))
    expect(optional.map((finding) => [finding.kind, finding.standing])).toEqual([['postgres', 'evidence']])
  })

  it('says a development dependency is a mention', () => {
    const found = findingsOf(manifest({ devDependencies: { pg: '^8.0.0' }, peerDependencies: { redis: '^4.0.0' } }))
    expect(found.map((finding) => [finding.kind, finding.standing])).toEqual([
      ['postgres', 'mention'],
      ['redis', 'mention'],
    ])
  })

  it('finds nothing in a package it does not know', () => {
    const text = manifest({
      dependencies: {
        prisma: '^5.0.0',
        axios: '^1.0.0',
        'better-sqlite3': '^9.0.0',
        'mуsql2': '^3.0.0',
        x: 'git+https://user:Qz7x@host/x.git',
        toString: '^1.0.0',
        ['__proto__']: '^1.0.0',
      },
    })
    expect(findingsOf(text)).toEqual([])
    expect(leaves(extract(text)).some((leaf) => leaf.includes('Qz7x'))).toBe(false)
    expect(NPM_CLIENTS['mуsql2']).toBeUndefined()
    expect(Object.isFrozen(NPM_CLIENTS)).toBe(true)
  })

  const refusals: readonly (readonly [string, string, string])[] = [
    ['a duplicate "name"', '{\n  "name": "Qz7a",\n  "name": "billing-api"\n}\n', 'duplicate-key'],
    ['a comment', '{\n  // Qz7b\n  "name": "billing-api"\n}\n', 'not-json'],
    ['a trailing comma', '{\n  "name": "billing-api",\n  "x": "Qz7c",\n}\n', 'not-json'],
    ['a top-level array', '["Qz7d"]\n', 'not-an-object'],
    ['64 KiB of [', `${'['.repeat(65_000)}"Qz7e"`, 'too-deep'],
    ['a string that never closes', '{ "name": "Qz7f\n', 'unclosed-quote'],
    ['bytes that are not UTF-8', '\u0000', 'not-utf8'],
  ]

  it.each(refusals)('refuses a file that is not plainly JSON, and quotes none of it: %s', (_, text, why) => {
    const bytes = why === 'not-utf8' ? Buffer.from([0x7b, 0x22, 0x51, 0x7a, 0x37, 0xff, 0x22, 0x7d]) : Buffer.from(text)
    const extracted = EXTRACTORS.npm('package.json', bytes)
    expect(extracted).toEqual({ outcome: 'parse-failure', why })
    for (const leaf of leaves(extracted)) expect(leaf).not.toContain('Qz7')
  })

  it('does not believe a name, it reports it', () => {
    // 2.5 and 2.6 decide what a name may vouch for: here it is what the file says.
    const findings = findingsOf(manifest({ name: 'billing-api' }), 'services/other/package.json')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'package-name', fields: { name: 'billing-api' }, path: 'services/other/package.json' })
  })

  it('reads 3,000 unknown dependencies, with no finding', () => {
    const dependencies = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`p${String(index)}`, '1']))
    const text = JSON.stringify({ dependencies })
    expect(Buffer.byteLength(text)).toBeLessThan(65_536)
    expect(extract(text)).toEqual({ outcome: 'read', findings: [] })
  })
})
