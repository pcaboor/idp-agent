# ADR-0012 — declared is not provisioned

**Date** 2026-09-29 · **Status** proposed — stage 6 reads the required status check and prints
it; the check is the downstream system's · **Builds on** ADR-0006, ADR-0010, ADR-0011

## Context

The merge is the act of authorisation (ADR-0006). But a merged declaration then reaches
systems with authorities of their own: a firewall flow goes through Tufin or AlgoSec, and a
database or an application account through a DBA's queue. Those systems can refuse, or fail.
Backstage reads `main` either way, so the catalogue shows an access that was never opened. The
catalogue ends up decorrelated from reality, which is the failure this tool exists to prevent,
arriving from the other side. The owner raised it while the stage-5 plan was reviewed; the
plan drafted it on `eee67d6` as "ADR-0009", a number `main` has since given to tracing, and
the stage-5 check (`docs/stage-5-check.md`, § 6, D16) renumbered it and asked for the
credential the reconciler holds.

## Decision

Three states, never collapsed into one:

- **declared** — on `main`, merged, and so authorised by whoever merged it;
- **refused** — the downstream system's verdict;
- **provisioned** — the downstream system's verdict.

The catalogue must be able to say which of the three is true. Two mechanisms, neither built in
v0.1:

1. **Prevent, before the merge (stage 6).** The downstream decision is a required status check
   on the merge request, enforced by branch protection. A refused request is never merged, so
   the catalogue never states it. The merge becomes the *last* authorisation, not the only
   one. The branch name is a digest of its bytes (ADR-0010), which makes it the correlation
   key between the merge request and the downstream ticket.
2. **Detect, after the merge (after v0.1).** A request can be approved and then fail in
   implementation. A reconciler compares what is declared with what the downstream system
   reports, and publishes the result as the entity's *status* in Backstage, not in the YAML,
   which stays the intent. Following § 4.4, it records a date of first absence and reports
   without deleting. A human removes the declaration through a merge request.

**The reconciler is a separate component with its own credential.** ADR-0011 makes one
transport, `GET` on two routes, the only code of this tool that sends the catalogue token, and
that token is scoped to reading. Publishing a status is a write to Backstage: it is done by the
reconciler, deployed beside the catalogue with a credential of its own and nothing of this
CLI's, or ADR-0011 is amended first, in a record of its own.

## Rejected alternatives

**Writing the downstream state back into the declaration** — a `provisioned: true` that a bot
commits. That is an automaton writing to the repository whose merge is the authorisation. It
makes downstream systems into sources (§ 4.1). And a committed field that goes stale is exactly
the lie this record is about.

**Deleting a refused declaration automatically** — § 4.4 forbids it. The declaration may be the
only trace of a flow that is half open.

**The CLI publishing the status with the catalogue token it reads with** — it would turn the
one GET-only transport ADR-0011 fenced into a writer, and give every person's read token a
write it was never scoped for.

## Consequences

Stage 6 reads the base's `required_status_checks` and prints the contexts merging waits for, in
`idpa protection` and in a submission's closing lines, or says none is required and so a
downstream refusal would not stop the merge. It requires none, since nothing downstream reports
yet and the generated `validate.yml` runs no validation until the package is published: the
rule is *advised* in the one list of settings `idpa protection` checks and `init platform`
prints (ADR-0015). A declaration on `main` still means *authorised*, not *provisioned*, and
every document that describes the catalogue says so. The reconciler needs the real integrations
§ 13 keeps out of v0.1. This record stays *proposed*: its mechanism is the downstream system's.
