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

/**
 * Three adapters, no default. The tool privileges no provider: whoever picks
 * this project up plugs in the model they want, and an unconfigured run says
 * so rather than reaching for one of ours.
 *
 * Adding a fourth is one entry here — the credentials come from that
 * provider's own environment variable, never from the repository (design 7.0).
 */
const ADAPTERS: Record<ProviderName, (model: string) => LanguageModel> = {
  anthropic: (model) => createAnthropic()(model),
  mistral: (model) => createMistral()(model),
  openai: (model) => createOpenAI()(model),
}

export const PROVIDER_NAMES = Object.keys(ADAPTERS) as readonly ProviderName[]

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
  return { provider, model }
}

/**
 * Replay never reaches this: a recording carries the provider and model it was
 * made against, so the suite runs without the key the recording was made with.
 */
export function modelFor(choice: ModelChoice): LanguageModel {
  return ADAPTERS[choice.provider](choice.model)
}
