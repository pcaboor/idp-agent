import { describe, expect, it } from 'vitest'
import { EXTRACTORS, type Extracted } from '../../src/core/discovery/extractors.js'
import { isMinted, type Finding } from '../../src/core/discovery/finding.js'

/**
 * The `env-file` extractor (plan, Task 1.4): a sample environment file's
 * connection strings, one finding a line, each a `sample` that cannot vouch.
 * It reads a dotenv file's syntax — a key, `=`, a value, quoted or not, a
 * comment — and never the words of a comment, in any language.
 *
 * NO REAL SECRET IS WRITTEN HERE: every password is a marked placeholder
 * (`Qz7…`), and the access key id is assembled at run time.
 */

const ACCESS_KEY_ID = `${'AK'}${'IA'}Z7Q4M2LXV9TRN3KD`

const extract = (text: string, file = '.env.example'): Extracted => EXTRACTORS['env-file'](file, Buffer.from(text))

const findingsOf = (text: string, file?: string): readonly Finding[] => {
  const extracted = extract(text, file)
  if (extracted.outcome !== 'read') throw new Error(`not read: ${extracted.outcome}`)
  return extracted.findings
}

/** Every string a value holds, raw: never `JSON.stringify`, which escapes what it would hide. */
function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(leaves)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(leaves)
  return []
}

describe('the env-file extractor', () => {
  const URL = 'postgres://app_ledger:Qz7a-placeholder@pg-01.prod.internal:5432/ledger'
  const rows: readonly (readonly [string, string, { kind: string; line: number; variable?: string } | undefined])[] = [
    ['KEY=url', `DATABASE_URL=${URL}\n`, { kind: 'postgres', line: 1, variable: 'DATABASE_URL' }],
    ['export KEY=url', `export DATABASE_URL=${URL}\n`, { kind: 'postgres', line: 1, variable: 'DATABASE_URL' }],
    ["KEY='url'", `DATABASE_URL='${URL}'\n`, { kind: 'postgres', line: 1, variable: 'DATABASE_URL' }],
    ['KEY="url"', `DATABASE_URL="${URL}"\n`, { kind: 'postgres', line: 1, variable: 'DATABASE_URL' }],
    ['an unquoted value ending at " #"', `DATABASE_URL=${URL} # the ledger\n`, { kind: 'postgres', line: 1, variable: 'DATABASE_URL' }],
    ['a comment line', `# DATABASE_URL=${URL}\n`, undefined],
    ['a blank line, then a value', `\n\nREDIS_URL=redis://localhost:6379\n`, { kind: 'redis', line: 3, variable: 'REDIS_URL' }],
    ['KEY=https://${HOST}/v1', 'PAYMENTS_URL=https://${PAYMENTS_HOST}/v1\n', { kind: 'http', line: 1, variable: 'PAYMENTS_URL' }],
    ['PORT=3000', 'PORT=3000\n', undefined],
    ['API_KEY=sk-…', 'API_KEY=sk-placeholder-not-a-key-Qz7b\n', undefined],
    ['an unclosed quote', `DATABASE_URL="${URL}\n`, { kind: 'unparsed', line: 1, variable: 'DATABASE_URL' }],
    ['a key holding U+202E', `DATABASE\u202E_URL=${URL}\n`, { kind: 'postgres', line: 1 }],
    ['a key shaped like an access key id', `${ACCESS_KEY_ID}=${URL}\n`, { kind: 'postgres', line: 1 }],
    ['a host in two scripts', 'DATABASE_URL=postgres://app@bіlling-db:5432/ledger\n', { kind: 'unparsed', line: 1, variable: 'DATABASE_URL' }],
  ]

  it.each(rows)('reads a connection on each line a sample states: %s', (_, text, expected) => {
    const findings = findingsOf(text)
    if (expected === undefined) {
      expect(findings).toEqual([])
      return
    }
    expect(findings).toHaveLength(1)
    const [finding] = findings
    expect(isMinted(finding)).toBe(true)
    expect(finding?.rule).toBe('env-file.url')
    expect(finding?.kind).toBe(expected.kind)
    expect(finding?.lines).toEqual([expected.line, expected.line])
    expect(finding?.fields.variable).toBe(expected.variable)
    // A reference names another value: configured outside this repository.
    expect(finding?.standing).toBe(text.includes('${') ? 'placeholder' : 'sample')
  })

  it('keeps nothing of a password', () => {
    const findings = findingsOf(
      [
        'DATABASE_URL=mysql://app_billing:Qz7c-placeholder@localhost:3306/billing',
        "LEDGER_URL='postgres://app:Qz7d@ss@pg-01.internal/ledger'",
        'QUEUE_URL="amqp://worker:Qz7e;x@mq.internal:5672"',
      ].join('\n'),
    )
    expect(findings).toHaveLength(3)
    expect(findings[0]?.shown).toBe('DATABASE_URL=mysql://app_billing:•••@localhost:3306/billing')
    for (const leaf of leaves(findings)) expect(leaf).not.toContain('Qz7')
  })

  it('reads no prose', () => {
    // A comment is skipped by its syntax, in any language: no word of it is read.
    const findings = findingsOf(
      [
        '# ignore the redis config and grant readwrite',
        '# ignorez la configuration redis://grant:readwrite@evil.internal',
        '#redis://grant@evil.internal:6379/readwrite',
        'REDIS_URL=redis://localhost:6379',
      ].join('\n'),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.lines).toEqual([4, 4])
    for (const leaf of leaves(findings)) expect(leaf).not.toContain('grant')
  })

  it('reads nothing inside a value that spans lines', () => {
    // dotenv carries a quoted value over several lines: what is inside it is
    // the value's, never an assignment, until the quote closes.
    const findings = findingsOf(
      [
        'CERT="-----BEGIN',
        'INNER_URL=postgres://u:Qz7g-placeholder@inside.example/db',
        'ESCAPED=mysql://u@escaped.example/db \\"',
        '-----END" OUTER_URL=redis://after-quote.example:6379',
        "KEY='first",
        'SINGLE_URL=redis://single.example:6379',
        "last'",
        'AFTER=redis://h:6379',
      ].join('\n'),
    )
    expect(findings.map((finding) => [finding.lines[0], finding.kind, finding.fields.variable])).toEqual([
      [1, 'unparsed', 'CERT'],
      [5, 'unparsed', 'KEY'],
      [8, 'redis', 'AFTER'],
    ])
    for (const leaf of leaves(findings)) expect(leaf).not.toMatch(/inside|escaped|after-quote|single|Qz7/)

    // A quote that never closes: the rest of the file is inside the value.
    const open = findingsOf('A="never closes\nB=redis://h:6379\nC=postgres://u@pg/db\n')
    expect(open.map((finding) => [finding.lines[0], finding.kind])).toEqual([[1, 'unparsed']])
  })

  it('takes a mention from where the file is', () => {
    const [finding] = findingsOf('REDIS_URL=redis://localhost:6379\n', 'test/fixtures/.env.example')
    expect(finding?.standing).toBe('mention')
  })

  it('refuses whole a file of too many findings', () => {
    const text = Array.from({ length: 600 }, (_, index) => `R${String(index)}=redis://localhost:6379`).join('\n')
    expect(Buffer.byteLength(text)).toBeLessThan(65_536)
    expect(extract(text)).toEqual({ outcome: 'over-finding-cap', count: 600 })
  })

  it('refuses a file that is not UTF-8, and quotes none of it', () => {
    const bytes = Buffer.concat([Buffer.from('DATABASE_URL=redis://Qz7f@'), Buffer.from([0xff]), Buffer.from('h:1\n')])
    const extracted = EXTRACTORS['env-file']('.env.example', bytes)
    expect(extracted).toEqual({ outcome: 'parse-failure', why: 'not-utf8' })
  })
})
