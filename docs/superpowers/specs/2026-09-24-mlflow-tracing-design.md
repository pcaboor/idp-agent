# Tracing agent runs into MLflow — design

**Date** 2026-09-24 · **Status** proposed · **Scope** tracing only; evaluation is a later,
separate sub-project that will read these traces.

## 1. Goal

Every run of an agent-backed command — `plan "<intent>"`, `ask`, `init` — can produce one
trace: the command at the root, then each agent, each model call (prompt, response, token
usage, latency, finish reason), each tool call, and each attempt of the repair loop with the
gates it passed and the one that refused it. The trace lands in a local MLflow server, where
a failed run can be opened and read instead of reconstructed from stderr.

It must hold under the project's existing constraints, not beside them:

- **Replay produces a trace too.** A recorded scenario — `repair-malformed-owner`, say — can
  be opened in MLflow with no API key. That also makes a trace's shape deterministic, and
  therefore assertable in the suite.
- **The suite never reaches the network.** `tests/setup/offline.ts` is not touched.
- **`agents/` gains no import.** Tracing is one more consumer of the event stream the harness
  already emits (design §6.2), like the stderr renderer today and Ink at stage 7.
- **Tracing never changes a run's outcome.** Exit code, stdout and the diff are identical with
  or without it.

## 2. Non-goals

- **Evaluation** — datasets of intents, metrics per model or prompt, MLflow runs. The next
  sub-project; it will consume the traces this one produces.
- **Streaming spans while a run is in flight.** A run is exported once, at its end.
- **Redaction beyond what `context/project-fs` already does.** A trace carries full prompts; §7
  states what that means.
- **OTLP protobuf or gRPC.** The MLflow OTLP endpoint accepts `application/json`, which needs no
  dependency.
- **A trace for `plan --from`, `graph`, `show`, `validate`, `init platform`.** No model is
  involved in any of them, and the stderr lines already say everything that happened.

## 3. Decision

A pure trace builder folds the `AgentEvent` stream and the model calls into a span tree, and a
sink in `cli/` exports it as OTLP/JSON to `POST <MLFLOW_TRACKING_URI>/v1/traces`.

Rejected, and recorded in `docs/adr/0009-tracing-renders-the-event-stream.md`:

- **The AI SDK's `experimental_telemetry` with the OpenTelemetry Node SDK.** Model spans nearly
  for free, but nothing in replay — `generateText` is never called there — four or five new
  dependencies, a global context, and the harness spans (attempts, gates) would still need
  either `@opentelemetry/api` inside `agents/` or an event bridge, which is this design.
- **The `mlflow-tracing` npm SDK.** Native span rendering, but a global `init`, an asynchronous
  exporter this project does not control, a young dependency — and the same event bridge for
  everything that is not a model call.

## 4. The shape of a trace

```
idp-agent plan "<intent>"            CHAIN   command, mode, provider, model, scenario, exit code
├─ supervisor                        AGENT
│  └─ supervisor#0                   CHAT_MODEL  system, transcript, tools → text, toolCalls,
│                                                finishReason, token usage
├─ inspector                         AGENT
│  ├─ inspector#0                    CHAT_MODEL
│  ├─ read_file                      TOOL    args → rows, truncated
│  └─ inspector#1                    CHAT_MODEL
├─ attempt 1                         CHAIN
│  ├─ architect                      AGENT   → CHAT_MODEL…, TOOL…
│  ├─ gate zod                       ✓
│  ├─ gate signature                 ✓
│  └─ gate policy                    ✗       status ERROR, the refusal's reason
└─ attempt 2                         CHAIN   … reviewer, recheck, then the outcome
```

`mode` is `live`, `record`, `replay` or `scripted` (an injected `MainDeps.client`). A replayed
trace's latencies measure the tape, not the model, and `mode` is how a reader knows.

**Gate spans are zero-length verdict markers**, placed at the moment the verdict is emitted.
Three of the five gates are free and synchronous; their duration is noise. The Reviewer's cost
is real and is already visible: it is the `reviewer` AGENT span directly before the
`gate reviewer` marker.

## 5. Components

### 5.1 `src/trace/` — new, pure

No disk, no network, no model SDK, nothing from `cli/`. It imports **types only** from
`agents/events.js`, `llm/client.js` and `core/`.

| module | what it is |
|---|---|
| `model.ts` | `Span`, `Trace`, `SpanType`, `SpanStatus` — plain data |
| `builder.ts` | `createTraceBuilder({ clock, ids, root })` → `{ onEvent, modelCallStarted, modelCallEnded, finish }` |
| `client.ts` | `traced(client, builder): LlmClient` — the decorator |
| `otlp.ts` | `toOtlpJson(trace, resource)` — the OTLP `ExportTraceServiceRequest` as JSON |
| `README.md` | what lives here, what may not, and which architecture rule holds the line |

`clock` returns Unix nanoseconds as a `bigint`; `ids` returns fresh trace and span ids. Both
are injected, so a unit test builds the same tree twice.

**The builder never throws.** An event that does not fit the open tree — `agent:end` with no
`agent:start`, a `tool:result` whose `id` matches no open `tool:call` — becomes a span closed
with status `ERROR` and `unbalanced event` in its attributes. `finish` closes every span still
open with status `ERROR` and `closed by finish, not by an event`: an unclosed span is reported
as unclosed, never guessed to have succeeded.

**The decorator relays and never swallows.** `traced` hands the request to the inner client,
returns its result unchanged, and on a thrown error closes the model span as `ERROR` and
rethrows the same error.

### 5.2 Events — `src/agents/events.ts`

Without these, span boundaries would be inferred from the next event, which is the guess the
doctrine forbids. Each is emitted where the fact happens:

| event | emitted by | why |
|---|---|---|
| `{ type: 'agent:end'; agent; threw }` | `asAgent`, around each agent, on every path out | an agent's end is never emitted today; `threw` says whether it returned |
| `{ type: 'attempt:start'; attempt }` | `repair()`, at the top of the loop | an attempt that passes emits nothing today |
| `{ type: 'attempt:end'; attempt }` | `repair()`, on every exit from an iteration | closes the attempt span |
| `{ type: 'gate:passed'; attempt; gate }` | `repair()`, after each gate that passes | a refusal is already `repair { attempt, gate, reason }` |
| `id` on `tool:call` and `tool:result` | the agents' tool loops | pair by identity, not by order |

A refusal stays the existing `repair` event. A `gate` event carrying `passed: false` would have
stated one fact twice. That is the same reasoning that split `repair` from `retry` (design §6.2).

`renderEvent` prints nothing for these new events. It says so in its switch, and the `never` in
`default` keeps an unhandled one a compile error. The stderr log stays as it reads today.

### 5.3 Token usage — `src/llm/`

- `GenerateResult` gains `usage?: { inputTokens?: number; outputTokens?: number;
  totalTokens?: number }`, which `client.ts` keeps as types only.
- `runtime.ts` fills it from `response.usage` in `live` and `record`.
- A new recording stores it under `result.usage`. The digest covers the request, not the result,
  so no existing tape goes stale.
- An old recording has no `usage`. Its trace states the usage as **absent**, never `0`.

### 5.4 `src/cli/trace-sink.ts`

```ts
interface TraceSink { name: string; export(trace: Trace): Promise<void> }
```

- **`mlflowSink({ trackingUri, experimentId, fetch, timeoutMs? })`** — `POST
  {trackingUri}/v1/traces` with `content-type: application/json` and `x-mlflow-experiment-id`,
  bounded by `AbortSignal.timeout(timeoutMs ?? 3000)`. The spike posted 24 MB in 1.2 s to a local
  server; a real trace is about the size of its recording, 200 KB at most today.
- **`fileSink({ dir })`** — writes `<dir>/<traceId>.json`, the same OTLP/JSON body.
- **`pnpm trace:push <dir>` (`scripts/trace-push.mjs`)** — posts every file in a directory to the
  configured server. It is how a replayed scenario reaches MLflow without the suite ever touching
  the network.

### 5.5 Wiring — `src/cli/index.ts`

- `agentBacked` builds the builder and wraps the client, whichever client the session opened,
  when at least one sink is configured. When none is, nothing is built and the client is
  today's.
- The trace starts once the session is open. A run refused for want of a model, or for a bad
  `IDP_RECORDING`, has no run to trace.
- `agentBacked` finishes the trace on **both** paths, the result and the catch, records the exit
  code on the root, exports to each sink, then returns the same code it returns today.
- `openSession` hands the root its attributes: `idp.mode`, plus `idp.scenario`, `idp.provider`
  and `idp.model` when it knows them.
- When tracing is on, stderr gains one line, `· trace <id>`, so a run can be found in the UI.
- `MainDeps` gains `traceSinks?: readonly TraceSink[]` and `fetch?: typeof fetch`. The sinks are
  **added to** those the environment configures, so a scenario test reads its trace from memory
  while `IDP_TRACE_DIR` still writes the same run to a file.

## 6. Configuration

Environment only, like `IDP_PROVIDER`. `.idp-agent.yml` gains no field.

| variable | effect |
|---|---|
| `MLFLOW_TRACKING_URI` | present → export to that server |
| `MLFLOW_EXPERIMENT_ID` | the experiment; `0`, MLflow's Default experiment, when unset |
| `IDP_TRACE_DIR` | present → write one OTLP/JSON file per run there, resolved against the shell's working directory, never against `--repo` |

Both sinks can be on at once. The scenario tests already pass `env: process.env` to `main`,
so `IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios` writes one trace per recorded
scenario. `.traces/` is gitignored.

## 7. Failure and security

| situation | behaviour |
|---|---|
| nothing configured | no builder, no decorator, no cost |
| the server is unreachable, or answers non-2xx | one stderr line, `! trace not exported to mlflow: <status or error>`; exit code unchanged |
| the server hangs | aborted after 3 s, then as above |
| the run throws | the root span closes as `ERROR` with the message; the trace is still exported, because it is the run most worth reading |
| an unbalanced event sequence | §5.1: an `ERROR` span naming it, never a throw and never a silent drop |

**What leaves the machine — a new row in `SECURITY.md`.** A trace carries the full prompts. That
includes the SI summary and the snapshots `context/project-fs` takes, with the secrets
`project-fs` already excludes, and nothing further redacted. With `MLFLOW_TRACKING_URI` set, that
content goes to that server. It never does by default, and the compose file this project ships
publishes the port on `127.0.0.1` only. No provider credential enters a trace: the decorator only
ever sees `GenerateRequest` and `GenerateResult`.

**A fourteenth architecture rule.** `src/trace/` imports neither `node:fs`, `node:http(s)`,
`undici`, the model SDK nor `cli/`. From `agents/` and `llm/` it may import types only. `agents/`
does not import `src/trace/`. `fetch` is a global that no import rule can see, as `SECURITY.md`
already says of the others. So the same test also refuses the identifier `fetch` anywhere in
`src/trace/`'s source. The rule is verified non-vacuous against a deliberate violation before it
is relied on. AGENTS.md's "Thirteen" becomes "Fourteen" in the same commit.

## 8. Testing — all offline

1. **The OTLP contract, verified once and then frozen.**
   - The first task is a spike. MLflow runs in Docker, and a hand-written OTLP/JSON body goes to
     it: a root, a `CHAT_MODEL`, a `TOOL`, and an `ERROR` span. The spike checks in the UI that
     span types, inputs and outputs, token usage and status render.
   - The accepted body is committed as `tests/fixtures/otlp/accepted.json`, and `toOtlpJson` is
     tested against it.
   - `scripts/mlflow-contract.mjs` re-runs that check against a live server, outside CI, whenever
     the pinned MLflow version moves.
2. **The builder.**
   - Unit tests turn an event sequence, a fake clock and fake ids into the expected tree. They
     cover two attempts, an agent's own `retry`, a truncated tool, `ask`, and a stop after three
     attempts.
   - Property tests (`fast-check`, beside `tests/invariants/`): for **any** event sequence, the
     builder never throws, every span is closed, `end ≥ start`, every parent exists, and there is
     exactly one root.
3. **The decorator.** It relays the result unchanged and rethrows the same error. A missing
   `usage` stays missing.
4. **End to end, on every recorded plan scenario.** The shared `run()` in
   `tests/scenarios/plan-mode.test.ts` passes `traceSinks: [memory]`, and each run's trace must
   agree with its own event stream:
   - every span was closed by an event of its own;
   - every model call sits inside an agent;
   - there is one AGENT span per `agent:start`;
   - every gate verdict, passed or refused, is a marker with the same verdict under its attempt,
     in the same order.

   The test compares that projection, never a raw snapshot, because prompts run to hundreds of
   kilobytes and would change on every re-recording.
5. **The sinks.**
   - Failure: `MLFLOW_TRACKING_URI` set with no injected `fetch` meets `offline.ts`'s thrower.
     That is a real assertion of "one stderr line, same exit code".
   - Success: an injected `fetch` asserts the URL, the headers, the content type and the timeout
     signal.
   - The file sink writes to a temporary directory and removes it afterwards.
   - With nothing configured, stdout and the exit code are byte-identical to a run without
     tracing.
6. **Architecture.** The fourteenth rule, as §7 describes.

AGENTS.md's test count is re-measured and corrected in each commit that changes it.

## 9. Local stack

`tools/mlflow/compose.yml`:

- Image `ghcr.io/mlflow/mlflow:v3.16.1`, **pinned**: the spike validated it, and 3.6 is the first
  release with OTLP ingestion.
- `mlflow server --host 0.0.0.0` inside the container, published on `127.0.0.1:5055` only.
  Port 5000 is MLflow's default, but macOS's AirPlay receiver holds it.
- sqlite and artifacts in a named volume, so traces survive a `down`.
- `pnpm mlflow:up` and `pnpm mlflow:down`. `mlflow:up` waits for a healthcheck on `/health`;
  the spike measured about 5 s.

Docker is never required by `test`, `typecheck`, `build` or `smoke`, and CI is unchanged.

```bash
pnpm mlflow:up
export MLFLOW_TRACKING_URI=http://127.0.0.1:5055
idp-agent plan "<intent>" --repo <iac>                                              # a live run
IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios && pnpm trace:push .traces    # the tapes, no key
```

## 10. Documentation

- `src/trace/README.md`.
- `docs/adr/0009-tracing-renders-the-event-stream.md`.
- `docs/design.md` §6.2: one paragraph on tracing as a consumer, and the new events added to the
  listed union.
- `SECURITY.md`: the row from §7.
- `src/llm/README.md`: `usage`, and what an old recording carries.
- AGENTS.md: the commands, the configuration, and the counts.
- The implementation plan: `docs/plans/tracing-mlflow.md`, ticked as it goes.

## 11. Delivery

One pull request per task, stacked, merged bottom-up with `--rebase`:

1. **Spike** — compose file, contract fixture, `mlflow-contract.mjs`
2. **Events** — `agent:end`, `attempt:start`/`attempt:end`, `gate:passed`, tool ids, `renderEvent`
3. **Usage** — `GenerateResult.usage`, `runtime.ts`, recordings
4. **`src/trace/`** — builder, decorator, `toOtlpJson`, properties, the fourteenth rule
5. **Wiring** — sinks, configuration, `main` tests, `trace:push`, documentation

The work happens in a worktree under `~/Documents/idp-agent-worktrees`, based on `origin/main`.
It is independent of stage 5. The likely point of friction is `src/cli/index.ts`, which stage 5
also touches.

## 12. Settled by the spike, 2026-09-24

The spike ran against `ghcr.io/mlflow/mlflow:v3.16.1`. The body was posted to `/v1/traces` and
read back through MLflow's own Python client inside the container.

- **Gate markers are `CHAIN`.** The type renders as sent, and an `ERROR` status keeps its message.
- **Encoding.** `mlflow.spanType` was read identically as a JSON-encoded string (`"\"CHAIN\""`)
  and as a plain one (`"CHAIN"`). The JSON form is kept: it is MLflow's own convention, and
  `mlflow.spanInputs`, `mlflow.spanOutputs` and `mlflow.chat.tokenUsage` must be JSON anyway.
  Project attributes (`idp.*`) keep typed OTLP values; an `intValue` reads back as a number.
- **Token usage.** `mlflow.chat.tokenUsage` on a `CHAT_MODEL` span, with keys `input_tokens`,
  `output_tokens` and `total_tokens`, is summed by MLflow into `trace.info.token_usage`. Nothing
  is written on the root. A tampered key (`prompt_tokens`) is not summed, which is how the
  contract check was shown to fail.
- **What the root drives.** The trace's state follows the root's status: an `ERROR` root is an
  `ERROR` trace, and `OK` children under it do not change that. `request_preview` and
  `response_preview` are the root's inputs and outputs. The trace id is `tr-` plus the OTLP
  `traceId` in hexadecimal.
- **Span events** come back with their name and attributes.
- **Size.** Bodies of 2, 8 and 24 MB were accepted in 0.2, 0.4 and 1.2 s.
- **The pinned tag** is `v3.16.1`.

`tests/contract/otlp/accepted.json` and `scripts/mlflow-contract.mjs` freeze these findings, and
`pnpm mlflow:contract` re-checks them against a live server.
