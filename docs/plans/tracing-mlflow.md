# Tracing agent runs into MLflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One MLflow trace per agent-backed run — `plan "<intent>"`, `ask`, `init` — live or replayed, built from the event stream and the model calls, with the suite still offline.

**Architecture:** A pure `src/trace/` folds `AgentEvent`s and `LlmClient` calls into a span tree and encodes it as OTLP/JSON. `src/cli/` owns the only two ways a trace leaves the process: a `POST` to MLflow's `/v1/traces`, and a file per run. The spec is `docs/tracing-design.md`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Node ≥ 22, vitest 5, fast-check 4, MLflow 3.16.1 in Docker. No new npm dependency.

**Since written.** The steps below are the record of what was decided on 2026-09-24. The review of the whole stack, and the rebase onto a `main` that had moved, changed some of it, and the spec says what holds now: `IDP_MLFLOW_TRACKING_URI` and `IDP_MLFLOW_EXPERIMENT_ID` replace `MLFLOW_*`, which is ignored (spec §6); an attempt that stops or throws fails with its reason, and the root fails only when the run threw (spec §4.1); the Architect answers the call it refuses, so every tool call is answered; `idpa "<phrase>"` is traced as `idp-agent entry`. Each step a later commit changed is ticked with a note saying how.

## Global Constraints

- **No new dependency.** OTLP is hand-encoded JSON, and the transport is the global `fetch`.
- **`pnpm test` stays offline.** `tests/setup/offline.ts` is not touched. No test sets `IDP_RECORDING`, and none reaches Docker.
- **Tracing never changes an exit code, stdout or the diff.**
- **`agents/` imports nothing from `src/trace/`.** `src/trace/` imports from `agents/` and `llm/` with `import type` only, and never names `fetch`.
- **Nothing is guessed.** A token count the provider did not report is absent, never `0`. A span nothing closed is `ERROR`, never `OK`.
- **MLflow is pinned.** Image `ghcr.io/mlflow/mlflow:v3.16.1`. Port `127.0.0.1:5055`, because macOS's AirPlay receiver holds 5000. Experiment `0` unless `MLFLOW_EXPERIMENT_ID` says otherwise.
- **Attribute encoding.** MLflow's own keys (`mlflow.spanType`, `mlflow.spanInputs`, `mlflow.spanOutputs`, `mlflow.chat.tokenUsage`) carry JSON-encoded strings. The project's own keys (`idp.*`) carry typed OTLP values.
- **Conventions.** English throughout, Conventional Commits, and no `switch` on a closed union without `const exhaustive: never = …; return exhaustive` in `default`.
- **Ask the owner before every `git commit`, `git push`, PR and merge.** Each "Commit" step below means three things:
  - stage the listed files **by name** — never `git add -A`, because `node_modules` is a symlink that `.gitignore`'s `node_modules/` does not match;
  - show the staged summary and the message;
  - wait for a go-ahead.

  End every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Where to work.** In `~/Documents/idp-agent-worktrees/mlflow-tracing`, never in `~/Documents/idp-agent`, which is the owner's checkout with stage-5 work in progress.
- **One PR per task, stacked:** `docs/tracing-design` (spec and this plan) ← `feat/tracing-1-contract` ← `feat/tracing-2-events` ← `feat/tracing-3-usage` ← `feat/tracing-4-trace` ← `feat/tracing-5-wiring`. They are merged bottom-up with `--rebase`, and each PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Counts are measurements.** Every count in AGENTS.md (tests, architecture rules) is re-measured and corrected in the commit that changes it. The test count comes from `pnpm test`'s summary line; the rule count from `pnpm vitest run tests/architecture --reporter=verbose`.
- **The suite leaks temporary directories.** Check `df -h /` before a full run. Every test added here removes what it creates.

## File map

| File | Task | Responsibility |
|---|---|---|
| `tools/mlflow/compose.yml` | 1 | MLflow 3.16.1 on `127.0.0.1:5055`, sqlite in a named volume |
| `tests/contract/otlp/accepted.json` | 1 | the OTLP/JSON body a real MLflow read back as sent |
| `scripts/mlflow-contract.mjs` | 1 | sends that body to a live server and compares what MLflow's client reads back |
| `src/agents/events.ts` | 2 | `agent:end`, `attempt:start`, `attempt:end`, `gate:passed`; `id` on tool events |
| `src/agents/lifetime.ts` | 2 | `asAgent` — `agent:start`/`agent:end` around an agent, on every path out |
| `src/agents/{supervisor,analyst,inspector,architect,reviewer}.ts` | 2 | wrapped in `asAgent`; tool events carry the call id |
| `src/agents/repair.ts` | 2 | emits each attempt's bounds and every gate that passed |
| `src/llm/client.ts`, `src/llm/runtime.ts` | 3 | `TokenUsage`, `GenerateResult.usage`, `usageOf` |
| `src/trace/model.ts` | 4 | `Span`, `Trace` — plain data |
| `src/trace/builder.ts` | 4 | `createTraceBuilder` — events and model calls → span tree |
| `src/trace/client.ts` | 4 | `traced` — the `LlmClient` decorator |
| `src/trace/otlp.ts` | 4 | `toOtlpJson` — the body MLflow accepts |
| `tests/support/trace.ts` | 4, 5 | fake clock and ids, `skeletonOf`, `spanNamed`; then `memorySink`, `onlyTrace`, `disagreements` |
| `src/cli/trace-sink.ts` | 5 | `mlflowSink`, `fileSink`, `sinksFromEnv`, `exportTrace` |
| `src/cli/index.ts` | 2, 5 | `renderEvent` cases (2); session attributes, `agentBacked` tracing, `MainDeps` (5) |
| `scripts/trace-push.mjs` | 5 | sends the files `IDP_TRACE_DIR` holds to MLflow |

---

### Task 1: Local MLflow and the OTLP contract

**Branch:** `git -C ~/Documents/idp-agent-worktrees/mlflow-tracing checkout -b feat/tracing-1-contract docs/tracing-design`

**Files:**
- Create: `tools/mlflow/compose.yml`
- Create: `tests/contract/otlp/accepted.json`
- Create: `scripts/mlflow-contract.mjs`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `tests/contract/otlp/accepted.json`, the exact body Task 4's `toOtlpJson(CONTRACT_TRACE, { serviceVersion: '0.0.0-contract' })` must equal;
  - the scripts `pnpm mlflow:up`, `pnpm mlflow:down` and `pnpm mlflow:contract`.

This task's content was validated against a live `v3.16.1` server on 2026-09-24. The contract script passed, and it failed as it should on a fixture tampered with `input_tokens → prompt_tokens`.

- [x] **Step 1: Write the compose file**

`tools/mlflow/compose.yml`:

```yaml
# MLflow for reading traces of idp-agent runs (docs/tracing-design.md). Never
# part of CI, and never needed by `pnpm test`.
#
# 127.0.0.1 only: a trace carries full prompts (SECURITY.md). Port 5055, not
# MLflow's 5000, because macOS's AirPlay receiver holds 5000. The tag is pinned
# because tests/contract/otlp/accepted.json was verified against it; after
# moving it, run `pnpm mlflow:contract`.
name: idp-agent-mlflow
services:
  mlflow:
    image: ghcr.io/mlflow/mlflow:v3.16.1
    command:
      - mlflow
      - server
      - --host=0.0.0.0
      - --port=5000
      - --backend-store-uri=sqlite:////mlflow/mlflow.db
      - --artifacts-destination=/mlflow/artifacts
    ports:
      - 127.0.0.1:5055:5000
    volumes:
      - mlflow-data:/mlflow
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health')"]
      interval: 2s
      timeout: 2s
      retries: 30
volumes:
  mlflow-data:
```

- [x] **Step 2: Add the scripts**

In `package.json`, inside `"scripts"`, after `"demo": "bash scripts/demo.sh"` (add a comma after that line):

```json
    "mlflow:up": "docker compose -f tools/mlflow/compose.yml up -d --wait",
    "mlflow:down": "docker compose -f tools/mlflow/compose.yml down",
    "mlflow:contract": "node scripts/mlflow-contract.mjs"
```

- [x] **Step 3: Start it and check it answers**

Run: `pnpm mlflow:up && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5055/health`
Expected: `Container idp-agent-mlflow-mlflow-1  Healthy`, then `200`.

- [x] **Step 4: Write the contract fixture**

`tests/contract/otlp/accepted.json`. The content is exact; formatting does not matter, because the test compares parsed JSON.

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          {"key":"service.name","value":{"stringValue":"idp-agent"}},
          {"key":"service.version","value":{"stringValue":"0.0.0-contract"}}
        ]
      },
      "scopeSpans": [
        {
          "scope": {"name":"idp-agent","version":"0.0.0-contract"},
          "spans": [
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000001",
              "name": "idp-agent ask",
              "kind": 1,
              "startTimeUnixNano": "1727000000000000000",
              "endTimeUnixNano": "1727000000090000000",
              "attributes": [
                {"key":"mlflow.spanType","value":{"stringValue":"\"CHAIN\""}},
                {
                  "key": "mlflow.spanInputs",
                  "value": {
                    "stringValue": "{\"command\":\"ask\",\"intent\":\"which databases are in prod?\"}"
                  }
                },
                {
                  "key": "mlflow.spanOutputs",
                  "value": {"stringValue":"{\"exitCode\":0,\"text\":\"billing-db-prod\"}"}
                },
                {"key":"idp.mode","value":{"stringValue":"replay"}},
                {"key":"idp.exit_code","value":{"intValue":"0"}}
              ],
              "events": [],
              "status": {"code":1}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000002",
              "parentSpanId": "0000000000000001",
              "name": "supervisor",
              "kind": 1,
              "startTimeUnixNano": "1727000000001000000",
              "endTimeUnixNano": "1727000000020000000",
              "attributes": [{"key":"mlflow.spanType","value":{"stringValue":"\"AGENT\""}}],
              "events": [
                {
                  "timeUnixNano": "1727000000019000000",
                  "name": "classified",
                  "attributes": [{"key":"classification","value":{"stringValue":"QUESTION"}}]
                }
              ],
              "status": {"code":1}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000003",
              "parentSpanId": "0000000000000002",
              "name": "supervisor call 0",
              "kind": 1,
              "startTimeUnixNano": "1727000000002000000",
              "endTimeUnixNano": "1727000000018000000",
              "attributes": [
                {"key":"mlflow.spanType","value":{"stringValue":"\"CHAT_MODEL\""}},
                {
                  "key": "mlflow.spanInputs",
                  "value": {
                    "stringValue": "{\"system\":\"You classify a request.\",\"transcript\":[{\"role\":\"user\",\"text\":\"request: which databases are in prod?\"}],\"tools\":[],\"toolChoice\":\"none\"}"
                  }
                },
                {
                  "key": "mlflow.spanOutputs",
                  "value": {
                    "stringValue": "{\"text\":\"QUESTION\",\"toolCalls\":[],\"finishReason\":\"stop\"}"
                  }
                },
                {
                  "key": "mlflow.chat.tokenUsage",
                  "value": {"stringValue":"{\"input_tokens\":120,\"output_tokens\":3,\"total_tokens\":123}"}
                }
              ],
              "events": [],
              "status": {"code":1}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000004",
              "parentSpanId": "0000000000000001",
              "name": "analyst",
              "kind": 1,
              "startTimeUnixNano": "1727000000021000000",
              "endTimeUnixNano": "1727000000080000000",
              "attributes": [{"key":"mlflow.spanType","value":{"stringValue":"\"AGENT\""}}],
              "events": [
                {
                  "timeUnixNano": "1727000000050000000",
                  "name": "retry",
                  "attributes": [
                    {"key":"agent","value":{"stringValue":"analyst"}},
                    {"key":"reason","value":{"stringValue":"answer: invalid outcome"}}
                  ]
                }
              ],
              "status": {"code":1}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000006",
              "parentSpanId": "0000000000000004",
              "name": "analyst call 0",
              "kind": 1,
              "startTimeUnixNano": "1727000000022000000",
              "endTimeUnixNano": "1727000000029000000",
              "attributes": [
                {"key":"mlflow.spanType","value":{"stringValue":"\"CHAT_MODEL\""}},
                {
                  "key": "mlflow.spanInputs",
                  "value": {
                    "stringValue": "{\"system\":\"You answer questions.\",\"transcript\":[{\"role\":\"user\",\"text\":\"question: which databases are in prod?\"}],\"tools\":[{\"name\":\"search_entities\",\"description\":\"find entities\"}],\"toolChoice\":\"auto\"}"
                  }
                },
                {
                  "key": "mlflow.spanOutputs",
                  "value": {
                    "stringValue": "{\"text\":\"\",\"toolCalls\":[{\"id\":\"c1\",\"name\":\"search_entities\",\"args\":{\"type\":\"database\",\"env\":\"prod\"}}],\"finishReason\":\"tool-calls\"}"
                  }
                },
                {"key":"idp.usage","value":{"stringValue":"absent"}}
              ],
              "events": [],
              "status": {"code":1}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000005",
              "parentSpanId": "0000000000000004",
              "name": "search_entities",
              "kind": 1,
              "startTimeUnixNano": "1727000000030000000",
              "endTimeUnixNano": "1727000000031000000",
              "attributes": [
                {"key":"mlflow.spanType","value":{"stringValue":"\"TOOL\""}},
                {
                  "key": "mlflow.spanInputs",
                  "value": {
                    "stringValue": "{\"id\":\"c1\",\"name\":\"search_entities\",\"args\":{\"type\":\"database\",\"env\":\"prod\"}}"
                  }
                },
                {"key":"mlflow.spanOutputs","value":{"stringValue":"{\"rows\":1,\"truncated\":0}"}}
              ],
              "events": [],
              "status": {"code":1}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000007",
              "parentSpanId": "0000000000000001",
              "name": "attempt 1",
              "kind": 1,
              "startTimeUnixNano": "1727000000081000000",
              "endTimeUnixNano": "1727000000089000000",
              "attributes": [{"key":"mlflow.spanType","value":{"stringValue":"\"CHAIN\""}}],
              "events": [],
              "status": {"code":2,"message":"refused at the policy gate"}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000008",
              "parentSpanId": "0000000000000007",
              "name": "gate zod",
              "kind": 1,
              "startTimeUnixNano": "1727000000082000000",
              "endTimeUnixNano": "1727000000082000000",
              "attributes": [
                {"key":"mlflow.spanType","value":{"stringValue":"\"CHAIN\""}},
                {"key":"idp.attempt","value":{"intValue":"1"}}
              ],
              "events": [],
              "status": {"code":1}
            },
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "0000000000000009",
              "parentSpanId": "0000000000000007",
              "name": "gate policy",
              "kind": 1,
              "startTimeUnixNano": "1727000000083000000",
              "endTimeUnixNano": "1727000000083000000",
              "attributes": [
                {"key":"mlflow.spanType","value":{"stringValue":"\"CHAIN\""}},
                {"key":"idp.attempt","value":{"intValue":"1"}}
              ],
              "events": [],
              "status": {"code":2,"message":"environment-mismatch at operations.0"}
            }
          ]
        }
      ]
    }
  ]
}
```

- [x] **Step 5: Write the contract check** — *since changed:* the script posts to `http://127.0.0.1:5055` and reads no variable: it reads the trace back through that container, so posting anywhere else could never be read back (spec §8.1).

`scripts/mlflow-contract.mjs`:

```js
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
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const COMPOSE = path.join(ROOT, 'tools/mlflow/compose.yml')
const TRACKING_URI = (process.env.MLFLOW_TRACKING_URI || 'http://127.0.0.1:5055').replace(/\/+$/, '')

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
```

- [x] **Step 6: Run the contract against the live server**

Run: `pnpm mlflow:contract`
Expected: `MLflow at http://127.0.0.1:5055 reads all 9 spans of the contract as sent (tr-<32 hex>)`, exit 0.

- [x] **Step 7: Prove the check can fail**

Run:
```bash
cp tests/contract/otlp/accepted.json tests/contract/otlp/accepted.json.bak
sed -i '' 's/input_tokens/prompt_tokens/' tests/contract/otlp/accepted.json
pnpm mlflow:contract; echo "exit $?"
mv tests/contract/otlp/accepted.json.bak tests/contract/otlp/accepted.json
```
Expected: `the trace token usage: read back {"input_tokens":0,"output_tokens":3,"total_tokens":123}, sent {"prompt_tokens":120,…}`, then `exit 1`. After the `mv`, `pnpm mlflow:contract` passes again.

- [x] **Step 8: Stop the server and run the CI commands**

Run: `pnpm mlflow:down && pnpm test && pnpm typecheck && pnpm build && pnpm smoke`
Expected: all green, with the test count unchanged. No test reads the fixture yet.

- [x] **Step 9: Commit** (after a go-ahead)

```bash
git add tools/mlflow/compose.yml tests/contract/otlp/accepted.json scripts/mlflow-contract.mjs package.json
git commit -F - <<'EOF'
chore(tracing): run MLflow locally and pin the OTLP body it accepts

tools/mlflow/compose.yml serves MLflow 3.16.1 on 127.0.0.1:5055, and
tests/contract/otlp/accepted.json is an OTLP/JSON trace that server read
back span by span as sent. scripts/mlflow-contract.mjs repeats that check
whenever the pinned image moves; nothing in CI needs Docker.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 10: Open the PR against `docs/tracing-design`** (after a go-ahead) — *not yet:* nothing is pushed until the owner says so.

---

### Task 2: Events that bound what a trace draws

**Branch:** `git checkout -b feat/tracing-2-events feat/tracing-1-contract`

**Files:**
- Create: `src/agents/lifetime.ts`, `tests/unit/lifetime.test.ts`
- Modify: `src/agents/events.ts`, `src/agents/supervisor.ts`, `src/agents/analyst.ts`, `src/agents/inspector.ts`, `src/agents/architect.ts`, `src/agents/reviewer.ts`, `src/agents/repair.ts`, `src/cli/index.ts` (`renderEvent`), `docs/design.md` §6.2
- Modify tests: `tests/unit/supervisor.test.ts`, `analyst.test.ts`, `architect.test.ts`, `inspector.test.ts`, `reviewer.test.ts`, `repair.test.ts`, `plan-intent.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 4 and 5 rely on these exact shapes):

```ts
// src/agents/events.ts — members added to, or changed in, AgentEvent
| { type: 'agent:end'; agent: AgentName; threw: boolean }
| { type: 'attempt:start'; attempt: 1 | 2 | 3 }
| { type: 'attempt:end'; attempt: 1 | 2 | 3 }
| { type: 'gate:passed'; attempt: 1 | 2 | 3; gate: Gate }
| { type: 'tool:call'; id: string; name: string; args: unknown }                       // id added
| { type: 'tool:result'; id: string; name: string; rows: number; truncated: number }   // id added

// src/agents/lifetime.ts
export async function asAgent<T>(agent: AgentName, emit: EventSink, run: () => Promise<T>): Promise<T>
```

- [x] **Step 1: Write the failing test for `asAgent`**

`tests/unit/lifetime.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { asAgent } from '../../src/agents/lifetime.js'

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

describe('asAgent', () => {
  it('announces the agent before its first turn and after its last', async () => {
    const { events, emit } = collect()

    const value = await asAgent('architect', emit, async () => {
      emit({ type: 'plan:ready', operations: 1 })
      return 42
    })

    expect(value).toBe(42)
    expect(events).toEqual([
      { type: 'agent:start', agent: 'architect' },
      { type: 'plan:ready', operations: 1 },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])
  })

  it('ends the agent it started even when the agent throws, and says that it threw', async () => {
    // A stream showing an agent that began and never ended is the defect the
    // Architect and the Reviewer each patched by hand with a `refused` before
    // rethrowing. This closes it for all five, on every path out.
    const { events, emit } = collect()
    const thrown = new Error('502 from the gateway')

    await expect(asAgent('reviewer', emit, () => Promise.reject(thrown))).rejects.toBe(thrown)

    expect(events).toEqual([
      { type: 'agent:start', agent: 'reviewer' },
      { type: 'agent:end', agent: 'reviewer', threw: true },
    ])
  })
})
```

- [x] **Step 2: Run it to see it fail**

Run: `pnpm vitest run tests/unit/lifetime.test.ts`
Expected: FAIL — `Cannot find module '../../src/agents/lifetime.js'` (or `Failed to load url`).

- [x] **Step 3: Add the events and `asAgent`**

In `src/agents/events.ts`, replace:

```ts
export type AgentEvent =
  | { type: 'agent:start'; agent: AgentName }
  | { type: 'classified'; classification: 'MUTATION' | 'QUESTION' }
  | { type: 'tool:call'; name: string; args: unknown }
  | { type: 'tool:result'; name: string; rows: number; truncated: number }
```

with:

```ts
export type AgentEvent =
  | { type: 'agent:start'; agent: AgentName }
  /**
   * The agent returned or threw. Emitted by `asAgent` on every path out, so
   * an agent that began always ends on the stream; `threw` says which path.
   * A trace closes the agent's span on it (src/trace/, ADR-0009) rather than
   * on whatever event happens to come next.
   */
  | { type: 'agent:end'; agent: AgentName; threw: boolean }
  | { type: 'classified'; classification: 'MUTATION' | 'QUESTION' }
  /**
   * `id` is the model's own id for the call, and the result carries the same
   * one: a call and its result are paired by identity, never by order.
   */
  | { type: 'tool:call'; id: string; name: string; args: unknown }
  | { type: 'tool:result'; id: string; name: string; rows: number; truncated: number }
```

Then, in the same union, replace:

```ts
  | { type: 'repair'; attempt: 1 | 2 | 3; gate: Gate; reason: string }
```

with:

```ts
  | { type: 'repair'; attempt: 1 | 2 | 3; gate: Gate; reason: string }
  /**
   * The bounds of one attempt of the repair loop, and every gate it passed.
   * `repair()` alone emits them, beside the `repair` event that already
   * reports a refusal — a `gate` event carrying `passed: false` would have
   * stated that one fact twice. An attempt that passes every gate used to
   * leave nothing on the stream at all.
   */
  | { type: 'attempt:start'; attempt: 1 | 2 | 3 }
  | { type: 'attempt:end'; attempt: 1 | 2 | 3 }
  | { type: 'gate:passed'; attempt: 1 | 2 | 3; gate: Gate }
```

Create `src/agents/lifetime.ts`:

```ts
import type { AgentName } from '../llm/client.js'
import type { EventSink } from './events.js'

/**
 * An agent's lifetime on the stream: `agent:start` before its first turn and
 * `agent:end` after its last, on every path out — a return, a refusal, a
 * throw.
 *
 * Each agent used to emit its own start and no end, and two of them emitted a
 * `refused` before rethrowing a provider failure so the stream would not show
 * an agent that began and never ended. That patch is kept — the refusal says
 * why — and this is the end it was standing in for.
 */
export async function asAgent<T>(
  agent: AgentName,
  emit: EventSink,
  run: () => Promise<T>,
): Promise<T> {
  emit({ type: 'agent:start', agent })
  let threw = true
  try {
    const value = await run()
    threw = false
    return value
  } finally {
    emit({ type: 'agent:end', agent, threw })
  }
}
```

- [x] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run tests/unit/lifetime.test.ts`
Expected: PASS, 2 tests.

- [x] **Step 5: Make the agents' own tests expect the end** — *since changed:* upstream renamed the event a failed model call ends on, so the Architect, Inspector and Reviewer tests expect `[agent:start, stopped, agent:end]` with `threw: true`, not `refused`.

`tests/unit/supervisor.test.ts`. Replace:

```ts
    expect(events).toEqual([
      { type: 'agent:start', agent: 'supervisor' },
      { type: 'classified', classification: 'QUESTION' },
    ])
```

with:

```ts
    expect(events).toEqual([
      { type: 'agent:start', agent: 'supervisor' },
      { type: 'classified', classification: 'QUESTION' },
      { type: 'agent:end', agent: 'supervisor', threw: false },
    ])
```

and replace:

```ts
    expect(events.at(-1)).toMatchObject({ type: 'refused', agent: 'supervisor' })
```

with:

```ts
    expect(events.at(-2)).toMatchObject({ type: 'refused', agent: 'supervisor' })
    expect(events.at(-1)).toEqual({ type: 'agent:end', agent: 'supervisor', threw: true })
```

`tests/unit/analyst.test.ts`, in `it('emits a readable stream: start, call, result, then the answer'`, replace:

```ts
      'tool:result',
      'answer:ready',
    ])
```

with:

```ts
      'tool:result',
      'answer:ready',
      'agent:end',
    ])
```

and add this test inside `describe('answerQuestion'`, right after that one:

```ts
  it('pairs a tool call with its result by the id the model gave the call', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database' }),
      turnCalling('answer', { outcome: 'entities', refs: [A] }),
    ])
    const { events, emit } = collect()
    await answerQuestion(client, fakeTools([A]), INPUT, emit)
    const ids = events.flatMap((event) =>
      event.type === 'tool:call' || event.type === 'tool:result' ? [event.id] : [],
    )
    // `turnCalling` gives every call the id c1.
    expect(ids).toEqual(['c1', 'c1'])
  })
```

`tests/unit/architect.test.ts`, in `it('stops at its turn bound and refuses rather than returning a partial plan'`, replace:

```ts
      'refused',
    ])
    expect(events.at(0)).toEqual({ type: 'agent:start', agent: 'architect' })
    expect(events.at(-1)).toEqual({
      type: 'refused',
      agent: 'architect',
      reason: expect.any(String),
    })
```

with:

```ts
      'refused',
      'agent:end',
    ])
    expect(events.at(0)).toEqual({ type: 'agent:start', agent: 'architect' })
    expect(events.at(-2)).toEqual({
      type: 'refused',
      agent: 'architect',
      reason: expect.any(String),
    })
    expect(events.at(-1)).toEqual({ type: 'agent:end', agent: 'architect', threw: false })
```

In `it('reports the proposal as a plan, never as one more tool call'`, replace:

```ts
      'tool:result',
      'plan:ready',
    ])
```

with:

```ts
      'tool:result',
      'plan:ready',
      'agent:end',
    ])
```

In the test whose client rejects with `'502 from the gateway'`, replace:

```ts
    expect(events.map((event) => event.type)).toEqual(['agent:start', 'refused'])
```

with:

```ts
    expect(events.map((event) => event.type)).toEqual(['agent:start', 'refused', 'agent:end'])
    expect(events.at(-1)).toEqual({ type: 'agent:end', agent: 'architect', threw: true })
```

`tests/unit/inspector.test.ts`. Replace:

```ts
      ...Array.from({ length: INSPECTOR_LIMITS.maxTurns }, () => ['tool:call', 'tool:result']).flat(),
      'refused',
    ])
    expect(events.at(0)).toEqual({ type: 'agent:start', agent: 'inspector' })
    expect(events.at(-1)).toEqual({ type: 'refused', agent: 'inspector', reason: expect.any(String) })
```

with:

```ts
      ...Array.from({ length: INSPECTOR_LIMITS.maxTurns }, () => ['tool:call', 'tool:result']).flat(),
      'refused',
      'agent:end',
    ])
    expect(events.at(0)).toEqual({ type: 'agent:start', agent: 'inspector' })
    expect(events.at(-2)).toEqual({ type: 'refused', agent: 'inspector', reason: expect.any(String) })
    expect(events.at(-1)).toEqual({ type: 'agent:end', agent: 'inspector', threw: false })
```

`tests/unit/reviewer.test.ts`. Replace:

```ts
    expect(events.map((event) => event.type)).toEqual(['agent:start'])
```

with:

```ts
    expect(events.map((event) => event.type)).toEqual(['agent:start', 'agent:end'])
```

and replace:

```ts
    expect(events.map((event) => event.type)).toEqual(['agent:start', 'refused'])
```

with:

```ts
    expect(events.map((event) => event.type)).toEqual(['agent:start', 'refused', 'agent:end'])
    expect(events.at(-1)).toEqual({ type: 'agent:end', agent: 'reviewer', threw: true })
```

- [x] **Step 6: Run them to see them fail**

Run: `pnpm vitest run tests/unit/supervisor.test.ts tests/unit/analyst.test.ts tests/unit/architect.test.ts tests/unit/inspector.test.ts tests/unit/reviewer.test.ts`
Expected: FAIL. The sequences lack `agent:end`, and the new analyst test sees `[undefined, undefined]`.

- [x] **Step 7: Wrap the five agents, and give tool events their id** — *since changed:* the Architect also answers the call it refuses (`answer`) with a `tool:result` carrying `error`, under the same id; `tests/unit/architect.test.ts` holds it.

Apply the same three edits in each of the five files:
- add `import { asAgent } from './lifetime.js'` beside the file's other `./` imports;
- rename the exported function to the private name given below;
- delete its first line, `emit({ type: 'agent:start', agent: '<name>' })`;
- add the exported wrapper **above** the renamed function.

`src/agents/supervisor.ts`: replace

```ts
export async function classify(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<Classification> {
  emit({ type: 'agent:start', agent: 'supervisor' })

```

with

```ts
export async function classify(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<Classification> {
  return asAgent('supervisor', emit, () => classifyRequest(client, input, emit))
}

async function classifyRequest(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<Classification> {
```

`src/agents/analyst.ts`: replace

```ts
export async function answerQuestion(
  client: LlmClient,
  tools: ReturnType<typeof buildTools>,
  input: { intent: string; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<AnalystOutcome> {
  emit({ type: 'agent:start', agent: 'analyst' })

```

with

```ts
export async function answerQuestion(
  client: LlmClient,
  tools: ReturnType<typeof buildTools>,
  input: { intent: string; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<AnalystOutcome> {
  return asAgent('analyst', emit, () => answerFromCatalogue(client, tools, input, emit))
}

async function answerFromCatalogue(
  client: LlmClient,
  tools: ReturnType<typeof buildTools>,
  input: { intent: string; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<AnalystOutcome> {
```

`src/agents/inspector.ts`: replace

```ts
export async function inspect(
  client: LlmClient,
  snapshot: ProjectSnapshot,
  emit: EventSink,
): Promise<ProjectFacts> {
  emit({ type: 'agent:start', agent: 'inspector' })

```

with

```ts
export async function inspect(
  client: LlmClient,
  snapshot: ProjectSnapshot,
  emit: EventSink,
): Promise<ProjectFacts> {
  return asAgent('inspector', emit, () => inspectRepository(client, snapshot, emit))
}

async function inspectRepository(
  client: LlmClient,
  snapshot: ProjectSnapshot,
  emit: EventSink,
): Promise<ProjectFacts> {
```

`src/agents/architect.ts`: replace

```ts
export async function draftPlan(
  client: LlmClient,
  tools: {
    specs: ModelToolSpec[]
    run(call: ModelToolCall): ToolOutcome
    witnessed: ReadonlySet<string>
  },
  input: { intent: string; facts: ProjectFacts; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<ArchitectOutcome> {
  emit({ type: 'agent:start', agent: 'architect' })

```

with

```ts
export async function draftPlan(
  client: LlmClient,
  tools: {
    specs: ModelToolSpec[]
    run(call: ModelToolCall): ToolOutcome
    witnessed: ReadonlySet<string>
  },
  input: { intent: string; facts: ProjectFacts; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<ArchitectOutcome> {
  return asAgent('architect', emit, () => draftFromIntent(client, tools, input, emit))
}

async function draftFromIntent(
  client: LlmClient,
  tools: {
    specs: ModelToolSpec[]
    run(call: ModelToolCall): ToolOutcome
    witnessed: ReadonlySet<string>
  },
  input: { intent: string; facts: ProjectFacts; summary: string; vocabulary: string },
  emit: EventSink,
): Promise<ArchitectOutcome> {
```

`src/agents/reviewer.ts`: replace

```ts
export async function reviewPlan(
  client: LlmClient,
  input: ReviewInput,
  emit: EventSink,
): Promise<Verdict> {
  emit({ type: 'agent:start', agent: 'reviewer' })

```

with

```ts
export async function reviewPlan(
  client: LlmClient,
  input: ReviewInput,
  emit: EventSink,
): Promise<Verdict> {
  return asAgent('reviewer', emit, () => reviewAgainstRequest(client, input, emit))
}

async function reviewAgainstRequest(
  client: LlmClient,
  input: ReviewInput,
  emit: EventSink,
): Promise<Verdict> {
```

Tool ids come next. In each of `analyst.ts`, `inspector.ts` and `architect.ts`, replace the one line

```ts
      if (reads) emit({ type: 'tool:call', name: call.name, args: call.args })
```

with

```ts
      if (reads) emit({ type: 'tool:call', id: call.id, name: call.name, args: call.args })
```

and, in the same loop, replace

```ts
        emit({
          type: 'tool:result',
          name: call.name,
```

with

```ts
        emit({
          type: 'tool:result',
          id: call.id,
          name: call.name,
```

- [x] **Step 8: Run the agents' tests to see them pass**

Run: `pnpm vitest run tests/unit/lifetime.test.ts tests/unit/supervisor.test.ts tests/unit/analyst.test.ts tests/unit/architect.test.ts tests/unit/inspector.test.ts tests/unit/reviewer.test.ts`
Expected: PASS.

- [x] **Step 9: Write the failing test that ties the stream to the repair record**

Append to the end of `tests/unit/repair.test.ts`. It uses only helpers already defined at the top of that file.

```ts
/**
 * The attempts as the stream tells them: each one's gates, passed or refused,
 * between its own attempt:start and attempt:end. It is what a trace is built
 * from (src/trace/), so it must never tell a run differently from the record
 * `repair()` returns.
 */
interface Told {
  attempt: number
  passed: Gate[]
  refused: Gate | undefined
  closed: boolean
}

const told = (events: readonly AgentEvent[]): Told[] => {
  const attempts: Told[] = []
  for (const event of events) {
    if (event.type === 'attempt:start') {
      attempts.push({ attempt: event.attempt, passed: [], refused: undefined, closed: false })
    }
    const current = attempts.at(-1)
    if (current === undefined) continue
    if (event.type === 'gate:passed') current.passed.push(event.gate)
    if (event.type === 'repair') current.refused = event.gate
    if (event.type === 'attempt:end') current.closed = true
  }
  return attempts
}

const recorded = (outcome: RepairOutcome): Told[] =>
  outcome.attempts.map((one) => ({
    attempt: one.attempt,
    passed: one.gates.filter((gate) => gate !== one.failed),
    refused: one.failed,
    closed: true,
  }))

const RUNS: readonly (readonly [string, () => RepairInput])[] = [
  ['a plan that passes every gate', () => inputs()],
  ['a refusal at the zod gate', () => inputs({ draft: drafting(REFUSED_BY_ZOD).draft })],
  [
    'three refusals at the policy gate',
    () => inputs({ provenance: stating(DEV_INTENT), draft: drafting(MISMATCHED).draft }),
  ],
  [
    'three refusals by the Reviewer',
    () => inputs({ review: reviewing({ verdict: 'reject', reason: 'more than was asked' }).review }),
  ],
  [
    'a question the signer asked',
    () => inputs({ provenance: stating(DECLARE_INTENT), draft: drafting(UNVOUCHED).draft }),
  ],
  ['a draft with no proposal in it', () => inputs({ draft: drafting(undefined).draft })],
]

describe('the stream tells each attempt the way the record does', () => {
  it.each(RUNS)('%s', async (_label, given) => {
    const { events, emit } = collect()

    const outcome = await repair(given(), emit)

    expect(told(events)).toEqual(recorded(outcome))
  })

  it('closes the attempt a Reviewer with no opinion ended, without calling it a refusal', async () => {
    // The one exit that records no attempt in the outcome: the Reviewer was
    // never reached, so nothing was refused. The stream still bounds the
    // attempt that ran four gates.
    const { events, emit } = collect()

    await repair(
      inputs({
        review: reviewing({ verdict: 'no-opinion', reason: 'the reviewer could not be reached' })
          .review,
      }),
      emit,
    )

    expect(told(events)).toEqual([
      {
        attempt: 1,
        passed: ['zod', 'signature', 'policy', 'recheck'],
        refused: undefined,
        closed: true,
      },
    ])
  })
})
```

- [x] **Step 10: Run it to see it fail**

Run: `pnpm vitest run tests/unit/repair.test.ts -t 'the stream tells each attempt'`
Expected: FAIL — `told(events)` is `[]`, because nothing emits `attempt:start` yet.

- [x] **Step 11: Emit the bounds and the verdicts in `repair()`** — *since changed:* `attempt:end` is emitted once, from a `finally` around the attempt, on every exit — a throw included — and carries `stopped` when the attempt ended with no verdict (no-opinion, no draft, a throw); `tests/unit/repair.test.ts` holds each exit.

In `src/agents/repair.ts`, make these edits in order.

(a) Replace

```ts
    const attempt = Math.min(number, 3) as 1 | 2 | 3
    const gates: Gate[] = []
```

with

```ts
    const attempt = Math.min(number, 3) as 1 | 2 | 3
    const gates: Gate[] = []
    // The attempt's bounds and each verdict, on the stream as they happen. The
    // record says the same once the loop is over; a trace built from the
    // stream (src/trace/) needs it while the loop is running, and a test in
    // tests/unit/repair.test.ts holds the two to agreeing.
    emit({ type: 'attempt:start', attempt })
    const passed = (gate: Gate): void => emit({ type: 'gate:passed', attempt, gate })
    const ended = (): void => emit({ type: 'attempt:end', attempt })
```

(b) In `fail`, replace

```ts
      emit({ type: 'repair', attempt, gate, reason })
    }
```

with

```ts
      emit({ type: 'repair', attempt, gate, reason })
      ended()
    }
```

(c) Replace

```ts
      attempts.push({ attempt, gates, failed: undefined, report: undefined })
      // The refusal an earlier attempt recorded is kept, not overwritten. A
```

with

```ts
      attempts.push({ attempt, gates, failed: undefined, report: undefined })
      ended()
      // The refusal an earlier attempt recorded is kept, not overwritten. A
```

(d) Replace

```ts
    if (!parsed.success) {
      fail('zod', [reasonOf(parsed.error)])
      continue
    }
```

with

```ts
    if (!parsed.success) {
      fail('zod', [reasonOf(parsed.error)])
      continue
    }
    passed('zod')
```

(e) Replace

```ts
        signed.refusals.map((one) => `${one.path}: ${one.reason}`),
      )
      continue
    }
```

with

```ts
        signed.refusals.map((one) => `${one.path}: ${one.reason}`),
      )
      continue
    }
    passed('signature')
```

(f) Replace

```ts
        violations.map((one) => `${one.policy} at ${one.path}: ${one.message}`),
      )
      continue
    }
```

with

```ts
        violations.map((one) => `${one.policy} at ${one.path}: ${one.message}`),
      )
      continue
    }
    passed('policy')
```

(g) Replace

```ts
      attempts.push({ attempt, gates: [...gates], failed: undefined, report: undefined })
      return { outcome: 'questions', plan: signed.plan, questions, attempts, truncated, rejections }
```

with

```ts
      attempts.push({ attempt, gates: [...gates], failed: undefined, report: undefined })
      ended()
      return { outcome: 'questions', plan: signed.plan, questions, attempts, truncated, rejections }
```

(h) Replace

```ts
        errors.map((one) => `${one.rule} at ${one.file}: ${one.message}`),
      )
      continue
    }
```

with

```ts
        errors.map((one) => `${one.rule} at ${one.file}: ${one.message}`),
      )
      continue
    }
    passed('recheck')
```

(i) Replace

```ts
      // their plan was refused. It stops here, saying what actually happened.
      return {
```

with

```ts
      // their plan was refused. It stops here, saying what actually happened.
      ended()
      return {
```

(j) Replace

```ts
    if (verdict.verdict === 'reject') {
      fail('reviewer', [verdict.reason])
      continue
    }

    attempts.push({ attempt, gates: [...gates], failed: undefined, report: undefined })
    return { outcome: 'planned', signed, edits, dropped, recheck, attempts, truncated, rejections }
```

with

```ts
    if (verdict.verdict === 'reject') {
      fail('reviewer', [verdict.reason])
      continue
    }
    passed('reviewer')

    attempts.push({ attempt, gates: [...gates], failed: undefined, report: undefined })
    ended()
    return { outcome: 'planned', signed, edits, dropped, recheck, attempts, truncated, rejections }
```

- [x] **Step 12: Run the repair tests to see them pass**

Run: `pnpm vitest run tests/unit/repair.test.ts`
Expected: PASS, all tests, including the 7 new ones.

- [x] **Step 13: Render nothing for the new events, and test it**

`tests/unit/plan-intent.test.ts`, in `describe('what a run looks like on a terminal'`. Replace

```ts
    expect(renderEvent({ type: 'tool:call', name: 'search_entities', args: { env: 'prod' } })).toBe(
```

with

```ts
    expect(renderEvent({ type: 'tool:call', id: 'c1', name: 'search_entities', args: { env: 'prod' } })).toBe(
```

and replace

```ts
    expect(renderEvent({ type: 'tool:result', name: 'search_entities', rows: 25, truncated: 3 })).toBe(
```

with

```ts
    expect(renderEvent({ type: 'tool:result', id: 'c1', name: 'search_entities', rows: 25, truncated: 3 })).toBe(
```

Then add this `it` as the last test of that same `describe`:

```ts
  it('renders nothing for the events that only bound a span', () => {
    // An agent's end, an attempt's bounds and a gate that passed are structure
    // for a trace (src/trace/). The lines they bound already say what happened.
    expect(renderEvent({ type: 'agent:end', agent: 'architect', threw: false })).toBeUndefined()
    expect(renderEvent({ type: 'attempt:start', attempt: 1 })).toBeUndefined()
    expect(renderEvent({ type: 'attempt:end', attempt: 1 })).toBeUndefined()
    expect(renderEvent({ type: 'gate:passed', attempt: 1, gate: 'zod' })).toBeUndefined()
  })
```

Run: `pnpm typecheck`
Expected: FAIL. `renderEvent`'s `const exhaustive: never = event` reports the four new members as unhandled.

In `src/cli/index.ts` `renderEvent`, replace

```ts
    case 'ask':
    case 'answer:ready':
      return undefined
```

with

```ts
    case 'ask':
    case 'answer:ready':
      return undefined
    case 'agent:end':
    case 'attempt:start':
    case 'attempt:end':
    case 'gate:passed':
      // Structure, not news. They bound what the lines above already say — an
      // agent's `·`, an attempt's `!` — and a trace needs them to draw spans;
      // a reader of stderr does not need four more lines per attempt.
      return undefined
```

Run: `pnpm typecheck && pnpm vitest run tests/unit/plan-intent.test.ts`
Expected: typecheck clean; the tests PASS.

- [x] **Step 14: Update design §6.2** — *since changed:* the union also carries upstream's `stopped`, `reapplied` and `tool:result.error`, and `attempt:end.stopped`.

In `docs/design.md` §6.2, replace the listed union:

```ts
type AgentEvent =
  | { type: 'agent:start';  agent: AgentName }
  | { type: 'classified';   classification: 'MUTATION' | 'QUESTION' }
  | { type: 'tool:call';    name: string; args: unknown }
  | { type: 'tool:result';  name: string; rows: number; truncated: number }
  | { type: 'answer:ready'; refs: string[] }
  | { type: 'refused';      agent: AgentName; reason: string }
  | { type: 'repair';       attempt: 1 | 2 | 3; gate: Gate; reason: string }
  | { type: 'retry';        agent: AgentName; reason: string }
  | { type: 'plan:ready';   operations: number }
  | { type: 'ask';          question: Question }
```

with

```ts
type AgentEvent =
  | { type: 'agent:start';   agent: AgentName }
  | { type: 'agent:end';     agent: AgentName; threw: boolean }
  | { type: 'classified';    classification: 'MUTATION' | 'QUESTION' }
  | { type: 'tool:call';     id: string; name: string; args: unknown }
  | { type: 'tool:result';   id: string; name: string; rows: number; truncated: number }
  | { type: 'answer:ready';  outcome: Answer['outcome']; refs: string[] }
  | { type: 'refused';       agent: AgentName; reason: string }
  | { type: 'repair';        attempt: 1 | 2 | 3; gate: Gate; reason: string }
  | { type: 'attempt:start'; attempt: 1 | 2 | 3 }
  | { type: 'attempt:end';   attempt: 1 | 2 | 3 }
  | { type: 'gate:passed';   attempt: 1 | 2 | 3; gate: Gate }
  | { type: 'retry';         agent: AgentName; reason: string }
  | { type: 'plan:ready';    operations: number }
  | { type: 'derived';       path: string; owner: string; from: readonly string[] }
  | { type: 'overridden';    path: string; owner: string; determined: string; from: readonly string[] }
  | { type: 'ask';           question: Question }
```

The old listing had also drifted: `answer:ready`'s `outcome`, `derived` and `overridden` were missing. The new one is the union as `src/agents/events.ts` declares it.

- [x] **Step 15: Run the CI commands and correct the count**

Run: `df -h / && pnpm test && pnpm typecheck && pnpm build && pnpm smoke`
Expected: all green, with 11 tests added: 2 in `lifetime.test.ts`, 1 in `analyst.test.ts`, 7 in `repair.test.ts` (6 from `it.each`, 1 on its own) and 1 in `plan-intent.test.ts`. Write the number `pnpm test` measured, not this sum, into AGENTS.md at `pnpm test             # <N> tests.`.

- [x] **Step 16: Commit** (after a go-ahead)

```bash
git add src/agents/events.ts src/agents/lifetime.ts src/agents/supervisor.ts src/agents/analyst.ts \
  src/agents/inspector.ts src/agents/architect.ts src/agents/reviewer.ts src/agents/repair.ts \
  src/cli/index.ts docs/design.md AGENTS.md tests/unit/lifetime.test.ts tests/unit/supervisor.test.ts \
  tests/unit/analyst.test.ts tests/unit/architect.test.ts tests/unit/inspector.test.ts \
  tests/unit/reviewer.test.ts tests/unit/repair.test.ts tests/unit/plan-intent.test.ts
git commit -F - <<'EOF'
feat(agents): end every agent and bound every attempt on the stream

An agent's end, an attempt's bounds and each gate that passed are now
events, and a tool call and its result carry the model's call id. A span
can then be closed by what happened rather than by whatever came next.
repair.test.ts holds the stream to the record repair() returns, for
every way an attempt ends. None of the new events renders on stderr.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 17: Open the PR against `feat/tracing-1-contract`** (after a go-ahead) — *not yet:* nothing is pushed until the owner says so.

---

### Task 3: Token usage, reported and recorded

**Branch:** `git checkout -b feat/tracing-3-usage feat/tracing-2-events`

**Files:**
- Modify: `src/llm/client.ts`, `src/llm/runtime.ts`, `src/llm/README.md`
- Test: `tests/unit/runtime.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// src/llm/client.ts
export interface TokenUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}
export interface GenerateResult { text: string; toolCalls: ModelToolCall[]; finishReason: string; usage?: TokenUsage }

// src/llm/runtime.ts
export function usageOf(raw: unknown): TokenUsage | undefined
```

- [x] **Step 1: Write the failing tests**

In `tests/unit/runtime.test.ts`, replace the first import

```ts
import { createClient } from '../../src/llm/runtime.js'
```

with

```ts
import { createClient, usageOf } from '../../src/llm/runtime.js'
```

and append at the end of the file:

```ts
describe('token usage', () => {
  it('keeps the counts a provider reported and drops the ones it did not', () => {
    expect(
      usageOf({ inputTokens: 120, outputTokens: 3, totalTokens: 123, inputTokenDetails: {} }),
    ).toEqual({ inputTokens: 120, outputTokens: 3, totalTokens: 123 })
    // Absent is not zero: an unreported count stays unreported.
    expect(usageOf({ inputTokens: 120, outputTokens: undefined, totalTokens: undefined })).toEqual({
      inputTokens: 120,
    })
  })

  it('has no usage at all when nothing was reported', () => {
    expect(usageOf(undefined)).toBeUndefined()
    expect(usageOf('120 tokens')).toBeUndefined()
    expect(usageOf({ inputTokens: undefined, outputTokens: Number.NaN })).toBeUndefined()
  })

  it('replays the usage a recording carries', async () => {
    const counted: Recording = {
      ...recording,
      turns: [
        {
          ...turn('supervisor', 0, []),
          result: {
            content: [{ type: 'text', text: 'QUESTION' }],
            finishReason: 'stop',
            usage: { inputTokens: 120, outputTokens: 1, totalTokens: 121 },
          },
        },
      ],
    }
    const client = createClient({
      tape: await openRecording({
        scenario: 'demo',
        store: { read: async () => counted, write: async () => {} },
        mode: 'replay',
        warn: () => {},
      }),
      mode: 'replay',
    })

    expect((await client.generate(ask('supervisor'))).usage).toEqual({
      inputTokens: 120,
      outputTokens: 1,
      totalTokens: 121,
    })
  })

  it('replays a recording made before usage was stored with no usage, never a zero', async () => {
    const result = await (await replaying()).generate(ask('supervisor'))
    expect('usage' in result).toBe(false)
  })
})
```

- [x] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/unit/runtime.test.ts`
Expected: FAIL — `usageOf is not a function` (vitest may report `does not provide an export named 'usageOf'`).

- [x] **Step 3: Implement** — *since changed:* upstream's `runtime.ts` gained `ModelCallError` and `IDP_TIMEOUT` meanwhile; `usage` rides beside them on the live, record and replay paths, and `tests/contract/providers.test.ts` expects it from all three providers.

In `src/llm/client.ts`, replace

```ts
export interface GenerateResult {
  text: string
  toolCalls: ModelToolCall[]
  finishReason: string
}
```

with

```ts
/** What a provider reported about one call. A count it did not report is absent, never 0. */
export interface TokenUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface GenerateResult {
  text: string
  toolCalls: ModelToolCall[]
  finishReason: string
  /** Absent when the provider reported none — and on every recording made before it was stored. */
  usage?: TokenUsage
}
```

In `src/llm/runtime.ts`, extend the type import from `./client.js` with `TokenUsage` (alphabetical position, after `ModelToolCall`), then replace

```ts
const fromRecord = (record: TurnRecord): GenerateResult => ({
  ...readContent(record.result.content),
  finishReason: record.result.finishReason,
})
```

with

```ts
/**
 * The token counts a provider reported, and only those. A count it did not
 * report stays absent rather than becoming 0, and a result with no count at
 * all has no usage: an old recording, or a provider that says nothing.
 */
export function usageOf(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const read = (key: string): number | undefined => {
    const value = (raw as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const inputTokens = read('inputTokens')
  const outputTokens = read('outputTokens')
  const totalTokens = read('totalTokens')
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

/** Omitted rather than set to undefined: exactOptionalPropertyTypes draws the distinction. */
const withUsage = (usage: TokenUsage | undefined): { usage?: TokenUsage } =>
  usage === undefined ? {} : { usage }

const fromRecord = (record: TurnRecord): GenerateResult => ({
  ...readContent(record.result.content),
  finishReason: record.result.finishReason,
  ...withUsage(usageOf(record.result.usage)),
})
```

Then, in `createClient`, replace

```ts
      spend()

      if (options.mode === 'live') {
        return { ...readContent(response.content), finishReason: response.finishReason }
      }
```

with

```ts
      spend()
      const usage = usageOf(response.usage)

      if (options.mode === 'live') {
        return {
          ...readContent(response.content),
          finishReason: response.finishReason,
          ...withUsage(usage),
        }
      }
```

and replace

```ts
        result: { content: response.content, finishReason: response.finishReason },
      })
      return { ...readContent(response.content), finishReason: response.finishReason }
```

with

```ts
        result: {
          content: response.content,
          finishReason: response.finishReason,
          ...withUsage(usage),
        },
      })
      return {
        ...readContent(response.content),
        finishReason: response.finishReason,
        ...withUsage(usage),
      }
```

- [x] **Step 4: Run the tests to see them pass** — *since changed:* the live path does have a test seam after all: `tests/contract/providers.test.ts` drives it offline through a mocked wire `fetch`. Only the record path has none.

Run: `pnpm vitest run tests/unit/runtime.test.ts && pnpm typecheck`
Expected: PASS, and typecheck clean.

The live and record paths call a real provider and have no test seam. They are the two `usageOf(response.usage)` reads above, and the next `IDP_RECORDING=record` run is what exercises them. Say so in the PR description rather than claiming coverage.

- [x] **Step 5: Document it**

In `src/llm/README.md`, insert this section right before `## The third way in, and why it exists`:

```markdown
## Token usage

`GenerateResult.usage` is what the provider reported — `inputTokens`, `outputTokens`,
`totalTokens`, each only if reported — read by `usageOf` in `runtime.ts`. A recording made
from now on stores it under `result.usage`; the digest covers the request, not the result,
so no tape goes stale by gaining it. The recordings made before it carry none, and replaying
one gives a result with **no** `usage` key — never a count of 0. `src/trace/` reports that
as `idp.usage: absent`.
```

- [x] **Step 6: Run the CI commands and correct the count**

Run: `df -h / && pnpm test && pnpm typecheck && pnpm build && pnpm smoke`
Expected: all green, with 4 tests added. Write the measured count into AGENTS.md.

- [x] **Step 7: Commit** (after a go-ahead)

```bash
git add src/llm/client.ts src/llm/runtime.ts src/llm/README.md tests/unit/runtime.test.ts AGENTS.md
git commit -F - <<'EOF'
feat(llm): report the token usage a provider returns, and record it

GenerateResult gains an optional usage, read by usageOf from what the
SDK returns and stored in new recordings. A count the provider did not
report stays absent, and replaying a recording made before this gives
no usage at all rather than a zero.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 8: Open the PR against `feat/tracing-2-events`** (after a go-ahead) — *not yet:* nothing is pushed until the owner says so.

---

### Task 4: `src/trace/` — the builder, the decorator, the encoder

**Branch:** `git checkout -b feat/tracing-4-trace feat/tracing-3-usage`

**Files:**
- Create: `src/trace/model.ts`, `src/trace/builder.ts`, `src/trace/client.ts`, `src/trace/otlp.ts`, `src/trace/README.md`
- Create: `tests/support/trace.ts`, `tests/contract/otlp/contract-trace.ts`
- Create: `tests/unit/trace-builder.test.ts`, `tests/unit/trace-client.test.ts`, `tests/unit/trace-otlp.test.ts`, `tests/invariants/trace.test.ts`
- Create: `docs/adr/0009-tracing-renders-the-event-stream.md`
- Modify: `tests/architecture/dependencies.test.ts`, `docs/design.md` (§5.5, §6.2), `AGENTS.md` (layering, rule count, test count)

**Interfaces:**
- Consumes: the Task 2 events, `TokenUsage` and `GenerateResult.usage` from Task 3, and `tests/contract/otlp/accepted.json` from Task 1.
- Produces (Task 5 relies on these):

```ts
// src/trace/model.ts
export type SpanType = 'CHAIN' | 'AGENT' | 'CHAT_MODEL' | 'TOOL'
export type AttributeValue = string | number | boolean
export type Attributes = Readonly<Record<string, AttributeValue>>
export type SpanStatus = { readonly code: 'OK' } | { readonly code: 'ERROR'; readonly message: string }
export interface SpanEvent { readonly name: string; readonly time: bigint; readonly attributes: Attributes }
export interface Span { spanId; parentId: string | undefined; name; type: SpanType; start: bigint; end: bigint;
  status: SpanStatus; inputs: unknown; outputs: unknown; usage: TokenUsage | undefined; attributes: Attributes; events: readonly SpanEvent[] }
export interface Trace { readonly traceId: string; readonly spans: readonly Span[] }

// src/trace/builder.ts
export interface TraceIds { traceId(): string; spanId(): string }
export interface RunOutcome { readonly outputs: unknown; readonly error?: string; readonly attributes?: Attributes }
export type ModelCallOutcome = { readonly result: GenerateResult } | { readonly error: unknown }
export interface TraceBuilder { readonly traceId: string; onEvent(event: AgentEvent): void;
  modelCallStarted(request: GenerateRequest): string; modelCallEnded(handle: string, outcome: ModelCallOutcome): void;
  finish(outcome: RunOutcome): Trace }
export function createTraceBuilder(options: { clock: () => bigint; ids: TraceIds; name: string; inputs: unknown; attributes?: Attributes }): TraceBuilder

// src/trace/client.ts
export function traced(client: LlmClient, builder: Pick<TraceBuilder, 'modelCallStarted' | 'modelCallEnded'>): LlmClient

// src/trace/otlp.ts
export interface OtlpResource { readonly serviceVersion: string }
export function toOtlpJson(trace: Trace, resource: OtlpResource): unknown

// tests/support/trace.ts
export const fakeClock: () => () => bigint
export const fakeIds: () => TraceIds
export interface Skeleton { name: string; type: SpanType; status: string; children: readonly Skeleton[] }  // status: 'OK' | 'ERROR: <message>'
export function skeletonOf(trace: Trace): Skeleton
export function spanNamed(trace: Trace, name: string): Span
```

- [ ] **Step 1: Write the data model**

`src/trace/model.ts`:

```ts
import type { TokenUsage } from '../llm/client.js'

/**
 * A run, as MLflow is handed it. Plain data: `builder.ts` builds it, `otlp.ts`
 * encodes it, and nothing in between reaches a disk or a network.
 */

/** The four MLflow span types this project emits — each checked to render (ADR-0009). */
export type SpanType = 'CHAIN' | 'AGENT' | 'CHAT_MODEL' | 'TOOL'

export type AttributeValue = string | number | boolean
export type Attributes = Readonly<Record<string, AttributeValue>>

export type SpanStatus =
  | { readonly code: 'OK' }
  | { readonly code: 'ERROR'; readonly message: string }

export interface SpanEvent {
  readonly name: string
  /** Unix nanoseconds. */
  readonly time: bigint
  readonly attributes: Attributes
}

export interface Span {
  readonly spanId: string
  /** Absent on the root, and only there. */
  readonly parentId: string | undefined
  readonly name: string
  readonly type: SpanType
  /** Unix nanoseconds. */
  readonly start: bigint
  readonly end: bigint
  readonly status: SpanStatus
  /** `undefined` means not recorded, and is encoded as no attribute at all. */
  readonly inputs: unknown
  readonly outputs: unknown
  /** What the provider reported, and only that. Absent is not zero. */
  readonly usage: TokenUsage | undefined
  readonly attributes: Attributes
  readonly events: readonly SpanEvent[]
}

export interface Trace {
  readonly traceId: string
  /** The root first, then every other span in the order it began. */
  readonly spans: readonly Span[]
}
```

- [ ] **Step 2: Write the test support and the failing builder tests**

`tests/support/trace.ts`:

```ts
import type { TraceIds } from '../../src/trace/builder.js'
import type { Span, SpanType, Trace } from '../../src/trace/model.js'

/** Unix nanoseconds that advance one millisecond per reading, so every span has a length. */
export const fakeClock = (): (() => bigint) => {
  let now = 1_727_000_000_000_000_000n
  return () => (now += 1_000_000n)
}

/** One trace id, and span ids counted up from 1: the same tree on every run. */
export const fakeIds = (): TraceIds => {
  let span = 0
  return {
    traceId: () => '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: () => (span += 1).toString(16).padStart(16, '0'),
  }
}

/** A span's place in the tree and its verdict, without the bytes. What assertions compare. */
export interface Skeleton {
  readonly name: string
  readonly type: SpanType
  /** `OK`, or `ERROR: <message>`. */
  readonly status: string
  readonly children: readonly Skeleton[]
}

export function skeletonOf(trace: Trace): Skeleton {
  const children = new Map<string, Span[]>()
  for (const span of trace.spans) {
    if (span.parentId === undefined) continue
    children.set(span.parentId, [...(children.get(span.parentId) ?? []), span])
  }
  const build = (span: Span): Skeleton => ({
    name: span.name,
    type: span.type,
    status: span.status.code === 'OK' ? 'OK' : `ERROR: ${span.status.message}`,
    children: (children.get(span.spanId) ?? []).map(build),
  })
  const root = trace.spans[0]
  if (root === undefined) throw new Error('a trace with no span')
  return build(root)
}

/** The first span with this name — for reading its inputs, outputs, usage or events. */
export function spanNamed(trace: Trace, name: string): Span {
  const span = trace.spans.find((one) => one.name === name)
  if (span === undefined) {
    throw new Error(`no span named "${name}" among ${trace.spans.map((one) => one.name).join(', ')}`)
  }
  return span
}
```

`tests/unit/trace-builder.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../../src/agents/events.js'
import type { AgentName, GenerateRequest, GenerateResult } from '../../src/llm/client.js'
import { createTraceBuilder, type TraceBuilder } from '../../src/trace/builder.js'
import { fakeClock, fakeIds, skeletonOf, spanNamed } from '../support/trace.js'

const building = (): TraceBuilder =>
  createTraceBuilder({
    clock: fakeClock(),
    ids: fakeIds(),
    name: 'idp-agent plan',
    inputs: { command: 'plan', intent: 'give billing-api read access' },
    attributes: { 'idp.mode': 'scripted' },
  })

const request = (agent: AgentName): GenerateRequest => ({
  agent,
  system: 'system',
  transcript: [{ role: 'user', text: 'hello' }],
  tools: [],
  toolChoice: 'none',
})

const RESULT: GenerateResult = { text: 'QUESTION', toolCalls: [], finishReason: 'stop' }
const DONE = { outputs: { exitCode: 0 } }

const emitAll = (builder: TraceBuilder, events: readonly AgentEvent[]): void => {
  for (const event of events) builder.onEvent(event)
}

describe('the root', () => {
  it('is the command, with what it was asked and what it answered', () => {
    const trace = building().finish({ outputs: { exitCode: 3 }, attributes: { 'idp.exit_code': 3 } })
    const root = trace.spans[0]

    expect(trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(root?.parentId).toBeUndefined()
    expect(root?.name).toBe('idp-agent plan')
    expect(root?.type).toBe('CHAIN')
    expect(root?.inputs).toEqual({ command: 'plan', intent: 'give billing-api read access' })
    expect(root?.outputs).toEqual({ exitCode: 3 })
    expect(root?.attributes).toEqual({ 'idp.mode': 'scripted', 'idp.exit_code': 3 })
    expect(root?.status).toEqual({ code: 'OK' })
  })

  it('fails when the run threw, with the message', () => {
    const trace = building().finish({ outputs: { exitCode: 1 }, error: 'recording needs a configured model' })
    expect(trace.spans[0]?.status).toEqual({ code: 'ERROR', message: 'recording needs a configured model' })
  })
})

describe('agents, model calls and tools', () => {
  it('nests an agent’s model calls and tools inside it', () => {
    const builder = building()
    builder.onEvent({ type: 'agent:start', agent: 'analyst' })
    builder.modelCallEnded(builder.modelCallStarted(request('analyst')), { result: RESULT })
    builder.onEvent({ type: 'tool:call', id: 'c1', name: 'search_entities', args: { env: 'prod' } })
    builder.onEvent({ type: 'tool:result', id: 'c1', name: 'search_entities', rows: 3, truncated: 1 })
    builder.onEvent({ type: 'agent:end', agent: 'analyst', threw: false })
    const trace = builder.finish(DONE)

    expect(skeletonOf(trace)).toEqual({
      name: 'idp-agent plan',
      type: 'CHAIN',
      status: 'OK',
      children: [
        {
          name: 'analyst',
          type: 'AGENT',
          status: 'OK',
          children: [
            { name: 'analyst call 0', type: 'CHAT_MODEL', status: 'OK', children: [] },
            { name: 'search_entities', type: 'TOOL', status: 'OK', children: [] },
          ],
        },
      ],
    })
    expect(spanNamed(trace, 'search_entities').inputs).toEqual({
      id: 'c1',
      name: 'search_entities',
      args: { env: 'prod' },
    })
    // Truncation is stated in the trace as on stderr: never silent.
    expect(spanNamed(trace, 'search_entities').outputs).toEqual({ rows: 3, truncated: 1 })
  })

  it('records what the model was sent and what it answered', () => {
    const builder = building()
    builder.modelCallEnded(builder.modelCallStarted(request('supervisor')), { result: RESULT })
    const call = spanNamed(builder.finish(DONE), 'supervisor call 0')

    expect(call.inputs).toEqual({
      system: 'system',
      transcript: [{ role: 'user', text: 'hello' }],
      tools: [],
      toolChoice: 'none',
    })
    expect(call.outputs).toEqual({ text: 'QUESTION', toolCalls: [], finishReason: 'stop' })
  })

  it('names the tools a model was offered, never their schemas', () => {
    const builder = building()
    const offered: GenerateRequest = {
      ...request('analyst'),
      tools: [
        { name: 'search_entities', description: 'find entities', parameters: z.object({ env: z.string() }) },
      ],
    }
    builder.modelCallEnded(builder.modelCallStarted(offered), { result: RESULT })

    expect(spanNamed(builder.finish(DONE), 'analyst call 0').inputs).toMatchObject({
      tools: [{ name: 'search_entities', description: 'find entities' }],
    })
  })

  it('numbers each agent’s model calls on their own', () => {
    const builder = building()
    for (const agent of ['supervisor', 'supervisor', 'analyst'] as const) {
      builder.modelCallEnded(builder.modelCallStarted(request(agent)), { result: RESULT })
    }
    expect(builder.finish(DONE).spans.map((span) => span.name)).toEqual([
      'idp-agent plan',
      'supervisor call 0',
      'supervisor call 1',
      'analyst call 0',
    ])
  })

  it('keeps the usage a provider reported, and says so when it reported none', () => {
    const builder = building()
    builder.modelCallEnded(builder.modelCallStarted(request('architect')), {
      result: { ...RESULT, usage: { inputTokens: 900, outputTokens: 40 } },
    })
    builder.modelCallEnded(builder.modelCallStarted(request('architect')), { result: RESULT })
    const trace = builder.finish(DONE)

    expect(spanNamed(trace, 'architect call 0').usage).toEqual({ inputTokens: 900, outputTokens: 40 })
    expect(spanNamed(trace, 'architect call 0').attributes).toEqual({})
    // Absent is not zero: a recording made before usage was stored has none.
    expect(spanNamed(trace, 'architect call 1').usage).toBeUndefined()
    expect(spanNamed(trace, 'architect call 1').attributes).toEqual({ 'idp.usage': 'absent' })
  })

  it('closes a model call that failed as an error, with what the provider said', () => {
    const builder = building()
    builder.modelCallEnded(builder.modelCallStarted(request('reviewer')), {
      error: new Error('502 from the gateway'),
    })
    expect(spanNamed(builder.finish(DONE), 'reviewer call 0').status).toEqual({
      code: 'ERROR',
      message: '502 from the gateway',
    })
  })
})

describe('an agent’s outcome', () => {
  it('fails an agent that refused, and keeps the refusal as an event on it', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'architect' },
      { type: 'refused', agent: 'architect', reason: 'the draft ended with no proposal' },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])
    const trace = builder.finish(DONE)

    expect(spanNamed(trace, 'architect').status).toEqual({
      code: 'ERROR',
      message: 'the draft ended with no proposal',
    })
    expect(spanNamed(trace, 'architect').events.map((event) => [event.name, event.attributes])).toEqual([
      ['refused', { agent: 'architect', reason: 'the draft ended with no proposal' }],
    ])
  })

  it('fails an agent that threw', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'reviewer' },
      { type: 'agent:end', agent: 'reviewer', threw: true },
    ])
    expect(spanNamed(builder.finish(DONE), 'reviewer').status).toEqual({
      code: 'ERROR',
      message: 'the agent threw',
    })
  })

  it('keeps what happened inside an agent as events on it, in order, without failing it', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'architect' },
      { type: 'retry', agent: 'architect', reason: 'spec.owner: invalid' },
      { type: 'plan:ready', operations: 2 },
      {
        type: 'derived',
        path: 'operations.0.entity.spec.owner',
        owner: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
      {
        type: 'overridden',
        path: 'operations.1.entity.spec.owner',
        owner: 'group:default/lion',
        determined: 'group:default/tiger',
        from: ['component:default/billing-api'],
      },
      { type: 'ask', question: { path: 'operations.0.entity.metadata.env', question: 'which environment?' } },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])
    const architect = spanNamed(builder.finish(DONE), 'architect')

    // A retry is a correction inside the agent, not its outcome.
    expect(architect.status).toEqual({ code: 'OK' })
    expect(architect.events.map((event) => [event.name, event.attributes])).toEqual([
      ['retry', { agent: 'architect', reason: 'spec.owner: invalid' }],
      ['plan:ready', { operations: 2 }],
      [
        'derived',
        { path: 'operations.0.entity.spec.owner', owner: 'group:default/tiger', from: 'component:default/billing-api' },
      ],
      [
        'overridden',
        {
          path: 'operations.1.entity.spec.owner',
          owner: 'group:default/lion',
          determined: 'group:default/tiger',
          from: 'component:default/billing-api',
        },
      ],
      ['ask', { path: 'operations.0.entity.metadata.env', question: 'which environment?' }],
    ])
  })

  it('keeps a classification and an answer on the agent that gave them', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'supervisor' },
      { type: 'classified', classification: 'QUESTION' },
      { type: 'agent:end', agent: 'supervisor', threw: false },
      { type: 'agent:start', agent: 'analyst' },
      { type: 'answer:ready', outcome: 'entities', refs: ['resource:default/a', 'resource:default/b'] },
      { type: 'agent:end', agent: 'analyst', threw: false },
    ])
    const trace = builder.finish(DONE)

    expect(spanNamed(trace, 'supervisor').events.map((event) => [event.name, event.attributes])).toEqual([
      ['classified', { classification: 'QUESTION' }],
    ])
    expect(spanNamed(trace, 'analyst').events.map((event) => [event.name, event.attributes])).toEqual([
      ['answer:ready', { outcome: 'entities', refs: 'resource:default/a, resource:default/b' }],
    ])
  })
})

describe('the repair loop', () => {
  it('puts each attempt’s gates under it, and fails the attempt a gate refused', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'attempt:start', attempt: 1 },
      { type: 'gate:passed', attempt: 1, gate: 'zod' },
      { type: 'gate:passed', attempt: 1, gate: 'signature' },
      { type: 'repair', attempt: 1, gate: 'policy', reason: 'environment-mismatch at operations.0' },
      { type: 'attempt:end', attempt: 1 },
      { type: 'attempt:start', attempt: 2 },
      { type: 'gate:passed', attempt: 2, gate: 'zod' },
      { type: 'attempt:end', attempt: 2 },
    ])

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'attempt 1',
        type: 'CHAIN',
        status: 'ERROR: refused at the policy gate',
        children: [
          { name: 'gate zod', type: 'CHAIN', status: 'OK', children: [] },
          { name: 'gate signature', type: 'CHAIN', status: 'OK', children: [] },
          {
            name: 'gate policy',
            type: 'CHAIN',
            status: 'ERROR: environment-mismatch at operations.0',
            children: [],
          },
        ],
      },
      {
        name: 'attempt 2',
        type: 'CHAIN',
        status: 'OK',
        children: [{ name: 'gate zod', type: 'CHAIN', status: 'OK', children: [] }],
      },
    ])
  })

  it('puts the agents an attempt ran inside it, beside its gates', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'attempt:start', attempt: 1 },
      { type: 'agent:start', agent: 'architect' },
      { type: 'agent:end', agent: 'architect', threw: false },
      { type: 'gate:passed', attempt: 1, gate: 'zod' },
      { type: 'agent:start', agent: 'reviewer' },
      { type: 'agent:end', agent: 'reviewer', threw: false },
      { type: 'gate:passed', attempt: 1, gate: 'reviewer' },
      { type: 'attempt:end', attempt: 1 },
    ])

    expect(skeletonOf(builder.finish(DONE)).children[0]?.children.map((child) => child.name)).toEqual([
      'architect',
      'gate zod',
      'reviewer',
      'gate reviewer',
    ])
  })
})

describe('an event that fits nowhere', () => {
  it('is reported as an unbalanced event, never thrown and never dropped', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:end', agent: 'reviewer', threw: false },
      { type: 'tool:result', id: 'c9', name: 'read_file', rows: 1, truncated: 0 },
      { type: 'attempt:end', attempt: 2 },
    ])
    builder.modelCallEnded('model:reviewer:7', { result: RESULT })

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: agent:end matched no open agent reviewer',
        children: [],
      },
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: tool:result matched no open tool call c9',
        children: [],
      },
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: attempt:end matched no open attempt 2',
        children: [],
      },
      {
        name: 'unbalanced event',
        type: 'CHAIN',
        status: 'ERROR: model call end matched no open model:reviewer:7',
        children: [],
      },
    ])
  })

  it('closes what an agent left open when the agent ends, as an error that says so', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'architect' },
      { type: 'tool:call', id: 'c1', name: 'read_file', args: {} },
      { type: 'agent:end', agent: 'architect', threw: false },
    ])

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'architect',
        type: 'AGENT',
        status: 'OK',
        children: [
          {
            name: 'read_file',
            type: 'TOOL',
            status: 'ERROR: closed when agent:architect ended, by no event of its own',
            children: [],
          },
        ],
      },
    ])
  })

  it('closes what nothing closed at finish, as an error that says so', () => {
    const builder = building()
    emitAll(builder, [
      { type: 'agent:start', agent: 'inspector' },
      { type: 'tool:call', id: 'c1', name: 'read_file', args: {} },
    ])

    expect(skeletonOf(builder.finish(DONE)).children).toEqual([
      {
        name: 'inspector',
        type: 'AGENT',
        status: 'ERROR: closed by finish, by no event of its own',
        children: [
          {
            name: 'read_file',
            type: 'TOOL',
            status: 'ERROR: closed by finish, by no event of its own',
            children: [],
          },
        ],
      },
    ])
  })
})

describe('finish', () => {
  it('hands back the same trace twice, and ignores what arrives after it', () => {
    const builder = building()
    const first = builder.finish(DONE)

    builder.onEvent({ type: 'agent:start', agent: 'analyst' })
    builder.modelCallEnded(builder.modelCallStarted(request('analyst')), { result: RESULT })

    expect(builder.finish({ outputs: { exitCode: 1 } })).toBe(first)
    expect(first.spans).toHaveLength(1)
  })

  it('lists the root first, then every span in the order it began', () => {
    const builder = building()
    emitAll(builder, [{ type: 'agent:start', agent: 'supervisor' }])
    builder.modelCallEnded(builder.modelCallStarted(request('supervisor')), { result: RESULT })
    emitAll(builder, [
      { type: 'agent:end', agent: 'supervisor', threw: false },
      { type: 'attempt:start', attempt: 1 },
      { type: 'gate:passed', attempt: 1, gate: 'zod' },
      { type: 'attempt:end', attempt: 1 },
    ])
    const spans = builder.finish(DONE).spans

    expect(spans.map((span) => span.name)).toEqual([
      'idp-agent plan',
      'supervisor',
      'supervisor call 0',
      'attempt 1',
      'gate zod',
    ])
    const starts = spans.map((span) => span.start)
    expect(starts).toEqual([...starts].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run tests/unit/trace-builder.test.ts`
Expected: FAIL — cannot load `../../src/trace/builder.js`.

- [ ] **Step 4: Implement the builder**

`src/trace/builder.ts`:

```ts
import type { AgentEvent } from '../agents/events.js'
import type { GenerateRequest, GenerateResult, TokenUsage } from '../llm/client.js'
import type {
  AttributeValue,
  Attributes,
  Span,
  SpanEvent,
  SpanStatus,
  SpanType,
  Trace,
} from './model.js'

/**
 * Folds one run into a span tree: the `AgentEvent` stream, plus each model
 * call as `traced` reports it (ADR-0009).
 *
 * Nothing is guessed. A span is closed by the event that ends it; one that
 * nothing closed is closed at `finish` as an error that says so, and an event
 * that fits no open span becomes an `unbalanced event` span — never a throw,
 * which would take the run down with the trace, and never a silent drop.
 * tests/invariants/trace.test.ts holds that over any sequence of events.
 */

export interface TraceIds {
  /** 32 lowercase hex characters. */
  traceId(): string
  /** 16 lowercase hex characters. */
  spanId(): string
}

export interface RunOutcome {
  readonly outputs: unknown
  /** The message, when the run threw. The root then closes as an error. */
  readonly error?: string
  readonly attributes?: Attributes
}

export type ModelCallOutcome = { readonly result: GenerateResult } | { readonly error: unknown }

export interface TraceBuilder {
  readonly traceId: string
  onEvent(event: AgentEvent): void
  /** Opens a CHAT_MODEL span and returns the handle that closes it. */
  modelCallStarted(request: GenerateRequest): string
  modelCallEnded(handle: string, outcome: ModelCallOutcome): void
  /** Idempotent: a second call returns the trace the first one built. */
  finish(outcome: RunOutcome): Trace
}

interface Open {
  readonly spanId: string
  readonly parentId: string | undefined
  readonly name: string
  readonly type: SpanType
  readonly start: bigint
  /** What closes it: `agent:<name>`, `attempt:<n>`, `tool:<id>`, `model:<agent>:<n>`. */
  readonly key: string
  readonly order: number
  inputs: unknown
  outputs: unknown
  usage: TokenUsage | undefined
  readonly attributes: Record<string, AttributeValue>
  readonly events: SpanEvent[]
  /** Set by the event that makes this span a failure: a refusal, a refused gate. */
  failure: string | undefined
}

const OK: SpanStatus = { code: 'OK' }
const failed = (message: string): SpanStatus => ({ code: 'ERROR', message })
const messageOf = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown)

export function createTraceBuilder(options: {
  clock: () => bigint
  ids: TraceIds
  name: string
  inputs: unknown
  attributes?: Attributes
}): TraceBuilder {
  const traceId = options.ids.traceId()
  const closed: Span[] = []
  const orders = new Map<string, number>()
  const calls = new Map<string, number>()
  let order = 0
  let finished: Trace | undefined

  const open = (
    parent: Open | undefined,
    name: string,
    type: SpanType,
    key: string,
    inputs?: unknown,
  ): Open => ({
    spanId: options.ids.spanId(),
    parentId: parent?.spanId,
    name,
    type,
    key,
    start: options.clock(),
    order: order++,
    inputs,
    outputs: undefined,
    usage: undefined,
    attributes: {},
    events: [],
    failure: undefined,
  })

  const root = open(undefined, options.name, 'CHAIN', 'root', options.inputs)
  Object.assign(root.attributes, options.attributes ?? {})
  const stack: Open[] = [root]

  const top = (): Open => stack[stack.length - 1] ?? root

  const close = (span: Open, status: SpanStatus): void => {
    orders.set(span.spanId, span.order)
    closed.push({
      spanId: span.spanId,
      parentId: span.parentId,
      name: span.name,
      type: span.type,
      start: span.start,
      end: options.clock(),
      status,
      inputs: span.inputs,
      outputs: span.outputs,
      usage: span.usage,
      attributes: { ...span.attributes },
      events: [...span.events],
    })
  }

  const statusOf = (span: Open): SpanStatus =>
    span.failure === undefined ? OK : failed(span.failure)

  const find = (key: string): Open | undefined => {
    for (let index = stack.length - 1; index >= 1; index -= 1) {
      const span = stack[index]
      if (span?.key === key) return span
    }
    return undefined
  }

  /** Closes the span `key` names, and first everything opened inside it that is still open. */
  const closeTo = (key: string, status: (span: Open) => SpanStatus = statusOf): boolean => {
    const target = find(key)
    if (target === undefined) return false
    while (top() !== target) {
      const inner = stack.pop()
      if (inner !== undefined) close(inner, failed(`closed when ${key} ended, by no event of its own`))
    }
    stack.pop()
    close(target, status(target))
    return true
  }

  /** A span with no duration of its own: a gate's verdict, or an event that fitted nowhere. */
  const marker = (name: string, status: SpanStatus, attributes: Attributes = {}): void => {
    const span = open(top(), name, 'CHAIN', 'marker')
    Object.assign(span.attributes, attributes)
    close(span, status)
  }

  const unbalanced = (what: string, expected: string): void =>
    marker('unbalanced event', failed(`${what} matched no open ${expected}`), { 'idp.event': what })

  const note = (name: string, attributes: Attributes): void => {
    top().events.push({ name, time: options.clock(), attributes })
  }

  /** The first failure stands: a later one on the same span does not overwrite why it failed. */
  const fail = (key: string, message: string): void => {
    const span = find(key)
    if (span !== undefined && span.failure === undefined) span.failure = message
  }

  const onEvent = (event: AgentEvent): void => {
    // After `finish` the trace has been handed over; there is no span left to
    // put anything under.
    if (finished !== undefined) return
    switch (event.type) {
      case 'agent:start':
        stack.push(open(top(), event.agent, 'AGENT', `agent:${event.agent}`))
        return
      case 'agent:end': {
        const threw = event.threw
        const ended = closeTo(`agent:${event.agent}`, (span) =>
          span.failure === undefined && threw ? failed('the agent threw') : statusOf(span),
        )
        if (!ended) unbalanced('agent:end', `agent ${event.agent}`)
        return
      }
      case 'attempt:start':
        stack.push(open(top(), `attempt ${event.attempt}`, 'CHAIN', `attempt:${event.attempt}`))
        return
      case 'attempt:end':
        if (!closeTo(`attempt:${event.attempt}`)) unbalanced('attempt:end', `attempt ${event.attempt}`)
        return
      case 'tool:call':
        stack.push(
          open(top(), event.name, 'TOOL', `tool:${event.id}`, {
            id: event.id,
            name: event.name,
            args: event.args,
          }),
        )
        return
      case 'tool:result': {
        const span = find(`tool:${event.id}`)
        if (span === undefined) {
          unbalanced('tool:result', `tool call ${event.id}`)
          return
        }
        span.outputs = { rows: event.rows, truncated: event.truncated }
        closeTo(span.key)
        return
      }
      case 'gate:passed':
        marker(`gate ${event.gate}`, OK, { 'idp.attempt': event.attempt })
        return
      case 'repair':
        marker(`gate ${event.gate}`, failed(event.reason), { 'idp.attempt': event.attempt })
        fail(`attempt:${event.attempt}`, `refused at the ${event.gate} gate`)
        return
      case 'refused':
        note('refused', { agent: event.agent, reason: event.reason })
        fail(`agent:${event.agent}`, event.reason)
        return
      case 'retry':
        note('retry', { agent: event.agent, reason: event.reason })
        return
      case 'classified':
        note('classified', { classification: event.classification })
        return
      case 'answer:ready':
        note('answer:ready', { outcome: event.outcome, refs: event.refs.join(', ') })
        return
      case 'plan:ready':
        note('plan:ready', { operations: event.operations })
        return
      case 'derived':
        note('derived', { path: event.path, owner: event.owner, from: event.from.join(', ') })
        return
      case 'overridden':
        note('overridden', {
          path: event.path,
          owner: event.owner,
          determined: event.determined,
          from: event.from.join(', '),
        })
        return
      case 'ask':
        note('ask', { path: event.question.path, question: event.question.question })
        return
      default: {
        // A new event with no span is a compile error rather than a silent gap.
        const exhaustive: never = event
        return exhaustive
      }
    }
  }

  const modelCallStarted = (request: GenerateRequest): string => {
    const index = calls.get(request.agent) ?? 0
    calls.set(request.agent, index + 1)
    const key = `model:${request.agent}:${index}`
    if (finished !== undefined) return key
    stack.push(
      open(top(), `${request.agent} call ${index}`, 'CHAT_MODEL', key, {
        system: request.system,
        transcript: request.transcript,
        // Named, never serialised: a tool's Zod schema is code, and what the
        // model was offered is its name and what it was told the tool does.
        tools: request.tools.map((spec) => ({ name: spec.name, description: spec.description })),
        toolChoice: request.toolChoice,
      }),
    )
    return key
  }

  const modelCallEnded = (handle: string, outcome: ModelCallOutcome): void => {
    if (finished !== undefined) return
    const span = find(handle)
    if (span === undefined) {
      unbalanced('model call end', handle)
      return
    }
    if ('error' in outcome) {
      const message = messageOf(outcome.error)
      closeTo(handle, () => failed(message))
      return
    }
    const { text, toolCalls, finishReason, usage } = outcome.result
    span.outputs = { text, toolCalls, finishReason }
    span.usage = usage
    // Absent is not zero, and a reader of the trace must not have to know that
    // a missing attribute means "not reported" rather than "nothing spent".
    if (usage === undefined) span.attributes['idp.usage'] = 'absent'
    closeTo(handle)
  }

  const finish = (outcome: RunOutcome): Trace => {
    if (finished !== undefined) return finished
    while (stack.length > 1) {
      const span = stack.pop()
      if (span !== undefined) close(span, failed('closed by finish, by no event of its own'))
    }
    root.outputs = outcome.outputs
    Object.assign(root.attributes, outcome.attributes ?? {})
    close(root, outcome.error === undefined ? OK : failed(outcome.error))
    const spans = [...closed].sort(
      (left, right) => (orders.get(left.spanId) ?? 0) - (orders.get(right.spanId) ?? 0),
    )
    finished = { traceId, spans }
    return finished
  }

  return { traceId, onEvent, modelCallStarted, modelCallEnded, finish }
}
```

- [ ] **Step 5: Run the builder tests to see them pass**

Run: `pnpm vitest run tests/unit/trace-builder.test.ts && pnpm typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 6: Write the property test**

`tests/invariants/trace.test.ts`:

```ts
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import type { Gate } from '../../src/agents/repair.js'
import type { Answer } from '../../src/core/schemas/query.js'
import type { AgentName, GenerateRequest, GenerateResult } from '../../src/llm/client.js'
import { createTraceBuilder } from '../../src/trace/builder.js'
import { fakeClock, fakeIds } from '../support/trace.js'

const agent = fc.constantFrom<AgentName>('supervisor', 'analyst', 'inspector', 'architect', 'reviewer')
const attempt = fc.constantFrom<1 | 2 | 3>(1, 2, 3)
const gate = fc.constantFrom<Gate>('zod', 'signature', 'policy', 'reviewer', 'recheck')
const id = fc.constantFrom('c1', 'c2', 'c3')
const words = fc.string({ maxLength: 12 })

/** Every member of the union, in any order — including every order no agent would produce. */
const event: fc.Arbitrary<AgentEvent> = fc.oneof(
  fc.record({ type: fc.constant('agent:start' as const), agent }),
  fc.record({ type: fc.constant('agent:end' as const), agent, threw: fc.boolean() }),
  fc.record({ type: fc.constant('attempt:start' as const), attempt }),
  fc.record({ type: fc.constant('attempt:end' as const), attempt }),
  fc.record({ type: fc.constant('gate:passed' as const), attempt, gate }),
  fc.record({ type: fc.constant('repair' as const), attempt, gate, reason: words }),
  fc.record({ type: fc.constant('tool:call' as const), id, name: words, args: fc.jsonValue() }),
  fc.record({
    type: fc.constant('tool:result' as const),
    id,
    name: words,
    rows: fc.nat(),
    truncated: fc.nat(),
  }),
  fc.record({
    type: fc.constant('classified' as const),
    classification: fc.constantFrom<'MUTATION' | 'QUESTION'>('MUTATION', 'QUESTION'),
  }),
  fc.record({ type: fc.constant('refused' as const), agent, reason: words }),
  fc.record({ type: fc.constant('retry' as const), agent, reason: words }),
  fc.record({ type: fc.constant('plan:ready' as const), operations: fc.nat() }),
  fc.record({
    type: fc.constant('answer:ready' as const),
    outcome: fc.constantFrom<Answer['outcome']>('entities', 'nothing', 'overview', 'unanswerable'),
    refs: fc.array(words, { maxLength: 3 }),
  }),
  fc.record({
    type: fc.constant('derived' as const),
    path: words,
    owner: words,
    from: fc.array(words, { maxLength: 3 }),
  }),
  fc.record({
    type: fc.constant('overridden' as const),
    path: words,
    owner: words,
    determined: words,
    from: fc.array(words, { maxLength: 3 }),
  }),
  fc.record({ type: fc.constant('ask' as const), question: fc.record({ path: words, question: words }) }),
)

type Step =
  | { readonly kind: 'event'; readonly event: AgentEvent }
  | { readonly kind: 'call'; readonly agent: AgentName }
  | { readonly kind: 'return'; readonly which: number; readonly fails: boolean }

const step: fc.Arbitrary<Step> = fc.oneof(
  event.map((one) => ({ kind: 'event' as const, event: one })),
  agent.map((one) => ({ kind: 'call' as const, agent: one })),
  fc.record({ kind: fc.constant('return' as const), which: fc.nat(), fails: fc.boolean() }),
)

const request = (who: AgentName): GenerateRequest => ({
  agent: who,
  system: 's',
  transcript: [],
  tools: [],
  toolChoice: 'none',
})
const RESULT: GenerateResult = { text: '', toolCalls: [], finishReason: 'stop' }

describe('the trace builder, over any sequence of events', () => {
  it('never throws, and always hands back one closed tree with every parent in it', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 80 }), fc.boolean(), (steps, threw) => {
        const builder = createTraceBuilder({
          clock: fakeClock(),
          ids: fakeIds(),
          name: 'idp-agent plan',
          inputs: {},
        })
        const handles: string[] = []
        for (const one of steps) {
          if (one.kind === 'event') builder.onEvent(one.event)
          else if (one.kind === 'call') handles.push(builder.modelCallStarted(request(one.agent)))
          else {
            // A handle already closed, or none at all, is as legal an input as a live one.
            const handle = handles[one.which % Math.max(handles.length, 1)] ?? 'model:none:0'
            builder.modelCallEnded(handle, one.fails ? { error: new Error('boom') } : { result: RESULT })
          }
        }
        const trace = builder.finish(threw ? { outputs: {}, error: 'boom' } : { outputs: {} })

        const byId = new Map(trace.spans.map((span) => [span.spanId, span]))
        expect(byId.size).toBe(trace.spans.length)
        expect(trace.spans[0]?.parentId).toBeUndefined()
        expect(trace.spans.filter((span) => span.parentId === undefined)).toHaveLength(1)
        for (const span of trace.spans) {
          expect(span.end >= span.start).toBe(true)
          if (span.parentId === undefined) continue
          const parent = byId.get(span.parentId)
          expect(parent).toBeDefined()
          expect((parent?.start ?? span.start + 1n) <= span.start).toBe(true)
        }
      }),
    )
  })
})
```

Run: `pnpm vitest run tests/invariants/trace.test.ts`
Expected: PASS. If fast-check reports a counterexample, it is a builder defect: fix `builder.ts`, never the property.

- [ ] **Step 7: Write the failing decorator test**

`tests/unit/trace-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { createTraceBuilder } from '../../src/trace/builder.js'
import { traced } from '../../src/trace/client.js'
import { fakeClock, fakeIds, skeletonOf, spanNamed } from '../support/trace.js'

const REQUEST: GenerateRequest = {
  agent: 'supervisor',
  system: 'system',
  transcript: [{ role: 'user', text: 'hello' }],
  tools: [],
  toolChoice: 'none',
}

const building = () =>
  createTraceBuilder({ clock: fakeClock(), ids: fakeIds(), name: 'idp-agent ask', inputs: {} })

describe('traced', () => {
  it('hands the inner client the request it was given, and returns its result untouched', async () => {
    const result: GenerateResult = {
      text: 'QUESTION',
      toolCalls: [],
      finishReason: 'stop',
      usage: { totalTokens: 7 },
    }
    const seen: GenerateRequest[] = []
    const inner: LlmClient = {
      generate: async (request) => {
        seen.push(request)
        return result
      },
    }
    const builder = building()

    expect(await traced(inner, builder).generate(REQUEST)).toBe(result)
    expect(seen[0]).toBe(REQUEST)
    const call = spanNamed(builder.finish({ outputs: {} }), 'supervisor call 0')
    expect(call.status).toEqual({ code: 'OK' })
    expect(call.usage).toEqual({ totalTokens: 7 })
  })

  it('rethrows the very error the inner client threw, after closing the call as failed', async () => {
    const thrown = new Error('502 from the gateway')
    const inner: LlmClient = { generate: () => Promise.reject(thrown) }
    const builder = building()

    await expect(traced(inner, builder).generate(REQUEST)).rejects.toBe(thrown)
    expect(skeletonOf(builder.finish({ outputs: {} })).children).toEqual([
      {
        name: 'supervisor call 0',
        type: 'CHAT_MODEL',
        status: 'ERROR: 502 from the gateway',
        children: [],
      },
    ])
  })
})
```

Run: `pnpm vitest run tests/unit/trace-client.test.ts`
Expected: FAIL — cannot load `../../src/trace/client.js`.

- [ ] **Step 8: Implement the decorator**

`src/trace/client.ts`:

```ts
import type { GenerateRequest, GenerateResult, LlmClient } from '../llm/client.js'
import type { TraceBuilder } from './builder.js'

/**
 * The same client, reporting each call to a trace.
 *
 * It relays and never decides: the request goes through as it came, the
 * result comes back as it went, and a failure is recorded and then rethrown
 * as the very same error. Wrapping whichever client the session opened — live,
 * recorded, replayed or scripted — is what makes a replayed run traced like a
 * live one.
 */
export function traced(
  client: LlmClient,
  builder: Pick<TraceBuilder, 'modelCallStarted' | 'modelCallEnded'>,
): LlmClient {
  return {
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const handle = builder.modelCallStarted(request)
      let result: GenerateResult
      try {
        result = await client.generate(request)
      } catch (thrown) {
        builder.modelCallEnded(handle, { error: thrown })
        throw thrown
      }
      builder.modelCallEnded(handle, { result })
      return result
    },
  }
}
```

Run: `pnpm vitest run tests/unit/trace-client.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the contract trace and the failing encoder tests**

`tests/contract/otlp/contract-trace.ts`:

```ts
import type { Span, Trace } from '../../../src/trace/model.js'

/**
 * The trace behind accepted.json: every span type this project emits, both
 * statuses, span events, a model call with usage and one without — the cases
 * MLflow could read differently. scripts/mlflow-contract.mjs sent its encoding
 * to MLflow 3.16.1 and read every span back as sent.
 */
const T0 = 1_727_000_000_000_000_000n
const at = (ms: number): bigint => T0 + BigInt(ms) * 1_000_000n

const span = (
  fields: Pick<Span, 'spanId' | 'parentId' | 'name' | 'type' | 'start' | 'end'> & Partial<Span>,
): Span => ({
  inputs: undefined,
  outputs: undefined,
  usage: undefined,
  attributes: {},
  events: [],
  status: { code: 'OK' },
  ...fields,
})

export const CONTRACT_TRACE: Trace = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spans: [
    span({
      spanId: '0000000000000001',
      parentId: undefined,
      name: 'idp-agent ask',
      type: 'CHAIN',
      start: at(0),
      end: at(90),
      inputs: { command: 'ask', intent: 'which databases are in prod?' },
      outputs: { exitCode: 0, text: 'billing-db-prod' },
      attributes: { 'idp.mode': 'replay', 'idp.exit_code': 0 },
    }),
    span({
      spanId: '0000000000000002',
      parentId: '0000000000000001',
      name: 'supervisor',
      type: 'AGENT',
      start: at(1),
      end: at(20),
      events: [{ name: 'classified', time: at(19), attributes: { classification: 'QUESTION' } }],
    }),
    span({
      spanId: '0000000000000003',
      parentId: '0000000000000002',
      name: 'supervisor call 0',
      type: 'CHAT_MODEL',
      start: at(2),
      end: at(18),
      inputs: {
        system: 'You classify a request.',
        transcript: [{ role: 'user', text: 'request: which databases are in prod?' }],
        tools: [],
        toolChoice: 'none',
      },
      outputs: { text: 'QUESTION', toolCalls: [], finishReason: 'stop' },
      usage: { inputTokens: 120, outputTokens: 3, totalTokens: 123 },
    }),
    span({
      spanId: '0000000000000004',
      parentId: '0000000000000001',
      name: 'analyst',
      type: 'AGENT',
      start: at(21),
      end: at(80),
      events: [
        { name: 'retry', time: at(50), attributes: { agent: 'analyst', reason: 'answer: invalid outcome' } },
      ],
    }),
    span({
      spanId: '0000000000000006',
      parentId: '0000000000000004',
      name: 'analyst call 0',
      type: 'CHAT_MODEL',
      start: at(22),
      end: at(29),
      inputs: {
        system: 'You answer questions.',
        transcript: [{ role: 'user', text: 'question: which databases are in prod?' }],
        tools: [{ name: 'search_entities', description: 'find entities' }],
        toolChoice: 'auto',
      },
      outputs: {
        text: '',
        toolCalls: [{ id: 'c1', name: 'search_entities', args: { type: 'database', env: 'prod' } }],
        finishReason: 'tool-calls',
      },
      attributes: { 'idp.usage': 'absent' },
    }),
    span({
      spanId: '0000000000000005',
      parentId: '0000000000000004',
      name: 'search_entities',
      type: 'TOOL',
      start: at(30),
      end: at(31),
      inputs: { id: 'c1', name: 'search_entities', args: { type: 'database', env: 'prod' } },
      outputs: { rows: 1, truncated: 0 },
    }),
    span({
      spanId: '0000000000000007',
      parentId: '0000000000000001',
      name: 'attempt 1',
      type: 'CHAIN',
      start: at(81),
      end: at(89),
      status: { code: 'ERROR', message: 'refused at the policy gate' },
    }),
    span({
      spanId: '0000000000000008',
      parentId: '0000000000000007',
      name: 'gate zod',
      type: 'CHAIN',
      start: at(82),
      end: at(82),
      attributes: { 'idp.attempt': 1 },
    }),
    span({
      spanId: '0000000000000009',
      parentId: '0000000000000007',
      name: 'gate policy',
      type: 'CHAIN',
      start: at(83),
      end: at(83),
      attributes: { 'idp.attempt': 1 },
      status: { code: 'ERROR', message: 'environment-mismatch at operations.0' },
    }),
  ],
}
```

`tests/unit/trace-otlp.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Span, Trace } from '../../src/trace/model.js'
import { toOtlpJson } from '../../src/trace/otlp.js'
import { CONTRACT_TRACE } from '../contract/otlp/contract-trace.js'

const ACCEPTED = path.resolve(import.meta.dirname, '../contract/otlp/accepted.json')

/** The contract's root alone, with some of its fields replaced. */
const rootWith = (fields: Partial<Span>): Trace => ({
  traceId: CONTRACT_TRACE.traceId,
  spans: [{ ...(CONTRACT_TRACE.spans[0] as Span), ...fields }],
})

interface Attribute {
  key: string
  value: unknown
}
const attributesOf = (body: unknown): Attribute[] =>
  (body as { resourceSpans: { scopeSpans: { spans: { attributes: Attribute[] }[] }[] }[] })
    .resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes ?? []

describe('toOtlpJson', () => {
  it('encodes the contract trace exactly as the MLflow it pins accepted it', async () => {
    // accepted.json was read back span by span through MLflow 3.16.1's own
    // client (scripts/mlflow-contract.mjs). An encoder that drifts from it is
    // sending MLflow something nobody has seen it read.
    expect(toOtlpJson(CONTRACT_TRACE, { serviceVersion: '0.0.0-contract' })).toEqual(
      JSON.parse(await readFile(ACCEPTED, 'utf8')),
    )
  })

  it('writes nothing for what was not recorded, rather than a null', () => {
    const keys = attributesOf(
      toOtlpJson(rootWith({ inputs: undefined, outputs: undefined, attributes: {} }), {
        serviceVersion: 'x',
      }),
    ).map((attribute) => attribute.key)
    expect(keys).toEqual(['mlflow.spanType'])
  })

  it('writes only the token counts the provider reported', () => {
    const usage = attributesOf(
      toOtlpJson(rootWith({ usage: { outputTokens: 3 } }), { serviceVersion: 'x' }),
    ).find((attribute) => attribute.key === 'mlflow.chat.tokenUsage')
    expect(usage).toEqual({
      key: 'mlflow.chat.tokenUsage',
      value: { stringValue: '{"output_tokens":3}' },
    })
  })

  it('types the project’s own attributes, where MLflow’s carry JSON', () => {
    const attributes = attributesOf(
      toOtlpJson(
        rootWith({
          inputs: undefined,
          outputs: undefined,
          attributes: { 'idp.mode': 'live', 'idp.exit_code': 1, 'idp.ratio': 0.5, 'idp.flag': true },
        }),
        { serviceVersion: 'x' },
      ),
    )
    expect(attributes).toEqual([
      { key: 'mlflow.spanType', value: { stringValue: '"CHAIN"' } },
      { key: 'idp.mode', value: { stringValue: 'live' } },
      { key: 'idp.exit_code', value: { intValue: '1' } },
      { key: 'idp.ratio', value: { doubleValue: 0.5 } },
      { key: 'idp.flag', value: { boolValue: true } },
    ])
  })
})
```

Run: `pnpm vitest run tests/unit/trace-otlp.test.ts`
Expected: FAIL — cannot load `../../src/trace/otlp.js`.

- [ ] **Step 10: Implement the encoder**

`src/trace/otlp.ts`:

```ts
import type { TokenUsage } from '../llm/client.js'
import type { AttributeValue, Attributes, Span, Trace } from './model.js'

/**
 * A trace as the OTLP/JSON body MLflow's `/v1/traces` accepts.
 *
 * MLflow's own keys carry JSON strings — that is how MLflow writes them itself,
 * and `spanInputs`/`spanOutputs` have to be JSON anyway. The project's own
 * `idp.*` keys carry typed values. tests/contract/otlp/accepted.json is this
 * encoding of one trace, read back as sent by the MLflow this project pins.
 */

export interface OtlpResource {
  readonly serviceVersion: string
}

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }

interface OtlpAttribute {
  key: string
  value: OtlpValue
}

const attribute = (key: string, value: AttributeValue): OtlpAttribute => {
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  // int64 travels as a string in OTLP/JSON.
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } }
}

const mlflow = (key: string, value: unknown): OtlpAttribute => ({
  key,
  value: { stringValue: JSON.stringify(value) },
})

const attributesOf = (attributes: Attributes): OtlpAttribute[] =>
  Object.entries(attributes).map(([key, value]) => attribute(key, value))

/** MLflow's names for the counts, and only the counts the provider reported. */
const usageOf = (usage: TokenUsage): Record<string, number> => ({
  ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
  ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
  ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
})

const SPAN_KIND_INTERNAL = 1
const STATUS_OK = 1
const STATUS_ERROR = 2

function spanOf(traceId: string, span: Span): object {
  const { status } = span
  return {
    traceId,
    spanId: span.spanId,
    ...(span.parentId !== undefined ? { parentSpanId: span.parentId } : {}),
    name: span.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: String(span.start),
    endTimeUnixNano: String(span.end),
    attributes: [
      mlflow('mlflow.spanType', span.type),
      ...(span.inputs !== undefined ? [mlflow('mlflow.spanInputs', span.inputs)] : []),
      ...(span.outputs !== undefined ? [mlflow('mlflow.spanOutputs', span.outputs)] : []),
      ...(span.usage !== undefined ? [mlflow('mlflow.chat.tokenUsage', usageOf(span.usage))] : []),
      ...attributesOf(span.attributes),
    ],
    events: span.events.map((event) => ({
      timeUnixNano: String(event.time),
      name: event.name,
      attributes: attributesOf(event.attributes),
    })),
    status:
      status.code === 'OK'
        ? { code: STATUS_OK }
        : { code: STATUS_ERROR, message: status.message },
  }
}

export function toOtlpJson(trace: Trace, resource: OtlpResource): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute('service.name', 'idp-agent'),
            attribute('service.version', resource.serviceVersion),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'idp-agent', version: resource.serviceVersion },
            spans: trace.spans.map((span) => spanOf(trace.traceId, span)),
          },
        ],
      },
    ],
  }
}
```

Run: `pnpm vitest run tests/unit/trace-otlp.test.ts`
Expected: PASS, 4 tests. If the contract test fails, diff the two objects; the fixture is the reference, since it is what MLflow read back.

- [ ] **Step 11: Write the architecture rule, and prove it bites**

In `tests/architecture/dependencies.test.ts`, add this `it` as the last test inside `describe('architecture'`:

```ts
  it('trace/ reaches nothing but types, and only cli/ reaches it', async () => {
    // A trace is built from what the harness emits, and it leaves the process
    // through cli/, which owns every way out (ADR-0009). `fetch` needs no
    // import, so trace/'s source is read for the name too — the limit
    // SECURITY.md states for the rules above.
    const offending: string[] = []
    for (const file of await sourceFiles(path.join(SOURCE_ROOT, 'trace'))) {
      const name = path.relative(SOURCE_ROOT, file)
      const code = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      for (const match of code.matchAll(/^\s*(?:import|export)(\s+type)?\b[^'"]*['"]([^'"]+)['"]/gm)) {
        const typeOnly = match[1] !== undefined
        const specifier = match[2] ?? ''
        if (DISK.test(specifier) || NETWORK.test(specifier) || MODEL_SDK.test(specifier)) {
          offending.push(`${name} imports ${specifier}`)
        }
        if (/(^|\/)cli\//.test(specifier)) offending.push(`${name} imports ${specifier}`)
        if (/(^|\/)(agents|llm)\//.test(specifier) && !typeOnly) {
          offending.push(`${name} imports values from ${specifier}`)
        }
      }
      if (/\bfetch\b/.test(code)) offending.push(`${name} names fetch`)
    }
    for (const { file, specifier } of await importsUnder(SOURCE_ROOT)) {
      if (/(^|\/)trace\//.test(specifier) && !file.startsWith('cli/') && !file.startsWith('trace/')) {
        offending.push(`${file} imports ${specifier}`)
      }
    }
    expect(offending).toEqual([])
  })
```

Run: `pnpm vitest run tests/architecture`
Expected: PASS.

Now prove it is not vacuous. Temporarily add these two lines at the top of `src/trace/otlp.ts`:

```ts
import { asAgent } from '../agents/lifetime.js'
void [asAgent, fetch]
```

and this line at the top of `src/agents/supervisor.ts`:

```ts
import '../trace/otlp.js'
```

Run: `pnpm vitest run tests/architecture`
Expected: FAIL, with three offending entries: `trace/otlp.ts imports values from ../agents/lifetime.js`, `trace/otlp.ts names fetch`, `agents/supervisor.ts imports ../trace/otlp.js`.

Remove the three lines and run again: PASS. Check with `git diff src/trace/otlp.ts src/agents/supervisor.ts` that nothing of the probe is left.

- [ ] **Step 12: Write the ADR, the folder README, and the design and AGENTS.md changes**

`docs/adr/0009-tracing-renders-the-event-stream.md`:

```markdown
# ADR-0009 — a trace is one more reader of the event stream

**Date** 2026-09-24 · **Status** accepted

## Context

A failed run is debugged from one stderr line per event. That says which gate refused and
why; it does not say what the model was sent, what it answered, how long it took or what it
cost. MLflow shows all of that, given spans. The question is where the spans come from.

## Decision

A pure module, `src/trace/`, builds a trace from two things the harness already exposes:
the `AgentEvent` stream (design §6.2), and `LlmClient.generate`, wrapped by a decorator.
`cli/` owns the only ways a trace leaves the process — a `POST` of OTLP/JSON to MLflow's
`/v1/traces`, a file per run — and turns each on from the environment alone. Four events
were added so that a span is bounded by what happened rather than by whatever came next —
`agent:end`, `attempt:start`, `attempt:end`, `gate:passed` — and a tool call and its result
carry the model's call id.

## Rejected alternatives

**The AI SDK's `experimental_telemetry` with the OpenTelemetry Node SDK.** Model spans come
almost for free — but only when `generateText` runs, which it never does in replay, so a
recorded scenario could not be opened in MLflow. The attempts and the gates would still need
spans of their own, from `@opentelemetry/api` inside `agents/` or from the event stream:
this decision, with four or five dependencies and a global context added.

**The `mlflow-tracing` npm SDK.** MLflow-native, and the same event bridge for everything
that is not a model call, behind a global `init` and an exporter this project would not
control.

## Consequences

A replayed run is traced like a live one: the suite asserts the shape of a real trace
offline, and a recording can be read in MLflow with no key. `agents/` gained no import. The
cost is an encoder of our own, held to a contract: `tests/contract/otlp/accepted.json` was
read back through MLflow 3.16.1's client span by span, and `scripts/mlflow-contract.mjs`
repeats that whenever the pinned image moves. A trace carries full prompts, which makes a
tracking server one more place content goes; `SECURITY.md` says what, and it is never on by
default.
```

`src/trace/README.md`:

```markdown
# `trace/` — a run, as MLflow is handed it

One trace per agent-backed run: the command at the root, each agent, each model call with
what it was sent and what it answered, each tool call, and each attempt of the repair loop
with the gates it passed and the one that refused it (ADR-0009).

## What lives here

| file | what it is |
|---|---|
| `model.ts` | `Span`, `Trace` — plain data |
| `builder.ts` | `createTraceBuilder` — folds the `AgentEvent` stream and the model calls into a span tree |
| `client.ts` | `traced` — the `LlmClient` decorator that reports each call to the builder |
| `otlp.ts` | `toOtlpJson` — the OTLP/JSON body MLflow's `/v1/traces` accepts |

## What may not

Nothing here reaches the disk or the network, names `fetch`, imports the model SDK or
imports `cli/`; from `agents/` and `llm/` it imports types only, and only `cli/` imports it.
`cli/trace-sink.ts` owns both ways a trace leaves the process. The rule is
`tests/architecture/dependencies.test.ts`, *trace/ reaches nothing but types, and only cli/
reaches it*.

## Two rules the builder keeps

- **Nothing is guessed.** A span is closed by the event that ends it. One that nothing
  closed is closed at `finish` as an error that says so; an event that matches no open span
  becomes an `unbalanced event` span — never a throw and never a silent drop.
  `tests/invariants/trace.test.ts` holds that over any sequence of events.
- **Absent is not zero.** A model call whose provider reported no usage — every recording
  made before usage was stored — carries `idp.usage: absent`, not a count of 0.

## The contract

MLflow's own keys carry JSON strings, the project's `idp.*` keys typed values.
`tests/contract/otlp/accepted.json` is that encoding of one trace, read back span by span
through MLflow 3.16.1's client; `toOtlpJson` is tested against it, and
`pnpm mlflow:contract` re-checks it against a live server.
```

In `docs/design.md` §5.5, replace

```markdown
it; `scaffold/` imports `core/` and nothing else of ours, and exactly one module in it
writes; only `context/iac-fs` and `context/project-fs` read a user's repository. **Add a
rule when you add a layer** — the count in this paragraph is the one that drifts first.
```

with

```markdown
it; `scaffold/` imports `core/` and nothing else of ours, and exactly one module in it
writes; only `context/iac-fs` and `context/project-fs` read a user's repository; `trace/`
reaches nothing but types and never names `fetch`, and only `cli/` reaches it. **Add a
rule when you add a layer** — the count in this paragraph is the one that drifts first.
```

Then correct §5.5's opening sentence (`**thirteen** are enforced today`) and "The other eleven" to the measured count. Measure it with `pnpm vitest run tests/architecture --reporter=verbose`: count the `✓` lines; "the other N" is that count minus 2.

In `docs/design.md` §6.2, after the paragraph that ends `…the future MCP server reuses these events.`, add:

```markdown
MLflow reads the same stream (ADR-0009). `src/trace/` folds it, with each model call, into
a trace — which is why an agent's end, an attempt's bounds and every gate that passed are
events too: a span is closed by what happened, never by whatever came next. None of them
renders on stderr; they are structure, and the lines they bound already say what happened.
```

In `AGENTS.md` **Layering**, replace the diagram with:

```
cli/  ──→  context/   ──→  core/
  ├──→  agents/   ──→  llm/client.ts   (types only — this is the whole rule)
  ├──→  llm/      ──→  the model SDK   (cli/ builds the client; agents/ may not)
  ├──→  trace/    ──→  agents/events, llm/client   (types only; cli/ ships the trace)
  └──→  scaffold/ ──→  core/
```

and add this row to the folder table, after the `agents/` row:

```markdown
| `trace/` | the trace of one run: `createTraceBuilder` over the event stream and the model calls, the `traced` client decorator, and `toOtlpJson` — pure; `cli/trace-sink.ts` is how a trace leaves |
```

In the Conventions bullet that begins `- **Thirteen** architecture rules`, write the measured count in words, and add this sentence after `Only \`context/iac-fs\` and \`context/project-fs\` read a user's repository.`:

```markdown
`trace/` reaches nothing but types — no disk, no network, no `fetch`, no SDK, nothing of `cli/` — and only `cli/` reaches it.
```

- [ ] **Step 13: Run the CI commands and correct the counts**

Run: `df -h / && pnpm test && pnpm typecheck && pnpm build && pnpm smoke`
Expected: all green. Write the measured test count into AGENTS.md. The rule count was set in Step 12.

- [ ] **Step 14: Commit** (after a go-ahead)

```bash
git add src/trace/model.ts src/trace/builder.ts src/trace/client.ts src/trace/otlp.ts src/trace/README.md \
  tests/support/trace.ts tests/contract/otlp/contract-trace.ts tests/unit/trace-builder.test.ts \
  tests/unit/trace-client.test.ts tests/unit/trace-otlp.test.ts tests/invariants/trace.test.ts \
  tests/architecture/dependencies.test.ts docs/adr/0009-tracing-renders-the-event-stream.md \
  docs/design.md AGENTS.md
git commit -F - <<'EOF'
feat(trace): build a run's trace from the event stream and encode it for MLflow

createTraceBuilder folds AgentEvents and model calls into a span tree,
closing each span on the event that ends it and reporting what fits
nowhere rather than dropping or throwing on it; a property test holds
that over any sequence. traced() reports each call without changing it,
and toOtlpJson matches the body MLflow 3.16.1 read back as sent. A new
architecture rule keeps trace/ to types and reachable from cli/ alone.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 15: Open the PR against `feat/tracing-3-usage`** (after a go-ahead)

---

### Task 5: Wiring — sinks, configuration, and a trace per run

**Branch:** `git checkout -b feat/tracing-5-wiring feat/tracing-4-trace`

**Files:**
- Create: `src/cli/trace-sink.ts`, `scripts/trace-push.mjs`, `tests/unit/trace-sink.test.ts`, `tests/unit/trace-wiring.test.ts`
- Modify: `src/cli/index.ts`, `tests/support/trace.ts`, `tests/scenarios/plan-mode.test.ts`, `scripts/smoke.mjs`, `package.json`, `.gitignore`, `SECURITY.md`, `AGENTS.md`, `src/cli/README.md`

**Interfaces:**
- Consumes: everything Task 4 produces.
- Produces:

```ts
// src/cli/trace-sink.ts
export interface TraceSink { readonly name: string; export(trace: Trace): Promise<void> }
export const EXPORT_TIMEOUT_MS = 3000
export function mlflowSink(options: { trackingUri: string; experimentId: string; fetch: typeof globalThis.fetch; timeoutMs?: number }): TraceSink
export function fileSink(options: { dir: string }): TraceSink
export function sinksFromEnv(env: Record<string, string | undefined>, fetch: typeof globalThis.fetch): TraceSink[]
export async function exportTrace(trace: Trace, sinks: readonly TraceSink[], err: (chunk: string) => void): Promise<void>

// src/cli/index.ts — MainDeps gains
traceSinks?: readonly TraceSink[]
fetch?: typeof globalThis.fetch

// tests/support/trace.ts gains
export const memorySink: () => TraceSink & { readonly traces: Trace[] }
export function onlyTrace(sink: { readonly traces: readonly Trace[] }): Trace
export function disagreements(trace: Trace, events: readonly AgentEvent[]): string[]
```

- [ ] **Step 1: Write the failing sink tests**

`tests/unit/trace-sink.test.ts`:

```ts
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
})
```

Run: `pnpm vitest run tests/unit/trace-sink.test.ts`
Expected: FAIL — cannot load `../../src/cli/trace-sink.js`.

- [ ] **Step 2: Implement the sinks**

`src/cli/trace-sink.ts`:

```ts
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
        const message = plain(thrown instanceof Error ? thrown.message : String(thrown))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200)
        err(`! trace not exported to ${sink.name}: ${message}\n`)
      }
    }),
  )
}
```

Run: `pnpm vitest run tests/unit/trace-sink.test.ts`
Expected: PASS, 10 tests.

Before relying on `plain`, check its export: run `grep -n "export" src/cli/render/plain.ts` and confirm it exports `plain(text: string): string`. `cli/index.ts` already imports it as `import { plain } from './render/plain.js'`.

- [ ] **Step 3: Extend the test support**

Append to `tests/support/trace.ts`, and add these imports at the top of the file:

```ts
import type { AgentEvent } from '../../src/agents/events.js'
import type { TraceSink } from '../../src/cli/trace-sink.js'
```

```ts
/** A sink that keeps the trace itself, so a test reads the tree rather than a file or a server. */
export const memorySink = (): TraceSink & { readonly traces: Trace[] } => {
  const traces: Trace[] = []
  return { name: 'memory', traces, export: async (trace) => void traces.push(trace) }
}

export function onlyTrace(sink: { readonly traces: readonly Trace[] }): Trace {
  const [trace, ...more] = sink.traces
  if (trace === undefined || more.length > 0) {
    throw new Error(`expected one trace, got ${sink.traces.length}`)
  }
  return trace
}

/**
 * Where a trace tells a run differently from the stream it was built from.
 *
 * What must hold whatever the model chose: every span was closed by an event
 * of its own, every model call sits inside an agent, there is one AGENT span
 * per `agent:start`, and every gate verdict on the stream is a marker with the
 * same verdict under its attempt, in the same order.
 */
export function disagreements(trace: Trace, events: readonly AgentEvent[]): string[] {
  const problems: string[] = []
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]))

  for (const span of trace.spans) {
    if (span.status.code === 'ERROR' && span.status.message.includes('by no event of its own')) {
      problems.push(`${span.name}: ${span.status.message}`)
    }
    if (span.type === 'CHAT_MODEL' && byId.get(span.parentId ?? '')?.type !== 'AGENT') {
      problems.push(`${span.name} is not inside an agent`)
    }
  }

  const started = events.filter((event) => event.type === 'agent:start').length
  const agents = trace.spans.filter((span) => span.type === 'AGENT').length
  if (started !== agents) problems.push(`${started} agent:start events, ${agents} AGENT spans`)

  const told = events.flatMap((event) =>
    event.type === 'gate:passed'
      ? [`attempt ${event.attempt} / gate ${event.gate} / OK`]
      : event.type === 'repair'
        ? [`attempt ${event.attempt} / gate ${event.gate} / ERROR`]
        : [],
  )
  const drawn = trace.spans
    .filter((span) => span.name.startsWith('gate '))
    .map((span) => `${byId.get(span.parentId ?? '')?.name} / ${span.name} / ${span.status.code}`)
  if (JSON.stringify(told) !== JSON.stringify(drawn)) {
    problems.push(`gates: the stream told ${JSON.stringify(told)}, the trace drew ${JSON.stringify(drawn)}`)
  }
  return problems
}
```

- [ ] **Step 4: Write the failing wiring tests**

`tests/unit/trace-wiring.test.ts`:

```ts
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
```

Run: `pnpm vitest run tests/unit/trace-wiring.test.ts`
Expected: FAIL. `MainDeps` has no `traceSinks` (typecheck), and at runtime no sink is ever called: `onlyTrace` throws `expected one trace, got 0`.

- [ ] **Step 5: Wire tracing into `cli/index.ts`**

Add these imports beside the existing ones. `EventSink` joins the existing `import type { AgentEvent }` from `'../agents/events.js'`:

```ts
import { randomBytes } from 'node:crypto'
import type { AgentEvent, EventSink } from '../agents/events.js'
import { createTraceBuilder } from '../trace/builder.js'
import { traced } from '../trace/client.js'
import type { Attributes } from '../trace/model.js'
import { exportTrace, sinksFromEnv, type TraceSink } from './trace-sink.js'
```

In `MainDeps`, after `ask?: Ask`, add:

```ts
  /**
   * Where a finished run's trace goes, beside the sinks the environment
   * configures (`MLFLOW_TRACKING_URI`, `IDP_TRACE_DIR`). Injected so a test
   * reads the trace itself rather than a file or a server. With neither this
   * nor those variables, which is every run by default, nothing is traced.
   */
  traceSinks?: readonly TraceSink[]
  /** The MLflow sink's transport. Injected for tests; a real run uses the global one. */
  fetch?: typeof globalThis.fetch
```

Replace the whole of `agentBacked`, doc comment included:

```ts
/**
 * Runs one command that needs a model, closes the tape afterwards, and traces
 * the run when a sink asks for it.
 *
 * The client is built here and not inside the command, for the reason every
 * other seam in this file exists: a command that chose its own provider could
 * not be driven by a scripted one, and every agent-backed test would need a key
 * or a recording.
 *
 * The trace starts once the session is open — a run refused for want of a
 * model has no run to trace — and is finished and exported on both paths out,
 * the result and the throw, because the run that failed is the one most worth
 * reading. Nothing about it reaches the exit code: an export that fails is one
 * line on stderr (ADR-0009).
 */
async function agentBacked(
  deps: MainDeps,
  err: (chunk: string) => void,
  out: (chunk: string) => void,
  run: AgentRun,
  execute: (client: LlmClient, emit: EventSink) => Promise<CommandResult>,
): Promise<number> {
  let session: Session
  try {
    session = await openSession(deps, err, run.scenario)
  } catch (error) {
    return failed(error, err)
  }

  const shown = deps.events ?? progress(err)
  const sinks = [
    ...sinksFromEnv(deps.env ?? process.env, deps.fetch ?? globalThis.fetch),
    ...(deps.traceSinks ?? []),
  ]
  const builder =
    sinks.length === 0
      ? undefined
      : createTraceBuilder({
          clock: traceClock(),
          ids: TRACE_IDS,
          name: `idp-agent ${run.command}`,
          inputs: run.inputs,
          attributes: session.attributes,
        })
  if (builder !== undefined) err(`· trace ${builder.traceId}\n`)
  const client = builder === undefined ? session.client : traced(session.client, builder)
  const emit: EventSink =
    builder === undefined
      ? shown
      : (event) => {
          builder.onEvent(event)
          shown(event)
        }

  let code: number
  let outputs: unknown
  let thrown: string | undefined
  try {
    const result = await execute(client, emit)
    // Recording in memory and never writing it down is the whole run wasted,
    // and it is silent: the turns are there, the file never appears.
    await session.save()
    code = report(result, out)
    outputs = { exitCode: code, text: result.text }
  } catch (error) {
    code = failed(error, err)
    thrown = error instanceof Error ? error.message : String(error)
    outputs = { exitCode: code, error: thrown }
  }

  if (builder !== undefined) {
    const trace = builder.finish({
      outputs,
      attributes: { 'idp.exit_code': code },
      ...(thrown !== undefined ? { error: thrown } : {}),
    })
    await exportTrace(trace, sinks, err)
  }
  return code
}

/** One agent-backed command: what it is called, which tape it replays, and what it was asked. */
interface AgentRun {
  readonly command: 'ask' | 'init' | 'plan'
  readonly scenario: string
  readonly inputs: Readonly<Record<string, unknown>>
}

/** The model, the tape, and what a trace's root says about where the answers came from. */
interface Session {
  readonly client: LlmClient
  save(): Promise<void>
  readonly attributes: Attributes
}

/** Unix nanoseconds, monotonic within a run: the wall clock read once, the high-resolution timer after. */
function traceClock(): () => bigint {
  const epoch = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint()
  return () => epoch + process.hrtime.bigint()
}

const TRACE_IDS = {
  traceId: (): string => randomBytes(16).toString('hex'),
  spanId: (): string => randomBytes(8).toString('hex'),
}
```

In `openSession`, change the return type from `Promise<{ client: LlmClient; save: () => Promise<void> }>` to `Promise<Session>`, and replace

```ts
    return { client: deps.client, save: async (): Promise<void> => {} }
```

with

```ts
    return {
      client: deps.client,
      save: async (): Promise<void> => {},
      attributes: { 'idp.mode': 'scripted' },
    }
```

Then replace

```ts
  const tape =
    mode === 'live'
      ? undefined
      : await openRecording({
          scenario: deps.scenario ?? env['IDP_SCENARIO'] ?? scenario,
```

with

```ts
  const name = deps.scenario ?? env['IDP_SCENARIO'] ?? scenario
  const tape =
    mode === 'live'
      ? undefined
      : await openRecording({
          scenario: name,
```

and replace

```ts
    save: async (): Promise<void> => {
      if (mode === 'record' && tape !== undefined) await tape.save()
    },
  }
}
```

with

```ts
    save: async (): Promise<void> => {
      if (mode === 'record' && tape !== undefined) await tape.save()
    },
    // A replayed trace's latencies measure the tape, not the model; `idp.mode`
    // is how a reader of the trace knows which.
    attributes: {
      'idp.mode': mode,
      ...(tape !== undefined ? { 'idp.scenario': name } : {}),
      ...(choice !== undefined ? { 'idp.provider': choice.provider, 'idp.model': choice.model } : {}),
    },
  }
}
```

Now the three call sites. For `init`, replace

```ts
    return agentBacked(deps, err, out, 'init', async (client) =>
      runInitRepo({
        project,
        client,
        emit: deps.events ?? progress(err),
        colour: colourOf(deps),
      }),
    )
```

with

```ts
    return agentBacked(
      deps,
      err,
      out,
      { command: 'init', scenario: 'init', inputs: { command: 'init', project } },
      async (client, emit) => runInitRepo({ project, client, emit, colour: colourOf(deps) }),
    )
```

For `plan`, replace

```ts
    return agentBacked(deps, err, out, 'plan', async (client) =>
      runIntent({
```

with

```ts
    return agentBacked(
      deps,
      err,
      out,
      {
        command: 'plan',
        scenario: 'plan',
        inputs: { command: 'plan', intent: source.intent, repo: command.repo },
      },
      async (client, emit) =>
      runIntent({
```

and, inside that same `runIntent({ … })` call, replace `emit: deps.events ?? progress(err),` with `emit,`. Leave the `plan --from` road above it unchanged: it involves no model and is not traced.

For `ask`, replace

```ts
    return agentBacked(deps, err, out, 'question', async (client) =>
      runAsk({
```

with

```ts
    return agentBacked(
      deps,
      err,
      out,
      { command: 'ask', scenario: 'question', inputs: { command: 'ask', intent: command.intent } },
      async (client, emit) =>
      runAsk({
```

and, inside that `runAsk({ … })` call, replace `emit: deps.events ?? progress(err),` with `emit,`.

Run: `pnpm typecheck && pnpm vitest run tests/unit/trace-wiring.test.ts tests/unit/trace-sink.test.ts tests/unit/main.test.ts tests/unit/plan-intent.test.ts tests/unit/init-command.test.ts tests/unit/ask.test.ts`
Expected: typecheck clean; all PASS. `main.test.ts`, `plan-intent.test.ts`, `init-command.test.ts` and `ask.test.ts` must pass unchanged: none of them configures a sink.

- [ ] **Step 6: Make every replayed plan scenario check its trace**

In `tests/scenarios/plan-mode.test.ts`, add the import:

```ts
import { disagreements, memorySink, onlyTrace } from '../support/trace.js'
```

In `run`, replace

```ts
  const events: AgentEvent[] = []
  const code = await main(['plan', intent, '--repo', repo], {
```

with

```ts
  const events: AgentEvent[] = []
  const sink = memorySink()
  const code = await main(['plan', intent, '--repo', repo], {
    traceSinks: [sink],
```

and, right after the existing `expect(stderr, \`${scenario}: the recording is stale — re-record it\`)…` statement, add:

```ts
  // Whatever the model chose, the trace a replay produces tells the run the
  // way its own stream did: every span closed by an event, every model call
  // inside an agent, every gate verdict under its attempt.
  expect(disagreements(onlyTrace(sink), events), `${scenario}: the trace and the stream disagree`).toEqual([])
```

Run: `pnpm vitest run tests/scenarios/plan-mode.test.ts`
Expected: PASS for every recorded plan scenario. Any disagreement is a defect in `builder.ts` or in where an event is emitted — never a reason to loosen `disagreements`.

- [ ] **Step 7: The push script, the scripts, the ignore file, and the smoke environment**

`scripts/trace-push.mjs`:

```js
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

const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
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
```

In `package.json` `"scripts"`, after `"mlflow:contract": "node scripts/mlflow-contract.mjs"` (add a comma after that line), add:

```json
    "trace:push": "node scripts/trace-push.mjs"
```

In `.gitignore`, after the `.vitest/` block, add:

```
# Written by IDP_TRACE_DIR=.traces; sent to MLflow by `pnpm trace:push`, never committed.
.traces/
```

In `scripts/smoke.mjs`, replace

```js
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('IDP_')),
)
```

with

```js
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith('IDP_') && !name.startsWith('MLFLOW_'),
  ),
)
```

and extend the comment above it with one sentence: `An MLFLOW_TRACKING_URI left there would send the smoke run's traces to whatever server it names.`

- [ ] **Step 8: Check the replay road end to end, against a live MLflow**

This is manual, and never part of CI.

```bash
pnpm mlflow:up
IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios
ls .traces | wc -l            # one file per agent-backed scenario run
MLFLOW_TRACKING_URI=http://127.0.0.1:5055 pnpm trace:push .traces
```

Expected: `N of N trace(s) sent to experiment 0 at http://127.0.0.1:5055`. Open `http://127.0.0.1:5055`, go to the Default experiment, then Traces. The `repair-malformed-owner` run shows supervisor, inspector, `attempt 1…` with its gate markers, and the architect and reviewer model calls with their prompts. Then `rm -rf .traces && pnpm mlflow:down`.

- [ ] **Step 9: Document it**

`SECURITY.md`: add this section right before `## Designed, not yet built`:

```markdown
## What a trace sends, and where

Tracing is off unless the environment turns it on. With `MLFLOW_TRACKING_URI` set, each
agent-backed run sends one trace to that server; with `IDP_TRACE_DIR` set, it writes one to
that directory. A trace carries **the full prompts**: the SI summary, what the agents' tools
read from the catalogue, and the snapshots `context/project-fs` takes of the application
repository — with what project-fs already withholds from the model still withheld, and
nothing further redacted. A tracking server is therefore one more place your repositories'
content goes. The compose file this project ships (`tools/mlflow/compose.yml`) publishes it
on `127.0.0.1` only. No provider credential enters a trace: the decorator sees
`GenerateRequest` and `GenerateResult`, never the adapter. With neither variable set nothing
is traced, which `tests/unit/trace-wiring.test.ts` asserts.
```

`src/cli/README.md`: append:

```markdown
**Tracing.** `trace-sink.ts` is the only way a trace leaves the process: `mlflowSink` posts
OTLP/JSON to `MLFLOW_TRACKING_URI`'s `/v1/traces`, `fileSink` writes one file per run under
`IDP_TRACE_DIR`, and a sink that fails is one `! trace not exported` line on stderr — never
an exit code. `agentBacked` in `index.ts` builds the trace (`src/trace/`), wraps the client
with `traced` and tees the event stream, for `plan "<intent>"`, `ask` and `init` alone: the
commands that involve no model have nothing to trace. `MainDeps.traceSinks` and
`MainDeps.fetch` are the test seams (`tests/unit/trace-wiring.test.ts`).
```

`AGENTS.md`: after the paragraph that ends `A suite that demands a key is a regression, not a configuration problem.`, add:

````markdown
Tracing is optional, needs Docker, and is never part of CI (ADR-0009):

```bash
pnpm mlflow:up                                   # MLflow 3.16.1 on 127.0.0.1:5055
MLFLOW_TRACKING_URI=http://127.0.0.1:5055 idp-agent plan "<intent>" --repo <dir>
IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios && pnpm trace:push .traces   # the tapes, no key
pnpm mlflow:contract                             # after moving the image tag
pnpm mlflow:down
```

`MLFLOW_EXPERIMENT_ID` defaults to `0`. A trace carries full prompts; `SECURITY.md` says
where they go.
````

- [ ] **Step 10: Run the CI commands and correct the count**

Run: `df -h / && pnpm test && pnpm typecheck && pnpm build && pnpm smoke`
Expected: all green. Write the measured test count into AGENTS.md.

- [ ] **Step 11: Commit** (after a go-ahead)

```bash
git add src/cli/trace-sink.ts src/cli/index.ts src/cli/README.md scripts/trace-push.mjs scripts/smoke.mjs \
  package.json .gitignore SECURITY.md AGENTS.md tests/support/trace.ts tests/unit/trace-sink.test.ts \
  tests/unit/trace-wiring.test.ts tests/scenarios/plan-mode.test.ts
git commit -F - <<'EOF'
feat(cli): trace agent-backed runs into MLflow when the environment asks

MLFLOW_TRACKING_URI posts each run's trace to MLflow's OTLP endpoint and
IDP_TRACE_DIR writes it to a file; neither is on by default. The trace
covers the throw path too, and an export that fails is one stderr line,
never an exit code. Every replayed plan scenario now checks that its
trace tells the run the way its event stream did, and pnpm trace:push
sends replayed traces to MLflow without the suite touching the network.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 12: Open the PR against `feat/tracing-4-trace`** (after a go-ahead)

---

## After the last task

- Merge bottom-up with `--rebase`, each PR only after the owner's go-ahead. Rebase each remaining branch onto `main` and repoint its base as the one below it lands.
- Remove the worktree once everything is pushed: `git worktree remove ~/Documents/idp-agent-worktrees/mlflow-tracing`.
- The next sub-project, evaluation, reads these traces. It gets its own spec.
