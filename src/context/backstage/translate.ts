import { COMPONENT_LIFECYCLES } from '../../core/schemas/entity.js'
import { RESOURCE_TYPE_NAMES } from '../../core/schemas/resource-types.js'
import type { Ignored, PrePassRule } from '../provider.js'
import { BACKSTAGE_LIMITS } from './limits.js'

/**
 * The catalogue pre-pass (docs/backstage-http-brief.md § 5): what stands
 * between an item a catalogue serves and the file reader's `readValue`.
 *
 * Backstage serves "final entities", processed, stitched and annotated. This
 * removes what the catalogue added — `relations`, derived, and a processor
 * can add an edge nothing declared; `status`, alpha; `metadata.uid` and
 * `metadata.etag`, which the load kept to count the read — and sets aside
 * what the catalogue accepted and this tool does not model. Refusing those
 * would say "skipped" about something legitimately there, and reading them
 * would turn them into what they are not:
 *
 *   - a Component or a Resource outside the namespace `default`: the graph
 *     keys every entity `kind:default/name` (`refOf`) and keeps the first
 *     declaration of a key, so one read from `payments` would shadow its
 *     namesake of `default`, or be shadowed by it, in silence, and the
 *     overview would count both. An API is set aside for this by the reader
 *     already, which is why it is not here;
 *   - a `backstage.io/v1beta1` apiVersion, a name in upper case, a lifecycle
 *     outside `COMPONENT_LIFECYCLES` and a Resource type outside
 *     `RESOURCE_TYPE_NAMES`: what Backstage accepts and this tool never
 *     writes. The YAML road does not change — in a declarations repository a
 *     lifecycle this tool cannot write is still refused (#49);
 *   - an item nested deeper than 64 or holding a `__proto__` or `constructor`
 *     key, as a `Plan` is refused: nothing downstream walks what it cannot
 *     bound, and no key reaches an object that could name its prototype.
 *
 * A set-aside is an `Ignored` with its kind, its lower-case ref and
 * `prePass`, so the graph's `aside` set takes it as it takes a Group, and a
 * reference to it is "in the catalogue, not modelled", never dangling.
 */

type Item = Record<string, unknown>

/** An item ready for `readValue`, what the pre-pass took off it that the load uses, or why it was set aside. */
export type PrePassed =
  | { readonly value: Item; readonly uid?: string; readonly location?: string }
  | { readonly aside: Ignored }

/** The annotation Backstage overwrites with where it read the entity: the file a person opens. */
export const MANAGED_BY_LOCATION = 'backstage.io/managed-by-location'

/** The two keys that could name a prototype. JSON.parse makes an own `__proto__`; the walk refuses both. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor'])

const isMapping = (value: unknown): value is Item =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A value the catalogue wrote, as a reason quotes it: as it is when plain,
 * quoted when not, with what `JSON.stringify` leaves — DEL, C1, the format
 * and separator characters — escaped too, as the file reader quotes a field.
 */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const quoted = (text: string): string =>
  PLAIN.test(text)
    ? text
    : JSON.stringify(text).replace(
        /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
        (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
      )

/**
 * Where an item came from, as a rejection and a set-aside name it: its ref,
 * and the file the catalogue read it from when it says.
 */
export function sourceOf(ref: string | undefined, location: string | undefined): string {
  const name = ref ?? 'an entity of the catalogue'
  return location === undefined ? name : `${name} (${location})`
}

/** `kind:namespace/name`, lower case, when the item states a kind and a name as text. */
export function refOfItem(item: Item): string | undefined {
  const metadata = isMapping(item['metadata']) ? item['metadata'] : {}
  const { kind } = item
  const { name, namespace } = metadata
  if (typeof kind !== 'string' || typeof name !== 'string') return undefined
  return `${kind}:${typeof namespace === 'string' ? namespace : 'default'}/${name}`.toLowerCase()
}

/** The item's `managed-by-location`, when it is text. */
export function locationOf(item: Item): string | undefined {
  const metadata = isMapping(item['metadata']) ? item['metadata'] : {}
  const annotations = isMapping(metadata['annotations']) ? metadata['annotations'] : {}
  const location = annotations[MANAGED_BY_LOCATION]
  return typeof location === 'string' ? location : undefined
}

/**
 * What the shape walk found wrong, or undefined: `depth`, or the forbidden
 * key. Iterative, so an item nested past any bound cannot exhaust the stack
 * that reads it; the item itself is level 1.
 */
function shapeFault(item: unknown): string | undefined {
  const stack: { value: unknown; depth: number }[] = [{ value: item, depth: 1 }]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, depth } = next
    if (typeof value !== 'object' || value === null) continue
    if (depth > BACKSTAGE_LIMITS.jsonDepth) return 'depth'
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return key
      stack.push({ value: (value as Item)[key], depth: depth + 1 })
    }
  }
  return undefined
}

/** Why a Component or a Resource the catalogue accepted is set aside, in the rules' order, or undefined. */
function unmodelled(item: Item): { rule: PrePassRule; value: string; reason: string } | undefined {
  const kind = typeof item['kind'] === 'string' ? item['kind'].toLowerCase() : undefined
  if (kind !== 'component' && kind !== 'resource') return undefined
  const metadata = isMapping(item['metadata']) ? item['metadata'] : {}
  const spec = isMapping(item['spec']) ? item['spec'] : {}
  const { namespace, name } = metadata

  // Exactly `default`: `DEFAULT`, or a namespace that is not text, would be
  // read without it and shadow its namesake of `default`.
  if (namespace !== undefined && namespace !== 'default') {
    return typeof namespace === 'string'
      ? { rule: 'namespace', value: namespace, reason: `namespace ${quoted(namespace)} is not modelled by this tool` }
      : { rule: 'namespace', value: JSON.stringify(namespace), reason: 'a namespace that is not text is not modelled by this tool' }
  }
  const { apiVersion } = item
  if (apiVersion === 'backstage.io/v1beta1') {
    return { rule: 'api-version', value: apiVersion, reason: `apiVersion ${apiVersion} is not one this tool reads` }
  }
  if (typeof name === 'string' && name !== name.toLowerCase()) {
    return { rule: 'name-case', value: name, reason: 'a name in upper case is not one this tool reads' }
  }
  const { lifecycle, type } = spec
  if (kind === 'component' && typeof lifecycle === 'string' && !(COMPONENT_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    return { rule: 'lifecycle', value: lifecycle, reason: `lifecycle ${quoted(lifecycle)} is not one this tool models` }
  }
  if (kind === 'resource' && typeof type === 'string' && !(RESOURCE_TYPE_NAMES as readonly string[]).includes(type)) {
    return { rule: 'resource-type', value: type, reason: `resource type ${quoted(type)} is not one this tool models` }
  }
  return undefined
}

/** A set-aside, named as every row of a catalogue read is. */
function aside(item: Item, rule: PrePassRule, value: string, reason: string): { aside: Ignored } {
  const ref = refOfItem(item)
  const kind = item['kind']
  return {
    aside: {
      source: sourceOf(ref, locationOf(item)),
      reason,
      ...(typeof kind === 'string' && { kind }),
      ...(ref !== undefined && { ref }),
      prePass: { rule, value },
    },
  }
}

/**
 * One item, before the reader: set aside, or a copy of it with what the
 * catalogue added taken off and its uid and location handed back beside it.
 * The item handed over is never changed.
 */
export function prePass(item: unknown): PrePassed {
  if (!isMapping(item)) return aside({}, 'shape', 'not a mapping', 'an item that is not a mapping is not read')
  const fault = shapeFault(item)
  if (fault !== undefined) {
    const reason =
      fault === 'depth'
        ? `nested deeper than ${String(BACKSTAGE_LIMITS.jsonDepth)} levels, which this tool does not read`
        : `holds a ${fault} key, which this tool does not read`
    return aside(item, 'shape', fault, reason)
  }

  const { relations: _relations, status: _status, ...value } = item
  const metadata = isMapping(value['metadata']) ? { ...value['metadata'] } : undefined
  const uid = metadata?.['uid']
  if (metadata !== undefined) {
    delete metadata['uid']
    delete metadata['etag']
    value['metadata'] = metadata
  }

  const why = unmodelled(value)
  if (why !== undefined) return aside(value, why.rule, why.value, why.reason)
  const location = locationOf(value)
  return {
    value,
    ...(typeof uid === 'string' && { uid }),
    ...(location !== undefined && { location }),
  }
}

/** Code-unit order, as `FixtureProvider` sorts paths: never the locale's. */
const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/**
 * The order a catalogue's entities are read in: by `managed-by-location`,
 * then by ref; an entity without a location last, by ref. The file road
 * orders by file path, and the served location of a file is its path, so
 * this reproduces the file road wherever each location holds one entity —
 * and never depends on the order the pages came in.
 */
export function catalogueOrder(
  a: { readonly ref: string; readonly location?: string | undefined },
  b: { readonly ref: string; readonly location?: string | undefined },
): number {
  if (a.location !== b.location) {
    if (a.location === undefined) return 1
    if (b.location === undefined) return -1
    return byCodeUnit(a.location, b.location)
  }
  return byCodeUnit(a.ref, b.ref)
}
