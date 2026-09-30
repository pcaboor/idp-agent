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
 * `user:`), System for `spec.system`, none at all for `spec.dependsOn` and
 * `spec.dependencyOf`, where a reference must carry its kind. Kinds and
 * namespaces compare case-insensitively, so both are lower-cased; a NAME is
 * not folded, and one outside the grammar below is refused as it always was —
 * except in `spec.system`, which is kept as written (readSystemRefSchema).
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

/**
 * `spec.system`, which Backstage defaults to the System kind. Backstage's own
 * schema asks only for a non-empty string, and this tool only prints the
 * field — it keys nothing and relates nothing on it. So a system is refused
 * where the catalogue would refuse it and nowhere else: a reference this
 * grammar reads is written in full (`qualifiedSpec`), and one it does not — an
 * upper-case name, which Backstage allows and this grammar does not fold — is
 * kept as the file wrote it. Refusing that would take the entity out of every
 * command, and turn `validate` red, over a line on `show`'s card.
 */
const readSystemRefSchema = z.string().min(1, 'expected a system reference')

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

/**
 * `spec.providesApis`: Backstage's short form, with API the default kind. A
 * reference that names another kind keeps it — Backstage defaults a kind, it
 * does not overrule one. Read as `spec.system` is, and for its reason: this
 * tool never writes the field, and a reference this grammar cannot split is
 * kept as the file wrote it (`qualifiedSpec`) and reported as dangling, since
 * nothing declares it. Refusing it would take the service out of every command
 * over one line of its card. A name in upper case, which Backstage allows, is
 * folded instead: Backstage compares references without regard to case.
 */
const readApiRefSchema = z.string().min(1, 'expected an API reference')

interface RefFields {
  owner: string
  system?: string | undefined
  subcomponentOf?: string | undefined
  dependsOn?: string[] | undefined
  dependencyOf?: string[] | undefined
  providesApis?: string[] | undefined
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
  // In full when it can be, as written when it cannot: see readSystemRefSchema.
  const lenient = (ref: string, defaultKind: string): string => {
    const [, kind = defaultKind, stated = own, name] = SHORT_REF.exec(ref) ?? []
    return name === undefined || stated === undefined
      ? ref
      : `${kind.toLowerCase()}:${stated.toLowerCase()}/${name}`
  }
  // Backstage compares references without regard to case, and allows upper
  // case in a name, which this grammar does not read: such a name is folded,
  // as `ignoredOf` folds the reference of the API it sets aside for it, so the
  // two meet. Anything else the grammar cannot split is kept as written.
  const provided = (ref: string): string =>
    !SHORT_REF.test(ref) && SHORT_REF.test(ref.toLowerCase())
      ? lenient(ref.toLowerCase(), 'api')
      : lenient(ref, 'api')
  return {
    ...spec,
    owner: read(spec.owner, 'group', ['owner']),
    ...(spec.system !== undefined && { system: lenient(spec.system, 'system') }),
    ...(spec.subcomponentOf !== undefined && {
      subcomponentOf: lenient(spec.subcomponentOf, 'component'),
    }),
    ...(spec.dependsOn !== undefined && {
      dependsOn: spec.dependsOn.map((ref, at) => read(ref, undefined, ['dependsOn', at])),
    }),
    ...(spec.dependencyOf !== undefined && {
      dependencyOf: spec.dependencyOf.map((ref, at) => read(ref, undefined, ['dependencyOf', at])),
    }),
    // A set, as Backstage keeps relations: an API listed twice, in any
    // spelling, is provided once, where it was first listed.
    ...(spec.providesApis !== undefined && {
      providesApis: [...new Set(spec.providesApis.map(provided))],
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

/**
 * Backstage's `metadata.links`: where to go to see or run the entity. Read so
 * `show` can print them, never proposed — a URL is what a reviewer clicks, and
 * a model has no business choosing one (plan.ts has no field for it).
 */
const linkSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  icon: z.string().optional(),
  type: z.string().optional(),
})

/** Why a title or a label that is not text refuses its entity. */
const BACKSTAGE_TEXT = 'expected text, which Backstage requires'

export const metadataSchema = z.object({
  name: z.string().regex(NAME_PATTERN, 'invalid Backstage name'),
  /**
   * What a person calls the entity, and its labels: read so `show` can print
   * them, never proposed — like the links, nothing a model writes has a field
   * for either. Each is text, as Backstage requires: a `tier: 1` refuses the
   * entity, as a number among the annotations does, where it was stripped
   * and the entity loaded before they were read. The reason names the rule's
   * owner, since the value parsed and reads as fine.
   */
  title: z.string({ error: BACKSTAGE_TEXT }).optional(),
  description: z.string().optional(),
  labels: z.record(z.string(), z.string({ error: BACKSTAGE_TEXT })).optional(),
  annotations: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string()).optional(),
  links: z.array(linkSchema).optional(),
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

/**
 * A Component's lifecycle: a closed set, and one list of it — the reader, the
 * proposal and the prompt that asks for one (`clarify.ts`) all read this.
 */
export const COMPONENT_LIFECYCLES = ['experimental', 'production', 'deprecated'] as const

export const componentSchema = z
  .object({
    ...baseFields,
    kind: z.literal('Component'),
    spec: z.object({
      type: z.string().min(1),
      lifecycle: z.enum(COMPONENT_LIFECYCLES),
      owner: readOwnerRefSchema,
      /** Read side only, like the links: no proposal names a system. */
      system: readSystemRefSchema.optional(),
      /**
       * The component this one is part of, Component the default kind — read
       * as `spec.system` is, for its reason: this tool only prints it.
       */
      subcomponentOf: z.string().min(1, 'expected a component reference').optional(),
      /**
       * The Backstage APIs this service provides — read, and never proposed:
       * `proposedComponentSchema` has no field for it. `spec.consumesApis` is
       * deliberately not read, and zod strips it: in this tool, consuming
       * something is an access right — a Resource that `dependsOn` what it
       * reaches and lists the consumer in `dependencyOf` — because that is what
       * gets provisioned, and a second declaration of the same fact would be a
       * second truth to keep aligned with the first (design 4.1). Not read on a
       * Resource either: Backstage gives a Resource no such field.
       */
      providesApis: z.array(readApiRefSchema).optional(),
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
      system: readSystemRefSchema.optional(),
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

/**
 * The keys a document of a kind this tool reads holds and the read model does
 * not read — `relations`, `metadata.uid`, `spec.consumesApis` — one path per
 * key, sorted. The schemas strip them; this is what says they were there
 * (domain-backstage-7), so a reader is told a field of the file reached no
 * answer rather than finding out. Only the three levels the read model has:
 * what is inside a field it reads, a link's keys say, is that field's.
 *
 * Read off the schemas' own shapes, so a field the read model starts to read
 * leaves this list without a second place to keep in step.
 */
export function unreadFieldsOf(document: unknown): string[] {
  const shape = shapes.get(kindOfDocument(document) ?? '')
  if (shape === undefined) return []
  const keysOf = (value: unknown): string[] =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : []
  const record = document as Record<string, unknown>
  return [
    ...keysOf(document).filter((key) => !shape.top.has(key)),
    ...keysOf(record['metadata'])
      .filter((key) => !shape.metadata.has(key))
      .map((key) => `metadata.${key}`),
    ...keysOf(record['spec'])
      .filter((key) => !shape.spec.has(key))
      .map((key) => `spec.${key}`),
  ].sort()
}

const kindOfDocument = (document: unknown): string | undefined => {
  const kind =
    typeof document === 'object' && document !== null
      ? (document as Record<string, unknown>)['kind']
      : undefined
  return typeof kind === 'string' ? kind : undefined
}

/** The three levels of a read schema, before its transform: what it reads. */
const levelsOf = (schema: {
  in: { shape: { metadata: { shape: object }; spec: { shape: object } } }
}): { top: ReadonlySet<string>; metadata: ReadonlySet<string>; spec: ReadonlySet<string> } => ({
  top: new Set(Object.keys(schema.in.shape)),
  metadata: new Set(Object.keys(schema.in.shape.metadata.shape)),
  spec: new Set(Object.keys(schema.in.shape.spec.shape)),
})

/**
 * The write model: the two kinds this tool proposes, files and amends. What
 * `propose()` can express, the serialiser writes and the plan's gates judge.
 */
export const entitySchema = z.discriminatedUnion('kind', [componentSchema, resourceSchema])

export type Component = z.infer<typeof componentSchema>
export type Resource = z.infer<typeof resourceSchema>
export type Entity = z.infer<typeof entitySchema>

/** What a definition is kept as: that it is there. */
const DECLARED = 'declared'

/**
 * The `spec.definition` placeholders the catalogue resolves to text: a mapping
 * of one key naming where the definition is. `$text` is Backstage's own, and
 * `$openapi` and `$asyncapi` its API docs module's, which bundle the document
 * they name into text. `$json` and `$yaml` are placeholders too, but Backstage
 * parses what they name into structured data, and its API schema then refuses
 * the definition, which must be a string — so they are refused here as well.
 */
const TEXT_PLACEHOLDERS: ReadonlySet<string> = new Set(['$text', '$openapi', '$asyncapi'])

const isPlaceholder = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value)
  if (entries.length !== 1) return false
  const [[key, target] = ['', undefined]] = entries
  return TEXT_PLACEHOLDERS.has(key) && typeof target === 'string' && target !== ''
}

/**
 * Whether the reader reads `value` as an API's definition: text, or one
 * placeholder that yields text. What `definitionSchema` applies, exported so
 * a catalogue read kept on disk keeps such a definition as `declared` — which
 * reads the same — and never its text (`context/backstage/cache.ts`).
 */
export const readsAsDefinition = (value: unknown): boolean =>
  (typeof value === 'string' && value !== '') || isPlaceholder(value)

/**
 * An API's contract — an OpenAPI document, a protobuf file — as Backstage
 * requires it: text, or one placeholder the catalogue resolves to text.
 *
 * Kept as the literal `'declared'` and nothing else, so no reader downstream
 * can print it, put it in a row or send it to a model: there is no field that
 * could carry it. A definition is written by whoever owns the API, can run to
 * thousands of lines, and says nothing a question about the catalogue needs
 * beyond its presence. A refusal names the field and never quotes the value.
 */
const definitionSchema = z
  .custom<unknown>(readsAsDefinition, {
    error: ({ input }) =>
      input === undefined
        ? 'required: Backstage refuses an API without its definition'
        : 'expected the definition as text, or one placeholder that yields text ' +
          '($text, $openapi or $asyncapi)',
  })
  .transform((): typeof DECLARED => DECLARED)

/**
 * Backstage's own API kind, read and never written: the read model is wider
 * than the write model (design 4.1). What Backstage requires of an API, it
 * requires here — a type (openapi, asyncapi, graphql, grpc, or any other
 * string), a lifecycle, an owner and a definition — and an API missing one is
 * refused with a reason, like a broken Component, because the catalogue would
 * refuse it too. Its metadata is read as every kind's is, and its owner and
 * system are normalised the same way.
 *
 * The lifecycle is Backstage's non-empty string, not the Component's closed
 * three: this tool never writes an API, so it has no convention of its own to
 * hold one to. The kind is `API` exactly, as Backstage's schema spells it: a
 * `kind: api` is routed here, as `kind: component` is routed to the Component
 * schema, and refused by the literal.
 *
 * Three APIs never reach this schema, and are set aside as they were before it
 * existed (`parseDocuments`): one under another tool's apiVersion, one outside
 * the default namespace, which the graph's `kind:default/name` keys cannot
 * tell from its namesake, and one whose name Backstage allows and this
 * grammar does not — upper case. A name Backstage refuses too is refused here.
 */
export const apiSchema = z
  .object({
    ...baseFields,
    // Both versions Backstage's API schema accepts. The write model keeps the
    // one it writes; an API is never written.
    apiVersion: z.enum(['backstage.io/v1alpha1', 'backstage.io/v1beta1']),
    kind: z.literal('API'),
    spec: z.object({
      type: z.string().min(1),
      lifecycle: z.string().min(1),
      owner: readOwnerRefSchema,
      system: readSystemRefSchema.optional(),
      definition: definitionSchema,
    }),
  })
  .transform(qualify)

export type Api = z.infer<typeof apiSchema>

/**
 * Backstage's organisation: the four kinds its processor turns into ownership,
 * membership and system membership (`BuiltinKindsEntityProcessor.ts`). Read,
 * beside the entities and never among them, and never proposed: `plan.ts` has
 * no field for any of them.
 */
export const ORGANISATION_KINDS = ['Group', 'User', 'System', 'Domain'] as const
export type OrganisationKind = (typeof ORGANISATION_KINDS)[number]

/**
 * What the read model reads of an organisation document's metadata: its name,
 * and its namespace, for the default of a reference that omits its own —
 * nothing else. Not a title, not a description, not an annotation: an
 * organisation provider puts a person's email and directory id among the
 * annotations of every User (Backstage's Microsoft Graph provider,
 * `defaultUserTransformer`), and what a file holds beyond these two keys is
 * named on `not read:` (`unreadFieldsOf`) and kept nowhere.
 */
export const organisationMetadataSchema = z.object({
  name: z.string().regex(NAME_PATTERN, 'invalid Backstage name'),
  namespace: z.unknown().optional(),
})

/** A reference as Backstage's schema asks for one: a non-empty string, read leniently. */
const organisationRefSchema = z.string().min(1, 'expected a reference')

/**
 * Each organisation reference in full, in the entity's namespace, with the kind
 * Backstage's processor defaults it to: `owner`, `parent`, `children` and
 * `memberOf` a Group, `members` a User, `domain` and `subdomainOf` a Domain.
 * Read as `spec.system` and `spec.providesApis` are, for their reason: this
 * tool never writes one, so a reference the grammar cannot split is kept as
 * the file wrote it and names nothing, and one in upper case is folded, since
 * Backstage compares references without regard to case.
 */
const ORGANISATION_DEFAULT_KINDS = {
  owner: 'group',
  parent: 'group',
  children: 'group',
  memberOf: 'group',
  members: 'user',
  domain: 'domain',
  subdomainOf: 'domain',
} as const

type OrganisationRefField = keyof typeof ORGANISATION_DEFAULT_KINDS

function qualifyOrganisation<
  A,
  K,
  S extends { readonly [F in OrganisationRefField]?: string | readonly string[] | undefined },
>(entity: {
  apiVersion: A
  kind: K
  metadata: { name: string; namespace?: unknown }
  spec: S
}): { apiVersion: A; kind: K; metadata: { name: string }; spec: S } {
  const { namespace } = entity.metadata
  const own =
    namespace === undefined
      ? 'default'
      : typeof namespace === 'string' && NAMESPACE_VALUE.test(namespace)
        ? namespace.toLowerCase()
        : undefined
  const full = (ref: string, defaultKind: string): string => {
    const readable = !SHORT_REF.test(ref) && SHORT_REF.test(ref.toLowerCase()) ? ref.toLowerCase() : ref
    const [, kind = defaultKind, stated = own, name] = SHORT_REF.exec(readable) ?? []
    return name === undefined || stated === undefined
      ? ref
      : `${kind.toLowerCase()}:${stated.toLowerCase()}/${name}`
  }
  const spec: Record<string, unknown> = { ...entity.spec }
  for (const field of Object.keys(ORGANISATION_DEFAULT_KINDS) as OrganisationRefField[]) {
    const value = entity.spec[field]
    const kind = ORGANISATION_DEFAULT_KINDS[field]
    if (typeof value === 'string') spec[field] = full(value, kind)
    else if (value !== undefined) spec[field] = [...new Set(value.map((ref) => full(ref, kind)))]
  }
  return {
    apiVersion: entity.apiVersion,
    kind: entity.kind,
    metadata: { name: entity.metadata.name },
    spec: spec as S,
  }
}

/** Both versions Backstage's schemas for the four kinds accept. */
const organisationApiVersion = z.enum(['backstage.io/v1alpha1', 'backstage.io/v1beta1'])

/**
 * A team, a department, an organisation. What Backstage requires of one is
 * required here — a type and its children, which may be none — and its parent
 * and members are read when stated. A child's `parent` and its parent's
 * `children` are one edge, as a Group's `members` and a User's `memberOf` are
 * (the graph reads both ends). Refused, it is set aside, never rejected
 * (`readValue`).
 */
export const groupSchema = z
  .object({
    apiVersion: organisationApiVersion,
    kind: z.literal('Group'),
    metadata: organisationMetadataSchema,
    spec: z.object({
      type: z.string().min(1),
      parent: organisationRefSchema.optional(),
      children: z.array(organisationRefSchema),
      members: z.array(organisationRefSchema).optional(),
    }),
  })
  .transform(qualifyOrganisation)

/**
 * A person: a name and the groups they are a member of, which Backstage
 * requires and allows to be none. `spec.profile` — a display name, an email,
 * a picture that can be a data URI of any size — is never read.
 */
export const userSchema = z
  .object({
    apiVersion: organisationApiVersion,
    kind: z.literal('User'),
    metadata: organisationMetadataSchema,
    spec: z.object({
      memberOf: z.array(organisationRefSchema),
    }),
  })
  .transform(qualifyOrganisation)

/**
 * What a product is made of. Its parts name it — a Component's, a Resource's
 * or an API's `spec.system` — and it names none of them, as Backstage's
 * processor emits `partOf` from the part. An owner is required, its domain
 * and type read when stated.
 */
export const systemSchema = z
  .object({
    apiVersion: organisationApiVersion,
    kind: z.literal('System'),
    metadata: organisationMetadataSchema,
    spec: z.object({
      owner: organisationRefSchema,
      domain: organisationRefSchema.optional(),
      type: z.string().min(1).optional(),
    }),
  })
  .transform(qualifyOrganisation)

/** A business area: its Systems name it, and so do its subdomains. An owner is required. */
export const domainSchema = z
  .object({
    apiVersion: organisationApiVersion,
    kind: z.literal('Domain'),
    metadata: organisationMetadataSchema,
    spec: z.object({
      owner: organisationRefSchema,
      subdomainOf: organisationRefSchema.optional(),
      type: z.string().min(1).optional(),
    }),
  })
  .transform(qualifyOrganisation)

/** The organisation, read: each of the four kinds by its own schema. */
export const organisationSchema = z.discriminatedUnion('kind', [
  groupSchema,
  userSchema,
  systemSchema,
  domainSchema,
])

export type OrganisationEntity = z.infer<typeof organisationSchema>

/** By the kind a document states, as `parseDocuments` routes it: exactly. */
const shapes = new Map<string, ReturnType<typeof levelsOf>>([
  ['Component', levelsOf(componentSchema)],
  ['Resource', levelsOf(resourceSchema)],
  ['API', levelsOf(apiSchema)],
  ['Group', levelsOf(groupSchema)],
  ['User', levelsOf(userSchema)],
  ['System', levelsOf(systemSchema)],
  ['Domain', levelsOf(domainSchema)],
])

/**
 * The read model's entities: the write model, and the kinds this tool reads
 * and never proposes — today Backstage's API. The write side takes `Entity`
 * and never meets one of these. The organisation is read beside them and is
 * not one of them (`OrganisationEntity`): a Group has no environment and no
 * type a vocabulary lists, and every table, summary and gate built from the
 * entities stays what it was.
 */
export type CatalogueEntity = Entity | Api

/** Every node the graph holds: the read model's entities, and the organisation beside them. */
export type GraphNode = CatalogueEntity | OrganisationEntity
