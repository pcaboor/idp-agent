import { parse, parseAllDocuments, stringify, type YAMLError } from 'yaml'
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
  if (entity.spec.dependsOn !== undefined) spec.dependsOn = entity.spec.dependsOn
  if (entity.kind === 'Resource' && entity.spec.dependencyOf !== undefined) {
    spec.dependencyOf = entity.spec.dependencyOf
  }

  return { apiVersion: entity.apiVersion, kind: entity.kind, metadata, spec }
}

/** One entity, one document. No leading `---`: that belongs to the surgery layer. */
export function serializeEntity(entity: Entity): string {
  const text = stringify(ordered(entity), STRINGIFY_OPTIONS)
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
 * Every entity in a multi-document file, one message per document that is not
 * one, and how many documents there were.
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
  /** Documents in the stream, the null ones a witness is made of included. */
  documents: number
} {
  const entities: Entity[] = []
  const rejections: string[] = []
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
    const parsed = entitySchema.safeParse(reading.value)
    if (parsed.success) entities.push(parsed.data)
    else rejections.push(reasonOf(parsed.error))
  }

  return { entities, rejections, documents: readings.length }
}
