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
At a terminal, without `--submit`, a change's diff ends on the engine's proposal (below), which
`main` builds inside `change`, so a question never meets one.
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

`runRelations(graph, options)` (`commands/relations.ts`) is `idpa relations`: keyless, and a
read command like `show`, whose resolution it shares — `show.ts`'s `resolveNode`, entities
first, so a name means the same node to both, a Group or a System named after a service
never makes that name ambiguous, and an ambiguous one gets the same refusal, word for word;
`--to`'s two ends are entities, each through `resolveEntity`, so a Group is refused at
either end in the same words. A name two entities carry exactly — a component and the
Resource of its API — is ambiguous too, and only those two are listed: the first the graph
held would be an accident of the order files were read in. It computes with
`context/graph/relations.ts` and nothing else: one relation (`--consumes`, `--consumed-by`,
`--depends-on`, `--impacts`, `--provides`, `--provided-by`, `OWN_RELATIONS`; `--owns`,
`--owned-by`, `--member-of`, `--has-member`, `--part-of`, `--has-part`,
`ORGANISATION_RELATIONS`), every path to another entity (`--to`, never with a relation
flag), or, with neither, every relation that holds something — an entity's in
`OVERVIEW_ORDER`, as before, and an organisation node's in `ORGANISATION_RELATIONS`' order.
`--depth` is a whole number from 1 to `RELATION_LIMITS.maxDepth`. Exit codes are `show`'s:
`0` something was found, a row declared nowhere included, or between two entities an entity
both reach; `1` an unknown or ambiguous name, a relation that holds nothing, two entities no
path links and that reach nothing in common — a near miss alone is not a relation — an
entity asked about its paths to itself; `2` the arguments — two relation flags, one beside
`--to`, a bad `--depth`, more than one name. `ask` answers a `relation` answer with this
same function (`asked: true`), so its block is this command's, byte for byte, save the way
further past a bound: the whole command, `--depth` being no option of a question.
`tests/unit/relations-command.test.ts` holds the owner's three questions to their bytes and
the demo SI to `tests/golden/relations-demo/`; `tests/unit/organisation-relations.test.ts`
holds the organisation's to `tests/golden/relations-organisation/`. An organisation
relation's table says NODE where the others say ENTITY, its arrows point from what is held —
an owned node, a member, a part — to what holds it, a path ending on a judged reference set
aside says `in the catalogue, not read`, and a relation whose first hop is only a name says
so in one line instead of `none`, in the overview of an organisation node too: `none:
group:default/tiger, the owner billing-api names, is read as a name here: this source holds
no Group` (or `a declarations repository's Group files are not read as the whole
organisation`).

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
On a catalogue read in part, a reference into what a bound left out is listed beside the
dangling ones and marked `not loaded` (`NOT_LOADED`, from `notLoadedOf`), never declared
nowhere; `graph` lists them after its dangling ones (`N references name what was not
loaded:`, at most 25), the overview under `past the bound` after its first block, `partial`,
and a path of `relations` ends on one with `— not loaded`. Every answer from a partial graph
closes on one `partial:` line (`partialClosing`, `render/catalogue-read.ts`) — `graph`'s
table, `show`'s card, a relation's block, an answer's card or table — and a miss names the
part it looked in (`missIn`). None of it is printed from a whole graph
(`tests/unit/backstage-partial.test.ts`).
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
and this build will not act on it), `EXIT.interrupted` is 130 (Ctrl-C at a question, at
`--submit`'s confirmation or at a proposal, `InterruptedError`; Ctrl-D stays a decline). Only `cli/index.ts` turns `CommandResult.found`
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
served — `N entities: M read, K not modelled`, the organisation among what was read, then set aside, skipped and
past the bound when there are any — then `not loaded:` for the kinds not modelled, then, only
when a read stopped at a count bound, `past the bound:` (`partialLine`), which never begins
with the other's words, then `setAsideLine` and `skippedLines`. A
read that fails is `catalogueFailureLine`, one line naming the host and what named it, exit
1, never a fall back. A reference the catalogue does not serve reads "declared nowhere in
the catalogue this token reads" on `show`, `relations` and an answer (`NOWHERE_IN_CATALOGUE`,
`render/entity.ts`), and the trace's root carries `idp.source.*`, never the token.
`tests/unit/backstage-read.test.ts` and `tests/contract/key-reach.test.ts` hold it.

**The kept catalogue.** `MainDeps.cacheRoot` is where a catalogue read is kept, `{ dir }` or
`{ none }`, and absent is none: `bin.ts` passes `cacheRootOf(process.env, process.platform,
process.getuid?.())` (`personal.ts`: `$XDG_CACHE_HOME` when absolute, else `$HOME/.cache`;
none on Windows, for root, or with `IDP_BACKSTAGE_CACHE=off`), and nothing in `main` defaults
it, so no test's run keeps a copy unless it hands a root in. `providerOf` hands the provider
`cache: { root, owner, use }`, the use `fresh`, `refresh` (`--refresh`) or `kept`
(`--cached`). `--refresh` and `--cached` are `READ_OPTIONS`, on the read commands and the
phrase: both at once, or either beside `--repo` or `--demo`, is refused at parsing; either
against a source resolved to a repository or the demo SI is refused before any request
(`cacheFlagRefusal`), and `--cached` with no root (`noCacheRefusal`) names why; an
`IDP_BACKSTAGE_CACHE` other than `off` is refused where a catalogue is resolved. A copy that
answered adds its age to the notice (`copyAge`: `read from cache, 3 min old; --refresh reads
Backstage again`, or `…, as --cached asks: Backstage was not asked`); a copy not used and a
read not kept are one line each after it, or one when both name one path and one reason
(`cacheLines`); the failure line names `--cached` and the copy's age after a failure of
reach, never after a 401 or a 403, and a `--cached` with nothing it could read says why
before it says so. The trace's root gains `idp.source.cache_read`, `cache_written` and
`cache_age_s`; a run answered from a copy is traced with no page and no byte and its own
time. `tests/unit/backstage-cache-read.test.ts` holds it.

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
seam and the same `fillAnswers`, and takes the Component's four answers as flags too —
`--name`, `--type`, `--lifecycle`, `--owner` — held at parsing to what an answer at the prompt
is held to (`initAnswersOf`, exit 2; a type to 1–63 characters and no control, format or bidi
character) and vouched for as answered; with nobody to ask, its questions name those flags
rather than a plan file it has none of. What the Inspector read is never an answer: `withHints`
puts each witnessed value beside the question at its field, held to the field's grammar
(`hintGrammar`), and an empty line still declines.

Printed and prompted, a question is the same lines (`questionLines`): the path, the reason
the plan carries, and — when the engine knows them — what the draft had put there and what
the field takes: `the draft says readwrite · accepted: read, readwrite` for the level of a
grant whose type states one, `accepted: experimental, production, deprecated` for a
Component's lifecycle, or `in use: dev, prod` for an environment, whose set is shown
and never closed. A hint goes between the draft's value and the set, labelled by its source:
`the draft says service · the Inspector, a model, read: service`, or for a CODEOWNERS entry
beside the owner's question, `the Inspector, a model, read the forge handle @acme/tiger,
which names no group`. They are the `Question`'s optional `proposed`, `hints`, `accepted` and
`inUse`, so `--json` carries them too; the `{unknown}` in the plan, which the Reviewer and the repair
loop read, is not reworded. An answer outside an `accepted` set is refused at the prompt,
before any gate — it used to reach the schema at gate [1] and spend a redraft on a word only
the user could fix — and the same question is put again with `not accepted: <value>` under
it. A decline is still a decline; a third value outside the set ends the run on it, exit 1
(`ASK_LIMITS.triesPerQuestion`). A Component's type holding a control, format or bidi
character is put back the same way, the character spelled out (`spelledOut`) — what
`init --type` refuses: the type is the one free-text field a question is at, and a direction
override in it reads the wrong way round in the diff.

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

**Submitting (`--submit`).** `commands/submit.ts` holds every step a submission takes, in the
order it takes them, so both roads of `plan`, `init` and the phrase share one copy. `idpa
"<phrase>" --submit` (D8 lifted) opens the forge in `main`, after `declarationsFor` and before
the catalogue is requested, says the GitHub road's line once what the run reads has been said,
runs `refuseUnprotected` before the Supervisor, and hands the forge to `runIntent` through
`reopening` on a change; a question is refused after the Supervisor's word, exit 3
(`entry.ts`'s `QUESTION_NOT_SUBMITTED`, through `classified`'s optional question road).
`openForSubmission` opens the forge before anything is read: a root that is not a clone's,
no `git`, no committer identity or a detached `HEAD` is a `ForgeInputError`, exit 2. The root
is the one `declarationsFor`'s chain resolved, and stderr names what chose it as it does
without `--submit` (D19). `refuseDivergence` then refuses, exit 1, a catalogue whose working
tree differs from `HEAD`, naming the files, before any question is asked or any diff shown.
`submit` clears the plan (`clearPlan`), asks `Confirm` — a structured `SubmissionSummary`,
the rendered preview one of its fields (D5) — and hands the `Cleared` to the forge. The
default `Confirm` is decided by `confirmOf`: the prompt on stderr, with the diff on stdout,
when stdin is a TTY and no sink was injected, and none otherwise — a script, a pipe and
`--json` have `--submit` as their answer, which is safe because the merge, not the prompt,
authorises (ADR-0006). Only `y` or `yes` submits. A plan that changes nothing never reaches
the forge: it is the same answer, and the same code, as without `--submit`. The closing
lines come from `render/footer.ts`'s `closingLines`, the one place a run says what became of
its diff; without `--submit` they are stage 4's, byte for byte. `--json` carries the outcome
under `submission`, its shape pinned by `plan-command.test.ts` (D11), and the intent road
answers under the same key. `plan --from … --submit` crosses four gates and no Reviewer;
the branch cannot reach the default one either way.

**Toward GitHub (stage 6).** `openForSubmission` opens the forge through
`forge/open.ts`'s `openSubmissionForge`, handed `--local`, the person's environment
(`MainDeps.env`, else `process.env`, which every git and gh of the submission is given),
`MainDeps.gh` and the road that drafted the change (`route`): the local forge, the road, and
on GitHub's road gh's identity and the GitHub forge, `cli/` loading no launcher. A refused
configuration key, a remote URL with a credential, a gh that is missing, logged out, too old
or not a person, and — until 6.3.3 — the phrase's road toward GitHub are
`ForgeInputError`s, exit 2, before any model. On GitHub's road it says, once, on stderr,
`submitting to github.com/<o>/<r>, into <base> (<remote>, <branch>'s upstream), as <login>
(gh)`. `refuseUnprotected`, right after `refuseDivergence`, runs the preflight and refuses,
exit 1, a repository this run cannot push to — archived, not pushable by gh's account,
answering under another name (§ 8 item 1, `renderUnprotected`, under the heading `not
submitted — github.com/<o>/<r> cannot take a pull request from this run:`) — or a clone not
level with GitHub, before the preview. The base's rules refuse nothing (the owner's decision
of 2026-10-01): where they let the author merge alone, `refuseUnprotected` says `note: on
this repository the author may merge without another person's review` through `notice`, on
stderr, once a run (or the `base-unguarded` line, `core/github/protection.ts`'s `noteLine`),
and the run goes on; the question (`authorMayMergeAlone`) and the closing lines
(`pullRequestLines`) then promise no approval. The forge's step 11 puts the note it reads
into the pull request's body, and `submit` says it on stderr above the closing lines when the
preflight did not say that line; `--json`'s `submission` carries it as `note`. `submit` takes a `pushed-without-pull-request`
recognised as the pull request left to open, and asks only about it; `Confirm`'s
`SubmissionSummary` carries `github`, and `confirmOnTerminal` asks the GitHub road's
question from it, the local road's unchanged. The closing lines name the road
(`localRoadLine`) or the pull request at the engine-built URL and what merging it waits for
(`pullRequestLines`); `--json`'s `submission` gains `pushed`, `pullRequest`, `olderBase`,
`kept`, and the outcomes `pushed-without-pull-request` and `closed`, each a negative answer
read from the result's own `found`. Every result `submit` returns carries
`forgeAttributes` (`idp.forge.*`), which `agentBacked` sets on a traced run's root, and so
does each refusal before the preview: `refuseDivergence`'s, `refuseUnprotected`'s and
`refuseOtherRepository`'s.

**The intent road's order** (6.3.1). `main` opens the forge before `agentBacked`, so the
road, the clone's configuration and gh's identity are refused, exit 2, before the model is
configured, and the `submitting to` line is said there; `runIntent` is handed that forge
through `reopening`. After `readConfig`, `refuseOtherRepository` holds the service's
`iacRepo` to the repository the clone's branch tracks — a cross-check, never a source,
exit 1, naming both, before either repository is read further; a preview, `--local`, a
road that is not GitHub's and a run that inspects no service read none. After
`readContents`, `refuseDivergence` and then `refuseUnprotected` — the preflight, judged
once per forge and base commit, so the phrase road's earlier read (6.3.3) is not read
twice — before the Inspector, the first model call. The re-check, the push and the pull
request are `forge.submit`'s, reached through `submit()` only after the Reviewer; a
question or a stop never reaches it, and reads nothing more of GitHub.

**The proposal** (6.3.5, the owner's decision of 2026-10-01). Without `--submit`, at a
terminal, `main` hands `runIntent` a `Proposal` — on the intent road beside where it would
build `submit`, on the phrase's inside `change` — whose `confirm` is `proposeOf`'s: the
injected `MainDeps.propose`, else `confirmOnTerminal(…, { discard: true })` only when stdin,
stdout and stderr are each a TTY and no sink was injected, and never with `--json`. A
separate seam from `confirmOf`, which reads stdin alone: with `--submit` the consent was typed
on the command line, and here the `y` is the only one, so the diff must reach the screen the
question is on, and `discardTypedAhead` reads away what was typed while the models ran (raw
mode, until 50 ms quiet, at most 500 ms; a Ctrl-C among it is `InterruptedError`). Nothing of
it runs before the Reviewer: `renderOutcome`, on a `planned` outcome that changes a byte,
clears the plan, then `openToPropose` — `openForSubmission`, the road, `refuseOtherRepository`,
`refuseDivergence`, `refuseUnprotected` — and `submit` with `proposal`, which asks `--submit`'s
question byte for byte. Each refusal on the way, a submission recognised refused or closed,
and GitHub failing to answer recognition's read, is said as one `no pull request proposed — …`
line (`unproposedLine`; `--submit`'s offer of `--local` made `--submit --local`) and the preview
stands at exit 0; one already submitted is named under the whole preview. The `submitting to`
line and the note are held (`Proposable.held`) and said just before the question, never on a run
that proposes nothing. A traced run's root
carries `idp.forge.proposed`: `true` where the question was put, `false` where the line was
said. No model writes the question, no prompt changed for it, and no agent reaches `forge/`.

**What is in flight** (6.3.6, the owner's decision of 2026-10-01). Right after
`refuseUnprotected`, before any model on every `--submit` road, `sayInFlight` asks the GitHub
forge's `inFlight` with no writes: the forge's first read of the open idp-agent pull requests
into the base and their files, kept for the run. Where the service is known before the model —
`serviceTarget`, the one Component an inspected project's root catalog-info declares, and the
declarations repository's files that declare or name it; on `init --submit`, the service's
catalog-info and `.idp-agent.yml` — the ones touching it are said on stderr, `in flight on
github.com/<o>/<r>, touching <what>: pull request #<k> by <login> (<branch>), changing <path>`,
and the run goes on; only a read that cannot be made whole is refused, exit 1, through
`refusedBefore`. The phrase road reads it with its early preflight, before the Supervisor, and
`runIntent`'s call says the service's lines from that read. `submitting()` judges the cleared
change before recognition, at no gh call: the same bytes are `already-proposed` (the author on
stderr, `already proposed by <login> in pull request #<k>`; stdout and `--json` the number, the
URL and this branch, exit 0); a competing pull request is a refusal, exit 1, its number, URL
and this change's paths on stdout and in `--json`'s `inFlight`, its author, branch and patch on
stderr (`patchLines`: four spaces, every control and bidi character spelled out, 40 lines a
path, 120 a run, 200 characters a line); one beside is said (`inFlightLines` in the `pending` and `submitted`
statuses, who opened it on stderr) and the change goes on. Step 8's verdict is the forge's;
where it is not the one shown before the question, `what is in flight changed while you read
the diff:` is said first. On the proposal road the same and a competing change are why nothing
is proposed (`Unproposed`'s `in-flight`). Another person's login, branch and patch go to
stderr alone — never stdout, so never a trace, nor `--json`, nor a body — and `toStderr` keeps
a line's spaces (`inertSpaced`) so a patch reads as it was laid out. `forgeAttributes` carries
`idp.forge.in_flight`, how many pull requests the last judgement named.

`plan "<intent>" --submit` moves the forge's opening earlier still: `main` opens it before the
model is configured, so a directory that cannot take a branch is an argument error even with
no model set, and hands it to `runIntent` through `reopening`, which refuses to serve any
other root. `runIntent` reads the base again and refuses divergence after the configuration
and before the Inspector — no model is paid for either refusal — then crosses five gates,
the Reviewer last, and submits only a `planned` outcome: a question and a stop answer as
they do without `--submit`. `plan-intent.test.ts` counts zero model calls on each refusal.

**The `init` road** (6.3.2) takes the same steps in the service's own clone: `main` opens
its forge before `agentBacked` — the road and gh's identity included, the `submitting to`
line said there — and `runInitRepo`, handed it through `reopening`, runs the configuration's
questions, the project's files and init's own verdicts, then `refuseDivergence` and
`refuseUnprotected` with `offerLocal`, whose refusal on § 8 item 1 ends on `--local`
(decision 17), and whose note on the rules is said there, before the Inspector. No `refuseOtherRepository`: the service's `iacRepo`
names the declarations repository, never the clone the branch goes to. D12 is the local
forge's refusal, before gh starts; D6 is the clearance's.

**`init`'s two repositories** (stage 8, slice 2, Task 2.3). `init --project` names the
service, as `plan --project` names the repository its Inspector reads; `init --repo`, which
named it until then, is refused at parsing whatever it names, exit 2, naming `--project`
(`INIT_REPO`), and the release after the first one that ships stage 8 removes the refusal.
`main` resolves the service (`initRoot`, which refuses a declarations repository by its
markers, as `plan --project` does), then the declarations repository through
`sourceOf({ command: 'init' })` — `plan`'s chain without `--repo` and without the working
directory, which is the service: `IDP_REPO`, then `repo` in the personal file — and refuses a
service that is that repository or lies under its `catalog/` or `dependencies/`
(`initApart`, `applicationRoot`'s two checks), all before the configuration and before any
model, so a broken `IDP_REPO` is exit 2 with nothing paid.
None found is said on stderr (`initFoundNoRepository`) and the run goes on against an empty
catalogue. `runInitRepo` reads that repository whole as `plan` does (`readContents`), builds the
graph, tools and contexts with `plan.ts`'s `graphOf` and `contextsOf`, and runs `repair`: the
Architect, the five gates, the Reviewer last, `componentsOf` as `scope` and the catalog-info's
edits as `elsewhere`. The signature context carries `ownComponent: 'stated-or-asked'`, so the
Component's name, type, lifecycle and owner, and every entry of its `dependsOn`, are typed or
asked, never enumerated off the catalogue or vouched for by a graph tool. A stop on the scope
shows the draft it refused and closes on what `init` takes (`SCOPE_STOP`), not on a value to
name. A name the person typed that the declarations repository already gives a Component
is *nothing to change* before any Reviewer is paid (`renderNamed`); a drafted one is asked, the
declaration shown (`declaredConflict`). What was already wrong in that repository is counted on
the line `plan` prints for it (`renderPreview`'s `standing`).

**`init`'s discovery report** (stage 8, slice 1). `runInitRepo` calls
`context/discovery/discover.ts` after every refusal before the model and just before the
Inspector, and `render/coverage.ts`'s `coverageLines` prints the report — a heading, § 9's six
parts with their labels aligned, the sentence — through `renderPreview`'s `report`, after the
diff and before the closing lines, so stdout still applies with `git apply` and still ends on
how to apply it; `renderDeclared` puts the same lines before `0 files · nothing written`, and
the confirmation's preview holds them too. Every path is spelled out (`spelled`: each control,
format, bidi and line-separator character as a `\u` escape, then `inertLine`). The sentence
goes to stderr through `notice` wherever the report is printed, never on a question or a
clearance refused before a Component is concluded. `clearService` carries the coverage on
`Cleared`, and the GitHub forge's `textOf` renders it after `ENGINE_BLOCK_END`. The exit is
decided once, by `initExit`, a switch over how the run ended — a preview, nothing to change,
or `submit`'s `SubmissionReport`, kept whole by `concluded` — that turns today's `found` false
for a preview, nothing to change, `unchanged` and `declined` when `verifiedFindings` is 0 and
`isComplete` is false, and never turns a false into true. `plan` passes no report and prints
what it printed.

**`idpa protection`.** `commands/protection.ts`'s `runProtection` checks, through the
person's own gh and with `GET` only, whether the branch a clone tracks on github.com keeps a
pull request from merging until someone other than its opener approves its latest commit
(stage 6 brief § 8). `main` finds the clone as `plan` finds its declarations repository —
`sourceOf({ command: 'protection' })`, never the demo SI or a catalogue, said on stderr when
it was not typed, and `protectionNeedsRepository` when nothing names one — and hands it the
environment and `MainDeps.gh`: the fake GitHub a test injects (`tests/support/fake-gh.ts`),
named here by `import type` alone, since only `forge/github/` loads the gh launcher and a real
run's is its own `spawnGh`. `runProtection` opens the GitHub side (`forge/github/open.ts`'s
`openGitHub`: the clone's root, the road, gh's identity), says the `checking …` line on stderr,
reads (`readProtection`) and renders (`render/protection.ts`'s `renderProtection`); `found`
is whether the rules hold, so exit 0 or 1 — a diagnostic: where a submission would go on with
a note, its exit-1 answer ends on `A submission still opens its pull request here, and says:
<the note>`. A clone on no GitHub road, a refused configuration
key or a gh that is missing, logged out, too old or not a person is a `ForgeInputError`, exit
2, before anything is read on GitHub; what GitHub fails to answer is a `GitHubAnswerError`,
which `failed()` prints in its own sentence, exit 1, as it does a `GhError` that escaped the
forge (matched by name, as `isGitError` is). No model is chosen, so none can be called, and
nothing is written. `renderUnprotected` is the same `missing:` lines as a submission's
refusal on § 8 item 1, which `refuseUnprotected` prints — naming gh's account where
`renderProtection` names its login, because the intent road's trace keeps a refusal as its output (stage 6 brief § 12).

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
