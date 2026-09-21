# ADR-0003 — provider interfaces for context and forge

**Date** 2026-09-21 · **Status** accepted

## Context

Two environments must be read and a third written to: Backstage to explore, the IaC repository to
decide on writes, a forge to open the merge request. Stage 1 has only the fictional SI; the other
providers arrive from stage 4 on (design.md § 3, § 11, § 13).

## Decision

`ContextProvider` (`src/context/provider.ts`) declares `name` and `load(): Promise<LoadResult>`,
where `LoadResult` carries `entities` alongside `rejected`: rejections are returned, never thrown
and never swallowed. `FixtureProvider` (`src/context/fixtures/index.ts`) is the only implementation
today; `ForgeProvider` (`src/forge/provider.ts`) is designed, not yet built.

## Rejected alternative

**A concrete Backstage client returning `Entity[]` and throwing on the first malformed file** — it
reproduces both failure modes the tool exists to prevent. The catalogue lags the repository by about
two minutes and ignores duplicates in silence (§ 4.4), so a write decided from it proposes creating
what already exists. And with no `rejected` channel a malformed entity has nowhere to be reported:
the negative test cannot be written.

## Consequences

The interface makes the failure visible; the type system does not force any caller to look.
`EntityGraph` is handed a `LoadResult`'s entities and reads nothing itself, so stage 1 runs with no
API key. The cost: one implementation is shaping the contract, and `iac-fs` may force it to change.
