import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseDocuments, parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: {
    name: 'billing-api-billing-db-dev',
    annotations: { 'company.fr/env': 'dev' },
  },
  spec: {
    type: 'database-access', access: 'read',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/billing-db-dev'],
  },
}

/** The same right, stating the level it grants. */
const grant: Entity = {
  ...entity,
  spec: {
    type: 'database-access',
    access: 'read',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/billing-db-dev'],
    dependencyOf: ['component:default/billing-api'],
  },
}

const withAnnotations = (annotations: Record<string, string>): Entity => ({
  ...entity,
  metadata: { name: 'x', annotations },
})

describe('serializeEntity', () => {
  it('emits keys in a fixed order', () => {
    const lines = serializeEntity(entity).split('\n')
    expect(lines[0]).toBe('apiVersion: backstage.io/v1alpha1')
    expect(lines[1]).toBe('kind: Resource')
    expect(lines[2]).toBe('metadata:')
  })

  it('ends in exactly one newline and never starts with a document marker', () => {
    const output = serializeEntity(entity)
    expect(output.endsWith('\n')).toBe(true)
    expect(output.endsWith('\n\n')).toBe(false)
    expect(output.startsWith('---')).toBe(false)
  })

  it('is stable across calls', () => {
    expect(serializeEntity(entity)).toBe(serializeEntity(entity))
  })

  it('omits an empty annotations map rather than writing an empty mapping', () => {
    expect(serializeEntity(withAnnotations({}))).not.toContain('annotations')
  })

  it('writes the level of a grant immediately after its type', () => {
    // Order is fixed by insertion, not sorted, so a reviewer reads "this is a
    // database-access, and it grants read" as one statement rather than
    // hunting for the level below the owner.
    const lines = serializeEntity(grant).split('\n')
    const spec = lines.indexOf('spec:')
    expect(lines[spec + 1]).toBe('  type: database-access')
    expect(lines[spec + 2]).toBe('  access: read')
    expect(lines[spec + 3]).toBe('  owner: group:default/tiger')
  })

  it('writes no level when none was declared, rather than a default', () => {
    // Absent is absent. Emitting `access: readwrite` for a right that states
    // nothing would be this design's one forbidden guess, written into the
    // repository (design 4.1).
    const unlevelled = {
      ...entity,
      spec: { ...entity.spec, access: undefined },
    } as typeof entity
    expect(serializeEntity(unlevelled)).not.toContain('  access:')
  })

  it('never folds a long value across lines, which would ruin the diff', () => {
    const long = withAnnotations({ note: 'word '.repeat(60).trim() })
    const valueLines = serializeEntity(long)
      .split('\n')
      .filter((line) => line.includes('word'))
    expect(valueLines).toHaveLength(1)
  })
})

describe('values YAML would read back as something else', () => {
  // This is the whole reason the model never writes YAML: each of these is a
  // string that an unquoted emitter turns into a number, a boolean or null.
  const traps = {
    numeric: '123',
    float: '1.0',
    octalish: '0755',
    yamlTrue: 'true',
    yamlNo: 'no',
    yamlYes: 'yes',
    yamlOn: 'on',
    yamlOff: 'off',
    shortY: 'y',
    shortN: 'n',
    yamlNull: 'null',
    tilde: '~',
    alias: '*star',
    anchor: '&anchor',
    colon: 'key: value',
    hash: 'value # not a comment',
    leadingSpace: '  padded',
    unicode: 'café — naïve 日本語',
    emptyish: '',
  }

  it('reads every trap back as the same string', () => {
    const round = parseEntity(serializeEntity(withAnnotations(traps)))
    expect(round.metadata.annotations).toEqual(traps)
  })

  it('round-trips a plain entity', () => {
    expect(parseEntity(serializeEntity(entity))).toEqual(entity)
  })

  it('round-trips a right that states the level it grants', () => {
    // `read` is a bare word an emitter is free to leave unquoted and a reader
    // free to hand back as something else; the round trip is what says it
    // comes home as the same string.
    expect(parseEntity(serializeEntity(grant))).toEqual(grant)
  })

  it('quotes anything a YAML 1.1 reader would take for a boolean', () => {
    // The round-trip above reads back with the same library, which is YAML 1.2:
    // it proves self-consistency, not interoperability. PyYAML, Ruby and Go's
    // yaml.v2 read 1.1, where `no` is false. The IaC repository is read by more
    // than this tool, so the output must be unambiguous for them too.
    const document = serializeEntity(withAnnotations(traps))
    const asYaml11 = parse(document, { version: '1.1' }) as {
      metadata: { annotations: Record<string, string> }
    }
    expect(asYaml11.metadata.annotations).toEqual(traps)
  })
})

describe('parseDocuments, the one reader of entity documents', () => {
  // `toJS()` hands back a value for a document the parser has already said is
  // broken: the last of two duplicate keys, the half of an unclosed sequence
  // it managed to read. Taking that value is how a duplicate key passed as
  // "0 violations", and how a surgery that broke a file's syntax passed the
  // re-check that reads its output.
  const grant = (...spec: string[]): string =>
    [
      '---',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      '  name: billing-api-billing-db-dev',
      'spec:',
      '  type: database-access',
      '  owner: group:default/tiger',
      ...spec,
      '',
    ].join('\n')

  it('refuses a document with a duplicate key, naming the line, column and code', () => {
    const { entities, rejections } = parseDocuments(
      grant('  dependencyOf:', '    - component:default/a', '  dependencyOf:', '    - component:default/b'),
    )
    expect(entities).toEqual([])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toContain('DUPLICATE_KEY')
    expect(rejections[0]).toContain('11:3')
  })

  it('refuses an unclosed flow sequence rather than reading half of it', () => {
    const { entities, rejections } = parseDocuments(
      grant('  dependencyOf: [component:default/a, component:default/b'),
    )
    expect(entities).toEqual([])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toMatch(/^\d+:\d+ [A-Z_]+ /)
  })

  it('refuses an alias bomb instead of throwing', () => {
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]',
      'e: [*d, *d, *d, *d, *d, *d, *d, *d, *d]',
      '',
    ].join('\n')
    const read = () => parseDocuments(bomb)
    expect(read).not.toThrow()
    expect(read().rejections).toHaveLength(1)
    expect(read().rejections[0]).toMatch(/alias/i)
  })

  it('keeps the documents it can read beside the one it cannot', () => {
    const file = `${grant('  owner: group:default/twice')}\n${grant()}`
    const { entities, rejections, documents } = parseDocuments(file)
    expect(entities.map((entity) => entity.metadata.name)).toEqual(['billing-api-billing-db-dev'])
    expect(rejections).toHaveLength(1)
    expect(documents).toBe(2)
  })

  it('counts a null document, which a witness is made of, and rejects nothing for it', () => {
    expect(parseDocuments('---\n')).toEqual({ entities: [], rejections: [], documents: 1 })
  })
})
