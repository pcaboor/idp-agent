import { entitySchema, type Entity } from '../schemas/entity.js'
import { readDocuments, serializeEntity } from '../yaml/serialize.js'

/**
 * Whether a file's new bytes do what an operation says, and nothing else —
 * decided by the parser, never by the surgery that produced them.
 *
 * The surgery finds documents by reading lines, because it must not rewrite
 * from a parse (§4.3). That makes it a heuristic, and a heuristic that guesses
 * wrong does not fail: it amends the wrong document, opens a key a second
 * time, or leaves the file as it was — which is byte-identical to "already
 * listed". So `planEdits` asks these after every edit, and an edit that fails
 * one is not offered. `appendedOnly` and `insertedOnly` return undefined when
 * the edit holds, and otherwise the reason, for a reader.
 *
 * Compared as the parser's own values, not as entities: `entitySchema` strips
 * keys it does not know, and a key it does not know is still a byte in the
 * repository somebody reviews. Whether a consumer is LISTED is the schema's
 * answer, though, on both sides of an edit: it is what the catalogue reads.
 */

const refOf = (entity: Entity): string =>
  `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`

/** Structural equality over what `toJS()` returns; a key holding undefined is absent. */
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = (value: object): string[] =>
    Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined)
  const [a, b] = [keys(left), keys(right)]
  return (
    a.length === b.length &&
    a.every(
      (key) =>
        Object.hasOwn(right, key) &&
        same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  )
}

/** The non-empty documents of a file, or the parser's first complaint about it. */
function contentsOf(text: string): { values: unknown[] } | { error: string } {
  const values: unknown[] = []
  for (const reading of readDocuments(text)) {
    if ('error' in reading) return { error: reading.error }
    // A null document declares nothing; comments and witnesses are made of them.
    if (reading.value !== null && reading.value !== undefined) values.push(reading.value)
  }
  return { values }
}

/** Where `ref` is declared: its first valid declaration, which is how `planEdits` resolves it. */
function indexOf(values: readonly unknown[], ref: string): number {
  return values.findIndex((value) => {
    const parsed = entitySchema.safeParse(value)
    return parsed.success && refOf(parsed.data) === ref
  })
}

/** Whether the entity schema reads `consumer` in a document's `spec.dependencyOf`. */
function lists(value: unknown, consumer: string): boolean {
  const read = entitySchema.safeParse(value)
  return (
    read.success &&
    read.data.kind === 'Resource' &&
    (read.data.spec.dependencyOf ?? []).includes(consumer)
  )
}

/**
 * Whether `text` already lists `consumer` under `ref`'s `spec.dependencyOf`.
 *
 * Asked of the target's own document, the faulted ones set aside the way
 * `parseDocuments` sets them aside when `planEdits` resolves `ref`. A sibling
 * with a duplicate key says nothing about this one: read as a whole, the file
 * answered "not listed" for a consumer that was, and the plan was told the
 * repository did not say what it said. The fault is still the re-check's and
 * `validate`'s to report.
 */
export function listsConsumer(text: string, ref: string, consumer: string): boolean {
  const values = readDocuments(text).flatMap((reading) =>
    'error' in reading ? [] : [reading.value],
  )
  return lists(values[indexOf(values, ref)], consumer)
}

/**
 * `after` is `before` with `consumer` appended to `ref`'s `spec.dependencyOf`,
 * every other document and every other field of `ref` read back unchanged.
 */
export function appendedOnly(
  before: string,
  after: string,
  ref: string,
  consumer: string,
): string | undefined {
  // The file first: a fault it already had is not one the edit made, and
  // blaming the edit sent a reader to the wrong line.
  const was = contentsOf(before)
  if ('error' in was) return `the file does not parse (${was.error})`
  const now = contentsOf(after)
  if ('error' in now) return `the result would not parse (${now.error})`

  const at = indexOf(was.values, ref)
  if (at === -1) return `the file does not declare ${ref}`
  if (now.values.length !== was.values.length || indexOf(now.values, ref) !== at) {
    return `the result does not declare ${ref} where the file did`
  }

  const target = was.values[at] as { spec: Record<string, unknown> }
  const listed = target.spec.dependencyOf
  const expected = {
    ...target,
    spec: { ...target.spec, dependencyOf: [...(Array.isArray(listed) ? listed : []), consumer] },
  }
  if (!same(now.values[at], expected)) {
    return lists(now.values[at], consumer)
      ? `the result changes more of ${ref} than its consumers`
      : `the result does not list ${consumer} under ${ref}`
  }
  // The bytes hold the line, and the catalogue still has to read it: the
  // schema strips a `dependencyOf` off a Component. Offered anyway, it was a
  // line nothing reads, and a second run, asking `listsConsumer`, found the
  // consumer absent and the surgery found it present.
  if (!lists(now.values[at], consumer)) {
    return `only a Resource lists its consumers, and ${ref} is not one`
  }
  const other = was.values.findIndex(
    (value, index) => index !== at && !same(value, now.values[index]),
  )
  return other === -1 ? undefined : 'the result changes another document in the file'
}

/**
 * `after` is `before` with one more document, the others read back unchanged,
 * and the new one reading back as `entity` serialised on its own — and as
 * `entity` itself whenever that is a valid entity. An invalid one is the
 * rules' to report, and the re-check does: refused here, it would come out as
 * a drop instead of the violation that says what is wrong with it.
 */
export function insertedOnly(
  before: string | undefined,
  after: string,
  entity: Entity,
): string | undefined {
  const now = contentsOf(after)
  if ('error' in now) return `the result would not parse (${now.error})`
  const was = contentsOf(before ?? '')
  if ('error' in was) return `the file does not parse (${was.error})`

  if (now.values.length !== was.values.length + 1) {
    return 'the result does not hold exactly one more document than the file'
  }
  if (was.values.some((value, index) => !same(value, now.values[index]))) {
    return 'the result changes a document that was already in the file'
  }

  const added = now.values[was.values.length]
  const alone = contentsOf(serializeEntity(entity))
  if ('error' in alone || !same(added, alone.values[0])) {
    return `the added document does not read back as ${refOf(entity)}`
  }
  const valid = entitySchema.safeParse(entity)
  const read = entitySchema.safeParse(added)
  if (valid.success && !(read.success && same(read.data, entity))) {
    return `the added document does not read back as ${refOf(entity)}`
  }
  return undefined
}
