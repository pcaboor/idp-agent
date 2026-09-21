# AGENTS.md

The first file to read. Architecture, invariants, commands. The full specification is
`docs/design.md`; per-stage implementation plans live in `docs/plans/`.

## What this is

A CLI that turns a natural-language intent into versioned infrastructure declarations
that are reviewed, then merged.

The primary subject is **how to build a reliable multi-agent system**: deterministic
orchestration, structural guardrails, a closed repair loop, and tests that reproduce
without an API key. Platform GitOps is the application domain, not the subject.

**Tie-breaker** — when two options compete, prefer the one that makes the harness more
verifiable over the one that adds an integration.

## Commands

```bash
pnpm install          # Node >= 22, pnpm 10
pnpm test             # 305 tests. No API key, no network, no Docker. Ever.
pnpm typecheck        # vitest does not typecheck; this is not redundant
pnpm build
pnpm smoke            # runs the built dist/cli/bin.js, which the suite never does
```

CI runs exactly those five, on Node 22 and 24. A suite that demands a key is a
regression, not a configuration problem.

**Exit codes:** `0` succeeded · `1` the answer is negative — nothing matched, a name was
ambiguous, **the repository does not conform**, or something failed unexpectedly · `2` the
arguments were refused, or no model is configured · `3` the request was understood and this
build will not act on it (a change request, or a question the model refused). A command
returns `{ text, found, unsupported? }`; only `cli/index.ts` turns that into a code.

A `validate` warning does not fail the build: a dangling reference is reported and exits 0,
because a red build there pushes people to delete the declaration, which is what §4.4
forbids.

## Current state — 2026-09-21

Stages 0 and 1 are merged on `main`; history is linear, no merge commits.

| # | Stage | State |
|---|---|---|
| 0 | Foundations — schemas, serialiser, paths, invariants | done |
| 1 | Read-only — `graph`, `show <entity>` over fixtures | done |
| 2 | Question mode — Supervisor, recordings | done |
| 3 | `init platform` — scaffold, CI, CODEOWNERS, witnesses, `validate` | done |
| 4 | Preview only — Inspector, Architect, `Plan`, diff; writes nothing | |
| 5 | Write + local branch — `ForgeProvider`, atomicity, idempotence | |
| 6 | GitHub merge request — real forge, negative token test | |
| 7 | Polish — Ink TUI, README, asciinema, npm publish | |

The order is imposed by the doctrine: read first, validate before the first write,
preview before the merge request. Writing arrives only at stage 5.

Shipped and working: `graph` and `show` over a fixture SI of 33 entities, no AI, no
network, no writes.

## Layering

```
cli/  ──→  context/  ──→  core/
```

| Folder | Responsibility |
|---|---|
| `core/` | schemas (Zod), deterministic YAML serialiser, entity paths, textual surgery |
| `context/` | `ContextProvider` (today: `fixtures`), `EntityGraph` and its queries |
| `cli/` | argument parsing, commands, rendering — the only layer that writes to stdout |
| `llm/` | the single crossing point: `client.ts` is types only, `runtime.ts` alone imports the SDK |
| `agents/` | Supervisor, Analyst, the bounded loop, the tool registry — reaches no disk, transitively |

Rendering returns strings and commands take a graph and return a string, so each is
tested without a terminal. Keep it that way.

## Invariants — non-negotiable

Each has a known cost when violated, and none follows from the documentation of the
tools involved. `docs/design.md` §4 carries the reasoning; do not weaken one without
changing that section first.

**Model**
- A resource is an object; an **access is a right over it**, and the access — not the
  resource — carries the list of its consumers.
- **A declaration is read from both ends.** Which side wrote the edge down —
  `dependsOn` on the consumer, `dependencyOf` on the access — decides which file a
  reviewer sees, never which question may be answered. `dependenciesOf` is the exact
  transpose of `dependantsOf`, resolving one declared hop; composing several hops is a
  separate, separately named walk (`consumersOf`).
- The **environment is part of an access's identity**: dev and staging are two entities.
- **Declare, never infer.** What is unknown is reported as unknown, never filled with a
  plausible value. A dangling reference is surfaced, never pruned.
- **Never ignore in silence.** An entity that fails validation is reported, never
  dropped — that silent drop is the catalogue behaviour this tool exists to compensate.

**Authorisation**
- **The merge is the act of authorisation.** The CLI opens a merge request; it never
  writes to the main branch.
- One token per capability: the token that opens a merge request cannot merge it, and a
  test asserts that this action *fails*.
- Any anti-destruction check is repeated engine-side, at the moment of acting.

**Writing**
- One file per entity, one folder per nature.
- **Textual surgery, never a reparse.** A reviewer must see an added line, not a
  reformatted file.
- An entity's location is read *from the entity*, through its annotation — never
  inferred from its type.
- A blank line between YAML documents, or Git anchors deletions across two entities.
- **Absent means already done.** Removing a line that is no longer there must not raise.

**Reconciliation**
- Never delete an orphaned access automatically. An automaton reports; it does not
  delete.
- Record a date of first absence, never a counter of passes.
- One witness file per folder: a pattern with no match is a read error, not an empty set.
- The catalogue lags the repository by ~2 min: check the repository before proposing,
  **and again at the moment of writing**.

## The trust boundary — not built yet (stage 4)

None of this exists in `src/` today. It is the contract the agent layer must respect
when it lands, and the reason `core/` is shaped the way it is.

Exactly one object crosses from the AI side to the deterministic side: the **`Plan`**
(JSON).

```
Supervisor → Inspector → Architect → Reviewer  │  Zod → Policies → Reviewer
                                               │  → repo re-check → Diff → MR
```

The AI chooses the name, owner, environment and `dependsOn`. The **engine** chooses the
file path, serialises the YAML and puts bytes on disk. The model never emits a line of
YAML, only a structure, and `propose()` must write into a typed buffer, never to disk.

> **The agent drafts. The engine signs.**

`Operation` is a closed discriminated union — what is not modelled cannot be requested,
and there is no delete operation in v0.1. Every `Plan` field is either a value or
`{ unknown: string }`, and a `Plan` holding an `unknown` cannot be applied: the CLI
stops and asks. Orchestration is plain TypeScript; no agent decides the sequence.

## Conventions

- **English throughout** — code, comments, commit messages, test names, CLI output.
- Conventional Commits. Work on a branch; `main` is reached through a merge request.
- Implementation plans are executed task by task, test first. The plan file is the
  checklist; tick its boxes as you go — Stage 1 shipped with all 36 unticked, which is
  how a plan stops being a status signal.
- No `switch` on a closed union without `const _exhaustive: never = value` in `default`.
- Seven architecture rules are enforced by `tests/architecture/`: `core/` imports neither
  `agents/`, `llm/`, the network nor the model SDK; `agents/` imports neither `fs`,
  `child_process` nor a git client, **and nothing reachable from it does either** — the
  test walks the transitive closure; only `llm/` imports the model SDK, and `agents/`
  imports `llm/client.js` and nothing else from `llm/`. Add a rule when you add a layer.
- `fixtures/si-demo/` is a valid IaC repository, not a test-only shape: one file per
  entity, in the folder `computeEntityPath` produces, witness files included. Later
  stages write into it directly.
- `.remember/` is one machine's scratchpad, gitignored in full (`*`). It is absent from a
  fresh clone and is not a source of truth about this project — git and this file are.

## Open questions

- `src/agents/README.md` and `src/llm/README.md` follow when those folders do. Everything
  else `docs/design.md` §12 asks for now exists: `README.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, the per-folder READMEs and `docs/adr/0001`–`0006`.
