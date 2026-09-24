import { createAnthropic } from '@ai-sdk/anthropic'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

export type ProviderName = 'anthropic' | 'mistral' | 'openai'

export interface ModelChoice {
  provider: ProviderName
  model: string
}

export class NoModelConfiguredError extends Error {}

/** A model setting that is present and cannot be used, such as IDP_TIMEOUT=soon. */
export class ModelSettingError extends Error {}

/**
 * Three adapters, no default. The tool privileges no provider: whoever picks
 * this project up plugs in the model they want, and an unconfigured run says
 * so rather than reaching for one of ours.
 *
 * Adding a fourth is one entry here — the credentials come from that
 * provider's own environment variable, never from the repository (design 7.0).
 */
/** A model object, never a gateway id: `runtime.ts` wraps it to watch each attempt. */
export type ModelAdapter = Exclude<LanguageModel, string>

const ADAPTERS: Record<ProviderName, (model: string) => ModelAdapter> = {
  anthropic: (model) => createAnthropic()(model),
  mistral: (model) => createMistral()(model),
  openai: (model) => createOpenAI()(model),
}

export const PROVIDER_NAMES = Object.keys(ADAPTERS) as readonly ProviderName[]

/**
 * The variable each adapter reads its key from — the SDK's own defaults,
 * written down so a missing one is said before any agent runs rather than
 * discovered by the SDK at the first request, after the Supervisor or the
 * Inspector has already started.
 */
export const KEY_VARIABLES: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openai: 'OPENAI_API_KEY',
}

const isProvider = (value: string): value is ProviderName =>
  (PROVIDER_NAMES as readonly string[]).includes(value)

/** An empty string is unset: that is what an unset shell variable yields. */
const valueOf = (raw: string | undefined): string | undefined =>
  raw === undefined || raw === '' ? undefined : raw

export function chooseModel(env: Record<string, string | undefined>): ModelChoice {
  const provider = valueOf(env['IDP_PROVIDER'])
  const model = valueOf(env['IDP_MODEL'])

  if (provider === undefined) {
    throw new NoModelConfiguredError(
      `no model configured: set IDP_PROVIDER (one of ${PROVIDER_NAMES.join(', ')}) and IDP_MODEL`,
    )
  }
  if (!isProvider(provider)) {
    throw new NoModelConfiguredError(
      `no adapter for provider "${provider}"; available: ${PROVIDER_NAMES.join(', ')}`,
    )
  }
  if (model === undefined) {
    throw new NoModelConfiguredError(`no model configured: set IDP_MODEL for ${provider}`)
  }
  // Checked, never read: the adapter reads the key itself, and keeping it out of
  // the choice keeps it out of everything the choice is copied into.
  const key = KEY_VARIABLES[provider]
  if (valueOf(env[key]) === undefined) {
    throw new NoModelConfiguredError(`no key for ${provider}: set ${key}`)
  }
  return { provider, model }
}

/**
 * A value from the environment, quoted for a one-line refusal: JSON escapes the
 * C0 controls and the quote, and the C1 controls it leaves alone — `\u009b` is
 * a CSI to some terminals — are escaped the same way here.
 */
const quoted = (raw: string): string =>
  JSON.stringify(raw).replace(
    // eslint-disable-next-line no-control-regex -- escaping them is the point
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

/** How long a model call may take before it is aborted, when IDP_TIMEOUT is unset. */
export const DEFAULT_TIMEOUT_SECONDS = 120

/**
 * The longest wait a timer can hold: Node's setTimeout takes a 32-bit number of
 * milliseconds and fires at once on anything larger, which would turn a long
 * timeout into none.
 */
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000)

/**
 * IDP_TIMEOUT, in seconds, bounding one model call — retries included, since
 * the SDK retries a 429 or a 5xx inside the same call.
 *
 * Two minutes by default. Without one, a request nobody answers waits on
 * undici's five-minute headers timeout, and the SDK then retries it in silence:
 * observed with gpt-6-luna. A plain decimal only — `1e3` and `0x10` are
 * numbers to `Number()` and typos to a person.
 */
export function timeoutOf(env: Record<string, string | undefined>): number {
  const raw = valueOf(env['IDP_TIMEOUT'])
  if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS
  const seconds = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN
  if (!(seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS)) {
    throw new ModelSettingError(
      `IDP_TIMEOUT must be a positive number of seconds, at most ${MAX_TIMEOUT_SECONDS}; ` +
        `got ${quoted(raw)}`,
    )
  }
  return seconds
}

/**
 * Replay never reaches this: a recording carries the provider and model it was
 * made against, so the suite runs without the key the recording was made with.
 */
export function modelFor(choice: ModelChoice): ModelAdapter {
  return ADAPTERS[choice.provider](choice.model)
}
