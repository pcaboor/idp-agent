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
pnpm test             # 617 tests. No API key, no network, no Docker. Ever.
pnpm typecheck        # vitest does not typecheck; this is not redundant
pnpm build
pnpm smoke            # runs the built dist/cli/bin.js, which the suite never does
```

CI runs exactly those five, on Node 22 and 24. A suite that demands a key is a
regression, not a configuration problem.

**Every number on this page is a measurement, and this page has drifted from all of them
before** — a test count one short, an architecture-rule count several short, one module
named as the only importer of the model SDK when there were two. A figure nobody re-ran is
worse than no figure, because it is read as evidence. Re-run the command and correct the
number in the same commit as the change.

**Exit codes:** `0` succeeded — a diff rendered, or a run with nothing to change · `1` the
answer is negative — nothing matched, a name was ambiguous, **the repository does not
conform**, a gate refused a plan, the repair loop stopped at three attempts, or something
failed unexpectedly · `2` the arguments were refused — a bad flag, a plan file that is not
a plan, a `--repo` that is not a directory, a `.idp-agent.yml` that does not parse — or no
model is configured · `3` the request was understood and this build will not act on it: a
change request put to `ask`, a question the model refused, or a plan holding values nobody
can vouch for, **asked rather than guessed**. A command returns
`{ text, found, unsupported? }`; only `cli/index.ts` turns that into a code.

The one that is not obvious is a **stop**: three attempts, still refused, exit `1`. Not
`3`, because `3` is a boundary the user cannot move by typing anything, and a stop is the
opposite — the build acted three times, a gate refused, and a clearer intent can change
the outcome. Not `0`, because a script must not read a stop as a plan. That leaves the
negative answer, which is the same code `plan --from` returns when one of those gates
refuses a plan once.

A `validate` warning does not fail the build: a dangling reference is reported and exits 0,
because a red build there pushes people to delete the declaration, which is what §4.4
forbids.

## Current state — 2026-09-22

`main` carries stages 0 through 3 and the stage 4 plan; history is linear, no merge
commits. Stage 4 itself is a stack of branches, one per task of
`docs/plans/stage-4-preview-only.md`, rebased and merged bottom-up — **none of them on
`main` yet**.

| # | Stage | State |
|---|---|---|
| 0 | Foundations — schemas, serialiser, paths, invariants | done |
| 1 | Read-only — `graph`, `show <entity>` over fixtures | done |
| 2 | Question mode — Supervisor, recordings | done |
| 3 | `init platform` — scaffold, CI, CODEOWNERS, witnesses, `validate` | done |
| 4 | Preview only — Inspector, Architect, `Plan`, diff; writes nothing | on a branch |
| 5 | Write + local branch — `ForgeProvider`, atomicity, idempotence | |
| 6 | GitHub merge request — real forge, negative token test | |
| 7 | Polish — Ink TUI, README, asciinema, npm publish | |

The order is imposed by the doctrine: read first, validate before the first write,
preview before the merge request. Writing arrives only at stage 5.

Shipped and working: `graph` and `show` over a fixture SI of 33 entities; `ask`, answered
by the Supervisor and the Analyst against recordings with no API key; `validate`, six
rules over an IaC repository; `init platform`, which writes twelve files and clobbers
nothing; and stage 4's two previews, which write nothing at all:

```bash
idp-agent plan --from <plan.json> --repo <dir>   # no model, and none is possible
idp-agent plan "<intent>" --repo <dir> [--json]  # Inspector, Architect, five gates
idp-agent init [--repo <dir>]                    # the catalog-info.yml it would write
```

**`init platform` is still the only command that writes**, and only into the directory it
was handed. The two forms of `plan` and `init` read two repositories and produce a unified
diff; `plan-command.test.ts` and `plan-intent.test.ts` hash every path, every byte and
every directory of both repositories either side of a full run rather than taking that on
trust, and `pnpm smoke` makes the same assertion about the built binary.

The two `--repo` flags name different repositories, which is the first thing that trips
someone up. `plan --repo` is the **declarations** repository the preview is decided
against; `init --repo` is the **application** repository being declared. For
`plan "<intent>"` the Inspector reads the directory the user is standing in.

## Layering

```
cli/  ──→  context/   ──→  core/
  ├──→  agents/   ──→  llm/client.ts   (types only — this is the whole rule)
  ├──→  llm/      ──→  the model SDK   (cli/ builds the client; agents/ may not)
  └──→  scaffold/ ──→  core/
```

`cli/` is the only layer that may reach both `llm/` and the disk, which is why the client
is built in `index.ts` and handed to a command rather than chosen inside one — and why
`fileRecordingStore` lives in `cli/` instead of next to the tape it implements.

| Folder | Responsibility |
|---|---|
| `core/` | schemas (Zod), the six validation rules, the JSON Schema export, deterministic YAML serialiser, entity paths, textual surgery, the unified diff, and `core/plan/` — everything between a proposal and a diff |
| `context/` | `ContextProvider` (one implementation: `fixtures`), `iac-fs` snapshots of a declarations repository with provenance, `project-fs` snapshots of an application repository **without its secrets**, `EntityGraph` and its queries |
| `cli/` | argument parsing, commands, rendering, `.idp-agent.yml` — the only layer that writes to stdout |
| `llm/` | the single crossing point: `client.ts` is types only — that is what `agents/` imports — while `providers.ts` and `runtime.ts` are the only modules importing the SDK |
| `agents/` | the five agents, the bounded turn, the repair loop, the tool registries — reaches no disk, transitively |
| `scaffold/` | the `init platform` layout, the packaged templates, and the only writer we own |

Each folder carries its own README stating what lives there, what may not, and which
architecture test holds the line. Read the one for the folder you are about to change.

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

## The trust boundary — built as far as the diff

Everything from the Supervisor to the unified diff runs. What is not built is the far
side: the branch is stage 5 and the merge request is stage 6, so a preview is where a run
ends today.

One object crosses **per direction of authority** (design §5.1, ADR-0007). The **`Plan`**
crosses when the AI side asks for a change. The **`Answer`** crosses when it reports a
read — a union of `entities` / `nothing` / `unanswerable` that authorises nothing and
carries only references the engine's own tools returned, each re-read before printing.
That witness check is a **read-side** guarantee and does not transfer to `propose()`,
which is why the write side has a signature of its own.

```
Supervisor → Inspector → Architect → Reviewer  │  Zod → signature → policies
                                               │  → Reviewer → re-check → Diff
```

The AI chooses the name, owner, environment and `dependsOn`. The **engine** chooses the
file path, serialises the YAML and puts bytes on disk. The model never emits a line of
YAML, only a structure, and `propose()` writes into a typed buffer, never to disk.

> **The agent drafts. The engine signs.**

`Operation` is a closed discriminated union — what is not modelled cannot be requested,
and there is no delete operation in v0.1. The proposal schemas are `strictObject`s with
four deliberate absences, each a guarantee: no `apiVersion`, no `annotations` (there is
nowhere to put `idp-agent.dev/source-file`, which is how a model would aim at its own
path), no `description` (free prose has no provenance, so it signs as `novel` and becomes
a question about a sentence the model just invented), and no path anywhere. Every `Plan`
field a model *chooses* is either a value or `{ unknown: string }`, and a `Plan` holding
an `unknown` cannot be applied: the CLI stops and asks. `metadata.name` is the exception
and not an oversight — an entity with no name is not an entity, so that is refused at the
schema rather than asked about. Orchestration is plain TypeScript; no agent decides the
sequence.

**`signPlan` is the only producer of a `SignedPlan`**, and the brand on that type is a
`declare const` symbol that is never exported — so `checkPolicies`, `recheckPlan` and
`planEdits` taking a `SignedPlan` makes "the engine signs" a compile error rather than a
slogan. The signature says **where a value came from**, never whether it is right: an
owner that exists and is the wrong team signs cleanly. That gap is what a policy is for,
and a diff after that, and the merge after that.

An environment is deliberately **not** enumerable. `prod` always exists, so accepting one
because the catalogue uses it would let a model pick production for a request that named
no environment at all (§4.1). An environment is echoed — the user named it — or novel, and
novel means asked. `.idp-agent.yml`'s `environments` widens what the deterministic gates
can *see*; it does not vouch for anything.

Five gates run over a draft, in this order and for this reason: `zod`, `signature`,
`policy`, `reviewer`, `recheck`. The first three are free, so a draft that cannot survive
them never reaches the one that spends a model call. Three attempts, then a clean stop.

## Conventions

- **English throughout** — code, comments, commit messages, test names, CLI output.
- Conventional Commits. Work on a branch; `main` is reached through a merge request.
- Implementation plans are executed task by task, test first. The plan file is the
  checklist; tick its boxes as you go — Stage 1 shipped with all 36 unticked, which is
  how a plan stops being a status signal.
- No `switch` on a closed union without `const _exhaustive: never = value` in `default`.
- **Thirteen** architecture rules are enforced by `tests/architecture/`. `core/` imports
  neither `agents/`, `llm/`, `context/`, `cli/`, `scaffold/`, the disk, the network nor the
  model SDK. `agents/` imports neither `fs`, `child_process` nor a git client — **and
  nothing reachable from it does either**, the test walks the transitive closure. Only
  `llm/` imports the model SDK, and `agents/` imports `llm/client.js` and nothing else from
  it. `scaffold/` imports `core/` and nothing else of ours; only `write.ts` and
  `templates.ts` touch the disk there, and only `write.ts` imports a writing function. Only
  `context/iac-fs` and `context/project-fs` read a user's repository. Add a rule when you
  add a layer — and re-count this number when you do, because it is the one that drifts
  first: `pnpm vitest run tests/architecture --reporter=verbose`.
- **No test calls a model.** `tests/setup/offline.ts` replaces `fetch` with a thrower
  unless `IDP_RECORDING=record`, so a forgotten recording fails loudly instead of quietly
  spending whoever's key is in the shell. An agent-backed command is driven either by a
  recording or by a scripted client injected through `MainDeps.client` — that seam exists
  so a whole command can be tested end to end with no key and no tape. Recording is a
  deliberate, separate act performed by a human with a key.
- `fixtures/si-demo/` is a valid IaC repository, not a test-only shape: one file per
  entity, in the folder `computeEntityPath` produces, witness files included. `validate`
  reports 33 entities in 33 files and 0 violations over it. Later stages write into it
  directly.
- `.remember/` is one machine's scratchpad, gitignored in full (`*`). It is absent from a
  fresh clone and is not a source of truth about this project — git and this file are.

## Open questions

- **The package is not on npm.** `0.1.0-rc.1` was published and unpublished the same
  hour; the generated `validate.yml` ships with its validation step commented out and
  says so. `package.json` still carries that version and its metadata, ready for the day
  it is published again — which must be `0.1.0-rc.2`, since a version number is never
  reusable.
- A copy of the unpublished tarball is still served by `registry.npmmirror.com`; removal
  has to be requested from them.
- **`draftPlan`'s `vocabulary` parameter is misnamed.** It is the trailing slot of the
  Architect's opening message, concatenated last, and `runIntent` puts the repair report
  there because it is the only seam a caller has. The report must *not* be appended to
  `intent` instead: `signPlan` measures provenance against that string, so a refusal
  naming `group:default/tiger` would make that owner `echoed` on the next attempt and the
  gate that caught the value would end up vouching for it. Worth renaming the parameter
  when someone next touches `architect.ts`.
- **`docs/plans/stage-3-init-platform.md` still documents `init` as a tested refusal.**
  Stage 4 answered that refusal. The historical plan was left alone on purpose — a plan is
  a record of what was decided then — but it is not a description of the code now.
