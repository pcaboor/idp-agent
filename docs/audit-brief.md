# Audit brief — idp-agent

**Written for an independent reviewer.** Everything below is measured or quoted, not
estimated. Where something is unproven or known-broken, it says so; a brief that hides
its weak points wastes the audit.

**Date** 2026-09-23 · **Commit** `c1bb7d8` · **Branch** `feat/access-level`
(Stage 4 merged to `main` as PRs #30–#38.)

---

## 1. What to audit

This is a system whose entire value is that **an LLM cannot cause an unreviewed change to
production infrastructure**. The question is not "does it work" — 687 tests say it runs.
The question is:

> **Is the guarantee real, or does it only look real?**

Specifically:

1. **Can a model get a value into a written file that nobody vouched for?** Every path,
   not the obvious one.
2. **Is the trust boundary actually a boundary**, or does something cross it sideways —
   through an error message, an event, a tool result, a type assertion?
3. **Do the guarantees the code claims in its comments match what the code does?** This
   repository documents heavily. Treat every stated guarantee as a claim to falsify.
4. **What is the worst thing a malicious or merely confused model can do?**

Secondary: is this a reasonable foundation to keep building on, or is something
structurally wrong that should be fixed before stage 5 (which introduces writing)?

---

## 2. The need

A CLI that turns a natural-language intent — *"give billing-api read access to orders-db
in prod"* — into versioned infrastructure declarations (Backstage-shaped YAML) that a
human reviews and merges.

It builds on a declarative reconciliation system already in production (CI/CD triggered by
`catalog-info.yml`, a central IaC repository, provisioning through an API gateway,
firewall automation, ticketing). **This project adds the multi-agent layer that system
never had.**

The stated axis, from `docs/design.md` §2:

> The repository primarily demonstrates **how to build a reliable multi-agent system**:
> deterministic orchestration, structural guardrails, a closed repair loop, and tests that
> reproduce without an API key. Platform GitOps is the application domain, not the subject.
>
> **Tie-breaker** — when two options compete, prefer the one that makes the harness more
> verifiable over the one that adds an integration.

The project is intended to be open-sourced. The repository is currently **private**.

### The threat model, in one sentence

A model produces plausible, schema-valid YAML that grants the wrong team access to the
wrong thing in the wrong environment, and nothing notices because it is *valid*.

---

## 3. What exists

**9 161 lines of source across 63 files; 11 516 lines of test across 55 files.**
687 tests, 52 files, 2.2 s. 13 architecture rules. 21 smoke checks against the built
binary. TypeScript 7 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`).

Production dependencies, all of them:

```
ai 7.0.107 · @ai-sdk/{anthropic,mistral,openai} 4.x · zod ^4.6.0 · yaml ^2.9.0
```

### Module boundaries, enforced by test

| module | may reach |
|---|---|
| `core/` | nothing but itself and `node:path` — no disk, no network, no model SDK |
| `agents/` | `llm/client.js` (types only); no disk, no network, no SDK, **transitively** |
| `context/` | the disk, in exactly three files |
| `scaffold/` | `core/`; two files touch the disk, one of them writes |
| `llm/` | the model SDK — the only module that may |
| `cli/` | everything, and owns the process |

The 13 architecture rules walk the **transitive import closure**, including
`import type` lines. Two of them exist because a type-only import of a module that
imports `node:fs` still puts `node:fs` in the closure.

### The five gates (design §6.1)

A drafted plan passes, in this fixed order:

```
[1] zod  →  [2] signature  →  [3] policies  →  [4] Reviewer  →  [5] re-check
```

- **[1] zod** — refuses what cannot be *expressed*. The proposal schemas are strictly
  narrower than the entity schemas: no `annotations` map (so a model cannot aim
  `idp-agent.dev/source-file` at a path), no `description` (free prose has no provenance).
- **[2] signature** (`core/plan/sign.ts`) — classifies **every leaf** by where its value
  came from: `derived` (the closed union decided it), `echoed` (the user wrote it),
  `enumerated` (the catalogue uses it), `novel` (**nobody can vouch for it** → becomes a
  question). Returns a *branded* type nothing else can construct.
- **[3] policies** — five deterministic predicates: `environment-mismatch`,
  `unwitnessed-folder`, `cross-environment-consumer`, `level-mismatch`,
  `unamendable-level`. No model, no disk. Every operation is gated, `update-entity`
  included — it joins a consumer to an *existing* grant, which is the one operation that
  hands out an authorisation nobody re-declares.
- **[4] Reviewer** — an LLM that sees **only** the plan, the original request, and the
  values the engine computed. Never the Architect's transcript, the attempt number, or an
  earlier gate's reason: it and the Architect are the same weights behind the same
  provider, so their errors are correlated by construction. **It blocks.**
- **[5] re-check** — applies the plan *virtually* and runs the same six `validate` rules
  CI runs over the result. It reads the **bytes the diff shows**, not a second model of
  the plan.

Three attempts, then a clean stop: the partial plan, the reason, nothing written.

### Paths are never model-chosen

`computeEntityPath(type, name)` derives the file path from the type's nature. There is no
field in any proposal schema a path could be written into, and no tool returns one.

### The test harness

`tests/setup/offline.ts` replaces `globalThis.fetch` with a thrower unless
`IDP_RECORDING=record`. **The full suite passes with no API key, no provider configured
and no network** — verified by running it with every relevant variable unset.

Five end-to-end scenarios are recorded against a real model (`gpt-6-luna`, OpenAI) and
replayed by everyone else. Recordings are keyed on `(scenario, agent, turn)` — never on a
prompt hash — so a reworded prompt replays and a changed one warns. Two tests assert no
recording is hand-authored and none carries a credential.

---

## 4. Guarantees claimed, and how each is held

Audit these as claims, not as facts.

| claim | mechanism | test that would catch a regression |
|---|---|---|
| Stage 4 writes nothing | — | `leaves the repository byte-identical` — hashes paths, contents **and directories**, on all five outcome paths, for both repositories; mutation-tested |
| A model cannot choose a file path | no field exists for one | `computes the path itself, whatever else the proposal says` |
| A plan cannot be forged | `declare const` brand, unexported | `cannot be forged, even with every field in place` — verified by deleting the brand and watching `@ts-expect-error` go unused |
| Nothing unvouched-for is written | every leaf classified | `classifies every leaf, so nothing escapes by being nested` + two fast-check properties |
| An environment is never inferred | `.env` excluded from `enumerated` | `asks which one when the request named none, rather than picking prod` |
| `read` is never widened to `readwrite` | `spec.access`, echoed or asked | `never turns a level it was not told into readwrite` |
| Secrets never leave the application repo | `context/project-fs` | seven attack cases in `project-fs.test.ts` |
| The Reviewer is not an echo | it sees plan + request + derivations | `hands the Reviewer the original request, and nothing the Architect saw` |

---

## 5. Known defects and limits — read this section first

### Open, found by adversarial agents, **not yet fixed**

These were demonstrated with running code, not theorised. A fix is in progress for the
first three at the time of writing.

1. **`checkPolicies` skips `update-entity` entirely.** Its loop is
   `if (op !== 'create-entity' && op !== 'create-catalog-info') continue`. So a request
   naming `dev` that joins a consumer to an existing `prod` grant meets no policy at all.
   `update-entity` is the operation that hands an *existing* authorisation to someone new,
   and it is the least gated.
2. **"Already declared" is decided by entity name alone.** A plan whose grant states a
   different level from the file on disk produces an **empty diff** and
   *"nothing to change — the repository already says it"*, exit 0. The tool asserts a
   falsehood about an authorisation in both directions.
3. **Nothing reads the level of a grant an update joins someone to.** A request for `read`
   is satisfiable by one `add-dependency-of` onto a standing `readwrite` grant — and the
   level line is not even in the diff a human merges, because it is an unchanged line in
   an unchanged file.
4. **The Architect's read tools never return `spec.access`.** The model cannot see the
   level of any existing grant, so it is being refused for something it could not know.

### Structural limits, accepted and documented

- **`echoes` tests the whole request, not the clause.** A request naming two levels for
  two resources can make `readwrite` classify `echoed` on the wrong grant. Clause
  attribution is not implemented.
- **The signature says where a value came from, never whether it is right.** An owner that
  exists and is the wrong team signs cleanly. That is what the diff is for — ADR-0006:
  *the merge request is authorisation*.
- **A hard link cannot be contained.** `project-fs` refuses all of them, because a hard
  link has no target to resolve.
- **`spec.access` is optional on entities read from disk** (required on proposals).
  Making it required would have `validate` reject every access declaration in a repository
  that already exists.
- **`init --repo` runs two of the five gates** (zod, signature) and no repair loop. Its
  Architect reads an empty graph and cannot tell whether the component is already declared.

### What a model still does badly

With `gpt-6-luna`, **no recorded scenario produces a diff.** Every run ends in a question
or a refusal, and every reason is legitimate — the Reviewer's latest is
*"the plan only adds billing-api as a dependency of orders-db-prod; it does not grant the
requested read access"*, which is true: the model chose the wrong operation. Two earlier
systematic blockers (owner, access level) were design faults and are fixed.

**This is the single most important open question of the project**: the guardrails work,
and nothing has yet passed them end to end on a real model.

---

## 6. Questions we want answered

1. **Find a path by which a value the signature would call `novel` reaches a written
   file.** Any path — a `{unknown}` that survives, a re-signed plan after an answered
   question, an `update-entity` that never gets classified, a field added between signing
   and writing.
2. **Break the brand.** `SignedPlan` is a `declare const unique symbol` that is never
   exported. Is there a cast, a structural match, a `JSON.parse` round trip, or a test
   helper that mints one?
3. **Get a secret out of `project-fs`.** Seven attacks are covered; find the eighth.
4. **Make the Reviewer useless** — either by feeding it something that biases it toward
   approval, or by showing that its independence is already compromised through a path we
   did not consider.
5. **Is the gate order right?** `[4] Reviewer` costs a round-trip and runs before
   `[5] re-check`, which is free-ish. Is there a cheaper ordering that refuses as much?
6. **Is `update-entity` salvageable as designed**, or should extending an existing grant be
   a different operation with its own schema and its own gates?
7. **Is the recording harness sound?** Keyed on `(scenario, agent, turn)`; a missing entry
   is fatal, a changed digest warns. What does that miss?
8. **Stage 5 introduces writing** (a local branch, then a merge request). Given what you
   find, is anything here not ready to carry that?

---

## 7. How to verify anything in this brief

```bash
pnpm install
pnpm test        # 687 tests — needs no key, no network, no Docker
pnpm typecheck
pnpm build && pnpm smoke     # 21 checks against dist/cli/bin.js
pnpm demo        # end-to-end: scaffolds a repo, previews a plan, hashes it before/after
```

The interesting reading, in order:

| file | why |
|---|---|
| `docs/design.md` | the specification; §4.1, §5.2, §6.1, §7.4 are load-bearing |
| `docs/adr/` | seven decisions, each with what it does **not** cover |
| `src/core/plan/sign.ts` | the write-side guarantee, and its stated limits |
| `src/agents/repair.ts` | the five gates, in order, plain TypeScript |
| `src/agents/reviewer.ts` | why it sees so little |
| `src/context/project-fs/snapshot.ts` | the confinement, and the attacks that shaped it |
| `tests/architecture/dependencies.test.ts` | the 13 rules |
| `tests/scenarios/plan-mode.test.ts` | what a real model actually did |

**Read the comments.** This repository states what each guarantee does *not* cover, in the
file that makes it. Those sentences are the best place to start looking for one that is
no longer true — several have been wrong before, and were found that way.

### Method note

Most defects in this project were found by **attacking the code, not reading it**: agents
told to get a secret out, to escape a directory, to forge a plan. Reading found the
polished parts; attacking found the symlink that defeated the entire exclusion list, the
`{unknown}` field with no length cap, and the gate that refused the engine's own
arithmetic. A review that only reads will report less than one that runs things.
