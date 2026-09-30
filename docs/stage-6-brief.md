# The stage 6 brief: a real forge, and the pull request as the act of authorisation

**Date** 2026-09-30 · **Status** revised after the owner's answers of 2026-09-30 (§ 18) and a
review of the revision · **Builds
on** ADR-0006, ADR-0010, ADR-0011 and ADR-0012 (proposed), design §4.2, §7.2 and §7.4, and the
stage-5 check's D4, D6, D7, D8, D11, D12 and D16 ([`stage-5-check.md`](stage-5-check.md))

This is a design note, not a plan. It says what stage 6 builds, in what order, and why each
guard exists. The plan in `docs/plans/` comes after it. The line numbers below are those of
`main` at `55fb995`. The GitHub facts are those of GitHub's public REST documentation, the
`gh` manual and the git manual, read on 2026-09-30, cited where they are used and linked at
the end.

The first draft of this note gave idpa a dedicated fine-grained token and its own REST
transport of eleven routes. The owner decided otherwise on 2026-09-30: **idpa handles no
GitHub credential at all**. The person's own `git` pushes the branch, with whatever SSH key or
credential helper they already use, and the person's own `gh` reads the rules and opens the
pull request, as Claude Code does. § 18 lists every decision as settled; § 20 records the
token design among the rejected alternatives, with what it would have bought.

**In one paragraph.** Stage 5 cuts a local branch, `idp-agent/<slug>-<8 hex>`, create-only,
and says "Nothing is pushed. No merge request is opened: this build has no forge (stage 6)"
(`src/cli/render/footer.ts:11`). Stage 6 puts that same commit on GitHub and opens a pull
request into the branch the clone tracks, and nothing more. Six rules keep this safe. First,
**idpa reads, stores and sends no GitHub secret**: `git` and `gh` authenticate as they always
do for this person, and idpa only starts them. Second, **idpa may run an explicit list of git
and gh commands and nothing else**, each argument shape fixed: one `git push` form that can only
create one `idp-agent/` ref, `gh api` with `GET` on eight routes, and one `POST` that opens the
pull request. The list is checked at run time before any process starts, and by an
architecture rule in the source (§ 6). Third, **the push trusts the person's global and system
git configuration and never the repository's**: a repository that sets a key that could
redirect the push or run a program during it is refused, and the pushed ref is read back
through `gh` before any pull request is opened (§ 7). Fourth, **no credential can be scoped
out of merging on GitHub**, so what refuses the merge is the base branch's ruleset, which idpa
reads before it writes anything **and again at the moment of acting**: it refuses to submit
unless merging needs the approval of someone else, of the exact commit that would merge, and
the person submitting cannot bypass that rule (§ 8). The invariant, as the owner worded it:
**the identity that opens a pull request cannot merge it until someone else has approved the
exact commit that would merge, and idpa never submits against a base without those rules.**
Fifth, the negative test is proved twice: offline, against a fake `gh` and a bare remote on
disk, in `pnpm test`; and live, by the owner, with their own `gh` session against a throwaway
repository (§ 10). Sixth, **nothing of GitHub reaches a model**.

> **Submitting for review, from stage 6.**
> 1. A person has `git` able to push to the declarations repository, as they already do, and
>    `gh` installed and logged in to github.com (`gh auth login`). idpa asks for no token.
> 2. The repository's administrator adds a ruleset on the default branch: a pull request with
>    one approval and approval of the most recent push, no force push, no deletion, and
>    nobody who submits allowed to bypass it (§ 8). `idpa protection --repo <clone>` says
>    whether the ruleset holds for this person, with no model and no write.
> 3. `idpa plan --from grant.json --submit` in the clone prints the diff, asks one question,
>    cuts the local branch as stage 5 does, pushes it with the person's git, opens the pull
>    request with the person's gh and prints its URL. Run again, it names the same pull
>    request and writes nothing.
> 4. Without `gh`, or with `gh` logged out, nothing is pushed: idpa cannot read the rules, so it
>    does not submit (§ 9). `--submit --local` still cuts the local branch.
> 5. What idpa never runs: a merge, an approval, a close, a reopen, a forced push, a deletion,
>    a push outside `idp-agent/`, or any `gh` command outside its list (§ 6).

---

## 1. Context

Stage 5 made the first half of ADR-0006 testable: a submission is one new ref, created with
`update-ref <ref> <commit> ""`, so it can never move `main` (ADR-0010). The second half is
still a sentence. `SECURITY.md` lists both of design §4.2's authorisation rules under
*Designed, not yet built* (`SECURITY.md`, *The merge is the act of authorisation* and *One
token per capability*). Design §9.4's first test, `the token that opens a merge request
cannot merge it` (`docs/design.md:1240`), has had nothing to call since stage 0, and design
§9.4 says so: "The first becomes real at stage 6, against a forge."

Four things are already decided and shape everything below.

- **The merge is the act of authorisation** (ADR-0006, design §4.2). The CLI opens a request
  and stops. Confirming at the terminal means "I am submitting my request". `ForgeProvider`
  has no `merge`, no `delete`, no push to a base and no way to name a branch
  (`src/forge/provider.ts:34-49`), and its comment already names this stage: "Stage 6's
  negative test calls the forge's merge endpoint directly with the token this interface
  holds, and requires it to FAIL." That comment changes in 6.2.1: the interface holds no
  token, and the test uses the person's own identity (§ 10).
- **A submission is a create-only ref, named by its bytes** (ADR-0010). The branch is
  `branchFor(edits)` (`src/core/plan/clear.ts:433-445`), a digest of the paths and bytes,
  **not of the base**, so the same change on the same base is the same branch, recognised and
  never duplicated, and the same change after the base moved keeps its name (§ 14). A branch
  of that name is ours only when it is one commit, on the base, touching exactly our paths
  with our bytes and modes, under the message the engine wrote (`src/forge/local/forge.ts`,
  `existing()`). D7 already named what stage 6 would lose without that last test: "at stage
  6 it would travel in this user's merge request".
- **The decisions about stage 6 in the stage-5 check.** D4: `plan --from … --submit` crosses
  four gates and no Reviewer, worded by route; stage 6 inherits it. D6: a plan writing into
  both repositories is refused by name; it stays refused (§ 18, decision 17). D7: our files on
  another parent are refused; stage 6 recognises a submission on an older base on the GitHub
  road only (decision 10). D8: `idpa "<phrase>" --submit` is refused; stage 6 lifts it in
  6.3.3 (decision 14). D11: `--json` carries a `submission` key whose shape a test pins
  (`src/cli/commands/submit.ts:146-157`); stage 6 widens it. D12: `init --submit` in a
  monorepo subfolder is refused; unchanged. D16: declared is not provisioned, ADR-0012,
  *proposed* until stage 6 builds its first mechanism; § 11 says what stage 6 builds of it.
- **One launcher, one environment, for every process `src/` starts.** `gitIn`
  (`src/process/git.ts`) is today the only module that starts a process, with `core.hooksPath`
  set to `/dev/null`, `fsmonitor` off, the working directory neutral, every `GIT_*` variable
  dropped, and `spawnedEnvironment` (`src/process/environment.ts:23-44`) removing every
  `*_API_KEY` and `IDP_BACKSTAGE_*` variable. Its comment keeps a `GITHUB_TOKEN` on purpose:
  "`git` may need one, and neither is this tool's". Under the owner's model that sentence
  becomes the rule rather than the exception: **no GitHub credential is this tool's**. Stage 6
  adds a second launcher, for `gh`, held to the same shape (§ 5, § 6).

What makes stage 6 more than a wrapper around two programs is one fact about GitHub that no
stage-5 document states: **an identity that can create a branch on a repository can also merge
a pull request into it**. Whatever the credential (an SSH key, `gh`'s OAuth token with its
`repo` scope, a fine-grained token with *Contents: write*), the right to push a branch is the
right that merges, merges a branch without a pull request, commits a file onto `main` and
moves `main` ([fine-grained permissions][fg-perms]). "One token per capability", as design
§4.2 words it, cannot be delivered by any credential's scope on GitHub, and under the owner's
model idpa does not even choose the credential. What can be delivered is the owner's
sentence: the base branch's ruleset, which the person submitting must not be able to bypass,
keeps that person from merging **until someone else has approved the exact commit that would
merge**; and idpa refuses to submit anywhere that rule does not stand. After that approval the
opener can merge, as the approver can: that is GitHub's model of review, and the approval of
exactly those bytes by another person is what the merge then carries.

## 2. Goal and non-goals

**Goal.** In a clone whose checked-out branch tracks a branch on github.com, with `gh`
installed and logged in to github.com, `plan --from … --submit`, `plan "<intent>" --submit`,
`init --submit` and `idpa "<phrase>" --submit`:

- cut the local branch exactly as stage 5 does, then push that very commit, create-only, to
  the same branch name on GitHub with the person's own git, and open one pull request from it
  into the tracked branch with the person's own gh;
- recognise, before anyone is asked to confirm, a submission already made: a branch on GitHub
  that is exactly this change, with or without its pull request, on this base or on an older
  one, and a pull request already open, closed or merged for it;
- refuse to submit when the base branch's ruleset, as the person's gh reads it, would let the
  pull request merge without someone else's approval of its latest commit, or would let this
  person bypass that rule; refuse a base protected only by classic branch protection; and read
  the rules again at the moment of acting;
- print the pull request's URL, built by the engine, and never report success where a step
  failed.

**Non-goals.**

- **No GitHub credential in idpa.** No token variable, no token flag, no token in a
  configuration file, no `gh auth token`, no credential helper written or read by idpa (§ 5).
- **No merge, approval, review, comment, close, reopen, label or assignment**, and no forced
  push, no deletion, no push outside `refs/heads/idp-agent/`. None of these is on the
  allow-list (§ 6). Reviewers come from the repository's `CODEOWNERS`, which `init platform`
  writes.
- **No change to the repository's settings.** idpa never creates a ruleset, a branch
  protection, a webhook or a deploy key, and has no command that could.
- **No `git fetch`, `clone` or `pull`.** The person brings the clone level with GitHub; idpa
  says when it is not (§ 4).
- **No `gh pr create`.** The pull request is opened with one `gh api` `POST`, whose body the
  engine builds (§ 6, § 20).
- **No fork workflow.** The branch is pushed to the base repository. A person who can only
  fork cannot submit in stage 6 (§ 20).
- **No GitLab, no GitHub Enterprise in the tested scope.** Enterprise is later, through `gh`'s
  own host configuration (§ 18, decision 16); design §13 keeps GitLab for v0.2.
- **No downstream integration.** ADR-0012's required status check is read and printed, never
  created or satisfied by this tool (§ 11).
- **No model sees anything of GitHub** (§ 12).

## 3. The flow

```
idpa plan --from grant.json --submit                 (in a clone of github.com/acme/iac)
  1. open       forge/local        stage 5: a clone's root, git, an identity, base = main@abc1234
  2. remote     forge/github       main's upstream: branch.main.remote = origin,
                                   branch.main.merge = refs/heads/main;
                                   `git remote get-url --all origin` and `--push --all`
                                   → github.com / acme / iac; userinfo refused, unquoted (§ 13);
                                   the repository's own configuration checked for keys that
                                   redirect a push or run a program (§ 7)
  3. gh         forge/github       gh present; `gh api user` on github.com answers a person
                                   (§ 5); otherwise exit 2, nothing written (§ 9)
  4. preflight  forge/github       through gh, GET only: the repository, the rules for main,
                                   each ruleset they come from, main's branch, main's ref:
                                   rules as § 8 requires, this person cannot bypass them,
                                   and main on GitHub is abc1234
                                   — on the intent road, steps 2 to 4 before any model
  5. gates      unchanged          four on --from, five on an intent (D4)
  6. recognise  forge/local, then  the local branch (stage 5, § 14); then, through gh, the ref
                forge/github       of idp-agent/…, its commit, the pull requests from it
  7. confirm    cli/               the diff, then one question naming the pull request (§ 14)
  8. re-check   forge/github       at the moment of acting (design §4.2, §4.4): the repository
                                   configuration, the rules, the rulesets and main's ref again;
                                   nothing is written anywhere before this passes
  9. local      forge/local        update-ref <ref> <commit> "" (stage 5)
 10. push       forge/github       the person's git: that commit to refs/heads/idp-agent/…,
                                   create-only (--force-with-lease=<ref>: , § 4)
 11. verify     forge/github       through gh: GitHub's idp-agent/… is exactly that commit;
                                   then the rules for main and each supplying ruleset's
                                   bypass answer once more (§ 8 items 2 and 3)
 12. open       forge/github       through gh: POST the pull request, the engine's body
 13. say        cli/               the URL (engine-built), the checks merging waits for, CLOSING
```

Steps 1, 5, 7 and 9 are stage 5's. Steps 2 to 4, 6, 8 and 11 read and write nothing. Steps 10
and 12 are the only writes on GitHub, one ref and one pull request. Step 8 comes before the
local ref, so a refusal there leaves nothing behind on either side, and the window between it
and the push is one local `update-ref`. The pull request, the act the invariant calls
submitting, comes after the push, which may last up to 120 s while the person types an ssh
passphrase (§ 15); so step 11 reads the rules again, after the read-back and immediately
before the `POST`. A ruleset gone or bypassable by then stops the run at the row *the branch
on GitHub, no pull request*, exit 1, and the next run refuses at the preflight, before
anything more is written. The window left is one read-back and one `POST`.

**A worked example.** The owner's throwaway repository, a clone at `~/idpa-live` tracking
`github.com/<owner>/idpa-live`, the owner logged in to gh:

```text
$ idpa plan --from examples/open-network.json --repo ~/idpa-live --submit
deciding against ~/idpa-live (--repo)
submitting to github.com/<owner>/idpa-live, into main (origin, main's upstream), as <owner> (gh)
--- /dev/null
+++ b/dependencies/network/orders-api-to-payments.yml
…
1 file · not yet submitted — it would become idp-agent/orders-api-to-payments-e9e6183f
Nothing is provisioned yet. The merge is what authorises it.
Push idp-agent/orders-api-to-payments-e9e6183f to github.com/<owner>/idpa-live with your git, and open a pull request into main with your gh? Nothing is provisioned until someone else approves it and it is merged. [y/N] y
1 file · submitted as idp-agent/orders-api-to-payments-e9e6183f on top of main@abc1234 · main untouched
Pull request #3 opened on github.com/<owner>/idpa-live: https://github.com/<owner>/idpa-live/pull/3
Merging it waits for one approval of its latest commit from someone other than you. No status check is required, so a system downstream could not refuse it (ADR-0012).
Nothing is provisioned yet. The merge is what authorises it.
```

Run again:

```text
1 file · already submitted as idp-agent/orders-api-to-payments-e9e6183f · pull request #3 is open · nothing written
```

## 4. How the branch reaches GitHub

**With the person's own `git push`, in one form.** The local forge has cut the commit at step
9; step 10 sends exactly that commit, never a branch name to resolve, to exactly one
destination ref:

```text
git --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.untrackedCache=false
    -c user.useConfigOnly=true
    -c protocol.ext.allow=never -c protocol.file.allow=never -c http.followRedirects=false
    -c push.followTags=false -c push.recurseSubmodules=no -c push.gpgSign=false
    -C <clone> push --porcelain --no-verify --no-follow-tags --no-recurse-submodules --no-signed
    --force-with-lease=refs/heads/idp-agent/<slug>-<8 hex>:
    <url> <commit>:refs/heads/idp-agent/<slug>-<8 hex>
```

Each part answers something.

- **`--force-with-lease=<ref>:` with an empty expected value is the create-only write on the
  remote side.** git's manual: "If *<expect>* is the empty string, then the named ref must not
  already exist" ([git push][git-push]). The expectation travels to the server as the ref's old
  value in the push command itself, so a ref created between our read and our push refuses the
  push rather than being overwritten. A plain push, without the lease, is not create-only: it
  fast-forwards a ref that exists when our commit descends from it, and a stranger's
  `idp-agent/…` pointing at `main` would be moved. The lease is the only form of force the
  allow-list admits, with this exact shape, and only ever on the one ref it names (§ 6).
- **`<commit>:refs/heads/…`, one refspec.** The source is the 40- or 64-hex commit step 9 cut
  and recognised; git allows any object name as the source when the destination is a full ref
  name ([git push][git-push]). No `--all`, `--mirror`, `--tags`, `--delete`, `--prune`, no
  second refspec, no `+`. `--porcelain` gives one machine-readable line per ref, whose flag
  (`*` a new ref, `=` up to date, `!` rejected) is all idpa reads of the push's output.
- **`<url>`, never the remote's name.** Pushing to a name consults `remote.<name>.push`
  refspecs, `remote.<name>.mirror`, `remote.<name>.receivepack` and `remote.<name>.proxy`.
  Pushing to a URL consults none of the tracked remote's — but git looks the URL up as a
  remote's name first, so a section named after the URL itself (`[remote
  "git@github.com:acme/iac.git"]`) would decide where the push goes (measured, git 2.46): § 7
  refuses every such section in the clone's own configuration. The URL is the one `git remote get-url --push`
  printed at step 2, after git expanded every `insteadOf` and `pushInsteadOf`, parsed as one of
  the five GitHub forms of § 13 and required to name the same host, owner and repository as
  the fetch URL. It is passed as one argument, after the options, and a URL beginning with `-`
  is refused by the parser before it gets there.
- **Hooks off, twice.** `core.hooksPath=/dev/null` is already on every call (`HARDENING`), and
  `--no-verify` bypasses `pre-push` "completely" ([git push][git-push]). A repository's hooks
  are its author's code, and this tool does not run it.
- **No tags, no submodules, no signature, no ext, no file.** A global `push.followTags=true` would push
  every annotated tag reachable from the commit; a `push.recurseSubmodules=on-demand` would push
  other repositories; `push.gpgSign` would run `gpg.program`. Each is pinned on the command
  line, which outranks every configuration file ([git config][git-config]), and the matching
  flag is given as well. `protocol.ext.allow=never` keeps the one transport that runs a command
  line off even if a global configuration enabled it, and `protocol.file.allow=never` the one
  that reaches this machine: a push to GitHub never needs it, and git starts a local
  `git-receive-pack` without the command line's pins, so the target's hooks would run.
  `http.followRedirects=false` stops a
  renamed repository's redirect from carrying the push elsewhere; the person is told to check
  the remote's URL.
- **The same environment rules as every git call, and the person's configuration for
  credentials** (§ 5, § 7).

**The pushed ref is read back before anything is opened** (step 11). Through gh, `GET
repos/{o}/{r}/git/ref/heads/idp-agent/…` must answer exactly the commit idpa pushed. That read
goes to the host gh is logged in to, github.com, and names the owner and repository parsed from
the remote, so it proves the push reached the repository the pull request will be opened on,
whatever the person's global configuration did to the URL on the way. The two failures are
told apart:

- **a 404** may be GitHub's API not showing yet a ref the push has just created, so the read is
  made at most three times over about two seconds (0.5 s, then 1.5 s), counted in § 15's
  budget, before anything is concluded. Still 404 after the third read: exit 1, nothing
  opened, and a sentence that does not accuse: "idp-agent/… was pushed, and github.com/acme/iac
  does not show it yet. If your git configuration rewrites this URL (url.*.insteadOf), the push
  went elsewhere; otherwise run the same command again, which opens the pull request once
  GitHub shows the branch";
- **a ref that exists with another commit** is not lag: someone moved it after the push, or
  the push went elsewhere and a branch of that name was already there. Exit 1, nothing opened,
  and the next run meets § 14's "not ours" row.

The live test records whether any lag was seen. This is how § 18's "the remote host must match
gh's host" is enforced: by reading the result, not by predicting git.

**What this costs, and what it simplifies.**

- **The remote commit is the local commit, byte for byte.** The first draft rebuilt the commit
  through the REST API and could not promise the same SHA. A push sends the objects
  themselves, so the SHA is identical, the tree-SHA check of the first draft disappears, and
  recognition compares SHAs first.
- **idpa now depends on two programs it does not ship**, and on the person's configuration of
  them. The allow-list (§ 6) and the repository-configuration check (§ 7) are what bound that
  dependency; § 9 is what happens when gh is missing.
- **A base the remote does not have cannot be built on.** The base check below makes that a
  stated refusal before any write.
- **No signature.** The local commit is unsigned (`commit-tree` without `-S`) and so is the
  pushed one. A base whose ruleset has `required_signatures` refuses the merge; stage 6
  reports that rule in the preflight (§ 8) and does not sign.

**Comparing trees without writing one.** Recognition (step 6) runs before the local commit
exists and, like stage 5's `recognise`, writes no object (`src/forge/local/forge.ts:247-254`).
When GitHub holds an `idp-agent/…` ref whose commit is not a local one (another clone pushed
it, or the local branch was deleted), the tree that change would have is computed, not built:
`treeFor(parent, edits)` in `forge/local` reads the parent's trees along each edited path with
`ls-tree`, replaces the entries with the edits' blob ids and modes, and hashes each tree as git
does, in JavaScript, as `blobId` already hashes a blob. It is compared with the remote commit's
tree SHA from `GET git/commits/{sha}`. The same function answers the older-base case of § 14.
A clone of GitHub is a SHA-1 repository; the function takes the object format the local forge
already reads.

**The base is exactly the remote tip.** The pull request's base is the branch the checked-out
branch tracks, and before anything is written idpa reads that branch's ref through gh (`GET
repos/{o}/{r}/git/ref/heads/{base}`) and requires it to equal `HEAD`'s commit. Stage 5 already
proves the working tree equals `HEAD`; this adds `HEAD` equals GitHub's `main`, so the bytes
the gates judged are the bytes the pull request is reviewed against. Two cases are refused,
exit 1, before any model on the intent road and again at step 8:

- local `main` has commits GitHub's does not: pushing the branch would carry them into this
  person's pull request, the case D7 named;
- GitHub's `main` has moved past local `main`: the plan was decided against an old
  repository, and design §4.4 says check the repository before proposing and again at the
  moment of writing. Someone may have declared the same grant since.

```text
not submitted — github.com/acme/iac's main is at def5678 and this clone's main is at abc1234:
bring them level (git pull), then run this again. If you submitted this change before, the
next run names its pull request. Nothing was written.
```

**Atomicity across two systems.** Each system stays atomic on its own: the local ref is
ADR-0010's; on GitHub, a push either creates the ref or does not (one ref, one command). The
two systems together cannot be atomic, and the note does not claim they are: design §8's
"nothing a person can observe exists before the branch's ref is created" and §9.2's "failure
⇒ initial state intact" hold per system, and their wording changes in 6.4.2 to say so. The
intermediate states are named instead, each completed by running the same command again:

| After a failure at | What exists | What the next run does |
|---|---|---|
| step 8 (re-check refused) | nothing, on either side | refuses or proceeds on what it reads then |
| step 9 (local) | nothing, or the whole local branch | stage 5's recognition, then continues to GitHub (§ 14) |
| step 10 (push refused or interrupted) | the local branch; on GitHub, nothing, or the ref if the push landed and its answer was lost | pushes again; a ref that landed is recognised as ours by its SHA (`=` or a lease refusal read back through gh) |
| step 11 (the ref does not read back) | the local branch; the pushed ref somewhere else | refuses again until the person's configuration sends the push to github.com |
| step 11 (the rules no longer hold) | the local branch; the branch on GitHub, no pull request | refuses at the preflight until the ruleset is back; then opens the pull request |
| step 12 (the pull request not opened) | the local branch; the branch on GitHub, no pull request | recognises the branch as ours and opens the pull request |
| after step 12 | everything | "already submitted", names the pull request |

A run that stops at step 12 says so and exits 1:

```text
1 file · idp-agent/orders-api-to-payments-e9e6183f is on github.com/acme/iac, and the pull request was not opened: GitHub answered 502 through gh. Run the same command again to open it.
```

## 5. Credentials: idpa holds none

**The model is Claude Code's.** Claude Code pushes with the person's git and opens pull
requests with the person's gh; it never asks for a GitHub token. Stage 6 does the same. The
person's SSH key, ssh-agent, credential helper (`osxkeychain`, Git Credential Manager,
`gh auth git-credential`) and gh's stored login stay where the person put them. idpa:

- reads no GitHub secret, in no variable, file, flag or program output: it never runs `gh auth
  token`, never reads `hosts.yml`, never runs `git credential`, and indexes the environment by
  no credential's name (an architecture rule, § 6);
- passes the person's environment on to git and gh unread, minus what § 5's table removes;
- never puts a credential in an argument, in standard input, on stdout or stderr, in a trace,
  in a pull request body or in a model request (the key-reach legs, § 10).

**Who the identity is.** Before the preflight, `gh api user` names the account gh acts as.
Its `login` is printed on the "submitting to" line; its `type` must be `User`. A `Bot`, or an
identity for which `/user` is refused (a GitHub Actions `GITHUB_TOKEN` or an App's
installation token answer so), is refused with exit 2: the author of the pull request would
then be a bot, and **the person who asked could approve their own request**, which is exactly
what the invariant forbids. § 19 asks the owner to confirm this rule.

**Exactly which variables pass.** Both launchers start from `spawnedEnvironment`, which already
removes every `*_API_KEY` and every `IDP_BACKSTAGE_*` whatever its case, and add:

| Variable | git (every call) | git push | gh | Why |
|---|---|---|---|---|
| `*_API_KEY`, `IDP_BACKSTAGE_*` | removed | removed | removed | ADR-0011; neither program has a use for them |
| `GIT_*` | removed | removed, except the four below | removed | `GIT_DIR` from a hook sent git to another repository; `GIT_CONFIG_PARAMETERS` undoes the pins (`src/process/git.ts`) |
| `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT`, `GIT_ASKPASS` | removed | **kept** | removed | the person's way of reaching GitHub, set in their shell, the environment counterpart of `core.sshCommand` and `core.askPass` in their global configuration |
| `SSH_AUTH_SOCK`, `SSH_ASKPASS`, `DISPLAY` | kept | kept | kept | the ssh-agent that holds the person's key, and its passphrase prompt |
| `HOME`, `XDG_CONFIG_HOME`, `PATH` | kept | kept | kept | where the global git configuration, `~/.ssh` and gh's configuration are; where the programs are |
| `GH_TOKEN`, `GITHUB_TOKEN` | kept | kept | kept | **gh's own login**, first in gh's precedence ([gh environment][gh-env]), and what `gh auth git-credential` hands git. idpa never reads their value; a person who authenticates gh that way keeps doing so |
| `GH_CONFIG_DIR` | kept | kept | kept | where gh keeps its login; the live test's second account uses it (§ 10) |
| `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | kept | kept | removed | only for an Enterprise Server host, which stage 6 never addresses |
| `GH_HOST`, `GH_REPO` | kept | kept | **removed** | each would point gh at another host or repository ([gh environment][gh-env]); every gh call names both explicitly anyway |
| `GH_DEBUG`, `DEBUG`, `GODEBUG` | kept | kept | **removed** | `GH_DEBUG=api` logs HTTP traffic to stderr, which idpa would then hold; gh is a Go program, and `GODEBUG=http2debug=2` makes Go's HTTP/2 client log frames and request headers to the same stderr, and other `GODEBUG` settings change TLS and HTTP behaviour idpa does not reason about. git's own tracing (`GIT_TRACE_CURL`) goes with every `GIT_*` |
| `GH_FORCE_TTY`, `CLICOLOR_FORCE` | kept | kept | **removed** | force terminal formatting into output idpa parses |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR` | kept | kept | kept | the person's network, used by curl and by gh |
| set by idpa | `LC_ALL=C`, `LANGUAGE=C`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` | the same | `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `NO_COLOR=1`, `GH_PAGER=cat` | a message reads the same everywhere; git and gh never wait for an answer on the terminal; nothing decorates output idpa parses |

Everything else in the person's environment passes, as it would to their own `git push`: the
table names what is removed or set, not an allow-list of what passes, because a corporate
proxy, CA bundle or credential manager has variables of its own that idpa cannot enumerate.
`GIT_TERMINAL_PROMPT=0` stops git asking for a username or password; it does not stop ssh
asking for a key's passphrase on the terminal, which ssh reads from `/dev/tty` and the person
answers as for their own push. The push therefore has a longer timeout (§ 15).

`spawnedEnvironment`'s comment on `GITHUB_TOKEN` stays true and becomes the rule: "`git` may
need one, and neither is this tool's". `src/core/schemas/config.ts:7-8` and design §7.0's
"the forge token from `GITHUB_TOKEN` or `gh auth`" (`docs/design.md:875`) change in 6.4.2 to
say idpa holds no forge credential; gh and git hold them.

**What idpa can still guarantee when the person's credentials are an administrator's.** gh's
login carries the `repo` scope over every repository the account reaches, and an SSH key pushes
wherever the account can; idpa does not narrow either. What it guarantees is about **its own
acts and the base's rules**, not the credential:

- idpa runs no command that merges, approves, bypasses, deletes, forces, moves a ref that
  exists or changes a setting: none is on the allow-list, the launcher refuses it before a
  process starts, and the source cannot name one (§ 6);
- idpa opens a pull request only when the base's ruleset binds this identity with
  `current_user_can_bypass` `never` (§ 8). For an administrator who is not in the bypass
  list, that is what GitHub answers, and GitHub then refuses that administrator's merge,
  `gh pr merge --admin` included, until someone else approves the head (recorded live, § 10);
- idpa reports the role it reads (`permissions.admin` and `permissions.maintain` in `GET
  repos/{o}/{r}`) on the "submitting to" line, and decides nothing on it (decision 6).

What it cannot guarantee: an administrator can edit or disable the ruleset, or add themselves
to its bypass list, on the web page or with their own gh, outside idpa, and then merge. GitHub
records ruleset changes in the ruleset's history and the audit log. A ruleset set at the
**organisation** level cannot be changed by a repository administrator, which is why § 8 prints
it as *advised*. `idpa protection` and `SECURITY.md` state the limit once, in the owner's
words and § 8's: **as long as the base's ruleset stands and binds the identity that opens the
pull request and every credential that person pushes with**. idpa reads the first and cannot
read the second (§ 8, *What no read can see*): the ruleset binds gh's account, and a push key
of another account or a deploy key in the bypass list is outside what gh can answer.

## 6. The allow-list: what idpa may run

**Two launchers, one shape.** `src/process/git.ts` stays the only module that starts git;
`src/process/gh.ts` becomes the only module that starts gh, and the architecture rule that
"only `process/git.ts` starts a process" becomes "only `process/git.ts` and `process/gh.ts`",
counted in `AGENTS.md`. Both run the program by name through `execFile` with no shell, from
the neutral directory (the running Node's), with the environment of § 5, a timeout and an
output cap. For gh the neutral directory matters twice: gh fills `{owner}` and `{repo}` "from
the repository of the current directory" ([gh api][gh-api]), and a hostile repository's
remotes must not choose where a request goes. No gh call uses a placeholder; each names the
host with `--hostname` and the path in full.

**The list is a grammar, checked at run time.** Each launcher takes a typed request, builds
the argument vector from it, and then checks the finished vector against its grammar before
starting the process; anything else throws a programming error and starts nothing. The check
is on the final vector, not on the request, so a builder bug cannot pass a shape the grammar
does not know.

*git.* Stage 5's commands, each in the argument shapes the forge and the Inspector use today:
`rev-parse`, `var`, `symbolic-ref`, `rev-list`, `diff-tree`, `cat-file`, `check-ref-format`,
`hash-object -w --stdin --no-filters`, `commit-tree`, `update-ref --no-deref … ""` (create-only,
as ADR-0010), `ls-tree`, `mktree`, `ls-files`. Stage 6 adds three reads and one write:

- `config --list --show-scope -z` (the scope check of § 7) and `config --get` of
  `branch.<name>.remote` and `branch.<name>.merge`;
- `remote get-url --all -- <name>` and `remote get-url --push --all -- <name>`, the remote's name
  held to § 13's grammar and placed after `--`, so a name read from a hostile configuration
  can never be an option;
- `merge-base --is-ancestor <sha> <sha>` (the older base of § 14);
- `push`, in exactly the form of § 4: the listed `-c` pins, the five flags, one
  `--force-with-lease=refs/heads/idp-agent/<slug>-<8 hex>:` with an empty expected value, one
  URL of § 13's grammar, and one refspec `<hex commit>:refs/heads/idp-agent/<slug>-<8 hex>`
  whose ref equals the lease's and matches `^refs/heads/idp-agent/[a-z0-9-]+-[0-9a-f]{8}$`.

Never: `push` in any other form (`--force`, `-f`, `+` in a refspec, `--delete`, `-d`,
`--mirror`, `--all`, `--tags`, `--prune`, `--follow-tags`, `--set-upstream`, a second
refspec, a remote name), `fetch`, `pull`, `clone`, `merge`, `rebase`, `reset`, `checkout`,
`branch -d`/`-D`, `tag`, `update-ref -d`, `credential`, `config` with a write.

*gh.* Exactly three shapes:

- `gh --version`;
- `gh api --hostname github.com --method GET --include <path>`, the path one of eight
  templates, each value held to its grammar (§ 13) and encoded: a value that is a ref name
  (`{base}`, `idp-agent/…`) is split on `/`, each component percent-encoded as a URI component,
  and the components joined with a literal `/`, which is how `git/ref/heads/release/1` and
  `branches/release/1` are addressed; a query value (`head=`) is encoded whole. **The finished
  path may hold no `{` or `}`**: gh replaces `{owner}`, `{repo}` and `{branch}` in an endpoint
  "with values from the repository of the current directory or the repository specified in the
  `GH_REPO` environment variable" ([gh api][gh-api]), and the grammar already refuses both
  characters in a base, so the launcher's check is the second fence:
  - `user`
  - `repos/{o}/{r}`
  - `repos/{o}/{r}/branches/{base}`
  - `repos/{o}/{r}/rules/branches/{base}?per_page=100`
  - `repos/{o}/{r}/rulesets/{id}`
  - `repos/{o}/{r}/git/ref/heads/{base or idp-agent/…}`
  - `repos/{o}/{r}/git/commits/{sha}`
  - `repos/{o}/{r}/pulls?head={o}:{idp-agent/…}&state=all&per_page=100`
- `gh api --hostname github.com --method POST --include repos/{o}/{r}/pulls --input -`, the
  **one** write, its body on standard input: a JSON object the engine builds with exactly
  `title`, `head` (the bare `idp-agent/…` name, never `owner:branch` of another), `base` (the
  base step 8 read), `body` (§ 12), `draft: false` and `maintainer_can_modify: false`.

`--method` is always explicit, because gh's default "is `GET` normally and `POST` if any
parameters were added" ([gh api][gh-api]). Never: `-f`, `-F`, `--field`, `--raw-field` (the
last two switch the method, and `-F @file` reads a file), `--input` on a `GET` or with anything
but `-`, `--paginate`, `--verbose` ("full HTTP request and response"), `-H`, `--cache`,
`--jq`, `--template`, `--hostname` other than the remote's host, and every other gh command:
`auth` (so never `auth token`), `pr` (so never `pr merge`, `pr merge --admin`, `pr review`,
`pr close`), `repo`, `ruleset`, `workflow`, `extension`, `alias`, `browse`. A `PUT`, `PATCH`
or `DELETE`, the `/merges`, `/contents/`, `/reviews`, `/update-branch`, `/merge` and
`/graphql` paths are not in the grammar.

**The source cannot name a door either.** The architecture rules, beside the runtime check:
under `src/`, no file but `process/git.ts` and `process/gh.ts` starts a process; only
`forge/github/` builds a gh request; no file names `pr merge`, `--admin`, `/merges`,
`/contents/`, `/graphql`, `/reviews`, `update-branch`, `auth token`, `--mirror`, `--delete`,
`--tags` or a bare `--force` argument; no file indexes `process.env` by `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`. In `tests/`, only
`tests/live/` and `tests/support/fake-gh.ts` may name a door, because they try them.

**Output is parsed, never printed.** `--include` puts gh's status line and headers before the
body, so idpa reads the status without trusting an exit code alone; gh's documented codes are
0, 1, 2 (cancelled) and 4 (authentication required) ([gh exit codes][gh-exit]). The body is
parsed as JSON within its bound, and only the fields a route needs are read, each against a
schema. A push's output is its `--porcelain` flag line; git's and gh's stderr are read to
classify a failure (§ 15) and never printed. What reaches the terminal is an engine sentence,
with any value that came from GitHub or the repository (a branch, a context name) through
`inertLine`, as a branch is today (`src/cli/render/footer.ts`, `baseOf`).

## 7. A hostile repository

A clone is the one thing on the person's machine that someone else wrote. Its `.git/config`
comes from whoever set the clone up, a script, or a repository that was copied rather than
cloned, and git reads it on every call, after the global and system files and before the
command line ([git config][git-config]). The launcher already pins what could run a program on
a read (`core.hooksPath`, `core.fsmonitor`). A push reaches further: a URL rewrite, an SSH
command, a credential helper, a proxy.

**What is feasible.** git has no variable that skips the repository's own configuration: the
manual's variables replace or skip the *global* and *system* files (`GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`), and the repository's file can be singled out only
for a read, with `--local` ([git config][git-config]).
`GIT_CONFIG_NOSYSTEM` skips the *system* file, which is where Apple's git and Git for Windows
set the credential helper the person relies on, so it would break the case that works and fix
nothing. A `-c key=` on the command line outranks the repository for a single-valued key, but
cannot remove a key with an unknown subsection (`url.<anything>.insteadOf`,
`credential.<url>.helper`), and `-c credential.helper=` empties the list for the person's
global helper too. So the design is **pin what is idpa's to decide, and refuse what is the
person's to fix**:

- **Pinned on every push** (§ 4): hooks, `protocol.ext.allow`, `protocol.file.allow`,
  `http.followRedirects`, tags, submodules, signing.
- **Refused, exit 2, before any model and again at step 8**, when set at the `local` or
  `worktree` scope (read with `git config --list --show-scope -z`, which reports a value from
  an included file with the scope of the file that includes it, so an `include.path` cannot
  hide a key): any key in the sections `url`, `credential`, `http`, `protocol`, `ssh`, `gpg`
  and `push`; `core.sshCommand`, `core.askPass`, `core.gitProxy`; `remote.<name>.vcs`,
  `.receivepack`, `.uploadpack`, `.proxy`, `.proxyAuthMethod`; and every key of a `remote`
  section whose name is not a remote's name, as one named after a URL is (below). These are the keys that choose
  where a push goes, who authenticates it, or what program runs during it. The refusal names
  the key and its scope, never its value, and gives the command that moves it.

  **Whole sections, on purpose.** Refusing a section rather than a list of dangerous keys
  trades false positives for a list nobody has to keep complete: git adds keys to `http`,
  `ssh` and `credential` in most releases, and a list that missed one would let a repository
  redirect a push. The false positives are known and harmless-looking local settings,
  `http.postBuffer` on a large repository, `push.autoSetupRemote`, `gpg.format=ssh` for
  signing; so the refusal skips exactly these two-part keys, with no subsection, each of which
  changes a buffer, a timeout or what a push to a remote *name* does (idpa pushes to a URL):
  `http.postBuffer`, `http.lowSpeedLimit`, `http.lowSpeedTime`, `push.default`,
  `push.autoSetupRemote`, `gpg.format`. `gpg.format` chooses a signing program only when a
  signature is made, and the push pins signing off. Any other key of these sections at the
  `local` or `worktree` scope is refused, and `docs/submitting.md` names the common ones and
  the one-line move to the global configuration:

```text
idpa: this clone's own configuration sets credential.helper (local), which would decide who
pushes for you; idpa pushes only with your global git configuration. Remove it with
`git config --local --unset-all credential.helper`, or set it globally, then run this again.
Nothing was written.
```

- **Read and checked, not refused**: `remote.<name>.url` and `remote.<name>.pushurl` live in
  the repository by nature. They are read through `git remote get-url` and required to parse
  as github.com, the same owner and repository for fetch and push, and no userinfo (§ 13).
  Because the push names the resulting URL rather than the remote, no other key of the
  tracked remote takes part. A remote **section named after that URL** would: git looks a
  push's destination up as a remote's name before it reads it as a URL, so a hand-written
  `[remote "git@github.com:acme/iac.git"] url = …` would send the push where it says, and a
  path there would run that repository's `pre-receive` hook (measured, git 2.46). Every
  push form holds `:`, which no remote's name does, so a `remote.<subsection>.*` key whose
  subsection is not a remote's name this build reads is refused like the keys above.

What the person's **global and system** configuration does is theirs, as it is for their own
`git push`: a global `url."git@github.com:".insteadOf https://github.com/` is common and
harmless. A global rewrite that sends github.com somewhere else is caught after the fact by
step 11, which reads the ref back from github.com through gh and opens nothing if it is not
there.

**Which remote, which host.** The remote is the one the checked-out branch tracks (§ 13). The
host is github.com, parsed from the remote's URL (the SSH-over-443 and SSH-CA forms map to it),
and every gh call is sent with `--hostname github.com`. A remote on any other host takes the
stage-5 road (§ 13). gh must be logged in to that host: `gh api user` answering 4 is "gh is not
logged in to github.com" (§ 9).

## 8. What the tool checks at run time

Design §7.2 says that from stage 6 the tool **verifies** the branch protection it prints,
"including a live check that the supplied token can open a request but cannot merge one — and
refuses to report success until that check passes" (`docs/design.md:1027-1030`). This section
defines that check, and says which half of it the tool cannot run.

**The merge is never attempted by the tool.** A live check that tries to merge succeeds on a
repository where it should have failed, and that success is a merge nobody authorised. A merge
command in the tool is the one line ADR-0006 says has no method, and the allow-list has no
shape for it. So "cannot merge" is established in two parts: what the person's gh can read,
checked on every submission, and what only a merge attempt can prove, proved on a throwaway
repository by the live test (§ 10).

**What every submission checks, through gh and with `GET` only, before anything is written**
(step 4, and on the intent road before any model), **and again at the moment of acting**:
at step 8, items 2 to 4 with the base ref, before the local ref and before the push; and at
step 11, items 2 and 3, after the push and before the pull request is opened:

1. **The identity and the repository.** `gh api user` answers a `User` (§ 5). `GET
   repos/{o}/{r}` answers; the repository is not archived; its `full_name` is, ignoring case,
   the one parsed from the remote (a renamed or transferred repository may answer under its
   new name, and a different name means "the repository was renamed or transferred; update the
   remote's URL"); and
   `permissions.push` is true, else "you cannot push to acme/iac" before any write.
2. **The rules.** `GET repos/{o}/{r}/rules/branches/{base}?per_page=100` holds, for the base:
   - a `pull_request` rule with `required_approving_review_count` of at least 1, **and**
     `require_last_push_approval` or `dismiss_stale_reviews_on_push` true;
   - a `non_fast_forward` rule (no force push) and a `deletion` rule.

   This endpoint returns every *active* ruleset rule that applies to the branch, repository,
   organisation and enterprise alike, each with the `ruleset_id` it comes from ([rules for a
   branch][rules-branch]); anyone with read access can see active rulesets ([about
   rulesets][rules-about]). Rules in *evaluate* mode are not returned, so a ruleset being
   trialled does not count, rightly. An answer with a `Link: rel="next"` is refused, not
   followed: a hundred rules on one branch is not a repository this build reasons about.
3. **This person cannot bypass them.** For each ruleset id that supplies a required rule of
   item 2 (at most ten, else refused), `GET repos/{o}/{r}/rulesets/{id}` returns
   `current_user_can_bypass`, "the bypass type of the user making the API request for this
   ruleset", one of `always`, `pull_requests_only`, `never`, `exempt` ([get a repository
   ruleset][ruleset-get]). The user making the request is gh's identity, the same that will
   open the pull request. **A rule counts toward item 2 only when its ruleset answers
   `never`.** `always` and `exempt` mean the ruleset does not bind this person;
   `pull_requests_only` is exactly the person who may merge their own pull request past the
   approval. A field that is absent counts as not `never`.

   **`current_user_can_bypass` describes gh's account, never the push credential.** The push
   uses the person's SSH key or credential helper, which may be a deploy key or another
   account's; a bypass actor can be a `DeployKey`, an `Integration`, a `User`, a `Team`, a
   `RepositoryRole` or `OrganizationAdmin` ([get a repository ruleset][ruleset-get]). Whoever
   holds a bypassing credential can fast-forward `main` to the pull request's head with a plain
   `git push`, which is a merge nobody reviewed. `bypass_actors` is returned only to someone
   who may edit the ruleset. When it is present, a **`DeployKey`** actor on a supplying ruleset
   **refuses** the submission, naming the ruleset: a deploy key's only use is git over SSH, so
   it is exactly the kind of credential a person pushes with and gh cannot name. Every other
   actor is reported, by type and never by name ("the bypass list holds 1 app and 1 team; none
   is you, as gh reads you"), and decides nothing, because `current_user_can_bypass` already
   answered for gh's account and an app's or a team's credentials are not the person's
   through idpa. When it is absent, `idpa protection` says the push credential's bypass could
   not be read (below, *What no read can see*).
4. **Not only classic protection.** When item 2 finds no ruleset rule, `GET
   repos/{o}/{r}/branches/{base}` says whether the branch is `protected`: if it is, the
   refusal says the base is protected by classic branch protection, which idpa does not accept,
   and names the ruleset to add (decision 7). Classic protection's own settings are never
   read: they need administration rights most people who submit do not have, and the owner
   decided a ruleset is required.
5. **What is reported without being required:** `require_code_owner_review`,
   `required_status_checks` and their contexts (§ 11), `required_signatures` (§ 4),
   `merge_queue`, whichever of the two push rules of item 2 is not set, and the person's role
   (§ 5).

A failure of items 2 to 4 is exit 1, nothing written, and the settings printed; a failure of
item 1's identity is exit 2 (§ 9). **The settings are one list, stated once**, in a constant
that both `idpa protection` and `init platform` print, replacing `init platform`'s
`BRANCH_PROTECTION` (`src/cli/commands/init.ts:80-89`) so the two cannot drift:

```text
not submitted — nothing on github.com/acme/iac's main stops the person who would open this pull request from merging it:
  missing: a pull request rule requiring 1 approval
  missing: approval of the most recent push
  missing: block force pushes
Add a ruleset on main (Settings → Rules → Rulesets):
  required · require a pull request before merging — 1 approval
  required · require approval of the most recent reviewable push (or dismiss stale approvals when new commits are pushed)
  required · block force pushes; restrict deletions
  required · nobody who submits in the bypass list
  advised  · no deploy key and no app in the bypass list
  advised  · GitHub Actions may not approve pull requests (Settings → Actions → General → Workflow permissions)
  advised  · set it at the organisation level, where a repository administrator cannot change it
  advised  · require review from Code Owners
  advised  · the downstream decision as a required status check, once one reports (ADR-0012)
Then run this again. Nothing was written.
```

Three of `init platform`'s present lines change. *Require review from Code Owners* moves to
*advised*: it decides which team approves, which is policy, not whether the opener can merge,
and a repository whose `CODEOWNERS` matches nothing would be refused for nothing. *Dismiss
stale approvals* becomes the *required* push rule, with *approval of the most recent push*
printed first, because it names who may approve: someone other than the pusher. *Include
administrators* is a classic branch protection setting; a ruleset has no such flag and binds
administrators unless they are in its bypass list, so it becomes *nobody who submits in the
bypass list*, which item 3 checks.

**A classic rule beside a ruleset** changes nothing: both are enforced together, the most
restrictive winning ([about rulesets][rules-about]), so adding the ruleset is all a repository
protected the old way needs.

**What no read can see.** Five things, each stated by `idpa protection` and in `SECURITY.md`,
and none made into a guess.

- **An administrator can disable or edit the ruleset** outside idpa and then merge (§ 5);
  GitHub's ruleset history and audit log record it.
- **A classic rule's settings are invisible**, which is why a ruleset is required.
- **The pusher and the opener may be two accounts**: git pushes with the person's SSH key or
  helper, gh opens with its login, and nothing idpa can read ties the two. With *approval of
  the most recent push*, neither account can approve (one is the author, the other the last
  pusher); with only *dismiss stale approvals*, the pushing account could approve the opener's
  request. `idpa protection` says so when only the second rule is set, and
  `docs/submitting.md` recommends the first.
- **The push credential's bypass cannot be read.** `current_user_can_bypass` answers for gh's
  account only. A key that belongs to another account in the bypass list, or a deploy key
  there that a person who cannot edit the ruleset holds, can move `main` without a pull request.
  idpa refuses a deploy key it can see (item 3) and cannot see one otherwise.
  `docs/submitting.md` recommends pushing as gh's account: over HTTPS, `gh auth setup-git`
  makes gh's login git's credential for github.com; over SSH, a key of the same account.
- **An approval by a workflow or an app counts as someone else's.** A repository or
  organisation that allows *GitHub Actions to create and approve pull requests* lets the person
  push a workflow onto their `idp-agent/` branch with their own git, outside idpa, whose
  `GITHUB_TOKEN` then approves the latest commit as `github-actions[bot]`: neither the author
  nor the last pusher, so the approval counts, and the person merges. An app with write access
  can approve the same way. The setting is read by its own route
  (`GET repos/{o}/{r}/actions/permissions/workflow`, `can_approve_pull_request_reviews`,
  [workflow permissions][actions-perms]), which answers the repository's administrators and
  not the people who usually submit, and at organisation level the organisation's; so, like
  the administrator's limit, it is stated and *advised*, never checked. *Require review from
  Code Owners* also stops it, since a bot is no code owner.

The invariant's limit is therefore worded once, in `SECURITY.md` and `idpa protection`: it
**binds the identity that opens the pull request and every credential that person pushes
with**, as long as the ruleset stands, the push credential is not in its bypass list, and no
workflow or app approves in someone else's place.

**`idpa protection`: the check on its own.** `init platform` runs on a directory with no
remote yet, so it cannot verify anything: it keeps printing the settings, and its last line
changes from "The live check … arrives at stage 6" to "`idpa protection` checks them once the
repository is on GitHub". `idpa protection [--repo <clone>]` runs steps 2 to 4 and nothing
else: no model, no write, exit 0 when the rules hold, 1 when they do not, 2 when the arguments,
the repository's configuration or gh are refused. It is the first thing the owner can run in
slice 6.1, and the command a platform team runs after creating the repository.

## 9. Without gh

The owner's model uses gh for three things: the rules (§ 8), recognition (§ 14) and the pull
request. The owner asked for a recommendation on what `--submit` does toward a GitHub remote
when gh is not installed, is not logged in to github.com, or answers as a bot.

**Options.** (a) **Refuse, exit 2, nothing pushed**, before any model on the intent road,
saying how to install gh and log in, and pointing at `--submit --local`; (b) push the branch
anyway and print an engine-built compare URL to open the pull request by hand, stating that
the ruleset could not be checked; (c) push only when the person adds `--no-pr`, with the same
statement.

**Decided: (a).** The reasons, in order of weight.

1. **The invariant forbids (b) and (c).** "idpa never submits against a base without those
   rules." A pushed `idp-agent/` branch on github.com, with a compare URL beside it, is a
   submission in everything but the last click, and the rules were never read. A warning
   printed beside it is the report nobody reads before `y` that decision 5 rejected.
2. **Without gh, idpa cannot read the rules at all.** idpa holds no credential; the rulesets
   of a private repository need one. Reading a public repository's rules anonymously would
   bring back an HTTP transport of idpa's own for an edge case, which the tie-breaker weighs
   against.
3. **Without gh, idempotence is blind.** idpa could not see that #42 is already open, or was
   closed by a reviewer, and would push and print a compare URL that re-requests a refused
   change (decision 11).
4. **`--submit --local` already answers "I only want the branch".** The person can push it
   themselves; that push is then their act, under their name, not idpa's submission. `--no-pr`
   would be a third road whose only purpose is to publish a branch idpa did not check.
5. **Exit 2 is the right class**: the environment is refused before anything happens, as for
   "no model configured", and one command fixes it. It is not 3, which is a boundary the person
   cannot move by typing anything.

```text
idpa: main tracks github.com/acme/iac, and gh is not logged in to github.com, so idpa cannot
read the rules that keep a pull request from merging unreviewed. Run `gh auth login
--hostname github.com`, then run this again; or add --local to cut the branch in this clone
only. Nothing was written.
```

**Logged out and expired are one case.** gh answers a missing login with its exit code 4
("authentication required", [gh exit codes][gh-exit]), but a stored login that was revoked or
has expired is sent, refused by GitHub with 401, and gh exits 1. Both mean the same thing and
take the same one command, so **any authentication failure of step 3's `gh api user`, exit 4
or a 401, is this refusal, exit 2, before anything is written**. Only a 401 on a later call,
once step 3 has answered a person, is a run-time failure, exit 1 (§ 15).

The same shape answers gh missing (`execFile`'s `ENOENT`: "gh is not installed; see
https://cli.github.com"), a version older than the one the fake and the live test pin (§ 17),
and an identity that is not a person (§ 5). **No compare URL is printed anywhere**: every road
that could print one either opened the pull request itself or refused.

## 10. The negative test

Design §9.4's first test, `the token that opens a merge request cannot merge it`, is renamed
to the owner's wording and becomes these.

**Offline, in `pnpm test`, against a fake gh and a bare remote on disk.** No network, ever.
`tests/setup/offline.ts` blocks `fetch`, `node:http(s)` and `net.connect` **in the test
process only**: a child process opens its own sockets, and § 5 hands the push the developer's
way of reaching GitHub on purpose. The developer's `GIT_SSH_COMMAND` outranks every
`core.sshCommand` ([git config][git-config], `core.sshCommand`: "overridden when the
environment variable is set"), so a developer who exports it (the 1Password or hardware-key
case of Q3) would send every push test to the real `git@github.com:acme/iac.git`, signed with
their own key, whatever the test's configuration says. So **the suite owns every variable that
can carry a child process to GitHub**, in a new setup file, `tests/setup/forge.ts`, loaded
with the other three and applied even while a scenario records (as `IDP_BACKSTAGE_*` is):

- **removed**: `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`,
  `SSH_ASKPASS`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`,
  `GH_HOST`, `GH_REPO`, `NO_PROXY` and `no_proxy`;
- **pointed into the run directory**: `HOME` (so the developer's `~/.gitconfig`, and a global
  `core.sshCommand` naming an absolute path that would skip the `PATH` guard, are never read),
  `XDG_CONFIG_HOME` (already, `personal.ts`) and `GH_CONFIG_DIR` (so gh finds no login);
- **set to a closed local port**: `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`,
  `ALL_PROXY` and `all_proxy`, since curl reads the lower-case forms and gh the upper;
- **set**: `GIT_CONFIG_NOSYSTEM=1`, for the git the tests start themselves (fixtures, the bare
  repository); the launcher removes every `GIT_*` from its own calls, so it cannot reach the
  forge's git, which is why the fake ssh below reaches the push through the environment;
- **first on `PATH`**: a `gh` and an `ssh` that fail loudly.

`tests/unit/offline.test.ts` gains a leg asserting each of these, as it asserts shell.ts's
removals today. What remains is a *system* git configuration whose `core.sshCommand` names an
absolute path, which the launcher reads by design (§ 20) and a push test without the fixture
would run. The push fixture's own `GIT_SSH_COMMAND` outranks it, and the same unit test reads
`git config --system --get-all core.sshCommand`, with every `GIT_*` removed from that one
call's environment as the launcher removes them (a test's own call, not on the allow-list), and
fails the suite, naming the file, when this
machine's system configuration sets one: the push tests refuse to run there rather than trust
that every test used the fixture.

- **The remote is a bare repository in a temporary directory.** The clone's remote stays
  `git@github.com:acme/iac.git`, so it passes every check of § 7 and § 13. The push fixture
  hands `main` an environment (`MainDeps.env`) whose `GIT_SSH_COMMAND` is a fake ssh: a small
  script that ignores the host and runs `git-receive-pack` on the bare repository. The
  environment, not only a configuration file, because the environment variable is what
  outranks every `core.sshCommand` of every scope. The push is therefore the real `git push` of
  § 4, with the real lease, the real porcelain line and the real refusal when the ref exists,
  over the real ssh transport, and nothing leaves the machine. One test sets the fake in the
  temporary *global* configuration's `core.sshCommand` instead, with no variable, and proves
  the global configuration is honoured where the repository's is refused.
- **gh is `tests/support/fake-gh.ts`, injected** as `MainDeps.gh`, as `MainDeps.client` injects
  a scripted model. It parses the argument vector with its own grammar (independently of the
  launcher's, so a drift fails), answers `--include` output as gh prints it, and holds a
  GitHub model: accounts and the one gh is logged in as (or none, answering 4), a repository
  with its archived flag and permissions, rulesets with their rules and bypass lists
  (`current_user_can_bypass` computed per account), classic protection, pull requests with
  their reviews, author and last pusher. Refs and commits are read from the bare repository,
  so what the push wrote is what the fake reports. It also models **every door**: a merge of
  the pull request (405 unless someone other than the author and the last pusher approved the
  head), `--admin` merges, `POST /merges`, `PUT contents` on the base, a ref update of the
  base, forced or not.
- **One real-launcher test** runs `process/gh.ts` against a stub `gh` executable on a
  temporary `PATH`, which records its arguments, its environment and its working directory:
  the vector is the grammar's, the working directory the neutral one, and the environment is
  § 5's table, `GH_TOKEN`'s canary value passed unchanged and no provider key or Backstage
  variable present.

The tests:

- **The type has no method.** `ForgeProvider` for GitHub has no `merge`, `approve`, `close` or
  `delete`, pinned by `// @ts-expect-error` lines in a typechecked test.
- **The launchers cannot run a door.** Every forbidden shape of § 6 (each git push variant, each
  gh command, each forbidden flag, a `GET` with `-f`, a path outside the templates, a path
  holding `{` or `}`, a second host) throws before a process starts, and the stub records no
  call. A remote named `--push`, and a base `release/1`, encoded as `…/heads/release/1`, are
  among the cases. So does a push whose ref
  is outside `refs/heads/idp-agent/`, whose lease names another ref or a non-empty value,
  whose URL is not § 13's, and a pull request body with another `head` or `base`.
- **The identity that opened the pull request cannot merge it, in the fake's model.** A full
  `plan --from --submit` against the fake opens pull request #1; the test then tries, as the
  same account and directly against the fake, each door, and requires each refused, the pull
  request still open and the base ref in the bare repository unchanged. Then another account
  approves; the author pushes a commit on top of the head (a fast-forward of the
  `idp-agent/` branch); the author's merge is refused again (405), because the latest commit
  is not the approved one. Then the other account approves the new head and the author's merge
  **succeeds**: the test pins the limit of § 5 instead of hiding it.
- **The check and the fake agree.** With the ruleset removed, its push rule unset, the author
  in its bypass list, or only a classic protection, the fake lets the author merge unreviewed,
  and the preflight refuses that repository before anything is written. With a deploy key in
  the bypass list, a fast-forward push of `main` with that key succeeds in the fake; the
  preflight refuses when `bypass_actors` is visible to gh's account, and `idpa protection`
  names the limit when it is not. With the ruleset dropped between the confirmation and step
  8, the re-check refuses, and nothing exists locally or in the bare repository. With it
  dropped during the push, step 11 refuses: the branch is in the bare repository, no pull
  request exists, and the next run refuses at the preflight.
- **A hostile clone.** Each key of § 7's refused list, set in the clone's `.git/config` (and
  through an `include.path` there), refuses the run with exit 2, names the key, never its
  value, and nothing is pushed; the same key in the temporary global configuration is honoured.
- **Two systems, every failure.** An injected-failure property in the manner of
  `tests/invariants/forge.test.ts`: each gh call and each git call of a submission is made to
  fail in turn, and a stranger creates the branch in the bare repository at each point. After
  every failure the state is a row of § 4's table, and the next run converges: one ref, one
  pull request, the same bytes.

These prove the fake, not GitHub. That is why the fake is held to a contract fixture (below)
and why the live test exists.

**Live, opt-in, run by the owner with their own gh session.** `tests/live/github/submit.live.test.ts`,
never in the default suite: `vitest.config.ts` excludes `tests/live/**`, and a unit test
asserts that the default configuration collects nothing there. It runs only under its own
configuration, `vitest.live.config.ts`, through `pnpm test:live:github`. CI never runs it. It
reads `IDP_GITHUB_LIVE_REPO` and, optionally, `IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR`, a gh
configuration directory logged in as a second account (`GH_CONFIG_DIR=… gh auth login`); no
token variable exists.

The live configuration loads **none** of the default setup files: not `offline.ts`, which
would block the network it needs; not `forge.ts`, which would remove the owner's gh login and
ssh agent; and not `shell.ts`, which deletes every `IDP_*` but `IDP_TRACE_DIR` and so would
delete both of the test's own variables before it read them. It loads one setup file of its
own, `tests/live/setup.ts`, which removes every `*_API_KEY` and every `IDP_*` but
`IDP_GITHUB_LIVE_*` (no model, no catalogue, no trace), and does nothing else. **Invoked
without `IDP_GITHUB_LIVE_REPO`, `pnpm test:live:github` fails**, naming the variable: it is
only ever run on purpose, and a skipped negative test reads as a pass. A unit test in the
default suite pins both: the live configuration's setup files are exactly
`tests/live/setup.ts`, and its guard throws on an environment without the variable. Without
the second variable, step 5 alone reports itself skipped, loudly and in the recorded answers,
and 6.4.1 is closed only by a run that made it (decision 20).

Before it sends anything but a read, it **refuses to start** unless every one of these holds:
the repository's name matches `<owner>/<name>` with `idpa-live` in the name; `GET repos` says it
is public; the owner's gh identity is a `User` with push access; `idpa protection` passed in
this run, against it; and every ruleset that supplies a required rule reports
`current_user_can_bypass` `never`. Then, against that repository:

1. `idpa protection` passes (the built CLI, `dist/cli/bin.js`); then the test's own git pushes a
   branch `live/<timestamp>/base`, and the three routes of § 6 that take a base
   (`git/ref/heads/…`, `branches/…`, `rules/branches/…`) are read for it through the launcher,
   the name encoded as § 6 says, and must each answer that branch, so the literal `/` between
   components is proved on GitHub and not only in the fake;
2. the built CLI submits a plan whose entity name carries the run's timestamp, so every run is
   a new branch, pushes with the owner's git, and prints a pull request URL;
3. a second submission of the same plan names the same pull request and writes nothing;
4. **the owner's identity tries every door, and each must be refused, `main`'s SHA read and
   unchanged after each**: `gh pr merge` in each of its three methods; `gh pr merge --admin`;
   `PUT pulls/{n}/merge-async` where GitHub serves it; `POST /merges` with base `main` and head
   the `idp-agent/` branch; `PUT contents/{path}` on `main`; a **non-forced** `git push` of the
   pull request's head onto `main`, a fast-forward the pull request rule forbids, so that a
   wrong success is one additive commit on a throwaway repository and never lost history; and
   the GraphQL `mergePullRequest` and `createCommitOnBranch` on `main`. No forced update is ever
   sent. These are the test's own calls, not idpa's;
5. with the second account's gh set: it approves; the owner pushes a commit on top of the head
   (non-forced); the owner's merge must be refused. The test never makes a merge that could
   succeed. Without the second account this step reports itself skipped, and the claim about a
   push after an approval rests on the fake and the rule's read alone;
6. the test, not the tool, closes the pull request and deletes the two branches with the
   owner's gh, so the repository stays tidy.

What the run answers is written, status codes and the shape of each body, logins removed, to
`tests/contract/github/answers-<date>.json`, which the owner commits, with the gh version it
ran against, how many reads each read-back needed (§ 4), and three fields left empty for the
owner to fill in before committing it, because no read settles them: whether *Allow GitHub
Actions to create and approve pull requests* is off for the repository and its owner, whether
the owner's git pushes as the account gh is logged in as, and whether the ruleset's bypass list
is empty. `tests/contract/github-answers.test.ts` then holds the fake to it offline: the fake
answers each door, a missing permission and each route with the statuses and shapes GitHub
answered. The same move as the Backstage page recorded from the demo Backstage
(`tests/contract/backstage-page.test.ts`).

**What the owner needs for it.** A GitHub account with gh logged in and git able to push, and:

- a **public** throwaway repository under that account, named with `idpa-live`, since
  rulesets on a private repository need GitHub Pro, Team or Enterprise ([about
  rulesets][rules-about]);
- the demo catalogue pushed to it (§ 16); no `CODEOWNERS` is needed, since the ruleset
  requires an approval and not a code owner's;
- the ruleset of § 8 on `main`, bypass list empty;
- for step 5, a second GitHub account with write access to the repository, logged in to gh in
  its own configuration directory (decision 20).

The steps go in `docs/submitting.md`; § 16 gives the commands.

## 11. Branch protection and the required status check (ADR-0012)

ADR-0012's first mechanism is "the downstream decision is a required status check on the
merge request, enforced by branch protection", keyed by the branch name, which is the digest
of the bytes. Stage 6 **prints it**: the preflight reads `required_status_checks`, and the
closing lines and `idpa protection` say which contexts merging waits for, or that none is
required and so a downstream refusal would not stop the merge. It does not require one:
nothing downstream reports yet (design §13 keeps Tufin, Kong and Jira out of v0.1), and the
generated `validate.yml` runs no validation until the package is published
(`templates/iac-repo/github/workflows/validate.yml`), so requiring a check would refuse every
repository today. The rule itself is left to the repository, *advised* in § 8's list. The
branch name already works as the correlation key a downstream check would read. ADR-0012
stays *proposed*: its mechanism is the downstream system's, and stage 6 builds the reading of
it, not the check. Design §4.4's "Refusal is caught before the merge by a required check
(stage 6)" and `init platform`'s "(stage 6, ADR-0012)" line are reworded to say that.

## 12. What reaches the model, stdout and traces

**The model: nothing of GitHub.** On the intent road the order is: the forge opened, the
repository's configuration checked, gh's identity and the preflight read (§ 8) before the
Supervisor or the Architect is called; then the gates; then the re-check, the push and the
pull request after the Reviewer, the last model call. No gh output and no git output is in
any prompt. On `--from` no model is called. The agents' closure stays network-free and
process-free, and the architecture test "only cli/ reaches forge/ at runtime" keeps `agents/`
away from both launchers.

**The pull request's text.** The title is the commit's subject, which the engine writes from
the operations (D18, `messageFor`, `src/core/plan/clear.ts:505-521`). The body is the commit's
body, which already carries the request "as recorded with the plan (no gate reads it)", plus a
block the engine writes: the road (*drafted by a model, five gates, the Reviewer last*, or
*from a plan file, four gates, no Reviewer*, D4), the branch and what its digest means, and
the closing sentence. The request is the person's words or the plan file's, so it goes inside
a fenced block whose fence is longer than any run of backticks in it: a pasted `@team` does not
notify anyone, and a link or an image is shown as text. The body travels to gh on standard
input inside the engine's JSON, never as an argument. It leaves room for stage 8's evidence
section (`docs/stage-8-brief.md`, "the merge request body").

**stdout.** The pull request's URL is built by the engine from the host, the owner and
repository parsed from the remote, and the number GitHub returned, checked to be a positive
integer: `https://github.com/acme/iac/pull/42`. GitHub's `html_url` is never printed, and
neither is anything gh or git wrote (§ 6). The login on the "submitting to" line is held to
GitHub's login grammar before it is printed.

**`--json`** (D11). `SubmissionReport` gains `pullRequest`: `{ host, repository, number, url,
state: 'opened' | 'open', base }`, and `pushed: boolean` beside `outcome`. The test that pins
the shape is updated in the same pull request, and cli-ux-10's item names the new keys.

**Traces.** Root attributes of the run, as `idp.inspector` and `idp.source.*` are:
`idp.forge.kind` (`local` or `github`), `idp.forge.host`, `idp.forge.repository`,
`idp.forge.base`, `idp.forge.branch`, `idp.forge.pull_request`, `idp.forge.outcome`,
`idp.forge.gh_calls`, `idp.forge.pushed`. Never a login, never a credential, never gh's or
git's output. No new span type, so ADR-0009's list stands.

**What leaves the machine.** `SECURITY.md`'s table gains two rows, and both say idpa itself
opens no connection to GitHub: through the person's git, to github.com, one commit (the files
the diff shows, the person's git identity, the recorded request) under one `idp-agent/` ref;
through the person's gh, the reads of § 8 and § 14 and one pull request whose text is above.
The files were going to GitHub by the merge anyway; the request text and the identity are what
is new, and the rows say so.

## 13. The remote and the base

**Which remote.** The remote the checked-out branch tracks: `branch.<name>.remote`, and the
branch `branch.<name>.merge` names on it. No new flag and no `origin` assumed: the person set
this with `git clone` or `git push -u`, and it is the branch they would open a pull request
into by hand. `branch.<name>.remote` must name a remote: `.` (the clone itself) or a literal
URL there is refused with exit 2, asking for a named remote.

Both values come from the clone's own configuration, which § 7 treats as hostile, so each has
a grammar, checked before it reaches a process or a path, and a value outside it is exit 2,
named and never quoted:

- **a remote name**: 1 to 100 bytes of letters, digits, `.`, `_`, `-` and `/`, not beginning
  with `-` or `.`, and a name git itself accepts as a remote (`refs/remotes/<name>/HEAD` passes
  `git check-ref-format`, git's own rule for a remote name); passed after `--`;
- **a base**: `branch.<name>.merge` is `refs/heads/` followed by a name `git check-ref-format
  --branch` accepts, not beginning with `-`, holding no `{`, `}`, `%` or control character, at
  most 255 bytes; a value that is not under `refs/heads/` (a tag, a pull request ref) is
  refused. A branch tracking another branch
name on GitHub, `release-1` say, is allowed, and the confirmation and the closing lines name
it; `idpa protection` checks that branch's rules, not the default branch's.

**The repository's name comes from the remote's URL, read, never guessed.** `git remote
get-url --all <remote>` and `git remote get-url --push --all <remote>` give the URLs the
person's own git would use, `insteadOf` and `pushInsteadOf` expanded ([git remote][git-remote]),
so a rewrite to an internal mirror is seen as the mirror, never as github.com. More than one
fetch URL, more than one push URL, or a push URL naming another host or repository than the
fetch URL (a fork set-up) is refused with exit 2. The URL is one of five forms:
`https://github.com/acme/iac(.git)`, `git@github.com:acme/iac(.git)`,
`ssh://git@github.com/acme/iac(.git)`, `ssh://git@ssh.github.com:443/acme/iac(.git)` (SSH over
the HTTPS port, [ssh over 443][ssh-443]), and `org-<id>@github.com:acme/iac(.git)`, the form
GitHub gives members of an organisation that uses an SSH certificate authority ([SSH
certificate authorities][ssh-ca]). All five map to the host github.com. The parser keeps the
host, the owner and the repository, each held to GitHub's grammar (an owner of letters, digits
and hyphens up to 39; a repository of letters, digits, `.`, `_`, `-` up to 100, never `.` or
`..`). Anything else is not a GitHub remote. **A URL holding userinfo**, other than the `git@`
and `org-<id>@` of the SSH forms, is refused with exit 2 and never quoted, the same rule #111
gave `iacRepo` (`src/core/schemas/config.ts:45-59`): an `https://x-access-token:<token>@github.com/…`
copied from somewhere is where a token sits, and idpa would otherwise hand it to git. The
message names the host and the path: "origin's URL carries a credential; set it to
https://github.com/acme/iac".

**`iacRepo` is a cross-check, never a source.** `.idp-agent.yml` is committed, travels with
every clone and is the service team's file, so it never chooses where a pull request goes. But
when `plan "<intent>"` runs from a service whose `.idp-agent.yml` names an `iacRepo`, and that
locator's host and path differ from the declarations repository's remote, the submission is
refused with exit 1, naming both. This is the first reader of `iacRepo`, which design §7.0
says nothing reads before stage 6, and it closes the review's cli-ux-13.

**Which road a submission takes.** Decided before any model, and said on stderr:

| The checked-out branch tracks | `--submit` does |
|---|---|
| a branch on github.com, gh logged in as a person | the local branch, the push and the pull request |
| a branch on github.com, gh missing, logged out, or not a person | exit 2, nothing written, `--local` named (§ 9) |
| a branch on another host | the local branch, as stage 5, with "the remote is on gitlab.example.com, where this build opens no pull request: nothing pushed" |
| nothing | the local branch, as stage 5, with "main tracks no remote: nothing pushed" |
| anything, with `--local` | the local branch, as stage 5 |

The two stage-5 rows are not mistakes the person can fix by typing anything: this build opens
no pull request there, stage 5's branch is what it has always done there, and the closing
lines say nothing was pushed. `--local` is the way to ask for stage 5's branch on purpose, and
is refused without `--submit`.

## 14. Idempotence, and what the user sees

**How the forges compose.** One `ForgeProvider` of `name: 'github'` holds the local forge, the
push and gh. `base`, `diverges` and the local half of `recognise` and `submit` are the local
forge's; the GitHub forge adds the remote half. `submit()`'s early return on a recognised local
branch (`src/cli/commands/submit.ts:199-200`) changes: on the GitHub road, a local
`already-submitted` is not the end of the run but the first half of the answer, and
recognition continues on GitHub. `Recognised` and `Submitted` gain the outcomes below
(`already-submitted` carrying the pull request, `pushed-without-pull-request`, `closed`), still
with no `merge` and no `delete` anywhere.

**Recognition, before the confirmation, reading only, through gh**: the ref `idp-agent/…` on
GitHub, its commit, and `GET repos/{o}/{r}/pulls?head={o}:{branch}&state=all` ([list pull
requests][pulls]), sent whether or not the ref exists, since a closed pull request's branch may
have been deleted. A remote branch is **ours on this base** when its SHA is the local branch's,
or, with no local branch, by the local test, remotely: one commit, whose parent is the base,
whose tree is `treeFor(base, edits)`, under the engine's message. It is **ours on an older
base** when its one parent is not the base but an ancestor of it (`git merge-base
--is-ancestor`, local, the clone being level with GitHub by step 4, so the old base is in it),
and its tree is `treeFor(that parent, edits)`. The same widened test applies to the local branch
on the GitHub road only; stage 5's local road keeps D7.

| Locally | On GitHub | Outcome | Exit | Written |
|---|---|---|---|---|
| no branch, or ours | no branch, no pull request | asked, then the push and the pull request | 0 | local ref if absent, remote ref, pull request |
| no branch, or ours | our branch, no pull request | asked, then the pull request: "the branch was pushed by an earlier run; opening its pull request" | 0 | pull request |
| any of ours | our branch, an open pull request into the base | "already submitted · pull request #42 is open", not asked | 0 | nothing |
| any of ours | our branch **on an older base**, an open pull request into the base | "already submitted · pull request #42 is open, on main@abc1234; main is now def5678, and GitHub shows whether it still merges cleanly", not asked | 0 | nothing |
| ours on an older base | no branch, no pull request | refused: "idp-agent/… is in this clone on main@abc1234, an older main, and was never opened for review; delete it (git branch -D idp-agent/…) and run this again". The tool never deletes | 1 | nothing |
| any | a pull request from that branch, closed unmerged, the branch present or deleted | refused: "submitted as #42 and closed on 2026-10-02. A closed request is not reopened by this tool: reopen it on GitHub, or change the request", not asked | 1 | nothing |
| any | a pull request from that branch, merged, and the change not on the base (reverted since) | refused: "merged as #42, and main no longer carries it; a reverted change is a reviewer's decision, which this tool does not re-request", not asked | 1 | nothing |
| any | our branch, an open pull request into another base | refused, naming the base it targets | 1 | nothing |
| any | a branch of that name that is not ours (another parent, more commits, other bytes, another message) | refused: "idp-agent/… exists on github.com/acme/iac and carries a different change", as stage 5 says of a local one | 1 | nothing |
| not ours | anything | stage 5's refusal, before anything is read on GitHub | 1 | nothing |

**A merged pull request needs no row.** A merge moves the base, so step 4 refuses first
("bring them level"); after `git pull`, the re-check finds the declaration already there and
the run ends on stage 5's no-op, "nothing to change", exit 0, before recognition. The row above
for a merged pull request is reached only when the change was reverted since.

**The base moving under an open request.** The branch name does not cover the base, so after
someone else's pull request merges, the same change keeps its name. The person is first told
to bring the clone level (§ 4); on the next run, the "older base" row names #42 instead of
calling it someone else's. If the other merge touched the same file, the bytes differ, the
name differs, and a second pull request is proposed: the two conflict at the merge, which is
where design §4.3 says that is seen. A stale local branch nobody opened is the one case the
person clears by hand, because a create-only tool never removes a ref.

**At the moment of writing.** Step 8's reads, then the push, whose lease refuses a ref created
in between; that refusal is read back through gh and answered as the local forge answers a
lost race, by the commit the ref points at (ours: continue to the pull request; not ours: the
"not ours" row). A 422 on the pull request ("a pull request already exists") is answered by
listing again. A branch somebody pushed commits onto after the pull request was opened is "not
ours" from then on, and the push rule of § 8 means that push needs a new approval before anyone
merges it.

## 15. Configuration and failure

**Configuration.**

| Where | What | Notes |
|---|---|---|
| the person's git | the push's credentials: SSH key and agent, or a credential helper | global and system configuration only (§ 7) |
| the person's gh | the reads and the pull request; the identity | `gh auth login --hostname github.com`; idpa reads none of it |
| the checked-out branch's upstream | the remote, the repository, the base | § 13 |
| `--local` | `--submit` cuts only the local branch | refused without `--submit` |
| `.idp-agent.yml` `iacRepo` | read as a cross-check | § 13 |
| `IDP_GITHUB_LIVE_REPO`, `IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR` | the live test's repository and second account | read by `tests/live/` only, never by the CLI |

No `IDP_GITHUB_TOKEN`, no `github:` section in `config.yml`, nothing in `.env.example`.
GitHub Enterprise, later, is a host gh is logged in to, not a configuration of idpa's (decision
16).

**Failure.**

- **Arguments and environment, before any process writes and before any model: exit 2.** gh
  missing, logged out of github.com or holding a login GitHub refuses (step 3's `gh api user`
  answering gh's exit 4 or a 401), older than the pinned version, or acting as a bot (§ 9);
  a refused key in the repository's configuration (§ 7); a remote URL with userinfo; a remote
  that does not parse; a `.` or URL-valued `branch.<name>.remote`; several fetch or push URLs,
  or a push URL naming another repository; a remote name or a base outside § 13's grammar;
  `--local` without `--submit`.
- **GitHub's answer through gh, at run time: exit 1**, one classified line naming the host, the
  route's name and the status, never GitHub's or gh's words: 401 on a call after step 3 (gh's
  login was refused during the run: "run `gh auth login --hostname github.com` again"); 403
  ("your account cannot do this on acme/iac", or a secondary rate limit, which says when to try
  again, and the tool does not wait); 404 (the repository does not exist or this account cannot
  see it; GitHub does not say which); 422 on the pull request (§ 14); 5xx; a timeout; an answer
  over its bound; a paginated rules answer (§ 8).
- **The push, at run time: exit 1**, classified from git's exit and stderr, never printed:
  authentication refused (`Permission denied (publickey)`, `Authentication failed`, a helper
  that answered nothing: "your git could not authenticate to github.com; `git push` in this
  clone would fail the same way"); host key verification failed; the lease refused (read back,
  § 14); a rule refused the ref (GitHub's `GH013`, for a ruleset that restricts creating
  `idp-agent/` branches: "a ruleset on github.com/acme/iac forbids creating idp-agent/…
  branches"); the ref not reading back (§ 4); a network failure.
- **The repository's state: exit 1.** The rules of § 8 missing, bypassable by this person, or
  only classic; a deploy key in a bypass list gh can read; the rules gone between the push and
  the pull request (step 11); the base not level with GitHub's (§ 4); a closed or reverted pull request; a
  branch that is not ours; a stale local branch; no push access.
- **Bounds.** 15 s per gh call and per local git call, 120 s for the push (an ssh passphrase
  may be typed during it), 180 s per submission; 1 MiB per gh answer and per pull request body;
  at most ten rulesets read per check; at most 48 gh calls per run: the version and the
  identity 2; the preflight 13 (the repository, the rules, at most ten rulesets, the base ref;
  the branch read of item 4 is made only when no rule was found, so no ruleset is read then);
  the re-check at step 8 12 (the rules, the rulesets, the base ref); recognition 3; the
  read-back at most 3 (§ 4); the rules before the pull request 11; the pull request 1; re-reads
  after a lease refusal or a 422 at most 3. One pull request list page of 100. A change is at
  most 50 files, the `Plan`'s own bound on operations.

```text
idpa: github.com refused to open the pull request through gh (403): your account cannot open pull requests on acme/iac. The branch idp-agent/orders-api-to-payments-e9e6183f is on github.com/acme/iac; run this again once it can.
```

## 16. Slices

Each numbered item is one stacked pull request, merged bottom-up. Headings and intent only;
the plan gives the steps. Each slice ends on something the owner can run. No pull request
merges a road that starts gh or pushes without the key-reach leg that proves what reaches
those processes, in the same pull request. Every pull request carries its `CHANGELOG.md`
line, its `docs/roadmap.md` edit and the documents it makes true, as stage 5's did.

### Slice 6.1 — the gh/git launcher allow-list, and `idpa protection`

Closed by 6.1.3: `idpa protection --repo ~/idpa-live` answers exit 1 on the throwaway
repository before its ruleset exists, printing the ruleset to add; exit 0 once it does; and
exit 2 with gh logged out. No model, no write, no recording.

1. **The allow-list and the launchers.** `process/gh.ts` beside `process/git.ts`, both checking
   the final argument vector against their grammar (§ 6), the push form included though no
   road calls it yet; the gh environment and the push environment of § 5; the architecture
   rules (two process starters, the door strings, no credential name read from the
   environment), and `AGENTS.md`'s rule count re-measured. `tests/support/fake-gh.ts` with its
   GitHub model; the stub-`gh` launcher test; `tests/setup/forge.ts`, the offline floor for
   child processes (§ 10: the removed variables, `HOME` and `GH_CONFIG_DIR` in the run
   directory, every proxy variant closed, the `gh` and `ssh` guards), with its legs in
   `tests/unit/offline.test.ts`; `vitest.config.ts` excluding `tests/live/**`, with the unit
   test that it collects nothing there. Unit tests only.
2. **The remote and the repository's configuration.** `forge/github/remote.ts`: the upstream,
   `get-url --all` and `--push --all`, the five URL forms, the grammar, userinfo refused
   unquoted, host github.com; the scope check of § 7 over `config --list --show-scope -z`;
   gh's presence, version and identity (§ 5, § 9), each refusal worded.
3. **The preflight and `idpa protection`.** § 8, items 1 to 5, over the fake; the one list of
   settings, printed by both `idpa protection` and `init platform`; `init platform`'s last line
   changed; the key-reach leg for `idpa protection`, the first command that starts gh.

### Slice 6.2 — push and pull request on `plan --from`

Closed by 6.2.2: `idpa plan --from examples/open-network.json --repo ~/idpa-live --submit`
pushes with the owner's git, opens a pull request on the throwaway repository and prints its
URL; run again, it names the same pull request. On the pull request page, GitHub says merging
is blocked until an approval. No recording changes.

1. **The GitHub forge.** `forge/github/forge.ts` holding the local forge: `recognise` and
   `submit` through gh and the push; `treeFor` in `forge/local`; the create-only push, the
   read-back, the pull request and its body (§ 12); the rows of § 14 against the fake and the
   bare remote, the older base included; the offline negative tests of § 10, the hostile-clone
   tests included; the injected-failure property over two systems. `ForgeProvider`'s `name`
   widens to `'local' | 'github'`; still no `merge`, no `delete`; its comment about "the token
   this interface holds" rewritten.
2. **`plan --from --submit` to GitHub.** The road table of § 13 and `--local`; the refusal
   without gh (§ 9); the preflight, and the re-check at step 8 before the local ref; `submit()`'s
   early return changed (§ 14); the confirmation naming the push and the pull request; the
   closing lines with the URL and the checks merging waits for, replacing `NO_FORGE` on this
   road; `--json`'s `pullRequest`; the trace attributes; the key-reach leg for `--from`;
   `SECURITY.md`'s new rows, and the two *Designed, not yet built* items moved to *Guaranteed*
   in the owner's words (decision 1), with § 5's limit stated beside them. Until 6.3.1,
   `plan "<intent>" --submit` in a clone whose base tracks a GitHub branch is refused with exit
   2 before any model, saying the intent road opens pull requests from the next release and
   pointing at `--local` and at `plan --from`: it never cuts a local branch while saying "no
   forge (stage 6)", which would then be false.

### Slice 6.3 — the intent and `init` roads, and the phrase road

Closed by 6.3.1: from a directory whose `.idp-agent.yml` names the throwaway repository,
`idpa plan "<intent>" --submit` opens a pull request there; 6.3.3 closes the same from
`idpa "<phrase>" --submit`.

1. **`plan "<intent>" --submit` to GitHub.** The remote, the configuration check, gh and the
   preflight before any model, on the order `main` already uses for the local forge
   (`src/cli/index.ts:1343-1368`); the re-check after the Reviewer; the `iacRepo` cross-check
   (§ 13); the key-reach leg for this road. Scripted clients only: no tape changes, and
   `IDP_RECORDING=record` is never used.
2. **`init --submit` to GitHub** (decision 17): the service's own repository, its upstream, the
   same configuration check and preflight on its rules; its key-reach leg. D6 and D12 stay
   refused by name.
3. **`idpa "<phrase>" --submit`** (D8, decision 14): the forge, gh and the preflight before the
   Supervisor, a question with `--submit` refused as today; its key-reach leg.

### Slice 6.4 — the live test, ADR-0015 and the documents

Closed by 6.4.1: the owner runs `pnpm test:live:github` with their own gh session and the
second account's, and it passes, every door refused and step 5 made, and commits the recorded
answers with their three hand-filled fields.

1. **The live test and its fixture.** `tests/live/github/`, `vitest.live.config.ts`,
   `pnpm test:live:github`, failing without its variable, loading only `tests/live/setup.ts`, and
refusing to start outside its
   guards (§ 10); the recorded answers with the gh version; the offline test holding the fake
   to them; the minimum gh version pinned from them; the unknowns of § 17 answered in the
   successor documents.
2. **ADR-0015 and the documents** (0013 and 0014 are `backstage-http` slice 2's). ADR-0015, "a submission is a pull request the rules keep
   from merging until someone else approves it", carrying the owner's invariant word for word,
   the gh/git model, the allow-list, the no-gh refusal and § 20's rejected alternatives;
   ADR-0006's consequences (the check `init platform` "will verify" is `idpa protection`, the
   live check is the owner's test, the invariant in the owner's words); ADR-0010 (the remote
   create-only ref, by lease); ADR-0012 (decision 12); design §4.2 (the invariant), §4.4 (the
   required check's sentence), §7.0 (no forge credential), §7.2, §7.4 (step 8 built), §8 (the
   "write interrupted" row, per system), §9.2 (atomicity and idempotence, per system), §9.4
   (the test renamed), §10 (`forge/github/`, `process/gh.ts`); `SECURITY.md` (the invariant,
   the environment table, the administrator limit); `docs/submitting.md`, the page a person
   follows to install gh and add a ruleset; README, `AGENTS.md` (the invariant in the same
   words, the layering line for `process/`, the rule count), the roadmap's stage 6 row.
3. **The tapes re-recorded, in the same session** (the owner's decision of 2026-09-30). Every
   tape recorded before 2026-09-30 is recorded again with the owner's key, so each turn carries
   the `sent:sha256:` digest over what the provider is sent, tools included (#116). The owner
   runs it, `IDP_RECORDING=record` in `tests/scenarios/` only, never an agent; the diff of
   `tests/recordings/` is reviewed like any other before it is committed.

**The owner's commands for the live part**, once 6.2 is merged. The first line is the only
one to edit: it names the owner's GitHub login once, and every later line reads it as
`"$OWNER"`, so nothing pasted holds a `<…>` that zsh would take for a redirection. The
repository is the demo SI, as the README's stage-5 demo uses, so that
`examples/open-network.json` has the entities it names. `idpa protection` is run twice: before
the ruleset exists (expected: exit 1, the ruleset to add) and after adding it on the web page
(Settings → Rules → Rulesets, § 8). The `plan` line is run twice.

```bash
OWNER=your-login
gh auth status --hostname github.com
cp -R ~/Documents/idp-agent/fixtures/si-demo ~/idpa-live
git -C ~/idpa-live init -q -b main
git -C ~/idpa-live add -A
git -C ~/idpa-live commit -qm "chore: the demo catalogue"
gh repo create "$OWNER/idpa-live" --public
git -C ~/idpa-live remote add origin "git@github.com:$OWNER/idpa-live.git"
git -C ~/idpa-live push -u origin main
idpa protection --repo ~/idpa-live
```

Then add the ruleset, and, in the same terminal:

```bash
idpa protection --repo ~/idpa-live
idpa plan --from ~/Documents/idp-agent/examples/open-network.json --repo ~/idpa-live --submit
idpa plan --from ~/Documents/idp-agent/examples/open-network.json --repo ~/idpa-live --submit
IDP_GITHUB_LIVE_REPO="$OWNER/idpa-live" pnpm test:live:github
```

For step 5, a second account logs in once in its own directory, and the last line gains
`IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR=~/.config/gh-idpa-reviewer`:

```bash
GH_CONFIG_DIR=~/.config/gh-idpa-reviewer gh auth login --hostname github.com
```

Expected: the second `idpa protection` exits 0, lists the rules it found, says gh's account
cannot bypass them and that the bypass list is empty, and states what it cannot read (the push
credential, the Actions setting); the first `plan` run prints a pull request URL whose page
says merging is blocked until an approval; the second says the pull request is already open and
writes nothing; the live test passes, every door refused and `main` unchanged.

## 17. Prerequisites, order, and what is still unknown

| Prerequisite | Why | Needed before |
|---|---|---|
| The owner's answers (§ 18) | settled on 2026-09-30 | — |
| The owner's answers to § 19 | the identity rule and the configuration refusal shape 6.1.2 | 6.1.2 |
| gh installed and logged in to github.com on the owner's machine | the demos of 6.1–6.3 and the live test; nothing in `pnpm test` needs it | 6.1.3's demo |
| A throwaway public GitHub repository named with `idpa-live`, a ruleset on it | the same | 6.1.3's demo |
| A second GitHub account with write access to it, logged in to gh in its own directory | the live test's step 5 | 6.4.1, optional |
| A directory whose `.idp-agent.yml` names the throwaway repository | 6.3.1's demo; it need not be on GitHub | 6.3.1 |
| A service repository on GitHub with § 8's ruleset | 6.3.2's demo | 6.3.2 |
| Nothing unmerged | stage 6 builds on `main`'s forge, `submit.ts` and launcher | — |

The queue puts batch B2 and `backstage-http` slice 2 first (`docs/roadmap.md`, *The queue*).
Stage 6 touches `process/`, `forge/`, `cli/commands/submit.ts`, `cli/commands/init.ts`,
`cli/render/footer.ts`, `cli/index.ts`'s submission wiring, `vitest.config.ts`, `tests/setup/`
(a new `forge.ts`) and `tests/architecture/`; slice 2 touches `context/backstage/` and
`cli/source.ts`. They meet only in `MainDeps` and the architecture test file, so they can run
side by side, the second to merge rebasing a few lines.

**Unknown, and where each is measured.**

- Whether `current_user_can_bypass` says `never` for a repository administrator not in the
  bypass list, and whether `gh pr merge --admin` is then refused. Recorded by the live test;
  § 8 item 3 fails closed until then.
- The status each door returns when the ruleset refuses it (405 is the documented "merge cannot
  be performed" for `PUT …/merge`, [merge a pull request][merge]), and GitHub's push rejection
  for a ruleset that restricts creating `idp-agent/` branches. Recorded live.
- The oldest gh version whose `api --include --input - --hostname --method` behaves as the fake
  models it, including what `--include` prints on a non-2xx answer. Recorded live; the version
  check of § 9 pins it in 6.4.1.
- Whether the owner's company protects its declarations repository with rulesets or with
  classic branch protection, whether the ruleset is at organisation level, and whether the
  people who would submit are in a bypass list.
- Whether the people who would submit push with the same account gh is logged in as, and
  whether a deploy key sits in a bypass list (§ 8, *What no read can see*).
- Whether the owner's company lets GitHub Actions approve pull requests.
- Whether an `@mention` inside a fenced block in a pull request body notifies nobody; the live
  test's pull request carries one.

## 18. The owner's answers (2026-09-30)

Every decision below is settled. 1, 2, 3, 4, 7 and 21 are the owner's own words or choices;
the others take this note's recommendation, rewritten where the first draft assumed a
fine-grained token; 22 was delegated to this revision and confirmed by the owner.

1. **The invariant** (design §4.2, `AGENTS.md`, `SECURITY.md`, ADR-0015): "the identity that
   opens a pull request cannot merge it until someone else has approved the exact commit that
   would merge, and idpa never submits against a base without those rules". Changed in design
   §4 first, as `AGENTS.md` requires, with ADR-0006's consequence rewritten and design §9.4's
   first test renamed to it.
2. **How the branch reaches GitHub**: the person's own `git push`, in the one create-only form
   of § 4 (`--force-with-lease=<ref>:` with an empty expected value, the exact commit, hooks
   off, one refspec, to the URL read from the remote), never forced, never a deletion, never
   another remote, never a branch outside `idp-agent/`. The REST transport of the first draft
   is dropped (§ 20).
3. **Which credential**: none of idpa's. The person's git (SSH key or credential helper) and
   the person's gh, as configured; the identity must be a person (§ 5, and § 19 Q1).
4. **Where the credential comes from**: gh's own authentication and git's own; idpa reads no
   GitHub secret, and design §7.0's "`GITHUB_TOKEN` or `gh auth`" is rewritten to say so.
5. **What the base must require, before any write and again at the moment of acting**: a
   ruleset with a pull request rule of at least one approval, approval of the most recent push
   (`require_last_push_approval`) or dismissal of stale approvals, no force push, no deletion,
   and `current_user_can_bypass` `never` on each ruleset supplying them (§ 8).
6. **An administrator's identity**: `current_user_can_bypass` decides; the role read through
   `gh api` (`permissions.admin`, `permissions.maintain`) is reported, never decided on. The
   Administration probe of the first draft is dropped with the token.
7. **A base protected only by classic branch protection**: refused, naming the ruleset to add.
8. **The base**: the tracked branch, and GitHub's tip must equal `HEAD` (§ 4).
9. **Where no pull request will be opened**: the road table of § 13. Another host or no
   upstream cuts stage 5's branch and says nothing was pushed; a GitHub remote without a usable
   gh is decision 22.
10. **A submission on an older base**: our one commit on an ancestor of the base, with its open
    pull request, is "already submitted"; a local branch on an older base GitHub never received
    is refused, naming the `git branch -D` the person runs. Stage 5's local road keeps D7.
11. **A closed unmerged pull request, or a merged one since reverted**: refused, naming it;
    never reopened, never re-requested.
12. **ADR-0012**: stage 6 prints the required contexts; ADR-0012 stays *proposed* (§ 11).
13. **`idpa protection`**: exists, as named, in 6.1.3.
14. **`idpa "<phrase>" --submit`** (D8): lifted in 6.3.3.
15. **`iacRepo`**: a cross-check that refuses a mismatch, never a source (§ 13).
16. **GitHub Enterprise**: github.com only in stage 6; later, a host gh is logged in to, through
    gh's own host configuration, with a real instance to test against.
17. **`init --submit` and the service repositories**: a pull request on the service repository
    only when it passes the same configuration check and preflight; otherwise refused as § 8
    says, with `--local` named. D6 and D12 stay refused. There is no token list to widen any
    more: what the person's credentials reach is theirs, and the ruleset is what every
    submission requires.
18. **A ruleset on `refs/heads/idp-agent/**`**: printed by `idpa protection` as advised, never
    required.
19. **Draft pull requests**: not draft.
20. **The live test's second account**: set up, logged in to gh in its own configuration
    directory, so step 5 proves live that a push after an approval blocks the merge.
21. **The push and pull request road is "like Claude Code"**: idpa handles no GitHub token; the
    person's git pushes, the person's gh reads the rulesets and opens the pull request; an
    architecture rule and a run-time check limit idpa to an explicit list of git and gh
    commands and arguments (§ 6).
22. **Without gh, or with gh logged out** (delegated): refused with exit 2, nothing pushed, how
    to install and log in said, `--local` named; no compare URL, no `--no-pr` (§ 9).

## 19. New questions for the owner

All four settled by the owner on 2026-09-30, each as recommended (recorded in
[`docs/roadmap.md`](roadmap.md)'s decisions): Q1, Q2 and Q4 answered, Q3 taken as following
from answer 21 and said so to the owner. The text below keeps each question as it was put.

- **Q1. Must gh's identity be a person?** § 5 refuses a `Bot` and an identity `/user` refuses
  (GitHub Actions' `GITHUB_TOKEN`, an App's installation token), because the pull request's
  author would be a bot and the requester could approve it. **Recommended: yes**, which also
  makes stage 6 a laptop tool, not a CI step, until a server-side runner gets its own ADR.
- **Q2. A repository key that redirects or runs a program during a push: refuse, or
  override?** § 7 refuses, naming the key and the one command that removes it. The
  alternative, overriding each with `-c`, cannot remove a key with an unknown subsection and
  would empty the person's own global credential helper. **Recommended: refuse**, and
  `docs/submitting.md` lists the keys.
- **Q3. The four `GIT_SSH*`/`GIT_ASKPASS` variables on the push.** § 5 passes them to the push
  only, since they are how some people reach GitHub (a 1Password or a hardware-key agent, say),
  while every other call keeps dropping all `GIT_*`. **Recommended: pass them**; the
  alternative asks those people to move the setting to `core.sshCommand` in their global
  configuration. Either way the suite removes them from its own environment (§ 10).
- **Q4. Should idpa prove that the push credential is gh's account?** § 8 cannot read a push
  credential's bypass: a deploy key or another account's key in the bypass list could move
  `main` without a pull request. Proving it would mean running the person's ssh outside the
  push (`ssh -T git@github.com`, whose greeting names the account or the deploy key's
  repository) and parsing its prose, or forcing git's credential for github.com to gh's
  (`gh auth setup-git`), which overrides the person's configuration the owner chose to trust.
  **Recommended: not in stage 6.** Refuse a visible deploy key (§ 8 item 3), state the limit in
  `idpa protection` and `SECURITY.md`, recommend pushing as gh's account in
  `docs/submitting.md`, and revisit when a company's answer to § 17's unknown says its
  submitters push with other keys.

## 20. Rejected alternatives

**A dedicated fine-grained token and idpa's own REST transport** (this note's first draft). It
kept the token in one Node closure, never in a child process, behind eleven typed routes, and
could refuse a token's shape. The owner rejected it for the gh/git model: it is one more secret
per person to create, scope, rotate and leak, for a guarantee that rested on the ruleset anyway,
since *Contents: write* merges as surely as `repo` does. What the gh/git model costs instead,
and how it is paid: two programs idpa does not ship (the allow-list, § 6), the person's
configuration (§ 7), and broad credentials (§ 5, the ruleset and `current_user_can_bypass`).

**Pushing without gh and printing a compare URL, or a `--no-pr` flag** (§ 9). Either publishes a
branch against rules idpa never read.

**`gh pr create`.** It may push the branch itself, offer to fork, prompt, and read the current
directory's remotes; its argument surface is far larger than one `POST` whose body the engine
builds.

**Pushing to the remote by name.** It consults the remote's push refspecs, mirror flag,
`receivepack` and proxy; pushing to the URL read from it consults none.

**A plain push without the lease.** It fast-forwards an existing `idp-agent/` ref that our
commit descends from, so it is not create-only.

**`GIT_CONFIG_NOSYSTEM`, or a private `GIT_CONFIG_GLOBAL`, for the push.** The first drops the
system credential helper Apple's git and Git for Windows rely on; the second drops the person's
own configuration, which is the credential the owner chose to trust. Neither removes the
repository's configuration, which no variable does (§ 7).

**Reading gh's token to call GitHub from Node.** It is exactly a GitHub secret in idpa.

**Merging on confirmation, or holding a credential that can.** ADR-0006's own rejected
alternative; nothing in GitHub's permission model changes it.

**Keeping design §4.2's sentence as it stands.** It is false on GitHub once someone approves,
and a sentence the next reader takes as true is worse than a narrower one that holds.

**A merge probe in the CLI**, with a SHA that cannot match. It puts a merge call in the tool's
code, and its safety rests on the order in which GitHub checks a SHA and the rules, which is not
documented.

**Reading `mergeable_state` after the pull request is opened.** It is computed asynchronously,
starts `unknown`, and says whether the pull request can merge, not whether its opener could
bypass a rule. The ruleset read is earlier, synchronous and specific.

**Refusing administrators through `permissions.admin`.** An administrator a ruleset binds cannot
merge through it, and a non-administrator in a bypass list would pass. `current_user_can_bypass`
answers the question asked.

**Accepting classic branch protection.** Its settings need administration rights to read, and
"it is protected somehow" is not the check design §7.2 promises (decision 7).

**Covering the base in the branch's digest.** Every merge on `main` would rename a change under
review and open its duplicate (decision 10).

**A fork workflow.** It needs push rights on a second repository and a pull request across
owners, and a person who can push to the base repository gains nothing from it.

**A GitHub App in v0.1.** An installation token makes the bot the author, so the requester could
approve their own request; it belongs to a server-side runner, later, behind its own ADR.

**Trusting GitHub's `html_url`, gh's or git's output.** All are text idpa did not write; the URL
is built from the engine's values and every failure is classified.

**Reopening a closed pull request**, or **pushing a new commit onto an existing branch** to
update it. Both move something a reviewer has already seen; a changed request is a new branch,
named by its new bytes.

**Running the live test in CI.** It would need a logged-in gh in CI, a credential someone else's
workflow can reach. It stays the owner's, run by hand, with its answers committed.

**A forced update of `main` in the live test.** A wrong success would rewrite history; a
non-forced fast-forward proves the same refusal and costs one additive commit at worst.

---

[git-push]: https://git-scm.com/docs/git-push
[git-config]: https://git-scm.com/docs/git-config
[git-remote]: https://git-scm.com/docs/git-remote
[gh-api]: https://cli.github.com/manual/gh_api
[gh-env]: https://cli.github.com/manual/gh_help_environment
[gh-exit]: https://cli.github.com/manual/gh_help_exit-codes
[fg-perms]: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
[merge]: https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request
[pulls]: https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
[rules-branch]: https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch
[ruleset-get]: https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset
[rules-about]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
[ssh-443]: https://docs.github.com/en/authentication/troubleshooting-ssh/using-ssh-over-the-https-port
[ssh-ca]: https://docs.github.com/en/organizations/managing-git-access-to-your-organizations-repositories/about-ssh-certificate-authorities
[actions-perms]: https://docs.github.com/en/rest/actions/permissions#get-default-workflow-permissions-for-a-repository
