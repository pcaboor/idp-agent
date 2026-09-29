/**
 * The only variable the Backstage token is read from. cli/ reads it; no child
 * process is handed it. It lives in this leaf, beside the one function that
 * keeps it out of every child, and `context/backstage/transport.ts` re-exports
 * it for everything that read it there.
 */
export const BACKSTAGE_TOKEN_VARIABLE = 'IDP_BACKSTAGE_TOKEN'

/**
 * A key variable's suffix: every provider's (`llm/providers.ts`'s
 * `KEY_VARIABLES`) ends in it. process/ imports nothing of ours, so the suffix
 * is the rule, and `tests/unit/spawned-environment.test.ts` is the link that
 * fails when a provider's key is named otherwise.
 */
const KEY_SUFFIX = '_API_KEY'

/**
 * Every variable of the Backstage source: the token, and the URL, where a
 * swapped pair puts the token. `git` has no use for either.
 */
const BACKSTAGE_PREFIX = 'IDP_BACKSTAGE_'

/**
 * A child process's environment: the process's, without the Backstage token
 * or any other `IDP_BACKSTAGE_*` variable, and without any `*_API_KEY`. Every
 * process src/ starts is given one — `git`, through `git.ts`, in every
 * inspected repository, whose configuration and hooks are whatever its author
 * left there — and the architecture rules hold each call to it: Node hands a
 * child the whole of `process.env` when `env` is left out.
 *
 * Names are compared whatever their case: Windows reads a variable by any case
 * of its name, so `openai_api_key` is the same key there. A `GITHUB_TOKEN` or
 * an `NPM_TOKEN` is kept: `git` may need one, and neither is this tool's.
 */
export function spawnedEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase()
    if (upper === BACKSTAGE_TOKEN_VARIABLE || upper.startsWith(BACKSTAGE_PREFIX) || upper.endsWith(KEY_SUFFIX)) continue
    kept[name] = value
  }
  return kept
}
