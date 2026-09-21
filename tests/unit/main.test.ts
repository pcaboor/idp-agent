import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const BROKEN = path.resolve(import.meta.dirname, '../golden/broken-si')

/** Collects what the command would have written, so main() is testable. */
const capture = (): { out: string[]; err: string[] } => ({ out: [], err: [] })

describe('main', () => {
  it('prints the help and succeeds', async () => {
    const io = capture()
    const code = await main(['help'], { out: (s) => io.out.push(s), err: (s) => io.err.push(s) })
    expect(code).toBe(0)
    expect(io.out.join('')).toContain('idp-agent graph')
    expect(io.err).toEqual([])
  })

  it('writes the table to stdout and succeeds', async () => {
    const io = capture()
    const code = await main(['graph', '--env', 'prod'], {
      root: FIXTURES,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(0)
    expect(io.out.join('')).toContain('billing-db-prod')
  })

  it('refuses an unknown command with 2, the argument-error code', async () => {
    const io = capture()
    const code = await main(['wat'], { out: (s) => io.out.push(s), err: (s) => io.err.push(s) })
    expect(code).toBe(2)
    expect(io.err.join('')).toContain('unknown command')
    expect(io.out).toEqual([])
  })

  it('reports a rejected entity on stderr rather than dropping it in silence', async () => {
    // The fixture SI has no rejection, so this path is only ever reached with a
    // deliberately broken SI — and it is the one stage-1 criterion that had no test.
    const io = capture()
    const code = await main(['graph'], {
      root: BROKEN,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(0)
    expect(io.err.join('')).toContain('invalid.yml')
    expect(io.out.join('')).toContain('good-db-dev')
  })

  it('returns 1 when a query matches nothing, so a script can tell', async () => {
    const io = capture()
    const code = await main(['show', 'no-such-entity'], {
      root: FIXTURES,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(1)
    expect(io.out.join('')).toContain('No entity named')
  })

  it('returns 1 when a filter matches nothing, rather than reporting success', async () => {
    const io = capture()
    const code = await main(['graph', '--env', 'nowhere'], {
      root: FIXTURES,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(1)
  })

  it('returns 1 when a name is ambiguous, since it resolved no entity', async () => {
    const io = capture()
    const code = await main(['show', 'redis-shared'], {
      root: FIXTURES,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(1)
    expect(io.out.join('')).toContain('matches 2 entities')
  })

  it('succeeds when it found what was asked for', async () => {
    const io = capture()
    const code = await main(['show', 'billing-db-prod'], {
      root: FIXTURES,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(0)
  })
})
