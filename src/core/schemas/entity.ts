import { z } from 'zod'
import { RESOURCE_TYPE_NAMES, natureOf } from './resource-types.js'

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
  })

export const entitySchema = z.discriminatedUnion('kind', [componentSchema, resourceSchema])

export type Component = z.infer<typeof componentSchema>
export type Resource = z.infer<typeof resourceSchema>
export type Entity = z.infer<typeof entitySchema>
