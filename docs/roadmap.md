# Roadmap

Where the project stands, what comes next and in what order, what the owner decided, and
what is known to be left. There are no GitHub issues for now: open items live here, and in
[`AGENTS.md`'s Open questions](../AGENTS.md#open-questions), which records the questions
about the code itself.

What has already shipped is in [`CHANGELOG.md`](../CHANGELOG.md). What the 2026-09-23 review
found, and which of its findings are closed, is in its
[Status section](reviews/2026-09-23-deep-review.md#status).

*Updated 2026-10-03, `main` at `d7a6396`.*

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
| 5 | Write + local branch | done ([the check](stage-5-check.md), [the revised plan](plans/stage-5-write.md)): task 1, `Cleared` for the declarations repository ([#105](https://github.com/pcaboor/idp-agent/pull/105)); task 2, `Cleared` for the service repository ([#106](https://github.com/pcaboor/idp-agent/pull/106)); task 3, the shared git launcher and the `forge/` types ([#107](https://github.com/pcaboor/idp-agent/pull/107)); task 4, the local forge — create-only, idempotent, atomic ([#108](https://github.com/pcaboor/idp-agent/pull/108)); task 5, `plan --from … --submit` ([#109](https://github.com/pcaboor/idp-agent/pull/109)); task 6, `plan "<intent>" --submit`, refused before a model is paid ([#110](https://github.com/pcaboor/idp-agent/pull/110)); task 7, `init --submit` and `.idp-agent.yml`, and a branch already there answered before the confirmation ([#111](https://github.com/pcaboor/idp-agent/pull/111)) |
| 6 | GitHub pull request | done ([the note](stage-6-brief.md), [the plan](plans/stage-6-github.md), [ADR-0015](adr/0015-a-submission-is-a-pull-request-the-rules-hold.md)). Slice 6.1 done: 6.1.1, the allow-list ([#123](https://github.com/pcaboor/idp-agent/pull/123)); 6.1.2, the remote and who gh is ([#124](https://github.com/pcaboor/idp-agent/pull/124)); 6.1.3, the preflight and `idpa protection` ([#125](https://github.com/pcaboor/idp-agent/pull/125)); slice 6.2 done: 6.2.1, the GitHub forge ([#126](https://github.com/pcaboor/idp-agent/pull/126)); 6.2.2, `plan --from … --submit` to GitHub ([#127](https://github.com/pcaboor/idp-agent/pull/127)); slice 6.3: 6.3.1, `plan "<intent>" --submit` to GitHub, and `iacRepo` as a cross-check ([#128](https://github.com/pcaboor/idp-agent/pull/128)); 6.3.2, `init --submit` to GitHub ([#130](https://github.com/pcaboor/idp-agent/pull/130)); 6.3.3, `idpa "<phrase>" --submit` ([#131](https://github.com/pcaboor/idp-agent/pull/131)), which closes slice 6.3 as the plan drew it; 6.3.4, the pull request always opened, with a `note:` where its author may merge it alone ([#133](https://github.com/pcaboor/idp-agent/pull/133)); 6.3.5, at a terminal, a change's diff ending on the engine's proposal to open the pull request ([#134](https://github.com/pcaboor/idp-agent/pull/134)); 6.3.6, what is in flight read first — the open `idp-agent` pull requests into the base, before any model and again before writing ([#135](https://github.com/pcaboor/idp-agent/pull/135)); slice 6.4: 6.4.1, the live test ([#136](https://github.com/pcaboor/idp-agent/pull/136)), made on GitHub on 2026-10-02; 6.4.2, ADR-0015 and the documents that describe stage 6 as built ([#137](https://github.com/pcaboor/idp-agent/pull/137)); 6.4.3, every tape recorded before 2026-09-30 recorded again by the owner, every turn under the digest of what the provider is sent ([#138](https://github.com/pcaboor/idp-agent/pull/138)) |
| 7 | Polish: Ink TUI, asciinema, npm publish | not started |
| 8 | Discovery | designed ([the design note](stage-8-brief.md), [#76](https://github.com/pcaboor/idp-agent/pull/76)); not started |

Since stage 4, the work has gone into the review's priorities and into the question half of
the product: `--repo` and a configured source, the one gesture `idpa "<phrase>"`, answers
framed in the model's words, Backstage APIs, the relations view, tracing into MLflow, and
reading a Backstage catalogue for questions and relations (`backstage-http` slice 1, built
against a fake and demonstrated against a real Backstage 1.55.2 in Docker, `tools/backstage/`;
[the note](backstage-http-brief.md)), and the organisation — Groups, Users, Systems and
Domains read, walked with `idpa relations` and asked about in plain words (`backstage-http`
slice 3, [#99](https://github.com/pcaboor/idp-agent/pull/99),
[#100](https://github.com/pcaboor/idp-agent/pull/100) and
[#101](https://github.com/pcaboor/idp-agent/pull/101)). Slices 1 and 3 are closed: their
three keyed recordings, a question answered from a catalogue and the two organisation
questions, were recorded by the owner on 2026-09-29 and replay with no key
([#103](https://github.com/pcaboor/idp-agent/pull/103)). Slice 2 is closed too
([the plan](plans/backstage-http-slice-2.md), [#117](https://github.com/pcaboor/idp-agent/pull/117)):
a catalogue past a bound is answered in part and says so
([#119](https://github.com/pcaboor/idp-agent/pull/119), ADR-0013), and a read is kept five
minutes for the person's account, read again through the reader, with `--refresh` and
`--cached` ([#120](https://github.com/pcaboor/idp-agent/pull/120) and
[#122](https://github.com/pcaboor/idp-agent/pull/122), ADR-0014).

## The queue

**In order**, as the owner decided on 2026-09-23, 2026-09-25, 2026-09-26, 2026-09-27,
2026-09-29, 2026-09-30 and 2026-10-01.
Each line says what the item is for. The sweep of the review is done
([its verdicts](reviews/2026-09-23-deep-review.md#the-sweep-2026-09-27)); its batches are
here, one pull request each, each naming the check run together at the end.

1. **Two fixes before stage 8** (owner's decision, 2026-10-03). The Inspector's facts held to
   the files it read: the engine keeps a fact only where a file the Inspector really read
   states it, as it already holds an answer to the references a tool returned, proved with a
   scripted client that reproduces the invented `package.json` of 2026-10-02, no tape needed.
   And `idpa protection`'s reason for a base whose ruleset supplies none of the three rules,
   reported as classic branch protection only (the exit code and the note were right, the
   reason was not) — done ([#139](https://github.com/pcaboor/idp-agent/pull/139)): the
   branch route is read only when the rules route answers no rule at all, so that base is told
   the four rules it lacks.
   The first is done too ([the plan](plans/inspector-witness.md),
   [#140](https://github.com/pcaboor/idp-agent/pull/140);
   [#141](https://github.com/pcaboor/idp-agent/pull/141)), with the owner's re-record of
   `link-already-declared`, whose Inspector classified `pg` as a database no file states: a
   value the Inspector reports reaches the Architect and `init`'s signature only where a file
   it read before its report states it, by the field's rule, and is otherwise an unknown with
   the engine's reason, said on stderr and in the trace. It holds the values a report states;
   the reasons a model writes for its own unknowns wait for stage 8, slice 2, item 2 (owner's
   decision, 2026-10-03). **Done.**
2. **Stage 8, discovery** ([the design note](stage-8-brief.md)), with `backstage-http`'s
   slices 4 and 5. From any service repository, generate its catalog-info and discover the
   dependencies it already has, with evidence; two people discovering the same service see what
   the other has in flight rather than a competing pull request (2026-10-01). It goes on top of
   stage 6, which is done ([#123](https://github.com/pcaboor/idp-agent/pull/123) to
   [#138](https://github.com/pcaboor/idp-agent/pull/138); its follow-ups are under *Known
   debts*), and whose submission road its own takes. Slice 1, the report, is done
   ([the plan](plans/stage-8-slice-1.md), [#144](https://github.com/pcaboor/idp-agent/pull/144)
   to [#146](https://github.com/pcaboor/idp-agent/pull/146) and
   [#147](https://github.com/pcaboor/idp-agent/pull/147)): `idpa init` reports what the
   service's committed configuration states, and what it did not read. Slice 2, matching and
   asking, is planned ([the plan](plans/stage-8-slice-2.md)): seven pull requests, three of them
   ending on a keyed recording by the owner.
3. **Removing and changing an access, and company rules** (2026-10-01). Revoking a right,
   changing its level or decommissioning a service, always as a pull request a person merges —
   today the tool only appends, and least privilege needs the other half; and gates a company
   configures in its declarations repository (a ticket required for a `readwrite` grant in
   production, its naming conventions). Placed after stage 8 and before stage 7; the order is
   the owner's to confirm.
4. **Stage 7, Ink TUI, asciinema, npm publish.** The Claude-Code-like chat in the terminal,
   the project's end goal (2026-09-23), with a Tab switch between the intent mode and the
   discovery mode (2026-10-01).
5. **After stage 7, the enterprise needs: a discussion, not a stage.** The owner brings the
   needs and constraints they identified for a company — for example MCP servers such as
   Jira's, for ticket handling — to be discussed before anything is planned. Nothing is
   scheduled; design §13 keeps real Jira integrations out of v0.1, and an MCP server exposed
   by `idp-agent` is §13's own v0.2 item, a different thing (2026-09-30). Added on 2026-10-01:
   GitLab, the forge interface being GitHub's alone in v0.1; and a proof that what a merged
   pull request declares was really done downstream (ADR-0012), which will come with MCP
   servers or integrations. And the harness itself as a reusable agent runtime — the bounded
   turn, the repair loop, the typed objects that cross the boundary, the provenance signature,
   the gates, the event stream, the tapes replayed with no key and the traces — extracted for
   other agents to be built on, which design §13 already lists for v0.2 (2026-10-01).

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
- ADR 0010 goes to the stage-5 check; the `backstage-http` ADR is
  [0011](adr/0011-backstage-to-explore.md); stage 8's evidence ADR takes the next free number
  when it is written ([`stage-8-brief.md`](stage-8-brief.md) says so;
  [#97](https://github.com/pcaboor/idp-agent/pull/97)).

**2026-09-28**

- The demo Backstage is our own image, not a community image: a minimal Backstage app at a
  pinned version, our app-config, and nothing else. Built as a committed minimal app derived
  from create-app 0.9.2, Backstage 1.55.2, with its lockfile (`tools/backstage/`, whose
  README gives the reasons); the `question-backstage-owner` tape, which needs the owner's key
  and the owner present, is what is left of `backstage-http` slice 1
  ([#98](https://github.com/pcaboor/idp-agent/pull/98)).
- `backstage-http` slice 3's three questions
  ([the plan](plans/backstage-http-slice-3.md#questions-for-the-owner)), settled. A Group,
  User, System or Domain document Backstage would refuse is set aside with a `not-modelled`
  warning, never an error, so it can never refuse a plan. Users' names and group memberships
  may reach the model provider from 3.3 on, with a `SECURITY.md` row; a User's profile
  (email, picture, display name) is never requested and is dropped by the pre-pass. Three pull
  requests — 3.1 the nodes, 3.2 the relations, 3.3 the Analyst — then the owner's keyed step
  R; the note's "Closed by 3.2" becomes "Closed by 3.3"
  ([#99](https://github.com/pcaboor/idp-agent/pull/99)).

**2026-09-29**

- The stage-5 check's nineteen decisions ([its § 7](stage-5-check.md#7-decisions-for-the-owner--settled-2026-09-29),
  [#104](https://github.com/pcaboor/idp-agent/pull/104)). Four chosen: the provenance is
  sealed into the `SignedPlan` by `signPlan`, and `clearPlan` re-runs the policies against it,
  never taking one from its caller (D1); a runtime brand on `Cleared`, a module `WeakSet`, the
  forge refusing any other object (D3); a plan writing into both repositories is refused by
  name, pointing at `init --submit` (D6); the brief is committed as it stands, dated, and the
  plan is revised in place (D15). The check's other recommendations are the owner's defaults,
  open to change — among them B3 after stage 5, since the forge writes only objects and a ref
  (D17); the commit subject written by the engine from the operations, the request in the
  body (D18); `--submit` taking `declarationsFor`'s whole chain, stderr naming what chose the
  root (D19); no `idpa "<phrase>" --submit` at stage 5 (D8); no `backstage:` written into
  `.idp-agent.yml` (D9); and "declared is not provisioned" as ADR 0012, *proposed* (D16).
  [ADR 0010](adr/0010-a-submission-is-a-create-only-ref.md) is written, *proposed*.
- The architecture of stage 5's task 4 and ADR 0010, validated after a presentation of both,
  with three explicit choices: the base is `HEAD`, the branch checked out, and a detached or
  unborn `HEAD` is refused; a catalogue file that differs from `HEAD` in the working tree —
  uncommitted, untracked or ignored — makes the submission a refusal for divergence, naming
  the files; and the repository's git hooks and fsmonitor never run during a submission, the
  launcher's hardening, which `SECURITY.md` states for teams relying on `pre-commit`. ADR 0010
  is *accepted* ([#108](https://github.com/pcaboor/idp-agent/pull/108)).
- After submitting a plan twice by hand, on stage 5's task 5: the second run asked the level,
  showed the diff and asked `[y/N]` before saying "already submitted". Now, on every
  `--submit` road, a branch already there is answered before the confirmation, by a look at
  the forge that writes no object and no ref — the test `submit` makes: this very submission
  is named, exit 0, and somebody else's branch of that name refused, exit 1, neither with a
  prompt. The level question stays, since it decides the bytes and so the branch; `submit`
  looks again at the moment of writing. For `init --submit`, the defaults held: no
  `backstage:` written and `--backstage` takes no value (D9), `--environment` rather than
  `--env`, a service in a subfolder of its repository refused with exit 2 (D12), `init`
  without `--submit` byte-identical, and the order forge, configuration questions, the
  project read, `init`'s verdicts, divergence, then the Inspector
  ([#111](https://github.com/pcaboor/idp-agent/pull/111)).

**2026-09-30**

- After stage 7, the owner brings the enterprise needs and constraints they identified — for
  example MCP servers such as Jira's, for ticket handling — to be discussed before anything
  is planned; it is the queue's last line, not a stage
  ([#112](https://github.com/pcaboor/idp-agent/pull/112)).
- A file whose last line has no line break keeps that convention: after an insertion it still
  ends without one, and insert then remove gives it back byte for byte, like the byte-order
  mark and CRLF. The debt B1 found and pinned ([#113](https://github.com/pcaboor/idp-agent/pull/113))
  is closed, and §9.2's two round trips draw every file
  ([#114](https://github.com/pcaboor/idp-agent/pull/114)).
- For batch B2 alone, the owner authorised what the rules otherwise forbid: `tests/recordings`
  may change with no key and no `IDP_RECORDING=record` — every tape's digest fields
  rewritten, its dead turns pruned — and no recorded response, nor the recorded content of
  any request, may change. A rewrite must never hide staleness: a new digest is computed
  from what the tape recorded, never from today's request, and where a tape does not hold
  enough the batch stops and reports the options. The 16 turns no scenario replays were
  pruned; no digest was rewritten, because no tape holds the tools or the tool choice it was
  sent, and its transcript was stored as the agent grew it after the call. The question
  tapes stale today are still reported stale ([#116](https://github.com/pcaboor/idp-agent/pull/116)).
- `backstage-http` slice 2, the owner's five answers, each as recommended: a kept copy of a
  catalogue read is removed after 7 days by the next run that writes one; `IDP_BACKSTAGE_CACHE=off`
  keeps nothing, `off` its only value and anything else refused with exit 2; all three read
  ceilings become stated bounds with one semantics, so no catalogue is refused for its size;
  three pull requests, the store and its proofs reviewed before any command writes; and new
  words for what a bound left out (`past the bound:`, `partial:`), `not loaded` kept for the
  marker a reference carries, so every whole read stays byte-identical
  ([#117](https://github.com/pcaboor/idp-agent/pull/117)).
- Stage 6's design, settled ([the note's § 18](stage-6-brief.md#18-the-owners-answers-2026-09-30),
  [#118](https://github.com/pcaboor/idp-agent/pull/118)). The invariant, reworded for
  design §4.2, `AGENTS.md`, `SECURITY.md` and ADR-0015: "the identity that opens a pull request
  cannot merge it until someone else has approved the exact commit that would merge, and idpa
  never submits against a base without those rules". The base's ruleset must require at least
  one approval, approval of the most recent push or dismissal of stale approvals, no force
  push, no deletion, and `current_user_can_bypass` `never` for the person submitting, checked
  before any write and again at the moment of acting; a base protected only by classic branch
  protection is refused, naming the ruleset to add (replaced on 2026-10-01, below; ADR-0015
  records the later wording). The push and the pull request go "like
  Claude Code": idpa handles no GitHub token; the person's own git pushes the `idp-agent/`
  branch, create-only (`--force-with-lease=<ref>:` with an empty expected value, the exact
  commit, hooks off, one refspec), and the person's own gh reads the rules and opens the pull
  request, idpa being limited to an explicit list of git and gh commands and arguments by a
  run-time check and an architecture rule. Without gh, or with gh logged out, nothing is pushed
  (exit 2, `--local` named), since the rules cannot be read. The note's other decisions take its
  recommendations, rewritten for gh: gh's own authentication and no GitHub secret read by
  idpa; the role read through `gh api` reported, never decided on; GitHub Enterprise later,
  through gh's host configuration; the live test on the owner's own gh session against a public
  throwaway repository named with `idpa-live`, with a second account for the approval step.
  The four questions the revision raised (§ 19), each as recommended: gh's identity must be a
  person, so a bot or an app's token is refused and stage 6 is a laptop tool, not a CI step; a
  repository key that redirects the push or runs a program during it is refused with exit 2,
  naming the key and the command that removes it, never overridden; `GIT_SSH_COMMAND`,
  `GIT_SSH`, `GIT_SSH_VARIANT` and `GIT_ASKPASS` reach the push and no other git call, taken
  as following from "like Claude Code" and said so; and stage 6 does not prove the push
  credential is gh's account — a deploy key visible in the bypass list is refused, the limit
  is stated, and `gh auth setup-git` recommended.
- The tapes recorded before 2026-09-30 keep the digest that does not see the tools a turn was
  sent; the owner chose to re-record them with their key during stage 6's live session, rather
  than warn on every replay of an old turn or store the tools from the next recording on. Done
  on 2026-10-02, all twelve ([#138](https://github.com/pcaboor/idp-agent/pull/138)).
- `init --iac-repo` keeps refusing a locator carrying userinfo, a query or a fragment, the
  SSH form `git@github.com:acme/iac.git` included: a user name cannot be told from a token by
  its shape, and `.idp-agent.yml` is committed. `acme/iac`, `github.com/acme/iac` and
  `https://github.com/acme/iac.git` stay accepted (confirmed by the owner,
  [#111](https://github.com/pcaboor/idp-agent/pull/111)).
- Stage 6's plan, the owner's four answers: with `--local`, the closing line is `--local:
  nothing pushed by this run`, which stays true when an earlier run pushed the branch; the
  "submitting to" line names gh's login and no role, which `idpa protection` prints; the
  suite removes `NODE_USE_ENV_PROXY`, so a recording is never sent to the closed proxy port
  and the owner checks nothing first; and a question put to `idpa "<phrase>" --submit` is exit
  3, `unsupported`, the mirror of a change put to `ask`
  ([#121](https://github.com/pcaboor/idp-agent/pull/121)).
- Stage 6's decision 13, built: `idpa protection [--repo <clone>]` checks the base's ruleset on
  its own, with no model and no write — exit 0 when the rules hold, 1 when they do not, 2 when
  the arguments, the clone's configuration or gh are refused — and `init platform` prints the
  same list of settings and names it, where it printed a checklist and "arrives at stage 6"
  ([#125](https://github.com/pcaboor/idp-agent/pull/125)).

**2026-10-01**

- **The invariant changes: the pull request is always opened.** Whether its author may merge
  it alone is the company's rule, not this tool's ("you can merge your own pull request if you
  have the role on GitHub or GitLab; it all depends on the company's rules"). So `--submit`
  opens the pull request whatever the base's rules, and when they let its author merge it
  without another person's review — no approval required, a role that can bypass, classic
  protection alone, a deploy key in the bypass list — it says so in one neutral line, `note: on
  this repository the author may merge without another person's review`, on stderr and in the
  pull request, and exits 0. idpa still never merges and never writes to `main`; the refusals
  that protect the push itself stay (no gh, a clone configured to redirect the push); `idpa
  protection` still answers 0 or 1. Task 6.3.4, after 6.3.3 and before ADR-0015: design §4.2
  changes first, then `AGENTS.md`, `SECURITY.md`, `docs/submitting.md` and the note. Built
  ([#133](https://github.com/pcaboor/idp-agent/pull/133)): what still refuses is item 1 of
  § 8 — a repository archived, not pushable by gh's account or answering under another name
  (exit 1) — besides gh and the clone's configuration (exit 2); where a binding rule still
  requires another person's approval and only force pushes or deletions are unguarded, the
  note says that instead, as the plan's question 2 recommended.
- **The Supervisor proposes to open the pull request** (task 6.3.5): after the diff, in a
  terminal and with no `--submit` typed, it proposes; the person's `y` authorises; the engine
  opens it and prints its URL. The model never holds a tool that pushes without that answer;
  a run with no terminal still needs `--submit`. Built
  ([#134](https://github.com/pcaboor/idp-agent/pull/134)): the question is `--submit`'s,
  byte for byte, put only when stdin, stdout and stderr are each a terminal and after what was
  typed while the models ran is discarded; every GitHub read on that road comes after the last
  model call, and where the engine could not do what it says, one `no pull request proposed —
  …` line says why and the preview stands at exit 0; `plan --from` and `init` keep `--submit`.
- **What is in flight is read first:** before any model is paid, the open `idp-agent` pull
  requests that touch the same service are read. The same content is named, `already proposed
  by <login> in pull request #12`, and nothing is written; different content is shown beside
  it, and only a complementary pull request on other files is proposed. Another person's pull
  request is never edited or closed. It serves every road and stage 8's discovery. Built
  ([#135](https://github.com/pcaboor/idp-agent/pull/135)), with the owner's answers to the
  plan's questions 5, 6 and 7 as settled: two `GET`s through gh, the open pull requests into the
  base (three pages at most) and each idp-agent one's files (twenty at most), read before any
  model on every `--submit` road and again at the moment of writing — the proposal road reads
  after its last model call — and the read before the model says what touches the service and
  goes on, never stops the run; the same bytes are named at exit 0, a competing change refused
  at exit 1 with the other's patch on stderr, one beside named in the body by number without
  `#`; more than twenty in flight, or 300 open, is refused; another person's login, branch and
  patch reach the terminal alone; the budget is 92 gh calls.
- Stage 6's decision 17, built: `init --submit` in a service whose checked-out branch tracks
  one on github.com pushes the branch and opens a pull request on the service's own
  repository, once that repository passes the same configuration check and the same preflight
  as the declarations repository, read before the Inspector; otherwise it is refused as § 8
  says, its last line naming `--local`. D6 and D12 stay refused by name, on the GitHub road
  too; `.idp-agent.yml`'s `iacRepo` names the declarations repository, another, so it is not
  held to the service's clone ([#130](https://github.com/pcaboor/idp-agent/pull/130)).
- Stage 6's decision 14, built, and stage 5's D8 settled by it: `idpa "<phrase>" --submit`
  submits a change as `plan "<intent>" --submit` does — the declarations repository, the
  `--project`, the road and gh read before a catalogue is requested and before the model is
  configured, the base's rules before the Supervisor — and a question put to `--submit` is
  refused after the Supervisor's one word, exit 3, the Analyst never called and nothing written;
  `--submit --demo` is refused at parse time. Divergence is judged after the Supervisor's word,
  where `runIntent` reads the catalogue's bytes: one Supervisor turn is what a divergent tree
  costs on this road ([#131](https://github.com/pcaboor/idp-agent/pull/131)).
- **The queue gains** removing and changing an access, and company rules, after stage 8; the
  discovery mode's Tab switch belongs to stage 7. GitLab and the proof of what was done after a
  merge go to the discussion after stage 7. Temporary access and a CI or bot mode were offered
  and not added.
- Stage 6's three added tasks are planned (6.3.4, 6.3.5, 6.3.6, [the plan](plans/stage-6-github.md),
  [#132](https://github.com/pcaboor/idp-agent/pull/132)), and the owner settled the eight
  questions they raised, each as recommended: the proposal to open a pull request is the
  engine's question alone, with no line from a model and no prompt changed; `init` and `plan
  --from` keep `--submit` in stage 6, `init`'s proposal coming with stage 8's discovery; a
  proposal reads what is in flight after the last model call, while `--submit` and `init` read it
  before any model and again at the moment of writing; a base that requires an approval but leaves
  force pushes or deletion unguarded gets a second, precise note; more than twenty `idp-agent`
  pull requests in flight into one base are refused rather than compared in part; no new flag for
  a preview with no GitHub read; and design §4.2 takes the bullet 6.3.4's Step 1 quotes.

**2026-10-02**

- Stage 6's live test, run by the owner against a public throwaway repository with gh 2.96.0 and
  no second account ([#136](https://github.com/pcaboor/idp-agent/pull/136)): it passed, steps 1, 2, 3, 3c, 4 and 6 passed and 3b and 5 were
  skipped for want of the second account, which the owner made optional on 2026-10-01. What it
  measured, committed in `tests/contract/github/answers-2026-10-02.json`:
  - **gh 2.96.0 is the oldest gh this build reads** (`GH_MINIMUM_VERSION`, provisionally 2.40.0
    until now): the version the run was made with. A later run with an older gh, committed,
    lowers it.
  - **An administrator outside an empty bypass list is bound**: GitHub answers
    `current_user_can_bypass: never` to the repository's administrator (the note's § 17, first
    unknown), and refuses their merge, `gh pr merge --admin` included. § 8 item 3 holds for the
    owner's own repository, as decision 6 assumed.
  - **Each door, as the identity that opened the pull request**: `gh pr merge` by merge, squash
    and rebase, and `--admin`, exit 1; the REST merge 405; `POST merges` 409; a file written to
    the base 409; the base's ref moved, non-forced, 422; a push of the head onto the base
    rejected, `GH013: Repository rule violations found`, with the rule it breaks; GraphQL's
    `mergePullRequest` and `createCommitOnBranch` an error each; the author's own approval
    refused, through gh and 422 through the API. **`merge-async` answers 202 Accepted and is
    never carried out**: the pull request watched 30 seconds, never merged, the base never moved,
    and every pull request the run opened read unmerged before the cleanup and after it.
  - **A branch a ruleset covers answers `protected: true`** on the branch route, with no
    classic protection set. The preflight read that route only when no ruleset supplied a
    required rule, so the run's verdict did not depend on it; a ruleset supplying none of the
    three required rules made `idpa protection` say "classic branch protection only" where it
    is a ruleset that is missing the rules, and leave those rules unnamed — fixed since: the
    route is read only when the rules route answers no rule at all
    ([#139](https://github.com/pcaboor/idp-agent/pull/139)).
  - **No read-back lag was seen**: GitHub answered the pushed branch on the first read.
  - **The request's `@mention`, inside the body's fence, rendered as code** with no mention link.
  - The three fields no read settles, filled by the owner for the throwaway repository: GitHub
    Actions may not approve pull requests there, the owner's git pushes as their gh account, and
    the ruleset's bypass list is empty.
  - The fake gh moved to what GitHub answered, never the other way round: `GET user`'s `name` a
    string, the repository owned by a person, with no description and `maintain` true for an
    administrator, `protected` true under a ruleset, the base's ref moved answered 422 where the
    fake said 409, and `merge-async` 202.
- The tapes recorded before 2026-09-30, recorded again by the owner with their key (stage 6,
  Task 6.4.3): all twelve, none left, so `tests/scenarios/left.ts` names none. Which provider
  recorded each is the owner's choice of that day. The five plan-mode tapes and the three
  Backstage questions with openai `gpt-6-luna`, as before; `question-prod-databases` with
  mistral `mistral-small-2603`, as before. The three other question-mode tapes —
  `question-consumers-of-billing-db`, `question-unanswerable-ranking` and
  `mutation-classified-link`, Mistral's until then — with openai `gpt-6-luna`:
  `mistral-small-2603` answered `nothing` to "which services use the billing database in
  prod?", having searched for Components of type `service` in `prod`, which the demo SI does
  not declare, so that tape and the two left after it were recorded with `gpt-6-luna` instead
  ([#138](https://github.com/pcaboor/idp-agent/pull/138)).

**2026-10-03**

- [ADR-0015](adr/0015-a-submission-is-a-pull-request-the-rules-hold.md) accepted: a submission
  is a pull request, and the base's rules decide who may merge it — "idpa never merges and
  never writes to the base: it opens a pull request, and the base's rules decide who may merge
  it", the owner's words of 2026-10-01, held word for word in the design, `AGENTS.md`,
  `SECURITY.md`, `docs/submitting.md` and the record by `tests/unit/invariant-wording.test.ts`.
  It records the owner's choices of 2026-09-30 and 2026-10-01 as built, and what the live run of
  2026-10-02 measured; step 5 of that run, an approval then a push, was not made, the second
  account being optional, and rests on the fake and the rule's read. Stage 6 is built; 6.4.3,
  the owner's re-recording of the tapes, lands next
  ([#137](https://github.com/pcaboor/idp-agent/pull/137)).
- The owner recorded `link-ambiguous-env` and `question-consumers-of-billing-db` again with
  OpenAI `gpt-6-luna` rather than keep a tape whose Inspector invented a service, or one
  answering in Spanish; and put the fix of the product gap that tape showed — the Inspector's
  facts held to no file read — right after stage 6, before stage 8, with `idpa protection`'s
  wrong reason ([#138](https://github.com/pcaboor/idp-agent/pull/138)).
- The Inspector's facts held to the files it read ([the plan](plans/inspector-witness.md),
  [#140](https://github.com/pcaboor/idp-agent/pull/140)), the owner's five answers, each as
  recommended: an unwitnessed value is withdrawn after the report, never handed back to the
  model; one unstated dependency name makes the whole list unknown, said with every name
  reported; `link-already-declared`, the one tape the change stales, is re-recorded by the
  owner in the same pull request; and the engine-written reason for an unknown, with `init`'s
  `answered` signature, wait for stage 8, which re-records the same tapes anyway.

**2026-10-04**

- Stage 8 is done step by step with the owner: the note refreshed, then the plan, then each
  pull request, each validated by the owner before it merges and before the next starts.
- The stage 8 note refreshed against `2572ebd` ([the note](stage-8-brief.md),
  [#142](https://github.com/pcaboor/idp-agent/pull/142)). The owner's eleven answers of
  2026-09-26 stand; the six questions the refresh raised are settled, each as recommended:
  exit 1 for a preview with no evidence, exit 0 once something is submitted; answer 4's setting
  an `idp-agent.dev/` annotation on the declarations repository's registration, central
  without it; CODEOWNERS handles typed by the person; a second scan teaching the same
  identifier withdraws its addition and keeps its rights; an unstated account agrees with a
  found one at recognition, strict at the re-check; `.idp-agent.yml` under the central default
  a separate pull request on the service's repository, only when a flag asked for it.
- Stage 8's slice 1 planned ([the plan](plans/stage-8-slice-1.md),
  [#143](https://github.com/pcaboor/idp-agent/pull/143)), four pull requests, 1.1 to 1.4.
  The owner's four answers: the exit is read literally — a preview with no **verified**
  finding (committed, of standing `evidence`, re-read; a sample's finding does not count) in a
  repository read in part exits 1, and the closing sentence carries the count of verified
  findings; the git remote is read in 2.5, with its first reader; what git does not track is
  counted and never named, on stdout, in the trace and in the pull request; nothing is
  extracted from a file not committed, and the launcher gains no shape.

**2026-10-06**

- The owner's two answers about stage 8's Task 1.2, the discovery read
  ([the plan](plans/stage-8-slice-1.md)). A name staged and never committed is **counted, never
  named** (question 5): the read names a path only when `HEAD`'s listing holds it, counts what
  the index holds and `HEAD` does not in a count of its own (`staged`), names nothing under an
  unborn `HEAD`, and under a `HEAD` it cannot list whole counts every tracked path for that one
  reason and names and opens none — with no new launcher shape. And the prose under
  `src/process` that still named two loaders of the git launcher is corrected in the same pull
  request: the diff there holds comment and README lines only, and `SHAPES` and `checkGitArgv`
  are byte-identical to `main`.
- The owner's two answers about stage 8's Task 1.4, the report
  ([the plan](plans/stage-8-slice-1.md)), each as recommended. A `package.json` written on one
  line over 1 KiB **verifies nothing, and that is kept and said** (question 6): every finding
  is at line 1, the re-read refuses a span over 1,024 bytes as a quote of the file, and the
  report names each drop at its file and line, as `README.md` says. A name the engine could
  not read is **not counted as verified** (question 7): `verifiedFindings` counts only a
  finding the re-read lets vouch whose kind is neither `unparsed` nor `withheld`, and that one
  count is the sentence's `(V findings verified)` and what `init`'s exit reads; the finding is
  still listed as what it is.

**2026-10-07**

- Stage 8's slice 2 planned ([the plan](plans/stage-8-slice-2.md),
  [#148](https://github.com/pcaboor/idp-agent/pull/148)), seven pull requests, 2.1 to 2.7,
  each validated by the owner before it merges; 2.2 re-records five tapes and 2.3 and 2.7 record
  the first `init` tape, each by the owner before its task merges. The owner's eight answers, each
  as recommended: `init --repo` is refused whatever it names, the declarations repository found
  through `IDP_REPO` or `config.yml`; `init` gains `--type`; the picker offers a typed `skip`,
  never chosen by Enter; `init --submit` is refused before anything (exit 3) while a central
  Component waits for slice 4; the `init` tape is recorded in 2.3 and again in 2.7; the
  declarations repository's preflight and in-flight read move to slice 4.2; the picker is built
  in 2.5 and first asked in 2.7; a service's pull request names a matched entity by its reference
  and shows nothing else of the declarations repository.

## Known debts and open items

Each was checked against `main` at `3b642fa`, except stage 6's follow-ups, checked at `d7a6396`
(6.4.1 merged).

**Stage 6's follow-ups** ([ADR-0015](adr/0015-a-submission-is-a-pull-request-the-rules-hold.md))

- **GitHub Enterprise** (decision 16). github.com only; a host gh is logged in to, through
  gh's own host configuration, comes later, with a real instance to test against.
- **The push credential is not proven to be gh's account** ([the stage 6
  note](stage-6-brief.md), § 19, Q4). A deploy key or another account's key in the bypass list
  could move the base without a pull request; `docs/submitting.md` recommends pushing as gh's
  account. Revisit when a company says its submitters push with other keys.
- **A server-side runner** (the note's Q1). Stage 6 is a laptop tool: gh must be logged in as
  a person, and a runner, whose token would make a bot the author, needs an ADR of its own.
- **A ruleset restricting the creation of `idp-agent/` branches** is printed as advised and
  was not measured live: what GitHub's push rejection says for it is unknown.
- **A ruleset supplying none of the three required rules was called classic protection** by
  `idpa protection`, the exit and the note right and the reason wrong. Closed,
  [#139](https://github.com/pcaboor/idp-agent/pull/139): the branch route, which answers
  `protected: true` for a branch any active ruleset covers, is read only when the rules route
  answers no rule at all, so such a base is told the four rules it lacks (a pull request rule
  requiring 1 approval, approval of the most recent push, block force pushes, restrict
  deletions), and classic protection alone is still said as such
  (`tests/unit/protection-command.test.ts`, `tests/unit/preflight.test.ts`). What is left: an
  active ruleset holding no rule at all leaves the rules route empty as classic protection
  does, so it would still be said as classic protection only; GitHub's answer for one was not
  measured.
- **Step 5 of the live test, an approval followed by the author's push, was not made on
  GitHub**: the second account is optional and was not used on 2026-10-02, so that claim rests
  on the fake and on the rule's read until a run with a second account is committed.

**Stage 5's follow-ups**

- **`init --submit` for a service in a subfolder of its repository** (D12). Refused with
  exit 2, on the GitHub road too, before gh starts: the forge cuts a branch at a clone's root,
  and the service's paths would need the folder's prefix. `init` without `--submit` previews
  one.
- **`.idp-agent.yml` for a service already declared.** It rides on the branch of the
  Component `init` adds; when the service's catalog-info already declares it, a typed
  configuration is said to be left unwritten, and is written by hand.
- **The Inspector reads the working tree.** `init --submit` proves the catalog-info files
  it decides on and `.idp-agent.yml`, not an uncommitted `CODEOWNERS` or `package.json` the
  inspection read — an owner read there is vouched for though the branch does not carry the
  file. Proving every file read would refuse `init` in any repository with one dirty
  unrelated file.

**Physical confinement, left from batch B3**

Checked against this change ([#115](https://github.com/pcaboor/idp-agent/pull/115)).

- **`.idp-agent.yml` is read through a link.** `cli/config.ts` reads it with `readFile`, in
  either repository; the batch covered the catalogue files, `init platform`'s writer and
  the Inspector (`src/confine/`).
- **One instant is not closed.** Node has no `openat`, so a folder swapped for a link
  between one of `init platform`'s checks and the `mkdir` or the create after it can leave
  one empty folder or one empty file where the link led, refused before anything deeper
  is made or a byte written, and named; a folder swapped and swapped back between two
  checks is not caught at all. `SECURITY.md` states it.

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
- **No Anthropic recording exists.** The twelve recordings are OpenAI's, `gpt-6-luna` for
  eleven, and Mistral's, `mistral-small-2603` for `question-prod-databases` (recorded again on
  2026-10-02); the provider contract test checks Anthropic's request shape, not a live run.
- **No `question-overview` scenario is recorded** ([#54](https://github.com/pcaboor/idp-agent/pull/54)
  suggested one): an overview answered from the demo SI is replayed by no tape. It is a new
  scenario, not a re-record, and needs the owner's key.
- **The Architect is told the user's answers only when a refusal is at them.** Listing them
  on every repair report would let it converge sooner, and changes what it is sent after an
  answered round. The `link-db-missing` tape that refused and redrafted after one is gone: no
  tape recorded on 2026-10-02 refuses or redrafts after an answered round (measured on a
  replay of the five plan-mode tapes), so the change stales none and no longer waits for a
  re-record; no scenario would show it either, and a scripted client is where it is tested
  ([`AGENTS.md`'s Open questions](../AGENTS.md#open-questions);
  [#61](https://github.com/pcaboor/idp-agent/pull/61)).
- **Two tapes recorded on 2026-10-02 were recorded again by the owner on 2026-10-03** and close
  here. `link-ambiguous-env`'s Inspector had read no file and reported a service of its own
  invention (`@thronecode/gorilla-service`, a model's invention found nowhere in the
  repository); recorded again, it reads `package.json` and reports `billing-api`, and
  `plan-mode.test.ts`'s *holds an Inspector that reports what a file it read says* passes.
  `question-consumers-of-billing-db` had framed an English question in Spanish; recorded
  again, it answers in English with the relation the engine computes.
- **The Architect's searches on a value nobody uses still answer empty.** The Analyst's are
  refused with the values in use; turning that on for the Architect is an open decision,
  because four of the five plan-mode recordings search on such values and would need
  re-recording ([#55](https://github.com/pcaboor/idp-agent/pull/55);
  `refuseUnusedValues: false` in `src/cli/commands/plan.ts`).

**Left from `backstage-http` slice 1**

- **An `IDP_REPO` exported in a recording shell is kept from a tape by one setup file, and
  no test says so while recording.** `tests/setup/shell.ts` keeps the shell whole while a
  scenario records, the catalogue's two variables excepted, so no tape holds what a
  catalogue serves. `IDP_REPO` is not among them: what keeps a company repository out of a
  tape is `tests/setup/personal.ts`, which removes it and moves `XDG_CONFIG_HOME` into the
  run directory in every worker, a recording one included (checked on `191f4e4`), while
  `personal-config.test.ts` asserts it only on a run that does not record. Out of slice 1
  (the owner's decision of 2026-09-27).
- **A value a search refusal named, and the summary did not show, is dropped from the
  commentary.** The commentary check is handed the lists as the summary shows them, 30 per
  list (domain-backstage-8), while a search on a value nobody uses is refused with the first
  ten values in use by code-unit order (`listed` in `src/agents/tools/graph-tools.ts`). On a
  list of more than 30 those ten are seldom among the 30 most frequent, so a sentence naming
  one is dropped as not read: the safe direction, but short of ADR-0008's "a value the
  model was shown". Either the refusal names the values the summary shows, or the check is
  handed what a refusal named ([#97](https://github.com/pcaboor/idp-agent/pull/97)).

**Left from `backstage-http` slice 3**

- **The note's § 14 decision 3 is not needed so far.** A read-only widening of the Component
  and Resource read schemas was to follow if the owner's catalogue sets many Components
  aside; the facts about that catalogue are still to gather (§ 14), and nothing seen since
  shows it is needed ([#101](https://github.com/pcaboor/idp-agent/pull/101)).
- **Over a source that holds an organisation, a conclusion using a team's name as a word is
  dropped.** The commentary check knows every node's name, the organisation's included, so
  "the shared platform" beside a Group `platform` no tool returned is left out, with its
  line on stderr: the safe direction ADR-0008 asks for, and the cost of a sentence never
  naming an unread team ([#101](https://github.com/pcaboor/idp-agent/pull/101)).

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
- **An absolute `--repo` from a removed working directory dies on `ENOENT … uv_cwd`,** exit
  1 (found in `backstage-http` slice 1.2's review, older than it). `repositoryChain` in
  `src/cli/source.ts` hands `declarationsRoot` `context.cwd()`, asked for up front, where
  `SourceContext` says the working directory is asked for only on the roads that need it;
  passing `context.cwd`, the function, asks for it only when `--repo` is relative. Left out of
  1.2, which changes no behaviour.

**Open questions**

- **What a company adopting stage 6 answers for itself**, which the live run of 2026-10-02 (the
  note's § 17) answered for the owner's throwaway repository only: whether its declarations
  repository is protected by rulesets or by classic branch protection, at the organisation's
  level or the repository's, and whether the people who submit sit in a bypass list; whether they
  push with the same account their gh is logged in as, and whether a deploy key sits in a bypass
  list; whether its GitHub Actions may approve pull requests. `idpa protection` reads what it can
  of each and says what no read can see.
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
  `evaluatePlan()`. For stage 5 the check chose a parity test between the preview and the
  clearance (D2), now `tests/unit/clear-parity.test.ts` ([#105](https://github.com/pcaboor/idp-agent/pull/105)), and `plan --from` keeps
  four gates, said by route (D4); the refactor stays here.
- **Settled by the stage-5 check** (2026-09-29, [its § 7](stage-5-check.md)), each closed
  by the stage-5 pull request that builds it: core-plan-9 and gap-stage5-readiness-5 (a
  `Cleared` minted after the free gates, with a runtime brand, D3; closed, [#105](https://github.com/pcaboor/idp-agent/pull/105)), gap-stage5-readiness-3
  (the base is `HEAD`, the bytes read proven equal to it; closed, [#108](https://github.com/pcaboor/idp-agent/pull/108)), gap-stage5-readiness-12 (the
  branch name as the plan's identity; design §4.3 reworded; closed, [#108](https://github.com/pcaboor/idp-agent/pull/108)), gap-stage5-readiness-8's
  identity half (a clearance names its repository, [#106](https://github.com/pcaboor/idp-agent/pull/106); a forge opened for one refuses the
  other's, closed by [#108](https://github.com/pcaboor/idp-agent/pull/108), `local-forge.test.ts`, *refuses a clearance for the other
  repository, before anything else — both ways*), gap-stage5-readiness-13 (a `Confirm`
  seam taking a structured summary, D5; closed,
  [#109](https://github.com/pcaboor/idp-agent/pull/109), `SubmissionSummary`), cli-ux-12
  (the same seam, in part: `plan.ts` is not split), and
  gap-stage5-readiness-10 (`plan --from … --submit` worded by route, D4; closed,
  [#109](https://github.com/pcaboor/idp-agent/pull/109)). Still open here: cli-ux-10, a
  versioned `--json`, which will version stage 5's `submission` key — `outcome`, `branch`,
  `commit` and `base` (`branch`, `commit`) on a branch cut or found, `outcome` alone when
  nothing changes, `outcome` and `reasons` on a refusal, and for a repository that is not
  `HEAD` a report holding that key alone — every shape pinned by `plan-command.test.ts` (D11);
  and stage 6's keys ([#127](https://github.com/pcaboor/idp-agent/pull/127), pinned by
  `submit-github.test.ts`): `pushed` on `created` and `already-submitted`, `pullRequest`
  (`host`, `repository`, `number`, `url`, `state`, `base`), `olderBase`, `kept` on `refused`,
  and the outcomes `pushed-without-pull-request` (`branch`, `commit`, `reason`) and `closed`
  (`branch`, `number`, `merged`, `at`);
  architecture-9 and product-gap-13, a session ADR, which the check found no blocker for the
  confirmation (D5).
- **The environment annotation and namespaces.** core-plan-8, domain-backstage-6,
  product-gap-5 (stage 8's question 6), architecture-5 and gap-ask-grounding-9 (one
  `refOf`/`parseRef` keeping the namespace; product-gap-4 needs no decision but goes with
  them).
- **Providers.** agents-llm-4, architecture-8 and product-gap-9 (an `openai-compatible`
  adapter, a model per agent, an Anthropic recording), gap-provider-matrix-7 (tool errors
  and reasoning in the transcript), agents-llm-2 (a context and call budget).
- **Recordings and what the scenarios pin.** agents-llm-9, wip-diff-6,
  gap-ask-grounding-13, and wip-diff-7 with tests-2 (pin each replayed exit code and diff).
  Batch B2 closed agents-llm-9's harness half
  ([#116](https://github.com/pcaboor/idp-agent/pull/116)), and stage 6's 6.4.3 its re-record,
  with tests-4: every tape recorded again, and `question-mode.test.ts` failing on a stale tape
  as the other two scenario files do ([#138](https://github.com/pcaboor/idp-agent/pull/138));
  the forced-turn fallback's digest is left.
- **What the Reviewer and the Analyst may accept** (each also a re-record). wip-diff-3 (the
  Reviewer vetoes declaring a missing resource the request needs; high), security-6 (no rule
  ties a grant's consumer and target to the request), gap-ask-grounding-2, -3, -4 and -8
  (witnesses, `nothing`, `holds` and `count` outcomes, `ask` forcing the read road).
- **`init`.** gap-init-real-repos-7 (monorepo root context; `auth/` folders skipped),
  gap-init-real-repos-10 (read the git remote, or drop it from design §7.3). security-5 and
  gap-init-real-repos-5 are closed ([#141](https://github.com/pcaboor/idp-agent/pull/141)):
  an Inspector value is placed only when a file it read states it.
- **Scope and documents.** docs-6 (a keyless `idpa tour`), docs-7 and product-gap-7 (what
  the tool produces and what it does not), docs-8 and architecture-7 (an extension guide;
  plugins after the foundation), product-gap-8 (the registry, closed for v1), docs-10 (the
  audit report's unreachable commit), cli-ux-13's remainder (`iacRepo` is read since 6.3.1;
  `plan --from` reads no `.idp-agent.yml`, and the file is looked for at a service's root only).
- **Toolchain and release.** build-ci-10 (a linter and formatter), build-ci-9 (a dependency
  policy), build-ci-6 (reserving the npm name).

*Belongs elsewhere.* gap-stage5-readiness-6 (compare before writing) is stage 5's writer —
closed at the forge by [#108](https://github.com/pcaboor/idp-agent/pull/108), which re-reads the base and compares each file with the bytes
judged; [#105](https://github.com/pcaboor/idp-agent/pull/105) made the edits and the re-check of a clearance judge one reading of the bytes,
while its `PolicyContext` is still built from the first read, and the witnesses and
`.idp-agent.yml` it judged stay outside the expectation, stated in `SECURITY.md`; architecture-10
(one bounded agent loop) and the rest of architecture-6 (exhaustive dispatch beyond batch A4)
are refactors left unordered.

## How this file is kept

It is updated in the pull request that changes any of it: one that closes a queue item, a
debt or an open question, or that records a decision of the owner's, edits this file in the
same diff. A decision is written in the owner's
terms, dated, with the pull request or ADR that carries it; nothing is added here that the
repository cannot show. The rule is in [`AGENTS.md`](../AGENTS.md#conventions).
