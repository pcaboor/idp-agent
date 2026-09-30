# Stage 6 — a GitHub pull request, with the person's own git and gh

**Status: 6.1.1 built ([#123](https://github.com/pcaboor/idp-agent/pull/123)); the rest planned.** The owner's answers to the note's § 18 (22 decisions) and
§ 19 (Q1–Q4) were settled on 2026-09-30, each as recommended, and this plan takes them as
given; so were the four questions the plan itself asked, the same day ([Questions for the
owner](#questions-for-the-owner)). Eleven stacked pull requests: ten, 6.1.1 to 6.4.2, then 6.4.3, the owner's step: every tape
recorded before 2026-09-30 re-recorded with the owner's key, never by an agent; on our side it is
the scenario tests that pin the tapes (`prompt-digests.test.ts`'s `SENT` re-measured, its
`FIRST_SENT` unchanged, two guards; Task 6.4.3 says why this is not documents only), the roadmap
and `CHANGELOG.md` lines, and its pull request carries the tapes the owner recorded.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

**Goal.** In a clone whose checked-out branch tracks a branch on github.com, with `gh` installed
and logged in to github.com as a person, `plan --from … --submit`, `plan "<intent>" --submit`,
`init --submit` and `idpa "<phrase>" --submit` cut stage 5's local branch, push that very commit
create-only to the same `idp-agent/…` name on GitHub with the person's own git, and open one pull
request into the tracked branch with the person's own gh; they recognise, before anyone is asked,
a submission already made on this base or an older one; they refuse to submit where the base
branch's ruleset would let the opener merge without someone else's approval of the latest
commit, read before anything is written and again at the moment of acting; and they print the
pull request's URL, built by the engine. idpa reads, stores and sends no GitHub credential, and
runs only an explicit list of git and gh command shapes, checked at run time on the final
argument vector and by architecture rules in the source.

**The design** is [`docs/stage-6-brief.md`](../stage-6-brief.md) (the note below): § 3 the flow,
§ 4 the push, § 5 credentials, § 6 the allow-list, § 7 the hostile repository, § 8 the run-time
check, § 9 without gh, § 10 the negative test, § 12 what reaches a model, stdout and traces,
§ 13 the remote and the base, § 14 idempotence, § 15 failure and bounds, § 16 the slices. Every
file, function and line named below was read on `main` at `2b2250e`; the note cites `55fb995`,
and [Where the code moved since the note](#where-the-code-moved-since-the-note) says what differs.
`backstage-http` slice 2 landed on `main` after `2b2250e` (#119, #120 and its third pull
request): it adds architecture rules (26 after #120), so every task re-counts them rather than
trusting a figure here, and it owns ADR-0013 and ADR-0014, so stage 6's ADR is **ADR-0015**, as
the note has said since #119.

**Closed by.**

| Slice | Closed by | What the owner sees |
|---|---|---|
| 6.1 | 6.1.3 | `idpa protection --repo ~/idpa-live` exits 1 before the ruleset exists, printing the ruleset to add; 0 once it does; 2 with gh logged out. Offline first: `pnpm demo:github` shows the same three answers against the fake gh. No model, no write, no recording |
| 6.2 | 6.2.2 | `idpa plan --from examples/open-network.json --repo ~/idpa-live --submit` pushes with the owner's git, opens a pull request, prints its URL; run again, names the same pull request and writes nothing. GitHub's page says merging is blocked until an approval |
| 6.3 | 6.3.1, then 6.3.3 | from a directory whose `.idp-agent.yml` names the throwaway repository, `idpa plan "<intent>" --submit` opens a pull request there; 6.3.3 the same from `idpa "<phrase>" --submit` |
| 6.4 | 6.4.1 | `pnpm test:live:github` passes with the owner's gh and the second account's, every door refused and step 5 made; the recorded answers are committed with their three hand-filled fields |

**Architecture.**

**6.1, the fence and the check.** `process/` gains a second launcher, `process/gh.ts`, held to
`process/git.ts`'s shape (`execFile`, no shell, a neutral working directory, a timeout, an
output cap, an environment built from `spawnedEnvironment`), and both launchers check the
finished argument vector against a grammar before any process starts: git's is stage 5's shapes
plus three reads and the one push form of § 4, gh's is `--version`, eight `GET` templates and one
`POST`. Architecture rules name the two process starters, the door strings no source may hold,
the credential names no source may read from an environment, and the one folder that loads the
gh launcher. `tests/setup/forge.ts` is the offline floor for child processes, and the fake gh is a
GitHub model the tests inject as `MainDeps.gh`. 6.1.2 reads the remote the checked-out branch
tracks, parses its URL in `core/github/`, refuses a hostile repository configuration key by scope,
and asks gh who it is. 6.1.3 reads the rules (§ 8, items 1 to 5), judges them in `core/github/`,
and ships `idpa protection`, which is also the one list of settings `init platform` prints.

**6.2, the GitHub forge on `plan --from`.** `forge/github/forge.ts` wraps the local forge as one
`ForgeProvider` of `name: 'github'`: `base` and `diverges` are the local forge's; `recognise` asks
the local forge, then GitHub (the ref, its commit, the pull requests from it); `submit` re-checks
at the moment of acting (§ 3 step 8), cuts the local ref, pushes the exact commit with the lease,
reads the ref back, reads the rules once more and opens the pull request. `treeFor` in
`forge/local/` computes a tree without writing one, for a branch GitHub holds and this clone does
not, and for the older base of § 14. 6.2.2 wires it into `plan --from --submit`: the road table
of § 13, `--local`, the refusal without gh, the confirmation naming the push and the pull request,
the closing lines with the engine-built URL, `--json`'s `pullRequest`, and `SECURITY.md`'s two
authorisation items moved to *Guaranteed*.

**6.3, the three other roads.** The intent road opens the forge, reads the road and gh's
identity before the model is configured, and the preflight before the first model call, as
divergence is judged today; the re-check runs after the Reviewer; `.idp-agent.yml`'s `iacRepo`
becomes a cross-check that refuses a mismatch. `init --submit` takes the same road in the
service's own repository. `idpa "<phrase>" --submit` lifts D8: the forge, gh and the preflight
before the Supervisor, a question with `--submit` still refused.

**6.4, the live proof and the documents.** The owner's live test against a public throwaway
repository, run by hand with their own gh session and a second account's, never in CI; its
recorded answers hold the fake to GitHub offline and pin the minimum gh version. ADR-0015, the
design sections, `SECURITY.md`, `docs/submitting.md`, the README and `AGENTS.md` say what was
built, in the owner's words. Then the owner re-records every tape recorded before 2026-09-30.

**Tech stack.** TypeScript 7, Node 22+ (the fake gh's executable and `pnpm demo:github` need
22.18+ for type stripping, as `pnpm demo:backstage` does), Vitest 5, Zod 4. The `git` binary, 2.28
or later as stage 5 (`config --show-scope` needs 2.26); `gh`, never in `pnpm test`, and for the
owner's live runs at least `GH_MINIMUM_VERSION` (6.1.2, provisional until 6.4.1 pins it). No new
npm dependency.

**Branches.** One task, one branch, one pull request, each cut from the one before and merged
bottom-up with `gh pr merge --rebase` once the owner says so. Worktrees under
`~/Documents/idp-agent-worktrees/`, files staged by name. The plan itself is committed on
`docs/stage-6-plan` and merged first, documents only.

| Task | Branch | Lands |
|---|---|---|
| — | `docs/stage-6-plan` | this plan |
| 6.1.1 | `feat/s6-allow-list` | the two launchers and their grammars, the push and gh environments, three architecture rules, the fake gh, `tests/setup/forge.ts`, `tests/live/**` excluded |
| 6.1.2 | `feat/s6-remote` | the upstream, the five URL forms, the configuration scope check, gh's presence, version and identity; the fourth rule |
| 6.1.3 | `feat/s6-protection` | the preflight, `PROTECTION_SETTINGS`, `idpa protection`, `init platform`'s list, `pnpm demo:github`, `docs/submitting.md` |
| 6.2.1 | `feat/s6-github-forge` | the GitHub forge: recognition, the re-check, the push, the read-back, the pull request; `treeFor`; the offline negative tests |
| 6.2.2 | `feat/s6-plan-from-github` | `plan --from --submit` to GitHub, the road table, `--local`, the interim refusals, `SECURITY.md`'s guarantees |
| 6.3.1 | `feat/s6-intent-github` | `plan "<intent>" --submit` to GitHub, the `iacRepo` cross-check, the forge's trace attributes |
| 6.3.2 | `feat/s6-init-github` | `init --submit` to GitHub |
| 6.3.3 | `feat/s6-phrase-submit` | `idpa "<phrase>" --submit` (D8 lifted) |
| 6.4.1 | `test/s6-live-github` | the live test, its configuration, the recorded answers, the contract test, the minimum gh version |
| 6.4.2 | `docs/s6-adr-0015` | ADR-0015 and every document the stage makes true |
| 6.4.3 | `chore/s6-tapes` | the owner's re-recording; on our side the roadmap and CHANGELOG lines |

---

## Global Constraints

Inherited and still binding: `AGENTS.md`, `docs/design.md` §4, stage 5's Global Constraints
(`docs/plans/stage-5-write.md`), and the note's § 5 to § 15. Every task cites the numbers below;
a task that cannot hold one is stopped and brought to the owner.

1. **idpa holds no GitHub credential.** No token variable, flag, configuration key or file; never
   `gh auth token`, never `hosts.yml`, never `git credential`, never a credential helper written
   or read. The person's environment is passed to git and gh unread, minus what § 5's table
   removes. No credential appears in an argument, in standard input, on stdout or stderr, in a
   trace, in a pull request body or in a model request; each road that starts gh or pushes has a
   key-reach leg proving it, **in the same pull request that opens that road** (§ 16).
2. **The allow-list is a grammar checked on the final vector.** Each launcher builds the vector
   from a typed request and checks the finished vector, before any process starts; anything
   else throws `LauncherRefusal` and starts nothing. The shapes are exactly § 6's, no wider. No
   merge, approval, review, comment, close, reopen, label, assignment, forced push, deletion, push
   outside `refs/heads/idp-agent/`, `fetch`, `pull`, `clone`, `gh pr …`, `gh auth …`, `gh repo …`,
   `PUT`, `PATCH`, `DELETE`, `/merges`, `/contents/`, `/reviews`, `/merge`, `/update-branch`,
   `/graphql`. `ForgeProvider` keeps no `merge`, no `delete`, no `approve`, no `close`, no way to
   name a branch.
3. **The repository's configuration is hostile; the person's global and system configuration is
   theirs.** Every push carries § 4's pins; a key of § 7's refused list at the `local` or
   `worktree` scope is exit 2, before any model and again at step 8, naming the key and its scope,
   **never its value**. The push goes to the URL `git remote get-url --push` printed, never to a
   remote name.
4. **Nothing is written on either side before the re-check at step 8 passes**, and nothing is
   opened before the read-back and the second rules read of step 11 pass. Each system stays
   atomic on its own (ADR-0010 locally, one ref per push on GitHub); the two together are not
   claimed atomic, and every intermediate state is a row of § 4's table that the same command,
   run again, completes.
5. **The invariant, in the owner's words**, wherever a document states it: "the identity that
   opens a pull request cannot merge it until someone else has approved the exact commit that
   would merge, and idpa never submits against a base without those rules". A pull request is
   opened only when every ruleset supplying a required rule answers `current_user_can_bypass`
   `never`; a base protected only by classic branch protection is refused.
6. **`pnpm test` reaches no network, no real gh, no real ssh and none of the developer's git or gh
   credentials** (§ 10's offline floor). `tests/setup/forge.ts` is loaded in every worker, even
   while a scenario records, and removes `NODE_USE_ENV_PROXY` there too, so the proxy it closes
   for git and gh never reaches Node's `fetch`; gh is the fake, injected as `MainDeps.gh`; the remote is a bare
   repository in the run directory reached through a fake ssh named by `GIT_SSH_COMMAND` in the
   environment handed to `main`. `pnpm smoke` and `pnpm demo:github` put a guard `gh` and `ssh`
   first on `PATH` and a scratch `HOME` and `GH_CONFIG_DIR` in the binary's environment, and
   remove every `*_API_KEY` and `IDP_*` variable from it, so the built CLI can reach neither the
   developer's gh nor their model key.
7. **Nothing of GitHub reaches a model.** On the intent and phrase roads the order is: the forge,
   the road, gh's identity, then (after the configuration) the preflight, all before the first
   model call; the re-check, the push and the pull request after the last. No gh or git output is
   in any prompt. **No tape's request bytes change**: scripted clients only, `IDP_RECORDING=record`
   never used by an agent; every tape replays with the bytes it has on `2b2250e`, and
   `tests/scenarios/prompt-digests.test.ts` stays green unchanged through 6.4.2. The one exception
   is 6.4.3, the owner's re-recording: the requests the code builds do not move (`FIRST_SENT`
   holds each agent's first request unchanged), but from each agent's second turn a request
   carries the recorded answers, so `SENT` is re-measured there. `tests/golden/` and
   `fixtures/si-demo/` are unchanged by every task.
8. **Output is parsed, never printed.** gh's `--include` status line is read, the body parsed as
   JSON within its bound against a schema of the fields a route needs; a push's output is its
   `--porcelain` flag line. git's and gh's stderr are read to classify a failure and never printed
   on the push and gh roads. What reaches the terminal is an engine sentence; every value that came
   from GitHub or the repository (a branch, a base, a login, a context) passes `inertLine`. The pull
   request URL is built from the parsed host, owner, repository and a positive integer number,
   never GitHub's `html_url`.
9. **Exit codes.** `2`: the environment or the arguments, refused before any process writes and
   before any model (`ForgeInputError`): gh missing, logged out, expired, too old or not a person;
   a refused configuration key; a remote URL with userinfo, one that does not parse, a `.` or
   URL-valued `branch.<name>.remote`, several fetch or push URLs, a push URL naming another
   repository, a remote name or base outside § 13's grammar; `--local` without `--submit`; the
   interim refusals of 6.2.2. `1`: GitHub's answer at run time, the push failing, the repository's
   state (rules missing or bypassable, classic only, a visible deploy key, the base not level, a
   closed or reverted pull request, a branch that is not ours, a stale local branch, no push
   access, the pull request not opened). `3`: a question put to `idpa "<phrase>" --submit`,
   refused after the Supervisor's one word, the mirror of a change put to `ask` (6.3.3), in prose
   and in `--json` alike (`unsupported`). `0`: submitted, already submitted, declined, unchanged.
   `idpa protection`: 0 the rules hold, 1 they do not, 2 arguments, configuration or gh refused.
   This stage adds no exit 2 after a model call: with `--submit`, the phrase's no-repository
   refusal, which `2b2250e` makes after the Supervisor's word (`index.ts:1610-1615`), is made
   before any model (6.3.3), and the one exit 2 left there is `2b2250e`'s own, a `.idp-agent.yml`
   that does not parse, which `runIntent` reads after the Supervisor's word on the phrase road
   (`plan.ts:1406`). No new exit code.
10. **Bounds** (§ 15), in one constant each: 15 s per gh call and per local git call, 120 s for
    the push, 180 s per submission; 1 MiB per gh answer and per pull request body; at most ten
    rulesets per check; at most 48 gh calls per run; one pull request list page of 100; the
    read-back at most three reads, 0.5 s then 1.5 s apart.
11. **Each pull request is green on its own**: `pnpm typecheck`, `pnpm test`, `pnpm build`,
    `pnpm smoke`. The suite leaves temporary directories and the disk was at 97 % when this plan
    was written: `df -h "$TMPDIR"` before a test-heavy step, targeted suites while developing.
12. **Architecture rules are counted, not trusted.** 25 on `2b2250e`
    (`pnpm vitest run tests/architecture --reporter=verbose`, the `architecture` block); 28 after
    6.1.1, 29 after 6.1.2, unchanged after. `AGENTS.md`'s number moves in the commit that moves it,
    and so does its test count (3999 on `2b2250e`, also on the README's badge).
13. **Traceability.** Every pull request adds its line under `## Unreleased` in `CHANGELOG.md`,
    ending `([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM))`, the number written when
    the pull request is opened; edits `docs/roadmap.md` (the stage 6 row, the queue item, the
    decisions it records); updates the review's Status section for each id it closes (cli-ux-10's
    `--json` keys in 6.2.2, cli-ux-13 in 6.3.1); and carries the documents it makes true, as stage
    5's did.
14. **"What the owner can run" ends every task**, run and checked by whoever executes the task
    before handing it over. Keyless and offline where the slice allows it (a bare repository on
    disk as the remote, the fake gh through `pnpm demo:github`, targeted vitest files); commands
    that need the owner's gh only where the note puts them (6.1.3, 6.2.2, 6.3.1, 6.3.2, 6.3.3,
    6.4.1). **No `#` comment inside a shell block** (the owner's zsh has no `interactive_comments`);
    expected output goes under the block as an "Attendu :" list; the owner's login is set once,
    `OWNER=your-login`, and read as `"$OWNER"`, never written `<owner>`.
15. **Standing rules.** No commit, push or pull request without the owner's go-ahead. English
    throughout, Conventional Commits. No `switch` on a closed union without
    `const _exhaustive: never = value` in `default`: `Road`, `Submitted`, `PreviewStatus`,
    `SubmissionReport`, `GhRoute`, `GhRequest`, `RemoteUrl`, `Missing`, `PushFlag` and
    `PushFailure` each get one wherever they are switched on.

---

## Where the code moved since the note

The note cites `main` at `55fb995`. `main` is at `2b2250e`: between them, `src/llm/recording.ts`,
`src/llm/runtime.ts`, `src/llm/README.md` and six lines at the end of `src/cli/index.ts`
(`openSession`'s `save`, `:2277-2289`) changed (B2, #116), and nothing else under `src/`. Every
line the note cites was read again on `2b2250e`.

| # | The note says | On `2b2250e` | This plan |
|---|---|---|---|
| 1 | The cited lines: `footer.ts:11`, `provider.ts:34-49`, `clear.ts:433-445` and `:505-521`, `forge.ts:247-254`, `submit.ts:146-157` and `:199-200`, `environment.ts:23-44`, `config.ts:7-8` and `:45-59`, `init.ts:80-89`, `index.ts:1343-1368`, `design.md:875`, `:1027-1030`, `:1240` | All hold, within a line: `spawnedEnvironment` is `environment.ts:23-43` (the file has 43 lines), `messageFor` is `clear.ts:497-518`, `BRANCH_PROTECTION` is `init.ts:76-90`, design §9.4's first test is `design.md:1239` | Cited as they stand |
| 2 | "the architecture rule that 'only `process/git.ts` starts a process'" | The rule's title is *only the named modules write, and only one starts a process*; the `architecture` block holds **25** rules, and `AGENTS.md:567` says "Twenty-five" (confine/'s two rules landed with B3, #115), and `docs/design.md` §5.5 still says "twenty-three" | 6.1.1 corrects §5.5 with its own count, renames that rule *…and only process/git.ts and process/gh.ts start a process* and adds three; 6.1.2 adds one: 29 |
| 3 | The layering names `process/` and `forge/` | `src/confine/` is a third leaf (`AGENTS.md:271`, `:299`), loaded by `scaffold/write.ts`, `context/iac-fs` and `context/project-fs` only | Stage 6 touches no module of `confine/` and gives it no importer: the launchers open no file, and the fake ssh and the stub gh are test-side |
| 4 | "`forge/github/remote.ts`: the five URL forms, the grammar" (§ 16, 6.1.2) | *forge/ imports core/, process/, node:crypto and node:path, and nothing else* — no package, so no Zod in `forge/` | The pure parts live in a new `src/core/github/` (the URL parser and grammars, the configuration scope check, the answer schemas, the rules judgement, the pull request's body and URL, the gh version); `forge/github/` does the reads and the writes through the launchers. `process/` holds its own copy of the grammars it checks (it imports nothing of ours), and a test holds the two copies to one answer (Choices) |
| 5 | "The push fixture hands `main` an environment (`MainDeps.env`) whose `GIT_SSH_COMMAND` is a fake ssh" (§ 10) | `openForSubmission` calls `openLocalForge(root, repository)`, whose default `git` is `gitIn(repo)` with **no** `env` (`forge.ts:76`): a submission's git reads `process.env`, never `MainDeps.env` | `openForSubmission` takes `env` (6.2.2, from `deps.env ?? process.env`) and hands it, through `openSubmissionForge` (`cli/` loads no launcher), to every launcher of the submission, `gitIn`, `pushIn` and `ghIn` alike, so the fixture's `GIT_SSH_COMMAND` and `HOME` reach the push. The launchers still drop every `GIT_*` but the push's four (§ 5) |
| 6 | "git's and gh's stderr are read to classify a failure (§ 15) and never printed" (§ 6) | `failed()` prints a `GitError`'s stderr, one cleaned line each, exit 1 (`index.ts:2041-2048`) | Unchanged for stage 5's local calls. A push failure and every gh failure are classified in `forge/github/` into an engine sentence and returned as an outcome; a `GhError` that reaches `failed()` is printed by its message alone, which never quotes gh |
| 7 | "Traces. Root attributes of the run … `idp.forge.*`" (§ 12), placed in 6.2.2 | `plan --from` writes no trace: only `agentBacked` runs are traced (`index.ts:2100-2185`: the phrase, `plan "<intent>"`, `ask`, `init`); root attributes are set at the start (`AgentRun.attributes`) or at the end (`builder.finish({ attributes })`, `trace/builder.ts:47-51`, used at `index.ts:2178`) | `forgeAttributes(report, road, calls)` lands in 6.2.2, pure and unit-tested, and is set on every result `submit()` returns; `CommandResult` gains `attributes?`, which `agentBacked` merges into `finish`. A local road's attributes reach a trace from 6.2.2 (`plan "<intent>" --submit --local`, `trace-wiring.test.ts`); the GitHub road's from 6.3.1 on (intent), 6.3.2 (init), 6.3.3 (phrase), and 6.3.1 sets them on `refuseDivergence`'s and `refuseUnprotected`'s refusals too. No new span type (ADR-0009) |
| 8 | Until 6.3.1 the intent road toward GitHub is refused, so it never says "no forge (stage 6)" | `init --submit` prints the same `NO_FORGE` line (`footer.ts:73`) | 6.2.2 applies the same interim refusal to `init --submit` toward a GitHub remote, exit 2 naming `--local`, lifted in 6.3.2; both live in `forge/open.ts` (`OPENS_PULL_REQUESTS`, `NOT_YET`), which reads the road before gh starts (Choices) |
| 9 | `NO_FORGE` replaced on the `--from` road | Its text is pinned by `tests/unit/plan-command.test.ts:1094` and quoted at `README.md:128`; `init platform`'s "stage 6" line by `tests/unit/init-command.test.ts:133` | Each updated in the pull request that changes the text: 6.2.2 and 6.1.3 |
| 10 | `SubmissionReport`'s shape "pinned by a test" (D11) | `submit.ts:146-155`, pinned in `plan-command.test.ts` | Widened in 6.2.2 with the test in the same commit (Choices) |
| 11 | "`tests/setup/offline.ts` blocks `fetch`, `node:http(s)` and `net.connect`" | Also `tls.connect` and `WebSocket`; the setup files are `shell.ts`, `offline.ts`, `personal.ts`; `vitest.config.ts` includes `tests/**/*.test.ts`, which **would collect** `tests/live/github/submit.live.test.ts` | `tests/setup/forge.ts` is the fourth setup file; `exclude: ['tests/live/**']` lands in 6.1.1 with the unit test that nothing there is collected |
| 12 | `HOME` pointed into the run directory by `forge.ts` | `tests/support/git.ts` isolates the tests' own git with `GIT_CONFIG_GLOBAL=/dev/null`; the launcher drops every `GIT_*` and so reads `$HOME/.gitconfig`; stage 5's fixtures set the identity locally (`committed()`) | 6.1.1 measures the suites that read `HOME` (`local-forge`, `process-git`, `plan-command`, `init-command`, `personal-config`, `tests/invariants/forge.test.ts`) with `HOME` moved, before it merges |
| 13 | § 7: `config --list --show-scope -z` reports an included value with the includer's scope | Measured on git 2.46: the output is `scope\0key\nvalue\0`, a key with no value has no `\n`, a key from `include.path` reports `local`, and the launcher's own `-c` pins report `command` | The parser in `core/github/config.ts` reads that format and drops every value at parse; only `local` and `worktree` are judged |
| 14 | § 13: a remote name "not beginning with `-`" | Measured: `git check-ref-format refs/remotes/--push/HEAD` **passes** | The leading-character rule is the fence, `--` before the name the second |
| 15 | § 12: the body "leaves room for stage 8's evidence section (`docs/stage-8-brief.md`, 'the merge request body')" | No heading of that name; `stage-8-brief.md:22` says "A report goes with it" | The body's engine block ends on a stable marker line stage 8 can append after; nothing of stage 8 is built |
| 16 | § 17: slice 2 of `backstage-http` goes first in the queue | Planned (#117), not built; B2 (#116) is merged | Whichever merges second rebases; they meet in `MainDeps` and `tests/architecture/dependencies.test.ts` only |
| 17 | `docs/submitting.md` | Does not exist | Created in 6.1.3 (gh, the ruleset, `idpa protection`, the configuration keys), extended in 6.2.2 and completed in 6.4.2 |
| 18 | "`idpa: …`" at the head of the note's refusals | No `ForgeInputError` carries a prefix; `failed()` prints the message as it is (`index.ts:2034-2037`) | No prefix, as every refusal today |
| 19 | `pnpm smoke` | Runs `plan --from --submit` on a clone with no remote (`smoke.mjs:399-441`) and checks only the first closing line; runs `pnpm demo:backstage` where Node strips types | The no-upstream road keeps both first lines; 6.1.3 makes smoke run `pnpm demo:github` under the same condition, and 6.2.2 adds the `--local` and no-upstream closing lines |
| 20 | The confirmation question (§ 3) | `confirmOnTerminal` asks `Submit this for review as <branch> in <root>? …` (`index.ts:1913-1942`) from a `SubmissionSummary` | `SubmissionSummary` gains `github?`; the GitHub road's question is § 3's, the local road's unchanged |

Nothing on the list reopens a decision of § 18 or § 19.

## Choices this plan makes where the note leaves one

- **`core/github/` holds everything pure** (row 4): `remote.ts`, `config.ts`, `answers.ts`,
  `protection.ts`, `pull-request.ts`, `gh-version.ts`. They import Zod and nothing of ours but
  `core/`, and each is unit-tested without a process. `forge/github/` reads and writes through the
  launchers and judges with `core/github/`.
- **The injection seam is the process, not the client.** `process/gh.ts` exports `GhProcess`,
  `(argv, { stdin, env, limits }) => Promise<GhExit>`; `spawnGh` is the real one, and
  `MainDeps.gh` hands in the fake's. `ghIn` builds the vector from a `GhRequest`, checks it with
  `checkGhArgv` and only then calls the process, so an injected fake never sees a vector the
  grammar refused, and the fake parses the vector with its own grammar, independently (§ 10).
- **Two copies of the grammars, one answer.** `process/` imports nothing of ours, so
  `process/git.ts`'s push-URL and ref checks and `process/gh.ts`'s owner, repository, base, sha and
  login checks are copies of `core/github/remote.ts`'s. `tests/unit/grammar-agreement.test.ts`
  (6.1.2) holds them to the same verdict over the same fast-check inputs and the note's named
  cases.
- **Where the fake lives.** As `tools/fake-backstage.ts` does for Backstage: `tools/fake-gh.ts` is
  the GitHub model and a self-contained executable (`node:` built-ins only, runnable where Node
  strips types, its state in a JSON file named by `FAKE_GH_STATE`), and `tests/support/fake-gh.ts`
  wraps it as a `GhProcess`, holds `DOORS` (every forbidden vector of § 6), and is the one file of
  `tests/` besides `tests/live/` the door rule lets name a door. `tools/` is never published
  (`package.json`'s `files`) and no rule reads it.
- **`pnpm demo:github`** (6.1.3, `scripts/demo-github.mjs`), the offline counterpart of
  `pnpm demo:backstage`: a copy of the demo SI committed on `main` with the remote
  `git@github.com:acme/iac.git`, a bare repository in a scratch directory, a fake ssh named by
  `GIT_SSH_COMMAND`, `tools/fake-gh.ts` first on `PATH` as `gh`, a scratch `HOME` and
  `GH_CONFIG_DIR`; it runs the built binary and states what each step expects. 6.1.3: `protection`
  exits 1, 0 and 2; 6.2.2 adds the submission twice and `--local`; 6.3.x add a road each, as far
  as the steps before the model (the built binary runs no model offline, and the demo removes
  every provider key from its environment). `pnpm smoke` runs it where Node strips types.
- **The road is decided once, before anything is read on GitHub**, by `readRoad` (6.1.2), and
  typed: `Road = GitHubRoad | LocalRoad`, `LocalRoad['why']` one of `'no-upstream'`,
  `'other-host'`, `'asked'`. A URL whose host is `github.com` or `ssh.github.com` (port 443) or of
  the `org-<id>@github.com` form is GitHub's, and one of those that does not parse to an owner and
  a repository is exit 2; a URL naming any other host is the other-host road; a path or a
  `file://` URL is the other-host road too, its host `this machine` (stage 5 submits in such a
  clone today, and 6.1.2 keeps it so). The clone's own configuration is judged on the GitHub road
  only, after the URLs: on the other roads nothing is pushed.
- **Which checks run when.** Exit-2 checks (the local forge's, the road's, gh's identity) in
  `openForSubmission`, before the model is configured, as `index.ts:1357-1368` opens the forge
  today. The preflight (exit 1, the repository's state) in `refuseUnprotected`, beside
  `refuseDivergence`, after the configuration and before the first model call, for the reason
  `index.ts:1349-1355` gives for divergence: a state is a negative answer, and it is judged once a
  model is known to exist; neither order pays a model for a refusal.
- **`--local`** is a flag of `plan` (both roads) and `init` from 6.2.2, of the phrase from 6.3.3,
  refused without `--submit` (exit 2). `idpa protection` refuses it.
- **Interim refusals** (6.2.2 to 6.3.1 and 6.3.2): `plan "<intent>" --submit` and `init --submit`
  toward a GitHub road are exit 2 before any model, naming `--local` and, for the intent,
  `plan --from`: `the intent road opens pull requests from the next release; add --local to cut
  the branch in this clone only, or submit a plan file with plan --from <plan.json> --submit.
  Nothing was written.` (and the `init` counterpart). They live in `forge/open.ts`
  (`OPENS_PULL_REQUESTS`, `NOT_YET`), which reads the road before gh starts: `cli/` cannot read
  the road without loading the git launcher, and Global Constraint 1 forbids starting gh on a
  road before its key-reach leg lands. 6.3.1, 6.3.2 and 6.3.3 each add their road to
  `OPENS_PULL_REQUESTS`; 6.3.3 removes both constants. The phrase keeps D8's refusal until 6.3.3.
- **`idpa protection`** takes the declarations repository through `declarationsFor`'s chain, as
  `plan` does, never the demo SI and never a catalogue, and says on stderr what named it; it has no
  `--json` in stage 6. A clone on the no-upstream or other-host road is exit 2, naming the road: there
  is no GitHub base to check.
- **`SubmissionReport`** (D11): `created` and `already-submitted` always carry `pushed: boolean`
  (false on a local road), and on the GitHub road `pullRequest: { host, repository, number, url,
  state: 'opened' | 'open', base }` and, on an older base, `olderBase`; `refused` gains `kept`
  (the local branch a refusal after step 9 leaves); two new variants, `pushed-without-pull-request`
  and `closed`. `pushed` is whether *this run* pushed. The pinned-shape test changes in 6.2.2, and
  cli-ux-10's Status item names the new keys.
- **`Submitted` and `Recognised`** widen in 6.2.1: `created` and `already-submitted` gain
  `pushed?`, `pullRequest?` and `olderBase?`, `created` also `statusChecks?` (the contexts step
  11's rules require, for the closing line), and `refused` gains `kept?` (all optional, so the
  local forge's literals stay as they are); `pushed-without-pull-request` and `closed` are new.
  § 14's second row includes a branch of ours on an older base: its pull request is opened, and
  the closing line says the base is older. Recognised as `pushed-without-pull-request`
  means "our branch is on GitHub with no pull request": the person is asked, and `submit` opens
  it (§ 14, row 2); returned by `submit`, it means step 11 or 12 stopped (exit 1).
- **The older base (D7, decision 10)** is an option of the local forge, `acceptOlderBase`, set only
  when `openGitHubForge` opens it: `existing()` accepts a single parent that is an ancestor of the
  base (`merge-base --is-ancestor`) and whose tree is `treeFor(parent, edits)`. Stage 5's local road
  keeps D7 unchanged.
- **`treeFor` writes nothing**: it reads the parent's trees with the `ls-tree -z <tree>` and
  `rev-parse <commit>^{tree}` shapes `objects.ts` already uses, and hashes each level in
  JavaScript (`treeId`, beside `blobId`), so the git grammar gains no shape for it.
- **The `SubmissionSummary` handed to `Confirm` gains `github?: { host, repository, base,
  pushedAlready }`**, and `confirmOnTerminal` asks § 3's question when it is present; the local
  road's question is unchanged byte for byte.
- **The forge's trace attributes** are the note's nine, from `forgeAttributes(report, road,
  calls)` (`idp.forge.kind`, `.host`, `.repository`, `.base`, `.branch`, `.pull_request`,
  `.outcome`, `.gh_calls`, `.pushed`), `calls` read from `GitHubApi.calls()` (0 on a local road),
  merged at `finish` through `CommandResult.attributes`.
- **The "submitting to" line names no role.** § 15 gives gh's identity exactly two calls (the
  version and `/user`), so `readIdentity` answers `role: undefined`; the role is read by the
  preflight (`repos/<o>/<r>`'s `permissions`) and reported in `ProtectionVerdict.reported.role`,
  which `idpa protection`'s block prints (`ada (gh, admin)`). The line is printed when the forge
  opens, before the preflight, so it reads `as <login> (gh)` on every road (settled by the owner,
  2026-09-30).
- **`readIdentity` and `openGitHub` take a `purpose`**, `'submission'` by default: with
  `'protection'`, the exit-2 gh sentences leave out `; or add --local to cut the branch in this
  clone only`, which `idpa protection` does not take.
- **`refuseUnprotected` keeps one verdict per forge and base commit** (6.3.1), so the phrase
  road's early preflight (6.3.3) is not read again by `runIntent`, and the run stays within the
  48 gh calls.
- **`GH_MINIMUM_VERSION` is provisionally `2.40.0`**, the version the fake answers
  (`gh version 2.40.0 (2023-12-07)`), and 6.4.1 sets it to the version the live run recorded,
  with the fake's answer moved to match.
- **The pull request body** is `pullRequestBody(input)`: the commit's body as `messageFor` wrote
  it, the request inside a backtick fence one longer than the longest run in it, then the engine's
  block (the road, D4's wording; the branch and what its digest means; `CLOSING`), ending on the
  line `<!-- idp-agent: end of the engine's block -->` after which stage 8's report will go. The
  title is the commit's subject.
- **The one list of settings** is `PROTECTION_SETTINGS` (`core/github/protection.ts`), printed by
  `idpa protection`, by `refuseUnprotected` and by `init platform`, whose last line becomes
  "`idpa protection` checks them once the repository is on GitHub." `BRANCH_PROTECTION` is removed.
- **What 6.2.1 proves without the CLI.** The note's "a full `plan --from --submit` against the fake
  opens pull request #1, then every door is tried" runs in 6.2.1 against the forge itself
  (`openGitHubForge` over a `Cleared` from `clearedFor`), and again end to end through `main` in
  6.2.2.
- **The road that drafted a change reaches the forge as `route`**, `PullRequestInput['road']`,
  required on `openForSubmission`, `openSubmissionForge` and `openGitHubForge` from 6.2.2 (`'from'`,
  `'intent'`, `'init'`, `'phrase'`): the pull request's engine block names it (D4). Named `route`
  because `road` is already § 13's `Road` on the same objects.
- **`Cleared` carries `request`** (6.2.1): the very string `messageFor` writes under "Requested,
  as recorded with the plan", cut at 500, so the pull request's body fences it without parsing a
  commit message. No commit message moves by a byte.
- **`readProtection` apart from `preflight`** (6.1.3): `idpa protection` has no local forge and so
  no `Base`; `preflight` is `readProtection` and the base's level check. 6.2.1 splits items 2 and 3
  out again as `readRules`, which the re-check of step 8 and the second read of step 11 call.
- **The step-12 line is built from its reason**: `<n> file(s) · <idp-branch> is on
  github.com/<o>/<r>, and <reason>`, so a lost gh answer can say "gh did not say whether the pull
  request was opened" rather than claim it was not.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/process/refusal.ts` | 6.1.1 | `LauncherRefusal`: a vector outside the grammar; names the command word, never an argument |
| `src/process/git.ts` *(edit)* | 6.1.1 | `checkGitArgv` over the final vector in `gitIn` (stage 5's shapes, `config --list --show-scope -z`, `config --get branch.<b>.remote/merge`, `remote get-url [--push] --all -- <name>`, `merge-base --is-ancestor`); `pushIn`, `PushRequest`, `PUSH_PINS`, `PUSH_FLAGS`, `PUSH_LIMITS`, `PUSH_VARIABLES`, `pushEnvironment`, `parsePorcelain`, `PushOutcome` |
| `src/process/gh.ts` | 6.1.1 | the gh launcher: `ghIn`, `GhClient`, `GhRequest`, `GhRoute`, `ghArgv`, `checkGhArgv`, `encodeRefPath`, `parseIncluded`, `GhAnswer`, `GhExit`, `GhProcess`, `spawnGh`, `ghEnvironment`, `GH_REMOVED`, `GH_SET`, `GH_LIMITS`, `GhError` |
| `src/process/README.md` *(edit)* | 6.1.1 | two launchers, the grammars, the environments |
| `tests/setup/forge.ts` | 6.1.1 | the offline floor for child processes (§ 10), and Node's `NODE_USE_ENV_PROXY` removed |
| `vitest.config.ts` *(edit)* | 6.1.1 | `forge.ts` among the setup files; `exclude: ['tests/live/**']` |
| `tools/fake-gh.ts` | 6.1.1, 6.1.3, 6.2.1 | the GitHub model (accounts, repository, rulesets, classic protection, refs and commits read from a bare repository; then pull requests, reviews and the doors) and its executable entry |
| `tests/support/fake-gh.ts` | 6.1.1, 6.2.1 | `fakeGitHub()` as a `GhProcess`, its own argv grammar, `DOORS` |
| `tests/support/stub-gh.ts` | 6.1.1 | `stubGh()` and `stubGit()`: a recording `gh` or `git` on a temporary `PATH` (argv, environment, working directory) |
| `tests/unit/process-gh.test.ts`, `tests/unit/launcher-doors.test.ts`, `tests/unit/fake-gh.test.ts`, `tests/unit/live-config.test.ts` | 6.1.1 | the gh launcher and its environment against the stub; every door refused before a process starts; the fake's grammar; nothing collected under `tests/live/` |
| `tests/unit/process-git.test.ts`, `tests/unit/offline.test.ts`, `tests/unit/local-forge.test.ts` *(edit)* | 6.1.1 | the git grammar and the push form and environment; the forge floor's legs and the system `core.sshCommand` check |
| `tests/architecture/dependencies.test.ts` *(edit)* | 6.1.1, 6.1.2 | three rules, then the fourth, with their self-tests |
| `src/core/github/remote.ts` | 6.1.2, 6.3.1 | `parseRemoteUrl`, `RemoteUrl`, `GitHubRepository`, `isRemoteName`, `baseOfMerge`, `isLogin`, `sameRepository`; then `locatorRepository` |
| `src/core/github/config.ts` | 6.1.2 | `parseConfigListing`, `refusedConfigKeys`, `REFUSED_SECTIONS`, `REFUSED_KEYS`, `KEPT_LOCAL_KEYS`, `ConfigEntry` |
| `src/core/github/gh-version.ts` | 6.1.2, 6.4.1 | `GH_MINIMUM_VERSION`, `parseGhVersion`, `isAtLeast` |
| `src/core/github/answers.ts` | 6.1.2, 6.1.3, 6.2.1 | the Zod schema of each route's fields: `userAnswer`; then `repositoryAnswer`, `rulesAnswer`, `rulesetAnswer`, `branchAnswer`, `refAnswer`; then `commitAnswer`, `pullsAnswer`, `pullAnswer` |
| `src/forge/provider.ts` *(edit)* | 6.1.2, 6.2.1 | `Road`, `GitHubRoad`, `LocalRoad`, `GhIdentity` (types); then `name: 'local' \| 'github'`, `PullRequest`, the widened `Submitted` and `Recognised`, the comment's "token" sentence rewritten |
| `src/forge/github/road.ts` | 6.1.2 | `readRoad`: the upstream, both URLs, the configuration scope check |
| `src/forge/github/identity.ts` | 6.1.2 | `readIdentity`: gh present, its version, `gh api user` a person |
| `src/forge/github/api.ts` | 6.1.2, 6.1.3, 6.2.1 | `githubApi`: one typed method per route, the status classified into `GitHubAnswerError`, the call budget |
| `src/forge/github/limits.ts` | 6.1.2 | `GITHUB_LIMITS` |
| `src/forge/github/README.md`, `src/forge/README.md` *(edit)* | 6.1.2, 6.2.1 | what lives there, what may not |
| `tests/unit/github-remote.test.ts`, `tests/unit/repository-config.test.ts`, `tests/unit/road.test.ts`, `tests/unit/gh-identity.test.ts`, `tests/unit/grammar-agreement.test.ts` | 6.1.2 | the five forms and the refusals; the scope check over real `.git/config` and `include.path`; the road table; identity; the two grammar copies |
| `src/core/github/protection.ts` | 6.1.3 | `PROTECTION_SETTINGS`, `judgeProtection`, `ProtectionVerdict`, `Missing`, `protectionText` |
| `src/forge/github/preflight.ts` | 6.1.3, 6.2.1 | `readProtection` (§ 8 items 1 to 5) and `preflight` (that and the base level check); then `readRules` (items 2 and 3) split out |
| `src/forge/github/open.ts` | 6.1.3 | `openGitHub`: the road, then gh's identity, with the launchers built inside `forge/` |
| `src/forge/open.ts` | 6.2.2, 6.3.1–6.3.3 | `openSubmissionForge`: the local forge, `openGitHub`, `openGitHubForge`, for one repository; the interim refusals (`OPENS_PULL_REQUESTS`, `NOT_YET`), each road added by its task and both constants removed by 6.3.3 |
| `src/cli/commands/protection.ts`, `src/cli/render/protection.ts` | 6.1.3 | `runProtection`; `renderProtection`, `renderUnprotected` |
| `src/cli/index.ts` *(edit)* | 6.1.3, 6.2.2, 6.3.1–6.3.3 | `protection` command, `MainDeps.gh`, `HELP` and `usageOf` (both in `index.ts`: `src/cli/usage.ts` is the model-cost line); then `--local`, the road wiring; then each road |
| `src/cli/repository.ts`, `src/cli/source.ts` *(edit)* | 6.1.3 | `DeclarationsCommand` gains `'protection'`; `sourceOf` and `sourceNotice` for it; `protectionNeedsRepository` |
| `src/cli/commands/init.ts` *(edit)* | 6.1.3, 6.2.2, 6.3.2 | `PROTECTION_SETTINGS` in place of `BRANCH_PROTECTION`; then `runInitRepo`'s own call with `route: 'init'`; then the preflight in `runInitRepo` |
| `scripts/demo-github.mjs`, `package.json`, `scripts/smoke.mjs` *(edit)* | 6.1.3, 6.2.2, 6.3.x | `pnpm demo:github`, run by smoke |
| `tests/unit/protection.test.ts`, `tests/unit/preflight.test.ts`, `tests/unit/protection-command.test.ts`, `tests/unit/init-command.test.ts` *(edit)*, `tests/contract/key-reach.test.ts` *(edit)*, `tests/unit/package-scripts.test.ts` *(edit)* | 6.1.3 | the judgement over every rule shape; the reads and their budget; the command's three exits; the list `init platform` prints; the protection leg; `pnpm demo:github` |
| `docs/submitting.md` | 6.1.3, 6.2.2, 6.4.2 | the page a person follows |
| `src/forge/local/objects.ts` *(edit)*, `src/forge/local/tree.ts` | 6.2.1 | `treeId`, `objectFormat`; `treeFor(git, parent, edits, format)` |
| `src/forge/local/forge.ts` *(edit)* | 6.2.1, 6.3.2 | `acceptOlderBase`; the format read through `objectFormat`; then D12's sentence says "by this build" |
| `src/core/plan/clear.ts` *(edit)* | 6.2.1 | `Cleared.request` |
| `src/core/github/pull-request.ts` | 6.2.1 | `pullRequestBody`, `pullRequestUrl`, `fenceFor`, `PullRequestInput`, `ENGINE_BLOCK_END` |
| `src/forge/github/push.ts` | 6.2.1 | `pushChange`, `classifyPushFailure`, `PushFailure` |
| `src/forge/github/forge.ts` | 6.2.1 | `openGitHubForge`: recognise, re-check, local ref, push, read-back, rules again, open |
| `tests/support/github-fixture.ts` | 6.2.1, 6.3.1, 6.4.1 | `githubClone()`: a committed clone on `git@github.com:acme/iac.git`, a bare repository, a fake ssh, the environment and the fake gh that go with them; `githubForge`, `fakeSsh`, `remoteRefs`; then `unprotect`, `moveGitHubBase` and `githubClone`'s `source` and `repository`; then `openedPullRequest` |
| `tests/unit/tree-for.test.ts`, `tests/unit/pull-request-body.test.ts`, `tests/unit/github-pulls.test.ts`, `tests/unit/github-forge.test.ts`, `tests/unit/merge-refused.test.ts`, `tests/unit/hostile-clone.test.ts`, `tests/unit/forge-types.test.ts`, `tests/invariants/github-forge.test.ts` | 6.2.1 | the tree git would write; the body and the URL; the three new routes; § 14's rows; the doors in the fake's model; § 7's keys; the absent methods; two systems, every failure |
| `src/cli/commands/submit.ts` *(edit)* | 6.2.1, 6.2.2, 6.3.1 | two interim cases of `outcomeOf`; then `openForSubmission` with the road and `env`; `refuseUnprotected`; the early return of `:199-200`; `SubmissionReport` widened; `forgeAttributes`; then `refuseOtherRepository` and the verdict kept per forge and base |
| `src/cli/render/footer.ts` *(edit)* | 6.2.2 | `PreviewStatus` widened; `NO_FORGE` replaced by `localRoadLine` and `pullRequestLines` |
| `src/cli/commands/result.ts` *(edit)* | 6.2.2 | `attributes?` |
| `src/cli/commands/plan.ts` *(edit)* | 6.2.2, 6.3.1 | the status and the report through both roads, `route`; then the cross-check and the preflight in `runIntent` |
| `tests/unit/plan-command.test.ts`, `tests/unit/cli-args.test.ts`, `tests/unit/trace-wiring.test.ts` *(edit)*, `tests/unit/submit-github.test.ts` | 6.2.2 | the pinned report and the two questions; `--local`; the forge on the trace's root; `plan --from --submit` to the fake, every row, and the doors after it |
| `SECURITY.md`, `README.md` *(edit)* | 6.2.2, 6.4.2 | two rows of *What leaves your machine*; the two authorisation items to *Guaranteed*; the closing lines quoted |
| `docs/design.md` §4.2, `AGENTS.md` *Authorisation* *(edit)* | 6.2.2, 6.4.2 | the owner's invariant, design §4 first, in the pull request that makes it true; 6.4.2 points both at ADR-0015 |
| `tests/unit/plan-intent.test.ts` *(edit)* | 6.3.1 | the intent road to the fake, the order before any model, the `iacRepo` cross-check |
| `tests/unit/init-command.test.ts` *(edit)* | 6.3.2 | `init --submit` to the fake, D12's sentence |
| `src/cli/commands/entry.ts`, `src/cli/commands/ask.ts` *(edit)*, `tests/unit/entry.test.ts` *(edit)* | 6.3.3 | the phrase road: `QUESTION_NOT_SUBMITTED`, `runEntry`'s `submit`, `classified`'s question road |
| `vitest.live.config.ts`, `tests/live/guard.ts`, `tests/live/setup.ts`, `tests/live/github/doors.ts`, `tests/live/github/submit.live.test.ts`, `tests/contract/github/answers-<date>.json`, `tests/contract/github-answers.test.ts`, `tests/support/github-answers.ts`, `tests/unit/github-answers.test.ts` | 6.4.1 | the live test, its guard and its doors, and what it records; the fake held to it |
| `docs/adr/0015-a-submission-is-a-pull-request-the-rules-hold.md` and the documents of § 16's 6.4.2, `tests/unit/invariant-wording.test.ts` | 6.4.2 | ADR-0015; ADR-0006, -0010, -0012, -0003; design §4.2, §4.4, §5.1, §5.5, §7.0, §7.2, §7.4, §8, §9.2, §9.4, §10, §12.1; `SECURITY.md`; `docs/submitting.md`; README; `AGENTS.md`; `src/core/schemas/config.ts:7-8`; the invariant held word for word |
| `tests/recordings/**` (the owner's), `tests/scenarios/plan-mode.test.ts`, `question-mode.test.ts`, `prompt-digests.test.ts` *(edit)* | 6.4.3 | every tape recorded before 2026-09-30, re-recorded by the owner with their key; every turn under the new digest, a stale question tape failing, `FIRST_SENT` split out and `SENT` re-measured |

---

## The names every task shares

Every task uses these, and none renames one. A name a task adds is listed here with the task
that adds it, and is added here first when the plan changes.

**Modules.** `src/process/refusal.ts`, `src/process/gh.ts`, `src/core/github/{remote,config,gh-version,answers,protection,pull-request}.ts`,
`src/forge/github/{road,identity,api,limits,preflight,open,push,forge}.ts`, `src/forge/open.ts`, `src/forge/local/tree.ts`,
`src/core/plan/clear.ts` (`Cleared.request`),
`src/cli/commands/protection.ts`, `src/cli/render/protection.ts`, `tools/fake-gh.ts`,
`tests/setup/forge.ts`, `tests/support/{fake-gh,stub-gh,github-fixture,github-answers}.ts`,
`scripts/demo-github.mjs`, `vitest.live.config.ts`, `tests/live/{guard,setup}.ts`,
`tests/live/github/{doors.ts,submit.live.test.ts}`, `tests/contract/github-answers.test.ts`, `docs/submitting.md`,
`docs/adr/0015-a-submission-is-a-pull-request-the-rules-hold.md`.

**`process/`.**
- `class LauncherRefusal extends Error` (`name = 'LauncherRefusal'`), message `` `git ${word} is not a command idp-agent runs` `` / `` `gh ${word} is not a command idp-agent runs` ``.
- git: `checkGitArgv(args: readonly string[]): void`; `interface PushRequest { url: string; commit: string; branch: string }`; `type PushFlag = 'created' | 'up-to-date' | 'rejected'` (porcelain `*`, `=`, `!`); `interface PushOutcome { flag: PushFlag; summary: string }` (`summary`: the porcelain line's summary, `stale info` or a repository rule, which is on stdout with `--porcelain`); `type Push = (request: PushRequest) => Promise<PushOutcome>`; `pushIn(repo: string, options?: { env?: NodeJS.ProcessEnv; limits?: GitLimits }): Push`; `PUSH_PINS` (the `-c` pairs of § 4 beyond `HARDENING`: `protocol.ext.allow=never`, `http.followRedirects=false`, `push.followTags=false`, `push.recurseSubmodules=no`, `push.gpgSign=false`); `PUSH_FLAGS` (`--porcelain`, `--no-verify`, `--no-follow-tags`, `--no-recurse-submodules`, `--no-signed`); `PUSH_LIMITS = { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 }`; `PUSH_VARIABLES = ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_ASKPASS']`; `pushEnvironment(env?)`; `parsePorcelain(stdout: Buffer, ref: string): PushOutcome`; `SUBMISSION_REF = /^refs\/heads\/idp-agent\/[a-z0-9-]+-[0-9a-f]{8}$/`; `GITHUB_PUSH_URL` (the five forms).
- gh: `type GhRoute = { route: 'user' } | { route: 'repository'; owner; name } | { route: 'branch'; owner; name; branch } | { route: 'rules'; owner; name; branch } | { route: 'ruleset'; owner; name; id: number } | { route: 'ref'; owner; name; branch } | { route: 'commit'; owner; name; sha } | { route: 'pulls'; owner; name; head: string }`; `type GhRequest = { kind: 'version' } | { kind: 'get'; route: GhRoute } | { kind: 'open-pull-request'; owner; name; body: string }`; `ghArgv(request): string[]`; `checkGhArgv(argv: readonly string[], stdin?: Buffer): void`; `encodeRefPath(ref: string): string`; `interface GhExit { code: number | string | undefined; stdout: Buffer; stderr: string; timedOut: boolean }`; `type GhProcess = (argv: readonly string[], options: { stdin?: Buffer; env: NodeJS.ProcessEnv; limits: GhLimits }) => Promise<GhExit>`; `spawnGh: GhProcess`; `interface GhAnswer { status: number; hasNext: boolean; body: string }`; `parseIncluded(stdout: Buffer): GhAnswer | undefined`; `interface GhClient { version(): Promise<string>; get(route: GhRoute): Promise<GhAnswer>; openPullRequest(owner: string, name: string, body: string): Promise<GhAnswer>; calls(): number }`; `ghIn(options?: { env?: NodeJS.ProcessEnv; run?: GhProcess; limits?: GhLimits }): GhClient`; `interface GhLimits { timeoutMs: number; maxOutputBytes: number }`; `ghEnvironment(env?)`; `GH_REMOVED` (`GIT_*` and `GH_HOST`, `GH_REPO`, `GH_DEBUG`, `DEBUG`, `GODEBUG`, `GH_FORCE_TTY`, `CLICOLOR_FORCE`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, compared by upper-cased name, never indexed); `GH_SET` (`GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `NO_COLOR=1`, `GH_PAGER=cat`); `GH_LIMITS = { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 }`; `class GhError extends Error { kind: 'missing' | 'auth' | 'timeout' | 'too-large' | 'unreadable' | 'failed' }` (`missing` = `ENOENT`, `auth` = gh's exit 4), its message never quoting gh. No gh route takes a login, so `process/gh.ts` holds no login grammar.

**`core/github/`.**
- `interface GitHubRepository { host: 'github.com'; owner: string; name: string }` (printed `github.com/acme/iac`); `type RemoteUrl = { kind: 'github'; repository: GitHubRepository; url: string } | { kind: 'other-host'; host: string } | { kind: 'userinfo'; host: string; path: string } | { kind: 'unreadable' }`; `parseRemoteUrl(url: string): RemoteUrl`; `isRemoteName(name)`; `baseOfMerge(merge: string): string | undefined`; `isLogin(login)`; `sameRepository(a, b)`; `printedRepository(repository): string` (`github.com/<o>/<r>`); `locatorRepository(iacRepo: string): GitHubRepository | undefined` (6.3.1).
- `interface ConfigEntry { scope: string; key: string }` (no value field, ever); `parseConfigListing(bytes: Buffer): ConfigEntry[]`; `refusedConfigKeys(entries): ConfigEntry[]`; `REFUSED_SECTIONS = ['url', 'credential', 'http', 'protocol', 'ssh', 'gpg', 'push']`; `REFUSED_KEYS = ['core.sshcommand', 'core.askpass', 'core.gitproxy']` and `remote.<name>.{vcs,receivepack,uploadpack,proxy,proxyauthmethod}`; `KEPT_LOCAL_KEYS = ['http.postbuffer', 'http.lowspeedlimit', 'http.lowspeedtime', 'push.default', 'push.autosetupremote', 'gpg.format']` (git's keys are case-insensitive in section and name: compared lower-cased); `configRefusal(entry: ConfigEntry, more: number): string`, the exit-2 sentence, which names a key's subsection only when it has a shape that cannot carry a credential (a URL of scheme, host, port and path alone in `url`, `http` and `credential`; a remote's name elsewhere), and elides it otherwise.
- `GH_MINIMUM_VERSION = '2.40.0'` (provisional); `parseGhVersion(stdout: string): string | undefined`; `isAtLeast(version, minimum): boolean`.
- `userAnswer`, `repositoryAnswer`, `branchAnswer`, `rulesAnswer`, `rulesetAnswer`, `refAnswer`, `commitAnswer`, `pullsAnswer`, `pullAnswer`.
- `type Missing = 'pull-request' | 'approvals' | 'last-push' | 'non-fast-forward' | 'deletion' | 'bypassable' | 'deploy-key' | 'classic-only' | 'archived' | 'no-push' | 'renamed'`; `interface ProtectionVerdict { holds: boolean; missing: readonly Missing[]; rulesets: readonly number[]; reported: { codeOwners: boolean; statusChecks: readonly string[]; signatures: boolean; mergeQueue: boolean; lastPushOnly: boolean; dismissStaleOnly: boolean; bypassActors: readonly { type: string; count: number }[] | 'unreadable'; role: 'admin' | 'maintain' | 'write' | 'read' } }` (`'read'`: a repository answering `permissions.push: false`, which fails on `no-push`); `interface ProtectionInput { expected: GitHubRepository; repository: RepositoryAnswer; rules?: RulesAnswer; rulesets: ReadonlyMap<number, RulesetAnswer>; classic?: boolean }`; `judgeProtection(input: ProtectionInput): ProtectionVerdict`; `PROTECTION_SETTINGS: readonly { level: 'required' | 'advised'; text: string }[]` (§ 8's nine lines, in its order); `protectionText(): string[]`.
- `interface PullRequestInput { message: string /* messageFor's */; request: string; road: 'from' | 'intent' | 'init' | 'phrase'; branch: string }`; `pullRequestBody(input): { title: string; body: string }`; `pullRequestUrl(repository, number): string`; `fenceFor(text): string`; `ENGINE_BLOCK_END = '<!-- idp-agent: end of the engine\'s block -->'`.
- `core/plan/clear.ts`: `Cleared.request: string` (6.2.1), what `messageFor` records, cut at 500.

**`forge/`.**
- `provider.ts`: `type LocalRoad = { kind: 'local'; why: 'no-upstream'; branch: string } | { kind: 'local'; why: 'other-host'; host: string } | { kind: 'local'; why: 'asked' }`; `interface GitHubRoad { kind: 'github'; repository: GitHubRepository; remote: string; base: string; branch: string; pushUrl: string }`; `type Road = GitHubRoad | LocalRoad`; `interface GhIdentity { login: string; role: 'admin' | 'maintain' | 'write' | undefined }` (`undefined` out of `readIdentity`: the role is the preflight's, `ProtectionVerdict.reported.role`); `interface PullRequest { host: 'github.com'; repository: string; number: number; url: string; state: 'opened' | 'open'; base: string }`; `ForgeProvider.name: 'local' | 'github'`; `Submitted` gains `pushed?: boolean`, `pullRequest?: PullRequest` and `olderBase?: string` on `created` and `already-submitted`, `statusChecks?: readonly string[]` on `created`, `kept?: string` on `refused`, plus `{ outcome: 'pushed-without-pull-request'; branch; commit; reason: string }` and `{ outcome: 'closed'; branch; number: number; merged: boolean; at: string }`; `Recognised = Extract<Submitted, { outcome: 'already-submitted' | 'refused' | 'pushed-without-pull-request' | 'closed' }>`.
- `readRoad(git: Git, options: { local: boolean }): Promise<Road>`; `githubClient(options: { env?: NodeJS.ProcessEnv; run?: GhProcess }): GhClient` (in `api.ts`, the one caller of `ghIn`, so `cli/` never loads the launcher); `readIdentity(gh: GhClient, road: GitHubRoad, purpose?: 'submission' | 'protection'): Promise<GhIdentity>`; `githubApi(gh: GhClient, repository: GitHubRepository): GitHubApi` with `user()`, `repository()`, `rules(base)`, `ruleset(id)`, `branch(base)`, `ref(branch)`, `commit(sha)`, `pulls(branch)`, `openPullRequest(input)` and `calls(): number` (the `GhClient`'s count, for `idp.forge.gh_calls`); `class GitHubAnswerError extends Error { route: GhRoute['route'] | 'open-pull-request'; status: number | 'timeout' | 'too-large' | 'unreadable' | 'paginated' }`; `GITHUB_LIMITS = { submissionMs: 180_000, ghCalls: 48, rulesets: 10, pullsPage: 100, readBack: [500, 1500], bodyBytes: 1024 * 1024 }`; `readProtection(api, road: GitHubRoad, identity): Promise<ProtectionVerdict>` (§ 8 items 1 to 5, 6.1.3); `preflight(api, road, base: Base, identity): Promise<Preflight>` with `interface Preflight { verdict: ProtectionVerdict; level: 'level' | { github: string } }`; `readRules(api, road, identity): Promise<ProtectionVerdict>` (items 2 and 3, 6.2.1); `type PushFailure = 'authentication' | 'host-key' | 'lease' | 'ruleset' | 'network' | 'other'`; `classifyPushFailure(error: GitError): PushFailure`; `openGitHubForge(input: { repo: string; local: ForgeProvider; road: GitHubRoad; identity: GhIdentity; api: GitHubApi; env: NodeJS.ProcessEnv; route: PullRequestInput['road']; git?: Git; push?: Push; wait?: (ms: number) => Promise<void>; now?: () => number }): ForgeProvider` (`git` and `push` default to `gitIn(repo, { env })` and `pushIn(repo, { env })`; a test injects failing ones); `openGitHub(input: { repo: string; env: NodeJS.ProcessEnv; gh?: GhProcess; local: boolean; git?: Git; purpose?: 'submission' | 'protection' }): Promise<GitHubSide>` in `forge/github/open.ts` (6.1.3), `interface GitHubSide { road: Road; identity?: GhIdentity; api?: GitHubApi }`, the road and, on a GitHub road, gh's identity: what `idpa protection` and every submission open first; `openSubmissionForge(input: { repo: string; repository: Repository; env: NodeJS.ProcessEnv; gh?: GhProcess; local: boolean; route: PullRequestInput['road'] }): Promise<OpenedForge>` in `forge/open.ts` (6.2.2), beside its internal `OPENS_PULL_REQUESTS` and `NOT_YET` (the interim refusals), `interface OpenedForge { forge: ForgeProvider; road: Road; github?: { identity: GhIdentity; api: GitHubApi } }`: the local forge (with `acceptOlderBase` on a GitHub road), then `openGitHub`, then `openGitHubForge`. `cli/` reaches the launchers only through these; `openLocalForge(repo, repository, git?, options?: { acceptOlderBase?: boolean })`; `treeFor(git: Git, parent: string, edits: readonly FileEdit[], format: 'sha1' | 'sha256'): Promise<string>`; `treeId(entries, format): string`; `objectFormat(git): Promise<'sha1' | 'sha256'>` (in `objects.ts`, called by both forges).

**`cli/`.**
- `MainDeps.gh?: GhProcess`.
- `SubmitOptions` gains `local?: boolean`, `env?: NodeJS.ProcessEnv`, `gh?: GhProcess`, `notice?: (line: string) => void` (where the "submitting to" line goes), and `open?: (root, repository) => Promise<OpenedForge>` (was `Promise<ForgeProvider>`): fields of `SubmitOptions` itself, since `runPlan` hands `PlanOptions.submit` on as it is; `openForSubmission(root, repository, options: SubmitOptions & { route: PullRequestInput['road'] }): Promise<Opened>`; `reopening` handing on an `OpenedForge`; `Opened` gains `road: Road` and `github?: { identity: GhIdentity; api: GitHubApi }`; `refuseUnprotected(opened, options: { json?: boolean; offerLocal?: boolean })`: Promise<CommandResult | undefined>` (runs `preflight`; a `Road` that is not GitHub's answers `undefined`; one verdict kept per forge and base commit from 6.3.1); `refuseOtherRepository(opened, config: RepositoryConfig | undefined, project: string, options?: { json?: boolean }): CommandResult | undefined` (6.3.1, the `iacRepo` cross-check); `SubmissionReport` as in Choices; `forgeAttributes(report: SubmissionReport, road: Road, calls: number): Attributes`; `SubmissionSummary.github?: { host: 'github.com'; repository: string; base: string; pushedAlready: boolean }`.
- `CommandResult.attributes?: Attributes`.
- `PreviewStatus` gains, on `submitted`, `pullRequest?: PullRequest`, `road: Road`, `olderBase?: string`, `statusChecks?: readonly string[]`, on `refused`, `kept?: string`, and two kinds: `{ kind: 'pushed-without-pull-request'; branch; repository: string; reason: string }` and `{ kind: 'closed'; branch; number; merged; at }`; `localRoadLine(road: LocalRoad): string`; `pullRequestLines(pullRequest: PullRequest, verdict: Pick<ProtectionVerdict['reported'], 'statusChecks'>): string[]` (`cli/` has no verdict at closing time: the status checks travel on `Submitted`); `NO_FORGE` removed.
- `runProtection(input: { repo: string; env: NodeJS.ProcessEnv; gh?: GhProcess; notice: (line: string) => void }): Promise<CommandResult>`; `renderProtection(verdict, road, identity): string`; `renderUnprotected(verdict, road, options?: { offerLocal?: boolean }): string` (`offerLocal` from 6.3.2); `protectionNeedsRepository(context): string` (`cli/source.ts`); `DeclarationsCommand` gains `'protection'`.
- 6.3.3: `QUESTION_NOT_SUBMITTED` and `runEntry`'s `submit?: boolean` (`cli/commands/entry.ts`); `classified(options, change, question?)` (`cli/commands/ask.ts`), the question road when the caller has another answer for one.
- `Command` gains `{ name: 'protection'; repo?: string }`; `COMMANDS` gains `'protection'`; `plan` and `init` gain `local?: true` (6.2.2), `entry` gains `submit?: true` and `local?: true` (6.3.3).

**Exact lines** (engine sentences; every `<…>` passes `inertLine`).
- stderr, the GitHub road: `submitting to github.com/<o>/<r>, into <base> (<remote>, <branch>'s upstream), as <login> (gh)`. No role: it is printed when the forge opens, before the preflight reads `permissions` (Choices); `idpa protection`'s block names the role.
- stderr, `idpa protection`: `checking github.com/<o>/<r>'s <base> (<remote>, <branch>'s upstream), as <login> (gh)`.
- stdout, local roads, in place of `NO_FORGE`: `<branch> tracks no remote: nothing pushed`; `the remote is on <host>, where this build opens no pull request: nothing pushed` (`<host>` is `this machine` for a path or a `file://` URL); `--local: nothing pushed by this run` (what this run did, never where the branch is: `--local` reads nothing on GitHub, where an earlier run without it may have pushed the same branch; 6.2.2).
- stdout, opened: `<n> file(s) · submitted as <idp-branch> on top of <base>@<sha7> · <base> untouched`, then `Pull request #<n> opened on github.com/<o>/<r>: https://github.com/<o>/<r>/pull/<n>`, then `Merging it waits for one approval of its latest commit from someone other than you. No status check is required, so a system downstream could not refuse it (ADR-0012).` or `…from someone other than you, and for the status checks <c1>, <c2>.`, then `CLOSING`.
- stdout, again: `<n> file(s) · already submitted as <idp-branch> · pull request #<n> is open · nothing written`; on an older base: `<n> file(s) · already submitted as <idp-branch> · pull request #<n> is open, on <base>@<old7>; <base> is now <new7>, and GitHub shows whether it still merges cleanly · nothing written`.
- stdout, step 11 or 12 stopped: `<n> file(s) · <idp-branch> is on github.com/<o>/<r>, and <reason>`, the reason the forge wrote, e.g. `the pull request was not opened: GitHub answered <status> through gh. Run the same command again to open it.`, or `gh did not say whether the pull request was opened. Run the same command again: it names the pull request, or opens it.`
- stdout, not level: `not submitted — github.com/<o>/<r>'s <base> is at <gh7> and this clone's <base> is at <local7>: bring them level (git pull), then run this again. If you submitted this change before, the next run names its pull request. Nothing was written.`
- stdout, unprotected: `not submitted — nothing on github.com/<o>/<r>'s <base> stops the person who would open this pull request from merging it:`, the `  missing: …` lines, `Add a ruleset on <base> (Settings → Rules → Rulesets):`, `protectionText()`, `Then run this again. Nothing was written.`; on `init --submit`'s road (6.3.2, decision 17: "with `--local` named") the last line is `Then run this again, or add --local to cut the branch in this clone only. Nothing was written.`
- the prompt, GitHub road: `Push <idp-branch> to github.com/<o>/<r> with your git, and open a pull request into <base> with your gh? Nothing is provisioned until someone else approves it and it is merged. [y/N] `; branch already pushed: `Open a pull request from <idp-branch> into <base> on github.com/<o>/<r> with your gh? The branch was pushed by an earlier run. Nothing is provisioned until someone else approves it and it is merged. [y/N] `.
- exit 2, gh (the checked-out `<branch>` is what tracks; usually both are `main`): `<branch> tracks github.com/<o>/<r>, and gh is not logged in to github.com, so idpa cannot read the rules that keep a pull request from merging unreviewed. Run \`gh auth login --hostname github.com\`, then run this again; or add --local to cut the branch in this clone only. Nothing was written.`; `gh is not installed` in place of `gh is not logged in to github.com`, with `Install it (https://cli.github.com) and run …`; `gh <v> is older than <min>, the oldest this build reads; update gh, then run this again; or add --local …`; `gh is logged in to github.com as <login>, which GitHub says is a <type>, not a person: the pull request's author would be a bot, and whoever asked could approve it. Log gh in as yourself (gh auth login --hostname github.com), or add --local … Nothing was written.`. For `idpa protection` (`purpose: 'protection'`), each is the same sentence without `; or add --local to cut the branch in this clone only` (or `, or add --local …`).
- exit 2, configuration: `this clone's own configuration sets <key> (<scope>), which would decide who pushes for you; idpa pushes only with your global git configuration. Remove it with \`git config --<scope> --unset-all <key>\`, or set it globally, then run this again. Nothing was written.` (the phrase after the comma follows the key's section: *where your push goes* for `url`, `http`, `protocol` and the `remote.*` keys, *who pushes for you* for `credential`, *what program runs during your push* for `ssh`, `gpg`, `push`, `core.*`).
- exit 2, userinfo: `<remote>'s URL carries a credential; set it to https://github.com/<o>/<r>. Nothing was written.`

**Test helpers.** `fakeGitHub(model?: FakeModel): FakeGitHub` with `.process: GhProcess`, `.as(login)`, `.logout()`, `.state`, `.sent` (each call received: argv, stdin, environment), and from 6.2.1 `.approve(number, login)`, `.pushAs(actor, ref, commit)`, `.fault({ route, status, times })`; `FAKE_GH_VERSION = '2.40.0'`; `DOORS: readonly { name: string; argv: readonly string[]; stdin?: string }[]` (gh), `GIT_DOORS` (git, full vectors), `DOOR_WORDS` (§ 6's source-level strings, which the architecture rules import rather than spell), `MERGE_DOOR` (6.2.1), all in `tests/support/fake-gh.ts`; `stubGh(options?: StubOptions)` and `stubGit(options?: StubOptions)`, each `Promise<{ bin: string; calls(): Promise<StubCall[]> }>`; `githubClone(options?: { model?: FakeModel; source?: string; repository?: string }): Promise<{ repo: string; bare: string; env: NodeJS.ProcessEnv; gh: FakeGitHub }>` (`source` and `repository` from 6.3.1), `githubForge(clone, options?)`, `fakeSsh(dir, bare, refuse?)`, `remoteRefs(bare)` (6.2.1), `unprotect(gh)`, `moveGitHubBase(clone)` (6.3.1), `openedPullRequest()` (6.4.1), in `tests/support/github-fixture.ts`; stage 5's `clone`, `clearedFor`, `committed`, `observable`, `stored`, `scratch`, `removeClones` reused as they are. 6.4.1: `tests/live/guard.ts` (`LIVE_VARIABLES`, `liveRepository`, `reviewerConfigDir`, `scrubLiveEnvironment`), `tests/live/github/doors.ts` (`LiveDoor`, `LIVE_DOORS`), `tests/support/github-answers.ts` (`Shape`, `KEPT_KEYS`, `shapeOf`, `fakeWithin`, `scrubbed`, `identifying`, `TOKEN_SHAPE`, `AnswersFile`, `answersFiles`). 6.4.2: `INVARIANT` in `tests/unit/invariant-wording.test.ts`, the one place in `tests/` that states the owner's words. 6.4.3: `FIRST_SENT` in `tests/scenarios/prompt-digests.test.ts`.

**Architecture rules** (exact titles). Renamed: *only the named modules write, and only process/git.ts and process/gh.ts start a process*. Unchanged titles, widened content: *every process src/ starts is given spawnedEnvironment* (both launchers; a `SPAWNS` entry names a list of environment functions, since `process/git.ts` makes two calls, `gitIn`'s with `gitEnvironment` and `pushIn`'s with `pushEnvironment`). New in 6.1.1: *nothing in src/ names a door the allow-list refuses*; *nothing in src/ reads a GitHub credential from the environment*; *in tests/, only tests/live/ and tests/support/fake-gh.ts name a door*. New in 6.1.2: *only forge/github/ loads the gh launcher* (`cli/` names `GhProcess` with `import type`, which is erased, as it names the forge's types today; `ghIn`'s default process is `spawnGh`, so no other module needs the launcher at run time). Their self-tests, in *the architecture rules themselves*: *refuses every way src/ can name a door*, *refuses every way src/ can read a GitHub credential*, *refuses every module but forge/github/ that loads the gh launcher*.

**Scripts and variables.** `pnpm demo:github`; `pnpm test:live:github` (`vitest run --config vitest.live.config.ts`); `FAKE_GH_STATE`; `IDP_GITHUB_LIVE_REPO`, `IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR` (read by `tests/live/` only); trace attributes `idp.forge.kind`, `idp.forge.host`, `idp.forge.repository`, `idp.forge.base`, `idp.forge.branch`, `idp.forge.pull_request`, `idp.forge.outcome`, `idp.forge.gh_calls`, `idp.forge.pushed`.

---

## Slice 6.1 — the fence and the check

Closed by 6.1.3. No command pushes or opens anything yet; `idpa protection` is the first to start gh.

### Task 6.1.1: The allow-list — two launchers, a grammar each, and a floor under every child process

**Goal.** Every git and gh command `src/` can start is one of an explicit list of shapes,
checked on the finished argument vector before any process starts (Global Constraint 2). The
git launcher keeps stage 5's shapes exactly as the forge and the Inspector build them, and gains
three reads, `merge-base --is-ancestor` and the one push form of § 4 — no road calls the push
yet, and one real push to a bare repository proves git accepts the vector the grammar pins. A
second launcher, `process/gh.ts`, starts gh in `process/git.ts`'s shape and speaks only
`--version`, eight `GET` templates and one `POST`. The suite owns every variable that could
carry a child process to GitHub (`tests/setup/forge.ts`, § 10), and removes Node's
`NODE_USE_ENV_PROXY`, so the proxy it closes for git and gh is never Node's. Three architecture
rules keep the doors and the credential names out of the source. No command changes; nothing a
person runs behaves differently.

Constraints cited: 1, 2, 6, 8, 10, 11, 12, 15.

**Branch** `feat/s6-allow-list`, cut from `docs/stage-6-plan`.

**Why the grammar changes tests that pass today.** `tests/unit/process-git.test.ts` drives the
launcher with vectors no road builds — an alias that runs `env`, another that sleeps, `log`,
`--version`, `update-ref` without `--no-deref`, `hash-object` without `-w` — and
`tests/unit/local-forge.test.ts:77,87` hash with `['hash-object', '-w', '--stdin']`. Each is now
refused. The hardening each proved is proved again through shapes the grammar admits, or through
a stub `git` on a temporary `PATH`, which records the vector, the environment and the working
directory the launcher hands it — a stronger proof of the environment than an alias, which only
showed what git hands on.

**Files:**
- Create: `src/process/refusal.ts`, `src/process/gh.ts`
- Modify: `src/process/git.ts`, `src/process/README.md`
- Create: `tests/setup/forge.ts`, `tests/support/fake-gh.ts`, `tests/support/stub-gh.ts`,
  `tools/fake-gh.ts` (the model's first part: accounts, the session, `--version`, `GET user`, its
  own argv grammar; no executable entry yet, 6.1.3 adds it)
- Create: `tests/unit/process-gh.test.ts`, `tests/unit/launcher-doors.test.ts`,
  `tests/unit/fake-gh.test.ts`, `tests/unit/live-config.test.ts`
- Modify: `tests/unit/process-git.test.ts`, `tests/unit/offline.test.ts`,
  `tests/unit/local-forge.test.ts` (`:77`, `:87`, `:501`), `tests/architecture/dependencies.test.ts`
- Modify: `vitest.config.ts`, `tests/setup/personal.ts` (its comment on `HOME`), `tests/README.md`
- Modify: `AGENTS.md` (the rule count, 25 → 28; the process sentence; the layering line for
  `process/`; the test count), `docs/design.md` §5.5 (the count reads "twenty-three" on
  `2b2250e`, two short of the 25 measured: corrected to twenty-eight, with the three rules named),
  `SECURITY.md` (`:164` and `:165`, the rows that name the one process starter), README's badge
- Modify: `CHANGELOG.md`, `docs/roadmap.md`

**Interfaces** (the shared names; nothing renamed):

```typescript
// src/process/refusal.ts
export class LauncherRefusal extends Error // name 'LauncherRefusal'; `git <word> is not a command idp-agent runs`

// src/process/git.ts — added beside gitIn, gitEnvironment, HARDENING, GIT_LIMITS, GitError
export function checkGitArgv(args: readonly string[]): void           // the FULL vector execFile receives
export const SUBMISSION_REF: RegExp                                    // /^refs\/heads\/idp-agent\/[a-z0-9-]+-[0-9a-f]{8}$/
export const GITHUB_PUSH_URL: RegExp                                   // the five forms of § 13
export const PUSH_PINS: readonly string[]                              // '-c', 'protocol.ext.allow=never', …
export const PUSH_FLAGS: readonly string[]                             // '--porcelain', '--no-verify', …
export const PUSH_LIMITS: GitLimits                                    // { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 }
export const PUSH_VARIABLES: readonly string[]                         // GIT_SSH_COMMAND, GIT_SSH, GIT_SSH_VARIANT, GIT_ASKPASS
export interface PushRequest { url: string; commit: string; branch: string }
export type PushFlag = 'created' | 'up-to-date' | 'rejected'
export interface PushOutcome { flag: PushFlag; summary: string }       // `summary`: ADDED, see below
export type Push = (request: PushRequest) => Promise<PushOutcome>
export function pushEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function parsePorcelain(stdout: Buffer, ref: string): PushOutcome
export function pushIn(repo: string, options?: { env?: NodeJS.ProcessEnv; limits?: GitLimits }): Push

// src/process/gh.ts
export type GhRoute = …; export type GhRequest = …                    // as the shared names state them
export interface GhLimits { readonly timeoutMs: number; readonly maxOutputBytes: number }
export const GH_LIMITS: GhLimits                                       // { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 }
export const GH_REMOVED: readonly string[]; export const GH_SET: Readonly<Record<string, string>>
export function ghEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function encodeRefPath(ref: string): string
export function ghArgv(request: GhRequest): string[]
export function checkGhArgv(argv: readonly string[], stdin?: Buffer): void
export interface GhExit { code: number | string | undefined; stdout: Buffer; stderr: string; timedOut: boolean }
export type GhProcess = (argv: readonly string[], options: { stdin?: Buffer; env: NodeJS.ProcessEnv; limits: GhLimits }) => Promise<GhExit>
export const spawnGh: GhProcess
export interface GhAnswer { status: number; hasNext: boolean; body: string }
export function parseIncluded(stdout: Buffer): GhAnswer | undefined
export class GhError extends Error { readonly kind: 'missing' | 'auth' | 'timeout' | 'too-large' | 'unreadable' | 'failed' }
export interface GhClient { version(): Promise<string>; get(route: GhRoute): Promise<GhAnswer>; openPullRequest(owner: string, name: string, body: string): Promise<GhAnswer>; calls(): number }
export function ghIn(options?: { env?: NodeJS.ProcessEnv; run?: GhProcess; limits?: GhLimits }): GhClient

// tests/support/fake-gh.ts
export const FAKE_GH_VERSION = '2.40.0'
export function fakeGitHub(model?: FakeModel): FakeGitHub              // .process, .as(login), .logout(), .state, .sent (ADDED)
export const DOORS: readonly Door[]                                    // gh vectors of § 6's "Never"
export const GIT_DOORS: readonly Door[]                                // ADDED: git vectors of § 6's "Never"
export const DOOR_WORDS: readonly string[]                             // ADDED: § 6's source-level door strings
// tests/support/stub-gh.ts
export function stubGh(options?: StubOptions): Promise<{ bin: string; calls(): Promise<StubCall[]> }>
export function stubGit(options?: StubOptions): Promise<{ bin: string; calls(): Promise<StubCall[]> }>   // ADDED
```

Four names are added to the shared names, each needed here:
`PushOutcome.summary` (with `--porcelain`, git writes a rejected ref's `[rejected] (stale info)`
or `[remote rejected] (push declined due to repository rule violations)` on **stdout**, the one
line `pushIn` parses, so 6.2.1's lease and ruleset cases are told apart from the outcome, never
from printed text); `GIT_DOORS` (the git half of § 6's "Never", in `Door`'s shape);
`DOOR_WORDS` (the architecture rules cannot spell the words they refuse without refusing
themselves, so they import them from the one file of `tests/` allowed to name a door); and
`stubGit` (the recording stub, for `git`, which the rewritten process-git tests need).
`FakeGitHub.sent` records each call the fake received (argv, stdin, environment): the key-reach
leg of 6.1.3 reads it.

- [x] **Step 1: The floor's legs, failing first** (`tests/unit/offline.test.ts`)

`vitest.config.ts`'s `env` gains `GIT_SSH_COMMAND: 'set-aside-by-vitest-config'` and
`GH_TOKEN: 'set-aside-by-vitest-config'`, as it already sets one `IDP_` name and one key: real
names this time, because `forge.ts` removes them even while a scenario records, so a recording
shell keeps nothing of them either. A new `describe("the child processes' floor")`:

1. *removes every variable that can carry a child process to GitHub* — none of `GIT_SSH`,
   `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `SSH_ASKPASS`,
   `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`,
   `GH_REPO`, `NO_PROXY`, `no_proxy` is in `process.env`, compared by name whatever its case.
   *Fails today:* the config's `GIT_SSH_COMMAND` and `GH_TOKEN` are still there.
2. *points HOME, XDG_CONFIG_HOME and GH_CONFIG_DIR into the run directory* — each is under
   `tmpdir()` and holds no file. *Fails today:* `HOME` is the developer's, `GH_CONFIG_DIR` unset.
3. *closes every proxy* — `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`,
   `all_proxy` are each `http://127.0.0.1:9`. *Fails today:* unset, or the developer's.
4. *keeps the system configuration from the tests' own git* — `GIT_CONFIG_NOSYSTEM` is `1`.
5. *puts a gh and an ssh that fail loudly first on PATH* — `PATH`'s first entry is the guard
   directory; resolving `gh` and then `ssh` along `PATH` (by `stat`, in this test, before
   anything runs) finds the guard's; only then each is run, and exits `97` saying what started
   it. *Fails today:* the first `gh` on `PATH` is whatever the machine has; the test stops
   there without running it.
6. *refuses to run where the system configuration could carry a push elsewhere* — the
   launcher removes every `GIT_*`, `GIT_CONFIG_NOSYSTEM` included, so every git it starts reads
   the machine's system file, and a key there outranks the environment the floor sets: a
   `core.sshCommand` replaces the fixture's ssh, an `http.proxy` or `http.<url>.proxy` replaces
   the closed `HTTPS_PROXY` (git's configuration outranks the proxy variables), and a
   `url.<base>.insteadOf` or `.pushInsteadOf` can turn the fixture's `git@github.com:` URL into
   an `https://` one, which the Xcode git's system file then answers with
   `credential.helper=osxkeychain`. So `git config --system --includes --show-origin
   --get-regexp '^(core\.sshcommand|http\..*proxy|url\..*\.(push)?insteadof)$'`, with every
   `GIT_*` removed from that one call's environment as the launcher removes them, exits 1
   (nothing set); otherwise the test fails naming each key and the file `--show-origin`
   printed, never a value. Passes on a clean machine today and stays; it is the suite's refusal
   to trust that every push test used the fixture (§ 10). The fixture holds the other half:
   `githubClone` (6.2.1) and `process-git.test.ts`'s push cases check, before they return, that
   the push URL they hand over is an ssh form (`git@github.com:` or a path the fake ssh
   serves), and `githubClone` also runs the test-side `git remote get-url --push origin` in the
   launcher's environment — which expands `insteadOf` and `pushInsteadOf` from every file git
   reads, and talks to no remote — and fails unless it answers `git@github.com:acme/iac.git`.
7. *removes Node's proxy switch, and leaves the closed proxy to git and gh* — `process.env`
   holds no `NODE_USE_ENV_PROXY` when the test starts, whatever the shell exported; the test
   then sets `NODE_USE_ENV_PROXY=1`, runs the setup again (`vi.resetModules()`, then a dynamic
   `import` of `tests/setup/forge.ts`, putting back after it the `PATH` the second run prefixed
   again), and finds the switch gone, compared by name whatever its case, while row 3's six
   variables still read `http://127.0.0.1:9`. Set by the test rather than by
   `vitest.config.ts`'s `env` as row 1's are: a worker started with the switch would read the
   shell's proxy variables as it started. Node reads the switch, and the proxy variables with it,
   when a process starts: the worker's own `fetch`, where a recording's provider call is made,
   was set up before this file closed the proxy, and the switch, removed here always, a scenario
   being recorded included, reaches no Node process the suite starts after it. So no Node `fetch`
   is sent to the closed port, while git and gh, which read the proxy variables themselves,
   still see them. *Fails today:* there is no setup to run again, and a switch the shell
   exported reaches every Node process the suite starts.

- [x] **Step 2: `tests/setup/forge.ts`, and `HOME` moved**

```typescript
/**
 * The suite owns every variable that can carry a child process to GitHub (§ 10).
 * `offline.ts` blocks the network in THIS process; a child opens its own
 * sockets, and a developer's exported GIT_SSH_COMMAND outranks every
 * core.sshCommand, so a push test would otherwise reach the real
 * git@github.com with their own key. Applied in every worker, a scenario being
 * recorded included, as a catalogue's variables are (`shell.ts`).
 */
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const FORGE_REMOVED = [
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'SSH_ASKPASS',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO',
  'NO_PROXY',
] as const
export const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const
/** The discard port on loopback: nothing listens, so a proxied request fails at once. */
export const CLOSED_PROXY = 'http://127.0.0.1:9'
export const GUARD_EXIT = 97
/**
 * Node's own switch for reading the proxy variables, read when a process starts. The closed
 * proxy is for git and gh: without the switch, no Node process the suite starts sends its
 * `fetch` there (this worker's own was set up before this file ran, and a recording's provider
 * call is made there), so a recording shell has nothing to unset.
 */
const NODE_PROXY_SWITCH = 'NODE_USE_ENV_PROXY'

const removed = new Set<string>([...FORGE_REMOVED, NODE_PROXY_SWITCH])
for (const name of Object.keys(process.env)) {
  if (removed.has(name.toUpperCase())) delete process.env[name]
}
for (const name of PROXY_VARIABLES) process.env[name] = CLOSED_PROXY
process.env['HOME'] = path.join(tmpdir(), 'home')
process.env['GH_CONFIG_DIR'] = path.join(tmpdir(), 'gh-config')
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
mkdirSync(process.env['HOME'], { recursive: true })

/** One directory per worker, written once and renamed into place: two workers never race on a file. */
const guard = path.join(tmpdir(), `guard-bin-${process.pid}`)
if (!existsSync(guard)) {
  const staging = `${guard}.${Date.now()}`
  mkdirSync(staging, { recursive: true })
  for (const [program, why] of [
    ['gh', 'a test reaches gh only through the fake (tests/support/fake-gh.ts), injected as MainDeps.gh'],
    ['ssh', 'a push test reaches its bare repository through a fake ssh named by GIT_SSH_COMMAND'],
  ] as const) {
    const file = path.join(staging, program)
    writeFileSync(file, `#!/bin/sh\necho "the test suite started ${program}: ${why}" >&2\nexit ${GUARD_EXIT}\n`)
    chmodSync(file, 0o755)
  }
  renameSync(staging, guard)
}
process.env['PATH'] = `${guard}${path.delimiter}${process.env['PATH'] ?? ''}`
```

`vitest.config.ts`: `setupFiles` gains `'tests/setup/forge.ts'`, fourth, after `personal.ts`;
`exclude: [...configDefaults.exclude, 'tests/live/**']` (`configDefaults` from
`vitest/config`: an `exclude` of our own replaces vitest's defaults, `node_modules` among them,
so they are spread first). `tests/setup/personal.ts`'s comment ("HOME and APPDATA are never
reached and are left alone") says `forge.ts` now moves `HOME`, and why.

**Measure `HOME` moved, before anything else is built.** The launcher removes every `GIT_*`,
so it reads `$HOME/.gitconfig`; stage 5's fixtures set the identity locally (`committed()`),
and nothing should have leaned on the developer's global file. Run, with `df -h "$TMPDIR"`
first (Constraint 11), the suites that name `HOME`:

```bash
pnpm vitest run tests/unit/local-forge.test.ts tests/unit/process-git.test.ts tests/unit/plan-command.test.ts tests/unit/init-command.test.ts tests/unit/personal-config.test.ts tests/invariants/forge.test.ts
pnpm vitest run tests/unit/plan-intent.test.ts tests/unit/configured-source.test.ts tests/unit/entry.test.ts tests/unit/backstage-read.test.ts tests/unit/two-resolutions.test.ts tests/unit/project-tracked.test.ts tests/unit/spawned-environment.test.ts tests/contract/key-reach.test.ts
pnpm vitest run tests/unit/ask-commentary.test.ts tests/unit/backstage-source.test.ts tests/unit/declarations-repository.test.ts tests/unit/env-example.test.ts tests/unit/offline.test.ts
```

The first line is drift row 12's list; the second and third are every other file that names
`HOME`: `grep -rln HOME tests/unit tests/contract tests/invariants tests/scenarios
tests/architecture` prints sixteen files on `2b2250e`, and the three lines hold them all
(`init-command`, `local-forge` and `tests/invariants/forge` are drift row 12's without naming
it). Step 11's full `pnpm test` is what catches a file this list missed. A failure here
is a test that read the developer's global configuration: it is fixed in the test (its own
identity, its own `HOME`), never by leaving `HOME` alone.

`process-git.test.ts`'s identity case reads the system file with
`execFile('git', ['config', '--system', …])` and `process.env`, which now holds
`GIT_CONFIG_NOSYSTEM=1`: it would read nothing, conclude no identity is configured, and then
see the launcher (which drops `GIT_*`) succeed on a machine whose system file holds one. Its
`system()` helper now calls git with every `GIT_*` removed, as the launcher does.

- [x] **Step 3: The git grammar and the push, failing first** (`tests/unit/process-git.test.ts`)

The existing cases move onto shapes the grammar admits, each keeping the hardening it proves:

| Case | On `2b2250e` | Now |
|---|---|---|
| inherited `GIT_DIR` | `rev-parse --absolute-git-dir` | `rev-parse --verify --quiet HEAD^{commit}`, the other repository holding one more commit, so the two answers differ |
| hooks | `update-ref refs/heads/idp-agent/probe HEAD ""` | `update-ref --no-deref -m 'idp-agent: submitted for review' refs/heads/idp-agent/probe-0123abcd <HEAD's sha> ""` |
| planted `git` | `rev-parse HEAD` | `rev-parse --verify --quiet HEAD^{commit}` |
| environment | alias `env` running `!env` | `stubGit()` first on `PATH`: the recorded environment holds no provider key, no `IDP_BACKSTAGE_*`, no `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, keeps `PATH`, and the recorded working directory is `path.dirname(process.execPath)` |
| identity | unchanged, `var GIT_COMMITTER_IDENT` | the `system()` helper without `GIT_*` (Step 2) |
| stdin byte for byte | `hash-object --stdin --no-filters` | `hash-object -w --stdin --no-filters` |
| git missing | `--version`, `PATH: ''` | `rev-parse --is-inside-work-tree`, `PATH: ''` |
| output bound | `log --format=%H%H%H`, 8 bytes | `rev-parse --verify --quiet HEAD^{commit}` (41 bytes), 8 bytes |
| time bound | alias `slow` running `!sleep 2` | `stubGit({ sleepMs: 2000 })`, `timeoutMs: 100` |
| git's words out of the message | `rev-parse --verify refs/heads/no-such-branch` | `rev-parse --verify --quiet refs/heads/idp-agent/none-0123abcd^{commit}`: message `git rev-parse failed`, code `1` |

New cases, each failing on `2b2250e` for the reason given:

- *admits every vector stage 5 builds, and nothing else* — each shape of the table below,
  through `checkGitArgv` over the full vector (`[...HARDENING, '-C', repo, ...args]`), does not
  throw; every entry of `GIT_DOORS` throws `LauncherRefusal`. *Fails:* `checkGitArgv` does not
  exist.
- *refuses before git starts* — `gitIn(repo, { env: stubbed })(['fetch'])` rejects
  `LauncherRefusal` with the message `git fetch is not a command idp-agent runs`, and the stub
  recorded no call. *Fails:* the stub records `fetch`: `gitIn` runs any vector today.
- *reads a remote's name only after `--`* — `remote get-url --all -- origin` passes;
  `remote get-url --all origin` and `remote get-url --all -- --push` are refused (§ 10's named
  case: a remote called `--push`, which `git check-ref-format refs/remotes/--push/HEAD` accepts,
  measured).
- *pushes the one form, and only it* — `pushIn(repo, { env: stubbed })` hands the stub exactly
  `[...HARDENING, ...PUSH_PINS, '-C', repo, 'push', ...PUSH_FLAGS,
  '--force-with-lease=refs/heads/idp-agent/x-0123abcd:', 'git@github.com:acme/iac.git',
  '<sha>:refs/heads/idp-agent/x-0123abcd']`; a request whose URL is `git@evil.example:acme/iac.git`,
  `https://x:y@github.com/acme/iac.git` or `-uhttps://github.com/acme/iac`, whose branch is `main`
  or `idp-agent/X`, or whose commit is 7 hex, is refused and the stub records nothing. *Fails:*
  `pushIn` does not exist.
- *hands the push its four variables, and every call none* — `pushEnvironment({ … })` keeps
  `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT`, `GIT_ASKPASS` (any case) and drops every other
  `GIT_*`, every key, every `IDP_BACKSTAGE_*`, sets the four of `gitEnvironment`; `gitEnvironment`
  still drops all four. Through the stub, the same.
- *really pushes, create-only, and says what happened* — a bare repository in the run
  directory, a fake ssh written by the test (`#!/bin/sh` that ignores its arguments and `exec`s
  `git receive-pack <bare>`), `GIT_SSH_COMMAND` naming it and `GIT_SSH_VARIANT=ssh` in the
  environment handed to `pushIn`: pushing HEAD's commit to `idp-agent/x-0123abcd` answers
  `{ flag: 'created' }` and the bare repository holds the ref at that commit; pushing the same
  commit again answers what git 2.46 answers (measured when built, `'up-to-date'` or `'rejected'`
  with a `stale info` summary — § 4's table admits both, and the test pins the one measured);
  pushing another commit to the same name answers `'rejected'`, and the bare repository's ref
  is unchanged. A `pre-push` hook planted in the clone leaves no mark. Why a real push in a
  pull request that opens no road: the grammar pins a vector nothing calls yet, and only git can
  say the vector is one it runs.
- *reads the porcelain line of its ref, and no other* — `parsePorcelain` over `*`, `=`, `!` lines
  (with and without a second ref's line, with `\r`), a `' '` (fast-forward) or `+` line, and no
  line at all: the three flags, and a `GitError` for the others.

**The grammar**, § 6's shapes written out. Tokens: `HEX` is 40 or 64 lower-case hex;
`SUB` is `SUBMISSION_REF`; `BRANCH` is a branch name (`^(?![-.])` 1 to 255 bytes of no control
(`\p{Cc}`), no format character (`\p{Cf}`: the bidi overrides and isolates, U+200B–U+200F and
U+2060–U+2064 among them), no space, `~ ^ : ? * [ \ { } %`, no `..`, `@{`, `//`, `/.`, no `.lock`
component, not ending in `/` or `.`) — git accepts a bidi override in a branch name, and a
hostile `branch.main.merge` would otherwise carry one past `inertLine`, which cleans only the
terminal, into `--json`'s `pullRequest.base`, the `idp.forge.base` attribute and the `POST`'s
`base`, as the project refuses those characters in `--iac-repo` and `--environment`; `REMOTE` is `^(?![-.])[A-Za-z0-9._/-]{1,100}$`. The vector is `HARDENING`, then `-C`
and an absolute path that does not begin with `-`, then exactly one of:

| # | Shape | Who builds it |
|---|---|---|
| 1 | `rev-parse --is-inside-work-tree` · `--show-prefix` · `--show-object-format` · `--show-toplevel` | `openLocalForge`, `project-fs` |
| 2 | `rev-parse --verify --quiet` (`HEAD^{commit}` or `SUB^{commit}`) | `base()`, `existing()` |
| 3 | `rev-parse HEX^{tree}` | `submit()`, 6.2.1's `treeFor` |
| 4 | `var GIT_AUTHOR_IDENT` · `var GIT_COMMITTER_IDENT` | `openLocalForge` |
| 5 | `symbolic-ref --quiet` (`HEAD` or `SUB`) | `base()`, `existing()` |
| 6 | `rev-list --parents -n 1 HEX` | `existing()` |
| 7 | `diff-tree -r -z --name-only --no-renames HEX HEX` | `existing()` |
| 8 | `cat-file commit HEX` | `existing()` |
| 9 | `check-ref-format SUB` · `check-ref-format refs/remotes/REMOTE/HEAD` · `check-ref-format --branch BRANCH` | `submit()`; 6.1.2's `readRoad` |
| 10 | `hash-object -w --stdin --no-filters` · `mktree -z` | `submit()`, `writeTree` |
| 11 | `commit-tree HEX -p HEX -F -` | `submit()` |
| 12 | `update-ref --no-deref -m idp-agent: submitted for review SUB HEX` and an empty last argument | `submit()`, ADR-0010 |
| 13 | `ls-tree -r -z --full-tree HEX` · `ls-tree -z HEX` | `treeOf`, `writeTree` |
| 14 | `ls-files -z --cached` | `project-fs` |
| 15 | `config --list --show-scope -z` · `config --get branch.BRANCH.remote` · `config --get branch.BRANCH.merge` | 6.1.2 |
| 16 | `remote get-url --all -- REMOTE` · `remote get-url --push --all -- REMOTE` | 6.1.2 |
| 17 | `merge-base --is-ancestor HEX HEX` | 6.2.1 |

and the push, whose vector is `HARDENING`, then `PUSH_PINS`, then `-C` and the path, then
`push`, `PUSH_FLAGS` in order, one `--force-with-lease=SUB:` with nothing after the colon, one
URL matching `GITHUB_PUSH_URL`, and one refspec `HEX:SUB` whose ref equals the lease's. The
`check-ref-format` shapes of rows 9 and 16's names arrive with the grammar although 6.1.2 is
their first caller, so the allow-list lands whole, once (§ 16: "the push form included though
no road calls it yet"). A branch name holding `%` is legal in git and outside `BRANCH`: `%`
would be read as an escape in the gh paths of 6.1.3, and 6.1.2's `readRoad` refuses such a
branch by name before it reaches the launcher. `branchFor` (`clear.ts:433-445`) always
produces a name `SUBMISSION_REF` matches: `[a-z0-9]` runs joined by `-`, at most 48, then `-`
and 8 hex.

```typescript
/** A token of a shape: a literal, or a predicate over one argument. */
type Token = string | ((word: string) => boolean)

const SHAPES: readonly (readonly Token[])[] = [
  ['rev-parse', '--is-inside-work-tree'],
  // … one entry per row above, each alternative its own entry …
  ['update-ref', '--no-deref', '-m', 'idp-agent: submitted for review', isSubmissionRef, isHex, ''],
  ['remote', 'get-url', '--all', '--', isRemoteName],
  ['remote', 'get-url', '--push', '--all', '--', isRemoteName],
]

const matches = (args: readonly string[], shape: readonly Token[]): boolean =>
  args.length === shape.length &&
  shape.every((token, at) => (typeof token === 'string' ? args[at] === token : token(args[at] ?? '')))

export function checkGitArgv(argv: readonly string[]): void {
  const word = subcommandOf(argv)            // the word after `-C <path>`, or `(none)`
  const refuse = (): never => { throw new LauncherRefusal('git', word) }
  // HARDENING first, element for element; then the push, or `-C` and a read or write shape.
  …
}
```

`gitIn` calls `checkGitArgv` on the vector it is about to hand `execFile`, inside the promise
and before the call; a refusal rejects the promise and nothing starts. `pushIn` does the same,
with `pushEnvironment(options.env)` and `PUSH_LIMITS`; it resolves `parsePorcelain(stdout, ref)`
whatever git's exit code (git exits 1 on a `!` line), and rejects a `GitError` only when no
porcelain line names the ref — nothing reached the remote: authentication, host key, network.
`parsePorcelain` switches on the flag character with `const _exhaustive: never` over `PushFlag`
where it maps back (Constraint 15).

- [x] **Step 4: The gh launcher, failing first** (`tests/unit/process-gh.test.ts`)

`tests/support/stub-gh.ts` writes a `gh` (and, for `stubGit`, a `git`) into a scratch directory:
a `#!/bin/sh` script that appends `{ argv, cwd, names, env }` as one JSON line to `calls.jsonl`
beside it (through `node -e`, so no shell quoting is involved) — `names` every variable's name
in the child's environment, sorted, and `env` the **values of the names `StubOptions.values`
lists only** (default `['PATH', 'HOME']`; a case adds the names it asserts a value of: its
canaries, `GH_SET`'s, `LC_ALL`, `GIT_OPTIONAL_LOCKS`, `GIT_TERMINAL_PROMPT`). A launcher handed
`process.env`, as `gitIn`'s default is, passes on whatever the developer exported that
`spawnedEnvironment` keeps — an `NPM_TOKEN`, a cloud credential — and the suite leaves its
temporary directories behind (Constraint 11), so the file on disk holds no value nobody asked
for; an assertion that a variable is absent reads `names`. Every file using a stub removes its
directory in `afterEach`. Then, per `StubOptions`, sleeps
`sleepMs`, prints `stdout` (default `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{}`),
prints `stderr`, and exits `exit` (default 0). `bin` is the directory, to be put first on
`PATH`. Each case fails on `2b2250e` because `src/process/gh.ts` does not exist; what each
then holds:

- *starts gh by name, from the neutral directory, with the grammar's vector* — `ghIn({ env })`
  with the stub first on `PATH`: `get({ route: 'user' })` records exactly
  `['api', '--hostname', 'github.com', '--method', 'GET', '--include', 'user']`, `cwd`
  `path.dirname(process.execPath)`, and resolves `{ status: 200, hasNext: false, body: '{}' }`.
- *hands gh § 5's environment* — handed `GH_TOKEN` and `GITHUB_TOKEN` canaries, a provider key,
  `IDP_BACKSTAGE_TOKEN`, `GH_HOST`, `GH_REPO`, `GH_DEBUG=api`, `DEBUG`, `GODEBUG=http2debug=2`,
  `GH_FORCE_TTY`, `CLICOLOR_FORCE`, `GH_ENTERPRISE_TOKEN`, `gh_host` (lower case), `GIT_DIR`,
  `SSH_AUTH_SOCK`, `GH_CONFIG_DIR`, `HTTPS_PROXY`: the stub's environment holds both tokens
  **unchanged** (gh's own login, § 5), `SSH_AUTH_SOCK`, `GH_CONFIG_DIR` and `HTTPS_PROXY`, none of
  the others, and every pair of `GH_SET`.
- *is idempotent in its environment* — `ghEnvironment(ghEnvironment(env))` equals
  `ghEnvironment(env)`: `ghIn` builds it, and `spawnGh` builds it again from what it is handed
  (the architecture rule wants the call site to name `ghEnvironment(`), so a fake sees what gh
  would.
- *writes the pull request's body to stdin, never to an argument* — `openPullRequest('acme',
  'iac', body)` records the POST vector ending `'--input', '-'`, and the stub's stdin (it copies
  stdin to `stdin.bin`) is `body`'s bytes.
- *reads the status from the included head, not from the exit code* — a stub printing
  `HTTP/2.0 404 Not Found` with a body and exiting 1 resolves `{ status: 404, … }`; one
  printing a `Link: <…>; rel="next"` header resolves `hasNext: true`.
- *names what failed, and never gh's words* — exit 4 with nothing on stdout: `GhError`
  `auth`; `PATH: ''`: `missing`; `sleepMs: 2000` against `timeoutMs: 100`: `timeout`; 2 KiB against
  `maxOutputBytes: 1024`: `too-large`; exit 0 with no status line: `unreadable`; exit 1 with no
  status line and `stderr` holding a canary: `failed`, and neither the canary nor any stderr is
  in the message (`gh api failed`, `gh --version failed: timed out`).
- *counts what it starts* — after three calls and one refused request, `calls()` is 3.
- *parses gh's included answer* — `parseIncluded` over `HTTP/2.0 200 OK`, `HTTP/1.1 201 Created`
  with `\n` line ends, headers in any case, a `Link` header with `rel="next"` among other
  relations, and `undefined` for no status line, a status that is not three digits, and a head
  with no blank line after it.

**`GhRoute`'s paths** (`ghArgv`, a `switch` over `route.route` with `const _exhaustive: never`):

| Route | Path |
|---|---|
| `user` | `user` |
| `repository` | `repos/<o>/<r>` |
| `branch` | `repos/<o>/<r>/branches/<encodeRefPath(branch)>` |
| `rules` | `repos/<o>/<r>/rules/branches/<encodeRefPath(branch)>?per_page=100` |
| `ruleset` | `repos/<o>/<r>/rulesets/<id>` |
| `ref` | `repos/<o>/<r>/git/ref/heads/<encodeRefPath(branch)>` |
| `commit` | `repos/<o>/<r>/git/commits/<sha>` |
| `pulls` | `repos/<o>/<r>/pulls?head=<encodeURIComponent(o + ':' + head)>&state=all&per_page=100` |

`encodeRefPath` splits on `/`, `encodeURIComponent`s each component and joins with a literal `/`
(`release/1` stays `release/1`; `a+b` becomes `a%2Bb`). `checkGhArgv` holds the vector to
exactly `['--version']`, the `GET` form above with no stdin, or the `POST` form with a stdin;
refuses any `{` or `}` in the path before anything else (gh fills `{owner}`, `{repo}` and
`{branch}` from the current directory or `GH_REPO`, § 6); decodes each value and holds it to
its grammar — owner `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`, name `^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$`,
a branch to `BRANCH` or to the bare submission branch (`idp-agent/<slug>-<8 hex>`), an id to
`^[1-9][0-9]{0,15}$`, a sha to `HEX` — and requires the encoded form to be exactly the one
`encodeRefPath` or `encodeURIComponent` would write (so `release%2F1` is refused: § 10 names
`release/1` among the cases). The `POST` stdin parses as a JSON object with exactly `title`
(1 to 256 characters, no control character), `head` (the bare submission branch, never
`owner:branch`), `base` (`BRANCH`), `body` (a string of at most 1 MiB), `draft: false` and
`maintainer_can_modify: false`. These grammars are copies of `core/github/remote.ts`'s (6.1.2),
because `process/` imports nothing of ours; 6.1.2's agreement test holds the copies to one
answer. No gh route takes a login, so `process/gh.ts` holds no login grammar.

```typescript
/**
 * The second process src/ starts, held to git.ts's shape (§ 6): execFile, no
 * shell, Node's own directory, a timeout and a cap, an environment from
 * spawnedEnvironment. It cannot import git.ts — only project-fs and forge/
 * may load the git launcher — so NEUTRAL_DIRECTORY is its own copy.
 */
const NEUTRAL_DIRECTORY = path.dirname(process.execPath)

export const spawnGh: GhProcess = (argv, options) =>
  new Promise((resolve) => {
    const child = execFile(
      'gh',
      [...argv],
      {
        cwd: NEUTRAL_DIRECTORY,
        env: ghEnvironment(options.env),
        encoding: 'buffer',
        timeout: options.limits.timeoutMs,
        maxBuffer: options.limits.maxOutputBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error === null ? 0 : (error.code ?? undefined),
          stdout,
          stderr: stderr.toString('utf8'),
          timedOut: error?.killed === true,
        }),
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.stdin)
  })
```

`ghIn` builds the vector with `ghArgv`, checks it with `checkGhArgv(argv, stdin)`, counts it, and
only then calls `options.run ?? spawnGh` with `{ env: ghEnvironment(options.env), limits,
stdin }`, so an injected fake never sees a vector the grammar refused. `ghEnvironment` is
`spawnedEnvironment(env)` minus every name `GH_REMOVED` lists (an entry ending `*` is a prefix,
`GIT_*`), compared by upper-cased name and never indexed, plus `GH_SET`.

- [x] **Step 5: The doors and the fake, failing first**

`tests/support/fake-gh.ts` holds three lists, the only file of `tests/` besides `tests/live/`
the door rule lets name one:

- `DOORS` (gh): `pr merge` in each of `--merge`, `--squash`, `--rebase`; `pr merge --admin`;
  `pr review --approve`; `pr close`; `pr create`; `auth token`; `auth status`; `repo view`;
  `ruleset list`; `workflow run`; `extension install`; `alias set`; `browse`; `api` with
  `--method PUT` on `…/pulls/1/merge`, `PUT …/pulls/1/merge-async`, `POST …/merges` (stdin
  `{"base":"main","head":"idp-agent/x-0123abcd"}`), `PUT …/contents/catalog/x.yml`, `PATCH
  …/git/refs/heads/main`, `DELETE …/git/refs/heads/idp-agent/x-0123abcd`, `POST graphql`, `POST
  …/pulls/1/reviews`, `PUT …/pulls/1/update-branch`; a `GET` with `-f`, `-F x=@file`, `--field`,
  `--raw-field`, `--paginate`, `--verbose`, `-H`, `--cache 1h`, `--jq .`, `--template`,
  `--input file`, or a stdin; `--hostname evil.example` and `--hostname github.com.evil.example`;
  a `GET` with no `--method`; the same flags in another order; paths holding `{owner}`,
  `{branch}`, `..`, `release%2F1`, an owner `-acme`, a ruleset id `0`, a sha of 7 hex; and the
  `POST` pulls body with `head` `acme:idp-agent/x-0123abcd`, `head` `main`, `base` `{branch}`, an
  extra key `merge_method`, `draft: true`, `maintainer_can_modify: true`.
- `GIT_DOORS` (full vectors): `push` with `--force`, `-f`, `+<sha>:<ref>`, `--delete`, `-d`,
  `--mirror`, `--all`, `--tags`, `--prune`, `--follow-tags`, `--set-upstream`, a second refspec,
  the remote's name in place of the URL, a ref outside `idp-agent/`, a lease naming another ref,
  a lease with a value, no lease, a URL of another host, with userinfo, beginning with `-`,
  `--receive-pack=…`, `--exec=…`, `-o …`, `--repo=…`, a pin missing, a flag missing; and
  `fetch`, `pull`, `clone`, `merge`, `rebase`, `reset --hard`, `checkout`, `branch -D`, `tag`,
  `update-ref -d`, `update-ref` without its empty old value, `update-ref` of `refs/heads/main`,
  `credential fill`, `config user.name x`, `config --unset …`, `config --get credential.helper`,
  `remote add`, `remote get-url origin` (no `--`), an extra `-c core.hooksPath=/tmp/h`, a missing
  `HARDENING` element, `--git-dir=…`, a relative path after `-C`, `symbolic-ref HEAD
  refs/heads/x` (a write).
- `DOOR_WORDS`: `pr merge`, `--admin`, `/merge`, `merge-async`, `/merges`, `/contents/`, `/graphql`,
  `/reviews`, `update-branch`, `auth token`, `--mirror`, `--delete`, `--tags`, `--force`, and the
  three write methods `PUT`, `PATCH`, `DELETE` as whole upper-case words — § 6's list for the
  source, with
  the most direct door of all (`PUT repos/{o}/{r}/pulls/{n}/merge`) and the write methods, which
  the grammar refuses at run time and the source has no reason to spell (measured on
  `2b2250e`: no file under `src/` or `tests/` holds any of them; Constraint 2 already lists
  them, and `merge-async` is the door 6.4.1's live test tries). `/merge` is bounded
  after (`(?![\w-])`), so it matches neither `/merges` nor `/merge-base`; `merge-base` itself
  starts with no `/`.

`tests/unit/launcher-doors.test.ts` (fails: neither `checkGhArgv` nor `checkGitArgv` exists):
every `DOORS` entry throws `LauncherRefusal` from `checkGhArgv(argv, stdin)`; every `GIT_DOORS`
entry from `checkGitArgv`; and through the launchers, with the stubs first on `PATH`, requests
that carry a hostile value — `{ route: 'repository', owner: '{owner}', … }`, `{ route: 'ref',
branch: 'release/{x}' }`, `{ route: 'ruleset', id: 0 }`, `{ route: 'commit', sha: 'abc1234' }`,
`openPullRequest` with each hostile body, `gitIn(…)(['fetch'])`, `pushIn` with each hostile
`PushRequest` — reject `LauncherRefusal`, and both stubs record no call. Test titles come from
`door.name`, so the test file spells none.

`tests/unit/fake-gh.test.ts` (fails: the fake does not exist): the fake answers `--version` with
`gh version 2.40.0 (2023-12-07)` and a release line; `GET user` logged in as `ada` with an
included `200` whose body carries `login`, `type` and fields the reader never reads (`id`,
`site_admin`); `.logout()`: exit 4, nothing on stdout, gh's own words on stderr; an expired
session: an included `401`, exit 1; `userRefused`: `403`; `installed: false`: code `ENOENT`;
`.as('robot')` with `type: 'Bot'`: `200` with `"type":"Bot"`. Its own grammar is held to the
launcher's: every vector `ghArgv` builds, over a sample of each route, is one the fake
recognises (a route it does not model yet answers exit 97, `fake gh: <route> is not modelled`,
which names the route it recognised), and every `DOORS` entry answers exit 97, `fake gh: not a
vector idp-agent sends` (6.2.1 turns the doors that name a GitHub action into GitHub's answers).
The fake reads the argv itself, with its own patterns, and imports nothing from `src/` but the
`GhProcess` type (§ 10: "independently of the launcher's, so a drift fails").

`tools/fake-gh.ts`'s model in 6.1.1: `FakeState { installed; version; accounts: { login; type }[];
session: { login: string; expired?: true } | undefined; userRefused?: true }`, and
`answer(state, argv, stdin): GhExit` — the `node:` built-ins only, no syntax type stripping
cannot erase, as `tools/fake-backstage.ts`. `fakeGitHub(model?)` defaults to gh 2.40.0,
installed, one account `ada` (`User`), logged in as her.

`tests/unit/live-config.test.ts` (fails: no `exclude`): reads `vitest.config.ts` **as text** —
importing it would call `enterRunDirectory()` in a worker whose pid is not the run's, and create
a second run directory — and requires `exclude: [...configDefaults.exclude, 'tests/live/**']`,
`include` unchanged, and `'tests/setup/forge.ts'` among `setupFiles`. 6.4.1, where the first file
under `tests/live/` exists, extends it with `vitest list --filesOnly --json`, which globs without
importing, and requires nothing listed under `tests/live/`: before then the listing would be
vacuous.

- [x] **Step 6: The architecture rules, failing first** (`tests/architecture/dependencies.test.ts`)

Re-count from **25** (`pnpm vitest run tests/architecture --reporter=verbose`, the `architecture`
block).

`SPAWNS` names both launchers, and an entry lists every environment function one of its calls
may be given — `process/git.ts` makes two calls, `gitIn`'s and `pushIn`'s, with different
environments:

```typescript
const SPAWNS: Readonly<Record<string, { readonly calls: number; readonly env: readonly string[] }>> = {
  // `gitIn` for every read and write, `pushIn` for the one push form (§ 4).
  'process/git.ts': { calls: 2, env: ['gitEnvironment', 'pushEnvironment'] },
  // `spawnGh`, which every gh call goes through.
  'process/gh.ts': { calls: 1, env: ['ghEnvironment'] },
}
```

`spawnOffences` checks each call is given `env: <one of them>(`, and each listed function starts
from `spawnedEnvironment(` and names its parameters nowhere else. Its message for a call given
none reads `… is not given env: gitEnvironment()` for a one-function entry, so the existing
self-test expectations hold as written; a two-function entry reads `… is not given env:
gitEnvironment() or pushEnvironment()`. The self-test *refuses a process started without
spawnedEnvironment* gains: a module of two calls and two functions passes; its second function
naming `env` outside `spawnedEnvironment(…)` is refused; its second call given the first
function passes; given none is refused.

Renamed: *only the named modules write, and only one starts a process* becomes *only the named
modules write, and only process/git.ts and process/gh.ts start a process* (its body reads
`SPAWNS`, so the second module is admitted by the entry above). Three new rules:

```typescript
/**
 * What a door rule refuses under `root`: a source file `allowed` does not name
 * whose code, comments stripped, holds one of § 6's door strings as a word.
 * Textual, as the fetch rules are: a door split across two strings passes,
 * and the launcher's grammar refuses it at run time.
 */
async function doorOffences(root: string, allowed: (name: string) => boolean): Promise<string[]> {
  const offending: string[] = []
  for (const file of await sourceFiles(root)) {
    const name = nameUnder(root, file)
    if (allowed(name)) continue
    const code = stripped(await readFile(file, 'utf8'))
    for (const word of DOOR_WORDS) if (doorPattern(word).test(code)) offending.push(`${name} names ${word}`)
  }
  return offending
}

/** A word's own boundaries: `--force` is not `--force-with-lease=`, `--tags` is not `--no-follow-tags`. */
const doorPattern = (word: string): RegExp => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const before = /^[\w-]/.test(word) ? '(?<![\\w-])' : ''
  const after = /[\w-]$/.test(word) ? '(?![\\w-])' : ''
  return new RegExp(`${before}${escaped}${after}`)
}

/**
 * What the credential rule refuses under `root`: a source naming `GH_TOKEN`
 * or `GITHUB_TOKEN` at all, or `hosts.yml`, or indexing an environment by any
 * `GH_…TOKEN`/`GITHUB_…TOKEN` name; the two Enterprise names only inside
 * `process/gh.ts`'s `GH_REMOVED` list, which drops them by upper-cased
 * comparison and never reads a value (§ 5).
 */
async function credentialOffences(root: string): Promise<string[]> { … }
```

```typescript
  it('nothing in src/ names a door the allow-list refuses', async () => {
    // The launchers refuse every vector outside § 6's grammar at run time;
    // this keeps the source from holding the words at all.
    expect(await doorOffences(SOURCE_ROOT, () => false)).toEqual([])
  })

  it('nothing in src/ reads a GitHub credential from the environment', async () => {
    // idpa holds no GitHub credential (§ 5): gh and git read their own.
    expect(await credentialOffences(SOURCE_ROOT)).toEqual([])
  })

  it('in tests/, only tests/live/ and tests/support/fake-gh.ts name a door', async () => {
    // They try the doors; every other test takes them from DOORS, GIT_DOORS and DOOR_WORDS.
    expect(await doorOffences(TESTS_ROOT, (name) => name.startsWith('live/') || name === 'support/fake-gh.ts')).toEqual([])
  })
```

`TESTS_ROOT` is `path.resolve(import.meta.dirname, '..')`; this file imports `DOOR_WORDS` and
never spells one. Self-tests, in *the architecture rules themselves*:

- *refuses every way src/ can name a door* — a scratch tree with one probe per `DOOR_WORDS` word
  as a string, one inside a template literal, one as a second array element's text, each
  refused, `'PUT'`, `"DELETE"`, `--method=PATCH` and `` `/repos/acme/iac/pulls/1/merge` `` among
  them; the same words in a `//` and a `/* */` comment, `--force-with-lease=`,
  `--no-follow-tags`, `merge-base`, `branch.main.merge`, `INPUT`, `DELETED` and `put` pass; the tests-side predicate lets `live/…` and
  `support/fake-gh.ts` through and refuses `unit/probe.test.ts`.
- *refuses every way src/ can read a GitHub credential* — `process.env.GH_TOKEN`,
  `process.env['GITHUB_TOKEN']`, ``env[`GH_TOKEN`]``, `const { GH_TOKEN } = process.env`,
  `Reflect.get(env, 'GITHUB_TOKEN')`, `name === 'GH_TOKEN'`, `env.GH_OTHER_TOKEN`,
  `env['GITHUB_ENTERPRISE_TOKEN']` in `process/gh.ts` outside `GH_REMOVED`, `GH_ENTERPRISE_TOKEN` in
  `cli/x.ts`, `'hosts.yml'` in `forge/github/x.ts` — each refused; `GH_REMOVED` naming both
  Enterprise names, `'GH_HOST'` and `'GH_CONFIG_DIR'`, and `GITHUB_TOKEN` in a comment, pass.

**Probes, each seen failing its rule, then deleted** (after Step 7):

| Probe | Must fail |
|---|---|
| `src/cli/probe.ts`: `export const x = ['pr', 'merge'].join(' ') + ' --admin'` | *nothing in src/ names a door…* (for `--admin`; the split `pr merge` passes, the limit stated) |
| `src/forge/local/probe.ts`: `export const f = '--force'` | *nothing in src/ names a door…* |
| `src/cli/probe.ts`: `export const t = process.env['GH_TOKEN']` | *nothing in src/ reads a GitHub credential…* |
| `tests/unit/probe.test.ts`: `const d = '--delete'` | *in tests/, only tests/live/…* |
| `src/process/gh.ts`: a second `execFile(` with no `env` | *every process src/ starts is given spawnedEnvironment* |
| `src/cli/probe.ts`: `import { execFile } from 'node:child_process'` | *…only process/git.ts and process/gh.ts start a process* |

`'reads every layer it has a rule about'` is unchanged in 6.1.1 (no new top-level folder).
Count after: **28** (25, three added, one renamed).

- [x] **Step 7: The code**

`src/process/refusal.ts`:

```typescript
/**
 * A vector outside a launcher's grammar (§ 6): a programming error, never the
 * user's, and nothing was started. It names the command word and nothing
 * else — an argument can hold a repository's content.
 */
export class LauncherRefusal extends Error {
  constructor(program: 'git' | 'gh', word: string) {
    super(`${program} ${word} is not a command idp-agent runs`)
    this.name = 'LauncherRefusal'
  }
}
```

`src/process/git.ts` gains the grammar, `pushIn` and the push constants of the Interfaces; its
head comment says it is one of two launchers and names `checkGitArgv`. `src/process/gh.ts` is
Step 4. `tools/fake-gh.ts`, `tests/support/fake-gh.ts` and `tests/support/stub-gh.ts` are Step 5.

Edits to existing tests: Step 3's table in `process-git.test.ts`;
`local-forge.test.ts:77` and `:87` hash with `['hash-object', '-w', '--stdin', '--no-filters']`;
`local-forge.test.ts:501`'s test-side `git(repo, 'symbolic-ref', '--delete', …)` becomes
`'symbolic-ref', '-d', …` — a test's own git setup is not a door idp-agent runs, and the short
form keeps the door list one list.

- [x] **Step 8: Run what changed, and count**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/process-git.test.ts tests/unit/process-gh.test.ts tests/unit/launcher-doors.test.ts tests/unit/fake-gh.test.ts tests/unit/live-config.test.ts tests/unit/offline.test.ts tests/unit/local-forge.test.ts tests/invariants/forge.test.ts tests/unit/spawned-environment.test.ts tests/unit/project-tracked.test.ts
pnpm vitest run tests/architecture --reporter=verbose
```

Expected: PASS; the `architecture` block lists **28** rules. `tests/invariants/forge.test.ts`
and `project-tracked.test.ts` passing unchanged is the proof that the grammar admits every
vector stage 5 builds. `tests/unit/doc-symbols.test.ts` runs too: an identifier the documents now
name in backticks that `src/` holds only in a comment (`GH_TOKEN`) is added to its list of names
that are not ours, with the reason (gh's own variable).

- [x] **Step 9: The documents this makes true**

- `AGENTS.md`: "**Twenty-five**" → "**Twenty-eight**", naming the three rules; "Only
  `process/git.ts` starts a process…" → "Only `process/git.ts` and `process/gh.ts` start a
  process, each from a grammar of the command shapes it may run, checked on the finished vector
  before the process starts (§ 6); no source names a door or reads a GitHub credential from the
  environment"; the layering paragraph's `process/` sentence names both launchers; the test
  count.
- `docs/design.md` §5.5: "**twenty-three**" → "**twenty-eight**", "The other twenty-one" →
  "The other twenty-six", the process sentence as in `AGENTS.md`.
- `SECURITY.md:164`: the renamed rule and the three new ones; `:165`: gh started by the second
  launcher with § 5's gh environment, the push's four `GIT_SSH*`/`GIT_ASKPASS` variables, and
  the new tests (`process-gh.test.ts`, `launcher-doors.test.ts`). The *What leaves your machine*
  table is unchanged: nothing starts gh yet.
- `src/process/README.md`: two launchers, the grammars and where they are written, the three
  environments (every git call, the push, gh), what may not.
- `tests/README.md`: four setup files, `forge.ts` described (what it removes, closes and moves,
  Node's `NODE_USE_ENV_PROXY` among what it removes, so a recording shell has nothing to unset);
  the stub and the fake in the support table.
- README's badge: the test count.

- [x] **Step 10: Traceability**

`CHANGELOG.md`, Unreleased → **Added**:

> - Every git and gh command idp-agent can start is checked, before the process starts,
>   against an explicit list of shapes: stage 5's git plumbing, reads of the clone's
>   configuration and remote, `merge-base --is-ancestor` and one create-only push form; and, in
>   a second launcher no command uses yet, `gh --version`, eight read-only `gh api` routes and
>   the one call that will open a pull request. Anything else is refused and nothing starts.
>   Architecture rules keep every door and every GitHub credential's name out of the source,
>   and the test suite removes every variable that could carry a child process to GitHub,
>   points git's and gh's proxy variables at a closed port and removes Node's
>   `NODE_USE_ENV_PROXY`, so no Node `fetch`, a recording's included, is sent there, moves
>   `HOME` into its run directory and puts a `gh` and an `ssh` that fail first on its `PATH`
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

`docs/roadmap.md`: the stage 6 row → "in progress ([the plan](plans/stage-6-github.md)): 6.1.1,
the allow-list ([#PRNUM](…))"; the queue item 2 says 6.1.1 is on `main` once merged.

**As built** (against `faf10f0`, where `main` had moved since this plan was written; the
plan's intent kept):

- The architecture rules were **26** before this task (backstage-http slice 2 added one), so
  **29** after it, not 28; `AGENTS.md` and design §5.5 say twenty-nine. `SECURITY.md`'s rows
  are at `:217` and `:218`, not `:164` and `:165`.
- `src/process/grammar.ts` is added: `isHex`, `isBranch`, `SUBMISSION_BRANCH` and
  `SUBMISSION_REF`, which both launchers check and neither may import from the other
  (`gh.ts` cannot load `git.ts`). `git.ts` re-exports `SUBMISSION_REF`. 6.1.2's agreement
  test holds `grammar.ts` and `gh.ts` to `core/github/remote.ts`.
- `isBranch` refuses every white-space character (`\s`), not only the space git refuses.
- The one POST's stdin must be exactly the JSON the engine writes: the six keys in the order
  `title`, `head`, `base`, `body`, `draft`, `maintainer_can_modify`, as `JSON.stringify`
  writes them, so no key is repeated or added on the way; 6.2.1 builds the body that way.
- The stub `exec`s Node on a `record.mjs` beside it rather than `node -e`, to the same end (no
  shell quoting); `Stub` also has `stdin()`, the bytes the last call read.
- Measured on git 2.46: pushing the same commit again answers `=` `[up to date]`; another
  commit to the same name answers `!` `[rejected] (stale info)`.
- `doc-symbols.test.ts`'s `NOT_OURS` gains `GH_TOKEN`, `GH_CONFIG_DIR`, `NO_PROXY` and
  `NODE_USE_ENV_PROXY`, each with its reason.
- After review: `checkGhArgv` refuses `:` in a path as well as the braces, since gh also fills
  `:owner`, `:repo` and `:branch` (no value of the grammar holds a literal `:`); `DOORS` gains
  those three paths and three POST bodies — `base` given twice, the keys in another order,
  white space between them — and `tools/fake-gh.ts` holds the body to the same written form.
  `forge.ts` gives each worker its own HOME and GH_CONFIG_DIR (`home-<pid>`,
  `gh-config-<pid>`) and takes `--use-env-proxy` out of NODE_OPTIONS as well; the stub finds
  its directory with `fileURLToPath` and quotes its paths for the shell. The real push test
  also reads the git configuration, as the launcher's git would, for a `core.sshCommand` or an
  `insteadOf`, before pushing; 6.2.1's `githubClone` keeps the check the plan gives it.
- Step 11's commit is left to the owner's go-ahead; its checks were run.

- [ ] **Step 11: Checks, then the pull request** *(after the owner's go-ahead)*

```bash
df -h "$TMPDIR"
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` is unchanged by this task and must pass as it is: no command starts gh.

```bash
git add src/process tests/setup/forge.ts tests/setup/personal.ts tests/support/fake-gh.ts tests/support/stub-gh.ts tools/fake-gh.ts tests/unit/process-gh.test.ts tests/unit/launcher-doors.test.ts tests/unit/fake-gh.test.ts tests/unit/live-config.test.ts tests/unit/process-git.test.ts tests/unit/offline.test.ts tests/unit/local-forge.test.ts tests/unit/doc-symbols.test.ts tests/architecture/dependencies.test.ts tests/README.md vitest.config.ts AGENTS.md docs/design.md SECURITY.md README.md CHANGELOG.md docs/roadmap.md docs/plans/stage-6-github.md
git commit -m "feat(process): two launchers that run only an allow-list of git and gh shapes, and a floor under every child process"
```

Base `docs/stage-6-plan`. Exhaustive switches added: `GhRoute` (`ghArgv`'s path),
`GhRequest` (`ghArgv`), `PushFlag` (`parsePorcelain`). Architecture rules: **28**.

**What the owner can run** (from the worktree, keyless and offline; no gh, no ssh, no model):

```bash
pnpm install
pnpm vitest run tests/architecture --reporter=verbose
pnpm vitest run tests/unit/launcher-doors.test.ts tests/unit/process-gh.test.ts tests/unit/process-git.test.ts
env GH_TOKEN=canary-not-a-token GIT_SSH_COMMAND=false GH_HOST=evil.example NODE_USE_ENV_PROXY=1 pnpm vitest run tests/unit/offline.test.ts
```

Attendu :
- the first run prints 28 rules under `architecture`, among them *nothing in src/ names a door
  the allow-list refuses*, *nothing in src/ reads a GitHub credential from the environment*, *in
  tests/, only tests/live/ and tests/support/fake-gh.ts name a door* and *only the named modules
  write, and only process/git.ts and process/gh.ts start a process*; exit 0;
- the second passes, one case per door (their titles are the doors' names), the real push to a
  bare repository included; exit 0;
- the third passes although the shell exported a GitHub token, an ssh command, a host and
  Node's proxy switch: the floor removed them before any test ran; exit 0.

---

### Task 6.1.2: The remote, the clone's own configuration, and who gh is

**Goal.** Before anything is read on GitHub, the road is decided and typed (`readRoad`): the
branch HEAD names, the remote and branch it tracks, both URLs `git remote get-url` prints,
parsed as one of the five GitHub forms or another host; on the GitHub road, the clone's own
configuration refused where it could redirect the push or run a program, by key and scope and
never by value (§ 7). Then gh's presence, version and identity (`readIdentity`, § 5, § 9). Every
refusal is exit 2, worded, and quotes nothing it read unless it passed a grammar. The pure parts
live in a new `src/core/github/`; `src/forge/github/` reads through the launchers. No command
calls any of it yet: 6.1.3's `idpa protection` is the first.

Constraints cited: 1, 3, 8, 9, 12, 15.

**Branch** `feat/s6-remote`, cut from `feat/s6-allow-list`.

**Files:**
- Create: `src/core/github/remote.ts`, `src/core/github/config.ts`, `src/core/github/gh-version.ts`,
  `src/core/github/answers.ts` (`userAnswer`)
- Modify: `src/core/README.md` (a paragraph for `core/github/`), `src/forge/provider.ts` (`Road`,
  `GitHubRoad`, `LocalRoad`, `GhIdentity`, types only)
- Create: `src/forge/github/road.ts`, `src/forge/github/identity.ts`, `src/forge/github/api.ts`
  (`githubClient`, `githubApi` with `user()`, `GitHubAnswerError`, the call budget),
  `src/forge/github/limits.ts`, `src/forge/github/README.md`
- Modify: `src/forge/README.md`
- Create: `tests/unit/github-remote.test.ts`, `tests/unit/repository-config.test.ts`,
  `tests/unit/road.test.ts`, `tests/unit/gh-identity.test.ts`, `tests/unit/grammar-agreement.test.ts`
- Modify: `tests/architecture/dependencies.test.ts` (the fourth rule, its self-test)
- Modify: `AGENTS.md` (28 → 29; the folder table's `forge/` row names `github/`; the layering
  diagram), `docs/design.md` §5.5 (twenty-nine), `SECURITY.md:164`, README's badge,
  `CHANGELOG.md`, `docs/roadmap.md`

**Interfaces** (the shared names; one widening and one parameter added, said below):

```typescript
// src/core/github/remote.ts
export interface GitHubRepository { readonly host: 'github.com'; readonly owner: string; readonly name: string }
export type RemoteUrl =
  | { kind: 'github'; repository: GitHubRepository; url: string }
  | { kind: 'other-host'; host: string }
  | { kind: 'userinfo'; host: string; path: string }
  | { kind: 'unreadable' }
export function parseRemoteUrl(url: string): RemoteUrl
export function isRemoteName(name: string): boolean
export function baseOfMerge(merge: string): string | undefined
export function isLogin(login: string): boolean
export function sameRepository(a: GitHubRepository, b: GitHubRepository): boolean
export const printedRepository = (repository: GitHubRepository): string => `github.com/${repository.owner}/${repository.name}`   // ADDED

// src/core/github/config.ts
export interface ConfigEntry { readonly scope: string; readonly key: string }   // no value field, ever
export function parseConfigListing(bytes: Buffer): ConfigEntry[]
export function refusedConfigKeys(entries: readonly ConfigEntry[]): ConfigEntry[]
export const REFUSED_SECTIONS, REFUSED_KEYS, KEPT_LOCAL_KEYS
export function configRefusal(entry: ConfigEntry, more: number): string        // ADDED: the exit-2 sentence

// src/core/github/gh-version.ts
export const GH_MINIMUM_VERSION = '2.40.0'  // provisional: 6.4.1 pins it from the live run
export function parseGhVersion(stdout: string): string | undefined
export function isAtLeast(version: string, minimum: string): boolean

// src/core/github/answers.ts
export const userAnswer  // z.looseObject({ login: z.string(), type: z.string() })

// src/forge/provider.ts — LocalRoad, GitHubRoad, Road, GhIdentity exactly as the shared names state them

// src/forge/github/
export function readRoad(git: Git, options: { local: boolean }): Promise<Road>
export function readIdentity(gh: GhClient, road: GitHubRoad, purpose?: 'submission' | 'protection'): Promise<GhIdentity>   // `purpose` ADDED
export function githubClient(options: { env?: NodeJS.ProcessEnv; run?: GhProcess }): GhClient
export function githubApi(gh: GhClient, repository: GitHubRepository): GitHubApi   // user() here; 6.1.3 and 6.2.1 add the rest
export class GitHubAnswerError extends Error { readonly route; readonly status }
export const GITHUB_LIMITS = { submissionMs: 180_000, ghCalls: 48, rulesets: 10, pullsPage: 100, readBack: [500, 1500], bodyBytes: 1024 * 1024 } as const
```

Where this task settles what the shared names left open (each now recorded there):

- **`GhIdentity.role` is `undefined` out of `readIdentity`.** § 15 budgets the identity at two
  gh calls, the version and `/user`, and the forty-eight add up exactly; the role is in
  `repos/{o}/{r}`'s `permissions`, which the preflight reads (6.1.3) and reports as
  `ProtectionVerdict.reported.role`, which `idpa protection`'s block prints (6.1.3) and nothing
  else does: the "submitting to" line names no role (Choices).
- **`readIdentity` takes a `purpose`.** The exit-2 sentences of *Exact lines* end "or add --local to cut
  the branch in this clone only", which is false for `idpa protection`: with `'protection'`,
  that clause is left out, the rest word for word.
- **A local path is a host.** A remote that is a path or `file://` URL is the other-host road,
  `host: 'this machine'` ("the remote is on this machine, where this build opens no pull
  request: nothing pushed"). A rule that "a URL from which no host can be read is exit 2"
  would refuse, from 6.2.2 on, every `--submit` in a clone whose upstream is a local bare
  repository, which stage 5 accepts today; a URL of the GitHub hosts that does not parse stays
  exit 2.
- **A key's subsection can hold a credential.** `url.https://x-access-token:<token>@github.com/.insteadof`
  is one key (measured: git prints the subsection as written), and so is
  `http.https://example.com/?access_token=<token>.extraheader`, which holds no `@`. So a
  subsection is printed only when it has a shape that cannot carry one, never on the absence of
  one character: for `url`, `http` and `credential`, whose subsection is a URL, only when it
  matches `^[a-z][a-z0-9+.-]*://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$` — no `@`,
  `?`, `#`, `%` or `;` — and for every other section only when it matches `isRemoteName`'s
  grammar; and in both cases only when `inertLine` leaves it unchanged. Otherwise the key is
  named `url.<a URL this build does not print>.insteadof` (`<a name this build does not print>`
  outside the three URL sections) and the remedy is `git config --local --edit`, so the token is
  never printed.
- **The configuration is judged on the GitHub road only, after the URLs.** On the other-host and
  no-upstream roads nothing is pushed, and a GitLab clone with a local `credential.helper` is not
  refused for a push that will not happen. A local `url.*.insteadOf` that rewrites github.com to
  another host therefore lands on the other-host road: nothing is pushed, the safe direction.
  A local `pushInsteadOf` that sends only the push elsewhere makes the push URL differ from the
  fetch URL, which is exit 2.

- [ ] **Step 1: The pure half, failing first**

`tests/unit/github-remote.test.ts` (fails: `core/github/remote.ts` does not exist):

- *parses the five forms, with and without `.git`* — `https://github.com/acme/iac(.git)`,
  `git@github.com:acme/iac(.git)`, `ssh://git@github.com/acme/iac(.git)`,
  `ssh://git@ssh.github.com:443/acme/iac(.git)`, `org-4711@github.com:acme/iac(.git)`: each
  `{ kind: 'github', repository: { host: 'github.com', owner: 'acme', name: 'iac' }, url }`, `url`
  the string as given.
- *refuses userinfo, and reads its host and path so the refusal can name them* —
  `https://x-access-token:t@github.com/acme/iac.git`, `https://ada@github.com/acme/iac`,
  `ssh://ada@github.com/acme/iac`, `ada@github.com:acme/iac`: `{ kind: 'userinfo', host:
  'github.com', path: 'acme/iac.git' }` (the path as written).
- *sends every other host down the stage-5 road* — `git@gitlab.example.com:acme/iac.git`,
  `https://gitlab.example.com/acme/iac`, `ssh://git@git.acme.internal:2222/iac`: `other-host`
  with the host; `/srv/iac.git`, `../iac`, `file:///srv/iac.git`: `other-host`, `'this machine'`.
- *refuses a GitHub URL that does not parse* — `https://github.com/acme`,
  `https://github.com/acme/iac/`, `https://github.com/acme/iac/tree/main`,
  `http://github.com/acme/iac`, `git://github.com/acme/iac`, `github.com:acme/iac`,
  `ssh://git@github.com:22/acme/iac`, `ssh://git@ssh.github.com/acme/iac` (no 443),
  `https://GitHub.com/acme/iac` (hosts are matched as GitHub prints them), `-acme` or `.`, `..`
  as the name, a name of 101 characters, a control or bidi character anywhere: `unreadable`.
- *holds a remote's name, a base and a login to their grammars* — `isRemoteName`: `origin`,
  `up/stream`, `a.b_c-d` yes; `--push`, `.hidden`, `-x`, 101 characters, `a b` and the empty string no;
  `baseOfMerge`: `refs/heads/main` → `main`, `refs/heads/release/1` → `release/1`; `refs/tags/v1`,
  `refs/pull/1/head`, `main`, `refs/heads/-x`, `refs/heads/a..b`, `refs/heads/a{b`,
  `refs/heads/a%b`, `refs/heads/x.lock`, `refs/heads/ma\u202Ein`, `refs/heads/ma\u200Bin`,
  256 bytes → `undefined`; `isLogin`: `ada`, `Ada-L`,
  `github-actions[bot]` yes; `-ada`, `ada b`, `a/b`, 40 characters no.
- *compares repositories as GitHub does* — `sameRepository` ignores case in owner and name.

`tests/unit/repository-config.test.ts` (fails: `core/github/config.ts` does not exist):

- *reads git's listing and keeps no value* — over the exact bytes measured on git 2.46
  (`local\0core.bare\nfalse\0`, a key with no `\n`, `command\0core.hookspath\n/dev/null\0`, a value
  holding `\n` and `=`): scopes and keys in order; `JSON.stringify` of the result holds none of
  the values.
- *refuses the seven sections at the local and worktree scopes, and only there* — each of
  `url.git@evil.example:.insteadof`, `credential.helper`, `credential.https://github.com.helper`,
  `http.proxy`, `http.https://github.com/.extraheader`, `protocol.allow`, `ssh.variant`,
  `gpg.program`, `push.pushoption` at `local` and at `worktree`: refused; the same at `global`,
  `system` and `command`: not.
- *refuses the named keys* — `core.sshcommand`, `core.askpass`, `core.gitproxy`,
  `remote.origin.vcs`, `.receivepack`, `.uploadpack`, `.proxy`, `.proxyauthmethod`, for any
  remote's name; `remote.origin.url`, `.pushurl`, `.fetch` and `remote.origin.mirror` are not
  (§ 7: the push names a URL, never the remote).
- *keeps the six harmless two-part keys* — `http.postbuffer`, `http.lowspeedlimit`,
  `http.lowspeedtime`, `push.default`, `push.autosetupremote`, `gpg.format`: not refused; with a
  subsection (`http.https://x.postbuffer`), refused; compared lower-cased, so `HTTP.PostBuffer`
  written by hand is kept too.
- *says which key, where, and what it would decide, never its value* — `configRefusal` for
  `credential.helper (local)` is the sentence of *Exact lines* with *who pushes for you*; `url.…` and
  `remote.origin.proxy` read *where your push goes*; `core.sshcommand`, `gpg.program`,
  `push.pushoption` read *what program runs during your push*; a subsection holding `@`
  (`url.https://x-access-token:canary@github.com/.insteadof`), one holding a query
  (`http.https://example.com/?access_token=canary.extraheader`), one holding `#` or `%40`, and
  one holding a bidi character are each elided as `<a URL this build does not print>`, the
  canary nowhere in the sentence, and the remedy is `git config --local --edit`;
  `http.https://github.com/.extraheader` and `remote.origin.vcs` are printed as they are;
  `more: 2` appends `It sets 2 more keys of
  this kind; each is refused the same way.`

`gh-version` (in `gh-identity.test.ts`): `parseGhVersion` over `gh version 2.40.0 (2023-12-07)\n…`
→ `2.40.0`, over `gh version 2.62.0-rc.1 (…)` → `2.62.0`, over `gh version DEV` → `undefined`;
`isAtLeast` numeric by part (`2.9.0` is older than `2.40.0`).

- [ ] **Step 2: The road, over real clones, failing first** (`tests/unit/road.test.ts`)

Clones built by `tests/support/git.ts` (`committed`, test-side `git`), read by `gitIn(repo)`,
the real launcher; the global configuration is the run directory's `HOME` (6.1.1), which a case
fills when it needs one. Fails: `readRoad` does not exist.

| Clone | `readRoad(gitIn(repo), { local: false })` |
|---|---|
| no upstream | `{ kind: 'local', why: 'no-upstream', branch: 'main' }` |
| `branch.main.remote origin`, `merge refs/heads/main`, `origin` = `git@github.com:acme/iac.git` | `{ kind: 'github', repository: acme/iac, remote: 'origin', base: 'main', branch: 'main', pushUrl: 'git@github.com:acme/iac.git' }` |
| the same, `feature` tracking `origin/release/1` | `base: 'release/1'`, `branch: 'feature'` |
| `origin` on `git@gitlab.example.com:acme/iac.git` | `{ kind: 'local', why: 'other-host', host: 'gitlab.example.com' }` |
| `origin` a path to a bare repository | `other-host`, `'this machine'` |
| any clone, `{ local: true }` | `{ kind: 'local', why: 'asked' }`, and no git call made (a counting `Git`) |
| a global `url."git@github.com:".insteadOf https://github.com/` and `origin` `https://github.com/acme/iac` | GitHub road, `pushUrl` `git@github.com:acme/iac` — the global configuration is the person's |
| a local `url."git@evil.example:".insteadOf git@github.com:` | `other-host`, `evil.example` |
| a local `remote.origin.pushurl` on another repository, or a local `pushInsteadOf` sending the push elsewhere | `ForgeInputError`: `origin fetches from github.com/acme/iac and pushes to github.com/evil/iac; idpa pushes only where it reads (a fork set-up is not supported). Nothing was written.` |
| two `remote.origin.url` values | `ForgeInputError`: `origin has 2 fetch URLs; idpa reads one. Nothing was written.` (and the push form) |
| `origin` = `https://x-access-token:canary@github.com/acme/iac.git` | `ForgeInputError`: `origin's URL carries a credential; set it to https://github.com/acme/iac. Nothing was written.`, and `canary` nowhere in the message |
| `origin` = `https://github.com/acme` | `ForgeInputError`: `origin's URL does not parse as a GitHub repository (https://github.com/<owner>/<name>, git@github.com:<owner>/<name> and the three SSH forms docs/submitting.md lists). Nothing was written.`, the URL unquoted |
| `branch.main.remote .` | `main tracks this clone itself (branch.main.remote is .); idpa pushes to a named remote. Set its upstream to one (git branch --set-upstream-to <remote>/<branch>), then run this again. Nothing was written.` |
| `branch.main.remote git@github.com:acme/iac.git` | `branch.main.remote is a URL, not a remote's name; …` (the same remedy) |
| `branch.main.remote --push` (set by hand) | `branch.main.remote names a remote this build does not read (a name is 1 to 100 letters, digits, '.', '_', '-' and '/', not beginning with '-' or '.'). Nothing was written.`, the value unquoted |
| `branch.main.merge refs/tags/v1` | `main's upstream is not a branch this build reads (branch.main.merge must be refs/heads/ and a branch name). Nothing was written.` |
| `branch.main.remote upstream`, no such remote | `main tracks upstream, which this clone does not define (git remote -v lists its remotes). Nothing was written.` |
| each key of § 7's refused list set locally, and once through `include.path` | `ForgeInputError`, `configRefusal`'s sentence with scope `local`; the value's canary nowhere |
| the same key in the run directory's `~/.gitconfig` | the GitHub road: `global` is the person's |
| detached HEAD | `HEAD is detached; check out the branch this request is for` (stage 5's words) |
| a checked-out branch named `a%b` | `a%b is a branch name this build does not read ('%' is read as an escape in GitHub's paths). Nothing was written.` |

`readRoad`'s order: `symbolic-ref --quiet HEAD`; the branch's grammar; `config --get
branch.<b>.remote` (exit 1: no upstream); its grammar, then `check-ref-format
refs/remotes/<name>/HEAD`; `config --get branch.<b>.merge` (exit 1: no upstream), `baseOfMerge`,
then `check-ref-format --branch <base>`; both `get-url` reads, one line each; `parseRemoteUrl`
over each, a `switch` over `RemoteUrl['kind']` with `const _exhaustive: never`; hosts and
repositories compared; on the GitHub road, `config --list --show-scope -z`, then
`refusedConfigKeys`. Every value a refusal names has passed its grammar first (a branch, a remote's name, a base,
an owner and a name), or is not named; the CLI's `inertLine` still cleans each at print.

- [ ] **Step 3: Who gh is, failing first** (`tests/unit/gh-identity.test.ts`)

Against `fakeGitHub()` (6.1.1) through `githubClient({ run: fake.process })`, over the GitHub
road of Step 2's second row. Fails: `readIdentity` does not exist.

| The fake | `readIdentity(gh, road)` |
|---|---|
| gh 2.40.0, logged in as `ada`, a `User` | `{ login: 'ada', role: undefined }`, `gh.calls()` 2 |
| `installed: false` | `ForgeInputError`: `main tracks github.com/acme/iac, and gh is not installed, so idpa cannot read the rules that keep a pull request from merging unreviewed. Install it (https://cli.github.com) and run this again; or add --local to cut the branch in this clone only. Nothing was written.` |
| logged out (exit 4) | the sentence of *Exact lines*, *gh is not logged in to github.com*, `gh auth login --hostname github.com` named |
| an expired session (`/user` answers 401) | the same sentence: logged out and expired are one case (§ 9) |
| `version: '2.39.2'` | `gh 2.39.2 is older than 2.40.0, the oldest this build reads; update gh, then run this again; or add --local to cut the branch in this clone only. Nothing was written.` |
| `version: 'DEV'` | `gh printed no version this build reads; update gh, then run this again; or add --local …` |
| logged in as `robot`, a `Bot` | `gh is logged in to github.com as robot, which GitHub says is a Bot, not a person: the pull request's author would be a bot, and whoever asked could approve it. Log gh in as yourself (gh auth login --hostname github.com), or add --local to cut the branch in this clone only. Nothing was written.` |
| `userRefused` (`/user` answers 403: an Actions or an installation token) | `gh is logged in to github.com with a token GitHub will not describe as a user (it answered 403 to /user), as a workflow's or an app's is: the pull request's author would be a bot, and whoever asked could approve it. Log gh in as yourself …` |
| a login outside `isLogin` | `gh is logged in to github.com as an account whose name this build does not read. Nothing was written.` |
| `/user` answering 502 | `GitHubAnswerError` (`route: 'user'`, `status: 502`), exit 1 when a command reaches it |
| any of the refusals, `purpose: 'protection'` | the same sentence without `; or add --local to cut the branch in this clone only` |

And `githubApi`'s budget: a `GhClient` whose `calls()` reads 48 makes the next method throw
`Error('idp-agent made more than 48 gh calls in one run')` before any call — a programming error:
§ 15's figures add up to exactly 48.

`GitHubAnswerError`'s messages, one per status class (§ 15), never GitHub's words: `401` "github.com
refused gh's login during the run (401 on <route>): run gh auth login --hostname github.com
again."; `403` "github.com answered 403 through gh on <route>: your account cannot do this on
<o>/<r>, or GitHub is limiting how fast it may be asked; it does not say which."; `404`
"github.com answered 404 through gh on <route>: <o>/<r> does not exist, or your account cannot
see it; GitHub does not say which."; `5xx` "github.com answered <status> through gh on <route>;
try again later."; `timeout` "gh did not answer within 15 s on <route>."; `too-large` "gh's answer
on <route> was over 1 MiB, more than this build reads."; `unreadable` "gh's answer on <route>
could not be read."; `paginated` (6.1.3). Each ends "Nothing was written." A `GhError` from the
client after the identity is wrapped: `auth` → `401`, `timeout`, `too-large`, and `missing`,
`unreadable` and `failed` → `unreadable`.

- [ ] **Step 4: The two copies of the grammars, one answer** (`tests/unit/grammar-agreement.test.ts`)

`process/` imports nothing of ours, so `process/git.ts` and `process/gh.ts` hold copies of
`core/github/remote.ts`'s grammars. Over fast-check strings (ASCII with `-`, `.`, `/`, `%`,
`{`, `}`, `@`, `:`, space, a control character, and U+202E, U+2066 and U+200B weighted in) and
the note's named cases, each
pair gives one verdict, read through the launchers' public checks so `process/` exports nothing
for the test:

- a remote's name: `checkGitArgv([...HARDENING, '-C', '/r', 'remote', 'get-url', '--all', '--', n])`
  passes if and only if `isRemoteName(n)`;
- a base: `checkGitArgv(… 'check-ref-format', '--branch', b)` passes iff `baseOfMerge(`refs/heads/${b}`)`
  is `b`; and `checkGhArgv(ghArgv({ kind: 'get', route: { route: 'rules', owner: 'acme', name: 'iac', branch: b } }))`
  passes iff the same;
- a push URL: `GITHUB_PUSH_URL.test(u)` iff `parseRemoteUrl(u).kind === 'github'`;
- an owner and a name: `checkGhArgv` over the `repository` route iff `parseRemoteUrl(`git@github.com:${o}/${r}.git`)`
  is GitHub's with exactly that owner and name.

*Fails first:* on `2b2250e` neither copy exists; written before Step 5's code, it fails on the
missing modules, then on any character class the two copies disagree about.

- [ ] **Step 5: The fourth rule, failing first**

```typescript
/** The gh launcher, and the one folder that may load it: the forge's GitHub half. */
const GH_LAUNCHER = 'process/gh.ts'
const RUNS_GH = (name: string): boolean => name.startsWith('forge/github/')
const ghLauncherOffences = (root: string): Promise<string[]> => loaderOffences(root, GH_LAUNCHER, RUNS_GH)

  it('only forge/github/ loads the gh launcher', async () => {
    // `ghIn` runs gh with the person's own login. cli/ names `GhProcess` with
    // `import type`, which is erased; `githubClient` is the one caller of
    // `ghIn`, and its default process is `spawnGh`, so no other module needs
    // the launcher at run time.
    expect(await ghLauncherOffences(SOURCE_ROOT)).toEqual([])
  })
```

Self-test *refuses every module but forge/github/ that loads the gh launcher*: probes
`cli/commands/probe.ts` (`import { ghIn }`), `forge/local/probe.ts` (`import { spawnGh }`),
`context/backstage/probe.ts`, `cli/late.ts` (`await import('../process/gh.js')`), `cli/named.ts`
(`import(name)`), `process/index.ts` (`export { ghIn } from './gh.js'`), `forge/github/api.ts`
handing it on (`export { ghIn } from '../../process/gh.js'`) — each refused;
`cli/typed.ts` (`import type { GhProcess }`), `forge/github/api.ts` (`import { ghIn }`) and
`process/gh.ts` itself pass. Count after: **29**.

- [ ] **Step 6: The code**

`src/core/github/` imports Zod and nothing of ours but `core/` — the rule *core/ imports nothing
from context/, cli/, …* already holds it, and `core/ neither reads nor writes` walks it.
`src/forge/github/road.ts`, `identity.ts`, `api.ts` and `limits.ts` import `core/`, `process/`
and `node:path` only (*forge/ imports core/, process/, node:crypto and node:path*). `api.ts`:

```typescript
/** The one caller of `ghIn` in src/: cli/ reaches gh through this, never the launcher. */
export function githubClient(options: { env?: NodeJS.ProcessEnv; run?: GhProcess }): GhClient {
  return ghIn({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.run === undefined ? {} : { run: options.run }),
  })
}
```

`githubApi(gh, repository).user()` gets `{ route: 'user' }`, holds `status` to 200 (else
`GitHubAnswerError`), parses the body as JSON within `GH_LIMITS` against `userAnswer` (else
`unreadable`). `src/forge/provider.ts` gains the four types, with a `type` import of
`GitHubRepository`; the comment on "the token this interface holds" is 6.2.1's.

- [ ] **Step 7: Run what changed, and count**

```bash
pnpm vitest run tests/unit/github-remote.test.ts tests/unit/repository-config.test.ts tests/unit/road.test.ts tests/unit/gh-identity.test.ts tests/unit/grammar-agreement.test.ts tests/unit/launcher-doors.test.ts
pnpm vitest run tests/architecture --reporter=verbose
```

Expected: PASS; **29** rules.

- [ ] **Step 8: The documents this makes true**

`AGENTS.md`: "**Twenty-eight**" → "**Twenty-nine**", *only forge/github/ loads the gh launcher*
named; the layering diagram shows `forge/` reaching `core/` and `process/` for `local/` and
`github/`; the folder table's `core/` row names `core/github/` (the remote's grammar, the
configuration's scope check, gh's version, GitHub's answers), its `forge/` row `github/`
(the road, gh's identity, the API through gh). `docs/design.md` §5.5: twenty-nine.
`SECURITY.md:164`: the fourth rule. `src/core/README.md`: a paragraph for `core/github/`.
`src/forge/github/README.md` (new) and `src/forge/README.md`: what lives there, that it reads
through the two launchers and judges with `core/github/`, and what may not (no fetch, no token,
no disk). README's badge.

- [ ] **Step 9: Traceability, checks, the pull request** *(after the owner's go-ahead)*

`CHANGELOG.md`, Unreleased → **Added**:

> - The road a submission will take is read from the branch the clone tracks, before anything
>   is read on GitHub: its remote's fetch and push URLs, as the person's own git prints them,
>   parsed as one of GitHub's five URL forms or another host; a URL carrying a credential, a
>   fork set-up, or a key in the clone's own configuration that could redirect the push or run
>   a program during it is refused, naming the key and its scope and never its value; and gh's
>   presence, version and identity are read, a bot or a logged-out gh refused. No command takes
>   this road yet ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

`docs/roadmap.md`: the stage 6 row adds 6.1.2.

```bash
df -h "$TMPDIR"
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
git add src/core/github src/core/README.md src/forge/provider.ts src/forge/github src/forge/README.md tests/unit/github-remote.test.ts tests/unit/repository-config.test.ts tests/unit/road.test.ts tests/unit/gh-identity.test.ts tests/unit/grammar-agreement.test.ts tests/architecture/dependencies.test.ts AGENTS.md docs/design.md SECURITY.md README.md CHANGELOG.md docs/roadmap.md docs/plans/stage-6-github.md
git commit -m "feat(forge): read the road a submission takes, refuse a clone configured to redirect the push, and ask gh who it is"
```

Base `feat/s6-allow-list`. Exhaustive switches added: `RemoteUrl` (`readRoad`), `LocalRoad['why']`
where a test switches on it. Architecture rules: **29**.

**What the owner can run** (from the worktree, keyless and offline; no command takes the road
yet, so the proof is the tests and the parser itself):

```bash
pnpm vitest run tests/unit/road.test.ts tests/unit/repository-config.test.ts tests/unit/gh-identity.test.ts --reporter=verbose
pnpm build
node -e 'import("./dist/core/github/remote.js").then((m) => { for (const u of ["git@github.com:acme/iac.git", "ssh://git@ssh.github.com:443/acme/iac", "https://x-access-token:secret@github.com/acme/iac.git", "git@gitlab.example.com:acme/iac.git", "https://github.com/acme"]) console.log(JSON.stringify(m.parseRemoteUrl(u))) })'
pnpm vitest run tests/architecture --reporter=verbose
```

Attendu :
- the first run lists, among its cases, one per row of the road table, the credential-carrying
  URL refused without its token, and the Bot identity refused; exit 0;
- the `node -e` prints five lines: `github` with `acme`/`iac` twice, `userinfo` with host
  `github.com` and path `acme/iac.git` (the token is in the input line only, never in a message
  idpa prints), `other-host` with `gitlab.example.com`, and `{"kind":"unreadable"}`;
- the last run lists **29** rules, the new one *only forge/github/ loads the gh launcher*; exit 0.

---

### Task 6.1.3: The preflight, and `idpa protection`

**Goal.** § 8, items 1 to 5, read through gh with `GET` only and judged in `core/github/`: the
repository (not archived, its name, push access), the rules for the base, each ruleset that
supplies a required rule and whether gh's account can bypass it, a deploy key visible in a
bypass list, a base protected only by classic branch protection; and, for a submission, the
base on GitHub level with the clone's. `idpa protection [--repo <clone>]` runs it with no
model and no write: exit 0 when the rules hold, 1 when they do not, 2 when the arguments, the
clone's configuration or gh are refused (decision 13). The one list of settings,
`PROTECTION_SETTINGS`, is what `idpa protection`, `init platform` and, from 6.2.2, a refused
submission print. `pnpm demo:github` shows the three answers offline. This closes slice 6.1.

Constraints cited: 1, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15.

**Branch** `feat/s6-protection`, cut from `feat/s6-remote`.

**Files:**
- Create: `src/core/github/protection.ts`
- Modify: `src/core/github/answers.ts` (`repositoryAnswer`, `rulesAnswer`, `rulesetAnswer`,
  `branchAnswer`, `refAnswer`), `src/forge/github/api.ts` (`repository()`, `rules(base)`,
  `ruleset(id)`, `branch(base)`, `ref(branch)`; the `paginated` status)
- Create: `src/forge/github/preflight.ts`, `src/forge/github/open.ts`
- Create: `src/cli/commands/protection.ts`, `src/cli/render/protection.ts`
- Modify: `src/cli/index.ts` (`Command`, `COMMANDS`, parsing, `HELP`, `MainDeps.gh`, the command's
  branch in `main`, `failed()` for `GitHubAnswerError`), `src/cli/repository.ts`
  (`DeclarationsCommand` gains `'protection'`), `src/cli/source.ts` (`sourceOf`'s repository
  overload takes `'protection'`; `sourceNotice`'s alternative for it;
  `protectionNeedsRepository`), `src/cli/commands/init.ts` (`BRANCH_PROTECTION` removed),
  `src/cli/README.md`
- Modify: `tools/fake-gh.ts` (repositories, branches, rulesets, classic protection, the rules
  route, refs read from a bare repository; the executable entry, `FAKE_GH_STATE`),
  `tests/support/fake-gh.ts` (model helpers)
- Create: `scripts/demo-github.mjs`, `docs/submitting.md`
- Modify: `package.json` (`demo:github`), `scripts/smoke.mjs`
- Create: `tests/unit/protection.test.ts`, `tests/unit/preflight.test.ts`,
  `tests/unit/protection-command.test.ts`
- Modify: `tests/unit/init-command.test.ts` (`:124-137`), `tests/contract/key-reach.test.ts`,
  `tests/unit/package-scripts.test.ts`, `tests/unit/doc-symbols.test.ts` (`docs/submitting.md`
  among the living documents), `tests/unit/fake-gh.test.ts`
- Modify: `AGENTS.md` (the command, its exit codes, *Current state*, the test count), `README.md`
  (the command line at `:423-428`, the table at `:465`, the badge), `SECURITY.md` (*What leaves
  your machine*: a row for the reads through the person's gh — see below), `CHANGELOG.md`,
  `docs/roadmap.md`

**Interfaces:**

```typescript
// src/core/github/protection.ts
export type Missing = 'pull-request' | 'approvals' | 'last-push' | 'non-fast-forward' | 'deletion' | 'bypassable' | 'deploy-key' | 'classic-only' | 'archived' | 'no-push' | 'renamed'
export interface ProtectionVerdict { … as the shared names state it, with reported.role: 'admin' | 'maintain' | 'write' | 'read' }   // 'read' ADDED
export interface ProtectionInput {
  readonly expected: GitHubRepository                        // parsed from the remote
  readonly repository: RepositoryAnswer
  readonly rules?: RulesAnswer                               // absent when item 1 failed
  readonly rulesets: ReadonlyMap<number, RulesetAnswer>
  readonly classic?: boolean                                 // read only when no ruleset supplies a required rule
}
export function judgeProtection(input: ProtectionInput): ProtectionVerdict
export const PROTECTION_SETTINGS: readonly { readonly level: 'required' | 'advised'; readonly text: string }[]
export function protectionText(): string[]

// src/forge/github/preflight.ts
export function readProtection(api: GitHubApi, road: GitHubRoad, identity: GhIdentity): Promise<ProtectionVerdict>   // ADDED
export interface Preflight { readonly verdict: ProtectionVerdict; readonly level: 'level' | { readonly github: string } }
export function preflight(api: GitHubApi, road: GitHubRoad, base: Base, identity: GhIdentity): Promise<Preflight>

// src/forge/github/open.ts
export interface GitHubSide { readonly road: Road; readonly identity?: GhIdentity; readonly api?: GitHubApi }
export function openGitHub(input: { repo: string; env: NodeJS.ProcessEnv; gh?: GhProcess; local: boolean; git?: Git; purpose?: 'submission' | 'protection' }): Promise<GitHubSide>

// src/cli/
export function runProtection(input: { repo: string; env: NodeJS.ProcessEnv; gh?: GhProcess; notice: (line: string) => void }): Promise<CommandResult>
export function renderProtection(verdict: ProtectionVerdict, road: GitHubRoad, identity: GhIdentity): string
export function renderUnprotected(verdict: ProtectionVerdict, road: GitHubRoad): string
export function protectionNeedsRepository(context: Pick<SourceContext, 'env' | 'platform'>): string   // ADDED
// MainDeps.gh?: GhProcess — `import type`
// Command: { name: 'protection'; repo?: string }; COMMANDS gains 'protection'
```

Where this task settles what the shared names left open:

- **`readProtection` apart from `preflight`.** `idpa protection` has no local forge and so no
  `Base`: it runs items 1 to 5 (`readProtection`), and `preflight` is that and the base's ref
  (§ 4's level check), what a submission needs from 6.2.2. The budget holds: the repository,
  the rules, at most ten rulesets and the base ref are § 15's 13.
- **`reported.role` gains `'read'`.** A repository answering `permissions.push: false` fails on
  `no-push`, and the verdict must still say what the account is; three values would
  make it `'write'`.
- **Item 1 first, and alone when it fails.** An archived repository, a renamed one (whose rules
  would be read under the old name through a redirect) or one the account cannot push to stops
  the read there: the verdict's `missing` holds only item 1's, and no ruleset is suggested,
  since none would help.
- **`SECURITY.md` gains its gh row here, reads only.** `idpa protection` is the first command
  that sends anything through the person's gh; the row says what (the reads of § 8, through the
  person's gh, to github.com; no credential of idpa's), and 6.2.2 widens it to the pull
  request, beside the push's row.
- **Decision 18's line.** `idpa protection` prints, after the list, "Also advised: a ruleset on
  refs/heads/idp-agent/** blocking force pushes and deletions, so a branch under review is never
  rewritten." It is not in `PROTECTION_SETTINGS`: `init platform` prints the base's list, and
  the branches do not exist yet there.

- [ ] **Step 1: The judgement, failing first** (`tests/unit/protection.test.ts`)

Fails: `core/github/protection.ts` does not exist. Rules and rulesets are written as GitHub
answers them (`type`, `ruleset_id`, `parameters`), one fixture per case:

| Input | `holds` | `missing` | `reported` |
|---|---|---|---|
| one ruleset, `never`: `pull_request` (1 approval, `require_last_push_approval`), `non_fast_forward`, `deletion`; `bypass_actors: []` | true | [] | `lastPushOnly: true`, `bypassActors: []`, `role: 'write'` |
| the same with `dismiss_stale_reviews_on_push` only | true | [] | `dismissStaleOnly: true` |
| `required_approving_review_count: 0` | false | `approvals` | |
| neither push rule | false | `last-push` | |
| no `pull_request` rule | false | `pull-request`, `last-push` | |
| no `non_fast_forward`; no `deletion` | false | `non-fast-forward`; `deletion` | |
| the ruleset answers `always`, `pull_requests_only`, `exempt`, or no `current_user_can_bypass` | false | the three rules' entries, then `bypassable` once | |
| `pull_request` from a `never` ruleset, `non_fast_forward` and `deletion` from an `always` one | false | `non-fast-forward`, `deletion`, `bypassable` | |
| two `never` rulesets: 1 approval in one, `require_last_push_approval` in the other | true | [] | the most restrictive wins, as GitHub enforces both |
| a `DeployKey` in a supplying ruleset's visible `bypass_actors` | false | `deploy-key` | `bypassActors: [{ type: 'DeployKey', count: 1 }]` |
| `bypass_actors` absent from a supplying ruleset | true | [] | `bypassActors: 'unreadable'` |
| an `Integration` and a `Team` visible | true | [] | counted by type, never named |
| no ruleset rule, the branch `protected` | false | `classic-only` | |
| no ruleset rule, the branch not protected | false | `pull-request`, `last-push`, `non-fast-forward`, `deletion` | |
| `archived` | false | `archived` only; `rules` not given | |
| `full_name` `Acme/IAC` for `acme/iac`; `other/iac` | true; false with `renamed` | | |
| `permissions.push: false` | false | `no-push` | `role: 'read'` |
| `admin: true`; `maintain: true` | | | `role: 'admin'`; `'maintain'` |
| `required_status_checks` with `deploy/tufin` and `ci`; `required_signatures`; `merge_queue`; `require_code_owner_review` | | | `statusChecks: ['ci', 'deploy/tufin']`, `signatures`, `mergeQueue`, `codeOwners` |

`missing` is in the order of the type's members, each once. And:

- *prints § 8's nine lines, in its order* — `PROTECTION_SETTINGS` equals, level and text:
  `required · require a pull request before merging — 1 approval`; `required · require approval
  of the most recent reviewable push (or dismiss stale approvals when new commits are pushed)`;
  `required · block force pushes; restrict deletions`; `required · nobody who submits in the
  bypass list`; `advised · no deploy key and no app in the bypass list`; `advised · GitHub
  Actions may not approve pull requests (Settings → Actions → General → Workflow permissions)`;
  `advised · set it at the organisation level, where a repository administrator cannot change
  it`; `advised · require review from Code Owners`; `advised · the downstream decision as a
  required status check, once one reports (ADR-0012)`. `protectionText()` is those lines as § 8
  prints them, `  required · …` and `  advised  · …`.

- [ ] **Step 2: The reads, failing first** (`tests/unit/preflight.test.ts`)

The fake's model grows (`tools/fake-gh.ts`): `repositories: { owner; name; fullName?;
archived; permissions: Record<login, { admin; maintain; push }>; bare?: string; branches:
Record<string, { protected: boolean }>; rulesets: FakeRuleset[] }[]`, a `FakeRuleset` being `{ id;
enforcement: 'active' | 'evaluate' | 'disabled'; branches: string[]; rules: { type; parameters? }[];
bypass: { actor_type; actor_id; bypass_mode: 'always' | 'pull_request' }[] }`. `GET
rules/branches/<b>` answers every rule of every **active** ruleset whose `branches` names `b`,
each with its `ruleset_id` (a ruleset in `evaluate` is not returned, as GitHub does not);
more than 100 → a `Link` with `rel="next"`. `GET rulesets/<id>` computes
`current_user_can_bypass` for the session's account (`always` for a `User` actor naming it or a
`RepositoryRole` it holds with `always`; `pull_requests_only` for `pull_request`; `never`
otherwise) and shows `bypass_actors` only to an admin. `GET git/ref/heads/<b>` reads the bare
repository with the fake's own git (`rev-parse --verify refs/heads/<b>`), 404 when it has no
such branch. `tests/support/fake-gh.ts` gains `protectedMain()` (Step 1's first row as a fake
ruleset, `ada` holding `{ admin: true, maintain: false, push: true }`, so the bypass list is
readable) and `repository(model)` helpers. Fails: `readProtection` and `preflight` do not exist.

- *reads what § 8 needs, in order, and nothing more* — for a protected `main`: `repository`,
  `rules`, one `ruleset`; `gh.calls()` 3 after `readProtection`, 4 after `preflight` (the base
  ref); the fake's `.sent` shows only `GET`.
- *reads the branch only when no ruleset supplies a rule* — the classic case reads `branches/main`;
  the protected case never does.
- *stops at item 1* — archived: one call after `repository`, no `rules`.
- *refuses more than it reasons about* — 101 rules: `GitHubAnswerError` `paginated`
  (`github.com/acme/iac's main has more than 100 rules, more than this build reasons about.
  Nothing was written.`); eleven supplying rulesets: refused before the eleventh is read
  (`… draws its rules from more than 10 rulesets, more than this build reads …`), status
  `too-large`.
- *says whether the base is level* — the bare repository's `main` at the clone's commit:
  `level: 'level'`; one commit ahead: `{ github: <its sha> }`; no `main` there: `GitHubAnswerError`
  404 on `ref`, whose message names the branch GitHub does not have.
- *reads a base with a slash as GitHub addresses it* — `release/1`: the paths sent are
  `…/rules/branches/release/1?per_page=100` and `…/git/ref/heads/release/1`, the literal `/`
  kept (§ 10's named case).
- *reads no field it does not need* — a repository answer with `owner`, `description` and a
  canary field: parsed; a ruleset answer missing `id`: `unreadable`.

- [ ] **Step 3: The command, failing first** (`tests/unit/protection-command.test.ts`)

Through `main(['protection', …], { gh: fake.process, env, cwd, out, err, client: untouchable })`,
over clones from `tests/support/git.ts` whose upstream is `origin` on `git@github.com:acme/iac.git`
(no push is made, so no bare repository is needed until the level check, which this command does
not make). `observable(repo)` and `stored(repo)` are equal before and after every case. Fails:
`protection` is a phrase today (`parsePhrase`), and with no model configured it is refused on
the configuration.

| Case | Exit | stdout | stderr |
|---|---|---|---|
| `protectedMain()` | 0 | `renderProtection`'s holding block (below), byte for byte | `checking github.com/acme/iac's main (origin, main's upstream), as ada (gh)` |
| the same, `ada` with `push` only (`admin` and `maintain` false) | 0 | the block, its fourth line `ada (gh, write) cannot bypass ruleset 1 (current_user_can_bypass: never)` and its fifth `bypass list: not readable with ada's role, so a deploy key there would go unseen` | the same line (the role is read by the preflight, so the stderr line names none, as *Exact lines* words it) |
| no ruleset, `main` unprotected | 1 | the non-holding block, the four `missing:` lines and the nine lines | the `checking` line |
| classic only | 1 | `missing: a ruleset: main is protected by classic branch protection only, which idpa does not read` | |
| archived | 1 | `missing: …archived…` and no ruleset list | |
| logged out | 2 | nothing | the *gh is not logged in* sentence of *Exact lines* without the `--local` clause |
| gh not installed; too old; a Bot | 2 | nothing | each sentence, `purpose: 'protection'` |
| no upstream | 2 | nothing | `main tracks no remote: idpa protection checks a branch on github.com, and there is none to check here. Nothing was read.` |
| `origin` on GitLab | 2 | nothing | `the remote is on gitlab.example.com: idpa protection checks a branch on github.com, and this build reads no other host. Nothing was read.` |
| a local `credential.helper` | 2 | nothing | `configRefusal`'s sentence |
| not a clone's root; a folder of one; detached HEAD | 2 | nothing | stage 5's sentences, which name `--submit`, reworded for this command: `… idpa protection needs a clone's root` |
| `/repos/acme/iac` answering 404 | 1 | nothing | `GitHubAnswerError`'s 404 sentence |
| no `--repo`, standing in the clone (its markers) | as the first row | | `reading the declarations repository iac (the current directory); --repo <directory> checks another` then the `checking` line |
| no `--repo`, nothing configured, standing elsewhere | 2 | nothing | `protectionNeedsRepository`: `idpa protection needs a declarations repository: --repo <directory>, the current directory when it is one, or IDP_REPO or repo in <file> set once` and `protection`'s usage |
| `--demo`, `--backstage`, `--json`, `--local`, a positional | 2 | nothing | parseArgs' refusal, or `protection takes no argument but --repo`, and the usage |
| `protectoin` | 2 | | a slip away from `protection`, as `idpa grpah` is |
| `protection --help` | 0 | `protection`'s usage | |

No model is configured in any case, and the untouchable client throws if called: the command
reaches no model. The `checking` line and every value in the blocks pass `inertLine`.

**`renderProtection`, holding** (the first row, `protectedMain()` for `ada`, whom the fake's
`protectedMain()` makes the repository's administrator, as the owner is of `idpa-live`: GitHub
shows `bypass_actors` only to an administrator). The fourth line always names the role,
`<login> (gh, <role>) cannot bypass ruleset <id> (current_user_can_bypass: never)`, `<role>`
being `ProtectionVerdict.reported.role` — `admin`, `maintain` or `write` (a `read` role fails
on `no-push` and prints the non-holding block); the second row of the table pins `write`:

```text
github.com/acme/iac's main keeps a pull request from merging until someone other than its opener approves its latest commit, as gh reads it for ada:
  a pull request before merging, 1 approval (ruleset 1)
  approval of the most recent push (ruleset 1)
  force pushes blocked, deletions restricted (ruleset 1)
  ada (gh, admin) cannot bypass ruleset 1 (current_user_can_bypass: never)
  bypass list: empty
Reported, not required:
  review from Code Owners: not required
  status checks: none required, so a system downstream could not refuse a merge (ADR-0012)
  signed commits: not required
  merge queue: none
What no read can see:
  an administrator can edit or disable the ruleset outside idpa, and then merge; GitHub records it in the ruleset's history
  the credential your git pushes with: a deploy key or another account's key in the bypass list could move main without a pull request; push as ada (docs/submitting.md)
  whether GitHub Actions or an app may approve pull requests here (Settings → Actions → General → Workflow permissions)
Also advised: a ruleset on refs/heads/idp-agent/** blocking force pushes and deletions, so a branch under review is never rewritten.
```

With `dismissStaleOnly`, the second line reads `stale approvals dismissed on a new push (ruleset
1); approval of the most recent push is not set, so the account your git pushes with could
approve a pull request gh opened`. With `bypassActors: 'unreadable'`: `bypass list: not readable
with ada's role, so a deploy key there would go unseen`. With visible actors: `bypass list: 1
app and 1 team; none is you, as gh reads you`. Status checks: `status checks: ci, deploy/tufin`.

**Not holding** (`missing` → text by a `switch` over `Missing` with `const _exhaustive: never`):

```text
github.com/acme/iac's main does not stop the person who would open a pull request from merging it:
  missing: a pull request rule requiring 1 approval
  missing: approval of the most recent push
  missing: block force pushes
  missing: restrict deletions
Add a ruleset on main (Settings → Rules → Rulesets):
  required · require a pull request before merging — 1 approval
  …the nine lines of protectionText()…
Then run idpa protection again.
```

The other `missing:` texts: `approvals` "at least 1 required approval (the pull request rule
requires 0)"; `bypassable` "rules ada cannot bypass: a ruleset that supplies them lets gh's
account bypass it"; `deploy-key` "no deploy key in the bypass list: a ruleset that supplies these
rules lets a deploy key bypass it, and a deploy key pushes with git, where gh cannot see it";
`classic-only` above; `archived` "a repository that is not archived: github.com/acme/iac is";
`no-push` "push access: ada cannot push to acme/iac"; `renamed` "the remote's name: GitHub
answers <full_name>, so the repository was renamed or transferred; update the remote's URL".
The ruleset list is printed only when one of `pull-request` to `classic-only` is missing.
`renderUnprotected(verdict, road)` is the submission block of *Exact lines* over the same `missing:`
lines: `not submitted — nothing on github.com/acme/iac's main stops the person who would open
this pull request from merging it:`, the lines, `Add a ruleset on main (Settings → Rules →
Rulesets):`, `protectionText()`, `Then run this again. Nothing was written.` — unit-tested here,
first called by 6.2.2's `refuseUnprotected`.

- [ ] **Step 4: `init platform`'s list, failing first** (`tests/unit/init-command.test.ts:124-137`)

The case *prints the branch protection it cannot set, on every run* becomes *prints the ruleset
idpa protection checks, on every run*: both runs print `Branch protection is set in the forge,
not here. Add a ruleset on the default branch (Settings → Rules → Rulesets):`, then exactly
`protectionText()`'s nine lines, then `idpa protection checks them once the repository is on
GitHub.`; neither says `stage 6` nor `cannot verify`; the ADR-0012 line still names a status
check. *Fails:* `BRANCH_PROTECTION` prints six unlevelled lines and "arrives at stage 6".
`src/cli/commands/init.ts:76-90`: `BRANCH_PROTECTION` removed, the three lines built from
`protectionText()`.

- [ ] **Step 5: The key-reach leg, failing first** (`tests/contract/key-reach.test.ts`)

A `describe('idpa protection')`, the first command that starts gh (§ 16: "the key-reach leg for
`idpa protection`, the first command that starts gh"): `main(['protection', '--repo', clone],
{ gh: fake.process, env: { PATH, HOME, XDG_CONFIG_HOME, GH_TOKEN: GH_CANARY, GITHUB_TOKEN:
GH_CANARY, OPENAI_API_KEY: KEY, IDP_BACKSTAGE_TOKEN: TOKEN, GH_HOST: 'evil.example' } })` over
`protectedMain()`:

- exit 0; every environment the fake received (`fake.sent`) holds `GH_CANARY` in `GH_TOKEN` and
  `GITHUB_TOKEN`, unchanged, and neither `KEY`, `TOKEN` nor `GH_HOST`; every argv and stdin the
  fake received holds none of the three;
- every environment handed to `execFile` (the file's `vi.mock`) holds neither `KEY` nor `TOKEN`
  (git keeps `GH_TOKEN` by § 5's table: the person's, passed unread);
- stdout and stderr hold none of the three canaries.

*Fails:* `protection` is not a command (the run is a phrase, refused on the configuration, and
the fake received nothing, so the first assertion on `fake.sent` fails before any other).

- [ ] **Step 6: The code**

`src/forge/github/open.ts`:

```typescript
/**
 * The road and, on GitHub's, gh's identity: what `idpa protection` and, from
 * 6.2.2, every submission open first. Before the road, the clone's root, as
 * `openLocalForge` requires it — `git -C` walks upwards, and a folder of
 * another repository would read that repository's upstream.
 */
export async function openGitHub(input: {
  repo: string
  env: NodeJS.ProcessEnv
  gh?: GhProcess
  local: boolean
  git?: Git
  purpose?: 'submission' | 'protection'
}): Promise<GitHubSide> {
  const git = input.git ?? gitIn(input.repo, { env: input.env })
  await requireCloneRoot(git, input.repo, input.purpose ?? 'submission')
  const road = await readRoad(git, { local: input.local })
  if (road.kind === 'local') return { road }
  const gh = githubClient({ env: input.env, ...(input.gh === undefined ? {} : { run: input.gh }) })
  const identity = await readIdentity(gh, road, input.purpose ?? 'submission')
  return { road, identity, api: githubApi(gh, road.repository) }
}
```

`runProtection` (`src/cli/commands/protection.ts`): `openGitHub({ …, local: false, purpose:
'protection' })`; a `LocalRoad` is `ForgeInputError` by its `why` (a `switch` with
`const _exhaustive: never`; `'asked'` cannot occur here and throws a programming error);
`notice(checking line)`; `readProtection`; `{ text: renderProtection(…), found: verdict.holds }`.
`src/cli/index.ts`: the `protection` branch finds the repository with
`sourceOf({ command: 'protection', repo }, context)` (the plan chain: never the demo SI, never a
catalogue), says it with `sourceNotice('protection', …)` when it was not typed, refuses none
found with `protectionNeedsRepository`, and hands `env: deps.env ?? process.env` and `gh:
deps.gh`. `failed()` prints a `GitHubAnswerError` by its message, exit 1, and a `GhError` that
escaped the wrapping (matched by name, as `isGitError` is) the same way. `HELP` gains:

```text
  idp-agent protection [--repo <directory>]
```

and a paragraph: `protection checks, through your gh and with reads only, that the branch the
clone tracks on github.com keeps a pull request from merging until someone other than its opener
approves its latest commit, and prints the ruleset to add when it does not. It needs gh logged in
to github.com as you, and no model; it writes nothing.`

**`tools/fake-gh.ts` becomes runnable**: `node tools/fake-gh.ts <gh's arguments>` reads the state
from the JSON file `FAKE_GH_STATE` names, answers as `answer()` does, writes stdout and stderr,
exits with the code (a state with `installed: false` is not representable there: the demo
removes the fake from `PATH` instead). `tests/unit/fake-gh.test.ts` gains a case that spawns it
with `process.execPath` and a state file and gets the in-process answer's bytes, where Node
strips types (skipped, and said, where it does not).

**`scripts/demo-github.mjs`** (`pnpm demo:github`), the offline counterpart of `pnpm
demo:backstage`, run after `pnpm build`, refused by `strippingRefusal()` where Node does not
strip types:

1. A scratch directory (`mkdtemp`, removed on `exit`): `iac`, a copy of `fixtures/si-demo`,
   committed on `main` by the fixture's own git (`GIT_CONFIG_GLOBAL=/dev/null`,
   `GIT_CONFIG_NOSYSTEM=1`, a local identity), `origin` = `git@github.com:acme/iac.git`,
   `branch.main.remote origin`, `branch.main.merge refs/heads/main` (set with `git config`: nothing
   is fetched).
2. `bin/gh`, `#!/bin/sh` `exec "<node>" --disable-warning=ExperimentalWarning "<root>/tools/fake-gh.ts"
   "$@"`; `bin/ssh`, a guard that exits 97 (nothing is pushed in 6.1.3; 6.2.2 adds the fake ssh).
3. The binary's environment: the process's minus every `IDP_*`, `*_API_KEY`, `GH_*`, `GITHUB_*`,
   `GIT_*`, `SSH_AUTH_SOCK` and `SSH_ASKPASS`; `HOME`, `XDG_CONFIG_HOME` and `GH_CONFIG_DIR` in the
   scratch directory; `PATH` with `bin` first; `FAKE_GH_STATE` the state file.
4. Three steps, each printing `$ node dist/cli/bin.js protection --repo iac`, stderr then
   stdout, and `(exit N)`, failing on any other code:
   - *1. The repository has no ruleset yet* — `acme/iac`, `ada` with push, `main` unprotected, no
     ruleset: exit 1;
   - *2. After the ruleset of docs/submitting.md* — `protectedMain()`'s ruleset: exit 0;
   - *3. gh logged out* — no session: exit 2.
5. `Done. No model was called, nothing was pushed, and the only gh this ran was the fake.`

`scripts/smoke.mjs`: the binary's environment in `check()` gains a guard `gh` and `ssh` first
on `PATH` and a scratch `HOME` and `GH_CONFIG_DIR` (Constraint 6), and loses `GH_*`,
`GITHUB_*`, `SSH_AUTH_SOCK` and `SSH_ASKPASS`; a check `protection --repo submitted` answers
exit 2 with `main tracks no remote: idpa protection checks a branch on github.com`; and, where
`strippingRefusal()` answers nothing, it runs `scripts/demo-github.mjs` and requires exit 0 and
`^\$ node dist/cli/bin\.js protection --repo iac$`, `^checking github\.com/acme/iac's main
\(origin, main's upstream\), as ada \(gh\)$`, `^\(exit 1\)$`, `^\(exit 0\)$`, `^\(exit 2\)$`,
`^Done\. No model was called, nothing was pushed, and the only gh this ran was the fake\.$`;
elsewhere `skipped pnpm demo:github: <why>`. `tests/unit/package-scripts.test.ts` gains
`describe('pnpm demo:github')`: the script is `node scripts/demo-github.mjs`, the smoke runs it
and skips it on the refusal's words, the demo deletes `GH_TOKEN` and `GITHUB_TOKEN` from what it
runs and puts its own `gh` first on `PATH`, and removes its scratch directory on `exit`.

**`docs/submitting.md`** (new; 6.2.2 extends it, 6.4.2 completes it): what a person needs — git
able to push to the repository as they already do, gh at least 2.40.0 (provisional until 6.4.1)
logged in to github.com as themselves (`gh auth login --hostname github.com`), no token for idpa;
the ruleset, step by step on the web page (Settings → Rules → Rulesets → New ruleset → New branch
ruleset; enforcement *Active*; bypass list empty; target *Include default branch*; *Restrict
deletions*, *Require a pull request before merging* with 1 required approval and *Require
approval of the most recent reviewable push*, *Block force pushes*), with `PROTECTION_SETTINGS`'
nine lines; `idpa protection` and its three exits, what it prints and what no read can see (§ 8);
pushing as gh's account (`gh auth setup-git` over HTTPS, a key of the same account over SSH);
the clone's own configuration — the refused sections and keys, the six kept, and the move of a
common one to the global configuration (`git config --local --unset-all credential.helper` then
`git config --global credential.helper …`). `tests/unit/doc-symbols.test.ts` holds it from now
on.

- [ ] **Step 7: Run what changed**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/protection.test.ts tests/unit/preflight.test.ts tests/unit/protection-command.test.ts tests/unit/init-command.test.ts tests/unit/fake-gh.test.ts tests/unit/package-scripts.test.ts tests/unit/doc-symbols.test.ts tests/unit/entry.test.ts tests/unit/run-usage.test.ts tests/contract/key-reach.test.ts
pnpm vitest run tests/architecture --reporter=verbose
```

Expected: PASS; **29** rules (6.1.3 adds none: `cli/` loads `forge/github/open.ts` and
`preflight.ts`, which *only cli/ reaches forge/ at runtime* allows, and names `GhProcess` by
type only). `entry.test.ts`'s *knows every command HELP lists* passes with the new line.

- [ ] **Step 8: The documents this makes true**

- `AGENTS.md`: `idp-agent protection [--repo <dir>]` in *Current state*'s block, with one
  sentence (reads through the person's gh, no model, no write); the exit codes' paragraph: `idpa
  protection` is `0` the rules hold, `1` they do not or GitHub answered a failure, `2` the
  arguments, the clone's configuration, its upstream or gh refused; the `init platform`
  sentence; the test count.
- `README.md`: `idp-agent protection [--repo <dir>]` in the block at `:423-428`, a row in the
  table at `:465`, and the `init platform` row's "branch-protection checklist" becomes "the
  ruleset `idpa protection` checks". No `text` block runs it: `readme-commands.test.ts` runs every
  `$ node dist/cli/bin.js` block with no gh.
- `SECURITY.md`, *What leaves your machine*: a row "Through your gh, to github.com: the reads
  `idpa protection` makes (the repository, the rules for the base, each supplying ruleset, the
  branch), `GET` only; idpa holds no credential, and gh authenticates as it always does for you",
  with the test (`key-reach.test.ts`, *idpa protection*).
- `src/cli/README.md`: the command, `MainDeps.gh`.

- [ ] **Step 9: Traceability, checks, the pull request** *(after the owner's go-ahead)*

`CHANGELOG.md`, Unreleased → **Added**:

> - `idpa protection [--repo <clone>]` says whether the branch the clone tracks on github.com
>   keeps a pull request from merging until someone other than its opener approves its latest
>   commit: through the person's own gh, with reads only, it checks a pull request rule of at
>   least one approval, approval of the most recent push (or stale approvals dismissed), no force
>   push, no deletion, and that gh's account cannot bypass them, refuses a base protected only by
>   classic branch protection or a deploy key in a bypass list, and states what no read can see.
>   Exit 0 when the rules hold, 1 when they do not, with the ruleset to add, 2 when gh or the
>   clone is refused; no model, nothing written. `init platform` prints the same list of settings
>   and names the command, and `pnpm demo:github` shows the three answers against a fake gh
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

`docs/roadmap.md`: the stage 6 row → "slice 6.1 done: 6.1.1 ([#…]), 6.1.2 ([#…]), 6.1.3 ([#…])";
the queue item 2 says slice 6.1 is on `main`; the decisions section records decision 13 as
built.

```bash
df -h "$TMPDIR"
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
git add src/core/github src/forge/github src/cli/commands/protection.ts src/cli/render/protection.ts src/cli/index.ts src/cli/repository.ts src/cli/source.ts src/cli/commands/init.ts src/cli/README.md tools/fake-gh.ts tests/support/fake-gh.ts scripts/demo-github.mjs scripts/smoke.mjs package.json docs/submitting.md tests/unit/protection.test.ts tests/unit/preflight.test.ts tests/unit/protection-command.test.ts tests/unit/init-command.test.ts tests/unit/fake-gh.test.ts tests/unit/package-scripts.test.ts tests/unit/doc-symbols.test.ts tests/contract/key-reach.test.ts AGENTS.md README.md SECURITY.md CHANGELOG.md docs/roadmap.md docs/plans/stage-6-github.md
git commit -m "feat(cli): idpa protection reads the base's ruleset through the person's gh, and init platform prints the one list it checks"
```

Base `feat/s6-remote`. Exhaustive switches added: `Missing` (the `missing:` texts), `Road` and
`LocalRoad['why']` (`runProtection`). Architecture rules: **29**, unchanged.

**What the owner can run.** Offline first, from the worktree, keyless: no gh, no ssh, no network.

```bash
pnpm build
pnpm demo:github
```

Attendu :
- step 1 prints `$ node dist/cli/bin.js protection --repo iac`, then on stderr `checking
  github.com/acme/iac's main (origin, main's upstream), as ada (gh)`, then the four `missing:`
  lines, `Add a ruleset on main (Settings → Rules → Rulesets):`, the nine `required ·`/`advised  ·`
  lines, and `(exit 1)`;
- step 2 prints the same `checking` line, `github.com/acme/iac's main keeps a pull request from
  merging until someone other than its opener approves its latest commit, as gh reads it for
  ada:`, `bypass list: empty` among its lines, *What no read can see* and its three lines, and
  `(exit 0)`;
- step 3 prints only ``main tracks github.com/acme/iac, and gh is not logged in to github.com, so
  idpa cannot read the rules that keep a pull request from merging unreviewed. Run `gh auth login
  --hostname github.com`, then run this again. Nothing was written.`` and `(exit 2)`;
- the last line is `Done. No model was called, nothing was pushed, and the only gh this ran was
  the fake.`, exit 0.

Then live, with the owner's own gh, against a public throwaway repository (§ 16; the first line
is the only one to edit). From the worktree, after `pnpm build`:

```bash
OWNER=your-login
gh auth status --hostname github.com
cp -R fixtures/si-demo ~/idpa-live
git -C ~/idpa-live init -q -b main
git -C ~/idpa-live add -A
git -C ~/idpa-live commit -qm "chore: the demo catalogue"
gh repo create "$OWNER/idpa-live" --public
git -C ~/idpa-live remote add origin "git@github.com:$OWNER/idpa-live.git"
git -C ~/idpa-live push -u origin main
node dist/cli/bin.js protection --repo ~/idpa-live
echo "exit $?"
```

Attendu :
- `gh auth status` says the owner is logged in to github.com;
- the `protection` run prints on stderr `checking github.com/<your login>/idpa-live's main
  (origin, main's upstream), as <your login> (gh)`, then the four `missing:` lines and the nine
  lines of the ruleset to add; `exit 1`.

Then add the ruleset on the repository's web page — Settings → Rules → Rulesets → New ruleset →
New branch ruleset; name `idpa`; enforcement *Active*; bypass list left empty; target branches
*Include default branch*; tick *Restrict deletions*, *Require a pull request before merging* (1
required approval, *Require approval of the most recent reviewable push*), *Block force pushes*;
Create — and, in the same terminal:

```bash
node dist/cli/bin.js protection --repo ~/idpa-live
echo "exit $?"
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$(mktemp -d)" node dist/cli/bin.js protection --repo ~/idpa-live
echo "exit $?"
```

Attendu :
- the first run prints the holding block: the three rule lines naming the ruleset's id,
  `<your login> (gh, admin) cannot bypass ruleset <id> (current_user_can_bypass: never)` — the
  owner is the repository's administrator, and § 17's first unknown is answered here: if GitHub
  answers anything but `never` for an administrator outside the bypass list, the run exits 1 with
  `missing: rules <your login> cannot bypass…`, and that answer is recorded for 6.4.1 —
  `bypass list: empty`, the *Reported* and *What no read can see* sections; `exit 0`;
- the second run, with a gh that has no login, prints only the *gh is not logged in to
  github.com* sentence; `exit 2`. The owner's own gh login is untouched: `GH_CONFIG_DIR` pointed
  gh at an empty directory for that one command.

---

## Slice 6.2 — the GitHub forge on `plan --from`

Closed by 6.2.2: `plan --from … --submit` opens a pull request; the other roads are refused toward GitHub until slice 6.3.

### Task 6.2.1: The GitHub forge — recognition, the re-check, the push, the read-back, the pull request

**Goal.** One `ForgeProvider` of `name: 'github'` that holds the local forge and adds the
remote half of § 3's steps 6 and 8 to 12: it recognises a submission already on GitHub before
anyone is asked (§ 14), re-reads the clone's configuration, the base's rules and the base's
tip at the moment of acting, cuts stage 5's local branch, pushes that very commit create-only
with the person's git, reads it back through gh, reads the rules once more, and opens one pull
request whose body the engine writes. Nothing reaches it from the command line yet: 6.2.2
wires it. Everything is proved offline, against the fake gh and a bare repository on disk,
the doors of § 10 included.

**Branch** `feat/s6-github-forge`, cut from `feat/s6-protection` (6.1.3). Global Constraints 1,
2, 3, 4, 5, 6, 8, 10, 11, 12, 15.

**Read on `2b2250e`, and what this task changes there.**

- `src/forge/local/forge.ts:176-229`, `existing()`: "ours" means one commit on **the base**
  (`parent !== at.commit` refuses, `:195-200`, D7). The older base of § 14 is an option of the
  opener, `acceptOlderBase`, read by `existing()` alone; without it, every line of `:176-229`
  answers as it does today, and `local-forge.test.ts`'s *refuses our files on a parent that is
  not the base* is unchanged.
- `:100`, the object format, read inside `openLocalForge` and not exported. It moves to
  `objectFormat(git)` in `objects.ts`, which the local forge and the GitHub forge both call:
  what `treeFor` needs of the format.
- `objects.ts:53-102`, `writeTree`: `ls-tree -z <tree>` level by level, then `mktree -z`.
  `treeFor` reads the same way and hashes each level in JavaScript instead of calling
  `mktree`, so it writes nothing and the git grammar of 6.1.1 gains no shape.
- `src/forge/provider.ts:16-31` and the comment at `:33-48`. `Submitted` and `Recognised` widen
  as the shared names say; the sentence "with the token this interface holds" is rewritten.
- `src/cli/commands/submit.ts:229-262`, `outcomeOf`, switches on `Submitted` with a `never`
  default. Widening `Submitted` breaks that switch, and this pull request must be green on
  its own, so the two new outcomes get a case each that throws a programming error (no road
  opens the GitHub forge until 6.2.2, which replaces both cases). Nothing else in `cli/`
  changes here.
- `src/core/plan/clear.ts:266-285`, `mint`: a `Cleared` carries `message`, not the request
  on its own. The pull request's body fences the request (§ 12), so `Cleared` gains
  `request`, the very string `messageFor` writes into the body (`cut(plan.intent, 500)`, now
  one internal function both call). No byte of any commit message moves, so no branch stage 5
  cut stops being recognised.

**Files:**
- Create: `src/forge/local/tree.ts`, `src/core/github/pull-request.ts`,
  `src/forge/github/push.ts`, `src/forge/github/forge.ts`, `tests/support/github-fixture.ts`
- Modify: `src/forge/local/objects.ts` (`treeId`, `objectFormat`), `src/forge/local/forge.ts`
  (`acceptOlderBase`, `objectFormat`), `src/forge/provider.ts`, `src/core/plan/clear.ts`
  (`Cleared.request`), `src/core/github/answers.ts` (`commitAnswer`, `pullsAnswer`,
  `pullAnswer`), `src/forge/github/api.ts` (`commit`, `pulls`, `openPullRequest`, `calls`),
  `src/forge/github/preflight.ts` (`readRules`, split out of `preflight`, no behaviour moved),
  `src/cli/commands/submit.ts` (the two interim cases), `tools/fake-gh.ts` (pull requests,
  reviews, merges, the doors, faults), `tests/support/fake-gh.ts` (`MERGE_DOOR`, the new
  model methods)
- Modify: `src/forge/README.md`, `src/forge/github/README.md`, `src/core/README.md`
- Create (tests): `tests/unit/tree-for.test.ts`, `tests/unit/pull-request-body.test.ts`,
  `tests/unit/github-pulls.test.ts`, `tests/unit/github-forge.test.ts`,
  `tests/unit/merge-refused.test.ts`, `tests/unit/hostile-clone.test.ts`,
  `tests/unit/forge-types.test.ts`, `tests/invariants/github-forge.test.ts`
- Modify (tests): `tests/unit/local-forge.test.ts` (the older base), `tests/unit/clear.test.ts`
  (`request`), `tests/unit/fake-gh.test.ts` (the new routes and doors of the model)
- Modify: `AGENTS.md` (the `forge/` row of the layering table, the test count), `README.md`
  (the badge), `CHANGELOG.md`, `docs/roadmap.md`

**Interfaces.** Consumes, as the shared names state them: `GhProcess`, `GhClient`, `GhRoute`,
`GhError` (6.1.1, `process/gh.ts`); `Push`, `PushRequest`, `PushOutcome`, `PushFlag`,
`pushIn`, `GitError`, `gitIn`, `Git` (6.1.1, `process/git.ts`); `GitHubRepository`,
`sameRepository` (6.1.2); `readRoad`, `GitHubRoad`, `GhIdentity`, `githubClient`,
`githubApi`, `GitHubApi`, `GitHubAnswerError`, `GITHUB_LIMITS` (6.1.2); `preflight`,
`ProtectionVerdict`, `openGitHub`, `GitHubSide`, `refAnswer`, `rulesAnswer`, `rulesetAnswer`
(6.1.3); `fakeGitHub`, `FakeGitHub`, `DOORS`, `FAKE_GH_VERSION` (6.1.1, 6.1.3); `clone`,
`clearedFor`, `committed`, `observable`, `stored`, `scratch`, `removeClones` (stage 5).
Produces:

```typescript
// src/forge/local/objects.ts
export function treeId(entries: ReadonlyMap<string, TreeEntry>, format: 'sha1' | 'sha256'): string
export async function objectFormat(git: Git): Promise<'sha1' | 'sha256'>

// src/forge/local/tree.ts
export async function treeFor(
  git: Git,
  parent: string,
  edits: readonly FileEdit[],
  format: 'sha1' | 'sha256',
): Promise<string>

// src/forge/local/forge.ts
export async function openLocalForge(
  repo: string,
  repository: Repository,
  git?: Git,
  options?: { readonly acceptOlderBase?: boolean },
): Promise<ForgeProvider>

// src/forge/provider.ts — the shared shapes; the fields marked (+) are this task's
export interface PullRequest {
  readonly host: 'github.com'
  readonly repository: string      // 'acme/iac': the host is its own field
  readonly number: number
  readonly url: string             // pullRequestUrl's, never GitHub's html_url
  readonly state: 'opened' | 'open'
  readonly base: string
}
export type Submitted =
  | {
      readonly outcome: 'created'
      readonly branch: string
      readonly commit: string
      /** This run pushed the branch. Absent on the local forge. */
      readonly pushed?: boolean
      readonly pullRequest?: PullRequest
      /** (+) The parent, when it is an ancestor of the base and not the base (§ 14). */
      readonly olderBase?: string
      /** (+) The contexts the rules read at step 11 require, for the closing line (§ 11). */
      readonly statusChecks?: readonly string[]
    }
  | {
      readonly outcome: 'already-submitted'
      readonly branch: string
      readonly commit: string
      readonly pushed?: boolean
      readonly pullRequest?: PullRequest
      readonly olderBase?: string
    }
  | { readonly outcome: 'unchanged' }
  /** (+) `kept`: the local branch this run cut and leaves, when the refusal came after step 9. */
  | { readonly outcome: 'refused'; readonly reason: string; readonly kept?: string }
  | { readonly outcome: 'pushed-without-pull-request'; readonly branch: string; readonly commit: string; readonly reason: string }
  | { readonly outcome: 'closed'; readonly branch: string; readonly number: number; readonly merged: boolean; readonly at: string }
export type Recognised = Extract<Submitted, { readonly outcome: 'already-submitted' | 'refused' | 'pushed-without-pull-request' | 'closed' }>
export interface ForgeProvider { readonly name: 'local' | 'github'; /* the rest unchanged */ }

// src/core/plan/clear.ts
export interface Cleared { /* … */ readonly request: string }   // (+) what messageFor records, cut at 500

// src/core/github/pull-request.ts — as the shared names state it
export interface PullRequestInput { readonly message: string; readonly request: string; readonly road: 'from' | 'intent' | 'init' | 'phrase'; readonly branch: string }
export function pullRequestBody(input: PullRequestInput): { readonly title: string; readonly body: string }
export function pullRequestUrl(repository: GitHubRepository, number: number): string
export function fenceFor(text: string): string
export const ENGINE_BLOCK_END = '<!-- idp-agent: end of the engine\'s block -->'

// src/forge/github/api.ts — added to GitHubApi
commit(sha: string): Promise<{ readonly sha: string; readonly tree: string; readonly parents: readonly string[]; readonly message: string }>
pulls(branch: string): Promise<readonly { readonly number: number; readonly state: 'open' | 'closed'; readonly merged: boolean; readonly at: string | undefined; readonly base: string; readonly head: string }[]>
openPullRequest(input: { readonly title: string; readonly head: string; readonly base: string; readonly body: string }): Promise<{ readonly number: number }>
calls(): number   // (+) the GhClient's count, for the trace's idp.forge.gh_calls (6.2.2)

// src/forge/github/preflight.ts
export async function readRules(api: GitHubApi, road: GitHubRoad, identity: GhIdentity): Promise<ProtectionVerdict>   // (+) § 8 items 2 and 3

// src/forge/github/push.ts
export type PushFailure = 'authentication' | 'host-key' | 'lease' | 'ruleset' | 'network' | 'other'
export function classifyPushFailure(error: GitError): PushFailure

// src/forge/github/forge.ts — the shared input, with (+) `route` and `now`
export function openGitHubForge(input: {
  readonly repo: string
  readonly local: ForgeProvider           // opened with acceptOlderBase: true
  readonly road: GitHubRoad
  readonly identity: GhIdentity
  readonly api: GitHubApi
  readonly env: NodeJS.ProcessEnv
  readonly route: PullRequestInput['road']  // (+) the road the pull request's block names (D4)
  readonly git?: Git                      // default gitIn(repo, { env })
  readonly push?: Push                    // default pushIn(repo, { env })
  readonly wait?: (ms: number) => Promise<void>
  readonly now?: () => number             // (+) the 180 s bound's clock; default Date.now
}): ForgeProvider

// tests/support/github-fixture.ts — githubClone, plus (+) three helpers
export async function githubClone(options?: { readonly model?: FakeModel }): Promise<{ repo: string; bare: string; env: NodeJS.ProcessEnv; gh: FakeGitHub }>
export async function fakeSsh(dir: string, bare: string, refuse?: 'publickey' | 'host-key'): Promise<string>
export async function githubForge(clone: Awaited<ReturnType<typeof githubClone>>, options?: { git?: Git; push?: Push; gh?: GhProcess; wait?: (ms: number) => Promise<void>; now?: () => number }): Promise<{ forge: ForgeProvider; road: GitHubRoad; identity: GhIdentity; api: GitHubApi }>
export async function remoteRefs(bare: string): Promise<string>

// tests/support/fake-gh.ts — (+) on FakeGitHub, and one named door
approve(number: number, login: string): void                           // a review, at the head's current commit
pushAs(actor: { type: 'User'; login: string } | { type: 'DeployKey'; id: number }, ref: string, commit: string): number   // a git push, judged by the model's rules; the status
fault(fault: { route: GhRoute['route'] | 'open-pull-request'; status: number | 'lost'; times: number }): void
export const MERGE_DOOR: (typeof DOORS)[number]                         // PUT …/pulls/1/merge, from DOORS
```

The names marked (+) are this task's additions to the shared names.

**The forge, in the order it acts.** Written here so the tests below have one reference.

`recognise(change, base)` reads only:

1. `local.recognise(change, base)`: stage 5's checks (a `Cleared` this module minted, for this
   repository) and the local branch. A local `refused` is returned as it is and **nothing is
   read on GitHub** (§ 14's last row). No edit: `undefined`, no gh call.
2. `api.ref(change.branch)` (404 is "absent") and `api.pulls(change.branch)`, the second sent
   whether or not the ref exists (§ 14).
3. The remote branch is **ours** when its commit is the local branch's commit, or, failing
   that, when `api.commit(sha)` answers one parent `P`, a message equal to `change.message`
   (or to it without its final newline: whether GitHub keeps that newline is one of the
   answers 6.4.1 records), and a tree equal to `treeFor(git, P, change.edits, format)`, with
   `P` the base's commit or an ancestor of it (`merge-base --is-ancestor P <base>`; any failure
   of that call, an unknown object included, is "not an ancestor"). An ancestor sets
   `olderBase: P`. Anything else is **not ours**.
4. The answer, first match wins:

| The remote branch | The pull requests from it | `recognise` answers |
|---|---|---|
| not ours; or absent, with one open | any | `refused`: "`<branch>` exists on github.com/acme/iac and carries a different change" |
| ours | one open, into `road.base` | `already-submitted`, `pullRequest.state: 'open'`, `olderBase` when set |
| any | one open, into another base | `refused`, naming that base |
| any | none open, the latest closed | `closed`, `merged` from `merged_at`, `at` the date of `merged_at` or `closed_at` |
| ours | none | `pushed-without-pull-request`, reason "the branch was pushed by an earlier run; opening its pull request" |
| absent | none, and the local branch is ours on an older base | `refused`: "`<branch>` is in this clone on main@abc1234, an older main, and was never opened for review; delete it (git branch -D `<branch>`) and run this again" |
| absent | none | `undefined`: asked, then submitted |

An open pull request with no branch on GitHub is in the first row: GitHub closes a pull request
whose head branch is deleted, so the pair is not a state this tool made, and nothing is claimed
of it.

`submit(change, base)` writes, and only past step 8:

- **First, before any read**: `isCleared(change)` and `change.repository`, stage 5's two checks,
  repeated here so that a clearance that is not ours costs no gh call. No edit: `local.submit`
  answers `unchanged` after its own re-check, and gh is not called.
- **A deadline**, `now() + GITHUB_LIMITS.submissionMs`, read before step 9, before the push and
  before the `POST`.
- **Step 8, the re-check** (reads only; a refusal here leaves nothing on either side):
  `readRoad(git, { local: false })` must answer the road the forge was opened on, field for
  field (a refused configuration key is `ForgeInputError` from `readRoad`; mid-run it is the
  repository moving, not an argument, so it becomes `refused` with that message, exit 1, as
  `forge.ts:274-278` does for a HEAD that moved); `readRules(api, road, identity)` must hold;
  `api.ref(road.base)` must be `base.commit`; `api.ref(change.branch)` is read again, and its
  commit judged as in recognition (`api.commit` only when it is not the local branch's).
  `pullRequestBody` is computed here, and a body past `GITHUB_LIMITS.bodyBytes` is refused
  here, before anything is written.
- **The remote branch is ours already** (the second and fourth rows of § 14's table, a push
  that landed on an earlier run): steps 9 and 10 are skipped, nothing is written locally, and
  the forge goes to the rules of step 11 (row 2 writes the pull request only).
- **The remote branch is not ours**: `refused`, nothing written.
- **Step 9**: `local.submit(change, base)`. `refused` and `unchanged` are returned as they are.
  Our local branch on an older base with nothing on GitHub is § 14's fifth row, `refused`,
  nothing written (the branch was there before this run).
- **Step 10**: `push({ url: road.pushUrl, commit, branch: change.branch })`, with the commit
  step 9 cut or recognised. `created` sets `pushed: true`. `up-to-date` and `rejected`, and a
  `GitError` that `classifyPushFailure` calls `lease`, are all answered by reading the ref
  back: our commit is a push that landed before its answer was lost (continue, `pushed:
  false`); another commit is "not ours" (`refused`, `kept`); no ref after a rejection is the
  remote refusing the ref, most likely a ruleset on `idp-agent/` branches (`refused`, `kept`).
  Every other `GitError` is classified and `refused`, `kept`, in one engine sentence per
  `PushFailure` (below), git's words never quoted. `pushIn`'s contract is 6.1.1's as it stands:
  a flag when the porcelain line for our ref was read, a `GitError` otherwise; this task
  answers a `rejected` flag and a `lease` error alike, so it holds whichever git answers.
- **Step 11, the read-back**: after a push, `api.ref(change.branch)` at most three times,
  waiting `readBack[0]` then `readBack[1]` between reads, and only on a 404. Our commit:
  continue. Still 404: `refused`, `kept`, "`<branch>` was pushed, and github.com/acme/iac does
  not show it yet. If your git configuration rewrites this URL or your ssh configuration this
  host, the push went elsewhere; otherwise run the same command again, which opens the pull
  request once GitHub shows the branch" (§ 4). Another commit: "not ours", `refused`, `kept`.
- **Step 11, the rules again**: `readRules` once more. Not holding: `pushed-without-pull-request`,
  reason "the pull request was not opened: the rules that keep it from merging unreviewed no
  longer hold on github.com/acme/iac's main (`<missing>`). Run the same command again once they
  do." Past the deadline: the same outcome, "the pull request was not opened: the submission
  took longer than 180 s. Run the same command again to open it."
- **Step 12**: `api.openPullRequest({ title, head: change.branch, base: road.base, body })`.
  A number: `created`, `pullRequest` built by the engine (`state: 'opened'`,
  `url: pullRequestUrl(road.repository, number)`), `statusChecks` from step 11's verdict,
  `olderBase` when set. A `GitHubAnswerError` of status 422: `api.pulls` once more; an open pull
  request from our branch into the base is `created` with `state: 'open'`; none is
  `pushed-without-pull-request`, "the pull request was not opened: GitHub answered 422 through
  gh. Run the same command again to open it." Any other status: the same sentence with its
  status. A `GhError` (an answer lost, a timeout): `api.pulls` once more, and without an open
  pull request, "gh did not say whether the pull request was opened. Run the same command
  again: it names the pull request, or opens it."
- **Anything thrown after step 9** (a `GitHubAnswerError`, a `GhError`, a `GitError` of a read)
  is caught and answered as `refused` with `kept` before the push, `pushed-without-pull-request`
  after it: a run that cut or pushed a branch never ends on a sentence that says nothing was
  written. Before step 9 a throw is left to `failed()` (exit 1, its message), nothing written.

The push's sentences, one per `PushFailure`, each ending "`<branch>` was cut in this clone and
nothing is on GitHub":

| `PushFailure` | read from | the sentence begins |
|---|---|---|
| `authentication` | `Permission denied (publickey`, `Authentication failed`, `could not read Username`, `terminal prompts disabled` | "your git could not authenticate to github.com; `git push` in this clone would fail the same way" |
| `host-key` | `Host key verification failed`, `REMOTE HOST IDENTIFICATION HAS CHANGED` | "your ssh does not trust github.com's host key; `ssh -T git@github.com` says why" |
| `lease` | `stale info` | (read back, above) |
| `ruleset` | `GH013`, `repository rule violations` | "a ruleset on github.com/acme/iac forbids creating idp-agent/… branches" |
| `network` | `Could not resolve host`, `Connection refused`, `Connection timed out`, `Connection reset`, a timeout (`timedOut`) | "the push to github.com did not complete: the network failed or took longer than 120 s" |
| `other` | anything else | "the push to github.com failed; `git push` in this clone would say why" |

Authentication is matched before the network: `Could not read from remote repository` follows
a refused key too, and is not read at all.

- [ ] **Step 1: Write the failing tests — `treeFor` and `treeId`**

`tests/unit/tree-for.test.ts`, over real repositories (`clone()`, test-side `git`):

- *computes the id git itself gives a tree* — for a listing holding a file, an executable, a
  folder and the names that sort differently once a folder is read as `name/` (`a-b`, `a.yml`,
  `a/`, `a0`), `treeId` equals `git mktree`'s answer; a folder's mode is written `40000` in the
  object though `ls-tree` prints `040000`.
- *computes the tree writeTree builds, and writes nothing* — a fast-check property over edit
  sets (new files in new and existing folders, nested three deep, amended files, an amended
  executable): `treeFor(git, HEAD, edits, format)` equals `writeTree`'s tree for the same blobs,
  and `stored(repo)` is byte for byte what it was before `treeFor` ran.
- *refuses what writeTree refuses* — a path under a file, and a file where the base has a
  folder: the same messages as `writeTree`.
- *hashes a sha256 repository with sha256* — `git init --object-format=sha256`; skipped, and
  saying so, where the git on the machine cannot create one.

Why they fail: `src/forge/local/tree.ts` does not exist and `objects.ts` exports no `treeId`;
the imports fail.

- [ ] **Step 2: Write the failing tests — the local forge's older base, and `Cleared.request`**

Add to `tests/unit/local-forge.test.ts`, reusing its `land` helper:

- *with acceptOlderBase, calls our one commit on an ancestor of the base already submitted, and
  names that base* — cut the branch, then commit an unrelated change on `main`: without the
  option, `recognise` refuses as today; with it, `{ outcome: 'already-submitted', olderBase:
  <the old main> }`, nothing written.
- *with acceptOlderBase, still refuses our files on a parent that is not an ancestor of the
  base* — the fixture of *refuses our files on a parent that is not the base*, the option set:
  the same refusal.
- *with acceptOlderBase, still refuses a second commit, other bytes or another message on an
  older base* — one case each.

Add to `tests/unit/clear.test.ts`: *carries the request as the commit records it* —
`cleared.request` is the line `messageFor` writes under "Requested, as recorded with the plan",
without its indentation, and a 600-character intent is cut to 500 code points there as well.

Why they fail: `openLocalForge` takes no fourth argument (a type error, and at run time the
option is ignored, so `recognise` refuses); `Cleared` has no `request`.

- [ ] **Step 3: Write the failing tests — the pull request's text**

`tests/unit/pull-request-body.test.ts`, over `messageFor`'s real output (a `Cleared` from
`clearedFor`):

- *titles the pull request with the commit's subject* — `title` is the message's first line.
- *keeps the request inside a fence no line of it can close* — for requests holding `` ` ``,
  ` ``` `, ` ```` `, an `@acme/platform`, a `[link](https://example.com)`, an image, an
  `<!-- comment -->` and a `#123`: every line between the opening and the closing fence is the
  request's, the fence is one backtick longer than the longest run in it and never shorter
  than three, and no line of the request appears outside it. Then a fast-check property over
  arbitrary strings.
- *names the road in D4's words* — `from`: "from a plan file: four gates, the schema, the
  signature, the policies and the re-check, and no Reviewer"; `intent`: "drafted by a model:
  five gates, the schema, the signature, the policies, the re-check and the Reviewer last";
  `phrase`: the intent's words, "from a phrase idpa took for a change"; `init`: "written by
  idpa init in the service's own repository, from what a person typed". A `switch` over the
  road with a `never` default, so a fifth road fails to compile.
- *ends on the marker stage 8 appends after* — the body's last line is `ENGINE_BLOCK_END`, and
  the block above it holds the branch, the sentence on what its digest means ("the same change
  always names the same branch"), and `CLOSING`'s words.
- *builds the URL from what was parsed, never from GitHub* — `pullRequestUrl({ host:
  'github.com', owner: 'acme', name: 'iac' }, 42)` is `https://github.com/acme/iac/pull/42`;
  `0`, `-1`, `1.5`, `NaN` and `2 ** 53` throw.

Why they fail: `src/core/github/pull-request.ts` does not exist.

- [ ] **Step 4: Write the failing tests — the three new routes**

`tests/unit/github-pulls.test.ts`, against `fakeGitHub()` and a stub `GhProcess` answering
chosen bytes:

- *reads a commit's parents, tree and message, and nothing else* — `api.commit(sha)` against
  the fake over a bare repository; a body with an extra field parses, one missing `tree` is a
  `GitHubAnswerError` of status `unreadable`.
- *lists the pull requests from one branch, closed ones included, on one page* —
  `api.pulls(branch)` sends `head=acme:idp-agent/…&state=all&per_page=100` (read back from the
  vector the stub recorded); a `Link: rel="next"` is `GitHubAnswerError` `paginated`.
- *opens a pull request with the engine's body on standard input, and never as an argument* —
  the stub records the vector (no `-f`, no `-F`, `--input -`) and a stdin whose JSON has
  exactly `title`, `head` (the bare branch), `base`, `body`, `draft: false`,
  `maintainer_can_modify: false`; a 201 answers the number; a 422 is `GitHubAnswerError` status
  `422`; a body past 1 MiB throws before any process starts. The body is built as
  `JSON.stringify({ title, head, base, body, draft: false, maintainer_can_modify: false })`,
  the keys in exactly that order and with no replacer or indentation: it is the only form
  `checkGhArgv` admits (6.1.1, as built), and any other would be refused as a
  `LauncherRefusal` on every pull request — a programming error, not a GitHub answer.
- *opens at most one pull request per run, whatever the first answered* — a second
  `api.openPullRequest(…)` on the same `api`, after a 201, after a 422 and after a stub that
  timed out, throws `Error('idp-agent asked to open a second pull request in one run')` before
  any process starts, and the stub records one `POST`. § 14 makes the `POST` the one write, and
  only the forge's control flow keeps it one today (after a 422 or a lost answer it lists
  again); this makes a second `POST` a programming error of the API, as the 49th call is.
- *counts every call it made* — `api.calls()` equals the stub's count.

Why they fail: `GitHubApi` has no `commit`, `pulls`, `openPullRequest` or `calls`, and
`answers.ts` no `commitAnswer`, `pullsAnswer` or `pullAnswer`.

- [ ] **Step 5: Write the failing tests — § 14's rows, the re-check, the push, the read-back**

`tests/unit/github-forge.test.ts`. Each test starts from `githubClone()` (a committed clone
whose `main` tracks `git@github.com:acme/iac.git`, level with a bare repository; the fake gh
logged in as `ada`, a person with push access, the ruleset of § 8 on `main`, bypass list empty;
`GIT_SSH_COMMAND` a fake ssh that runs `git receive-pack` on the bare repository, and
`GIT_SSH_VARIANT=simple`), a `Cleared` from `clearedFor(repo)`, and `githubForge(clone)`.
"Nothing written" is always three facts: `observable(repo)`, `remoteRefs(bare)` and the fake's
pull requests, each as it was.

Recognition, one test per row, named by it:

- *finds nothing to recognise when neither side holds the branch* — `undefined`; two gh calls
  made by `recognise` (the ref, the pull requests; no commit read), counted as the difference of
  `api.calls()` across the call, so the identity's two reads made by `githubForge` do not count.
- *submits: the local branch, the same commit on GitHub, and one pull request into main* —
  `created`, `pushed: true`, `pullRequest: { host: 'github.com', repository: 'acme/iac', number:
  1, url: 'https://github.com/acme/iac/pull/1', state: 'opened', base: 'main' }`,
  `statusChecks: []`; the bare repository's `refs/heads/<branch>` is the local branch's commit;
  `main` unchanged on both sides; the fake's pull request #1 has `head` the bare branch, `base`
  `main`, the body `pullRequestBody` wrote, and `draft: false`.
- *pushes a local branch a stage-5 run cut, and opens its pull request* — the local branch cut
  first by `openLocalForge`; `recognise` answers `undefined`; `submit` answers `created`,
  `pushed: true`, and the local ref did not move.
- *opens the pull request of a branch an earlier run pushed, and writes nothing else* — the
  branch pushed, the local branch deleted (so the commit is judged by `api.commit` and
  `treeFor`): `recognise` answers `pushed-without-pull-request`; `submit` answers `created`,
  `pushed: false`; no local ref was created and the bare ref did not move.
- *names the pull request already open, and writes nothing* — `already-submitted`,
  `pullRequest.state: 'open'`, nothing written.
- *names the pull request open on an older base* — submit, then advance `main` on both sides by
  one unrelated commit: `already-submitted` with `olderBase` the first `main`.
- *opens the pull request of a branch pushed on an older base* — the same, but the pull request
  never opened (the fake's `POST` faulted once): `pushed-without-pull-request`, then `created`
  with `olderBase`. (This plan's reading of § 14's second row: "ours" there includes an older
  base, because it is the row that completes a submission stopped at step 12, and the base may
  have moved before the next run.)
- *refuses a local branch on an older base that GitHub never received* — the fifth row's
  sentence, `git branch -D` named, nothing written.
- *refuses a closed pull request, never reopening it* — closed unmerged, the branch present,
  then deleted: `closed`, `merged: false`, the date; nothing written.
- *refuses a merged pull request whose change the base no longer carries* — `closed`, `merged:
  true`.
- *refuses an open pull request into another base, naming it* — the fake holds one into
  `release`.
- *refuses a branch on GitHub that is not ours, whatever it holds* — four strangers' branches
  in the bare repository: on another parent, with one more file, with our bytes as
  executables, under another message: `refused`, "exists on github.com/acme/iac and carries a
  different change", nothing written.
- *refuses a local branch that is not ours before reading anything on GitHub* — stage 5's
  refusal; the fake recorded no call.

The moment of acting:

- *re-checks the rules at the moment of acting: a ruleset dropped after the confirmation leaves
  nothing on either side* — `recognise`, then the ruleset removed from the fake's state, then
  `submit`: `refused` without `kept`, nothing written.
- *re-checks the base: main moved on GitHub after the confirmation* — a commit pushed to the
  bare `main` between the two: `refused`, nothing written.
- *re-checks the clone's configuration at the moment of acting* — `credential.helper` set in
  `.git/config` between the two: `refused`, the key and `local` named, the canary value nowhere
  in the reason, nothing written.
- *pushes to the URL the remote printed, never to the remote's name* — `remote.origin.pushurl`
  unset, `remote.origin.push` set to `refs/heads/*:refs/heads/elsewhere/*` (read, never
  refused: it is not a key of § 7's list, and a URL push never consults it): the branch lands at
  its own name.

Races and failures:

- *never moves a branch a stranger pushed between the re-check and the push* — a `push` wrapper
  that first creates the branch in the bare repository with another commit: `refused`, `kept`,
  "carries a different change"; the stranger's ref unchanged; no pull request.
- *takes as its own a push that landed and whose answer was lost* — a wrapper that pushes, then
  throws: `created`, `pushed: false`, one pull request.
- *reads the branch back before opening anything* — the fake's `ref` faulted 404 twice: the
  pull request opened, `wait` called with 500 then 1500. Faulted three times: `refused`, `kept`,
  the § 4 sentence; no pull request; the local branch and the bare ref in place.
- *opens nothing when the push went elsewhere* — `GIT_SSH_COMMAND` removed from the fixture's
  environment and the temporary global configuration's `core.sshCommand` set to a fake ssh on a
  **second** bare repository: the push succeeds, the read-back finds nothing, `refused`, `kept`;
  no pull request (§ 7: "a global rewrite that sends github.com somewhere else is caught after
  the fact by step 11").
- *opens nothing when the rules stop holding during the push* — a wrapper that drops the
  ruleset, then pushes: `pushed-without-pull-request`, the rules named; the branch in the bare
  repository; no pull request; `preflight` over the same fake then answers `holds: false`.
- *says so when GitHub refuses to open the pull request, and opens it on the next run* — the
  `POST` faulted 502: `pushed-without-pull-request`, reason "the pull request was not opened:
  GitHub answered 502 through gh. Run the same command again to open it."; a new forge on the
  same clone: `recognise` answers `pushed-without-pull-request`, `submit` answers `created`,
  `pushed: false`.
- *answers a 422 by listing again* — the fake opens a pull request from our branch on the
  `POST` and answers 422: `created`, `state: 'open'`, one pull request.
- *does not claim a pull request whose answer was lost, nor deny one* — the `POST` faulted
  `lost` after the fake created it: `created` (found by the second listing); faulted `lost`
  before: `pushed-without-pull-request` with the "did not say" sentence.
- *classifies a failed push, and prints none of git's words* — a table over
  `classifyPushFailure` (one `GitError` per row above, a canary line in each stderr); and end to
  end, `fakeSsh(dir, bare, 'publickey')` and `fakeSsh(dir, bare, 'host-key')`: `refused`,
  `kept`, the class's sentence, the canary in no reason.
- *stops at 180 s* — `now` advanced past the bound before the push: `refused`, `kept`, no push;
  between the push and the `POST`: `pushed-without-pull-request`, the bound named.
- *stays within 48 gh calls on its longest path* — ten supplying rulesets, the branch on
  GitHub only on an older base, the read-back faulted 404 twice and the `POST` 422: every call
  counted, `api.calls()` at most 48, and `fake.sent` holds exactly one `POST`; then one more
  read through the same `api` is refused by the budget (6.1.2's `GitHubAnswerError`) and the
  fake records no forty-ninth call.

Why they fail: `src/forge/github/forge.ts` and `push.ts` do not exist; `github-fixture.ts`
does not exist.

- [ ] **Step 6: Write the failing tests — the identity that opened it cannot merge it (§ 10)**

`tests/unit/merge-refused.test.ts`, directly against the fake's model, never through the
launcher (which refuses every door before a process starts, 6.1.1). The doors are `DOORS`
from `tests/support/fake-gh.ts`, tried as vectors: this file names none, as the architecture
rule *in tests/, only tests/live/ and tests/support/fake-gh.ts name a door* requires.

- *refuses every door to the identity that opened the pull request, and leaves it open and
  main where it was* — the forge opens pull request #1 as `ada`; each entry of `DOORS` run
  through `gh.process` as `ada`: each a failure status or a non-zero exit, the pull request
  still open, the bare `main` unchanged after each.
- *refuses the author's merge after a push on top of an approved head, and lets it through once
  someone else approves the new head* — `gh.approve(1, 'grace')`; `gh.pushAs({ type: 'User',
  login: 'ada' }, 'refs/heads/<branch>', <a commit on top of the head>)`; `MERGE_DOOR` as `ada`:
  405; `gh.approve(1, 'grace')` again; `MERGE_DOOR` as `ada`: 200, and the bare `main` is the
  merge. The limit of § 5 pinned, not hidden.
- *lets the author merge unreviewed wherever the preflight refuses, and the preflight refuses
  each* — four models: no ruleset; the push rule unset (`require_last_push_approval` and
  `dismiss_stale_reviews_on_push` both false); `ada` in the bypass list; classic protection
  only. In each, `MERGE_DOOR` as `ada` on a pull request the test opens through the fake
  succeeds with no review, and `preflight(api, road, base, identity)` answers `holds: false`
  with the matching `missing`, before the forge is asked to write anything.
- *refuses a deploy key it can see in the bypass list* — a `DeployKey` bypass actor visible to
  `ada`: `gh.pushAs({ type: 'DeployKey', id: 7 }, 'refs/heads/main', <the head>)` answers 200
  (a fast-forward of `main` nobody reviewed), and `preflight` answers `missing: ['deploy-key']`;
  with `bypass_actors` hidden from `ada`, `preflight` holds and its `reported.bypassActors` is
  `'unreadable'`, which `idpa protection` states (6.1.3).

Why they fail: the fake answers no pull request route and models no review, merge or push
yet; `MERGE_DOOR`, `approve` and `pushAs` do not exist.

- [ ] **Step 7: Write the failing tests — a hostile clone (§ 7)**

`tests/unit/hostile-clone.test.ts`, one `it.each` per key, the value always the canary
`hostile-value-0123`:

- *refuses <key> set in the clone's own configuration, naming it and never its value* — for one
  key of each section of `REFUSED_SECTIONS` (`url.x.insteadOf`, `credential.helper`,
  `http.proxy`, `protocol.allow`, `ssh.variant`, `gpg.program`, `push.pushOption`), each of
  `REFUSED_KEYS`, and `remote.origin.vcs`, `.receivepack`, `.uploadpack`, `.proxy`,
  `.proxyAuthMethod`: set with `git config --local`, `openGitHub` throws `ForgeInputError`
  naming the key and `local`, the canary in no message; nothing pushed.
- *refuses the same key hidden behind include.path* — the key in a file the clone's
  configuration includes: refused, scope `local`.
- *never prints a credential a key's subsection holds* — `url.https://x-access-token:hostile-value-0123@github.com/.insteadOf`
  and `http.https://example.com/?access_token=hostile-value-0123.extraHeader`, each set locally:
  `ForgeInputError`, its message naming `<a URL this build does not print>` and `git config
  --local --edit`, the canary in no message.
- *refuses a key set in the clone after the confirmation* — `submit` answers `refused`, nothing
  written on either side.
- *leaves the six local keys a person keeps* — each of `KEPT_LOCAL_KEYS` set locally: the
  submission is `created`.
- *honours the person's global configuration where the clone's is refused* — each key above set
  in the fixture's temporary global configuration with a value under which an ssh push still
  works (a credential helper that answers nothing, a proxy on the closed port, `gpg.program`
  false, …): `created`; and `core.sshCommand` set there, with `GIT_SSH_COMMAND` removed, is what
  carries the push to the bare repository.

Why they fail: `openGitHubForge` does not exist, so the last three cannot be run; the first
two already pass against 6.1.2's `readRoad` through `openGitHub`, and are here end to end
with a push that did not happen.

- [ ] **Step 8: Write the failing tests — the type has no method (§ 10)**

`tests/unit/forge-types.test.ts`, typechecked by `pnpm typecheck` (`tsconfig.json` includes
`tests/**/*.ts`):

```typescript
import { afterAll, describe, expect, it } from 'vitest'
import type { ForgeProvider } from '../../src/forge/provider.js'
import { removeClones } from '../support/forge-fixture.js'
import { githubClone, githubForge } from '../support/github-fixture.js'

declare const forge: ForgeProvider

// @ts-expect-error a forge has no merge: the merge is the act of authorisation (ADR-0006)
forge.merge
// @ts-expect-error a forge approves nothing
forge.approve
// @ts-expect-error a forge closes nothing
forge.close
// @ts-expect-error a forge deletes nothing, and moves no ref that exists (ADR-0010)
forge.delete
// @ts-expect-error a forge is never handed a branch name
forge.submit({ branch: 'main' }, { branch: 'main', commit: '0'.repeat(40) })

describe('ForgeProvider', () => {
  afterAll(removeClones)

  it('holds exactly six members on both forges, and nothing that merges, approves, closes or deletes', async () => {
    const { forge: github } = await githubForge(await githubClone())
    expect(Object.keys(github).sort()).toEqual(['base', 'diverges', 'name', 'recognise', 'repository', 'submit'])
    expect(github.name).toBe('github')
  })
})
```

(`githubClone` makes its clone and its bare repository under `scratch`, so stage 5's
`removeClones` removes both.)

Why it fails: `githubForge` does not exist. The `@ts-expect-error` lines already hold on
`2b2250e` for `merge`, `approve`, `close` and `delete`; they are written here so that a later
widening of `ForgeProvider` fails `pnpm typecheck`.

- [ ] **Step 9: Write the failing tests — two systems, every failure**

`tests/invariants/github-forge.test.ts`, in the manner of `tests/invariants/forge.test.ts`:

- *a submission failing at any git, push or gh call leaves a row of § 4's table, and the next
  run converges* — one counter across three wrappers (the `Git`, the `Push`, the `GhProcess`);
  a clean `recognise` then `submit` is counted first (and must make more than twenty calls, or
  the test proves nothing); then, for every call `k` and both sides (the call refused before it
  runs; the call run and its answer lost), a fresh `githubClone()` fails at `k`. After each:
  the local refs, the bare repository's refs and the fake's pull requests form one of four
  states — nothing; our local branch; our local branch and the same commit on GitHub; those and
  one pull request — and no other line of `observable(repo)` or `remoteRefs(bare)` moved; an
  outcome of `created` or `already-submitted` only in the last state, `refused` without `kept`
  only in the first; and the faulted run's calls hold at most one `POST` (a refused `POST`
  counts as sent). Then a new forge on the same clone and fake, with no fault, converges:
  one local branch, the same commit on GitHub, exactly one pull request, the files byte for byte
  the edits'.
- *a branch a stranger pushes at any moment is never moved, nor claimed* — before call `k`, the
  test's git creates the branch in the bare repository on the bare `main`: the outcome is
  `refused`, the stranger's ref is unchanged, no pull request exists, and a second run refuses
  again.

Each attempt's directories are removed as soon as it is judged, not at the end: this is some
two hundred clones and bare repositories. Timeout 300 s. Run it targeted, after `df -h
"$TMPDIR"`.

Why they fail: `openGitHubForge` does not exist.

- [ ] **Step 10: Run the tests, see them fail for the reasons above**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/tree-for.test.ts tests/unit/pull-request-body.test.ts tests/unit/github-pulls.test.ts tests/unit/local-forge.test.ts tests/unit/clear.test.ts
pnpm vitest run tests/unit/github-forge.test.ts tests/unit/merge-refused.test.ts tests/unit/hostile-clone.test.ts tests/unit/forge-types.test.ts
```

Expected: FAIL, on missing modules and exports; `clear.test.ts` and `local-forge.test.ts` on
the new cases only.

- [ ] **Step 11: `objects.ts`, `tree.ts`, and the local forge's option**

`treeId(entries, format)`: the entries sorted as git sorts a tree (by name, a folder compared
as `name/`), each written `<mode> <name>\0<raw id>` with `040000` written `40000`, hashed with
the header `tree <length>\0`. `objectFormat(git)`: `rev-parse --show-object-format`, the shape
`openLocalForge` already runs. `treeFor(git, parent, edits, format)`: `rev-parse
<parent>^{tree}`, then `writeTree`'s recursion with `ls-tree -z <tree>` per level, the edited
entries replaced by `blobId(Buffer.from(edit.after, 'utf8'), format)` and the mode `writeTree`
gives, each level hashed with `treeId`, and the same two refusals.

`openLocalForge(repo, repository, git, options)`: `format` from `objectFormat(git)`;
`existing()` takes the option: a parent that is not `at.commit` is accepted only with
`acceptOlderBase` and only when `merge-base --is-ancestor <parent> <at.commit>` succeeds; the
touched paths, the bytes and modes (against `treeOf(git, parent)`), and the message are then
judged as they are today, and the answer carries `olderBase: parent`. `submit()` returns that
answer as it returns any `already-submitted`. Every other line is unchanged.

`clear.ts`: `recordedRequest(intent)` (internal) is `cut(intent, 500)`; `messageFor` writes
`  ${recordedRequest(plan.intent)}` where it wrote `  ${cut(plan.intent, 500)}`; `mint` sets
`request: recordedRequest(plan.intent)`.

- [ ] **Step 12: `pull-request.ts`**

```typescript
export const ENGINE_BLOCK_END = '<!-- idp-agent: end of the engine\'s block -->'

/** Three backticks, or one more than the longest run in the text: no line of it can close the fence. */
export const fenceFor = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

const ROAD = (road: PullRequestInput['road']): string => {
  switch (road) {
    case 'from':
      return 'from a plan file: four gates, the schema, the signature, the policies and the re-check, and no Reviewer'
    case 'intent':
      return 'drafted by a model: five gates, the schema, the signature, the policies, the re-check and the Reviewer last'
    case 'phrase':
      return 'drafted by a model from a phrase idpa took for a change: five gates, the Reviewer last'
    case 'init':
      return "written by idpa init in the service's own repository, from what a person typed"
    default: {
      const _exhaustive: never = road
      return _exhaustive
    }
  }
}
```

`pullRequestBody(input)`: `title` is the message's first line. The body is the message's
lines from its third up to the line `Requested, as recorded with the plan (no gate reads it):`
(kept), then a blank line, the fence, `input.request`, the fence, a blank line, `---`, and the
engine's block: `Made ${ROAD(input.road)}.`, `` The branch `${input.branch}` is named by a
digest of its files' paths and bytes: the same change always names the same branch, and any
other change another. ``, `Nothing is provisioned yet. The merge is what authorises it.`, then
`ENGINE_BLOCK_END`. The line that `messageFor` wrote with the request is dropped: it is the
same text, and outside a fence it would notify, link and render. A message without the
`Requested` line (not one `messageFor` wrote) throws.

`pullRequestUrl(repository, number)`: `Number.isSafeInteger(number) && number > 0`, else
throws; `https://github.com/${owner}/${name}/pull/${number}`, from the parsed owner and name
(held to their grammar by 6.1.2 already).

`src/core/README.md`: `core/github/pull-request.ts`, the text and the URL of a pull request.

- [ ] **Step 13: The three routes, and `readRules`**

`answers.ts`: `commitAnswer` (`sha`, `tree.sha`, `parents[].sha`, `message`), `pullsAnswer` (an
array of `number`, `state`, `merged_at`, `closed_at`, `base.ref`, `head.ref`), `pullAnswer`
(`number`, `state`, `base.ref`, `head.ref`): `z.object`, not `strictObject`, since GitHub adds
fields; only these are read. `api.ts`: one method per route, each through the budget, each
non-2xx a `GitHubAnswerError`; `openPullRequest` throws a programming error when the same
`api` already asked for one (a `boolean` it sets before `gh.openPullRequest` is called, so a
timed-out or lost `POST` counts), builds the JSON with exactly the six fields,
checks it against `GITHUB_LIMITS.bodyBytes` before `gh.openPullRequest` is called, and reads
the number from a 201; `calls()` returns the `GhClient`'s. `preflight.ts`: items 2 and 3 move
into `readRules(api, road, identity)`, which `preflight` calls; `tests/unit/protection.test.ts`
(6.1.3) passes unchanged, which is the proof nothing moved.

- [ ] **Step 14: `push.ts` and `forge.ts`**

`classifyPushFailure(error)`: `timedOut` is `network`; then the table above, in its order,
over `error.stderr`; `other` last. `forge.ts`: `openGitHubForge(input)` as **The forge, in the
order it acts** says, with `base` and `diverges` the local forge's, `name: 'github'` and
`repository` the local forge's. Two internal functions carry the order: `remoteOf(change,
base, localCommit)` (steps 2 and 3 of recognition, answering `absent`, `ours` with
`olderBase`, or `other`) and `decided(remote, pulls)` (the table). Switches with a `never`
default: over `PushFlag` (the push's answer), over `PushFailure` (the sentences), over the
remote's three states. The module's comment says what it is and is not: one ref and one pull
request are its only writes on GitHub, the two systems are atomic each and not together, and
every intermediate state is a row of § 4's table that the same command completes.

`src/forge/provider.ts`: the widened types; the comment at `:37-41` becomes

```typescript
 * No `merge`: the merge is the act of authorisation, and a tool that could
 * perform it would make that sentence a matter of not calling a method. There
 * is no method, and the interface holds no credential: the person's git pushes
 * and the person's gh reads and opens. `tests/unit/merge-refused.test.ts` tries
 * every door as the identity that opened the pull request, against the fake gh,
 * and requires each to FAIL; the owner's live test does the same on GitHub.
```

`src/cli/commands/submit.ts`, `outcomeOf`: two cases before the `default`:

```typescript
    case 'pushed-without-pull-request':
    case 'closed':
      // Only the GitHub forge answers these, and no road opens it before 6.2.2.
      throw new Error(`the local forge never answers ${submitted.outcome}`)
```

- [ ] **Step 15: The fake's pull requests, reviews, merges and doors; the fixture**

`tools/fake-gh.ts`: pull requests (a `POST` creates the next number, author the logged-in
account, head and base read from the bare repository, 422 when an open one exists from that
head into that base; the list filtered by `head=` and `state=all`), reviews (`approve`, at the
head's commit when it is made), a merge judged by the model (405 unless an account other than
the author and the last pusher approved the current head, or the merger's
`current_user_can_bypass` is not `never`; a merge writes the bare `main` with test-side git),
`pushAs` judged the same way for `main` and allowed for any other branch, and an answer for
every entry of `DOORS`: the status § 10 names where it names one (405 for a merge), else 409
"Repository rule violations found" for a write the rules forbid, else 404; each is the fake's
guess until 6.4.1's recorded answers hold it (`tests/contract/github-answers.test.ts`).
`fault(...)` answers the next `times` calls of a route with a status, or `lost` (the call is
made, the answer is an exit 1 with nothing on stdout). The state stays JSON, so the executable
entry and `FAKE_GH_STATE` keep working; `tests/unit/fake-gh.test.ts` gains a case per route and
per door.

`tests/support/fake-gh.ts`: `MERGE_DOOR`, found in `DOORS` by its vector's method and path, and
`approve`, `pushAs`, `fault` passed through.

`tests/support/github-fixture.ts`: `githubClone(options)` makes the clone with `clone()`, a
bare repository beside it holding `main` (a test-side `git push` by path), `remote.origin.url`
`git@github.com:acme/iac.git` and `branch.main.remote`/`.merge`; the environment is
`process.env` with a scratch `HOME`, `GIT_SSH_COMMAND` the fake ssh, `GIT_SSH_VARIANT=simple`
(one of the four variables the push keeps, § 5, so git never probes the script with `-G`), and
the check of 6.1.1's floor leg 6 made before it returns (`git remote get-url --push origin` in
the launcher's environment answers `git@github.com:acme/iac.git`, or the helper throws naming
the system file); the
fake is `fakeGitHub({ bare, ...options.model })`, logged in as `ada`. `fakeSsh(dir, bare,
refuse)` writes a `sh` script that runs `git receive-pack` (or `upload-pack`) on `bare`
whatever host it is handed, or prints ssh's own refusal and exits 255. If 6.1.1's
`process-git.test.ts` already wrote such a script for `pushIn`, this function is that one,
moved here: one fake ssh in `tests/support/`. `githubForge(clone, options)` opens what 6.2.2's
`openSubmissionForge` will: `openGitHub` (6.1.3) for the road and identity, `openLocalForge`
with `acceptOlderBase: true`, then `openGitHubForge` with `route: 'from'`.

- [ ] **Step 16: Run the tests**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/tree-for.test.ts tests/unit/pull-request-body.test.ts tests/unit/github-pulls.test.ts tests/unit/local-forge.test.ts tests/unit/clear.test.ts tests/unit/fake-gh.test.ts tests/unit/protection.test.ts
pnpm vitest run tests/unit/github-forge.test.ts tests/unit/merge-refused.test.ts tests/unit/hostile-clone.test.ts tests/unit/forge-types.test.ts
pnpm vitest run tests/invariants/forge.test.ts tests/invariants/github-forge.test.ts
pnpm vitest run tests/architecture --reporter=verbose
pnpm typecheck
```

Expected: PASS. The architecture block holds **29** rules, as after 6.1.2: this task adds
none. `forge/github/forge.ts` imports `core/`, `process/` and `forge/` only; the gh launcher is
loaded by `forge/github/` alone; `tools/` is read by no rule.

- [ ] **Step 17: The documents this task makes true**

- `src/forge/README.md`: `provider.ts`'s line names the widened `Submitted` and the absent
  methods; a line for `local/tree.ts`; `github/forge.ts` in the folder's list.
- `src/forge/github/README.md`: `forge.ts` and `push.ts`, what they may not do (no merge, no
  approval, no deletion, no push but the create-only one, never a ref name from a caller), and
  the tests that hold it.
- `AGENTS.md`: the `forge/` row of the layering table names `github/forge.ts`, the GitHub
  forge, which `cli/` does not reach yet; the test count, re-measured with `pnpm test` (the
  full suite, with 2 GiB free), and the README's badge with it.
- `CHANGELOG.md`, under `### Added`:

  > - The GitHub forge, not yet reachable from the command line: through the person's own gh it
  >   recognises a submission already on GitHub (its branch, on this base or an older one, and
  >   its pull request, open, closed or merged) before anyone is asked; at the moment of acting
  >   it re-reads the clone's configuration, the base's rules and the base's tip, cuts the local
  >   branch, pushes that very commit create-only with the person's own git, reads it back, reads
  >   the rules once more and opens one pull request whose body the engine writes, the request
  >   in a fence. Offline tests against a fake gh and a bare repository try every door as the
  >   pull request's author, refuse a hostile clone's configuration, and fail every git and gh
  >   call of a submission in turn ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

- `docs/roadmap.md`: the stage 6 queue item says 6.2.1 is on `main` (#PRNUM).

- [ ] **Step 18: Checks, then the pull request** *(after the owner's go-ahead)*

```bash
df -h "$TMPDIR"
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

Every check green on this branch alone. No tape's request bytes change
(`tests/scenarios/prompt-digests.test.ts` passes unchanged), `tests/golden/` and
`fixtures/si-demo/` are untouched, and nothing reaches the network, a real gh or a real ssh
(`tests/setup/forge.ts`).

```bash
git add src/forge/local/objects.ts src/forge/local/tree.ts src/forge/local/forge.ts src/forge/provider.ts src/forge/github/api.ts src/forge/github/preflight.ts src/forge/github/push.ts src/forge/github/forge.ts src/forge/README.md src/forge/github/README.md
git add src/core/plan/clear.ts src/core/github/answers.ts src/core/github/pull-request.ts src/core/README.md src/cli/commands/submit.ts
git add tools/fake-gh.ts tests/support/fake-gh.ts tests/support/github-fixture.ts
git add tests/unit/tree-for.test.ts tests/unit/pull-request-body.test.ts tests/unit/github-pulls.test.ts tests/unit/github-forge.test.ts tests/unit/merge-refused.test.ts tests/unit/hostile-clone.test.ts tests/unit/forge-types.test.ts tests/unit/local-forge.test.ts tests/unit/clear.test.ts tests/unit/fake-gh.test.ts tests/invariants/github-forge.test.ts
git add AGENTS.md README.md CHANGELOG.md docs/roadmap.md
git commit -m "feat(forge): the GitHub forge — recognise, re-check, push create-only, read back, open one pull request"
```

**PR boundary.** Base `feat/s6-protection`. What a person sees: nothing on the command line;
`pnpm demo:github` prints what 6.1.3 made it print. The `CHANGELOG.md` line above ends with this
pull request's number.

**What the owner can run** (from the pull request's worktree, after `pnpm install`). Keyless,
offline, no gh: the fake and a bare repository on disk.

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/tree-for.test.ts tests/unit/pull-request-body.test.ts tests/unit/github-forge.test.ts
pnpm vitest run tests/unit/merge-refused.test.ts tests/unit/hostile-clone.test.ts tests/unit/forge-types.test.ts
pnpm vitest run tests/invariants/github-forge.test.ts
pnpm typecheck
pnpm vitest run tests/architecture --reporter=verbose
```

Attendu :
- the first line shows at least 2 GiB available;
- each `vitest` line ends on every test passed and none failed, the counts written into the pull
  request's description once measured; `merge-refused.test.ts` lists *refuses every door to
  the identity that opened the pull request, and leaves it open and main where it was* and
  *refuses the author's merge after a push on top of an approved head, and lets it through once
  someone else approves the new head*;
- the invariant file takes up to five minutes and leaves no directory behind
  (`ls "$TMPDIR" | grep -c idp-forge` is what it was before it ran);
- `pnpm typecheck` exits 0, which is what proves the `@ts-expect-error` lines of
  `forge-types.test.ts`;
- the architecture block lists 29 rules, all passing.

---

### Task 6.2.2: `plan --from … --submit` to GitHub

**Goal.** In a clone whose checked-out branch tracks a branch on github.com, with gh logged in
as a person, `plan --from <plan.json> --submit` takes § 13's road: gh's identity before
anything is read, the rules and the base's tip before anything is written (exit 1 when they do
not hold, nothing written), the diff, one question naming the push and the pull request, then
the GitHub forge of 6.2.1; it ends on the pull request's engine-built URL and the checks merging
waits for, and a second run names the same pull request and writes nothing. `--local` asks for
stage 5's branch on purpose. Without a usable gh, exit 2 and `--local` named. `plan "<intent>"
--submit` and `init --submit` toward GitHub are refused before any model and before gh, until
6.3.1 and 6.3.2. This closes slice 6.2.

**Branch** `feat/s6-plan-from-github`, cut from `feat/s6-github-forge`. Global Constraints 1,
3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15.

**Read on `2b2250e`, and what this task changes there.**

- `src/cli/commands/submit.ts:72-79`, `openForSubmission`, calls `openLocalForge(root,
  repository)`, whose `git` is `gitIn(repo)` with no `env` (`forge.ts:76`): drift
  row 5. From here the environment comes from `deps.env ?? process.env` and reaches every
  launcher of a submission, through `openSubmissionForge`; `cli/` loads no launcher.
- `submit.ts:199-200`, the early return on anything `recognise` answered. A
  `pushed-without-pull-request` recognised is not the end of the run: it is asked (the "pushed by
  an earlier run" question) and submitted (§ 14, row 2).
- `submit.ts:146-155`, `SubmissionReport`, pinned by `plan-command.test.ts`'s *pins every shape
  --json gives the submission key (D11)* (`:1607-1640`) and *reports the submission in --json,
  and never prompts there* (`:1341-1361`).
- `src/cli/render/footer.ts:11`, `NO_FORGE`, and `:67-76`, the `submitted` case; the sentence is
  pinned at `plan-command.test.ts:1094` and quoted at `README.md:128`.
- `src/cli/commands/plan.ts:1074-1101`, `runPlan`: the forge opened before the plan file is
  read, then `refuseDivergence` after the contents are read. `refuseUnprotected` goes right after
  `refuseDivergence`, before the preview. `:1241-1257` and `:1643-1664`: `--json` reads
  `submission.outcome !== 'refused'` as its `found`; both read the `result.found` `submit()`
  returns instead, because `pushed-without-pull-request` and `closed` are negative answers too.
- `src/cli/index.ts:1286-1310` (`--from`), `:1357-1368` (the intent road's forge, opened
  before the model), `:1173-1185` (`init`'s), and `runInitRepo`'s own call at
  `src/cli/commands/init.ts:819`: each passes its road (`route`), `local`, `env`, `gh` and a
  `notice`. HELP is `index.ts:202-275` and `usageOf` `:598` (not `src/cli/usage.ts`, which is the
  model-cost line).
- `index.ts:1913-1942`, `confirmOnTerminal`: the local road's question stays byte for byte; the
  GitHub road's is § 3's.
- `index.ts:2029-2048`, `failed()`: `ForgeInputError` is exit 2, printed through `inertLine`;
  the gh refusals of 6.1.2 and the interim refusals below are `ForgeInputError`s and need no
  new branch there.
- `plan --from` writes no trace (drift row 7). `CommandResult.attributes` is set on every
  result `submit()` returns; `agentBacked` merges it into `builder.finish`, which a
  `plan "<intent>" --submit --local` run proves here (the intent road reaches `submit()` on a
  local road already); the GitHub attributes reach a trace from 6.3.1.

**Files:**
- Create: `src/forge/open.ts`, `tests/unit/submit-github.test.ts`
- Modify: `src/cli/commands/submit.ts`, `src/cli/commands/result.ts`,
  `src/cli/render/footer.ts`, `src/cli/commands/plan.ts`, `src/cli/commands/init.ts`,
  `src/cli/index.ts`, `src/cli/README.md`, `src/forge/README.md`
- Modify: `scripts/demo-github.mjs`, `scripts/smoke.mjs`
- Modify (tests): `tests/unit/plan-command.test.ts`, `tests/unit/cli-args.test.ts`,
  `tests/unit/init-command.test.ts` (the interim refusal, the local road's line),
  `tests/unit/trace-wiring.test.ts` (the forge's attributes on the root),
  `tests/contract/key-reach.test.ts` (the `--from` leg)
- Modify: `docs/design.md` (§4.2's first two bullets, the invariant, first), `SECURITY.md`,
  `README.md`, `AGENTS.md`, `docs/submitting.md`, `CHANGELOG.md`, `docs/roadmap.md`,
  `docs/reviews/2026-09-23-deep-review.md` (Status, cli-ux-10)

**Interfaces.** Consumes 6.2.1's forge and 6.1.3's `openGitHub`, `preflight`,
`renderUnprotected`, `PROTECTION_SETTINGS`. Produces the shared names, with these shapes:

```typescript
// src/forge/open.ts — the shared names, with (+) `route`
export interface OpenedForge { readonly forge: ForgeProvider; readonly road: Road; readonly github?: { readonly identity: GhIdentity; readonly api: GitHubApi } }
export async function openSubmissionForge(input: {
  readonly repo: string
  readonly repository: Repository
  readonly env: NodeJS.ProcessEnv
  readonly gh?: GhProcess          // `import type`: forge/open.ts loads no launcher
  readonly local: boolean
  readonly route: PullRequestInput['road']
}): Promise<OpenedForge>

// src/cli/commands/submit.ts
export interface SubmitOptions {
  readonly confirm?: Confirm
  readonly open?: (root: string, repository: Repository) => Promise<OpenedForge>   // was Promise<ForgeProvider>
  readonly local?: boolean
  readonly env?: NodeJS.ProcessEnv
  readonly gh?: GhProcess
  readonly notice?: (line: string) => void    // (+) where the "submitting to" line goes
}
export async function openForSubmission(root: string, repository: Repository, options: SubmitOptions & { readonly route: PullRequestInput['road'] }): Promise<Opened>
export interface Opened { readonly root: string; readonly forge: ForgeProvider; readonly base: Base; readonly road: Road; readonly github?: { readonly identity: GhIdentity; readonly api: GitHubApi } }
export const reopening: (opened: OpenedForge, root: string, repository: Repository) => (asked: string, which: Repository) => Promise<OpenedForge>
export async function refuseUnprotected(opened: Opened, options: { readonly json?: boolean }): Promise<CommandResult | undefined>
export interface SubmissionSummary { /* … as today */ readonly github?: { readonly host: 'github.com'; readonly repository: string; readonly base: string; readonly pushedAlready: boolean } }
export type SubmissionReport =
  | { readonly outcome: 'created' | 'already-submitted'; readonly branch: string; readonly commit: string; readonly base: Base; readonly pushed: boolean; readonly pullRequest?: PullRequest; readonly olderBase?: string }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'declined'; readonly branch: string }
  | { readonly outcome: 'refused'; readonly reasons: readonly string[]; readonly kept?: string }
  | { readonly outcome: 'pushed-without-pull-request'; readonly branch: string; readonly commit: string; readonly reason: string }
  | { readonly outcome: 'closed'; readonly branch: string; readonly number: number; readonly merged: boolean; readonly at: string }
export function forgeAttributes(report: SubmissionReport, road: Road, calls: number): Attributes

// src/cli/commands/result.ts
export interface CommandResult { text: string; found: boolean; unsupported?: boolean; attributes?: Attributes }

// src/cli/render/footer.ts
export type PreviewStatus =
  | { readonly kind: 'preview' }
  | { readonly kind: 'pending'; readonly branch: string }
  | { readonly kind: 'declined' }
  | { readonly kind: 'refused'; readonly reasons: readonly string[]; readonly kept?: string }
  | { readonly kind: 'submitted'; readonly again: boolean; readonly branch: string; readonly base: Base; readonly road: Road; readonly pullRequest?: PullRequest; readonly olderBase?: string; readonly statusChecks?: readonly string[] }
  | { readonly kind: 'pushed-without-pull-request'; readonly branch: string; readonly repository: string; readonly reason: string }
  | { readonly kind: 'closed'; readonly branch: string; readonly number: number; readonly merged: boolean; readonly at: string }
  | { readonly kind: 'applied-by-hand'; readonly apply: string }
export function localRoadLine(road: LocalRoad): string
export function pullRequestLines(pullRequest: PullRequest, verdict: Pick<ProtectionVerdict['reported'], 'statusChecks'>): string[]

// src/cli/index.ts
// Command: `plan` and `init` gain `local?: true`
```

`pushed` in the report is **whether this run pushed the branch**: `false` on a local road, on
a pull request opened for a branch an earlier run pushed, and on every `already-submitted`.
`PullRequest.repository` is `acme/iac` (the host is its own field);
`PreviewStatus.pushed-without-pull-request.repository` is the printed `github.com/acme/iac`.

**The lines**, exactly (those of *Exact lines*, and this task's where it has none):

| When | stdout, after the diff (or alone after a prompt) |
|---|---|
| no upstream | first line as stage 5; `main tracks no remote: nothing pushed`; `CLOSING` |
| another host | first line as stage 5; `the remote is on gitlab.example.com, where this build opens no pull request: nothing pushed`; `CLOSING` |
| `--local` | first line as stage 5; `--local: nothing pushed by this run`; `CLOSING` |
| opened | `1 file · submitted as <b> on top of main@abc1234 · main untouched`; `Pull request #3 opened on github.com/acme/iac: https://github.com/acme/iac/pull/3`; the merging line; `CLOSING` |
| opened, a pull request already there after a 422 | the same, its second line `Pull request #3 is open on github.com/acme/iac: …` |
| opened, on an older base (+) | `1 file · submitted as <b> on top of main@abc1234, an older main (now def5678; GitHub shows whether it still merges cleanly) · main untouched`; then as opened |
| again | `1 file · already submitted as <b> · pull request #3 is open · nothing written`; `CLOSING` |
| again, older base | `1 file · already submitted as <b> · pull request #3 is open, on main@abc1234; main is now def5678, and GitHub shows whether it still merges cleanly · nothing written`; `CLOSING` |
| step 11 or 12 stopped | `1 file · <b> is on github.com/acme/iac, and <reason>` (the reason 6.2.1 wrote, "the pull request was not opened: GitHub answered 502 through gh. Run the same command again to open it."); `CLOSING`; exit 1 |
| closed (+) | `1 file · not submitted — <b> was submitted as pull request #3 and closed on 2026-10-02 · nothing written`; `A closed request is not reopened by this tool: reopen it on GitHub, or change the request.`; `CLOSING`; exit 1 |
| merged since reverted (+) | `1 file · not submitted — <b> was merged as pull request #3, and main no longer carries it · nothing written`; `A reverted change is a reviewer's decision, which this tool does not re-request.`; `CLOSING`; exit 1 |
| refused after step 9 (+) | stage 5's refused lines, with `<b> was cut in this clone, and no pull request was opened.` in place of `Nothing was written.`; exit 1 |

The merging line: `Merging it waits for one approval of its latest commit from someone other
than you. No status check is required, so a system downstream could not refuse it
(ADR-0012).`, or, with contexts, `Merging it waits for one approval of its latest commit from
someone other than you, and for the status checks ci/validate, downstream/tufin.` Every value
that came from GitHub or the repository (a branch, a base, a host, a context) passes
`inertLine`. On stderr, before the diff: `submitting to github.com/acme/iac, into main (origin,
main's upstream), as ada (gh)`: no role, since `readIdentity` answers `role: undefined` (6.1.2) and
the preflight, which reads `permissions`, runs after this line.

The `--local` line says what this run did and nothing about GitHub (the owner's answer of
2026-09-30): `--local` starts no gh and reads nothing there, so it cannot know whether an earlier
run without it pushed the same branch, and `nothing pushed by this run` is true either way.

- [ ] **Step 1: Write the failing tests — `plan --from --submit` to the fake, through `main`**

`tests/unit/submit-github.test.ts`. Each test runs `main([...], { out, err, env: clone.env, gh:
clone.gh.process, ask, confirm? })` over `githubClone()` and a plan file written beside the
clone from stage 5's `INTENT` and `OPERATIONS`, answered by `answering('read')`.

- *pushes with the person's git and opens one pull request, whose URL the engine builds* — exit
  0; stderr holds the "submitting to" line with `as ada (gh)`; stdout ends on the opened lines
  of the table, `Pull request #1 opened on github.com/acme/iac:
  https://github.com/acme/iac/pull/1`; the bare repository's branch is the local branch's
  commit; `main` unchanged on both sides; the fake's pull request #1 exists, open, into `main`.
- *names the same pull request on a second run, asks nothing and writes nothing* — a `confirm`
  that throws if called; exit 0; the "again" line; `observable`, `remoteRefs` and the fake's
  pull requests unchanged.
- *asks, at a terminal, whether to push with the person's git and open the pull request with
  their gh* — an injected `confirm` receives `github: { host: 'github.com', repository:
  'acme/iac', base: 'main', pushedAlready: false }`; declining is exit 0, `not submitted ·
  nothing written`, and nothing on either side.
- *asks only to open the pull request when an earlier run pushed the branch* — the `POST`
  faulted 502 on the first run (exit 1, the step-12 line, the branch in the bare repository);
  the second run's `confirm` receives `pushedAlready: true`, and exit 0 opens #1, with `pushed:
  false` in `--json`.
- *refuses an unprotected base before anything is written, and prints the ruleset to add* —
  the ruleset removed: exit 1; stdout is `renderUnprotected`'s text (the lines of *Exact lines*,
  `protectionText()` among them); no diff; nothing on either side; with `--json`, `{
  submission: { outcome: 'refused', reasons } }` alone.
- *refuses a clone that is not level with GitHub, naming both commits* — a commit pushed to
  the bare `main`: exit 1, the "not level" line of *Exact lines*, nothing written.
- *refuses without a usable gh: exit 2, nothing written, --local named* — five `it.each` rows:
  gh missing (a `GhProcess` answering `ENOENT`), logged out (`gh.logout()`), a login GitHub
  refuses (the fake's `user` faulted 401), a gh older than `GH_MINIMUM_VERSION`, a `Bot`: each
  the sentence of *Exact lines* on stderr, nothing on stdout, `observable(repo)` and the bare repository
  unchanged.
- *refuses a key of the clone's own configuration before gh and before any write, naming it and
  never its value* — two `it.each` rows, each set with `git config --local` in the clone: a
  `credential.helper` of `store --file=/tmp/canary-credential-store`, and a
  `url.git@evil.example:.insteadOf` of `git@github.com:`, whose subsection is not a URL
  6.1.2's rule prints, so the key reads `url.<a URL this build does not print>.insteadof`.
  Each: exit 2; stderr holds `configRefusal`'s sentence of *Exact lines* for its key and
  `(local)`; neither stdout nor stderr holds `canary-credential-store`, `git@github.com:` or
  `evil.example`; stdout is empty; a `GhProcess` that
  throws if called was never called; `observable(repo)` and `remoteRefs(bare)` unchanged. This
  is the first pull request in which `main` reaches `openGitHub`, so it is the one that proves
  the path `openSubmissionForge` → `ForgeInputError` → `failed()` → `inertLine` → exit 2 end to
  end, rather than leaving it to 6.3.1 and 6.3.2.
- *takes stage 5's road where no pull request can be opened, and never starts gh* — three rows:
  no upstream (the remote's configuration removed), another host
  (`git@gitlab.example.com:acme/iac.git`), `--local`: exit 0, the local road's line, the bare
  repository unchanged, and a `GhProcess` that throws if called was never called.
- *re-checks the rules after the confirmation, and writes nothing when they are gone* — a
  `confirm` that removes the ruleset from the fake, then answers yes: exit 1, the refused
  lines with `Nothing was written.`, nothing on either side.
- *says the local branch stays when the push fails* — `fakeSsh(dir, bare, 'publickey')` as
  `GIT_SSH_COMMAND`: exit 1, the `authentication` sentence, `<b> was cut in this clone, and no
  pull request was opened.`, the canary line of the fake ssh's stderr nowhere in stdout or
  stderr.
- *refuses a closed pull request, and never reopens it* — `closed` lines, exit 1, the pull
  request still closed.
- *tries every door after a submission through main, and each is refused* — after the first
  test's run, each entry of `DOORS` through `clone.gh.process` as `ada`: refused, #1 still open,
  the bare `main` unchanged (§ 10: the same proof as `merge-refused.test.ts`, end to end).
- *refuses plan "<intent>" --submit and init --submit toward GitHub before any model and before
  gh, naming --local* — no `client` and no provider variable, so a model would be refused as
  "no model configured": each answers exit 2 with its interim sentence instead, the `GhProcess`
  was never called, and nothing was written. (`plan "<intent>" --submit --local`, which takes
  the local road, is `trace-wiring.test.ts`'s case in Step 2.)

Why they fail: `main` hands `openForSubmission` no `env` and no `gh`, and `openForSubmission`
opens the local forge alone: every run takes stage 5's road and ends on `NO_FORGE`; the
unprotected and not-level runs submit; the "no gh" runs and the configuration-key runs exit 0
on the local road; `--local` is an unknown option (exit 2 for the wrong reason, which the
assertion on stderr's text catches).

- [ ] **Step 2: Write the failing tests — the report, the closing lines, the question, the
  attributes**

In `tests/unit/plan-command.test.ts`:

- `:1094`: the line becomes `expect(out).toContain('main tracks no remote: nothing pushed')`,
  and the test also asserts `out` holds no `No merge request is opened`.
- *pins every shape --json gives the submission key (D11)*: the created keys become `['base',
  'branch', 'commit', 'outcome', 'pushed']`, `pushed` `false`; the refused shape unchanged.
- *reports the submission in --json, and never prompts there*: `pushed: false` added.
- In the `confirmOnTerminal` block: *asks the local road's question byte for byte as before* (the
  prompt text read from `output`: `Submit this for review as … in /work/iac? Nothing is
  provisioned until someone else merges it. [y/N] `), *asks § 3's question on the GitHub road*
  (`SUMMARY` with `github`: `Push idp-agent/orders-db-prod-3f9c2a1b to github.com/acme/iac with
  your git, and open a pull request into main with your gh? Nothing is provisioned until
  someone else approves it and it is merged. [y/N] `), and *asks only for the pull request when
  the branch was pushed* (`pushedAlready: true`, the second question of *Exact lines*).

In `tests/unit/submit-github.test.ts`, three more:

- *reports the pull request in --json* — created: keys `['base', 'branch', 'commit', 'outcome',
  'pullRequest', 'pushed']`, `pullRequest`'s keys `['base', 'host', 'number', 'repository',
  'state', 'url']`, `state: 'opened'`, `pushed: true`; again: `already-submitted`, `state:
  'open'`, `pushed: false`; the step-12 stop: `{ outcome: 'pushed-without-pull-request',
  branch, commit, reason }`, exit 1.
- *closes every road on its own line, and never on NO_FORGE* — `closingLines` over each status
  of the table above, one expectation each, `localRoadLine` over the three `why`, and a
  `submitted` status on a GitHub road without a pull request throws (a programming error, never
  a line).
- *names the road, the pull request and the gh calls, never the login* — `forgeAttributes` over
  a created report on a GitHub road: `idp.forge.kind` `github`, `.host` `github.com`,
  `.repository` `acme/iac`, `.base` `main`, `.branch`, `.pull_request` `1`, `.outcome`
  `created`, `.gh_calls` the count, `.pushed` `true`; `ada` in no key and no value; on a local
  road: `kind` `local`, `gh_calls` `0`, `pushed` `false`, no `host` unless `other-host`.

In `tests/unit/trace-wiring.test.ts`: *puts the forge's attributes on the root of a submitted
run* — `plan "<intent>" --submit --local` over a scripted client and a memory sink: the root's
attributes hold `idp.forge.kind: 'local'`, `idp.forge.outcome: 'created'`, `idp.forge.pushed:
false`, `idp.forge.gh_calls: 0`, beside what the root held before.

In `tests/unit/cli-args.test.ts`: *parses --local beside --submit on plan and init*, and
*refuses --local without --submit* (`{ name: 'error', message: '--local says where --submit cuts
its branch, and there is no --submit here: add --submit, or leave --local out' }`) on both
roads of `plan` and on `init`.

In `tests/unit/init-command.test.ts`: *refuses init --submit toward GitHub until its road lands,
before any model and before gh* and *cuts init's branch with --local, and says nothing was
pushed*.

Why they fail: the report has no `pushed`; `closingLines` prints `NO_FORGE`; `SubmissionSummary`
has no `github`; `forgeAttributes` does not exist; `--local` is not an option.

- [ ] **Step 3: Write the failing test — the key-reach leg for `--from`**

In `tests/contract/key-reach.test.ts`, under the `vi.mock` of `node:child_process` the file
already holds (it records the environment of every `execFile`, so of every git call, the push
included):

- *hands gh and the push nothing of idpa's, and passes the person's gh login unread, on plan
  --from --submit* — `main(['plan', '--from', plan, '--repo', clone.repo, '--submit', '--json'],
  { env, gh, ask })` (`ask` answering `read`: a `--json` run asks the level through an injected
  `ask`, as `plan-command.test.ts` does) where `env` is `clone.env` plus every provider's `KEY` variable, `IDP_BACKSTAGE_URL`
  and `IDP_BACKSTAGE_TOKEN` set to `TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` set to a third canary
  (`GH_CANARY`), and the inherited variables the launchers must drop, each planted with a value
  of its own: `GIT_DIR` (a directory that does not exist), `GIT_CONFIG_PARAMETERS`
  (`'core.hooksPath'='/nonexistent'`), `GIT_ASKPASS` (`/nonexistent/askpass`), `GH_HOST:
  'evil.example'`, `GH_REPO: 'evil/repo'`, `GH_DEBUG: 'api'`, `GODEBUG: 'http2debug=2'` and
  `GH_ENTERPRISE_TOKEN: 'enterprise-canary'`. `forge.ts` removes `GH_HOST` and `GH_REPO` from
  the process's environment, so without them planted here the gh assertions below would pass on
  a variable nobody set. `gh` wraps the fake's process, recording each call's vector, standard
  input and environment. Then:
  - exit 0 and a pull request;
  - every gh environment holds `GH_TOKEN` and `GITHUB_TOKEN` with `GH_CANARY` unchanged —
    passed unread — `GH_PROMPT_DISABLED=1`, and none of `KEY`, `TOKEN`, any `GIT_*`, `GH_HOST`,
    `GH_REPO`, `GH_DEBUG`, `GODEBUG` or `GH_ENTERPRISE_TOKEN` (each compared by name);
  - every git environment (`spawned.environments`) holds neither `KEY` nor `TOKEN`, and holds
    `GH_TOKEN` and `GITHUB_TOKEN` with `GH_CANARY` unchanged (§ 5's table: git keeps them, for
    `gh auth git-credential`); of `GIT_*`, the push's holds exactly `GIT_SSH_COMMAND`,
    `GIT_SSH_VARIANT` and `GIT_ASKPASS` as `clone.env` and the planted value hand them, plus
    `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`, which `gitEnvironment` sets; every other
    git call holds exactly those two and none of the inherited `GIT_*` (`GIT_DIR`,
    `GIT_CONFIG_PARAMETERS`, `GIT_ASKPASS`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT` among them);
  - no gh argument vector, no gh standard input, no git argument vector, no stdout, no stderr
    and not the fake's pull request body holds any of the three canaries or
    `enterprise-canary`.

Why it fails: `plan --from --submit` starts neither gh nor a push before this task.

- [ ] **Step 4: Run the tests, see them fail**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/submit-github.test.ts tests/unit/plan-command.test.ts tests/unit/cli-args.test.ts
pnpm vitest run tests/unit/init-command.test.ts tests/unit/trace-wiring.test.ts tests/contract/key-reach.test.ts
```

Expected: FAIL for the reasons above.

- [ ] **Step 5: `forge/open.ts`**

```typescript
/** The roads that open a pull request in this build; the others are refused toward GitHub (6.3). */
const OPENS_PULL_REQUESTS: readonly PullRequestInput['road'][] = ['from']

const NOT_YET: Record<Exclude<PullRequestInput['road'], 'from'>, string> = {
  intent:
    'the intent road opens pull requests from the next release; add --local to cut the branch in ' +
    'this clone only, or submit a plan file with plan --from <plan.json> --submit. Nothing was written.',
  init:
    "init opens a pull request on the service's repository from the next release; add --local to cut " +
    'the branch in this clone only. Nothing was written.',
  phrase:
    'idpa "<phrase>" does not submit yet; a change is submitted with plan --from <plan.json> --submit. ' +
    'Nothing was written.',
}
```

`openSubmissionForge(input)`: `git = gitIn(repo, { env })`; `openLocalForge(repo, repository,
git)` (stage 5's exit-2 checks first, so a directory that is not a clone says so before any
road is read); for a `route` outside `OPENS_PULL_REQUESTS`, `readRoad(git, { local })` and, on a
GitHub road, `ForgeInputError(NOT_YET[route])` before gh is asked (Global Constraint
1: no road starts gh before its key-reach leg lands); then `openGitHub({ repo, env, gh, local,
git })`. A local road returns `{ forge: local, road }`. A GitHub road opens the local forge
again with `acceptOlderBase: true` (its checks are four reads already passed; the option is
fixed at opening, so the local road's forge keeps D7 untouched), then `openGitHubForge({ repo,
local: older, road, identity, api, env, git, route })`. `forge/open.ts` names `GhProcess` with
`import type` and loads no launcher but `process/git.ts`, which `forge/` already loads.
6.3.1, 6.3.2 and 6.3.3 each add their road to `OPENS_PULL_REQUESTS` and remove its entry
from `NOT_YET`.

- [ ] **Step 6: `submit.ts`**

- `openForSubmission(root, repository, options)`: `options.open` when given, else
  `openSubmissionForge({ repo: root, repository, env: options.env ?? process.env, ...(gh), local:
  options.local === true, route: options.route })`; then `base()`; then, on a GitHub road,
  `options.notice?.(submittingLine(road, identity, base))`, a local function writing the stderr
  line through `inertLine`. `Opened` carries `road` and `github`.
- `reopening(opened, root, repository)` hands on the `OpenedForge`.
- `refuseUnprotected(opened, options)`: `undefined` on a local road; else `preflight(api, road,
  base, identity)`; a verdict that does not hold is `renderUnprotected(verdict, road)`, a
  `level` that is not `'level'` the not-level line of *Exact lines* (the rules are judged first, so a
  base that fails both is told about its ruleset); `found: false`; with `json`, `{ submission:
  { outcome: 'refused', reasons } }` alone, as `refuseDivergence` answers, `reasons` the
  unprotected text's first line and each `missing:` line, or the not-level sentence.
- `submit(input)`: the early return keeps every recognised outcome but
  `pushed-without-pull-request`; the summary handed to `confirm` gains `github` on a GitHub road,
  `pushedAlready` from that outcome; the result carries `attributes: forgeAttributes(report,
  opened.road, opened.github?.api.calls() ?? 0)`.
- `outcomeOf(submitted, base, road, said)`: the two cases of 6.2.1 become real (the statuses of
  the table, `found: false`); `created` and `already-submitted` put `pushed: submitted.pushed ===
  true`, `pullRequest`, `olderBase` in the report and `road`, `pullRequest`, `olderBase`,
  `statusChecks` in the status; `refused` carries `kept`. A `switch` with a `never` default over
  `Submitted`; `forgeAttributes` switches over `SubmissionReport` and `Road` the same way.

- [ ] **Step 7: `footer.ts`**

`NO_FORGE` removed. `closingLines` over the widened `PreviewStatus` (a `never` default):
`submitted` on a local road prints its first line, `localRoadLine(status.road)`, `CLOSING`; on a
GitHub road, the table's lines, `pullRequestLines(status.pullRequest, { statusChecks:
status.statusChecks ?? [] })` for the opened ones, and throws when a GitHub road's status holds
no pull request. `localRoadLine(road)` switches over `why` with a `never` default.
`pullRequestLines` prints the URL as `PullRequest.url` holds it, which `pullRequestUrl` built.

- [ ] **Step 8: `plan.ts`, `init.ts`, `index.ts`, `result.ts`**

- `result.ts`: `attributes?: Attributes` (a type from `trace/model.ts`, imported as a type).
- `runPlan`: `openForSubmission(root, 'declarations', { ...options.submit, route: 'from' })`;
  `refuseUnprotected(opened, { json })` right after `refuseDivergence`; the two `--json` paths
  read `found` and `attributes` from `submit()`'s result.
- `runIntent` and `runInitRepo`: the same spread with `route: 'intent'` and `route: 'init'` (each
  meets the interim refusal toward GitHub, or its local road).
- `index.ts`: `--local` in `plan`'s and `init`'s `parseArgs` options, `local: true` on the
  command when typed, the refusal without `--submit`; the three openers pass `{ confirm, local,
  env: deps.env ?? process.env, gh: deps.gh, notice: toStderr(err), route }`; the intent and init
  openers keep `reopening`, handed the whole `OpenedForge`; `confirmOnTerminal` asks § 3's
  question when `summary.github` is set, and the local road's otherwise, unchanged;
  `agentBacked` merges `result.attributes` into `builder.finish({ attributes: { ...,
  'idp.exit_code': code } })`; HELP's `plan` and `init` lines gain `[--submit [--local]]`, and
  its paragraph "With it, plan cuts a branch … nothing is pushed, and no merge request is
  opened" becomes: "With it, plan cuts a branch idp-agent/… from HEAD in the declarations
  repository, which must be a git clone's root, for review. When the checked-out branch tracks
  one on github.com, plan --from pushes that branch with your git and opens a pull request into
  it with your gh, once gh is logged in and the base's ruleset keeps you from merging it
  unreviewed (idpa protection says whether it does); --local keeps the branch in the clone. A
  change drafted from an intent is not pushed yet."

- [ ] **Step 9: Run the tests**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/submit-github.test.ts tests/unit/plan-command.test.ts tests/unit/cli-args.test.ts tests/unit/init-command.test.ts
pnpm vitest run tests/unit/plan-intent.test.ts tests/unit/trace-wiring.test.ts tests/contract/key-reach.test.ts tests/scenarios/prompt-digests.test.ts
pnpm vitest run tests/architecture --reporter=verbose
pnpm typecheck
```

Expected: PASS; `prompt-digests.test.ts` unchanged and green (nothing a model is sent moved);
the architecture block still 29 rules (this task adds none; `forge/open.ts` imports `forge/`,
`core/` and `process/git.ts`, and *only forge/github/ loads the gh launcher* holds because it
names `GhProcess` with `import type`).

- [ ] **Step 10: The binary — `pnpm demo:github` and `pnpm smoke`**

`scripts/demo-github.mjs` (6.1.3) gains four steps after `protection`'s three, each stating what
it expects before it runs, over a fresh copy of its clone and bare repository, the fake gh first
on `PATH` and the clone's `GIT_SSH_COMMAND` the demo's fake ssh:

1. `plan --from examples/open-network.json --repo <clone> --submit --local`: exit 0, `--local:
   nothing pushed by this run`, the bare repository holds no `idp-agent/` ref, and the fake's
   call log is empty.
2. `plan --from … --submit`: exit 0, stderr `submitting to github.com/acme/iac, into main
   (origin, main's upstream), as ada (gh)`, stdout `Pull request #1 opened on
   github.com/acme/iac: https://github.com/acme/iac/pull/1`; the bare repository's branch is the
   clone's.
3. The same again: exit 0, `pull request #1 is open · nothing written`, the fake still holding
   one pull request.
4. The fake logged out, the same again: exit 2, `main tracks github.com/acme/iac, and gh is not
   logged in to github.com, …`, nothing written.

`scripts/smoke.mjs`: on the existing `submitted` clone (no remote), the first run's checks gain
`stdout: /^main tracks no remote: nothing pushed$/m` beside the existing first line, and after
the two runs, one more: `plan --from OPEN_NETWORK --repo submitted --submit --local`, code 0,
`/^--local: nothing pushed by this run$/m`; and `plan --from OPEN_NETWORK
--repo submitted --local`, code 2, stderr `/--local says where --submit cuts its branch/`.
`pnpm smoke` runs `pnpm demo:github` where Node strips types (6.1.3), so the four steps above
run on the built binary there too.

```bash
pnpm build
pnpm demo:github
pnpm smoke
```

Expected: every step and check passes; the totals are printed, and `AGENTS.md`'s smoke count,
if it states one, is corrected in this commit.

- [ ] **Step 11: The documents this task makes true**

This is the pull request that makes the owner's invariant true of a road, so it is the one that
changes it, design §4 first, as `AGENTS.md` requires and decision 1 repeats ("Changed in design
§4 first"): no merged pull request states the old guarantee beside a build that no longer keeps
it.

- `docs/design.md` **§4.2**, first: the second bullet, "**Separate tokens per capability.** …",
  becomes the text 6.4.2's Step 4 quotes, word for word, except that its closing reference reads
  "(the stage 6 note, `docs/stage-6-brief.md` §§ 8 and 10)" until ADR-0015 exists; the first
  bullet's "merge request" becomes "pull request"; the third stays. Nothing else of design.md
  moves here: §4.4, §5, §7 to §10 and ADR-0006's consequence are 6.4.2's, which describe stage 6
  as built.
- `SECURITY.md`:
  - *What leaves your machine* gains two rows (or widens the gh row 6.1.3 added for `idpa
    protection`), both saying idpa itself opens no connection to GitHub:

    | to | when | what |
    |---|---|---|
    | github.com, through your own git | `plan --from … --submit` in a clone whose branch tracks one on github.com, without `--local` | one commit (the files the diff shows, your git identity as author and committer, the request as recorded with the plan) under one new `idp-agent/…` branch, pushed with your credentials and your git configuration, never the clone's own |
    | github.com, through your own gh | the same, and `idpa protection` | `GET` reads of your identity, the repository, the base's rules and rulesets, the base's and the branch's refs, one commit and the pull requests from the branch; one `POST` opening the pull request: its title, the commit's body, the request in a fenced block, and the engine's block. gh's login is gh's; idpa never reads it |

  - *Guaranteed today* gains three rows, the first in the owner's words (decision 1):
    - "The identity that opens a pull request cannot merge it until someone else has approved
      the exact commit that would merge, and idpa never submits against a base without those
      rules: the base's rules and each supplying ruleset's `current_user_can_bypass` are read
      through your gh before anything is written, and again at the moment of acting and before
      the pull request is opened — as long as the ruleset stands and binds every credential you
      push with (below)" | `tests/unit/merge-refused.test.ts` — *refuses every door to the
      identity that opened the pull request, and leaves it open and main where it was*,
      *refuses the author's merge after a push on top of an approved head, and lets it through
      once someone else approves the new head*, *lets the author merge unreviewed wherever the
      preflight refuses, and the preflight refuses each*; `tests/unit/github-forge.test.ts` —
      *re-checks the rules at the moment of acting: a ruleset dropped after the confirmation
      leaves nothing on either side*, *opens nothing when the rules stop holding during the
      push*; `tests/unit/submit-github.test.ts` — *refuses an unprotected base before anything
      is written, and prints the ruleset to add*, *tries every door after a submission through
      main, and each is refused*; on GitHub itself, the owner's live test (6.4.1).
    - "idpa runs no git or gh command outside its list — no merge, approval, review, close,
      reopen, forced push, deletion, push outside `refs/heads/idp-agent/`, no `PUT`, `PATCH` or
      `DELETE` — checked on the final argument vector before any process starts, and in the
      source; the forge has no method that merges, approves, closes or deletes" |
      `tests/unit/launcher-doors.test.ts`; `tests/architecture/dependencies.test.ts` — *nothing
      in src/ names a door the allow-list refuses*, *only the named modules write, and only
      process/git.ts and process/gh.ts start a process*; `tests/unit/forge-types.test.ts`.
    - "idpa reads, stores and sends no GitHub credential: git and gh are handed your environment
      unread, minus what the stage 6 note's § 5 removes, and no credential reaches an argument,
      standard input, stdout, stderr, a trace or a pull request body" |
      `tests/contract/key-reach.test.ts` — *hands gh and the push nothing of idpa's, and passes
      the person's gh login unread, on plan --from --submit*; `tests/architecture` — *nothing in
      src/ reads a GitHub credential from the environment*.
  - *What leaves your machine*, the MLflow row (`:56` on `2b2250e`) gains "and, on a
    submission, where it went (`idp.forge.*`: the kind, the base, the branch, the outcome)",
    since `forgeAttributes` reaches a trace from this pull request on the local road; 6.3.1
    widens it for the GitHub road.
  - *Designed, not yet built*: both items removed; the heading goes with them when nothing is
    left under it.
  - *Not guaranteed, by design* gains the limit of § 5 and § 8, stated once: an administrator
    can edit or disable the ruleset, or add themselves to its bypass list, outside idpa, and
    then merge (GitHub's ruleset history and audit log record it; a ruleset set at the
    organisation level cannot be changed by a repository administrator); idpa cannot read the
    bypass of the credential you push with (a deploy key it can see in the bypass list is
    refused; one it cannot see is not); and an approval by a workflow or an app counts as
    someone else's, so *Allow GitHub Actions to create and approve pull requests* should be off.
- `README.md`: `:8-10` and `:331-333` say `plan --from … --submit` pushes and opens the pull
  request on a GitHub road; `:120-132`, the stage-5 sample, keeps its lines with `main tracks no
  remote: nothing pushed` in place of `NO_FORGE`, and a second sample shows the GitHub road (the
  stderr line, the question, the four closing lines); `:470-482` says what the `--from` road does
  toward GitHub, `--local`, and the exit 2 without gh; `:172-176` and `:678-682`: the intent road
  is not pushed yet; the badge's test count.
- `docs/submitting.md` (6.1.3) gains *Submitting a plan file*: the question, the closing lines,
  running it again, `--local`, the step-12 stop and how the next run completes it, a closed pull
  request, each refusal and its one fix (gh, a clone not level, a base the rules do not protect,
  a configuration key), and that the intent, `init` and phrase roads follow in 6.3.
- `AGENTS.md`: the exit-code paragraph (`2` adds gh missing, logged out, expired, too old or not
  a person, a refused configuration key, a remote URL with a credential or that does not parse,
  `--local` without `--submit`, and `plan "<intent>" --submit` or `init --submit` toward GitHub
  until 6.3; `1` adds a base the rules do not protect, a clone not level with GitHub, a closed or
  reverted pull request, a pull request not opened, a push refused); the commands block
  (`[--submit [--local]]` on `plan --from` and `init`, `plan "<intent>"`); the bold sentence on
  what `--submit` writes gains "and, on a GitHub road, `plan --from … --submit` pushes that one
  ref to the same name on github.com with your git and opens one pull request with your gh";
  *The trust boundary*'s "What is not built is the far side — the merge request is stage 6"
  becomes "`plan --from … --submit` crosses it on a GitHub road; the intent, `init` and phrase
  roads cross it in 6.3"; the test count. *Invariants*, **Authorisation**, after design §4.2
  above: "One token per capability: …" becomes the owner's invariant word for word (the text of
  design §4.2's new bullet), followed by "— a test asserts the merge *fails*: offline against
  the fake gh (`tests/unit/merge-refused.test.ts`), live by the owner (stage 6 note, § 10)";
  the first bullet's "merge request" becomes "pull request". 6.4.2 points both at ADR-0015 and
  holds them to it with `invariant-wording.test.ts`.
- `src/cli/README.md` and `src/forge/README.md`: `forge/open.ts`, and `submit.ts`'s new
  responsibilities.
- `CHANGELOG.md`:

  > ### Added
  > - `plan --from … --submit` in a clone whose branch tracks one on github.com pushes the branch
  >   with your own git and opens a pull request into it with your own gh, printing the pull
  >   request's URL, which the engine builds; run again, it names the same pull request and
  >   writes nothing. Before anything is written it refuses a base whose ruleset would let you
  >   merge without someone else approving the latest commit (printing the ruleset to add) and a
  >   clone not level with GitHub, and it reads the rules again at the moment of acting. Without
  >   gh, or with gh logged out or not a person, nothing is pushed (exit 2, `--local` named).
  >   `--submit --local` cuts the branch in the clone only. `--json`'s `submission` gains `pushed`
  >   and `pullRequest`, and the outcomes `pushed-without-pull-request` and `closed`
  >   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).
  >
  > ### Changed
  > - A submission's closing line says which road it took, "main tracks no remote: nothing
  >   pushed" among them, where it said "this build has no forge (stage 6)"; `plan "<intent>"
  >   --submit` and `init --submit` toward GitHub are refused before any model, `--local` named,
  >   until their roads open pull requests ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

- `docs/roadmap.md`: the stage 6 queue item says slice 6.2 is on `main` (#PRNUM for 6.2.1 and
  this one) and 6.3 is next; cli-ux-10's item (*Waits for the owner*) names the new keys it will
  version: `pushed` on `created` and `already-submitted`, `pullRequest` (`host`, `repository`,
  `number`, `url`, `state`, `base`), `olderBase`, `kept` on `refused`, and the outcomes
  `pushed-without-pull-request` (`branch`, `commit`, `reason`) and `closed` (`branch`, `number`,
  `merged`, `at`).
- The review's Status: cli-ux-10's line names the same keys; it stays open (versioning is its
  subject).

- [ ] **Step 12: Checks, then the pull request** *(after the owner's go-ahead)*

```bash
df -h "$TMPDIR"
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

Every check green on this branch alone; `tests/golden/`, `fixtures/si-demo/` and every tape
unchanged; `pnpm test` reaches no network, no real gh and no real ssh.

```bash
git add src/forge/open.ts src/forge/README.md src/cli/commands/submit.ts src/cli/commands/result.ts src/cli/render/footer.ts src/cli/commands/plan.ts src/cli/commands/init.ts src/cli/index.ts src/cli/README.md
git add scripts/demo-github.mjs scripts/smoke.mjs
git add tests/unit/submit-github.test.ts tests/unit/plan-command.test.ts tests/unit/cli-args.test.ts tests/unit/init-command.test.ts tests/unit/trace-wiring.test.ts tests/contract/key-reach.test.ts
git add docs/design.md SECURITY.md README.md AGENTS.md docs/submitting.md CHANGELOG.md docs/roadmap.md docs/reviews/2026-09-23-deep-review.md
git commit -m "feat(cli): submit a plan file as a pull request, pushed with your git and opened with your gh"
```

**PR boundary.** Base `feat/s6-github-forge`. It closes slice 6.2. What changes that a person
sees: every `--submit` closing line (the road's line in place of `NO_FORGE`); `--local`; on a
clone tracking github.com, `plan --from … --submit` asks gh, checks the rules, pushes and opens a
pull request, or refuses; `plan "<intent>" --submit` and `init --submit` toward github.com are
exit 2 until 6.3.1 and 6.3.2; `--json`'s `submission` keys.

**What the owner can run.** First keyless and offline, from the pull request's worktree after
`pnpm install`:

```bash
pnpm build
pnpm demo:github
pnpm vitest run tests/unit/submit-github.test.ts tests/contract/key-reach.test.ts
pnpm smoke
```

Attendu :
- `pnpm demo:github` prints 6.1.3's three `protection` steps, then the four of Step 10 in their
  order, each marked as it expected, and exits 0;
- in its output, the `--local` step ends on `--local: nothing pushed by this run`, the
  submission on `Pull request #1 opened on github.com/acme/iac:
  https://github.com/acme/iac/pull/1`, the second submission on `pull request #1 is open ·
  nothing written`, and the logged-out step on exit 2 with `gh is not logged in to github.com`;
- both `vitest` files pass entirely, the leg *hands gh and the push nothing of idpa's, and
  passes the person's gh login unread, on plan --from --submit* among them;
- `pnpm smoke` ends on every check passed, `main tracks no remote: nothing pushed` among them.

Then against the throwaway repository of 6.1.3 (`~/idpa-live`, the demo catalogue on `main`,
the ruleset of § 8 added, gh logged in as the owner). These talk to GitHub with the owner's own
git and gh, and are the owner's alone. The first line is the only one to edit.

```bash
OWNER=your-login
BIN="$PWD/dist/cli/bin.js"
EXAMPLE="$PWD/examples/open-network.json"
node "$BIN" protection --repo ~/idpa-live
node "$BIN" plan --from "$EXAMPLE" --repo ~/idpa-live --submit
node "$BIN" plan --from "$EXAMPLE" --repo ~/idpa-live --submit
gh pr list --repo "$OWNER/idpa-live" --state all
git -C ~/idpa-live ls-remote origin "refs/heads/idp-agent/*"
git -C ~/idpa-live for-each-ref "refs/heads/idp-agent/"
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$(mktemp -d)" node "$BIN" plan --from "$EXAMPLE" --repo ~/idpa-live --submit
echo "exit $?"
```

Attendu :
- `protection` exits 0, as 6.1.3 left it;
- the first `plan` prints, on stderr, `submitting to github.com/$OWNER/idpa-live, into main
  (origin, main's upstream), as $OWNER (gh)`, then the diff of
  `dependencies/network/orders-api-to-payments.yml`, then asks `Push
  idp-agent/orders-api-to-payments-… to github.com/$OWNER/idpa-live with your git, and open a
  pull request into main with your gh? … [y/N]`; answer `y`: `1 file · submitted as
  idp-agent/orders-api-to-payments-… on top of main@… · main untouched`, `Pull request #1 opened
  on github.com/$OWNER/idpa-live: https://github.com/$OWNER/idpa-live/pull/1` (the number is
  whatever GitHub gives), the merging line naming no status check, and `Nothing is provisioned
  yet. The merge is what authorises it.`; exit 0. The URL's page says merging is blocked until
  an approval;
- the second `plan` asks nothing and prints `1 file · already submitted as
  idp-agent/orders-api-to-payments-… · pull request #1 is open · nothing written`; exit 0;
- `gh pr list` lists that one pull request, open, from `idp-agent/orders-api-to-payments-…`;
- `ls-remote` and `for-each-ref` show the same commit for that branch, and only that branch;
- the last run, with a gh that is not logged in, prints on stderr `main tracks
  github.com/$OWNER/idpa-live, and gh is not logged in to github.com, so idpa cannot read the
  rules that keep a pull request from merging unreviewed. Run `gh auth login --hostname
  github.com`, then run this again; or add --local to cut the branch in this clone only. Nothing
  was written.`, and `echo` prints `exit 2`.

The pull request stays open for 6.4.1's live test to find, or is closed by hand on its page;
this tool never closes it.

---

## Slice 6.3 — the three other roads

Closed by 6.3.3: the intent road (6.3.1), `init` (6.3.2) and the phrase (6.3.3) each open a pull request, and each lifts its interim refusal.

### Task 6.3.1: `plan "<intent>" --submit` to GitHub, and `iacRepo` as a cross-check

**Goal.** In a clone whose checked-out branch tracks a branch on github.com, `plan "<intent>"
--submit` does what `plan --from … --submit` does since 6.2.2, with the order § 12 fixes for a
road that pays a model: the local forge, the road and gh's identity before the model is
configured (exit 2); the preflight after the configuration and before the Inspector, the first
model call (exit 1); the gates, the Reviewer last; then the recognition, the confirmation, the
re-check of step 8, the local ref, the push, the read-back, the rules once more and the pull
request. `.idp-agent.yml`'s `iacRepo` is read for the first time, as a cross-check and never as
a source: a service whose file names another repository than the one the clone would open the
pull request on is refused, exit 1, naming both, before any model (§ 13, decision 15,
cli-ux-13). The run's trace carries the forge's attributes. Scripted clients only: no tape
changes, and `IDP_RECORDING=record` is never used (Global Constraint 7).

**Where this task starts.** 6.2.2 left, on this road: `main` opens the forge with
`openForSubmission(roots.repo, 'declarations', { local, env, gh, notice, route: 'intent', … })`
before the configuration, as `index.ts:1357-1368` did on `2b2250e`, and `openSubmissionForge`
(`src/forge/open.ts`) refuses a `GitHubRoad` there, before gh starts, with the interim exit 2 of
`NOT_YET.intent` (*the intent road opens pull requests from the next release; add --local …*); a
`LocalRoad` (no upstream, another host, `--local`) already submits with the closing line of its
road. `runIntent` still calls `refuseDivergence` alone. `forgeAttributes`,
`CommandResult.attributes` and their merge into `builder.finish` exist, and `submit()`'s result
carries them on every road (proven on the local road by `trace-wiring.test.ts`); no refusal
before `submit()` carries them yet.
Nothing of the local road changes here: its tests (`plan "<intent>" --submit`,
`plan-intent.test.ts:696-1023` on `2b2250e`) are run unchanged and stay green.

**Files:**
- Modify: `src/core/github/remote.ts` (`locatorRepository`)
- Modify: `src/forge/open.ts` (`'intent'` added to `OPENS_PULL_REQUESTS`, `NOT_YET.intent`
  removed)
- Modify: `src/cli/commands/submit.ts` (`refuseOtherRepository`; the forge's attributes on the
  results `refuseDivergence` and `refuseUnprotected` return, as 6.2.2 put them on `submit()`'s;
  `refuseUnprotected` judged once per forge and base, for 6.3.3)
- Modify: `src/cli/commands/plan.ts` (`runIntent`: the cross-check after `readConfig`, the
  preflight after `refuseDivergence`)
- Modify: `src/cli/index.ts` (the comment above the intent road's `--submit` block; `HELP`'s
  `--submit` paragraph)
- Modify: `src/core/schemas/config.ts` (the `iacRepo` field's comment only: read as a
  cross-check; lines 7-8 stay 6.4.2's)
- Modify: `tests/unit/plan-intent.test.ts` (a `describe('plan "<intent>" --submit to GitHub')`
  and a `describe('plan "<intent>" --submit and iacRepo')`), `tests/unit/submit-github.test.ts`
  (the intent half of 6.2.2's *refuses plan "<intent>" --submit and init --submit toward GitHub
  before any model and before gh, naming --local* removed — search `from the next release`),
  `tests/unit/github-remote.test.ts` (`locatorRepository`),
  `tests/contract/key-reach.test.ts` (a `describe.each(PROVIDER_NAMES)` for the submission legs,
  and the intent leg in it), `tests/support/github-fixture.ts` (`githubClone`'s `source` and
  `repository`, `unprotect`, `moveGitHubBase`: see *Names this task adds*)
- Modify: `scripts/demo-github.mjs` (two steps of the intent road)
- Modify: `docs/submitting.md` (*From a service: `plan "<intent>" --submit`*), `docs/design.md`
  (§7.0: "Nothing reads `iacRepo` before stage 6" rewritten), `SECURITY.md` (the rows 6.2.2
  added for the GitHub road name this road's tests; the model-provider row says no gh or git
  output reaches a prompt, with its test), `README.md` (the intent road's closing lines),
  `src/cli/README.md` (*Submitting*), `AGENTS.md` (exit `1` gains the `iacRepo` mismatch; the
  state line; the test count), `CHANGELOG.md`, `docs/roadmap.md`,
  `docs/reviews/2026-09-23-deep-review.md` (Status, cli-ux-13)

**Interfaces:**
- Consumes: `openForSubmission`, `reopening`, `Opened` (with `road` and `github`),
  `refuseDivergence`, `refuseUnprotected`, `submit`, `SubmissionReport`, `forgeAttributes`,
  `CommandResult.attributes` (6.2.2); `openSubmissionForge`, `OpenedForge`,
  `OPENS_PULL_REQUESTS`, `NOT_YET`, `route` (6.2.2); `GitHubRoad`, `GhIdentity`, `PullRequest`,
  `GitHubApi` and its `calls()`, `GITHUB_LIMITS` (6.1.2, 6.2.1);
  `GitHubRepository`, `sameRepository`, `isLogin` (6.1.2); `githubClone`, `FakeGitHub`,
  `GhProcess` (6.1.1, 6.2.1); `readConfig`, `CONFIG_FILE` (`cli/config.ts`).
- Produces:

```typescript
// src/core/github/remote.ts
/**
 * `.idp-agent.yml`'s `iacRepo` read as a repository on github.com, or undefined:
 * `github.com/<owner>/<name>`, optionally behind `https://` or `ssh://`, optionally ending
 * `.git` or `/`, the host in any case. The schema has already refused userinfo, a query and
 * a fragment (`carriesCredential`), so nothing here can hold a credential. The owner and the
 * name are held to the grammar `parseRemoteUrl` holds them to. Anything else — another
 * host, a path of one or three segments, a bare word — is undefined: a locator this build
 * cannot compare with a remote, which the cross-check refuses rather than skips.
 */
export function locatorRepository(iacRepo: string): GitHubRepository | undefined

// src/cli/commands/submit.ts
/**
 * § 13: `iacRepo` is a cross-check, never a source. On a GitHub road, a service whose
 * `.idp-agent.yml` names another repository than the one this clone would open the pull
 * request on is refused, exit 1, naming both. No file, no road to GitHub: nothing to hold.
 */
export function refuseOtherRepository(
  opened: Opened,
  config: RepositoryConfig | undefined,
  project: string,
  options?: { readonly json?: boolean },
): CommandResult | undefined
```

The line, stdout, exit 1 (every `<…>` through `inertLine`; the locator holds no credential by
the schema, so it is quoted):

```text
not submitted — .idp-agent.yml in <project> names <iacRepo> as this service's declarations repository, and <root>'s <branch> tracks github.com/<o>/<r>: run this with --repo naming a clone of the repository it names, or change iacRepo in a reviewed change. Nothing was written.
```

With `--json`, the report is its `submission` key alone, as `refuseDivergence`'s is:
`{ "submission": { "outcome": "refused", "reasons": ["<the sentence between the dash and the colon>"] } }`.

**Names this task adds** (listed in the plan's shared names; none renames one it holds):

- `refuseOtherRepository` and its line, above.
- In `tests/support/github-fixture.ts`: `githubClone`'s options gain `source?: string` and
  `repository?: string` beside 6.2.1's `model?` — `source`, a directory whose files are the first
  commit on `main` (default: `init platform`'s scaffold, as stage 5's `clone()`), and
  `repository`, `'<owner>/<name>'` (default `'acme/iac'`), which sets both the remote's URL and
  the repository the fake models, with 6.1.3's protected ruleset; `unprotect(gh: FakeGitHub):
  void | Promise<void>`, which removes every ruleset from the fake's model;
  `moveGitHubBase(clone): Promise<void>`, which puts one commit on the bare repository's `main`
  with the test's own git (`commit-tree` on `main`'s tree, then `update-ref`), so GitHub's base
  is no longer the clone's. Moved there from the test file that holds them if 6.2.1 or 6.2.2
  wrote them locally.

`route` (which road drafted the change, for the pull request body's engine block) and
`GitHubApi.calls()` (which `forgeAttributes(report, road, calls)` reads) are 6.2.1's and 6.2.2's;
this task passes nothing new through them.
- Test-local, in `tests/contract/key-reach.test.ts`: `submittingRun`, `heldToGitHub`,
  `GH_CANARY`.

**When each check runs on this road**, top to bottom, and what a refusal costs:

| # | Where | What | Refused with | Paid |
|---|---|---|---|---|
| 1 | `main`, before `agentBacked` | the local forge (stage 5), the road (`readRoad`), the repository's configuration keys, gh's presence, version and identity | exit 2 | nothing |
| 2 | `main`, same place | the stderr line `submitting to github.com/<o>/<r>, into <base> (<remote>, <branch>'s upstream), as <login> (gh)` | — | — |
| 3 | `agentBacked` | the model's configuration | exit 2 | nothing |
| 4 | `runIntent`, after `readConfig` | `refuseOtherRepository` | exit 1 | nothing: no gh call past step 1's two, no repository read |
| 5 | `runIntent`, after `readContents` | `refuseDivergence` (stage 5), then `refuseUnprotected` (the preflight, § 8 items 1 to 5 and the base level) | exit 1 | nothing |
| 6 | `runIntent` | the Inspector, the Architect, the four free gates, the Reviewer | as today | the models |
| 7 | `submit()`, in `renderOutcome` | recognition through gh, the confirmation, `forge.submit`: the re-check of step 8, the local ref, the push, the read-back, the rules again, the pull request | exit 0 or 1 | — |

Step 4 sits before step 5 so that a service pointed at the wrong clone costs no gh call and no
read of either repository; it comes after the configuration because it is the repository's
state against the service's file, a negative answer (exit 1), judged where divergence is judged
(*Choices*, *Which checks run when*). Without `--submit`, with `--local`, on a clone that tracks
nothing or tracks another host, or with no application repository inspected (no
`.idp-agent.yml` read), `refuseOtherRepository` answers `undefined`: nothing leaves the clone,
or nothing states a repository, and a preview stays stage 4's byte for byte.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/github-remote.test.ts`, beside 6.1.2's five forms:

```typescript
describe('locatorRepository', () => {
  it.each([
    ['github.com/acme/iac', 'acme', 'iac'],
    ['https://github.com/acme/iac', 'acme', 'iac'],
    ['https://github.com/acme/iac.git', 'acme', 'iac'],
    ['ssh://github.com/acme/iac', 'acme', 'iac'],
    ['GitHub.com/acme/iac/', 'acme', 'iac'],
    ['github.com/acme/my.repo_1-x', 'acme', 'my.repo_1-x'],
  ])('reads %s as github.com/%s/%s', (locator, owner, name) => {
    expect(locatorRepository(locator)).toStrictEqual({ host: 'github.com', owner, name })
  })

  it.each([
    'gitlab.example.com/acme/iac',
    'www.github.com/acme/iac',
    'github.com.evil.example/acme/iac',
    'http://github.com/acme/iac',
    'github.com/acme',
    'github.com/acme/iac/tree/main',
    'github.com/-acme/iac',
    'github.com/acme/..',
    'x',
    'acme/iac',
  ])('reads no GitHub repository in %s', (locator) => {
    expect(locatorRepository(locator)).toBeUndefined()
  })
})
```

*Why they fail:* `locatorRepository` is not exported (6.1.2 names it for 6.3.1).

In `tests/unit/plan-intent.test.ts`, importing `githubClone` and `unprotect`/`moveGitHubBase`
(*Names this task adds*) from `../support/github-fixture.js`, `memorySink` and `onlyTrace` from
`../support/trace.js`, `GITHUB_LIMITS` from `../../src/forge/github/limits.js` and
`type GhProcess` from `../../src/process/gh.js`:

```typescript
describe('plan "<intent>" --submit to GitHub', () => {
  afterAll(removeClones)

  type Clone = Awaited<ReturnType<typeof githubClone>>

  /**
   * Every gh call and every model call of one run, in the order they were made: what
   * "before any model" and "after the Reviewer" are checked on. The fake answers; this only
   * writes down what was asked of it.
   */
  const watching = (clone: Clone, inner: LlmClient) => {
    const log: string[] = []
    const gh: GhProcess = async (argv, options) => {
      log.push(`gh ${argv.join(' ')}`)
      return clone.gh.process(argv, options)
    }
    const client: LlmClient = {
      generate: async (request) => {
        log.push(`model ${request.agent}`)
        return inner.generate(request)
      },
    }
    return { log, gh, client }
  }

  const run = async (clone: Clone, args: string[], deps: Parameters<typeof main>[1] = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await main(args, {
      env: clone.env,
      gh: clone.gh.process,
      ...deps,
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
    })
    return { code, out: out.join(''), err: err.join('') }
  }

  const ours = async (dir: string): Promise<string[]> =>
    (await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/'))
      .split('\n')
      .filter((line) => line !== '')

  const submitting = (clone: Clone, project: string, extra: string[] = []): string[] =>
    ['plan', INTENT, '--repo', clone.repo, '--project', project, '--submit', ...extra]

  it('opens a pull request after all five gates, and prints the URL the engine builds', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    const { code, out, err } = await run(clone, submitting(clone, project), {
      gh,
      client,
      ask: answering('read'),
    })

    expect(code, err).toBe(0)
    expect(err).toMatch(
      /^submitting to github\.com\/acme\/iac, into main \(origin, main's upstream\), as [A-Za-z0-9-]+ \(gh\)$/m,
    )
    expect(out).toMatch(
      /^2 files · submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched$/m,
    )
    expect(out).toContain('Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1')
    expect(out.trimEnd().endsWith(CLOSING)).toBe(true)
    // The very commit the clone holds is the one GitHub holds: pushed, never rebuilt.
    const [ref] = await ours(clone.repo)
    expect(await ours(clone.bare)).toEqual([ref])
    expect(await git(clone.bare, 'rev-parse', ref ?? '')).toBe(await git(clone.repo, 'rev-parse', ref ?? ''))
    expect(log.filter((line) => line.startsWith('gh ') && line.includes('POST'))).toHaveLength(1)
  })

  it('reads the rules before the first model call, nothing of GitHub while the agents run, and the rules again after the Reviewer', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    await run(clone, submitting(clone, project), { gh, client, ask: answering('read') })

    const first = log.findIndex((line) => line.startsWith('model '))
    const reviewed = log.lastIndexOf('model reviewer')
    expect(first).toBeGreaterThan(0)
    // § 8 items 1 to 4 and the base level, before the Inspector.
    expect(log.slice(0, first).some((line) => /rules\/branches\/main\b/.test(line))).toBe(true)
    expect(log.slice(0, first).some((line) => /git\/ref\/heads\/main\b/.test(line))).toBe(true)
    // Nothing of GitHub is asked while a model is: every line between is a model call.
    expect(log.slice(first, reviewed + 1).every((line) => line.startsWith('model '))).toBe(true)
    // Step 8 and step 11 after the last model call, and the pull request last.
    expect(log.slice(reviewed + 1).filter((line) => /rules\/branches\/main\b/.test(line)).length).toBeGreaterThanOrEqual(2)
    expect(log.at(-1)).toMatch(/POST/)
  })

  it('writes nothing on either side before the Reviewer has answered', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])
    const seenAtReview: string[][] = []
    const client: LlmClient = {
      generate: async (request) => {
        if (request.agent === 'reviewer') seenAtReview.push([...(await ours(clone.repo)), ...(await ours(clone.bare))])
        return inner.generate(request)
      },
    }

    const { code } = await run(clone, submitting(clone, project), { client, ask: answering('read') })

    expect(code).toBe(0)
    expect(seenAtReview).toEqual([[]])
  })

  it('refuses at the moment of acting when the rules go while the Reviewer reads, and writes nothing on either side', async () => {
    // § 3 step 8: the preflight passed before the Inspector; the ruleset is removed while
    // the last model call runs. The re-check is what refuses, before the local ref.
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])
    const client: LlmClient = {
      generate: async (request) => {
        if (request.agent === 'reviewer') await unprotect(clone.gh)
        return inner.generate(request)
      },
    }

    const { code, out } = await run(clone, submitting(clone, project), { client, ask: answering('read') })

    expect(code).toBe(1)
    expect(out).toContain('Nothing was written.')
    expect(await ours(clone.repo)).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a base whose rules let the opener merge, exit 1, before a single model call', async () => {
    const clone = await githubClone()
    await unprotect(clone.gh)
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])

    const { code, out } = await run(clone, submitting(clone, project), { client: inner, ask: answering('read') })

    expect(code).toBe(1)
    expect(out).toContain(
      "not submitted — nothing on github.com/acme/iac's main stops the person who would open this pull request from merging it:",
    )
    expect(out).toContain('Add a ruleset on main (Settings → Rules → Rulesets):')
    expect(inner.seen).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a clone that is not level with GitHub, exit 1, before a single model call', async () => {
    const clone = await githubClone()
    await moveGitHubBase(clone)
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])

    const { code, out } = await run(clone, submitting(clone, project), { client: inner, ask: answering('read') })

    expect(code).toBe(1)
    expect(out).toContain('bring them level (git pull), then run this again.')
    expect(inner.seen).toEqual([])
  })

  it.each([
    ['gh not logged in', (clone: Clone) => clone.gh.logout(), 'gh is not logged in to github.com'],
    ['gh not installed', () => undefined, 'gh is not installed'],
  ])('refuses with %s, exit 2, before the model is configured, naming --local', async (_, arrange, said) => {
    const clone = await githubClone()
    arrange(clone)
    const project = await application(CONFIGURED)
    const missing: GhProcess = async () => ({ code: 'ENOENT', stdout: Buffer.alloc(0), stderr: '', timedOut: false })
    const before = await observable(clone.repo)

    // No client, no key: the configuration would be refused next, and is not reached.
    const { code, out, err } = await run(clone, submitting(clone, project), {
      ...(said === 'gh is not installed' ? { gh: missing } : {}),
    })

    expect(code).toBe(2)
    expect(err).toContain(said)
    expect(err).toContain('add --local to cut the branch in this clone only')
    expect(err).not.toContain('no model configured')
    expect(out).toBe('')
    expect(await observable(clone.repo)).toBe(before)
  })

  it('refuses a key of the clone’s own configuration that would redirect the push, exit 2, naming it and never its value', async () => {
    const clone = await githubClone()
    await git(clone.repo, 'config', 'credential.helper', 'store --file=/tmp/canary-credential-store')
    const project = await application(CONFIGURED)

    const { code, err } = await run(clone, submitting(clone, project))

    expect(code).toBe(2)
    expect(err).toContain("this clone's own configuration sets credential.helper (local), which would decide who pushes for you")
    expect(err).not.toContain('canary-credential-store')
    expect(err).not.toContain('no model configured')
  })

  it('cuts only the local branch with --local, starts no gh, and says so', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    const { code, out } = await run(clone, submitting(clone, project, ['--local']), { gh, client, ask: answering('read') })

    expect(code).toBe(0)
    expect(out).toContain('--local: nothing pushed by this run')
    expect(await ours(clone.repo)).toHaveLength(1)
    expect(await ours(clone.bare)).toEqual([])
    expect(log.filter((line) => line.startsWith('gh '))).toEqual([])
  })

  it('names the open pull request on a second run, not asked, and writes nothing', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    await run(clone, submitting(clone, project), { client: converging([CREATE_DATABASE, CREATE_ACCESS]), ask: answering('read') })
    const before = await observable(clone.repo)
    let asked = 0

    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))
    const { code, out } = await run(clone, submitting(clone, project), {
      gh,
      client,
      ask: answering('read'),
      confirm: async () => {
        asked += 1
        return true
      },
    })

    expect(code).toBe(0)
    expect(out).toMatch(/already submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} · pull request #1 is open · nothing written/)
    expect(asked).toBe(0)
    expect(log.some((line) => line.includes('POST'))).toBe(false)
    expect(await observable(clone.repo)).toBe(before)
  })

  it('asks the question of § 3 on a GitHub road, naming the push and the pull request', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const summaries: SubmissionSummary[] = []

    await run(clone, submitting(clone, project), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
      confirm: async (summary) => {
        summaries.push(summary)
        return false
      },
    })

    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.github).toStrictEqual({ host: 'github.com', repository: 'acme/iac', base: 'main', pushedAlready: false })
    expect(await ours(clone.bare)).toEqual([])
  })

  it('reports the pull request in --json, under the key --from pins (D11)', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)

    const { code, out } = await run(clone, submitting(clone, project, ['--json']), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(0)
    const { submission } = JSON.parse(out) as { submission: Record<string, unknown> }
    expect(submission).toMatchObject({
      outcome: 'created',
      pushed: true,
      pullRequest: {
        host: 'github.com',
        repository: 'acme/iac',
        number: 1,
        url: 'https://github.com/acme/iac/pull/1',
        state: 'opened',
        base: 'main',
      },
    })
  })

  it('sends every agent the bytes it sends without --submit: nothing of GitHub reaches a prompt', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const previewing = converging([CREATE_DATABASE, CREATE_ACCESS])
    await run(clone, ['plan', INTENT, '--repo', clone.repo, '--project', project], { client: previewing, ask: answering('read') })
    const submittingClient = converging([CREATE_DATABASE, CREATE_ACCESS])
    const { err } = await run(clone, submitting(clone, project), { client: submittingClient, ask: answering('read') })
    const login = /as ([A-Za-z0-9-]+) \(gh/.exec(err)?.[1] ?? ''

    expect(login).not.toBe('')
    expect(JSON.stringify(submittingClient.seen)).toBe(JSON.stringify(previewing.seen))
    expect(JSON.stringify(submittingClient.seen)).not.toContain('github.com')
    expect(JSON.stringify(submittingClient.seen)).not.toContain(login)
  })

  it('reads nothing more of GitHub and pushes nothing when the run ends on a question', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    // Nobody to ask: the level is a question, and the run ends on it (exit 3).
    const { code } = await run(clone, submitting(clone, project), { gh, client })

    expect(code).toBe(3)
    const first = log.findIndex((line) => line.startsWith('model '))
    expect(log.slice(first).filter((line) => line.startsWith('gh '))).toEqual([])
    expect(await ours(clone.repo)).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('puts the forge on the trace’s root, never a login, and counts the gh calls it made', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))
    const sink = memorySink()

    const { code, err } = await run(clone, submitting(clone, project), { gh, client, ask: answering('read'), traceSinks: [sink] })

    expect(code).toBe(0)
    const trace = onlyTrace(sink)
    const root = trace.spans[0]?.attributes ?? {}
    const calls = log.filter((line) => line.startsWith('gh ')).length
    expect(root).toMatchObject({
      'idp.forge.kind': 'github',
      'idp.forge.host': 'github.com',
      'idp.forge.base': 'main',
      'idp.forge.pull_request': 1,
      'idp.forge.outcome': 'created',
      'idp.forge.pushed': true,
      'idp.forge.gh_calls': calls,
    })
    expect(calls).toBeLessThanOrEqual(GITHUB_LIMITS.ghCalls)
    const login = /as ([A-Za-z0-9-]+) \(gh/.exec(err)?.[1] ?? ''
    expect(JSON.stringify(trace, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(login)
  })
})
```

`idp.forge.repository` and `idp.forge.branch` are asserted in the form `forgeAttributes`' unit
test pins them (6.2.2); the object above leaves them out so this test does not restate it.

```typescript
describe('plan "<intent>" --submit and iacRepo', () => {
  afterAll(removeClones)

  it('refuses a service whose iacRepo names another repository, exit 1, naming both, before any model and any read of GitHub', async () => {
    const clone = await githubClone()
    const project = await application('iacRepo: github.com/acme/other-iac\nenvironments: [dev, staging, prod]\n')
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    const { code, out } = await run(clone, submitting(clone, project), { gh, client, ask: answering('read') })

    expect(code).toBe(1)
    // The two paths are printed as `main` resolved them; the sentence around them is pinned.
    expect(out.startsWith('not submitted — .idp-agent.yml in ')).toBe(true)
    expect(out).toContain("names github.com/acme/other-iac as this service's declarations repository, and ")
    expect(out.trimEnd()).toMatch(
      /'s main tracks github\.com\/acme\/iac: run this with --repo naming a clone of the repository it names, or change iacRepo in a reviewed change\. Nothing was written\.$/,
    )
    expect(out.trimEnd().split('\n')).toHaveLength(1)
    expect(log.filter((line) => line.startsWith('model '))).toEqual([])
    // gh's version and identity, read in main before the configuration; no route of the repository.
    expect(log.filter((line) => /repos\//.test(line))).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a locator that names no repository on github.com, quoting it', async () => {
    const clone = await githubClone()
    const project = await application('iacRepo: gitlab.example.com/acme/iac\nenvironments: [prod]\n')

    const { code, out } = await run(clone, submitting(clone, project), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(out).toContain('names gitlab.example.com/acme/iac as this service')
  })

  it.each([
    'https://github.com/acme/iac.git',
    'github.com/ACME/IaC',
    'ssh://github.com/acme/iac/',
  ])('submits when iacRepo names the same repository, written as %s', async (locator) => {
    const clone = await githubClone()
    const project = await application(`iacRepo: ${locator}\nenvironments: [dev, staging, prod]\n`)

    const { code, out } = await run(clone, submitting(clone, project), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(out).toContain('Pull request #1 opened on github.com/acme/iac')
  })

  it('reads no iacRepo where nothing leaves the clone: --local, no --submit, a clone that tracks nothing', async () => {
    const project = await application('iacRepo: github.com/acme/other-iac\nenvironments: [dev, staging, prod]\n')
    const tracked = await githubClone()
    const untracked = await clone()

    for (const [repo, extra] of [
      [tracked.repo, ['--submit', '--local']],
      [tracked.repo, []],
      [untracked, ['--submit']],
    ] as const) {
      const { code } = await run(tracked, ['plan', INTENT, '--repo', repo, '--project', project, ...extra], {
        client: converging([CREATE_DATABASE, CREATE_ACCESS]),
        ask: answering('read'),
      })
      expect(code).toBe(0)
    }
  })

  it('answers the mismatch in --json with the submission key alone', async () => {
    const clone = await githubClone()
    const project = await application('iacRepo: github.com/acme/other-iac\nenvironments: [prod]\n')

    const { code, out } = await run(clone, submitting(clone, project, ['--json']), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(Object.keys(JSON.parse(out) as object)).toEqual(['submission'])
    expect(JSON.parse(out)).toMatchObject({ submission: { outcome: 'refused' } })
  })
})
```

`watching`, `run`, `ours` and `submitting` are hoisted to the file's scope so both `describe`s
share them. `SubmissionSummary` is imported as a type from `../../src/cli/commands/submit.js`.

In `tests/contract/key-reach.test.ts`, a third `describe.each(PROVIDER_NAMES)`, *the %s key,
and the person's gh and git, on a submission to GitHub*, whose runner is the first block's `run`
with three differences: the repository is `githubClone({ source: FIXTURES })`; `main` is handed
`gh:` a recorder around `clone.gh.process` keeping each call's argument vector, standard input
and environment, and `env: { ...clone.env, <the provider's variables>, GH_TOKEN: GH_CANARY,
GITHUB_TOKEN: GH_CANARY }` (and `vi.stubEnv` of both, as a real shell holds them); and
`spawned.environments` is emptied before the run. Its first leg:

```typescript
  it('reaches its provider in its header, and nothing of GitHub reaches it, on plan "<intent>" --submit', async () => {
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { intent: string; operations: unknown[] }
    const { project } = await repositories()
    const ran = await submittingRun(['plan', example.intent, '--project', project, '--submit'], 'MUTATION', example.operations)

    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('Pull request #1 opened on github.com/acme/iac')
    heldToGitHub(ran, 'acme/iac')
  })
```

`heldToGitHub(ran, repository)`, shared by 6.3.2's and 6.3.3's legs, asserts two different things of the
two places a run sends to, because § 12 sends them different things:

- **the model provider: nothing of GitHub.** Every request to the provider went to its URL with
  the key in its one header (the first block's loop), and **no provider request contains
  `github.com`, the login gh answered (read from the `submitting to` line), `GH_CANARY` or the
  base's commit** — the guard of § 12's "no gh output and no git output is in any prompt";
- **the trace: where the submission went, and never who or with what.** § 12 puts the forge's
  host and repository on the trace's root on purpose, so no MLflow request, and not the trace
  the sink kept, contains the login or `GH_CANARY`; and the trace's root carries
  `idp.forge.kind: 'github'`, `idp.forge.host: 'github.com'`, `idp.forge.repository:
  repository` and `idp.forge.pull_request: 1`, asserted
  positively. `github.com` in the trace is held to that one place: the trace serialised with
  the root's `idp.forge.host` removed contains no `github.com` (the prompts it carries are the
  provider requests' own, which the first point already holds to none), and the MLflow requests
  hold `github.com` exactly as often as the trace they ship holds the attribute.

And of the processes: the key is in no gh call's argument vector, standard input or environment,
and in no environment `spawned` recorded (the push included); `GH_CANARY` is in every gh call's
environment, unchanged — passed unread (§ 5) — and in no gh argument vector, no gh standard
input (the pull request's body), no stdout or stderr. `submittingRun` appends `--repo <clone>`
to the argument vector itself.

*Why they fail, before the code:* every GitHub-road case exits 2 on 6.2.2's interim refusal
(`the intent road opens pull requests from the next release`), so no pull request, no preflight
before the Inspector, no second rules read, no trace attributes, and the key-reach leg's `code`
is 2. `refuses a base whose rules let the opener merge` expects exit 1 and the ruleset lines,
and gets the interim exit 2. *refuses with gh not logged in / not installed* fails too, on the
interim message: `openSubmissionForge` refuses the road before gh starts. The `iacRepo` cases
fail because nothing reads `iacRepo`: the mismatch would reach the interim refusal (exit 2)
today, and after the interim refusal is lifted, submit to `acme/iac` (exit 0). Two cases pass
before the code and are kept as guards: *refuses a key of the clone's own configuration*
(`readRoad` refuses it before the interim refusal is reached) and *cuts only the local branch
with --local* (6.2.2's local road).

- [ ] **Step 2: Run them to verify they fail**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/github-remote.test.ts tests/unit/plan-intent.test.ts tests/contract/key-reach.test.ts
```

Expected: FAIL — `locatorRepository` is not a function; the GitHub-road cases exit 2 with the
interim sentence; the `iacRepo` mismatch is not refused.

- [ ] **Step 3: `locatorRepository`**

In `src/core/github/remote.ts`: strip an optional `https://` or `ssh://`, one trailing `/`,
then one trailing `.git`; split on `/`; exactly three segments; the first, lower-cased, is
`github.com`; the owner and the name pass the predicates `parseRemoteUrl` holds a remote's
owner and repository to (6.1.2), and the name is not `.` or `..`. Anything else is
`undefined`. No new grammar: the owner and repository rules are the ones already held in
agreement with `process/`'s copies by `grammar-agreement.test.ts`, which needs no new case.

- [ ] **Step 4: `refuseOtherRepository`, and the forge on every result of `submit.ts`**

In `src/cli/commands/submit.ts`:

```typescript
export function refuseOtherRepository(
  opened: Opened,
  config: RepositoryConfig | undefined,
  project: string,
  options: { readonly json?: boolean } = {},
): CommandResult | undefined {
  const road = opened.road
  if (config === undefined || road.kind !== 'github') return undefined
  const named = locatorRepository(config.iacRepo)
  // Compared as GitHub resolves a repository, owner and name in any case (6.1.2).
  if (named !== undefined && sameRepository(named, road.repository)) return undefined
  const reason =
    `${CONFIG_FILE} in ${project} names ${config.iacRepo} as this service's declarations repository, ` +
    `and ${opened.root}'s ${road.branch} tracks github.com/${road.repository.owner}/${road.repository.name}`
  const report: SubmissionReport = { outcome: 'refused', reasons: [reason] }
  const attributes = forgeAttributes(report, road, callsOf(opened))
  if (options.json === true) {
    return { text: JSON.stringify({ submission: report }, null, 2), found: false, attributes }
  }
  return {
    text:
      `not submitted — ${inertLine(reason, Number.POSITIVE_INFINITY)}: run this with --repo naming a clone ` +
      'of the repository it names, or change iacRepo in a reviewed change. Nothing was written.',
    found: false,
    attributes,
  }
}
```

`callsOf(opened)` is `opened.github?.api.calls() ?? 0`, private to the module. `submit()`'s
result (since 6.2.2), `refuseDivergence`'s refusal and `refuseUnprotected`'s refusal each carry `attributes:
forgeAttributes(report, opened.road, callsOf(opened))` with the report they build (for a
refusal in prose, the `{ outcome: 'refused', reasons }` the `--json` form carries). The `--from`
road writes no trace, so these attributes are read there by nobody, and its output does not
move. The attributes are computed when the result is returned, so `idp.forge.gh_calls` counts
every call the run made, step 11 and the pull request included.

`refuseUnprotected` keeps one verdict per forge and base: a module-level `WeakMap<ForgeProvider,
{ commit: string; verdict: Promise<CommandResult | undefined> }>`, read when the same forge is
asked again at the same `opened.base.commit`, so a road that runs the preflight early (6.3.3)
does not read § 8's thirteen routes twice and stays inside `GITHUB_LIMITS.ghCalls`. A base that
moved in between is judged again. A refusal ends the run, so only a pass is ever read back;
step 8 and step 11 are the forge's own reads and are never cached.

- [ ] **Step 5: `runIntent`**

Right after `const config = …readConfig(options.project)` (`plan.ts:1406` on `2b2250e`):

```typescript
  if (opened !== undefined && options.project !== undefined) {
    // § 13: the service says where its declarations live, the clone says where the pull
    // request would go, and a service is never the one that chooses (decision 15). Held
    // here, before either repository is read further and before any model: a service
    // pointed at the wrong clone costs nothing.
    const other = refuseOtherRepository(opened, config, options.project, { json: options.json === true })
    if (other !== undefined) return other
  }
```

After the `refuseDivergence` block (`:1430-1442`), inside the same `if (opened !== undefined)`:

```typescript
    // § 8, items 1 to 5 and the base level: the repository's state, judged where
    // divergence is, after the configuration and before the Inspector, the first model call.
    const unprotected = await refuseUnprotected(opened, { json: options.json === true })
    if (unprotected !== undefined) return unprotected
```

Nothing else in `runIntent` moves: the re-check at step 8, the push and the pull request are
`forge.submit`'s, reached through `submit()` in `renderOutcome`, which `repair` returns to only
after the Reviewer. A question or a stop never reaches `submit()` and reads nothing more of
GitHub.

- [ ] **Step 6: `main`**

In `src/forge/open.ts`: `'intent'` joins `OPENS_PULL_REQUESTS` and `NOT_YET.intent` goes, with
its sentence. In the intent road's `--submit` block (`index.ts:1357-1368` on `2b2250e`, as 6.2.2
left it), nothing of the call moves: it already passes `route: 'intent'` and a `notice`, so the
GitHub road's stderr line is printed exactly as the `--from` road prints it, before
`agentBacked`, and `runIntent` is handed the opened forge through `reopening`. The comment above
the block keeps its reasoning and gains the road and gh: every exit-2 check of the submission
runs here, before the configuration.

`HELP`'s `--submit` paragraph (`index.ts:266-274` on `2b2250e`, reworded by 6.2.2 for `--from`)
says both roads of `plan` push the branch and open a pull request where the checked-out branch
tracks one on github.com, and that `plan "<intent>" --submit` reads the road, gh and the rules
before any model is paid.

- [ ] **Step 7: The demo**

`scripts/demo-github.mjs` gains two steps after 6.2.2's, on the same clone of the demo SI and
with the binary's environment holding **no provider key and no `IDP_*` variable** (the script
removes every `*_API_KEY`, `IDP_*` and `XDG_CONFIG_HOME` from the environment it builds, and
says so in its header; a step that finds a model configured fails the demo, so the owner's
exported key is never spent by it):

1. *The intent road refuses a gh that is not logged in before any model* — the fake logged out
   (the toggle 6.1.3's third step uses), `plan "<intent>" --repo <clone> --submit`: exit 2, the
   gh sentence naming `--local`.
2. *The intent road reads the road and gh's identity before the model's configuration* — the
   fake logged in: exit 2, stderr first `submitting to github.com/acme/iac, into main (origin,
   main's upstream), as <the fake's login> (gh)`, then `no model configured: …`. The step fails
   unless both lines are there, in that order.

- [ ] **Step 8: Traceability and the documents this task makes true**

- `CHANGELOG.md`, Unreleased → Added (below).
- `docs/roadmap.md`: the stage 6 row names 6.3.1 and its pull request; the queue item says the
  intent road is built; cli-ux-13 leaves the open list of *Scope and documents* (`:661` on
  `2b2250e`).
- `docs/reviews/2026-09-23-deep-review.md`, Status → *Beyond the priorities*: `cli-ux-13 →
  [#PRNUM]`, for its `iacRepo` half — read, as a cross-check on the GitHub road; left: `plan
  --from` reads no `.idp-agent.yml` (it inspects no application repository), and the file is
  looked for at a service's root only, `isApplicationRepository`'s rule.
- `docs/design.md` §7.0: "Nothing reads `iacRepo` before stage 6." becomes "`plan "<intent>"
  --submit` reads `iacRepo` as a cross-check, never a source: on a clone tracking github.com, a
  locator naming another repository refuses the submission, naming both (stage 6)." The
  paragraph at `:931-936` keeps "it is not a fall-back for `repo`".
- `src/core/schemas/config.ts`: the `iacRepo` field's comment says the same in one line.
- `docs/submitting.md`: *From a service: `plan "<intent>" --submit`* — the order of the checks
  (the table above, in prose), the cross-check and the one line it prints, `--local`.
- `SECURITY.md`: the GitHub-road rows 6.2.2 added name *plan "<intent>" --submit to GitHub*'s
  tests beside `--from`'s; the model-provider row of *What leaves your machine* says nothing gh
  or git printed reaches a prompt, citing *sends every agent the bytes it sends without
  --submit* and the key-reach leg; the MLflow row's forge clause becomes "and, on a submission,
  where it went (`idp.forge.*`: the kind, and on a GitHub road the host, the repository, the
  base, the branch, the pull request's number, the outcome, how many gh calls, whether it
  pushed) — never gh's login, a GitHub credential or anything gh or git printed", citing the
  same leg (`heldToGitHub`'s trace half).
- `README.md`: the intent road's paragraph quotes the closing lines of a pull request, as
  6.2.2's does for `--from`; the first screen, held byte for byte by its test, does not move.
- `AGENTS.md`: exit `1` gains "a service whose `.idp-agent.yml` names another repository than
  the one a submission goes to"; the state line says `plan "<intent>" --submit` opens a pull
  request; the test count, re-measured from this pull request's `pnpm test`, and the README's
  badge with it. The architecture rule count stays 29.
- `src/cli/README.md`, *Submitting*: the intent road's order.

**Exhaustive switches:** none new. `refuseOtherRepository` reads `road.kind` with one `if`; the
switches on `Road`, `SubmissionReport` and `PreviewStatus` are 6.2.2's and gain no member.

**Architecture rules:** none added; `pnpm vitest run tests/architecture --reporter=verbose`
still lists 29. `cli/` still names `GhProcess` by `import type` only, and reaches the launchers
through `forge/open.ts` alone.

- [ ] **Step 9: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/github-remote.test.ts tests/unit/plan-intent.test.ts tests/contract/key-reach.test.ts tests/unit/plan-command.test.ts tests/unit/submit-github.test.ts
pnpm vitest run tests/scenarios
pnpm vitest run tests/architecture --reporter=verbose
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git status --short tests/recordings tests/golden fixtures/si-demo
```

Expected: all green; `tests/scenarios/prompt-digests.test.ts` unchanged and green; 29
architecture rules; the last command prints nothing.

- [ ] **Step 10: The pull request** (after the owner's go-ahead)

```bash
git add src/core/github/remote.ts src/forge/open.ts src/cli/commands/submit.ts src/cli/commands/plan.ts src/cli/index.ts \
  src/core/schemas/config.ts src/cli/README.md \
  tests/unit/github-remote.test.ts tests/unit/plan-intent.test.ts tests/unit/submit-github.test.ts tests/contract/key-reach.test.ts \
  tests/support/github-fixture.ts scripts/demo-github.mjs \
  docs/submitting.md docs/design.md SECURITY.md README.md AGENTS.md CHANGELOG.md docs/roadmap.md \
  docs/reviews/2026-09-23-deep-review.md docs/plans/stage-6-github.md
git commit -m "feat(cli): open a pull request from a drafted plan, and hold iacRepo to the clone it submits from"
```

Branch `feat/s6-intent-github`, base `feat/s6-plan-from-github`. CHANGELOG, `### Added`:

> - `plan "<intent>" --submit` opens a GitHub pull request as `plan --from` does: the road,
>   gh's identity and the base's rules are read before any model is called, and the rules
>   again after the Reviewer, at the moment of acting; a service whose `.idp-agent.yml` names
>   another declarations repository than the one the clone's branch tracks is refused, naming
>   both — `iacRepo`'s first reader, a cross-check and never a source
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** on a clone tracking github.com, `plan "<intent>" --submit`
opens a pull request where 6.2.2 refused with exit 2, and prints `--from`'s lines; a new exit-1
line for a service pointed at the wrong clone. The local roads, a preview without `--submit`
and every tape are unchanged.

**What the owner can run.** Offline, from the worktree, after `pnpm build`:

```bash
pnpm vitest run tests/unit/plan-intent.test.ts tests/unit/github-remote.test.ts tests/contract/key-reach.test.ts
pnpm vitest run tests/scenarios
pnpm demo:github
```

Attendu :
- the three files pass, the new `describe`s among them; `tests/scenarios` passes with no key;
- `pnpm demo:github` prints 6.1.3's and 6.2.2's steps, then the two new ones: *the intent road
  refuses a gh that is not logged in before any model* (exit 2, the sentence ending "or add
  --local to cut the branch in this clone only. Nothing was written."), and *the intent road
  reads the road and gh's identity before the model's configuration* (exit 2, the `submitting
  to github.com/acme/iac, into main (origin, main's upstream), as … (gh)` line, then `no model
  configured: …`); it ends without a failed step.

With the owner's gh and key, against `~/idpa-live` (6.2.2's clone, its ruleset in place), from
the worktree's root: the package is not on npm, so a bare `idpa` is whichever clone last ran
`pnpm link --global` — usually the main checkout, which ends every road of this task on the
interim exit 2 — and these blocks run this branch's build by its path instead. The first line is
the only one to edit:

```bash
OWNER=your-login
pnpm build
BIN="$PWD/dist/cli/bin.js"
git -C ~/idpa-live pull --ff-only
mkdir -p ~/idpa-live-app
printf '{ "name": "reporting-worker" }\n' > ~/idpa-live-app/package.json
printf 'iacRepo: github.com/%s/idpa-live\nenvironments: [dev, prod]\n' "$OWNER" > ~/idpa-live-app/.idp-agent.yml
cd ~/idpa-live-app
node "$BIN" plan "open the network flow reporting-worker-to-payments from component:default/reporting-worker to resource:default/payments-api, owned by group:default/common" --repo ~/idpa-live --submit; echo "exit $?"
```

Attendu :
- stderr: `submitting to github.com/<your login>/idpa-live, into main (origin, main's upstream),
  as <your login> (gh)`, a line saying how `~/idpa-live-app`'s files were read (it is
  a folder, not a git repository, so it is walked), then the agents' progress lines;
- the diff creating `dependencies/network/reporting-worker-to-payments.yml`, then `Push
  idp-agent/reporting-worker-to-payments-<8 hex> to github.com/<your login>/idpa-live with your
  git, and open a pull request into main with your gh? … [y/N]` — answer `y` (any question the
  model left open is asked before it; answer it);
- `1 file · submitted as idp-agent/reporting-worker-to-payments-<8 hex> on top of main@<7 hex> ·
  main untouched`, `Pull request #<n> opened on github.com/<your login>/idpa-live:
  https://github.com/<your login>/idpa-live/pull/<n>`, the line saying merging waits for one
  approval, then `Nothing is provisioned yet. The merge is what authorises it.`; `exit 0`;
- on GitHub, the pull request's page says merging is blocked until an approval.

Then the cross-check, from a service whose file names another repository, in the same shell
(`BIN` is still the worktree's build):

```bash
mkdir -p ~/idpa-live-other
printf '{ "name": "reporting-worker" }\n' > ~/idpa-live-other/package.json
printf 'iacRepo: github.com/%s/not-idpa-live\nenvironments: [dev, prod]\n' "$OWNER" > ~/idpa-live-other/.idp-agent.yml
cd ~/idpa-live-other
node "$BIN" plan "open the network flow reporting-worker-to-payments from component:default/reporting-worker to resource:default/payments-api, owned by group:default/common" --repo ~/idpa-live --submit; echo "exit $?"
```

Attendu :
- the `submitting to …` line on stderr, then one line on stdout: `not submitted —
  .idp-agent.yml in /Users/…/idpa-live-other names github.com/<your login>/not-idpa-live as
  this service's declarations repository, and /Users/…/idpa-live's main tracks
  github.com/<your login>/idpa-live: run this with --repo naming a clone of the repository it
  names, or change iacRepo in a reviewed change. Nothing was written.`; `exit 1`;
- no agent line and no line counting model calls on stderr: no model was called.

---

### Task 6.3.2: `init --submit` to GitHub

**Goal.** `init --submit` in a service repository whose checked-out branch tracks a branch on
github.com cuts stage 5's branch in the service's own clone, pushes it and opens a pull request
on the service's repository, once that repository passes the same configuration check and the
same preflight as the declarations repository (decision 17). `init`'s branch holds the
catalog-info and, when a person typed or answered it, `.idp-agent.yml` — the file whose
`iacRepo` names *another* repository, the declarations one, so no cross-check applies here. D6
(a plan writing into both repositories) and D12 (a service in a subfolder of its repository)
stay refused by name, on the GitHub road too. Scripted clients only.

**Where this task starts.** 6.2.2 left, in `main`'s `init` branch and in `runInitRepo`'s own
call (`init.ts:819` on `2b2250e`): `openForSubmission(project, 'service', { local, env, gh,
notice, route: 'init', … })` before the configuration, and `openSubmissionForge`'s interim exit 2
of a `GitHubRoad`, `NOT_YET.init` (the `init` counterpart of the intent road's sentence); the
local roads of `init` already carry their closing line. 6.3.1 left `refuseUnprotected` judged once per forge and base,
and the forge's attributes on every result of `submit.ts`.

**Files:**
- Modify: `src/forge/open.ts` (`'init'` added to `OPENS_PULL_REQUESTS`, `NOT_YET.init` removed)
- Modify: `src/cli/index.ts` (`HELP`'s `init` paragraph)
- Modify: `src/cli/commands/init.ts` (`runInitRepo`: the preflight after `refuseDivergence`)
- Modify: `src/cli/commands/submit.ts` (`refuseUnprotected`'s `offerLocal`),
  `src/cli/render/protection.ts` (`renderUnprotected`'s last line with `offerLocal`, decision
  17), `tests/unit/protection-command.test.ts` (that line pinned)
- Modify: `src/forge/local/forge.ts` (D12's sentence: "is not submitted at stage 5" becomes "is
  not submitted by this build")
- Modify: `tests/unit/init-command.test.ts` (a `describe('init --submit to GitHub')`; the two
  D12 expectations, `:727` and `:1032` on `2b2250e`; 6.2.2's *refuses init --submit toward GitHub
  until its road lands, before any model and before gh* deleted), `tests/unit/submit-github.test.ts`
  (the `init` half of 6.2.2's interim-refusal test removed, with nothing left of it; the D6 case
  below),
  `tests/contract/key-reach.test.ts` (the `init` leg), `tests/support/github-fixture.ts`
  (`githubClone`'s `repository` option, when absent)
- Modify: `scripts/demo-github.mjs` (a service clone, and two steps)
- Modify: `docs/submitting.md` (*A service's own repository: `init --submit`*), `SECURITY.md`
  (the `init --submit` row: the GitHub road, its tests), `README.md` (the `init` paragraph:
  "a service in a subfolder of its repository is not submitted yet" stays, the pull request is
  added), `src/cli/README.md`, `AGENTS.md` (the state line, the test count), `CHANGELOG.md`,
  `docs/roadmap.md`

**Interfaces:**
- Consumes: everything 6.3.1 consumes; `runInitRepo`, `InitOptions`, `concluded` (stage 5);
  `githubClone({ source, repository })`, `unprotect`, `moveGitHubBase` (6.3.1's *Names this task
  adds*).
- Produces: the `init` road opening pull requests (`route: 'init'`, which 6.2.2 already passes);
  D12's sentence reworded. No new export.

`runInitRepo`'s order becomes (D12 and the owner's order of 2026-09-29, one step added): the
forge — and, from `main`, the road and gh — the configuration's questions, the project's files,
init's own verdicts on them, the divergence, **the preflight**, and only then the Inspector.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/init-command.test.ts`, importing `githubClone`, `unprotect` and
`moveGitHubBase` from `../support/github-fixture.js`, `type GhProcess` from
`../../src/process/gh.js`, and `observable`, `git` from `../support/git.js`:

```typescript
describe('init --submit to GitHub', () => {
  const FLAGS = ['--iac-repo', 'github.com/acme/iac', '--environment', 'dev', '--environment', 'prod']
  const made: string[] = []
  afterAll(async () => {
    await removeClones()
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** A service committed on main, its remote git@github.com:acme/billing-api.git, level with GitHub. */
  const service = async () => {
    const source = await application()
    made.push(source)
    return githubClone({ source, repository: 'acme/billing-api' })
  }

  const run = async (
    clone: Awaited<ReturnType<typeof githubClone>>,
    args: string[],
    deps: Parameters<typeof main>[1] = {},
  ) => {
    const io = capture()
    const code = await main(['init', '--repo', clone.repo, '--submit', ...FLAGS, ...args], {
      cwd: clone.repo,
      env: clone.env,
      gh: clone.gh.process,
      ...deps,
      out: (chunk) => void io.out.push(chunk),
      err: (chunk) => void io.err.push(chunk),
    })
    return { code, out: io.out.join(''), err: io.err.join('') }
  }

  const ours = async (dir: string): Promise<string[]> =>
    (await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/')).split('\n').filter((line) => line !== '')

  it('opens a pull request on the service’s own repository, holding the catalog-info and the configuration', async () => {
    const clone = await service()

    const { code, out, err } = await run(clone, [], { client: drafting([COMPONENT]) })

    expect(code, err).toBe(0)
    expect(err).toMatch(/^submitting to github\.com\/acme\/billing-api, into main \(origin, main's upstream\), as [A-Za-z0-9-]+ \(gh\)$/m)
    expect(out).toMatch(/^2 files · submitted as idp-agent\/init-billing-api-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched$/m)
    expect(out).toContain('Pull request #1 opened on github.com/acme/billing-api: https://github.com/acme/billing-api/pull/1')
    const [ref] = await ours(clone.bare)
    expect(await git(clone.bare, 'diff', '--name-only', 'main', ref ?? '')).toBe(`${CONFIG_FILE}\ncatalog-info.yaml`)
  })

  it('holds no iacRepo to the repository it submits to: the service names the declarations repository, which is another', async () => {
    // § 13's cross-check is the intent road's: there, the clone IS the repository iacRepo
    // names. Here the branch goes to the service, and iacRepo names somewhere else by design.
    const clone = await service()
    const { code } = await run(clone, [], { client: drafting([COMPONENT]) })
    expect(code).toBe(0)
  })

  it('names the open pull request on a second run, not asked, and writes nothing', async () => {
    const clone = await service()
    await run(clone, [], { client: drafting([COMPONENT]) })
    const before = await observable(clone.repo)
    let asked = 0

    const { code, out } = await run(clone, [], {
      client: drafting([COMPONENT]),
      confirm: async () => {
        asked += 1
        return true
      },
    })

    expect(code).toBe(0)
    expect(out).toMatch(/2 files · already submitted as idp-agent\/init-billing-api-[0-9a-f]{8} · pull request #1 is open · nothing written/)
    expect(asked).toBe(0)
    expect(await observable(clone.repo)).toBe(before)
  })

  it('refuses a service repository whose rules let the opener merge, exit 1, before the Inspector, naming --local', async () => {
    const clone = await service()
    await unprotect(clone.gh)
    const client = drafting([COMPONENT])

    const { code, out } = await run(clone, [], { client })

    expect(code).toBe(1)
    expect(out).toContain(
      "not submitted — nothing on github.com/acme/billing-api's main stops the person who would open this pull request from merging it:",
    )
    expect(out).toContain('Then run this again, or add --local to cut the branch in this clone only. Nothing was written.')
    expect(client.seen).toEqual([])
    expect(await ours(clone.repo)).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a service clone that is not level with GitHub, exit 1, before the Inspector', async () => {
    const clone = await service()
    await moveGitHubBase(clone)
    const client = drafting([COMPONENT])
    const { code, out } = await run(clone, [], { client })
    expect(code).toBe(1)
    expect(out).toContain('bring them level (git pull)')
    expect(client.seen).toEqual([])
  })

  it('refuses gh logged out, exit 2, before the model is configured, and --local cuts the branch in the clone only', async () => {
    const clone = await service()
    clone.gh.logout()

    const refused = await run(clone, [])
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('gh is not logged in to github.com')
    expect(refused.err).not.toContain('no model configured')

    const local = await run(clone, ['--local'], { client: drafting([COMPONENT]) })
    expect(local.code).toBe(0)
    expect(local.out).toContain('--local: nothing pushed by this run')
    expect(await ours(clone.repo)).toHaveLength(1)
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a key of the service clone’s own configuration, exit 2, naming it and its scope, never its value', async () => {
    const clone = await service()
    await git(clone.repo, 'config', 'url.ssh://mirror.canary.example/.insteadOf', 'git@github.com:')
    const client = drafting([COMPONENT])

    const { code, err } = await run(clone, [], { client })

    expect(code).toBe(2)
    expect(err).toContain('url.ssh://mirror.canary.example/.insteadof (local), which would decide where your push goes')
    expect(client.seen).toEqual([])
  })

  it('refuses when the rules go while the Architect drafts, at the moment of acting, and writes nothing on either side', async () => {
    const clone = await service()
    const inner = drafting([COMPONENT])
    const client: LlmClient = {
      generate: async (request) => {
        if (request.agent === 'architect') await unprotect(clone.gh)
        return inner.generate(request)
      },
    }

    const { code } = await run(clone, [], { client })

    expect(code).toBe(1)
    expect(await ours(clone.repo)).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('asks the question of § 3, naming the service’s repository', async () => {
    const clone = await service()
    const summaries: SubmissionSummary[] = []
    await run(clone, [], {
      client: drafting([COMPONENT]),
      confirm: async (summary) => {
        summaries.push(summary)
        return false
      },
    })
    expect(summaries[0]?.github).toStrictEqual({ host: 'github.com', repository: 'acme/billing-api', base: 'main', pushedAlready: false })
  })

  it('still refuses a service in a subfolder of its repository (D12), exit 2, before gh is started', async () => {
    const root = await application()
    made.push(root)
    await mkdir(path.join(root, 'services', 'billing'), { recursive: true })
    await writeFile(path.join(root, 'services', 'billing', 'package.json'), '{ "name": "billing-api" }\n')
    const clone = await githubClone({ source: root, repository: 'acme/billing-api' })
    const calls: string[] = []
    const gh: GhProcess = async (argv, options) => {
      calls.push(argv.join(' '))
      return clone.gh.process(argv, options)
    }

    const io = capture()
    const code = await main(['init', '--repo', path.join(clone.repo, 'services', 'billing'), '--submit', ...FLAGS], {
      env: clone.env,
      gh,
      out: (chunk) => void io.out.push(chunk),
      err: (chunk) => void io.err.push(chunk),
    })

    expect(code).toBe(2)
    expect(io.err.join('')).toContain('a service in a subfolder of its repository is not submitted by this build')
    expect(calls).toEqual([])
  })
})
```

And one test of D6 on the GitHub road, in `tests/unit/submit-github.test.ts` (6.2.2's file):
*refuses a plan writing into both repositories by name on a GitHub road, pointing at init
--submit, and pushes nothing (D6)* — the same plan file `plan-command.test.ts`'s D6 case uses,
`plan --from … --submit` on a `githubClone()`: exit 1, the D6 sentence, no `idp-agent/` ref in
either repository, no gh call holding `POST`.

In `tests/contract/key-reach.test.ts`, in 6.3.1's `describe.each`, the `init` leg: the service
is `githubClone({ source: <the key-reach application repository>, repository:
'acme/orders-api' })`, the argument vector `['init', '--repo', clone.repo, '--submit',
'--iac-repo', 'github.com/acme/iac', '--environment', 'prod', '--name', 'orders-api',
'--lifecycle', 'production', '--owner', 'group:default/tiger']`, the model's replies those of
the first block's `answering` with the operations `[{ op: 'create-entity', entity: { kind:
'Component', metadata: { name: 'orders-api' }, spec: { type: 'service', lifecycle:
'production', owner: 'group:default/tiger' } } }]`; `expect(ran.code, ran.err).toBe(0)`,
`Pull request #1 opened on github.com/acme/orders-api`, then `heldToGitHub(ran, 'acme/orders-api')`. The flags
answer every field the key-reach `FACTS` leave open (its forge handle is unknown), so nothing
is asked of a run with no terminal: the leg is about where the key and the canary go, and must
end on exit 0 to be about anything.

*Why they fail, before the code:* every GitHub-road case exits 2 on 6.2.2's interim refusal of
`init`, so no pull request, no preflight (the unprotected and not-level cases expect exit 1),
no second run to recognise; the D12 case fails on the sentence (`at stage 5`). *refuses gh
logged out* fails too, on the interim message (`openSubmissionForge` refuses the road before gh
starts), though its `--local` half passes. One passes before the code and is kept as a guard:
*refuses a key of the service clone's own configuration* (6.1.2's check, which `readRoad` makes
before the interim refusal is reached). The D6 case passes before the code too: D6 is `clearPlan`'s, and
this task changes nothing of it; it is added here because its sentence points at `init
--submit`, which this task makes reach GitHub.

- [ ] **Step 2: Run them to verify they fail**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/init-command.test.ts tests/unit/submit-github.test.ts tests/contract/key-reach.test.ts
```

Expected: FAIL — the GitHub-road cases on the interim exit 2; the D12 case on its sentence.

- [ ] **Step 3: `runInitRepo`**

After `const refused = await refuseDivergence(opened, { files, scope: 'touched' })` and its
return (`init.ts:910-911` on `2b2250e`), inside the same `if (opened !== undefined)`:

```typescript
    // § 8 on the service's own repository (decision 17): the same rules the declarations
    // repository must hold, read before the Inspector is paid for a branch they would refuse,
    // and refused "with --local named", which the declarations roads do not offer.
    const unprotected = await refuseUnprotected(opened, { offerLocal: true })
    if (unprotected !== undefined) return unprotected
```

`init` has no `--json`, so the refusal is always prose. `offerLocal` (added to
`refuseUnprotected`'s options and handed to `renderUnprotected(verdict, road, { offerLocal })`,
in `cli/render/protection.ts`) changes the block's last line only, from `Then run this again.
Nothing was written.` to `Then run this again, or add --local to cut the branch in this clone
only. Nothing was written.` (decision 17); `tests/unit/protection-command.test.ts`, where 6.1.3
unit-tests `renderUnprotected`, gains the `offerLocal` case and keeps the declarations roads'
block byte for byte as 6.1.3 left it. Nothing else in `runInitRepo` moves:
`concluded` hands the clearance to `submit()`, which recognises through gh, confirms and calls
`forge.submit` — the re-check at step 8, the push, the read-back, the rules again, the pull
request.

- [ ] **Step 4: `main`**

In `src/forge/open.ts`: `'init'` joins `OPENS_PULL_REQUESTS` and `NOT_YET.init` goes, with its
sentence. In the `init` branch (`index.ts:1167-1185` on `2b2250e`, as 6.2.2 left it) nothing of
the call moves: it already passes `route: 'init'` and the `notice` that prints the GitHub road's
stderr line as `--from` does. `HELP`'s `init` paragraph: "With --submit, both go on one branch
idp-agent/… cut from HEAD in the service's repository, which must be a git clone's root, and,
where its branch tracks one on github.com, a pull request is opened there; a service in a
subfolder of its repository is not submitted yet."

- [ ] **Step 5: D12's sentence**

`src/forge/local/forge.ts:94`: `'a service in a subfolder of its repository is not submitted by
this build — init without --submit previews it'`. D12 is unchanged; only the stage it named is
no longer the last one. The two expectations in `init-command.test.ts` follow.

- [ ] **Step 6: The demo**

`scripts/demo-github.mjs` builds a second clone, a service (a `package.json` and `CODEOWNERS`
committed on `main`), its remote `git@github.com:acme/billing-api.git`, its own bare
repository, and the fake's model holding that repository with 6.1.3's protected ruleset. Two
steps, with the binary's environment holding no provider key, as 6.3.1's:

1. *`init --submit` refuses a gh that is not logged in before any model*: exit 2, naming
   `--local`.
2. *`init --submit` reads the road and gh's identity before the model's configuration*: exit 2,
   `submitting to github.com/acme/billing-api, into main (origin, main's upstream), as … (gh)`,
   then `no model configured: …`.

- [ ] **Step 7: Traceability and the documents**

- `CHANGELOG.md`, Unreleased → Added (below).
- `docs/roadmap.md`: the stage 6 row names 6.3.2; decision 17 recorded as built.
- `docs/submitting.md`: *A service's own repository* — the same ruleset on the service's
  repository, the two files the branch holds, why `iacRepo` names another repository there,
  D12.
- `SECURITY.md`: the `init --submit` row (`:175` on `2b2250e`) gains the GitHub road and names
  *init --submit to GitHub*'s tests; the D12 test's title in it follows the rename.
- `README.md`, `src/cli/README.md`, `AGENTS.md` (the state line; the test count and the badge).

**Exhaustive switches:** none new.

**Architecture rules:** none added; 29.

- [ ] **Step 8: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/init-command.test.ts tests/unit/protection-command.test.ts tests/unit/submit-github.test.ts tests/unit/local-forge.test.ts tests/contract/key-reach.test.ts
pnpm vitest run tests/scenarios
pnpm vitest run tests/architecture --reporter=verbose
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git status --short tests/recordings tests/golden fixtures/si-demo
```

- [ ] **Step 9: The pull request** (after the owner's go-ahead)

```bash
git add src/forge/open.ts src/cli/index.ts src/cli/commands/init.ts src/cli/commands/submit.ts src/cli/render/protection.ts src/forge/local/forge.ts src/cli/README.md \
  tests/unit/init-command.test.ts tests/unit/protection-command.test.ts tests/unit/submit-github.test.ts tests/contract/key-reach.test.ts \
  tests/support/github-fixture.ts scripts/demo-github.mjs \
  docs/submitting.md SECURITY.md README.md AGENTS.md CHANGELOG.md docs/roadmap.md docs/plans/stage-6-github.md
git commit -m "feat(cli): open a pull request on the service's own repository from init --submit"
```

Branch `feat/s6-init-github`, base `feat/s6-intent-github`. CHANGELOG, `### Added`:

> - `init --submit` opens a pull request on the service's own GitHub repository, holding the
>   catalog-info and `.idp-agent.yml`, once that repository passes the same configuration check
>   and the same ruleset check as the declarations repository; a service in a subfolder of its
>   repository, and a plan writing into both repositories, are still refused by name
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** on a service clone tracking github.com, `init --submit`
opens a pull request where 6.2.2 refused with exit 2; D12's refusal says "by this build" where
it said "at stage 5". Everything else of `init` is unchanged.

**What the owner can run.** Offline, after `pnpm build`:

```bash
pnpm vitest run tests/unit/init-command.test.ts tests/contract/key-reach.test.ts
pnpm demo:github
```

Attendu :
- both files pass;
- `pnpm demo:github` adds the two `init` steps: exit 2 naming `--local` with the fake logged
  out; exit 2 with the `submitting to github.com/acme/billing-api, …` line, then `no model
  configured: …`, with it logged in.

With the owner's gh and key: a throwaway service repository, first without its ruleset. From
the worktree's root, so `BIN` is this branch's build and not a linked `idpa` (6.3.1):

```bash
OWNER=your-login
pnpm build
BIN="$PWD/dist/cli/bin.js"
mkdir -p ~/idpa-live-service
printf '{ "name": "idpa-live-service" }\n' > ~/idpa-live-service/package.json
printf '* @%s\n' "$OWNER" > ~/idpa-live-service/CODEOWNERS
git -C ~/idpa-live-service init -q -b main
git -C ~/idpa-live-service add -A
git -C ~/idpa-live-service commit -qm "chore: a service to declare"
gh repo create "$OWNER/idpa-live-service" --public
git -C ~/idpa-live-service remote add origin "git@github.com:$OWNER/idpa-live-service.git"
git -C ~/idpa-live-service push -u origin main
node "$BIN" init --repo ~/idpa-live-service --submit --iac-repo "github.com/$OWNER/idpa-live" --environment dev --environment prod --name idpa-live-service --lifecycle experimental --owner group:default/tiger; echo "exit $?"
```

Attendu :
- stderr: `submitting to github.com/<your login>/idpa-live-service, into main (origin, main's
  upstream), as <your login> (gh)`;
- stdout: `not submitted — nothing on github.com/<your login>/idpa-live-service's main stops
  the person who would open this pull request from merging it:`, the `missing:` lines, `Add a
  ruleset on main (Settings → Rules → Rulesets):`, the settings, and `Then run this again, or add
  --local to cut the branch in this clone only. Nothing was written.`; `exit 1`; no agent line on
  stderr: the Inspector was not paid.

Then add the same ruleset as `idpa-live`'s on `idpa-live-service`'s `main`
(`docs/submitting.md`), and run the last line again, in the same shell:

```bash
node "$BIN" init --repo ~/idpa-live-service --submit --iac-repo "github.com/$OWNER/idpa-live" --environment dev --environment prod --name idpa-live-service --lifecycle experimental --owner group:default/tiger; echo "exit $?"
```

Attendu :
- the diff adding `catalog-info.yaml` and `.idp-agent.yml`, then `Push
  idp-agent/init-idpa-live-service-<8 hex> to github.com/<your login>/idpa-live-service with
  your git, and open a pull request into main with your gh? … [y/N]` — answer `y`;
- `2 files · submitted as idp-agent/init-idpa-live-service-<8 hex> on top of main@<7 hex> ·
  main untouched`, `Pull request #1 opened on github.com/<your login>/idpa-live-service:
  https://github.com/<your login>/idpa-live-service/pull/1`, the merging line, `Nothing is
  provisioned yet. The merge is what authorises it.`; `exit 0`;
- the pull request's page on GitHub says merging is blocked until an approval.

---

### Task 6.3.3: `idpa "<phrase>" --submit` (D8 lifted)

**Goal.** The one gesture submits (D8, decision 14): `idpa "<phrase>" --submit` opens the
forge, reads the road and gh's identity before the model's configuration, and the preflight
before the Supervisor, the first model call of this road; a phrase the Supervisor calls a
change is then previewed and submitted exactly as `plan "<intent>" --submit` does, through
`runIntent`, the `iacRepo` cross-check included; a phrase it calls a question is refused, exit
3, after its one word, and the Analyst is never called. `--local` works as on `plan`.
Scripted clients only; the Supervisor is sent the bytes it is sent without `--submit`.

**Where this task starts.** `parsePhrase` refuses `--submit` at parse time
(`index.ts:679-690` on `2b2250e`), and knows no `--local`. The phrase's change road calls
`runIntent` with no `submit` (`:1610-1628`). 6.3.1 left `refuseUnprotected` judged once per
forge and base.

**Files:**
- Modify: `src/cli/index.ts` (`Command`'s `entry` gains `submit?: true` and `local?: true`;
  `parsePhrase`: D8's refusal deleted, `--local`, `--submit` with `--demo` refused, `--local`
  without `--submit` refused; the phrase road: with `--submit`, the application root and the
  forge before the catalogue load, the stderr line after the source notice, the preflight
  before `runEntry`, `submit` handed to `runIntent`; `HELP` and the phrase's usage line)
- Modify: `src/forge/open.ts` (`'phrase'` joins the roads that open pull requests: every road
  now does, so `OPENS_PULL_REQUESTS` and `NOT_YET` are removed, with the check that read them)
- Modify: `src/cli/commands/entry.ts` (`submit?: boolean`; a question refused;
  `QUESTION_NOT_SUBMITTED`; the `--json` note not said when `--submit` refuses the question)
- Modify: `src/cli/commands/ask.ts` (`classified` takes the question road as an optional third
  argument)
- Modify: `tests/unit/entry.test.ts` (a `describe('idpa "<phrase>" --submit')`),
  `tests/unit/cli-args.test.ts` (the D8 test replaced; `--local`, `--demo`; `HELP: --submit`),
  `tests/contract/key-reach.test.ts` (the phrase leg)
- Modify: `scripts/demo-github.mjs` (two steps)
- Modify: `docs/design.md` (`:1127`, "`idpa "<phrase>"` does not submit at stage 5"),
  `docs/submitting.md` (*One phrase: `idpa "<phrase>" --submit`*), `SECURITY.md`, `README.md`,
  `src/cli/README.md`, `AGENTS.md` (exit `2` loses "or on `idpa "<phrase>"`", and exit `3`
  gains "a question put to `idpa "<phrase>" --submit`"; the trust boundary loses "and only `idpa "<phrase>"` still ends
  at the preview (D8)"; the commands block; the test count), `CHANGELOG.md`, `docs/roadmap.md`

**Interfaces:**
- Consumes: `openForSubmission`, `reopening`, `refuseUnprotected` (judged once per forge and
  base, 6.3.1), `refuseOtherRepository` (inside `runIntent`, 6.3.1), `planNeedsRepository`
  (`cli/source.ts`), `RepositoryArgumentError` (`cli/repository.ts`).
- Produces:

```typescript
// src/cli/commands/ask.ts
export async function classified(
  options: AskOptions,
  change: () => Promise<CommandResult>,
  /** The question road, when the caller has another answer for one than `ask`'s. Absent: `ask`'s. */
  question?: () => Promise<CommandResult>,
): Promise<CommandResult>

// src/cli/commands/entry.ts
/** A question put to `--submit`: refused after the Supervisor's one word, exit 3, as `ask` declines a change. */
export const QUESTION_NOT_SUBMITTED =
  'that is a question, and --submit submits a change: ask it again without --submit. ' +
  'Nothing was answered, and nothing was written.'

export async function runEntry(
  options: AskOptions & {
    readonly json: boolean
    readonly change: () => Promise<CommandResult>
    /** `--submit`: a question is refused rather than answered; a change is `change`'s to submit. */
    readonly submit?: boolean
  },
): Promise<CommandResult>
```

Parse-time refusals (exit 2, with the phrase's usage):
`idpa "<phrase>" --submit never writes to the demo SI; name the declarations repository with
--repo` for `--submit --demo`; for `--local` without `--submit`, the sentence 6.2.2 gives
`plan`'s, with `idpa "<phrase>"` in place of `plan`. Before any model, when `--submit` finds no
declarations repository: `planNeedsRepository(context, 'idpa "<phrase>" --submit')`, exit 2 —
today a phrase learns that only after the Supervisor's word; with `--submit` the person has
said it is a change.

**The order on this road with `--submit`**, and why each step sits where it does:

| # | Where | What | Refused with |
|---|---|---|---|
| 1 | `parsePhrase` | `--demo`, `--local` without `--submit` | exit 2 |
| 2 | `main`, after `declarationsFor` and **before the catalogue load** | no declarations repository; `applicationRoot` (`--project`); `openForSubmission(roots.repo, 'declarations', { local, env, gh, route: 'phrase' })` — the local forge, the road, the configuration keys, gh | exit 2 |
| 3 | `main` | the catalogue load, as today; the source notice; **then** the GitHub road's stderr line | as today |
| 4 | `agentBacked` | the model's configuration | exit 2 |
| 5 | the callback, before `runEntry` | `refuseUnprotected(opened, { json })` — the preflight | exit 1 |
| 6 | `runEntry` | the Supervisor's one word | — |
| 7a | QUESTION | `QUESTION_NOT_SUBMITTED`, the Analyst never called | exit 3 |
| 7b | MUTATION | `runIntent` with `submit`, through `reopening`: `refuseOtherRepository`, `refuseDivergence`, `refuseUnprotected` (read back, no gh call), the Inspector, the Architect, the gates, the Reviewer, `submit()` | as `plan "<intent>" --submit` |

Step 2 runs before the catalogue load only with `--submit`: every exit-2 check of a
submission is then made before anything is requested of a catalogue, as `declarationsFor`'s
already is, and a run without `--submit` keeps today's order of refusals byte for byte. The
roots computed there are the ones step 7b is handed; `applicationRoot` is not run twice. The
stderr line waits for the source notice so the terminal reads what is read, then where it
goes. Divergence stays `runIntent`'s (7b), after the Supervisor's one word: it needs the
catalogue's bytes, which `runIntent` reads, and moving that read ahead of the Supervisor would
make the phrase road a second copy of `runIntent`'s opening. What a divergent tree costs on
this road is one Supervisor turn, the price the change-without-repository refusal already pays
on `2b2250e`. The preflight (5) is not paid for twice: `runIntent`'s call at 7b is answered
from 6.3.1's verdict for the same forge and base.

A question refused at 7a is exit 3 because it is the mirror of a change put to `ask`, which is
exit 3: the request is understood, and this build will not submit a question (the owner's answer
of 2026-09-30). It is returned as `runAsk`'s refusal is, never thrown: `QUESTION_NOT_SUBMITTED` on
stderr and `{ text: '', found: false, unsupported: true }`, so the code is 3 in prose and in
`--json` alike, and the stdout of a `--json` run stays empty, a question having no JSON form
(`entry.ts`'s header). This task adds no exit 2 after a model call: with `--submit`, a change
with no repository, which a phrase learns after the Supervisor's word on `2b2250e`
(`index.ts:1610-1615`), is refused at step 2, before any model. Step 7 writes the code into
`AGENTS.md`'s exit-code paragraph, under `3`, and the tests below pin it.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/cli-args.test.ts`, the D8 test (`:160-175` on `2b2250e`) becomes:

```typescript
  it('is a flag of the phrase from stage 6, with --local beside it', () => {
    expect(parseArguments(['give billing-api read access to orders-db', '--submit'])).toMatchObject({
      name: 'entry',
      phrase: 'give billing-api read access to orders-db',
      submit: true,
    })
    expect(parseArguments(['give billing-api read access to orders-db', '--submit', '--local'])).toMatchObject({
      name: 'entry',
      submit: true,
      local: true,
    })
    expect(parseArguments(['give billing-api read access to orders-db'])).not.toHaveProperty('submit')
  })

  it('is refused on a phrase with --demo, and --local is refused without it', () => {
    expect(parseArguments(['give billing-api read access to orders-db', '--submit', '--demo'])).toStrictEqual({
      name: 'error',
      message: 'idpa "<phrase>" --submit never writes to the demo SI; name the declarations repository with --repo',
    })
    expect(parseArguments(['give billing-api read access to orders-db', '--local'])).toMatchObject({ name: 'error' })
  })
```

and `HELP: --submit` asserts `usageOf('entry')` holds `[--submit [--local]]`.

In `tests/unit/entry.test.ts`, importing `githubClone` and `unprotect` from
`../support/github-fixture.js`, `type FakeGitHub` from `../support/fake-gh.js`, `fakeBackstage`
from `../support/fake-backstage.js`, `type GhProcess` from `../../src/process/gh.js` and `QUESTION_NOT_SUBMITTED` from
`../../src/cli/commands/entry.js`:

```typescript
describe('idpa "<phrase>" --submit', () => {
  afterAll(removeClones)

  const watching = (fake: FakeGitHub, inner: LlmClient) => {
    const log: string[] = []
    const gh: GhProcess = async (argv, options) => {
      log.push(`gh ${argv.join(' ')}`)
      return fake.process(argv, options)
    }
    const client: LlmClient = {
      generate: async (request) => {
        log.push(`model ${request.agent}`)
        return inner.generate(request)
      },
    }
    return { log, gh, client }
  }

  it('submits a change as plan "<intent>" --submit does, the forge, gh and the rules read before the Supervisor', async () => {
    const clone = await githubClone()
    const project = await application()
    const { log, gh, client } = watching(clone.gh, changing())

    const { code, out, err } = await run([INTENT, '--repo', clone.repo, '--project', project, '--submit'], {
      env: clone.env,
      gh,
      client,
      ask: answering('read'),
    })

    expect(code, err).toBe(0)
    expect(err).toMatch(/^· mutation$/m)
    expect(out).toContain('Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1')
    const supervisor = log.indexOf('model supervisor')
    expect(log.slice(0, supervisor).some((line) => /rules\/branches\/main\b/.test(line))).toBe(true)
    // Read once before the Supervisor; step 8 and step 11 after the Reviewer; never a fourth.
    expect(log.filter((line) => /rules\/branches\/main\b/.test(line))).toHaveLength(3)
  })

  it.each([[[] as string[]], [['--json']]])('refuses a question after the Supervisor’s one word, exit 3 with %j: the Analyst is never called, nothing is written', async (flags) => {
    const clone = await githubClone()
    const client = scripted({ supervisor: [saying('QUESTION')], analyst: [turnCalling('answer', { outcome: 'nothing' })] })
    const before = await observable(clone.repo)

    const { code, out, err } = await run(['which databases are in prod?', '--repo', clone.repo, '--submit', ...flags], {
      env: clone.env,
      gh: clone.gh.process,
      client,
    })

    // The mirror of a change put to `ask`: understood, and not acted on, in prose and in --json alike.
    expect(code).toBe(3)
    expect(out).toBe('')
    expect(err).toContain(QUESTION_NOT_SUBMITTED)
    expect(err).not.toContain('--json applies to a change')
    expect(agentsOf(client)).toEqual(['supervisor'])
    expect(await observable(clone.repo)).toBe(before)
  })

  it('refuses unprotected rules before the Supervisor, exit 1', async () => {
    const clone = await githubClone()
    await unprotect(clone.gh)
    const client = changing()

    const { code, out } = await run([INTENT, '--repo', clone.repo, '--submit'], { env: clone.env, gh: clone.gh.process, client })

    expect(code).toBe(1)
    expect(out).toContain("not submitted — nothing on github.com/acme/iac's main stops the person")
    expect(client.seen).toEqual([])
  })

  it('refuses gh logged out before the model is configured and before a catalogue is requested, exit 2', async () => {
    const clone = await githubClone()
    clone.gh.logout()
    const catalogue = fakeBackstage({})

    const { code, err } = await run([INTENT, '--submit'], {
      env: { ...clone.env, IDP_REPO: clone.repo, IDP_BACKSTAGE_URL: 'http://127.0.0.1:7007/api/catalog' },
      gh: clone.gh.process,
      catalogueFetch: catalogue.fetch,
      cwd: await temp(),
    })

    expect(code).toBe(2)
    expect(err).toContain('gh is not logged in to github.com')
    expect(err).not.toContain('no model configured')
    expect(catalogue.sent).toEqual([])
  })

  it('refuses --submit with no declarations repository anywhere, before any model, naming every way to name one', async () => {
    const client = changing()
    const { code, err } = await run([INTENT, '--submit'], { client, env: {}, cwd: await temp() })
    expect(code).toBe(2)
    expect(err).toContain('idpa "<phrase>" --submit needs a declarations repository')
    expect(client.seen).toEqual([])
  })

  it('cuts only the local branch with --local, and starts no gh', async () => {
    const clone = await githubClone()
    const { log, gh, client } = watching(clone.gh, changing())

    const { code, out } = await run([INTENT, '--repo', clone.repo, '--submit', '--local'], {
      env: clone.env,
      gh,
      client,
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(out).toContain('--local: nothing pushed by this run')
    expect(log.filter((line) => line.startsWith('gh '))).toEqual([])
  })

  it('refuses a service whose iacRepo names another repository, as plan "<intent>" does', async () => {
    const clone = await githubClone()
    const project = await application()
    await writeFile(path.join(project, '.idp-agent.yml'), 'iacRepo: github.com/acme/other-iac\nenvironments: [prod]\n', 'utf8')
    const client = changing()

    const { code, out } = await run([INTENT, '--repo', clone.repo, '--project', project, '--submit'], {
      env: clone.env,
      gh: clone.gh.process,
      client,
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(out).toContain('names github.com/acme/other-iac as this service')
    expect(agentsOf(client)).toEqual(['supervisor'])
  })

  it('sends the Supervisor, and every agent after it, the bytes it sends without --submit', async () => {
    const clone = await githubClone()
    const project = await application()
    const previewing = changing()
    await run([INTENT, '--repo', clone.repo, '--project', project], { env: clone.env, client: previewing, ask: answering('read') })
    const submitting = changing()
    await run([INTENT, '--repo', clone.repo, '--project', project, '--submit'], {
      env: clone.env,
      gh: clone.gh.process,
      client: submitting,
      ask: answering('read'),
    })

    expect(JSON.stringify(submitting.seen)).toBe(JSON.stringify(previewing.seen))
    expect(JSON.stringify(submitting.seen)).not.toContain('github.com')
  })

  it('reports the pull request in --json on a change', async () => {
    const clone = await githubClone()
    const { code, out } = await run([INTENT, '--repo', clone.repo, '--submit', '--json'], {
      env: clone.env,
      gh: clone.gh.process,
      client: changing(),
      ask: answering('read'),
    })
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ submission: { outcome: 'created', pushed: true, pullRequest: { number: 1 } } })
  })
})
```

`removeClones` and `observable` come from `../support/forge-fixture.js` and `../support/git.js`;
`temp`, `run`, `scripted`, `saying`, `turnCalling`, `agentsOf`, `changing`, `application`,
`INTENT` and `answering` are the file's own (`entry.test.ts:23-150` on `2b2250e`). The
`application()` of this file writes a marker file beside `package.json`, so the inspected
project differs between runs only by its temporary path, which no agent is sent.

In `tests/contract/key-reach.test.ts`, 6.3.1's `describe.each` gains the phrase leg:
`submittingRun([example.intent, '--project', project, '--submit'], 'MUTATION',
example.operations)`, `expect(ran.code, ran.err).toBe(0)`, the pull request's line, and
`heldToGitHub(ran, 'acme/iac')` — the Supervisor's request among the provider requests that hold
no `github.com`, no login and no canary.

*Why they fail, before the code:* `parsePhrase` refuses `--submit` (D8), so every
`idpa "<phrase>" --submit` run exits 2 on the sentence `idpa "<phrase>" does not submit; …`,
and `--local` is an unknown option there; `QUESTION_NOT_SUBMITTED` is not exported; the
catalogue case exits 2 on D8 too, for the wrong reason (the assertion on gh's sentence fails);
the new `cli-args` tests read the D8 error where they expect an `entry` command.

- [ ] **Step 2: Run them to verify they fail**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/cli-args.test.ts tests/unit/entry.test.ts tests/contract/key-reach.test.ts
```

Expected: FAIL — D8's refusal, the missing export, the unknown `--local`.

- [ ] **Step 3: The parser**

In `parsePhrase`, `local: { type: 'boolean' }` beside `submit`; the D8 block (`:679-690`) and
its comment become:

```typescript
    // A phrase submits from stage 6 (D8 lifted, decision 14): the forge, gh and the base's
    // rules are read before the Supervisor, so a repository that cannot take the branch is
    // refused before any model is paid. The demo SI is never written.
    if (values.submit === true && values.demo === true) {
      return {
        name: 'error',
        message: 'idpa "<phrase>" --submit never writes to the demo SI; name the declarations repository with --repo',
      }
    }
    if (values.local === true && values.submit !== true) {
      return { name: 'error', message: /* 6.2.2's `--local` sentence, naming idpa "<phrase>" */ }
    }
```

and the returned command gains `...(values.submit === true ? { submit: true as const } : {})`
and the same for `local`. `Command`'s `entry` member gains both, omitted when absent, as
`plan`'s are.

- [ ] **Step 4: `classified` and `runEntry`**

`classified`'s `QUESTION` case becomes `return question === undefined ? answered(…) :
question()`; its `switch` keeps `const exhaustive: never` in `default`. `runEntry`:

```typescript
  const refusing = options.submit === true
  const emit: EventSink =
    options.json && !refusing
      ? /* today's wrapper, saying --json does nothing on a question */
      : options.emit
  return classified(
    { ...options, emit },
    options.change,
    refusing
      ? async () => {
          // Understood, and declined: --submit submits a change. The mirror of `runAsk`'s
          // refusal of a change, exit 3 in prose and in --json alike.
          options.err(`${QUESTION_NOT_SUBMITTED}\n`)
          return { text: '', found: false, unsupported: true }
        }
      : undefined,
  )
```

`entry.ts`'s header comment gains the `--submit` paragraph: a change is submitted as `plan
"<intent>" --submit` submits one, a question is refused after the Supervisor's word, exit 3 as
`ask` declines a change, and the Supervisor is sent what it is sent without the flag.

- [ ] **Step 5: `main`'s phrase road**

Right after `declarationsFor` (`index.ts:1427-1436` on `2b2250e`), when
`command.name === 'entry' && command.submit === true`:

```typescript
    // --submit: everything a submission can refuse as an argument, before the catalogue
    // is requested and before the configuration — as `declarationsFor` already is. A person
    // who typed --submit has said the phrase is a change, so the repository it would be
    // decided against is required now rather than after the Supervisor's word.
    if (declarations === undefined) {
      return failed(new RepositoryArgumentError(planNeedsRepository(context, 'idpa "<phrase>" --submit')), err)
    }
    try {
      roots = await applicationRoot({ who: 'idpa', repo: declarations.root, project: command.project, cwd, home })
      early = await openForSubmission(roots.repo, 'declarations', {
        local: command.local === true,
        env: deps.env ?? process.env,
        ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
        route: 'phrase',
      })
    } catch (error) {
      return failed(error, err)
    }
```

`roots`, `early`, `cwd` and `home` are declared before the load (`cwd` and `home` as the
`entry` block defines them today, hoisted); the `applicationRoot` call of the existing
`entry` block (`:1568-1583`) is skipped when `roots` is already set, so it runs once. After the
source notice is written, the GitHub road's stderr line (6.2.2's code). In the `agentBacked`
callback, before `runEntry`:

```typescript
      async (client, emit) => {
        if (early !== undefined) {
          // § 12: the preflight before the Supervisor, the first model call of this road.
          // `runIntent` asks again, and is answered from this verdict (6.3.1).
          const unprotected = await refuseUnprotected(early, { json: command.json })
          if (unprotected !== undefined) return unprotected
        }
        return runEntry({
          ...asked,
          client,
          emit,
          json: command.json,
          ...(early !== undefined ? { submit: true } : {}),
          change: async () => { /* as today, and: */
            // ...(submit !== undefined ? { submit } : {}) handed to runIntent,
            // `submit` being { confirm, open: reopening(<early's OpenedForge>, roots.repo, 'declarations') }
          },
        })
      }
```

`confirm` is `confirmOf(deps, command.json)`, as on `plan`. `HELP`: the phrase's usage line
`idpa "<phrase>" [--repo <dir> | --demo | --backstage] [--project <dir>] [--json] [--quiet]
[--submit [--local]]`, and one sentence in the `--submit` paragraph: "A phrase takes --submit
too: a change is submitted as plan "<intent>" --submit submits it, and a question is refused."

- [ ] **Step 6: The demo**

`scripts/demo-github.mjs`, two steps on the demo SI clone, no provider key in the binary's
environment:

1. *A phrase refuses a gh that is not logged in before any model*: `"<the open-network
   intent>" --repo <clone> --submit`, the fake logged out: exit 2, naming `--local`.
2. *A phrase with --submit never writes to the demo SI*: `"<the open-network intent>" --submit
   --demo`: exit 2, the parse-time sentence and the phrase's usage.

- [ ] **Step 7: Traceability and the documents**

- `CHANGELOG.md`, Unreleased → Added (below).
- `docs/roadmap.md`: the stage 6 row names 6.3.3 and closes slice 6.3; decision 14 recorded as
  built; D8 among the stage-5 decisions stage 6 settled.
- `docs/design.md:1127`: "`idpa "<phrase>"` does not submit at stage 5" becomes "`idpa
  "<phrase>" --submit` submits a change as `plan "<intent>" --submit` does, the forge, gh and
  the base's rules read before the Supervisor; a question with `--submit` is refused (stage 6)."
- `docs/submitting.md`: *One phrase* — the order table above in prose, the question refusal.
- `SECURITY.md`: the GitHub-road rows name *idpa "<phrase>" --submit*'s tests and the key-reach
  phrase leg; the exit-2 list, if the page carries one, follows `AGENTS.md`.
- `AGENTS.md`: exit `2` — "`--submit` with `--demo` or on `idpa "<phrase>"`" becomes "`--submit`
  with `--demo`"; exit `3` — after "a change request put to `ask` (which names `idpa "<phrase>"` as
  the gesture that previews it)", "a question put to `idpa "<phrase>" --submit` (which names the
  same phrase without `--submit`)"; *The trust boundary* loses "and
  only `idpa "<phrase>"` still ends at the preview (D8)"; the commands block's `idpa
  "<phrase>"` line gains `[--submit [--local]]`; the state line; the test count and the badge.
- `README.md`, `src/cli/README.md`: the phrase submits.

**Exhaustive switches:** `classified`'s switch on the Supervisor's word keeps its `never`
default; nothing new is switched on.

**Architecture rules:** none added; 29. `entry.ts` imports nothing new: the refusal is a
returned `CommandResult`, as `runAsk`'s is.

- [ ] **Step 8: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/cli-args.test.ts tests/unit/entry.test.ts tests/unit/plan-intent.test.ts tests/contract/key-reach.test.ts tests/unit/backstage-read.test.ts
pnpm vitest run tests/scenarios
pnpm vitest run tests/architecture --reporter=verbose
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git status --short tests/recordings tests/golden fixtures/si-demo
```

`tests/unit/backstage-read.test.ts` is in the list because step 5 moves code around the
catalogue load: its order of refusals without `--submit` must not move.

- [ ] **Step 9: The pull request** (after the owner's go-ahead)

```bash
git add src/forge/open.ts src/cli/index.ts src/cli/commands/entry.ts src/cli/commands/ask.ts src/cli/README.md \
  tests/unit/cli-args.test.ts tests/unit/entry.test.ts tests/contract/key-reach.test.ts \
  scripts/demo-github.mjs docs/design.md docs/submitting.md SECURITY.md README.md AGENTS.md \
  CHANGELOG.md docs/roadmap.md docs/plans/stage-6-github.md
git commit -m "feat(cli): submit a change typed as one phrase, and refuse a question put to --submit"
```

Branch `feat/s6-phrase-submit`, base `feat/s6-init-github`. CHANGELOG, `### Added`:

> - `idpa "<phrase>" --submit`: a change typed as one phrase is submitted as `plan "<intent>"
>   --submit` submits it — the forge, gh and the base's rules read before the Supervisor, a
>   pull request opened on a clone tracking github.com, `--local` for the clone only — and a
>   question put to `--submit` is refused after the Supervisor's one word, exit 3 as `ask`
>   declines a change, nothing answered and nothing written (D8 lifted)
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** `idpa "<phrase>" --submit` no longer answers with D8's
refusal: a change is submitted, a question is refused, exit 3; `--submit --demo` and `--local`
without `--submit` are refused at parse time. Without `--submit`, the phrase road is
unchanged, its order of refusals included.

**What the owner can run.** Offline, after `pnpm build`:

```bash
pnpm vitest run tests/unit/entry.test.ts tests/unit/cli-args.test.ts tests/contract/key-reach.test.ts
pnpm demo:github
node dist/cli/bin.js "which databases are in prod?" --submit --demo; echo "exit $?"
```

Attendu :
- the three files pass;
- `pnpm demo:github` adds the two phrase steps (exit 2 naming `--local`; exit 2 on the demo SI);
- the last line prints `idpa "<phrase>" --submit never writes to the demo SI; name the
  declarations repository with --repo`, then the commands, and `exit 2`, with no model
  configured or called.

With the owner's gh and key, from 6.3.1's `~/idpa-live-app`, running this branch's build by its
path (6.3.1 says why not a bare `idpa`); `BIN` is set at the worktree's root, before the `cd`:

```bash
pnpm build
BIN="$PWD/dist/cli/bin.js"
cd ~/idpa-live-app
git -C ~/idpa-live pull --ff-only
node "$BIN" "open the network flow billing-api-to-sirene from component:default/billing-api to resource:default/sirene-api, owned by group:default/tiger" --repo ~/idpa-live --submit; echo "exit $?"
node "$BIN" "which databases are in prod?" --repo ~/idpa-live --submit; echo "exit $?"
```

Attendu :
- first line: stderr `submitting to github.com/<your login>/idpa-live, into main (origin,
  main's upstream), as <your login> (gh)`, then `· mutation` and the agents' lines; the
  diff creating `dependencies/network/billing-api-to-sirene.yml`; the question naming the push
  and the pull request — answer `y`; `1 file · submitted as
  idp-agent/billing-api-to-sirene-<8 hex> on top of main@<7 hex> · main untouched`, `Pull
  request #<n> opened on github.com/<your login>/idpa-live: …/pull/<n>`, the merging line,
  `Nothing is provisioned yet. The merge is what authorises it.`; `exit 0`;
- second line: the `submitting to …` line, `· question`, then `that is a question, and --submit
  submits a change: ask it again without --submit. Nothing was answered, and nothing was
  written.`; `exit 3`; one model call counted (the Supervisor's), no answer on stdout.

---

## Slice 6.4 — the live proof and the documents

Closed by 6.4.1, the owner's live test; 6.4.2 records the decision and every document it makes true; 6.4.3 is the owner's re-recording, in the same session as the live test.

### Task 6.4.1: The live test, its recorded answers, and the fake held to them

**Goal.** The note's § 10, live half, and the close of slice 6.4. The owner runs
`pnpm test:live:github` by hand, with their own gh session and a second account's, against the
public throwaway repository `"$OWNER/idpa-live"` (the demo SI, § 8's ruleset on `main`, bypass
list empty). It passes only when `idpa protection` passes there, a submission opens a pull
request, a second submission names it and writes nothing, **every door is refused to the
identity that opened it, `main`'s SHA read and unchanged after each**, and, with the second
account, an approval followed by the opener's push leaves the opener's merge refused. What
the run answers is written to `tests/contract/github/answers-<date>.json`, logins removed,
which the owner completes with three fields no read settles and commits; from then on
`tests/contract/github-answers.test.ts` holds the fake gh to it in `pnpm test`, offline, and
`GH_MINIMUM_VERSION` is the oldest gh a committed run was made with. CI never runs the live
test; nothing in `pnpm test` starts a real gh or reaches the network (Global Constraint 6).

Cites Global Constraints 1, 2, 5, 6, 8, 10, 11, 12, 13, 14 and 15.

**Order within the slice.** The live test and the re-recording of 6.4.3 are the owner's, in
one session (§ 16, 6.4.3), and both come before three of the implementer's steps. So:
the implementer writes 6.4.1's Steps 1 to 6 on `test/s6-live-github`, drafts 6.4.2 on
`docs/s6-adr-0015` with the measured values left as `<measured>`, and writes 6.4.3's Step 1
on `chore/s6-tapes`; none of the three is pushed. The owner's session runs 6.4.1's Step 7
and 6.4.3's Step 2. Then the implementer finishes 6.4.1 (Steps 8 to 11), rebases 6.4.2 on it
and writes the measured values in, and rebases 6.4.3 and finishes it. No agent ever runs
`pnpm test:live:github`, `gh`, `ssh`, or `IDP_RECORDING=record`: an agent that would need one
stops and hands the command to the owner.

**Files:**
- Create: `vitest.live.config.ts` (`include: ['tests/live/**/*.live.test.ts']`,
  `setupFiles: ['tests/live/setup.ts']` and nothing else, no `globalSetup`, one file at a
  time, `testTimeout` and `hookTimeout` of 180 s, § 15's submission bound)
- Create: `tests/live/guard.ts` (pure: the two variables, the repository's grammar, the
  environment the live run keeps) — **added to the shared names**, so the default suite can
  test the guard without importing a setup file whose import throws
- Create: `tests/live/setup.ts` (calls the guard at import: scrubs, then throws naming
  `IDP_GITHUB_LIVE_REPO` when it is unset or refused)
- Create: `tests/live/github/doors.ts` (`LIVE_DOORS`: every door step 4 and step 5 try, each
  with the `DOORS` name the fake knows it by) — **added to the shared names**
- Create: `tests/live/github/submit.live.test.ts`
- Create: `tests/support/github-answers.ts` (the answers file's type, `shapeOf`,
  `fakeWithin`, `scrubbed`, `identifying`, `TOKEN_SHAPE`, `answersFiles`) — **added to the
  shared names**, shared by the recorder and the contract test, and naming no door
- Create: `tests/unit/github-answers.test.ts` — **added to the shared names**
- Create: `tests/contract/github-answers.test.ts`
- Create: `tests/contract/github/answers-<date>.json` (written by the owner's run, Step 7)
- Modify: `tests/unit/live-config.test.ts` (6.1.1's: the live configuration pinned, the guard)
- Modify: `tests/support/github-fixture.ts` (`openedPullRequest()`: 6.2.1's route to pull
  request #1 through `openGitHubForge`, factored out of `tests/unit/merge-refused.test.ts` so
  the contract test reaches the same state) — **added to the shared names**
- Modify: `tests/support/fake-gh.ts` (`FAKE_GH_VERSION`; `DOORS` gains any door
  `LIVE_DOORS` marks modelled that it lacks), `tools/fake-gh.ts` (the version it prints; each
  status or shape the recorded answers contradict)
- Modify: `src/core/github/gh-version.ts` (`GH_MINIMUM_VERSION`), and every test that writes
  `2.40.0` as a literal (`git grep -n --untracked -e '2\.40\.0' -- src tests tools scripts`)
  reads the constant instead
- Modify: `package.json` (`"test:live:github": "vitest run --config vitest.live.config.ts"`)
- Modify: `docs/submitting.md` (the minimum gh; *Proving it on your repository: the live
  test*), `tests/README.md` (*The fake gh and the live test*), `AGENTS.md` (the commands
  block; the test count), `README.md` (the badge's count), `CHANGELOG.md`, `docs/roadmap.md`,
  `docs/plans/stage-6-github.md` (ticks)

**Interfaces:**

```typescript
// tests/live/guard.ts — node: built-ins and src/core/github/remote.ts only
export const LIVE_VARIABLES = ['IDP_GITHUB_LIVE_REPO', 'IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR'] as const
/** `<owner>/<name>`, the owner a GitHub login (isLogin), the name GitHub's grammar holding `idpa-live`. Throws naming the variable, never quoting its value. */
export function liveRepository(env: NodeJS.ProcessEnv): { owner: string; name: string }
/** The second account's gh configuration directory, absolute, or undefined when unset. Throws on a relative path. */
export function reviewerConfigDir(env: NodeJS.ProcessEnv): string | undefined
/** Removes every *_API_KEY and every IDP_* but LIVE_VARIABLES, whatever its case; touches nothing else. */
export function scrubLiveEnvironment(env: NodeJS.ProcessEnv): void

// tests/live/github/doors.ts — may name doors (the door rule's tests/live/ exception)
export interface LiveDoor {
  /** The DOORS name the fake answers this door under, or a name of its own when `modelled` is false. */
  readonly name: string
  readonly modelled: boolean
  readonly via: 'gh' | 'gh-api' | 'graphql' | 'git-push'
  readonly step: 'doors' | 'after-approval'
  argv(context: { owner: string; name: string; base: string; number: number; branch: string; head: string; baseSha: string; nodeId: string; stamp: string }): readonly string[]
}
export const LIVE_DOORS: readonly LiveDoor[]

// tests/support/github-answers.ts — names no door; node: built-ins only
/** A leaf is its type, `'<string>' | '<number>' | '<boolean>' | '<null>'`, or, under a KEPT_KEYS key, the value itself. */
export type Shape = string | number | boolean | null | readonly Shape[] | { readonly [key: string]: Shape }
export const KEPT_KEYS: readonly string[]   // type, current_user_can_bypass, enforcement, target, source_type, bypass_mode, actor_type, state, merged, draft, mergeable_state, archived, private, visibility, protected, admin, maintain, push, pull, triage, required_approving_review_count, require_last_push_approval, dismiss_stale_reviews_on_push, require_code_owner_review
export function shapeOf(value: unknown): Shape
/** Paths where `fake` says something `recorded` does not: a key GitHub did not send, another type, another kept value. Empty when the fake is within GitHub. */
export function fakeWithin(fake: Shape, recorded: Shape): string[]
/** Every occurrence of each name, case-insensitive, replaced by its placeholder. */
export function scrubbed(text: string, names: readonly { text: string; as: '<owner>' | '<reviewer>' }[]): string
/** Which of the given identifying texts, or a token's shape, the file still holds: kinds only, never the text. */
export function identifying(file: string, secrets: readonly { text: string; kind: string }[]): string[]
export const TOKEN_SHAPE: RegExp            // gh[pousr]_… and github_pat_…
export interface AnswersFile { /* below */ }
/** The committed answers files, oldest first; throws when there is none: a pattern with no match is a read error. */
export function answersFiles(): string[]
```

**The answers file.** One JSON object, written by the run whatever its outcome, never holding
a login, a name, an email, a token's shape or a body's text:

```json
{
  "version": 1,
  "recordedAt": "2026-10-02T09:14:03.000Z",
  "passed": true,
  "gh": { "version": "2.81.0", "date": "2025-10-01" },
  "git": { "version": "2.46.0" },
  "repository": "<owner>/idpa-live",
  "steps": { "protection": "passed", "baseRoutes": "passed", "submitted": "passed", "again": "passed", "doors": "passed", "afterApproval": "made", "cleanup": "passed" },
  "routes": [
    { "account": "owner", "route": "rules", "status": 200, "hasNext": false, "shape": [ { "type": "pull_request", "ruleset_id": "<number>", "parameters": { "required_approving_review_count": 1, "require_last_push_approval": true } } ] }
  ],
  "doors": [
    { "door": "merge-rest", "via": "gh-api", "step": "doors", "reachedGitHub": true, "exit": 1, "status": 405, "refused": true, "baseUnchanged": true, "remote": [] },
    { "door": "push-base", "via": "git-push", "step": "doors", "reachedGitHub": true, "exit": 1, "refused": true, "baseUnchanged": true, "remote": ["remote: error: GH013: Repository rule violations found for refs/heads/main."] }
  ],
  "readBack": { "reads": 1, "lagSeen": false },
  "include": { "nonSuccessParsed": true, "exitOnNonSuccess": 1 },
  "bypass": { "currentUserCanBypass": "never", "role": "admin", "bypassActors": [] },
  "mention": { "renderedAsCode": true },
  "tokenShapeInBody": false,
  "handFilled": { "actionsCanApprovePullRequests": null, "gitPushesAsGhAccount": null, "bypassListEmpty": null }
}
```

The values above are illustrative; every number, status and version is the run's. `routes`
holds one entry per route of § 6 the run read (`user`, `repository`, `branch`, `rules`,
`ruleset`, `ref`, `commit`, `pulls`, and `pull`, the single pull request the test reads
itself as a stand-in for the `POST`'s answer, which the CLI never shows it), as the owner and,
where the second account is set, as the reviewer (the missing permission: no `bypass_actors`
on a ruleset, `permissions.admin` false). `remote` holds the `remote:` lines of a refused
push, scrubbed. `bypassActors` is `[{ type, count }]` by actor type, or `"unreadable"`.

**What the live test does.** `beforeAll` sends nothing but reads and refuses to start, naming
the check and exiting 1, unless every one of these holds, in this order:

| # | Guard | Read |
|---|---|---|
| g1 | `IDP_GITHUB_LIVE_REPO` passes `liveRepository` | none (setup.ts, at import) |
| g2 | `dist/cli/bin.js` exists | none: "run pnpm build first" |
| g3 | gh is installed and at least `GH_MINIMUM_VERSION` | `version` |
| g4 | the owner's gh identity is a `User` | `user` |
| g5 | the repository answers under that name, is public (`private: false`), not archived, and `permissions.push` is true | `repository` |
| g6 | with the second account set: its identity is a `User`, another login than the owner's, with `permissions.push` | `user`, `repository`, in an environment whose `GH_CONFIG_DIR` is the second account's and **without `GH_TOKEN` and `GITHUB_TOKEN`**, which outrank `GH_CONFIG_DIR` in gh and would answer as the owner |
| g7 | the test's own clone, `git clone --quiet --branch <default_branch> git@github.com:<o>/<r>.git`, in a temporary directory the test removes | none but the clone |
| g8 | `node dist/cli/bin.js protection --repo <clone>` exits 0 | the built CLI's own reads |
| g9 | every ruleset supplying a rule of § 8 item 2 answers `current_user_can_bypass` `never` to the owner | `rules`, `ruleset` |

Every read goes through the real launcher, `ghIn({ env })` from `src/process/gh.ts` with
`spawnGh`, so the grammar and `parseIncluded` meet GitHub; `main`'s SHA is read (`ref` of the
base) and kept as `baseSha`. Then, one `it` per step, each skipped when an earlier one failed
(`context.skip()`, never vitest's `bail`, so `afterAll` always runs):

1. **A base whose name holds a slash.** The test's git pushes `baseSha` to
   `refs/heads/live/<stamp>/base` (`<stamp>` is the run's UTC time, `yyyymmddhhmmss`); the
   `ref` route is read for it at once, then 0.5 s and 1.5 s later until it answers 200 —
   `readBack.reads` and `lagSeen` —, then `branch` and `rules` for it: each must answer that
   branch (`ref` naming `refs/heads/live/<stamp>/base`, `branch` its `name`, `rules` a 200 with
   `hasNext` false), so the literal `/` between components of `encodeRefPath` is proved on
   GitHub.
2. **A submission.** `examples/open-network.json` with the name
   `orders-api-to-payments-<stamp>` in the entity and in the request, and the request ending
   `cc @<login>` (the second account's login when it is set, else the owner's), written to the
   temporary directory; `node dist/cli/bin.js plan --from <file> --repo <clone> --submit`, no
   terminal, so `--submit` is the answer. It must exit 0, its stderr must hold
   `submitting to github.com/<o>/<r>, into <base> (origin, <branch>'s upstream), as <owner> (gh)`,
   and its stdout `Pull request #<n> opened on github.com/<o>/<r>: https://github.com/<o>/<r>/pull/<n>`,
   whose `<n>` is read by one regular expression. Then through the launcher: `pulls` for the
   branch holds exactly pull request `<n>`, open; `ref` for `idp-agent/…` answers the local
   branch's commit (`git -C <clone> rev-parse`); `commit` for it answers one parent,
   `baseSha`. The test's own `gh api -H 'Accept: application/vnd.github.full+json'
   repos/<o>/<r>/pulls/<n>` gives the `pull` shape, the node id, and `body_html`: the mention
   must be inside a `<code>` or `<pre>` element and no `user-mention` link exists
   (`mention.renderedAsCode`); the body must not match `TOKEN_SHAPE` (`tokenShapeInBody`).
3. **Again.** The same command, the same file: exit 0, stdout holding
   `already submitted as idp-agent/… · pull request #<n> is open · nothing written`; the
   clone's refs (`git for-each-ref`) byte-identical before and after; `pulls` still one pull
   request; `ref` for `idp-agent/…` the same commit.
4. **Every door, as the owner.** Each `LIVE_DOORS` entry of step `doors`, in order: the
   three methods of `gh pr merge`, `gh pr merge --admin`, the REST merge `PUT pulls/<n>/merge`,
   `PUT pulls/<n>/merge-async` (a 404 is recorded as not served, and counts as refused only
   because the base did not move), `POST merges` with base `<base>` and head the `idp-agent/`
   branch, `PUT contents/live-<stamp>.txt` on `<base>`, a **non-forced** `PATCH
   git/refs/heads/<base>` to the pull request's head (`force` false), a **non-forced** `git push
   origin <head>:refs/heads/<base>` (a fast-forward the pull request rule forbids), and the
   GraphQL `mergePullRequest` and `createCommitOnBranch` on `<base>` with `expectedHeadOid`
   `baseSha`. After each: `ref` for the base must still be `baseSha`, and the pull request
   still open and not merged. A door counts as refused only when **GitHub answered** — an HTTP
   status of 400 or more read by `parseIncluded` from `--include`, a GraphQL `errors` array, a
   `remote:` rejection line, or, for `gh pr merge`, exit 1 with none of gh's argument errors
   on stderr (`unknown flag`, `accepts`, `required flag`, `could not determine`,
   `not a git repository`); a door that failed before reaching GitHub fails the test as *not
   tried*. No forced update is ever sent. A door that succeeds stops the steps at once.
5. **After an approval, a push, then the merge.** Only with the second account: it runs
   `gh pr review <n> --repo <o>/<r> --approve`; the test reads the review back as approved;
   the test's git commits one file on top of the head in the clone and pushes it
   **non-forced** to the `idp-agent/` branch; the pull request's `head.sha` is read until it is
   that commit (at most three reads, 0.5 s then 1.5 s apart); then the `after-approval` door,
   `gh pr merge <n> --repo <o>/<r> --merge` as the owner, must be refused and the base
   unchanged. The test never makes a merge that could succeed: nothing merges between the
   approval and the push. Without the second account this step writes
   `"afterApproval": "skipped"`, prints on stderr that the claim about a push after an approval
   rests on the fake and the rule's read alone, and calls `context.skip()`.
6. **`afterAll`, whatever happened.** The test closes the pull request (`gh pr close <n>
   --repo <o>/<r>`) and deletes `live/<stamp>/base` and the `idp-agent/` branch
   (`gh api --method DELETE repos/<o>/<r>/git/refs/heads/…`) with the owner's gh, removes the
   temporary directory, and writes the answers file: `passed` true only when every step passed
   and step 5 was made or skipped, `steps` each `passed`, `failed`, `skipped` or `not-run`.
   Before writing, `identifying(file, [owner login, reviewer login, the owner's name and email
   as `user` answered])` must return nothing, or the file is not written and the run fails
   naming the kinds found. A failed cleanup is said on stderr, the branch names given, and
   `steps.cleanup` is `failed`.

**When the run contradicts the design, it stops and goes to the owner**, and no pull request of
6.4 is opened: `current_user_can_bypass` other than `never` for the owner, an administrator
outside the bypass list (g9 — § 8 item 3 would refuse the owner's own repository, decision 6's
premise); any door that succeeds, step 5's merge included (the invariant does not hold as built;
the throwaway repository keeps one additive commit, since no forced update exists); a read-back
needing more than three reads (§ 4's bound, `GITHUB_LIMITS.readBack`, is too tight); a non-2xx
answer `parseIncluded` cannot read (`process/gh.ts`'s classification is wrong: fixed here, with
its test, only on the owner's word).

- [ ] **Step 1: The default-suite tests (fail: nothing of this exists)**

`tests/unit/live-config.test.ts`, beside 6.1.1's assertion that the default configuration
collects nothing under `tests/live/`, now over a file that exists:

```typescript
describe('the live configuration', () => {
  it('loads tests/live/setup.ts and no other setup file, and no global setup', …)        // vitest.live.config.ts does not exist
  it('collects tests/live/**/*.live.test.ts and nothing else', …)
  it('is what pnpm test:live:github runs, and nothing else runs it', …)                    // package.json's script, exactly; ci.yml names no test:live
  it('lists tests/live/github/submit.live.test.ts, and the default configuration does not', …)
})

describe('the live guard', () => {
  it('throws on an environment without IDP_GITHUB_LIVE_REPO, naming the variable', …)     // guard.ts does not exist
  it('refuses a repository without idpa-live in its name, a URL, a third segment and an owner outside the login grammar, never quoting the value', …)
  it('accepts acme/idpa-live and acme/my-idpa-live-2', …)
  it('refuses a relative reviewer directory, and answers undefined when it is unset', …)
  it('removes every *_API_KEY and IDP_* but its two variables, whatever the case, and keeps GH_TOKEN, HOME, SSH_AUTH_SOCK and PATH', …)
})
```

`tests/unit/github-answers.test.ts`:

```typescript
describe('the shape of an answer', () => {
  it('keeps a value only under a KEPT_KEYS key, and a login, a name, an email or an id never', …)  // github-answers.ts does not exist
  it('writes one shape per distinct array element, sorted, so three rules keep their three types', …)
  it('finds a key the fake sends and GitHub did not, another type and another kept value, each by its path', …)
  it('finds nothing when the fake sends a subset of what GitHub sent', …)
})
describe('what the answers file may hold', () => {
  it('replaces a login in any case, inside a URL and inside a remote line', …)
  it('names the kind of each identifying text left, never the text', …)
  it('sees a token of each shape TOKEN_SHAPE covers, and a near miss it does not', …)
  it('refuses to list no file: a pattern with no match is a read error', …)
})
```

`tests/contract/github-answers.test.ts` (Step 5 writes its body):

```typescript
describe('the fake gh, held to what GitHub answered', () => {
  it('reads at least one answers file, each from a run that passed and made step 5', …)    // no file under tests/contract/github/
  it('has each hand-filled field answered, and bypassListEmpty true, agreeing with the bypass actors read when they were readable', …)
  it('pins GH_MINIMUM_VERSION to the oldest gh a committed run used, and the fake answers that version', …)
  it('answers each route with the status GitHub answered, and says nothing GitHub did not', …)
  it('answers each modelled door as GitHub did, as the owner, and the after-approval merge after an approval and a push', …)
  it('holds every modelled live door to a DOORS entry of the same name', …)
  it('classifies the recorded push rejection as a ruleset refusal', …)                        // classifyPushFailure over the recorded remote lines
  it('reads a non-2xx answer through --include as GitHub printed it, exiting as gh did', …)
})
```

Run: `pnpm vitest run tests/unit/live-config.test.ts tests/unit/github-answers.test.ts
tests/contract/github-answers.test.ts`. Expected: FAIL — `vitest.live.config.ts`,
`tests/live/guard.ts` and `tests/support/github-answers.ts` not found, and no answers file.

- [ ] **Step 2: The configuration, the guard and the setup file**

`vitest.live.config.ts` as in *Files*; it imports nothing from `tests/setup/` and does not call
`enterRunDirectory()`: the live test makes and removes its one temporary directory itself.
`tests/live/setup.ts` is two lines, `scrubLiveEnvironment(process.env)` then
`liveRepository(process.env)`, so an invocation without the variable fails before any test
file is imported, naming it:

```text
IDP_GITHUB_LIVE_REPO is not set: the live test runs only on purpose, against your throwaway repository (docs/submitting.md, "Proving it on your repository").
```

`package.json` gains `"test:live:github": "vitest run --config vitest.live.config.ts"` and
nothing else. `pnpm typecheck` already covers `tests/**/*.ts`, so the live test is typechecked
in CI though never run there. Run the two unit files: live-config green.

- [ ] **Step 3: `tests/support/github-answers.ts`**

`shapeOf` walks a parsed JSON value; a primitive under a `KEPT_KEYS` key is kept when it is a
boolean, a number, or a string of at most 40 characters matching `^[A-Za-z_]+$` (an
enumeration: `User`, `never`, `pull_request`, `DeployKey`), and is its type otherwise. An array
is the sorted list of its distinct element shapes. `fakeWithin` walks the fake's shape and
reports each path absent from the recorded one, typed otherwise, or kept with another value; an
array element of the fake's must be within at least one of the recorded elements. `scrubbed` is
case-insensitive and literal (no regular expression is built from a login). `identifying`
lowercases both sides and returns kinds. `answersFiles()` lists
`tests/contract/github/answers-*.json` sorted by name, which is by date. Run
`tests/unit/github-answers.test.ts`: green.

- [ ] **Step 4: `LIVE_DOORS` and the live test**

`tests/live/github/doors.ts` holds the doors of steps 4 and 5 with their argument vectors:
every `gh pr` door carries `--repo <o>/<r>`, every `gh api` door `--hostname github.com
--method <M> --include`, the GraphQL doors `gh api graphql -f query=…` with the node id and
`baseSha` substituted, the push door `git -C <clone> push origin <head>:refs/heads/<base>` with
no force of any kind. A door the fake models (the three merge methods, `--admin`, the REST
merge, `POST merges`, `PUT contents` on the base, the base's ref update) carries the name its
`DOORS` entry has in `tests/support/fake-gh.ts`; one it does not (`merge-async`, the two
GraphQL mutations, the push, which the bare repository answers in the fake's world) carries a
name of its own and `modelled: false`. A modelled door `DOORS` lacks is added to `DOORS` in this
task, and 6.1.1's `launcher-doors.test.ts` then refuses it too. The names are kebab-case words
holding none of the door strings, so the contract test, which reads them, names no door.

`tests/live/github/submit.live.test.ts` follows *What the live test does*, one
`describe.sequential` over steps 1 to 5 and `afterAll` for step 6; its gh reads are
`ghIn({ env }).get(route)`, recorded raw (`status`, `hasNext`, `shapeOf(JSON.parse(body))`) and
then parsed with `core/github/answers.ts`'s schema for the route, so a real answer the schemas
refuse fails the run where it happened; its own calls (the clone, the doors, the review, the
cleanup) are `execFile` from `tests/live/`, with no shell. The test prints each step's outcome
and, on a failure, the CLI's stdout and stderr, which are engine sentences; it never prints a
gh body or a git stderr but through `scrubbed`.

**Exhaustive switches:** the recorder's switch over `LiveDoor['via']` and the contract test's
over the recorded door's `via`, each with `const _exhaustive: never = via` in `default`.

- [ ] **Step 5: The contract test's body**

Over each file of `answersFiles()`:

- the file parses as `AnswersFile`, `passed` true, `steps.afterApproval` `made` (decision 20:
  6.4.1 closes only on a run that made step 5), `identifying(text, [])` empty for token shapes;
- each `handFilled` field is a boolean, `bypassListEmpty` is true, and when
  `bypass.bypassActors` is an array its emptiness equals `bypassListEmpty`;
- `GH_MINIMUM_VERSION` equals the lowest `gh.version` of all files (`isAtLeast` both ways), and
  `FAKE_GH_VERSION` equals it;
- each route entry: the fake, in the state `openedPullRequest()` reaches (pull request #1 open
  from its `idp-agent/` branch into `main`, § 8's ruleset, the owner an administrator outside
  the bypass list) and `.as()` the entry's account, answers the argument vector `ghArgv` builds
  for the route with the same `status` and `hasNext`, and `fakeWithin(shapeOf(fake), entry.shape)`
  is empty — GitHub's answer holds every field the fake gives, of the same type, and the fake's
  answers are what `core/github/answers.ts`'s schemas are tested on since 6.1.2, so what the
  schemas read is in GitHub's answer;
- each door entry with a modelled name: the fake answers `DOORS`' vector of that name, in the
  same state (and, for `after-approval`, after another account approved and the author pushed on
  top, as `merge-refused.test.ts` does), with the recorded `status` for `gh-api` and the recorded
  `exit` for `gh`, refused, and the bare repository's base ref unchanged;
- `classifyPushFailure` over a `GitError` whose stderr is the recorded `remote` lines of the
  push door answers `ruleset`;
- `include.exitOnNonSuccess` equals the fake's exit on a non-2xx answer, and the fake's stdout
  for it passes `parseIncluded`.

The entries a fake cannot be held to (`modelled: false`) are asserted only as refused with the
base unchanged, read from the file. Run it: FAIL on the missing file alone.

- [ ] **Step 6: Checks before the session**

```bash
df -h "$TMPDIR"
pnpm typecheck
pnpm vitest run tests/unit/live-config.test.ts tests/unit/github-answers.test.ts tests/architecture
pnpm build
```

Expected: green; the architecture block reports **29** rules, unchanged — the door rule reads
`tests/live/` as its exception and finds no door in `tests/support/github-answers.ts`,
`tests/unit/` or `tests/contract/`. `tests/contract/github-answers.test.ts` is the one red test
until Step 7, by design. The branch is not pushed.

- [ ] **Step 7: The owner's live session** (owner only; "What the owner can run" below)

The owner runs the live test once or more; each run writes its file and cleans up after
itself. The owner fills the three fields of the file kept — *Allow GitHub Actions to create and
approve pull requests* off for the repository (its answer to `GET
repos/<o>/<r>/actions/permissions/workflow`, read by the owner, an administrator there), whether
their git pushes as the account gh is logged in as (`ssh -T git@github.com` names it), whether
the ruleset's bypass list is empty (Settings → Rules → Rulesets) — removes the files of runs not
kept, and hands the branch back. The same session goes on to 6.4.3's recordings.

- [ ] **Step 8: The fake moved to GitHub, the minimum gh pinned**

Run `pnpm vitest run tests/contract/github-answers.test.ts`. Each failure is a place where the
fake said something GitHub did not: the status or shape is moved in `tools/fake-gh.ts` to
GitHub's, and every 6.1.x–6.3.x test asserting the old one is changed in the same commit, each
named in *What changes*. `GH_MINIMUM_VERSION` becomes the recorded `gh.version`,
`FAKE_GH_VERSION` and `tools/fake-gh.ts`'s `gh version <v> (<date>)` line match it, and the
literal `2.40.0` is gone from `src/`, `tests/`, `tools/` and `scripts/`. A later run with an
older gh, committed, lowers the minimum; nothing raises it but a newer oldest run.

- [ ] **Step 9: The documents this task makes true**

- `docs/submitting.md`: "gh `<v>` or later", with the sentence that it is the version a live
  run was proved with, and a section *Proving it on your repository: the live test* — the
  throwaway repository, the ruleset, the second account (`gh api --method PUT
  repos/<o>/<r>/collaborators/<login> -f permission=push`, the invitation accepted in the second
  account's own gh configuration directory, with `GH_TOKEN` and `GITHUB_TOKEN` unset for it),
  the command, what each step proves, the three fields and where each is read, and that the
  test is never run in CI because it needs a logged-in gh, a credential someone else's workflow
  could reach (§ 20).
- `tests/README.md`: *The fake gh and the live test*, beside *The fake Backstage*: the fake is
  held to `contract/github/` by `contract/github-answers.test.ts`; `pnpm test:live:github`
  re-records, run by hand with a logged-in gh; nothing in the suite starts gh.
- `AGENTS.md`: under *Commands*, beside the tracing and Backstage blocks, the live test —
  optional, needs gh logged in to github.com and the owner's throwaway repository, never part of
  CI —, and the test count re-measured (also on the README's badge).
- § 17's unknowns this run answers, each written where a person meets it: `docs/submitting.md`
  (the minimum gh; an administrator outside the bypass list is bound, `--admin` included; a
  mention inside the request's fence is shown as code), and the roadmap's decisions (below).
  Those it cannot answer — how a company protects its declarations repository, whether its
  submitters push as their gh account, whether its Actions may approve — stay in the roadmap as
  the questions an adopting company answers; the three hand-filled fields answer them for the
  owner's repository only. GitHub's rejection of a push by a ruleset restricting the creation of
  `idp-agent/` branches is not provoked (the live repository has one ruleset); the recorded
  `GH013` lines of the push onto `main` are what `classifyPushFailure` is held to.

- [ ] **Step 10: Checks**

```bash
df -h "$TMPDIR"
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm vitest run tests/architecture --reporter=verbose
git diff main -- tests/recordings tests/golden fixtures/si-demo tests/scenarios/prompt-digests.test.ts
git grep -n --untracked -e '2\.40\.0' -- src tests tools scripts
```

Expected: green; 29 rules; the diff of the four paths empty; the grep finds nothing. The test
count is written into `AGENTS.md` and the badge.

- [ ] **Step 11: The pull request** (after the owner's go-ahead)

```bash
git add vitest.live.config.ts package.json tests/live/guard.ts tests/live/setup.ts \
  tests/live/github/doors.ts tests/live/github/submit.live.test.ts \
  tests/support/github-answers.ts tests/support/github-fixture.ts tests/support/fake-gh.ts \
  tools/fake-gh.ts src/core/github/gh-version.ts tests/unit/live-config.test.ts \
  tests/unit/github-answers.test.ts tests/contract/github-answers.test.ts \
  tests/contract/github/ tests/unit/merge-refused.test.ts \
  docs/submitting.md tests/README.md AGENTS.md README.md CHANGELOG.md docs/roadmap.md \
  docs/plans/stage-6-github.md
git commit -m "test(github): prove on GitHub that the opener cannot merge, and hold the fake gh to what GitHub answered"
```

The answers file's name is the run's date (`answers-<date>.json`), so its folder is added, which
holds that one file; every other test file Step 8 changed is added by name. Base `feat/s6-phrase-submit`. CHANGELOG, `### Added`:

> - `pnpm test:live:github`, the owner's live test of stage 6, run by hand against a public
>   throwaway repository with their own gh session and a second account's, never in CI and
>   failing without `IDP_GITHUB_LIVE_REPO`: a submission opens a pull request, a second one
>   names it, every door — each merge method, `--admin`, the REST and GraphQL merges, a
>   contents write and a push onto `main` — is refused to the identity that opened it with
>   `main` unchanged, and an approval followed by the opener's push leaves the merge refused.
>   Its recorded answers, logins removed, hold the fake gh to GitHub in `pnpm test`, and gh
>   `<v>`, the version it ran with, is the oldest this build reads
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

The roadmap: the stage 6 row gains "6.4.1, the live test ([#PRNUM](…))"; its decisions gain,
dated, what the run measured — the gh version pinned, `current_user_can_bypass` for an
administrator outside the bypass list, each door's answer in one line, whether a read-back lag
was seen, whether the fenced mention rendered as code — and the queue's stage 6 item says the
live proof is made.

**What changes that a person sees:** `idpa` refuses a gh older than `<v>` where it refused one
older than 2.40.0 (exit 2, the sentence of 6.1.2); nothing else of the CLI changes, unless Step 8
moved a status of the fake, and then only the tests that named it — each listed here.

**What the owner can run.** Offline and keyless first, from the worktree:

```bash
cd "$HOME/Documents/idp-agent-worktrees/s6-live-github"
pnpm install
pnpm vitest run tests/unit/live-config.test.ts tests/unit/github-answers.test.ts
pnpm test:live:github
```

Attendu :
- the two test files pass;
- `pnpm test:live:github` stops at once with `IDP_GITHUB_LIVE_REPO is not set: …`, exit 1,
  having started no gh and no git.

Once, to set the second account up (it needs write access to the repository and its own gh
login; `GH_TOKEN` and `GITHUB_TOKEN` are unset for its commands because either would make gh
answer as you):

```bash
OWNER=your-login
REVIEWER=your-second-login
gh api --method PUT "repos/$OWNER/idpa-live/collaborators/$REVIEWER" -f permission=push
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" gh auth login --hostname github.com
INVITATION=$(env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" gh api user/repository_invitations --jq '.[0].id')
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" gh api --method PATCH "user/repository_invitations/$INVITATION"
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" gh api "repos/$OWNER/idpa-live" --jq .permissions.push
```

Attendu :
- the first `gh api` answers the invitation (or nothing, if the account is already a
  collaborator; then the invitation lines answer nothing and a 404, and are not needed);
- `gh auth login` opens the browser: sign in there **as the second account**;
- the last line prints `true`.

The live run (the throwaway repository as 6.1.3 and 6.2.2 left it: the demo SI on `main`, § 8's
ruleset, bypass list empty; your ssh key loaded in your agent, so no passphrase is asked in the
middle of a step):

```bash
OWNER=your-login
cd "$HOME/Documents/idp-agent-worktrees/s6-live-github"
gh auth status --hostname github.com
ssh-add -l
pnpm build
IDP_GITHUB_LIVE_REPO="$OWNER/idpa-live" IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" pnpm test:live:github
ls tests/contract/github
```

Attendu :
- `gh auth status` says you are logged in to github.com; `ssh-add -l` lists your key;
- the live test passes: the guards, then steps 1 to 5, each ✓ (step 5 is *made*, not
  skipped), in a few minutes;
- on the way, the CLI's stderr says
  `submitting to github.com/…/idpa-live, into main (origin, main's upstream), as … (gh)`,
  and a pull request is opened, then named again;
- on GitHub afterwards: that pull request is closed, its `idp-agent/…` branch and
  `live/…/base` are deleted, `main` is where it was, and the pull request's page shows an
  approval from the second account followed by your push;
- `ls` shows one new `answers-YYYY-MM-DD.json`.

Then the three fields no read settles, written into that file by hand (`true` or `false` each):

```bash
OWNER=your-login
ssh -T git@github.com
gh api "repos/$OWNER/idpa-live/actions/permissions/workflow"
```

Attendu :
- `ssh -T` prints `Hi …! You've successfully authenticated, but GitHub does not provide shell
  access.` and exits 1, which is GitHub's normal answer: `gitPushesAsGhAccount` is `true` when
  that login is your gh login;
- the second line shows `"can_approve_pull_request_reviews": false`, which is
  `actionsCanApprovePullRequests: false`;
- on the web page, Settings → Rules → Rulesets → the ruleset: its bypass list is empty, which is
  `bypassListEmpty: true`.

Then, and after the implementer's Step 8:

```bash
pnpm vitest run tests/contract/github-answers.test.ts
pnpm test
```

Attendu : both green; `pnpm test` reaches no network and starts no gh.

---

### Task 6.4.2: ADR-0015, and every document the stage makes true

**Goal.** The note's § 16, 6.4.2. ADR-0015 records the decision the stage built, in the owner's
words; ADR-0006, ADR-0010, ADR-0012 and ADR-0003 say what it changed of them; design §4.2, §4.4,
§5.1, §5.5, §7.0, §7.2, §7.4, §8, §9.2, §9.4 and §10, `SECURITY.md`, `docs/submitting.md`, the
README and `AGENTS.md` describe stage 6 as built; the note is marked built; the roadmap's stage 6
row is done. The invariant appears **word for word** wherever a document states it, held by a
test (Global Constraint 5). No behaviour changes: the one file under `src/` is a comment.

Cites Global Constraints 5, 11, 12, 13, 14 and 15.

Earlier tasks already made some of these true (the File Structure: design §4.2's invariant,
`AGENTS.md`'s *Authorisation* bullets, `SECURITY.md`'s two rows and its two authorisation items
in 6.2.2, `docs/submitting.md` from 6.1.3 and 6.2.2, the
README's closing lines in 6.2.2, the rule count in 6.1.1 and 6.1.2). Each step below re-reads the
document first and leaves what already holds; the grep of Step 10 is what says the sweep is
complete.

**Files:**
- Create: `docs/adr/0015-a-submission-is-a-pull-request-the-rules-hold.md`
- Create: `tests/unit/invariant-wording.test.ts` — **added to the shared names**
- Modify: `docs/adr/0006-the-merge-request-is-authorisation.md`,
  `docs/adr/0010-a-submission-is-a-create-only-ref.md`,
  `docs/adr/0012-declared-is-not-provisioned.md`, `docs/adr/0003-provider-interfaces.md`
- Modify: `docs/design.md` (§4.2, §4.4, §5.1, §5.5, §7.0, §7.2, §7.4, §8, §9.2, §9.4, §10, and
  §12.1's ADR list)
- Modify: `SECURITY.md`, `docs/submitting.md`, `README.md`, `AGENTS.md`
- Modify: `src/core/schemas/config.ts` (`:7-8`, the comment)
- Modify: `docs/stage-6-brief.md` (its status line: built, and where the plan departed),
  `docs/roadmap.md`, `CHANGELOG.md`, `docs/plans/stage-6-github.md` (ticks)

- [ ] **Step 1: The wording test (fails: ADR-0015 does not exist; design §4.2, `AGENTS.md`
  and `SECURITY.md` state the invariant since 6.2.2)**

```typescript
/** The owner's words (the note's § 18, decision 1), stated once here and nowhere else in tests/. */
const INVARIANT =
  'the identity that opens a pull request cannot merge it until someone else has approved ' +
  'the exact commit that would merge, and idpa never submits against a base without those rules'

describe('the invariant, in the owner’s words', () => {
  it.each([
    'docs/design.md',
    'AGENTS.md',
    'SECURITY.md',
    'docs/adr/0015-a-submission-is-a-pull-request-the-rules-hold.md',
    'docs/submitting.md',
  ])('%s states it word for word', …)   // whitespace collapsed, `*` removed, the first letter's case ignored
  it('no document states "one token per capability" or "the token that opens a merge request cannot merge it" as a guarantee', …)
})
```

The second test reads the same five files, the README and `docs/adr/0006-…`, and allows the
phrase only in a sentence that says it was replaced (the test looks for `ADR-0015` in the same
paragraph). Run: `pnpm vitest run tests/unit/invariant-wording.test.ts`. Expected: FAIL on the
missing ADR, and on `docs/submitting.md` if it does not yet state the invariant word for word;
`docs/design.md`, `AGENTS.md` and `SECURITY.md` pass (6.2.2), which is the check that 6.2.2
wrote the owner's words and not a paraphrase.

- [ ] **Step 2: ADR-0015**

`docs/adr/0015-a-submission-is-a-pull-request-the-rules-hold.md`, titled *ADR-0015 — a
submission is a pull request the rules keep from merging until someone else approves it*.
Status line: *proposed* in the draft; the owner accepts it on the pull request, after a
presentation of this record, and the commit that records it writes *accepted, <date>* and one
italic paragraph naming what the owner chose, as ADR-0010's does. **Builds on** ADR-0006,
ADR-0010, ADR-0011, ADR-0012. Sections:

- **Context.** Stage 5's local branch and its closing sentence; the fact no stage-5 document
  states — on GitHub, the right to push a branch is the right that merges, whatever the
  credential (`repo` scope, an SSH key, *Contents: write*), so "one token per capability" cannot
  be delivered by any credential's scope; the owner's decision of 2026-09-30 that idpa holds no
  GitHub credential, "like Claude Code".
- **Decision.** First, verbatim and in bold, the invariant: "**the identity that opens a pull
  request cannot merge it until someone else has approved the exact commit that would merge,
  and idpa never submits against a base without those rules**". Then, one paragraph each: the
  person's git pushes the exact commit create-only (`--force-with-lease=<ref>:`, empty expected
  value, one refspec, to the URL `git remote get-url --push` printed, hooks off, § 4's pins);
  the person's gh reads and opens (eight `GET` templates and one `POST`, `--hostname github.com`
  on each, the body on standard input, built by the engine); both launchers check the final
  argument vector against a grammar before any process starts, and four architecture rules keep
  the source from naming a door, reading a GitHub credential or loading the gh launcher outside
  `forge/github/`; the repository's own configuration is hostile — a key that redirects the push
  or runs a program is refused, exit 2, named with its scope, never its value — while the
  person's global and system configuration is theirs; the base's ruleset is read before
  anything is written and again at the moment of acting (§ 8 items 1 to 5: a pull request rule
  of one approval with approval of the most recent push or dismissal of stale approvals, no force
  push, no deletion, `current_user_can_bypass` `never` on every supplying ruleset; classic
  protection alone refused; a visible deploy key in the bypass list refused); without gh, or
  with gh logged out, expired, too old or not a person, nothing is pushed, exit 2, `--local`
  named; the pull request's URL is built by the engine; recognition on GitHub before anyone is
  asked (§ 14's rows, the older base included); two systems, each atomic on its own and never
  claimed atomic together, every intermediate state completed by running the same command again.
- **How it is proved.** Twice: offline in `pnpm test`, against the fake gh and a bare remote
  through a fake ssh (`tests/unit/merge-refused.test.ts`, `tests/invariants/github-forge.test.ts`,
  the hostile-clone and door tests); and live, by the owner, on a public throwaway repository
  with their own gh session and a second account's (`tests/live/github/submit.live.test.ts`),
  whose recorded answers (`tests/contract/github/answers-<date>.json`) hold the fake to GitHub.
  The measured values of 6.4.1, each in one sentence: the gh version, the administrator bound,
  each door's answer, the read-back lag, the fenced mention.
- **Rejected alternatives.** § 20, condensed to one line each, the token design first, with
  what it would have bought.
- **Consequences.** What no read can see (§ 8, five items), and the invariant's limit in the
  owner's words and § 8's: it binds the identity that opens the pull request and every
  credential that person pushes with, as long as the ruleset stands, the push credential is not
  in its bypass list, and no workflow or app approves in someone else's place; the push
  credential is not proven gh's account in stage 6 (§ 19 Q4), and `gh auth setup-git` is
  recommended; stage 6 is a laptop tool, not a CI step (Q1), until a server-side runner has an
  ADR of its own; github.com only, GitHub Enterprise later through gh's own host configuration
  (decision 16); ADR-0012 stays proposed; D6 and D12 stay refused.

- [ ] **Step 3: The records it amends**

- **ADR-0006**, *Consequences*: the sentence "`init platform` will print the required settings
  and verify them, including a live check that the supplied token cannot merge (§ 7.2)" becomes:
  "`init platform` prints the required settings, and `idpa protection` and every submission
  verify them, before anything is written and again at the moment of acting (ADR-0015). The live
  check that the identity which opens a pull request cannot merge it is the owner's live test,
  never the tool's: a merge the tool attempted would be the merge nobody authorised." A last
  paragraph: "Stage 6 replaces 'a token that may open a request, never merge it', which no
  GitHub credential can be scoped to, with the owner's invariant: the identity that opens a pull
  request cannot merge it until someone else has approved the exact commit that would merge,
  and idpa never submits against a base without those rules (ADR-0015)." The *Decision* section
  is the record of 2026-09-21 and stays as written.
- **ADR-0010**, *Consequences*, one paragraph: "From stage 6 the same commit is pushed to the
  same name on GitHub, create-only as well: `--force-with-lease=<ref>:` with an empty expected
  value refuses a ref that exists, and the push names one refspec and a URL, never a remote.
  Each system stays atomic on its own; the two together are not, and each intermediate state is
  completed by running the same command again (ADR-0015). On the GitHub road only, our one
  commit on an older base, with its open pull request, is recognised as already submitted; the
  local road keeps D7." The same paragraph says that the *Decision*'s "the one launcher every
  process `src/` starts goes through" (line 55, left as the record it is) now means the git
  launcher, `process/git.ts`: since 6.1.1 gh has a launcher of its own, `process/gh.ts`
  (`src/context/project-fs/snapshot.ts`'s comment saying the same was reworded in 6.1.1).
- **ADR-0012** (decision 12): the status line becomes "proposed — stage 6 reads the required
  status check and prints it; the check is the downstream system's"; *Consequences*' "Until stage
  6 …" paragraph becomes: stage 6 reads the base's `required_status_checks` and prints the
  contexts merging waits for, in `idpa protection` and in a submission's closing lines, or says
  none is required and so a downstream refusal would not stop the merge; it requires none, since
  nothing downstream reports yet and the generated `validate.yml` runs no validation until the
  package is published; the rule is *advised* in the one list of settings; the record stays
  proposed, its mechanism being the downstream system's.
- **ADR-0003**, *Decision*: "`ForgeProvider` … ships at stage 5 with one implementation,
  `local`" → "… ships at stage 5 with `local`, and at stage 6 with `github`, which holds the
  local forge and adds the push and the pull request; neither has a `merge`, an `approve`, a
  `close` or a `delete` (ADR-0010, ADR-0015)."
- **design §12.1**: `ADR-0015  a submission is a pull request the rules keep from merging until
  someone else approves it`, and ADR-0012's line "(proposed; stage 6 reads and prints the
  required check)".

- [ ] **Step 4: `docs/design.md`**

- **§4.2.** Written in 6.2.2; this step re-reads it and replaces its closing reference to the
  note by "(ADR-0015)". The bullet, as 6.2.2 writes it and this step leaves it:

  > - **The identity that opens a pull request cannot merge it until someone else has approved
  >   the exact commit that would merge, and idpa never submits against a base without those
  >   rules.** On GitHub the right to push a branch is the right that merges, so no credential
  >   can be scoped out of merging; what refuses the merge is the base's ruleset, which the tool
  >   reads before it writes anything and again at the moment of acting, and a test asserts that
  >   the merge **fails**: offline against a fake, live on a throwaway repository (ADR-0015).

  (The first bullet's "merge request" became "pull request" in 6.2.2; the third stays.)
- **§4.4**, *Declared is not provisioned*: "Refusal is caught before the merge by a required
  check (stage 6)" → "Refusal is caught before the merge by a required status check the
  downstream system reports; `idpa protection` and every submission print the contexts merging
  waits for, and nothing requires one yet".
- **§5.1**, `:273`: "The merge request is stage 6 — see § 7.4." → "The pull request is stage 6:
  the same commit pushed with the person's git and opened with their gh — see § 7.4."
- **§5.5**: the count re-measured (**twenty-three** on `2b2250e`, two short of the 25 measured
  there; 29 now), and the four rules of 6.1.1 and 6.1.2 named in its long sentence — two
  launchers, the door strings, the credential names, the gh launcher's one folder — unless 6.1.1
  and 6.1.2 already wrote them.
- **§7.0**: "the forge token from `GITHUB_TOKEN` or `gh auth`" → "no forge credential: the
  person's git and gh hold theirs, and idpa reads none of it (ADR-0015)"; "Nothing reads
  `iacRepo` before stage 6" → "`iacRepo` is read from stage 6 as a cross-check, never a source: a
  submission whose declarations repository's remote names another host or path is refused".
- **§7.2**, *What the tool cannot do, and says so*: the sentences from "**From stage 6** it also
  **verifies** them" to "one stage earlier" become: "It cannot verify them either, since a new
  repository has no remote yet; `idpa protection` verifies them once the repository is on
  GitHub, and every submission verifies them again, before anything is written and at the
  moment of acting, refusing where the opener could merge without someone else's approval of the
  latest commit. What no read can prove — that the merge itself fails — is proved by the owner's
  live test, never by the tool, which runs no merge (ADR-0015)."
- **§7.4**: the bold sentence becomes "**Steps 2 to 8 are built**, step 1 from a git repository
  or a Backstage catalogue for a question"; the paragraph beginning "`idp-agent plan
  "<intent>"` runs" ends, from "The local forge cuts the branch", with: "Where the checked-out
  branch tracks a branch on github.com, the person's git pushes that commit create-only and
  their gh opens a pull request into the tracked branch, after the base's rules were read before
  any model and again at the moment of acting (ADR-0015); elsewhere, and with `--local`, the
  local branch is cut and the run says nothing was pushed. `plan --from … --submit` crosses four
  gates and no Reviewer; `idpa "<phrase>" --submit` takes the change's road, and a question with
  `--submit` is refused." The confirmation's question is quoted as § 3 words it.
- **§8**: the *Write interrupted* row becomes "per system: locally, nothing to roll back, as
  before; on GitHub, one ref per push, created or not; the two together are not atomic, and each
  intermediate state is completed by running the same command again (ADR-0015)"; a row "Rules
  missing or bypassable | refused before anything is written, and again at the moment of acting;
  the settings to add printed; exit 1".
- **§9.2**: after "…and so is a stranger creating the branch at each of them.", one sentence:
  "On the GitHub road the invariant is held per system (`tests/invariants/github-forge.test.ts`):
  every gh call and every git call is made to fail in turn, and a stranger creates the branch in
  the remote at each point; after every failure the state is a row of ADR-0015's table, and the
  next run converges on one ref and one pull request."
- **§9.4**: the first test becomes
  `test('the identity that opens a pull request cannot merge it until someone else has approved the exact commit that would merge')`,
  and the last paragraph's "The first becomes real at stage 6, against a forge." becomes "The
  first is proved twice from stage 6: offline in `tests/unit/merge-refused.test.ts`, against the
  fake gh and a bare remote, and live by the owner in `tests/live/github/submit.live.test.ts`,
  whose recorded answers hold the fake to GitHub (ADR-0015)."
- **§10**: `local/  git: local branch, commit, MR preview (no token)` and
  `github/  GitHub API` become `local/  git: the local branch (create-only)` and
  `github/  the push and the pull request, through the person's git and gh (no token)`; a
  `process/  git.ts · gh.ts — the only two launchers, each checking its argument vector` line
  under `src/`, and `core/github/` under `core/`.

- [ ] **Step 5: `SECURITY.md`**

*Where it stands*: "stage 6 of 7", and the sentence says what a submission writes on either road
and that idpa holds no forge credential. The invariant, word for word, heads the *Guaranteed*
item 6.2.2 moved there (checked, not rewritten). New, or completed where 6.2.2 began them: the
environment table of the note's § 5 (which variables reach git, the push and gh; what idpa sets);
under *Not guaranteed, by design*, the administrator limit and the five items of *What no read
can see* (§ 8), the limit worded once in the owner's words and § 8's; the push credential not
proven gh's (Q4); the live test named as the evidence for the merge refused, with its answers
file; *Reporting a vulnerability*'s surfaces gain `process/gh.ts`, `process/git.ts`'s push
grammar and `forge/github/`.

- [ ] **Step 6: `docs/submitting.md`, completed**

It is the page a person follows (the note's § 16): gh installed (`https://cli.github.com`) and
logged in as a person, the minimum version (6.4.1); git able to push as they already do, and the
recommendation to push as gh's account (`gh auth setup-git` over HTTPS, a key of the same account
over SSH); the ruleset of § 8 on the base, the one list of settings as `idpa protection` prints it
(quoted from `protectionText()`'s output, not retyped), and why each line; `idpa protection`, its
three exits; the refused configuration keys and the one-line move of each to the global
configuration; `--local`; what each road prints; the rows of § 14 as a person meets them; what no
read can see; the live test (6.4.1). The invariant word for word in its opening paragraph.

- [ ] **Step 7: `README.md`**

The first screen's sentence ("Nothing is pushed yet: the pull request, whose merge is the
approval, is stage 6") → the branch is pushed with your git and the pull request opened with your
gh, where the clone tracks a branch on github.com; the *With your own key* and *Commands* passages
(`:174`, `:478`) and the diagram's `Pull request<br/><i>stage 6</i>` (`:318`, `:333`) say what is
built; *Design principles* (`:680`); the roadmap table's stage 6 row done, with the note and the
plan linked; *Next, in order* without stage 6; the FAQ answers (`:729`, `:740`); *Documentation*
gains `docs/submitting.md` and ADR-0015. Every line the keyless first screen's test holds byte for
byte (`#78`'s test) is re-run; a line that test pins changes only with the test, in this commit.

- [ ] **Step 8: `AGENTS.md`**

*Invariants*, **Authorisation**: the owner's invariant, written in 6.2.2, re-read; its closing
reference to the note becomes "(ADR-0015)". *Current state*:
the date, stage 6 **done**, the stage table's row "GitHub pull request — the person's git and gh,
the ruleset checked, the live test", the paragraph on how stage 6 landed (eleven pull requests,
6.1.1 to 6.4.3). *Shipped and working*: `idpa protection`, `--local`, the GitHub road of each
command, and the sentence "nothing is pushed and no merge request is opened" (`:184`) replaced by
what a submission writes on each road (locally one ref; on the GitHub road the same commit under
the same name on github.com, and one pull request); the commands block gains `idpa protection
[--repo <dir>]` and `[--local]`. *The trust boundary*: the heading "built as far as a pull
request", the diagram's last line `→ [submit] → branch → push → pull request`, and "What is not
built is the far side — the merge request is stage 6 —" replaced by what is not built now (the
merge, by design; ADR-0012's check, the downstream system's). *Layering*: the `process/` sentence
names the two launchers and what each serves; the folder table's `process/`, `forge/` and `core/`
rows name `gh.ts`, `forge/github/` and `core/github/`. The rules paragraph names the four rules of
6.1.1 and 6.1.2, if they did not. The exit-code paragraph re-read against `docs/submitting.md`'s
refusals, each one found there. *Open questions*: "Declared is not provisioned … `init platform`
names the status check stage 6 will require" → "`idpa protection` prints the status checks
merging waits for"; a new item, the push credential not proven gh's account (Q4), with what a
company's answer to § 17 would change.

- [ ] **Step 9: The rest**

- `src/core/schemas/config.ts:7-8`: "model credentials come from the environment and the forge
  token from `GITHUB_TOKEN`, and nothing below reads either" → "model credentials come from the
  environment, and there is no forge credential of idpa's — the person's git and gh hold theirs
  (ADR-0015) —, and nothing below reads any".
- `docs/stage-6-brief.md`: the status line gains "**Built** on <date>, by
  `docs/plans/stage-6-github.md`", with the plan's departures in one sentence each (the pure
  parts in `core/github/`, the environment handed through `openSubmissionForge`, the forge's
  trace attributes from the intent road on, the interim refusal of `init --submit` until 6.3.2,
  `pnpm demo:github`, the answers of § 17 measured by 6.4.1). The note's text is otherwise a
  record and stays.
- `docs/roadmap.md`: the stage 6 row **done**, every pull request linked; the queue without stage
  6, renumbered; *Where the project stands* and its *Updated* line; ADR-0015 accepted, dated, in
  the decisions; *Known debts* gains stage 6's follow-ups: GitHub Enterprise (decision 16), the
  push credential (Q4), a server-side runner (Q1), a ruleset restricting `idp-agent/` creation not
  measured live.
- `CHANGELOG.md`, `### Documentation`, the line below.

- [ ] **Step 10: The sweep, and checks**

```bash
df -h "$TMPDIR"
git grep -n -e 'no forge (stage 6)' -e 'GITHUB_TOKEN. or' -e 'is stage 6' -e 'arrive at stage 6' -e 'until stage 6' -e 'token that opens a merge request' -e 'One token per capability' -e 'does not yet push' -e 'stage 5 of 7' -- docs AGENTS.md SECURITY.md README.md src tests
pnpm vitest run tests/unit/invariant-wording.test.ts
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm vitest run tests/architecture --reporter=verbose
```

Expected: the grep finds only dated records — `docs/plans/`, `docs/reviews/`,
`docs/stage-5-check.md`, `docs/stage-5-brief.md`, `docs/stage-6-brief.md`, `CHANGELOG.md`'s dated
sections — and the replaced sentences' own "replaced by ADR-0015" mentions; everything green; 29
rules. `tests/recordings`, `tests/golden` and `fixtures/si-demo` unchanged (`git diff main --stat`
lists none of them).

- [ ] **Step 11: The pull request** (after the owner's go-ahead; the ADR's status as the owner
  gives it)

```bash
git add docs/adr/0015-a-submission-is-a-pull-request-the-rules-hold.md \
  docs/adr/0006-the-merge-request-is-authorisation.md docs/adr/0010-a-submission-is-a-create-only-ref.md \
  docs/adr/0012-declared-is-not-provisioned.md docs/adr/0003-provider-interfaces.md docs/design.md \
  SECURITY.md docs/submitting.md README.md AGENTS.md src/core/schemas/config.ts \
  tests/unit/invariant-wording.test.ts docs/stage-6-brief.md docs/roadmap.md CHANGELOG.md \
  docs/plans/stage-6-github.md
git commit -m "docs: record that a submission is a pull request the rules keep from merging until someone else approves it"
```

Base `test/s6-live-github`. CHANGELOG, `### Documentation`:

> - ADR-0015: a submission is a pull request the rules keep from merging until someone else
>   approves it — "the identity that opens a pull request cannot merge it until someone else has
>   approved the exact commit that would merge, and idpa never submits against a base without
>   those rules", word for word in the design, `AGENTS.md`, `SECURITY.md` and
>   `docs/submitting.md` and held there by a test; ADR-0006, -0010, -0012 and -0003, the design's
>   authorisation, configuration, journeys, failure and test sections, the README and `AGENTS.md`
>   describe stage 6 as built, and `docs/submitting.md` is the page a person follows to submit
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** documents only, and one comment in `src/`; every command's
output is the same byte for byte.

**What the owner can run:**

```bash
cd "$HOME/Documents/idp-agent-worktrees/s6-adr-0015"
pnpm vitest run tests/unit/invariant-wording.test.ts
git grep -n -e 'One token per capability' -e 'token that opens a merge request' -- docs AGENTS.md SECURITY.md README.md
pnpm build
pnpm demo:github
```

Attendu :
- the wording test passes, five files and the sweep;
- the `git grep` lists only `docs/plans/`, `docs/reviews/`, `docs/stage-5-check.md`,
  `docs/stage-6-brief.md` and the sentences that say ADR-0015 replaced them;
- `pnpm demo:github` runs every road offline against the fake gh and a bare remote, each step
  printing what `docs/submitting.md` says it prints, and ends on success, exit 0.

---

### Task 6.4.3: The tapes recorded before 2026-09-30, recorded again by the owner

**Goal.** The owner's decision of 2026-09-30 (the note's § 16, 6.4.3; the roadmap's *Recordings
that need the owner's key*): each of the twelve tapes under `tests/recordings/` was recorded before
2026-09-30, so each of its turns holds a `sha256:` digest, blind to a tool's `.describe()`, `.max()`
and `.regex()`. The owner records all twelve again with their key, during the live session, so
every turn carries `sent:sha256:`, the digest over what the provider is sent, tools included
(#116). The owner runs every recording, `IDP_RECORDING=record` in `tests/scenarios/` only; **no
agent records, and no agent edits a tape**. No code under `src/` changes, so the requests the code
builds before any model answers are those of `2b2250e`; what changes is what the models answered,
and with it every later turn.

**Why this is not documents only on our side.** It
cannot be: `tests/scenarios/prompt-digests.test.ts` pins every request the question tapes are
replayed with, and from each agent's second turn those requests carry the recorded answers, so its
`SENT` moves with the tapes. This task re-measures `SENT` after the recording, keeps each agent's
first request pinned apart as `FIRST_SENT` (unchanged, the proof that the code sends what it sent),
and adds the two tests the re-record makes possible: every turn under the new digest, and
`question-mode.test.ts` failing on a stale tape as the other two scenario files already do.

Cites Global Constraints 6, 7 (the deliberate exception: tapes change, the requests the code builds
do not), 11, 12, 13, 14 and 15.

The twelve tapes on `2b2250e`, measured with `jq` (every turn `sha256:`, every `recordedAt` before
2026-09-30):

| Tape | Scenario file · test | Recorded with | Turns |
|---|---|---|---|
| `link-db-exists` | `plan-mode.test.ts` · `link-db-exists: proposes the access alone when the database is already declared` | openai `gpt-6-luna`, 2026-09-23 | 12 |
| `link-db-missing` | `plan-mode.test.ts` · `link-db-missing: the database is not in the catalogue` | openai `gpt-6-luna`, 2026-09-23 | 12 |
| `link-ambiguous-env` | `plan-mode.test.ts` · `link-ambiguous-env: the request names no environment` | openai `gpt-6-luna`, 2026-09-23 | 11 |
| `link-already-declared` | `plan-mode.test.ts` · `link-already-declared: the access is in the repository already` | openai `gpt-6-luna`, 2026-09-23 | 9 |
| `repair-malformed-owner` | `plan-mode.test.ts` · `repair-malformed-owner: a group outside the catalogue is never quietly replaced` | openai `gpt-6-luna`, 2026-09-23 | 7 |
| `question-backstage-owner` | `backstage-mode.test.ts` · `answers who owns billing-api from a Backstage catalogue` | openai `gpt-6-luna`, 2026-09-29 | 3 |
| `question-organisation-owns` | `backstage-mode.test.ts` · `answers what team tiger owns with the relation block` | openai `gpt-6-luna`, 2026-09-29 | 4 |
| `question-organisation-system` | `backstage-mode.test.ts` · `answers which system billing-api is in` | openai `gpt-6-luna`, 2026-09-29 | 4 |
| `question-prod-databases` | `question-mode.test.ts` · `answers a question with the table the graph itself would print` | mistral `mistral-small-2603`, 2026-09-21 | 3 |
| `question-consumers-of-billing-db` | `question-mode.test.ts` · `names the services that reach a database` | mistral `mistral-small-2603`, 2026-09-21 | 4 |
| `question-unanswerable-ranking` | `question-mode.test.ts` · `refuses a question the catalogue cannot answer, with a reason on stderr` | mistral `mistral-small-2603`, 2026-09-21 | 5 |
| `mutation-classified-link` | `question-mode.test.ts` · `classifies a change request and declines it` | mistral `mistral-small-2603`, 2026-09-21 | 1 |

Re-recording also closes the roadmap's *The question-mode recordings are stale*: the three
question tapes warn on the Analyst's turns since #54, and `mutation-classified-link` was recorded on
"give billing-api access to orders-db in prod" where the scenario now asks "give billing-api
**read** access to orders-db in prod". It does not close what waits for *a change and* a re-record
(the sweep's *Waits for a re-record only*, commentary on plans, wip-diff-2, the Architect told the
answers, `refuseUnusedValues`): each changes what a model is sent, and is recorded after its own
change. A `question-overview` scenario (#54's suggestion) is a new scenario, not a re-record, and
stays in the roadmap.

**Files:**
- Modify: `tests/recordings/*.json` (the twelve, the owner's)
- Create: `tests/scenarios/left.ts` (`LEFT_BY_THE_OWNER`, empty unless the owner leaves a tape)
- Modify: `tests/scenarios/plan-mode.test.ts` (*the recordings themselves* gains one test)
- Modify: `tests/scenarios/question-mode.test.ts` (`run` fails on a stale turn)
- Modify: `tests/scenarios/prompt-digests.test.ts` (`FIRST_SENT` split out; `SENT` re-measured; its
  comment)
- Modify: `tests/README.md` (*The tapes*: no tape holds the old digest; `question-mode.test.ts`
  fails on a stale tape)
- Modify: `AGENTS.md` and `README.md` (the test count), `docs/roadmap.md`,
  `docs/reviews/2026-09-23-deep-review.md` (Status), `CHANGELOG.md`, `docs/plans/stage-6-github.md`

- [ ] **Step 1: The tests the re-record makes pass (implementer, before the session; fail on the
  twelve tapes of `2b2250e`)**

`tests/scenarios/plan-mode.test.ts`, in *the recordings themselves*, beside `no shipped recording is
hand-authored`:

```typescript
// tests/scenarios/left.ts (new):
/**
 * Tapes the owner decided to leave as they were recorded, each with the date of that decision in
 * docs/roadmap.md. Empty unless the owner decides otherwise (Step 2): a scenario named here is
 * exempt from the two staleness checks (this one and question-mode.test.ts's) and from nothing else.
 */
export const LEFT_BY_THE_OWNER: readonly string[] = []

// tests/scenarios/plan-mode.test.ts, importing it from './left.js':
it('records every turn under the digest of what the provider is sent', async () => {
  // The owner's decision of 2026-09-30: every tape recorded before was recorded again, so no
  // turn holds the digest blind to a tool's .describe(), .max() and .regex() (#116).
  const old: string[] = []
  for (const file of await readdir(RECORDINGS)) {
    const tape = JSON.parse(await readFile(path.join(RECORDINGS, file), 'utf8')) as Recording
    if (LEFT_BY_THE_OWNER.includes(tape.scenario)) continue
    for (const turn of tape.turns) {
      if (!turn.digest.startsWith('sent:sha256:')) old.push(`${tape.scenario} ${turn.agent} turn ${turn.turn}`)
    }
  }
  expect(old).toEqual([])
})
```

Run: `pnpm vitest run tests/scenarios/plan-mode.test.ts -t 'records every turn'`. Expected: FAIL,
listing the 75 turns of the twelve tapes.

`tests/scenarios/question-mode.test.ts`: `run` asserts, as `plan-mode.test.ts` and
`backstage-mode.test.ts` do, that stderr holds no `the prompt changed since recording`, with the
message `${scenario}: the recording is stale — re-record it`, unless the scenario is in
`LEFT_BY_THE_OWNER` (imported from `tests/scenarios/left.ts`, so both files read one list); the
comment "The staleness of three of these tapes is known
and asserted elsewhere" goes. Run the file: FAIL on the three question tapes
(the Analyst's turns) and on `mutation-classified-link` (the Supervisor's).

`tests/scenarios/prompt-digests.test.ts`: `FIRST_SENT`, each scenario's first Supervisor request and
first Analyst request, copied from `SENT` as it stands on `2b2250e`, and a test that the first
request of each agent equals it. Neither depends on a recorded answer: the Supervisor is sent the
request and the summary, and the Analyst the request and the same summary, never the Supervisor's
words (`ask.ts`, `classified` and `answered`). It passes now and must pass unchanged after the
recording. The branch is not pushed.

- [ ] **Step 2: The owner's recordings** (owner only; "What the owner can run" below)

One scenario at a time, `-t` naming it, each provider's key exported in the owner's shell, never
typed into a file of the repository. `tests/setup/shell.ts` keeps the shell whole while a scenario
records, but for the two catalogue variables; `tests/setup/personal.ts` keeps `IDP_REPO` and the
personal configuration out; `tests/setup/forge.ts` (6.1.1) still applies, which moves `HOME`,
points the proxy variables at a closed local port for git and gh, and removes
`NODE_USE_ENV_PROXY`, so Node's `fetch`, which the provider SDKs use, never sends a call to that
port (6.1.1's seventh row of the floor): the owner has nothing to check or unset.
A recording whose provider call fails is run once more; a recording whose scenario **assertions**
fail is not retried until a sample passes: the run writes nothing (a failed run writes no tape), the
old tape stays, and the output goes to the implementer and the owner, who decide. This pull request
merges when all twelve are recorded, or with the owner's decision, dated in the roadmap, to leave
one — which is then the one entry of `LEFT_BY_THE_OWNER`, in this pull request, so the tests
above stay green and say which tape was left.

- [ ] **Step 3: `SENT` re-measured, and the tapes read (implementer)**

```bash
pnpm vitest run tests/scenarios
for f in tests/recordings/*.json; do diff <(git show main:"$f" | jq -S '[.turns[] | select(.turn == 0) | {agent, system: .call.system}]') <(jq -S '[.turns[] | select(.turn == 0) | {agent, system: .call.system}]' "$f") > /dev/null || echo "$f"; done
```

Expected: every scenario green but `prompt-digests.test.ts`'s `SENT` comparison, whose actual
values are the new ones: they are written into `SENT` (`FIRST_SENT` untouched and green), and its
comment says they were measured on this branch after the owner's re-record, over tapes recorded
under `sent:sha256:`. The loop prints nothing: every agent's first system prompt is the one each
tape held. Then each tape is read before it is committed: it holds what the scenario's own
temporary repositories and the demo catalogue contain, and `carries no credential` is green. A
difference in turn count from the table above is expected and said in the pull request, per tape.

- [ ] **Step 4: The documents**

- `tests/README.md`, *What makes a tape stale*: the paragraph on turns "recorded before" says no
  tape holds one since this re-record, and that the replay still compares a `sha256:` turn in its
  own scheme, for a tape from an older branch; *The tapes*: `question-mode.test.ts` turns the
  warning into a failure like the other two.
- `docs/roadmap.md`, *Recordings that need the owner's key*: the first two items leave (closed,
  with this pull request's link); *No Anthropic recording exists* names the providers the twelve
  are now recorded with; the sweep's *Recordings and what the scenarios pin*: agents-llm-9's
  re-record done, tests-4's guard and the forced-turn fallback's digest left.
- `docs/reviews/2026-09-23-deep-review.md`, Status: tests-6 and wip-diff-12 fixed for every tape
  (this pull request); agents-llm-9, the re-record done, the two remainders named.
- `AGENTS.md` and the README's badge: the test count re-measured (one test added).

- [ ] **Step 5: Checks**

```bash
df -h "$TMPDIR"
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm vitest run tests/architecture --reporter=verbose
git diff main --stat -- src tests/golden fixtures/si-demo
```

Expected: green, with no key and no network; 29 rules; the diff lists nothing under `src/`,
`tests/golden/` or `fixtures/si-demo/`.

- [ ] **Step 6: The pull request** (after the owner's go-ahead; the owner has read the tapes' diff)

```bash
git add tests/recordings/link-db-exists.json tests/recordings/link-db-missing.json \
  tests/recordings/link-ambiguous-env.json tests/recordings/link-already-declared.json \
  tests/recordings/repair-malformed-owner.json tests/recordings/question-backstage-owner.json \
  tests/recordings/question-organisation-owns.json tests/recordings/question-organisation-system.json \
  tests/recordings/question-prod-databases.json tests/recordings/question-consumers-of-billing-db.json \
  tests/recordings/question-unanswerable-ranking.json tests/recordings/mutation-classified-link.json \
  tests/scenarios/left.ts tests/scenarios/plan-mode.test.ts tests/scenarios/question-mode.test.ts \
  tests/scenarios/prompt-digests.test.ts tests/README.md AGENTS.md README.md docs/roadmap.md \
  docs/reviews/2026-09-23-deep-review.md CHANGELOG.md docs/plans/stage-6-github.md
git commit -m "test(scenarios): record every tape again under the digest of what the provider is sent"
```

Base `docs/s6-adr-0015`. CHANGELOG, `### Changed`:

> - Every tape recorded before 2026-09-30 is recorded again by the owner, with their key, so every
>   turn of the twelve carries the digest over what the provider is sent, tools included, and a
>   change to a tool's description or bounds now warns on every tape; the question tapes, stale
>   since #54, replay clean, and `question-mode.test.ts` fails on a stale tape as the other two
>   scenario files do. The requests the code builds are those it built before; what the models
>   answered is new ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** nothing of the CLI. For a contributor: a change that reaches a
tool's `.describe()`, `.max()` or `.regex()` now stales every tape that sends it, and a stale
question tape fails the suite.

**What the owner can run.** In the session, after 6.4.1's live run, from the worktree holding
`chore/s6-tapes`, with your provider keys exported in this shell as you export them for `idpa`:

```bash
cd "$HOME/Documents/idp-agent-worktrees/s6-tapes"
pnpm install
printenv OPENAI_API_KEY | wc -c
printenv MISTRAL_API_KEY | wc -c
```

Attendu :
- each `wc -c` prints a number above 1: the key is set, and is not printed.

The eight OpenAI tapes, one command each:

```bash
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/plan-mode.test.ts -t 'link-db-exists: proposes the access alone'
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/plan-mode.test.ts -t 'link-db-missing: the database is not in the catalogue'
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/plan-mode.test.ts -t 'link-ambiguous-env: the request names no environment'
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/plan-mode.test.ts -t 'link-already-declared: the access is in the repository already'
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/plan-mode.test.ts -t 'repair-malformed-owner: a group outside the catalogue'
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/backstage-mode.test.ts -t 'answers who owns billing-api from a Backstage catalogue'
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/backstage-mode.test.ts -t 'answers what team tiger owns with the relation block'
IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/backstage-mode.test.ts -t 'answers which system billing-api is in'
```

Attendu : each command passes one test (the others of its file are skipped by `-t`) and rewrites one
tape; about a minute each for the plan-mode five, seconds for the three questions.

The four question-mode tapes, recorded with Mistral as before (without a Mistral key, run these
four with the two OpenAI values above instead, and say so: the roadmap then names one provider):

```bash
IDP_PROVIDER=mistral IDP_MODEL=mistral-small-2603 IDP_RECORDING=record pnpm vitest run tests/scenarios/question-mode.test.ts -t 'answers a question with the table the graph itself would print'
IDP_PROVIDER=mistral IDP_MODEL=mistral-small-2603 IDP_RECORDING=record pnpm vitest run tests/scenarios/question-mode.test.ts -t 'names the services that reach a database'
IDP_PROVIDER=mistral IDP_MODEL=mistral-small-2603 IDP_RECORDING=record pnpm vitest run tests/scenarios/question-mode.test.ts -t 'refuses a question the catalogue cannot answer'
IDP_PROVIDER=mistral IDP_MODEL=mistral-small-2603 IDP_RECORDING=record pnpm vitest run tests/scenarios/question-mode.test.ts -t 'classifies a change request and declines it'
```

Attendu : each passes one test and rewrites one tape.

Then, without any of those variables, replaying:

```bash
pnpm vitest run tests/scenarios
git status --short tests/recordings
git diff --stat tests/recordings
```

Attendu :
- every scenario passes with no key, but `prompt-digests.test.ts`'s `SENT`, which the implementer
  re-measures next (its `FIRST_SENT` passes);
- `records every turn under the digest of what the provider is sent` passes, and no line says
  `the prompt changed since recording`;
- `git status` lists the twelve tapes as modified, and nothing else;
- read the diff before handing it over: each tape holds the scenario's own small repositories and
  the demo catalogue, never a file of yours.

---

## Questions for the owner

All four settled by the owner on 2026-09-30: the second as written, the other three as the
alternative this section offered. The last line of each still says what the other answer was, so
a later reversal knows where to look. The note's § 18 and § 19 were settled before and none was
reopened here. (When design §4.2 and `AGENTS.md`'s *Authorisation* bullets change was not one of
them: decision 1 says "changed in design §4 first", so they change in 6.2.2, the pull request
that makes the invariant true, before `SECURITY.md` guarantees it.)

1. **Settled: `--local: nothing pushed by this run`.** `--local` starts no gh and reads nothing
   on GitHub, so it cannot know whether an earlier run without `--local` pushed the same branch;
   the line says what this run did, which is true whatever GitHub holds (*Exact lines*, 6.2.2's
   table, tests, demo and smoke, and the `--local` cases of 6.3.1, 6.3.2 and 6.3.3). The other two
   local roads' lines keep their `nothing pushed`: with no remote, or a remote on another host,
   no run pushes. The alternative was `--local: the branch is in this clone only; nothing pushed`,
   false once an earlier run had pushed the branch.
2. **Settled: no role on the "submitting to" line.** gh's identity has a budget of two calls (the
   version and `/user`), so the role is read by the preflight, which runs after the line is
   printed: the line reads `as <login> (gh)` on every road, and `idpa protection`'s block names the
   role (Choices). The alternative was the note's `as <login> (gh, admin)`, printed after the
   preflight: after the source notice on the intent and phrase roads and after any exit-1
   refusal, with no line before the exit-2 gh sentences.
3. **Settled: the suite removes `NODE_USE_ENV_PROXY`.** `tests/setup/forge.ts` (6.1.1) still
   points the proxy variables at a closed port while a scenario records, for git and gh, and
   removes Node's switch always, recording included, so Node's own `fetch` never uses the closed
   proxy while git and gh children still see it; the floor's seventh row proves a switch set
   before the setup is gone after it, and 6.4.3 gives the owner nothing to check. The alternative
   was 6.4.3's first command checking for the switch and telling the owner to unset it (or
   `forge.ts` leaving the proxy variables alone while `IDP_RECORDING=record`).
4. **Settled: exit 3 for a question put to `idpa "<phrase>" --submit`** (6.3.3), `unsupported` in
   prose and in `--json` alike: the mirror of a change put to `ask`, understood and not acted on.
   6.3.3's `AGENTS.md` step lists it under `3`, and Global Constraint 9's "one exit 2 after a
   model call" became none that this stage adds. The alternative was exit 2, thrown as a
   `RepositoryArgumentError`: the note's "refused as today" (D8's refusal is exit 2), `AGENTS.md`
   keeping `3` for a boundary no typing moves, and a change with no repository, refused after the
   Supervisor's word, being exit 2 on `2b2250e`.

## Rejected alternatives

The note's [§ 20](../stage-6-brief.md#20-rejected-alternatives) lists them, each with its reason,
and this plan builds none of them. They are:

- a dedicated fine-grained token with idpa's own REST transport;
- a push without gh, or a `--no-pr` flag;
- `gh pr create`;
- a push to the remote by name, or without the lease;
- `GIT_CONFIG_NOSYSTEM` or a private `GIT_CONFIG_GLOBAL` for the push;
- reading gh's token;
- merging on confirmation;
- keeping design §4.2's sentence;
- a merge probe;
- `mergeable_state`;
- `permissions.admin` as the test;
- classic branch protection;
- the base in the digest;
- a fork workflow;
- a GitHub App in v0.1;
- trusting `html_url` or any tool's output;
- reopening a closed pull request, or pushing onto a branch under review;
- the live test in CI;
- a forced update of `main` in the live test.

This plan also rejected some options where the note left the choice open. Each is argued in the
task that made the choice:

- **Zod in `forge/`.** `forge/` imports no package, so the pure parts live in `core/github/`
  (drift row 4).
- **`process/` importing `core/github/`'s grammars.** `process/` imports nothing of ours. It
  keeps two copies, and a test holds them to the same answer (6.1.2).
- **Injecting a `GhClient` in place of the process.** A fake client would never meet the
  launcher's check of the final vector (Choices).
- **Treating a URL with no readable host as exit 2.** That would refuse the local-path upstreams
  stage 5 submits to (6.1.2).
- **Reading the role in `readIdentity`.** It would break § 15's budget of 48 gh calls, which
  has no slack (6.1.2, 6.2.1).
- **Holding the interim refusals in `cli/`.** `cli/` cannot read the road without loading the
  git launcher, and gh would start before that road's key-reach leg lands (6.2.2).
- **`treeFor` through `mktree`.** It would write objects, and the git grammar would gain a
  shape (6.2.1).
- **Importing `vitest.config.ts` from a test.** Importing it creates a second run directory
  (6.1.1).
