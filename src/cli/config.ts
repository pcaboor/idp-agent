import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, YAMLParseError } from 'yaml'
import {
  CONFIG_FILE,
  repositoryConfigSchema,
  type RepositoryConfig,
} from '../core/schemas/config.js'
import { reasonOf } from '../core/schemas/reject.js'
import type { Vocabulary } from '../core/schemas/vocabulary.js'

/**
 * Reading `.idp-agent.yml` (design §7.0) from a repository on disk. What the
 * file may hold — the schema, `CONFIG_FILE`, and the serialiser `init --submit`
 * writes it with — is `core/schemas/config.ts`'s, re-exported here so no
 * importer changes: a service's clearance carries the file's bytes, and
 * `core/` imports no `cli/`.
 */

export { CONFIG_FILE, type RepositoryConfig } from '../core/schemas/config.js'

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

/** The read errors that mean "no such file", as opposed to "unreadable". */
const isAbsent = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Reads the configuration at the root of one repository, or reports that there
 * is none — with the bytes it was read from. `init --submit` needs both: the
 * parsed value to compare with what the person typed, the bytes so the forge
 * can prove the base still holds them.
 *
 * The distinction it refuses to blur: a file that is not there and a file that
 * cannot be read. The first is a repository that never declared one; the second
 * is a directory of that name, a permission, a device — and answering it with
 * "no configuration" would hand the user a run that behaves as if their
 * committed file did not exist.
 */
export async function readConfigFile(
  root: string,
): Promise<{ readonly config: RepositoryConfig; readonly text: string } | undefined> {
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
  return { config: parseConfig(text), text }
}

/** The configuration alone: what every run but `init --submit` seeds its vocabulary from. */
export async function readConfig(root: string): Promise<RepositoryConfig | undefined> {
  return (await readConfigFile(root))?.config
}

/** The bytes of a file that is there, as YAML and then as §7.0's three fields. */
function parseConfig(text: string): RepositoryConfig {
  let value: unknown
  try {
    value = parse(text)
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error
    throw new ConfigError(`${CONFIG_FILE} is not YAML: ${error.message}`)
  }

  const parsed = repositoryConfigSchema.safeParse(value)
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
 * Empty is what silences the environment policies: `checkPolicies` counts an
 * environment answered for a proposed entity only when it is in this list, so
 * an empty one makes `asked` empty and `environment-mismatch` structurally
 * unable to fire, and `environmentsTouched` cannot recognise an environment
 * inside a composed name.
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
