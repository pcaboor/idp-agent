# `backstage-http` slice 2 — scale and cache

**Status: 2.1 built ([#119](https://github.com/pcaboor/idp-agent/pull/119)); 2.2 built
([#120](https://github.com/pcaboor/idp-agent/pull/120)); 2.3 built
([#122](https://github.com/pcaboor/idp-agent/pull/122)). The slice is closed.** Three stacked pull
requests, 2.1 to 2.3, after this plan merged on its own (`docs/bhttp-slice-2-plan`, #117).
The owner's answers to the five questions are [at the end](#questions-for-the-owner), settled
on 2026-09-30, each as recommended, so the plan is built as written.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

**Goal.** Two things a real, large catalogue needs before it is plugged in. First, a
catalogue past a bound of this version is **answered in part and says so**, where today it is
refused: what the bound left out is *not loaded*, a state beside *declared nowhere*, so a
reference into the part not read is never called dangling, every answer built from a partial
graph says it is partial, and a stderr line of its own (`past the bound:`) counts what the
bound left out. Second, **a disk
cache**: a catalogue read is kept for five minutes under `$XDG_CACHE_HOME/idp-agent/backstage/`,
in folders only the person's account can open, keyed by an HMAC of the catalogue and the token
under a per-machine secret, sealed by a MAC over every byte of it and the key it was kept
under, and every read of it goes through the pre-pass, the load's own checks and `readValue`
again, so a file on disk is never a source that skips the reader.
`--refresh` reads Backstage again; `--cached` reads the kept copy whatever its age, and only
when asked. The age is always stated. Nothing kept reaches a plan: Backstage answers, Git
decides.

**The design** is [`docs/backstage-http-brief.md`](../backstage-http-brief.md), § 13 slice 2,
with § 6 (the bounds), § 8 (trust), § 10 (failure) and the owner's answers 5, 6 and 7 of § 14.
Slices 1 and 3 are built ([slice 1's plan](backstage-http-slice-1.md), #92 to #98;
[slice 3's](backstage-http-slice-3.md), #99 to #101, and #103). Every file, function and line
named below was read on `main` at `55fb995`; the section
[Where the code moved since the note](#where-the-code-moved-since-the-note) says where the
note's assumptions no longer hold.

**Closed by** 2.3, the note's "Closed by 2.2" moving one pull request, as slice 3's did: a
second run against a large fake catalogue answers in under a second and says `read from cache,
3 min old; --refresh reads Backstage again`, and a catalogue over the bound answers with `not
loaded` rather than refusing. Both are shown against `tools/fake-backstage.ts --scale 20500`
on port 7011, keyless.

**Architecture.** From the inside out, as slices 1 and 3 went.

- **2.1, the partial graph.** The load stops a read at its ceiling instead of throwing
  `too-many`, and says how far it got (`Served.bounded`). `LoadResult.partial` carries it to
  `EntityGraph`, which keeps a reference into a kind whose read was bounded out of
  `danglingReferences()` and `unresolvedOf()`, in a list of its own (`notLoadedReferences()`);
  an organisation read that was bounded is not judged, which slice 3's rule already reads as
  "a name, never declared nowhere". The notice, `graph`, `show`, `relations`, the overview, a
  question's blocks, the summary and the Analyst's rows say it — **only when the graph is
  partial**, so every whole read prints and sends the bytes it does today. No cache yet.
- **2.2, the store.** `context/backstage/cache.ts`, the first disk writer in `context/`: the
  per-machine secret, the key, a copy written through `confine/` (0700 folders, 0600 files,
  exclusive creation, no link followed) and renamed into place, read back through `confine/`
  with its owner, mode, link count, MAC (header, key and body), envelope, its account of its
  own reads and every item checked again. The provider gains a `cache` option (`fresh`,
  `refresh`, `kept`) and `LoadResult.cache`, which reports what was read and what was written.
  Only the provider may load the store, a new architecture rule. No command uses it yet.
- **2.3, the command line.** `--refresh` and `--cached` on the read commands and the phrase;
  the cache root, handed to `main` by `bin.ts` and by nothing else, so no test can write under
  a real home; the notice's age; the lines that say a copy was not used or not kept; the
  failure line's `--cached` way out; the demos, the smoke test, `SECURITY.md`, the README and
  an ADR.

**Tech stack.** TypeScript 7, Node 22+ (the fake needs 22.18+ for type stripping), Vitest 5,
Zod 4, `yaml` 2, `node:crypto` for the HMAC. No new dependency.

**Branches.** This plan on `docs/bhttp-slice-2-plan` (worktree
`~/Documents/idp-agent-worktrees/bhttp2`, from `main` at `55fb995`), merged first. Then
`feat/bhttp-2-1` from `main`, `feat/bhttp-2-2` from it, `feat/bhttp-2-3` from that, one pull
request each, merged bottom-up with `--rebase`. Pull request numbers are written `PRNUM` below
and filled in when each is opened.

**Why three pull requests, not the note's two.** The note's item 1 is 2.1, and its item 2 is
2.2 and 2.3. The cache as one pull request would change `confine/`, add a disk writer to a
layer that had none, change the provider, the command line, both demos, the smoke test and
the security page at once. 2.2 is the part a security review reads line by line — who may
open a file, what is checked before a byte is read, what a race can and cannot do — and it
changes nothing a person sees, as slice 1's transport (1.3) landed with its proofs before
any command sent a request. 2.3 is the part a person sees.

## Global Constraints

Inherited and still binding: `AGENTS.md`, `docs/design.md` §4, the note's § 4, § 5, § 6 and
§ 8, and the Global Constraints of slices 1 and 3. A task that cannot keep one is stopped and
brought to the owner.

- **`pnpm test` needs no key, no network and no Docker, and writes under no real home.** No
  test opens a socket; the catalogue is `tests/support/fake-backstage.ts`, handed in as
  `catalogueFetch`. `main` uses a cache only when `MainDeps.cacheRoot` names one, which
  `src/cli/bin.ts` does and no test does unless it is a test of the cache, with a folder under
  the run directory (`tests/setup/tmp.ts`). `tests/setup/personal.ts` also points
  `XDG_CACHE_HOME` into the run directory, for a binary a test starts (2.3); `main` never
  reads that variable, only `bin.ts` does. No test on `55fb995` starts the binary against a
  catalogue (the two files that name `IDP_BACKSTAGE_URL` beside a spawn,
  `process-git.test.ts` and `spawned-environment.test.ts`, test what git inherits); one that ever does
  passes an `XDG_CACHE_HOME` of its own, so two spawned runs never share a copy.
- **Byte-neutral for every whole read.** No tape's request bytes change:
  `tests/scenarios/prompt-digests.test.ts` stays green, unchanged, through 2.3, and
  `plan-mode.test.ts` warns about nothing. The outputs of `--demo`, of `--repo`, of the fake
  without `--scale`, of the Docker demo's steps 2 to 4 on stdout, and every file under
  `tests/golden/`, do not move. `fixtures/si-demo/` is untouched. Everything 2.1 adds to an
  output, a prompt or a tool row is added only when the graph is partial, which no tape's
  source, no golden and no demo without `--scale` is.
- **Backstage answers, Git decides.** Nothing read from a catalogue, fresh or kept, reaches a
  plan's signature, policies, owner derivation, re-check or Reviewer. The cache is loaded by
  `context/backstage/provider.ts` alone (a new architecture rule, 2.2), the provider is built
  by `providerOf` alone, for the read road, and the change road reads the declarations
  repository through `readRepository` (`src/cli/commands/plan.ts:17`). 2.3 proves it with a
  kept copy holding an owner the repository does not, which the plan still asks about.
- **The token is never at rest.** No file the cache writes holds it, nor any value derived
  from it without the per-machine secret; `tests/contract/key-reach.test.ts` gains the leg
  that reads every byte under the cache root (2.3).
- **A partial answer is never silent.** Wherever a whole read would call a reference
  declared nowhere, a partial one says not loaded; wherever a whole read would say "no entity",
  a partial one says in what part it looked.
- **Hands off what another batch is changing.** No task touches `src/llm/`, `tests/recordings/`
  or `tests/scenarios/` beyond reading them (queue item 1, batch B2, rewrites the recording
  harness), nor `src/core/plan/` or `src/core/paths/`.
- **Nothing read from a catalogue reaches a committed file**: the fake's `--scale` entities
  are generated, and every new test builds its catalogue from `fixtures/si-demo` and
  `tools/backstage/org.yaml`.
- **Traceability.** Every pull request adds its line under `## Unreleased` in `CHANGELOG.md`
  and re-measures the numbers `AGENTS.md` states (the test count, also on the README's badge,
  and the architecture-rule count, which 2.2 moves from twenty-five to twenty-six) in the
  same commit. 2.3 takes slice 2 out of `docs/roadmap.md`'s queue, marks the note's slice 2
  **Built** with this plan's departures, and moves the README's roadmap row 6b.
- **Each pull request is green on its own**: `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm smoke`. The disk was at 98 %, 4.1 GiB free, when this plan was written, and the suite
  leaves temporary folders behind: `df -h "$TMPDIR"` before a test-heavy step.
- **Standing rules.** No commit, push or pull request without the owner's go-ahead. Stage
  files by name, never `git add -A`. English throughout, Conventional Commits, and no
  `switch` on a closed union without `const exhaustive: never = value` in `default`.
- **"What the owner can run"** ends every task, keyless, against `tools/fake-backstage.ts` on
  port 7011 and, for 2.3, the Docker demo; run and checked by whoever executes the task before
  it is handed over (the owner's kit lives in `~/Documents/idp-agent-tests/`). No command in
  those blocks carries a comment: what each prints is in the table under it.

---

## Where the code moved since the note

The note cites `main` at `44fcfed`; slices 1 and 3 reconciled it with `60974de` and
`f8bcb43`. `main` is at `55fb995`. Each row is an assumption of the note, or of the task
that asked for this plan, checked against the worktree, and what this plan does about it.

| # | The assumption | On `55fb995` | This plan |
|---|---|---|---|
| 1 | § 13 2.2: "a **fourth** disk writer in `context/`" | `context/` has **no** writer. Across `src/`, the modules that import a writing function are `scaffold/write.ts`, `confine/confine.ts` (since #115), `cli/recording-fs.ts` and `cli/trace-sink.ts` (`tests/architecture/dependencies.test.ts:794-830`), and the forge writes through git. Three rules bound what `context/` touches: *only context/iac-fs and context/project-fs read a user repository* (`:758-772`, whose allow-list also holds `context/fixtures/index.ts`), *only the named modules write* (`:794`), *only scaffold/write.ts, context/iac-fs and context/project-fs load confine/* (`:955`) | `context/backstage/cache.ts` is the first writer in `context/` and the fifth module in the `writes` map, with `rename`, `unlink` and `rmdir`; it joins the disk allow-list and the loaders of `confine/`, each named with why. A rule is added, *only context/backstage/provider.ts loads context/backstage/cache.ts*: twenty-six (2.2) |
| 2 | § 13 2.2: "directory 0700, files 0600 (as `fileSink`, `src/cli/trace-sink.ts:85-92`)" | `fileSink` is at `:80-95` and sets **only the file's** mode, `0o600` with `wx`; its folder is `mkdir(…, { recursive: true })` at the default mode, and it follows any link on the way | The cache sets both, and never follows a link below the root: `confine/`'s `makeFolders` and `openNew` gain a `mode` option (their callers' default unchanged), and every folder and file is checked for owner and mode on every read and write (Choices) |
| 3 | § 6: "modelled entities 20,000: refused"; § 13 2.1: "the modelled-entity ceiling then becomes a bound stated" | Three ceilings (`src/context/backstage/limits.ts`): `modelledEntities` 20,000, `organisationEntities` 200,000 (slice 3), `otherRefs` 200,000, each refused with `too-many` at `src/context/backstage/load.ts:159` (announced by `totalItems`) and `:167` (as items arrive) | **All three** become stated bounds, with one semantics: what a bounded read left out is not loaded, and an organisation read that was bounded is not judged (Choices; question 3) |
| 4 | § 6: "not loaded, beside `Unresolved` at `entity-graph.ts:39-53`" | `Unresolved` is at `src/context/graph/entity-graph.ts:45-61`. Slice 3 added `OrganisationUnresolved` (`:85-90`), `OrganisationUnread` (`:99-106`) and the judged-kind rule (`:360-385`): an organisation reference whose kind was not read whole is a name, never declared nowhere | `NotLoaded` sits beside `Unresolved`, for the write model's three fields. For the organisation, the judged-kind rule is the not-loaded state already: a bounded organisation read leaves `judged` empty (`load.ts`'s `judged`, `:197`) |
| 5 | § 13 2.2: the cache "holds the raw entity JSON as served" | Slice 3's owner decision 2: of a User or a Group, no profile, annotation or title "is kept anywhere"; a server that ignores `fields` serves them, the pre-pass drops the profile and the reader the rest (`load.ts:76-86`, `ORGANISATION_FIELDS`). § 14 decision 5: API definitions "fetched and discarded" — the reader keeps one as the literal `declared` (`definitionSchema`, `src/core/schemas/entity.ts:449-457`) | Raw, with two minimisations that change no reading: an organisation or refs item is kept as the fields its read asked for, which is what a Backstage honouring `fields` serves; an API's `spec.definition` that the reader reads as declared is kept as the string `declared`. Everything else as served, `relations` and `status` included (Choices) |
| 6 | § 13 2.2: "every read of it runs the pre-pass and `readValue` again" | `BackstageProvider.load` already separates the load (`loadCatalogue`, returning the raw `Served`, `provider.ts:49`) from the translation (the loop at `:57-94`) | The store keeps a `Served`, and the provider's loop runs on a kept one unchanged. The load's own item checks — a string uid, a kind the read asked for, the ceiling, the distinct count — are extracted (`admitted`, 2.2) and run on a kept copy as on a page |
| 7 | § 10's failure line for `too-many` | `src/cli/source.ts:829-836` words the organisation scope "entities of other kinds", where `transport.ts`'s `scopeWords` (`:116-129`) says "Groups, Users, Systems and Domains" | Moot: 2.1 removes `too-many` from `CatalogueFailure`, and both switches lose the case |
| 8 | § 10: "never a fall back … to a cache"; § 14 decision 7: "a cached read only when asked (`--cached`)" | A failed read is one line, exit 1, `catalogueFailureLine` (`source.ts:772-778`), naming `--repo` and `idpa plan` | No automatic fall back. `--cached` reads the copy and never asks Backstage. The failure line names `--cached` as a way out only when a copy is kept **and** the failure is one of reach (unreachable, a timeout, a 5xx, 429), never after a 401 or a 403, which may be a revoked token (Choices) |
| 9 | § 8: `--backstage` takes no value | The read commands share `READ_OPTIONS` (`src/cli/index.ts:873-877`) and `readFrom` (`:884-905`); the phrase has its own parser (`parsePhrase`, `:656`) | `--refresh` and `--cached` join both, boolean, refused with `--repo` or `--demo`, with each other, and against a source that is not a catalogue (2.3) |
| 10 | Tests inject what a run reads | `main` defaults `catalogueFetch` to the global inside itself (`index.ts:1719`); `bin.ts` is four lines | The cache root is deliberately **not** defaulted inside `main`: `bin.ts` computes it and hands it in, so every existing `main(…)` call in the suite runs with no cache, byte for byte as today (Choices) |
| 11 | The demos run in a person's shell | `scripts/demo-backstage.mjs:47-49` and `scripts/demo-backstage-docker.mjs:203-209` hand the binary the contributor's `HOME`; `scripts/smoke.mjs:119-123` points only `XDG_CONFIG_HOME` away. Both demos already read one base twice, seconds apart: the fake demo's steps 1 and 2 (`demo-backstage.mjs:146-160`, then a count of the requests "for the two reads"), the Docker demo's steps 2 to 4 (`:247-253`) | With the binary caching, each would write under the contributor's `~/.cache` — and the fake listens on a new port each run, a new key each time. Each demo points `XDG_CACHE_HOME` at a folder in its own scratch, and smoke at one in `ELSEWHERE` for its own runs (2.3). The fake demo's step 2 **is** the second read: it becomes "answered from the copy step 1 kept", its request count step 1's alone; no step is added |
| 12 | ADR-0011: "A read the catalogue could not give whole is refused"; "A disk cache in this slice — … slice 2 decides it" | `docs/adr/0011-backstage-to-explore.md:23-25`, `:41-42`; the last ADR is 0012 | ADR-0013 (2.1), *a catalogue past a bound is read in part and says so*, and ADR-0014 (2.3), *a catalogue kept on disk is read again through the reader*; 0011's status line says "amended by 0013 and 0014". Stage 8's evidence ADR takes the next free number, as the roadmap says |
| 13 | § 8: the trace's root attributes | `sourceAttributes` (`index.ts:1741-1756`), asserted with `toMatchObject` (`tests/unit/backstage-read.test.ts:516-522`) | 2.1 adds `idp.source.not_loaded`, 2.3 `idp.source.cache_read`, `idp.source.cache_written` and `idp.source.cache_age_s`; no attribute is removed |
| 14 | § 13 4.3: slice 4's gate makes "a fresh read, the cache bypassed" | Not built | The provider's `cache: { use: 'refresh' }` is that read; 2.2's interface says so, so slice 4 has nothing to invent |
| 15 | § 13: "a large fake catalogue" | `tools/fake-backstage.ts` serves a folder, `org.yaml` and, for tests, `groups` (`catalogueOf`, `:142-158`); nothing generates entities at scale | `--scale <n>` and `catalogueOf(root, { scale })`: `n` generated Components whose uids sort after the demo SI's, so what a bound leaves out is predictable (2.1) |
| 16 | The cache is POSIX | `confine/`'s `O_NOFOLLOW` does not exist on Windows (`confine.ts:47`), and neither does `process.getuid` | No cache on Windows: the root is none there, and `--cached` says why (Choices) |
| 17 | § 6: "not loaded" beside `Unresolved` | `not loaded:` already begins the stderr line that counts documents of a kind this tool does not model (`notLoaded`, `src/cli/index.ts:1797-1813`, printed at `:1490`), the overview has a `not loaded` row with that meaning (`src/cli/render/overview.ts:139`), and `README.md:656` pastes it | `not loaded` stays the **per-reference** marker the note names, beside `declared nowhere`. The count of what a bound left out gets words of its own: the notice's term `N past the bound` and a line `past the bound: …`; the overview's block is headed `partial`. The existing line and row do not move, so a whole read stays byte-identical (question 5) |
| 18 | The cache root exists | `realRootOf` is `realpath(path.resolve(root))` (`confine.ts:79`), which throws `ENOENT` for a missing path, and `makeFolders` makes names only below a real root (`:212-229`). A fresh macOS account has no `~/.cache`; the suite's `XDG_CONFIG_HOME` is a path no one made | A missing `<root>` is made, `0o700`, when its parent is a folder; a deeper absence makes the store unusable (Choices). The smoke test, the demos and the setup file rely on that rule rather than each making the folder |
| 19 | `openToRead` refuses only links | `holdsInside` compares the inode opened with the one the name names a moment later (`confine.ts:150-163`) and `openToRead` throws `LinkRefused(path, true)` when they differ (`:188-189`): a sibling run's `rename` of a new copy over `served.json` between the two is refused as a link | The store tells the two apart: after that refusal, a name that is now a regular file with no link above it is a copy **replaced**, and is opened again, at most three times in all (Choices) |
| 20 | One set of bounds per build | `BackstageProvider` takes `limits` overrides (`provider.ts:34-40`), which `MainDeps.catalogueLimits` passes through (`index.ts:957`, `:1720`) | The key is over `readShapeOf(limits)`, the effective bounds, not a constant, and a copy's stated bounds are checked against them |

Nothing on the list reopens a decision of § 14.

## Choices this plan makes where the note leaves one

### 2.1, the partial graph

- **All three ceilings, one semantics.** A read that reaches its ceiling stops there, keeps
  what it read, and says so in `Served.bounded`: its scope, its kinds, how many it read, how
  many the catalogue announced (`totalItems`, or unknown when the server announced fewer than
  it served), and the bound. The modelled read, bounded: every reference to a Component, a
  Resource or an API that resolves to nothing is not loaded. The refs read, bounded: every
  reference to one of its kinds that resolves to nothing is not loaded. The organisation
  read, bounded: `judged` is empty, so an owner, a system or a membership naming nothing is a
  name, as over a repository, and a `dependsOn` naming a Group or a System that resolves to
  nothing is not loaded. The note names the modelled ceiling only; refusing at the 200,001st
  User while answering at the 20,001st Component would give the rarer case the harsher
  answer, for the same reason the bound exists (question 3).
- **The byte and time bounds stay refusals.** `bytesPerResponse`, `bytesPerRun`,
  `requestMs`, `loadMs`, the cursor loop, a missing uid, an unasked kind and fewer uids than
  announced on a whole read are what a broken or hostile server does, and a read cut there is
  cut wherever the server chose. A count ceiling is a fact about the catalogue's size, and
  where it cuts is stated.
- **Where a bounded read stops.** A first page whose `totalItems` passes the ceiling does
  not stop the read: it only marks the read bounded and records `total`. The read stops when
  `seen.size` reaches the ceiling, on whichever page that happens: that page's items up to the
  ceiling are kept, the rest are not loaded, and no further page is asked for. So a ceiling of
  20,000 at a page size of 250 reads 80 pages of the modelled kinds. The part kept
  is the first in the server's order — keyset on `entity_id` in Backstage, uid order in the
  fake — which the notice does not pretend is anything else: "not loaded" names no entity,
  it counts them.
- **`PartialRead` lives in `context/provider.ts`**, beside `LoadResult`, and `ReadScope`
  moves there from `transport.ts` (re-exported), so `EntityGraph` can name them without
  importing `context/backstage/`: `agents/` reaches the graph, and nothing it reaches may be
  in `context/backstage/` (*nothing reachable from agents/ is in context/backstage/*, `:923`).
- **A reference is not loaded by its kind**: the prefix the reader wrote in full
  (`qualifiedSpec` writes every reference it can split in full, `src/core/schemas/entity.ts:148`), lower
  case, among the kinds of a bounded read. A reference with no kind the grammar can split is
  what it is today, declared nowhere or not. This **narrows the note**, which says an
  unresolved reference in a partial graph is never called dangling: a reference into a kind
  that was read whole — a Template the catalogue does not hold, when only the modelled read
  was bounded — is still declared nowhere, because the read of its kind was whole and the
  answer is known. Recorded among the departures in `Built` (2.3 Step 7).
- **Not loaded is a list of its own**, as slice 3 kept the organisation's: `DeclaredField`,
  `Unresolved`, `danglingReferences()` and `unresolvedOf()` keep their meaning, *declared
  nowhere in what was read*, and simply no longer hold a reference into a bounded kind. So
  `validate` (the file road never bounds) and every consumer of them are unchanged; the
  places that must say "not loaded" read `notLoadedOf(ref, field?)` and
  `notLoadedReferences()` on purpose: `show`'s sections, `relations`' path ends, `graph`'s
  closing lines, the overview, the Analyst's rows, and `ask`'s `known` set.
- **Said only when partial, in the engine's words.** `not loaded` is the marker a
  **reference** carries, beside `declared nowhere`, as the note names it. The count of what a
  bound left out never begins with those words, because `not loaded:` already begins the line
  counting documents of a kind this tool does not model, and the overview's `not loaded` row
  (row 17): the notice gains a term (`533 past the bound`) and a line of its own on stderr,
  `past the bound: …`, after the existing `not loaded:` line; `graph`, `show` on a hit,
  `relations` and a question's `relation` block gain one closing line; the overview a first
  block, headed `partial`, and a list of the references past the bound headed `past the bound`;
  "No entity named" and
  "No entity matches" name the part they looked in; the Supervisor's and the Analyst's
  summary gain one line; an Analyst row gains `notLoaded` when it has one. None of it exists
  on a whole read, which is what keeps every tape, golden and demo as it is. One wording for
  the bound everywhere, stderr, stdout and prompts alike: `this version's bound of N`.
- **`show` on a hit says it too.** Its sections are what was read; its `used by` and
  `consumed by` cannot count a dependant past the bound. The stderr line says the graph is
  partial, but stdout is what a person pipes or pastes, and *a partial answer is never
  silent* (Global Constraints). So a hit ends with the same closing line as `relations`:
  `partial: 533 Components, Resources and APIs were not loaded, past this version's bound of
  20,000; what they declare is not in these sections`. On a whole read there is no such line,
  and `show`'s goldens do not move.
- **The summary says the scope and the bound, never the counts.** `summariseGraph` buckets
  counts so that a catalogue growing by one does not move a prompt; "read in part" with the
  kinds and the bound is the health fact, as `danglingReferences` is.
- **The fake at scale.** `--scale <n>` (1 to 99,999) adds Components `scale-00001` … whose
  uids are `ffffffff-ffff-4fff-8fff-<index, 12 digits>`, after every uid `uidOf` derives from
  a sha256 of the demo SI (asserted), each owned by `group:default/common`, type `service`,
  lifecycle `production`, located at `url:https://github.com/acme/si-demo/blob/main/scale/<name>.yml`,
  and each but the last `dependsOn` the next. So with `--scale 20500` the modelled read holds
  20,533, the first 20,000 in uid order are the demo SI's 33 and `scale-00001` to
  `scale-19967`, 533 are not loaded, and `scale-19967` names the one reference that is.

### 2.2 and 2.3, the cache

- **Where, and who may open it.** `<root>/idp-agent/backstage/`, where `<root>` is
  `$XDG_CACHE_HOME` when it is absolute, else `$HOME/.cache` — the same resolution
  `personalConfigFile` makes for `XDG_CONFIG_HOME` (`src/cli/personal.ts:64-78`), read from
  the environment and never from `os.homedir()`. `<root>` is the person's, followed if it is a
  link (`realRootOf`, as a directory the person names always is). From `idp-agent/` down:
  every name a folder, never a link, owned by the running uid; `idp-agent/` writable by no one
  else; `backstage/` and everything in it open to no one else (no group or other bit); every
  file a regular file with one link. Made with `0o700` and `0o600`, so a umask can only narrow
  them. Every name, folder or file, is judged by one pure function,
  `acceptable(stats, owner, kind)`, so each rule is tested on synthetic stats as well as on a
  disk. A name that fails is never repaired, removed or `chmod`-ed: the store is not used this
  run, and one stderr line says which path and why (`shownPath`, `~` for the home).
- **A missing root is made, one name deep.** A fresh macOS account has no `~/.cache`, and
  `realRootOf` cannot resolve what does not exist (row 18). When `<root>` is missing and its
  parent is a folder (followed, as the root is), `<root>` is made with `0o700`, as the XDG base
  directory specification asks — `realRootOf(parent)`, then
  `makeFolders(realParent, basename, { mode: 0o700 })`, which follows no link and refuses one
  planted there — and only then is `realRootOf(root)` taken. A missing parent makes the store
  unusable (`io`, `ENOENT`) and nothing is made: the tool makes the one folder the person's
  environment names, never a chain of them.
- **Never as root.** A run whose uid is 0 keeps and reads nothing: `cacheRootOf` returns
  `{ none: 'root' }`. `sudo` can keep the caller's `HOME`, and one `sudo idpa graph` would
  otherwise leave a tree of company data owned by root in the person's home, which every later
  run of theirs refuses as foreign and none of them can remove without `sudo`. `--cached` as
  root is exit 2, naming why.
- **What a copy is.** `backstage/<key>/served.json`: one header line, then the body as lines
  of JSON.
  ```json
  {"format":"idp-agent/backstage-cache/1","origin":"http://127.0.0.1:7011/api/catalog","fetchedAt":"2026-10-01T09:14:03.120Z","count":20007,"bytes":18234567,"mac":"<64 hex>"}
  ```
  The header is at most 4 KiB. The body's first line is the envelope —
  `{"startedAt":…,"asked":{"organisation":[…],"refs":[…]},"bounded":[…],"census":{…},"counts":{"whole":…,"organisation":…,"refs":…}}`
  — then one line per item: the modelled read's, then the organisation read's, then the refs
  read's, as many of each as `counts` says. Each line is at most `bytesPerResponse`, so no
  parse of a copy is larger than a page's on the live road, and the whole body is never one
  string. `judged` is **not kept**: it is recomputed from `asked.organisation` and `bounded`
  as the load computes it. `fetchedAt` is when the load **began** (`Served.startedAt`), so an
  age is never understated by the time the load took, and the header's must equal the
  envelope's `startedAt`. `mac` is HMAC-SHA256 under the secret over
  `idp-agent/backstage-cache/1\n`, the key (the folder's name), `\n`, the header's canonical
  form without `mac` (its five other fields, in the order above, through `JSON.stringify`),
  `\n`, and every byte of the body. So a flipped byte anywhere — a digit of the header's
  `fetchedAt` included, which would otherwise turn a stale copy fresh — fails the MAC, and a
  copy moved or restored into another key's folder fails it too: the key it is read under is
  not the one it was sealed under. The header holds no token and nothing derived from one.
- **The secret.** `backstage/secret`: 64 lower-case hex characters and a line break, from
  `randomBytes(32)`, `0o600`, read like a copy (`openToRead`, then `acceptable` on the
  descriptor). A secret that is a link, open to group or other, linked twice or another uid's
  makes the store **unusable**, said with its path, and is never made again over: that is a
  name to look at, not to replace. Only a secret that passes `acceptable` and is not that
  shape — truncated, emptied — is made again: written to a temporary file of its own, then
  renamed into place. A new secret changes every key, so every earlier copy is unreadable
  from then on, which the pruning removes; that is also what deleting the folder does.
- **The key.** The first 32 hex characters of HMAC-SHA256(secret, `key\n` +
  `JSON.stringify([CACHE_FORMAT, base.href, token ?? '', readShapeOf(limits)])`). `base.href`
  is the whole catalogue base, path included, since two bases on one origin are two
  catalogues; `token` because two tokens can see two catalogues (a static token sees
  everything, a person's own the permission policy's share); `readShapeOf(limits)`
  (`load.ts`) is the fields each read asks for, the three ceilings and the two byte bounds of
  **the limits the provider was given** — `{ ...BACKSTAGE_LIMITS, ...options.limits }`, as
  `provider.ts:40` builds them — so a version that reads other fields, or a run under other
  bounds (a test's lowered ones included), never reads a copy made under these. An HMAC, not a
  hash: a short token hashed plainly can be recovered offline from a folder name, and this
  cannot without the secret.
- **Writing a copy.** After a load that ended with a `Served` — whole or bounded, never after
  a failure — and before the translation: the folders made or checked (`makeFolders`,
  `0o700`), the copy written to `<key>/served.json.<pid>.<random>.tmp` (`openNew`,
  `O_CREAT | O_EXCL | O_NOFOLLOW`, `0o600`), the folders checked again, `served.json`
  `lstat`-ed — a link there, or anything but a regular file, is refused (`not-written`, said
  with its path) and left as it is, the temporary file unlinked, since the store repairs
  nothing — then `rename` over `served.json`. A link planted between that `lstat` and the
  `rename` is replaced as a name, its target never opened or written. A write that fails never
  fails the run: the answer is given, and one line says the read was not kept and why.
- **Reading a copy**, in this order, everything after the open on the descriptor:
  1. `openToRead` (`O_NOFOLLOW`, and the folders asked again once the descriptor exists).
     When it refuses with `LinkRefused(…, true)` and the name, `lstat`-ed at once, is a
     regular file with no link among the folders above it, a sibling run renamed a new copy
     between the open and the check (row 19): the copy was **replaced**, and it is opened
     again, three opens in all, then `busy`. A link is refused on every open, as `link`. The
     secret is opened the same way.
  2. `acceptable` on the descriptor's stats; a size of at most `bytesPerRun` plus 4 KiB.
  3. The header: a line break within the first 4 KiB, decoded with
     `TextDecoder('utf-8', { fatal: true })`, its shape, its format, its origin equal to the
     configured base.
  4. Under `fresh`, the header's `fetchedAt` first: a copy past the TTL, or dated after now,
     is `stale` and is **not read further**. Skipping only reads less, so an unauthenticated
     age is enough to skip; nothing of that copy is used. Under `kept`, and for a copy that
     is fresh by its header, verification goes on, and the age an answer states is taken
     only after step 5 has covered it.
  5. The body's length equal to `bytes`; the MAC.
  6. Each line decoded fatally and parsed alone, at most `bytesPerResponse`; the envelope
     (Zod); `fetchedAt` equal to `startedAt`; as many item lines as `counts` says.
  7. **The copy's account of itself**, which a live read derives and a copy only states — so
     a copy cannot choose what a hostile Backstage cannot: `asked.organisation` a subset of
     `ORGANISATION`'s keys, in their order; `asked.refs` sorted, each matching `KIND`, none
     among `MODELLED` or `ORGANISATION`; at most one `bounded` entry per scope, its `kinds`
     its scope's asked kinds, its `limit` the effective ceiling of its scope, its `read`
     equal to that limit, its `total` absent or above it; `census.served` equal to the
     number of items. Then `judged` is recomputed from them.
  8. Every item through `admitted`, with the effective ceilings and the kinds of step 7; the
     distinct uids across the three reads equal to the header's `count`.

  Only then is it a `Served`, and the provider's loop runs the pre-pass and `readValue` on
  every item, as on a page. Anything that fails is **no copy**, said once: "the kept copy of
  this catalogue did not verify (`<reason>`) and was not used"; a fresh read then replaces it.
- **Minimised, never re-shaped.** An organisation item is kept as `ORGANISATION_FIELDS`
  project it, a refs item as `REFS_FIELDS` do — what a Backstage honouring `fields` serves,
  so nothing of a User's profile or annotations is at rest even when a server ignores
  `fields` — and an API's `spec.definition` that the reader reads as declared (the exported
  predicate `readsAsDefinition`, `core/schemas/entity.ts`) as the string `declared`, which the
  reader reads the same (decision 5: fetched and discarded). A definition the reader refuses
  is kept as served, so a kept copy refuses it too. Tested: a copy reads as the read it was
  made from, entity for entity, rejection for rejection; the one difference is the `not read:`
  line of a server that ignored `fields`, whose extra keys were never kept.
- **Fresh, refreshed, kept.** The provider's `cache.use`: `fresh` (a run with neither flag)
  reads a copy whose age is at least zero and under `CATALOGUE_CACHE.ttlMs` (5 minutes), else
  reads Backstage and writes; `refresh` (`--refresh`, and slice 4's gate) never answers from a
  copy, reads Backstage and writes; `kept` (`--cached`) reads the copy whatever its age, never
  asks Backstage, writes nothing, and with no copy that verifies ends in a
  `CatalogueReadError` of kind `not-kept`, exit 1. Under `fresh` and `refresh` alike, a load
  that fails for reach then looks for a copy that verifies, only so the failure line can name
  `--cached` with its age; it is never answered from.
- **What a run reports.** `LoadResult.cache` carries two facts, because one run can have
  both: what was read — `fresh` or `kept` with the age, `stale`, `absent`, `skipped` (under
  `refresh`), or `not-used` with the refusal — and, when Backstage was read, what was written
  — `written`, or `not-written` with the refusal. A copy that did not verify and was replaced
  is `{ read: not-used, written }`; a `<key>` that is a file is `{ read: not-used,
  written: not-written }`. The stderr lines and the trace's `idp.source.cache_read` and `idp.source.cache_written` read both.
- **The age, always.** Read from a copy, the notice says `read from cache, <age> old;
  --refresh reads Backstage again`, and with `--cached` `read from cache, <age> old, as
  --cached asks: Backstage was not asked`. `<age>` is `less than a minute`, `N min` (floor),
  `N h` from 60 minutes, `N days` from 48 hours. A copy dated after this clock's now is never
  fresh; with `--cached` it is read and its age is `of an age this clock cannot tell (dated
  N min ahead of it)`.
- **Pruning.** After a copy is written, and never otherwise: under `backstage/`, each folder
  whose name is 32 hex characters, owned and closed as above, is looked at without following
  anything; its `served.json` older than `CATALOGUE_CACHE.keepMs` (7 days, question 1) by its
  `mtime` is unlinked, and so is a `*.tmp` older than the TTL; then the folder is removed if
  empty (`rmdir`, which removes nothing else) — when this pass emptied it, or its own `mtime`
  is older than the TTL: an empty folder younger than that is another run's, made for a copy
  it is still sealing, and removing it would fail that run's write. Anything else under
  `backstage/` — a file, a link, a folder of another name or owner — is left alone.
- **The root comes from `bin.ts`.** `MainDeps.cacheRoot` is `{ dir }` or `{ none: reason }`,
  and absent means none, as a test's `main(…)` call is. `bin.ts` passes
  `cacheRootOf(process.env, process.platform, process.getuid?.())`. A default inside `main`,
  as `catalogueFetch` has, would make every existing test that passes `HOME` —
  `tests/unit/backstage-read.test.ts` passes a temporary one on five rows — keep a copy
  between two runs of one test and turn its second answer into a cached one.
- **No cache on Windows**, and none when neither variable names a root, when the uid is 0, or
  when the person turned it off (`IDP_BACKSTAGE_CACHE=off`, question 2): `cacheRootOf`
  returns `{ none }`, nothing is said on a normal run, and `--cached` is refused, exit 2,
  naming the reason.
- **The failure line's way out.** A read that fails for reach — `unreachable`, `timeout`, a
  `status` of 500 or more, `rate-limited` — while a copy is kept adds `; --cached reads the
  copy kept <age> ago` before `--repo`, with or without `--refresh`. After a 401 or a 403 it
  never does: the catalogue said this token may not read it, and pointing at a copy would
  route around a revocation. The person may still pass `--cached`; the copy is theirs, on
  their machine, and stated as such.
- **The flags.** `--refresh` and `--cached` on `graph`, `show`, `relations`, `ask` and the
  phrase; never on `plan`, `validate` or `init`, which read no catalogue, so there
  `parseArgs` refuses them as unknown, exit 2, as today. Both at once, or either with `--repo`
  or `--demo`, is exit 2 at parsing; either against a resolved source that is not a catalogue
  — the directory the person stands in when it is a declarations repository — is exit 2
  naming what was read and `--backstage`.

## The cache as company data at rest

The owner asked for each of these to be answered before anything is built. Each answer is a
test of 2.2 or 2.3, named in its step.

| Question | Answer |
|---|---|
| **Who can read it** | The person's own account, and the machine's administrators. Folders `0o700`, files `0o600`, owned by the running uid, checked before every read and write; a store that fails the check is not used. A run as root keeps and reads nothing. Anything that copies the home directory copies it too — a backup (Time Machine does not exclude `~/.cache`), a sync tool, a disk image — which `SECURITY.md` says, with `XDG_CACHE_HOME` to put it elsewhere and `IDP_BACKSTAGE_CACHE=off` to keep nothing. It holds what the token read: Components, Resources and APIs as served (descriptions, links, annotations, relations), the organisation's names, types and memberships, other kinds' references; never a token, a profile, a User's or a Group's annotation, or an API's definition text. |
| **How it is invalidated** | By age: a copy older than 5 minutes is not read without `--cached`. By `--refresh`. By a new token, a new base, or a version or a run reading other fields or bounds: a new key, which never reads the old copy. By a new secret: every key. By the person: deleting `~/.cache/idp-agent/backstage`. What is not caught: a change in Backstage within the 5 minutes, which the notice already says ("it may lag the declarations repository by minutes"). Copies no run writes again are removed 7 days after they were written. |
| **A corrupted file** | Truncated, a flipped byte in the header or the body, not JSON, not UTF-8, a header of another shape or format or longer than 4 KiB, a line longer than a page may be, a length or a MAC that does not match, an envelope Zod refuses, a `fetchedAt` other than the envelope's, an account of its own reads that no live read could give, an item without a uid, of a kind its read did not ask for, past the ceiling, a count that disagrees, a file larger than a run may read: no copy. Said once with the reason, Backstage read again, and the copy replaced. With `--cached`: exit 1, naming it. |
| **A tampered file** | Another account cannot write into a folder only the person's may open, and a folder or file whose mode lets anyone else in is refused before it is opened. A file moved in from another key's folder fails the MAC, which covers the key. The person's own account, or root, is beyond any check a file can make — it can read the secret too. Even then a copy is only a catalogue, and no more than a hostile Backstage can serve: what a live read derives rather than receives — the kinds each read asked, which organisation kinds are judged, the bounds — is checked against what a live read could derive, or recomputed; every item goes through the load's checks, the pre-pass and `readValue`; and nothing it holds can reach a plan. |
| **A foreign-owned file or folder** | From `idp-agent/` down, one owned by another uid — a shared or world-writable `XDG_CACHE_HOME` where someone made `idp-agent/` first, or a tree a `sudo` run of another tool made — means the store is not used or written this run, said with the path; nothing is read from it, removed or changed. A run as root keeps nothing, so this tool never makes that tree; `SECURITY.md` names removing it as its owner as the remedy. |
| **A symlinked cache folder** | `<root>` is the person's and is followed. Below it nothing is: `makeFolders` refuses a link where a folder goes, by name; `openToRead` and `openNew` refuse a link where the file goes (`O_NOFOLLOW`) and a folder swapped for a link between the check and the open (`holdsInside`); a write finding a link at `served.json` refuses and leaves it, and `rename` replaces a name and follows no link there; the pruning `lstat`s and follows nothing. What `confine/` cannot close, a folder swapped for a link and back between two of its checks, is what `SECURITY.md` already states for every repository read. A file with more than one link is refused. |
| **Concurrent runs** | A writer writes a temporary file of its own name and renames it: POSIX `rename` is atomic, so a descriptor names one inode and reads it whole, the old copy or the new, never a mix. A rename that lands between `openToRead`'s open and its check is seen as a copy replaced and opened again, never as a link (row 19); three replacements in a row is `busy`, said once, and Backstage is read. Two runs that both miss both read Backstage and both write; the last rename wins, and each copy is a whole read. Two first runs racing to make the secret: the last rename wins, the other run's copy sits under a key nobody computes again and is pruned. The pruning never touches a temporary file younger than the TTL. |
| **Clock skew** | The TTL trusts this machine's wall clock, the only clock two processes share. A copy dated in the future is never fresh. A clock moved forward makes copies look older: Backstage is read again. A clock moved back by less than a copy's age makes it look younger by as much, which nothing can detect; `SECURITY.md` says so. |
| **Token rotation** | A new token is a new key: the old copy is never read by it. The old copy stays until pruned, readable only by the person's account holding the old token. A token Backstage now refuses (401, 403) is never pointed at its copy by the failure line. **Revocation lags**: a run inside the TTL answers from its fresh copy without asking Backstage, so a token revoked two minutes ago keeps answering for up to 5 minutes with no 401 to see, and indefinitely with `--cached`, since the copy is on the person's machine. `--refresh`, and slice 4's gate, are what prove the token still reads; `SECURITY.md` says all three. |
| **A plan's signature** | Nothing kept reaches it: the store is loaded by the provider alone (an architecture rule), the provider by the read road alone, and the change road reads the declarations repository; 2.3's test keeps a copy holding an owner the repository does not declare, and the plan still asks about that owner, exit 3, with no request sent. |

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `tools/fake-backstage.ts` *(edit)* | 2.1 | `catalogueOf(root, { scale })`, `--scale <n>` |
| `src/context/provider.ts` *(edit)* | 2.1, 2.2 | `ReadScope`, `PartialRead`, `LoadResult.partial?`; then `CacheReport`, `LoadResult.cache?` |
| `src/context/backstage/load.ts` *(edit)* | 2.1, 2.2 | bounded reads, `Served.bounded`, `judged` of whole reads only; then `admitted`, `judgedOf`, `Served.asked`, `Served.startedAt`, `readShapeOf` |
| `src/context/backstage/transport.ts` *(edit)* | 2.1, 2.2 | `too-many` removed, `ReadScope` re-exported; then `not-kept`, `CatalogueReadError.kept?` |
| `src/context/backstage/provider.ts` *(edit)* | 2.1, 2.2 | `partial` carried; then the `cache` option and its three uses |
| `src/context/backstage/limits.ts` *(edit)* | 2.2 | `CATALOGUE_CACHE`: `ttlMs`, `keepMs` |
| `src/context/backstage/cache.ts` | 2.2 | the store: the root made when missing, `acceptable`, secret, key, write, read, verification, pruning |
| `src/confine/confine.ts`, `src/confine/README.md` *(edit)* | 2.2 | `mode` on `makeFolders` and `openNew`; a fourth loader |
| `src/core/schemas/entity.ts` *(edit)* | 2.2 | `readsAsDefinition`, the predicate `definitionSchema` already applies |
| `src/context/graph/entity-graph.ts` *(edit)* | 2.1 | `NotLoaded`, `partial`, `notLoadedOf`, `notLoadedReferences` |
| `src/context/graph/overview.ts`, `src/context/graph/relations.ts`, `src/context/graph/summary.ts` *(edit)* | 2.1 | the overview's partial block and not-loaded list; a path ending not loaded; `SiSummary.partial?` |
| `src/agents/summary.ts`, `src/agents/tools/graph-tools.ts` *(edit)* | 2.1 | the summary's one line; a row's `notLoaded` |
| `src/cli/render/entity.ts`, `src/cli/render/relations.ts`, `src/cli/render/overview.ts`, `src/cli/render/catalogue-read.ts` *(edit)* | 2.1, 2.3 | `NOT_LOADED`, `partialSentence`; then `cacheLines` |
| `src/cli/commands/graph.ts`, `show.ts`, `relations.ts`, `ask.ts` *(edit)* | 2.1 | the closing lines, `show`'s on a hit included, and the part a miss looked in |
| `src/cli/source.ts` *(edit)* | 2.1, 2.2, 2.3 | the notice's `past the bound` term; `not-kept`; the notice's age, the failure line's `--cached`, the flags against a non-catalogue source |
| `src/cli/index.ts` *(edit)* | 2.1, 2.3 | the `past the bound:` line, the graph built with `partial`, `idp.source.not_loaded`; then the flags and their lines in `HELP` (which `usageOf` reads), `MainDeps.cacheRoot`, `providerOf`'s cache, the cache lines, the trace |
| `src/cli/personal.ts`, `src/cli/bin.ts` *(edit)* | 2.3 | `cacheRootOf`; the root handed to `main` |
| `tests/architecture/dependencies.test.ts` *(edit)* | 2.2 | three rules widened by one module each, one rule added, its self-test |
| `tests/setup/personal.ts` *(edit)* | 2.3 | `XDG_CACHE_HOME` in the run directory, a folder no one made |
| `tests/unit/cli-args.test.ts` *(edit)* | 2.3 | `usageOf` of each read command names both flags |
| `scripts/demo-backstage.mjs`, `scripts/demo-backstage-docker.mjs`, `scripts/smoke.mjs` *(edit)* | 2.3 | a scratch `XDG_CACHE_HOME`; the demo's cache step |
| `docs/adr/0013-a-catalogue-read-in-part-says-so.md` | 2.1 | the partial graph |
| `docs/adr/0014-a-kept-catalogue-is-read-again.md` | 2.3 | the cache |

---

### Task 2.1: A catalogue past a bound, read in part and said so

**Goal.** The load stops each read at its ceiling and says how far it got; the graph keeps a
reference into what was not read out of *declared nowhere*, as *not loaded*; every command,
the overview, a question's blocks, the summary and the Analyst's rows say the graph is partial
when it is, and only then. Nothing a whole read prints, sends or traces moves, but one new
root attribute.

**Files:**
- Modify: `tools/fake-backstage.ts` (`catalogueOf`, `:142-158`; `main`, `:338-377`)
- Modify: `src/context/provider.ts`, `src/context/backstage/load.ts` (`read`, `:139-184`; the
  return, `:193-200`), `src/context/backstage/transport.ts` (`ReadScope`, `:59`;
  `CatalogueFailure`'s `too-many`, `:95`; `scopeWords`, `:116-129`, kept for the partial
  sentence's words and moved to `provider.ts` beside `ReadScope`; `sentenceOf`'s case,
  `:169-175`), `src/context/backstage/provider.ts` (the return, `:110-119`),
  `src/context/README.md`
- Modify: `src/context/graph/entity-graph.ts` (the dangling loop, `:285-304`; the judged
  loop reads `organisation.judged`, unchanged), `src/context/graph/overview.ts`
  (`Overview.partial`, `Overview.notLoaded`, `:223`), `src/context/graph/relations.ts`
  (`Step.notLoaded`, beside `nowhere` and `setAside`, `:67-84`; the walks' `dangling` at `:649-790` gain
  `notLoaded`), `src/context/graph/summary.ts` (`SiSummary.partial?`)
- Modify: `src/agents/summary.ts` (`formatSummary`, `:110`), `src/agents/tools/graph-tools.ts`
  (the row's `dangling`, `:648-653`), `src/agents/README.md`
- Modify: `src/cli/render/entity.ts` (`NOT_LOADED`, beside `NOWHERE` at `:69-70`; the sections
  at `:262-266`), `src/cli/render/relations.ts` (`pathText`, `:139-145`; `renderRelation`'s
  closing line, `:381`), `src/cli/render/overview.ts` (`renderOverview`, `:100`),
  `src/cli/render/catalogue-read.ts` (`partialSentence`, `partialLine`)
- Modify: `src/cli/commands/graph.ts` (`:33-42`), `src/cli/commands/show.ts` (the miss at
  `:124`, and a hit's closing line),
  `src/cli/commands/relations.ts` (`runRelations`, `:55`), `src/cli/commands/ask.ts` (`block`,
  `:180-181`; `renderEntities`, `:227`; `known`, `:379`)
- Modify: `src/cli/source.ts` (`ReadCounts.pastBound`, `:651-657`; the catalogue case of
  `sourceNotice`, `:710-724`; `whatFailed`'s `too-many`, `:829-836`, removed),
  `src/cli/index.ts` (the graph, `:1526-1530`; the `past the bound:` line after the
  `not loaded:` one at `:1490`, which does not move;
  `sourceAttributes`, `:1741-1756`), `src/cli/README.md`
- Create: `tests/unit/backstage-partial.test.ts`, `docs/adr/0013-a-catalogue-read-in-part-says-so.md`
- Modify (tests that assert what changes, each named in Step 9): `backstage-load.test.ts`,
  `backstage-provider.test.ts`, `backstage-read.test.ts`, `fake-backstage.test.ts`
- Modify: `AGENTS.md` (the test count), `README.md` (`:514`'s exit codes, `:583-585`'s "A
  catalogue read in part is never answered from", the badge), `SECURITY.md` (the row "A
  catalogue read whole or not at all", `:186`), `docs/design.md` (§7.0, `:973-974`, "whole or
  not at all"), `docs/adr/0011-backstage-to-explore.md` (its status line), `CHANGELOG.md`

**Interfaces:**

```typescript
// src/context/provider.ts
/** Which of a load's three reads (load.ts). Moved here from transport.ts, which re-exports it. */
export type ReadScope = 'modelled' | 'organisation' | 'refs'

/** A read that reached its ceiling: what it read, what the catalogue announced, the bound. */
export interface PartialRead {
  readonly scope: ReadScope
  /** Lower case, as a reference names them: the kinds this read asked for. */
  readonly kinds: readonly string[]
  readonly read: number
  /** The first page's totalItems; undefined when the server served more than it announced. */
  readonly total: number | undefined
  readonly limit: number
}

export interface LoadResult {
  … // as on 55fb995
  /** The reads that stopped at a bound. Absent, or empty, is a whole read; the file road never sets it. */
  partial?: readonly PartialRead[]
}

// src/context/backstage/load.ts
export interface Served { …; readonly bounded: readonly PartialRead[] }   // judged: the whole reads' kinds only

// src/context/graph/entity-graph.ts
/** A reference into a kind whose read stopped at a bound, resolving to nothing read: not declared nowhere. */
export interface NotLoaded { readonly from: string; readonly field: DeclaredField; readonly to: string }
static from(entities, aside?, organisation?, partial?: readonly PartialRead[]): EntityGraph
get partial(): readonly PartialRead[]                              // empty: whole
notLoadedOf(ref: string, field?: DeclaredField): NotLoaded[]
notLoadedReferences(): NotLoaded[]                                  // the order danglingReferences() keeps

// src/context/graph/summary.ts
export interface SiSummary { …; partial?: Array<{ scope: ReadScope; limit: number }> }   // absent when whole

// src/cli/render/catalogue-read.ts
/** "533 Components, Resources and APIs were not loaded, past this version's bound of 20,000" — scopes joined by "; ". */
export function partialSentence(partial: readonly PartialRead[]): string
/** The stderr line: "past the bound: 533 Components, Resources and APIs, beyond this version's bound of 20,000, were not loaded; …". Never begins "not loaded:" (row 17). */
export function partialLine(partial: readonly PartialRead[]): string
```

- [x] **Step 1: Pin the before (passes now)**

On the unchanged tree:

```bash
df -h "$TMPDIR"
pnpm vitest run tests/scenarios/prompt-digests.test.ts tests/unit/backstage-read.test.ts tests/unit/backstage-provider.test.ts tests/unit/read-commands-hostile.test.ts
```

Expected: green. `prompt-digests.test.ts` is the proof that no prompt moves, and it is not
edited by any task of this plan.

- [x] **Step 2: The fake at scale (fails: `catalogueOf` takes no `scale`)**

`tests/unit/fake-backstage.test.ts` gains a local reader beside its `uidOf` (`:42`) — the
fake's own `at` (`tools/fake-backstage.ts:161`) is not exported, and stays so — and the rows:

```typescript
const at = (item: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), item)
it('generates n Components after the demo SI, each depending on the next, uids after every sha256 one', () => {
  const items = catalogueOf(DEMO, { scale: 3 })
  const scale = items.filter((item) => String(at(item, 'metadata.name')).startsWith('scale-'))
  expect(scale.map((item) => at(item, 'metadata.name'))).toEqual(['scale-00001', 'scale-00002', 'scale-00003'])
  expect(scale.map((item) => at(item, 'spec.dependsOn'))).toEqual([['component:default/scale-00002'], ['component:default/scale-00003'], undefined])
  const demoUids = items.filter((item) => !scale.includes(item)).map((item) => String(at(item, 'metadata.uid')))
  expect(demoUids.every((uid) => uid < 'ffffffff')).toBe(true)
  expect(scale.map((item) => at(item, 'metadata.uid'))).toEqual([
    'ffffffff-ffff-4fff-8fff-000000000001', 'ffffffff-ffff-4fff-8fff-000000000002', 'ffffffff-ffff-4fff-8fff-000000000003',
  ])
})
it('refuses --scale outside 1 to 99,999, as a number it cannot name', …)
```

Run `pnpm vitest run tests/unit/fake-backstage.test.ts`. Expected: FAIL, no `scale-` item.
Then `catalogueOf` gains `scale?: number`, each item made by `served()` with its uid set
after, and `main` reads `--scale`, refusing a value that is not an integer in range with one
line and exit 2. The file's header lists the flag. Run again: green.

- [x] **Step 3: The load stops at a bound (fails: `too-many` is thrown)**

`tests/unit/backstage-load.test.ts:321-356`, the three `refuses …` tests, become:

```typescript
it('reads the modelled kinds up to their ceiling and says how far it got, the other reads still sent', async () => {
  const { loading, sent } = loaded(demoWithLocations(), {}, { modelledEntities: 32 })
  const served = await loading
  expect(served.whole).toHaveLength(32)
  expect(served.bounded).toEqual([{ scope: 'modelled', kinds: ['component', 'resource', 'api'], read: 32, total: 33, limit: 32 }])
  expect(sent.map(({ url }) => new URL(url).searchParams.getAll('filter'))).toContainEqual(['kind=location'])
})
it('asks for no page after the one that reaches the ceiling, and keeps that page up to it', async () => {
  const { loading, sent } = loaded(demoWithResources(300), {}, { modelledEntities: 300 })
  const served = await loading
  expect(served.whole).toHaveLength(300)
  expect(served.bounded[0]).toMatchObject({ read: 300, total: 333 })
  expect(sent.filter(({ url }) => url.includes('entities/by-query'))).toHaveLength(2)
})
it('stops as items arrive past the ceiling whatever totalItems says, and calls the total unknown', async () => {
  const served = await loaded(demo, { totalItemsAbove: -30 }, { modelledEntities: 32 }).loading
  expect(served.bounded[0]).toMatchObject({ read: 32, total: undefined })
})
it('judges no organisation kind when the organisation read stopped at its ceiling', async () => {
  const served = await loaded([...demoWithGroups(), ...locations(3)], {}, { organisationEntities: 2 }).loading
  expect(served.judged).toEqual([])
  expect(served.bounded).toEqual([expect.objectContaining({ scope: 'organisation', read: 2 })])
})
it('reads the refs up to their ceiling', …)
it('still refuses fewer uids than announced on a read that did not reach its ceiling', …)   // the changed row, unchanged
it('is whole, bounded: [], judged as before, on every catalogue under its ceilings', …)
```

and the three `too-many` sentences asserted inside the first of them
(`backstage-load.test.ts:331-342`) go with it; `backstage-transport.test.ts` names none. Run
`pnpm vitest run tests/unit/backstage-load.test.ts`. Expected: FAIL, `too-many` thrown.

Then in `load.ts`, `read()` takes the ceiling as a bound. A first page whose `totalItems`
passes it only marks the read bounded and records `total` — the read goes on, where today
it throws (`load.ts:157-160`). The read **stops** when `seen.size` reaches the ceiling: the
items of that page past it are not kept, no next page is asked for, and the read returns its
items with a `PartialRead` (`read` the ceiling; `total` the announced count when it passed
the ceiling, else undefined, since the server then served more than it announced). The
`changed` check runs only on a read that did not stop. `judged` is the organisation kinds of a read that did
not stop. `too-many` leaves `CatalogueFailure`, `sentenceOf` and `whatFailed`; `ReadScope`
and `scopeWords` move to `provider.ts`, `transport.ts` re-exporting `ReadScope` for its
importers. Run again: green, and `pnpm typecheck` finds the two switches' removed case.

- [x] **Step 4: The provider carries it (fails: no `partial`)**

`tests/unit/backstage-provider.test.ts` gains a row: the demo SI with `modelledEntities: 30`
loads 30 entities, `partial` equal to the load's `bounded`, the rejections, set-asides and
order of what was read as a whole read of those 30 would give; a whole read has no `partial`
key at all (`expect(result).not.toHaveProperty('partial')`, so every `LoadResult` literal and
snapshot elsewhere is unchanged). Expected: FAIL. Then the provider spreads
`...(served.bounded.length > 0 && { partial: served.bounded })`. Green.

- [x] **Step 5: The graph (fails: a reference into a bounded kind is dangling)**

`tests/unit/backstage-partial.test.ts`, its first `describe`, over graphs built by hand:

```typescript
describe('a graph read in part', () => {
  const partial: PartialRead[] = [{ scope: 'modelled', kinds: ['component', 'resource', 'api'], read: 2, total: 5, limit: 2 }]
  it('calls a reference into a bounded kind not loaded, and never dangling', () => {
    const graph = EntityGraph.from([WORKER_DEPENDING_ON_MISSING_DB], [], undefined, partial)
    expect(graph.danglingReferences()).toEqual([])
    expect(graph.unresolvedOf('component:default/worker')).toEqual([])
    expect(graph.notLoadedOf('component:default/worker', 'dependsOn')).toEqual([
      { from: 'component:default/worker', field: 'dependsOn', to: 'resource:default/missing-db' },
    ])
  })
  it('still calls a reference into a kind read whole declared nowhere: a template the catalogue does not hold', …)
  it('is whole, with no not-loaded reference, when built with no partial read, as every graph on 55fb995 is', …)
  it('leaves an owner naming no Group a name when the organisation read was bounded: not judged', …)
  it('calls a dependsOn naming a System not loaded when the organisation read was bounded', …)
  it('lists notLoadedReferences() in the order danglingReferences() would have', …)
})
```

Run. Expected: FAIL (`EntityGraph.from` takes three arguments; the reference is dangling).
Then `from` takes `partial`, the constructor computes the bounded kinds, and the dangling loop
(`:292-301`) sends a reference whose kind is among them to `notLoaded` instead of `found`.
Green.

- [x] **Step 6: What a person reads (fails: the run is exit 1 today)**

`tests/unit/backstage-partial.test.ts`, a second `describe`, through `main` with the fake
over the demo SI plus `scale: 12` and `catalogueLimits: { modelledEntities: 40 }` — 45
modelled, 40 read, 5 not loaded, and `scale-00007` naming `scale-00008`:

| Row | Asserts |
|---|---|
| the notice | exit 0; stderr's first line is `reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 52 entities: 47 read, 0 not modelled, 5 past the bound; it may lag …` |
| the bound's line | the next stderr line is `past the bound: 5 Components, Resources and APIs, beyond this version's bound of 40, were not loaded; the graph is partial, and a reference to one of them is not loaded, never declared nowhere`; no stderr line of the run begins `not loaded:` but the one of kinds not modelled, when there is one |
| both lines | the same catalogue with three Location documents added: `not loaded: 3 documents this tool does not model (Location ×3)` as on `55fb995`, then the `past the bound:` line |
| an unknown total | the fake with no organisation and `totalItemsAbove: -10` (35 announced, 45 served): `at least 41 entities: 40 read, 0 not modelled, at least 1 past the bound` and `past the bound: Components, Resources and APIs beyond this version's bound of 40 were not loaded, how many is not known; …` |
| `graph` | the table of the 40, the dangling list `--demo` prints, then `1 reference names what was not loaded:` and `  component:default/scale-00007 -> component:default/scale-00008`; at most 25 such lines, then `+N more` |
| `show scale-00007` | its `depends on` section lists `component:default/scale-00008` marked `not loaded`, never `declared nowhere`; stdout's last line is `partial: 5 Components, Resources and APIs were not loaded, past this version's bound of 40; what they declare is not in these sections` |
| `show billing-api` | stdout is `tests/golden/demo-read/show-billing-api.txt` followed by that one `partial:` line, and nothing else differs |
| `show scale-00011` | exit 1, `No entity named "scale-00011" in the part of the catalogue read: 5 Components, Resources and APIs were not loaded, past this version's bound of 40.` |
| `relations scale-00006 --depends-on` | the path to `scale-00008` ends `— not loaded`, and the block's last line is `partial: 5 Components, Resources and APIs were not loaded, past this version's bound of 40; what they declare is not in these rows` |
| `relations mysql-prod-01 --impacts` | the README's table, then that one closing line |
| the overview | a question answered `overview` opens with `partial  40 of 45 Components, Resources and APIs read, this version's bound; every count below is of what was read`; its references past the bound are listed under `past the bound`, never `not loaded`, which stays the row of kinds not modelled; its dangling section is the whole read's |
| `nothing` | `No entity matches that question in the part of the catalogue read: 5 Components, Resources and APIs were not loaded, past this version's bound of 40.` |
| the trace | `idp.source.not_loaded: 5`; on a whole read `0` |
| a whole read | the same commands without the bound print, byte for byte, what they print on `55fb995` (each compared with `--demo`'s stdout) |

Run. Expected: FAIL, exit 1 with the `too-many` line gone and no partial wording. Then:
`ReadCounts.pastBound` and the notice's term and `at least` wording (`source.ts`);
`partialSentence` and `partialLine` (`catalogue-read.ts`); `index.ts` builds the graph with
`loaded.partial`, prints `partialLine` after the `not loaded:` line of kinds not modelled,
which does not move, and adds the attribute; `NOT_LOADED = 'not loaded'` beside `NOWHERE`;
`show`'s sections take `notLoadedOf`, and a hit on a partial graph ends with the closing line; `runGraph`, `runShow`'s miss, `runRelations`, `block`'s `nothing` and
`renderEntities`' miss read `graph.partial`; `Step.notLoaded` and the walks' `notLoaded`
ends; `Overview.partial` and `renderOverview`'s first block. Green.

- [x] **Step 7: What a model is sent (fails: nothing says partial)**

A third `describe`, with a scripted client that keeps every request (`prompt-digests.test.ts`'s
pattern), over the same bounded catalogue:

- the Supervisor's and the Analyst's opening message holds, after the vocabulary, the line
  `The catalogue was read in part: Components, Resources and APIs past this version's bound of 40 were not loaded; a reference to one is not loaded, never declared nowhere.`;
- `get_entity scale-00007`'s row holds `notLoaded: ['component:default/scale-00008']`, and no
  `declaredNowhere`;
- `ask`'s commentary check counts `component:default/scale-00008` as known (`known`,
  `ask.ts:379`), as it counts a dangling one;
- over the same catalogue read whole, every request is byte for byte the one a
  `--demo`-shaped run sends: no `partial` key in the summary, no `notLoaded` in a row.

Expected: FAIL. Then `SiSummary.partial?`, one line in `formatSummary` when present, a row's
`notLoaded` through `boundedOf` like its `dangling`, and `known` widened. Then run
`pnpm vitest run tests/scenarios`: green, `prompt-digests.test.ts` unchanged.

- [x] **Step 8: The documents**

- `docs/adr/0013-a-catalogue-read-in-part-says-so.md`: *Context* — ADR-0011 refused a
  catalogue past a bound, because a reference left unloaded would read as declared nowhere;
  a company catalogue can pass 20,000 Components. *Decision* — each count ceiling is a bound
  stated: a read stops there, the graph keeps a reference into a bounded kind as not loaded,
  an organisation read that stopped is not judged, and every answer from a partial graph says
  so in the engine's words. *Rejected* — refusing (the tool then answers nothing about the
  catalogues it is for); answering without saying (a miss reads as a fact); a sample of the
  catalogue (arbitrary where the server's order is at least stated); partial on the byte and
  time bounds (what a broken server cuts). *Consequences* — the Analyst is told in one line,
  only when partial; nothing moves on a whole read.
- ADR-0011's status line: `**Status** accepted; amended by [0013](0013-…md)`.
- `README.md:583-585`: "A catalogue read in part is never answered from: …" becomes: a
  catalogue larger than a run reads (20,000 Components, Resources and APIs; 200,000
  Groups, Users, Systems and Domains; 200,000 references of other kinds) is read up to that
  bound and answered in part, every answer saying so, a reference past it `not loaded`; a
  server that refuses the token, cannot be reached, serves less than it announced or more
  bytes than a run reads is exit 1. `:514`'s exit codes: "could not be read whole" becomes
  "could not be read".
- `SECURITY.md:186`: "A catalogue read whole or not at all" becomes "A catalogue read whole,
  or up to a stated bound and answered as partial; every failure one line and exit 1 …", its
  test column naming `tests/unit/backstage-partial.test.ts`.
- `docs/design.md:973-974`: "whole or not at all" becomes "whole, or up to a stated bound
  and said to be partial".
- `docs/adopting-backstage.md:179`: the same words, the same change, naming ADR-0013.
- `src/context/README.md` and `src/cli/README.md`: the not-loaded list beside the dangling one.

- [x] **Step 9: What changes in tests that exist**

| File | Asserted on `55fb995` | After 2.1 | Why |
|---|---|---|---|
| `backstage-load.test.ts:321-356` | three ceilings refused with `too-many`, the refs read never sent | Step 3's rows | the bound is stated |
| `backstage-load.test.ts:331-342` | `too-many`'s three sentences, inside the first of those tests | gone | the case is gone |
| `backstage-read.test.ts:448` | "more modelled entities than a run reads", a row of the failure matrix, exit 1 | moved to `backstage-partial.test.ts` as exit 0 with the not-loaded line | the same |
| `backstage-read.test.ts:516-522` | the root attributes, `toMatchObject` | unchanged; `idp.source.not_loaded: 0` asserted beside them | a new attribute |
| everything else | | unchanged | a whole read prints what it printed |

`grep -rn "too-many\|does not answer from part\|whole or not at all" src tests scripts docs README.md SECURITY.md AGENTS.md`
after the step prints only this plan, slice 3's and the note, which are records, and
`render/entity.ts`'s link, which is another subject.

- [x] **Step 10: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/backstage-partial.test.ts tests/unit/backstage-load.test.ts tests/unit/fake-backstage.test.ts tests/scenarios
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
git diff main --stat -- tests/golden tests/recordings fixtures/si-demo
```

The last prints nothing.

**Architecture rules:** none change. `context/graph/` names `PartialRead` and `ReadScope` from
`context/provider.ts`, never from `context/backstage/`.

- [ ] **Step 11: The pull request** (after the owner's go-ahead)

```bash
git add tools/fake-backstage.ts src/context/provider.ts src/context/backstage/load.ts \
  src/context/backstage/transport.ts src/context/backstage/provider.ts src/context/README.md \
  src/context/graph/entity-graph.ts src/context/graph/overview.ts src/context/graph/relations.ts \
  src/context/graph/summary.ts src/agents/summary.ts src/agents/tools/graph-tools.ts src/agents/README.md \
  src/cli/render/entity.ts src/cli/render/relations.ts src/cli/render/overview.ts \
  src/cli/render/catalogue-read.ts src/cli/commands/graph.ts src/cli/commands/show.ts \
  src/cli/commands/relations.ts src/cli/commands/ask.ts src/cli/source.ts src/cli/index.ts \
  src/cli/README.md tests/unit/backstage-partial.test.ts tests/unit/backstage-load.test.ts \
  tests/unit/backstage-provider.test.ts tests/unit/backstage-read.test.ts \
  tests/unit/fake-backstage.test.ts \
  docs/adr/0013-a-catalogue-read-in-part-says-so.md docs/adr/0011-backstage-to-explore.md \
  src/context/backstage/limits.ts docs/adopting-backstage.md docs/roadmap.md \
  docs/plans/backstage-http-slice-2.md \
  AGENTS.md README.md SECURITY.md docs/design.md CHANGELOG.md
git commit -m "feat(context): answer a catalogue past a bound in part, and say what was not loaded"
```

Base `main`. CHANGELOG, `### Changed`:

> - A Backstage catalogue larger than a run reads — 20,000 Components, Resources and APIs,
>   200,000 Groups, Users, Systems and Domains, or 200,000 references of other kinds — is no
>   longer refused: it is read up to that bound and answered in part. A stderr line,
>   `past the bound:`, counts what was left out, a reference past the bound is marked
>   `not loaded` and never declared nowhere, and `graph`, `show`, `relations`, the overview and a question's answer each say
>   the graph is partial; a catalogue read whole prints and sends exactly what it did
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** over a catalogue past a bound, an answer, its
`past the bound:` line and its `not loaded` references where there was exit 1 and one
refusing line. Over anything else, nothing:
`--demo`, `--repo`, the fake without `--scale` and the Docker demo print what they printed;
the trace gains `idp.source.not_loaded`.

**What the owner can run** (after `pnpm build`, from the clone; the fake in one terminal, the
rest in a second):

```bash
node tools/fake-backstage.ts --port 7011 --scale 20500
```

```bash
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js show billing-api
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js show scale-19967
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js show scale-20400
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js relations mysql-prod-01 --impacts
node dist/cli/bin.js show billing-api --demo
```

| Command | Prints | Exit |
|---|---|---|
| the fake | `listening on http://127.0.0.1:7011/api/catalog` | runs |
| `show billing-api` | stderr: `reading the Backstage catalogue at 127.0.0.1:7011 (IDP_BACKSTAGE_URL): 20,540 entities: 20,007 read, 0 not modelled, 533 past the bound; …`, then `past the bound: 533 Components, Resources and APIs, beyond this version's bound of 20,000, were not loaded; …`; stdout: `tests/golden/demo-read/show-billing-api.txt`, byte for byte, then `partial: 533 Components, Resources and APIs were not loaded, past this version's bound of 20,000; what they declare is not in these sections` | 0 |
| `show scale-19967` | its `depends on` lists `component:default/scale-19968` marked `not loaded`, and the same closing `partial:` line | 0 |
| `show scale-20400` | `No entity named "scale-20400" in the part of the catalogue read: 533 Components, Resources and APIs were not loaded, past this version's bound of 20,000.` | 1 |
| `relations mysql-prod-01 --impacts` | the README's table, then `partial: 533 Components, Resources and APIs were not loaded, …` | 0 |
| `show billing-api --demo` | the golden, byte for byte, and the demo's notice as on `main` | 0 |

The load's time for the first command is written into the pull request's description
(measured; a few seconds is expected).

---

### Task 2.2: The store — a catalogue read kept on disk, and read again through the reader

**Goal.** `context/backstage/cache.ts` keeps a `Served` under a key only this machine's secret
can compute, in folders only the person's account can open, and gives one back only after
every check a page meets, so the provider's loop runs the pre-pass and `readValue` on it as
on a page. The provider gains its three uses. No command uses any of it yet.

**Files:**
- Modify: `src/confine/confine.ts` (`makeFolders`, `:212`; `openNew`, `:245`: an optional
  `{ mode }`, the default the call makes today), `src/confine/README.md` (a fourth caller,
  and its stance: follows none, creates folders `0o700` and files `0o600`)
- Modify: `src/core/schemas/entity.ts` (`readsAsDefinition`, the predicate `definitionSchema`
  applies at `:449-457`, exported; `definitionSchema` uses it)
- Modify: `src/context/backstage/load.ts` (`admitted`, extracted from `read()`'s per-item
  loop; `judgedOf`, extracted from the return's `judged`, `:197`; `Served.asked`,
  `Served.startedAt`; `readShapeOf`), `src/context/backstage/limits.ts`
  (`CATALOGUE_CACHE`), `src/context/backstage/transport.ts` (`not-kept`; `kept?` on
  `CatalogueReadError`), `src/context/backstage/provider.ts` (the `cache` option),
  `src/context/provider.ts` (`CacheReport`, `LoadResult.cache?`), `src/context/README.md`
- Create: `src/context/backstage/cache.ts`
- Modify: `src/cli/source.ts` (`whatFailed`'s `not-kept`, which no command reaches before 2.3)
- Modify: `tests/architecture/dependencies.test.ts` (`:758-772`, `:794-830`, `CONFINES`
  at `:642-646` and the rule at `:955`; one new rule and its self-test beside `:1274`)
- Create: `tests/unit/backstage-cache.test.ts`, `tests/unit/backstage-provider-cache.test.ts`
- Modify: `tests/unit/confine.test.ts`, `tests/unit/backstage-load.test.ts`
- Modify: `AGENTS.md` (twenty-six rules and what they say of `context/`; the writers; the test
  count), `README.md` (the badge), `CHANGELOG.md`

**Interfaces:**

```typescript
// src/confine/confine.ts — the default is what each call makes on 55fb995
export async function makeFolders(realRoot: string, relative: string, options?: { mode?: number }): Promise<void>
export async function openNew(realRoot: string, relative: string, options?: { mode?: number }): Promise<FileHandle | undefined>

// src/core/schemas/entity.ts
/** Whether the reader reads `value` as an API's definition: text, or one placeholder that yields text. */
export function readsAsDefinition(value: unknown): boolean

// src/context/backstage/limits.ts
export const CATALOGUE_CACHE = {
  /** A copy younger than this is read instead of the catalogue: of the order of the catalogue's own lag. */
  ttlMs: 5 * 60_000,
  /** A copy older than this is removed by the next run that writes one (question 1). */
  keepMs: 7 * 24 * 60 * 60_000,
  /** The longest header line a copy may have. */
  headerBytes: 4096,
} as const

// src/context/backstage/load.ts
export interface Served {
  …                                               // whole, organisation, refs, judged, census, bounded (2.1)
  /** The kinds the organisation and refs reads asked for, lower case: what a kept copy's account of itself is checked against. */
  readonly asked: { readonly organisation: readonly string[]; readonly refs: readonly string[] }
  /** When the load began (Date.now()): a copy's fetchedAt, so its age is never understated. */
  readonly startedAt: number
}
/** Every item of one read, each uid once, or the failure that ends it: a page's check, and a kept copy's. */
export function admitted(items: readonly unknown[], asked: ReadonlySet<string>, ceiling: number, scope: ReadScope, seen: Set<string>): unknown[]
/** The organisation kinds a load judges: those it asked for, unless their read was bounded. The load's rule, and a copy's recomputation. */
export function judgedOf(asked: readonly string[], bounded: readonly PartialRead[]): OrganisationKind[]
/** Whether a stated `asked` and `bounded` are ones a live load under `limits` could have produced. */
export function accountHolds(asked: Served['asked'], bounded: readonly PartialRead[], limits: BackstageLimits): boolean
/** The fields each read asks for, its three ceilings and two byte bounds: part of a copy's key. */
export function readShapeOf(limits: BackstageLimits): string

// src/context/backstage/cache.ts
export type CacheRefusal =
  | { readonly kind: 'link'; readonly path: string }
  | { readonly kind: 'foreign'; readonly path: string }                  // another uid's
  | { readonly kind: 'open'; readonly path: string; readonly mode: number } // a group or other bit
  | { readonly kind: 'not-a-folder' | 'not-a-file' | 'linked'; readonly path: string }
  | { readonly kind: 'busy'; readonly path: string }                     // replaced under three opens in a row
  | { readonly kind: 'unverified'; readonly reason: 'header' | 'format' | 'origin' | 'length' | 'mac' | 'envelope' | 'account' | 'items' | 'size' }
  | { readonly kind: 'io'; readonly code: string }                        // the error's code, never its message
/** Whether one name may be used: the one judgement of owner, mode, type and links, tested on synthetic stats. */
export function acceptable(stats: Pick<Stats, 'mode' | 'uid' | 'nlink'> & { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }, owner: number, kind: 'top' | 'folder' | 'file'): CacheRefusal['kind'] | undefined
export interface Kept { readonly served: Served; readonly fetchedAt: number }   // fetchedAt: the MAC-covered one, equal to served.startedAt
export interface CatalogueCache {
  /** `stale`: under `fresh`, a copy past the TTL or dated ahead by its header, not verified further. */
  read(use: 'fresh' | 'kept'): Promise<{ readonly kept: Kept } | { readonly none: 'absent' | 'stale' } | { readonly none: CacheRefusal }>
  write(served: Served): Promise<{ readonly written: true } | { readonly written: false; readonly refusal: CacheRefusal }>
}
/** The store for this base and token under `root`, or why it cannot be used at all. */
export async function catalogueCache(options: {
  root: string                      // $XDG_CACHE_HOME or ~/.cache, the person's; followed if a link; made 0700 when missing and its parent is a folder
  base: URL
  token: string | undefined         // hashed into the key under the secret, and kept nowhere
  owner: number                     // the uid every name must belong to (process.getuid(), from cli/)
  limits: BackstageLimits           // the provider's effective limits: the key's read shape, and the bounds a copy is checked against
  now?: () => number
  /** Tests only: the open a read goes through, so a rename between open and check is staged exactly. */
  openRead?: typeof openToRead
}): Promise<{ readonly cache: CatalogueCache } | { readonly unusable: CacheRefusal }>

// src/context/provider.ts
export interface CacheReport {
  readonly read:
    | { readonly state: 'fresh' | 'kept'; readonly fetchedAt: number; readonly ageMs: number | undefined }  // undefined: dated after now
    | { readonly state: 'stale' | 'absent' | 'skipped' }                                                   // skipped: refresh
    | { readonly state: 'not-used'; readonly refusal: CacheRefusalWords }                                   // the store, or a copy that did not verify
  /** Absent when Backstage was not read (a copy answered, or kept use). */
  readonly written?: { readonly state: 'written' } | { readonly state: 'not-written'; readonly refusal: CacheRefusalWords }
}
export interface LoadResult { …; cache?: CacheReport }                          // absent: no cache was asked for

// src/context/backstage/provider.ts
constructor(options: { …; cache?: { root: string; owner: number; use: 'fresh' | 'refresh' | 'kept'; now?: () => number } })

// src/context/backstage/transport.ts
| { readonly kind: 'not-kept' }   // --cached, and no copy read with this token verifies
export class CatalogueReadError extends Error { …; readonly kept?: { readonly ageMs: number } }   // a copy is kept: said after a failure of reach, under fresh or refresh
```

`CacheRefusalWords` is the refusal with its path already shown relative to the root, so
`context/provider.ts` names no type of `context/backstage/`.

- [x] **Step 1: `confine/` makes what it is told (fails: the mode is the umask's)**

`tests/unit/confine.test.ts`:

```typescript
it('makes folders 0700 and a new file 0600 when asked, under a umask of 022', async () => {
  const root = await realRootOf(await scratch())
  await makeFolders(root, 'a/b', { mode: 0o700 })
  const handle = await openNew(root, 'a/b/f', { mode: 0o600 })
  await handle?.close()
  expect((await lstat(path.join(root, 'a'))).mode & 0o777).toBe(0o700)
  expect((await lstat(path.join(root, 'a/b/f'))).mode & 0o777).toBe(0o600)
})
it('keeps what makeFolders and openNew make with no option, as init platform relies on', …)
```

Expected: FAIL, 0755 and 0644. Then `mkdir(current, options?.mode)` and
`open(…, options?.mode ?? 0o666)`. Green; `tests/unit/init-platform*.test.ts` and
`scaffold` tests unchanged.

- [x] **Step 2: One check for a page and a copy (fails: no `admitted`, no `readShapeOf`)**

`tests/unit/backstage-load.test.ts`: `admitted` refuses an item with no uid (`no-uid`), of a
kind not asked (`unasked-kind`), keeps a repeated uid once and counts it, and stops at the
ceiling as 2.1's read does; `judgedOf` gives the load's `judged` on every row of the file
that asserts one; `accountHolds` refuses, one row each, an organisation kind out of order or
not an organisation kind, a refs kind unsorted, failing `KIND` or among the modelled or
organisation kinds, two `bounded` entries of one scope, a `limit` other than the effective
ceiling, a `read` other than it, a `total` at or under it; `readShapeOf` holds
`ORGANISATION_FIELDS`, `REFS_FIELDS`, the three ceilings and the two byte bounds, and changes
when any does, a lowered `modelledEntities` included; `Served.asked` and `startedAt` are what
the load sent and when. Expected: FAIL. Then the per-item loop of `read()` becomes `admitted`,
called per page, the return's `judged` becomes `judgedOf`, and every existing row of the file
stays green unchanged — the refactor is proven by them.

- [x] **Step 3: The root, the key and the secret (fails: no `cache.ts`)**

`tests/unit/backstage-cache.test.ts`, each row over a root made under the run directory with
`mkdtemp`, `owner: process.getuid()`, and `now` injected:

- the first store makes `idp-agent/` (`0o700`), `backstage/` (`0o700`) and `secret`
  (`0o600`, 64 hex characters and a line break);
- a `root` that does not exist, whose parent does: made `0o700`, then the rest as above; a
  `root` whose parent does not exist either: `unusable: { kind: 'io', code: 'ENOENT' }` (2.3
  makes it `{ kind: 'no-parent' }`, so no other ENOENT is said as a missing root), and
  nothing made anywhere; a missing `root` whose parent is a link to a folder: followed, as a
  root is, and the root made in the folder it names;
- the key is 32 hex characters, the same for one base and token, another for another token,
  another base on the same origin (`/api/catalog` and `/other/api/catalog`), another secret,
  and other effective limits (`modelledEntities: 40` against the default) with the same base
  and token;
- no name under the root, and no byte of any file, holds the token or its sha256;
- a secret of another shape, owned and closed, is made again, and every earlier key changes;
- two stores made at once on an empty root each end with a secret, and the root holds one
  `secret` and no temporary file.

Expected: FAIL, the module does not exist. Then `cache.ts`: the root made when missing,
`realRootOf(root)`, `makeFolders(…, { mode: 0o700 })`, `acceptable` over every name
(`lstat`, never following), `randomBytes`, `createHmac`, the secret written through `openNew`
and renamed. Green.

- [x] **Step 4: A copy written and read back (fails: no `write`, no `read`)**

- `write(served)` then `read('fresh')` gives a `Served` deep-equal to the one written, but an
  organisation item projected to `ORGANISATION_FIELDS` and an API's text definition as
  `declared`; `fetchedAt` is `served.startedAt`;
- the file is `backstage/<key>/served.json`, `0o600`, one link, owned; its first line is the
  header of the Choices, with no token, under 4 KiB; then the envelope line, with no `judged`;
  then one line per item;
- a copy of a bounded read keeps `bounded`, and `judged` comes back as the load gave it,
  recomputed;
- a server that ignored `fields` (a User with `spec.profile` and `microsoft.com/email` served
  whole): no byte of the copy holds the email or the picture;
- an API served as `kind: Api`, `api` or `aPI`, which the load admits and the reader refuses on
  its kind: no byte of the copy holds its definition text, as the load and the reader read a
  kind in any case.

Expected: FAIL. Then `write` and `read`. Green.

- [x] **Step 5: Every refusal (fails: each is read today)**

First `acceptable`, on synthetic stats, one row each: a folder or a file of another uid
(`foreign`); a group or other bit on a folder below `idp-agent/` or on a file (`open`); a
group or other **write** bit on `idp-agent/` (`open`), a read bit there accepted; a file with
`nlink` 2 (`linked`); a link (`link`); a file where a folder goes and a folder where a file
goes. Then on a disk, `read()` answering `{ none: … }` and `write()` `{ written: false, … }`
where it applies, nothing under the root changed but by the row itself:

| Staged | Answer |
|---|---|
| `backstage/` a link to a folder elsewhere, or `idp-agent/` one | `unusable: { kind: 'link' }`, the target never read or written |
| `<key>/` a link | `none: { kind: 'link' }`; a write refuses, and the link's target is untouched |
| `served.json` a link | `read`: `none: { kind: 'link' }`; `write`: `{ written: false, refusal: { kind: 'link' } }`, the link still there, its target untouched, no temporary file left |
| `served.json` with two links (a hard link beside it) | `none: { kind: 'linked' }` |
| `backstage/` `0o755`, `served.json` `0o644` | `unusable`/`none` `{ kind: 'open', mode }`; nothing `chmod`-ed |
| `secret` a link, `0o644`, or with two links | `unusable: { kind: 'link' \| 'open' \| 'linked' }`; the secret is **not** made again, and the link's target, the file and its other name are untouched |
| truncated at half; one byte of the body flipped; one digit of the header's `fetchedAt` changed; the MAC changed; the header's `format` 2; `origin` another base; `bytes` another length; the body not JSON; `whole` not an array | `none: { kind: 'unverified', reason }`, one reason each — the `fetchedAt` digit is `mac` |
| a valid copy moved into another key's folder (the same secret, another token) | `none: { kind: 'unverified', reason: 'mac' }` |
| a header of 5 KiB; a body line of invalid UTF-8, or longer than `bytesPerResponse` (limits lowered), each with the MAC recomputed | `header`; `envelope`; `size` |
| each with the MAC recomputed with the test's knowledge of the secret: `asked.refs` holding `component`; `asked.organisation` holding `template`; a `bounded` organisation read with `limit` 5 against the default ceiling; `census.served` one more than the items; an envelope's `startedAt` other than the header's `fetchedAt` | `none: { kind: 'unverified', reason: 'account' }` for the first four, `'envelope'` for the last; no item of the copy reaches a `Served` |
| an item without a uid; of a kind its read did not ask for; more items than the ceiling; `count` one more than the distinct uids | `none: { kind: 'unverified', reason: 'items' }` |
| a file larger than `bytesPerRun` plus the header (limits lowered) | `none: { kind: 'unverified', reason: 'size' }`, read no further than the header |
| a folder swapped for a link between the check and the open (the confine test's staging) | refused, as `openToRead` refuses it |
| a named pipe at `served.json`, or at `secret` | `none`/`unusable` `{ kind: 'not-a-file' }` within a second: the store opens with `O_NONBLOCK` (`openToRead`'s `nonBlocking`), so an open never waits for a writer |
| the key folder moved away and replaced by a link to it after the temporary file is written, staged through the `openWrite` seam | `{ written: false, refusal: { kind: 'link', path: 'idp-agent/backstage/<key>' } }`: the folders asked again before the rename; nothing renamed through the link, no temporary file left |

`acceptable`'s rows are where the per-file owner check is proved: the disk rows cannot stage a
file of another uid inside folders the test owns, and an implementation that checked only
folders would fail the synthetic ones.

Expected: FAIL. Then the checks, in the order of the Choices. Green.

- [x] **Step 6: Races, clock and pruning (fails: no pruning; a replaced copy reads as a link)**

- a read racing a write, staged exactly through `openRead`: a wrapper whose first call
  renames a second, whole copy over `served.json` and throws `LinkRefused(path, true)` —
  exactly what `openToRead` throws when that rename lands between its open and its check
  (row 19) — and whose later calls are `openToRead`'s; the read opens again and gives the
  second copy, never `link`. The same staging three times in
  a row gives `busy`; a real link at `served.json` gives `link` on the first open and is not
  retried as a replacement. The same two rows for the secret;
- a descriptor opened on one copy, a second renamed over it, the read finished on the
  descriptor: the first copy, whole and verified — `rename` never mixes two;
- a copy dated 10 minutes ahead of `now`: `read('kept')` gives it with `fetchedAt` in the
  future; `read('fresh')` gives `none: 'stale'`;
- a copy 6 minutes old with one byte of its body flipped: `read('fresh')` gives
  `none: 'stale'`, not `unverified` — a stale copy is not verified; `read('kept')` gives
  `unverified`;
- after a write, a sibling key's `served.json` with an `mtime` older than `keepMs` is gone and
  its folder removed; one younger is kept; a `*.tmp` older than the TTL is gone, a younger
  one kept; a file named otherwise, a link, a folder of another name are untouched;
- pruning never follows a link: a sibling key folder that is a link to a folder holding an
  old `served.json` leaves that file in place.
- an empty sibling key folder a second old, another run's between its `mkdir` and its
  temporary file, is left; one empty for longer than the TTL is removed;

Expected: FAIL. Then the replacement retry in `read`, and the pruning pass after `rename`.
Green.

- [x] **Step 7: The provider's three uses (fails: no `cache` option)**

`tests/unit/backstage-provider-cache.test.ts`, the fake as `catalogueFetch`, its `sent`
counted. Each row asserts the whole `cache` report, both facts:

| Use | Staged | Result |
|---|---|---|
| `fresh` | an empty root | one load; `cache: { read: absent, written }`, the copy on disk |
| `fresh` | a copy 4 min old | no request; the `LoadResult` equal to the fresh one's but `cache: { read: { state: 'fresh', ageMs: 240_000 } }`, no `written` — `census` included: the envelope keeps the census of the load that made the copy, and a read gives it back as it was (how the trace and the notice say a run that sent no request is 2.3's, Step 5) |
| `fresh` | a copy 6 min old, or dated ahead of now | a load, the copy replaced; `{ read: stale, written }` |
| `fresh` | a copy that does not verify | a load, the copy replaced; `{ read: { not-used, unverified }, written }` |
| `fresh` | `<key>` a file | a load; `{ read: { not-used, not-a-folder }, written: { not-written, not-a-folder } }` |
| `fresh` | a store that is unusable (`backstage/` `0o755`) | a load; `{ read: { not-used, refusal: { kind: 'open', path: 'idp-agent/backstage', mode: 0o755 } }, written: { not-written, same refusal } }`, nothing written |
| `fresh` | a load that fails, for reach, a copy 2 h old kept | the `CatalogueReadError` with `kept.ageMs` 7,200,000, nothing written, the old copy kept |
| `fresh` | a load that fails with a 401 or a 403, a copy kept | the `CatalogueReadError` with no `kept` |
| `refresh` | a copy 1 min old | a load, the copy replaced; `{ read: skipped, written }` |
| `refresh` | a load that fails for reach, a copy 1 min old kept | the `CatalogueReadError` with `kept.ageMs` 60,000; nothing written, the copy kept |
| `kept` | a copy 3 days old | no request; `{ read: { state: 'kept', … } }`, no `written` |
| `kept` | a copy dated ahead | read, `ageMs: undefined` |
| `kept` | no copy, or one that does not verify | `CatalogueReadError` `{ kind: 'not-kept' }`, no request; on an empty or missing root, or a store with no secret, nothing made — a kept read's store is read-only (`readOnly`), and a store not all there is `absent` |
| `fresh` | the provider's `limits` lowered to `modelledEntities: 40`, a copy made under the default | a load: another key, the default's copy never read |
| none | no `cache` option | exactly what `55fb995` does: no `cache` key on the result, no file anywhere |

and one row that proves the reader runs on a copy: a copy whose item was edited on disk to a
Component with `lifecycle: beta` and its MAC recomputed with the test's knowledge of the
secret reads that item set aside by the pre-pass, as a page would, never as an entity.

Expected: FAIL. Then the provider: the store made once per load with the effective limits,
the use decided before the transport is built, the translation loop unchanged. Green.

- [x] **Step 8: The architecture rules**

- *only context/iac-fs and context/project-fs read a user repository* (`:758-772`): its
  allow-list gains `'context/backstage/cache.ts', // the catalogue kept under the person's
  cache folder, never a repository`; its title becomes *in context/, only iac-fs, project-fs,
  the fixtures and the catalogue cache touch the disk*.
- *only the named modules write* (`:794`): `'context/backstage/cache.ts': ['rename',
  'unlink', 'rmdir']`, its comment: folders and new files through `confine/`, a copy renamed
  into place, a pruned copy unlinked and its empty folder removed.
- `CONFINES` (`:642-646`) gains `'context/backstage/cache.ts'`, and the rule's title (`:955`)
  names it.
- New: *only context/backstage/provider.ts loads context/backstage/cache.ts*, through
  `loaderOffences`, with a self-test beside `:1274` planting `cli/cached.ts` that loads it,
  one that loads it at run time by a name the source does not spell, and the provider
  handing it on with `export … from`: three offences. This is the rule that makes "a copy
  is never a source that skips the reader" structural: the one module that may take a
  `Served` from the store is the one whose loop runs the pre-pass and `readValue` on it.

```bash
pnpm vitest run tests/architecture --reporter=verbose
```

Expected: twenty-six rules, green; `AGENTS.md`'s paragraph says twenty-six and what the four
changed ones now say.

- [x] **Step 9: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/backstage-cache.test.ts tests/unit/backstage-provider-cache.test.ts tests/unit/confine.test.ts tests/unit/backstage-load.test.ts tests/architecture
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
git diff feat/bhttp-2-1 --stat -- tests/golden tests/recordings fixtures/si-demo scripts
```

The last prints nothing: no command uses the store yet.

- [ ] **Step 10: The pull request** (after the owner's go-ahead)

```bash
git add src/confine/confine.ts src/confine/README.md src/core/schemas/entity.ts \
  src/context/backstage/cache.ts src/context/backstage/load.ts src/context/backstage/limits.ts \
  src/context/backstage/transport.ts src/context/backstage/provider.ts src/context/provider.ts \
  src/context/README.md src/cli/source.ts tests/architecture/dependencies.test.ts \
  tests/unit/backstage-cache.test.ts tests/unit/backstage-provider-cache.test.ts \
  tests/unit/confine.test.ts tests/unit/backstage-load.test.ts AGENTS.md README.md CHANGELOG.md
git commit -m "feat(context): keep a catalogue read on disk for its own account, and read it back through the reader"
```

Base `feat/bhttp-2-1`. CHANGELOG, `### Added`:

> - The store a Backstage catalogue read will be kept in: under
>   `$XDG_CACHE_HOME/idp-agent/backstage/`, in folders only the person's account may open, keyed
>   by an HMAC of the catalogue and the token under a secret of this machine, written by
>   exclusive creation and renamed into place, and read back only after its owner, mode, links,
>   MAC, its account of its own reads and every item are checked again, then through the
>   pre-pass and the reader like any page. No command uses it yet; the next pull request does
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** nothing. `confine/` makes folders and files as before
for `init platform`.

**What the owner can run** (keyless, from the clone). The tests and the build, in one
terminal:

```bash
pnpm vitest run tests/unit/backstage-cache.test.ts tests/unit/backstage-provider-cache.test.ts tests/architecture --reporter=verbose
pnpm build
```

The fake, in that terminal, where it keeps running:

```bash
node tools/fake-backstage.ts --port 7011
```

In a second terminal:

```bash
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js show billing-api
ls ~/.cache/idp-agent
```

| Command | Prints | Exit |
|---|---|---|
| the tests | every row of Steps 3 to 8 green, the architecture list at twenty-six | 0 |
| `show billing-api` | as after 2.1: the golden, and the notice with no word of a cache | 0 |
| `ls ~/.cache/idp-agent` | `No such file or directory`, unless something else made it: no command writes there yet | 1 |

---

### Task 2.3: `--refresh`, `--cached`, and the age on every kept answer

**Goal.** A person's second run within five minutes answers from the kept copy and says how
old it is; `--refresh` reads Backstage again; `--cached` answers from the copy when Backstage
cannot be reached, and only when asked; the binary keeps copies under the person's cache
folder and no test does unless it asks; the demos, the smoke test and the documents say all
of it. Nothing kept reaches a plan.

**Files:**
- Modify: `src/cli/personal.ts` (`cacheRootOf`, beside `personalConfigFile`, `:64-78`),
  `src/cli/bin.ts`, `src/cli/index.ts` (`READ_OPTIONS`, `:873-877`; `readFrom`, `:884-905`;
  `parsePhrase`, `:656`; `ReadFrom`, `:118-121`; `MainDeps`, `:911-958`, `cacheRoot`;
  `providerOf`, `:1698-1733`; the read path after the load, `:1440-1490`;
  `sourceAttributes`; `HELP`, `:202-274`, whose read-command lines `usageOf`, `:598`,
  prints), `src/cli/source.ts`
  (`sourceNotice`'s catalogue case; `catalogueFailureLine`, `:772-778`; `whatFailed`'s
  `not-kept`), `src/cli/render/catalogue-read.ts` (`cacheLines`: the not-used and not-written
  lines), `src/cli/README.md`
- Modify: `.env.example` (`IDP_BACKSTAGE_CACHE`, question 2), `tests/setup/personal.ts`
- Modify: `scripts/demo-backstage.mjs`, `scripts/demo-backstage-docker.mjs`,
  `scripts/smoke.mjs`, `tools/backstage/README.md`
- Create: `tests/unit/backstage-cache-read.test.ts`, `docs/adr/0014-a-kept-catalogue-is-read-again.md`
- Modify: `tests/contract/key-reach.test.ts`, `tests/unit/backstage-read.test.ts`,
  `tests/unit/backstage-source.test.ts`, `tests/unit/personal-config.test.ts`,
  `tests/unit/cli-args.test.ts`,
  `tests/unit/env-example.test.ts` (only if it lists the variables by name),
  `tests/unit/demo-backstage.test.ts` (only if a row reads the script's steps)
- Modify: `SECURITY.md` (`:35-40` "Writes nothing, except"; a paragraph *The kept catalogue*;
  the guarantees' rows), `README.md` (`:578-600`; the exit codes; the roadmap row 6b; the
  badge), `AGENTS.md` (Current state; the writers; the test count), `docs/design.md` (§7.0,
  `:959-974`), `docs/adopting-backstage.md` (What a person gains, `:237-255`),
  `docs/adr/0011-backstage-to-explore.md` (its status line), `docs/backstage-http-brief.md`
  (slice 2 **Built**), `docs/roadmap.md` (the queue; the decisions), `CHANGELOG.md`

**Interfaces:**

```typescript
// src/cli/personal.ts
export type CacheRoot = { readonly dir: string } | { readonly none: 'off' | 'no-home' | 'platform' | 'root' }
/** $XDG_CACHE_HOME when absolute, else $HOME/.cache; none on Windows, as uid 0, with IDP_BACKSTAGE_CACHE=off, or with neither. */
export function cacheRootOf(env: Env, platform?: Platform, uid?: number): CacheRoot

// src/cli/index.ts
export type ReadFrom = (… as on 55fb995) & { refresh?: true; cached?: true }   // never both
export interface MainDeps { …; /** Absent: no cache, as in every test but the cache's own. bin.ts passes cacheRootOf(process.env, process.platform, process.getuid?.()). */ cacheRoot?: CacheRoot }

// src/cli/bin.ts
process.exitCode = await main(process.argv.slice(2), { cacheRoot: cacheRootOf(process.env, process.platform, process.getuid?.()) })
```

- [x] **Step 1: Where the cache lives (fails: no `cacheRootOf`)**

`tests/unit/personal-config.test.ts` gains the rows: an absolute `XDG_CACHE_HOME` is used; a
relative one is ignored, as for the config file; an absolute `HOME` gives `$HOME/.cache`;
neither, or a relative `HOME` (which would resolve against the working directory and put the
copy and its secret in a repository), is `{ none: 'no-home' }`; `win32` is `{ none: 'platform' }`; uid 0 is `{ none: 'root' }`, with
`HOME` or `XDG_CACHE_HOME` set or not; `IDP_BACKSTAGE_CACHE=off` is
`{ none: 'off' }` whatever else is set, and any other value of it is refused where the source
is resolved, exit 2 (`off` is the one value, so a typo never keeps what was meant to be
kept nowhere). And the setup row: `process.env.XDG_CACHE_HOME` is inside the run directory
(`tests/setup/personal.ts`), as `XDG_CONFIG_HOME` is, and is a path no one has made — the
store makes it, one name deep, as 2.2 Step 3 proves; so the row does not make it either.
Expected: FAIL. Then `cacheRootOf`,
and one line in the setup file. Green.

- [x] **Step 2: The flags (fails: `--refresh` is an unknown option)**

`tests/unit/backstage-source.test.ts`:

| Arguments | Result |
|---|---|
| `graph --refresh`, `show x --cached`, `relations x --impacts --refresh`, `ask "q" --cached`, `idpa "q" --refresh` | parsed, the flag on `ReadFrom` |
| `graph --refresh --cached` | exit 2: `graph takes --refresh or --cached, never both: one reads Backstage again and the other only the kept copy` |
| `graph --cached --repo x`, `show x --refresh --demo` | exit 2: `--cached reads a kept copy of a Backstage catalogue, and --repo names a repository` (and `--demo` likewise) |
| `plan "x" --refresh`, `validate d --cached` | exit 2, unknown option, as today |
| `graph --cached` standing in a declarations repository | exit 2: `--cached reads a kept copy of a Backstage catalogue, and this run reads the declarations repository <dir> (the current directory); --backstage reads the catalogue`, before any request |
| `graph --cached` with `cacheRoot: { none: 'off' }` | exit 2: `--cached reads a copy this tool keeps, and none is kept here: IDP_BACKSTAGE_CACHE is off` (and `'no-home'`: `neither XDG_CACHE_HOME nor HOME names an absolute folder`; `'platform'`: `this tool keeps none on Windows`; `'root'`: `this tool keeps none for root, so a sudo run never leaves company data owned by root in a home`) |
| `usageOf('graph')`, `'show'`, `'relations'`, `'ask'`, `'entry'` (`cli-args.test.ts`) | each names `[--refresh \| --cached]`; `usageOf('plan')`, `'validate'`, `'init'` name neither |

Expected: FAIL. Then `READ_OPTIONS` and the phrase parser gain the two booleans, `HELP`'s
read-command lines the two flags, `readFrom` the refusals, and the source check after
`sourceOf`. Green.

- [x] **Step 3: A second run, from the copy (fails: every run reads Backstage)**

`tests/unit/backstage-cache-read.test.ts`, through `main` with the fake as `catalogueFetch`,
`cacheRoot: { dir: <mkdtemp under the run directory> }`, and `now` driven through
`vi.useFakeTimers({ toFake: ['Date'] })` and `vi.setSystemTime`, so no timer the transport arms is faked:

| Row | Asserts |
|---|---|
| first run | exit 0; the fake sent the facets and the pages; stderr's notice as without a cache, byte for byte; a copy under `<dir>/idp-agent/backstage/<32 hex>/served.json` |
| first run, `<dir>` a path not yet made in an existing folder | the same, `<dir>` made `0o700`; `<dir>`'s parent missing too: exit 0, read from Backstage, one line `this read of the catalogue was not kept: <dir> does not exist, nor does the folder above it` |
| second run, 3 minutes later | exit 0; **the fake sent nothing**; stdout byte for byte the first run's; the notice ends `…, 0 not modelled; read from cache, 3 min old; --refresh reads Backstage again; it may lag the declarations repository by minutes; --repo <directory> reads a repository` |
| 40 seconds later | `read from cache, less than a minute old` |
| 6 minutes later | the fake is sent the read again, the notice has no cache words, the copy is replaced |
| `--refresh` 1 minute later | the fake is sent the read; no cache words; the copy is replaced |
| a partial copy (2.1's catalogue, bound lowered through `catalogueLimits` on both runs) | read from it: the notice's `past the bound` term and the `past the bound:` line as the first run's, then the age; the same catalogue with the bound lowered only on the second run reads Backstage, another key |
| `--cached`, the fake answering `ECONNREFUSED`, a copy 2 days old | exit 0; nothing sent; `read from cache, 2 days old, as --cached asks: Backstage was not asked` |
| `--cached`, no copy | exit 1: `the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL) was not read: no copy of it read with this token is kept on this machine (--cached); run without --cached to read it` |
| unreachable, a copy 2 hours old, no flag | exit 1: the line of `55fb995` with `; --cached reads the copy kept 2 h ago` before `; --repo <directory> reads …` |
| unreachable, a copy 2 minutes old, `--refresh` | exit 1: the same line, `; --cached reads the copy kept 2 min ago` |
| 401, a copy kept | exit 1: the line of `55fb995`, byte for byte, with no `--cached` |
| a copy dated 10 minutes ahead, no flag | read from Backstage; with `--cached`: `read from cache, of an age this clock cannot tell (dated 10 min ahead of it)` |
| `backstage/` at `0o755` | exit 0, read from Backstage; one line: `the cache at <dir>/idp-agent/backstage was not used: others may open it (mode 0755); nothing was changed`; with `--refresh`, which never uses a copy, `read: skipped` and only `… could not keep this read: others may open it (mode 0755); nothing was changed` |
| a copy that does not verify | exit 0, read from Backstage; one line, from `{ read: not-used, written }`: `the kept copy of this catalogue did not verify (its MAC) and was not used; it is replaced by this read` |
| `served.json` a symbolic link | exit 0, read from Backstage; from `{ read: not-used, written: not-written }`, one line: `the cache at <path> was not used and this read was not kept: <path> is a symbolic link, never followed; nothing was changed`; the link and its target untouched |
| `<key>` a file | exit 0; from `{ read: not-used, written: not-written }`, one line, since both say one thing: `the cache at <path> was not used and this read was not kept: <path> is not a folder` |
| the trace | `idp.source.cache_read` is `fresh`, `kept`, `stale`, `absent`, `skipped`, `not-used` or `off`; `idp.source.cache_written` is `written` or `not-written` when Backstage was read, absent otherwise; `idp.source.cache_age_s` when a copy answered |
| the trace and the notice, a run answered from a copy | the `LoadResult`'s `census` is the load's that made the copy (2.2 keeps it in the envelope and gives it back): `idp.source.pages`, `bytes` and `ms` are that load's network cost, not this run's, and the notice's served-twice clause is that load's. Decide here, and pin with a row, how a run that sent no request is traced — the three attributes absent or zero, or this run's own read time — and whether the clause is said again; Step 6's second-run time is measured on that decision, not on the census a copy carries. **Decided:** `pages` and `bytes` are `0` and `ms` is this run's own time reading the copy (a row makes the first load slow so the two differ); the clause is said again after `read from cache, <age>`, as the earlier read's: `the catalogue changed during the read this copy keeps (U served twice)` |
| no `cacheRoot` | every line and file exactly as `55fb995`'s: nothing under the run directory, no cache words |

Expected: FAIL. Then `providerOf` hands the provider `cache: { root, owner: process.getuid(),
use }` when `deps.cacheRoot` is `{ dir }`; `sourceNotice` takes `loaded.cache` and prints the
age; `cacheLines` reads both facts of the report and prints the not-used and not-written
lines after the notice, one line when they name one path and one reason;
`catalogueFailureLine` takes `error.kept`; the trace attributes. Green.

- [x] **Step 4: Nothing kept reaches a plan, and no token is at rest (fails: the cache is new)**

- `tests/unit/backstage-read.test.ts`, beside *lets nothing in the catalogue vouch …*
  (`:386`): a first run keeps a copy whose Component names owner `group:default/invented`,
  which the configured repository does not declare; a second run, `idpa "<change>"` naming
  that owner, with a `catalogueFetch` that throws if called: the Supervisor is shown the
  kept catalogue's summary, the plan still asks about the owner, exit 3, and nothing was
  sent. And `idpa plan … --refresh` stays exit 2, unknown option.
- `tests/contract/key-reach.test.ts`, the Backstage leg (`:489`): with a `cacheRoot`, after
  each provider's question and change, every file and every name under the root is read,
  and none holds the canary token, its sha256 or its base64; and the same token and base
  under two roots — two secrets — give two different key folders, neither of which is the
  token's sha256 or a prefix of it: the folder's name depends on the secret, not only on the
  token.

Expected: FAIL (the test has no root to read). Green once Step 3 is in.

- [x] **Step 5: The binary, the demos and the smoke test**

- `scripts/smoke.mjs:119-123`: `CLEAN_ENV` gains `XDG_CACHE_HOME: path.join(ELSEWHERE,
  'cache')`, a folder no one makes — the store makes it, one name deep — for smoke's own
  runs of the binary. Its run of `pnpm demo:backstage` needs nothing more: the demo sets its
  own. Smoke's checks of the demo (`:677-684`) gain two:
  `/^reading the Backstage catalogue at 127\.0\.0\.1:\d+ \(IDP_BACKSTAGE_URL\): 40 entities: 40 read, 0 not modelled; read from cache, less than a minute old; --refresh reads Backstage again;/m`
  and `/^the fake Backstage was sent no request for the second read$/m`. This is where the
  suite proves `bin.ts` hands the root in: smoke fails if the second read reaches the fake.
- `scripts/demo-backstage.mjs`: `environment` gains `XDG_CACHE_HOME`, a `cache` path inside a
  `mkdtemp` scratch removed on exit. Steps 1 and 2 already read one base seconds apart
  (`:146-160`), so **step 2 is the second read**, and no step is added: its title becomes
  `2. What billing-api is, from the same catalogue: answered from the copy step 1 kept`, its
  stdout still the golden, its stderr now ending in `read from cache, less than a minute old;
  --refresh reads Backstage again; …`. The count line after step 1 becomes `the fake
  Backstage answered N requests for the first read`, and after step 2 the demo prints
  `the fake Backstage was sent no request for the second read`, or fails with the number it
  was sent. Step 3, the plan that sends nothing, counts from after step 2, as it counted from
  after the two reads.
- `scripts/demo-backstage-docker.mjs:203-209`: `environmentWith` sets `XDG_CACHE_HOME` to
  `path.join(scratch, 'cache')` (the store makes it), so steps 3 and 4 answer from the copy
  step 2 kept — their stdout comparisons unchanged, their stderr ending in `read from cache`.
  A new **step 5, `--refresh` reads Backstage again**, runs `show billing-api --refresh`:
  exit 0, stdout the golden, no cache words. The steps that were 5 and 6 become 6 and 7;
  step 6, with no token, is a new key and still reaches Backstage and its 401.
- `tools/backstage/README.md`: both demos' new lines and the Docker demo's numbering.

- [x] **Step 6: Under a second (measured, not asserted by the suite)**

With the fake at `--scale 20500` on 7011 and a scratch `XDG_CACHE_HOME`, `show billing-api`
three times, the second and third timed. The target is the note's: under a second, wall
clock, on the owner's machine. The measured numbers — first run, second run, and the
second run's `idp.source.ms` from `IDP_TRACE_DIR` — go into the pull request's description.
If the second run takes a second or more: profile which part (the parse, the MAC, the
pre-pass, `readValue`, the graph) and bring the numbers to the owner before merging. The
reader is never skipped to meet it; the copy is a `Served` because a translated `LoadResult`
on disk would be a source that passes no schema (the note's § 15).

- [x] **Step 7: The documents**

- `docs/adr/0014-a-kept-catalogue-is-read-again.md`: *Context* — ADR-0011 left the cache to
  this slice; every run, `idpa "<change>"` included, paid the whole catalogue read.
  *Decision* — a read is kept 5 minutes under the person's cache folder, in folders only their
  account opens, keyed by an HMAC of the base and the token under a per-machine secret; a copy
  is the raw read, minimised as the fields asked, and every read of it meets the load's
  checks, the pre-pass and `readValue`; `--refresh` and `--cached`; the age always said; no
  automatic fall back; nothing kept reaches a plan. *Rejected* — the translated `LoadResult`
  on disk; a plain hash key; a MAC over the body alone (a header's date would be unsealed,
  and a copy readable under another key); a cache inside the repository or `/tmp`; an
  automatic fall back to a copy; `--cached` offered after a 401; a cache for root. *Consequences* — company data at rest on the
  person's disk, which `SECURITY.md` states; a copy may lag Backstage by five minutes on top
  of Backstage's own lag.
- ADR-0011's status line: `amended by 0013 and 0014`.
- `SECURITY.md`: "Writes nothing, except" (`:35-40`) names the kept catalogue, and
  `context/backstage/cache.ts` among the named writers; a paragraph *The kept catalogue*,
  the table [The cache as company data at rest](#the-cache-as-company-data-at-rest) in prose —
  who can read it, backups, `XDG_CACHE_HOME` and `IDP_BACKSTAGE_CACHE=off`, the clock, what
  `confine/` cannot close; that a revoked token keeps answering from its own fresh copy for
  at most 5 minutes, and from any copy with `--cached`, and that `--refresh` is what proves a
  token still reads; that a run as root keeps nothing, and that a tree under the cache folder
  owned by another account is refused, never repaired, and removed by that account
  (`sudo rm -rf ~/.cache/idp-agent` when root made it); two guarantee rows: *a kept catalogue is opened only by its
  account, never through a link, and read again through the reader* → `backstage-cache.test.ts`,
  and *nothing kept reaches a plan, and no token is at rest* → `backstage-read.test.ts`,
  `key-reach.test.ts`.
- `README.md:578-600`: two sentences after "once per run": a read is kept five minutes under
  `~/.cache/idp-agent/backstage`, only for your account, and a second run says `read from
  cache, 3 min old; --refresh reads Backstage again`; `--cached` answers from the kept copy,
  whatever its age, when Backstage cannot be reached, and never otherwise. The exit codes:
  `--cached` with no copy is `1`. The roadmap row 6b: slice 2 done.
- `AGENTS.md`: "Current state" names the cache and the two flags; the writers sentence.
- `docs/design.md` §7.0 (`:973-974`): the cache sentence and `--cached`.
- `docs/adopting-backstage.md` (`:249-251`): "read once per run" gains "and kept five
  minutes for your account".
- `docs/backstage-http-brief.md`, slice 2: **Built** (the three pull requests, this plan),
  with the departures: three pull requests; closed by 2.3; all three ceilings stated
  (question 3); *never called dangling* narrowed to a reference into a kind whose read was
  bounded, a reference into a kind read whole still declared nowhere; the count of what a
  bound left out worded `past the bound`, `not loaded` kept for a reference (question 5);
  `show` on a hit closing with the `partial:` line; the copy minimised (row 5), stored as
  lines, sealed over its header and key, and its `judged` recomputed; the root handed in by
  `bin.ts`, made one name deep when missing, and none for root; `--cached` never after a 401
  or a 403, and named after a failed `--refresh`; the off switch (question 2); 7 days of
  retention (question 1).
- `docs/roadmap.md`: slice 2 leaves the queue; the decisions list records the owner's answers
  to this plan's questions.

- [x] **Step 8: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/backstage-cache-read.test.ts tests/unit/backstage-source.test.ts tests/unit/personal-config.test.ts tests/unit/backstage-read.test.ts tests/contract/key-reach.test.ts tests/scenarios
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
git diff main --stat -- tests/golden tests/recordings fixtures/si-demo
ls ~/.cache/idp-agent
```

`git diff` prints nothing; `ls` says there is no such folder unless the owner's own runs made
one: the suite and the smoke test wrote only under their scratch folders.

- [ ] **Step 9: The pull request** (after the owner's go-ahead)

```bash
git add src/cli/personal.ts src/cli/bin.ts src/cli/index.ts src/cli/source.ts \
  src/cli/render/catalogue-read.ts src/cli/README.md .env.example tests/setup/personal.ts \
  scripts/demo-backstage.mjs scripts/demo-backstage-docker.mjs scripts/smoke.mjs tools/backstage/README.md \
  tests/unit/backstage-cache-read.test.ts tests/contract/key-reach.test.ts tests/unit/backstage-read.test.ts \
  tests/unit/backstage-source.test.ts tests/unit/personal-config.test.ts tests/unit/cli-args.test.ts \
  docs/adr/0014-a-kept-catalogue-is-read-again.md docs/adr/0011-backstage-to-explore.md \
  SECURITY.md README.md AGENTS.md docs/design.md docs/adopting-backstage.md \
  docs/backstage-http-brief.md docs/roadmap.md CHANGELOG.md docs/plans/backstage-http-slice-2.md
git commit -m "feat(cli): answer a second run from the catalogue kept five minutes, and say how old it is"
```

Add `tests/unit/env-example.test.ts` and `tests/unit/demo-backstage.test.ts` to the list if
Step 1 or 5 changed them. Base `feat/bhttp-2-2`. CHANGELOG, `### Added`:

> - A Backstage catalogue read is kept five minutes under `~/.cache/idp-agent/backstage`
>   (`$XDG_CACHE_HOME` when set), for your account only, and a second run answers from it
>   and says so: `read from cache, 3 min old; --refresh reads Backstage again`. `--refresh`
>   reads Backstage again; `--cached` answers from the kept copy whatever its age — when
>   Backstage cannot be reached, for example — and only when asked; `IDP_BACKSTAGE_CACHE=off`
>   keeps nothing. A kept copy is read again through the same checks and reader as a page,
>   holds no token, and never reaches a plan
>   ([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM)).

**What changes that a person sees:** the second run of a read command or a question within
five minutes sends Backstage nothing and says the copy's age; `--refresh` and `--cached`; a
line when a copy could not be used or kept; after a failure of reach, the failure line names
`--cached` when a copy is kept; `~/.cache/idp-agent/backstage` on their disk. `plan`, `init`
and `validate` do not change.

**What the owner can run** (after `pnpm build`, from the clone). The fake in one terminal:

```bash
node tools/fake-backstage.ts --port 7011 --scale 20500
```

In a second terminal, a scratch cache so the owner's own `~/.cache` is not touched:

```bash
export IDPA_DEMO_CACHE="$(mktemp -d)"
export IDPA_URL=http://127.0.0.1:7011/api/catalog
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js show billing-api
time env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js show billing-api
ls -la "$IDPA_DEMO_CACHE/idp-agent/backstage"
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js show billing-api --refresh
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js show scale-20400
```

| # | Command | Prints | Exit |
|---|---|---|---|
| 1 | first `show billing-api` | the notice of 2.1 (`20,540 entities: 20,007 read, 0 not modelled, 533 past the bound`), the `past the bound:` line; stdout the golden, then the `partial:` line | 0 |
| 2 | the timed second | the same stdout; the notice ends `…, 533 past the bound; read from cache, less than a minute old; --refresh reads Backstage again; it may lag …`; the time under 1 s (zsh's `total`, bash's `real`: `time` is given the command itself, never a shell function, which zsh times as nothing); the fake's terminal logs no request | 0 |
| 3 | `ls -la` | `drwx------` for `.`, one folder of 32 hex characters `drwx------`, `secret` `-rw-------`; `$IDPA_DEMO_CACHE` itself was made by `mktemp -d`, and `idp-agent` under it by the first run | 0 |
| 4 | `--refresh` | the fake logs the facets and 81 pages — 80 of Components, Resources and APIs, stopped at the bound, and one of the organisation; no cache words | 0 |
| 5 | `show scale-20400` | from the copy, `No entity named "scale-20400" in the part of the catalogue read: …` | 1 |

Three minutes later, the closing line of the slice:

```bash
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js relations mysql-prod-01 --impacts
```

| Prints | Exit |
|---|---|
| stderr's notice holds `read from cache, 3 min old; --refresh reads Backstage again; …`; stdout the README's table and the `partial:` line | 0 |

Then stop the fake (Ctrl-C in its terminal), and in the second terminal:

```bash
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js show billing-api --refresh
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js show billing-api --cached
chmod 755 "$IDPA_DEMO_CACHE/idp-agent/backstage"
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" node dist/cli/bin.js show billing-api --cached
chmod 700 "$IDPA_DEMO_CACHE/idp-agent/backstage"
```

| Command | Prints | Exit |
|---|---|---|
| `--refresh`, the fake stopped | `… could not be reached (ECONNREFUSED); --cached reads the copy kept 3 min ago; --repo <directory> reads a repository instead, …` | 1 |
| `--cached` | the golden, then the `partial:` line; `read from cache, 3 min old, as --cached asks: Backstage was not asked` | 0 |
| `--cached`, the folder `0755` | `the cache at …/idp-agent/backstage was not used: others may open it (mode 0755); nothing was changed`, then `--cached … no copy … is kept` | 1 |

The token, with the fake restarted as `node tools/fake-backstage.ts --port 7011 --token demo-canary-7011`:

```bash
env -u IDP_REPO XDG_CACHE_HOME="$IDPA_DEMO_CACHE" IDP_BACKSTAGE_URL="$IDPA_URL" IDP_BACKSTAGE_TOKEN=demo-canary-7011 node dist/cli/bin.js show billing-api
ls "$IDPA_DEMO_CACHE/idp-agent/backstage"
grep -rl demo-canary-7011 "$IDPA_DEMO_CACHE"
rm -rf "$IDPA_DEMO_CACHE"
```

| Command | Prints | Exit |
|---|---|---|
| `show billing-api` with the token | the golden; no cache words: a new token is a new key | 0 |
| `ls` | two folders of 32 hex characters, and `secret` | 0 |
| `grep` | nothing: the token is in no file | 1 |

And the demos:

```bash
pnpm demo:backstage
pnpm demo:backstage:docker
```

| Command | Prints | Exit |
|---|---|---|
| `pnpm demo:backstage` | every step as documented; step 2 `read from cache, less than a minute old` and `the fake Backstage was sent no request for the second read` | 0 |
| `pnpm demo:backstage:docker` (needs Docker) | every step as documented; steps 3 and 4 read from the kept copy, step 5 (`--refresh`) reads Backstage again with no cache words, step 6 still `(401)` | 0 |

---

## Questions for the owner

All five settled by the owner on 2026-09-30, as recommended (recorded in
[`docs/roadmap.md`](../roadmap.md)'s decisions). The last line of each still says what would
have changed, so a later reversal knows where to look.

1. **Settled: a copy is kept 7 days.** Recommended: **7 days**, then removed by the next run that
   writes one — its own key's too — so a copy some token no longer reads does not sit on disk
   for good, and `--cached` still covers a long weekend's outage. The TTL (5 minutes) decides
   only what is read without asking; this decides what is at rest. Shorter (24 hours) holds
   less company data and makes `--cached` useless after a day off. If not 7 days:
   `CATALOGUE_CACHE.keepMs` and two sentences change.
2. **Settled: an off switch, `IDP_BACKSTAGE_CACHE=off`.** The note has none, so today a person whose
   company forbids catalogue data at rest could only point `XDG_CACHE_HOME` at a folder the
   tool cannot write, and read a "not kept" line on every run. Recommended: **yes**, `off`
   its only value (anything else refused, exit 2, so a typo never keeps what was meant to be
   kept nowhere), listed in `.env.example`, removed from children with the other
   `IDP_BACKSTAGE_*` variables by `spawnedEnvironment`. If no: Step 1 of 2.3 loses one row
   and `cacheRootOf` its first line.
3. **Settled: all three ceilings are stated bounds.** The note names the modelled
   ceiling. Recommended: **all three**, one semantics — a bounded organisation read is not
   judged, a bounded refs read leaves its kinds not loaded — since refusing at 200,001 Users
   while answering at 20,001 Components gives the rarer case the harsher answer. If only the
   modelled one: the other two keep `too-many` and their sentences, Step 3 of 2.1 keeps two of
   its three refusing rows.
4. **Settled: three pull requests, not the note's two**, closed by 2.3 rather than 2.2 — the store with
   its proofs before any command writes (the section above says why). Recommended: yes, as
   slice 3 went. If two: 2.2 and 2.3 are one pull request, and its review reads `confine/`,
   the store and the command line together.
5. **Settled: new words for what a bound left out.** `not loaded:` already begins the stderr line that
   counts documents of a kind this tool does not model, and the overview's row of them
   (row 17), both printed on every whole read. Recommended: **new words** — the notice's term
   `533 past the bound`, a stderr line `past the bound: …`, an overview block headed
   `partial` — and `not loaded` kept only as the marker a reference carries, which is the
   state the note names. Every whole read stays byte-identical. The alternative renames the
   existing line (to `not modelled:`, say) and gives `not loaded:` to the bound: closer to
   the note's words, but it moves `README.md:656`, the overview's row, the Docker demo's
   stderr and every test that asserts them. If renamed: 2.1 gains that rename and those
   files, and the byte-neutrality constraint names the moved line as its one exception.
