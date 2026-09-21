# ADR-0001 — deterministic orchestration over model-driven

**Date** 2026-09-21 · **Status** accepted

## Context

Four agents take part in a mutation — Supervisor, Inspector, Architect, Reviewer (docs/design.md
§ 6); something must decide which runs, in what order, and how often it retries. Cassettes replay
per turn (§ 9.3) and tests assert the event sequence (§ 6.2); both need that order to be fixed.

## Decision

Plain TypeScript sequences the agents; no agent decides the sequence. The Supervisor returns one
classification, `MUTATION` or `QUESTION`; the repair loop is a fixed pipeline — Zod, policies,
Reviewer, repository re-check — reporting to the Architect three times at most, then stopping with
a partial plan and writing nothing (§ 6.1). The Supervisor lands at stage 2 and the
Inspector, Architect and repair loop at stage 4 (§ 11); `src/agents/` is unwritten today.

## Rejected alternative

**Let the Supervisor pick its own workers** — an LLM router choosing the next agent and when to
retry. It would make the suite unwritable: cassettes are indexed on `(scenario, agent, turn
number)` (§ 9.3), and a turn number exists only once the order is fixed, so a test asserting the
`AgentEvent` stream would have no constant to assert against. Worse, the three-attempt bound stops
being a bound — a router free to re-dispatch can loop, rarely enough to survive review.

## Consequences

The cost is rigidity: a new step means editing TypeScript and shipping a release, never editing a
prompt, and nothing recovers from an unanticipated case. The Supervisor's classification is the
one free choice left, uncorrectable downstream; what it buys is an offline, assertable run.
