import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/cli/index.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const BROKEN = path.resolve(import.meta.dirname, '../golden/broken-si')

/** Collects what the command would have written, so main() is testable. */
const capture = (): { out: string[]; err: string[] } => ({ out: [], err: [] })

/**
 * A configured model, key included. The key is fake and set in both places the
 * run reads: `chooseModel` checks the injected environment, the adapter reads
 * the process's. The request then reaches `tests/setup/offline.ts`'s thrower.
 */
const CONFIGURED = {
  IDP_PROVIDER: 'mistral',
  IDP_MODEL: 'some-model',
  MISTRAL_API_KEY: 'test-key-not-a-real-one',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

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

  it('returns 2 and refuses to pick a model on the user behalf', async () => {
    // The state a reviewing agent who just cloned the repository is in.
    const io = capture()
    const code = await main(['ask', 'which databases are in prod?'], {
      root: FIXTURES,
      env: {},
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(2)
    expect(io.err.join('')).toContain('no model configured')
    expect(io.out).toEqual([])
  })

  it('refuses an ask with no question, rather than asking an empty one', async () => {
    const io = capture()
    const code = await main(['ask'], { out: (s) => io.out.push(s), err: (s) => io.err.push(s) })
    expect(code).toBe(2)
    expect(io.err.join('')).toContain('needs a question')
  })

  it('still refuses an unknown command, now that a new one exists', async () => {
    const io = capture()
    expect(
      await main(['asking'], { out: (s) => io.out.push(s), err: (s) => io.err.push(s) }),
    ).toBe(2)
  })

  it('offers ask in the help', async () => {
    const io = capture()
    await main(['help'], { out: (s) => io.out.push(s), err: (s) => io.err.push(s) })
    expect(io.out.join('')).toContain('idp-agent ask')
  })

  it('calls the model rather than hunting for a recording, when one is configured', async () => {
    // A real run has no scenario to replay. Before this, `idp-agent ask` with a
    // provider configured died looking for a recording called "live".
    vi.stubEnv('MISTRAL_API_KEY', CONFIGURED.MISTRAL_API_KEY)
    const io = capture()
    const code = await main(['ask', 'which databases are in prod?'], {
      root: FIXTURES,
      env: CONFIGURED,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(io.err.join('')).not.toContain('no recording')
    // It gets as far as the network, which the suite blocks — the point being
    // that it went looking for a model and not for a file.
    expect(io.err.join('')).toMatch(/network/i)
    expect(code).not.toBe(0)
  })

  it('reports an unexpected failure instead of exiting 0 with a stack trace', async () => {
    vi.stubEnv('MISTRAL_API_KEY', CONFIGURED.MISTRAL_API_KEY)
    const io = capture()
    const code = await main(['ask', 'anything'], {
      root: FIXTURES,
      env: CONFIGURED,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    })
    expect(code).toBe(1)
    expect(io.out).toEqual([])
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
