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
Supervisor's refusal to classify, which quotes what it said. `plan` and `init` clean what a
model wrote (`render/plain.ts` says where); what they print from a repository file is not
covered by this paragraph.

**Exit codes.** `EXIT.ok` is 0, `EXIT.notFound` is 1 (the answer is negative: a filter that
matches nothing, an ambiguous name, or a repository that does not conform), `EXIT.badUsage` is 2 (the arguments were
refused, or no model is configured), `EXIT.unsupported` is 3 (understood, and this build
will not act on it). Only `cli/index.ts` turns `CommandResult.found` into an exit code — a command
states the fact and stays free of the process — and `bin.ts` assigns it to
`process.exitCode`.

**stdout.** `cli/` is the only layer that writes to it. `main(argv, deps)` takes injectable `MainDeps` —
`root`, `cwd`, `out`, `err` — so `tests/unit/main.test.ts` captures output into arrays and runs against
`tests/golden/broken-si`. Entities the provider rejected go to `err`, never dropped in silence,
one `skipped` line each; documents it set aside as a kind this tool does not model go there
too, as one `not loaded:` line counting them by kind.

**Where the SI comes from.** `graph`, `show` and `ask` pick a `ContextProvider` and nothing
after it knows which: `IacFsProvider` over the declarations repository `--repo` names,
resolved against `cwd` and refused with exit 2 by `repository.ts`'s `declarationsRoot` —
the guard `plan` uses too; with no `--repo`, `IacFsProvider` over `cwd` itself when
`isDeclarationsRepository` says it is one; otherwise, or with `--demo`, `FixtureProvider`
over the demo SI. The demo SI, `--demo` or not, and the working directory each say so in one
line on `err` — only `--repo` is silent — and `--demo` with `--repo` is a parse error. A
repository is named by its folder's basename, whichever road reached it.
`tests/unit/read-repo.test.ts` holds all three.

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
stated — `provenanceOf` in `plan.ts`, the request plus every answer at the field it
answered — and the derivation, the signature and the policies all read that one
`Provenance`. That is what stops the same field being asked about twice, and what makes an
answer count exactly as the same value typed into the request would, at that field.
