# idp-agent — Design Specification

**Date** 2026-09-09 · **Status** approved, ready for implementation planning · **Target** v0.1

---

## 1. Purpose

A CLI framework that turns a natural-language intent into versioned infrastructure
declarations that are reviewed, then merged.

It builds on a declarative reconciliation system designed and shipped to production
(CI/CD trigger on `catalog-info.yml`, central IaC repository, provisioning
through an API gateway, firewall automation and ticketing), adding the multi-agent
orchestration layer that system never had.

---

## 2. Guiding axis

The repository primarily demonstrates **how to build a reliable multi-agent system**:
deterministic orchestration, structural guardrails, a closed repair loop, and tests
that reproduce without an API key.

Platform GitOps is the application domain, not the subject.

**Tie-breaker rule** — when two options compete, prefer the one that makes the
harness more verifiable over the one that adds an integration.

---

## 3. Decisions

| Topic | Decision |
|---|---|
| Axis | Reliable agent harness; GitOps is the playing field |
| SI context | `ContextProvider` interface, embedded fictional SI by default |
| Source of truth | Backstage to **explore**, the git repository to **decide on writes** |
| Provider schedule | fixtures in stages 1-2, `iac-fs` from stage 4, `backstage-http` at MVP |
| LLM layer | Vercel AI SDK, low-level mode — multi-provider, loop written by hand |
| Reliability proof | Record/replay recordings + property-based invariants + negative tests |
| Terminal | Ink; the harness emits events, the TUI draws them |
| Forge | `ForgeProvider` interface — `local` and `github` in v0.1, GitLab in v0.2 |
| v0.1 scope | `init` and `link`, both ending in a merge request |
| Structure | Single package, folders aligned with future packages |
| v0.2 | Extract `core/` and `context/` as publishable packages + GitLab |
| Name | `idp-agent` on npm, short command alias `idpa` |
| Commands | `init platform` · `init` · bare intent |
| Configuration | `.idp-agent.yml` committed per app; a personal `config.yml` per machine; credentials never in either |
| Language | English throughout — code, docs, commits, CLI output |
| Licence | Apache-2.0 |

---

## 4. Doctrine — non-negotiable invariants

Drawn from a production system. Each has a known cost when violated, and none
follows from the documentation of the tools involved.

### 4.1 Model

- **A resource is an object; an access is a right over that resource.** The access —
  not the resource — carries the list of its consumers. A right is over *something* and
  granted to *somebody*, so a proposal for one states both `dependsOn` and `dependencyOf`,
  and a proposal for an object states no consumers at all; the proposal schema refuses
  each of those outright, because neither needs a repository to judge. A grant naming no
  consumer grants nothing to nobody, and it used to pass every gate and render a diff that
  read like an authorisation.
- **A right states the level it grants** — `read` or `readwrite` — and only a right may.
  The level is a property of the grant, not a second type: splitting `database-access` in
  two would double the registry and the folder layout for one boolean. Stating it is
  optional, because a repository written before the field still has to validate and a
  network flow has no level at all; an unstated level is **unstated**, reported as absent
  and never read as `readwrite`.
- **A declaration is read from both ends.** Which side wrote the edge down — `dependsOn`
  on the consumer, `dependencyOf` on the access — decides which file a reviewer sees,
  never which question may be answered. A graph query resolves one declared hop in
  either direction; reading a declaration back is not inference, and composing several
  hops is a separate, separately named walk.
- **The environment is part of an access's identity.** Being authorised in dev grants
  nothing in staging: two distinct entities.
- **Declare, never infer.** What the catalogue does not know is reported as unknown,
  never filled in with a plausible value.
- **The read model is wider than the write model.** This tool proposes and files two
  kinds, Component and Resource, and a catalogue holds more. Backstage's own `kind: API`
  is **read**: a node of the graph, held to what Backstage requires of one — a type, a
  lifecycle, an owner and a definition — and refused with a reason when it lacks one,
  like a broken Component. Its definition is kept as the fact that it is declared, never
  its text: it is printed nowhere and sent to no model. A Component's
  `spec.providesApis` is read too, as a relation of its own — providing is not
  depending, either way — and a reference in it naming nothing is dangling, as a
  `dependsOn` one is. Neither is ever **proposed**: a proposal has no API kind and no
  `providesApis`, and a change is decided against the write model, where an API is a
  reference that resolves and never a node. **`spec.consumesApis` is deliberately not
  read.** Here, consuming something is an access right — a Resource that `dependsOn`
  what it reaches and lists the consumer in `dependencyOf` — because the right is what
  gets provisioned; a second declaration of the same fact would be a second truth to
  keep aligned with the first. So the rights over an API are how its consumers are
  found, walked as for any object. Every other kind — Group, System, Domain, User — is
  still set aside, and said to be. So are three APIs, as they were before any was read,
  because reading them would get them wrong rather than refuse them: a `kind: API` under
  another tool's apiVersion, which is no Backstage entity; one outside the `default`
  namespace, which the graph's `kind:default/name` keys would confuse with its namesake;
  and one whose name is in upper case, which Backstage allows and this tool's name grammar
  does not read — a known gap, closed with namespaces. A `providesApis` reference is
  never a reason to refuse its Component: a name in upper case is folded, since Backstage
  compares references without regard to case, and so names the API set aside for it; one
  the grammar cannot split even so is kept as written, and reported dangling. The `schemas/entity.schema.json` that `init platform` ships describes
  the reader, so a Component there may carry `providesApis`, and nothing `consumesApis`.
- **Downstream systems are destinations, not sources.** Mirroring their configuration
  would turn the catalogue into a copy to keep aligned, with no added value.
- **An application never declares its own dependencies** in a repository nobody reviews.

### 4.2 Authorisation

- **The merge is the act of authorisation.** The CLI opens a merge request; it never
  writes to the main branch. Confirming in the terminal means "I am submitting my
  request", not "I am authorising myself".
- **Separate tokens per capability.** The token that opens a merge request cannot merge
  it — and a test asserts that this action **fails**.
- Any check that guards against destruction is repeated engine-side, at the moment of
  acting. A control that only lives in the client controls nothing.

### 4.3 Writing

- **One file per entity**, in one folder per nature. Two concurrent declarations never
  write to the same file.
- **Textual surgery, never a reparse.** A reviewer must see an added line, not a
  reformatted file.
- **An entity's location is read from the entity**, through its annotation — never
  inferred from its type.
- **A blank line between YAML documents.** Without it, since documents open with the
  same lines, Git anchors deletions poorly and renders them straddling two entities.
  The result is correct and the diff says otherwise — and here, review decides.
- **Absent means already done.** Removing a line that is no longer there must not
  raise: a branch may be replayed.

### 4.4 Reconciliation

- **Never delete an orphaned access automatically.** Its declaration may be the only
  trace of a still-open network flow or a still-active account. Removing the line
  would make it disappear **without closing the access**. An automaton reports; it
  does not delete.
- **Record a date of first absence, never a counter of passes** — otherwise changing
  the schedule silently changes the safeguard.
- **One witness file per folder**: a pattern with no match is a read error, not an
  empty set.
- **The catalogue lags the repository** (~2 min). Check against the repository before
  proposing, and **check again at the moment of writing**.
- The catalogue **ignores duplicates silently**: CI must be the one to refuse.

---

## 5. Architecture

### 5.1 Trust boundary

One object crosses the boundary **per direction of authority**.

The **`Plan`** crosses when the AI side asks for a change: it authorises writes and
carries values the model chose, so everything downstream of it — Zod, policies, the
Reviewer, the repository re-check — exists to refuse it.

The **`Answer`** crosses when the AI side reports a read (stage 2, ADR-0007). It
authorises nothing and names no value: it carries only identifiers the engine itself
returned, and the engine re-reads every one of them from the graph before printing. An
identifier the tools never produced is refused and named. One member, `overview`, carries
no identifier at all: the model chooses it for a request to describe the catalogue as a
whole, and the engine writes the description from the graph.

The model may frame that block in words (ADR-0008): an `intro` and a `conclusion` on
`entities`, `nothing` and `overview`, written in the same terminal call. They are not the
answer and authorise nothing. The engine checks every sentence before printing it — a
sentence naming an entity no tool returned, or an identifier nobody read, is dropped whole
— then cleans it, bounds it, and prints it marked `› ` as the model's, around the block's
unchanged bytes. The check removes entities of the graph and identifiers nobody read, and
nothing else: a name written in plain words (a team, a product, "the billing API"), a figure,
a claim about the block all pass, and it does not make a sentence true. The label is what
tells the reader which words are the model's. `--quiet` prints the block alone.

The carve-out has a limit, and it does not travel: the witness check is a read-side
guarantee. `propose()` needed its own, because a `Plan` proposes values that were never in
the catalogue to begin with — that is the **signature**, gate [2] of § 6.1, which
classifies every leaf of a proposal by where it came from and turns what nobody can vouch
for into a question rather than a value.

One source of vouching is the proposal itself. A grant over a resource the catalogue does
not hold is two operations — declare the resource, then the right over it — and the second
names the first by a reference that is in no witness set, because a witness set is what the
read tools returned. That reference is grounded in the plan the reviewer reads before
merging, so it classifies as derived. It is not a way in: a *name* is classified on its
own, so a name the model invented is a question already and the plan cannot be applied —
the reference inherits the name's standing rather than manufacturing its own.

```
┌───────────────────── AI ZONE (untrusted) ─────────────────────────┐
│  Supervisor ──► Inspector ──► Architect ──► Reviewer              │
│                    │             │             │                  │
│                READ tools    READ tools     reason                │
│                              + propose()                          │
└────────────────────────────────┬──────────────────────────────────┘
                                 │
                        ═══ Plan (JSON) ═══   ◄── the write crossing
                                 │
┌────────────────────────────────┼──────── DETERMINISTIC ZONE ──────┐
│  Zod ─► signature ─► policies ─► re-check ─► Reviewer ─► Diff     │
│    │                                                        │     │
│    └── failure ──► report ──► back to Architect (3 max)     │     │
│                                                             ▼     │
│                              [ CONFIRMATION ] ──► branch + MR     │
└───────────────────────────────────────────────────────────────────┘
```

The last box is not built. Stage 4 ends at the diff, and the branch and the merge request
arrive at stages 5 and 6 — see § 7.4.

### 5.2 What `propose()` actually is

The AI **produces the content**; it **does not write the file**.

| Act | Actor |
|---|---|
| Choosing the name, owner, environment, `dependsOn` | the AI — entirely |
| Choosing the file path | the engine |
| Serialising to YAML | the engine (single deterministic serialiser) |
| Putting bytes on disk | the engine |

**Two cases for the path**, which resolves the apparent tension with § 4.3:

- **New entity** — the engine computes the path by convention, `<nature>/<name>.yml`.
  The model cannot aim at it.
- **Existing entity** — the path is **read from the entity**, in its
  `idp-agent.dev/source-file` annotation, never re-derived from its type. If someone
  filed it elsewhere, the change goes where it is.

The model never emits a line of YAML: it emits a **structure**. That removes broken
indentation, missing escapes, forgotten `---`, and guarantees an identical format
whichever model is in use.

So `propose()` is a write tool — but it writes into a typed buffer, not to disk.

> **The agent drafts. The engine signs.**

### 5.3 Operations

A closed discriminated union. What is not modelled cannot be requested. As it ships, in
`core/schemas/plan.ts`:

```ts
type Operation =
  | { op: 'create-entity';       entity: ProposedResource | ProposedComponent }
  | { op: 'update-entity';       entityRef: string; patch: Patch }
  | { op: 'create-catalog-info'; repoPath: string; entity: ProposedComponent }
```

`create-entity` carries no separate `kind` field: the entity is itself discriminated on
`kind`, so "the operation says Resource and the entity says Component" is unrepresentable
rather than a case someone has to remember to check. It is a *discriminated* union and not
a bare one for the sake of the message — a bare union reports `invalid_union` at
`operations.0.entity` and swallows the issue that actually failed, and a repair loop
(§ 6.1) cannot correct a field nobody named.

`Patch` is closed for the same reason and holds exactly one member today:
`add-dependency-of`, carrying the consumer **and the level that grant grants**. A
free-form patch is a write tool with no shape.

The level is in the operation because it was nowhere else. An update joins a consumer to an
*existing* grant, so the plan stated no level, so the signature had nothing to classify and
the only remaining gate read the requested level out of the English in the request. A
request arrives in whatever language the person wrote it in — `core/plan/echoes.ts` states
that rule and the script-based word boundary it turns on — so *accès en lecture* named no
level, that gate stayed silent, and a `readwrite` grant was handed to a request for `read`
at exit 0. Stated as a field, the level is classified like every other leaf, except that a
word in the request never vouches for it — echoed when the user answered it for that grant,
novel and therefore a question when they did not, in every script — and
`declared-level-mismatch` compares it to what the repository declares without reading a word
of the request. The field is `'read' | 'readwrite' | { unknown }`, and **optional**, which
`metadata.env` is not: every declaration is in exactly one environment, while a
`network-access` is opened or it is not and a right with no level has none to state. So an
omission is a claim — *this grant states no level* — and it is checked like any other: it
agrees with a pre-`access` declaration, which is the case it exists to express, and is
refused against a grant that declares one.

**The proposal schemas are strict, and deliberately stricter than `entitySchema`.** That
asymmetry is the point. `entitySchema` READS the Components and Resources of a real
Backstage catalogue, whose files legitimately carry fields this tool does not model, so
making it strict would break the reader on any real repository. Those two kinds are the
only ones it proposes. Backstage's API is read beside them, through a schema of its own,
`apiSchema`, that no proposal can reach (§4.1). The rest of a real catalogue — Groups,
Users, Systems, Locations, Templates — and a YAML file that is no catalogue entry at all, a
`mkdocs.yml` beside the entities, are set aside by `parseDocuments` before the schema runs:
reported, as a `not-modelled` warning in `validate` and one summary line in the read
commands, and never refused, because refusing them turned a catalogue Backstage reads
without complaint into a red build. A mistyped kind is told from a custom one by where it
is declared, never by guessing what was meant: Backstage's own `backstage.io/` apiVersion
defines a closed set of kinds, so `kind: Resouce` under it is refused with the list of the
kinds that group defines, while a kind of somebody's own lives under their own apiVersion
and is set aside. A PROPOSAL travels the other way: an unmodelled field there is either an
invention, or a field the deterministic serialiser will drop in silence. Both are
unacceptable.

References follow the same asymmetry. A real catalogue writes `owner: team-a` and
`resource:orders-db`, and Backstage fills in the omitted kind and namespace by documented
defaults — the referring entity's namespace, and per field a default kind (Group for an
owner, API for `providesApis`, none at all for `dependsOn` and `dependencyOf`, where the
kind must be written).
`entitySchema` applies those same defaults and yields `kind:namespace/name`, so everything
downstream compares one spelling while the file keeps the one a person wrote. That is
reading what Backstage reads, not inferring: a `dependsOn` with no kind is still refused.
A proposal, and everything the engine writes, takes the full form only.

Four things are absent from a proposal, and each absence is a guarantee rather than an
omission:

| absent | what the absence guarantees |
|---|---|
| `apiVersion` | the engine derives it — one repository, one version string |
| `annotations` | there is nowhere to put `idp-agent.dev/source-file`, which `resolveEntityPath` reads to decide where a file goes. Without this absence a model aims at its own path and § 5.2 is a promise nothing keeps. The environment is a named field, `metadata.env`, precisely so the map is not needed for it |
| `description` | free prose has no provenance. The signature asks one question of every value — where did it come from? — and a sentence a model writes is echoed by nothing and enumerated by nothing, so it classifies as novel and becomes a question put to the user about a sentence the model had just invented. That dead-ended a whole run once: the Architect was never asked again and the Reviewer never called. Prose belongs in the merge request, where a human writes it |
| a path, anywhere | the engine chooses it (§ 5.2) |

The bounds are part of the boundary, not a style rule: a plan is untrusted input. Fifty
operations, 2 000 characters of intent, 32 levels of nesting, 10 000 values, 8 192
characters per string — including the reason inside `{ unknown }`, or the one escape hatch
for "I do not know" becomes the one unbounded channel out of a model and into the next
agent's opening message. The operation ceiling is low on purpose: a plan a human cannot
read in one merge request is not a plan, it is a migration, and it needs a different tool.
Depth and node count are walked iteratively, because a proposal nested fifty thousand deep
would otherwise kill the CLI by overflowing a call stack, which is a cheap thing for a
steered model to achieve.

A proposed name is `/^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/`, and that pattern is
exported rather than restated. The Inspector reports a name that lands in `metadata.name`,
and "a name it cannot express is `{unknown}` and the CLI asks" is only true if both ends
measure *expressible* with the same regex.

No delete operation in v0.1 (see § 4.4).

An `echoed` leaf means *the person asked for this*, so it rests on the request being a
person's sentence. `init` composes one from the inspection, and a composed sentence vouches
for no word in it — what an inspection actually read out of the project's files stands
behind itself instead, at the field it was read for. An answer typed at a prompt vouches the
same way, for the field it answered and nowhere else, and the derivation and the policies
read the request and the answers exactly as the signature does (`core/plan/provenance.ts`).
The limit that remains is stated in `sign.ts` rather than fixed: a word test cannot tell a
word that names something from a word that is merely present, so `please-thanks` on "please
declare a database in prod, thanks" signs echoed. Every fix is a list of words that do not
count, and a stop list works in one language and silently weakens the check in every other —
which is a false guarantee, where a filler-word name is a cosmetic one the diff shows.

### 5.4 Unknown fields

Every `Plan` field a model *chooses* is either a value or `{ unknown: string }`. A `Plan`
holding an `unknown` **cannot be applied**: the CLI stops and asks the user. This is
"declare, never infer" made executable.

Three fields are outside that, and none of them is a choice. `metadata.name` cannot be
`{unknown}`: an entity with no name is not an entity, so a proposal that cannot name what
it proposes is refused at gate [1] rather than turned into a question — the Inspector's
`ProjectFacts` *can* report an unknown name, which is where that question belongs.
`dependsOn` and `dependencyOf` are lists, where an `unknown` inside one would be a
reference nobody could resolve — so neither may hold one. Absent is a complete answer for a
list in general and **not** for a right (§4.1): a `database-access` states both, and the
proposal schema refuses one that does not, because a grant naming no consumer grants
nothing to nobody. And `repoPath` was never
the model's to write (§ 5.3).

### 5.5 Dependency rules, enforced in CI

Two rules were written here first; **fourteen** are enforced today, in
`tests/architecture/dependencies.test.ts`. The two founding ones:

1. `core/` never imports `agents/` or `llm/`.
2. `agents/` never imports `fs`, `child_process`, or a git client.

Rule 2 is checked over the **transitive** import closure, and that is the part that does
the work: `agents/ → llm/client → recording → node:fs` passes a grep of one directory and
fails this test. `SECURITY.md` states there is no code path from an agent to a file; this
is that statement, made checkable.

Two consequences look odd until the rule is known. `llm/client.ts` holds types only — an
agent imports it, so a runtime import there would put `ai` inside the agent closure. And
the filesystem implementation of the recording store lives in `cli/`, not in `llm/`, for
the same reason.

The other twelve extend the same idea to the layers added since: `core/` reaches neither
the network, nor the disk, nor the model SDK, nor `context/`, `cli/` or `scaffold/`; only
`llm/` imports the model SDK, and `agents/` imports `llm/client.js` and nothing else from
it; `scaffold/` imports `core/` and nothing else of ours, and exactly one module in it
writes; only `context/iac-fs` and `context/project-fs` read a user's repository; `trace/`
reaches nothing but types and never names `fetch`, and only `cli/` reaches it. **Add a
rule when you add a layer** — the count in this paragraph is the one that drifts first.

---

## 6. Agents

Orchestration is **deterministic**. The Supervisor classifies intent; plain TypeScript
sequences the steps. No agent decides the sequence.

Five agents, and the tool column is what each one actually holds. The terminal tool — the
one call that ends the agent's turn — is the last in each row.

| Agent | Input | Tools | Output |
|---|---|---|---|
| Supervisor | the request + a bucketed SI summary | none | `MUTATION` or `QUESTION` |
| Analyst | a question + the SI summary | `search_entities`, `get_entity`, `get_dependencies`, `get_apis`, `answer` | an `Answer` |
| Inspector | a project snapshot, already read and capped | `list_files`, `read_file`, `report_facts` | `ProjectFacts` |
| Architect | `ProjectFacts` + the SI summary + the repair report | `search_entities`, `get_entity`, `get_dependencies`, `propose` | `Plan` |
| Reviewer | the `Plan` + the original request | `verdict` | `ok` or a rejection reason |

The Architect has **no** `get_governance_rule`: the configurable rule engine is deferred
past v0.1 (§ 6.1), and a tool that names a feature nobody built is a prompt for the model
to ask about one. It also has no `answer` — that is the Analyst's terminal call, and an
agent with two ways to finish has two ways to finish something it was not asked to.

The Reviewer has **no SI reads at all**, and the emptiness is the design. It and the
Architect are the same weights behind the same provider, so their errors are correlated by
construction; a second opinion fed the first one's transcript is an echo, and this echo
holds a veto. It sees the Plan and the original request, never the draft's reasoning,
never which attempt this is, never what an earlier gate said.

The Inspector never touches a disk, because nothing reachable from `agents/` may (§ 5.5).
`context/project-fs` reads the repository on the deterministic side and hands over a
snapshot, with every exclusion already applied: `.env*`, key material, credential files,
`.git/`, `node_modules/` and hidden directories bar `.github`, plus a content check for a
PEM header behind an innocent name, a symlink refusal, and three caps — 200 files, 64 KB
each, 1 MB in total. `list_files` and `read_file` read that snapshot and nothing else, so
"confined to the current repository" is a property of the data the agent was handed rather
than a check it performs.

**Why a Reviewer LLM on top of Zod** — Zod validates *shape* (`owner: tiger` instead of
`group:default/tiger`); the Reviewer validates *substance* (the request was about dev,
the plan opens prod access). Perfectly valid YAML can answer the wrong question.

### 6.1 Repair loop

Five gates as it ships, in the order `agents/repair.ts` runs them. The signature was prose
in this section before it was a gate; it is one now, and the CLI names it by that word when
it refuses, so it is numbered here too.

```
Plan ─► [1] Zod ─► [2] signature ─► [3] policies ─► [4] re-check ─► [5] Reviewer ─► Diff
          │             │                │               │              │
          └─────────────┴────────────────┴───────────────┴──────────────┘
                          structured report ─► Architect
                              (3 attempts maximum)
```

The four free gates run first, and that ordering is not tidiness: gates [1] to [4] cost
nothing, so a draft that cannot survive them never reaches the one gate that spends a
model call.

The re-check was last until it was measured. It sat there because it is the only gate
whose answer can go stale — but nothing goes stale inside one repair loop: the snapshot
and the bytes are read once, before the Inspector runs, and never re-read. What the old
order cost is in a recorded scenario: `link-already-declared` paid three Reviewer
round-trips for three approvals, each followed by a re-check refusal the free gate could
have delivered first. Moving it earlier costs a preview computed for a plan the Reviewer
might reject — bytes in memory against a paid call — and buys something besides: the
Reviewer now judges a plan that **would land**, rather than one that merely parses.

Past three attempts: clean stop, partial plan shown with the reason. No file is written.

**A Policy is a deterministic predicate over a signed Plan.** No model, no disk. That is
the whole definition, and it is what makes gate [3] free to run and testable without a
repository: gate [1] rejects what cannot be *expressed*, gate [2] asks about what nobody
can *vouch for* — and asks rather than refuses, because *declare, never infer* means
putting the question to the user, not guessing and not giving up — and a policy refuses
what is expressible, vouched for, and still wrong.

Four ship in v0.1:

| policy | refuses |
|---|---|
| `environment-mismatch` | an environment the user did not state, in the request or answering for it |
| `unwitnessed-folder` | a write into a folder the repository never declared |
| `cross-environment-consumer` | an access whose environment differs from its consumer's |
| `declared-level-mismatch` | a level the operation states that the repository does not declare |
| `consumer-on-an-object` | an `add-dependency-of` aimed at a thing, which carries no consumers |

**Every operation is gated, not only the creations.** `update-entity` joins a consumer to
an *existing* grant, so it is the operation that hands out an authorisation nobody
re-declares — and it is the one §4.1 is most about. It names its target by reference
rather than carrying an entity, so the first three policies read the environments off the
snapshot: the grant being extended has one, and so does the consumer being joined to it.
`unwitnessed-folder` alone does not apply, and the absence is a rule rather than a gap —
it is about a folder the *engine* computed a path into, and an update computes none.

`declared-level-mismatch` exists because the level of the grant being extended **is** the
authorisation being extended, and it cannot be seen: a level is a scalar, this tool only
ever appends (§4.3), and the unified diff of an update shows one added consumer line in an
otherwise unchanged file — `access:` sits further from the insertion than the three lines of
context a hunk carries, so it is an unchanged line, invisible to whoever merges. **Putting
the level in the operation does not put it in the hunk**; what it buys is that the level is
now a fact the engine holds, so the comparison is deterministic and the Reviewer is shown
it. It is one predicate over both shapes — `patch.access` on an update, `spec.access` on a
creation — where there were two, calibrated in opposite directions on a level-less
declaration: one hard-refused it, the other was deliberately silent. The comparison is the
plan against the repository and never against the request: what the *request* named is the
signature's question (§5.4), asked in any language, and reporting *nothing to change* about
a requested narrowing is the falsehood this refuses to tell.

`consumer-on-an-object` is the same §4.1 sentence read the other way: a right carries its
consumers and a thing does not, so an `add-dependency-of` aimed at a database has nothing
to add a consumer to. Nothing downstream asks — `planEdits` finds the file by reference and
appends the line to whatever is in it, so the update would write a consumer list onto the
database and the diff would show one plausible added line in a file that legitimately
exists. It was found by measurement rather than by reading: a model proposed exactly that,
and `declared-level-mismatch` refused it for the wrong reason, because `levels` held every
entity and a database's absent level looked like a right's unstated one. The two facts are
kept apart now, and each gate says its own thing.

A configurable rule engine — `governance/`, and the `get_governance_rule` tool this
document once gave the Architect in § 6 — is deferred past v0.1: five predicates that run
are worth more than an extension point that does not. The tool is absent from the
Architect's registry for the same reason, because a tool naming a feature nobody built is
a prompt for the model to ask about one.

An empty diff is not always success. `nothing to change.` on exit 0 says the repository
already grants what was asked, and it is true when the re-check says `already-declared` —
the plan restated a declaration and the bytes it would write are the ones on disk. When
every operation was *dropped* instead, the plan did nothing and nothing says the request
was already satisfied: that exits 3, with the reasons underneath as before. The two used to
share one sentence and one exit code, and a reason printed under a sentence that
contradicts it is not saying it.

Gate [4] is not a second set of rules. It applies the Plan **virtually** — builds the
snapshot that would exist if the plan landed — and runs the same seven `validate` rules CI
runs over the result. It exists because the catalogue lags the repository by about two
minutes (§4.4): what was true when the plan was drafted may not be true now, so an entity
may have appeared, or appeared somewhere else. (It was gate [5] until the reordering above,
and this paragraph said so for one commit longer than the diagram did.)

It refuses a plan for what **the plan** does to the repository, never for the repository as
it was. The rules run twice, over the snapshot and over the result, and a violation of the
result is the plan's when it is new — a duplicate that gains a file counts, because its
message changes — or when it sits in a file the plan changes (for the folder rule, in a
folder it writes into; for a duplicate, when one of its files is), since a merge request
carrying a file CI refuses has to say so whoever broke it. Everything else is *standing*:
counted in one line with the preview, listed by `validate`, and never part of a repair
report. Refusing on the whole list blocked every plan on a real repository over one fault
anywhere in it, and sent that fault to the Architect three paid times as something to fix.

**Gate [5] is told what it is judging.** The Reviewer is given the request in the user's
words, the operations, and three sets of facts the *engine* established: the owners
`deriveOwners` computed, what the repository already declares about every entity an
`update-entity` targets, and what each operation would do to the repository. None of it is
the Architect's reasoning — no transcript, no attempt number, no earlier gate's reason —
which is the independence rule and is unchanged.

The second and third exist because the first list was not enough to answer the question
this gate asks. An update names its target by *reference* and carries no entity, so the
operations JSON for one is `{op, entityRef, patch}`: no level, no environment, no owner, no
current holders — and an `add-dependency-of` hands over exactly those. And until the
reordering above, the preview did not exist yet when this gate ran, so it could approve a
plan whose only operation produces no bytes, which is the difference between a request
satisfied and a request silently ignored. They are read off the snapshot by the caller,
never off the plan: `agents/` reaches no disk, and a fact arriving through the model is the
Architect's claim wearing the engine's clothes.

### 6.2 Events

The harness renders nothing. It emits:

```ts
type AgentName = 'supervisor' | 'analyst' | 'inspector' | 'architect' | 'reviewer'

type AgentEvent =
  | { type: 'agent:start';   agent: AgentName }
  | { type: 'agent:end';     agent: AgentName; threw: boolean }
  | { type: 'classified';    classification: 'MUTATION' | 'QUESTION' }
  | { type: 'tool:call';     id: string; name: string; args: unknown }
  | { type: 'tool:result';   id: string; name: string; rows: number; truncated: number; error?: string }
  | { type: 'answer:ready';  outcome: Answer['outcome']; refs: string[] }
  | { type: 'refused';       agent: AgentName; reason: string }
  | { type: 'stopped';       agent: AgentName; reason: string }
  | { type: 'repair';        attempt: 1 | 2 | 3; gate: Gate; reason: string }
  | { type: 'attempt:start'; attempt: 1 | 2 | 3 }
  | { type: 'attempt:end';   attempt: 1 | 2 | 3; stopped?: string }
  | { type: 'gate:passed';   attempt: 1 | 2 | 3; gate: Gate }
  | { type: 'retry';         agent: AgentName; reason: string }
  | { type: 'plan:ready';    operations: number }
  | { type: 'derived';       path: string; owner: string; from: readonly string[] }
  | { type: 'overridden';    path: string; owner: string; determined: string; from: readonly string[] }
  | { type: 'reapplied';     path: string; value: string; entity: string; answeredAt: string; replaced?: string }
  | { type: 'ask';           question: Question }
```

Three details in that list were learned rather than designed.

`plan:ready` carries a **count, not the plan**. An event says that something happened; one
carrying the plan itself would be a second way for the plan to travel, next to the signed
object, and the whole signature exists to make sure there is exactly one.

`repair` and `retry` are two facts and used to be one. `repair` is an attempt of the loop
above, and its `gate` is mandatory: an attempt that cannot say which of the five refused it
is a number with no fact attached. `retry` is an agent handing its own malformed terminal
call back to the model, inside its own turn — it has failed no gate, and naming one there
would invent it. Sharing a field put two counters under one name, one restarting inside
every attempt of the other, and the rendered sequence went backwards within a run.

`stopped` and `refused` are two facts for the same reason. `refused` is an agent judging;
`stopped` says why an agent ended when its model call threw — a timeout, a provider failure
— and `agent:end` is what closes it. The error goes on to the caller, which prints it. So
`cli/index.ts` renders `stopped` without its reason: with it, the one line a failed call
ends on was printed twice, the first time as the agent refusing.

Ink consumes the stream at stage 7; tests consume the same stream and assert the sequence,
and `cli/index.ts` renders one line per event on **stderr** until then — stdout carries
the diff and the `--json` report, and both are piped. `ask` and `answer:ready` render
nothing there, deliberately: they *are* the command's output and they reach the user on
stdout, so a copy on stderr would state one fact twice. The harness is therefore testable
without a terminal, and the future MCP server reuses these events.

MLflow reads the same stream (ADR-0009). `src/trace/` folds it, with each model call, into
a trace — which is why an agent's end, an attempt's bounds and every gate that passed are
events too: a span is closed by what happened, never by whatever came next. None of them
renders on stderr; they are structure, and the lines they bound already say what happened.

---

## 7. User journeys

### 7.0 Configuration

`.idp-agent.yml` lives in the application repository and is committed, so a whole
team shares one configuration and a newcomer has nothing to set up:

```yaml
iacRepo: github.com/org/iac-repo
backstage: https://backstage.internal/api/catalog   # optional
environments: [dev, staging, prod]
```

It holds **no secret**. Model credentials come from the environment or
`~/.config/idp-agent/credentials.json`; the forge token from `GITHUB_TOKEN` or
`gh auth`. What is shared is versioned; what is personal never enters the repository.

The absence of `.idp-agent.yml` is what makes the CLI offer a guided tour rather
than fail.

**Read from stage 4, written at stage 5.** `cli/config.ts` reads it today, and the three
fields above are the whole schema — strict, so `enviroments:` is a named error rather than
a silent fallback to "this repository declared nothing". There is deliberately no field
that could carry a credential: a token in a committed file is a token in every clone of
it. Writing the file is § 7.3's last clause, and writing arrives at stage 5, so `init`
previews the `catalog-info.yml` and leaves this one to the stage allowed to create it.

What the read buys is `environments`, which seeds the vocabulary the deterministic gates
measure a proposal against. That vocabulary is otherwise empirical — what the catalogue
currently holds — and on a repository with no entities yet it is empty, which leaves
`environment-mismatch` structurally unable to fire and leaves the engine unable to
recognise an environment segment inside a composed name. The declaration fills that gap
before the first entity exists. It is merged with what the entities show, never
substituted for it: an environment in use that the file forgot is still in use.

Seeding is not vouching. An environment listed here is still echoed by the request or
still asked about — `prod` always exists, so enumerating it would let a model pick
production for a request that named no environment at all (§ 4.1). The seed widens what
the gates can *see*, never what a proposal may claim.

Absent and malformed are two different facts and the reader refuses to blur them. Absent
is a repository that never declared one, and the run proceeds on what the entities show.
Present and unparseable is refused, naming the field, because falling back there would
answer a typo with a run that silently asks about everything.

**The personal file.** Beside the shared file there is one person's, on one machine, and
it never enters a repository: `$XDG_CONFIG_HOME/idp-agent/config.yml`, else
`~/.config/idp-agent/config.yml` — on Windows, with no XDG_CONFIG_HOME, under
`%APPDATA%\idp-agent\`. `.idp-agent.yml` says what a team agreed about an application;
this file says where *this* user keeps the SI they question.

```yaml
repo: ~/work/IaC        # the local declarations repository
```

That is the whole schema today, and `cli/personal.ts` reads it by the same rules: strict,
so `repos:` is refused by name; absent is nothing configured; present and unparseable is
exit 2, naming the file. `~` is expanded — a bare `~` is YAML's null, so the home
directory itself is written `"~"` — and a relative path is resolved against the file's own
directory, so it names the same repository wherever the command is run. `IDP_REPO` in the
environment overrides it, and must be absolute or start with `~`: relative to the working
directory it would name another repository in each, and `IDP_REPO=.` would make the service
`plan` declares its own declarations repository, so it is refused.

The two files answer different questions and neither reads the other. `iacRepo` and
`backstage` in `.idp-agent.yml` are what a team agreed for one application: which remote
its declarations live in, which catalogue it is registered with. `repo` in the personal
file — and, later, a Backstage URL beside it — is where this person reads the SI from: a
local checkout on this machine. The read commands and `plan`'s declarations repository
consult only the personal side; `iacRepo` is a URL, nothing here clones it, and it is not
a fall-back for `repo`.

The project has two uses: `init platform` creates the declarations repository once, and
then `idpa "<phrase>"` (§ 7.4) — and `graph`, `show`, `ask` and `plan` — question it or
change it from anywhere, not only from inside it. Every one of them reads, first match
wins: `--repo` (or `--demo`, for a read); the working directory when it is a declarations
repository; `IDP_REPO`; the file's `repo`. With none, a read takes the fictional demo SI
and a change is refused, naming all four: a write preview is decided against a
repository, never a demo (§ 4.4). `plan` used to skip the working directory, as the
service it declares; it is taken on its markers only, which a service's repository does
not carry, so `cd IaC && idpa "<intent>"` decides against IaC. Every road but `--repo` is
said on stderr in one line naming the folder and what named it. A configured path that is
not a directory is exit 2, never a quiet fall back to the demo SI: the user asked for that
repository.

This is also the slot the `backstage-http` provider (§ 3) plugs into: one decision,
`cli/source.ts`'s `sourceOf`, returns `{ kind: 'repo' | 'demo', … }`, and a Backstage
source is one more kind and one more field here. Its token will come from an environment
variable, never from this file: `config.yml` holds no credential, whatever other files —
the `credentials.json` above — come to sit beside it in the same directory, and there is
deliberately no field in it that could carry one.

### 7.1 First contact — no configuration

```
$ npx idp-agent

  idp-agent  v0.1.0
  No configuration found in this directory.

  ? What do you want to do?
  > Take the guided tour     (fictional SI, no setup, no API key)
    Set up a new platform    (creates an IaC repository)
    Connect this app         (needs an existing IaC repository)
```

The guided tour replays recordings: no API key, no Docker, no network. This is the
sixty seconds that decide whether the project is examined or closed.

### 7.2 `idp-agent init platform` — once per organisation

Run by whoever sets up the platform. Creates the IaC repository and materialises the
governance model:

```
iac-repo/
├── catalog/…                         one folder per object type, from the registry
├── dependencies/…                    one folder per right type, from the registry
│   └── each with a .witness.yml      a pattern with no match must fail, not return empty
├── schemas/                          JSON Schemas exported from Zod
├── .github/workflows/validate.yml    calls `idp-agent validate`, which refuses what the
│                                     catalogue would accept
├── CODEOWNERS
└── README.md                         the doctrine, written down
```

The folder list is derived from the resource-type registry, never written out here: adding
a type adds its folder, and a list in this document would drift from the code the first
time one is added. It has already drifted once.

**What the tool cannot do, and says so.** Branch protection is set in the forge
interface. The tool prints the exact settings required. **From stage 6** it also
**verifies** them — including a live check that the supplied token can open a request but
cannot merge one — and refuses to report success until that check passes. Before stage 6
it prints the settings and states plainly that it cannot verify them, which is the same
admission made one stage earlier.

An automaton that verifies its own powerlessness, out loud, is the clearest
statement the product makes.

### 7.3 `idp-agent init` — once per application (stage 4)

Inspects the repository (manifest, git remote, CODEOWNERS), proposes a
`catalog-info.yml` through the same `propose()` path as any other entity, confirms
the owner it inferred rather than assuming it, and writes `.idp-agent.yml`.

Three of those four need the Inspector and `propose()`. The command existed from stage 3
as a tested refusal naming what it waited for; stage 4 answers that refusal, and the shape
of the answer is what stops the model choosing where the file goes. The Architect's
`propose` tool is built from the operation union **minus** `create-catalog-info`,
because that operation carries `repoPath` and a path field in front of a model is a path a
model chooses — so there is no field to write one into. What it proposes is a Component;
anything else is refused by name rather than dropped, and the engine mints the real
`create-catalog-info` out of the **signed** proposal afterwards. That order is load-bearing:
minting first puts a path in front of a gate that classifies a value by where it came
from, and the engine's own choice comes out as "nobody vouches for this" — a question the
CLI would put to the user about a path chosen by the code asking.

The fourth clause waits for stage 5. The `catalog-info.yml` is previewed as a diff and
nothing is written, `.idp-agent.yml` included — and "confirms the owner it inferred rather
than assuming it" is a human reading that diff. The signature says a proposed value
matches what the inspection established; the Inspector is a model reading files, so it
says nothing about whether the inspection was right.

### 7.4 `idp-agent "<intent>"` — the daily gesture

```
1. load the SI          Backstage to explore · git repo to decide
2. Supervisor           MUTATION or QUESTION?
3. Inspector            reads the local repository            [read-only]
4. Architect            does the resource exist?              [read + propose]
       yes -> access declarations only
       no  -> resource declaration + access declarations
5. validation           Zod · signature · policies · Reviewer [3 attempts max]
6. re-check             against the repository (catalogue lag)
7. diff + confirmation  "I am submitting my request"
8. branch + MR          an architect reviews -> merge = AUTHORISATION
```

**Steps 2 to 7 are built — step 1 from a git repository, Backstage not yet, and step 7 is
the diff alone. Step 8 arrives with the forge, at stages 5 and 6.** `idpa "<phrase>"` is
the gesture, typed from any directory: step 1 finds the declarations repository as § 7.0
says, step 2 classifies the phrase once, and a `QUESTION` goes to the Analyst exactly as
`ask` would take it (§ 7.6) while a `MUTATION` runs steps 3 to 7 exactly as
`plan "<intent>"` would. `ask` and `plan` remain, as the commands that force a road:
`plan` previews without step 2, and `ask` runs step 2 but only answers — a change is
declined, naming the gesture that previews it. A single word a slip away from a command
name (`idpa grpah`), or a command typed after its options, is refused before step 2 and
never classified.

**Step 3 is optional.** The Inspector reads the application repository `--project` names,
or the one the user is standing in when it is one — a `catalog-info.yaml` or a package
manifest at its root, looked for there and never by walking, and never a declarations
repository. Anywhere else — the declarations repository or any folder of it, `$HOME`, the
filesystem root — the Inspector is skipped and the run says so in one line, and the
Architect is told that no application repository was inspected rather than handed facts
nobody established: it drafts from the request and the catalogue, and what neither states
is `{ unknown }`, asked. A `--project` that names a declarations repository, or the one
the change is decided against, is still refused before any model is chosen.

`idp-agent plan "<intent>"` runs the Inspector when there is a service to read, the
Architect over the declarations repository, the five gates of § 6.1, and renders the
diff — then stops. There is no confirmation prompt at step 7 yet, because
there is nothing on the other side of it to confirm: the branch is stage 5 and the merge
request is stage 6. Until they exist, "diff + confirmation" is a diff and the closing line
below, and the honest reading of "writes nothing" is that no code between the diff and a
write has been written.

The two `--repo` flags on this page name two different repositories, and the difference is
the whole reason the flag exists. `plan --repo` is the **declarations** repository, which
the preview is decided against (§ 4.4), and standing in it, `IDP_REPO` or the personal
file (§ 7.0) can name it instead. `init --repo` is the **application** repository, the one
being declared.

Every run ends on the same line, so no one mistakes submission for permission:

> Nothing is provisioned yet. The merge is what authorises it.

### 7.5 Variants

| Case | Behaviour |
|---|---|
| Resource missing | the Architect branches: resource declaration **and** access |
| Ambiguous name | interactive picker listing each match with its environment — never a default |
| Already declared | the plan RESTATES the declaration, the edit produces bytes identical to the ones on disk, and the re-check reports `already-declared`, exit 0 |
| No convergence | stops at 3 attempts, states what could not be determined, suggests the flag or field that would resolve it, writes nothing |

An empty plan used to be how both of those rows were written, and it is not a
channel any more: `proposeTool` and `planSchema` both require at least one
operation. The reason is that an empty plan is indistinguishable from a model
giving up. It passes every gate vacuously, produces no edits, and came out of
the CLI as `nothing to change.` on exit 0 — a person asked for an authorisation
and was told their repository already grants it. Idempotence is now demonstrated
rather than asserted: the plan says what it would declare, the preview shows the
bytes are the ones already on disk, and `already-declared` names the file. An
Architect with genuinely nothing to propose ends its draft without calling
`propose`, which the CLI reports as a refusal rather than as success.

### 7.6 Question mode

Direct graph query, tabular output. No plan, no writes, no confirmation.

## 8. Failure behaviour

| Situation | Behaviour |
|---|---|
| Information missing from the SI | `{ unknown }` in the plan → the CLI asks |
| Ambiguity (dev or prod?) | interactive picker, never a silent default |
| Access already declared | plan restating it, no bytes changed, message, exit 0 (idempotent) |
| Loop does not converge | stop at 3, partial plan + reason, nothing written |
| Write interrupted | full rollback, initial state restored |
| Orphaned access detected | reported only, never deleted |
| Repository moved meanwhile | caught at step 6, plan recomputed |

---

## 9. Test strategy

### 9.1 Pure tests — `core/`
Schemas, serialiser, path computation, diff. No I/O. Around 60 % of the suite.

### 9.2 Invariants — `fast-check`

```
∀ valid Plan      → every produced path is inside the IaC repository
∀ Plan            → application is atomic (failure ⇒ initial state intact)
∀ entity          → serialise then reload yields the same entity
∀ file + entity   → insert then remove yields the file BYTE FOR BYTE
∀ Plan            → applying twice == applying once
∀ Plan + file     → the edit, read back, carries out the operation and nothing else —
                    or the operation is dropped, naming the file
```

The fourth is "textual surgery, never a reparse" made executable: replacing insertion
with `parse + stringify` breaks it. The fifth encodes "absent means already done". The
sixth is **effectiveness**, and it is what makes the fourth safe: surgery locates a
document by reading lines, which is a heuristic. The misses it knows of it refuses; one it
does not know of amends the wrong document, opens a key twice, or leaves the file as it
was — byte-identical to "already done". So every edit is read back with the parser before
it is offered, and an unchanged file means the parser found the work already done.

### 9.3 Recordings — end to end, no API key

```
tests/recordings/link-db-exists.json
tests/recordings/link-db-missing.json
tests/recordings/link-ambiguous-env.json
tests/recordings/link-already-declared.json
tests/recordings/repair-malformed-owner.json
```

```bash
IDP_RECORDING=record pnpm test   # once, with a key
pnpm test                       # CI and contributors: free, offline
```

Indexed on `(scenario, agent, turn number)` — **never** on a hash of the full prompt,
which would invalidate every recording on a single changed comma. A prompt that changed
since recording produces a warning, not an error.

### 9.4 Tests that must fail

```ts
test('the token that opens a merge request cannot merge it')
test('no module under agents/ imports fs, git or child_process')
test('a Plan carrying a path outside the repository is rejected')
test('a Plan carrying an unknown field cannot be applied')
```

---

## 10. Repository layout

```
idp-agent/
├─ src/
│  ├─ core/            no AI, no network
│  │  ├─ schemas/        Backstage entities, Plan, Operation (Zod)
│  │  ├─ plan/           construction · validation · atomic application
│  │  ├─ yaml/           deterministic serialiser + textual surgery
│  │  ├─ diff/           unified rendering
│  │  ├─ paths/          entity path computation — never the AI
│  │  └─ git/            branch, commit
│  ├─ context/
│  │  ├─ provider.ts     ContextProvider interface
│  │  ├─ fixtures/       embedded fictional SI (default)
│  │  ├─ backstage/      HTTP client — to EXPLORE
│  │  ├─ iac-fs/         repository reads — to DECIDE ON WRITES
│  │  └─ graph/          in-memory index + dependency queries
│  ├─ forge/
│  │  ├─ provider.ts     ForgeProvider interface
│  │  ├─ local/          local branch + MR preview (no token)
│  │  └─ github/         GitHub API
│  ├─ llm/
│  │  ├─ client.ts       the single crossing point — types only
│  │  ├─ recording.ts    record / replay
│  │  ├─ runtime.ts      the only file importing the model SDK
│  │  └─ providers.ts    anthropic · mistral · openai
│  ├─ agents/          cannot import fs, git, child_process
│  │  ├─ supervisor.ts · analyst.ts · inspector.ts · architect.ts · reviewer.ts
│  │  ├─ tools/          registry: read-only + propose
│  │  ├─ repair.ts       loop, 3 attempts max
│  │  └─ events.ts
│  ├─ governance/      cyber · archi · infra rules (MCP server in v0.2)
│  ├─ tui/             Ink — consumes events
│  └─ cli/             index · init · link
├─ fixtures/si-demo/   ~30 realistic entities
├─ templates/iac-repo/ scaffolds laid down by `init`
└─ tests/              unit · invariants · recordings · architecture
```

---

## 11. Build order

Order imposed by the doctrine: read-only first, validation before the first write,
preview before the merge request.

| # | Stage | Demonstrable output | Time |
|---|---|---|---|
| 0 | Foundations | schemas, serialiser, paths, invariants green | 1 wk |
| 1 | Read-only | `graph`, `show <entity>` over fixtures | 1 wk |
| 2 | Question mode | Supervisor + answers; **recordings in place** | 1 wk |
| 3 | `init` | scaffold + CI + CODEOWNERS + witnesses | 1 wk |
| 4 | Preview only | Inspector + Architect + Plan + diff — writes nothing | 1.5 wk |
| 5 | Write + local branch | local `ForgeProvider`, atomicity, idempotence | 1 wk |
| 6 | GitHub MR | real forge + negative token test | 1 wk |
| 7 | Polish | Ink TUI, README, asciinema, npm publish | 1.5 wk |

**≈ 9 weeks** part-time. Writing arrives only at stage 5, by which point validation has
been refusing correctly for three stages.

---

## 12. Open-source ergonomics

Three audiences, not one. The user runs the tool; a **contributor** wants to change it;
and a **reviewing agent** — an employer clones the repository and points their coding
agent at it — wants to judge it in two minutes.

### 12.1 The repository must explain itself to an agent

| File | Role |
|---|---|
| `AGENTS.md` | architecture in 60 lines, invariants, commands. The first file any agent reads. |
| `src/core/README.md`, `src/agents/README.md` | why this boundary exists, at folder level |
| `docs/adr/000X-*.md` | one decision per file, ~20 lines, dated |

Architecture Decision Records pay the most here. An agent reading *"ADR-0001:
deterministic orchestration over model-driven — rejected alternative: let the Supervisor
pick its own workers — reason: untestable, loops one time in ten"* infers the author's
level immediately.

Initial set:

```
ADR-0001  deterministic orchestration over model-driven
ADR-0002  no write tools for agents; the Plan as trust boundary
ADR-0003  provider interfaces for context and forge
ADR-0004  recordings as the default suite, live evals as nightly
ADR-0005  structured entities, never model-authored YAML
ADR-0006  the merge request is the act of authorisation
ADR-0007  the answer crosses the boundary, under a witness check
ADR-0008  commentary crosses the boundary, labelled and witness-checked
ADR-0009  a trace is one more reader of the event stream
```

### 12.2 The whole suite runs without an API key

Stated at the top of the README, not buried:

```bash
git clone … && pnpm i && pnpm test     # 40 scenarios, no API key, no cost
```

An agent that clones, runs the tests and sees them pass in twenty seconds writes a
favourable report. An agent that hits `ANTHROPIC_API_KEY is required` stops and reports
that it could not verify anything. This is the highest-return detail in the project.

### 12.3 Answer the security question before it is asked

`SECURITY.md` states the threat model plainly:

```
GUARANTEED
  · agents hold no write access (enforced by architecture test)
  · no path outside the IaC repository is reachable (property-based invariant)
  · the supplied token cannot merge a request (negative test)
  · no secret reaches the model (.env, .git/, key files excluded by Inspector)

NOT GUARANTEED
  · content proposed by the model may be wrong — review decides
  · a prompt injection carried in a repository file can steer a proposal, but
    cannot widen permissions: the action surface is fixed at build time
```

The last line matters most: it shows prompt injection was considered **and** that the
architecture neutralises it by construction rather than by filtering.

### 12.4 Contribution

`CONTRIBUTING.md` with a three-command setup, a visible CI badge, and Conventional
Commits. Architecture tests do the review work: a contributor importing `fs` under
`agents/` gets a red build with an explicit message, with no need for a human to
explain the rule.

### 12.5 Licence and language

Apache-2.0 — the licence of Backstage, Kubernetes and Terraform; its explicit patent
grant is what lets a company's legal team adopt the project without friction.
English throughout: code, comments, commits, docs, CLI output.

---

## 13. Out of scope for v0.1

Deliberately excluded; do not reintroduce without an explicit decision.

- GitLab (v0.2 — the interface is in place, it is one file to write)
- The `backstage-http` provider (MVP). v0.1 ships `fixtures` and `iac-fs`.
  `iac-fs` cannot be deferred with it: the catalogue lags the repository by about
  two minutes, so deciding to write against Backstage would propose creating what
  already exists. The git repository stays the source of truth at write time, in
  the POC as much as in production.
- MCP server exposed by `idp-agent` (v0.2)
- Extraction into a publishable monorepo (v0.2, once usage has revealed the interfaces)
- Real Kong / Tufin / Jira integrations — they remain described destinations, not code
- Delete operations
- Live evals with a published score (v0.2, nightly)
- Context compaction and long sessions
- Docker Compose Backstage — a bonus, never a prerequisite
