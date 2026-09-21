# ADR-0002 — no write tools for agents; the `Plan` as trust boundary

**Date** 2026-09-21 · **Status** accepted

## Context

An agent holding a file-writing tool can write anywhere, in any shape: a path aimed at another
entity's file, broken indentation, a change nobody reviews. design.md § 5.1 puts exactly one object
on the AI/deterministic boundary; the question was whether a write tool may cross it too.

## Decision

An agent emits a `Plan` and nothing else: an intent plus a closed list of `Operation`s, defined in
`src/core/schemas/plan.ts`. The engine chooses the path (`computeEntityPath`, `resolveEntityPath`),
serialises (`serializeEntity`), and puts the bytes on disk. `propose()` — designed, not yet built —
fills a typed buffer, never the filesystem.

## Rejected alternative

**A `writeFile` tool for the Architect, validated after the fact** — rejected because once YAML text
is the unit of exchange there is nothing left to validate against: a path off by one entity reads
exactly like a deliberate edit, and `tests/architecture/dependencies.test.ts` ("agents/ does not
import fs, git or child_process") becomes unkeepable, the agent needing precisely those imports.

## Consequences

Every new capability costs a variant in `operationSchema`: what is not modelled cannot be requested,
hence no delete operation in v0.1 (design.md § 4.4). `PLAN_LIMITS` bounds operations, depth, nodes and
string length, so a real bulk migration is refused and needs another tool. The rule is cheap today,
`src/agents/` being unwritten; the bill falls on stages 2-7.
