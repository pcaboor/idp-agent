import { z } from 'zod'
import { ACCESS_LEVELS, RESOURCE_TYPE_NAMES, natureOf } from './resource-types.js'

/** Annotation carrying an entity's own file location. Read it; never re-derive it. */
export const SOURCE_FILE_ANNOTATION = 'idp-agent.dev/source-file'

/** Backstage names: up to 63 chars, alphanumerics plus - _ ., not at the edges. */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/

/** `kind:namespace/name`, e.g. `resource:default/billing-db-dev`. */
export const entityRefSchema = z
  .string()
  .regex(/^[a-z]+:[a-z0-9-]+\/[a-z0-9._-]+$/, 'expected kind:namespace/name')

/** Ownership is always a group or a user, never a bare string. */
export const ownerRefSchema = z
  .string()
  .regex(/^(group|user):[a-z0-9-]+\/[a-z0-9._-]+$/, 'expected group:... or user:...')

export const metadataSchema = z.object({
  name: z.string().regex(NAME_PATTERN, 'invalid Backstage name'),
  description: z.string().optional(),
  annotations: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string()).optional(),
})

const baseFields = {
  apiVersion: z.literal('backstage.io/v1alpha1'),
  metadata: metadataSchema,
}

export const componentSchema = z.object({
  ...baseFields,
  kind: z.literal('Component'),
  spec: z.object({
    type: z.string().min(1),
    lifecycle: z.enum(['experimental', 'production', 'deprecated']),
    owner: ownerRefSchema,
    dependsOn: z.array(entityRefSchema).optional(),
  }),
})

export const resourceSchema = z
  .object({
    ...baseFields,
    kind: z.literal('Resource'),
    spec: z.object({
      type: z.enum(RESOURCE_TYPE_NAMES),
      owner: ownerRefSchema,
      dependsOn: z.array(entityRefSchema).optional(),
      /** An access carries its consumers; a resource does not (design 4.1). */
      dependencyOf: z.array(entityRefSchema).optional(),
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

export const entitySchema = z.discriminatedUnion('kind', [componentSchema, resourceSchema])

export type Component = z.infer<typeof componentSchema>
export type Resource = z.infer<typeof resourceSchema>
export type Entity = z.infer<typeof entitySchema>
