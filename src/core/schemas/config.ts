import { z } from 'zod'

/**
 * `.idp-agent.yml`, design §7.0.
 *
 * It is committed, so a whole team shares one configuration and a newcomer has
 * nothing to set up. It holds **no secret** — model credentials come from the
 * environment, and there is no forge credential of idpa's — the person's git
 * and gh hold theirs (ADR-0015) —, and nothing below reads any: what is shared
 * is versioned, what is personal never enters the repository.
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
 * A locator's authority: what follows an optional `scheme://` up to the first
 * `/`. An scp-style `git@host:org/repo` has no scheme and no slash before its
 * `@`, so its user is in here too.
 */
const AUTHORITY = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?([^/]*)/

/**
 * Why a locator is not one `.idp-agent.yml` may hold: userinfo, a query or a
 * fragment is where a credential sits — a clone URL copied from `git remote
 * -v` carries its token as `https://oauth2:<token>@host/…` — and this file is
 * committed, then pushed. ADR-0011's rule for a catalogue URL, on a locator
 * that need not be a URL. A plain user such as scp's `git@` holds no secret,
 * and is refused all the same: telling a user from a token by its shape is a
 * guess, and `host/path` names the same repository.
 *
 * The reason never quotes the value: that is where the secret would be.
 */
const CREDENTIAL_SHAPED =
  'a locator never holds userinfo, a query or a fragment: that is where a credential ' +
  'would be, and this file is committed; name the repository alone, e.g. github.com/acme/iac'

const carriesCredential = (locator: string): boolean =>
  /[?#]/.test(locator) || (AUTHORITY.exec(locator)?.[1] ?? '').includes('@')

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
 * clone of it — and the one field a pasted URL could smuggle one into,
 * `iacRepo`, refuses the places it would sit (`carriesCredential`). One gate,
 * so the flag, the answer, the reader and `clearService` all refuse it.
 */
export const repositoryConfigSchema = z.strictObject({
  /**
   * Where the declarations live. §7.0's own example is `github.com/org/iac-repo`.
   * Read as a cross-check, never a source: `plan "<intent>" --submit` refuses a clone
   * tracking another repository on github.com (`refuseOtherRepository`, stage 6).
   */
  iacRepo: z
    .string()
    .min(1)
    .max(512)
    .refine((locator) => !carriesCredential(locator), { message: CREDENTIAL_SHAPED }),
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

/**
 * Every control, every format character (the bidi marks and U+FEFF included)
 * and the two line separators — wider than the set a terminal is protected
 * from. A configuration value is a host and a list of environment names, and
 * holds none of them for any reason a person means — unlike a name, where a
 * mark is how right-to-left is typed. The file is committed and seeds every
 * gate's vocabulary: a direction override in it is a value a reviewer reads
 * the wrong way round.
 *
 * Checked twice, on purpose: where a person types the value — the flag or
 * the answer, before any model (`cli/commands/init.ts`) — and again by
 * `clearService`, the engine's re-check at the moment of acting.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

export const holdsInvisible = (value: string): boolean => INVISIBLE.test(value)

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
