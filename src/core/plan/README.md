# `core/plan/` — everything between a proposal and a diff

A `Plan` arrives from the untrusted side. Nothing in this folder decides whether it is a
good idea; every module here decides whether it may be *offered to a reviewer*, and the
merge is still what authorises it (ADR-0006).

Pure, like the rest of `core/`: no disk, no model, no clock. The bytes a plan would replace
are handed in as a map, which is why the diff a reviewer sees and the write that follows it
are the same computation rather than two that agree until they do not.

## The gates, in the order §7.4 runs them

| Module | Question it answers |
|---|---|
| `../schemas/plan.ts` | can this even be expressed? — the closed `Operation` union |
| `derive.ts` | which values follow from the catalogue rather than being chosen? |
| `sign.ts` | where did each value come from? |
| `clarify.ts` | what has to be asked before anything happens? |
| `policies.ts` | is it expressible, vouched for, and still wrong? |
| `recheck.ts` | is it still true, against the repository as it is now? |
| `edits.ts` | what bytes would it leave behind? |

Four gates, four different kinds of refusal, and none of them substitutes for another. The
schema rejects what cannot be requested. The signature turns a value nobody can vouch for
into a question rather than a refusal — *declare, never infer* means asking, not guessing
and not giving up. A policy refuses what is expressible, vouched for, and still wrong; the
design named that gate four times and defined it nowhere, so `policies.ts` opens with the
definition. Four ship, and **every operation is gated** — `update-entity` joins a consumer
to an *existing* grant, so it is the one operation that hands out an authorisation nobody
re-declares, and the loop once skipped it. The re-check exists because the catalogue lags
the repository by about two minutes (§4.4): what was true when the plan was drafted may not
be true now.

`derive.ts` is in that list but it is **not a gate**: it has no refusal to make and hands
nothing back. It runs between the schema and the signature because a right's owner is not a
choice, it is a consequence — an access `billing-api → orders-db` belongs to whoever owns
`billing-api`, and the catalogue already says who that is. §5.2 gives the model the owner
"entirely" and the signature says an owner nobody vouches for is a question; both were true
at once and the run stopped between them. So the field is taken away from the model rather
than asked of it, exactly as the path already is. Only for a right (`natureOf`), and only
when its consumers agree: two teams sharing one access is the case a human must decide, and
picking the first would be the guess this folder exists to prevent.

It runs **every pass**, and the only owner it leaves alone is one the request states —
`echoes`, the signature's own test, is what answers that. "Something is already in the
field" used to be the rule, and it let the engine's own conclusion protect itself: a run
read `group:default/lion` off a consumer the user then replaced with a different component,
and the second pass skipped the field because it was no longer empty. The diff carried
lion's authorisation and billing-api's consumer, and the Reviewer — which runs once, in the
last round — was told nothing, because the derivation had happened in a round it never saw.
So a value one consumer determines is written and reported on every pass, including the one
where it does not move, and a value nothing determines is **withdrawn** back to a question.
The record of who stated what is `plan.intent` rather than a list kept beside the plan: the
ask loop grows that string with every answer, and nothing kept beside the plan survives the
Architect returning a different plan under the same indices.

## Why there is one producer of a `SignedPlan`

`signPlan` is the only function that can mint one. The brand on `SignedPlan` is a
`declare const` symbol that is never exported, so nothing downstream takes a bare `Plan`
and "the engine signs" is a compile error rather than a slogan. `checkPolicies`,
`recheckPlan` and `planEdits` all take a `SignedPlan`, which is how the order above is
enforced by the type checker instead of by review.

The cast inside `signPlan` is the seam, and it is admitted in that file. One place, on
purpose.

The brand proves the object was signed once. What proves it still holds what was signed is
the **freeze**: `signPlan` deep-freezes the plan it returns and seals `paths` and `refs`,
so a field changed after signing is a `TypeError` where it is written rather than a value
`planEdits` puts in the bytes while `classified` vouches for the one it replaced. A copy is
not covered and must not be — `clarify.answer` makes a new plan out of an answered one, and
that plan runs the five gates again and is signed again.

## What the signature does not claim

It says **where a value came from**. It says nothing about whether the value is right. An
owner that exists and is the wrong team is `enumerated` and signs cleanly. That gap is what
a policy is for, and what a diff is for after that, and what the merge is for after that.

An environment is deliberately not enumerable: `prod` always exists, so accepting it
because the catalogue uses it would let a model pick production for a request that named no
environment at all. §4.1 says being authorised in dev grants nothing elsewhere, so an
environment is echoed — the user named it — or novel, and novel means asked.

## The translation nobody owns

A proposal is not an `Entity`. It carries `metadata.env` where an entity carries the
`company.fr/env` annotation, and no `apiVersion` at all — both absences are guarantees the
proposal schema makes, because an annotation map is also where a model would put
`idp-agent.dev/source-file` and aim at its own path (§5.2).

So `materialise.ts` is one function, imported by `recheck.ts` and `edits.ts`. Neither owns
it: the same proposal becoming the same entity in two places is two places for the
annotation to drift.

## What "already declared" means

`grant.ts` exists for the reason `materialise.ts` does: two modules ask one question and
neither may own the answer. It used to mean a **name** — `planEdits` asked
`listDocumentNames`, `recheckPlan` asked whether the reference was declared at the computed
path — so a plan stating `read` against a file granting `readwrite` produced an edit whose
two sides were equal, an empty diff, and a run ending on *nothing to change — the
repository already says it*. The tool asserted a falsehood about an authorisation in both
directions: a requested narrowing silently did not happen, and a request for `read` was
reported satisfied by a standing `readwrite`.

A grant **is** its level (§4.1), so a declaration restates a proposal when it states the
same level. When it does not, there are no honest bytes to show — appending cannot rewrite
a scalar — so `planEdits` produces none and names both levels, `recheckPlan` answers
`differs` rather than `already-declared`, and the `declared-level-mismatch` policy refuses
the plan before any preview is offered. What it does **not** compare is everything else: a
declaration whose owner differs still reads as already declared, because a file
legitimately carries consumers, tags and a description no proposal ever states, and
comparing documents would call a genuine replay a change.

## What it never does

It never reads, writes or asks. `planEdits` takes the bytes that exist and returns the
bytes that would exist; putting them on disk is stage 5's business, in a layer that is
allowed to have one. What stage 5 inherits is the guarantee `effect.ts` checks: every edit,
read back with the parser, carries out its operation and changes nothing else, and an
operation whose bytes do not is dropped with a reason naming the file. The surgery that
produced the bytes finds documents by reading lines; it can be wrong, and an unchanged file
is the one mistake that would otherwise read as "already done". `recheckPlan` applies the
plan **virtually** — a new snapshot, never a mutation of the one it was handed — and runs
`checkRepository` over the result, so the re-check is the seven rules CI already runs asked
about a repository that does not exist yet, rather than a second set of rules to keep in
agreement with the first.

It asks them about the snapshot too, and that difference is what it reports as the plan's
`violations`: what the plan introduces, and what sits in a file it changes — for a
duplicate, what names one. The rest is `standing` — already there, word for word, in files
the plan leaves alone — and no gate refuses on it. Refusing on the whole repository made one
misfiled document anywhere block every plan, and made the repair loop hand that document to
the Architect as its fault.

And `planEdits` does not judge. Whether the entity already lives in another file is
`recheckPlan`'s `moved` verdict, whether the folder was ever declared is a policy, and
whether the result satisfies the seven rules is `checkRepository`. This folder computes text
and verdicts; only `cli/` decides whether that text is ever shown.
