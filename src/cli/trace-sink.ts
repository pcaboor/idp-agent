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

/**
 * The spans an OTLP server says it dropped, and why. A server answers `2xx`
 * and still rejects what it could not take, in the body's `partialSuccess`;
 * a trace kept only in part must not be reported as sent. `rejectedSpans` is
 * an int64, which OTLP/JSON may spell as a string. A body that is not JSON,
 * or rejects nothing, is a trace accepted.
 */
const rejectedOf = (body: string): { count: number; message: string } | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const partial = (
    parsed as { partialSuccess?: { rejectedSpans?: unknown; errorMessage?: unknown } } | null
  )?.partialSuccess
  const count = Number(partial?.rejectedSpans ?? 0)
  if (!Number.isFinite(count) || count <= 0) return undefined
  const message = partial?.errorMessage
  return { count, message: typeof message === 'string' && message !== '' ? message : 'no reason given' }
}

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
      const answered = await response.text()
      if (!response.ok) throw new Error(`${response.status} ${answered.slice(0, 200)}`)
      const rejected = rejectedOf(answered)
      if (rejected !== undefined) {
        throw new Error(`${rejected.count} span(s) rejected: ${rejected.message.slice(0, 200)}`)
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
      // else's trace, and it is not ours to replace. `0600`: it holds the
      // full prompts, the application repository's snapshots included, and
      // nobody else on the machine needs to read them.
      await writeFile(path.join(options.dir, `${trace.traceId}.json`), bodyOf(trace), {
        flag: 'wx',
        mode: 0o600,
      })
    },
  }
}

/**
 * The sinks the environment asks for: `IDP_MLFLOW_TRACKING_URI`, with
 * `IDP_MLFLOW_EXPERIMENT_ID` defaulting to `0`, MLflow's Default experiment;
 * and `IDP_TRACE_DIR`, resolved against the shell's working directory — where
 * the variable was typed — never against `--repo`.
 *
 * MLflow's own `MLFLOW_TRACKING_URI` and `MLFLOW_EXPERIMENT_ID` are never
 * read. They are routinely exported for other tools — a Databricks
 * workspace, a team's tracking server — and honouring them would send this
 * tool's full prompts there on every run, for someone who never asked it to
 * trace anything (docs/tracing-design.md §6).
 */
export function sinksFromEnv(
  env: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch,
): TraceSink[] {
  const sinks: TraceSink[] = []
  const trackingUri = env['IDP_MLFLOW_TRACKING_URI']
  if (trackingUri !== undefined && trackingUri !== '') {
    const experimentId = env['IDP_MLFLOW_EXPERIMENT_ID']
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
