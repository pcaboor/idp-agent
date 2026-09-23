# cli/

Three layers — parsing, then commands, then rendering — each testable on its own.

**Parsing.** `parseArguments(argv)` in `index.ts` turns an argv array into a resolved
`Command`: `graph` with its `GraphOptions`, `show` with a query, `help`, or `error` with a
message. It reads nothing and writes nothing, so `tests/unit/cli-args.test.ts` drives it
with plain arrays and asserts on the returned object.

**Commands.** `runGraph(graph, options)` and `runShow(graph, query)` take an `EntityGraph`
and return a `CommandResult` — `text` plus `found`. No I/O and no process, so
`tests/unit/commands.test.ts` builds a graph and asserts on the value that comes back.

**Rendering.** `renderTable(headers, rows)` and `renderEntityDetail(graph, entity)` take
data and return a string. Pure functions, asserted directly in `tests/unit/render.test.ts`.

**Exit codes.** `EXIT.ok` is 0, `EXIT.notFound` is 1 (the answer is negative: a filter that
matches nothing, an ambiguous name, or a repository that does not conform), `EXIT.badUsage` is 2 (the arguments were
refused, or no model is configured), `EXIT.unsupported` is 3 (understood, and this build
will not act on it). Only `cli/index.ts` turns `CommandResult.found` into an exit code — a command
states the fact and stays free of the process — and `bin.ts` assigns it to
`process.exitCode`.

**stdout.** `cli/` is the only layer that writes to it. `main(argv, deps)` takes injectable `MainDeps` —
`root`, `out`, `err` — so `tests/unit/main.test.ts` captures output into arrays and runs against
`tests/golden/broken-si`. Entities `FixtureProvider` rejected go to `err`, never dropped in silence.

**Asking (§7.5).** A plan holding an `{unknown}` is a question, and `plan` puts it to the
user rather than printing it and leaving. `MainDeps.ask` is the seam — `(question) =>
Promise<string | undefined>` — injected by `tests/unit/plan-ask.test.ts` so the whole
interactive path runs with no terminal. The default is decided by `askOf`: a prompt on
**stderr** when stdin is a TTY and no sink was injected (stdout carries the diff), and
nothing at all otherwise, because a script has nobody to ask and blocking on a read is the
worst thing a CLI in a pipeline can do — the questions print and the run exits 3, as it
always has. `undefined` is a decline, and so is an empty line.

Both roads then run **all the gates again** on the filled plan, bounded by
`ASK_LIMITS.maxRounds`. An answer is not exempted from the signature: the request GREW by
it (`withAnswers`), because the user is the authority the intent comes from — which is
what stops the same field being asked about twice.
