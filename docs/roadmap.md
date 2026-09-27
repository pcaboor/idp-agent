# Roadmap

Where the project stands, what comes next and in what order, what the owner decided, and
what is known to be left. There are no GitHub issues for now: open items live here, and in
[`AGENTS.md`'s Open questions](../AGENTS.md#open-questions), which records the questions
about the code itself.

What has already shipped is in [`CHANGELOG.md`](../CHANGELOG.md). What the 2026-09-23 review
found, and which of its findings are closed, is in its
[Status section](reviews/2026-09-23-deep-review.md#status).

*Updated 2026-09-27, `main` at `b9b204d`.*

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

**In order**, as the owner decided on 2026-09-23, 2026-09-25 and 2026-09-26. Each line says
what the item is for.

1. **Review priority 8, an exact "already declared".** The tool never asserts on exit 0 an
   access that does not exist.
2. **The `backstage-http` read provider: a design note and a stage plan.** Context read from a
   Backstage catalogue, where today it comes from a configured source.
3. **A sweep of the review.** Each finding no pull request names is classified still true,
   fixed or obsolete; the Status section is updated, and the cheap fixes still true are
   batched.
4. **A check of the owner's stage-5 plan** against the review's stage-5 readiness findings and
   the current `main`, read only: what it covers and what it misses. It includes **which
   repository a `FileEdit` writes to**, the part of gap-stage5-readiness-8 review priority 9
   left to stage 5 ([#82](https://github.com/pcaboor/idp-agent/pull/82)): `init`'s
   edit names a file in the service's repository and `plan`'s one in the declarations
   repository, and nothing in the shape says which — `init`'s `before` is now read whole
   outside the budget, so only the identity is left. The plan's clearance must also file
   where `init` files: `asCatalogInfo` keeps its one argument, but `init` then moves the
   operation to `targetOf`'s choice over `ProjectRead.declarations` (`filedIn`) — the root's
   `.yml`, or the one catalog-info kept elsewhere — so a `readCatalogInfo` that reads only the
   root's `catalog-info.yaml` would bring back the twin and the capped `before` this removed.
5. **Stage 5, write + local branch.** The first write, atomic and idempotent. The owner's own
   work, on branch `feat/s5-cleared`, at the owner's pace.

**Not yet ordered.**

- **Stage 6, GitHub pull request.** A real forge, and the pull request as the act of
  authorisation (ADR-0006).
- **Stage 7, Ink TUI, asciinema, npm publish.** The Claude-Code-like chat in the terminal
  that the owner set as the project's end goal (2026-09-23).
- **The `backstage-http` read provider itself**, once its design note and plan (item 2) are
  agreed.
- **Stage 8, discovery** ([the design note](stage-8-brief.md)). From any
  service repository, generate its catalog-info and discover the dependencies it already
  has, with evidence.

The one order stated beyond these five is stage 8's own, in its design note (section 11):
priorities 6 (done, [#79](https://github.com/pcaboor/idp-agent/pull/79)), 7 (done,
[#80](https://github.com/pcaboor/idp-agent/pull/80)), 8 as queued, 9 (done,
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

## How this file is kept

It is updated in the pull request that changes any of it: one that closes a queue item, a
debt or an open question, or that records a decision of the owner's, edits this file in the
same diff. A decision is written in the owner's
terms, dated, with the pull request or ADR that carries it; nothing is added here that the
repository cannot show. The rule is in [`AGENTS.md`](../AGENTS.md#conventions).
