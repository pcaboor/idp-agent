import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { VERSION } from '../core/index.js'
import type { Trace } from '../trace/model.js'
import { toOtlpJson } from '../trace/otlp.js'
import { plain } from './render/plain.js'

/**
 * Where a finished trace goes. `trace/` builds it and reaches nothing; this is
 * the only module a trace leaves the process through (ADR-0009).
 *
 * Both sinks are off unless the environment turns them on, and a sink that
 * fails is one line on stderr — never an exit code, never a thrown run.
 */

export interface TraceSink {
  /** What a failure line names: `mlflow`, `file`. */
  readonly name: string
  export(trace: Trace): Promise<void>
}

/** Bounded: a server that never answers must not hold a finished run open. */
export const EXPORT_TIMEOUT_MS = 3000

const bodyOf = (trace: Trace): string =>
  JSON.stringify(toOtlpJson(trace, { serviceVersion: VERSION }))

export function mlflowSink(options: {
  trackingUri: string
  experimentId: string
  fetch: typeof globalThis.fetch
  timeoutMs?: number
}): TraceSink {
  const url = `${options.trackingUri.replace(/\/+$/, '')}/v1/traces`
  return {
    name: 'mlflow',
    async export(trace) {
      const response = await options.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mlflow-experiment-id': options.experimentId,
        },
        body: bodyOf(trace),
        signal: AbortSignal.timeout(options.timeoutMs ?? EXPORT_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`)
      }
    },
  }
}

export function fileSink(options: { dir: string }): TraceSink {
  return {
    name: 'file',
    async export(trace) {
      await mkdir(options.dir, { recursive: true })
      // `wx`: a trace id is random, so a file already there is somebody
      // else's trace, and it is not ours to replace.
      await writeFile(path.join(options.dir, `${trace.traceId}.json`), bodyOf(trace), { flag: 'wx' })
    },
  }
}

/**
 * The sinks the environment asks for. `MLFLOW_EXPERIMENT_ID` defaults to `0`,
 * MLflow's Default experiment. `IDP_TRACE_DIR` is resolved against the
 * shell's working directory — where the variable was typed — never against
 * `--repo`.
 */
export function sinksFromEnv(
  env: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch,
): TraceSink[] {
  const sinks: TraceSink[] = []
  const trackingUri = env['MLFLOW_TRACKING_URI']
  if (trackingUri !== undefined && trackingUri !== '') {
    const experimentId = env['MLFLOW_EXPERIMENT_ID']
    sinks.push(
      mlflowSink({
        trackingUri,
        experimentId: experimentId === undefined || experimentId === '' ? '0' : experimentId,
        fetch,
      }),
    )
  }
  const dir = env['IDP_TRACE_DIR']
  if (dir !== undefined && dir !== '') sinks.push(fileSink({ dir: path.resolve(dir) }))
  return sinks
}

/**
 * What a failure says, and always a string, however malformed the thrown
 * value is: `thrown.message` might not be a string (or might not exist at
 * all), and `String(thrown)` throws for an object with no prototype
 * (`Object.create(null)`) — a sink's own failure must not take `exportTrace`
 * down with it.
 *
 * undici's "fetch failed" carries the real reason on `cause`, not on the
 * message itself — `ECONNREFUSED` is what names a forgotten `pnpm mlflow:up`
 * — so a `code` or `message` found there is appended, as `fetch failed
 * (ECONNREFUSED)`.
 */
const messageOf = (thrown: unknown): string => {
  let text: string
  try {
    const message = (thrown as { message?: unknown } | null)?.message
    text = typeof message === 'string' ? message : String(thrown)
  } catch {
    text = 'an error that could not be printed'
  }
  try {
    const cause = (thrown as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
    const label =
      typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : undefined
    if (label !== undefined) text += ` (${label})`
  } catch {
    // The cause is decoration on the message; losing it is fine, throwing here is not.
  }
  return text
}

/** Every sink, each on its own: one that fails says so, and does not stop the others. */
export async function exportTrace(
  trace: Trace,
  sinks: readonly TraceSink[],
  err: (chunk: string) => void,
): Promise<void> {
  await Promise.all(
    sinks.map(async (sink) => {
      try {
        await sink.export(trace)
      } catch (thrown) {
        const message = plain(messageOf(thrown)).replace(/\s+/g, ' ').trim().slice(0, 200)
        err(`! trace not exported to ${sink.name}: ${message}\n`)
      }
    }),
  )
}
