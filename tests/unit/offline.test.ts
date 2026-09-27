import http, { request as httpRequest } from 'node:http'
import https from 'node:https'
import net, { connect } from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { describe, expect, it } from 'vitest'
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
