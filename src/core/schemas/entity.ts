import { z } from 'zod'
import { ACCESS_LEVELS, RESOURCE_TYPE_NAMES, natureOf } from './resource-types.js'

/** Annotation carrying an entity's own file location. Read it; never re-derive it. */
export const SOURCE_FILE_ANNOTATION = 'idp-agent.dev/source-file'

/** Backstage names: up to 63 chars, alphanumerics plus - _ ., not at the edges. */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/

/*
 * The three parts of a reference, as this tool writes them. Kind and
 * namespace are lower-case here; the reader below accepts either case of
 * each, and nothing else wider.
 */
const KIND = 'a-z'
const NAMESPACE = 'a-z0-9-'
const NAME = 'a-z0-9._-'

/**
 * `kind:namespace/name`, e.g. `resource:default/billing-db-dev` — the full
 * form, and the only one this tool writes. A proposal must use it (plan.ts),
 * and so must every agent tool's arguments.
 */
export const entityRefSchema = z
  .string()
  .regex(new RegExp(`^[${KIND}]+:[${NAMESPACE}]+\\/[${NAME}]+$`), 'expected kind:namespace/name')

/**
 * A proposal names its owner in full, as a group or a user; the reader also
 * accepts Backstage's bare form (below).
 */
export const ownerRefSchema = z
  .string()
  .regex(
    new RegExp(`^(group|user):[${NAMESPACE}]+\\/[${NAME}]+$`),
    'expected group:... or user:...',
  )

/*
 * What a repository may write instead, and how it is read.
 *
 * This implements Backstage's documented entity-reference format: a reference
 * is `[<kind>:][<namespace>/]<name>`. An omitted namespace is the REFERRING
 * entity's own `metadata.namespace`, itself `default` when absent. An omitted
 * kind defaults per field — Group for `spec.owner` (which may also name a
 * `user:`), none at all for `spec.dependsOn` and `spec.dependencyOf`, where a
 * reference must carry its kind. Kinds and namespaces compare
 * case-insensitively, so both are lower-cased; a NAME is not folded, and one
 * outside the grammar below is refused as it always was.
 *
 * The character sets are the strict schemas' own, kept as they were, with
 * upper case added to kind and namespace. They may be narrower than
 * Backstage's — a kind with a digit after its first letter (`k8s:db`) is
 * refused here, and whether Backstage allows one has not been checked.
 *
 * Read side only. `entitySchema` yields the full form, so everything
 * downstream — the graph, the rules, the re-check, the plan's edits — compares
 * one spelling; the file keeps the one a person wrote, because nothing here
 * rewrites a repository. Proposals keep the strict schemas above.
 */

const READ_KIND = `[A-Z${KIND}]+`
const READ_NAMESPACE = `[A-Z${NAMESPACE}]+`
const READ_NAME = `[${NAME}]+`

/** Either case of each letter, so the exported JSON Schema carries the same pattern. */
const caseless = (word: string): string =>
  [...word].map((letter) => `[${letter.toUpperCase()}${letter}]`).join('')

/** `[kind:][namespace/]name`, split: kind, namespace, name. */
const SHORT_REF = new RegExp(`^(?:(${READ_KIND}):)?(?:(${READ_NAMESPACE})\\/)?(${READ_NAME})$`)

/** What `metadata.namespace` must be for a reference to take it. ASCII, checked before folding. */
const NAMESPACE_VALUE = new RegExp(`^${READ_NAMESPACE}$`)

const readOwnerRefSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:(?:${caseless('group')}|${caseless('user')}):)?(?:${READ_NAMESPACE}\\/)?${READ_NAME}$`,
    ),
    'expected group:... or user:...',
  )

/** A reference that would be well-formed, had it named its kind. */
const kindless = (input: unknown): boolean => {
  const parts = typeof input === 'string' ? SHORT_REF.exec(input) : null
  return parts !== null && parts[1] === undefined
}

const readDependencyRefSchema = z
  .string()
  .regex(new RegExp(`^${READ_KIND}:(?:${READ_NAMESPACE}\\/)?${READ_NAME}$`), {
    error: ({ input }) =>
      kindless(input)
        ? 'kind required: Backstage gives this field no default kind, ' +
          'so expected kind:[namespace/]name'
        : 'expected kind:namespace/name',
  })

interface RefFields {
  owner: string
  dependsOn?: string[] | undefined
  dependencyOf?: string[] | undefined
}

/**
 * `spec` with every reference in full. The namespace is the entity's own —
 * but every other part of the tool still keys an entity as
 * `kind:default/name`, namespaces being separate work, so a reference read in
 * another namespace resolves to nothing there. A known limitation, and a
 * dangling reference is reported rather than guessed at.
 *
 * `default` stands in only for a `metadata.namespace` that is absent, which is
 * Backstage's documented default. One that is present and not a namespace — a
 * number, an empty string, a lookalike letter — is malformed, not absent, and
 * a reference that needs it is refused. The reason does not repeat the value:
 * it comes from the file and goes to a terminal.
 */
function qualifiedSpec<S extends RefFields>(
  spec: S,
  namespace: unknown,
  ctx: z.RefinementCtx,
): S {
  const own =
    namespace === undefined
      ? 'default'
      : typeof namespace === 'string' && NAMESPACE_VALUE.test(namespace)
        ? namespace.toLowerCase()
        : undefined
  const read = (ref: string, defaultKind: string | undefined, path: PropertyKey[]): string => {
    // The field schemas accept nothing SHORT_REF does not split, and a
    // dependency nothing without its kind: the fallbacks are unreachable.
    const [, kind = defaultKind, stated = own, name] = SHORT_REF.exec(ref) ?? []
    if (kind === undefined || name === undefined) return ref
    if (stated === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['spec', ...path],
        message: 'names no namespace, and metadata.namespace is not a valid one',
      })
      return ref
    }
    return `${kind.toLowerCase()}:${stated.toLowerCase()}/${name}`
  }
  return {
    ...spec,
    owner: read(spec.owner, 'group', ['owner']),
    ...(spec.dependsOn !== undefined && {
      dependsOn: spec.dependsOn.map((ref, at) => read(ref, undefined, ['dependsOn', at])),
    }),
    ...(spec.dependencyOf !== undefined && {
      dependencyOf: spec.dependencyOf.map((ref, at) => read(ref, undefined, ['dependencyOf', at])),
    }),
  }
}

/** An entity with its references in full, and `metadata.namespace` read and dropped. */
function qualify<A, M extends { namespace?: unknown }, K, S extends RefFields>(
  entity: { apiVersion: A; metadata: M; kind: K; spec: S },
  ctx: z.RefinementCtx,
): { apiVersion: A; metadata: Omit<M, 'namespace'>; kind: K; spec: S } {
  const { namespace, ...metadata } = entity.metadata
  return {
    apiVersion: entity.apiVersion,
    metadata,
    kind: entity.kind,
    spec: qualifiedSpec(entity.spec, namespace, ctx),
  }
}

export const metadataSchema = z.object({
  name: z.string().regex(NAME_PATTERN, 'invalid Backstage name'),
  description: z.string().optional(),
  annotations: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string()).optional(),
})

const baseFields = {
  apiVersion: z.literal('backstage.io/v1alpha1'),
  /**
   * `namespace` is read for one purpose — the default of a reference that
   * omits its own — and not yielded: it was stripped before short forms were
   * read, and carrying it is the namespace work, not this.
   */
  metadata: metadataSchema.extend({ namespace: z.unknown().optional() }),
}

export const componentSchema = z
  .object({
    ...baseFields,
    kind: z.literal('Component'),
    spec: z.object({
      type: z.string().min(1),
      lifecycle: z.enum(['experimental', 'production', 'deprecated']),
      owner: readOwnerRefSchema,
      dependsOn: z.array(readDependencyRefSchema).optional(),
    }),
  })
  .transform(qualify)

export const resourceSchema = z
  .object({
    ...baseFields,
    kind: z.literal('Resource'),
    spec: z.object({
      type: z.enum(RESOURCE_TYPE_NAMES),
      owner: readOwnerRefSchema,
      dependsOn: z.array(readDependencyRefSchema).optional(),
      /** An access carries its consumers; a resource does not (design 4.1). */
      dependencyOf: z.array(readDependencyRefSchema).optional(),
      /**
       * What the right grants (design 4.1). Optional, and the optionality is
       * the one decision here that costs something.
       *
       * `entitySchema` READS a repository that already exists, and no access
       * in one carries this field yet: required would make `validate` — the
       * command a user points at the repository they already have — report
       * invalid-entity on every access declaration in it. It is also
       * meaningless on a `network-access` or a `gateway-route`: a flow is not
       * read or write, and requiring it on some rights and not others would be
       * a second registry of which rights are levelled, which is the split
       * `ACCESS_LEVELS` exists to avoid.
       *
       * What the optionality does NOT buy is a default. An absent level is
       * reported as absent wherever it is read — `show` says undeclared, the
       * serialiser writes no line, the signature classifies no leaf — and is
       * never read as readwrite. It buys a right that parses, not a grant
       * anyone can review; the diff and the Reviewer are what catch that.
       */
      access: z.enum(ACCESS_LEVELS).optional(),
    }),
  })
  .superRefine((value, ctx) => {
    // Enforced here rather than left to review: a consumer list on an object is
    // valid YAML that the catalogue ingests without complaint, so nothing
    // downstream would ever report it.
    if (value.spec.dependencyOf !== undefined && natureOf(value.spec.type) !== 'right') {
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'dependencyOf'],
        message: `'${value.spec.type}' is an object; only a right carries its consumers`,
      })
    }

    // The same shape, for the same reason: a level on a database is valid YAML
    // the catalogue ingests without complaint, so the schema is the only place
    // that would ever report it. An object is not a grant — there is nothing
    // for a level to be about.
    if (value.spec.access !== undefined && natureOf(value.spec.type) !== 'right') {
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'access'],
        message: `'${value.spec.type}' is an object; only a right carries an access level`,
      })
    }
  })
  .transform(qualify)

export const entitySchema = z.discriminatedUnion('kind', [componentSchema, resourceSchema])

export type Component = z.infer<typeof componentSchema>
export type Resource = z.infer<typeof resourceSchema>
export type Entity = z.infer<typeof entitySchema>
