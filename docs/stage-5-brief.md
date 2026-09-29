# Stage 5 brief — write, and the local branch

> **A dated record.** The owner wrote this brief on `eee67d6`, before the plan it asked for
> ([`plans/stage-5-write.md`](plans/stage-5-write.md)), and it is committed as it stands
> (the owner's decision of 2026-09-29). Its counts — 790 tests across 54 files, thirteen
> architecture rules — and its account of the code are that commit's. Where
> [the stage-5 check](stage-5-check.md) of 2026-09-29 says otherwise, the check supersedes
> it; its questions Q1–Q6 are answered in the plan, which was revised in place against
> `main` at `d0fdee9`.

**For the agent receiving this.** You are asked for two things, in order, and the first
gates the second:

1. **Answer the open questions in §4.** They are decisions the design does not make, and
   each one changes the shape of the module. Answer them by reading the code, not by
   picking what seems reasonable — where the code already implies an answer, say so and
   quote it; where it genuinely does not, say that too and recommend one with its cost.
2. **Then write `docs/plans/stage-5-write.md`**, in the format of the four plans already in
   `docs/plans/` — goal, global constraints, tasks split into stacked PRs with checkboxes.
   Not before the answers are agreed.

Do not implement anything. Do not run a model: `pnpm test` is offline and must stay that
way, and the keys in `.env` are not yours to spend.

---

## 1. What this tool is

`idp-agent` turns a natural-language intent into versioned, Backstage-shaped infrastructure
declarations that a human reviews and merges. Its entire value is one sentence:

> **An LLM cannot cause an unreviewed change to production infrastructure.**

Everything in the codebase is downstream of that. A model proposes; deterministic
TypeScript decides. Four agents (Supervisor, Inspector, Architect, Reviewer) read and
suggest; no agent orchestrates, no agent writes, no agent chooses a file path.

**Standing constraints, all of them load-bearing:**

- **No privileged provider or model.** Anthropic, Mistral and OpenAI are behind one
  interface; whoever takes over this project must be able to plug in the model they want.
- **No privileged language.** A request arrives in any language the model supports. Word
  boundaries are by Unicode script, never ASCII — an ASCII boundary once matched `prod`
  inside the Turkish `prodüksiyon`.
- **Destined for open source.** The repository is private today.
- **Ask before committing.** No commit, push, PR or merge without the owner's explicit
  go-ahead.

## 2. Where it stands

`main`, four stages complete, **790 tests across 54 files**, 22 smoke checks against the
built binary, typecheck clean, CI green. ~10 700 lines of TypeScript across 65 files.

| Stage | Delivered |
|---|---|
| 0 | schemas, serialiser, path computation, invariants |
| 1 | `graph`, `show` over a fictional catalogue |
| 2 | question mode, and the recording harness |
| 3 | `init platform` — scaffold, CI, CODEOWNERS, witnesses |
| 4 | Inspector + Architect + Reviewer + Plan + diff — **writes nothing** |

**The CLI surface today:** `init`, `validate`, `plan`, `ask`, `show`, `graph`.
**Exit codes:** `0` ok · `1` a negative answer, not a failure · `2` bad usage · `3`
understood, and this build will not act on it.

### The five gates

Every plan crosses them in this order, in `agents/repair.ts`, three attempts maximum:

```
Plan ─► [1] Zod ─► [2] signature ─► [3] policies ─► [4] re-check ─► [5] Reviewer ─► Diff
```

The four free gates run first so a draft that cannot survive them never costs a model call.
**Gate [2], the signature, is the heart of the design**: it classifies every leaf of a
proposal by where the value came from — `derived` (the engine computed it), `echoed` (the
person's own request), `enumerated` (the catalogue already uses it), `novel` (nobody can
vouch for it) — and a `novel` leaf becomes a question put to the user rather than a value.
A `SignedPlan` is branded, deep-frozen, and its brand is never exported.

### What was just finished, and why it matters here

An external audit found twelve defects. Eleven are closed; the twelfth is left open **and
written down as a limit** rather than fixed with a rule that would work in English and
silently weaken the check in every other language.

Four more were found by acting on the audit's F7 — re-recording the scenarios made the
whole chain run end to end for the first time. Read `docs/audit-report.md` (its status
table first) before you start: **the recurring lesson is that defects live between
components, and attacking beats reading.** Two examples that bear directly on stage 5:

- `plan` could not land in **any** configured repository, because the catalogue reader
  skipped hidden *directories* and not hidden *files*, so `.idp-agent.yml` was parsed as an
  entity and one `invalid-entity` makes the re-check refuse the whole plan. Every fixture
  passed because no fixture had a configuration file.
- `nothing to change.` on exit 0 was reachable by a model calling `propose` with **no
  operations** — somebody asked for an authorisation and was told their repository already
  granted it. Both agent prompts explicitly instructed the model to do that.

`docs/audit-attacks/` holds nine test files that **assert defects**: a test there *passing*
means the defect still reproduces, *failing* means it is closed. It currently reports 13 of
21 failing. Note that suite's own failure mode, because you may repeat it: its fixtures
drifted behind `SignatureContext`, so eight tests were *throwing* rather than asserting —
and a crash counts as a failure, which in that folder reads as a closure. **An oracle that
lies in the safe direction is the worst kind to have.**

## 3. What stage 5 is

From `docs/design.md` §11:

| | |
|---|---|
| Stage 5 | **Write + local branch** |
| Demonstrable output | local `ForgeProvider`, atomicity, idempotence |
| Estimate | 1 week |

Three clauses elsewhere in the design are explicitly waiting for it:

- **§7.0** — `.idp-agent.yml` is "read from stage 4, **written at stage 5**". `init`
  previews `catalog-info.yml` and leaves this one to the stage allowed to create it.
- **§7.4 step 7** — there is no confirmation prompt yet, "because there is nothing on the
  other side of it to confirm: the branch is stage 5 and the merge request is stage 6".
- **§8** — "Write interrupted → full rollback, initial state restored."

**This stage inverts the property every previous stage asserted.** Until now the guarantee
was *not one byte* — a test hashes the directory before and after a full preview. From here
it becomes §4.2's:

> The merge is the act of authorisation. The CLI opens a merge request; it never writes to
> the main branch. Confirming in the terminal means "I am submitting my request", not "I am
> authorising myself."

That is a much harder sentence to test than a tree hash, and **that is where the real work
of this stage is.** ADR-0006 records the rejected alternative — apply on confirmation, one
token, a commit straight to main — and why it makes the guarantee untestable.

### What is already in place

- **The bytes are already computed.** `planEdits` produces `FileEdit { path, before, after }`
  for every file a plan touches, and the diff a user reads is rendered from exactly those.
  Writing is *applying `after`*. Stage 5 invents no content.
- **There is a precedent for writing.** `scaffold/write.ts` has an injectable `FileIO`
  whose `writeNew` "never clobbers, never deletes", so `init platform` already writes and is
  tested without a disk.
- **Idempotence is finally demonstrable.** `nothing to change.` can no longer come from an
  empty plan or from operations that were all dropped; it now means the bytes match the
  ones on disk.

### The two invariants §9.2 declares and nothing yet tests

```
∀ Plan → application is atomic (failure ⇒ initial state intact)
∀ Plan → applying twice == applying once
```

Both are unimplementable before stage 5 because nothing applies. They are the stage's real
acceptance criteria, and `tests/invariants/` already has the `fast-check` harness the other
three invariants use.

### §9.4's list of tests that must FAIL

```ts
test('the token that opens a merge request cannot merge it')   // stage 6
test('no module under agents/ imports fs, git or child_process')
test('a Plan carrying a path outside the repository is rejected')
test('a Plan carrying an unknown field cannot be applied')
```

The last three hold today. The first is stage 6 — but the shape of `ForgeProvider` decided
in stage 5 is what makes it writable or not, so design for it now.

## 4. The open questions — answer these first

These are the reason this brief exists. Each changes the module's shape, and the design does
not settle any of them.

### Q1 — What is a "local branch" when nothing here has ever touched git?

Nothing in `src/` imports a git client, `child_process`, or shells out. `plan --repo` takes
a **path**, and the scenario fixtures hand it a `mkdtemp` directory with no `.git` at all.

So: does `forge/local` create a real git branch in a real clone, or does "local" mean *a
directory and a diff*, with git arriving only with the GitHub provider at stage 6?

The answer decides whether this stage introduces a git dependency, what `--repo` must
henceforth be, and what happens when it is not a repository. Note what it costs either way:
a real branch makes the stage-6 forge a thin layer over something proven, while a
directory-only `local` keeps the offline test suite trivial and defers every git failure
mode to the stage that has one week for a real forge.

### Q2 — Where does the atomicity boundary sit?

§9.2 says application is atomic: failure leaves the initial state intact. A plan touches
several files (`planEdits` returns one edit **per file**, never per operation). Is the unit
of atomicity the file, the plan, or the branch — and what restores the state, given that
`FileIO.writeNew` deliberately "never deletes"?

Say what "failure" covers: a full disk mid-write is not the same as a gate refusing, and
the second already happens before any byte exists.

### Q3 — What does the second run of the same intent do?

"Applying twice == applying once" is a property of the *bytes*. But the second run drafts a
new plan from a model, against a repository the first run changed. The re-check now reports
`already-declared` and the preview renders no diff — so is idempotence asserted over
`planEdits` output alone (deterministic, no model needed), or over the whole command
(which would need a recording)? The first is testable in CI today; the second is the
property a user actually experiences.

### Q4 — Where does the confirmation live, and what does it say?

§7.4's step 7 needs a prompt. There is already an `ask` seam for questions
(`CliOptions.ask`), and a non-interactive run must not hang — today it exits 3 and prints
the question. What is the non-interactive contract for a *write*: refuse, or a `--yes` flag,
and which exit code? Whatever it is, it must make "I am submitting my request" impossible to
read as "I am authorising myself".

### Q5 — Does `.idp-agent.yml` go through the same gates?

§7.0 says stage 5 writes it. It is not an entity, so no signature classifies it and no
policy sees it — but it seeds the vocabulary the gates measure everything else against. Is
writing it a plan operation, or a separate command path? Note that its misplacement was half
of audit finding F6: it belongs in the **application** repository, and `readConfig` looks
nowhere else.

### Q6 — What does `agents/` still not get to see?

Thirteen architecture rules walk the transitive import closure and fail the build on a
forbidden edge; rule 2 is that nothing reachable from `agents/` imports `fs`,
`child_process`, or a git client. A `forge/` module is exactly the kind of thing that ends
up imported from somewhere convenient. Which rule covers it, and does the closure need a
fourteenth?

Read `SECURITY.md`'s section "What the architecture rules are, and are not" before
answering: they are a build-time convention with teeth, never a sandbox.

## 5. How to work

- **Attack it, don't read it.** Four adversarial rounds during stage 4 found 11, 12, 14 and
  13 defects; each round's fixes created new ones until the root was addressed. The external
  audit then falsified three claims made from reading alone.
- **Measure, don't assert.** Every claim in `docs/audit-report.md` is backed by something
  that was run. If you cannot run it, say the claim is unverified.
- **Comments carry the why and the measurement**, in the style already in the codebase:
  what was tried, what it cost, what it does *not* cover.
- `rtk proxy pnpm vitest run` runs the suite (a hook rewrites bare commands; `rtk proxy`
  bypasses it). `pnpm smoke` runs 22 checks against `dist/cli/bin.js`. `pnpm typecheck` is
  TypeScript 7 strict — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`.

## 6. What to hand back

**First** — answers to Q1–Q6, each with the evidence for it and the cost of the
alternative. Where the code already decides, quote it. Where it does not, recommend and say
why. Flag anything in `docs/design.md` that your answers make false: the design is the
contract, and it has drifted before — §6.1's prose called the re-check "gate [5]" for three
commits after it became [4].

**Then, once those are agreed** — `docs/plans/stage-5-write.md`: goal, inherited global
constraints, and tasks split into stacked PRs with `- [ ]` checkboxes, each task landing
something demonstrable and green on its own.

## 7. Where to read

| | |
|---|---|
| `docs/design.md` | the contract. §4 doctrine · §5 architecture · §6.1 the gates · §7 the commands · §9 tests · §11 stages |
| `docs/audit-report.md` | the external audit, status table first |
| `docs/audit-attacks/` | nine files asserting defects — passing means it reproduces |
| `docs/adr/0003`, `0006` | provider interfaces; the merge request is authorisation |
| `docs/plans/stage-4-preview-only.md` | the format your plan should match |
| `SECURITY.md` | what is guaranteed, and what is only a convention |
| `AGENTS.md` | how to work in this repository |
| `src/core/plan/sign.ts` | the signature — read this one in full |
| `src/core/plan/edits.ts` | `FileEdit`, the bytes stage 5 applies |
| `src/agents/repair.ts` | the five gates, in order |
| `src/scaffold/write.ts` | the only code here that writes today |
