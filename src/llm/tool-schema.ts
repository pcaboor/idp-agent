import { isDeepStrictEqual } from 'node:util'

/**
 * The shape a tool's arguments are ADVERTISED in, which is not always the shape
 * they are validated against.
 *
 * Anthropic accepts a tool only when its `input_schema` is `type: "object"`,
 * and refuses a `oneOf` / `anyOf` / `allOf` at the root. A discriminated union
 * — the Analyst's `answer`, the Reviewer's `verdict` — converts to exactly that
 * root, so both tools were a 400 on that provider before a token was spent.
 * This rewrites such a union into the one object every provider accepts: the
 * discriminator becomes a required `enum`, each other field is offered once, a
 * field only some branches have or require says which in its description, and
 * a field the branches give different schemas becomes an `anyOf` of them.
 *
 * The flat object is looser than the union — it cannot say "required when" in
 * a way a provider enforces — and that is acceptable only because it is never
 * what a call is accepted on: the agent that owns a terminal tool re-parses
 * the call against its own Zod schema and hands a failure back (runtime.ts
 * says why the SDK's validator alone is not that gate). This decides what a
 * model is shown, and nothing else.
 *
 * Anything it cannot flatten faithfully is refused, naming the tool, rather than
 * sent in a shape some provider may reject or rewritten into one that drops a
 * constraint without saying so.
 */

/**
 * The JSON Schema this reads and writes, declared here rather than taken from
 * the SDK: `ai` re-exports `JsonSchema` from the `json-schema` package, which
 * ships no types, so the SDK's name for it is `any` in this project.
 */
export interface JsonSchema {
  [keyword: string]: unknown
  $schema?: string
  title?: string
  description?: string
  type?: string | string[]
  properties?: Record<string, Definition>
  required?: string[]
  additionalProperties?: Definition
  const?: unknown
  enum?: unknown[]
  oneOf?: Definition[]
  anyOf?: Definition[]
}

type Definition = JsonSchema | boolean

/** What may sit beside the union at the root. Anything else would be dropped. */
const ROOT_KEYS = new Set(['$schema', 'title', 'description'])

/** Refused at the root by Anthropic, `type: "object"` beside them or not. */
const ROOT_COMBINATORS = ['oneOf', 'anyOf', 'allOf'] as const

/** What a branch may carry. A keyword outside this list has no place in the flat object. */
const BRANCH_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties'])

interface Branch {
  properties: Record<string, Definition>
  required: readonly string[]
}

interface Discriminator {
  name: string
  values: readonly unknown[]
  schema: JsonSchema
}

export function objectRooted(schema: JsonSchema, tool: string): JsonSchema {
  const refuse = (why: string): never => {
    throw new Error(`tool "${tool}": ${why}`)
  }

  if (schema.type === 'object') {
    for (const key of ROOT_COMBINATORS) {
      if (schema[key] !== undefined) refuse(`its object root also carries "${key}"`)
    }
    return schema
  }

  const unionKey: 'oneOf' | 'anyOf' =
    schema.oneOf !== undefined
      ? 'oneOf'
      : schema.anyOf !== undefined
        ? 'anyOf'
        : refuse('its input schema has neither an object root nor a union of objects to flatten')
  for (const key of Object.keys(schema)) {
    if (key !== unionKey && !ROOT_KEYS.has(key)) {
      refuse(`its input schema carries "${key}" beside the union, which flattening would drop`)
    }
  }

  const branches = (schema[unionKey] ?? []).map((definition, index) =>
    branchOf(definition, index, refuse),
  )
  if (branches.length === 0) refuse('its input schema is a union of nothing')

  const discriminator = discriminatorOf(branches, refuse)
  const valuesIn = (indices: readonly number[]): string =>
    listOf(indices.map((index) => discriminator.values[index]))

  const properties: Record<string, Definition> = { [discriminator.name]: discriminator.schema }
  const required = [discriminator.name]

  for (const name of propertyNames(branches)) {
    if (name === discriminator.name) continue
    const present: number[] = []
    const requiredIn: number[] = []
    const shapes: Definition[] = []
    branches.forEach((branch, index) => {
      const shape = branch.properties[name]
      if (shape === undefined) return
      present.push(index)
      if (branch.required.includes(name)) requiredIn.push(index)
      if (!shapes.some((seen) => isDeepStrictEqual(seen, shape))) shapes.push(shape)
    })

    const [only] = shapes
    const merged: JsonSchema =
      shapes.length === 1 && only !== undefined
        ? typeof only === 'boolean'
          ? refuse(`property "${name}" is a bare boolean schema, which has no field to describe`)
          : only
        : { anyOf: shapes }

    const note = noteFor(discriminator.name, branches.length, present, requiredIn, valuesIn)
    properties[name] =
      note === undefined
        ? merged
        : {
            ...merged,
            description: merged.description === undefined ? note : `${merged.description} ${note}`,
          }
    if (requiredIn.length === branches.length) required.push(name)
  }

  return {
    ...(schema.$schema !== undefined ? { $schema: schema.$schema } : {}),
    ...(schema.title !== undefined ? { title: schema.title } : {}),
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

function branchOf(
  definition: Definition,
  index: number,
  refuse: (why: string) => never,
): Branch {
  if (typeof definition === 'boolean' || definition.type !== 'object') {
    return refuse(`branch ${index} of its input schema is not an object, so it cannot be one`)
  }
  for (const key of Object.keys(definition)) {
    if (!BRANCH_KEYS.has(key)) {
      refuse(`branch ${index} of its input schema carries "${key}", which flattening would drop`)
    }
  }
  // An open branch would be advertised closed. The SDK closes every object it
  // converts, so this only fires on a schema that did not come through it.
  if (definition.additionalProperties !== false) {
    refuse(`branch ${index} of its input schema accepts properties it does not name`)
  }
  return { properties: definition.properties ?? {}, required: definition.required ?? [] }
}

/** The single value a property is pinned to, and the rest of its schema. */
function constantOf(
  definition: Definition | undefined,
): { value: unknown; rest: JsonSchema } | undefined {
  if (definition === undefined || typeof definition === 'boolean') return undefined
  const { const: value, enum: values, ...rest } = definition
  if (value !== undefined && values === undefined) return { value, rest }
  if (value === undefined && values?.length === 1) return { value: values[0], rest }
  return undefined
}

/**
 * The first property, in the first branch's order, that every branch requires,
 * pins to one value, and pins to a value no other branch uses — with the rest
 * of its schema the same everywhere, so one `enum` states it for all of them.
 *
 * A candidate that fails only because its description differs from branch to
 * branch is remembered: it is a discriminator one `enum` cannot describe, and
 * the refusal names that rather than claiming there is none.
 */
function discriminatorOf(
  branches: readonly Branch[],
  refuse: (why: string) => never,
): Discriminator {
  let describedApart: string | undefined
  for (const name of Object.keys(branches[0]?.properties ?? {})) {
    const pinned = branches.map((branch) =>
      branch.required.includes(name) ? constantOf(branch.properties[name]) : undefined,
    )
    const settled = pinned.filter((each) => each !== undefined)
    if (settled.length !== branches.length) continue
    const [head] = settled
    if (head === undefined) continue
    const values = settled.map((each) => each.value)
    const distinct = values.every(
      (value, index) => values.findIndex((other) => isDeepStrictEqual(other, value)) === index,
    )
    if (!distinct) continue
    if (!settled.every((each) => isDeepStrictEqual(each.rest, head.rest))) {
      const plain = undescribed(head.rest)
      if (settled.every((each) => isDeepStrictEqual(undescribed(each.rest), plain))) {
        describedApart ??= name
      }
      continue
    }
    return { name, values, schema: { ...head.rest, enum: values } }
  }
  return refuse(
    describedApart !== undefined
      ? `its discriminator "${describedApart}" is described differently from branch to branch, and ` +
          'one enum carries one description: describe it the same everywhere, or not at all'
      : 'its branches share no required constant with a distinct value in each, so there is ' +
          'nothing to tell the branches apart by',
  )
}

function undescribed(schema: JsonSchema): JsonSchema {
  const copy = { ...schema }
  delete copy.description
  return copy
}

/** Every property name, in order of first appearance: branch order, then property order. */
function propertyNames(branches: readonly Branch[]): string[] {
  const names = new Set<string>()
  for (const branch of branches) for (const name of Object.keys(branch.properties)) names.add(name)
  return [...names]
}

/**
 * What the flat object can no longer say structurally, said in words: which
 * branches a field belongs to, and in which it is required. Nothing when the
 * field is the same everywhere, so a field no branch treats specially reads
 * exactly as it did.
 */
function noteFor(
  discriminator: string,
  total: number,
  present: readonly number[],
  requiredIn: readonly number[],
  valuesIn: (indices: readonly number[]) => string,
): string | undefined {
  const everywhere = present.length === total
  if (everywhere) {
    if (requiredIn.length === 0 || requiredIn.length === total) return undefined
    return `Required when ${discriminator} is ${valuesIn(requiredIn)}.`
  }
  if (requiredIn.length === present.length) {
    return `Required when ${discriminator} is ${valuesIn(present)}; omit it otherwise.`
  }
  if (requiredIn.length === 0) return `Only when ${discriminator} is ${valuesIn(present)}.`
  return (
    `Only when ${discriminator} is ${valuesIn(present)}; ` +
    `required when it is ${valuesIn(requiredIn)}.`
  )
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"`. */
function listOf(values: readonly unknown[]): string {
  const quoted = values.map((value) => JSON.stringify(value))
  const last = quoted.pop()
  return quoted.length === 0 ? (last ?? '') : `${quoted.join(', ')} or ${last}`
}
