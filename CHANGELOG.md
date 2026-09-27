# Changelog

What changed, for someone using `idp-agent` or contributing to it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), adapted to a project that has not
released a version yet.

- **No release so far.** The repository carries no git tag. `0.1.0-rc.1` was published to
  npm and withdrawn the same day, 2026-09-21 ([#25](https://github.com/pcaboor/idp-agent/pull/25),
  [#26](https://github.com/pcaboor/idp-agent/pull/26)); the next version will be
  `0.1.0-rc.2`.
- **Every pull request adds its line under Unreleased**, in the section that fits (Added,
  Changed, Fixed, Documentation), in plain words, ending with the pull request's link. The
  first release turns Unreleased into its own heading.
- **The dated sections record the pull requests merged before this file existed**, one line
  each from [#43](https://github.com/pcaboor/idp-agent/pull/43) onward, grouped by merge date
  (UTC). Stages 0 to 4, [#1](https://github.com/pcaboor/idp-agent/pull/1) to
  [#42](https://github.com/pcaboor/idp-agent/pull/42), are summarised at the end.

Where the project goes next is in [`docs/roadmap.md`](docs/roadmap.md).

## Unreleased

Each pull request adds its line here.

### Added

- `init platform` writes the Backstage registration, a root `catalog-info.yaml` of
  `kind: Location` whose targets are the path registry's folders, so a company that adopts
  Backstage later ingests the repository with one `catalog.locations` entry; `validate`
  counts it in silence and holds it to Backstage's Location shape (a new `registration`
  rule), a root `catalog-info.yaml` already there is kept and the Location it needs printed
  on stderr, and [`docs/adopting-backstage.md`](docs/adopting-backstage.md) gives the entry,
  its catalogue rule and `idpa`'s read token ([#86](https://github.com/pcaboor/idp-agent/pull/86)).

### Fixed

- `init` on a real service repository ends on a diff or an answerable question: the
  Inspector's 200-file budget reads the manifests, CODEOWNERS, catalog-info, charts,
  Dockerfiles and deployment files first — still handed over in path order — and stderr
  counts what it left out, and how many of those were signal files; a question is asked at a
  terminal as `plan` asks it, the draft's value and a lifecycle's accepted values shown, and
  `--name`, `--lifecycle` and `--owner` answer it on the command line; an existing
  `catalog-info.yaml` or `.yml`, at the root or kept elsewhere, with or without `---`, is read
  whole outside the budget, so a Component it declares — by kind, namespace and name, case
  aside, whatever lifecycle it states, never a same-named API or Resource — is reported as
  already declared on exit 0; a new one is added to that file rather than to a twin, never to
  a test's, an example's or a workspace's, and the name is asked when the file already
  declares a Component under another; only the service's own catalog-info that cannot be read
  stops it — review priority 9 ([#82](https://github.com/pcaboor/idp-agent/pull/82)).
- "Already declared" is exact: a declaration restates a plan only when everything each
  operation states is already there — consumer, target, environment, level, owner and type,
  references compared as the reader writes them — so a grant of the requested name held by
  another consumer, owned by another team or scoped to another environment is refused
  (`declared-otherwise`) instead of reported on exit 0 as done; two operations aimed at one
  reference are refused, naming both (`same-reference-twice`); an update joining a consumer
  the grant already lists at the stated level is reported already declared, with the grant's
  type, owner and what it is over; and "nothing to change" names the file and every matching
  field, and exits 0 only when every operation is already declared, in prose and in `--json`
  alike — review priority 8 ([#83](https://github.com/pcaboor/idp-agent/pull/83)).
- An environment is never inferred, against a natural name too: a right's scope is the
  environment it declares, and a name saying another is refused (`environment-in-name`);
  the environment of the grant an update extends is asked when nothing the user said names
  it, and an answer naming another is refused with the grant of that environment as the
  remedy, a grant declaring none included; a request names a value only as a whole word, so
  "non-prod" names no prod and "lion-ops" no lion, and "en production" or "orders-db-prod"
  names none, so the environment is asked — unless the request names everything the grant
  is over by its reference in full and each declares the grant's environment, which is then
  the person's pointing, not an inference; a bare name never points, and a word or a
  pointing is vetoed when the request mentions anywhere a name the repository declares in
  another environment, so it is asked; invisible characters no longer split a word —
  review priority 6 ([#79](https://github.com/pcaboor/idp-agent/pull/79)).
- An environment is never taken from the words of a request, in any language, exactly as
  an access level is not: "give billing-api read access to orders-db in prod", "not prod"
  and "prodではなく" are all asked, the environments in use listed. It comes from the
  person's answer, or from the declaration of what the request names by its reference in
  full — for the grant an update extends and now for a right the draft creates, whose
  `metadata.env` is then derived — and `environment-mismatch` holds the plan to that. A
  word never states an environment but can cancel one: "…resource:default/orders-db-prod
  in dev" is asked, where it once ended on the prod diff. A negation marker anywhere in the
  request, in a list extended with the forms two verifiers found ("dont", "anywhere but",
  "ではなく", "nao" without its accent, "avoiding", "in place of", "hormis", "대신"), vetoes
  the pointing too ([#81](https://github.com/pcaboor/idp-agent/pull/81)).
- What the Inspector reads from a service repository carries no secret the filter can see:
  every match in a file is judged, so a placeholder no longer lets a literal after it
  through, and a file holding one is withheld whole; the keys of Anthropic, OpenAI, GitHub,
  GitLab, Slack, AWS, Google, Stripe, npm and Hugging Face, a private key at any base64
  alignment or with its header stripped, a Kubernetes Secret's data in YAML or JSON, a
  docker `auths` entry and a password in a URL are recognised, and so is a secret-named key
  written as one word (`DBPASSWORD`), as a flag (`--password=`, `-D…password=`), with its
  value on the next line or quoted with punctuation, as an XML element, a subscript, a
  spaced flag or a netrc line, or escaped (`\u0073k-ant-…`) or base64-encoded; in a git
  repository only the files git tracks are read, an untracked one counted and never named,
  and git is started outside the repository and runs none of its commands, while a checkout
  git cannot list is read as nothing and a directory outside git is walked as before and
  said so on stderr; `jsonwebtoken`, `existingSecret`, a README's `your-api-key`, a type
  (`password: string`) or a call no longer withhold a file; and `init` refuses the home
  directory and the filesystem root — review priority 7
  ([#80](https://github.com/pcaboor/idp-agent/pull/80)).

### Documentation

- The review's 133 findings that no pull request named are swept against `main`: 15 fixed,
  39 partly fixed, 79 still true, none obsolete; the review's Status section records each
  verdict, and the roadmap batches the cheap fixes into pull requests and lists what waits
  for a re-record or the owner ([#85](https://github.com/pcaboor/idp-agent/pull/85)).
- The `backstage-http` read provider is designed: the catalogue is read once per run, before
  any model, through the same reader as a file, `spec` and never `relations`; the token comes
  from `IDP_BACKSTAGE_TOKEN` and reaches only the configured origin, on two `GET` routes and
  never a child process; every bound is stated and a partial catalogue is refused; Backstage
  answers questions and the declarations repository still decides changes; stage 8's gate
  matches the location the catalogue records, never the one an entity claims; five slices,
  the first demoable after a slice 0 that makes the repository Backstage-ready in one
  registration — installing a Backstage stays out of scope — and the owner's answers
  ([#84](https://github.com/pcaboor/idp-agent/pull/84)).
- Stage 8, discovery, is designed: from a service repository, report the dependencies its
  configuration already states, with evidence the engine re-reads, and propose the missing
  catalog-info and rights; the owner's answers to its questions are recorded
  ([#76](https://github.com/pcaboor/idp-agent/pull/76)).
- The first two minutes work and tell the truth: a keyless README first screen whose outputs
  a test holds, `SECURITY.md` rewritten for today with the test behind each guarantee, a
  `.env.example` that cannot drift from the code, `pnpm demo` and the examples checked by
  smoke, and the key shown to reach only its provider's header
  ([#78](https://github.com/pcaboor/idp-agent/pull/78)).
- `CHANGELOG.md`, `docs/roadmap.md` and the review's Status section record what was done,
  what is next and the owner's decisions; `AGENTS.md` says each pull request keeps them
  ([#77](https://github.com/pcaboor/idp-agent/pull/77)).

## 2026-09-26

### Added

- `idpa relations <entity>` traces every declared relation, with the whole path of each row,
  the rights on it with their levels and the environment at each step, and, with `--to`, the
  paths between two entities. It needs no model. The Analyst can answer a relation question
  with the same block ([#74](https://github.com/pcaboor/idp-agent/pull/74)).
- Agent-backed runs can be traced into a local MLflow (`IDP_MLFLOW_TRACKING_URI`) or into
  files (`IDP_TRACE_DIR`), and `pnpm trace:push` sends replayed traces. Tracing never changes
  what a run prints or how it exits ([#70](https://github.com/pcaboor/idp-agent/pull/70)).
- `src/trace/` builds a run's trace from the event stream and encodes it for MLflow, without
  guessing a span boundary. ADR-0009 records the decision, and a 14th architecture rule keeps
  the module away from the disk and the network ([#69](https://github.com/pcaboor/idp-agent/pull/69)).
- The token usage a provider reports is kept with each model call and in new recordings; a
  count the provider did not report stays absent, never zero
  ([#68](https://github.com/pcaboor/idp-agent/pull/68)).
- For contributors: `pnpm mlflow:up` / `pnpm mlflow:down` run a pinned MLflow locally, and
  `pnpm mlflow:contract` checks the OTLP body it accepts against a fixture. Never part of CI
  ([#66](https://github.com/pcaboor/idp-agent/pull/66)).
- Backstage `kind: API` entities are read, with the APIs a Component provides
  (`spec.providesApis`): `graph --kind API`, an API card on `show`, and an APIs block in the
  overview. `consumesApis` is deliberately not read. The plan road is unchanged
  ([#71](https://github.com/pcaboor/idp-agent/pull/71)).

### Changed

- A reference that names nothing is shown, on `show`'s card and in what the Analyst reads,
  marked as declared nowhere with the entities that share its name. It is never hidden, and
  never resolved by guess ([#73](https://github.com/pcaboor/idp-agent/pull/73)).
- The event stream says when an agent and an attempt end and which gates passed, and pairs
  each tool result with its call. One new stderr line: `← refused: answer is not a tool this
  agent has` ([#67](https://github.com/pcaboor/idp-agent/pull/67)).

### Fixed

- Five small defects: a missing field reads "required"; the Analyst may name the entity it
  asked the dependencies of; a derived owner prints once per run; the Supervisor asks
  OpenAI reasoning models for a low reasoning effort and runs on `IDP_SUPERVISOR_MODEL` when
  it is set; an assistant turn that says nothing is never sent to a provider ([#75](https://github.com/pcaboor/idp-agent/pull/75)).
- `plan` tells the Architect the level the user answered and never offers to widen it: a
  refused join offers a separate grant at that level instead. Questions say what they
  accept ([#72](https://github.com/pcaboor/idp-agent/pull/72)).

### Documentation

- The tracing design (`docs/tracing-design.md`) and its implementation plan
  (`docs/plans/tracing-mlflow.md`) ([#65](https://github.com/pcaboor/idp-agent/pull/65)).

## 2026-09-25

### Added

- A verified answer reads like a chat: a short introduction and conclusion written by the
  model, each line marked `›`, checked against what the tools returned, around the
  engine's unchanged block. `--quiet` prints the block alone (ADR-0008)
  ([#64](https://github.com/pcaboor/idp-agent/pull/64)).
- One gesture, `idpa "<phrase>"`, from anywhere: the Supervisor sends a question to `ask`'s
  road and a change to `plan`'s. A one-word typo of a command is caught without a model, and
  without `--project` the Inspector reads the working directory only when it is an
  application repository
  ([#63](https://github.com/pcaboor/idp-agent/pull/63)).
- `plan --project <dir>` names the service to inspect, and `plan` refuses to inspect a
  declarations repository as one. What `plan` and `init` print from a model or a file is
  cleaned of terminal controls ([#62](https://github.com/pcaboor/idp-agent/pull/62)).
- A configured default source: `IDP_REPO` or `repo` in the personal `config.yml` names the
  declarations repository once, so `idpa` works from any directory
  ([#60](https://github.com/pcaboor/idp-agent/pull/60)).

### Fixed

- A question answered once is not asked again in the same run: each answer is put back on
  every redraft, by entity and field. It is asked again only when the entity is renamed or
  changes kind, a list element moved, the schema refuses the value, or two operations amend
  the same entity ([#61](https://github.com/pcaboor/idp-agent/pull/61)).

## 2026-09-24

### Added

- `ask` answers "what is in here?" with an overview the engine writes: counts by kind, type,
  environment and owner, rights by level, and every dangling reference
  ([#54](https://github.com/pcaboor/idp-agent/pull/54)).
- `ask`, `graph` and `show` take `--repo <directory>` and read that declarations repository;
  without it, one stderr line says the demo SI is being read (review priority 3)
  ([#46](https://github.com/pcaboor/idp-agent/pull/46)).

### Changed

- `show` and the overview say what an entity is (description, system, tags, links), and
  every string from a file or a model is cleaned of terminal controls before `show`,
  `graph`, `ask` or `validate` prints it ([#58](https://github.com/pcaboor/idp-agent/pull/58)).
- `ask`, `graph` and `show` read the declarations repository you are standing in; `--demo`
  forces the fictional SI ([#57](https://github.com/pcaboor/idp-agent/pull/57)).
- A document of a kind this tool does not model (a Group, a `mkdocs.yml`) is set aside with a
  warning instead of failing `validate`; an unknown kind under Backstage's own apiVersion is
  refused as a typo (review priority 4, second half)
  ([#49](https://github.com/pcaboor/idp-agent/pull/49)).

### Fixed

- A failed model call ends on one clear line: a timeout (`IDP_TIMEOUT`, 120 s by default), a
  missing key before any agent runs (exit 2), a refused key, a rate limit or a server error
  ([#59](https://github.com/pcaboor/idp-agent/pull/59)).
- For contributors: `pnpm test` and `pnpm smoke` leave nothing in the temp directory
  ([#56](https://github.com/pcaboor/idp-agent/pull/56)).
- `ask` works with a real OpenAI model: tools are declared `strict: false`, a search on a
  value no entity carries names the values in use, and a refused call is shown as refused
  ([#55](https://github.com/pcaboor/idp-agent/pull/55)).
- The short references a real Backstage catalogue writes (`owner: team-a`) are read the way
  Backstage fills them in ([#53](https://github.com/pcaboor/idp-agent/pull/53)).
- One provenance, read by every gate: an owner answered at the prompt is asked once, and an
  answered environment is checked like a typed one (review priority 5)
  ([#52](https://github.com/pcaboor/idp-agent/pull/52)).
- A string a YAML 1.2 reader would read back as a number (`0o17`, `1e3`) is quoted, which
  also ends a property test that failed CI at random
  ([#50](https://github.com/pcaboor/idp-agent/pull/50)).
- A plan is refused only for the violations it introduces or the files it touches; faults
  already in the repository are summarised under the preview (review priority 4, first
  half) ([#48](https://github.com/pcaboor/idp-agent/pull/48)).
- A plan never reports an edit its bytes do not carry out: every edit is re-read by the YAML
  parser, and one that fails is dropped with its reason (review priority 2)
  ([#45](https://github.com/pcaboor/idp-agent/pull/45)).
- Every tool is advertised with an object root, the shape Anthropic requires, held by a
  contract test of each provider's request (not a live Anthropic run; review priority 1)
  ([#44](https://github.com/pcaboor/idp-agent/pull/44)).

### Documentation

- The Node badge in the README renders ([#51](https://github.com/pcaboor/idp-agent/pull/51)).
- The README opens on what the tool is, a demo and why it exists
  ([#47](https://github.com/pcaboor/idp-agent/pull/47)).
- The 2026-09-23 deep review is recorded in `docs/reviews/`, and the test counts are
  corrected ([#43](https://github.com/pcaboor/idp-agent/pull/43)).

## Stages 0–4, 2026-09-10 to 2026-09-23

**Stage 0, the deterministic core** ([#1](https://github.com/pcaboor/idp-agent/pull/1),
[#2](https://github.com/pcaboor/idp-agent/pull/2)). `src/core/` with no AI, no network and
no CLI: the resource-type registry, the entity and `Plan` schemas, engine-computed paths, a
deterministic serialiser and whole-document YAML surgery, with property-based invariants
and architecture rules. The provider schedule was pinned in the design.

**Stage 1, read-only** ([#3](https://github.com/pcaboor/idp-agent/pull/3) to
[#7](https://github.com/pcaboor/idp-agent/pull/7)). `graph` and `show` over a fictional SI
of 33 entities, with no model. A dependency is read from both ends, a query that resolves
nothing exits 1, and `main()` is tested. `AGENTS.md`, the README, `SECURITY.md` and
`CONTRIBUTING.md` were written.

**Stage 2, question mode** ([#8](https://github.com/pcaboor/idp-agent/pull/8) to
[#16](https://github.com/pcaboor/idp-agent/pull/16)). The network is blocked in the suite
and the import rules follow imports transitively. A model turn is recorded and replayed;
three provider adapters ship, none of them the default. The Supervisor classifies a
request, the Analyst uses four bounded read-only tools, and `ask` refuses any reference no
tool returned before printing its answer.

**Stage 3, `init platform` and `validate`** ([#17](https://github.com/pcaboor/idp-agent/pull/17)
to [#27](https://github.com/pcaboor/idp-agent/pull/27),
[#29](https://github.com/pcaboor/idp-agent/pull/29)). The entity and plan schemas are
exported as JSON Schema, six rules refuse what the catalogue would accept, and `validate`
reads an IaC repository keeping each entity's file. `init platform` scaffolds a
declarations repository from the registry and never overwrites a file.
`0.1.0-rc.1` was published and then withdrawn, and the generated workflow says it is waiting
([#25](https://github.com/pcaboor/idp-agent/pull/25),
[#26](https://github.com/pcaboor/idp-agent/pull/26)). The documentation stopped naming the
employer behind the original production system
([#27](https://github.com/pcaboor/idp-agent/pull/27)) and was brought back in line with the
code ([#29](https://github.com/pcaboor/idp-agent/pull/29)).

**Stage 4, preview only** ([#28](https://github.com/pcaboor/idp-agent/pull/28),
[#30](https://github.com/pcaboor/idp-agent/pull/30) to
[#38](https://github.com/pcaboor/idp-agent/pull/38)). A proposal is stricter than an entity
read from disk. A plan is signed by where each value came from, re-checked by policies and
against the repository, and rendered as a diff that writes nothing. The Inspector reads an
application repository without its secrets, the Architect drafts into a typed buffer, and a
bounded repair loop runs five gates with an independent Reviewer. `plan "<intent>"` and
`init --repo` end on that preview, and five scenarios are recorded.

**After stage 4, an independent audit** ([#39](https://github.com/pcaboor/idp-agent/pull/39)
to [#42](https://github.com/pcaboor/idp-agent/pull/42)). A grant states `read` or
`readwrite`, and `docs/audit-report.md` records an audit that falsified claims the project
made about itself. Its findings were closed: a grant reaches the repository, the Reviewer is
told what it is judging, and a plan that grants nothing no longer prints `nothing to
change.` on exit 0.
