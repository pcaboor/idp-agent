# ADR-0008 — commentary crosses the boundary, labelled and witness-checked

**Date** 2026-09-25 · **Status** accepted · **Amends** ADR-0007's consequence

## Context

ADR-0007 made an answer to a question an engine-written block: a table, a card, the overview,
"No entity matches". It is verified and it is mute. `idpa "<phrase>"` made a question the daily
gesture, and a block with no sentence around it reads as a database dump rather than as an answer
— nobody says what was looked at, or what the result means for what was asked. The owner asked
for a middle ground: an introduction written by the model, the answer guaranteed by the engine,
then a concluding sentence that explains it. The engine serves the model; the model does not
invent.

## Decision

The verified block stays the only authority, byte for byte what it was. Around it, the model may
write an **`intro`** (one short sentence) and a **`conclusion`** (at most three), as two optional
fields of the `entities`, `nothing` and `overview` answers, in the **same** terminal call.
`unanswerable` discards both: its reason already says why. A field that is malformed or longer
than 2 000 characters is dropped at the parse, never refused: the answer is what matters, and no
repair turn is spent on a sentence.

Before a word of it is printed, the engine checks every sentence (`core/answer/commentary.ts`, a
pure function of plain data). The text is split into sentences with `Intl.Segmenter`, in every
script, and cut again where Unicode's rules see no end but a reader does: Unicode reads a full stop
followed by a lower-case word as the sentence going on (`e.g. this`), and entity names are
lower-case, so a full stop after a word of two characters or more, then a space, ends a sentence
when the next word is identifier-shaped or a name the graph holds — "… tiger. orders-db-dev is not."
is two sentences, and the first is not dropped with the second. After an abbreviation of single
letters (`e.g.`) or before a word of prose (`bzw. einem`), Unicode's reading stands. Each sentence
is matched as it will be printed, normalised for the match only — NFKC, lower case, every character
that prints as nothing removed, the hyphen lookalikes read as `-` — so `billing-db` with a
zero-width space or a variation selector in it, or in full-width letters, is `billing-db`. The soft
hyphen, which some terminals draw as `-` and others as nothing, is removed from the printed text
too, so the reading checked is the only one left. A sentence is **dropped whole, never edited**,
when it names an entity the graph holds and no tool returned in this conversation — by name, full
reference or short one, at a script-aware word boundary, with any dash or line between its parts
read as a hyphen (`billing–api`, `billing─api`) — or when it carries an identifier (letters or
digits of any script joined by `_` `.` `/` `:` or holding a digit; joined by hyphens alone, only
when a catalogue name could be spelled so and a part of it is a part of one), or a word that mixes
the letters of two scripts, that is no witnessed entity's name or reference, no value a witnessed
entity declares, no value of the vocabulary the model was shown, and no token of the question
itself. What is kept is cleaned to one line at the model-text strength (`inertLine`) and bounded —
the introduction is the first kept sentence, the conclusion at most three — and cut only at a
sentence boundary.

It is printed **labelled as the model's**: every line starts with `› `, which no engine block
starts with, so the label survives a pipe; it is also dimmed when the run wants colour. A dropped
sentence is said once per answer, on stderr, naming what it named. `--quiet` prints the block
alone. The commentary never enters the event stream: `answer:ready` stays `{ outcome, refs }`.
A JSON form of an answer, when there is one, keeps the commentary in fields of its own, never
mixed into the verified data.

## Rejected alternatives

**Prose answers with no engine block** — the model writes the whole answer, as a chat does. The
ADR-0007 guarantee goes with it: nothing would stop a sentence stating an owner, an environment or
an entity the graph never produced, and nothing would say which words were checked.

**A second model call to write the commentary**, handed the verified block. Twice the cost and the
latency on every question, and the model writing about the tool results would not be the one that
read them — it would be handed a summary of a conversation it was not in, and asked to explain it.

**Engine-templated sentences only** ("2 entities match."). Nothing to check, and nothing to read
either: a template restates the block, and the owner asked for an explanation of what the result
means for the question — which is the one thing a template cannot say.

## Consequences

ADR-0007's consequence — "no model-authored text reaches stdout, and a model cannot make the CLI
state something the graph never produced" — no longer holds as written. It now reads: **no
model-authored text reaches stdout unlabelled or unchecked, and the engine's block states nothing
the graph never produced.** A labelled line can — which is why it is labelled, and why `--quiet`
leaves it out. The block's bytes are unchanged, the witness check on references is unchanged, and
`plan`'s output is untouched (commentary on plans is not built).

What the check guarantees is narrow, and it is stated here so it is not read as more: a kept
sentence names no entity of the graph that no tool returned, by its name or its reference, and
carries no identifier-shaped token nobody read. That is all. Names written as ordinary words pass
— an invented team ("the Falcon team"), a product, a place, a paraphrase of an entity nobody read
("the billing API") — and so do figures and any statement about the block: "12 microservices"
printed above an overview that counts 33 entities passes. It does **not** make a sentence true
either. A sentence can be wrong in plain words about what the model *did* read — "billing-api
writes to billing-db-prod" when the grant it read says `read`, a relation between two witnessed
entities that no declaration states, a figure miscounted. The check removes names of the graph and
identifiers nobody read, not invention in plain words nor errors of reasoning; the prompt asks for
neither ("say only what the tool results state"), and the label is what tells the reader which
words could carry them.

The label marks a line as it is printed, not as a terminal wraps it. An introduction may be 240
characters and a conclusion sentence 480, each printed on one line; on a narrow terminal it wraps,
and the continuation rows carry no `›`. With colour they are dimmed like the rest of the line;
without it, the blank line around the block is what still sets them apart. Wrapping to the
terminal's width ourselves would make the output depend on it, and was not done.

It also drops sentences that are fine, and lets some invented names through. A hyphen joins the
words of prose in more languages than it joins names — `peut-être`, `c'est-à-dire`, `sous-système`,
`read-only` — and the first version read every one as an identifier: a French conclusion lost most
of its sentences. Letters joined by hyphens alone are now an identifier only when a Backstage name
could be spelled so (`[a-z0-9]` and hyphens once lower-cased, so an accent is prose) and one of
their parts is a part of a name the graph holds (`payments-db` beside a `billing-db-prod`). So
`read-only` passes unless the catalogue has a name with `read` or `only` in it, and an invented
`ghost-gateway` in a catalogue with neither word passes as the prose it looks like; the label covers
it. Anything else identifier-shaped still counts — `Node.js`, `api-v2`, `orders_db` — unless the
witnessed entities, the vocabulary or the question hold it. A plain word that is also the name of an
entity no tool returned (a component called `website`) drops its sentence too, and so does a word
that mixes two scripts (`5μs`, a Greek `μ`). Where it drops, the cost is a missing sentence, never a
wrong one. The cut before a name has one of its own: an abbreviation of a whole word before one
(`vs. orders-db-prod`) ends a sentence there, and the two halves are printed, and counted toward the
bounds, as two. A dash is read as a hyphen only to find a name the graph holds: "the database—the
one in prod—" and "Paris–Lyon" stay prose, and an invented identifier written with dashes
(`ghost–db`) passes as the plain words it then is.

Confusables are read away only as far as the list above goes. A letter of another script
inside a word (a Cyrillic `а` for a Latin `a`) drops the sentence, identifier or not, because
no word is spelled in two scripts; a script change is cut only where a script written without
spaces meets another (`billing-dbは`, `billing-db는`). A whole word written in lookalikes of one
other script, or a visible diacritic on a name (`lẹdger`), is not folded: it is no name the
graph holds, and only the label covers it.

The question-mode tapes were recorded against the previous prompt and answer tool: they replay,
and warn that the prompt changed, until someone re-records them with a key.
