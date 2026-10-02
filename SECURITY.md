# Security

The project's whole point is to change an infrastructure repository on someone's behalf,
so the threat model is stated here rather than left to be asked about.

**Where it stands: stage 6 of 7, on every road.** It reads, it asks a model, and
it previews; asked with `--submit`, it writes one new branch per submission, in the
repository named, and on a clone whose branch tracks one on github.com, `plan --from …
--submit`, `plan "<intent>" --submit`, `init --submit` and `idpa "<phrase>" --submit` push
that branch with your own git and open one pull request with your own gh. It holds no
GitHub credential. This file separates what is **guaranteed and tested today** from what is **not
guaranteed, by design**, and names what is **known to be incomplete**. A guarantee that is not enforced by a test is not claimed here: each one
names the test that fails if it stops being true.

## What the tool does today

- **Reads a declarations repository** — Backstage `catalog-info` YAML in a Git
  repository — named by `--repo`, found where you stand, or configured with `IDP_REPO` or
  the personal `config.yml`; with none of those, the read commands read the fictional demo
  SI shipped in `fixtures/si-demo/`.
- **Reads a Backstage catalogue, when you configure one** — `IDP_BACKSTAGE_URL`, or
  `backstage:` in the personal `config.yml`, with its token in `IDP_BACKSTAGE_TOKEN` — for
  `graph`, `show`, `relations`, `ask` and a question: once per run, before any model, whole
  or not at all. A change is still decided against the declarations repository, and nothing
  read from the catalogue reaches a plan's signature, policies, re-check or Reviewer. The
  URL comes from you alone: never from `.idp-agent.yml`, which travels with every clone, and
  never from the command line (`--backstage` takes no value).
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
  handed, a trace file when `IDP_TRACE_DIR` is set, and a Backstage catalogue read kept five
  minutes under `$XDG_CACHE_HOME/idp-agent/backstage` (else `~/.cache/…`), for your account
  alone ([The kept catalogue](#the-kept-catalogue)). (A contributor's
  `IDP_RECORDING=record` also writes a tape into `tests/recordings/`.) The named writers
  are `scaffold/write.ts`, `cli/recording-fs.ts`, `cli/trace-sink.ts` and
  `context/backstage/cache.ts`, through `confine/`; the fifth is the
  local forge, through git: one new branch per submission, cut in the repository named, and
  the objects it reaches — never the working tree, the index or `HEAD`. `plan … --submit`
  reaches it, worded by its route (D4): `plan "<intent>"` crosses all five gates, the
  Reviewer last; `plan --from` crosses four — the schema, the signature, the policies and
  the re-check — and **no Reviewer**, since no model drafted the plan. Either way its branch
  cannot reach the default branch. `init --submit` reaches it for the service's own
  repository: the catalog-info `init` previews and, when a person typed or answered it,
  `.idp-agent.yml` — never with a `backstage:`, never over a committed one. On a clone whose
  checked-out branch tracks one on github.com, `plan … --submit`, on either road,
  `idpa "<phrase>" --submit` on a change, and `init --submit`, in the service's own clone,
  then push that very branch, create-only, to
  the same name on GitHub with your own git, and open one pull request into the tracked
  branch with your own gh — once gh is logged in as a person, whatever the base's rules: where
  they let you merge it without another person's review, the run says so in one note, on
  stderr and in the pull request; `--local` keeps the branch in the clone. Every other road pushes nothing and opens no pull request; the merge is what
  authorises (ADR-0006).

## What leaves your machine

| to | when | what |
|---|---|---|
| the configured Backstage catalogue | a run that reads one (`IDP_BACKSTAGE_URL` or `backstage:`, and no `--repo`) | `IDP_BACKSTAGE_TOKEN`, in one `authorization` header when it is set; `GET` on `entities/by-query` and `entity-facets` under the configured base, with kind filters and paging parameters (`limit`, `cursor`, `fields`), and nothing else — no redirect is followed |
| the model provider | a model-backed command | your request; the agents' instructions; a summary of the source read — the declarations repository, or the catalogue (kinds, types, environments, owners in use; to the Supervisor and the Analyst, at most 30 of each list, the most frequent); the entities the agents' tools read from it — catalogue content included, for the Supervisor and the Analyst, never the Architect; for a change or `init`, the files the Inspector reads from the application repository — only the files git tracks when it is a git repository, at most 200 files, 64 KiB each, 1 MiB in all, minus what `project-fs` withholds (below); and your key, in the header that provider reads it from. Nothing gh or git printed, and nothing of GitHub — not the repository a submission goes to, not gh's login, not the base's commit — reaches a prompt: on `plan "<intent>" --submit`, `idpa "<phrase>" --submit` and `init --submit` the road, gh and the rules are read before the first model call — the Supervisor's, on a phrase — and the push and the pull request made after the last (`tests/unit/plan-intent.test.ts` — *sends every agent the bytes it sends without --submit: nothing of GitHub reaches a prompt*; `tests/unit/entry.test.ts` — *sends the Supervisor, and every agent after it, the bytes it sends without --submit*; `tests/contract/key-reach.test.ts` — *the {anthropic, mistral, openai} key, and the person's gh and git, on a submission to GitHub*) |
| the model provider, of people | a question over a source that holds an organisation — Groups, Users, Systems or Domains, read from a catalogue or from a declarations repository's files | what the Analyst's tools read of it (backstage-http slice 3, 3.3; the owner's decision, 2026-09-28): a Group's name, type, parent, children and members; a System's and a Domain's name, type, owner and parts; what each owns; and a **User's name and the groups it is a member of** — the summary counts them. Nothing else of a person: a User's profile (display name, email, picture) is never requested and is dropped on arrival, and its annotations and title are never requested and dropped by the reader. What a document writes where a reference goes and that is no `kind:namespace/name` — an email among a Group's members, an address as a System's owner — is never sent either: a tool result counts it and says it is not shown. A User's name can be an email in disguise: Backstage's Microsoft Graph provider names `ada.lovelace@acme.com` the User `ada.lovelace_acme.com`, and that name is sent as it is. Over a source that holds none, nothing of the kind is sent |
| github.com, through your own git | `plan --from … --submit`, `plan "<intent>" --submit` and `idpa "<phrase>" --submit` on a change in a clone whose branch tracks one on github.com, and `init --submit` in a service's clone that does, without `--local` | one commit (the files the diff shows, your git identity as author and committer, the request as recorded with the plan) under one new `idp-agent/…` branch, pushed with your credentials and your git configuration, never the clone's own. idpa itself opens no connection to GitHub |
| github.com, through your own gh | `idpa protection`; and `plan --from … --submit`, `plan "<intent>" --submit` and `idpa "<phrase>" --submit` in a clone whose branch tracks one on github.com, and `init --submit` in a service's clone that does, without `--local` | `GET` reads only, for `idpa protection`: who gh acts as (`GET user`), the repository, the rules for the base branch, each ruleset that supplies a required rule, and — only when none does — the branch. A submission reads the same, and the base's and the branch's refs, one commit and the pull requests from the branch, and makes one `POST` opening the pull request: its title, the commit's body, the request in a fenced block, and the engine's block. Before them, `gh --version` runs on your machine and sends nothing. idpa holds no GitHub credential: gh authenticates as it always does for you, idpa never reads its login, and your environment reaches gh unread, minus the variables that would point it at another host and every provider key and catalogue variable (`tests/contract/key-reach.test.ts`, *idpa protection*, *plan --from --submit, to GitHub* and *the {anthropic, mistral, openai} key, and the person's gh and git, on a submission to GitHub*). idpa itself opens no connection to GitHub |
| an MLflow server | `IDP_MLFLOW_TRACKING_URI` is set | one trace per model-backed run, holding the full prompts and answers above, catalogue content included, where a catalogue was read (`idp.source.*`) and, on a submission, where it went (`idp.forge.*`: the kind, and on a GitHub road the host, the repository, the base, the branch, the pull request's number, the outcome, how many gh calls, whether it pushed) — never gh's login, a GitHub credential or anything gh or git printed (`tests/contract/key-reach.test.ts` — *the {anthropic, mistral, openai} key, and the person's gh and git, on a submission to GitHub*, the pull request opened and the rules refusing, in prose and in `--json`), never the key or the catalogue token. A submission refused on the base before any model is a run's output too, and the trace keeps it as stdout printed it: the rules it lacks, naming gh's account and never its login; or the commit GitHub's base is at, beside the clone's; or the name GitHub answers for a renamed repository — two values GitHub answered, each held to its grammar (a commit id, `owner/name`) before it is printed, and each about the repository the trace already names, never about who submitted |

The endpoint is the SDK's default for that provider, unless `ANTHROPIC_BASE_URL` or
`OPENAI_BASE_URL` is set in your environment: the SDK reads those itself, and the key then
goes to the URL they name. [`.env.example`](.env.example) lists them with every variable
this tool reads. Retention is otherwise the provider's: every call to OpenAI's Responses API
says `store: false`, where the default is to store the response (held by
`tests/contract/providers.test.ts`); Anthropic and Mistral are sent no retention option, and
their defaults apply.

## The kept catalogue

A catalogue read is kept on your disk for five minutes, so a second run within them answers
without asking Backstage and says so: `read from cache, 3 min old; --refresh reads Backstage
again` (ADR-0014). It is company data at rest.

**What it holds.** What the token read: Components, Resources and APIs as served —
descriptions, links, annotations, relations — the organisation's names, types and
memberships, and other kinds' references. Never a token, nor anything derived from one
without this machine's secret; never a User's profile, a User's or a Group's annotation, or
an API's definition text.

**Who can read it.** Your account, and the machine's administrators. Folders are `0700` and
files `0600`, owned by the running account, and each name is checked for its owner, mode, type
and links before every read and write; a store that fails the check is not used that run, and
one line says which path and why. It is never repaired, `chmod`-ed or removed: a tree under
the cache folder owned by another account — one a `sudo` run of another tool made, say — is
refused, and removed by that account (`sudo rm -rf ~/.cache/idp-agent` when root made it). A
run as root keeps and reads nothing. Anything that copies your home copies it too — a backup
(Time Machine does not exclude `~/.cache`), a sync tool, a disk image: `XDG_CACHE_HOME` puts it
elsewhere, and `IDP_BACKSTAGE_CACHE=off` keeps nothing (`off` is its one value; any other is
refused). There is none on Windows.

**What it can and cannot be made to say.** A copy is keyed by an HMAC of the catalogue's base,
the token and the read's shape under a per-machine secret, and sealed by a MAC over its
format, its key, its header and every byte of its body: a flipped byte, a changed date, or a
copy moved into another key's folder does not verify, is said, and is replaced. A copy that
verifies is read again through the load's checks, the pre-pass and the reader, as a page is,
and is no more than a hostile Backstage could serve. Your own account, or root, is beyond any
check a file can make — it can read the secret too. What `confine/` cannot close for a
repository it cannot close here either ([Known to be incomplete](#known-to-be-incomplete)).

**The clock.** Its age is read from this machine's wall clock. A copy dated after now is never
answered from without `--cached`; a clock moved forward makes copies look older, and
Backstage is read again; a clock moved back by less than a copy's age makes it look younger by
as much, which nothing can detect.

**A revoked token keeps answering from its copy.** A run inside the five minutes answers from
its fresh copy without asking Backstage, so a token revoked two minutes ago answers for up to
five more with no 401 to see — and from any copy, whatever its age, with `--cached`, since the
copy is on your machine. `--refresh` is what proves a token still reads. A failed read is
never answered from a copy; after a failure of reach the failure line names `--cached`, and
after a 401 or a 403 it never does. A new token is a new key, which never reads the old copy.
A copy older than seven days is removed by the next run that keeps a read; until one does, it
stays on disk, and `rm -rf ~/.cache/idp-agent` (under `$XDG_CACHE_HOME` when it is set) removes
them all.

**Nothing kept reaches a plan.** Only the provider loads the store, the provider is built for
the read road alone, and a change is decided against the declarations repository.

## The threat model

**Prompt injection from a repository file.** Any file the Inspector reads, and any entity
the catalogue holds — a description, a name — reaches the model, and can tell it to do
something else. A Backstage catalogue widens that to every team's unreviewed
`catalog-info`, not the one reviewed declarations repository: its content is untrusted as a
file's is, and is printed through the same cleaning. It cannot cause a request — the load is
over before a model is called, and no model output becomes one — and it never reaches the
Architect, the gates or the Reviewer. What an injection can reach is fixed at build time: the model fills a typed
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

**The catalogue token.** It is read from `IDP_BACKSTAGE_TOKEN` alone, is required for any
host but this machine, and is sent from one function (`context/backstage/transport.ts`) to
the configured origin on the two GET routes, with `redirect: 'error'`. A refusal of the
configured URL quotes it with userinfo, query and fragment starred, and a value that does
not parse, or holds a space or a control character a URL parser would drop, by its length
alone — a token put where the URL goes is never printed. A failure
names the host, the status and a class, never what the server wrote. A test cannot prove
the token is read-only; it proves what this tool does with it. Once a company token is
exported, it is also sent, over plain http, to a catalogue on this machine
(`http://127.0.0.1:…`): unset it (`env -u IDP_BACKSTAGE_TOKEN`) for the demo's fake.

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
| Five gates, in order — schema, signature, policy, re-check, Reviewer — and a clean stop after three attempts | `tests/unit/repair.test.ts` — *the five gates of §6.1*, *three attempts, then a clean stop* |
| Of a person, a model is sent a User's name and its groups and nothing else: no `@`, no directory id, no picture reaches a request, from a User served whole by a catalogue that ignores `fields`, nor from an email written where a reference goes, from a catalogue or from files | `tests/unit/organisation-analyst.test.ts` — *sends no @, no directory id and no picture: a User served whole with microsoft.com/email and a profile*, *sends no @ written where a reference goes: a Group’s members and children, a System’s owner and domain, from a catalogue and from files*; `tests/unit/backstage-provider.test.ts` — *reads a User served whole by a server that ignores fields, and keeps no email, no directory id and no picture* |
| An answer names only what a tool returned (ADR-0007) | `tests/unit/analyst.test.ts` — *refuses an answer naming a reference no tool returned, and names it* |
| The model's sentences around an answer are dropped whole when they name what nobody read, and marked `›` (ADR-0008) | `tests/unit/commentary.test.ts` — *drops a sentence naming an entity the graph holds and no tool returned*; `tests/unit/ask-commentary.test.ts` — *marks every line of the model with a sign no engine line starts with* |
| No computed path leaves the repository; a traversing name or annotation is refused, not sanitised | `tests/invariants/core.test.ts` — *every computed path stays inside the repository* (property-based); `tests/unit/entity-path.test.ts` — *refuses a traversal escape*, *refuses an annotation that traverses out of the repository* |
| The Inspector reads nothing outside the application repository, links included | `tests/unit/project-fs.test.ts` — *refuses a symlink pointing outside the project*, *an alias is not a disguise* |
| Nothing is read through a symbolic link in the declarations repository, inside it or out: every link the walk meets is named — a linked `.yml` as a file not read, any other as a link not followed, an error to `validate` — and `plan` refuses a repository holding a linked file, naming it, before a preview; a file or a folder swapped for a link after the walk, leading outside the repository or to another folder inside it, is refused at the open | `tests/unit/iac-fs.test.ts` — *names a file linked outside, and never reads what it leads to*, *names a file linked inside the repository too, and reads it once, where it is*, *names a folder linked outside, rather than dropping it in silence, and walks nothing in it*, *names a folder linked inside the repository, and walks it once, where it is*, *names a link at the root, whatever it is called*; `tests/unit/plan-command.test.ts` — *refuses a file that is a symbolic link, naming it, and reads nothing through it*; `tests/unit/confine.test.ts` — *refuses a file swapped for a link after it was decided on*, *refuses a file whose folder was swapped for a link outside after it was decided on*, *refuses a file whose folder was swapped for a link inside the root after it was decided on*; `tests/unit/iac-fs.test.ts` — *says a link is a link, never a folder it could not list, whatever the link names* |
| Environment files and key material are withheld from the model | `tests/unit/project-fs.test.ts` — *excludes every environment file, whatever its case or suffix*, *excludes key material by name, whatever the case*, *skips a private key hiding behind an innocent name* |
| In a git repository only tracked files are read: an untracked one is never opened nor named, a tracked link to one is refused, git runs no command the repository configures and no git the repository ships, and a repository git cannot list is read as nothing | `tests/unit/project-tracked.test.ts` — *reads the files git tracks and never an untracked one*, *refuses a tracked link to an untracked file*, *asks git about this repository, whatever GIT_DIR says*, *never runs a command the repository's own configuration names*, *reads nothing when git cannot list what the repository tracks*, *reads nothing when the repository names another directory as its work tree*, *reads nothing from a checkout whose .git file leads nowhere*, *with no git on the PATH* — *reads nothing beside a .git*, *never runs a git the inspected repository ships* |
| A file is withheld when any secret in it is a literal, every match examined; each listed key format and assignment syntax is recognised and its near miss is not; an ordinary manifest or source file is read; no rule is slow on a hostile 64 KiB line | `tests/unit/project-secrets.test.ts` — *every match is examined, not only the first (security-1)*, *the formats the deny list missed (security-2)*, *what a reviewer found read, and must be withheld*, *an ordinary manifest is not withheld (gap-init-real-repos-4)*, *ordinary source is not withheld for naming a secret*, *no rule is slow on a hostile line* |
| From a hostile repository, git or not, no secret-shaped string reaches the snapshot, the Inspector's opening message or any answer of `list_files` and `read_file` | `tests/unit/project-tracked.test.ts` — *what the Inspector is sent carries no secret* |
| The home directory and the filesystem root are never inspected unasked | `tests/unit/plan-project.test.ts` — *never inspects the home directory or the filesystem root unless --project names it*; `tests/unit/project-tracked.test.ts` — *refuses init in the home directory, before a model is chosen*, *refuses init at the filesystem root* |
| What a model or a repository file wrote reaches the terminal with nothing a terminal obeys, on `plan`, `relations`, `show`, `graph`, `validate` and `ask` | `tests/unit/plain.test.ts`; `tests/unit/plan-project.test.ts` — *what plan prints that a model or a file wrote*; `tests/unit/relations-command.test.ts` — *a hostile type, environment and name reach no terminal*; `tests/unit/read-commands-hostile.test.ts` — *… reaches no terminal with a byte it obeys*, one per command, and *ask: the overview it prints and the model sentences around it …* |
| A preview writes nothing: both repositories are byte for byte as they were, `.git/` of a clone included | `tests/unit/plan-command.test.ts` — *leaves the repository byte-identical*, *still writes nothing — .git included — without --submit*; `tests/unit/plan-intent.test.ts` — *leaves the declarations repository byte-identical*, *leaves the application repository byte-identical too*; `pnpm smoke`, on the built binary |
| No module reachable from `agents/` touches the disk or the network, reaches `context/backstage/` or names `fetch`; nothing in `context/` names `fetch`; only named modules write, and two start a process — `process/git.ts`, the launcher the Inspector and the forge share, which only `context/project-fs` and `forge/` load, and `process/gh.ts`, gh's, which only `forge/github/` loads and no command starts yet — each running only the command shapes of its grammar, checked on the finished vector before anything starts; no source names a door those grammars refuse, or reads a GitHub credential from the environment, and in `tests/` only `tests/live/` and `tests/support/fake-gh.ts` name a door; `confine/`, the primitive a repository is read and written through, imports only `node:` built-ins and only `scaffold/write.ts`, `context/iac-fs`, `context/project-fs` and `context/backstage/cache.ts` load it; only `context/backstage/provider.ts` loads that cache; nothing reachable from `core/` reads or writes; only `cli/` reaches `forge/` at run time, however many hops away, and `forge/` imports no package and no built-in that reads, writes or opens a socket | `tests/architecture/dependencies.test.ts` — *no module reachable from agents/ touches the disk or the network*, *nothing reachable from agents/ is in context/backstage/, names fetch or names a global*, *nothing in context/ names fetch or a global, and only the transport calls what it is handed*, *nothing in scaffold/ but write.ts imports a writing function*, *only the named modules write, and only process/git.ts and process/gh.ts start a process*, *nothing in src/ names a door the allow-list refuses*, *nothing in src/ reads a GitHub credential from the environment*, *in tests/, only tests/live/ and tests/support/fake-gh.ts name a door*, *only the named modules of cli/ touch the disk*, *core/ neither reads nor writes, however many hops away*, *process/ imports nothing of ours, and only node: built-ins*, *confine/ imports nothing of ours, and only node: built-ins*, *only scaffold/write.ts, context/iac-fs, context/project-fs and context/backstage/cache.ts load confine/*, *only context/backstage/provider.ts loads context/backstage/cache.ts*, *forge/ imports core/, process/, node:crypto and node:path, and nothing else*, *only context/project-fs and forge/ load the git launcher*, *only forge/github/ loads the gh launcher*, *only cli/ reaches forge/ at runtime*; the rules fail on a missing folder or an unresolved import — *the architecture rules themselves* |
| No child process is handed a provider key or the Backstage token: `git`, started by the launcher `process/git.ts` for the Inspector and the forge alike, runs — and so does whatever git runs — without any `*_API_KEY`, without `IDP_BACKSTAGE_TOKEN` or any other `IDP_BACKSTAGE_*` variable, and without any `GIT_*` variable but, on the one push form, the person's `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT` and `GIT_ASKPASS`; with hooks and fsmonitor off, never guessing a committer identity, from outside the repository, and bounded in time and output. `gh`, started by the second launcher `process/gh.ts`, which no command starts yet, runs the same way, without any `GIT_*`, `GH_HOST`, `GH_REPO`, gh's or Go's debugging, forced terminal formatting or an Enterprise token, and with its prompts, update notices and colours off; its own login (`GH_TOKEN`, `GITHUB_TOKEN`) passes to it unread. Each launcher runs only the command shapes of its grammar, and refuses anything else before a process starts | `tests/unit/spawned-environment.test.ts` — *is what git runs in when the Inspector reads a directory*, *drops the Backstage token and every provider key, and keeps the rest*, *drops every IDP_BACKSTAGE_ variable: a swapped pair puts the token in the URL one*; `tests/unit/process-git.test.ts` — *hands git, and whatever git runs, no provider key, no catalogue variable and no identity*, *does not run the repository's hooks*, *does not run the fsmonitor the repository's configuration names*, *never runs a git planted in the repository*, *never lets git guess who is committing*, *cannot be redirected to another repository by an inherited GIT_DIR*, *stops a call past its output bound, and reads nothing of it*, *stops a call past its time bound, and says so*, *hands the push its four variables, and every call none*, *admits every vector stage 5 builds, and nothing else*, *pushes the one form, and only it*; `tests/unit/process-gh.test.ts` — *hands gh § 5's environment*, *starts gh by name, from the neutral directory, with the grammar's vector*, *names what failed, and never gh's words*; `tests/unit/launcher-doors.test.ts` — one case per door, and *the launchers start nothing for a hostile value*; `tests/architecture/dependencies.test.ts` — *every process src/ starts is given spawnedEnvironment* |
| A submission creates one new ref under `refs/heads/idp-agent/` and moves none, `main` included: every other ref, `HEAD`, the index and the working tree are as they were; the same bytes on the same base name the same branch, recognised and not written twice; a change that changes nothing cuts no branch; a symbolic ref at the branch name is refused, and the one write never follows one | `tests/unit/local-forge.test.ts` — *cuts one branch from HEAD, and nothing else a person can observe moves*, *submitting the same bytes twice is submitting them once*, *refuses when the branch exists and carries something else*, *cuts no branch for a change that changes nothing*, *never follows a symbolic ref planted at the branch name*, *never writes outside idp-agent/ when a symbolic ref appears between the check and the write* |
| A failed submission leaves the observable state — every ref, `HEAD`, the index, the working tree — as it found it, or the whole branch, never part of one; a branch somebody else creates meanwhile is never moved nor claimed | `tests/invariants/forge.test.ts` — *a submission failing at any git call leaves the initial state, or the complete branch* (every call, before it runs and after), *a branch a stranger creates at any moment of a submission is never moved, nor claimed*; `tests/unit/local-forge.test.ts` — *refuses a stranger who creates the branch between the check and the write*, *calls its own branch created when git fails after making it* |
| The forge takes only a value `clear.ts` minted — never a spread, a cast or a clone of one (D3) — and only for the repository it was opened on | `tests/unit/local-forge.test.ts` — *cannot be aimed at main, even by a cast that ignores the brand*, *refuses a clearance for the other repository, before anything else — both ways* |
| A branch that exists is this submission only when it is one commit, on the base, touching exactly its paths with its bytes and modes, under the message the engine wrote (D18): the same files on another parent (D7), as a merge whose first parent is the base, with one more file, made executable, or under somebody else's message are refused, never reported as submitted | `tests/unit/local-forge.test.ts` — *refuses our files on a parent that is not the base*, *refuses our tree as a merge whose first parent is the base*, *does not mistake a squatted branch for its own, however right its files look*, *does not call its own a branch holding its bytes as executables*, *does not vouch for a message it did not write* |
| Bytes the gates did not judge are never submitted: at the moment of writing the base is re-read, and every file the gates read must be in `HEAD` byte for byte — a file uncommitted, untracked or ignored, a path the gates read as absent that `HEAD` now holds, a catalogue file `HEAD` holds and the gates never read, a symbolic link (which the preview no longer reads through either, D17), a `HEAD` that moved or became detached is refused, by name | `tests/unit/local-forge.test.ts` — *refuses when the working tree is not what HEAD holds, naming the file*, *names a tracked file changed in the working tree and not committed*, *names a catalogue file git ignores, which the gates read and HEAD does not hold*, *names a catalogue file HEAD holds and the gates never read*, *refuses a path the gates read as absent that HEAD now holds*, *never carries a linked file into a submitted blob*, *refuses when HEAD moved between reading and writing*, *refuses — never an argument error — when HEAD is detached during the run*; `tests/unit/plan-intent.test.ts` — *refuses, and cuts nothing, when main moves while the person answers*, *answers exit 1, not 2, and cuts nothing, when HEAD is detached while the person answers* |
| A directory inside another repository, a detached or unborn `HEAD`, no `git` and no author or committer identity are refused when the forge opens — git never guesses who commits (D13) | `tests/unit/local-forge.test.ts` — *refuses a directory inside someone else's repository*, *refuses a detached HEAD, which no merge request could target*, *refuses an unborn HEAD, which has no commit to cut from*, *says git is missing, as an argument error, when there is no git to run*, *says there is no committer identity before anything is read*, *says there is no author identity when only the committer is configured*; `tests/unit/process-git.test.ts` — *never lets git guess who is committing* |
| `plan --from … --submit` submits only the diff it printed, after the four gates and the confirmation: a declined or interrupted prompt, an open question, a gate's refusal, a plan writing into both repositories (D6) and a change that changes nothing cut no branch, and a catalogue differing from `HEAD` is refused before any preview, naming the files | `tests/unit/plan-command.test.ts` — *cuts one branch holding exactly the diff it printed, and leaves main alone*, *declined at the prompt: exit 0, not submitted, nothing written*, *interrupted at the prompt: exit 130, nothing written*, *submits nothing while a question is open and nobody can answer it*, *refuses a plan writing into both repositories, pointing at init --submit (D6)*, *answers a plan that changes nothing with #83’s exit 3, and asks no forge*, *refuses a repository whose working tree is not HEAD, before previewing*, *refuses at the moment of writing when the base moved after the preview*, *answers a git that fails mid-write with exit 1, and leaves what a person sees*; `pnpm smoke`, on the built binary |
| `plan "<intent>" --submit` submits only after all five gates, the Reviewer last, and refuses a repository that cannot take the branch before any model is called: not a clone's root, no committer identity or a detached `HEAD` before the model is even configured (exit 2), and a catalogue differing from `HEAD` once a model is configured, before the Inspector (exit 1, in `--json` too, under `submission` alone) | `tests/unit/plan-intent.test.ts` — *cuts the branch the same plan cuts by --from, after all five gates*, *cuts no branch when the Reviewer refuses: the submission comes after it*, *refuses a repository that cannot take a branch as an argument, before a single model call*, *refuses a divergent repository before a single model call*, *refuses a divergent repository in --json with only the submission key, and no model call (D11)*, *refuses a --repo that cannot take a branch before the model is configured, and calls none*, *leaves the application repository byte-identical while submitting* |
| `idpa "<phrase>" --submit` submits a change as `plan "<intent>" --submit` does, and refuses before any model what it refuses: with no declarations repository, a gh logged out — before a catalogue is requested and before the model is configured (exit 2) — and a repository gh's account cannot push to, before the Supervisor (exit 1); rules that let the author merge alone are said in a note before the Supervisor, and the pull request is opened; a question is refused after the Supervisor's one word, exit 3 in prose and in `--json`, the Analyst never called and nothing written; `--submit --demo` is refused at parse time, and the demo SI is never written | `tests/unit/entry.test.ts`, *idpa "<phrase>" --submit* — *submits a change as plan "<intent>" --submit does, the forge, gh and the rules read before the Supervisor*, *refuses a question after the Supervisor’s one word, exit 3 with …: the Analyst is never called, nothing is written*, *says the note before the Supervisor, and opens the pull request where the author may merge alone*, *still refuses a question put to --submit where the author may merge alone, exit 3, the note said before the Supervisor’s word*, *refuses gh logged out before the model is configured and before a catalogue is requested, exit 2*, *refuses --submit with no declarations repository anywhere, before any model, naming every way to name one*, *cuts only the local branch with --local, and starts no gh*, *refuses a service whose iacRepo names another repository, as plan "<intent>" does*; `tests/unit/cli-args.test.ts` — *is refused on a phrase with --demo, and --local is refused without it* |
| A branch already there is answered before anyone is asked to confirm, by a look that writes no object and no ref: this very submission is named, exit 0, with no `[y/N]`; somebody else's branch of that name is refused, exit 1, with none either — on `plan --from`, `plan "<intent>"` and `init`; `submit` looks again at the moment of writing | `tests/unit/local-forge.test.ts` — *finds nothing where nothing was submitted, and writes nothing to say so*, *names its own branch, by the test submit() uses, with no object and no ref written*, *refuses a branch of that name that is someone else's, writing nothing*; `tests/unit/plan-command.test.ts` — *answers a second submission before the confirmation: the level asked, no [y/N], nothing written*, *refuses a branch of that name that is someone else's before the confirmation*; `tests/unit/plan-intent.test.ts` and `tests/unit/init-command.test.ts` — *answers a second submission before the confirmation, and writes nothing* |
| `init --submit` cuts one branch in the service's own repository holding the catalog-info it previews, filed where the preview files it, and `.idp-agent.yml` only from `--iac-repo` and `--environment` or a person's answers — never from the inspection, never with a `backstage:`; a committed configuration that says otherwise is refused, one equal in value is left alone; a flag or an answer the schema refuses, or holding a control, format or bidi character, a question nobody can answer, a service in a subfolder of its repository (D12) and a working tree differing from `HEAD` on the files `init` decides on are all refused before any model call; without `--submit` or a flag, it prints what stage 4 printed and writes nothing. Where the service's checked-out branch tracks one on github.com, the branch is pushed and a pull request opened on the service's own repository, once that repository passes the same configuration check and the same preflight as the declarations repository, both before the Inspector: a repository gh's account cannot push to, archived or answering under another name, or not level with GitHub, is refused (exit 1, `--local` named on the first), and rules that let the author merge alone are said in a note, the pull request opened all the same, a clone configured to redirect the push and a gh missing, logged out or not a person (exit 2) before the model is configured; D12 is refused before gh starts, and `iacRepo` names the declarations repository, another, so it is not held to the clone | `tests/unit/init-command.test.ts` — *init --submit*: *cuts one branch in the application repository holding the catalog-info and the configuration*, *files in the root catalog-info.yml the service keeps, as the preview does*, *writes the configuration readConfig reads back*, *never rewrites a committed configuration that says something else, and says so before a model call*, *leaves a committed configuration alone when the flags say the same, however it is written*, *refuses flags the schema refuses before a single model call*, *refuses an answer holding a bidi control, as a refused answer, before a model call*, *asks for what the flags did not say, and exits 3, before a model call, when nobody can answer*, *refuses a working tree that is not HEAD before a single model call*, *refuses a service in a subfolder of its repository, not submitted by this build, before a model call*, *prints what it prints today without --submit or a flag, APPLY included*, *says the configuration a flag asked for is not written when the service is already declared*; *init --submit through main* — *refuses an --environment holding a bidi control, naming the flag, exit 2, with no model call*; *init --submit to GitHub* — *opens a pull request on the service’s own repository, holding the catalog-info and the configuration*, *names the open pull request on a second run, not asked, and writes nothing*, *says the note before the Inspector, and opens the service’s pull request*, *refuses a service repository gh’s account cannot push to, before the Inspector, naming --local*, *refuses a service clone that is not level with GitHub, exit 1, before the Inspector*, *refuses gh logged out, exit 2, before the model is configured, and --local cuts the branch in the clone only*, *refuses a key of the service clone’s own configuration, exit 2, naming it and its scope, never its value*, *still refuses a service in a subfolder of its repository (D12), exit 2, before gh is started*; `tests/contract/key-reach.test.ts` — *reaches its provider in its header, and nothing of GitHub reaches it, on init --submit* |
| `.idp-agent.yml` never carries a credential: `iacRepo` refuses userinfo, a query or a fragment — where a clone URL copied from `git remote -v` keeps its token — in the one schema the flag, the answer, the reader and `clearService` all parse through, and the refusal never quotes the value; `--iac-repo` typed twice is refused rather than one kept in silence | `tests/unit/cli-args.test.ts` — *refuses a locator that carries a credential, naming the flag and never the secret*, *refuses --iac-repo typed twice, rather than keeping the last one in silence*; `tests/unit/init-command.test.ts` — *refuses a locator answer that carries a credential, never quoting it, before a model call*; `tests/unit/clear-service.test.ts` — *refuses a locator carrying a credential at the moment of acting, never quoting it*; `tests/unit/config.test.ts` — *refuses a committed locator that carries a credential, naming the field and not the token* |
| A submission runs none of the repository's hooks | `tests/unit/local-forge.test.ts` — *runs none of the repository's hooks while it writes*; `tests/unit/process-git.test.ts` — *does not run the repository's hooks* |
| `init platform` never overwrites and never deletes, and writes through no symbolic link under the directory it was named — a folder linked outside, inside, deeper down or to nothing is refused by name, and a link where a file goes is kept, never followed | `tests/unit/scaffold-write.test.ts` — *leaves a hand-edited file byte for byte*, *does not delete anything that was already there*, *never writes through a folder linked outside the root*, *never writes through a folder linked inside the root either*, *never writes through a linked folder deeper down*, *never creates the folder a dangling link names*, *keeps a file that is a link, and writes nothing through it*, *keeps a dangling link where a file goes, and creates nothing at its target*; `tests/unit/confine.test.ts` — *refuses a folder swapped for a link after it was checked, before a byte is written*, *refuses a folder swapped for a link inside the root after it was checked, before a byte is written*, *refuses a folder swapped for a link {outside, inside} between two names, and leaves at most the one folder made in that instant*, *keeps a link planted where the file goes after the folders were checked, and follows it nowhere* |
| The key reaches its provider, in its header, and nothing else: no request body, no trace, no tracking server, no output — on each of the three providers, for a question and for a change | `tests/contract/key-reach.test.ts` — *the {anthropic, mistral, openai} key on a real run*: *reaches its provider in its header, and nothing else, on a question*, *… on a change* |
| A missing key is refused with exit 2, naming the variable, before any agent runs | `tests/unit/model-failures.test.ts` — *is refused for … with exit 2, naming …, before any agent runs*, one per provider |
| Nothing is traced unless this tool's variable asks; MLflow's own is ignored; a trace file is its owner's alone | `tests/unit/trace-wiring.test.ts` — *traces nothing, and says nothing about a trace, when none is configured*, *traces nothing when only MLflow’s own MLFLOW_TRACKING_URI is set*; `tests/unit/trace-sink.test.ts` — *writes a file only its owner can read* |
| A `Plan` is bounded — 50 operations, 32 levels, 10 000 nodes, 8 KB values, a 2 000-character intent — and a `__proto__` key is refused | `tests/unit/plan.test.ts` — *plan limits*, *refuses a __proto__ key outright, rather than dropping it quietly* |
| The catalogue token reaches the configured catalogue, on its two GET routes, in one header, with `redirect: 'error'`, and nothing else: no model provider, no tracking server, no child process, no output, no trace — on each of the three providers, for a question and for a change, and when the catalogue answers 401, 403, 500 or echoes the request; no model key reaches the catalogue; catalogue content reaches the Supervisor and the Analyst and never the Architect | `tests/contract/key-reach.test.ts` — *the {anthropic, mistral, openai} key and the catalogue token on a real run*: *reaches the catalogue only, in one header, on a question and on a change*, *puts the token nowhere when the catalogue answers …* |
| The transport sends only `GET` on its two routes, to the configured origin and path, checked once the URL is built; follows no redirect and refuses a 3xx, a response marked redirected or from another address; bounds every body and request; and never quotes a response, a header or the token | `tests/unit/backstage-transport.test.ts` — *sends GET to the base and route, the token in one header, and redirect: error*, *checks the URL it built, origin and pathname, whatever base it is given*, *throws before any request for a method or a route outside the list*, *refuses a response whose url is on another origin, or another path, …*, *refuses a response marked redirected, even from the same address*, *refuses a body over the bound while it streams, and stops reading it* |
| A catalogue URL that could aim the token elsewhere — not https: (http: only to this machine), userinfo, a query, a fragment, a space or a control character, a `\`, no path, an empty, `.` or `..` segment, encoded or not — is refused with exit 2 before any request, quoting no secret; a host not on this machine is never read without a token, and a token a header cannot carry is refused the same way, quoting none of it; `.idp-agent.yml`'s `backstage:` is never requested, on the change road that reads the file | `tests/unit/backstage-source.test.ts` — *refuses … with 2, naming IDP_BACKSTAGE_URL, before any request, quoting no secret*, one per case, *quotes no secret from config.yml behind …*, *refuses a token unset/empty for a host that is not this machine …*, *refuses a token holding … with 2, before any request, quoting none of it*, *never reads backstage: in .idp-agent.yml …* |
| A catalogue read whole, or up to a stated bound and answered as partial — every answer saying so, a reference past the bound `not loaded` and never declared nowhere; every failure one line and exit 1, never a fall back; a change is decided against the declarations repository, and an owner only the catalogue holds is asked | `tests/unit/backstage-read.test.ts` — *… one classified line, exit 1, nothing on stdout*, *is decided against the configured repo, never the catalogue it was classified from*, *lets nothing in the catalogue vouch …*; `tests/unit/backstage-partial.test.ts` — *what a person reads of a catalogue past a bound*, *what a model is sent about a catalogue past a bound* |
| A kept catalogue is opened only by its account, never through a link, and read again through the reader: a copy that does not verify is not used, and a store open to others is refused and never repaired | `tests/unit/backstage-cache.test.ts` — *refuses the store when backstage/ or idp-agent/ is a link, and never reads or writes the folder it leads to*, *refuses a copy that is a link, for a read and a write: the link kept, its target untouched, no temporary file left*, *refuses a copy moved into another key’s folder: the MAC covers the key*; `tests/unit/backstage-provider-cache.test.ts` — *runs the pre-pass and the reader on a copy …*; `tests/unit/backstage-cache-read.test.ts` — *says a store others may open was not used, and changes nothing* |
| Nothing kept reaches a plan, and no token is at rest: a kept owner is still asked, and no name or byte under the cache root holds the token, its sha256 or its base64 | `tests/unit/backstage-read.test.ts` — *lets nothing kept vouch either: an owner only the kept copy holds is asked, exit 3, nothing sent*; `tests/contract/key-reach.test.ts` — *reaches the catalogue only, in one header, on a question and on a change*, *keys a copy by the token under the secret …* |
| What a catalogue serves reaches the terminal with nothing a terminal obeys, and no grouped line past its bound | `tests/unit/read-commands-hostile.test.ts` — *what a catalogue served, as the read commands print it*, *holds each grouped line to the bounds catalogue-read.ts states …* |
| idpa never merges and never writes to the base: it opens a pull request, and the base's rules decide who may merge it. Whether its author may merge it alone is the company's rule, not this tool's; where the rules allow it, idpa says so — `note: on this repository the author may merge without another person's review` — on stderr and in the pull request, and the pull request is opened all the same. Where the rules require someone else's approval of the exact commit that would merge, the identity that opens the pull request cannot merge it: the base's rules and each supplying ruleset's `current_user_can_bypass` are read through your gh before anything is written, and again at the moment of acting and before the pull request is opened — as long as the ruleset stands and binds every credential you push with (below) | `tests/unit/merge-refused.test.ts` — *refuses every door to the identity that opened the pull request, and leaves it open and main where it was*, *refuses the author's merge after a push on top of an approved head, and lets it through once someone else approves the new head*, *counts neither the author's own approval nor the last pusher's*, *opens the pull request with the note wherever the rules let its author merge it alone, and the author can merge it*, *notes a deploy key it can see in the bypass list, and opens the pull request*; `tests/invariants/github-forge.test.ts` — *opens the pull request on every shape of rules, and says the note exactly when judgeProtection does not hold*, *refuses the push itself on every item-1 kind, and writes nothing on either side*; `tests/unit/github-forge.test.ts` — *reads the rules again at the moment of acting, and a ruleset dropped after the confirmation opens the pull request with the note in its body*, *opens the pull request with the note when the rules stop holding during the push*; `tests/unit/submit-github.test.ts` — *opens the pull request on an unprotected base, says the note on stderr and in its body, and exits 0*, *refuses a repository gh’s account cannot push to, before anything is written*, *reads the rules after the confirmation, and opens the pull request with the note when they are gone*, *tries every door after a submission through main, and each is refused*; `tests/unit/plan-intent.test.ts`, *plan "<intent>" --submit to GitHub* — *says the note before a single model call, and opens the pull request after the Reviewer*, *opens the pull request with the note when the rules go while the Reviewer reads*, *reads the rules before the first model call, nothing of GitHub while the agents run, and the rules again after the Reviewer*; `tests/unit/init-command.test.ts`, *init --submit to GitHub* — *says the note before the Inspector, and opens the service’s pull request*, *opens the pull request with the note when the rules go while the Architect drafts*; `tests/unit/entry.test.ts`, *idpa "<phrase>" --submit* — *says the note before the Supervisor, and opens the pull request where the author may merge alone*; on GitHub itself, the owner's live test (stage 6 plan, 6.4.1) |
| idpa runs no git or gh command outside its list — no merge, approval, review, close, reopen, forced push, deletion, push outside `refs/heads/idp-agent/`, no `PUT`, `PATCH` or `DELETE` — checked on the final argument vector before any process starts, and in the source; the forge has no method that merges, approves, closes or deletes | `tests/unit/launcher-doors.test.ts`; `tests/architecture/dependencies.test.ts` — *nothing in src/ names a door the allow-list refuses*, *only the named modules write, and only process/git.ts and process/gh.ts start a process*; `tests/unit/forge-types.test.ts` |
| idpa reads, stores and sends no GitHub credential: git and gh are handed your environment unread, minus what the stage 6 note's § 5 removes, and no credential reaches an argument, standard input, stdout, stderr, a trace or a pull request body | `tests/contract/key-reach.test.ts` — *hands gh and the push nothing of idpa's, and passes the person's gh login unread, on plan --from --submit*, *reaches its provider in its header, and nothing of GitHub reaches it, on plan "<intent>" --submit*, *… on idpa "<phrase>" --submit*, *… on init --submit*; `tests/architecture` — *nothing in src/ reads a GitHub credential from the environment* |
| No test reaches the network, or reads a key or a model setting from the contributor's shell: `fetch`, `node:http`, `node:https`, `node:net`, `node:tls` and `WebSocket` throw, and every `IDP_` variable but `IDP_TRACE_DIR` and every `*_API_KEY` are removed, but in a scenario being recorded — where a catalogue's two variables are removed still, so no tape holds what a catalogue serves; recordings replay offline | `tests/setup/offline.ts` and `tests/setup/shell.ts`, asserted by `tests/unit/offline.test.ts` — *refuses a network call from inside the suite*, *refuses every other way out: http, https, net, tls and WebSocket*, *is set aside: every IDP_ variable but IDP_TRACE_DIR, and every key*, *records only in a scenario: a unit test never writes a tape*, *keeps a catalogue from every run, a recording included …* |

## What the architecture rules are, and are not

`tests/architecture/` walks **string-literal imports** across the transitive closure. That
catches the threat it names — a contributor who adds an import without noticing where it
lands — and it is not a sandbox. `globalThis.fetch`, `process.binding`, `eval` and
``import(`node:${name}`)`` need no import at all, and a specifier the rules do not list
passes. The `fetch` rules are **textual**: `fetch` needs no import, so the source of
`context/` and of every file reachable from `agents/` is read, comments stripped by a
scanner that knows strings, templates and regular expressions, for the word `fetch` and for
`globalThis`, `global`, `XMLHttpRequest` and `WebSocket`, and only
`context/backstage/transport.ts` may call the `catalogueFetch` it is handed; `context/`
imports no network module either, and loads no module by a name its source does not spell.
The process rule is textual too: a module that starts a process takes child_process's
functions by their own names, and every mention of one is a call given an environment
`spawnedEnvironment` builds. So are the door and credential rules: a door split across two
strings, or a variable's name built at run time, passes them, and the launchers' grammars
refuse the door at run time. A way out those words do not name passes them. Read them as a build-time convention with
teeth, never as a boundary that contains hostile code in this repository. The boundary that
does contain something is `context/project-fs`, enforced at runtime.

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
- **Physical confinement has one instant it cannot close** (batch B3, which closed
  runtime-probe-11 and core-yaml-5). `O_NOFOLLOW` guards the last name of a path, and Node
  has no `openat` to hold the folders above it still, so every open is checked once the
  descriptor exists and refused before a byte is read or written, and `init platform` asks
  every folder above a name again after each one it makes. A folder swapped for a link in
  the instant between one of those checks and the `mkdir` or the create after it can leave
  one empty folder or one empty file where the link led — never a deeper folder, never a
  file with bytes in it — and the refusal names the path. A folder swapped for a link and
  back again between two of the checks themselves is the instant only `openat` would
  close. On Windows `O_NOFOLLOW` does not exist,
  and the checks around the open are the whole guard. `.idp-agent.yml` is read by
  `cli/config.ts` as it always was, a link followed; the batch covered the catalogue
  files, `init platform`'s writer and the Inspector.
- **A submission proves the catalogue files the gates read, not the hidden ones**
  (gap-stage5-readiness-6). The `.witness.yml` files and `.idp-agent.yml` the gates also
  judged are not in a clearance's expectation, so one removed or changed between the
  preview and the submission is not caught there; `validate` over the branch still reports
  a missing witness, as an error. Working-tree bytes that differ from `HEAD` only through
  `core.autocrlf` are refused as a divergence, and an aborted submission leaves
  unreachable objects for `git gc`. A dangling symbolic ref somebody plants at the branch
  name between the forge's check and its write is replaced by the branch — git's
  create-only test reads a dangling symbolic ref as absent — though nothing outside
  `refs/heads/idp-agent/` is written.
- **`init --submit` proves the files it decides on and writes, not every file the Inspector
  read.** The Inspector reads the application's working tree, an uncommitted `CODEOWNERS`
  or `package.json` included; the divergence check covers the catalog-info files `init`
  reads and `.idp-agent.yml`. An owner read out of an uncommitted file is vouched for
  though the branch does not carry that file — the diff and the merge request are where a
  person sees it. `.idp-agent.yml` goes only on the branch of a Component `init` adds: for
  a service its catalog-info already declares, a typed configuration is said to be left
  unwritten, and is written by hand.
- **What the agents read from the declarations repository is sent as written.** Nothing
  there is filtered: it is the catalogue the question is about.

## Not guaranteed, by design

- **Content proposed by the model may be wrong.** The signature says where a value came
  from, never whether it is right: an owner that exists and is the wrong team signs
  cleanly. Review decides; the tool exists to produce a reviewable change, not to be
  trusted unread.
- **A submission runs none of the repository's hooks** — no `pre-commit`, no
  `reference-transaction`, no fsmonitor (ADR-0010). A hook is its repository's code, and
  this tool does not run it. A team relying on a `pre-commit` hook reviews the branch in the
  merge request, where CI runs, rather than by the hook.
- **The catalogue lags the repository** by about two minutes. The repository, not the
  catalogue, is the source of truth at write time.
- **The rules hold only while they stand, and only for what idpa can see.** An
  administrator can edit or disable the ruleset, or add themselves to its bypass list,
  outside idpa, and then merge: GitHub's ruleset history and audit log record it, and a
  ruleset set at the organisation level cannot be changed by a repository administrator.
  idpa cannot read the bypass of the credential you push with: a deploy key it can see in
  the bypass list is said in the note, and one it cannot see is not. And an approval by a
  workflow or an app counts as someone else's, so *Allow GitHub Actions to create and
  approve pull requests* should be off.
- **Where a base's rules let a pull request's author merge it alone, idpa opens the pull
  request and says so; it does not stop the merge**, which is the company's rule
  (2026-10-01). What it still refuses is what protects the push itself: a repository gh's
  account cannot push to, that is archived or that answers under another name (exit 1), and
  a gh missing, logged out, expired or not a person, or a clone configured to redirect the
  push (exit 2).

## Reporting a vulnerability

Open a private security advisory through the repository's **Security** tab (*Report a
vulnerability*). Please do not open a public issue for something exploitable. There is no
deployed service; the surfaces worth a look are `context/project-fs` (what leaves an
application repository), `core/plan/` (the signature and the policies), `core/paths/` and
`cli/render/plain.ts`.
