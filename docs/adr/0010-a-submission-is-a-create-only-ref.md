# ADR-0010 — a submission is a create-only ref

**Date** 2026-09-29 · **Status** accepted, 2026-09-29 · **Builds on** ADR-0006, ADR-0011

*Accepted by the owner on 2026-09-29, after a presentation of this record and of stage 5's
task 4, with three explicit choices, each already the decision below: the base is `HEAD`,
the branch checked out, and a detached or unborn `HEAD` is refused; a catalogue file that
differs from `HEAD` in the working tree — uncommitted, untracked or ignored — makes the
submission a refusal for divergence, naming the files; and the repository's hooks and
fsmonitor never run during a submission, which is documented for teams relying on
`pre-commit` (`SECURITY.md`, *Not guaranteed, by design*). The local forge that implements it
is `src/forge/local/`.*

## Context

Stage 5 writes for the first time. § 4.2 says the CLI never writes to the main branch and § 8
says an interrupted write leaves the initial state — two sentences a directory and a diff
cannot make testable, because "the main branch" is not something a directory has. ADR-0006
makes the merge request the act of authorisation; this record says what a submission is on
this side of it. The owner drafted it in the stage-5 plan on `eee67d6` as "ADR-0008"; the
stage-5 check (`docs/stage-5-check.md`, § 5–§ 7) renumbered it and added what `main` and the
owner's decisions of 2026-09-29 require. On `main` at `d0fdee9` — 3683 tests, 19
architecture rules — one process already ran, `git ls-files` for the Inspector, and nothing
wrote into a repository but `init platform`'s scaffold.

## Decision

The local forge cuts a **real git branch through plumbing**: blobs with `hash-object`, trees
with `mktree`, a commit with `commit-tree`, and one `update-ref <ref> <commit> ""` whose empty
old value means create-only — so a submission can never move a ref that exists, `main`
included. Nothing is checked out; `HEAD`, the index and the working tree are never written.
The branch is named by the engine, under `idp-agent/`, from a digest of the bytes, which makes
it the plan's identity: the same bytes on the same base are recognised, never duplicated.

The forge accepts only a **`Cleared`**, which re-runs the free gates when minted — the
questions with the context the preview asks them in, the policies against the provenance
`signPlan` sealed into the `SignedPlan` (never one a caller hands over), the edits and the
re-check over one reading of the bytes — and refuses an empty change the repository does not
already account for. `clear.ts` registers every `Cleared` it mints in a module-private
`WeakSet`, and the forge refuses any other object: a spread, a cast or a clone of one. A
`Cleared` names **the repository it is for** — the declarations repository, or a service's —
and a forge is opened for one; a clearance for the other is refused before anything else. A
plan whose operations write into both repositories is refused by name, pointing at
`init --submit`.

The **base is `HEAD`**, and before writing the forge proves that `HEAD` holds exactly the bytes
the gates judged — at the read, and again at the moment of writing, with the base re-read. A
file the gates read that is not in `HEAD`, differs from it or is a symbolic link there, and in
the declarations repository any catalogue file of `HEAD` the gates never read, is refused. A
branch that already exists is ours only when it is a branch — not a symbolic ref — of one
commit, **on the base**, touching exactly our paths with our bytes and modes, under the
message the engine wrote; anything else is refused, never reported as submitted. The one
write never follows a symbolic ref (`update-ref --no-deref`).

Every git call goes through the one launcher every process `src/` starts goes through: in
`spawnedEnvironment()` — no provider key, no catalogue token (ADR-0011) — minus every `GIT_*`
variable, hooks and fsmonitor disabled, started outside the repository with a bound on time
and output. The author and committer identities come from git's configuration, never from a
guess — git runs with `user.useConfigOnly=true`, so with no `user.name`/`user.email`
configured it refuses rather than making one up from the login and host names — and both are
probed when the forge opens, before any model.

`plan --from … --submit` crosses four gates and no Reviewer; `plan "<intent>" --submit` crosses
five. Either way the branch cannot reach the default branch, and the merge authorises
(ADR-0006).

## Rejected alternatives

**Writing the files into `--repo`'s working tree** — it writes whatever branch is checked
out, usually `main`, so one `git commit -a` lands the change unreviewed; its atomicity is a
rename-and-rollback a SIGKILL defeats; and it adds almost nothing to `plan | git apply`,
which already works because the diff is on stdout.

**Trusting the `SignedPlan`'s wiring** — a `SignedPlan` proves the plan was signed, not that
the policies passed, the re-check found no error or no question is left; a writer that took
those verdicts from `cli/` would be the one place the engine took a caller's word for it.

**The provenance as an argument of the clearance** — the caller's word again: a caller
holding another provenance could clear a plan the policies refused.

**Two clearances from one plan that writes into both repositories** — one per forge, each
atomic alone and the pair not; not worth its cost at stage 5.

## Consequences

`--submit` needs a clone's root — resolved by the same chain `plan` already uses — a `git`
binary on `PATH` and a committer identity; a service in a subfolder of its repository is not
submitted at stage 5. A failure leaves only unreachable objects, for `git gc`: the observable
state — every ref, `HEAD`, the index, the working tree — is the initial state or the whole
branch, never part of it (§ 9.2, checked by injected failures). The repository's hooks never
run, which a team relying on a `pre-commit` hook must know: the branch is reviewed in the merge
request, not by the hook. Working-tree bytes that differ from `HEAD` only through
`core.autocrlf` are refused as divergence. A dangling symbolic ref planted at the branch name
between the check and the write is replaced by the branch, because git's create-only test
reads it as absent; nothing outside `refs/heads/idp-agent/` is written. The preview still reads a file through a symbolic
link, which the submission refuses; one primitive for both (batch B3) comes after stage 5, and
the writer does not need it, since it never writes the working tree. The Reviewer is not
re-proved at submission: it is a model and cannot be re-run for free, and the merge still
authorises.

From stage 6 the same commit is pushed to the same name on GitHub, create-only as well:
`--force-with-lease=<ref>:` with an empty expected value refuses a ref that exists, and the push
names one refspec and a URL, never a remote. Each system stays atomic on its own; the two
together are not, and each intermediate state is completed by running the same command again
(ADR-0015). On the GitHub road only, our one commit on an older base, with its open pull
request, is recognised as already submitted; the local road keeps D7. The *Decision*'s "the one
launcher every process `src/` starts goes through", left as the record it is, now means the git
launcher, `process/git.ts`: since stage 6 gh has a launcher of its own, `process/gh.ts`, and
each runs only the command shapes of its grammar.
