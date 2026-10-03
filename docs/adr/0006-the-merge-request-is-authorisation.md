# ADR-0006 — the merge request is the act of authorisation

**Date** 2026-09-21 · **Status** accepted

## Context

A CLI that turns an intent into infrastructure declarations must decide where the right to change
production is granted. `docs/design.md` § 4.2 inherits the answer from the production system it is
drawn from, but a terminal confirmation looks exactly like an approval and nothing separates them.

## Decision

The CLI will open a merge request and stop there, never pushing to the main branch; confirming
in the terminal means "I am submitting my request". `ForgeProvider` (`src/forge/provider.ts`,
§ 10, not yet built) keeps the forge behind an interface whose token may open a request, never
merge it.

## Rejected alternative

**Apply on confirmation — a single token, a commit straight to the main branch** — it fuses
submission and approval and makes the guarantee untestable: `test('the token that opens a merge
request cannot merge it')` (§ 9.4), which ADR-0015 replaced since no GitHub credential can be
scoped out of merging, has nothing left to assert once that one credential must be able to merge
for the happy path to work. The record of who authorised a change shrinks to a keystroke in
someone's terminal, and with no delete operation in v0.1 (§ 5.3) the tool cannot undo what it
wrote.

## Consequences

Nothing the tool does is provisioned by the tool: every run ends on "Nothing is provisioned yet. The
merge is what authorises it." (§ 7.4), and a user in a hurry gets no override. The tool also depends
on branch protection it cannot configure: `init platform` prints the required settings, `idpa
protection` verifies them, and every submission reads them before anything is written and again at
the moment of acting, saying where they let the pull request's author merge it alone (ADR-0015).
The live check that the identity which opens a pull request cannot merge it is the owner's live
test, never the tool's: a merge the tool attempted would be the merge nobody authorised.

Stage 5's local forge makes the first half testable: a submission cannot move an existing ref,
`main` included (ADR-0010).

Stage 6 replaces "a token that may open a request, never merge it", which no GitHub credential
can be scoped to, with the owner's invariant: idpa never merges and never writes to the base: it
opens a pull request, and the base's rules decide who may merge it (ADR-0015).
