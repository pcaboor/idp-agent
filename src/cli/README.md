# cli/

Three layers — parsing, then commands, then rendering — each testable on its own.

**Parsing.** `parseArguments(argv)` in `index.ts` turns an argv array into a resolved
`Command`: `graph` with its `GraphOptions`, `show` with a query, `relations` with a query
and at most one relation or a `to`, `help`, or `error` with a message. It reads nothing and writes nothing, so `tests/unit/cli-args.test.ts` drives it
with plain arrays and asserts on the returned object. `graph`, `show`, `relations` and `ask`
parse strictly: an option `ask` does not know is refused, never sent to the model as a word of the
question. A first argument that is no command name is `entry`, the one gesture `idpa
"<phrase>"`: the positionals joined are the phrase, quoted or not, and `--repo`, `--demo`,
`--backstage`, `--project` and `--json` are parsed as strictly and carried to whichever road it takes. Two
things are refused, and nothing else is second-guessed: a command behind its options
(`--repo IaC show billing-api` is `show` in the wrong order, not the phrase "show
billing-api"), and a phrase of a single word a slip away from a command name (`grpah`,
`shwo`, `palm`, `relation`, `relatoins`) — one edit, two for a name of four letters or more
kept at its length, and never a change of first letter, so `who`, `edit` and `hello` stay
phrases; `validate` and `version` share theirs, and the nearer wins. Each is an `error`, and
neither reaches a model. A longer phrase whose first word is such a slip —
`idpa relation billing-api` — stays a phrase, since a sentence may begin with any word;
when no model can be opened for it, the refusal is followed by the command it looks like
(`slipHint`: `"relation" is not a command; did you mean idpa relations? It needs no
model`). `COMMANDS` is the list of names, and `entry.test.ts` holds it to the parser and
to `HELP`. `-h` and `--help` are `help`, `--version`, `-v` and `version` are `version`, and
a `--help` or `-h` anywhere before `--` is `help` with the `usage` of the command it follows
(`usageOf`, its lines of `HELP`) — the lines a refused argument prints too, where it
printed the whole page. `validate` and `init platform` take exactly one directory, never
empty, and `version`, `--version` and `-v` nothing (`command-line-edges.test.ts`).

**The one gesture.** `commands/entry.ts`'s `runEntry` is `ask`'s `classified` with a
different answer to a change: the Supervisor classifies the phrase once, a `QUESTION` is
answered by the very code `ask` runs — same summary, same Analyst, same output and exit
codes — and a `MUTATION` runs the `change` callback `main` builds, which is `runIntent`
over the repository the phrase was read against, or the refusal when that is the demo SI.
A phrase's `--project` is checked before the model whichever road is then taken: in full
against the repository found (`applicationRoot`), and for what it is on its own —
empty, no directory, a declarations repository — when that is the demo SI (`projectRoot`).
`--json` on a question does nothing, and one line on `err` says so; `--quiet`, on `ask` and on
a phrase, prints a question's verified block without the model's commentary, and on a change
does nothing and says nothing. The refusals name
`idpa`, which is what was typed, and the source line names `--demo` as the question's.
`ask` still declines a change, and says `run it as idpa "<phrase>" to preview the plan`.
`tests/unit/entry.test.ts` holds both roads.

**Commands.** `runGraph(graph, options)` and `runShow(graph, query)` take an `EntityGraph`
and return a `CommandResult` — `text` plus `found`. No I/O and no process, so
`tests/unit/commands.test.ts` builds a graph and asserts on the value that comes back.
`graph --kind` takes `Component`, `Resource` or `API` — Backstage's API is read, never
proposed (design §4.1) — and an API's row has `API` in its KIND column. `show` resolves an
API as it resolves any entity, through `resolveEntity`: a full reference, then the one entity
carrying exactly that name. A name two entities carry — an API and the Resource the demo
convention models one as may share one — resolves to neither: it is refused on exit 1, with
those entities alone listed by reference, for the reader to choose. `show` resolves through
`resolveNode`, which puts the organisation after the entities: a reference to an entity, then
to an organisation node, then the entities of that name, and only when no entity carries it,
the organisation's; a Group named after its service never makes an entity ambiguous.
A Group, a User, a System or a Domain prints `render/organisation.ts`'s card, laid out as an
entity's, each list cut at 25 rows and the rest counted; an entity's `owner` and `system`
lines carry `nowhere`'s mark only where a catalogue read that kind whole.

`runRelations(graph, options)` (`commands/relations.ts`) is `idpa relations`: keyless, and
a read command like `show`, whose resolution it shares — `show.ts`'s `resolveEntity`, so a
name means the same entity to both and an ambiguous one gets the same refusal, word for
word, `--to`'s included. A name two entities carry exactly — a component and the Resource
of its API — is ambiguous too, and only those two are listed: the first the graph held
would be an accident of the order files were read in. It computes with
`context/graph/relations.ts` and nothing else: one relation (`--consumes`, `--consumed-by`,
`--depends-on`, `--impacts`, `--provides`, `--provided-by`, `OWN_RELATIONS`), every path to
another entity (`--to`, never with a relation flag), or, with neither, every relation that
holds something. `--depth` is a whole number from 1 to `RELATION_LIMITS.maxDepth`. Exit
codes are `show`'s: `0` something was found, a row declared nowhere included, or between
two entities an entity both reach; `1` an unknown or ambiguous name, a relation that holds
nothing, two entities no path links and that reach nothing in common — a near miss alone is
not a relation — an entity asked about its paths to itself; `2` the arguments — two
relation flags, one beside `--to`, a bad `--depth`, more than one name. `ask` answers a
`relation` answer with this same function (`asked: true`), so its block is this command's,
byte for byte, save the way further past a bound: the whole command, `--depth` being no
option of a question.
`tests/unit/relations-command.test.ts` holds the owner's three questions to their bytes and
the demo SI to `tests/golden/relations-demo/`.

**Rendering.** `renderTable(headers, rows)` and `renderEntityDetail(graph, entity)` take
data and return a string. Pure functions, asserted directly in `tests/unit/render.test.ts`.
`show`'s card says what an entity is as well as how it is typed and owned: a one-line
description, its system, its tags and a short `links` section, each omitted when the entity
has none or nothing is left of it once cleaned. A description is cut at `ENTITY_LIMITS.text`
and ends in `…` when it is; a tag is cut at Backstage's 63 (`TAG_LENGTH`); the tags and the
links stop at a count, and what was left out is counted. A URL is never cut — a shortened
address is a wrong one — and one longer than `ENTITY_LIMITS.url` is replaced by a line saying so.
An API's card adds its lifecycle and `definition   declared` after its type — the text of the
definition is never kept, so it cannot be printed — and a `provided by` section, `none`
included; the rights over it and the services they reach are listed as for any object. A
Component's card has a `provides` section only when it provides an API, and another kind's a
`provided by` only when a `providesApis` names it — Backstage keeps an explicit kind as
written — so every other card reads as it did.
A reference the entity declares and nothing in the catalogue answers to — a dangling one,
as `graph` and `validate` count them — is listed in the section of its relation, after what
resolves, one per line and marked where an environment would be: `declared nowhere`, and
`; resource:default/payments-api has this name` when entities of its name exist under
another kind or namespace. A `dependsOn` in `depends on`, a `dependencyOf` in `used by`, a
`providesApis` in `provides` (which then appears for it alone), and every service the
rights reaching an object name and nothing declares in `reached by services`, once each —
a `component:` one only, since a missing Resource is not a service and stays under its
right's `used by`. A reference longer than an entity's can be (`providesApis` keeps one the
grammar cannot split as written) sets no column: it is printed with its marker after it.
Beside, never in place of: which entity was meant, if any, is the reader's to decide (design
§4.1). A card with nothing dangling reads as it did, byte for byte
(`tests/unit/dangling-shown.test.ts`).
`renderRelation(result, road)` and `renderRelationsOverview(subject, results, road)`
(`render/relations.ts`) print a relation: the entity's reference, then per relation a title
with the number of rows found, a table, and under it every bound the walk reached — `n more
not shown`, `stopped at depth d`, a cycle not followed (five named, the rest counted), a
`between` search that spent its budget — never silent. `consumes` at its own depth says what
it stops at instead: `what these depend on is not listed; --depth 3 follows it`. The `road`
decides how the way further is named: the flag for the command, the whole command
(`idpa relations <ref> --consumes --depth 3`) under an answer. A row is the entity reached,
its type, its own environment, its depth and its PATH, names joined by `→` (depends on) or
`←` (is depended on by), a right with a stated level followed by it, `(readwrite)`.
`consumes` and `consumed-by` add ACCESS and VIA. ACCESS is the level of the right next to
the entity the row names — the one over the object, or the one naming the consumer —
`(undeclared)` for a right whose type states one and that states none, `-` for one whose
type states none, and empty past the object a right is over: a right over a database
grants nothing on its host. VIA names every right on the path with its own environment,
`resource:default/app-db (dev)`, since a right declared in dev over a prod database is
what the file says and the table must not paper over; `(no right)` when the path holds
none. `between` prints each path on one line and, under it, every step with its type,
environment and level; where there is none, `no path where one depends on the other`, then
the nearest entities both reach (`both depend on`, `depend on both`), each with the path
from either end and one step table; and apart from both, `near misses, declared nowhere`,
counted in neither. A step declared nowhere ends its path with `show`'s own marker
(`nowhere`, exported from `render/entity.ts`). Every string goes through `oneLine`, as on
the card. `holds` says whether a result is an answer — a row, or an entity both ends reach.
`renderOverview(overview, source)` is the text of `ask`'s `overview` answer: the model
chose it, and every word of it is written here from `context/graph/overview.ts`'s figures —
a headline naming the demo SI or the repository by its folder, then short sections, each list cut
at five with the remainder counted (`tests/unit/render-overview.test.ts`). Among them,
systems, tags, and up to five entities with their description on one line each — what the
catalogue contains in the words its repository wrote. An `apis` section — how many, and
how many a service provides — appears only where the repository declares one, and an API a
right reaches is counted among the most reached objects; one `organisation` line, the Groups,
Users, Systems and Domains read, only where there are any. `runAsk` gets the
source and what the reader set aside and rejected from `main`, which already has them.
`setAsideLine(ignored)` and `skippedLines(rejected)` (`render/catalogue-read.ts`) are what a
catalogue read says on stderr beside `not loaded:`, after the notice: what the pre-pass
set aside, grouped by rule with its count, "set aside by the catalogue read", and what the
reader refused, grouped by reason, "skipped" — one line per reason where the file road
prints one per file, since a catalogue holds thousands. Every value quoted there was chosen
by the catalogue: each is `inertLine`d, as the file road's `skipped` line is (nothing a
terminal obeys, the bidi controls spelled out), and cut to 80 characters, a rule lists five
values then `and K more`, a line three refs then `…`, and a reason is cut at 200
(`tests/unit/catalogue-read-lines.test.ts`).

**An answer's commentary (ADR-0008).** `runAsk` prints the model's `intro` above the
engine's block and its `conclusion` under it, a blank line between each, the block's bytes
unchanged. Before that, `core/answer/commentary.ts`'s `checkCommentary` drops every sentence
naming an entity no tool returned or an identifier nobody read, and cleans and bounds the
rest through `inertLine`. Each kept line starts with `› `, which no engine block starts with,
so the mark survives a pipe; it is also dimmed (SGR 2) when `main`'s `colourOf` says stdout is
a terminal that wants colour, which an injected `out` never is. What the check left out for
what it named is one line on `err`, per answer — `! the model's commentary named …, which no
tool returned; that sentence was left out` — its names cleaned and bounded. `--quiet` skips
all of it. `tests/unit/ask-commentary.test.ts` holds the bytes.

**What reaches a terminal.** On `show`, `graph`, `relations`, `ask` and `validate`, every string a
repository file or a model wrote goes through `render/plain.ts` before it is printed: `plain`
removes what a terminal obeys, and `oneLine` also flattens it to one line, cut at the bound it
is given. That covers every field on `show`'s card, every cell of `renderTable` (flattened,
never cut: a value shortened there would be wrong), every label and description in the
overview, the `skipped <file>: <reason>` lines on stderr and `validate`'s violation lines —
a reason quotes the key it faults, and a file name is somebody's choice — the event stream,
and `ask`'s two model-authored lines on stderr: `cannot answer: <reason>` and the
Supervisor's refusal to classify, which quotes what it said. An answer's commentary, the
model's words on stdout, goes further: through `inertLine`, like a reason `plan` prints,
once the engine's check has kept it. `plan` and `init` go further,
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
matches nothing, an ambiguous name, a relation that holds nothing, or a repository that does
not conform — and a model call that failed, in the one line `llm/failures.ts` wrote for it),
`EXIT.badUsage` is 2 (the arguments were refused, or no model, no key or no usable
`IDP_TIMEOUT` or `IDP_SUPERVISOR_MODEL` is configured), `EXIT.unsupported` is 3 (understood,
and this build will not act on it), `EXIT.interrupted` is 130 (Ctrl-C at a question,
`InterruptedError`; Ctrl-D stays a decline). Only `cli/index.ts` turns `CommandResult.found`
into an exit code — a command states the fact and stays free of the process — and `bin.ts`
assigns it to `process.exitCode`.

**stdout.** `cli/` is the only layer that writes to it. `main(argv, deps)` takes injectable `MainDeps` —
`root`, `cwd`, `out`, `err` — so `tests/unit/main.test.ts` captures output into arrays and runs against
`tests/golden/broken-si`. Entities the provider rejected go to `err`, never dropped in silence,
one `skipped` line each; documents it set aside as a kind this tool does not model go there
too, as one `not loaded:` line counting them by kind; and the fields of a read entity the
read model does not read, as one `not read:` line counting them by path.

**Which repository a change inspects.** `plan "<intent>"`, and a phrase classified as a
change, read the declarations repository the preview is decided against, and may read an
application repository too — the Inspector is optional. `repository.ts`'s
`applicationRoot` decides, before a model is chosen, and returns an `Inspection`: the
directory `--project` names, resolved against the working directory; else the working
directory when `isApplicationRepository` says it is one (a `catalog-info.yaml`/`.yml` or a
package manifest at its root, never a declarations repository) and it is neither the
declarations repository by real path nor anywhere under it, nor the home directory or the
filesystem root; else
`none`, with the reason, which `main` says on `err` in one line (`skipNotice`) before
`runIntent` runs with `project: undefined` and the Architect is told `NOT_INSPECTED`. A
`--project` that is not a directory, is a declarations repository, is the `--repo`
directory or lies under its declaration folders is refused with exit 2: a flag is an
argument, and an argument is refused before the configuration is. The working directory
is not an argument, so it is never refused, only skipped. `runIntent` reads the roots it is
handed, so the directory compared is the directory read; with no project it reads no
`.idp-agent.yml` either, which lives in the application repository (§7.0).
`--project` with `--from` is a parse error: that road has no Inspector.
`tests/unit/plan-project.test.ts` holds all of it.

**Where the SI comes from.** `source.ts`'s `sourceOf` decides what every command reads —
`graph`, `show`, `relations`, `ask`, `plan` and a phrase (which asks as `ask` does) — and
returns a value — `{ kind: 'repo', root, label, origin }`, `{ kind: 'demo', label, origin }`
or `{ kind: 'backstage', url, label, origin }` — that `providerOf` turns into a
`ContextProvider` and nothing after it knows which. The read commands take, first match
wins: `--repo`, resolved against `cwd` and refused with exit 2 by `repository.ts`'s
`declarationsRoot` — the guard `plan` uses too — `--demo`, or `--backstage`, the configured
catalogue (refused, exit 2, when none is); `cwd` itself when `isDeclarationsRepository` says
it is one; `IDP_BACKSTAGE_URL`; `IDP_REPO`, absolute or under `~` — a relative one is exit
2, since it would name another repository in every directory; `backstage` in the personal
configuration; `repo` there; the demo SI. At each level a catalogue beats a repository.
`plan` takes the repository roads alone, `cwd` included on its markers — a service's
repository carries none — and never the demo SI or a catalogue: without any of them it is
refused with exit 2, naming all four, and a phrase the Supervisor calls a change is refused
the same way. A phrase resolves twice: what it reads (`sourceOf`) and what its change is
decided against (`declarationsFor`: `plan`'s chain, walked with `idpa`'s name so its
refusals name what was typed, and nothing for `--demo`), both over one private chain, the
second before the load — so a broken `IDP_REPO` is exit 2 before any request to a
catalogue, on a question too (`backstage-read.test.ts`). They coincide while no Backstage is
read; once one is, the read takes it and the change never does. What is not reached is not
read: a malformed file cannot refuse a run `IDP_REPO` or `IDP_BACKSTAGE_URL` already
answered. A configured path that is not a directory is exit 2 naming the variable or the
file, never the demo SI; a directory with no markers is read all the same, as `--repo`
reads one. Every road but `--repo` is said in one line on `err`, after the load, naming the
folder or the catalogue's host and its `origin`, and two of `--repo`, `--demo` and
`--backstage` is a parse error. A repository is named by its folder's basename, whichever
road reached it. The exhaustive switches over `Source` — `overviewName`, `blameOf`,
`sourceNotice` and `providerOf` — are the only places that learn about its kind; what
`main` needs of a source goes through them, never through a bare `kind === 'repo'`.
Refusals quote a variable or a file in one flattened line, as the notices do.
`tests/unit/read-repo.test.ts` and `tests/unit/configured-source.test.ts` hold the roads.

**A Backstage catalogue.** The URL — `IDP_BACKSTAGE_URL`, or `backstage` in the personal
file, never `.idp-agent.yml` and never the command line — is checked before any request
(`catalogueBase`): https:, or http: to 127.0.0.1, ::1 or localhost; no space or control
character, which the parser drops; no userinfo, query or fragment, as typed or parsed; a path, with no empty, `.` or `..` segment, encoded or not, and
none the parser would rewrite. A refusal is exit 2 and quotes the URL as `shownUrl` does —
userinfo, query and fragment each `***`, and a value that does not parse, or holds a space or
a control character, by its length alone, since it may be the token — never whole
(`backstage-source.test.ts`). A host that is not this machine is refused, exit 2, when
`IDP_BACKSTAGE_TOKEN` is unset or empty, and any host when the token holds a character a
header cannot carry (`headerCarries`, the transport's own rule), quoting none of it; its
value is otherwise read in `providerOf` alone and handed to `BackstageProvider` with
`MainDeps.catalogueFetch` (the global `fetch` in a real run). The notice follows the load and counts what was
served — `N entities: M read, K not modelled`, the organisation among what was read, then set aside and skipped when there are
any — then `not loaded:` for the kinds not modelled, `setAsideLine` and `skippedLines`. A
read that fails is `catalogueFailureLine`, one line naming the host and what named it, exit
1, never a fall back. A reference the catalogue does not serve reads "declared nowhere in
the catalogue this token reads" on `show`, `relations` and an answer (`NOWHERE_IN_CATALOGUE`,
`render/entity.ts`), and the trace's root carries `idp.source.*`, never the token.
`tests/unit/backstage-read.test.ts` and `tests/contract/key-reach.test.ts` hold it.

**The personal configuration.** `personal.ts` reads `$XDG_CONFIG_HOME/idp-agent/config.yml`,
else `~/.config/idp-agent/config.yml` (`%APPDATA%\idp-agent\config.yml` on Windows when no
XDG_CONFIG_HOME is set). It is one person's and never committed, where `.idp-agent.yml`
(`config.ts`) is a team's and is. The schema is `{ repo?, backstage? }`, strict, so a misspelt key — or
a `token:` — is exit 2 naming it; `~` is expanded against the home the environment names,
and a relative path against the file's own directory. A bare `~` is YAML's null, and is
refused with a message saying to quote it, and a bare `backstage:` as empty. `backstage` is
a URL as written, never expanded. Absent is nothing configured; unreadable or not
YAML is exit 2, naming the file. It is located from `MainDeps.env` alone, never
`os.homedir()`, so a test that injects an environment cannot reach the developer's file.

**Asking (§7.5).** A plan holding an `{unknown}` is a question, and `plan` puts it to the
user rather than printing it and leaving. `MainDeps.ask` is the seam — `(question) =>
Promise<string | undefined>` — injected by `tests/unit/plan-ask.test.ts` so the whole
interactive path runs with no terminal. The default is decided by `askOf`: a prompt on
**stderr** when stdin is a TTY and no sink was injected (stdout carries the diff), and
nothing at all otherwise, because a script has nobody to ask and blocking on a read is the
worst thing a CLI in a pipeline can do — the questions print and the run exits 3, as it
always has. `undefined` is a decline, and so is an empty line. `init` asks through the same
seam and the same `fillAnswers`, and takes the three answers no file of a service states
reliably as flags too — `--name`, `--lifecycle`, `--owner` — held at parsing to what an answer
at the prompt is held to (`initAnswersOf`, exit 2) and vouched for as answered; with nobody to
ask, its questions name those flags rather than a plan file it has none of.

Printed and prompted, a question is the same lines (`questionLines`): the path, the reason
the plan carries, and — when the engine knows them — what the draft had put there and what
the field takes: `the draft says readwrite · accepted: read, readwrite` for the level of a
grant whose type states one, `accepted: experimental, production, deprecated` for a
Component's lifecycle, or `in use: dev, prod` for an environment, whose set is shown
and never closed. They are the `Question`'s optional `proposed`, `accepted` and `inUse`, so
`--json` carries them too; the `{unknown}` in the plan, which the Reviewer and the repair
loop read, is not reworded. An answer outside an `accepted` set is refused at the prompt,
before any gate — it used to reach the schema at gate [1] and spend a redraft on a word only
the user could fix — and the same question is put again with `not accepted: <value>` under
it. A decline is still a decline; a third value outside the set ends the run on it, exit 1
(`ASK_LIMITS.triesPerQuestion`).

Both roads then run **all the gates again** on the filled plan, bounded by
`ASK_LIMITS.maxRounds`. An answer is not exempted from any gate: it joins what the user
stated, and the derivation, the signature and the policies all read that one
`Provenance`. That is what makes an answer count exactly as the same value typed into the
request would, at that field. Each round derives the owners again and says so on the
stream; the terminal's sink (`progress` in `index.ts`) prints a `derived` line once per path
and owner per run, so an owner the second round derives again is not a second line, and an
owner that replaced the first one is. The trace keeps every emission, on its round's span.

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
`  = <path> is <value>, as answered for <entity>; the draft said <value>`. A level is also
recorded by its **access** — the consumer and the thing — so an answer typed for
billing-api joined to orders-api's grant follows the redraft that declares a grant of
billing-api's own, and the line names the access rather than a grant.
What it does not follow — a renamed entity, a moved consumer, an entity two operations
amend, an access stated twice — is asked again; `reapply.ts` lists it.

A stop over a value the user gave does not end on "name the value the gate could not
accept": it names the value as theirs, kept through every redraft, and for a level what
would pass — a separate grant at their level, for whom and over what as far as the engine
knows (`renderStopped`, `RepairOutcome.kept`).

**Tracing.** `trace-sink.ts` is the only way a trace leaves the process: `mlflowSink` posts
OTLP/JSON to `IDP_MLFLOW_TRACKING_URI`'s `/v1/traces` — never `MLFLOW_TRACKING_URI`'s, which
other tools set — and reads the answer, so spans an OTLP server rejects are not reported as
sent; that check reads JSON, and MLflow 3.16.1 answers `200` with an empty `application/x-protobuf`
body, so it never fires there, and a partial rejection from that server would go unreported.
`fileSink` writes one `0600` file per run under `IDP_TRACE_DIR`. A sink that fails is one
`! trace not exported` line on stderr — never an exit code. `agentBacked` in `index.ts`
builds the trace (`src/trace/`), wraps the client with `traced` and tees the event stream,
for `idpa "<phrase>"`, `plan "<intent>"`, `ask` and `init` alone: the commands that involve
no model have nothing to trace. The root is `idp-agent <command>`, with the resolved
repositories in its inputs and `idp.exit_code` on it, and fails only when the run threw
(`docs/tracing-design.md` §4.1); stderr names it `· trace tr-<hex>`, as MLflow does.
`MainDeps.traceSinks` and `MainDeps.fetch` are the test seams
(`tests/unit/trace-wiring.test.ts`).

**What a run cost.** `agentBacked` also wraps the client with `counted` (`usage.ts`): each
model call that returned is a `usage` event carrying what its provider reported, and the
run ends on one stderr line, `· 3 model calls: 5700 input tokens, 103 output tokens`. It
follows what the command printed as its result — `cannot answer`, a change request put to
`ask`, a miss — and comes before a failure's line, which stays the last: every failure,
the Supervisor's two answers that were no word included, is thrown to `failed`. A count no call reported is said to be
missing, never printed as 0, and one only some calls reported says of how many: a tape
recorded before usage was stored holds none. A run that made no call says nothing.
