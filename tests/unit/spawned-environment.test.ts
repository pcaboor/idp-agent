import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKSTAGE_TOKEN_VARIABLE } from '../../src/context/backstage/transport.js'
import { readProject } from '../../src/context/project-fs/snapshot.js'
import { spawnedEnvironment } from '../../src/context/spawned-environment.js'
import { KEY_VARIABLES, PROVIDER_NAMES } from '../../src/llm/providers.js'

/**
 * A child process is handed the environment it is started with, and `git`
 * runs in every inspected repository — an untrusted one, whose configuration
 * and hooks are its author's. So the Backstage token and every provider key
 * stay out of it (docs/backstage-http-brief.md § 4, point 4): one function
 * builds every spawned environment, and `git` gets its own from it.
 *
 * NO REAL KEY IS WRITTEN HERE: the canaries were never issued by anyone.
 */

/** Every `execFile` the code under test makes, its arguments as given; the real one still runs. */
const calls = vi.hoisted((): unknown[][] => [])

vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: vi.fn((...args: unknown[]) => {
      calls.push(args)
      return (real.execFile as (...given: unknown[]) => unknown)(...args)
    }),
  }
})

const CANARY = 'canary-backstage-token-for-git-0123'
const KEY = 'canary-provider-key-for-git-4567'

const keys = (value: string): Record<string, string> =>
  Object.fromEntries(PROVIDER_NAMES.map((provider) => [KEY_VARIABLES[provider], value]))

afterEach(() => {
  vi.unstubAllEnvs()
  calls.length = 0
})

describe('spawnedEnvironment', () => {
  it('drops the Backstage token and every provider key, and keeps the rest', () => {
    const env = spawnedEnvironment({ PATH: '/bin', HOME: '/h', IDP_BACKSTAGE_TOKEN: 't', ...keys('k') })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' })
    for (const provider of PROVIDER_NAMES) expect(env).not.toHaveProperty(KEY_VARIABLES[provider])
  })

  it('drops the token by the name the transport reads, and every provider key by its suffix', () => {
    // context/ does not import llm/, so the suffix is the rule and this test
    // is the link: every key variable ends in it.
    expect(BACKSTAGE_TOKEN_VARIABLE).toBe('IDP_BACKSTAGE_TOKEN')
    for (const provider of PROVIDER_NAMES) expect(KEY_VARIABLES[provider]).toMatch(/_API_KEY$/)
    expect(
      spawnedEnvironment({ GEMINI_API_KEY: 'k', [BACKSTAGE_TOKEN_VARIABLE]: 't', GITHUB_TOKEN: 'g', NPM_TOKEN: 'n' }),
    ).toEqual({ GITHUB_TOKEN: 'g', NPM_TOKEN: 'n' })
  })

  it('drops them whatever their case: Windows reads a variable by any case of its name', () => {
    expect(spawnedEnvironment({ Openai_Api_Key: 'k', idp_backstage_token: 't', Path: 'C:\\x' })).toEqual({
      Path: 'C:\\x',
    })
  })

  it('drops every IDP_BACKSTAGE_ variable: a swapped pair puts the token in the URL one', () => {
    // git has no use for either, and a token pasted into IDP_BACKSTAGE_URL is
    // a token all the same.
    expect(
      spawnedEnvironment({ IDP_BACKSTAGE_URL: 't', Idp_Backstage_Url: 't', IDP_BACKSTAGES: 'kept', PATH: '/bin' }),
    ).toEqual({ IDP_BACKSTAGES: 'kept', PATH: '/bin' })
  })

  it('reads the process environment when given none, and changes neither', () => {
    vi.stubEnv('IDP_BACKSTAGE_TOKEN', CANARY)
    vi.stubEnv('OPENAI_API_KEY', KEY)
    vi.stubEnv('IDP_SPAWNED_CANARY_KEPT', 'kept')
    const env = spawnedEnvironment()
    expect(env['IDP_SPAWNED_CANARY_KEPT']).toBe('kept')
    expect(JSON.stringify(env)).not.toContain(CANARY)
    expect(JSON.stringify(env)).not.toContain(KEY)
    expect(env).not.toBe(process.env)
    expect(process.env['IDP_BACKSTAGE_TOKEN']).toBe(CANARY)

    const given = { PATH: '/bin', OPENAI_API_KEY: 'k' }
    spawnedEnvironment(given)
    expect(given).toEqual({ PATH: '/bin', OPENAI_API_KEY: 'k' })
  })

  it('is what git runs in when the Inspector reads a directory', async () => {
    vi.stubEnv('IDP_BACKSTAGE_TOKEN', CANARY)
    vi.stubEnv('OPENAI_API_KEY', KEY)
    // A temporary directory outside git is enough: `tracking` (snapshot.ts)
    // runs `git rev-parse --show-toplevel` on every directory before it
    // decides to walk it.
    const root = await mkdtemp(path.join(tmpdir(), 'idp-spawned-'))
    await writeFile(path.join(root, 'package.json'), '{}\n')
    await readProject(root)
    expect(calls.length).toBeGreaterThan(0)
    for (const [command, , options] of calls) {
      expect(command).toBe('git')
      // An `env` left out would be process.env, whole.
      const env = (options as { env?: Record<string, string | undefined> }).env
      expect(env).toBeDefined()
      expect(Object.keys(env!)).not.toContain('OPENAI_API_KEY')
      expect(JSON.stringify(env)).not.toContain(KEY)
      expect(Object.keys(env!)).not.toContain('IDP_BACKSTAGE_TOKEN')
      expect(JSON.stringify(env)).not.toContain(CANARY)
    }
  })
})
