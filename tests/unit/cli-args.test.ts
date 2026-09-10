import { describe, expect, it } from 'vitest'
import { parseArguments } from '../../src/cli/index.js'

describe('parseArguments', () => {
  it('reads the graph command with its filters', () => {
    expect(parseArguments(['graph', '--env', 'prod'])).toEqual({
      name: 'graph',
      options: { env: 'prod' },
    })
  })

  it('reads the show command with its argument', () => {
    expect(parseArguments(['show', 'billing-db-dev'])).toEqual({
      name: 'show',
      query: 'billing-db-dev',
    })
  })

  it('asks for help when given nothing', () => {
    expect(parseArguments([])).toEqual({ name: 'help' })
  })

  it('reports an unknown command instead of guessing one', () => {
    expect(parseArguments(['destroy']).name).toBe('error')
  })

  it('reports show without an argument', () => {
    expect(parseArguments(['show']).name).toBe('error')
  })

  it('reports an unknown flag rather than ignoring it', () => {
    expect(parseArguments(['graph', '--wat', 'x']).name).toBe('error')
  })

  it('reports an invalid kind', () => {
    expect(parseArguments(['graph', '--kind', 'Banana']).name).toBe('error')
  })
})
