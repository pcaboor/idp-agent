import { describe, expect, it } from 'vitest'
import { ModelTimeoutError, summarise } from '../../src/llm/failures.js'

/**
 * The one function every provider's own words pass through before a terminal
 * sees them. Each property is asserted on its own, so removing any one of them
 * fails a test that names it — the contract tests see only their sum.
 */
describe('summarise', () => {
  it('cuts a long reason, and says it did', () => {
    const said = summarise('too long '.repeat(300))
    expect(said.length).toBeLessThanOrEqual(120)
    expect(said.endsWith('…')).toBe(true)
  })

  it('leaves a short reason whole', () => {
    expect(summarise('tool_choice is not supported')).toBe('tool_choice is not supported')
  })

  it('masks anything shaped like a key', () => {
    expect(summarise('Incorrect API key provided: sk-proj-abcdefghijklmnop')).toBe(
      'Incorrect API key provided: [redacted]',
    )
    expect(summarise(`key ${'A1b2'.repeat(10)} refused`)).toBe('key [redacted] refused')
  })

  it('removes escape sequences and controls, and flattens to one line', () => {
    expect(summarise('bad\n\u001b[2J\u001b[31mrequest\u0007')).toBe('bad request')
    expect(summarise('bad\u009brequest')).toBe('bad request')
  })
})

describe('who was called', () => {
  it('is named without the controls a model name could carry', () => {
    // IDP_MODEL comes from the environment and is in every failure line.
    const error = new ModelTimeoutError({ provider: 'openai', model: 'gpt\u001b[2J-6\nx' }, 5)
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(error.message.startsWith('openai gpt')).toBe(true)
  })
})
