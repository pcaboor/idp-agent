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
pnpm test             # 5466 tests. No API key, no network, no Docker. Ever.
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

The demo Backstage is optional too, needs Docker, and is never part of CI
(`tools/backstage/README.md`): our own minimal Backstage 1.55.2 holding the demo SI.

```bash
pnpm build && pnpm demo:backstage:docker         # build, start, wait, run idpa against it, check the 401, stop
pnpm demo:backstage:docker --record              # also re-records tests/contract/backstage/, after moving the version
pnpm backstage:up                                # leave it running on 127.0.0.1:7007 (guest sign-in); pnpm backstage:down
```

Stage 6's live test is optional too, needs gh logged in to github.com as a person, the owner's
ssh key and their throwaway repository, and is never part of CI (`docs/submitting.md`,
*Proving it on your repository*): it proves on GitHub that the identity that opened a pull
request cannot merge it, and re-records `tests/contract/github/`, which holds the fake gh to
GitHub in `pnpm test` and pins `GH_MINIMUM_VERSION` (2.96.0, from the run of 2026-10-02).

```bash
pnpm build && IDP_GITHUB_LIVE_REPO=<you>/idpa-live pnpm test:live:github    # without the variable it stops at once
pnpm build && IDP_GITHUB_LIVE_REPO=<you>/idpa-live IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR=<dir> pnpm test:live:github   # with a second account's gh, for the steps another person makes
```

**Every number on this page is a measurement, and this page has drifted from all of them
before** — a test count one short, an architecture-rule count several short, one module
named as the only importer of the model SDK when there were two. A figure nobody re-ran is
worse than no figure, because it is read as evidence. Re-run the command and correct the
number in the same commit as the change.

**Exit codes:** `0` succeeded — a diff rendered, or a run with nothing to change because
the repository already declares everything each operation states, the file and fields named,
or a branch submitted, already submitted, or declined at the confirmation, nothing written
— on GitHub whatever the base's rules, a note saying when its author may merge it alone — or a
change another person already proposed, byte for byte, named — or a
proposal declined, or not made, the preview standing — except an `init` whose discovery
verified no finding in a repository read in part, which is `1`
· `1` the answer is negative — an `init` that previewed, found nothing to change or to
submit, or was declined at the confirmation, while its discovery verified no finding and read
the repository in part (the coverage sentence on stdout and stderr; once a branch is cut or a
pull request opened, 0), nothing matched, a name was ambiguous (two entities sharing it
included), a relation holds nothing, two entities are linked by no declared path and reach
nothing in common (a near miss alone does not count), an entity was asked about its paths
to itself, **the repository does not conform**, a gate refused a
plan, the repair loop stopped at three attempts, a Backstage catalogue could not be read
(unreachable, refused, a 3xx, past a byte or time bound — never a fall back; one past a
count bound is answered in part, with the answer's own code, and says so), `--cached` with
no copy kept that verifies, a submission
refused — a catalogue that differs from `HEAD`, a plan writing into both repositories, a
refusal at the moment of writing, git failing, a repository on GitHub gh's account cannot
push to, that is archived or that answers under another name, a clone not level with GitHub, a closed or reverted pull request, a pull request not opened, a
push refused, a service whose `.idp-agent.yml` names another repository than the one a
submission goes to, an idp-agent pull request in flight that changes a file this change
writes, differently, or more of them than this build compares — or something failed unexpectedly · `2`
the arguments were refused — a bad flag, a plan file that is not a plan, a `--repo`, a
`--project`, a configured repository or the directory `validate` or `init` is handed that is
not a directory, a `--project` that is a declarations repository or the one the change is
decided against, a change with no declarations repository to decide against, a single word
one slip away from a command name (`idpa grpah`, `idpa relation`), a command typed after its
options, two relation flags or one beside `--to`, a `--depth` that is not a whole number
from 1 to 100, a `.idp-agent.yml` or a personal `config.yml` that does not parse, a
catalogue URL refused before any request, `IDP_BACKSTAGE_TOKEN` unset for a catalogue that
is not on this machine or holding a character a header cannot carry, `--backstage` with none
configured, `--refresh` and `--cached` together, beside `--repo` or `--demo`, or against a
source that is not a catalogue, `--cached` where no copy is kept (`IDP_BACKSTAGE_CACHE=off`,
no home, Windows, root), an `IDP_BACKSTAGE_CACHE` other than `off`, a declarations repository `--submit` cannot cut a branch in (not a git clone's
root, no `git`, no committer identity, a detached or unborn `HEAD` — on `plan "<intent>"`,
`idpa "<phrase>" --submit` and `init`, refused before the model is configured), `init --submit` for a service in a
subfolder of its repository, an `--iac-repo` or `--environment` the configuration's schema
refuses or holding a control, format or bidi character, `--submit` with `--demo`,
`idpa "<phrase>" --submit` with no declarations repository (refused before any model),
`--local` without `--submit`, on a submission toward GitHub gh missing,
logged out, expired, too old or not a person, a key of the clone's own configuration that
would redirect the push or run a program, a remote URL with a credential or that does not
parse — or no
model, no key or no usable `IDP_TIMEOUT` or `IDP_SUPERVISOR_MODEL` is configured · `3` the
request was understood and this build will not act on it: a change request put to `ask`
(which names `idpa "<phrase>"` as the gesture that previews it), a question put to
`idpa "<phrase>" --submit` (which names the same phrase without `--submit`), a question the model
refused, a plan holding values nobody can vouch for, **asked rather than guessed**, or a
plan that produces no bytes while the repository does not already declare what it states —
in prose and in `--json` alike · `130` Ctrl-C at a question, at `--submit`'s
confirmation or at a proposal: the person stopped the run, which is not a declined question (Ctrl-D is one).
`idpa protection` has three of its own: `0` the rules hold, `1` they do not or GitHub
answered a failure, `2` the arguments, the clone's configuration, its upstream or gh
refused. A command returns
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
declarations repository that is also the company's catalogue holds Locations and Templates,
and they are not ours to refuse. Backstage's APIs are read, not set aside: an API missing what
Backstage requires of one is an `invalid-entity` error, as a broken Component is, and a
`providesApis` naming nothing is a dangling reference. Its Groups, Users, Systems and Domains
are read too, and counted, and **no rule reads them**: one Backstage would refuse — a Group
without `children`, a System without an owner — is set aside with a `not-modelled` warning
saying why, never an error, because a Group is usually another team's and the re-check would
make an error in a file a plan edits the plan's (owner's decision, 2026-09-28). The `kind: Location` of the root
`catalog-info.yaml` is not set aside either: it is the repository's **Backstage
registration**, which `init platform` writes with the path registry's folders as targets
(`core/validate/registration.ts`, `docs/adopting-backstage.md`). `validate` counts it in
silence, fails on what Backstage would refuse or what reads outside the repository
(`registration`, an error), and warns when no target reaches one of the registry's folders.

## Current state — 2026-10-03

`main` carries stages 0 through 6; stage 6 was proved on GitHub by the owner's live test of
2026-10-02 and is recorded in ADR-0015, and every tape recorded before 2026-09-30 was recorded
again by the owner on 2026-10-02 (6.4.3). History is linear, no merge commits.
Each stage lands as a stack of branches, one per task of its plan in `docs/plans/`, rebased
and merged bottom-up. Stage 5 landed that way, one task per pull request: `Cleared`, the forge
layer, the local forge, `plan … --submit` on both roads, and `init --submit`, which writes a
service's catalog-info and its `.idp-agent.yml` on one branch of its own repository. Stage 6
landed the same way, in fourteen pull requests (`docs/plans/stage-6-github.md`): the
allow-list and `idpa protection`, the GitHub forge on `plan --from`, the intent, `init` and
phrase roads, the three tasks the owner added on 2026-10-01, the live test, ADR-0015, and the
owner's re-recorded tapes, every turn under the digest of what the provider is sent.

| # | Stage | State |
|---|---|---|
| 0 | Foundations — schemas, serialiser, paths, invariants | done |
| 1 | Read-only — `graph`, `show <entity>` over fixtures | done |
| 2 | Question mode — Supervisor, recordings | done |
| 3 | `init platform` — scaffold, CI, CODEOWNERS, witnesses, `validate` | done |
| 4 | Preview only — Inspector, Architect, `Plan`, diff; writes nothing | done |
| 5 | Write + local branch — `ForgeProvider`, atomicity, idempotence | done |
| 6 | GitHub pull request — the person's git and gh, the ruleset checked, the live test | done, proved live on 2026-10-02 (ADR-0015), every tape recorded again (6.4.3): `idpa protection`, `plan --from … --submit`, `plan "<intent>" --submit`, `init --submit`, `idpa "<phrase>" --submit`, the pull request opened whatever the base's rules, with a note where its author may merge it alone (6.3.4), at a terminal, a change's diff ending on the engine's proposal to open it (6.3.5), and what is in flight read first — the open idp-agent pull requests into the base, before any model and again before writing: the same change named, a competing one refused, one beside proposed beside it (6.3.6) |
| 7 | Polish — Ink TUI, README, asciinema, npm publish | |

The order is imposed by the doctrine: read first, validate before the first write,
preview before the pull request. Writing arrives only at stage 5.

Shipped and working: `idpa "<phrase>"`, the one gesture of §7.4, from any directory — the
Supervisor classifies the phrase once, a question takes `ask`'s road and a change `plan
"<intent>"`'s (`cli/commands/entry.ts`); `graph` and `show` over a fixture SI of 33
entities; `relations`, which traces an entity's relations from the declarations —
multi-hop, both directions, each row with its whole path, the rights on it and their
levels, the environment at each step, and a reference declared nowhere marked where the
path ends; between two entities, the paths where one depends on the other, else the
nearest entities both reach; and over the organisation, what a team owns down its child
teams, who owns an entity and the groups above, a person's groups, a group's members, and
what a System or a Domain holds and what holds it (`backstage-http` slice 3.2) — with no
model (`context/graph/relations.ts`, rendered by `cli/render/relations.ts`); `ask`,
answered by the Supervisor and the Analyst against recordings with no API key, a relation
question included: the model chooses the entity and the relation, and the engine writes
`relations`' block; `validate`, nine rules over an IaC repository; `init platform`, which
writes thirteen files — the Backstage registration among them — clobbers nothing, and prints
the ruleset `idpa protection` checks; `idpa protection` (stage 6, slice 6.1), which reads,
through the person's own gh and with `GET` only, whether the branch a clone tracks on
github.com keeps a pull request from merging until someone other than its opener approves
its latest commit — no model, nothing written, its exit 1 a diagnostic, since a submission
opens the pull request whatever the rules and says, in a note, when its author may merge it
alone — and `pnpm demo:github` shows its three answers against a fake gh; the
read commands and a question over a Backstage catalogue (`backstage-http` slice 1,
ADR-0011; `pnpm demo:backstage` runs them against a fake on loopback), past its bounds
answered in part (slice 2, ADR-0013) and kept five minutes for a second run, with
`--refresh` and `--cached` (slice 2, ADR-0014); the organisation —
Groups, Users, Systems and Domains, read-only nodes beside the entities, from files and
from a catalogue alike, which `show` prints and the overview counts (`backstage-http` slice
3.1), and which a question reads too, over a source that holds some — "what does team tiger
own?", "who is in tiger?", "which system is billing-api in?", answered with the relation
block `relations` prints (`backstage-http` slice 3.3; recorded and replayed with no key in
`tests/scenarios/backstage-mode.test.ts`, with slice 1's question); and stage 4's two
previews, which write nothing to a repository — unless `plan`, `init` or a phrase is given `--submit`,
stage 5's writes, or, at a terminal, a person answers `y` to the engine's proposal a change's
preview ends on, a local branch for review — and, from a clone whose branch tracks one on
github.com, that branch pushed with the person's git and one pull request opened with their
gh, or with `--local` the local branch alone; a branch or a pull request already there is
named, or refused, before anyone is asked to confirm:

```bash
idpa "<phrase>" [--repo <dir> | --demo | --backstage] [--refresh | --cached] [--project <dir>] [--json] [--quiet] [--submit [--local]]  # question or change
idp-agent relations <name-or-ref> [--consumes | --consumed-by | --depends-on | --impacts | --provides | --provided-by | --owns | --owned-by | --member-of | --has-member | --part-of | --has-part | --to <name-or-ref>] [--depth <n>] [--repo <dir> | --demo | --backstage] [--refresh | --cached]  # no model
idp-agent plan --from <plan.json> --repo <dir> [--submit [--local]]  # no model, and none is possible
idp-agent plan "<intent>" --repo <dir> [--json] [--submit [--local]]  # Inspector, Architect, five gates
idp-agent init [--repo <dir>] [--name <n>] [--type <t>] [--lifecycle <l>] [--owner <ref>] [--submit [--local]] [--iac-repo <locator>] [--environment <name>]...  # the catalog-info.yaml, and .idp-agent.yml when a flag states it
idp-agent protection [--repo <dir>]  # through the person's gh, reads only; no model, no write
```

`init` also reports what the service's committed configuration states (stage 8, slice 1,
`docs/plans/stage-8-slice-1.md`): `context/discovery/discover.ts` opens the `package.json`
files and sample environment files `HEAD` holds, by name, extracts typed findings from them
— a package's name, the database, cache and queue clients it installs, a sample's connection
strings with no password — reads each finding's file again, and `core/discovery/report.ts`
says what was read and what was not, and why. The report prints between `init`'s diff and its
closing lines, so a saved preview still applies, its sentence goes to stderr too, and
`init --submit`'s pull request carries it after the engine's block. No model is sent any of
it, and nothing is proposed from it yet. And `init` takes no model's reading of the service
as the person's word (slice 2, Task 2.1): the name, type, lifecycle and owner the Inspector
reads are hints shown beside the questions, labelled as a model's reading, each held to its
field's grammar and never selected — an empty line declines — and only what a person types,
by `--name`, `--type`, `--lifecycle`, `--owner` or at the prompt, signs as answered.

**`init platform` writes into the directory it was handed, and through no symbolic link
under it. `plan … --submit`, `idpa "<phrase>" --submit` and
`init --submit` write one new ref and the objects it reaches, and nothing else, and, on a
GitHub road, `plan --from … --submit`, `plan "<intent>" --submit`, `idpa "<phrase>" --submit` and `init --submit` push that
one ref to the same name on github.com with your git and open one pull request with your gh** — never `HEAD`, the index, the
working tree or a ref that exists; and so do `idpa "<phrase>"` and `plan "<intent>"` without
`--submit` when a person answers `y` at a terminal to the engine's proposal a change's diff ends
on; every other road pushes nothing and opens no pull request (`plan-command.test.ts`'s *still writes nothing — .git
included — without --submit* and `plan-intent.test.ts`'s *leaves the declarations repository
byte-identical*, neither run at a terminal; `plan-intent.test.ts`'s *writes nothing on either
side when the proposal is declined* and *proposes nothing in --json, nor with no terminal, and
starts no gh*). With
`IDP_TRACE_DIR` set, `idpa "<phrase>"`, `plan "<intent>"`, `ask` and `init` also write one
trace file there, and nothing else. A run that reads a Backstage catalogue keeps the read
under `$XDG_CACHE_HOME/idp-agent/backstage` (else `~/.cache/…`), for the running account
alone, and nothing else — a root `bin.ts` hands `main` (`cacheRootOf`) and nothing else does,
so no test's `main` writes under a real home. The two forms of `plan` and `init` read two repositories
and produce a unified diff; `plan-command.test.ts` and `plan-intent.test.ts` hash every
path, every byte and every directory of both repositories either side of a full run —
`.git/` of a clone included — rather than taking that on trust, `plan-command.test.ts`
compares every ref, `HEAD`, the index and the working tree either side of a submission, and
`pnpm smoke` makes the same assertions about the built binary.

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
routes, paged and bounded. A read past a count bound — 20,000 Components, Resources and
APIs, 200,000 of the organisation or of other kinds' references — stops there and is
answered in part, and says so everywhere (ADR-0013): a `past the bound:` line on stderr,
a `partial:` line closing each answer, a reference past it `not loaded`, never declared
nowhere, and one line to the Supervisor and the Analyst; a whole read prints and sends what
it did. Any other failure is exit 1, one line naming the host and what named it, and never
answered from. A read is kept five minutes (`context/backstage/cache.ts`, ADR-0014): a run
within them answers from the copy, sends nothing and says `read from cache, 3 min old;
--refresh reads Backstage again`; `--refresh` reads Backstage again; `--cached` answers from
the copy whatever its age and never asks; after a failure of reach the failure line names
`--cached` and the copy's age, never after a 401 or a 403. A copy is keyed by an HMAC of the
base, the token and the read's shape under a per-machine secret, sealed by a MAC, and read
again through the load's checks, the pre-pass and the reader; a run answered from one is
traced with no page and no byte. The URL is checked before any request
and quoted with its userinfo, query and fragment starred; the token comes from
`IDP_BACKSTAGE_TOKEN` alone and goes to that catalogue alone, in one header
(`tests/contract/key-reach.test.ts`, every provider, both roads). What it serves reaches the
Supervisor and the Analyst, whose summary shows at most 30 values of each vocabulary list,
the most frequent, then how many more (`shownVocabulary`); the Architect's summary and the
gates keep every value. Nothing read over HTTP reaches a plan's signature, policies,
re-check or Reviewer, which are decided against the declarations repository. A reference it
does not serve reads "declared nowhere in the catalogue this token reads". The organisation
is a third read, sent only when the facets name a Group, a User, a System or a Domain, of the
fields the read model reads and nothing else (`ORGANISATION_FIELDS`: no annotation, no
profile), under a ceiling of its own; the kinds it read whole are the ones an owner, a
membership or a system is judged against (`LoadResult.judged`), which a folder never sets,
and one it read only up to its bound judges nothing.
What the Analyst's tools read of it — a User's name and its groups among them — reaches the
model provider only over a source that holds an organisation (`SECURITY.md`); over one that
holds none, what the Supervisor and the Analyst are sent is what every tape recorded.

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
  │           ├──→  process/   (context/project-fs: git ls-files;
  │           │                 context/discovery: git ls-files, ls-tree)
  │           └──→  confine/   (context/iac-fs, project-fs and discovery/read.ts:
  │                             lstat, realpath, O_NOFOLLOW)
  ├──→  agents/   ──→  llm/client.ts   (types only — this is the whole rule)
  ├──→  llm/      ──→  the model SDK   (cli/ builds the client; agents/ may not)
  ├──→  trace/    ──→  agents/events, llm/client   (types only; cli/ ships the trace)
  ├──→  forge/    ──→  core/, process/   (only cli/ reaches it at run time;
  │                                        local/ through git, github/ through git and gh)
  └──→  scaffold/ ──→  core/, confine/
```

`process/` is a leaf: it imports nothing of ours, and it holds the two launchers every process
`src/` starts goes through — `git.ts` for the Inspector's `git ls-files`, the forge's git and
the one push form, `gh.ts` for gh — each running only the command shapes of its grammar. `confine/`
is a leaf too, and holds the one primitive a user's repository is read and written through
below its root — `init platform`'s writer, `iac-fs`, `project-fs` and the discovery read — so that a symbolic
link is judged by where it leads, never by its name alone.

`cli/` is the only layer that may reach both `llm/` and the disk, which is why the client
is built in `index.ts` and handed to a command rather than chosen inside one — and why
`fileRecordingStore` lives in `cli/` instead of next to the tape it implements.

| Folder | Responsibility |
|---|---|
| `core/` | schemas (Zod), the nine validation rules and the Backstage registration, the JSON Schema export, deterministic YAML serialiser, entity paths, textual surgery, the unified diff, `core/plan/` — everything between a proposal and a diff — the engine's check on an answer's commentary (`core/answer/`), `core/github/`: a remote's URL and the grammars a clone's own configuration is held to, the configuration's scope check, gh's version, and the fields read of GitHub's answers, and `core/discovery/`: stage 8's finding, minted only by `mintFinding`, every field held to a closed grammar and to the credential shapes, and the connection-string parser that keeps only the parts it names, `allow.ts`, what the discovery read may open by path, `verify.ts`, the witness re-read, the two extractors of slice 1 (`extract/env-file.ts`, `extract/npm.ts`) and `report.ts`, the coverage report `init` prints and its pull request carries, and its sentence; `core/secrets/` and `core/text/` hold the credential, placeholder and script shapes it shares with `project-fs` and the commentary check, and the lists of where credentials live by name (`secrets/names.ts`), which `project-fs` and the discovery read share; `core/git/blob.ts` computes git's blob id for the forge and the read |
| `context/` | `ContextProvider` (`fixtures`, and `iac-fs` behind `--repo`; `backstage/provider.ts`, a whole catalogue through the file reader or nothing, which `cli/` constructs for a configured catalogue), `iac-fs` snapshots of a declarations repository with provenance, `project-fs` snapshots of an application repository **without its secrets**, `discovery/read.ts` — stage 8's second reader of that repository, which opens only its committed `package.json` and sample environment files, by name, through `openToRead`, follows no link, keeps a file's bytes only when they are `HEAD`'s, and names a path only when `HEAD` holds it — what git does not track or is staged and never committed is counted, never named; it and `project-fs` load nothing of each other, and `discovery/discover.ts` chains it with the extractors and the re-read for `init`, never throwing — `EntityGraph` and its queries, `backstage/transport.ts` — the only code that sends a catalogue token, over a `fetch` it is handed — and `backstage/cache.ts`, a catalogue read kept under the person's cache folder, which only the provider loads and no command uses yet |
| `cli/` | argument parsing, commands, rendering, `.idp-agent.yml` and the personal `config.yml`, which source a command reads — the only layer that writes to stdout |
| `llm/` | the single crossing point: `client.ts` is types only — that is what `agents/` imports — while `providers.ts` and `runtime.ts` are the only modules importing the SDK |
| `agents/` | the five agents, the bounded turn, the repair loop, the tool registries — reaches no disk, transitively |
| `trace/` | the trace of one run: `createTraceBuilder` over the event stream and the model calls, the `traced` client decorator, and `toOtlpJson` — pure; `cli/trace-sink.ts` is how a trace leaves |
| `scaffold/` | the `init platform` layout, the packaged templates, and `write.ts`, the writer for a repository being created |
| `forge/` | where a submission becomes a branch: `provider.ts` — `ForgeProvider`, `Base`, `Submitted`, types only, with no merge, no delete and no caller-chosen name — `ForgeInputError`, a refusal that is the user's arguments — and `local/`, the local forge: `openLocalForge` for one repository, which writes git objects and one create-only ref, through the launcher, and never the working tree, the index or `HEAD` (ADR-0010) — and `github/`, which reads through both launchers and judges with `core/github/`: `readRoad`, the road a submission takes, `readIdentity`, who gh is, `githubApi`, GitHub through gh, `preflight.ts`'s `readProtection`, `preflight` and `readRules` (§ 8's reads), and `openGitHub`, the road then gh's identity, which `idpa protection` reaches — and `github/forge.ts`, the GitHub forge: the local forge (`acceptOlderBase`, `local/tree.ts`'s `treeFor`), then the person's own push of that very commit, create-only, a read-back through gh, the rules once more and one pull request whose body the engine writes, proved offline against the fake gh and a bare repository — and `open.ts`'s `openSubmissionForge`, what every submission opens: the local forge, the road, gh's identity, and on GitHub's road the GitHub forge, which both forms of `plan`, `init` and the phrase take. `plan … --submit`, on either road, `idpa "<phrase>" --submit` and `init --submit`, for the service's repository, reach it, through `cli/commands/submit.ts` |
| `confine/` | physical confinement: `confine.ts`'s `followInside`, `openToRead` (`O_NOFOLLOW`, checked once open), `makeFolders` and `createNew` (`O_CREAT \| O_EXCL \| O_NOFOLLOW`) — what `assertInsideRepo`, lexical, cannot see; `iac-fs` follows no link, `project-fs` follows one that stays inside, `init platform` writes through none |
| `process/` | the one place a process is started: `git.ts`'s `gitIn` — hooks and fsmonitor off, `user.useConfigOnly`, every `GIT_*` scrubbed, started outside the repository, bounded — and `pushIn`, the one push form; `gh.ts`'s `ghIn`, gh in the same shape; each checks the finished vector against its grammar (`checkGitArgv`, `checkGhArgv`) before anything starts, and throws `LauncherRefusal` otherwise; and `environment.ts`'s `spawnedEnvironment`, the one builder of a child process's environment |

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
  A document this tool does not model — a Location, a Template, a `mkdocs.yml` — is not
  refused either, and not dropped: it is set aside and *said* to be, a `not-modelled` warning
  in `validate`, one summary line in `graph`, `show` and `ask`. So is a Group, a User, a
  System or a Domain Backstage would refuse, its warning saying why. The one exception is the
  root `catalog-info.yaml`'s Location, the Backstage registration, which `validate` reads and
  holds to Backstage's shape.
- **The read model is wider than the write model.** Backstage's `kind: API` is a node of
  the graph and a Component's `spec.providesApis` an edge — `show`, `graph --kind API`, the
  overview and the Analyst's `get_apis` read them — and neither is ever proposed: a plan is
  decided against Components and Resources, and an API there is a reference that resolves.
  An API's definition is kept only as `declared`, never printed or sent. `consumesApis`
  is not read at all: consuming is an access right, and a second declaration of it would be
  a second truth (design §4.1). Backstage's **Group, User, System and Domain** are read the
  same way, from a file and from a catalogue, as the organisation: an index of the graph
  **beside** the entities, never in `all()`, so no table, vocabulary, gate or entity row
  sees one, and never proposed. `show` prints a team, a person, a system, a domain; the
  overview counts them; the Analyst finds, reads and walks them with tools of its own and
  the summary counts them in one line, both only where the source holds one. Of a User only the name and `memberOf` are read — never an
  annotation, a title or `spec.profile`. A reference to one is judged — "declared nowhere in
  the catalogue this token reads" — only where a catalogue read its kind whole: a
  declarations repository's Group files are not the organisation. On the plan road the
  organisation is a reference that resolves, as it was when it was set aside.

**Authorisation**
- **The merge is the act of authorisation.** The CLI opens a pull request; it never
  writes to the main branch.
- **idpa never merges and never writes to the base: it opens a pull request, and the base's
  rules decide who may merge it.** Whether its author may merge it alone is the company's rule,
  not this tool's; where the rules allow it, idpa says so — `note: on this repository the
  author may merge without another person's review` — on stderr and in the pull request, and
  the pull request is opened all the same. Where the rules require someone else's approval of
  the exact commit that would merge, the identity that opens the pull request cannot merge it:
  on GitHub the right to push a branch is the right that merges, so no credential can be
  scoped out of merging, and what refuses the merge is the base's ruleset, which the tool
  reads before it writes anything and again at the moment of acting; a test asserts that the
  merge **fails** there: offline against a fake (`tests/unit/merge-refused.test.ts`), live on
  a throwaway repository by the owner (ADR-0015).
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

## The trust boundary — built as far as a pull request, on every road that submits

Everything from the Supervisor to the unified diff runs, and on both roads of `plan` one
step further: `plan … --submit` cuts the branch, locally — `plan "<intent>"` after all five
gates, having refused a repository that cannot take it before any model was paid. `init
--submit` does the same in the service's own repository, for its catalog-info and
`.idp-agent.yml`. Both roads of `plan … --submit` cross it on a GitHub road — they push that
branch with the person's git and open one pull request with their gh, after the base's rules
and its tip were read through gh, and again at the moment of acting; `plan "<intent>"` reads
the road and gh before the model is configured and the rules before the first model call,
and holds a service's `iacRepo` to the clone's repository as a cross-check. `init --submit`
crosses it in the service's own clone, held to the same configuration check and the same
preflight before the Inspector, its refusal on § 8 item 1 — a repository archived, renamed
or not pushable — naming `--local` (decision 17). `idpa "<phrase>" --submit` crosses it as
`plan "<intent>"` does (D8 lifted): the forge, gh and the base's rules are read before the
Supervisor, a change is then submitted through `runIntent`, and a question is refused after
the Supervisor's one word, exit 3. And at a terminal a change previewed without `--submit` —
a phrase the Supervisor calls a `MUTATION`, or `plan "<intent>"` — ends on the engine's
proposal, the same question (2026-10-01): the person's `y` is the authorisation, nothing is
read on GitHub before the last model call on that road, and where the engine could not do
what the question says, one `no pull request proposed — …` line says why and the preview
stands at exit 0. No model writes the question and no agent holds a tool that pushes; stdin,
stdout and stderr must each be a terminal, and what was typed before the question is
discarded (`proposeOf`, `discardTypedAhead`). What is not built is the merge, by design —
idpa has no command and no forge method that merges, approves or closes (ADR-0015) — and
ADR-0012's required check, which is the downstream system's: `idpa protection` and a
submission's closing lines print the status checks merging waits for.
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
A value the Inspector reports reaches the Architect only where a file
it read before its report states it, by the field's rule (`agents/tools/project-witness.ts`:
a whole token, a keyed line, a reference in full; a dependency's type never; a value folding
would change in anything but its case, by none; an empty dependency list, by none when no file
was read); otherwise it is
an unknown with the engine's reason, said on stderr and in the trace, and asked where a
proposal carries it — a `package.json` the model wrote into a tool's arguments is read by
nobody. On `init` a witnessed value vouches for nothing: it is a hint beside the question at
its field, shown as a model's reading and held to the field's grammar, and the signature
reads what the person typed alone (stage 8, slice 2, Task 2.1). The reason a model writes for
a field it marks unknown is not checked, and reaches the Architect as written, bounded at
8,192 characters, until stage 8 makes it the engine's — it is never shown as a hint.

```
Supervisor → Inspector → Architect → Reviewer  │  Zod → signature → policies
                                               │  → re-check → Reviewer → Diff
                                               │  → [submit] → branch → push → pull request
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
consumer it was typed for, and only when no operation states its access (a redraft that
keeps the grant and moves its `dependsOn`, as the `link-db-missing` tape recorded before
2026-10-02 did, and `reapply.test.ts` pins), so it puts nothing
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
- Conventional Commits. Work on a branch; `main` is reached through a pull request.
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
- **Thirty-two** architecture rules are enforced by `tests/architecture/`. `core/` imports
  neither `agents/`, `llm/`, `context/`, `cli/`, `scaffold/`, `forge/`, `process/`,
  `confine/`, the network nor the model SDK, and nothing reachable from it reads or writes — its disk rule
  walks the transitive closure too. `agents/` imports neither `fs`, `child_process` nor a git client — **and
  nothing reachable from it does either**, the test walks the transitive closure. Only
  `llm/` imports the model SDK, and `agents/` imports `llm/client.js` and nothing else from
  it. `scaffold/` imports `core/` and `confine/` and nothing else of ours; only `write.ts` and
  `templates.ts` touch the disk there, and only `write.ts` imports a writing function. In
  `context/`, only `iac-fs`, `project-fs`, `discovery/read.ts`, the fixtures and
  `backstage/cache.ts` touch the disk, and only the first three read a user's repository; in `cli/`, seven named
  modules touch the disk, among them `config.ts`, which reads `.idp-agent.yml` in either
  repository, and `commands/plan.ts`, which reads the plan file `--from` names — the
  declarations' bytes it reads through `iac-fs`. Across `src/`, only `scaffold/write.ts`
  (`mkdir`, for the directory it is named), `confine/confine.ts`, `cli/recording-fs.ts`,
  `cli/trace-sink.ts` and `context/backstage/cache.ts` (`rename`, `unlink` and `rmdir`: a copy
  renamed into place, a pruned one removed) import a writing function — `confine/` opens
  files, read only for `iac-fs`, `project-fs` and the discovery read, create-only for `init platform` and the
  cache, whose folders it makes `0o700` and files `0o600` — each named with the functions
  it may use; the forge is the sixth writer, through git and nothing else. `confine/`
  imports nothing of ours, only `node:` built-ins, and only `scaffold/write.ts`,
  `context/iac-fs`, `context/project-fs`, `context/discovery/read.ts` and
  `context/backstage/cache.ts` load it; only
  `context/backstage/provider.ts` loads the cache, so a catalogue kept on disk reaches
  nothing but the provider's loop, which runs the pre-pass and the reader on every item of
  it as on a page. Only `process/git.ts` and `process/gh.ts` start a process, each from a
  grammar of the command shapes it may run, checked on the finished vector before the process
  starts (stage 6 brief § 6): git for the Inspector's `git ls-files`, the discovery read's listing of what git tracks
  and what `HEAD` holds — six shapes the launcher already ran, and none added — the forge and
  the one push form, from two calls, and gh from one, each given an environment `spawnedEnvironment`
  builds: without any `IDP_BACKSTAGE_*` variable and without any provider key; only
  `context/project-fs/snapshot.ts`, `context/discovery/read.ts` and `forge/` load the git
  launcher, and only
  `forge/github/` loads the gh launcher (*only forge/github/ loads the gh launcher*). No source in `src/`
  names a door the grammars refuse (*nothing in src/ names a door the allow-list refuses*) or
  reads a GitHub credential from the environment (*nothing in src/ reads a GitHub credential
  from the environment*), and in `tests/` only `tests/live/` and `tests/support/fake-gh.ts`
  name a door (*in tests/, only tests/live/ and tests/support/fake-gh.ts name a door*).
  `process/` imports nothing of ours, only `node:` built-ins; `forge/` imports `core/`,
  `process/`, `node:crypto` and `node:path` and nothing else — no package, no disk, no
  network; and only `cli/` reaches `forge/` at run time, however many hops away — another
  layer may name its types. `trace/` reaches nothing
  but types — no disk, no network, no `fetch`, no SDK, nothing of `cli/` — and only `cli/`
  reaches it. Nothing in `context/` names `fetch`, `globalThis`, `global`, `XMLHttpRequest`
  or `WebSocket`, read in the source with comments stripped because `fetch` needs no import,
  nor imports a network module, and only `context/backstage/transport.ts` calls the `catalogueFetch` it is handed; nothing
  reachable from `agents/` is in `context/backstage/` or names any of those words. Nothing
  reachable from `agents/` is in `core/discovery/` or `context/discovery/`, however many hops
  away and a type included (*nothing reachable from agents/ is in core/discovery/ or
  context/discovery/, not even a type*): a finding is the engine's, and no model sees one. And
  `context/project-fs/` and `context/discovery/` load nothing of each other, however many hops
  away and a type included (*context/project-fs/ and context/discovery/ load nothing of each
  other*): the snapshot is what a model is sent, the discovery read opens files the snapshot
  withholds, and the lists of where credentials live are one copy in `core/secrets/names.ts`. The rules read `.ts`,
  `.mts` and `.cts`, and fail on a folder that is not there and on an import that resolves
  to no file, rather than passing over nothing. Add a rule when you add a layer — and
  re-count this number when you do, because it is the one that drifts first:
  `pnpm vitest run tests/architecture --reporter=verbose`.
- **No test calls a model.** `tests/setup/offline.ts` makes `fetch`, `node:http`,
  `node:https`, `node:net`, `node:tls` and `WebSocket` throw, and `tests/setup/shell.ts`
  removes every `IDP_` variable but `IDP_TRACE_DIR` and every `*_API_KEY`, unless a scenario
  is being recorded (`IDP_RECORDING=record`, in `tests/scenarios/` only) — and
  `IDP_BACKSTAGE_URL` and `IDP_BACKSTAGE_TOKEN` even then, so no tape holds what a real
  catalogue serves: `backstage-mode.test.ts` names its own URL and reads the in-process fake.
  A child process opens its own sockets, so `tests/setup/forge.ts` owns every variable that
  could carry one to GitHub, a recording included: it removes the ssh and askpass variables,
  gh's tokens and hosts, `NO_PROXY` and Node's `NODE_USE_ENV_PROXY`, points the proxy
  variables at a closed port, moves `HOME` and `GH_CONFIG_DIR` into the run directory, and
  puts a `gh` and an `ssh` that fail first on `PATH`; a test reaches gh through the fake
  (`tests/support/fake-gh.ts`) and a push through a fake ssh serving a bare repository.
  A forgotten
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
  an answered round, and no tape recorded on 2026-10-02 refuses or redrafts after one, so
  it stales none and no longer waits for a re-record — and no scenario would show it either.
- **A submission ignores the repository's hooks** (ADR-0010): no `pre-commit`, no
  `reference-transaction`, no fsmonitor. A team relying on a hook reviews the branch in the
  pull request instead, where CI runs.
- **Declared is not provisioned.** A merged declaration can still be refused or fail
  downstream, and nothing detects it yet (ADR-0012, proposed). `idpa protection` prints the
  status checks merging waits for, and `init platform` advises one among the settings it
  prints; the reconciler that reports a failure after the merge arrives with the real
  integrations.
- **The push credential is not proven to be gh's account** (the stage 6 note's § 19, Q4;
  ADR-0015). The ruleset's `current_user_can_bypass` answers for gh's account, and git
  pushes with whatever key or helper the person configured: a deploy key or another
  account's key in the bypass list could move the base without a pull request; a deploy key
  idpa can see there is said in the note, and one it cannot see is not. `docs/submitting.md`
  recommends pushing as gh's account. A company's answer to the note's § 17 — its submitters
  pushing with other keys — would make it worth proving, through the person's ssh greeting
  or gh's credential helper, each of which reads or overrides what the person configured.
- **`init --submit` is not offered for a service in a subfolder of its repository** (D12):
  the forge cuts a branch at a clone's root, and the service's paths would need the
  folder's prefix. `init` without `--submit` previews one.
- **`docs/plans/stage-3-init-platform.md` still documents `init` as a tested refusal.**
  Stage 4 answered that refusal. The historical plan was left alone on purpose — a plan is
  a record of what was decided then — but it is not a description of the code now.
