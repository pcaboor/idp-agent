import { z } from 'zod'

/**
 * `.idp-agent.yml`, design §7.0.
 *
 * It is committed, so a whole team shares one configuration and a newcomer has
 * nothing to set up. It holds **no secret** — model credentials come from the
 * environment and the forge token from `GITHUB_TOKEN`, and nothing below reads
 * either: what is shared is versioned, what is personal never enters the
 * repository.
 *
 * Its absence is a fact about a repository, not a failure of one. §7.0 says so
 * in as many words — the missing file is what makes the CLI offer a guided tour
 * rather than fail — so `readConfig` returns `undefined` and the vocabulary
 * falls back to what the entities show. A file that is *there* and malformed is
 * the opposite case and throws, naming the field: it was written on purpose,
 * and quietly falling back would answer a typo with a run that silently asks
 * about everything.
 *
 * The schema and the serialiser live in `core/` because a service's clearance
 * carries the configuration's bytes (`clearService`), and `core/` imports no
 * `cli/`. The read stays in `cli/config.ts`: it touches a disk. Named
 * `repositoryConfigSchema` because `cli/personal.ts` reads a second, personal
 * `config.yml`, with a `backstage` and a `repo` of its own, and "config" alone
 * no longer says which.
 */

export const CONFIG_FILE = '.idp-agent.yml'

/**
 * The ceiling `proposedResourceSchema.metadata.env` already uses. Borrowed
 * rather than restated: an environment a configuration declares and a proposal
 * could never carry is a value whose only possible outcome is a refusal.
 */
const MAX_ENVIRONMENT_LENGTH = 63

/**
 * §7.0's three fields, and only those. `backstage` carries the document's `#
 * optional` comment; the other two do not, and inventing a second optionality
 * is exactly the drift this schema exists to prevent — a repository with no
 * `environments` is the one every environment policy goes silent on.
 *
 * `strictObject`, so `enviroments:` is a message rather than a mystery. A typo
 * in a committed file is otherwise invisible: the key is dropped, the
 * vocabulary falls back to the entities, and a fresh repository asks about
 * every environment for no stated reason.
 *
 * What this does NOT hold is a credential, and there is deliberately no field
 * that could carry one (§7.0). A token in a committed file is a token in every
 * clone of it.
 */
export const repositoryConfigSchema = z.strictObject({
  /** Where the declarations live. §7.0's own example is `github.com/org/iac-repo`. */
  iacRepo: z.string().min(1).max(512),
  /**
   * Read, never written: a committed file may hold one, and it is never
   * requested (`SECURITY.md`); `init --submit` writes none (D9, ADR-0011).
   */
  backstage: z.string().min(1).max(512).optional(),
  /**
   * The environments this organisation has. Bounded like every other list the
   * engine carries: these reach a model through the catalogue summary, and an
   * unbounded one is an unbounded prompt.
   */
  environments: z.array(z.string().min(1).max(MAX_ENVIRONMENT_LENGTH)).min(1).max(64),
})

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>

/** What `init --submit` writes: never `backstage` (D9, ADR-0011). */
export type WrittenConfig = Pick<RepositoryConfig, 'iacRepo' | 'environments'>

/**
 * The bytes `init --submit` writes. Deterministic — key order fixed, every
 * scalar a JSON string, which is a YAML 1.2 double-quoted scalar — so the same
 * configuration is the same file, and the forge can recognise a submission it
 * already made.
 *
 * Parsed on the way out as well as on the way in: what this writes is what
 * the reader accepts, or it throws here rather than on the next run. Only the
 * two written fields are handed to the schema, so a `backstage` a caller's
 * value happens to carry — a `RepositoryConfig` read from disk — is never
 * written back.
 */
export function serializeConfig(config: WrittenConfig): string {
  const parsed = repositoryConfigSchema.parse({
    iacRepo: config.iacRepo,
    environments: config.environments,
  })
  return [
    `iacRepo: ${JSON.stringify(parsed.iacRepo)}`,
    `environments: [${parsed.environments.map((env) => JSON.stringify(env)).join(', ')}]`,
    '',
  ].join('\n')
}
