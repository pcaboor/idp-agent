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
request cannot merge it')` (§ 9.4) has nothing left to assert once that one credential must be able
to merge for the happy path to work. The record of who authorised a change shrinks to a keystroke in
someone's terminal, and with no delete operation in v0.1 (§ 5.3) the tool cannot undo what it wrote.

## Consequences

Nothing the tool does is provisioned by the tool: every run ends on "Nothing is provisioned yet. The
merge is what authorises it." (§ 7.4), and a user in a hurry gets no override. The tool also depends
on branch protection it cannot configure — `init platform` will print the required settings and
verify them, including a live check that the supplied token cannot merge (§ 7.2).
