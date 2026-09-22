/**
 * What an environment is called, and what values a catalogue actually holds.
 *
 * Both lived in `context/` until the engine needed them: the signature that
 * classifies a proposed value has to know which annotation carries an
 * environment, and which values are already in use. `core/` may not import
 * `context/` — an architecture rule says so now — so they live here, and
 * `context/` re-exports them.
 */

/** The annotation an entity carries its environment in. */
export const ENV_ANNOTATION = 'company.fr/env'

/**
 * The closed value space a catalogue is currently using. Empirical, not
 * declared: it is what the repository holds, which is why an empty repository
 * yields an empty vocabulary and every proposed value becomes a question.
 */
export interface Vocabulary {
  kinds: string[]
  types: string[]
  environments: string[]
  owners: string[]
}
