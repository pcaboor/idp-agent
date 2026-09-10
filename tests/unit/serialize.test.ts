import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: {
    name: 'billing-api-billing-db-dev',
    annotations: { 'company.fr/env': 'dev' },
  },
  spec: {
    type: 'database-access',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/billing-db-dev'],
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
