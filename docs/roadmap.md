# Roadmap

Where the project stands, what comes next and in what order, what the owner decided, and
what is known to be left. There are no GitHub issues for now: open items live here, and in
[`AGENTS.md`'s Open questions](../AGENTS.md#open-questions), which records the questions
about the code itself.

What has already shipped is in [`CHANGELOG.md`](../CHANGELOG.md). What the 2026-09-23 review
found, and which of its findings are closed, is in its
[Status section](reviews/2026-09-23-deep-review.md#status).

*Updated 2026-09-26, `main` at `3b642fa`.*

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

1. **Review priority 7, project-fs's secret filter.** No secret reaches the provider, and no
   ordinary manifest is withheld as one.
2. **Review priority 8, an exact "already declared".** The tool never asserts on exit 0 an
   access that does not exist.
3. **Review priority 9, `init` on a real service repository.** The first onboarding gesture
   ends on a diff, not a dead end or a duplicate.
4. **The `backstage-http` read provider: a design note and a stage plan.** Context read from a
   Backstage catalogue, where today it comes from a configured source.
5. **A sweep of the review.** Each finding no pull request names is classified still true,
   fixed or obsolete; the Status section is updated, and the cheap fixes still true are
   batched.
6. **A check of the owner's stage-5 plan** against the review's stage-5 readiness findings and
   the current `main`, read only: what it covers and what it misses.
7. **Stage 5, write + local branch.** The first write, atomic and idempotent. The owner's own
   work, on branch `feat/s5-cleared`, at the owner's pace.

**Not yet ordered.**

- **Stage 6, GitHub pull request.** A real forge, and the pull request as the act of
  authorisation (ADR-0006).
- **Stage 7, Ink TUI, asciinema, npm publish.** The Claude-Code-like chat in the terminal
  that the owner set as the project's end goal (2026-09-23).
- **The `backstage-http` read provider itself**, once its design note and plan (item 4) are
  agreed.
- **Stage 8, discovery** ([the design note](stage-8-brief.md)). From any
  service repository, generate its catalog-info and discover the dependencies it already
  has, with evidence.

The one order stated beyond these seven is stage 8's own, in its design note (section 11):
priorities 6 (done, [#79](https://github.com/pcaboor/idp-agent/pull/79)), 7, 8 and 9
as queued, and stage 5's first two tasks; then slice 1, which needs only priority 7 and can
start as soon as it lands; then slices 2 and 3, and submission.
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

## Known debts and open items

Each was checked against `main` at `3b642fa`.

**First contact, left from review id docs-2**

- A repository-contract document (what a declarations repository must hold), a "wire it
  into Backstage" section, and the `credentials.json` the design mentions are not written
  (review priority 10 closed the rest in [#78](https://github.com/pcaboor/idp-agent/pull/78)).

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
- **A negation written with a space still names the environment.** "non prod", "hors prod"
  or "not prod" — and "non–prod" with an en dash — leave `prod` a whole word, so an update
  joining the prod grant is not asked and ends on a diff. The hyphenated forms are closed
  ([#79](https://github.com/pcaboor/idp-agent/pull/79)); a negating word before an
  environment word should withdraw it, or at least ask (`src/core/plan/echoes.ts`).
- **The mention check does not fold confusables.** A mention written with a lookalike letter
  (a Cyrillic `о` in `оrders-db-dev`) escapes the veto; the request must still name the target
  by full reference, so the environment reached is the one referenced
  (`src/core/plan/environment.ts`).
- **A Hangul filler (U+3164), which renders as a blank, is removed like other invisible
  characters,** so `pro<filler>d` reads `prod` (`fold` in `src/core/plan/echoes.ts`).
- **Only the vocabulary's words are environment words.** "staging" or "development" in a
  repository whose environments are dev and prod neither state an environment nor veto the
  pointing (design §7.5).
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
