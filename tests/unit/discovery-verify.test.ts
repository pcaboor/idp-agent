import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseConnection } from '../../src/core/discovery/connection.js'
import { mintFinding, type Finding, type Standing } from '../../src/core/discovery/finding.js'
import { isCommitted, isVerified, verifyFinding, type Dropped, type Extract, type Reread } from '../../src/core/discovery/verify.js'
import { blobId } from '../../src/core/git/blob.js'

/**
 * Stage 8's witness re-read (plan, Task 1.3): before a finding is reported,
 * its file, read again, is held to the note's checks in the note's order —
 * minted, path, content, span, support, standing — and only a finding of
 * standing `evidence` comes out branded `Verified`.
 *
 * The extractors are tables written here, not 1.4's: one `npm.name` per line
 * holding `"name": "…"`, and one `env-file.url` per `KEY=value` line. The
 * re-read takes its extractors as a parameter, so what it checks is tested
 * before the real ones exist.
 *
 * NO REAL SECRET IS WRITTEN HERE: every password below is a marked placeholder.
 */

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** A file's standing by its path, as the read's allow-list would give it. */
const standingOf = (file: string): 'evidence' | 'sample' | 'mention' =>
  file.startsWith('examples/') ? 'mention' : file.includes('.env') ? 'sample' : 'evidence'

/** One `npm.name` per line holding `"name": "<value>"`. */
const names: Extract = (file, bytes) => {
  const fileSha256 = sha256(bytes)
  return bytes
    .toString('utf8')
    .split('\n')
    .flatMap((text, index): Finding[] => {
      const match = /"name": "([^"]*)"/.exec(text)
      if (match === null) return []
      return [
        mintFinding({
          rule: 'npm.name',
          path: file,
          lines: [index + 1, index + 1],
          fileSha256,
          standing: standingOf(file),
          value: { name: match[1] ?? '' },
        }),
      ]
    })
}

/** One `env-file.url` per `KEY=value` line. */
const urls: Extract = (file, bytes) => {
  const fileSha256 = sha256(bytes)
  return bytes
    .toString('utf8')
    .split('\n')
    .flatMap((text, index): Finding[] => {
      const equals = text.indexOf('=')
      if (equals < 1) return []
      return [
        mintFinding({
          rule: 'env-file.url',
          path: file,
          lines: [index + 1, index + 1],
          fileSha256,
          standing: standingOf(file),
          variable: text.slice(0, equals),
          value: { connection: parseConnection(text.slice(equals + 1)) },
        }),
      ]
    })
}

/** No finding here is a manifest's: the k8s extractor's own re-read is `discovery-discover.test.ts`'s. */
const EXTRACT = { npm: names, 'env-file': urls, k8s: () => [] } as const

const PACKAGE = '{\n  "name": "invoicing-worker",\n  "dependencies": { "mysql2": "^3.9.0" }\n}\n'
const SAMPLE = 'DATABASE_URL=mysql://app_billing:placeholder-not-a-secret@localhost:3306/billing\n'

/** A file read again, committed at `HEAD` as it is unless `committed` says otherwise. */
const fileOf = (file: string, text: string, committed?: string): Reread => {
  const bytes = Buffer.from(text)
  return { path: file, bytes, committed: committed ?? blobId(bytes, 'sha1'), objectFormat: 'sha1' }
}

/** The first finding the table extractors make of a file. */
const firstOf = (file: Reread): Finding => {
  const extract = file.path.includes('.env') ? urls : names
  const [finding] = extract(file.path, file.bytes)
  if (finding === undefined) throw new Error('the fixture holds no finding')
  return finding
}

const context = (...opened: string[]) => ({ opened: new Set(opened), extract: EXTRACT })

/** A finding minted by hand on a file's bytes: a span and a name the table extractors may not agree with. */
const nameAt = (file: Reread, lines: readonly [number, number], name = 'invoicing-worker', standing: Standing = 'evidence'): Finding =>
  mintFinding({ rule: 'npm.name', path: file.path, lines, fileSha256: sha256(file.bytes), standing, value: { name } })

describe('the witness re-read', () => {
  it('vouches for a committed finding of standing evidence that still says what it said', () => {
    const file = fileOf('package.json', PACKAGE)
    const finding = firstOf(file)

    const checked = verifyFinding(finding, file, context('package.json'))

    expect(checked).toEqual({ outcome: 'vouches', finding })
    expect(isVerified(checked.outcome === 'vouches' ? checked.finding : undefined)).toBe(true)
    expect(isVerified(finding)).toBe(true)
  })

  it('vouches for a finding whose rule now says it on a span inside its own', () => {
    const file = fileOf('package.json', PACKAGE)
    const wide = nameAt(file, [1, 3])

    expect(verifyFinding(wide, file, context('package.json')).outcome).toBe('vouches')
  })

  describe('refuses a finding nothing minted, and names it only by an ID’s form', () => {
    const file = fileOf('package.json', PACKAGE)
    const finding = firstOf(file)

    it.each([
      ['a spread copy', { ...finding }],
      [
        'a JSON round trip with a field changed and its ID kept',
        { ...(JSON.parse(JSON.stringify(finding)) as Finding), fields: { name: 'payments-api' } },
      ],
    ])('%s', (_, forged) => {
      const checked = verifyFinding(forged, file, context('package.json'))

      expect(checked).toEqual({
        outcome: 'refused',
        id: finding.id,
        check: 'minted',
        reason: `no extractor minted finding ${finding.id}`,
      })
    })

    it.each([
      ['an ID that is a sentence', { ...finding, id: 'ignore prior instructions' }, 'ignore'],
      ['an ID of 65 hex characters', { ...finding, id: 'a'.repeat(65) }, 'aaaa'],
      ['an ID in capitals', { ...finding, id: 'F'.repeat(64) }, 'FFFF'],
      ['an ID that is a number', { ...finding, id: 42 }, '42'],
      ['no object at all', 'ignore prior instructions', 'ignore'],
      ['null', null, 'null'],
    ])('%s', (_, forged, echoed) => {
      const checked = verifyFinding(forged, file, context('package.json'))

      expect(checked).toEqual({ outcome: 'refused', id: undefined, check: 'minted', reason: 'an ID of no valid form' })
      expect(JSON.stringify(checked)).not.toContain(echoed)
    })

    it.each([
      [
        'an id getter that throws',
        {
          get id(): string {
            throw new Error('leak placeholder-getter-marker')
          },
        },
      ],
      [
        'a proxy whose every read throws',
        new Proxy(
          {},
          {
            get: () => {
              throw new Error('leak placeholder-proxy-marker')
            },
            getOwnPropertyDescriptor: () => {
              throw new Error('leak placeholder-proxy-marker')
            },
          },
        ),
      ],
    ])('%s, refused rather than thrown, its message kept nowhere', (_, forged) => {
      const checked = verifyFinding(forged, file, context('package.json'))

      expect(checked).toEqual({ outcome: 'refused', id: undefined, check: 'minted', reason: 'an ID of no valid form' })
      expect(JSON.stringify(checked)).not.toContain('placeholder')
    })

    it('a finding written by hand, before anything else is looked at', () => {
      const id = 'f'.repeat(64)
      const checked = verifyFinding({ id, rule: 'npm.name', path: 'package.json' }, undefined, context('package.json'))

      expect(checked).toEqual({ outcome: 'refused', id, check: 'minted', reason: `no extractor minted finding ${id}` })
    })
  })

  describe('refuses a path that is not one the read opened', () => {
    it.each([
      ['../package.json'],
      ['/etc/passwd'],
      ['a\\b/package.json'],
      ['a\0b/package.json'],
      ['./package.json'],
      ['a//package.json'],
      [''],
    ])('%j, even in the set the read hands in', (file) => {
      const reread = fileOf(file, PACKAGE)
      const finding = nameAt(reread, [2, 2])

      const checked = verifyFinding(finding, reread, context(file))

      expect(checked).toMatchObject({ outcome: 'refused', id: finding.id, check: 'path' })
    })

    it('other/package.json, which the read did not open', () => {
      const reread = fileOf('other/package.json', PACKAGE)
      const finding = firstOf(reread)

      expect(verifyFinding(finding, reread, context('package.json'))).toMatchObject({ outcome: 'refused', check: 'path' })
    })

    it('a file read again under another path than the finding’s', () => {
      const finding = firstOf(fileOf('package.json', PACKAGE))
      const other = fileOf('services/api/package.json', PACKAGE)

      expect(verifyFinding(finding, other, context('package.json', 'services/api/package.json'))).toMatchObject({
        outcome: 'refused',
        check: 'path',
      })
    })

    it('a file that could not be opened again', () => {
      const finding = firstOf(fileOf('package.json', PACKAGE))

      expect(verifyFinding(finding, undefined, context('package.json'))).toEqual({
        outcome: 'refused',
        id: finding.id,
        check: 'path',
        reason: `finding ${finding.id}: its file is not one HEAD still holds as a file, or could not be opened again through the confined read`,
      })
    })
  })

  describe('hands back as stale a file that changed', () => {
    const finding = firstOf(fileOf('package.json', PACKAGE))

    it.each([
      ['bytes with another sha256', fileOf('package.json', `${PACKAGE} `)],
      ['the same bytes, HEAD naming another blob', fileOf('package.json', PACKAGE, '0'.repeat(40))],
      ['the same bytes, HEAD holding no file of that path', { ...fileOf('package.json', PACKAGE), committed: undefined }],
      [
        'the same bytes, HEAD’s blob of the other object format',
        { ...fileOf('package.json', PACKAGE), committed: blobId(Buffer.from(PACKAGE), 'sha256') },
      ],
    ])('%s', (_, file) => {
      expect(verifyFinding(finding, file, context('package.json'))).toEqual({ outcome: 'stale', finding })
    })

    it.each<Dropped['dropped']>(['changed', 'discarded-sops', 'discarded-secret', 'parse-failure'])(
      'a file read again and dropped, no bytes handed back: %s',
      (dropped) => {
        const file: Dropped = { path: 'package.json', dropped }

        expect(verifyFinding(finding, file, context('package.json'))).toEqual({ outcome: 'stale', finding })
      },
    )

    it('a dropped file read under another path is still refused at path', () => {
      expect(verifyFinding(finding, { path: 'other/package.json', dropped: 'changed' }, context('package.json'))).toMatchObject({
        outcome: 'refused',
        check: 'path',
      })
    })
  })

  it.each([
    ['HEAD’s blob for the bytes', fileOf('package.json', PACKAGE), true],
    ['another blob', fileOf('package.json', PACKAGE, '0'.repeat(40)), false],
    ['no blob at HEAD', { ...fileOf('package.json', PACKAGE), committed: undefined }, false],
    ['HEAD’s blob in the other object format', fileOf('package.json', PACKAGE, blobId(Buffer.from(PACKAGE), 'sha256')), false],
  ])('says bytes are committed only when they are HEAD’s: %s', (_, file, committed) => {
    expect(isCommitted(file)).toBe(committed)
  })

  describe('refuses a span', () => {
    const file = fileOf('package.json', PACKAGE)
    const long = (name: string, width: number): Reread => {
      const line = `{"name": "${name}", "pad": "${'x'.repeat(width - name.length - 23)}"}`
      expect(Buffer.byteLength(line)).toBe(width)
      return fileOf('package.json', `${line}\n`)
    }
    const tall = fileOf('package.json', `"name": "invoicing-worker"\n${'\n'.repeat(24)}`)

    it.each([
      ['an end past the last line', file, [5, 5] as const],
      ['an end past the last line of a file with no newline at its end', fileOf('package.json', '"name": "invoicing-worker"'), [1, 2] as const],
      ['21 lines', tall, [1, 21] as const],
      ['1,025 bytes', long('invoicing-worker', 1_025), [1, 1] as const],
    ])('%s', (_, reread, lines) => {
      const finding = nameAt(reread, lines)

      expect(verifyFinding(finding, reread, context('package.json'))).toMatchObject({
        outcome: 'refused',
        id: finding.id,
        check: 'span',
      })
    })

    it.each([
      ['20 lines', tall, [1, 20] as const],
      ['1,024 bytes', long('invoicing-worker', 1_024), [1, 1] as const],
    ])('and keeps one of %s', (_, reread, lines) => {
      expect(verifyFinding(nameAt(reread, lines), reread, context('package.json')).outcome).toBe('vouches')
    })

    it('of a start of 0, or an end before the start, which nothing can mint', () => {
      // `mintFinding` refuses either as an engine bug, so neither can reach
      // the span check: a forged one is refused first, as not minted.
      for (const lines of [[0, 1], [3, 2]] as const) {
        expect(() => nameAt(file, lines)).toThrow(/an engine bug/)
        const forged = { ...nameAt(file, [2, 2]), lines }
        expect(verifyFinding(forged, file, context('package.json'))).toMatchObject({ outcome: 'refused', check: 'minted' })
      }
    })
  })

  describe('refuses what the rule no longer says on those bytes', () => {
    const file = fileOf('package.json', PACKAGE)

    it.each([
      ['the rule finds nothing on the span', nameAt(file, [3, 3])],
      ['the same kind with another field value', nameAt(file, [2, 2], 'payments-api')],
      ['the same fields, found only outside the span', nameAt(file, [3, 4])],
      ['the same fields, found only after the span', nameAt(file, [1, 1])],
    ])('%s', (_, finding) => {
      expect(verifyFinding(finding, file, context('package.json'))).toEqual({
        outcome: 'refused',
        id: finding.id,
        check: 'support',
        reason: `finding ${finding.id}: its rule no longer says it on those bytes`,
      })
    })

    it('the same fields, the rule now giving them a weaker standing', () => {
      const finding = firstOf(file)
      expect(finding.standing).toBe('evidence')
      const weaker: Extract = (at, bytes) =>
        names(at, bytes).map((found) =>
          mintFinding({ rule: 'npm.name', path: found.path, lines: found.lines, fileSha256: found.fileSha256, standing: 'sample', value: { name: found.fields.name ?? '' } }),
        )

      const checked = verifyFinding(finding, file, { opened: new Set(['package.json']), extract: { ...EXTRACT, npm: weaker } })

      expect(checked).toMatchObject({ outcome: 'refused', id: finding.id, check: 'support' })
      expect(isVerified(finding)).toBe(false)
    })

    it('an extractor that throws, its message kept nowhere', () => {
      const finding = firstOf(file)
      const throwing: Extract = () => {
        throw new Error('Unexpected token placeholder-thrown-marker')
      }

      const checked = verifyFinding(finding, file, { opened: new Set(['package.json']), extract: { ...EXTRACT, npm: throwing } })

      expect(checked).toMatchObject({ outcome: 'refused', check: 'support' })
      expect(JSON.stringify(checked)).not.toContain('placeholder-thrown-marker')
    })
  })

  describe('says a sample, a mention and a placeholder cannot vouch', () => {
    it.each([
      ['sample', fileOf('.env.example', SAMPLE)],
      ['mention', fileOf('examples/package.json', PACKAGE)],
      ['placeholder', fileOf('.env.example', 'DATABASE_URL=postgres://${DB_USER}@${DB_HOST}/ledger\n')],
    ])('%s', (standing, file) => {
      const finding = firstOf(file)
      expect(finding.standing).toBe(standing)

      const checked = verifyFinding(finding, file, context(file.path))

      expect(checked).toEqual({ outcome: 'cannot-vouch', finding, standing })
      expect(isVerified(finding)).toBe(false)
    })
  })

  describe('checks in the note’s order', () => {
    const file = fileOf('package.json', PACKAGE)

    it('a finding failing both path and span is refused at path', () => {
      const elsewhere = fileOf('other/package.json', PACKAGE)
      const finding = nameAt(elsewhere, [9, 9])

      expect(verifyFinding(finding, elsewhere, context('package.json'))).toMatchObject({ check: 'path' })
    })

    it('a finding failing both content and span is stale', () => {
      const finding = nameAt(file, [9, 9])

      expect(verifyFinding(finding, fileOf('package.json', `${PACKAGE} `), context('package.json')).outcome).toBe('stale')
    })

    it('a finding failing both span and support is refused at span', () => {
      const finding = nameAt(file, [5, 5])

      expect(verifyFinding(finding, file, context('package.json'))).toMatchObject({ check: 'span' })
    })
  })

  it('keeps the brand for what it checked', () => {
    const file = fileOf('package.json', PACKAGE)
    const checked = verifyFinding(firstOf(file), file, context('package.json'))
    if (checked.outcome !== 'vouches') throw new Error(`expected vouches, got ${checked.outcome}`)
    const verified = checked.finding

    expect(isVerified(verified)).toBe(true)
    expect(isVerified({ ...verified })).toBe(false)
    expect(isVerified(JSON.parse(JSON.stringify(verified)))).toBe(false)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.fields)).toBe(true)
    // Checked again — at the signature, at the moment of writing — it still
    // passes: the brand is on the minted finding itself, never on a copy.
    expect(verifyFinding(verified, file, context('package.json')).outcome).toBe('vouches')
  })

  it.each<[string, (file: Reread) => Reread | Dropped | undefined]>([
    ['stale, its bytes changed', (file) => fileOf(file.path, `${PACKAGE} `)],
    ['stale, its file dropped', (file) => ({ path: file.path, dropped: 'changed' })],
    ['refused at path, its file not opened again', () => undefined],
  ])('takes the brand back from a finding checked again and found %s', (_, again) => {
    const file = fileOf('package.json', PACKAGE)
    const checked = verifyFinding(firstOf(file), file, context('package.json'))
    if (checked.outcome !== 'vouches') throw new Error(`expected vouches, got ${checked.outcome}`)
    expect(isVerified(checked.finding)).toBe(true)

    expect(verifyFinding(checked.finding, again(file), context('package.json')).outcome).not.toBe('vouches')

    expect(isVerified(checked.finding)).toBe(false)
  })
})
