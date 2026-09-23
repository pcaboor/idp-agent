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

/**
 * What a right grants.
 *
 * A property of the grant, not a kind of thing. Splitting `database-access`
 * into `database-read` and `database-readwrite` would double this table and
 * the folder layout for one boolean, and every rule that asks a type for its
 * nature would then be asking two entries the same question.
 *
 * Two levels, closed, and neither of them a default. `resourceSchema` says
 * what an absent one means and what that costs.
 */
export const ACCESS_LEVELS = ['read', 'readwrite'] as const

export type AccessLevel = (typeof ACCESS_LEVELS)[number]

interface ResourceTypeEntry {
  readonly nature: Nature
  readonly folder: string
  /**
   * Whether a grant of this type is read or write.
   *
   * Not every right has a level. A network flow is opened or it is not — asking
   * whether it is "read" is asking the wrong question — and a gateway route is
   * the same. Putting the fact in the registry means the schema does not carry
   * a second list of which rights are levelled, which is the split that
   * `ACCESS_LEVELS` being one enum already avoids.
   */
  readonly levelled?: true
}

export const RESOURCE_TYPES = {
  database: { nature: 'object', folder: 'catalog/databases' },
  cache: { nature: 'object', folder: 'catalog/caches' },
  api: { nature: 'object', folder: 'catalog/apis' },
  'database-access': { nature: 'right', folder: 'dependencies/access', levelled: true },
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

/** Whether a grant of this type states read or write. See ResourceTypeEntry. */
export function levelledOf(type: ResourceType): boolean {
  const entry: ResourceTypeEntry = RESOURCE_TYPES[type]
  return entry.levelled === true
}
