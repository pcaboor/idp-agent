# Tracing agent runs into MLflow — design

**Date** 2026-09-24, revised 2026-09-25 · **Status** accepted · **Scope** tracing only;
evaluation is a later, separate sub-project that will read these traces.

## 1. Goal

Every run of an agent-backed command — `plan "<intent>"`, `ask`, `init`, and the one gesture
`idpa "<phrase>"` (the `entry` command) — can produce one trace: the command at the root, then
each agent, each model call (prompt, response, token usage, latency, finish reason), each tool
call, and each attempt of the repair loop with the gates it passed and the one that refused it.
The trace lands in a local MLflow server, where a failed run can be opened and read instead of
reconstructed from stderr.

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
sink in `cli/` exports it as OTLP/JSON to `POST <IDP_MLFLOW_TRACKING_URI>/v1/traces`.

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
idp-agent plan                       CHAIN   inputs: command, intent, repo, project
│                                            idp.mode, idp.provider, idp.model, idp.scenario,
│                                            idp.exit_code
├─ supervisor                        AGENT
│  └─ supervisor call 0              CHAT_MODEL  system, transcript, tools → text, toolCalls,
│                                                finishReason, token usage
├─ inspector                         AGENT
│  ├─ inspector call 0               CHAT_MODEL
│  ├─ read_file                      TOOL    args → rows, truncated (and error, when refused)
│  └─ inspector call 1               CHAT_MODEL
├─ attempt 1                         CHAIN   ERROR: refused at the policy gate
│  ├─ architect                      AGENT   → CHAT_MODEL…, TOOL…
│  ├─ gate zod                       ✓
│  ├─ gate signature                 ✓
│  └─ gate policy                    ✗       status ERROR, the refusal's reason
└─ attempt 2                         CHAIN   … reviewer, recheck, then the outcome
```

The root is named after the command — `idp-agent plan`, `idp-agent ask`, `idp-agent init`,
`idp-agent entry` — and what it was asked is its `inputs`: the intent or the phrase, and the
repositories the run reads, **resolved** to absolute paths, since what was typed may be a
relative path or nothing at all.

`mode` is `live`, `record`, `replay` or `scripted` (an injected `MainDeps.client`). A replayed
trace's latencies measure the tape, not the model, and `mode` is how a reader knows.

**Gate spans are zero-length verdict markers**, placed at the moment the verdict is emitted.
Three of the five gates are free and synchronous; their duration is noise. The Reviewer's cost
is real and is already visible: it is the `reviewer` AGENT span directly before the
`gate reviewer` marker.

### 4.1 Statuses — decided

A span is `ERROR` when something it stands for failed, and its message says what:

| span | `ERROR` when | message |
|---|---|---|
| gate marker | the gate refused (`repair`) | the refusal's reason |
| attempt | a gate refused it | `refused at the <gate> gate` |
| attempt | it ended with no verdict (`attempt:end.stopped`) | the Reviewer's reason for having no opinion; `the draft ended with no proposal`; `the attempt threw` |
| agent | it refused (`refused`), or its model call threw (`stopped`) | the reason on the event |
| agent | it threw, and nothing said why first (`agent:end { threw: true }`) | `the agent threw` |
| model call | the call threw | the error's message |
| tool | the tool refused the call (`tool:result.error`) | that error |
| root | **the run threw** | the error's message |

The first failure of a span stands. A later one does not overwrite it: an attempt a gate
refused still reads `refused at the policy gate` when it then ends, and an agent that
`stopped` keeps that reason when its `agent:end { threw: true }` arrives.

**The root is `ERROR` only when the run threw, and `idp.exit_code` is always on it.** A plan the
repair loop stopped after three attempts exits `1` with an `OK` root, and is found by its
failed attempt spans, each of which says why.

The reason is what an `ERROR` root means in MLflow: the trace's state follows the root's status
(§12), so the root decides whether the run is listed as failed. Exit `1` is the negative answer
— nothing matched, a gate refused, three attempts refused (AGENTS.md) — and exit `3` is a
question asked rather than a value guessed. Neither is the run failing; a trace list where every
"nothing matched" is red would hide the runs that did fail. A thrown run is the one where the
harness itself did not reach an answer, and that is what `ERROR` says. What each run concluded
is `idp.exit_code`, which MLflow can filter on.

A refusal that throws is a thrown run. `idpa "<change>"` against the demo SI throws once the
Supervisor has said it is a change — a change is never previewed against the demo SI — and
`failed()` maps that error to exit `2`. Its root is `ERROR` and carries the refusal, beside
the `supervisor` span that got it there.

## 5. Components

### 5.1 `src/trace/` — new, pure

No disk, no network, no model SDK, nothing from `cli/`. It imports **types only** from
`agents/events.js`, `llm/client.js` and `core/`.

| module | what it is |
|---|---|
| `model.ts` | `Span`, `Trace`, `SpanType`, `SpanStatus` — plain data |
| `builder.ts` | `createTraceBuilder({ clock, ids, name, inputs, attributes })` → `{ traceId, onEvent, modelCallStarted, modelCallEnded, finish }` |
| `client.ts` | `traced(client, builder): LlmClient` — the decorator |
| `otlp.ts` | `toOtlpJson(trace, resource)` — the OTLP `ExportTraceServiceRequest` as JSON |
| `README.md` | what lives here, what may not, and which architecture rule holds the line |

`clock` returns Unix nanoseconds as a `bigint`; `ids` returns fresh trace and span ids. Both
are injected, so a unit test builds the same tree twice. `name` and `inputs` are the root's;
`attributes` are the session's (`idp.mode` and the rest), and `finish` adds the run's own —
`idp.exit_code` — with its outputs.

**The builder never throws.** An event that does not fit the open tree — `agent:end` with no
`agent:start`, a `tool:result` whose `id` matches no open `tool:call` — becomes a zero-length
span **named** `unbalanced event`, with status `ERROR` saying what it matched nothing of, and the
event's type in `idp.event`. `finish` closes every span still open with status `ERROR` and
`closed by finish, by no event of its own`, and a span closed by the end of the one around it
says `closed when <key> ended, by no event of its own`: an unclosed span is reported as
unclosed, never guessed to have succeeded. A span that had already failed keeps why, with the
forced close in brackets after it.

**A tool call is a leaf.** A `TOOL` span is paired with its result by id and never contains
anything, and it never becomes the span later events land on. Every agent answers every call it
receives — the Architect answers a call to a tool it does not have with a `tool:result` carrying
`error` — so in a well-formed run each `TOOL` span is closed by its own result. A call that
still gets none is closed, as `ERROR`, when its parent ends; it does not become the parent of
everything after it. Agents, attempts and model calls nest; that works because events and model
calls arrive one at a time and no two model calls overlap.

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
| `{ type: 'attempt:end'; attempt; stopped? }` | `repair()`, exactly once per attempt, on every exit — a throw included | closes the attempt span; `stopped` says why an attempt ended with no verdict |
| `{ type: 'gate:passed'; attempt; gate }` | `repair()`, after each gate that passes | a refusal is already `repair { attempt, gate, reason }` |
| `id` on `tool:call` and `tool:result` | the agents' tool loops | pair by identity, not by order |

`stopped` on `attempt:end` is set when the attempt ended without a verdict: the Reviewer's
`no-opinion` (its reason), an Architect that produced no draft (`the draft ended with no
proposal`), and a throw (`the attempt threw`, and the error goes on unchanged). An attempt a gate
refused needs none — its `repair` event already says so — and neither does one that ends on a
question, which is not a failure.

A refusal stays the existing `repair` event. A `gate` event carrying `passed: false` would have
stated one fact twice. That is the same reasoning that split `repair` from `retry` (design §6.2).

The trace also reads three facts the stream carries for its own reasons:

| event | emitted by | what the trace draws |
|---|---|---|
| `{ type: 'stopped'; agent; reason }` | the Architect, the Inspector and the Reviewer, when the model call beneath them threw | the agent span fails with `reason`; `agent:end` still closes it |
| `error?` on `tool:result` | a tool loop, when the tool refused or failed the call — the Architect's refused `answer` included | the `TOOL` span's outputs carry `error`, and it fails with it |
| `{ type: 'reapplied'; path; value; entity; answeredAt; replaced? }` | the ask loop, when an answer the user gave is put back into a redraft | a span event on whatever is open |

`renderEvent` prints nothing for the four events this design adds. It says so in its switch,
and the `never` in `default` keeps an unhandled one a compile error. The stderr log stays as it
reads today.

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
  server; a real trace is about the size of its recording, 200 KB at most today. A `2xx` is not
  the end of it: the body is read, and an OTLP `partialSuccess` with `rejectedSpans > 0` is a
  failure, `<n> span(s) rejected: <errorMessage>` — a trace MLflow kept only part of is never
  reported as sent.
- **`fileSink({ dir })`** — writes `<dir>/<traceId>.json`, the same OTLP/JSON body, with mode
  `0600`, since it holds full prompts, and never over a file already there.
- **`pnpm trace:push <dir>` (`scripts/trace-push.mjs`)** — posts every file in a directory to the
  server `IDP_MLFLOW_TRACKING_URI` names. It is how a replayed scenario reaches MLflow without the
  suite ever touching the network.

### 5.5 Wiring — `src/cli/index.ts`

- The traced commands are the four agent-backed ones: `plan "<intent>"`, `ask`, `init`, and
  `entry` — `idpa "<phrase>"`, whose question road is `ask`'s and whose change road is `plan`'s.
- `agentBacked` builds the builder and wraps the client, whichever client the session opened,
  when at least one sink is configured. When none is, nothing is built and the client is
  today's.
- The trace starts once the session is open. A run refused for want of a model, or for a bad
  `IDP_RECORDING`, has no run to trace.
- `agentBacked` finishes the trace on **both** paths, the result and the catch, records the exit
  code on the root as `idp.exit_code`, exports to each sink, then returns the same code it
  returns today. The root's outputs are `{ exitCode, text }`, with the text as a terminal would
  not show it — no escape sequences, so MLflow's preview reads — or `{ exitCode, error }`.
- `openSession` hands the root its attributes: `idp.mode`, plus `idp.scenario`, `idp.provider`
  and `idp.model` when it knows them.
- The root's `inputs` carry the resolved repositories: `plan`'s `repo` and `project`, and
  `entry`'s when it found them. When `plan` skips the Inspector — the working directory is not a
  service's — there is no `project` key, and the root says so: `idp.inspector: 'skipped'`, with
  the reason in `idp.inspector.reason`. Otherwise the skip reached only stderr.
- When tracing is on, stderr gains one line, `· trace tr-<hex>`: MLflow's own id for the trace,
  which pastes into its search.
- `MainDeps` gains `traceSinks?: readonly TraceSink[]` and `fetch?: typeof fetch`. The sinks are
  **added to** those the environment configures, so a scenario test reads its trace from memory
  while `IDP_TRACE_DIR` still writes the same run to a file.

## 6. Configuration

Environment only, like `IDP_PROVIDER`. `.idp-agent.yml` gains no field.

| variable | effect |
|---|---|
| `IDP_MLFLOW_TRACKING_URI` | present → export to that server |
| `IDP_MLFLOW_EXPERIMENT_ID` | the experiment; `0`, MLflow's Default experiment, when unset |
| `IDP_TRACE_DIR` | present → write one OTLP/JSON file per run there, resolved against the shell's working directory, never against `--repo` |

**MLflow's own `MLFLOW_TRACKING_URI` and `MLFLOW_EXPERIMENT_ID` are ignored entirely.** They are
routinely set for other tools — a Databricks workspace, a team's tracking server — and honouring
them would start sending full prompts to that server on every run of this CLI, for someone who
never asked this tool to trace anything. Tracing is off unless this tool's own environment turns
it on, and that promise has to hold whatever else the shell exports.

Both sinks can be on at once. The scenario tests already pass `env: process.env` to `main`,
so `IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios` writes one trace per recorded
scenario. `.traces/` is gitignored. `tests/setup/personal.ts` removes `IDP_MLFLOW_TRACKING_URI`
and `IDP_MLFLOW_EXPERIMENT_ID` from the suite's environment, so a developer who exported them
never sends the suite's traces anywhere; it leaves `IDP_TRACE_DIR` alone, because a file on this
machine is not a trace sent anywhere, and that variable is how the tapes are traced on purpose.

## 7. Failure and security

| situation | behaviour |
|---|---|
| nothing configured | no builder, no decorator, no cost |
| the server is unreachable, or answers non-2xx | one stderr line, `! trace not exported to mlflow: <status or error>`; exit code unchanged |
| the server accepts the body and rejects spans | as above, `<n> span(s) rejected: <its message>` |
| the server hangs | aborted after 3 s, then as above |
| the run throws | the root span closes as `ERROR` with the message; the trace is still exported, because it is the run most worth reading |
| an unbalanced event sequence | §5.1: an `ERROR` span naming it, never a throw and never a silent drop |

**What leaves the machine — a new row in `SECURITY.md`.** A trace carries the full prompts. That
includes the SI summary and the snapshots `context/project-fs` takes, with the secrets
`project-fs` already excludes, and nothing further redacted. With `IDP_MLFLOW_TRACKING_URI` set,
that content goes to that server. It never does by default, `MLFLOW_TRACKING_URI` never turns it
on (§6), and the compose file this project ships publishes the port on `127.0.0.1` only. A trace
file is written `0600`. Kept inside an application repository, it would be read back by the
Inspector: `IDP_TRACE_DIR` belongs outside it, or in a hidden folder, the only kind `project-fs`
skips. No provider credential enters a trace: the decorator only ever sees `GenerateRequest` and
`GenerateResult`.

**A fourteenth architecture rule.** `src/trace/` imports neither `node:fs`, `node:http(s)`,
`undici`, the model SDK nor `cli/`. Outside its own folder it may import types only — from any
layer and any package — and it loads nothing through `import()` or `require()` but its own
modules. Only `cli/` imports `src/trace/`, so neither `agents/` nor `llm/` does. `fetch` is a
global that no import rule can see, as `SECURITY.md` already says of the others. So the same
test also refuses the identifier `fetch` anywhere in `src/trace/`'s source. The rule is verified
non-vacuous against a deliberate violation before it is relied on. AGENTS.md's "Thirteen"
becomes "Fourteen" in the same commit.

## 8. Testing — all offline

1. **The OTLP contract, verified once and then frozen.**
   - The first task is a spike. MLflow runs in Docker, and a hand-written OTLP/JSON body goes to
     it: a root, a `CHAT_MODEL`, a `TOOL`, and an `ERROR` span. The spike checks in the UI that
     span types, inputs and outputs, token usage and status render.
   - The accepted body is committed as `tests/contract/otlp/accepted.json`, and `toOtlpJson` is
     tested against it.
   - `scripts/mlflow-contract.mjs` re-runs that check against the local compose server, outside
     CI, whenever the pinned MLflow version moves. It posts to `http://127.0.0.1:5055` and to
     nowhere else: it reads the trace back through that container, so a trace posted anywhere
     else could never be read back, and could land on a team's server.
2. **The builder.**
   - Unit tests turn an event sequence, a fake clock and fake ids into the expected tree. They
     cover two attempts, an agent's own `retry`, a truncated tool, a refused tool, `ask`, an
     agent that stopped, an attempt that stopped or threw, and a stop after three attempts.
   - Property tests (`fast-check`, beside `tests/invariants/`): for **any** event sequence, the
     builder never throws, every span is closed, `end ≥ start`, every parent exists, every child
     lies inside its parent in time, there is exactly one root, and nothing is dropped — one
     AGENT span per `agent:start`, one TOOL per `tool:call`, one gate marker per verdict. For a
     **well-formed** run, generated as nested blocks, every span is also closed by its own event,
     an agent fails only for its own refusal, its `stopped` or its throw, and a tool only for its
     own error.
3. **The decorator.** It relays the result unchanged and rethrows the same error. A missing
   `usage` stays missing.
4. **End to end, on every recorded scenario.** The shared `run()` in
   `tests/scenarios/plan-mode.test.ts`, and the question-mode scenarios the same way, pass
   `traceSinks: [memory]`, and each run's trace must agree with its own event stream:
   - every span was closed by an event of its own — any forced close is a disagreement, since
     every tool call is answered (§5.1);
   - no `unbalanced event`;
   - every model call sits inside an agent;
   - there is one AGENT span per `agent:start`;
   - every gate verdict, passed or refused, is a marker with the same verdict under its attempt,
     in the same order.

   The test compares that projection, never a raw snapshot, because prompts run to hundreds of
   kilobytes and would change on every re-recording.
5. **The sinks.**
   - Failure: `IDP_MLFLOW_TRACKING_URI` set, with an injected `fetch` that throws as a refused
     connection does. That is a real assertion of "one stderr line, same exit code", and it holds
     on its own rather than borrowing `offline.ts`'s thrower, which steps aside under
     `IDP_RECORDING=record`.
   - `MLFLOW_TRACKING_URI` set, and nothing else, configures no sink.
   - Success: an injected `fetch` asserts the URL, the headers, the content type and the timeout
     signal; a `partialSuccess` that rejected spans is a failure.
   - The file sink writes `0600` to a temporary directory and removes it afterwards.
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
export IDP_MLFLOW_TRACKING_URI=http://127.0.0.1:5055
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
