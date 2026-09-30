import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import http, { request as httpRequest } from 'node:http'
import https from 'node:https'
import net, { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { mayRecord, shellVariables } from '../setup/shell.js'

/**
 * What a transport does when asked to open a connection: the refusal's
 * message, or `opened` when a socket was on its way. Loopback on the discard
 * port, so a guard that is missing reaches no host but this one.
 */
const attempt = (open: () => { on(event: 'error', listener: () => void): unknown; destroy(): unknown }): string => {
  try {
    const connection = open()
    connection.on('error', () => {})
    connection.destroy()
    return 'opened'
  } catch (error) {
    return String(error)
  }
}

describe('the offline floor', () => {
  it('refuses a network call from inside the suite', async () => {
    // Not a convention: the suite must be unable to reach the network, so a
    // forgotten recording fails loudly instead of quietly calling a provider
    // on a contributor's key (design 9.3, CONTRIBUTING).
    await expect(async () => fetch('https://api.example.com/v1/messages')).rejects.toThrow(
      /reached the network/,
    )
  })

  it('names how to record, since that is the one legitimate reason to want it', async () => {
    await expect(async () => fetch('https://api.example.com')).rejects.toThrow(
      /IDP_RECORDING=record/,
    )
  })

  it('refuses every other way out: http, https, net, tls and WebSocket', () => {
    // `fetch` is the SDK's road, and only one road: a dependency that reaches
    // for node:http or a raw socket would have left the suite unnoticed.
    expect(attempt(() => http.request('http://127.0.0.1:9/'))).toMatch(/reached the network \(http:\/\/127\.0\.0\.1:9\//)
    expect(attempt(() => http.get({ host: '127.0.0.1', port: 9 }))).toMatch(/reached the network/)
    expect(attempt(() => https.request('https://127.0.0.1:9/'))).toMatch(/reached the network/)
    expect(attempt(() => https.get('https://127.0.0.1:9/'))).toMatch(/reached the network/)
    expect(attempt(() => net.connect(9, '127.0.0.1'))).toMatch(/reached the network \(127\.0\.0\.1:9\)/)
    expect(attempt(() => net.createConnection({ host: '127.0.0.1', port: 9 }))).toMatch(/reached the network/)
    expect(attempt(() => new net.Socket().connect(9, '127.0.0.1'))).toMatch(/reached the network/)
    expect(attempt(() => tls.connect(9, '127.0.0.1'))).toMatch(/reached the network/)
    expect(
      attempt(() => {
        const socket = new WebSocket('ws://127.0.0.1:9/')
        return { on: () => {}, destroy: () => socket.close() }
      }),
    ).toMatch(/reached the network \(ws:\/\/127\.0\.0\.1:9\/\)/)
  })

  it('refuses a transport imported by name at its own door, not only at the floor', () => {
    // A named import reads the module's ESM bindings, which stay the originals
    // unless the setup syncs them after patching (`syncBuiltinESMExports`).
    // Unsynced, the call still stops at `net.Socket`'s `connect`, which names
    // no URL and reads `connect(9, host)` as `localhost`: the target in the
    // message is how this tells the stub from the floor.
    expect(attempt(() => httpRequest('http://127.0.0.1:9/'))).toMatch(/reached the network \(http:\/\/127\.0\.0\.1:9\/\)/)
    expect(attempt(() => connect(9, '127.0.0.1'))).toMatch(/reached the network \(127\.0\.0\.1:9\)/)
  })
})

describe("the contributor's shell", () => {
  // The README asks for IDP_PROVIDER and IDP_MODEL to be exported, and a test
  // that calls `main` with `process.env` would read them — two tests failed on
  // exactly that — and a key in the shell is a key a replay could spend.
  const SHELL = {
    IDP_PROVIDER: 'openai',
    IDP_MODEL: 'gpt-x',
    IDP_SUPERVISOR_MODEL: 'gpt-y',
    IDP_TIMEOUT: '5',
    IDP_SCENARIO: 'mine',
    IDP_RECORDING: 'record',
    IDP_TRACE_DIR: '.traces',
    OPENAI_API_KEY: 'not-a-key',
    ANTHROPIC_API_KEY: 'not-a-key',
    MISTRAL_API_KEY: 'not-a-key',
    HOME: '/home/ada',
    PATH: '/usr/bin',
  }

  it('is set aside: every IDP_ variable but IDP_TRACE_DIR, and every key', () => {
    expect(shellVariables(SHELL, false).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'IDP_MODEL',
      'IDP_PROVIDER',
      'IDP_RECORDING',
      'IDP_SCENARIO',
      'IDP_SUPERVISOR_MODEL',
      'IDP_TIMEOUT',
      'MISTRAL_API_KEY',
      'OPENAI_API_KEY',
    ])
  })

  it('is kept whole for a scenario being recorded, the one run that needs a model', () => {
    expect(shellVariables(SHELL, true)).toEqual([])
  })

  it('keeps a catalogue from every run, a recording included: no tape may hold what it serves', () => {
    const catalogue = { ...SHELL, IDP_BACKSTAGE_URL: 'https://backstage.acme.example/api/catalog', IDP_BACKSTAGE_TOKEN: 'not-a-token' }
    expect(shellVariables(catalogue, true).sort()).toEqual(['IDP_BACKSTAGE_TOKEN', 'IDP_BACKSTAGE_URL'])
    expect(shellVariables(catalogue, false)).toEqual(expect.arrayContaining(['IDP_BACKSTAGE_TOKEN', 'IDP_BACKSTAGE_URL']))
  })

  it('records only in a scenario: a unit test never writes a tape', () => {
    const record = { IDP_RECORDING: 'record' }
    expect(mayRecord(record, '/repo/tests/scenarios/plan-mode.test.ts', '/repo')).toBe(true)
    expect(mayRecord(record, '/repo/tests/unit/init-command.test.ts', '/repo')).toBe(false)
    expect(mayRecord(record, undefined, '/repo')).toBe(false)
    expect(mayRecord({ IDP_RECORDING: 'replay' }, '/repo/tests/scenarios/plan-mode.test.ts', '/repo')).toBe(false)
    // A checkout under a folder named `scenarios` is not a scenario, nor is a
    // `scenarios` folder somewhere else in the tree.
    expect(mayRecord(record, '/w/scenarios/idp-agent/tests/unit/init-command.test.ts', '/w/scenarios/idp-agent')).toBe(false)
    expect(mayRecord(record, '/repo/docs/scenarios/x.test.ts', '/repo')).toBe(false)
    expect(mayRecord(record, '/elsewhere/tests/scenarios/x.test.ts', '/repo')).toBe(false)
    // And by default, the repository this suite is in.
    const scenarios = path.resolve(import.meta.dirname, '../scenarios')
    expect(mayRecord(record, path.join(scenarios, 'plan-mode.test.ts'))).toBe(true)
    expect(mayRecord(record, import.meta.filename)).toBe(false)
  })

  it('reaches no test in this run', () => {
    // vitest.config.ts sets one of each before the setup runs, so that this has
    // something to find gone on a shell that exported nothing — which is every
    // CI run, where removing the setup's `delete` used to leave the suite green.
    expect(process.env['IDP_SET_BY_VITEST_CONFIG']).toBeUndefined()
    expect(process.env['SET_BY_VITEST_CONFIG_API_KEY']).toBeUndefined()
    expect(Object.keys(process.env).filter((name) => shellVariables({ [name]: 'x' }, false).length > 0)).toEqual([])
  })
})

describe("the child processes' floor", () => {
  // `offline.ts` blocks the network in this process; a child opens its own
  // sockets. git and gh read their way to GitHub from the environment — and a
  // developer's exported GIT_SSH_COMMAND outranks every core.sshCommand — so
  // the suite owns every variable that could carry a child there (§ 10).
  // Spelled here rather than imported from `tests/setup/forge.ts`: the test
  // holds the setup to the list, not the list to itself.

  /** Every name `process.env` holds, compared whatever its case. */
  const held = (names: readonly string[]): string[] => {
    const wanted = new Set(names.map((name) => name.toUpperCase()))
    return Object.keys(process.env).filter((name) => wanted.has(name.toUpperCase()))
  }

  /** `dir` is the run directory or under it. */
  const underRun = (dir: string | undefined): boolean =>
    dir !== undefined && path.isAbsolute(dir) && !path.relative(tmpdir(), dir).startsWith('..')

  /** Where `program` is found along `PATH`, by `stat` alone: nothing is run to find it. */
  const resolve = async (program: string): Promise<string | undefined> => {
    for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
      if (dir === '') continue
      const file = path.join(dir, program)
      const found = await stat(file).catch(() => undefined)
      if (found?.isFile() === true && (found.mode & 0o111) !== 0) return file
    }
    return undefined
  }

  it('removes every variable that can carry a child process to GitHub', () => {
    // vitest.config.ts sets GIT_SSH_COMMAND and GH_TOKEN before the setup
    // runs — real names, since the floor removes them from a recording shell
    // too — so a shell that exported nothing still has something to find gone.
    expect(
      held([
        'GIT_SSH',
        'GIT_SSH_COMMAND',
        'GIT_SSH_VARIANT',
        'GIT_ASKPASS',
        'SSH_AUTH_SOCK',
        'SSH_ASKPASS',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'GH_ENTERPRISE_TOKEN',
        'GITHUB_ENTERPRISE_TOKEN',
        'GH_HOST',
        'GH_REPO',
        'NO_PROXY',
      ]),
    ).toEqual([])
  })

  it('points HOME, XDG_CONFIG_HOME and GH_CONFIG_DIR into the run directory', async () => {
    // So the developer's ~/.gitconfig, a global core.sshCommand naming an
    // absolute path past the PATH guard, and gh's stored login are never read.
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR']) {
      const dir = process.env[name]
      expect(underRun(dir), `${name} is ${String(dir)}`).toBe(true)
      const entries = await readdir(dir ?? '').catch(() => [])
      expect(entries, name).toEqual([])
    }
    // One HOME and one gh configuration per worker: a test in another worker
    // that writes under its own leaves this one's empty.
    for (const name of ['HOME', 'GH_CONFIG_DIR']) {
      expect(path.basename(process.env[name] ?? ''), name).toMatch(new RegExp(`-${String(process.pid)}$`))
    }
  })

  it('closes every proxy', () => {
    // curl reads the lower-case names and gh the upper: the discard port on
    // loopback, where nothing listens, so a proxied request fails at once.
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      expect(process.env[name], name).toBe('http://127.0.0.1:9')
    }
  })

  it("keeps the system configuration from the tests' own git", () => {
    // The launcher removes every GIT_*, this one included: it reaches the git
    // the tests start themselves, and the case below covers the launcher's.
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1')
  })

  it('puts a gh and an ssh that fail loudly first on PATH', async () => {
    const guard = (process.env['PATH'] ?? '').split(path.delimiter)[0] ?? ''
    expect(underRun(guard), `PATH starts with ${guard}`).toBe(true)
    // Both resolved first, and neither run until both are the guard's: a
    // machine's real gh or ssh is never started by this test.
    const found = { gh: await resolve('gh'), ssh: await resolve('ssh') }
    expect(found).toEqual({ gh: path.join(guard, 'gh'), ssh: path.join(guard, 'ssh') })
    for (const program of ['gh', 'ssh']) {
      const ran = await promisify(execFile)(path.join(guard, program), ['--version']).catch(
        (error: { code?: unknown; stderr?: unknown }) => error,
      )
      expect(ran, program).toMatchObject({ code: 97 })
      expect(String((ran as { stderr?: unknown }).stderr), program).toContain(`the test suite started ${program}`)
    }
  })

  it('refuses to run where the system configuration could carry a push elsewhere', async () => {
    // The launcher removes every GIT_*, GIT_CONFIG_NOSYSTEM included, so every
    // git it starts reads this machine's system file, and a key there outranks
    // the environment above: a core.sshCommand replaces the fixture's ssh, an
    // http proxy the closed one, and an insteadOf can turn the fixture's
    // git@github.com: URL into an https:// one a system credential helper
    // answers. Read as the launcher would read it — every GIT_* removed from
    // this one call — and named by key and file, never by value.
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.toUpperCase().startsWith('GIT_')) env[name] = value
    }
    const read = await promisify(execFile)(
      'git',
      [
        'config',
        '--system',
        '--includes',
        '--show-origin',
        '--get-regexp',
        '^(core\\.sshcommand|http\\..*proxy|url\\..*\\.(push)?insteadof)$',
      ],
      { env, encoding: 'utf8' },
    ).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error: { code?: unknown; stdout?: unknown }) => ({ code: error.code, stdout: String(error.stdout ?? '') }),
    )
    // `<origin>\t<key> <value>`: the origin and the key, the value dropped.
    const named = read.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [origin = '', rest = ''] = line.split('\t')
        return `${rest.split(' ')[0] ?? ''} (${origin})`
      })
    expect(named, 'the system git configuration sets a key that could carry a push test elsewhere').toEqual([])
    expect(read.code).toBe(1)
  })

  it("removes Node's proxy switch, and leaves the closed proxy to git and gh", async () => {
    // Node reads NODE_USE_ENV_PROXY, and the proxy variables with it, when a
    // process starts: a switch that reached a Node process the suite starts
    // would send its fetch to the closed port. Set here, not by the config: a
    // worker started with it would already have read the shell's proxy.
    expect(held(['NODE_USE_ENV_PROXY'])).toEqual([])
    // The same switch as a flag, which Node reads from NODE_OPTIONS: taken
    // out, and every other option left as it was.
    expect((process.env['NODE_OPTIONS'] ?? '').split(/\s+/)).not.toContain('--use-env-proxy')
    const saved = { PATH: process.env['PATH'], NODE_OPTIONS: process.env['NODE_OPTIONS'] }
    process.env['NODE_USE_ENV_PROXY'] = '1'
    process.env['NODE_OPTIONS'] = '--use-env-proxy --no-warnings  --use-env-proxy'
    let options: string | undefined
    try {
      vi.resetModules()
      await import('../setup/forge.js')
      options = process.env['NODE_OPTIONS']
    } finally {
      process.env['PATH'] = saved.PATH
      if (saved.NODE_OPTIONS === undefined) delete process.env['NODE_OPTIONS']
      else process.env['NODE_OPTIONS'] = saved.NODE_OPTIONS
    }
    expect(options).toBe('--no-warnings')
    expect(held(['NODE_USE_ENV_PROXY'])).toEqual([])
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      expect(process.env[name], name).toBe('http://127.0.0.1:9')
    }
  })
})
