# Submitting to GitHub

What a person needs before idpa can open a pull request on their behalf, and how to check it.
idpa never merges and never writes to the base: it opens a pull request, and the base's rules
decide who may merge it. It holds no GitHub credential: your own git pushes the branch and your
own gh opens the pull request, from a clone whose checked-out branch tracks one on github.com.
`idpa protection` checks the base's rules on its own, and every road that submits pushes and
opens the pull request:
[`plan --from … --submit`](#submitting-a-plan-file),
[`plan "<intent>" --submit`](#from-a-service-plan-intent---submit),
[`idpa "<phrase>" --submit`](#one-phrase-idpa-phrase---submit),
[`init --submit`](#a-services-own-repository-init---submit) and, at a terminal,
[the proposal a change's diff ends on](#without---submit-the-proposal).
The decision is [ADR-0015](adr/0015-a-submission-is-a-pull-request-the-rules-hold.md); the
design, [`stage-6-brief.md`](stage-6-brief.md), § 3 to § 15.

## What you need

- **Your own git, able to push to the repository** as it already does: your SSH key and agent, or
  your credential helper, from your global configuration. idpa never reads either.
- **gh, at least 2.96.0** (`GH_MINIMUM_VERSION`), the version the owner's live run of 2026-10-02
  proved stage 6 with on GitHub ([below](#proving-it-on-your-repository-the-live-test)): an older gh
  may work, and this build refuses it rather than vouch for what nobody ran; a later live run made
  with an older gh, committed, lowers it. Logged in to github.com **as yourself**:

  ```bash
  gh auth login --hostname github.com
  gh auth status --hostname github.com
  ```

  A bot, an app's token or a workflow's token is refused: the pull request's author would be a bot,
  and the person who asked could approve it.
- **No token for idpa.** It has no token variable, no flag and no configuration key for one. gh reads
  its own login — its stored one, or `GH_TOKEN` if you export it — and idpa passes your environment
  to gh unread, minus the variables that would point gh at another host.

## The ruleset on the base branch

The ruleset is what keeps a pull request's author from merging it alone: it holds the pull request
until someone other than its opener approves its latest commit. On GitHub that is a **ruleset**;
classic branch protection is not read. Whether an author may merge alone is the company's rule,
not idpa's (the owner's decision of 2026-10-01): without the ruleset, or with only part of it, a
submission still opens the pull request, and says so in one line, on stderr and in the pull
request's body:

```text
note: on this repository the author may merge without another person's review
```

Where a rule binding you requires another person's approval and only the rule blocking force
pushes or restricting deletions is missing or bypassed, the line says that instead — `note: on
this repository no rule on main that binds the author blocks force pushes`, `… restricts
deletions`, or `… blocks force pushes or restricts deletions` — since the approval still
holds. In the pull request's body the base is written as code, `` `main` ``, so that no branch
name can mention, reference or link anything there; the words are the same.

On the repository's page: **Settings → Rules → Rulesets → New ruleset → New branch ruleset**, then

1. a name, `idpa` for instance, and enforcement **Active**;
2. the bypass list left **empty** — which binds the repository's administrators too: with it
   empty, GitHub answers `current_user_can_bypass: never` to an administrator, and refuses their
   merge, `gh pr merge --admin` included (measured by the live run of 2026-10-02);
3. target branches: **Include default branch** (or the branch you submit into);
4. tick **Restrict deletions**;
5. tick **Require a pull request before merging**, with **1** required approval and **Require
   approval of the most recent reviewable push**;
6. tick **Block force pushes**;
7. **Create**.

That is the list `idpa protection` checks and `init platform` prints (`PROTECTION_SETTINGS`):

```text
  required · require a pull request before merging — 1 approval
  required · require approval of the most recent reviewable push (or dismiss stale approvals when new commits are pushed)
  required · block force pushes; restrict deletions
  required · nobody who submits in the bypass list
  advised  · no deploy key and no app in the bypass list
  advised  · GitHub Actions may not approve pull requests (Settings → Actions → General → Workflow permissions)
  advised  · set it at the organisation level, where a repository administrator cannot change it
  advised  · require review from Code Owners
  advised  · the downstream decision as a required status check, once one reports (ADR-0012)
```

Prefer *approval of the most recent reviewable push* to *dismiss stale approvals*: with only the
second, the account your git pushes with could approve a pull request your gh opened. Also
advised, though not checked: a second ruleset on `refs/heads/idp-agent/**` blocking force pushes
and deletions, so a branch under review is never rewritten.

## `idpa protection`

```bash
idpa protection --repo ~/my-iac
```

It reads the branch the clone's checked-out branch tracks on github.com, through your gh, with
`GET` requests only: who gh acts as (`GET user`), the repository, the rules for that branch, each
ruleset that supplies one of the required rules, and — only when none does — the branch, for
classic protection. Before them it runs `gh --version`, which stays on your machine. No model, and
nothing written, in the clone or on GitHub. Without `--repo` it finds the declarations repository
as `plan` does: the current directory when it is one, then `IDP_REPO`, then `repo` in your personal
`config.yml`.

| Exit | When |
|---|---|
| `0` | the rules hold: a pull request rule of at least 1 approval, approval of the most recent push (or stale approvals dismissed), no force push, no deletion, from rulesets gh's account cannot bypass (`current_user_can_bypass: never`), and no deploy key in a bypass list gh can read |
| `1` | they do not — or the repository is archived, renamed, or yours to read but not to push — and it prints what is missing and the ruleset to add; or GitHub failed to answer, in one sentence of idpa's. A diagnostic: where a submission would go on, its last line but one says what it says there — `A submission still opens its pull request here, and says: note: on this repository the author may merge without another person's review` |
| `2` | the arguments, the clone or gh are refused: not a clone's root, a detached `HEAD`, a branch that tracks no remote or a remote on another host, a key of the clone's own configuration (below), gh missing, logged out, too old or not a person |

When the rules hold it also reports what is not required — review from Code Owners, the required
status checks, signed commits, a merge queue — and says what **no read can see**:

- an administrator can edit or disable the ruleset outside idpa, and then merge; GitHub records it
  in the ruleset's history;
- the credential your git pushes with: `current_user_can_bypass` answers for gh's account only,
  and a deploy key or another account's key in the bypass list could move the base without a pull
  request. A deploy key idpa can see is said in the note; the bypass list is shown only to someone
  who may edit the ruleset;
- whether GitHub Actions or an app may approve pull requests in the repository.

Two more things no read can see, which `idpa protection` does not print: a classic rule's settings,
which only an administrator can read — that is why a ruleset is what counts, and a base protected
by classic protection alone gets the note — and whether the account your git pushes with is the one
gh opens the pull request as, since nothing idpa reads ties them ([push as gh's
account](#push-as-ghs-account)).

**A known limit**, a follow-up after stage 6: a base covered by a ruleset that supplies none of
the three required rules (a pull request, force pushes, deletions) is reported as

```text
  missing: a ruleset: main is protected by classic branch protection only, which idpa does not read
```

because GitHub answers `protected: true` for a branch a ruleset covers, and that route is read
only when no ruleset supplies a required rule. The exit, 1, and a submission's note are right; the
reason is not: the base has a ruleset, missing the rules [above](#the-ruleset-on-the-base-branch),
which is what to add to it ([`roadmap.md`](roadmap.md), *Open questions*).

Where the rules require another person's approval, the invariant therefore binds the identity
that opens the pull request and every credential that person pushes with, as long as the ruleset
stands, the push credential is not in its bypass list, and no workflow or app approves in
someone else's place. That the merge itself fails is never tried by idpa, which runs no merge.

## Submitting a plan file

```bash
idpa plan --from examples/open-network.json --repo ~/my-iac --submit
```

In a clone whose checked-out branch tracks a branch on github.com, it runs in this order, and each
step can end the run with nothing written:

1. **The road and gh**, before anything is read: the branch's upstream, both URLs of its remote,
   the clone's own configuration ([below](#the-clones-own-configuration)), then gh's version and
   who it is logged in as. On stderr: `submitting to github.com/acme/iac, into main (origin,
   main's upstream), as ada (gh)`.
2. **The base**, before anything is previewed: the repository and its ruleset, as `idpa protection`
   reads them, and whether GitHub's base is the commit your clone's is. A repository that is
   archived, that gh's account cannot push to or that GitHub answers under another name is refused;
   rules that let you merge alone are said, once, on stderr — `note: on this repository the author may merge without another person's review` — and the run goes on.
3. **The diff**, and one question:

   ```text
   Push idp-agent/orders-api-to-payments-e9e6183f to github.com/acme/iac with your git, and open a pull request into main with your gh? Nothing is provisioned until someone else approves it and it is merged. [y/N]
   ```

   Where the rules let you merge alone, it ends `Nothing is provisioned until it is merged. [y/N]`.
   A script, a pipe or `--json` has `--submit` as its answer: the question was never the guard,
   the merge is.
4. **At the moment of acting**, the road, the clone's configuration, the rules and the base's tip
   are read again; then the branch is cut in the clone, your git pushes that very commit to the
   same name, create-only (a branch already there is never moved), gh reads it back, the rules are
   read once more — they decide the note in the body, never whether to open — and your gh opens one
   pull request whose body the engine writes. The request is quoted there inside a fenced block, so
   an `@login` in it is shown as code, with no mention link (measured by the live run of
   2026-10-02).

It ends on the pull request, at a URL the engine builds from the repository and the number, and on
what merging it waits for:

```text
1 file · submitted as idp-agent/orders-api-to-payments-e9e6183f on top of main@3f9c2a1 · main untouched
Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1
Merging it waits for one approval of its latest commit from someone other than you. No status check is required, so a system downstream could not refuse it (ADR-0012).
Nothing is provisioned yet. The merge is what authorises it.
```

Where the rules let you merge alone, the third line drops the approval — `No status check is
required, so a system downstream could not refuse it (ADR-0012).`, or `Merging it waits for the
status checks <…>.` — and the pull request's body carries the note below how the change was made.
Rules that changed between the question and the pull request, so that the body's note is not the
line said before, are said on stderr just above these lines, the body's words; `--json` says it as
`"note": "author-may-merge"` under `submission`.

**Run it again** and it asks nothing and writes nothing: `1 file · already submitted as
idp-agent/… · pull request #1 is open · nothing written`. A pull request on an older base is named
too, and says GitHub shows whether it still merges cleanly.

**When it stops halfway.** The two systems are not one transaction, and every state between them is
completed by running the same command again. A push that failed leaves the branch in the clone and
says so (`… was cut in this clone, and no pull request was opened.`, exit 1). A branch pushed whose
pull request was not opened says why — `<branch> is on github.com/acme/iac, and the pull request was
not opened: GitHub answered 502 through gh. Run the same command again to open it.` — and the next
run asks only `Open a pull request from … into main on github.com/acme/iac with your gh? The branch
was pushed by an earlier run.` and opens it.

**A closed pull request** is not reopened, nor a merged one that was since reverted: the run says
which, exit 1. Reopen it on GitHub, or change the request.

**`--local`** cuts the branch in the clone only, reads nothing on GitHub and starts no gh; it ends on
`--local: nothing pushed by this run`. A clone whose branch tracks nothing ends on `main tracks no
remote: nothing pushed`, whatever the branch is named, and one whose remote is on another host on `the remote is on <host>, where
this build opens no pull request: nothing pushed`. `--local` without `--submit` is refused (exit 2).

Each refusal, and its one fix:

| Refused | Exit | Fix |
|---|---|---|
| gh not installed, logged out or expired, older than 2.96.0, or logged in as a bot or an app | 2 | `gh auth login --hostname github.com` as yourself, or update gh; or `--local` |
| a key of the clone's own configuration | 2 | move it to your global configuration ([below](#the-clones-own-configuration)) |
| a remote URL carrying a credential, or one that does not parse | 2 | `git remote set-url origin https://github.com/<owner>/<name>` |
| a checked-out branch that tracks one, named with a `%`, `{`, `}` or invisible character | 2 | `git branch -m <name>`; or `--local` |
| a repository that is archived, that gh's account cannot push to, or that GitHub answers under another name | 1 | unarchive it, ask for push access, or update the remote's URL |
| a clone not level with GitHub | 1 | `git pull`, then run it again; a change already submitted is then named |
| the base moved, or the clone's configuration changed, between the question and the push | 1 | nothing was written; run it again |

Rules that let you merge alone refuse nothing: the pull request is opened with the note, exit 0.

## From a service: `plan "<intent>" --submit`

```bash
cd ~/my-service
idpa plan "give component:default/billing-api read access to resource:default/orders-db-prod" --repo ~/my-iac --submit
```

A change drafted from your words takes the same road as a plan file, with the models in the middle,
and nothing of GitHub is paid for by a model or shown to one. In this order:

1. **The road and gh**, before the model is even configured: the clone, its branch's upstream, both
   URLs of its remote, the clone's own configuration, gh's version and who it is logged in as. Each
   refusal is exit 2, as for a plan file, and the `submitting to …` line is printed here.
2. **The model's configuration** (`IDP_PROVIDER`, `IDP_MODEL`, the key): exit 2 when it is missing.
3. **The service's `.idp-agent.yml`**, when one is read: its `iacRepo` is a cross-check, never a
   source. A service that names another repository than the one your clone's branch tracks is
   refused, exit 1, before anything more is read of either repository or of GitHub:

   ```text
   not submitted — .idp-agent.yml in /Users/you/my-service names github.com/acme/other-iac as this service's declarations repository, and /Users/you/my-iac's main tracks github.com/acme/iac: run this with --repo naming a clone of the repository it names, or change iacRepo in a reviewed change. Nothing was written.
   ```

   `iacRepo` is compared as GitHub compares a repository, owner and name in any case, written
   `github.com/<owner>/<name>` behind an optional `https://` or `ssh://`, with or without `.git`; a
   locator naming another host, or no repository at all, is refused the same way. It is read only on
   the way to GitHub: a preview, `--local`, a clone that tracks nothing or another host, and a run
   with no service inspected read none.
4. **The working tree and the base**: a catalogue file that differs from `HEAD`, then the repository
   and GitHub's tip, as for a plan file (exit 1) — all before the Inspector, the first model call —
   and the note, when the rules let you merge alone, said there.
5. **The Inspector, the Architect, the four free gates and the Reviewer.** gh is asked nothing while
   they run.
6. **The diff, the question, and the moment of acting**, exactly as for a plan file: the rules read
   again before the branch is cut and once more before the pull request is opened, for the note in
   its body, which the closing lines name.

A run that ends on a question (exit 3) or stops at three attempts (exit 1) reads nothing more of
GitHub and writes nothing. `--local` cuts the branch in the clone only and starts no gh.

## One phrase: `idpa "<phrase>" --submit`

```bash
cd ~/my-service
idpa "give component:default/billing-api read access to resource:default/orders-db-prod" --repo ~/my-iac --submit
```

The one gesture submits too. Typing `--submit` says the phrase is a change, so everything a
submission can refuse as an argument is refused before anything is requested of a catalogue and
before any model, and the repository and the base's rules are read before the Supervisor, the first
model call of this road. In this order:

1. **The arguments**: `--submit --demo` is refused at once, exit 2 — the demo SI is never written —
   and so is `--local` without `--submit`.
2. **The declarations repository, the service and the road**, before a catalogue is read and before
   the model is configured: with no declarations repository named anywhere, exit 2, naming every way
   to name one; then `--project`, then the clone, its upstream, its own configuration and gh, as on
   the intent road, each refusal exit 2.
3. **What the run reads**, as without `--submit` — the line naming the repository or the catalogue
   — and then the `submitting to …` line.
4. **The model's configuration**: exit 2 when it is missing.
5. **The repository and GitHub's tip**, exit 1 when either refuses, before the Supervisor is paid;
   the note, when the rules let you merge alone, said there — a question is still refused after it.
6. **The Supervisor's one word.** The Supervisor is sent exactly what it is sent without
   `--submit`, and nothing of GitHub.
7. **A change** then takes the intent road from its step 3: the service's `iacRepo`, the working
   tree, the rules (already read, and not read again), the Inspector, the Architect, the gates, the
   Reviewer, the diff, the question and the moment of acting. **A question** is refused, exit 3, and
   the Analyst is never called:

   ```text
   that is a question, and --submit submits a change: ask it again without --submit. Nothing was answered, and nothing was written.
   ```

   Exit 3, as `ask` declines a change: the request is understood, and this build does not submit a
   question. In `--json` too, with nothing on stdout, since a question has no JSON form.

`--local` cuts the branch in the clone only and starts no gh, as on every road. What a divergent
working tree costs here is one Supervisor turn: it is judged with the catalogue's bytes, which the
change road reads after the Supervisor's word.

## Without `--submit`: the proposal

```bash
cd ~/my-service
idpa "give component:default/billing-api read access to resource:default/orders-db-prod" --repo ~/my-iac
```

At a terminal, a change previewed without `--submit` ends on a proposal (the owner's decision of
2026-10-01): the diff, then the very question `--submit` asks, naming the push and the pull request.
Your `y` authorises it, and the engine opens the pull request exactly as `--submit` would, and prints
`Pull request #<n> opened on github.com/<owner>/<repository>: <url>`. `n`, an empty line or Ctrl-D
declines, exit 0, nothing written; Ctrl-C stops the run, exit 130.

| Road | At a terminal, no `--submit` | With `--submit` | No terminal, or `--json` |
|---|---|---|---|
| `idpa "<phrase>"`, a change | the diff, then the proposal | submitted | the preview |
| `idpa "<phrase>"`, a question | the answer; nothing proposed | refused, exit 3 | the answer |
| `plan "<intent>"` | the diff, then the proposal | submitted | the preview |
| `plan --from <plan.json>` | the preview | submitted | the preview |
| `init` | the preview | submitted | the preview |

`plan --from` is the road with no model, and a file someone hands over is submitted by typing
`--submit`, as a script would; `init` writes into the service's own repository, and its proposal
comes with stage 8's discovery.

**The question is the engine's.** No model writes a word of it, and no agent holds a tool that
pushes: the Supervisor's `MUTATION` only chooses the road the proposal is at the end of. The question
is `--submit`'s, byte for byte, so you learn one question.

**What is read, and when.** After the Reviewer and the diff — after the last model call, so nothing
of GitHub reaches a model and a preview's order before its diff is unchanged — the engine clears the
plan, then opens what `--submit` opens: the clone, its upstream, its own configuration and gh; then
the service's `iacRepo`, the working tree against `HEAD`, the base's rules and whether the clone is
level with GitHub; then whether this change was submitted before. It asks only when it could do what
the question says. Otherwise it says why in one line on stderr, and the preview stands at exit 0:

```text
no pull request proposed — main tracks no remote; --submit cuts the branch in this clone
no pull request proposed — the remote is on gitlab.example.com, where this build opens no pull request; --submit cuts the branch in this clone
no pull request proposed — main tracks github.com/acme/iac, and gh is not logged in to github.com, so idpa cannot read the rules that keep a pull request from merging unreviewed. Run `gh auth login --hostname github.com`, then run this again; or add --submit --local to cut the branch in this clone only.
no pull request proposed — github.com/acme/iac cannot take a pull request from this run: missing: push access: gh's account cannot push to acme/iac
```

Each is the reason `--submit` would have printed for the same refusal, without its `not submitted —`
and its `Nothing was written.`, and with its offer of `--local` made `--submit --local`: `--local`
alone is refused without `--submit`. GitHub failing to answer one of these reads — a 502, a gh that
times out — is said the same way, and the preview still stands. A submission already made is named
under the whole preview, and nothing is asked. The `submitting to …` line, and the note where the
rules let you merge alone, are said only when the question is put, just before it, and the question
then promises no approval; a run that proposes nothing does not say it was submitting.

**Who is asked.** Only a person at a terminal: stdin, stdout and stderr must each be one, so the diff
reaches the screen the question is on — `> preview.txt` or `| tee` is never asked — and whatever was
typed while the models ran is discarded before the question is written, so a `y` typed early answers
nothing. A script, a pipe or `--json` is never asked and reads nothing of GitHub on this road: it
still types `--submit`.

## A service's own repository: `init --submit`

```bash
cd ~/my-service
idpa init --submit --iac-repo github.com/acme/iac --environment dev --environment prod
```

`init` declares a service in its own repository, so its branch is cut there and its pull request
opened there: on `github.com/<you>/my-service`, into the branch your clone's `main` tracks — never on
the declarations repository. The branch holds two files at most: the `catalog-info.yaml` it
previews, and `.idp-agent.yml` when `--iac-repo` and `--environment` were typed, or answered at the
terminal.

The service's repository is held to exactly what the declarations repository is: the same clone
configuration check, gh's identity, and **the same ruleset on its base branch**
([above](#the-ruleset-on-the-base-branch)) — add it there too, and `idpa protection --repo
~/my-service` checks it; without it, the service's pull request is opened with the note. In this
order, every step before the Inspector, the first model call:

1. **The road and gh**, before the model is configured: exit 2 on a refusal, and the `submitting to
   github.com/<you>/my-service, …` line printed here.
2. **The model's configuration**, then `.idp-agent.yml`'s questions, the service's files and
   init's own verdicts on them.
3. **The working tree, the repository and GitHub's tip.** A repository gh's account cannot push
   to, archived or answering under another name, is refused, exit 1 — and, since a branch in the
   clone alone is still a way forward for a service, naming `--local`:

   ```text
   not submitted — github.com/<you>/my-service cannot take a pull request from this run:
     missing: push access: gh's account cannot push to <you>/my-service
   Then run this again, or add --local to cut the branch in this clone only. Nothing was written.
   ```

   Rules that let you merge alone are said in the note, and the run goes on.

4. **The Inspector and the Architect**, then the diff, the question and the moment of acting, as
   for a plan file.

`iacRepo` is not held to the clone here, as it is on the intent road: there the clone *is* the
repository it names; here the branch goes to the service, and `iacRepo` names the declarations
repository, which is another by design.

Still refused by name, on this road too: a service in a subfolder of its repository (exit 2, before
gh starts — the branch is cut at a clone's root, and the service's paths would need the folder's
prefix; `init` without `--submit` previews it), and a plan file writing into both repositories,
which `plan --from` refuses pointing here.

## What is in flight

Before anything is written, idpa reads the idp-agent pull requests already open into your base, and
compares your change with them (the owner's decision of 2026-10-01). Two people asking for the same
access at the same time open one pull request between them, not two; two different changes to one
file are stopped before they meet at the merge.

**What it reads.** The open pull requests into the base, newest first, a hundred a page, at most
three pages; of those, the **candidates** — a branch of this very repository (a fork's never is)
named as an idp-agent run names one, `idp-agent/<slug>-<8 hex>` — and the files each candidate
changes, one page of a hundred. Two `GET`s through your gh, nothing else, and no write: another
person's pull request is never edited, commented on, closed or linked to. Never read: a pull
request's title or body (dropped as it is parsed), a file's bytes on GitHub, a branch somebody made
by hand, a person's own pull request on any other branch — that one meets yours at the merge, as
any two changes do. A bot's pull request (`dependabot[bot]`) is not a candidate, and is not looked
at further. Your own pull request from this very branch is recognition's, which names it as
*already submitted*.

**What it decides**, in this order:

| A candidate… | What happens | Exit |
|---|---|---|
| changes exactly the files your change writes, to the same bytes, its file list whole | named: `already proposed by <login> in pull request #12`; nothing written | 0 |
| changes a file your change writes, otherwise (or renames or removes it) | shown, its patch for that file on stderr; your change is not submitted | 1 |
| changes another file of the same entities — one that declares, or names, an entity your plan names — and none your change writes | said, and your change goes on: asked as before, its pull request's body naming the other by number | as the submission |
| none of the above | nothing said | — |

A candidate whose file list runs past a hundred is judged on the first hundred, and said to be;
it can be competing or beside, never the same.

```text
1 file · already proposed in pull request #12 on github.com/acme/iac: https://github.com/acme/iac/pull/12 · nothing written
```

```text
1 file · not submitted:
  pull request #12 on github.com/acme/iac already changes dependencies/network/orders-api-to-payments.yml, differently: https://github.com/acme/iac/pull/12
Review it there, or run this again once it is merged or closed. Nothing was written.
```

```text
In flight beside it on github.com/acme/iac: pull request #12, changing dependencies/access/billing-api-cache-dev.yml
```

**When it is read, on each road.**

| Road | Read | Said before the model | Judged | Read again |
|---|---|---|---|---|
| `plan --from … --submit` | before the preview | — | before the question | at the moment of writing |
| `plan "<intent>" --submit` | before the Inspector | the pull requests touching the inspected service, when its root `catalog-info` declares one Component | after the Reviewer, from what was read | at the moment of writing |
| `idpa "<phrase>" --submit` | before the Supervisor | before the Inspector, once the Supervisor took the phrase for a change | as `plan "<intent>"` | at the moment of writing |
| `init --submit` | before the Inspector | the pull requests changing the service's `catalog-info` or `.idp-agent.yml` | once the Architect's bytes exist | at the moment of writing |
| the proposal, at a terminal | after the last model call | — | before the question; the same or a competing change is why nothing is proposed, and the preview stands | at the moment of writing |
| `--local`, any road | nothing is read on GitHub | — | — | — |

Before the model nothing is refused for being in flight: before your change's bytes exist, the
same change and a different one look alike. The run says what it found and goes on.

**Two reads.** The first, before the question, is kept for the run. The second, at the moment of
writing, reads page 1 again — the hundred most recently opened — and the files of a candidate that
is new or was pushed to since; a change named or refused there writes nothing on either side, and
`what is in flight changed while you read the diff:` says so first. What escapes both: a pull
request opened between the second read and the push, or one beyond the hundred most recent pushed
to after the first read. Then the same bytes still give the same branch name, refused by the lease
or recognised; two different changes on one file meet at the merge.

**The bounds.** More than 300 open pull requests into the base, or more than twenty idp-agent ones,
is a read this build cannot make whole, and it is refused, exit 1, before any model, rather than
judged on a part:

```text
github.com/acme/iac has 21 open idp-agent pull requests into main, more than the 20 this build compares: review some of them, then run this again. Nothing was written.
```

A run makes at most 92 gh calls.

**Where each fact goes.** Another person's login, their branch and their patch are said on stderr,
and nowhere else: not on stdout, so not in a trace or MLflow; not in `--json`, whose `submission`
carries `already-proposed` with the number, the URL and your branch, or, on a refusal, `inFlight`
with each pull request's number, URL and your own paths it changes; not in your pull request's body;
never to a model. The body names a pull request beside it by number alone — `Opened beside pull
request 12, open into main, …` — with no `#` and no URL, so GitHub adds nothing to the other pull
request's timeline and notifies nobody.

## Push as gh's account

Nothing idpa can read ties the account your git pushes with to the one gh opens pull requests as.
Make them the same:

- over HTTPS, `gh auth setup-git` makes gh's login git's credential for github.com;
- over SSH, use a key of the same account — never a deploy key.

## The clone's own configuration

A clone's `.git/config` is the one file on your machine someone else may have written, and git
reads it on every call. So a key that would choose where a push goes, who authenticates it or what
program runs during it is refused when it is set in the clone — the `local` or `worktree` scope —
and idpa names the key and its scope, never its value. Your global and system configuration are
yours, as for your own `git push`.

- Refused whole sections: `url`, `credential`, `http`, `protocol`, `ssh`, `gpg`, `push`.
- Refused keys: `core.sshCommand`, `core.askPass`, `core.gitProxy`, and for any remote
  `remote.<name>.vcs`, `.receivepack`, `.uploadpack`, `.proxy`, `.proxyAuthMethod`.
- Kept, being harmless: `http.postBuffer`, `http.lowSpeedLimit`, `http.lowSpeedTime`,
  `push.default`, `push.autoSetupRemote`, `gpg.format`.

A common one to move is a credential helper set in the clone:

```bash
git config --local --unset-all credential.helper
git config --global credential.helper osxkeychain
```

(`osxkeychain` on macOS; the helper you already use elsewhere.) Then run the command again.

## Proving it on your repository: the live test

`pnpm test` proves stage 6 against a fake gh. `pnpm test:live:github` proves it on GitHub, with your
own gh and git, against a repository you made to be thrown away; it is run by hand and never in CI,
because it needs a gh logged in as a person — a credential someone else's workflow could reach
([`stage-6-brief.md`](stage-6-brief.md), § 20). Without `IDP_GITHUB_LIVE_REPO` it stops before
anything starts:

```text
IDP_GITHUB_LIVE_REPO is not set: the live test runs only on purpose, against your throwaway repository (docs/submitting.md, "Proving it on your repository").
```

**The repository.** Public, with a name holding `idpa-live`, such as `<you>/idpa-live` (the test
refuses any other name), the demo SI (`fixtures/si-demo/`) on its default branch, [the ruleset
above](#the-ruleset-on-the-base-branch) on that branch with its bypass list empty, *Allow
auto-merge* off (Settings → General) and no merge queue. Your ssh key loaded in your agent, so no
passphrase is asked in the middle of a step, and gh logged in to github.com as you.

**A second account, optional.** With one, the test also tries what only another person can do:
the same change proposed by someone else, and an approval followed by your push. It needs write
access and its own gh login, in a directory of its own, with `GH_TOKEN` and `GITHUB_TOKEN` unset
for it, since either would make gh answer as you:

```bash
OWNER=your-login
REVIEWER=your-second-login
gh api --method PUT "repos/$OWNER/idpa-live/collaborators/$REVIEWER" -f permission=push
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" gh auth login --hostname github.com
INVITATION=$(env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" gh api user/repository_invitations --jq '.[0].id')
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer" gh api --method PATCH "user/repository_invitations/$INVITATION"
```

Without it, the steps that need another person are skipped, each saying on stderr that the claim
then rests on the fake and the rule's read alone.

**The run**, from a checkout of idp-agent:

```bash
OWNER=your-login
pnpm build
IDP_GITHUB_LIVE_REPO="$OWNER/idpa-live" pnpm test:live:github
```

(add `IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR="$HOME/.config/gh-idpa-reviewer"` for the second
account). It reads before it writes: gh's version and identity, the repository (public, not
archived, yours to push to), then `node dist/cli/bin.js protection` on its own clone, which must
exit 0, and every ruleset must answer `current_user_can_bypass: never` to you. Then, in order, each
step skipped once one fails:

| Step | What it proves |
|---|---|
| 1 | a base whose name holds a slash (`live/<stamp>/base`) is read back through gh's routes, the `/` kept between its components |
| 2 | `plan --from … --submit` pushes with your git and opens one pull request, the URL the engine builds; GitHub holds the branch at the clone's commit, on one parent, the base; the request's `@mention` is shown as code |
| 3 | the same command again names the pull request and writes nothing |
| 3b | the same change, proposed by the second account, is named as already proposed, nothing written |
| 3c | a different change to the same file is refused, the other pull request named, nothing written |
| 4 | every door is refused to you, who opened the pull request — each merge method of `gh pr merge`, `--admin`, the REST merge and `merge-async`, `POST merges`, a file written to the base, the base's ref moved, a push onto it, GraphQL's `mergePullRequest` and `createCommitOnBranch`, your own approval through gh and through the API — the base's commit read and unchanged after each |
| 5 | after the second account approved, a push of yours on top leaves your merge refused |
| 6 | on a base no ruleset covers, the pull request is still opened, with the note on stderr and in its body |

A door counts as refused only when GitHub answered it — a status, a GraphQL error, a `remote:` line
naming a rule or a review; one that failed before reaching GitHub (a 401, a missing scope, a 404)
stops the run as *not tried*, and one that succeeded stops it at once. Whatever happens, the test
closes every pull request it opened, deletes the branches it pushed and nothing else, and checks
that nothing it opened was merged, before the cleanup and after it.

**What it writes.** `tests/contract/github/answers-<date>.json`: the status and the shape of each
route GitHub answered, each door's answer, the `remote:` lines of the refused push and what
`--include` printed for a 404, with every login, name and email removed — the file is not written
when one is left. Three fields no read settles are yours to fill, `true` or `false`, before you
commit the file:

| Field | Where you read it |
|---|---|
| `actionsCanApprovePullRequests` | `gh api "repos/$OWNER/idpa-live/actions/permissions/workflow"`: `can_approve_pull_request_reviews` |
| `gitPushesAsGhAccount` | `ssh -T git@github.com` names the account your git pushes as: `true` when it is gh's |
| `bypassListEmpty` | Settings → Rules → Rulesets → the ruleset: its bypass list |

From then on `tests/contract/github-answers.test.ts` holds the fake gh to the committed files in
`pnpm test`, offline: each route's status and every field the fake sends, each door's answer, and
the minimum gh, the oldest version a committed run used.

**What the run of 2026-10-02 measured**, gh 2.96.0, without a second account: every door refused,
the base never moved. The three methods of `gh pr merge` and `--admin` exit 1; the REST merge is
405; `POST merges` and a file written to the base 409, the base's ref moved 422; the push onto the
base is rejected with `GH013: Repository rule violations found` and the rule it breaks; both
GraphQL mutations answer an error; your own approval is refused, 422 through the API.
`merge-async` answers **202 Accepted**, and GitHub never carried the merge out: the test watched
the pull request for 30 seconds, never merged and the base unmoved, and found it unmerged again at
its end. A branch the ruleset covers answers `protected: true` on the branch route although no
classic protection is set. GitHub held the pushed branch on the first read, and the request's
`@mention`, inside the body's fence, rendered as code, with no mention link. Steps 3b and 5 were
skipped: what they prove — the same change proposed by another person named, and your merge still
refused after another person's approval and a push of yours on top — rests on the fake and on the
rule's read (*approval of the most recent reviewable push*), not on GitHub's answer. What it
cannot answer is how your company protects its own declarations repository, whether its people
push as their gh account, and whether its Actions may approve: the three fields answer those for
the throwaway repository only.
