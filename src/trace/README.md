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
imports `cli/`. Outside this folder it imports types only — `import type`, which is erased —
from whichever layer or package, never loads a module through `import()` or `require()`, and
only `cli/` imports it. `cli/trace-sink.ts` owns both ways a trace leaves the process. The rule
is `tests/architecture/dependencies.test.ts`, *trace/ reaches nothing but types, and only cli/
reaches it*.

## Three rules the builder keeps

- **Nothing is guessed.** A span is closed by the event that ends it. One that nothing
  closed is closed — at `finish`, or when the span around it ends — as an error that says so
  and keeps any reason it had already failed for; an event that matches no open span becomes
  an `unbalanced event` span — never a throw and never a silent drop. A tool call is a leaf,
  so one that never gets a result does not swallow what follows it.
  `tests/invariants/trace.test.ts` holds that over any sequence of events, and holds a
  well-formed run to closing every span by its own event.
- **A span fails for a reason of its own, and the first one stands.** An agent fails for its
  refusal, its `stopped` or its throw; an attempt for the gate that refused it, else for why
  it ended with no verdict (`attempt:end.stopped`); a tool for its own `error`; a model call
  for what the provider threw. The root fails only when the run threw: a plan stopped after
  three attempts is an `OK` root over failed attempts, and `idp.exit_code` says how the run
  ended (`docs/tracing-design.md` §4.1). The well-formed property holds every agent, attempt
  and tool to exactly that status.
- **Absent is not zero.** A model call whose provider reported no usage — every recording
  made before usage was stored — carries `idp.usage: absent`, not a count of 0.

## The contract

MLflow's own keys carry JSON strings, the project's `idp.*` keys typed values.
`tests/contract/otlp/accepted.json` is that encoding of one trace, read back span by span
through MLflow 3.16.1's client; `toOtlpJson` is tested against it, and
`pnpm mlflow:contract` re-checks it against a live server.
