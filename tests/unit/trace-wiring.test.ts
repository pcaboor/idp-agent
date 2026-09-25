import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, type MainDeps } from '../../src/cli/index.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'
import { memorySink, onlyTrace, skeletonOf } from '../support/trace.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })
const answering = (args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: 'c1', name: 'answer', args }],
  finishReason: 'tool-calls',
})

/** The Supervisor classifies, the Analyst answers "nothing": two agents, two model calls. */
const scripted = (): LlmClient => {
  const turns = [saying('QUESTION'), answering({ outcome: 'nothing' })]
  let index = 0
  return { generate: async () => turns[index++] ?? saying('') }
}

const ask = async (deps: MainDeps = {}): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(['ask', 'which databases are in prod?'], {
    root: FIXTURES,
    env: {},
    client: scripted(),
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    ...deps,
  })
  return { code, out: out.join(''), err: err.join('') }
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('tracing an agent-backed run', () => {
  it('traces nothing, and says nothing about a trace, when none is configured', async () => {
    const { err } = await ask()
    expect(err).not.toContain('· trace')
    expect(err).not.toContain('not exported')
  })

  it('leaves stdout and the exit code exactly as an untraced run leaves them', async () => {
    const untraced = await ask()
    const traced = await ask({ traceSinks: [memorySink()] })

    expect(traced.out).toBe(untraced.out)
    expect(traced.code).toBe(untraced.code)
  })

  it('hands each sink one trace, rooted at the command, with both agents inside it', async () => {
    const sink = memorySink()
    const { code } = await ask({ traceSinks: [sink] })
    const trace = onlyTrace(sink)

    expect(skeletonOf(trace)).toEqual({
      name: 'idp-agent ask',
      type: 'CHAIN',
      status: 'OK',
      children: [
        {
          name: 'supervisor',
          type: 'AGENT',
          status: 'OK',
          children: [{ name: 'supervisor call 0', type: 'CHAT_MODEL', status: 'OK', children: [] }],
        },
        {
          name: 'analyst',
          type: 'AGENT',
          status: 'OK',
          children: [{ name: 'analyst call 0', type: 'CHAT_MODEL', status: 'OK', children: [] }],
        },
      ],
    })
    expect(trace.spans[0]?.inputs).toEqual({ command: 'ask', intent: 'which databases are in prod?' })
    expect(trace.spans[0]?.outputs).toMatchObject({ exitCode: code })
    expect(trace.spans[0]?.attributes).toEqual({ 'idp.mode': 'scripted', 'idp.exit_code': code })
  })

  it('names the trace on stderr, so the run can be found in MLflow', async () => {
    const sink = memorySink()
    const { err } = await ask({ traceSinks: [sink] })
    const { traceId } = onlyTrace(sink)

    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(err).toContain(`· trace ${traceId}\n`)
  })

  it('posts the trace to MLflow when MLFLOW_TRACKING_URI is set', async () => {
    const sent: string[] = []
    const headers: unknown[] = []
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(url))
      headers.push(init?.headers)
      return new Response('', { status: 200 })
    }) as typeof globalThis.fetch

    const { err } = await ask({
      env: { MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055', MLFLOW_EXPERIMENT_ID: '12' },
      fetch,
    })

    expect(sent).toEqual(['http://127.0.0.1:5055/v1/traces'])
    expect(headers[0]).toMatchObject({ 'x-mlflow-experiment-id': '12' })
    expect(err).not.toContain('not exported')
  })

  it('says so on one line when MLflow cannot be reached, and exits as it would have', async () => {
    // No fetch injected: the global one is tests/setup/offline.ts's thrower,
    // which is what an unreachable server looks like from here.
    const untraced = await ask()
    const unreachable = await ask({ env: { MLFLOW_TRACKING_URI: 'http://127.0.0.1:5055' } })

    expect(unreachable.err).toContain('! trace not exported to mlflow: the test suite reached the network')
    expect(unreachable.code).toBe(untraced.code)
    expect(unreachable.out).toBe(untraced.out)
  })

  it('writes one file per run under IDP_TRACE_DIR', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idp-trace-'))
    dirs.push(dir)
    const sink = memorySink()

    await ask({ env: { IDP_TRACE_DIR: dir }, traceSinks: [sink] })

    expect(await readdir(dir)).toEqual([`${onlyTrace(sink).traceId}.json`])
  })

  it('still exports the trace of a run that threw, and marks it failed', async () => {
    const sink = memorySink()
    const failing: LlmClient = { generate: () => Promise.reject(new Error('502 from the gateway')) }

    const untraced = await ask({ client: failing })
    const traced = await ask({ client: failing, traceSinks: [sink] })
    const trace = onlyTrace(sink)

    expect(traced.code).toBe(untraced.code)
    expect(trace.spans[0]?.status).toEqual({ code: 'ERROR', message: '502 from the gateway' })
    expect(skeletonOf(trace).children[0]).toMatchObject({ name: 'supervisor', status: 'ERROR: the agent threw' })
  })
})
