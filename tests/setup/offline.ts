/**
 * The suite must be unable to reach the network — not by convention, not by
 * everyone remembering. A forgotten recording has to fail loudly rather than
 * quietly calling a provider on whoever's key happens to be in the shell.
 *
 * Recording is the one legitimate reason to want the network, and it is opt-in
 * through the documented variable (design 9.3), in a scenario only
 * (`shell.ts`).
 *
 * `fetch` is the SDK's road, and only one: `node:http` and `node:https`, a raw
 * socket from `node:net` or `node:tls` and a `WebSocket` each open a
 * connection without it. Every one of them throws here. `net.Socket`'s
 * `connect` is the floor under all of them — an http agent and undici end
 * there — so a road this list does not name still stops at it.
 */
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import { recording } from './shell.js'

/** Where a caller was going, in the words it used: a URL, or an options object's host and port. */
const target = (input: unknown, host?: unknown): string => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  // `connect(port, host)`: the port first, then the host.
  if (typeof input === 'number') return `${typeof host === 'string' ? host : 'localhost'}:${input}`
  if (typeof input === 'object' && input !== null) {
    const options = input as Record<string, unknown>
    const name = options['host'] ?? options['hostname'] ?? options['path'] ?? 'localhost'
    return options['port'] === undefined ? String(name) : `${String(name)}:${String(options['port'])}`
  }
  return String(input)
}

if (!recording) {
  const blocked = (input: unknown, host?: unknown): never => {
    throw new Error(
      `the test suite reached the network (${target(input, host)}). ` +
        'Replay a recording, or record one with IDP_RECORDING=record pnpm test.',
    )
  }

  globalThis.fetch = blocked as unknown as typeof globalThis.fetch
  for (const transport of [http, https]) {
    transport.request = blocked as unknown as typeof http.request
    transport.get = blocked as unknown as typeof http.get
  }
  net.connect = blocked as unknown as typeof net.connect
  net.createConnection = blocked as unknown as typeof net.createConnection
  net.Socket.prototype.connect = blocked as unknown as typeof net.Socket.prototype.connect
  tls.connect = blocked as unknown as typeof tls.connect
  globalThis.WebSocket = class {
    constructor(url: unknown) {
      blocked(url)
    }
  } as unknown as typeof WebSocket
  // `import { request } from 'node:http'` reads the module's ESM bindings,
  // which follow the objects above only once told to.
  syncBuiltinESMExports()
}
