# cli/

Three layers — parsing, then commands, then rendering — each testable on its own.

**Parsing.** `parseArguments(argv)` in `index.ts` turns an argv array into a resolved
`Command`: `graph` with its `GraphOptions`, `show` with a query, `help`, or `error` with a
message. It reads nothing and writes nothing, so `tests/unit/cli-args.test.ts` drives it
with plain arrays and asserts on the returned object. `graph`, `show` and `ask` parse
strictly: an option `ask` does not know is refused, never sent to the model as a word of the
question.

**Commands.** `runGraph(graph, options)` and `runShow(graph, query)` take an `EntityGraph`
and return a `CommandResult` — `text` plus `found`. No I/O and no process, so
`tests/unit/commands.test.ts` builds a graph and asserts on the value that comes back.

**Rendering.** `renderTable(headers, rows)` and `renderEntityDetail(graph, entity)` take
data and return a string. Pure functions, asserted directly in `tests/unit/render.test.ts`.
`show`'s card says what an entity is as well as how it is typed and owned: a one-line
description, its system, its tags and a short `links` section, each omitted when the entity
has none or nothing is left of it once cleaned. A description is cut at `ENTITY_LIMITS.text`
and ends in `…` when it is; a tag is cut at Backstage's 63 (`TAG_LENGTH`); the tags and the
links stop at a count, and what was left out is counted. A URL is never cut — a shortened
address is a wrong one — and one longer than `ENTITY_LIMITS.url` is replaced by a line saying so.
`renderOverview(overview, source)` is the text of `ask`'s `overview` answer: the model
chose it, and every word of it is written here from `context/graph/overview.ts`'s figures —
a headline naming the demo SI or the repository by its folder, then short sections, each list cut
at five with the remainder counted (`tests/unit/render-overview.test.ts`). Among them,
systems, tags, and up to five entities with their description on one line each — what the
catalogue contains in the words its repository wrote. `runAsk` gets the
source and what the reader set aside and rejected from `main`, which already has them.

**What reaches a terminal.** On `show`, `graph`, `ask` and `validate`, every string a
repository file or a model wrote goes through `render/plain.ts` before it is printed: `plain`
removes what a terminal obeys, and `oneLine` also flattens it to one line, cut at the bound it
is given. That covers every field on `show`'s card, every cell of `renderTable` (flattened,
never cut: a value shortened there would be wrong), every label and description in the
overview, the `skipped <file>: <reason>` lines on stderr and `validate`'s violation lines —
a reason quotes the key it faults, and a file name is somebody's choice — the event stream,
and `ask`'s two model-authored lines on stderr: `cannot answer: <reason>` and the
Supervisor's refusal to classify, which quotes what it said. `plan` and `init` go further,
through `inertLine`: every reason they print — a question, a refusal at the signature or a
policy, a violation, a dropped operation, a refused answer, the stop and the Reviewer's words
in it — is one line, cleaned, with the bidi overrides spelled out as `\u202e`, and bounded:
at `REASON_LIMIT` on stdout, at 200 on the event stream, and a file name or a reference not
at all, because a shortened one names another. Two outputs are escaped by `visible` rather than cleaned, because removing a byte
would change what they say: the partial plan a stop shows, which stays JSON that parses back
to the plan refused, and the diff, whose context lines are a repository file's own bytes. The
`derived` and `overridden` lines clean every reference on them, as do the `skipped` lines
every command prints, and every refusal `index.ts` prints on the way out (`failed`) goes
through `inert` — through `inertLine`, whole, for a plan file's and a directory's, which are
one sentence each and quote a file's bytes. `--json` is data and is
left as it is.

**Exit codes.** `EXIT.ok` is 0, `EXIT.notFound` is 1 (the answer is negative: a filter that
matches nothing, an ambiguous name, or a repository that does not conform — and a model call
that failed, in the one line `llm/failures.ts` wrote for it), `EXIT.badUsage` is 2 (the
arguments were refused, or no model, no key or no usable `IDP_TIMEOUT` is configured),
`EXIT.unsupported` is 3 (understood, and this build
will not act on it). Only `cli/index.ts` turns `CommandResult.found` into an exit code — a command
states the fact and stays free of the process — and `bin.ts` assigns it to
`process.exitCode`.

**stdout.** `cli/` is the only layer that writes to it. `main(argv, deps)` takes injectable `MainDeps` —
`root`, `cwd`, `out`, `err` — so `tests/unit/main.test.ts` captures output into arrays and runs against
`tests/golden/broken-si`. Entities the provider rejected go to `err`, never dropped in silence,
one `skipped` line each; documents it set aside as a kind this tool does not model go there
too, as one `not loaded:` line counting them by kind.

**Which repository `plan` inspects.** `plan "<intent>"` reads two: the declarations
repository the preview is decided against (`--repo`, `IDP_REPO` or the personal file), and
the application repository the Inspector reads — the working directory, or `--project <dir>`
resolved against it.
`repository.ts`'s `applicationRoot` refuses, with exit 2 and before a model is chosen, a
project that is not a directory, one that is a declarations repository by the markers
`isDeclarationsRepository` looks for, one that is the `--repo` directory by real path, and
one under that directory's `catalog/` or `dependencies/`. Before the model, because the
directory is the argument to fix whatever is configured. It returns both roots resolved,
and `runIntent` reads those, so the directory compared is the directory read; the working
directory is asked for only when a path needs it.
`--project` with `--from` is a parse error: that road has no Inspector.
`tests/unit/plan-project.test.ts` holds all of it.

**Where the SI comes from.** `source.ts`'s `sourceOf` decides it once, for `graph`, `show`,
`ask` and `plan`, and returns a value — `{ kind: 'repo', root, label, origin }` or
`{ kind: 'demo', label, origin }` — that `providerOf` turns into a `ContextProvider` and
nothing after it knows which. The read commands take, first match wins: `--repo`, resolved
against `cwd` and refused with exit 2 by `repository.ts`'s `declarationsRoot` — the guard
`plan` uses too — or `--demo`; `cwd` itself when `isDeclarationsRepository` says it is one;
`IDP_REPO`, absolute or under `~` — a relative one is exit 2, since it would name another
repository in every directory; `repo` in the personal configuration; the demo SI. `plan`
takes `--repo`, `IDP_REPO`, the file, never `cwd` — that is the service it declares — and
without any of them is refused with exit 2, naming all three. What is not reached is not
read: a malformed file cannot refuse a run `IDP_REPO` already answered. A configured path
that is not a directory is exit 2 naming the variable or the file, never the demo SI; a
directory with no markers is read all the same, as `--repo` reads one. Every road but
`--repo` is said in one line on `err`, naming the folder and its `origin`, and `--demo`
with `--repo` is a parse error. A repository is named by its folder's basename, whichever
road reached it. A Backstage source is one more `kind`, and the exhaustive switches over
`Source` — in `source.ts` and `providerOf` — are the only places that learn about it; what
`main` needs of a source goes through them (`overviewName`, `blameOf`), never through a
bare `kind === 'repo'`. Refusals quote a variable or a file in one flattened line, as the
notices do. `tests/unit/read-repo.test.ts` and `tests/unit/configured-source.test.ts` hold
the roads.

**The personal configuration.** `personal.ts` reads `$XDG_CONFIG_HOME/idp-agent/config.yml`,
else `~/.config/idp-agent/config.yml` (`%APPDATA%\idp-agent\config.yml` on Windows when no
XDG_CONFIG_HOME is set). It is one person's and never committed, where `.idp-agent.yml`
(`config.ts`) is a team's and is. The schema is `{ repo? }`, strict, so a misspelt key — or
a `token:` — is exit 2 naming it; `~` is expanded against the home the environment names,
and a relative path against the file's own directory. A bare `~` is YAML's null, and is
refused with a message saying to quote it. Absent is nothing configured; unreadable or not
YAML is exit 2, naming the file. It is located from `MainDeps.env` alone, never
`os.homedir()`, so a test that injects an environment cannot reach the developer's file.

**Asking (§7.5).** A plan holding an `{unknown}` is a question, and `plan` puts it to the
user rather than printing it and leaving. `MainDeps.ask` is the seam — `(question) =>
Promise<string | undefined>` — injected by `tests/unit/plan-ask.test.ts` so the whole
interactive path runs with no terminal. The default is decided by `askOf`: a prompt on
**stderr** when stdin is a TTY and no sink was injected (stdout carries the diff), and
nothing at all otherwise, because a script has nobody to ask and blocking on a read is the
worst thing a CLI in a pipeline can do — the questions print and the run exits 3, as it
always has. `undefined` is a decline, and so is an empty line.

Both roads then run **all the gates again** on the filled plan, bounded by
`ASK_LIMITS.maxRounds`. An answer is not exempted from any gate: it joins what the user
stated, and the derivation, the signature and the policies all read that one
`Provenance`. That is what makes an answer count exactly as the same value typed into the
request would, at that field.

An answer is recorded by what it is about — the entity its operation declares or amends,
and the field inside it (`recordAnswers`) — not by its path, because the Architect does
not keep paths: a redraft after the Reviewer refused a filled plan may move the entity, or
put `{unknown}` back where the user answered. `reapplyAnswers` (`core/plan/reapply.ts`)
runs on every plan before the derivation — inside `repair` on the intent road, once per
round on `--from` — writes each answer back wherever its entity now is, and re-keys the
answers to that plan's paths; `provenanceOf` builds the one `Provenance` from them. That
is what stops a moved or reopened field being asked about twice. An answer it wrote into a
redraft is said on stderr, one line per path, naming the entity rather than a path the
user no longer sees, and what the draft said when the user's answer replaced it:
`  = <path> is <value>, as answered for <entity>; the draft said <value>`. What it does
not follow — a renamed entity, a moved consumer, an entity two operations amend — is asked
again; `reapply.ts` lists it.
