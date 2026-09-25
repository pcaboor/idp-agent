import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPORT_TIMEOUT_MS,
  exportTrace,
  fileSink,
  mlflowSink,
  sinksFromEnv,
  type TraceSink,
} from '../../src/cli/trace-sink.js'
import { createTraceBuilder } from '../../src/trace/builder.js'
import { fakeClock, fakeIds } from '../support/trace.js'

const TRACE = createTraceBuilder({
  clock: fakeClock(),
  ids: fakeIds(),
  name: 'idp-agent ask',
  inputs: { command: 'ask' },
}).finish({ outputs: { exitCode: 0 } })

interface Sent {
  url: string
  init: RequestInit
}

/** A server that answers every request with `status`, and remembers what it was sent. */
const answering = (status: number, body = ''): { fetch: typeof globalThis.fetch; sent: Sent[] } => {
  const sent: Sent[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status })
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

const dirs: string[] = []
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'idp-trace-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('mlflowSink', () => {
  it('posts the OTLP/JSON body to /v1/traces, naming the experiment', async () => {
    const server = answering(200)

    await mlflowSink({ trackingUri: 'http://127.0.0.1:5055/', experimentId: '7', fetch: server.fetch }).export(TRACE)

    expect(server.sent.map((one) => one.url)).toEqual(['http://127.0.0.1:5055/v1/traces'])
    const init = server.sent[0]?.init
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'content-type': 'application/json', 'x-mlflow-experiment-id': '7' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(init?.body))
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(TRACE.traceId)
  })

  it('refuses a server that did not accept the trace, saying what it answered', async () => {
    const server = answering(400, 'Invalid OpenTelemetry format')
    const sink = mlflowSink({ trackingUri: 'http://127.0.0.1:5055', experimentId: '0', fetch: server.fetch })

    await expect(sink.export(TRACE)).rejects.toThrow('400 Invalid OpenTelemetry format')
  })

  it('gives up on a server that does not answer', async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof globalThis.fetch
    const sink = mlflowSink({
      trackingUri: 'http://127.0.0.1:5055',
      experimentId: '0',
      fetch: hanging,
      timeoutMs: 20,
    })

    await expect(sink.export(TRACE)).rejects.toThrow(/timeout|abort/i)
    // What a real run waits at most, before one stderr line.
    expect(EXPORT_TIMEOUT_MS).toBe(3000)
  })
})

describe('fileSink', () => {
  it('writes one file per trace, named by its id, holding the body MLflow would be sent', async () => {
    const dir = path.join(await scratch(), 'nested')

    await fileSink({ dir }).export(TRACE)

    expect(await readdir(dir)).toEqual([`${TRACE.traceId}.json`])
    const body = JSON.parse(await readFile(path.join(dir, `${TRACE.traceId}.json`), 'utf8'))
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('idp-agent ask')
  })

  it('never overwrites a trace already written', async () => {
    const dir = await scratch()
    await fileSink({ dir }).export(TRACE)

    await expect(fileSink({ dir }).export(TRACE)).rejects.toThrow(/EEXIST/)
  })
})

describe('sinksFromEnv', () => {
  const { fetch } = answering(200)

  it('configures nothing when nothing is set', () => {
    expect(sinksFromEnv({}, fetch)).toEqual([])
  })

  it('ignores a variable set to the empty string', () => {
    expect(sinksFromEnv({ MLFLOW_TRACKING_URI: '', IDP_TRACE_DIR: '' }, fetch)).toEqual([])
  })

  it('configures each sink its variable asks for', () => {
    const names = (env: Record<string, string>): string[] =>
      sinksFromEnv(env, fetch).map((sink) => sink.name)
    expect(names({ MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055' })).toEqual(['mlflow'])
    expect(names({ IDP_TRACE_DIR: '.traces' })).toEqual(['file'])
    expect(names({ MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055', IDP_TRACE_DIR: '.traces' })).toEqual([
      'mlflow',
      'file',
    ])
  })

  it('sends to MLflow’s Default experiment unless told otherwise', async () => {
    const server = answering(200)
    const [sink] = sinksFromEnv({ MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055' }, server.fetch)

    await sink?.export(TRACE)

    expect(server.sent[0]?.init.headers).toEqual({
      'content-type': 'application/json',
      'x-mlflow-experiment-id': '0',
    })
  })
})

describe('exportTrace', () => {
  it('lets every sink try, and names the one that failed on one line', async () => {
    const written: string[] = []
    const failing: TraceSink = {
      name: 'mlflow',
      export: async () => {
        throw new Error('502 from\nthe proxy')
      },
    }
    const working: TraceSink = { name: 'memory', export: async (trace) => void written.push(trace.traceId) }
    const err: string[] = []

    await exportTrace(TRACE, [failing, working], (chunk) => void err.push(chunk))

    expect(written).toEqual([TRACE.traceId])
    expect(err).toEqual(['! trace not exported to mlflow: 502 from the proxy\n'])
  })

  it('never rejects, even when a sink throws a value with no message and no prototype', async () => {
    const failing: TraceSink = {
      name: 'mlflow',
      export: async () => {
        // No `.message`, and `String()` throws on this — the shape a
        // guarded helper exists for, not a contrived edge case.
        throw Object.create(null)
      },
    }
    const err: string[] = []

    await expect(exportTrace(TRACE, [failing], (chunk) => void err.push(chunk))).resolves.toBeUndefined()
    expect(err).toHaveLength(1)
    expect(err[0]).toMatch(/^! trace not exported to mlflow: .+\n$/)
  })

  it('names the cause undici hangs the real reason on, so a forgotten `pnpm mlflow:up` is named', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5055'), { code: 'ECONNREFUSED' })
    const failing: TraceSink = {
      name: 'mlflow',
      export: async () => {
        throw new TypeError('fetch failed', { cause })
      },
    }
    const err: string[] = []

    await exportTrace(TRACE, [failing], (chunk) => void err.push(chunk))

    expect(err[0]).toContain('ECONNREFUSED')
  })

  it('strips a control sequence a thrown message carries, the same as any other model text', async () => {
    const failing: TraceSink = {
      name: 'mlflow',
      export: async () => {
        throw new Error('failed\u001b[2Jmore')
      },
    }
    const err: string[] = []

    await exportTrace(TRACE, [failing], (chunk) => void err.push(chunk))

    expect(err[0]).not.toContain('\u001b')
  })
})
