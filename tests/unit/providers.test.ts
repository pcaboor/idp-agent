import { describe, expect, it } from 'vitest'
import { NoModelConfiguredError, PROVIDER_NAMES, chooseModel } from '../../src/llm/providers.js'

describe('chooseModel', () => {
  it('refuses to pick a provider on the user behalf', () => {
    // The project ships three adapters and privileges none: whoever picks it up
    // plugs in the model they want, rather than inheriting ours.
    expect(() => chooseModel({})).toThrow(NoModelConfiguredError)
    expect(() => chooseModel({})).toThrow(/IDP_PROVIDER/)
  })

  it('takes the provider and the model from the environment', () => {
    expect(chooseModel({ IDP_PROVIDER: 'mistral', IDP_MODEL: 'mistral-large-latest' })).toEqual({
      provider: 'mistral',
      model: 'mistral-large-latest',
    })
  })

  it('needs both halves, and says which one is missing', () => {
    expect(() => chooseModel({ IDP_PROVIDER: 'openai' })).toThrow(/IDP_MODEL/)
    expect(() => chooseModel({ IDP_MODEL: 'some-model' })).toThrow(/IDP_PROVIDER/)
  })

  it('refuses a provider it has no adapter for, rather than falling back to one', () => {
    expect(() => chooseModel({ IDP_PROVIDER: 'acme', IDP_MODEL: 'x' })).toThrow(/acme/)
    expect(() => chooseModel({ IDP_PROVIDER: 'acme', IDP_MODEL: 'x' })).toThrow(
      new RegExp(PROVIDER_NAMES.join('|')),
    )
  })

  it('treats an empty string as unset, since that is what an unset shell variable gives', () => {
    expect(() => chooseModel({ IDP_PROVIDER: '', IDP_MODEL: 'x' })).toThrow(/IDP_PROVIDER/)
    expect(() => chooseModel({ IDP_PROVIDER: 'openai', IDP_MODEL: '' })).toThrow(/IDP_MODEL/)
  })

  it('names every adapter it ships, so the error tells you what is available', () => {
    expect([...PROVIDER_NAMES].sort()).toEqual(['anthropic', 'mistral', 'openai'])
  })
})
