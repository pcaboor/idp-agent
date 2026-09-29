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
| `reapply.ts` | what has the user already answered about the entities in this draft? |
| `derive.ts` | which values follow from the catalogue rather than being chosen? |
| `sign.ts` | where did each value come from? |
| `clarify.ts` | what has to be asked before anything happens? |
| `policies.ts` | is it expressible, vouched for, and still wrong? |
| `recheck.ts` | is it still true, against the repository as it is now? |
| `edits.ts` | what bytes would it leave behind? |
| `clear.ts` | may these bytes be handed to a forge, and which repository's? — the free gates re-run against the signed provenance, one `Cleared` minted and registered; `clearService` for a service's own catalog-info and `.idp-agent.yml` |
| `seal.ts` | a Map that refuses to change, for the signature's paths and a clearance's bytes |
| `catalog-info.ts` | where `init` files a service's Component, and the bytes it leaves there — the one reading `init`'s preview and `clearService` share |

Four gates, four different kinds of refusal, and none of them substitutes for another. The
schema rejects what cannot be requested. The signature turns a value nobody can vouch for
into a question rather than a refusal — *declare, never infer* means asking, not guessing
and not giving up. A policy refuses what is expressible, vouched for, and still wrong; the
design named that gate four times and defined it nowhere, so `policies.ts` opens with the
definition. Nine ship, and **every operation is gated** — `update-entity` joins a consumer
to an *existing* grant, so it is the one operation that hands out an authorisation nobody
re-declares, and the loop once skipped it. The re-check exists because the catalogue lags
the repository by about two minutes (§4.4): what was true when the plan was drafted may not
be true now.

`reapply.ts` and `derive.ts` are in that list but neither is **a gate**: neither has a
refusal to make or hands anything back. Both run after the schema and before the
signature, `reapply.ts` first: it needs a plan the schema has minted, since it checks each
value it writes against the operation's schema, and it has to put an owner the user
answered back in the field — and have the provenance vouch for it there — before
`derive.ts` reads the consumers, or the derivation would treat that owner as nobody's.
`derive.ts` runs where it does because a right's owner is not a choice, it is a
consequence — an access `billing-api → orders-db` belongs to whoever owns `billing-api`,
and the catalogue already says who that is. §5.2 gives the model the owner
"entirely" and the signature says an owner nobody vouches for is a question; both were true
at once and the run stopped between them. So the field is taken away from the model rather
than asked of it, exactly as the path already is. Only for a right (`natureOf`), and only
when its consumers agree: two teams sharing one access is the case a human must decide, and
picking the first would be the guess this folder exists to prevent.

It runs **every pass**, and the only owner it leaves alone is one the user stated — in the
request, or answered at a prompt for that owner; when the consumers determine another, the
disagreement is reported as `overridden` rather than left for a reader to find in the diff.
"Something is already in the field" used to be the rule, and it let the engine's own
conclusion protect itself: a run read `group:default/lion` off a consumer the user then
replaced with a different component, and the second pass skipped the field because it was
no longer empty. The diff carried lion's authorisation and billing-api's consumer, and the
Reviewer — which runs once, in the last round — was told nothing, because the derivation
had happened in a round it never saw. So a value one consumer determines is written and
reported on every pass, including the one where it does not move, and a value nothing
determines is **withdrawn** back to a question.

## One provenance

What the user stated is `provenance.ts`: the request, whose words they are, and every
answer typed at a prompt, indexed by the field it answered. The derivation, the signature
and the environment policies all read it, and that one module defines what it means —
`named` for the request's words, `answered` for exactly this value at exactly this field,
`stated` for either — so the three cannot disagree about what the user said. They used to:
the signature counted an answer and the other two read only the request, so an owner the
user answered was withdrawn on the next pass and asked again until the rounds ran out, and
an environment the user answered did not count as asked.

An answer is indexed by its field because a value is not the user's everywhere it appears:
answering one grant's level `read` says nothing about another grant's, and an environment
answered for one operation counts as asked for that operation only.

A path is the plan's own index, though, and the Architect does not keep indices. A run
asked the owner of `orders-db-prod`, the Reviewer refused the filled plan because it
granted no access, and the redraft — which had never seen the answer — put `{unknown}`
back in the same field: the same question, asked twice. So an answer is **recorded by
what it is about** — the entity its operation declares or amends, and the field inside
the operation — and `reapply.ts` puts it back into every plan before the derivation, on
both roads: a field the draft left open or left out is filled, a different value is
replaced (the user's word for that entity's field wins, as an owner they state outranks
the consumers) and the replacement is said, and the provenance's paths are re-keyed to
where the entity now sits, so a redraft that moves the entity or reopens the field does
not ask it again. What is asked again — the safe direction — is stated as plainly: a
renamed entity, one whose name the redraft left open, or one of another kind, is another
entity; a list element and a consumer are never written — their position is not their
identity — and vouch only where the same entity still holds that value; a value the schema
would refuse at the redraft's field is not written; and an entity two operations of one
plan amend has no identity at all, because two updates of one grant ask two levels and
those are two answers, not one given twice. A level is keyed by its access as well as its
entity — the consumer and the thing it reaches — because "which level?" asks at what
level billing-api reaches orders-db-prod, not what orders-api's grant declares: the answer
follows the redraft that gives billing-api a grant of its own, and two updates of one grant
for two consumers each follow their own access. Held by its grant, a level goes back only
to the consumer it was typed for, and only where no operation states its access — never to
a different consumer joined to the grant it was typed into; a level typed for a grant of
two consumers is no one consumer's, and stays at its path. Only the rights whose type
states a level are accesses here (`GrantedOver`): a network flow over the same database is
never written into nor counted as the access twice. What keeps the old limit is only what has no
entity to follow — an answer about an operation with no name to know it by, or about an
entity two operations share, and one a caller vouches for at a fixed path — which still
vouches for the same value at the same field of whatever operation sits there.

And the words live in the provenance, never in `plan.intent` —
that field arrives with the plan, from whoever drafted it, and is only the record a report
carries. `init` signs with the engine's own sentence, which vouches for nothing (`wordsOf:
'engine'`), and puts what its inspection read in as answers at the Component's fields.

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
environment is answered, or derived from the declaration the request points at, or novel,
and novel means asked. **It is never echoed**: no word of the request states one, in any
language, exactly as no word states a level — see below.

Echoed means named as a **whole word** (`echoes.ts`): letters, marks and digits of any
script joined by `.`, `_` or `-`, ended by anything else and by a change of script. A
hyphen joins, so "non-prod", "pre-prod" and "hors-prod" name no `prod` and "lion-ops" no
`lion`; the price, in the safe direction, is that "en production" names no `prod` either,
nor does "orders-db-prod" — an environment inside a longer name is no word of the request —
and nothing reads an environment out of a request's words anyway (below). U+2010 and U+2011 are hyphens too, and a letter of any script
but Latin ends a token, listed anywhere or not. A composed name is vouched for by runs of its segments that
are whole words of the request, so `orders-db-prod` still passes on "orders-db in prod".

**The environment comes from the declaration you point at, or you are asked — never from
words** (the owner's decision of 2026-09-27). A word test cannot read a negation: "not
prod", "hors prod", "non–prod" with a dash, "prodではなく", "dont use prod" and "nao em
prod" each leave `prod` a whole word. A lexicon of negations withdrew the word for a while,
and a verifier found the phrasings it did not hold, each ending on a production diff; no
list is complete. So `requestedEnvironment` — the one definition the signature of
`metadata.env`, the question of an update's and the policies read — reads no environment
word, and states one only through pointing (below) or an answer.

**A negation vetoes the pointing** (`negation.ts`), and that is all it does now: "…pas à
resource:default/orders-db-prod" names the prod database by its reference in full to
exclude it, so a request holding a negation marker anywhere points at nothing, and the
environment is asked. What the negation is about is not read — "no rush, …" asks too, the
cost of failing closed. `NEGATIONS` is the marker set, by language, as data; a marker is a
whole word as prose splits it (`proseWords`: a hyphen, a dash and a change of script end
one), several words in a row, English's `n't` ending a word, `w/o` standing alone, or — in
Han, kana, Hangul and Thai — found wherever it stands; the accents of Latin letters are
read on neither side, so "nao" and "plutot que" count. It is a veto and never a guarantee:
a negation it does not hold, beside a reference in full, still points — at the declaration
the person named, whose environment the diff shows. An answer is not a word, and no
negation reaches it.

**A word cancels a pointing, and never states one** (`contradicts` in `environment.ts`).
"…resource:default/orders-db-prod in dev" names prod in full and says dev, and ended on the
prod diff: now a word spelling an environment the repository uses — the vocabulary's, or
one a document declares — other than the one pointed at, found as whole words as prose
splits them, withdraws the pointing and the environment is asked. The references pointed at
are set aside first, so `orders-db-pre-prod` says no `prod`; "the dev team" asks too, the
cost of failing closed; a word the repository never uses as an environment is not read.

## Where an environment is read, and where it is asked

`environment.ts` holds the two readings three modules share. **A name says an environment**
only as a whole part of it (`environmentsNamedBy`), and that is read for a contradiction,
never as a scope: `cross-environment-consumer` compares the environment a right *declares*
with what it reaches and who holds it, and `environment-in-name` refuses a name that says
another. Counting the name as scope let `billing-api-orders-db-prod`, declared dev, pass
over the prod database. `environment-mismatch` still reads the name, against what the user
stated, because there reading more only refuses more.

**An update's environment is asked** unless the user answered it or pointed at it — the
patch carries none, so the model chose. The question is put at
`operations.<n>.environment` (`ENVIRONMENT_FIELD`), a path the operation has no field for,
with the grant, its environment as the draft's, and the environments in use; `fillAnswers`
records the answer without writing it into the plan. It is keyed by its access like a
level (`environmentFieldOf`), so an environment answered for a grant the draft declared and
one answered for a grant an update extends are one answer, and follow the redraft between
the two shapes; a redraft that reaches another thing asks again. An answer naming another
environment than the grant's is `environment-mismatch`'s to refuse, and the remedy names
the grant of that environment — a right declared there, held by the same consumers, and
what it is over — beside a separate grant. The engine never retargets the operation itself.
A grant that declares no environment is asked about too, with the environment of what it
is over (`scopeOf`); a request naming an environment in words is asked like any other. A
request naming everything the grant is over by its reference in full is not — `kind:namespace/name`, or `kind:name` in the default
namespace, each a whole token — each thing declaring the environment the grant hands out:
"…à resource:default/orders-db-prod" pointed at a declaration, so nothing is inferred, and
`checkPolicies` counts that environment as stated, holding the consumer to it. All or
nothing — a grant over two things with one named, a thing declaring no environment, another
thing named, or the reference inside a longer token, is asked — and a bare name never
points. The pointing is vetoed by what the request mentions: every name
the repository holds (`Namesakes`, read off every file's bytes by `namesakesIn` — entities,
APIs, documents refused whose name can be read, documents set aside that carry one, and
namesakes in other namespaces), each with the SET of environments its documents declare,
found anywhere in the folded request as a plain substring. A mentioned name in another
environment than the grant's, and the update's environment is asked; so it is when a refused document's name cannot be read, and when the
request holds a negation marker anywhere (`negates`) or a word saying another environment
(`contradicts`), either of which cancels the pointing. One function,
`requestedEnvironment`, for the signature, the question and the policies, so what stops the
question is what the gates hold the plan to. The cost, in the safe direction: a bare name,
an environment named only in words, a request mentioning several environments' entities,
or one holding a negation, gets the question. Pointing stands in for silence only: beside
an answered environment it adds nothing.

**A right the draft creates** is pointed at the same way: its `dependsOn`, every thing the
repository declares, named in full, one environment, the same vetoes — and its
`metadata.env` is then signed `derived` from that declaration, not asked. A thing points at
nothing; a right over a thing the same plan creates, over one declaring no environment, or
declaring another environment than the one pointed at, is asked. Only a levelled grant is
read for what it is over when an update extends it (`GrantedOver`), so joining a consumer
to a network flow is asked, even over a thing named in full. An answer held by its path alone vouches only while that path joins
the same consumer to the same grant, since the plan holds no value to check it against.

## The translation nobody owns

A proposal is not an `Entity`. It carries `metadata.env` where an entity carries the
`company.fr/env` annotation, and no `apiVersion` at all — both absences are guarantees the
proposal schema makes, because an annotation map is also where a model would put
`idp-agent.dev/source-file` and aim at its own path (§5.2).

So `materialise.ts` is one function, imported by `recheck.ts` and `edits.ts`. Neither owns
it: the same proposal becoming the same entity in two places is two places for the
annotation to drift.

## What "already declared" means

`grant.ts` exists for the reason `materialise.ts` does: three modules ask one question —
the edits, the re-check and the policies — and none may own the answer. It used to mean a
**name** — `planEdits` asked `listDocumentNames`, `recheckPlan` asked whether the reference
was declared at the computed path — so a plan stating `read` against a file granting
`readwrite` produced an edit whose two sides were equal, an empty diff, and a run ending on
*nothing to change — the repository already says it*. The tool asserted a falsehood about an authorisation in both
directions: a requested narrowing silently did not happen, and a request for `read` was
reported satisfied by a standing `readwrite`.

A grant **is** its level (§4.1), so it came to mean a **level** — and the same falsehood came
back through every other field (review priority 8): a grant of that name held by another
consumer, owned by another team or scoped to another environment restated a proposal
whenever the two levels agreed, so an access nobody had was reported on exit 0 as the one the
request asked for. And an update was never compared at all — the re-check called it
`unresolved` whatever the file said, so an access that did exist was never named.

So a declaration restates an operation when **everything the operation would declare is
already there**: for a creation (`restatementOf`), the type, the environment, the level, the
owner, what the right is over and who holds it; for an `add-dependency-of`
(`consumerRestatement`), the consumer listed at the level the operation states. Two lists are
compared by inclusion — a file legitimately lists consumers and targets no proposal states,
and a grant orders-api also holds is still billing-api's access — and references as the
reader writes them, so `owner: tiger` restates `group:default/tiger`. A description, tags and
a Component's lifecycle are not compared: nothing a proposal says about an authorisation.

When it does not restate, there are no honest bytes — appending cannot rewrite a declaration
(§4.3) — so `planEdits` produces none and names every field that differs, `recheckPlan`
answers `differs`, and a policy refuses the plan before any preview: `declared-level-mismatch`
for the level, `declared-otherwise` for the rest, with an update per consumer as the remedy
when a consumer is all that is missing. An update whose consumer the grant does not list is
an append (`fresh`). When it does restate, `recheckPlan` says `already-declared` and hands the
CLI the file and the fields (`restated`), which is what "nothing to change — the repository
already says it" prints, so a reader can check it. For an update that is the grant's type,
environment, owner and what it is over too, which the operation does not state: they are how
a reader tells the grant the draft extended from the one the request asked for. An empty diff
exits 0 only when every operation is `already-declared`, in prose and in `--json` alike.

A right whose `dependsOn` names a right — another grant, or itself — is refused
(`right-over-a-right`): a grant is over a thing (§4.1), and the schema asks only that it
name something.

Two operations of one plan aimed at one reference are refused too (`same-reference-twice`),
naming both: two creations of one entity, a creation and an update of it, or two updates of
one grant for one consumer or stating two levels. They used to merge in silence — the second
creation found the first's bytes and added nothing. Two updates of one grant for two
consumers are two accesses and stand.

Two places are still wrong, on purpose. The Reviewer is told that an update the re-check
finds `already-declared` "would be written to the repository" (`effectsOf`, review id
wip-diff-2); saying otherwise changes what the recorded `link-already-declared` scenario sent
the Reviewer, so it waits for a re-record. And "already declared" is about the operation, not
the request: nothing here reads the request, so an update extending a grant over another
thing than the one asked for, which already lists the consumer, is reported already declared
on exit 0 — what it is over printed beside it, and a gate for it left in
[`docs/roadmap.md`](../../../docs/roadmap.md).

## What it never does

It never reads, writes or asks. `planEdits` takes the bytes that exist and returns the
bytes that would exist; putting them on disk is stage 5's business, in a layer that is
allowed to have one. What stage 5 inherits is the guarantee `effect.ts` checks: every edit,
read back with the parser, carries out its operation and changes nothing else, and an
operation whose bytes do not is dropped with a reason naming the file. The surgery that
produced the bytes finds documents by reading lines; it can be wrong, and an unchanged file
is the one mistake that would otherwise read as "already done". `recheckPlan` applies the
plan **virtually** — a new snapshot, never a mutation of the one it was handed — and runs
`checkRepository` over the result, so the re-check is the nine rules CI already runs asked
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
whether the result satisfies the nine rules is `checkRepository`. This folder computes text
and verdicts; only `cli/` decides whether that text is ever shown.
