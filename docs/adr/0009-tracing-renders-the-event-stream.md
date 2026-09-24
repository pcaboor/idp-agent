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
