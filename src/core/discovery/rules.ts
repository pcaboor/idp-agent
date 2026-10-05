import type { ResourceType } from '../schemas/resource-types.js'
import type { Engine, Fields } from './finding.js'

/** The extractors of slice 1: the sample family of dotenv files, and npm's `package.json` (plan, Task 1.4). */
export type ExtractorName = 'env-file' | 'npm'

/**
 * What a finding of a rule can vouch for, once 2.6 lets one vouch: the kind of
 * a dependency, its target, the account it is reached as, the Component's
 * name. A package in a dependency list says a client is installed, never what
 * it is reached for (`project-tools.ts`), so `npm.dependency` supports a kind
 * and nothing else; a connection string supports a kind, a target and an
 * account.
 */
export type Support = 'kind' | 'target' | 'account' | 'name'

/**
 * Every rule, its version, the extractor that runs it, the fields its
 * findings may carry and what they may support. A version is part of a
 * finding's ID, so a rule that changes what it reads changes its version and
 * no finding of the old reading passes for one of the new. A field a rule does
 * not list is an engine bug when a finding carries it: `mintFinding` throws.
 */
export const RULES = {
  'env-file.url': {
    version: 1,
    extractor: 'env-file',
    fields: ['scheme', 'hosts', 'database', 'account', 'url', 'variable'],
    supports: ['kind', 'target', 'account'],
  },
  'npm.name': { version: 1, extractor: 'npm', fields: ['name'], supports: ['name'] },
  'npm.dependency': { version: 1, extractor: 'npm', fields: ['package'], supports: ['kind'] },
} as const satisfies Record<
  string,
  {
    readonly version: number
    readonly extractor: ExtractorName
    readonly fields: readonly (keyof Fields)[]
    readonly supports: readonly Support[]
  }
>

export type RuleName = keyof typeof RULES

/**
 * The resource type an engine is declared as, or none: kafka and amqp are
 * found and reported "not expressible", because the registry has no type for
 * a topic or a queue and does not grow in v1 (stage 8 brief, answer 9). A
 * record, so an engine added without its entry does not compile.
 */
export const ENGINE_TYPE: { readonly [E in Engine]: ResourceType | undefined } = {
  postgres: 'database',
  mysql: 'database',
  mariadb: 'database',
  mssql: 'database',
  oracle: 'database',
  mongodb: 'database',
  redis: 'cache',
  amqp: undefined,
  kafka: undefined,
  http: 'api',
}
