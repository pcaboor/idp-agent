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
