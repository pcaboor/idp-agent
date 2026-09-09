import { z } from 'zod'

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

export const RESOURCE_TYPES = [
  'database',
  'cache',
  'api',
  'database-access',
  'network-access',
  'gateway-route',
] as const

export type ResourceType = (typeof RESOURCE_TYPES)[number]

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

export const resourceSchema = z.object({
  ...baseFields,
  kind: z.literal('Resource'),
  spec: z.object({
    type: z.enum(RESOURCE_TYPES),
    owner: ownerRefSchema,
    dependsOn: z.array(entityRefSchema).optional(),
    /** An access carries its consumers; a resource does not (design section 4.1). */
    dependencyOf: z.array(entityRefSchema).optional(),
  }),
})

export const entitySchema = z.discriminatedUnion('kind', [componentSchema, resourceSchema])

export type Component = z.infer<typeof componentSchema>
export type Resource = z.infer<typeof resourceSchema>
export type Entity = z.infer<typeof entitySchema>
