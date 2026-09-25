#!/usr/bin/env node
/**
 * Checks that the MLflow this project pins still reads our OTLP/JSON the way
 * the suite assumes.
 *
 * The suite compares `toOtlpJson` against tests/contract/otlp/accepted.json and
 * never leaves the machine. This is the one place that file meets a real
 * server: it is sent under a fresh trace id, read back through MLflow's own
 * Python client inside the container — what the UI shows is what that client
 * parsed — and every span's type, status, inputs, outputs and events are
 * compared with what was sent, and the trace's token total with the sum of its
 * model spans'.
 *
 * Run it whenever the image tag in tools/mlflow/compose.yml moves. Needs Docker
 * and `pnpm mlflow:up`; never part of CI, which has neither.
 *
 * It posts to http://127.0.0.1:5055, the port that compose file publishes, and
 * to nowhere else: no environment variable moves it. The read-back always
 * goes through that container, so a trace posted to any other server could
 * never be read back — and a tracking URI exported for some other tool would
 * have sent the contract's trace to that tool's server.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const COMPOSE = path.join(ROOT, 'tools/mlflow/compose.yml')
const TRACKING_URI = 'http://127.0.0.1:5055'

const body = JSON.parse(readFileSync(path.join(ROOT, 'tests/contract/otlp/accepted.json'), 'utf8'))
const sent = body.resourceSpans[0].scopeSpans[0].spans
// A fresh id every run: the same id twice would be one trace, and a re-run
// would be reading back the first run's spans.
const traceId = randomBytes(16).toString('hex')
for (const span of sent) span.traceId = traceId

const response = await fetch(`${TRACKING_URI}/v1/traces`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mlflow-experiment-id': '0' },
  body: JSON.stringify(body),
})
if (!response.ok) {
  console.error(`the server refused the body: ${response.status} ${await response.text()}`)
  process.exit(1)
}

const READ = `
import json, mlflow
mlflow.set_tracking_uri("http://127.0.0.1:5000")
t = mlflow.get_trace("tr-${traceId}")
print(json.dumps({
    "state": t.info.state.value,
    "tokens": t.info.token_usage,
    "spans": [
        {
            "name": s.name,
            "type": s.span_type,
            "status": s.status.status_code.value,
            "message": s.status.description,
            "inputs": s.inputs,
            "outputs": s.outputs,
            "events": [{"name": e.name, "attributes": e.attributes} for e in s.events],
        }
        for s in t.data.spans
    ],
}))
`
const printed = execFileSync('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'mlflow', 'python', '-c', READ], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
})
const read = JSON.parse(printed.trim().split('\n').at(-1))

const attribute = (span, key) => span.attributes.find((one) => one.key === key)?.value
const json = (span, key) => {
  const value = attribute(span, key)?.stringValue
  return value === undefined ? undefined : JSON.parse(value)
}
const plain = (attributes) =>
  Object.fromEntries(
    attributes.map(({ key, value }) => [
      key,
      value.stringValue ?? value.boolValue ?? (value.intValue !== undefined ? Number(value.intValue) : value.doubleValue),
    ]),
  )

const failures = []
const expect = (what, got, wanted) => {
  if (!isDeepStrictEqual(got, wanted)) {
    failures.push(`${what}: read back ${JSON.stringify(got)}, sent ${JSON.stringify(wanted)}`)
  }
}

expect('the number of spans', read.spans.length, sent.length)
for (const span of sent) {
  const got = read.spans.find((one) => one.name === span.name)
  if (got === undefined) {
    failures.push(`${span.name}: not read back`)
    continue
  }
  const error = span.status.code === 2
  expect(`${span.name} type`, got.type, json(span, 'mlflow.spanType'))
  expect(`${span.name} status`, got.status, error ? 'ERROR' : 'OK')
  if (error) expect(`${span.name} message`, got.message, span.status.message)
  expect(`${span.name} inputs`, got.inputs ?? undefined, json(span, 'mlflow.spanInputs'))
  expect(`${span.name} outputs`, got.outputs ?? undefined, json(span, 'mlflow.spanOutputs'))
  expect(
    `${span.name} events`,
    got.events,
    span.events.map((event) => ({ name: event.name, attributes: plain(event.attributes) })),
  )
}
// MLflow sums the model spans' usage onto the trace; nothing writes it on the root.
const total = {}
for (const span of sent) {
  for (const [key, value] of Object.entries(json(span, 'mlflow.chat.tokenUsage') ?? {})) {
    total[key] = (total[key] ?? 0) + value
  }
}
expect('the trace token usage', read.tokens, total)
expect('the trace state', read.state, sent[0].status.code === 2 ? 'ERROR' : 'OK')

if (failures.length > 0) {
  console.error(`MLflow at ${TRACKING_URI} reads the contract differently:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`MLflow at ${TRACKING_URI} reads all ${sent.length} spans of the contract as sent (tr-${traceId})`)
