# ADR-0007 — the answer crosses the boundary, under a witness check

**Date** 2026-09-21 · **Status** accepted

## Context

design.md § 5.1 said exactly one object crosses from the AI side to the deterministic side: the
`Plan`. Stage 2 answers questions, and an answer has to come back somehow. Either the model
returns something, or it returns prose nobody can check.

## Decision

The `Answer` crosses too — a Zod union of `entities` / `nothing` / `unanswerable`, where refusal
is a member rather than a parse failure, so the model has a legal way to say "I cannot" instead of
approximating to stay in schema. It carries only references the engine itself returned, tracked in
a witness set; the engine re-reads each one before printing, and a reference no tool produced is
refused and named. § 5.1 now reads "one object per direction of authority".

## Rejected alternative

**Let the Supervisor classify and route to the stage-1 commands, so nothing new crosses.** It keeps
§ 5.1 untouched and still exercises the recording harness — but the model would then answer only
questions already expressible as `graph --type x --env y`, which is the set of questions that
needed no model. Worse, it defers the real problem: stage 4's `propose()` crosses regardless, and
the first structured crossing would then arrive with writes attached rather than with reads, where
a mistake prints a wrong table instead of opening a wrong merge request.

## Consequences

The read path is auditable: no model-authored text reaches stdout, and a model cannot make the CLI
state something the graph never produced. The cost is that § 5.1 is no longer one sentence, and
the carve-out invites being stretched — so its limit is written into both: **the witness check does
not transfer to `propose()`**, which proposes values that were never in the catalogue and will need
a guarantee of its own.

## Addendum — 2026-09-24: the overview

`ask "Talk about this project"` ended on `cannot answer`, exit 3, on a real repository: the
union had no member for a request to describe the catalogue as a whole, so the model's only
legal answer was a refusal. The union gains `overview`, and it carries **no field**: whatever
arrives with it is discarded at the parse (amended below). The model only chooses it; the
engine writes it, every figure computed from the graph and from what the reader set aside
(`context/graph/overview.ts`, rendered by `cli/render/overview.ts`). There is nothing in it to
witness, which is what lets it cross under this decision rather than beside it: the
consequence above still holds word for word, because no model-authored text reaches stdout.
What the model could still get wrong is the choice — an overview for a question that wanted
entities — and that prints a true description of the wrong thing, never a false one.

The overview also prints prose, and none of it is the model's: the descriptions a few
entities give of themselves, as their repository files wrote them (`metadata.description`),
beside the systems and tags those files declare. They are the repository's words, cleaned of
anything a terminal obeys and cut to one bounded line each (`cli/render/overview.ts`), so the
consequence still holds as stated — no model-authored text reaches stdout. A description can
be wrong, as any declaration can; it is printed as what the file says, never as what the tool
concluded.

### Amended — 2026-09-24: extra fields are discarded, not refused

The overview was first a `strictObject`, so an overview arriving with a `summary` was refused
and handed back rather than stripped. A real model then answered "Talk about this project"
with `{"outcome":"overview","refs":["component:default/site-placeholder"],"reason":" "}` three
times running — the tool is advertised flat (`llm/tool-schema.ts`), so `refs` and `reason` are
optional properties it sees beside every outcome, and it fills every one it is shown. Each
answer was refused, and the question ended on "nothing in the catalogue matched", which was
false. Every branch of the union now **discards** a field it does not declare. That keeps the
guarantee rather than relaxing it: a discarded field is gone at the parse, so nothing
downstream can read it, put it in the `answer:ready` event or print it. Two fields are kept,
and neither is new. An `entities` answer's references are checked against the witness set and
re-read before printing, so a `site-placeholder` no tool returned is still refused and named.
An `unanswerable` answer's reason is the model's own prose, unchecked, and reaches stderr only
(`cannot answer: …`), as it always has — never stdout, so the consequence above is untouched.
`ask-real-model.test.ts` replays those calls verbatim and asserts the invented reference and
the reason reach neither stdout, stderr nor the event stream.
