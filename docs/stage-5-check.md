# Stage-5 check — the owner's plan and work against today's `main`

**Answers the queue item** in `docs/roadmap.md:52-65`: a read-only check of the owner's
stage-5 plan against the review's stage-5 readiness findings and the current `main`, starting
with the owner's uncommitted work on `feat/s5-cleared`. It is shown to the owner before a
line of stage 5 is written; its ADR becomes 0010.

**Date** 2026-09-29 · **Checked against** `main` at `d0fdee9` · **The owner's work** branch
`feat/s5-cleared` at `eee67d6`, uncommitted · **Settled** 2026-09-29: the owner chose D1, D3,
D6 and D15, and took this check's recommendation for the other fifteen as the default, open
to change (§7); the plan is revised in place and ADR 0010 and ADR 0012 are written,
*proposed* · **Method** the owner's checkout was only read
(`git diff`, `git status`, reading files); its status was the same before and after. The WIP
was copied into a detached scratch worktree of `d0fdee9`, compiled and run there with
targeted tests only (no full suite, no model, no recording), and the worktree was restored
clean afterwards. The adapted diff that makes the WIP green on `main` was kept outside the
repository; the code it holds is now carried by the revised plan's task 1. A second pass
re-applied that diff, re-ran the same targeted suites (144/144) and the owner's raw §9.2 property (0/400,
the guard), and probed `questionsOf` without its context (§2).

How to read the citations: `file:line` is on `main` at `d0fdee9` unless it says otherwise;
`plan:N` is a line of the owner's `docs/plans/stage-5-write.md` as written on `eee67d6`,
before it was revised in place (D15; the revised file says so in its header); `brief:N` of the owner's
`docs/stage-5-brief.md`; `review:N` of `docs/reviews/2026-09-23-deep-review.md`. Pull
requests are cited from `docs/roadmap.md` and the review's Status, since the rebase-merged
commits carry no number in their subject.

---

## 1. The state and the verdict

The owner's stage-5 work is the first two steps of task 1 of an eight-task plan, written on
`eee67d6` before `main` moved by 78 commits: two small modules created but not wired
(`catalogue.ts`, `seal.ts`), four test pieces written red (`catalogue-path`, `clear`, a grant
generator, the §9.2 idempotence property), a `.gitignore` line, the brief and the plan.
Nothing of `clear.ts`, `applyEdits`, the forge or the commands exists yet. **The verdict: the
plan's design holds and should be built — a real branch cut through git plumbing from `HEAD`,
one create-only `update-ref`, a `Cleared` value minted by re-running the free gates, a branch
name derived from the bytes, divergence proven against `HEAD` at the read and again at the
write. None of the owner's code is obsolete; every piece is kept, three need mechanical
adaptation to `main`'s shapes, and all of it has been measured green once adapted** —
green on the scenarios written, which do not yet cover core-plan-3's implied question: the
plan's `clearPlan` skips it (§2). What
must be redone is in the plan, not the code: `init --submit` (tasks 2 and 7) reads only the
root's `catalog-info.yaml` and would bring back the twin file and the capped `before` that
#82 removed; the git layer (task 3) was written for 13 rules and "no process in `src/`" and
would hand git the provider keys and the Backstage token; `init --backstage <url>` collides
with `main`'s boolean `--backstage`; and nothing yet says which repository a clearance is
for (gap-stage5-readiness-8). Four owner decisions the review left open were unmade, and
the plan and this check added fifteen more: nineteen in all (§7), settled by the owner on
2026-09-29.

---

## 2. The WIP code, piece by piece

| Piece | Verdict | In one line |
|---|---|---|
| W1 `src/core/paths/catalogue.ts` | **holds** | Drop-in for the iac-fs walker's inline rule; the rewire is 3 lines, measured green |
| W2 `src/core/plan/seal.ts` | **adapt** | Keep; finish the extraction in `sign.ts`; the seal alone is not a guard |
| W3 `tests/unit/catalogue-path.test.ts` | **holds** | 2/2 on `main` |
| W4 `tests/unit/clear.test.ts` | **adapt** | 7 compile errors, all shape drift; 9/9 pass once rebuilt |
| W5 `arbitraryGrantPlan` (arbitraries.ts) | **holds** | Applies cleanly; 400/400 schema-valid |
| W6 §9.2 idempotence (core.test.ts) | **adapt** | Trips its own vacuity guard on `main` (0/400); 400/400 once given a `Provenance` |
| W7 `.gitignore` `+/IaC` | **holds** | One line only; better in `.git/info/exclude` |
| W8 `docs/stage-5-brief.md` | **holds, as history** | A prompt for the planner, answered by the plan; its counts date from `eee67d6` (§3) |
| W9 `docs/plans/stage-5-write.md` | **adapt** | Tasks 1, 4-6, 8 adapt; tasks 2, 3, 7 are redone (§3); the file itself is §7 D15 |
| — `applyEdits` | **missing** | Imported by W6, written nowhere; the plan's 7 lines compile on `main` |
| — `clear.ts` | **adapt** | The plan's text compiles after one change (`checkPolicies` needs a `Provenance`), but compiling is not enough: `questionsOf` without its context skips core-plan-3's question |

### W1 — `catalogue.ts`: holds

`isCatalogueFolder(name)` and `isCataloguePath(relative)` compile unchanged on `main`. The
walker's rule is the same in substance: folders at `src/context/iac-fs/snapshot.ts:65`,
hidden files at `:77`, `YAML_EXTENSIONS` at `:22` and `:78`. Rewired in scratch — `:65`
becomes `!isCatalogueFolder(entry.name)`, `:77-78` become
`isCataloguePath(relative(root, full))`, `YAML_EXTENSIONS` goes — the catalogue-path, iac-fs,
iac-fs-provider, validate-command and architecture tests pass, 64/64. The architecture test
accepts `context/` importing `core/paths`.

**To do.** Carry it as is and do the rewire the plan asks for (P1 step 3). A third walker,
`src/context/fixtures/index.ts:10-24` (the demo SI), restates the folder rule but does not
skip hidden files: point it at `isCatalogueFolder` too, or say why it differs. The predicate
is about names; B3's symbolic-link rule is about a file's type and stays separate (§3, the B3 paragraph).

### W2 — `seal.ts`: adapt

It compiles and nothing imports it. `sign.ts` still has its private one-argument copy
(`src/core/plan/sign.ts:593-602`, used at `:507-508`, message `SEALED` at `:514`) and the
stale comment "Stage 5 hands a `SignedPlan` to a writer" (`:524`). With `sign.ts` importing
`seal.js` and passing `SEALED`, `tsc` is clean and sign, architecture and the adapted clear
test pass, 93/93.

Measured in plain Node: after the shadow-and-freeze, `Map.prototype.set.call(m, 'evil', 2)`
still inserts. The seal stops an accident, not a determined caller.

**To do.** Finish the extraction, move the §5.2 rationale from the deleted doc block to
`seal.ts`, fix the comment at `:524` to say a `SignedPlan` goes to `clearPlan`. Do not rely on
the seal as the forge's guard: see the runtime brand in §7 (D3).

### W3 — `catalogue-path.test.ts`: holds

2/2 with W1 copied in, and still 2/2 with the walker rewired. Its own comment
(lines 30-34) says it guards against drift and does not prove the walker calls the
predicate; that stays true.

**To do.** Carry it. Add the root `catalog-info.yaml` that `init platform` now scaffolds
into the declarations repository (`src/scaffold/layout.ts:60`; `REGISTRATION_FILE`,
`src/core/validate/registration.ts:33`; #86) to its nine paths, and a symbolic-link case
once B3 lands.

### W4 — `clear.test.ts`: adapt

`tsc` on `main` fails in seven places, all of them drift:

- `clear.js` is missing (8,8);
- `wordsOf` is no longer in `SignatureContext` (22,3): since `5107365`, provenance is
  `signPlan`'s third argument (`sign.ts:266-282`, `provenance.ts:46-62`);
- `PolicyContext` needs `over` and `namesakes` (31,7);
- two implicit `any`s (97,30; 149,45);
- the `RepositorySnapshot` cast fails, `RepositoryFile` now has `apis` and `ignored`
  (150,42; `src/core/validate/rules.ts:44-74`);
- the `@ts-expect-error` goes unused (183,5).

Rebuilt on `main`'s shapes — signing with `saidInFull(plan)` from
`tests/support/provenance.ts`, `over: new Map()`, `namesakes: namesakesOf([])`
(`src/core/plan/environment.ts:125`), `apis: []`, `ignored: []` — and run against the plan's
own `clear.ts` text (plan:816-996), **all nine scenarios pass**: the ghost-owner question,
the unwitnessed-folder refusal, "the whole plan or nothing", an already-stated plan giving
zero edits, the frozen and sealed result, the hand-built `Cleared` refused by the compiler,
and both `branchFor` cases.

**To do.** Keep all nine scenarios on the rebuilt fixtures, and add:

- a plan whose environment was answered clears, and the same plan under `nothingStated()`
  is refused (the provenance question, §7 D1);
- an `update-entity` of a right whose environment nobody answered is refused as a question
  left, as the preview asks it (core-plan-3; the context `questionsOf` needs, §2);
- an update whose consumer is already listed at another level is refused, not minted as an
  empty `Cleared` (#83's rule, §3 P1);
- a snapshot with `unreadable` set is refused by `clearPlan`, not left to the forge;
- a snapshot and contents that disagree (§3 P1, the two reads);
- a mixed plan (a `create-catalog-info` beside grants) is refused with its own reason, not
  "produced no change" (§5.3).

### W5 — `arbitraryGrantPlan`: holds

`arbitraries.ts` is unchanged since `eee67d6`; the hunk applies cleanly. At seed 42,
`planSchema` accepts 400/400 grant plans and `signPlan` refuses none. With no provenance
all 400 carry questions and change no byte; with the level and the environment answered at
their paths, 400/400 sign with no question and change bytes. The intent it builds is still
needed: a composed right name (`consumer-database`) is vouched for only by words whose
`wordsOf` is `'user'` (`provenance.ts:73-74`), now carried by `Provenance.intent`, not
`plan.intent`.

**To do.** Carry it; correct its doc comment (the level and environment are answered at
their paths by the test, not read from the intent). Batch B1 edits the same file and stays
on top of stage 5 (`docs/roadmap.md:70-73`); B1 builds on this generator rather than writing
a second one.

### W6 — the §9.2 idempotence property: adapt

It applies textually. With a scratch `applyEdits` it **fails its own vacuity guard: "expected
0 to be greater than 100"**, 0 of 400 exercised, where the owner's dry run at `eee67d6`
recorded 400/400. The cause is `5107365`: `grantContext = {...signatureContext, answered}`
sets a field `signPlan` no longer reads, the `echoing` intent rewrites `plan.intent`, which
no gate reads (`provenance.ts:17-21`), and a level or an environment is vouched for only by
an answer at its path (`sign.ts:384-428`). The guard did exactly its job.

Rebuilt with `asDrafted(plan) = userSaid(plan.intent, {...environmentsAnswered(plan), each
spec.access at operations.N.entity.spec.access})` passed as `signPlan`'s third argument, it
exercises **400/400** and `tests/invariants` is 15/15. `saidInFull` alone does not do: it
answers one fixed level, and the generator draws `read` and `readwrite`.

**To do.** Rewrite the hunk against `Provenance` as measured; keep the guard; update the
dry-run numbers in its comment; pass the `echoing` branch's words through `Provenance`. Add
the effect the review asked for (gap-stage5-readiness-11): the second pass's recheck reports
every operation already declared. `main`'s own `signatureContext` in this file still carries
the dead `wordsOf`/`answered` (`tests/invariants/core.test.ts:21, :31`); drop them here or in
B1.

### W7 — `.gitignore`: holds

The hunk applies at an offset of 3 lines. `main`'s `.gitignore` gained `.vitest/` and
`.traces/` since, so the owner's whole file must never be copied over. The line names the
owner's local IaC checkout, not a project path: `.git/info/exclude` is its better home, or
its own one-line commit outside the stage-5 stack.

### W8, W9 — the brief and the plan: history, and a plan to revise

`docs/stage-5-brief.md` is the prompt the plan answers (brief:1-15): its Q1-Q6 are settled
in the plan (plan:96-140), and its baseline — 790 tests across 54 files (brief:43), thirteen
architecture rules (brief:220) — dates from `eee67d6`. The repository keeps its briefs
beside what answered them (`docs/audit-brief.md`, `docs/stage-8-brief.md`,
`docs/backstage-http-brief.md`), so it can be committed as it stands, as a dated record.
The plan is the subject of §3; whether it is revised in place before stage 5 or committed
as written with this check as its erratum is §7 D15.

### `applyEdits` and `clear.ts`: missing, then adapt

`applyEdits` exists nowhere on `main`; the plan's seven lines (plan:803-810) compile appended
to `src/core/plan/edits.ts`, whose `FileEdit {path, before, after}`
(`src/core/diff/unified.ts:21`) and `planEdits(signed, before)` (`edits.ts:71`) are
unchanged. The plan's `clear.ts` compiles after one change: `checkPolicies(signed, context,
provenance)` now requires a `Provenance` (`src/core/plan/policies.ts:814-818`), so
`ClearInput` has to carry one or `SignedPlan` has to bind it (§7 D1). Everything else it calls
keeps a compatible signature (`questionsOf`, `clarify.ts:172`; `recheckPlan`,
`recheck.ts:181-185`; `DroppedOperation`, `edits.ts:57-60`), and `node:crypto` in `core/` is
allowed by the architecture rules.

A compatible signature is not the same gate, though. `questionsOf(plan, context = {})` finds
the signature's own questions from the plan alone, but core-plan-3's implied question — the
environment of the grant an `update-entity` extends (#79) — is raised only when
`context.natures` says the target is a right (`clarify.ts:233-265`, the test at `:240`). The plan's `clearPlan`
calls `questionsOf(signed.plan)` with no context (plan:891; `clearService` too, plan:1290), so it never asks it. Measured in
scratch: for an update of a right with no environment answered, `questionsOf(plan)` returns
0 questions and `questionsOf(plan, {natures})` returns 1, at `operations.0.environment`. A
plan whose preview stopped on that question would clear. `clearPlan` must build the same
`QuestionContext` `runPlan` builds (`plan.ts:1096-1104`: `environments`, `over`,
`declared`, `namesakes`, `natures`, `provenance`) — all of it is in `PolicyContext` and the
provenance of §7 D1.

---

## 3. The plan, task by task

The backbone (plan:96-140, the probes at plan:72-92) holds and nothing on `main` contradicts
it: design §10 already puts git in `forge/` (`docs/design.md:1209-1231`), §9.2 still lists
"applying twice == applying once" and atomicity (`design.md:1157-1166`), and the review's
gap-stage5-readiness-3 asked for exactly this base and this plumbing (review:1025-1032). The
probe table, the brief's counts (790 tests, 13 rules) and the 400/400 dry run all date from
`eee67d6`: `main` has 3683 tests (`AGENTS.md:22`), 139 test files and 19 rules
(`AGENTS.md:537`). Every count the plan asserts is re-measured in the pull request that
changes it.

Missing from all eight tasks: the repository's traceability rule — a CHANGELOG line, the
`docs/roadmap.md` edit and the review Status ids closed, in every pull request
(`docs/roadmap.md:529-535`; 0 hits in the plan).

### P1 — `Cleared` and `clearPlan`: adapt, with three additions

Holds: minting only through `clearPlan`, re-running the free gates rather than taking their
verdicts, refusing a drop as "the whole plan or nothing", byte-changing edits sorted by path,
`Expectation` with created paths absent, `branchFor` and the `seal`/`isCataloguePath`
extraction.

What moved, and what to change:

1. **Provenance.** `checkPolicies` needs one (`policies.ts:814-818`) and `questionsOf` takes a
   `QuestionContext` with `over`, `namesakes`, `declared` and `provenance`
   (`clarify.ts:71-99`). The plan calls both without (plan:890-900). A `SignedPlan` carries
   `plan`, `paths`, `refs`, `classified` (`sign.ts:74-81`), not the provenance it was signed
   with, so taking it through `ClearInput` would be taking it on the caller's word. §7 D1.
   Without that context `clearPlan` also skips the implied environment question of an
   update (§2, measured): it must pass `questionsOf` the context `runPlan` passes
   (`plan.ts:1096-1104`).
2. **#83's empty diff.** On `main` an empty diff exits 0 only when every operation other
   than a `create-catalog-info` has the recheck outcome `already-declared`; otherwise it is
   `unsupported`, exit 3 (`changedNothing`, `src/cli/commands/plan.ts:465-477`). The plan mints a `Cleared` with zero edits whenever
   nothing was dropped (plan:924-927), and the forge would call it `unchanged` on exit 0.
   `clearPlan` must refuse an empty change unless every outcome is `already-declared`.
3. **One snapshot, not two reads.** `readRepository` reads each file once
   (`iac-fs/snapshot.ts:84-106`) and `readContents` reads them again (`plan.ts:163-181`). The
   policies and the recheck judge the snapshot, the forge proves the contents. Inside
   `clearPlan`, rebuild `snapshot.files` from `contents` with the pure `repositoryFileOf`
   (`src/core/validate/rules.ts`), so the edits and the recheck judge the bytes the forge
   proves. *(Narrowed in review, 2026-09-29.)* The policies do not: their `PolicyContext` is
   built by `contextsOf` from the first read (`plan.ts:262-294`), and the rebuild compares
   paths, not bytes. Either build that context from the rebuilt snapshot, or state the window
   as what gap-6 still lacks.
4. **The repository role.** `Cleared.repository: 'declarations'`, set by `clearPlan` alone
   (§5).
5. **A runtime brand**, if the owner agrees (§7 D3): `mint()` registers in a module-private
   `WeakSet`; `isCleared()` is what the forge checks.
6. **The commit message.** `messageFor` puts `signed.plan.intent` in the subject
   (plan:982-995); on `main` that field is a record, not evidence (`provenance.ts:16-21`),
   and on `--from` it is the file's own words. Let the engine write the subject from the
   operations, carry the request in the body labelled as recorded, strip the bidi controls
   `plain.ts:119-128` treats as dangerous (a core-side copy), and cut by code point, not
   UTF-16 unit — no privileged script. This changes the owner's design of the message: §7 D18.
7. **A fourth copy of the gate sequence** (architecture-1, gap-stage5-readiness-10;
   review:984-991). `clearPlan` orders questions, policies, edits, recheck on its own, beside
   `runPlan`'s loop (`plan.ts:1037-1060`) and repair's. §7 D2.

### P2 — the service's `Cleared`: redo

Holds: the config moving to `core/schemas/config.ts` with a deterministic serialiser, a
committed config compared by value, `.idp-agent.yml` added only when a person typed one.

What moved: `init` no longer files at the root's `catalog-info.yaml`. `asCatalogInfo` keeps
one argument (`src/cli/commands/init.ts:333`), then `filedIn(op, target)` moves the
operation (`:339`, `:949`) to `targetOf`'s choice (`:584`) — the root's `.yaml`, else the
root's `.yml`, else the one catalog-info kept elsewhere — over every tracked catalog-info,
read whole outside the budget as `ProjectRead.declarations`, with tests and examples set
aside by `isSetAside` (`:567`, `:708-730`). `catalogInfoEdits` takes `{files: kept}` of
several paths (`:963`, `:1006`). The plan's `clearService` takes the root's file alone
(plan:1270-1331): on a service with a root `.yml`, or one nested catalog-info, that files a
twin at the root with `before = undefined`, which is the regression the queue item names.
`catalogInfoEdits` also skips an operation that does not materialise with a silent
`continue` (`init.ts:1026`) and has no effect check, where `planEdits` has both
(`edits.ts:183-191`; #45).

**Redo as:** move `asCatalogInfo`, `filedIn`, `targetOf`, `isSetAside` and `catalogInfoEdits`
— all pure — to `core/plan/catalog-info.ts`; `catalogInfoEdits` returns `{edits, dropped}`
under the same effect check as `planEdits`. `clearService(signed, {target, kept, existing,
config})` mints with `filedIn(asCatalogInfo(op), target)` from the same reading the preview
uses, with `repository: 'service'`, and refuses a drop. It re-runs `init`'s own verdicts
before any model: an unreadable own catalog-info is refused, a Component already declared
exits 0 with no branch, a target declaring another name asks it (`init.ts:718-760`; design
§7.3). Name the moved schema `repositoryConfigSchema`: `main` also has a personal
`config.yml` (`cli/personal.ts`) with its own `backstage` and `repo`. Tests: a root `.yml`, a
single nested catalog-info, a monorepo with several.

### P3 — the `forge/` layer: redo

Holds: `provider.ts` as types only (`Base`, `Submitted`, `ForgeProvider` with no merge, no
delete, no caller-chosen name), `ForgeInputError` on exit 2, the hardening flags
(`core.hooksPath=/dev/null`, `core.fsmonitor=false`), `GIT_*` scrubbed, and the new rules
"`core/` may not import `forge/`" and "only `cli/` reaches `forge/` at runtime", which
`main` still lacks.

What moved:

- `PATTERNS` is already repaired (`tests/architecture/dependencies.test.ts:39-42`); drop the
  step.
- There are 19 rules, not 13. A git process already runs in `context/project-fs/snapshot.ts`
  under the `SPAWNS` registry (`dependencies.test.ts:322`), with "only the named modules
  write, and only one starts a process" (`:541`) and "every process `src/` starts is given
  `spawnedEnvironment`" (`:663`). The plan's "only `forge/local/git.ts` starts a process" is
  false on `main`.
- `scrubbed(env)` removes only `GIT_*` (plan:1746-1760): git and anything it runs would get
  `IDP_BACKSTAGE_TOKEN` and every `*_API_KEY`, against ADR-0011
  (`docs/adr/0011-backstage-to-explore.md:23`), `SECURITY.md:153` and the rule at `:663`.
- `gitIn` sets no `cwd` and no bound (plan:1761-1768). `main` starts git from Node's own
  directory (`NEUTRAL_DIRECTORY`, `project-fs/snapshot.ts:422`, `:436`) because Windows looks
  a program up in the working directory first — a `git.exe` at a repository's root would run
  — and bounds each call (`GIT_LIMITS`, `:377`). A user will often run `--submit` from inside
  the repository.
- A rule over a missing folder now fails (#88): the `forge/` rules land with `forge/`.

**Redo as:** one hardened git launcher shared by `project-fs` and the forge —
`spawnedEnvironment()` minus `GIT_*`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`,
`GIT_OPTIONAL_LOCKS=0`, `--no-pager`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
the neutral `cwd` with `-C`, a timeout and an output cap. Where it lives is §7 D10. Then
`SPAWNS` still names one spawner and "only one starts a process" stays true. `GitError`'s
stderr is printed through `inertLine`. Add `forge/` to the `core/` import ban, make `core/`'s
disk rule transitive, see each new rule fail on a probe, and recount from 19. Test: a `git`
executable planted at the repository root never runs.

### P4 — the local forge: adapt

Holds: `blobId`, `treeOf`, `writeTree` (keeps `100755`, refuses a file-as-folder),
`openLocalForge` refusing a non-worktree, a non-root and a missing git; `base()` refusing a
detached or unborn `HEAD`; `diverges()` refusing symlinks and, in catalogue scope, any
catalogue blob never read; `submit()` re-reading the base, re-checking divergence, enforcing
the `idp-agent/` prefix and `check-ref-format`, one create-only `update-ref`, and race
recovery that tells its own commit from a stranger's; `hash-object --stdin --no-filters`.
The fault-injection invariant over real repositories is the right proof of atomicity.

To change:

- **The fixture** signs with `eee67d6`'s `SignatureContext {wordsOf, answered}` and builds
  `PolicyContext` by hand without `over`/`namesakes`. Take both from `contextsOf` and a
  `Provenance`. `runInitPlatform` now also commits a root `catalog-info.yaml` Location
  (#86): add a case where it is in `HEAD`.
- **The role.** `openLocalForge(root, role)`; `submit()` refuses a `Cleared` of the other
  repository before anything else. Test both cross-wirings (§5).
- **A squatted parent.** `existing()` accepts an existing branch as ours when it is one
  commit on one parent touching exactly our paths with our blobs (plan:2397-2420), but never
  checks that the parent is the base. Branch names are predictable; someone who can create
  refs can put our files on top of a parent carrying an unrelated change, and it would be
  reported `already-submitted` on exit 0 — and at stage 6 that change would travel under this
  user's request. Require the parent to equal `at.commit` (§7 D7).
- **The committer identity.** `commit-tree` needs one, and the scrub removes
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`; today its absence surfaces after the paid model run as a
  generic exit 1 (plan:2463). Probe `git var GIT_COMMITTER_IDENT` in `openLocalForge`, exit 2
  with a named remedy, before any model — and run git with `user.useConfigOnly=true`: with no
  `user.name`/`user.email` configured, git 2.46 guessed one from the login and host names and
  the probe exited 0 (measured in review of this report, 2026-09-29).
- **Recompute, don't trust.** The forge recomputes `branchFor(edits, label)` and checks it
  equals `change.branch`.
- **Limits stated.** Working-tree bytes differing from the `HEAD` blob through
  `autocrlf`/CRLF are refused as divergence. `tests/invariants/forge.test.ts` removes its
  temporary repositories in `afterAll` and runs targeted, never in a full run: the owner's
  machine is short of disk and swap.

### P5 — `plan --from … --submit`: adapt

`plan.ts` is 1509 lines now: `CLOSING` at `:71`, `renderPreview` at `:608` with an `apply`
option and #83's exit-3 path, `runPlan` as `declarationsRoot`, `readRepository`, `loadPlan`,
`readContents`, then `contextsOf(root, snapshot, contents, graphOf(snapshot))`
(`:1037-1043`), and `renderRefusedAnswer` already exported (`:849`). Re-derive the wiring
there.

- The root comes from `declarationsFor`'s chain — `--repo`, the working directory on its
  markers, `IDP_REPO`, the personal file's `repo`, never a Backstage catalogue
  (`src/cli/source.ts:225-290`; #93) — not only `--repo`. Require the *resolved* root to be a
  worktree root, and let the line stderr already prints say which link named it. Refuse
  `--submit` under `--demo` or when nothing resolves. The plan required `--repo` itself
  (plan:103-104); which links may name the repository a branch is cut in is §7 D19.
- `--submit` goes into HELP's `plan` lines so `usageOf` prints it (`index.ts:542-556`), and
  HELP's "none of them writes" changes.
- The `--json` `submission` key: §7 D11.
- `#83`'s exit 3 for an unaccounted empty diff comes before any forge call.
- The confirmation (Q4) holds: `[y/N]` on stderr, no by default, `--submit` as the only verb,
  the flag as the confirmation without a TTY or with `--json` (ADR-0006, design §4.2). `Confirm`
  should take a structured summary (paths, counts, branch), not text (§7 D5).
- Without `--submit`, the preview stays byte-identical, `CLOSING` included.

### P6 — `plan "<intent>" --submit`: adapt, smaller than planned

`runIntent` (`plan.ts:1267-1310`) already reads the contents before `inspect()` (`:1297`,
"Before the Inspector too"), so the move is done. Place `openForSubmission` and
`refuseDivergence` right after `readContents`, before any model. Rebuild the `answering('read')`
tests on path-keyed answers and add one where the environment is answered, not named. Keep
the three scenarios: the same branch as `--from`, a divergent repository refused with
`client.seen` empty, the application repository byte-identical. Scripted clients only: no tape
changes, and `IDP_RECORDING=record` is never used.

`idpa "<phrase>"` (`package.json:29-31`; design §7.4) routes a change to `plan` after a
Supervisor call. Whether it takes `--submit` at stage 5 is §7 D8.

### P7 — `init --submit` and `.idp-agent.yml`: redo

- **Where it files.** Drop `readCatalogInfo` (plan:3677-3694). The divergence expectation, in
  `'touched'` scope, names `targetOf`'s file (its `before`, or absent) plus every kept
  declaration the "already declared" and name decisions read, plus `.idp-agent.yml` — never
  `CATALOG_INFO` by name (§5.2).
- **The order.** `main` reads the declarations inside `readProject` (tracked catalog-infos
  plus the root's, read with `O_NOFOLLOW` in `context/project-fs/snapshot.ts:750`; used at `init.ts:708-730`). So: the config questions,
  `readProject`, the forge and `refuseDivergence`, then the Inspector — still before any
  model.
- **The flags.** `--backstage` is a global boolean that "takes no value, since a URL typed on
  a command line would send the token to whatever was typed" (`src/cli/index.ts:805`, `:832`;
  design §7.0), ADR-0011 refuses a URL from the command line, and `.idp-agent.yml`'s
  `backstage:` "is never requested" (`SECURITY.md:161`). `init --backstage <url>`
  (plan:208, :3588) cannot stand. `--env` is `graph`'s filter (`index.ts:460`). §7 D9.
- **The tail.** The preview now ends on `APPLY` — "`idpa init > catalog-info.diff`, then
  `git apply`" (`init.ts:985`). With `--submit` the submitted lines replace it; without,
  `init`'s output stays byte-identical.
- **A service in a subfolder.** `main`'s `init` supports one; the forge requires a clone's
  root. §7 D12.
- Keep the stated limit: the Inspector reads the uncommitted working tree.
- `renderRefusedAnswer` is already exported: drop that step.

### P8 — the documents: adapt, and spread

- **ADR numbers.** 0008 and 0009 are taken; see §6.
- **Contradictions already closed.** #1 (design §10's `core/git`) is done on `main`; #7's
  `SECURITY.md` "stage 1 of 7" is now "stage 4 of 7" (`SECURITY.md:6`, #78). The rest still
  stands: §8's "full rollback" (`design.md:1146`), `catalog-info.yml` in `design.md:13`, the
  comments in `src/scaffold/write.ts:7` and `src/scaffold/README.md:17`, `AGENTS.md:171`'s
  "only writer".
- **Stale baselines.** 19 rules, not 13. The writers are `scaffold/write.ts`,
  `cli/recording-fs.ts` and `cli/trace-sink.ts` (`dependencies.test.ts:546-552`), the forge
  a fourth through git: "two writers" is already false.
- **SECURITY.md** as edits against `main`'s text: stage 5 of 7; a submission under "Writes
  nothing, except" (`:34`); the "check at the moment of writing" item (`:218`) moves to
  Guaranteed with its tests; new rows — one create-only ref, atomic under faults, hooks never
  run, `GIT_DIR` cannot redirect, no key or token reaches the forge's git, a clearance for the
  wrong repository refused, a symlinked catalogue file refused at submission though the
  preview still reads through it (until B3) — and the `--from` road worded by route (§7 D4).
- **Design §4.3** (gap-stage5-readiness-12): "two concurrent declarations never write the
  same file" (`design.md:173-175`) is false for `update-entity`; reword it — two branches
  amending one grant conflict at the merge, and the merge request is where that is seen.
- **Design §9.2** defines "initial state" as the observable state, as the plan says.
- **Spread it.** Each document edit lands in the pull request that makes it true, not in a
  final documents PR: the traceability rule already asks every PR for its CHANGELOG,
  roadmap and review-Status lines.

### Revised order

One pull request per task, stacked, merged bottom-up with `--rebase`, as the plan and the
repository's habit both say. The three merge groups stay.

| # | Pull request | Group | From the plan | Needs first |
|---|---|---|---|---|
| 0 | This check and ADR 0010 (proposed) | — | draft-0008, rewritten | the owner's reading |
| 1 | `Cleared` for the declarations repository: `clear.ts`, `applyEdits`, W1-W6 adapted, `sign.ts` and iac-fs rewired | 5a | P1 | D1, D3, D6 decided |
| 2 | `core/plan/catalog-info.ts` and the service's `Cleared` | 5a | P2, redone | D9 decided |
| 3 | The shared git launcher and the `forge/` types and rules | 5b | P3, redone | D10 decided |
| 4 | The local forge | 5b | P4 | D7 decided |
| 5 | `plan --from … --submit` | 5c | P5 | D4, D5, D11 decided |
| 6 | `plan "<intent>" --submit` | 5c | P6 | D8 decided |
| 7 | `init --submit` and `.idp-agent.yml` | 5c | P7, redone | D12 decided |

Documents travel with each row; what is left of P8 (design §4.3, the ADR index, ADR-0003 and
ADR-0006 amendments) goes with #7 or with #0 where it is decision rather than code.

**B3** (physical confinement; `docs/roadmap.md:74-77`) is not needed by the writer: the forge
writes git objects and one ref and never touches the working tree (plan:2440-2470), and
`diverges()` refuses a symlink tracked in `HEAD` and any path absent from it, so a linked file
the walk followed cannot reach a branch. B3 stays where the queue has it, after stage 5, for
the read side — iac-fs following a link into a preview or a prompt — and for
`scaffold/write.ts`. #4 carries one test proving a linked file in the working tree never
reaches a submitted blob. If the owner wants the preview and the submission to refuse the
same files, B3 moves to just before #5; that is the one place it would earn its keep (§7 D17).

---

## 4. The review's stage-5 readiness findings

| Id | Finding (review:1673-1686) | Status | Where |
|---|---|---|---|
| gap-1 | "nothing to change" on exit 0 when the surgery missed | **fixed by `main`** | #45; `planEdits` guarantees its effect (`edits.ts:30-45`). `clearPlan` must also mirror #83's empty-diff rule (§3 P1.2) |
| gap-2 | `repoPath` a free path | **fixed by `main`** | #90; `isCatalogInfoPath` (`schemas/plan.ts:327-336`) |
| gap-3 | preview on the working tree, branch from `HEAD` | **covered** | Base is `HEAD`, divergence proves the read bytes equal its blobs (plan:111-127, :2356-2385) |
| gap-4 | lexical confinement on the declarations side | **covered at submission; preview left to B3** | `diverges()` refuses symlinks and unread paths; B3 queued after stage 5 |
| gap-5 | the brand is forgeable by a cast | **partly covered** | Brand plus freeze; a spread still type-checks, the seal is bypassable. §7 D3 |
| gap-6 | nothing detects a change between preview and write | **covered, with one gap** | Divergence at the read and inside `submit()`, create-only ref; the two reads (snapshot, contents) must become one for the edits and the recheck; the policy context still comes from the first (§3 P1.3) |
| gap-7 | `writeNew` cannot modify, rename, delete | **fixed by `main` for the list (#90); moot for the forge** | The forge writes through git, not `FileIO` |
| gap-8 | two repositories; `before` from a capped snapshot | **`before` fixed by `main` (#82), identity missing, and the plan regresses the `before`** | §5 |
| gap-9 | one transitive rule; no writer restriction | **fixed by `main`** | #88; the plan's P3 conflicts with it and is redone |
| gap-10 | `--from` crosses four gates | **missing** | §7 D4 |
| gap-11 | idempotence would pass a writer that writes nothing | **partly covered, broken on `main`** | W5/W6 with a vacuity guard; 0/400 until rebuilt on `Provenance`; the effect assertion to add; B1 |
| gap-12 | no plan identity; §4.3 false for `update-entity` | **identity covered, §4.3 missing** | `branchFor` (plan:960-975); reword §4.3 (§3 P8) |
| gap-13 | confirmation and result seams | **partly covered** | `Confirm` seam in the plan; no structured preview. §7 D5 |
| gap-14 | documentation drift | **fixed by `main` (#89)** | The plan's P8 still lists contradiction #1, now closed |

Neighbouring ids the plan inherits by re-running the gates, all closed by #90: wip-diff-1 and
-4 (an operation vouching for itself, or for a Component the edits drop), core-plan-10 (every
dispatch switches exhaustively; `edits.ts:109-111`, `sign.ts:500-505`). Any new dispatch —
`clear.ts`, `catalog-info.ts`, the `Submitted` renderer — keeps that rule. core-plan-9 is
gap-5 (§7 D3). architecture-1 is gap-10's sibling (§7 D2).

---

## 5. Which repository a clearance writes to, and where `init` files

### 5.1 The problem today

A `FileEdit` is `{path, before, after}` (`src/core/diff/unified.ts:21`). `init`'s edits name a
file in the service's repository, `plan`'s one in the declarations repository, and nothing in
the value says which. The plan leaves it implicit in which forge receives the `Cleared`; its
only hint is `Expectation.scope`, `'catalogue'` or `'touched'`. Since #86 it is worse: the
declarations repository has its own root `catalog-info.yaml`, so the same path names a file in
both. A service `Cleared` — `{catalog-info.yaml: absent}`, `'touched'` — handed to a forge
opened on the declarations repository passes `diverges()` whenever that repository has no
root `catalog-info.yaml` yet, and cuts a branch adding a service's catalog-info and
`.idp-agent.yml` to the IaC repository.

### 5.2 The proposal

1. **The identity goes on the value that crosses to a forge, not on every `FileEdit`.**
   `Cleared.repository: 'declarations' | 'service'`, set by `clearPlan` and `clearService`
   alone. The scope follows from it and stops being a free field: `declarations` always
   checks in catalogue scope, `service` in touched scope. `FileEdit` stays as it is; it is a
   diff, and the diff renderer and `planEdits` have no use for a role.
2. **The forge is opened for one role.** `openLocalForge(root, role)`; `submit()` refuses a
   `Cleared` of the other role first, with exit 2 and a sentence naming both. Tests cross the
   wiring both ways.
3. **`init` files where it previews.** `clearService` mints from the same reading the preview
   uses: `targetOf` over `ProjectRead.declarations` less `isSetAside`, and
   `filedIn(asCatalogInfo(op), target)`, with the kept declarations as the befores, read whole
   outside the budget as #82 made them. `asCatalogInfo` keeps its one argument. The service
   expectation names the target's bytes (or its absence), every kept declaration read, and
   `.idp-agent.yml`. No `readCatalogInfo`, no `CATALOG_INFO` as a path in stage-5 code.
4. **A mixed plan is refused by name.** `planEdits` drops every `create-catalog-info` as
   "writes into the service repository" (`edits.ts:309-313`), and "the whole plan or nothing"
   would refuse a plan carrying one beside grants as "produced no change" (plan:906-913) —
   true but misleading, since the preview accounts for that operation (`plan.ts:467-475`).
   `clearPlan` refuses it with its own reason: this plan writes into two repositories; the
   service's catalog-info goes through `init --submit`. Two `Cleared`s from one plan is the
   alternative, and it is not worth its cost at stage 5 (§7 D6).
5. **Recorded** in ADR 0010, and the roadmap item and gap-stage5-readiness-8 closed in the
   pull request that ships #2 and the forge's role check.

---

## 6. ADRs

The plan's two ADR drafts are called here by the number the plan gave them, draft-0008 and
draft-0009, so they are not taken for the decisions D1-D19 of §7.

| Draft | In the plan | Becomes | Why |
|---|---|---|---|
| draft-0008 "a submission is a create-only ref" | plan:3868-3900, as ADR-0008 | **ADR 0010** | 0010 is reserved for this check (`docs/roadmap.md:208`; `design.md:1306`), and the queue says its ADR becomes 0010 |
| draft-0009 "declared is not provisioned" | plan:3906-3960, as ADR-0009 | **0012**, *proposed* (§7 D16, the owner's default); stage 8's evidence ADR takes the next free number | Its mechanisms are only proposed and belong to stage 6 and after |

`main` holds 0008 (commentary crosses, labelled), 0009 (tracing renders the event stream) and
0011 (Backstage to explore). Every cross-reference in P8 moves with the numbers: ADR-0003 and
ADR-0006 amendments "(ADR-0008)", design §4.4 "(ADR-0009)", the `AGENTS.md` open questions,
and the index at `design.md:1294-1308`.

**ADR 0010** keeps draft-0008's body — a real branch through `hash-object`/`mktree`/`commit-tree`, one
`update-ref <ref> <commit> ""`, nothing checked out, hooks off, the working tree never written
— and adds what this check decides: the repository role on `Cleared` and the mixed plan (§5);
the parent-equals-base rule; the runtime brand if chosen; the base as `HEAD` with the read
bytes proven equal; the provenance bound to the signature; the `--from` road's gates by route;
B3's status (not a prerequisite of the writer); and today's counts in place of the brief's.

**Conflicts with ADRs merged since:**

- **0011.** draft-0008 says "hooks disabled and `GIT_*` scrubbed" and nothing of the token or keys;
  ADR-0011 forbids the token "into a child process" (`0011-backstage-to-explore.md:23`). ADR
  0010 says git runs in `spawnedEnvironment` minus `GIT_*`. draft-0009's reconciler "publishes the
  result as the entity's status in Backstage"; ADR-0011 makes one GET-only transport the only
  code that sends the token. draft-0009 must say the reconciler is a separate component with its own
  credential, or record an amendment to ADR-0011.
- **0008, 0009.** No conflict. A `--submit` run traces like any other.
- **0006** ("the merge request is the act of authorisation") is what makes the `--from` road
  defensible (§7 D4) and what the parent-equals-base rule protects.

draft-0009's `BRANCH_PROTECTION` line still has its home (`init.ts:60`) and keeps its test.

---

## 7. Decisions for the owner — settled 2026-09-29

The owner settled all nineteen on 2026-09-29. Four were chosen explicitly: **D1** (a), the
provenance sealed into the `SignedPlan` by `signPlan`, never passed in; **D3**, a runtime
brand on `Cleared`, a module `WeakSet`, the forge refusing any other object; **D6**, a plan
writing into both repositories refused by name, pointing at `init --submit`; **D15**, the
brief committed as it stands, dated, and the plan revised in place. For the other fifteen the
owner took the recommendation below as the default, open to change. The *Settled* column
says which.

| # | Decision | Recommendation | Settled |
|---|---|---|---|
| D1 | Which provenance `clearPlan` re-runs the policies against: (a) `signPlan` binds a sealed copy into `SignedPlan`, or (b) `ClearInput.provenance`, taken on the caller's word | **(a).** The gates then judge exactly what was signed, which is why `Cleared` exists. Test: a mismatched provenance cannot clear a plan the policies refused | **chosen: (a)** |
| D2 | One `evaluatePlan()` for every road before 5a, or a parity test | **A parity test in #1** — every preview that ends on a diff and exit 0 clears; every preview refusal refuses — and keep "One evaluation for every route" in its owner queue (`roadmap:492-494`). Extracting it first would block stage 5 on a refactor | recommended, the owner's default |
| D3 | A runtime brand for `Cleared` (gap-5, core-plan-9) | **Yes**: a module-private `WeakSet` in `clear.ts`, `isCleared()` checked by `submit()`. A spread, a cast or `structuredClone` then cannot put arbitrary bytes on an `idp-agent/` branch. ADR 0010 says the Reviewer is not re-proved and the merge authorises | **chosen: yes**, a module `WeakSet` |
| D4 | `--submit` on `--from`, which has no Reviewer (gap-10) | **Allow it**, worded by route in `SECURITY.md`, the help and ADR 0010: `--from` crosses four gates and still cannot reach the default branch; the merge authorises (ADR-0006) | recommended, the owner's default |
| D5 | Freeze the confirmation now, or after a session ADR (gap-13, architecture-9) | **Now, but structured**: `Confirm` takes a summary (paths, counts, branch), not text, so stage 7 can reuse it. The session ADR is not a blocker | recommended, the owner's default |
| D6 | A plan that writes into both repositories | **Refuse it by name** and point at `init --submit`; revisit at stage 6 | **chosen: refused by name** |
| D7 | Our files on a branch whose parent is not the base | **Refuse**, naming the old base. Never `already-submitted` on another parent | recommended, the owner's default |
| D8 | `idpa "<phrase>" --submit` at stage 5 | **Not yet**: exit 2 pointing at `plan "<intent>" --submit`. When it comes, divergence is refused before the Supervisor | recommended, the owner's default |
| D9 | `backstage:` in `.idp-agent.yml` written by `init --submit` | **Do not write it at stage 5.** Keep `--iac-repo`; name the environment flag so it cannot be read as `graph`'s `--env` (for example `--environment`). Never give `--backstage` a value | recommended, the owner's default |
| D10 | Where the shared git launcher lives | **A small leaf module** holding `spawnedEnvironment` and the launcher, imported by `context/project-fs` and `forge/local`; `SPAWNS` still names one spawner. The alternative, letting `forge/` import `context/`, breaks the plan's own layering | recommended, the owner's default (the plan names it `src/process/`) |
| D11 | `--json`'s `submission` key before cli-ux-10's versioned report | **Add the key** with a test pinning its shape, and list it in cli-ux-10's item. Versioning stays that item's | recommended, the owner's default |
| D12 | `init --submit` for a service in a monorepo subfolder | **Refuse with exit 2 at stage 5**, saying so; prefixed paths are a follow-up | recommended, the owner's default |
| D13 | Whether `GIT_AUTHOR_*`/`GIT_COMMITTER_*` are honoured | **No**: scrubbed like every `GIT_*`; the identity comes from git's config, never guessed (`user.useConfigOnly`), probed before any model | recommended, the owner's default |
| D14 | The `/IaC` line | **`.git/info/exclude`**, not the project's `.gitignore` | recommended, the owner's default |
| D15 | The plan file (W9) and the brief (W8) | **Commit the brief as it stands, as a dated record**, as the other briefs are; **revise the plan in place in #0** — tasks 2, 3 and 7 rewritten, the others amended by §3 — rather than commit it as written with this check as its erratum: the implementer of #1-#7 reads one document, not two that disagree | **chosen**: the brief committed as it stands, dated; the plan revised in place in #0 |
| D16 | draft-0009 "declared is not provisioned": an ADR at stage 5, or a stage-6 design note | **ADR 0012, status *proposed***, landed with #7 or #0: the stage-5 edits the plan writes cite it — design §4.4 and §13, `init`'s `BRANCH_PROTECTION`, `AGENTS.md`'s open questions (plan:3958-3972, :4012-4014), and it must first say its reconciler holds its own credential (§6, ADR-0011). The alternative, a stage-6 design note, is sound too — its mechanisms are all after stage 5 — but then those citations change | recommended, the owner's default: ADR 0012, *proposed*, written in #0 with its own credential |
| D17 | B3 before the submission, or after stage 5 as queued | **After stage 5**, as `docs/roadmap.md:74-77` has it: the forge never writes the working tree and refuses a symlink tracked in `HEAD` (§3, B3). Note the roadmap's own words, "what stage 5's writer will need" (`:77`): if this is taken, that sentence changes in #0 | recommended, the owner's default; the roadmap sentence corrected in #0 |
| D18 | The commit subject: the request, as the plan has it, or engine-written from the operations | **Engine-written**, the request in the body labelled as recorded (§3 P1.6): `plan.intent` is not evidence on `main`, and on `--from` it is the file's own words | recommended, the owner's default |
| D19 | Which links may name the repository `--submit` cuts a branch in: `--repo` only, as the plan says, or `declarationsFor`'s whole chain | **The whole chain**, with the stderr line naming the link and the resolved root required to be a worktree root; the confirmation shows the root. The alternative, `--repo` only, is safer against a stale `IDP_REPO` and costs one flag per run — a reasonable choice too | recommended, the owner's default |

D1, D3 and D6 shape `Cleared` and were needed before #1; D15 was needed for #0. All four are
settled, and the others are the owner's defaults before the pull request that names them in
§3; changing one is a dated decision in `docs/roadmap.md`.

---

## 8. What is recommended next

**First, #0:** this document, and ADR 0010 written as *proposed* from draft-0008 and §5-§7, in one
pull request once the owner has read them and settled D1, D3, D6 and D15 — with the plan
revised in place if D15 is taken. *Done as settled on 2026-09-29: D15 was taken, so #0 also
carries the plan revised in place, the brief as a dated record, and ADR 0012 (D16).*

**Then the first pull request of stage 5, #1 — `Cleared` for the declarations repository.**
A new branch from `main` (the owner's `feat/s5-cleared` stays where it is; nothing of it is
thrown away, and its pieces are carried over with the owner as author of what they wrote),
holding:

1. `src/core/paths/catalogue.ts` as written, and `src/context/iac-fs/snapshot.ts` rewired to it
   (3 lines, measured green); `tests/unit/catalogue-path.test.ts` as written plus the root
   `catalog-info.yaml` case.
2. `src/core/plan/seal.ts` as written, and `sign.ts` importing it, its private copy removed,
   its stage-5 comment corrected.
3. `applyEdits` in `src/core/plan/edits.ts`, with its README row.
4. `src/core/plan/clear.ts` from the plan's text, with the provenance bound by `signPlan`
   (D1), `questionsOf` given the context `runPlan` gives it (core-plan-3's question), the
   runtime brand (D3), `repository: 'declarations'`, #83's empty-diff rule, one
   snapshot rebuilt from the contents, the mixed plan refused by name (D6), and an
   engine-written subject.
5. `tests/unit/clear.test.ts` rebuilt on `main`'s shapes (9/9 measured) plus the five cases in
   §2 W4, and a parity test against the preview (D2).
6. `arbitraryGrantPlan` as written, and the §9.2 property rebuilt on `Provenance` (400/400
   measured) with the effect assertion.
7. The CHANGELOG line, the roadmap state, and the review Status for gap-stage5-readiness-11
   (in part) and -5 if D3 is taken.

The adapted diff that already makes items 1, 2, 3, 5 and 6 green on `d0fdee9` is the starting
point; the revised plan's task 1 carries its code. Item 4's additions are new and are written test first. Before merging, the targeted
suites — `tests/unit/clear.test.ts`, `catalogue-path`, `sign`, `tests/invariants`,
`tests/architecture`, the iac-fs and validate tests — then one full run if `df -h /` shows at
least 2 GiB free (3.0 GiB at the time of the second pass).
