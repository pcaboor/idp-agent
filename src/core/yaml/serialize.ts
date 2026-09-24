import { Document, Scalar, parse, parseAllDocuments, visit, type YAMLError } from 'yaml'
import { entitySchema, type Entity } from '../schemas/entity.js'
import { reasonOf } from '../schemas/reject.js'

/**
 * The model never emits YAML; it emits a structure, and this is the only place
 * that turns one into text. A single serialiser means one format across the
 * repository whichever model produced the content, and it removes a whole class
 * of failure: broken indentation, a missing escape, a value like `no` or `123`
 * read back as a boolean or a number.
 *
 * lineWidth 0 disables folding. The default wraps at 80 columns, which would
 * split a long value across lines and make the diff unreadable — and review is
 * what authorises the change (design 4.2).
 *
 * version 1.1 governs quoting, not the output format: no directive is emitted.
 * This library reads and writes YAML 1.2, where `no` is a string, so a 1.2
 * round-trip through it proves self-consistency and nothing more. PyYAML, Ruby
 * and Go's yaml.v2 read 1.1, where `no`, `yes`, `on`, `off`, `y` and `n` are
 * booleans. The IaC repository is read by more than this tool, so the output is
 * quoted conservatively enough for those readers as well. Measured: six of nine
 * ambiguous strings came back wrong before this.
 *
 * Quoting for 1.1 is not quoting for 1.2, though: each version reads a few
 * strings as numbers the other does not. `0o17` is octal only in 1.2, and so is
 * `1e3` a float — 1.1 wants a decimal point. So a string is quoted when either
 * reader would take it for something else (`quotedFor12` adds the 1.2 half);
 * 1.2 is what this library, and Backstage, read the repository with.
 */
const STRINGIFY_OPTIONS = {
  indent: 2,
  lineWidth: 0,
  singleQuote: true,
  sortMapEntries: false,
  version: '1.1',
} as const

/**
 * Key order is fixed by insertion order, not by sorting: a reader expects
 * apiVersion, kind, metadata, spec, and a stable order keeps diffs to the lines
 * that actually changed.
 *
 * `links` and `system` are written where Backstage's own examples put them,
 * after the tags and after the owner, so an entity read from a repository
 * round-trips. The engine's own writes never carry either — a proposal has no
 * field for them (plan.ts) — so nothing this tool writes changed when they
 * were added.
 */
function ordered(entity: Entity): Record<string, unknown> {
  const metadata: Record<string, unknown> = { name: entity.metadata.name }
  if (entity.metadata.description !== undefined) {
    metadata.description = entity.metadata.description
  }
  if (Object.keys(entity.metadata.annotations).length > 0) {
    metadata.annotations = entity.metadata.annotations
  }
  if (entity.metadata.tags !== undefined) metadata.tags = entity.metadata.tags
  if (entity.metadata.links !== undefined) {
    // Rebuilt rather than passed through, so the order is this function's and
    // an absent title writes no key.
    metadata.links = entity.metadata.links.map(({ url, title, icon, type }) => ({
      url,
      ...(title !== undefined && { title }),
      ...(icon !== undefined && { icon }),
      ...(type !== undefined && { type }),
    }))
  }

  const spec: Record<string, unknown> = { type: entity.spec.type }
  if (entity.kind === 'Component') spec.lifecycle = entity.spec.lifecycle
  // Directly after the type, because "a database-access, granting read" is one
  // statement: a reviewer reading the diff should not have to look past the
  // owner to find out what is being granted. Absent when none was declared —
  // writing a level nobody stated is the one guess design 4.1 forbids.
  if (entity.kind === 'Resource' && entity.spec.access !== undefined) {
    spec.access = entity.spec.access
  }
  spec.owner = entity.spec.owner
  if (entity.spec.system !== undefined) spec.system = entity.spec.system
  if (entity.spec.dependsOn !== undefined) spec.dependsOn = entity.spec.dependsOn
  if (entity.kind === 'Resource' && entity.spec.dependencyOf !== undefined) {
    spec.dependencyOf = entity.spec.dependencyOf
  }

  return { apiVersion: entity.apiVersion, kind: entity.kind, metadata, spec }
}

/**
 * Whether a YAML 1.2 reader would take `text`, written bare, for something other
 * than a string. The type is what is asked, not the value: a string that would
 * come back as a different string — spacing, a line break — is the emitter's
 * syntax to get right, and it does, in either version.
 */
const readsAsOtherThanString = (text: string): boolean => {
  try {
    return typeof parse(text, { version: '1.2', logLevel: 'silent' }) !== 'string'
  } catch {
    // Not even a scalar on its own — an alias to nothing, a stray indicator.
    // Quoting is always a faithful way to write a string.
    return true
  }
}

/** Quotes every string value a YAML 1.2 reader would not read back as one. */
function quotedFor12(document: Document): void {
  visit(document, {
    Scalar(_, node) {
      if (typeof node.value === 'string' && readsAsOtherThanString(node.value)) {
        node.type = Scalar.QUOTE_SINGLE
      }
    },
  })
}

/** One entity, one document. No leading `---`: that belongs to the surgery layer. */
export function serializeEntity(entity: Entity): string {
  const document = new Document(ordered(entity), STRINGIFY_OPTIONS)
  quotedFor12(document)
  const text = document.toString(STRINGIFY_OPTIONS)
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Reads one document back, and throws on anything else: the round-trip tests
 * want exactly that. A repository is read with `parseDocuments`, which reports.
 */
export function parseEntity(document: string): Entity {
  return entitySchema.parse(parse(document))
}

/**
 * One document of a stream as the parser left it: a value, `null` for an
 * empty one, or why there is none.
 */
export type DocumentReading = { readonly value: unknown } | { readonly error: string }

/**
 * `4:3 DUPLICATE_KEY Map keys must be unique` — where, what, and the parser's
 * own words, which it suffixes with a location this already states.
 */
function describe(error: YAMLError): string {
  const at = error.linePos?.[0]
  const where = at === undefined ? '' : `${String(at.line)}:${String(at.col)} `
  const [first = ''] = error.message.split('\n')
  return `${where}${error.code} ${first.replace(/ at line \d+, column \d+:?$/, '')}`
}

/** yaml's own default, stated: a catalogue entity has no business near it. */
const MAX_ALIAS_COUNT = 100

/**
 * Every document of a stream, read as far as the parser vouches for it.
 *
 * A document the parser has faulted is an error here, never a value. `toJS()`
 * returns one regardless — the last of two duplicate keys, the half of an
 * unclosed sequence it managed to read — and taking it is how a duplicate key
 * passed `validate` as "0 violations", and how a surgery that broke a file's
 * syntax passed the re-check that reads its output back. `toJS()` itself is
 * guarded: an alias bomb trips yaml's alias-count limit, which throws, and one
 * hostile file must be a rejection rather than the end of the run.
 */
export function readDocuments(text: string): DocumentReading[] {
  const readings: DocumentReading[] = []
  for (const document of parseAllDocuments(text)) {
    const [error] = document.errors
    if (error !== undefined) {
      readings.push({ error: describe(error) })
      continue
    }
    try {
      readings.push({ value: document.toJS({ maxAliasCount: MAX_ALIAS_COUNT }) })
    } catch (thrown) {
      readings.push({
        error: `could not be read: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      })
    }
  }
  return readings
}

/**
 * A document read and left alone: part of a real catalogue — a Group, an API,
 * a Location — or not catalogue at all, like a mkdocs.yml. Neither refused nor
 * dropped: `validate` warns about it and the read commands count it.
 */
export interface IgnoredDocument {
  /** The kind it declares; absent when it declares none. */
  readonly kind?: string
  /**
   * `kind:namespace/name`, lower case, when it states a name: the target a
   * `dependsOn` would write, so a reference to it is not called dangling.
   */
  readonly ref?: string
  readonly reason: string
}

/** The two kinds this tool manages, and so the only two it holds to its schema. */
const MODELLED_KINDS = new Set(['component', 'resource'])

/** Backstage's own apiVersion: a kindless document under it is a failed entity. */
const BACKSTAGE_API_VERSION = /^backstage\.io\//

/**
 * The kinds Backstage defines under that apiVersion, Template included: the
 * scaffolder's v1beta2 templates were declared there before they moved to
 * `scaffolder.backstage.io/`. A closed set, which is what lets a kind outside
 * it be called a mistake rather than somebody's own.
 */
const BACKSTAGE_KINDS = [
  'API',
  'Component',
  'Domain',
  'Group',
  'Location',
  'Resource',
  'System',
  'Template',
  'User',
] as const
const BACKSTAGE_KIND_NAMES = new Set(BACKSTAGE_KINDS.map((kind) => kind.toLowerCase()))

/** What Backstage's grammars allow a kind, a name and an apiVersion to be: nothing a terminal acts on. */
const PLAIN_KIND = /^[A-Za-z][A-Za-z0-9]*$/
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PLAIN_API_VERSION = /^[A-Za-z0-9][A-Za-z0-9./-]*$/

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A field from a document no schema has checked, as it may be printed. The
 * reason reaches the CI log and a terminal, so text that is not plain is
 * quoted: `JSON.stringify` escapes a newline and the C0 controls, and what it
 * leaves — DEL, the C1 controls (U+009B is a CSI on its own), the format and
 * separator characters — is escaped here.
 */
const shown = (text: string, plain: RegExp): string =>
  plain.test(text)
    ? text
    : JSON.stringify(text).replace(
        /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
        (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
      )

/**
 * Whether a document is one this tool has no business judging, and why.
 *
 * Decided before the entity schema, because that schema is deliberately
 * stricter than Backstage for the two kinds it knows and knows no other: run
 * over a Group, it refused it, and a declarations repository that is also the
 * company's catalogue could not pass `validate`. A Component or Resource in any
 * case — Backstage compares kinds case-insensitively, so `kind: component` is
 * one — goes to the schema, and so does what looks like a failed attempt at an
 * entity: a kind that is empty or not a string, a document that is not a
 * mapping, and a document with no kind that has Backstage's apiVersion, or a
 * `metadata` or a `spec`, which is an entity that lost its header. Setting
 * those aside would turn a broken declaration into a warning. A Helm
 * `Chart.yaml` has an apiVersion, Helm's, and no kind; it is set aside.
 *
 * A mistyped kind is told apart from a custom one by where it is declared, not
 * by guessing what was meant: under Backstage's own apiVersion the kinds are a
 * closed set, so `kind: Resouce` there is refused (`misdeclaredKind`), while a
 * kind of somebody's own lives under their own apiVersion and is set aside.
 */
function ignoredOf(value: unknown): IgnoredDocument | undefined {
  if (!isMapping(value)) return undefined
  if (!('kind' in value)) {
    const { apiVersion } = value
    const backstage = typeof apiVersion === 'string' && BACKSTAGE_API_VERSION.test(apiVersion)
    if (backstage || 'metadata' in value || 'spec' in value) return undefined
    return {
      reason:
        apiVersion === undefined
          ? 'not a catalogue entity: no apiVersion or kind'
          : 'not a catalogue entity: no kind',
    }
  }
  const { kind } = value
  if (typeof kind !== 'string' || kind.trim() === '') return undefined
  if (MODELLED_KINDS.has(kind.toLowerCase())) return undefined
  const metadata = isMapping(value.metadata) ? value.metadata : {}
  const { name, namespace } = metadata
  const reason = (subject: string): string =>
    `kind ${shown(kind, PLAIN_KIND)} is not modelled by this tool; ${subject}left as is`
  if (typeof name !== 'string') return { kind, reason: reason('') }
  const space = typeof namespace === 'string' ? namespace : 'default'
  return {
    kind,
    ref: `${kind}:${space}/${name}`.toLowerCase(),
    reason: reason(`${shown(kind.toLowerCase(), PLAIN_KIND)} ${shown(name, PLAIN_NAME)} `),
  }
}

/**
 * Why a document declares, under Backstage's own apiVersion, a kind Backstage
 * does not define there — or undefined when it does not.
 *
 * Refused rather than set aside: nobody declares a kind of their own under
 * Backstage's apiVersion, so the likeliest reading of `kind: Resouce` is a
 * Resource with a typo, and a warning would let CI pass while the entity
 * vanished from the graph. The reason lists the kinds that group does define,
 * which is the whole of what a reader needs to fix it.
 */
function misdeclaredKind(value: unknown): string | undefined {
  if (!isMapping(value)) return undefined
  const { apiVersion, kind } = value
  if (typeof apiVersion !== 'string' || !BACKSTAGE_API_VERSION.test(apiVersion)) return undefined
  // An empty or missing kind is the schema's to refuse, in its own words.
  if (typeof kind !== 'string' || kind.trim() === '') return undefined
  if (BACKSTAGE_KIND_NAMES.has(kind.toLowerCase())) return undefined
  return (
    `kind ${shown(kind, PLAIN_KIND)} is not one Backstage defines under ` +
    `${shown(apiVersion, PLAIN_API_VERSION)} (${BACKSTAGE_KINDS.join(', ')})`
  )
}

/**
 * Every entity in a multi-document file, one message per document that is not
 * one, every document set aside as someone else's, and how many documents
 * there were.
 *
 * The one reader of entity documents — `readDocuments` is its lower half, and
 * `plan/effect.ts` the only other caller of that. `context/`'s readers call it
 * on what they read from a disk, and `core/` on bytes it is about to write, so
 * a file cannot be conformant to one of them and broken to the other.
 * Rejections are returned rather than thrown for the same reason the readers
 * report them: a file with one bad document still has good ones, and dropping
 * either fact hides a defect.
 */
export function parseDocuments(text: string): {
  entities: Entity[]
  rejections: string[]
  ignored: IgnoredDocument[]
  /** Documents in the stream, the null ones a witness is made of included. */
  documents: number
} {
  const entities: Entity[] = []
  const rejections: string[] = []
  const ignored: IgnoredDocument[] = []
  const readings = readDocuments(text)

  for (const reading of readings) {
    if ('error' in reading) {
      rejections.push(reading.error)
      continue
    }
    // A witness is a null document (design 7.2): present on purpose, and not
    // an entity. Counting it as a rejection would make every witnessed folder
    // report one.
    if (reading.value === null || reading.value === undefined) continue
    const misdeclared = misdeclaredKind(reading.value)
    if (misdeclared !== undefined) {
      rejections.push(misdeclared)
      continue
    }
    const foreign = ignoredOf(reading.value)
    if (foreign !== undefined) {
      ignored.push(foreign)
      continue
    }
    const parsed = entitySchema.safeParse(reading.value)
    if (parsed.success) entities.push(parsed.data)
    else rejections.push(reasonOf(parsed.error))
  }

  return { entities, rejections, ignored, documents: readings.length }
}
