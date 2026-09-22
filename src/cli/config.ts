import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, YAMLParseError } from 'yaml'
import { z } from 'zod'
import { reasonOf } from '../core/schemas/reject.js'
import type { Vocabulary } from '../core/schemas/vocabulary.js'

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
 */

export const CONFIG_FILE = '.idp-agent.yml'

/**
 * Refused, not absent. Thrown rather than returned for the reason
 * `PlanInputError` is: `cli/index.ts` is the only place that turns a fact into
 * an exit code, and a configuration nobody can read is an argument error — the
 * user typed a directory whose committed file does not parse.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

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
const configSchema = z.strictObject({
  /** Where the declarations live. §7.0's own example is `github.com/org/iac-repo`. */
  iacRepo: z.string().min(1).max(512),
  backstage: z.string().min(1).max(512).optional(),
  /**
   * The environments this organisation has. Bounded like every other list the
   * engine carries: these reach a model through the catalogue summary, and an
   * unbounded one is an unbounded prompt.
   */
  environments: z.array(z.string().min(1).max(MAX_ENVIRONMENT_LENGTH)).min(1).max(64),
})

export type RepositoryConfig = z.infer<typeof configSchema>

/** The read errors that mean "no such file", as opposed to "unreadable". */
const isAbsent = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Reads the configuration at the root of one repository, or reports that there
 * is none.
 *
 * The distinction it refuses to blur: a file that is not there and a file that
 * cannot be read. The first is a repository that never declared one; the second
 * is a directory of that name, a permission, a device — and answering it with
 * "no configuration" would hand the user a run that behaves as if their
 * committed file did not exist.
 */
export async function readConfig(root: string): Promise<RepositoryConfig | undefined> {
  const file = path.join(root, CONFIG_FILE)

  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw new ConfigError(
      `cannot read ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let value: unknown
  try {
    value = parse(text)
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error
    throw new ConfigError(`${CONFIG_FILE} is not YAML: ${error.message}`)
  }

  const parsed = configSchema.safeParse(value)
  if (!parsed.success) {
    // `reasonOf` puts the offending field in front of the message, which is the
    // half Zod leaves in the issue path. The same repair both repository
    // readers make, and the same one the plan boundary makes for a proposal.
    throw new ConfigError(`${CONFIG_FILE} is not a configuration — ${reasonOf(parsed.error)}`)
  }
  return parsed.data
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

/**
 * What the entities show, plus what the repository declared.
 *
 * `summariseGraph` builds a vocabulary empirically — it is what the catalogue
 * currently holds — and on a repository with no entities yet that is empty.
 * Empty is what silences the environment policies: `checkPolicies` computes the
 * environments the request named by filtering this list, so an empty one makes
 * `asked` empty and `environment-mismatch` structurally unable to fire, and
 * `environmentsTouched` cannot recognise an environment inside a composed name.
 * §7.0's `environments` is the declaration that fills the gap before the first
 * entity exists.
 *
 * Merged, never substituted. What the entities show is evidence and what the
 * file declares is intent; an environment in use that the file forgot is still
 * in use, and dropping it would make the policies blind to exactly the
 * repository they know most about.
 *
 * What this does NOT do is make an environment *vouched for*. `signPlan`
 * deliberately does not enumerate `.env` — `prod` always exists, so enumerating
 * it would let a model pick production for a request that named no environment
 * at all — and that stays true here: a configured environment is still echoed
 * or still asked about. This widens what the deterministic gates can SEE, not
 * what a proposal may claim.
 */
export function seededVocabulary(
  vocabulary: Vocabulary,
  config: RepositoryConfig | undefined,
): Vocabulary {
  if (config === undefined) return vocabulary
  return {
    ...vocabulary,
    environments: sorted([...vocabulary.environments, ...config.environments]),
  }
}
