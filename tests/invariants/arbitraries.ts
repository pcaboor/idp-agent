import fc from 'fast-check'
import {
  ACCESS_LEVELS,
  RESOURCE_TYPE_NAMES,
  levelledOf,
  natureOf,
  type AccessLevel,
} from '../../src/core/schemas/resource-types.js'
import { COMPONENT_LIFECYCLES, type Entity } from '../../src/core/schemas/entity.js'
import { serializeEntity } from '../../src/core/yaml/serialize.js'
import { insertDocument } from '../../src/core/yaml/surgery.js'

const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
const middle = [...alnum, '-', '.', '_']

/** Built valid by construction rather than filtered, so no run is wasted. */
export const entityName = fc
  .tuple(
    fc.constantFrom(...alnum),
    fc.array(fc.constantFrom(...middle), { maxLength: 18 }),
    fc.constantFrom(...alnum),
  )
  .map(([first, body, last]) => first + body.join('') + last)

const LF = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

/** Strings a YAML emitter is tempted to write unquoted, plus ordinary text. */
const annotationValue = fc.oneof(
  fc.constantFrom(
    'no',
    'yes',
    'on',
    'off',
    'y',
    'n',
    'true',
    'false',
    '123',
    '1.0',
    '0755',
    '~',
    'null',
    '*star',
    '&anchor',
    'key: value',
    'value # not a comment',
    '  padded  ',
    '',
    'cafe naive',
    '---',
    `line one${LF}line two`,
    `a${TAB}tab`,
  ),
  fc.string({ maxLength: 24 }),
)

/**
 * A spec, carrying a level only where the registry lets one go (design 4.1).
 *
 * Built valid by construction rather than filtered, for `entityName`'s reason:
 * half the types are objects, and a filter would throw those runs away. The
 * nature decides, so adding a type adds its shape here with no edit.
 *
 * `undefined` is one of the three outcomes and not an oversight — an access
 * written before the field exists states no level, and that is what most of a
 * real repository looks like. A generator that always states one would cover
 * the field and miss the common case.
 */
const arbitrarySpec = fc
  .record({
    type: fc.constantFrom(...RESOURCE_TYPE_NAMES),
    level: fc.constantFrom<(AccessLevel | undefined)[]>(...ACCESS_LEVELS, undefined),
    owner: entityName.map((group) => `group:default/${group}`),
  })
  .map(({ type, level, owner }) =>
    // Spread rather than `access: level`: under exactOptionalPropertyTypes an
    // explicit undefined is not an absent field, and the schema refuses it.
    natureOf(type) === 'right' && level !== undefined
      ? { type, access: level, owner }
      : { type, owner },
  )

export const arbitraryEntity: fc.Arbitrary<Entity> = fc.record({
  apiVersion: fc.constant('backstage.io/v1alpha1' as const),
  kind: fc.constant('Resource' as const),
  metadata: fc.record({
    name: entityName,
    annotations: fc.dictionary(
      fc.constantFrom('company.fr/env', 'team', 'note', 'idp-agent.dev/origin'),
      annotationValue,
      { maxKeys: 3 },
    ),
  }),
  spec: arbitrarySpec,
})

/** Files built the way the tool builds them: one document per entity. */
export const arbitraryFile = fc
  .uniqueArray(arbitraryEntity, {
    minLength: 0,
    maxLength: 4,
    selector: (entity) => entity.metadata.name,
  })
  .map((entities) =>
    entities.reduce((file, entity) => insertDocument(file, serializeEntity(entity)), ''),
  )

/**
 * One document as somebody typed it, each trait drawn on its own: the order of
 * the keys, the indentation, a quoted name, comments trailing a key or sitting
 * at column zero inside the spec, a comment introducing the document, an
 * anchor and its alias, a flow mapping, a literal block whose lines look like
 * a comment and a key, a blank line inside, and — on a grant — its consumers as
 * a block sequence at either indentation, a flow sequence, an empty one, or
 * none. `kind` and `type` vary too, so a file holds things, rights and
 * Components side by side, the way a declarations repository does.
 *
 * Every shape is YAML the parser reads: a file that does not parse is not a
 * catalogue file, and a property over one would be about the parser.
 */
const arbitraryHandWrittenDocument = fc.record({
  name: entityName,
  kind: fc.constantFrom('Resource' as const, 'Component' as const),
  type: fc.constantFrom('database', 'database-access', 'network-access'),
  level: fc.constantFrom<(AccessLevel | undefined)[]>(...ACCESS_LEVELS, undefined),
  consumers: fc.uniqueArray(entityName.map((one) => `component:default/${one}`), {
    maxLength: 3,
  }),
  consumersAs: fc.constantFrom('block', 'flush', 'flow', 'empty-flow', 'absent'),
  reversedKeys: fc.boolean(),
  indent: fc.constantFrom(2, 4),
  quoting: fc.constantFrom('plain', 'single', 'double'),
  trailingComments: fc.boolean(),
  columnZero: fc.boolean(),
  header: fc.boolean(),
  anchor: fc.boolean(),
  flowAnnotations: fc.boolean(),
  literal: fc.boolean(),
  innerBlank: fc.boolean(),
})

export type HandWrittenDocument = typeof arbitraryHandWrittenDocument extends fc.Arbitrary<
  infer T
>
  ? T
  : never

/** The lines of one document, without its marker and its header comment. */
function documentLines(document: HandWrittenDocument): string[] {
  const pad = ' '.repeat(document.indent)
  const note = (text: string): string => (document.trailingComments ? ` # ${text}` : '')
  const name =
    document.quoting === 'single'
      ? `'${document.name}'`
      : document.quoting === 'double'
        ? `"${document.name}"`
        : document.name
  // The anchor goes on whichever block the reader meets first, so the alias
  // always follows it: YAML refuses an alias to an anchor not yet seen.
  const anchored = (first: boolean): string =>
    document.anchor ? (first ? '&team group:default/legacy' : '*team') : 'group:default/legacy'

  const annotations = document.flowAnnotations
    ? [`${pad}annotations: { company.fr/env: prod, team: ${anchored(!document.reversedKeys)} }`]
    : [
        `${pad}annotations:${note('set by hand')}`,
        `${pad}${pad}company.fr/env: prod`,
        `${pad}${pad}team: ${anchored(!document.reversedKeys)}`,
      ]
  const description = document.literal
    ? [
        `${pad}description: |`,
        `${pad}${pad}kept as written`,
        `${pad}${pad}# not a comment, a line of the text`,
        `${pad}${pad}owner: not a key either`,
      ]
    : []
  const metadata = [
    `metadata:${note('identity')}`,
    `${pad}name: ${name}${note('do not rename')}`,
    ...description,
    ...annotations,
  ]

  const rights = document.kind === 'Resource' && document.type !== 'database'
  const items = document.consumers.map(
    (consumer) => `${document.consumersAs === 'flush' ? pad : pad + pad}- ${consumer}`,
  )
  const dependencyOf = !rights
    ? []
    : document.consumersAs === 'flow'
      ? [`${pad}dependencyOf: [${document.consumers.join(', ')}]${note('who reads it')}`]
      : document.consumersAs === 'empty-flow'
        ? [`${pad}dependencyOf: []${note('nobody yet')}`]
        : document.consumersAs === 'absent' || document.consumers.length === 0
          ? []
          : [`${pad}dependencyOf:${note('who reads it')}`, ...items]
  const level =
    document.kind === 'Resource' && document.type === 'database-access' && document.level
      ? [`${pad}access: ${document.level}`]
      : []
  const spec =
    document.kind === 'Component'
      ? [
          `spec:${note('the service')}`,
          `${pad}type: service`,
          `${pad}lifecycle: production`,
          ...(document.columnZero ? ['# owner below, reviewed by tiger'] : []),
          `${pad}owner: ${anchored(document.reversedKeys)}`,
        ]
      : [
          `spec:${note('the grant')}`,
          `${pad}type: ${document.type}`,
          ...level,
          ...(document.columnZero ? ['# owner below, reviewed by tiger'] : []),
          `${pad}owner: ${anchored(document.reversedKeys)}`,
          ...dependencyOf,
        ]

  const head = document.reversedKeys
    ? [`kind: ${document.kind}`, 'apiVersion: backstage.io/v1alpha1']
    : ['apiVersion: backstage.io/v1alpha1', `kind: ${document.kind}`]
  const blank = document.innerBlank ? [''] : []
  return document.reversedKeys
    ? [...head, ...spec, ...blank, ...metadata]
    : [...head, ...metadata, ...blank, ...spec]
}

/**
 * What a whole file varies on its own, beside its documents: a byte-order mark,
 * CRLF endings, a first document with no `---` (YAML reads what precedes the
 * first marker as a document), a comment opening the file, one or two blank
 * lines between documents, a `...` closing each, and a last line that ends in
 * a line break or does not.
 */
const fileTraitsDrawn = {
  bom: fc.boolean(),
  crlf: fc.boolean(),
  implicitFirst: fc.boolean(),
  opening: fc.boolean(),
  gap: fc.constantFrom(1, 2),
  documentEnd: fc.boolean(),
  finalNewline: fc.boolean(),
}
const fileTraits = fc.record(fileTraitsDrawn)

type FileTraits = typeof fileTraits extends fc.Arbitrary<infer T> ? T : never

export interface HandWrittenFile {
  readonly text: string
  readonly documents: readonly HandWrittenDocument[]
}

/** The bytes of a file holding `documents`, shaped by `traits`. */
function fileText(documents: readonly HandWrittenDocument[], traits: FileTraits): string {
  const lines: string[] = traits.opening ? ['# declared by hand, kept by hand'] : []
  documents.forEach((document, index) => {
    if (index > 0) lines.push(...Array<string>(traits.gap).fill(''))
    const header = document.header ? [`# hand written note about ${document.name}`] : []
    const marker = index === 0 && traits.implicitFirst ? [] : ['---']
    lines.push(...header, ...marker, ...documentLines(document))
    if (traits.documentEnd) lines.push('...')
  })
  const eol = traits.crlf ? '\r\n' : '\n'
  const end = traits.finalNewline ? eol : ''
  // No document and no comment: an empty file, or a mark alone on its line —
  // what an editor saving an empty file with a byte-order mark leaves.
  if (lines.length === 0) return traits.bom ? `\uFEFF${end}` : ''
  return (traits.bom ? '\uFEFF' : '') + lines.join(eol) + end
}

/**
 * Files as a human left them, not as this tool would write them.
 *
 * Generating them with insertDocument instead would make every byte-for-byte
 * property vacuous — the file would already be normalised by the very code
 * under test, and any self-consistent implementation would pass. So would
 * generating them in one shape: `---`, two spaces, LF and no mark was the only
 * one this produced, and "byte for byte" was proven on files already written
 * the way the serialiser writes them (core-yaml-6).
 *
 * `held` holds some traits still, for a property that one shape breaks.
 */
export const handWrittenFileOf = (held: Partial<typeof fileTraitsDrawn> = {}) =>
  fc
    .record({
      documents: fc.uniqueArray(arbitraryHandWrittenDocument, {
        minLength: 0,
        maxLength: 4,
        selector: (document) => document.name,
      }),
      traits: fc.record({ ...fileTraitsDrawn, ...held }),
    })
    .map(
      ({ documents, traits }): HandWrittenFile => ({
        text: fileText(documents, traits),
        documents,
      }),
    )

export const arbitraryHandWritten = handWrittenFileOf()
export const arbitraryHandWrittenFile = arbitraryHandWritten.map((file) => file.text)

/**
 * The same files, every one ending in a line break: what the two byte-for-byte
 * round trips run over. A file whose last line has none gains one when a
 * document is inserted, and removing the document cannot know the break was
 * never there, so §9.2's "insert then remove yields the file byte for byte"
 * does not hold for it. Found by these generators, left open, and pinned in
 * `core.test.ts` at the exact bytes it comes back as. Every other property
 * holds for such a file and draws it.
 */
export const arbitraryHandWrittenFileEndingInBreak = handWrittenFileOf({
  finalNewline: fc.constant(true),
}).map((file) => file.text)

/**
 * A database and a right over it, which the proposal schema accepts: a right
 * is over something and granted to somebody (§4.1). The plans generated
 * before it could not produce one, their rights carrying neither `dependsOn`
 * nor `dependencyOf`, which the schema refuses — so without this, §9.2's
 * idempotence property never met a grant.
 *
 * The intent names the database, the consumer and the right, so the composed
 * right name is vouched for by a person's words. The level and the
 * environment are not: no word states either, and a property answers them at
 * their paths (`provenanceOf` in core.test.ts).
 */
export const arbitraryGrantPlan = fc
  .record({
    database: entityName,
    consumer: entityName,
    env: fc.constantFrom('dev', 'staging', 'prod'),
    level: fc.constantFrom('read', 'readwrite'),
  })
  .filter(({ database, consumer }) => database !== consumer)
  .map(({ database, consumer, env, level }) => {
    const right = `${consumer}-${database}`.slice(0, 63).replace(/[._-]+$/, '')
    return {
      intent:
        `declare ${database} in ${env} owned by group:default/tiger and give ` +
        `component:default/${consumer} ${right} on resource:default/${database}`,
      operations: [
        {
          op: 'create-entity' as const,
          entity: {
            kind: 'Resource' as const,
            metadata: { name: database, env },
            spec: { type: 'database', owner: 'group:default/tiger' },
          },
        },
        {
          op: 'create-entity' as const,
          entity: {
            kind: 'Resource' as const,
            metadata: { name: right, env },
            spec: {
              type: 'database-access',
              access: level,
              owner: 'group:default/tiger',
              dependsOn: [`resource:default/${database}`],
              dependencyOf: [`component:default/${consumer}`],
            },
          },
        },
      ],
    }
  })

/**
 * A value, or the question §5.4 lets a model put in its place. Both are
 * proposals the schema accepts, and the signer walks each differently.
 */
const orUnknown = <T>(value: fc.Arbitrary<T>): fc.Arbitrary<T | { unknown: string }> =>
  fc.oneof(
    { weight: 4, arbitrary: value },
    { weight: 1, arbitrary: fc.constant({ unknown: 'which one is it?' }) },
  )

const componentRef = entityName.map((one) => `component:default/${one}`)
const owner = fc.constantFrom('group:default/tiger', 'group:default/common', 'group:default/ghost')

/**
 * A Resource proposal the schema accepts, built that way rather than filtered:
 * a right is over something and granted to somebody, states a level exactly
 * when its type is levelled, and a thing lists no consumers (§4.1). The
 * proposals generated before drew those independently, so the schema refused
 * most of them, and a property about what the signer does with a plan it
 * accepted was proven over the few left (tests-3).
 */
const resourceOf = (
  chosen: <T>(value: fc.Arbitrary<T>) => fc.Arbitrary<T | { unknown: string }>,
) =>
  fc
    .record({
      name: entityName,
      env: chosen(fc.constantFrom('dev', 'staging', 'prod')),
      type: fc.constantFrom(...RESOURCE_TYPE_NAMES),
      level: chosen(fc.constantFrom(...ACCESS_LEVELS)),
      owner: chosen(owner),
      over: entityName.map((one) => `resource:default/${one}`),
      consumers: fc.uniqueArray(componentRef, { minLength: 1, maxLength: 3 }),
      dependsOn: fc.boolean(),
    })
    .map(({ name, env, type, level, owner, over, consumers, dependsOn }) => {
      const right = natureOf(type) === 'right'
      return {
        kind: 'Resource' as const,
        metadata: { name, env },
        spec: {
          type,
          owner,
          ...(levelledOf(type) ? { access: level } : {}),
          ...(right || dependsOn ? { dependsOn: [over] } : {}),
          ...(right ? { dependencyOf: consumers } : {}),
        },
      }
    })

const arbitraryValidResource = resourceOf(orUnknown)

/** The same, every field it chooses a value: a creation `planEdits` writes. */
export const arbitraryStatedResource = resourceOf((value) => value)

/** A Component proposal: never filed in a declarations repository, and still signed. */
const arbitraryValidComponent = fc
  .record({
    name: entityName,
    type: orUnknown(fc.constantFrom('service', 'website', 'library')),
    lifecycle: orUnknown(fc.constantFrom(...COMPONENT_LIFECYCLES)),
    owner: orUnknown(owner),
    dependsOn: fc.uniqueArray(entityName.map((one) => `resource:default/${one}`), {
      maxLength: 2,
    }),
  })
  .map(({ name, type, lifecycle, owner, dependsOn }) => ({
    kind: 'Component' as const,
    metadata: { name },
    spec: { type, lifecycle, owner, ...(dependsOn.length > 0 ? { dependsOn } : {}) },
  }))

/**
 * A consumer joined to a grant that exists, stating the grant's level, saying
 * it cannot determine it, or stating none — the three a patch may carry.
 */
const arbitraryValidUpdate = fc
  .record({
    grant: entityName,
    consumer: componentRef,
    level: fc.constantFrom<(AccessLevel | { unknown: string } | undefined)[]>(
      ...ACCESS_LEVELS,
      { unknown: 'read or readwrite?' },
      undefined,
    ),
  })
  .map(({ grant, consumer, level }) => ({
    op: 'update-entity' as const,
    entityRef: `resource:default/${grant}`,
    patch: {
      patch: 'add-dependency-of' as const,
      consumer,
      ...(level === undefined ? {} : { access: level }),
    },
  }))

/**
 * Plans the proposal schema accepts, by construction: Resources of every type,
 * Components, and updates, mixed, with `arbitraryGrantPlan`'s database and its
 * right beside them. The intent is filler — a property that needs the words
 * to vouch for values builds its own provenance.
 */
export const arbitraryValidPlan = fc.oneof(
  fc.record({
    intent: fc.string({ minLength: 1, maxLength: 120 }),
    operations: fc.array(
      fc.oneof(
        arbitraryValidResource.map((entity) => ({ op: 'create-entity' as const, entity })),
        arbitraryValidComponent.map((entity) => ({ op: 'create-entity' as const, entity })),
        arbitraryValidUpdate,
      ),
      { minLength: 1, maxLength: 4 },
    ),
  }),
  arbitraryGrantPlan,
)

/**
 * A hand-written file holding `target` among other hand-written documents, at
 * any position: the file an update amends is one somebody wrote, in whatever
 * shape they wrote it.
 */
export const handWrittenAround = (target: fc.Arbitrary<HandWrittenDocument>) =>
  fc
    .record({
      others: fc.uniqueArray(arbitraryHandWrittenDocument, {
        maxLength: 3,
        selector: (document) => document.name,
      }),
      target,
      at: fc.nat(3),
      traits: fileTraits,
    })
    .map(({ others, target, at, traits }) => {
      const kept = others.filter((other) => other.name !== target.name)
      const documents = [...kept.slice(0, at), target, ...kept.slice(at)]
      return { text: fileText(documents, traits), documents, target }
    })

/** A hand-written grant: a levelled right, in any of the shapes a document takes. */
export const arbitraryHandWrittenGrant = arbitraryHandWrittenDocument.map(
  (document): HandWrittenDocument => ({
    ...document,
    kind: 'Resource',
    type: 'database-access',
  }),
)
