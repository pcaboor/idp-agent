import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEOUT_SECONDS,
  KEY_VARIABLES,
  ModelSettingError,
  NoModelConfiguredError,
  PROVIDER_NAMES,
  chooseModel,
  timeoutOf,
} from '../../src/llm/providers.js'

describe('chooseModel', () => {
  it('refuses to pick a provider on the user behalf', () => {
    // The project ships three adapters and privileges none: whoever picks it up
    // plugs in the model they want, rather than inheriting ours.
    expect(() => chooseModel({})).toThrow(NoModelConfiguredError)
    expect(() => chooseModel({})).toThrow(/IDP_PROVIDER/)
  })

  it('takes the provider and the model from the environment', () => {
    expect(
      chooseModel({
        IDP_PROVIDER: 'mistral',
        IDP_MODEL: 'mistral-large-latest',
        MISTRAL_API_KEY: 'test-key-not-a-real-one',
      }),
    ).toEqual({
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

  it('refuses a provider whose key is missing, naming the variable, before any call', () => {
    // The SDK only finds out at the first request, after the Supervisor or the
    // Inspector has started; this says it before anything runs.
    for (const provider of PROVIDER_NAMES) {
      const variable = KEY_VARIABLES[provider]
      const env = { IDP_PROVIDER: provider, IDP_MODEL: 'some-model' }
      expect(() => chooseModel(env)).toThrow(NoModelConfiguredError)
      expect(() => chooseModel(env)).toThrow(new RegExp(`set ${variable}\\b`))
      expect(() => chooseModel({ ...env, [variable]: '' })).toThrow(new RegExp(variable))
    }
  })

  it("reads each provider's own variable, and no other provider's", () => {
    expect(KEY_VARIABLES).toEqual({
      anthropic: 'ANTHROPIC_API_KEY',
      mistral: 'MISTRAL_API_KEY',
      openai: 'OPENAI_API_KEY',
    })
    expect(() =>
      chooseModel({ IDP_PROVIDER: 'openai', IDP_MODEL: 'x', ANTHROPIC_API_KEY: 'k' }),
    ).toThrow(/OPENAI_API_KEY/)
  })

  it('never puts the key in the choice it returns', () => {
    const env = { IDP_PROVIDER: 'openai', IDP_MODEL: 'x', OPENAI_API_KEY: 'sk-secret' }
    expect(JSON.stringify(chooseModel(env))).not.toContain('sk-secret')
  })
})

describe('timeoutOf', () => {
  it(`waits ${DEFAULT_TIMEOUT_SECONDS} seconds when IDP_TIMEOUT is unset or empty`, () => {
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(120)
    expect(timeoutOf({})).toBe(120)
    expect(timeoutOf({ IDP_TIMEOUT: '' })).toBe(120)
  })

  it('takes a positive number of seconds, fractions included', () => {
    expect(timeoutOf({ IDP_TIMEOUT: '300' })).toBe(300)
    expect(timeoutOf({ IDP_TIMEOUT: '0.5' })).toBe(0.5)
  })

  it.each(['0', '-5', 'abc', '2m', ' ', '1e3', 'Infinity', '9999999'])(
    'refuses IDP_TIMEOUT=%j as a bad setting, naming the variable',
    (raw) => {
      expect(() => timeoutOf({ IDP_TIMEOUT: raw })).toThrow(ModelSettingError)
      expect(() => timeoutOf({ IDP_TIMEOUT: raw })).toThrow(/IDP_TIMEOUT/)
    },
  )

  it('quotes a refused value so it cannot write to the terminal', () => {
    // The refusal is one line on stderr; a value carrying an escape or a line
    // break would clear the screen or make it two.
    let message = ''
    try {
      timeoutOf({ IDP_TIMEOUT: '5\u001b[2J\nx\u009b1m' })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toContain('IDP_TIMEOUT')
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(message).toContain('\\u001b[2J\\nx\\u009b1m')
  })
})
