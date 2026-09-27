# `backstage-http` slice 1 — questions and relations against a Backstage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

**Goal.** With a Backstage configured, `graph`, `show`, `relations`, `ask` and `idpa
"<phrase>"` answer from the company's catalogue, read over HTTP once per run before any
model, through the same reader as a YAML file; a change is still decided against the
declarations repository alone.

**The design** is [`docs/backstage-http-brief.md`](../backstage-http-brief.md) (merged
[#84](https://github.com/pcaboor/idp-agent/pull/84), amended
[#86](https://github.com/pcaboor/idp-agent/pull/86)); the owner accepted every
recommendation of its § 14 on 2026-09-27. This plan gives the steps of its slice 1 (§ 13),
six stacked pull requests, 1.1 to 1.6. Where the note's assumptions no longer hold on
`main` at `60974de`, the section [Where the code moved since the note](#where-the-code-moved-since-the-note)
says so and says how each task adapts. Every file, function and line named below was read
on `60974de`.

**Architecture.** Two refactors first, each with no change in behaviour: the reader's
per-value loop becomes `readValue` in `core/` (1.1), and a run's read source and the
repository a change is decided against become two resolutions (1.2). Then the HTTP code,
from the inside out: one transport that is the only code sending the token, proven against
an injected `fetch` (1.3); the load, the catalogue pre-pass and `BackstageProvider`, proven
against an in-process fake (1.4); the source, the configuration and the live key-reach leg,
which is where a real run first reaches a Backstage (1.5); the summary cap and the documents
(1.6).

**Tech stack.** TypeScript 7, Node 22+ (the demo's fake needs 22.18+, see 1.4), Vitest 5,
Zod 4, `yaml` 2. No new dependency: `@backstage/catalog-client` is rejected by the note
(§ 15).

**Branches.** `feat/bhttp-1-1` (this worktree, from `main` at `60974de`) to
`feat/bhttp-1-6`, each cut from the one before, one pull request each, merged bottom-up
with `--rebase`. This plan file is committed with 1.1, and its boxes are ticked by the pull
request that does each step.

## Global Constraints

Inherited and still binding: `AGENTS.md`, `docs/design.md` §4, the note's § 4, § 6 and § 8.
Every task carries all of them; a task that cannot is stopped and brought to the owner.

- **`pnpm test` needs no key, no network and no Docker.** `tests/setup/offline.ts` makes
  `fetch`, `node:http`, `node:https`, `node:net`, `node:tls` and `WebSocket` throw, and
  `tests/setup/shell.ts` removes every `IDP_` variable but `IDP_TRACE_DIR`, so
  `IDP_BACKSTAGE_URL` and `IDP_BACKSTAGE_TOKEN` never reach a test from a shell. No test
  opens a socket.
- **The transport is tested only against an injected `fetch`**: `tests/support/fake-backstage.ts`,
  in process. The fake arrives in 1.4, so 1.3's transport tests use a hand-written `fetch`
  of the same shape (a function that keeps every call and answers what the case needs);
  from 1.4 on, every test above the transport goes through the fake. The demo runs against
  `tools/fake-backstage.ts`, `node:http` on `127.0.0.1:7007`, which no test starts.
- **The token.** It comes only from `IDP_BACKSTAGE_TOKEN`. It is sent from one function
  (`context/backstage/transport.ts`), only to the configured origin, on the two `GET`
  routes `entities/by-query` and `entity-facets`, with `redirect: 'error'`, never through a
  redirect, never into a child process, and never into a `LoadResult`, an agent input, a
  trace, an error message or any output. **No pull request merges code that sends the token
  without the test that proves where it goes**: 1.3 carries the transport's proofs, and the
  first pull request in which a real run reaches a Backstage (1.5) carries the live
  key-reach leg.
- **Backstage is read once per run, before any model is called**, into the same in-memory
  graph the files fill. No model output ever becomes a request.
- **The same reader.** Every item Backstage serves goes through `readValue`, the YAML road's
  per-value loop. It reads `spec`, never `relations[]`.
- **A partial read is refused, never answered from.** Every bound that would leave the graph
  incomplete ends the run on exit 1, stdout empty.
- **Backstage answers questions; the declarations repository decides changes.** Nothing read
  over HTTP reaches a plan's signature, its policies, its re-check or its Reviewer.
- **No recording changes.** `tests/recordings/` is not touched, and every scenario tape
  replays with the bytes it had: the prompts the tapes were recorded with do not move.
- **Hands off the owner's stage-5 work.** `tests/invariants/arbitraries.ts` and
  `tests/invariants/core.test.ts` are not touched. No task touches `src/core/plan/` or
  `src/core/paths/`; the only `core/` file changed is `src/core/yaml/serialize.ts` (1.1).
- **Nothing read from a catalogue reaches a committed file.** `tests/setup/shell.ts` removes
  `IDP_BACKSTAGE_URL` and `IDP_BACKSTAGE_TOKEN` even while a scenario records (1.5), so a
  recording shell that exports them cannot put catalogue content into a tape.
- **Goldens and `fixtures/si-demo/` are unchanged.** Tests read them; none rewrites them, and
  no new file is added under `tests/golden/`.
- **Traceability.** Every pull request adds its line under `## Unreleased` in `CHANGELOG.md`,
  in the section that fits, ending `([#92](https://github.com/pcaboor/idp-agent/pull/92))`.
  Every pull request re-measures and corrects the numbers `AGENTS.md` states (the test count,
  also on the README's badge, and the architecture-rule count) in the same commit as the
  change. 1.6 removes slice 1 from `docs/roadmap.md`'s queue, marks the note's slice 1
  **Built**, and closes review id domain-backstage-8 in the review's Status section.
- **Each pull request is green on its own**: `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm smoke`, the five CI runs, plus `pnpm vitest run tests/architecture --reporter=verbose`
  to count the rules. The suite leaves temp directories behind: check `df -h` before a
  test-heavy step.
- **Standing rules.** No commit, push or pull request without the owner's go-ahead. The owner
  works in the main checkout at the same time: work in `~/Documents/idp-agent-worktrees/bhttp`
  and stage files by name, never `git add -A`. English throughout, Conventional Commits, and
  no `switch` on a closed union without `const exhaustive: never = value` in `default`.
- **"What the owner can run"** ends every task: keyless commands and their expected output,
  from 1.5 on against `tools/fake-backstage.ts`. They are run and checked by whoever executes
  the task before they are handed over (the owner's kit lives in `~/Documents/idp-agent-tests/`).

---

## Where the code moved since the note

The note cites `main` at `44fcfed`. `main` is at `60974de`, about seventeen pull requests
later (#71 to #91: batches A1 to A5, slice 0, environment pointing, the relations view, the
tracing stack). Each row is an assumption of the note checked against the worktree, and what
this plan does about it. A line reference that merely shifted is listed once, so that
nobody follows a stale one.

| # | The note says | On `60974de` | This plan |
|---|---|---|---|
| 1 | § 5: `parseDocuments` (`serialize.ts:400-446`) "becomes `readDocuments` → `readValue`" | `parseDocuments` is `src/core/yaml/serialize.ts:413-470`, its loop `:435-467`. **`readDocuments` already exists** (`:183-201`): the YAML half, text to values with a parser fault as an error, called also by `core/plan/effect.ts:48,85` and `core/validate/registration.ts:276`. And since #91 the loop also collects `unread` (`unreadFieldsOf`, `core/schemas/entity.ts:374`) | 1.1 adds `readValue(value)` beside it, returning one of five readings with `unread` in the two that read; `parseDocuments` keeps its name and signature and becomes `readDocuments` then `readValue` per value. No caller changes |
| 2 | `LoadResult` "returns what it rejected and what it set aside" (`provider.ts:31-45`) | `LoadResult` (`src/context/provider.ts:31-46`) has a fourth field, `unread` (#91): every key the read model does not read — `relations`, `metadata.uid`, `spec.consumesApis` — one path per document, printed on a `not read:` line (`cli/index.ts:1240`, `notRead` at `:1504`) | The pre-pass (1.4) removes `relations`, `status`, `metadata.uid` and `metadata.etag` before `readValue`, keeping the uid aside for its own check, so a catalogue read prints the file road's `not read:` line, not one line per catalogue field. `LoadResult` gains an optional `census` (1.4) for the notice's counts |
| 3 | § 5: "`byRef` keeps the last of two with one key (`:85`)", the reason for setting other namespaces aside | Since #90 (domain-backstage-10) the graph keeps the **first** declaration of a reference (`entity-graph.ts:92-94`) and `all()` keeps both | The rule stands, for the same outcome: a `component:default/x` read from namespace `payments` would shadow, or be shadowed by, its namesake in silence, and the overview would count both. 1.4 states the current reason in the code |
| 4 | `entity-graph.ts:131` (resolved against the refs set aside), `:155-164` (`aside`) | The `aside` test is at `:153`; `EntityGraph.from(entities, aside)` at `:174-176`; `refOf` unchanged at `:15-17` | None; cited as they are now |
| 5 | § 6: `formatSummary` prints every value (`src/agents/summary.ts:9-25`); `ask.ts:134-139` passes the whole vocabulary | `formatSummary` is `src/agents/summary.ts:49-67`, and #91 added `vocabularyValue` (one line, 128 code points) and `listed` (values that flatten alike given once). `ask.ts:131-136` already maps `vocabularyValue`. `formatSummary` has two callers the note does not name: the Architect's (`cli/commands/plan.ts:1297`) and `init`'s (`cli/commands/init.ts:780`) | 1.6 caps after `listed`, the frequencies of values that flatten alike summed, at the one caller the note names: `ask.ts`, whose summary is the Supervisor's and the Analyst's. The Architect's (`plan.ts:1297`) and `init`'s (`init.ts:780`) are left whole: they read a declarations repository, not a catalogue, and capping them would change what the Architect is shown on a repository of more than 30 owners, which the note does not ask for. Every demo list is under 30, so every prompt, and every tape's digest, is unchanged |
| 6 | "the 30 most frequent" | `summariseGraph` (`context/graph/summary.ts:26-63`) returns sorted unique lists and no counts; `Vocabulary` (`core/schemas/vocabulary.ts`) is read by `core/plan/sign.ts` | 1.6 makes `summariseGraph` also return `counts`; `Vocabulary` and every gate reading it are unchanged ("the whole vocabulary stays for the gates") |
| 7 | `cli/index.ts`: the entry road loads the read source at `:1058-1065`, `entry` at `:1103`, `declarationsOf(source)` at `:1125`, `MainDeps.fetch` at `:694-695`, `notLoaded` at `:1308-1332`, `idp.inspector` at `:1031-1033` | `providerOf(...)` is called at `:1223` and defined at `:1420-1438`; the `entry` branch is `:1269-1354`; `declarationsOf(source)` is `:1291`; `MainDeps` is `:788-822` with `fetch` at `:821`; `notLoaded` is `:1481-1497`; `idp.inspector` is `:1197`; the MLflow sink takes `deps.fetch ?? globalThis.fetch` at `:1719`; `failed` is `:1645-1685` | Cited as they are now |
| 8 | § 13, 1.5: the exhaustive switches include `declarationsOf` (`source.ts:363-380`) | `declarationsOf` has one caller, `cli/index.ts:1291` | 1.2 replaces that call with the second resolution; `declarationsOf` then has no caller and is removed. 1.5's switches are `originText`, `overviewName`, `blameOf`, `sourceNotice`, `providerOf` and the new ones it adds. `namedBy` (`source.ts:295-311`) is a sixth switch, on `Origin`, and it names a repository (`--repo`, `repo in <file>`): `blameOf`'s `backstage` case does not call it, and names the catalogue's setting itself (1.5) |
| 9 | § 10: the notice carries the counts ("N entities: M read, K not modelled") | `providerOf` prints the notice **before** the load (`:1427-1428`) | 1.5 prints the notice after the load, for every source. Nothing is printed during a load, so the stderr of a repository or the demo SI is byte for byte what it was, and the existing tests say so |
| 10 | § 9: `graph`, `show`, `relations` and "the `ask` overview give stdout byte-identical to `--demo`" | The overview names its source in its first line (`cli/render/overview.ts:82-86`, from `overviewName`), and it counts the documents set aside (`context/graph/overview.ts:185-190`) | The equivalence fake serves the demo SI without Groups, and the overview is identical from its second line; its first line names the catalogue. `graph`, `show` and `relations` are identical whole |
| 11 | § 4: `gitEnvironment()` copies every variable not starting with `GIT_` (`snapshot.ts:393-405`) | `gitEnvironment` is `src/context/project-fs/snapshot.ts:394-406`, `execFile` at `:429-445`. It copies the provider's key into `git`'s environment today. `readProject` always runs `git rev-parse --show-toplevel` (`tracking`, `:485-492`), also on a directory outside git, which it then walks; so `tests/contract/key-reach.test.ts`'s change road (`:251-264`, a directory outside git) already runs `execFile` | 1.3 builds every spawned environment with `spawnedEnvironment`, and its test fails today on the key. 1.5's key-reach leg keeps the application directory outside git: the `rev-parse` call is the `execFile` it asserts on, which is not vacuous, and the Inspector still walks and reads `package.json` |
| 12 | § 9: "the `NETWORK` pattern does not catch the global `fetch` (`dependencies.test.ts:73`)"; the agents' closure rule at `:102-109` | `NETWORK` is `tests/architecture/dependencies.test.ts:150`; the agents' closure rule is `:179-186`; the `trace/` rule (`:335-389`) already reads source text, comments stripped, for the word `fetch`. `AGENTS.md:470` counts **sixteen** rules | 1.3 adds three rules on the `trace/` rule's pattern, and the count goes to nineteen |
| 13 | § 13, 1.6: `.env.example` with the documents | `tests/unit/env-example.test.ts` fails when `src/` reads a variable `.env.example` does not list, and a computed `env[NAME]` must be declared in its `COMPUTED` map | Both variables are listed, and `COMPUTED` extended, in 1.5, the pull request that reads them |
| 14 | § 8: SECURITY.md's table at `:31-38`, its threat model at `:45-55`; § 13 puts the rows in 1.6 | The table is `SECURITY.md:31-34`, the threat model `:46-56`. SECURITY.md claims only what a test enforces and states every flow that leaves the machine | The rows move to 1.5, where the flow starts and the key-reach leg that enforces it lands. 1.6 keeps the README, design §7.0 and the ADR |
| 15 | § 13, 1.6: "The ADR takes the next free number; stage 8 has reserved 0010" | `docs/adr/` ends at 0009. **0010 is claimed twice**: by the stage 8 note (`docs/stage-8-brief.md:745`, its evidence ADR) and by the roadmap's stage-5 check (`docs/roadmap.md:55`, "its ADR becomes 0010") | The Backstage ADR is **0011**. The owner settled 0010 on 2026-09-27: it goes to the stage-5 check, and stage 8's evidence ADR takes the next free number when it is written. 1.6 records this in the roadmap and corrects `stage-8-brief.md`'s reservation |
| 16 | § 9: `tools/fake-backstage.ts` "with node:http" | `tools/` holds only `mlflow/`; the scripts are `.mjs`; there is no TypeScript runner in `devDependencies` | `tools/fake-backstage.ts` runs under Node's type stripping (`node tools/fake-backstage.ts`, on by default from Node 22.18), imports only `node:` modules and `yaml`, and is typechecked through the test that imports it (1.4) |
| 17 | § 9: the contract fixture, "one recorded `by-query` page", recorded "once from a local Backstage" | Recording it needs a running Backstage, which the owner placed out of this tool's scope for a company and in the next queue item for the demo | Deferred to queue item 2, the Backstage in Docker, where it is one command. 1.6 says so in the roadmap and in the note's **Built** paragraph |
| 18 | § 9: "one new tape, `question-backstage-owner`" | A new tape is a file added to `tests/recordings/`, and recording needs a key | Not in slice 1 (no recording changes). A question answered from the catalogue is tested on a scripted client (`MainDeps.client`); the tape waits for a keyed recording, listed in the roadmap |
| 19 | § 10: "idpa: the Backstage catalogue at … refused the token (401): …" | No refusal this CLI prints carries a prefix (`failed`, `cli/index.ts:1645-1685`) | The line is the note's without `idpa: ` |
| 20 | `SECURITY.md`, `docs/adopting-backstage.md` describe the provider as not built | `docs/adopting-backstage.md:155` says "**designed and not built yet**" | 1.5 corrects that sentence when it becomes false |
| 21 | Other line references | `personal.ts:18-22`, `source.ts:26-29`, `:171-214`, `:328-361`, `:387-397`, `key-reach.test.ts:12-26`, `:30`, `:228-234`, `config.ts:66`, `fixtures/index.ts:24`, `graph.ts:14`, `trace-sink.ts:51-78` hold as cited. `unreadApi` is `serialize.ts:352-374` (note `:339-355`); `apiSchema` is `entity.ts:500-516` (note `:382-392`); the Resource types are `resource-types.ts:53-65` (note `:47-62`) and the lifecycles `COMPONENT_LIFECYCLES`, `entity.ts:271`; `EntityGraph.from([])` in `init` is `init.ts:770` (note `:677-693`); `readRepository` in `plan` is `plan.ts:1270` (note `:1262-1291`); the review's domain-backstage-8 is at `docs/reviews/2026-09-23-deep-review.md:277` and `:370` | Cited as they are now |
| 22 | § 6: "the next page by `pageInfo.nextCursor`. The cursor carries the filter and the order"; page size "250, always sent" | Read on `backstage/backstage` master: `parseQueryEntitiesParams.ts` returns early on a cursor with `{ cursor, fields }` only, so `filter` beside a cursor is **ignored**, not refused, and `fields` is read from each request; `createRouter.ts`'s `/entities/by-query` passes `limit: req.query.limit` beside the parsed parameters, so `limit` is read from each request too; `DefaultEntitiesCatalog.ts` has `DEFAULT_LIMIT = 200` and **no maximum**, carries `totalItems` from the first page in the cursor, and breaks ties on `entity_id`; `packages/catalog-client/src/CatalogClient.ts` `queryEntities` re-sends `cursor`, `limit` and `fields` on every next page | 1.4: every next page sends `cursor`, `limit=250` and, for the refs read, the same `fields`; never `filter`. The fake's cursor holds the filter, the order and `totalItems` only, it takes `limit` and `fields` from each request, ignores `filter` beside a cursor, defaults to 200 and caps nothing |
| 23 | § 5: the kinds this tool does not model "share one line, counted by kind (`notLoaded`)" | `notLoaded` (`cli/index.ts:1481-1497`) counts **every** `Ignored` by its `kind`, and the overview's `setAside.kinds` (`context/graph/overview.ts:185-190`) tallies every kinded one; the empty-repository line (`:1256`) blames "the declarations repository" | A pre-pass set-aside carries a kind, so 1.5 has `notLoaded` and the overview's tally take only `Ignored` rows without `prePass`, the pre-pass rows appearing on `setAsideLine` alone, and words the empty-source line per kind of source |
| 24 | § 3: a change is decided against the declarations repository, whatever the question reads | The entry road resolves the change's repositories **before any model**, whichever road the Supervisor then takes (`cli/index.ts:1291-1307`), and a refusal there ends the run | From 1.5 a Backstage beats `IDP_REPO` and the file's `repo`, so the read no longer checks them; `declarationsFor` does, and refuses a broken one (exit 2) on a question too. 1.2 moves the resolution before the load, so from 1.5 that refusal comes before any request to the catalogue (see Choices) |

Nothing on the list reopens a decision of § 14. One choice below amends the note's § 6
table (the partial-read rule), and says so; 1.6's **Built** paragraph records it.

## Choices this plan makes where the note leaves one

- **`readValue`'s readings are a closed union** (`witness`, `rejected`, `ignored`, `api`,
  `entity`), and `parseDocuments` folds them with an exhaustive `switch`.
- **The two resolutions** are `sourceOf` (what a run reads) and `declarationsFor` (what a
  change is decided against: `plan`'s chain, and nothing when `--demo` was typed), both in
  `cli/source.ts`, over one private chain so their refusals name the command typed.
- **A set-aside of the pre-pass is an `Ignored`**, marked `prePass: { rule, value }`, so the
  graph's `aside` set takes it as it takes a Group. It is counted once, under its own term:
  `notLoaded` and the overview's kind tally take only the rows without `prePass` ("not
  modelled"), and the pre-pass rows appear on `setAsideLine` alone ("set aside by the
  catalogue read") and as one count in the overview (1.5).
- **The census** (`served`, `pages`, `bytes`, `ms`, `repeated`) is an optional field of
  `LoadResult`, set by `BackstageProvider` only. It holds no token and no URL.
- **Failures are one closed union**, `CatalogueFailure`, carried by `CatalogueReadError`
  (exit 1). The transport's own message is safe on its own (status, class, origin); 1.5
  renders the line the note specifies, naming the host and what named it, from the union.
- **429.** A `Retry-After` of at most 10 seconds is waited for and the request retried, three
  times per run at most; a 429 with no `Retry-After`, an unreadable one or one over 10
  seconds is refused at once, naming the rate limit.
- **The URL.** Any `\` is refused, and the path as typed must equal the path `new URL`
  parses: the WHATWG parser reads `%2e` as a dot and `\` as `/` in an `https:` URL, so
  `/api/%2e%2e/catalog` parses to `/catalog` and a check of `.` and `..` in the text alone
  would miss it. Each segment is also matched against `/^(\.|%2e){1,2}$/i` and against the
  empty string, for a refusal that names the segment. A trailing slash is an empty segment
  and is refused, the message showing the form expected, as the note says ("kept as given").
  The transport checks its `base` again when it is built (1.3), since it exists two pull
  requests before `catalogueBase`.
- **A refused URL is quoted without what could be a credential.** Userinfo, a query and a
  fragment are where people put a token, and a swapped pair puts the token in
  `IDP_BACKSTAGE_URL`. So a refusal quotes the URL with userinfo, query and fragment each
  replaced by `***` (`https://***@backstage.acme.example/api/catalog`), and a value that does
  not parse is described by its length alone ("a value of 41 characters that does not parse
  as a URL"), never quoted. The tests assert the secret is absent from stderr.
- **A `--backstage` source's origin is where its URL came from**: `IDP_BACKSTAGE_URL` or the
  file, never `{ by: 'flag' }`. `--backstage` chooses the catalogue; the notice's parenthesis
  and the blame name the setting that holds the URL, which is what a person fixes.
- **The notice** is § 10's line, printed after the load: `N entities: M read, K not modelled`,
  where N is the distinct uids served across both reads, M the entities in the graph and K the
  `Ignored` rows without `prePass`; when non-zero, `, S set aside, R skipped` follows, so the
  four terms add up to N. When a uid was served twice (`census.repeated > 0`) and the read was
  still whole, `; the catalogue changed while it was read (U served twice)` follows the counts.
  What the catalogue cannot report (it does not serve what it refused) is said in the README
  and the adopting page (1.6), not on every run.
- **The partial-read rule is stricter than the note's § 6 table.** The table refuses "fewer
  read than announced, with no uid repeated". A server that serves one entity twice and
  leaves another out would pass that rule, and the graph would be answered from part of the
  catalogue. Backstage pages by keyset on `entity_id` (`DefaultEntitiesCatalog.ts`), which
  does not change when an entity is updated, so a legitimate read never repeats a uid. This
  plan refuses whenever a read's distinct uids are fewer than its first page's `totalItems`,
  repeats or not, and refuses an item with no string `metadata.uid`; a repeat is only stated
  (in the notice) when the distinct uids reach `totalItems`. It amends the note's table, and
  1.6's **Built** paragraph says so.
- **The modelled read is always sent**, whatever the facets say: a facets answer that omits
  Component, Resource or API would otherwise give an empty graph that is answered from. The
  facets decide only the refs read of the other kinds; a kind they omit leaves a reference to
  it unresolved, which the Backstage wording ("declared nowhere in the catalogue this token
  reads") already describes.
- **A broken repository setting is refused on a question too, before any request.** From 1.5
  a Backstage beats `IDP_REPO` and the file's `repo` for the read, but the entry road still
  resolves the change's repository before any model (row 24). This plan keeps that early
  refusal, exit 2, and runs it before the load: a misconfiguration is exit 2 before any
  request, as for the catalogue's own settings, and deferring it to the Supervisor's answer
  would spend a model call to report a setting. `backstage-read.test.ts` pins it.
- **The Backstage wording of a reference declared nowhere, and the hostile bytes through a
  catalogue, land in 1.5**, the pull request in which a real run first prints catalogue text,
  not in 1.6 as the note's § 13 lists them.
- **The vocabulary cap applies to the Supervisor's and the Analyst's summary only** (row 5).
- **`pnpm smoke` runs the Backstage demo only where Node strips types.** `engines` stays
  `>=22`; on a Node without `process.features.typescript` the smoke prints one line saying the
  Backstage demo needs Node 22.18 or later and goes on. CI's matrix (`node: [22, 24]`, the
  latest of each) runs it.
- **The trace attributes** `idp.source.*` are added only when the source is a Backstage, so
  every existing trace assertion stands.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/core/yaml/serialize.ts` *(edit)* | 1.1 | `readValue`: one value's reading; `parseDocuments` folds it |
| `src/cli/source.ts` *(edit)* | 1.2, 1.5 | `declarationsFor`; then the Backstage source, the URL and token rules |
| `src/cli/commands/entry.ts` *(edit)* | 1.2 | its header: a change is decided against `plan`'s chain |
| `src/context/backstage/transport.ts` | 1.3 | the only code that sets `Authorization`; routes, origin, redirects, bounds, 429 |
| `src/context/backstage/limits.ts` | 1.3 | every bound of the note's § 6, each stated where it is reached |
| `src/context/spawned-environment.ts` | 1.3 | the one builder of a child process's environment |
| `src/context/project-fs/snapshot.ts` *(edit)* | 1.3 | `gitEnvironment` goes through it |
| `src/context/backstage/load.ts` | 1.4 | facets, the kind-split reads, cursor, uid and `totalItems` checks |
| `src/context/backstage/translate.ts` | 1.4 | the pre-pass and the order by (`managed-by-location`, ref) |
| `src/context/backstage/provider.ts` | 1.4 | `BackstageProvider implements ContextProvider` |
| `src/context/provider.ts` *(edit)* | 1.4 | `Ignored.prePass`, `LoadResult.census` |
| `src/cli/render/catalogue-read.ts` | 1.4 | the grouped, bounded stderr lines |
| `tools/fake-backstage.ts` | 1.4 | the catalogue a fake serves, its request handler, and a `node:http` server when run |
| `tests/support/fake-backstage.ts` | 1.4 | that handler as an injected `fetch`, the requests kept, and the faults |
| `src/cli/personal.ts` *(edit)* | 1.5 | `backstage:` in `config.yml` |
| `src/cli/index.ts` *(edit)* | 1.5 | `--backstage`, `MainDeps.catalogueFetch`, the provider, the notice after the load, the failure line, the trace attributes |
| `src/cli/render/overview.ts`, `src/context/graph/overview.ts` *(edit)* | 1.5 | an overview headed by the catalogue; the pre-pass counted apart from the kinds not modelled |
| `src/cli/render/entity.ts`, `src/cli/render/relations.ts`, `src/cli/commands/show.ts`, `src/cli/commands/relations.ts` *(edit)* | 1.5 | the phrase for a reference declared nowhere, chosen by the source |
| `tests/setup/shell.ts` *(edit)* | 1.5 | the two Backstage variables removed even while recording |
| `src/context/graph/summary.ts`, `src/agents/summary.ts` *(edit)* | 1.6 | counts, and the cap at 30 |
| `scripts/demo-backstage.mjs`, `scripts/smoke.mjs` *(edit)* | 1.6 | `pnpm demo:backstage`, and the smoke that runs it where Node strips types |
| `docs/adr/0011-backstage-to-explore.md` | 1.6 | "Backstage to explore: one snapshot per run; the model's words never become a request" |

---

### Task 1.1: `readValue` in core

**Goal.** Extract the per-value loop of `parseDocuments` as `readValue(value: unknown)`, with
no change in behaviour, pinned by the YAML road's output recorded before the extraction.
The Backstage provider will call `readValue` on each item, so a file and a catalogue meet
one reader and one set of refusal words (`reasonOf`, `core/schemas/reject.ts:33`).

**Files:**
- Modify: `src/core/yaml/serialize.ts` (`readValue`, `ValueReading`; `parseDocuments` folds them)
- Modify: `src/core/README.md` (the reader is `readDocuments` then `readValue`), `src/context/README.md:28`
- Create: `tests/unit/read-value.test.ts`
- Modify: `CHANGELOG.md`, `AGENTS.md` (test count), `README.md` (badge)
- Add: `docs/plans/backstage-http-slice-1.md` (this plan)

**Interfaces:**

```typescript
export type ValueReading =
  | { readonly as: 'witness' }
  | { readonly as: 'rejected'; readonly reason: string }
  | { readonly as: 'ignored'; readonly document: IgnoredDocument }
  | { readonly as: 'api'; readonly api: Api; readonly unread: readonly string[] }
  | { readonly as: 'entity'; readonly entity: Entity; readonly unread: readonly string[] }

/** One document's value, read as a file's is: the decisions of the loop, in its order. */
export function readValue(value: unknown): ValueReading
```

- [x] **Step 1: Pin the YAML road as it is (passes now, by construction)**

In `tests/unit/read-value.test.ts`, the `LoadResult` of `FixtureProvider` and of
`IacFsProvider` over `fixtures/si-demo` and over every folder of `tests/golden/` that holds
YAML (`backstage-apis`, `backstage-namespaces`, `broken-si`, `dangling-shown`, `multi-doc`,
`relations-owner`), and `parseDocuments` over every YAML file under them, each serialised
with sorted keys and hashed. The digests are recorded on `60974de`, before the extraction,
and written in the test as constants with that commit named.

```typescript
/** Recorded on 60974de, before `readValue` existed. A later change of the YAML road updates one in the commit that explains why. */
const BEFORE: Record<string, string> = {
  'fixtures/si-demo': '<sha256>',
  'tests/golden/backstage-apis': '<sha256>',
  // … one per folder, and one for the per-file parseDocuments readings
}

it.each(Object.entries(BEFORE))('reads %s exactly as it did before readValue', async (folder, digest) => {
  const root = path.join(ROOT, folder)
  const read = {
    fixtures: await new FixtureProvider(root).load(),
    iacFs: await new IacFsProvider(root).load(),
  }
  expect(digestOf(read)).toBe(digest)
})
```

Run it on the unchanged tree: `pnpm vitest run tests/unit/read-value.test.ts`. Expected:
green. It is the "before".

- [x] **Step 2: Write the tests of `readValue` (fail: no such export)**

```typescript
describe('readValue, one value as a file reads it', () => {
  it('reads null as a witness, not a rejection', () => {
    expect(readValue(null)).toEqual({ as: 'witness' })
  })
  it('refuses a kind Backstage does not define under its own apiVersion, naming the kinds it does', () => {
    const read = readValue({ apiVersion: 'backstage.io/v1alpha1', kind: 'Resouce', metadata: { name: 'x' } })
    expect(read).toEqual({ as: 'rejected', reason: expect.stringContaining('API, Component, Domain') })
  })
  it('sets a Group aside with its reference, so a dependsOn naming it is not dangling', () => {
    expect(readValue(GROUP)).toMatchObject({ as: 'ignored', document: { kind: 'Group', ref: 'group:default/tiger' } })
  })
  it('sets an API of another namespace aside, and reads one of default', …)
  it('reads an API, and counts what it holds that the read model does not read', () => {
    // No fixture or golden holds such an API: without this, nothing sees the api branch's unread.
    expect(readValue({ ...(API('default') as object), relations: [] })).toMatchObject({ as: 'api', unread: ['relations'] })
  })
  it('reads a Component, and counts what it holds that the read model does not read', () => {
    expect(readValue({ ...BILLING_API, relations: [] })).toMatchObject({ as: 'entity', unread: ['relations'] })
  })
  it('refuses a Component missing its owner in reasonOf's words', …)
  it('is what parseDocuments folds: the same readings for every document of every file', () => {
    // Every YAML file of Step 1: parseDocuments(text) equals the fold of readValue over readDocuments(text).
  })
})
```

Run: `pnpm vitest run tests/unit/read-value.test.ts`. Expected: FAIL, `readValue` is not
exported by `serialize.js`.

- [x] **Step 3: Extract**

Move the body of the `for` loop of `parseDocuments` (`serialize.ts:435-467`) into
`readValue`, in the same order: null or undefined is a witness; `misdeclaredKind`;
`ignoredOf`; a kind in `READ_KINDS` goes to `apiSchema`; the rest to `entitySchema`; the two
that read return `unreadFieldsOf(value)`. `parseDocuments` keeps its signature and becomes:

```typescript
for (const reading of readDocuments(text)) {
  if ('error' in reading) { rejections.push(reading.error); continue }
  const read = readValue(reading.value)
  switch (read.as) {
    case 'witness': break
    case 'rejected': rejections.push(read.reason); break
    case 'ignored': ignored.push(read.document); break
    case 'api': apis.push(read.api); unread.push(...read.unread); break
    case 'entity': entities.push(read.entity); unread.push(...read.unread); break
    default: { const exhaustive: never = read; return exhaustive }
  }
}
```

Its doc comment says the one reader is now two halves, `readDocuments` for YAML and
`readValue` for a value, and that the Backstage provider will call the second.

**Exhaustive switches:** the fold above (new). **Architecture rules:** none change; `core/`
still imports no disk and no network.

- [x] **Step 4: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/read-value.test.ts tests/unit/serialize.test.ts tests/unit/validate-rules.test.ts
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
```

Expected: all green; Step 1's digests unchanged; `tests/golden/` and `tests/recordings/`
unchanged (`git status --short tests/golden tests/recordings` prints nothing).

- [ ] **Step 5: The pull request** (after the owner's go-ahead)

```bash
git add src/core/yaml/serialize.ts src/core/README.md src/context/README.md tests/unit/read-value.test.ts \
  docs/plans/backstage-http-slice-1.md CHANGELOG.md AGENTS.md README.md
git commit -m "refactor(core): read one value as a file reads it, for the catalogue to share"
```

Base `main`. CHANGELOG, `### Changed`:

> - The reader of entity documents is two halves: `readDocuments` turns YAML into values and
>   `readValue` reads one value, so the `backstage-http` provider will read a catalogue's
>   entities with the very decisions a file gets; the YAML road's output is pinned before and
>   after ([#92](https://github.com/pcaboor/idp-agent/pull/92)).

**What the owner can run** (after `pnpm build`, from the clone):

```bash
node dist/cli/bin.js validate fixtures/si-demo
# 33 entities in 33 files, 0 violations                              (exit 0)
node dist/cli/bin.js relations mysql-prod-01 --impacts --demo
# the README's first-screen block, byte for byte                     (exit 0)
pnpm vitest run tests/unit/read-value.test.ts
# every test passes; the digests are those of 60974de
```

---

### Task 1.2: Two resolutions

**Goal.** A run's read source and the repository a change is decided against become two
resolutions: `sourceOf` for what a question reads, `declarationsFor` for what a change is
decided against. They coincide whenever no Backstage is configured, which is every run
today, so this lands with no change in behaviour, before any HTTP code (the note's § 3).

**Files:**
- Modify: `src/cli/source.ts` (`declarationsFor`; `declarationsOf` removed; one private chain)
- Modify: `src/cli/index.ts:1291` (the entry road's change repository)
- Modify: `src/cli/commands/entry.ts` (its header, `:22-27`)
- Modify: `src/cli/README.md`, `AGENTS.md` ("Current state": one function decides it → two)
- Create: `tests/unit/two-resolutions.test.ts`
- Modify: `tests/unit/entry.test.ts` (a row per argument of the entry road's call: `--demo`
  with `IDP_REPO` set is refused, `--repo` beats `IDP_REPO` for the change; review of 1.2)
- Modify: `docs/roadmap.md` (a known debt the review found, older than 1.2: an absolute
  `--repo` from a removed working directory)
- Modify: `CHANGELOG.md`, `README.md` (the test-count badge)

**Interfaces:**

```typescript
/**
 * The declarations repository a phrase's change is decided against: `plan`'s chain —
 * --repo, the working directory on its markers, IDP_REPO, the file's repo — and nothing
 * when --demo was typed. Never derived from what the run reads.
 */
export async function declarationsFor(
  request: { command: ReadCommand; repo?: string | undefined; demo?: boolean | undefined },
  context: SourceContext,
): Promise<RepositorySource | undefined>
```

- [x] **Step 1: Write the test (fails: no such export)**

```typescript
describe('what a change is decided against, resolved apart from what the run reads', () => {
  // One row per road of the chain, each in a world of its own (configured-source.test.ts's `world`).
  it.each([
    ['--repo', { repo: IAC }, { kind: 'repo', root: IAC, origin: { by: 'flag' } }],
    ['the working directory', { cwd: IAC }, { kind: 'repo', root: IAC, origin: { by: 'working-directory' } }],
    ['IDP_REPO', { env: { IDP_REPO: IAC } }, { kind: 'repo', origin: { by: 'variable', name: 'IDP_REPO' } }],
    ['the file', { file: `repo: ${IAC}` }, { kind: 'repo', origin: { by: 'file' } }],
    ['--demo', { demo: true, env: { IDP_REPO: IAC } }, undefined],
    ['nothing', {}, undefined],
  ])('%s', async (_, road, expected) => {
    expect(await declarationsFor(requestOf(road), contextOf(road))).toEqual(
      expected === undefined ? undefined : expect.objectContaining(expected),
    )
  })

  it('refuses what the read refuses, naming the command that was typed', async () => {
    await expect(declarationsFor({ command: 'idpa' }, contextOf({ env: { IDP_REPO: 'relative' } })))
      .rejects.toThrow(/IDP_REPO=relative is relative/)
  })
})
```

Run: `pnpm vitest run tests/unit/two-resolutions.test.ts`. Expected: FAIL, no export
`declarationsFor`.

The proof that nothing else changes is today's suite: `entry.test.ts`,
`configured-source.test.ts`, `plan-project.test.ts`, `declarations-repository.test.ts` and
the scenario tapes (`tests/scenarios/`), unchanged.

- [x] **Step 2: Implement**

In `source.ts`, the body of `sourceOf` after the flags becomes a private
`repositoryChain(command, repo, context)`: `--repo` (`declarationsRoot(command, …)`), the
working directory on its markers, `configuredRepository(command, …)`. `sourceOf` calls it
with the command it was given; `declarationsFor` returns `undefined` for `--demo`, else
calls it with the read command's name, so a refusal names `idpa` as the read's did.
`declarationsOf` loses its only caller and is removed.

In `cli/index.ts`, the entry branch's `const declarations = declarationsOf(source)` (`:1291`)
is removed, and the resolution moves up, right after `providerOf` (`:1223`) and before
`provider.load()`, for the entry command only:

```typescript
let declarations: RepositorySource | undefined
if (command.name === 'entry') {
  try {
    declarations = await declarationsFor(
      { command: 'idpa', repo: command.repo, demo: command.demo },
      sourceContextOf(deps),
    )
  } catch (error) {
    return failed(error, err)
  }
}
```

In this pull request the resolution follows the read's over the same chain, which already
refused anything it would refuse, so the order of refusals and their words are unchanged.
**That stops being true in 1.5**, where a Backstage beats `IDP_REPO` and the file's `repo`
for the read: `declarationsFor` then reaches settings the read did not, and refuses a broken
one on a question too (Choices, row 24). Placing it before the load is what makes that
refusal come before any request to the catalogue. `entry.ts`'s header says the phrase is
classified against what the run reads, and a change decided against `plan`'s chain, and that
the two are one repository unless a Backstage is read (slice 1.5).

**Exhaustive switches:** `declarationsOf` (removed). **Architecture rules:** none.

- [x] **Step 3: Checks**

```bash
pnpm vitest run tests/unit/two-resolutions.test.ts tests/unit/entry.test.ts tests/unit/configured-source.test.ts
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
```

Expected: green; `tests/recordings/` unchanged; every scenario replays with no digest
warning.

- [ ] **Step 4: The pull request** (after the owner's go-ahead)

```bash
git add src/cli/source.ts src/cli/index.ts src/cli/commands/entry.ts src/cli/README.md \
  tests/unit/two-resolutions.test.ts tests/unit/entry.test.ts CHANGELOG.md AGENTS.md \
  README.md docs/roadmap.md docs/plans/backstage-http-slice-1.md
git commit -m "refactor(cli): resolve what a run reads and what a change is decided against apart"
```

Base `feat/bhttp-1-1`. CHANGELOG, `### Changed`:

> - What a run reads and what a change is decided against are resolved apart: a phrase's
>   change takes `plan`'s chain — `--repo`, the working directory, `IDP_REPO`, the personal
>   file — whatever the question side reads, so a Backstage can be read for questions while
>   changes stay decided in Git; no behaviour changes today
>   ([#92](https://github.com/pcaboor/idp-agent/pull/92)).

**What the owner can run** (after `pnpm build`; `$HOME` untouched, a scratch config):

```bash
export XDG_CONFIG_HOME="$(mktemp -d)"; mkdir -p "$XDG_CONFIG_HOME/idp-agent"
printf 'repo: %s\n' "$PWD/fixtures/si-demo" > "$XDG_CONFIG_HOME/idp-agent/config.yml"
cd /tmp && node ~/Documents/idp-agent-worktrees/bhttp/dist/cli/bin.js graph --kind Component
# stderr: reading the declarations repository si-demo (<that config.yml, shown whole>); --repo <directory> reads another, --demo the fictional SI
# stdout: the five Components, as `graph --kind Component --demo` prints them      (exit 0)
node ~/Documents/idp-agent-worktrees/bhttp/dist/cli/bin.js plan --from ~/Documents/idp-agent-worktrees/bhttp/examples/open-network.json
# stderr: reading the declarations repository si-demo (…config.yml); --repo <directory> decides against another
# stdout: the diff of pnpm demo's step 3                                          (exit 0)
```

---

### Task 1.3: `context/backstage/transport.ts`, with its proofs

**Goal.** The one function that sends the token: a closed list of (method, route) pairs,
the origin and pathname checked before the header is attached, `redirect: 'error'`, the 3xx
and foreign-`url` refusals, the streaming byte count, the timeouts, 429; every spawned
environment stripped of the token and the provider keys; and the architecture rules that
hold `fetch` to it. Tested against an injected `fetch` alone. Nothing in `cli/` calls it
yet, so no real run can send a token in this pull request.

**Files:**
- Create: `src/context/backstage/transport.ts`, `src/context/backstage/limits.ts`
- Create: `src/context/spawned-environment.ts`
- Modify: `src/context/project-fs/snapshot.ts` (`gitEnvironment` builds on `spawnedEnvironment`)
- Modify: `tests/architecture/dependencies.test.ts` (three rules)
- Create: `tests/unit/backstage-transport.test.ts`, `tests/unit/spawned-environment.test.ts`
- Modify: `src/context/README.md` (what lives in `backstage/`, which rule holds it), `AGENTS.md` (19 rules, the layering table), `SECURITY.md` ("What the architecture rules are": the `fetch` rule is textual), `CHANGELOG.md`

**Interfaces:**

```typescript
// limits.ts — the note's § 6, each stated in the line that reports reaching it
export const BACKSTAGE_LIMITS = {
  pageSize: 250, modelledEntities: 20_000, otherRefs: 200_000,
  bytesPerResponse: 32 * 1024 * 1024, bytesPerRun: 256 * 1024 * 1024,
  requestMs: 15_000, loadMs: 120_000,
  retryAfterMs: 10_000, retriesPerRun: 3, jsonDepth: 64,
} as const

// transport.ts
export const CATALOGUE_REQUESTS = [['GET', 'entities/by-query'], ['GET', 'entity-facets']] as const
export type CatalogueRoute = (typeof CATALOGUE_REQUESTS)[number][1]
export const BACKSTAGE_TOKEN_VARIABLE = 'IDP_BACKSTAGE_TOKEN'
export function isLoopback(url: URL): boolean // 127.0.0.1, [::1], localhost
export type CatalogueFailure =
  | { kind: 'unreachable'; cause: string }          // DNS, refused, TLS: the error code only
  | { kind: 'timeout'; scope: 'request' | 'load' }
  | { kind: 'status'; status: number }              // 401, 403, 404, 5xx, other 4xx
  | { kind: 'redirect'; status: number | undefined }
  | { kind: 'foreign-response' }
  | { kind: 'rate-limited' }
  | { kind: 'too-large'; scope: 'response' | 'run'; limit: number }
  | { kind: 'not-json' }
export class CatalogueReadError extends Error {
  constructor(readonly failure: CatalogueFailure, readonly origin: string) // message: status, class, origin; never the body
}
export interface CatalogueTransport {
  request(method: 'GET', route: CatalogueRoute, query: URLSearchParams): Promise<unknown>
  readonly spent: { readonly requests: number; readonly bytes: number; readonly ms: number }
}
/**
 * The function the transport sends with. A type of its own, not `typeof globalThis.fetch`:
 * no file in context/ names the global (the first rule of Step 3), not even in a type.
 * The global `fetch` is assignable to it, and cli/ hands it over (1.5).
 */
export type CatalogueFetch = (url: URL, init: RequestInit) => Promise<Response>
/** Throws a TypeError, before any request, for a base that is not https: or loopback http:, holds userinfo, a query or a fragment, or whose pathname is not one or more non-empty segments. */
export function catalogueTransport(options: {
  base: URL                          // checked by cli/ (1.5); checked again here, at construction
  token: string | undefined          // a value, never read from the environment here
  catalogueFetch: CatalogueFetch     // injected by cli/, never defaulted here
  limits?: Partial<typeof BACKSTAGE_LIMITS>
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal               // the load's own timeout, 1.4
}): CatalogueTransport

// spawned-environment.ts
/** A child process's environment: the process's, without the Backstage token and without any `*_API_KEY`. */
export function spawnedEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
```

- [ ] **Step 1: Write the transport's tests (fail: no module)**

`tests/unit/backstage-transport.test.ts`, each against a hand-written `fetch` that keeps
every call (`url`, `init`) and answers what the case needs (the fake of 1.4 does not exist
yet). The offline setup leaves the global `fetch` a thrower, and each test also spies on it:
a fallback to it fails loudly.

```typescript
const BASE = new URL('https://backstage.canary.example/api/catalog')
const TOKEN = 'canary-backstage-token-0123456789'

it('sends GET to the base and route, the token in one header, and redirect: error', async () => {
  const { fetch, sent } = keeping(() => json({ items: [], totalItems: 0, pageInfo: {} }))
  await catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch }).request('GET', 'entities/by-query', new URLSearchParams({ limit: '250' }))
  expect(sent).toHaveLength(1)
  expect(new URL(sent[0]!.url).origin).toBe(BASE.origin)
  expect(new URL(sent[0]!.url).pathname).toBe('/api/catalog/entities/by-query')
  expect(sent[0]!.init.method).toBe('GET')
  expect(sent[0]!.init.redirect).toBe('error')
  expect(headerEntries(sent[0]!.init).filter(([, value]) => value.includes(TOKEN)))
    .toEqual([['authorization', `Bearer ${TOKEN}`]])
  expect(globalFetch).not.toHaveBeenCalled()
})

it('sends no Authorization header without a token, and refuses to be built without one for a non-loopback host', …)
it.each([
  ['a pathname that starts with two slashes', 'https://backstage.canary.example//evil.example/api/catalog'], // rebuilt, it would reach https://evil.example
  ['the root pathname', 'https://backstage.canary.example/'],                                            // rebuilt, https://entities/by-query
  ['http: to a host that is not loopback', 'http://backstage.canary.example/api/catalog'],
  ['userinfo', 'https://me:pw@backstage.canary.example/api/catalog'],
])('refuses to be built on a base with %s, and sends nothing', (_, base) => {
  const { fetch, sent } = keeping(() => json({}))
  expect(() => catalogueTransport({ base: new URL(base), token: TOKEN, catalogueFetch: fetch })).toThrow(TypeError)
  expect(sent).toEqual([])
})
it('throws before any request for a method or a route outside the list', async () => {
  const t = catalogueTransport({ base: BASE, token: TOKEN, catalogueFetch: fetch })
  await expect(t.request('POST' as 'GET', 'entities/by-query', new URLSearchParams())).rejects.toThrow(TypeError)
  await expect(t.request('GET', 'locations' as CatalogueRoute, new URLSearchParams())).rejects.toThrow(TypeError)
  expect(sent).toEqual([])
})
it('keeps the path whatever a query value holds: only URLSearchParams builds the query', …) // filter=kind=../../x?y#z
it.each([301, 302, 303, 307, 308])('refuses a %s without reading its body, naming the origin', …)
it('classifies the redirect Node's fetch itself refuses, and does not retry', async () => {
  // With redirect: 'error', undici never hands back a 3xx: it rejects with
  // TypeError('fetch failed', { cause: Error('unexpected redirect') }), a cause with no code
  // (undici lib/web/fetch/index.js, makeNetworkError('unexpected redirect'); response.js wraps the string in an Error).
  const { fetch, sent } = keeping(() => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }) })
  const error = await failure(fetch)
  expect(error.failure).toEqual({ kind: 'redirect', status: undefined })
  expect(error.message).toContain('https://backstage.canary.example')
  expect(sent).toHaveLength(1)
})
it('refuses a response whose url is on another origin, and one marked redirected', …) // Object.defineProperty(response, 'url', …)
it.each([[401], [403], [404], [500], [503]])('classifies a %s, and quotes nothing of the body', async (status) => {
  const { fetch } = keeping(() => new Response(`echo: Bearer ${TOKEN}`, { status }))
  const error = await failure(fetch)
  expect(error.failure).toEqual({ kind: 'status', status })
  expect(error.message).not.toContain(TOKEN)
  expect(error.message).not.toContain('echo')
})
it('waits a Retry-After of up to 10 s and retries, three times per run at most', …) // injected sleep records the waits
it('refuses a 429 with no Retry-After, or one over 10 s, naming the rate limit', …)
it('refuses a body over the bound while it streams, and stops reading it', …) // a ReadableStream counting pulls; limits.bytesPerResponse: 1024
it('refuses a run past its byte bound across requests', …)
it('refuses a body that is not JSON, or not UTF-8', …)
it('refuses a request that outlives its bound, naming the origin', …) // limits.requestMs: 20; a fetch that rejects on init.signal abort
it('classifies an unreachable host by its code alone', …) // TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
```

Run: `pnpm vitest run tests/unit/backstage-transport.test.ts`. Expected: FAIL, the module
does not exist.

- [ ] **Step 2: Write the spawned-environment tests (the second fails today)**

`tests/unit/spawned-environment.test.ts`:

```typescript
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn((...args: unknown[]) => { calls.push(args); return (real.execFile as Function)(...args) }) }
})

it('drops the Backstage token and every provider key, and keeps the rest', () => {
  const env = spawnedEnvironment({ PATH: '/bin', HOME: '/h', IDP_BACKSTAGE_TOKEN: 't', ...keys('k') })
  expect(env).toEqual({ PATH: '/bin', HOME: '/h' })
  for (const provider of PROVIDER_NAMES) expect(env).not.toHaveProperty(KEY_VARIABLES[provider])
})

it('is what git runs in when the Inspector reads a directory', async () => {
  vi.stubEnv('IDP_BACKSTAGE_TOKEN', CANARY)
  vi.stubEnv('OPENAI_API_KEY', KEY)
  // A temporary directory outside git is enough: `tracking` (snapshot.ts:485-492) runs
  // `git rev-parse --show-toplevel` on every directory before it decides to walk it.
  await readProject(await temporaryDirectory({ 'package.json': '{}' }))
  expect(calls.length).toBeGreaterThan(0)
  for (const [, , options] of calls) {
    expect(JSON.stringify((options as { env: unknown }).env)).not.toContain(CANARY)
    expect(JSON.stringify((options as { env: unknown }).env)).not.toContain(KEY)
  }
})
```

Run it. Expected: the first FAILS (no module), and once it exists the second still FAILS on
`KEY`: `gitEnvironment` (`snapshot.ts:394-406`) copies every variable not starting with
`GIT_`.

- [ ] **Step 3: Write the architecture rules (fail: no folder)**

Three rules in `tests/architecture/dependencies.test.ts`, on the `trace/` rule's pattern
(source read, comments stripped):

```typescript
// Any mention of the global, not only a call: `const f = fetch; f(url)`, `fetch.call(…)`,
// `Reflect.apply(fetch, …)` and `global.fetch` all name it. The one exemption is a `fetch`
// right after an escaped dot, `\.fetch`, which is text inside a regular expression:
// secrets.ts:285's `ENV\.fetch\(`.
const NAMES_FETCH = /(?<!\\\.)\bfetch\b/
const NAMES_A_GLOBAL_WAY_OUT = /\bglobalThis\b|\bglobal\b|\bXMLHttpRequest\b|\bWebSocket\b/

it('nothing in context/ names fetch or a global, and only the transport calls what it is handed', async () => {
  // `fetch` needs no import, so NETWORK cannot see it (the limit SECURITY.md states), which
  // is why the trace/ rule (:380) already refuses the word. The transport is handed a
  // `catalogueFetch` and calls it as `options.catalogueFetch(`; no other file calls one.
  const offending: string[] = []
  for (const file of await sourceFiles(path.join(SOURCE_ROOT, 'context'))) {
    const name = path.relative(SOURCE_ROOT, file)
    const code = stripped(await readFile(file, 'utf8'))
    if (NAMES_A_GLOBAL_WAY_OUT.test(code)) offending.push(`${name} names a global way out`)
    if (NAMES_FETCH.test(code)) offending.push(`${name} names fetch`)
    // `options.catalogueFetch(` in the transport; no call of one anywhere else.
    const calls = name === 'context/backstage/transport.ts' ? /(?<!\boptions\.)\bcatalogueFetch\s*\(/ : /\bcatalogueFetch\s*\(/
    if (calls.test(code)) offending.push(`${name} calls a catalogueFetch`)
  }
  expect(offending).toEqual([])
})

it('nothing reachable from agents/ is in context/backstage/, names fetch or names a global', …)
  // closureOf over every agents/ file: no specifier matching /(^|\/)backstage\//, and every
  // relative file reached, comments stripped, free of NAMES_FETCH and NAMES_A_GLOBAL_WAY_OUT

it('every process src/ starts is given spawnedEnvironment', …)
  // In each module of the `spawns` set: every call of a child_process function
  // (/\b(execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\s*\(/) is counted and held
  // to the number the rule states (today one, in snapshot.ts's `git`); the options of that
  // call pass `env: gitEnvironment()`; `gitEnvironment`'s body starts from
  // `spawnedEnvironment(`; and the module names `process.env` nowhere. Node's child_process
  // uses process.env when `env` is omitted, so a second call with no `env` would hand a child
  // the token and the keys: the count is what refuses it.
```

`context/project-fs/secrets.ts:285` holds `ENV\.fetch\(` inside a regular expression: the
escaped dot before it is the one exemption of `NAMES_FETCH`. The rules' own tests in "the
architecture rules themselves" pin each with a scratch tree: a bare `fetch(`, `const f =
fetch`, `globalThis.fetch`, `global.fetch`, `typeof globalThis.fetch` in a type, that regular
expression (not refused), `x.catalogueFetch(` outside the transport, and a second `execFile(`
with no `env` in a module of the `spawns` set.

Prove each bites before the code exists: add a throwaway `await fetch('x')` to
`src/context/iac-fs/provider.ts`, watch the first rule name it, delete it.

- [ ] **Step 4: Implement**

`transport.ts`, when built: the `base` is checked again — `https:`, or `http:` with
`isLoopback`; no username, password, search or hash; `pathname` matching
`/^(\/[^/]+)+$/` (one or more non-empty segments, no trailing slash) — else
`throw new TypeError(...)`, and a non-loopback base with no token is refused the same way.
Then, in this order inside `request`:

1. `(method, route)` in `CATALOGUE_REQUESTS`, else `throw new TypeError(...)`: a
   programming error, never a run's failure.
2. `const url = new URL(`${base.pathname}/${route}`, base.origin); url.search = query.toString()`.
   Then `url.origin === base.origin && url.pathname === `${base.pathname}/${route}``, else
   throw. Only then are the headers built: `accept: application/json`, and
   `authorization: Bearer <token>` when there is a token.
3. `options.catalogueFetch(url, { method, headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(limits.requestMs), options.signal ?? never]) })`.
   A rejection is classified: an `AbortError`/`TimeoutError` as a timeout (request or load,
   by which signal fired); a `TypeError` whose `cause` is an `Error` with the message
   `unexpected redirect` (what undici rejects with under `redirect: 'error'`) as
   `{ kind: 'redirect', status: undefined }`, never retried; a `TypeError` whose `cause`
   names a `code` as `unreachable` with that code; anything else as `unreachable` with the
   cause's class name, never its message.
4. `response.status` 3xx, `response.redirected`, or a non-empty `response.url` on another
   origin: refused, the body cancelled unread.
5. 429: `Retry-After` in seconds or as an HTTP date, at most `retryAfterMs`, while fewer
   than `retriesPerRun` retries were spent in this transport: wait (`sleep`), retry.
   Otherwise `rate-limited`.
6. Any other status outside 2xx: `{ kind: 'status', status }`, body cancelled unread.
7. The body read from `response.body.getReader()`, bytes counted per response and per run;
   past a bound the reader is cancelled and the failure thrown. `new TextDecoder('utf-8', { fatal: true })`,
   then `JSON.parse`; either failing is `not-json`.

The token is held in a closure and is never a field of the returned object, of the error or
of `spent`. `CatalogueReadError.message` is built from the failure and the origin only
(`scheme://host:port`), e.g. `the catalogue at https://backstage.canary.example answered 401`.

`spawned-environment.ts`: copies `env` (default `process.env`) without
`BACKSTAGE_TOKEN_VARIABLE` and without any name ending `_API_KEY` (every one of
`KEY_VARIABLES`, which the test holds it to). `context/` does not import `llm/`, so the
suffix is the rule and the test is the link. `gitEnvironment` starts from
`spawnedEnvironment()` instead of `process.env`, then drops `GIT_*` and sets its four
variables, as now.

**Exhaustive switches:** the classification of `CatalogueFailure` has no consumer yet; 1.5's
renderer is the first. **Architecture rules touched:** three added (16 → 19); rule 12's
`spawns` set unchanged.

- [ ] **Step 5: Checks**

```bash
pnpm vitest run tests/unit/backstage-transport.test.ts tests/unit/spawned-environment.test.ts tests/unit/project-tracked.test.ts
pnpm vitest run tests/architecture --reporter=verbose   # 19 rules
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
```

Expected: green; `project-tracked.test.ts` unchanged and green (git still runs with no `GIT_`
variable); the architecture count reads 19, and `AGENTS.md` says nineteen.

- [ ] **Step 6: The pull request** (after the owner's go-ahead)

```bash
git add src/context/backstage/transport.ts src/context/backstage/limits.ts src/context/spawned-environment.ts \
  src/context/project-fs/snapshot.ts src/context/README.md tests/architecture/dependencies.test.ts \
  tests/unit/backstage-transport.test.ts tests/unit/spawned-environment.test.ts \
  AGENTS.md SECURITY.md CHANGELOG.md README.md
git commit -m "feat(context): the one transport that may send a catalogue token, and its proofs"
```

Base `feat/bhttp-1-2`. CHANGELOG, `### Added`:

> - The `backstage-http` transport, the only code that will send a catalogue token: `GET` on
>   two routes, to the configured origin and path only, `redirect: 'error'` with 3xx and
>   foreign responses refused, bounded in bytes and time, 429 waited for within 10 s, and no
>   response quoted in an error; every child process now runs without `IDP_BACKSTAGE_TOKEN`
>   and without any provider key, which `git` inherited until now; three architecture rules
>   hold `fetch` to the transport. Nothing calls it yet
>   ([#92](https://github.com/pcaboor/idp-agent/pull/92)).

**What the owner can run:**

```bash
pnpm vitest run tests/unit/backstage-transport.test.ts tests/unit/spawned-environment.test.ts
# every test passes; no socket is opened (the offline floor would throw)
pnpm vitest run tests/architecture --reporter=verbose
# 19 rules under "architecture", every one ✓
OPENAI_API_KEY=canary IDP_BACKSTAGE_TOKEN=canary node -e \
  "import('./dist/context/spawned-environment.js').then(m => { const env = m.spawnedEnvironment(); console.log(['IDP_BACKSTAGE_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter(k => k in env)) })"
# []   (after pnpm build; a GITHUB_TOKEN or NPM_TOKEN of the shell is kept, as git may need it)
```

---

### Task 1.4: The load, the pre-pass and `BackstageProvider`

**Goal.** Read a whole catalogue into a `LoadResult`: the facet call, the kind-split read,
the cursor, uid and `totalItems` checks; `relations` and `status` dropped, provenance kept,
other namespaces and unmodelled values set aside; `readValue` per item; the order by
(`managed-by-location`, ref); the grouped, bounded stderr lines; and the fake Backstage, in
process for the tests and on a port for the demo. Proven against the fake alone; `cli/` does
not construct the provider yet.

**Files:**
- Create: `src/context/backstage/load.ts`, `src/context/backstage/translate.ts`, `src/context/backstage/provider.ts`
- Modify: `src/context/provider.ts` (`Ignored.prePass`, `LoadResult.census`)
- Create: `src/cli/render/catalogue-read.ts`
- Create: `tools/fake-backstage.ts`, `tests/support/fake-backstage.ts`
- Create: `tests/unit/backstage-load.test.ts`, `tests/unit/backstage-prepass.test.ts`,
  `tests/unit/backstage-provider.test.ts`, `tests/unit/catalogue-read-lines.test.ts`,
  `tests/unit/fake-backstage.test.ts`
- Modify: `src/context/README.md`, `src/cli/README.md` (the new renderer), `tests/README.md`
  (the fake and where it is used), `CHANGELOG.md`, `AGENTS.md`

**Interfaces:**

```typescript
// context/provider.ts
export interface Ignored {
  source: string; reason: string; kind?: string; ref?: string
  /** Set aside by the catalogue read's pre-pass, not by the reader: what the catalogue accepted and this tool does not model. */
  prePass?: { rule: 'namespace' | 'lifecycle' | 'resource-type' | 'name-case' | 'api-version' | 'shape'; value: string }
}
export interface Census { served: number; pages: number; bytes: number; ms: number; repeated: number }
export interface LoadResult { entities; rejected; ignored; unread; census?: Census }

// context/backstage/load.ts
export interface Served { readonly whole: unknown[]; readonly refs: unknown[]; readonly census: Census }
export async function loadCatalogue(transport: CatalogueTransport, limits?: …): Promise<Served>

// context/backstage/translate.ts
export type PrePassed = { value: Record<string, unknown>; uid?: string; location?: string } | { aside: Ignored }
export function prePass(item: unknown): PrePassed
export function catalogueOrder(a: { ref: string; location?: string }, b: …): number

// context/backstage/provider.ts
export class BackstageProvider implements ContextProvider {
  readonly name = 'backstage-http'
  constructor(options: { base: URL; token: string | undefined; catalogueFetch: CatalogueFetch; limits?: … })
  load(): Promise<LoadResult>   // throws CatalogueReadError: a partial read is never returned
}

// cli/render/catalogue-read.ts — pure, every catalogue value oneLine'd and cut to 80
export function setAsideLine(ignored: readonly Ignored[]): string | undefined
export function skippedLines(rejected: readonly Rejection[]): string[]

// tools/fake-backstage.ts — self-contained: node: modules and `yaml` only
export function catalogueOf(root: string, options?: { groups?: readonly string[]; location?: string }): Record<string, unknown>[]
export function handler(options: { entities: readonly Record<string, unknown>[]; token?: string; base?: string }): (request: Request) => Promise<Response>

// tests/support/fake-backstage.ts
export function fakeBackstage(options: FakeOptions & { faults?: Faults }): { fetch: CatalogueFetch; sent: Sent[] }
```

- [ ] **Step 1: The fake, and its own tests (fail: no module)**

`tools/fake-backstage.ts` serves what a real catalogue serves, from a folder of YAML
(`fixtures/si-demo` by default): every document of every `.yml`/`.yaml` file in path order,
null documents skipped, each given `metadata.namespace: default` when it has none,
`metadata.uid` (a hash of its location and position, so it is stable), `metadata.etag`,
`relations[]` built from its `spec` as Backstage builds them (`dependsOn`, `dependencyOf`,
`providesApi`, `ownedBy`), and the two annotations the catalogue overwrites,
`backstage.io/managed-by-location` and `backstage.io/managed-by-origin-location`, set to
`url:https://github.com/acme/si-demo/blob/main/<path from the root>`, so that ordering by
location is ordering by file. `spec` is kept as written, short references included. With
`groups`, it adds one `kind: Group` per name (the demo's three: `tiger`, `elephant`,
`dodowarriors`).

Its `handler` answers `GET {base}/entity-facets?facet=kind` with the counts of every kind,
and `GET {base}/entities/by-query` as current Backstage does (row 22):
`filter` (repeated `filter` parameters are ORed, `kind=` compared without case), `fields`
(dot paths), `limit` (200 when absent, no maximum), `cursor`, `totalItems` and
`pageInfo.nextCursor`, ordered by uid as Backstage orders by `entity_id`. The cursor is
opaque (base64 JSON) and holds the filter, the position and the first page's `totalItems`
only; `limit` and `fields` are read from **each** request, so a next page sent without them
comes back at 200 items and whole, as a real catalogue's would. A request holding a cursor
has its `filter` ignored, as `parseQueryEntitiesParams.ts` does. Any other method is a 405, any other
path a 404, and a wrong or missing bearer, when a token is configured, a 401. Run as a
program (`process.argv[1]` is this file), it listens with `node:http` on
`127.0.0.1:7007` (`--port <n>`, `0` for any; `--token <t>`; `--root <folder>`;
`--no-groups`), prints `listening on http://127.0.0.1:<port>/api/catalog` on stdout, and
one line per request on stderr (method, path, status; never a header), which is how the demo
script counts what it was asked. Imported, it starts nothing.

`tests/support/fake-backstage.ts` wraps `handler` as an injected `fetch` (it builds a
`Request` from `(input, init)`, keeps `{ method, url, headers, redirect, body }` in `sent`,
honours `init.signal`) and applies faults: a status on the n-th request, `Retry-After`, a
3xx with a `location`, a response `url` on another origin, a body echoing the request's
headers, a hang, a body that is not JSON, a body of n bytes, the same `nextCursor` twice, a
`nextCursor` that is a URL on another origin, a uid served on two pages (with or without
another left out), an item with no uid, a `totalItems` above what is served, facets that omit
a modelled kind, n extra modelled entities, an item holding a `__proto__` key or nested 65
deep.

`tests/unit/fake-backstage.test.ts`: the fake serves the demo SI's 33 entities over pages
of 10; a next page sent with the cursor alone comes back at the default 200 and whole, and
one sent with `limit` and `fields` comes back at that size and projected; a `filter` beside a
cursor is ignored; answers 405 to `POST`, 401 to a wrong token; `fields` returns refs only.
Run: FAIL, no module.

`tools/fake-backstage.ts` is outside `tsconfig.json`'s `include`, and is typechecked because
`tests/support/fake-backstage.ts` imports it (`../../tools/fake-backstage.js`): `tsc`
checks every file a checked file imports. It uses no syntax type stripping cannot erase (no
`enum`, no parameter properties, no `namespace`).

- [ ] **Step 2: The pre-pass tests (fail: no module)**

`tests/unit/backstage-prepass.test.ts`, one test per row of the note's § 5 table:

```typescript
it('drops relations and status, so a relation naming what no spec names creates no edge', async () => {
  const served = demoWith((items) => addRelation(items, 'component:default/billing-api', 'dependsOn', 'resource:default/ghost'))
  const graph = graphOf(await provider(served).load())
  expect(graph.dependenciesOf('component:default/billing-api').map(refOf)).not.toContain('resource:default/ghost')
  expect(graph.danglingReferences()).toEqual([])
})
it('keeps uid and etag out of the entity, so the not read: line is the file road’s', …)
it('sets a Component of namespace payments aside, and it does not replace component:default/billing-api', …)
it('sets aside lifecycle beta, and a reference to it is not dangling', …)
it('sets aside a Resource type it does not model: kafka-topic', …)
it('sets aside an upper-case name and a backstage.io/v1beta1 Component, with the reason', …)
it('sets aside an item nested deeper than 64, or holding a __proto__ or constructor key', …)
it('reads a dependsOn naming a custom kind read as refs only as not dangling', …)
```

- [ ] **Step 3: The load tests (fail: no module)**

`tests/unit/backstage-load.test.ts`, the failure matrix of the note's § 9 that belongs to the
load, each giving its `CatalogueFailure` and no `LoadResult`:

```typescript
it('asks the facets once, then reads Components, Resources and APIs whole and every other kind as refs', async () => {
  const { fetch, sent } = fakeBackstage({ entities: demoWithGroups })
  await loadCatalogue(transportOf(fetch))
  expect(sent.map(({ url }) => routeAndQuery(url))).toEqual([
    'entity-facets?facet=kind',
    'entities/by-query?filter=kind%3Dcomponent&filter=kind%3Dresource&filter=kind%3Dapi&limit=250',
    'entities/by-query?filter=kind%3Dgroup&fields=kind%2Cmetadata.namespace%2Cmetadata.name%2Cmetadata.uid&limit=250',
  ])
})
it('sends each next page its cursor, limit=250 and, for the refs read, the same fields; never filter', async () => {
  // Backstage's cursor carries the filter, the order and totalItems, not limit or fields
  // (parseQueryEntitiesParams.ts, createRouter.ts); CatalogClient.queryEntities re-sends both.
  const { fetch, sent } = fakeBackstage({ entities: demoWithGroups(600) }) // 600 Groups: three pages of refs
  await loadCatalogue(transportOf(fetch))
  const refsPages = sent.map(({ url }) => new URL(url)).filter((url) => url.searchParams.getAll('filter').includes('kind=group') || url.searchParams.has('cursor'))
  const next = refsPages.filter((url) => url.searchParams.has('cursor'))
  expect(next.length).toBeGreaterThan(0)
  for (const url of next) {
    expect(url.searchParams.getAll('filter')).toEqual([])
    expect(url.searchParams.get('limit')).toBe('250')
  }
  expect(next.at(-1)!.searchParams.get('fields')).toBe('kind,metadata.namespace,metadata.name,metadata.uid')
})
it('sends a nextCursor that is a URL on another origin only as the value of cursor, to the base', async () => {
  const foreign = 'https://evil.example/api/catalog/entities/by-query?x=1'
  const { fetch, sent } = fakeBackstage({ entities: demo, faults: { nextCursor: foreign } })
  await loadCatalogue(transportOf(fetch)).catch(() => undefined) // the cursor loop refuses the second sight
  const second = new URL(sent.find(({ url }) => new URL(url).searchParams.has('cursor'))!.url)
  expect(`${second.origin}${second.pathname}`).toBe('https://backstage.canary.example/api/catalog/entities/by-query')
  expect(second.searchParams.get('cursor')).toBe(foreign)
})
it('sends the modelled read even when the facets name no Component, Resource or API', …)
it('refuses a kind the facets name that the kind grammar refuses: filters are never built from other text', …)
it('refuses the same page twice: "the catalogue returned the same page twice"', …)
it('keeps a uid seen on two pages once, and counts it in census.repeated, when the read is still whole', …)
it('refuses fewer distinct uids than totalItems announced, with no uid repeated', …)
it('refuses one uid served twice and another left out: fewer distinct than announced, repeats or not', …)
it('refuses an item with no string metadata.uid', …)
it('refuses 20,001 modelled entities, and 200,001 refs of other kinds', …) // limits lowered in the test, the words checked with the real ones
it('refuses a page that is not the envelope { items, totalItems, pageInfo }', …)
it('refuses a load past 120 s', …) // limits.loadMs lowered
```

- [ ] **Step 4: The provider tests: the equivalence (fail: no module)**

`tests/unit/backstage-provider.test.ts` is the proof of "the same reader":

```typescript
it('reads the demo SI served by a catalogue as the files read it', async () => {
  const files = await new FixtureProvider(DEMO).load()
  const served = await new BackstageProvider(fromFolder(DEMO)).load()
  // The two annotations the catalogue sets (managed-by-location, managed-by-origin-location)
  // are the only difference an entity may carry.
  expect(served.entities.map(withoutCatalogueAnnotations)).toEqual(files.entities)
  expect(served.rejected).toEqual(files.rejected)
  expect(served.ignored).toEqual(files.ignored)
  expect(served.unread).toEqual(files.unread)
  expect(served.census).toMatchObject({ served: 33, repeated: 0 })
})

it.each(['backstage-apis', 'backstage-namespaces'])('reads %s as the files do, as sets, apart from what the pre-pass sets aside', …)
  // entities (by ref), ignored refs and unread as sets; rejection reasons as multisets;
  // the extra rows are exactly the prePass ones
it('orders by managed-by-location, then by ref, whatever order the pages came in', …) // the fake shuffles its pages
it('puts an entity with no managed-by-location last, by ref', …)
it('names a rejection by its ref and its location', …) // 'component:default/legacy-batch (url:https://…/legacy.yml)'
it('never returns part of a catalogue: a failure on the last page throws, with nothing returned', …)
```

- [ ] **Step 5: The grouped lines (fail: no module)**

`tests/unit/catalogue-read-lines.test.ts`:

```typescript
it('groups what the pre-pass set aside by rule, five values then "and K more", three refs', () => {
  expect(setAsideLine([...beta(120), ...development(60), ...payments(34)])).toBe(
    'set aside by the catalogue read: 180 lifecycle not modelled (beta ×120, development ×60), ' +
      '34 outside namespace default (payments ×34); first: component:default/a, component:default/b, component:default/c, …',
  )
})
it('groups what the reader skipped by reason, the five most common, three refs each', …) // 'skipped 2: spec.owner is required (component:default/legacy-batch, …)'
it('cleans and cuts every catalogue value to 80 characters: no C0, DEL or C1 survives', …) // the HOSTILE string of read-commands-hostile.test.ts in a kind, a namespace, a lifecycle, a type, a location
```

Run the five files. Expected: FAIL, the modules do not exist.

- [ ] **Step 6: Implement**

`load.ts`:
1. `GET entity-facets?facet=kind`. The envelope is zod-checked
   (`{ facets: { kind: { value: string; count: number }[] } }`). Every value must match the
   kind grammar (`/^[A-Za-z][A-Za-z0-9]*$/`), else the load is refused: a filter is never
   built from text that grammar refuses.
2. The modelled read, **always sent**: `filter=kind=component`, `filter=kind=resource`,
   `filter=kind=api`, `limit=250`; the other read: one `filter=kind=<value>` per other facet
   value, `fields=kind,metadata.namespace,metadata.name,metadata.uid`, `limit=250`, sent
   only when the facets name another kind.
3. Each read's first page sends its `filter`, `limit` and `fields`; each next page sends
   `cursor=<pageInfo.nextCursor>`, the same `limit=250` and the same `fields`, and never
   `filter` (row 22: Backstage reads `limit` and `fields` from every request, and its cursor
   holds only the filter, the order and `totalItems`). The cursor is only ever a query value,
   built by `URLSearchParams`, sent to the base. A cursor already seen is refused; the first
   page's `totalItems` is kept; the envelope is checked with zod
   (`{ items: unknown[]; totalItems: number; pageInfo: { nextCursor?: string } }`).
4. Every item must hold a string `metadata.uid`, else the load is refused (a read whose items
   cannot be counted cannot be proved whole). A uid seen before is kept once and counted
   (`repeated`). At the end of a read, **fewer distinct uids than the first page's
   `totalItems` is refused**, repeats or not ("the catalogue changed while it was read (N
   expected, M read)"); a repeat in a read that is still whole is kept for the notice
   (Choices: this amends the note's § 6 row). The two ceilings are checked as items arrive.
5. The load runs under one `AbortSignal.timeout(loadMs)` handed to the transport.

`translate.ts`'s `prePass(item)`, in this order: the shape walk (iterative, depth 64,
`__proto__` or `constructor` as a key: aside, `shape`); `relations` and `status` removed,
`metadata.uid` and `metadata.etag` removed and returned beside the value; for a Component
or a Resource: a namespace other than `default` (aside, `namespace`), a `backstage.io/v1beta1`
apiVersion (`api-version`), an upper-case name (`name-case`), a lifecycle outside
`COMPONENT_LIFECYCLES` (`lifecycle`), a Resource type outside `RESOURCE_TYPE_NAMES`
(`resource-type`). Each set-aside is an `Ignored` with its kind, its lower-case ref, the
reason in the reader's style ("lifecycle beta is not one this tool models") and `prePass`.
The constants are imported from `core/schemas/`, never restated. The YAML road does not
change: in a declarations repository a lifecycle this tool cannot write is still refused
(#49).

`provider.ts` names no `fetch`: its option is `catalogueFetch`, handed to the transport as is.
`load()` builds the transport, calls `loadCatalogue`, runs `prePass` then
`readValue` on each item of both reads, and returns the `LoadResult`: entities ordered by
`catalogueOrder` (location, then ref, code-unit order as `FixtureProvider` sorts paths;
without a location last), each rejection's `source` the ref plus ` (<location>)`, `ignored`
ordered by ref, and `census`. It throws `CatalogueReadError` for every failure and returns
nothing partial.

`catalogue-read.ts`: every value quoted is `oneLine(value, 80)`; five distinct values per
rule then "and K more"; three refs per line then `…`; the terms are the note's: "not
modelled", "set aside by the catalogue read", "skipped".

**Exhaustive switches:** `prePass`'s rule (new union), `readValue`'s reading in the provider,
the grouped line per `prePass.rule`. **Architecture rules:** the three of 1.3 now hold over
`load.ts`, `translate.ts` and `provider.ts` too (none names `fetch` or a global, none calls
a `catalogueFetch`; `agents/` reaches none).

- [ ] **Step 7: Checks**

```bash
pnpm vitest run tests/unit/fake-backstage.test.ts tests/unit/backstage-prepass.test.ts tests/unit/backstage-load.test.ts \
  tests/unit/backstage-provider.test.ts tests/unit/catalogue-read-lines.test.ts
pnpm vitest run tests/architecture --reporter=verbose   # still 19, all green
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
node tools/fake-backstage.ts --port 0 & sleep 1; kill %1   # prints its listening line and stops cleanly
```

- [ ] **Step 8: The pull request** (after the owner's go-ahead)

```bash
git add src/context/backstage/load.ts src/context/backstage/translate.ts src/context/backstage/provider.ts \
  src/context/provider.ts src/cli/render/catalogue-read.ts tools/fake-backstage.ts tests/support/fake-backstage.ts \
  tests/unit/fake-backstage.test.ts tests/unit/backstage-prepass.test.ts tests/unit/backstage-load.test.ts \
  tests/unit/backstage-provider.test.ts tests/unit/catalogue-read-lines.test.ts \
  src/context/README.md src/cli/README.md tests/README.md CHANGELOG.md AGENTS.md README.md
git commit -m "feat(context): read a whole catalogue through the file reader, or nothing"
```

Base `feat/bhttp-1-3`. CHANGELOG, `### Added`:

> - `BackstageProvider` reads a catalogue's Components, Resources and APIs whole and every
>   other kind as references, pages by cursor, and returns the demo SI served by a catalogue
>   exactly as the files read it: `relations` and `status` dropped, other namespaces and
>   values this tool does not model set aside and counted, each entity through the file
>   reader, ordered by location; a catalogue read in part is refused. A fake Backstage,
>   `tools/fake-backstage.ts`, serves the demo SI on `127.0.0.1:7007`. The CLI does not read
>   one yet ([#92](https://github.com/pcaboor/idp-agent/pull/92)).

**What the owner can run** (Node 22.18 or later; Node 22 may print an `ExperimentalWarning`
for type stripping on stderr, which `--disable-warning=ExperimentalWarning` silences):

```bash
node tools/fake-backstage.ts
# listening on http://127.0.0.1:7007/api/catalog
curl -s 'http://127.0.0.1:7007/api/catalog/entity-facets?facet=kind'
# {"facets":{"kind":[{"value":"Component","count":5},{"value":"Group","count":3},{"value":"Resource","count":28}]}}
curl -s 'http://127.0.0.1:7007/api/catalog/entities/by-query?filter=kind=component&limit=2' | head -c 400
# {"items":[{"apiVersion":"backstage.io/v1alpha1","kind":"Component","metadata":{… "uid":…, "relations":[…   (two Components, in uid order; then "totalItems":5 and a nextCursor)
curl -s -X POST -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7007/api/catalog/entities/by-query
# 405
pnpm vitest run tests/unit/backstage-provider.test.ts
# every test passes: the demo SI served by the fake reads as the files read it
```

The facet counts above are the demo SI's by kind (5 Components, 28 Resources, no `kind:
API`: its APIs are Resources of type `api`) plus the three Groups, which is the overview's
`kinds` block (`tests/golden/demo-read/overview.txt`); the executor checks them before
handing them over.

---

### Task 1.5: The source, with the key-reach leg

**Goal.** `Source` gains `{ kind: 'backstage', url, label, origin }`; the personal file gains
`backstage`; `IDP_BACKSTAGE_URL`, `IDP_BACKSTAGE_TOKEN` and `--backstage`; the exhaustive
switches; the failure line and its exit codes; the trace attributes; the notice after the
load; the Backstage wording of a reference declared nowhere; the hostile bytes end to end
through a catalogue; and the live key-reach leg of the note's § 4. First demo: `IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog
idpa relations mysql-prod-01 --impacts` against `tools/fake-backstage.ts` prints the README's
table. This is the first pull request in which a real run can reach a Backstage and print
what a catalogue holds, so it carries the test that proves where the token goes and the one
that proves no control byte of the catalogue reaches a terminal.

**Files:**
- Modify: `src/cli/source.ts` (`BackstageSource`, `BACKSTAGE_URL_VARIABLE`, `catalogueBase`, `shownUrl`, the chain, `originText`, `overviewName`, `blameOf`, `sourceNotice`, `catalogueFailureLine`)
- Modify: `src/cli/personal.ts` (`backstage?`)
- Modify: `src/cli/index.ts` (`READ_OPTIONS`, `readFrom`, `ReadFrom`, `HELP`, `MainDeps.catalogueFetch`, `providerOf`, the notice after the load, `notLoaded` and the grouped lines, the empty-source line, `failed`, `AgentRun.attributes`)
- Modify: `src/cli/usage.ts`, `src/cli/render/overview.ts`, `src/context/graph/overview.ts` (the pre-pass counted apart), `src/cli/commands/ask.ts` (the overview's source, the declared-nowhere phrase)
- Modify: `src/cli/render/entity.ts:67-74` (`nowhere`), `src/cli/render/relations.ts:95,275`, `src/cli/commands/show.ts`, `src/cli/commands/relations.ts` (the phrase as a parameter, today's words the default)
- Modify: `tests/contract/key-reach.test.ts` (the Backstage leg), `tests/setup/shell.ts`, `tests/unit/offline.test.ts`
- Create: `tests/unit/backstage-source.test.ts`, `tests/unit/backstage-read.test.ts`
- Modify: `tests/unit/configured-source.test.ts`, `tests/unit/personal-config.test.ts`, `tests/unit/env-example.test.ts` (`COMPUTED`), `tests/unit/read-commands-hostile.test.ts`
- Modify: `.env.example`, `SECURITY.md` (rows), `docs/adopting-backstage.md:155`, `src/cli/README.md`, `AGENTS.md`, `CHANGELOG.md`, `README.md` (badge)

**Interfaces:**

```typescript
export const BACKSTAGE_URL_VARIABLE = 'IDP_BACKSTAGE_URL'
export type Origin =
  | { by: 'flag' } | { by: 'working-directory' }
  | { by: 'variable'; name: typeof REPO_VARIABLE | typeof BACKSTAGE_URL_VARIABLE }
  | { by: 'file'; file: string } | { by: 'default' }
export interface BackstageSource {
  readonly kind: 'backstage'
  /** The catalogue API's base, checked (`catalogueBase`). Never printed whole: the notice names the host. */
  readonly url: string
  /** The host and port, flattened. */
  readonly label: string
  /** Where the URL came from: `IDP_BACKSTAGE_URL` or the file, also when `--backstage` chose it. */
  readonly origin: Extract<Origin, { by: 'variable' } | { by: 'file' }>
}
export type Source = RepositorySource | DemoSource | BackstageSource
/**
 * Exit 2 for a URL that does not parse, http: to a non-loopback host, userinfo, a query, a
 * fragment, a `\`, a path `new URL` would rewrite, an empty, `.`, `..` or `%2e` segment.
 * The refusal quotes `shownUrl(raw)`, never `raw`.
 */
export function catalogueBase(raw: string, where: string): URL
/** `raw` as a refusal may quote it: userinfo, query and fragment each `***`; a value that does not parse, its length alone. */
export function shownUrl(raw: string): string
/** The one line a failed catalogue read prints, exit 1: host, what named it, the class, the way out. */
export function catalogueFailureLine(error: CatalogueReadError, source: BackstageSource): string

// MainDeps
/** The catalogue's transport. Injected for tests; a real run hands the global one to the transport, which never reaches for it itself. */
catalogueFetch?: CatalogueFetch
```

- [ ] **Step 1: The configuration tests (fail)**

`tests/unit/backstage-source.test.ts`:

```typescript
describe('the catalogue URL, checked before any request', () => {
  const CANARY = 'canary-secret-0123456789'
  it.each([
    ['not a URL', 'backstage', /does not parse/],
    ['the token where the URL goes', CANARY, /a value of 24 characters that does not parse as a URL/],
    ['http to a host that is not loopback', 'http://backstage.acme.example/api/catalog', /https:, or http: to 127\.0\.0\.1, ::1 or localhost/],
    ['userinfo', `https://me:${CANARY}@backstage.acme.example/api/catalog`, /userinfo/],
    ['a query', `https://backstage.acme.example/api/catalog?token=${CANARY}`, /query/],
    ['a fragment', `https://backstage.acme.example/api/catalog#${CANARY}`, /fragment/],
    ['a dot segment', 'https://backstage.acme.example/api/./catalog', /segment/],
    ['a dot-dot segment', 'https://backstage.acme.example/api/../catalog', /segment/],
    ['an encoded dot-dot segment', 'https://backstage.acme.example/api/%2e%2e/catalog', /segment/],
    ['an encoded dot segment', 'https://backstage.acme.example/api/%2E/catalog', /segment/],
    ['a backslash', 'https://backstage.acme.example\\api\\catalog', /\\/],
    ['an empty segment', 'https://backstage.acme.example/api/catalog/', /segment/],
    ['no path', 'https://backstage.acme.example', /catalogue API's base/],
  ])('refuses %s with 2, naming IDP_BACKSTAGE_URL, before any request, quoting no secret', async (_, url, why) => {
    const { code, err, catalogue } = await run(['graph'], { env: { IDP_BACKSTAGE_URL: url, IDP_BACKSTAGE_TOKEN: 't' } })
    expect(code).toBe(2)
    expect(err).toMatch(/^IDP_BACKSTAGE_URL=/)
    expect(err).toMatch(why)
    expect(err).not.toContain(CANARY)
    expect(catalogue.sent).toEqual([])
  })
  it('quotes a refused URL with its userinfo, query and fragment starred', () => {
    expect(shownUrl(`https://me:${CANARY}@backstage.acme.example/api/catalog?t=${CANARY}#${CANARY}`))
      .toBe('https://***@backstage.acme.example/api/catalog?***#***')
  })
  it('names the file for a backstage: in config.yml', …)
  it('refuses a missing or empty token for a non-loopback host, naming IDP_BACKSTAGE_TOKEN', …)
  it('reads a loopback host with no token, and sends no Authorization header', …)
  it('refuses --backstage with nothing configured, and --backstage beside --repo or --demo', …)
  it('refuses token: in config.yml by name, as before', …) // personalSchema is strict
  it('never reads backstage: in .idp-agent.yml', …) // a hostile committed URL is not requested
})
```

`tests/unit/configured-source.test.ts` gains the precedence rows of the note's § 10, first
match wins: `--repo`/`--demo`/`--backstage`; the working directory on its markers (and its
notice then says `--backstage` reads the catalogue); `IDP_BACKSTAGE_URL`; `IDP_REPO`; the
file's `backstage`; the file's `repo`; the demo SI. At each level a Backstage beats a
repository, and what is not reached is not read (a malformed `backstage:` does not refuse a
run `IDP_BACKSTAGE_URL` answered). `personal-config.test.ts` gains `backstage:` read,
`backstage: ~` refused as `repo: ~` is.

- [ ] **Step 2: The read tests (fail)**

`tests/unit/backstage-read.test.ts`, every run through `main` with the fake as
`catalogueFetch`:

```typescript
it.each([
  [['graph']], [['graph', '--kind', 'Component']], [['show', 'billing-api']], [['relations', 'mysql-prod-01', '--impacts']],
  [['relations', 'reporting-worker', '--to', 'billing-api']],
])('%s prints what --demo prints, byte for byte', async (argv) => {
  const demo = await run([...argv, '--demo'])
  const catalogue = await run(argv, { env: { IDP_BACKSTAGE_URL: LOOPBACK }, catalogueFetch: servingDemo.fetch })
  expect(catalogue.out).toBe(demo.out)
  expect(catalogue.code).toBe(demo.code)
})
it('ask: the overview is the demo’s from its second line, and its first names the catalogue', …) // scripted client answering { outcome: 'overview' }
it('prints the notice after the load, with the counts', async () => {
  const { err } = await run(['relations', 'mysql-prod-01', '--impacts'], withGroups)
  expect(err).toBe(
    'reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 36 entities: 33 read, 3 not modelled; ' +
      'it may lag the declarations repository by minutes; --repo <directory> reads a repository\n' +
      'not loaded: 3 documents this tool does not model (Group ×3)\n',
  )
})
it('counts what the pre-pass set aside once, apart from the kinds not modelled', async () => {
  // The demo with Groups, plus a Component of lifecycle beta and one of namespace payments.
  const { err } = await run(['graph', '--kind', 'Component'], withGroupsBetaAndPayments)
  expect(err).toBe(
    'reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 38 entities: 33 read, 3 not modelled, 2 set aside; ' +
      'it may lag the declarations repository by minutes; --repo <directory> reads a repository\n' +
      'not loaded: 3 documents this tool does not model (Group ×3)\n' +
      'set aside by the catalogue read: 1 lifecycle not modelled (beta ×1), 1 outside namespace default (payments ×1); first: component:default/beta-svc, component:payments/pay-svc\n',
  )
})
it('says the catalogue changed while it was read when a uid came twice and the read was still whole', …)
  // the fake's 'uid served on two pages' fault, with totalItems still reached:
  // '…: 36 entities: 33 read, 3 not modelled; the catalogue changed while it was read (1 served twice); it may lag …'
it('blames the catalogue, not a repository, when it serves no entity', …)
  // 'the Backstage catalogue at 127.0.0.1:7007 serves no entity this token reads; IDP_BACKSTAGE_URL names it'
it('refuses a question, exit 2 before any request, when the repository a change would use is misconfigured', …)
  // IDP_BACKSTAGE_URL (loopback) and IDP_REPO=relative: `idpa "who owns billing-api?"` exits 2 with
  // "IDP_REPO=relative is relative…", catalogue.sent stays empty, and no model is called.
  // The one proof of 1.2's placement of `declarationsFor` before `provider.load()`: seen
  // failing with that block moved below the load.
it('says "declared nowhere in the catalogue this token reads" on show, relations and the ask answer', …)
  // a dependsOn naming nothing, served by the fake: `show`, `relations`, and `ask`/`idpa` answered by a
  // scripted Analyst whose answer renders the entity (ask.ts:201) and a relations block (ask.ts:172);
  // the same references read from a repository still read "declared nowhere" (tests/golden/dangling-shown/ unchanged)
it('reads the catalogue once, before the first model call, on both roads', …)
  // a scripted client whose generate() records catalogue.sent.length at its first call; after the run it is unchanged, and the facets were asked once
it.each(FAILURES)('%s: one classified line, exit 1, nothing on stdout', …)
  // 401, 403, 404 on the first page ("not a catalogue API base: expected <url>/entities/by-query"), 429 past retries,
  // 500, a hang, 301/302/307, a foreign url, over the byte bound, non-JSON, a cursor loop, fewer than totalItems,
  // 20,001 modelled, unreachable — and `idpa "<change>"` with the catalogue unreachable
it('decides a change against the configured repo, never the catalogue it classified from', …)
  // file: repo + backstage; the scripted Architect proposes; the diff is against the repo's bytes
it('lets nothing in the catalogue vouch: an owner only the catalogue holds is asked, exit 3', …)
  // the catalogue declares group:default/only-in-catalogue as an owner; the scripted Architect proposes it;
  // the signature makes it a question because the plan's vocabulary is the repository's
it('refuses a change with a catalogue and no repository, in planNeedsRepository’s words', …)
it('never reads the catalogue for plan, nor for a phrase given --repo', …) // catalogueFetch that throws, never called
it('records the source as root attributes of the trace, and never the token', …) // memorySink; idp.source.kind … idp.source.ms
```

`tests/unit/read-commands-hostile.test.ts` gains a `describe` serving, through the fake, the
file's `HOSTILE` bytes in every free-text field of the served JSON and in the kind (a
refs-only kind), a namespace, a lifecycle, a type and `managed-by-location`. `graph`, `show`,
`relations` and the `ask` overview through `main`: stdout and stderr hold no C0 but the line
feed, no DEL and no C1; no grouped line is longer than its stated bound; a kind the grammar
refuses ends the run on its one line, cleaned.

`tests/unit/offline.test.ts` gains: `shellVariables(env, true)` (a scenario recording) still
returns `IDP_BACKSTAGE_URL` and `IDP_BACKSTAGE_TOKEN`, and only them.

The line of the note's § 10, rendered by `catalogueFailureLine`:

```text
the Backstage catalogue at backstage.acme.example (config.yml) refused the token (401): IDP_BACKSTAGE_TOKEN is set and not accepted; --repo <directory> reads a repository instead, and `idpa plan` decides a change without the catalogue
```

- [ ] **Step 3: The key-reach leg (fail)**

In `tests/contract/key-reach.test.ts`, a second `describe.each(PROVIDER_NAMES)` on the
existing pattern (`live`, only the transports replaced). A temporary `config.yml` names both
a `repo` (a copy of the demo SI) and `backstage: https://backstage.canary.example/api/catalog`,
located by `XDG_CONFIG_HOME`. `main`'s injected `env` holds `XDG_CONFIG_HOME`,
`IDP_BACKSTAGE_TOKEN` (the canary) and the key, beside the existing leg's variables: the
source is resolved from that `env` (`sourceContextOf` reads `deps.env ?? process.env`), and
without the token there the `https:` base is refused, exit 2. `process.env` holds the canary
token and the key too (`vi.stubEnv`), as a real shell would, so a child process that
inherited it would carry them. The fake (with the canary token configured, so an
unauthenticated request would be a 401) is `catalogueFetch`, and it serves the demo SI plus
one Component only the catalogue holds, `component:default/catalogue-only-canary`, owned by
`group:default/only-in-catalogue`: no file of the repository copy names either, whereas
`group:default/tiger` is in 14 of them, so only this marker proves that catalogue content
reached a request. The provider stub is on the global `fetch`; MLflow is stubbed through
`MainDeps.fetch`; `node:child_process`'s `execFile` is wrapped to keep each call's `env` and
call through. The application directory stays outside git: the Inspector's `git rev-parse
--show-toplevel` runs on it all the same (row 11), and it then walks and reads its
`package.json`.

```typescript
const MARKER = 'group:default/only-in-catalogue'

it('reaches the catalogue only, in one header, on a question and on a change', async () => {
  for (const road of [question, change]) {             // idpa "<question>"  and  idpa "<change>" --project <directory>
    const { toCatalogue, toProvider, toMlflow, global, spawned, out, err, trace } = await runRoad(road)
    expect(toCatalogue.length).toBeGreaterThan(0)
    for (const sent of toCatalogue) {
      expect(`${new URL(sent.url).origin}${new URL(sent.url).pathname}`).toMatch(/^https:\/\/backstage\.canary\.example\/api\/catalog\/(entities\/by-query|entity-facets)$/)
      expect(sent.method).toBe('GET')
      expect(sent.redirect).toBe('error')
      expect(Object.entries(sent.headers).filter(([, value]) => value.includes(TOKEN))).toEqual([['authorization', `Bearer ${TOKEN}`]])
      expect(JSON.stringify(sent)).not.toContain(KEY)
    }
    expect(global.filter(({ url }) => url.startsWith('https://backstage.canary.example'))).toEqual([])
    // Catalogue content reaches the provider and MLflow on both roads — the Supervisor's
    // summary, and on a question the Analyst's — so the token searches below are not vacuous.
    const offering = (tool: string) => toProvider.filter(({ body }) => wire.offered(JSON.parse(body)).includes(tool))
    expect(toProvider.some(({ body }) => body.includes(MARKER))).toBe(true)
    expect(toMlflow.some(({ body }) => body.includes(MARKER))).toBe(true)
    if (road === question) expect(offering('answer').some(({ body }) => body.includes(MARKER))).toBe(true)
    // The Architect is shown the repository, never the catalogue (§ 3).
    if (road === change) expect(offering(PROPOSE_TOOL).some(({ body }) => body.includes(MARKER))).toBe(false)
    for (const sent of [...toProvider, ...toMlflow]) expect(JSON.stringify(sent)).not.toContain(TOKEN)
    if (road === change) expect(spawned.length).toBeGreaterThan(0)   // the question road starts no process
    for (const env of spawned) expect(JSON.stringify(env)).not.toMatch(new RegExp(`${TOKEN}|${KEY}`))
    for (const text of [out, err, trace]) { expect(text).not.toContain(TOKEN); expect(text).not.toContain(KEY) }
  }
})

it.each([401, 403, 500, 'a body echoing the request'])('puts the token nowhere when the catalogue answers %s', …)
  // exit 1, one line on stderr, and neither stdout, stderr nor the trace holds the token or the key
```

Run: `pnpm vitest run tests/contract/key-reach.test.ts`. Expected: FAIL, exit 2 on the
first road: the personal file's schema is strict (`personal.ts:116-119`), so `backstage:` in
`config.yml` is refused by name before anything is read.

- [ ] **Step 4: Implement the source**

`source.ts`:
- `catalogueBase(raw, where)`: any `\` is refused first; then the path segments of `raw`
  as typed (the text after the authority, up to `?` or `#`) are checked, an empty segment and
  one matching `/^(\.|%2e){1,2}$/i` refused; then `new URL(raw)`, whose `pathname` must equal
  the typed path (any rewrite the parser would make is refused, row 22's `%2e` included);
  `https:`, or `http:` with `isLoopback`; no username, password, query or fragment (in the
  text as typed too: a bare `?` is a query). Each refusal is `refusal(...)` (exit 2) and
  quotes `shownUrl(raw)`, flattened: never the value itself (Choices).
- The token rule, at resolution time: a non-loopback base with `IDP_BACKSTAGE_TOKEN` unset
  or empty is refused, exit 2, naming the variable and the host. The token is **not** part
  of the `Source`. This is one of the **two** places `IDP_BACKSTAGE_TOKEN` is read, both from
  the same context environment (`deps.env ?? process.env`): its presence here, its value in
  `providerOf`. Both are listed in `env-example.test.ts`'s `COMPUTED`.
- The chain for a read, first match wins: `--repo` or `--demo` or `--backstage` (the
  configured catalogue: `IDP_BACKSTAGE_URL`, else the file's `backstage`, else refused);
  the working directory on its markers; `IDP_BACKSTAGE_URL`; `IDP_REPO`; the file's
  `backstage`; the file's `repo`; the demo SI. The personal file is read once, and only
  when reached. A source `--backstage` chose carries the origin of its URL (the variable
  or the file). `declarationsFor` is unchanged: it never includes a Backstage.
- `overviewName`: `the Backstage catalogue at <label>`. `blameOf`'s `case 'backstage'`
  does not call `namedBy` (which names a repository: `--repo`, `repo in <file>`), and names
  `IDP_BACKSTAGE_URL` or `backstage in <file>` itself, with its own exhaustive switch.
  `sourceNotice(command, source, context, census?)`: the note's line for a Backstage, from
  the census, with the counts of Choices ("The notice"); for a repository read from the
  working directory while a catalogue is configured, `, --backstage the catalogue` is added
  to its alternatives. `originText` is unchanged: the new variable is one more `name`.

`personal.ts`: `backstage: z.string().min(1).max(4096).optional()`, a bare `~` refused as
`repo`'s is, and `PersonalConfig.backstage` the string as written (a URL, never
home-expanded).

`index.ts`:
- `READ_OPTIONS` gains `backstage: { type: 'boolean' }`; `readFrom` refuses any two of
  `--repo`, `--demo`, `--backstage` ("never both: …"); `ReadFrom` gains `{ backstage: true }`.
  `HELP` and `usage.ts` name `--backstage` on `graph`, `show`, `relations`, `ask` and the
  phrase, and one paragraph says where the catalogue comes from and that a change is still
  decided against a repository.
- `providerOf`'s switch gains `case 'backstage'`: `new BackstageProvider({ base, token:
  env[BACKSTAGE_TOKEN_VARIABLE] || undefined, catalogueFetch: deps.catalogueFetch ?? globalThis.fetch })`,
  `env` being the context's. The value is read here and nowhere else; `source.ts` only checks
  that it is there.
- The entry road's `declarationsFor` (placed before the load by 1.2) now runs before any
  request to the catalogue, so a broken `IDP_REPO` or file `repo` is exit 2 with nothing
  sent, on a question too (Choices).
- The notice moves after `provider.load()`, for every source; for a Backstage the
  per-rejection `skipped` lines give way to `skippedLines`. `notLoaded` takes only the
  `Ignored` rows without `prePass`, and `setAsideLine` the rows with it, after `notLoaded`,
  so no entity is counted under two terms (row 23). The empty-source line is worded per
  source: a repository "declares no entity; <blame> names the declarations repository", as
  now; a catalogue "serves no entity this token reads; <blame> names it". A
  `CatalogueReadError` from the load goes to `failed` through `catalogueFailureLine`, exit 1.
- `main` chooses the phrase for a reference nobody declares — `'declared nowhere in the
  catalogue this token reads'` for a Backstage, today's `'declared nowhere'` otherwise — and
  hands it to `runShow`, `runRelations` and, through `asked.source` (`AskOptions`), to
  `ask.ts`'s answer block, which renders an entity (`:201`) and relations (`:172`) itself.
  `nowhere` (`render/entity.ts:67-74`) and the relations renderer (`render/relations.ts:95`,
  `:275`'s section title) take it as a parameter with today's words as the default, so every
  golden stands. What the agents' tools say to a model does not change.
- `ask` and `entry` pass `attributes` to `agentBacked` when the source is a Backstage:
  `idp.source.kind`, `idp.source.origin` (scheme, host, port, path), `idp.source.entities`,
  `idp.source.set_aside`, `idp.source.pages`, `idp.source.bytes`, `idp.source.ms`.

`render/overview.ts`: the overview's source is `{ repo } | { catalogue } | {}`, and the
first line reads `Overview of the Backstage catalogue at <host>: …`. `context/graph/overview.ts`'s
`setAside.kinds` tallies only the rows without `prePass`, and a new `setAside.catalogueRead`
counts the others, rendered as one line, `N set aside by the catalogue read`, only when
non-zero, so the demo's overview is unchanged.

`tests/setup/shell.ts`: `shellVariables` returns `IDP_BACKSTAGE_URL` and
`IDP_BACKSTAGE_TOKEN` also while a scenario records, so a recording never reads a catalogue
(the scenarios call `main` with `env: process.env` and no `--demo`,
`tests/scenarios/question-mode.test.ts:34-39`), and no tape can hold catalogue content.

`.env.example` gains, in a section of its own after the declarations repository:

```bash
# --- A Backstage catalogue: read for questions, never for a change ------------------
# The catalogue API's base, never the app's URL: https://<backend host>/api/catalog.
# https:, or http: to 127.0.0.1, ::1 or localhost. The alternative is `backstage:` in
# ~/.config/idp-agent/config.yml; this one wins.
# IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog
# A read token (docs/adopting-backstage.md). Required for any host but a loopback one;
# sent to that catalogue only, never into a file, a trace or a child process. Set, it is
# sent to a loopback host too, over plain http: unset it (env -u) for the local fake.
# IDP_BACKSTAGE_TOKEN=
```

`env-example.test.ts`'s `COMPUTED` gains the two constants' names, for the three reads: the
URL in `source.ts`, the token's presence in `source.ts` and its value in `cli/index.ts`.

`SECURITY.md`: "What the tool does today" gains the catalogue read; "What leaves your
machine" gains the row to the configured Backstage (the token and `GET` on the two routes,
with kind filters and paging, nothing else) and the model-provider row says "a summary of
the source read" and that catalogue content reaches the provider and, traced, MLflow;
the threat model adds the breadth (every team's catalog-info); the guarantees table gains
the key-reach leg, the transport tests and the spawned-environment test, each by name.
`docs/adopting-backstage.md:155` says the provider is built, from this pull request.

**Exhaustive switches:** `Source` in `overviewName`, `blameOf`, `sourceNotice`, `providerOf`;
`CatalogueFailure` in `catalogueFailureLine`; the overview's source in `render/overview.ts`.
A `default: never` in each. **Architecture rules:** unchanged at 19; `cli/source.ts` still
only stats (the rule "only the named modules of cli/ touch the disk" is unchanged).

- [ ] **Step 5: Checks**

```bash
pnpm vitest run tests/unit/backstage-source.test.ts tests/unit/backstage-read.test.ts tests/contract/key-reach.test.ts \
  tests/unit/configured-source.test.ts tests/unit/personal-config.test.ts tests/unit/env-example.test.ts tests/unit/readme-commands.test.ts \
  tests/unit/read-commands-hostile.test.ts tests/unit/offline.test.ts
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git status --short tests/recordings tests/golden fixtures   # nothing
```

Expected: green; every scenario tape replays with no digest warning.

- [ ] **Step 6: The pull request** (after the owner's go-ahead)

```bash
git add src/cli/source.ts src/cli/personal.ts src/cli/index.ts src/cli/usage.ts src/cli/render/overview.ts \
  src/context/graph/overview.ts src/cli/render/entity.ts src/cli/render/relations.ts src/cli/commands/show.ts \
  src/cli/commands/relations.ts src/cli/commands/ask.ts tests/contract/key-reach.test.ts tests/setup/shell.ts \
  tests/unit/offline.test.ts tests/unit/backstage-source.test.ts tests/unit/backstage-read.test.ts \
  tests/unit/configured-source.test.ts tests/unit/personal-config.test.ts tests/unit/env-example.test.ts \
  tests/unit/read-commands-hostile.test.ts .env.example SECURITY.md docs/adopting-backstage.md src/cli/README.md \
  AGENTS.md CHANGELOG.md README.md
git commit -m "feat(cli): answer questions and relations from a Backstage catalogue"
```

Base `feat/bhttp-1-4`. CHANGELOG, `### Added`:

> - `graph`, `show`, `relations`, `ask` and `idpa "<phrase>"` read a Backstage catalogue when
>   one is configured — `IDP_BACKSTAGE_URL`, or `backstage:` in the personal `config.yml`, or
>   `--backstage` to choose it — read once per run before any model, with its token from
>   `IDP_BACKSTAGE_TOKEN` alone; a change is still decided against the declarations
>   repository, and nothing read from the catalogue vouches for a plan; a misconfiguration is
>   exit 2 and an unreachable or partial catalogue exit 1, never a fall back; the key-reach
>   test proves the token reaches the catalogue alone, on every provider, on both roads; no
>   control byte a catalogue serves reaches the terminal, a reference the token cannot see
>   reads "declared nowhere in the catalogue this token reads", and a recording never reads
>   a catalogue ([#92](https://github.com/pcaboor/idp-agent/pull/92)).

**What the owner can run** (after `pnpm build`; terminal 1 runs the fake). Every command
against the fake starts with `env -u IDP_BACKSTAGE_TOKEN`: once a company token is exported,
it would otherwise be sent, over plain http, to whatever listens on 7007 — the configured
origin, so the rule holds, but not where that token belongs.

```bash
# terminal 1
node tools/fake-backstage.ts
# listening on http://127.0.0.1:7007/api/catalog

# terminal 2, from anywhere that is not a declarations repository
env -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog node ~/Documents/idp-agent-worktrees/bhttp/dist/cli/bin.js relations mysql-prod-01 --impacts
```

Expected, exit 0:

```text
reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 36 entities: 33 read, 3 not modelled; it may lag the declarations repository by minutes; --repo <directory> reads a repository
not loaded: 3 documents this tool does not model (Group ×3)
resource:default/mysql-prod-01

impacts (9)
  ENTITY                                        TYPE             ENV   DEPTH  PATH
  resource:default/billing-db-prod              database         prod  1      mysql-prod-01 ← billing-db-prod
  resource:default/compliance-db-prod           database         prod  1      mysql-prod-01 ← compliance-db-prod
  resource:default/orders-db-prod               database         prod  1      mysql-prod-01 ← orders-db-prod
  resource:default/billing-api-billing-db-prod  database-access  prod  2      mysql-prod-01 ← billing-db-prod ← billing-api-billing-db-prod (readwrite)
  resource:default/orders-api-orders-db-prod    database-access  prod  2      mysql-prod-01 ← orders-db-prod ← orders-api-orders-db-prod (readwrite)
  resource:default/reporting-billing-db-prod    database-access  prod  2      mysql-prod-01 ← billing-db-prod ← reporting-billing-db-prod (read)
  component:default/billing-api                 service          -     3      mysql-prod-01 ← billing-db-prod ← billing-api-billing-db-prod (readwrite) ← billing-api
  component:default/orders-api                  service          -     3      mysql-prod-01 ← orders-db-prod ← orders-api-orders-db-prod (readwrite) ← orders-api
  component:default/reporting-worker            service          -     3      mysql-prod-01 ← billing-db-prod ← reporting-billing-db-prod (read) ← reporting-worker
```

Then, each keyless:

```bash
# the fake stopped (Ctrl-C in terminal 1):
env -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog node dist/cli/bin.js graph
# the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL) could not be reached (ECONNREFUSED); --repo <directory> reads a repository instead, and `idpa plan` decides a change without the catalogue      (exit 1, stdout empty)
env -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=https://backstage.acme.example/api/catalog node dist/cli/bin.js graph
# IDP_BACKSTAGE_TOKEN is not set; the Backstage catalogue at backstage.acme.example needs a read token (docs/adopting-backstage.md)      (exit 2, no request)
IDP_BACKSTAGE_URL='https://me:not-a-secret@backstage.acme.example/api/catalog' node dist/cli/bin.js graph
# IDP_BACKSTAGE_URL=https://***@backstage.acme.example/api/catalog holds userinfo; …   (exit 2; `not-a-secret` appears nowhere)
env -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog node dist/cli/bin.js graph --repo fixtures/si-demo
# the demo SI's graph; --repo wins and the catalogue is not read                      (exit 0)
env -u IDP_BACKSTAGE_TOKEN IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog node dist/cli/bin.js plan --from examples/open-network.json --repo fixtures/si-demo
# pnpm demo's step 3, byte for byte: a plan never reads the catalogue                 (exit 0)
```

The exact words of the three refusals are those the tests of this pull request pin; the
executor copies them from a run before handing this list over.

---

### Task 1.6: The summary cap and the documents

**Goal.** Thirty values per vocabulary list in the Supervisor's and the Analyst's summary,
then "and K more", byte-neutral for the demo, with the commentary check handed the lists as
printed; `pnpm demo:backstage`; design §3, §7.0 and §13, the README, a new ADR (0011), and
the roadmap, the note and the review closed out for slice 1. (The hostile bytes through a
catalogue and the Backstage wording of a reference declared nowhere moved to 1.5.) The closing demo against a **real** Backstage is not in this pull request:
it moves to the next queue item, the Backstage in Docker (see the end of this task).

**Files:**
- Modify: `src/context/graph/summary.ts` (`counts`), `src/agents/summary.ts` (`shownVocabulary`, the cap in `formatSummary`)
- Modify: `src/cli/commands/ask.ts:83,131-136` (the summary with `counts`; the commentary gets the lists as shown). `plan.ts:1297` and `init.ts:780` are not touched: they call `formatSummary` without `counts`, which prints every value, as today (row 5)
- Create: `scripts/demo-backstage.mjs`; Modify: `package.json` (`demo:backstage`), `scripts/smoke.mjs` (runs it where Node strips types; its header's "No network" at `:13` becomes "No network beyond a loopback fake it starts itself")
- Create: `tests/unit/summary-cap.test.ts`; Modify: `tests/unit/ask-commentary.test.ts`, `tests/unit/package-scripts.test.ts`
- Create: `docs/adr/0011-backstage-to-explore.md`
- Modify: `docs/design.md` §3 (the provider schedule, `:39`), §7.0, and §13 (`:1305`, "The `backstage-http` provider (MVP)" out of scope: now built for the read commands, still never for a change), `README.md`, `docs/adopting-backstage.md`, `docs/backstage-http-brief.md` (slice 1 **Built**), `docs/roadmap.md`, `docs/reviews/2026-09-23-deep-review.md` (Status), `AGENTS.md`, `src/context/README.md`, `CHANGELOG.md`

**Interfaces:**

```typescript
// context/graph/summary.ts
export type VocabularyCounts = { readonly [K in keyof Vocabulary]: ReadonlyMap<string, number> }
export function summariseGraph(graph: EntityGraph): { summary: SiSummary; vocabulary: Vocabulary; counts: VocabularyCounts }

// agents/summary.ts
export const VOCABULARY_LIST_LIMIT = 30
/** Each list as the prompt shows it: flattened, deduplicated, and past 30 the 30 most frequent, alphabetically, with how many more. */
export function shownVocabulary(vocabulary: Vocabulary, counts?: VocabularyCounts): { [K in keyof Vocabulary]: { values: string[]; more: number } }
/** With `counts`, each list is capped (`shownVocabulary`); without, every value is printed, as the Architect's and init's are. */
export function formatSummary(summary: SiSummary, vocabulary: Vocabulary, counts?: VocabularyCounts): string
```

- [ ] **Step 1: The cap's tests (fail)**

`tests/unit/summary-cap.test.ts`:

```typescript
it('prints a list of 30 or fewer exactly as before', () => {
  // The demo SI's summary, whose bytes every tape's digest was recorded over.
  expect(formatSummary(summary, vocabulary, counts)).toBe(readFileSync(GOLDEN_SUMMARY, 'utf8').trimEnd())
})
it('prints the 30 most frequent of a longer list, alphabetically, then "and K more"', () => {
  const owners = Array.from({ length: 300 }, (_, i) => `group:default/team-${String(i).padStart(3, '0')}`)
  const text = formatSummary(summaryOf(owners), vocabularyOf(owners), countsOf(owners, { 'group:default/team-299': 9 }))
  const line = text.split('\n').find((l) => l.startsWith('  owners: '))!
  expect(line.endsWith(', and 270 more')).toBe(true)
  expect(line).toContain('group:default/team-299')   // the most frequent is shown, however it sorts
})
it('counts values that flatten alike as one, their frequencies summed', …)
it('leaves the gates the whole vocabulary', …) // summariseGraph(...).vocabulary.owners has 300
```

`tests/unit/ask-commentary.test.ts` gains: an owner outside the 30 printed, and not
witnessed by a tool, is dropped from the commentary; one inside the 30 is kept.

- [ ] **Step 2: The cap only where the note puts it (passes once Step 4 is in)**

`tests/unit/summary-cap.test.ts` also holds: the Architect's summary (`plan.ts:1297`) of a
repository of 300 owners still lists all 300, and so does `init`'s: `formatSummary` without
`counts` caps nothing.

- [ ] **Step 3: `pnpm demo:backstage` (fails: no script)**

`tests/unit/package-scripts.test.ts` (it already holds two of `package.json`'s scripts)
expects `demo:backstage` to be `node scripts/demo-backstage.mjs`, and `scripts/smoke.mjs` to
run that script. The script: refuses to start
without type stripping (`process.features.typescript` falsy, which it is on Node 22.0 to
22.9, where the property does not exist, and on 22.10 to 22.17 without the flag: "needs Node
22.18 or later"); starts `node --disable-warning=ExperimentalWarning tools/fake-backstage.ts --port 0`
(Node 22 warns that type stripping is experimental), reads its listening line, and runs the
built binary, as `scripts/demo.mjs`'s `step` does, with `IDP_BACKSTAGE_URL` set to it and
`IDP_BACKSTAGE_TOKEN` removed from the child's environment, so an exported company token is
never sent to the fake: 1.
`relations mysql-prod-01 --impacts`, whose stdout must equal
`tests/golden/relations-demo/mysql-prod-01-impacts.txt`; 2. `show billing-api`, equal to
`tests/golden/demo-read/show-billing-api.txt`; 3. `plan --from examples/open-network.json
--repo fixtures/si-demo`, exit 0, which reads no catalogue (the fake logs no request line
across it); then stops the fake, and says so. `pnpm smoke` runs it after `pnpm demo`
(`smoke.mjs:538`), on a port the system chooses, so CI never collides on 7007. Loopback
only. `engines.node` stays `>=22` (Choices): where `process.features.typescript` is falsy,
the smoke does not run it and prints `skipped pnpm demo:backstage: it needs Node 22.18 or
later (this is <version>)`, so `pnpm smoke` and `prepack` pass on every Node `engines`
allows; CI's `node: [22, 24]` resolves to the latest of each, where it runs.
`package-scripts.test.ts` pins both branches with `process.features` stubbed.

- [ ] **Step 4: Implement**

`summariseGraph` counts each value per list as it collects it. `shownVocabulary` applies
`listed` first (flatten, dedupe, the counts of values that flatten alike summed), then, past
30, keeps the 30 most frequent (ties by value), sorts them in code-unit order as `sorted`
does, and reports `more`. `formatSummary` prints `values.join(', ')` and, when `more > 0`,
`, and K more`, and without `counts` prints every value as today. `ask.ts` passes the
counts (`:83`) and hands `checkCommentary` the shown lists, flattened as printed. `plan.ts`
and `init.ts` are unchanged. With no list over 30, every prompt is byte for byte what it was.

The documents:
- `docs/adr/0011-backstage-to-explore.md`: "Backstage to explore: one snapshot per run; the
  model's words never become a request". Context (§ 1, § 6 of the note), the decision (the
  read before the model, the same reader, the one transport, partial refused, the
  declarations repository decides), consequences (the cost per run until slice 2's cache),
  and § 15's rejected alternatives, each in a sentence.
- `docs/design.md` §3's provider schedule (`:39`) says `backstage-http` is read by the read
  commands from slice 1; §13's out-of-scope entry (`:1305`) says the provider is built for
  questions and still never decides a change, the reason it gives (the catalogue lags the
  repository) now the reason for that; §7.0's personal file gains `backstage:` and `IDP_BACKSTAGE_URL`, the token
  variable, `--backstage`, the precedence, and why `.idp-agent.yml`'s `backstage` is never
  requested.
- `README.md`: the configuration section's "once that provider exists" becomes the
  configuration, with the fake's demo as a `console` block (not a `text` block, which
  `readme-commands.test.ts` would run without a catalogue); the paragraph on catalogue
  content reaching the model provider (§ 14, decision 4); what the catalogue cannot report;
  that a token set is sent to a loopback catalogue too, so the fake's commands start with
  `env -u IDP_BACKSTAGE_TOKEN`; the roadmap row 6b marked 🚧.
- `docs/adopting-backstage.md`: the "read token for `idpa`" section in the present tense,
  with the `config.yml` line and the stderr line a person sees.
- `docs/backstage-http-brief.md`: under "Slice 1", a **Built** paragraph as slice 0 has,
  naming the six pull requests and this plan's departures: `readValue` beside an existing
  `readDocuments`; `declarationsOf` removed; the notice printed after the load, with its
  counts adding up; the overview equal from its second line; `.env.example`, SECURITY.md,
  the hostile bytes and the "declared nowhere in the catalogue this token reads" wording in
  1.5; the next page sent with its `limit` and `fields` (Backstage's cursor carries neither);
  **§ 6's row "count against `totalItems`" amended**: fewer distinct uids than announced is
  refused whether or not a uid repeated, and an item with no uid is refused; the modelled
  read always sent; the vocabulary cap at the Supervisor's and Analyst's summary only; the
  ADR numbered 0011; the contract fixture, the `question-backstage-owner` tape and the demo
  against a real catalogue moved to the Docker item.
- `docs/roadmap.md`: queue item 1 removed and the queue renumbered; the Docker item (now 1)
  gains "the first demo against a real Backstage, which closes `backstage-http` slice 1, and
  the contract fixture of the note's § 9, recorded from it"; the known items gain the
  `question-backstage-owner` tape (keyed) and one debt: an `IDP_REPO` exported in a recording
  shell still exposes a company repository to a tape, which `tests/setup/shell.ts` does not
  remove (the owner's decision of 2026-09-27: out of slice 1); the owner's decisions record
  that ADR 0010 goes to the stage-5 check and stage 8's evidence ADR takes the next free
  number; the "Updated" line names the new `main`; *Belongs elsewhere* loses
  domain-backstage-8.
- `docs/stage-8-brief.md`: its reservation of ADR 0010 becomes "the next free number".
- `docs/reviews/2026-09-23-deep-review.md`: domain-backstage-8 moves to the closed list,
  with this pull request and "a bound of 30 on each vocabulary list".
- `AGENTS.md`: "Current state" names the catalogue as a read source, the layering table's
  `context/` row names `backstage/`, and the numbers re-measured.

**Exhaustive switches:** none new. **Architecture rules:** unchanged at 19.

- [ ] **Step 5: Checks**

```bash
pnpm vitest run tests/unit/summary-cap.test.ts tests/unit/ask-commentary.test.ts \
  tests/unit/package-scripts.test.ts tests/unit/readme-commands.test.ts
pnpm vitest run tests/scenarios        # every tape replays; no digest warning on stderr
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm demo:backstage
git status --short tests/recordings tests/golden fixtures tests/invariants src/core/plan src/core/paths   # nothing
```

- [ ] **Step 6: The pull request** (after the owner's go-ahead)

```bash
git add src/context/graph/summary.ts src/agents/summary.ts src/cli/commands/ask.ts \
  scripts/demo-backstage.mjs scripts/smoke.mjs package.json tests/unit/summary-cap.test.ts \
  tests/unit/ask-commentary.test.ts tests/unit/package-scripts.test.ts \
  docs/adr/0011-backstage-to-explore.md docs/design.md README.md \
  docs/adopting-backstage.md docs/backstage-http-brief.md docs/roadmap.md docs/reviews/2026-09-23-deep-review.md \
  AGENTS.md src/context/README.md CHANGELOG.md
git commit -m "feat: bound the vocabulary a model is shown, and close backstage-http slice 1"
```

Base `feat/bhttp-1-5`. CHANGELOG, `### Added`:

> - Each vocabulary list the Supervisor and the Analyst are shown holds at most 30 values,
>   the most frequent, then "and K more"; the Architect still sees every value of the
>   declarations repository; the gates keep the whole vocabulary, the demo's prompts and every tape are
>   unchanged, and the commentary check is handed the lists as shown (review
>   domain-backstage-8). `pnpm demo:backstage` runs the README's relations against the fake
>   Backstage; ADR-0011 records why the catalogue is read once per run, before any model; the
>   design, the README and the adopting page describe the provider as built, and slice 1 of
>   `backstage-http` is closed ([#92](https://github.com/pcaboor/idp-agent/pull/92)).

**What the owner can run** (after `pnpm build`):

```bash
pnpm demo:backstage      # the script removes IDP_BACKSTAGE_TOKEN from what it runs
# 1. What breaks if mysql-prod-01 fails, read from a Backstage
#    $ IDP_BACKSTAGE_URL=http://127.0.0.1:<port>/api/catalog node dist/cli/bin.js relations mysql-prod-01 --impacts
#    the notice, the Group line, then the README's table          (exit 0)
# 2. show billing-api, from the same catalogue                   (exit 0)
# 3. A change is decided against the repository: plan --from …   (exit 0; the fake saw no request)
# Done. No model, no key; the fake Backstage is stopped.
pnpm vitest run tests/unit/summary-cap.test.ts
# every test passes; the demo's summary is byte for byte tests/golden/demo-read/summary.txt
```

**The closing demo against a real Backstage** — the note's "Closed by 1.6: the same command
against the owner's Backstage" — is deferred to the next queue item, *A real Backstage in
Docker, for the demo*: it needs a running Backstage, which this slice neither installs nor
tests against (the offline floor, and the owner's decision that installing one is out of the
tool's scope). That item runs `IDP_BACKSTAGE_URL=<its base> IDP_BACKSTAGE_TOKEN=<its read
token> idpa relations mysql-prod-01 --impacts` against a pinned Backstage holding the demo
SI and expects the table above; it also records the note's contract fixture from that
Backstage. The owner's company Backstage, and the facts of § 14 it answers (the facets by
kind and namespace, the version, SSO or an identity-aware proxy), come after it.

---

## Done when

- `IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog idpa relations mysql-prod-01 --impacts`
  against `tools/fake-backstage.ts` prints the README's table, and `pnpm demo:backstage` runs
  it in CI through `pnpm smoke`.
- `graph`, `show` and `relations` over the demo SI served by a catalogue print what `--demo`
  prints, byte for byte; the overview from its second line.
- The token is sent by one function, to the configured origin and two routes, in one header,
  with `redirect: 'error'`; it reaches no model provider, no MLflow server, no child process,
  no trace and no output, on every provider, on both roads, and when the catalogue answers
  401, 403, 500 or echoes it (`tests/contract/key-reach.test.ts`).
- The catalogue is read once per run, before any model, every page with its `limit` and
  `fields`; a partial read — fewer distinct uids than announced, repeats or not — ends the
  run on exit 1 with nothing on stdout; a misconfiguration is exit 2 before any request, and
  a refused URL is quoted with no userinfo, query or fragment.
- No C0, DEL or C1 byte a catalogue serves reaches stdout or stderr, and a recording never
  reads a catalogue.
- A change is decided against the declarations repository alone, and an owner only the
  catalogue holds is asked, never vouched for.
- `tests/recordings/`, `tests/golden/`, `fixtures/si-demo/`, `tests/invariants/`,
  `src/core/plan/` and `src/core/paths/` are unchanged across the six pull requests.
- `pnpm test` still needs no key, no network and no Docker; nineteen architecture rules hold.

Slice 2 makes a large catalogue cheap (the cache) and a partial graph a stated state rather
than a refusal; slice 3 reads Groups, Users, Systems and Domains. Neither changes what this
slice guarantees: **Backstage answers questions; the declarations repository decides
changes.**
