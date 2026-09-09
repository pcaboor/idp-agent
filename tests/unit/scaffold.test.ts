import { describe, expect, it } from 'vitest'
import { VERSION } from '../../src/core/index.js'

describe('scaffold', () => {
  it('exposes the core version', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
