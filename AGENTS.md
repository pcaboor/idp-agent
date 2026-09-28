# AGENTS.md

The first file to read. Architecture, invariants, commands. The full specification is
`docs/design.md`; per-stage implementation plans live in `docs/plans/`.

## What this is

A CLI that turns a natural-language intent into versioned infrastructure declarations
that are reviewed, then merged.

The primary subject is **how to build a reliable multi-agent system**: deterministic
orchestration, structural guardrails, a closed repair loop, and tests that reproduce
without an API key. Platform GitOps is the application domain, not the subject.

**Tie-breaker** — when two options compete, prefer the one that makes the harness more
verifiable over the one that adds an integration.

## Commands

```bash
pnpm install          # Node >= 22, pnpm 10
pnpm test             # 3535 tests. No API key, no network, no Docker. Ever.
pnpm typecheck        # vitest does not typecheck; this is not redundant
pnpm build
pnpm smoke            # packs the tarball and runs its dist/cli/bin.js, which the suite
                      # never does, pnpm demo and every example in examples/README.md's table,
                      # and pnpm demo:backstage where Node strips types (22.18 or later)
```

CI runs exactly those five, on Node 22 and 24. A suite that demands a key is a
regression, not a configuration problem.

Tracing is optional, needs Docker, and is never part of CI (ADR-0009,
`docs/tracing-design.md`):

```bash
pnpm mlflow:up                                   # MLflow 3.16.1 on 127.0.0.1:5055
IDP_MLFLOW_TRACKING_URI=http://127.0.0.1:5055 idp-agent plan "<intent>" --repo <dir>
IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios && IDP_MLFLOW_TRACKING_URI=http://127.0.0.1:5055 pnpm trace:push .traces   # the tapes, no key
pnpm mlflow:contract                             # after moving the image tag
pnpm mlflow:down
```

`IDP_MLFLOW_EXPERIMENT_ID` defaults to `0`. MLflow's own `MLFLOW_TRACKING_URI` is ignored:
it is set for other tools, and tracing is on only when this tool's variable says so. The
suite removes both `IDP_MLFLOW_*` from its environment (`tests/setup/personal.ts`) and
leaves `IDP_TRACE_DIR`, which is how the tapes are traced. A trace carries full prompts;
`SECURITY.md` says where they go.

**Every number on this page is a measurement, and this page has drifted from all of them
before** — a test count one short, an architecture-rule count several short, one module
named as the only importer of the model SDK when there were two. A figure nobody re-ran is
worse than no figure, because it is read as evidence. Re-run the command and correct the
number in the same commit as the change.

**Exit codes:** `0` succeeded — a diff rendered, or a run with nothing to change because
the repository already declares everything each operation states, the file and fields named
· `1` the answer is negative — nothing matched, a name was ambiguous (two entities sharing it
included), a relation holds nothing, two entities are linked by no declared path and reach
nothing in common (a near miss alone does not count), an entity was asked about its paths
to itself, **the repository does not conform**, a gate refused a
plan, the repair loop stopped at three attempts, a Backstage catalogue could not be read
whole (unreachable, refused, a 3xx, past a bound — never a fall back), or something failed
unexpectedly · `2`
the arguments were refused — a bad flag, a plan file that is not a plan, a `--repo`, a
`--project`, a configured repository or the directory `validate` or `init` is handed that is
not a directory, a `--project` that is a declarations repository or the one the change is
decided against, a change with no declarations repository to decide against, a single word
one slip away from a command name (`idpa grpah`, `idpa relation`), a command typed after its
options, two relation flags or one beside `--to`, a `--depth` that is not a whole number
from 1 to 100, a `.idp-agent.yml` or a personal `config.yml` that does not parse, a
catalogue URL refused before any request, `IDP_BACKSTAGE_TOKEN` unset for a catalogue that
is not on this machine or holding a character a header cannot carry, `--backstage` with none
configured — or no
model, no key or no usable `IDP_TIMEOUT` or `IDP_SUPERVISOR_MODEL` is configured · `3` the
request was understood and this build will not act on it: a change request put to `ask`
(which names `idpa "<phrase>"` as the gesture that previews it), a question the model
refused, a plan holding values nobody can vouch for, **asked rather than guessed**, or a
plan that produces no bytes while the repository does not already declare what it states —
in prose and in `--json` alike · `130` Ctrl-C at a question: the person stopped the run,
which is not a declined question (Ctrl-D is one). A command returns
`{ text, found, unsupported? }`; only `cli/index.ts` turns that into a code.

The one that is not obvious is a **stop**: three attempts, still refused, exit `1`. Not
`3`, because `3` is a boundary the user cannot move by typing anything, and a stop is the
opposite — the build acted three times, a gate refused, and a clearer intent can change
the outcome. Not `0`, because a script must not read a stop as a plan. That leaves the
negative answer, which is the same code `plan --from` returns when one of those gates
refuses a plan once.

A `validate` warning does not fail the build: a dangling reference is reported and exits 0,
because a red build there pushes people to delete the declaration, which is what §4.4
forbids. A document of a kind this tool does not model is also a warning, and exits 0: a
declarations repository that is also the company's catalogue holds Groups and Systems, and
they are not ours to refuse. Backstage's APIs are read, not set aside: an API missing what
Backstage requires of one is an `invalid-entity` error, as a broken Component is, and a
`providesApis` naming nothing is a dangling reference. The `kind: Location` of the root
`catalog-info.yaml` is not set aside either: it is the repository's **Backstage
registration**, which `init platform` writes with the path registry's folders as targets
(`core/validate/registration.ts`, `docs/adopting-backstage.md`). `validate` counts it in
silence, fails on what Backstage would refuse or what reads outside the repository
(`registration`, an error), and warns when no target reaches one of the registry's folders.

## Current state — 2026-09-28

`main` carries stages 0 through 4; history is linear, no merge commits. Each stage lands
as a stack of branches, one per task of its plan in `docs/plans/`, rebased and merged
bottom-up. Stage 5 is in progress and none of it is on `main`.

| # | Stage | State |
|---|---|---|
| 0 | Foundations — schemas, serialiser, paths, invariants | done |
| 1 | Read-only — `graph`, `show <entity>` over fixtures | done |
| 2 | Question mode — Supervisor, recordings | done |
| 3 | `init platform` — scaffold, CI, CODEOWNERS, witnesses, `validate` | done |
| 4 | Preview only — Inspector, Architect, `Plan`, diff; writes nothing | done |
| 5 | Write + local branch — `ForgeProvider`, atomicity, idempotence | in progress |
| 6 | GitHub merge request — real forge, negative token test | |
| 7 | Polish — Ink TUI, README, asciinema, npm publish | |

The order is imposed by the doctrine: read first, validate before the first write,
preview before the merge request. Writing arrives only at stage 5.

Shipped and working: `idpa "<phrase>"`, the one gesture of §7.4, from any directory — the
Supervisor classifies the phrase once, a question takes `ask`'s road and a change `plan
"<intent>"`'s (`cli/commands/entry.ts`); `graph` and `show` over a fixture SI of 33
entities; `relations`, which traces an entity's relations from the declarations —
multi-hop, both directions, each row with its whole path, the rights on it and their
levels, the environment at each step, and a reference declared nowhere marked where the
path ends; between two entities, the paths where one depends on the other, else the
nearest entities both reach — with no model (`context/graph/relations.ts`, rendered by
`cli/render/relations.ts`); `ask`, answered by the Supervisor and the Analyst against
recordings with no API key, a relation question included: the model chooses the entity and
the relation, and the engine writes `relations`' block; `validate`, nine rules over an
IaC repository; `init platform`, which writes thirteen files — the Backstage registration
among them — and clobbers nothing; the read commands and a question over a Backstage
catalogue (`backstage-http` slice 1, ADR-0011; `pnpm demo:backstage` runs them against a fake
on loopback); and stage 4's two previews, which write nothing to a repository:

```bash
idpa "<phrase>" [--repo <dir> | --demo | --backstage] [--project <dir>] [--json] [--quiet]  # question or change
idp-agent relations <name-or-ref> [--consumes | --consumed-by | --depends-on | --impacts | --provides | --provided-by | --to <name-or-ref>] [--depth <n>] [--repo <dir> | --demo | --backstage]  # no model
idp-agent plan --from <plan.json> --repo <dir>   # no model, and none is possible
idp-agent plan "<intent>" --repo <dir> [--json]  # Inspector, Architect, five gates
idp-agent init [--repo <dir>] [--name <n>] [--lifecycle <l>] [--owner <ref>]  # the catalog-info.yaml it would write
```

**`init platform` is still the only command that writes into a repository**, and only into
the directory it was handed; with `IDP_TRACE_DIR` set, `idpa "<phrase>"`, `plan
"<intent>"`, `ask` and `init` also write one trace file there, and nothing else. The two
forms of `plan` and `init` read two repositories and produce a unified diff;
`plan-command.test.ts` and `plan-intent.test.ts` hash every path, every byte and every
directory of both repositories either side of a full run rather than taking that on trust,
and `pnpm smoke` makes the same assertion about the built binary.

The two `--repo` flags name different repositories, which is the first thing that trips
someone up. `plan --repo` is the **declarations** repository the preview is decided
against; `init --repo` is the **application** repository being declared. `idpa
"<phrase>"`, `graph`, `show`, `relations`, `ask` and `plan` take `--repo` in `plan`'s
sense, through the same guard, and find it the same way without it: the working directory
when its root carries the markers `init platform` writes — a witnessed folder under
`catalog/` or `dependencies/`, looked for there and never by walking — then `IDP_REPO`,
then `repo` in the personal `config.yml`. A Backstage catalogue answers the read commands
and a question ahead of each of the last two — `IDP_BACKSTAGE_URL` before `IDP_REPO`,
`backstage` before `repo` in the file — and `--backstage` chooses it over the working
directory; a change never reads one. With none of them the read commands and a
question read the fictional `fixtures/si-demo/`, as `--demo` makes them (`--demo` with
`--repo` is refused), and a change is refused, naming all four ways, because a write
preview is never decided against a demo. So `cd IaC && idpa "<intent>"` decides against
IaC. Every road but `--repo` is said in one line on stderr, naming the folder and what
named it — because an answer about an invented company that does not say so is read as one
about the user's own; a repository is named by its folder, never as the `.` it was typed
as. Two functions decide it, over one chain in `cli/source.ts`: `sourceOf`, what a run
reads, and `declarationsFor`, what a phrase's change is decided against — `plan`'s chain,
never the demo SI or a catalogue. A Backstage is one more `kind` of `sourceOf`'s and never
of `declarationsFor`'s, and `declarationsFor` runs before the catalogue is requested, so a
broken `IDP_REPO` is exit 2 with nothing sent, on a question too.

**A Backstage catalogue** (`docs/backstage-http-brief.md`) is read over HTTP once per run,
before any model, into the graph a folder of YAML fills, through the same reader: both GET
routes, paged and bounded, whole or not at all — a partial read is exit 1, one line naming
the host and what named it, and never answered from. The URL is checked before any request
and quoted with its userinfo, query and fragment starred; the token comes from
`IDP_BACKSTAGE_TOKEN` alone and goes to that catalogue alone, in one header
(`tests/contract/key-reach.test.ts`, every provider, both roads). What it serves reaches the
Supervisor and the Analyst, whose summary shows at most 30 values of each vocabulary list,
the most frequent, then how many more (`shownVocabulary`); the Architect's summary and the
gates keep every value. Nothing read over HTTP reaches a plan's signature, policies,
re-check or Reviewer, which are decided against the declarations repository. A reference it
does not serve reads "declared nowhere in the catalogue this token reads".

A change — `plan "<intent>"`, or a phrase the Supervisor calls a `MUTATION` — may read the
application repository too, and the **Inspector is optional**: it reads the directory
`--project` names, or the working directory when it is an application repository by its
root (`context/iac-fs`'s `isApplicationRepository`: a `catalog-info.yaml`/`.yml` or a
package manifest, never a walk, and never a declarations repository). Anywhere else —
the declarations repository or any folder of it, `$HOME`, the filesystem root — it is
skipped, said in one line on stderr, and the Architect is told that no application
repository was inspected (`NOT_INSPECTED`) rather than handed facts nobody established.
A `--project` that is not a directory, is a declarations repository by its markers, is the
`--repo` directory by real path, or lies under that directory's `catalog/` or
`dependencies/`, is refused with exit 2 before a model is chosen — `cli/repository.ts`'s
`applicationRoot`, which hands `runIntent` both roots resolved; the run that asked for it
read the declarations repository as billing-api's and drafted from that. A phrase checks
its `--project` before the Supervisor, whichever road it then takes, and against the demo
SI too, for what it is on its own (`projectRoot`). `--project` with `--from` is refused —
there is no Inspector to point. `plan "<intent>"` with an
application repository sends the agents exactly what it sent before the Inspector was
optional; `architect.test.ts` pins the opening message's bytes, and the plan-mode tapes
replay clean.

Configuration is two files, and neither holds a secret — a catalogue's token is
`IDP_BACKSTAGE_TOKEN`, and the personal file's `backstage:` is a URL. `.idp-agent.yml` is committed to
an application repository and shared by its team; the personal one —
`$XDG_CONFIG_HOME/idp-agent/config.yml`, else `~/.config/idp-agent/config.yml`
(`%APPDATA%\idp-agent\config.yml` on Windows) — is one person's and never committed.
`cli/personal.ts` locates it from the environment `main` is handed (`MainDeps.env`), never
`os.homedir()`, and `tests/setup/personal.ts` removes `IDP_REPO` and points
`XDG_CONFIG_HOME` into the run directory, so no test — and, likewise, no `pnpm smoke`
check — reads the developer's own. `IDP_REPO` must be absolute or start with `~`.

## Layering

```
cli/  ──→  context/   ──→  core/
  ├──→  agents/   ──→  llm/client.ts   (types only — this is the whole rule)
  ├──→  llm/      ──→  the model SDK   (cli/ builds the client; agents/ may not)
  ├──→  trace/    ──→  agents/events, llm/client   (types only; cli/ ships the trace)
  └──→  scaffold/ ──→  core/
```

`cli/` is the only layer that may reach both `llm/` and the disk, which is why the client
is built in `index.ts` and handed to a command rather than chosen inside one — and why
`fileRecordingStore` lives in `cli/` instead of next to the tape it implements.

| Folder | Responsibility |
|---|---|
| `core/` | schemas (Zod), the nine validation rules and the Backstage registration, the JSON Schema export, deterministic YAML serialiser, entity paths, textual surgery, the unified diff, `core/plan/` — everything between a proposal and a diff — and the engine's check on an answer's commentary (`core/answer/`) |
| `context/` | `ContextProvider` (`fixtures`, and `iac-fs` behind `--repo`; `backstage/provider.ts`, a whole catalogue through the file reader or nothing, which `cli/` constructs for a configured catalogue), `iac-fs` snapshots of a declarations repository with provenance, `project-fs` snapshots of an application repository **without its secrets**, `EntityGraph` and its queries, `backstage/transport.ts` — the only code that sends a catalogue token, over a `fetch` it is handed — and `spawnedEnvironment`, the one builder of a child process's environment |
| `cli/` | argument parsing, commands, rendering, `.idp-agent.yml` and the personal `config.yml`, which source a command reads — the only layer that writes to stdout |
| `llm/` | the single crossing point: `client.ts` is types only — that is what `agents/` imports — while `providers.ts` and `runtime.ts` are the only modules importing the SDK |
| `agents/` | the five agents, the bounded turn, the repair loop, the tool registries — reaches no disk, transitively |
| `trace/` | the trace of one run: `createTraceBuilder` over the event stream and the model calls, the `traced` client decorator, and `toOtlpJson` — pure; `cli/trace-sink.ts` is how a trace leaves |
| `scaffold/` | the `init platform` layout, the packaged templates, and the only writer we own |

Each folder carries its own README stating what lives there, what may not, and which
architecture test holds the line. Read the one for the folder you are about to change.

Rendering returns strings and commands take a graph and return a string, so each is
tested without a terminal. Keep it that way.

## Invariants — non-negotiable

Each has a known cost when violated, and none follows from the documentation of the
tools involved. `docs/design.md` §4 carries the reasoning; do not weaken one without
changing that section first.

**Model**
- A resource is an object; an **access is a right over it**, and the access — not the
  resource — carries the list of its consumers.
- **A right states the level it grants**, `read` or `readwrite`, and only a right may.
  Optional, because an existing repository has none and a network flow has no level —
  but an unstated level is unstated, never read as `readwrite`.
- **A declaration is read from both ends.** Which side wrote the edge down —
  `dependsOn` on the consumer, `dependencyOf` on the access — decides which file a
  reviewer sees, never which question may be answered. `dependenciesOf` is the exact
  transpose of `dependantsOf`, resolving one declared hop; composing several hops is a
  separate, separately named walk (`consumersOf`).
- The **environment is part of an access's identity**: dev and staging are two entities.
- **Declare, never infer.** What is unknown is reported as unknown, never filled with a
  plausible value. A dangling reference is surfaced, never pruned.
- **Never ignore in silence.** An entity that fails validation is reported, never
  dropped — that silent drop is the catalogue behaviour this tool exists to compensate.
  A document this tool does not model — a Group, a System, a `mkdocs.yml` — is not refused
  either, and not dropped: it is set aside and *said* to be, a `not-modelled` warning in
  `validate`, one summary line in `graph`, `show` and `ask`. The one exception is the root
  `catalog-info.yaml`'s Location, the Backstage registration, which `validate` reads and
  holds to Backstage's shape.
- **The read model is wider than the write model.** Backstage's `kind: API` is a node of
  the graph and a Component's `spec.providesApis` an edge — `show`, `graph --kind API`, the
  overview and the Analyst's `get_apis` read them — and neither is ever proposed: a plan is
  decided against Components and Resources, and an API there is a reference that resolves.
  An API's definition is kept only as `declared`, never printed or sent. `consumesApis`
  is not read at all: consuming is an access right, and a second declaration of it would be
  a second truth (design §4.1).

**Authorisation**
- **The merge is the act of authorisation.** The CLI opens a merge request; it never
  writes to the main branch.
- One token per capability: the token that opens a merge request cannot merge it, and a
  test asserts that this action *fails*.
- Any anti-destruction check is repeated engine-side, at the moment of acting.

**Writing**
- One file per entity, one folder per nature.
- **Textual surgery, never a reparse.** A reviewer must see an added line, not a
  reformatted file.
- An entity's location is read *from the entity*, through its annotation — never
  inferred from its type.
- A blank line between YAML documents, or Git anchors deletions across two entities.
- **Absent means already done.** Removing a line that is no longer there must not raise.

**Reconciliation**
- Never delete an orphaned access automatically. An automaton reports; it does not
  delete.
- Record a date of first absence, never a counter of passes.
- One witness file per folder: a pattern with no match is a read error, not an empty set.
- The catalogue lags the repository by ~2 min: check the repository before proposing,
  **and again at the moment of writing**.

## The trust boundary — built as far as the diff

Everything from the Supervisor to the unified diff runs. What is not built is the far
side: the branch is stage 5 and the merge request is stage 6, so a preview is where a run
ends today.

One object crosses **per direction of authority** (design §5.1, ADR-0007). The **`Plan`**
crosses when the AI side asks for a change. The **`Answer`** crosses when it reports a
read — a union of `entities` / `nothing` / `overview` / `relation` / `unanswerable` that
authorises nothing and carries only references the engine's own tools returned, each
re-read before printing. An `overview` carries no identifier at all: the model chooses it,
and the engine writes the description of the catalogue from the graph. A `relation`
carries witnessed references and the name of a relation: the model chooses which entity
and which relation, and the engine computes every path and writes it as `idpa relations`
prints it. Around that block the model may
write an `intro` and a `conclusion` (ADR-0008): it frames the answer and never is it. The
engine drops, whole, every sentence that names an entity no tool returned or an identifier
nobody read, cleans and bounds the rest, and prints each line marked `› ` as the model's —
so no model-authored text reaches stdout unlabelled or unchecked. The check removes entities
and identifiers nobody read, nothing else: a name in plain words (a team, a product, "the
billing API"), a figure or an error of reasoning passes, and only the mark says whose words
they are. `--quiet` prints the block alone.
That witness check is a **read-side** guarantee and does not transfer to `propose()`,
which is why the write side has a signature of its own.

```
Supervisor → Inspector → Architect → Reviewer  │  Zod → signature → policies
                                               │  → re-check → Reviewer → Diff
```

The AI chooses the name, owner, environment and `dependsOn`. The **engine** chooses the
file path, serialises the YAML and puts bytes on disk. The model never emits a line of
YAML, only a structure, and `propose()` writes into a typed buffer, never to disk.

> **The agent drafts. The engine signs.**

`Operation` is a closed discriminated union — what is not modelled cannot be requested,
and there is no delete operation in v0.1. A proposal names every reference in full,
`kind:namespace/name`; only the reader, `entitySchema`, accepts Backstage's short forms
(`owner: team-a`), filling in the kind and namespace by Backstage's own defaults and never
rewriting the file. The proposal schemas are `strictObject`s with four deliberate
absences, each a guarantee: no `apiVersion`, no `annotations` (there is nowhere to put
`idp-agent.dev/source-file`, which is how a model would aim at its own path), no
`description` (free prose has no provenance, so it signs as `novel` and becomes a question
about a sentence the model just invented), and no path anywhere. Every `Plan` field a
model *chooses* is either a value or `{ unknown: string }`, and a `Plan` holding an
`unknown` cannot be applied: the CLI stops and asks. `metadata.name` is the exception and
not an oversight — an entity with no name is not an entity, so that is refused at the
schema rather than asked about. Orchestration is plain TypeScript; no agent decides the
sequence.

**`signPlan` is the only producer of a `SignedPlan`**, and the brand on that type is a
`declare const` symbol that is never exported — so `checkPolicies`, `recheckPlan` and
`planEdits` taking a `SignedPlan` makes "the engine signs" a compile error rather than a
slogan. The signature says **where a value came from**, never whether it is right: an
owner that exists and is the wrong team signs cleanly. That gap is what a policy is for,
and a diff after that, and the merge after that.

The brand proves the object was signed once; the **freeze** proves it still holds what was
signed. `signPlan` deep-freezes the plan it returns and seals the `paths` and `refs` maps,
so a field changed after signing is a `TypeError` at the line that wrote it rather than a
value `planEdits` writes while `classified` still vouches for the old one. A copy is
deliberately not covered: `clarify.answer` and the ask loop produce a new plan from an
answered one, and that plan goes back through all five gates and is signed again.

**`spec.type` is structural on a Resource and classified on a Component.** A Resource's is
`z.enum(RESOURCE_TYPE_NAMES)`, closed, and the folder layout is derived from it. A
Component's is `z.string().min(1).max(63)` — Backstage's own convention, and the one
free-text field a proposal carries — so it is echoed, enumerated against `vocabulary.types`
(which `summariseGraph` builds from every entity, Components included), or novel, and novel
means asked.

**The level a grant hands over is a field of the operation, not a reading of the
request.** `add-dependency-of` carries `access` beside the consumer — the level the
*existing* grant declares — so the signature classifies it like any other leaf, and
`declared-level-mismatch` compares it to what the repository declares without reading a
word of the request. That is what makes it work in every language: the gate it replaced
matched English words, so *accès en lecture* named no level and a `readwrite` grant was
handed to a request for `read` at exit 0. Optional, and an omission is a claim — *this
grant states no level* — which agrees with a pre-`access` declaration and is refused
against a grant that declares one. It does **not** reach the diff: a level is a scalar,
this tool only appends, and `access:` sits further from an added consumer line than the
three lines of context a hunk carries.

**A right's owner is derived every pass, and a conclusion that cannot be re-derived is
withdrawn.** `deriveOwners` runs between gates [1] and [2] on both roads, and the only
owner it leaves alone on a grant is one the **user** stated — in the request, or answered
at a prompt for that owner — and when the consumers determine another, it says so (an
`overridden` event) rather than leaving the disagreement to the diff. An owner one
consumer determines is written and reported; an owner nothing determines goes back to
being a question, whoever put the value there. That last line is the fix for a run that
read `group:default/lion` off a consumer the user then replaced, and ended on a diff
carrying lion's authorisation and somebody else's consumer.

**What the user stated is one `Provenance`** (`core/plan/provenance.ts`): the request,
whose words they are, and every answer typed at a prompt **indexed by the field it
answered**. `deriveOwners`, `signPlan` and `checkPolicies` all read it, and one module
defines what it means — `named` (the request's words, and only a person's), `answered`
(exactly this value at exactly this field) and `stated` (either) — so an answer counts for
what the user said everywhere it should and only there: an answered owner is not withdrawn
on the next pass, an environment answered for an operation counts as asked for that
operation, and answering one grant's level `read` vouches for nothing on another grant.
A path is the plan's own index and the Architect keeps none, so an answer is **recorded by
what it is about** — the entity its operation declares or amends, and the field — and
`reapplyAnswers` (`core/plan/reapply.ts`) puts it back into every plan before the
derivation, on both roads: a field a redraft left open is filled, a different value is
replaced and the replacement said (`reapplied`), and the provenance is re-keyed to where
the entity now sits — so a redraft that moves the entity, or puts the question back, does
not ask it again. A level is recorded by its **access** as well — the consumer and the
thing — because that is what the person answered: `read` typed for billing-api joined to
orders-api's grant follows the redraft into a grant of billing-api's own. A level is
always about **one consumer**: held by its grant too, it is put back there only for the
consumer it was typed for, and only when no operation states its access (the
`link-db-missing` redraft keeps the grant and moves its `dependsOn`), so it puts nothing
on another consumer's access through the grant it was typed into; a level typed for a
grant of two consumers stays at its path. Two updates of one grant for two consumers are
two accesses, and each level follows its own. Only a right whose type states a level is
an access here: a `network-access` over the same database is neither written into nor
counted. It IS asked again —
the safe direction — when the redraft renames the entity, leaves its name open or changes
its kind; when the answer is a list element or a consumer the redraft moved (their
position is not their identity, so they are never written); when the schema would refuse
the value at the redraft's field; and when two operations of one plan amend the same
entity, or state the same access (two answers the plan cannot tell apart). Still keyed by
the index: an answer about an operation with no
name to know it by or about an entity two operations share, and one a caller vouches for
at a fixed path. The words live there and nowhere else — no gate reads `plan.intent`,
which arrives with the plan from whoever drafted it. `plan.ts` records the answers, and
`repair` takes them and the request from its caller, never from a draft.

An environment is deliberately **not** enumerable. `prod` always exists, so accepting one
because the catalogue uses it would let a model pick production for a request that named
no environment at all (§4.1). **And it is never read from the words of a request**, in any
language, exactly as a level is not: a word test cannot read a negation — "not prod",
"prodではなく", "dont use prod" each leave `prod` a whole word — and no list of negations is
complete. The environment comes from the declaration the person points at, or from their
answer; otherwise it is asked, the environments in use listed (owner's decision,
2026-09-27). `.idp-agent.yml`'s `environments` widens what the deterministic gates can
*see*; it does not vouch for anything. The environment a right grants is the one it
**declares**, never one its name spells, and a name spelling another is refused
(`environment-in-name`). Pointing is naming everything a right is over by its **reference
in full** — `kind:namespace/name`, or `kind:name` in the default namespace, as whole tokens
of the request — each declaring the one environment: for the grant an `update-entity`
extends, the environment it hands out (its own, or that of what it is over when it
declares none), and for a right the draft creates over things the repository declares, its
`metadata.env`, signed `derived`. A thing points at nothing, nor does a bare name, a right
over a thing the same plan creates, or a draft declaring another environment than the one
pointed at. The pointing is vetoed by what the request **mentions** — every name the
repository holds (entities, APIs, documents refused or set aside, namesakes in other
namespaces) with every environment any of its documents declares, found anywhere in the
folded request as a plain substring: a mentioned name in another environment, or a refused
document whose name cannot be read, and it is asked — and by a **negation** marker anywhere
in the request (`negates`, a list by language), which is a veto and never a guarantee: a
negation it does not hold, beside a reference in full, still points, at the declaration the
diff shows — and by a **word** saying another environment the repository uses (`contradicts`):
a word never states an environment, and "…resource:default/orders-db-prod in dev" is asked. An update's environment is asked at `operations.<n>.environment`, the grant and
its environment shown, never a default; an answer naming another environment is refused
with the grant of that environment as the remedy, never retargeted (design §5.3, §6.1,
§7.5). `requestedEnvironment` is the one definition `signPlan`, `questionsOf` and
`checkPolicies` read. The cost, in the safe direction: a bare name, an environment named
only in words, a request mentioning several environments' entities, one holding a
negation, or one whose words say another environment, gets the question. Characters nobody sees (`\p{Default_Ignorable_Code_Point}`)
are taken out before a request is read.

Five gates run over a draft, in this order and for this reason: `zod`, `signature`,
`policy`, `recheck`, `reviewer`. The first four are free, so a draft that cannot survive
them never reaches the one that spends a model call, and the Reviewer is shown what the
preview would do to the repository, which only the re-check computes (`repair.ts`, `ORDER`
in `repair.test.ts`). Three attempts, then a clean stop.

## Conventions

- **English throughout** — code, comments, commit messages, test names, CLI output.
- Conventional Commits. Work on a branch; `main` is reached through a merge request.
- **What was done is traceable in the repository, not only in a pull request's description.**
  Every pull request adds its line to [`CHANGELOG.md`](CHANGELOG.md) under Unreleased. It
  updates [`docs/roadmap.md`](docs/roadmap.md) when it closes a queue item, a debt or an open
  question, or records a decision of the owner's. It updates the review's
  [Status section](docs/reviews/2026-09-23-deep-review.md#status) when it
  closes a review priority or a review id. There are no GitHub issues for now: open items
  live in the roadmap, and questions about the code itself in [Open
  questions](#open-questions) below, which the roadmap links.
- Implementation plans are executed task by task, test first. The plan file is the
  checklist; tick its boxes as you go — Stage 1 shipped with all 36 unticked, which is
  how a plan stops being a status signal.
- No `switch` on a closed union without `const _exhaustive: never = value` in `default`.
- **Nineteen** architecture rules are enforced by `tests/architecture/`. `core/` imports
  neither `agents/`, `llm/`, `context/`, `cli/`, `scaffold/`, the disk, the network nor the
  model SDK. `agents/` imports neither `fs`, `child_process` nor a git client — **and
  nothing reachable from it does either**, the test walks the transitive closure. Only
  `llm/` imports the model SDK, and `agents/` imports `llm/client.js` and nothing else from
  it. `scaffold/` imports `core/` and nothing else of ours; only `write.ts` and
  `templates.ts` touch the disk there, and only `write.ts` imports a writing function. In
  `context/`, only `iac-fs` and `project-fs` read a user's repository; in `cli/`, seven named
  modules touch the disk, among them `commands/plan.ts` and `config.ts`, which read the
  repositories too. Across `src/`, only `scaffold/write.ts`, `cli/recording-fs.ts` and
  `cli/trace-sink.ts` import a writing function — `project-fs/snapshot.ts` opens files, read
  only — each named with the functions it may use, and only `project-fs/snapshot.ts` starts
  a process (`git ls-files`), from one call, given the environment `spawnedEnvironment`
  builds: without any `IDP_BACKSTAGE_*` variable and without any provider key. `trace/` reaches nothing
  but types — no disk, no network, no `fetch`, no SDK, nothing of `cli/` — and only `cli/`
  reaches it. Nothing in `context/` names `fetch`, `globalThis`, `global`, `XMLHttpRequest`
  or `WebSocket`, read in the source with comments stripped because `fetch` needs no import,
  nor imports a network module, and only `context/backstage/transport.ts` calls the `catalogueFetch` it is handed; nothing
  reachable from `agents/` is in `context/backstage/` or names any of those words. The rules read `.ts`,
  `.mts` and `.cts`, and fail on a folder that is not there and on an import that resolves
  to no file, rather than passing over nothing. Add a rule when you add a layer — and
  re-count this number when you do, because it is the one that drifts first:
  `pnpm vitest run tests/architecture --reporter=verbose`.
- **No test calls a model.** `tests/setup/offline.ts` makes `fetch`, `node:http`,
  `node:https`, `node:net`, `node:tls` and `WebSocket` throw, and `tests/setup/shell.ts`
  removes every `IDP_` variable but `IDP_TRACE_DIR` and every `*_API_KEY`, unless a scenario
  is being recorded (`IDP_RECORDING=record`, in `tests/scenarios/` only) — and
  `IDP_BACKSTAGE_URL` and `IDP_BACKSTAGE_TOKEN` even then, so no tape holds what a catalogue
  serves. A forgotten
  recording fails loudly instead of quietly spending whoever's key is in the shell, and the
  suite passes the same with the README's variables exported. What stales a tape, and how
  to record one: [`tests/README.md`](tests/README.md). An agent-backed command is driven
  either by a recording or by a scripted client injected through `MainDeps.client` — that
  seam exists so a whole command can be tested end to end with no key and no tape.
  Recording is a deliberate, separate act performed by a human with a key.
- `fixtures/si-demo/` is a valid IaC repository, not a test-only shape: one file per
  entity, in the folder `computeEntityPath` produces, witness files included. `validate`
  reports 33 entities in 33 files and 0 violations over it. Later stages write into it
  directly.
- `.remember/` is one machine's scratchpad, gitignored in full (`*`). It is absent from a
  fresh clone and is not a source of truth about this project — git and this file are.

## Open questions

- **The package is not on npm.** `0.1.0-rc.1` was published and unpublished the same
  hour; the generated `validate.yml` ships with its validation step commented out and
  says so. `package.json` carries `0.1.0-rc.2`, since a version number is never reusable,
  and its metadata, ready for the day it is published again; `prepack` runs `typecheck`,
  `test`, `build` and `smoke` before any tarball is made, and `build` empties `dist/`
  first.
- A copy of the unpublished tarball is still served by `registry.npmmirror.com`; removal
  has to be requested from them.
- **`draftPlan`'s `vocabulary` parameter is misnamed.** It is the trailing slot of the
  Architect's opening message, concatenated last, and `runIntent` puts the repair report
  there because it is the only seam a caller has. The report must *not* be appended to
  `intent` instead: the Architect is shown that string as `request:`, the user's own
  words, so a refusal naming `group:default/tiger` would come back to it as a request for
  tiger. No gate reads it — they read the provenance `runIntent` builds from its own
  `request` — and building the provenance from the Architect's `intent` instead is the
  change that would let the gate that caught a value vouch for it on the next attempt.
  Worth renaming the parameter when someone next touches `architect.ts`.
- **The Architect is told what the user answered only when a refusal is at it.** `repair`
  puts every answer back into a redraft (`reapplyAnswers`), and when a gate refuses a
  field holding one — the owner's `read` joined to a readwrite grant — the report ends
  with the user's values the engine puts back and what each is about, so the model stops
  proposing the field the engine will overwrite. A refusal elsewhere after an answered
  round still hands back no answers: the redraft can propose a different owner the engine
  then overwrites, or rename the entity and have the question asked again. Listing them on
  every report would let it converge sooner; it changes what the Architect is sent after
  an answered round, which stales the `link-db-missing` tape, so it waits for a re-record.
- **`docs/plans/stage-3-init-platform.md` still documents `init` as a tested refusal.**
  Stage 4 answered that refusal. The historical plan was left alone on purpose — a plan is
  a record of what was decided then — but it is not a description of the code now.
