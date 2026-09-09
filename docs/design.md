# idp-agent — Design Specification

**Date** 2026-09-09 · **Status** approved, ready for implementation planning · **Target** v0.1

---

## 1. Purpose

A CLI framework that turns a natural-language intent into versioned infrastructure
declarations that are reviewed, then merged.

It builds on a declarative reconciliation system designed and shipped to production
at Orange (CI/CD trigger on `catalog-info.yml`, central IaC repository, provisioning
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
| LLM layer | Vercel AI SDK, low-level mode — multi-provider, loop written by hand |
| Reliability proof | Record/replay cassettes + property-based invariants + negative tests |
| Terminal | Ink; the harness emits events, the TUI draws them |
| Forge | `ForgeProvider` interface — `local` and `github` in v0.1, GitLab in v0.2 |
| v0.1 scope | `init` and `link`, both ending in a merge request |
| Structure | Single package, folders aligned with future packages |
| v0.2 | Extract `core/` and `context/` as publishable packages + GitLab |
| Name | `idp-agent` on npm, short command alias `idpa` |
| Commands | `init platform` · `init` · bare intent |
| Configuration | `.idp-agent.yml` committed per app; credentials never in the repo |
| Language | English throughout — code, docs, commits, CLI output |
| Licence | Apache-2.0 |

---

## 4. Doctrine — non-negotiable invariants

Drawn from a production system. Each has a known cost when violated, and none
follows from the documentation of the tools involved.

### 4.1 Model

- **A resource is an object; an access is a right over that resource.** The access —
  not the resource — carries the list of its consumers.
- **The environment is part of an access's identity.** Being authorised in dev grants
  nothing in staging: two distinct entities.
- **Declare, never infer.** What the catalogue does not know is reported as unknown,
  never filled in with a plausible value.
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

One object crosses the boundary between the AI side and the deterministic side: the
**`Plan`**.

```
┌───────────────────── AI ZONE (untrusted) ─────────────────────────┐
│  Supervisor ──► Inspector ──► Architect ──► Reviewer              │
│                    │             │             │                  │
│                READ tools    READ tools     reason                │
│                              + propose()                          │
└────────────────────────────────┬──────────────────────────────────┘
                                 │
                        ═══ Plan (JSON) ═══   ◄── the only crossing
                                 │
┌────────────────────────────────┼──────── DETERMINISTIC ZONE ──────┐
│  Zod ──► Policies ──► Reviewer ──► repo re-check ──► Diff         │
│    │                                                    │         │
│    └── failure ──► report ──► back to Architect (3 max) │         │
│                                                          ▼        │
│                              [ CONFIRMATION ] ──► branch + MR     │
└───────────────────────────────────────────────────────────────────┘
```

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

A closed discriminated union. What is not modelled cannot be requested.

```ts
type Operation =
  | { op: 'create-entity';       kind: EntityKind; entity: EntityInput }
  | { op: 'update-entity';       entityRef: string; patch: EntityPatch }
  | { op: 'create-catalog-info'; repoPath: string; entity: ComponentInput }
```

No delete operation in v0.1 (see § 4.4).

### 5.4 Unknown fields

Every `Plan` field is either a value or `{ unknown: string }`. A `Plan` holding an
`unknown` **cannot be applied**: the CLI stops and asks the user. This is
"declare, never infer" made executable.

### 5.5 Dependency rules, enforced in CI

1. `core/` never imports `agents/` or `llm/`.
2. `agents/` never imports `fs`, `child_process`, or a git client.

---

## 6. Agents

Orchestration is **deterministic**. The Supervisor classifies intent; plain TypeScript
sequences the steps. No agent decides the sequence.

| Agent | Input | Tools | Output |
|---|---|---|---|
| Supervisor | the request + a numeric SI summary | none | `MUTATION` or `QUESTION` |
| Inspector | the local repository | `list_files`, `read_file`, `read_manifest` | `ProjectFacts` |
| Architect | `ProjectFacts` + SI + rules | `search_entities`, `get_entity`, `get_dependencies`, `get_governance_rule`, `propose` | `Plan` |
| Reviewer | the `Plan` + the original request | SI reads | `OK` or a rejection reason |

`Inspector` is confined to the current repository: any escaping path is refused, and
`.env`, `.git/` and key files are excluded; size is capped.

**Why a Reviewer LLM on top of Zod** — Zod validates *shape* (`owner: tiger` instead of
`group:default/tiger`); the Reviewer validates *substance* (the request was about dev,
the plan opens prod access). Perfectly valid YAML can answer the wrong question.

### 6.1 Repair loop

```
Plan ─► [1] Zod ─► [2] Policies ─► [3] Reviewer ─► [4] repo re-check ─► Diff
          │            │               │                │
          └────────────┴───────────────┴────────────────┘
                     structured report ─► Architect
                         (3 attempts maximum)
```

Past three attempts: clean stop, partial plan shown with the reason. No file is written.

### 6.2 Events

The harness renders nothing. It emits:

```ts
type AgentEvent =
  | { type: 'agent:start'; agent: 'inspector' | 'architect' | 'reviewer' }
  | { type: 'tool:call';   name: string; args: unknown }
  | { type: 'repair';      attempt: 1 | 2 | 3; reason: string }
  | { type: 'plan:ready';  plan: Plan }
  | { type: 'ask';         question: Question }
```

Ink consumes the stream; tests consume the same stream and assert the sequence. The
harness is therefore testable without a terminal, and the future MCP server reuses
these events.

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

The guided tour replays cassettes: no API key, no Docker, no network. This is the
sixty seconds that decide whether the project is examined or closed.

### 7.2 `idp-agent init platform` — once per organisation

Run by whoever sets up the platform. Creates the IaC repository and materialises the
governance model:

```
iac-repo/
├── catalog/{databases,apis,caches}/.witness.yml
├── dependencies/{access,network}/.witness.yml
├── schemas/                          JSON Schemas exported from Zod
├── .github/workflows/validate.yml    refuses what the catalogue would accept
├── CODEOWNERS
└── README.md                         the doctrine, written down
```

**What the tool cannot do, and says so.** Branch protection is set in the forge
interface. The tool prints the exact settings required, then **verifies** them —
including a live check that the supplied token can open a request but cannot merge
one. It refuses to report success until that check passes.

An automaton that verifies its own powerlessness, out loud, is the clearest
statement the product makes.

### 7.3 `idp-agent init` — once per application

Inspects the repository (manifest, git remote, CODEOWNERS), proposes a
`catalog-info.yml` through the same `propose()` path as any other entity, confirms
the owner it inferred rather than assuming it, and writes `.idp-agent.yml`.

### 7.4 `idp-agent "<intent>"` — the daily gesture

```
1. load the SI          Backstage to explore · git repo to decide
2. Supervisor           MUTATION or QUESTION?
3. Inspector            reads the local repository        [read-only]
4. Architect            does the resource exist?          [read + propose]
       yes -> access declarations only
       no  -> resource declaration + access declarations
5. validation           Zod · policies · Reviewer         [3 attempts max]
6. re-check             against the repository (catalogue lag)
7. diff + confirmation  "I am submitting my request"
8. branch + MR          an architect reviews -> merge = AUTHORISATION
```

Every run ends on the same line, so no one mistakes submission for permission:

> Nothing is provisioned yet. The merge is what authorises it.

### 7.5 Variants

| Case | Behaviour |
|---|---|
| Resource missing | the Architect branches: resource declaration **and** access |
| Ambiguous name | interactive picker listing each match with its environment — never a default |
| Already declared | empty plan, points at the existing file and its merge date, exit 0 |
| No convergence | stops at 3 attempts, states what could not be determined, suggests the flag or field that would resolve it, writes nothing |

### 7.6 Question mode

Direct graph query, tabular output. No plan, no writes, no confirmation.

## 8. Failure behaviour

| Situation | Behaviour |
|---|---|
| Information missing from the SI | `{ unknown }` in the plan → the CLI asks |
| Ambiguity (dev or prod?) | interactive picker, never a silent default |
| Access already declared | empty plan, message, exit 0 (idempotent) |
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
```

The fourth is "textual surgery, never a reparse" made executable: replacing insertion
with `parse + stringify` breaks it. The fifth encodes "absent means already done".

### 9.3 Cassettes — end to end, no API key

```
tests/cassettes/link-db-exists.json
tests/cassettes/link-db-missing.json
tests/cassettes/link-ambiguous-env.json
tests/cassettes/link-already-declared.json
tests/cassettes/repair-malformed-owner.json
```

```bash
IDP_CASSETTE=record pnpm test   # once, with a key
pnpm test                       # CI and contributors: free, offline
```

Indexed on `(scenario, agent, turn number)` — **never** on a hash of the full prompt,
which would invalidate every cassette on a single changed comma. A prompt that changed
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
│  │  ├─ client.ts       the single crossing point
│  │  ├─ cassette.ts     record / replay
│  │  └─ providers.ts    anthropic · mistral · openai
│  ├─ agents/          cannot import fs, git, child_process
│  │  ├─ supervisor.ts · inspector.ts · architect.ts · reviewer.ts
│  │  ├─ tools/          registry: read-only + propose
│  │  ├─ repair.ts       loop, 3 attempts max
│  │  └─ events.ts
│  ├─ governance/      cyber · archi · infra rules (MCP server in v0.2)
│  ├─ tui/             Ink — consumes events
│  └─ cli/             index · init · link
├─ fixtures/si-demo/   ~30 realistic entities
├─ templates/iac-repo/ scaffolds laid down by `init`
└─ tests/              unit · invariants · cassettes · architecture
```

---

## 11. Build order

Order imposed by the doctrine: read-only first, validation before the first write,
preview before the merge request.

| # | Stage | Demonstrable output | Time |
|---|---|---|---|
| 0 | Foundations | schemas, serialiser, paths, invariants green | 1 wk |
| 1 | Read-only | `graph`, `show <entity>` over fixtures | 1 wk |
| 2 | Question mode | Supervisor + answers; **cassettes in place** | 1 wk |
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

Architecture Decision Records pay the most here. An agent reading *"ADR-001:
deterministic orchestration over model-driven — rejected alternative: let the Supervisor
pick its own workers — reason: untestable, loops one time in ten"* infers the author's
level immediately.

Initial set:

```
ADR-001  deterministic orchestration over model-driven
ADR-002  no write tools for agents; the Plan as trust boundary
ADR-003  provider interfaces for context and forge
ADR-004  cassettes as the default suite, live evals as nightly
ADR-005  structured entities, never model-authored YAML
ADR-006  the merge request is the act of authorisation
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
- MCP server exposed by `idp-agent` (v0.2)
- Extraction into a publishable monorepo (v0.2, once usage has revealed the interfaces)
- Real Kong / Tufin / Jira integrations — they remain described destinations, not code
- Delete operations
- Live evals with a published score (v0.2, nightly)
- Context compaction and long sessions
- Docker Compose Backstage — a bonus, never a prerequisite
