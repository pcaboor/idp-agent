# Stage 5 — Write and the Local Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

> **Revised on 2026-09-29 against main `d0fdee9` after the stage-5 check
> ([`docs/stage-5-check.md`](../stage-5-check.md)).** The owner wrote this plan on `eee67d6`,
> before `main` moved by 78 commits. The design, the voice and the eight-task split are the
> owner's and stay; what `main` moved, and what the owner decided on 2026-09-29, is folded
> in task by task, each change citing the check (§2 is the owner's code, §3 the plan, §5
> which repository, §7 the decisions D1–D19). Tasks 2, 3 and 7 are rewritten; the others are
> amended; task 8 is spread over the pull requests that make each sentence true. Where a
> figure below was measured at `eee67d6` it says so, and every count is re-measured in the
> pull request that changes it. The owner's start — `src/core/plan/seal.ts`,
> `src/core/paths/catalogue.ts`, `tests/unit/catalogue-path.test.ts`,
> `tests/unit/clear.test.ts` and the hunks in `tests/invariants/arbitraries.ts` and
> `core.test.ts`, uncommitted on `feat/s5-cleared` — is task 1's first steps, and the first
> code pull request brings it in (task 1, "The owner's start").

**Goal:** Turn a previewed plan into a local git branch cut from `HEAD`, created atomically,
never touching the branch the user is on, and recognised rather than duplicated when it is
submitted twice.

**Architecture:** Three merges. **5a** is pure: `core/` gains `Cleared`, a branded value that
only exists for bytes every deterministic gate has passed, **for one named repository**, plus
the byte-level idempotence invariant. **5b** adds `forge/`, a new layer. Its only process is
`git`, started through **the one hardened launcher `project-fs` already uses**, moved to a
leaf module both share, and called through plumbing; a submission becomes visible at exactly
one point: a ref that can only be created, never moved. **5c** wires `--submit` into `plan`
(both roads) and `init`. `init` is also where `.idp-agent.yml` gets written, through an
engine path no model reaches.

**Tech Stack:** TypeScript 7, Node 22+, Vitest 5, Zod 4, `yaml` 2, fast-check 4, the `git`
binary (≥ 2.28) through `node:child_process` — no new npm dependency.

## Global Constraints

Inherited and still binding — `docs/design.md` §4, `AGENTS.md`, `docs/stage-5-brief.md` §1.

- **An LLM cannot cause an unreviewed change to production infrastructure.** Every rule
  below serves that sentence.
- **The CLI never writes to the branch the user is on.** A submission is one new ref under
  `refs/heads/idp-agent/`. `HEAD`, the index, the working tree and every existing ref are
  byte-identical before and after. Tests check this by comparison; nobody takes it on trust.
- **`plan` and `init` without `--submit` still write nothing**, and print what they print
  today byte for byte — `plan`'s `CLOSING`, `init`'s `APPLY` tail. The stage-4 suites that
  hash both repositories stay green unchanged, and one of them now also runs over a git
  clone with `.git/` inside the hash.
- **`pnpm test` needs no API key, no network and no Docker.** It does need a `git` binary.
  CI's ubuntu runners have one, and every git fixture is a `git init` inside a `mkdtemp`.
  The suites that build many real repositories (`tests/invariants/forge.test.ts`) remove
  them in `afterAll` and are run targeted while developing: the owner's machine is short of
  disk (check `df -h /` before a full run; under 2 GiB, run the targeted suites only).
- **`agents/` reaches neither disk, network nor process, transitively.** `forge/` is
  reachable from `cli/` only.
- **`core/` stays pure, now transitively.** It hashes, it never reads or writes.
- **No key and no token reaches git.** Every process `src/` starts is given
  `spawnedEnvironment()` (ADR-0011, `SECURITY.md`), minus every `GIT_*` variable, started
  outside the repository with a bound on time and output — the forge's git as much as the
  Inspector's.
- **No privileged provider, no privileged language.** Nothing in this stage reads the
  request's words. The prompt answer `y`/`yes` is CLI output, which is English throughout.
  Any other answer declines, which is the safe reading. The commit subject is written by the
  engine from the operations; the request goes in the body, labelled as recorded, cut by
  code point (D18).
- **Declare, never infer.** A value nobody vouched for is asked. `.idp-agent.yml` is
  written only from what a person typed.
- **Ask before committing.** No commit, push, PR or merge without the owner's explicit
  go-ahead. The `git commit` lines below are what to run *once that go-ahead is given*.
- **Traceable in the repository** (`AGENTS.md`, Conventions). Every pull request adds its
  line to `CHANGELOG.md` under Unreleased, edits `docs/roadmap.md` when it closes a queue
  item, a debt or an open question, and updates the review's Status section for each review
  id it closes. Each task below ends on that step (check §3, "Missing from all eight tasks").
- English throughout. Conventional Commits. No `switch` on a closed union without
  `const _exhaustive: never = value`. Re-run and correct every count this plan changes
  (tests, files, smoke checks, architecture rules) **in the same commit** that changes it.

### The owner's decisions, 2026-09-29

The check's §7 listed nineteen decisions. The owner chose four, and took the check's
recommendation for the other fifteen as the default, open to change:

| # | Decided | Where it lands |
|---|---|---|
| D1 | The provenance is **sealed into the `SignedPlan`** by `signPlan`; `clearPlan` re-runs the policies against it and never takes one from its caller | task 1 |
| D3 | A **runtime brand** on `Cleared`: a module-private `WeakSet`; the forge refuses any other object | tasks 1, 4 |
| D6 | A plan writing into **both repositories is refused by name**, pointing at `init --submit` | task 1 |
| D15 | The brief is committed as it stands, dated; **this plan is revised in place** | this file |
| D2 | A parity test against the preview in task 1; one `evaluatePlan()` stays in the owner's queue | task 1 |
| D4 | `--submit` is allowed on `--from`, worded by route: four gates, and the merge authorises | tasks 5, 8 |
| D5 | `Confirm` takes a structured summary, not text | task 5 |
| D7 | Our files on a branch whose parent is not the base are refused | task 4 |
| D8 | No `idpa "<phrase>" --submit` at stage 5: exit 2, pointing at `plan "<intent>" --submit` | task 6 |
| D9 | `init --submit` writes no `backstage:`; `--environment`, not `--env`; `--backstage` never takes a value | tasks 2, 7 |
| D10 | The shared git launcher lives in a small leaf module, `src/process/` | task 3 |
| D11 | `--json` gains a `submission` key, its shape pinned by a test | tasks 5, 6 |
| D12 | `init --submit` for a service in a monorepo subfolder is exit 2 at stage 5 | task 7 |
| D13 | `GIT_AUTHOR_*`/`GIT_COMMITTER_*` are scrubbed; the identity comes from git's config, never guessed (`user.useConfigOnly`), probed before any model | tasks 3, 4 |
| D14 | The owner's `/IaC` line goes to `.git/info/exclude`, not `.gitignore` | task 1 |
| D16 | draft-0009 becomes ADR 0012, *proposed* | task 8 |
| D17 | B3 stays after stage 5: the forge writes only objects and a ref, never the working tree | task 4 |
| D18 | The commit subject is engine-written from the operations; the request is in the body, labelled as recorded | task 1 |
| D19 | `--submit` takes `declarationsFor`'s whole chain, and stderr names what chose the root | task 5 |

---

## The guarantee this stage owes

Until now every stage asserted *not one byte*: a test hashes the directory before and after
a preview. This stage replaces that with §4.2:

> The merge is the act of authorisation. The CLI opens a merge request; it never writes to
> the main branch. Confirming in the terminal means "I am submitting my request", not "I am
> authorising myself."

That sentence becomes testable only once "the main branch" is something the code can name.
So the local forge cuts a **real git branch**. It is not a directory with a diff in it (Q1
below).

### What was measured before planning

Everything in this section was run, with git 2.46 in a scratch directory and the suite at
`eee67d6`. None of it comes from reading the code. **It dates from `eee67d6`**: the counts in
it (790 tests, 13 rules, "passes all 13 rules") are that commit's; the table after it is
what the check re-measured on `d0fdee9`.

| Probe | Result | Consequence |
|---|---|---|
| `hash-object` → `mktree` → `commit-tree`, then compare refs, `HEAD`, index and working tree | **identical** until the last step | nothing observable exists before the ref |
| `update-ref <ref> <new> ""` on an existing ref | refused, `reference already exists`, exit 128 | a submission cannot move a ref, `main` included |
| same, aimed at `refs/heads/main` | refused, `main` unchanged | the local analogue of stage 6's negative token test |
| a `reference-transaction` hook in `.git/hooks` | **ran** during `update-ref` | the repository's hooks execute inside our write |
| same with `-c core.hooksPath=/dev/null` | did not run | every git call carries it |
| an inherited `GIT_DIR` plus `git -C <repo>` | **resolved to the other repository** | every `GIT_*` variable is scrubbed |
| `git -C fixtures/si-demo rev-parse --show-toplevel` | `/…/idp-agent`, **the parent repository** | `--repo` must be the root: `--show-prefix` is empty |
| `commit.gpgSign=true` with `commit-tree` | ignored, exit 0 | no signing prompt can appear mid-write |
| `git fsck --unreachable` after an aborted write | one unreachable blob | the one trace a failure leaves, stated as a limit |
| `planEdits` over bytes it already produced, 400 generated `create-entity` plans | `before === after` on every file, **400/400 non-vacuous** | §9.2's "applying twice == applying once" holds over bytes today |
| same property, first attempt | **0/400 exercised**: a random intent made every value `novel`, so every operation dropped | a property needs a vacuity guard; the invariant in task 1 carries one |
| `arbitraryPlan` | generates **no valid right**: a `database-access` without `dependsOn`/`dependencyOf` is refused by the schema | the invariant needs a grant arbitrary of its own |
| a `forge/local/git.ts` importing `node:child_process`, imported from `agents/` | **caught** by the closure rule | `agents/` needs no new rule |
| the same module imported from `core/` | **passes all 13 rules** | `core/`'s disk rule is direct-only |
| the same module imported from `context/` | **passes all 13 rules** | nothing says who may reach `forge/` |
| git driven through `execa` instead | **passes**: `execa` is not in `DISK` | `forge/` may import no package at all |
| `core/`'s disk rule made transitive, on today's code | passes; catches `core/ → forge/local` | the fix costs nothing today |
| a hand-built `PolicyContext` over an empty scaffold | clean: one `dangling-reference` *warning* | the `clear.test.ts` fixtures below are measured, not guessed |
| `update-entity` aimed at a grant declared nowhere | no policy fires; `planEdits` **drops** it | the partial plan `clearPlan` must refuse |
| **tasks 1–4 dry-run in a scratch copy** | 8 defects in this plan's own code, all fixed below; with them, 790 → 826 tests, typecheck clean, 16 rules, each probe failing the rule it names | the code in tasks 1–4 has been run, not just written |
| the atomicity property, during that dry run | **caught a real bug**: a failure just after a successful `update-ref` was reported `already-submitted` | the race recovery in task 4 tells its own commit from a stranger's |
| an adversarial review, with real git | a squatted branch (our files **plus one**) passed as "already submitted"; a hand-written config equal in value was refused as different | `existing()` compares the whole commit; the config is compared by value |

**Re-measured on `d0fdee9` by the check** (§1–§3 there), with the owner's work copied into a
scratch worktree, targeted suites only:

| Probe | Result | Consequence |
|---|---|---|
| `main`'s baseline | 3683 tests, 139 test files, **19** architecture rules (`AGENTS.md:22`, `:537`) | every count above is `eee67d6`'s; each PR re-measures the one it changes |
| `catalogue.ts` as written, the iac-fs walker rewired to it | catalogue-path, iac-fs, iac-fs-provider, validate-command, architecture: **64/64** | task 1 carries it as written |
| `seal.ts` as written, `sign.ts` importing it | `tsc` clean; sign, architecture and the adapted clear test **93/93** | task 1 finishes the extraction |
| `Map.prototype.set.call(sealedMap, 'evil', 2)` in plain Node | **still inserts** | the seal stops an accident, not a caller; the forge's guard is the runtime brand (D3). *Closed in task 1's review:* the brand checks identity, never contents, so `sealed` now keeps its entries in a private field, and the call throws |
| `clear.test.ts` as written, on `main` | **7 compile errors**, all shape drift (`wordsOf`/`answered` left `SignatureContext`; `PolicyContext` gained `over`, `namesakes`; `RepositoryFile` gained `apis`, `ignored`) | rebuilt on `main`'s shapes: **9/9** |
| the §9.2 property as written, on `main` | **0/400 exercised** — its vacuity guard trips: since `5107365` a level or an environment is vouched for only by an answer at its path, and no gate reads `plan.intent` | rebuilt on a `Provenance`: **400/400**, `tests/invariants` 15/15 |
| `questionsOf(plan)` for an update of a right with no environment answered | **0 questions**; with `{ natures }`, **1**, at `operations.0.environment` | `clearPlan` passes the context `runPlan` passes, or it clears what the preview asks (core-plan-3) |
| `arbitraryGrantPlan` at seed 42 | 400/400 schema-valid, `signPlan` refuses none | carried as written |
| `git var GIT_COMMITTER_IDENT` with no `user.name`/`user.email` in any configuration (git 2.46, empty `HOME`) | **exit 0**: git guessed `<login> <<login>@<host>.localdomain>`; with `-c user.useConfigOnly=true`, `var` and `commit-tree` both refuse, exit 128 | the launcher carries `user.useConfigOnly=true` (D13): git may not guess who commits |

---

## Scope, and the contradictions this plan resolves

### Answered before planning

These are the six questions of `docs/stage-5-brief.md` §4. Each was answered from the code
and the probes above, and each answer was agreed before this plan was written. The revision
amends Q1, Q4, Q5 and Q6 where `main` moved (check §3).

- **Q1 — a local branch is a real git branch, cut through plumbing.**
  - `git` runs via `execFile`, with no shell and no npm dependency, through the one
    hardened launcher (task 3).
  - Nothing is checked out; `HEAD`, the index and the working tree are never touched.
  - The preview still works on a plain directory. Only `--submit` requires the declarations
    root — resolved by `declarationsFor`'s whole chain, `--repo` first (D19) — to be the
    root of a git working tree; anything else is exit 2, and so is `--submit` under
    `--demo` or with nothing resolved.
  - The alternative, writing into the working tree, fails three ways:
    - it writes whatever branch is checked out, usually `main`, and one `git commit -a`
      then lands it unreviewed;
    - its rollback is best-effort, and a SIGKILL leaves a partial state;
    - it leaves every git failure mode to stage 6's single week.
- **Q2 — the plan is the unit of meaning; the ref is the unit of atomicity.**
  - One plan becomes one commit, which becomes one branch, in **one** repository: a plan
    whose operations write into both is refused by name (D6).
  - Nothing restores state, because nothing observable is written before `update-ref`.
  - "Failure" covers:
    - a gate refusing, which already stops before any byte;
    - the base moving between the read and the write;
    - the working tree differing from `HEAD`: every file the gates judged must equal
      `HEAD`'s blob byte for byte, checked at the read and again at the write;
    - git failing mid-way;
    - a SIGKILL;
    - the ref already existing (Q3).
  - The forge accepts only a `Cleared`, minted after the free gates are re-run, and checks
    at run time that `clear.ts` minted it (D3). A `SignedPlan` proves signing, not passage.
- **Q3 — the second run reads an unchanged `main`.** The first run cut a branch; it did not
  change `main`. So the re-check does **not** report `already-declared` until the branch is
  merged. Idempotence is held at two levels, both deterministic:
  - **Bytes:** the §9.2 property, in `core/`.
  - **Forge:**
    - the branch name is derived from the content;
    - a second submission of the same bytes finds its own branch — one commit, on the
      base, touching exactly these paths with these bytes — reports it and exits 0;
    - a branch that exists with different content, or on another parent, is exit 1 (D7);
    - no change means no branch.
  - Two model drafts that differ are two plans, and that is not a violation: §9.2
    quantifies over a Plan, not over an intent.
- **Q4 — `--submit`, and `plan` without it stays a preview.**
  - **In a TTY:** the diff, then `[y/N]` on stderr. The default is no; an empty line or
    Ctrl-D declines, which is `fillAnswers`' own rule. `Confirm` is handed a structured
    summary — the root, the paths, the counts, the branch — not a rendered string, so
    stage 7's TUI can reuse the seam (D5).
  - **Without a TTY, or with `--json`:** the flag is the confirmation. That is safe because
    the confirmation was never the guard; the merge is (ADR-0006, design §4.2).
  - Declining at the prompt exits 0 with "not submitted".
  - The vocabulary is *submit*, never *apply*, *approve*, *confirm* or `--yes`.
  - `idpa "<phrase>"` does not take `--submit` at stage 5: exit 2, pointing at
    `plan "<intent>" --submit` (D8).
- **Q5 — `.idp-agent.yml` is written by `init --submit`, through a path with no model.**
  - The values come from `--iac-repo` and `--environment` (repeatable), or from questions
    when those are missing; a non-interactive run exits 3. No `backstage:` is written at
    stage 5, and `--backstage` stays the global boolean that takes no value (D9, ADR-0011,
    `SECURITY.md:161`).
  - `repositoryConfigSchema` is its gate [1], and a test round-trips the file through
    `readConfig`.
  - It goes on the same branch as the service's catalog-info — the file `init` previews,
    `targetOf`'s choice — in the application repository.
  - A committed configuration is never rewritten.
  - Nothing reads `iacRepo` before stage 6, and that is stated.
- **Q6 — `main`'s 19 architecture rules gain the `forge/` rules, and `core/`'s disk rule
  becomes transitive.**
  - `forge/` imports `core/`, the launcher's leaf module and no package.
  - **One module starts a process, as today**: the shared launcher (D10). `SPAWNS` still
    names one spawner, and "every process `src/` starts is given `spawnedEnvironment`"
    still holds. The eee67d6 plan's "only `forge/local/git.ts` starts a process" is false on
    `main`, where `context/project-fs/snapshot.ts` already does (check §3 P3).
  - Only `cli/` reaches `forge/` at runtime.
  - `ForgeProvider` has no `merge`, no `delete` and no way to push to a base.

### The contradictions

**1. `docs/design.md` §10 put git in `core/git/`.** Closed on `main` (#89): §10 already puts
it in `forge/` (`design.md:1209-1231`). Nothing to do.

**2. §8: "Write interrupted → full rollback, initial state restored."** Nothing is rolled
back, because nothing observable exists before the ref. Still stands (`design.md:1146`).

→ §8 says so, and names the one trace a failure leaves: unreachable objects, pruned by
`git gc`. §9.2 defines "initial state" as the *observable* state: refs, `HEAD`, the index,
the working tree. In task 4's pull request.

**3. `scaffold/write.ts`, its README and an architecture-test comment say "Stage 5's atomic
applier replaces this seam".** It does not. `init platform` creates a repository, and a
repository being created has no branch to write to. Still stands (`src/scaffold/write.ts:7`,
`src/scaffold/README.md:17`).

→ The seam stays, and the comments are corrected in task 4's pull request.

**4. `sign.ts`: "Stage 5 hands a `SignedPlan` to a writer"** (`sign.ts:524`). It hands one
to `clearPlan`, and the writer takes a `Cleared`.

→ Corrected in task 1.

**5. The brief's Q3 premise.** "The re-check now reports `already-declared`" is true only
after the merge (see Q3 above).

→ Task 4 tests the forge level and task 1 the byte level. The model level is a stated limit.

**6. `catalog-info.yml` versus `catalog-info.yaml`.** `design.md` §7.2 and §7.3 and
`design.md:13` say `.yml`. `CATALOG_INFO` is `'catalog-info.yaml'`, Backstage's own default,
and `init` files at `targetOf`'s choice, which may be the root's `.yml` (#82).

→ The document is amended in task 7's pull request; `init-command.test.ts`'s title in the
same one.

**7. `SECURITY.md`.** "Stage 1 of 7" is already "stage 4 of 7" on `main` (#78); its "Writes
nothing, except" (`SECURITY.md:34`) and the "check at the moment of writing" item under
*Designed, not yet built* (`:218`) still stand.

→ Edited in each pull request that makes a row true (task 8 lists them).

**8. `AGENTS.md`.** It says "**Nineteen** architecture rules" (`:537`), "`init platform` is
still the only command that writes" (`:171`), "only `project-fs/snapshot.ts` starts a
process", and "Stage 5 is in progress and none of it is on `main`".

→ The rule count and the spawner sentence are corrected in task 3, "the only command that
writes" in task 5, the state in task 7.

**9. Design §4.3: "two concurrent declarations never write the same file"**
(`design.md:173-175`) is false for `update-entity`, whose edit amends a grant's file
(gap-stage5-readiness-12). Two branches amending one grant conflict at the merge, and the
merge request is where that is seen.

→ Reworded in task 4's pull request, with the branch name as the plan's identity.

**10. "Two writers".** `main` already has three modules that write — `scaffold/write.ts`,
`cli/recording-fs.ts`, `cli/trace-sink.ts` (`tests/architecture/dependencies.test.ts:546-552`)
— and the forge is a fourth, through git.

→ `SECURITY.md` and `AGENTS.md` say "the named writers, and the forge through git" in task 4's
pull request.

---

## What the user types

```bash
idp-agent plan --from <plan.json> [--repo <dir>] [--json] [--submit]
idp-agent plan "<intent>" [--repo <dir>] [--json] [--submit]
idp-agent init [--repo <dir>] [--submit] [--iac-repo <locator>] [--environment <name>]...
```

`--submit` is the only new verb, and it names what the user is doing: submitting a request.
Nothing on this page approves anything. The declarations repository is `declarationsFor`'s
(`src/cli/source.ts:225-290`): `--repo`, the working directory on its markers, `IDP_REPO`,
the personal file's `repo`, never a catalogue — and every road but `--repo` is said on
stderr, naming the folder and what named it, as it is today (D19).

| Case | Exit |
|---|---|
| Branch cut; prints `submitted as idp-agent/<slug>-<8 hex> on top of main@<sha> · main untouched` | 0 |
| The same bytes were already submitted, on the same base: the existing branch is named, nothing written | 0 |
| Nothing to change, every operation already declared (#83): no branch, no commit, the stage-4 sentence | 0 |
| Declined at the prompt: `not submitted · nothing written` | 0 |
| Refused at a gate, a partial plan, a plan writing into both repositories (D6), the base moved, working tree ≠ `HEAD`, the branch exists with other content or on another parent (D7), git failed | 1 |
| The resolved root is not a git working tree or not its root, `HEAD` is detached or unborn, no `git` on `PATH`, no committer identity (D13), `--submit` with `--demo` or with no repository resolved, `idpa "<phrase>" --submit` (D8), `init --submit` in a subfolder of a repository (D12) | 2 |
| Questions left and nobody to ask; a plan that changes nothing and nothing says it is satisfied (#83) | 3 — nothing submitted |

Every submitted run still ends on §7.4's line, and a local run says what it did not do:

```
2 files · submitted as idp-agent/orders-db-prod-3f9c2a1b on top of main@abc1234 · main untouched
No merge request is opened: this build has no forge (stage 6).
Nothing is provisioned yet. The merge is what authorises it.
```

---

## File Structure

### 5a — what the engine lets a forge see (no git)

| File | Responsibility |
|---|---|
| `src/core/plan/seal.ts` | `sealed()` — a Map that refuses to change, extracted from `sign.ts` so `clear.ts` can use it *(the owner's, as written)* |
| `src/core/paths/catalogue.ts` | `isCataloguePath`, `isCatalogueFolder` — the one predicate `iac-fs` and the forge share *(the owner's, as written)* |
| `src/core/plan/sign.ts` *(edit)* | imports `sealed`; `SignedPlan` binds a sealed copy of the `Provenance` it was signed with (D1) |
| `src/core/plan/clear.ts` | `Cleared` (branded at compile time and at run time, D3; `repository` named), `clearPlan`, `clearService`, `isCleared`, `branchFor`, `messageFor` |
| `src/core/plan/edits.ts` *(edit)* | `applyEdits` — the bytes after, for the invariant and nothing else |
| `src/core/schemas/config.ts` | `repositoryConfigSchema`, `CONFIG_FILE`, `serializeConfig`, moved out of `cli/` |
| `src/core/plan/catalog-info.ts` | `CATALOG_INFO`, `asCatalogInfo`, `filedIn`, `targetOf`, `isSetAside`, `catalogInfoEdits` — all pure, moved out of `cli/commands/init.ts` |

### 5b — the forge

| File | Responsibility |
|---|---|
| `src/process/environment.ts` | `spawnedEnvironment`, moved from `context/spawned-environment.ts`, with the Backstage variable's name (D10) |
| `src/process/git.ts` | `runGit`, `gitIn` — **the one module in `src/` that starts a process**, shared by `project-fs` and the forge (D10) |
| `src/forge/provider.ts` | `ForgeProvider`, `Base`, `Submitted` — **types only**, like `llm/client.ts` |
| `src/forge/errors.ts` | `ForgeInputError` — the refusals that are the user's arguments (exit 2) |
| `src/forge/local/objects.ts` | `blobId`, `treeOf`, `writeTree` — reading and writing git objects, never a ref |
| `src/forge/local/forge.ts` | `openLocalForge(root, role)` — `base`, `diverges`, `submit` |
| `src/forge/README.md`, `src/process/README.md` | what lives there, what may not, which rules hold the line |
| `tests/support/git.ts` | `git`, `committed`, `observable` — test-side git, isolated from the developer's config |

### 5c — the CLI

| File | Responsibility |
|---|---|
| `src/cli/render/footer.ts` | `CLOSING`, `PreviewStatus`, `closingLines` — the last lines every diff run prints |
| `src/cli/commands/submit.ts` | `Confirm`, `SubmissionSummary`, `SubmitOptions`, `openForSubmission`, `refuseDivergence`, `submit` |
| `src/cli/commands/plan.ts` *(edit)* | `renderPreview` takes a status; both roads take `submit?` |
| `src/cli/commands/init.ts` *(edit)* | `init --submit`, the configuration flags and questions |
| `src/cli/index.ts` *(edit)* | `--submit`, `MainDeps.confirm`, the terminal prompt, `ForgeInputError` → 2, HELP |

Reused rather than rewritten: `planEdits`, `recheckPlan`, `checkPolicies`, `questionsOf`,
`repositoryFileOf`, `renderUnifiedDiff`, `renderQuestions`, `renderRefusedAnswer` (already
exported, `plan.ts:849`), `fillAnswers`, `readRepository`, `readProject` (and its
`declarations`), `readConfig`, `declarationsFor`, `contextsOf`, `hashTree`, the scripted
clients in `plan-intent.test.ts` and `init-command.test.ts`, `tests/support/provenance.ts`,
and `examples/declare-database.json`.

## How this stage ships

One task, one branch, one PR. They are stacked, each on the one before, and merged
bottom-up with `gh pr merge --rebase` once the owner says so. Every PR is green on its own,
lands something demonstrable, and carries its own documents and traceability lines (task 8
lists which document edit rides with which PR). A pull request #0 comes first: the check,
the brief as a dated record, this revision, and ADR 0010 and ADR 0012 *(proposed)*, documents
only.

| # | Branch | Lands | Needs first |
|---|---|---|---|
| 0 | `docs/stage-5-check` | the check, the brief as a record, this plan revised, ADR 0010 and ADR 0012 *proposed* | the owner's reading |
| 1 | `feat/s5-cleared` | `Cleared` for the declarations repository; §9.2's fifth invariant | D1, D3, D6 |
| 2 | `feat/s5-service-cleared` | `core/plan/catalog-info.ts`; `Cleared` for the service repository; config serialised | D9 |
| 3 | `feat/s5-forge-layer` | the shared git launcher, `forge/` types, the new rules | D10, D13 |
| 4 | `feat/s5-local-forge` | the local forge: create-only, idempotent, atomic, for one role | D7, D17 |
| 5 | `feat/s5-plan-submit` | `plan --from --submit`, the prompt, the exit codes, smoke | D4, D5, D11, D19 |
| 6 | `feat/s5-intent-submit` | `plan "<intent>" --submit`, refused before a model is paid | D8 |
| 7 | `feat/s5-init-submit` | `init --submit` and `.idp-agent.yml`; the documents left | D12 |

The owner's `feat/s5-cleared` stays where it is; task 1 starts a new branch of the same name
from `main` after renaming or setting the owner's aside — the owner decides which — and
carries its pieces with the owner as author of what they wrote.

---

# Merge 5a — what the engine lets a forge see

### Task 1: `Cleared` — only bytes every free gate passed reach a forge

**Files:**
- Create: `src/core/plan/seal.ts`, `src/core/paths/catalogue.ts` *(the owner's, as written)*, `src/core/plan/clear.ts`
- Modify: `src/core/plan/sign.ts` (import `sealed`; bind the provenance, D1; correct the stage-5 comment)
- Modify: `src/core/plan/edits.ts` (add `applyEdits`)
- Modify: `src/context/iac-fs/snapshot.ts` (walk with the shared predicate), `src/context/fixtures/index.ts` (the third walker)
- Modify: `src/core/plan/README.md` (two rows)
- Create: `tests/unit/clear.test.ts` *(the owner's, rebuilt)*, `tests/unit/catalogue-path.test.ts` *(the owner's, one case added)*, `tests/unit/clear-parity.test.ts`
- Modify: `tests/invariants/arbitraries.ts`, `tests/invariants/core.test.ts` *(the owner's hunks, the second rebuilt)*
- Modify: `CHANGELOG.md`, `docs/roadmap.md`, `docs/reviews/2026-09-23-deep-review.md` (Status)

**The owner's start.** The first two steps of this task exist, uncommitted, on the owner's
`feat/s5-cleared` at `eee67d6` (check §2): `seal.ts` and `catalogue.ts` created and not wired,
`catalogue-path.test.ts` and `clear.test.ts` written red, `arbitraryGrantPlan` and the §9.2
property added to `tests/invariants/`, and a `/IaC` line in `.gitignore`. None of it is
obsolete. This pull request brings it in — a new branch from `main`, the owner as author of
what they wrote — as follows:

| The owner's piece | Verdict (check §2) | In this task |
|---|---|---|
| `src/core/paths/catalogue.ts` | holds | step 3, as written; the walker rewired (3 lines, measured 64/64) |
| `src/core/plan/seal.ts` | adapt | step 3, as written; `sign.ts` imports it, its private copy goes |
| `tests/unit/catalogue-path.test.ts` | holds | step 1, plus the root `catalog-info.yaml` `init platform` now scaffolds (#86) |
| `tests/unit/clear.test.ts` | adapt | step 1, rebuilt on `main`'s shapes (measured 9/9), plus the cases below |
| `arbitraryGrantPlan` | holds | step 1, as written; its doc comment corrected |
| the §9.2 property | adapt | step 1, rebuilt on a `Provenance` (measured 400/400), plus the effect assertion |
| `.gitignore` `/IaC` | holds | **not in this pull request**: it names the owner's own checkout, so it goes to `.git/info/exclude` (D14) |

**Interfaces:**
- Consumes: `SignedPlan`, `signPlan` (`core/plan/sign.ts`); `Provenance`, `nothingStated`
  (`provenance.ts`); `questionsOf`, `QuestionContext` (`clarify.ts:71-99`, `:172`);
  `checkPolicies`, `PolicyContext` (`policies.ts:95`, `:814-818`); `planEdits` (`edits.ts:71`);
  `recheckPlan`, `Recheck.outcomes` (`recheck.ts:72`, `:181-185`); `FileEdit`
  (`core/diff/unified.ts:21`); `RepositorySnapshot`, `repositoryFileOf`
  (`core/validate/rules.ts:91`, `:104`).
- Produces:
  - `SignedPlan.provenance: Provenance` — a sealed copy, bound by `signPlan` (D1)
  - `const SUBMISSION_PREFIX = 'idp-agent/'`
  - `type Repository = 'declarations' | 'service'`
  - `interface Expectation { readonly files: ReadonlyMap<string, string | undefined>; readonly scope: 'catalogue' | 'touched' }`
  - `interface Cleared { readonly edits: readonly FileEdit[]; readonly expected: Expectation; readonly branch: string; readonly message: string; readonly repository: Repository }` — branded at compile time, deep-frozen, and registered at run time
  - `function isCleared(value: unknown): value is Cleared` — the runtime brand (D3)
  - `interface ClearRefusal { readonly outcome: 'refused'; readonly reasons: readonly string[] }`
  - `interface ClearInput { readonly policy: PolicyContext; readonly snapshot: RepositorySnapshot; readonly contents: ReadonlyMap<string, string> }` — no provenance: it comes with the signature (D1)
  - `function clearPlan(signed: SignedPlan, input: ClearInput): Cleared | ClearRefusal`
  - `function branchFor(edits: readonly FileEdit[], label?: string): string`
  - `function messageFor(plan: Plan, edits: readonly FileEdit[]): string`
  - `function applyEdits(before: ReadonlyMap<string, string>, edits: readonly FileEdit[]): Map<string, string>`
  - `function isCataloguePath(relative: string): boolean` · `function isCatalogueFolder(name: string): boolean`
  - `function sealed<K, V>(entries: ReadonlyMap<K, V>, message: string): ReadonlyMap<K, V>`

`SignedPlan`'s brand proves `signPlan` returned the object once. It does not prove the
policies passed, the re-check found no error, no question is left, or every operation
produced bytes. Those facts live in the wiring of `cli/`, and stage 5 is where a writer
would trust that wiring. `Cleared` removes the need to trust it: its one minting function
**re-runs** the free gates rather than taking their verdicts as arguments, because §4.2
says every anti-destruction check is repeated engine-side at the moment of acting.

Re-running them needs what they were run with. `main` moved three of those inputs since
`eee67d6`, and this task takes each from where it cannot be chosen by the caller:

- **The provenance (D1).** `checkPolicies` requires one (`policies.ts:814-818`), and a
  `SignedPlan` carries `plan`, `paths`, `refs` and `classified` (`sign.ts:74-81`), not the
  provenance it was signed with. Taking it through `ClearInput` would be taking it on the
  caller's word, and a caller holding another provenance could clear a plan the policies
  refused. So `signPlan` binds a sealed copy into the `SignedPlan`, and `clearPlan` reads
  that one. The gates then judge exactly what was signed.
- **The questions' context.** `questionsOf(plan)` finds the signature's own questions from
  the plan alone, but core-plan-3's implied question — the environment of the grant an
  `update-entity` extends (#79) — is raised only when `context.natures` says the target is a
  right (`clarify.ts:233-265`). Measured: 0 questions without the context, 1 with it. So
  `clearPlan` builds the `QuestionContext` `runPlan` builds (`plan.ts:1096-1104`) from the
  `PolicyContext` and the bound provenance; a plan whose preview stopped on that question
  can then never clear.
- **The bytes.** `readRepository` reads each file once (`iac-fs/snapshot.ts:84-106`) and
  `readContents` reads them again (`plan.ts:163-181`): the policies and the re-check judged
  the first read, and the forge proves the second. Inside `clearPlan` the snapshot's files
  are rebuilt from `contents` with the pure `repositoryFileOf`, so the edits and the
  re-check judge the bytes the forge proves; a snapshot whose paths disagree with `contents`,
  or that could not list a folder, is refused. **A limit that remains:** the
  `PolicyContext` (natures, environments, grants, namesakes) is the caller's, built by
  `contextsOf` from the FIRST read (`plan.ts:262-294` iterates `snapshot.files`), and
  `clearPlan` compares the two reads' paths, not their bytes. A file rewritten between
  `readRepository` and `readContents` is judged by the policies and the questions as it
  was, and by the edits, the re-check and the forge as it is. Closing it means building the
  `PolicyContext` from the rebuilt snapshot (the pure part of `contextsOf`, moved to
  `core/`); until then it is stated beside gap-stage5-readiness-6, which this plan closes
  in part.

It also takes two rules `main` added: #83's empty diff — exit 0 only when every operation
other than a `create-catalog-info` is `already-declared` (`changedNothing`,
`plan.ts:465-477`) — and the repository a clearance is for (check §5). `planEdits` drops a
`create-catalog-info` as "writes into the service repository" (`edits.ts:309-313`), so a
plan carrying one beside grants would be refused as "produced no change", which is true and
misleading. It is refused by name instead, pointing at `init --submit` (D6).

- [x] **Step 1: Write the failing tests**

`tests/unit/catalogue-path.test.ts` — the owner's, with the root `catalog-info.yaml`, the
Backstage registration `init platform` now scaffolds (`src/scaffold/layout.ts:60`;
`REGISTRATION_FILE`, `src/core/validate/registration.ts:33`; #86), added to its paths:

```typescript
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCataloguePath } from '../../src/core/paths/catalogue.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'

const PATHS = [
  'root.yml',
  // The Backstage registration: catalogue, and read by iac-fs like any file.
  'catalog-info.yaml',
  'catalog/databases/orders-db-prod.yml',
  'catalog/databases/orders.yaml',
  'catalog/databases/.witness.yml',
  '.idp-agent.yml',
  '.github/workflows/validate.yml',
  'node_modules/pkg/entity.yml',
  'docs/readme.md',
  'catalog/.hidden/inner.yml',
]

describe('which files are catalogue', () => {
  it('says what the reader reads, and nothing else', () => {
    expect(PATHS.filter(isCataloguePath)).toEqual([
      'root.yml',
      'catalog-info.yaml',
      'catalog/databases/orders-db-prod.yml',
      'catalog/databases/orders.yaml',
    ])
  })

  it('agrees with readRepository on a real directory', async () => {
    // Two readers of one repository — iac-fs, and the forge proving the base
    // holds what the gates judged — must not disagree about what a catalogue
    // file is. This guards against the two DRIFTING apart; it passes before
    // the refactor too, because the old walker applied the same rules, so it
    // is not the proof that iac-fs now calls the predicate — reading the diff is.
    const root = await mkdtemp(path.join(tmpdir(), 'idp-catalogue-'))
    for (const file of PATHS) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), '# comment only\n', 'utf8')
    }
    const read = (await readRepository(root)).files.map((file) => file.path).sort()
    expect(read).toEqual(PATHS.filter(isCataloguePath).sort())
  })
})
```

A symbolic-link case is added with B3, after stage 5: the predicate is about names, and B3's
rule is about a file's type (check §2 W1; D17).

`tests/unit/clear.test.ts`. The owner's nine scenarios, rebuilt on `main`'s shapes as the
check measured them (9/9): `SignatureContext` lost `wordsOf` and `answered` (since `5107365`
the provenance is `signPlan`'s third argument, `sign.ts:266-282`), `PolicyContext` gained
`over` and `namesakes`, `RepositoryFile` gained `apis` and `ignored`. The provenance is
`saidInFull` from `tests/support/provenance.ts`, and it travels **with the signature**, not
in `input` (D1):

```typescript
import { describe, expect, it } from 'vitest'
import {
  branchFor,
  clearPlan,
  isCleared,
  SUBMISSION_PREFIX,
  type Cleared,
  type ClearRefusal,
} from '../../src/core/plan/clear.js'
import { namesakesOf } from '../../src/core/plan/environment.js'
import type { PolicyContext } from '../../src/core/plan/policies.js'
import { nothingStated } from '../../src/core/plan/provenance.js'
import { signPlan, type SignatureContext } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import type { RepositorySnapshot } from '../../src/core/validate/rules.js'
import { saidInFull } from '../support/provenance.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api', 'service'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger'],
}

const signature: SignatureContext = {
  witnessed: new Set(['component:default/billing-api', 'resource:default/nowhere-prod']),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
}

const policy: PolicyContext = {
  vocabulary,
  witnesses: new Set(['catalog/databases', 'dependencies/access']),
  environments: new Map(),
  levels: new Map(),
  natures: new Map(),
  over: new Map(),
  namesakes: namesakesOf([]),
}

/** A freshly scaffolded repository: folders and witnesses, no entity. */
const empty: RepositorySnapshot = {
  folders: ['catalog', 'catalog/databases', 'dependencies', 'dependencies/access'],
  witnesses: ['catalog/databases', 'dependencies/access'],
  files: [],
}

const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

const DATABASE = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db-prod', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

const ACCESS = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: 'database-access',
      access: 'read',
      owner: 'group:default/tiger',
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: ['component:default/billing-api'],
    },
  },
}

const DATABASE_PATH = 'catalog/databases/orders-db-prod.yml'
const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'

/** Signed as a person who said it all: the level and each environment answered at their paths. */
const sign = (intent: string, operations: unknown[]) => {
  const plan = planSchema.parse({ intent, operations })
  const result = signPlan(plan, signature, saidInFull(plan))
  if ('outcome' in result) throw new Error(JSON.stringify(result.refusals))
  return result
}

const input = { policy, snapshot: empty, contents: new Map<string, string>() }

const cleared = (result: Cleared | ClearRefusal): Cleared => {
  if ('outcome' in result) throw new Error(result.reasons.join('\n'))
  return result
}

const refusal = (result: Cleared | ClearRefusal): readonly string[] =>
  'outcome' in result ? result.reasons : []

describe('clearPlan', () => {
  it('clears a plan every free gate passes, keeping only the edits that change a byte', () => {
    const result = cleared(clearPlan(sign(INTENT, [DATABASE, ACCESS]), input))

    expect(result.edits.map((edit) => edit.path)).toEqual([DATABASE_PATH, ACCESS_PATH])
    expect(result.repository).toBe('declarations')
    expect(result.expected.scope).toBe('catalogue')
    // A created file is expected ABSENT at the base: one that appeared
    // meanwhile is a divergence, never something to merge into.
    expect([...result.expected.files]).toEqual([
      [DATABASE_PATH, undefined],
      [ACCESS_PATH, undefined],
    ])
    expect(result.branch).toMatch(/^idp-agent\/orders-db-prod-[0-9a-f]{8}$/)
    // Written by the engine from the operations, never from the request (D18).
    expect(result.message.split('\n')[0]).toBe(
      'idp-agent: declare orders-db-prod, declare billing-api-orders-db-prod',
    )
  })

  it('refuses a plan that still asks a question', () => {
    // An owner nobody vouches for is a question (§5.4), and a question is not
    // a value a branch can carry.
    const ghost = {
      ...DATABASE,
      entity: { ...DATABASE.entity, spec: { type: 'database', owner: 'group:default/ghost' } },
    }
    const reasons = refusal(clearPlan(sign(INTENT, [ghost]), input))
    expect(reasons.join('\n')).toContain('operations.0.entity.spec.owner')
  })

  it('refuses a policy violation, re-run here rather than taken on trust', () => {
    const reasons = refusal(
      clearPlan(sign(INTENT, [DATABASE]), {
        ...input,
        policy: { ...policy, witnesses: new Set<string>() },
      }),
    )
    expect(reasons.join('\n')).toContain('unwitnessed-folder')
  })

  it('refuses a plan part of which would not land — a branch carries all of it or nothing', () => {
    // Measured: no policy fires on an update aimed at a grant declared
    // nowhere, and planEdits drops it. The preview lists the drop and exits 0;
    // a branch holding the database without the grant is the "grants nothing"
    // state the audit spent a round closing.
    const update = {
      op: 'update-entity',
      entityRef: 'resource:default/nowhere-prod',
      patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api', access: 'read' },
    }
    const reasons = refusal(
      clearPlan(sign(`${INTENT} and resource:default/nowhere-prod`, [DATABASE, update]), input),
    )
    expect(reasons.join('\n')).toContain('operations.1')
    expect(reasons.join('\n')).toContain('the whole plan or nothing')
  })

  it('clears a plan the repository already states, with no edit to carry', () => {
    const first = cleared(clearPlan(sign(INTENT, [DATABASE]), input))
    const onDisk = new Map(first.edits.map((edit) => [edit.path, edit.after] as const))
    const snapshot: RepositorySnapshot = {
      ...empty,
      files: [
        {
          path: DATABASE_PATH,
          entities: [
            {
              apiVersion: 'backstage.io/v1alpha1',
              kind: 'Resource',
              metadata: {
                name: 'orders-db-prod',
                annotations: { 'company.fr/env': 'prod' },
              },
              spec: { type: 'database', owner: 'group:default/tiger' },
            },
          ],
          apis: [],
          rejections: [],
          ignored: [],
          documents: 1,
        },
      ],
    } as RepositorySnapshot
    const again = cleared(clearPlan(sign(INTENT, [DATABASE]), { ...input, snapshot, contents: onDisk }))
    expect(again.edits).toEqual([])
  })

  it('is frozen, and its maps refuse to change', () => {
    const result = cleared(clearPlan(sign(INTENT, [DATABASE, ACCESS]), input))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.edits)).toBe(true)
    expect(() => (result.expected.files as Map<string, string>).set('x.yml', 'x')).toThrow(TypeError)
  })

  it('cannot be written by hand', () => {
    // @ts-expect-error a Cleared is minted by clear.ts or not at all
    const forged: Cleared = { edits: [], expected: { files: new Map(), scope: 'touched' }, branch: 'main', message: '', repository: 'declarations' }
    expect(forged.branch).toBe('main')
  })
})

describe('branchFor', () => {
  const edit = (path: string, after: string) => ({ path, before: undefined, after })

  it('names a branch by its bytes, whatever order the edits came in', () => {
    const a = edit('catalog/databases/a.yml', 'a\n')
    const b = edit('dependencies/access/b.yml', 'b\n')
    expect(branchFor([a, b])).toBe(branchFor([b, a]))
    expect(branchFor([a, b])).not.toBe(branchFor([a, edit('dependencies/access/b.yml', 'c\n')]))
  })

  it('never produces a ref git refuses, whatever the entity is called', () => {
    // `orders..db` is a legal entity name and an illegal ref component.
    const name = branchFor([edit('catalog/databases/orders..db.lock.yml', 'x\n')])
    expect(name.startsWith(SUBMISSION_PREFIX)).toBe(true)
    expect(name).toMatch(/^idp-agent\/[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/)
    expect(name).not.toContain('..')
  })
})
```

Then the cases the check adds (§2 W4, §5), in the same file. They are new in this revision
and not yet measured; write each red first:

- **The provenance comes with the signature (D1).** `ClearInput` has no `provenance`: an
  `@ts-expect-error` on `{ ...input, provenance: saidInFull(plan) }` holds it. The grant
  plan signed under `saidInFull` clears; the same operations signed under
  `nothingStated()` are refused, naming `operations.1.entity.spec.access` — the level is
  vouched for only by an answer at its path.
- **An update's implied environment is asked, as the preview asks it** (core-plan-3). A
  snapshot declaring the grant `resource:default/billing-api-orders-db-prod` (a
  `database-access` in prod), `policy.natures` naming it a right, and an `update-entity`
  adding a consumer to it, signed with the level answered and no environment answered:
  refused, naming `operations.0.environment`. With `userSaid(intent, { 'operations.0.environment': 'prod', … })`
  it clears.
- **#83's empty diff.** The same update when the grant already lists that consumer at
  another level: no byte changes and the re-check's outcome is not `already-declared`, so it
  is refused as "produced no change, and the repository does not already say it" — never
  minted as an empty `Cleared` the forge would call `unchanged` on exit 0.
- **A snapshot that could not be read whole.** `{ ...empty, unreadable: [{ path: 'catalog', reason: 'EACCES' }] }`
  is refused by `clearPlan`, not left to the forge.
- **Two reads that disagree.** A `snapshot.files` path missing from `contents`, and a
  `contents` path missing from `snapshot.files`: each refused, naming the path.
- **A mixed plan (D6).** A `create-catalog-info` beside the grant is refused with its own
  reason, naming `operations.N` and `init --submit` — never "produced no change".
- **The runtime brand (D3).** `isCleared(result)` is true; `isCleared({ ...result })`,
  `isCleared(structuredClone(result))` and `isCleared(forged)` are false.
- **The subject is the engine's (D18).** A request holding U+202E and a C1 control, and one
  of 300 characters in a script written without spaces: the first line of `message` is
  `idp-agent: ` and the operations, every line holds none of U+0000–U+001F, U+007F–U+009F,
  U+202A–U+202E, U+2066–U+2069, and the recorded request is cut at a code point with `…`,
  never inside a surrogate pair.

`tests/unit/clear-parity.test.ts` — the parity test that stands in for one `evaluatePlan()`
(D2, architecture-1, gap-stage5-readiness-10): `clearPlan` orders the questions, the
policies, the edits and the re-check on its own, beside `runPlan`'s loop and `repair`'s, so a
table of fixtures drives both. For each — `examples/declare-database.json` over a scaffolded
repository, the same with a stray owner, an update of a declared grant, an update already
declared, a mixed plan — the preview runs through `main(['plan', '--from', …, '--repo', …])`
with `answering(...)`, and the clearance through the signature and contexts `runPlan` builds
(export `contextsOf` for the test, or add a `clearFor(root, plan, answers)` helper to
`plan.ts`; the choice is this pull request's). Every preview that ends on a diff and exit 0
clears; every preview refusal, question or exit 3 refuses. "One evaluation for every route"
stays in the owner's queue (`docs/roadmap.md`).

In `tests/invariants/arbitraries.ts`, add the owner's grant generator. `arbitraryPlan` never
produces a valid right: the probe measured that. Its doc comment is corrected — the level and
the environment are answered at their paths by the test, not read from the intent (check §2
W5). The intent it builds is still needed: a composed right name (`consumer-database`) is
vouched for only by words whose `wordsOf` is `'user'` (`provenance.ts:73-74`), carried by the
provenance's `intent`, not `plan.intent`. Batch B1 builds on this generator rather than
writing a second one.

```typescript
/**
 * A database and a right over it, which the proposal schema accepts: a right
 * is over something and granted to somebody (§4.1). `arbitraryPlan` cannot
 * produce one, because its rights carry neither `dependsOn` nor
 * `dependencyOf` and the schema refuses them — so without this, §9.2's
 * idempotence property never met a grant.
 *
 * The intent names the database, the consumer and the right, so the composed
 * right name is vouched for by a person's words. The level and the
 * environment are not: no word states either, and the property answers them
 * at their paths (`asDrafted` in core.test.ts).
 */
export const arbitraryGrantPlan = fc
  .record({
    database: entityName,
    consumer: entityName,
    env: fc.constantFrom('dev', 'staging', 'prod'),
    level: fc.constantFrom('read', 'readwrite'),
  })
  .filter(({ database, consumer }) => database !== consumer)
  .map(({ database, consumer, env, level }) => {
    const right = `${consumer}-${database}`.slice(0, 63).replace(/[._-]+$/, '')
    return {
      intent:
        `declare ${database} in ${env} owned by group:default/tiger and give ` +
        `component:default/${consumer} ${right} on resource:default/${database}`,
      operations: [
        {
          op: 'create-entity' as const,
          entity: {
            kind: 'Resource' as const,
            metadata: { name: database, env },
            spec: { type: 'database', owner: 'group:default/tiger' },
          },
        },
        {
          op: 'create-entity' as const,
          entity: {
            kind: 'Resource' as const,
            metadata: { name: right, env },
            spec: {
              type: 'database-access',
              access: level,
              owner: 'group:default/tiger',
              dependsOn: [`resource:default/${database}`],
              dependencyOf: [`component:default/${consumer}`],
            },
          },
        },
      ],
    }
  })
```

In `tests/invariants/core.test.ts`, the fifth invariant of §9.2. It carries a vacuity guard,
because the first attempt at it passed 400 times while exercising nothing — and the guard did
its job again on `main`: the owner's hunk, which set `answered` on the signature context and
rewrote `plan.intent`, exercised 0 of 400, since neither is read any more (check §2 W6). Rebuilt
on a `Provenance`, as measured (400/400). `saidInFull` alone does not do: it answers one fixed
level, and the generator draws `read` and `readwrite`.

```typescript
import { applyEdits, planEdits } from '../../src/core/plan/edits.js'
import type { Provenance } from '../../src/core/plan/provenance.js'
import type { Plan } from '../../src/core/schemas/plan.js'
import { environmentsAnswered, userSaid } from '../support/provenance.js'
import { arbitraryGrantPlan } from './arbitraries.js'

/** The person confirms, at its own field, every level and environment the draft wrote. */
const asDrafted = (plan: Plan): Provenance =>
  userSaid(plan.intent, {
    ...environmentsAnswered(plan),
    ...Object.fromEntries(
      plan.operations.flatMap((operation, index) =>
        operation.op === 'create-entity' &&
        operation.entity.kind === 'Resource' &&
        typeof operation.entity.spec.access === 'string'
          ? [[`operations.${index}.entity.spec.access`, operation.entity.spec.access]]
          : [],
      ),
    ),
  })

/**
 * The request names every value, so the signature echoes them and nothing is
 * asked. The words reach the gates through the provenance `asDrafted` builds
 * from this intent — no gate reads `plan.intent`.
 */
const echoing = (raw: { intent: string; operations: { entity: { metadata: { name: string; env: string }; spec: Record<string, unknown> } }[] }) => ({
  ...raw,
  intent: raw.operations
    .flatMap(({ entity }) => [
      entity.metadata.name,
      entity.metadata.env,
      String(entity.spec['type']),
      String(entity.spec['owner']),
    ])
    .join(' '),
})

it('applying a plan twice leaves the bytes applying it once left (§9.2)', () => {
  let exercised = 0
  fc.assert(
    fc.property(
      fc.oneof(arbitraryPlan.map(echoing), arbitraryGrantPlan),
      arbitraryHandWrittenFile,
      (raw, noise) => {
        const parsed = planSchema.safeParse(raw)
        fc.pre(parsed.success)
        if (!parsed.success) return
        const signed = signPlan(parsed.data, signatureContext, asDrafted(parsed.data))
        fc.pre(!('outcome' in signed))
        if ('outcome' in signed) return

        const base = new Map([['catalog/noise.yml', noise]])
        const first = planEdits(signed, base)
        const once = applyEdits(base, first.edits)
        const second = planEdits(signed, once)

        if (first.edits.some((edit) => edit.before !== edit.after)) exercised += 1
        for (const edit of second.edits) expect(edit.after).toBe(edit.before)
        expect([...applyEdits(once, second.edits)]).toEqual([...once])
      },
    ),
    { numRuns: 400 },
  )
  // A property that never saw a change has proven nothing about one. Measured
  // on d0fdee9: 400/400 exercised (0/400 before the property was given a
  // Provenance — the guard caught it). Re-measure the share of grant plans and
  // write it here.
  expect(exercised).toBeGreaterThan(100)
})
```

Add the effect the review asked for (gap-stage5-readiness-11): the second pass's re-check —
`recheckPlan(signed, snapshotOf(once), second.edits)`, the snapshot rebuilt with
`repositoryFileOf` — reports every operation `already-declared`. `main`'s own
`signatureContext` in this file still carries the dead `wordsOf` and `answered`
(`tests/invariants/core.test.ts:21`, `:31`); drop them here, or leave them to B1 and say so
in the pull request.

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/unit/clear.test.ts tests/unit/clear-parity.test.ts tests/unit/catalogue-path.test.ts tests/invariants/core.test.ts`
Expected: FAIL — `clear.js`, `catalogue.js` and `applyEdits` do not exist.

- [x] **Step 3: Extract `sealed`, and write the catalogue predicate** *(the owner's code, as written)*

`src/core/plan/seal.ts`. The body moves out of `sign.ts` unchanged, except that the
message is now a parameter. The §5.2 rationale the deleted doc block in `sign.ts` gave —
`paths` is the field §5.2 is about, the engine chooses where bytes go — moves here with it,
and the limit the check measured is stated: `Map.prototype.set.call(map, …)` still inserts
(check §2 W2), so the seal stops an accident, not a determined caller. The forge's guard is
the runtime brand (D3), not the seal.

```typescript
/**
 * A Map that refuses to change.
 *
 * `Object.freeze` does nothing to one: `set` lives on the prototype and writes
 * internal slots, so a frozen Map is still a writable Map. The mutators are
 * shadowed on the instance (non-writable and non-configurable by
 * `defineProperty`'s defaults, so the shadow cannot be removed), and the
 * instance is then frozen.
 *
 * Shared because two values need it: the paths a signature computed, and the
 * bytes a clearance vouches the base still holds. Either one, moved after the
 * fact, is a value no gate judged. `paths` is the field §5.2 is about — the
 * engine chooses where bytes go, and a model cannot aim at a path — so leaving
 * it writable would leave the strongest guarantee in the design as the one
 * field a mutation could still move.
 *
 * What this does NOT cover: `ReadonlyMap` already said no at compile time, and
 * this only answers the cast that ignores it — and not every one of those:
 * `Map.prototype.set.call(map, key, value)` reaches the internal slots past the
 * shadow (measured). It stops an accident, not a determined caller; what a
 * forge trusts is `isCleared` (`clear.ts`).
 */
export const sealed = <K, V>(entries: ReadonlyMap<K, V>, message: string): ReadonlyMap<K, V> => {
  const map = new Map(entries)
  const refuse = (): never => {
    throw new TypeError(message)
  }
  for (const mutator of ['set', 'delete', 'clear']) {
    Object.defineProperty(map, mutator, { value: refuse })
  }
  return Object.freeze(map)
}
```

*Revised in review.* `isCleared` checks a clearance's identity, never its contents, and
`expected.files` is what task 4's `diverges()` proves the base against: a borrowed
`Map.prototype.delete.call` emptied it with the brand still true. `sealed` now returns a
frozen object that is not a Map — its entries in a private field, which Map's own methods
refuse as a receiver — implementing `ReadonlyMap`, its `set`/`delete`/`clear` throwing the
message. The interface is unchanged; `clear.test.ts` and `sign.test.ts` assert the borrowed
call throws.

In `sign.ts` (`:593-602` on `d0fdee9`), delete the local `sealed`,
`import { sealed } from './seal.js'`, and call `sealed(paths, SEALED)` /
`sealed(refs, SEALED)` (`:507-508`). Replace the sentence (`:524`) "Stage 5 hands a
`SignedPlan` to a writer, and "signed" has to mean the bytes it composes are the ones the
gates judged." with:

```typescript
 * Stage 5 hands a `SignedPlan` to `clearPlan`, which re-runs the free gates
 * against the provenance bound here and mints the only value a forge accepts,
 * and "signed" has to mean the bytes it composes are the ones the gates judged.
```

`src/core/paths/catalogue.ts`:

```typescript
/**
 * Which files of a declarations repository are catalogue.
 *
 * Two readers ask, and they must not disagree: `context/iac-fs` walks a
 * directory, and the forge proves a commit holds exactly what the gates judged.
 * A file one of them counts and the other does not is a file a submission
 * could carry past every gate — so the rule lives here once, and a test walks a
 * real directory to prove the reader uses it.
 *
 * Hidden is tooling, never catalogue: `.github` holds workflows, `.git`
 * objects, `.idp-agent.yml` this tool's own configuration, and a `.witness.yml`
 * declares nothing (design §4.4). `node_modules` is somebody else's.
 *
 * About names only. Whether a file is a symbolic link is a question about its
 * type, which B3 answers (docs/roadmap.md), not this predicate.
 */
const YAML = /\.ya?ml$/

export const isCatalogueFolder = (name: string): boolean =>
  !name.startsWith('.') && name !== 'node_modules'

export function isCataloguePath(relative: string): boolean {
  const segments = relative.split('/')
  const file = segments.pop()
  if (file === undefined || file.startsWith('.') || !YAML.test(file)) return false
  return segments.every(isCatalogueFolder)
}
```

In `src/context/iac-fs/snapshot.ts`, `walk` asks the predicate instead of restating it —
folders at `:65`, hidden files at `:77`, `YAML_EXTENSIONS` at `:22` and `:78`. The directory
branch becomes `if (!isCatalogueFolder(entry.name)) continue`. The file branch replaces both
the hidden-file skip and the extension test with:

```typescript
    if (isCataloguePath(relative(root, full))) found.files.push(full)
```

Keep the two long comments that explain why each rule exists; they now explain the
predicate. `YAML_EXTENSIONS` goes. `WITNESS` stays, because witness detection is a
different question. The architecture test accepts `context/` importing `core/paths`
(measured).

A third walker restates the folder rule: `src/context/fixtures/index.ts:10-24`, the demo SI's,
which does not skip hidden files. Point it at `isCatalogueFolder` too, or say in a comment why
it differs.

- [x] **Step 4: Bind the provenance to the signature (D1)**

In `src/core/plan/sign.ts`, `SignedPlan` gains the provenance it was signed with, sealed:

```typescript
export interface SignedPlan {
  readonly plan: Plan
  /** Engine-computed, repository-relative. Never read from the proposal. */
  readonly paths: ReadonlyMap<number, string>
  readonly refs: ReadonlyMap<number, string>
  readonly classified: readonly LeafFinding[]
  /**
   * What the user stated when this plan was signed: the one provenance every
   * later gate is re-run against. Bound here so a clearance judges exactly
   * what was signed (D1) — a provenance handed to `clearPlan` beside the plan
   * would be the caller's word, and a caller holding another one could clear
   * a plan the policies refused.
   */
  readonly provenance: Provenance
  readonly [signature]: true
}
```

`signPlan` returns it as
`provenance: Object.freeze({ intent: provenance.intent, wordsOf: provenance.wordsOf, answers: sealed(provenance.answers, SEALED) })`.
No caller changes: the provenance was already `signPlan`'s third argument, and
`checkPolicies` keeps taking one — a round's, which the ask loop changes between passes.
`pnpm typecheck` finds any test that builds a `SignedPlan` by hand.

- [x] **Step 5: Write `applyEdits` and `clear.ts`**

Append to `src/core/plan/edits.ts` *(measured on `d0fdee9`)*:

```typescript
/**
 * The bytes a repository holds once `edits` are applied. Pure, and used by the
 * one property that needs it: §9.2's "applying twice == applying once". The
 * forge does not call it — it writes git objects, not a map.
 */
export function applyEdits(
  before: ReadonlyMap<string, string>,
  edits: readonly FileEdit[],
): Map<string, string> {
  const after = new Map(before)
  for (const edit of edits) after.set(edit.path, edit.after)
  return after
}
```

`src/core/plan/clear.ts`. The owner's text, measured to compile on `d0fdee9` once
`checkPolicies` is handed a provenance; the lines marked **new** are this revision's
additions, not yet measured, and are written test first against the cases of step 1:

```typescript
import { createHash } from 'node:crypto'
import type { FileEdit } from '../diff/unified.js'
import type { Plan } from '../schemas/plan.js'
import { repositoryFileOf, type RepositorySnapshot } from '../validate/rules.js'
import { questionsOf } from './clarify.js'
import { planEdits } from './edits.js'
import { checkPolicies, type PolicyContext } from './policies.js'
import { recheckPlan } from './recheck.js'
import { sealed } from './seal.js'
import type { SignedPlan } from './sign.js'

/**
 * What a forge is allowed to see: bytes every deterministic gate has passed,
 * the bytes they were computed against, and the repository they are for.
 *
 * `SignedPlan`'s brand proves the plan was signed. It does not prove a policy
 * passed, that the re-check found no error, that no question is left, or that
 * every operation produced bytes — those facts live in the wiring of `cli/`,
 * and a writer that trusted the wiring would be the one place the engine took
 * a caller's word for it. So minting RE-RUNS the free gates rather than taking
 * their verdicts as arguments: §4.2's "any check that guards against
 * destruction is repeated engine-side, at the moment of acting". Against the
 * provenance the plan was signed with (D1); the edits and the re-check over
 * one reading of the bytes — the `PolicyContext` is the caller's, built from
 * the first read, a limit stated beside gap-stage5-readiness-6.
 *
 * What this does NOT prove: that the Reviewer approved. That gate is a model,
 * it cannot be re-run for free, and the `--from` road has none. The merge is
 * still the act of authorisation (ADR-0006).
 */

declare const cleared: unique symbol

/** Every branch a submission may create lives under this, and nowhere else. */
export const SUBMISSION_PREFIX = 'idp-agent/'

const SEALED = 'a clearance is what the gates judged; clear the plan again'

/**
 * Which repository a clearance writes into (check §5). A `FileEdit` names a
 * path and nothing says whose: since #86 the declarations repository has a
 * root `catalog-info.yaml` too, so the same path names a file in both. The
 * role goes on the value that crosses to a forge, set here and nowhere else,
 * and the forge is opened for one.
 */
export type Repository = 'declarations' | 'service'

/**
 * What the gates judged: path → bytes, or `undefined` for a path judged ABSENT.
 * The forge proves the base still holds exactly this before it writes.
 *
 * `catalogue` means every catalogue file of the base must be in `files` — the
 * gates judged the whole repository. `touched` means only the listed paths
 * matter: a service repository is not a catalogue. The scope follows from the
 * repository, and `mint` alone sets it.
 */
export interface Expectation {
  readonly files: ReadonlyMap<string, string | undefined>
  readonly scope: 'catalogue' | 'touched'
}

export interface Cleared {
  /** Only the edits that change a byte, in path order. */
  readonly edits: readonly FileEdit[]
  readonly expected: Expectation
  /** Computed by the engine from the bytes; a forge never takes a name from a caller. */
  readonly branch: string
  readonly message: string
  readonly repository: Repository
  readonly [cleared]: true
}

export interface ClearRefusal {
  readonly outcome: 'refused'
  readonly reasons: readonly string[]
}

/** No provenance here: it is the one the plan was signed with (D1). */
export interface ClearInput {
  readonly policy: PolicyContext
  readonly snapshot: RepositorySnapshot
  /** The bytes of that snapshot, path → text, as the preview composed against. */
  readonly contents: ReadonlyMap<string, string>
}

/**
 * Every `Cleared` this module minted — and nothing else (D3). The compile-time
 * brand stops a hand-built literal; a spread, a cast or `structuredClone` of a
 * real one still type-checks, and would put arbitrary bytes on an `idp-agent/`
 * branch. A `WeakSet` holds identities no other module can add to, and lets go
 * of them with the value.
 */
const minted = new WeakSet<object>()

/** Did `clear.ts` mint exactly this object? What `submit()` checks first. */
export const isCleared = (value: unknown): value is Cleared =>
  typeof value === 'object' && value !== null && minted.has(value)

const refused = (reasons: readonly string[]): ClearRefusal => ({ outcome: 'refused', reasons })

const byPath = (a: FileEdit, b: FileEdit): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

export function clearPlan(signed: SignedPlan, input: ClearInput): Cleared | ClearRefusal {
  // new — D6: a branch is cut in one repository. `planEdits` drops a
  // create-catalog-info as "writes into the service repository", so it would
  // come back below as "produced no change": true, and misleading.
  const service = signed.plan.operations.flatMap((operation, index) =>
    operation.op === 'create-catalog-info' ? [index] : [],
  )
  if (service.length > 0) {
    return refused(
      service.map(
        (index) =>
          `operations.${String(index)} declares a service in its own repository; ` +
          'plan --submit cuts a branch in the declarations repository only — submit it with init --submit',
      ),
    )
  }

  // new — one reading of the bytes. The edits and the re-check judge the files
  // rebuilt from `contents`, which are the bytes the forge proves; a snapshot
  // that disagrees with them, or could not list a folder, judged something
  // else. Only the paths are compared: `input.policy` was built from the
  // snapshot's own read, so its natures and environments may be a moment
  // older than these bytes (the limit beside gap-stage5-readiness-6).
  if (input.snapshot.unreadable !== undefined && input.snapshot.unreadable.length > 0) {
    return refused(
      input.snapshot.unreadable.map(
        (one) => `${one.path === '' ? 'the root' : one.path} could not be read: ${one.reason}`,
      ),
    )
  }
  const listed = new Set(input.snapshot.files.map((file) => file.path))
  const disagree = [
    ...[...listed].filter((file) => !input.contents.has(file)),
    ...[...input.contents.keys()].filter((file) => !listed.has(file)),
  ]
  if (disagree.length > 0) {
    return refused(disagree.map((file) => `${file} changed between two reads of the repository; run this again`))
  }
  const snapshot: RepositorySnapshot = {
    ...input.snapshot,
    files: [...input.contents].map(([file, text]) => repositoryFileOf(file, text)),
  }

  const provenance = signed.provenance
  // new — the context `runPlan` gives (plan.ts:1096-1104): without `natures`,
  // an update's implied environment question is never raised (core-plan-3).
  const questions = questionsOf(signed.plan, {
    environments: input.policy.vocabulary.environments,
    over: input.policy.over,
    declared: input.policy.environments,
    namesakes: input.policy.namesakes,
    natures: input.policy.natures,
    provenance,
  })
  if (questions.length > 0) {
    return refused(questions.map((question) => `${question.path}: still a question`))
  }

  const policies = checkPolicies(signed, input.policy, provenance)
  if (policies.length > 0) {
    return refused(policies.map((one) => `${one.policy} at ${one.path}: ${one.message}`))
  }

  const { edits, dropped } = planEdits(signed, input.contents)
  // The preview lists a drop and still exits 0; a branch may not. A branch
  // holding the database without the grant is exactly the plan that "grants
  // nothing", and the unit of meaning here is the plan, never the file.
  if (dropped.length > 0) {
    return refused(
      dropped.map(
        (one) =>
          `operations.${String(one.opIndex)} produced no change — ${one.reason}; ` +
          'a branch carries the whole plan or nothing',
      ),
    )
  }

  const recheck = recheckPlan(signed, snapshot, edits)
  const errors = recheck.violations.filter((violation) => violation.severity === 'error')
  if (errors.length > 0) {
    return refused(errors.map((one) => `${one.rule} at ${one.file}: ${one.message}`))
  }

  const changed = edits.filter((edit) => edit.before !== edit.after)
  // new — #83: an empty change is an answer only when the repository already
  // says every operation (`changedNothing`, plan.ts:465-477). Anything else
  // behind no bytes was not carried out, and exit 0 would say it was.
  if (changed.length === 0) {
    const unaccounted = signed.plan.operations.flatMap((_, index) =>
      recheck.outcomes.get(index) === 'already-declared' ? [] : [index],
    )
    if (unaccounted.length > 0) {
      return refused(
        unaccounted.map(
          (index) =>
            `operations.${String(index)} produced no change, and the repository does not already say it`,
        ),
      )
    }
  }

  // Every file the gates read, plus every file this plan creates, judged
  // absent: a file that appeared at the base meanwhile is a divergence.
  const files = new Map<string, string | undefined>(input.contents)
  for (const edit of changed) if (edit.before === undefined) files.set(edit.path, undefined)
  return mint(changed, files, 'declarations', signed.plan)
}

/**
 * The only place a `Cleared` is made. Both producers go through it — this file's
 * `clearPlan` and, from task 2, `clearService` — so the freeze, the scope and
 * the runtime brand cannot differ between them.
 */
function mint(
  changed: readonly FileEdit[],
  files: ReadonlyMap<string, string | undefined>,
  repository: Repository,
  plan: Plan,
  label?: string,
): Cleared {
  const edits = [...changed].sort(byPath).map((edit) => Object.freeze({ ...edit }))
  const value = Object.freeze({
    edits: Object.freeze(edits),
    expected: Object.freeze({
      files: sealed(files, SEALED),
      scope: repository === 'declarations' ? ('catalogue' as const) : ('touched' as const),
    }),
    branch: branchFor(edits, label),
    message: messageFor(plan, edits),
    repository,
  })
  minted.add(value)
  return value as unknown as Cleared
}

const stemOf = (file: string | undefined): string =>
  file === undefined ? 'change' : file.slice(file.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '')

/**
 * The branch a set of bytes becomes. A function of the BYTES, so the same
 * submission made twice names the same branch and the forge can recognise its
 * own work (§9.2, applied at the forge); the order edits arrive in is not part
 * of a change. It is also the plan's identity (gap-stage5-readiness-12): two
 * submissions of one plan are one branch.
 *
 * Every run of characters git would refuse in a ref component — `..`, a
 * leading dot, `.lock` — becomes one `-`. An entity name may legally hold them;
 * a ref may not.
 */
export function branchFor(edits: readonly FileEdit[], label?: string): string {
  const sorted = [...edits].sort(byPath)
  const digest = createHash('sha256')
  for (const edit of sorted) digest.update(edit.path).update('\0').update(edit.after).update('\0')
  const slug =
    (label ?? stemOf(sorted[0]?.path))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'change'
  return `${SUBMISSION_PREFIX}${slug}-${digest.digest('hex').slice(0, 8)}`
}

/**
 * C0 and C1 controls, and the bidi controls that reorder what follows them —
 * the embeddings and override (U+202A–U+202E) and the isolates (U+2066–U+2069),
 * the set `cli/render/plain.ts` treats as dangerous. A copy, because `core/`
 * does not import `cli/`; the marks (LRM, RLM, ALM) are left, as there, since
 * they are how right-to-left writing is typed.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]+/g

/** One line, cut at a code point — never inside a surrogate pair — and said to be cut. */
const cut = (text: string, max: number): string => {
  const points = [...text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('')
}

/** What an operation does, in the engine's words: the verb is ours, the name the schema held. */
const actionOf = (operation: Plan['operations'][number]): string => {
  switch (operation.op) {
    case 'create-entity':
    case 'create-catalog-info':
      return `declare ${operation.entity.metadata.name}`
    case 'update-entity':
      return `amend ${operation.entityRef}`
    default: {
      const _exhaustive: never = operation
      return _exhaustive
    }
  }
}

/**
 * The commit message (D18). The subject is the ENGINE's, written from the
 * operations: on `main`, `plan.intent` is a record, not evidence
 * (`provenance.ts:16-21`), and on `--from` it is the file's own words — a
 * subject a person reads first in a forge must not be whatever a plan file
 * said. The request is carried in the body, labelled as recorded, cleaned of
 * what a terminal obeys and cut by code point: a request comes in any script.
 */
export function messageFor(plan: Plan, edits: readonly FileEdit[]): string {
  return [
    cut(`idp-agent: ${plan.operations.map(actionOf).join(', ')}`, 72),
    '',
    'Submitted by idp-agent for review. Nothing is provisioned until this is merged.',
    '',
    ...edits.map((edit) => `  ${edit.before === undefined ? '+' : '~'} ${edit.path}`),
    '',
    'Requested, as recorded with the plan (no gate reads it):',
    `  ${cut(plan.intent, 500)}`,
    '',
  ].join('\n')
}
```

Check against `main` when writing it: the recheck outcome's spelling (`RecheckOutcome`,
`recheck.ts:30`), and whether an
`update-entity`'s patch reads better as `add <consumer> to <entityRef>`. Every new `switch`
keeps the exhaustive `default` (core-plan-10).

Add two rows to the table in `src/core/plan/README.md`, after `edits.ts`:

```markdown
| `clear.ts` | may these bytes be handed to a forge, and which repository's? — the free gates re-run against the signed provenance, one `Cleared` minted and registered |
| `seal.ts` | a Map that refuses to change, for the signature's paths and a clearance's bytes |
```

- [x] **Step 6: Run the tests, then everything**

Run: `pnpm vitest run tests/unit/clear.test.ts tests/unit/clear-parity.test.ts tests/unit/catalogue-path.test.ts tests/unit/sign.test.ts tests/invariants tests/architecture tests/unit/iac-fs.test.ts tests/unit/validate-command.test.ts`
Expected: PASS. If the §9.2 property fails, that is a finding about `planEdits`, not about
the property: stop and report the shrunk counterexample rather than weakening it.

Run, if `df -h /` shows at least 2 GiB free: `pnpm test && pnpm typecheck`
Expected: PASS, with the suite's count up by the tests added. Record the new count in
`AGENTS.md` (`pnpm test  # N tests`).

- [x] **Step 7: Traceability**

- `CHANGELOG.md`, under Unreleased → Added: one line, ending with the pull request's link.
- `docs/roadmap.md`: stage 5's row and queue item say task 1 is on `main`.
- The review's Status: gap-stage5-readiness-5 and core-plan-9 closed (the runtime brand),
  gap-stage5-readiness-11 in part (the property; the rest is B1), gap-stage5-readiness-6 in
  part (the one reading of the bytes for the edits and the re-check; the `PolicyContext`
  still comes from the first read, stated there as what remains).

- [ ] **Step 8: Commit** *(after the owner's go-ahead)*

By explicit path only — never `git add -A` or `git add .`: in a worktree whose
`node_modules` is a symbolic link, `.gitignore`'s `node_modules/` does not match it, and it
would be committed as a link into another checkout. `src/cli/commands/plan.ts` carries the
`PlanOptions.clearance` seam `clear-parity.test.ts` needs; the escaped tests and
`hidden-controls.test.ts` are the guard and what it found; `AGENTS.md` is the shipping
script's test count.

```bash
git add src/core src/context/iac-fs/snapshot.ts src/context/fixtures/index.ts src/cli/commands/plan.ts tests/unit/clear.test.ts tests/unit/clear-parity.test.ts tests/unit/catalogue-path.test.ts tests/unit/sign.test.ts tests/unit/hidden-controls.test.ts tests/unit/commentary.test.ts tests/unit/echoes.test.ts tests/unit/update-environment.test.ts tests/unit/negation.test.ts tests/unit/surgery.test.ts tests/unit/surgery-append.test.ts tests/invariants CHANGELOG.md docs/roadmap.md docs/reviews/2026-09-23-deep-review.md docs/plans/stage-5-write.md AGENTS.md
git commit -m "feat(core): mint the only value a forge accepts, and prove applying twice is applying once"
```

---

### Task 2: `Cleared` for the service repository, filed where `init` previews, and a configuration the reader reads back

*Rewritten on 2026-09-29 (check §3 P2, §5).* The `eee67d6` version took the root's
`catalog-info.yaml` alone, read by a `readCatalogInfo` of its own. `main` no longer files
there: since #82, `init` moves the Component to `targetOf`'s choice (`init.ts:584`) — the
root's `.yaml`, else the root's `.yml`, else the one catalog-info kept elsewhere — over every
tracked catalog-info, read whole outside the budget as `ProjectRead.declarations`, with tests
and examples set aside by `isSetAside` (`:567`, `:708-730`); `asCatalogInfo` keeps its one
argument (`:333`) and `filedIn(op, target)` moves the operation (`:339`, `:949`);
`catalogInfoEdits` takes `{ files: kept }` of several paths (`:963`, `:1006`). On a service
with a root `.yml`, or one nested catalog-info, the old `clearService` would file a twin at
the root with `before = undefined` — the regression the roadmap's queue item named. What
holds from the owner's design: the configuration moving to `core/schemas/config.ts` with a
deterministic serialiser, a committed configuration compared by value, `.idp-agent.yml`
added only when a person typed one.

**Files:**
- Create: `src/core/schemas/config.ts`, `src/core/plan/catalog-info.ts`
- Modify: `src/cli/config.ts` (import the schema; add `readConfigFile`)
- Modify: `src/cli/commands/init.ts` (import what moved; `previewOf` reads `catalogInfoEdits(...).edits`)
- Modify: `src/core/plan/clear.ts` (add `clearService`)
- Modify: `tests/unit/init-command.test.ts` (import `catalogInfoEdits` from its new home)
- Create: `tests/unit/clear-service.test.ts`, `tests/unit/catalog-info.test.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `CHANGELOG.md`, `docs/roadmap.md`, the review's Status

**Interfaces:**
- Consumes: `mint`, `Cleared`, `ClearRefusal`, `Repository` (task 1); `SignedPlan.provenance`
  (task 1); `questionsOf`; `planSchema`; `DroppedOperation` (`edits.ts:57-60`); `materialise`,
  `serializeEntity`, `insertDocument`, `documentNames`, `parseDocuments` (already used by the
  code that moves).
- Produces:
  - `const CONFIG_FILE = '.idp-agent.yml'` · `const repositoryConfigSchema` · `type RepositoryConfig`
  - `type WrittenConfig = Pick<RepositoryConfig, 'iacRepo' | 'environments'>` — what `init --submit` may write (D9: never `backstage`)
  - `function serializeConfig(config: WrittenConfig): string`
  - `const CATALOG_INFO = 'catalog-info.yaml'` · `function asCatalogInfo(operation: Operation): Operation` · `function filedIn(operation: Operation, repoPath: string): Operation`
  - `function targetOf(declarations: readonly { readonly path: string; readonly workspace?: string }[]): string` · `function isSetAside(file: string): boolean` · `function declaresComponent(text: string, name: string): boolean`
  - `function catalogInfoEdits(plan: Plan, snapshot: { readonly files: readonly { readonly path: string; readonly text: string }[] }): { edits: FileEdit[]; dropped: DroppedOperation[] }`
  - `interface ServiceInput { readonly target: string; readonly kept: readonly { readonly path: string; readonly text: string }[]; readonly existing: { readonly text: string; readonly config: RepositoryConfig } | undefined; readonly config: WrittenConfig | undefined }`
  - `function clearService(signed: SignedPlan, input: ServiceInput): Cleared | ClearRefusal`
  - `function readConfigFile(root: string): Promise<{ readonly config: RepositoryConfig; readonly text: string } | undefined>`

The schema moves into `core/` because a `Cleared` carries the configuration's bytes, and
`core/` may not import `cli/`. `readConfig` stays in `cli/`, since it reads a disk. It is
named `repositoryConfigSchema` because `main` also has a personal `config.yml`
(`cli/personal.ts`) with its own `backstage` and `repo`, and "config" alone no longer says
which. The five functions that decide where `init` files move with it, all pure, so the
preview and the clearance are the one reading: `clearService` mints from the same `target`
and `kept` the preview uses, never a second read.

- [x] **Step 1: Write the failing tests**

`tests/unit/catalog-info.test.ts` — the moved functions, and the effect check `catalogInfoEdits`
gains. `main`'s skips an operation that does not materialise with a silent `continue`
(`init.ts:1026`) and checks no effect, where `planEdits` has both (`edits.ts:183-191`; #45):

- `targetOf` over `[]` is `catalog-info.yaml`; over a root `catalog-info.yml` it is that
  file; over one nested `services/billing/catalog-info.yaml` it is that file; over two nested
  and none at the root it is a new root `catalog-info.yaml`; over a workspace's file only
  (`workspace` set) it is a new root file.
- `isSetAside('examples/catalog-info.yaml')` and `isSetAside('src/__tests__/catalog-info.yaml')`
  are true; `isSetAside('catalog-info.yaml')` is false.
- `catalogInfoEdits` over a root `.yml` holding another Component appends a document to that
  file, `before` its bytes; over a file already declaring the Component, `before === after`;
  an operation whose entity does not materialise is in `dropped` with a reason, never skipped
  in silence; an edit whose `after` does not declare the Component (a stub
  `insertDocument` in a test double, or a file that fails `documentNames`) is dropped with
  "the edit did not declare it".

`tests/unit/clear-service.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { clearService, isCleared, type Cleared, type ClearRefusal } from '../../src/core/plan/clear.js'
import { CATALOG_INFO } from '../../src/core/plan/catalog-info.js'
import type { Provenance } from '../../src/core/plan/provenance.js'
import { signPlan } from '../../src/core/plan/sign.js'
import { CONFIG_FILE, serializeConfig } from '../../src/core/schemas/config.js'
import { planSchema } from '../../src/core/schemas/plan.js'

const COMPONENT = {
  op: 'create-entity',
  entity: {
    kind: 'Component',
    metadata: { name: 'billing-api' },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  },
}

/**
 * What `init` signs: an engine-composed request, which vouches for nothing,
 * and what the inspection read, at the fields it read it for (`inspected`).
 */
const said: Provenance = {
  intent: 'declare this repository in the catalogue',
  wordsOf: 'engine',
  answers: new Map([
    ['operations.0.entity.metadata.name', 'billing-api'],
    ['operations.0.entity.spec.type', 'service'],
    ['operations.0.entity.spec.lifecycle', 'production'],
    ['operations.0.entity.spec.owner', 'group:default/tiger'],
  ]),
}

const signed = () => {
  const result = signPlan(
    planSchema.parse({ intent: said.intent, operations: [COMPONENT] }),
    {
      witnessed: new Set(),
      vocabulary: { kinds: [], types: [], environments: [], owners: [] },
      repoRoot: '/service',
      declared: new Map(),
    },
    said,
  )
  if ('outcome' in result) throw new Error(JSON.stringify(result.refusals))
  return result
}

const CONFIG = { iacRepo: 'github.com/acme/iac', environments: ['dev', 'staging', 'prod'] }
const NONE = { target: CATALOG_INFO, kept: [], existing: undefined, config: undefined }

const cleared = (result: Cleared | ClearRefusal): Cleared => {
  if ('outcome' in result) throw new Error(result.reasons.join('\n'))
  return result
}

describe('clearService', () => {
  it('carries the catalog-info and the configuration, for the service repository', () => {
    const result = cleared(clearService(signed(), { ...NONE, config: CONFIG }))
    expect(isCleared(result)).toBe(true)
    expect(result.repository).toBe('service')
    expect(result.edits.map((edit) => edit.path)).toEqual([CONFIG_FILE, CATALOG_INFO])
    expect(result.edits[0]?.after).toBe(serializeConfig(CONFIG))
    expect(result.edits[1]?.after).toContain('name: billing-api')
    expect(result.expected.scope).toBe('touched')
    expect([...result.expected.files].sort()).toEqual([
      [CONFIG_FILE, undefined],
      [CATALOG_INFO, undefined],
    ])
    expect(result.branch).toMatch(/^idp-agent\/init-billing-api-[0-9a-f]{8}$/)
  })

  it('files in the root .yml the service keeps, never a twin beside it', () => {
    // #82: the file init previews is `targetOf`'s, and its `before` is the file
    // read whole. A clearance that took the root .yaml alone filed a second one.
    const yml = { path: 'catalog-info.yml', text: 'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing\n' }
    const result = cleared(clearService(signed(), { ...NONE, target: yml.path, kept: [yml] }))
    expect(result.edits.map((edit) => edit.path)).toEqual(['catalog-info.yml'])
    expect(result.edits[0]?.before).toBe(yml.text)
    expect(result.expected.files.get('catalog-info.yml')).toBe(yml.text)
    expect(result.expected.files.has(CATALOG_INFO)).toBe(false)
  })

  it('files in the one catalog-info the service keeps elsewhere', () => {
    const nested = { path: 'deploy/catalog-info.yaml', text: '# nothing yet\n' }
    const result = cleared(clearService(signed(), { ...NONE, target: nested.path, kept: [nested] }))
    expect(result.edits.map((edit) => edit.path)).toEqual([nested.path])
  })

  it('proves every declaration it read, not only the one it writes', () => {
    // The "already declared" and name decisions read every kept file: a base
    // where one of them changed is a base those decisions never saw.
    const a = { path: 'services/a/catalog-info.yaml', text: '# a\n' }
    const b = { path: 'services/b/catalog-info.yaml', text: '# b\n' }
    const result = cleared(clearService(signed(), { ...NONE, kept: [a, b] }))
    expect(result.expected.files.get(a.path)).toBe(a.text)
    expect(result.expected.files.get(b.path)).toBe(b.text)
    expect(result.expected.files.get(CATALOG_INFO)).toBeUndefined()
    expect(result.expected.files.get(CONFIG_FILE)).toBeUndefined()
  })

  it('writes no configuration when nobody typed one', () => {
    const result = cleared(clearService(signed(), NONE))
    expect(result.edits.map((edit) => edit.path)).toEqual([CATALOG_INFO])
  })

  it('leaves a committed configuration alone when it says the same, however it is written', () => {
    // Hand-written, unquoted — the shape `plan-intent.test.ts`'s CONFIGURED
    // fixture has, and the one a person types. Byte comparison refused it.
    const existing = {
      text: 'iacRepo: github.com/acme/iac\nenvironments: [dev, staging, prod]\n',
      config: CONFIG,
    }
    const result = cleared(clearService(signed(), { ...NONE, existing, config: CONFIG }))
    expect(result.edits.map((edit) => edit.path)).toEqual([CATALOG_INFO])
    expect(result.expected.files.get(CONFIG_FILE)).toBe(existing.text)
  })

  it('never rewrites a committed configuration that says something else', () => {
    // It seeds the vocabulary every gate measures against (§7.0), and it was
    // merged by someone. Changing it is a reviewed edit made by hand.
    const result = clearService(signed(), {
      ...NONE,
      existing: {
        text: 'iacRepo: github.com/other/iac\nenvironments: [prod]\n',
        config: { iacRepo: 'github.com/other/iac', environments: ['prod'] },
      },
      config: CONFIG,
    })
    expect('outcome' in result && result.reasons.join('\n')).toContain(CONFIG_FILE)
  })

  it('carries a Component already declared as no edit at all', () => {
    const own = {
      path: CATALOG_INFO,
      text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger\n',
    }
    const result = cleared(clearService(signed(), { ...NONE, kept: [own] }))
    expect(result.edits).toEqual([])
  })

  it('refuses a plan carrying anything but the service’s Component', () => {
    // A right has no place in a service's repository; the preview never shows
    // one there, so a clearance must not either.
    const grant = {
      op: 'update-entity',
      entityRef: 'resource:default/orders-db-prod',
      patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api', access: 'read' },
    }
    const plan = planSchema.parse({ intent: said.intent, operations: [COMPONENT, grant] })
    const result = signPlan(plan, { witnessed: new Set(), vocabulary: { kinds: [], types: [], environments: [], owners: [] }, repoRoot: '/service', declared: new Map() }, said)
    if ('outcome' in result) return // refused at the signature is a refusal too
    expect('outcome' in clearService(result, NONE)).toBe(true)
  })
})
```

Append to `tests/unit/config.test.ts`. The round trip goes through the real reader, on a
real disk. The file already imports `mkdtemp`, `writeFile`, `tmpdir`, `path`, `readConfig`
and `CONFIG_FILE`, and repeating them is a duplicate-identifier error. Add only:

```typescript
import fc from 'fast-check'
import { serializeConfig } from '../../src/core/schemas/config.js'
```

and the test:

```typescript
it('writes exactly what readConfig reads back', async () => {
  // What `init --submit` writes is what every later run seeds its vocabulary
  // from. A serialiser the reader disagrees with would seed something nobody
  // typed — or refuse, on the next run, the file this tool just wrote. No
  // `backstage:`: init --submit never writes one (D9).
  const word = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/)
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        iacRepo: fc.stringMatching(/^[a-z0-9.\/:_-]{1,60}$/),
        environments: fc.array(word, { minLength: 1, maxLength: 5 }),
      }),
      async (config) => {
        const root = await mkdtemp(path.join(tmpdir(), 'idp-config-'))
        await writeFile(path.join(root, CONFIG_FILE), serializeConfig(config), 'utf8')
        expect(await readConfig(root)).toEqual(config)
      },
    ),
    { numRuns: 40 },
  )
})
```

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/unit/clear-service.test.ts tests/unit/catalog-info.test.ts tests/unit/config.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 3: Move the schema and the catalog-info composition into `core/`**

`src/core/schemas/config.ts` takes the schema (`src/cli/config.ts:63`), `RepositoryConfig`
(`:75`), `CONFIG_FILE` (`:26`) and `MAX_ENVIRONMENT_LENGTH` (`:46`) **with their comments**,
moved from `src/cli/config.ts`. The schema is renamed `repositoryConfigSchema` and becomes
`export const`; it was module-private in `cli/`. It keeps its optional `backstage` for
reading — a committed file may hold one, which is never requested (`SECURITY.md:161`) — and
the file adds the serialiser, which writes only the two fields `init --submit` may write:

```typescript
/** What `init --submit` writes: never `backstage` (D9, ADR-0011). */
export type WrittenConfig = Pick<RepositoryConfig, 'iacRepo' | 'environments'>

/**
 * The bytes `init --submit` writes. Deterministic — key order fixed, every
 * scalar a JSON string, which is a YAML 1.2 double-quoted scalar — so the same
 * configuration is the same file, and the forge can recognise a submission it
 * already made.
 *
 * Parsed on the way out as well as on the way in: what this writes is what
 * the reader accepts, or it throws here rather than on the next run.
 */
export function serializeConfig(config: WrittenConfig): string {
  const parsed = repositoryConfigSchema.parse({ iacRepo: config.iacRepo, environments: config.environments })
  return [
    `iacRepo: ${JSON.stringify(parsed.iacRepo)}`,
    `environments: [${parsed.environments.map((env) => JSON.stringify(env)).join(', ')}]`,
    '',
  ].join('\n')
}
```

`src/cli/config.ts` imports and re-exports `CONFIG_FILE` and `RepositoryConfig` from
`../core/schemas/config.js`, so no other importer changes. It keeps `ConfigError`,
`readConfig` and `seededVocabulary`, and gains the read that keeps the bytes:

```typescript
/**
 * The configuration and the bytes it was read from. `init --submit` needs both:
 * the parsed value to compare with what the person typed, the bytes so the
 * forge can prove the base still holds them.
 */
export async function readConfigFile(
  root: string,
): Promise<{ readonly config: RepositoryConfig; readonly text: string } | undefined> {
  const file = path.join(root, CONFIG_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw new ConfigError(
      `cannot read ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { config: parseConfig(text), text }
}

export async function readConfig(root: string): Promise<RepositoryConfig | undefined> {
  return (await readConfigFile(root))?.config
}
```

`parseConfig(text)` is the YAML-then-schema half of today's `readConfig` (`:93-120`), moved
into a private function unchanged, with the same two `ConfigError`s.

`src/core/plan/catalog-info.ts` takes, **with their comments**, from
`src/cli/commands/init.ts`: `CATALOG_INFO` (`:193`), `asCatalogInfo` (`:333`), `filedIn`
(`:339`), `Identity`, `identitiesOf`, `isComponent`, `isThis`, `declaresComponent`
(`:451-498`), `SET_ASIDE` and `isSetAside` (`:547-572`), `targetOf` (`:584`), and
`catalogInfoEdits` (`:1006`). All are pure; each is exported that `init.ts` or `clear.ts`
needs. `recognise`, `Kept` and the rendering stay in `init.ts`, which imports what they call.

`catalogInfoEdits` returns `{ edits, dropped }` under the effect check `planEdits` has:

```typescript
  for (const [opIndex, operation] of plan.operations.entries()) {
    if (operation.op !== 'create-catalog-info') continue
    const entity = materialise(operation.entity)
    if (entity === undefined) {
      // Never a silent skip (#45): a caller printing a diff must be able to say
      // "this plan declares nothing" rather than "nothing to change".
      dropped.push({ opIndex, reason: 'the proposed Component could not be materialised' })
      continue
    }
    // … the buffer, as today …
    const after = buffered.get(path)
    if (after === undefined || !declaresComponent(after, entity.metadata.name)) {
      dropped.push({ opIndex, reason: `${path}: the edit did not declare it` })
    }
  }
```

Then:
- `init.ts` imports the moved names from `../../core/plan/catalog-info.js` and `previewOf`
  reads `catalogInfoEdits(...).edits`; a `dropped` there is rendered as the preview renders
  one, and `init`'s tests show it is not reachable from a signed plan today.
- Delete the imports the move leaves unused in `init.ts`. Re-run `pnpm typecheck` to confirm
  the list, because it is the compiler's.
- `init-command.test.ts` imports `catalogInfoEdits` from the new module, and reads `.edits`.

`init`'s preview output is byte-identical to before, `APPLY` tail included: the functions
moved, and the only new branch — a drop — was a silent `continue`.

- [x] **Step 4: Write `clearService`**

Append to `src/core/plan/clear.ts`, with the imports it needs (`asCatalogInfo`, `filedIn`
and `catalogInfoEdits` from `./catalog-info.js`; `CONFIG_FILE`, `serializeConfig`,
`type RepositoryConfig` and `type WrittenConfig` from `../schemas/config.js`; `planSchema`
from `../schemas/plan.js`; `reasonOf` from `../schemas/reject.js`):

```typescript
export interface ServiceInput {
  /** Where `init` files the Component: `targetOf`'s choice, the file the preview shows. */
  readonly target: string
  /**
   * Every catalog-info the service keeps, read whole and outside the budget
   * (`ProjectRead.declarations` less `isSetAside`, #82) — the befores, and what
   * the "already declared" and name decisions read.
   */
  readonly kept: readonly { readonly path: string; readonly text: string }[]
  /**
   * `.idp-agent.yml` as it stands — its bytes, for the forge to prove, and its
   * parsed value, to compare — or undefined when there is none.
   */
  readonly existing: { readonly text: string; readonly config: RepositoryConfig } | undefined
  /** What the person typed for it; undefined when nothing is to be written. */
  readonly config: WrittenConfig | undefined
}

/**
 * The service repository's clearance: its Component, filed where `init`
 * previews it, and `.idp-agent.yml` when a person supplied one (design §7.3).
 * No model value reaches the configuration — `config` comes from flags or
 * answers, never from the plan — and a committed configuration is never
 * rewritten: it seeds the vocabulary every gate measures against, and changing
 * it is a reviewed edit by hand.
 */
export function clearService(signed: SignedPlan, input: ServiceInput): Cleared | ClearRefusal {
  const questions = questionsOf(signed.plan, { provenance: signed.provenance })
  if (questions.length > 0) {
    return refused(questions.map((question) => `${question.path}: still a question`))
  }

  // Re-crossed for the reason `init.ts` gives: the minted plan is a different
  // object from the one that was signed. Filed where the preview files it.
  const minted = planSchema.safeParse({
    intent: signed.plan.intent,
    operations: signed.plan.operations.map((operation) => filedIn(asCatalogInfo(operation), input.target)),
  })
  if (!minted.success) return refused([`the composed plan is not a plan — ${reasonOf(minted.error)}`])
  const other = minted.data.operations.flatMap((operation, index) =>
    operation.op === 'create-catalog-info' ? [] : [index],
  )
  if (other.length > 0) {
    return refused(
      other.map((index) => `operations.${String(index)} is not this service's Component; init --submit writes nothing else`),
    )
  }

  const { edits, dropped } = catalogInfoEdits(minted.data, { files: input.kept })
  if (dropped.length > 0) {
    return refused(
      dropped.map(
        (one) => `operations.${String(one.opIndex)} produced no change — ${one.reason}; a branch carries the whole plan or nothing`,
      ),
    )
  }

  if (input.config !== undefined) {
    const after = serializeConfig(input.config)
    if (input.existing === undefined) {
      edits.push({ path: CONFIG_FILE, before: undefined, after })
    } else if (serializeConfig(input.existing.config) !== after) {
      // Compared by VALUE, through the one serialiser: a hand-written file
      // says `iacRepo: github.com/acme/iac` where this writes it quoted, and
      // comparing bytes refused a re-run over a file that agreed with every
      // flag (measured).
      return refused([
        `${CONFIG_FILE} already says something else; a committed configuration is ` +
          'changed by hand, in a reviewed change, never by this command',
      ])
    }
  }

  const changed = edits.filter((edit) => edit.before !== edit.after)
  // What the gates read, proved at the base (check §5.2, 3): the target's bytes
  // or its absence, every kept declaration, and the configuration's bytes or
  // its absence — never `CATALOG_INFO` by name.
  const files = new Map<string, string | undefined>(input.kept.map((file) => [file.path, file.text] as const))
  if (!files.has(input.target)) files.set(input.target, undefined)
  files.set(CONFIG_FILE, input.existing?.text)
  const name = minted.data.operations.find((operation) => operation.op === 'create-catalog-info')
  const label = name?.op === 'create-catalog-info' ? `init-${name.entity.metadata.name}` : 'init'
  return mint(changed, files, 'service', minted.data, label)
}
```

`clearService` does not stand in for `init`'s own verdicts, which run before any model and
stay where they are (`init.ts:718-760`; design §7.3): an unreadable own catalog-info is
refused, a Component already declared exits 0 with no branch (`renderDeclared`), and a target
declaring another name asks it. What it re-runs is what the forge must not take on trust: no
question left, nothing dropped, the file `init` previews and nothing else, the configuration
never rewritten.

- [x] **Step 5: Run the tests, then everything**

Run: `pnpm vitest run tests/unit/clear-service.test.ts tests/unit/catalog-info.test.ts tests/unit/config.test.ts tests/unit/init-command.test.ts tests/unit/clear.test.ts tests/architecture`
Expected: PASS.

Run, if `df -h /` shows at least 2 GiB free: `pnpm test && pnpm typecheck`
Expected: PASS. `init`'s preview output is byte-identical to before.

- [x] **Step 6: Traceability**

- `CHANGELOG.md`, Unreleased → Added (or Changed, for the move): one line with the link.
- `docs/roadmap.md`: stage 5's queue item says task 2 is on `main`.
- The review's Status: gap-stage5-readiness-8's identity half closed with task 4's role
  check (say "in part" here).

- [ ] **Step 7: Commit** *(after the owner's go-ahead)*

```bash
git add src/core src/cli/config.ts src/cli/commands/init.ts tests/unit CHANGELOG.md docs/roadmap.md docs/reviews/2026-09-23-deep-review.md docs/audit-attacks/core-attacks.test.ts docs/plans/stage-5-write.md
git commit -m "feat(core): clear a service's declaration where init files it, and write a configuration the reader reads back"
```

`docs/audit-attacks/core-attacks.test.ts` is in that line because it imports
`catalogInfoEdits` and `CATALOG_INFO`, which moved out of `init.ts`; `tsconfig.json` includes
only `src/` and `tests/`, so neither `pnpm typecheck` nor `pnpm test` would notice it left
behind — only the next run of the audit harness would. The plan file carries the ticked boxes.

---

# Merge 5b — the forge

### Task 3: one hardened git launcher, the `forge/` types, and the rules that fence them

*Rewritten on 2026-09-29 (check §3 P3; D10, D13).* The `eee67d6` version was written for
13 rules and "no process in `src/`". On `main` there are 19, and a git process already runs:
`context/project-fs/snapshot.ts` lists a repository's files with `git ls-files`, under the
`SPAWNS` registry (`tests/architecture/dependencies.test.ts:322`), the rule "only the named
modules write, and only one starts a process" (`:541`) and the rule "every process `src/`
starts is given `spawnedEnvironment`" (`:663`). Its `scrubbed(env)` removed only `GIT_*`
(plan:1746-1760 at `eee67d6`), so git — and every hook or fsmonitor it runs — would have been
handed `IDP_BACKSTAGE_TOKEN` and every `*_API_KEY`, against ADR-0011
(`docs/adr/0011-backstage-to-explore.md:23`) and `SECURITY.md:153`. Its `gitIn` set no `cwd`
and no bound, where `main` starts git from Node's own directory (`NEUTRAL_DIRECTORY`,
`project-fs/snapshot.ts:422`, `:436`) — Windows looks a program up in the working directory
first, so a `git.exe` at a repository's root would run — and bounds each call (`GIT_LIMITS`,
`:377`); a user will often run `--submit` from inside the repository. The `PATTERNS` repair
of step 1 is already on `main` (`dependencies.test.ts:39-42`), and a rule over a missing
folder now fails (#88), so the `forge/` rules land with `forge/`.

What holds from the owner's design: `provider.ts` as types only (`Base`, `Submitted`,
`ForgeProvider` with no merge, no delete, no caller-chosen name), `ForgeInputError` on exit
2, the hardening flags (`core.hooksPath=/dev/null`, `core.fsmonitor=false`), `GIT_*`
scrubbed, `core/`'s disk rule made transitive, and the rules "`core/` may not import
`forge/`" and "only `cli/` reaches `forge/` at runtime", which `main` still lacks.

**One flag added** (D13): `-c user.useConfigOnly=true`. The scrub leaves the identity to
git's configuration, and with none configured git does not fail — it guesses one from the
login and host names (measured, git 2.46: `git var GIT_COMMITTER_IDENT` exit 0). With the
flag, the forge's identity probe and `commit-tree` refuse instead; an identity is configured
or there is none.

**Redone as one launcher, shared.** `project-fs` and the forge run git through the same
function, in a small leaf module both may import (D10): `src/process/`. Letting `forge/`
import `context/` instead would break the plan's own layering. `SPAWNS` then still names one
spawner, and "only one starts a process" stays true.

**Files:**
- Create: `src/process/environment.ts` (moved from `src/context/spawned-environment.ts`), `src/process/git.ts`, `src/process/README.md`
- Modify: `src/context/project-fs/snapshot.ts` (its `git()` goes through the launcher), `src/context/backstage/transport.ts` (imports the token variable's name), `src/context/README.md`
- Create: `src/forge/provider.ts`, `src/forge/errors.ts`, `src/forge/README.md`
- Create: `tests/support/git.ts`, `tests/unit/process-git.test.ts`
- Modify: `tests/support/tree.ts` (add `hashWorktree`), `tests/unit/spawned-environment.test.ts` (the import path)
- Modify: `tests/architecture/dependencies.test.ts`
- Modify: `AGENTS.md` (the rule count, the spawner sentence, the layering diagram, the folder table), `docs/design.md` §5.5, `SECURITY.md` (the rows that name the spawner), `src/core/README.md` (the bans its rules now hold)
- Modify: `CHANGELOG.md`, `docs/roadmap.md`, `docs/reviews/2026-09-23-deep-review.md` (architecture-11)

**Interfaces:**
- Consumes: `Cleared`, `Expectation`, `Repository` (task 1) — as types.
- Produces:
  - `function spawnedEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv` · `const BACKSTAGE_TOKEN_VARIABLE` — moved, unchanged
  - `type Git = (args: readonly string[], input?: Buffer) => Promise<Buffer>` · `class GitError` (`args`, `code`, `stderr`, `timedOut`)
  - `const GIT_LIMITS = { timeoutMs: 15_000, maxOutputBytes: 32 MiB }` · `const HARDENING: readonly string[]`
  - `function gitEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `function gitIn(repo: string, options?: { readonly env?: NodeJS.ProcessEnv; readonly limits?: GitLimits }): Git`
  - `interface Base { readonly branch: string; readonly commit: string }`
  - `type Submitted = { outcome: 'created' | 'already-submitted'; branch; commit } | { outcome: 'unchanged' } | { outcome: 'refused'; reason }`
  - `interface ForgeProvider { readonly name: 'local'; readonly repository: Repository; base(): Promise<Base>; diverges(base: Base, expected: Expectation): Promise<readonly string[]>; submit(change: Cleared, base: Base): Promise<Submitted> }`
  - `class ForgeInputError extends Error`
  - tests: `git(repo, ...args)`, `show(repo, revision, file)`, `committed(repo)`, `observable(repo)`, `hashWorktree(root)`

- [x] **Step 1: Write the failing architecture rules**

In `tests/architecture/dependencies.test.ts`, strengthen two rules, move the spawner, and add
three. Re-count from **19**.

The existing `'core/ imports nothing from context/, cli/ or scaffold/'` (`:573`) becomes:

```typescript
  it('core/ imports nothing from context/, cli/, scaffold/, forge/ or process/', async () => {
    // forge/ depends on core/ — `Cleared` is core's — so core naming forge,
    // even by type, is a cycle; and at runtime it is core reaching a process.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(
      ({ specifier }) => /(^|\/)(context|cli|scaffold|forge|process)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })
```

The existing `'core/ neither reads nor writes'` (`:584`) becomes transitive:

```typescript
  it('core/ neither reads nor writes, however many hops away', async () => {
    // Direct imports only, until stage 5 measured it: core/ importing a module
    // that imports child_process passed every rule.
    const entries = await sourceFiles(path.join(SOURCE_ROOT, 'core'))
    const closure = (await Promise.all(entries.map((file) => closureOf(file)))).flat()
    const offending = closure.filter(({ specifier }) => DISK.test(specifier))
    expect(offending).toEqual([])
  })
```

`SPAWNS` (`:322`) names the launcher instead of `project-fs`:

```typescript
const SPAWNS: Readonly<Record<string, { readonly calls: number; readonly env: string }>> = {
  // `gitIn`, which every git command of the Inspector and of the forge goes through.
  'process/git.ts': { calls: 1, env: 'gitEnvironment' },
}
```

and `'only the named modules write, and only one starts a process'` (`:541`) keeps its body;
its comment says the forge writes through git, not through a writing function, so it is in
neither list. Add:

```typescript
  it('process/ imports nothing of ours, and only node: built-ins', async () => {
    // A leaf both context/project-fs and forge/ import: the one place a
    // process is started, with the one environment a child is given. Anything
    // it imported would be reachable from both.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'process'))).filter(
      ({ specifier }) => !specifier.startsWith('node:') && !/^\.\/[\w-]+\.js$/.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('forge/ imports core/ and process/, nothing else of ours, and no package', async () => {
    // A forge is the one layer that writes into a user's repository. What it
    // may reach is kept as small as scaffold/'s — and smaller: no package at
    // all, because a git client the DISK list does not name (`execa`, `zx`,
    // `dugite`) passed every rule when it was measured.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'forge'))).filter(
      ({ specifier }) =>
        /(^|\/)(agents|llm|context|cli|scaffold|trace)\//.test(specifier) ||
        (!specifier.startsWith('.') && !specifier.startsWith('node:')),
    )
    expect(offending).toEqual([])
  })

  it('only cli/ reaches forge/ at runtime', async () => {
    // `import type` names the interface without being able to call it — the
    // shape `llm/client.ts` has for agents/. Anything else, from anywhere but
    // cli/, is a writer reachable from a layer that was never meant to write:
    // core/ and context/ importing forge/local passed every rule at eee67d6.
    const offending: string[] = []
    for (const source of await sourceFiles(SOURCE_ROOT)) {
      const relative = path.relative(SOURCE_ROOT, source)
      if (relative.startsWith('cli/') || relative.startsWith('forge/')) continue
      const body = await readFile(source, 'utf8')
      for (const match of body.matchAll(/^\s*(?:import|export)(\s+type)?\b[^'"]*['"]([^'"]+)['"]/gm)) {
        if (match[1] === undefined && /(^|\/)forge\//.test(match[2] ?? '')) {
          offending.push(`${relative} → ${match[2] ?? ''}`)
        }
      }
    }
    expect(offending).toEqual([])
  })
```

`'reads every layer it has a rule about, and the tree as a whole'` gains `forge` and
`process`: a rule over a folder that is not there fails (#88), which is why these rules land
in the same commit as the folders.

- [x] **Step 2: Prove each rule bites**

Each probe is a throwaway file. Add it, run
`pnpm vitest run tests/architecture --reporter=verbose`, watch the named rule fail, then
delete it. A rule that has never failed has not been tested.

| Probe (after step 4 creates the modules) | Must fail |
|---|---|
| `src/core/probe.ts`: `import { gitIn } from '../process/git.js'` | `core/ imports nothing from … process/`, `core/ neither reads nor writes…` |
| `src/core/probe.ts`: `import type { Base } from '../forge/provider.js'` | `core/ imports nothing from … forge/` |
| `src/context/probe.ts`: `import { openLocalForge } from '../forge/local/forge.js'` (task 4; until then `../forge/errors.js`) | `only cli/ reaches forge/` |
| `src/agents/probe.ts`: `import { gitIn } from '../process/git.js'` | the existing closure rule |
| `src/agents/probe.ts`: `import type { ForgeProvider } from '../forge/provider.js'` | **nothing** — a type is allowed |
| `src/forge/local/probe.ts`: `import { execa } from 'execa'` | `forge/ imports core/ and process/…` |
| `src/process/probe.ts`: `import { CONFIG_FILE } from '../cli/config.js'` | `process/ imports nothing of ours…` |
| `src/cli/probe.ts`: `import { execFile } from 'node:child_process'` | `only the named modules write, and only one starts a process` |

- [x] **Step 3: Write the failing launcher tests**

`tests/support/git.ts`:

```typescript
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { hashWorktree } from './tree.js'

const run = promisify(execFile)

/**
 * Test-side git, isolated from the developer's configuration so a test means
 * the same thing on every machine. The launcher under test deliberately is NOT
 * isolated this way — it scrubs GIT_* and reads the user's own config, where
 * their identity lives — which is why every repository here sets its identity
 * locally.
 */
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], { env: ENV, encoding: 'utf8' })
  return stdout.trim()
}

/**
 * A file's bytes at a revision, untrimmed. `git()` trims, which is right for a
 * ref and wrong for a file: "the branch holds exactly the bytes of the diff" is
 * a byte-for-byte claim, trailing newline included.
 */
export async function show(repo: string, revision: string, file: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, 'show', `${revision}:${file}`], {
    env: ENV,
    encoding: 'utf8',
  })
  return stdout
}

/** A directory made into a repository on `main`, holding every file it had. Returns HEAD. */
export async function committed(repo: string): Promise<string> {
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.name', 'idp-agent tests')
  await git(repo, 'config', 'user.email', 'tests@idp-agent.invalid')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
  return git(repo, 'rev-parse', 'HEAD')
}

/**
 * Everything a person can observe of a repository without reading its object
 * store: every ref, what HEAD is, the index's bytes, and the working tree.
 * §9.2's "initial state intact" is this string being equal — and deliberately
 * not `.git/objects`, where an aborted write leaves an unreachable blob.
 */
export async function observable(repo: string): Promise<string> {
  const index = await readFile(path.join(repo, '.git', 'index')).catch(() => Buffer.alloc(0))
  return [
    await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    await git(repo, 'symbolic-ref', '-q', 'HEAD').catch(() => 'detached'),
    await git(repo, 'rev-parse', 'HEAD'),
    createHash('sha256').update(index).digest('hex'),
    await hashWorktree(repo),
  ].join('\n')
}
```

In `tests/support/tree.ts`, add `hashWorktree`. It is `hashTree` without the root `.git/`
directory, because a submission legitimately writes objects and one ref there:

```typescript
/** `hashTree` minus the repository's own `.git/`: the working tree a person sees. */
export async function hashWorktree(root: string): Promise<string> {
  const entries = (await entriesUnder(root)).filter((entry) => !/^\.git(\/|$)/.test(entry)).sort()
  const digest = createHash('sha256')
  for (const entry of entries) {
    digest.update(entry)
    digest.update('\x00')
    if (!entry.endsWith('/')) digest.update(await readFile(path.join(root, ...entry.split('/'))))
    digest.update('\x00')
  }
  return digest.digest('hex')
}
```

`tests/unit/process-git.test.ts` — the owner's `forge-git.test.ts`, on the shared launcher,
plus what `main` requires of every child:

```typescript
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitError, HARDENING, gitIn } from '../../src/process/git.js'
import { committed, git } from '../support/git.js'

const repository = async (): Promise<string> => {
  const repo = await mkdtemp(path.join(tmpdir(), 'idp-git-'))
  await committed(repo)
  return repo
}

/** A shell script that leaves a mark where it ran, for "did git run this?". */
const marking = async (file: string, marker: string): Promise<void> => {
  await writeFile(file, `#!/bin/sh\ntouch '${marker}'\n`, 'utf8')
  await chmod(file, 0o755)
}

describe('the one process', () => {
  it('cannot be redirected to another repository by an inherited GIT_DIR', async () => {
    // Measured: `GIT_DIR=<other>/.git git -C <repo>` answers for <other>.
    const repo = await repository()
    const other = await repository()
    const run = gitIn(repo, { env: { ...process.env, GIT_DIR: path.join(other, '.git') } })
    const answered = (await run(['rev-parse', '--absolute-git-dir'])).toString('utf8').trim()
    expect(answered).toBe(await git(repo, 'rev-parse', '--absolute-git-dir'))
  })

  it("does not run the repository's hooks", async () => {
    // Measured: a reference-transaction hook runs inside `update-ref`.
    const repo = await repository()
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'idp-hook-')), 'ran')
    await marking(path.join(repo, '.git', 'hooks', 'reference-transaction'), marker)

    await gitIn(repo)(['update-ref', 'refs/heads/idp-agent/probe', 'HEAD', ''])

    await expect(stat(marker)).rejects.toThrow()
  })

  it('never runs a git planted in the repository', async () => {
    // Windows looks a program up in the working directory first, and a
    // relative PATH entry does it anywhere: git is started from Node's own
    // directory and reaches the repository by -C (NEUTRAL_DIRECTORY).
    const repo = await repository()
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'idp-planted-')), 'ran')
    await marking(path.join(repo, 'git'), marker)
    const env = { ...process.env, PATH: `.${path.delimiter}${process.env['PATH'] ?? ''}` }

    await gitIn(repo, { env })(['rev-parse', 'HEAD'])

    await expect(stat(marker)).rejects.toThrow()
  })

  it('hands git no provider key and no catalogue token', async () => {
    // ADR-0011 and SECURITY.md: no child process is handed either. `git var`
    // is not enough to see the environment; a hook would be — and hooks are
    // off — so an alias that runs a shell prints it.
    const repo = await repository()
    await git(repo, 'config', 'alias.env', '!env')
    const env = { ...process.env, OPENAI_API_KEY: 'sk-probe', IDP_BACKSTAGE_TOKEN: 'probe-token' }
    const printed = (await gitIn(repo, { env })(['env'])).toString('utf8')
    expect(printed).not.toContain('sk-probe')
    expect(printed).not.toContain('probe-token')
    expect(printed).not.toMatch(/^GIT_AUTHOR_|^GIT_COMMITTER_/m)
  })

  it('never lets git guess who is committing', async () => {
    // Measured (git 2.46): with no user.name/user.email in any configuration,
    // `git var GIT_COMMITTER_IDENT` printed `<login> <<login>@<host>.localdomain>`,
    // exit 0 — the identity `commit-tree` would have signed a branch with.
    // With user.useConfigOnly it refuses, exit 128 (D13). The system file
    // cannot be switched off here: GIT_CONFIG_NOSYSTEM is a GIT_* variable and
    // the launcher scrubs it. An identity written there is a configured one,
    // not a guess, so on such a machine the probe is expected to succeed.
    expect(HARDENING).toContain('user.useConfigOnly=true')
    const repo = await repository()
    await git(repo, 'config', '--unset', 'user.name')
    await git(repo, 'config', '--unset', 'user.email')
    const home = await mkdtemp(path.join(tmpdir(), 'idp-home-'))
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home }
    const configured = await promisify(execFile)('git', ['config', '--system', '--get', 'user.email']).then(
      () => true,
      () => false,
    )

    const probe = gitIn(repo, { env })(['var', 'GIT_COMMITTER_IDENT'])

    if (configured) await expect(probe).resolves.toBeDefined()
    else await expect(probe).rejects.toBeInstanceOf(GitError)
  })

  it('hands stdin over byte for byte, carriage returns included', async () => {
    // A blob's id is a hash of its exact bytes, computed here the way git
    // computes it (measured equal for sha1). A runner that re-encoded, trimmed
    // or line-ended its input would produce a different id.
    const repo = await repository()
    const bytes = Buffer.from('a\r\nb\n', 'utf8')
    const expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const oid = (await gitIn(repo)(['hash-object', '--stdin', '--no-filters'], bytes)).toString('utf8').trim()
    expect(oid).toBe(expected)
  })

  it('says git is missing rather than failing somewhere else', async () => {
    const repo = await repository()
    const error = await gitIn(repo, { env: { PATH: '' } })(['--version']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('ENOENT')
  })

  it('stops a call past its bound, and says so', async () => {
    const repo = await repository()
    const error = await gitIn(repo, { limits: { timeoutMs: 15_000, maxOutputBytes: 8 } })([
      'log', '--format=%H%H%H',
    ]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
  })
})
```

The alias test relies on git running a `!` alias through a shell with the child's
environment; if that proves platform-dependent, assert on `gitEnvironment(env)` directly and
keep `tests/unit/spawned-environment.test.ts`'s existing "is what git runs in" case as the
wired proof.

- [x] **Step 4: Write the launcher, and move `project-fs` onto it**

`src/process/environment.ts` is `src/context/spawned-environment.ts` moved unchanged, with
`BACKSTAGE_TOKEN_VARIABLE` moved beside it — a leaf imports nothing of ours, and
`context/backstage/transport.ts` then imports the name from here (re-exporting it, so no
other importer changes). `tests/unit/spawned-environment.test.ts` and
`src/context/README.md:187-189` follow the path.

`src/process/git.ts`:

```typescript
import { execFile } from 'node:child_process'
import path from 'node:path'
import { spawnedEnvironment } from './environment.js'

/**
 * The only module in `src/` that starts a process, and an architecture test
 * holds that. The Inspector's `git ls-files` and everything the local forge
 * does to a repository go through `gitIn`, so every line below applies to
 * every call or to none.
 *
 * What was measured, and what each line answers:
 *
 *   - `-c core.hooksPath=/dev/null` — a `reference-transaction` hook in the
 *     user's repository RAN inside `update-ref`. A repository's hooks are its
 *     owner's code, and this tool does not run it.
 *   - `-c core.fsmonitor=false`, `-c core.untrackedCache=false` — a configured
 *     fsmonitor is a program git runs; `ls-files` runs it.
 *   - `-c user.useConfigOnly=true` — with no `user.name`/`user.email`
 *     configured, git GUESSED an identity from the login and host names and
 *     `git var GIT_COMMITTER_IDENT` exited 0, so `commit-tree` would have
 *     signed a branch with it. With this, both refuse (exit 128), and the
 *     forge's probe means what it says (D13).
 *   - `spawnedEnvironment()` minus every `GIT_*` — an inherited `GIT_DIR` sent
 *     `git -C <repo>` to another repository entirely; `GIT_CONFIG_PARAMETERS`
 *     would undo the overrides; `GIT_AUTHOR_*`/`GIT_COMMITTER_*` are a caller's
 *     choice of identity (D13). And no provider key and no catalogue token:
 *     git has no use for either, and its hooks no right to them (ADR-0011).
 *   - `cwd` is Node's own directory, the repository named by `-C` and an
 *     absolute path: Windows looks a program up in the working directory
 *     first, so a `git.exe` at a repository's root would run.
 *   - a timeout and an output cap — past either, nothing is read rather than
 *     something partial.
 *   - `execFile`, no shell — no argument is ever interpreted.
 *
 * What this does NOT do: sandbox git. It reads the user's global
 * configuration (their identity lives there), and `/dev/null` is not a
 * directory name on Windows, which CI does not run.
 */

export interface GitLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

/** A listing is about 60 bytes a file: this reads a repository of half a million. */
export const GIT_LIMITS: GitLimits = { timeoutMs: 15_000, maxOutputBytes: 32 * 1024 * 1024 }

export const HARDENING: readonly string[] = [
  '--no-pager',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'user.useConfigOnly=true',
]

const NEUTRAL_DIRECTORY = path.dirname(process.execPath)

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: string | number | undefined,
    /** git's own words: a repository's content can reach them, so `cli/` prints them through `inertLine`. */
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(`git ${args[0] ?? ''} failed${timedOut ? ': timed out' : ''}`)
    this.name = 'GitError'
  }
}

/** One git invocation: arguments, optional stdin, stdout as bytes. */
export type Git = (args: readonly string[], input?: Buffer) => Promise<Buffer>

/** The environment every git call runs in. The C locale makes a message read the same on every machine. */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(spawnedEnvironment(env))) {
    if (!name.toUpperCase().startsWith('GIT_')) kept[name] = value
  }
  return { ...kept, LC_ALL: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
}

export function gitIn(
  repo: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly limits?: GitLimits } = {},
): Git {
  const env = gitEnvironment(options.env)
  const limits = options.limits ?? GIT_LIMITS
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...HARDENING, '-C', repo, ...args],
        {
          cwd: NEUTRAL_DIRECTORY,
          env,
          encoding: 'buffer',
          timeout: limits.timeoutMs,
          maxBuffer: limits.maxOutputBytes,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new GitError(args, error.code ?? undefined, stderr.toString('utf8'), error.killed === true))
            return
          }
          resolve(stdout)
        },
      )
      // A git that failed to start, or exited before reading, closes its end
      // of the pipe; the write then fails with EPIPE on the stream. The
      // failure that matters is already reported by the callback above, and
      // an unhandled stream error would crash the CLI instead of refusing.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
}
```

*As built:* `SPAWNS`' own rule refuses two lines above — a module that starts a process may
not name `process.env`, and its call must pass `env: gitEnvironment(…)` — so `gitEnvironment`
takes `env?` and hands it to `spawnedEnvironment` (whose default is the process's), and the
call is `env: gitEnvironment(options.env)`; the rule now accepts an argument there, since
whatever is passed still goes through `spawnedEnvironment`.

`GitError`'s message no longer carries git's stderr: a repository's content can reach it (a
ref name, a path), and `cli/` prints it through `inertLine` when it prints it at all.

In `src/context/project-fs/snapshot.ts`, `GIT_LIMITS`, `GIT_OVERRIDES`, `gitEnvironment` and
`NEUTRAL_DIRECTORY` (`:377-422`) go, and its `git(root, args)` (`:430-452`) becomes a wrapper
that keeps its `GitOutcome` shape — `gitIn(root)(args)` decoded as UTF-8, a `GitError` turned
into `{ ok: false, missing: error.code === 'ENOENT', stderr: error.stderr }` — so its two
callers (`:489`, `:504`) and its tests do not change. `project-tracked.test.ts` and
`spawned-environment.test.ts` stay green unchanged: that is the proof the move changed nothing
the Inspector does.

`src/forge/provider.ts`:

```typescript
import type { Cleared, Expectation, Repository } from '../core/plan/clear.js'

/**
 * Where a submission is cut from, and where a merge request will point.
 *
 * Types only, like `llm/client.ts`, and for the same reason: `agents/` may
 * name a forge's shapes without being able to call one — the architecture test
 * "only cli/ reaches forge/ at runtime" holds that line.
 */
export interface Base {
  /** The branch HEAD names — `main`, not `refs/heads/main`. */
  readonly branch: string
  readonly commit: string
}

export type Submitted =
  | { readonly outcome: 'created'; readonly branch: string; readonly commit: string }
  /** The same bytes, already submitted on this base: the branch is named and nothing is written (§9.2). */
  | { readonly outcome: 'already-submitted'; readonly branch: string; readonly commit: string }
  /** No edit changes a byte: no branch, no commit. */
  | { readonly outcome: 'unchanged' }
  /** Refused at the moment of acting. Nothing observable was written. */
  | { readonly outcome: 'refused'; readonly reason: string }

/**
 * A forge can do three things, and the absences are the design (ADR-0006,
 * ADR-0010).
 *
 * No `merge`: the merge is the act of authorisation, and a tool that could
 * perform it would make that sentence a matter of not calling a method. There
 * is no method. Stage 6's negative test calls the forge's merge endpoint
 * directly with the token this interface holds, and requires it to FAIL.
 *
 * No `delete`, no push to a base, no way to name the branch: `submit` takes a
 * `Cleared`, whose branch the engine computed from its bytes, and creates it —
 * it can never move a ref that exists, `main` included.
 *
 * Opened for ONE repository (check §5): a clearance of the other is refused
 * before anything else.
 */
export interface ForgeProvider {
  readonly name: 'local'
  readonly repository: Repository
  /** HEAD as a branch and a commit. Refuses a detached or unborn HEAD. */
  base(): Promise<Base>
  /** Each way the base differs from what the gates judged, as a sentence. Empty: it does not. */
  diverges(base: Base, expected: Expectation): Promise<readonly string[]>
  /** Re-reads the base, re-checks divergence, then creates one branch — or says why not. */
  submit(change: Cleared, base: Base): Promise<Submitted>
}
```

`src/forge/errors.ts`:

```typescript
/**
 * The refusals that are the user's arguments — a repository that is not a
 * working tree's root, a detached HEAD, no `git` on PATH, no committer
 * identity. `cli/index.ts` turns them into exit 2, the way it already does
 * `PlanInputError`.
 */
export class ForgeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForgeInputError'
  }
}
```

`src/process/README.md` and `src/forge/README.md` state, in the style of the other folder
READMEs, what lives there, what may not, which rules hold the line, that `process/git.ts` is
the only process `src/` starts, and that nothing in `forge/` checks out, stages or touches a
working tree.

- [x] **Step 5: Run the rules and the launcher tests**

Run: `pnpm vitest run tests/architecture tests/unit/process-git.test.ts tests/unit/spawned-environment.test.ts tests/unit/project-tracked.test.ts --reporter=verbose`
Expected: PASS, and the architecture file reports **22** rules — 19, and three new. Count
them from the output; the number is the one that drifts first.

*As built, after review:* **23**. Four holes the review measured, each probe passing all 22:
a module of `context/backstage/` or `llm/` importing `gitIn` and running
`show HEAD:.env` past project-fs's secret exclusions; a `context/` module importing a
`cli/` module that imports the forge; `forge/` importing `node:http` and
`node:fs/promises`; and `gitEnvironment(env)` handing `{ ...env }` on after a call to
`spawnedEnvironment(env)` whose result it dropped. So: a fourth rule, *only
context/project-fs and forge/ load the git launcher* (a type may be named anywhere, and
neither of the two may hand it on with `export … from`); *only cli/ reaches forge/ at
runtime* walks the value-import closure from every module outside `cli/` and `forge/`, into
`cli/` included; the forge rule became *forge/ imports core/, process/, node:crypto and
node:path, and nothing else* — a list of what may be imported, since a list of what may not
is the one nobody finished; and the `SPAWNS` rule holds a spawner's environment function to
naming its parameters (and `arguments`) only inside `spawnedEnvironment(…)`. A run-time load
no source spells is refused by each of these rules with one message, *no rule can tell what
it names*, and a type written as `import('…')` counts as a load — `import type` says the
same and is read as erased. Each has a self-test case, seen failing before the code. In
`tests/unit/process-git.test.ts`, the planted-`git` case now stands in the repository, as
`plan "<intent>"` does, so deleting the launcher's `cwd` fails it (it did not, before), and
the identity case asserts git's own refusal — exit 128, *auto-detection is disabled* —
rather than any `GitError`, on a system configuration holding neither or half an identity.

- [x] **Step 6: Correct what this makes false, in this commit**

- `AGENTS.md`:
  - "**Nineteen** architecture rules" → the number measured;
  - name the three new rules, say `core/`'s disk rule is transitive, and replace "only
    `project-fs/snapshot.ts` starts a process (`git ls-files`)" with "only `process/git.ts`
    starts a process, for the Inspector's `git ls-files` and the forge";
  - the layering diagram: `cli/ ──→ forge/ ──→ core/`, and `process/` as the leaf
    `context/project-fs` and `forge/` share;
  - the folder table: a `forge/` row and a `process/` row; `context/`'s row no longer holds
    `spawnedEnvironment`.
- `docs/design.md` §5.5: the rule count, with one sentence on the new rules and transitivity.
- `SECURITY.md`: the row *No child process is handed a provider key or the Backstage token*
  names the launcher; the row *only named modules write, and one starts a process* names it.

- [x] **Step 7: Traceability**

- `CHANGELOG.md`, Unreleased → Changed: one line (the launcher shared, the rules), with the link.
- `docs/roadmap.md`: stage 5's queue item says task 3 is on `main`.

- [ ] **Step 8: Run everything and commit** *(after the owner's go-ahead)*

```bash
pnpm typecheck && pnpm test   # the full run only with 2 GiB free on /
git add src/process src/forge src/context src/core/README.md tests AGENTS.md docs/design.md SECURITY.md CHANGELOG.md docs/roadmap.md docs/plans/stage-5-write.md docs/reviews/2026-09-23-deep-review.md
git commit -m "feat(forge): one hardened git launcher for every process, and the rules that fence the layer that writes"
```

---

### Task 4: The local forge — create-only, idempotent, atomic

*Amended on 2026-09-29 (check §3 P4, §5; D3, D7, D13, D17).* What holds: `blobId`, `treeOf`,
`writeTree` (keeps `100755`, refuses a file-as-folder), `openLocalForge` refusing a
non-worktree, a non-root and a missing git; `base()` refusing a detached or unborn `HEAD`;
`diverges()` refusing symlinks and, in catalogue scope, any catalogue blob never read;
`submit()` re-reading the base, re-checking divergence, enforcing the `idp-agent/` prefix and
`check-ref-format`, one create-only `update-ref`, and race recovery that tells its own commit
from a stranger's; `hash-object --stdin --no-filters`; and the fault-injection invariant over
real repositories as the proof of atomicity. What changes: the fixture is signed on `main`'s
shapes; the forge is opened for one repository and refuses a clearance of the other; it
refuses any object `clear.ts` did not mint (D3); a branch carrying our files on another
parent is refused, never `already-submitted` (D7); the committer identity is probed when the
forge opens, before any model, and git may not guess one (D13, `user.useConfigOnly`); the branch name is recomputed, not trusted; and git runs
through task 3's launcher.

*Added in task 1's review — two things this task inherits.* **An empty clearance.** A
`Cleared` whose every operation is `already-declared` carries no edit, and its `branch` is
the same name for every such plan (`branchFor([])`, the digest of nothing): `submit()` must
answer `unchanged` before any ref, which the `unchanged` case below already asserts with
`observable`. **The hidden files the gates judged.** A `catalogue`-scope `Expectation` holds
catalogue paths only; the `.witness.yml` files `unwitnessed-folder` read and
`.idp-agent.yml`'s `environments` are not in `expected.files` (`clear.ts`, `Expectation`).
`diverges()` therefore cannot see a witness removed, or the configuration changed, between
clearance and submission. Stated, not closed, beside gap-stage5-readiness-6's
`PolicyContext` limit; `validate` over the branch still reports a missing witness as an
error. Closing it means the clearance holding those files' bytes, which is a change to
`ClearInput`, not to the forge.

**Files:**
- Create: `src/forge/local/objects.ts`, `src/forge/local/forge.ts`
- Create: `tests/support/forge-fixture.ts`, `tests/unit/local-forge.test.ts`, `tests/invariants/forge.test.ts`
- Modify: `docs/design.md` §4.3, §8, §9.2; `src/scaffold/write.ts`, `src/scaffold/README.md`, the `scaffold/` comment in `tests/architecture/dependencies.test.ts` (comments only); `SECURITY.md`, `AGENTS.md` (the writers)
- Modify: `CHANGELOG.md`, `docs/roadmap.md`, the review's Status

**Interfaces:**
- Consumes: `Git`, `GitError`, `gitIn` (task 3, `process/git.ts`); `ForgeProvider`, `Base`,
  `Submitted`, `ForgeInputError` (task 3); `Cleared`, `Expectation`, `Repository`,
  `isCleared`, `branchFor`, `SUBMISSION_PREFIX`, `clearPlan` (task 1); `isCataloguePath`
  (task 1); `git`, `show`, `committed`, `observable` (task 3).
- Produces:
  - `function openLocalForge(repo: string, repository: Repository, git?: Git): Promise<ForgeProvider>`
  - `function blobId(bytes: Buffer, format: 'sha1' | 'sha256'): string`
  - `function treeOf(git: Git, commit: string): Promise<Map<string, TreeEntry>>` with `interface TreeEntry { readonly mode: string; readonly type: string; readonly oid: string }`
  - `function writeTree(git: Git, tree: string | undefined, blobs: ReadonlyMap<string, string>): Promise<string>`

A submission becomes visible at exactly one point: `update-ref <ref> <commit> ""`, whose
empty old value means *create, and refuse if it exists*. Everything before it writes only
objects no ref reaches. That is the whole of the atomicity argument, and the property in
this task checks it.

- [ ] **Step 1: Write the failing tests**

`tests/support/forge-fixture.ts` is shared by both test files below. It holds a scaffolded
declarations repository that has been committed, plus a `Cleared` minted the way the CLI
will mint one. At `eee67d6` it signed with a `SignatureContext {wordsOf, answered}` and built
`PolicyContext` by hand without `over` and `namesakes`; on `main` the provenance is
`signPlan`'s third argument and travels with the signature (D1), and both contexts are the
ones `contextsOf` builds (`plan.ts:262`) — imported if task 1 exported it for the parity
test, else built as below. `runInitPlatform` now also commits the root `catalog-info.yaml`,
the Backstage registration (#86), so the base's `HEAD` holds it and the clearance must name
it in its expectation:

```typescript
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { clearPlan, type Cleared } from '../../src/core/plan/clear.js'
import { namesakesOf } from '../../src/core/plan/environment.js'
import type { PolicyContext } from '../../src/core/plan/policies.js'
import { signPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { committed } from './git.js'
import { saidInFull } from './provenance.js'

export const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

export const OPERATIONS = [
  {
    op: 'create-entity',
    entity: {
      kind: 'Resource',
      metadata: { name: 'orders-db-prod', env: 'prod' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    },
  },
  {
    op: 'create-entity',
    entity: {
      kind: 'Resource',
      metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
      spec: {
        type: 'database-access',
        access: 'read',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/orders-db-prod'],
        dependencyOf: ['component:default/billing-api'],
      },
    },
  },
]

export const DATABASE_PATH = 'catalog/databases/orders-db-prod.yml'
export const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'

/** A committed declarations repository, exactly as `init platform` leaves one. */
export const clone = async (): Promise<string> => {
  const repo = path.join(await mkdtemp(path.join(tmpdir(), 'idp-forge-')), 'iac')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  await committed(repo)
  return repo
}

/** What the CLI mints: the free gates re-run over the repository as read. */
export const clearedFor = async (repo: string): Promise<Cleared> => {
  const snapshot = await readRepository(repo)
  const contents = new Map<string, string>()
  for (const file of snapshot.files) {
    contents.set(file.path, await readFile(path.join(repo, ...file.path.split('/')), 'utf8'))
  }
  const plan = planSchema.parse({ intent: INTENT, operations: OPERATIONS })
  const signed = signPlan(
    plan,
    {
      witnessed: new Set(['component:default/billing-api']),
      vocabulary: { kinds: [], types: [], environments: ['dev', 'staging', 'prod'], owners: [] },
      repoRoot: repo,
      declared: new Map(),
    },
    // The level and each environment answered at their paths, as a person at
    // the prompt would; the provenance travels with the signature (D1).
    saidInFull(plan),
  )
  if ('outcome' in signed) throw new Error(JSON.stringify(signed.refusals))
  const policy: PolicyContext = {
    vocabulary: { kinds: [], types: [], environments: ['dev', 'staging', 'prod'], owners: [] },
    witnesses: new Set(snapshot.witnesses),
    environments: new Map(),
    levels: new Map(),
    natures: new Map(),
    over: new Map(),
    namesakes: namesakesOf([]),
  }
  const result = clearPlan(signed, { policy, snapshot, contents })
  if ('outcome' in result) throw new Error(result.reasons.join('\n'))
  return result
}
```

`tests/unit/local-forge.test.ts`. Each test builds a real repository:

```typescript
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Cleared } from '../../src/core/plan/clear.js'
import { ForgeInputError } from '../../src/forge/errors.js'
import { openLocalForge } from '../../src/forge/local/forge.js'
import { ACCESS_PATH, DATABASE_PATH, clearedFor, clone } from '../support/forge-fixture.js'
import { committed, git, observable, show } from '../support/git.js'

describe('opening a local forge', () => {
  it('refuses a directory that is not a git working tree', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'idp-plain-'))
    await expect(openLocalForge(plain, 'declarations')).rejects.toThrow(ForgeInputError)
  })

  it("refuses a directory inside someone else's repository", async () => {
    // Measured on this very repository: `git -C fixtures/si-demo` answers for
    // idp-agent itself. A branch cut there would be cut in the parent.
    const parent = await mkdtemp(path.join(tmpdir(), 'idp-parent-'))
    await mkdir(path.join(parent, 'iac'))
    await writeFile(path.join(parent, 'iac', 'x.yml'), '# x\n')
    await committed(parent)
    await expect(openLocalForge(path.join(parent, 'iac'), 'declarations')).rejects.toThrow(/not at its root/)
  })

  it('refuses a detached HEAD, which no merge request could target', async () => {
    const repo = await clone()
    await git(repo, 'checkout', '-q', '--detach')
    const forge = await openLocalForge(repo, 'declarations')
    await expect(forge.base()).rejects.toThrow(/detached/)
  })
})

describe('submitting', () => {
  it('cuts one branch from HEAD, and nothing else a person can observe moves', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('created')
    if (submitted.outcome !== 'created') return
    // Exactly one new line in the ref list, and it is ours.
    const after = await observable(repo)
    const added = after.split('\n').filter((line) => !before.split('\n').includes(line))
    expect(added).toEqual([`refs/heads/${change.branch} ${submitted.commit}`])
    expect(await git(repo, 'rev-parse', 'main')).toBe(base.commit)
    // The commit sits on the base, and differs from it at the edited paths only.
    expect(await git(repo, 'rev-parse', `${submitted.commit}^`)).toBe(base.commit)
    expect((await git(repo, 'diff', '--name-status', base.commit, submitted.commit)).split('\n')).toEqual([
      `A\t${DATABASE_PATH}`,
      `A\t${ACCESS_PATH}`,
    ])
    // The bytes on the branch are the bytes the preview showed.
    for (const edit of change.edits) {
      expect(await show(repo, submitted.commit, edit.path)).toBe(edit.after)
    }
  })

  it('submitting the same bytes twice is submitting them once', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const first = await forge.submit(change, base)
    const between = await observable(repo)

    const second = await forge.submit(change, base)

    expect(second).toEqual({ ...first, outcome: 'already-submitted' })
    expect(await observable(repo)).toBe(between)
  })

  it('refuses when the branch exists and carries something else', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    expect(await observable(repo)).toBe(before)
  })

  it('does not mistake a squatted branch for its own, however right its files look', async () => {
    // Measured before this rule existed: a branch holding our two files plus
    // one more was reported "already submitted", exit 0. The name is a hash of
    // the content, so anyone who can create refs can predict it.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const first = await forge.submit(change, base)
    if (first.outcome !== 'created') throw new Error(first.outcome)
    // Rebuild the branch as someone else would: our files, and an extra one.
    await git(repo, 'update-ref', '-d', `refs/heads/${change.branch}`)
    await git(repo, 'checkout', '-q', '-b', 'squatter', first.commit)
    await writeFile(path.join(repo, 'catalog', 'databases', 'extra.yml'), '# extra\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '--amend', '-m', 'squat')
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    await git(repo, 'checkout', '-q', 'main')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    expect(await observable(repo)).toBe(before)
  })

  it('cannot be aimed at main, even by a cast that ignores the brand', async () => {
    // The engine computes the name, so this cannot happen by wiring. It is
    // tested anyway: §4.2 repeats a check at the moment of acting. A spread
    // of a real clearance type-checks through a cast; the runtime brand (D3)
    // is what refuses it, first — the namespace check and the recomputed name
    // behind it are kept, and are unreachable from a minted value.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forged = { ...change, branch: 'main' } as unknown as Cleared
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(forged, await forge.base())

    expect(submitted.outcome).toBe('refused')
    // The brand itself, not a later check: without it `existing()` refuses
    // too ("main already exists …"), and a test asserting only `refused`
    // passed with the check deleted.
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain('not a clearance')
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a clearance for the other repository, before anything else', async () => {
    // Check §5: since #86 the declarations repository has a root
    // catalog-info.yaml too, so a service's clearance can pass `diverges()`
    // there. Opened for one role, the forge refuses the other, both ways.
    const repo = await clone()
    const change = await clearedFor(repo)
    const before = await observable(repo)
    const service = await openLocalForge(repo, 'service')

    const submitted = await service.submit(change, await service.base())

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toMatch(/declarations.*service|service.*declarations/)
    expect(await observable(repo)).toBe(before)
    // And the other way: a clearService value handed to a declarations forge —
    // written with task 2's `clearService` over this repository.
  })

  it('refuses our files on a parent that is not the base', async () => {
    // D7. Branch names are predictable; someone who can create refs can put
    // our exact files on top of a parent carrying an unrelated change, and
    // "already submitted" on exit 0 would put that change under this user's
    // request — at stage 6, in a merge request.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    await git(repo, 'checkout', '-q', '-b', 'elsewhere')
    await writeFile(path.join(repo, 'README.md'), '# an unrelated change\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'unrelated')
    for (const edit of change.edits) {
      await mkdir(path.dirname(path.join(repo, edit.path)), { recursive: true })
      await writeFile(path.join(repo, edit.path), edit.after)
    }
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'ours, on another parent')
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    await git(repo, 'checkout', '-q', 'main')
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain(base.commit.slice(0, 7))
    expect(await observable(repo)).toBe(before)
  })

  it('says there is no committer identity before anything is read', async () => {
    // D13: the scrub removes GIT_AUTHOR_* and GIT_COMMITTER_*, so the identity
    // comes from git's config; its absence used to surface after the paid
    // model run, as a generic exit 1 from `commit-tree`. The absence is set up
    // in configuration, not with GIT_CONFIG_NOSYSTEM (the launcher scrubs every
    // GIT_*): an empty name and email in the repository's own file override the
    // global and system files, and git refuses them (measured: "empty ident
    // name (for <>) not allowed", exit 128). That git never GUESSES one when
    // none is configured is the launcher's test (process-git.test.ts).
    const repo = await clone()
    await git(repo, 'config', 'user.name', '')
    await git(repo, 'config', 'user.email', '')
    await expect(openLocalForge(repo, 'declarations')).rejects.toThrow(/identity/)
  })

  it('never carries a linked file into a submitted blob', async () => {
    // D17: B3 is after stage 5. The forge writes objects and one ref, never the
    // working tree, and refuses a symlink tracked in HEAD and any path absent
    // from it — so a file the walk followed through a link cannot reach a branch.
    const repo = await clone()
    const outside = path.join(await mkdtemp(path.join(tmpdir(), 'idp-outside-')), 'secret.yml')
    await writeFile(outside, '# outside the repository\n')
    await symlink(outside, path.join(repo, 'catalog', 'databases', 'linked.yml'))
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'a link')
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain('linked.yml')
  })

  it('refuses when the working tree is not what HEAD holds', async () => {
    // The gates judged the working tree; the branch is cut from HEAD. A dirty
    // or untracked catalogue file makes those two different repositories.
    const repo = await clone()
    await writeFile(path.join(repo, 'catalog', 'databases', 'stray.yml'), '# stray\n')
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain('stray.yml')
    expect(await observable(repo)).toBe(before)
  })

  it('refuses when HEAD moved between reading and writing', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'meanwhile')

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toMatch(/moved/)
  })

  it('refuses — never an argument error — when HEAD is detached during the run', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    await git(repo, 'checkout', '-q', '--detach')

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
  })

  it('cuts no branch for a change that changes nothing', async () => {
    // A real empty clearance, not a spread (the brand refuses those): the
    // plan's files committed on main, then cleared again — every operation
    // already declared (#83), so `clearPlan` mints one with no edit.
    const repo = await clone()
    const first = await clearedFor(repo)
    for (const edit of first.edits) {
      await mkdir(path.dirname(path.join(repo, edit.path)), { recursive: true })
      await writeFile(path.join(repo, edit.path), edit.after)
    }
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'merged')
    const empty = await clearedFor(repo)
    expect(empty.edits).toEqual([])
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)
    expect(await forge.submit(empty, await forge.base())).toEqual({ outcome: 'unchanged' })
    expect(await observable(repo)).toBe(before)
  })

  it("runs none of the repository's hooks while it writes", async () => {
    const repo = await clone()
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'idp-hook-')), 'ran')
    for (const hook of ['reference-transaction', 'post-commit', 'pre-commit']) {
      const file = path.join(repo, '.git', 'hooks', hook)
      await writeFile(file, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    }
    const forge = await openLocalForge(repo, 'declarations')
    await forge.submit(await clearedFor(repo), await forge.base())
    await expect(readFile(marker)).rejects.toThrow()
  })
})
```

`tests/invariants/forge.test.ts`, §9.2's atomicity invariant. Failure is injected at every
mutating step, before and after the step runs:

```typescript
import { rm } from 'node:fs/promises'
import path from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { openLocalForge } from '../../src/forge/local/forge.js'
import type { Git } from '../../src/process/git.js'
import { gitIn } from '../../src/process/git.js'
import { clearedFor, clone } from '../support/forge-fixture.js'
import { git, observable, show } from '../support/git.js'

/** The calls that write anything at all — into the object store, or a ref. */
const mutates = (args: readonly string[]): boolean =>
  (args[0] === 'hash-object' && args.includes('-w')) ||
  args[0] === 'mktree' ||
  args[0] === 'commit-tree' ||
  args[0] === 'update-ref'

/** A runner that throws at the k-th mutating call, before it runs or just after. */
const failingAt = (inner: Git, k: number, late: boolean): Git => {
  let seen = 0
  return async (args, input) => {
    const counted = mutates(args) ? ++seen : 0
    if (counted === k && !late) throw new Error(`injected before ${args[0] ?? ''}`)
    const out = await inner(args, input)
    if (counted === k && late) throw new Error(`injected after ${args[0] ?? ''}`)
    return out
  }
}

describe('§9.2 — application is atomic', () => {
  // Twenty-four real repositories per run: removed at the end, because the
  // temporary directories of a test run fill a small disk (run it targeted).
  const made: string[] = []
  afterAll(async () => {
    await Promise.all(made.map((repo) => rm(path.dirname(repo), { recursive: true, force: true })))
  })

  it('a submission failing at any step leaves the initial state, or the complete branch', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 12 }), fc.boolean(), async (k, late) => {
        const repo = await clone()
        made.push(repo)
        const change = await clearedFor(repo)
        const before = await observable(repo)
        const forge = await openLocalForge(repo, 'declarations', failingAt(gitIn(repo), k, late))

        const outcome = await forge.submit(change, await forge.base()).catch(() => 'threw' as const)
        const after = await observable(repo)

        if (after === before) return
        // The one other acceptable state: the injection landed after the ref
        // was created, so the branch exists — whole.
        const branch = await git(repo, 'rev-parse', '--verify', `refs/heads/${change.branch}`)
        for (const edit of change.edits) {
          expect(await show(repo, branch, edit.path)).toBe(edit.after)
        }
        expect(outcome === 'threw' || outcome.outcome === 'created').toBe(true)
      }),
      { numRuns: 24 },
    )
    // Twenty-four real repositories: ~2 s alone, past vitest's 5 s default
    // inside the full parallel suite (measured in the dry run).
  }, 60_000)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/unit/local-forge.test.ts tests/invariants/forge.test.ts`
Expected: FAIL — `forge.js` not found.

- [ ] **Step 3: Write the object layer**

`src/forge/local/objects.ts`:

```typescript
import { createHash } from 'node:crypto'
import type { Git } from '../../process/git.js'

/**
 * Reading and writing git objects, and never a ref. Nothing here is visible to
 * a person: an object no ref reaches is garbage `git gc` collects, which is the
 * whole of why a submission is atomic.
 */

export interface TreeEntry {
  readonly mode: string
  readonly type: string
  readonly oid: string
}

/**
 * A blob's id computed here rather than asked of git, one call instead of one
 * per file. Measured equal to `git hash-object` for sha1; sha256 repositories
 * hash the same header with the other function.
 */
export function blobId(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** Every blob of a commit, path → entry, from one `ls-tree -r -z`. */
export async function treeOf(git: Git, commit: string): Promise<Map<string, TreeEntry>> {
  const listing = (await git(['ls-tree', '-r', '-z', '--full-tree', commit])).toString('utf8')
  const entries = new Map<string, TreeEntry>()
  for (const line of listing.split('\0')) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    const [mode = '', type = '', oid = ''] = line.slice(0, tab).split(' ')
    entries.set(line.slice(tab + 1), { mode, type, oid })
  }
  return entries
}

/**
 * The tree `tree` becomes once each path in `blobs` holds that blob. Built
 * with `mktree`, level by level, so no index is written — not the user's, not
 * a temporary one — and the only side effect is objects.
 *
 * An existing file keeps its mode; a new one is `100644`. A path whose folder
 * is a FILE at the base cannot be written, and says so: the gates never judged
 * such a repository.
 */
export async function writeTree(
  git: Git,
  tree: string | undefined,
  blobs: ReadonlyMap<string, string>,
): Promise<string> {
  const entries = new Map<string, string>()
  if (tree !== undefined) {
    for (const line of (await git(['ls-tree', '-z', tree])).toString('utf8').split('\0')) {
      if (line === '') continue
      const tab = line.indexOf('\t')
      entries.set(line.slice(tab + 1), line.slice(0, tab))
    }
  }

  const here = new Map<string, string>()
  const below = new Map<string, Map<string, string>>()
  for (const [file, blob] of blobs) {
    const slash = file.indexOf('/')
    if (slash === -1) {
      here.set(file, blob)
      continue
    }
    const folder = file.slice(0, slash)
    const rest = below.get(folder) ?? new Map<string, string>()
    rest.set(file.slice(slash + 1), blob)
    below.set(folder, rest)
  }

  for (const [name, blob] of here) {
    // An executable file stays executable; anything else — a new file, and a
    // symlink, which `diverges` has already refused — becomes a regular one.
    const [mode] = (entries.get(name) ?? '').split(' ')
    entries.set(name, `${mode === '100755' ? '100755' : '100644'} blob ${blob}`)
  }
  for (const [folder, rest] of below) {
    const existing = entries.get(folder)
    const [, type, oid] = (existing ?? '').split(' ')
    if (existing !== undefined && type !== 'tree') {
      throw new Error(`${folder} is a file at the base, not a folder`)
    }
    entries.set(folder, `040000 tree ${await writeTree(git, oid, rest)}`)
  }

  // mktree normalises the order itself (measured): no sort needed here.
  const input = [...entries].map(([name, head]) => `${head}\t${name}\0`).join('')
  return (await git(['mktree', '-z'], Buffer.from(input, 'utf8'))).toString('utf8').trim()
}
```

- [ ] **Step 4: Write the forge**

`src/forge/local/forge.ts`:

```typescript
import type { Cleared, Expectation, Repository } from '../../core/plan/clear.js'
import { branchFor, isCleared, SUBMISSION_PREFIX } from '../../core/plan/clear.js'
import { isCataloguePath } from '../../core/paths/catalogue.js'
import { GitError, gitIn, type Git } from '../../process/git.js'
import { ForgeInputError } from '../errors.js'
import type { Base, ForgeProvider, Submitted } from '../provider.js'
import { blobId, treeOf, writeTree } from './objects.js'

const text = (bytes: Buffer): string => bytes.toString('utf8').trim()
const short = (commit: string): string => commit.slice(0, 7)
const refused = (reason: string): Submitted => ({ outcome: 'refused', reason })

/** The digest half of a branch name: what the forge can recompute from the bytes alone. */
const digestOf = (branch: string): string => branch.slice(branch.lastIndexOf('-') + 1)

/**
 * A forge over a clone on this machine, for ONE repository — the declarations
 * repository or the service's (check §5). It cuts a branch; it opens no merge
 * request — there is nothing here to open one on, and the CLI says so.
 *
 * Opening it is where the arguments are judged, once and before any model: a
 * working tree, at its ROOT — `git -C <dir>` walks upwards, and measured on this
 * very repository, `fixtures/si-demo` answered for idp-agent, so a branch cut
 * there would have been cut in the parent, with paths computed for the child —
 * and a committer identity, which `commit-tree` needs and the scrub of
 * `GIT_COMMITTER_*` leaves to git's configuration — configured, never guessed:
 * the launcher's `user.useConfigOnly=true` makes this probe fail where git
 * would otherwise have made one up from the login and host names (D13).
 */
export async function openLocalForge(
  repo: string,
  repository: Repository,
  git: Git = gitIn(repo),
): Promise<ForgeProvider> {
  const inside = await git(['rev-parse', '--is-inside-work-tree']).catch((error: unknown) => {
    if (error instanceof GitError && error.code === 'ENOENT') {
      throw new ForgeInputError('git is not on PATH; --submit cuts a branch with it')
    }
    throw new ForgeInputError(`${repo} is not a git working tree; --submit needs a clone`)
  })
  if (text(inside) !== 'true') {
    throw new ForgeInputError(`${repo} is not a git working tree; --submit needs a clone`)
  }
  const prefix = text(await git(['rev-parse', '--show-prefix']))
  if (prefix !== '') {
    throw new ForgeInputError(
      `${repo} is inside a git repository at ${prefix}, not at its root; ` +
        '--submit needs the root, or the branch would be cut in someone else’s repository',
    )
  }
  const format = text(await git(['rev-parse', '--show-object-format'])) === 'sha256' ? 'sha256' : 'sha1'
  await git(['var', 'GIT_COMMITTER_IDENT']).catch(() => {
    throw new ForgeInputError(
      'git has no committer identity here; set user.name and user.email ' +
        '(git config --global user.name …), then run this again',
    )
  })

  const base = async (): Promise<Base> => {
    const head = await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => undefined)
    if (head === undefined) {
      throw new ForgeInputError('HEAD is detached; check out the branch this request is for')
    }
    const commit = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => undefined)
    if (commit === undefined) {
      throw new ForgeInputError(`${text(head)} has no commit yet; a submission is cut from one`)
    }
    return { branch: text(head).replace(/^refs\/heads\//, ''), commit: text(commit) }
  }

  const diverges = async (at: Base, expected: Expectation): Promise<readonly string[]> => {
    const listing = await treeOf(git, at.commit)
    const where = `${at.branch}@${short(at.commit)}`
    const found: string[] = []
    for (const [file, bytes] of expected.files) {
      const entry = listing.get(file)
      if (bytes === undefined) {
        if (entry !== undefined) found.push(`${file} exists at ${where}, and was read as absent`)
        continue
      }
      if (entry === undefined) {
        found.push(`${file} was read but is not in ${where} — uncommitted, untracked or ignored`)
        continue
      }
      // A symlink's blob is its target's NAME; the reader followed it. Refused
      // rather than reasoned about: the gates judged bytes git does not hold.
      const regular = entry.mode === '100644' || entry.mode === '100755'
      if (!regular || entry.oid !== blobId(Buffer.from(bytes, 'utf8'), format)) {
        found.push(`${file} differs from ${where} — the gates judged the working tree, not the commit`)
      }
    }
    if (expected.scope === 'catalogue') {
      for (const [file, entry] of listing) {
        if (entry.type === 'blob' && isCataloguePath(file) && !expected.files.has(file)) {
          found.push(`${file} is in ${where} and was never read — the gates did not judge it`)
        }
      }
    }
    return found
  }

  /**
   * The branch as it stands, compared with the change: ours, someone else's, or
   * absent.
   *
   * "Ours" means EXACTLY this change: one commit, on THE BASE, differing
   * from it at these paths and no others, holding these bytes. Checking only
   * that our blobs are present was measured wrong: branch names are
   * predictable — they are a hash of the content — so a branch pre-created
   * with our files AND one more passed, and "already submitted" would have
   * put somebody else's file under this user's request. The same holds for a
   * parent carrying an unrelated change (D7): at stage 6 it would travel in
   * this user's merge request.
   */
  const existing = async (ref: string, change: Cleared, at: Base): Promise<Submitted | undefined> => {
    const found = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => undefined)
    if (found === undefined) return undefined
    const head = text(found)
    const other = refused(`${change.branch} already exists and carries a different change`)

    const parents = text(await git(['rev-list', '--parents', '-n', '1', head])).split(' ').slice(1)
    const [parent] = parents
    if (parents.length !== 1 || parent === undefined) return other
    if (parent !== at.commit) {
      return refused(
        `${change.branch} already exists on ${short(parent)}, not on ${at.branch}@${short(at.commit)}; ` +
          'it is not this submission',
      )
    }
    const touched = (await git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', parent, head]))
      .toString('utf8')
      .split('\0')
      .filter((line) => line !== '')
      .sort()
    const ours = change.edits.map((edit) => edit.path).sort()
    if (touched.length !== ours.length || touched.some((file, index) => file !== ours[index])) return other

    const listing = await treeOf(git, head)
    const same = change.edits.every(
      (edit) => listing.get(edit.path)?.oid === blobId(Buffer.from(edit.after, 'utf8'), format),
    )
    return same ? { outcome: 'already-submitted', branch: change.branch, commit: head } : other
  }

  const submit = async (change: Cleared, at: Base): Promise<Submitted> => {
    // First, and before any git call: the value is one `clear.ts` minted
    // (D3) — a spread, a cast or a clone of one is not — and it is for the
    // repository this forge was opened on (check §5).
    if (!isCleared(change)) return refused('not a clearance minted by clearPlan or clearService')
    if (change.repository !== repository) {
      return refused(
        `a clearance for the ${change.repository} repository was handed to a forge on the ${repository} repository`,
      )
    }
    // §4.4: check the repository again at the moment of writing. A HEAD that
    // became detached or unborn DURING the run is not an argument the user
    // typed wrong — it is the repository moving — so it is a refusal (exit 1),
    // never the ForgeInputError `base()` throws when the run starts (exit 2).
    const now = await base().catch((error: unknown) => {
      if (error instanceof ForgeInputError) return error
      throw error
    })
    if (now instanceof ForgeInputError) return refused(`${at.branch} changed during the run: ${now.message}`)
    if (now.branch !== at.branch || now.commit !== at.commit) {
      return refused(
        `${at.branch} moved from ${short(at.commit)} to ${now.branch}@${short(now.commit)} ` +
          'since the plan was read; run it again',
      )
    }
    const divergent = await diverges(at, change.expected)
    if (divergent.length > 0) {
      return refused(`the repository is not what the gates judged:\n  ${divergent.join('\n  ')}`)
    }
    if (change.edits.length === 0) return { outcome: 'unchanged' }

    // The engine computed this name; checked anyway, where the write happens —
    // its namespace, and its digest recomputed from the bytes.
    const ref = `refs/heads/${change.branch}`
    if (!change.branch.startsWith(SUBMISSION_PREFIX)) {
      return refused(`${change.branch} is outside ${SUBMISSION_PREFIX}; a submission creates nothing else`)
    }
    if (digestOf(branchFor(change.edits)) !== digestOf(change.branch)) {
      return refused(`${change.branch} does not name these bytes`)
    }
    const valid = await git(['check-ref-format', ref]).then(() => true, () => false)
    if (!valid) return refused(`${change.branch} is not a name git accepts`)

    const already = await existing(ref, change, at)
    if (already !== undefined) return already

    const blobs = new Map<string, string>()
    for (const edit of change.edits) {
      blobs.set(
        edit.path,
        text(await git(['hash-object', '-w', '--stdin', '--no-filters'], Buffer.from(edit.after, 'utf8'))),
      )
    }
    const tree = await writeTree(git, text(await git(['rev-parse', `${at.commit}^{tree}`])), blobs)
    const commit = text(
      await git(['commit-tree', tree, '-p', at.commit, '-F', '-'], Buffer.from(change.message, 'utf8')),
    )

    try {
      // The one visible act. `""` as the old value: create, and refuse if it
      // exists — so this can never move a ref, main included.
      await git(['update-ref', '-m', 'idp-agent: submitted for review', ref, commit, ''])
    } catch (error) {
      // Either somebody created the ref between our check and our write, or
      // the ref is ours and something failed after git made it — the
      // atomicity property found the second: a failure just after a
      // successful `update-ref` was reported "already submitted" by the very
      // call that submitted it. Ours is the commit we just built.
      const raced = await existing(ref, change, at)
      if (raced?.outcome === 'already-submitted' && raced.commit === commit) {
        return { outcome: 'created', branch: change.branch, commit }
      }
      if (raced !== undefined) return raced
      throw error
    }
    return { outcome: 'created', branch: change.branch, commit }
  }

  return { name: 'local', repository, base, diverges, submit }
}
```

- [ ] **Step 5: Run the tests, then everything**

Run: `pnpm vitest run tests/unit/local-forge.test.ts tests/invariants/forge.test.ts tests/architecture`
Expected: PASS. `forge.ts` and `objects.ts` import only `core/`, `process/`, `node:crypto` and
their siblings, which task 3's rules accept. `forge.test.ts` builds real repositories: run it
targeted, and the full suite only with 2 GiB free on `/` (`pnpm test && pnpm typecheck`).

**Limits, stated where they live** (in `forge.ts`'s comment and `SECURITY.md`):
- Working-tree bytes that differ from the `HEAD` blob only through `core.autocrlf` or a CRLF
  checkout are refused as divergence: the gates judged the working tree, the branch is cut
  from `HEAD`, and the two are different bytes.
- The preview still reads a file through a symbolic link; the submission refuses one (B3,
  after stage 5; D17). A person sees the preview and the refusal disagree, which is the
  safe direction.
- An aborted submission leaves unreachable objects for `git gc`.

- [ ] **Step 6: Correct what this makes false, in this commit**

- `docs/design.md` §8: the row "Write interrupted | full rollback, initial state restored" →
  "Write interrupted | nothing to roll back: nothing a person can observe exists before
  the branch's ref is created; an unreachable object may remain, for `git gc`".
- `docs/design.md` §9.2: under the invariants, add

  > "Initial state" is the observable state — every ref, what `HEAD` is, the index, the
  > working tree — and not `.git/objects`. "Applying twice" is held at two levels: over
  > the bytes (`planEdits` on applied bytes changes nothing) and at the forge (the same
  > bytes on the same base name the same branch, which is recognised, not duplicated). Two
  > model drafts that differ are two plans.

- `docs/design.md` §4.3 (gap-stage5-readiness-12): "Two concurrent declarations never write
  to the same file" → "Two concurrent declarations of new entities never write to the same
  file. Two that amend one grant do — each `update-entity` appends to the grant's file — and
  their branches conflict at the merge, which is where that is seen; a submission's branch
  name is a digest of its bytes, the plan's identity."
- `src/scaffold/write.ts:7`, `src/scaffold/README.md:17` and the `scaffold/` rule's comment in
  `tests/architecture/dependencies.test.ts`: "Stage 5's atomic applier replaces this seam" →
  "It stays the writer for a repository being created; a branch in an existing one is
  `forge/local/`'s (ADR-0010)."
- `SECURITY.md`: *Writes nothing, except* (`:34`) gains "one new branch per `--submit`, cut
  through git in the repository named, and the objects it reaches"; the "check at the moment
  of writing" item moves from *Designed, not yet built* (`:218`) to *Guaranteed today*, with
  its tests; the forge's rows (task 8 lists them) are added as their tests land here.
- `AGENTS.md` and `SECURITY.md`: "one module writes" / "the only writer we own" → the named
  writers (`scaffold/write.ts`, `cli/recording-fs.ts`, `cli/trace-sink.ts`), and the forge,
  through git.

- [ ] **Step 7: Traceability**

- `CHANGELOG.md`, Unreleased → Added: one line with the link.
- `docs/roadmap.md`: stage 5's queue item says task 4 is on `main`; gap-stage5-readiness-8's
  identity half is closed with the role check.
- The review's Status: gap-stage5-readiness-3, -4 (at submission; the preview is B3's), -6,
  -8 and -12 closed, each naming its test.

- [ ] **Step 8: Commit** *(after the owner's go-ahead)*

```bash
git add src/forge src/scaffold tests docs/design.md SECURITY.md AGENTS.md CHANGELOG.md docs/roadmap.md docs/reviews/2026-09-23-deep-review.md
git commit -m "feat(forge): cut a branch that can only be created, recognise it twice, leave nothing half-made"
```

---

# Merge 5c — the CLI

### Task 5: `plan --from … --submit`

*Amended on 2026-09-29 (check §3 P5; D4, D5, D11, D19).* `plan.ts` is 1509 lines on
`d0fdee9`: `CLOSING` at `:71`, `renderPreview` at `:608` with an `apply` option and #83's
exit-3 path, `runPlan` at `:1037` as `declarationsRoot`, `readRepository`, `loadPlan`,
`readContents`, then `contextsOf(root, snapshot, contents, graphOf(snapshot))`, and
`renderRefusedAnswer` already exported (`:849`). The wiring below is re-derived there. What
moved besides:

- **The root comes from `declarationsFor`'s chain** (D19): `main` already resolves `plan`'s
  repository through `sourceOf({ command: 'plan' })` — `--repo`, the working directory on its
  markers, `IDP_REPO`, the personal file's `repo`, never a catalogue
  (`src/cli/source.ts:225-290`; #93) — and says every road but `--repo` on stderr
  (`index.ts:1173`). `--submit` takes that root, and requires the *resolved* root to be a
  worktree root; the eee67d6 plan required `--repo` itself (plan:103-104 then). `--submit` with
  `--demo`, or with nothing resolved, is exit 2. The confirmation shows the root.
- **`--from` has no Reviewer** (gap-stage5-readiness-10): `--submit` is allowed on it, worded
  by route (D4) — `--from` crosses four gates and still cannot reach the default branch; the
  merge authorises (ADR-0006).
- **#83's exit 3** for an unaccounted empty diff comes before any forge call.
- **`Confirm` takes a structured summary**, not a rendered string (D5), so stage 7's TUI can
  reuse the seam; the rendered diff travels in it for the terminal, beside the fields a TUI
  needs without parsing it.
- **`--json` gains a `submission` key** (D11), its shape pinned by a test and listed in
  cli-ux-10's item; versioning the report stays that item's.
- **HELP**: `--submit` goes into the `plan` lines so `usageOf` prints it
  (`index.ts:542-556`), and "none of them writes" (`index.ts:227`) changes.
- Without `--submit`, the preview stays byte-identical, `CLOSING` included.

**Files:**
- Create: `src/cli/render/footer.ts`, `src/cli/commands/submit.ts`
- Modify: `src/cli/commands/plan.ts`, `src/cli/index.ts`
- Modify: `tests/unit/plan-command.test.ts` (a `describe('plan --from --submit')`), `tests/unit/cli-args.test.ts`
- Modify: `scripts/smoke.mjs`
- Modify: `AGENTS.md` (the exit-code paragraph; "init platform is still the only command that writes"), `SECURITY.md` (the `--from` road, by route), `README.md` (the command list)
- Modify: `CHANGELOG.md`, `docs/roadmap.md` (cli-ux-10's item names the key), the review's Status

**Interfaces:**
- Consumes: `clearPlan`, `ClearInput`, `Cleared`, `ClearRefusal`, `Expectation`,
  `Repository` (task 1); `ForgeProvider`, `Base`, `ForgeInputError`, `openLocalForge`
  (tasks 3–4).
- Produces:
  - `const CLOSING` (moved from `plan.ts`) · `type PreviewStatus` · `function closingLines(status: PreviewStatus, changed: number): string[]`
  - `interface SubmissionSummary { readonly root: string; readonly repository: Repository; readonly branch: string; readonly base: Base; readonly files: readonly { readonly path: string; readonly change: 'create' | 'amend' }[]; readonly preview: string }`
  - `type Confirm = (summary: SubmissionSummary) => Promise<boolean>`
  - `interface SubmitOptions { readonly confirm?: Confirm; readonly open?: (root: string, repository: Repository) => Promise<ForgeProvider> }`
  - `interface Opened { readonly root: string; readonly forge: ForgeProvider; readonly base: Base }`
  - `function openForSubmission(root: string, repository: Repository, options: SubmitOptions): Promise<Opened>`
  - `function refuseDivergence(opened: Opened, expected: Expectation): Promise<CommandResult | undefined>`
  - `type SubmissionReport` · `function submit(input: { opened; cleared; render; confirm? }): Promise<{ result: CommandResult; report: SubmissionReport }>`
  - `PlanOptions.submit?: SubmitOptions` · `MainDeps.confirm?: Confirm`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/plan-command.test.ts`, reusing its `scaffoldedRepository`, `planFile`,
`declare`, `answering`, `CREATE_PLAN`, `CLOSING`, `DATABASE_PATH` and `ACCESS_PATH`, with
these imports added at the top:

```typescript
import { renderUnifiedDiff } from '../../src/core/diff/unified.js'
import type { Confirm, SubmissionSummary } from '../../src/cli/commands/submit.js'
import { committed, git, observable, show } from '../support/git.js'
```

and a runner that can pass `confirm`:

```typescript
const runWith = async (args: string[], deps: { ask?: Ask; confirm?: Confirm } = {}) => {
  const io = capture()
  const code = await main(args, {
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
    ...deps,
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

/** The declarations repository as a clone: scaffolded, committed on main. */
const clonedRepository = async (): Promise<string> => {
  const repo = await scaffoldedRepository()
  await committed(repo)
  return repo
}

const branches = async (repo: string): Promise<string[]> =>
  (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/idp-agent/'))
    .split('\n')
    .filter((line) => line !== '')

describe('plan --from --submit', () => {
  it('cuts one branch holding exactly the diff it printed, and leaves main alone', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const main0 = await git(repo, 'rev-parse', 'main')
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(out).toMatch(/2 files · submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched/)
    expect(out).toContain('No merge request is opened: this build has no forge (stage 6).')
    expect(out.trimEnd().endsWith(CLOSING)).toBe(true)
    expect(await git(repo, 'rev-parse', 'main')).toBe(main0)
    const [branch] = await branches(repo)
    expect(branch).toBeDefined()
    // The branch's diff, rendered by the same renderer, is IN what was printed:
    // what the person read is what was submitted.
    const fromGit = await Promise.all(
      [DATABASE_PATH, ACCESS_PATH].map(async (file) => ({
        path: file,
        before: undefined,
        after: await show(repo, branch ?? '', file),
      })),
    )
    expect(out).toContain(renderUnifiedDiff(fromGit).trimEnd())
    // And the only change a person can see is that one branch.
    const added = (await observable(repo)).split('\n').filter((line) => !before.split('\n').includes(line))
    expect(added).toHaveLength(1)
  })

  it('still writes nothing — .git included — without --submit', async () => {
    // Stage 4's guarantee, over a clone this time: the hash covers .git/.
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const before = await hashTree(repo)
    const { code } = await runWith(['plan', '--from', from, '--repo', repo], { ask: answering('read') })
    expect(code).toBe(0)
    expect(await hashTree(repo)).toBe(before)
  })

  it('submitting twice names the branch it already cut, and writes nothing', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const args = ['plan', '--from', from, '--repo', repo, '--submit']
    await runWith(args, { ask: answering('read') })
    const between = await observable(repo)

    const { code, out } = await runWith(args, { ask: answering('read') })

    expect(code).toBe(0)
    expect(out).toMatch(/already submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} · nothing written/)
    expect(await observable(repo)).toBe(between)
  })

  it('shows the diff before asking, and prints it once', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const shown: SubmissionSummary[] = []
    const confirm: Confirm = async (summary) => {
      shown.push(summary)
      return true
    }

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
      confirm,
    })

    expect(code).toBe(0)
    // Structured (D5): what a TUI needs, without parsing the text.
    expect(shown[0]?.files).toEqual([
      { path: DATABASE_PATH, change: 'create' },
      { path: ACCESS_PATH, change: 'create' },
    ])
    expect(shown[0]?.branch).toMatch(/^idp-agent\/orders-db-prod-[0-9a-f]{8}$/)
    expect(shown[0]?.repository).toBe('declarations')
    expect(shown[0]?.preview).toContain(`+++ b/${DATABASE_PATH}`)
    expect(shown[0]?.preview).toContain('not yet submitted')
    // The prompt printed the diff; the result must not print it a second time.
    expect(out).not.toContain('+++ b/')
    expect(out).toContain('submitted as idp-agent/')
  })

  it('declined at the prompt: exit 0, not submitted, nothing written', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
      confirm: async () => false,
    })

    expect(code).toBe(0)
    expect(out).toContain('not submitted · nothing written')
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a --repo that is not a clone, with the argument-error code', async () => {
    const repo = await scaffoldedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const { code, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'])
    expect(code).toBe(2)
    expect(err).toContain('not a git working tree')
  })

  it('refuses a repository whose working tree is not HEAD, before previewing', async () => {
    const repo = await clonedRepository()
    await declare(repo, 'catalog/databases/stray.yml', '# stray\n')
    const from = await planFile(repo, CREATE_PLAN)
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(out).toContain('stray.yml')
    expect(out).not.toContain('+++ b/')
    expect(await observable(repo)).toBe(before)
  })

  it('submits nothing while a question is open and nobody can answer it', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const { code } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'])
    expect(code).toBe(3)
    expect(await branches(repo)).toEqual([])
  })

  it('reports the submission in --json, and never prompts there', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit', '--json'], {
      ask: answering('read'),
      confirm: async () => {
        throw new Error('a --json run asked a person')
      },
    })
    expect(code).toBe(0)
    const report = JSON.parse(out) as { submission: Record<string, unknown> }
    // The key's shape is pinned (D11): cli-ux-10 versions the report later,
    // and a consumer written today must not be broken silently before then.
    expect(Object.keys(report.submission).sort()).toEqual(['base', 'branch', 'commit', 'outcome'])
    expect(report.submission['outcome']).toBe('created')
    expect(report.submission['branch']).toMatch(/^idp-agent\//)
  })
})
```

Then, in the same `describe`, the cases `main` added since `eee67d6` (written red first):

- **The root by any road of the chain (D19).** Run from inside the clone with no `--repo`
  (`deps.cwd` the clone, whose markers `init platform` wrote), and with `IDP_REPO` set: the
  branch is cut, stderr names the folder and what named it, and the confirmation's
  `summary.root` is the clone.
- **Refused before anything is read**: `--submit --demo` is exit 2; `--submit` with no
  repository resolved is exit 2, naming the four ways, as `plan` without `--submit` is today.
- **#83 before the forge.** A plan file whose update names a consumer the grant already lists
  at another level: exit 3, the sentence "this plan changes nothing, and the repository does
  not already say it", no branch, `observable` unchanged.
- **A plan writing into both repositories (D6).** A `create-catalog-info` beside the grant:
  exit 1, the reason names `init --submit`, no branch.
- **A preview byte for byte.** Without `--submit`, over the same clone, `out` equals what
  `d0fdee9` prints — the existing tests asserting `CLOSING` stay unchanged and pass.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/unit/plan-command.test.ts`
Expected: FAIL — `--submit` is an unknown option (exit 2), and `Confirm` does not exist.

- [ ] **Step 3: The footer, one module both roads print from**

`src/cli/render/footer.ts`:

```typescript
import type { Base } from '../../forge/provider.js'

/** The one line every run that produced a diff ends on (design §7.4). */
export const CLOSING = 'Nothing is provisioned yet. The merge is what authorises it.'

/** Said wherever a local branch was cut, so nobody looks for a merge request that does not exist. */
const NO_FORGE = 'No merge request is opened: this build has no forge (stage 6).'

/**
 * What became of a diff. `preview` is stage 4's sentence, unchanged; the rest
 * exist only with `--submit`, and none of them says "applied" — a submission
 * is a request (§4.2).
 */
export type PreviewStatus =
  | { readonly kind: 'preview' }
  | { readonly kind: 'pending'; readonly branch: string }
  | { readonly kind: 'declined' }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] }
  | { readonly kind: 'submitted'; readonly again: boolean; readonly branch: string; readonly base: Base }
  /** `init`'s preview ends on `APPLY` instead of `CLOSING` (init.ts:985): the tail it says in place of it. */
  | { readonly kind: 'applied-by-hand'; readonly apply: string }

const short = (commit: string): string => commit.slice(0, 7)

export function closingLines(status: PreviewStatus, changed: number): string[] {
  const files = `${String(changed)} ${changed === 1 ? 'file' : 'files'}`
  switch (status.kind) {
    case 'preview':
      return [`${files} · nothing written`, CLOSING]
    case 'applied-by-hand':
      return [`${files} · nothing written`, status.apply]
    case 'pending':
      return [`${files} · not yet submitted — it would become ${status.branch}`, CLOSING]
    case 'declined':
      return [`${files} · not submitted · nothing written`, CLOSING]
    case 'refused':
      return [
        `${files} · not submitted:`,
        ...status.reasons.map((reason) => `  ${reason}`),
        'Nothing was written.',
        CLOSING,
      ]
    case 'submitted':
      return [
        status.again
          ? `${files} · already submitted as ${status.branch} · nothing written`
          : `${files} · submitted as ${status.branch} on top of ` +
            `${status.base.branch}@${short(status.base.commit)} · ${status.base.branch} untouched`,
        NO_FORGE,
        CLOSING,
      ]
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}
```

`src/cli/render/footer.ts` imports a *type* from `forge/`, which the rule
"only cli/ reaches forge/ at runtime" allows. The same holds from `cli/`, which may import
it at runtime anyway.

In `src/cli/commands/plan.ts`:
- delete the local `CLOSING` (`:71`) and import `CLOSING`, `closingLines` and
  `PreviewStatus` from `../render/footer.js`;
- `renderPreview`'s input gains `readonly status?: PreviewStatus`;
- in the non-empty branch, the two lines
  `` `${plural(changed.length, 'file', 'files')} · nothing written`, preview.apply ?? CLOSING ``
  become `...closingLines(preview.status ?? (preview.apply === undefined ? { kind: 'preview' } : { kind: 'applied-by-hand', apply: preview.apply }), changed.length)`;
- the empty-diff branch — #83's exit 3 included — is left unchanged.

Stage 4's output is byte-identical, and its tests prove it.

- [ ] **Step 4: The submission step**

`src/cli/commands/submit.ts`:

```typescript
import type { Cleared, ClearRefusal, Expectation, Repository } from '../../core/plan/clear.js'
import { openLocalForge } from '../../forge/local/forge.js'
import type { Base, ForgeProvider } from '../../forge/provider.js'
import { closingLines, type PreviewStatus } from '../render/footer.js'
import { inertLine } from '../render/plain.js'
import type { CommandResult } from './result.js'

/**
 * What a person is asked to submit, as data (D5): a terminal prints `preview`
 * and asks; stage 7's TUI can lay out the files and the branch itself without
 * parsing the text. Nothing in it authorises anything — it is a request.
 */
export interface SubmissionSummary {
  /** The repository the branch is cut in, as `declarationsFor` resolved it (D19). */
  readonly root: string
  readonly repository: Repository
  readonly branch: string
  readonly base: Base
  readonly files: readonly { readonly path: string; readonly change: 'create' | 'amend' }[]
  /** The preview as printed, `not yet submitted` tail included. */
  readonly preview: string
}

/**
 * The person at the keyboard: shown the diff, asked one question. A function
 * for the reason `Ask` is one — the interactive path is then driven from a
 * test with no terminal. `cli/index.ts` owns the only implementation that
 * touches a keyboard.
 */
export type Confirm = (summary: SubmissionSummary) => Promise<boolean>

export interface SubmitOptions {
  /**
   * Absent: `--submit` was the whole confirmation — a script, a pipe, `--json`.
   * That is safe because the confirmation was never the guard: the merge is,
   * and nobody can perform it from this terminal (§4.2).
   */
  readonly confirm?: Confirm
  /** Injected so a test can hand in a runner that fails at step k. */
  readonly open?: (root: string, repository: Repository) => Promise<ForgeProvider>
}

export interface Opened {
  readonly root: string
  readonly forge: ForgeProvider
  readonly base: Base
}

/**
 * Before anything is read and before any model is paid: a repository that
 * cannot take a branch — not a clone's root, no git, no committer identity —
 * is refused now, as an argument (exit 2), by `ForgeInputError`.
 */
export async function openForSubmission(
  root: string,
  repository: Repository,
  options: SubmitOptions,
): Promise<Opened> {
  const forge = await (options.open ?? openLocalForge)(root, repository)
  return { root, forge, base: await forge.base() }
}

const short = (commit: string): string => commit.slice(0, 7)

/**
 * The gates are about to judge the working tree, and the branch will be cut
 * from HEAD. If those differ, stop BEFORE the preview — and on the intent road
 * before a model is paid for — rather than show a diff that cannot be submitted.
 */
export async function refuseDivergence(
  opened: Opened,
  expected: Expectation,
): Promise<CommandResult | undefined> {
  const divergent = await opened.forge.diverges(opened.base, expected)
  if (divergent.length === 0) return undefined
  return {
    text: [
      `not submitted — the repository is not what ${opened.base.branch}@${short(opened.base.commit)} holds:`,
      // A path is a repository's own, and may hold what a terminal obeys.
      ...divergent.map((line) => `  ${inertLine(line, Number.POSITIVE_INFINITY)}`),
      '',
      'Commit or set those changes aside, and run this again. Nothing was previewed, and nothing was written.',
    ].join('\n'),
    found: false,
  }
}

export type SubmissionReport =
  | {
      readonly outcome: 'created' | 'already-submitted'
      readonly branch: string
      readonly commit: string
      readonly base: Base
    }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'declined'; readonly branch: string }
  | { readonly outcome: 'refused'; readonly reasons: readonly string[] }

/**
 * Clear, confirm, submit — in that order, and each one can end the run.
 *
 * `render` is the preview renderer with everything bound but its status, so
 * the diff a person confirms is the diff the preview printed; a second
 * renderer here would be a second answer to "what would this do?".
 */
export async function submit(input: {
  readonly opened: Opened
  readonly cleared: Cleared | ClearRefusal
  readonly render: (status: PreviewStatus) => CommandResult
  readonly confirm?: Confirm
}): Promise<{ readonly result: CommandResult; readonly report: SubmissionReport }> {
  const { opened, cleared, render, confirm } = input
  const changed = 'outcome' in cleared ? 0 : cleared.edits.length
  // With a prompt, the diff was already printed by it; the result is the
  // closing lines only, or the person reads the diff twice.
  const said = (status: PreviewStatus): string =>
    confirm === undefined ? render(status).text : closingLines(status, changed).join('\n')

  if ('outcome' in cleared) {
    const status: PreviewStatus = { kind: 'refused', reasons: cleared.reasons }
    return {
      report: { outcome: 'refused', reasons: cleared.reasons },
      result: { text: render(status).text, found: false },
    }
  }

  if (confirm !== undefined) {
    const yes = await confirm({
      root: opened.root,
      repository: cleared.repository,
      branch: cleared.branch,
      base: opened.base,
      files: cleared.edits.map((edit) => ({
        path: edit.path,
        change: edit.before === undefined ? 'create' : 'amend',
      })),
      preview: render({ kind: 'pending', branch: cleared.branch }).text,
    })
    if (!yes) {
      return {
        report: { outcome: 'declined', branch: cleared.branch },
        result: { text: said({ kind: 'declined' }), found: true },
      }
    }
  }

  const submitted = await opened.forge.submit(cleared, opened.base)
  switch (submitted.outcome) {
    case 'created':
    case 'already-submitted': {
      const status: PreviewStatus = {
        kind: 'submitted',
        again: submitted.outcome === 'already-submitted',
        branch: submitted.branch,
        base: opened.base,
      }
      return {
        report: { ...submitted, base: opened.base },
        result: { text: said(status), found: true },
      }
    }
    case 'unchanged':
      return { report: submitted, result: { text: said({ kind: 'preview' }), found: true } }
    case 'refused': {
      // The forge's words quote refs and paths of the repository: cleaned.
      const status: PreviewStatus = { kind: 'refused', reasons: [inertLine(submitted.reason, Number.POSITIVE_INFINITY)] }
      return {
        report: { outcome: 'refused', reasons: [submitted.reason] },
        result: { text: said(status), found: false },
      }
    }
    default: {
      const _exhaustive: never = submitted
      return _exhaustive
    }
  }
}
```

- [ ] **Step 5: Wire `runPlan`**

In `src/cli/commands/plan.ts`:

- `PlanOptions` gains `readonly submit?: SubmitOptions`.
- `runPlan` (`:1037`) opens the forge first, then refuses a divergent repository before any
  question is asked:

```typescript
export async function runPlan(options: PlanOptions): Promise<CommandResult> {
  const root = await declarationsRoot('plan', options.repo)
  // Before anything is read: a repository that cannot take a branch is an argument error.
  const opened =
    options.submit === undefined
      ? undefined
      : await openForSubmission(root, 'declarations', options.submit)
  const snapshot = await readRepository(root)
  const loaded = await loadPlan(options.from)

  const contents = await readContents(root, snapshot)
  const contexts = contextsOf(root, snapshot, contents, graphOf(snapshot))
  if (opened !== undefined) {
    const refused = await refuseDivergence(opened, { files: contents, scope: 'catalogue' })
    if (refused !== undefined) return refused
  }
```

The ask loop below it stays as it is (`:1045-1127`). Its two `return previewPlan(...)` calls become
`return await previewPlan(...)`, and each passes the submission through by replacing the
`options` argument with:

```typescript
      {
        ...options,
        ...(opened !== undefined ? { opened } : {}),
        ...(options.submit?.confirm !== undefined ? { confirm: options.submit.confirm } : {}),
      }
```

- `previewPlan` (`:1140`) becomes `async`, and its `options` gains
  `readonly opened?: Opened; readonly confirm?: Confirm`. Both call sites `await` it. It
  already takes `provenance`; `clearPlan` does not — the signed plan carries its own (D1).
- Its JSON branch, when `opened` is set and nothing refused, submits without a prompt:

```typescript
  if (options.json === true) {
    const report = reportOf(signed, questions, policies, recheck, changed, dropped)
    // Nothing that changes a byte is never submitted, and never refused for
    // it: the same answer, and the same code, as the run without --submit —
    // #83's exit 3 included, which asks no forge anything.
    const accounted = !didNothing(signed, changed, recheck)
    if (options.opened !== undefined && !refused && questions.length === 0 && changed.length === 0 && accounted) {
      return { text: asJson({ ...report, submission: { outcome: 'unchanged' } }), found: true }
    }
    if (options.opened !== undefined && !refused && questions.length === 0 && changed.length > 0) {
      const { report: submission } = await submit({
        opened: options.opened,
        cleared: clearPlan(signed, { policy: contexts.policy, snapshot, contents }),
        render: (status) => renderPreview({ signed, edits, dropped, recheck, status }),
      })
      return {
        text: asJson({ ...report, submission }),
        found: submission.outcome !== 'refused',
      }
    }
    return {
      text: asJson(report),
      found: !refused,
      ...(questions.length > 0 || (!refused && didNothing(signed, changed, recheck))
        ? { unsupported: true }
        : {}),
    }
  }
```

- Its final `return renderPreview(...)` becomes:

```typescript
  const render = (status: PreviewStatus): CommandResult =>
    renderPreview({
      signed,
      edits,
      dropped,
      recheck,
      repo: options.repo,
      status,
      ...(options.colour !== undefined ? { colour: options.colour } : {}),
    })
  // Nothing to submit is the same answer with or without --submit: no branch,
  // and #83's exit 3 from the empty-diff branch when nothing accounts for it.
  if (options.opened === undefined || changed.length === 0) return render({ kind: 'preview' })
  const { result } = await submit({
    opened: options.opened,
    cleared: clearPlan(signed, { policy: contexts.policy, snapshot, contents }),
    render,
    ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
  })
  return result
```


- [ ] **Step 6: Wire the CLI**

In `src/cli/index.ts`:

- `Command`'s `plan` member gains `submit: boolean`. `parseArguments` adds
  `submit: { type: 'boolean' }` to `plan`'s options and returns
  `submit: values.submit === true`. `--submit` with `--demo` is refused there, exit 2: a
  write is never decided against a demo. With nothing resolved, the existing
  `planNeedsRepository` refusal (`index.ts:1169-1171`) already comes first.
- `idpa "<phrase>" --submit` is refused there too, exit 2, pointing at
  `plan "<intent>" --submit` (D8): the entry routes a change after a Supervisor call
  (`package.json:29-31`; design §7.4), and a submission from it would have to refuse
  divergence before the Supervisor. It is a follow-up, stated in the roadmap.
- `MainDeps` gains:

```typescript
  /**
   * How a submission is confirmed (§7.4 step 7). Injected for the reason `ask`
   * is; left out, `confirmOf` decides from the process whether anyone is there.
   */
  confirm?: Confirm
```

- The terminal implementation and its chooser sit beside `promptOnTerminal`:

```typescript
/**
 * The diff on stdout, where the preview always goes; the question on stderr,
 * where every prompt goes (§6.2). Only `y` or `yes` submits: an empty line,
 * Ctrl-D or anything else declines, which is the reading that writes nothing.
 * The wording says what is being done — submitting for review — and what is
 * not: nothing is provisioned until someone else merges it (§4.2).
 */
const confirmOnTerminal = (): Confirm => async (summary) => {
  process.stdout.write(`${summary.preview}\n`)
  const reader = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const closed = new Promise<undefined>((resolve) => {
      reader.once('close', () => resolve(undefined))
    })
    const said = await Promise.race([
      reader.question(
        `Submit this for review as ${summary.branch} in ${summary.root}? ` +
          'Nothing is provisioned until someone else merges it. [y/N] ',
      ),
      closed,
    ])
    return said !== undefined && /^(y|yes)$/i.test(said.trim())
  } finally {
    reader.close()
  }
}

/** A person at a terminal gets the prompt; a script, a pipe or `--json` has `--submit` as its answer. */
const confirmOf = (deps: MainDeps, json: boolean): Confirm | undefined => {
  // First, and before an injected one: a `--json` run is read by a program,
  // and a program is never asked — the test "never prompts there" injects a
  // confirm that throws to prove it.
  if (json) return undefined
  if (deps.confirm !== undefined) return deps.confirm
  if (deps.out !== undefined || deps.err !== undefined) return undefined
  return process.stdin.isTTY === true ? confirmOnTerminal() : undefined
}
```

- In the `plan` branch of `main`, build
  `const submit = command.submit ? { ...(confirm !== undefined ? { confirm } : {}) } : undefined`,
  with `confirm = confirmOf(deps, command.json)`. Pass `...(submit !== undefined ? { submit } : {})`
  to `runPlan`.
- **Not yet to `runIntent`.** `IntentOptions` has no `submit` until task 6, and a
  conditionally spread property escapes the excess-property check, so passing it would
  typecheck and drop the flag in silence: `plan "<intent>" --submit` would print "nothing
  written" and exit 0. Until then, `parseArguments` refuses the combination out loud:

```typescript
      if (values.submit === true && from === undefined) {
        // Removed by the next change, which teaches the intent road to submit.
        return {
          name: 'error',
          message: 'plan "<intent>" --submit is not wired yet; use --from <plan.json> --submit',
        }
      }
```

  With a test in `tests/unit/cli-args.test.ts` asserting that error. Task 6 deletes both.
- `failed()` adds `error instanceof ForgeInputError` to the exit-2 list; a `GitError`
  reaching it is exit 1, its stderr printed through `inertLine`.
- `HELP`: add `[--submit]` to both `plan` lines, so `usageOf` prints it
  (`index.ts:542-556`), and replace "… and none of them writes." (`index.ts:227`) with:

```
  A phrase, ask, plan "<intent>" and init need IDP_PROVIDER and IDP_MODEL. None
  of them writes without --submit. With it, plan cuts a branch idp-agent/… from
  HEAD in the declarations repository, which must be a git clone's root, for
  review, and nothing else moves; plan --from crosses four gates, no Reviewer,
  and the merge authorises either way.
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/unit/plan-command.test.ts tests/unit/main.test.ts tests/unit/cli-args.test.ts`
Expected: PASS.

- [ ] **Step 8: The built binary**

In `scripts/smoke.mjs`, give `hashTree` a second parameter so it can skip the root `.git`
(`hashTree(dir, { skipGit: true })`). Then add, after the stage-4 `plan --from` assertions:

```javascript
// Stage 5: --submit, against a CLONE of a scaffolded repository. The binary is
// the one that must cut the branch; git here only builds the fixture.
const SUBMITTED = path.join(ELSEWHERE, 'submitted')
execFileSync(process.execPath, [BIN, 'init', 'platform', 'submitted', '--owner', '@acme/platform'], {
  cwd: ELSEWHERE,
  env: CLEAN_ENV,
  stdio: 'ignore',
})
const fixtureGit = (...args) =>
  execFileSync('git', ['-C', SUBMITTED, ...args], {
    env: { ...CLEAN_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim()
fixtureGit('init', '-q', '-b', 'main')
fixtureGit('config', 'user.name', 'smoke')
fixtureGit('config', 'user.email', 'smoke@idp-agent.invalid')
fixtureGit('add', '-A')
fixtureGit('commit', '-q', '-m', 'base')
const mainBefore = fixtureGit('rev-parse', 'main')
const worktreeBefore = hashTree(SUBMITTED, { skipGit: true })

check({
  args: ['plan', '--from', path.join(ROOT, 'examples/declare-database.json'), '--repo', 'submitted', '--submit'],
  code: 0,
  stdout: /submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} on top of main@[0-9a-f]{7}/,
})
assert('--submit left main where it was', fixtureGit('rev-parse', 'main') === mainBefore, '--submit moved main')
assert(
  '--submit left the working tree byte for byte',
  hashTree(SUBMITTED, { skipGit: true }) === worktreeBefore,
  '--submit wrote into the working tree',
)
assert(
  '--submit cut exactly one branch',
  fixtureGit('for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/').split('\n').filter(Boolean).length === 1,
  '--submit cut no branch, or more than one',
)
check({ args: ['plan', '--from', EXAMPLE, '--repo', 'repo', '--submit'], code: 2, stderr: /not a git working tree/ })
```

Run: `pnpm build && pnpm smoke`
Expected: every check passes. The total is printed from `checks`, and `AGENTS.md` must say
the new number.

- [ ] **Step 9: Correct what this task makes false, in this commit**

In `AGENTS.md`:
- the exit-code paragraph: `0` includes "a branch submitted, or already submitted", `1`
  "a submission refused at the moment of writing", and `2` "a declarations repository that
  is not a git clone's root, no committer identity, `--submit` with `--demo`";
- "**`init platform` is still the only command that writes**" (`:171`) becomes: "`init
  platform` writes into the directory it was handed. `plan … --submit` writes one new ref
  and the objects it reaches, and nothing else."
- the commands block: `[--submit]` on both `plan` lines.

In `SECURITY.md`, the `--from` road worded by route (D4): `plan --from … --submit` crosses
the schema, the signature, the policies and the re-check — no Reviewer — and still cannot
reach the default branch; the merge authorises (ADR-0006). In `README.md`, the `--submit`
line in the command list and one sentence on what a local submission does and does not do.

- [ ] **Step 10: Traceability**

- `CHANGELOG.md`, Unreleased → Added: one line with the link.
- `docs/roadmap.md`: stage 5's queue item says task 5 is on `main`; cli-ux-10's item (under
  *Waits for the owner*, "For the stage-5 check") names the `submission` key it will version;
  "`idpa "<phrase>" --submit`" is recorded as a follow-up (D8).
- The review's Status: gap-stage5-readiness-10 (worded by route, D4) and -13 (the structured
  Confirm seam, D5) closed; cli-ux-12 and architecture-9 in part.

- [ ] **Step 11: Run everything and commit** *(after the owner's go-ahead)*

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm smoke   # the full run only with 2 GiB free on /
git add src/cli tests scripts/smoke.mjs AGENTS.md SECURITY.md README.md CHANGELOG.md docs/roadmap.md docs/reviews/2026-09-23-deep-review.md
git commit -m "feat(cli): submit a previewed plan as a local branch, and say it is a request"
```

---

### Task 6: `plan "<intent>" --submit` — refused before a model is paid

*Amended on 2026-09-29 (check §3 P6; D8).* Smaller than planned: `runIntent`
(`plan.ts:1267-1310`) already reads the contents before `inspect()` — `:1297`, "Before the
Inspector too" — so the move of step 3 is done on `main`. What is left is to open the forge
and refuse a divergence right after `readContents`, before any model. The tests' `answering`
clients are rebuilt on path-keyed answers (the provenance indexes an answer by the field it
answered), and one case has the environment answered, not named. Scripted clients only: no
tape changes, and `IDP_RECORDING=record` is never used. `idpa "<phrase>" --submit` stays
refused at stage 5 (D8, task 5).

**Files:**
- Modify: `src/cli/commands/plan.ts` (`runIntent`, `renderOutcome`)
- Modify: `src/cli/index.ts` (delete task 5's interim refusal; pass `submit` to `runIntent`)
- Modify: `tests/unit/plan-intent.test.ts` (a `describe('plan "<intent>" --submit')`)
- Modify: `tests/unit/cli-args.test.ts` (delete task 5's interim-refusal test)
- Modify: `CHANGELOG.md`, `docs/roadmap.md`

**Interfaces:**
- Consumes: `openForSubmission`, `refuseDivergence`, `submit`, `SubmitOptions`, `Opened`,
  `Confirm` (task 5); `PreviewStatus` (task 5, `cli/render/footer.ts`); `clearPlan`,
  `ClearInput` (task 1).
- Produces: `IntentOptions.submit?: SubmitOptions`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/plan-intent.test.ts`, reusing `scaffoldedRepository`, `application`,
`converging`, `answering`, `collect`, `INTENT`, `CREATE_DATABASE` and `CREATE_ACCESS`, and
importing `committed`, `git`, `observable` from `../support/git.js`:

```typescript
describe('plan "<intent>" --submit', () => {
  const cloned = async (): Promise<string> => {
    const repo = await scaffoldedRepository()
    await committed(repo)
    return repo
  }

  it('cuts the branch the same plan cuts by --from', async () => {
    const repo = await cloned()
    const project = await application()

    const result = await runIntent({
      intent: INTENT,
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit: collect().emit,
      ask: answering('read'),
      submit: {},
    })

    expect(result.found).toBe(true)
    expect(result.text).toMatch(/submitted as idp-agent\/orders-db-prod-[0-9a-f]{8}/)
    expect(
      (await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/')).split('\n'),
    ).toHaveLength(1)
  })

  it('refuses a divergent repository before a single model call', async () => {
    // Three paid round-trips for a diff that cannot be submitted is the cost
    // this ordering removes: the check runs before the Inspector.
    const repo = await cloned()
    await writeFile(path.join(repo, 'catalog', 'databases', 'stray.yml'), '# stray\n', 'utf8')
    const project = await application()
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])
    const before = await observable(repo)

    const result = await runIntent({
      intent: INTENT,
      repo,
      project,
      client,
      emit: collect().emit,
      ask: answering('read'),
      submit: {},
    })

    expect(result.found).toBe(false)
    expect(result.text).toContain('stray.yml')
    expect(client.seen).toEqual([])
    expect(await observable(repo)).toBe(before)
  })

  it('submits a plan whose environment was answered at the prompt, not named', async () => {
    // An environment is never read from the request's words (2026-09-27): the
    // provenance holds the answer at its path, and the clearance re-runs the
    // policies against the provenance the plan was signed with (D1).
    const repo = await cloned()
    const project = await application()

    const result = await runIntent({
      intent: 'give billing-api read access to orders-db',
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit: collect().emit,
      // The level answered, and each environment confirmed at its path as the
      // draft proposed it (`confirmingEnvironment`): nothing named in the words.
      ask: answering('read'),
      submit: {},
    })

    expect(result.found).toBe(true)
    expect(result.text).toMatch(/submitted as idp-agent\//)
  })

  it('leaves the application repository byte-identical while submitting', async () => {
    const repo = await cloned()
    const project = await application()
    const before = await hashTree(project)

    await runIntent({
      intent: INTENT,
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit: collect().emit,
      ask: answering('read'),
      submit: {},
    })

    expect(await hashTree(project)).toBe(before)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/unit/plan-intent.test.ts`
Expected: FAIL — `submit` is not an `IntentOptions` field; no branch is cut.

- [ ] **Step 3: Wire `runIntent`**

- In `src/cli/index.ts`, delete task 5's `plan "<intent>" --submit is not wired yet`
  refusal and its test, and pass `...(submit !== undefined ? { submit } : {})` to
  `runIntent` exactly as to `runPlan`.
- `IntentOptions` gains `readonly submit?: SubmitOptions`.
- In `runIntent`, open the forge right after `declarationsRoot` (`:1268`):
  `const opened = options.submit === undefined ? undefined : await openForSubmission(root, 'declarations', options.submit)`.
- `const contents = await readContents(root, snapshot)` already sits above
  `const facts = await inspect(…)` on `main` (`:1297`). Reading bytes is free; the
  Inspector is not. Right after it:

```typescript
  if (opened !== undefined) {
    // Before the Inspector: a repository whose working tree is not HEAD cannot
    // take this branch, and finding that out after three paid round-trips is
    // the waste this line exists to prevent.
    const refused = await refuseDivergence(opened, { files: contents, scope: 'catalogue' })
    if (refused !== undefined) return refused
  }
```

- `renderOutcome` becomes `async`. Its two call sites in `runIntent` become
  `return await renderOutcome(...)`, and its options gain the submission:

```typescript
/** What `--submit` needs once the loop has planned: the forge, the prompt, and what to clear against. */
interface Submission {
  readonly opened: Opened
  readonly confirm?: Confirm
  readonly clear: ClearInput
}
```

  `runIntent` builds it once, after `contexts` and `contents` exist, and passes it to both
  `renderOutcome` calls as `{ ...options, ...(submission !== undefined ? { submission } : {}) }`.
  `exactOptionalPropertyTypes` refuses `{ submission }` while it may be undefined:

```typescript
  const submission: Submission | undefined =
    opened === undefined
      ? undefined
      : {
          opened,
          clear: { policy: contexts.policy, snapshot, contents },
          ...(options.submit?.confirm !== undefined ? { confirm: options.submit.confirm } : {}),
        }
```

- `renderOutcome`'s `planned` branch becomes:

```typescript
  if (outcome.outcome === 'planned') {
    const changed = outcome.edits.filter((edit) => edit.before !== edit.after)
    const submission = options.submission
    const cleared =
      submission === undefined || changed.length === 0
        ? undefined
        : clearPlan(outcome.signed, submission.clear)
    const render = (status: PreviewStatus): CommandResult =>
      renderPreview({
        signed: outcome.signed,
        edits: outcome.edits,
        dropped: outcome.dropped,
        recheck: outcome.recheck,
        status,
        ...(options.colour !== undefined ? { colour: options.colour } : {}),
      })

    if (options.json === true) {
      const report = {
        outcome: 'planned',
        ...reportOf(outcome.signed, [], [], outcome.recheck, changed, outcome.dropped),
        truncated: outcome.truncated,
        rejections: outcome.rejections,
        attempts: outcome.attempts,
      }
      if (submission === undefined || cleared === undefined) return { text: asJson(report), found: true }
      // A program reads --json, and a program is never asked.
      const { report: submitted } = await submit({ opened: submission.opened, cleared, render })
      return { text: asJson({ ...report, submission: submitted }), found: submitted.outcome !== 'refused' }
    }

    if (submission === undefined || cleared === undefined) return render({ kind: 'preview' })
    const { result } = await submit({
      opened: submission.opened,
      cleared,
      render,
      ...(submission.confirm !== undefined ? { confirm: submission.confirm } : {}),
    })
    return result
  }
```

  Keep the existing comment about `truncated` above the JSON fields.

`answering` is `plan-intent.test.ts`'s scripted asker on `main` (`:163`): it answers a
level at its path and confirms an environment nobody pointed at (`confirmingEnvironment`),
the path-keyed answers the provenance now reads. The `eee67d6` tests passed `answering('read')`
for the level alone; each is re-read against today's helper.

- [ ] **Step 4: Traceability**

- `CHANGELOG.md`, Unreleased → Added: one line with the link.
- `docs/roadmap.md`: stage 5's queue item says task 6 is on `main`.

- [ ] **Step 5: Run everything and commit** *(after the owner's go-ahead)*

```bash
pnpm typecheck && pnpm test   # the full run only with 2 GiB free on /
git add src/cli tests/unit/plan-intent.test.ts tests/unit/cli-args.test.ts CHANGELOG.md docs/roadmap.md
git commit -m "feat(cli): submit a drafted plan, and refuse an unsubmittable repository before paying a model"
```

---

### Task 7: `init --submit`, and `.idp-agent.yml`

*Rewritten on 2026-09-29 (check §3 P7, §5; D9, D12).* What the `eee67d6` version got wrong on
today's `main`:

- **Where it files.** It read the root's `catalog-info.yaml` with a `readCatalogInfo` of its
  own (plan:3677-3694 then). `main` files at `targetOf`'s choice over the tracked
  declarations `readProject` reads whole — with `O_NOFOLLOW`, in
  `context/project-fs/snapshot.ts:750`, used at `init.ts:708-730`. `readCatalogInfo` goes;
  the divergence expectation, in `'touched'` scope, names `targetOf`'s file (its bytes, or
  absent), every kept declaration the "already declared" and name decisions read, and
  `.idp-agent.yml` — never `CATALOG_INFO` by name (check §5.2).
- **The order.** The declarations are read inside `readProject`, so the order is: open the
  forge (an argument error is exit 2 before anything is read), the configuration's questions,
  `readProject`, `init`'s own verdicts on what it read, `refuseDivergence`, then the
  Inspector — still before any model.
- **The flags.** `--backstage` is a global boolean that "takes no value, since a URL typed
  on a command line would send the token to whatever was typed" (`src/cli/index.ts:805`,
  `:832`; design §7.0), ADR-0011 refuses a URL from the command line, and `.idp-agent.yml`'s
  `backstage:` "is never requested" (`SECURITY.md:161`). So `init --backstage <url>` cannot
  stand, and no `backstage:` is written at stage 5 (D9). `--env` is `graph`'s filter
  (`index.ts:460`): the environment flag is `--environment`, repeatable.
- **The tail.** The preview now ends on `APPLY` — "`idpa init > catalog-info.diff`, then
  `git apply`" (`init.ts:985`). With `--submit`, the submitted lines replace it; without,
  `init`'s output stays byte-identical.
- **A service in a subfolder.** `main`'s `init` supports one; the forge requires a clone's
  root. At stage 5 `init --submit` there is exit 2, saying so (D12); prefixed paths are a
  follow-up.
- `renderRefusedAnswer` is already exported (`plan.ts:849`): that step goes.

What holds: the configuration never passes through a model — its values come from flags, or
from a person answering a question, and `repositoryConfigSchema` is the gate; a committed
configuration is never rewritten and one equal in value is left alone; flags the schema
refuses and questions it needs are settled before the first model call; and the stated limit
that the Inspector reads the uncommitted working tree.

A value holding a control, format or bidi character (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`, the class
`isCatalogInfoPath` holds a path to) is refused where the flag or the answer is read, before
any model, naming the flag. `clearService` refuses the same values (task 2),
but only after the Inspector and the Architect have been paid for: that is the engine's
re-check at the moment of acting, not the place a person should first hear of a typo. A test
in `init-command.test.ts` pins `--environment 'prod\u2066'` as exit 2 with no model call.

**Files:**
- Modify: `src/cli/index.ts` (`init` options, HELP)
- Modify: `src/cli/commands/init.ts` (`runInitRepo`)
- Modify: `tests/unit/init-command.test.ts` (a `describe('init --submit')`; the `.yml` title), `tests/unit/cli-args.test.ts`
- Modify: `docs/design.md` §7.0, §7.2, §7.3, §7.4, §9.4; `docs/adr/0003-provider-interfaces.md`, `docs/adr/0006-the-merge-request-is-authorisation.md`; `SECURITY.md`; `AGENTS.md`; `README.md` (task 8 lists each edit)
- Modify: `CHANGELOG.md`, `docs/roadmap.md`, the review's Status

**Interfaces:**
- Consumes: `clearService`, `ServiceInput` (task 2); `targetOf`, `isSetAside` (task 2,
  `core/plan/catalog-info.ts`); `readConfigFile`, `ConfigError` (task 2);
  `repositoryConfigSchema`, `CONFIG_FILE`, `serializeConfig`, `RepositoryConfig`,
  `WrittenConfig` (task 2); `openForSubmission`, `refuseDivergence`, `submit`,
  `SubmitOptions`, `PreviewStatus` (task 5); `Ask`, `renderQuestions`, `renderRefusedAnswer`
  (plan.ts).
- Produces:
  - `interface ConfigFlags { readonly iacRepo?: string; readonly environments?: readonly string[] }`
  - `InitOptions.submit?: SubmitOptions` · `InitOptions.flags?: ConfigFlags` (`InitOptions.ask` exists on `main`)

The configuration never passes through a model. Its values come from flags, or from a
person answering a question, and `repositoryConfigSchema` is the gate. The Inspector's facts
are not an input to it, so a test can say so by construction: `configFor` does not take
them.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/init-command.test.ts`, reusing `application`, `drafting`, `COMPONENT`,
`temp` and `hashTree`, and importing `committed`, `git`, `observable`, `show` from
`../support/git.js`, `readConfig` and `ConfigError` from `../../src/cli/config.js`, and
`CONFIG_FILE` and `serializeConfig` from `../../src/core/schemas/config.js`:

```typescript
describe('init --submit', () => {
  const FLAGS = { iacRepo: 'github.com/acme/iac', environments: ['dev', 'staging', 'prod'] }

  const clonedApplication = async (files: Record<string, string> = {}): Promise<string> => {
    const project = await application()
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project, file)), { recursive: true })
      await writeFile(path.join(project, file), text, 'utf8')
    }
    await committed(project)
    return project
  }

  const submitted = async (project: string): Promise<string> => {
    const [branch] = (await git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/idp-agent/')).split('\n')
    return branch ?? ''
  }

  it('cuts one branch in the application repository holding the catalog-info and the configuration', async () => {
    const project = await clonedApplication()
    const before = await observable(project)

    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      submit: {},
      flags: FLAGS,
    })

    expect(result.found).toBe(true)
    expect(result.text).toMatch(/submitted as idp-agent\/init-billing-api-[0-9a-f]{8}/)
    const branch = await submitted(project)
    expect(await git(project, 'diff', '--name-only', 'main', branch)).toBe(`${CONFIG_FILE}\ncatalog-info.yaml`)
    expect(await show(project, branch, CONFIG_FILE)).toBe(serializeConfig(FLAGS))
    const added = (await observable(project)).split('\n').filter((line) => !before.split('\n').includes(line))
    expect(added).toHaveLength(1)
  })

  it('files in the root catalog-info.yml the service keeps, as the preview does', async () => {
    // #82: never a twin catalog-info.yaml beside it.
    const project = await clonedApplication({ 'catalog-info.yml': 'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing\nspec:\n  type: openapi\n  lifecycle: production\n  owner: group:default/tiger\n  definition: "{}"\n' })
    await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, submit: {} })
    expect(await git(project, 'diff', '--name-only', 'main', await submitted(project))).toBe('catalog-info.yml')
  })

  it('files in the one catalog-info the service keeps in a folder', async () => {
    const project = await clonedApplication({ 'deploy/catalog-info.yaml': '# nothing declared yet\n' })
    await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, submit: {} })
    expect(await git(project, 'diff', '--name-only', 'main', await submitted(project))).toBe('deploy/catalog-info.yaml')
  })

  it('refuses a service in a subfolder of its repository, at stage 5, before a model call', async () => {
    // D12: the forge cuts a branch at a clone's root; prefixed paths are a follow-up.
    const root = await clonedApplication({ 'services/billing/package.json': '{ "name": "billing-api" }\n' })
    const client = drafting([COMPONENT])
    await expect(
      runInitRepo({ project: path.join(root, 'services', 'billing'), client, emit: () => {}, submit: {} }),
    ).rejects.toThrow(/root/)
    expect(client.seen).toEqual([])
  })

  it('writes the configuration readConfig reads back', async () => {
    const project = await clonedApplication()
    await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, submit: {}, flags: FLAGS })
    const checkout = await temp()
    await writeFile(path.join(checkout, CONFIG_FILE), await show(project, await submitted(project), CONFIG_FILE))
    expect(await readConfig(checkout)).toEqual(FLAGS)
  })

  it('asks for what the flags did not say, and exits 3 when nobody can answer', async () => {
    const project = await clonedApplication()
    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      submit: {},
      flags: { iacRepo: 'github.com/acme/iac' },
    })
    expect(result.unsupported).toBe(true)
    expect(result.text).toContain(`${CONFIG_FILE}.environments`)
    expect(await git(project, 'for-each-ref', 'refs/heads/idp-agent/')).toBe('')
  })

  it('takes the answer a person gives, and nothing the inspection read', async () => {
    const project = await clonedApplication()
    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      submit: {},
      flags: { iacRepo: 'github.com/acme/iac' },
      ask: async (question) => (question.path.endsWith('.environments') ? 'dev, prod' : undefined),
    })
    expect(result.found).toBe(true)
    expect(await show(project, await submitted(project), CONFIG_FILE)).toContain('environments: ["dev", "prod"]')
  })

  it('never rewrites a committed configuration that says something else', async () => {
    const project = await application(`iacRepo: github.com/other/iac\nenvironments: [prod]\n`)
    await committed(project)
    const before = await observable(project)

    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      submit: {},
      flags: FLAGS,
    })

    expect(result.found).toBe(false)
    expect(result.text).toContain(CONFIG_FILE)
    expect(await observable(project)).toBe(before)
  })

  it('leaves a committed configuration alone when the flags say the same, however it is written', async () => {
    // Unquoted, as a person writes it; `serializeConfig` quotes. Compared by value.
    const project = await application('iacRepo: github.com/acme/iac\nenvironments: [dev, staging, prod]\n')
    await committed(project)

    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      submit: {},
      flags: FLAGS,
    })

    expect(result.found).toBe(true)
    expect(await git(project, 'diff', '--name-only', 'main', await submitted(project))).toBe('catalog-info.yaml')
  })

  it('refuses flags the schema refuses before a single model call', async () => {
    const project = await clonedApplication()
    const client = drafting([COMPONENT])
    await expect(
      runInitRepo({ project, client, emit: () => {}, submit: {}, flags: { iacRepo: '', environments: ['dev'] } }),
    ).rejects.toThrow(ConfigError)
    expect(client.seen).toEqual([])
  })

  it('refuses a working tree that is not HEAD before a single model call', async () => {
    const project = await clonedApplication({ 'catalog-info.yaml': '# committed\n' })
    await writeFile(path.join(project, 'catalog-info.yaml'), '# changed, not committed\n', 'utf8')
    const client = drafting([COMPONENT])
    const result = await runInitRepo({ project, client, emit: () => {}, submit: {} })
    expect(result.found).toBe(false)
    expect(result.text).toContain('catalog-info.yaml')
    expect(client.seen).toEqual([])
  })

  it('prints what it prints today without --submit or a flag, APPLY included', async () => {
    const project = await clonedApplication()
    const before = await hashTree(project)
    const result = await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {} })
    expect(result.text.trimEnd().endsWith('then git apply catalog-info.diff')).toBe(true)
    expect(await hashTree(project)).toBe(before)
  })

  it('previews the configuration a flag states without --submit, and writes nothing', async () => {
    const project = await clonedApplication()
    const before = await hashTree(project)
    const result = await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, flags: FLAGS })
    expect(result.text).toContain(`+++ b/${CONFIG_FILE}`)
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(await hashTree(project)).toBe(before)
  })
})
```

`init-command.test.ts`'s `application()` takes no argument today. Give it the optional
configuration `plan-intent.test.ts`'s helper already takes. Every existing caller passes
nothing and is unaffected:

```typescript
const application = async (config?: string): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api' }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, 'CODEOWNERS'), '* @acme/platform\n', 'utf8')
  if (config !== undefined) await writeFile(path.join(root, CONFIG_FILE), config, 'utf8')
  return root
}
```

In `tests/unit/cli-args.test.ts`: `init --environment dev --environment prod --iac-repo x`
parses; `init --backstage https://…` is refused as `--backstage` taking no value; `init --env`
is unknown to `init`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/unit/init-command.test.ts tests/unit/cli-args.test.ts`
Expected: FAIL — `submit` and `flags` are not `InitOptions` fields.

- [ ] **Step 3: Parse the flags**

In `parseArguments`' `init` branch (not `init platform`), the options gain:

```typescript
          submit: { type: 'boolean' },
          'iac-repo': { type: 'string' },
          environment: { type: 'string', multiple: true },
```

beside the existing `--repo`, `--name`, `--lifecycle` and `--owner` (`INIT_FLAGS`,
`init.ts:357`). No `backstage` option: the global boolean stays what it is (D9). The `init`
member of `Command` gains `submit: boolean` and `flags: ConfigFlags`, each flag omitted when
absent. `main` passes `flags` and `submit` (built exactly as in task 5) into `runInitRepo`
beside the `ask` it already passes. `HELP`'s `init` line names the new flags, and `usageOf`
prints them.

- [ ] **Step 4: Compose the configuration, and submit**

In `src/cli/commands/init.ts`, add the pure decision and its questions:

```typescript
export interface ConfigFlags {
  readonly iacRepo?: string
  readonly environments?: readonly string[]
}

const CONFIG_QUESTIONS = {
  iacRepo: {
    path: `${CONFIG_FILE}.iacRepo`,
    question: 'Where do the declarations live? A repository locator, e.g. github.com/acme/iac',
  },
  environments: {
    path: `${CONFIG_FILE}.environments`,
    question: 'Which environments does this organisation have? Comma-separated, e.g. dev, staging, prod',
  },
} as const

type ConfigDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'write'; readonly config: WrittenConfig }
  | { readonly kind: 'missing'; readonly questions: readonly Question[] }

/**
 * What `.idp-agent.yml` should say, from what a PERSON typed and nothing else.
 * The inspection is deliberately not a parameter: the configuration seeds the
 * vocabulary every gate measures against (§7.0), so a model's reading of the
 * project must never be where it came from. `backstage:` is never written
 * (D9): it is never requested either, and a URL is never taken from a command
 * line (ADR-0011).
 *
 * An existing file wins when no flag is given; when flags are given they state
 * the whole configuration, and `clearService` refuses one that differs from the
 * file — a committed configuration is never rewritten.
 */
function configFor(
  flags: ConfigFlags,
  existing: RepositoryConfig | undefined,
  submitting: boolean,
): ConfigDecision {
  const typed = flags.iacRepo !== undefined || flags.environments !== undefined
  if (!typed && existing !== undefined) return { kind: 'none' }
  if (!typed && !submitting) return { kind: 'none' }
  const iacRepo = flags.iacRepo ?? existing?.iacRepo
  const environments = flags.environments ?? existing?.environments
  const missing = [
    ...(iacRepo === undefined ? [CONFIG_QUESTIONS.iacRepo] : []),
    ...(environments === undefined ? [CONFIG_QUESTIONS.environments] : []),
  ]
  if (missing.length > 0) return submitting ? { kind: 'missing', questions: missing } : { kind: 'none' }
  const parsed = repositoryConfigSchema.safeParse({ iacRepo, environments })
  if (!parsed.success) {
    throw new ConfigError(`the configuration flags do not make a configuration — ${reasonOf(parsed.error)}`)
  }
  // The same configuration, however the committed file happens to be written:
  // nothing to write, and a re-run with the same flags is a no-op.
  if (existing !== undefined && serializeConfig(parsed.data) === serializeConfig(existing)) {
    return { kind: 'none' }
  }
  return { kind: 'write', config: { iacRepo: parsed.data.iacRepo, environments: parsed.data.environments } }
}
```

Whether a person with no flags and no file is asked for a configuration at all is this pull
request's to settle against §7.3; the code above asks only when submitting, so a preview
without flags stays byte-identical.

Then reorder `runInitRepo` (`init.ts:704`) so that everything free, and every question for a
person, comes before the first model call:

1. Open the forge before anything is read, as task 5 does, for the service repository:
   `const opened = options.submit === undefined ? undefined : await openForSubmission(options.project, 'service', options.submit)`.
   A project that is not a clone's root is `ForgeInputError`, exit 2; its message says that
   a service in a subfolder of its repository is not submitted at stage 5 (D12).
2. Replace `readConfig` (`:708`) with `const read = await readConfigFile(options.project)`,
   and use `read?.config` wherever `config` was used.
3. Decide the configuration, and ask for what is missing, **before `readProject` and the
   Inspector**. A flag the schema refuses is an argument error (exit 2), and a question is a
   person's time: neither should come after three paid round-trips.

```typescript
  let decision = configFor(options.flags ?? {}, read?.config, opened !== undefined)
  if (decision.kind === 'missing') {
    if (options.ask === undefined) return renderQuestions(decision.questions)
    const answers = new Map<string, string>()
    for (const [index, question] of decision.questions.entries()) {
      const said = await options.ask(question)
      if (said === undefined || said.trim() === '') return renderQuestions(decision.questions.slice(index))
      answers.set(question.path, said.trim())
    }
    const iacRepo = answers.get(CONFIG_QUESTIONS.iacRepo.path)
    const environments = answers.get(CONFIG_QUESTIONS.environments.path)
    try {
      decision = configFor(
        {
          ...options.flags,
          ...(iacRepo !== undefined ? { iacRepo } : {}),
          ...(environments !== undefined
            ? { environments: environments.split(',').map((env) => env.trim()).filter((env) => env !== '') }
            : {}),
        },
        read?.config,
        true,
      )
    } catch (error) {
      // An ANSWER the schema refuses is a negative answer about one value
      // (exit 1), the way `plan` treats one — not an argument error.
      if (error instanceof ConfigError) return renderRefusedAnswer(error.message)
      throw error
    }
  }
```

4. `readProject`, and `init`'s own verdicts on what it read, unchanged (`:711-760`): the
   notices, `considered`, `target = targetOf(considered)`, `kept`, and the refusal of an own
   catalog-info nobody can read.
5. If `opened` is set, refuse a divergence on what the gates read and this command writes —
   still before the Inspector:

```typescript
  if (opened !== undefined) {
    // The target's bytes or its absence, every kept declaration the "already
    // declared" and name decisions read, and the configuration's bytes or its
    // absence (check §5.2) — never CATALOG_INFO by name.
    const files = new Map<string, string | undefined>(kept.map((file) => [file.path, file.text] as const))
    if (!files.has(target)) files.set(target, undefined)
    files.set(CONFIG_FILE, read?.text)
    const refused = await refuseDivergence(opened, { files, scope: 'touched' })
    if (refused !== undefined) return refused
  }
```

6. The existing flow follows unchanged: the Inspector, the Architect, the signature, the
   recognition (`renderDeclared` exits 0 with no branch), the name question, the questions.
7. `previewOf` (`:937`) mints through the clearance, so preview and submission show the same
   bytes, filed at the same `target`:

```typescript
  const cleared = clearService(signed, {
    target,
    kept,
    existing: read,
    config: decision.kind === 'write' ? decision.config : undefined,
  })
  // Refused with or without --submit: a preview of bytes that cannot be
  // submitted would be a diff of something this command will never write.
  if ('outcome' in cleared) {
    return {
      text: [
        'refused — nothing was previewed, and nothing was written:',
        ...cleared.reasons.map((reason) => `  ${inertLine(reason)}`),
      ].join('\n'),
      found: false,
    }
  }
  const render = (status: PreviewStatus): CommandResult =>
    renderPreview({
      signed,
      edits: cleared.edits,
      dropped: [],
      status,
      ...(options.colour !== undefined ? { colour: options.colour } : {}),
    })
  // Without --submit, the tail is APPLY, byte for byte as today.
  if (opened === undefined || cleared.edits.length === 0) return render({ kind: 'applied-by-hand', apply: APPLY })
  const { result } = await submit({
    opened,
    cleared,
    render,
    ...(options.submit?.confirm !== undefined ? { confirm: options.submit.confirm } : {}),
  })
  return result
```

**A limit to state in the comment above this tail, not a defect to fix here.** The
Inspector reads the application's *working tree*, uncommitted `CODEOWNERS` and
`package.json` included. The `touched` expectation proves only the declarations `init` read
and the two files this command writes. So an owner the inspection read out of an uncommitted
file is vouched for, even though the branch does not carry that file. The diff and the merge
request are where a person sees it. Proving every file the Inspector read against `HEAD`
would refuse `init` in any repository with a dirty unrelated file, which is a worse trade.

Keep the existing comments above `previewOf` about the service repository and the `before`
read whole. They are still true.

- [ ] **Step 5: Correct what this makes false, in this commit**

Task 8 lists the document edits this pull request carries: design §7.0, §7.2, §7.3, §7.4 and
§9.4; the ADR-0003 and ADR-0006 amendments; `SECURITY.md`'s state line and its forge rows;
`AGENTS.md`'s current state; `README.md`; the `init-command.test.ts` title.

- [ ] **Step 6: Traceability**

- `CHANGELOG.md`, Unreleased → Added: one line with the link.
- `docs/roadmap.md`: stage 5 **done** in the state table and the queue item removed, the queue
  renumbered; `init --submit` in a subfolder (D12) and `idpa "<phrase>" --submit` (D8) as
  follow-ups; B3 next as queued.
- The review's Status: gap-stage5-readiness-8 closed (the identity with task 4, the `before`
  with #82, the filing here), and every other stage-5 readiness id this stage closed, each
  naming its test.

- [ ] **Step 7: Run everything and commit** *(after the owner's go-ahead)*

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm smoke   # the full run only with 2 GiB free on /
git add src/cli tests docs SECURITY.md AGENTS.md README.md CHANGELOG.md
git commit -m "feat(cli): submit a service's declaration and its configuration, written only from what a person typed"
```

---

### Task 8: The documents — spread over the pull requests that make them true

*Amended on 2026-09-29 (check §3 P8, §6).* At `eee67d6` this was a last pull request of its
own. The repository's traceability rule already asks every pull request for its CHANGELOG,
roadmap and review-Status lines, and a document edit that lands before its code is a claim
nobody can check: so each edit below rides with the pull request that makes it true, and this
task is the checklist of where each one lands. Two contradictions it listed are already
closed on `main`: design §10's `core/git` (#89), and `SECURITY.md`'s "stage 1 of 7", now
"stage 4 of 7" (#78). The ADR numbers moved: 0008 and 0009 are taken on `main` (commentary,
tracing), 0010 was reserved for the stage-5 check, and 0011 is `backstage-http`'s.

**In pull request #0 — the check, and this revision** *(documents only)*

- [x] `docs/stage-5-check.md` — the check, its evidence and the owner's decisions of 2026-09-29.
- [x] `docs/stage-5-brief.md` — the owner's brief, committed as it stands, dated, with a note
  that it was written on `eee67d6` and is superseded where the check says so (D15).
- [x] This plan, revised in place (D15).
- [x] `docs/adr/0010-a-submission-is-a-create-only-ref.md` — draft-0008, *proposed*,
  renumbered 0010 (the owner's decision of 2026-09-27: 0010 goes to the stage-5 check) and
  rewritten with the check's decisions: the repository role on `Cleared` and the mixed plan
  refused (D6), the parent-equals-base rule (D7), the runtime brand (D3), the base as `HEAD`
  with the read bytes proven equal, the provenance bound to the signature (D1), the `--from`
  road's gates by route (D4), git run in `spawnedEnvironment` minus `GIT_*` (ADR-0011), B3's
  status (not a prerequisite of the writer, D17), and today's counts.
- [x] `docs/adr/0012-declared-is-not-provisioned.md` — draft-0009, *proposed* (D16), its
  reconciler a separate component with its own credential: ADR-0011 makes one GET-only
  transport the only code that sends the catalogue token, so publishing a status to
  Backstage is never this tool's token's to do.
- [x] `docs/design.md`'s ADR index (`:1294-1308`): 0010 and 0012 named, *proposed*.
- [x] `docs/roadmap.md`: the check done and removed from the queue, the owner's decisions
  dated, B3's sentence corrected (after stage 5; the forge writes only objects and a ref).
- [x] `CHANGELOG.md`: one line under Unreleased → Documentation.

**In task 1's pull request**

- [x] `sign.ts`'s stage-5 comment (contradiction 4); `seal.ts` carries the §5.2 rationale.
- [x] `src/core/plan/README.md`: the `clear.ts` and `seal.ts` rows.

**In task 3's pull request**

- [ ] `AGENTS.md`: the rule count (re-measured from 19), the launcher as the one module that
  starts a process, the layering diagram and the folder table (`forge/`, `process/`).
- [ ] `docs/design.md` §5.5: the rule count, the new rules, transitivity.
- [ ] `SECURITY.md`: the key-and-token row and the "one starts a process" row name the launcher.
- [ ] `src/context/README.md`: `spawnedEnvironment` moved to `process/`.

**In task 4's pull request**

- [ ] `docs/design.md` §8 (nothing to roll back), §9.2 ("initial state" is the observable
  state; idempotence at two levels), §4.3 (gap-stage5-readiness-12: two amendments of one
  grant conflict at the merge).
- [ ] `src/scaffold/write.ts:7`, `src/scaffold/README.md:17`, the `scaffold/` rule's comment in
  `tests/architecture/dependencies.test.ts`: the seam stays, and a branch in an existing
  repository is `forge/local/`'s (ADR-0010) — contradiction 3.
- [ ] `SECURITY.md`: *Writes nothing, except* (`:34`) gains the submission; the "check at the
  moment of writing" item (`:218`) moves to *Guaranteed today* with its tests; the writers
  are named (contradiction 10); and, in *Guaranteed today*, each row naming its test:
  - a submission writes one new ref and moves none (`local-forge.test.ts`);
  - a failed submission leaves the observable state (`tests/invariants/forge.test.ts`);
  - the repository's hooks never run, and `GIT_*` cannot redirect a write (`process-git.test.ts`);
  - git never guesses who commits: an identity is configured or the submission stops before any model (`process-git.test.ts`, `local-forge.test.ts`, D13);
  - no provider key and no catalogue token reaches the forge's git (`process-git.test.ts`);
  - a clearance for the wrong repository is refused (`local-forge.test.ts`);
  - a value `clear.ts` did not mint is refused (`local-forge.test.ts`, D3);
  - our files on a parent that is not the base are refused (`local-forge.test.ts`, D7);
  - a repository inside another is refused (`local-forge.test.ts`);
  - bytes the gates did not judge are never submitted (`local-forge.test.ts`, divergence);
  - a symlinked catalogue file is refused at submission, though the preview still reads
    through it until B3 (`local-forge.test.ts`, D17);
  - only `process/git.ts` starts a process (architecture).
- [ ] `AGENTS.md`: the writers.

**In task 5's pull request**

- [ ] `AGENTS.md`: the exit-code paragraph; "`init platform` is still the only command that
  writes" (`:171`, contradiction 8); `[--submit]` in the commands block.
- [ ] `SECURITY.md`: the `--from` road worded by route (D4).
- [ ] `README.md`: the `--submit` line and one sentence on what a local submission does and
  does not do.
- [ ] `docs/roadmap.md`: cli-ux-10's item names the `submission` key (D11); `idpa "<phrase>"
  --submit` recorded as a follow-up (D8).

**In task 7's pull request** — what is left

- [ ] **`docs/design.md`**:
  - **§5.1.** "The last box is not built. Stage 4 ends at the diff, and the branch and the
    merge request arrive at stages 5 and 6" → "The branch is built at stage 5: a ref under
    `idp-agent/`, cut from `HEAD` and never moving one. The merge request is stage 6."
  - **§7.0.** "Read from stage 4, written at stage 5" stays. Replace the sentence "`init`
    previews the `catalog-info.yaml` and leaves this one to the stage allowed to create it"
    with: "`init --submit` writes it, on the same branch as the service's catalog-info, from
    `--iac-repo` and `--environment` or from answers — never from the inspection, never with
    a `backstage:` — and never rewrites one that is committed. Nothing reads `iacRepo` before
    stage 6."
  - **§7.2 and §7.3.** `catalog-info.yml` → `catalog-info.yaml` where the file `init platform`
    or a new service writes is meant, and "the file `init` adds to — `targetOf`'s choice" where
    the service's own is (contradiction 6). In §7.3, "The fourth clause waits for stage 5" →
    "The fourth clause arrives with `--submit` at stage 5."
  - **§7.4.** Replace the paragraph beginning "Steps 3 to 7 ship at stage 4" with:

    > Steps 3 to 7 ship at stage 4, and step 8's branch at stage 5. `plan … --submit` shows
    > the diff and, at a terminal, asks one question — *Submit this for review as
    > idp-agent/… in <repository>?* — whose default is no. Without a terminal, `--submit` is
    > the answer, which is safe because the confirmation was never the guard: the merge is.
    > The local forge cuts the branch and says it opened no merge request, because there is
    > no forge to open one on until stage 6. `plan --from … --submit` crosses four gates and
    > no Reviewer; `idpa "<phrase>"` does not submit at stage 5.

  - **§9.4.** Add `test('a submission cannot move an existing ref, main included')`, marked as
    the local half of the first test.
  - **§4.4**, a bullet: "**Declared is not provisioned.** A merged declaration is
    authorised, and a system downstream may still refuse it or fail. Refusal is caught
    before the merge by a required check (stage 6); failure is detected after it and
    reported as the entity's status, never written back into the declaration and never
    deleted (ADR-0012, proposed)."
  - **§13**, extend the "Real Kong / Tufin / Jira integrations" bullet: "…and with them the
    reconciler of ADR-0012 — until then, `main` says *authorised*, not *provisioned*."
- [ ] `src/cli/commands/init.ts`: `BRANCH_PROTECTION` (`:60`) gains one line after "include
  administrators":

  ```
    · require the downstream decision (Tufin, AlgoSec, a DBA's queue) as a status
      check, once one reports — a refused request must never merge (stage 6, ADR-0012)
  ```

  and `tests/unit/init-command.test.ts`'s "prints the branch protection it cannot set" adds
  `expect(run.out).toContain('status')`. Re-run `pnpm smoke`: its `init platform` check
  matches the count of files written, which the added line does not change.
- [ ] ADR-0003: "`ForgeProvider` (`src/forge/provider.ts`) is designed, not yet built" →
  "`ForgeProvider` (`src/forge/provider.ts`) ships at stage 5 with one implementation,
  `local`, opened for one repository; it has no `merge` and no `delete` (ADR-0010)."
- [ ] ADR-0006, Consequences: add "Stage 5's local forge makes the first half testable: a
  submission cannot move an existing ref, `main` included (ADR-0010)."
- [ ] ADR 0010's status: the owner accepts it, and the pull request that does records the
  date. ADR 0012 stays *proposed* until stage 6 builds its first mechanism.
- [ ] `SECURITY.md`: "stage 4 of 7" (`:6`) → "stage 5 of 7": it writes one new branch per
  submission, in the repository named, and no token until stage 6; "no secret reaches the
  model" and the Inspector's confinement stay where #78 put them.
- [ ] `AGENTS.md`:
  - "Current state": stage 5 **done**; replace "Stage 5 is in progress and none of it is on
    `main`";
  - "Shipped and working": `--submit` on `plan` and `init`, and the test, file and smoke
    counts re-measured;
  - the trust-boundary diagram: `→ Diff` becomes `→ Diff → [submit] → branch`;
  - *Open questions*: "a submission ignores the repository's hooks (ADR-0010)", and
    "**declared is not provisioned** — a merged declaration can still be refused or fail
    downstream, and nothing detects it yet (ADR-0012)".
- [ ] `README.md`: `init --submit` in the command list.
- [ ] `tests/unit/init-command.test.ts`: the title that says `catalog-info.yml` and asserts
  `.yaml` → `catalog-info.yaml`.

- [ ] **Verify the documents against the code, in each of those pull requests**

Every count in `AGENTS.md` and `SECURITY.md` is re-measured, not edited by hand:

```bash
df -h /   # under 2 GiB free: the targeted suites only, and say so
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm vitest run tests/architecture --reporter=verbose
rtk proxy grep -rn "stage 4 of 7\|replaces this seam\|only command that writes\|\*\*[Nn]ineteen\*\*\|designed, not yet built" docs AGENTS.md SECURITY.md README.md src tests
```

Expected, once task 7 is merged: the grep finds only historical plans (`docs/plans/stage-*`)
and dated reviews, which are records of what was decided then and stay as written. The rule
count is searched in bold (`**Nineteen**` in `AGENTS.md`, `**nineteen**` in design §5.5):
a bare "nineteen" also finds the stage-5 check's nineteen decisions and the roadmap's dated
entry for them, which count something else and stay.

---

## Done when

- `idp-agent plan --from <plan.json> --submit`, in a declarations repository `declarationsFor`
  resolves — `--repo`, the working directory, `IDP_REPO` or the personal file, stderr naming
  which — cuts **one** branch `idp-agent/<slug>-<8 hex>` from `HEAD`. Every other ref,
  `HEAD`, the index and the working tree are byte-identical before and after.
- The branch holds exactly the bytes of the diff that was printed. This is proven by
  rendering the branch with the same renderer.
- Submitting the same bytes twice on the same base names the existing branch, exits 0 and
  writes nothing. A branch that merely *contains* those bytes, among other changes, or
  carries them on another parent, is refused.
- A submission failing at any mutating step leaves the observable state intact or the
  whole branch, never part of it. Checked over injected failures before and after every
  step.
- A submission cannot move an existing ref, `main` included, and the forge refuses any value
  `clear.ts` did not mint — a spread, a cast or a clone of one (D3) — and a clearance for
  the other repository.
- A clearance re-runs the free gates against the provenance the plan was signed with (D1),
  asks what the preview asks — an update's implied environment included — refuses an empty
  change the repository does not already account for (#83), and refuses by name a plan that
  writes into both repositories (D6).
- A working tree that differs from `HEAD` is refused **before** a model is paid, and nothing
  is written.
- A repository inside another, a detached `HEAD`, a missing `git`, no committer identity,
  `--submit` with `--demo`, `idpa "<phrase>" --submit` and `init --submit` in a subfolder
  exit 2, before any model.
- The repository's hooks never run, an inherited `GIT_DIR` cannot redirect a write, no
  provider key and no catalogue token reaches git, and a `git` planted in the repository
  never runs — one launcher for every process `src/` starts.
- `plan` and `init` without `--submit` write nothing, `.git/` included, and print what they
  print on `d0fdee9` byte for byte.
- At a terminal, the diff is shown before the question, and declining writes nothing. The
  confirmation is handed a structured summary (D5).
- `init --submit` writes the service's catalog-info — the file `init` previews, `targetOf`'s
  choice — and `.idp-agent.yml` on one branch of the application repository. The
  configuration comes only from `--iac-repo`, `--environment` or answers, never holds a
  `backstage:`, `readConfig` reads it back identically, and a committed one is never
  rewritten. One equal in value, however it is written, is left alone.
- A flag the configuration schema refuses, or a question it needs answered, is settled
  before the first model call.
- §9.2's "applying twice == applying once" holds over generated plans, grants included,
  with a vacuity guard.
- `main`'s nineteen architecture rules and this stage's new ones, each new one seen failing,
  `core/`'s disk rule transitive, and the count re-measured where it is stated.
- `pnpm test` needs no API key, no network and no Docker.
- ADR 0010 records the submission; ADR 0012 (*proposed*) records that a merged declaration
  is *authorised*, not *provisioned*, and `init platform` names the downstream check stage 6
  will require.
- Every pull request carried its `CHANGELOG.md` line, its `docs/roadmap.md` edit and the
  review ids it closed.
- `docs/audit-attacks/` still reports every closed defect as closed. Run it with a temporary
  vitest config whose `include` is `docs/audit-attacks/**/*.test.ts` (see `AGENTS.md` for
  why it is not in `pnpm test`).

Stage 6 puts a merge request on the far side of this branch, and makes the first test of
§9.4 real: the token that opens that request is used to try to merge it, and the attempt
must **fail**. The interface this stage ships has no method for it to call. **The merge is
what authorises it.**
