/**
 * The registry of resource types.
 *
 * A resource is an object; an access is a right over that resource (design 4.1).
 * The folder is not a naming convention, it follows from the nature: objects live
 * under catalog/, rights under dependencies/. Keeping both facts on one line means
 * adding a type is a single edit, and no rule about objects versus rights has to
 * enumerate type names by hand.
 *
 * This is a static registry today. When custom types become configurable, it is
 * this table that gets built at start-up instead of declared here; nothing that
 * consumes it needs to change.
 */

export type Nature = 'object' | 'right'

interface ResourceTypeEntry {
  readonly nature: Nature
  readonly folder: string
}

export const RESOURCE_TYPES = {
  database: { nature: 'object', folder: 'catalog/databases' },
  cache: { nature: 'object', folder: 'catalog/caches' },
  api: { nature: 'object', folder: 'catalog/apis' },
  'database-access': { nature: 'right', folder: 'dependencies/access' },
  'network-access': { nature: 'right', folder: 'dependencies/network' },
  'gateway-route': { nature: 'right', folder: 'dependencies/gateway' },
} as const satisfies Record<string, ResourceTypeEntry>

export type ResourceType = keyof typeof RESOURCE_TYPES

/** Non-empty tuple, the shape z.enum expects. */
export const RESOURCE_TYPE_NAMES = Object.keys(RESOURCE_TYPES) as [
  ResourceType,
  ...ResourceType[],
]

export function natureOf(type: ResourceType): Nature {
  return RESOURCE_TYPES[type].nature
}

export function folderOf(type: ResourceType): string {
  return RESOURCE_TYPES[type].folder
}
