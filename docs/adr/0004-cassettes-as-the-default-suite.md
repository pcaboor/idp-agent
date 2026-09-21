# ADR-0004 — cassettes as the default suite, live evals as nightly

**Date** 2026-09-21 · **Status** accepted

## Context

The agent loop will cross a model at one point — `src/llm/client.ts` in the § 10 layout,
not yet written — so any end-to-end test of it needs a key, costs money and answers
differently each run, while § 12.2 demands `pnpm test` pass with nothing configured.

## Decision

Record each scenario's exchanges once and replay them by default: `IDP_CASSETTE=record
pnpm test` will write `tests/cassettes/*.json` with a key, plain `pnpm test` will replay
them without one, indexed on `(scenario, agent, turn number)` and never on a hash of the full
prompt. Live evals stay nightly, outside v0.1. Designed, not yet built: stage 2 ships them.

## Rejected alternative

**Calling the real model in the default suite** — the reviewing agent of 12.2 clones,
runs `pnpm test`, hits a missing API key and reports that it verified nothing; that one
failure costs more than the tests prove. It also puts a paid, non-deterministic
dependency on every pull request, where `.github/workflows/ci.yml` reads no secret.

## Consequences

Cassettes are a second artefact to maintain: every intended behaviour change needs someone
with a key to re-record, and a prompt that drifted since recording only warns, so the suite
can stay green while replaying a prompt nobody ships. The nightly eval that would catch
that drift does not exist yet either.
