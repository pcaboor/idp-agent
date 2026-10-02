# Submitting to GitHub

What a person needs before idpa can open a pull request on their behalf, and how to check it.
Stage 6 builds the submission itself task by task ([`plans/stage-6-github.md`](plans/stage-6-github.md));
what works today is `idpa protection`, the check every submission makes before it writes anything,
and every road that submits, each of which pushes and opens the pull request:
[`plan --from … --submit`](#submitting-a-plan-file),
[`plan "<intent>" --submit`](#from-a-service-plan-intent---submit),
[`idpa "<phrase>" --submit`](#one-phrase-idpa-phrase---submit) and
[`init --submit`](#a-services-own-repository-init---submit).
The design is [`stage-6-brief.md`](stage-6-brief.md), § 3 to § 15.

## What you need

- **Your own git, able to push to the repository** as it already does: your SSH key and agent, or
  your credential helper, from your global configuration. idpa never reads either.
- **gh, at least 2.40.0** (`GH_MINIMUM_VERSION`, provisional until the live run pins it), logged in
  to github.com **as yourself**:

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
2. the bypass list left **empty**;
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

## Submitting a plan file

The invariant every submission keeps: idpa never merges and never writes to the base: it opens a
pull request, and the base's rules decide who may merge it.

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
   pull request whose body the engine writes.

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
| gh not installed, logged out or expired, older than 2.40.0, or logged in as a bot or an app | 2 | `gh auth login --hostname github.com` as yourself, or update gh; or `--local` |
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
