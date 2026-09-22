import { parse, parseAllDocuments, stringify } from 'yaml'
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

/** Reads one document back. Used by round-trip tests and by repository readers. */
export function parseEntity(document: string): Entity {
  return entitySchema.parse(parse(document))
}

/**
 * Every entity in a multi-document file, and one message per document the
 * schema refused.
 *
 * The repository readers in `context/` do this against a disk; this does it
 * against bytes, so `core/` can read back what it is about to write without
 * one. Rejections are returned rather than thrown for the same reason the
 * readers report them: a file with one bad document still has good ones, and
 * dropping either fact hides a defect.
 */
export function parseDocuments(text: string): {
  entities: Entity[]
  rejections: string[]
} {
  const entities: Entity[] = []
  const rejections: string[] = []

  for (const document of parseAllDocuments(text)) {
    const value: unknown = document.toJS()
    // A witness is a null document (design 7.2): present on purpose, and not
    // an entity. Counting it as a rejection would make every witnessed folder
    // report one.
    if (value === null || value === undefined) continue
    const parsed = entitySchema.safeParse(value)
    if (parsed.success) entities.push(parsed.data)
    else rejections.push(reasonOf(parsed.error))
  }

  return { entities, rejections }
}
