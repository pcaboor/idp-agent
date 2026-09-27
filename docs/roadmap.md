# Roadmap

Where the project stands, what comes next and in what order, what the owner decided, and
what is known to be left. There are no GitHub issues for now: open items live here, and in
[`AGENTS.md`'s Open questions](../AGENTS.md#open-questions), which records the questions
about the code itself.

What has already shipped is in [`CHANGELOG.md`](../CHANGELOG.md). What the 2026-09-23 review
found, and which of its findings are closed, is in its
[Status section](reviews/2026-09-23-deep-review.md#status).

*Updated 2026-09-27, `main` at `05356af`.*

## Where the project stands

The stages are the README's [roadmap table](../README.md#roadmap). Their state, in one line
each:

| # | Stage | State |
|---|---|---|
| 0 | Foundations | done |
| 1 | Read-only | done |
| 2 | Question mode | done |
| 3 | `init platform` and `validate` | done |
| 4 | Preview only: nothing is written | done |
| 5 | Write + local branch | in progress: the owner's own work, not on `main` |
| 6 | GitHub pull request | not started |
| 7 | Polish: Ink TUI, asciinema, npm publish | not started |
| 8 | Discovery | designed ([the design note](stage-8-brief.md), [#76](https://github.com/pcaboor/idp-agent/pull/76)); not started |

Since stage 4, the work has gone into the review's priorities and into the question half of
the product: `--repo` and a configured source, the one gesture `idpa "<phrase>"`, answers
framed in the model's words, Backstage APIs, the relations view, and tracing into MLflow.

## The queue

**In order**, as the owner decided on 2026-09-23, 2026-09-25, 2026-09-26 and 2026-09-27.
Each line says what the item is for. The sweep of the review is done
([its verdicts](reviews/2026-09-23-deep-review.md#the-sweep-2026-09-27)); its batches are
here, one pull request each, each naming the check run together at the end.

1. **Batch A2, tests that cannot pass on nothing.** tests-12, architecture-11,
   gap-stage5-readiness-9, tests-7, tests-8, tests-11, core-plan-13, security-10, tests-9:
   the architecture rules fail on an empty tree or an unresolved import and name who may
   write; the offline guard covers `http`, `net`, `tls` and `WebSocket`; the suite ignores
   the contributor's `IDP_*` and key variables; the audit attacks read `tests/recordings`;
   a real key's shape is caught in a tape; `tests/README.md` explains a stale tape. Check:
   `pnpm test` stays green with `IDP_PROVIDER` and `IDP_MODEL` exported.
2. **Batch A3, build, CI and documentation drift.** build-ci-3, build-ci-2, build-ci-5,
   build-ci-7, build-ci-8, product-gap-14, architecture-12, gap-stage5-readiness-14, docs-9,
   domain-backstage-9, docs-3, security-9, cli-ux-14: a clean `dist/` and a `prepack`, smoke
   from the packed tarball, version `0.1.0-rc.2`, least privilege in both workflows, POSIX
   paths on Windows, the gate order written as the code runs it (recheck before the
   Reviewer), in AGENTS.md and in SECURITY.md's guarantee table, and `src/cli/README.md` no
   longer saying `show` takes the first entity of a shared name. Check: `pnpm build && pnpm
   smoke`, and `npm pack --dry-run` lists no stale file.
3. **Batch A4, what the plan engine lets vouch and dispatch.** wip-diff-1, wip-diff-4,
   wip-diff-10, wip-diff-8, wip-diff-9, core-plan-10, gap-stage5-readiness-2,
   gap-stage5-readiness-7, domain-backstage-10: an operation no longer vouches for itself or
   for a Component the edits drop; `planEdits` and the gates switch exhaustively; a
   `create-catalog-info` path must be a catalog-info inside the repository; `init platform`
   says what it wrote before a failure; the graph resolves a duplicate as the plan does.
   Check: the new `sign.test` cases, and the plan-mode tapes still replay clean.
4. **Batch A5, the read side and the provider calls.** gap-ask-grounding-6,
   gap-ask-grounding-7, gap-ask-grounding-11, domain-backstage-7, gap-init-real-repos-9,
   gap-provider-matrix-6, agents-llm-10, product-gap-10: repository text flattened before a
   prompt; a decorated Supervisor word accepted; the truncation note of the search cited;
   `title`, `labels` and `subcomponentOf` read; `read_file` paths normalised; `store: false`
   at OpenAI; an optional abort signal; one usage line per run. Check: the provider contract
   test, and the question tapes replay with the bytes they had.
5. **`backstage-http` slice 1: questions and relations against a Backstage.** The provider
   reads a catalogue over HTTP ([the design note](backstage-http-brief.md), slice 1), first
   demonstrated against the fake Backstage on `127.0.0.1:7007`.
6. **A real Backstage in Docker, for the demo.** One `docker compose up` starts a pinned
   Backstage holding the demo SI, registered through slice 0's Location, with a read token,
   so an evaluator sees the catalogue's pages and `idpa` querying the same Backstage (a
   built image or a maintained community image: decided then).
7. **`backstage-http` slice 3: the organisation in the read model.** Groups, Users, Systems
   and Domains read, so the agents see real owners and the systems services belong to.
8. **A check of the owner's stage-5 plan** against the review's stage-5 readiness findings and
   the current `main`, read only: what it covers and what it misses. It starts with an
   **analysis of the owner's uncommitted stage-5 work** on `feat/s5-cleared`, written on
   `eee67d6` before more than forty pull requests: what still applies, what `main` made
   obsolete, what must be redone; its ADR becomes 0010. The result is shown to the owner
   before a line of stage 5 is written. It includes **which
   repository a `FileEdit` writes to**, the part of gap-stage5-readiness-8 review priority 9
   left to stage 5 ([#82](https://github.com/pcaboor/idp-agent/pull/82)): `init`'s
   edit names a file in the service's repository and `plan`'s one in the declarations
   repository, and nothing in the shape says which — `init`'s `before` is now read whole
   outside the budget, so only the identity is left. The plan's clearance must also file
   where `init` files: `asCatalogInfo` keeps its one argument, but `init` then moves the
   operation to `targetOf`'s choice over `ProjectRead.declarations` (`filedIn`) — the root's
   `.yml`, or the one catalog-info kept elsewhere — so a `readCatalogInfo` that reads only the
   root's `catalog-info.yaml` would bring back the twin and the capped `before` this removed.
9. **Stage 5, write + local branch.** The first write, atomic and idempotent — taken on from
   the owner's plan and branch, discarding nothing already written, once the check above is
   agreed.
10. **Batch B1, the invariant generators.** core-yaml-6, gap-stage5-readiness-11, tests-3:
    hand-written files in every shape, and `signPlan` properties over plans valid by
    construction. `tests/invariants/arbitraries.ts` and `core.test.ts` are also edited on
    `feat/s5-cleared`, so it goes on top of stage 5.
11. **Batch B3, physical confinement.** core-yaml-5, runtime-probe-11,
    gap-stage5-readiness-4: one lstat, realpath and `O_NOFOLLOW` primitive shared from
    `project-fs`, used by `scaffold/write.ts` and by the iac-fs walk, which rejects a
    symbolic link by name. Medium, and what stage 5's writer will need.
12. **Batch B2, the recording harness, offline.** tests-5, wip-diff-12, tests-6, and the
    harness half of agents-llm-9: record from an empty tape, fail on a turn never replayed,
    and digest the JSON Schema the provider is sent. It needs no key, but it prunes dead turns
    and rewrites every tape's digest, so it waits for the owner's go-ahead.
13. **`backstage-http` slice 2: large catalogues and the cache.** Before a real, large
    catalogue is plugged in.
14. **Stage 6, GitHub pull request.** A real forge, and the pull request as the act of
    authorisation (ADR-0006).
15. **Stage 8, discovery** ([the design note](stage-8-brief.md)), with `backstage-http`'s
    slices 4 and 5. From any service repository, generate its catalog-info and discover the
    dependencies it already has, with evidence.
16. **Stage 7, Ink TUI, asciinema, npm publish.** The Claude-Code-like chat in the terminal,
    the project's end goal (2026-09-23).

Within stage 8, its design note (section 11) states its own order:
priorities 6 (done, [#79](https://github.com/pcaboor/idp-agent/pull/79)), 7 (done,
[#80](https://github.com/pcaboor/idp-agent/pull/80)), 8 (done,
[#83](https://github.com/pcaboor/idp-agent/pull/83)), 9 (done,
[#82](https://github.com/pcaboor/idp-agent/pull/82)), and stage 5's first two tasks; then slice 1,
which needed only priority 7 and can start now; then slices 2 and 3, and submission.
Submitting rights for a Component declared in its own service repository needs the
`backstage-http` provider, and submission needs stages 5 and 6.

## Decisions

The owner's decisions, dated, each with where it is recorded.

**2026-09-23**

- The project is an open-source portfolio piece that employers must be able to try
  plug-and-play with an OpenAI, Anthropic or Mistral key; it turns natural-language intents
  into infrastructure through Backstage and answers questions about the information system.
  Its end goal is a Claude-Code-like chat in the terminal (stage 7). Stated in the owner's
  brief for the deep review.
- A multi-agent deep review ranked ten priorities. The foundation is fixed before plugins,
  in that order ([the review](reviews/2026-09-23-deep-review.md),
  [#43](https://github.com/pcaboor/idp-agent/pull/43)).

**2026-09-24**

- An unknown kind under Backstage's own apiVersion is refused; a kind of another tool is set
  aside ([#49](https://github.com/pcaboor/idp-agent/pull/49)).
- Short Backstage references are normalised on read
  ([#53](https://github.com/pcaboor/idp-agent/pull/53)).
- A request to describe the catalogue as a whole gets an overview the engine writes
  ([#54](https://github.com/pcaboor/idp-agent/pull/54)).

**2026-09-25**

- The product has two uses: `init platform` creates the declarations repository once, then
  `idpa` is used from anywhere with one gesture, `idpa "<phrase>"`
  ([#63](https://github.com/pcaboor/idp-agent/pull/63)).
- Context comes from a configured source today
  ([#60](https://github.com/pcaboor/idp-agent/pull/60)), and from Backstage later.
- Answers read like a chat: an AI introduction, the engine-verified block, an AI conclusion,
  witness-checked and labelled
  ([ADR-0008](adr/0008-commentary-crosses-labelled.md),
  [#64](https://github.com/pcaboor/idp-agent/pull/64)).
- Backstage APIs must be read: `kind: API` nodes and `providesApis`. `consumesApis` is
  deliberately not read, because consumption is expressed by access rights, which are what
  gets provisioned ([#71](https://github.com/pcaboor/idp-agent/pull/71)).
- The order after the unified entry: the answers' explanations, then Backstage APIs, then
  review priority 6, then the `backstage-http` design note and stage plan (the first two
  merged as [#64](https://github.com/pcaboor/idp-agent/pull/64) and
  [#71](https://github.com/pcaboor/idp-agent/pull/71)).

**2026-09-26**

- Tracing every dependency and knowing everything about relations is the framework's added
  value: the relations view ([#74](https://github.com/pcaboor/idp-agent/pull/74)).
- A reference that names nothing is shown, never hidden nor resolved by guess
  ([#73](https://github.com/pcaboor/idp-agent/pull/73)).
- A level the user answered is never widened
  ([#72](https://github.com/pcaboor/idp-agent/pull/72)).
- Review priority 10, first contact, moves up: right after the small batch
  ([#75](https://github.com/pcaboor/idp-agent/pull/75)) and before priority 6; priorities 7
  to 9 follow 6, then the `backstage-http` design note and stage plan.
- The Supervisor classifies with a low reasoning effort, with an optional
  `IDP_SUPERVISOR_MODEL` ([#75](https://github.com/pcaboor/idp-agent/pull/75)).
- Stage 8, discovery, is added: from any service repository, generate its catalog-info and
  discover the dependencies it already has, with evidence. Decided: Node first, and exit 1
  for an empty result with incomplete coverage
  ([#76](https://github.com/pcaboor/idp-agent/pull/76)).
- Stage 8's remaining questions are answered as recommended: the `--project` rename in stage
  8; a new Component's place is a setting, central by default; the declarations merge request
  waits for a declared consumer; the `idp-agent.dev/` prefix; per-folder CODEOWNERS; the
  account is part of a grant's identity; no new resource types in v1; labelled environment
  hints; deterministic extractors only in v1
  ([the note's section 13](stage-8-brief.md), [#76](https://github.com/pcaboor/idp-agent/pull/76)).
- The order after review priority 9: a sweep of the review's remaining findings (still true,
  fixed or obsolete, with the Status updated and the cheap fixes batched), then a check of the
  owner's stage-5 plan against the review's stage-5 readiness findings and the current
  `main`, then stage 5.
- The `backstage-http` read provider's design note and stage plan come right after review
  priority 9, before the sweep. The owner sees it as a major step: it widens the agents'
  context to the whole catalogue — real owners, systems, every service repository's
  declarations — while Backstage's content stays untrusted input.
- No GitHub issues for now: open items are tracked in this file.

**2026-09-27**

- An environment is never taken from the request's words, like an access level; it comes
  from the declaration of the target the person designates by full reference, or from an
  answer. Otherwise it is asked, the environments in use listed. A negation lexicon is kept
  only as a veto on that pointing
  ([#81](https://github.com/pcaboor/idp-agent/pull/81)).
- The `backstage-http` design is accepted as recommended: the catalogue read before the
  model into the same graph, a static read token limited to `catalog.entity.read`, entities
  the tool does not model set aside and counted, catalogue content to the model provider
  stated in SECURITY.md and the README, a disk cache and `--cached` in slice 2, and a row
  after stage 6 ([the note's section 14](backstage-http-brief.md),
  [#84](https://github.com/pcaboor/idp-agent/pull/84)).
- A company without Backstage is fully served by the declarations repository; installing a
  Backstage is not the tool's responsibility, but adopting one must take a single
  registration: slice 0 ([#84](https://github.com/pcaboor/idp-agent/pull/84)); built — `init
  platform` writes the registration and [a page](adopting-backstage.md) says how to register
  it ([#86](https://github.com/pcaboor/idp-agent/pull/86)).

- A company's production Backstage stays out of the tool's scope, but a Backstage for
  evaluating the project is the tool's to provide: a recruiter will not install one. A real
  Backstage in Docker, preloaded with the demo SI, comes right after `backstage-http`'s
  slice 1 ([#86](https://github.com/pcaboor/idp-agent/pull/86)).
- The Backstage registration covers `components/` too, where the demo SI and the owner's
  repository keep their Components ([#86](https://github.com/pcaboor/idp-agent/pull/86)).

- The queue after batch A5: `backstage-http` slice 1, then the Docker demo Backstage, then
  slice 3; the stage-5 check, which first analyses the owner's uncommitted stage-5 work
  against today's `main`; stage 5, which Claude takes on from the owner's plan and branch;
  batches B1, B3 and B2; slice 2; stage 6; stage 8 with slices 4 and 5; stage 7
  ([#87](https://github.com/pcaboor/idp-agent/pull/87)).

## Known debts and open items

Each was checked against `main` at `3b642fa`.

**First contact, left from review id docs-2**

- A repository-contract document (what a declarations repository must hold), a "wire it
  into Backstage" section, and the `credentials.json` the design mentions are not written
  (review priority 10 closed the rest in [#78](https://github.com/pcaboor/idp-agent/pull/78)).

**The secret filter, left from review priority 7**

Checked against this change ([#80](https://github.com/pcaboor/idp-agent/pull/80)).

- **A directory outside git is walked, not refused.** security-3 asked for a git root;
  `readProject` falls back to the walk, with every name, content and size rule, when git
  says the directory is in no repository, and the CLI says so on stderr. Refusing would
  inspect nothing in a service not committed yet, and in every plan-mode recording's
  application repository, which is a temporary directory; changing the fixture changes what
  the recordings were sent (`tracking` in `src/context/project-fs/snapshot.ts`).
- **`init` inspects a directory with no service marker.** `plan` skips one (#63); `init`
  refuses only the home directory and the filesystem root, so `init` run from
  `~/Documents` hands that tree to the Inspector (`initRoot` in `src/cli/repository.ts`).
- **Nothing announces how many files the provider may read** before a run (security-3's
  "N files readable by <provider>").
- **The content filter sees only what it lists** (`src/context/project-fs/secrets.ts`,
  whose header keeps the list): a password under six characters; a literal under a key
  that does not name a secret (`DB_URL: <literal>` with no `user:password@` in it, a `dsn:`,
  `auth:` outside a docker `auths` object); a token format not listed (a Stripe test key,
  Twilio, Datadog…); a value taken for code — a type, a call, a member access, an
  identifier naming a secret, a plain lowercase word after a spaced key; a syntax not
  parsed — a YAML anchor's value, a `\`-continued or folded value, `mysql -pX`, a heredoc,
  a concatenated string; and an encoding past one base64 layer or a `\u` escape. The review
  suggested a maintained pattern set (gitleaks) and an allow list of what the Inspector
  needs; neither is built.
- **A file is withheld whole, never redacted.** A `docker-compose.yml` with one literal
  development password (`POSTGRES_PASSWORD: postgres`) is lost to the Inspector with
  everything else it states. Masking the value is the review's other suggestion; it trades
  a lost file for a file with a hole the model cannot see.
- **A repository git cannot list is read as nothing**, and so is one whose listing passes
  32 MiB (about half a million files) or 15 seconds (`GIT_LIMITS`). The reason is on the
  Inspector's opening line and on stderr.

**`init`, left from review priority 9**

Checked against this change ([#82](https://github.com/pcaboor/idp-agent/pull/82)).

- **No `--type`.** A Component type no file states is asked at a terminal; with nobody to
  ask, the run ends on that question and says the field has no flag.
- **`.idp-agent.yml` is never sent to the Inspector.** It is a hidden file, which
  `project-fs` withholds, and the plan-mode recordings were made with it withheld; the
  engine reads it (`readConfig`).
- **An existing declaration is never amended.** A Component the service's catalog-info
  already declares is reported as declared on exit 0 even when the draft proposes another
  owner or lifecycle: `init` adds a declaration, it does not rewrite one.
- **A catalog-info in a hidden folder is not seen.** The walk that finds declarations skips
  hidden folders, as it must for what a model is sent, so a `.backstage/catalog-info.yaml`
  is neither recognised nor added to, and a new root file is previewed beside it.
- **A `kind: Location` is not followed.** A root catalog-info that points elsewhere is read
  for what it declares itself; the files its targets name are read only when they are
  catalog-info files too.
- **A same-named Component in a workspace's catalog-info counts as declared.** It is read
  like the service's own; in a monorepo it is most often another service's name.
- **The declarations repository is still not read at `init` time**, so a Component declared
  there and not in the service's own catalog-info is proposed again (stage 8, slice 3).

**Recordings that need the owner's key**

- **The question-mode recordings are stale.** `tests/recordings/question-*.json` warn "the
  prompt changed since recording" on the Analyst's turn. They have been stale since
  [#54](https://github.com/pcaboor/idp-agent/pull/54), which changed the Analyst's prompt
  and answer tool ([#55](https://github.com/pcaboor/idp-agent/pull/55) says so). They still
  replay and pass. A re-record needs the owner's key, and #54 suggests recording a
  `question-overview` scenario at the same time.
- **Commentary on plans is not built** (ADR-0008, "Consequences"). It changes what plan mode
  sends, and `tests/scenarios/plan-mode.test.ts` fails on a stale plan-mode recording, so it
  waits for a re-record with a key.
- **The Reviewer is told an update already declared "would be written"** (review id
  wip-diff-2). Since [#83](https://github.com/pcaboor/idp-agent/pull/83) the re-check
  finds an `add-dependency-of` whose consumer the grant already lists at the stated level
  `already-declared`, and the CLI says so, naming the file; `effectsOf` in
  `src/agents/repair.ts` still tells the Reviewer that update "would be written to the
  repository". The recorded `link-already-declared` scenario is exactly that update, so
  saying "changes nothing" stales its Reviewer turn; it waits for a re-record.
- **No Anthropic recording exists.** The nine recordings are OpenAI's and Mistral's; the
  provider contract test checks Anthropic's request shape, not a live run.
- **The Architect is told the user's answers only when a refusal is at them.** Listing them
  on every repair report would let it converge sooner, but changes what it is sent after an
  answered round and stales the `link-db-missing` recording
  ([`AGENTS.md`'s Open questions](../AGENTS.md#open-questions);
  [#61](https://github.com/pcaboor/idp-agent/pull/61)).
- **The Architect's searches on a value nobody uses still answer empty.** The Analyst's are
  refused with the values in use; turning that on for the Architect is an open decision,
  because four of the five plan-mode recordings search on such values and would need
  re-recording ([#55](https://github.com/pcaboor/idp-agent/pull/55);
  `refuseUnusedValues: false` in `src/cli/commands/plan.ts`).

**Behaviour**

- **An update extending a grant over another thing than the one asked for is already
  declared** (left from review priority 8). "Already declared" reads the operation, not the
  request: a request for `resource:default/orders-db-prod` whose draft extends a grant over
  `payments-db-prod` that already lists the consumer ends on "nothing to change — the
  repository already says it", exit 0. Since
  [#83](https://github.com/pcaboor/idp-agent/pull/83) the grant's `dependsOn`, type
  and owner are printed beside it (`consumerRestatement` in `src/core/plan/grant.ts`), so a
  reader can see it; nothing refuses it. A gate would compare what the grant is over with
  what the request points at (`requestedEnvironment`'s reading in
  `src/core/plan/environment.ts`), which is known only when the request names the thing by
  its reference in full; a bare name is the Reviewer's to judge, and `plan --from` has no
  Reviewer.
- **The demo SI has no `kind: API` entity** (`fixtures/si-demo/`):
  [#71](https://github.com/pcaboor/idp-agent/pull/71) left it untouched. The summary `ask`
  sends lists the kinds in use (`src/context/graph/summary.ts`), so adding one changes what
  the question-mode recordings were taken over.
- **Priority 4's remainder: Component and Resource are read by the strict schema.** An
  upper-case name, a Component lifecycle outside `experimental`, `production` and
  `deprecated`, and an apiVersion other than `backstage.io/v1alpha1` are refused
  (`src/core/schemas/entity.ts`), where Backstage accepts them: the part of review id
  domain-backstage-1 that [#49](https://github.com/pcaboor/idp-agent/pull/49) left, on
  purpose ("being stricter than Backstage for the two kinds it manages is what `validate`
  is for"). [#53](https://github.com/pcaboor/idp-agent/pull/53) names case-insensitive
  names out of scope.
- **`get_apis` does not witness the reference it was asked about.**
  [#75](https://github.com/pcaboor/idp-agent/pull/75) made `get_dependencies` witness its
  starting entity on the Analyst's registry; `get_apis` witnesses only the rows it returns
  (`src/agents/tools/graph-tools.ts`).
- **The `reapplied` and `overridden` lines repeat once per question round.** The terminal
  sink deduplicates only `derived` lines ([#75](https://github.com/pcaboor/idp-agent/pull/75);
  `progress` in `src/cli/index.ts`).
- **`plan --repo` ignores `MainDeps.cwd`** (review `runtime-probe-15`, left open in
  [#46](https://github.com/pcaboor/idp-agent/pull/46)). A relative `--repo` is resolved
  against `process.cwd()`; the two agree in every real run.
- **An update's environment answer follows its access, and only its access.** Answered for
  billing-api's access to `orders-db-prod`, it does not follow a redraft that joins
  billing-api to a grant over `orders-db-dev` — another access — so that environment is
  asked again, naming the grant the redraft chose: the safe direction, and a second prompt
  ([#79](https://github.com/pcaboor/idp-agent/pull/79); `src/core/plan/reapply.ts`).
- **A stop over an update's answered environment does not say the value was the user's.**
  It closes on "Name the value the gate could not accept": the kept block reads the refused
  path, and the refusal is at `entityRef`, where the remedy is
  ([#79](https://github.com/pcaboor/idp-agent/pull/79); `keptLines` in
  `src/cli/commands/plan.ts`).
- **A grant that declares no environment and no level is asked about, and its answer is
  held to nothing.** Its environment is that of what it is over, and what a grant is over is
  read for levelled grants only (`GrantedOver`), so for a network flow declaring no
  environment the question shows none as the draft's and no policy compares the answer
  ([#79](https://github.com/pcaboor/idp-agent/pull/79); `scopeOf` in
  `src/core/plan/environment.ts`).
- **The negation veto is a list, and a list is never complete.** An environment is no
  longer read from a request's words at all
  ([#81](https://github.com/pcaboor/idp-agent/pull/81)), so a negation it misses no
  longer names an environment; what remains is the pointing. A request holding a negation
  marker anywhere points at nothing, and the markers cover the languages and phrasings
  `NEGATIONS` lists (`src/core/plan/negation.ts`), accents read on neither side. A negation
  in any other language or phrasing, beside a reference in full — "…, prod 안 돼,
  resource:default/orders-db-prod" — still points, at the declaration the person named,
  whose environment the diff shows before the merge, unless a word of it says another
  environment, which cancels the pointing on its own. It fails closed, and the cost is
  stated: an unrelated "no" beside a reference asks, a name or ticket carrying a marker
  segment (`no-reply-api`, `PAS-123`) withdraws a pointing too, and so does a word spelling
  another environment anywhere ("the dev team").
- **Joining a consumer to a network flow is always asked its environment.** Only a
  levelled grant is read for what it is over (`GrantedOver`), so an update extending a
  `network-access` right points at nothing even when the request names what it is over in
  full ([#81](https://github.com/pcaboor/idp-agent/pull/81)); a creation of one does
  point. Asked, the safe direction.
- **The mention check does not fold confusables.** A mention written with a lookalike letter
  (a Cyrillic `о` in `оrders-db-dev`) escapes the veto; the request must still name the target
  by full reference, so the environment reached is the one referenced
  (`src/core/plan/environment.ts`).
- **A Hangul filler (U+3164), which renders as a blank, is removed like other invisible
  characters,** so `pro<filler>d` reads `prod` (`fold` in `src/core/plan/echoes.ts`).
- **Only the repository's environments are environment words.** A word states no
  environment, and one saying another than the declaration pointed at cancels the pointing
  — but only an environment the vocabulary or a document names: "staging" or "development"
  in a repository whose environments are dev and prod does not, so "…
  resource:default/orders-db-prod in staging" still points at prod, which the diff shows
  (`contradicts` in `src/core/plan/environment.ts`, design §5.3).
- **Every diff writes the demo company's `company.fr/env` annotation**
  (`ENV_ANNOTATION` in `src/core/schemas/vocabulary.ts`). Making it configurable is stage 8's
  question 6.

**Open questions**

- **Should a mistyped command followed by words be caught before the model?** Today it is
  not, by design: the typo guard judges a one-word phrase only, because "a sentence is never
  a typo" (`parsePhrase` in `src/cli/index.ts`), and the "did you mean" hint is said only
  once a phrase could not reach a model, because "a phrase that reached a model was the
  model's to classify" (`slipHint`). So `idpa relatoins billing-api` reaches the Supervisor
  when a model is configured.

**Tracing follow-ups, named in [#70](https://github.com/pcaboor/idp-agent/pull/70)**

- A recording's `call` holds the transcript by reference, so it shows the final transcript
  (`src/llm/runtime.ts`). The digest is unaffected.
- When `repair()` runs again within one `plan`, attempt names restart at 1; no round
  attribute tells them apart.
- MLflow's protobuf `partialSuccess` is not decoded; only a JSON one is reported.

**Left from the sweep of the review**

Checked against `main` at `05356af`. The fix sketched for each is in the review's
[sweep](reviews/2026-09-23-deep-review.md#the-sweep-2026-09-27).

*Waits for a re-record only.* agents-llm-6 (a turn given back is not forced), agents-llm-7
(the `propose` description asks for the empty list the schema refuses), agents-llm-8 (the
Architect cannot read the plan it must repair), wip-diff-5 (the Reviewer's SYSTEM does not
name its four inputs; with wip-diff-3), gap-ask-grounding-5 (`consumers` says "any chain";
`nameContains` is case-sensitive), gap-ask-grounding-12 (the Supervisor is sent the whole
vocabulary), product-gap-6 (no offset and no system, lifecycle or tag criteria in a search).

*Waits for the owner.*

- **Answering without a terminal.** cli-ux-5, core-plan-11, product-gap-11,
  runtime-probe-9: one `plan --answer <path>=<value>` (or `--answers file.json`); the owner
  picks its shape.
- **One evaluation for every route.** architecture-1, gap-stage5-readiness-10: a shared
  `evaluatePlan()`, and whether `plan --from` gets a Reviewer or the docs say it has four
  gates.
- **For the stage-5 check.** core-plan-9 and gap-stage5-readiness-5 (an `ApprovedChange`
  minted after the five gates), gap-stage5-readiness-3 (the base is a commit, not the
  working tree), gap-stage5-readiness-12 (a plan identity; design §4.3 reworded),
  gap-stage5-readiness-13, cli-ux-10, cli-ux-12, architecture-9 and product-gap-13 (a
  structured preview, a Confirm seam, a versioned `--json`, a session ADR before the
  confirmation contract is fixed).
- **The environment annotation and namespaces.** core-plan-8, domain-backstage-6,
  product-gap-5 (stage 8's question 6), architecture-5 and gap-ask-grounding-9 (one
  `refOf`/`parseRef` keeping the namespace; product-gap-4 needs no decision but goes with
  them).
- **Providers.** agents-llm-4, architecture-8 and product-gap-9 (an `openai-compatible`
  adapter, a model per agent, an Anthropic recording), gap-provider-matrix-7 (tool errors
  and reasoning in the transcript), agents-llm-2 (a context and call budget).
- **Recordings and what the scenarios pin.** agents-llm-9, tests-4, wip-diff-6,
  gap-ask-grounding-13, and wip-diff-7 with tests-2 (pin each replayed exit code and diff).
  Batch B2 waits for a go-ahead too.
- **What the Reviewer and the Analyst may accept** (each also a re-record). wip-diff-3 (the
  Reviewer vetoes declaring a missing resource the request needs; high), security-6 (no rule
  ties a grant's consumer and target to the request), gap-ask-grounding-2, -3, -4 and -8
  (witnesses, `nothing`, `holds` and `count` outcomes, `ask` forcing the read road).
- **`init`.** security-5 and gap-init-real-repos-5 (an Inspector fact placed only when a
  file states it), gap-init-real-repos-7 (monorepo root context; `auth/` folders skipped),
  gap-init-real-repos-10 (read the git remote, or drop it from design §7.3).
- **Scope and documents.** docs-6 (a keyless `idpa tour`), docs-7 and product-gap-7 (what
  the tool produces and what it does not), docs-8 and architecture-7 (an extension guide;
  plugins after the foundation), product-gap-8 (the registry, closed for v1), docs-10 (the
  audit report's unreachable commit), cli-ux-13 (`iacRepo`, required and never read).
- **Toolchain and release.** build-ci-10 (a linter and formatter), build-ci-9 (a dependency
  policy), build-ci-6 (reserving the npm name).

*Belongs elsewhere.* domain-backstage-8 (a bound on each vocabulary list) is `backstage-http`
slice 1; gap-stage5-readiness-6 (compare before writing) is stage 5's writer; architecture-10
(one bounded agent loop) and the rest of architecture-6 (exhaustive dispatch beyond batch A4)
are refactors left unordered.

## How this file is kept

It is updated in the pull request that changes any of it: one that closes a queue item, a
debt or an open question, or that records a decision of the owner's, edits this file in the
same diff. A decision is written in the owner's
terms, dated, with the pull request or ADR that carries it; nothing is added here that the
repository cannot show. The rule is in [`AGENTS.md`](../AGENTS.md#conventions).
