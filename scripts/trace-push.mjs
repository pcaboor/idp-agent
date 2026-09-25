#!/usr/bin/env node
/**
 * Sends the traces a run wrote under IDP_TRACE_DIR to MLflow.
 *
 * The suite never reaches the network, so a replayed scenario cannot post its
 * own trace; it writes a file, and this sends the files. Each is posted as it
 * was written — the same OTLP/JSON body the MLflow sink would have sent.
 *
 *   IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios
 *   MLFLOW_TRACKING_URI=http://127.0.0.1:5055 pnpm trace:push .traces
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const trackingUri = process.env.MLFLOW_TRACKING_URI
if (!dir || !trackingUri) {
  console.error('usage: MLFLOW_TRACKING_URI=<url> pnpm trace:push <dir>')
  process.exit(2)
}
const experimentId = process.env.MLFLOW_EXPERIMENT_ID || '0'
const url = `${trackingUri.replace(/\/+$/, '')}/v1/traces`

let files
try {
  files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
} catch (error) {
  // A missing IDP_TRACE_DIR, or one this user cannot read, is the same
  // ordinary mistake as a bad --repo elsewhere in this project: one line
  // naming it, never a stack.
  console.error(`${dir}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
if (files.length === 0) {
  console.error(`${dir} holds no trace`)
  process.exit(1)
}

let failures = 0
for (const name of files) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mlflow-experiment-id': experimentId },
      body: readFileSync(path.join(dir, name), 'utf8'),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`)
    console.log(`sent ${name}`)
  } catch (error) {
    failures += 1
    console.error(`! ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`${files.length - failures} of ${files.length} trace(s) sent to experiment ${experimentId} at ${trackingUri}`)
process.exit(failures === 0 ? 0 : 1)
