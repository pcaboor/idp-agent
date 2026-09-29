# `backstage-http` slice 3 — the organisation in the read model

**Status: 3.1 built** ([#99](https://github.com/pcaboor/idp-agent/pull/99)), **3.2 built**
([#100](https://github.com/pcaboor/idp-agent/pull/100)), **3.3 built**
([#101](https://github.com/pcaboor/idp-agent/pull/101)): the slice's code is done. Three
stacked pull requests, 3.1 to 3.3, and one owner step after them (the keyed recordings),
which is what is left. The
owner's answers to the three questions are [below](#questions-for-the-owner), settled on
2026-09-28.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

**Goal.** Backstage's Group, User, System and Domain become read-only nodes of the graph, read
the same way from a declarations repository's files and from a catalogue: `show` prints a
team, a person, a system and a domain; `relations` walks ownership, membership and system
membership, both directions, bounded, each row with its whole path; the overview counts them;
and the Analyst reads them with the tools it has, under the same caps, so that "what does team
tiger own?" and "which system is billing-api in?" are answered with witnessed Group and System
nodes. None of them is ever proposed, and nothing read from one reaches a plan's signature,
policies, owner derivation, re-check errors or Reviewer.

**The design** is [`docs/backstage-http-brief.md`](../backstage-http-brief.md), § 13 slice 3,
with § 5 (translation), § 6 (the bounds), § 11 (what each agent gains) and § 14. Slice 1 is
built ([`backstage-http-slice-1.md`](backstage-http-slice-1.md), #92 to #98). Every file,
function and line named below was read on `main` at `f8bcb43`; the section
[Where the code moved since the note](#where-the-code-moved-since-the-note) says where the
note's assumptions no longer hold, and one of the task's premises that does not.

**Architecture.** From the inside out, as slice 1 went. **3.1, the nodes:** four read schemas
beside `apiSchema` in `core/`, a sixth reading of `readValue`, so a Group file and a Group
served by a catalogue meet one reader; the catalogue's load gains an organisation read of the
fields the read model reads; `EntityGraph` holds the organisation in an index of its own,
**never in `all()`**, and its dangling references in a list of their own, **never in
`danglingReferences()` nor in `unresolvedOf(ref)` read with no field**, so every summary,
table, gate, tool result and prompt built from those is unchanged; `show` and the overview
print them. A reference to an organisation kind is called declared nowhere only where a
catalogue read that kind whole: a declarations repository's Group files are what it happens
to hold, not the organisation. **3.2, the relations:** six walks over ownership, membership
and system membership, on `idpa relations`, no model. **3.3, the Analyst:** its tools read the
organisation, and only when the source holds one, so every existing prompt keeps its bytes.
**Owner step R:** the three keyed recordings.

**Tech stack.** TypeScript 7, Node 22+ (the fake needs 22.18+ for type stripping), Vitest 5,
Zod 4, `yaml` 2. No new dependency.

**Branches.** `feat/bhttp-3-1` (this worktree, from `main` at `f8bcb43`), `feat/bhttp-3-2`,
`feat/bhttp-3-3`, each cut from the one before, one pull request each, merged bottom-up with
`--rebase`. This plan is committed with 3.1, and its boxes are ticked by the pull request that
does each step. Pull request numbers below are written `#N`: the next free one is #99.

**Why three pull requests, not the note's two.** The note's item 1 is here 3.1 and 3.2, and
its item 2 is 3.3. Item 1 as one pull request would change the shared reader (which
`validate` and the write side's re-check read), the catalogue's load, the graph, two renderers,
the relations engine, the demo's organisation data and two demos at once: over 2,000 lines
with their tests, three reviews in one. 3.1 is the reading and what `show` and the overview
say of it, and is where the doctrine is decided (what a Group file does to `validate`, to a
plan, to a prompt); 3.2 is the walks, the product's core ("relations are the value"), which
touch no reader and no prompt and deserve a review of their own; 3.3 is the only one that
changes what a model can be sent. The note's closing sentence ("Closed by 3.2") becomes
"Closed by 3.3" in the **Built** paragraph 3.3 writes.

## Global Constraints

Inherited and still binding: `AGENTS.md`, `docs/design.md` §4, the note's § 4, § 5, § 6 and
§ 8, and slice 1's Global Constraints. Every task carries all of them; a task that cannot is
stopped and brought to the owner.

- **`pnpm test` needs no key, no network and no Docker.** No test opens a socket; the
  catalogue is `tests/support/fake-backstage.ts`, handed in as `catalogueFetch`.
- **Read-only, and never proposed.** Group, User, System and Domain get read schemas and no
  proposal schema: `src/core/schemas/plan.ts`, the `propose` tool
  (`src/agents/tools/propose-tool.ts`), the write schemas and `tests/golden/architect-tools.json`
  do not change. `git diff main -- src/core/schemas/plan.ts src/agents/tools/propose-tool.ts
  tests/golden/architect-tools.json` prints nothing at the end of every task.
- **Nothing read from the organisation reaches a plan.** The plan road's graph (`graphOf`,
  `src/cli/commands/plan.ts:210-221`) takes an organisation document as it takes one today:
  a reference that resolves, in `aside`, never a node — the document read and the document
  set aside alike, so a `dependsOn` naming a System that Backstage would refuse resolves as
  it did (`plan-intent.test.ts:265-330`, a spec-less System whose `dangling references: 0` is asserted at `:327`, stays green unchanged). The
  vocabulary a signature reads, the owners `deriveOwners` reads, the policies' contexts, the
  re-check's **errors** (what refuses a plan, and what `repair.ts:620-630` sends the
  Architect) and the Reviewer see exactly what they see on `f8bcb43` for the same
  repository: **an organisation document is never an error** (Choices), so no fault read
  from one can become the plan's through `attribute` (`recheck.ts:157-178`). What does move
  on the plan road is warnings: a Group, User, System or Domain document that is read no
  longer yields a `not-modelled` warning, so `plan`'s standing line (`plan.ts:377-389`),
  its warning lines for a file it edits (`:646`) and `plan --json`'s `recheck.standing`
  (`:519`) count fewer; one set aside because Backstage would refuse it is still that
  warning, its message saying why (3.1, "What changes that a person sees"). **Group nodes do
  not change the owner derivation**: an owner is still derived from the consumers'
  declarations, and a Group declared in the repository vouches for nothing a proposal names
  (3.1 proves both).
- **Every existing tape replays with the bytes it had.** Not only "no new warning": the
  question tapes' Analyst turns already warn today (measured on `f8bcb43`:
  `question-prod-databases` analyst turns 0–1, `question-consumers-of-billing-db` 0–2,
  `question-unanswerable-ranking` 0–3, `mutation-classified-link` supervisor turn 0 — the
  roadmap's "Recordings that need the owner's key"), so a further change to those turns would
  pass unseen. 3.1 therefore pins the request digest of every turn of the four question-mode
  tapes, measured on `f8bcb43` (`tests/scenarios/prompt-digests.test.ts`), and
  `plan-mode.test.ts` already fails on any warning of its five. Both stay green through 3.3.
- **`fixtures/si-demo/` is untouched**, and so is every file under `tests/golden/` but the
  one new folder `tests/golden/organisation/` (3.1) and the new relations goldens of 3.2; the
  digest of `tests/golden/backstage-apis` in `read-value.test.ts` changes in 3.1, because it
  holds a Group (`org/teams.yml`), and the commit says so. No output over
  `tests/golden/backstage-apis` other than its `not loaded:` line moves (3.1 pins `graph`'s
  dangling list and the `show api:default/payments` card over it).
- **The organisation never widens a prompt that exists.** Whatever the source, nothing in
  3.1 or 3.2 changes what a model is sent: the organisation is out of `all()`, and its
  dangling references are out of `danglingReferences()` and out of `unresolvedOf(ref)` read
  with no field — which is what the summary's count (`context/graph/summary.ts:63`), the
  Analyst's rows' `danglingReferences` and `declaredNowhere` (`graph-tools.ts:442-443`) and
  `ask`'s `known` (`ask.ts:265`) read. 3.1 proves it over a source that holds an
  organisation and judges it, not only over the tapes' (Step 7). 3.3 adds to the
  Supervisor's and the Analyst's prompts only when the graph holds at least one organisation
  node, which no tape's source does, and leaves an entity's row as it is.
- **Hands off the owner's stage-5 work.** `tests/invariants/arbitraries.ts` and
  `tests/invariants/core.test.ts` are not touched; no task touches `src/core/plan/` or
  `src/core/paths/`.
- **Nothing read from a catalogue reaches a committed file**, as in slice 1: the new
  goldens and contract fixture come from this repository's own fixtures and demo data.
- **Traceability.** Every pull request adds its line under `## Unreleased` in `CHANGELOG.md`
  and re-measures the numbers `AGENTS.md` states (the test count, also on the README's badge,
  and the architecture-rule count, which no task here changes) in the same commit. 3.3 moves
  slice 3 out of `docs/roadmap.md`'s queue, adds its recordings to "Recordings that need the
  owner's key", and marks the note's slice 3 **Built**.
- **Each pull request is green on its own**: `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm smoke`. The suite leaves temp directories behind and the disk was at 96 % when this
  plan was written: `df -h "$TMPDIR"` before a test-heavy step.
- **Standing rules.** No commit, push or pull request without the owner's go-ahead. Work in
  `~/Documents/idp-agent-worktrees/bhttp3`, stage files by name, never `git add -A`. English
  throughout, Conventional Commits, and no `switch` on a closed union without
  `const exhaustive: never = value` in `default`.
- **"What the owner can run"** ends every task, keyless, run and checked by whoever executes
  the task before it is handed over (the owner's kit lives in `~/Documents/idp-agent-tests/`).

---

## Where the code moved since the note

The note cites `main` at `44fcfed`; slice 1's plan reconciled it with `60974de`. `main` is at
`f8bcb43`. Each row is an assumption — the note's, or the task's — checked against the
worktree, and what this plan does about it.

| # | The assumption | On `f8bcb43` | This plan |
|---|---|---|---|
| 1 | The task: "billing-api's `spec.system` lives in `fixtures/si-demo`" | **It does not.** No file of `fixtures/si-demo/` holds `system` (`grep -rn system fixtures/si-demo` prints nothing); `components/billing-api.yml` declares type, lifecycle and owner only, and `tests/golden/demo-read/overview.txt` says `systems  none declared` | "Which system is billing-api in?" cannot be answered "billing" from the demo SI, and the demo SI must not change. A System in the demo's organisation data would not help: Backstage's `partOf` edge is emitted from the **Component's** `spec.system` (`BuiltinKindsEntityProcessor.ts`, below), and a System lists no members. So the question is demonstrated on a catalogue of its own, `tests/golden/organisation/`, where billing-api declares `system: billing`, served by the fake with `--root` and read as files with `--repo` (3.1). Against the demo SI the same question has a true answer, "billing-api declares no system", and 3.2's `--part-of` gives it |
| 2 | § 13: the four kinds "read whole from here on, with the byte bounds of § 6" | Every kind but Component, Resource and API is read as refs (`REFS_FIELDS`, `src/context/backstage/load.ts:56`, `kind,metadata.namespace,metadata.name,metadata.uid`), for § 5's reason: some organisation providers store a profile picture in every User as a data URI | Read whole **for what the read model reads, and nothing else**: a third read, of the four kinds, sent with `fields=apiVersion,kind,metadata.name,metadata.namespace,metadata.uid,spec.type,spec.parent,spec.children,spec.members,spec.memberOf,spec.owner,spec.domain,spec.subdomainOf`. Not `metadata` whole: organisation providers put personal data in it — Backstage's Microsoft Graph provider sets `microsoft.com/email` and `graph.microsoft.com/user-id` annotations on every User (`plugins/catalog-backend-module-msgraph/src/microsoftGraph/defaultTransformers.ts`, `defaultUserTransformer`, read 2026-09-28) — and it is most of a User's bytes. So `spec.profile` (display name, email, picture), the annotations, labels, description and title never cross the wire, and the read schemas read the same fields from a file, naming the rest on `not read:` (Choices) |
| 3 | § 9 and § 3: the fake serves "the demo SI with three Groups" | `tools/fake-backstage.ts:328` serves tiger, elephant and dodowarriors; the demo SI's owners are common ×13, tiger ×14, dodowarriors ×5, elephant ×1; `tools/backstage/org.yaml` holds all four | With owners judged against the Groups a catalogue serves (3.1), the fake's missing `common` would make 13 owners declared nowhere on every `show` against `pnpm demo:backstage`. The fake serves `tools/backstage/org.yaml`'s documents instead of a list of its own, so the fake and the Docker Backstage hold one organisation |
| 4 | § 11: "`query` and `related` on the new kinds" | The Analyst's tools are `search_entities`, `get_entity`, `get_dependencies`, `get_relations`, `get_apis` and `answer` (`src/agents/tools/graph-tools.ts:564-640`) | `query` is `search_entities` and `get_entity`; `related` is `get_relations`. Both widen in 3.3, on a registry of their own when the graph holds an organisation |
| 5 | § 5: an owner "is a string until slice 3"; `EntityGraph` resolves only `dependsOn`, `dependencyOf` and `providesApis` | `DeclaredField` (`src/context/graph/entity-graph.ts:35`) has those three; `unresolvedOf(ref)` with no field returns all of them (`:285-288`) and the Analyst's rows read it so (`graph-tools.ts:442`); the reader normalises an owner to `group:`/`user:` in full (`src/core/schemas/entity.ts:77-84`, `:191`); `search({ owner })` compares the string (`entity-graph.ts:195`) | `DeclaredField` **does not change**. The organisation's fields are `OrganisationField`, kept in their own list and read only by name (`unresolvedOrganisationOf(ref, field)`), and a reference to an organisation kind is judged only where a catalogue read that kind (Choices) |
| 6 | § 13: "An owner naming no Group is shown as dangling" | Read literally, every owner of the demo SI, of every tape's source and of `tests/golden/backstage-apis` (four owners `group:default/lion`, one Group file, `org/teams.yml`) would become dangling | The rule of row 5. On the catalogue road an owner naming no Group the catalogue serves is shown as declared nowhere, in the note's words for a Backstage source ("declared nowhere in the catalogue this token reads", § 5). On the file road it is never judged: the demo SI holds no Group, `backstage-apis` holds one, and neither is the organisation, so no output of `--demo`, of the README's first screen, of `backstage-apis` or of any tape moves |
| 7 | AGENTS.md's invariants and design §4.1: a Group, a System "is set aside and *said* to be" (`AGENTS.md:283-287`, `docs/design.md:118-119`, `:309-317`) | The same | 3.1 rewrites those sentences: the four kinds are read, as the API is; one Backstage would refuse is still set aside and said to be; Location, Template and kinds of other tools stay set aside |
| 8 | The Docker demo holds four Groups and three Locations | `scripts/demo-backstage-docker.mjs:123` expects `{ Group: 4, Location: 3 }`; `tools/backstage/app-config.yaml` allows the organisation location `[Group]`; `tests/unit/demo-backstage.test.ts:125-131` holds both | 3.1 updates all three for the organisation data below |
| 9 | § 14, decision 3: "a read-only widening of the read schemas in slice 3" if the owner's catalogue sets many Components aside | The facts about the owner's catalogue are still to gather (§ 14) | Not done here: nothing shows it is needed, and the brief makes it conditional. Said in the roadmap line 3.3 writes |
| 10 | § 9: "one new tape, `question-backstage-owner`" | Not recorded (`docs/roadmap.md:296-303`); no scenario names it | Recorded with this slice's two, in owner step R, one command each |
| 11 | `graph --kind` | Refuses anything but Component, Resource and API (`src/cli/index.ts:459-462`); `graph` lists `graph.search()`, over `all()` | Unchanged. Organisation nodes are not in `all()`, so `graph` lists exactly what it lists today, over every source, and its dangling list is `danglingReferences()`, unchanged; a Group is read with `show`, a team's list with `relations` |
| 12 | The Backstage facts of § 5 | Read on backstage/backstage master, 2026-09-28: `packages/catalog-model/src/schema/kinds/{Group,User,System,Domain}.v1alpha1.schema.json` and `plugins/catalog-backend/src/processors/BuiltinKindsEntityProcessor.ts` | Group: `spec.type` and `spec.children` required (children may be empty), `parent` and `members` optional; User: `spec.memberOf` required (may be empty), `profile` optional; System: `spec.owner` required, `domain` and `type` optional; Domain: `spec.owner` required, `subdomainOf` and `type` optional; each under `backstage.io/v1alpha1` or `v1beta1`. The processor's default kinds: `parent`, `children`, `memberOf` and `owner` → Group; `members` → User; `system` → System; `domain` and `subdomainOf` → Domain. It emits `parentOf`/`childOf` from **both** `parent` and `children`, and `hasMember`/`memberOf` from **both** `members` and `memberOf`: one fact written on either side, which is design §4.1's "a declaration is read from both ends" |
| 13 | A User's name is not personal data | The Microsoft Graph provider names a User `normalizeEntityName(user.mail)` (`helper.ts`: lower case, every character outside `[a-zA-Z0-9_.-]` made `_`), so `ada.lovelace@acme.com` is the User `ada.lovelace_acme.com` | Reading Users at all reads such names; nothing narrower is possible short of not reading Users. Question 2 says so |

Nothing on the list reopens a decision of § 14.

## Choices this plan makes where the note leaves one

- **The organisation is an index of the graph, not part of `all()`.** `LoadResult` gains
  `organisation?: OrganisationEntity[]` beside `entities` (optional, absent is none, as
  `unread?` is, so no `LoadResult` literal of a test moves), and `EntityGraph.from(entities,
  aside, organisation?: OrganisationRead)` indexes it; `all()`, `get()`, `search()` stay the
  Components, Resources and APIs they are. Everything built from `all()` — `graph`'s table,
  the summary's buckets and vocabulary, the overview's kinds, types and owners, the
  commentary check's entities, `unusedCriteria` — is unchanged by an organisation, and each
  place that should see one is changed on purpose: `node(ref)` and `nodes()` read both,
  `show` and `relations` resolve through them, the overview counts them apart. Widening
  `CatalogueEntity` instead would have put a Group, which has no owner and no environment,
  into every row, table and vocabulary list at once, and moved the Supervisor's prompt on
  every catalogue.
- **An organisation reference is judged only where a catalogue read its kind whole.**
  `OrganisationRead` is `{ nodes, judged }`, `judged` the organisation kinds whose read is
  known to be whole: on the catalogue road, the kinds among the four the facets named, which
  the organisation read then read to the end or failed the load (`BackstageProvider` sets
  `LoadResult.judged`); on the file road, none (`FixtureProvider` and `IacFsProvider` leave it
  absent). A reference is judged by its own kind: an owner `group:…` when Groups are judged,
  `user:…` when Users are, a `spec.system` when Systems are, `domain` and `subdomainOf` when
  Domains are, `memberOf`, `parent` and `children` when Groups are, `members` when Users are.
  A judged reference **resolves against the organisation index and `aside` both** — a Group
  of another namespace, one named in upper case, one Backstage would refuse, are set aside
  with their ref (`index.ts:1368-1371`), and a reference to one is "in the catalogue, not
  read", as `entity-graph.ts:143` treats `aside` today, never declared nowhere — and names
  nothing only when neither holds it: it is then declared nowhere, in the words of § 5 for a
  Backstage source. An unjudged reference is what it is today: a name, resolved when a node
  carries it, never dangling. Why not "dangling whenever nothing declares it": a source that
  holds no Group — the demo SI, a catalogue whose token is not allowed to read Users — says
  nothing about which Groups exist, and a declarations repository that keeps a few Group
  files (the shape `rules.ts:189-192` describes, and perhaps the owner's IaC:
  `tests/golden/backstage-apis` keeps one Group, `tiger`, beside four owners
  `group:default/lion`) says as little: a partial set of Group files is not the
  organisation. Only a catalogue's read is whole by construction (slice 1's `totalItems`
  and uid count), and even then only "as this token reads it", which is why the wording
  says so.
- **The organisation's dangling references are a list of their own.** `DeclaredField`,
  `Unresolved`, `danglingReferences()` and `unresolvedOf(ref, field?)` do not change: they
  are the write model's three fields, which `validate`, the summary, `graph`'s list, the
  overview's dangling section, the Analyst's rows and `ask`'s `known` read. The
  organisation's are `OrganisationField` and `unresolvedOrganisationOf(ref, field)`, the
  field required, read by the places that show the organisation: `show`'s owner and system
  lines and the organisation's cards (3.1), `relations`' path ends (3.2), the Analyst's
  organisation rows (3.3). Until 3.3 decides what the Analyst is told, no count a model or a
  table reads moves.
- **Membership is read from both ends**, as `dependsOn` and `dependencyOf` are: a Group's
  `children` and a child's `parent` are one edge, a Group's `members` and a User's `memberOf`
  another; either side declaring it is enough, and each side naming nothing is its own
  dangling reference where judged. A System's membership is its members' `spec.system`, a
  Domain's is its Systems' `spec.domain` and its subdomains' `subdomainOf`, as Backstage
  emits them.
- **The four read schemas follow `apiSchema`**, not `entitySchema`: what Backstage requires of
  the kind is required (row 12), references are normalised with the processor's default kinds
  and the entity's namespace (`qualifiedSpec`'s rules), a reference the grammar cannot split
  is kept as written, and three documents are set aside rather than read, for `unreadApi`'s
  three reasons (another tool's apiVersion, a namespace other than `default`, a name in upper
  case). `unreadApi` becomes `unreadReadKind`, one rule for the five read-only kinds. Their
  `metadata` is `name` and `namespace` alone (`organisationMetadataSchema`), and their `spec`
  the fields row 2 asks for: what a file holds beyond them — a title, a description,
  annotations, a profile — is what `unreadFieldsOf` names on `not read:`, as an API's unread
  keys are, and a catalogue that ignores `fields` is read the same — the reader drops what it
  serves beyond them and names it on `unread` — but for a User's or a Group's `spec.profile`,
  which the pre-pass drops first, so a served profile never reaches the reader (the owner's
  decision 2; a file's is named on `not read:` and kept nowhere).
- **An organisation document Backstage would refuse is set aside, never refused.** This is
  where the four kinds part from the API. A Group without `children`, a User without
  `memberOf`, a System or a Domain without an `owner` is read as the document set aside today
  is: its ref kept (into `aside`, so a reference to it resolves on every road, the plan's
  included), a `not-modelled` warning in `validate` whose message says why (`Group tiger is
  not read: spec.children: …, which Backstage requires`), counted on the `not loaded:` line.
  Never `invalid-entity`, never a rejection. Three reasons, each from the code: the comment
  at `rules.ts:189-192` ("a repository that is also the company's catalogue declares Groups
  and Systems beside the entities this tool manages, and a red build there would push people
  to move them out — or to delete them"); the re-check makes any violation anchored in a file
  a plan edits into the plan's (`recheck.ts:18-26`, `:172-173`), so an error there would
  refuse a plan over a Group the Architect cannot touch and send it `invalid-entity at
  <file>` as a repair report (`repair.ts:620-630`), the failure `recheck.ts`'s header says
  was fixed; and `init` reads `parseDocuments(…).rejections` as the reasons a service's
  `catalog-info.yaml` cannot be previewed (`init.ts:522`, `:749`), which a System beside a
  Component would then join. An API is refused because the repository's own team declares it
  beside the service; a Group or a System is usually another team's.
- **A Group, User, System or Domain file in a declarations repository**, read: counted among
  `validate`'s entities (as an API is), no warning; its ref joins `checkRepository`'s `aside`
  (`rules.ts:150-163`), not `declared`, so a reference to it resolves as it did when it was
  set aside, and **no rule reads it**: no `duplicate-name` for two Groups of one name (the
  catalogue settles that, first location wins, and an error there could refuse a plan), no
  `dangling-reference` for an owner or a membership naming nothing (`referencesOf`,
  `:123-127`, is unchanged, because the re-check reads the same rules). `RepositoryFile`
  gains `organisation?`, optional, so the write side's fixtures (`recheck.test.ts`,
  `repair.test.ts`) do not move. `graph`, `show` and the read commands over such a
  repository: the Group is a node `show` prints and `relations` walks, an owner naming one
  resolves to it, one naming none is a name as today, and the `not loaded:` line no longer
  counts it. `init` is unchanged: an organisation document is never among `rejections`.
  Question 1 asks the owner to confirm on the IaC.
- **What a User carries.** Its name, its namespace, and `spec.memberOf`. Nothing of
  `metadata` beyond the name — no annotation, no title, no label — and no `spec.profile`
  (display name, email, picture): no answer this slice builds needs them, a picture can be a
  data URI of any size, and an email, an employee id or a directory id is personal data a
  model has no use for. None is requested from a catalogue (row 2); a server that ignores
  `fields` and serves them anyway has the profile dropped by the pre-pass, before the reader,
  and the rest dropped by the reader and named on `unread`; a file holding them has them named
  on `not read:`; none is kept anywhere. So what
  reaches a model provider of a person, once the Analyst reads the organisation (3.3), is
  the User's name and its groups — and a name can be an email in disguise (row 13). SECURITY.md
  says so in 3.3 (question 2, settled).
- **The organisation read's ceiling is its own**: `organisationEntities: 200_000`, beside
  `modelledEntities` and `otherRefs`, since Users are most of a company catalogue. Refused
  past it as every ceiling is, with the scope named ("Groups, Users, Systems and Domains").
  The byte bounds are § 6's, unchanged. At row 2's fields a User shaped as the Microsoft
  Graph provider writes one, in two groups, is 260 bytes of JSON, against 138 for today's
  refs read and 804 whole without a picture (measured on a hand-built item; on the recorded
  Backstage 1.55.2 page, Step 9, a User in one group with a short name is 175 to 178 bytes
  of compact JSON, uid included, and a Group 185 to 239): 200,000 Users are about 50 MiB, where
  the refs read spent about 26 MiB and a whole read about 153 MiB before any picture, under
  the 256 MiB a run may read (`limits.ts`). A catalogue that loads on `f8bcb43` at the
  ceiling still loads.
- **The organisation read is sent only when the facets name one of the four kinds.** A
  catalogue with none — the fake with `--no-org`, the equivalence tests — sends exactly the
  requests it sends today, and its request log is unchanged. It asks for no annotation, so an
  organisation node has no `managed-by-location` and `catalogueOrder` puts it by ref; every
  list the organisation index answers is sorted by ref, so the order never shows.
- **The notice counts the organisation as read.** "N entities: M read, K not modelled": M is
  the entities and the organisation nodes the graph holds. A Location stays not modelled.
- **`show` resolves an entity first.** `resolveNode`: a reference to an entity, then a
  reference to an organisation node, then the entities of exactly that name (one: it;
  several: ambiguous among them, as today), and only when **no entity** carries the name, the
  organisation nodes of that name, then candidates — the entities' as today, and, when none,
  the organisation's, that list bounded at 25 and `+N more`. So a System `billing` beside a
  Component `billing`, or a Group named after its service, never turns a `show` or a
  `relations` that finds an entity today into an ambiguity, and a catalogue cannot shadow a
  Component with a User of its name; the System is `show system:default/billing`.
- **`show` on an organisation node** prints a card of its own (`cli/render/organisation.ts`),
  laid out as an entity's is: header lines, then sections, each "none" when empty, a
  reference naming nothing marked as `nowhere` marks one. **Every list on it** — `owns`,
  `members`, `children`, `member of`, `contains`, `systems` — is bounded at 25 rows, then
  `+N more`, since an all-staff Group has thousands of members; the relation (3.2) lists
  them. A Component's, Resource's or API's card changes only where a judged reference names
  nothing: its `owner` or `system` line then carries the mark after the value.
- **Organisation relations are their own list.** `ORGANISATION_RELATIONS` (`owns`,
  `owned-by`, `member-of`, `has-member`, `part-of`, `has-part`, Backstage's own relation
  names) sits beside `RELATIONS`, which does not change, so neither does the Analyst's
  `get_relations` schema, the `answer` schema or `idpa relations`' overview of an entity. They
  are flags of `idpa relations` (3.2), and `relations <org node>` with no flag prints the ones
  that apply to its kind.
- **The Analyst's organisation registry is chosen by the graph** (`buildTools(graph, { apis:
  true, organisation: graph.holdsOrganisation })`), as slice 4 will add the Architect's
  catalogue tool only when a Backstage is configured (the note's § 13, 4.2): without an
  organisation, specs, system prompt and summary are byte for byte `f8bcb43`'s.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/core/schemas/entity.ts` *(edit)* | 3.1 | `groupSchema`, `userSchema`, `systemSchema`, `domainSchema`, `organisationSchema`, `organisationMetadataSchema`, `ORGANISATION_KINDS`, `OrganisationEntity`, `GraphNode`; their shapes for `unreadFieldsOf` |
| `src/core/yaml/serialize.ts` *(edit)* | 3.1 | `readValue`'s `organisation` reading, and the refused organisation document set aside with its ref; `parseDocuments`' `organisation` list; `unreadReadKind` |
| `src/core/validate/rules.ts`, `src/cli/commands/validate.ts` *(edit)* | 3.1 | `RepositoryFile.organisation?`; counted, in `aside`; no rule reads it |
| `src/context/iac-fs/snapshot.ts`, `src/context/iac-fs/provider.ts`, `src/context/fixtures/index.ts` *(edit)* | 3.1 | the file road fills `organisation`, never `judged` |
| `src/context/provider.ts` *(edit)* | 3.1 | `LoadResult.organisation?`, `LoadResult.judged?` |
| `src/context/backstage/limits.ts`, `load.ts`, `provider.ts`, `transport.ts` *(edit)* | 3.1 | the organisation read, its fields and ceiling; `judged`; the read scope of `too-many` and `unasked-kind` |
| `src/context/graph/entity-graph.ts` *(edit)* | 3.1 | the organisation index, `node`, `nodes`, the judged-kind rule, `OrganisationField` and its own dangling list |
| `src/context/graph/overview.ts`, `src/cli/render/overview.ts` *(edit)* | 3.1 | the organisation's counts |
| `src/cli/render/organisation.ts` | 3.1 | the card of a Group, a User, a System, a Domain |
| `src/cli/render/entity.ts`, `src/cli/commands/show.ts` *(edit)* | 3.1 | a judged owner or system naming nothing; `resolveNode`, entities first |
| `src/cli/commands/plan.ts` *(edit)* | 3.1 | `graphOf`: the organisation's references in `aside`, as today's set-aside ones |
| `src/cli/index.ts` *(edit)* | 3.1, 3.2 | the graph built with the organisation; the notice's count; the empty-source line; the trace's `idp.source.*`; the relation flags |
| `tools/fake-backstage.ts`, `tools/backstage/org.yaml`, `tools/backstage/app-config.yaml`, `scripts/demo-backstage-docker.mjs` *(edit)* | 3.1 | one organisation for the fake and the Docker Backstage |
| `scripts/smoke.mjs` *(edit)* | 3.1 | a Group file beside the demo SI is read; the fake's notice |
| `tests/golden/organisation/` | 3.1 | a small catalogue in which a service declares its system |
| `tests/scenarios/prompt-digests.test.ts` | 3.1 | every question-mode turn's request digest, pinned on `f8bcb43` |
| `src/core/schemas/query.ts` *(edit)* | 3.2, 3.3 | `ORGANISATION_RELATIONS`; then the organisation search, relations and answer schemas |
| `src/context/graph/relations.ts` *(edit)* | 3.2 | the walks generalised to a `GraphNode`; the six organisation walks |
| `src/cli/commands/relations.ts`, `src/cli/render/relations.ts`, `src/cli/usage.ts` *(edit)* | 3.2 | the flags, the overview of an organisation node, the steps of a Group |
| `src/agents/tools/graph-tools.ts`, `src/agents/analyst.ts`, `src/agents/summary.ts`, `src/context/graph/summary.ts` *(edit)* | 3.3 | the organisation registry, its rows, its paragraph, the summary's one line |
| `src/cli/commands/ask.ts` *(edit)* | 3.3 | organisation nodes in an answer's block and in the commentary check |
| `tests/scenarios/backstage-mode.test.ts` + three tapes | R | the keyed recordings |

---

### Task 3.1: Group, User, System and Domain as read-only nodes

**Goal.** The four kinds are read — from a file and from a catalogue, through `readValue` —
into an index of the graph beside the entities; `show` prints them, the overview counts them,
and an owner or a system naming nothing is shown as declared nowhere where a catalogue read
that kind. Nothing a model is sent, no error a plan can meet, and no output of the demo SI
moves.

**Files:**
- Modify: `src/core/schemas/entity.ts`, `src/core/yaml/serialize.ts`, `src/core/README.md`
- Modify: `src/core/validate/rules.ts`, `src/cli/commands/validate.ts`
- Modify: `src/context/provider.ts`, `src/context/fixtures/index.ts`,
  `src/context/iac-fs/snapshot.ts:97-99` (an unreadable file holds no organisation),
  `src/context/iac-fs/provider.ts`, `src/context/README.md`
- Modify: `src/context/backstage/translate.ts` (the pre-pass drops a User's and a Group's
  `spec.profile`, the owner's decision 2)
- Modify: `src/context/backstage/limits.ts`, `load.ts`, `provider.ts`,
  `transport.ts:79` and `:83` (`ReadScope = 'modelled' | 'organisation' | 'refs'`, the one
  type both failures take; `unasked-kind`'s sentence names no scope and does not change) and
  `:141-146` (`too-many`'s words for the new scope)
- Modify: `src/context/graph/entity-graph.ts`, `src/context/graph/overview.ts`
- Create: `src/cli/render/organisation.ts`
- Modify: `src/cli/render/entity.ts`, `src/cli/render/overview.ts`, `src/cli/commands/show.ts`,
  `src/cli/commands/plan.ts:210-221`, `src/cli/index.ts` (`:1296-1376`, and
  `sourceAttributes`, `:1586-1597`), `src/cli/README.md`
- Modify: `tools/fake-backstage.ts`, `tools/backstage/org.yaml`, `tools/backstage/app-config.yaml`,
  `tools/backstage/README.md`, `scripts/demo-backstage-docker.mjs`, `scripts/smoke.mjs`
  (`:517-532`, `:601`)
- Create: `tests/golden/organisation/` (below), `tests/unit/organisation-reader.test.ts`,
  `tests/unit/organisation-graph.test.ts`, `tests/unit/organisation-show.test.ts`,
  `tests/unit/organisation-plan-road.test.ts`, `tests/scenarios/prompt-digests.test.ts`,
  `tests/contract/backstage/org-by-query-1.55.2.json` (recorded, Step 9)
- Modify (tests that assert what changes, each named in Step 11): `read-value.test.ts`,
  `serialize.test.ts`, `validate-rules.test.ts`, `validate-command.test.ts`,
  `read-repo.test.ts`, `api-reader.test.ts`, `api-graph.test.ts`, `api-read-commands.test.ts`,
  `api-write-side.test.ts`, `ask-overview.test.ts`, `iac-fs-provider.test.ts`,
  `fixtures-provider.test.ts`, `overview.test.ts`, `backstage-load.test.ts`,
  `backstage-provider.test.ts`, `backstage-read.test.ts`, `fake-backstage.test.ts`,
  `demo-backstage.test.ts`, `tests/contract/backstage-page.test.ts`
- Modify: `AGENTS.md` (invariants, "Current state", `validate`'s paragraph, test count),
  `docs/design.md` (§4.1's read model, the paragraph at `:309-317`, §7.0 if it names the
  set-aside kinds), `docs/adopting-backstage.md` (`:218`'s sample notice and `:221-223`'s
  "what this tool does not model (Users, Groups, Systems, Domains and Locations…)"),
  `README.md` (the two Backstage blocks, the sample notice at `:455`, the badge),
  `CHANGELOG.md`. Not `SECURITY.md`: what leaves the machine does not change until 3.3 (the
  organisation read is a `GET` on `entities/by-query` with `fields`, which its row already
  names, and asks for less than the refs read's row allows plus the spec fields)
- Add: `docs/plans/backstage-http-slice-3.md` (this plan)

**Interfaces:**

```typescript
// src/core/schemas/entity.ts
export const ORGANISATION_KINDS = ['Group', 'User', 'System', 'Domain'] as const
export type OrganisationKind = (typeof ORGANISATION_KINDS)[number]
export const organisationMetadataSchema  // name (NAME_PATTERN), namespace?; nothing else is read
export const groupSchema   // spec: type, children[], parent?, members?
export const userSchema    // spec: memberOf[]
export const systemSchema  // spec: owner, domain?, type?
export const domainSchema  // spec: owner, subdomainOf?, type?
export const organisationSchema = z.discriminatedUnion('kind', [groupSchema, userSchema, systemSchema, domainSchema])
export type OrganisationEntity = z.infer<typeof organisationSchema>
/** Every node the graph holds: the read model's entities, and the organisation beside them. */
export type GraphNode = CatalogueEntity | OrganisationEntity

// src/core/yaml/serialize.ts — one more reading, and one more list
export type ValueReading =
  | … // the five of slice 1; a refused organisation document is the `ignored` reading, its ref kept
  | { readonly as: 'organisation'; readonly entity: OrganisationEntity; readonly unread: readonly string[] }
// parseDocuments(text): { entities, apis, organisation: OrganisationEntity[], rejections, ignored, unread, documents }

// src/core/validate/rules.ts
export interface RepositoryFile { …; readonly organisation?: readonly OrganisationEntity[] }   // absent is none

// src/context/provider.ts
export interface LoadResult {
  entities; rejected; ignored; unread; census?
  organisation?: OrganisationEntity[]              // absent is none
  /** The organisation kinds read whole, which a reference to is judged against: a catalogue's, never a repository's. */
  judged?: readonly OrganisationKind[]
}

// src/context/graph/entity-graph.ts
export type DeclaredField = 'dependsOn' | 'dependencyOf' | 'providesApis'      // unchanged
export type OrganisationField =
  | 'owner' | 'system' | 'domain' | 'subdomainOf' | 'memberOf' | 'members' | 'parent' | 'children'
export interface OrganisationUnresolved { from: string; field: OrganisationField; to: string; sameName: readonly string[] }
export interface OrganisationRead { readonly nodes: readonly OrganisationEntity[]; readonly judged: ReadonlySet<OrganisationKind> }
static from(entities: readonly CatalogueEntity[], aside?: Iterable<string>, organisation?: OrganisationRead): EntityGraph
node(ref: string): GraphNode | undefined            // an entity or an organisation node
nodes(): GraphNode[]                                 // all(), then the organisation sorted by ref
get holdsOrganisation(): boolean                     // at least one organisation node
unresolvedOrganisationOf(ref: string, field: OrganisationField): OrganisationUnresolved[]   // judged only
ownedBy(ref: string): GraphNode[]                    // what names `ref` as its owner, sorted
membersOf(ref: string): GraphNode[]                  // Users: members ∪ memberOf read back; sorted
groupsOf(ref: string): GraphNode[]                   // a User's groups, both ends; sorted
childrenOf(ref: string): GraphNode[]                 // children ∪ parent read back; sorted
parentsOf(ref: string): GraphNode[]                  // parent ∪ children read back; sorted
partsOf(ref: string): GraphNode[]                    // a System's entities, a Domain's Systems and subdomains; sorted
wholeOf(ref: string): GraphNode[]                    // what a node's system, domain or subdomainOf names, present only
```

`danglingReferences()`, `unresolvedOf(ref, field?)` and `Unresolved` are unchanged and read
the entities alone. `refOf` takes a `GraphNode` (it reads the kind and the name alone).

- [x] **Step 1: Pin the prompts as they are (passes now, by construction)**

`tests/scenarios/prompt-digests.test.ts` replays the four question-mode tapes through a
client that keeps every request's digest, and asserts the list, turn by turn, against
constants measured on `f8bcb43`. It is written and run on the unchanged tree first: the
"before".

```typescript
/**
 * Every request the question-mode tapes are replayed with, as sha256 of JSON.stringify — the
 * digest `digestOf` (src/llm/runtime.ts:47) takes. Measured on f8bcb43, before
 * backstage-http slice 3. The Analyst's turns of three tapes already warn "the prompt
 * changed since recording" (docs/roadmap.md), so a warning cannot tell a further change;
 * this can. A change that must move one updates it in the commit that says why.
 */
const SENT: Record<string, readonly string[]> = {
  'question-prod-databases': ['supervisor#sha256:…', 'analyst#sha256:…', 'analyst#sha256:…'],
  'question-consumers-of-billing-db': [ … ],
  'question-unanswerable-ranking': [ … ],
  'mutation-classified-link': [ … ],
}

it.each(Object.entries(QUESTIONS))('%s sends the requests it sent on f8bcb43', async (scenario, intent) => {
  const tape = await openRecording({ scenario, store: fileRecordingStore(RECORDINGS), mode: 'replay', warn: () => {} })
  const replay = createClient({ mode: 'replay', tape })
  const sent: string[] = []
  const client: LlmClient = {
    generate: (request, call) => {
      sent.push(`${request.agent}#sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`)
      return replay.generate(request, call)
    },
  }
  await main(['ask', intent], { root: FIXTURES, client, env: process.env, out: () => {}, err: () => {} })
  expect(sent).toEqual(SENT[scenario])
})
```

The intents are `question-mode.test.ts`'s, word for word. Run:
`pnpm vitest run tests/scenarios/prompt-digests.test.ts` on the unchanged tree; write the
digests it prints on its first failure into `SENT`; run again. Expected: green. It is the
"before", and it stays green through 3.3.

- [x] **Step 2: The catalogue that answers the system question**

`tests/golden/organisation/` is a declarations repository by the rules `validate` holds (one
entity per file, witnesses, the registry's paths), small enough to read in one sitting, with
the organisation in `org/`, one document per file:

| File | What it declares | What it is for |
|---|---|---|
| `components/billing-api.yml` | Component, service, owner `tiger`, `system: billing`, `dependsOn` its grant | "which system is billing-api in?" |
| `components/invoicing-worker.yml` | Component, service, owner `group:default/lion`, `system: billing` | an owner naming no Group: a name over `--repo`, declared nowhere over the fake |
| `components/checkout-web.yml` | Component, website, owner `user:default/ada` | a User owning something |
| `catalog/databases/billing-db-prod.yml` | Resource, database, owner `tiger`, `system: billing`, env prod | a Resource in a System |
| `dependencies/access/billing-api-billing-db-prod.yml` | the grant, read | the dependency the card lists |
| three `.witness.yml` | | `validate`'s witnesses |
| `org/engineering.yml` | Group, `type: department`, `children: [tiger, common]` | the parent, declared from above |
| `org/tiger.yml` | Group, `type: team`, `children: []`, `members: [ada]` | a child that names no parent (read from the other end) |
| `org/common.yml` | Group, `type: team`, `parent: engineering`, `children: []` | a child that names its parent too |
| `org/ada.yml` | User, `memberOf: [tiger]`, `metadata.annotations: { microsoft.com/email: ada@acme.example }`, `profile: { displayName: Ada, email: ada@acme.example, picture: 'data:image/png;base64,iVBORw0KGgo=' }` | membership from both ends; no annotation and no profile is ever read |
| `org/grace.yml` | User, `memberOf: [group:default/ghost]` | a membership naming nothing |
| `org/billing.yml` | System, owner `tiger`, `domain: finance`, `type: product` | the system |
| `org/finance.yml` | Domain, owner `engineering` | the domain |

`node dist/cli/bin.js validate tests/golden/organisation` then reads: 12 entities in 12
files, 0 violations (five entities and seven organisation documents; a witness is no file of
that count, as in the demo SI's 33) — with `lion` and `ghost` said nowhere, since no rule
reads the organisation (Choices). The exact count is measured in Step 10 and written into
`organisation-reader.test.ts`.

- [x] **Step 3: Write the reader's tests (fail: no `organisation` reading)**

`tests/unit/organisation-reader.test.ts`:

```typescript
describe('the organisation, read for what the read model reads, never proposed', () => {
  it.each([
    ['Group', GROUP, { kind: 'Group', spec: { type: 'team', children: [], members: ['user:default/ada'] } }],
    ['User', USER, { kind: 'User', spec: { memberOf: ['group:default/tiger'] } }],
    ['System', SYSTEM, { kind: 'System', spec: { owner: 'group:default/tiger', domain: 'domain:default/finance' } }],
    ['Domain', DOMAIN, { kind: 'Domain', spec: { owner: 'group:default/engineering' } }],
  ])('reads a %s, its references in full by the processor’s default kinds', (_, value, expected) => {
    expect(readValue(value)).toMatchObject({ as: 'organisation', entity: expected })
  })
  it('reads a short reference in the entity’s own namespace default, as Backstage does: memberOf: [tiger] is group:default/tiger', …)
  it('sets aside, with its ref and the reason in reasonOf’s words, a Group without children, a User without memberOf, a System and a Domain without an owner — never a rejection', …)
  it('reads backstage.io/v1beta1 for all four, as their schemas allow', …)
  it('sets aside a Group of another namespace, of another tool’s apiVersion, or named in upper case — unreadApi’s three reasons', …)
  it('names metadata.annotations, metadata.title and spec.profile as not read, and keeps no email, no directory id and no picture anywhere in the reading', () => {
    const read = readValue(USER_WITH_PROFILE)   // microsoft.com/email and graph.microsoft.com/user-id annotations, a profile with a picture
    expect(read).toMatchObject({ as: 'organisation', unread: ['metadata.annotations', 'metadata.title', 'spec.profile'] })
    expect(JSON.stringify(read)).not.toMatch(/@|acme\.example|user-id|data:image/)
  })
  it('still sets a Location, a Template and another tool’s kind aside, as before', …)
  it('is what parseDocuments folds: organisation beside entities and apis, never among them, and never among rejections', …)
  it('reads tests/golden/organisation as its files say: 5 entities, 7 organisation nodes, no rejection, ada’s annotations and profile unread', …)
})

describe('validate over a repository holding the organisation', () => {
  it('counts the organisation among the entities and warns about none of it', async () => {
    expect((await runValidate(ORGANISATION)).text).toBe('12 entities in 12 files, 0 violations')
  })
  it('warns, never fails, on a Group that Backstage would refuse: not-modelled, its message saying why', …)
  it('reports nothing for two Groups of one name: no rule reads the organisation', …)
  it('reports no dangling reference for an owner or a membership naming nothing: the rule reads the write model', …)
  it('resolves a dependsOn naming a Group the repository declares, and one naming a System Backstage would refuse, as it resolved them set aside', …)
})
```

Run: `pnpm vitest run tests/unit/organisation-reader.test.ts`. Expected: FAIL, `readValue`
returns `ignored` for a Group.

- [x] **Step 4: The schemas and the reader**

In `entity.ts`, the four schemas after `apiSchema`, each `.transform(qualifyOrganisation)`:
`qualifiedSpec`'s `lenient` read over every reference, with the processor's default kind —
`owner`, `parent`, `children[]` and `memberOf[]` → Group, `members[]` → User, `domain` and
`subdomainOf` → Domain — in the entity's namespace; `apiVersion: z.enum(['backstage.io/v1alpha1',
'backstage.io/v1beta1'])` as `apiSchema`'s; `metadata` is `organisationMetadataSchema`, name and
namespace alone. `shapes` (`entity.ts:500-504`) gains the four, so `unreadFieldsOf` names
every other key they hold. The doc comment of `CatalogueEntity` (`:506-511`) says the
organisation is read beside it and is not one.

In `serialize.ts`: `READ_KINDS` (`:227`) becomes a map from the lower-case kind to its
schema and reading (`api` → `apiSchema`, `'api'`; the four → `organisationSchema`,
`'organisation'`); `ignoredOf` sends every read kind through `unreadReadKind` (today's
`unreadApi`, its reasons unchanged in wording, the kind named in the first); `readValue`
routes as today, but for one difference: an organisation document the schema refuses is the
`ignored` reading, its ref read as `ignoredOf` reads one and its reason `reasonOf`'s words
("Group tiger is not read: spec.children: …, which Backstage requires"), where an API's is
refused as today. `parseDocuments` folds the new reading into `organisation` with the
exhaustive `switch`. The `READ_KINDS` comment and `parseDocuments`' doc say the read model
now holds the organisation, that the write side reads `entities` alone as before, and why a
refused organisation document is set aside (the Choices' three reasons, with their lines).

**Exhaustive switches:** `parseDocuments`' fold, `BackstageProvider.load`'s, and every
`switch` on `ValueReading['as']` the compiler finds.

- [x] **Step 5: `validate`, and the write side left where it is**

`RepositoryFile` gains `organisation?` (`rules.ts:39-70`); `repositoryFileOf` carries it;
`checkRepository` puts its refs in `aside` beside the ignored ones (`:158-163`), not in
`declared` nor in `byRef`, so a reference to it resolves and no duplicate is reported; no
rule reads it; `referencesOf` (`:123-127`) is unchanged. The comment at `:186-199` now says a
read organisation document is no violation, and one set aside is still this warning.
`validate.ts:25-28` counts it. `plan.ts`' `graphOf` adds `...(file.organisation ??
[]).map(refOf)` to `aside`, beside `file.apis` and the ignored refs (which now include a
refused organisation document), with the comment saying why: a change is decided against the
write model, where a Group is a reference that resolves and never a node.

Then `tests/unit/organisation-plan-road.test.ts`, which is the doctrine's proof:

```typescript
describe('the organisation never reaches a plan', () => {
  it('builds the plan road’s graph, summary and Architect tool results for a repository holding Groups exactly as f8bcb43 did', async () => {
    // tests/golden/backstage-apis holds org/teams.yml, a Group: its gate contexts, the Architect’s
    // summary and one search's rows, serialised and hashed, equal constants measured on f8bcb43.
  })
  it('refuses no plan that amends a Component whose file also holds a Group Backstage would refuse', async () => {
    // A copy of tests/golden/organisation whose components/billing-api.yml gains a second
    // document, a Group without children. A plan amending billing-api passes the re-check:
    // no error, the Group's not-modelled warning among the plan's warnings as on f8bcb43,
    // and the repair loop sends the Architect nothing about it.
  })
  it('resolves, in the Architect’s summary, a dependsOn naming a System Backstage would refuse and one naming a read Group: dangling references: 0', …)
  it('vouches nothing with a declared Group: a proposed owner no entity carries signs novel and is asked, Group file or not', …)
  it('derives a grant’s owner from its consumers, as before, when the owner’s Group is declared in the repository', …)
  it('gives the propose tool and the proposal schemas no field for a Group, a User, a System or a Domain', () => {
    expect(JSON.stringify(proposeSpec)).not.toMatch(/memberOf|"children"|subdomainOf|"domain"/)
  })
})
```

*As built in 3.1:* the second test amends the grant, not a Component — `update-entity`'s one
patch, `add-dependency-of`, amends a Resource — so the Group Backstage would refuse sits
in the grant's file; the third's `dependsOn` names `group:default/tiger` beside the System,
so reverting the `graphOf` line fails it on the read Group.

- [x] **Step 6: Both roads, and the catalogue's organisation read**

The file road: `FixtureProvider` and `IacFsProvider` push `read.organisation` /
`file.organisation` into `LoadResult.organisation`, and set no `judged`.

The catalogue: in `load.ts`, `ORGANISATION = ['group', 'user', 'system', 'domain']` and

```typescript
/**
 * What the organisation read asks for: the fields the read model reads of the four kinds, and
 * nothing else — no annotation (an organisation provider puts a person's email and directory
 * id there), no title, no spec.profile (a picture can be a data URI of any size).
 */
const ORGANISATION_FIELDS =
  'apiVersion,kind,metadata.name,metadata.namespace,metadata.uid,' +
  'spec.type,spec.parent,spec.children,spec.members,spec.memberOf,spec.owner,spec.domain,spec.subdomainOf'
```

`others` splits into `organisation` (the facets' kinds among the four) and the rest; the
organisation read is `read(organisation, ORGANISATION_FIELDS, bounds.organisationEntities,
'organisation')`, sent only when `organisation` is not empty, between the modelled read and
the refs read. Its next pages carry the same `fields`, as the refs read's do. `Served` gains
`organisation: unknown[]` and `judged`, the facets' kinds among the four, capitalised as
`ORGANISATION_KINDS` writes them; `BackstageProvider.load` reads the items through `prePass`
and `readValue`, in `catalogueOrder`, into `LoadResult.organisation`, and hands `judged` on.
A server that ignores `fields` sends the rest, which the reader drops and names on `unread`,
as a file's — but for a User's or a Group's `spec.profile`, which the pre-pass drops before
the reader sees it (the owner's decision 2 of 2026-09-28; as built in 3.1). `limits.ts` gains `organisationEntities: 200_000`;
`ReadScope` gains `'organisation'`, `too-many` rendered "Groups, Users, Systems and Domains".

Tests, in `backstage-load.test.ts` and `backstage-provider.test.ts`:
- asks the facets once, then the modelled read, then the organisation read with exactly
  `ORGANISATION_FIELDS`, then the refs read of what is left (Location);
- sends no organisation read when the facets name none of the four: the requests of today,
  and `judged` empty;
- `judged` is the kinds the facets named: a catalogue serving Groups and no Users judges
  `Group` alone;
- each next page of the organisation read carries its cursor, `limit=250` and the same
  `fields`;
- refuses 200,001 organisation entities, naming them; the refs ceiling is reached with
  Locations now (today's rows used Groups: they move to `Location`, the same assertions);
- a User served whole — a picture of 1 MiB, `microsoft.com/email` and
  `graph.microsoft.com/user-id` annotations — by a fake that ignores `fields` is read, with
  no `@`, no directory id and no picture in the `LoadResult`, and `metadata.annotations` on
  its `unread` (the profile never reaches the reader: the pre-pass drops it);
- the fake serving `tests/golden/organisation` gives the `LoadResult` its files give, as
  sets — the equivalence of § 9 for the new kinds — but for `judged`, which the files never
  set, and `unread`, which names ada's annotations and profile from the file and nothing from
  a catalogue that honours `fields`.

- [x] **Step 7: The graph's organisation index, and the judged-kind rule**

`tests/unit/organisation-graph.test.ts` first (fails: no `node`):

```typescript
describe('the organisation beside the entities', () => {
  it('keeps all(), get(), search(), danglingReferences() and unresolvedOf(ref) of every graph exactly as they were without the organisation', …)
  it('keeps the organisation out of all(): graph, the summary and the overview’s kinds do not see a Group', …)
  it('finds a node by reference with node(), an entity or a Group', …)
  it('reads a parent from both ends: children on engineering and parent on common are one edge each', …)
  it('reads membership from both ends: members on tiger and memberOf on ada are one', …)
  it('lists what a Group, a User owns: every node whose owner names it, sorted', …)
  it('lists a System’s parts and a Domain’s Systems', …)
  it('calls an owner naming no Group declared nowhere where Groups are judged, and nowhere else', () => {
    const served = graphOf(ORGANISATION, { judged: ['Group', 'User', 'System', 'Domain'] })   // as the catalogue road builds it
    expect(served.unresolvedOrganisationOf('component:default/invoicing-worker', 'owner'))
      .toEqual([{ from: 'component:default/invoicing-worker', field: 'owner', to: 'group:default/lion', sameName: [] }])
    expect(graphOf(ORGANISATION).unresolvedOrganisationOf('component:default/invoicing-worker', 'owner')).toEqual([])   // the file road
    expect(graphOf(BACKSTAGE_APIS).unresolvedOrganisationOf('api:default/payments', 'owner')).toEqual([])  // one Group file is not the organisation
    expect(graphOf(DEMO).danglingReferences()).toEqual([])
  })
  it('judges an owner user:… only when Users are judged, and a system only when Systems are', …)
  it('resolves a judged owner naming a Group set aside — of another namespace, in upper case, refused — against aside: never declared nowhere', …)
  it('counts Groups read, not Groups set aside, as what a node() finds', …)
  it('does not call a dependsOn naming a Group dangling, as before', …)
  it('leaves what a model is sent where it was over a source that holds and judges an organisation', () => {
    // tests/golden/organisation served by the fake: summariseGraph and formatSummary, and the
    // rows search_entities and get_entity return for every entity (buildTools(graph, { apis: true })),
    // equal those of the same entities with no organisation — invoicing-worker's row carries no
    // owner among its danglingReferences, and declaredNowhere does not grow.
  })
  it('leaves graph’s dangling list, the show api:default/payments card and every search_entities and get_entity row over tests/golden/backstage-apis byte for byte', …)
  // the rows hashed against constants measured on f8bcb43, as the demo SI's are pinned: its
  // Group file is read, lion is not judged, and no row gains a danglingReferences entry
})
```

Then the index in `EntityGraph`'s constructor, after today's, over `organisation.nodes`:
a map of its own, `organisationByRef` (first declaration wins, as for entities) — **not**
`byRef`, which is typed `CatalogueEntity` and backs `get()`, `all()` and the dangling check
(`entity-graph.ts:67`, `:95`, `:143`, `:186-187`), so a Group put there would reach every
one of them — and six maps built from both ends — `owners` (owner → nodes, over entities,
APIs, Systems and Domains), `members` / `groups`, `children` / `parents`, `parts` /
`wholes` — with the same `link` helper. The organisation's refs join the set a `dependsOn`
is resolved against, as `aside` does today (`:143` reads `byRef`, `organisationByRef` and
`aside`). Unresolved organisation references are computed only for the judged kinds,
against all three, into their own `organisationUnresolved` map; `dangling` and `unresolved`
are built as today, from the entities' three fields alone.

- [x] **Step 8: What `show`, the overview and the notice say**

`tests/unit/organisation-show.test.ts` first, over `tests/golden/organisation` read as files
and served by the fake (the two outputs equal but for the source's words and the judged
marks):

```text
$ idpa show tiger --repo tests/golden/organisation
group:default/tiger

  kind         Group
  type         team

parent
  group:default/engineering

children
  none

members
  user:default/ada

owns
  component:default/billing-api
  resource:default/billing-api-billing-db-prod  prod
  resource:default/billing-db-prod              prod
  system:default/billing
```

(columns padded as `show`'s sections pad them; the environment of a Resource, as there)

```text
$ IDP_BACKSTAGE_URL=http://127.0.0.1:7008/api/catalog idpa show invoicing-worker   # the fake, --root tests/golden/organisation --no-org
component:default/invoicing-worker

  kind         Component
  type         service
  owner        group:default/lion  <nowhere's mark for a Backstage source>
  environment  (undeclared)
  system       system:default/billing
…
```

and over `--repo` the same card with `owner        group:default/lion` unmarked, as on
`f8bcb43`. Then the User's (`member of`, `owns`), the System's (`owner`, `domain`, then
`contains`), the Domain's (`owner`, then `systems`); over the fake `grace`'s `member of`
shows `group:default/ghost` with the mark; a Group owning 30 entities lists 25 and `+5
more`, and one with 30 members, 30 children, a User in 30 groups the same; ada's card holds
no `@`. Resolution: `show billing` over a graph holding a Component `billing` and a System
`billing` prints the Component (exit 0), `show system:default/billing` the System; a name
only a Group carries prints the Group; a name held by nothing but in 30 Users' names lists 25
candidates and `+5 more` (exit 1), headed `"person" matches 30 nodes:` — as a name a Group and
a User both carry is — where the entities' candidates keep `entities`. Every `show` of the demo SI, over files and over the fake,
is byte for byte `f8bcb43`'s (`tests/golden/demo-read/`).

Then `renderOrganisationDetail(graph, node, said)` in `cli/render/organisation.ts`, reusing
`entity.ts`'s `shown`, `nowhere` and section layout (the section helper is exported from
`entity.ts` rather than copied, and gains the 25-row bound only for its new callers);
`renderEntityDetail`'s `owner` and `system` lines append `nowhere(…)` when
`unresolvedOrganisationOf(ref, 'owner' | 'system')` holds one; `runShow` resolves through
`resolveNode`, the precedence of the Choices, and `resolveEntity`, which `relations` uses
until 3.2, is unchanged.

The overview: `Overview` gains `organisation: { groups; users; systems; domains }`, counted
from the index; the renderer prints one line after the APIs' only when one is non-zero —
`organisation  3 groups, 2 users, 1 system, 1 domain` — so the demo SI's overview
(`tests/golden/demo-read/overview.txt`) is unchanged. Its `dangling references` section is
`danglingReferences()`, unchanged.

`index.ts`: the graph is `EntityGraph.from(entities, asideRefs, { nodes: organisation ?? [],
judged: new Set(judged ?? []) })`; the notice's `entities` count is `entities.length +
organisation.length`; the empty-source line (`:1353-1366`) is not printed when the
organisation is not empty (a repository of Groups is a catalogue, as the comment above it
says). `sourceAttributes` (`:1586-1597`): the fallback `served` adds `organisation.length`,
and `idp.source.set_aside` is `served - entities.length - organisation.length`, so a Group
read is not reported set aside.

- [x] **Step 9: One organisation for the fake and the Docker Backstage**

`tools/backstage/org.yaml` becomes the demo's organisation data, with no System or Domain
(row 1: one would show empty, and billing-api cannot be made part of it without changing the
demo SI):

```yaml
# Group engineering: type department, children [common, dodowarriors, elephant, tiger]
# Groups common, dodowarriors, elephant, tiger: type team, children [] — as today, no parent
#   stated (read from engineering's side)
# User ada:   memberOf [tiger], annotations { microsoft.com/email: ada@acme.example },
#             profile { displayName: Ada, email: ada@acme.example, picture: a data: URI }
#             — Backstage ingests them; idpa never asks for them
# User linus: memberOf [common]
```

`app-config.yaml`'s organisation location allows `[Group, User]`. `tools/fake-backstage.ts`
serves `org.yaml`'s documents, located at `${prefix}org/org.yaml`, instead of its three
hard-coded Groups: `catalogueOf(root, { org?: string; groups?: readonly string[]; location?:
string })`, `org` the path of a YAML file whose documents are served beside the folder's; the
program passes `tools/backstage/org.yaml` unless `--no-org` is given (`--no-groups` kept as
its alias, so no command written before breaks), and `--root <folder>` with `--no-org` serves
`tests/golden/organisation` alone, which holds its own. `groups` stays for the tests that
build hundreds of synthetic teams. Every organisation reference of `org.yaml` resolves — the
four teams are engineering's children, ada's and linus's groups exist — so over the fake and
the Docker Backstage no owner, membership or parent is declared nowhere.
`scripts/demo-backstage-docker.mjs:123` expects `{ Group: 5, User: 2, Location: 3 }`, and
gains one step: `show tiger` against the Docker Backstage prints what it prints against the
fake. `--record` also writes the organisation read's first page to
`tests/contract/backstage/org-by-query-1.55.2.json`, and `backstage-page.test.ts` reads it:
through the pre-pass and `readValue` it gives what `org.yaml` gives as a file, it holds no
`profile`, no `annotations` and no `@`, which proves the real Backstage honours `fields`,
and its bytes per User are written beside the Choices' estimate. Recording it needs Docker
and no key; if Docker is not available to whoever executes this step, the step and the
fixture wait for the owner and 3.1 says so in its description.

*As built in 3.1:* everything above but the recording. `pnpm demo:backstage:docker` was not run
(no Docker run in 3.1), so `tests/contract/backstage/org-by-query-1.55.2.json` and the
`backstage-page.test.ts` rows that read it were left to a later `pnpm demo:backstage:docker
--record`, which now writes that page too. The `show tiger` step compares the catalogue's
card with the one the same files print (`--repo` over a copy of the demo SI and `org.yaml`),
which is what the fake serves.

*As recorded, 2026-09-29* (the pull request that made the demo's compose calls quiet): `pnpm
demo:backstage:docker --record` ran every step as documented against Backstage 1.55.2 and
wrote `tests/contract/backstage/org-by-query-1.55.2.json`: the five Groups and two Users of
`org.yaml`, `totalItems` 7, one page, 2,222 bytes as committed (1,390 as compact JSON).
Every item holds `apiVersion`, `kind`, `metadata.name`, `metadata.namespace`,
`metadata.uid` and the spec fields it declares, and nothing else: no `spec.profile`, no
`metadata.annotations`, no `@` anywhere, so Backstage 1.55.2 honours `fields` — the run
refuses to write a page whose items carry either. `by-query-1.55.2.json` was served again
but for its uids, etags and order, and `--record` leaves such a page's fixture as it is.
`backstage-page.test.ts` holds four rows on the page. The first checks the recorded bytes:
the seven items, their keys, no profile, no `@`. The other three read it: through the
pre-pass and `readValue`, item by item, it gives the nodes `org.yaml` gives as a file,
written out in the test, with nothing unread; ada served with `org.yaml`'s profile, as a
server ignoring `fields` would send her, reads as the recorded ada; and loaded, it gives
what the fake's organisation read gives, answering exactly the request the provider sends.
Each of the three was seen to fail: the pre-pass keeping the profile failed the ada row;
`readValue` no longer reading an organisation document failed all three; `readValue`
handing on the served value instead of its reading failed the item-by-item and the load
rows.

- [x] **Step 10: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/organisation-*.test.ts tests/scenarios/prompt-digests.test.ts tests/unit/read-value.test.ts tests/unit/plan-intent.test.ts
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git status --short fixtures tests/recordings tests/golden     # only tests/golden/organisation/ is new
git diff main -- src/core/schemas/plan.ts src/agents/tools/propose-tool.ts tests/golden/architect-tools.json   # empty
grep -rlE "Group|kind: (User|System|Domain)" tests scripts   # each hit has its verdict in Step 11's table
```

- [x] **Step 11: What changes, test by test, and why** (in the pull request's description)

| Test | What it asserted | Now | Why |
|---|---|---|---|
| `read-value.test.ts` | the digest of `tests/golden/backstage-apis` and of `org/teams.yml`'s reading | new digests | the Group there is read, not set aside |
| `serialize.test.ts:335-337,416`, `api-reader.test.ts:268-278`, `fixtures-provider.test.ts:34`, `iac-fs-provider.test.ts:68`, `api-graph.test.ts:215` | Group, System, User, Domain "is not modelled by this tool" | read as organisation nodes, or set aside with the reason Backstage would refuse them for; Location and Template rows unchanged | the change itself |
| `validate-rules.test.ts:205-250`, `validate-command.test.ts:82` | `not-modelled` warnings for Groups and a System | none for one read, the same rule with its reason for one refused; the count grows | read like an API, never an error |
| `read-repo.test.ts:223,262`, `api-read-commands.test.ts:57` | `not loaded: … (Group ×2, User ×1, …)`, `(Group ×1)` | the line lists what is still set aside; over `backstage-apis` it is gone | the same |
| `api-read-commands.test.ts:39,53,67,135`, `api-graph.test.ts:112-117`, `api-analyst-tools.test.ts` | `DANGLING` = one reference; the payments card's `owner        group:default/lion`; "a providesApis naming nothing is dangling, and only that"; the Analyst's rows over `backstage-apis` | **unchanged**, now also pinned by `organisation-graph.test.ts` | the file road judges nothing: one Group file is not the organisation; and an entity's row reads `unresolvedOf(ref)`, whose three fields do not change (`api-graph.test.ts` builds its graph with no organisation at all) |
| `api-write-side.test.ts:129` | `1 error and 2 warnings already in the repository` | `1 error and 1 warning` | the Group's `not-modelled` warning is gone from `recheck.standing` |
| `ask-overview.test.ts:117-118` | `not loaded  1 document this tool does not model`, `Group  1` | `organisation  1 group`, no `not loaded` section | the Group is read |
| `overview.test.ts:273-295` | Groups and Users among `setAside.kinds` | counted under `organisation` | the same |
| `backstage-read.test.ts:52,177-214` | the fake with three Groups (`GROUPS`, no `common`): `36 entities: 33 read, 3 not modelled` and `not loaded: … (Group ×3)` | the fake with `org.yaml`'s organisation: `40 entities: 40 read, 0 not modelled`, no `not loaded` line | the Groups are read; with three of the four teams, the 13 owners `group:default/common` would be declared nowhere on their cards, which is not what these tests are about. One new row keeps the three and asserts `show` marks exactly those 13, and that `graph`'s dangling list does not |
| `backstage-read.test.ts:498-499` | `'idp.source.entities': 36, 'idp.source.set_aside': 3` | `40` and `0` (and `pages` as measured: the organisation read replaces the refs read) | `sourceAttributes` counts the organisation as read |
| `backstage-load.test.ts`, `backstage-provider.test.ts:128`, `fake-backstage.test.ts:70-143` | Groups as the example of a kind read as refs | Locations; Groups read by the organisation read | the refs read no longer carries them |
| `demo-backstage.test.ts:125-131` | `org.yaml` holds four Groups, allowed `[Group]` | five Groups and two Users, allowed `[Group, User]` | Step 9 |
| `scripts/smoke.mjs:517-532` | `warning org/tiger.yml: kind Group is not modelled` then `33 entities in 34 files, 0 violations` | no warning, `34 entities in 34 files, 0 violations`; the comment says a Group beside the entities is read, and one Backstage would refuse is set aside with a warning, never refused | the Group is read |
| `scripts/smoke.mjs:601` | `36 entities: 33 read, 3 not modelled` | `40 entities: 40 read, 0 not modelled` | Step 9 |
| `plan-intent.test.ts:265-330`, `recheck.test.ts`, `repair.test.ts`, `init-*.test.ts` | a spec-less System resolves for the Architect; `RepositoryFile` literals; init's reasons | **unchanged** | a refused organisation document is set aside with its ref; `organisation?` is optional; never a rejection |

The last command of Step 10 lists every file that names an organisation kind; any hit not in
this table gets a row, with "unchanged" and the reason when it does not move
(`update-environment`, `registration`, `key-reach` and `read-commands-hostile` were read for
this plan and appear unaffected).

**Architecture rules:** none change: `core/` imports nothing new, `context/backstage/` still
names no `fetch` but in `transport.ts`, and the agents' closure reaches none of it.

- [ ] **Step 12: The pull request** (after the owner's go-ahead)

```bash
git add src/core/schemas/entity.ts src/core/yaml/serialize.ts src/core/README.md \
  src/core/validate/rules.ts src/cli/commands/validate.ts src/context/provider.ts \
  src/context/fixtures/index.ts src/context/iac-fs/snapshot.ts src/context/iac-fs/provider.ts \
  src/context/README.md src/context/backstage/limits.ts src/context/backstage/load.ts \
  src/context/backstage/provider.ts src/context/backstage/transport.ts \
  src/context/graph/entity-graph.ts src/context/graph/overview.ts src/cli/render/organisation.ts \
  src/cli/render/entity.ts src/cli/render/overview.ts src/cli/commands/show.ts src/cli/commands/plan.ts \
  src/cli/index.ts src/cli/README.md tools/fake-backstage.ts tools/backstage/org.yaml \
  tools/backstage/app-config.yaml tools/backstage/README.md scripts/demo-backstage-docker.mjs \
  scripts/smoke.mjs \
  src/context/backstage/translate.ts \
  tests/golden/organisation tests/unit/organisation-*.test.ts tests/scenarios/prompt-digests.test.ts \
  tests/unit/{read-value,serialize,validate-rules,validate-command,read-repo,api-reader,api-graph}.test.ts \
  tests/unit/{api-read-commands,api-write-side,ask-overview,iac-fs-provider,fixtures-provider}.test.ts \
  tests/unit/{overview,backstage-load,backstage-provider,backstage-read,fake-backstage,demo-backstage}.test.ts \
  tests/unit/{backstage-prepass,backstage-transport,render-overview}.test.ts \
  AGENTS.md docs/design.md docs/adopting-backstage.md README.md CHANGELOG.md docs/plans/backstage-http-slice-3.md \
  docs/roadmap.md docs/backstage-http-brief.md
# org-by-query-1.55.2.json and the backstage-page.test.ts rows that read it came later (Step 9)
git commit -m "feat: read Groups, Users, Systems and Domains as read-only nodes of the graph"
```

Base `main`. CHANGELOG, `### Added`:

> - Groups, Users, Systems and Domains are read, from a declarations repository's files and
>   from a Backstage catalogue alike, as read-only nodes beside the entities: `show` prints a
>   team, a person, a system and a domain, the overview counts them, and against a catalogue
>   an owner or a system naming nothing it serves is shown as declared nowhere. A catalogue
>   is asked for the fields the read model reads of them, never for a profile or an
>   annotation; none of them is ever proposed, one Backstage would refuse is set aside with a
>   warning rather than refused, and a plan is decided as before
>   ([#N](https://github.com/pcaboor/idp-agent/pull/N)).

**What changes that a person sees** (the pull request lists it):
- `validate` over a repository holding Group, User, System or Domain files: no `not-modelled`
  warning for one it reads, and it is counted; one Backstage would refuse is still that
  warning, whose message now says why; never an error. Over `fixtures/si-demo`: unchanged.
- `plan` over such a repository: the standing line (`N errors and M warnings already in the
  repository`) counts fewer warnings, a Group read in a file the plan edits no longer prints
  its warning among the plan's, and `plan --json`'s `recheck.standing` loses them. No error
  appears or disappears, so no plan is refused or accepted differently.
- The read commands' `not loaded:` line no longer lists the four kinds read; a `not read:`
  line appears for a Group or a User file holding annotations, a title or a profile (the owner's
  IaC may).
- `show <name>`: unchanged for every name an entity carries; a name only an organisation
  node carries now prints its card where it printed "No entity named"; `show <ref>` of a
  Group, User, System or Domain prints its card.
- `pnpm demo:backstage` and the fake: `reading the Backstage catalogue at 127.0.0.1:7007
  (IDP_BACKSTAGE_URL): 40 entities: 40 read, 0 not modelled; …` and no `not loaded:` line,
  where it printed `36 entities: 33 read, 3 not modelled` and `not loaded: 3 documents this
  tool does not model (Group ×3)` — README lines 455, 481 and 493-494.
- The Docker demo: `43 entities: 40 read, 3 not modelled` and `not loaded: 3 documents this
  tool does not model (Location ×3)`, where it printed `40 entities: 33 read, 7 not
  modelled` and `(Group ×4, Location ×3)` — README lines 524-525, `tools/backstage/README.md`.
  `docs/adopting-backstage.md:218-223`'s sample and sentence say Users and Groups are read.
- The trace's root: `idp.source.set_aside` no longer counts organisation nodes.
- stdout of `graph`, `show billing-api` and `relations` over the demo SI, over the fake and
  over the Docker Backstage: unchanged — every owner of the demo SI names a Group the demo
  organisation declares, so none is declared nowhere, and `graph`'s dangling list is the
  write model's. Over `tests/golden/backstage-apis`: unchanged but for `not loaded:`. The
  overview over the demo SI: unchanged; over the two catalogues it gains `organisation  5
  groups, 2 users`, and its `not loaded` section no longer counts the Groups (the fake's
  disappears; Docker's reads `Location 3`).
- What a model is sent: unchanged, for every source (`prompt-digests.test.ts`, and Step 7's
  test over a source that holds and judges an organisation).

**What the owner can run** (after `pnpm build`, from the clone):

```bash
node dist/cli/bin.js validate fixtures/si-demo
# 33 entities in 33 files, 0 violations                                           (exit 0)
node dist/cli/bin.js validate tests/golden/organisation
# 12 entities in 12 files, 0 violations                                           (exit 0)
node dist/cli/bin.js show tiger --repo tests/golden/organisation
# the Group card of Step 8: parent engineering (read from engineering's side), member ada,
# owns billing-api, its grant, billing-db-prod and the System billing            (exit 0)
node dist/cli/bin.js show invoicing-worker --repo tests/golden/organisation
# owner        group:default/lion   — unmarked: a repository's Group files are not the organisation  (exit 0)
node dist/cli/bin.js graph --repo tests/golden/backstage-apis
# byte for byte as on main: 1 dangling reference, component:default/billing-api -> api:default/ghost  (exit 0)
node dist/cli/bin.js show billing-api --demo
# tests/golden/demo-read/show-billing-api.txt, byte for byte                     (exit 0)
node tools/fake-backstage.ts          # in a second terminal: listening on http://127.0.0.1:7007/api/catalog
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog node dist/cli/bin.js show group:default/tiger
# stderr: reading the Backstage catalogue at 127.0.0.1:7007 (IDP_BACKSTAGE_URL): 40 entities: 40 read, 0 not modelled; …
# stdout: kind Group, type team, parent group:default/engineering, member user:default/ada,
#         owns the first 25 of the 14 entities tiger owns in the demo SI, i.e. all 14   (exit 0)
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog node dist/cli/bin.js show user:default/ada
# member of group:default/tiger; no email, no picture                            (exit 0)
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog node dist/cli/bin.js show billing-api
# tests/golden/demo-read/show-billing-api.txt, byte for byte                     (exit 0)
node tools/fake-backstage.ts --root tests/golden/organisation --no-org --port 7008   # a third terminal: the system question's catalogue
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7008/api/catalog node dist/cli/bin.js show billing-api
# system       system:default/billing  — the card, read from a catalogue; the same over --repo  (exit 0)
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7008/api/catalog node dist/cli/bin.js show invoicing-worker
# owner        group:default/lion  declared nowhere in the catalogue this token reads   (exit 0)
pnpm build && pnpm demo:backstage:docker          # optional, needs Docker: every step as documented, show tiger included
```

The `show tiger` outputs and the exact mark are written into the pull request's description
once measured.

---
### Task 3.2: Relations over ownership and membership

**Goal.** `idpa relations` walks the organisation, with no model: what a team or a person
owns, who owns something and the groups above them, who is a member of what, and what a
System or a Domain holds and what holds it — both directions, several hops, bounded, each row
with its whole path, a judged reference naming nothing marked where the path ends. The walks
are the ones the Analyst will choose in 3.3, as `idpa relations` and the `relation` answer
print one computation today (design §4.1).

**Files:**
- Modify: `src/core/schemas/query.ts` (`ORGANISATION_RELATIONS`, `OrganisationRelation`;
  `RELATIONS` untouched)
- Modify: `src/context/graph/relations.ts` (`Step.kind` and `stepOf` over a `GraphNode`;
  `Walk` and `walked` over `GraphNode`; the six walks; `relationsOf` takes either list),
  `src/context/README.md`
- Modify: `src/cli/commands/relations.ts` (`resolveNode`, 3.1's precedence; an organisation
  node's overview), `src/cli/render/relations.ts` (the six headings and arrows; the line of a
  first hop read as a name), `src/cli/index.ts:709` (`RELATION_FLAGS`), `src/cli/usage.ts`,
  `src/cli/README.md`
- Create: `tests/unit/organisation-relations.test.ts`, `tests/golden/relations-organisation/`
  (`tiger-owns.txt`, `engineering-owns.txt`, `invoicing-worker-owned-by.txt` (the fake's),
  `ada-member-of.txt`, `engineering-has-member.txt`, `billing-api-part-of.txt`,
  `finance-has-part.txt`, `tiger.txt`)
- Modify: `CHANGELOG.md`, `AGENTS.md` (the `relations` line of "Current state", test count),
  `README.md` (the relations flags, the badge), `docs/design.md` (§4.1, "Relations are
  computed, never inferred": the six). Not `relations-command.test.ts`: its two-flags row
  asserts the prefix `relations takes one of` (`:390`), which does not move

**Interfaces:**

```typescript
// src/core/schemas/query.ts — beside RELATIONS, which does not move
export const ORGANISATION_RELATIONS = ['owns', 'owned-by', 'member-of', 'has-member', 'part-of', 'has-part'] as const
export type OrganisationRelation = (typeof ORGANISATION_RELATIONS)[number]

// src/context/graph/relations.ts
export interface Step { readonly ref: string; readonly kind?: GraphNode['kind']; … }   // as today, the kind widened
export function stepOf(node: GraphNode): Step          // an organisation node: its kind, its type when it states one, no env, never a right
export function relationsOf(graph: EntityGraph, ref: string, relation: Relation | OrganisationRelation, options?: RelationOptions): RelationResult | undefined
```

The six walks, each over edges the graph reads from both ends (3.1), the arrow pointing as
today's do — from what is held, a member or a part, to what holds it (`render/relations.ts:44`):

| Relation | From | First hop | Further hops | Listed | Walked through | Declared nowhere, at each hop (judged only) |
|---|---|---|---|---|---|---|
| `owns` | a Group or a User | what names it as owner (`ownedBy`) | a Group's child Groups (`childrenOf`), whose own | every node reached but a Group reached as a child | Groups | a `children` naming nothing |
| `owned-by` | anything that states an owner | its owner | the owner's parent Groups (`parentsOf`) | Groups and Users | Groups | the `owner`, then a `parent` |
| `member-of` | a User, a Group | a User's Groups (`groupsOf`), a Group's parents | parents | Groups | Groups | `memberOf`, then `parent` |
| `has-member` | a Group | its Users (`membersOf`) and child Groups | the children's | Users and Groups | Groups | `members`, `children` |
| `part-of` | a Component, Resource, API, System or Domain | what its `system`, `domain` or `subdomainOf` names (`wholeOf`) | the same, upward | every node reached | Systems and Domains | `system`, `domain`, `subdomainOf` |
| `has-part` | a System or a Domain | its parts (`partsOf`) | a part System's or subdomain's | every node reached | Systems and Domains | none: a part that names nothing is that part's own reference |

Depth, rows and cycles are `RELATION_LIMITS`' (ten hops, 100 rows on the command, a parent
loop reported as a cycle and walked once). A judged reference naming nothing ends its path,
marked as today's are (`unresolvedOrganisationOf`); an unjudged one that no node carries is
no row, and when the first hop is only such a reference the renderer says so in one line
instead of `none`: `none: <ref>, the <field> <subject> names, is read as a name here: <why>`,
the why being `this source holds no <Kind>` or `a declarations repository's <Kind> files are
not read as the whole organisation`.

- [x] **Step 1: Write the tests (fail: no such relation)**

```typescript
describe('relations over the organisation', () => {
  // tests/golden/organisation, read as files; the same over the fake, the source's words and the judged ends aside.
  it('lists what tiger owns: billing-api, its grant, billing-db-prod and the System billing, depth 1', …)
  it('lists what engineering owns, through its children: finance at depth 1, then tiger’s and common’s at depth 2, each path from engineering', () => {
    const rows = rowsOf(relationsOf(graph, 'group:default/engineering', 'owns'))
    expect(rows).toContainEqual({ ref: 'component:default/billing-api', depth: 2, path: ['group:default/engineering', 'group:default/tiger', 'component:default/billing-api'] })
  })
  it('reads a child from either end: tiger is engineering’s by children, common by children and parent, each listed once', …)
  it('names billing-api’s owner and the groups above it: tiger, then engineering', …)
  it('over the fake, ends invoicing-worker’s owned-by on group:default/lion, declared nowhere, and lists no group past it', …)
  it('over --repo, answers invoicing-worker’s owned-by with the one line: lion is read as a name here, exit 1', …)
  it('over the fake, ends grace’s member-of on group:default/ghost, declared nowhere', …)
  it('ends a judged owner naming a Group set aside on that Group, in the catalogue and not read, never declared nowhere', …)
  it('lists engineering’s members, users and groups, down its children', …)
  it('walks billing-api up to billing, then finance; and finance down to billing, then its three parts', …)
  it('reports a parent loop as a cycle, walked once, whatever order the files came in', …)
  it('computes the same rows whatever order the provider read the files in', …)
  it('holds nothing, and says so, for an organisation relation over a source that holds none of its kinds', async () => {
    const run = await cli(['relations', 'billing-api', '--owned-by', '--demo'])
    expect(run).toMatchObject({ code: 1 })
    expect(run.out).toContain('none: group:default/tiger, the owner billing-api names, is read as a name here: this source holds no Group')
  })
  it('resolves relations billing through the Component when a System billing is also read', …)
  it('leaves every existing relation of every entity exactly as it was: tests/golden/relations-demo, byte for byte', …)
  it('leaves relations <entity> with no flag as it was: an entity’s overview lists the relations it listed', …)
  it('prints an organisation node’s overview: the relations of its kind that hold something', …)
  it('refuses two relation flags, naming all twelve', …)
})
```

The goldens under `tests/golden/relations-organisation/` are written by the first green run,
read line by line against the table above, and committed: new files, the point of the task.
All are the file road's but `invoicing-worker-owned-by.txt`, which is the fake's, the one
where the roads differ.

- [x] **Step 2: The walks**

`stepOf`, `Walk` and `walked` take a `GraphNode`: `stepOf` of an organisation node carries
its kind and, for a Group, System or Domain that states one, its type; a User states none,
and its step says `(undeclared)` where a type goes, as an absent environment does. The six
`Walk`s beside today's seven in `relationsOf`, each from the table, `dangling` reading
`unresolvedOrganisationOf(at, field)` with the fields named there. `relationsOf` resolves its
subject with `graph.node(ref)`; a relation asked of a node of a kind it does not start from
computes no row (`holds` is false), as `provides` of a database does today.

- [x] **Step 3: The command**

`RELATION_FLAGS` (`index.ts:709`) is `[...OWN_RELATIONS, ...ORGANISATION_RELATIONS]`, twelve
flags (`OWN_RELATIONS` is `RELATIONS` less `between`, `query.ts:104-110`; `--to` stays apart);
`OVERVIEW_ORDER` (`render/relations.ts:62`) does not change, so `relations billing-api`
prints what it printed. `runRelations` resolves through `resolveNode` (3.1's precedence:
entities first, so no name that finds an entity today becomes ambiguous); an organisation
node with no flag prints its kind's relations that hold something, in the table's order.
`renderRelation` gains the six headings (`owns`, `owned by`, `member of`, `has members`,
`part of`, `has parts`), their arrows, and the one line of a first hop read as a name.
`usage.ts` lists the six flags.

**Exhaustive switches:** the heading and arrow maps of `render/relations.ts`, and every
`switch` on `Relation` the compiler finds now taking `Relation | OrganisationRelation`.

- [x] **Step 4: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/organisation-relations.test.ts tests/unit/relations.test.ts tests/unit/relations-command.test.ts tests/scenarios/prompt-digests.test.ts
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git status --short tests/golden/relations-demo tests/recordings    # nothing
```

*As built in 3.2*, where the code asked for something the plan did not say:
- **The usage text is `HELP` in `src/cli/index.ts`**, not `src/cli/usage.ts`, which is the
  line a run's model calls end on; `HELP`'s `relations` line and paragraph name the six.
- **`EntityGraph` gains three small reads** the walks need and 3.1 did not expose: the
  judged kinds kept, `unreadOrganisationOf(ref, field)` — what a node declares in one field
  that no node carries and that is not declared nowhere: set aside where judged, a name where
  not — and `holdsKind(kind)`, which picks the name line's why.
- **A judged reference naming a document set aside** ends its row on a step of its own,
  `setAside`, printed `— in the catalogue, not read`: the words `entity-graph.ts` already used
  for it, since the plan named the case and no mark.
- **An organisation relation's table says NODE** where the others say ENTITY (a Group is a
  node, not an entity, as `show`'s candidates say), and the name line's field is said in
  words: `owner`, `system`, `domain`, `parent domain`, `group` (a `memberOf`), `member`,
  `parent`, `child`; a reference of no organisation kind is `this source holds nothing of
  that name`.
- **The Analyst's `get_relations` still asks of an entity alone**: `relationsOf` now resolves
  a Group too, so `graph-tools.ts` refuses a ref `graph.get` does not hold with the words it
  used for one naming nothing, and its `Dangling.field` type widens (no byte moves; the
  field is always a `DeclaredField` there). What the Analyst is shown is 3.3's.
- **The owner guide runs the fake on port 7011**: 7007 may be the owner's Docker Backstage.
- **An absent type is `-`**, as an absent environment is in these tables, where Step 2 said
  `(undeclared)`: a User's TYPE, and a System's or a Domain's that states none
  (`ada-member-of.txt`, `engineering-has-member.txt`, `billing-api-part-of.txt`).
- **Each walk follows only the kinds its edges are of**, which the table says in words ("a
  Group's child Groups", "the owner's parent Groups") and the reader does not enforce: it
  keeps a reference's own kind, so a Group's `children` may name a Component or a User, its
  `parent` a User, its `members` a Group, and a `spec.system` a Component. A hierarchy edge
  is read from a Group only and ends on a Group only, `owned-by`'s first hop is the owner
  alone (a Group or a User), `member-of` reads a User's Groups or a Group's parent Groups,
  `has-member` a Group's Users and child Groups, and `part-of` ends on a System or a Domain.
  Such a reference resolves to a node, so it is no row and never declared nowhere; what
  `show`'s card lists of it is 3.1's and unchanged.
- **An entity relation asked of an organisation node computes no row**, even where a
  `dependsOn` or a `providesApis` names the Group (it resolves, and makes the Group no
  dependency), and `between` is asked of two entities: `relations tiger --to billing-api`
  and `relations billing-api --to tiger` both answer `No entity named "tiger".`, as before
  3.2, since both ends of `--to` resolve through `resolveEntity`.
- **An organisation node's overview says a relation read only as a name**, in the relation's
  one line, where "no relation declared" alone would be false: `relations grace --repo
  tests/golden/organisation` prints `member of (0)` and the line that `group:default/ghost`
  is read as a name (exit 1). An entity's overview is unchanged: its relations carry none.

- [ ] **Step 5: The pull request** (after the owner's go-ahead)

```bash
git add src/core/schemas/query.ts src/context/graph/relations.ts src/context/graph/entity-graph.ts \
  src/context/README.md src/agents/tools/graph-tools.ts \
  src/cli/commands/relations.ts src/cli/render/relations.ts src/cli/index.ts \
  src/cli/README.md tests/unit/organisation-relations.test.ts tests/golden/relations-organisation \
  CHANGELOG.md AGENTS.md README.md docs/design.md docs/roadmap.md docs/plans/backstage-http-slice-3.md
git commit -m "feat(cli): trace ownership, membership and system membership with idpa relations"
```

Base `feat/bhttp-3-1`. CHANGELOG, `### Added`:

> - `idpa relations` traces the organisation: `--owns` and `--owned-by`, `--member-of` and
>   `--has-member`, `--part-of` and `--has-part` — what a team owns, down its child teams;
>   who owns an entity and the groups above them; a person's groups; what a System or a
>   Domain holds — each row with its whole path, read from both ends of a declaration, and,
>   against a catalogue, a reference naming nothing it serves marked where the path ends
>   ([#N](https://github.com/pcaboor/idp-agent/pull/N)).

**What changes that a person sees:** six new flags, and the two-flags refusal lists twelve
where it listed six. No existing output moves: an entity's relations and its no-flag overview
are `f8bcb43`'s, and a name an entity carries resolves to it as before.

**What the owner can run** (after `pnpm build`, from the clone):

```bash
node dist/cli/bin.js relations engineering --owns --repo tests/golden/organisation
# tests/golden/relations-organisation/engineering-owns.txt: domain:default/finance at
# depth 1; through tiger, billing-api, its grant, billing-db-prod and system:default/billing
# at depth 2; nothing through common; checkout-web is ada's, a User, not a child group, so
# it is not listed; each path starts at engineering                                (exit 0)
node dist/cli/bin.js relations billing-api --part-of --repo tests/golden/organisation
# system:default/billing at depth 1, domain:default/finance at depth 2             (exit 0)
node dist/cli/bin.js relations invoicing-worker --owned-by --repo tests/golden/organisation
# none: group:default/lion, the owner invoicing-worker names, is read as a name here: a
# declarations repository's Group files are not read as the whole organisation     (exit 1)
node dist/cli/bin.js relations billing-api --owned-by --demo
# none: group:default/tiger, the owner billing-api names, is read as a name here: this source holds no Group  (exit 1)
node tools/fake-backstage.ts --root tests/golden/organisation --no-org --port 7011   # in a second terminal
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js relations invoicing-worker --owned-by
# tests/golden/relations-organisation/invoicing-worker-owned-by.txt: one row, ending on
# group:default/lion, declared nowhere in the catalogue this token reads           (exit 0)
# stop it, then: the demo SI and org.yaml, on the same port
node tools/fake-backstage.ts --port 7011
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js relations tiger --owns
# the 14 entities of the demo SI tiger owns, each at depth 1                       (exit 0)
env -u IDP_BACKSTAGE_TOKEN -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7011/api/catalog node dist/cli/bin.js relations billing-api --owned-by
# group:default/tiger at depth 1, group:default/engineering at depth 2             (exit 0)
node dist/cli/bin.js relations mysql-prod-01 --impacts --demo
# tests/golden/relations-demo/mysql-prod-01-impacts.txt, byte for byte            (exit 0)
```

---

### Task 3.3: The Analyst's tools over the organisation

**Goal.** Over a source that holds an organisation, the Analyst finds Groups, Users, Systems
and Domains with `search_entities`, reads one with `get_entity`, walks the six relations with
`get_relations`, and may answer `relation` with one of them, the engine writing the block
`idpa relations` prints. The caps are today's. Over a source that holds none — the demo SI,
every tape's — its specs, its system prompt and the summary are `f8bcb43`'s, byte for byte.
An entity's row is `f8bcb43`'s over every source: an owner declared nowhere is learnt by
walking `owned-by`, never added to the entity's `danglingReferences`. Closed when "what does
team tiger own?" and "which system is billing-api in?" are answered, on a scripted client,
with the Group and the System witnessed.

**Files:**
- Modify: `src/core/schemas/query.ts` (`organisationSearchCriteriaSchema`,
  `organisationRelationsInputSchema`, `organisationAnswerSchema`; the three of today untouched)
- Modify: `src/agents/tools/graph-tools.ts` (`buildTools`' `organisation` option: the specs,
  `OrganisationRow`, `get_entity` over `node`, `unusedCriteria` over `nodes()` for the kinds
  it adds; the registry returns the answer schema it advertises)
- Modify: `src/agents/analyst.ts` (the answer is parsed with the registry's schema; one
  paragraph appended to `SYSTEM` when the registry reads the organisation)
- Modify: `src/context/graph/summary.ts`, `src/agents/summary.ts` (`SiSummary.organisation?`;
  one line, printed only when set)
- Modify: `src/cli/commands/ask.ts` (`buildTools(graph, { apis: true, organisation:
  graph.holdsOrganisation })`; `renderEntities` over `node`; `known` over `nodes()`; the
  `relation` outcome with an organisation relation)
- Modify: `src/agents/README.md`, `AGENTS.md`, `SECURITY.md` (the model-provider row: the
  organisation's names and memberships, when read), `README.md`, `CHANGELOG.md`,
  `docs/roadmap.md`, `docs/backstage-http-brief.md` (slice 3 **Built**)
- Create: `tests/unit/organisation-analyst.test.ts`

**Interfaces:**

```typescript
// src/core/schemas/query.ts
export const organisationSearchCriteriaSchema  // apiSearchCriteriaSchema's, kind: Component | Resource | API | Group | User | System | Domain
export const organisationRelationsInputSchema  // getRelationsInputSchema's, relation: [...RELATIONS, ...ORGANISATION_RELATIONS]
export const organisationAnswerSchema          // answerSchema's, the relation branch's enum widened the same way

// src/agents/tools/graph-tools.ts
buildTools(graph, { apis?: boolean; organisation?: boolean; refuseUnusedValues?: boolean }): {
  specs; run; witnessed; declaredNowhere
  /** The answer schema the registry advertises: the loop parses the answer with it. */
  answer: typeof answerSchema | typeof organisationAnswerSchema | typeof answerSchemaWithoutRelation
}
```

An `OrganisationRow` is `{ ref, name, kind, type?, owner?, parent?, children?, members?,
memberOf?, system?, domain?, subdomainOf?, owns?, danglingReferences? }` — no title, no
annotation, no profile, which 3.1 never reads: every list at most `QUERY_LIMITS.maxRows` (25)
with `…Truncated: "N more not shown"` beside it, as `danglingReferences` is bounded today;
`owns` is the count and the first 25 references; its `danglingReferences` are the node's own
judged ones (`unresolvedOrganisationOf`), joining `declaredNowhere`. Every reference a row
names that resolves is witnessed, as a row's `provides` is. An entity's row is built as today.

- [x] **Step 1: Pin the Analyst's registry and prompts without an organisation (passes now)**

In `tests/unit/organisation-analyst.test.ts`, first: `buildTools(graphOf(DEMO), { apis: true
})`'s `JSON.stringify(specs)`, the Analyst's `SYSTEM` and `formatSummary(...)` of the demo SI,
each hashed, equal constants measured on `f8bcb43`. Green on the unchanged tree; it and
`prompt-digests.test.ts` stay green after Step 3.

- [x] **Step 2: Write the tests (fail: no `organisation` option)**

```typescript
describe('the Analyst over a source that holds an organisation', () => {
  it('advertises the four kinds in search_entities, and the six relations in get_relations and answer, only then', …)
  it('finds a Group by kind and by name, its row bounded at 25 of each list, the cut stated', …)
  it('refuses a kind nothing carries, naming the kinds in use, the organisation’s included', …)
  it('witnesses the Group get_entity read, and the references its row resolves; never one declared nowhere', …)
  it('walks owns from group:default/tiger at 25 rows, stating the cut', …)
  // `between` with a Group at either end refuses naming that end, `ref` first (review fix).
  it('reads at most 25 names beside the rows, the cut stated, where the kind was not read whole', …) // review fix
  it('refuses a relation answer about a Group no tool returned', …)
  it('returns an entity’s row as f8bcb43 did: invoicing-worker’s carries no owner among its danglingReferences', …)
  it('sends no @, no directory id and no picture: a User served whole with microsoft.com/email and a profile', () => {
    // every tool result of a scripted conversation over it, and the summary, match none of /@|user-id|data:image/
  })
  // Review fix: an email written where a reference goes is counted, never shown.
  it('sends no @ written where a reference goes: a Group’s members and children, a System’s owner and domain, from a catalogue and from files', …)
})

describe('the two questions, end to end on a scripted client, over the fake serving tests/golden/organisation', () => {
  it('answers "what does team tiger own?" with idpa relations group:default/tiger --owns, byte for byte', async () => {
    const client = scripted([
      supervisorSays('QUESTION'),
      analystCalls({ name: 'search_entities', args: { kind: 'Group', nameContains: 'tiger' } }),
      analystCalls({ name: 'answer', args: { outcome: 'relation', ref: 'group:default/tiger', relation: 'owns' } }),
    ])
    const run = await idpa('what does team tiger own?', { catalogue: ORGANISATION, client })
    expect(run.code).toBe(0)
    expect(run.out).toBe(`${(await cli(['relations', 'group:default/tiger', '--owns', '--repo', ORGANISATION_DIR])).out}`)
  })
  it('answers "which system is billing-api in?" with the part-of block, system:default/billing witnessed', …)
  it('drops a conclusion naming group:default/engineering when no tool returned it', …)
  it('drops a conclusion using the word "platform" over a source holding a Group platform no tool returned, and keeps it where none is read', …)
  it('prints a card for an entities answer naming one Group, and a table for several', …)
})
```

`scripted` and the helpers are those `tests/unit/backstage-read.test.ts` answers a question
from the fake with (slice 1's "a question read from a catalogue is tested on a scripted
client"). Run: `pnpm vitest run tests/unit/organisation-analyst.test.ts`. Expected: the pins
green, the rest FAIL on `organisation` not being an option.

- [x] **Step 3: The registry, the loop, the summary, `ask`**

`buildTools`: with `organisation`, `search` is `organisationSearchCriteriaSchema`,
`get_relations` takes `organisationRelationsInputSchema`, `answer` advertises
`organisationAnswerSchema` with its description naming the six relations, and the three
descriptions say, in one sentence each, that Groups, Users, Systems and Domains are read here.
`search_entities` over an organisation kind searches `nodes()` of that kind (`type`,
`owner`, `nameContains`; `env` refused as unused, since none declares one). Without
`organisation`, not a byte moves.

`analyst.ts`: `answerQuestion` parses the answer with `tools.answer`; with the organisation
registry, `SYSTEM` gains one paragraph after the `relation` line: "owns", "owned-by",
"member-of", "has-member", "part-of", "has-part", each with the question it answers
("what a team owns", "which system an entity is in"…).

`summary.ts`: `summariseGraph` sets `organisation: { groups, users, systems, domains }` as
buckets when the graph holds one, and `formatSummary` prints `  organisation: groups 1-9,
users 1-9, systems 1-9, domains 1-9` after `resources` only then. Its `dangling references`
count stays `danglingReferences()`'s. The Supervisor reads it too: it is the summary both are
shown (`ask.ts:131`); the Architect's is built from the plan road's graph, which holds no
organisation (3.1), so its line never appears.

`ask.ts`: the registry as above; `renderEntities` re-reads each reference with `node`, a
single Group printing its card (3.1's renderer) and several a table whose missing columns are
`-`; `known` covers `nodes()`, so a sentence naming an organisation node no tool returned is
dropped (ADR-0008); the `relation` outcome hands an organisation relation to `runRelations`
as it hands `impacts`.

**The commentary check gains every organisation name, on purpose, and says so.** `namesOf`
(`src/core/answer/commentary.ts:268-291`) puts every known node's name and name parts in
`graph`, `parts` and `unwitnessed`. Over a source holding Groups named `platform`, `data` or
`security`, a conclusion sentence using the word as prose reads as naming an unwitnessed
Group and is dropped. It fails closed, which ADR-0008 asks, and it is only over a source that
holds an organisation (the demo SI's conclusions are unchanged, pinned by the scenarios); the
alternative — organisation nodes known only once a tool returned them — would let a sentence
name an unread team by its name, the guarantee ADR-0008 states. The pull request's "What
changes" says it, and Step 2's `platform` test pins it both ways.

**Exhaustive switches:** the `Answer` switch in `ask.ts`'s `block` and `analyst.ts`'s
`referencesOf` (the `relation` branch's type widens, its members do not change).

- [x] **Step 4: Checks**

```bash
df -h "$TMPDIR"
pnpm vitest run tests/unit/organisation-analyst.test.ts tests/scenarios
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git diff main -- tests/golden/architect-tools.json tests/recordings    # nothing
```

`tests/scenarios/` green means: `prompt-digests.test.ts` unchanged, and no plan-mode
warning.

- [ ] **Step 5: The pull request** (after the owner's go-ahead)

```bash
git add src/core/schemas/query.ts src/agents/tools/graph-tools.ts src/agents/analyst.ts \
  src/agents/summary.ts src/context/graph/summary.ts src/cli/commands/ask.ts src/agents/README.md \
  src/context/README.md tests/unit/organisation-analyst.test.ts tests/unit/organisation-graph.test.ts \
  tests/unit/api-analyst-tools.test.ts tests/support/offered-tools.ts AGENTS.md SECURITY.md README.md \
  CHANGELOG.md docs/design.md docs/roadmap.md docs/backstage-http-brief.md docs/plans/backstage-http-slice-3.md
git commit -m "feat(agents): let the Analyst read and walk the organisation, when the source holds one"
```

Base `feat/bhttp-3-2`. CHANGELOG, `### Added`:

> - Over a source that holds Groups, Users, Systems or Domains, the Analyst finds them, reads
>   them and walks ownership, membership and system membership with the tools and caps it
>   has, so "what does team tiger own?" and "which system is billing-api in?" are answered
>   with the relation block `idpa relations` prints; over a source that holds none, what it
>   is sent does not change ([#N](https://github.com/pcaboor/idp-agent/pull/N)).

**What changes that a person sees:** over a source holding an organisation, `ask` can answer
about teams, people, systems and domains; the summary gains one line; and a model's
conclusion that uses an organisation node's name as a common word, when no tool returned
that node, is dropped. Over a source holding none: nothing.

The roadmap: slice 3 leaves the queue; "Recordings that need the owner's key" gains the two
tapes of owner step R beside `question-backstage-owner`; the note's § 14 decision 3 (a
read-only widening of the Component and Resource read schemas) is recorded as not needed so
far. The note's slice 3 is marked **Built**, with this plan's departures: three pull requests;
the organisation read asks for the fields it reads (row 2); the judged-kind rule, catalogue
road only (row 6); a refused organisation document is set aside, not refused (Choices); the
demo's System question is answered on `tests/golden/organisation` (row 1).

**What the owner can run** (after `pnpm build`, from the clone): keyless, the scripted tests
above, and every command of 3.1 and 3.2, unchanged. With a key, owner step R.

```bash
pnpm vitest run tests/unit/organisation-analyst.test.ts tests/scenarios
# every test passes; prompt-digests.test.ts holds the digests of f8bcb43
```

---

### Owner step R: the keyed recordings (owner present, after 3.3 merges)

A new scenario cannot merge before its tape: a turn the tape does not hold is fatal
(`src/llm/recording.ts:65-71`), and a skipped scenario would be a green test that replayed
nothing. So the scenario file and its three tapes land together, in one pull request made
with the owner, `feat/bhttp-3-r` from `main` once 3.3 is merged.

`tests/scenarios/backstage-mode.test.ts` — `question-mode.test.ts`'s `run`, over a catalogue:

```typescript
const catalogue = (root: string, options: { org?: boolean } = {}) => ({
  env: { ...process.env, IDP_BACKSTAGE_URL: 'http://127.0.0.1:7007/api/catalog' },  // shell.ts removes the shell's own, recording or not
  catalogueFetch: fakeBackstage({ entities: catalogueOf(root, options.org === false ? {} : { org: ORG_YAML }) }).fetch,
})

it('answers who owns billing-api from a Backstage catalogue', async () => {        // question-backstage-owner (slice 1)
  const { code, out } = await run('question-backstage-owner', 'who owns billing-api?', catalogue(DEMO))
  expect(code).toBe(0)
  expect(out).toContain('group:default/tiger')
})
it('answers what team tiger owns with the relation block', async () => {           // question-organisation-owns
  const { code, out } = await run('question-organisation-owns', 'what does team tiger own?', catalogue(ORGANISATION, { org: false }))
  expect(code).toBe(0)
  expect(out).toContain('component:default/billing-api')
})
it('answers which system billing-api is in', async () => {                         // question-organisation-system
  const { code, out } = await run('question-organisation-system', 'which system is billing-api in?', catalogue(ORGANISATION, { org: false }))
  expect(code).toBe(0)
  expect(out).toContain('system:default/billing')
})
```

`fakeBackstage` is `tests/support/fake-backstage.ts:87`'s, as `backstage-read.test.ts:70-76`
hands its `fetch` in. Each asserts what holds whatever the model chose (the tape freezes one
sample), the trace agreeing with the stream, and no "prompt changed since recording"
warning, as `plan-mode.test.ts` does. The commands, one scenario at a time
(`tests/README.md`), with the owner's provider and model:

```bash
IDP_PROVIDER=<provider> IDP_MODEL=<model> <PROVIDER>_API_KEY=… IDP_RECORDING=record \
  pnpm vitest run tests/scenarios/backstage-mode.test.ts -t 'answers who owns billing-api from a Backstage catalogue'
IDP_PROVIDER=<provider> IDP_MODEL=<model> <PROVIDER>_API_KEY=… IDP_RECORDING=record \
  pnpm vitest run tests/scenarios/backstage-mode.test.ts -t 'answers what team tiger owns with the relation block'
IDP_PROVIDER=<provider> IDP_MODEL=<model> <PROVIDER>_API_KEY=… IDP_RECORDING=record \
  pnpm vitest run tests/scenarios/backstage-mode.test.ts -t 'answers which system billing-api is in'
pnpm vitest run tests/scenarios          # then, without the variables: replays, no key
```

Read each tape before committing it: it holds what the fake served, which is this
repository's own fixtures and demo data, and no company's. `IDP_BACKSTAGE_URL` and
`IDP_BACKSTAGE_TOKEN` are removed from the shell even while recording
(`tests/setup/shell.ts`), which is why the scenario hands its own URL and the fake as
`catalogueFetch`. The roadmap's three lines leave "Recordings that need the owner's key" in
the same pull request.

---

## Questions for the owner

All three settled by the owner on 2026-09-28, as recommended (recorded in
[`docs/roadmap.md`](../roadmap.md)'s decisions).

1. **Settled: an organisation document Backstage would refuse stays a warning, never an
   error as a refused API is.** A Group without `children`, a System without an `owner` is set
   aside with a `not-modelled` warning saying why, and one read is no longer warned about.
   This keeps the reason `rules.ts:189-192` gives ("a red build there would push people to
   move them out — or to delete them"), and keeps such a document from ever refusing a plan
   through the re-check (`recheck.ts:172-173`, `repair.ts:620-630`). Your IaC may hold
   Group files: before 3.1 merges, run `idpa validate <your IaC>` on `main` and on
   `feat/bhttp-3-1` and compare; the only expected difference is fewer warnings (and new
   wording for any refused one).
2. **Settled: people's names and groups may reach the model provider, from 3.3 on, with a
   `SECURITY.md` row.** Over a source with Users, a User's name and its groups reach the
   Analyst's tool results (3.3), and SECURITY.md says so. Nothing else of a User is read or
   requested — no annotation, no title, no profile (email, picture, display name) — and one a
   server sends anyway is dropped on arrival, the profile by the pre-pass, the rest by the
   reader: an email annotation, a directory id and a picture are never kept, printed or sent
   to a model. A name can still be an email in
   disguise: Backstage's Microsoft Graph provider names a User `normalizeEntityName(user.mail)`,
   so `ada.lovelace@acme.com` is `ada.lovelace_acme.com`; the row names this.
3. **Settled: three pull requests, not two** — 3.1 the nodes, 3.2 the relations, 3.3 the
   Analyst — plus the owner's keyed step R, and the note's "Closed by 3.2" reads "Closed by
   3.3" (the section above says why; the note's slice 3 text is fixed in 3.1).
