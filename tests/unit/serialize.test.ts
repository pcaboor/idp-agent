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

  it("writes an entity's links and system where Backstage's examples put them", () => {
    // Only an entity READ from a repository carries them — a proposal cannot —
    // so the engine's own writes never do. Written, they round-trip.
    const described: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: 'artist-web',
        description: 'The place to be, for great artists',
        annotations: {},
        tags: ['java'],
        links: [{ url: 'https://admin.example-org.com', title: 'Admin Dashboard' }],
      },
      spec: {
        type: 'website',
        lifecycle: 'production',
        owner: 'group:default/artist-relations-team',
        system: 'system:default/public-websites',
      },
    }
    expect(serializeEntity(described)).toBe(
      [
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: artist-web',
        '  description: The place to be, for great artists',
        '  tags:',
        '    - java',
        '  links:',
        '    - url: https://admin.example-org.com',
        '      title: Admin Dashboard',
        'spec:',
        '  type: website',
        '  lifecycle: production',
        '  owner: group:default/artist-relations-team',
        '  system: system:default/public-websites',
        '',
      ].join('\n'),
    )
    expect(parseEntity(serializeEntity(described))).toEqual(described)

    const resource: Entity = { ...grant, spec: { ...grant.spec, system: 'system:default/billing' } }
    const lines = serializeEntity(resource).split('\n')
    expect(lines.indexOf('  system: system:default/billing')).toBe(
      lines.indexOf('  owner: group:default/tiger') + 1,
    )
    expect(parseEntity(serializeEntity(resource))).toEqual(resource)
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
    // Strings to YAML 1.1 and numbers to YAML 1.2, which is what this library
    // and Backstage read: a 1.2 octal, and an exponent with no decimal point.
    octal12: '0o17',
    exponent: '1e3',
    exponentUpper: '1E3',
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

  it('round-trips a name only YAML 1.2 would read as a number', () => {
    // `0o1` is a valid Backstage name. Quoted for 1.1 alone, it went out bare
    // and came back as the number 1 — the counterexample the property test
    // "serialise then reload" hit about once in two hundred thousand runs.
    const named = { ...entity, metadata: { ...entity.metadata, name: '0o1' } }
    expect(parseEntity(serializeEntity(named))).toEqual(named)
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
    expect(parseDocuments('---\n')).toEqual({
      entities: [],
      apis: [],
      rejections: [],
      ignored: [],
      documents: 1,
    })
  })
})

describe('parseDocuments over a real Backstage catalogue', () => {
  // A declarations repository is often the company's catalogue as well: Groups,
  // Users, Systems, APIs, Locations beside the entities this tool manages, and a
  // mkdocs.yml or renovate.yaml at the root. Refusing each of those made
  // `validate` red on a catalogue Backstage reads without complaint; dropping
  // them would be the silent ignore the tool exists to compensate for. They are
  // set aside, and said to be — all but the API, which is read with a schema of
  // its own (api-reader.test.ts).
  const document = (...lines: string[]): string => ['---', ...lines, ''].join('\n')
  const read = (...lines: string[]) => parseDocuments(document(...lines))

  it('sets aside a mapping that declares neither apiVersion nor kind', () => {
    const { entities, rejections, ignored } = read('site_name: Billing', 'nav:', '  - Home: index.md')
    expect(entities).toEqual([])
    expect(rejections).toEqual([])
    expect(ignored).toEqual([{ reason: 'not a catalogue entity: no apiVersion or kind' }])
  })

  it.each([
    ['Group', 'team-a', 'kind Group is not modelled by this tool; group team-a left as is'],
    ['System', 'payments', 'kind System is not modelled by this tool; system payments left as is'],
    ['User', 'jdoe', 'kind User is not modelled by this tool; user jdoe left as is'],
    ['Location', 'root', 'kind Location is not modelled by this tool; location root left as is'],
    ['Template', 'new-service', 'kind Template is not modelled by this tool; template new-service left as is'],
  ])('sets aside a %s, naming its kind and name', (kind, name, reason) => {
    const { entities, rejections, ignored } = read(
      'apiVersion: backstage.io/v1alpha1',
      `kind: ${kind}`,
      'metadata:',
      `  name: ${name}`,
      'spec: {}',
    )
    expect(entities).toEqual([])
    expect(rejections).toEqual([])
    expect(ignored).toEqual([{ kind, reason, ref: `${kind.toLowerCase()}:default/${name}` }])
  })

  it('sets aside a kind of its own, declared under its own apiVersion', () => {
    const { rejections, ignored } = read(
      'apiVersion: acme.com/v1',
      'kind: Gadget',
      'metadata:',
      '  name: widget',
    )
    expect(rejections).toEqual([])
    expect(ignored).toEqual([
      {
        kind: 'Gadget',
        reason: 'kind Gadget is not modelled by this tool; gadget widget left as is',
        ref: 'gadget:default/widget',
      },
    ])
  })

  // Backstage's own group defines a closed set of kinds. Under it, a kind it
  // does not define is a typo, not somebody's own kind — and set aside, a
  // mistyped `Resouce` would pass CI as a warning with the entity missing.
  it.each(['Resouce', 'Componet', 'Gadget'])(
    'refuses %s under Backstage’s own apiVersion, naming the kinds it defines',
    (kind) => {
      const { entities, rejections, ignored } = read(
        'apiVersion: backstage.io/v1alpha1',
        `kind: ${kind}`,
        'metadata:',
        '  name: orders-db-prod',
      )
      expect(entities).toEqual([])
      expect(ignored).toEqual([])
      expect(rejections).toEqual([
        `kind ${kind} is not one Backstage defines under backstage.io/v1alpha1 ` +
          '(API, Component, Domain, Group, Location, Resource, System, Template, User)',
      ])
    },
  )

  it('matches Backstage’s kinds case-insensitively, as Backstage does', () => {
    const { rejections, ignored } = read('apiVersion: backstage.io/v1alpha1', 'kind: group')
    expect(rejections).toEqual([])
    expect(ignored.map((one) => one.kind)).toEqual(['group'])
  })

  it('sets aside a Kubernetes Deployment, whatever its apiVersion', () => {
    const { rejections, ignored } = read(
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: billing-api',
    )
    expect(rejections).toEqual([])
    expect(ignored).toEqual([
      {
        kind: 'Deployment',
        reason: 'kind Deployment is not modelled by this tool; deployment billing-api left as is',
        ref: 'deployment:default/billing-api',
      },
    ])
  })

  it('names no entity when the set-aside document states no name', () => {
    expect(read('apiVersion: backstage.io/v1alpha1', 'kind: System').ignored).toEqual([
      { kind: 'System', reason: 'kind System is not modelled by this tool; left as is' },
    ])
  })

  it('reads a Component through the strict schema, beside the documents it sets aside', () => {
    const { entities, rejections, ignored, documents } = parseDocuments(
      [
        document(
          'apiVersion: backstage.io/v1alpha1',
          'kind: Component',
          'metadata:',
          '  name: billing-api',
          'spec:',
          '  type: service',
          '  lifecycle: production',
          '  owner: group:default/tiger',
        ),
        document('apiVersion: backstage.io/v1alpha1', 'kind: Group', 'metadata:', '  name: tiger'),
      ].join('\n'),
    )
    expect(entities.map((entity) => entity.metadata.name)).toEqual(['billing-api'])
    expect(rejections).toEqual([])
    expect(ignored.map((one) => one.kind)).toEqual(['Group'])
    expect(documents).toBe(2)
  })

  it('still refuses a Resource the schema refuses: stricter than Backstage on purpose', () => {
    const { rejections, ignored } = read(
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      '  name: orders-db',
      'spec:',
      '  type: database',
    )
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toMatch(/owner/)
  })

  it('refuses a kind that is Component or Resource spelled in another case', () => {
    // Backstage compares kinds case-insensitively, so this IS a Component to
    // the catalogue. Setting it aside would turn a declaration this tool
    // manages into a warning; the strict schema refuses it instead.
    const { rejections, ignored } = read(
      'apiVersion: backstage.io/v1alpha1',
      'kind: component',
      'metadata:',
      '  name: billing-api',
    )
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
  })

  it('refuses a backstage.io document that states no kind', () => {
    const { rejections, ignored } = read('apiVersion: backstage.io/v1alpha1', 'metadata:', '  name: x')
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
  })

  it('refuses a backstage.io document that states no kind, even with nothing else', () => {
    const { rejections, ignored } = read('apiVersion: backstage.io/v1beta1')
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
  })

  it('sets aside a document of another tool that has an apiVersion and no kind', () => {
    // A Helm Chart.yaml: `apiVersion: v2` is Helm's, and the chart is common in
    // an IaC repository. Only Backstage's apiVersion makes a kindless document
    // a failed entity.
    const { rejections, ignored } = read('apiVersion: v2', 'name: web', 'version: 0.1.0')
    expect(rejections).toEqual([])
    expect(ignored).toEqual([{ reason: 'not a catalogue entity: no kind' }])
  })

  it.each([
    ['metadata', ['metadata:', '  name: orders-db']],
    ['spec', ['spec:', '  type: database']],
  ])('refuses a mapping with a %s and no header, which is an entity missing its header', (_, lines) => {
    const { rejections, ignored } = read(...lines)
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
  })

  it.each([
    ['empty', '""'],
    ['blank', '"   "'],
  ])('refuses a document whose kind is %s, which names nobody\'s kind', (_, kind) => {
    const { rejections, ignored } = read(
      'apiVersion: backstage.io/v1alpha1',
      `kind: ${kind}`,
      'metadata:',
      '  name: blank',
    )
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
  })

  it('quotes a kind or a name that is not plain, so the reason cannot forge a line', () => {
    // The reason is printed to the CI log and a terminal, and neither field
    // went through the entity schema. A newline there would start a line of
    // its own — an `error` line, a `::error::` annotation — and an escape
    // sequence would reach the reviewer's terminal.
    const [set] = read(
      'apiVersion: acme.com/v1',
      'kind: "Gro\\u001b[31mup"',
      'metadata:',
      '  name: "x\\n::error file=a.yml::forged\\u009b2K"',
    ).ignored
    expect(set?.reason).toBe(
      'kind "Gro\\u001b[31mup" is not modelled by this tool; ' +
        '"gro\\u001b[31mup" "x\\n::error file=a.yml::forged\\u009b2K" left as is',
    )
    expect(set?.reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  })

  it('quotes a kind that is not plain in the refusal of a misdeclared kind too', () => {
    const [refused] = read(
      'apiVersion: backstage.io/v1alpha1',
      'kind: "Reso\\u001b[31muce\\n::error::forged"',
    ).rejections
    expect(refused).toMatch(/^kind "Reso\\u001b\[31muce\\n::error::forged" is not one Backstage/)
    expect(refused).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  })

  it('names the reference of a set-aside document, so a dependency on it is not dangling', () => {
    const [set] = read(
      'apiVersion: backstage.io/v1alpha1',
      'kind: System',
      'metadata:',
      '  name: Billing-Events',
      '  namespace: payments',
    ).ignored
    // Backstage compares references case-insensitively, and a `dependsOn` this
    // tool accepts is written in lower case.
    expect(set?.ref).toBe('system:payments/billing-events')
  })

  it('refuses a document whose kind is not a string', () => {
    const { rejections, ignored } = read('apiVersion: backstage.io/v1alpha1', 'kind: 42')
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
  })

  it.each([
    ['a scalar', 'just a sentence'],
    ['a sequence', '- a\n- b'],
  ])('refuses %s, which is not a mapping', (_, body) => {
    const { rejections, ignored } = parseDocuments(`---\n${body}\n`)
    expect(ignored).toEqual([])
    expect(rejections).toHaveLength(1)
  })
})
