# Security

The project's whole point is to change an infrastructure repository on someone's behalf,
so the threat model is stated here rather than left to be asked about.

**Where it stands: stage 4 of 7.** It reads, it asks a model, and it previews; it does not
yet write a branch or open a pull request. This file separates what is **guaranteed and
tested today** from what is **designed and not yet built**, and names what is **known to
be incomplete**. A guarantee that is not enforced by a test is not claimed here: each one
names the test that fails if it stops being true.

## What the tool does today

- **Reads a declarations repository** — Backstage `catalog-info` YAML in a Git
  repository — named by `--repo`, found where you stand, or configured with `IDP_REPO` or
  the personal `config.yml`; with none of those, the read commands read the fictional demo
  SI shipped in `fixtures/si-demo/`.
- **For a change, may read an application repository**: the Inspector reads the one
  `--project` names, or the directory you stand in when it is one (a `catalog-info.yaml`
  or a package manifest at its root). Anywhere else it reads nothing and says so.
- **Calls one model provider** — Anthropic, Mistral or OpenAI, the one `IDP_PROVIDER`
  names — over HTTPS, with your key, for `idpa "<phrase>"`, `ask`, `plan "<intent>"` and
  `init`. `graph`, `show`, `relations`, `validate`, `init platform` and `plan --from` call
  no model and read no key.
- **Exports a trace, only when asked**: to the MLflow server `IDP_MLFLOW_TRACKING_URI`
  names, or as a file in the directory `IDP_TRACE_DIR` names.
- **Writes nothing, except** the files `init platform` scaffolds into the directory it is
  handed, and a trace file when `IDP_TRACE_DIR` is set. (A contributor's
  `IDP_RECORDING=record` also writes a tape into `tests/recordings/`.)

## What leaves your machine

| to | when | what |
|---|---|---|
| the model provider | a model-backed command | your request; the agents' instructions; a summary of the declarations repository (kinds, types, environments, owners in use); the entities the agents' tools read from it; for a change or `init`, the files the Inspector reads from the application repository — only the files git tracks when it is a git repository, at most 200 files, 64 KiB each, 1 MiB in all, minus what `project-fs` withholds (below); and your key, in the header that provider reads it from |
| an MLflow server | `IDP_MLFLOW_TRACKING_URI` is set | one trace per model-backed run, holding the full prompts and answers above — never the key |

The endpoint is the SDK's default for that provider, unless `ANTHROPIC_BASE_URL` or
`OPENAI_BASE_URL` is set in your environment: the SDK reads those itself, and the key then
goes to the URL they name. [`.env.example`](.env.example) lists them with every variable
this tool reads. Retention is the provider's: this tool sends no retention option, so each
provider's default applies — on OpenAI's Responses API, that default is to store the
response.

## The threat model

**Prompt injection from a repository file.** Any file the Inspector reads, and any entity
the catalogue holds — a description, a name — reaches the model, and can tell it to do
something else. What an injection can reach is fixed at build time: the model fills a typed
`Plan`, never YAML and never a path; `Operation` is a closed union with no delete; every
value the model *chooses* must be traced to your words, to your answers or to the
repository, or it becomes a question; and five gates run before a diff is shown. An
injection can still steer a proposal toward values the request or the repository already
vouches for — an existing owner, an existing grant. It cannot make the tool propose an act
outside the union, choose a file, or hand out a level nobody answered for. The diff is
there to be read, and at stage 6 the merge will be the authorisation.

**A model inventing values.** The same signature is the defence: an owner, an environment,
a name segment or a type nobody can vouch for is asked, never guessed, and the level of a
grant is always asked. On the read side, an answer may name only what the engine's tools
returned (ADR-0007), and the model's sentences around it are checked the same way and
marked `›` (ADR-0008).

**Terminal escapes.** Text a model or a repository file wrote is printed with nothing a
terminal obeys: removed, or spelled out where the bytes are the point (a diff, `--json`).
A model's `{unknown}` reason carrying `ESC[2J` once cleared the screen and printed a fake
diff under the tool's own closing line. The cleaning is applied where each such text is
printed, not on the output stream as a whole, so what is guaranteed is what the tests
below cover.

**Secrets in an inspected repository.** `context/project-fs` decides what leaves an
application repository for the provider. In a git repository only the files git tracks are
candidates: an untracked `.env`, a local override or a build artefact is never opened, nor
named — the count of untracked paths is all the provider is sent. git is run with no shell,
with no `GIT_` variable, with `core.fsmonitor` off, and from the directory of the Node
binary, the repository named with `-C`: no command the repository's own configuration names
is executed, and no `git.exe` the repository ships is found first, as Windows would from
the working directory. A repository git cannot list — a broken index, a `core.worktree`
naming another directory, a `.git` file whose gitdir is gone, git missing beside a `.git` —
is read as nothing. A directory outside git is walked, and the CLI says so on stderr.
Either way, environment files, key material, credential folders, hidden files, binaries,
links out of the project and files over the caps are withheld, and so is any file whose
content holds key material, a token of a known issuer's shape, or a secret assigned a
literal value — every match in the file examined, a placeholder before a literal no
longer enough — withheld whole, never redacted. Each is listed as skipped by its class,
never by its value. The filter sees what it lists, and no more — see *Known to be
incomplete*. `init` refuses to inspect the home directory and the filesystem root, and a
change skips them unless `--project` names them.

**The key.** It is read from the provider's own variable, never from a repository or a
configuration file, and neither `.idp-agent.yml` nor the personal `config.yml` has a
field that could hold one. It reaches the provider in its header and nothing else.

**Traces.** A trace carries the full prompts: the summary, what the tools read from the
catalogue, and what the Inspector read from the application repository, with what
`project-fs` withholds still withheld and nothing further redacted. A tracking server is
therefore one more place your repositories' content goes; the compose file this project
ships (`tools/mlflow/compose.yml`) publishes it on `127.0.0.1` only. MLflow's own
`MLFLOW_TRACKING_URI` is never read: it is routinely exported for other tools, and
honouring it would send this tool's prompts there without anyone asking for a trace. Keep
`IDP_TRACE_DIR` outside the application repository, or in a hidden folder inside it:
`project-fs` skips hidden folders, and in a git repository every file git does not track, so
a trace kept anywhere else in a directory outside git is read back by the next run's
Inspector.

## Guaranteed today, with the test that enforces it

| Guarantee | Enforced by |
|---|---|
| Only `signPlan` makes a `SignedPlan`, and what it signed cannot be changed or re-aimed afterwards (ADR-0002) | `tests/unit/sign.test.ts` — *the brand*: *cannot be forged, even with every field in place*, *cannot be changed after it is minted…*, *cannot be aimed somewhere else after it is minted* |
| A value nobody can vouch for becomes a question, not a value | `tests/unit/sign.test.ts` — *turns an owner nobody can vouch for into a question, not a value* |
| The level of a grant is always asked, never read from the request's words | `tests/unit/sign.test.ts` — *asks even when the request names the level*; `tests/unit/plan-answered-level.test.ts` — *(c) asks the level of an English request too* |
| The model cannot request an unmodelled act, or aim at a file | `tests/unit/plan.test.ts` — *rejects an operation that is not modelled*; `tests/unit/proposal-schema.test.ts` — *has nowhere to carry an annotation, so the model cannot aim at a path*; `tests/unit/sign.test.ts` — *computes the path itself, whatever else the proposal says* |
| Five gates, in order — schema, signature, policy, Reviewer, re-check — and a clean stop after three attempts | `tests/unit/repair.test.ts` — *the five gates of §6.1*, *three attempts, then a clean stop* |
| An answer names only what a tool returned (ADR-0007) | `tests/unit/analyst.test.ts` — *refuses an answer naming a reference no tool returned, and names it* |
| The model's sentences around an answer are dropped whole when they name what nobody read, and marked `›` (ADR-0008) | `tests/unit/commentary.test.ts` — *drops a sentence naming an entity the graph holds and no tool returned*; `tests/unit/ask-commentary.test.ts` — *marks every line of the model with a sign no engine line starts with* |
| No computed path leaves the repository; a traversing name or annotation is refused, not sanitised | `tests/invariants/core.test.ts` — *every computed path stays inside the repository* (property-based); `tests/unit/entity-path.test.ts` — *refuses a traversal escape*, *refuses an annotation that traverses out of the repository* |
| The Inspector reads nothing outside the application repository, links included | `tests/unit/project-fs.test.ts` — *refuses a symlink pointing outside the project*, *an alias is not a disguise* |
| Environment files and key material are withheld from the model | `tests/unit/project-fs.test.ts` — *excludes every environment file, whatever its case or suffix*, *excludes key material by name, whatever the case*, *skips a private key hiding behind an innocent name* |
| In a git repository only tracked files are read: an untracked one is never opened nor named, a tracked link to one is refused, git runs no command the repository configures and no git the repository ships, and a repository git cannot list is read as nothing | `tests/unit/project-tracked.test.ts` — *reads the files git tracks and never an untracked one*, *refuses a tracked link to an untracked file*, *asks git about this repository, whatever GIT_DIR says*, *never runs a command the repository's own configuration names*, *reads nothing when git cannot list what the repository tracks*, *reads nothing when the repository names another directory as its work tree*, *reads nothing from a checkout whose .git file leads nowhere*, *with no git on the PATH* — *reads nothing beside a .git*, *never runs a git the inspected repository ships* |
| A file is withheld when any secret in it is a literal, every match examined; each listed key format and assignment syntax is recognised and its near miss is not; an ordinary manifest or source file is read; no rule is slow on a hostile 64 KiB line | `tests/unit/project-secrets.test.ts` — *every match is examined, not only the first (security-1)*, *the formats the deny list missed (security-2)*, *what a reviewer found read, and must be withheld*, *an ordinary manifest is not withheld (gap-init-real-repos-4)*, *ordinary source is not withheld for naming a secret*, *no rule is slow on a hostile line* |
| From a hostile repository, git or not, no secret-shaped string reaches the snapshot, the Inspector's opening message or any answer of `list_files` and `read_file` | `tests/unit/project-tracked.test.ts` — *what the Inspector is sent carries no secret* |
| The home directory and the filesystem root are never inspected unasked | `tests/unit/plan-project.test.ts` — *never inspects the home directory or the filesystem root unless --project names it*; `tests/unit/project-tracked.test.ts` — *refuses init in the home directory, before a model is chosen*, *refuses init at the filesystem root* |
| What a model or a repository file wrote reaches the terminal with nothing a terminal obeys, on `plan`, `relations`, `show`, `graph`, `validate` and `ask` | `tests/unit/plain.test.ts`; `tests/unit/plan-project.test.ts` — *what plan prints that a model or a file wrote*; `tests/unit/relations-command.test.ts` — *a hostile type, environment and name reach no terminal*; `tests/unit/read-commands-hostile.test.ts` — *… reaches no terminal with a byte it obeys*, one per command, and *ask: the overview it prints and the model sentences around it …* |
| A preview writes nothing: both repositories are byte for byte as they were | `tests/unit/plan-command.test.ts` — *leaves the repository byte-identical*; `tests/unit/plan-intent.test.ts` — *leaves the declarations repository byte-identical*, *leaves the application repository byte-identical too*; `pnpm smoke`, on the built binary |
| No module reachable from `agents/` touches the disk or the network; one module in `scaffold/` writes | `tests/architecture/dependencies.test.ts` — *no module reachable from agents/ touches the disk or the network*, *nothing in scaffold/ but write.ts imports a writing function* |
| `init platform` never overwrites and never deletes | `tests/unit/scaffold-write.test.ts` — *leaves a hand-edited file byte for byte*, *does not delete anything that was already there* |
| The key reaches its provider, in its header, and nothing else: no request body, no trace, no tracking server, no output — on each of the three providers, for a question and for a change | `tests/contract/key-reach.test.ts` — *the {anthropic, mistral, openai} key on a real run*: *reaches its provider in its header, and nothing else, on a question*, *… on a change* |
| A missing key is refused with exit 2, naming the variable, before any agent runs | `tests/unit/model-failures.test.ts` — *is refused for … with exit 2, naming …, before any agent runs*, one per provider |
| Nothing is traced unless this tool's variable asks; MLflow's own is ignored; a trace file is its owner's alone | `tests/unit/trace-wiring.test.ts` — *traces nothing, and says nothing about a trace, when none is configured*, *traces nothing when only MLflow’s own MLFLOW_TRACKING_URI is set*; `tests/unit/trace-sink.test.ts` — *writes a file only its owner can read* |
| A `Plan` is bounded — 50 operations, 32 levels, 10 000 nodes, 8 KB values, a 2 000-character intent — and a `__proto__` key is refused | `tests/unit/plan.test.ts` — *plan limits*, *refuses a __proto__ key outright, rather than dropping it quietly* |
| Every `fetch` in the suite throws, so no provider SDK call can leave it: recordings replay offline. (`node:http`, `node:net` and the like are not blocked; the adapters send through `fetch`, which is where `key-reach.test.ts` catches every request) | `tests/setup/offline.ts`, asserted by `tests/unit/offline.test.ts` — *refuses a network call from inside the suite* |

## What the architecture rules are, and are not

`tests/architecture/` walks **string-literal imports** across the transitive closure. That
catches the threat it names — a contributor who adds an import without noticing where it
lands — and it is not a sandbox. `globalThis.fetch`, `process.binding`, `eval` and
``import(`node:${name}`)`` need no import at all, and a specifier the rules do not list
passes. Read them as a build-time convention with teeth, never as a boundary that contains
hostile code in this repository. The boundary that does contain something is
`context/project-fs`, enforced at runtime.

## Known to be incomplete

Each is a finding of [the 2026-09-23 review](docs/reviews/2026-09-23-deep-review.md), still
open.

- **The secret filter of `project-fs` sees what it lists** (what review priority 7 left,
  closed by [#80](https://github.com/pcaboor/idp-agent/pull/80)). Read, and so sent: a password shorter than six characters;
  a literal under a key that does not name a secret (`DB_URL: <literal>` with no
  `user:password@` in it, `auth:` outside a docker `auths` object, a Secret's data under
  another `kind`); a token format `src/context/project-fs/secrets.ts` does not list; a
  value the filter takes for code — a type (`password: String`), a call, a member access,
  an identifier naming a secret (`password: hashedPassword`), a plain lowercase word after
  a spaced key (`--password letmein`); a syntax it does not parse — a YAML anchor's value,
  a value continued with `\` or folded over plain lines, a short flag glued to its value
  (`mysql -pX`), a heredoc, a concatenated string; and an encoding other than one base64
  layer or a `\u` escape, with only token shapes and key material looked for in a decoded
  run. Outside a git repository, files git would not track are read too, under the same
  rules. Keep literal secrets out of the files a service commits, as ever: the filter is a
  backstop, not a vault.
- **Confinement in the declarations repository is lexical** (security-8,
  runtime-probe-11). `iac-fs` follows a symbolic link to a file, wherever it points, and
  `init platform` writes through a linked folder. Both act on a repository you chose; the
  project-fs rules above do not apply there.
- **What the agents read from the declarations repository is sent as written.** Nothing
  there is filtered: it is the catalogue the question is about.

## Designed, not yet built

Claimed by `docs/design.md`, not by the code. Do not rely on them today.

- **The merge is the act of authorisation.** The CLI will open a merge request and never
  write to the main branch: writing a branch is stage 5, the merge request stage 6.
- **One token per capability.** The token that opens a merge request will not be able to
  merge it, and a test will assert that this action *fails* (stage 6).
- **Every anti-destruction check repeated engine-side, at the moment of writing**, against
  the repository as it is then (stage 5). Today the re-check runs at preview time.

## Not guaranteed, by design

- **Content proposed by the model may be wrong.** The signature says where a value came
  from, never whether it is right: an owner that exists and is the wrong team signs
  cleanly. Review decides; the tool exists to produce a reviewable change, not to be
  trusted unread.
- **The catalogue lags the repository** by about two minutes. The repository, not the
  catalogue, is the source of truth at write time.

## Reporting a vulnerability

Open a private security advisory through the repository's **Security** tab (*Report a
vulnerability*). Please do not open a public issue for something exploitable. There is no
deployed service; the surfaces worth a look are `context/project-fs` (what leaves an
application repository), `core/plan/` (the signature and the policies), `core/paths/` and
`cli/render/plain.ts`.
