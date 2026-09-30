# ADR-0013 — A catalogue past a bound is read in part, and says so

**Date** 2026-09-30 · **Status** accepted · amends [ADR-0011](0011-backstage-to-explore.md)

## Context

ADR-0011 refused a catalogue the load could not read whole, a count ceiling included: past
20,000 Components, Resources and APIs, 200,000 Groups, Users, Systems and Domains, or 200,000
references of other kinds, the run ended on one line, exit 1. The reason was sound — a
reference into the part not read would read as *declared nowhere*, which is a statement about
the catalogue the tool could not make — but the refusal answered nothing about the
catalogues the tool is for: a company's can pass 20,000 Components, and "this version does
not answer from part of a catalogue" is all its people would ever read
(`docs/backstage-http-brief.md` § 6, § 13 slice 2; `docs/plans/backstage-http-slice-2.md`).

## Decision

**Each count ceiling is a bound stated, not a refusal.** A read that reaches its ceiling
stops there, keeps what it read, and says how far it got (`Served.bounded`, then
`LoadResult.partial`): its scope, its kinds, how many it read, how many the catalogue
announced — or that the server served more than it announced, and how many is not known —
and the bound. The part kept is the first in the server's order, which is stated as nothing
more. The byte and time bounds, the cursor loop, an item with no uid or of a kind its read
did not ask for, and fewer uids than announced on a read that did not stop stay refusals:
they are what a broken or hostile server does, and a read cut there is cut wherever the
server chose.

**What a bound left out is *not loaded*, a state beside *declared nowhere*.** A reference
into a kind whose read stopped, resolving to nothing read, is kept out of
`danglingReferences()` and `unresolvedOf()` and listed on its own (`notLoadedOf`,
`notLoadedReferences`), so every consumer of *declared nowhere* keeps its meaning and the file
road, which never bounds, is unchanged. A reference into a kind read whole is still declared
nowhere: that answer is known, and so is it of a reference the grammar cannot split, which
names no served entity. An organisation read that stopped is **not judged**: an owner, a
system or a membership naming nothing is a name, as over a repository — and the reason given
is the bound (`Groups past this version's bound of N were not loaded`), never that the source
holds no Group or that it is a declarations repository.

**Every answer from a partial graph says so, in the engine's words, and only then.** The
notice counts `N past the bound`; a stderr line of its own begins `past the bound:`, after the
`not loaded:` line of the kinds this tool does not model, whose words it never takes; `graph`,
`show`, `relations` and a question's blocks close on one `partial:` line; the overview opens
on a `partial` block and lists the references past the bound apart from the dangling ones; a
miss names the part it looked in; a reference past the bound is marked `not loaded`. The
Supervisor and the Analyst are told in one line, after the vocabulary, and an Analyst row
carries `notLoaded`. The trace's root gains `idp.source.not_loaded`.

## Rejected alternatives

**Refusing, as ADR-0011 did** — the tool then answers nothing about the catalogues it is for.
**Answering without saying** — a miss, or a reference past the bound, would read as a fact
about the catalogue. **A sample of the catalogue** — arbitrary, where the server's order is at
least stated. **Partial on the byte and time bounds** — what a broken server cuts is cut
wherever it chose, and no sentence can say what was left out. **Renaming the existing
`not loaded:` line** to give its words to the bound — closer to the note's words, but it moves
every whole read's stderr and overview (the owner's decision 5, 2026-09-30).

## Consequences

A catalogue past a bound is answered, exit 0, where it was exit 1. Nothing moves on a whole
read: every tape, golden and demo prints and sends the bytes it did, and the summary line and
a row's `notLoaded` exist only when the graph is partial, so no recording is staled. The
summary names the scope and the bound, never a count, so a catalogue growing past the bound
by one does not move a prompt. The note's "an unresolved reference in a partial graph is never
called dangling" is narrowed to the kinds whose read stopped.
